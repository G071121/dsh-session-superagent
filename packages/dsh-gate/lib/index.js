/**
 * @mycf711/dsh-gate —— 内容层门禁（确定性规则 + 可选语义复审）。
 *
 * 门禁只管「回复正文里有什么」：凭证、本机路径、越界引用、未发布承诺、破坏性建议。
 * 它**不是**工具权限层，不替代官方授权审查。
 *
 * 四层配置，后者覆盖前者：
 *   1. 默认          packages/dsh-gate/gates/default.json（随包发布）
 *   2. 用户全局      ~/.dsh/state/session-superagent/gates.json
 *   3. 项目          <repo>/.superagent/gates.json
 *   4. 本地覆盖      <repo>/.superagent/gates.local.json
 *
 * 规则按 id 合并：同 id 覆盖，不同 id 追加。规则可选 `enabled`（缺省 `true`）：
 * `enabled:false` 表示本层明确停用该规则，后层写**同 id 完整规则** + `enabled:true` 即恢复。
 * 项目 / 本地只能**关闭**语义复审，不能替用户开复审或换模型。
 *
 * 除 loadGateConfig / readGateScope / writeGateConfig 这类显式 IO 函数外，其余都是纯函数，方便主插件和测试注入。
 */
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  DEFAULT_GATE_GUARD_STALE_MS,
  DEFAULT_GATE_LOCK_POLL_MS,
  DEFAULT_GATE_LOCK_STALE_MS,
  DEFAULT_GATE_LOCK_TIMEOUT_MS,
  DEFAULT_GATE_RENAME_ATTEMPTS,
  DEFAULT_GATE_RENAME_BACKOFF_MS,
  acquireGateConfigLock,
  renameWithRetry,
  sleepSync,
} from './config-lock.js'
import {
  SEMANTIC_TRIGGERS,
  normalizeSemanticConfig,
  semanticReview,
} from './semantic.js'

export {
  DEFAULT_GATE_ARTIFACT_KEEP,
  DEFAULT_GATE_ARTIFACT_MIN_AGE_MS,
  DEFAULT_GATE_GUARD_STALE_MS,
  DEFAULT_GATE_LOCK_POLL_MS,
  DEFAULT_GATE_LOCK_STALE_MS,
  DEFAULT_GATE_LOCK_TIMEOUT_MS,
  DEFAULT_GATE_RENAME_ATTEMPTS,
  DEFAULT_GATE_RENAME_BACKOFF_MS,
  GATE_GUARD_SUFFIX,
  GATE_LOCK_SUFFIX,
  acquireGateConfigLock,
  gateGuardPath,
  gateLockPath,
  pruneLockArtifacts,
  renameWithRetry,
} from './config-lock.js'

export {
  SEMANTIC_TRIGGERS,
  listModels,
  normalizeSemanticConfig,
  optimizePrompt,
  resolveSemanticConfig,
  parseSemanticReply,
  semanticReview,
} from './semantic.js'

export const PACKAGE_NAME = '@mycf711/dsh-gate'
/** 与 package.json 的 version 同步（测试守着）。 */
export const PACKAGE_VERSION = '0.1.3'

const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

/** 门禁支持的全部触发器。 */
export const TRIGGERS = Object.freeze(['issue.reply', 'pr.reply', 'pr.handle', 'merge', 'release'])
const TRIGGER_SET = new Set(TRIGGERS)
const SEMANTIC_TRIGGER_SET = new Set(SEMANTIC_TRIGGERS)

/** 确定性规则类型。 */
export const RULE_TYPES = Object.freeze(['regex', 'contains', 'maxLength', 'nonEmpty', 'foreign-ref'])
const RULE_TYPE_SET = new Set(RULE_TYPES)

const RULE_ID_RE = /^[a-z][a-z0-9-]{1,63}$/
const MAX_PATTERN_LENGTH = 400
const MAX_EXTENDS_DEPTH = 8

export const DEFAULT_GATE_PATH = join(PACKAGE_ROOT, 'gates', 'default.json')

function stateDir({ home = homedir(), env = process.env } = {}) {
  return env.DSH_SUPERAGENT_STATE || join(home, '.dsh', 'state', 'session-superagent')
}

/** 用户全局配置路径；`DSH_GATE_USER_CONFIG` 可整体覆盖，方便测试与自定义安装。 */
export function userGatePath({ home = homedir(), env = process.env } = {}) {
  return env.DSH_GATE_USER_CONFIG || join(stateDir({ home, env }), 'gates.json')
}

/** 项目配置路径。 */
export function projectGatePath(repo = process.cwd()) {
  return join(repo || process.cwd(), '.superagent', 'gates.json')
}

/** 本地覆盖路径（不进版本库）。 */
export function localGatePath(repo = process.cwd()) {
  return join(repo || process.cwd(), '.superagent', 'gates.local.json')
}

// 旧版主插件 lib/gates.js 的导出名，保留给 re-export，避免 G2 迁移时破坏调用点。
export const USER_GATE_PATH = userGatePath
export const PROJECT_GATE_PATH = projectGatePath
export const LOCAL_GATE_PATH = localGatePath

function configPathFor(scope, { repo = process.cwd(), home = homedir(), env = process.env, defaultPath = DEFAULT_GATE_PATH } = {}) {
  if (scope === 'default') return defaultPath
  if (scope === 'user') return userGatePath({ home, env })
  if (scope === 'project') return projectGatePath(repo)
  if (scope === 'local') return localGatePath(repo)
  throw new Error('scope 只能是 default / user / project / local，收到：' + String(scope))
}

// ── extends 的写盘安全 ───────────────────────────────────────────────────────
// 只有 `false` / `'none'` 能原样写回：它们不引用任何外部内容，写回后语义不变（本层替换）。
// `true` / `'default'` / 路径字符串 / 内联对象都表示「本层以别处为基」，而写盘是整层重写
// （只写 version/name/extends/rules/semantic，其中 extends 只保留 false/'none'），
// 写下去就把基规则连同 `extends` 一起冲掉 —— 必须报错。
const EXTENDS_ABSENT = 'absent'
const EXTENDS_KEEP = 'keep'
const EXTENDS_SHARED = 'shared'
const EXTENDS_INVALID = 'invalid'

function hasOwn(object, key) {
  return Boolean(object) && typeof object === 'object'
    && Object.prototype.hasOwnProperty.call(object, key)
}

/**
 * 判断一个 `extends` 值能不能在整层重写里安全保留。
 * 读侧分类见 `readLayerConfig`：false/'none' = 替换，true/'default'/路径/对象 = 共享基。
 */
function classifyExtends(value) {
  if (value === undefined) return EXTENDS_ABSENT
  if (value === false || value === 'none') return EXTENDS_KEEP
  if (typeof value === 'string') return EXTENDS_SHARED // 含 'default'
  if (value === true) return EXTENDS_SHARED
  if (value && typeof value === 'object' && !Array.isArray(value)) return EXTENDS_SHARED
  return EXTENDS_INVALID
}

function describeExtends(value) {
  let text
  try {
    text = JSON.stringify(value)
  } catch {
    text = ''
  }
  if (text === undefined || text === '') text = String(value)
  return text.length > 80 ? text.slice(0, 79) + '…' : text
}

/** 写盘侧的 extends 拒绝错误：必须点名配置路径 + 解决方式（面板和 CLI 都直接展示它）。 */
function extendsWriteError(source, path, value) {
  const detail = source === 'existing'
    ? '该文件现有的 extends（' + describeExtends(value) + '）会在整层重写时丢失，它共享的基规则也跟着失效。'
    : '本条配置里的 extends（' + describeExtends(value) + '）无法在整层重写时保留。'
  const fix = source === 'existing'
    ? '解决方式：直接手工编辑该文件；或先把基规则合并进本层规则、删掉 extends 后再从面板保存。'
    : '解决方式：先手工编辑该文件把基规则合并进本层规则，或把 extends 改成 false / "none" 后再保存。'
  const error = new Error('无法安全写入 extends：' + path + '。' + detail + fix)
  error.code = 'extends_not_preservable'
  error.path = path
  return error
}

/**
 * 读磁盘上现有文件的 `extends`。坏 JSON / 非对象：返回 absent ——
 * 那种文件每次读取都会报错，写盘时原文会先进 `.bak`，不会被静默抹掉。
 */
function existingExtends(path) {
  const absent = { kind: EXTENDS_ABSENT, value: undefined }
  if (!existsSync(path)) return absent
  let raw
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return absent
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || !hasOwn(raw, 'extends')) return absent
  return { kind: classifyExtends(raw.extends), value: raw.extends }
}

function normalizeRule(rule) {
  if (!rule || typeof rule !== 'object' || Array.isArray(rule)) return null
  const id = String(rule.id || '')
  if (!RULE_ID_RE.test(id)) return null
  if (!RULE_TYPE_SET.has(rule.type)) return null
  if (rule.severity !== undefined && rule.severity !== 'error' && rule.severity !== 'warn') return null
  const triggers = Array.isArray(rule.triggers) && rule.triggers.length > 0
    ? [...new Set(rule.triggers.map(String).filter((trigger) => TRIGGER_SET.has(trigger)))]
    : ['issue.reply', 'pr.reply']
  if (triggers.length === 0) return null
  const flags = typeof rule.flags === 'string' ? rule.flags : ''
  if (rule.type === 'regex') {
    const pattern = String(rule.pattern || '')
    if (!pattern || [...pattern].length > MAX_PATTERN_LENGTH) return null
    try {
      new RegExp(pattern, flags)
    } catch {
      return null
    }
  }
  if (rule.type === 'foreign-ref' && rule.pattern !== undefined) {
    try {
      new RegExp(String(rule.pattern), 'g')
    } catch {
      return null
    }
  }
  // 坏规则不能变成「全拦」：contains 空串 / maxLength 非正数会让每条回复都命中，
  // 直接丢弃（validateConfig 会给出具体原因），而不是静默阻断所有回复。
  if (rule.type === 'contains' && (typeof rule.value !== 'string' || rule.value.length === 0)) return null
  if (rule.type === 'maxLength' && !(Number.isFinite(Number(rule.value)) && Number(rule.value) > 0)) return null
  const normalized = {
    id,
    label: String(rule.label || id),
    description: String(rule.description || ''),
    severity: rule.severity === 'warn' ? 'warn' : 'error',
    triggers,
    type: rule.type,
    pattern: rule.pattern === undefined ? undefined : String(rule.pattern),
    flags,
    value: rule.value,
    message: String(rule.message || rule.label || '未通过门禁'),
  }
  // 规则级启停：只保留**显式写了的布尔值**，缺省即启用（旧配置写回不凭空加字段）。
  // 非布尔（例如字符串 "false"）一律忽略：宁可规则继续生效，也不静默把保护关掉。
  if (typeof rule.enabled === 'boolean') normalized.enabled = rule.enabled
  return normalized
}

/** 整理成稳定形状；非法规则被丢弃（`validateConfig` 会给出具体原因）。 */
export function normalizeConfig(input, semanticBase = undefined) {
  const config = input && typeof input === 'object' && !Array.isArray(input) ? input : {}
  const rules = Array.isArray(config.rules) ? config.rules.map(normalizeRule).filter(Boolean) : []
  return {
    version: 1,
    name: typeof config.name === 'string' && config.name.trim() ? config.name.trim() : 'config',
    rules,
    semantic: normalizeSemanticConfig(config.semantic, semanticBase),
  }
}

/**
 * 合并两层配置：同 id 覆盖、不同 id 追加；语义复审按字段覆盖。
 * 规则顺序保持「先出现的位置」，同 id 只更新内容。
 */
export function mergeConfig(base, override) {
  const a = normalizeConfig(base)
  // 语义配置按字段合并：只写 mode 的层不能把上层 baseURL / model 清空。
  const b = normalizeConfig(override, a.semantic)
  const byId = new Map(a.rules.map((rule) => [rule.id, rule]))
  for (const rule of b.rules) byId.set(rule.id, rule)
  return {
    version: 1,
    name: b.name !== 'config' ? b.name : a.name,
    rules: [...byId.values()],
    semantic: b.semantic,
  }
}

/**
 * 读一个配置层，并解析 `extends`。
 *
 * - 没有 `extends`：只返回本层规则（由调用方叠到已累积配置上）。
 * - `extends: false | 'none'`：返回 `mode: 'replace'`，丢掉之前所有层。
 * - `extends: true | 'default'`：以包内默认配置为基。
 * - `extends: './base.json'`：以相对本文件的配置为基。
 * - `extends: { rules: [...] }`：以对象为基。
 *
 * 读不到 / 循环 / 层级过深时**不抛错**：记录 error，按本层规则继续（fail-open，
 * 避免一个坏配置文件让整个门禁不可用）。
 */
function readLayerConfig(path, { seen = new Set(), depth = 0 } = {}) {
  const absolute = resolve(path)
  const empty = { config: normalizeConfig(null), mode: 'merge', raw: null, error: null }
  if (depth > MAX_EXTENDS_DEPTH) {
    return { ...empty, error: 'extends 嵌套超过 ' + MAX_EXTENDS_DEPTH + ' 层：' + basename(absolute) }
  }
  if (seen.has(absolute)) {
    return { ...empty, error: 'extends 出现循环：' + basename(absolute) }
  }
  seen.add(absolute)
  if (!existsSync(absolute)) {
    return { ...empty, error: 'extends 目标不存在：' + basename(absolute) }
  }
  let raw
  try {
    raw = JSON.parse(readFileSync(absolute, 'utf8'))
  } catch (error) {
    return { ...empty, error: '配置不是合法 JSON：' + basename(absolute) + '（' + String((error && error.message) || error) + '）' }
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ...empty, error: '配置必须是对象：' + basename(absolute) }
  }
  if (!Object.prototype.hasOwnProperty.call(raw, 'extends')) {
    // 返回**原始对象**，让调用方的 mergeConfig 按字段合并 semantic。
    return { config: raw, mode: 'merge', raw, error: null }
  }
  const extended = raw.extends
  if (extended === false || extended === 'none') {
    return { config: raw, mode: 'replace', raw, error: null }
  }
  if (extended === true || extended === 'default') {
    const base = readLayerConfig(DEFAULT_GATE_PATH, { seen: new Set(seen), depth: depth + 1 })
    return { config: mergeConfig(base.config, raw), mode: 'merge', raw, error: base.error }
  }
  if (typeof extended === 'string') {
    const target = resolve(dirname(absolute), extended)
    const base = readLayerConfig(target, { seen, depth: depth + 1 })
    return { config: mergeConfig(base.config, raw), mode: 'merge', raw, error: base.error }
  }
  if (extended && typeof extended === 'object' && !Array.isArray(extended)) {
    return { config: mergeConfig(extended, raw), mode: 'merge', raw, error: null }
  }
  return { config: raw, mode: 'merge', raw, error: 'extends 必须是字符串、false 或对象：' + basename(absolute) }
}

/**
 * 项目 / 本地层只能关掉语义复审，不能开启或换模型。
 * 返回修正后的配置；尝试开启时往 errors 里记一条。
 */
function restrictSemantic(config, raw, beforeSemantic, layer, path, errors) {
  const requested = raw && Object.prototype.hasOwnProperty.call(raw, 'semantic') ? raw.semantic : undefined
  const disable = requested === false
    || (requested && typeof requested === 'object' && !Array.isArray(requested) && requested.enabled === false)
  const attempted = requested !== undefined && !disable
  const semantic = beforeSemantic
    ? { ...beforeSemantic, enabled: disable ? false : beforeSemantic.enabled === true }
    : { enabled: false }
  if (attempted) {
    errors.push({ layer, path, error: '项目/本地配置只能关闭语义复审，不能开启或更换模型' })
  }
  return { ...config, semantic }
}

/**
 * 读取四层配置。
 *
 * @returns {{ config: object, sources: Array<{name: string, path: string}>, errors: Array<{layer: string, path: string, error: string}> }}
 * `sources` 只列真实存在的层（按 default → user → project → local 顺序）。
 */
export function loadGateConfig({
  repo = process.cwd(),
  home = homedir(),
  env = process.env,
  defaultPath = DEFAULT_GATE_PATH,
} = {}) {
  const sources = []
  const errors = []
  let config = normalizeConfig(null)
  const layers = [
    ['default', defaultPath],
    ['user', userGatePath({ home, env })],
    ['project', projectGatePath(repo)],
    ['local', localGatePath(repo)],
  ]
  for (const [name, path] of layers) {
    if (!existsSync(path)) {
      if (name === 'default') errors.push({ layer: name, path, error: '默认规则文件不存在' })
      continue
    }
    const layer = readLayerConfig(path)
    if (!layer.raw) {
      errors.push({ layer: name, path, error: layer.error || '配置读取失败' })
      continue
    }
    if (layer.error) errors.push({ layer: name, path, error: layer.error })
    sources.push({ name, path })
    const beforeSemantic = config.semantic
    config = layer.mode === 'replace' ? normalizeConfig(layer.config) : mergeConfig(config, layer.config)
    if (name === 'project' || name === 'local') {
      config = restrictSemantic(config, layer.raw, beforeSemantic, name, path, errors)
    }
  }
  return { config, sources, errors }
}

function normalizeCurrent(value) {
  if (value === undefined || value === null) return null
  const text = String(value).trim().replace(/^#/, '')
  if (!/^\d+$/.test(text)) return null
  return String(Number(text))
}

function ruleMatches(rule, text, current) {
  if (rule.type === 'nonEmpty') return text.trim().length === 0
  if (rule.type === 'maxLength') return text.length > Number(rule.value || 0)
  if (rule.type === 'contains') return text.includes(String(rule.value || ''))
  if (rule.type === 'foreign-ref') {
    // 没给当前编号时无法判断「其它」——跳过，不制造假红。
    const currentRef = normalizeCurrent(current)
    if (currentRef === null) return false
    const re = new RegExp(rule.pattern || '#(\\d+)', 'g')
    const refs = [...text.matchAll(re)].map((match) => (match[1] === undefined ? match[0] : match[1]))
    return refs.some((ref) => normalizeCurrent(ref) !== currentRef)
  }
  return new RegExp(rule.pattern, rule.flags || '').test(text)
}

function assertTrigger(trigger) {
  if (!TRIGGER_SET.has(trigger)) {
    throw new Error('trigger 必须是 ' + TRIGGERS.join(' / ') + ' 之一，收到：' + String(trigger))
  }
}

/**
 * 跑确定性门禁。
 *
 * @param {string} text 回复正文
 * @param {object} config 配置（四层合并结果或任意自定义配置）
 * @param {{trigger?: string, current?: number|string}} options
 * @returns {{ ok: boolean, hits: Array<{id: string, label: string, severity: 'error'|'warn', message: string}> }}
 * `ok` 只由 `severity: 'error'` 的命中决定；warn 命中会出现在 hits 里但不阻断。
 */
export function lintText(text, config, { trigger = 'issue.reply', current } = {}) {
  assertTrigger(trigger)
  const body = String(text ?? '')
  const hits = []
  for (const rule of normalizeConfig(config).rules) {
    // 本层明确停用（enabled:false）的规则不参与判定：连 warn 都不出，ok 口径不变。
    if (rule.enabled === false) continue
    if (!rule.triggers.includes(trigger)) continue
    if (!ruleMatches(rule, body, current)) continue
    hits.push({ id: rule.id, label: rule.label, severity: rule.severity, message: rule.message })
  }
  return { ok: hits.every((hit) => hit.severity !== 'error'), hits }
}

/**
 * 严格校验一份配置（写盘 / 面板保存前用）。
 * 与 `normalizeConfig` 不同：这里不静默丢弃，返回第一条具体错误。
 *
 * `extends` 在这里只做**形状**校验，并且会原样带在返回的 `config` 上：
 * 面板保存走的是 `validateConfig` → `writeGateConfig`，如果在这一步把 `extends` 抹掉，
 * 写盘端就再也没机会知道调用方传过它（Q1-F3 的静默丢失）。能不能安全写下去由
 * `writeGateConfig` 按目标路径判定（它才拿得到配置路径，报错时能点名）。
 */
export function validateConfig(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, error: '配置必须是对象' }
  }
  const hasExtends = Object.prototype.hasOwnProperty.call(input, 'extends') && input.extends !== undefined
  if (hasExtends && classifyExtends(input.extends) === EXTENDS_INVALID) {
    return { ok: false, error: 'extends 只能是 true、false、字符串或对象' }
  }
  if (!Array.isArray(input.rules)) return { ok: false, error: 'rules 必须是数组' }
  if (input.name !== undefined && typeof input.name !== 'string') return { ok: false, error: 'name 必须是字符串' }
  const seen = new Set()
  for (const raw of input.rules) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      return { ok: false, error: '规则必须是对象' }
    }
    const id = String(raw.id || '')
    if (!RULE_ID_RE.test(id)) return { ok: false, error: '规则 id 非法：' + (id || '?') }
    if (seen.has(id)) return { ok: false, error: '规则 id 重复：' + id }
    seen.add(id)
    if (raw.enabled !== undefined && typeof raw.enabled !== 'boolean') {
      return { ok: false, error: 'enabled 必须是布尔值：' + id }
    }
    if (!RULE_TYPE_SET.has(raw.type)) {
      // 只写 { id, enabled } 的「复启」不是合法规则：不完整规则会被合并丢掉，
      // 面板必须看到具体原因，而不是以为已经保存、实际还停用着。
      return {
        ok: false,
        error: raw.type === undefined
          ? '规则缺少 type：' + id + '（只写 id + enabled 不能停用或复启，请写完整规则）'
          : '规则类型非法：' + id,
      }
    }
    if (raw.severity !== undefined && raw.severity !== 'error' && raw.severity !== 'warn') {
      return { ok: false, error: 'severity 只能是 error / warn：' + id }
    }
    if (raw.triggers !== undefined) {
      if (!Array.isArray(raw.triggers) || raw.triggers.length === 0) {
        return { ok: false, error: 'triggers 必须是非空数组：' + id }
      }
      for (const trigger of raw.triggers) {
        if (!TRIGGER_SET.has(String(trigger))) {
          return { ok: false, error: '未知 trigger：' + String(trigger) + '（' + id + '）' }
        }
      }
    }
    if (raw.type === 'regex') {
      const pattern = String(raw.pattern || '')
      if (!pattern) return { ok: false, error: 'regex 规则缺少 pattern：' + id }
      if ([...pattern].length > MAX_PATTERN_LENGTH) return { ok: false, error: '正则过长（上限 ' + MAX_PATTERN_LENGTH + ' 字符）：' + id }
      if (raw.flags !== undefined && typeof raw.flags !== 'string') return { ok: false, error: 'flags 必须是字符串：' + id }
      try {
        new RegExp(pattern, raw.flags || '')
      } catch (error) {
        return { ok: false, error: '正则非法：' + id + '（' + String((error && error.message) || error) + '）' }
      }
    }
    if (raw.type === 'contains' && (typeof raw.value !== 'string' || raw.value.length === 0)) {
      return { ok: false, error: 'contains 规则缺少 value：' + id }
    }
    if (raw.type === 'maxLength' && !(Number.isFinite(Number(raw.value)) && Number(raw.value) > 0)) {
      return { ok: false, error: 'maxLength 规则的 value 必须是正数：' + id }
    }
    if (raw.type === 'foreign-ref' && raw.pattern !== undefined) {
      try {
        new RegExp(String(raw.pattern), 'g')
      } catch (error) {
        return { ok: false, error: 'foreign-ref 的 pattern 非法：' + id + '（' + String((error && error.message) || error) + '）' }
      }
    }
  }
  if (input.semantic !== undefined && input.semantic !== false) {
    if (typeof input.semantic !== 'object' || Array.isArray(input.semantic)) {
      return { ok: false, error: 'semantic 必须是对象或 false' }
    }
    if (input.semantic.enabled !== undefined && typeof input.semantic.enabled !== 'boolean') {
      return { ok: false, error: 'semantic.enabled 必须是布尔值' }
    }
    if (input.semantic.mode !== undefined && input.semantic.mode !== 'warn' && input.semantic.mode !== 'block') {
      return { ok: false, error: 'semantic.mode 只能是 warn / block' }
    }
    if (input.semantic.timeoutMs !== undefined && !(Number.isFinite(Number(input.semantic.timeoutMs)) && Number(input.semantic.timeoutMs) > 0)) {
      return { ok: false, error: 'semantic.timeoutMs 必须是正数' }
    }
    if (input.semantic.maxInputChars !== undefined && !(Number.isFinite(Number(input.semantic.maxInputChars)) && Number(input.semantic.maxInputChars) > 0)) {
      return { ok: false, error: 'semantic.maxInputChars 必须是正数' }
    }
  }
  const normalized = normalizeConfig(input)
  if (hasExtends) normalized.extends = input.extends
  return { ok: true, config: normalized }
}

/** 读某一层的原始配置（给面板展示「这一层现在写的是什么」）。 */
export function readGateScope(scope, { repo = process.cwd(), home = homedir(), env = process.env, defaultPath = DEFAULT_GATE_PATH } = {}) {
  const path = configPathFor(scope, { repo, home, env, defaultPath })
  try {
    if (!existsSync(path)) return { path, config: null }
    return { path, config: JSON.parse(readFileSync(path, 'utf8')) }
  } catch (error) {
    return { path, config: null, error: '配置不是合法 JSON：' + String((error && error.message) || error) }
  }
}

/**
 * 写某一层配置：先备份 `.bak`，再原子替换（临时文件 + rename）。
 * 只允许 user / project / local —— 默认规则随包发布，不能从面板改。
 *
 * 写盘是**整层重写**（只写 version/name/extends/rules/semantic，其中 extends 只保留 false/'none'），
 * 所以 `extends` 走 fail closed：
 * - 入参 `extends: false | 'none'`：允许，原样写回（写回后仍是「替换」语义）；
 * - 入参 `extends: true | 'default' | '<路径>' | {…}`：抛错（含配置路径与解决方式）；
 * - 文件里已有这类共享 `extends`：不管入参写什么（包括 `false`）都抛错，绝不静默冲掉基规则；
 * - 文件里已有 `false | 'none'` 而入参没写：原样保留，避免「替换」悄悄退化成「合并」。
 *
 * 并发（C1）：整段「读旧文件 → 校验 → 备份 → 临时写入 → rename」在同一路径的跨进程写锁内串行，
 * 两个写者不会拿着旧快照互相覆盖；拿不到锁显式失败（`code: 'gate_lock_timeout'`），**不**退回无锁写。
 * Windows 上目标文件被占用时 rename 会 EPERM / EBUSY：`renameAttempts` 次有界退避重试，
 * 最终失败保留原文件、清理临时文件。
 * 接管 stale 锁的段由守护锁串行、搬走后核对 token 并还原（C2），写盘前还会再确认一次锁仍是自己的：
 * 锁被接管过就抛 `code: 'gate_lock_lost'`，绝不覆盖别人的写盘；释放同样在守护区里先核对 token
 * 再从原位删（C3），token 不匹配就一个字节都不碰。
 *
 * @returns {{ path: string, config: object, lock: { path: string, waitedMs: number, broken: Array<object> } }}
 * `lock.broken` 是本次接管过的 stale 锁证据（年龄 + 所有者），没有接管就是空数组。
 */
export function writeGateConfig(scope, config, {
  repo = process.cwd(),
  home = homedir(),
  env = process.env,
  lockTimeoutMs = DEFAULT_GATE_LOCK_TIMEOUT_MS,
  lockPollMs = DEFAULT_GATE_LOCK_POLL_MS,
  lockStaleMs = DEFAULT_GATE_LOCK_STALE_MS,
  lockGuardStaleMs = DEFAULT_GATE_GUARD_STALE_MS,
  renameAttempts = DEFAULT_GATE_RENAME_ATTEMPTS,
  renameBackoffMs = DEFAULT_GATE_RENAME_BACKOFF_MS,
  // 测试注入点：Windows 上真实的 EPERM 无法稳定制造，用替身证明退避重试与失败清理。
  rename = renameSync,
  sleep = sleepSync,
} = {}) {
  if (scope !== 'user' && scope !== 'project' && scope !== 'local') {
    throw new Error('scope 只能是 user / project / local')
  }
  const path = configPathFor(scope, { repo, home, env })
  mkdirSync(dirname(path), { recursive: true })
  const lock = acquireGateConfigLock(path, {
    timeoutMs: lockTimeoutMs,
    pollMs: lockPollMs,
    staleMs: lockStaleMs,
    guardStaleMs: lockGuardStaleMs,
    sleep,
  })
  try {
    const input = config && typeof config === 'object' && !Array.isArray(config) ? config : {}
    // 1) 调用方传入的 extends：能原样保留的写回，其余显式报错。
    const incoming = hasOwn(input, 'extends') ? classifyExtends(input.extends) : EXTENDS_ABSENT
    if (incoming === EXTENDS_SHARED || incoming === EXTENDS_INVALID) {
      throw extendsWriteError('incoming', path, input.extends)
    }
    // 2) 磁盘上已有的 extends：整层重写会把它冲掉，同样不能无提示改写。
    const existing = existingExtends(path)
    if (existing.kind === EXTENDS_SHARED || existing.kind === EXTENDS_INVALID) {
      throw extendsWriteError('existing', path, existing.value)
    }
    // 3) 可安全保留的值：入参优先；入参没写就用文件里已有的（否则等于悄悄改了语义）。
    const keepExtends = incoming === EXTENDS_KEEP
      ? { value: input.extends }
      : existing.kind === EXTENDS_KEEP
        ? { value: existing.value }
        : null
    const checked = validateConfig(config)
    if (!checked.ok) throw new Error(checked.error)
    const normalized = checked.config
    // 明确的字段顺序：extends 跟在 name 后面，读文件的人一眼能看到这一层挂在哪。
    const output = {
      version: normalized.version,
      name: normalized.name,
      ...(keepExtends ? { extends: keepExtends.value } : {}),
      rules: normalized.rules,
      semantic: normalized.semantic,
    }
    const tmp = path + '.tmp-' + process.pid + '-' + Date.now()
    try {
      // C2：写盘前再确认锁还在自己手里。锁被判定 stale 接管过时，宁可失败也不覆盖别人的写盘。
      lock.assertOwner()
      if (existsSync(path)) copyFileSync(path, path + '.bak')
      writeFileSync(tmp, JSON.stringify(output, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 })
      renameWithRetry(tmp, path, { attempts: renameAttempts, backoffMs: renameBackoffMs, rename, sleep })
    } catch (error) {
      try {
        if (existsSync(tmp)) unlinkSync(tmp)
      } catch {
        // 清理失败不覆盖原始错误
      }
      throw error
    }
    return { path, config: output, lock: { path: lock.path, waitedMs: lock.waitedMs, broken: lock.broken } }
  } finally {
    lock.release()
  }
}

/**
 * 稳定 GateProvider 接口（主插件优先 `ctx.get('gate')`，缺失时回退到这里）。
 *
 * ```js
 * const gate = createGate()
 * const result = await gate.check({ trigger: 'issue.reply', text, current, repo })
 * if (!result.ok) return
 * ```
 *
 * 语义复审默认跟随配置（`semantic.enabled`），且只对 merge / release 生效；
 * 确定性门禁先跑，硬门禁已经不过时不再请求模型。
 */
export function createGate({
  id = 'dsh-gate',
  version = PACKAGE_VERSION,
  repo,
  config,
  semantic = true,
  semanticOptions = {},
  ...loadOptions
} = {}) {
  return {
    id,
    version,
    async check(input = {}) {
      const trigger = input.trigger === undefined ? 'issue.reply' : input.trigger
      assertTrigger(trigger)
      const text = String(input.text ?? '')
      const current = input.current
      const loaded = config !== undefined
        ? { config: normalizeConfig(config), sources: [], errors: [] }
        : loadGateConfig({ ...loadOptions, repo: input.repo || repo || process.cwd() })
      const deterministic = lintText(text, loaded.config, { trigger, current })
      const hits = [...deterministic.hits]
      let semanticResult = { skipped: true }
      const semanticEnabled = Boolean(loaded.config.semantic && loaded.config.semantic.enabled === true)
      if (semantic !== false && semanticEnabled && SEMANTIC_TRIGGER_SET.has(trigger)) {
        if (!deterministic.ok) {
          // 先确定性、后语义：硬门禁已经不过，就不再请求模型（省一次调用，也不把正文发出去）。
          semanticResult = { skipped: true, reason: '硬门禁未通过，未请求模型' }
        } else {
          semanticResult = await semanticReview(text, loaded.config, { trigger, current, ...semanticOptions })
          hits.push(...(semanticResult.hits || []))
        }
      }
      return {
        ok: hits.every((hit) => hit.severity !== 'error'),
        hits,
        semantic: semanticResult,
      }
    },
  }
}
