// PR 响应监控的纯函数层：水位、判定、措辞。
//
// 为什么单独一个文件：这些函数决定「哪条评论算新」「要不要叫醒」「唤醒消息长什么样」，
// 全是会静默出错的判断（少叫醒一次 = 评论永久丢失；多叫醒一次 = 每轮刷屏），
// 而且会被 lib/index.js 的轮询直接消费。放在一起才好单独钉住。
//
// 约定：本文件只做纯计算 —— 不发请求、不读环境、不调用 Date.now()。
// 时间一律由调用方传入，所以测试可以离线、确定性地跑。

/**
 * 账号归一：去掉 `@` 前缀与首尾空白，并转小写。
 *
 * 为什么必须小写：GitHub / Gitee 的登录名都是大小写不敏感的，
 * `iJetLi` 与 `ijetli` 是同一个人；不归一会把本人评论当成新评论，每轮都叫醒自己。
 * 为什么作者可能是 null：评论者账号被删除时上游回的就是 null，这里不能抛异常。
 */
export function normalizeSelf(login) {
  // 先 trim 再剥 `@`：`'  @iJetLi '` 这种也要归一
  return String(login ?? '').trim().replace(/^@+/, '').toLowerCase()
}

/** 仓库全名归一：trim + 小写（仓库名同样大小写不敏感）。 */
function normalizeRepo(name) {
  return String(name ?? '').trim().toLowerCase()
}

/**
 * 是不是「从 fork 提给别人的 PR」。
 *
 * 判据：head 与 base 两边都非空且不是同一个仓库。
 * 为什么 null 要当成「非 fork」：fork 仓库被删除后 GraphQL 的 `headRepository` 就是 null，
 * 这不是异常，只是这条 PR 已经没法再跟（Review Focus 1）—— 跳过，别把它当成候选。
 */
export function isForkPr(pr) {
  if (!pr || typeof pr !== 'object') return false
  const head = normalizeRepo(pr.headRepo)
  const base = normalizeRepo(pr.baseRepo)
  return Boolean(head && base && head !== base)
}

/**
 * 按水位筛出新评论：返回 `id > seenId` 的评论，保持原顺序。
 *
 * `seenId` 为 0 / undefined 表示第一次轮询，全部算新。
 * 为什么 `id` 要过 Number()：Gitee 的评论 id 可能是字符串，
 * 而 `'999' > 1000` 在字符串比较里是 **true**（Review Focus 2）—— 不转数值会重复唤醒。
 * 不修改入参：水位推进是调用方的状态，不是这个函数的副作用。
 */
export function pickNewComments(comments, seenId) {
  const list = Array.isArray(comments) ? comments : []
  const threshold = Number(seenId) || 0
  return list.filter((comment) => {
    const id = Number(comment && comment.id)
    return Number.isFinite(id) && id > threshold
  })
}

/**
 * 这批新评论里有没有「不是本人」的：有就值得叫醒。
 *
 * 本人评论不叫醒：那是我们上一轮留下的回评，叫醒只会自己跟自己对话。
 * 空批次返回 false（没有新评论就没有唤醒）。
 */
export function shouldWake(comments, self) {
  const list = Array.isArray(comments) ? comments : []
  const me = normalizeSelf(self)
  return list.some((comment) => normalizeSelf(comment && comment.author) !== me)
}

/**
 * 结构化唤醒消息。格式是**对外契约**（Task 5 与后续测试依赖），改动要同步测试。
 *
 * 固定形状：
 *   【PR 响应】<base>#<number> 有 <n> 条新评论
 *
 *   PR: <title>
 *   分支: <branch>
 *   评论者: <author>（非本人）
 *   时间: <createdAt>
 *
 *   > <body 逐行>
 *
 *   处理建议: 阅读评论 → 修改代码 → 自审 → 提交 → 回评
 *   目标: <goal>            // 只在传了 goal 时出现
 *
 * 为什么正文逐行加 `>`：多行评论里只要有一行没被引用，markdown 就会把它当成正文指令，
 * 会话可能把「随便看看」这类句子误读成任务要求。
 * 为什么时间原样透传：这里是纯函数，不碰时钟；调用方给什么就显示什么。
 */
export function buildPrWakeText(opts) {
  const options = opts && typeof opts === 'object' ? opts : {}
  const comments = Array.isArray(options.comments) ? options.comments : []
  const base = String(options.base ?? '')
  const number = String(options.number ?? '')
  const lines = [
    '【PR 响应】' + base + '#' + number + ' 有 ' + comments.length + ' 条新评论',
    '',
    'PR: ' + String(options.title ?? ''),
    '分支: ' + String(options.branch ?? ''),
  ]
  for (const comment of comments) {
    const item = comment && typeof comment === 'object' ? comment : {}
    const body = String(item.body ?? '').trim()
    lines.push('评论者: ' + String(item.author ?? '') + '（非本人）')
    lines.push('时间: ' + String(item.createdAt ?? ''))
    lines.push('')
    // 空正文也保留一个 `>`，避免引用块塌掉、两条评论粘在一起
    const bodyLines = body.length > 0 ? body.split(/\r\n|\n|\r/) : ['']
    for (const line of bodyLines) lines.push('> ' + line)
    lines.push('')
  }
  lines.push('处理建议: 阅读评论 → 修改代码 → 自审 → 提交 → 回评')
  if (options.goal) lines.push('目标: ' + String(options.goal))
  return lines.join('\n')
}

/**
 * 只保留仍然 open 的 PR 水位。
 *
 * 为什么要剪：PR 关闭/合并后水位留着只会无限增长，
 * 而编号被复用的仓库上（Gitee 有这种）旧水位还会误伤新 PR。
 * 键统一按字符串比较（JSON 里对象键本来就是字符串）。
 */
export function pruneSeen(seen, openNumbers) {
  const open = new Set((Array.isArray(openNumbers) ? openNumbers : []).map((number) => String(number)))
  const out = {}
  for (const [key, value] of Object.entries(seen && typeof seen === 'object' ? seen : {})) {
    if (!open.has(String(key))) continue
    const id = Number(value)
    out[key] = Number.isFinite(id) ? id : 0
  }
  return out
}

/**
 * 合并水位：同一条 PR 取**较大**的评论 id，绝不让水位回退。
 *
 * 为什么不能直接覆盖：唤醒失败时调用方不会推进水位，但别的路径可能拿着旧数据再合并一次；
 * 回退意味着已经处理过的评论会被重新叫醒（同一条评论重复唤醒，Review Focus 5）。
 * 返回新对象，不修改入参。
 */
export function advanceSeen(seen, updates) {
  const out = {}
  for (const [key, value] of Object.entries(seen && typeof seen === 'object' ? seen : {})) {
    const id = Number(value)
    out[key] = Number.isFinite(id) ? id : 0
  }
  for (const update of Array.isArray(updates) ? updates : []) {
    if (!update || typeof update !== 'object') continue
    if (update.number === undefined || update.number === null) continue
    const latest = Number(update.latestId)
    if (!Number.isFinite(latest)) continue
    const key = String(update.number)
    const prev = Number(out[key])
    if (!Number.isFinite(prev) || latest > prev) out[key] = latest
  }
  return out
}
