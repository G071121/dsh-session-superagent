// C1：同一配置路径的跨进程写锁 + Windows 原子替换（rename）重试。
//
// 冻结行为（docs/任务书-dsh-gate-v4.md 第二节「门禁写盘」）：
//   - 同一配置路径的「读旧文件 → 校验 → 备份 → 临时写入 → rename」必须串行，跨进程也不能互相覆盖；
//   - 锁获取失败 / 超时必须**显式失败**，不得无锁写；stale lock 清理必须有年龄与所有者证据；
//   - rename EPERM / EBUSY 做有界退避重试；最终失败保留原文件与明确错误，清理临时文件；
//   - 现有 extends fail-closed、false/'none'、.bak 行为不回归。
//
// 这里的并发用例都是**真实子进程**（node:child_process），不是单进程 Promise 链：
// 计数器丢更新、两个写者同层互覆，只有真并发才会暴露。
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, utimesSync, writeFileSync, writeSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { hostname } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  acquireGateConfigLock,
  gateGuardPath,
  gateLockPath,
  projectGatePath,
  renameWithRetry,
  writeGateConfig,
} from '../lib/index.js'
import { tempDir, writeJsonFile, writeTextFile } from '../test-support/helpers.mjs'

const WORKER = join(dirname(fileURLToPath(import.meta.url)), '..', 'test-support', 'lock-worker.mjs')

const rule = (id = 'own') => ({
  id,
  label: '自定义 ' + id,
  type: 'contains',
  value: '禁止词-' + id,
  triggers: ['issue.reply'],
  message: '命中',
})

/** 跑一个真实子进程 worker，收齐 stdout / stderr 与退出码。 */
function runWorker(args, { timeoutMs = 120000 } = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, [WORKER, ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    const timer = setTimeout(() => {
      child.kill()
      rejectPromise(new Error('worker 超时：' + args.join(' ') + '\n' + stderr))
    }, timeoutMs)
    child.on('error', (error) => {
      clearTimeout(timer)
      rejectPromise(error)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolvePromise({ code, stdout, stderr })
    })
  })
}

const leftovers = (dir) => readdirSync(dir).filter((name) => name.includes('.tmp-')).sort()

/** 锁相关残留：临时文件、锁、守护锁、接管/释放用的隔离文件，一个都不许剩。 */
const lockDebris = (dir) => readdirSync(dir)
  .filter((name) => /\.(tmp-|lock|guard|release-|stale-)/.test(name))
  .sort()

/**
 * 跑一轮真实多进程压力：`workers` 个进程各做 `iterations` 次
 * 「（可选）种 stale 锁 → 拿锁 → 读计数 → 2ms → 写计数并记录读到的值」。
 * 返回计数、读者日志与残留清单。
 */
async function runStress({ workers, iterations, plant }) {
  const dir = tempDir('gate-lock-stress-')
  const configPath = join(dir, '.superagent', 'gates.json')
  const counterPath = join(dir, 'counter.json')
  const logPath = join(dir, 'reads.log')
  mkdirSync(dirname(configPath), { recursive: true })
  writeJsonFile(counterPath, { value: 0 })
  writeFileSync(logPath, '', 'utf8')

  const results = await Promise.all(Array.from({ length: workers }, () => runWorker([
    'stress', configPath, counterPath, logPath, String(iterations), plant ? '--plant' : '--no-plant',
  ])))
  results.forEach((result, index) => {
    assert.equal(result.code, 0, 'worker ' + (index + 1) + ' 失败：' + result.stdout + result.stderr)
  })
  return {
    dir,
    expected: workers * iterations,
    counter: JSON.parse(readFileSync(counterPath, 'utf8')).value,
    reads: readFileSync(logPath, 'utf8').split('\n').filter(Boolean).map(Number),
    debris: lockDebris(join(dir, '.superagent')),
  }
}

const sleepMs = (ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms))

async function waitUntil(predicate, { timeoutMs = 120000, label = '条件' } = {}) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await sleepMs(2)
  }
  throw new Error('等待超时：' + label)
}

/** 原子种一把 stale 锁（死 pid + 60s 前 mtime）：O_EXCL 建、写负载、回拨 mtime。 */
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
  utimesSync(lockPath, old, old)
  return true
}

const countDone = (controlDir, round) => readdirSync(controlDir)
  .filter((name) => name.startsWith('done-' + round + '-')).length

/**
 * Q1 的排布：12 个写者就位 → 父进程**每轮先种一把 stale 锁、再发轮次号** →
 * 12 个写者同时醒来抢同一把锁（每轮一次真实的接管竞争），共 `rounds` 轮。
 */
async function runBarrierStress({ workers, rounds }) {
  const dir = tempDir('gate-lock-barrier-')
  const configPath = join(dir, '.superagent', 'gates.json')
  const counterPath = join(dir, 'counter.json')
  const logPath = join(dir, 'reads.log')
  const controlDir = join(dir, 'control')
  mkdirSync(dirname(configPath), { recursive: true })
  mkdirSync(controlDir, { recursive: true })
  writeJsonFile(counterPath, { value: 0 })
  writeFileSync(logPath, '', 'utf8')
  const lockPath = gateLockPath(configPath)

  const children = Array.from({ length: workers }, (_, index) => runWorker([
    'barrier', configPath, counterPath, logPath, String(rounds), String(index), controlDir,
  ]))

  for (let round = 1; round <= rounds; round += 1) {
    // 每轮每个写者写一个 `done-<round>-<index>` 标记；等上一轮 12 个都到齐再发下一轮。
    await waitUntil(
      () => round === 1 || countDone(controlDir, round - 1) >= workers,
      { label: '第 ' + (round - 1) + ' 轮写完' },
    )
    // 上一轮全部 release 之后才种：只在锁空着时原子创建，绝不覆盖真实锁。
    await waitUntil(() => plantStaleLock(lockPath), { label: '第 ' + round + ' 轮种 stale 锁' })
    // 每轮一个独立标记文件：只创建、不覆盖；12 个写者同时读也碰不到共享冲突。
    writeFileSync(join(controlDir, 'round-' + round), '1', 'utf8')
  }
  await waitUntil(() => countDone(controlDir, rounds) >= workers, { label: '最后一轮写完' })

  const results = await Promise.all(children)
  results.forEach((result, index) => {
    assert.equal(result.code, 0, 'writer ' + (index + 1) + ' 失败：' + result.stdout + result.stderr)
  })
  return {
    dir,
    expected: workers * rounds,
    counter: JSON.parse(readFileSync(counterPath, 'utf8')).value,
    reads: readFileSync(logPath, 'utf8').split('\n').filter(Boolean).map(Number),
    debris: lockDebris(join(dir, '.superagent')),
  }
}

/** 断言：抛出的错误必须带稳定 code、点名锁/配置路径与所有者证据。 */
function assertLockError(fn, { code, lockPath, ownerPid }) {
  assert.throws(fn, (error) => {
    const message = String((error && error.message) || error)
    assert.equal(error.code, code, '错误 code 必须稳定：' + message)
    assert.ok(message.includes(lockPath), '错误必须点名锁文件路径，实际：' + message)
    if (ownerPid !== undefined) {
      assert.equal(error.owner && error.owner.pid, ownerPid, '错误必须带持有者证据')
      assert.ok(message.includes('pid=' + ownerPid), '错误信息里要有持有者 pid，实际：' + message)
    }
    assert.match(message, /未在无锁状态下写入/)
    return true
  })
}

// ── 真实多进程：互斥 ───────────────────────────────────────────────────────

test('跨进程：同一配置路径的写锁保证「读-改-写」串行（计数一次不少）', async () => {
  const dir = tempDir('gate-lock-counter-')
  const configPath = join(dir, '.superagent', 'gates.json')
  const counterPath = join(dir, 'counter.json')
  writeJsonFile(counterPath, { value: 0 })
  const iterations = 15

  const [first, second] = await Promise.all([
    runWorker(['counter', configPath, counterPath, String(iterations)]),
    runWorker(['counter', configPath, counterPath, String(iterations)]),
  ])

  assert.equal(first.code, 0, 'worker 1 失败：' + first.stderr)
  assert.equal(second.code, 0, 'worker 2 失败：' + second.stderr)
  assert.equal(
    JSON.parse(readFileSync(counterPath, 'utf8')).value,
    iterations * 2,
    '两个进程各 ' + iterations + ' 次「读 → 5ms → 写」，计数丢一次就说明锁没串行',
  )
  assert.equal(existsSync(gateLockPath(configPath)), false, '锁用完必须释放')
})

test('跨进程：两个写者同层写入，extends:"none" 不被无锁覆盖，文件始终可解析', async () => {
  const repo = tempDir('gate-lock-ext-')
  const path = projectGatePath(repo)
  const iterations = 25

  const [none, plain] = await Promise.all([
    runWorker(['write', repo, tempDir('gate-home-'), String(iterations), 'none']),
    runWorker(['write', repo, tempDir('gate-home-'), String(iterations), 'plain']),
  ])

  assert.equal(none.code, 0, 'extends 写者失败：' + none.stderr)
  assert.equal(plain.code, 0, '普通写者失败：' + plain.stderr)
  const written = JSON.parse(readFileSync(path, 'utf8'))
  assert.equal(
    written.extends,
    'none',
    '"none" 一旦写下去，后写者必须在锁内读到它并按原样保留；丢掉就退化成 merge 语义',
  )
  assert.equal(written.rules.length, 1, '整层重写：最终文件只保留最后一个写者的规则')
  assert.deepEqual(leftovers(join(repo, '.superagent')), [], '不能留下临时文件')
  assert.equal(existsSync(gateLockPath(path)), false, '两个写者都要释放锁')
})

// ── C2：stale 接管的并发安全（Q1 medium）──────────────────────────────────

test('压力：12 写者同时抢同一把 stale 锁，临界区不得重叠（计数一次不少、无重复读）', async () => {
  const result = await runStress({ workers: 12, iterations: 8, plant: true })
  assert.equal(
    result.counter,
    result.expected,
    '两个写者同时进了临界区就会吞掉一次自增：期望 ' + result.expected + '，实际 ' + result.counter,
  )
  assert.equal(result.reads.length, result.expected, '每个进过临界区的写者都要留下一条读记录')
  assert.equal(
    new Set(result.reads).size,
    result.expected,
    'DUP_READS：临界区里读到了重复值，说明两个写者同时在临界区（明细：' + result.reads.join(',') + '）',
  )
  assert.deepEqual(result.debris, [], '接管/释放不能留下 .lock / .guard / .tmp- / .release- / .stale- 残留')
})

test('正对照：没有 stale 锁时 12 写者正常竞争，计数一次不少（守护机制不误伤）', async () => {
  const result = await runStress({ workers: 12, iterations: 6, plant: false })
  assert.equal(result.counter, result.expected, '没有 stale 锁时也必须串行：期望 ' + result.expected + '，实际 ' + result.counter)
  assert.equal(new Set(result.reads).size, result.expected, '正对照里同样不允许 DUP_READS')
  assert.deepEqual(result.debris, [], '正对照同样不许留残留')
})

test('Q1 排布：12 写者 × 12 轮同抢一把 stale 锁，临界区不得重叠', async () => {
  const result = await runBarrierStress({ workers: 12, rounds: 12 })
  assert.equal(
    result.counter,
    result.expected,
    '两个写者同时进临界区会吞掉自增：期望 ' + result.expected + '，实际 ' + result.counter,
  )
  assert.equal(result.reads.length, result.expected, '每个写者每轮都要留下一条读记录')
  assert.equal(
    new Set(result.reads).size,
    result.expected,
    'DUP_READS：有写者读到了重复值，说明两个写者同时在临界区',
  )
  assert.deepEqual(result.debris, [], '接管/释放不能留下 .lock / .guard / .tmp- / .release- / .stale- 残留')
})

// ── 锁失败：显式失败，不得无锁写 ───────────────────────────────────────────
test('锁被占用：等待超时后显式失败，磁盘原样不动（真实跨进程）', async () => {
  const repo = tempDir('gate-lock-timeout-')
  const path = projectGatePath(repo)
  writeJsonFile(path, { version: 1, name: 'project', extends: 'none', rules: [rule('before')] })
  const before = readFileSync(path, 'utf8')
  const lockPath = gateLockPath(path)

  const lock = acquireGateConfigLock(path, { timeoutMs: 5000 })
  try {
    const result = await runWorker(['write', repo, tempDir('gate-home-'), '1', 'plain', '200'])
    assert.equal(result.code, 2, '子进程必须显式失败，stdout：' + result.stdout + ' stderr：' + result.stderr)
    const payload = JSON.parse(result.stdout)
    assert.equal(payload.ok, false)
    assert.equal(payload.code, 'gate_lock_timeout')
    assert.ok(payload.message.includes(lockPath), '错误必须点名锁路径，实际：' + payload.message)
    assert.ok(payload.message.includes('pid=' + process.pid), '错误必须带持有者证据，实际：' + payload.message)
    assert.match(payload.message, /未在无锁状态下写入/)
  } finally {
    lock.release()
  }

  assert.equal(readFileSync(path, 'utf8'), before, '锁没拿到就不能写盘')
  assert.equal(existsSync(path + '.bak'), false, '拒绝写盘不该产生 .bak')
  assert.deepEqual(leftovers(join(repo, '.superagent')), [], '不能留下临时文件')
  assert.equal(existsSync(lockPath), false, '释放后锁文件必须消失')
})

test('活锁 + 未到 stale 年龄：等待超时失败，不抢活锁（不静默删除别人的锁）', () => {
  const repo = tempDir('gate-lock-live-')
  const path = projectGatePath(repo)
  mkdirSync(dirname(path), { recursive: true })
  const lockPath = gateLockPath(path)
  const token = 'live-token-' + process.pid
  writeTextFile(lockPath, JSON.stringify({
    pid: process.pid,
    hostname: hostname(),
    startedAt: new Date().toISOString(),
    token,
  }) + '\n')
  const before = readFileSync(lockPath, 'utf8')

  assertLockError(
    () => writeGateConfig('project', { version: 1, name: 'project', rules: [rule('blocked')] }, {
      repo,
      home: tempDir('gate-home-'),
      env: {},
      lockTimeoutMs: 80,
      lockPollMs: 10,
    }),
    { code: 'gate_lock_timeout', lockPath, ownerPid: process.pid },
  )

  assert.equal(existsSync(path), false, '没拿到锁就不能创建配置')
  assert.equal(readFileSync(lockPath, 'utf8'), before, '活锁内容必须原样保留（年龄不够不能接管）')
  writeTextFile(lockPath, '') // 清理：让 tempDir 的退出清理能删掉它
})

// ── stale lock：年龄与所有者证据 ───────────────────────────────────────────

test('stale lock：所有者进程已死 → 立即接管，并留下所有者证据', () => {
  const repo = tempDir('gate-lock-stale-dead-')
  const path = projectGatePath(repo)
  mkdirSync(dirname(path), { recursive: true })
  const lockPath = gateLockPath(path)
  const deadPid = 999999
  assert.throws(() => process.kill(deadPid, 0), /ESRCH/, '前置：该 pid 必须不存在')
  writeTextFile(lockPath, JSON.stringify({
    pid: deadPid,
    hostname: hostname(),
    startedAt: new Date(Date.now() - 2000).toISOString(),
    token: 'dead-token',
  }) + '\n')

  const saved = writeGateConfig('project', { version: 1, name: 'project', rules: [rule('after-dead')] }, {
    repo,
    home: tempDir('gate-home-'),
    env: {},
  })

  assert.equal(saved.lock.broken.length, 1, '死锁必须被识别并记录一次')
  const [evidence] = saved.lock.broken
  assert.equal(evidence.reason, 'owner_dead')
  assert.equal(evidence.owner.pid, deadPid, '证据里必须有所有者 pid')
  assert.equal(evidence.owner.token, 'dead-token')
  assert.ok(evidence.ageMs >= 0, '证据里必须有年龄')
  assert.equal(evidence.path, lockPath)
  assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')).rules.map((item) => item.id), ['after-dead'])
  assert.equal(existsSync(lockPath), false, '接管后锁必须释放')
})

test('stale lock：年龄超过阈值 → 接管并记录年龄（活着的锁不会被静默删除）', () => {
  const repo = tempDir('gate-lock-stale-age-')
  const path = projectGatePath(repo)
  mkdirSync(dirname(path), { recursive: true })
  const lockPath = gateLockPath(path)
  writeTextFile(lockPath, JSON.stringify({
    pid: process.pid,
    hostname: hostname(),
    startedAt: new Date(Date.now() - 60000).toISOString(),
    token: 'old-token',
  }) + '\n')
  const old = new Date(Date.now() - 60000)
  utimesSync(lockPath, old, old)

  const saved = writeGateConfig('project', { version: 1, name: 'project', rules: [rule('after-age')] }, {
    repo,
    home: tempDir('gate-home-'),
    env: {},
    lockStaleMs: 30000,
  })

  assert.equal(saved.lock.broken.length, 1, '超龄锁必须被识别并记录')
  const [evidence] = saved.lock.broken
  assert.equal(evidence.reason, 'age')
  assert.ok(evidence.ageMs >= 30000, '证据里的年龄必须达到阈值，实际：' + evidence.ageMs)
  assert.equal(evidence.owner.pid, process.pid)
  assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')).rules.map((item) => item.id), ['after-age'])
  assert.equal(existsSync(lockPath), false, '接管后锁必须释放')
})

// ── C2：接管段互斥 / 释放不误删 / 守护锁 ───────────────────────────────────

test('stale 守护锁（持有者已死）被接管：写盘照常，且不残留 .guard', () => {
  const repo = tempDir('gate-lock-guard-stale-')
  const path = projectGatePath(repo)
  const lockPath = gateLockPath(path)
  mkdirSync(dirname(path), { recursive: true })
  const guardPath = lockPath + '.guard'
  const deadPid = 999999
  assert.throws(() => process.kill(deadPid, 0), /ESRCH/, '前置：该 pid 必须不存在')
  writeTextFile(guardPath, JSON.stringify({
    pid: deadPid,
    hostname: hostname(),
    startedAt: new Date(Date.now() - 2000).toISOString(),
    token: 'dead-guard',
  }) + '\n')

  const saved = writeGateConfig('project', { version: 1, name: 'project', rules: [rule('after-guard')] }, {
    repo,
    home: tempDir('gate-home-'),
    env: {},
  })

  assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')).rules.map((item) => item.id), ['after-guard'])
  assert.equal(saved.lock.broken.length, 0, '守护锁接管不算配置锁接管：证据只记真锁')
  assert.equal(existsSync(guardPath), false, '守护锁用完/接管后必须消失')
  assert.equal(existsSync(lockPath), false, '配置锁同样必须释放')
})

test('stale 守护锁（活着的持有者超龄）→ 接管并继续写盘，不残留 .guard', () => {
  const repo = tempDir('gate-lock-guard-age-')
  const path = projectGatePath(repo)
  const lockPath = gateLockPath(path)
  mkdirSync(dirname(path), { recursive: true })
  const guardPath = gateGuardPath(path)
  writeTextFile(guardPath, JSON.stringify({
    pid: process.pid,
    hostname: hostname(),
    startedAt: new Date(Date.now() - 60000).toISOString(),
    token: 'old-guard',
  }) + '\n')
  const old = new Date(Date.now() - 60000)
  utimesSync(guardPath, old, old)

  const saved = writeGateConfig('project', { version: 1, name: 'project', rules: [rule('after-guard-age')] }, {
    repo,
    home: tempDir('gate-home-'),
    env: {},
    lockGuardStaleMs: 5000,
  })

  assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')).rules.map((item) => item.id), ['after-guard-age'])
  assert.equal(saved.lock.broken.length, 0, '守护锁接管不算配置锁接管')
  assert.equal(existsSync(guardPath), false, '超龄守护锁必须被接管并释放')
  assert.equal(existsSync(lockPath), false, '配置锁同样必须释放')
})

test('release：锁已被换成别人的 token 时不误删（原样还原，返回 false）', () => {
  const repo = tempDir('gate-lock-release-toctou-')
  const path = projectGatePath(repo)
  mkdirSync(dirname(path), { recursive: true })
  const lockPath = gateLockPath(path)
  const lock = acquireGateConfigLock(path, { timeoutMs: 2000 })
  assert.equal(lock.isOwner(), true, '前置：刚拿到的锁必须算自己的')

  // 模拟「本进程的锁被判定 stale 接管过」：磁盘上已经是别人那把。
  writeTextFile(lockPath, JSON.stringify({
    pid: process.pid,
    hostname: hostname(),
    startedAt: new Date().toISOString(),
    token: 'foreign-token',
  }) + '\n')

  assert.equal(lock.release(), false, '不是自己的锁不能报告释放成功')
  assert.ok(existsSync(lockPath), '别人的锁必须留在原处，不能被删掉')
  assert.equal(JSON.parse(readFileSync(lockPath, 'utf8')).token, 'foreign-token', '内容也必须原样')
  assert.deepEqual(lockDebris(join(repo, '.superagent')), ['gates.json.lock'], '只能剩别人那把锁，不能留隔离文件')
})

test('isOwner / assertOwner：锁被换掉后立刻检测到，绝不带着别人的锁写盘', () => {
  const repo = tempDir('gate-lock-owner-')
  const path = projectGatePath(repo)
  mkdirSync(dirname(path), { recursive: true })
  const lockPath = gateLockPath(path)
  const lock = acquireGateConfigLock(path, { timeoutMs: 2000 })
  assert.equal(lock.isOwner(), true)

  writeTextFile(lockPath, JSON.stringify({
    pid: process.pid,
    hostname: hostname(),
    startedAt: new Date().toISOString(),
    token: 'stolen-token',
  }) + '\n')

  assert.equal(lock.isOwner(), false, '磁盘上的锁已经不是自己的')
  assert.throws(
    () => lock.assertOwner(),
    (error) => {
      assert.equal(error.code, 'gate_lock_lost', '必须给稳定的 code')
      assert.match(error.message, /写锁已不在自己手里/)
      assert.ok(error.message.includes(lockPath))
      return true
    },
  )
  lock.release()
  assert.equal(JSON.parse(readFileSync(lockPath, 'utf8')).token, 'stolen-token', 'release 也不能删别人的锁')
})

// ── rename：Windows EPERM / EBUSY 有界退避 ─────────────────────────────────

test('rename EPERM / EBUSY：有界退避重试，前两次失败后成功', () => {
  const dir = tempDir('gate-rename-retry-')
  const tmp = join(dir, 'gates.json.tmp-1')
  const target = join(dir, 'gates.json')
  writeTextFile(tmp, '{"ok":true}\n')
  const calls = []
  const rename = (from, to) => {
    calls.push({ from, to })
    if (calls.length < 3) {
      const error = new Error((calls.length === 1 ? 'EPERM' : 'EBUSY') + ': mock 占用')
      error.code = calls.length === 1 ? 'EPERM' : 'EBUSY'
      throw error
    }
    return renameSync(from, to)
  }

  const result = renameWithRetry(tmp, target, { rename, backoffMs: 1 })
  assert.equal(result.attempts, 3, 'EPERM / EBUSY 各重试一次后第三次成功')
  assert.equal(calls.length, 3)
  assert.equal(readFileSync(target, 'utf8'), '{"ok":true}\n')
  assert.equal(existsSync(tmp), false, '成功后临时文件已经变成目标文件')
})

test('rename 非重试错误（EACCES）立即失败，不做无谓退避', () => {
  const dir = tempDir('gate-rename-fatal-')
  const tmp = join(dir, 'gates.json.tmp-2')
  writeTextFile(tmp, '{}\n')
  let calls = 0
  const rename = () => {
    calls += 1
    const error = new Error('EACCES: denied')
    error.code = 'EACCES'
    throw error
  }
  assert.throws(
    () => renameWithRetry(tmp, join(dir, 'gates.json'), { rename, backoffMs: 1 }),
    (error) => {
      assert.equal(error.code, 'EACCES')
      assert.match(error.message, /无法原子替换/)
      assert.equal(error.attempts, 1)
      return true
    },
  )
  assert.equal(calls, 1, '只有 EPERM / EBUSY 才重试')
})

test('rename 重试耗尽：原文件不变、临时文件清理、错误点名路径与次数、锁释放', () => {
  const repo = tempDir('gate-rename-exhaust-')
  const path = projectGatePath(repo)
  const lockPath = gateLockPath(path)
  writeJsonFile(path, { version: 1, name: 'project', extends: 'none', rules: [rule('keep')] })
  const before = readFileSync(path, 'utf8')
  let calls = 0
  const rename = () => {
    calls += 1
    const error = new Error('EPERM: 目标文件被占用')
    error.code = 'EPERM'
    throw error
  }

  assert.throws(
    () => writeGateConfig('project', { version: 1, name: 'project', rules: [rule('lost')] }, {
      repo,
      home: tempDir('gate-home-'),
      env: {},
      rename,
      renameAttempts: 3,
      renameBackoffMs: 1,
    }),
    (error) => {
      assert.equal(error.code, 'EPERM', '原始错误码要保持可判')
      assert.match(error.message, /无法原子替换/)
      assert.ok(error.message.includes(path), '错误必须点名配置路径，实际：' + error.message)
      assert.equal(error.attempts, 3, '重试次数必须写进错误')
      return true
    },
  )

  assert.equal(calls, 3, 'EPERM 必须重试到上限')
  assert.equal(readFileSync(path, 'utf8'), before, '最终失败必须保留原文件')
  assert.deepEqual(leftovers(join(repo, '.superagent')), [], '最终失败必须清理临时文件')
  assert.equal(existsSync(lockPath), false, '失败路径也要释放锁')
})

// ── Windows：并发创建锁文件是 EPERM / EBUSY，不是 EEXIST ───────────────────

test('Windows：并发创建锁文件拿到 EPERM / EBUSY → 按竞争等待，不直接失败', () => {
  const repo = tempDir('gate-lock-eperm-create-')
  const path = projectGatePath(repo)
  mkdirSync(dirname(path), { recursive: true })
  const lockPath = gateLockPath(path)
  const codes = ['EPERM', 'EBUSY']
  let calls = 0
  const open = (file, flags, mode) => {
    calls += 1
    if (calls <= codes.length) {
      const error = new Error(codes[calls - 1] + '：并发创建同一个锁文件')
      error.code = codes[calls - 1]
      throw error
    }
    return openSync(file, flags, mode)
  }

  const lock = acquireGateConfigLock(path, { open, sleep: () => {} })
  try {
    // 同一个 open 也覆盖守护锁：EPERM / EBUSY 各退让一次后，守护锁与配置锁依次建出来。
    assert.ok(calls >= 3, 'EPERM / EBUSY 必须按竞争重试，实际 open 调用：' + calls)
    assert.ok(existsSync(lockPath), '最终必须拿到锁')
    assert.equal(JSON.parse(readFileSync(lockPath, 'utf8')).pid, process.pid)
    assert.equal(existsSync(gateGuardPath(path)), false, '守护锁必须已经释放')
  } finally {
    lock.release()
  }
  assert.equal(existsSync(lockPath), false, '释放后锁文件必须消失')
})

test('锁文件始终创建不出来（只读目录 / 权限）→ 报原始创建错误，不伪装成超时', () => {
  const repo = tempDir('gate-lock-create-fail-')
  const path = projectGatePath(repo)
  mkdirSync(dirname(path), { recursive: true })
  let calls = 0
  const open = () => {
    calls += 1
    const error = new Error('EPERM: 目录只读')
    error.code = 'EPERM'
    throw error
  }

  assert.throws(
    () => acquireGateConfigLock(path, { open, timeoutMs: 0, sleep: () => {} }),
    (error) => {
      assert.equal(error.code, 'EPERM', '必须保留原始错误码，不能报成 gate_lock_timeout')
      assert.match(error.message, /无法创建门禁配置写锁/)
      assert.match(error.message, /未在无锁状态下写入/)
      return true
    },
  )
  assert.equal(calls, 1, 'timeout=0 时只尝试一次')
  assert.equal(existsSync(gateLockPath(path)), false, '创建失败不该留下锁文件')
})

// ── 回归：既有 extends / .bak 语义不因加锁变化 ─────────────────────────────

test('writeGateConfig：成功写盘后释放锁，且 .bak 与 extends 语义不回归', () => {
  const repo = tempDir('gate-lock-regress-')
  const path = projectGatePath(repo)
  writeJsonFile(path, { version: 1, name: 'project', extends: 'none', rules: [rule('old')] })

  const saved = writeGateConfig('project', { version: 1, name: 'project', rules: [rule('fresh')] }, {
    repo,
    home: tempDir('gate-home-'),
    env: {},
  })

  assert.equal(saved.config.extends, 'none', '入参不带 extends 时必须沿用磁盘上的 "none"')
  assert.equal(saved.lock.path, gateLockPath(path), '返回值里要能拿到本次用的锁路径')
  assert.deepEqual(saved.lock.broken, [], '没有 stale 锁时接管证据必须是空数组')
  assert.equal(JSON.parse(readFileSync(path, 'utf8')).extends, 'none')
  assert.ok(readFileSync(path + '.bak', 'utf8').includes('old'), '.bak 必须是写盘前的原文')
  assert.deepEqual(lockDebris(join(repo, '.superagent')), [], '锁、守护锁、临时文件都不能残留')
  assert.equal(existsSync(gateLockPath(path)), false, '锁必须在 finally 里释放')
})

test('跨进程：stale 接管压力下两个写者同层写入，extends:"none" 仍不丢', async () => {
  const repo = tempDir('gate-lock-ext-stale-')
  const path = projectGatePath(repo)
  const iterations = 12
  const [none, plain] = await Promise.all([
    runWorker(['write', repo, tempDir('gate-home-'), String(iterations), 'none', '15000', '--plant']),
    runWorker(['write', repo, tempDir('gate-home-'), String(iterations), 'plain', '15000', '--plant']),
  ])
  assert.equal(none.code, 0, 'extends 写者失败：' + none.stdout + none.stderr)
  assert.equal(plain.code, 0, '普通写者失败：' + plain.stdout + plain.stderr)
  assert.equal(JSON.parse(readFileSync(path, 'utf8')).extends, 'none', '接管 stale 锁不能把 "none" 一起丢掉')
  assert.deepEqual(lockDebris(join(repo, '.superagent')), [], '不能留 .lock / .guard / .tmp- 残留')
})

test('writeGateConfig：extends 共享基被拒绝时也在 finally 里释放锁', () => {
  const repo = tempDir('gate-lock-reject-')
  const path = projectGatePath(repo)
  writeJsonFile(join(repo, '.superagent', 'shared.json'), { version: 1, rules: [rule('shared')] })
  writeJsonFile(path, { version: 1, name: 'project', extends: './shared.json', rules: [rule('own')] })

  assert.throws(
    () => writeGateConfig('project', { version: 1, name: 'project', rules: [rule('next')] }, {
      repo,
      home: tempDir('gate-home-'),
      env: {},
    }),
    (error) => {
      assert.equal(error.code, 'extends_not_preservable')
      return true
    },
  )
  assert.equal(existsSync(gateLockPath(path)), false, '抛错路径也必须释放锁')
  assert.deepEqual(leftovers(join(repo, '.superagent')), [])
})
