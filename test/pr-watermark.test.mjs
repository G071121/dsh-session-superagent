// T39 反向用例：`entry.pending` 非空但本轮没有新增时，**不许**发空唤醒。
//
// 背景（2026-11-13 外部 review）：PR #48 的第一版把早退条件改成
// `if (fresh.length === 0 && Object.keys(entry.pending || {}).length === 0)` ——
// 当 `pendingRetry` 因 10 分钟冷却期或 `tries >= maxTries` 返回空时，`listed` 仍为空
// 但条件不拦，最后走到 `formatWatchText` 发出「有 0 条新动态」的空唤醒
// （`advanceWatermark: true`、`cursor: null`、`history.numbers: []`）。
//
// 这条用例守的就是「撤回后不许再回来」：造一轮「pending 非空 + 所有条目都不新于 seen」，
// 断言没发唤醒（history / wakeTimes 都不动）、cursor 没变、ETag 已提交
// （早退路径仍然消费掉了这一轮，AGENTS 坑表 #2）。
import assert from 'node:assert/strict'
import test from 'node:test'

import { tempDir, assertTempStateDir } from './fixtures/tmpdir.mjs'

const STATE_DIR = tempDir('zhuli-pr-watermark-')
process.env.DSH_SUPERAGENT_STATE = STATE_DIR
process.env.DSH_SUPERAGENT_NO_POLL = '1'
process.env.DSH_SUPERAGENT_OFFLINE = '1'
process.env.DSH_SUPERAGENT_UPDATE_OFFLINE = '1'
assertTempStateDir('pr-watermark.test.mjs')

const mod = await import('../lib/index.js?pr-watermark=' + Date.now())
const { apply, __test } = mod

const tools = []
const routes = new Map()
const ctx = {
  tools: {
    register: (tool) => {
      tools.push(tool)
    },
  },
  webServer: {
    register: (route) => {
      routes.set(route.path, route)
      return () => {}
    },
  },
  agents: {
    currentInitiator: () => ({ id: 'session-pr-watermark' }),
    get: () => ({ status: 'idle' }),
  },
  get: () => ({ status: 'idle' }),
  on() {},
  effect: (fn) => fn(),
  logger: { info() {}, warn() {}, error() {} },
}
apply(ctx, {})

const issue = (number, extra = {}) => ({
  number,
  title: '条目 ' + number,
  state: 'open',
  html_url: 'https://github.com/acme/repo/issues/' + number,
  updated_at: '2026-01-01T00:00:00Z',
  user: { login: 'octocat' },
  labels: [],
  ...extra,
})

test('pending 非空但本轮没有新增：不发空唤醒、cursor 不变、ETag 已提交', async () => {
  const entry = {
    id: 'acme/repo#session-pr-watermark',
    repo: 'acme/repo',
    provider: 'github',
    sessionId: 'session-pr-watermark',
    enabled: true,
    intervalSec: 300,
    batchLimit: 5,
    observe: false,
    seen: { 41: '2026-11-01T00:00:00.000Z' },
    // 旧水位必须**非 null**：`cursor: null` 会让「保留」与「清空」同值，断言等于空转。
    cursor: '2026-11-01T00:00:00.000Z',
    // pending 非空：模拟「上一轮唤醒失败、攒着重提」。这一轮 pendingRetry 会因冷却期
    // 返回空，但早退必须只看 fresh。
    pending: { 41: { tries: 1, at: new Date().toISOString() } },
    wakeTimes: [],
    history: [],
    silentWakes: 0,
    etag: 'W/"old"',
    lastFreshAt: new Date().toISOString(),
  }
  // 唯一一条的 updated_at 等于 seen 里的值 → 不算新增
  const listed = {
    status: 200,
    etag: 'W/"new"',
    body: JSON.stringify([issue(41, { updated_at: '2026-11-01T00:00:00.000Z' })]),
  }
  const before = {
    cursor: entry.cursor,
    seen: { ...entry.seen },
    wakeTimes: entry.wakeTimes.length,
    history: entry.history.length,
  }

  await __test.pollWithItems(ctx, entry, 300000, listed)

  // 反回退的第一层：早退路径不许留下任何「唤醒过」的痕迹
  assert.equal(entry.history.length, before.history, '不许写一条 numbers: [] 的空唤醒历史')
  assert.equal(entry.wakeTimes.length, before.wakeTimes, '不许消耗每小时唤醒名额')
  assert.equal(entry.cursor, before.cursor, 'cursor 必须保持原值（不是 null）')
  assert.deepEqual(entry.seen, before.seen, 'seen 不动')
  // 第二层：这一轮确实消费掉了 —— ETag 要前移，否则下一轮又全量重取
  assert.equal(entry.etag, 'W/"new"', 'ETag 必须前移（AGENTS 坑表 #2）')
})
