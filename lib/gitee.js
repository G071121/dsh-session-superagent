/**
 * Gitee（码云）适配层 —— 让「守」不只能盯 GitHub。
 *
 * 为什么要单独一层：`gh` CLI 只服务 GitHub。Gitee 没有等价 CLI，
 * 但它有 REST v5，形状和 GitHub 不完全一样（`state` 有 progressing/rejected、
 * PR 走 `/pulls`、没有 GraphQL、没有 ETag 条件请求）。
 *
 * 设计原则（和 gh-format.js 一致）：
 *   1. **纯转换**在这里做完，下游（pollOnce / 筛选 / 唤醒）完全不用知道是哪家；
 *   2. 网络失败只返回结构化错误，不抛 —— 让调用方走统一的失败分类；
 *   3. token 只在这里出现，绝不写日志。
 */

export const GITEE_API = 'https://gitee.com/api/v5'

/** Gitee 的 state → 我们内部沿用的 GitHub 口径。 */
export function normalizeGiteeState(raw) {
  const s = String(raw || '').toLowerCase()
  // 审核 M1：Gitee 用 `merged` 表示「已合并的 PR」，漏了它，合并掉的 PR 会一直被当成「开着」，
  // 每轮都被算成新动态。`rejected`（关闭且不修）同理。
  // resolved / rejected 是 Gitee 的 issue_state 取值（issue 已解决或不予处理）
  if (s === 'closed' || s === 'rejected' || s === 'merged' || s === 'resolved') return 'closed'
  return 'open'
}

/**
 * Gitee 条目 → 内部统一形状。
 *
 * 下游只用这些字段：number / title / state / user.login / labels[].name /
 * assignees[].login / html_url / updated_at / state_reason / pull_request / draft。
 */
export function normalizeGiteeItem(raw, { kind = 'issue' } = {}) {
  const item = raw || {}
  const isPr = kind === 'pull' || Boolean(item.pull_request) || Array.isArray(item.head)
  // 审核 T22 B4：Gitee 的 issue 除了 `state` 还有 `issue_state`
  // （progressing / resolved / rejected …）。以前只读 state，于是「已解决」的 issue 一直算开着、
  // 每轮都被当成新动态。两个字段都看，任一判「关闭」即可。
  const state = normalizeGiteeState(item.state === 'closed' || item.state === 'merged' ? item.state : (item.issue_state || item.state))
  const labels = Array.isArray(item.labels)
    ? item.labels.map((l) => (typeof l === 'string' ? { name: l } : { name: l && l.name })).filter((l) => l.name)
    : []
  const out = {
    // Gitee 的 issue 编号是字符串（真机样例：number = "IKSQJH"，id = 34933085），
    // PR 才是数字（number = 14）。**别转 Number** —— 转了就全变 0，去重和 ack 全部失效。
    number: item.number === 0 || item.number ? String(item.number) : String(item.id || ''),
    title: String(item.title || ''),
    state,
    // Gitee 用 'rejected' 表示「关闭且不修」；state_reason 只有 reopened 会被下游用来警示
    state_reason: String(item.state_reason || (String(item.state || '').toLowerCase() === 'reopened' ? 'reopened' : '')) || null,
    user: { login: (item.user && item.user.login) || (item.assignee && item.assignee.login) || '?' },
    assignees: item.assignee ? [{ login: item.assignee.login }] : [],
    labels,
    html_url: String(item.html_url || ''),
    created_at: item.created_at || null,
    updated_at: item.updated_at || null,
  }
  // 审核 M3：`comments` 漏了 → 「有人评论 +10」这条信号在 Gitee 上恒为 0。
  // 保留原始类型（数字就是数字），下游按 `> 0` 判。
  if (item.comments !== undefined && item.comments !== null) out.comments = Number(item.comments) || 0
  if (isPr) {
    out.pull_request = { url: out.html_url }
    out.draft = String(item.state || '').toLowerCase() === 'draft'
  }
  return out
}

export function normalizeGiteeList(issues, pulls) {
  const list = []
  // 200 但正文不是数组时以前会抛 TypeError，违反本文件「从不抛」的约定（审核 G8）
  for (const raw of (Array.isArray(issues) ? issues : [])) list.push(normalizeGiteeItem(raw, { kind: 'issue' }))
  for (const raw of (Array.isArray(pulls) ? pulls : [])) list.push(normalizeGiteeItem(raw, { kind: 'pull' }))
  return list.sort((a, b) => String(b.updated_at || '').localeCompare(String(a.updated_at || '')))
}

/** 统一请求：成功给 {ok:true,data}，失败给 {ok:false,status,error}，从不抛。 */
async function request(path, { token, method = 'GET', body = null, fetchImpl = globalThis.fetch, timeoutMs = 20000 } = {}) {
  const url = GITEE_API + path + (token && method === 'GET' ? '' : '')
  const init = {
    method,
    headers: {
      accept: 'application/json',
      ...(token ? { authorization: 'token ' + token } : {}),
      ...(body ? { 'content-type': 'application/json; charset=utf-8' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  }
  const controller = typeof AbortController === 'function' ? new AbortController() : null
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null
  if (controller) init.signal = controller.signal
  try {
    const res = await fetchImpl(url, init)
    const text = await res.text()
    if (!res.ok) {
      // Gitee 的限流是 429；401/403 是 token 问题
      return { ok: false, status: res.status, error: String(text || '').slice(0, 240) }
    }
    let data = null
    try { data = text ? JSON.parse(text) : null } catch { return { ok: false, status: res.status, error: 'non-json body' } }
    return { ok: true, status: res.status, data }
  } catch (error) {
    return { ok: false, status: 0, error: String((error && error.message) || error).slice(0, 200) }
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/** 拉一页 issue + PR（Gitee 两者分属不同端点，缺 token 时公开仓库也能读）。 */
export async function listGiteeItems({ repo, token = '', perPage = 20, since = '', fetchImpl } = {}) {
  // `since` 是 Gitee 少有的、能省流量的手段（没有 ETag 条件请求）。
  // 真机验证：since 传给未来时间 → 返回 []；传今天 → 只返回今天之后更新的。
  // 两个端点都支持，缺了它就只能每轮全量读。
  const sinceQ = since ? '&since=' + encodeURIComponent(String(since)) : ''
  const size = Math.max(1, Math.min(100, Number(perPage) || 20))
  const q = 'state=all&sort=updated&direction=desc&per_page=' + size + sinceQ
  const [issues, pulls] = await Promise.all([
    request(`/repos/${repo}/issues?${q}`, { token, fetchImpl }),
    request(`/repos/${repo}/pulls?${q}`, { token, fetchImpl }),
  ])
  if (!issues.ok && !pulls.ok) {
    return { ok: false, status: issues.status || pulls.status, error: issues.error || pulls.error }
  }
  // 审核 G3：只取一页时，超出的部分会**静默消失**，而 cursor 还会推进过去 ——
  // 停机恢复/首次轮询时最危险（攒了 30 条只看到 20 条，另外 10 条永远不再出现）。
  // 这里如实告诉调用方「满了，可能被截断」，由它决定是否推迟推进水位。
  const truncated = [issues, pulls].some((res) => res.ok && Array.isArray(res.data) && res.data.length >= size)
  return {
    ok: true,
    items: normalizeGiteeList(issues.ok ? issues.data : [], pulls.ok ? pulls.data : []),
    // 一半成功也要说清楚：否则客户以为 PR 一条都没有
    partial: !issues.ok || !pulls.ok ? (issues.ok ? 'pulls' : 'issues') : null,
    truncated,
  }
}

/** 某条 issue/PR 的最后一条评论（谁、什么时候）——唤醒消息用它回答「现在是有人在等吗」。 */
export async function fetchGiteeLastComment({ repo, token = '', item, selfLogin = '', fetchImpl } = {}) {
  // 编号可能是字符串（issue 形如 IKSQJH）也可能是数字（PR 形如 14）：都按原样拼进 URL
  const number = item && item.number != null ? String(item.number) : ''
  if (!number) return null
  const kind = item && item.pull_request ? 'pulls' : 'issues'
  // 审核 M2：Gitee **不认** `sort=created&direction=desc`（那是 GitHub 的参数），
  // 以前照抄过来，`per_page=1` 拿到的是**最早**一条评论 —— 于是「最后评论」永远是第一条。
  // Gitee 只按创建时间正序返回，所以翻到最后一页取末条。
  let last = null
  for (let page = 1; page <= 5; page += 1) {
    const res = await request(`/repos/${repo}/${kind}/${number}/comments?per_page=100&page=${page}`, { token, fetchImpl })
    if (!res.ok || !Array.isArray(res.data) || res.data.length === 0) break
    last = res.data[res.data.length - 1]
    if (res.data.length < 100) break
  }
  if (!last) return null
  const login = (last.user && last.user.login) || ''
  return {
    login,
    at: last.created_at || null,
    // 自己留的评论不算「有人在等」——和 GitHub 那条 GraphQL 分支保持同一口径
    self: Boolean(selfLogin) && login === selfLogin,
  }
}

/** 打标签（ack 用）。Gitee 对 issue 有这个端点；PR 视同 issue。
 *  body 必须是**裸字符串数组**：Gitee 规范（swagger `POST /v5/repos/{owner}/{repo}/issues/{number}/labels`）
 *  写的是 `type: array, items: string`（如 ["feat","bug"]）。包成 `{ labels: [...] }`
 *  会被回 `400 {"message":"Problems parsing JSON"}`，watch_ack 的标签阶段随之失败。 */
export async function addGiteeLabel({ repo, token = '', number, label, fetchImpl } = {}) {
  return request(`/repos/${repo}/issues/${number}/labels`, { token, method: 'POST', body: [label], fetchImpl })
}

/** 回写处理结论（ack 的可选 Delivery）。PR 与 issue 的端点不同，调用方必须给 kind。 */
export async function addGiteeComment({ repo, token = '', number, body, kind = 'issue', fetchImpl } = {}) {
  const segment = kind === 'pull' ? 'pulls' : 'issues'
  return request(`/repos/${repo}/${segment}/${number}/comments`, { token, method: 'POST', body: { body: String(body || '') }, fetchImpl })
}

/** 当前 token 是谁（doctor 用）。 */
export async function giteeWhoami({ token = '', fetchImpl } = {}) {
  return request('/user', { token, fetchImpl })
}

/** 仓库是否可读（doctor 用）。 */
export async function giteeRepo({ repo, token = '', fetchImpl } = {}) {
  return request(`/repos/${repo}`, { token, fetchImpl })
}

/**
 * Gitee 仓库信息 → 内部 `repoAccess` 形状（与 GitHub 那条 `gh api repos/x --jq` 同构）。
 *
 * Gitee 的 `/repos/{owner}/{name}` 里权限在 `permissions.{admin,push,pull}`；
 * 它**没有** `archived`/`disabled` 这两个字段，所以这两个保持 false 并注明来源，
 * 不要瞎猜成 true（那会让「归档仓库」提示永远不出现，属于静默错误）。
 */
export function mapGiteeRepoAccess(repo, info = {}) {
  const perms = info.permissions || {}
  // 审核 G7：Gitee 的仓库对象里**没有** `permissions` 字段（67 个键都没有它）。
  // 以前 `perms.push === true` 恒 false → 每条 Gitee 守都恒挂「只读」徽章 + 「你只有读权限」假警告。
  // 没有这个字段时 `push` 应该是 `null`（不知道），不是 `false`（只读）——
  // 调用方按 `=== false` 才提示只读。
  const known = info.permissions && typeof info.permissions === 'object'
  return {
    repo,
    push: known ? (perms.push === true || perms.admin === true) : null,
    private: info.private === true,
    fork: Boolean(info.parent) || info.fork === true,
    hasIssues: info.has_issues !== false,
    archived: info.archived === true,
    disabled: info.disabled === true,
    parent: (info.parent && info.parent.full_name) || null,
    checkedAt: new Date().toISOString(),
  }
}

/**
 * 确保 ack 标签存在（Gitee 不会像 GitHub 那样「打标签时自动建」）。
 *
 * 真机核对（2026-11-05）：`GET /repos/{owner}/{repo}/labels` 返回 200 与标签数组，
 * 说明标签端点族存在；不存在时 `POST .../issues/{n}/labels` 会回 HTML 404 页（不是 JSON）。
 *
 * 先 GET 再 POST：Gitee 对「已存在」的 POST 行为没有文档保证，先查一次能省掉一次无谓写入，
 * 也让返回能说清「是新建的，还是本来就有」。
 *
 * 失败不抛：调用方（watch_ack）要能继续尝试打标签，并把真实原因带回给客户。
 */
export async function ensureGiteeLabel({ repo, token = '', label, color = 'ededed', fetchImpl } = {}) {
  const name = String(label || '').trim()
  if (!name) return { ok: false, error: 'label is required' }
  // 先按 Gitee 的规则校验：名字非法时 POST 回来的是一句中文报错，客户看不懂该改什么
  if (!isValidGiteeLabel(name)) {
    return {
      ok: false,
      reason: 'invalid-name',
      error: 'Gitee 标签名只允许汉字/字母/数字/._-/ 与全角符号，长度 2–20（半角冒号不行）',
      suggestion: suggestGiteeLabel(name),
    }
  }
  // 默认每页 20 条：标签多了会把「已存在」判成不存在，于是重复 POST。
  // 翻到没有为止（最多 5 页 = 500 个标签，足够）。
  let listed = { ok: true, data: [] }
  for (let page = 1; page <= 5; page += 1) {
    const res = await request(`/repos/${repo}/labels?per_page=100&page=${page}`, { token, fetchImpl })
    if (!res.ok) { listed = res; break }
    const pageItems = Array.isArray(res.data) ? res.data : []
    listed.data = (listed.data || []).concat(pageItems)
    if (pageItems.length < 100) break
  }
  if (listed.ok) {
    const names = (Array.isArray(listed.data) ? listed.data : []).map((item) => String(item && item.name || ''))
    if (names.includes(name)) return { ok: true, created: false, reason: 'already-exists' }
  } else {
    // 审核 G6：**列标签失败时不许盲发 POST**。
    // 这是唯一会往「别人仓库」写的路径 —— 读不到现有标签就去建，等于在别人仓库里造重复标签。
    // 读失败就老实回报失败，让客户知道是「查不到」而不是「没有」。
    return {
      ok: false,
      reason: 'list-failed',
      status: listed.status,
      error: '查不到现有标签（HTTP ' + (listed.status || '?') + '）：' + String(listed.error || '').slice(0, 120),
    }
  }
  const created = await request(`/repos/${repo}/labels`, { token, method: 'POST', body: { name, color }, fetchImpl })
  if (created.ok) return { ok: true, created: true, reason: 'created' }
  return { ok: false, status: created.status, error: created.error, reason: 'create-failed' }
}

/**
 * Gitee 的标签名规则比 GitHub 严（真机 2026-11-05 实测的报错原文）：
 *
 *   只允许汉字、字母、数字或者小数点(.)、下划线(_)、中划线(-)、正斜杠(/)、反斜杠(\)
 *   以及全角符号，长度必须在 2 到 20 个字符之间
 *
 * 注意**半角冒号不在允许集合里** —— 我们默认的 `主理鱼:已处理` 在 Gitee 上根本建不出来，
 * 于是 ack 永远 404。所以 Gitee 用连字符版本。
 */
export const DEFAULT_ACK_LABEL_GITEE = '主理鱼-已处理'

// 允许集：汉字 / 字母 / 数字 / . _ - / 与全角符号；**半角冒号不在其中**（Gitee 实测拒绝）
const GITEE_LABEL_RE = /^[一-龥A-Za-z0-9._/　-〿＀-￯-]{2,20}$/

export function isValidGiteeLabel(name) {
  return GITEE_LABEL_RE.test(String(name || '').trim())
}

/** 把 GitHub 风格的标签名换成 Gitee 能接受的（主要就是把半角冒号换成连字符）。 */
export function suggestGiteeLabel(name) {
  const fixed = String(name || '').trim().split(':').join('-').slice(0, 20)
  return isValidGiteeLabel(fixed) ? fixed : DEFAULT_ACK_LABEL_GITEE
}

/** 仓库的标签列表（doctor 用；只读）。 */
export async function giteeLabels({ repo, token = '', fetchImpl } = {}) {
  return request(`/repos/${repo}/labels`, { token, fetchImpl })
}

/** 标签列表里有没有这个名字（Gitee 区分大小写，逐字比）。 */
export function giteeHasLabel(list, name) {
  const target = String(name || '')
  if (!target) return false
  return (Array.isArray(list) ? list : []).some((item) => String(item && item.name) === target)
}

/**
 * 编号归一：缺失 / 空串一律给 `NaN`（调用方按「跳过」处理）。
 *
 * 为什么不直接 `Number()`：`Number(null)` / `Number('')` / `Number('  ')` 都是 **0**，
 * 会把「没有编号」的条目收成 `number: 0` / `id: 0` 的脏数据 ——
 * 前者让 `isForkPr` 永远判不出 fork，后者让 `id > 水位` 永远为假（评论静默丢失）。
 */
function toNumberId(value) {
  if (value === null || value === undefined) return NaN
  if (typeof value === 'string' && value.trim() === '') return NaN
  return Number(value)
}

/**
 * 「别人仓库里、由本人提的」PR 列表（PR 响应监控用）。
 *
 * 为什么必须按仓库拉：Gitee 没有 GitHub 那种全局 PR 搜索，只能
 * `GET /repos/{base}/pulls`。真机核对（2026-11-13）：
 *   - `state=open` 只要开着的；
 *   - `author={self}` 是**服务端过滤**，实测有效；
 *   - `head={user}`（不带分支）返回 0 条 —— 别拿它当过滤条件；
 *   - `sort=updated&direction=desc` 让最新的 PR 排前面（下游按顺序消费）。
 *
 * 输出形状是 Task 5（pollPrOnce）唯一消费的契约：
 * `isForkPr` 读 headRepo/baseRepo，唤醒消息读 title/headRef，
 * 所以这里少归一一个字段，PR 就会静默从候选里消失。
 *
 * 防御性归一：fork 仓库被删除时 `head.repo` 是 `null`（不是异常），
 * 输出 `headRepo: null` 交给 `isForkPr` 判「非 fork」跳过；绝不在解析里抛。
 *
 * 为什么 `number` 统一转数字：Gitee 的 PR 编号真机是数字（issue 才是 IKSQJH 那种字符串），
 * 但历史上有字符串形态；统一成数字后 `pruneSeen` / `advanceSeen`（按 String 存键）
 * 与 `Number.isFinite` 判定都不会被脏数据带偏。没有有限编号的条目直接跳过，
 * 免得收成 `number: 0` 的脏 PR。
 */
export async function listGiteePrs({ repo, token = '', author = '', perPage = 100, fetchImpl } = {}) {
  // Gitee 的 per_page 上限是 100（超过回 400）；非法值回落到默认 100
  const size = Math.max(1, Math.min(100, Number(perPage) || 100))
  const authorQ = String(author || '').trim() ? '&author=' + encodeURIComponent(String(author).trim()) : ''
  const res = await request(
    `/repos/${repo}/pulls?state=open&sort=updated&direction=desc&per_page=${size}${authorQ}`,
    { token, fetchImpl },
  )
  if (!res.ok) return { ok: false, status: res.status, error: res.error }
  // 200 但不是数组（网关把错误包成 {"message":"..."} 也回 200）不能当成「没有 PR」：
  // 下游会把空列表读成「本轮没新 PR」，静默漏掉唤醒
  if (!Array.isArray(res.data)) return { ok: false, status: res.status, error: 'PR 列表不是数组' }
  const prs = []
  for (const raw of res.data) {
    const item = raw && typeof raw === 'object' ? raw : {}
    const number = toNumberId(item.number)
    if (!Number.isFinite(number)) continue
    const head = item.head && typeof item.head === 'object' ? item.head : {}
    const base = item.base && typeof item.base === 'object' ? item.base : {}
    prs.push({
      number,
      title: String(item.title || ''),
      // 草稿态：Gitee 的列表里既有布尔 `draft`，也可能只给 `state: 'draft'`（同文件 normalizeGiteeState
      // 就是这么判的）。只认 `draft === true` 会在真机恒为 false —— 契约字段静默失效。
      draft: item.draft === true || String(item.state || '').toLowerCase() === 'draft',
      headRepo: (head.repo && head.repo.full_name) ? String(head.repo.full_name) : null,
      baseRepo: (base.repo && base.repo.full_name) ? String(base.repo.full_name) : null,
      headLogin: (head.user && head.user.login) ? String(head.user.login) : null,
      headRef: head.ref ? String(head.ref) : null,
    })
  }
  // `truncated`：拿满一整页时列表**可能**还有下一页（Gitee 没有 hasNextPage）。
  // 调用方靠它决定「这轮能不能剪掉不在列表里的 PR 的水位」—— 剪了会让那只 PR
  // 回窗后按 seenId=0 把旧评论全部重报。宁可多留一条水位，也不要重报。
  return { ok: true, prs, truncated: prs.length >= size }
}

/**
 * 某条 PR 的**讨论评论**（PR 响应监控用）。
 *
 * 为什么是 `/pulls/{n}/comments?comment_type=pr_comment`：真机核对（2026-11-13），
 * PR 的讨论评论走这里；`/issues/{n}/comments` 对 PR 直接 **404**，别混用。
 * `direction=desc` 让最新的评论排在**首条** —— 下游取最新评论要取 `[0]`，
 * 按 id 比对则不受顺序影响。
 *
 * `id` 必须 `Number()`：Gitee 的评论 id 可能以字符串返回，
 * 而 `pickNewComments`（lib/pr-watch.js）拿它和数字水位比 ——
 * `'999' > 1000` 在字符串比较里是 true，不转就会把旧评论当新评论、每轮重复叫醒。
 *
 * 失败返回 `{ ok: false, status, error }`，**不**给空数组：
 * 空数组会被下游读成「没有新评论」，静默漏掉一次唤醒。
 */
export async function fetchGiteePrComments({ repo, token = '', number, perPage = 100, fetchImpl } = {}) {
  // 没有编号就别发请求：否则 URL 会拼成 /pulls/undefined/comments，拿回 404 还看不出是参数错了。
  // 0 与负数同样是非法 PR 编号（toNumberId 只挡 null/undefined/空白串）
  const id = toNumberId(number)
  if (!Number.isFinite(id) || id <= 0) return { ok: false, status: 0, error: 'number is required' }
  const size = Math.max(1, Math.min(100, Number(perPage) || 100))
  const comments = []
  // 翻页：`per_page` 最大 100，只拉第一页时首窗之后的评论永远看不到
  // （2026-11-13 外部 review 的第 3 点：已有 id 1..14、服务端只回 5..14，
  // 首轮 seen=14 后 id 1..4 永久低于水位）。Gitee 用 `page` 参数翻。
  const maxPages = 10 // 1000 条封顶：病态 PR 不能把一轮轮询拖成分钟级
  let truncated = false
  for (let page = 1; page <= maxPages; page += 1) {
    const res = await request(
      `/repos/${repo}/pulls/${id}/comments?comment_type=pr_comment&direction=desc&per_page=${size}&page=${page}`,
      { token, fetchImpl },
    )
    if (!res.ok) return { ok: false, status: res.status, error: res.error }
    // 同列表：200 但正文不是数组时不能当成「没有评论」
    if (!Array.isArray(res.data)) return { ok: false, status: res.status, error: '评论列表不是数组' }
    if (res.data.length === 0) break
    for (const raw of res.data) {
      const item = raw && typeof raw === 'object' ? raw : {}
      const commentId = toNumberId(item.id)
      // 没有可比较的 id 就没法做水位：跳过，免得 NaN 让「新评论」判定永远为假
      if (!Number.isFinite(commentId)) continue
      comments.push({
        id: commentId,
        // 评论者账号被删除时 user 是 null：给空串（与 GitHub 侧 parsePrSearch 同类型），
        // normalizeSelf('') 归一成空串，与任何真实账号都不等 → 按「非本人」处理，别抛
        author: (item.user && item.user.login) ? String(item.user.login) : '',
        body: String(item.body || ''),
        createdAt: item.created_at ? String(item.created_at) : '',
      })
    }
    // 不满一页说明到底了；满页才继续翻
    if (res.data.length < size) break
    if (page === maxPages) truncated = true
  }
  return { ok: true, comments, truncated }
}
