import test from 'node:test'
import assert from 'node:assert/strict'
import { lintReply } from '../scripts/lint-reply.mjs'

const has = (text, label, current = 15) =>
  lintReply(text, { current }).some((item) => item.includes(label))

test('干净的 issue 回复通过', () => {
  assert.deepEqual(lintReply('已复现，0.10.2 修复；升级后重载宿主生效。', { current: 15 }), [])
})

test('拒绝本机绝对路径', () => {
  assert.ok(has(String.raw`见 D:\主工作区\projects\x`, '绝对路径'))
})

test('拒绝 runningVersion / serverVersion', () => {
  assert.ok(has('runningVersion 还是 0.9.275', '本机运行版本'))
})

test('拒绝后台任务口吻', () => {
  assert.ok(has('我刚把 ComfyUI 后台任务关了', '后台任务'))
})

test('拒绝内部任务 ID', () => {
  assert.ok(has('这条在 n9641 里', '内部任务 ID'))
})

test('拒绝凭证泄漏', () => {
  assert.ok(has('token=ghp_' + 'a'.repeat(30), '凭证/密钥'))
})

test('拒绝引用其它 issue/PR', () => {
  assert.ok(has('另见 #13 和 #14', '引用了其它 issue/PR'))
})

test('引用当前 issue 不报错', () => {
  assert.deepEqual(lintReply('本 issue #15 已修复', { current: 15 }), [])
})

test('拒绝未发布版本承诺', () => {
  assert.ok(has('计划在 0.10.3 放宽依赖', '未发布版本承诺'))
})

test('空回复拒绝', () => {
  assert.ok(has('   ', '空回复'))
})
