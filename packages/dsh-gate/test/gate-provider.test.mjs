import test from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { createGate } from '../lib/index.js'
import { tempDir, writeJsonFile } from '../test-support/helpers.mjs'

const customConfig = (extra = {}) => ({
  version: 1,
  name: 'custom',
  rules: [
    {
      id: 'banana',
      label: '禁止香蕉',
      type: 'contains',
      value: 'banana',
      triggers: ['issue.reply', 'merge', 'release'],
      message: '不要提香蕉',
    },
  ],
  ...extra,
})

const semanticConfig = (mode = 'warn') => ({
  ...customConfig(),
  semantic: {
    enabled: true,
    baseURL: 'http://gateway.test/v1',
    model: 'test-model',
    mode,
    prompt: 'p',
    timeoutMs: 2000,
    maxInputChars: 8000,
  },
})

test('createGate 暴露稳定的 GateProvider 形状', async () => {
  const gate = createGate({ config: customConfig() })
  assert.equal(gate.id, 'dsh-gate')
  assert.equal(gate.version, '0.1.2')
  assert.equal(typeof gate.check, 'function')
  const result = await gate.check({ trigger: 'issue.reply', text: '干净回复' })
  assert.deepEqual(result, { ok: true, hits: [], semantic: { skipped: true } })
})

test('check 默认 trigger 是 issue.reply，空正文被空回复规则拦住', async () => {
  const gate = createGate({ home: tempDir('gate-provider-home-'), env: {} })
  const result = await gate.check({ text: '   ', repo: tempDir('gate-provider-repo-') })
  assert.equal(result.ok, false)
  assert.ok(result.hits.some((hit) => hit.id === 'empty'))
})

test('check 使用自定义配置并保留 hits 结构', async () => {
  const gate = createGate({ config: customConfig() })
  const result = await gate.check({ trigger: 'issue.reply', text: '我要 banana' })
  assert.equal(result.ok, false)
  assert.deepEqual(result.hits, [
    { id: 'banana', label: '禁止香蕉', severity: 'error', message: '不要提香蕉' },
  ])
})

test('check 读取仓库里的 .superagent/gates.json', async () => {
  const repo = tempDir('gate-provider-repo-')
  const home = tempDir('gate-provider-home-')
  writeJsonFile(join(repo, '.superagent', 'gates.json'), {
    version: 1,
    name: 'project',
    rules: [
      {
        id: 'no-pineapple',
        label: '禁止菠萝',
        type: 'contains',
        value: 'pineapple',
        triggers: ['issue.reply'],
        message: '不要提菠萝',
      },
    ],
  })
  const gate = createGate({ repo, home, env: {} })
  const result = await gate.check({ trigger: 'issue.reply', text: 'pineapple 出现了' })
  assert.equal(result.ok, false)
  assert.equal(result.hits[0].id, 'no-pineapple')
})

test('check 支持 current，用来判断无关引用', async () => {
  const home = tempDir('gate-provider-home-')
  const repo = tempDir('gate-provider-repo-')
  const gate = createGate({ home, env: {} })
  const clean = await gate.check({ trigger: 'issue.reply', text: '本 issue #15 已修复。', current: 15, repo })
  assert.equal(clean.ok, true)
  const foreign = await gate.check({ trigger: 'issue.reply', text: '另见 #13。', current: 15, repo })
  assert.equal(foreign.ok, false)
  assert.ok(foreign.hits.some((hit) => hit.id === 'foreign-ref'))
})

test('语义复审只对 merge / release 生效：issue.reply 不调用模型', async () => {
  let calls = 0
  const gate = createGate({
    config: semanticConfig(),
    semanticOptions: {
      fetchImpl: async () => {
        calls += 1
        throw new Error('不该调用')
      },
    },
  })
  const result = await gate.check({ trigger: 'issue.reply', text: '正文' })
  assert.equal(result.ok, true)
  assert.deepEqual(result.semantic, { skipped: true })
  assert.equal(calls, 0)
})

test('merge + warn：语义问题只告警，不阻断', async () => {
  const gate = createGate({
    config: semanticConfig('warn'),
    semanticOptions: {
      fetchImpl: async () => ({
        ok: true,
        json: async () => ({ choices: [{ message: { content: '{"pass":false,"issues":[{"rule":"scope","reason":"答非所问"}]}' } }] }),
      }),
    },
  })
  const result = await gate.check({ trigger: 'merge', text: '正文' })
  assert.equal(result.ok, true)
  assert.equal(result.semantic.skipped, false)
  assert.equal(result.hits.length, 1)
  assert.equal(result.hits[0].severity, 'warn')
})

test('release + block：语义问题算 error 并阻断', async () => {
  const gate = createGate({
    config: semanticConfig('block'),
    semanticOptions: {
      fetchImpl: async () => ({
        ok: true,
        json: async () => ({ choices: [{ message: { content: '{"pass":false,"issues":[{"rule":"evidence","reason":"没有验证"}]}' } }] }),
      }),
    },
  })
  const result = await gate.check({ trigger: 'release', text: '正文' })
  assert.equal(result.ok, false)
  assert.equal(result.hits[0].severity, 'error')
})

test('semantic:false 时即使配置开启也跳过语义复审', async () => {
  let calls = 0
  const gate = createGate({
    config: semanticConfig(),
    semantic: false,
    semanticOptions: {
      fetchImpl: async () => {
        calls += 1
        throw new Error('不该调用')
      },
    },
  })
  const result = await gate.check({ trigger: 'merge', text: '正文' })
  assert.equal(result.ok, true)
  assert.deepEqual(result.semantic, { skipped: true })
  assert.equal(calls, 0)
})

test('硬门禁失败时不请求模型（先确定性、后语义），硬门禁判定照旧', async () => {
  let calls = 0
  const gate = createGate({
    config: semanticConfig(),
    semanticOptions: {
      fetchImpl: async () => {
        calls += 1
        throw new Error('gateway down')
      },
    },
  })
  const result = await gate.check({ trigger: 'merge', text: 'banana' })
  assert.equal(result.ok, false)
  assert.ok(result.hits.some((hit) => hit.id === 'banana'))
  assert.equal(calls, 0, '硬门禁已经不过，就不该再花一次模型调用')
  assert.equal(result.semantic.skipped, true)
})

test('语义复审不可用时放行：硬门禁干净就不阻断', async () => {
  const gate = createGate({
    config: semanticConfig(),
    semanticOptions: {
      fetchImpl: async () => {
        throw new Error('gateway down')
      },
    },
  })
  const result = await gate.check({ trigger: 'merge', text: '干净回复，没有命中任何硬规则。' })
  assert.equal(result.ok, true)
  assert.equal(result.semantic.ok, true)
  assert.match(result.semantic.warning, /语义复审不可用/)
})

test('check 拒绝未知 trigger', async () => {
  const gate = createGate({ config: customConfig() })
  await assert.rejects(() => gate.check({ trigger: 'push', text: 'x' }), /trigger 必须是/)
})
