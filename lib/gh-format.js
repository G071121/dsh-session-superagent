// GitHub 交互层：把 API 的数据变成「人话」和「可判断的结论」。
//
// 从 watch.js 拆出来的理由：另一半是**调度与状态**（去重水位、退避、时段、合并写）。
// 两块的修改动机完全不同 —— 改「唤醒消息多一行」不需要看调度代码，反之亦然。
// 拆完 watch.js 从 883 行降到 ~470 行，这边自成一体、对 watch.js 零依赖（已用脚本核对过）。
//
// 约定：本文件只做「解析 / 归类 / 措辞」，不发请求、不碰状态。

/**
 * gh 返回空/坏内容时，先分清是「凭证问题」还是「代理/网络问题」。
 *
 * 真机现场：令牌失效后 `gh api` 输出为空，我们却说「可能是代理干扰」—— 客户会去查代理，
 * 而真正要做的是 `gh auth login`。
 * 依据：GitHub 排障文档在结果不对时要求「confirm that the authentication credentials … have access」
 * 出处：https://docs.github.com/en/rest/using-the-rest-api/troubleshooting-the-rest-api#missing-results
 */
/** 凭证是否已失效（`gh auth status` 的输出判定）。抽出来给所有入口共用。 */
export function isAuthBroken(authStatusText) {
  return /token in keyring is invalid|Failed to log in|Bad credentials|requires authentication/i.test(String(authStatusText || ''))
}
export function diagnoseBadBody({ bodyText, authStatusText } = {}) {
  const body = String(bodyText ?? '').trim()
  // 有内容但不是 JSON：先分清是「我们切错了」还是「上游/代理给的不是 JSON」
  if (body.length > 0) {
    // ① 本地切分错误：正文以 HTTP 状态行开头，说明头/体没切开（`gh --include` 的行尾差异就会这样）。
    //    这一条最值钱 —— 以前它落到「可能是代理干扰」，把客户往网络上游带，实际一行都不用查。
    //    真机来源：2026-11-03 Windows 上 CRLF 头体分隔（PR #2 修复）；这里防的是"下次换个行尾再犯"。
    if (/^HTTP\/[0-9.]+\s+[0-9]{3}\b/i.test(body)) {
      return {
        kind: 'local-parse',
        hint: '（正文以 HTTP 状态行开头：这是本地解析问题，不是网络问题 —— 请升级插件并把这段贴到 issue）',
      }
    }
    if (/^<(!doctype|html)|<body|Bad Gateway|Service Unavailable|Gateway Time-?out/i.test(body)) {
      return { kind: 'gateway', hint: '（返回的是网页而不是 JSON：本地代理/网关拦了请求 —— 检查代理设置）' }
    }
    return null
  }
  return diagnoseEmptyBody({ bodyText, authStatusText })
}

export function diagnoseEmptyBody({ bodyText, authStatusText } = {}) {
  const body = String(bodyText ?? '').trim()
  if (body.length > 0) return null
  const auth = String(authStatusText ?? '')
  if (isAuthBroken(auth)) {
    return { kind: 'auth', hint: '（gh 没有返回内容，且凭证已失效：跑 gh auth login 重新登录）' }
  }
  return { kind: 'empty', hint: '（gh 没有返回内容：可能是代理拦截或未登录 —— 跑 watch_doctor 看凭证）' }
}
/**
 * 把 `gh` 调用的结果整理成给 agent 看的一段文本。
 *
 * 为什么要单独抽出来：`github` 工具原来只贴原始 stderr + `[exit code: N]`，
 * agent 拿到「gh: HTTP 404」还得自己猜该动什么。这里统一补上分类与下一步。
 * 依据：GitHub 官方要求「do not ignore repeated 4xx/5xx」——
 * 失败必须带着可执行的动作回到调用方。
 * 出处：https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api
 */
export function formatGhCall({ code, text, classify }) {
  const body = String(text || '').trim() || '(empty)'
  const failed = Number(code) !== 0
  const why = failed ? classify(body) : null
  // 304 是「没变化」，不是失败：别让调用方以为出错了
  if (why && why.kind === 'notmodified') {
    return body + String.fromCharCode(10) + why.hint + String.fromCharCode(10) + '[exit code: ' + code + '][kind: notmodified]'
  }
  if (failed) {
    return body + String.fromCharCode(10) + why.hint + String.fromCharCode(10) + '[exit code: ' + code + '][kind: ' + why.kind + ']'
  }
  return body + String.fromCharCode(10) + '[exit code: ' + code + ']'
}
export function classifyGhError(detail) {
  const text = String(detail || '')
  // 长 URL 压缩，避免一整条 API 地址占满面板
  const short = text
    .replace(/Get "https?:\/\/[^"]{16,}"/g, 'GitHub API 请求')
    .replace(/Post "https?:\/\/[^"]{16,}"/g, 'GitHub API 请求')
    .slice(0, 200)

  // ── Gitee（REST v5）的三种形状先认 ──────────────────────────────────────
  // 为什么必须排在最前面：Gitee 的报错里**没有** `HTTP <code>` 前缀，措辞也和 GitHub 不同，
  // 以前这些全落到 other —— 面板显示「（没归类的错误…）」，客户根本想不到是标签名写错了。
  // 真机复刻（2026-11-05 本机 curl，可原样重放）：
  //   标签不存在（HTML 404 页，7187 bytes）→ <title>你所访问的页面不存在 (404)</title>
  //   标签不存在（JSON）→ {"message":"404 Not Found"} / {"message":"Not Found Project"}
  //   token 失效（JSON）→ {"message":"401 Unauthorized: Access token does not exist"}
  //   限流 → HTTP 429（常常只有状态行，没有正文）
  // Gitee 的 401 还有**中文**版本（真机 2026-11-05 实测）：
  //   {"message":"登录失效，无权限访问该资源","code":40001}
  // 只认英文会把这条放进 other，客户看到「没归类的错误」而不知道该重新登录。
  // 只认 **Gitee 专属**措辞：`401 Unauthorized` / `429 Too Many Requests` 是两家共用的，
  // 放到这里会抢走 GitHub 的提示（T15 G4）。
  if (/Access token does not exist|登录失效|无权限访问该资源/i.test(text)) {
    return {
      kind: 'auth',
      short,
      hint: '（Gitee 私人令牌无效或没填：到 Gitee「设置 → 私人令牌」重新生成一个，填进面板的 token）',
    }
  }
  if (/HTTP\s+429/i.test(text)) {
    return {
      kind: 'ratelimit',
      short,
      hint: '（被限流（HTTP 429）：等几分钟再重试，别立刻重发；Gitee 上未带私人令牌的请求额度低得多 —— 先确认令牌已填）',
    }
  }
  // 没有 HTTP 前缀的 429（两家都可能这么回）：判限流，但提示是中性的
  if (/429\s+Too\s+Many\s+Requests/i.test(text)) {
    return { kind: 'ratelimit', short, hint: '（被限流（HTTP 429）：等几分钟再重试，别立刻重发）' }
  }
  // 404 的判据分两路：JSON 正文里的 Gitee 专属措辞（GitHub 只说 "Not Found"），
  // 或者一整页 HTML（Gitee 的标签/编号不存在时回的就是 404 页，不是 JSON）。
  // 注意两个「Gitee 专属」判据都不能放宽成裸 `404` / 裸 `Not Found`，否则会抢走 GitHub 的 404。
  const gitee404 = /Not\s+Found\s+Project|"message"\s*:\s*"404\b/i.test(text)
    || (/gitee/i.test(text) && /404|not\s+found|不存在/i.test(text))
    || (/<!doctype\s+html|<html[\s>]|<\/html>/i.test(text) && /404|not\s+found|不存在/i.test(text))
  if (gitee404) {
    return {
      kind: 'notfound',
      short,
      hint: '（Gitee 上标签/仓库/编号不存在：确认标签名（区分大小写）、仓库全名，或改用 issue 编号；也可能是 token 没有这个仓库的权限）',
    }
  }

  if (/HTTP 401|Bad credentials|requires authentication/i.test(text)) {
    return { kind: 'auth', short, hint: '（gh 登录失效：跑 gh auth login，或在面板填 token）' }
  }
  // 403 有两种完全不同的意思：限流（等着就行）与权限不足（要改 token/仓库设置）。
  // 出处：https://docs.github.com/en/rest/using-the-rest-api/troubleshooting-the-rest-api#resource-not-accessible
  if (/rate limit|secondary rate limit|abuse detection|API rate limit exceeded/i.test(text)) {
    return { kind: 'ratelimit', short, hint: '（被 GitHub 限流：等几分钟，或换成带 token 的凭证）' }
  }
  if (/HTTP 403|Resource not accessible|Must have admin rights|not have permission|forbidden/i.test(text)) {
    return { kind: 'permission', short, hint: '（权限不足：检查 token 作用域或这个仓库的访问权限）' }
  }
  if (/HTTP 50[0234]|Bad Gateway|Service Unavailable|Gateway Time-?out/i.test(text)) {
    return { kind: 'gateway', short, hint: '（GitHub 或本地代理短暂故障：已按退避自动重试，不需要手动处理；持续出现就检查代理）' }
  }
  // 系统级错误码：含义与动作各不相同（找不到文件 / 没权限 / 管道断了 / 超时）
  // 出处：https://nodejs.org/api/errors.html#common-system-errors
  if (/EACCES|EPERM/i.test(text)) {
    return { kind: 'permfile', short, hint: '（gh 没有执行权限：检查安装权限或重装 gh）' }
  }
  if (/EPIPE|ETIMEDOUT|ECONNRESET|socket hang up/i.test(text)) {
    return { kind: 'network', short, hint: '（连接被中断：网络或代理不稳，已按退避自动重试，不需要手动处理）' }
  }
  // Windows 的 cmd 报法不一样：'gh' is not recognized as an internal or external command
  // 出处（Node 的错误码语义）：https://nodejs.org/api/errors.html#common-system-errors
  if (/ENOENT|gh: command not found|not recognized as an internal or external command/i.test(text)) {
    return { kind: 'nogh', short, hint: '（找不到 gh 命令：确认已安装且在 PATH）' }
  }
  // 条件请求命中：gh 把 304 当失败（非 2xx 就 exit 1），但语义是「没有变化」，不是错误
  if (/HTTP 304|304 Not Modified|not modified/i.test(text)) {
    return { kind: 'notmodified', short, hint: '（没有变化 —— 条件请求命中 304，这不是错误）' }
  }
  // 仓库改名/转移：GitHub 会回 301 或 "has moved"，客户看到的却只是「没动静」
  if (/moved permanently|has moved|HTTP 301|Repository has been moved/i.test(text)) {
    return { kind: 'moved', short, hint: '（仓库改名或转移了：用新地址重新添加，或把守改成新的 owner/name）' }
  }
  if (/HTTP 404|Not Found|not found/i.test(text) && !/command not found/i.test(text)) {
    return { kind: 'notfound', short, hint: '（不存在或没权限 —— 私有仓库也回 404：检查 owner/name 与 token）' }
  }
  if (/EOF|i\/o timeout|connection reset|dial tcp|TLS handshake|no such host|proxyconnect|timeout|context deadline exceeded|certificate|x509|self.signed|unable to get local issuer/i.test(text)) {
    return { kind: 'network', short, hint: '（网络抖动：这一轮没连上 GitHub，已按退避自动重试，不需要手动处理）' }
  }
  // 兜底也要给下一步：客户看到一条没归类的错误，最怕「那我该做什么」
  return { kind: 'other', short, hint: '（没归类的错误：已按退避自动重试；持续出现就跑 watch_doctor 看检查清单，或把这行贴给对方）' }
}

/**
 * 解析 `gh api --include` 的输出：状态行 / 响应头 / 空行 / 正文。
 *
 * 为什么用它而不是直接 `gh api`：GitHub 官方文档明确说
 * 「Make authenticated conditional requests, so that unchanged data does not count against
 * your primary rate limit」—— 带上 If-None-Match 后，没变化时拿 304，
 * 304 **不计入**速率限制。对一个每 N 秒轮询的工具，这是最直接的省额度手段。
 *
 * 出处：https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api
 */
export function parseGhInclude(stdout) {
  const text = String(stdout || '')
  const LF = String.fromCharCode(10)
  const CR = String.fromCharCode(13)
  // 头/体之间那个空行可能是 "\n\n"，也可能是 "\r\n\r\n" —— 取决于 gh 吐响应头时用的行尾。
  // 真机实测（gh 2.103.3 / Windows）：状态行以 LF 结尾、响应头以 CRLF 结尾，分隔处因此是
  // "\r\n\r\n"，而它里面**没有**连续两个 LF。只找 "\n\n" 会返回 -1，于是把整段输出
  // （状态行 + 响应头 + 正文）当成 body 丢给 JSON.parse，每次都失败 ——
  // 面板显示「（返回内容不是合法 JSON：可能是代理干扰）」，把人往代理上带。
  // 两种分隔符都认，取最先出现的那个。
  let idx = -1
  let sepLen = 0
  for (const sep of [CR + LF + CR + LF, LF + LF]) {
    const at = text.indexOf(sep)
    if (at >= 0 && (idx < 0 || at < idx)) { idx = at; sepLen = sep.length }
  }
  const head = idx < 0 ? text : text.slice(0, idx)
  const body = idx < 0 ? text.trim() : text.slice(idx + sepLen)
  const lines = head.split(LF)
  const statusParts = String(lines[0] || '').split(' ')
  const status = Number(statusParts[1]) || 0
  const header = (name) => {
    const needle = name.toLowerCase() + ':'
    for (const line of lines) {
      if (line.toLowerCase().startsWith(needle)) return line.slice(needle.length).trim()
    }
    return null
  }
  const numeric = (name) => {
    const raw = header(name)
    const value = Number(raw)
    return Number.isFinite(value) ? value : null
  }
  const resetSeconds = numeric('x-ratelimit-reset')
  // Stage 2 限流（secondary rate limit）用 Retry-After 告诉你等多久；primary 用 x-ratelimit-reset
  const retryAfterRaw = header('retry-after')
  return {
    status,
    etag: header('etag'),
    remaining: numeric('x-ratelimit-remaining'),
    limit: numeric('x-ratelimit-limit'),
    resetAt: resetSeconds ? new Date(resetSeconds * 1000).toISOString() : null,
    retryAfter: Number.isFinite(Number(retryAfterRaw)) ? Number(retryAfterRaw) : null,
    // GitHub 用这个头告诉你「这个 endpoint 至少隔多久再问」——忽略它会白撞额度
    pollInterval: (() => { const raw = header('x-poll-interval'); return raw && Number.isFinite(Number(raw)) ? Number(raw) : null })(),
    body,
  }
}

/**
 * 额度自适应：GitHub 主额度快用完时，不要继续按固定间隔撞墙。
 *
 * 依据：GitHub 每次响应都带 `X-RateLimit-Remaining` / `X-RateLimit-Reset`
 * （实测 `gh api --include` 的输出里就是这几个头）。
 * 剩余低于阈值时，把下一次轮询推到额度重置时间（最多等 1 小时），而不是继续发请求。
 */
/**
 * GitHub 的「第二阶段限流」会在 403/429 响应里带 `Retry-After: <秒>`。
 * 按它等，比我们瞎猜一个退避时间准确得多。
 * 依据：GitHub 暴露头里明确包含 `Retry-After`（实测 `gh api --include` 的
 * Access-Control-Expose-Headers 一行里就能看到），且官方限流文档要求遵守它。
 */
export function retryAfterMs(retryAfter, { capMs = 3600 * 1000 } = {}) {
  const seconds = Number(retryAfter)
  if (!Number.isFinite(seconds) || seconds <= 0) return 0
  return Math.min(capMs, Math.round(seconds * 1000))
}

export function throttleDelayMs({ remaining, resetAt, now = Date.now(), threshold = 500, capMs = 3600 * 1000 } = {}) {
  if (remaining === null || remaining === undefined) return 0
  if (Number(remaining) >= Number(threshold)) return 0
  const reset = Date.parse(resetAt || '')
  if (!Number.isFinite(reset)) return Math.min(capMs, 5 * 60 * 1000)
  const wait = reset - now + 1000
  if (wait <= 0) return 0
  return Math.min(capMs, wait)
}

/**
 * 去同步抖动：给每个 watcher 一个**确定性的**起始偏移，避免 N 条守在同一条时间线上一起发车。
 *
 * 为什么不用随机数：随机数每次启动都不同，调试时对不上；用 id 的哈希则「同一条守永远同一个偏移」，
 * 既错峰又可复现。范围固定在 [0, windowMs)。
 *
 * 依据：AWS Architecture Blog 的《Exponential Backoff And Jitter》——同步发车会让
 * 下游在整点承压，加入抖动后峰值被摊平。（https://aws.amazon.com/blogs/architecture/exponential-backoff-and-jitter/）
 */
export function jitterMs(key, windowMs) {
  const width = Math.max(0, Math.floor(Number(windowMs) || 0))
  if (width === 0) return 0
  const text = String(key || '')
  let hash = 0
  for (let i = 0; i < text.length; i += 1) hash = (hash * 31 + text.charCodeAt(i)) % 1000003
  return hash % width
}

/**
 * 把「为什么没叫醒」做成可统计的分布。
 *
 * 背景：我们每轮只留最近 5 条过滤记录（`filteredLog`），客户想知道
 * 「为什么我加的标签一条都没被叫醒」时看不出全貌。这里按原因累计次数，
 * 面板上就能直接读「不在标签白名单: ai-fix × 37」这种结论。
 *
 * 依据：GitHub 的 issue 过滤语义本身就是「限定词 + 集合运算」
 * （label:/assignee:/state:…，见 GitHub 文档「Filtering and searching issues」），
 * 所以「被哪条限定词刷掉」比「被刷掉」更值得告诉用户。
 */
export function countReasons(counts, reason, { maxKinds = 12 } = {}) {
  const map = { ...(counts || {}) }
  if (!reason) return map
  const key = String(reason).slice(0, 60)
  map[key] = (Number(map[key]) || 0) + 1
  const entries = Object.entries(map).sort((a, b) => b[1] - a[1]).slice(0, maxKinds)
  return Object.fromEntries(entries)
}

/**
 * 仓库权限提示：只读仓库上我们**没法**回写结果（评论、打标签都会 403）。
 *
 * 依据：`GET /repos/{owner}/{repo}` 返回 `permissions.push`，官方文档里这个对象就是
 * "你有没有写权限"的权威来源。事先知道，比跑到一半才发现 403 好。
 * 出处：https://docs.github.com/en/rest/repos/repos#get-a-repository
 */
export function accessNote(repoAccess) {
  if (!repoAccess || typeof repoAccess !== 'object') return ''
  if (repoAccess.push === true) return ''
  if (repoAccess.push === false) {
    return '你对 ' + String(repoAccess.repo || '这个仓库') + ' 只有读权限：能看、能被叫醒，但没法回写评论或打标签 —— '
      + '要么换有写权限的 token，要么把结论写在本地/PR 描述里。'
  }
  return ''
}

/**
 * 仓库结构提示：主理鱼只认 issue/PR，所以「这个仓库没有 issue」要提前说。
 *
 * 依据：`GET /repos/{owner}/{repo}` 返回 `has_issues` / `fork` / `parent.full_name`
 * （本机实测这三个字段都在：`{fork, has_issues, parent, private}`）。
 * 出处：https://docs.github.com/en/rest/repos/repos#get-a-repository
 */
export function repoStructureNote(repoAccess) {
  if (!repoAccess || typeof repoAccess !== 'object') return ''
  const repo = String(repoAccess.repo || '这个仓库')
  if (repoAccess.archived === true) {
    return repo + ' 已归档：GitHub 上归档仓库是只读的，评论和打标签都会失败 —— 守它只能看、不能回写。'
  }
  if (repoAccess.disabled === true) {
    return repo + ' 已被禁用：这个仓库当前不可用，主理鱼不会拿到任何条目。'
  }
  if (repoAccess.hasIssues === false) {
    return repo + ' 关闭了 Issues —— 主理鱼只认 issue / PR，这里不会有任何条目可接。'
  }
  if (repoAccess.fork === true && repoAccess.parent && repoAccess.hasIssues !== true) {
    return repo + ' 是 ' + String(repoAccess.parent) + ' 的 fork。fork 默认不带 Issues，'
      + 'issue 大多落在上游 —— 确认你要守的是哪一个（守上游就把仓库填成 ' + String(repoAccess.parent) + '）。'
  }
  return ''
}

/**
 * 仓库能力徽章：把「这条守到底能不能干活」压缩成几个短标签。
 *
 * 依据：`GET /repos` 的 `archived` / `disabled` / `private` / `fork` / `has_issues` / `permissions.push`
 * 就是全部需要的判断依据（本机实测 atom/atom 的 `archived` 为 true）。
 * 出处：https://docs.github.com/en/rest/repos/repos#get-a-repository
 */
export function repoBadges(repoAccess) {
  if (!repoAccess || typeof repoAccess !== 'object') return []
  const badges = []
  // 归档仓库在 GitHub 上是完全只读的：评论、打标签都会失败 —— 比"没有写权限"更彻底
  if (repoAccess.archived === true) badges.push({ text: '已归档', tone: 'warning' })
  if (repoAccess.disabled === true) badges.push({ text: '已禁用', tone: 'danger' })
  if (repoAccess.hasIssues === false) badges.push({ text: '无 Issues', tone: 'warning' })
  if (repoAccess.fork === true && repoAccess.parent && repoAccess.hasIssues !== true) {
    badges.push({ text: 'fork · 上游 ' + String(repoAccess.parent), tone: 'outline' })
  }
  if (repoAccess.push === false) badges.push({ text: '只读', tone: 'warning' })
  if (repoAccess.private === true) badges.push({ text: '私有', tone: 'outline' })
  return badges
}

/**
 * 仓库名纠错：404 之后从搜索结果里挑一个最像的，别让客户自己猜。
 *
 * 依据：`GET /search/repositories?q=<name>+in:name` 能按仓库名检索；
 * **但它走独立的 search 池**（本机实测 response header：`x-ratelimit-limit: 30`，
 * 即 30 次/分钟，远小于 core 的 5000）—— 所以只能在 404 之后偶尔调用，绝不能每轮轮询都用。
 * 出处：https://docs.github.com/en/rest/search/search#search-repositories
 */
export function pickSuggestion(query, candidates) {
  const wanted = String(query || '').trim().toLowerCase()
  if (!wanted) return null
  const list = Array.isArray(candidates) ? candidates.filter((name) => typeof name === 'string') : []
  const exactName = wanted.includes('/') ? wanted.split('/')[1] : wanted
  // 优先级：仓库名完全相同 > 名字里包含 > 仅 owner 相同（最后这种基本没价值，直接丢）
  const sameName = list.find((name) => name.toLowerCase().endsWith('/' + exactName))
  if (sameName) return sameName
  const contains = list.find((name) => name.toLowerCase().includes(exactName) && exactName.length >= 4)
  return contains || null
}

/**
 * 「最后是谁在说话」：一条 issue 的最后评论者与时间。
 *
 * 为什么要它：会话被叫醒后第一件事就是判断「是不是已经有人处理了」。
 * 只给 issue 作者和更新时间不够 —— 更新时间可能是我自己打的标签引起的。
 *
 * 代价：每条 issue 一次 `GET /issues/{n}/comments`，所以只在**评论数 > 0** 且**批次前几条**里取，
 * 失败就静默省略（宁可少一行，不要拖慢唤醒）。
 * 出处：https://docs.github.com/en/rest/issues/comments#list-issue-comments
 */
export function commentSummaryLine(lastComment, viewer) {
  if (!lastComment || typeof lastComment !== 'object') return ''
  const login = lastComment.login ? String(lastComment.login) : ''
  // 最后一条是"我们自己"发的，意义完全不同：那不是"有人在处理"，而是上一轮留下的痕迹。
  // 依据：GET /user 返回当前 token 对应的账号（本机实测：`gh api user --jq .login` → 我们的账号名）。
  // 出处：https://docs.github.com/en/rest/users/users#get-the-authenticated-user
  const isSelf = Boolean(login && viewer && login.toLowerCase() === String(viewer).toLowerCase())
  const who = login ? (isSelf ? '我（上一轮留的）' : '@' + login) : ''
  const when = lastComment.at ? String(lastComment.at) : ''
  if (!who && !when) return ''
  return [who, when].filter(Boolean).join(' ')
}

/**
 * 批量取"最后一条评论"的 GraphQL 查询：一次请求拿 N 条，别一条一个 REST 调用。
 *
 * 依据：GraphQL 支持别名（alias）在同一请求里查多个 issue，且计费按点数而非请求数；
 * 但我们只用它的"批量"能力，复杂度极低（一个 repository + N 个 issue 别名）。
 * 出处：https://docs.github.com/en/graphql
 */
export function buildCommentBatchQuery(count) {
  const n = Math.max(0, Math.min(10, Number(count) || 0))
  const parts = []
  for (let i = 0; i < n; i += 1) {
    parts.push('  i' + i + ': issue(number: $n' + i + ') { number'
      + ' comments(last: 1) { nodes { author { login } createdAt } }'
      + ' timelineItems(last: 5, itemTypes: [CROSS_REFERENCED_EVENT]) { nodes { ... on CrossReferencedEvent {'
      + ' source { __typename ... on PullRequest { number state url isDraft reviewDecision mergeable statusCheckRollup { state } } } } } }')
  }
  const vars = Array.from({ length: n }, (_, i) => '$n' + i + ': Int!').join(', ')
  return 'query($owner: String!, $name: String!' + (n > 0 ? ', ' + vars : '') + ') {'
    + ' repository(owner: $owner, name: $name) {'
    + String.fromCharCode(10) + parts.join(String.fromCharCode(10)) + String.fromCharCode(10)
    + '} }'
}

/**
 * 解析批量结果：把 {i0: {number, comments:{nodes:[…]}}} 摊平成 {number: {login, at}}。
 * 单个 issue 不存在时 GraphQL 会在 `errors` 里报 NOT_FOUND，但同请求里别的 issue 仍然有值 ——
 * 所以我们**只看 data，不因为 errors 整体放弃**。
 */
export function parseCommentBatch(payload) {
  const out = {}
  const repo = payload && payload.data && payload.data.repository
  if (!repo || typeof repo !== 'object') return out
  for (const value of Object.values(repo)) {
    if (!value || typeof value !== 'object') continue
    const nodes = value.comments && value.comments.nodes
    const node = Array.isArray(nodes) && nodes.length > 0 ? nodes[nodes.length - 1] : null
    if (!node) continue
    const login = node.author && node.author.login ? String(node.author.login) : ''
    const linked = pickLinkedPullRequests(value.timelineItems && value.timelineItems.nodes)
    if (!login && linked.length === 0) continue
    out[String(value.number)] = {
      login,
      at: node.createdAt ? String(node.createdAt) : '',
      linked,
    }
  }
  return out
}

/**
 * REST 兜底取「全线程最后一条评论」的 gh 参数。
 *
 * 为什么不能再用 `per_page=1&sort=created&direction=desc`：GitHub 的 issue comments
 * 接口**不支持** `sort` / `direction`（那是 issue 列表的参数），传了会被**静默忽略**，
 * 于是 `per_page=1` 恒返回**最早**一条 —— 唤醒消息里的「最后评论」一直停在第一条，
 * 会话误判成「对方没回复」后继续 ack（Issue #39 Bug 2）。
 * 唯一正确的口径：拉满一页（接口上限 100）+ `--paginate` 取全线程，再用 jq 取每页最后一条。
 * `--paginate` 下 `--jq` 是**逐页**执行的，stdout 每页一行；全线程最后一条在最后一行，
 * 所以解析必须看最后一行（见 `parseLastComment`），否则超过 100 条时只看得到第 100 条。
 *
 * 出处：https://docs.github.com/en/rest/issues/comments#list-issue-comments
 */
export function lastCommentArgs(repo, number) {
  return [
    'api',
    'repos/' + String(repo) + '/issues/' + String(number) + '/comments?per_page=100',
    '--paginate',
    '--jq',
    '.[-1] | {login: .user.login, at: .created_at}',
  ]
}

/**
 * 解析 `lastCommentArgs` 的 stdout：取**最后一条有效记录**。
 *
 * 跳过空行与空页标记：`--paginate` 的最后一页为空时，jq 对空数组输出 `null`，
 * 它不是评论，跳过它才能拿到上一页的最后一条。
 * 空 / 坏 JSON / 不是对象 / `login` 为空 → `null`（调用方少显示一行，绝不阻断唤醒）。
 * 尾部是坏 JSON 时**不回退**到上一条：宁可少一行，也不展示可能已经过期的评论。
 */
export function parseLastComment(stdout) {
  const lines = String(stdout ?? '').split(/\r\n|\n|\r/)
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i].trim()
    if (!line || line === 'null') continue
    let parsed = null
    try { parsed = JSON.parse(line) } catch { return null }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    const login = parsed.login ? String(parsed.login).trim() : ''
    if (!login) return null
    return { login, at: parsed.at ? String(parsed.at) : '' }
  }
  return null
}

/**
 * 关闭原因 / 反复重开的提示。
 *
 * 依据：issue 对象有 `state_reason`（本机实测 `cli/cli` 上大量 `not_planned`；
 * 重新打开时会变成 `reopened`）。出处：https://docs.github.com/en/rest/issues/issues
 *
 * 为什么要它：主理鱼看到 closed 就跳过，但"被标成 not_planned 后又被重开"的条目
 * 恰恰是最需要人看一眼的 —— 说明之前判断"不做"是错的，或者有人在坚持。
 */
// KB: state-reason.md —— 「判过不做」又被重开才是信号（只有 reopened 值得抬优先级）
export function stateReasonNote(item) {
  if (!item || typeof item !== 'object') return ''
  const reason = item.state_reason || item.stateReason
  if (!reason) return ''
  if (reason === 'reopened') return '这条被重新打开过（之前关过，判"不做"可能不对）'
  if (item.state === 'closed' && reason === 'not_planned') return '关闭原因：不做（not planned）'
  if (item.state === 'closed' && reason === 'completed') return '关闭原因：已完成'
  return ''
}

/**
 * 有没有人认领（assignee）。
 *
 * 依据：issue 对象的 `assignees` 数组；GitHub 的过滤语法里也有现成的 `assignee:` 限定词
 * （我们自己的过滤器 `onlyAssigned` 就基于它）。
 * 出处：https://docs.github.com/en/issues/tracking-your-work-with-issues/using-issues/filtering-and-searching-issues-and-pull-requests
 *
 * 注意：**"无人认领更紧急"是产品判断，不是 GitHub 的规则**（本轮没找到官方依据），
 * 所以只在消息里如实标注，加权默认关闭。
 */
// KB: assignment-signal.md —— 认领状态：事实默认展示，判断默认关闭（见 watch.js 的 DEFAULT_PRIORITY）
export function assignmentNote(item) {
  if (!item || typeof item !== 'object') return ''
  const list = Array.isArray(item.assignees) ? item.assignees.filter(Boolean) : []
  if (list.length > 0) return ''
  return '未认领'
}

/**
 * 分诊信号表：单一口径，回答「我们到底看哪些信号、哪些是事实、哪些是判断、默认开不开」。
 *
 * 为什么要这张表：信号散落在代码里，客户看不见我们的取舍；写进这里之后
 * `/state` 会回传、面板能直接展示，改权重也不用改两处。
 *
 * `kind`：fact = GitHub 给的事实；judgment = 我们的产品判断（无官方依据）。
 */
// KB: triage-signal-table.md —— 一张表说清分诊信号与取舍（事实 vs 判断、默认开不开）
export const TRIAGE_SIGNALS = [
  { key: 'reopened', label: '被重新打开', kind: 'fact', weight: 100, default: true, why: 'state_reason=reopened，说明之前判"不做"被推翻' },
  { key: 'comments', label: '有人评论', kind: 'fact', weight: 10, default: true, why: '在等回应' },
  { key: 'labels', label: '带标签', kind: 'fact', weight: 5, default: true, why: '命中过某个分类' },
  { key: 'unassigned', label: '无人认领', kind: 'judgment', weight: 3, default: false, why: '团队经验：没人认领更该看 —— 无官方依据，故默认关' },
  { key: 'stale', label: '长期没动静', kind: 'fact', weight: 2, default: false, why: 'open 且超过 30 天没更新（stale bot 默认 60 天）—— 默认只展示，开启后 +2 分' },
]

/**
 * 「躺了多久」：open 且长期没更新 —— stale bot 的世界标准是 60 天（actions/stale 默认值）。
 *
 * 依据：actions/stale 的 `days-before-stale` 默认 **60** 天
 * （https://github.com/actions/stale#readme），社区普遍用 30/60 两档。
 * 我们只**展示**，默认不参与排序（和 unassigned 一样：先给事实，判断交给用户）。
 */
// KB: stale-threshold.md —— 60 天是社区默认，我们用 30 天
export function stalenessNote(item, options = {}) {
  if (!item || typeof item !== 'object') return ''
  const state = String(item.state || '')
  if (state && state !== 'open') return ''
  const stamp = item.updated_at || item.updatedAt
  const at = Date.parse(stamp || '')
  if (!Number.isFinite(at)) return ''
  // 括号别省：Number(now) || (Date.now() - at) 会把 now 自己当成毫秒差（写错过一次）
  const days = Math.floor(((Number(options.now) || Date.now()) - at) / (24 * 3600 * 1000))
  if (!Number.isFinite(days) || days < 0) return ''
  const threshold = Number(options.thresholdDays) || 30
  if (days < threshold) return ''
  return '躺了 ' + days + ' 天'
}

/**
 * 从 cross-reference 时间线里挑出关联的 PR。
 *
 * 依据：`timelineItems(itemTypes: [CROSS_REFERENCED_EVENT])` 会给出引用过这条 issue 的 PR；
 * 注意 `source` 是 union，**必须带 `__typename`** 才能选到 PullRequest 的字段
 * （直接选 `source { number }` 会报 "Selections can't be made directly on unions"）。
 * 出处：https://docs.github.com/en/graphql/reference/objects#crossreferencedevent
 */
export function pickLinkedPullRequests(nodes) {
  const list = Array.isArray(nodes) ? nodes : []
  const seen = new Set()
  const out = []
  for (const node of list) {
    const source = node && node.source
    if (!source || source.__typename !== 'PullRequest' || !source.number) continue
    if (seen.has(source.number)) continue
    seen.add(source.number)
    out.push({
      number: source.number,
      state: String(source.state || ''),
      url: String(source.url || ''),
      draft: source.isDraft === true,
      review: String(source.reviewDecision || ''),
      mergeable: String(source.mergeable || ''),
      ci: String((source.statusCheckRollup && source.statusCheckRollup.state) || ''),
    })
  }
  // open 的排前面（说明真在做），merged 其次，closed 最后
  const rank = { OPEN: 0, MERGED: 1, CLOSED: 2 }
  return out.sort((a, b) => (rank[a.state] ?? 9) - (rank[b.state] ?? 9))
}

/** 「已经有 PR 在做了」——避免会话重复干活。 */
// KB: linked-pull-requests.md —— 「已有 PR 在做」比评论更硬的信号
// KB: draft-pr-signal.md —— 草稿 PR ≠ 有人在推进
// KB: pr-blocked-state.md —— 「有 PR」不够，要说清卡在哪
// KB: ci-status-on-linked-pr.md —— CI 红绿零成本拿到，值得展示
export function linkedPrNote(linked) {
  const list = Array.isArray(linked) ? linked.filter((item) => item && item.number) : []
  if (list.length === 0) return ''
  const first = list[0]
  const stateText = first.state === 'OPEN' ? '进行中' : first.state === 'MERGED' ? '已合并' : first.state === 'CLOSED' ? '已关闭' : String(first.state || '')
  // 草稿 PR 说明"还没准备好"：别让会话以为对方在推进
  const draftText = first.state === 'OPEN' && first.draft === true ? '·草稿' : ''
  // 「卡在哪」比「有 PR」更有用：有冲突 / 等 review 是会话接管前最该知道的
  const blocked = first.state === 'OPEN'
    ? (first.mergeable === 'CONFLICTING' ? '·有冲突' : '')
      + (first.review === 'REVIEW_REQUIRED' ? '·等 review' : '')
      + (first.review === 'CHANGES_REQUESTED' ? '·被要求修改' : '')
      // CI 状态同样是"该不该接管"的依据：失败可能是可修的，运行中等它出结果
      + (first.ci === 'FAILURE' || first.ci === 'ERROR' ? '·CI 失败' : '')
      + (first.ci === 'PENDING' || first.ci === 'EXPECTED' ? '·CI 运行中' : '')
    : ''
  return '已有 PR #' + first.number + (stateText || draftText || blocked ? '（' + stateText + draftText + blocked + '）' : '')
    + (list.length > 1 ? ' 等 ' + list.length + ' 个' : '')
}

/**
 * 额度推迟的文案（审核 T20 的回归点）。
 *
 * 以前这段是内联拼的，拼错过一次：
 *   `deferReason = 'quota' + new Date(...).toISOString().slice(11, 16) + 'Z'` → `quota09:30Z`
 * `deferReason` 是**机器可读的稳定原因**（面板按它筛选、打标签），掺进时间就永远查不到。
 * 抽成纯函数 + 单测钉住：reason 必须**恰好**是下面这些之一，时间只能出现在人读的那句话里。
 */
export const DEFER_REASONS = ['ratelimit', 'quota', 'truncated', 'busy', 'window', 'observe', 'backoff']

export function quotaDeferText(remaining, resumeInMs, now = Date.now()) {
  const at = new Date(now + Math.max(0, Number(resumeInMs) || 0))
  const hhmm = at.toISOString().slice(11, 16)
  return {
    reason: 'quota',
    text: '额度紧张（剩余 ' + String(remaining) + '），已推迟到 ' + hhmm + ' UTC',
  }
}

/**
 * 离线模式判定（`DSH_SUPERAGENT_OFFLINE`）。
 *
 * 审核 T23：以前这条判断是内联的 `process.env.DSH_SUPERAGENT_OFFLINE === '1'`，
 * 藏在 `lib/index.js` 的 `run()` 闭包里 —— 测试只能「跑整套用例看快不快」来间接证明。
 * 抽成纯函数后可以真的断言它的真值表（尤其是 `'0'` / `'false'` 不该被当成离线）。
 */
export function isOfflineMode(env = process.env) {
  const raw = String((env && env.DSH_SUPERAGENT_OFFLINE) || '').trim().toLowerCase()
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on'
}
