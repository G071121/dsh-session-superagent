/**
 * 同一配置路径的跨进程写锁 + 原子替换（rename）重试。
 *
 * 为什么需要：`writeGateConfig()` 是「读旧文件（extends）→ 校验 → 备份 → 临时写入 → rename」
 * 五步，两个写者（面板保存、CLI、主插件）同时进来时，后写者可能拿着**旧快照**通过校验，
 * 再把先写者刚写下的 `extends: "none"` / `false` 冲掉 —— 语义从「替换」静默退化成「合并」。
 * 锁文件用 `open(path, 'wx')` 原子创建（O_EXCL，Windows / POSIX 都成立），把整段串行起来。
 *
 * 三条硬约束（docs/任务书-dsh-gate-v4.md「门禁写盘」）：
 *   1. 拿不到锁**显式失败**，绝不退回无锁写；
 *   2. 只有**超龄**（或所有者进程已死）的锁才算 stale，清理时留下年龄与所有者证据；
 *   3. Windows 上目标文件被占用时 rename 会 EPERM / EBUSY：有界退避重试，最终失败保留原文件。
 *
 * 锁是**跨进程互斥**，不是分布式锁：判据是同一台机器、同一路径；跨主机共享盘不保证。
 * 超龄接管的含义：单次写盘耗时超过 `staleMs` 时理论上可能被并发接管 —— 所以默认 30s，
 * 远大于一次「读 → 校验 → 写 → rename」的毫秒级窗口；崩在中间的锁会留下文件，由下一次写入接管。
 */
import { closeSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { hostname } from 'node:os'

/** 锁文件后缀：`<gates.json>.lock`，和配置同目录（目录不存在时调用方先建）。 */
export const GATE_LOCK_SUFFIX = '.lock'
/** 等锁上限：超过就显式失败（写盘是毫秒级操作，5s 已经足够宽）。 */
export const DEFAULT_GATE_LOCK_TIMEOUT_MS = 5000
/** 等锁轮询间隔。 */
export const DEFAULT_GATE_LOCK_POLL_MS = 15
/** 超过这个年龄的锁视为 stale（持有者极可能已经崩在中间）。 */
export const DEFAULT_GATE_LOCK_STALE_MS = 30000
/** rename 最多尝试次数（含第一次）。 */
export const DEFAULT_GATE_RENAME_ATTEMPTS = 6
/** rename 退避基数（线性：base × 第几次）。 */
export const DEFAULT_GATE_RENAME_BACKOFF_MS = 20

/** 只有这两个码值得重试：Windows 上目标文件被别的进程打开时的典型表现。 */
const RETRYABLE_RENAME_CODES = new Set(['EPERM', 'EBUSY'])

/**
 * 创建锁文件时代表「锁在别人手里」的错误码。
 *
 * `EEXIST` 是 POSIX 的常规答案；**Windows 上两个进程同时创建同一个文件时，`open(…, 'wx')`
 * 会返回 EPERM / EBUSY（共享冲突），而不是 EEXIST**。把它当致命错误会让并发一高就整层写盘失败
 * （2026-11-07 实测：两个真实进程各写 15 次，2/15 轮直接 EPERM 失败）。
 */
const CONTENDED_CREATE_CODES = new Set(['EEXIST', 'EPERM', 'EBUSY'])

/** 某个配置路径对应的锁路径。 */
export function gateLockPath(configPath) {
  return String(configPath) + GATE_LOCK_SUFFIX
}

/** 同步睡眠：`writeGateConfig` 是同步 API，等锁不能用 setTimeout。 */
export function sleepSync(ms) {
  const wait = Number(ms)
  if (!(wait > 0)) return
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, wait)
}

/**
 * 读锁文件快照：年龄（按 mtime）+ 所有者（按内容）。
 * 内容不可解析（比如刚好在 open 与 write 之间）时 owner 为 null，交给年龄判定。
 */
function readLockState(lockPath) {
  let stat
  try {
    stat = statSync(lockPath)
  } catch {
    return null
  }
  let owner = null
  try {
    const parsed = JSON.parse(readFileSync(lockPath, 'utf8'))
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) owner = parsed
  } catch {
    // 空 / 坏内容：所有者未知
  }
  // 年龄按 mtime 算；mtime 带亚毫秒精度，刚创建的锁可能出现 -0.x，钳到 0 避免「负年龄」。
  return { path: lockPath, mtimeMs: stat.mtimeMs, ageMs: Math.max(0, Date.now() - stat.mtimeMs), owner }
}

/** 进程是否还活着：ESRCH = 死了；EPERM 等「无权判断」按活着处理（宁可不抢锁）。 */
function isPidAlive(pid) {
  const value = Number(pid)
  if (!Number.isInteger(value) || value <= 0) return null
  try {
    process.kill(value, 0)
    return true
  } catch (error) {
    return error && error.code === 'ESRCH' ? false : true
  }
}

function describeOwner(owner) {
  if (!owner) return '未知（锁文件内容不可解析）'
  return 'pid=' + (owner.pid === undefined ? '?' : String(owner.pid))
    + ' host=' + String(owner.hostname || '?')
    + ' startedAt=' + String(owner.startedAt || '?')
    + (owner.token ? ' token=' + String(owner.token) : '')
}

/** 判定一把锁能不能接管：只有超龄、或同机所有者已死。活锁永远不抢。 */
function staleReason(state, staleMs, selfHost) {
  if (!state) return null
  if (state.ageMs >= staleMs) return 'age'
  const owner = state.owner
  if (!owner || typeof owner.hostname !== 'string' || owner.hostname !== selfHost) return null
  return isPidAlive(owner.pid) === false ? 'owner_dead' : null
}

/**
 * 清理 stale 锁并返回证据。先 rename 到唯一名字再 unlink：
 * 两个等待者同时看到同一把死锁时只有一个能搬走它，另一个拿 ENOENT 重新竞争 ——
 * 直接 unlink 会误删别人刚建好的新锁。
 */
function breakStaleLock(state, reason) {
  const staleName = state.path + '.stale-' + Date.now() + '-' + randomUUID()
  try {
    renameSync(state.path, staleName)
  } catch {
    return null
  }
  try {
    unlinkSync(staleName)
  } catch {
    // 残留一个 .stale- 文件不影响正确性（下次清理会覆盖不到它，但也不会被当成锁）
  }
  return {
    path: state.path,
    reason,
    ageMs: state.ageMs,
    owner: state.owner,
    brokenAt: new Date().toISOString(),
  }
}

function lockCreateError(lockPath, cause) {
  const code = (cause && cause.code) || 'ELOCK'
  const error = new Error(
    '无法创建门禁配置写锁：' + lockPath + '（' + code + '：' + String((cause && cause.message) || cause)
    + '）。为避免并发覆盖，未在无锁状态下写入。',
  )
  error.code = code
  error.lockPath = lockPath
  error.cause = cause
  return error
}

function lockTimeoutError(lockPath, state, timeoutMs) {
  const owner = state ? state.owner : null
  const ageMs = state ? state.ageMs : null
  const error = new Error(
    '无法获取门禁配置写锁：' + lockPath + '（等待 ' + timeoutMs + 'ms 超时；持有者 '
    + describeOwner(owner)
    + (ageMs === null ? '' : '，锁年龄 ' + ageMs + 'ms')
    + '）。为避免并发覆盖，未在无锁状态下写入。',
  )
  error.code = 'gate_lock_timeout'
  error.lockPath = lockPath
  error.timeoutMs = timeoutMs
  error.owner = owner
  error.ageMs = ageMs
  return error
}

/**
 * 原子创建锁文件。
 * @returns {{ok: true} | {ok: false, error: Error}} `ok:false` = 锁在别人手里（`error.code` 是竞争码）
 */
function tryCreateLockFile(lockPath, text, open) {
  let fd
  try {
    fd = open(lockPath, 'wx', 0o600)
  } catch (error) {
    if (error && CONTENDED_CREATE_CODES.has(error.code)) return { ok: false, error }
    throw lockCreateError(lockPath, error)
  }
  try {
    writeSync(fd, text)
  } catch (error) {
    try {
      closeSync(fd)
    } catch {
      // 忽略：清理比关闭更重要
    }
    try {
      unlinkSync(lockPath)
    } catch {
      // 忽略：错误以原始创建失败为准
    }
    throw lockCreateError(lockPath, error)
  }
  closeSync(fd)
  return { ok: true }
}

/**
 * 释放锁：只有内容 token 还是自己的才删（stale 接管后旧持有者不能删新锁）。
 * Windows 上 unlink 偶发 EPERM / EBUSY（防病毒 / 索引器短暂持有）时做几次退避重试，
 * 免得把锁留给下一个写者白等到超时。
 * @returns {boolean} 是否真的删掉了
 */
function releaseLock(lockPath, token) {
  try {
    const owner = JSON.parse(readFileSync(lockPath, 'utf8'))
    if (!owner || owner.token !== token) return false
  } catch {
    return false
  }
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      unlinkSync(lockPath)
      return true
    } catch (error) {
      if (!RETRYABLE_RENAME_CODES.has(error && error.code) || attempt === 3) return false
      sleepSync(attempt * 5)
    }
  }
  return false
}

/**
 * 拿同一配置路径的跨进程写锁（同步、有界等待）。
 *
 * 拿不到就抛错（`code: 'gate_lock_timeout'` / 创建失败的原生码），**不会**返回一个「假锁」。
 * stale 接管不静默：每次接管都进 `report.broken`，带年龄与所有者。
 *
 * @param {string} configPath 配置文件的绝对路径（锁 = 该路径 + `.lock`）
 * @param {{timeoutMs?: number, pollMs?: number, staleMs?: number, sleep?: (ms: number) => void, open?: typeof openSync}} [options]
 * @returns {{path: string, configPath: string, token: string, waitedMs: number, broken: Array<object>, release: () => boolean}}
 */
export function acquireGateConfigLock(configPath, {
  timeoutMs = DEFAULT_GATE_LOCK_TIMEOUT_MS,
  pollMs = DEFAULT_GATE_LOCK_POLL_MS,
  staleMs = DEFAULT_GATE_LOCK_STALE_MS,
  sleep = sleepSync,
  // 测试注入点：证明「并发创建拿到 EPERM」按竞争等待，而不是直接失败。
  open = openSync,
} = {}) {
  const lockPath = gateLockPath(configPath)
  const token = randomUUID()
  const selfHost = hostname()
  const startedAtMs = Date.now()
  const timeout = Number.isFinite(Number(timeoutMs)) && Number(timeoutMs) >= 0
    ? Number(timeoutMs)
    : DEFAULT_GATE_LOCK_TIMEOUT_MS
  const poll = Number.isFinite(Number(pollMs)) && Number(pollMs) > 0 ? Number(pollMs) : DEFAULT_GATE_LOCK_POLL_MS
  // 非法 staleMs（0 / 负数 / NaN）退回默认值：否则「所有锁都算 stale」会把活锁也抢掉。
  const stale = Number.isFinite(Number(staleMs)) && Number(staleMs) > 0 ? Number(staleMs) : DEFAULT_GATE_LOCK_STALE_MS
  const deadline = startedAtMs + timeout
  const broken = []
  let state = null
  let createError = null

  while (true) {
    const payload = JSON.stringify({
      pid: process.pid,
      hostname: selfHost,
      startedAt: new Date(startedAtMs).toISOString(),
      token,
      configPath,
    }) + '\n'
    const created = tryCreateLockFile(lockPath, payload, open)
    if (created.ok) {
      return {
        path: lockPath,
        configPath,
        token,
        waitedMs: Date.now() - startedAtMs,
        broken,
        release() {
          return releaseLock(lockPath, token)
        },
      }
    }
    createError = created.error
    state = readLockState(lockPath)
    const reason = staleReason(state, stale, selfHost)
    if (reason) {
      const evidence = breakStaleLock(state, reason)
      if (evidence) {
        broken.push(evidence)
        continue
      }
    }
    if (Date.now() >= deadline) {
      // 锁文件从头到尾没出现过：不是「有人持有」，而是创建本身失败（只读目录 / 权限），
      // 报原始错误码；只有真看到锁时才报超时 + 持有者证据。
      if (!state) throw lockCreateError(lockPath, createError)
      throw lockTimeoutError(lockPath, state, timeout)
    }
    sleep(poll)
  }
}

/**
 * 原子替换 + Windows EPERM / EBUSY 有界退避重试。
 *
 * 只对 EPERM / EBUSY 重试（目标文件被占用）；其余错误立即失败。
 * 最终失败抛出的错误带 `code`（原始错误码）、`path`、`tmpPath`、`attempts`，原文件不动。
 *
 * @param {string} from 临时文件
 * @param {string} to 目标文件
 * @param {{attempts?: number, backoffMs?: number, rename?: (from: string, to: string) => void, sleep?: (ms: number) => void}} [options]
 * @returns {{attempts: number, from: string, to: string}}
 */
export function renameWithRetry(from, to, {
  attempts = DEFAULT_GATE_RENAME_ATTEMPTS,
  backoffMs = DEFAULT_GATE_RENAME_BACKOFF_MS,
  rename = renameSync,
  sleep = sleepSync,
} = {}) {
  const total = Math.max(1, Math.trunc(Number(attempts)) || 1)
  const backoff = Number.isFinite(Number(backoffMs)) && Number(backoffMs) > 0 ? Number(backoffMs) : 0
  let lastError = null
  let tried = 0
  for (let attempt = 1; attempt <= total; attempt += 1) {
    tried = attempt
    try {
      rename(from, to)
      return { attempts: attempt, from, to }
    } catch (error) {
      lastError = error
      const code = error && error.code
      if (!RETRYABLE_RENAME_CODES.has(code) || attempt === total) break
      // 线性有界退避（20ms / 40ms / …）：总等待远小于一次用户可感知的保存。
      sleep(backoff * attempt)
    }
  }
  const code = (lastError && lastError.code) || 'ERENAME'
  const error = new Error(
    '无法原子替换门禁配置：' + to + '（' + code + '：' + String((lastError && lastError.message) || lastError)
    + '；已尝试 ' + tried + ' 次）。原文件保持不变。',
  )
  error.code = code
  error.path = to
  error.tmpPath = from
  error.attempts = tried
  error.cause = lastError
  throw error
}
