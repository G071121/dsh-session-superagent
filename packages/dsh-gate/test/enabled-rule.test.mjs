// 规则级启停（`enabled`）的行为断言。
//
// 冻结契约（docs/任务书-dsh-gate-v2.md §3.1）：
// - 规则可选 `enabled`，缺省 true；`enabled:false` = 本层明确停用同 id 规则。
// - 同 id 后层完整覆盖前层（含 enabled）；停用不可被更前层复活，后层写 enabled:true 即恢复。
// - 复启必须写同 id 完整规则；只写 { id, enabled:true } 缺 type 一律判非法并给具体原因。
// - 写盘保留 enabled:false（JSON 往返仍是 false）；旧配置（没写 enabled）写回不凭空加字段。
// - lintText 跳过 enabled === false 的规则（连 warn 都不出）。
// - 硬门禁失败时不请求模型（先确定性、后语义）。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  createGate,
  lintText,
  loadGateConfig,
  mergeConfig,
  normalizeConfig,
  projectGatePath,
  readGateScope,
  validateConfig,
  writeGateConfig,
} from '../lib/index.js'
import { tempDir, writeJsonFile } from '../test-support/helpers.mjs'

const SECRET_TEXT = 'token=ghp_' + 'a'.repeat(30)

const rule = (id, extra = {}) => ({
  id,
  label: id,
  type: 'contains',
  value: id,
  triggers: ['issue.reply', 'pr.reply', 'pr.handle', 'merge', 'release'],
  message: id + ' 命中',
  ...extra,
})

// 默认层 'secret' 规则的完整形状（复启必须写完整规则）。
const secretRule = (extra = {}) => ({
  id: 'secret',
  label: '禁止凭证与密钥',
  type: 'regex',
  pattern: 'ghp_[A-Za-z0-9]{20,}',
  triggers: ['issue.reply', 'pr.reply', 'pr.handle', 'merge', 'release'],
  message: '删掉凭证',
  ...extra,
})

// ---------------------------------------------------------------- normalize

test('normalizeConfig：保留 enabled:false（不丢）', () => {
  const normalized = normalizeConfig({ rules: [rule('secret-rule', { enabled: false })] })
  assert.equal(normalized.rules.length, 1)
  assert.equal(normalized.rules[0].enabled, false)
})

test('normalizeConfig：保留显式 enabled:true', () => {
  const normalized = normalizeConfig({ rules: [rule('secret-rule', { enabled: true })] })
  assert.equal(normalized.rules[0].enabled, true)
})

test('normalizeConfig：没写 enabled 时归一化结果不带该字段（旧配置写回字节不变）', () => {
  const normalized = normalizeConfig({ rules: [rule('secret-rule')] })
  assert.equal(Object.prototype.hasOwnProperty.call(normalized.rules[0], 'enabled'), false)
})

test('normalizeConfig：非布尔 enabled 不会被当成停用（fail-closed，规则仍生效）', () => {
  for (const bad of ['false', 0, null, []]) {
    const normalized = normalizeConfig({ rules: [rule('secret-rule', { enabled: bad })] })
    assert.equal(normalized.rules.length, 1, '坏 enabled 不能把规则整条丢掉：' + JSON.stringify(bad))
    assert.notEqual(normalized.rules[0].enabled, false, '字符串 "false" 不等于停用：' + JSON.stringify(bad))
  }
})

// ----------------------------------------------------------------- lintText

test('lintText：enabled:false 的规则不命中（error 也不出）', () => {
  const config = { rules: [rule('banned', { type: 'contains', value: '禁止词', enabled: false })] }
  const result = lintText('这里写了禁止词。', config, { trigger: 'issue.reply' })
  assert.equal(result.ok, true)
  assert.deepEqual(result.hits, [])
})

test('lintText：enabled:false 的 warn 规则连 warn 都不出', () => {
  const config = { rules: [rule('soft', { type: 'contains', value: '注意', severity: 'warn', enabled: false })] }
  const result = lintText('这里需要注意事项。', config, { trigger: 'issue.reply' })
  assert.equal(result.ok, true)
  assert.deepEqual(result.hits, [])
})

test('lintText：停用一条不影响同层其它规则', () => {
  const config = {
    rules: [
      rule('off', { type: 'contains', value: '禁止词', enabled: false }),
      rule('on', { type: 'contains', value: '禁止词' }),
    ],
  }
  const result = lintText('这里写了禁止词。', config, { trigger: 'issue.reply' })
  assert.equal(result.ok, false)
  assert.deepEqual(result.hits.map((hit) => hit.id), ['on'])
})

// -------------------------------------------------------------- mergeConfig

test('mergeConfig：同 id 后层写 enabled:false 真停用', () => {
  const base = { name: 'base', rules: [rule('secret-rule')] }
  const merged = mergeConfig(base, { name: 'override', rules: [rule('secret-rule', { enabled: false })] })
  assert.equal(merged.rules.length, 1)
  assert.equal(merged.rules[0].enabled, false)
})

test('mergeConfig：后层写完整规则（enabled 缺省 true）即复启', () => {
  const base = { name: 'base', rules: [rule('secret-rule', { enabled: false })] }
  const merged = mergeConfig(base, { name: 'override', rules: [rule('secret-rule', { enabled: true })] })
  assert.equal(merged.rules[0].enabled, true)
  const defaulted = mergeConfig(base, { name: 'override', rules: [rule('secret-rule')] })
  assert.equal(Object.prototype.hasOwnProperty.call(defaulted.rules[0], 'enabled'), false, '缺省即启用')
})

test('mergeConfig：不同 id 追加不影响已停用规则的开关', () => {
  const base = { name: 'base', rules: [rule('secret-rule', { enabled: false })] }
  const merged = mergeConfig(base, { name: 'override', rules: [rule('other-rule')] })
  const secret = merged.rules.find((item) => item.id === 'secret-rule')
  assert.equal(secret.enabled, false)
  assert.deepEqual(merged.rules.map((item) => item.id), ['secret-rule', 'other-rule'])
})

// ----------------------------------------------------------- 四层真实合并

test('四层合并：用户层 enabled:false 真停用默认规则，后层不同 id 不复活', () => {
  const home = tempDir('gate-home-')
  const repo = tempDir('gate-repo-')
  writeJsonFile(join(home, '.dsh', 'state', 'session-superagent', 'gates.json'), {
    name: 'user',
    rules: [secretRule({ enabled: false })],
  })
  writeJsonFile(join(repo, '.superagent', 'gates.json'), {
    name: 'project',
    rules: [rule('project-only', { value: '项目专属' })],
  })
  const loaded = loadGateConfig({ repo, home, env: {} })
  const secret = loaded.config.rules.find((item) => item.id === 'secret')
  assert.equal(secret.enabled, false, '合并结果必须保留 enabled:false')
  const result = lintText(SECRET_TEXT, loaded.config, { trigger: 'issue.reply' })
  assert.equal(result.ok, true, '停用的规则不该再命中')
  assert.deepEqual(result.hits, [])
})

test('四层合并：后层写完整规则 + enabled:true 复启', () => {
  const home = tempDir('gate-home-')
  const repo = tempDir('gate-repo-')
  writeJsonFile(join(home, '.dsh', 'state', 'session-superagent', 'gates.json'), {
    name: 'user',
    rules: [secretRule({ enabled: false })],
  })
  writeJsonFile(join(repo, '.superagent', 'gates.local.json'), {
    name: 'local',
    rules: [secretRule({ enabled: true })],
  })
  const loaded = loadGateConfig({ repo, home, env: {} })
  const secret = loaded.config.rules.find((item) => item.id === 'secret')
  assert.equal(secret.enabled, true, '后层 enabled:true 必须恢复')
  assert.equal(lintText(SECRET_TEXT, loaded.config, { trigger: 'issue.reply' }).ok, false)
})

test('四层合并：只写 { id, enabled:true } 的复启规则被丢弃，不会静默复启', () => {
  const home = tempDir('gate-home-')
  const repo = tempDir('gate-repo-')
  writeJsonFile(join(home, '.dsh', 'state', 'session-superagent', 'gates.json'), {
    name: 'user',
    rules: [secretRule({ enabled: false })],
  })
  writeJsonFile(join(repo, '.superagent', 'gates.local.json'), {
    name: 'local',
    rules: [{ id: 'secret', enabled: true }],
  })
  const loaded = loadGateConfig({ repo, home, env: {} })
  assert.equal(loaded.config.rules.length, 10, '缺 type 的规则不应该进合并结果')
  const secret = loaded.config.rules.find((item) => item.id === 'secret')
  assert.equal(secret.enabled, false, '不完整规则不能悄悄复启')
})

// ----------------------------------------------------------- validateConfig

test('validateConfig：接受布尔 enabled 并原样保留', () => {
  const off = validateConfig({ rules: [rule('secret-rule', { enabled: false })] })
  assert.equal(off.ok, true)
  assert.equal(off.config.rules[0].enabled, false)
  const on = validateConfig({ rules: [rule('secret-rule', { enabled: true })] })
  assert.equal(on.ok, true)
  assert.equal(on.config.rules[0].enabled, true)
})

test('validateConfig：enabled 非布尔报错，点名 enabled', () => {
  for (const bad of ['false', 0, null, []]) {
    const checked = validateConfig({ rules: [rule('secret-rule', { enabled: bad })] })
    assert.equal(checked.ok, false, '非布尔 enabled 必须拒绝：' + JSON.stringify(bad))
    assert.match(checked.error, /enabled 必须是布尔值/)
  }
})

test('validateConfig：只写 { id, enabled } 缺 type 报「规则缺少 type」', () => {
  const checked = validateConfig({ rules: [{ id: 'secret', enabled: true }] })
  assert.equal(checked.ok, false)
  assert.match(checked.error, /规则缺少 type/)
  assert.match(checked.error, /完整规则/)
})

// --------------------------------------------------------- writeGateConfig

test('writeGateConfig：enabled:false 写盘后读回仍是 false（JSON 往返一致）', () => {
  const repo = tempDir('gate-write-')
  const home = tempDir('gate-home-')
  const saved = writeGateConfig('project', { version: 1, rules: [rule('secret-rule', { enabled: false })] }, {
    repo,
    home,
    env: {},
  })
  assert.equal(saved.config.rules[0].enabled, false)
  const written = JSON.parse(readFileSync(projectGatePath(repo), 'utf8'))
  assert.equal(written.rules[0].enabled, false)
  assert.equal(validateConfig(written).ok, true, '写出来的配置必须还能通过校验')
  // 面板读的是**本层原始形状**：enabled:false 不能在读取时被归一化掉。
  const scope = readGateScope('project', { repo, home, env: {} })
  assert.equal(scope.config.rules[0].enabled, false, 'readGateScope 不能丢 enabled')
})

test('writeGateConfig：旧配置（没写 enabled）写回不凭空加字段', () => {
  const repo = tempDir('gate-write-')
  const home = tempDir('gate-home-')
  writeGateConfig('project', { version: 1, rules: [rule('legacy-rule')] }, { repo, home, env: {} })
  const written = JSON.parse(readFileSync(projectGatePath(repo), 'utf8'))
  assert.equal(Object.prototype.hasOwnProperty.call(written.rules[0], 'enabled'), false)
})

// ------------------------------------------------------------- createGate

test('createGate：停用的规则不阻断回复', async () => {
  const gate = createGate({
    config: { rules: [rule('banana', { type: 'contains', value: 'banana', enabled: false })] },
  })
  const result = await gate.check({ trigger: 'issue.reply', text: '我要 banana' })
  assert.equal(result.ok, true)
  assert.deepEqual(result.hits, [])
})

test('createGate：硬门禁失败时不请求模型（先确定性、后语义）', async () => {
  let calls = 0
  const gate = createGate({
    config: {
      rules: [rule('banana', { type: 'contains', value: 'banana' })],
      semantic: {
        enabled: true,
        baseURL: 'http://gateway.test/v1',
        model: 'test-model',
        mode: 'warn',
        prompt: 'p',
        timeoutMs: 2000,
        maxInputChars: 8000,
      },
    },
    semanticOptions: {
      fetchImpl: async () => {
        calls += 1
        throw new Error('硬门禁已经不过，不该请求模型')
      },
    },
  })
  const result = await gate.check({ trigger: 'merge', text: '我要 banana' })
  assert.equal(result.ok, false)
  assert.ok(result.hits.some((hit) => hit.id === 'banana'))
  assert.equal(calls, 0, '硬门禁失败时不许请求模型')
  assert.equal(result.semantic.skipped, true)
})

test('createGate：硬门禁干净时才请求语义复审（正对照）', async () => {
  let calls = 0
  const gate = createGate({
    config: {
      rules: [rule('banana', { type: 'contains', value: 'banana' })],
      semantic: {
        enabled: true,
        baseURL: 'http://gateway.test/v1',
        model: 'test-model',
        mode: 'warn',
        prompt: 'p',
        timeoutMs: 2000,
        maxInputChars: 8000,
      },
    },
    semanticOptions: {
      fetchImpl: async () => {
        calls += 1
        return { ok: true, json: async () => ({ choices: [{ message: { content: '{"pass":true,"issues":[]}' } }] }) }
      },
    },
  })
  const result = await gate.check({ trigger: 'merge', text: '干净回复，没有命中任何硬规则。' })
  assert.equal(result.ok, true)
  assert.equal(calls, 1, '干净回复才请求语义复审')
  assert.equal(result.semantic.skipped, false)
})
