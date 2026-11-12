/**
 * Pure watcher logic — no I/O, no timers, no Cordis.
 *
 * Kept separate so the behaviour that matters (what counts as news, when a wake
 * is allowed, what the wake text says) is unit-testable without a DSH host.
 */
import { repoBadges, classifyGhError } from './gh-format.js'
// Gitee 的标签名不允许半角冒号，它的默认 ack 与 GitHub 不同。
// 这里只取常量，不碰网络：gitee.js 的顶层没有任何副作用。
import { DEFAULT_ACK_LABEL_GITEE } from './gitee.js'

/**
 * 品牌名的唯一默认值（issue #11）。
 *
 * 它出现在两处**结构性**文本里：唤醒抬头的「【品牌】…」和合并抬头的「【品牌】这一小段时间内…」。
 * 这两处是会话解析消息的依据，所以默认值必须与 0.10.0 完全一致；
 * 只有插件 Config 明确改了 `brandName` 时才换。
 */
export const DEFAULT_BRAND_NAME = '主理鱼'

/**
 * 归一化品牌名：trim、压平换行、空值回落默认。
 *
 * 抬头是**单行**结构（`【品牌】<repo> 有 N 条新动态：`）。品牌名里夹一个换行，
 * 整段就会变成两行，看起来像第二条消息 —— 外部可配的文本必须先压平再进结构。
 */
export function normalizeBrandName(value, fallback = DEFAULT_BRAND_NAME) {
  const text = String(value ?? '').trim()
  if (!text) return fallback
  return text.replace(/[\r\n]+/g, ' ')
}

/**
 * Split items into "report now" and "absorb silently".
 *
 * An item's `updated_at` moves for two different reasons:
 *
 * 1. Genuinely new activity → report it.
 * 2. Our own follow-up actions (comment, close, label) on an item we just
 *    handled → the item is newer than its watermark, but it is not news.
 *
 * A pure cooldown is not enough: it only *delays* the second kind, and once the
 * window expires the item resurfaces. So a bump that falls inside the cooldown
 * is **absorbed** — its watermark is advanced without a wake — and never comes
 * back. Only bumps that arrive after the window are reported.
 *
 * @param {Array<{number:number, updated_at:string}>} items
 * @param {{seen?: Record<string,string>, cursor?: string|null, lastReported?: Record<string,number>}} state
 * @param {{now?: number, cooldownMs?: number}} [options]
 * @returns {{fresh: Array<object>, absorbed: Array<object>}}
 */
export function partitionItems(items, state = {}, options = {}) {
  const { now = Date.now(), cooldownMs = 0 } = options
  // `items ?? []` 只防 null：手写坏的状态或上游返回对象时，for-of 会抛 TypeError，
  // 而 tick 的 catch 会把它当成「这一轮失败」→ 该守永久退避。非数组一律当空。
  if (!Array.isArray(items)) return { fresh: [], absorbed: [] }
  const seen = state.seen ?? {}
  const reported = state.lastReported ?? {}
  const floor = state.cursor ? Date.parse(state.cursor) : 0
  const fresh = []
  const absorbed = []
  for (const item of items ?? []) {
    const key = String(item.number)
    const prev = seen[key]
    const baseline = prev ? Date.parse(prev) : floor
    if (!(Date.parse(item.updated_at) > baseline)) continue
    const handledAt = reported[key]
    if (cooldownMs > 0 && handledAt && now - handledAt < cooldownMs) absorbed.push(item)
    else fresh.push(item)
  }
  return { fresh, absorbed }
}

/**
 * Backwards-compatible view: only the items that warrant a wake.
 * @param {Array<object>} items
 * @param {object} state
 * @param {{now?: number, cooldownMs?: number}} [options]
 * @returns {Array<object>}
 */
export function splitFresh(items, state = {}, options = {}) {
  return partitionItems(items, state, options).fresh
}

/**
 * Remember when each item was reported, so the cooldown window can start.
 *
 * 审核 T36 M1：这是**唯一没有上限的集合**。`seen` 有 `pruneSeen()`（200 条 / 30 天），
 * 而 `lastReported` 只增不减 —— 每次唤醒写一条，20 条守 × 60 秒跑 30 天约 **14 MB**，
 * 而它唯一被读的地方是 180 秒冷却判断（`REPORT_COOLDOWN_MS`）。180 秒以外的记录纯属垃圾。
 *
 * 现在只保留「冷却窗口还有意义」的那一段，并加一道条数上限兜底。
 */
export function recordReported(state, fresh, now = Date.now(), options = {}) {
  const maxAgeMs = Number(options.maxAgeMs) || 24 * 3600 * 1000
  const maxEntries = Number(options.maxEntries) || 200
  const next = {}
  // 先按时间窗留下还有用的（下一步再写入新的）
  for (const [key, at] of Object.entries(state.lastReported ?? {})) {
    const t = Number(at)
    if (Number.isFinite(t) && now - t <= maxAgeMs) next[key] = t
  }
  for (const item of fresh ?? []) next[String(item.number)] = now
  const trimmed = Object.entries(next)
    .sort((a, b) => b[1] - a[1])
    .slice(0, maxEntries)
  return Object.fromEntries(trimmed)
}

/**
 * May we wake now?
 *
 * A followup spliced while the agent is driving a turn lands in the client's
 * pending-input strip; the client can later restore already-sent input as a
 * draft and re-submit it. Waiting for `idle` costs at most one poll interval.
 *
 * @param {string|undefined} status agent status (`idle` | `running`)
 * @returns {{ok: true} | {ok: false, reason: string}}
 */
export function decideWake(status) {
  if (!status) return { ok: true }
  // 审核 T33 M3：reason 会直接进面板/诊断/唤醒记录 —— 以前是英文内部话，客户读不懂。
  // 这里保留英文状态值（便于排查），但整条话说成客户能懂的：现在是「忙」，不是「坏了」。
  if (status !== 'idle') return { ok: false, reason: '会话正忙（agent busy: ' + status + '）—— 等它空闲，这轮会自动顺延' }
  return { ok: true }
}

/** Advance per-item watermarks after a successful wake. */
export function advanceSeen(seen, fresh) {
  const next = { ...(seen ?? {}) }
  for (const item of fresh ?? []) next[String(item.number)] = item.updated_at
  return next
}

/**
 * 唤醒消息里的「完成标准」三条。
 *
 * 单独抽出来是因为它曾经写错过一次：`criteria` 里引用了不存在的 `iso`（实际变量叫 `isolation`），
 * 只在**会话空闲、真的走到发消息**那一步才爆 `ReferenceError: iso is not defined` ——
 * 有守但一直是 304/会话忙的话，永远看不到。抽成纯函数后，它就能被用例直接覆盖。
 */
export function wakeCriteria({ isolation } = {}) {
  const iso = isolation || {}
  const where = iso.dir
    ? '回写到哪：推分支并开 PR，然后在 issue 里留言 + watch_ack 打标签'
    : '回写到哪：在 issue 里留言 + watch_ack 打标签'
  return [
    '改了什么：文件清单 + 一句话为什么（别只写"已修复"）',
    '怎么验证的：跑过的测试/命令 + 结果；跑不了就写清为什么跑不了',
    where,
  ]
}

// KB: actionable-suggestion.md —— 每个提示都要能回答「我现在该做什么」
// KB: actionable-does-not-mean-repeated.md —— 可执行 ≠ 把同一份指令印 N 遍（见 mergeWakeTexts）
// KB: error-must-have-next-step.md —— 每个错误都要带下一步
/**
 * 唤醒消息 = 有序 section，而不是按角色拆分。竞品的触发都带足上下文
 * （类型、状态、作者、标签、是否草稿），否则 agent 醒来还得自己查一遍。
 *
 * 每个 section 都是 `{ id, lines }`：id 稳定、lines 可直接断言或覆盖；
 * 没有内容的可选 section 省略，header / facts / next 始终保留。
 */
export function buildWakeSections(repo, items, options = {}) {
  const list = items ?? []
  const brandName = normalizeBrandName(options.brandName)
  const more = Number(options.more) || 0
  const lines = list.map((item) => {
    const kind = item.pull_request ? 'PR' : 'issue'
    const draft = item.draft ? ' 草稿' : ''
    const who = (item.user && item.user.login) || '?'
    const labels = labelNames(item)
    const tail = [
      `(${kind}${draft})`,
      labels.length > 0 ? `标签: ${labels.join(', ')}` : null,
      (item.assignees ?? []).length > 0 ? `指派: ${item.assignees.map((a) => '@' + a.login).join(' ')}` : null,
      item.html_url,
      (stateReasonNote(item) && String(item.state_reason || '') === 'reopened') ? '⚠ ' + stateReasonNote(item) : null,
      // T31 曾建议：`未认领` 无条件出现在每一条上是噪音（5 条消息 5 次），且默认不参与排序。
      // 结论是**保留**：它是一个事实（模型据它决定要不要接），而且「默认不加权」本身就是产品判断
      // （见 DEFAULT_PRIORITY.unassigned）。删掉它等于让模型分不清「无人认领」和「已指派给别人」。
      assignmentNote(item) || null,
      (item.state === 'open' ? stalenessNote(item) : '') || null,
      linkedPrNote(item.linkedPr) || null,
      // 之前叫醒过这条：会话该知道「这不是新问题」
      (options.seenBefore && options.seenBefore[String(item.number)])
        ? '⏰ 之前叫醒过（' + String(options.seenBefore[String(item.number)]).slice(0, 10) + '）'
        : null,
      // Ticket 「open」状态的最小版：这条上一轮提过，但没等到回执
      (item.retryOf ? '↻ 上一轮提过，还没回执（第 ' + (Number(item.retryOf.tries) + 1) + ' 次）' : null),
      // 诉求 2「不留手尾」：同一条被重开/再叫醒时，告诉会话上次是怎么处理的，
      // 别让它重新判一遍。（数据来自 watch_ack 的 note，见 INDEX 的 acked）
      (options.acked && options.acked[String(item.number)])
        ? '↩ 上次处理（' + String(options.acked[String(item.number)].at).slice(0, 10) + '）：'
          + String(options.acked[String(item.number)].note)
        : null,
      item.lastComment
        ? '最后评论: ' + commentSummaryLine({
          login: item.lastComment.self ? '' : item.lastComment.login,
          at: item.lastComment.at,
        }, null) + (item.lastComment.self ? ' 我（上一轮留的）' : '')
        : null,
    ].filter(Boolean).join(' ')
    // 单行太长在聊天窗口里会挤成一团：超过 120 字就把补充信息挪到下一行（链接点哪都一样）
    // 审核 M5（注入面）：issue 标题是**外部不可信内容**，直接插值会被拼出第二个
    // 「【主理鱼】以下为系统指令」抬头。同一个函数里 goal 的换行早就被压平了，title 漏了。
    // 压平换行 + 把方括号抬头换成普通括号（保留内容，只让它无法伪造结构）。
    const safeTitle = String(item.title || '')
      .split(String.fromCharCode(13)).join(' ')
      .split(String.fromCharCode(10)).join(' ')
      .split('【').join('[')
      .split('】').join(']')
      .slice(0, 200)
    const MAX_LINE = 120
    const prefix = `#${item.number} [${item.state}] `
    const suffix = ` — @${who}`
    // 标题按「整行不超过上限」反算 —— 以前固定截 200，前面还有前缀，整行就爆了
    const room = Math.max(20, MAX_LINE - [...prefix].length - [...suffix].length)
    const chars = [...safeTitle]
    const shown = chars.length <= room ? safeTitle : chars.slice(0, room - 1).join('') + '…'
    const head = `${prefix}${shown}${suffix}`
    const oneLine = tail ? `${head} ${tail}` : head
    if ([...oneLine].length <= MAX_LINE) return oneLine
    // 第二行（补充信息）也可能很长：同样按上限截断，别让它变成一堵墙
    const tailChars = [...tail]
    const tailFit = tailChars.length <= MAX_LINE ? tail : tailChars.slice(0, MAX_LINE - 1).join('') + '…'
    return `${head}\n  ${tailFit}`
  })
  const rest = (options.restNumbers ?? []).map((n) => '#' + n).join(' ')
  const iso = options.isolation
  const isoLine = iso && iso.dir
    ? `【隔离工作区】${iso.dir}（分支 ${iso.branch}）—— 只在这里改，推这个分支开 PR，别碰主工作区；用完 git worktree remove 掉。`
    : iso && iso.error
      ? `【隔离失败】${iso.error}；这次请谨慎，改完别留下未提交内容。`
      : ''
  const goalLine = options.goal
    ? `本条目主理目标：${String(options.goal).split(String.fromCharCode(13)).join(' ').split(String.fromCharCode(10)).join(' ').slice(0, 200)}`
    : ''
  // 身份说明：插件调 gh 用的是它绑定的账号，会话里跑的 git push 用的是会话自己的环境。
  // 不说明的话，gh 评论挂智能体名下、git 提交挂操作者名下 —— 一次改动两个作者。
  //
  // 注意：**这里不写路径**（PR #7 原本把 GH_CONFIG_DIR=<绝对路径> 塞进来）。唤醒消息会进模型上下文、
  // 进对话记录、可能被后续总结引用；带路径就等于把本机用户目录一并带出去。
  // 会话只要知道「该问用户」就够了 —— 用户本来就知道自己的路径。
  const identityLine = options.identityBound
    ? '【提交身份】本插件的 gh 已绑定单独的智能体账号。你在会话里执行 git / git push 时如需一致身份，'
      + '请向用户索取该账号的 gh 配置目录并设 GH_CONFIG_DIR；否则提交会落到操作者账号上。'
    : ''
  const moreLine = more > 0
    ? `（另有 ${more} 条：${rest}，处理完这批再看）`
    : ''
  // 「为什么是这几条」：只给结果不给依据，会话/客户都没法判断要不要调过滤条件。
  // 依据：GitHub 的通知带 reason（为什么通知你）、Slack 摘要会说明分组依据 —— 同一个道理。
  const whyLine = (() => {
    const parts = []
    const changed = Number(options.changedTotal)
    const count = list.length
    // 只有一条变化时，解释"为什么是这几条"就是噪音：本来就只有它
    const onlyOne = count <= 1 && (!Number.isFinite(changed) || changed <= 1)
    if (!onlyOne) {
      if (Number.isFinite(changed) && changed > 0) parts.push('本轮共 ' + changed + ' 条变化')
      if (options.batchLimit) {
        // 审核 T31 M3：真实排序是 priorityScore（重开 +100 / 评论 +10 / 标签 +5），不是「最近更新」。
        // 写「按最近更新」等于骗人：客户会以为越新越靠前，实测 5 分钟前的落进「另有」。
        const priorityOn = Boolean(options.priority && (options.priority.reopened !== false || options.priority.comments !== false || options.priority.labels !== false))
        parts.push(priorityOn
          ? '按优先级取前 ' + options.batchLimit + ' 条（重开的排最前）'
          : '按优先级取前 ' + options.batchLimit + ' 条')
      }
    }
    const skipped = options.skippedReasons && typeof options.skippedReasons === 'object'
      ? Object.entries(options.skippedReasons).filter(([, n]) => Number(n) > 0).slice(0, 3)
      : []
    if (skipped.length > 0) {
      // 只说「前三个原因」会让人以为只有这些；把总数也报出来
      const total = Object.values(options.skippedReasons).reduce((sum, n) => sum + (Number(n) || 0), 0)
      const more = Object.keys(options.skippedReasons).length > skipped.length ? ' 等' : ''
      parts.push('本轮跳过 ' + total + ' 条（' + skipped.map(([reason, n]) => reason + ' × ' + n).join('、') + more + '）')
    }
    return parts.length > 0 ? '【为什么是这几条】' + parts.join('；') : ''
  })()
  // 完成标准要「可观测」：只说"做好它"等于没说。
  // 依据：Given-When-Then 的核心是把验收写成可观察的结果（martinfowler.com/bliki/GivenWhenThen.html）。
  const accessLine = options.access ? '【权限提示】' + options.access : ''
  const criteria = Array.isArray(options.criteria) ? options.criteria.filter(Boolean).slice(0, 4) : []
  const criteriaLines = criteria.length > 0
    ? ['【完成标准】', ...criteria.map((line, i) => (i + 1) + '. ' + line)]
    : []
  const headerLine = options.firstSync
    ? `【${brandName}】${repo} 首次同步：仓库里现有 ${lines.length} 条待处理（接上之前就在的，不是刚刚发生）：`
    : `【${brandName}】${repo} 有 ${lines.length} 条新动态：`
  const nextLine = '接下来：先读仓库 AGENTS.md 定「修 / 回 / 待定」；没有测试结果不算完成；'
    + (options.provider === 'gitee'
      // Gitee 没有 gh CLI：回写走网页/API，别让会话去跑 gh 命令
      ? '做完一条就写回 Gitee（网页或 API 都行）+ watch_ack 打标签，不要扩大范围。'
      : '做完一条就写回 GitHub + watch_ack 打标签，不要扩大范围。')

  const sections = [
    { id: 'header', lines: [headerLine] },
    { id: 'facts', lines },
  ]
  if (whyLine) sections.push({ id: 'selection', lines: [whyLine] })
  if (moreLine) sections.push({ id: 'overflow', lines: [moreLine] })
  if (isoLine) sections.push({ id: 'isolation', lines: [isoLine] })
  if (goalLine) sections.push({ id: 'goal', lines: [goalLine] })
  if (identityLine) sections.push({ id: 'identity', lines: [identityLine] })
  if (accessLine) sections.push({ id: 'access', lines: [accessLine] })
  if (criteriaLines.length > 0) sections.push({ id: 'criteria', lines: criteriaLines })
  // 空行属于 next section：无论 criteria 是否存在，收尾前都保持原有的一个空行。
  sections.push({ id: 'next', lines: ['', nextLine] })
  return sections
}

/** 把有序 sections 渲染成唤醒文本；两层 join 也保留空 facts 的旧空行行为。 */
export function formatWatchText(repo, fresh, options = {}) {
  return buildWakeSections(repo, fresh, options)
    .map((section) => section.lines.join('\n'))
    .join('\n')
}

// ── 竞品蒸馏出来的四道闸（见 docs/competitive-analysis.md） ────────────────

export const DEFAULT_FILTERS = {
  labels: [],
  ignoreLabels: [],
  skipBots: true,
  skipDrafts: true,
  skipClosed: true,
  onlyAssigned: false,
  assignee: null,
  // 谁提的才算：空 = 谁都算
  allowAuthors: [],
}

/** 宽容地把用户传进来的 filters 规范化，缺字段走默认。 */
export function normalizeFilters(raw) {
  const f = raw && typeof raw === 'object' ? raw : {}
  const list = (v) => (Array.isArray(v) ? v.map(String).map((s) => s.trim()).filter(Boolean) : [])
  return {
    labels: list(f.labels),
    ignoreLabels: list(f.ignoreLabels),
    skipBots: f.skipBots !== false,
    skipDrafts: f.skipDrafts !== false,
    skipClosed: f.skipClosed !== false,
    onlyAssigned: f.onlyAssigned === true,
    assignee: typeof f.assignee === 'string' && f.assignee.trim() ? f.assignee.trim() : null,
    // 谁提的才算（空 = 谁都算）；顺手去掉 @ 前缀，客户复制粘贴的形如 @alice
    allowAuthors: list(f.allowAuthors).map((n) => n.replace(/^@/, '')),
  }
}

const labelNames = (item) => (item.labels ?? []).map((l) => (typeof l === 'string' ? l : l && l.name)).filter(Boolean)
const isBot = (item) => {
  const user = item.user || {}
  return user.type === 'Bot' || /\[bot\]$/i.test(String(user.login || ''))
}

/**
 * 触发要有许可：不是仓库里任何风吹草动都叫醒会话。
 * 返回 false 的条目直接不进候选集，也不会污染 seen 水位。
 */
/**
 * 为什么这条被过滤掉？返回 null 表示通过，否则返回一个可读的原因码。
 * 拆出原因是为了面板能展示「最近被过滤了什么、因为哪条规则」——
 * 否则「不在干活」和「在过滤」在界面上长得一样。
 */
// KB: filter-explainability.md —— 让「为什么没叫醒」有答案（每条被过滤的都要留原因）
export function filterReason(item, filters = DEFAULT_FILTERS) {
  const f = { ...DEFAULT_FILTERS, ...(filters || {}) }
  if (f.skipClosed && item.state && item.state !== 'open') return '已关闭'
  if (f.skipDrafts && item.draft) return '草稿 PR'
  if (f.skipBots && isBot(item)) return '机器人'

  const names = labelNames(item).map((n) => String(n).toLowerCase())
  const lower = (arr) => (arr || []).map((n) => String(n).toLowerCase())
  const ignored = lower(f.ignoreLabels).find((n) => names.includes(n))
  if (ignored) return '排除标签: ' + ignored
  if (f.labels.length > 0 && !lower(f.labels).some((n) => names.includes(n))) {
    return '不在标签白名单: ' + f.labels.join(',')
  }

  // 「谁提的」——官方原型把这一条放在 Policy 的第一位（谁可以给你派活）。
  // 我们不做完整政策层，但白名单是单人场景也要的：别人随手提的 issue 不该叫醒你。
  // 空数组 = 谁都算（默认，保持老行为）。
  if (Array.isArray(f.allowAuthors) && f.allowAuthors.length > 0) {
    const login = String((item.user && item.user.login) || '').toLowerCase()
    const allowed = f.allowAuthors.map((n) => String(n).replace(/^@/, '').toLowerCase())
    if (!allowed.includes(login)) return '作者不在名单: @' + (login || '?')
  }

  if (f.onlyAssigned) {
    const assignees = (item.assignees ?? []).map((a) => String((a && a.login) || a).toLowerCase())
    if (f.assignee) return assignees.includes(f.assignee.toLowerCase()) ? null : '未指派给 @' + f.assignee
    return assignees.length > 0 ? null : '没有指派给人'
  }
  return null
}

export function passesFilters(item, filters = DEFAULT_FILTERS) {
  return filterReason(item, filters) === null
}

/** 环形缓冲：最近被过滤的条目（默认留 5 条），够解释「为什么没动」就行。 */
export function pushFiltered(log, record, max = 5) {
  const list = Array.isArray(log) ? log.slice() : []
  list.push(record)
  return list.slice(-Math.max(1, max))
}

/** 单次唤醒最多带几条；其余留到下一轮，别让一次唤醒把上下文撑爆。 */
/** 记一条「被冷却期吸收」：只有记下来，客户问「这条为什么没叫醒我」才答得准。 */
// 吸收日志只用于回答「这条最近为什么没叫醒我」，20 条足够覆盖最近几轮；
// 50 条时状态文件会多几十 KB（实测 20 守 × 30 天从 204 KB 降到约 170 KB）。
export function pushAbsorbed(log, items, at, max = 20) {
  const list = Array.isArray(log) ? log.slice() : []
  for (const item of items ?? []) {
    list.push({ at, number: String(item.number), title: String(item.title || '').slice(0, 80) })
  }
  return list.slice(-Math.max(1, max))
}


/**
 * 优先级：一次只能处理 N 条时，该先处理哪 N 条。
 *
 * 依据：GitHub 的 issue 列表支持 `sort=created|updated|comments`（服务端排序），
 * 但它排的是"哪条更热"，我们要的是"哪条更该现在处理"——两者不同，所以在本地排。
 * 出处：https://docs.github.com/en/rest/issues/issues#list-repository-issues
 *
 * 权重（简单、可解释、可测）：
 *   被重开 100   —— 之前判过"不做"被推翻，最该看
 *   有人评论 10  —— 说明在等回应
 *   命中我们的标签 5
 *   其余按 GitHub 的 updated 顺序（稳定排序保持原相对次序）
 */
export const DEFAULT_PRIORITY = { reopened: true, comments: true, labels: true, unassigned: false }

// KB: priority-configurable.md —— 权重是产品判断，别写死（客户可开关每一项）
// KB: batch-priority.md —— 一次 N 条时先处理更该处理的
export function priorityScore(item, options) {
  if (!item || typeof item !== 'object') return 0
  const on = { ...DEFAULT_PRIORITY, ...(options || {}) }
  let score = 0
  if (on.reopened !== false && String(item.state_reason || '') === 'reopened') score += 100
  if (on.comments !== false && Number(item.comments) > 0) score += 10
  if (on.labels !== false && Array.isArray(item.labels) && item.labels.length > 0) score += 5
  // 默认关闭：这是产品判断而非规则，客户想用再开
  if (on.unassigned === true && assignmentNote(item) !== '') score += 3
  if (on.stale === true && stalenessNote(item) !== '') score += 2
  return score
}

export function batchFresh(fresh, limit = 3, priority) {
  const list = Array.isArray(fresh) ? fresh.slice() : []
  const n = Math.max(1, Number(limit) || 3)
  // 稳定排序：分数相同就保持 GitHub 给的 updated 顺序
  const ranked = list
    .map((item, index) => ({ item, index, score: priorityScore(item, priority) }))
    .sort((a, b) => (b.score - a.score) || (a.index - b.index))
    .map((entry) => entry.item)
  return ranked.slice(0, n)
}

/** 连续失败指数退避：30s → 60 → 120 → … 上限 30 分钟；成功即复位。 */
/**
 * 永久性错误（仓库不存在 / 已改名）要等多久再试。
 *
 * 依据 GitHub 官方最佳实践：确认凭据没问题后，「wait much longer before you check again」——
 * 反复请求不存在的资源既浪费额度，还可能触发 secondary rate limit。
 * 出处：https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api
 */
/**
 * 进入「不在活跃时段」的等待：顺带把上一次的错误清掉。
 *
 * 为什么：时段外根本不轮询，旧的 lastError 会一直挂着，面板上就变成一条永不消停的「异常」。
 * 依据同 paused-means-no-new-facts：不再更新的状态不该继续代表「现在」。
 */
/**
 * 未归类的错误：把原始措辞留一份样本（最多 3 条）到事件流。
 *
 * 为什么：分类器只认我们见过的措辞。没见过的如果只显示「没归类的错误」，
 * 下次还是收集不到 —— 让它在事件流里留个样本，下一轮才能补规则。
 */
export function recordOtherError(entry, detail) {
  const text = String(detail || '').trim().slice(0, 120)
  if (!text) return entry
  entry.events = pushEvent(entry.events, { kind: 'other', text })
  return entry
}
export function enterActiveHoursDefer(entry, waitMs, hours, at = new Date()) {
  entry.nextAt = new Date(at.getTime() + Number(waitMs || 0)).toISOString()
  entry.lastDeferred = `不在活跃时段（${hours}），${Math.round(Number(waitMs || 0) / 60000)} 分钟后开始`
  entry.deferReason = 'active-hours'
  // 旧错误不是「现在」的事实
  entry.lastError = null
  entry.lastErrorAt = null
  entry.consecutiveFailures = 0
  return entry
}
export function permanentBackoffMs(kind, baseMs = 60000) {
  // auth：凭证失效不会自己好 —— 每 60 秒重试既无用，也可能被风控当成异常
  const PERMANENT = new Set(['notfound', 'moved', 'auth'])
  if (!PERMANENT.has(kind)) return 0
  return Math.max(30 * 60 * 1000, Number(baseMs) || 0)
}
/**
 * 失败后的等待时间。
 *
 * 前几次按指数退避（上限 30 分钟）；**连续失败到第 6 次就不再密集重试**，改成 2 小时一次 ——
 * 思路来自 Google SRE《Handling Overload》的「per-request retry budget」：
 * 重试应当有预算，用完就不能再无限次立刻重来。
 * 出处：https://sre.google/sre-book/handling-overload/
 */
export const RETRY_BUDGET_ATTEMPTS = 6
// 预算外的等待上限（分钟）：面板上的「已放慢到 X 小时档」从这里算，不再写死文案
export const RETRY_SLOW_CAP_MINUTES = 120
export function nextDelayMs(entry, baseMs) {
  const failures = Number((entry && entry.consecutiveFailures) || 0)
  if (failures <= 0) return baseMs
  const overBudget = failures >= RETRY_BUDGET_ATTEMPTS
  // 预算内：最多 60 倍（默认 60s 间隔 → 1 小时）；超出预算：最多 120 倍（→ 2 小时）
  const factor = Math.min(2 ** failures, overBudget ? 120 : 60)
  const cap = overBudget ? RETRY_SLOW_CAP_MINUTES * 60 * 1000 : 30 * 60 * 1000
  return Math.min(Math.max(baseMs * factor, baseMs), cap)
}

/** 每小时唤醒上限：把过去一小时的唤醒时间戳剪掉再判断。 */
export function pruneWakeTimes(times, now = Date.now()) {
  const floor = now - 60 * 60 * 1000
  // 手写坏的值（"abc" / {} / 0）以前会让这里抛 TypeError：①该守被 tick 的 catch 抓走进永久退避，
  // ②/state 整条 500（面板全灭）。非数组一律当空处理 —— 坏数据的代价不该是「整个面板挂掉」。
  const list = Array.isArray(times) ? times : []
  return list.map(Number).filter((t) => Number.isFinite(t) && t >= floor)
}


/** Highest `updated_at` among fresh items, used as the falling-back global cursor. */
export function newestUpdatedAt(fresh) {
  let best = null
  for (const item of fresh ?? []) {
    const at = item.updated_at
    if (!best || Date.parse(at) > Date.parse(best)) best = at
  }
  return best
}

/**
 * Pause / resume / delete one watcher, as a pure state transition.
 *
 * The host route and the tests share this so the three actions cannot drift:
 * the route only has to persist the returned state and reconcile its timers.
 * @param state - mutable `{ watchers }` record read from disk.
 * @param request - `{ action, id }`; id is `repo#sessionId`.
 * @returns `{ ok: true, action, id, enabled?, deleted? }` or `{ ok: false, error }`.
 */
export function applyWatcherAction(state, { action, id } = {}) {
  const watchers = (state && state.watchers) || {}
  // 审核 T19：`id = "__proto__"` 会命中 Object.prototype —— 随后 `entry.enabled = false`
  // 写到**原型**上，进程级生效（所有缺省 enabled 的守、同进程其它插件一起受影响），
  // 而盘上一个字没改。只认自有属性，且 id 必须是字符串。
  if (typeof id !== 'string' || !id || !Object.prototype.hasOwnProperty.call(watchers, id)) {
    return { ok: false, error: `unknown watcher: ${id || '(missing id)'}` }
  }
  const entry = watchers[id]
  if (action === 'delete') {
    delete watchers[id]
    return { ok: true, action, id, deleted: true }
  }
  if (action === 'pause') {
    entry.enabled = false
    return { ok: true, action, id, enabled: false }
  }
  if (action === 'resume') {
    entry.enabled = true
    // A stale error would make the satellite look broken on the first frame
    // after the operator turns it back on; the next poll repopulates it.
    entry.lastError = null
    return { ok: true, action, id, enabled: true }
  }
  return { ok: false, error: 'action must be pause | resume | delete' }
}

// ── DeepSeek 论文蒸馏：记忆要遗忘 + 幂等要留在外部系统 ──────────────────

/** 处理完打在这个 issue/PR 上的标签，轮询时直接跳过 —— 换机器也不会重报。 */
export const DEFAULT_ACK_LABEL = '主理鱼:已处理'

export function hasAckLabel(item, label = DEFAULT_ACK_LABEL) {
  const want = String(label).toLowerCase()
  return labelNames(item).some((n) => String(n).toLowerCase() === want)
}

/**
 * `seen` / `lastReported` 会随条目无限增长（DeepSeek-OCR 那篇把这件事叫记忆遗忘）。
 * 超过 maxAgeMs 或超过 maxEntries 的旧记录直接丢掉 —— 丢掉的代价只是「老 issue 可能被重报一次」。
 */
export function pruneSeen(seen, options = {}) {
  // 500 条 × 每条约 60 字节 × 20 条守 → 状态文件会到 200 KB 以上；
  // 去重只需要覆盖「最近几页条目」，200 条足够（列表查询一次最多 100 条/页）。
  const { maxAgeMs = 30 * 24 * 3600 * 1000, maxEntries = 200, now = Date.now() } = options
  const entries = Object.entries(seen ?? {})
    .map(([k, v]) => [k, Date.parse(v)])
    .filter(([, t]) => Number.isFinite(t) && now - t <= maxAgeMs)
    .sort((a, b) => b[1] - a[1])
    .slice(0, maxEntries)
  return Object.fromEntries(entries.map(([k, t]) => [k, new Date(t).toISOString()]))
}

/**
 * 隔离工作区命名（对应 DeepSeek DSec 的沙箱思路）：一次唤醒一个一次性 worktree，
 * 让 agent 在副本里改，主工作区不受污染。纯函数，方便测试。
 */
export function worktreePlan({ workdir, repo, sessionTag, stamp = Date.now() } = {}) {
  const safeRepo = String(repo || 'repo').replace(/[^A-Za-z0-9._-]+/g, '-')
  const safeTag = String(sessionTag || 'session').replace(/^session-/, '').replace(/[^A-Za-z0-9._-]+/g, '').slice(0, 8) || 'session'
  const id = `${safeRepo}-${safeTag}-${Number(stamp).toString(36)}`
  const root = String(workdir || '.').replace(/[\\/]+$/, '')
  return {
    id,
    dir: `${root}/.dsh-zhuli/${id}`,
    branch: `zhuli/${id}`,
  }
}

/**
 * 隔离区（worktree）会随每次唤醒累积。返回超过 keepMs 没动过的那些，交给调用方回收。
 * 纯函数，单测覆盖。
 */
/**
 * 该回收的隔离区：**按年龄** + **按数量** 两条线（原来只有年龄）。
 *
 * 为什么补数量：年龄线管不住"堆" —— 上限 6 次/小时 × 保留 3 天 = 最坏 432 个副本。
 * 实测一个 worktree ≈ 该仓库工作树的大小（我们的仓库 1.3 MB，一个 3 MB 文件的测试仓库开出 2.9 MB），
 * 按 10 MB 估就是 4 GB 级占用。
 *
 * `keepCount`：最近 N 个无论多老都留着（正在用的那个不能被删）。
 */
export function staleWorktrees(entries, options = {}) {
  const { now = Date.now(), keepMs = 3 * 24 * 3600 * 1000, keepCount = 5 } = options
  const list = (entries ?? []).filter((entry) => entry && entry.name && Number.isFinite(Number(entry.mtimeMs)))
  const byAge = list.filter((entry) => now - Number(entry.mtimeMs) > keepMs)
  const cap = Math.max(0, Number(keepCount) || 0)
  const newest = list.slice().sort((a, b) => Number(b.mtimeMs) - Number(a.mtimeMs)).slice(0, cap)
  const keep = new Set(newest.map((entry) => entry.name))
  const byCount = list.filter((entry) => !keep.has(entry.name))
  const out = []
  const seen = new Set()
  for (const entry of [...byAge, ...byCount]) {
    if (seen.has(entry.name)) continue
    seen.add(entry.name)
    out.push(entry)
  }
  return out
}

/**
 * 活跃时段控制（对标 Renovate 的 schedule）：只在人和 agent 都清醒的时段唤醒，
 * 夜里攒着。spec 形如 "09:00-23:00"，支持跨夜 "22:00-06:00"；空值或格式不对 = 一直活跃。
 * 用本地时间判断。
 */
export function inActiveHours(spec, now = new Date()) {
  if (!spec || typeof spec !== 'string') return true
  const m = spec.match(/^(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})$/)
  if (!m) return true
  const toMin = (h, mi) => (Number(h) * 60 + Number(mi)) % (24 * 60)
  const start = toMin(m[1], m[2])
  const end = toMin(m[3], m[4])
  const cur = now.getHours() * 60 + now.getMinutes()
  if (start === end) return true
  return start < end ? cur >= start && cur < end : cur >= start || cur < end
}

/**
 * 唤醒历史（面板要能看见「上一轮干了什么」）。只保留最近 max 条。
 */
export function pushHistory(history, record, max = 20) {
  const list = Array.isArray(history) ? history.slice() : []
  list.push(record)
  return list.slice(-Math.max(1, max))
}

/** 只允许从内存 entry 写回的轮询结果字段。配置类字段（enabled/filters/…）以盘上为准。 */
export const POLL_RESULT_FIELDS = [
  'lastPoll', 'lastError', 'nextAt', 'consecutiveFailures', 'seen', 'cursor', 'lastReported',
  'lastWake', 'lastWakeCount', 'lastBatch', 'lastWakeItem', 'lastAbsorbed', 'wakeTimes', 'lastDeferred',
  'history', 'lastWorktree', 'lastAcked', 'lastTrigger',
  // 过滤记录也是轮询结果：漏了它面板上的「最近被过滤」永远是空的
  'filteredLog',
  // lastReopened / lastStates 是「这一轮判出重新打开」的产物：漏了它们，
  // /state 永远回 null，面板上的 ⚠ 与 problems 也永远不出现（对 GitHub 同样成立）。
  'lastReopened', 'lastStates',
  // 审核（0.9.194）又数出 13 个：**都是轮询结果，却全被写盘丢掉**。
  // 最关键的是 etag —— 丢了它，条件请求永远带不上，每轮都在全量拉；
  // 其次是 needsReauth / lastErrorAt —— doctor 的「凭证失效」分支永远不会触发。
  // 教训：白名单是**手维护的**，新增字段时必须同时加进来，否则「算出来了但没存」。
  'etag', 'lastFreshAt', 'needsReauth', 'lastErrorAt', 'deferReason', 'silentWakes', 'prevWakeAt',
  'dailyWakes', 'absorbedLog', 'filterCounts', 'repoAccess', 'sessionMissingSince',
  'minIntervalSec', 'lastCleanupAt',
  // 「叫醒之后」的两块记录：漏了它们，ack 留的话和「提过没回执」都会在写盘时被静默丢掉
  //（这个白名单是手维护的 —— 加字段忘了加这里，功能就静默失效）
  'acked', 'pending',
]

/**
 * 把一次轮询的内存结果合并进盘上记录：配置类字段永远以盘上为准。
 * 这条规则是审核找出来的 —— tick 收尾曾把「暂停」写回成运行中。
 */
export function mergePollResult(stored, polled) {
  const merged = { ...(stored || {}) }
  for (const key of POLL_RESULT_FIELDS) {
    if (polled && polled[key] !== undefined) merged[key] = polled[key]
  }
  // 水位只许前进：`seen` / `lastPoll` 是「处理到哪」的标记，不是普通字段。
  // 真机事故（0.9.194 审核 M2）：`watch_ack` 把 seen[42] 推到 05:00，
  // 并发 tick 手里还是 04:59 的快照，收尾整份覆盖 → 水位后退 → 冷却期一过同一条又被叫醒。
  if (stored && polled) {
    if (stored.seen && polled.seen) {
      const seen = { ...polled.seen }
      for (const [key, at] of Object.entries(stored.seen)) {
        const prev = seen[key]
        if (!prev || Date.parse(at) > Date.parse(prev)) seen[key] = at
      }
      merged.seen = seen
    }
    if (stored.lastPoll && merged.lastPoll && Date.parse(stored.lastPoll) > Date.parse(merged.lastPoll)) {
      merged.lastPoll = stored.lastPoll
    }
  }
  return merged
}

/**
 * 部分更新过滤器：只用 patch 里「出现过的键」覆盖，没出现的保持原值。
 * 踩过的坑：GUI 只发 labels/onlyAssigned，服务端整对象重建会把 ignoreLabels / skip* / assignee 全抹成默认。
 */
export function mergeFilters(base, patch) {
  const current = normalizeFilters(base)
  if (!patch || typeof patch !== 'object') return current
  const next = { ...current }
  if ('labels' in patch) next.labels = normalizeFilters({ labels: patch.labels }).labels
  if ('ignoreLabels' in patch) next.ignoreLabels = normalizeFilters({ ignoreLabels: patch.ignoreLabels }).ignoreLabels
  if ('skipBots' in patch) next.skipBots = patch.skipBots !== false
  if ('skipDrafts' in patch) next.skipDrafts = patch.skipDrafts !== false
  if ('skipClosed' in patch) next.skipClosed = patch.skipClosed !== false
  if ('onlyAssigned' in patch) next.onlyAssigned = patch.onlyAssigned === true
  if ('assignee' in patch) next.assignee = normalizeFilters({ assignee: patch.assignee }).assignee
  // 审核 T40 M2：`allowAuthors` 加进 normalizeFilters 时漏了这里 ——
  // 而 watch_start（工具）和 /watch（面板）**都走 mergeFilters**，于是这个字段两条路都被静默丢弃，
  // 面板上还写着「不在名单里的人提的 issue/PR 不会叫醒你」。功能等于不存在，而测试全绿
  //（用例只测了 filterReason/normalizeFilters，没走真实链路）。
  if ('allowAuthors' in patch) next.allowAuthors = normalizeFilters({ allowAuthors: patch.allowAuthors }).allowAuthors
  return next
}

/**
 * 把 gh 失败时的原始文本归类成「一句话原因 + 该怎么做」。
 *
 * 真机上出现过 `Get "https://api.github.com/...": EOF` 这种直接怼给用户看的原始报错 ——
 * 它既长又吓人，其实是**网络抖动**，自动退避重试就会好。这里把它变成人话。
 *
 * @returns {{ kind: string, short: string, hint: string }}
 */
// 拆分后：GitHub 交互层在 gh-format.js，这里转出以保持既有调用方不变
import {
  assignmentNote, commentSummaryLine, linkedPrNote, stalenessNote, stateReasonNote,
} from './gh-format.js'
export {
  TRIAGE_SIGNALS,
  accessNote,
  assignmentNote,
  buildCommentBatchQuery,
  classifyGhError,
  commentSummaryLine,
  countReasons,
  isAuthBroken,
  diagnoseEmptyBody,
  diagnoseBadBody,
  formatGhCall,
  jitterMs,
  linkedPrNote,
  parseCommentBatch,
  parseGhInclude,
  pickLinkedPullRequests,
  pickSuggestion,
  repoBadges,
  repoStructureNote,
  retryAfterMs,
  stalenessNote,
  stateReasonNote,
  throttleDelayMs,
} from './gh-format.js'

/**
 * 距离「活跃时段开门」还有多久（毫秒）；已在时段内返回 0。
 *
 * 为什么要它：以前 activeHours 的判断在**拉完 API 之后**才做 ——
 * 夜里 8 小时照常每 N 秒打一次 GitHub，纯属白跑。现在提前到最前面，
 * 并把下一次轮询安排在"开门那一刻"，既不浪费请求，也不会让攒着的条目干等一个周期。
 */
export function msUntilActiveWindow(spec, now = new Date()) {
  if (!spec || typeof spec !== 'string') return 0
  const m = spec.match(/^(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})$/)
  if (!m) return 0
  if (inActiveHours(spec, now)) return 0
  const startMin = (Number(m[1]) * 60 + Number(m[2])) % (24 * 60)
  const curMin = now.getHours() * 60 + now.getMinutes()
  const curSec = now.getSeconds()
  let diffMin = startMin - curMin
  if (diffMin <= 0) diffMin += 24 * 60
  // 精确到分钟的开头，再减掉当前秒数
  return Math.max(1000, diffMin * 60 * 1000 - curSec * 1000)
}

/**
 * 被「每小时上限」挡住时，下一个名额什么时候空出来。
 *
 * 为什么要它：cap=6 时最坏要等近 1 小时（实测：滑动窗口下 6 次集中在开头几分钟，
 * 之后要等最早那次过期）。这段时间里面板只说「已攒 N 条」，客户不知道要等多久，
 * 容易以为卡死了。算出具体时刻，就能写「约 43 分钟后可再唤醒」。
 */
export function nextWaketimeAt(wakeTimes, cap, now = Date.now()) {
  const times = pruneWakeTimes(wakeTimes, now).sort((a, b) => a - b)
  const n = Math.max(1, Number(cap) || 6)
  if (times.length < n) return now
  // 需要等最早的那 n 个里第一个过期：第 (times.length - n) 个之后的那次过期就空出一个名额
  const freeing = times[times.length - n]
  return freeing + 60 * 60 * 1000
}

/**
 * 同一条会话在过去一小时被唤醒了几次（跨所有守）。
 *
 * 为什么需要：`maxWakesPerHour` 是**按守**算的。一条会话守 5 个仓库时，
 * 上限实际是 5 × 6 = 30 次/小时 —— 这根本没保护到"别把会话的上下文打爆"，
 * 而那正是当初设这个上限的原因。
 *
 * 类比：只给单个 Pod 设 CPU limit，并不能防止整个 namespace 被打满，所以还要 ResourceQuota。
 * 出处：https://kubernetes.io/docs/concepts/policy/resource-quotas/
 */
export function sessionWakesLastHour(entries, sessionId, now = Date.now()) {
  if (!sessionId) return 0
  const list = Array.isArray(entries) ? entries : Object.values(entries || {})
  let total = 0
  for (const entry of list) {
    if (!entry || entry.sessionId !== sessionId) continue
    total += pruneWakeTimes(entry.wakeTimes, now).length
  }
  return total
}

/**
 * 把同一会话在几秒内产生的多条唤醒合并成一条。
 *
 * 实测（本轮）：同会话 3 个守、间隔都是 60 秒时，首轮抖动只把相位拉开 ≤5 秒，
 * **之后每一轮都一样** —— 三次唤醒落在 ~1 秒内，会话会连着收到 3 条注入。
 * 5 个守就是 5 条。这正是"上下文被瞬间打爆"的真实形态。
 *
 * 合并而不是"设个间隔挡掉"：硬间隔会让先到的守永远赢，后面的守被饿死。
 */
export function mergeWakeTexts(parts, options = {}) {
  const list = (Array.isArray(parts) ? parts : []).filter((t) => typeof t === 'string' && t.trim())
  if (list.length === 0) return ''
  if (list.length === 1) return list[0]
  // 每条唤醒都带着同一段【完成标准】和目标行 —— 合并后重复 3 遍纯属噪音（实测占约 40% 长度）。
  // 只保留第一份；内容不同的（不同仓库的完成标准确实不同）则各自保留。
  const seenCriteria = new Set()
  const seenGoal = new Set()
  const trimmed = list.map((text) => {
    let out = text
    const criteriaAt = out.indexOf('【完成标准】')
    if (criteriaAt >= 0) {
      const block = out.slice(criteriaAt)
      if (seenCriteria.has(block)) out = out.slice(0, criteriaAt).replace(/[\s]+$/, '')
      else seenCriteria.add(block)
    }
    out = out
      .split(String.fromCharCode(10))
      .filter((line) => {
        if (!line.startsWith('本条目主理目标：')) return true
        if (seenGoal.has(line)) return false
        seenGoal.add(line)
        return true
      })
      .join(String.fromCharCode(10))
    return out
  })
  // 「接下来」那一整段是每次唤醒都一样的收尾（三条动作）。合并后重复 N 遍纯噪音：
  // 它就是同一份指令，客户读一遍就够。依据：SRE 的「Every page should be actionable」，
  // 但 actionable 不等于把同一份指令印 N 次。
  const TAIL = '接下来：'
  // 审核 T31 M2：先把「接下来」整段抽出来，再做去重 ——
  // 以前去重会从【完成标准】一口气切到末尾，把「接下来」也切掉，
  // 于是「合并多条」这个最需要指令的场景反而一条指令都没有。
  const tailBlock = (() => {
    for (const text of trimmed) {
      const at = text.indexOf(TAIL)
      if (at >= 0) return text.slice(at).replace(/[\s]+$/, '')
    }
    return ''
  })()
  const stripped = trimmed.map((text) => {
    const at = text.indexOf(TAIL)
    return at < 0 ? text : text.slice(0, at).replace(/[\s]+$/, '')
  })

  const brandName = normalizeBrandName(options && options.brandName)
  const head = '【' + brandName + '】这一小段时间内有 ' + list.length + ' 处变化，合并成一条：'
  const body = stripped.map((text, i) => String.fromCharCode(10, 10) + '—— 第 ' + (i + 1) + ' 处 ——' + String.fromCharCode(10) + text).join('')
  return head + body + (tailBlock ? String.fromCharCode(10, 10) + tailBlock : '')
}

/**
 * 该不该现在回收隔离区。
 *
 * 现状：每次唤醒都跑一遍回收 —— 里面是 `git worktree remove` / `branch -D` / `prune`
 * （本机实测 `worktree add` 0.19s，remove 同级；5 个过期副本就是 1 秒级），
 * 而绝大多数时候根本没有过期副本。
 *
 * 节流规则：
 * - 数量**超上限**时必须立刻回收（不能等，否则会堆）；
 * - 没超额时，距上次回收不足 `intervalMs`（默认 10 分钟）就跳过。
 */
export function shouldRunCleanup({ count = 0, keepCount = 5, lastRunAt = 0, now = Date.now(), intervalMs = 10 * 60 * 1000 } = {}) {
  const total = Number(count) || 0
  const cap = Math.max(1, Number(keepCount) || 5)
  if (total > cap) return { run: true, reason: 'over-cap' }
  const last = Number(lastRunAt) || 0
  if (last > 0 && now - last < Number(intervalMs)) return { run: false, reason: 'throttled' }
  return { run: true, reason: 'interval' }
}

/**
 * 迷你时间线：最近 N 条事件（唤醒 / 攒着 / 限流 / 回收 / 报错 / ack）。
 *
 * 为什么不用 `history`：那个只记"成功唤醒过哪几条"，回答不了"为什么没叫醒"。
 * 事件流按 OTel 的语义组织：一条事件 = 时间 + 类型 + 一句人话 + 可选属性，
 * 有界（只留最近 N 条），所以即使跑一整夜也不会把状态文件撑大。
 * 出处：https://opentelemetry.io/docs/concepts/signals/logs/
 */
export function pushEvent(events, event, max = 20) {
  const list = Array.isArray(events) ? events.slice() : []
  const limit = Math.max(1, Number(max) || 20)
  if (!event || typeof event !== 'object' || !event.kind) return list.slice(-limit)
  const at = event.at || new Date().toISOString()
  const next = {
    at,
    // since：首次发生时间。合并时**不更新**，这样"这事从什么时候开始"仍然查得到。
    since: at,
    kind: String(event.kind).slice(0, 24),
    text: String(event.text || '').slice(0, 160),
  }
  // 连续同一条事件合并成一条带次数 —— 否则"撞上限"这种每轮都一样的记录会刷满 20 条，
  // 把真正有用的一次性事件挤掉（噪声淹没信号是这个界面最不该犯的错）。
  const last = list[list.length - 1]
  if (last && last.kind === next.kind && last.text === next.text) {
    last.at = next.at
    last.count = (Number(last.count) || 1) + 1
    if (!last.since) last.since = last.at // 老数据补一个，免得显示成"持续 0 分钟"
    return list.slice(-limit)
  }
  list.push(next)
  return list.slice(-limit)
}

/**
 * "持续了多久"：合并事件时 at 是最新、since 是首次，两者之差就是这个状态持续的时间。
 * 面板上写「×10 · 持续 42 分钟」比只写「×10」有用得多 —— 前者能回答"卡了多久"。
 */
export function durationText(sinceIso, untilIso) {
  const from = Date.parse(String(sinceIso || ''))
  const to = Date.parse(String(untilIso || ''))
  if (!Number.isFinite(from) || !Number.isFinite(to) || to < from) return ''
  const minutes = Math.floor((to - from) / 60000)
  if (minutes < 1) return '不到 1 分钟'
  if (minutes < 60) return minutes + ' 分钟'
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  return rest > 0 ? hours + ' 小时 ' + rest + ' 分' : hours + ' 小时'
}

/**
 * "叫醒了但没回音"的连续次数。
 *
 * 为什么值得统计：唤醒只保证**消息送到了**，不保证**有人动手**。
 * 客户最容易遇到的情况恰恰是"守在工作、消息也进去了，但会话没处理" ——
 * 因为仓库的 AGENTS.md 没给规则、或者任务书里的完成标准被忽略。
 * 这类问题在现有指标里完全看不到（wake 计数还在涨）。
 *
 * 判据：上一次唤醒之后有没有出现过 ack：
 * - 有 ack → 连续次数清零；
 * - 没有 → 次数 +1。
 * 依据（ack 语义）：RabbitMQ 的 consumer acknowledgement —— 投递成功不代表处理完成，
 * 必须由消费者显式 ack 才能确认。（https://www.rabbitmq.com/docs/confirms）
 */
export function silentStreak({ previousWakeAt, lastAckedAt, previousStreak = 0 } = {}) {
  const streak = Math.max(0, Number(previousStreak) || 0)
  const wakeAt = Date.parse(String(previousWakeAt || ''))
  if (!Number.isFinite(wakeAt)) return streak // 还没唤醒过：保持原状
  const ackAt = Date.parse(String(lastAckedAt || ''))
  if (Number.isFinite(ackAt) && ackAt >= wakeAt) return 0
  return streak + 1
}

/**
 * 按仓库汇总：守 5 个仓库时，平铺的列表看不出"哪个健康、哪个一直跳过"。
 *
 * 这是渐进披露（progressive disclosure）在数据层的落实：
 * 先给每仓库一行摘要，细节留在下面的明细里。
 * 出处：https://www.nngroup.com/articles/progressive-disclosure/
 */
export function summarizeByRepo(watchers) {
  const list = Array.isArray(watchers) ? watchers.filter((w) => w && w.repo) : []
  const groups = new Map()
  for (const watcher of list) {
    const repo = String(watcher.repo)
    const group = groups.get(repo) || { repo, count: 0, lastWake: null, lastPoll: null, silentWakes: 0, errors: 0, enabled: 0, badges: [] }
    group.count += 1
    if (watcher.enabled !== false) group.enabled += 1
    if (watcher.lastWake && (!group.lastWake || String(watcher.lastWake) > String(group.lastWake))) group.lastWake = watcher.lastWake
    if (watcher.lastPoll && (!group.lastPoll || String(watcher.lastPoll) > String(group.lastPoll))) group.lastPoll = watcher.lastPoll
    group.silentWakes = Math.max(group.silentWakes, Number(watcher.silentWakes) || 0)
    if (watcher.lastError) group.errors += 1
    for (const badge of repoBadges(watcher.repoAccess) || []) {
      if (!group.badges.some((b) => b.text === badge.text)) group.badges.push(badge)
    }
    groups.set(repo, group)
  }
  // 有问题的排前面：错误 > 未回音 >= 2 > 其余；同类按仓库名
  const weight = (g) => (g.errors > 0 ? 0 : g.silentWakes >= 2 ? 1 : 2)
  return [...groups.values()].sort((a, b) => (weight(a) - weight(b)) || a.repo.localeCompare(b.repo))
}

/**
 * 有几条守正被"频率上限"挡着。
 *
 * 之前是面板去匹配提示文案（`lastDeferred.includes('上限')`）—— 文案一改统计就废。
 * 现在服务端在暂停时写一个明确的 `deferReason`，这里只按字段统计。
 */
export const CAP_REASONS = ['cap-session', 'cap-watcher']

export function countCapped(watchers) {
  const list = Array.isArray(watchers) ? watchers : Object.values(watchers || {})
  return list.filter((w) => w && CAP_REASONS.includes(w.deferReason)).length
}

/**
 * 把一批新条目拆成「这次唤醒的」和「剩下的」。
 *
 * 为什么单独成一个函数：剩余绝不能写成 `fresh.slice(listed.length)` ——
 * `batchFresh` 会按优先级重排，切片会把已经选中的条目又算进剩余，
 * 于是唤醒消息里会出现「#77 …（另有 1 条：#77）」这种重复（首次演练脚本抓到过）。
 */
export function splitBatch(fresh, limit = 3, priority) {
  const listed = batchFresh(fresh, limit, priority)
  const picked = new Set(listed.map((item) => item.number))
  const rest = (Array.isArray(fresh) ? fresh : []).filter((item) => !picked.has(item.number))
  return { listed, rest }
}

/**
 * 单条条目的追踪：它到底经历了什么（被过滤 / 被冷却吸收 / 上报过 / 还在等）。
 *
 * 客户会问"这条 issue 为什么没叫醒我"。这个问题以前只能靠三处分散的数据
 * （seen 水位、filteredLog、history）自己在脑子里拼 —— 这里拼好并返回结构化结果。
 * 类比 SQL 的 EXPLAIN：不改变行为，只解释"为什么是这个结果"。
 * 出处：https://www.postgresql.org/docs/current/sql-explain.html
 */
export function itemTrace(watcher, number) {
  // 注意 String(null) === 'null' —— 先判断入参本身，别让 null 变成一个合法编号
  if (!watcher || number === null || number === undefined || number === '') return null
  const target = String(number).trim()
  if (!target) return null
  const seen = (watcher.seen && watcher.seen[target]) || null
  const reported = (watcher.lastReported && watcher.lastReported[target]) || null
  const filtered = (Array.isArray(watcher.filteredLog) ? watcher.filteredLog : [])
    .filter((entry) => String(entry.number) === target)
    .map((entry) => ({ at: entry.at, reason: entry.reason, title: entry.title }))
  const absorbed = (Array.isArray(watcher.absorbedLog) ? watcher.absorbedLog : [])
    .filter((entry) => String(entry.number) === target)
    .map((entry) => ({ at: entry.at, title: entry.title }))
  const wakes = (Array.isArray(watcher.history) ? watcher.history : [])
    .filter((entry) => Array.isArray(entry.numbers) && entry.numbers.map(String).includes(target))
    .map((entry) => ({ at: entry.at, ok: Boolean(entry.ok), reason: entry.reason || null }))

  let verdict
  if (filtered.length > 0 && !seen && !reported) verdict = '被过滤掉了：' + (filtered[filtered.length - 1].reason || '未知原因')
  else if (wakes.some((w) => w.ok)) verdict = '已经唤醒过 ' + wakes.filter((w) => w.ok).length + ' 次'
  else if (absorbed.length > 0) verdict = '被冷却期吸收了（' + (absorbed[absorbed.length - 1].at || '未知时间') + '）—— 那一批刚唤醒过，等下一轮'
  else if (seen) verdict = '已记入水位但没唤醒（仅观察，或上报前就已存在）'
  else if (wakes.length > 0) verdict = '尝试唤醒过 ' + wakes.length + ' 次但都没成功'
  else verdict = '还没轮到它（可能还没被轮询到，或在批外）'

  return { number: target, repo: watcher.repo || null, seen, reported, filtered, absorbed, wakes, verdict }
}

/**
 * 用满了该调到多少？给一个具体数字，而不是让客户自己算。
 *
 * 依据：离线模拟（3 仓库 / 每仓库每小时 10 条 / 会话上限 12）显示
 * 一小时只能处理 12 条、剩 18 条排队 —— 也就是"想全部处理，需要约 30 次/小时"。
 * 所以规则取「翻倍 + 封顶 60」，既给足余量，也不至于一次跳到不合理的大数。
 */
export function suggestSessionCap({ used = 0, cap = 12, capped = 0, max = 60 } = {}) {
  const u = Math.max(0, Number(used) || 0)
  const c = Math.max(1, Number(cap) || 12)
  const blocked = Math.max(0, Number(capped) || 0)
  if (u < c) return null // 还没用满，不需要建议
  const doubled = c * 2
  const wanted = blocked > 0 ? doubled : c + Math.ceil(c / 2)
  return Math.min(Math.max(1, Number(max) || 60), wanted)
}

/**
 * 按天累计唤醒次数，只保留最近 N 天（默认 7）。
 *
 * 为什么需要：上限建议目前只看"当前这一小时"，是瞬时值 ——
 * 偶尔一次积压就建议翻倍，客户可能被误导。留一份极小的历史（每天一个数，几十字节），
 * 面板就能显示"过去 7 天共 N 次"，让判断有上下文。
 * 用 map 而不是数组：同一天多次唤醒只加同一条，天然去重。
 */
export function bumpDailyWakes(daily, atIso = new Date().toISOString(), keepDays = 7) {
  const day = String(atIso).slice(0, 10)
  const map = (daily && typeof daily === 'object' && !Array.isArray(daily)) ? { ...daily } : {}
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return map
  map[day] = (Number(map[day]) || 0) + 1
  const days = Object.keys(map).sort().slice(-Math.max(1, Number(keepDays) || 7))
  const out = {}
  for (const key of days) out[key] = map[key]
  return out
}

/** 最近几天的总量与日均（给面板显示用；没有数据就返回 null）。 */
export function dailySummary(daily, todayIso = new Date().toISOString()) {
  const map = (daily && typeof daily === 'object' && !Array.isArray(daily)) ? daily : {}
  const values = Object.values(map).map(Number).filter((n) => Number.isFinite(n) && n >= 0)
  if (values.length === 0) return null
  const total = values.reduce((a, b) => a + b, 0)
  const day = String(todayIso).slice(0, 10)
  return {
    days: values.length,
    total,
    avg: Math.round((total / values.length) * 10) / 10,
    today: Number(map[day]) || 0,
  }
}

/**
 * 「今天明显比平时忙」：只在有足够历史、且高出很多倍时才提示。
 *
 * 阈值故意保守（默认 2 倍 + 至少 3 天数据）——
 * 拿历史去影响判断，最怕的是频繁误报；宁可少提示，也不要制造噪音。
 */
export function busierThanUsual(summary, { factor = 2, minDays = 3 } = {}) {
  if (!summary || !Number.isFinite(Number(summary.days)) || summary.days < minDays) return false
  const avg = Number(summary.avg) || 0
  const today = Number(summary.today) || 0
  if (avg <= 0) return false // 历史为 0 时没有可比基线
  return today >= avg * Math.max(1.5, Number(factor) || 2)
}

/**
 * 默认 ack 标签（issue #11）：GitHub 用 `主理鱼:已处理`，Gitee 因为标签名不允许半角冒号用
 * `主理鱼-已处理`。品牌配置可以从 `labels` 传进来；不传时保持 0.10.0 的默认。
 *
 * @param {'github'|'gitee'|undefined} provider
 * @param {{github?: string, gitee?: string}} [labels]
 */
export function defaultAckLabelFor(provider, labels) {
  const map = labels && typeof labels === 'object' ? labels : null
  if (provider === 'gitee') return (map && map.gitee) || DEFAULT_ACK_LABEL_GITEE
  return (map && map.github) || DEFAULT_ACK_LABEL
}

/**
 * `watch_status` 的结构化视图：同一份数据，既能渲染成人读的文本，也能给 agent 解析。
 *
 * 为什么要有它：工具输出原来是拼接的字符串，agent 只能靠字符串匹配 —— 一改文案就崩。
 * 现在纯函数产出结构，文本只是它的一种渲染（两边永远一致）。
 */
export function statusView(entries, options = {}) {
  const list = (Array.isArray(entries) ? entries : Object.values(entries || {})).filter(Boolean)
  const sessionId = options.sessionId || (list[0] && list[0].sessionId) || null
  const capped = countCapped(list)
  const used = sessionId ? sessionWakesLastHour(list, sessionId) : 0
  const cap = Number((list[0] && list[0].sessionMaxWakes)) || 12
  return {
    // 消费方靠它判断字段语义有没有变；改字段时这个数一起加
    schemaVersion: 1,
    session: {
      id: sessionId,
      used,
      cap,
      capped,
      suggest: list.length === 0 ? null : suggestSessionCap({ used, cap, capped }),
    },
    watchers: list.map((w) => ({
      repo: w.repo || null,
      // 两家仓库同名时（owner/name 在 GitHub 与 Gitee 都存在），只有 provider 能区分
      provider: w.provider === 'gitee' ? 'gitee' : 'github',
      sessionId: w.sessionId || null,
      enabled: w.enabled !== false,
      intervalSec: Number(w.intervalSec) || 60,
      observe: w.observe === true,
      isolated: w.isolated === true,
      activeHours: w.activeHours || null,
      labels: (w.filters && Array.isArray(w.filters.labels)) ? w.filters.labels.slice() : [],
      onlyAssigned: Boolean(w.filters && w.filters.onlyAssigned),
      // 可写配置必须回传，模型才能用 watch_status 自查 watch_start 是否真正生效。
      batchLimit: w.batchLimit ?? 5,
      maxWakesPerHour: w.maxWakesPerHour ?? 6,
      sessionMaxWakes: w.sessionMaxWakes ?? 12,
      isolateKeepDays: w.isolateKeepDays ?? 3,
      maxIsolated: w.maxIsolated ?? 5,
      ackLabel: w.ackLabel ?? defaultAckLabelFor(w.provider, options.defaultAckLabels),
      workdir: w.workdir ?? null,
      // 补齐缺省开关，同时保留面板写入的 stale 等扩展项；拷贝对象避免共享引用。
      priority: { ...DEFAULT_PRIORITY, ...((w.priority && typeof w.priority === 'object' && !Array.isArray(w.priority)) ? w.priority : {}) },
      ignoreLabels: (w.filters && Array.isArray(w.filters.ignoreLabels)) ? w.filters.ignoreLabels.slice() : [],
      assignee: (w.filters && w.filters.assignee) || null,
      allowAuthors: (w.filters && Array.isArray(w.filters.allowAuthors)) ? w.filters.allowAuthors.slice() : [],
      deferReason: w.deferReason || null,
      lastDeferred: w.lastDeferred || null,
      silentWakes: Number(w.silentWakes) || 0,
      cursor: w.cursor || null,
      lastPoll: w.lastPoll || null,
      lastWake: w.lastWake || null,
      lastError: w.lastError || null,
      // 审核 T33 M2：`/state` 早就有 kind，`watch_status` 没有 —— 模型无法像面板那样按 kind 选动作。
      // 同源判定，避免两处各写一份。
      lastErrorKind: w.lastError ? classifyGhError(String(w.lastError)).kind : null,
    })),
  }
}

/**
 * 「找不到会话」到底是**被删了**，还是**宿主刚启动还没加载**？
 *
 * 真机现场（2026-11-04 重启后第一轮轮询）：
 *   lastError: 会话已不在：请删除或重建这条主理鱼
 * 而那个会话明明还开着 —— 宿主刚启动时 agents.get() 会短暂返回 undefined。
 * 让客户看到"请删除或重建"这种不可逆建议，比什么都不说更糟。
 *
 * 判据：先给一段宽限期（默认 10 分钟，约 5 个轮询周期）。
 * 宽限期内只写 lastDeferred（不记失败、不退避）；过了宽限期才认定真的没了。
 */
export const SESSION_MISSING_GRACE_MS = 10 * 60 * 1000

export function sessionMissingVerdict({ missingSince, now = Date.now(), graceMs = SESSION_MISSING_GRACE_MS } = {}) {
  const since = Date.parse(String(missingSince || ''))
  if (!Number.isFinite(since)) {
    return { grace: true, startedAt: new Date(now).toISOString(), waitMin: Math.ceil(graceMs / 60000), justNow: true }
  }
  const left = graceMs - (now - since)
  if (left > 0) return { grace: true, startedAt: new Date(since).toISOString(), waitMin: Math.max(1, Math.ceil(left / 60000)) }
  return { grace: false, waitedMin: Math.max(1, Math.round((now - since) / 60000)) }
}

/**
 * 解析仓库写法：`owner/name`、`github:owner/name`、`gitee:owner/name`，
 * 以及 `https://github.com/owner/name`、`https://gitee.com/owner/name`（可带 .git / 结尾斜杠）。
 *
 * 为什么要认 URL：客户是从浏览器地址栏复制的，让他手动删 `https://gitee.com/` 是没必要的摩擦。
 * 认不出来就返回 ok:false + 具体原因，别在轮询阶段才 404。
 */
export function parseRepoSpec(input) {
  const raw = String(input || '').trim()
  if (!raw) return { ok: false, error: 'repo 不能为空' }
  let provider = 'github'
  let rest = raw

  const url = raw.match(/^https?:\/\/([^/]+)\/(.+)$/i)
  if (url) {
    const host = url[1].toLowerCase()
    rest = url[2]
    if (host === 'gitee.com' || host.endsWith('.gitee.com')) provider = 'gitee'
    else if (host === 'github.com' || host.endsWith('.github.com')) provider = 'github'
    else return { ok: false, error: '只支持 github.com 与 gitee.com 的地址' }
  } else {
    const prefixed = raw.match(/^(github|gitee)\s*[:：]\s*(.+)$/i)
    if (prefixed) {
      provider = prefixed[1].toLowerCase()
      rest = prefixed[2]
    }
  }

  rest = rest.replace(/\.git$/i, '').replace(/\/+$/, '')
  // URL 里可能还带着 /issues 之类的尾巴：只取前两段
  const parts = rest.split('/').filter(Boolean)
  if (parts.length < 2) return { ok: false, error: '要写成 owner/name' }
  const [owner, name] = parts
  if (!/^[A-Za-z0-9_.-]+$/.test(owner) || !/^[A-Za-z0-9_.-]+$/.test(name)) {
    return { ok: false, error: 'owner/name 只能包含字母、数字、下划线、点、短横线' }
  }
  // 审核 T19：`.` 和 `..` 能过上面那条字符类（点也算合法字符），于是 `'../..'` 会被当成 owner/name ——
  // 它会一路拼进 URL 与磁盘路径。路径段不许是这两个。
  if (owner === '.' || owner === '..' || name === '.' || name === '..') {
    return { ok: false, error: 'owner/name 不能是 . 或 ..' }
  }
  return { ok: true, provider, repo: owner + '/' + name, spec: provider === 'github' ? owner + '/' + name : 'gitee:' + owner + '/' + name }
}

/**
 * Gitee 没有 `state_reason` 字段 —— 「重新打开」这个信号在它上面永远不出现。
 *
 * 但「上一轮是 closed、这一轮是 open」本身就是 reopen 的定义。这里用上一轮记下的状态自己判，
 * 判出来写回 `state_reason = 'reopened'`，下游的 ⚠ 标记与 +100 加权不用改一行。
 *
 * 只在 Gitee 上调用：GitHub 有原生字段，覆盖它等于篡改事实。
 * 返回新的状态表（调用方存进 entry，键是编号字符串，值只存 open/closed）。
 */
export function markGiteeReopened(items, lastStates = {}) {
  const list = items || []
  for (const item of list) {
    const prev = lastStates[String(item.number)]
    if (!item.state_reason && prev === 'closed' && item.state === 'open') item.state_reason = 'reopened'
  }
  const next = { ...lastStates }
  for (const item of list) next[String(item.number)] = item.state
  // 只留当前这一页见过的：翻页之外的旧状态没有价值，留着就是内存泄漏
  const alive = new Set(list.map((item) => String(item.number)))
  for (const key of Object.keys(next)) if (!alive.has(key)) delete next[key]
  return next
}

/**
 * 一次唤醒的**结算**：成功才推进水位、失败就保留水位。
 *
 * 审核 T20：这段原来是内联在 `pollWithItems()` 里的（171 行、0 覆盖）—— 它恰好是
 * **最会丢消息**的那段：会话忙时如果先把 `seen` 推进、ETag 也提交，下一轮拿到 304 直接 return，
 * 那条 PR 评论**永远不会再叫**，而面板还写「运行中」。
 *
 * 抽成纯函数：给定 entry 与结果，返回**要写回的字段**（不改入参）。调用方 `Object.assign` 即可。
 */
export function planWakeSettlement(entry, { ok, reason, fresh = [], firstSync = false, baseMs = 60000, now = Date.now() } = {}) {
  const at = new Date(now).toISOString()
  const numbers = (fresh || []).map((item) => item && item.number).filter(Boolean)
  // 记下这一批里**最老**的那条是什么时候更新的：没有它，就算不出
  // 「从仓库有动静到会话开始干」的时延（《为什么做这个产品》里的第二个成功指标）。
  const oldest = (fresh || [])
    .map((item) => Date.parse(String((item && (item.updated_at || item.updatedAt)) || '')))
    .filter((t) => Number.isFinite(t))
    .sort((a, b) => a - b)[0]
  const history = pushHistory(entry.history, {
    at,
    numbers,
    ok: Boolean(ok),
    reason: ok ? null : String(reason || '').slice(0, 120),
    oldest: Number.isFinite(oldest) ? new Date(oldest).toISOString() : null,
  })
  const lastWake = ok ? at : 'failed: ' + String(reason || '')

  if (!ok) {
    // 保留水位：下一轮重试这一批。**不许**在这里碰 seen / cursor / etag。
    const busy = /busy|running|idle/i.test(String(reason || ''))
    return {
      lastWake,
      history,
      lastBatch: numbers,
      lastWakeCount: (fresh || []).length,
      commitEtag: false,
      advanceWatermark: false,
      deferReason: 'busy',
      lastDeferred: busy ? '会话正忙，下一轮重试' : (entry.lastDeferred || null),
      bumpBackoff: !busy,
      baseMs,
      // 审核 T33 M3：以前是 `wake failed: session not live` —— 英文内部话，而且面板会把它
      // 显示成「轮询失败」（归错类：轮询其实成功了，失败的是唤醒）。
      // 加 `wake:` 前缀让下游能区分两类；reason 本身已经是客户能看懂的中文。
      error: 'wake: ' + String(reason || ''),
    }
  }

  return {
    lastWake,
    history,
    lastBatch: numbers,
    lastWakeCount: (fresh || []).length,
    // 真正发出去了才允许：水位前移 + ETag 前移
    commitEtag: true,
    advanceWatermark: true,
    seen: advanceSeen(entry.seen, fresh || []),
    lastReported: recordReported(entry, fresh || []),
    cursor: newestUpdatedAt(fresh || []),
    silentWakes: silentStreak({
      previousWakeAt: entry.prevWakeAt,
      lastAckedAt: entry.lastAcked && entry.lastAcked.at,
      previousStreak: entry.silentWakes,
    }),
    prevWakeAt: at,
    wakeTimes: [...(entry.wakeTimes || []), now],
    dailyWakes: bumpDailyWakes(entry.dailyWakes, at),
    lastDeferred: null,
    deferReason: null,
    ackedRecovered: Boolean(entry.prevWakeAt && silentStreak({
      previousWakeAt: entry.prevWakeAt,
      lastAckedAt: entry.lastAcked && entry.lastAcked.at,
      previousStreak: entry.silentWakes,
    }) === 0),
    eventKind: firstSync ? 'baseline' : 'wake',
    eventText: (firstSync ? '首次同步（存量 ' : '唤醒了 ') + numbers.length + ' 条' + (firstSync ? '）' : '') + '：' + numbers.map((n) => '#' + n).join(' '),
    error: null,
  }
}

/**
 * 实际轮询间隔：自己的配置与 GitHub 要求的 `x-poll-interval` 取**大者**。
 *
 * 审核 T23：这个函数以前在 `lib/index.js` 里（不导出），于是测试只能自己算一遍
 * `Math.max(base, minIntervalSec * 1000)` —— **断言的是测试自己的算术**，
 * `Math.max` 写反、写成 `Math.min`、或者忘了乘 1000，测试全都绿。
 * 挪到这里（纯函数、可直接 import）之后，才能真正测它。
 */
export function effectiveIntervalMs(entry, baseMs) {
  const floor = (Number(entry && entry.minIntervalSec) || 0) * 1000
  return Math.max(Number(baseMs) || 0, floor)
}

/**
 * `activeHours` 格式校验（审核 T32）。
 *
 * 以前格式写错（`9-23`、`09:00~23:00`、`9:00-25:00`）时 `inActiveHours` 直接 `return true` ——
 * **静默变成「全天有效」**，而工具回执照样打 `[activeHours=9-23]`。
 * 客户以为设了时段，实际一直开着。
 *
 * 现在创建时先校验：合法返回 `{ ok: true }`，不合法返回 `{ ok: false, reason }`，
 * 由调用方**拒绝**并说清正确格式。
 */
export function validateActiveHours(spec) {
  if (spec === null || spec === undefined || spec === '') return { ok: true, empty: true }
  const text = String(spec).trim()
  const m = text.match(/^(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})$/)
  if (!m) {
    return { ok: false, reason: '格式要写成 HH:MM-HH:MM（例如 09:00-23:00），收到的是「' + text + '」' }
  }
  const bad = [m[1], m[2], m[3], m[4]].map(Number)
  if (bad[0] > 23 || bad[2] > 23 || bad[1] > 59 || bad[3] > 59) {
    return { ok: false, reason: '时要在 00-23、分要在 00-59（格式 HH:MM-HH:MM，例如 09:00-23:00），收到的是「' + text + '」' }
  }
  return { ok: true, normalized: text }
}

/**
 * 「叫醒未回执」的条目（Ticket 状态机的最小版）。
 *
 * 问题：`seen` 水位线一旦前移，同一条只要内容没再更新就**永远不会再被提起**。
 * 于是「叫醒了 → 会话干到一半被打断 → 没有 ack」这一条就**静默消失**了。
 * 而官方原型用 Ticket 的 `open → ended` 状态机表达「这条还在进行中」。
 *
 * 我们不做完整状态机，只补这一条最要命的：**提过但没回执的，下一轮再提一次**。
 *
 * 三条硬约束（都来自「不打断」）：
 * 1. 有次数上限（默认 2 次），提满了就放弃，不再打扰；
 * 2. 冷却期：刚提过的那一轮不提（默认 10 分钟），别紧接着又提；
 * 3. 只提**还开着**的条目 —— 关掉了就说明不用干了。
 */
export function recordPendingWake(pending, numbers, at = new Date().toISOString()) {
  const map = { ...(pending && typeof pending === 'object' ? pending : {}) }
  for (const n of numbers || []) {
    const key = String(n)
    const prev = map[key]
    map[key] = { first: (prev && prev.first) || at, at, tries: ((prev && prev.tries) || 0) + 1 }
  }
  return map
}

/** ack 之后清掉（这条路走通了，不用再提）。 */
export function clearPending(pending, numbers) {
  const map = { ...(pending && typeof pending === 'object' ? pending : {}) }
  for (const n of numbers || []) delete map[String(n)]
  return map
}

/**
 * 这一轮该不该把「提过但没回执」的条目再提一次。
 * @returns {{ retry: Array<object>, stillPending: object }} retry 是要并进批次的条目
 */
export function pendingRetry(pending, items, options = {}) {
  const { maxTries = 2, cooldownMs = 10 * 60 * 1000, now = Date.now() } = options
  const map = pending && typeof pending === 'object' ? pending : {}
  const byNumber = new Map((items || []).map((item) => [String(item && item.number), item]))
  const retry = []
  const stillPending = { ...map }
  for (const [key, record] of Object.entries(map)) {
    const item = byNumber.get(key)
    // 条目已经不在这一页了（关了/删了）：不再提，也不清（可能只是翻页没包含它）
    if (!item) continue
    if (item.state && item.state !== 'open') { delete stillPending[key]; continue }
    const tries = Number(record && record.tries) || 0
    if (tries >= maxTries) { delete stillPending[key]; continue }
    const at = Date.parse(String((record && record.at) || ''))
    if (Number.isFinite(at) && now - at < cooldownMs) continue
    retry.push({ ...item, retryOf: { tries, first: record && record.first, at: record && record.at } })
  }
  return { retry, stillPending }
}

/**
 * 唤醒质量：把《为什么做这个产品》里那三个「怎么算成功」变成能算的数。
 *
 * 没有这三个数，「不打断」就只是信念，不是判断 —— 你没法知道自己在优化还是在变吵。
 *
 * 三个指标：
 * 1. **有动作率** = 叫醒过的条目里，后来 ack 了的比例 —— 低于 0.7 说明叫醒的是噪音；
 * 2. **开工时延** = 从「这条最后一次更新」到「会话被叫醒」的中位数 —— 目标是分钟级；
 * 3. **回执空白** = 叫醒后一直没回音的连续次数（`silentWakes`）。
 *
 * 全部只依赖已有的 history / acked / lastAcked，不新增存储。
 */
export function wakeQuality(entry, options = {}) {
  const { now = Date.now() } = options
  const history = Array.isArray(entry && entry.history) ? entry.history : []
  const acked = (entry && entry.acked && typeof entry.acked === 'object') ? entry.acked : {}
  const lastAcked = (entry && entry.lastAcked && Array.isArray(entry.lastAcked.numbers)) ? entry.lastAcked.numbers : []

  const wokenNumbers = new Set()
  const ackedNumbers = new Set()
  const latencies = []

  // ack 过的一律算「有动作」：不管是这一轮 history 里还是更早的（lastAcked 兜底）
  for (const key of Object.keys(acked)) ackedNumbers.add(String(key))
  for (const n of lastAcked) ackedNumbers.add(String(n))

  let wakeCount = 0
  for (const event of history) {
    if (!event || event.ok !== true) continue
    wakeCount += 1
    for (const n of event.numbers || []) wokenNumbers.add(String(n))
    const at = Date.parse(String(event.at || ''))
    const oldest = Date.parse(String(event.oldest || ''))
    if (Number.isFinite(at) && Number.isFinite(oldest) && at >= oldest) latencies.push(at - oldest)
  }

  let hit = 0
  for (const n of wokenNumbers) if (ackedNumbers.has(n)) hit += 1

  latencies.sort((a, b) => a - b)
  const medianLatencyMs = latencies.length === 0
    ? null
    : latencies[Math.floor(latencies.length / 2)]

  return {
    wakeCount,
    itemsWoken: wokenNumbers.size,
    itemsAcked: hit,
    // 没叫醒过就没有分母 —— 返回 null 而不是 0，别让「没数据」看起来像「做得很差」
    actionRate: wokenNumbers.size === 0 ? null : Math.round((hit / wokenNumbers.size) * 100) / 100,
    medianLatencyMs,
    silentWakes: Number((entry && entry.silentWakes) || 0),
    // 给面板一句话用：不达标的地方直接说
    verdict: wokenNumbers.size === 0
      ? '还没有叫醒过'
      : (hit / wokenNumbers.size < 0.7
        ? '叫醒后有动作的比例偏低（' + hit + '/' + wokenNumbers.size + '）—— 可能叫醒的是噪音'
        : '正常（' + hit + '/' + wokenNumbers.size + ' 有动作）'),
    // 注意：**不要**在这里放 computedAt —— 每次调用都变，`/state` 的 ETag 就永远不 304。
  }
}
