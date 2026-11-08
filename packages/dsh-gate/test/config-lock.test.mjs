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
import { existsSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, utimesSync } from 'node:fs'
import { hostname } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  acquireGateConfigLock,
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
    assert.equal(calls, 3, 'EPERM / EBUSY 各退让一次，第三次真的建锁')
    assert.ok(existsSync(lockPath), '最终必须拿到锁')
    assert.equal(JSON.parse(readFileSync(lockPath, 'utf8')).pid, process.pid)
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
  assert.deepEqual(leftovers(join(repo, '.superagent')), [])
  assert.equal(existsSync(gateLockPath(path)), false, '锁必须在 finally 里释放')
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
