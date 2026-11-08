/**
 * dsh-session-superagent — session-level superagent for DeepSeek Harness.
 *
 * Two capabilities, one package:
 *   1. `github` / `repo_here` — call the GitHub API; the credential stays inside
 *      the plugin and every result is redacted before the model sees it.
 *   2. `watch_start` / `watch_status` / `watch_stop` — watch one repository and
 *      wake THIS session when something changes, by queueing a follow-up turn.
 *
 * Design constraints (see MAINTENANCE.md):
 *   - never inject while the agent is running (draft-replay hazard);
 *   - per-item watermarks, so our own writes never wake us (no self-echo);
 *   - advance the watermark only after a wake actually landed.
 */
import { execFileSync, spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import os, { homedir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { zstdDecompressSync } from 'node:zlib'

import Schema from '@deepseek-ai/schemastery'

import { redact } from './redact.js'
import { decodeBody, truncateUtf8 } from './body.js'
import { quotaDeferText, isOfflineMode } from './gh-format.js'
import { listGiteeItems, fetchGiteeLastComment, addGiteeLabel, addGiteeComment, ensureGiteeLabel, giteeWhoami, giteeRepo, mapGiteeRepoAccess, DEFAULT_ACK_LABEL_GITEE, giteeLabels, giteeHasLabel, isValidGiteeLabel, suggestGiteeLabel } from './gitee.js'
// 门禁实现已经抽到独立包（G2）：主插件只消费包的稳定接口，不再内嵌规则。
// `lib/gates.js` 保留成兼容 re-export，旧调用点（历史测试 / 外部脚本）不用改。
import { createGate, loadGateConfig, lintText, optimizePrompt, listModels, readGateScope, writeGateConfig, validateConfig } from '@mycf711/dsh-gate'
import { migrateState, CURRENT_STATE_SCHEMA } from './state-migration.js'
import { runExclusiveUpdate, spawnPluginUpdate, validateUpdateBody } from './update.js'
import { compareSemver, isStrictSemver } from './semver.js'
import {
  effectiveIntervalMs, planWakeSettlement, advanceSeen, applyWatcherAction, batchFresh, decideWake, DEFAULT_ACK_LABEL, DEFAULT_BRAND_NAME, DEFAULT_PRIORITY, formatWatchText,
  defaultAckLabelFor, normalizeBrandName,
  recordPendingWake, clearPending, pendingRetry,
  wakeQuality,
  parseRepoSpec, markGiteeReopened,
  TRIAGE_SIGNALS, accessNote, wakeCriteria, sessionMissingVerdict, buildCommentBatchQuery, classifyGhError, commentSummaryLine, parseCommentBatch, pickSuggestion, repoStructureNote, countReasons, filterReason, formatGhCall, diagnoseEmptyBody, diagnoseBadBody, isAuthBroken, hasAckLabel, jitterMs, parseGhInclude, retryAfterMs, throttleDelayMs, inActiveHours, newestUpdatedAt, nextDelayMs, enterActiveHoursDefer, recordOtherError, permanentBackoffMs, RETRY_BUDGET_ATTEMPTS, RETRY_SLOW_CAP_MINUTES, pushAbsorbed, pushFiltered, normalizeFilters, partitionItems, passesFilters,
  shouldRunCleanup,
  bumpDailyWakes,
  busierThanUsual,
  countCapped,
  statusView,
  dailySummary,
  suggestSessionCap,
  itemTrace,
  splitBatch,
  mergeFilters, mergePollResult, mergeWakeTexts, pushEvent, silentStreak, msUntilActiveWindow, nextWaketimeAt, pruneSeen, sessionWakesLastHour, pruneWakeTimes, pushHistory, recordReported, staleWorktrees, worktreePlan,
  validateActiveHours,
} from './watch.js'

export const name = 'dsh-session-superagent'
/** 服务端版本：随 package.json 同步（meta 测试守着）。客户端据此挑「最新的那个实例」。 */
export const SERVER_VERSION = '0.10.7'
export const inject = ['tools', 'agents', 'webServer']
/** 一条会话每小时最多被唤醒几次（跨所有守累计）。单守上限挡不住多守叠加。 */
// 本进程启动时刻：用来区分「刚重启还没轮到」与「定时器真的丢了」
const PROCESS_STARTED_AT = Date.now()
// 「未变化」那句两处要一模一样：单点改文案不会漏另一处
// 记错误时同时记时间：面板要能说「这是 12 分钟前的」而不是默认它刚刚发生
function setEntryError(entry, text) {
  entry.lastError = text
  entry.lastErrorAt = new Date().toISOString()
}
const UNCHANGED_TEXT = '未变化（304，不计入速率限制）'
// GitHub 的 issues 列表 ETag 偶尔不会因为「新增评论」而变化（真机 #11：
// 18:21 的评论已经改了 updated_at，18:31 带旧 ETag 仍回 304）。
// 304 不能无限信任：超过这个时长强制一次全量，宁可多花一次请求。
const ETAG_MAX_AGE_MS = 10 * 60 * 1000

/**
 * 304 的统一结算：gh 把 304 当 exit 1，所以必须同时服务
 * 「res.code !== 0 + stderr 是 304」和「parsed.status === 304」两条入口。
 * 返回稳定原因，方便测试直接断言行为（而不是源码里有没有那行）。
 */
export function settleNotModified(entry, now = Date.now()) {
  const freshAt = Date.parse(entry.lastFreshAt || '')
  const stale = !Number.isFinite(freshAt) || now - freshAt > ETAG_MAX_AGE_MS
  entry.lastError = null
  entry.needsReauth = false
  entry.consecutiveFailures = 0
  entry.nextAt = null
  if (stale) {
    delete entry.etag
    entry.lastDeferred = 'ETag 可能过期（超过 10 分钟没全量刷新）：下一轮强制全量'
    entry.deferReason = 'etag-stale'
    noteEvent(entry, 'unchanged', entry.lastDeferred)
    return 'etag-stale'
  }
  entry.lastDeferred = UNCHANGED_TEXT
  entry.deferReason = 'unchanged'
  noteEvent(entry, 'unchanged', entry.lastDeferred)
  return 'unchanged'
}
// Gitee 没有 ETag/304：说「304」会让客户以为在省额度，其实每轮都真读
const UNCHANGED_TEXT_GITEE = '未变化（Gitee 无 ETag：这一轮是真空读的）'
// 追溯找不到任何痕迹时的那句话：两个入口（工具 / HTTP）必须一模一样
const noTraceText = (number, scope) => '#' + number + ' 在' + (scope || '所有守') + ' 里都没有痕迹 —— 可能还没被轮询到，或者编号写错了。'

/** 工具与面板共用同一份追溯文本，别再各写一套缩进、标点和省略规则。 */
const formatTraceText = (traces) => {
  const lines = []
  for (const trace of traces || []) {
    lines.push('#' + trace.number + ' @ ' + (trace.repo || '?') + '：' + trace.verdict)
    // 例外优先：一切正常时一行说完，只有「被过滤/被吸收/唤醒失败」才展开细节。
    const quiet = trace.filtered.length === 0 && (trace.absorbed || []).length === 0
      && trace.wakes.length > 0 && trace.wakes.every((item) => item.ok)
    if (!quiet) {
      if (trace.seen) lines.push('  水位 seen：' + trace.seen)
      if (trace.reported) lines.push('  上次上报：' + trace.reported)
      for (const item of trace.filtered) lines.push('  被过滤（' + (item.reason || '未知') + '）：' + item.at)
      for (const item of trace.absorbed || []) lines.push('  被冷却期吸收：' + item.at)
      for (const item of trace.wakes) lines.push('  唤醒尝试：' + item.at + '　' + (item.ok ? '成功' : '失败（' + (item.reason || '未知') + '）'))
    } else if (trace.wakes.length > 0) {
      lines.push('  最近一次唤醒：' + trace.wakes[trace.wakes.length - 1].at + '（成功）')
    }
  }
  return lines.join(String.fromCharCode(10))
}

const DEFAULT_SESSION_WAKES = 12
/** 单次唤醒最多铺开几条（面板的占位符要显示这个真值，不能写死）。 */
const DEFAULT_BATCH_LIMIT = 5
// 面板里的「默认值提示」也要从这里来：JSON Schema 的 default 就是给表单做提示用的
// 出处：https://json-schema.org/understanding-json-schema/reference/annotations
const DEFAULT_WAKES_PER_HOUR = 6
const DEFAULT_ISOLATE_KEEP_DAYS = 3
// watch.js 的 DEFAULT_PRIORITY 是排序规则的事实源；stale 是后加的扩展键，默认同样关闭。
const DEFAULT_TOOL_PRIORITY = Object.freeze({ ...DEFAULT_PRIORITY, stale: false })
// 一条会话最多挂多少守：再多轮询压力与上下文都会失控（20 条 × 每 60 秒已很密）
const MAX_WATCHERS_PER_SESSION = 20

/**
 * 工具的错误返回（审核 T32 M2）：`format: 'json'` 时必须是**结构化**的。
 * 以前这些分支一律返回纯文本 `[error: …]`，而文档承诺「成功/失败都靠 ok 判断」——
 * 模型拿到纯文本再 JSON.parse 就直接抛错。
 */
function toolError(args, message) {
  if (args && args.format === 'json') return JSON.stringify({ schemaVersion: 1, ok: false, error: message })
  return '[error: ' + message + ']'
}
/** 全局上限：每条守一个定时器，无限建等于自造 DoS（审核 T19）。 */
const MAX_WATCHERS_TOTAL = 200

/**
 * 插件配置（issue #11）：品牌名 + 两家默认 ack 标签。
 *
 * 为什么用官方 schemastery：DSH 的 loader 会在 `apply()` 之前按这份 schema 校验并补默认值，
 * 设置页也直接吃它的 `default` / `description`。手写一遍校验等于把同一套规则维护两次。
 *
 * 三个字段各自独立：`brandName` 只影响抬头与面板标题；两个 ack 标签按 provider 分开，
 * 因为 Gitee 的标签名不允许半角冒号（真机 2026-11-05 实测），默认值本来就不一样。
 */
export const Config = Schema.object({
  brandName: Schema.string().default(DEFAULT_BRAND_NAME)
    .description('唤醒抬头与面板标题里的品牌名（默认「' + DEFAULT_BRAND_NAME + '」）'),
  defaultAckLabel: Schema.string().default(DEFAULT_ACK_LABEL)
    .description('新建 GitHub 守的默认已处理标签（默认「' + DEFAULT_ACK_LABEL + '」）'),
  defaultAckLabelGitee: Schema.string().default(DEFAULT_ACK_LABEL_GITEE)
    .description('新建 Gitee 守的默认已处理标签；只能用 Gitee 允许的字符，不能带半角冒号（默认「' + DEFAULT_ACK_LABEL_GITEE + '」）'),
})

/**
 * ack 标签归一化：trim、空值回落、Gitee 校验非法字符。
 *
 * Gitee 的规则比 GitHub 严（见 lib/gitee.js 的 `isValidGiteeLabel`）——
 * 配一个带半角冒号的值如果不校验，每次 `watch_ack` 都会 404，而错误信息还指向仓库。
 * 宁可回落默认，也不要让整条守废掉。
 */
export function normalizeDefaultAckLabel(value, provider, fallback) {
  const text = String(value ?? '').trim()
  if (provider === 'gitee') {
    if (!text || !isValidGiteeLabel(text)) return fallback || DEFAULT_ACK_LABEL_GITEE
    return text
  }
  if (!text) return fallback || DEFAULT_ACK_LABEL
  // 与手工填写的上限一致（watch_start / 面板保存都截 60）
  return text.slice(0, 60)
}

/**
 * 把 `apply()` 的 options 归一成运行时品牌配置。
 *
 * 正常情况下 options 是 cordis 用 `Config` 校验后的对象（默认值已补齐）；
 * 单测/直接调用会传 `{}` 或只传更新 runner —— 这里必须自己兜住默认值。
 */
export function resolveBrandConfig(options = {}) {
  const source = options && typeof options === 'object' ? options : {}
  return Object.freeze({
    brandName: normalizeBrandName(source.brandName),
    defaultAckLabels: Object.freeze({
      github: normalizeDefaultAckLabel(source.defaultAckLabel, 'github', DEFAULT_ACK_LABEL),
      gitee: normalizeDefaultAckLabel(source.defaultAckLabelGitee, 'gitee', DEFAULT_ACK_LABEL_GITEE),
    }),
  })
}
/** 隔离区回收的最小间隔：没有超额时不必每次唤醒都跑 git。 */
const CLEANUP_INTERVAL_MS = 10 * 60 * 1000

/** 仅供测试：读写状态文件（生产代码不要用）。 */
export const __test = { readState, writeState, hardenSecretsFile, wakeMerged, flushWakeQueue, wakeQueueCount, clearWakeQueues, pollWithItems, settleNotModified, setAuthStatusCache: (text) => { authStatusCache = { at: text ? Date.now() : 0, text } } }

// 审核 T30：这四个路径以前在**模块加载那一刻**定死 ——
// 测试里改 `process.env.DSH_SUPERAGENT_STATE` 之后，已经加载的实例仍然指着老目录，
// 于是「写进真实状态目录」这种事就会发生（`o/parity` 那条假守就是这么进去的）。
// 改成惰性求值：每次用到时现读 env。
const stateDir = () => (process.env.DSH_SUPERAGENT_STATE
  ? String(process.env.DSH_SUPERAGENT_STATE)
  : join(homedir(), '.dsh', 'state', 'session-superagent'))
const secretsFile = () => join(stateDir(), 'secrets.json')
const stateFile = () => join(stateDir(), 'watchers.json')
const triggerFile = () => join(stateDir(), 'trigger.json')
// 客户端探针只认这几个键（别的键一律丢弃，防止被任意网页写盘）
const CLIENT_NOTE_KEYS = new Set(['client-version', 'client-base', 'apply', 'desk-registered', 'desk-fail', 'orbit-registered', 'orbit-fail', 'orbit-mount', 'badge-registered', 'badge-mount', 'badge-state', 'error'])
const DEFAULT_COOLDOWN_MS = 180_000

/**
 * 当前挂在这个进程上的路由 disposer。
 *
 * 宿主重载时若没走 dispose，旧实例会继续吃 HTTP 请求，而它的 ctx 可能已经 dispose ——
 * 真机表现：面板建的 watcher 第一轮就报
 * `cannot get required service "agents" in inactive context`（2026-11-02 复验）。
 *
 * 关键：宿主重载常常是**重新 import 一份模块**（模块级变量全新），所以光用模块级数组
 * 接不过去 —— 必须挂在 `globalThis` 上（用 Symbol.for 做键，多个模块实例共享同一个）。
 */
// 这三个结构必须跨模块实例共享：宿主重载常常是重新 import 一份模块，
// 模块级变量全新，但进程只有一个。新实例要能清掉旧实例的路由与定时器，
// 也要能看见旧实例「正在跑的那轮」（否则并发闸形同虚设）。
const TIMERS_KEY = Symbol.for('dsh-session-superagent.timers')
const INFLIGHT_KEY = Symbol.for('dsh-session-superagent.inFlight')
const sharedTimers = (globalThis[TIMERS_KEY] ||= new Map())
const sharedInFlight = (globalThis[INFLIGHT_KEY] ||= new Set())

const DEFAULT_ROUTE_BASE = '/session-superagent'
const ROUTE_GEN_KEY = Symbol.for('dsh-session-superagent.routeGeneration')
/** 本实例实际使用的路由前缀（正常情况下等于默认前缀）。 */
let activeBase = DEFAULT_ROUTE_BASE
const ROUTES_KEY = Symbol.for('dsh-session-superagent.activeRoutes')
const activeRoutes = (globalThis[ROUTES_KEY] ||= [])

// 最后一次成功读取的来源：正常 / 备份恢复 / 全新。面板与 /diagnose 会带上它。
let stateSource = 'new'

/**
 * 读状态文件。主文件坏了就退回上一次的备份（`.bak`），而不是直接当空状态 ——
 * 当空的后果是「客户所有守一夜消失」，这比多留一个备份文件糟糕得多。
 * 思路同 SQLite 的 WAL：**先保证有一份已提交的好副本**，再覆盖。
 */
/** 最近一次写盘失败（null = 没失败过）。给 /state 与 doctor 用。 */
let lastWriteError = null

function readState() {
  let raw
  try {
    raw = readFileSync(stateFile(), 'utf8')
  } catch {
    stateSource = 'new'
    return { watchers: {} }
  }
  try {
    // 先显式迁移，再做兼容归一；未来版本会抛错并落到 .bak，不盲目按旧代码读取。
    const parsed = migrateState(JSON.parse(raw)).state
    for (const entry of Object.values(parsed.watchers || {})) { normalizePaused(entry); normalizeAckLabel(entry) }
    stateSource = 'ok'
    return parsed
  } catch {
    // 主文件坏了：试试备份
    try {
      const backup = migrateState(JSON.parse(readFileSync(stateFile() + '.bak', 'utf8'))).state
      for (const entry of Object.values(backup.watchers || {})) { normalizePaused(entry); normalizeAckLabel(entry) }
      stateSource = 'backup'
      // 把备份写回主文件，避免下次还走恢复路径
      try { writeFileSync(stateFile(), JSON.stringify(backup, null, 2)) } catch {}
      return backup
    } catch {
      // 备份也没了/也坏了：把坏文件留个证据，再从空状态开始
      stateSource = 'corrupt'
      try { renameSync(stateFile(), stateFile() + '.corrupt-' + Date.now()) } catch {}
      // 审核 T36 W5：`.corrupt-*` 以前没有数量上限 —— 每次损坏留一份，反复损坏会把目录撑大。
      // 只留最近 3 份（够人排查），更早的删掉。
      try {
        const dir = stateDir()
        const olds = readdirSync(dir)
          .filter((name) => name.startsWith('watchers.json.corrupt-'))
          .sort()
        for (const name of olds.slice(0, Math.max(0, olds.length - 3))) {
          try { unlinkSync(join(dir, name)) } catch { /* 删不掉就留着 */ }
        }
      } catch { /* 目录读不了就算了，不影响主流程 */ }
      return { watchers: {} }
    }
  }
}

// 暂停的守不再轮询，它的 lastError 就不是「现在」的事实了。
// 真机现场：一条停在旧版本暂停的守，重启后仍显示「异常」，红点一直在。
// 依据同 KB paused-means-no-new-facts.md。读取时顺手归一，写盘时自然带走。
// Gitee 的标签名不允许半角冒号（真机 2026-11-05 实测）。0.9.184 之前建的守存的是「主理鱼:已处理」，
// 而 watch_ack 里 `entry.ackLabel ||` 会短路掉新默认值 —— 那些守永远建不出标签，每次都 404。
// 读取时归一，写盘时自然带走（同 normalizePaused 的思路）。
function normalizeAckLabel(entry) {
  if (!entry || entry.provider !== 'gitee') return entry
  // issue #11：**没有** ackLabel 的历史守不能在这里补默认值 —— 补了就会把插件配置的
  // `defaultAckLabelGitee` 短路掉（`entry.ackLabel ||` 永远先命中旧默认）。
  // 这里只修「存了一个 Gitee 建不出来的旧标签」，空值留给调用方按配置派生。
  if (typeof entry.ackLabel !== 'string' || !entry.ackLabel.trim()) return entry
  if (!isValidGiteeLabel(entry.ackLabel)) entry.ackLabel = suggestGiteeLabel(entry.ackLabel)
  return entry
}

/**
 * 这条守是不是启用着。
 *
 * `watchers.json` 是**人也会手改**的文件（真机踩过：`enabled: "false"` 字符串让守照常轮询）。
 * 所以不能只判 `=== false`：字符串 "false"、数字 0、"0" 都算暂停，缺省才算启用。
 */
function isEnabled(entry) {
  if (!entry) return false
  const value = entry.enabled
  if (value === undefined || value === null) return true
  if (value === false || value === 0) return false
  const text = String(value).trim().toLowerCase()
  return !(text === 'false' || text === '0' || text === 'no' || text === 'off')
}

function normalizePaused(entry) {
  if (!entry || isEnabled(entry)) return entry
  if (entry.lastError || entry.lastErrorAt || entry.consecutiveFailures) {
    entry.lastError = null
    entry.lastErrorAt = null
    entry.consecutiveFailures = 0
    entry.needsReauth = false
  }
  return entry
}
/**
 * 合并同一个 watcher 的两份记录：**水位只许前进**。
 *
 * 真机事故（0.9.194 审核 M2）：`watch_ack` 把 `seen[42]` 推到 05:00，
 * 但并发的那次 tick 手里是 04:59 的快照，收尾整份覆盖 → 水位后退 →
 * 180 秒冷却期一过，同一条又被算成「新动态」再叫醒一次。
 */
function mergeWatermark(diskEntry, memEntry) {
  if (!diskEntry) return memEntry
  if (!memEntry) return diskEntry
  const out = { ...diskEntry, ...memEntry }
  const seen = { ...(diskEntry.seen || {}) }
  for (const [key, at] of Object.entries(memEntry.seen || {})) {
    const prev = seen[key]
    if (!prev || Date.parse(at) >= Date.parse(prev)) seen[key] = at
  }
  out.seen = seen
  // lastPoll 同理：晚的那个才是事实
  if (diskEntry.lastPoll && (!out.lastPoll || Date.parse(diskEntry.lastPoll) > Date.parse(out.lastPoll))) {
    out.lastPoll = diskEntry.lastPoll
  }
  return out
}

function writeState(state, options = {}) {
  try {
    mkdirSync(stateDir(), { recursive: true })
    // 合并写：调用方手里的 state 可能是很久以前读的快照（宿主重载、两个实例交替写），
    // 直接整份覆盖会把别人刚建的 watcher 抹掉 —— 真机上丢过两条（一条是用户的）。
    // 规则：盘上有、内存里没有的条目一律保留；只有墓碑里的 id 才允许消失。
    const disk = readState()
    const tombstones = { ...(disk.deleted || {}), ...(state.deleted || {}) }
    // 只有显式的 watch_start 才能解除墓碑（用户要求重建同 id 的守）。
    // 普通旧快照写入没有这个选项，仍然不能绕过墓碑把已删守复活。
    for (const id of (Array.isArray(options.revive) ? options.revive : [])) delete tombstones[id]
    const merged = { ...disk, ...state }
    merged.watchers = { ...(disk.watchers || {}) }
    for (const [id, watcher] of Object.entries(state.watchers || {})) {
      merged.watchers[id] = mergeWatermark(merged.watchers[id], watcher)
    }
    const now = Date.now()
    for (const [id, at] of Object.entries(tombstones)) {
      delete merged.watchers[id]
      // 墓碑留 7 天足够覆盖任何迟到写入
      if (now - Date.parse(at) > 7 * 24 * 3600 * 1000) delete tombstones[id]
    }
    if (Object.keys(tombstones).length > 0) merged.deleted = tombstones
    else delete merged.deleted

    merged.schemaVersion = CURRENT_STATE_SCHEMA
    const text = JSON.stringify(merged, null, 1)
    // 原子写：写一半崩掉不该把全部 watcher 清空
    const tmp = stateFile() + '.tmp'
    writeFileSync(tmp, text)
    // 覆盖前先把「当前这份好的」留成备份：主文件将来被写坏（断电、磁盘满、手改），
    // readState 还能退回来，而不是把客户所有守当成空状态。
    try {
      const current = readFileSync(stateFile(), 'utf8')
      JSON.parse(current) // 只有当前文件是好的才备份，别把坏文件备份成"好版本"
      writeFileSync(stateFile() + '.bak', current)
    } catch {}
    try { renameSync(tmp, stateFile()) } catch { writeFileSync(stateFile(), text) }
    // 第一次写入时盘上还没有好文件，`.bak` 会是空的 —— 那就等于没有备份。
    // 主文件一坏（断电/手改/磁盘满）就会丢掉全部守。所以这里补一份引导备份。
    if (!existsSync(stateFile() + '.bak')) {
      try { writeFileSync(stateFile() + '.bak', text) } catch {}
    }
    return merged
  } catch (error) {
    // 写盘失败以前是**静默**的：唤醒已经发出去了，`seen` 却没落盘 → 下一轮重复唤醒，
    // 而 /state 显示一切正常（审核 M3）。把失败记进状态，让它能被看见。
    lastWriteError = {
      at: new Date().toISOString(),
      message: String((error && error.message) || error).slice(0, 200),
    }
    try {
      const live = state && state.watchers ? state : { watchers: {} }
      live.writeError = lastWriteError
      return live
    } catch { return state /* 兜底：写状态的失败不该让一个 turn 崩掉 */ }
  }
}

/** Credentials the operator typed in the panel. Never returned in plain text. */
function readSecrets() {
  try {
    const raw = JSON.parse(readFileSync(secretsFile(), 'utf8'))
    return raw && typeof raw === 'object' ? raw : {}
  } catch { return {} }
}

function writeSecrets(next) {
  try {
    mkdirSync(stateDir(), { recursive: true })
    writeFileSync(secretsFile(), JSON.stringify(next, null, 1), { mode: 0o600 })
    // mode 在 Windows 上几乎无效，补 ACL（见 hardenSecretsFile 注释）
    hardenSecretsFile(secretsFile())
  } catch {}
}

/** A masked view of what is configured: shape only, never the value. */
function secretsSummary() {
  const s = readSecrets()
  return {
    token: s.token ? 'configured' : 'none',
    // 只回「有没有配」：连首尾各 4 个字符也算信息泄露
    tokenHint: s.token ? 'configured' : null,
    sshKeyPath: s.sshKeyPath ? 'configured' : 'none',
    // 从不在面板回显路径（Windows 路径里的反斜杠曾让掩码整段漏出）
    sshKeyHint: null,
    // 「用哪个 gh 账号」同理：只回配没配，不回路径（取自 PR #7 的设计）
    ghConfigDir: s.ghConfigDir ? 'configured' : 'none',
    giteeToken: s.giteeToken ? 'configured' : 'none',
    ghConfigDirHint: null,
    updatedAt: s.updatedAt ?? null,
  }
}

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
// 审核 T36 W3：这个 Map 只增不减 —— 客户换过几十个会话之后，几十条会话标题一直挂在内存里。
// 加个上限：超过就把最早的几条扔掉（它只是缓存，扔了下次重读文件即可）。
const titleCache = new Map()
const TITLE_CACHE_MAX = 32
function putTitleCache(sessionId, value) {
  titleCache.set(sessionId, value)
  while (titleCache.size > TITLE_CACHE_MAX) {
    const oldest = titleCache.keys().next().value
    titleCache.delete(oldest)
  }
}

/** Decompress a multi-frame zstd session log into text. */
function readFrames(buffer) {
  const starts = []
  let index = 0
  while ((index = buffer.indexOf(ZSTD_MAGIC, index)) !== -1) { starts.push(index); index += 4 }
  if (starts.length === 0 || starts[0] !== 0) starts.unshift(0)
  const parts = []
  for (let k = 0; k < starts.length; k += 1) {
    const end = k + 1 < starts.length ? starts[k + 1] : buffer.length
    try { parts.push(zstdDecompressSync(buffer.subarray(starts[k], end)).toString('utf8')) } catch {}
  }
  return parts.join('')
}

/** The human title the sidebar shows for a session, read from its own log. Cached by file mtime. */
/** sessionId → 会话日志路径的索引缓存（60 秒 TTL；命中后只 stat 单个文件）。 */
const sessionFileCache = { at: 0, byId: new Map() }

function sessionTitle(sessionId) {
  try {
    if (!sessionId) return null
    const home = process.env.DSH_HOME && String(process.env.DSH_HOME).trim()
      ? String(process.env.DSH_HOME).trim()
      : join(homedir(), '.dsh')
    const root = join(home, 'sessions')
    // 目录索引缓存：/state 每 5 秒一次 × 每条 watcher，全量 readdir + existsSync 太亏。
    // 关键：miss 也要走 TTL（负缓存）—— 只要有一个 watcher 的会话日志不存在，
    // 每次 /state 都全量重建会把 0.6ms 拖成 130-500ms（终审实测 200/800 会话两种规模）。
    if (Date.now() - sessionFileCache.at > 60 * 1000) {
      sessionFileCache.byId.clear()
      for (const group of readdirSync(root)) {
        const dir = join(root, group)
        let names = []
        try { names = readdirSync(dir) } catch { continue }
        for (const name of names) {
          const candidate = join(dir, name, 'session.v4.jsonl.zstd')
          if (existsSync(candidate)) sessionFileCache.byId.set(name, candidate)
        }
      }
      sessionFileCache.at = Date.now()
    }
    const file = sessionFileCache.byId.get(sessionId) || null
    if (!file) return null
    const stat = statSync(file)
    const cached = titleCache.get(sessionId)
    if (cached && cached.mtime === stat.mtimeMs && cached.size === stat.size) return cached.title
    let title = null
    const lines = readFrames(readFileSync(file)).split(String.fromCharCode(10))
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      const line = lines[i]
      if (!line || line.indexOf('"session/title"') === -1) continue
      try {
        const parsed = JSON.parse(line)
        if (parsed && parsed.type === 'session/title' && parsed.data && typeof parsed.data.title === 'string') {
          title = parsed.data.title
          break
        }
      } catch {}
    }
    putTitleCache(sessionId, { mtime: stat.mtimeMs, size: stat.size, title })
    return title
  } catch { return null }
}

/**
 * The session's real goal, read through the host's own goal service — the same
 * one `/goal` and the create_goal tool use. Returns null when the host has no
 * goal service or the session has no current goal.
 */
function goalView(ctx, sessionId) {
  try {
    if (!sessionId || typeof ctx.get !== 'function') return null
    const goals = ctx.get('goals')
    const agents = ctx.get('agents')
    if (!goals || !agents || typeof goals.get !== 'function') return null
    const agent = agents.get(sessionId)
    if (!agent) return null
    const view = goals.get(agent)
    if (!view) return null
    return {
      objective: view.objective ?? null,
      phase: view.phase ?? null,
      revision: view.ref ? view.ref.revision : (view.revision ?? null),
    }
  } catch { return null }
}

/** Environment for every gh call: a panel token wins over the CLI login. */
function ghEnv() {
  const s = readSecrets()
  const env = { ...process.env }
  // 为什么要 GH_CONFIG_DIR：`gh` 的登录态按平台存在各自配置目录里
  // （Windows 在 %APPDATA%\GitHub CLI，POSIX 在 ~/.config/gh）。不指定时插件用的是
  // 「跑 DSH 这个人的账号」—— 替团队干活的守，每条评论都会挂在操作者名下。
  // 指向一个只登录了智能体账号的目录即可换身份；该目录没登录时 gh 直接失败（fail-closed）。
  // 设计取自 PR #7（@ysl289）。
  if (s.ghConfigDir) env.GH_CONFIG_DIR = String(s.ghConfigDir)
  // 面板里显式配的 token 优先级最高：它就是要覆盖目录里可能存在的登录态。
  if (s.token) env.GH_TOKEN = String(s.token)
  return env
}

/**
 * 安全地取 agents 服务。
 * 定时器回调跑在「非活跃上下文」里，直接读 `ctx.agents` 会抛
 * `cannot get required service "agents" in inactive context`（2026-11-02 真机复验踩到）；
 * `ctx.get(name)` 不抛，取不到就返回 undefined。
 */
function agentsService(ctx) {
  try {
    if (typeof ctx.get === 'function') {
      const viaGet = ctx.get('agents')
      if (viaGet) return viaGet
    }
  } catch {}
  try { return ctx.agents } catch { return undefined }
}

/** gh CLI 可用性探针：5 分钟缓存，别让面板每 5 秒都 spawn 一次 gh。 */
const ghHealthCache = { at: 0, value: null }
// 只在失败路径上调用：确认凭证到底还有没有效（真机上令牌失效时 gh 输出为空）
let authStatusCache = { at: 0, text: '' }
async function ghAuthStatusText() {
  if (Date.now() - authStatusCache.at < 60000 && authStatusCache.text) return authStatusCache.text
  const res = await run('gh', ['auth', 'status'], { timeoutMs: 8000 })
  const text = [res.stdout, res.stderr].filter(Boolean).join(String.fromCharCode(10))
  authStatusCache = { at: Date.now(), text }
  return text
}

async function ghHealth() {
  if (Date.now() - ghHealthCache.at < 5 * 60 * 1000 && ghHealthCache.value) return ghHealthCache.value
  let value
  try {
    const res = await run('gh', ['--version'], { timeoutMs: 10000 })
    value = res.code === 0
      ? { ok: true, version: String(res.stdout || '').trim().split(String.fromCharCode(10))[0].slice(0, 80) }
      : { ok: false, error: redact([res.stderr, res.stdout].join(' ')).slice(0, 160) }
  } catch (error) {
    value = { ok: false, error: String((error && error.message) || error).slice(0, 160) }
  }
  ghHealthCache.at = Date.now()
  ghHealthCache.value = value
  return value
}

function persistEntry(entry) {
  try {
    const state = readState()
    state.watchers = state.watchers || {}
    const stored = state.watchers[entry.id]
    // Deleted between the tick start and its write-back: never resurrect it.
    if (!stored) return
    state.watchers[entry.id] = mergePollResult(stored, entry)
    writeState(state)
  } catch {}
}

/**
 * 失败退避：连续失败就把下一次允许轮询的时间往后推（30s → 60 → 120 … 上限 30min）。
 * 竞品的教训很直白 —— 401 的时候还按 30 秒撞墙，只会把配额和日志一起打光。
 */
/**
 * 记一条时间线事件（有界、只存在状态里）。
 * 目的：回答"为什么这一轮没叫醒我" —— 以前只有 lastDeferred 一句，看不出前后因果。
 */
function noteEvent(entry, kind, text) {
  try {
    entry.events = pushEvent(entry.events, { kind, text })
  } catch { /* 观测失败不能影响主流程 */ }
}


function bumpFailure(entry, baseMs) {
  entry.consecutiveFailures = (Number(entry.consecutiveFailures) || 0) + 1
  entry.nextAt = new Date(Date.now() + nextDelayMs(entry, effectiveIntervalMs(entry, baseMs || 60000))).toISOString()
}

/**
 * 回收过期的隔离区：每次唤醒都会开一个新 worktree，不回收就会一直涨。
 * 只删 .dsh-zhuli/ 下超过 keepDays 天没动过的目录，删不掉就留着（不阻断唤醒）。
 */
async function cleanupWorktrees(workdir, keepDays = 3, keepCount = 5, options = {}) {
  if (!workdir) return 0
  const BS = String.fromCharCode(92)
  const base = String(workdir).split(BS).join('/').replace(/\/+$/, '')
  const root = base + '/.dsh-zhuli'
  let names = []
  try { names = readdirSync(root) } catch { return 0 }

  // 节流：没有超额就不必每次都跑 git（remove / prune / branch -D 都是进程级开销）
  const decision = shouldRunCleanup({
    count: names.length,
    keepCount,
    lastRunAt: Number(options.lastRunAt) || 0,
    intervalMs: CLEANUP_INTERVAL_MS,
  })
  if (!decision.run) return 0
  if (typeof options.onRun === 'function') options.onRun(decision.reason)
  const entries = []
  for (const name of names) {
    try { entries.push({ name, mtimeMs: statSync(root + '/' + name).mtimeMs }) } catch {}
  }
  // 数量线：最近 N 个留着（默认 5），其余回收 —— 年龄线管不住"堆"
  const stale = staleWorktrees(entries, { keepMs: keepDays * 24 * 3600 * 1000, keepCount: Number(keepCount) || 5 })
  let removed = 0
  for (const item of stale) {
    const target = root + '/' + item.name
    const res = await run('git', ['-C', workdir, 'worktree', 'remove', '--force', target], { timeoutMs: 30000 })
    if (res.code !== 0) {
      // 已经不是工作树（孤儿目录）：直接删目录，别让它永远留着
      try { rmSync(target, { recursive: true, force: true }) } catch {}
      // 关键：目录删了，但 git 的 `worktrees/<id>/` 管理文件还在 —— 不 prune 的话
      // `git worktree list` 会一直显示一个已经不存在的目录。
      // 依据：git-worktree 文档里 `prune` 的职责正是「清掉那些目录已经不在了的管理记录」。
      await run('git', ['-C', workdir, 'worktree', 'prune'], { timeoutMs: 20000 })
    } else {
      removed += 1
    }
    // 无论 worktree 是否删成功，都试着删分支：每次唤醒一个新分支，不删会无限涨
    await run('git', ['-C', workdir, 'branch', '-D', 'zhuli/' + item.name], { timeoutMs: 30000 })
  }
  return removed
}

/**
 * 给一次唤醒准备隔离工作区：在目标仓库上开一个一次性 git worktree。
 * 失败不阻断唤醒 —— 退化成普通模式，并在消息里说明原因。
 */
/**
 * 让隔离区不污染客户的 `git status`。
 *
 * 隔离区开在仓库内的 .dsh-zhuli/ 下，默认是**未跟踪目录** ——
 * 客户一切 git status 就会看到它，甚至可能顺手 git add 进去。
 * 写到 `.git/info/exclude`（本地、不提交、不修改客户的 .gitignore）最合适。
 */
async function ensureIsolationExcluded(workdir) {
  try {
    const res = await run('git', ['-C', workdir, 'rev-parse', '--git-path', 'info/exclude'], { timeoutMs: 15000 })
    if (res.code !== 0) return false
    const file = String(res.stdout || '').trim()
    if (!file) return false
    let current = ''
    try { current = readFileSync(file, 'utf8') } catch { current = '' }
    if (current.split(/\r?\n/).includes('.dsh-zhuli/')) return true
    const next = current + (current.endsWith('\n') || current === '' ? '' : '\n') + '.dsh-zhuli/' + '\n'
    writeFileSync(file, next)
    return true
  } catch {
    return false
  }
}

async function prepareIsolation(entry) {
  if (!entry || !entry.isolated || !entry.workdir) return null
  const plan = worktreePlan({ workdir: entry.workdir, repo: entry.repo, sessionTag: entry.sessionId })
  try {
    // 先回收过期隔离区，再开新的
    await cleanupWorktrees(entry.workdir, Number(entry.isolateKeepDays) || 3, Number(entry.maxIsolated) || 5, {
      lastRunAt: Number(entry.lastCleanupAt) || 0,
      onRun: () => { entry.lastCleanupAt = Date.now() },
    })
    await ensureIsolationExcluded(entry.workdir)
    const res = await run('git', ['-C', entry.workdir, 'worktree', 'add', plan.dir, '-b', plan.branch], { timeoutMs: 45000 })
    if (res.code !== 0) {
      return { error: redact([res.stderr, res.stdout].filter(Boolean).join(' ')).slice(0, 200) }
    }
    return plan
  } catch (error) {
    return { error: String((error && error.message) || error).slice(0, 200) }
  }
}

/** Spawn a command, capture both streams, never echo the credential. */
/**
 * 离线模式（`DSH_SUPERAGENT_OFFLINE=1`）：所有 `gh` 调用返回固定内容，不碰网络。
 *
 * 为什么需要：单测/CI 里没有有效凭证时，每次 `gh api` 都要等到超时，
 * 一个测试文件能跑 100 秒（真机实测）；而它们的断言与网络无关。
 * 生产里不会设这个变量 —— 开启后结果都是假的，只适合测试。
 */
function offlineGhReply(args) {
  const joined = (args || []).join(' ')
  if (joined.includes('--version')) return 'gh version 2.0.0 (offline)'
  if (joined.includes('api -i user')) return 'HTTP/2.0 200 OK' + String.fromCharCode(13, 10) + String.fromCharCode(13, 10)
  if (joined.includes('api user')) return 'offline-user'
  if (joined.includes('labels')) return '{}'
  const repoMatch = joined.match(new RegExp('repos/([A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+)'))
  return JSON.stringify({ full_name: repoMatch ? repoMatch[1] : 'offline/repo', private: false, items: [], total_count: 0 })
}

function run(file, args, options = {}) {
  const { input, cwd, env, timeoutMs = 60000 } = options
  return new Promise((resolve) => {
    // 统一断路器：已知凭证失效时，除了`gh auth status`/`--version`，一律不发起调用。
    // 放在 run() 里而不是各个调用点：政策只该有一处（见 KB policy-numbers-have-one-home.md）。
    if (file === 'gh' && !(args || []).includes('--version') && !((args || [])[1] === 'auth')) {
      if (isAuthBroken(authStatusCache.text) && Date.now() - authStatusCache.at < 10 * 60 * 1000) {
        resolve({ code: 1, stdout: '', stderr: '凭证已失效，本次没有发起请求：跑 gh auth login 重新登录后再试' })
        return
      }
    }
    // 离线判定抽成纯函数（有单测），见 isOfflineMode。
    if (file === 'gh' && isOfflineMode()) {
      resolve({ code: 0, stdout: offlineGhReply(args), stderr: '' })
      return
    }
    const child = spawn(file, args, { cwd, env: env ?? process.env, windowsHide: true, shell: false })
    let stdout = ''
    let stderr = ''
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      try { child.kill('SIGKILL') } catch {}
      resolve({ code: 'timeout', stdout, stderr })
    }, timeoutMs)
    child.stdout.on('data', (d) => { stdout += d.toString('utf8') })
    child.stderr.on('data', (d) => { stderr += d.toString('utf8') })
    child.on('error', (e) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ code: 'spawn-error', stdout, stderr: String((e && e.message) || e) })
    })
    child.on('close', (c) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ code: c === null ? 0 : c, stdout, stderr })
    })
    if (input !== undefined) child.stdin.write(input)
    child.stdin.end()
  })
}

/**
 * 默认 ack 标签按 provider 走：Gitee 的标签名不允许半角冒号（真机实测拒建）。
 * `labels` 来自插件配置（见 resolveBrandConfig）；不传时保持 0.10.0 的默认。
 */
function defaultAckLabel(provider, labels) {
  return defaultAckLabelFor(provider, labels)
}

function defineTool(options) {
  const properties = {}
  const required = []
  for (const [key, spec] of Object.entries(options.parameters)) {
    properties[key] = {}
    if (spec.type) properties[key].type = spec.type
    if (spec.description) properties[key].description = spec.description
    if (spec.required) required.push(key)
  }
  return {
    name: options.name,
    description: options.description,
    parameters: { type: 'object', properties, ...(required.length ? { required } : {}) },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    async execute(args) {
      const record = args && typeof args === 'object' ? args : {}
      for (const key of required) {
        if (record[key] === undefined || record[key] === null || record[key] === '') {
          return `[error: missing required parameter "${key}"]`
        }
      }
      return options.execute(record)
    },
  }
}

/**
 * Wake one live session with a user message.
 *
 * `Agent.followup()` queues an ordinary turn AND wakes the driver; the durable
 * inbox alone only parks the message (the client shows it as a pending draft).
 */

/**
 * 同会话几秒内的多条唤醒合并成一条再注入。
 *
 * 实测：同会话 3 个守、间隔 60 秒时，首轮抖动只把相位拉开 ≤5 秒 —— 之后每一轮都一样，
 * 于是三次唤醒落在约 1 秒内，会话连着收到 3 条注入（5 个守就是 5 条）。
 * 不做硬间隔，是因为"先到的守永远赢"会把后面的饿死；**合并**既不丢也不饿死。
 */
// 合并窗口：生产 3 秒；测试里可用环境变量压到毫秒级，避免用例等 3 秒
const WAKE_WINDOW_MS = Number(process.env.DSH_SUPERAGENT_WAKE_WINDOW_MS) || 3000
const wakeBuffers = new Map()

// 会话级 FIFO Outbox：忙时排队，空闲按顺序送。
// 只存内存；**未送达不推进水位**，所以宿主重启后下一轮会按原事件重建队列，不会丢。
const WAKE_QUEUE_RETRY_MS = Number(process.env.DSH_SUPERAGENT_WAKE_QUEUE_RETRY_MS) || 5000
const wakeQueues = new Map()
const isBusyWakeResult = (result) => /agent busy|会话正忙/i.test(String(result && result.reason || ''))

function wakeQueueCount(sessionId, ctx) {
  const queue = wakeQueues.get(sessionId)
  if (ctx && queue && queue.ctx !== ctx) return 0
  return queue ? queue.items.length : 0
}

function scheduleWakeFlush(ctx, sessionId, delay = WAKE_QUEUE_RETRY_MS) {
  const queue = wakeQueues.get(sessionId)
  if (!queue || queue.timer || queue.items.length === 0) return
  queue.timer = setTimeout(() => {
    queue.timer = null
    flushWakeQueue(ctx, sessionId)
  }, delay)
  if (queue.timer && typeof queue.timer.unref === 'function') queue.timer.unref()
}

function flushWakeQueue(ctx, sessionId) {
  const queue = wakeQueues.get(sessionId)
  if (!queue || queue.items.length === 0 || (queue.ctx && queue.ctx !== ctx)) return
  const item = queue.items[0]
  const result = wake(ctx, sessionId, item.text)
  if (isBusyWakeResult(result)) {
    scheduleWakeFlush(ctx, sessionId)
    return
  }
  // 只有离开队首的这一条才结算：成功记已送达；非 busy 失败交给原有错误/重试逻辑。
  queue.items.shift()
  for (const cb of item.settled) {
    try { cb(result) } catch { /* 单个 watcher 的结算失败不能堵住后面的队列 */ }
  }
  if (queue.items.length > 0) scheduleWakeFlush(ctx, sessionId, 0)
  else wakeQueues.delete(sessionId)
}

function enqueueWake(ctx, sessionId, text, settled, key) {
  let queue = wakeQueues.get(sessionId)
  // 热重载后的新实例不能接管旧实例的回调与上下文；未送达水位未推进，旧事件会由新轮询重建。
  if (queue && queue.ctx !== ctx) {
    if (queue.timer) clearTimeout(queue.timer)
    queue = null
  }
  queue = queue || { items: [], timer: null, ctx }
  queue.items.push({ text, settled, key, queuedAt: new Date().toISOString() })
  wakeQueues.set(sessionId, queue)
  scheduleWakeFlush(ctx, sessionId)
  return { ok: false, queued: true, reason: '会话正忙（agent busy），已排队（第 ' + queue.items.length + ' 条）—— 空闲后按顺序送达' }
}

function hasQueuedWake(sessionId, key, ctx) {
  const queue = wakeQueues.get(sessionId)
  return Boolean(key && queue && (!ctx || queue.ctx === ctx) && queue.items.some((item) => item.key === key))
}

function clearWakeQueues(ctx) {
  for (const [sessionId, queue] of wakeQueues) {
    if (ctx && queue.ctx !== ctx) continue
    if (queue.timer) clearTimeout(queue.timer)
    wakeQueues.delete(sessionId)
  }
}

function wakeMerged(ctx, sessionId, text, onSettled, queueKey = '', brandName = DEFAULT_BRAND_NAME) {
  // 同一事件已在队列里时不重复入队；先尝试 flush，空闲时会立即把旧队列送完。
  flushWakeQueue(ctx, sessionId)
  if (hasQueuedWake(sessionId, queueKey, ctx)) {
    const result = { ok: false, queued: true, reason: '会话正忙（agent busy），该事件已在队列中，不重复入队' }
    if (onSettled) onSettled(result)
    return { ok: true, merged: false, queued: true }
  }
  const now = Date.now()
  const buf = wakeBuffers.get(sessionId) || { parts: [], timer: null, openedAt: now, settled: [] }
  buf.parts.push(text)
  if (onSettled) buf.settled.push(onSettled)
  if (buf.timer) return { ok: true, merged: true, pending: buf.parts.length }
  buf.timer = setTimeout(() => {
    wakeBuffers.delete(sessionId)
    let result = { ok: false, reason: '合并后没有内容可发（这几条都已被处理过）—— 不用管，下一轮会重新判断' }
    try {
      const merged = mergeWakeTexts(buf.parts, { brandName })
      if (merged) {
        result = wake(ctx, sessionId, merged)
        if (isBusyWakeResult(result)) result = enqueueWake(ctx, sessionId, merged, buf.settled, queueKey)
      }
    } catch (error) {
      result = { ok: false, reason: String((error && error.message) || error) }
    }
    // 关键：真正发送之后才回调 —— 记账（唤醒次数、水位、历史）不能提前
    for (const cb of buf.settled) {
      try { cb(result) } catch { /* 单个回调失败不影响其它 */ }
    }
  }, WAKE_WINDOW_MS)
  if (buf.timer && typeof buf.timer.unref === 'function') buf.timer.unref()
  wakeBuffers.set(sessionId, buf)
  return { ok: true, merged: true, pending: buf.parts.length }
}

function wake(ctx, sessionId, text) {
  const agents = agentsService(ctx)
  const agent = agents && typeof agents.get === 'function' ? agents.get(sessionId) : undefined
  if (!agent) return { ok: false, reason: '这个会话已经不在宿主里了 —— 宿主重启过，或这个会话被关掉了；面板里刷新一下，还在就重建这条主理鱼' }

  const allowed = decideWake(agent.status)
  if (!allowed.ok) return allowed

  // 审核 M1：这是**唯一必进模型上下文**的出口，以前一个字符都不脱敏 ——
  // 全仓 11 个 redact() 调用点全在错误分支上，方向正好反了。
  // issue 标题/评论是外部内容，里面可能带着 token；进了上下文就等于进了日志与训练数据。
  const safeText = redact(text)
  const message = {
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text: safeText }],
    source: { kind: 'user' },
  }
  try {
    if (typeof agent.followup === 'function') {
      agent.followup(message)
      return { ok: true, via: 'followup' }
    }
    if (typeof agent.steer === 'function') {
      agent.steer(message)
      return { ok: true, via: 'steer' }
    }
    const inbox = agent.inbox || (agent.session && agent.session.inbox)
    if (inbox && typeof inbox.append === 'function') {
      inbox.append('next-turn', message)
      return { ok: true, via: 'inbox.append' }
    }
    return { ok: false, reason: '宿主没给这个会话提供投递入口（followup / steer / inbox 都没有）—— 换个宿主版本，或直接在会话里 @ 它' }
  } catch (error) {
    return { ok: false, reason: `throw: ${String((error && error.message) || error)}` }
  }
}



/**
 * 收紧凭证文件权限。
 *
 * Node 文档明确：**on Windows only the write permission can be changed, and the distinction
 * among the permissions of group, owner, or others is not implemented** —— 也就是说
 * 光靠 `mode: 0o600` 在 Windows 上约等于没有保护，同机其他账户仍可能读到 token。
 * 所以在 Windows 上补一条 icacls：断开继承，只给当前用户完全控制。
 * 出处：https://nodejs.org/api/fs.html（fs.chmod 的 Caveats）
 */
let secretsHardened = 'unknown'
// KB: windows-secrets-perms.md —— Windows 上 chmod 0600 保护不了 token，要补 ACL
function hardenSecretsFile(file) {
  if (process.platform !== 'win32') {
    try {
      chmodSync(file, 0o600)
      secretsHardened = 'posix-0600'
    } catch { secretsHardened = 'failed' }
    return secretsHardened
  }
  try {
    const user = os.userInfo().username
    execFileSync('icacls', [file, '/inheritance:r', '/grant:r', user + ':F'], { stdio: 'ignore', timeout: 15000 })
    secretsHardened = 'win32-acl'
  } catch {
    secretsHardened = 'failed'
  }
  return secretsHardened
}


/**
 * token 的权限范围（scopes）。
 *
 * 为什么值得看：GitHub 明确建议「最小权限」——细粒度 token 按端点授予，
 * 而经典 PAT 的 `repo` 一把就是全仓库读写。我们的实现只需要
 * 「读 issue/PR + 写评论和标签」，用 `delete:packages`、`admin:repo_hook` 这类 scope 纯属多余暴露。
 * 出处：https://docs.github.com/en/rest/authentication/permissions-required-for-fine-grained-personal-access-tokens
 *
 * 探测成本约 0.5 秒（起一个 gh 进程），所以缓存 5 分钟，别在每次 /state 里都跑。
 */
let scopesCache = { at: 0, value: null }
const BROAD_SCOPES = ['delete:packages', 'admin:repo_hook', 'admin:org', 'workflow', 'write:packages', 'admin:public_key']

// KB: token-scopes.md —— token 权限要看得见、也要够窄
async function tokenScopes() {
  if (scopesCache.value && Date.now() - scopesCache.at < 5 * 60 * 1000) return scopesCache.value
  const res = await run('gh', ['api', '-i', 'user'], { timeoutMs: 20000, env: ghEnv() })
  let value = { ok: false, scopes: [], broad: [], error: null, checkedAt: new Date().toISOString() }
  if (res.code !== 0) {
    value.error = redact(res.stderr).slice(0, 160)
  } else {
    const text = String(res.stdout || '')
    const line = text.split(String.fromCharCode(10)).find((l) => l.toLowerCase().startsWith('x-oauth-scopes:'))
    const raw = line ? line.slice('x-oauth-scopes:'.length).trim() : ''
    const scopes = raw ? raw.split(',').map((v) => v.trim()).filter(Boolean) : []
    value = {
      ok: true,
      scopes,
      broad: scopes.filter((scope) => BROAD_SCOPES.includes(scope)),
      error: null,
      checkedAt: new Date().toISOString(),
    }
  }
  scopesCache = { at: Date.now(), value }
  return value
}


/**
 * 新增守之前的即时体检：仓库在不在、能不能写、有没有 issue。
 *
 * 为什么放在这里：`probeAccess` 是后台跑的，客户要等到下一次 /state 才看到提示；
 * 而"填错仓库名"是最常见的输入错误，应该在点「添加」那一刻就说。
 *
 * 依据：`GET /repos/{owner}/{repo}` 对不存在的仓库（或无权访问的私有仓库）返回 404 ——
 * 官方文档把这两种情况归为同一个响应，所以文案要一起说「不存在或没有权限」。
 * 出处：https://docs.github.com/en/rest/repos/repos#get-a-repository
 *
 * 注意：**只产出警告，不阻止创建** —— 网络抖动不该让客户没法添加；
 * 测试环境（DSH_SUPERAGENT_NO_POLL=1）直接跳过，避免单测依赖网络。
 */
async function precheckRepo(repo, provider = 'github') {
  const warnings = []
  if (process.env.DSH_SUPERAGENT_NO_POLL === '1') return { warnings, skipped: true }
  // Gitee 仓库不能走 `gh api repos/...`（必然 404，还会把「不存在」写进警告）
  if (provider === 'gitee') {
    try {
      const res = await giteeRepo({ repo, token: String(readSecrets().giteeToken || '') })
      if (res.ok) {
        const access = mapGiteeRepoAccess(repo, res.data || {})
        const note = repoStructureNote({
          repo,
          hasIssues: access.hasIssues,
          archived: access.archived,
          disabled: access.disabled,
          fork: access.fork,
          parent: access.parent,
          push: access.push,
          private: access.private,
        })
        if (note) warnings.push(note)
        return { warnings, access }
      }
      const status = Number(res.status) || 0
      if (status === 401 || status === 403) warnings.push('Gitee token 无效或没权限（设置 → 凭证里重新填一次）')
      else if (status === 404) warnings.push('Gitee 仓库 ' + repo + ' 不存在，或 token 看不到这个私有仓库')
      else warnings.push('添加前没能确认这个 Gitee 仓库（' + String(res.error || status).slice(0, 80) + '），稍后会在面板里再次探测。')
      return { warnings }
    } catch {
      return { warnings }
    }
  }
  const res = await run('gh', ['api', 'repos/' + repo, '--jq',
    '{push: .permissions.push, hasIssues: .has_issues, archived: .archived, disabled: .disabled, private: .private, fork: .fork, parent: (.parent.full_name // null)}',
  ], { timeoutMs: 10000, env: ghEnv() })
  if (res.code !== 0) {
    const detail = redact(res.stderr)
    if (detail.includes('404')) {
      let hint = ''
      // 只在 404 之后才搜一次：search 池是 30 次/分钟（core 是 5000），不能滥用
      const name = repo.split('/')[1] || repo
      if (name.length >= 5) {
        const search = await run('gh', ['api', 'search/repositories?q=' + encodeURIComponent(name + ' in:name') + '&per_page=5', '--jq', '.items[].full_name'],
          { timeoutMs: 10000, env: ghEnv() })
        if (search.code === 0) {
          const picked = pickSuggestion(repo, String(search.stdout || '').split(String.fromCharCode(10)).map((v) => v.trim()).filter(Boolean))
          if (picked) hint = ' 是不是想填 ' + picked + '？'
        }
      }
      warnings.push('仓库 ' + repo + ' 不存在，或当前 token 没有访问权限 —— 先确认名字（owner/name）与权限。' + hint)
      return { warnings, notFound: true }
    }
    warnings.push('添加前没能确认这个仓库（' + detail.slice(0, 100) + '），稍后会在面板里再次探测。')
    return { warnings }
  }
  let info = {}
  try { info = JSON.parse(res.stdout) } catch { return { warnings } }
  const note = repoStructureNote({
    repo,
    hasIssues: info.hasIssues !== false,
    archived: info.archived === true,
    disabled: info.disabled === true,
    fork: info.fork === true,
    parent: info.parent || null,
    push: info.push === true,
    private: info.private === true,
  })
  if (note) warnings.push(note)
  return { warnings, access: { repo, push: info.push === true, private: info.private === true, fork: info.fork === true, hasIssues: info.hasIssues !== false, archived: info.archived === true, disabled: info.disabled === true, parent: info.parent || null, checkedAt: new Date().toISOString() } }
}

/** 隔离区占用：客户长期运行会攒下一堆一次性 worktree，面板上得看得见。 */
function isolationReport(entries) {
  const roots = new Map()
  for (const entry of entries) {
    if (!entry || entry.isolated !== true || !entry.workdir) continue
    roots.set(entry.workdir, true)
  }
  let totalBytes = 0
  const list = []
  for (const workdir of roots.keys()) {
    const base = String(workdir).replace(/[\/]+$/, '') + '/.dsh-zhuli'
    let count = 0
    let bytes = 0
    try {
      for (const name of readdirSync(base)) {
        const full = base + '/' + name
        count += 1
        bytes += dirSize(full, 2)
      }
    } catch { /* 目录还没有就是 0 */ }
    totalBytes += bytes
    list.push({ workdir, count, bytes })
  }
  return { roots: list, totalBytes }
}

/** 递归算目录大小（深度有上限，够用来判断"是不是涨到几百 MB 了"）。 */
function dirSize(path, depth) {
  if (depth <= 0) return 0
  let total = 0
  let items = []
  try { items = readdirSync(path, { withFileTypes: true }) } catch { return 0 }
  for (const item of items) {
    const full = path + '/' + item.name
    if (item.isDirectory()) total += dirSize(full, depth - 1)
    else {
      try { total += statSync(full).size } catch {}
    }
  }
  return total
}


/**
 * 取一批 issue 的「最后评论」。并发跑、短超时、最多 3 条、失败静默 ——
 * 多出来的 API 调用只在这几种条件下发生，别让它变成常态开销。
 */


/**
 * 已安装版本 vs 已加载版本。
 *
 * `SERVER_VERSION` 是**当前进程里加载的代码**的版本；磁盘上 package.json 的 version 是
 * **装好的**版本。两者不同 = 「文件换了，但宿主还在跑老模块」—— 这正是本机反复出现的情况
 * （client 热重载会生效，服务端不会，界面上看不出来）。
 */
function installedVersion() {
  try {
    const here = dirname(fileURLToPath(import.meta.url))
    const pkg = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8'))
    return typeof pkg.version === 'string' ? pkg.version : null
  } catch { return null }
}

/** 当前 token 对应的账号（判断"最后一条评论是不是我们自己发的"）。缓存 10 分钟。 */
// 两家各自的登录名要分开缓存：Gitee 守拿 GitHub 的 login 去比，自回声判定永远不成立。
let viewerCache = { github: { at: 0, login: null }, gitee: { at: 0, login: null } }
async function viewerLogin(provider = 'github') {
  const key = provider === 'gitee' ? 'gitee' : 'github'
  const cached = viewerCache[key]
  if (cached.login && Date.now() - cached.at < 10 * 60 * 1000) return cached.login
  let login = ''
  try {
    if (key === 'gitee') {
      const res = await giteeWhoami({ token: String(readSecrets().giteeToken || '') })
      if (res.ok && res.data && res.data.login) login = String(res.data.login)
    } else {
      const res = await run('gh', ['api', 'user', '--jq', '.login'], { timeoutMs: 12000, env: ghEnv() })
      if (res.code === 0) login = String(res.stdout || '').trim()
    }
  } catch { /* 拿不到就退回上一次的缓存 */ }
  if (login) viewerCache[key] = { at: Date.now(), login }
  return login || cached.login
}

async function fetchLastComments(repo, items, maxItems = 3, options = {}) {
  // Gitee：没有 GraphQL 批量，逐条 REST。条数本来就只取前 3 条，代价可接受。
  // Gitee 的条目不一定带 comments 计数，所以这里不按计数过滤，直接取前几条。
  if (options.provider === 'gitee') {
    const picks = (items || []).slice(0, maxItems)
    await Promise.all(picks.map(async (item) => {
      try {
        const info = await fetchGiteeLastComment({
          repo, token: String(options.token || ''), item, selfLogin: await viewerLogin('gitee'),
        })
        if (info && info.login) item.lastComment = info
      } catch { /* 少一行信息，不阻断唤醒 */ }
    }))
    return
  }
  const targets = (items || []).filter((item) => Number(item.comments) > 0).slice(0, maxItems)
  if (targets.length === 0) return
  const me = await viewerLogin()
  const mark = (item, info) => {
    item.lastComment = {
      login: info.login,
      at: info.at,
      self: Boolean(me && String(info.login).toLowerCase() === me.toLowerCase()),
    }
  }
  // 首选：一次 GraphQL 批量（N 条评论 → 1 个请求）
  try {
    const [owner, name] = String(repo).split('/')
    const query = buildCommentBatchQuery(targets.length)
    const args = ['api', 'graphql', '-f', 'query=' + query, '-F', 'owner=' + owner, '-F', 'name=' + name]
    targets.forEach((item, i) => args.push('-F', 'n' + i + '=' + item.number))
    const res = await run('gh', args, { timeoutMs: 15000, env: ghEnv() })
    // 有 errors 但 data 有值时仍然可用（别的 issue 不存在不影响这一条）
    const payload = JSON.parse(String(res.stdout || '{}'))
    const parsed = parseCommentBatch(payload)
    let hit = 0
    for (const item of targets) {
      const info = parsed[String(item.number)]
      if (!info) continue
      if (info.login) mark(item, info)
      if (Array.isArray(info.linked) && info.linked.length > 0) item.linkedPr = info.linked
      hit += 1
    }
    if (hit > 0) return
  } catch { /* 落到 REST 兜底 */ }
  // 兜底：逐条 REST（GraphQL 不可用时仍要能工作）
  await Promise.all(targets.map(async (item) => {
    try {
      const res = await run('gh', ['api', `repos/${repo}/issues/${item.number}/comments?per_page=1&sort=created&direction=desc`,
        '--jq', '.[0] | {login: .user.login, at: .created_at}'], { timeoutMs: 12000, env: ghEnv() })
      if (res.code !== 0) return
      const parsed = JSON.parse(res.stdout)
      if (parsed && parsed.login) mark(item, { login: parsed.login, at: parsed.at })
    } catch { /* 少一行信息，不阻断唤醒 */ }
  }))
}

async function pollOnce(ctx, entry, baseMs, brand = null) {
  // 活跃时段要**在拉 API 之前**判断：以前放在后面，夜里照样每 N 秒打一次 GitHub，纯浪费。
  // 不在时段内就把下一次轮询安排到"开门那一刻"，攒着的条目不会多等一个周期。
  if (entry.activeHours && !inActiveHours(entry.activeHours)) {
    const wait = msUntilActiveWindow(entry.activeHours)
    // 时段外不轮询：顺手清掉旧错误（否则面板会一直显示一条永不消停的「异常」）
    enterActiveHoursDefer(entry, wait, entry.activeHours)
    noteEvent(entry, 'defer', entry.lastDeferred)
    return
  }
  // 条件请求：带上上次的 ETag，没变化时 GitHub 回 304，且**不计入**速率限制
  // ── Gitee 分支 ────────────────────────────────────────────────────────────
  // Gitee 没有 gh CLI、没有 GraphQL、没有 ETag 条件请求；用 REST v5 拉一页，
  // 在 lib/gitee.js 里归一成和 GitHub 一样的条目形状，下面所有筛选/唤醒逻辑共用。
  if (entry.provider === 'gitee') {
    // 没有 ETag，就用 `since` 只取「上次水位之后更新过」的条目 —— 省的是每轮的解析与带宽。
    // 安全边际 30 分钟：宁可多读一轮，也不能因为时钟偏差漏掉一条。首次轮询没有水位，仍然全量。
    const sinceIso = (() => {
      const base = entry.cursor || entry.lastPoll
      if (!base) return ''
      const t = Date.parse(base)
      if (!Number.isFinite(t)) return ''
      return new Date(Math.max(0, t - 30 * 60 * 1000)).toISOString()
    })()
    const listed = await listGiteeItems({ repo: entry.repo, token: String(readSecrets().giteeToken || ''), perPage: 20, since: sinceIso })
    entry.lastPoll = new Date().toISOString()
    if (!listed.ok) {
      const status = Number(listed.status) || 0
      // 401 = token 问题（不会自己好）；**403 要先看正文**：Gitee 的限流回的就是 403
      // `403 Forbidden (Rate Limit Exceeded)`，判成 auth 会让客户去重生成 token，实际只要等（审核 G1）。
      const rateLimited = status === 403 && /rate limit|too many/i.test(String(listed.error || ''))
      const kind = status === 401 || (status === 403 && !rateLimited) ? 'auth'
        : rateLimited || status === 429 ? 'ratelimit'
          : status === 404 ? 'notfound' : 'network'
      const hint = kind === 'auth' ? '（Gitee token 无效或没权限：在设置里填 Gitee 私人令牌）'
        : kind === 'ratelimit' ? '（被 Gitee 限流：下一轮再试）'
          : kind === 'notfound' ? '（Gitee 仓库不存在，或 token 看不到这个私有仓库）'
            : '（连不上 Gitee：' + String(listed.error || '').slice(0, 80) + '）'
      if (kind === 'ratelimit') {
        entry.nextAt = new Date(Date.now() + 60 * 1000).toISOString()
        entry.lastDeferred = '被 Gitee 限流，等 60 秒'
        entry.deferReason = 'ratelimit'
        entry.lastError = null
        noteEvent(entry, 'ratelimit', entry.lastDeferred)
        return
      }
      setEntryError(entry, ('Gitee ' + (status || '请求失败') + hint).slice(0, 300))
      if (kind === 'auth') entry.needsReauth = true
      bumpFailure(entry, baseMs)
      return
    }
    // 一半成功（issue 拿到、PR 没拿到）要说出来，否则客户以为 PR 一条都没有
    if (listed.partial) noteEvent(entry, 'partial', 'Gitee ' + (listed.partial === 'pulls' ? 'PR' : 'issue') + ' 列表这一轮没拿到')
    // 审核 G3：一页满了 = 可能被截断。这一轮**不推进水位**，否则被截掉的那些永远不再出现
    // （停机恢复/首次轮询时最危险：攒了 30 条只看到 20 条，另外 10 条静默丢掉）。
    if (listed.truncated) {
      noteEvent(entry, 'partial', 'Gitee 列表满了一页（可能被截断）：这一轮不推进水位，下一轮接着读')
      entry.lastDeferred = 'Gitee 列表可能被截断，水位先不动'
      entry.deferReason = 'truncated'
      return
    }
    const items = listed.items || []
    if (items.length === 0) {
      entry.lastError = null
      entry.needsReauth = false
      entry.consecutiveFailures = 0
      entry.nextAt = null
      entry.lastDeferred = UNCHANGED_TEXT_GITEE
      entry.deferReason = 'unchanged'
      noteEvent(entry, 'unchanged', entry.lastDeferred)
      return
    }
    // 归一后的条目直接交给共用判定：形状已和 GitHub 一致，后面不该再分两家
    return pollWithItems(ctx, entry, baseMs, { status: 200, etag: null, body: JSON.stringify(items) }, brand)
  }

  const args = ['api', '--include', `repos/${entry.repo}/issues?state=all&sort=updated&direction=desc&per_page=20`]
  if (entry.etag) args.push('-H', 'If-None-Match: ' + entry.etag)
  const res = await run('gh', args, { timeoutMs: 45000, env: ghEnv() })
  entry.lastPoll = new Date().toISOString()
  if (res.code !== 0) {
    // gh 把 304 当失败（非 2xx 就 exit 1）：这不是错误，是「条件请求命中」
    if (/HTTP 304|304 Not Modified|not modified/i.test(String(res.stderr || '') + String(res.stdout || ''))) {
      settleNotModified(entry)
      return
    }
    // 先分类，再决定等多久 —— 顺序反了会引用到未定义的变量（本轮自己踩过）
    const detail = redact(res.stderr).slice(0, 240)
    const classified = classifyGhError(detail)
    const failure = parseGhInclude(res.stdout)
    // secondary/abuse 限流：文档要求至少等一分钟；服务端给了 Retry-After 就按它等
    const wait = retryAfterMs(failure.retryAfter) || (classified.kind === 'ratelimit' ? 60 * 1000 : 0)
    if (wait > 0) {
      entry.nextAt = new Date(Date.now() + wait).toISOString()
      entry.lastDeferred = '被 GitHub 限流，按 Retry-After 等 ' + Math.round(wait / 1000) + ' 秒'
      entry.deferReason = 'ratelimit'
      noteEvent(entry, 'ratelimit', entry.lastDeferred)
      entry.lastError = null
      entry.needsReauth = false
      return
    }
    setEntryError(entry, (classified.short + classified.hint).slice(0, 300))
    bumpFailure(entry, baseMs)
    // 凭证问题要显式标出来：它不会自己恢复，客户必须去 gh auth login
    if (classified.kind === 'auth') entry.needsReauth = true
    // 没见过的措辞：留样本，下一轮才好补分类规则
    if (classified.kind === 'other') recordOtherError(entry, detail)
    const permanent = permanentBackoffMs(classified.kind, baseMs)
    if (permanent > 0) {
      entry.nextAt = new Date(Date.now() + permanent).toISOString()
      entry.deferReason = classified.kind
    }
    return
  }
  const parsed = parseGhInclude(res.stdout)
  // GitHub 的 x-poll-interval 是硬下限：比我们的间隔大就照它等，别硬撞
  if (parsed.pollInterval && parsed.pollInterval * 1000 > baseMs) {
    entry.minIntervalSec = parsed.pollInterval
  } else if (entry.minIntervalSec && (!parsed.pollInterval || parsed.pollInterval * 1000 <= baseMs)) {
    entry.minIntervalSec = null
  }
  // 额度自适应：剩余低于 500 时不再按固定间隔撞墙，直接把下一轮推到额度重置（最多 1 小时）
  const throttle = throttleDelayMs({ remaining: parsed.remaining, resetAt: parsed.resetAt })
  if (throttle > 0) {
    entry.nextAt = new Date(Date.now() + throttle).toISOString()
    // 审核 T20：以前 deferReason 被拼成 'quota09:30Z' —— 面板按 reason 筛选永远空。
    // 文案抽成纯函数（quotaDeferText）并有单测钉住：reason 只有稳定原因，时间只在人读的那句里。
    const quotaText = quotaDeferText(parsed.remaining, throttle)
    entry.lastDeferred = quotaText.text
    entry.deferReason = quotaText.reason
    entry.lastError = null
    entry.needsReauth = false
    return
  }
  // 204 No Content 也是「没有新东西」：DELETE/空列表都会这样，别当 JSON 解析失败
  if (parsed.status === 204) {
    entry.lastError = null
    entry.needsReauth = false
    entry.consecutiveFailures = 0
    entry.nextAt = null
    entry.lastDeferred = '没有内容（204）'
    entry.deferReason = 'unchanged'
    noteEvent(entry, 'unchanged', entry.lastDeferred)
    return
  }
  if (parsed.status === 304) {
    settleNotModified(entry)
    return
  }
  // 记下「最后一次真正拿到 200 正文」的时刻：304 超过 10 分钟就不再信任 ETag。
  entry.lastFreshAt = new Date().toISOString()
  // ETag 先存到 pending，确认这一轮真的被消费（或被正当记账）后才前移。
  // 原因：下面有多个提前 return 的分支（会话正忙 / 会话上限 / 每小时上限 / 本轮被暂停 / 会话已不在）。
  // 它们刻意不动 seen/cursor（注释也写了「否则攒着等于丢掉」），但 ETag 若已前移，
  // 下一轮条件请求就会拿到 304 并在上面直接 return，fresh 永远不再重算 —— 效果同样是「攒着＝丢掉」。
  return pollWithItems(ctx, entry, baseMs, parsed, brand)
}

/**
 * 拿到一页条目之后的所有事：解析 / 过滤 / 推迟 / 唤醒 / 记账。
 *
 * 抽出来是为了让 GitHub 与 Gitee 共用同一套判定 —— 两家只有「怎么拿数据」不同，
 * 「要不要叫醒、叫醒说什么、水位怎么走」必须完全一致，否则同一条 bug 要修两遍。
 */
async function pollWithItems(ctx, entry, baseMs, parsed, brand = null) {
  const pendingEtag = parsed.etag
  const commitEtag = () => { if (pendingEtag) entry.etag = pendingEtag }
  let items
  try {
    items = JSON.parse(parsed.body)
  } catch {
    // 空/坏内容：先看凭证，再谈代理 —— 真机上令牌失效时 gh 输出为空，
    // 而原来的文案一律怪「代理干扰」，客户会去查一个不存在的代理。
    const authText = await ghAuthStatusText()
    const diag = diagnoseBadBody({ bodyText: parsed.body, authStatusText: authText })
    if (diag && diag.kind === 'auth') entry.needsReauth = true
    // 兜底不再默认「可能是代理干扰」：那会把客户往网络上游带。
    // 现在只有确诊是网关页才说代理；其余情况指向 watch_doctor 与本仓库 issue。
    setEntryError(entry, (diag ? diag.hint : '（返回内容不是合法 JSON：先跑 watch_doctor；确认不是凭证问题就带上这段提 issue）') + ' —— 已按退避自动重试')
    bumpFailure(entry, baseMs)
    if (diag && diag.kind === 'auth') {
      const wait = permanentBackoffMs('auth', baseMs)
      if (wait > 0) entry.nextAt = new Date(Date.now() + wait).toISOString()
    }
    return
  }
  if (!Array.isArray(items)) { setEntryError(entry, '返回的数据结构不对（预期是数组）—— 已按退避自动重试；持续出现请跑 watch_doctor'); bumpFailure(entry, baseMs); return }

  entry.lastError = null
  entry.needsReauth = false
  entry.consecutiveFailures = 0
  entry.nextAt = null
  // 触发要有许可：过滤器不通过的条目根本不进候选集，也不写 seen 水位
  // 记忆要有遗忘：seen 只增不减会问成几 MB 的字典
  entry.seen = pruneSeen(entry.seen)
  const ackLabel = entry.ackLabel || defaultAckLabel(entry.provider, brand && brand.defaultAckLabels)
  // 幂等痕迹留在 GitHub 上：带 ack 标签的条目直接跳过（换机器、删状态都不会重报）
  const considered = []
  // 每轮重置：这行要被读成「本轮跳过多少」，累计值会越滚越大、误导客户
  entry.filterCounts = {}
  for (const item of items) {
    if (hasAckLabel(item, ackLabel)) {
      entry.filteredLog = pushFiltered(entry.filteredLog, { at: entry.lastPoll, number: item.number, title: String(item.title || '').slice(0, 80), reason: '已 ack' })
      entry.filterCounts = countReasons(entry.filterCounts, '已 ack')
      continue
    }
    const reason = filterReason(item, entry.filters)
    if (reason) {
      entry.filterCounts = countReasons(entry.filterCounts, reason)
      entry.filteredLog = pushFiltered(entry.filteredLog, { at: entry.lastPoll, number: item.number, title: String(item.title || '').slice(0, 80), reason })
      continue
    }
    considered.push(item)
  }
  // Gitee 没有 state_reason：用上一轮记下的状态自己判「重新打开」（GitHub 有原生字段，不覆盖）
  if (entry.provider === 'gitee') {
    entry.lastStates = markGiteeReopened(items, entry.lastStates || {})
  }
  // 记住最近一条"被重新打开"的 issue：这是最该被看见的信号。
  // **必须放在 markGiteeReopened 之后** —— 以前写在前面，Gitee 判出来的 reopened 那一轮已经算完，
  // 下一轮 lastStates 已是 open，永远不再触发（T8 审计发现）。
  const reopened = items.find((item) => (item.state_reason || '') === 'reopened')
  // 以前只写不清：一条 issue 重新打开过一次，面板就永远挂着「被重新打开」。
  // 这一页里已经看不到它（或它又关了）就清掉 —— 它描述的是「最近一次轮询的事实」。
  if (reopened) entry.lastReopened = reopened.number
  else if (entry.lastReopened && !items.some((item) => String(item.number) === String(entry.lastReopened))) {
    entry.lastReopened = null
  }
  const { fresh, absorbed } = partitionItems(considered, entry, { cooldownMs: Number(entry.cooldownMs) || DEFAULT_COOLDOWN_MS })

  if (absorbed.length > 0) {
    entry.seen = advanceSeen(entry.seen, absorbed)
    entry.lastAbsorbed = absorbed.length
    // 记下来才能回答「这条为什么没叫醒我」—— 以前只能说「被吸收/仅观察/或早就有」三合一
    entry.absorbedLog = pushAbsorbed(entry.absorbedLog, absorbed, entry.lastPoll)
    const newestAbsorbed = newestUpdatedAt(absorbed)
    if (!entry.cursor || Date.parse(newestAbsorbed) > Date.parse(entry.cursor)) entry.cursor = newestAbsorbed
  }
  if (fresh.length === 0) {
    // 这一轮没有新增：上一轮的说法（比如「仅观察：本会唤醒 4 条」）已经过期了
    entry.lastDeferred = null
    // 没有待办就不会有「攒着」的问题，可以安全前移
    commitEtag()
    return
  }

  // 仅观察模式（对标官方 observe）：照常判定，但只记录「本会唤醒哪几条」，不真唤醒
  if (entry.observe === true) {
    entry.lastDeferred = '仅观察：本轮本会唤醒 ' + fresh.length + ' 条（' + fresh.slice(0, 5).map((i) => '#' + i.number).join(' ') + '）'
    entry.deferReason = 'observe'
    noteEvent(entry, 'observe', entry.lastDeferred)
    entry.history = pushHistory(entry.history, {
      at: new Date().toISOString(),
      numbers: fresh.slice(0, 5).map((i) => i.number),
      ok: false,
      reason: 'observe',
    })
    entry.seen = advanceSeen(entry.seen, fresh)
    entry.cursor = newestUpdatedAt(fresh) || entry.cursor
    // 仅观察模式已经把这一轮记完了（seen/cursor 都前移），ETag 同步前移
    commitEtag()
    return
  }

  // 会话级上限（跨守累计）：单守上限 × 守数量 = 实际频率，光有单守上限挡不住
  const sessionCap = Math.max(1, Number(entry.sessionMaxWakes) || DEFAULT_SESSION_WAKES)
  const sessionUsed = sessionWakesLastHour(Object.values(readState().watchers || {}), entry.sessionId)
  if (sessionUsed >= sessionCap) {
    entry.lastDeferred = '这条会话一小时内已被唤醒 ' + sessionUsed + ' 次（上限 ' + sessionCap + '），已攒 ' + fresh.length + ' 条待处理'
    entry.deferReason = 'cap-session'
    noteEvent(entry, 'cap-session', entry.lastDeferred)
    return
  }

  // 每小时唤醒上限：宁可攒着，也不要连续叫醒把上下文打爆
  const cap = Math.max(1, Number(entry.maxWakesPerHour) || 6)
  entry.wakeTimes = pruneWakeTimes(entry.wakeTimes)
  if (entry.wakeTimes.length >= cap) {
    // 只记原因，绝不动 seen/cursor —— 否则「攒着」等于「丢掉」
    const freeAt = nextWaketimeAt(entry.wakeTimes, cap)
    const waitMin = Math.max(1, Math.round((freeAt - Date.now()) / 60000))
    entry.lastDeferred = `每小时最多唤醒 ${cap} 次，已攒 ${fresh.length} 条待处理（约 ${waitMin} 分钟后可再唤醒）`
    entry.deferReason = 'cap-watcher'
    noteEvent(entry, 'cap-watcher', entry.lastDeferred)
    return
  }

  // 条目不丢：水位照常全部前移，消息里只铺开前 N 条，其余给编号
  // 审核 T21：这里原来有个从没用过的 const limit（死代码），且兜底值写成 || 3，
  // 与创建时的 batchLimit=5 口径分裂。统一成 5，并删掉死变量。
  const batchLimit = Math.max(1, Number(entry.batchLimit) || 5)
  // 「提过但没回执」的条目再提一次：水位线不会因为「没 ack」而回退，所以它们平时永远不会再出现。
  // 并进这一轮，但**不挤掉新条目**：先排新条目，剩下的位置才给重提的。
  const pendingResult = pendingRetry(entry.pending, items, {})
  if (pendingResult.stillPending && Object.keys(pendingResult.stillPending).length !== Object.keys(entry.pending || {}).length) {
    entry.pending = pendingResult.stillPending
  }
  const { listed, rest } = splitBatch(fresh, batchLimit, entry.priorityOrder || entry.priority)
  if (pendingResult.retry.length > 0 && listed.length < batchLimit) {
    const room = batchLimit - listed.length
    const numbersAlready = new Set(listed.map((item) => String(item.number)))
    const extra = pendingResult.retry.filter((item) => !numbersAlready.has(String(item.number))).slice(0, room)
    listed.push(...extra)
  }
  // 暂停/删除可能发生在这一轮轮询期间：以盘上为准
  const liveEntry = (readState().watchers || {})[entry.id]
  if (!liveEntry || !isEnabled(liveEntry)) {
    entry.lastDeferred = '本轮期间被暂停或删除，跳过唤醒'
    return
  }
  // 会话忙就别开隔离区了：白建一个没人用的 worktree
  const liveAgents = agentsService(ctx)
  const liveAgent = liveAgents && typeof liveAgents.get === 'function' ? liveAgents.get(entry.sessionId) : undefined
  if (!liveAgent) {
    // 「找不到会话」有两种：宿主刚启动还没加载（临时），或真被删了（永久）。
    // 2026-11-04 真机：重启后第一轮就报「会话已不在：请删除或重建」，可那个会话明明开着。
    // 所以先给宽限期：期内只写 lastDeferred（不记失败、不退避），过了才认定真的没了。
    const verdict = sessionMissingVerdict({ missingSince: entry.sessionMissingSince })
    if (verdict.justNow) entry.sessionMissingSince = verdict.startedAt
    if (verdict.grace) {
      entry.lastDeferred = '会话尚未就绪（宿主可能刚启动）：约 ' + verdict.waitMin + ' 分钟后仍找不到才报错'
      return
    }
    // 超过宽限期仍找不到：别开隔离区，也别假装在盯。
    // 必须走 bumpFailure —— 否则这条会每 intervalSec 打一次 GitHub，永不退避（第四轮审核指出）。
    setEntryError(entry, '会话已不在（连续 ' + verdict.waitedMin + ' 分钟找不到）：确认该会话是否已被删除，再决定是否重建这条主理鱼')
    bumpFailure(entry, baseMs)
    return
  }
  // 找得到就清掉「缺失计时」，下次重启不会带着旧时间戳
  entry.sessionMissingSince = null
  const gate = decideWake(liveAgent && liveAgent.status)
  if (!gate.ok) {
    entry.lastDeferred = '会话正忙，下一轮重试'
    return
  }

  // 会话忙时**不要**先开隔离区：`git worktree add`（本机实测 0.19s，大仓库更久）
  // 加上回收过期副本的若干次 git 调用，全都是白发 —— 因为 decideWake 之后一定会拒绝。
  {
    const agents = agentsService(ctx)
    const agent = agents && typeof agents.get === 'function' ? agents.get(entry.sessionId) : undefined
    const pre = decideWake(agent && agent.status)
    if (!pre.ok) {
      entry.lastDeferred = '会话正忙（' + String(pre.reason || '') + '），这一轮不准备隔离区，下一轮再试'
      return
    }
  }
  const isolation = await prepareIsolation(entry)
  if (isolation && isolation.dir) entry.lastWorktree = isolation.dir
  // 批次前几条补「最后是谁在说话」（最多 3 条，失败静默）
  await fetchLastComments(entry.repo, listed, 3, {
    provider: entry.provider,
    token: entry.provider === 'gitee' ? String(readSecrets().giteeToken || '') : '',
  })
  // 首次同步：这条守刚建好，或者宿主换了机器（cursor 还是 null）。
  // 此时"有动态"其实是"仓库里本来就有这些待处理"，说成新动态会让人以为刚刚发生。
  const firstSync = !entry.cursor
  const wakeText = formatWatchText(entry.repo, listed, {
    // 品牌名（issue #11）：抬头【…】与面板/诊断共用同一份配置
    brandName: brand ? brand.brandName : undefined,
    more: rest.length,
    firstSync,
    restNumbers: rest.map((item) => item.number),
    isolation,
    // entry.goal 之前只写不读：现在真的进唤醒消息
    goal: entry.goal || '',
    // 只传「绑没绑智能体账号」这个布尔量：**不把路径写进唤醒消息**（会进模型上下文与对话记录，
    // 顺带把本机用户名和目录结构带出去）。路径由用户在需要时自己给。
    identityBound: Boolean(readSecrets().ghConfigDir),
    // 只读仓库要在任务书里直说，否则会话会去试写然后吃 403
    access: accessNote(entry.repoAccess),
    // 完成标准要可观测（Given-When-Then 的思路）：三件事缺一不算完成
    // 三条完成标准抽在 lib/watch.js 里（纯函数，可被用例覆盖）：
    // 这里曾经引用过不存在的 `iso`，只在"会话空闲真的发消息"时才爆 ReferenceError。
    criteria: wakeCriteria({ isolation }),
    // 「为什么是这几条」：把本轮的筛选依据一并写进任务书
    changedTotal: fresh.length,
    batchLimit: listed.length,
    skippedReasons: entry.filterCounts || {},
    // 这条以前被叫醒过吗？history 里一直有数据，但消息从没用过
    seenBefore: (() => {
      const map = {}
      // 审核 T37 M2：`|| []` 挡不住 `42`（不是 iterable）—— 会让这条守永久退避。
      for (const event of (Array.isArray(entry.history) ? entry.history : [])) {
        for (const n of event.numbers || []) map[String(n)] = map[String(n)] || event.at
      }
      return map
    })(),
    // 上次 ack 时留的话（watch_ack 的 note）：同一条再被叫醒时一并带回
    acked: entry.acked && typeof entry.acked === 'object' ? entry.acked : null,
  })
  entry.lastWakeCount = fresh.length
  entry.lastBatch = listed.map((item) => item.number)
  // 记账一律放到「真正发送之后」：
  // 之前是入队即记账 —— 会话忙时 decideWake 会拒绝，次数却已经记了、seen 也已经推进，
  // 于是那几条既不会重试（seen 已推进）又白白占掉名额。这是会丢消息的 bug。
  const wakeQueueKey = entry.id + '|' + fresh.map((item) => String(item.number) + '@' + String(item.updated_at || '')).join(',')
  wakeMerged(ctx, entry.sessionId, wakeText, (result) => {
    // 审核 T20：结算逻辑抽成纯函数 planWakeSettlement()（有单测），这里只负责落副作用。
    const settled = planWakeSettlement(entry, {
      ok: result.ok,
      reason: result.reason,
      fresh,
      firstSync,
      baseMs,
    })
    entry.lastWake = settled.lastWake
    entry.lastWakeCount = settled.lastWakeCount
    entry.lastBatch = settled.lastBatch
    entry.history = settled.history
    if (settled.error) setEntryError(entry, settled.error)
    if (settled.advanceWatermark) {
      entry.silentWakes = settled.silentWakes
      if (settled.ackedRecovered && entry.prevWakeAt) noteEvent(entry, 'acked', '上一次唤醒有回音（ack 出现过了）')
      entry.prevWakeAt = settled.prevWakeAt
      entry.wakeTimes = settled.wakeTimes
      entry.dailyWakes = settled.dailyWakes
      entry.lastDeferred = settled.lastDeferred
      entry.deferReason = settled.deferReason
      noteEvent(entry, settled.eventKind, settled.eventText)
      entry.seen = settled.seen
      entry.lastReported = settled.lastReported
      entry.cursor = settled.cursor
      // 「叫醒未回执」跟踪（Ticket 状态机的最小版）：提过的条目记下来，
      // 下一轮若仍开着且没 ack，会再提一次（有次数上限与冷却期，见 pendingRetry）。
      try {
        entry.pending = recordPendingWake(entry.pending, listed.map((item) => item.number))
      } catch { /* 记账失败不影响唤醒 */ }
      commitEtag()
    } else {
      // 保留水位，下一轮重试这次事件
      noteEvent(entry, 'wake-failed', entry.lastError)
      entry.deferReason = settled.deferReason
      if (settled.lastDeferred) entry.lastDeferred = settled.lastDeferred
      if (settled.bumpBackoff) bumpFailure(entry, baseMs)
    }    persistEntry(entry)
  }, wakeQueueKey, brand ? brand.brandName : undefined)
}

export function apply(ctx, options = {}) {
  // 品牌配置（issue #11）：options 是 cordis 按 Config 校验后的对象；
  // 直接调用（单测 / 老宿主）时由 resolveBrandConfig 兜住默认值。
  const brand = resolveBrandConfig(options)
  // 更新 runner 可注入：路由测试绝不发起真实安装；生产默认走 shell:false 的 CLI runner。
  const updateRunner = options.updateRunner || spawnPluginUpdate
  const updateTimeoutMs = options.updateTimeoutMs
  const readInstalledVersion = options.readInstalledVersion || installedVersion
  // 宿主升级（如 0.2.2-rc.1）时最可能变的不是我们的逻辑，而是服务名/形状。
  // 一条守挂了不该拖垮整个插件树：缺服务就只打一条日志，其余能力继续挂。
  if (!ctx || !ctx.tools || typeof ctx.tools.register !== 'function') {
    try { console.error('[session-superagent] 宿主没有提供 tools 服务：插件能力不可用，但不影响宿主') } catch {}
    return
  }
  const timers = sharedTimers
  // 一次性定时器（首轮错峰）：**每实例一份** —— teardown 只清自己的，不碰别人的（审核 W5）
  const bootTimers = new Map()


  // 并发闸的唯一事实源：tick 和 HTTP「立刻」拿到的是两个不同的 entry 对象，
  // 靠 entry.polling 标记永远对不上（审核专员 probe-c 实证：同一条被唤醒 3 次）。
  // 跨模块实例共享：旧实例还没跑完的那轮，新实例不能同时再跑一遍。
  const inFlight = sharedInFlight

  /** 后台查一次仓库权限：push=false 说明只能读，回写评论/标签都会 403。 */
  const probeAccess = async (entry) => {
    // Gitee 走 REST：`gh api repos/...` 对它必然 404，硬探会把「只读」误报成常态
    if (entry.provider === 'gitee') {
      try {
        const res = await giteeRepo({ repo: entry.repo, token: String(readSecrets().giteeToken || '') })
        if (!res.ok) return
        entry.repoAccess = mapGiteeRepoAccess(entry.repo, res.data || {})
        persistEntry(entry)
      } catch { /* 探测失败不影响主流程 */ }
      return
    }
    try {
      const res = await run('gh', ['api', 'repos/' + entry.repo, '--jq',
        '{push: .permissions.push, private: .private, fork: .fork, hasIssues: .has_issues, archived: .archived, disabled: .disabled, parent: (.parent.full_name // null)}'],
      { timeoutMs: 20000, env: ghEnv() })
      if (res.code !== 0) return
      const info = JSON.parse(res.stdout)
      entry.repoAccess = {
        repo: entry.repo,
        push: info.push === true,
        private: info.private === true,
        fork: info.fork === true,
        hasIssues: info.hasIssues !== false,
        archived: info.archived === true,
        disabled: info.disabled === true,
        parent: info.parent || null,
        checkedAt: new Date().toISOString(),
      }
      persistEntry(entry)
    } catch { /* 探测失败不影响主流程 */ }
  }

  const startWatcher = (entry) => {
    if (timers.has(entry.id)) return
    const every = Math.max(30, Number(entry.intervalSec) || 60) * 1000
    // 首轮错峰：多条守同间隔时不要整点一起发车（之后按 every 稳定推进，不累积漂移）
    const firstDelay = jitterMs(entry.id, Math.min(5000, every * 0.1))

    const tick = async () => {
      // A pause (or delete) can land between two ticks; never poll a watcher
      // the operator has just switched off.
      if (!isEnabled(entry)) return
      // 连续失败后的退避窗口：到点之前一律不碰 API
      if (entry.nextAt && Date.now() < Date.parse(entry.nextAt)) return
      // 同一个 watcher 不允许两轮并跑（手动「立刻」+ 定时器撞一起会开两个隔离区）
      if (inFlight.has(entry.id)) return
      inFlight.add(entry.id)
      try {
        await pollOnce(ctx, entry, every, brand)
        // GitHub 要求的间隔比我们的长：把下一轮推到它之后（成功路径也生效）
        const floor = (Number(entry.minIntervalSec) || 0) * 1000
        if (floor > every) entry.nextAt = new Date(Date.now() + floor).toISOString()
      } catch (error) {
        // 未预期的异常（比如宿主上下文/服务不可用）也必须退避：
        // 之前只写 lastError，于是坏掉的 watcher 会按 intervalSec 无限重试（真机踩到过）。
        setEntryError(entry, String((error && error.message) || error))
        bumpFailure(entry, every)
      } finally {
        inFlight.delete(entry.id)
        persistEntry(entry)
      }
    }
    // unref：宿主本来不会退出，但测试进程不该被这个定时器吊住
    timers.set(entry.id, setInterval(tick, every).unref?.())

    // DSH_SUPERAGENT_NO_POLL=1 只登记不轮询（路由层单测用，避免真去请求 GitHub）
    if (process.env.DSH_SUPERAGENT_NO_POLL === '1') return
    // 首轮按确定性抖动错峰（0~5 秒），之后按 every 稳定推进
    if (firstDelay > 0) {
      // 这个一次性定时器**也要能取消**：以前只 unref 不登记，stop 之后它还会 fire 一次
      // （审核 W1）—— 删掉/暂停的守会「诈尸」轮询一轮。
      const boot = setTimeout(() => { bootTimers.delete(entry.id); tick() }, firstDelay)
      boot.unref?.()
      bootTimers.set(entry.id, boot)
    } else {
      tick()
    }
  }

  // Must run before the entry leaves the state file: a live tick would
  // otherwise `persistEntry` the just-deleted watcher straight back.
  const stopWatcher = (id) => {
    // 首轮的错峰定时器也要取消，否则删掉的守还会 tick 一次（W1）
    const pending = bootTimers.get(id)
    if (pending) { clearTimeout(pending); bootTimers.delete(id) }
    const timer = timers.get(id)
    if (timer === undefined) return false
    clearInterval(timer)
    timers.delete(id)
    return true
  }

  /**
   * 版本检查：问 npm registry 最新版是多少，和本实例版本比。
   * GET 只读；POST 仅在 guardWrite 通过后复用这里的 latest 并交给受控更新 runner。
   * 10 分钟内存缓存，避免面板每次刷新都打 registry。
   */
  // /state 的体积预算：每守最多 6 条事件、全局最多 240 条（约 100 KB 内）
const STATE_EVENTS_PER_WATCHER = 6
const STATE_EVENTS_BUDGET = 240

const UPDATE_CACHE_MS = 10 * 60 * 1000
  let updateCache = null
  let updateCacheGeneration = 0
  // 非零退出、spawn_error 与 timeout 同样可能已经部分改盘。包装 runner 的 Promise，
  // 只有它真正 settle 才失效缓存并递增 generation；外层 504 时若仍 pending，这里不会执行。
  // validate/profile 等尚未调用 runner 的失败自然也不会碰到这段清理。
  const runUpdateAndInvalidateCache = async (request) => {
    try {
      return await updateRunner(request)
    } finally {
      updateCacheGeneration += 1
      updateCache = null
    }
  }
  // 审核 T19：强制刷新（?refresh=1）没有任何节流 —— 任意网页可以反复触发它去打 npm registry。
  // 60 秒内最多真查一次；其余走缓存（面板上的「刷新」按钮不受影响，人点不了这么快）。
  let lastForcedUpdateAt = 0
  const UPDATE_FORCE_MIN_MS = 60 * 1000
  const checkUpdate = async (force) => {
    const mayForce = force && Date.now() - lastForcedUpdateAt >= UPDATE_FORCE_MIN_MS
    if (mayForce) lastForcedUpdateAt = Date.now()
    if (!mayForce && updateCache && Date.now() - updateCache.at < UPDATE_CACHE_MS) return updateCache.value
    const generation = updateCacheGeneration
    const current = SERVER_VERSION
    const installed = readInstalledVersion()
    // 磁盘是否可更新只看 installedVersion；running/current 仅在安装版本不可用时兜底。
    const baseline = isStrictSemver(installed) ? installed : current
    const value = {
      current,
      runningVersion: current,
      installedVersion: installed,
      latest: null,
      publishedAt: null,
      hasUpdate: false,
      command: '',
      error: null,
    }
    // 离线开关：单测不该依赖 npm registry（一次网络抖动就会让整条门禁变红）
    if (process.env.DSH_SUPERAGENT_UPDATE_OFFLINE === '1') {
      value.command = 'dsh plugin --profile <你的 profile> add dsh-session-superagent@latest'
      if (generation === updateCacheGeneration) updateCache = { at: Date.now(), value }
      return value
    }
    try {
      const res = await fetch('https://registry.npmjs.org/' + encodeURIComponent('dsh-session-superagent') + '/latest', {
        signal: AbortSignal.timeout(5000),
        headers: { accept: 'application/json' },
      })
      if (!res.ok) throw new Error('HTTP ' + res.status)
      const body = await res.json()
      value.latest = typeof body.version === 'string' ? body.version : ''
      if (!isStrictSemver(value.latest)) throw new Error('npm registry 返回的 latest 不是严格 semver')
      const published = typeof body.dist?.tarball === 'string' ? body.dist.tarball : ''
      if (published) value.publishedAt = published
      value.hasUpdate = compareSemver(value.latest, baseline) === 1
      value.command = 'dsh plugin --profile <你的 profile> add dsh-session-superagent@' + (value.latest || 'latest')
    } catch (error) {
      value.error = String((error && error.message) || error).slice(0, 160)
    }
    if (generation === updateCacheGeneration) updateCache = { at: Date.now(), value }
    return value
  }

  /**
   * 门禁 provider 解析（G2）：宿主/第三方插件注入的 `ctx.get('gate')` 优先，
   * 缺失时回退到 `@mycf711/dsh-gate` 的 `createGate()`。这样门禁实现可以整体替换，
   * 而四条 /gates 路由的响应形状不变。
   */
  const resolveGate = (options) => {
    const injected = typeof ctx.get === 'function' ? ctx.get('gate') : undefined
    return injected || createGate(options)
  }

  // Read-only status endpoints for the web panel. `httpServer` is looked up
  // through ctx.inject: the service may load after this plugin, and ctx.get()
  // does not wait for it.
  const registerRoutes = (httpServer) => {
    if (!httpServer || typeof httpServer.register !== 'function') return
    for (const dispose of activeRoutes) { try { dispose() } catch {} }
    activeRoutes.length = 0
    // W5（旧实例晚到 dispose 会掐死新实例）**暂缓**：改成「只清自己的」会让 routes 注册路径整片挂掉，
    // 风险/收益不划算。先按原样全清 —— 等能拆得更小时再做。
    for (const handle of timers.values()) { try { clearInterval(handle) } catch {} }
    timers.clear()
    for (const handle of bootTimers.values()) { try { clearTimeout(handle) } catch { /* 已停 */ } }
    bootTimers.clear()
    const routes = []
    // 宿主热重载时旧实例的路由可能还没 dispose；一条重复会让整个 try 崩掉，
    // 面板和所有接口一起 404（2026-11-02 真机踩到 webserver: duplicate exact route）。
    // 改成每条路由单独容错：重复的那条记下来，其余照常注册。
    const failedRoutes = []
    const attempted = []
    const addRoute = (options) => {
      attempted.push(options)
      try {
        const dispose = httpServer['register'](options)
        routes.push(dispose)
        activeRoutes.push(dispose)
      } catch (error) {
        failedRoutes.push(String((error && error.message) || error).slice(0, 120))
      }
    }
    const record = (kind, detail) => {
      const state = readState()
      state.client = state.client || {}
      state.client[kind] = { at: new Date().toISOString(), detail }
      writeState(state)
    }
    try {
      addRoute({
        kind: 'exact',
        path: '/session-superagent/state',
        handler: async (req, res) => {
          if (req.method !== 'GET') { res.statusCode = 405; res.end('method not allowed'); return }
          const url = new URL(String(req.url || '/'), 'http://127.0.0.1')
          const focusSession = url.searchParams.get('sessionId') || ''
          const state = readState()
          // 审核 T37 M1：状态文件里只要有一个 `null` 值（手改、旧版写坏、半截写入），
          // `/state` 就会在 `w.id` 上抛 —— **整个面板全灭**。`watch_status` 早就有 filter(Boolean)，
          // 这里漏了同一个过滤。
          const allWatchers = Object.values(state.watchers || {}).filter(Boolean)
          // 只有 GitHub 守才需要 `gh`：全 Gitee 的客户看到「gh 未登录」是纯噪音，
          // 而且那两条探测每次都要 spawn 一个进程（面板 5 秒一刷）。
          const needsGh = allWatchers.some((w) => w && w.provider !== 'gitee')
          if (needsGh) tokenScopes().catch(() => {})
          const gh = needsGh ? await ghHealth() : { ok: null, skipped: '没有 GitHub 守' }
          // 全局预算：守越多，每守分到的事件条数越少（100 条守时每人 2 条，总量 ≤ 240）
          const perWatcherEvents = Math.max(1, Math.min(STATE_EVENTS_PER_WATCHER, Math.floor(STATE_EVENTS_BUDGET / Math.max(1, allWatchers.length))))
          const watchers = allWatchers.map((w) => ({
            id: w.id || (w.repo + '#' + w.sessionId),
            repo: w.repo,
            // 面板要能一眼分出 GitHub / Gitee：否则行内只能靠 id 前缀猜
            provider: w.provider === 'gitee' ? 'gitee' : 'github',
            ackLabel: w.ackLabel || defaultAckLabel(w.provider, brand.defaultAckLabels),
            // 会话忙时真正排在 FIFO 里的条数；0 表示没有排队，不靠猜 lastDeferred。
            queuedWakes: wakeQueueCount(w.sessionId, ctx),
            sessionId: w.sessionId,
            intervalSec: w.intervalSec,
            enabled: isEnabled(w),
            cursor: w.cursor ?? null,
            lastPoll: w.lastPoll ?? null,
            lastWake: w.lastWake ?? null,
            lastWakeCount: w.lastWakeCount ?? 0,
            lastAbsorbed: w.lastAbsorbed ?? 0,
            lastError: w.lastError ?? null,
            filters: w.filters ?? null,
            batchLimit: w.batchLimit ?? 5,
            maxWakesPerHour: w.maxWakesPerHour ?? DEFAULT_WAKES_PER_HOUR,
            sessionMaxWakes: w.sessionMaxWakes ?? 12,
            consecutiveFailures: w.consecutiveFailures ?? 0,
            nextAt: w.nextAt ?? null,
            lastDeferred: w.lastDeferred ?? null,
            observe: w.observe === true,
            // 审核 T37 M2：`?? []` 只挡 null/undefined —— 字段是数字时 `.slice` 不是函数，`/state` 直接 500。
            filteredLog: (Array.isArray(w.filteredLog) ? w.filteredLog : []).slice(-5),
            filterCounts: w.filterCounts ?? {},
            repoAccess: w.repoAccess ?? null,
            lastReopened: w.lastReopened ?? null,
            priority: w.priority ?? null,
            isolated: w.isolated === true,
            workdir: w.workdir ?? null,
            lastWorktree: w.lastWorktree ?? null,
            activeHours: w.activeHours ?? null,
            isolateKeepDays: w.isolateKeepDays ?? DEFAULT_ISOLATE_KEEP_DAYS,
            maxIsolated: w.maxIsolated ?? 5,
            history: (Array.isArray(w.history) ? w.history : []).slice(-5),
            // 唤醒质量（《为什么做这个产品》的三个成功指标）：没有这三个数，「不打断」只是信念
            quality: wakeQuality(w),
            events: (Array.isArray(w.events) ? w.events : []).slice(-perWatcherEvents),
            // 同一个仓库被别的会话也守着：客户该知道「还有谁在看」
            otherSessions: allWatchers.filter((peer) => peer && peer.repo === w.repo && peer.sessionId !== w.sessionId).map((peer) => peer.sessionId),
            // 分类放在服务端做一次：面板按 kind 给「下一步」按钮，不用自己解析中文
            lastErrorKind: w.lastError ? classifyGhError(String(w.lastError)).kind : null,
            lastErrorAt: w.lastErrorAt || null,
            needsReauth: w.needsReauth === true,
            deferReason: w.deferReason ?? null,
            daily: dailySummary(w.dailyWakes),
            busy: busierThanUsual(dailySummary(w.dailyWakes)),
            silentWakes: w.silentWakes ?? 0,
            note: w.goal ?? '',
            title: sessionTitle(w.sessionId),
          }))
          const stateBody = {
            gh,
            routeBase: activeBase,
            serverVersion: SERVER_VERSION,
            updatedAt: new Date().toISOString(),
            credentials: secretsSummary(),
            sessionGoal: goalView(ctx, focusSession),
            stateSource,
            // 会话级用量：上限够不够，客户应该一眼看到（数据都在状态里，零新增请求）
            sessionUsage: (() => {
              const list = Object.values(state.watchers || {})
              const usage = list.length === 0 ? null : sessionWakesLastHour(list, focusSession)
              const cap = list.length === 0 ? null : (Number(list[0].sessionMaxWakes) || 12)
              const capped = countCapped(list)
              if (usage === null) return null
              const suggest = suggestSessionCap({ used: usage, cap, capped })
              return { used: usage, cap, capped, suggest }
            })(),
            // 版本漂移：文件换了但宿主还在跑老模块（客户端热重载会掩盖这件事）
            installedVersion: installedVersion(),
            runningVersion: SERVER_VERSION,
            triageSignals: TRIAGE_SIGNALS,
            tokenScopes: scopesCache.value || null,
            isolation: isolationReport(Object.values(state.watchers || {})),
            sessionTitle: sessionTitle(focusSession),
            retryPolicy: { budgetAttempts: RETRY_BUDGET_ATTEMPTS, slowCapMinutes: RETRY_SLOW_CAP_MINUTES },
            defaults: { sessionMaxWakes: DEFAULT_SESSION_WAKES, maxWakesPerHour: DEFAULT_WAKES_PER_HOUR, isolateKeepDays: DEFAULT_ISOLATE_KEEP_DAYS, batchLimit: DEFAULT_BATCH_LIMIT },
            // issue #11：品牌与两家默认 ack 标签由服务端下发 —— 客户端不再各自写死「主理鱼」。
            // 放在 stateBody 里就自动进了 ETag 的稳定字段：配置变了，下一次轮询一定不是 304。
            brandName: brand.brandName,
            defaultAckLabels: brand.defaultAckLabels,
            watchers: watchers.map((w) => ({ ...w, goal: goalView(ctx, w.sessionId) })),
          }
          // ETag/304：面板每 5 秒拉一次 /state，没变化时没必要重传整份 JSON ——
          // 和我们自己对 GitHub 做的事一样，只是方向反过来（这次我们是服务端）。
          // 依据：RFC 9110 §15.4.5 规定 304 不带正文，客户端沿用本地缓存。
          const payload = JSON.stringify(stateBody)
          // 注意：updatedAt 每次都变，把它排除在指纹之外，否则 ETag 永远不命中
          const stable = JSON.stringify({ ...stateBody, updatedAt: undefined })
          const etag = '"' + createHash('sha1').update(stable).digest('hex').slice(0, 16) + '"'
          res.setHeader('etag', etag)
          // 测试里的假 req 可能没有 headers，别因此崩
          const inm = String((req.headers && req.headers['if-none-match']) || '')
          if (inm && inm.split(',').map((v) => v.trim()).includes(etag)) {
            res.statusCode = 304
            res.end()
            return
          }
          res.statusCode = 200
          res.setHeader('content-type', 'application/json; charset=utf-8')
          res.setHeader('cache-control', 'no-store')
          res.end(payload)
        },
      })
      addRoute({
        kind: 'exact',
        path: '/session-superagent/client-note',
        handler: (req, res) => {
          const url = new URL(String(req.url || '/'), 'http://127.0.0.1')
          const key = String(url.searchParams.get('key') || '')
          // 只接受已知探针键：否则任何网页用一个 <img> 就能往状态文件里塞任意键
          if (CLIENT_NOTE_KEYS.has(key)) {
            record('note:' + key, String(url.searchParams.get('value') || '').slice(0, 300))
          }
          res.statusCode = 204; res.end()
        },
      })
      addRoute({
        kind: 'exact',
        path: '/session-superagent/client-error',
        handler: (req, res) => { record('error', String(req.url).slice(0, 400)); res.statusCode = 204; res.end() },
      })
      // 审核 T19：64KB 以前只是「读完再截断」—— 48MB 的请求体会先把 RSS 从 105MB 顶到 333MB。
      // 现在边读边算，超了立刻 destroy 并返回 413。
      const MAX_BODY_BYTES = 64 * 1024
      const INVALID_JSON_BODY = Symbol('invalid-json-body')
      const INVALID_JSON_BODY_TEXT = '请求体必须是合法 JSON 对象'
      const readBody = (req, res, strict = false) => new Promise((resolve) => {
        const chunks = []
        let bytes = 0
        let aborted = false
        req.on('data', (chunk) => {
          if (aborted) return
          bytes += chunk.length
          if (bytes > MAX_BODY_BYTES) {
            aborted = true
            try { res.statusCode = 413; res.setHeader('content-type', 'application/json; charset=utf-8'); res.end(JSON.stringify({ error: 'request body too large' })) } catch { /* 尽力而为 */ }
            try { req.destroy() } catch { /* 尽力而为 */ }
            resolve(null)
            return
          }
          chunks.push(chunk)
        })
        req.on('end', () => {
          if (aborted) return
          try {
            // 按字符边界截断：直接 subarray 会切开汉字，剩下的半截被 decodeBody 当成 GBK 整段重解（T16）
            const raw = decodeBody(truncateUtf8(Buffer.concat(chunks), 64 * 1024))
            const parsed = JSON.parse(raw || '{}')
            if (strict && (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))) {
              resolve(INVALID_JSON_BODY)
              return
            }
            resolve(parsed)
          } catch { resolve(strict ? INVALID_JSON_BODY : {}) }
        })
        req.on('error', () => resolve(strict ? INVALID_JSON_BODY : {}))
      })
      const json = (res, code, body) => {
        res.statusCode = code
        res.setHeader('content-type', 'application/json; charset=utf-8')
        res.setHeader('cache-control', 'no-store')
        res.end(JSON.stringify(body))
      }

      /**
       * 写操作的来源校验（审核 T19）。
       *
       * 宿主只绑 127.0.0.1，但**浏览器里的任意网页**都能往 localhost 发请求：
       * `text/plain` 是「简单请求」，不触发预检，而 CORS 只挡跨站**读**响应、不挡副作用。
       * 实测：跨站 POST `{action:'delete'}` 就能删守、清凭证、改活会话目标。
       *
       * 两道闸（任一不过就 403）：
       * 1. `Content-Type` 必须是 `application/json` —— 这就要求预检，浏览器会先问 OPTIONS；
       * 2. 带了 `Origin` 就必须是**本机**（127.0.0.1 / localhost / [::1]）。
       * 非浏览器客户端（curl / 测试）不带 Origin，只受第 1 条约束。
       */
      const allowedOrigin = (origin) => {
        if (!origin) return true // 非浏览器（curl、同源 GET）
        try {
          const url = new URL(origin)
          return url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '[::1]' || url.hostname === '::1'
        } catch {
          return false
        }
      }
      const guardWrite = (req, res) => {
        // 只查 Origin：浏览器跨站 POST **一定**带它（简单请求也一样），而 curl / 测试不带。
        // 不要求 content-type —— 那会把 curl 之类的合法用法一起挡掉，收益还一样。
        const origin = req.headers.origin || req.headers.referer
        if (!allowedOrigin(origin)) {
          json(res, 403, { error: 'cross-origin request refused' })
          return false
        }
        return true
      }

      // Create or update a watcher from the panel. The panel is session-scoped,
      // so it must send the session id it is bound to.
      addRoute({
        kind: 'exact',
        path: '/session-superagent/watch',
        handler: async (req, res) => {
          if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' })
          if (!guardWrite(req, res)) return // 来源不对：已回 403
          const body = await readBody(req, res)
          if (!body) return // 已回 413
          // pause / resume / delete target an existing watcher by id; the
          // create path below is the default when no action is supplied.
          if (body.action) {
            const action = String(body.action)
            const id = String(body.id || '')
            const state = readState()
            // 立刻跑一次（对应 Claude Code Action 的 interactive 模式）：
            // 不等定时器，马上轮询一次；仍然受 filters / ack 标签约束。
            if (action === 'poll') {
              const entry = state.watchers && state.watchers[id]
              if (!entry) return json(res, 404, { error: '没有这条主理鱼（' + id + '）—— 刷新面板看看它还在不在；可能是别的窗口刚删掉', code: 'unknown_watcher' })
              if (!isEnabled(entry)) return json(res, 409, { error: '这条主理鱼是暂停状态，先点「恢复」再试', code: 'paused' })
              if (inFlight.has(id)) return json(res, 409, { error: '上一轮轮询还没结束（网络慢或 GitHub 慢）—— 等十几秒再看', code: 'in_flight', id })
              const every = Math.max(30, Number(entry.intervalSec) || 60) * 1000
              inFlight.add(id)
              pollOnce(ctx, entry, every, brand)
                .catch(() => {})
                .finally(() => { inFlight.delete(id); persistEntry(entry) })
              return json(res, 202, { ok: true, action, id, polling: true })
            }
            const result = applyWatcherAction(state, { action, id })
            if (!result.ok) return json(res, 400, result)
            if (result.deleted) {
              // 立墓碑：否则一个持有旧快照的写入会把这条又"复活"
              state.deleted = { ...(state.deleted || {}), [id]: new Date().toISOString() }
            }
            if (result.deleted || !isEnabled(result)) stopWatcher(id)
            writeState(state)
            // 只有「显式启用」才重启轮询：result 可能是部分字段，缺 enabled 时不该把守拉起来
            if ((result.enabled === true || String(result.enabled) === 'true') && state.watchers[id]) startWatcher(state.watchers[id])
            return json(res, 200, result)
          }
          // 认三种写法：`owner/name` / `gitee:owner/name` / `https://gitee.com/owner/name`。
          // 客户是从浏览器地址栏复制的，让他手动删前缀是没必要的摩擦。
          const spec = parseRepoSpec(body.repo)
          if (!spec.ok) return json(res, 400, { error: spec.error })
          const repo = spec.repo
          const provider = spec.provider
          const sessionId = String(body.sessionId || '').trim()
          // 审核 T19：sessionId 以前无上限、无字符集校验 —— 它会进 id、落进状态文件、拼进唤醒消息。
          if (sessionId.length > 200) return json(res, 400, { error: 'sessionId too long (max 200)' })
          if (!sessionId) return json(res, 400, { error: 'sessionId is required (open the panel in the session that should be woken)' })
          // 若这个实例的 ctx 已经 dispose（宿主重载后旧 handler 仍在服务请求），
          // 建出来的 watcher 一定跑不起来（定时器一 tick 就 inactive context）。
          // 与其静默造一条死守，不如直接拒绝并让用户重载宿主。
          const agentsHere = agentsService(ctx)
          const canReachSessions = agentsHere && typeof agentsHere.get === 'function'
          if (!canReachSessions) {
            json(res, 503, { ok: false, error: '插件实例已失效（当前 handler 跑在已释放的上下文里）：请重载 DSH 后再添加' })
            return
          }
          // 与 watch_start 同口径：先取整再夹取。否则面板存 30.7、工具存 31，同一设置两种结果。
          const intervalSec = Math.max(30, Math.min(3600, Math.round(Number(body.intervalSec) || 60)))
          const state = readState()
          state.watchers = state.watchers || {}
          // id 里带 provider：同一个 owner/name 在两家可能都存在，混在一起会互相覆盖
          const id = (provider === 'gitee' ? 'gitee:' : '') + repo + '#' + sessionId
          const created = !(state.watchers && state.watchers[id])
          // 审核 T19：新建没有任何上限 —— 100 次 POST 就是 100 条守（每条一个定时器）。
          // 工具路径早就有 MAX_WATCHERS_PER_SESSION，HTTP 路径漏了；这里再补一个全局上限。
          if (created) {
            // 审核 T40 M1：这里以前把**已暂停**的守也算进上限 —— 而工具侧只数在跑的。
            // 结果：20 条全停之后，面板回 429「最多挂 20 条」（且不给路），模型却能建。
            // 同一会话两个入口给出相反答案。0.9.233 在工具路径上修过同一个死结，这条路漏了。
            const mine = Object.values(state.watchers).filter((w) => w && w.sessionId === sessionId && w.enabled !== false)
            if (mine.length >= MAX_WATCHERS_PER_SESSION) {
              return json(res, 429, { error: '一条会话最多同时挂 ' + MAX_WATCHERS_PER_SESSION + ' 条在跑的守（现在 ' + mine.length + ' 条）—— 先暂停或删除不用的' })
            }
            if (Object.keys(state.watchers).length >= MAX_WATCHERS_TOTAL) {
              return json(res, 429, { error: '全局最多 ' + MAX_WATCHERS_TOTAL + ' 条守' })
            }
          }
          const entry = state.watchers[id] || {
            id, repo, provider, sessionId, cursor: null, seen: {}, lastReported: {},
            cooldownMs: 180000, createdAt: new Date().toISOString(),
            filters: normalizeFilters(), batchLimit: 5, maxWakesPerHour: 6,
            wakeTimes: [], consecutiveFailures: 0, ackLabel: defaultAckLabel(provider, brand.defaultAckLabels),
            isolated: false, workdir: null,
          }
          entry.provider = provider
          entry.intervalSec = intervalSec
          // 只有真正带了 goal 才覆盖：GUI 编辑保存不带这个字段，覆盖会清空
          if (typeof body.goal === 'string') entry.goal = body.goal.slice(0, 500)
          // 竞品蒸馏：触发要有许可（label/指派/跳过机器人草稿）、单次别铺开太多、每小时有上限
          entry.filters = mergeFilters(entry.filters, body.filters)
          entry.batchLimit = Math.max(1, Math.min(20, Number(body.batchLimit) || entry.batchLimit || 5))
          entry.maxWakesPerHour = Math.max(1, Math.min(60, Number(body.maxWakesPerHour) || entry.maxWakesPerHour || 6))
          if (body.sessionMaxWakes != null) entry.sessionMaxWakes = Math.max(1, Math.min(60, Number(body.sessionMaxWakes) || DEFAULT_SESSION_WAKES))
          if (typeof body.ackLabel === 'string' && body.ackLabel.trim()) entry.ackLabel = body.ackLabel.trim().slice(0, 60)
          // 优先级开关：客户可以关掉某几类"加权"，只按 updated 顺序处理
          if (body.priority && typeof body.priority === 'object') {
            entry.priority = {
              reopened: body.priority.reopened !== false,
              comments: body.priority.comments !== false,
              labels: body.priority.labels !== false,
              // 默认关：没有官方依据支持"无人认领更紧急"
              unassigned: body.priority.unassigned === true,
              stale: body.priority.stale === true,
            }
          }
          // 隔离执行（对标 DeepSeek DSec）：每次唤醒开一次性 worktree，改副本不碰主工作区
          entry.observe = body.observe === undefined ? entry.observe === true : body.observe === true
          entry.isolated = body.isolated === undefined ? entry.isolated === true : body.isolated === true
          if (body.isolateKeepDays != null) entry.isolateKeepDays = Math.max(1, Math.min(30, Number(body.isolateKeepDays) || 3))
          // 同时最多留几个隔离区（越界回收最旧的）—— 1~50
          if (body.maxIsolated != null) entry.maxIsolated = Math.max(1, Math.min(50, Number(body.maxIsolated) || 5))
          if (typeof body.activeHours === 'string') {
            // 审核 T40：工具路径 0.9.235 就拒绝了非法格式，HTTP 路径却一直**原样收下** ——
            // 于是面板填 `9-23` 会静默变成「全天有效」，而回执还打着 [activeHours=9-23]。
            const hoursCheck = validateActiveHours(body.activeHours)
            if (!hoursCheck.ok) return json(res, 400, { error: hoursCheck.reason })
            entry.activeHours = hoursCheck.normalized || null
          }
          if (typeof body.workdir === 'string' && body.workdir.trim()) {
            const workdir = body.workdir.trim()
            if (!isAbsolute(workdir)) return json(res, 400, { error: 'workdir must be an absolute path' })
            if (!existsSync(workdir)) return json(res, 400, { error: 'workdir does not exist: ' + workdir })
            entry.workdir = workdir
          }
          else if (entry.isolated && !entry.workdir) entry.workdir = process.cwd()
          entry.consecutiveFailures = 0
          entry.nextAt = null
          // 没传 enabled 就保持原值：只改间隔/标签不该把暂停的 watcher 悄悄恢复
          entry.enabled = body.enabled === undefined ? isEnabled(entry) : isEnabled({ enabled: body.enabled })
          // 暂停/恢复时清掉「上一次的错误」：暂停后不再轮询，旧错误会一直挂在面板上变成假异常
          if (body.enabled === false || body.enabled === true) {
            entry.lastError = null
            entry.deferReason = null
            entry.lastDeferred = null
            entry.consecutiveFailures = 0
            entry.nextAt = null
          }
          // 只有**新建**时才做添加前体检：编辑已有守不该再打一次网络
          // `created` 的语义就是「新建」；这里原来写成 `!created && !state.watchers[id]`，
          // 两项互为否定 → 永远 false → 下面的添加前体检从来没跑过（T1 审计发现）。
          const isNew = created
          let warnings = []
          if (isNew) {
            const pre = await precheckRepo(repo, provider)
            warnings = pre.warnings || []
            if (pre.access) entry.repoAccess = pre.access
          }
          state.watchers[id] = entry
          writeState(state)
          // 编辑已有 watcher 时，间隔/配置变化要立刻生效：startWatcher 会因为 timer 已存在而直接返回
          if (entry.enabled) {
            stopWatcher(id)
            probeAccess(entry).catch(() => {})

            startWatcher(entry)
          }
          json(res, 200, { ok: true, id, repo, intervalSec, enabled: entry.enabled, warnings })
        },
      })

      // Credentials typed by the operator. Stored 0600 under the state dir and
      // never echoed back; the answer carries only a masked summary.
      addRoute({
        kind: 'exact',
        path: '/session-superagent/credentials',
        handler: async (req, res) => {
          if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' })
          if (!guardWrite(req, res)) return // 来源不对：已回 403
          const body = await readBody(req, res)
          if (!body) return // 已回 413
          const next = readSecrets()
          if (typeof body.token === 'string') {
            const token = body.token.trim()
            if (token === '') delete next.token
            else if (!/^(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})$/.test(token)) {
              return json(res, 400, { error: 'token shape not recognized (ghp_… or github_pat_…)' })
            } else next.token = token
          }
          if (typeof body.sshKeyPath === 'string') {
            const keyPath = body.sshKeyPath.trim()
            if (keyPath === '') delete next.sshKeyPath
            else if (!isAbsolute(keyPath)) return json(res, 400, { error: 'sshKeyPath must be absolute' })
            else next.sshKeyPath = keyPath
          }
          // 「用哪个 gh 账号」：指向只登录了智能体账号的配置目录；空串 = 回到宿主当前账号。
          // 只收绝对路径：相对路径会随 cwd 漂移，把设置指向一个不存在的地方。
          // Gitee 私人令牌：和 GitHub token 分开存（两家互不通用）
          if (typeof body.giteeToken === 'string') {
            const gt = body.giteeToken.trim()
            if (gt === '') delete next.giteeToken
            // 审核 T19：Gitee 令牌以前不校验形状 —— 任意字符串都会存进去并被当成凭证用。
            // Gitee 私人令牌是 **32 位十六进制**（真机形状）；不像就拒绝，别把垃圾存成凭证。
            else if (!/^[0-9a-f]{32}$/i.test(gt)) return json(res, 400, { error: 'Gitee 令牌应为 32 位十六进制' })
            else next.giteeToken = gt
          }
          if (typeof body.ghConfigDir === 'string') {
            const dir = body.ghConfigDir.trim()
            if (dir === '') delete next.ghConfigDir
            else if (!isAbsolute(dir)) return json(res, 400, { error: 'ghConfigDir must be absolute' })
            else next.ghConfigDir = dir
          }
          next.updatedAt = new Date().toISOString()
          writeSecrets(next)
          json(res, 200, { credentials: secretsSummary() })
        },
      })

      // 客户报障用：把「版本 / 挂载状态 / 每条守的最近错误」拼成一段可直接粘贴的文本。
      // 客户在别的电脑上，我们看不到他的状态文件 —— 让他一键复制这段就够了。
      addRoute({
        kind: 'exact',
        path: '/session-superagent/diagnose',
        handler: (req, res) => {
          if (req.method !== 'GET') return json(res, 405, { error: 'method not allowed' })
          const state = readState()
          const mounted = state.server || {}
          const lines = []
          lines.push('主理鱼诊断 · ' + new Date().toISOString())
          lines.push('插件版本: ' + SERVER_VERSION)
          lines.push('宿主: DSH / node ' + String(process.version || ''))
          lines.push('凭证保护: ' + (secretsHardened === 'unknown' ? '未写入过 token' : secretsHardened))
          lines.push('挂载: routes=' + String(mounted.routes ?? '?')
            + ' failed=' + String((mounted.failed || []).length)
            + ' base=' + String(mounted.base || '-')
            + ' at=' + String(mounted.at || '-'))
          if ((mounted.failed || []).length > 0) lines.push('挂载失败: ' + mounted.failed.join('; '))
          // 审核 T37 M1：同 `/state` —— 一个 null 值就会让整份诊断抛异常。
          const entries = Object.values(state.watchers || {}).filter(Boolean)
          lines.push('值守: ' + entries.length + ' 条')
          for (const entry of entries) {
            lines.push('- ' + entry.repo
              + ' | ' + (isEnabled(entry) ? '启用' : '已暂停')
              + ' | 间隔 ' + entry.intervalSec + 's'
              + ' | 会话 ' + String(entry.sessionId || '').slice(0, 20)
              + ' | 上次轮询 ' + String(entry.lastPoll || '-')
              + ' | 失败 ' + (entry.consecutiveFailures || 0)
              // 审核 T33 M5：`slice(0,160)` 会把现象之后的**建议整段切掉** ——
              // 而项目约定（KB error-must-have-next-step）要求「建议必须完整」。
              // 现在现象截 120，括号里的下一步**完整保留**（最多再兜 200 字）。
              + (entry.lastError ? ' | 错误: ' + (() => {
                const full = String(entry.lastError)
                const cut = full.indexOf('（')
                if (cut < 0) return full.slice(0, 160)
                const main = full.slice(0, cut).slice(0, 120)
                const hint = full.slice(cut).slice(0, 200)
                return main + hint
              })() : ''))
          }
          const text = redact(lines.join(String.fromCharCode(10)))
          json(res, 200, { ok: true, text })
        },
      })

      // 单条追溯：面板点「追溯」时来问。只回传结论与明细，不回传 seen/lastReported 这类大字段。
      addRoute({
        kind: 'exact',
        path: '/session-superagent/trace',
        handler: async (req, res) => {
          if (req.method !== 'GET') return json(res, 405, { error: 'method not allowed' })
          const url = new URL(String(req.url || '/'), 'http://127.0.0.1')
          const repo = url.searchParams.get('repo') || ''
          const number = url.searchParams.get('number') || ''
          const state = readState()
          const list = Object.values(state.watchers || {}).filter((entry) => !repo || entry.repo === repo)
          const traces = list.map((entry) => itemTrace(entry, number)).filter((trace) => trace
            && Boolean(trace.seen || trace.reported || trace.filtered.length || trace.wakes.length))
          const text = traces.length > 0
            ? formatTraceText(traces)
            : noTraceText(number, repo ? ' ' + repo : '所有守')
          // text 给模型与旧客户端；traces 给面板渲染结构化时间线（官方 Thread 详情的最小吸收）。
          json(res, 200, { ok: true, text, traces })
        },
      })

      // 门禁配置：默认 / 用户全局 / 项目 / 本地覆盖。只读 GET 不需要写权限。
      addRoute({
        kind: 'exact',
        path: '/session-superagent/gates',
        handler: async (req, res) => {
          if (req.method === 'GET') {
            const url = new URL(String(req.url || '/'), 'http://127.0.0.1')
            const repo = url.searchParams.get('repo') || process.cwd()
            const loaded = loadGateConfig({ repo })
            const scopes = {}
            for (const scope of ['default', 'user', 'project', 'local']) {
              const value = readGateScope(scope, { repo })
              scopes[scope] = { path: value.path, exists: Boolean(value.config), config: value.config }
            }
            return json(res, 200, { ok: true, repo, sources: loaded.sources, config: loaded.config, scopes })
          }
          if (req.method !== 'POST') {
            res.setHeader('Allow', 'GET, POST')
            return json(res, 405, { error: 'method not allowed' })
          }
          if (!guardWrite(req, res)) return
          const body = await readBody(req, res, true)
          if (body === null) return
          if (body === INVALID_JSON_BODY) return json(res, 400, { ok: false, code: 'invalid_body', error: INVALID_JSON_BODY_TEXT })
          const scope = String(body.scope || '')
          const checked = validateConfig(body.config)
          if (!checked.ok) return json(res, 400, { ok: false, code: 'invalid_config', error: checked.error })
          try {
            const saved = writeGateConfig(scope, checked.config, { repo: body.repo || process.cwd() })
            return json(res, 200, { ok: true, scope, path: saved.path, config: saved.config })
          } catch (error) {
            return json(res, 400, { ok: false, code: 'save_failed', error: String(error?.message || error) })
          }
        },
      })

      // 预览：先跑确定性门禁；语义复审只在 release / merge 且显式开启时调用。
      addRoute({
        kind: 'exact',
        path: '/session-superagent/gates/preview',
        handler: async (req, res) => {
          if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' })
          if (!guardWrite(req, res)) return
          const body = await readBody(req, res, true)
          if (body === null) return
          if (body === INVALID_JSON_BODY) return json(res, 400, { ok: false, code: 'invalid_body', error: INVALID_JSON_BODY_TEXT })
          const repo = body.repo || process.cwd()
          const text = String(body.body || '')
          const trigger = String(body.trigger || 'issue.reply')
          // 确定性门禁永远先跑：硬门禁已经不过时，不再白花一次模型调用。
          const loaded = loadGateConfig({ repo })
          const first = lintText(text, loaded.config, { trigger, current: body.current })
          if (!first.ok || body.semantic !== true) return json(res, 200, { ok: first.ok, trigger, hits: first.hits, semantic: { skipped: true } })
          // 语义复审走 GateProvider：ctx.get('gate') 优先，缺失时回退 createGate()。
          const gate = resolveGate({ config: loaded.config })
          const checked = await gate.check({ trigger, text, current: body.current, repo })
          // 确定性命中已经在 first 里；这里只补 provider 多出来的（语义复审）命中，
          // 避免同一份规则跑两遍后重复展示。
          const extra = (checked.hits || []).filter((hit) => !first.hits.some((known) => known.id === hit.id
            && known.severity === hit.severity && known.message === hit.message))
          const semantic = checked.semantic || { skipped: true }
          return json(res, 200, {
            ok: first.ok && checked.ok !== false,
            trigger,
            hits: [...first.hits, ...extra],
            semantic,
          })
        },
      })

      // 提示词润色：没有显式模型时用配置里的默认模型。
      addRoute({
        kind: 'exact',
        path: '/session-superagent/gates/optimize',
        handler: async (req, res) => {
          if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' })
          if (!guardWrite(req, res)) return
          const body = await readBody(req, res, true)
          if (body === null) return
          if (body === INVALID_JSON_BODY) return json(res, 400, { ok: false, code: 'invalid_body', error: INVALID_JSON_BODY_TEXT })
          const loaded = loadGateConfig({ repo: body.repo || process.cwd() })
          const semantic = loaded.config.semantic || {}
          try {
            const text = await optimizePrompt(String(body.prompt || semantic.prompt || ''), {
              baseURL: body.baseURL || semantic.baseURL,
              model: body.model || semantic.model,
            })
            return json(res, 200, { ok: true, text })
          } catch (error) {
            return json(res, 502, { ok: false, error: '提示词润色失败：' + String(error?.message || error) })
          }
        },
      })

      addRoute({
        kind: 'exact',
        path: '/session-superagent/gates/models',
        handler: async (req, res) => {
          if (req.method !== 'GET') return json(res, 405, { error: 'method not allowed' })
          const url = new URL(String(req.url || '/'), 'http://127.0.0.1')
          const loaded = loadGateConfig({ repo: url.searchParams.get('repo') || process.cwd() })
          const semantic = loaded.config.semantic || {}
          try {
            const models = await listModels({ baseURL: url.searchParams.get('baseURL') || semantic.baseURL })
            return json(res, 200, { ok: true, models })
          } catch (error) {
            return json(res, 200, { ok: false, models: [], error: String(error?.message || error) })
          }
        },
      })

      // GET 保持只读版本检查；POST 走同一套写来源守卫，执行固定 argv 的插件更新。
      addRoute({
        kind: 'exact',
        path: '/session-superagent/update',
        handler: async (req, res) => {
          if (req.method === 'GET') {
            const url = new URL(String(req.url || '/'), 'http://127.0.0.1')
            const value = await checkUpdate(url.searchParams.get('refresh') === '1')
            return json(res, 200, value)
          }
          if (req.method !== 'POST') {
            res.setHeader('Allow', 'GET, POST')
            return json(res, 405, { error: 'method not allowed' })
          }
          if (!guardWrite(req, res)) return
          const body = await readBody(req, res, true)
          if (body === null) return // 已回 413
          if (body === INVALID_JSON_BODY) return json(res, 400, { ok: false, code: 'invalid_body', error: INVALID_JSON_BODY_TEXT })
          const selected = validateUpdateBody(body)
          if (!selected.ok) return json(res, 400, selected)

          const versionState = () => {
            const installed = readInstalledVersion()
            return {
              installedVersion: installed,
              runningVersion: SERVER_VERSION,
              needsReload: installed !== null && installed !== SERVER_VERSION,
            }
          }
          let version = selected.version
          if (version === undefined) {
            const checked = await checkUpdate(false)
            if (!isStrictSemver(checked.latest)) {
              return json(res, 503, {
                ...versionState(),
                ok: false,
                code: 'latest_unavailable',
                error: '没有取得严格 semver 的 latest 版本，本次没有执行更新' + (checked.error ? '：' + redact(String(checked.error)) : ''),
              })
            }
            version = checked.latest
            const before = versionState()
            const installedBaseline = isStrictSemver(before.installedVersion) ? before.installedVersion : SERVER_VERSION
            if (compareSemver(version, installedBaseline) === -1) {
              return json(res, 409, {
                ...before,
                ok: false,
                code: 'downgrade_requires_explicit_version',
                version,
                error: 'npm latest ' + version + ' 低于当前安装基线 ' + installedBaseline + '，本次没有静默降级；如确需降级，请显式指定 version',
              })
            }
          }

          const result = await runExclusiveUpdate({ version, runner: runUpdateAndInvalidateCache, timeoutMs: updateTimeoutMs })
          const state = versionState()
          const common = {
            ...state,
            // 成功安装了别的版本时，即使测试替身没有改磁盘，也必须提示运行中代码尚未切换。
            needsReload: state.needsReload || (result.ok === true && version !== SERVER_VERSION),
            version,
            profile: result.profile || null,
            stdout: redact(String(result.stdout || '')),
            stderr: redact(String(result.stderr || '')),
            stdoutTruncated: result.stdoutTruncated === true,
            stderrTruncated: result.stderrTruncated === true,
          }
          if (result.ok === true && result.code === 0) {
            return json(res, 200, {
              ...common,
              ok: true,
              code: 0,
              exitCode: 0,
              message: 'DSH CLI 更新命令已以退出码 0 结束；运行中代码仍为 ' + SERVER_VERSION + '，needsReload 表示是否还需重载后才能使用新版本',
            })
          }
          const code = result.code || 'update_failed'
          const status = code === 'update_in_flight' ? 409
            : code === 'timeout' ? 504
              : ['cli_not_found', 'cli_unsupported', 'profile_unavailable', 'invalid_profile'].includes(code) ? 503
                : 500
          const error = result.error || (typeof code === 'number'
            ? 'DSH CLI 更新命令以非零退出码 ' + code + ' 结束，未确认安装成功'
            : '插件更新失败，未确认安装成功')
          // normalizeFailure 已脱敏一次；runner 直接 resolve 的 error 不经过它，路由出口必须再守一次。
          return json(res, status, { ...common, ok: false, code, exitCode: typeof code === 'number' ? code : null, error: redact(String(error)) })
        },
      })

      // Set / edit / clear the session's REAL goal through ctx.goals — the same
      // service the /goal command drives, so the panel and the conversation are
      // one source of truth (polling reads it back).
      addRoute({
        kind: 'exact',
        path: '/session-superagent/goal',
        handler: async (req, res) => {
          if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' })
          if (!guardWrite(req, res)) return // 来源不对：已回 403
          const body = await readBody(req, res)
          if (!body) return // 已回 413
          const sessionId = String(body.sessionId || '').trim()
          // 审核 T19：sessionId 以前无上限、无字符集校验 —— 它会进 id、落进状态文件、拼进唤醒消息。
          if (sessionId.length > 200) return json(res, 400, { error: 'sessionId too long (max 200)' })
          const objective = String(body.objective || '').trim()
          if (!sessionId) return json(res, 400, { error: 'sessionId is required' })
          const goals = typeof ctx.get === 'function' ? ctx.get('goals') : undefined
          const agents = typeof ctx.get === 'function' ? ctx.get('agents') : undefined
          if (!goals || !agents) return json(res, 501, { error: 'this host has no goal service' })
          const agent = agents.get(sessionId)
          if (!agent) return json(res, 404, { error: 'session is not live' })
          try {
            const current = goals.get(agent)
            if (objective === '') {
              if (!current) return json(res, 200, { ok: true, cleared: false, sessionGoal: null })
              goals.clear(agent, current.ref)
              return json(res, 200, { ok: true, cleared: true, sessionGoal: null })
            }
            const view = current
              ? goals.edit(agent, current.ref, { objective })
              : goals.create(agent, { objective })
            return json(res, 200, {
              ok: true,
              sessionGoal: { objective: view.objective, phase: view.phase, revision: view.ref ? view.ref.revision : null },
            })
          } catch (error) {
            return json(res, 400, { error: String((error && error.message) || error) })
          }
        },
      })

      // 热重载时旧实例的 handler 摘不掉（宿主路由表行为）：默认前缀会全部撞车。
      // 那就换一个带序号的前缀整组重放 —— 面板会自己发现新前缀（客户端 discoverBase）。
      if (failedRoutes.length > 0) {
        const generation = (Number(globalThis[ROUTE_GEN_KEY]) || 1) + 1
        globalThis[ROUTE_GEN_KEY] = generation
        const altBase = DEFAULT_ROUTE_BASE + '/r' + generation
        const replay = attempted.map((options) => ({ ...options, path: String(options.path).replace(DEFAULT_ROUTE_BASE, altBase) }))
        failedRoutes.length = 0
        for (const options of replay) addRoute(options)
        if (failedRoutes.length === 0) {
          activeBase = altBase
          record('route-base', altBase)
        }
      }
      const state = readState()
      state.server = { at: new Date().toISOString(), routes: routes.length, failed: failedRoutes, base: activeBase, startedAt: new Date(PROCESS_STARTED_AT).toISOString() }
      writeState(state)
    } catch (error) {
      const state = readState()
      state.server = { at: new Date().toISOString(), routes: routes.length, failed: failedRoutes, error: String((error && error.message) || error).slice(0, 300), startedAt: new Date(PROCESS_STARTED_AT).toISOString() }
      writeState(state)
    }
    const teardown = () => {
      for (const dispose of routes) { try { dispose() } catch {} }
      routes.length = 0
      activeRoutes.length = 0
      // 插件卸载/热重载后旧定时器不能继续跑：它们还持有已 dispose 的 ctx
      for (const handle of timers.values()) { try { clearInterval(handle) } catch {} }
      timers.clear()
      clearWakeQueues(ctx)
      try { clearInterval(sweepHandle) } catch {}
    }
    // 两条路都挂上：ctx.effect 的清理函数在 effect 作用域销毁时一定被调用；
    // ctx.on('dispose') 覆盖宿主走事件广播的卸载方式。真机踩过「路由没 dispose →
    // 重载后重复路由 → 六条接口全灭」，多挂一条成本很低。
    try { ctx.effect(() => teardown) } catch {}
    ctx.on('dispose', teardown)
  }

  // Routes for the panel. `webServer` is the host's route registry (the same
  // service dsh-unlag injects); it is a required inject so this plugin simply
  // does not mount on a host that has no web surface, instead of silently
  // offering a panel that cannot read anything.
  try {
    registerRoutes(ctx.webServer)
  } catch (error) {
    const state = readState()
    state.server = { at: new Date().toISOString(), error: String((error && error.message) || error).slice(0, 300) }
    writeState(state)
  }

  // Manual test channel: {text, sessionId?} in trigger.json wakes that session
  // on the next 5 s sweep, then removes the file. Verifies the inbox path
  // without a host restart.
  const sweepTrigger = () => {
    // 测试通道：默认关闭。开着等于给本机任意进程一个「以用户口吻注入任意文本」的入口。
    if (process.env.DSH_SUPERAGENT_TRIGGER !== '1') return
    if (!existsSync(triggerFile())) return
    let payload = {}
    try { payload = JSON.parse(readFileSync(triggerFile(), 'utf8')) } catch {}
    try { unlinkSync(triggerFile()) } catch {}
    const state = readState()
    const any = Object.values(state.watchers || {}).find((w) => w && w.enabled)
    const sessionId = payload.sessionId || (any && any.sessionId)
    if (!sessionId) return
    const result = wake(ctx, sessionId, payload.text || '【watch】ping')
    state.lastTrigger = { at: new Date().toISOString(), ok: result.ok, reason: result.reason ?? null, sessionId }
    writeState(state)
  }
  const sweepHandle = setInterval(sweepTrigger, 5000)
  sweepHandle.unref?.()

  try {
    const state = readState()
    for (const entry of Object.values(state.watchers || {})) {
      if (entry && entry.enabled) startWatcher(entry)
    }
  } catch {}

  ctx.tools.register(defineTool({
    name: 'watch_ack',
    description:
      'Mark an issue/PR as handled: adds the ack label (' + brand.defaultAckLabels.github + ' by default on GitHub, '
        + brand.defaultAckLabels.gitee + ' on Gitee) and advances the local watermark, so the same item will never wake this session again — even after a restart or on another machine.',
    parameters: {
      repo: { type: 'string', description: 'owner/name; defaults to the only watched repo' },
      // 审核 T32 M4：实现里这两个必填其一（缺了直接报错），schema 却没标。
      number: { type: ['number', 'string'], description: 'issue or PR number（Gitee 的编号是字符串，如 IKSQJH）' },
      numbers: { type: 'string', description: '逗号分隔的多个编号，如 "12,13,14"（number 与 numbers 至少填一个）' },
      label: { type: 'string', description: 'ack label, default ' + brand.defaultAckLabels.github + ' on GitHub / ' + brand.defaultAckLabels.gitee + ' on Gitee' },
      note: { type: 'string', description: '可选：一句话记下这条最后怎么处理的（如「已修，见 #57」「不修，上游已修」）。下次这条再被叫醒时会带回来，省得会话重新判一遍。' },
      comment: { type: 'boolean', description: '把 note 作为评论回写到原 issue/PR（默认 false）。必须同时给 note；这是显式写操作。' },
      kind: { type: 'string', description: "Gitee 评论回写时的条目类型：'issue'（默认）或 'pull'；GitHub 不需要。" },
      format: { type: 'string', description: "'text' (default) or 'json'." },
    },
    async execute(args) {
      // 编号允许两种：GitHub 是数字（14），Gitee 的 issue 是字符串（IKSQJH）。
      // 以前一律 Number()，Gitee 那边会被过滤成空数组，报「number is required」—— 看着像用户没填。
      const numbers = String(args.numbers || args.number || '')
        .split(',')
        .map((v) => v.trim())
        .filter((v) => /^[A-Za-z0-9_-]+$/.test(v))
      if (numbers.length === 0) {
        // 审核 T33 M1：同上 —— 给了 `#14` 却报「必填」，是假话。
        const given = String(args.numbers || args.number || '').trim()
        return toolError(args, given
          ? '编号要写成 14 或 12,13，不要带 # 号（收到的是「' + given + '」）—— 去掉 # 再试一次'
          : 'number (or numbers) is required（例如 14，或 12,13）')
      }
      const state = readState()
      const watchers = Object.values(state.watchers || {})
      const entry = args.repo
        ? watchers.find((w) => w && w.repo === String(args.repo))
        : watchers.find((w) => w && w.enabled)
      if (!entry) return toolError(args, 'no watcher for that repo — start one with watch_start first')
      const label = String(args.label || entry.ackLabel || defaultAckLabel(entry.provider, brand.defaultAckLabels))
      const note = typeof args.note === 'string' ? args.note.trim().slice(0, 200) : ''
      if (args.comment === true && !note) return toolError(args, 'comment:true 需要同时提供 note —— 不会发一条空评论')
      // GitHub 不会因为加标签而自动建标签：不存在时返回 422。先幂等建一次（已存在也返回 422，忽略）。
      // Gitee 没有「建标签」的独立端点（标签必须先存在），所以这边只打标签；
      // 标签不存在时它会 404 —— 让调用方看到真实原因，别假装成功。
      if (entry.provider !== 'gitee') {
        await run('gh', ['api', '-X', 'POST', `repos/${entry.repo}/labels`, '-f', `name=${label}`, '-f', 'color=ededed'], { env: ghEnv() })
      }
      const results = []
      let failed = null
      let labelNote = ''
      // Gitee 打标签前要先确保标签存在（它不会像 GitHub 那样自动建）
      if (entry.provider === 'gitee') {
        const ensured = await ensureGiteeLabel({ repo: entry.repo, token: String(readSecrets().giteeToken || ''), label })
        if (ensured.ok) labelNote = ensured.created ? '（已自动新建标签「' + label + '」）' : ''
        else labelNote = '（标签「' + label + '」建不出来：' + String(ensured.error || ensured.status || '').slice(0, 80) + '）'
      }
      for (const number of numbers) {
        const res = entry.provider === 'gitee'
          ? await (async () => {
            const r = await addGiteeLabel({ repo: entry.repo, token: String(readSecrets().giteeToken || ''), number, label })
            return { code: r.ok ? 0 : 1, stdout: '', stderr: r.ok ? '' : String(r.status || '') + ' ' + String(r.error || '') }
          })()
          : await run('gh', ['api', '-X', 'POST', `repos/${entry.repo}/issues/${number}/labels`, '-f', `labels[]=${label}`], { env: ghEnv() })
        if (res.code !== 0) {
          failed = { number, text: redact([res.stdout, res.stderr].filter(Boolean).join(' ').trim()).slice(0, 200), phase: 'label' }
          break
        }
        // Delivery（官方原型可吸收的一部分）：处理结论不只留在本地，显式 comment:true 时回写原条目。
        if (args.comment === true) {
          const posted = entry.provider === 'gitee'
            ? await (async () => {
              const r = await addGiteeComment({ repo: entry.repo, token: String(readSecrets().giteeToken || ''), number, body: note, kind: args.kind === 'pull' ? 'pull' : 'issue' })
              return { code: r.ok ? 0 : 1, stdout: '', stderr: r.ok ? '' : String(r.status || '') + ' ' + String(r.error || '') }
            })()
            : await run('gh', ['api', '-X', 'POST', `repos/${entry.repo}/issues/${number}/comments`, '-f', `body=${note}`], { env: ghEnv() })
          if (posted.code !== 0) {
            failed = { number, text: redact([posted.stdout, posted.stderr].filter(Boolean).join(' ').trim()).slice(0, 200), phase: 'comment' }
            break
          }
        }
        results.push(number)
      }
      if (failed) {
        // 失败要分两类：会自动恢复的（网络/限流/网关）和必须人动手的（登录/权限/编号）
        let why = classifyGhError(failed.text)
        // Gitee 的 404 有一个特例：仓库存在、**标签不存在**也是 404。
        // 不点破的话客户会去查仓库，而真正要做的是「先去 Gitee 建这个标签」。
        if (entry.provider === 'gitee' && why.kind === 'notfound') {
          why = { ...why, hint: '（Gitee 的 ack 标签必须先存在：先去仓库的「标签」页建好「' + label + '」，再 ack 一次）' }
        }
        const retryable = ['network', 'ratelimit', 'gateway'].includes(why.kind)
        // 文案不重复：可恢复的只说要等，不可恢复的只说要做什么（避免两句同义话叠在一起）
        const LABELS = { network: '网络抖动', ratelimit: '被 GitHub 限流', gateway: 'GitHub 或代理故障', auth: 'gh 登录失效', notfound: '仓库或编号不存在', nogh: '找不到 gh 命令', other: '未归类的错误' }
        const label = LABELS[why.kind] || LABELS.other
        const advice = retryable ? '暂时失败，稍后再 ack 一次即可' : '需要你处理'
        if (args && args.format === 'json') {
          return JSON.stringify({
            schemaVersion: 1, ok: false, repo: entry.repo, acked: results,
            failed: { number: failed.number, text: failed.text, kind: why.kind, retryable, advice, phase: failed.phase || 'label' },
          })
        }
        const phaseNote = failed.phase === 'comment' ? '（标签已打，评论回写失败）' : ''
        return retryable
          ? `[error: #${failed.number} ${advice}（${label}）]${phaseNote}`
          : `[error: #${failed.number} ${advice}] ${why.hint}${phaseNote}`
      }
      const latest = readState()
      const live = latest.watchers && latest.watchers[entry.id]
      const nowIso = new Date().toISOString()
      if (live) {
        live.seen = advanceSeen(live.seen, results.map((number) => ({ number, updated_at: nowIso })))
        // 打标签本身就是一次外部更新，把光标推到当下，避免自己把自己叫醒
        live.cursor = nowIso
        live.lastAcked = { numbers: results, label, at: nowIso }
        // 回执到了，这条路走通了 —— 不用再提
        live.pending = clearPending(live.pending, results)
        // 「叫醒之后」的闭环（见 docs/为什么做这个产品.md 诉求 2）：
        // 以前只记「叫醒过」，不记「怎么处理的」—— 同一条被重开时会话只能重新判一遍。
        // 有界：只留最近 20 条，超出丢最旧的。
        if (note) {
          const acked = { ...(live.acked || {}) }
          for (const number of results) acked[String(number)] = { at: nowIso, note }
          const keep = Object.entries(acked).sort((a, b) => String(b[1].at).localeCompare(String(a[1].at))).slice(0, 20)
          live.acked = Object.fromEntries(keep)
        }
        writeState(latest)
      }
      if (args && args.format === 'json') {
        // labelNote 是「标签是新建的还是本来就有的」——JSON 分支以前把它丢了，消费方只能猜
        return JSON.stringify({ schemaVersion: 1, ok: true, repo: entry.repo, label, acked: results, at: nowIso, labelNote: labelNote || null, ...(args.comment === true ? { commented: true } : {}) })
      }
        return `acked ${entry.repo} #${results.join(' #')} with label "${label}"` + labelNote
          + (typeof args.note === 'string' && args.note.trim() ? '｜记下了：' + args.note.trim().slice(0, 200) : '')
          + (args.comment === true ? '｜已回写评论' : '')
    },
  }))

  // 单条追溯：agent 被问"这条为什么没叫醒我"时不用猜，直接查
  ctx.tools.register(defineTool({
    name: 'watch_trace',
    description:
      'Explain what happened to one issue/PR: whether it was filtered (and why), absorbed by the cooldown, already reported, or never seen. Read-only — changes nothing. Use it when the customer asks "why did this not wake me".',
    parameters: {
      repo: { type: 'string', description: 'owner/name; defaults to the only watched repo' },
      // Gitee 的 issue 编号是字符串（IKSQJH），写成 number 会被宿主直接拒掉
      // 审核 T32 M4：实现里它是必填（缺了直接报错），schema 却没标 —— 模型只能靠调一次失败才知道
      number: { type: ['number', 'string'], required: true, description: 'issue or PR number to trace' },
      format: { type: 'string', description: "'text' (default) or 'json'." },
    },
    async execute(args) {
      const state = readState()
      const all = Object.values(state.watchers || {})
      const wanted = typeof args.repo === 'string' && args.repo.trim() ? args.repo.trim() : null
      const list = wanted ? all.filter((entry) => entry && entry.repo === wanted) : all
      if (list.length === 0) {
        const message = 'no watcher for that repo — ' + (wanted ? 'nothing is watching ' + wanted : 'run watch_status to see what is watched')
        // format=json 时错误也要是 JSON：消费方不该在两种格式间猜
        return (args && args.format === 'json') ? JSON.stringify({ schemaVersion: 1, error: message }) : '[error: ' + message + ']'
      }
      // 编号可能是数字（GitHub 的 14）也可能是字符串（Gitee 的 IKSQJH）：
      // 统一转成字符串再比 —— 以前这里 Number('IKSQJH') = NaN，Gitee 的条目永远查不到。
      const rawNumber = args.number == null ? '' : String(args.number).trim()
      if (!/^[A-Za-z0-9_-]+$/.test(rawNumber)) {
        // 审核 T33 M1：编号**给了**就别说「没给」—— `#14` 是从 issue 页面直接复制的形状。
        // 说「没给」会让模型原样再传一次，拿到同一句报错，然后死循环或转头问客户。
        const why = rawNumber
          ? '编号要写成 14，不要带 # 号（收到的是「' + rawNumber + '」）—— 去掉 # 再试一次'
          : 'number is required（例如 14；Gitee 的编号是 IKSQJH 这种字符串）'
        return toolError(args, why)
      }
      const number = rawNumber
      const traces = list.map((entry) => itemTrace(entry, number)).filter((trace) => trace
        && Boolean(trace.seen || trace.reported || trace.filtered.length || trace.wakes.length))
      if (args && args.format === 'json') {
        return JSON.stringify({ schemaVersion: 1, number: String(number), results: traces }, null, 2)
      }
      if (traces.length === 0) {
        return noTraceText(number, wanted ? ' ' + wanted : '所有守')
      }
      return formatTraceText(traces)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'watch_doctor',
    description:
      'Self-check the watchers: gh login, repo access, ack label existence, isolation workdir. Prints a checklist. It does not change any watcher config, but it does write one temporary probe file inside the isolation workdir (and deletes it immediately) to prove the directory is writable.',
    parameters: {
      repo: { type: 'string', description: 'only check this owner/name; default = every watcher' },
      format: { type: 'string', description: "'text' (default) or 'json'." },
    },
    async execute(args) {
      const lines = []
      const state = readState()
      const all = Object.values(state.watchers || {})
      const wanted = args.repo ? all.filter((w) => w && w.repo === String(args.repo)) : all

      // -3. 凭证失效：不会自愈，必须人去登录
      {
        const needAuth = wanted.filter((w) => w.needsReauth === true)
        if (needAuth.length > 0) {
          lines.push('FAIL 凭证失效（' + needAuth.length + ' 条守）：跑 gh auth login 重新登录，'
            + '在此之前这些守只会一直失败 —— 它不会自己恢复')
        }
      }
      // -2. 状态来源：从备份或损坏里恢复过，客户有权知道（否则他会纳闷「我的守怎么少了一条」）
      if (stateSource === 'backup') {
        lines.push('WARN 状态文件坏过一次，已从备份恢复（原文件留在 .corrupt-* 里，可人工检查）')
      } else if (stateSource === 'corrupt') {
        lines.push('FAIL 状态文件和备份都读不了 —— 已从空状态开始，原文件留在 .corrupt-*；请重新添加守')
      }
      // -1. 版本一致性：文件换了但没重启时，服务端仍然跑老代码（客户端热重载会掩盖这件事）
      const installed = installedVersion()
      if (installed && installed !== SERVER_VERSION) {
        lines.push(`WARN 代码已更新但未生效：磁盘 ${installed} / 正在运行 ${SERVER_VERSION} —— 需要重启宿主（不是重装）`)
      } else if (installed) {
        lines.push(`OK 版本一致：${SERVER_VERSION}`)
      }

      // 0. 挂载状态：面板/HTTP 靠路由，路由注册失败时工具仍然可用 —— 这种「半死」状态
      //    光看工具是发现不了的（2026-11-02 真机踩过：duplicate exact route 让六条接口全灭）
      if (state.server) {
        const routeCount = Number(state.server.routes)
        const hasRouteCount = state.server.routes !== undefined && state.server.routes !== null && state.server.routes !== ''
          && Number.isInteger(routeCount) && routeCount >= 0
        const mounted = hasRouteCount ? routeCount : null
        const failed = Array.isArray(state.server.failed) ? state.server.failed : []
        if (state.server.error) {
          lines.push(`FAIL 面板接口挂载：${state.server.error}（工具仍可用，但面板会空白；重载一次即可）`)
        } else if (failed.length > 0) {
          // routes 是成功的 disposer 数，failed 是实际注册失败数；总数来自这次挂载，不写死。
          const total = mounted === null ? null : mounted + failed.length
          lines.push(total === null
            ? `WARN 面板接口部分失败（成功/总数未知）：${failed.join('；')}`
            : `WARN 面板接口部分失败（${mounted}/${total} 成功）：${failed.join('；')}`)
        } else if (mounted === null) {
          lines.push('WARN 面板接口挂载：路由数未知（旧版本没有记录 routes）')
        } else {
          lines.push(`OK   面板接口挂载：${mounted} 条，无失败`)
        }
      } else {
        lines.push('WARN 还没有挂载记录（刚装上或从未加载过路由）')
      }

      // 1. gh 是否登录（只有 GitHub 守才需要它；全 Gitee 的客户看到 FAIL 是假故障）
      const hasGithub = all.some((w) => w && w.provider !== 'gitee')
      if (!hasGithub) {
        lines.push('INFO 没有 GitHub 守：跳过 gh 登录检查（Gitee 那条走令牌，见上面）')
      } else {
        const auth = await run('gh', ['auth', 'status'], { env: ghEnv() })
        const authed = auth.code === 0
        lines.push(`${authed ? 'OK  ' : 'FAIL'} gh 登录：${auth.code === 0 ? '正常' : redact([auth.stderr, auth.stdout].join(' ')).slice(0, 120)}`)
      }

      if (wanted.length === 0) {
        lines.push('INFO 当前没有任何 watcher —— 先 watch_start 或到面板加一条')
        if (args && args.format === 'json') {
          const checks = lines.map((line) => {
            const m = /^(OK|WARN|FAIL|INFO)\s*(.*)$/.exec(line)
            return { status: m ? m[1].toLowerCase() : 'info', text: (m ? m[2] : line).trim() }
          })
          return JSON.stringify({ schemaVersion: 1, checks }, null, 2)
        }
        return lines.join('\n')
      }

      for (const entry of wanted) {
        const isGitee = entry.provider === 'gitee'
        // 2. 仓库可访问（Gitee 走 REST，不走 gh）
        if (isGitee) {
          const token = String(readSecrets().giteeToken || '')
          const repoRes = await giteeRepo({ repo: entry.repo, token })
          if (repoRes.ok) {
            lines.push('OK   gitee:' + entry.repo + ' 可访问')
          } else {
            const status = Number(repoRes.status) || 0
            const why = status === 401 || status === 403 ? 'Gitee token 无效或没权限（在设置里填私人令牌）'
              : status === 404 ? 'Gitee 仓库不存在，或 token 看不到这个私有仓库'
                : '连不上 Gitee（' + String(repoRes.error || '').slice(0, 80) + '）'
            lines.push('FAIL gitee:' + entry.repo + ' 不可访问：' + why)
          }
          if (!token) lines.push('WARN 没有配置 Gitee token：公开仓库能读，私有仓库读不到，也打不了 ack 标签')
          lines.push('INFO Gitee 没有 ETag 条件请求，所以这条守每轮都会真的读一次列表（注意额度）')
        } else {
          const repoRes = await run('gh', ['api', `repos/${entry.repo}`, '--jq', '.full_name'], { env: ghEnv() })
          if (repoRes.code === 0) {
            lines.push(`OK   ${entry.repo} 可访问：${repoRes.stdout.trim()}`)
          } else {
            // 仓库改名/转移在 GH 上是 301，客户看到的却只是「一直没动静」
            const why = classifyGhError([repoRes.stderr, repoRes.stdout].join(' '))
            lines.push(`FAIL ${entry.repo} 不可访问：${why.hint}`)
          }

          // 2b. gh 账号配置目录：设了但目录不可读 / 没登录时，客户看到的只是「一直失败」
          {
          const dir = readSecrets().ghConfigDir
          if (!dir) {
            lines.push('OK   gh 账号：使用宿主当前登录的账号（未绑定独立配置目录）')
          } else if (!existsSync(dir)) {
            lines.push('FAIL gh 账号：绑定的配置目录不存在（检查设置里的路径）')
          } else if (!existsSync(join(dir, 'hosts.yml'))) {
            lines.push('FAIL gh 账号：配置目录里没有 hosts.yml（该目录还没登录过：先在那个目录下跑 gh auth login）')
          } else {
            lines.push('OK   gh 账号：已绑定独立配置目录（hosts.yml 存在）')
          }
          }
        }
        // 3. ack 标签是否存在（两家都要看：Gitee 不会自动建标签，更要说清楚）
        const label = entry.ackLabel || defaultAckLabel(entry.provider, brand.defaultAckLabels)
        if (isGitee) {
          // Gitee 的标签必须先存在（watch_ack 会先查再建，但建不出来时要能看出是哪一步）——
          // 以前这里只写一句规则，等于没检查。现在真的去查一次。
          const labRes = await giteeLabels({ repo: entry.repo, token: String(readSecrets().giteeToken || '') })
          if (!labRes.ok) {
            const status = Number(labRes.status) || 0
            lines.push(`WARN ack 标签「${label}」：查不到（HTTP ${status || '?'}）——`
              + (status === 401 || status === 403 ? 'Gitee token 无效或没权限' : '连不上 Gitee，稍后再试'))
          } else if (giteeHasLabel(labRes.data, label)) {
            lines.push(`OK   ack 标签「${label}」：已存在`)
          } else {
            lines.push(`WARN ack 标签「${label}」：不存在 —— 第一次 watch_ack 会自动建（建不出来时看它的报错）`)
          }
        } else {
          const labRes = await run('gh', ['api', `repos/${entry.repo}/labels/${encodeURIComponent(label)}`, '--jq', '.name'], { env: ghEnv() })
          lines.push(`${labRes.code === 0 ? 'OK  ' : 'WARN'} ack 标签「${label}」：${labRes.code === 0 ? '已存在' : '不存在（首次 watch_ack 会自动创建）'}`)
        }

        // 4. 隔离工作目录
        if (entry.isolated) {
          const wd = entry.workdir
          if (!wd) lines.push('WARN 隔离开着但没有 workdir，会在宿主 cwd 里建 worktree')
          else if (!existsSync(wd)) lines.push(`FAIL 隔离工作目录不存在：${wd}`)
          else {
            const gitRes = await run('git', ['-C', wd, 'rev-parse', '--is-inside-work-tree'], { timeoutMs: 15000 })
            lines.push(`${gitRes.code === 0 ? 'OK  ' : 'FAIL'} 隔离工作目录 ${wd}：${gitRes.code === 0 ? '是 git 仓库' : '不是 git 仓库'}`)
            // 目录在但不可写时，第一次唤醒建 worktree 就会失败（真机上更常见的是权限/磁盘）
            // 审核 T32：这里确实会**写一个探针文件**（再立刻删）。
            // 以前描述写「Read-only」，客户和模型都以为它完全不碰磁盘 —— 已改成如实描述。
            const probe = join(wd, '.dsh-doctor-probe')
            try {
              writeFileSync(probe, String(Date.now()))
              rmSync(probe, { force: true })
              lines.push(`OK   隔离工作目录可写（写过一个临时探针并已删除）`)
            } catch (error) {
              lines.push(`FAIL 隔离工作目录不可写：${wd}（${String((error && error.code) || error).slice(0, 40)}）`)
            }
          }
        }

        // 5. 轮询停滞：定时器丢了或进程被挂起时，面板上一切「正常」，其实早就不看了
        if (isEnabled(entry) && entry.lastPoll) {
          const intervalMs = (Number(entry.intervalSec) || 60) * 1000
          const staleMs = Math.max(intervalMs * 3, 5 * 60 * 1000)
          const age = Date.now() - Date.parse(entry.lastPoll)
          const uptimeMs = state.server && state.server.startedAt ? Date.now() - Date.parse(state.server.startedAt) : Infinity
          // 刚重启时 uptime 还不够一个停滞周期：陈旧只是「还没轮到」，不是故障
          if (Number.isFinite(age) && age > staleMs && uptimeMs > staleMs) {
            lines.push(`WARN ${entry.repo} 已经 ${Math.round(age / 60000)} 分钟没轮询过（预期每 ${Math.round(intervalMs / 1000)} 秒）—— 定时器可能丢了`)
          } else if (Number.isFinite(age) && age > staleMs) {
            lines.push(`INFO ${entry.repo} 上次轮询是 ${Math.round(age / 60000)} 分钟前，但进程才启动 ${Math.round(uptimeMs / 60000)} 分钟 —— 刚重启，等下一轮即可`)
          }
          // 连续失败很多次时间隔已被拉长（retry budget）：要解释清楚，别让人以为又卡住了
          if (Number(entry.consecutiveFailures) >= 6) {
            lines.push(`INFO ${entry.repo} 已连续失败 ${entry.consecutiveFailures} 次，重试间隔已放慢到最多每 ${RETRY_SLOW_CAP_MINUTES / 60} 小时一次`)
          }
        }

        // 6. 最近一次状态
        // 审核 M4：lastError 里可能原样带着 Gitee 返回的请求/令牌 —— 工具结果会进模型上下文，先脱敏
        const last = entry.lastError ? `错误：${redact(entry.lastError)}` : entry.lastDeferred ? `等待：${redact(entry.lastDeferred)}` : '正常'
        lines.push(`INFO ${isEnabled(entry) ? '运行中' : '已暂停'} · 上次轮询 ${entry.lastPoll || '无'} · ${last}`)
      }
      // format=json 时从同一份文本行解析出结构 —— 单一来源，不会出现两套逻辑走偏
      if (args && args.format === 'json') {
        const checks = lines.map((line) => {
          const m = /^(OK|WARN|FAIL|INFO)\s*(.*)$/.exec(line)
          return { status: m ? m[1].toLowerCase() : 'info', text: (m ? m[2] : line).trim() }
        })
        return JSON.stringify({ schemaVersion: 1, checks }, null, 2)
      }
      return lines.join('\n')
    },
  }))

  ctx.tools.register(defineTool({
    name: 'github',
    description: 'Call the GitHub REST API. The credential stays inside the plugin — it is never returned, and every result is redacted. Write methods require confirm: true.',
    parameters: {
      method: { type: 'string', description: 'HTTP method, default GET.' },
      path: { type: 'string', required: true, description: 'API path after https://api.github.com/, e.g. repos/o/r/issues.' },
      body: { type: 'string', description: 'JSON body for write methods.' },
      confirm: { type: 'boolean', description: 'Must be true for POST/PATCH/PUT/DELETE.' },
    },
    async execute(args) {
      const method = String(args.method || 'GET').toUpperCase()
      if (String(args.path || '').trim().startsWith('-')) {
        return '[error: path must be a GitHub API path, not a flag]'
      }
      if (!['GET', 'HEAD', 'POST', 'PATCH', 'PUT', 'DELETE'].includes(method)) {
        return `[error: unsupported method ${method}]`
      }
      const write = ['GET', 'HEAD'].indexOf(method) === -1
      if (write && args.confirm !== true) {
        return `[error: ${method} requires confirm: true — this plugin never writes to GitHub without an explicit flag]`
      }
      const res = await run('gh', ['api', '-X', method, args.path, '--header', 'Accept: application/vnd.github+json'], {
        input: write && args.body ? args.body : undefined, env: ghEnv(),
      })
      const text = redact([res.stdout, res.stderr].filter(Boolean).join(String.fromCharCode(10)).trim())
      // 失败要带「下一步」：只贴 gh 的原始报错，调用方还得自己猜
      return formatGhCall({ code: res.code, text, classify: classifyGhError })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'repo_here',
    description: 'Report the GitHub repository of the current working directory (owner/name, default branch, visibility). Read-only.',
    parameters: {},
    async execute() {
      const res = await run('gh', ['repo', 'view', '--json', 'nameWithOwner,defaultBranchRef,visibility,url'], { cwd: process.cwd(), env: ghEnv() })
      const text = redact([res.stdout, res.stderr].filter(Boolean).join(String.fromCharCode(10)).trim())
      // 与 github 工具同一套：失败带分类与下一步，而不是只贴原始 stderr
      return formatGhCall({ code: res.code, text, classify: classifyGhError })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'watch_start',
    description: 'Watch a repository and wake THIS session when its issues or pull requests change. Works with GitHub (owner/name) and Gitee (prefix with gitee:, e.g. gitee:owner/name; a gitee.com URL also works). Pass several repos in one call separated by spaces or commas to create several watchers at once. Idempotent per (repo, session). Default interval 60 s, minimum 30 s.',
    parameters: {
      repo: { type: 'string', description: 'owner/name (GitHub) 或 gitee:owner/name（Gitee）；多个用空格或逗号分隔。Omit to infer from the current working directory.' },
      intervalSec: { type: 'number', description: 'Polling interval in seconds, clamped to 30-3600, default 60.' },
      labels: { type: 'array', items: { type: 'string' }, description: 'Only handle items carrying one of these labels (whitelist).' },
      ignoreLabels: { type: 'array', items: { type: 'string' }, description: 'Skip items carrying any of these labels.' },
      onlyAssigned: { type: 'boolean', description: 'Only handle items assigned to someone (or to `assignee`).' },
      assignee: { type: 'string', description: 'With onlyAssigned: require this login.' },
      allowAuthors: { type: 'array', items: { type: 'string' }, description: '只要这些人提的（GitHub 登录名，可带 @）。空 = 谁都算。用来挡掉别人随手提的 issue。' },
      observe: { type: 'boolean', description: 'Observe only: record what WOULD be woken, never wake.' },
      isolated: { type: 'boolean', description: 'Run each wake in a throwaway git worktree.' },
      workdir: { type: 'string', description: 'Repository used for isolation worktrees (absolute path).' },
      activeHours: { type: 'string', description: 'Wake only inside this window, e.g. "09:00-23:00" (supports overnight).' },
      resume: { type: 'boolean', description: 'Only when the watcher is paused: resume it (default true). Pass false to change config while keeping it paused.' },
      format: { type: 'string', description: "'text' (default) or 'json'." },
      batchLimit: { type: 'number', description: 'Max items listed per wake (1-20, default 5).' },
      maxWakesPerHour: { type: 'number', description: 'Max wakes per hour per watcher (1-60, default 6).' },
      sessionMaxWakes: { type: 'number', description: 'Max wakes per hour for the whole session, summed across watchers (1-60, default 12).' },
      isolateKeepDays: { type: 'number', description: 'With isolated: remove isolation worktrees older than this many days (1-30, default 3).' },
      maxIsolated: { type: 'number', description: 'With isolated: keep at most this many worktrees, oldest removed first (1-50, default 5).' },
      goal: { type: 'string', description: 'Optional per-watcher goal appended to the wake message.' },
      ackLabel: { type: 'string', description: 'Label used as the handled marker (default ' + brand.defaultAckLabels.github + ' on GitHub / ' + brand.defaultAckLabels.gitee + ' on Gitee). Two sessions watching the same repo share it unless each sets its own.' },
      priority: { type: 'object', description: 'Priority switches; only explicitly supplied keys are changed. Boolean keys: reopened, comments, labels, unassigned, stale. Defaults: reopened/comments/labels=true; unassigned/stale=false. additionalProperties are unrestricted.' },
    },
    async execute(args) {
      const toolAgents = agentsService(ctx)
      const agent = toolAgents && typeof toolAgents.currentInitiator === 'function' ? toolAgents.currentInitiator() : undefined
      const sessionId = agent && agent.id
      if (!sessionId) return toolError(args, 'no live session — watch_start must be called from a session turn')

      let repo = args.repo
      if (!repo) {
        const res = await run('gh', ['repo', 'view', '--json', 'nameWithOwner'], { cwd: process.cwd(), env: ghEnv() })
        try { repo = JSON.parse(res.stdout).nameWithOwner } catch { return `[error: cannot infer repo]\n${redact(res.stderr)}` }
      }

      // 一次可以加多个仓库：客户三个仓库不用点三次（逗号/空格/换行都认）
      // 同一个写法解析器给面板和工具共用：`gitee:owner/name` / gitee.com URL 都要能认，
      // 否则工具建出来的守没有 provider，Gitee 仓库会被当 GitHub 轮询，每轮 404。
      const parsedSpecs = String(repo).split(/[,\s]+/).map((item) => item.trim()).filter(Boolean).map((item) => ({ item, spec: parseRepoSpec(item) }))
      const bad = parsedSpecs.filter(({ spec }) => !spec.ok).map(({ item }) => item)
      if (bad.length > 0) {
        // 审核 T33 M4：以前坏值里可能混进 `undefined`（推断失败时），客户看到「这些不对：undefined」。
        const shown = bad.map((v) => (v === undefined || v === null || String(v).trim() === '' ? '（空）' : String(v))).join(', ')
        return toolError(args, '仓库要写成 owner/name 或 gitee:owner/name，这些不对：' + shown)
      }
      if (parsedSpecs.length === 0) return toolError(args, '至少给一个仓库（owner/name）')
      const repoList = parsedSpecs.map(({ item, spec }) => ({ repo: spec.repo, provider: spec.provider, label: item }))
      const applyOne = async ({ repo, provider }) => {
      const id = (provider === 'gitee' ? 'gitee:' : '') + `${repo}#${sessionId}`
      const state = readState()
      const existing = state.watchers && state.watchers[id]
      const entry = existing || {
        id, repo, provider, sessionId,
        intervalSec: 60,
        cooldownMs: DEFAULT_COOLDOWN_MS,
        ackLabel: defaultAckLabel(provider, brand.defaultAckLabels),
        priority: { ...DEFAULT_TOOL_PRIORITY },
        cursor: null,
        seen: {},
        lastReported: {},
        enabled: true,
        createdAt: new Date().toISOString(),
      }
      if (typeof args.intervalSec === 'number' && args.intervalSec > 0) {
        // 之前只判断 >0，能把 5 秒存进状态文件（调度时会按 30 秒跑，但状态与实际不一致）
        entry.intervalSec = Math.max(30, Math.min(3600, Math.round(args.intervalSec)))
      }
      const patch = {}
      if (args.labels !== undefined) patch.labels = args.labels
      if (args.ignoreLabels !== undefined) patch.ignoreLabels = args.ignoreLabels
      if (args.onlyAssigned !== undefined) patch.onlyAssigned = args.onlyAssigned
      if (args.assignee !== undefined) patch.assignee = args.assignee
      // 谁提的才算：参考官方原型的 Policy（谁来派活）。空数组 = 谁都算。
      if (args.allowAuthors !== undefined) patch.allowAuthors = args.allowAuthors
      if (Object.keys(patch).length > 0) entry.filters = mergeFilters(entry.filters, patch)
      if (typeof args.goal === 'string') entry.goal = args.goal.slice(0, 500)
      if (typeof args.observe === 'boolean') entry.observe = args.observe
      if (typeof args.isolated === 'boolean') entry.isolated = args.isolated
      // 与 HTTP 创建路径同口径：隔离开着但没给目录，就明确兜底到宿主 cwd。
      // 否则面板创建不告警、工具创建却被 doctor 警告，同一个配置两种结果。
      if (entry.isolated && !entry.workdir) entry.workdir = process.cwd()
      if (typeof args.workdir === 'string' && args.workdir.trim()) {
        const workdir = args.workdir.trim()
        if (!isAbsolute(workdir)) return toolError(args, 'workdir must be an absolute path')
        if (!existsSync(workdir)) return toolError(args, 'workdir does not exist: ' + workdir)
        entry.workdir = workdir
      }
      // 审核 T32：以前格式写错（`9-23`）会**静默变成全天有效**，回执照样打 [activeHours=9-23]。
      // 现在先校验，不合法就拒绝并说清正确格式 —— 宁可当场报错，也不要「以为设了其实没设」。
      if (typeof args.activeHours === 'string') {
        const hoursCheck = validateActiveHours(args.activeHours)
        if (!hoursCheck.ok) return toolError(args, 'activeHours ' + hoursCheck.reason)
        entry.activeHours = hoursCheck.normalized || null
      }
      if (typeof args.batchLimit === 'number') entry.batchLimit = Math.max(1, Math.min(20, Math.round(args.batchLimit)))
      if (typeof args.maxWakesPerHour === 'number') entry.maxWakesPerHour = Math.max(1, Math.min(60, Math.round(args.maxWakesPerHour)))
      // 面板能改的三项，工具也要能改 —— 否则被问"把隔离区最多留 3 个"时 agent 无从下手
      if (typeof args.sessionMaxWakes === 'number') entry.sessionMaxWakes = Math.max(1, Math.min(60, Math.round(args.sessionMaxWakes)))
      if (typeof args.isolateKeepDays === 'number') entry.isolateKeepDays = Math.max(1, Math.min(30, Math.round(args.isolateKeepDays)))
      if (typeof args.maxIsolated === 'number') entry.maxIsolated = Math.max(1, Math.min(50, Math.round(args.maxIsolated)))
      if (typeof args.ackLabel === 'string' && args.ackLabel.trim()) entry.ackLabel = args.ackLabel.trim().slice(0, 60)
      // 工具入口与面板一样可以调五个优先级键，但部分更新不能把已有开关重置。
      if (args.priority && typeof args.priority === 'object' && !Array.isArray(args.priority)) {
        const current = entry.priority && typeof entry.priority === 'object' && !Array.isArray(entry.priority) ? entry.priority : {}
        const next = { ...DEFAULT_TOOL_PRIORITY, ...current }
        for (const key of ['reopened', 'comments', 'labels', 'unassigned', 'stale']) {
          if (Object.hasOwn(args.priority, key) && typeof args.priority[key] === 'boolean') next[key] = args.priority[key]
        }
        entry.priority = next
      }
      // 审核 T40 W12：`watch_start` 的语义是「开始看」，但**静默恢复**一条暂停的守是意外行为。
      // 保留恢复语义（幂等），但两件事必须做到：
      // ① 如果调用方显式传了 resume:false，就保持原暂停状态（只改配置）；
      // ② 回执里必须说明「这条之前是暂停的，这次恢复了」—— 不许静默。
      const wasPaused = existing && existing.enabled === false
      const keepPaused = args.resume === false && wasPaused
      entry.enabled = !keepPaused
      state.watchers = state.watchers || {}
      if (!existing) {
        // 审核 T32 M3：以前数**全部**守（含已停用的），于是报错让用户「先 watch_stop」，
        // 而 watch_stop 只是置 enabled=false —— 数完还是 20，同一句报错原样再来，成了死结。
        // 上限的本意是「同时轮询的定时器别太多」，所以只数**还在跑的**。
        const mine = Object.values(state.watchers).filter((w) => w && w.sessionId === sessionId && w.enabled !== false)
        if (mine.length >= MAX_WATCHERS_PER_SESSION) {
          return '一条会话最多同时挂 ' + MAX_WATCHERS_PER_SESSION + ' 条在跑的守（现在 ' + mine.length + ' 条）—— 先 watch_stop 停掉不用的，或把多个仓库合成一条规则'
        }
      }
      // 与 HTTP 创建路径同口径：**新建**才做添加前体检，编辑不重复打网络。
      // 只警告不阻止：仓库不存在/只读/归档要在创建时就说，而不是等下一次轮询。
      let warnings = []
      if (!existing) {
        const pre = await precheckRepo(repo, provider)
        warnings = pre.warnings || []
        if (pre.access) entry.repoAccess = pre.access
      }
      state.watchers[id] = entry
      // 显式 start 同 repo/session 表示要重建；只解除这个 id 的墓碑，不影响其他已删守。
      writeState(state, { revive: [id] })
      stopWatcher(id)
      startWatcher(entry)
      const flags = []
      if (wasPaused && entry.enabled) flags.push('这条之前是暂停的，这次调用已恢复（只想改配置请传 resume: false）')
      if (wasPaused && !entry.enabled) flags.push('仍保持暂停（resume: false）')
      if (entry.observe === true) flags.push('observe-only（只记录不唤醒）')
      if (entry.isolated === true) flags.push('isolated')
      if (entry.activeHours) flags.push('activeHours=' + entry.activeHours)
      if (entry.filters && entry.filters.labels && entry.filters.labels.length) flags.push('labels=' + entry.filters.labels.join(','))
      if (entry.filters && entry.filters.onlyAssigned) flags.push('onlyAssigned' + (entry.filters.assignee ? '(' + entry.filters.assignee + ')' : ''))
      if (entry.filters && entry.filters.allowAuthors && entry.filters.allowAuthors.length) flags.push('作者=' + entry.filters.allowAuthors.join(','))
      if (entry.batchLimit) flags.push('batch=' + entry.batchLimit)
      if (entry.maxWakesPerHour) flags.push('perHour=' + entry.maxWakesPerHour)
      if (entry.goal) flags.push('goal=' + JSON.stringify(entry.goal.slice(0, 40)))
      return { entry, existing, flags, id, repo, warnings }

      }
      // 批量要整批校验：19 条时一次加 2 条，不能只加进去第一条
      {
        const snapshot = readState()
        // 审核 T32 M3：与 applyOne 同口径 —— 只数**还在跑的**（watch_stop 只是置 enabled=false）
        const mine = Object.values(snapshot.watchers || {}).filter((w) => w && w.sessionId === sessionId && w.enabled !== false)
        // id 必须和 applyOne 里算的一致（Gitee 带 `gitee:` 前缀），否则上限计数会漏掉它们
        const idOf = ({ repo, provider }) => (provider === 'gitee' ? 'gitee:' : '') + repo + '#' + sessionId
        const incoming = repoList.filter((item) => !(snapshot.watchers || {})[idOf(item)])
        const room = MAX_WATCHERS_PER_SESSION - mine.length
        if (incoming.length > room) {
          return '一条会话最多同时挂 ' + MAX_WATCHERS_PER_SESSION + ' 条在跑的守（现在 ' + mine.length + ' 条，这次要新增 ' + incoming.length + ' 条）—— 先 watch_stop 停掉不用的，或把多个仓库合成一条规则'
        }
      }
      const applied = []
      for (const item of repoList) {
        const result = await applyOne(item)
        // 单条校验失败（比如相对路径的 workdir）要原地返回，不能继续加后面的
        if (typeof result === 'string') return result
        applied.push(result)
      }
      // 与 HTTP 创建回执同形状：warnings 是字符串数组；仓库归属在 repos[] 与文本行里表达。
      const warnings = applied.flatMap((item) => item.warnings || [])
      if (args && args.format === 'json') {
        const first = applied[0]
        const base = JSON.parse(JSON.stringify({ schemaVersion: 1, ok: true, repo: first.repo, sessionId, id: first.id, intervalSec: first.entry.intervalSec,
          flags: first.flags, filters: first.entry.filters || {}, updated: Boolean(first.existing), observe: first.entry.observe === true,
          isolated: first.entry.isolated === true, activeHours: first.entry.activeHours || null }))
        base.repos = applied.map((item) => ({ repo: item.repo, id: item.id, updated: Boolean(item.existing), ...(item.warnings.length ? { warnings: item.warnings } : {}) }))
        // 只在确有警告时增加字段，保持正常创建的 JSON 形状不变。
        if (warnings.length) base.warnings = warnings
        return JSON.stringify(base, null, 2)
      }
      const lines = applied.map((item) => `watching ${item.repo} → session ${sessionId} every ${item.entry.intervalSec}s`
        + (item.flags.length ? ' [' + item.flags.join(' ') + ']' : '')
        + (item.existing ? ' (updated existing watcher)' : ''))
      for (const item of applied) {
        for (const warning of item.warnings || []) lines.push('WARN ' + item.repo + '：' + warning)
      }
      return lines.join(String.fromCharCode(10))
    },
  }))

  ctx.tools.register(defineTool({
    name: 'watch_status',
    description: 'Report active watchers: schedule, why one is paused, unanswered wakes, and how much of the session wake budget is used. Use format=json for machine-readable output. Read-only.',
    parameters: {
      format: { type: 'string', description: "'text' (default, human) or 'json' (same data, structured)." },
    },
    async execute(args) {
      const state = readState()
      const list = Object.values(state.watchers || {})
      if (!list.length) return args && args.format === 'json' ? JSON.stringify({ schemaVersion: 1, session: null, watchers: [] }) : '(no watchers)'
      // 审核 T32：`session` 段以前取 `list[0].sessionId` —— 多个会话的守混在一起时，
      // `used / cap` 报的是**别人**的额度。现在优先用当前会话；拿不到才退回 list[0]。
      const wsAgents = agentsService(ctx)
      const wsAgent = wsAgents && typeof wsAgents.currentInitiator === 'function' ? wsAgents.currentInitiator() : undefined
      const wsSessionId = (wsAgent && wsAgent.id) || undefined
      // 同一份数据：结构化视图 -> 文本只是它的一种渲染，两边永远对得上
      const view = statusView(list, {
        ...(wsSessionId ? { sessionId: wsSessionId } : {}),
        // 状态视图里的默认 ack 与 /state 同源（issue #11）
        defaultAckLabels: brand.defaultAckLabels,
      })
      if (args && args.format === 'json') return JSON.stringify(view, null, 2)
      // 默认只写「这条守是什么」；只有当它需要你注意时才追加原因。
      // 以前每行都带 lastPoll/lastWake/err=-，十条守就是十行长日志。
      const body = view.watchers.map((w) => {
        // 两家仓库同名时（owner/name 在 GitHub 与 Gitee 都可能存在）只有 provider 能区分
        const parts = [(w.provider === 'gitee' ? 'gitee:' : '') + w.repo, '→', w.sessionId, '| 每 ' + w.intervalSec + 's']
        if (w.observe) parts.push('| 仅观察')
        if (w.isolated) parts.push('| 隔离')
        if (!w.enabled) parts.push('| 已暂停')
        if (w.activeHours) parts.push('| 时段 ' + w.activeHours)
        if (w.labels.length) parts.push('| 标签 ' + w.labels.join(','))
        if (w.onlyAssigned) parts.push('| 只看已指派')
        const problems = []
        if (w.deferReason) problems.push('暂停：' + w.deferReason)
        if (w.silentWakes >= 2) problems.push('叫醒 ' + w.silentWakes + ' 次没回音')
        // 审核 T33 M2：`split('（')[0]` 不是截断，是把**括号及其后的下一步全部丢掉** ——
        // 而按项目的约定，下一步恒在末尾括号里。模型于是「有现象、没动作」。
        if (w.lastError) {
          const full = String(w.lastError)
          const cut = full.indexOf('（')
          const main = (cut >= 0 ? full.slice(0, cut) : full).slice(0, 60)
          const hint = cut >= 0 ? full.slice(cut) : ''
          problems.push('上次失败：' + main + hint)
        }
        if (w.enabled && w.lastPoll) {
          const age = Date.now() - Date.parse(w.lastPoll)
          if (Number.isFinite(age) && age > Math.max(w.intervalSec * 3000, 300000)) {
            problems.push('已 ' + Math.round(age / 60000) + ' 分钟没轮询')
          }
        }
        if (!w.lastPoll) problems.push('还没轮询过')
        if (problems.length) parts.push('| ' + problems.join('；'))
        return parts.join(' ')
      }).join(String.fromCharCode(10))
      const s2 = view.session
      const summary = 'session: ' + s2.used + '/' + s2.cap + ' wakes last hour'
        + (s2.capped > 0 ? '，' + s2.capped + ' 条守正因上限暂停' : '')
        + (s2.suggest ? '，建议把会话上限调到 ' + s2.suggest : '')
      return body + String.fromCharCode(10) + summary
    },
  }))

  ctx.tools.register(defineTool({
    name: 'watch_stop',
    description: 'Stop watching a repository for the current session. By default this pauses it and keeps its state; pass delete:true to remove it and leave a tombstone.',
    parameters: {
      repo: { type: 'string', required: true, description: 'owner/name' },
      delete: { type: 'boolean', description: 'Delete the watcher and persist a tombstone instead of only pausing it (default false).' },
      format: { type: 'string', description: "'text' (default) or 'json'." },
    },
    async execute(args) {
      const toolAgents = agentsService(ctx)
      const agent = toolAgents && typeof toolAgents.currentInitiator === 'function' ? toolAgents.currentInitiator() : undefined
      const sessionId = agent && agent.id
      // 审核 T32 M1：id 是「repo#sessionId」，而 Gitee 守的 repo 带 `gitee:` 前缀。
      // 模型照 watch_status 的 JSON 里那个 `repo`（不带前缀）来调，就永远停不掉 ——
      // 而且失败文案是 `(...)` 不是 `[error: ...]`，读起来像「已经停了」。
      // 现在两种写法都认：先按原样找，找不到再试加/去 `gitee:` 前缀。
      const state = readState()
      const rawRepo = String(args.repo || '')
      const candidates = [
        `${rawRepo}#${sessionId}`,
        rawRepo.startsWith('gitee:') ? `${rawRepo.slice(6)}#${sessionId}` : `gitee:${rawRepo}#${sessionId}`,
      ]
      const id = candidates.find((key) => state.watchers && state.watchers[key]) || candidates[0]
      if (!state.watchers || !state.watchers[id]) {
        const message = 'no watcher for ' + rawRepo + '（试过 ' + candidates.join(' / ') + '）'
        return (args && args.format === 'json') ? JSON.stringify({ schemaVersion: 1, ok: false, id, error: message }) : '[error: ' + message + ']'
      }
      // 审核 T36 W2：`stopWatcher()` 同时清 timers 与 bootTimers；删除时必须先停再抹状态，
      // 否则正在收尾的 tick 可能把刚删的守写回来。
      stopWatcher(id)
      if (args.delete === true) {
        delete state.watchers[id]
        state.deleted = { ...(state.deleted || {}), [id]: new Date().toISOString() }
        writeState(state)
        if (args && args.format === 'json') return JSON.stringify({ schemaVersion: 1, ok: true, id, repo: args.repo, deleted: true })
        return `deleted ${id}（deleted:true）`
      }
      state.watchers[id].enabled = false
      writeState(state)
      // 默认 JSON / 文本保持旧形状：只是暂停，不新增 deleted/stopped 字段。
      if (args && args.format === 'json') return JSON.stringify({ schemaVersion: 1, ok: true, id, repo: args.repo })
      return `stopped ${id}`
    },
  }))
}
