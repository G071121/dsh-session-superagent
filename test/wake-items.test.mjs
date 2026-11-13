// 弹层要显示「最近唤醒的是哪一条」（仓库 → 编号 + 标题 + 类型 + 时间）。
//
// 数据来自 entry.lastWakeItem：唤醒**真的发出去之后**才记，失败保留上一批 ——
// 不能把「没发出去」说成「处理过」。本用例走真实发送路径（pollWithItems）。
// 只记一条（listed[0]，batchFresh 已按优先级降序）；条数交给 lastWakeCount。
import assert from 'node:assert/strict'
import { tempDir } from './fixtures/tmpdir.mjs'
import test from 'node:test'

process.env.DSH_SUPERAGENT_STATE = tempDir('zhuli-item-')
process.env.DSH_SUPERAGENT_NO_POLL = '1'
process.env.DSH_SUPERAGENT_WAKE_WINDOW_MS = '5'

const { __test, apply } = await import('../lib/index.js')

function makeCtx(agent) {
  return {
    tools: { register: () => {} },
    webServer: { register: () => () => {} },
    agents: { currentInitiator: () => ({ id: 's1' }), get: () => agent },
    get: () => null,
    effect: (fn) => fn(),
    inject: () => {},
  }
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const makeEntry = (id = 'o/r#s1', extra = {}) => ({
  id,
  repo: id.split('#')[0],
  provider: 'github',
  sessionId: 's1',
  intervalSec: 60,
  enabled: true,
  observe: false,
  seen: {},
  lastReported: {},
  cursor: null,
  filters: { labels: [], ignoreLabels: [], skipBots: false, skipDrafts: false, skipClosed: false },
  ...extra,
})

/** pollWithItems 会回读盘上条目（暂停/删除判断），所以测试条目必须先落盘。 */
function persist(entry) {
  const state = __test.readState()
  state.watchers = state.watchers || {}
  state.watchers[entry.id] = entry
  __test.writeState(state)
  return entry
}

const parsed = (items) => ({ status: 200, etag: null, body: JSON.stringify(items) })

const issue = (n, extra = {}) => ({
  number: n,
  title: '标题 ' + n,
  state: 'open',
  user: { login: 'u' },
  labels: [],
  assignees: [],
  html_url: 'https://github.com/o/r/issues/' + n,
  updated_at: new Date().toISOString(),
  ...extra,
})

test('唤醒发出后记下优先级最高的那一条（不是整批，更不是末尾一条）', async () => {
  // 客户问的是「现在轮到哪一条」。batchFresh 按优先级降序，头部才是正在处理的。
  const sent = []
  const ctx = makeCtx({ status: 'idle', followup: (msg) => sent.push(msg) })
  apply(ctx)
  // batchLimit=10，一次涌进 12 条：reopened 的那条优先级最高（priorityScore +100）
  const items = [
    issue(100, { title: '登录页 500', state_reason: 'reopened' }),
    ...Array.from({ length: 11 }, (_, i) => issue(101 + i, { title: '标题 ' + (101 + i) })),
  ]
  const entry = persist(makeEntry('o/r#s1', { batchLimit: 10 }))
  await __test.pollWithItems(ctx, entry, 60000, parsed(items))
  await wait(80)

  assert.equal(sent.length, 1, '应真的发出去一次（否则记什么都是假的）')
  assert.equal(entry.lastWakeCount, 12, '本轮新增 12 条：弹层「等 N 条」读的是这个，不是数组长度')
  assert.deepEqual(entry.lastWakeItem, { number: '100', title: '登录页 500', kind: 'issue' },
    '只记优先级最高的一条（取末尾会把 #110 报成「正在处理」）')
  assert.equal(entry.lastWakeItems, undefined, '不再落整批数组：20 条守会把 /state 顶过 50KB 门禁')
})

test('标题按码点截断，不会切出半个 emoji', async () => {
  const ctx = makeCtx({ status: 'idle', followup: () => {} })
  apply(ctx)
  const longEntry = persist(makeEntry('o/long#s1'))
  await __test.pollWithItems(ctx, longEntry, 60000, parsed([issue(7, { title: 'x'.repeat(500) })]))
  await wait(80)
  assert.equal(longEntry.lastWakeItem.title.length, 60, '标题截到 60 字')

  // 59 个 ASCII + 1 个 emoji（2 个 UTF-16 单元）：按 UTF-16 截 60 会剩下孤立高位代理，
  // 渲染出来是 �（客户看到的是乱码，不是标题）
  const emojiEntry = persist(makeEntry('o/emoji#s1'))
  await __test.pollWithItems(ctx, emojiEntry, 60000, parsed([issue(8, { title: 'x'.repeat(59) + '😀' })]))
  await wait(80)
  const title = emojiEntry.lastWakeItem.title
  assert.equal(Array.from(title).length, 60, '按码点截到 60：' + title.length)
  assert.ok(title.endsWith('😀'), 'emoji 不能被切成半个') 
})

test('发送真失败时保留上一批（不能把没发出去的说成处理过）', async () => {
  const okCtx = makeCtx({ status: 'idle', followup: () => {} })
  apply(okCtx)
  const entry = persist(makeEntry('o/fail#s1'))
  await __test.pollWithItems(okCtx, entry, 60000, parsed([issue(20, { title: '上一批' })]))
  await wait(80)
  const firstBatch = entry.lastWakeItem
  assert.deepEqual(firstBatch, { number: '20', title: '上一批', kind: 'issue' })

  // 第二次真的发失败：followup 抛错（status 仍 idle —— 若写成 running，decideWake 会提前
  // return，wakeMerged 的失败回调根本不执行，这条用例就成了假阳性）
  const failCtx = makeCtx({ status: 'idle', followup: () => { throw new Error('gh: HTTP 502（网关）') } })
  apply(failCtx)
  await __test.pollWithItems(failCtx, entry, 60000, parsed([
    issue(21, { title: '新的那批 1', updated_at: new Date(Date.now() + 60000).toISOString() }),
    issue(22, { title: '新的那批 2', updated_at: new Date(Date.now() + 90000).toISOString() }),
    issue(23, { title: '新的那批 3', updated_at: new Date(Date.now() + 120000).toISOString() }),
  ]))
  await wait(80)

  assert.deepEqual(entry.lastWakeItem, firstBatch, '失败那一轮不能覆盖上一批')
  assert.equal(String(entry.lastWake).indexOf('failed'), 0, '失败要如实记：' + entry.lastWake)
  // 两轮条数必须不同（1 vs 3）：上一版用例让成功/失败各 1 条，count 被失败批次
  // 覆盖也看不出来 —— 那正是外部 review 指出的「手工保持一致掩盖真实先后两轮」。
  assert.equal(entry.lastWakeCount, 1, '条数跟着 lastWakeItem 一起保留上一批（失败批次不覆盖）')
})

test('没唤醒过时是 null（老状态文件 / 新条目），客户端据此不渲染', async () => {
  const entry = persist(makeEntry('o/never#s1'))
  const state = __test.readState()
  assert.equal(state.watchers['o/never#s1'].lastWakeItem, undefined, '新条目不该凭空有值')
  assert.equal(entry.lastWakeItem, undefined)
})
