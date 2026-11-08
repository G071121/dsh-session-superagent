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
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, utimesSync, writeFileSync, writeSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { hostname } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  acquireGateConfigLock,
  gateGuardPath,
  gateLockPath,
  projectGatePath,
  pruneLockArtifacts,
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
  const result = await runStress({ workers: 12, iterations: 6, plant: true })
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
  const result = await runStress({ workers: 12, iterations: 4, plant: false })
  assert.equal(result.counter, result.expected, '没有 stale 锁时也必须串行：期望 ' + result.expected + '，实际 ' + result.counter)
  assert.equal(new Set(result.reads).size, result.expected, '正对照里同样不允许 DUP_READS')
  assert.deepEqual(result.debris, [], '正对照同样不许留残留')
})

test('Q1 排布：12 写者 × 10 轮同抢一把 stale 锁，临界区不得重叠', async () => {
  const result = await runBarrierStress({ workers: 12, rounds: 10 })
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

// ── C3：release 不得搬走 / 释放别人的新锁（Q1R release-window）─────────────

test('真实场景：A 挂起 → B 接管 → A 恢复释放，第三写者不得在窗口里进临界区', async () => {
  const repo = tempDir('gate-release-window-')
  const path = projectGatePath(repo)
  mkdirSync(dirname(path), { recursive: true })
  const lockPath = gateLockPath(path)
  const probes = Array.from({ length: 6 }, (_, index) => join(repo, 'c' + (index + 1) + '.json'))

  // A：旧持有者。拿到锁后「挂起」，锁年龄很快超过 staleMs。
  const lockA = acquireGateConfigLock(path, { timeoutMs: 2000 })
  assert.equal(lockA.isOwner(), true)
  await sleepMs(150) // 注入延迟：A 挂起期间锁超龄（下一步用 staleMs=60 接管）

  // B：接管 stale 锁，成为当前持有者（另一个写者的视角）。
  const lockB = acquireGateConfigLock(path, { timeoutMs: 2000, staleMs: 60, pollMs: 5 })
  assert.equal(lockB.isOwner(), true, '前置：B 必须接管成功')
  assert.equal(lockA.isOwner(), false, '前置：A 已经不是锁的主人')
  assert.ok(readFileSync(lockPath, 'utf8').includes(lockB.token), '前置：磁盘上是 B 的锁')

  // 注入延迟：把 B 的锁写成「合法但很大」的 JSON。旧实现 release 会先把 lockPath rename 走，
  // 再 read + JSON.parse 这个文件才决定要不要还原 —— 文件越大，那个「lockPath 不在」的空窗越长。
  // 这就是 Q1R 要的注入延迟用例：窗口被稳定放大，第三写者必然能趁虚而入。
  const padded = {
    pid: process.pid,
    hostname: hostname(),
    startedAt: new Date().toISOString(),
    token: lockB.token,
    configPath: path,
    padding: 'x'.repeat(2 * 1024 * 1024),
  }
  writeFileSync(lockPath, JSON.stringify(padded) + '\n', 'utf8')
  assert.ok(readFileSync(lockPath, 'utf8').includes(lockB.token), '前置：放大后仍是 B 的锁')

  // C1/C2/C3：第三写者，在 A 释放期间纯自旋抢锁（默认 staleMs，不会去抢 B 的新锁）。
  const children = probes.map((marker) => runWorker(['probe-lock', path, marker, '900']))
  await sleepMs(50)

  // A 恢复并释放：旧实现先 rename(lockPath → 私有名)，把 B 的锁搬走 → lockPath 空窗 → C 进来。
  assert.equal(lockA.release(), false, 'A 不是当前持有者，release 必须返回 false')
  assert.equal(lockB.isOwner(), true, 'A release 之后 B 的锁必须还在原位')

  const results = await Promise.all(children)
  results.forEach((result) => assert.equal(result.code, 0, '探针失败：' + result.stderr))
  for (const marker of probes) {
    const observed = JSON.parse(readFileSync(marker, 'utf8'))
    assert.equal(observed.entered, false, '第三写者不能在 B 持有期间进临界区（release 窗口存在）：' + marker)
  }
  assert.equal(lockB.isOwner(), true, '整个窗口里 B 都不能失去锁')
  assert.equal(lockB.release(), true)
  assert.equal(existsSync(lockPath), false, 'B 释放后锁文件必须消失')
  assert.deepEqual(lockDebris(join(repo, '.superagent')), [], '不能留 .release- / .stale- 等隔离文件')
})

test('release：拿不到守护锁时不碰锁文件（宁可留着也不误删）', () => {
  const repo = tempDir('gate-release-guard-busy-')
  const path = projectGatePath(repo)
  mkdirSync(dirname(path), { recursive: true })
  const lockPath = gateLockPath(path)
  const guardPath = gateGuardPath(path)
  const lock = acquireGateConfigLock(path, { timeoutMs: 300, pollMs: 20 })
  assert.equal(lock.isOwner(), true)

  // 种一把「活着的」守护锁（自己的 pid、刚写，不会超龄）：release 进不了守护区。
  writeTextFile(guardPath, JSON.stringify({
    pid: process.pid,
    hostname: hostname(),
    startedAt: new Date().toISOString(),
    token: 'blocked-guard',
  }) + '\n')

  assert.equal(lock.release(), false, '拿不到守护锁就不能删锁')
  assert.equal(lock.isOwner(), true, '锁文件必须原样留着（不能因为释放失败就乱动）')

  // 守护锁消失后，释放照常成功。
  unlinkSync(guardPath)
  assert.equal(lock.release(), true)
  assert.equal(existsSync(lockPath), false)
  assert.equal(existsSync(guardPath), false)
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

// ── v5 C1：锁残余（.stale-* / .release-*）与旧版无 token 锁 ─────────────────
//
// 冻结行为（docs/任务书-dsh-gate-v5.md 第二节）：
//   - 接管 / 释放的隔离文件只是证据：成功路径必须删干净；失败路径留得下诊断信息、但有界（不会无限堆积）；
//   - 旧版无 token 锁的身份策略：有 token 用 token，无 token 用原文逐字节比对；
//     连内容都读不出来就没有身份证据 → fail closed（不搬走、不删除）；
//   - 解析失败不等于「可删除」：接管理由只有超龄 / 所有者已死，且仍要通过身份核对。

/** 锁目录里的隔离文件（接管 `.stale-*` / 旧版释放 `.release-*`）。 */
const artifactNames = (dir) => readdirSync(dir).filter((name) => /\.(stale|release)-/.test(name)).sort()

test('v5 C1：旧版无 token 锁 + 活着的所有者 → 不接管、超时显式失败、原文原样', () => {
  const repo = tempDir('gate-lock-legacy-live-')
  const path = projectGatePath(repo)
  mkdirSync(dirname(path), { recursive: true })
  const lockPath = gateLockPath(path)
  const payload = JSON.stringify({
    pid: process.pid,
    hostname: hostname(),
    startedAt: new Date().toISOString(),
    legacy: true, // 旧版锁：没有 token
  }) + '\n'
  writeTextFile(lockPath, payload)

  assert.throws(
    () => writeGateConfig('project', { version: 1, name: 'project', rules: [rule('legacy-live')] }, {
      repo,
      home: tempDir('gate-home-'),
      env: {},
      lockTimeoutMs: 120,
      lockPollMs: 10,
    }),
    (error) => {
      assert.equal(error.code, 'gate_lock_timeout')
      assert.equal(error.owner && error.owner.pid, process.pid, '证据里必须有旧版锁的 pid')
      return true
    },
  )
  assert.equal(readFileSync(lockPath, 'utf8'), payload, '活着的旧版锁必须原样保留')
  assert.equal(existsSync(path), false, '没拿到锁不能创建配置')
  assert.deepEqual(artifactNames(dirname(lockPath)), [], '单纯等待不能产生隔离文件')
})

test('v5 C1：旧版无 token 锁 + 所有者已死 → 可接管（原文身份），成功路径不留 .stale-', () => {
  const repo = tempDir('gate-lock-legacy-dead-')
  const path = projectGatePath(repo)
  mkdirSync(dirname(path), { recursive: true })
  const lockPath = gateLockPath(path)
  const deadPid = 999999
  assert.throws(() => process.kill(deadPid, 0), /ESRCH/, '前置：该 pid 必须不存在')
  writeTextFile(lockPath, JSON.stringify({
    pid: deadPid,
    hostname: hostname(),
    startedAt: new Date(Date.now() - 2000).toISOString(),
    legacy: true,
  }) + '\n')

  const saved = writeGateConfig('project', { version: 1, name: 'project', rules: [rule('legacy-dead')] }, {
    repo,
    home: tempDir('gate-home-'),
    env: {},
  })

  assert.equal(saved.lock.broken.length, 1, '旧版死锁必须被识别并记录')
  const [evidence] = saved.lock.broken
  assert.equal(evidence.reason, 'owner_dead')
  assert.equal(evidence.owner.pid, deadPid)
  assert.equal(evidence.leftover, null, '成功清理干净时 leftover 必须是 null')
  assert.equal(existsSync(lockPath), false, '接管后锁必须释放')
  assert.deepEqual(artifactNames(dirname(lockPath)), [], '成功接管必须删掉 .stale- 证据文件')
})

test('v5 C1：锁内容读不出来（EISDIR）→ fail closed：不搬走、不删除，超时点名「内容不可读」', () => {
  const repo = tempDir('gate-lock-unreadable-')
  const path = projectGatePath(repo)
  mkdirSync(dirname(path), { recursive: true })
  const lockPath = gateLockPath(path)
  // 目录：stat 看得到、readFileSync 报 EISDIR —— 旧实现会把它当「空锁」接管掉，等于解析失败就删。
  mkdirSync(lockPath)
  const old = new Date(Date.now() - 60000)
  utimesSync(lockPath, old, old)
  assert.equal(statSync(lockPath).isDirectory(), true, '前置：锁路径必须「看得到、读不出内容」')

  assert.throws(
    () => writeGateConfig('project', { version: 1, name: 'project', rules: [rule('unreadable')] }, {
      repo,
      home: tempDir('gate-home-'),
      env: {},
      lockTimeoutMs: 300,
      lockPollMs: 10,
    }),
    (error) => {
      assert.equal(error.code, 'gate_lock_timeout')
      assert.ok(error.message.includes(lockPath), '错误必须点名锁路径，实际：' + error.message)
      assert.match(error.message, /内容不可读/, '错误必须说明「读不出来」，实际：' + error.message)
      assert.match(error.message, /fail-closed/)
      assert.match(error.message, /未在无锁状态下写入/)
      return true
    },
  )
  assert.equal(statSync(lockPath).isDirectory(), true, '不可读的锁必须原样留在原位（不得搬走 / 删除）')
  assert.equal(existsSync(path), false, 'fail closed 不能写盘')
  assert.deepEqual(artifactNames(dirname(lockPath)), [], '不能把「读不出来」当成接管，留下 .stale-')
})

test('v5 C1：核对窗口内被换成活着的旧版锁 → 不得当成同一把接管（无 token ≠ "undefined"）', () => {
  const repo = tempDir('gate-lock-legacy-swap-')
  const configPath = projectGatePath(repo)
  mkdirSync(dirname(configPath), { recursive: true })
  const lockPath = gateLockPath(configPath)
  const legacyStale = JSON.stringify({
    pid: 999999,
    hostname: hostname(),
    startedAt: new Date(Date.now() - 60000).toISOString(),
    legacy: 'stale',
  }) + '\n'
  writeTextFile(lockPath, legacyStale)
  const old = new Date(Date.now() - 60000)
  utimesSync(lockPath, old, old)
  const legacyLive = JSON.stringify({
    pid: process.pid,
    hostname: hostname(),
    startedAt: new Date().toISOString(),
    legacy: 'live',
  }) + '\n'
  let swapped = false
  const rename = (from, to) => {
    if (!swapped && from === lockPath) {
      // 注入：在「搬走 → 核对」之间把原位换成另一把**活着的**旧版锁。
      // 旧实现用 String(owner.token) 比对，两边都是字面量 "undefined"，会把活锁当死锁删掉。
      writeFileSync(lockPath, legacyLive, 'utf8')
      swapped = true
    }
    return renameSync(from, to)
  }

  assert.throws(
    () => acquireGateConfigLock(configPath, { timeoutMs: 400, pollMs: 10, rename }),
    (error) => {
      assert.equal(error.code, 'gate_lock_timeout', '活锁被搬到核对窗口时必须还原并继续等待')
      return true
    },
  )
  assert.equal(swapped, true, '前置：注入点必须真的触发，否则这条用例没验到身份核对')
  assert.equal(readFileSync(lockPath, 'utf8'), legacyLive, '被误搬的活锁必须原样回到原位')
  assert.deepEqual(artifactNames(dirname(lockPath)), [], '还原后不能留下 .stale- 隔离文件')
})

test('v5 C1：残留证据有界 —— 旧的 .stale-* / .release-* 只留最新 3 份，新鲜的与无关文件不动', () => {
  const repo = tempDir('gate-lock-artifacts-')
  const path = projectGatePath(repo)
  const dir = dirname(path)
  mkdirSync(dir, { recursive: true })
  const base = basename(gateLockPath(path))
  const artifacts = [
    ['stale-old-360', 360000],
    ['release-old-300', 300000],
    ['stale-old-240', 240000],
    ['release-old-180', 180000],
    ['stale-old-120', 120000],
    ['release-old-60', 60000],
  ]
  for (const [suffix, age] of artifacts) {
    const file = join(dir, base + '.' + suffix)
    writeFileSync(file, 'evidence ' + suffix, 'utf8')
    const stamp = new Date(Date.now() - age)
    utimesSync(file, stamp, stamp)
  }
  const fresh = join(dir, base + '.stale-fresh')
  writeFileSync(fresh, 'fresh', 'utf8') // 新鲜 = 可能正被别的进程使用，不许删
  const unrelated = join(dir, base + '-notes.txt')
  writeFileSync(unrelated, 'keep', 'utf8')

  const saved = writeGateConfig('project', { version: 1, name: 'project', rules: [rule('after-prune')] }, {
    repo,
    home: tempDir('gate-home-'),
    env: {},
  })
  assert.deepEqual(saved.lock.broken, [], '这不是接管，只是回收旧残留')

  assert.deepEqual(
    artifactNames(dir),
    [base + '.release-old-60', base + '.stale-fresh', base + '.stale-old-120'],
    '只保留最新的 3 份证据（新鲜的在途文件 + 两份最新的旧文件）',
  )
  assert.ok(existsSync(unrelated), '无关文件一个都不许动')
  assert.ok(existsSync(path), '回收残留不能影响正常写盘')
})

test('v5 C1：清理失败留证有界 —— 接管证据带 leftover，旧残留由下一次写盘回收', () => {
  const repo = tempDir('gate-lock-leftover-')
  const configPath = projectGatePath(repo)
  mkdirSync(dirname(configPath), { recursive: true })
  const dir = dirname(configPath)
  const lockPath = gateLockPath(configPath)
  const deadPid = 999999
  assert.throws(() => process.kill(deadPid, 0), /ESRCH/, '前置：该 pid 必须不存在')
  writeTextFile(lockPath, JSON.stringify({
    pid: deadPid,
    hostname: hostname(),
    startedAt: new Date(Date.now() - 2000).toISOString(),
    token: 'dead-leftover',
  }) + '\n')

  let unlinkAttempts = 0
  const unlink = (target) => {
    if (String(target).includes('.stale-')) {
      unlinkAttempts += 1
      const error = new Error('EPERM: 被占用（替身）')
      error.code = 'EPERM'
      throw error
    }
    return unlinkSync(target)
  }

  const lock = acquireGateConfigLock(configPath, { timeoutMs: 2000, unlink })
  try {
    assert.equal(lock.broken.length, 1, '死锁必须被接管一次')
    const [evidence] = lock.broken
    assert.equal(unlinkAttempts, 3, '清理残留必须有界退避重试（3 次），不是无限重试')
    assert.ok(evidence.leftover && evidence.leftover.includes('.stale-'), '清理失败必须在证据里点名残留文件')
    assert.ok(existsSync(evidence.leftover), '残留文件要真的留着（留证）')
    assert.equal(lock.isOwner(), true, '残留不影响接管结果')
  } finally {
    lock.release()
  }

  const [leftoverName] = artifactNames(dir)
  assert.ok(leftoverName, '前置：接管失败清理必须留下一个隔离文件')
  // v6 C1 起残留的年龄按**本次搬走时间**算（名字里带 `<ts>`）：单纯 utimes 不再能把
  // 「刚搬走」的证据洗成旧的。这里把它重命名成「6 分钟前搬走」的名字（mtime 一并拨旧，
  // 与旧格式残留同形），模拟真正的旧失败证据；再堆三份更新的旧残留。
  const stamped = Date.now() - 360000
  const aged = join(dir, basename(gateLockPath(configPath)) + '.stale-' + stamped + '-' + randomUUID())
  renameSync(join(dir, leftoverName), aged)
  utimesSync(aged, new Date(stamped), new Date(stamped))
  for (const [suffix, age] of [['stale-newer-300', 300000], ['release-newer-240', 240000], ['stale-newer-180', 180000]]) {
    const file = join(dir, basename(gateLockPath(configPath)) + '.' + suffix)
    writeFileSync(file, 'evidence ' + suffix, 'utf8')
    utimesSync(file, new Date(Date.now() - age), new Date(Date.now() - age))
  }

  writeGateConfig('project', { version: 1, name: 'project', rules: [rule('recycle')] }, {
    repo,
    home: tempDir('gate-home-'),
    env: {},
  })
  assert.equal(existsSync(aged), false, '最旧的失败证据必须被下一次写盘回收（有界）')
  assert.equal(
    artifactNames(dir).length,
    3,
    '只保留最新的三份证据（失败路径留证有界，不无限堆积）',
  )
})

// ── v6 C1：残留回收的年龄基准与大小写边界 ───────────────────────────────────
//
// 冻结行为（docs/任务书-dsh-gate-v6.md 第二节，承 v5 L4 / L5）：
//   - 残留的年龄按**本次搬走 / 发现时间**算，不沿用源文件继承的 mtime：`rename` 会保留被搬锁的
//     旧 mtime，一把 5 分钟前的 stale 锁搬成 `.stale-*` 后按 mtime 判龄会「生下来就够旧」；
//   - 名字里的时间戳（`.stale-<ts>-<uuid>`）由 rename 原子落地，是「搬走时间」的权威来源；
//     没有时间戳的（旧格式 / 手写残留）退回 mtime，行为与 v5 一致；
//   - 大小写语义跟随文件系统：Windows 上 `.STALE-` 与本路径的 `.stale-` 是同一个命名空间（v5 L5），
//     POSIX 上是不同文件 —— 一律不碰无关文件（`.bak` / 前缀相似 / 守护锁路径的残留）。

/** 种一把「所有者已死 + 源 mtime 很旧」的 stale 锁（真实 PID 判活）。 */
function plantDeadOldLock(lockPath, { ageMs = 300000, token = 'old-mtime' } = {}) {
  const deadPid = 999999
  assert.throws(() => process.kill(deadPid, 0), /ESRCH/, '前置：该 pid 必须不存在')
  writeTextFile(lockPath, JSON.stringify({
    pid: deadPid,
    hostname: hostname(),
    startedAt: new Date(Date.now() - ageMs).toISOString(),
    token,
  }) + '\n')
  const stamp = new Date(Date.now() - ageMs)
  utimesSync(lockPath, stamp, stamp)
  return lockPath
}

/** 接管时「清理残留永远 EPERM」的替身：制造 leftover 证据。 */
function unlinkStaleAlwaysFails() {
  const counter = { attempts: 0 }
  counter.unlink = (target) => {
    if (String(target).includes('.stale-')) {
      counter.attempts += 1
      const error = new Error('EPERM: 替身占用')
      error.code = 'EPERM'
      throw error
    }
    return unlinkSync(target)
  }
  return counter
}

test('v6 C1：接管搬走的老锁按「搬走时间」计龄 —— 证据生下来不算旧，minAge 内不回收', () => {
  const repo = tempDir('gate-artifact-move-age-')
  const configPath = projectGatePath(repo)
  const dir = dirname(configPath)
  mkdirSync(dir, { recursive: true })
  const lockPath = plantDeadOldLock(gateLockPath(configPath))

  const flaky = unlinkStaleAlwaysFails()
  let leftover = null
  const lock = acquireGateConfigLock(configPath, { timeoutMs: 2000, unlink: flaky.unlink })
  try {
    assert.equal(flaky.attempts, 3, '前置：清理失败走 3 次有界重试')
    const [evidence] = lock.broken
    assert.ok(evidence, '前置：老锁必须被接管一次')
    leftover = evidence.leftover
    assert.ok(leftover && leftover.includes('.stale-'), '前置：清理失败要在证据里点名残留')
    const movedAgeMs = Date.now() - statSync(leftover).mtimeMs
    assert.ok(
      movedAgeMs < 10000,
      '证据文件的 mtime 必须是本次搬走时间，不能沿用源锁 5 分钟前的 mtime（实际 '
        + Math.round(movedAgeMs) + 'ms）',
    )
  } finally {
    lock.release()
  }

  const pruned = pruneLockArtifacts(lockPath, { keep: 0, minAgeMs: 60000 })
  assert.deepEqual(pruned.removed, [], '刚搬走的在途 / 新鲜证据不能被回收（源锁 mtime 旧也不行）')
  assert.ok(existsSync(leftover), '证据文件必须还在（够老才回收）')
})

test('v6 C1：证据新旧按「搬走时间」排 —— 名字里的时间戳优先于继承的 mtime', () => {
  const repo = tempDir('gate-artifact-order-')
  const path = projectGatePath(repo)
  const dir = dirname(path)
  mkdirSync(dir, { recursive: true })
  const lockPath = gateLockPath(path)
  const base = basename(lockPath)
  const now = Date.now()
  const artifact = (name, ageMs) => {
    const file = join(dir, name)
    writeFileSync(file, 'evidence ' + name, 'utf8')
    utimesSync(file, new Date(now - ageMs), new Date(now - ageMs))
    return file
  }

  const oldest = artifact(base + '.stale-' + (now - 120000) + '-a', 120000)
  const middle = artifact(base + '.stale-' + (now - 90000) + '-b', 90000)
  const newer = artifact(base + '.release-' + (now - 62000) + '-c', 62000)
  // 刚搬走、但继承了源锁 3 小时前 mtime 的隔离文件：按「搬走时间」它才是最新的。
  const justMoved = join(dir, base + '.stale-' + now + '-d')
  writeFileSync(justMoved, 'evidence d', 'utf8')
  utimesSync(justMoved, new Date(now - 3 * 3600000), new Date(now - 3 * 3600000))

  const result = pruneLockArtifacts(lockPath, { keep: 3, minAgeMs: 60000 })
  assert.deepEqual(result.removed, [oldest], 'keep=3 只回收「搬走时间」最早的那份')
  assert.ok(existsSync(justMoved), '刚搬走的证据不能被当成最旧删掉（继承 mtime 不算年龄）')
  assert.ok(existsSync(middle) && existsSync(newer), '更新三份证据要留着')
  assert.deepEqual([...result.kept].sort(), [justMoved, middle, newer].sort())
})

test('v6 C1：名字里的搬走时间说了算 —— mtime 被后来触碰过也洗不白旧证据', () => {
  const repo = tempDir('gate-artifact-touched-')
  const path = projectGatePath(repo)
  const dir = dirname(path)
  mkdirSync(dir, { recursive: true })
  const lockPath = gateLockPath(path)
  const base = basename(lockPath)
  const now = Date.now()
  // 名字说「10 分钟前搬走」，mtime 却是刚刚（被 touch 过）：按搬走时间它已经够旧。
  const oldByName = join(dir, base + '.stale-' + (now - 600000) + '-old')
  writeFileSync(oldByName, 'old evidence', 'utf8')

  const result = pruneLockArtifacts(lockPath, { keep: 0, minAgeMs: 60000 })
  assert.deepEqual(result.removed, [oldByName], '旧证据不能靠 touch 永驻（有界才成立）')
})

test('v6 C1：在途 —— rename 之后 / 核对之前的并发 prune 不得回收隔离文件', () => {
  const repo = tempDir('gate-artifact-inflight-')
  const configPath = projectGatePath(repo)
  const dir = dirname(configPath)
  mkdirSync(dir, { recursive: true })
  const lockPath = plantDeadOldLock(gateLockPath(configPath))

  let raced = null
  const rename = (from, to) => {
    renameSync(from, to)
    if (from === lockPath && raced === null) {
      // 另一个写者此刻的回收：源锁 mtime 已 5 分钟，按 mtime 计龄会把刚落地的隔离文件当成「够旧」删掉。
      raced = pruneLockArtifacts(lockPath, { keep: 0, minAgeMs: 60000 })
    }
  }
  const lock = acquireGateConfigLock(configPath, { timeoutMs: 2000, rename })
  try {
    assert.ok(raced, '前置：注入点必须触发')
    assert.deepEqual(raced.removed, [], '并发 prune 不能回收刚搬走的隔离文件（否则身份核对失败、还原丢失）')
    assert.equal(lock.broken.length, 1, '接管必须完成并留证一次（被并发回收会让核对拿不到身份）')
  } finally {
    lock.release()
  }
  assert.deepEqual(artifactNames(dir), [], '成功路径不留隔离文件')
})

test('v6 C1：大小写变体 —— .STALE-/.RELEASE- 按文件系统语义回收，无关文件一个不动', () => {
  const repo = tempDir('gate-artifact-case-')
  const path = projectGatePath(repo)
  const dir = dirname(path)
  mkdirSync(dir, { recursive: true })
  const lockPath = gateLockPath(path)
  const base = basename(lockPath)
  const upper = base.toUpperCase()
  const now = Date.now()
  const make = (name, ageMs, text = 'evidence') => {
    const file = join(dir, name)
    writeFileSync(file, text, 'utf8')
    utimesSync(file, new Date(now - ageMs), new Date(now - ageMs))
    return file
  }

  const lowerOld = make(base + '.stale-' + (now - 400000) + '-a', 400000)
  const upperOld = make(upper + '.STALE-' + (now - 300000) + '-b', 300000)
  const upperRelease = make(upper + '.RELEASE-' + (now - 200000) + '-c', 200000)
  const lowerNew = make(base + '.release-' + (now - 100000) + '-d', 100000)
  const unrelated = [
    make(base + '.bak', 500000, 'backup'),
    make(base + '-notes.txt', 500000, 'notes'),
    make(base + 'x.stale-' + (now - 500000) + '-y', 500000, 'prefix lookalike'),
    make(upper + '.BAK', 500000, 'upper backup'),
  ]

  const posix = pruneLockArtifacts(lockPath, { keep: 0, minAgeMs: 60000, caseInsensitive: false })
  assert.deepEqual(
    [...posix.removed].sort(),
    [lowerOld, lowerNew].sort(),
    '区分大小写（POSIX 语义）时只认本路径产出的残留',
  )
  for (const file of [upperOld, upperRelease, ...unrelated]) {
    assert.ok(existsSync(file), '大小写变体（区分模式）与无关文件都不能删：' + basename(file))
  }

  const windows = pruneLockArtifacts(lockPath, { keep: 0, minAgeMs: 60000, caseInsensitive: true })
  assert.deepEqual(
    [...windows.removed].sort(),
    [upperOld, upperRelease].sort(),
    'Windows 语义下大小写变体是同一个命名空间，一并回收',
  )
  for (const file of unrelated) {
    assert.ok(existsSync(file), '无关文件一个都不许动：' + basename(file))
  }
})

test('v6 C1：默认大小写语义跟随平台（Windows 不区分 / POSIX 区分）', () => {
  const repo = tempDir('gate-artifact-case-default-')
  const path = projectGatePath(repo)
  const dir = dirname(path)
  mkdirSync(dir, { recursive: true })
  const lockPath = gateLockPath(path)
  const base = basename(lockPath)
  const now = Date.now()
  const upperOld = join(dir, base.toUpperCase() + '.STALE-' + (now - 300000) + '-z')
  writeFileSync(upperOld, 'upper evidence', 'utf8')
  utimesSync(upperOld, new Date(now - 300000), new Date(now - 300000))

  const result = pruneLockArtifacts(lockPath, { keep: 0, minAgeMs: 60000 })
  if (process.platform === 'win32') {
    assert.deepEqual(result.removed, [upperOld], 'Windows 默认必须把大小写变体当同一个残留')
  } else {
    assert.deepEqual(result.removed, [], 'POSIX 默认不碰大小写不同的真实文件')
    assert.ok(existsSync(upperOld), 'POSIX 上另一个文件原样保留')
  }
})

test('v6 C1：刷不动 mtime（EPERM 替身）也不丢证据 —— 名字里的搬走时间兜底', () => {
  const repo = tempDir('gate-artifact-utimes-fail-')
  const configPath = projectGatePath(repo)
  const dir = dirname(configPath)
  mkdirSync(dir, { recursive: true })
  const lockPath = plantDeadOldLock(gateLockPath(configPath))

  const flaky = unlinkStaleAlwaysFails()
  const utimes = () => {
    const error = new Error('EPERM: 替身占用（utimes）')
    error.code = 'EPERM'
    throw error
  }
  let leftover = null
  const lock = acquireGateConfigLock(configPath, { timeoutMs: 2000, unlink: flaky.unlink, utimes })
  try {
    const [evidence] = lock.broken
    assert.ok(evidence, '前置：老锁必须被接管一次')
    leftover = evidence.leftover
    assert.ok(leftover && leftover.includes('.stale-'), '前置：清理失败要在证据里点名残留')
    const untouchedAgeMs = Date.now() - statSync(leftover).mtimeMs
    assert.ok(untouchedAgeMs > 240000, '前置：mtime 刷不动时仍是源锁的旧 mtime（实际 ' + Math.round(untouchedAgeMs) + 'ms）')
  } finally {
    lock.release()
  }

  const pruned = pruneLockArtifacts(lockPath, { keep: 0, minAgeMs: 60000 })
  assert.deepEqual(pruned.removed, [], '名字里的搬走时间是权威：mtime 旧也按新鲜在途文件保护')
  assert.ok(existsSync(leftover), '证据文件必须还在')
})

test('v6 C1：守护锁路径的残留同规则 —— 按搬走时间计龄，且不被主锁的回收顺带删掉', () => {
  const repo = tempDir('gate-artifact-guard-')
  const path = projectGatePath(repo)
  const dir = dirname(path)
  mkdirSync(dir, { recursive: true })
  const lockPath = gateLockPath(path)
  const guardPath = gateGuardPath(path)
  const base = basename(lockPath)
  const now = Date.now()
  const make = (name, ageMs) => {
    const file = join(dir, name)
    writeFileSync(file, 'evidence ' + name, 'utf8')
    utimesSync(file, new Date(now - ageMs), new Date(now - ageMs))
    return file
  }

  // 刚搬走的守护锁证据：继承了源守护锁 3 小时前的 mtime，按搬走时间它是新鲜的。
  const justMovedGuard = make(base + '.guard.stale-' + now + '-g', 3 * 3600000)
  const oldGuard = make(base + '.guard.release-' + (now - 300000) + '-h', 300000)

  const lockPrune = pruneLockArtifacts(lockPath, { keep: 3, minAgeMs: 60000 })
  assert.deepEqual(lockPrune.removed, [], '主锁的回收不能顺带删守护锁路径的残留')

  const guardPrune = pruneLockArtifacts(guardPath, { keep: 0, minAgeMs: 60000 })
  assert.deepEqual(guardPrune.removed, [oldGuard], '守护锁路径自己回收：旧的删、刚搬走（继承旧 mtime）的留')
  assert.ok(existsSync(justMovedGuard), '刚搬走的守护锁证据必须留着')
})

