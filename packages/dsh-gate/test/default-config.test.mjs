import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  DEFAULT_GATE_PATH,
  TRIGGERS,
  lintText,
  loadGateConfig,
  normalizeConfig,
  validateConfig,
} from '../lib/index.js'
import { tempDir } from '../test-support/helpers.mjs'

const raw = JSON.parse(readFileSync(new URL('../gates/default.json', import.meta.url), 'utf8'))
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))

test('默认规则 JSON 可解析，包名 / 版本 / bin 一致', () => {
  assert.equal(raw.version, 1)
  assert.equal(raw.name, 'default')
  assert.equal(pkg.name, '@mycf711/dsh-gate')
  assert.equal(pkg.version, '0.1.3')
  assert.equal(pkg.bin['dsh-gate'], 'bin/gate.mjs')
  assert.ok(pkg.files.includes('gates/'), 'files 必须包含 gates/')
  assert.ok(pkg.files.includes('lib/'), 'files 必须包含 lib/')
  assert.ok(pkg.files.includes('bin/'), 'files 必须包含 bin/')
})

test('默认规则恰好 10 条，id 唯一且全部通过 validateConfig', () => {
  assert.equal(raw.rules.length, 10)
  assert.equal(new Set(raw.rules.map((rule) => rule.id)).size, 10)
  const checked = validateConfig(raw)
  assert.equal(checked.ok, true)
  assert.equal(checked.config.rules.length, 10)
})

test('默认规则覆盖全部五个触发器', () => {
  const triggers = new Set(raw.rules.flatMap((rule) => rule.triggers))
  assert.deepEqual([...triggers].sort(), [...TRIGGERS].sort())
})

test('语义复审默认关闭，模式为 warn', () => {
  assert.equal(raw.semantic.enabled, false)
  assert.equal(raw.semantic.mode, 'warn')
  assert.ok(raw.semantic.baseURL.startsWith('http://'))
  assert.ok(raw.semantic.model.length > 0)
})

test('10 条默认规则都真的能命中（不是僵尸规则）', () => {
  const samples = {
    secret: 'ghp_' + 'a'.repeat(30),
    'abs-path': '见 D:\\主工作区\\x.js',
    'runtime-version': 'runningVersion: 0.10.2',
    'local-machine': '本机已复现',
    'background-job': '后台任务 bash-12345678 还在跑',
    'internal-id': '见 n9641',
    'foreign-ref': '另见 #13',
    'unpublished-promise': '计划 0.10.5 修复',
    destructive: '建议直接删除分支',
    empty: '   ',
  }
  for (const [id, text] of Object.entries(samples)) {
    const result = lintText(text, raw, { trigger: 'issue.reply', current: 15 })
    assert.ok(result.hits.some((hit) => hit.id === id), id + ' 没有命中：' + text)
    assert.equal(result.ok, false, id + ' 应该阻断：' + text)
  }
})

test('普通 URL 不会被误判成本机路径或内部编号', () => {
  const text = '参考 https://example.com/a/b 与 http://127.0.0.1:3425/v1/models。'
  const result = lintText(text, raw, { trigger: 'issue.reply', current: 15 })
  assert.deepEqual(result.hits, [])
  assert.equal(result.ok, true)
})

test('空仓库 + 空用户目录时只加载默认层', () => {
  const home = tempDir('gate-home-')
  const repo = tempDir('gate-repo-')
  const loaded = loadGateConfig({ repo, home, env: {} })
  assert.deepEqual(loaded.sources.map((source) => source.name), ['default'])
  assert.equal(loaded.config.rules.length, 10)
  assert.deepEqual(loaded.errors, [])
  assert.equal(loaded.sources[0].path, DEFAULT_GATE_PATH)
})

test('normalizeConfig 静默丢弃非法规则，但保留合法规则', () => {
  const config = normalizeConfig({
    name: ' custom ',
    rules: [
      { id: 'ok', type: 'contains', value: 'x', triggers: ['issue.reply'], message: 'ok' },
      { id: 'Bad', type: 'contains', value: 'x' },
      { id: 'bad-regex', type: 'regex', pattern: '(' },
      { id: 'bad-type', type: 'nope' },
      { id: 'bad-trigger', type: 'contains', value: 'x', triggers: ['nope'] },
      null,
    ],
  })
  assert.equal(config.name, 'custom')
  assert.deepEqual(config.rules.map((rule) => rule.id), ['ok'])
  assert.equal(config.semantic, undefined)
})

test('规则不写 triggers 时默认只作用于回复类触发器', () => {
  const config = {
    version: 1,
    rules: [{ id: 'custom', label: '自定义', type: 'contains', value: '禁止词', message: '命中' }],
  }
  assert.equal(lintText('这里有禁止词', config, { trigger: 'issue.reply' }).ok, false)
  assert.equal(lintText('这里有禁止词', config, { trigger: 'merge' }).ok, true)
})

test('坏规则不会退化成「全拦」', () => {
  const config = normalizeConfig({
    rules: [
      { id: 'empty-contains', type: 'contains', value: '', triggers: ['issue.reply'] },
      { id: 'bad-max', type: 'maxLength', value: 0, triggers: ['issue.reply'] },
      { id: 'ok-rule', type: 'contains', value: 'x', triggers: ['issue.reply'], message: 'ok' },
    ],
  })
  assert.deepEqual(config.rules.map((rule) => rule.id), ['ok-rule'])
  assert.equal(lintText('随便写点什么', config, { trigger: 'issue.reply' }).ok, true)
})

test('默认规则路径指向包内 gates/default.json', () => {
  assert.ok(DEFAULT_GATE_PATH.endsWith(join('gates', 'default.json')))
})
