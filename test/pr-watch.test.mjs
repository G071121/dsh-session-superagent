// PR 响应监控的核心纯函数单元测试：只测 lib/pr-watch.js，不联网、不碰文件系统。
//
// 为什么这些函数要单独测：它们决定「哪条评论算新」「要不要叫醒」「水位怎么走」，
// 全是会静默出错的判断（少叫醒 = 评论永久丢失；多叫醒 = 每轮刷屏）。
// 时间一律由调用方传入，本文件里没有 Date.now()，所以可以离线、可复现地跑。
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  normalizeSelf,
  isForkPr,
  pickNewComments,
  shouldWake,
  buildPrWakeText,
  pruneSeen,
  advanceSeen,
} from '../lib/pr-watch.js'

test('normalizeSelf 去 @ 并小写', () => {
  assert.equal(normalizeSelf('@iJetLi '), 'ijetli')
  assert.equal(normalizeSelf('  @@iJetLi'), 'ijetli')
  assert.equal(normalizeSelf(''), '')
  // null / undefined 不能抛：评论作者被删除时上游给的就是 null
  assert.equal(normalizeSelf(null), '')
  assert.equal(normalizeSelf(undefined), '')
})

test('isForkPr：head 与 base 不同才是 fork', () => {
  assert.equal(isForkPr({ headRepo: 'iJetLi/repo', baseRepo: 'MYCF711/repo' }), true)
  assert.equal(isForkPr({ headRepo: 'MYCF711/repo', baseRepo: 'MYCF711/repo' }), false)
  assert.equal(isForkPr({ headRepo: null, baseRepo: 'MYCF711/repo' }), false) // fork 已删
  // 仓库名大小写不敏感：只差大小写仍是同一个仓库，不是 fork
  assert.equal(isForkPr({ headRepo: 'mycf711/repo', baseRepo: 'MYCF711/repo' }), false)
  // 两边都缺 → 无法判断，按「非 fork」跳过
  assert.equal(isForkPr({ headRepo: null, baseRepo: null }), false)
  assert.equal(isForkPr(null), false)
})

test('pickNewComments 按 id 水位过滤', () => {
  const comments = [{ id: 1 }, { id: 5 }, { id: 9 }]
  assert.deepEqual(pickNewComments(comments, 5).map((c) => c.id), [9])
  assert.equal(pickNewComments(comments, 0).length, 3)
  assert.equal(pickNewComments(comments, 100).length, 0)
  // undefined 水位 = 第一次轮询，全部算新
  assert.equal(pickNewComments(comments, undefined).length, 3)
  // 不修改入参（水位推进由调用方决定，纯函数只读）
  assert.deepEqual(comments.map((c) => c.id), [1, 5, 9])
})

test('pickNewComments 兼容字符串 id', () => {
  const comments = [{ id: '10' }, { id: '2' }]
  // 一侧是 number 时 JS 会走 ToNumber，所以 '2' > 5 其实是 false —— 这条用例真正钉住的是
  // 「id 被转成数值再比」，而不是字符串比较的陷阱。
  assert.deepEqual(pickNewComments(comments, 5).map((c) => Number(c.id)), [10])
  // 边界：id 等于水位不算新
  assert.deepEqual(pickNewComments(comments, 10).map((c) => Number(c.id)), [])
  // 水位本身是字符串时也必须按数值比：实测 '10' > '5' 是 false（字符串比较），
  // 只转 id 不转水位的实现会漏掉 id=10 这条（少唤醒 = 评论永久丢失）
  assert.deepEqual(pickNewComments(comments, '5').map((c) => Number(c.id)), [10])
  // 两侧都是字符串：'2' > '10' 是 true（字符串比较），不转数值会重复唤醒 id=2
  assert.deepEqual(pickNewComments([{ id: '2' }], '10').map((c) => Number(c.id)), [])
})

test('shouldWake：只有非本人评论才叫醒', () => {
  assert.equal(shouldWake([{ author: 'MYCF711' }], 'iJetLi'), true)
  assert.equal(shouldWake([{ author: 'iJetLi' }], 'iJetLi'), false)
  assert.equal(shouldWake([{ author: '@iJetLi' }], 'ijetli'), false) // 大小写/@ 不敏感
  assert.equal(shouldWake([], 'iJetLi'), false)
  // 混着本人与非本人：只要有一条别人的就值得叫醒
  assert.equal(shouldWake([{ author: 'iJetLi' }, { author: 'MYCF711' }], 'iJetLi'), true)
})

test('buildPrWakeText 带 PR 号、评论者、正文', () => {
  const text = buildPrWakeText({
    base: 'MYCF711/repo', number: 48, title: 'fix: xxx', branch: 'fix/a',
    self: 'iJetLi', comments: [{ author: 'MYCF711', body: '这里漏了边界', createdAt: '2026-11-13T04:32:15Z' }],
    goal: '改完回评',
  })
  assert.match(text, /#48/)
  assert.match(text, /MYCF711/)
  assert.match(text, /这里漏了边界/)
  assert.match(text, /改完回评/)
  // 格式固定（Task 5 与后续测试依赖）：标题行的条数、空行分段、引用块、处理建议
  const lines = text.split('\n')
  assert.equal(lines[0], '【PR 响应】MYCF711/repo#48 有 1 条新评论')
  assert.equal(lines[1], '')
  assert.ok(lines.includes('PR: fix: xxx'))
  assert.ok(lines.includes('分支: fix/a'))
  assert.ok(lines.includes('评论者: MYCF711（非本人）'))
  assert.ok(lines.includes('时间: 2026-11-13T04:32:15Z'))
  assert.ok(lines.includes('> 这里漏了边界'))
  assert.ok(lines.includes('处理建议: 阅读评论 → 修改代码 → 自审 → 提交 → 回评'))
  // 没有 goal 时不能出现空的「目标:」行
  const noGoal = buildPrWakeText({
    base: 'MYCF711/repo', number: 48, title: 'fix: xxx', branch: 'fix/a',
    self: 'iJetLi', comments: [{ author: 'MYCF711', body: '这里漏了边界', createdAt: '2026-11-13T04:32:15Z' }],
  })
  assert.equal(noGoal.split('\n').some((line) => line.startsWith('目标:')), false)
})

test('buildPrWakeText 多条评论逐条引用', () => {
  const text = buildPrWakeText({
    base: 'MYCF711/repo', number: 48, title: 'fix: xxx', branch: 'fix/a', self: 'iJetLi',
    comments: [
      { author: 'MYCF711', body: '第一条\n第二行', createdAt: '2026-11-13T04:32:15Z' },
      { author: 'someone', body: '再看这条', createdAt: '2026-11-13T05:00:00Z' },
    ],
  })
  const lines = text.split('\n')
  assert.equal(lines[0], '【PR 响应】MYCF711/repo#48 有 2 条新评论')
  // 正文多行都要落在引用块里，否则 markdown 会把第二行当成正文指令
  assert.ok(lines.includes('> 第一条'))
  assert.ok(lines.includes('> 第二行'))
  assert.ok(lines.includes('> 再看这条'))
  assert.equal(lines.filter((line) => line.startsWith('评论者: ')).length, 2)
})

test('pruneSeen 移除已关闭 PR', () => {
  const seen = { 48: 9, 41: 7 }
  assert.deepEqual(pruneSeen(seen, [48]), { 48: 9 })
  // 空 open 列表 → 全部清掉；空 seen → 空对象
  assert.deepEqual(pruneSeen({ 48: 9 }, []), {})
  assert.deepEqual(pruneSeen({}, [48]), {})
  // 不修改入参：水位是调用方的状态，纯函数只返回新对象
  assert.deepEqual(seen, { 48: 9, 41: 7 })
})

test('advanceSeen 取较大水位', () => {
  const seen = { 48: 9, 41: 7 }
  assert.deepEqual(advanceSeen({ 48: 5 }, [{ number: 48, latestId: 9 }, { number: 50, latestId: 3 }]), { 48: 9, 50: 3 })
  assert.deepEqual(advanceSeen({ 48: 9 }, [{ number: 48, latestId: 5 }]), { 48: 9 }) // 不回退
  // 未被更新的 PR 保留原水位
  assert.deepEqual(advanceSeen(seen, [{ number: 48, latestId: 10 }]), { 48: 10, 41: 7 })
  // 不修改入参
  assert.deepEqual(seen, { 48: 9, 41: 7 })
  // 非法 latestId 跳过：不能让 NaN 污染水位（NaN > prev 恒为 false，但显式断言更清楚）
  assert.deepEqual(advanceSeen({ 48: 9 }, [{ number: 48, latestId: NaN }]), { 48: 9 })
})
