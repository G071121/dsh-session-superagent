import test from 'node:test'
// 审核 T30：这些用例会改 process.env.DSH_SUPERAGENT_STATE 却从不还原 ——
import { readFileSync } from 'node:fs'
import assert from 'node:assert/strict'

import { decodeBody } from '../lib/body.js'
import { assertTempStateDir, tempDir } from './fixtures/tmpdir.mjs'
import * as watchModule from '../lib/watch.js'
import {
  linkedPrNote,
  pickLinkedPullRequests,
  TRIAGE_SIGNALS,
  assignmentNote,
  priorityScore,
  classifyGhError,
  parseGhInclude,
  accessNote,
  pickSuggestion,
  mergeWakeTexts,
  msUntilActiveWindow,
  nextWaketimeAt,
  bumpDailyWakes,
  busierThanUsual,
  countCapped,
  dailySummary,
  durationText,
  pushEvent,
  repoBadges,
  stalenessNote,
  sessionWakesLastHour,
  splitBatch,
  statusView,
  silentStreak,
  shouldRunCleanup,
  suggestSessionCap,
  summarizeByRepo,
  stateReasonNote,
  repoStructureNote,
  buildCommentBatchQuery,
  commentSummaryLine,
  parseCommentBatch,
  countReasons,
  jitterMs,
  retryAfterMs,
  throttleDelayMs,
  advanceSeen, applyWatcherAction, batchFresh, decideWake, formatWatchText, newestUpdatedAt,
  hasAckLabel,
  itemTrace, nextDelayMs, normalizeFilters, partitionItems, passesFilters, pruneSeen, pruneWakeTimes,
  inActiveHours, mergePollResult, filterReason, pushFiltered, recordReported, splitFresh,
  staleWorktrees, worktreePlan,
} from '../lib/watch.js'

const item = (number, updatedAt) => ({ number, updated_at: updatedAt, state: 'open', title: `t${number}`, html_url: `https://x/${number}`, user: { login: 'me' } })

test('empty state reports every item as news', () => {
  const items = [item(1, '2026-01-01T00:00:00Z'), item(2, '2026-01-02T00:00:00Z')]
  assert.equal(splitFresh(items, {}).length, 2)
})

test('per-item watermark suppresses the item it already reported', () => {
  const items = [item(2, '2026-01-02T00:00:00Z')]
  const state = { seen: { 2: '2026-01-02T00:00:00Z' } }
  assert.equal(splitFresh(items, state).length, 0, 'the same updated_at is not news')
})

test('a newer update on a seen item is news again', () => {
  const items = [item(2, '2026-01-03T00:00:00Z')]
  const state = { seen: { 2: '2026-01-02T00:00:00Z' } }
  assert.equal(splitFresh(items, state).length, 1)
})

test('the global cursor only floors never-seen items', () => {
  const items = [item(5, '2026-01-05T00:00:00Z')]
  assert.equal(splitFresh(items, { cursor: '2026-01-06T00:00:00Z' }).length, 0)
  assert.equal(splitFresh(items, { cursor: '2026-01-04T00:00:00Z' }).length, 1)
})

test('advanceSeen records each reported item and keeps old keys', () => {
  const next = advanceSeen({ 1: 'a' }, [item(2, 'b'), item(3, 'c')])
  assert.deepEqual(next, { 1: 'a', 2: 'b', 3: 'c' })
})

test('decideWake refuses a running agent and allows an idle one', () => {
  assert.equal(decideWake('running').ok, false)
  assert.match(decideWake('running').reason, /busy/)
  assert.equal(decideWake('idle').ok, true)
  assert.equal(decideWake(undefined).ok, true, 'unknown status is not a blocker')
})

test('formatWatchText 是任务书：类型/标签/指派/链接齐全', () => {
  const rich = {
    number: 7, updated_at: '2026-01-07T00:00:00Z', state: 'open', title: 't7',
    html_url: 'https://x/7', user: { login: 'me' },
    labels: [{ name: 'bug' }, { name: 'ai-fix' }],
    assignees: [{ login: 'alice' }],
  }
  const text = formatWatchText('o/r', [rich])
  assert.match(text, /^【主理鱼】o\/r 有 1 条新动态：/)
  assert.match(text, /#7 \[open\] t7 — @me \(issue\) 标签: bug, ai-fix 指派: @alice https:\/\/x\/7/)
  assert.match(text, /AGENTS\.md/)
  assert.match(text, /不要扩大范围/)
})

test('formatWatchText 把没铺开的条目给成编号，不丢信息', () => {
  const text = formatWatchText('o/r', [item(1, '2026-01-01T00:00:00Z')], { more: 3, restNumbers: [2, 3, 4] })
  assert.match(text, /另有 3 条：#2 #3 #4/)
})

test('newestUpdatedAt picks the newest timestamp', () => {
  const fresh = [item(1, '2026-01-01T00:00:00Z'), item(2, '2026-03-01T00:00:00Z')]
  assert.equal(newestUpdatedAt(fresh), '2026-03-01T00:00:00Z')
  assert.equal(newestUpdatedAt([]), null)
})

test('cooldown suppresses the churn that follows our own handling', () => {
  const now = Date.parse('2026-01-01T00:00:30Z')
  const items = [item(9, '2026-01-01T00:00:20Z')]
  const state = { seen: { 9: '2026-01-01T00:00:10Z' }, lastReported: { 9: now - 20_000 } }
  assert.equal(splitFresh(items, state, { now, cooldownMs: 180_000 }).length, 0)
})

test('after the cooldown a new update is reported again', () => {
  const now = Date.parse('2026-01-01T00:10:00Z')
  const items = [item(9, '2026-01-01T00:09:50Z')]
  const state = { seen: { 9: '2026-01-01T00:09:40Z' }, lastReported: { 9: now - 200_000 } }
  assert.equal(splitFresh(items, state, { now, cooldownMs: 180_000 }).length, 1)
})

test('recordReported stamps every reported item（并丢掉过期的）', () => {
  const now = 1_700_000_000_000
  const recent = now - 60 * 1000          // 一分钟前：还在窗口内
  const ancient = now - 40 * 24 * 3600 * 1000  // 40 天前：早该扔了
  const next = recordReported({ lastReported: { 1: recent, 2: ancient } }, [item(3, 'x')], now)
  assert.equal(next[1], recent, '窗口内的要保留（冷却判断还要用）')
  assert.equal(next[2], undefined, '窗口外的要丢掉（T36 M1：以前只增不减，30 天能到 14 MB）')
  assert.equal(next[3], now)
})

test('partitionItems absorbs our own bump instead of delaying it', () => {
  const now = Date.parse('2026-01-01T00:00:30Z')
  const items = [item(9, '2026-01-01T00:00:20Z')]
  const state = { seen: { 9: '2026-01-01T00:00:10Z' }, lastReported: { 9: now - 20_000 } }
  const { fresh, absorbed } = partitionItems(items, state, { now, cooldownMs: 180_000 })
  assert.equal(fresh.length, 0)
  assert.equal(absorbed.length, 1)
})

test('absorbed bumps never resurface once the cooldown is over', () => {
  const t0 = Date.parse('2026-01-01T00:00:30Z')
  const items = [item(9, '2026-01-01T00:00:20Z')]
  let state = { seen: { 9: '2026-01-01T00:00:10Z' }, lastReported: { 9: t0 - 20_000 } }
  const first = partitionItems(items, state, { now: t0, cooldownMs: 180_000 })
  state = { ...state, seen: advanceSeen(state.seen, first.absorbed) }
  const later = partitionItems(items, { ...state, lastReported: {} }, { now: t0 + 600_000, cooldownMs: 180_000 })
  assert.equal(later.fresh.length, 0, 'watermark already covered it')
  assert.equal(later.absorbed.length, 0)
})

test('applyWatcherAction: pause / resume / delete 只动目标那一条', () => {
  const makeState = () => ({
    watchers: {
      'a/b#s1': { id: 'a/b#s1', repo: 'a/b', sessionId: 's1', enabled: true, lastError: 'boom' },
      'c/d#s2': { id: 'c/d#s2', repo: 'c/d', sessionId: 's2', enabled: true, lastError: null },
    },
  })

  let state = makeState()
  assert.deepEqual(applyWatcherAction(state, { action: 'pause', id: 'a/b#s1' }), { ok: true, action: 'pause', id: 'a/b#s1', enabled: false })
  assert.equal(state.watchers['a/b#s1'].enabled, false)
  assert.equal(state.watchers['c/d#s2'].enabled, true, '不该顺手动别的条目')

  state = makeState()
  state.watchers['a/b#s1'].enabled = false
  assert.deepEqual(applyWatcherAction(state, { action: 'resume', id: 'a/b#s1' }), { ok: true, action: 'resume', id: 'a/b#s1', enabled: true })
  assert.equal(state.watchers['a/b#s1'].lastError, null, '恢复时清掉旧的错误，别让卫星一上来就是红的')

  state = makeState()
  assert.deepEqual(applyWatcherAction(state, { action: 'delete', id: 'a/b#s1' }), { ok: true, action: 'delete', id: 'a/b#s1', deleted: true })
  assert.equal(state.watchers['a/b#s1'], undefined)
  assert.ok(state.watchers['c/d#s2'], '删除不该连带别的条目')

  state = makeState()
  assert.equal(applyWatcherAction(state, { action: 'nope', id: 'a/b#s1' }).ok, false, '未知动作要拒绝')
  assert.equal(applyWatcherAction(state, { action: 'pause', id: 'x/y#zz' }).ok, false, '未知 id 要拒绝')
  assert.equal(applyWatcherAction({}, { action: 'pause', id: 'a/b#s1' }).ok, false, '空状态要拒绝')
  assert.equal(Object.keys(makeState().watchers).length, 2, '被拒绝的调用不能改状态')
})

// ── 竞品蒸馏：过滤器 / 批量 / 退避 / 每小时上限 ──────────────────────────

test('passesFilters：默认跳过机器人、草稿、非 open', () => {
  const bot = { number: 1, state: 'open', user: { login: 'dependabot[bot]', type: 'Bot' } }
  const draft = { number: 2, state: 'open', user: { login: 'me' }, draft: true, pull_request: {} }
  const closed = { number: 3, state: 'closed', user: { login: 'me' } }
  const ok = { number: 4, state: 'open', user: { login: 'me' } }
  assert.equal(passesFilters(bot), false)
  assert.equal(passesFilters(draft), false)
  assert.equal(passesFilters(closed), false)
  assert.equal(passesFilters(ok), true)
  // 显式关掉这些闸就别拦
  assert.equal(passesFilters(bot, { skipBots: false }), true)
  assert.equal(passesFilters(closed, { skipClosed: false }), true)
})

test('passesFilters：label 白名单/黑名单与「只看指派」', () => {
  const withLabels = (names) => ({ number: 9, state: 'open', user: { login: 'me' }, labels: names.map((name) => ({ name })) })
  assert.equal(passesFilters(withLabels(['bug']), normalizeFilters({ labels: ['AI-Fix'] })), false, '大小写不同但没这个标签')
  assert.equal(passesFilters(withLabels(['ai-fix']), normalizeFilters({ labels: ['AI-Fix'] })), true, '标签匹配忽略大小写')
  assert.equal(passesFilters(withLabels(['bug', 'wontfix']), normalizeFilters({ ignoreLabels: ['wontfix'] })), false)
  assert.equal(passesFilters(withLabels(['bug']), normalizeFilters({ ignoreLabels: ['wontfix'] })), true)

  const assigned = { number: 10, state: 'open', user: { login: 'me' }, assignees: [{ login: 'Alice' }] }
  assert.equal(passesFilters(assigned, normalizeFilters({ onlyAssigned: true })), true)
  assert.equal(passesFilters(assigned, normalizeFilters({ onlyAssigned: true, assignee: 'alice' })), true)
  assert.equal(passesFilters(assigned, normalizeFilters({ onlyAssigned: true, assignee: 'bob' })), false)
  assert.equal(passesFilters(withLabels(['bug']), normalizeFilters({ onlyAssigned: true })), false, '没人指派就跳过')
})

test('normalizeFilters 宽容处理脏输入', () => {
  const f = normalizeFilters({ labels: [' a ', '', 'b'], skipBots: false, assignee: '  ' })
  assert.deepEqual(f.labels, ['a', 'b'])
  assert.equal(f.skipBots, false)
  assert.equal(f.assignee, null)
  assert.equal(normalizeFilters(null).skipDrafts, true)
})

test('batchFresh 只取前 N 条，N 非法时退回 3', () => {
  const list = [1, 2, 3, 4, 5]
  assert.deepEqual(batchFresh(list, 2), [1, 2])
  assert.deepEqual(batchFresh(list, 0), [1, 2, 3])
  assert.deepEqual(batchFresh([], 5), [])
})

test('nextDelayMs：失败翻倍；预算内封顶 30 分钟，超出预算封顶 2 小时', () => {
  const base = 30000
  assert.equal(nextDelayMs({ consecutiveFailures: 0 }, base), base)
  assert.equal(nextDelayMs({ consecutiveFailures: 1 }, base), 60000)
  assert.equal(nextDelayMs({ consecutiveFailures: 3 }, base), 240000)
  // 第 5 次仍在预算内：最多 30 分钟
  // base=30s 时：5 次失败 = 30s×32 = 16 分钟（还没到 30 分钟上限）
  assert.equal(nextDelayMs({ consecutiveFailures: 5 }, base), 16 * 60 * 1000)
  // 换成 60s 基准才看得到上限：5 次 → 被 30 分钟截住
  assert.equal(nextDelayMs({ consecutiveFailures: 5 }, 60000), 30 * 60 * 1000, '预算内封顶 30 分钟')
  // 第 6 次起超出预算：改 2 小时一次（原来是 30 分钟一直重试到天荒地老）
  // base=30s：20 次 = 30s×120 = 1 小时（预算外的倍率上限 120）
  assert.equal(nextDelayMs({ consecutiveFailures: 20 }, base), 60 * 60 * 1000)
  // base=60s 才真正碰到 2 小时上限
  assert.equal(nextDelayMs({ consecutiveFailures: 20 }, 60000), 2 * 60 * 60 * 1000, '超出预算封顶 2 小时')
})

test('pruneWakeTimes 只保留最近一小时的唤醒', () => {
  const now = Date.parse('2026-11-01T12:00:00Z')
  const times = [
    Date.parse('2026-11-01T10:00:00Z'),
    Date.parse('2026-11-01T11:30:00Z'),
    Date.parse('2026-11-01T11:59:00Z'),
  ]
  assert.deepEqual(pruneWakeTimes(times, now), [times[1], times[2]])
  assert.deepEqual(pruneWakeTimes(undefined, now), [])
})

test('hasAckLabel：大小写无关，认标签', () => {
  const done = { labels: [{ name: 'bug' }, { name: '主理鱼:已处理' }] }
  const nope = { labels: [{ name: 'bug' }] }
  assert.equal(hasAckLabel(done), true)
  assert.equal(hasAckLabel(done, '主理鱼:已处理'), true)
  assert.equal(hasAckLabel(nope), false)
  assert.equal(hasAckLabel({}), false)
  assert.equal(hasAckLabel({ labels: ['主理鱼:已处理'] }), true, '字符串标签也要认')
})

test('pruneSeen：超龄与超量的记录都被丢掉，留下的按新到旧', () => {
  const now = Date.parse('2026-11-01T12:00:00Z')
  const seen = {
    1: '2026-08-01T00:00:00Z',   // 90 多天前，超龄
    2: '2026-10-31T12:00:00Z',   // 1 天前
    3: '2026-10-20T12:00:00Z',   // 12 天前
    4: '不是时间',
  }
  const kept = pruneSeen(seen, { now })
  assert.deepEqual(Object.keys(kept).sort(), ['2', '3'])
  assert.equal(kept['2'], '2026-10-31T12:00:00.000Z')

  const capped = pruneSeen(seen, { now, maxEntries: 1 })
  assert.deepEqual(Object.keys(capped), ['2'], '超量时只留最新的')
  assert.deepEqual(pruneSeen(undefined, { now }), {})
})

test('worktreePlan：路径安全、分支成对、每次不同', () => {
  const a = worktreePlan({ workdir: 'D:/repo/', repo: 'MYCF711/dsh-session-superagent', sessionTag: 'session-1e82afca-8be2', stamp: 1730000000000 })
  assert.ok(a.dir.startsWith('D:/repo/.dsh-zhuli/MYCF711-dsh-session-superagent-1e82afca-'), a.dir)
  assert.equal(a.branch, 'zhuli/' + a.id)
  const b = worktreePlan({ workdir: 'D:/repo', repo: 'MYCF711/dsh-session-superagent', sessionTag: 'session-1e82afca-8be2', stamp: 1730000001000 })
  assert.notEqual(a.id, b.id, '时间戳不同就该是不同 worktree')
  const odd = worktreePlan({ workdir: 'D:/repo', repo: 'a b/c!d', sessionTag: 'session-!!!', stamp: 1 })
  assert.ok(!odd.id.includes(' '), '空格要清洗掉：' + odd.id)
  assert.ok(!odd.id.includes('!'), '特殊字符要清洗掉：' + odd.id)
})

test('formatWatchText 带隔离工作区/隔离失败说明', () => {
  const one = [item(1, '2026-01-01T00:00:00Z')]
  const ok = formatWatchText('o/r', one, { isolation: { dir: 'D:/x/.dsh-zhuli/a', branch: 'zhuli/a' } })
  assert.ok(ok.includes('【隔离工作区】D:/x/.dsh-zhuli/a'), ok)
  assert.ok(ok.includes('zhuli/a'))
  assert.ok(ok.includes('别碰主工作区'))
  const bad = formatWatchText('o/r', one, { isolation: { error: 'not a git repo' } })
  assert.ok(bad.includes('【隔离失败】not a git repo'), bad)
  const plain = formatWatchText('o/r', one)
  assert.ok(!plain.includes('隔离'), '没有隔离选项时不该出现这段')
})

test('decodeBody：UTF-8 正常解，GBK 字节自动兜底', () => {
  const utf8 = Buffer.from('D:/中文路径/x', 'utf8')
  assert.equal(decodeBody(utf8), 'D:/中文路径/x')
  // "D:/中文路径" 的 GBK 字节：中=D6D0 文=CEC4 路=C2B7 径=BEB6
  const gbk = Buffer.from([0x44, 0x3a, 0x2f, 0xd6, 0xd0, 0xce, 0xc4, 0xc2, 0xb7, 0xbe, 0xb6])
  assert.equal(decodeBody(gbk), 'D:/中文路径')
  assert.equal(decodeBody(Buffer.alloc(0)), '')
})

test('staleWorktrees：只挑超龄的，脏输入直接跳过', () => {
  const now = Date.parse('2026-11-01T12:00:00Z')
  const entries = [
    { name: 'old', mtimeMs: now - 5 * 24 * 3600 * 1000 },
    { name: 'fresh', mtimeMs: now - 3600 * 1000 },
    { name: 'bad', mtimeMs: 'x' },
    null,
  ]
  assert.deepEqual(staleWorktrees(entries, { now }).map((e) => e.name), ['old'])
  assert.deepEqual(staleWorktrees(entries, { now, keepMs: 0 }).map((e) => e.name), ['old', 'fresh'])
  assert.equal(staleWorktrees([]).length, 0)
  assert.equal(staleWorktrees(undefined).length, 0)
})

test('lib/index.js 从 watch.js 导入的每个名字都必须真的导出', () => {
  // 踩过：给 watch.js 加函数时忘了写文件，index.js 却先 import 了 —— node --check 查不出来，
  // 宿主重启时才会整块插件加载失败。这条用例专门守这个洞。
  const src = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')
  const marker = "} from './watch.js'"
  const end = src.indexOf(marker)
  assert.ok(end > 0, '找不到 index.js 里对 watch.js 的 import 块')
  const start = src.lastIndexOf('import {', end) + 'import {'.length
  const names = src.slice(start, end).split(',').map((v) => v.trim()).filter(Boolean)
  assert.ok(names.length > 5, '只解析到 ' + names.length + ' 个名字，解析逻辑可能错了')
  const missing = names.filter((n) => !(n in watchModule))
  assert.deepEqual(missing, [], '这些名字没从 watch.js 导出：' + missing.join(', '))
})

test('inActiveHours：普通时段 / 跨夜 / 空值', () => {
  const at = (h, m = 0) => new Date(2026, 10, 1, h, m)
  assert.equal(inActiveHours('09:00-23:00', at(12)), true)
  assert.equal(inActiveHours('09:00-23:00', at(3)), false)
  assert.equal(inActiveHours('09:00-23:00', at(23, 0)), false, '右开区间，23:00 已经不算')
  assert.equal(inActiveHours('22:00-06:00', at(2)), true, '跨夜要成立')
  assert.equal(inActiveHours('22:00-06:00', at(12)), false)
  assert.equal(inActiveHours('', at(3)), true, '空 = 一直活跃')
  assert.equal(inActiveHours('乱写', at(3)), true, '格式不对就退化成一直活跃')
  assert.equal(inActiveHours('09:00-09:00', at(3)), true, '起止相同也按一直活跃处理')
})

test('mergePollResult：配置字段以盘上为准，轮询结果才写回', () => {
  const stored = { id: 'a/b#s1', enabled: false, intervalSec: 30, filters: { labels: ['x'] }, seen: {}, lastPoll: 'old' }
  const polled = { id: 'a/b#s1', enabled: true, intervalSec: 999, seen: { 1: 'now' }, lastPoll: 'new', lastWake: 'w', extraGarbage: 1 }
  const merged = mergePollResult(stored, polled)
  assert.equal(merged.enabled, false, '暂停不能被 tick 收尾写回成运行中')
  assert.equal(merged.intervalSec, 30, '间隔属于配置，不从内存覆盖')
  assert.deepEqual(merged.filters, { labels: ['x'] }, '过滤器属于配置')
  assert.deepEqual(merged.seen, { 1: 'now' }, 'seen 是轮询结果，要写回')
  assert.equal(merged.lastPoll, 'new')
  assert.equal(merged.lastWake, 'w')
  assert.equal(merged.extraGarbage, undefined, '白名单之外的内存字段不落盘')
})

test('filterReason：每种过滤都给得出人话原因', () => {
  const base = { number: 1, state: 'open', user: { login: 'me' } }
  assert.equal(filterReason(base), null, '什么都没配时应该通过')
  assert.equal(filterReason({ ...base, state: 'closed' }), '已关闭')
  assert.equal(filterReason({ ...base, draft: true }), '草稿 PR')
  assert.equal(filterReason({ ...base, user: { login: 'x[bot]' } }), '机器人')
  assert.equal(filterReason({ ...base, labels: [{ name: 'wontfix' }] }, normalizeFilters({ ignoreLabels: ['wontfix'] })), '排除标签: wontfix')
  assert.equal(filterReason({ ...base, labels: [{ name: 'bug' }] }, normalizeFilters({ labels: ['ai-fix'] })), '不在标签白名单: ai-fix')
  assert.equal(filterReason(base, normalizeFilters({ onlyAssigned: true })), '没有指派给人')
  assert.equal(filterReason({ ...base, assignees: [{ login: 'bob' }] }, normalizeFilters({ onlyAssigned: true, assignee: 'alice' })), '未指派给 @alice')
})

test('pushFiltered：环形缓冲只留最近 max 条', () => {
  let log
  for (let i = 0; i < 8; i += 1) log = pushFiltered(log, { number: i, reason: 'r' + i }, 5)
  assert.equal(log.length, 5)
  assert.deepEqual(log.map((x) => x.number), [3, 4, 5, 6, 7])
})

test('formatWatchText 把 watcher 的「目标/规则」带进消息，并压平换行', () => {
  const one = [item(1, '2026-01-01T00:00:00Z')]
  const without = formatWatchText('o/r', one)
  const withGoal = formatWatchText('o/r', one, { goal: '把 widget 的 issue 都处理完' + String.fromCharCode(10) + '第二行' })
  assert.notEqual(without, withGoal, '带 goal 的消息必须和不带的不同（0.8.8 曾忘了拼接）')
  assert.ok(withGoal.includes('本条目主理目标：把 widget 的 issue 都处理完 第二行'), withGoal)
})

test('mergePollResult 必须保留 filteredLog（面板「最近被过滤」靠它落盘）', () => {
  const stored = { id: 'a/b#s1', enabled: true, filters: { labels: [] } }
  const polled = { id: 'a/b#s1', filteredLog: [{ at: 'now', number: 7, title: 't', reason: '机器人' }] }
  const merged = mergePollResult(stored, polled)
  assert.deepEqual(merged.filteredLog, polled.filteredLog, 'filteredLog 漏出白名单就会永远读不到')
})

test('classifyGhError：把 gh 的原始报错变成人话（真机踩过 EOF）', () => {
  const cases = [
    ['Get "https://api.github.com/repos/a/b/issues?per_page=20": EOF', 'network', '网络抖动'],
    ['HTTP 401: Bad credentials', 'auth', 'gh auth login'],
    ['HTTP 404: Not Found', 'notfound', 'owner/name'],
    ['gh: command not found', 'nogh', 'PATH'],
    ['HTTP 403: API rate limit exceeded', 'ratelimit', '限流'],
    ['something odd', 'other', ''],
  ]
  for (const [input, kind, hintPart] of cases) {
    const got = classifyGhError(input)
    assert.equal(got.kind, kind, input)
    assert.equal(typeof got.hint, 'string', input + ' 的 hint 必须是字符串')
    if (hintPart) {
      assert.ok(got.hint.includes(hintPart), `${input} -> ${got.hint}`)
    } else {
      // 'other' 现在也有兜底提示：必须有"下一步"，只是不针对具体原因
      assert.ok(got.hint.length > 0, `${input} 的兜底提示不能为空`)
      assert.ok(got.hint.includes('watch_doctor') || got.hint.includes('重试'), `${input} 的兜底要给出下一步：${got.hint}`)
    }
  }
  // 长 URL 必须被压缩，否则面板会被一整条 API 地址占满
  const short = classifyGhError('Get "https://api.github.com/repos/a/b/issues?state=all&per_page=20": EOF').short
  assert.ok(!short.includes('api.github.com'), short)
  assert.ok(short.length <= 60, short)
})

test('parseGhInclude：解析 --include 的状态行 / ETag / 正文', () => {
  const LF = String.fromCharCode(10)
  const sample = [
    'HTTP/2.0 200 OK',
    'etag: W/"abc123"',
    'content-type: application/json',
    '',
    '[{"number":1}]',
  ].join(LF)
  const parsed = parseGhInclude(sample)
  assert.equal(parsed.status, 200)
  assert.equal(parsed.etag, 'W/"abc123"')
  assert.equal(parsed.body, '[{"number":1}]')

  // 304：没有正文，但状态要能认出来（这条路径不计入速率限制）
  const notModified = ['HTTP/2.0 304 Not Modified', 'etag: W/"abc123"', '', ''].join(LF)
  assert.equal(parseGhInclude(notModified).status, 304)

  // 纯正文（老版本 gh 或将来格式变化）：不炸，当 0 处理
  const plain = parseGhInclude('[1,2,3]')
  assert.equal(plain.status, 0)
  assert.equal(plain.body, '[1,2,3]')
})

test('ETag 只在真正消费这一轮之后前移（推迟时不前移，否则 304 会把待办吞掉）', async () => {
  const source = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')
  const lines = source.split(/\r?\n/)

  // 1) 不能再有「解析出 etag 就立刻写进 entry」的写法
  const eager = lines.filter((line) => /entry\.etag\s*=/.test(line) && !/\bcommitEtag\b/.test(line))
  assert.equal(eager.length, 0, 'ETag 必须经 commitEtag 提交，不能就地赋值：' + eager.join(' | '))

  // 2) commitEtag 必须存在，且只在 pendingEtag 有值时才写
  assert.ok(/const pendingEtag = parsed\.etag/.test(source), '要从这一轮解析结果里取 pendingEtag')
  assert.ok(/const commitEtag = \(\) => \{ if \(pendingEtag\) entry\.etag = pendingEtag \}/.test(source),
    'commitEtag 只在有值的时候写')

  // 3) 每个「推迟」分支的 return 之前不能提交 ETag —— 这几个分支故意不动 seen/cursor，
  //    ETag 若前移，下一轮条件请求拿到 304 就直接 return，fresh 不再重算，等于丢事件。
  const deferMarkers = [
    '会话正忙，下一轮重试',
    '这条会话一小时内已被唤醒',
    '每小时最多唤醒',
    '本轮期间被暂停或删除',
    '会话已不在',
  ]
  for (const marker of deferMarkers) {
    const at = lines.findIndex((line) => line.includes(marker) && /lastDeferred\s*=/.test(line))
    if (at < 0) continue // 文案随版本变化时不阻断，只校验存在的那几处
    const window = lines.slice(at, Math.min(at + 7, lines.length)).join('\n')
    assert.ok(!/commitEtag\(\)/.test(window), '推迟分支「' + marker + '」不得提交 ETag')
  }

  // 4) 模块仍能正常加载，__test 接口未变
  const mod = await import('../lib/index.js?etag=' + Date.now())
  assert.equal(typeof mod.apply, 'function')
  assert.equal(typeof mod.__test.readState, 'function')
})

test('304 超过 10 分钟不再信任 ETag（真机 #11 评论被 304 吞掉）', async () => {
  const mod = await import('../lib/index.js?etag-behavior=' + Date.now())
  const stale = { etag: 'W/"old"', lastFreshAt: new Date(Date.now() - 11 * 60 * 1000).toISOString() }
  assert.equal(mod.__test.settleNotModified(stale, Date.now()), 'etag-stale')
  assert.equal(stale.etag, undefined, '过期后要丢掉 ETag，下一轮全量重取')
  assert.equal(stale.deferReason, 'etag-stale')
  const fresh = { etag: 'W/"new"', lastFreshAt: new Date().toISOString() }
  assert.equal(mod.__test.settleNotModified(fresh, Date.now()), 'unchanged')
  assert.equal(fresh.etag, 'W/"new"', '新鲜 ETag 不能误删')
})

test('jitterMs：同一条守永远同一个偏移，且在窗口内', () => {
  const a = jitterMs('owner/repo#session-1', 5000)
  const b = jitterMs('owner/repo#session-1', 5000)
  assert.equal(a, b, '同一个 key 必须稳定，否则调试时对不上')
  assert.ok(a >= 0 && a < 5000, '偏移必须落在窗口内：' + a)
  // 不同 key 不应该全都挤在同一个点（取 20 条看分布）
  const offsets = new Set(Array.from({ length: 20 }, (_, i) => jitterMs('repo#' + i, 5000)))
  assert.ok(offsets.size > 8, '20 条守应该散开，实际只用了 ' + offsets.size + ' 个偏移')
  assert.equal(jitterMs('x', 0), 0, '窗口为 0 时不出抖动')
})

test('parseGhInclude 读得出限流头（真实 gh 输出格式）', () => {
  const LF = String.fromCharCode(10)
  const sample = [
    'HTTP/2.0 200 OK',
    'ETag: W/"e1"',
    'X-Ratelimit-Limit: 5000',
    'X-Ratelimit-Remaining: 120',
    'X-Ratelimit-Reset: 1793608466',
    '',
    '[]',
  ].join(LF)
  const parsed = parseGhInclude(sample)
  assert.equal(parsed.remaining, 120)
  assert.equal(parsed.limit, 5000)
  assert.equal(parsed.resetAt, new Date(1793608466 * 1000).toISOString())
})

test('throttleDelayMs：额度充足不动，紧张时推到重置（最多 1 小时）', () => {
  const now = Date.parse('2026-11-02T08:00:00.000Z')
  // 充足：不推迟
  assert.equal(throttleDelayMs({ remaining: 4000, resetAt: '2026-11-02T09:00:00.000Z', now }), 0)
  // 没拿到头：不推迟
  assert.equal(throttleDelayMs({ remaining: null, now }), 0)
  // 紧张：等到重置（+1 秒缓冲）
  const wait = throttleDelayMs({ remaining: 10, resetAt: '2026-11-02T08:10:00.000Z', now })
  assert.equal(wait, 10 * 60 * 1000 + 1000)
  // 重置时间超过 1 小时：封顶 1 小时
  assert.equal(throttleDelayMs({ remaining: 10, resetAt: '2026-11-02T12:00:00.000Z', now }), 3600 * 1000)
  // 重置时间已过：不推迟
  assert.equal(throttleDelayMs({ remaining: 10, resetAt: '2026-11-02T07:00:00.000Z', now }), 0)
})

test('Retry-After：stage 2 限流按服务端说的等，别瞎猜', () => {
  const LF = String.fromCharCode(10)
  const sample = ['HTTP/2.0 403 Forbidden', 'Retry-After: 42', '', ''].join(LF)
  assert.equal(parseGhInclude(sample).retryAfter, 42)
  assert.equal(retryAfterMs(42), 42000)
  assert.equal(retryAfterMs(0), 0, '没给就别推迟')
  assert.equal(retryAfterMs('abc'), 0, '解析不了当没给')
  assert.equal(retryAfterMs(99999), 3600 * 1000, '封顶 1 小时')
})

test('countReasons：按原因累计并按次数排序（客户问「为什么没叫醒」要有答案）', () => {
  let counts = {}
  counts = countReasons(counts, '不在标签白名单: ai-fix')
  counts = countReasons(counts, '不在标签白名单: ai-fix')
  counts = countReasons(counts, '机器人')
  assert.deepEqual(counts, { '不在标签白名单: ai-fix': 2, 机器人: 1 })
  assert.deepEqual(countReasons(counts, ''), counts, '空原因不记')
  // 种类有上限，且保留次数最多的
  let many = {}
  for (let i = 0; i < 30; i += 1) many = countReasons(many, '原因' + i, { maxKinds: 5 })
  assert.equal(Object.keys(many).length, 5)
  assert.deepEqual(Object.keys(countReasons({}, 'x', { maxKinds: 5 })), ['x'])
})

test('唤醒消息带「为什么是这几条」（只给结果不给依据，接收方没法调过滤）', () => {
  const items = [{ number: 7, title: '修一下登录', state: 'open', html_url: 'https://x/7', user: { login: 'a' }, labels: [], assignees: [] }]
  const text = formatWatchText('o/r', items, {
    changedTotal: 9,
    batchLimit: 1,
    skippedReasons: { '不在标签白名单: ai-fix': 5, '机器人': 3, '草稿': 0 },
  })
  assert.ok(text.includes('【为什么是这几条】'), text.slice(0, 120))
  assert.ok(text.includes('本轮共 9 条变化'), '要说清总共多少变化')
  assert.ok(text.includes('取前 1 条'), '要说清这批是怎么截的')
  assert.ok(text.includes('不在标签白名单: ai-fix × 5') && text.includes('机器人 × 3'), '要说清跳过了什么')
  assert.ok(!text.includes('草稿 × 0'), '次数为 0 的不要凑数')

  // 没有依据信息时不要凭空加一行
  const plain = formatWatchText('o/r', items, {})
  assert.ok(!plain.includes('【为什么是这几条】'), '没信息就别硬编')
})

test('唤醒消息的完成标准是可观测的三条（Given-When-Then 思路）', () => {
  const items = [{ number: 1, title: 'x', state: 'open', html_url: 'https://x/1', user: { login: 'u' }, labels: [], assignees: [] }]
  const text = formatWatchText('o/r', items, { criteria: ['改了什么', '怎么验证的', '回写到哪', '第四条留着', '第五条会被截'] })
  assert.ok(text.includes('【完成标准】'), '要有独立的完成标准块')
  assert.ok(text.includes('1. 改了什么') && text.includes('3. 回写到哪'), '按序号列出来')
  assert.ok(text.includes('第四条留着') && !text.includes('第五条'), '最多 4 条，第 5 条起丢掉')
  // 不给标准时退回原来的一句话
  const plain = formatWatchText('o/r', items, {})
  assert.ok(!plain.includes('【完成标准】'))
  // 没有显式 standard 时，末尾仍要有可观测的验收要求（现在拆成了编号三行）
  assert.ok(plain.includes('没有测试结果不算完成'), '要保留“没有测试结果不算完成”这条底线')
})

test('只读仓库要在任务书里直说（否则会话会去试写然后吃 403）', () => {
  assert.equal(accessNote({ push: true }), '', '有写权限就不该提示')
  assert.equal(accessNote(null), '')
  assert.equal(accessNote({}), '', '未知时不猜')
  const note = accessNote({ repo: 'o/r', push: false })
  assert.ok(note.includes('只有读权限'), note)
  assert.ok(note.includes('没法回写'), note)

  const items = [{ number: 1, title: 'x', state: 'open', html_url: 'https://x/1', user: { login: 'u' }, labels: [], assignees: [] }]
  const text = formatWatchText('o/r', items, { access: note })
  assert.ok(text.includes('【权限提示】'), '要单独成行，别混在正文里')
})

test('仓库结构提示：关闭 Issues / 是 fork 都要提前说（否则守着一个永远没条目的仓库）', () => {
  assert.equal(repoStructureNote(null), '')
  assert.equal(repoStructureNote({ hasIssues: true, fork: false }), '')
  const closed = repoStructureNote({ repo: 'o/r', hasIssues: false })
  assert.ok(closed.includes('关闭了 Issues'), closed)
  const fork = repoStructureNote({ repo: 'me/r', fork: true, parent: 'up/r' })
  assert.ok(fork.includes('fork') && fork.includes('up/r'), fork)
  // 有 issue 的 fork（用户自己开了）不提示
  assert.equal(repoStructureNote({ repo: 'me/r', fork: true, parent: 'up/r', hasIssues: true }), '')
})

test('仓库能力徽章：归档/禁用/无 Issues/fork/只读/私有', () => {
  assert.deepEqual(repoBadges(null), [])
  assert.deepEqual(repoBadges({ push: true, hasIssues: true }), [], '正常仓库不该有徽章')
  const archived = repoBadges({ archived: true })
  assert.ok(archived.some((b) => b.text === '已归档' && b.tone === 'warning'))
  const full = repoBadges({ archived: true, disabled: true, hasIssues: false, fork: true, parent: 'up/r', push: false, private: true })
  assert.equal(full.length, 6, full.map((b) => b.text).join('|'))
  assert.ok(full.some((b) => b.tone === 'danger'), '禁用要用危险色')
  // fork 自己开了 Issues：不给 fork 徽章（避免误伤）
  assert.ok(!repoBadges({ fork: true, parent: 'up/r', hasIssues: true }).some((b) => b.text.startsWith('fork')))
})

test('仓库名纠错：优先同名、其次包含、别乱猜', () => {
  const candidates = ['MYCF711/dsh-session-superagent', 'someone/dsh-session-superagent-fork', 'other/unrelated']
  assert.equal(pickSuggestion('me/dsh-session-superagent', candidates), 'MYCF711/dsh-session-superagent', '仓库名相同就是它')
  assert.equal(pickSuggestion('me/dsh-session', candidates), 'MYCF711/dsh-session-superagent', '包含关系也能推')
  assert.equal(pickSuggestion('me/zzz', candidates), null, '完全不相关就别乱建议')
  assert.equal(pickSuggestion('', candidates), null)
  assert.equal(pickSuggestion('me/x', null), null, '没有候选不崩')
  assert.equal(pickSuggestion('me/abc', ['x/abc']), 'x/abc', '短名字只要同名仍然可用')
})

test('「最后是谁在说话」：有就给一行，没就给空（不许瞎编）', () => {
  assert.equal(commentSummaryLine(null), '')
  assert.equal(commentSummaryLine({}), '')
  assert.equal(commentSummaryLine({ login: 'octocat' }), '@octocat')
  assert.equal(commentSummaryLine({ login: 'octocat', at: '2026-11-02T08:00:00Z' }), '@octocat 2026-11-02T08:00:00Z')

  const items = [{
    number: 5, title: '有人已经在处理', state: 'open', html_url: 'https://x/5',
    user: { login: 'author' }, labels: [], assignees: [], comments: 2,
    lastComment: { login: 'helper', at: '2026-11-02T07:00:00Z' },
  }]
  const text = formatWatchText('o/r', items, {})
  assert.ok(text.includes('最后评论: @helper'), text.slice(0, 200))
})

test('最后评论是"我自己发的"要说清楚（那不是有人在处理，是上一轮的痕迹）', () => {
  assert.equal(commentSummaryLine({ login: 'helper', at: 't' }, 'me'), '@helper t')
  assert.equal(commentSummaryLine({ login: 'ME', at: 't' }, 'me'), '我（上一轮留的） t', '大小写不敏感')
  assert.equal(commentSummaryLine({ login: 'helper', at: 't' }, null), '@helper t', '不知道我是谁时照常显示')

  const items = [{
    number: 6, title: '上一轮我评论过', state: 'open', html_url: 'https://x/6',
    user: { login: 'author' }, labels: [], assignees: [], comments: 1,
    lastComment: { login: 'me', at: '2026-11-02T06:00:00Z', self: true },
  }]
  const text = formatWatchText('o/r', items, {})
  assert.ok(text.includes('我（上一轮留的）'), text.slice(0, 200))
})

test('GraphQL 批量：一次查多条，单条 NOT_FOUND 不影响其他条', () => {
  const q3 = buildCommentBatchQuery(3)
  assert.ok(q3.includes('i0:') && q3.includes('i2:'), '要有 3 个别名')
  assert.ok(q3.includes('$n0: Int!') && q3.includes('$n2: Int!'), '变量声明要齐')
  assert.equal(buildCommentBatchQuery(0).includes('i0:'), false, '0 条时不生成别名')
  assert.equal(buildCommentBatchQuery(99).match(/i\d+:/g).length, 10, '上限 10')

  const payload = {
    data: { repository: {
      i0: { number: 7, comments: { nodes: [{ author: { login: 'helper' }, createdAt: '2026-11-02T07:00:00Z' }] } },
      i1: null, // NOT_FOUND
      i2: { number: 9, comments: { nodes: [] } },
    } },
    errors: [{ type: 'NOT_FOUND', path: ['repository', 'i1'] }],
  }
  const parsed = parseCommentBatch(payload)
  assert.deepEqual(parsed['7'], { login: 'helper', at: '2026-11-02T07:00:00Z', linked: [] }, '没关联 PR 时给空数组')
  assert.equal(parsed['9'], undefined, '没有评论就不放进来')
  assert.equal(parseCommentBatch(null) && Object.keys(parseCommentBatch(null)).length, 0)
})

test('关闭原因与"反复重开"：只有重开才在消息里警示', () => {
  assert.equal(stateReasonNote(null), '')
  assert.equal(stateReasonNote({ state: 'open' }), '', '没原因就不说话')
  assert.match(stateReasonNote({ state: 'open', state_reason: 'reopened' }), /重新打开/)
  assert.match(stateReasonNote({ state: 'closed', state_reason: 'not_planned' }), /不做/)
  assert.match(stateReasonNote({ state: 'closed', state_reason: 'completed' }), /已完成/)

  const base = { number: 11, title: 'x', html_url: 'https://x/11', user: { login: 'u' }, labels: [], assignees: [] }
  const reopened = formatWatchText('o/r', [{ ...base, state: 'open', state_reason: 'reopened' }], {})
  assert.ok(reopened.includes('⚠'), '重开的要显眼')
  const closedFine = formatWatchText('o/r', [{ ...base, state: 'closed', state_reason: 'not_planned' }], {})
  assert.ok(!closedFine.includes('⚠'), '正常的关闭原因不喧哗')
})

test('一次只能处理 N 条时，先处理更该处理的（重开 > 有评论 > 有标签 > 其他）', () => {
  assert.equal(priorityScore(null), 0)
  assert.equal(priorityScore({}), 0)
  assert.equal(priorityScore({ state_reason: 'reopened' }), 100)
  assert.equal(priorityScore({ comments: 3 }), 10)
  assert.equal(priorityScore({ labels: [{ name: 'ai-fix' }] }), 5)
  assert.equal(priorityScore({ state_reason: 'reopened', comments: 2, labels: [{ name: 'x' }] }), 115)

  const plain = { number: 1, title: 'a' }
  const tagged = { number: 2, title: 'b', labels: [{ name: 'x' }] }
  const commented = { number: 3, title: 'c', comments: 4 }
  const reopened = { number: 4, title: 'd', state_reason: 'reopened' }
  const picked = batchFresh([plain, tagged, commented, reopened], 2)
  assert.deepEqual(picked.map((i) => i.number), [4, 3], '重开第一、有评论第二')

  // 分数相同保持 GitHub 的 updated 顺序（稳定）
  const a = { number: 11 }, b = { number: 12 }, c = { number: 13 }
  assert.deepEqual(batchFresh([a, b, c], 3).map((i) => i.number), [11, 12, 13])
  assert.deepEqual(batchFresh([a, b, c], 3).map((i) => i.number), [11, 12, 13], '多次调用顺序一致')
})

test('优先级开关：关掉某一类加权后，就按"最近更新"顺序处理', () => {
  const reopened = { number: 1, state_reason: 'reopened' }
  const plain = { number: 2 }
  // 全开：重开在前
  assert.deepEqual(batchFresh([plain, reopened], 2).map((i) => i.number), [1, 2])
  // 关掉重开加权：退回原顺序（稳定）
  assert.deepEqual(batchFresh([plain, reopened], 2, { reopened: false }).map((i) => i.number), [2, 1])
  // 三项全关 == 原顺序
  assert.deepEqual(batchFresh([plain, reopened], 2, { reopened: false, comments: false, labels: false }).map((i) => i.number), [2, 1])
  // 权重本身不受影响
  assert.equal(priorityScore(reopened, { reopened: false }), 0)
  assert.equal(priorityScore({ comments: 1, labels: [{}] }, { comments: false }), 5)
})

test('认领状态：无人认领如实标注，加权默认关闭', () => {
  assert.equal(assignmentNote(null), '')
  assert.equal(assignmentNote({ assignees: [{ login: 'a' }] }), '')
  assert.equal(assignmentNote({ assignees: [] }), '未认领')
  assert.equal(assignmentNote({}), '未认领')

  const item = { number: 9, title: 'x', state: 'open', html_url: 'https://x/9', user: { login: 'u' }, labels: [], assignees: [] }
  const text = formatWatchText('o/r', [item], {})
  assert.ok(text.includes('未认领'), '消息里要如实标注')

  // 默认不加权；显式打开才有
  assert.equal(priorityScore(item), 0)
  assert.equal(priorityScore(item, { unassigned: true }), 3)
  // 已认领的不受 unassigned 影响
  assert.equal(priorityScore({ assignees: [{ login: 'a' }] }, { unassigned: true }), 0)
})

test('分诊信号表：每条都要说清"事实还是判断""默认开不开"', () => {
  assert.ok(Array.isArray(TRIAGE_SIGNALS) && TRIAGE_SIGNALS.length >= 4)
  for (const sig of TRIAGE_SIGNALS) {
    for (const field of ['key', 'label', 'kind', 'weight', 'default', 'why']) {
      assert.ok(sig[field] !== undefined, sig.key + ' 缺字段 ' + field)
    }
    assert.ok(['fact', 'judgment'].includes(sig.kind), sig.key + ' 的 kind 只能是 fact/judgment')
    assert.equal(typeof sig.default, 'boolean')
  }
  // 判断类的默认必须是关的：我们的判断不该默认生效
  for (const sig of TRIAGE_SIGNALS.filter((item) => item.kind === 'judgment')) {
    assert.equal(sig.default, false, sig.key + ' 是判断类，默认必须关')
  }
  // 表里的权重必须和实际打分一致（防止文档与代码走偏）
  const reopened = { state_reason: 'reopened' }
  assert.equal(priorityScore(reopened), TRIAGE_SIGNALS.find((s) => s.key === 'reopened').weight)
  const commented = { comments: 1 }
  assert.equal(priorityScore(commented), TRIAGE_SIGNALS.find((s) => s.key === 'comments').weight)
})

test('躺了多久：open 且超过阈值才说，closed 不吵', () => {
  const now = Date.parse('2026-11-02T00:00:00Z')
  const old = { state: 'open', updated_at: '2026-09-01T00:00:00Z' } // 62 天
  assert.match(stalenessNote(old, { now }), /躺了 62 天/)
  assert.equal(stalenessNote({ state: 'open', updated_at: '2026-11-01T00:00:00Z' }, { now }), '', '刚更新过不算躺')
  assert.equal(stalenessNote({ state: 'closed', updated_at: '2026-09-01T00:00:00Z' }, { now }), '', 'closed 不标')
  assert.equal(stalenessNote({ state: 'open' }, { now }), '', '没有时间戳就不猜')
  assert.equal(stalenessNote({ state: 'open', updated_at: '2026-09-01T00:00:00Z' }, { now, thresholdDays: 90 }), '', '阈值可调')

  const item = { number: 3, title: 'x', state: 'open', html_url: 'https://x/3', user: { login: 'u' }, labels: [], assignees: [], updated_at: new Date(Date.now() - 40 * 86400000).toISOString() }
  assert.ok(formatWatchText('o/r', [item], {}).includes('躺了 40 天'), '消息里要标出来')
  assert.equal(priorityScore(item), 0, '默认不参与排序')
  assert.equal(priorityScore(item, { stale: true }), 2, '开启后 +2')
})

test('关联 PR：open 优先、去重、消息里提醒"已有 PR 在做"', () => {
  const nodes = [
    { __typename: 'CrossReferencedEvent', source: { __typename: 'PullRequest', number: 21, state: 'CLOSED', url: 'u21' } },
    { __typename: 'CrossReferencedEvent', source: { __typename: 'PullRequest', number: 20, state: 'OPEN', url: 'u20' } },
    { __typename: 'CrossReferencedEvent', source: { __typename: 'PullRequest', number: 20, state: 'OPEN', url: 'u20' } },
    { __typename: 'CrossReferencedEvent', source: { __typename: 'Issue', number: 99 } },
    { __typename: 'CrossReferencedEvent', source: null },
  ]
  const picked = pickLinkedPullRequests(nodes)
  assert.deepEqual(picked.map((p) => p.number), [20, 21], 'open 在前、去重、非 PR 忽略')
  assert.equal(pickLinkedPullRequests(null).length, 0)

  assert.equal(linkedPrNote(null), '')
  assert.equal(linkedPrNote([]), '')
  assert.equal(linkedPrNote([{ number: 20, state: 'OPEN' }]), '已有 PR #20（进行中）')
  assert.equal(linkedPrNote([{ number: 20, state: 'OPEN', draft: true }]), '已有 PR #20（进行中·草稿）', '草稿要说清楚')
  assert.equal(linkedPrNote([{ number: 21, state: 'MERGED', draft: true }]), '已有 PR #21（已合并）', '合并不可能是草稿，不加后缀')
  assert.equal(linkedPrNote([{ number: 22, state: 'OPEN', mergeable: 'CONFLICTING' }]), '已有 PR #22（进行中·有冲突）', '冲突要说')
  assert.equal(linkedPrNote([{ number: 23, state: 'OPEN', review: 'REVIEW_REQUIRED' }]), '已有 PR #23（进行中·等 review）')
  assert.equal(linkedPrNote([{ number: 26, state: 'OPEN', ci: 'FAILURE' }]), '已有 PR #26（进行中·CI 失败）')
  assert.equal(linkedPrNote([{ number: 26, state: 'OPEN', ci: 'PENDING' }]), '已有 PR #26（进行中·CI 运行中）')
  assert.equal(linkedPrNote([{ number: 26, state: 'OPEN', ci: 'SUCCESS' }]), '已有 PR #26（进行中）', 'CI 绿了不用提')
  assert.equal(linkedPrNote([{ number: 24, state: 'OPEN', review: 'CHANGES_REQUESTED' }]), '已有 PR #24（进行中·被要求修改）')
  assert.equal(
    linkedPrNote([{ number: 25, state: 'OPEN', mergeable: 'CONFLICTING', review: 'REVIEW_REQUIRED', draft: true }]),
    '已有 PR #25（进行中·草稿·有冲突·等 review）',
    '多个状态可叠加',
  )
  assert.equal(linkedPrNote([{ number: 21, state: 'MERGED' }]), '已有 PR #21（已合并）')
  assert.match(linkedPrNote([{ number: 20, state: 'OPEN' }, { number: 21, state: 'CLOSED' }]), /等 2 个/)

  const item = { number: 7, title: 'x', state: 'open', html_url: 'u7', user: { login: 'u' }, labels: [], assignees: [], linkedPr: [{ number: 20, state: 'OPEN' }] }
  assert.ok(formatWatchText('o/r', [item], {}).includes('已有 PR #20'), '消息里要提醒')
})

test('错误归类覆盖真实见过的 12 种（别退回 other）', () => {
  const cases = [
    ['unexpected EOF', 'network'],
    ['HTTP 403: API rate limit exceeded for user ID 1.', 'ratelimit'],
    ['gh: Not Found (HTTP 404)', 'notfound'],
    ['dial tcp 140.82.114.6:443: i/o timeout', 'network'],
    ['Bad credentials', 'auth'],
    ['error: unable to get local issuer certificate', 'network'],
    ['HTTP 502 Bad Gateway', 'gateway'],
    ['secondary rate limit', 'ratelimit'],
    ['repository "o/r" not found', 'notfound'],
    ['gh: command not found', 'nogh'],
    ['context deadline exceeded', 'network'],
    ['You have exceeded a secondary rate limit', 'ratelimit'],
  ]
  for (const [text, kind] of cases) {
    const r = classifyGhError(text)
    assert.equal(r.kind, kind, `「${text}」应归为 ${kind}，实际 ${r.kind}`)
    assert.ok(r.hint && r.hint.length > 4, `「${text}」必须带一句人话提示`)
  }
  // "command not found" 不能被当成 notfound 仓库
  assert.equal(classifyGhError('gh: command not found').kind, 'nogh')
})

test('时段外要算清"还有多久开门"（并把轮询安排到那一刻）', () => {
  const at = (h, m) => new Date(2026, 10, 2, h, m, 0)
  // 时段内：0
  assert.equal(msUntilActiveWindow('09:00-18:00', at(10, 0)), 0)
  // 夜里 23:30，第二天 09:00 开门 → 9.5 小时
  assert.equal(msUntilActiveWindow('09:00-18:00', at(23, 30)), (9 * 60 + 30) * 60 * 1000)
  // 早上 07:00 → 2 小时
  assert.equal(msUntilActiveWindow('09:00-18:00', at(7, 0)), 2 * 60 * 60 * 1000)
  // 跨夜时段 22:00-06:00：凌晨 3 点在时段内
  assert.equal(msUntilActiveWindow('22:00-06:00', at(3, 0)), 0)
  // 跨夜时段：下午 15:00 → 到 22:00 还有 7 小时
  assert.equal(msUntilActiveWindow('22:00-06:00', at(15, 0)), 7 * 60 * 60 * 1000)
  // 非法/空 → 0（当作一直活跃）
  assert.equal(msUntilActiveWindow('', at(3, 0)), 0)
  assert.equal(msUntilActiveWindow('乱写', at(3, 0)), 0)
  // 永远 >= 1 秒，避免 0 延迟死循环
  assert.ok(msUntilActiveWindow('09:00-18:00', at(8, 59)) >= 1000)
})

test('被每小时上限挡住时，要算得出"还有多久有名额"', () => {
  const now = Date.UTC(2026, 10, 2, 10, 0, 0)
  // 名额没满 -> 现在就可以
  assert.equal(nextWaketimeAt([now - 60_000], 6, now), now)
  // 满 6 次，最早那次在 30 分钟前 -> 还要等 30 分钟
  const times = [30, 25, 20, 15, 10, 5].map((min) => now - min * 60_000)
  assert.equal(nextWaketimeAt(times, 6, now), now - 30 * 60_000 + 60 * 60_000)
  // 过期的不算（超过 1 小时的自动剔除）
  assert.equal(nextWaketimeAt([now - 70 * 60_000], 6, now), now)
  // cap 非法/0 时按 6 兜底，不崩
  // 审核 T23：只断言 typeof 太弱 —— 返回任意数字都能过。真正的判据是「0 与默认 6 等价」。
  assert.equal(nextWaketimeAt(times, 0, now), nextWaketimeAt(times, 6, now), 'cap=0 应按 6 兜底')
  assert.equal(typeof nextWaketimeAt(times, 0, now), 'number')
})

test('隔离区回收：年龄线之外再加数量线（否则 6 次/小时 × 3 天 = 432 个副本）', () => {
  const now = Date.UTC(2026, 10, 2, 12, 0, 0)
  const mk = (name, minsAgo) => ({ name, mtimeMs: now - minsAgo * 60_000 })
  const entries = [1, 2, 3, 4, 5, 6, 7, 8].map((i) => mk('wt' + i, i)) // wt1 最新

  // 都在 3 天内（年龄线不回收），但数量线只留 5 个 -> 回收最旧的 3 个
  const out = staleWorktrees(entries, { now, keepMs: 3 * 86400_000, keepCount: 5 })
  assert.deepEqual(out.map((e) => e.name).sort(), ['wt6', 'wt7', 'wt8'])

  // keepCount 足够大时，只剩年龄线生效
  assert.equal(staleWorktrees(entries, { now, keepMs: 3 * 86400_000, keepCount: 100 }).length, 0)

  // 超龄的即使很新也要回收（wt1 是 3 天前的？不：这里造一个超龄的）
  const oldOne = [mk('old', 60 * 24 * 60)] // 60 天前
  const aged = staleWorktrees([...entries, ...oldOne], { now, keepMs: 3 * 86400_000, keepCount: 100 })
  assert.deepEqual(aged.map((e) => e.name), ['old'])

  // 非法 entry 不该让它崩
  assert.equal(staleWorktrees([null, {}, { name: 'x' }], { now }).length, 0)
})

test('会话级上限：多个守的唤醒次数要累加（单守上限挡不住多守叠加）', () => {
  const now = Date.now()
  const mk = (id, sessionId, times) => ({ id, sessionId, wakeTimes: times })
  const entries = [
    mk('a#s1', 's1', [now - 60_000, now - 120_000, now - 180_000]),
    mk('b#s1', 's1', [now - 90_000, now - 200_000]),
    mk('c#s2', 's2', [now - 60_000]),
    mk('d#s1', 's1', [now - 2 * 3600_000]), // 超过 1 小时，不计入
  ]
  assert.equal(sessionWakesLastHour(entries, 's1', now), 5, 'a 3 次 + b 2 次；过期的不算')
  assert.equal(sessionWakesLastHour(entries, 's2', now), 1)
  assert.equal(sessionWakesLastHour(entries, 'nope', now), 0)
  // 也支持传对象（readState().watchers 的形态）
  const asObject = Object.fromEntries(entries.map((e) => [e.id, e]))
  assert.equal(sessionWakesLastHour(asObject, 's1', now), 5)
  // 空/坏数据不崩
  assert.equal(sessionWakesLastHour(null, 's1', now), 0)
  assert.equal(sessionWakesLastHour([null, {}], 's1', now), 0)
  assert.equal(sessionWakesLastHour(entries, '', now), 0)
})

test('同会话多条唤醒要合并成一条（实测三守相位只差 1 秒）', () => {
  assert.equal(mergeWakeTexts([]), '')
  assert.equal(mergeWakeTexts(['只有一条']), '只有一条', '单条不加包装')
  assert.equal(mergeWakeTexts(['', '   ']), '', '空内容丢掉')
  const merged = mergeWakeTexts(['A 仓库有 2 条', 'B 仓库有 1 条', 'C 仓库有 3 条'])
  assert.ok(merged.includes('3 处变化'), '要说清合并了几处：' + merged.slice(0, 60))
  assert.ok(merged.includes('第 1 处') && merged.includes('第 3 处'), '每处都要有分隔')
  assert.ok(merged.includes('A 仓库有 2 条') && merged.includes('C 仓库有 3 条'), '内容不能丢')
})

test('合并时同一段【完成标准】只保留一份（实测能砍掉近一半长度）', () => {
  const item = (n, repo) => ({ number: n, title: repo + ' 的标题', state: 'open', html_url: 'https://x/' + n, user: { login: 'u' }, labels: [], assignees: [] })
  const opts = {
    criteria: ['改了什么：…', '怎么验证的：…', '回写到哪：…'],
    goal: '让客户的问题当天有回应',
  }
  const a = formatWatchText('o/repoA', [item(1, 'repoA')], opts)
  const b = formatWatchText('o/repoB', [item(2, 'repoB')], opts)
  const merged = mergeWakeTexts([a, b])
  const count = (needle) => (merged.match(new RegExp(needle, 'g')) || []).length
  assert.equal(count('【完成标准】'), 1, '完成标准只该出现一次')
  assert.equal(count('本条目主理目标'), 1, '目标行只该出现一次')
  assert.ok(merged.includes('repoA') && merged.includes('repoB'), '两个仓库的内容都要在')
  assert.ok(merged.length < a.length * 2, '合并后应明显短于简单拼接：' + merged.length + ' vs ' + a.length * 2)

  // 完成标准不同则各自保留（不能误删）
  const c = formatWatchText('o/repoC', [item(3, 'c')], { criteria: ['另一套标准'] })
  const mixed = mergeWakeTexts([a, c])
  assert.equal((mixed.match(new RegExp('【完成标准】', 'g')) || []).length, 2, '不同的完成标准要都留着')
})

test('回收节流：没超额且刚跑过就跳过；超额必须立刻跑', () => {
  const now = Date.UTC(2026, 10, 2, 12, 0, 0)
  // 刚跑过（1 分钟前），数量没超额 -> 跳过
  assert.equal(shouldRunCleanup({ count: 3, keepCount: 5, lastRunAt: now - 60_000, now, intervalMs: 600_000 }).run, false)
  // 超过 10 分钟 -> 跑
  assert.equal(shouldRunCleanup({ count: 3, keepCount: 5, lastRunAt: now - 11 * 60_000, now, intervalMs: 600_000 }).run, true)
  // 超额：无论刚跑没跑过都要跑（否则会堆）
  const over = shouldRunCleanup({ count: 9, keepCount: 5, lastRunAt: now - 1000, now, intervalMs: 600_000 })
  assert.equal(over.run, true)
  assert.equal(over.reason, 'over-cap')
  // 从没跑过 -> 跑
  assert.equal(shouldRunCleanup({ count: 1, keepCount: 5, lastRunAt: 0, now }).run, true)
  // 坏数据不崩
  assert.equal(typeof shouldRunCleanup({}).run, 'boolean')
  assert.equal(typeof shouldRunCleanup().run, 'boolean')
})

test('迷你时间线：有界、只留最近 N 条、坏数据不崩', () => {
  assert.deepEqual(pushEvent(null, { kind: 'wake', text: 'x' }).length, 1)
  assert.deepEqual(pushEvent([], null), [], '没有 kind 的事件丢掉')
  let events = []
  for (let i = 0; i < 30; i += 1) events = pushEvent(events, { kind: 'wake', text: 'e' + i }, 20)
  assert.equal(events.length, 20, '必须有界')
  assert.ok(events[19].text === 'e29', '保留最近的：' + events[19].text)
  assert.ok(!events.some((e) => e.text === 'e0'), '最早的被挤掉')
  // 字段会被裁剪，避免脏数据撑大状态文件
  const long = pushEvent([], { kind: 'x'.repeat(80), text: 'y'.repeat(400) })
  assert.ok(long[0].kind.length <= 24 && long[0].text.length <= 160)
  assert.ok(/T/.test(long[0].at), '要带时间戳')
})

test('连续同一条事件合并成带次数的一条（否则每轮一样的记录会刷满 20 条）', () => {
  let events = []
  for (let i = 0; i < 10; i += 1) events = pushEvent(events, { kind: 'cap-watcher', text: '每小时最多唤醒 6 次' })
  assert.equal(events.length, 1, '连续 10 次应合并成 1 条')
  assert.equal(events[0].count, 10, '次数要记下来：' + JSON.stringify(events[0]))

  // 中间夹了别的事件就不合并，且合并后计数重新开始
  events = pushEvent(events, { kind: 'wake', text: '唤醒了 2 条：#1 #2' })
  events = pushEvent(events, { kind: 'cap-watcher', text: '每小时最多唤醒 6 次' })
  assert.equal(events.length, 3, '不连续就不该合并：' + JSON.stringify(events.map((e) => e.kind)))
  assert.equal(events[2].count, undefined, '新的一条没有次数')

  // 同样的 kind 但文案不同也不合并（不同原因要分开看）
  events = pushEvent(events, { kind: 'cap-watcher', text: '这条会话一小时内已被唤醒 12 次' })
  assert.equal(events.length, 4)

  // 合并后仍然有界
  let many = []
  for (let i = 0; i < 50; i += 1) many = pushEvent(many, { kind: 'k' + (i % 3), text: 't' + i })
  assert.equal(many.length, 20)
})

test('合并事件要能回答"持续了多久"（at 是最新、since 是首次）', () => {
  const t0 = '2026-11-02T10:00:00.000Z'
  const t1 = '2026-11-02T10:42:00.000Z'
  let events = pushEvent([], { kind: 'cap-watcher', text: 'x', at: t0 })
  assert.equal(events[0].since, t0, '首次发生时间要记下来')
  events = pushEvent(events, { kind: 'cap-watcher', text: 'x', at: t1 })
  assert.equal(events.length, 1)
  assert.equal(events[0].since, t0, 'since 不能被覆盖成最新时间')
  assert.equal(events[0].at, t1, 'at 要更新为最新')
  assert.equal(events[0].count, 2)

  assert.equal(durationText(t0, t1), '42 分钟')
  assert.equal(durationText(t0, '2026-11-02T12:05:00.000Z'), '2 小时 5 分')
  assert.equal(durationText(t0, '2026-11-02T12:00:00.000Z'), '2 小时')
  assert.equal(durationText(t0, t0), '不到 1 分钟')
  assert.equal(durationText(null, t1), '', '缺输入给空')
  assert.equal(durationText(t1, t0), '', '反向时间给空')
})

test('叫醒了但没回音：ack 出现过就清零，没有就累加', () => {
  const wake = '2026-11-02T10:00:00.000Z'
  // 还没唤醒过：保持原状
  assert.equal(silentStreak({ previousWakeAt: null, lastAckedAt: null, previousStreak: 0 }), 0)
  // 唤醒过、没有 ack -> 累加
  assert.equal(silentStreak({ previousWakeAt: wake, lastAckedAt: null, previousStreak: 0 }), 1)
  assert.equal(silentStreak({ previousWakeAt: wake, lastAckedAt: null, previousStreak: 2 }), 3)
  // 唤醒后出现了 ack -> 清零
  assert.equal(silentStreak({ previousWakeAt: wake, lastAckedAt: '2026-11-02T10:05:00.000Z', previousStreak: 4 }), 0)
  // ack 在唤醒之前（上一轮的 ack）-> 不算这次的回音
  assert.equal(silentStreak({ previousWakeAt: wake, lastAckedAt: '2026-11-02T09:00:00.000Z', previousStreak: 1 }), 2)
  // 坏数据不崩
  assert.equal(silentStreak({ previousWakeAt: '乱写', previousStreak: 2 }), 2)
  assert.equal(typeof silentStreak(), 'number')
})

test('按仓库汇总：同仓库合并、有问题的排前面、徽章去重', () => {
  const list = [
    { repo: 'ok/one', enabled: true, lastWake: '2026-11-02T09:00:00Z', silentWakes: 0 },
    { repo: 'bad/two', enabled: false, lastWake: '2026-11-02T10:00:00Z', silentWakes: 0, lastError: 'boom' },
    { repo: 'silent/three', enabled: true, lastWake: null, silentWakes: 3 },
    { repo: 'ok/one', enabled: true, lastWake: '2026-11-02T11:00:00Z', silentWakes: 1, repoAccess: { repo: 'ok/one', push: false } },
    { repo: 'ok/one', enabled: true, silentWakes: 0, repoAccess: { repo: 'ok/one', push: false } },
  ]
  const groups = summarizeByRepo(list)
  assert.deepEqual(groups.map((g) => g.repo), ['bad/two', 'silent/three', 'ok/one'], '错误优先、其次未回音、最后正常')
  const one = groups.find((g) => g.repo === 'ok/one')
  assert.equal(one.count, 3, '三条守合成一组')
  assert.equal(one.enabled, 3)
  assert.equal(one.lastWake, '2026-11-02T11:00:00Z', '取最近的唤醒时间')
  assert.equal(one.silentWakes, 1, '取最大的未回音次数')
  assert.equal(one.badges.length, 1, '同样的徽章只留一枚：' + JSON.stringify(one.badges))
  const bad = groups.find((g) => g.repo === 'bad/two')
  assert.equal(bad.errors, 1)
  assert.deepEqual(summarizeByRepo(null), [])
  assert.deepEqual(summarizeByRepo([null, {}]), [])
})

test('被上限挡住的数量按字段统计，不靠匹配文案', () => {
  const list = [
    { id: 'a#s', deferReason: 'cap-session' },
    { id: 'b#s', deferReason: 'cap-watcher' },
    { id: 'c#s', deferReason: 'ratelimit' },
    { id: 'd#s', deferReason: null },
    { id: 'e#s' },
    null,
  ]
  assert.equal(countCapped(list), 2)
  // 就算文案里写着"上限"，只要没字段就不算（这正是旧实现的误判来源）
  assert.equal(countCapped([{ id: 'x', lastDeferred: '每小时最多唤醒 6 次' }]), 0)
  assert.equal(countCapped({ a: { deferReason: 'cap-session' } }), 1, '支持对象入参')
  assert.equal(countCapped(null), 0)
})

test('拆分批量：剩余里绝不能出现已被选中的条目（真实消息里出现过重复）', () => {
  // 三条里按优先级会挑中 #42 和 #77（#77 在原始顺序里排最后）
  const fresh = [
    { number: 42, updated_at: '2026-11-02T09:58:00Z', labels: [] },
    { number: 43, updated_at: '2026-11-02T09:20:00Z', labels: [] },
    { number: 77, updated_at: '2026-11-02T08:30:00Z', labels: [], pull_request: {} },
  ]
  const { listed, rest } = splitBatch(fresh, 2)
  const listedNumbers = listed.map((i) => i.number)
  const restNumbers = rest.map((i) => i.number)
  assert.equal(listed.length + rest.length, fresh.length, '两边加起来必须是全部')
  for (const n of restNumbers) assert.ok(!listedNumbers.includes(n), '#' + n + ' 同时出现在两边：' + JSON.stringify({ listedNumbers, restNumbers }))
  assert.deepEqual([...listedNumbers, ...restNumbers].sort(), [42, 43, 77])
})

test('单条追溯：把"为什么没叫醒"拼成一条结论', () => {
  const watcher = {
    repo: 'acme/x',
    seen: { 42: '2026-11-02T09:55:00.000Z' },
    lastReported: { 42: '2026-11-02T09:55:00.000Z' },
    filteredLog: [{ at: '2026-11-02T09:30:00.000Z', number: 51, title: 'x', reason: '已关闭' }],
    history: [
      { at: '2026-11-02T09:55:00.000Z', numbers: [42], ok: true, reason: null },
      { at: '2026-11-02T09:41:00.000Z', numbers: [43], ok: false, reason: 'agent busy (running)' },
    ],
  }
  const hit = itemTrace(watcher, 42)
  assert.match(hit.verdict, /已经唤醒过 1 次/)
  assert.equal(hit.seen, '2026-11-02T09:55:00.000Z')
  assert.equal(hit.wakes.length, 1)

  const filtered = itemTrace(watcher, 51)
  assert.match(filtered.verdict, /被过滤掉了：已关闭/)
  assert.equal(filtered.wakes.length, 0)

  const failed = itemTrace(watcher, 43)
  assert.match(failed.verdict, /尝试唤醒过 1 次但都没成功/)
  assert.equal(failed.wakes[0].ok, false)

  const unknown = itemTrace(watcher, 999)
  assert.match(unknown.verdict, /还没轮到它/)
  assert.equal(itemTrace(watcher, null), null)
  assert.equal(itemTrace(null, 1), null)
})

test('用满了要给具体数字建议（别让客户自己算）', () => {
  // 没用满 -> 不给建议
  assert.equal(suggestSessionCap({ used: 3, cap: 12, capped: 0 }), null)
  // 用满但没守着被挡 -> 温和上调（1.5 倍）
  assert.equal(suggestSessionCap({ used: 12, cap: 12, capped: 0 }), 18)
  // 用满且有守被挡 -> 翻倍
  assert.equal(suggestSessionCap({ used: 12, cap: 12, capped: 3 }), 24)
  // 封顶 60
  assert.equal(suggestSessionCap({ used: 40, cap: 40, capped: 2 }), 60)
  // 坏数据不崩，且不低于 1
  const weird = suggestSessionCap({ used: 'x', cap: 'y', capped: 'z' })
  assert.equal(weird, null)
  assert.ok(suggestSessionCap({ used: 99, cap: 1, capped: 1 }) >= 1)
})

test('按天累计：同日累加、只留最近 N 天、坏数据不崩', () => {
  let daily = {}
  daily = bumpDailyWakes(daily, '2026-11-02T10:00:00Z')
  daily = bumpDailyWakes(daily, '2026-11-02T11:00:00Z')
  assert.equal(daily['2026-11-02'], 2, '同一天要累加')

  for (let i = 1; i <= 9; i += 1) {
    daily = bumpDailyWakes(daily, '2026-10-' + String(i).padStart(2, '0') + 'T10:00:00Z')
  }
  assert.ok(Object.keys(daily).length <= 7, '最多保留 7 天：' + Object.keys(daily).length)
  assert.ok(!('2026-10-01' in daily), '最早的那天应被挤掉')

  assert.deepEqual(bumpDailyWakes(null, 'bad-input'), {}, '坏日期不写入')
  assert.equal(dailySummary({}), null)
  assert.deepEqual(dailySummary({ a: '3', b: 2 }), { days: 2, total: 5, avg: 2.5, today: 0 })
  // today 取当天那一格
  assert.equal(dailySummary({ '2026-11-02': 4, '2026-11-01': 2 }, '2026-11-02T09:00:00Z').today, 4)
})

test('"今天明显比平时忙"要保守：历史不足或高得不多都不提示', () => {
  // 历史不足 3 天 -> 不提示
  assert.equal(busierThanUsual({ days: 2, avg: 3, today: 99 }), false)
  // 历史为 0 -> 没有基线，不提示
  assert.equal(busierThanUsual({ days: 5, avg: 0, today: 10 }), false)
  // 高出不到 2 倍 -> 不提示
  assert.equal(busierThanUsual({ days: 4, avg: 5, today: 9 }), false)
  // 刚好 2 倍 -> 提示
  assert.equal(busierThanUsual({ days: 4, avg: 5, today: 10 }), true)
  // 明显更忙 -> 提示
  assert.equal(busierThanUsual({ days: 7, avg: 3, today: 20 }), true)
  // 坏输入不崩
  assert.equal(busierThanUsual(null), false)
  assert.equal(busierThanUsual({}), false)
})

test('结构化状态视图：文本与 JSON 出自同一份数据', () => {
  const entries = [
    { repo: 'a/x', sessionId: 's1', intervalSec: 60, enabled: true, deferReason: 'cap-session', silentWakes: 2, wakeTimes: [], sessionMaxWakes: 12 },
    { repo: 'b/y', sessionId: 's1', intervalSec: 120, enabled: false, observe: true, filters: { labels: ['bug'], onlyAssigned: true }, wakeTimes: [] },
  ]
  const view = statusView(entries)
  assert.equal(view.watchers.length, 2)
  assert.equal(view.session.id, 's1')
  assert.equal(view.session.cap, 12)
  assert.equal(view.watchers[0].deferReason, 'cap-session')
  assert.equal(view.watchers[0].silentWakes, 2)
  assert.equal(view.watchers[1].enabled, false, '暂停要如实反映')
  assert.equal(view.watchers[1].observe, true)
  assert.deepEqual(view.watchers[1].labels, ['bug'])
  assert.equal(view.watchers[1].onlyAssigned, true)
  // 空输入不崩
  const empty = statusView([])
  assert.equal(empty.watchers.length, 0)
  assert.equal(empty.session.used, 0)
})

test('跳过行要说总数（只说前三个原因会让人以为只有这些）', () => {
  const items = [{ number: 1, title: 'x', state: 'open', html_url: 'https://x/1', user: { login: 'u' }, labels: [], assignees: [] }]
  const text = formatWatchText('o/r', items, {
    changedTotal: 9, batchLimit: 1,
    skippedReasons: { '已关闭': 5, '机器人': 2, '草稿 PR': 1, '已 ack': 1 },
  })
  assert.ok(text.includes('本轮跳过 9 条'), '总数要是 5+2+1+1=9：' + text.split(String.fromCharCode(10)).find((l) => l.includes('跳过')))
  assert.ok(text.includes('已关闭 × 5'), '前三个原因要列出')
  assert.ok(text.includes('草稿 PR × 1'), '第三个原因在列表里')
  assert.ok(!text.includes('已 ack × 1'), '第四个原因不再列（只列前三个）')
  assert.ok(text.includes('等）'), '被截断时要标"等"')

  // 没有跳过时不该出现这一行
  const none = formatWatchText('o/r', items, { changedTotal: 1, batchLimit: 1, skippedReasons: {} })
  assert.ok(!none.includes('本轮跳过'), '没有跳过就不要提')
})

test('每一类错误都要给出"下一步"（客户看到错误时最怕不知道做什么）', () => {
  const samples = [
    'HTTP 401: Bad credentials',
    'HTTP 403: API rate limit exceeded',
    'HTTP 502: Bad Gateway',
    'gh: command not found',
    'HTTP 404: Not Found',
    'Get "https://api.github.com/x": EOF',
    'something totally unexpected',
  ]
  for (const raw of samples) {
    const got = classifyGhError(raw)
    assert.ok(got.hint && got.hint.length > 0, got.kind + ' 缺下一步：' + raw)
    assert.ok(got.short.length > 0, got.kind + ' 缺可读描述')
  }
  // 兜底类必须指向一个可执行动作
  const fallback = classifyGhError('something totally unexpected')
  assert.equal(fallback.kind, 'other')
  assert.match(fallback.hint, /watch_doctor|重试/)
})

test('只有一条变化时不再解释「为什么是这几条」（那是噪音）', () => {
  const one = [{ number: 7, title: 'x', state: 'open', html_url: 'https://x/7', user: { login: 'u' }, labels: [], assignees: [] }]
  const single = formatWatchText('o/r', one, { changedTotal: 1, batchLimit: 5 })
  assert.ok(!single.includes('【为什么是这几条】'), '单条不该解释排序：' + single.slice(0, 120))
  assert.ok(single.includes('#7'), '条目本身还要在')

  // 多条时解释必须保留（客户要知道为什么没铺开）
  const many = [one[0], { ...one[0], number: 8 }]
  const multi = formatWatchText('o/r', many, { changedTotal: 9, batchLimit: 5 })
  assert.ok(multi.includes('【为什么是这几条】'), '多条要有解释')
  assert.ok(multi.includes('本轮共 9 条变化'), '解释里要带总数')

  // 单条但有跳过时，跳过信息仍要说（那不是排序解释，是"我还看过别的"）
  const withSkip = formatWatchText('o/r', one, { changedTotal: 1, batchLimit: 5, skippedReasons: { '已关闭': 2 } })
  assert.ok(withSkip.includes('本轮跳过 2 条'), '跳过信息不能丢')
})

test('之前叫醒过的条目要在消息里标出来（这不是新问题）', () => {
  const item = (n) => ({ number: n, title: 't' + n, state: 'open', html_url: 'https://x/' + n, user: { login: 'u' }, labels: [], assignees: [], updated_at: '2026-11-01T10:00:00Z' })
  const text = formatWatchText('o/r', [item(7), item(8)], {
    changedTotal: 4, batchLimit: 5,
    seenBefore: { 7: '2026-10-30T08:00:00Z' },
  })
  const line7 = text.split(String.fromCharCode(10)).find((l) => l.startsWith('#7')) || ''
  const line8 = text.split(String.fromCharCode(10)).find((l) => l.startsWith('#8')) || ''
  assert.ok(line7.includes('之前叫醒过'), '叫醒过的要标：' + line7)
  assert.ok(line7.includes('2026-10-30'), '要带日期')
  assert.ok(!line8.includes('之前叫醒过'), '没叫醒过的不该标')

  // 没有 seenBefore 时行为不变
  const plain = formatWatchText('o/r', [item(7)], { changedTotal: 1, batchLimit: 5 })
  assert.ok(!plain.includes('之前叫醒过'))
})

test('ack 标签被人手动删掉：本地水位仍然挡住重复叫醒（三种情形都验一遍）', () => {
  const item = (over = {}) => ({
    number: 12, title: 't', state: 'open', html_url: 'https://x/12',
    user: { login: 'u' }, labels: [], assignees: [],
    updated_at: '2026-11-02T10:00:00.000Z', ...over,
  })
  const labelled = item({ labels: [{ name: '主理鱼:已处理' }] })

  // ① 标签在：跳过，并留下可追溯的记录
  assert.equal(hasAckLabel(labelled), true, '有标签就要认出来')
  assert.equal(hasAckLabel(item()), false)

  // ② 标签被删、但本地水位还在：不重复叫醒（updated_at 没有变新）
  const state = { seen: { 12: '2026-11-02T10:00:00.000Z' }, cursor: '2026-11-01T00:00:00.000Z' }
  const afterDelete = partitionItems([item()], state, { cooldownMs: 180000 })
  assert.equal(afterDelete.fresh.length, 0, '水位挡住重复叫醒')

  // ③ 标签被删、水位也没了（换了机器 / 状态重建）：会再叫醒一次 —— 这是设计取舍
  const afterLoss = partitionItems([item()], { seen: {}, cursor: '2026-11-01T00:00:00.000Z' })
  assert.equal(afterLoss.fresh.length, 1, '两边都没痕迹时会再叫醒一次（可接受）')

  // 边界：条目被编辑过（updated 变新）时，即使有水位也会重新叫醒 —— 客户改了内容
  const edited = item({ updated_at: '2026-11-03T00:00:00.000Z' })
  const afterEdit = partitionItems([edited], state, { cooldownMs: 180000 })
  assert.equal(afterEdit.fresh.length, 1, '内容变了要重新处理')
})

test('永久性错误（404 / 改名）至少等半小时再试 —— 别反复撞不存在的资源', () => {
  // 依据：GitHub 最佳实践「wait much longer before you check again」
  assert.equal(watchModule.permanentBackoffMs('notfound', 60000), 30 * 60 * 1000)
  assert.equal(watchModule.permanentBackoffMs('moved', 60000), 30 * 60 * 1000)
  assert.equal(watchModule.permanentBackoffMs('network', 60000), 0, '网络问题不该被当成永久错误')
  assert.equal(watchModule.permanentBackoffMs('ratelimit', 60000), 0)
  // 配置的间隔更长时取配置
  assert.equal(watchModule.permanentBackoffMs('notfound', 45 * 60 * 1000), 45 * 60 * 1000)
})

test('进入时段外等待时清掉旧错误（否则面板会一直显示「异常」）', () => {
  const entry = {
    activeHours: '09:00-23:00',
    lastError: 'gh: HTTP 304（没归类的错误）',
    lastErrorAt: '2026-11-02T14:30:50.655Z',
    consecutiveFailures: 4,
  }
  watchModule.enterActiveHoursDefer(entry, 597 * 60000, '09:00-23:00')
  assert.equal(entry.deferReason, 'active-hours')
  assert.equal(entry.lastError, null, '旧错误要清掉')
  assert.equal(entry.lastErrorAt, null)
  assert.equal(entry.consecutiveFailures, 0, '失败计数也要归零')
  assert.ok(entry.lastDeferred.includes('597 分钟'), '要说清多久后开始：' + entry.lastDeferred)
  assert.ok(Date.parse(entry.nextAt) > Date.now(), 'nextAt 要指向未来')
})

test('凭证失效要走 30 分钟退避（auth 不会自己好）', () => {
  // 依据：401 重试无意义，反复 401 还可能被风控当成异常
  assert.equal(watchModule.permanentBackoffMs('auth', 60000), 30 * 60 * 1000)
  assert.equal(watchModule.permanentBackoffMs('network', 60000), 0, '网络抖动仍按指数退避')
})

test('合并唤醒消息：收尾的「接下来」只保留一份（内容不同的完成标准照样各留）', () => {
  const tail = String.fromCharCode(10, 10) + '接下来：' + String.fromCharCode(10)
    + '1. 先读仓库 AGENTS.md 的判断规则；' + String.fromCharCode(10)
    + '2. 没有测试结果不算完成；' + String.fromCharCode(10)
    + '3. 做完一条就写回 GitHub。'
  const items = [1, 2, 3].map((n) => '【主理鱼】o/r 有 1 条新动态：' + String.fromCharCode(10)
    + '# ' + n + ' 标题' + String.fromCharCode(10) + '【完成标准】' + String.fromCharCode(10)
    + '1. 第 ' + n + ' 条的标准' + tail)
  const merged = watchModule.mergeWakeTexts(items)
  const tailCount = (merged.match(/接下来：/g) || []).length
  assert.equal(tailCount, 1, '收尾只该出现一次（实际 ' + tailCount + '）')
  for (const n of [1, 2, 3]) {
    assert.ok(merged.includes('第 ' + n + ' 条的标准'), '每条各自的完成标准要保留')
  }
  // 结构断言为主：合并后会多出「—— 第 N 处 ——」分隔行，所以长度只要求净省下一点
  const saved = items.join('').length - merged.length
  assert.ok(saved > 30, '合并后要净省下长度（实际省 ' + saved + '）')
})

test('重试预算：连续失败到第 6 次就放慢到 2 小时一次（不再密集重试）', () => {
  const base = 60000
  const at = (f) => Math.round(watchModule.nextDelayMs({ consecutiveFailures: f }, base) / 60000)
  assert.equal(at(0), 1, '没失败就按配置间隔')
  assert.equal(at(1), 2)
  assert.equal(at(3), 8)
  assert.ok(at(5) <= 30, '预算内不超过 30 分钟')
  assert.ok(at(6) >= 60, '到预算后明显放慢（实际 ' + at(6) + ' 分钟）')
  assert.equal(at(20), 120, '最多 2 小时一次')
})

test('找不到 gh 的报法要认全（Windows 的 cmd 措辞与 Node 的 ENOENT）', () => {
  // 出处：https://nodejs.org/api/errors.html#common-system-errors
  const cases = [
    'spawn gh ENOENT',
    'gh: command not found',
    "'gh' is not recognized as an internal or external command,",
  ]
  for (const text of cases) {
    const why = watchModule.classifyGhError(text)
    assert.equal(why.kind, 'nogh', text + ' → ' + why.kind)
    assert.ok(why.hint.includes('PATH'), '要指向 PATH：' + why.hint)
  }
})

test('403 要分成两件事：限流（等着）与权限不足（要改 token/仓库权限）', () => {
  const rate = watchModule.classifyGhError('gh: HTTP 403: API rate limit exceeded for 1.2.3.4')
  assert.equal(rate.kind, 'ratelimit')
  assert.ok(rate.hint.includes('等'), '限流只要等：' + rate.hint)

  const perm = watchModule.classifyGhError('HTTP 403: Resource not accessible by integration')
  assert.equal(perm.kind, 'permission', '权限问题不能算限流')
  assert.ok(/token|权限/.test(perm.hint), '要指向 token/权限：' + perm.hint)

  const admin = watchModule.classifyGhError('HTTP 403: Must have admin rights to Repository.')
  assert.equal(admin.kind, 'permission')
})

test('未归类的错误要在事件流里留样本（否则永远补不上分类）', () => {
  const entry = { events: [] }
  watchModule.recordOtherError(entry, 'something nobody has seen before: xyz-123')
  assert.equal(entry.events.length, 1)
  assert.equal(entry.events[0].kind, 'other')
  assert.ok(entry.events[0].text.includes('xyz-123'), '要留下原始措辞')

  // 空内容不记（避免噪音）
  watchModule.recordOtherError(entry, '   ')
  assert.equal(entry.events.length, 1)

  // 最多留 3 条：一直记会刷满事件列表
  for (let i = 0; i < 6; i += 1) watchModule.recordOtherError(entry, 'sample-' + i)
  // 审核 T23：以前断言 <= 22 —— 恒真（实际最多 7 条），等于没测。断言真实上限。
  assert.ok(entry.events.length <= 8, '事件流上限该是 8 条以内：' + entry.events.length)
  assert.ok(entry.events.length >= 1, '刚记的几条不该被清空')
})

test('系统错误码各归其类：EACCES 是权限、EPIPE/ETIMEDOUT 是网络', () => {
  assert.equal(watchModule.classifyGhError('spawn gh EACCES').kind, 'permfile')
  assert.equal(watchModule.classifyGhError('spawn gh EPERM').kind, 'permfile')
  assert.equal(watchModule.classifyGhError('EPIPE: broken pipe, write').kind, 'network')
  assert.equal(watchModule.classifyGhError('ETIMEDOUT connect').kind, 'network')
})

test('唤醒消息的完成标准：有/无隔离区两种情况都对（曾经引用过不存在的 iso）', async () => {
  const { wakeCriteria } = await import('../lib/watch.js')
  const plain = wakeCriteria({})
  assert.equal(plain.length, 3)
  assert.ok(plain[2].includes('在 issue 里留言'), '没有隔离区时不该提分支：' + plain[2])
  assert.ok(!plain[2].includes('推分支'), '没有隔离区却说推分支 = 骗人：' + plain[2])

  const isolated = wakeCriteria({ isolation: { dir: '/tmp/wt', branch: 'b' } })
  assert.ok(isolated[2].includes('推分支并开 PR'), '有隔离区时要教它推分支：' + isolated[2])

  assert.ok(wakeCriteria()[2].includes('在 issue 里留言'))
})

test('lib/index.js 里不再引用未声明的 iso（那条 ReferenceError 只在空闲会话真发消息时才爆）', () => {
  const src = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')
  const bad = src.split(/\r?\n/).filter((line) => {
    if (!/\biso\b/.test(line)) return false
    if (/isolation|iso\.|isoLine|const iso|let iso/.test(line)) return false
    if (/^\s*(\/\/|\*)/.test(line)) return false
    return true
  })
  assert.deepEqual(bad, [], '发现未声明的 iso 引用：' + bad.join(' | '))
})

test('「找不到会话」先给宽限期：重启后别让客户看到「请删除或重建」', async () => {
  const { sessionMissingVerdict, SESSION_MISSING_GRACE_MS } = await import('../lib/watch.js')
  const now = Date.parse('2026-11-04T12:00:00Z')

  // 第一次发现：进入宽限期，并记下起点
  const first = sessionMissingVerdict({ now })
  assert.equal(first.grace, true, '第一次不该直接判死')
  assert.equal(first.justNow, true)
  assert.ok(first.startedAt, '要记下起点，下一轮才知道过了多久')

  // 宽限期内：还是宽限
  const inside = sessionMissingVerdict({ missingSince: new Date(now - 2 * 60000).toISOString(), now })
  assert.equal(inside.grace, true, '两分钟还在宽限期内')
  assert.ok(inside.waitMin >= 1)

  // 超过宽限期：判为真的没了
  const expired = sessionMissingVerdict({ missingSince: new Date(now - SESSION_MISSING_GRACE_MS - 60000).toISOString(), now })
  assert.equal(expired.grace, false, '超过宽限期要判死')
  assert.ok(expired.waitedMin >= 11, '要报等了多久：' + expired.waitedMin)

  // 时间戳坏掉也不能卡死：当作刚发现
  assert.equal(sessionMissingVerdict({ missingSince: 'not-a-date', now }).justNow, true)
})

test('lib/index.js 里「会话已不在」必须走宽限期判断，而不是直接判死', () => {
  const src = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')
  assert.ok(src.includes('sessionMissingVerdict('), '要调用宽限期判断')
  assert.ok(!/setEntryError\(entry, '会话已不在：请删除或重建这条主理鱼'\)/.test(src), '不许再出现那句不可逆的建议原文')
})

test('首次同步不能说「新动态」：接上之前就在的条目要如实说', async () => {
  const { formatWatchText } = await import('../lib/watch.js')
  const item = { number: 7, title: 'x', user: { login: 'a' }, html_url: 'u', state: 'open' }

  const first = formatWatchText('o/r', [item], { firstSync: true }).split(String.fromCharCode(10))[0]
  assert.ok(first.includes('首次同步'), '第一次要说明这是首次同步：' + first)
  assert.ok(!first.includes('新动态'), '首次同步不该说「新动态」：' + first)

  const normal = formatWatchText('o/r', [item], {}).split(String.fromCharCode(10))[0]
  assert.ok(normal.includes('新动态'), '平时仍是新动态：' + normal)
})

test('绑了智能体账号：唤醒消息要提身份，但**不许带路径**（PR #7 原设计会漏本机目录）', async () => {
  const { formatWatchText } = await import('../lib/watch.js')
  const item = { number: 7, title: 'x', user: { login: 'a' }, html_url: 'u', state: 'open' }

  const bound = formatWatchText('o/r', [item], { identityBound: true })
  assert.ok(bound.includes('【提交身份】'), '要提醒会话身份可能不一致')
  assert.ok(bound.includes('请向用户索取'), '要说清路径从哪来')
  assert.ok(!bound.includes('GH_CONFIG_DIR='), '不许把环境变量赋值整段塞进消息：' + bound.slice(0, 120))
  assert.ok(!/AppData|Users\\|\/home\//.test(bound), '不许出现本机路径')

  assert.ok(!formatWatchText('o/r', [item], {}).includes('【提交身份】'), '没绑就不该提')
})

test('lastReopened / lastStates 必须能跨轮存活（漏了白名单，面板永远看不到「被重新打开」）', async () => {
  const { mergePollResult, POLL_RESULT_FIELDS } = await import('../lib/watch.js')
  assert.ok(POLL_RESULT_FIELDS.includes('lastReopened'), 'lastReopened 要在白名单里')
  assert.ok(POLL_RESULT_FIELDS.includes('lastStates'), 'lastStates 要在白名单里')

  const merged = mergePollResult({ id: 'x', lastPoll: '2026-11-05T00:00:00Z' }, {
    lastReopened: 'IK1', lastStates: { IK1: 'open' }, lastPoll: '2026-11-05T01:00:00Z',
  })
  assert.equal(merged.lastReopened, 'IK1')
  assert.deepEqual(merged.lastStates, { IK1: 'open' })
})

test('白名单必须覆盖所有「轮询结果」字段（M1：漏一个就是「算出来了但没存」）', async () => {
  const { POLL_RESULT_FIELDS, mergePollResult } = await import('../lib/watch.js')
  // 这些字段都是轮询算出来的：漏一个，对应的功能就静默失效
  const must = [
    'etag', 'needsReauth', 'lastErrorAt', 'deferReason', 'silentWakes', 'prevWakeAt',
    'dailyWakes', 'absorbedLog', 'filterCounts', 'repoAccess', 'sessionMissingSince',
    'minIntervalSec', 'lastCleanupAt', 'lastReopened', 'lastStates',
    // 弹层「最近唤醒的是哪一条」：只在内存里算、漏了白名单就永远写不进状态文件
    'lastWakeItem',
  ]
  const missing = must.filter((f) => !POLL_RESULT_FIELDS.includes(f))
  assert.deepEqual(missing, [], '白名单漏了：' + missing.join(','))

  // 逐字段验证「真的能过去」
  const polled = {}; for (const f of must) polled[f] = 'x'
  const merged = mergePollResult({ id: 'r#s' }, polled)
  const dropped = must.filter((f) => merged[f] === undefined)
  assert.deepEqual(dropped, [], '这些字段在合并时被丢弃：' + dropped.join(','))
})

test('wakeTimes 被写成非数组也不许崩（坏数据的代价不该是整个面板 500）', async () => {
  const { pruneWakeTimes } = await import('../lib/watch.js')
  for (const bad of ['abc', {}, 0, true, { a: 1 }]) {
    assert.doesNotThrow(() => pruneWakeTimes(bad), '输入 ' + JSON.stringify(bad) + ' 不该抛')
    assert.deepEqual(pruneWakeTimes(bad), [], '输入 ' + JSON.stringify(bad) + ' 应得空数组')
  }
  // 正常输入照旧
  const now = Date.now()
  assert.equal(pruneWakeTimes([now - 1000, now - 7200_000], now).length, 1)
})

test('水位只许前进：并发 tick 手里的旧快照不许把 watch_ack 推进的 seen 写回去', async () => {
  const { mergePollResult } = await import('../lib/watch.js')
  // 模拟 writeState 的合并：盘上已是 05:00（ack 写的），内存里 tick 手里是 04:59
  const disk = { id: 'r#s', lastPoll: '2026-11-05T05:00:00.000Z', seen: { 42: '2026-11-05T05:00:00.000Z', 41: '2026-11-05T04:00:00.000Z' } }
  const mem = { id: 'r#s', lastPoll: '2026-11-05T04:59:00.000Z', seen: { 42: '2026-11-05T04:59:00.000Z' } }
  // mergePollResult 是「轮询结果并入盘上」，方向是 disk ← mem；这里验证它不会让 42 后退
  const merged = mergePollResult(disk, mem)
  assert.ok(
    Date.parse(merged.seen[42]) >= Date.parse(disk.seen[42]),
    'seen[42] 后退了：' + merged.seen[42] + ' < ' + disk.seen[42],
  )
})

test('partitionItems 收到非数组不许抛（坏状态会让该守永久退避）', async () => {
  const { partitionItems } = await import('../lib/watch.js')
  for (const bad of ['abc', {}, 0, true, undefined, null]) {
    assert.doesNotThrow(() => partitionItems(bad, {}), '输入 ' + JSON.stringify(bad) + ' 不该抛')
    const { fresh, absorbed } = partitionItems(bad, {})
    assert.deepEqual(fresh, [])
    assert.deepEqual(absorbed, [])
  }
  // 正常输入照旧
  const { fresh } = partitionItems([{ number: 1, updated_at: '2026-11-05T00:00:00Z' }], {})
  assert.equal(fresh.length, 1)
})

test('repo 不许是 . 或 ..（能过字符类，但会拼进 URL 与磁盘路径）', async () => {
  const { parseRepoSpec } = await import('../lib/watch.js')
  for (const bad of ['../..', 'o/..', '../name', './name']) {
    const res = parseRepoSpec(bad)
    assert.equal(res.ok, false, bad + ' 应该被拒绝')
  }
  assert.equal(parseRepoSpec('o/r').ok, true)
  assert.equal(parseRepoSpec('gitee:o/r').provider, 'gitee')
})

test('id=__proto__ 不能污染原型（T19：一次请求改掉 Object.prototype.enabled）', async () => {
  const { applyWatcherAction } = await import('../lib/watch.js')
  const state = { watchers: { 'a#b': { enabled: true } } }
  const res = applyWatcherAction(state, { action: 'pause', id: '__proto__' })
  assert.equal(res.ok, false, '__proto__ 必须被拒')
  assert.equal(({}).enabled, undefined, 'Object.prototype 被污染了')
  assert.equal(state.watchers['a#b'].enabled, true, '正常条目不该被动')
})

test('会话忙时**不许**推进水位（T20：否则下一轮 304，那条评论永远不再叫）', async () => {
  const { planWakeSettlement } = await import('../lib/watch.js')
  const entry = { seen: { 1: 'x' }, wakeTimes: [], history: [], silentWakes: 0, cursor: 'c0' }
  const busy = planWakeSettlement(entry, { ok: false, reason: 'session busy', fresh: [{ number: 42 }] })
  assert.equal(busy.advanceWatermark, false, '失败分支不许推进水位')
  assert.equal(busy.commitEtag, false, '失败分支不许提交 ETag（否则下一轮 304 直接 return）')
  assert.equal(busy.seen, undefined, '不该产出新的 seen')
  assert.equal(busy.cursor, undefined, '不该产出新的 cursor')
  assert.equal(busy.deferReason, 'busy')
  assert.ok(!busy.bumpBackoff, '会话忙是暂时的，别退避')
})

test('真正发出去之后才推进水位，且记账（T20：入队即记账会丢消息）', async () => {
  const { planWakeSettlement } = await import('../lib/watch.js')
  const entry = { seen: { 1: 'x' }, wakeTimes: [], history: [], silentWakes: 0 }
  const ok = planWakeSettlement(entry, {
    ok: true,
    fresh: [{ number: 42, updated_at: '2026-11-05T00:00:00.000Z' }],
    now: 1770000000000,
  })
  assert.equal(ok.advanceWatermark, true)
  assert.equal(ok.commitEtag, true)
  assert.ok(ok.seen['42'], '水位要包含这一批')
  assert.equal(ok.wakeTimes.length, 1, '唤醒次数要记')
  assert.ok(ok.dailyWakes, '当日唤醒数要记')
  assert.equal(ok.deferReason, null)
  assert.match(ok.eventText, /#42/)
})

test('水位只推「这次列出去的」：没列出的条目下一轮还要能提（T38：整批 fresh 全进水位 = 静默丢弃）', async () => {
  const { planWakeSettlement } = await import('../lib/watch.js')
  const fresh = [
    { number: 11, updated_at: '2026-11-05T00:01:00.000Z' },
    { number: 12, updated_at: '2026-11-05T00:02:00.000Z' },
    { number: 13, updated_at: '2026-11-05T00:03:00.000Z' },
  ]
  const listed = fresh.slice(0, 2)
  const entry = { seen: {}, cursor: '2026-11-01T00:00:00.000Z', wakeTimes: [], history: [], silentWakes: 0 }
  const ok = planWakeSettlement(entry, { ok: true, fresh, listed, now: 1770000000000 })
  assert.deepEqual(Object.keys(ok.seen).sort(), ['11', '12'], '只有列出去的进 seen')
  assert.equal(ok.cursor, entry.cursor, '没全列出时全局水位不许前移（否则 #13 被 floor 挡住）')
  // 全部列出去时才推全局水位
  const all = planWakeSettlement(entry, { ok: true, fresh: listed, listed, now: 1770000000000 })
  assert.equal(all.cursor, '2026-11-05T00:02:00.000Z', '全列出时水位推到这批最新')
})

test('「静默丢弃」回归：只列了 2/3 条时，第 3 条下一轮仍是 fresh', async () => {
  const { planWakeSettlement, partitionItems } = await import('../lib/watch.js')
  const items = [
    { number: 21, updated_at: '2026-11-05T00:01:00.000Z' },
    { number: 22, updated_at: '2026-11-05T00:02:00.000Z' },
    { number: 23, updated_at: '2026-11-05T00:03:00.000Z' },
  ]
  const entry = { seen: {}, cursor: '2026-11-01T00:00:00.000Z', wakeTimes: [], history: [], silentWakes: 0 }
  const settled = planWakeSettlement(entry, { ok: true, fresh: items, listed: items.slice(0, 2), now: 1770000000000 })
  const { fresh } = partitionItems(items, { seen: settled.seen, cursor: settled.cursor }, {})
  assert.deepEqual(fresh.map((item) => item.number), [23], '没列出的 #23 必须还能被提，不能静默消失')
})

test('失败的唤醒也要进 history（客户能看到「叫过但没叫醒」）', async () => {
  const { planWakeSettlement } = await import('../lib/watch.js')
  const res = planWakeSettlement({ history: [] }, { ok: false, reason: 'session not live', fresh: [{ number: 7 }] })
  assert.equal(res.history.length, 1)
  assert.equal(res.history[0].ok, false)
  assert.match(res.history[0].reason, /session not live/)
  assert.deepEqual(res.lastBatch, [7])
})

test('fresh 为空时水位不许清空（T39：pending 非空但本轮没新增 → cursor 被写成 null，下一轮重复唤醒）', async () => {
  const { planWakeSettlement } = await import('../lib/watch.js')
  const entry = { cursor: '2026-11-01T00:00:00.000Z', seen: {}, wakeTimes: [], history: [], silentWakes: 0 }
  const out = planWakeSettlement(entry, {
    ok: true,
    fresh: [],
    listed: [{ number: 41, updated_at: '2026-10-01T00:00:00.000Z' }],
  })
  // 纯函数层的防线：正常路径根本走不到这里（调用方 `fresh.length === 0` 就早退了），
  // 但一旦有人再放开那个早退，这里必须挡住 —— newestUpdatedAt([]) 是 null，
  // 写回等于把水位清空，下一轮旧内容会被当成「首次同步」重提。
  assert.equal(out.cursor, entry.cursor, 'fresh 为空时 newestUpdatedAt 返回 null，不许写回')
  assert.deepEqual(Object.keys(out.seen), ['41'], 'listed 里的条目照常进 seen')
})

test('batchLimit=1 连续两轮：先提第 1 条、下轮提第 2 条，且不重复第 1 条', async () => {
  const { planWakeSettlement, partitionItems } = await import('../lib/watch.js')
  // 真实 API 是 sort=updated&direction=desc（新→旧）：fixture 必须降序，
  // 否则「batchLimit=1 时第一轮列哪条」会和真机反着来（desc 下先列 #32）。
  const items = [
    { number: 32, updated_at: '2026-11-05T00:02:00.000Z' },
    { number: 31, updated_at: '2026-11-05T00:01:00.000Z' },
  ]
  // 旧水位必须**非 null**：`cursor: null` 会让「保留」与「清空」同值，断言等于空转。
  const entry = { seen: {}, cursor: '2026-10-01T00:00:00.000Z', wakeTimes: [], history: [], silentWakes: 0 }
  // 第一轮：只列第 1 条（batchLimit=1 的等价形状）
  const round1 = planWakeSettlement(entry, { ok: true, fresh: items, listed: items.slice(0, 1) })
  assert.deepEqual(Object.keys(round1.seen), ['32'], '第一轮只记列出去的第 1 条')
  assert.equal(round1.cursor, entry.cursor, '没全列出时全局水位不动（保持旧水位，不是 null）')
  // 第二轮：第 2 条仍是 fresh，第 1 条不能重复
  const r2 = partitionItems(items, { seen: round1.seen, cursor: round1.cursor }, {})
  assert.deepEqual(r2.fresh.map((i) => i.number), [31], '第 2 条要能被提，第 1 条不能重复')
  const round2 = planWakeSettlement(
    { ...entry, seen: round1.seen, cursor: round1.cursor },
    { ok: true, fresh: r2.fresh, listed: r2.fresh },
  )
  assert.deepEqual(Object.keys(round2.seen).sort(), ['31', '32'], '两轮之后两条都记过')
  assert.equal(round2.cursor, '2026-11-05T00:01:00.000Z', '全部列出时才推全局水位')
})

test('实际间隔 = 自己配置与 x-poll-interval 取大者（T23：以前测试在算自己的算术）', async () => {
  const { effectiveIntervalMs } = await import('../lib/watch.js')
  // 没有下限：用自己的
  assert.equal(effectiveIntervalMs({ minIntervalSec: 0 }, 60000), 60000)
  // 下限更大：用下限（**且乘 1000** —— 忘了乘就是 60 毫秒，轮询会变成疯转）
  assert.equal(effectiveIntervalMs({ minIntervalSec: 120 }, 60000), 120000)
  // 自己更大：用自己
  assert.equal(effectiveIntervalMs({ minIntervalSec: 10 }, 300000), 300000)
  // 坏值不该产出 NaN / 负数
  assert.equal(effectiveIntervalMs({ minIntervalSec: 'abc' }, 60000), 60000)
  assert.equal(effectiveIntervalMs(null, 60000), 60000)
  assert.ok(effectiveIntervalMs({ minIntervalSec: -99 }, 60000) > 0)
})

test('合并多条唤醒时「接下来」必须还在（T31 M2：去重把整段指令吃掉了）', async () => {
  const { mergeWakeTexts } = await import('../lib/watch.js')
  const one = '第 1 处\n【完成标准】\n- 有 ack\n接下来：\n1. 读 AGENTS.md\n2. 改\n3. 回'
  const two = '第 2 处\n【完成标准】\n- 有 ack\n接下来：\n1. 读 AGENTS.md\n2. 改\n3. 回'
  const merged = mergeWakeTexts([one, two])
  const tails = (merged.match(/接下来：/g) || []).length
  assert.equal(tails, 1, '合并后「接下来」应当恰好出现 1 次，实际 ' + tails)
  assert.match(merged, /读 AGENTS\.md/, '下一步指令不能丢')
  // 完成标准该去重（只留一份）
  assert.equal((merged.match(/【完成标准】/g) || []).length, 1, '完成标准应当只留一份')
})

test('「取前 N 条」说的是优先级，不是「最近更新」（T31 M3：文案与实际排序不符）', async () => {
  const { formatWatchText } = await import('../lib/watch.js')
  const list = [1, 2, 3, 4, 5].map((n) => ({ number: n, title: 't' + n, state: 'open', html_url: 'u' + n, updated_at: '2026-11-05T00:00:00Z' }))
  const text = formatWatchText('o/r', list, { batchLimit: 3, changedTotal: 9 })
  assert.ok(!text.includes('最近更新'), '不该再写「按最近更新」—— 实际按 priorityScore 排')
  assert.match(text, /按优先级取前 3 条/)
})

test('超长标题不会把行撑过 120 字符（T31 M1：175 字符的行会让聊天窗口一堵墙）', async () => {
  const { formatWatchText } = await import('../lib/watch.js')
  const huge = '【超长标题】' + '很长的说明文字'.repeat(30)
  const text = formatWatchText('o/r', [{ number: 55, title: huge, state: 'open', html_url: 'https://example.invalid/55' }], {})
  const over = text.split(String.fromCharCode(10)).filter((line) => [...line].length > 120)
  assert.equal(over.length, 0, '有行超过 120 字符：' + over.map((l) => [...l].length).join(','))
  assert.match(text, /…/, '超长标题应当带省略号，而不是硬切')
})

test('activeHours 格式写错要拒绝，不能静默变成全天有效（T32：回执照打 [activeHours=9-23]）', async () => {
  const { validateActiveHours } = await import('../lib/watch.js')
  assert.equal(validateActiveHours('09:00-23:00').ok, true)
  assert.equal(validateActiveHours('').ok, true, '空 = 不限时段')
  assert.equal(validateActiveHours(null).ok, true)
  for (const bad of ['9-23', '09:00~23:00', '9:00-25:00', '25:00-26:00', 'ab:cd-ef:gh']) {
    const res = validateActiveHours(bad)
    assert.equal(res.ok, false, bad + ' 应当被拒绝')
    assert.ok(res.reason && res.reason.includes('HH:MM'), bad + ' 要说明正确格式')
  }
})

test('唤醒失败的原因要客户能看懂（T33 M3：以前是 session not live 这种英文内部话）', async () => {
  const { decideWake } = await import('../lib/watch.js')
  const busy = decideWake('running').reason
  assert.match(busy, /[\u4e00-\u9fa5]/, '要有中文说明：' + busy)
  assert.match(busy, /顺延|等/, '要说下一步：' + busy)
  assert.match(busy, /busy/, '排查用的英文状态值要保留：' + busy)
})

test('lastReported 必须是有界的（T36 M1：以前只增不减，20 守跑 30 天约 14 MB）', async () => {
  const { recordReported } = await import('../lib/watch.js')
  const now = Date.now()
  let state = { lastReported: {} }
  // 模拟 20 条守跑 400 轮（每小时一条新条目）
  for (let round = 0; round < 400; round += 1) {
    const fresh = Array.from({ length: 20 }, (_, i) => ({ number: round * 20 + i }))
    state.lastReported = recordReported(state, fresh, now + round * 3600 * 1000)
  }
  const count = Object.keys(state.lastReported).length
  assert.ok(count <= 200, '条数要有上限，实际 ' + count)
  assert.ok(JSON.stringify(state.lastReported).length < 8000, '体积要小，实际 ' + JSON.stringify(state.lastReported).length)
})

test('只理名单里的人（官方原型的 Policy 最小版：谁可以给你派活）', async () => {
  const { filterReason, normalizeFilters } = await import('../lib/watch.js')
  const by = (login, allow) => filterReason({ number: 1, state: 'open', user: { login }, labels: [], assignees: [] }, { allowAuthors: allow })
  assert.equal(by('alice', []), null, '空名单 = 谁都算（保持老行为）')
  assert.equal(by('alice', ['alice']), null, '名单里有她')
  assert.equal(by('Alice', ['alice']), null, '大小写不敏感')
  assert.equal(by('alice', ['@alice']), null, '允许带 @ 前缀')
  assert.match(String(by('bob', ['alice'])), /作者不在名单/, '不在名单要说明原因（能被 /state 和 trace 看到）')
  // normalizeFilters 要去掉 @，否则面板存下来的值匹配不上
  assert.deepEqual(normalizeFilters({ allowAuthors: ['@Alice', ' bob '] }).allowAuthors, ['Alice', 'bob'])
})

test('同一编号再被叫醒时，要带回上次 ack 留的话（诉求 2：不留手尾）', async () => {
  const { formatWatchText } = await import('../lib/watch.js')
  const items = [{ number: 7, title: '修登录', state: 'open', user: { login: 'alice' }, labels: [], assignees: [], html_url: 'https://x/7' }]
  const withNote = formatWatchText('o/r', items, { acked: { 7: { at: '2026-11-01T10:00:00Z', note: '已修，见 #57' } } })
  assert.match(withNote, /上次处理/, '要提示这条以前处理过')
  assert.match(withNote, /已修，见 #57/, '要把上次留的话原样带回')
  assert.match(withNote, /2026-11-01/, '要带日期，方便判断多久以前')
  const without = formatWatchText('o/r', items, {})
  assert.ok(!without.includes('上次处理'), '没记过就别硬编')
})

test('提过但没回执的条目，下一轮再提一次（Ticket「open」的最小版）', async () => {
  const { recordPendingWake, clearPending, pendingRetry } = await import('../lib/watch.js')
  const t0 = '2026-11-05T00:00:00.000Z'
  const pending = recordPendingWake({}, [7, 8], t0)
  assert.equal(pending['7'].tries, 1)

  const items = [{ number: 7, state: 'open' }, { number: 8, state: 'open' }]
  // 冷却期内不提（不打断）
  assert.equal(pendingRetry(pending, items, { now: Date.parse('2026-11-05T00:05:00Z') }).retry.length, 0, '刚提过就别紧接着再提')
  // 过冷却期要提，并带上「第几次」
  const later = pendingRetry(pending, items, { now: Date.parse('2026-11-05T00:20:00Z') })
  assert.equal(later.retry.length, 2)
  assert.equal(later.retry[0].retryOf.tries, 1)
  // 次数用完就放弃（不打扰）
  const twice = recordPendingWake(pending, [7], '2026-11-05T00:20:00Z')
  assert.equal(pendingRetry(twice, items, { now: Date.parse('2026-11-05T00:40:00Z') }).retry.length, 1, '8 还能提一次，7 提满了')
  // 关掉的不提
  assert.equal(pendingRetry(pending, [{ number: 7, state: 'closed' }], { now: Date.parse('2026-11-05T00:20:00Z') }).retry.length, 0)
  // ack 之后彻底不提
  assert.equal(pendingRetry(clearPending(pending, [7, 8]), items, { now: Date.parse('2026-11-05T00:20:00Z') }).retry.length, 0)
})

test('唤醒消息里要标出「上一轮提过，还没回执」', async () => {
  const { formatWatchText } = await import('../lib/watch.js')
  const item = { number: 7, title: 'x', state: 'open', user: { login: 'a' }, labels: [], assignees: [], html_url: 'https://x/7', retryOf: { tries: 1, first: '2026-11-05T00:00:00Z', at: '2026-11-05T00:00:00Z' } }
  const text = formatWatchText('o/r', [item], {})
  assert.match(text, /上一轮提过/, '要标出来，否则会话以为是新事件')
  assert.match(text, /第 2 次/, '要说清是第几次')
})

test('acked / pending 必须真的写进状态文件（白名单是手维护的，漏了会静默丢失）', async () => {
  const { POLL_RESULT_FIELDS } = await import('../lib/watch.js')
  // seenComments 是 PR 守的水位：漏了它，唤醒成功了但一写盘就被旧值覆盖 → 同一条评论每轮重复叫醒
  for (const key of ['acked', 'pending', 'seenComments']) {
    assert.ok(POLL_RESULT_FIELDS.includes(key), key + ' 必须在落盘白名单里，否则「算出来了但没存」')
  }
})

test('唤醒质量：有动作率 / 开工时延 / 回执空白（《为什么做这个产品》的三个数）', async () => {
  const { wakeQuality } = await import('../lib/watch.js')
  const entry = {
    history: [
      { at: '2026-11-05T10:03:00Z', numbers: [1, 2], ok: true, oldest: '2026-11-05T10:00:00Z' },
      { at: '2026-11-05T10:33:00Z', numbers: [3], ok: true, oldest: '2026-11-05T10:30:00Z' },
      { at: '2026-11-05T11:00:00Z', numbers: [], ok: false, reason: 'busy' },
    ],
    acked: { 1: { at: '2026-11-05T10:10:00Z', note: 'done' } },
    lastAcked: { numbers: [3] },
    silentWakes: 0,
  }
  const q = wakeQuality(entry)
  assert.equal(q.wakeCount, 2, '失败的那次不算一次成功唤醒')
  assert.equal(q.itemsWoken, 3)
  assert.equal(q.itemsAcked, 2, 'acked 里的 1 和 lastAcked 里的 3 都算有动作')
  assert.equal(q.actionRate, 0.67)
  assert.equal(q.medianLatencyMs, 180000, '两次都是 3 分钟')
  assert.match(q.verdict, /偏低/, '2/3 低于 0.7 要说出来')
  // 没叫醒过 = 没数据，不是 0
  const empty = wakeQuality({ history: [] })
  assert.equal(empty.actionRate, null, '没叫醒过不该显示 0%')
  // **关键**：不能有每次调用都变的时间戳，否则 /state 的 ETag 永远不命中
  assert.ok(!('computedAt' in q), 'quality 里不许放每次调用都变的时间戳')
})

// ─────────────────────────────────────────────────────────────────────────────
// Task 5：PR 响应轮询（pollPrOnce）与 watch_pr_* 工具
// ─────────────────────────────────────────────────────────────────────────────

/** 一条 PR 评论（形状与 parsePrSearch 归一后的契约一致）。 */
const prComment = (id, author, body = 'body ' + id) => ({
  id,
  author,
  body,
  createdAt: '2026-11-13T00:00:0' + (id % 10) + 'Z',
})

/** gh api graphql 的原始返回（parsePrSearch 的输入）。 */
function prGraphql(rows) {
  return {
    data: {
      search: {
        nodes: rows.map((row) => ({
          number: row.number,
          title: row.title || 'PR ' + row.number,
          isDraft: false,
          headRefName: row.headRef || 'feature/' + row.number,
          headRepository: { nameWithOwner: row.headRepo || 'fork/r' },
          baseRepository: { nameWithOwner: row.baseRepo || 'o/r' },
          comments: {
            nodes: (row.comments || []).map((comment) => ({
              databaseId: comment.id,
              author: { login: comment.author },
              createdAt: comment.createdAt,
              body: comment.body,
            })),
          },
        })),
      },
    },
  }
}

function prEntry(over = {}) {
  return {
    id: 'pr:o/r#session-pr',
    repo: 'o/r',
    provider: 'github',
    sessionId: 'session-pr',
    kind: 'pr',
    intervalSec: 300,
    seenComments: {},
    enabled: true,
    audit: false,
    adversarialAudit: false,
    auditMode: 'subagent',
    observe: false,
    goal: null,
    ...over,
  }
}

/** 注入用的 gh runner：返回固定 GraphQL 载荷，并记录调用。 */
function prDeps(rows, over = {}) {
  const calls = []
  return {
    calls,
    selfLogin: 'me',
    ghRun: async (file, args) => {
      calls.push({ file, args })
      const joined = (args || []).join(' ')
      // 首次同步（seenComments 里还没有这个 PR）会走 REST 分页把评论拉全：
      // `repos/o/r/issues/7/comments?per_page=100&page=1`。这里必须回数组，
      // 回 GraphQL 形状会让 pollPrOnce 判「评论列表不是数组」→ 整轮跳过。
      const rest = joined.match(/repos\/([^/\s]+)\/([^/\s]+)\/issues\/(\d+)\/comments/)
      if (rest) {
        const number = Number(rest[3])
        const row = rows.find((item) => item.number === number)
        const list = (row && row.comments) || []
        return {
          code: 0,
          stderr: '',
          stdout: JSON.stringify(list.map((c) => ({
            id: c.id,
            user: { login: c.author },
            body: c.body || '',
            created_at: c.createdAt || '',
          }))),
        }
      }
      return { code: 0, stderr: '', stdout: JSON.stringify(prGraphql(rows)) }
    },
    ...over,
  }
}

/** 假的 wakeMerged：立即用给定结果结算，并记录发出去的消息。 */
function fakeWake(result) {
  const calls = []
  const wake = (ctx, sessionId, text, onSettled) => {
    calls.push({ sessionId, text })
    if (onSettled) onSettled(result)
    return { ok: Boolean(result && result.ok) }
  }
  wake.calls = calls
  return wake
}

/** 每个 pollPrOnce 用例都要一个临时状态目录：persistEntry 会真的写文件。 */
async function withPrState(fn) {
  const previous = process.env.DSH_SUPERAGENT_STATE
  process.env.DSH_SUPERAGENT_STATE = tempDir('superagent-pr-')
  assertTempStateDir('pollPrOnce')
  try {
    return await fn()
  } finally {
    if (previous === undefined) delete process.env.DSH_SUPERAGENT_STATE
    else process.env.DSH_SUPERAGENT_STATE = previous
  }
}

async function prModule(tag) {
  return import('../lib/index.js?pr=' + tag + '=' + Date.now())
}

test('pollPrOnce 无新评论不唤醒也不推进水位', async () => {
  await withPrState(async () => {
    const mod = await prModule('no-new')
    const wake = fakeWake({ ok: true })
    const entry = prEntry({ seenComments: { 7: 100, 99: 5 } })
    await mod.__test.pollPrOnce({}, entry, 300_000, null, {
      ...prDeps([{ number: 7, comments: [prComment(100, 'alice')] }]),
      wake,
    })
    assert.equal(wake.calls.length, 0, '没有 id 大于水位的评论，不该叫醒')
    assert.deepEqual(entry.seenComments, { 7: 100 }, '水位必须原样保留，且关掉的 PR 被剪掉')
    assert.ok(entry.lastPoll, '轮询成功要记 lastPoll')
    assert.equal(entry.deferReason, 'unchanged')
  })
})

test('pollPrOnce 自己发的最后一条不唤醒', async () => {
  await withPrState(async () => {
    const mod = await prModule('self')
    const wake = fakeWake({ ok: true })
    const entry = prEntry()
    await mod.__test.pollPrOnce({}, entry, 300_000, null, {
      ...prDeps([{ number: 7, comments: [prComment(1, 'me'), prComment(2, 'Me')] }]),
      wake,
    })
    assert.equal(wake.calls.length, 0, '本人评论（大小写不同也是本人）不叫醒')
    assert.deepEqual(entry.seenComments, {}, '没消费就不许推进水位')
  })
})

test('pollPrOnce 唤醒成功后水位推进到最后一条', async () => {
  await withPrState(async () => {
    const mod = await prModule('advance')
    const wake = fakeWake({ ok: true })
    const entry = prEntry({ goal: '把 CI 修绿', audit: true })
    // 生产里这条守已经在状态文件里（tick 拿着盘上同一份对象），这里先落盘再轮询
    mod.__test.writeState({ watchers: { [entry.id]: entry } })
    await mod.__test.pollPrOnce({}, entry, 300_000, null, {
      ...prDeps([{ number: 7, title: 'T7', headRef: 'feat/x', comments: [prComment(11, 'alice'), prComment(12, 'bob')] }]),
      wake,
    })
    assert.equal(wake.calls.length, 1)
    const text = wake.calls[0].text
    assert.match(text, /^【PR 响应】o\/r#7 有 2 条新评论/)
    assert.match(text, /PR: T7/)
    assert.match(text, /分支: feat\/x/)
    assert.match(text, /评论者: alice（非本人）/)
    assert.match(text, /目标: 把 CI 修绿/)
    assert.match(text, /审计: 开启（subagent 模式）/, '审计说明段要拼在消息末尾')
    assert.deepEqual(entry.seenComments, { 7: 12 }, '真正发出去之后才推进水位')
    // 内存里推进还不够：persistEntry 走 mergePollResult 的白名单，漏字段就「算出来了但没存」
    const stored = mod.__test.readState().watchers['pr:o/r#session-pr']
    assert.deepEqual(stored.seenComments, { 7: 12 }, '水位必须真的落盘')
    assert.ok(entry.lastWake)
  })
})

test('pollPrOnce：审计与对抗性审计都开时两条说明都在（旧实现 else if 只剩一条）', async () => {
  await withPrState(async () => {
    const mod = await prModule('both-audits')
    const wake = fakeWake({ ok: true })
    const entry = prEntry({ audit: true, adversarialAudit: true, auditMode: 'inline' })
    mod.__test.writeState({ watchers: { [entry.id]: entry } })
    await mod.__test.pollPrOnce({}, entry, 300_000, null, {
      ...prDeps([{ number: 7, title: 'T7', headRef: 'feat/x', comments: [prComment(11, 'alice')] }]),
      wake,
    })
    assert.equal(wake.calls.length, 1)
    const text = wake.calls[0].text
    const auditLines = text.split('\n').filter((line) => line.startsWith('审计:') || line.startsWith('对抗性审计:'))
    // 严格相等：2026-11-13 实测两项都开时消息里只有「对抗性审计」——
    // 当时是 `if (adversarialAudit) ... else if (audit) ...`，对抗性审计把审计吞掉了。
    assert.deepEqual(auditLines, [
      '审计: 开启（inline 模式）',
      '对抗性审计: 开启（inline 模式）',
    ], '两项都开必须各占一行，顺序是「先审计、后对抗性」')
  })
})

test('pollPrOnce 唤醒失败不推进水位', async () => {
  await withPrState(async () => {
    const mod = await prModule('failed')
    const rows = [{ number: 7, comments: [prComment(11, 'alice')] }]

    // 会话忙：这轮本来就不该消费，水位不动、也不该退避（下一轮立刻重试）
    const busyEntry = prEntry()
    await mod.__test.pollPrOnce({}, busyEntry, 300_000, null, { ...prDeps(rows), wake: fakeWake({ ok: false, reason: '会话正忙（agent busy）' }) })
    assert.deepEqual(busyEntry.seenComments, {})
    assert.equal(busyEntry.consecutiveFailures || 0, 0, '会话忙不是失败，不该退避')
    assert.match(String(busyEntry.lastDeferred), /会话正忙/)

    // 真正的投递失败：要退避，但同样不许推进水位
    const brokenEntry = prEntry()
    await mod.__test.pollPrOnce({}, brokenEntry, 300_000, null, { ...prDeps(rows), wake: fakeWake({ ok: false, reason: '宿主没给这个会话提供投递入口' }) })
    assert.deepEqual(brokenEntry.seenComments, {})
    assert.equal(brokenEntry.consecutiveFailures, 1)
    assert.ok(brokenEntry.nextAt, '失败要排下一次退避时间')
  })
})

test('pollPrOnce 跳过非 fork PR', async () => {
  await withPrState(async () => {
    const mod = await prModule('fork')
    const wake = fakeWake({ ok: true })
    const entry = prEntry()
    await mod.__test.pollPrOnce({}, entry, 300_000, null, {
      ...prDeps([
        { number: 8, headRepo: 'o/r', baseRepo: 'o/r', comments: [prComment(1, 'alice')] },
        { number: 9, headRepo: 'fork/r', baseRepo: 'o/r', comments: [prComment(2, 'alice')] },
      ]),
      wake,
    })
    const text = wake.calls[0].text
    assert.match(text, /#9/)
    assert.doesNotMatch(text, /#8/, '同仓库的分支不是 fork PR，不跟')
    assert.deepEqual(entry.seenComments, { 9: 2 })
  })
})

test('pollPrOnce 仅观察模式不推进水位', async () => {
  await withPrState(async () => {
    const mod = await prModule('observe')
    const wake = fakeWake({ ok: true })
    const entry = prEntry({ observe: true })
    await mod.__test.pollPrOnce({}, entry, 300_000, null, {
      ...prDeps([{ number: 7, comments: [prComment(11, 'alice')] }]),
      wake,
    })
    assert.equal(wake.calls.length, 0, '仅观察不真唤醒')
    assert.deepEqual(entry.seenComments, {}, '仅观察不推进水位')
    assert.equal(entry.deferReason, 'observe')
    assert.match(String(entry.lastDeferred), /仅观察/)
  })
})

test('pollPrOnce 超过 10 条评论时截断消息但水位推进到最后一条', async () => {
  await withPrState(async () => {
    const mod = await prModule('truncate')
    const wake = fakeWake({ ok: true })
    const entry = prEntry()
    const comments = Array.from({ length: 12 }, (_, i) => prComment(i + 1, 'alice'))
    await mod.__test.pollPrOnce({}, entry, 300_000, null, { ...prDeps([{ number: 7, comments }]), wake })
    const text = wake.calls[0].text
    assert.equal(text.split('评论者:').length - 1, 10, '一条消息最多列 10 条评论')
    assert.match(text, /还有 2 条/, '其余要给出条数，不能静默丢掉')
    assert.deepEqual(entry.seenComments, { 7: 12 }, '水位推进到最新一条')
  })
})

test('pollPrOnce 走 Gitee：fetchImpl 注入，评论按 id 归一', async () => {
  await withPrState(async () => {
    const mod = await prModule('gitee')
    const wake = fakeWake({ ok: true })
    const entry = prEntry({ provider: 'gitee', id: 'pr:gitee:o/r#session-pr' })
    const fetchImpl = async (url) => ({
      ok: true,
      status: 200,
      text: async () => (String(url).includes('/comments')
        ? JSON.stringify([{ id: '31', user: { login: 'alice' }, body: '这里还有问题', created_at: '2026-11-13T02:00:00Z' }])
        : JSON.stringify([{
          number: 5,
          title: 'Gitee PR',
          draft: false,
          head: { repo: { full_name: 'fork/r' }, user: { login: 'me' }, ref: 'b1' },
          base: { repo: { full_name: 'o/r' } },
        }])),
    })
    await mod.__test.pollPrOnce({}, entry, 300_000, null, { fetchImpl, selfLogin: 'me', wake })
    const text = wake.calls[0].text
    assert.match(text, /o\/r#5/)
    assert.match(text, /评论者: alice（非本人）/)
    assert.deepEqual(entry.seenComments, { 5: 31 }, '字符串 id 必须转成数字再比水位')
  })
})

test('watch_pr_start 存 kind:pr 与 seenComments，并注册成 pr: 前缀', async () => {
  const previousNoPoll = process.env.DSH_SUPERAGENT_NO_POLL
  process.env.DSH_SUPERAGENT_NO_POLL = '1'
  try {
    await withPrState(async () => {
      const mod = await prModule('start')
      const tools = []
      const ctx = {
        tools: { register: (tool) => tools.push(tool) },
        webServer: { register: () => () => {} },
        agents: { currentInitiator: () => ({ id: 'session-pr' }), get: () => null },
        get: () => null,
        effect: (fn) => fn(),
        inject: () => {},
      }
      mod.apply(ctx)
      const start = tools.find((tool) => tool.name === 'watch_pr_start')
      assert.ok(start, '没注册 watch_pr_start')
      const out = JSON.parse(await start.execute({ repo: 'o/r', format: 'json' }))
      assert.equal(out.ok, true)
      assert.equal(out.id, 'pr:o/r#session-pr')
      assert.equal(out.kind, 'pr')
      assert.deepEqual(out.seenComments, {})
      const state = mod.__test.readState()
      assert.equal(state.watchers['pr:o/r#session-pr'].kind, 'pr')
      assert.deepEqual(state.watchers['pr:o/r#session-pr'].seenComments, {})
      assert.equal(state.watchers['pr:o/r#session-pr'].auditMode, 'subagent')
      // 收尾：清掉定时器，别让测试进程吊着
      const stop = tools.find((tool) => tool.name === 'watch_pr_stop')
      await stop.execute({ repo: 'o/r', delete: true })
    })
  } finally {
    if (previousNoPoll === undefined) delete process.env.DSH_SUPERAGENT_NO_POLL
    else process.env.DSH_SUPERAGENT_NO_POLL = previousNoPoll
  }
})

test('watch_pr_start auditMode 非法值被拒', async () => {
  const previousNoPoll = process.env.DSH_SUPERAGENT_NO_POLL
  process.env.DSH_SUPERAGENT_NO_POLL = '1'
  try {
    await withPrState(async () => {
      const mod = await prModule('audit-mode')
      const tools = []
      mod.apply({
        tools: { register: (tool) => tools.push(tool) },
        webServer: { register: () => () => {} },
        agents: { currentInitiator: () => ({ id: 'session-pr' }), get: () => null },
        get: () => null,
        effect: (fn) => fn(),
        inject: () => {},
      })
      const start = tools.find((tool) => tool.name === 'watch_pr_start')
      const out = await start.execute({ repo: 'o/r', auditMode: 'parallel' })
      assert.match(out, /auditMode/)
      assert.match(out, /inline/)
      assert.match(out, /subagent/)
      assert.equal(mod.__test.readState().watchers['pr:o/r#session-pr'], undefined, '非法参数不该落状态')
    })
  } finally {
    if (previousNoPoll === undefined) delete process.env.DSH_SUPERAGENT_NO_POLL
    else process.env.DSH_SUPERAGENT_NO_POLL = previousNoPoll
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// Task 5 review 补测：Minor 3（watch_pr_status 零测试）、Minor 6（activeHours /
// nextAt 早退）、Important 1c（截断改用 Gitee 真实形状）、wakeTimes 记账、
// watch_pr_stop 的 URL 归一
// ─────────────────────────────────────────────────────────────────────────────

/** 造一个「下一分钟」的活跃时段：现在必然不在窗口内，跨午夜也成立。 */
function nextMinuteWindow() {
  const now = new Date()
  const start = (now.getHours() * 60 + now.getMinutes() + 1) % 1440
  const fmt = (m) => String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0')
  return fmt(start) + '-' + fmt((start + 1) % 1440)
}

test('pollPrOnce 单 PR 评论超过 10 条时截断消息但水位推进到最后一条（Gitee 形状）', async () => {
  // GitHub 的 `comments(last:10)` 一次最多 10 条，产不出 12 条的截断形状；
  // 这条路径只可能由 Gitee 触发（per_page=100 取回全部），所以用 Gitee provider。
  await withPrState(async () => {
    const mod = await prModule('truncate-gitee')
    const wake = fakeWake({ ok: true })
    const entry = prEntry({ provider: 'gitee', id: 'pr:gitee:o/r#session-pr' })
    // 真实 Gitee 带 `direction=desc`：id 降序，最新一条在**首条**。
    // 这里必须是降序 —— 曾经用升序 mock 把这个 bug 断言成「通过」了：
    // 取末条拿到的是最旧 id，水位永远只前进一条，同一批评论每轮重报。
    const comments = Array.from({ length: 12 }, (_, i) => ({
      id: String(12 - i),
      user: { login: 'alice' },
      body: 'body ' + (12 - i),
      created_at: '2026-11-13T00:00:0' + (i % 10) + 'Z',
    }))
    const fetchImpl = async (url) => ({
      ok: true,
      status: 200,
      text: async () => (String(url).includes('/comments')
        ? JSON.stringify(comments)
        : JSON.stringify([{
          number: 7,
          title: 'Gitee PR',
          draft: false,
          head: { repo: { full_name: 'fork/r' }, user: { login: 'me' }, ref: 'b1' },
          base: { repo: { full_name: 'o/r' } },
        }])),
    })
    await mod.__test.pollPrOnce({}, entry, 300_000, null, { fetchImpl, selfLogin: 'me', wake })
    const text = wake.calls[0].text
    assert.equal(text.split('评论者:').length - 1, 10, '一条消息最多列 10 条评论')
    assert.match(text, /还有 2 条/, '其余要给出条数，不能静默丢掉')
    assert.deepEqual(entry.seenComments, { 7: 12 }, '水位推进到最新一条')
  })
})

test('pollPrOnce 不在活跃时段时早退：不发请求、不唤醒、不推水位', async () => {
  await withPrState(async () => {
    const mod = await prModule('pr-active-hours')
    const wake = fakeWake({ ok: true })
    const entry = prEntry({ activeHours: nextMinuteWindow() })
    const deps = prDeps([{ number: 7, comments: [prComment(1, 'alice')] }])
    await mod.__test.pollPrOnce({}, entry, 300_000, null, { ...deps, wake })
    assert.equal(deps.calls.length, 0, '活跃时段外不该发 gh 请求')
    assert.equal(wake.calls.length, 0, '活跃时段外不该唤醒')
    assert.deepEqual(entry.seenComments, {}, '活跃时段外不推进水位')
    assert.equal(entry.deferReason, 'active-hours')
    assert.match(String(entry.lastDeferred), /不在活跃时段/)
    // 顺带记住下一次窗口时间：enterActiveHoursDefer 必须写 nextAt，否则 tick 会立刻重试
    assert.ok(entry.nextAt, '要排下一次')
  })
})

test('pollPrOnce 处于退避期时不发请求、不唤醒、不推水位', async () => {
  await withPrState(async () => {
    const mod = await prModule('pr-backoff')
    const wake = fakeWake({ ok: true })
    const entry = prEntry({ nextAt: new Date(Date.now() + 60_000).toISOString() })
    const deps = prDeps([{ number: 7, comments: [prComment(1, 'alice')] }])
    await mod.__test.pollPrOnce({}, entry, 300_000, null, { ...deps, wake })
    assert.equal(deps.calls.length, 0, '退避期不碰 API')
    assert.equal(wake.calls.length, 0, '退避期不唤醒')
    assert.deepEqual(entry.seenComments, {}, '退避期不推进水位')
    assert.equal(entry.consecutiveFailures || 0, 0, '退避不是新失败，不该累加')
  })
})

test('pollPrOnce 唤醒成功记一次 wakeTimes（面板 used 才不是 0）', async () => {
  await withPrState(async () => {
    const mod = await prModule('pr-waketimes')
    const wake = fakeWake({ ok: true })
    const entry = prEntry({ wakeTimes: [] })
    const deps = prDeps([{ number: 7, comments: [prComment(1, 'alice')] }])
    await mod.__test.pollPrOnce({}, entry, 300_000, null, { ...deps, wake })
    assert.equal(wake.calls.length, 1)
    assert.equal(entry.wakeTimes.length, 1, '成功唤醒记一次')
    assert.ok(Number.isFinite(entry.wakeTimes[0]), '记的是时间戳')
  })
})

test('pollPrOnce busy / 投递失败 / 仅观察 都不记 wakeTimes', async () => {
  await withPrState(async () => {
    const mod = await prModule('pr-waketimes-no')
    const rows = [{ number: 7, comments: [prComment(1, 'alice')] }]
    for (const [tag, over, result] of [
      ['busy', {}, { ok: false, reason: '会话正忙（agent busy）' }],
      ['deliver', {}, { ok: false, reason: '宿主没给这个会话提供投递入口' }],
      ['observe', { observe: true }, { ok: true }],
    ]) {
      const entry = prEntry({ id: 'pr:o/r#' + tag, wakeTimes: [], ...over })
      const wake = fakeWake(result)
      await mod.__test.pollPrOnce({}, entry, 300_000, null, { ...prDeps(rows), wake })
      assert.deepEqual(entry.wakeTimes, [], tag + ' 不该算唤醒')
    }
  })
})

test('watch_pr_status 只报 PR 守，输出水位与审计开关', async () => {
  const previousNoPoll = process.env.DSH_SUPERAGENT_NO_POLL
  process.env.DSH_SUPERAGENT_NO_POLL = '1'
  try {
    await withPrState(async () => {
      const mod = await prModule('pr-status')
      const tools = []
      mod.apply({
        tools: { register: (tool) => tools.push(tool) },
        webServer: { register: () => () => {} },
        agents: { currentInitiator: () => ({ id: 'session-pr' }), get: () => null },
        get: () => null,
        effect: (fn) => fn(),
        inject: () => {},
      })
      // 直接写状态：一条 PR 守 + 一条 issue 守，status 只能报前者
      const state = mod.__test.readState()
      state.watchers = {
        'pr:o/r#session-pr': prEntry({ seenComments: { 7: 12, 9: 3 }, audit: true, auditMode: 'inline', wakeTimes: [Date.now()] }),
        'o/r#session-pr': { id: 'o/r#session-pr', repo: 'o/r', sessionId: 'session-pr', enabled: true, seen: [] },
      }
      mod.__test.writeState(state)
      const status = tools.find((tool) => tool.name === 'watch_pr_status')
      assert.ok(status, '没注册 watch_pr_status')
      const view = JSON.parse(await status.execute({ format: 'json' }))
      assert.equal(view.schemaVersion, 1)
      assert.equal(view.session.id, 'session-pr')
      assert.equal(view.session.used, 1, 'wakeTimes 里 1 次')
      assert.equal(view.watchers.length, 1, 'issue 守不该出现')
      const w = view.watchers[0]
      assert.equal(w.id, 'pr:o/r#session-pr')
      assert.equal(w.kind, 'pr')
      assert.equal(w.tracked, 2, '跟 2 个 PR')
      assert.deepEqual(w.seenComments, { 7: 12, 9: 3 })
      assert.equal(w.audit, true)
      assert.equal(w.auditMode, 'inline')
      assert.equal(w.intervalSec, 300)
      // 文本模式：一行一条守
      const text = await status.execute({})
      assert.match(text, /o\/r → session-pr \| 每 300s \| 跟 2 个 PR/)
      assert.match(text, /审计=inline/)
    })
  } finally {
    if (previousNoPoll === undefined) delete process.env.DSH_SUPERAGENT_NO_POLL
    else process.env.DSH_SUPERAGENT_NO_POLL = previousNoPoll
  }
})

test('watch_pr_status 没有 PR 守时给空视图', async () => {
  const previousNoPoll = process.env.DSH_SUPERAGENT_NO_POLL
  process.env.DSH_SUPERAGENT_NO_POLL = '1'
  try {
    await withPrState(async () => {
      const mod = await prModule('pr-status-empty')
      const tools = []
      mod.apply({
        tools: { register: (tool) => tools.push(tool) },
        webServer: { register: () => () => {} },
        agents: { currentInitiator: () => ({ id: 'session-pr' }), get: () => null },
        get: () => null,
        effect: (fn) => fn(),
        inject: () => {},
      })
      const status = tools.find((tool) => tool.name === 'watch_pr_status')
      const view = JSON.parse(await status.execute({ format: 'json' }))
      assert.deepEqual(view.watchers, [])
      assert.equal(view.session.used, 0)
      assert.equal(await status.execute({}), '(no PR watchers)')
    })
  } finally {
    if (previousNoPoll === undefined) delete process.env.DSH_SUPERAGENT_NO_POLL
    else process.env.DSH_SUPERAGENT_NO_POLL = previousNoPoll
  }
})

test('watch_pr_stop 能用 gitee.com URL 停掉 start 建的守', async () => {
  const previousNoPoll = process.env.DSH_SUPERAGENT_NO_POLL
  process.env.DSH_SUPERAGENT_NO_POLL = '1'
  try {
    await withPrState(async () => {
      const mod = await prModule('pr-stop-url')
      const tools = []
      mod.apply({
        tools: { register: (tool) => tools.push(tool) },
        webServer: { register: () => () => {} },
        agents: { currentInitiator: () => ({ id: 'session-pr' }), get: () => null },
        get: () => null,
        effect: (fn) => fn(),
        inject: () => {},
      })
      // start 用 URL 建的守，id 是 pr:gitee:o/r#...；stop 也必须能用 URL 找到它
      const state = mod.__test.readState()
      state.watchers = { 'pr:gitee:o/r#session-pr': prEntry({ id: 'pr:gitee:o/r#session-pr', provider: 'gitee' }) }
      mod.__test.writeState(state)
      const stop = tools.find((tool) => tool.name === 'watch_pr_stop')
      assert.ok(stop, '没注册 watch_pr_stop')
      // 注意必须带协议：不带协议时 parseRepoSpec 会把 `gitee.com` 当成 owner（既有行为），
      // 那不是本用例要覆盖的东西。
      const out = JSON.parse(await stop.execute({ repo: 'https://gitee.com/o/r', delete: true, format: 'json' }))
      assert.equal(out.ok, true, 'URL 建的守必须能停掉')
      assert.equal(mod.__test.readState().watchers['pr:gitee:o/r#session-pr'], undefined)
    })
  } finally {
    if (previousNoPoll === undefined) delete process.env.DSH_SUPERAGENT_NO_POLL
    else process.env.DSH_SUPERAGENT_NO_POLL = previousNoPoll
  }
})

test('pollPrOnce 评论乱序时水位取最大 id（不依赖接口返回顺序）', async () => {
  // GitHub 升序、Gitee 降序、分页拼接后可能整体乱序 —— 三种都不能让水位退回去
  await withPrState(async () => {
    const mod = await prModule('out-of-order')
    const wake = fakeWake({ ok: true })
    const entry = prEntry()
    const comments = [prComment(5, 'alice'), prComment(9, 'bob'), prComment(2, 'carol')]
    await mod.__test.pollPrOnce({}, entry, 300_000, null, { ...prDeps([{ number: 7, comments }]), wake })
    assert.deepEqual(entry.seenComments, { 7: 9 }, '取最大 id，不是末条 id')
    assert.equal(wake.calls.length, 1)
  })
})

test('pollPrOnce 取不到当前账号时早退：不拉 PR、不唤醒、不推水位', async () => {
  // self 为空时 Gitee 的 author 过滤会被跳过（返回仓库全部 open PR），
  // 而「非本人」判定在 me='' 时恒真 —— 会指使会话去陌生人的 PR 下回评。
  await withPrState(async () => {
    const mod = await prModule('no-self')
    const wake = fakeWake({ ok: true })
    const entry = prEntry()
    const deps = prDeps([{ number: 7, comments: [prComment(1, 'alice')] }], { selfLogin: '' })
    await mod.__test.pollPrOnce({}, entry, 300_000, null, { ...deps, wake })
    assert.equal(deps.calls.length, 0, '认不出自己是谁就不该发请求')
    assert.equal(wake.calls.length, 0, '不能唤醒')
    assert.deepEqual(entry.seenComments, {}, '不推进水位')
    assert.match(String(entry.lastError), /取不到当前账号/)
    assert.ok(entry.consecutiveFailures > 0, '算一次失败，走退避')
  })
})

test('pollPrOnce 达到单守每小时上限时只记 defer，绝不动水位', async () => {
  await withPrState(async () => {
    const mod = await prModule('pr-cap-watcher')
    const wake = fakeWake({ ok: true })
    // 6 次都在最近一小时内 → 达到默认上限 6
    const recent = Array.from({ length: 6 }, (_, i) => Date.now() - i * 1000)
    const entry = prEntry({ wakeTimes: recent })
    const deps = prDeps([{ number: 7, comments: [prComment(1, 'alice')] }])
    await mod.__test.pollPrOnce({}, entry, 300_000, null, { ...deps, wake })
    assert.equal(wake.calls.length, 0, '到上限不唤醒')
    assert.deepEqual(entry.seenComments, {}, '攒着不能等于丢掉')
    assert.equal(entry.deferReason, 'cap-watcher')
    assert.match(String(entry.lastDeferred), /每小时最多唤醒 6 次/)
    assert.match(String(entry.lastDeferred), /攒 1 条/)
  })
})

test('pollPrOnce 达到会话级上限时只记 defer，绝不动水位', async () => {
  await withPrState(async () => {
    const mod = await prModule('pr-cap-session')
    const wake = fakeWake({ ok: true })
    // 同会话另一条守已经用掉 12 次（默认 sessionMaxWakes=12）—— 会话级预算跨守累计
    const state = mod.__test.readState()
    state.watchers = {
      'pr:other/r#session-pr': prEntry({
        id: 'pr:other/r#session-pr',
        repo: 'other/r',
        wakeTimes: Array.from({ length: 12 }, (_, i) => Date.now() - i * 1000),
      }),
    }
    mod.__test.writeState(state)
    const entry = prEntry()
    const deps = prDeps([{ number: 7, comments: [prComment(1, 'alice')] }])
    await mod.__test.pollPrOnce({}, entry, 300_000, null, { ...deps, wake })
    assert.equal(wake.calls.length, 0, '会话预算用完不唤醒')
    assert.deepEqual(entry.seenComments, {}, '水位不动')
    assert.equal(entry.deferReason, 'cap-session')
    assert.match(String(entry.lastDeferred), /上限 12/)
  })
})

// watch_pr_ack：手动把某个 PR 的评论水位推到指定 id（「这条我看过了，别再叫我」）
test('watch_pr_ack：显式 commentId 直接推水位，不调 API', async () => {
  const previousNoPoll = process.env.DSH_SUPERAGENT_NO_POLL
  process.env.DSH_SUPERAGENT_NO_POLL = '1'
  try {
    await withPrState(async () => {
      const mod = await prModule('pr-ack-explicit')
      const tools = []
      mod.apply({
        tools: { register: (tool) => tools.push(tool) },
        webServer: { register: () => () => {} },
        agents: { currentInitiator: () => ({ id: 'session-pr' }), get: () => null },
        get: () => null,
        effect: (fn) => fn(),
        inject: () => {},
      })
      const state = mod.__test.readState()
      state.watchers = { 'pr:o/r#session-pr': prEntry({ seenComments: { 7: 3, 9: 5 } }) }
      mod.__test.writeState(state)
      const ack = tools.find((tool) => tool.name === 'watch_pr_ack')
      assert.ok(ack, '没注册 watch_pr_ack')
      const out = JSON.parse(await ack.execute({ repo: 'o/r', pr: 7, commentId: 12, format: 'json' }))
      assert.equal(out.ok, true)
      assert.equal(out.pr, 7)
      assert.equal(out.before, 3)
      assert.equal(out.seenCommentId, 12)
      assert.equal(out.moved, true)
      const after = mod.__test.readState().watchers['pr:o/r#session-pr']
      assert.deepEqual(after.seenComments, { 7: 12, 9: 5 }, '只动指定 PR 的水位')
    })
  } finally {
    if (previousNoPoll === undefined) delete process.env.DSH_SUPERAGENT_NO_POLL
    else process.env.DSH_SUPERAGENT_NO_POLL = previousNoPoll
  }
})

test('watch_pr_ack：给更旧的 id 不回退（advanceSeen 只许前进）', async () => {
  const previousNoPoll = process.env.DSH_SUPERAGENT_NO_POLL
  process.env.DSH_SUPERAGENT_NO_POLL = '1'
  try {
    await withPrState(async () => {
      const mod = await prModule('pr-ack-backwards')
      const tools = []
      mod.apply({
        tools: { register: (tool) => tools.push(tool) },
        webServer: { register: () => () => {} },
        agents: { currentInitiator: () => ({ id: 'session-pr' }), get: () => null },
        get: () => null,
        effect: (fn) => fn(),
        inject: () => {},
      })
      const state = mod.__test.readState()
      state.watchers = { 'pr:o/r#session-pr': prEntry({ seenComments: { 7: 12 } }) }
      mod.__test.writeState(state)
      const ack = tools.find((tool) => tool.name === 'watch_pr_ack')
      const out = JSON.parse(await ack.execute({ repo: 'o/r', pr: 7, commentId: 5, format: 'json' }))
      assert.equal(out.ok, true)
      assert.equal(out.before, 12)
      assert.equal(out.seenCommentId, 12, '仍停在 12，不回退')
      assert.equal(out.moved, false)
      assert.deepEqual(mod.__test.readState().watchers['pr:o/r#session-pr'].seenComments, { 7: 12 })
    })
  } finally {
    if (previousNoPoll === undefined) delete process.env.DSH_SUPERAGENT_NO_POLL
    else process.env.DSH_SUPERAGENT_NO_POLL = previousNoPoll
  }
})

test('watch_pr_ack：省略 repo 且只有一条 PR 守时自动匹配', async () => {
  const previousNoPoll = process.env.DSH_SUPERAGENT_NO_POLL
  process.env.DSH_SUPERAGENT_NO_POLL = '1'
  try {
    await withPrState(async () => {
      const mod = await prModule('pr-ack-autorepo')
      const tools = []
      mod.apply({
        tools: { register: (tool) => tools.push(tool) },
        webServer: { register: () => () => {} },
        agents: { currentInitiator: () => ({ id: 'session-pr' }), get: () => null },
        get: () => null,
        effect: (fn) => fn(),
        inject: () => {},
      })
      const state = mod.__test.readState()
      state.watchers = {
        'pr:o/r#session-pr': prEntry({ seenComments: {} }),
        'o/r#session-pr': { id: 'o/r#session-pr', repo: 'o/r', sessionId: 'session-pr', enabled: true, seen: [] },
      }
      mod.__test.writeState(state)
      const ack = tools.find((tool) => tool.name === 'watch_pr_ack')
      const out = JSON.parse(await ack.execute({ pr: 41, commentId: 6844038761, format: 'json' }))
      assert.equal(out.ok, true)
      assert.equal(out.repo, 'o/r')
      assert.deepEqual(mod.__test.readState().watchers['pr:o/r#session-pr'].seenComments, { 41: 6844038761 })
    })
  } finally {
    if (previousNoPoll === undefined) delete process.env.DSH_SUPERAGENT_NO_POLL
    else process.env.DSH_SUPERAGENT_NO_POLL = previousNoPoll
  }
})

test('watch_pr_ack：多条 PR 守没给 repo → 要求指定', async () => {
  const previousNoPoll = process.env.DSH_SUPERAGENT_NO_POLL
  process.env.DSH_SUPERAGENT_NO_POLL = '1'
  try {
    await withPrState(async () => {
      const mod = await prModule('pr-ack-ambiguous')
      const tools = []
      mod.apply({
        tools: { register: (tool) => tools.push(tool) },
        webServer: { register: () => () => {} },
        agents: { currentInitiator: () => ({ id: 'session-pr' }), get: () => null },
        get: () => null,
        effect: (fn) => fn(),
        inject: () => {},
      })
      const state = mod.__test.readState()
      state.watchers = {
        'pr:o/r#session-pr': prEntry({ seenComments: {} }),
        'pr:o/r2#session-pr': prEntry({ id: 'pr:o/r2#session-pr', repo: 'o/r2', seenComments: {} }),
      }
      mod.__test.writeState(state)
      const ack = tools.find((tool) => tool.name === 'watch_pr_ack')
      const out = JSON.parse(await ack.execute({ pr: 1, commentId: 9, format: 'json' }))
      assert.equal(out.ok, false)
      assert.match(String(out.error), /repo/)
      assert.match(String(out.error), /o\/r/)
      assert.match(String(out.error), /o\/r2/)
    })
  } finally {
    if (previousNoPoll === undefined) delete process.env.DSH_SUPERAGENT_NO_POLL
    else process.env.DSH_SUPERAGENT_NO_POLL = previousNoPoll
  }
})

test('watch_pr_ack：没有 PR 守 → 报错', async () => {
  const previousNoPoll = process.env.DSH_SUPERAGENT_NO_POLL
  process.env.DSH_SUPERAGENT_NO_POLL = '1'
  try {
    await withPrState(async () => {
      const mod = await prModule('pr-ack-noagent')
      const tools = []
      mod.apply({
        tools: { register: (tool) => tools.push(tool) },
        webServer: { register: () => () => {} },
        agents: { currentInitiator: () => ({ id: 'session-pr' }), get: () => null },
        get: () => null,
        effect: (fn) => fn(),
        inject: () => {},
      })
      const ack = tools.find((tool) => tool.name === 'watch_pr_ack')
      const out = JSON.parse(await ack.execute({ repo: 'o/r', pr: 1, commentId: 9, format: 'json' }))
      assert.equal(out.ok, false)
      assert.match(String(out.error), /PR 守/)
    })
  } finally {
    if (previousNoPoll === undefined) delete process.env.DSH_SUPERAGENT_NO_POLL
    else process.env.DSH_SUPERAGENT_NO_POLL = previousNoPoll
  }
})

test('watch_pr_ack：不传 commentId 且拿不到最新 → 报错而不是瞎推', async () => {
  const previousNoPoll = process.env.DSH_SUPERAGENT_NO_POLL
  process.env.DSH_SUPERAGENT_NO_POLL = '1'
  try {
    await withPrState(async () => {
      const mod = await prModule('pr-ack-nofetch')
      const tools = []
      mod.apply({
        tools: { register: (tool) => tools.push(tool) },
        webServer: { register: () => () => {} },
        agents: { currentInitiator: () => ({ id: 'session-pr' }), get: () => null },
        get: () => null,
        effect: (fn) => fn(),
        inject: () => {},
      })
      const state = mod.__test.readState()
      state.watchers = { 'pr:o/r#session-pr': prEntry({ seenComments: { 7: 3 } }) }
      mod.__test.writeState(state)
      const ack = tools.find((tool) => tool.name === 'watch_pr_ack')
      // offline 下 gh 返回的对象不是数组 → 拿不到最新评论 → 必须报错，不能把水位推到 undefined
      const out = JSON.parse(await ack.execute({ repo: 'o/r', pr: 7, format: 'json' }))
      assert.equal(out.ok, false)
      assert.match(String(out.error), /最新评论/)
      assert.deepEqual(mod.__test.readState().watchers['pr:o/r#session-pr'].seenComments, { 7: 3 }, '失败不动水位')
    })
  } finally {
    if (previousNoPoll === undefined) delete process.env.DSH_SUPERAGENT_NO_POLL
    else process.env.DSH_SUPERAGENT_NO_POLL = previousNoPoll
  }
})

test('pollPrOnce：Gitee 单个 PR 评论失败只跳过该 PR，其他 PR 照常叫醒（A2）', async () => {
  await withPrState(async () => {
    const mod = await prModule('pr-gitee-one-fail')
    const wake = fakeWake({ ok: true })
    const entry = prEntry({ provider: 'gitee' })
    const list = [
      { number: 7, title: '七', state: 'open', head: { repo: { full_name: 'x/r' }, user: { login: 'me' }, ref: 'b7' }, base: { repo: { full_name: 'o/r' } } },
      { number: 8, title: '八', state: 'open', head: { repo: { full_name: 'x/r' }, user: { login: 'me' }, ref: 'b8' }, base: { repo: { full_name: 'o/r' } } },
    ]
    const fetchImpl = async (url) => {
      if (/\/pulls\?/.test(url)) return { ok: true, status: 200, text: async () => JSON.stringify(list) }
      if (/\/pulls\/7\/comments/.test(url)) return { ok: false, status: 500, text: async () => 'boom' }
      if (/\/pulls\/8\/comments/.test(url)) return { ok: true, status: 200, text: async () => JSON.stringify([{ id: 200, user: { login: 'bob' }, body: '有新意见', created_at: '2026-01-01T00:00:00Z' }]) }
      return { ok: false, status: 404, text: async () => '' }
    }
    await mod.__test.pollPrOnce({}, entry, 300_000, null, { fetchImpl, wake, selfLogin: 'me' })
    assert.equal(wake.calls.length, 1, 'PR#7 的 500 不该把 PR#8 的新评论一起拖住')
    assert.match(wake.calls[0].text, /#8/, '叫醒消息必须指向 PR#8')
    assert.deepEqual(entry.seenComments, { 8: 200 }, 'PR#7 的水位不许动，PR#8 推进到 200')
    assert.equal(entry.consecutiveFailures, 0, '单个 PR 的错不该让整个 watcher 退避')
  })
})

test('pollPrOnce：Gitee 列表拿满一页（可能截断）时不剪水位（A4）', async () => {
  await withPrState(async () => {
    const mod = await prModule('pr-gitee-truncated')
    const wake = fakeWake({ ok: true })
    const entry = prEntry({ provider: 'gitee', seenComments: { 7: 10, 200: 20 } })
    const list = []
    for (let i = 1; i <= 100; i += 1) {
      list.push({ number: i, title: 't' + i, state: 'open', head: { repo: { full_name: 'x/r' }, user: { login: 'me' }, ref: 'b' + i }, base: { repo: { full_name: 'o/r' } } })
    }
    const fetchImpl = async (url) => {
      if (/\/pulls\?/.test(url)) return { ok: true, status: 200, text: async () => JSON.stringify(list) }
      if (/\/pulls\/\d+\/comments/.test(url)) return { ok: true, status: 200, text: async () => '[]' }
      return { ok: false, status: 404, text: async () => '' }
    }
    await mod.__test.pollPrOnce({}, entry, 300_000, null, { fetchImpl, wake, selfLogin: 'me' })
    assert.deepEqual(entry.seenComments, { 7: 10, 200: 20 }, '列表可能被截断时，离窗的 PR#200 水位必须保留（否则回窗后旧评论重报）')
    assert.equal(wake.calls.length, 0, '没有新评论')
  })
})

test('watch_pr_status：只返回本会话的 PR 守，不抖出别的会话（B8）', async () => {
  await withPrState(async () => {
    const mod = await prModule('pr-status-session')
    const tools = []
    mod.apply({
      tools: { register: (tool) => tools.push(tool) },
      webServer: { register: () => () => {} },
      agents: { currentInitiator: () => ({ id: 'session-a' }), get: () => null },
      get: () => null,
      effect: (fn) => fn(),
      inject: () => {},
    })
    const state = mod.__test.readState()
    state.watchers = {
      'pr:o/r#session-a': prEntry({ id: 'pr:o/r#session-a', sessionId: 'session-a', seenComments: { 7: 3 } }),
      'pr:o/r#session-b': prEntry({ id: 'pr:o/r#session-b', sessionId: 'session-b', repo: 'other/private', goal: 'B 的私有目标', seenComments: { 8: 5 } }),
    }
    mod.__test.writeState(state)
    const status = tools.find((tool) => tool.name === 'watch_pr_status')
    const out = JSON.parse(await status.execute({ format: 'json' }))
    assert.equal(out.schemaVersion, 1)
    const ids = out.watchers.map((w) => w.id)
    assert.deepEqual(ids, ['pr:o/r#session-a'], '别的会话的 PR 守不许出现')
    assert.equal(out.session.id, 'session-a')
    assert.ok(!JSON.stringify(out).includes('B 的私有目标'), '不许泄露别的会话的 goal')
  })
})

test('watch_ack：只有 PR 守时明确报「这是 PR 守」，不去改 issue 水位（B9）', async () => {
  await withPrState(async () => {
    const mod = await prModule('ack-pr-only')
    const tools = []
    mod.apply({
      tools: { register: (tool) => tools.push(tool) },
      webServer: { register: () => () => {} },
      agents: { currentInitiator: () => ({ id: 'session-pr' }), get: () => null },
      get: () => null,
      effect: (fn) => fn(),
      inject: () => {},
    })
    const state = mod.__test.readState()
    state.watchers = { 'pr:o/r#session-pr': prEntry({ seenComments: { 7: 3 } }) }
    mod.__test.writeState(state)
    const ack = tools.find((tool) => tool.name === 'watch_ack')
    const out = JSON.parse(await ack.execute({ repo: 'o/r', numbers: 7, format: 'json' }))
    assert.equal(out.ok, false, '只有 PR 守时 watch_ack 必须拒绝')
    assert.match(String(out.error), /PR 守/, '错误要说清是 PR 守，而不是「没有守」')
    assert.deepEqual(mod.__test.readState().watchers['pr:o/r#session-pr'].seenComments, { 7: 3 }, '不许把 PR 的评论水位写进 issue 水位')
  })
})

function issueAckEntry(over = {}) {
  return {
    id: 'o/r#session-a',
    repo: 'o/r',
    provider: 'github',
    sessionId: 'session-a',
    enabled: true,
    ackLabel: 'A:done',
    seen: {},
    cursor: null,
    lastAcked: null,
    ...over,
  }
}

async function callIssueAck(tag, { sessionId = 'session-a', watchers, args = {} }) {
  let result
  await withPrState(async () => {
    const mod = await prModule(tag)
    const tools = []
    mod.apply({
      tools: { register: (tool) => tools.push(tool) },
      webServer: { register: () => () => {} },
      agents: { currentInitiator: () => sessionId ? ({ id: sessionId }) : null, get: () => null },
      get: () => null,
      effect: (fn) => fn(),
      inject: () => {},
    })
    const state = mod.__test.readState()
    state.watchers = watchers
    mod.__test.writeState(state)
    const before = mod.__test.readState()
    const ack = tools.find((tool) => tool.name === 'watch_ack')
    const out = JSON.parse(await ack.execute({ number: 54, format: 'json', ...args }))
    result = { out, before, after: mod.__test.readState() }
  })
  return result
}

test('issue #54：同 repo 两会话只返回并推进 currentInitiator=A 的 ackLabel 与水位', async () => {
  const a = issueAckEntry({
    seen: { 54: '2026-01-01T00:00:00.000Z' },
    cursor: '2026-01-01T00:00:00.000Z',
    lastAcked: { numbers: ['1'], label: 'A:done', at: '2026-01-01T00:00:00.000Z' },
  })
  // B 故意放在第一条：旧实现按 repo find 会错误选中它。
  const b = issueAckEntry({
    id: 'o/r#session-b', sessionId: 'session-b', ackLabel: 'B:done',
    seen: { 54: '2026-02-01T00:00:00.000Z' },
    cursor: '2026-02-01T00:00:00.000Z',
    lastAcked: { numbers: ['2'], label: 'B:done', at: '2026-02-01T00:00:00.000Z' },
  })
  const { out, before, after } = await callIssueAck('issue-54-session-isolation', {
    watchers: { [b.id]: b, [a.id]: a },
    args: { repo: 'o/r' },
  })
  assert.equal(out.ok, true, JSON.stringify(out))
  assert.equal(out.label, 'A:done', '返回标签必须来自 A，不得来自同 repo 的 B')
  const afterA = after.watchers[a.id]
  assert.equal(afterA.seen['54'], out.at, 'A 的 seen 必须前进到本次 ack 时间')
  assert.equal(afterA.cursor, out.at, 'A 的 cursor 必须前进到本次 ack 时间')
  assert.deepEqual(afterA.lastAcked, { numbers: ['54'], label: 'A:done', at: out.at })
  assert.deepEqual(after.watchers[b.id], before.watchers[b.id], 'B 的 seen/cursor/lastAcked 等全部字段必须原样不变')
})

test('issue #54：无 live session 明确拒绝，不回退到第一条守', async () => {
  const b = issueAckEntry({ id: 'o/r#session-b', sessionId: 'session-b', ackLabel: 'B:done' })
  const { out, before, after } = await callIssueAck('issue-54-no-session', {
    sessionId: null,
    watchers: { [b.id]: b },
  })
  assert.equal(out.ok, false)
  assert.match(String(out.error), /no live session/)
  assert.match(String(out.error), /watch_ack/)
  assert.deepEqual(after, before, '拒绝时任何会话的状态都不能变')
})

test('issue #54：省略 repo 且本会话有多条启用 issue 守时要求指定 repo', async () => {
  const other = issueAckEntry({ id: 'o/other#session-b', repo: 'o/other', sessionId: 'session-b', ackLabel: 'B:done' })
  const one = issueAckEntry({ id: 'o/one#session-a', repo: 'o/one' })
  const two = issueAckEntry({ id: 'o/two#session-a', repo: 'o/two' })
  const { out, before, after } = await callIssueAck('issue-54-ambiguous', {
    watchers: { [other.id]: other, [one.id]: one, [two.id]: two },
  })
  assert.equal(out.ok, false)
  assert.match(String(out.error), /repo/)
  assert.match(String(out.error), /o\/one/)
  assert.match(String(out.error), /o\/two/)
  assert.doesNotMatch(String(out.error), /o\/other/, '歧义清单只列本会话的守')
  assert.deepEqual(after, before, '歧义时不能静默推进第一条')
})

test('issue #54：其它会话的 PR 守不会触发本会话的 PR-only 提示', async () => {
  const otherPr = prEntry({ id: 'pr:o/r#session-b', sessionId: 'session-b', seenComments: { 54: 3 } })
  const { out, before, after } = await callIssueAck('issue-54-other-pr', {
    watchers: { [otherPr.id]: otherPr },
    args: { repo: 'o/r' },
  })
  assert.equal(out.ok, false)
  assert.match(String(out.error), /本会话/)
  assert.match(String(out.error), /其它会话/)
  assert.doesNotMatch(String(out.error), /PR 守/, '其它会话有 PR 守不代表本会话是 PR-only')
  assert.deepEqual(after, before)
})

test('issue #54：显式 repo 只有其它会话的守时明确报错且状态不动', async () => {
  const b = issueAckEntry({ id: 'o/r#session-b', sessionId: 'session-b', ackLabel: 'B:done' })
  const { out, before, after } = await callIssueAck('issue-54-other-repo', {
    watchers: { [b.id]: b },
    args: { repo: 'o/r' },
  })
  assert.equal(out.ok, false)
  assert.match(String(out.error), /本会话/)
  assert.match(String(out.error), /其它会话/)
  assert.deepEqual(after, before, '不得给 B 打标签或推进 B 的水位')
})

test('pollPrOnce：首次同步走 REST 全量拉评论，之后走列表自带的 comments（A3）', async () => {
  await withPrState(async () => {
    const mod = await prModule('pr-a3-rest')
    const wake = fakeWake({ ok: true })
    const rows = [{ number: 7, comments: [{ id: 100, author: 'me' }, { id: 101, author: 'alice' }] }]
    const deps = prDeps(rows, { selfLogin: 'me', wake })
    const entry = prEntry({ seenComments: {} })
    await mod.__test.pollPrOnce({}, entry, 300_000, null, deps)
    const firstRest = deps.calls.filter((c) => (c.args || []).join(' ').includes('issues/7/comments'))
    assert.equal(firstRest.length, 1, '首次同步（seenId=0）必须走 REST 分页把评论拉全，否则更早的评论永久漏报')
    assert.deepEqual(entry.seenComments, { 7: 101 })
    assert.equal(wake.calls.length, 1)

    // 第二轮：水位已建，走列表里带回来的 comments，不再打 REST
    deps.calls.length = 0
    await mod.__test.pollPrOnce({}, entry, 300_000, null, deps)
    const secondRest = deps.calls.filter((c) => (c.args || []).join(' ').includes('issues/7/comments'))
    assert.equal(secondRest.length, 0, '增量轮不该再打 REST')
    assert.equal(wake.calls.length, 1, '没有新评论不重复叫醒')
  })
})

test('pollPrOnce：上一轮排队的唤醒先送出，本轮不按旧水位重复投递（A1）', async () => {
  await withPrState(async () => {
    // WAKE_WINDOW_MS 在模块加载时读：用带 query 的新实例拿到 20ms 的合并窗口
    const previousWindow = process.env.DSH_SUPERAGENT_WAKE_WINDOW_MS
    process.env.DSH_SUPERAGENT_WAKE_WINDOW_MS = '20'
    const mod = await prModule('flush-before-read')
    if (previousWindow === undefined) delete process.env.DSH_SUPERAGENT_WAKE_WINDOW_MS
    else process.env.DSH_SUPERAGENT_WAKE_WINDOW_MS = previousWindow
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

    // 会话先忙后闲：忙时唤醒进队列，空闲后（下一轮开轮）flush 送出并推进水位
    let busy = true
    const followed = []
    const ctx = {
      get: (name) => name === 'agents' ? {
        get: () => ({
          status: busy ? 'busy' : 'idle',
          followup: async (text) => { followed.push(text) },
        }),
      } : undefined,
    }

    const rows = [{
      number: 7,
      title: 'PR 7',
      isDraft: false,
      headRefName: 'b7',
      headRepository: { nameWithOwner: 'me/r' },
      baseRepository: { nameWithOwner: 'o/r' },
      comments: {
        pageInfo: { hasPreviousPage: false },
        nodes: [{ databaseId: 14, author: { login: 'someone' }, createdAt: '2026-11-13T00:00:00Z', body: 'review 意见' }],
      },
    }]
    const ghRun = async (file, args) => {
      const joined = (args || []).join(' ')
      // 首次同步（seenId=0）走 REST 全量：必须回数组，否则被判「评论列表不是数组」
      if (joined.includes('/issues/7/comments')) {
        return { code: 0, stderr: '', stdout: JSON.stringify([{ id: 14, user: { login: 'someone' }, body: 'review 意见', created_at: '2026-11-13T00:00:00Z' }]) }
      }
      return { code: 0, stderr: '', stdout: JSON.stringify({ data: { search: { pageInfo: { hasNextPage: false }, nodes: rows } } }) }
    }

    const entry = prEntry()
    mod.__test.writeState({ watchers: { [entry.id]: entry } })

    // 第一轮：会话忙 → 进队列，水位不动
    await mod.__test.pollPrOnce(ctx, mod.__test.readState().watchers[entry.id], 300000, null, { ghRun, selfLogin: 'me' })
    await sleep(150)
    const afterFirst = mod.__test.readState().watchers[entry.id]
    assert.equal(mod.__test.wakeQueueCount('session-pr'), 1, '忙时唤醒必须进队列')
    assert.equal(afterFirst.seenComments[7], undefined, '忙时不能推进水位')
    assert.equal(afterFirst.deferReason, 'busy', '忙时记 busy')

    // 第二轮：会话空闲 → 开轮 flush 旧队列 → 送出 → 回调推进水位 → 本轮无新评论
    busy = false
    await mod.__test.pollPrOnce(ctx, mod.__test.readState().watchers[entry.id], 300000, null, { ghRun, selfLogin: 'me' })
    await sleep(150)
    const afterSecond = mod.__test.readState().watchers[entry.id]
    assert.equal(followed.length, 1, '同一条评论只能投递一次，实际投递了 ' + followed.length + ' 次')
    assert.equal(afterSecond.seenComments[7], 14, '水位必须推进到 14')
    mod.__test.clearWakeQueues()
  })
})
