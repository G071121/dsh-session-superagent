import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tempDir, assertTempStateDir } from './fixtures/tmpdir.mjs'
import { migrateState, migratePrWatchers, CURRENT_STATE_SCHEMA } from '../lib/state-migration.js'

test('v0 历史状态只补 schemaVersion，已有 watcher 与扩展字段原样保留', () => {
  const legacy = { watchers: { 'a/b#s1': { repo: 'a/b', enabled: true } }, custom: { keep: 1 } }
  const result = migrateState(legacy)
  assert.equal(result.changed, true)
  assert.equal(result.from, 0)
  assert.equal(result.state.schemaVersion, CURRENT_STATE_SCHEMA)
  assert.equal(result.state.custom.keep, 1)
  assert.equal(result.state.watchers['a/b#s1'].repo, 'a/b')
  assert.equal(legacy.schemaVersion, undefined, '迁移不能原地篡改调用方对象')
})

test('当前版本不重复迁移；未来版本与非法版本明确拒绝', () => {
  const current = { schemaVersion: CURRENT_STATE_SCHEMA, watchers: {} }
  const result = migrateState(current)
  assert.equal(result.changed, false)
  assert.equal(result.state, current)
  assert.throws(() => migrateState({ schemaVersion: CURRENT_STATE_SCHEMA + 1 }), /newer than supported/)
  assert.throws(() => migrateState({ schemaVersion: 'abc' }), /invalid state schemaVersion/)
})

const STATE_DIR = tempDir('zhuli-state-migration-')
process.env.DSH_SUPERAGENT_STATE = STATE_DIR
process.env.DSH_SUPERAGENT_NO_POLL = '1'
assertTempStateDir('state-migration.test.mjs')
const { __test } = await import('../lib/index.js?migration=' + Date.now())
const file = join(STATE_DIR, 'watchers.json')

test('readState 先迁移再归一，writeState 落盘当前 schemaVersion', () => {
  writeFileSync(file, JSON.stringify({ watchers: { 'a/b#s1': { repo: 'a/b', provider: 'github', enabled: true } } }))
  const state = __test.readState()
  assert.equal(state.schemaVersion, CURRENT_STATE_SCHEMA)
  assert.equal(state.watchers['a/b#s1'].repo, 'a/b')
  __test.writeState(state)
  const disk = JSON.parse(readFileSync(file, 'utf8'))
  assert.equal(disk.schemaVersion, CURRENT_STATE_SCHEMA)
  assert.equal(disk.watchers['a/b#s1'].repo, 'a/b')
})

test('主文件是未来版本时退回可读备份，并把迁移后的备份写回主文件', () => {
  writeFileSync(file, JSON.stringify({ schemaVersion: 999, watchers: {} }))
  writeFileSync(file + '.bak', JSON.stringify({ watchers: { 'a/b#s1': { repo: 'a/b', provider: 'github', enabled: true } } }))
  const state = __test.readState()
  assert.equal(state.schemaVersion, CURRENT_STATE_SCHEMA)
  assert.equal(state.watchers['a/b#s1'].repo, 'a/b')
  const repaired = JSON.parse(readFileSync(file, 'utf8'))
  assert.equal(repaired.schemaVersion, CURRENT_STATE_SCHEMA)
  assert.equal(repaired.watchers['a/b#s1'].repo, 'a/b')
})

test('migratePrWatchers 给老 watcher 补 kind:issue', () => {
  const out = migratePrWatchers({ watchers: { 'o/r#s1': { repo: 'o/r' } } })
  assert.equal(out.watchers['o/r#s1'].kind, 'issue')
})

test('migratePrWatchers 给 pr: 前缀补 kind:pr 与 seenComments', () => {
  const out = migratePrWatchers({ watchers: { 'pr:o/r#s1': { repo: 'o/r' } } })
  assert.equal(out.watchers['pr:o/r#s1'].kind, 'pr')
  assert.deepEqual(out.watchers['pr:o/r#s1'].seenComments, {})
})

test('migratePrWatchers 幂等', () => {
  const once = migratePrWatchers({ watchers: { 'pr:o/r#s1': { repo: 'o/r', kind: 'pr', seenComments: { 1: 2 } } } })
  const twice = migratePrWatchers(once)
  assert.deepEqual(twice, once)
})

test('migratePrWatchers 保留未知字段', () => {
  const out = migratePrWatchers({ watchers: { 'o/r#s1': { repo: 'o/r', custom: 1 } } })
  assert.equal(out.watchers['o/r#s1'].custom, 1)
})
