#!/usr/bin/env node
/**
 * C1 / C2 的真实多进程用例执行体（由 test/config-lock.test.mjs 拉起）。
 *
 * 用法：
 *   node lock-worker.mjs counter <configPath> <counterPath> <iterations>
 *   node lock-worker.mjs write <repo> <home> <iterations> <none|plain> [lockTimeoutMs] [--plant]
 *   node lock-worker.mjs stress <configPath> <counterPath> <logPath> <iterations> <--plant|--no-plant>
 *
 * 退出码：0 = 成功；2 = 写盘显式失败（stdout 输出 JSON：{ ok:false, code, message }）。
 *
 * `counter` / `stress` 模式故意把临界区放大到 5ms / 2ms：没有跨进程锁时，「读 → 写」会互相
 * 覆盖（计数丢更新、读到重复值），有锁时计数必须一次不少 —— 这是锁真的生效、而不是单进程
 * Promise 链「看起来串行」的判据。
 *
 * `--plant`：每次进入临界区前，尝试用 O_EXCL **原子**种一把 stale 锁（死 pid + 60s 前 mtime），
 * 模拟「上一个进程崩在中间」。抢不到就跳过 —— 绝不覆盖别人正在持有的锁。这样 12 个写者会
 * 反复同时看到同一把 stale 锁、抢着接管，正是 Q1 复现「两个写者同时进临界区」的入口。
 */
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, utimesSync, writeFileSync, writeSync } from 'node:fs'
import { hostname } from 'node:os'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { acquireGateConfigLock, gateLockPath, projectGatePath, writeGateConfig } from '../lib/index.js'

const args = process.argv.slice(2)
const [mode] = args

/** 同步睡眠：临界区要真的占用一段时间，才能暴露并发窗口。 */
function sleep(ms) {
  if (!(ms > 0)) return
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

function readCounter(path) {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    return Number(parsed && parsed.value) || 0
  } catch {
    return 0
  }
}

function criticalSection(counterPath, logPath, holdMs) {
  const value = readCounter(counterPath)
  sleep(holdMs)
  writeFileSync(counterPath, JSON.stringify({ value: value + 1 }) + '\n', 'utf8')
  // 每个进过临界区的读者都记下自己读到的值：正常锁下这些值两两不同，
  // 出现重复 = 两个写者同时进了临界区。
  if (logPath) appendFileSync(logPath, value + '\n', 'utf8')
}

/**
 * 原子种一把 stale 锁：O_EXCL 创建 → 写死 pid 的负载 → mtime 回拨 60s。
 * 抢不到（有人持有 / Windows 共享冲突）就返回 false，不破坏真实锁。
 */
function plantStaleLock(lockPath) {
  let fd
  try {
    fd = openSync(lockPath, 'wx', 0o600)
  } catch {
    return false
  }
  try {
    writeSync(fd, JSON.stringify({
      pid: 999999,
      hostname: hostname(),
      startedAt: new Date(Date.now() - 60000).toISOString(),
      token: 'planted-' + randomUUID(),
    }) + '\n')
  } finally {
    closeSync(fd)
  }
  const old = new Date(Date.now() - 60000)
  try {
    utimesSync(lockPath, old, old)
  } catch {
    // 回拨失败不致命：死 pid 本身就已经满足 stale 判据
  }
  return true
}

function rule(id) {
  return {
    id,
    label: '规则 ' + id,
    type: 'contains',
    value: '禁止词-' + id,
    triggers: ['issue.reply'],
    message: '命中',
  }
}

function payload(variant, index) {
  if (variant === 'none') {
    return { version: 1, name: 'project', extends: 'none', rules: [rule('none-' + index)] }
  }
  return { version: 1, name: 'project', rules: [rule('plain-' + index)] }
}

if (mode === 'counter') {
  const [, configPath, counterPath, rawIterations] = args
  const iterations = Number(rawIterations)
  mkdirSync(dirname(configPath), { recursive: true })
  for (let index = 0; index < iterations; index += 1) {
    const lock = acquireGateConfigLock(configPath, { timeoutMs: 20000 })
    try {
      criticalSection(counterPath, '', 5)
    } finally {
      lock.release()
    }
  }
  process.stdout.write(JSON.stringify({ ok: true, mode, iterations }) + '\n')
} else if (mode === 'stress') {
  const [, configPath, counterPath, logPath, rawIterations, ...flags] = args
  const iterations = Number(rawIterations)
  const plant = !flags.includes('--no-plant')
  // `--spin`：等锁不 sleep（纯自旋）。这是 acquireGateConfigLock 的合法参数，
  // 但会把「读快照 → rename」这个窗口压到所有写者同时在场，接管竞态最容易在此暴露。
  const spin = flags.includes('--spin')
  const lockOptions = spin ? { timeoutMs: 30000, sleep: () => {} } : { timeoutMs: 30000 }
  mkdirSync(dirname(configPath), { recursive: true })
  for (let index = 0; index < iterations; index += 1) {
    if (plant) plantStaleLock(configPath)
    const lock = acquireGateConfigLock(configPath, lockOptions)
    try {
      criticalSection(counterPath, logPath, 2)
    } finally {
      lock.release()
    }
  }
  process.stdout.write(JSON.stringify({ ok: true, mode, iterations, plant, spin }) + '\n')
} else if (mode === 'barrier') {
  // 栅栏模式：父进程每轮先种一把 stale 锁、再发轮次号，12 个写者**同时**醒来抢同一把锁。
  // 这是 Q1 复现「两个写者同时进临界区」的排布（12 写者 44 轮）。
  const [, configPath, counterPath, logPath, rawRounds, rawIndex, controlDir] = args
  const rounds = Number(rawRounds)
  const index = Number(rawIndex)
  let last = 0
  const giveUpAt = Date.now() + 180000
  while (last < rounds && Date.now() < giveUpAt) {
    // 每轮一个**独立**标记文件（round-N）：父进程只做 O_EXCL 创建，不覆盖、不需要 rename，
    // 12 个写者同时读也不会触发 Windows 的共享冲突。
    if (!existsSync(join(controlDir, 'round-' + (last + 1)))) {
      sleep(2)
      continue
    }
    last += 1
    // pollMs=1：12 个写者同时醒来后都在毫秒级轮询，接管窗口天然对齐（Q1 的排布）。
    const lock = acquireGateConfigLock(configPath, { timeoutMs: 30000, pollMs: 5 })
    try {
      criticalSection(counterPath, logPath, 1)
    } finally {
      lock.release()
    }
    writeFileSync(join(controlDir, 'done-' + last + '-' + index), '1', 'utf8')
  }
  process.stdout.write(JSON.stringify({ ok: last >= rounds, mode, last, rounds, index }) + '\n')
} else if (mode === 'probe-lock') {
  // 第三写者：纯自旋抢锁（sleep 空转、pollMs=1），抢到就写 marker 再释放；
  // 超时就写 entered:false。用来证明「旧持有者 release 期间 lockPath 不该出现空窗」。
  const [, configPath, markerPath, rawDuration] = args
  const duration = Number(rawDuration)
  try {
    const lock = acquireGateConfigLock(configPath, { timeoutMs: duration, pollMs: 1, sleep: () => {} })
    try {
      writeFileSync(markerPath, JSON.stringify({ entered: lock.isOwner() }) + '\n', 'utf8')
    } finally {
      lock.release()
    }
  } catch (error) {
    writeFileSync(markerPath, JSON.stringify({ entered: false, code: (error && error.code) || null }) + '\n', 'utf8')
  }
  process.stdout.write(JSON.stringify({ ok: true, mode, duration }) + '\n')
} else if (mode === 'write') {
  const [, repo, home, rawIterations, variant, rawLockTimeoutMs, ...flags] = args
  const iterations = Number(rawIterations)
  const lockTimeoutMs = rawLockTimeoutMs === undefined || rawLockTimeoutMs.startsWith('--')
    ? 15000
    : Number(rawLockTimeoutMs)
  const plant = flags.includes('--plant')
  try {
    for (let index = 0; index < iterations; index += 1) {
      if (plant) plantStaleLock(gateLockPath(projectGatePath(repo)))
      writeGateConfig('project', payload(variant, index), { repo, home, env: {}, lockTimeoutMs })
    }
    process.stdout.write(JSON.stringify({ ok: true, mode, variant, iterations, plant }) + '\n')
  } catch (error) {
    process.stdout.write(JSON.stringify({
      ok: false,
      code: (error && error.code) || null,
      message: String((error && error.message) || error),
    }) + '\n')
    process.exitCode = 2
  }
} else {
  process.stderr.write('未知模式：' + String(mode) + '\n')
  process.exitCode = 2
}
