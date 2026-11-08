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
 * 并发安全（C2/C3）：`rename` / `unlink` 都是**无条件**操作 —— 只看一眼旧快照就动 `lockPath`，
 * 可能搬走别的写者刚创建的新锁，于是两个写者同时进临界区（Q1 实测 12 写者 2/44 轮）。
 * 所以「创建 / 接管 / 释放」这三个会动 `lockPath` 的动作全部走：
 *   1. **守护锁**（`<lock>.guard`，微秒级、同样 O_EXCL）：把「读快照 → 判定 stale → 搬走 → 新建」
 *      以及「核对 token → 删除」串起来，活着的写者不会互相打断；
 *   2. **搬走后再核对**：rename 到唯一名字后比对 token（内容不可解析时比对原文），
 *      不是快照里那把（搬错了别人刚建的新锁）就用 `link` / `COPYFILE_EXCL` **原子放回去**，绝不误删；
 *   3. **释放先核对、不匹配不碰**（C3/Q1R）：释放**不能**先 rename —— 旧持有者被挂起、锁被接管、
 *      恢复后 release 时，先 rename 会把当前持有者的新锁搬走，`lockPath` 空窗，第三写者趁机进临界区。
 *      现在的顺序是「进守护区 → 核对 token → 仍是自己的才从原位删」，不匹配原样返回 false；
 *      拿不到守护锁也不碰 `lockPath`（宁可留着自己的锁，也不误删别人的新锁）。
 * 再加一道**写盘前归属校验**（`assertOwner()`）：锁一旦不在自己手里，宁可失败也不覆盖别人的写盘。
 *
 * 锁是**跨进程互斥**，不是分布式锁：判据是同一台机器、同一路径；跨主机共享盘不保证。
 * 超龄接管的含义：单次写盘耗时超过 `staleMs` 时理论上可能被并发接管 —— 所以默认 30s，
 * 远大于一次「读 → 校验 → 写 → rename」的毫秒级窗口；崩在中间的锁会留下文件，由下一次写入接管。
 */
import {
  closeSync,
  constants as fsConstants,
  copyFileSync,
  linkSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from 'node:fs'
import { randomUUID } from 'node:crypto'
import { hostname } from 'node:os'

/** 锁文件后缀：`<gates.json>.lock`，和配置同目录（目录不存在时调用方先建）。 */
export const GATE_LOCK_SUFFIX = '.lock'
/** 守护锁后缀：`<gates.json>.lock.guard`，只护住「创建 / 接管 / 释放」那几微秒。 */
export const GATE_GUARD_SUFFIX = '.guard'
/** 等锁上限：超过就显式失败（写盘是毫秒级操作，5s 已经足够宽）。 */
export const DEFAULT_GATE_LOCK_TIMEOUT_MS = 5000
/** 等锁轮询间隔。 */
export const DEFAULT_GATE_LOCK_POLL_MS = 15
/** 超过这个年龄的锁视为 stale（持有者极可能已经崩在中间）。 */
export const DEFAULT_GATE_LOCK_STALE_MS = 30000
/** 守护锁只在崩溃时才会滞留；它本身只该活几微秒，所以 stale 阈值比锁小。 */
export const DEFAULT_GATE_GUARD_STALE_MS = 10000
/** rename 最多尝试次数（含第一次）。 */
export const DEFAULT_GATE_RENAME_ATTEMPTS = 6
/** rename 退避基数（线性：base × 第几次）。 */
export const DEFAULT_GATE_RENAME_BACKOFF_MS = 20

/** 只有这两个码值得重试：Windows 上目标文件被别的进程打开时的典型表现。 */
const RETRYABLE_RENAME_CODES = new Set(['EPERM', 'EBUSY'])

/**
 * 释放写锁时等守护锁的上限。守护锁只活微秒级，正常立刻拿到；给上限是为了**永不无限等**。
 * 拿不到就不碰 lockPath（失败返回 false），宁可留着自己的锁，也不误删别人的新锁。
 */
const RELEASE_GUARD_TIMEOUT_MS = 2000

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

/** 某个配置路径对应的守护锁路径。 */
export function gateGuardPath(configPath) {
  return gateLockPath(configPath) + GATE_GUARD_SUFFIX
}

/** 同步睡眠：`writeGateConfig` 是同步 API，等锁不能用 setTimeout。 */
export function sleepSync(ms) {
  const wait = Number(ms)
  if (!(wait > 0)) return
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, wait)
}

/**
 * 读锁文件快照：年龄（按 mtime）+ 所有者（按内容）+ 原文。
 * 原文用于「内容不可解析」时的身份比对（比如刚好崩在 open 与 write 之间）。
 */
function readLockState(lockPath) {
  let stat
  try {
    stat = statSync(lockPath)
  } catch {
    return null
  }
  let owner = null
  let raw = ''
  try {
    raw = readFileSync(lockPath, 'utf8')
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) owner = parsed
  } catch {
    // 空 / 坏内容：所有者未知
  }
  // 年龄按 mtime 算；mtime 带亚毫秒精度，刚创建的锁可能出现 -0.x，钳到 0 避免「负年龄」。
  return { path: lockPath, mtimeMs: stat.mtimeMs, ageMs: Math.max(0, Date.now() - stat.mtimeMs), owner, raw }
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
 * 把一个被搬错的文件原子放回原位：`link` 不覆盖已有文件，文件系统不支持时退回
 * `copyFileSync(…, COPYFILE_EXCL)`（同样不覆盖）。返回是否还原成功。
 */
function restoreFile(from, to) {
  try {
    linkSync(from, to)
    try {
      unlinkSync(from)
    } catch {
      // 还原成功、残留清理失败：不影响锁语义
    }
    return true
  } catch (error) {
    if (error && error.code === 'EEXIST') {
      // 原位已经被新的锁占用：不覆盖它，放弃还原
      try {
        unlinkSync(from)
      } catch {
        // 忽略
      }
      return false
    }
  }
  try {
    copyFileSync(from, to, fsConstants.COPYFILE_EXCL)
    try {
      unlinkSync(from)
    } catch {
      // 忽略
    }
    return true
  } catch {
    try {
      unlinkSync(from)
    } catch {
      // 忽略
    }
    return false
  }
}

/**
 * 接管 stale 锁并返回证据（年龄 + 所有者）。
 *
 * 先 rename 到唯一名字，**再核对搬走的是不是快照里那把**：
 * - 是 → 删掉，接管成功；
 * - 不是（别的写者刚创建了新锁）→ 原子放回去，返回 null 重新竞争。
 * rename / unlink 本身没有「条件执行」，这一步核对 + 还原就是「不误删新锁」的兜底。
 */
function takeOverStale(targetPath, snapshot, reason) {
  if (!snapshot) return null
  const moved = targetPath + '.stale-' + Date.now() + '-' + randomUUID()
  try {
    renameSync(targetPath, moved)
  } catch {
    return null
  }
  let movedOwner = null
  let movedRaw = ''
  try {
    movedRaw = readFileSync(moved, 'utf8')
    const parsed = JSON.parse(movedRaw)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) movedOwner = parsed
  } catch {
    // 内容不可解析：退化为原文比对
  }
  const expected = snapshot.owner ? String(snapshot.owner.token) : String(snapshot.raw || '')
  const actual = movedOwner ? String(movedOwner.token) : movedRaw
  if (expected !== actual) {
    restoreFile(moved, targetPath)
    return null
  }
  try {
    unlinkSync(moved)
  } catch {
    // 残留一个 .stale- 文件不影响正确性（它不会被当成锁）
  }
  return {
    path: targetPath,
    reason,
    ageMs: snapshot.ageMs,
    owner: snapshot.owner,
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

function lockTimeoutError(lockPath, state, timeoutMs, label = '门禁配置写锁') {
  const owner = state ? state.owner : null
  const ageMs = state ? state.ageMs : null
  const error = new Error(
    '无法获取' + label + '：' + lockPath + '（等待 ' + timeoutMs + 'ms 超时；持有者 '
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

/** 锁已经不在自己手里（被判定 stale 接管过）：宁可失败，也不覆盖别人的写盘。 */
function lockLostError(lockPath) {
  const error = new Error(
    '写锁已不在自己手里：' + lockPath
    + '（可能已被判定 stale 接管）。为避免覆盖别人的写盘，本次写入已放弃。',
  )
  error.code = 'gate_lock_lost'
  error.lockPath = lockPath
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

/** 磁盘上的锁还是不是自己的（token 比对）。 */
function lockOwnedBy(lockPath, token) {
  try {
    const owner = JSON.parse(readFileSync(lockPath, 'utf8'))
    return Boolean(owner && owner.token === token)
  } catch {
    return false
  }
}

/**
 * 只有 token 仍是自己的才删；不是自己的**一个字节都不动**。
 * 调用者必须保证此刻没有别人在改同一个路径：写锁的释放包在守护区里，守护锁自己不需要再套一层。
 */
function unlinkIfOwned(path, token) {
  if (!lockOwnedBy(path, token)) return false
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      unlinkSync(path)
      return true
    } catch (error) {
      if (!RETRYABLE_RENAME_CODES.has(error && error.code) || attempt === 3) return false
      sleepSync(attempt * 5)
    }
  }
  return false
}

/**
 * 释放写锁：在守护区里「先核对 token，再从原位删除」。
 *
 * 关键（C3 / Q1R）：**不能**先 rename 再核对。rename 是无条件操作 —— 旧持有者被挂起、
 * 锁被判定 stale 接管、恢复后调 release 时，这么做会把**当前持有者的新锁**搬走，
 * `lockPath` 出现空窗，第三写者能趁虚而入，两个写者同时进临界区。
 * 现在 token 不匹配就原样返回 false，绝不碰 `lockPath`。
 *
 * 拿不到守护锁时同样选择「不碰 `lockPath`」：宁可留着自己的锁等它超龄，
 * 也不冒误删别人新锁的风险（守护锁只活微秒级，正常不会拿不到）。
 */
function releaseLock(lockPath, token, { guardPath, guardStaleMs, timeoutMs, pollMs, sleep, open, selfHost }) {
  let guard = null
  try {
    guard = acquireGuard(guardPath, {
      timeoutMs: Math.min(timeoutMs, RELEASE_GUARD_TIMEOUT_MS),
      pollMs,
      staleMs: guardStaleMs,
      sleep,
      open,
      selfHost,
    })
  } catch {
    return false
  }
  try {
    return unlinkIfOwned(lockPath, token)
  } finally {
    guard.release()
  }
}

/**
 * 拿守护锁：只护住「创建 / 接管 / 释放」这几微秒，所以 stale 阈值单独给（默认 10s）。
 * 活着的持有者永远不会被接管；崩在中间的守护锁按「所有者已死」立即接管。
 */
function acquireGuard(guardPath, { timeoutMs, pollMs, staleMs, sleep, open, selfHost }) {
  const token = randomUUID()
  const startedAtMs = Date.now()
  const deadline = startedAtMs + Math.max(0, Number(timeoutMs) || 0)
  const payload = JSON.stringify({
    pid: process.pid,
    hostname: selfHost,
    startedAt: new Date(startedAtMs).toISOString(),
    token,
    kind: 'guard',
  }) + '\n'
  let state = null
  let createError = null
  while (true) {
    const created = tryCreateLockFile(guardPath, payload, open)
    if (created.ok) {
      return {
        path: guardPath,
        token,
        // 守护锁自己不再套一层守护锁：直接核对 token 再删（它只活微秒级，没人会在这一刻接管它）。
        release() {
          return unlinkIfOwned(guardPath, token)
        },
      }
    }
    createError = created.error
    state = readLockState(guardPath)
    if (staleReason(state, staleMs, selfHost)) {
      if (takeOverStale(guardPath, state, 'guard')) continue
    }
    if (Date.now() >= deadline) {
      if (!state) throw lockCreateError(guardPath, createError)
      throw lockTimeoutError(guardPath, state, timeoutMs, '门禁配置写锁守护锁')
    }
    sleep(pollMs)
  }
}

/**
 * 拿同一配置路径的跨进程写锁（同步、有界等待）。
 *
 * 拿不到就抛错（`code: 'gate_lock_timeout'` / 创建失败的原生码），**不会**返回一个「假锁」。
 * stale 接管不静默：每次接管都进 `report.broken`，带年龄与所有者。
 *
 * 创建与接管都在 `<lock>.guard` 守护锁内完成：两个写者不会同时「看到同一把 stale 锁 → 各自搬走」，
 * 也就不会把彼此刚建好的新锁搬走（C2/Q1 medium）。
 *
 * @param {string} configPath 配置文件的绝对路径（锁 = 该路径 + `.lock`，守护锁再加 `.guard`）
 * @param {{timeoutMs?: number, pollMs?: number, staleMs?: number, guardStaleMs?: number, sleep?: (ms: number) => void, open?: typeof openSync}} [options]
 * @returns {{path: string, configPath: string, token: string, waitedMs: number, broken: Array<object>, release: () => boolean, isOwner: () => boolean, assertOwner: () => true}}
 */
export function acquireGateConfigLock(configPath, {
  timeoutMs = DEFAULT_GATE_LOCK_TIMEOUT_MS,
  pollMs = DEFAULT_GATE_LOCK_POLL_MS,
  staleMs = DEFAULT_GATE_LOCK_STALE_MS,
  guardStaleMs = DEFAULT_GATE_GUARD_STALE_MS,
  sleep = sleepSync,
  // 测试注入点：证明「并发创建拿到 EPERM」按竞争等待，而不是直接失败。
  open = openSync,
} = {}) {
  const lockPath = gateLockPath(configPath)
  const guardPath = gateGuardPath(configPath)
  const token = randomUUID()
  const selfHost = hostname()
  const startedAtMs = Date.now()
  const timeout = Number.isFinite(Number(timeoutMs)) && Number(timeoutMs) >= 0
    ? Number(timeoutMs)
    : DEFAULT_GATE_LOCK_TIMEOUT_MS
  const poll = Number.isFinite(Number(pollMs)) && Number(pollMs) > 0 ? Number(pollMs) : DEFAULT_GATE_LOCK_POLL_MS
  // 非法 staleMs（0 / 负数 / NaN）退回默认值：否则「所有锁都算 stale」会把活锁也抢掉。
  const stale = Number.isFinite(Number(staleMs)) && Number(staleMs) > 0 ? Number(staleMs) : DEFAULT_GATE_LOCK_STALE_MS
  const guardStale = Number.isFinite(Number(guardStaleMs)) && Number(guardStaleMs) > 0
    ? Number(guardStaleMs)
    : DEFAULT_GATE_GUARD_STALE_MS
  const deadline = startedAtMs + timeout
  const broken = []
  let state = null
  let createError = null
  const payload = JSON.stringify({
    pid: process.pid,
    hostname: selfHost,
    startedAt: new Date(startedAtMs).toISOString(),
    token,
    configPath,
  }) + '\n'

  const handle = () => ({
    path: lockPath,
    configPath,
    token,
    waitedMs: Date.now() - startedAtMs,
    broken,
    release() {
      // 释放同样走守护区：先核对 token 再删，token 不匹配就一个字节都不碰（C3）。
      return releaseLock(lockPath, token, {
        guardPath,
        guardStaleMs: guardStale,
        timeoutMs: timeout,
        pollMs: poll,
        sleep,
        open,
        selfHost,
      })
    },
    isOwner() {
      return lockOwnedBy(lockPath, token)
    },
    assertOwner() {
      if (lockOwnedBy(lockPath, token)) return true
      throw lockLostError(lockPath)
    },
  })

  while (true) {
    // 快路径：锁在、且没超龄 / 所有者没死 —— 只等，不碰守护锁。
    // 这一步不做任何 create / rename / unlink，所以跳过互斥是安全的；真正会动 lockPath 的
    // 动作（创建 / 接管 / 释放）一律走下面的守护区。
    const snapshot = readLockState(lockPath)
    if (snapshot && !staleReason(snapshot, stale, selfHost)) {
      state = snapshot
      if (Date.now() >= deadline) throw lockTimeoutError(lockPath, state, timeout)
      sleep(poll)
      continue
    }
    // 守护区：创建 / 接管是**互斥**的，不会有两个写者同时搬同一把 stale 锁。
    let guard = null
    try {
      guard = acquireGuard(guardPath, {
        timeoutMs: Math.max(0, deadline - Date.now()),
        pollMs: poll,
        staleMs: guardStale,
        sleep,
        open,
        selfHost,
      })
    } catch (error) {
      // 守护锁都拿不到：如果已经见过真锁，按「等锁超时」报（带持有者证据）；否则原样报创建错误。
      if (state) throw lockTimeoutError(lockPath, state, timeout)
      throw error
    }
    try {
      const created = tryCreateLockFile(lockPath, payload, open)
      if (created.ok) return handle()
      createError = created.error
      state = readLockState(lockPath)
      const reason = staleReason(state, stale, selfHost)
      if (reason) {
        const evidence = takeOverStale(lockPath, state, reason)
        if (evidence) {
          broken.push(evidence)
          // 接管成功后立刻（仍在守护区里）创建自己的锁，不给别人插队的窗口。
          const again = tryCreateLockFile(lockPath, payload, open)
          if (again.ok) return handle()
          createError = again.error
          state = readLockState(lockPath)
        }
      }
    } finally {
      if (guard) guard.release()
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
