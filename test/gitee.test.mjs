// Gitee 适配层的单元测试：不联网，全部用假 fetch。
//
// 为什么要有：Gitee 与 GitHub 的条目形状不同（state 有 progressing/rejected、PR 走 /pulls、
// 没有 GraphQL、没有 ETag）。归一化写错的话，下游的筛选/唤醒逻辑会静默失效 ——
// 这正是「看起来有数据，但永远不叫醒」那类 bug。
import assert from 'node:assert/strict'
import test from 'node:test'

import { parseRepoSpec } from '../lib/watch.js'
import * as watchModule from '../lib/watch.js'
import * as giteeModule from '../lib/gitee.js'
import {
  normalizeGiteeItem, normalizeGiteeList, normalizeGiteeState,
  listGiteeItems, fetchGiteeLastComment, addGiteeLabel,
} from '../lib/gitee.js'

test('仓库写法：owner/name、gitee: 前缀、Gitee URL 都能认', () => {
  assert.equal(parseRepoSpec('a/b').provider, 'github')
  assert.equal(parseRepoSpec('gitee:a/b').provider, 'gitee')
  assert.equal(parseRepoSpec('gitee：a/b').repo, 'a/b', '全角冒号也要认（中文输入法太常见）')
  assert.equal(parseRepoSpec('https://gitee.com/Ghandi/workbuddy-pro').repo, 'Ghandi/workbuddy-pro')
  assert.equal(parseRepoSpec('https://gitee.com/Ghandi/workbuddy-pro.git').provider, 'gitee')
  assert.equal(parseRepoSpec('https://github.com/x/y/issues/3').repo, 'x/y', '带尾巴的 URL 只取前两段')
  assert.equal(parseRepoSpec('bad').ok, false)
  assert.equal(parseRepoSpec('').ok, false)
})

test('Gitee state 归一：rejected 算关闭，progressing 算开着', () => {
  assert.equal(normalizeGiteeState('open'), 'open')
  assert.equal(normalizeGiteeState('progressing'), 'open')
  assert.equal(normalizeGiteeState('closed'), 'closed')
  assert.equal(normalizeGiteeState('rejected'), 'closed')
  assert.equal(normalizeGiteeState(undefined), 'open')
})

test('Gitee issue/PR 归一成下游认识的形状', () => {
  const issue = normalizeGiteeItem({
    number: 7, title: '报告', state: 'progressing',
    user: { login: 'ysl289' }, assignee: { login: 'MYCF711' },
    labels: [{ name: 'bug' }, 'ui'], html_url: 'https://gitee.com/a/b/issues/7',
    updated_at: '2026-11-04T10:00:00Z',
  })
  assert.equal(issue.number, '7', '编号统一成字符串（Gitee issue 真机就是字符串）')
  assert.equal(issue.state, 'open', 'progressing 要当成开着')
  assert.equal(issue.user.login, 'ysl289')
  assert.deepEqual(issue.assignees, [{ login: 'MYCF711' }])
  assert.deepEqual(issue.labels.map((l) => l.name), ['bug', 'ui'], '字符串标签也要能用')

  const pr = normalizeGiteeItem({ number: 9, title: 'PR', state: 'open', head: {}, user: { login: 'x' }, updated_at: '2026-11-04T11:00:00Z' }, { kind: 'pull' })
  assert.ok(pr.pull_request, 'PR 要带 pull_request，下游靠它分类')
  assert.equal(pr.number, '9')
})

test('issue 与 PR 合并后按 updated_at 倒序', () => {
  const list = normalizeGiteeList(
    [{ number: 1, updated_at: '2026-11-01T00:00:00Z', state: 'open' }],
    [{ number: 2, updated_at: '2026-11-03T00:00:00Z', state: 'open' }],
  )
  assert.equal(list.length, 2)
  assert.equal(list[0].number, '2', '最近更新的排前面')
})

test('拉列表：issue 与 PR 两个端点都要打，一半失败要标出来', async () => {
  const seen = []
  const fetchImpl = async (url) => {
    seen.push(url)
    if (url.includes('/pulls')) return { ok: false, status: 500, text: async () => 'boom' }
    return { ok: true, status: 200, text: async () => JSON.stringify([{ number: 3, state: 'open', updated_at: '2026-11-04T00:00:00Z' }]) }
  }
  const out = await listGiteeItems({ repo: 'a/b', token: 't', fetchImpl })
  assert.equal(seen.length, 2)
  assert.ok(seen.every((u) => u.startsWith('https://gitee.com/api/v5/repos/a/b/')), 'URL 形状要对：' + seen[0])
  assert.equal(out.ok, true)
  assert.equal(out.partial, 'pulls', '一半失败要说清楚是哪一半')
  assert.equal(out.items.length, 1)
})

test('拉列表：两个端点都失败才算失败，并把状态码带回来', async () => {
  const fetchImpl = async () => ({ ok: false, status: 401, text: async () => 'bad token' })
  const out = await listGiteeItems({ repo: 'a/b', fetchImpl })
  assert.equal(out.ok, false)
  assert.equal(out.status, 401)
})

test('最后评论：自己留的要标 self，别人留的不标', async () => {
  const make = (login) => async () => ({
    ok: true, status: 200,
    text: async () => JSON.stringify([{ user: { login }, created_at: '2026-11-04T09:00:00Z' }]),
  })
  const mine = await fetchGiteeLastComment({ repo: 'a/b', item: { number: 1 }, selfLogin: 'me', fetchImpl: make('me') })
  assert.equal(mine.self, true)
  const other = await fetchGiteeLastComment({ repo: 'a/b', item: { number: 1 }, selfLogin: 'me', fetchImpl: make('someone') })
  assert.equal(other.self, false)
})

test('打标签：POST 到 issues/{n}/labels，body 是裸字符串数组', async () => {
  let captured = null
  const fetchImpl = async (url, init) => {
    captured = { url, init }
    return { ok: true, status: 200, text: async () => '{}' }
  }
  const res = await addGiteeLabel({ repo: 'a/b', token: 't', number: 5, label: '主理鱼:已处理', fetchImpl })
  assert.equal(res.ok, true)
  assert.ok(captured.url.endsWith('/repos/a/b/issues/5/labels'))
  assert.equal(captured.init.method, 'POST')
  assert.deepEqual(JSON.parse(captured.init.body), ['主理鱼:已处理'])
  assert.equal(captured.init.headers.authorization, 'token t')
})

test('打标签的 body 不能包成 { labels: [...] }：Gitee 会回 400 Problems parsing JSON', async () => {
  // 2026-11-08 真机（Gitee 项目看板式仓库）：裸数组 201，对象体 400 Problems parsing JSON。
  // Gitee swagger 对该端点的 body 定义是 type: array / items: string，所以对象体不是合法形状。
  let body = null
  const fetchImpl = async (_url, init) => {
    body = JSON.parse(init.body)
    return { ok: true, status: 200, text: async () => '{}' }
  }
  await addGiteeLabel({ repo: 'o/r', token: 't', number: 'IKTQ5G', label: 'L', fetchImpl })
  assert.ok(Array.isArray(body), 'body 必须是数组')
  assert.equal(body.length, 1)
  assert.equal(body[0], 'L')
  assert.equal(Object.prototype.hasOwnProperty.call(body, 'labels'), false, '不能再包一层 labels 字段')
})

test('真机样例：issue 的 number 是字符串（IKSQJH），PR 是数字 —— 都不能被转成 0', () => {
  // 2026-11-04 真机抓的真实响应形状
  const issue = normalizeGiteeItem({ id: 34933085, number: 'IKSQJH', state: 'open', title: 't', user: { login: 'x' }, updated_at: '2026-11-04T10:00:00Z' })
  assert.equal(issue.number, 'IKSQJH', 'Gitee issue 编号是字符串，转 Number 会变 0 → 去重与 ack 全部失效')
  const pr = normalizeGiteeItem({ id: 5474824, number: 14, state: 'closed', title: 't', user: { login: 'q' }, updated_at: '2026-11-02T11:16:51+08:00' }, { kind: 'pull' })
  assert.equal(pr.number, '14')
  // 两种都要能进 URL（评论/打标签都按原样拼）
  assert.ok(pr.pull_request)
})

test('字符串编号也要能拼出评论与打标签的 URL', async () => {
  const urls = []
  const f = async (u) => { urls.push(u); return { ok: true, status: 200, text: async () => '[]' } }
  await fetchGiteeLastComment({ repo: 'o/r', item: { number: 'IKSQJH' }, fetchImpl: f })
  await addGiteeLabel({ repo: 'o/r', number: 'IKSQJH', label: 'L', fetchImpl: f })
  // Gitee 不认 GitHub 的 sort/direction：翻了页取末条才是「最后评论」（审核 M2）
  assert.ok(urls[0].endsWith('/issues/IKSQJH/comments?per_page=100&page=1'), urls[0])
  assert.ok(urls[1].endsWith('/issues/IKSQJH/labels'), urls[1])
})

test('since 会拼进两个端点的 URL（Gitee 没有 ETag，这是唯一能省流量的手段）', async () => {
  const urls = []
  const f = async (u) => { urls.push(u); return { ok: true, status: 200, text: async () => '[]' } }
  await listGiteeItems({ repo: 'o/r', perPage: 5, since: '2026-11-04T00:00:00Z', fetchImpl: f })
  assert.equal(urls.length, 2)
  assert.ok(urls.every((u) => u.includes('since=2026-11-04T00%3A00%3A00Z')), '两个端点都要带 since：' + urls.join(' '))
  assert.ok(urls[0].includes('per_page=5'))
})

test('repoAccess 映射：Gitee 的 permissions 形状 → 内部形状（别把只读误报成可写）', () => {
  const { mapGiteeRepoAccess } = giteeModule
  const rw = mapGiteeRepoAccess('o/r', { permissions: { push: true, admin: false }, private: true, has_issues: true })
  assert.equal(rw.push, true)
  assert.equal(rw.private, true)
  assert.equal(rw.fork, false)

  const ro = mapGiteeRepoAccess('o/r', { permissions: { push: false, admin: false, pull: true }, has_issues: false })
  assert.equal(ro.push, false, '只读仓库不能报成可写')
  assert.equal(ro.hasIssues, false, '关掉 issue 的仓库要能看出来')

  // Gitee 没有 archived/disabled 字段：必须保持 false，不许瞎猜
  assert.equal(ro.archived, false)
  assert.equal(ro.disabled, false)

  const admin = mapGiteeRepoAccess('o/r', { permissions: { admin: true } })
  assert.equal(admin.push, true, 'admin 也应当能写')
})

test('Gitee 没有 state_reason：靠上一轮状态自己判「重新打开」', () => {
  // 判定逻辑在 lib/watch.js（纯函数，可单测），不在 gitee.js
  const { markGiteeReopened } = watchModule

  // 上一轮 closed，这一轮 open → 就是 reopen
  const items = [{ number: 'IK1', state: 'open' }, { number: 'IK2', state: 'closed' }]
  const states = markGiteeReopened(items, { IK1: 'closed', IK2: 'open' })
  assert.equal(items[0].state_reason, 'reopened', '关掉又打开要能判出来')
  assert.equal(items[1].state_reason, undefined, '一直关着的不是 reopen')
  assert.deepEqual(states, { IK1: 'open', IK2: 'closed' }, '状态表要更新成这一轮的值')

  // 已经有 state_reason 的条目（例如 GitHub 分支误用）不许被覆盖
  const keep = [{ number: 'IK3', state: 'open', state_reason: '' }]
  markGiteeReopened(keep, { IK3: 'closed' })
  assert.equal(keep[0].state_reason, 'reopened')

  // 翻页之外的旧状态要清掉（否则字典无限长）
  const trimmed = markGiteeReopened([{ number: 'IK1', state: 'open' }], { IK1: 'open', OLD1: 'closed', OLD2: 'open' })
  assert.deepEqual(Object.keys(trimmed), ['IK1'], '没出现在这一页的键要删掉：' + JSON.stringify(trimmed))
})

test('打标签前先确保标签存在：已存在只发 GET，不存在才 POST 建', async () => {
  const { ensureGiteeLabel } = giteeModule
  const calls = []
  const exists = async (url, init) => {
    calls.push(((init && init.method) || 'GET') + ' ' + url.split('/labels')[0].split('/').pop())
    return { ok: true, status: 200, text: async () => JSON.stringify([{ name: '主理鱼-已处理' }, { name: 'bug' }]) }
  }
  const a = await ensureGiteeLabel({ repo: 'o/r', token: 't', label: '主理鱼-已处理', fetchImpl: exists })
  assert.deepEqual(a, { ok: true, created: false, reason: 'already-exists' })
  assert.deepEqual(calls, ['GET r'], '已存在就不该发 POST')

  calls.length = 0
  const missing = async (url, init) => {
    calls.push((init && init.method) || 'GET')
    return { ok: true, status: 201, text: async () => '{}' }
  }
  const b = await ensureGiteeLabel({ repo: 'o/r', token: 't', label: '主理鱼-已处理', fetchImpl: missing })
  assert.deepEqual(b, { ok: true, created: true, reason: 'created' })
  assert.deepEqual(calls, ['GET', 'POST'], '不存在时要先查后建')

  // 建不出来也不能抛：调用方要能继续并把原因带回去
  const denied = async () => ({ ok: false, status: 403, text: async () => 'no permission' })
  const c = await ensureGiteeLabel({ repo: 'o/r', token: 't', label: '主理鱼-已处理', fetchImpl: denied })
  assert.equal(c.ok, false)
  assert.equal(c.status, 403)
})

test('空标签名直接拒（别去建一个名字是空串的标签）', async () => {
  const { ensureGiteeLabel } = giteeModule
  const res = await ensureGiteeLabel({ repo: 'o/r', label: '   ', fetchImpl: async () => { throw new Error('不该发请求') } })
  assert.equal(res.ok, false)
})

test('Gitee 标签名规则：半角冒号非法（默认 ack 标签要换连字符）', () => {
  const { isValidGiteeLabel, suggestGiteeLabel, DEFAULT_ACK_LABEL_GITEE } = giteeModule
  // 真机实测：Gitee 回「Name只允许汉字、字母、数字或者…，长度必须在 2 到 20 个字符之间」
  assert.equal(isValidGiteeLabel('主理鱼:已处理'), false, '半角冒号不在允许集合里')
  assert.equal(isValidGiteeLabel('主理鱼-已处理'), true)
  assert.equal(isValidGiteeLabel('a'), false, '太短')
  assert.equal(isValidGiteeLabel('a'.repeat(21)), false, '太长')
  assert.equal(suggestGiteeLabel('主理鱼:已处理'), '主理鱼-已处理', '冒号换成连字符')
  assert.equal(DEFAULT_ACK_LABEL_GITEE, '主理鱼-已处理', 'Gitee 的默认 ack 标签必须是合法的')
})

test('doctor 用的标签列表与判定：存在/不存在/大小写', async () => {
  const { giteeLabels, giteeHasLabel } = giteeModule
  const f = async (url) => ({ ok: true, status: 200, text: async () => JSON.stringify([{ name: '主理鱼-已处理' }, { name: 'bug' }]) })
  const res = await giteeLabels({ repo: 'o/r', token: 't', fetchImpl: f })
  assert.equal(res.ok, true)
  assert.equal(giteeHasLabel(res.data, '主理鱼-已处理'), true)
  assert.equal(giteeHasLabel(res.data, 'bug'), true)
  assert.equal(giteeHasLabel(res.data, '主理鱼:已处理'), false, 'Gitee 区分大小写/标点，逐字比')
  assert.equal(giteeHasLabel(null, 'bug'), false, '拿不到列表时不能崩')
  assert.equal(giteeHasLabel(res.data, ''), false)
})

test('merged / rejected 都要算关闭（否则合并掉的 PR 每轮都被当成新动态）', () => {
  const { normalizeGiteeState } = giteeModule
  assert.equal(normalizeGiteeState('merged'), 'closed', 'Gitee 用 merged 表示已合并的 PR')
  assert.equal(normalizeGiteeState('rejected'), 'closed')
  assert.equal(normalizeGiteeState('closed'), 'closed')
  assert.equal(normalizeGiteeState('open'), 'open')
  assert.equal(normalizeGiteeState(''), 'open')
})

test('comments 字段要透传（否则「有人评论 +10」在 Gitee 上恒为 0）', () => {
  const { normalizeGiteeItem } = giteeModule
  assert.equal(normalizeGiteeItem({ number: 'IK1', comments: 7 }).comments, 7)
  assert.equal(normalizeGiteeItem({ number: 'IK1', comments: '3' }).comments, 3)
  assert.equal(normalizeGiteeItem({ number: 'IK1' }).comments, undefined, '没有该字段时不要硬塞 0')
})

test('列标签失败时不许盲发 POST（唯一会往别人仓库写的路径）', async () => {
  const { ensureGiteeLabel } = giteeModule
  let posts = 0
  const f = async (url, init) => {
    if (init && init.method === 'POST') posts += 1
    return { ok: false, status: 403, text: async () => 'rate limit' }
  }
  const res = await ensureGiteeLabel({ repo: 'o/r', label: '主理鱼-已处理', fetchImpl: f })
  assert.equal(res.ok, false)
  assert.equal(res.reason, 'list-failed')
  assert.equal(posts, 0, '读不到现有标签时绝不能 POST')
})

test('permissions 缺失时 push 是 null（不知道），不是 false（只读）', () => {
  const { mapGiteeRepoAccess } = giteeModule
  const unknown = mapGiteeRepoAccess('o/r', { private: false })
  assert.equal(unknown.push, null, 'Gitee 仓库对象没有 permissions 字段，不能谎报只读')
  const known = mapGiteeRepoAccess('o/r', { permissions: { push: true } })
  assert.equal(known.push, true)
  const denied = mapGiteeRepoAccess('o/r', { permissions: { push: false } })
  assert.equal(denied.push, false)
})

test('列表满一页要标记 truncated（否则被截掉的条目永远不再出现）', async () => {
  const { listGiteeItems } = giteeModule
  const mk = (n) => async () => ({ ok: true, status: 200, text: async () => JSON.stringify(Array.from({ length: n }, (_, i) => ({ number: 'I' + i, title: 't', state: 'open' }))) })
  assert.equal((await listGiteeItems({ repo: 'o/r', perPage: 20, fetchImpl: mk(20) })).truncated, true)
  assert.equal((await listGiteeItems({ repo: 'o/r', perPage: 20, fetchImpl: mk(5) })).truncated, false)
})

test('issue_state 也要参与判定（T22 B4：resolved/rejected 以前一直算「开着」）', () => {
  const { normalizeGiteeItem } = giteeModule
  assert.equal(normalizeGiteeItem({ number: '1', state: 'open', issue_state: 'resolved' }).state, 'closed')
  assert.equal(normalizeGiteeItem({ number: '2', state: 'open', issue_state: 'rejected' }).state, 'closed')
  assert.equal(normalizeGiteeItem({ number: '3', state: 'open', issue_state: 'progressing' }).state, 'open')
  assert.equal(normalizeGiteeItem({ number: '4', state: 'closed' }).state, 'closed')
  assert.equal(normalizeGiteeItem({ number: '5', state: 'open' }).state, 'open')
})
