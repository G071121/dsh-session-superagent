// 把「主理鱼」面板渲染成静态 HTML，用于在真浏览器里看布局（不需要宿主、不需要 React）。
//
// 为什么：client.js 是给宿主用的模块（`window.__ModuleLoader__.load` + `require('react')`），
// 组件树用 h() 构造。这里提供一个极简的假 React，把组件渲染成虚拟节点树，
// 再序列化成 HTML，并内联移植来的官方 CSS —— 于是可以在浏览器里真实地看布局。
//
// 用法： node scripts/render-preview.mjs [输出文件]
//   node scripts/render-preview.mjs preview-panel.html
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const OUT = process.argv[2] || join(ROOT, 'preview-panel.html')

// ── 假 React：只需要 createElement/useState/useEffect/useCallback/useRef/memo/Fragment ──
let hookQueue = []
let hookIndex = 0
const React = {
  Fragment: Symbol('Fragment'),
  createElement(type, props, ...children) {
    return { type, props: { ...(props || {}), children: children.flat(Infinity).filter((c) => c !== null && c !== undefined && c !== false) } }
  },
  memo: (fn) => fn,
  useState(init) {
    const value = hookIndex < hookQueue.length ? hookQueue[hookIndex] : (typeof init === 'function' ? init() : init)
    hookIndex += 1
    return [value, () => {}]
  },
  useEffect() {},
  useCallback: (fn) => fn,
  useRef: (value) => ({ current: value }),
}

// 假宿主：只收集注册，不真的挂任何东西
const registrations = []
const sandbox = {
  window: {
    __ModuleLoader__: { load: (mod) => registrations.push(mod) },
    innerWidth: 1280, innerHeight: 900,
    addEventListener() {}, removeEventListener() {},
  },
  document: {
    getElementById: () => null,
    createElement: () => ({ id: '', textContent: '' }),
    head: { appendChild() {} },
    addEventListener() {}, removeEventListener() {},
  },
  fetch: () => Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve('{}') }),
  // 页签名称的本地覆盖：预览要展示「已保存」的样子（输入框里的名字 = 生效的名字），
  // 所以像真机一样从 localStorage 读，而不是往组件里塞一个假的脏草稿。
  localStorage: {
    getItem: (key) => (key === 'dsh-session-superagent.tab-name' ? '夜猫' : null),
    setItem: () => {},
    removeItem: () => {},
  },
  setInterval: () => 0, clearInterval: () => {}, setTimeout: () => 0, clearTimeout: () => {},
  console,
}
vm.createContext(sandbox)
vm.runInContext(readFileSync(join(ROOT, 'client.js'), 'utf8'), sandbox)

const mod = registrations[0]
if (!mod) throw new Error('client.js 没有注册任何模块')
const slots = new Map()
const ctx = {
  slots: {
    inject: (_name, fn) => fn(),
    register: (opts, Component) => { slots.set(opts.id, Component); return () => {} },
  },
  effect: (fn) => fn(),
}
mod.factory((name) => {
  if (name === 'react') return React
  throw new Error('unexpected require: ' + name)
}).apply(ctx)

const Desk = slots.get('session-superagent-desk')
const Orbit = slots.get('session-superagent-orbit')
if (!Desk) throw new Error('没有注册 session-superagent-desk，已注册：' + [...slots.keys()].join(','))

// ── 样本快照：覆盖各种状态（正常/暂停/异常/仅观察/隔离/退避/过滤记录/历史）──
const now = Date.now()
const iso = (ms) => new Date(now - ms).toISOString()
const snapshot = {
  loading: false, error: null,
  body: {
    sessionTitle: 'README 收尾与发布',
    sessionGoal: null,
    // 诊断页要用：分诊信号（事实/判断 + 权重 + 是否默认开）
    triageSignals: [
      { key: 'reopened', label: '被重新打开', kind: 'fact', weight: 100, default: true, why: 'state_reason=reopened' },
      { key: 'comments', label: '有人评论', kind: 'fact', weight: 10, default: true, why: '在等回应' },
      { key: 'labels', label: '带标签', kind: 'fact', weight: 5, default: true, why: '命中过某个分类' },
      { key: 'unassigned', label: '无人认领', kind: 'judgment', weight: 3, default: false, why: '团队经验，无官方依据' },
      { key: 'stale', label: '长期没动静', kind: 'fact', weight: 2, default: false, why: 'open 且超过 30 天没更新' },
    ],
    serverVersion: '0.9.140',
    runningVersion: '0.9.140',
    installedVersion: '0.9.140',
    routeBase: '/session-superagent',
    defaults: { sessionMaxWakes: 12, maxWakesPerHour: 6, isolateKeepDays: 3 },
    // issue #11：品牌与两家默认 ack 标签（client.js 从 /state 顶层读）
    brandName: '主理鱼',
    defaultAckLabels: { github: '主理鱼:已处理', gitee: '主理鱼-已处理' },
    retryPolicy: { budgetAttempts: 6, slowCapMinutes: 120 },
    sessionUsage: { used: 3, cap: 12, capped: 0 },
    tokenScopes: { ok: true, scopes: ['repo', 'read:org'] },
    isolation: { roots: [{ root: 'E:/temp/iso', count: 2, bytes: 262144 }], totalBytes: 262144 },
    error: null,
    gh: { ok: true, version: 'gh version 2.101.0' },
    credentials: { token: 'configured', sshKeyPath: 'none' },
    watchers: [
      {
        id: 'MYCF711/dsh-session-superagent#s1', repo: 'MYCF711/dsh-session-superagent', sessionId: 's1',
        intervalSec: 60, enabled: true, observe: false, title: 'README 收尾与发布', note: '把 0.8.x 的文档补齐',
        lastPoll: iso(15000), lastWake: iso(300000), lastWakeCount: 3, lastAbsorbed: 1,
        filters: { labels: ['ai-fix'], ignoreLabels: [], skipBots: true, skipDrafts: true, skipClosed: true, onlyAssigned: false, assignee: null },
        activeHours: '09:00-23:00', isolated: true, workdir: 'E:/temp/iso', lastWorktree: 'E:/temp/iso/.dsh-zhuli/a-b',
        history: [
          { at: iso(300000), numbers: [12], ok: true, reason: null },
          { at: iso(600000), numbers: [11], ok: false, reason: 'observe' },
          // 跨天：用来验「今天 / 昨天 / 具体日期」分组
          { at: iso(26 * 3600000), numbers: [10], ok: true, reason: null },
          { at: iso(50 * 3600000), numbers: [9], ok: false, reason: 'cap-session' },
        ],
        filteredLog: [{ number: 7, title: '机器人提的依赖升级', reason: '机器人', at: iso(120000) }],
      },
      {
        id: 'MYCF711/dsh-GOkifu-compact#s2', repo: 'MYCF711/dsh-GOkifu-compact', sessionId: 's2',
        intervalSec: 120, enabled: false, observe: true, title: '联调会话',
        lastPoll: iso(900000), lastDeferred: '仅观察：本轮本会唤醒 2 条（#4 #3）',
        filters: { labels: [], ignoreLabels: [], skipBots: true, skipDrafts: true, skipClosed: true, onlyAssigned: false, assignee: null },
        history: [], filteredLog: [],
      },
      {
        id: 'a/b#s3', repo: 'someone/broken-repo', sessionId: 's3', intervalSec: 30, enabled: true,
        title: '出错示例', lastPoll: iso(5000), lastError: 'gh: Not Found (HTTP 404)（仓库不存在或没权限：检查 owner/name）',
        consecutiveFailures: 2, nextAt: new Date(now + 180000).toISOString(),
        filters: { labels: [], ignoreLabels: [], skipBots: true, skipDrafts: true, skipClosed: true, onlyAssigned: false, assignee: null },
        history: [], filteredLog: [],
      },
    ],
  },
}

// ── 渲染：把元素树序列化成 HTML ───────────────────────────────────────────────
function escapeHtml(text) {
  return String(text).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]))
}
function styleToCss(style) {
  if (!style) return ''
  return Object.entries(style).map(([k, v]) => {
    const prop = k.startsWith('--') ? k : k.replace(/[A-Z]/g, (m) => '-' + m.toLowerCase())
    return prop + ':' + v
  }).join(';')
}
function attr(name, value) {
  // aria-* / data-* 是**枚举属性**：React 真机渲染成 aria-selected="true"，
  // 而 CSS 写的是 [aria-selected='true']。以前 value===true 渲染成裸属性，
  // 于是所有「选中态」样式在预览里从不生效 —— 之前每一份深色出图都带着这个失真（T11 发现）。
  if (value === true && /^(aria-|data-)/.test(name)) return ` ${name}="true"`
  if (value === undefined || value === null || value === false || value === true) {
    return value === true ? ' ' + name : ''
  }
  return ' ' + name + '="' + escapeHtml(value) + '"'
}
function render(node) {
  if (node === null || node === undefined || node === false) return ''
  if (typeof node === 'string' || typeof node === 'number') return escapeHtml(node)
  if (Array.isArray(node)) return node.map(render).join('')
  if (typeof node !== 'object') return ''
  const { type, props = {} } = node
  if (typeof type === 'function') return render(type(props))
  if (type === React.Fragment) return (props.children || []).map(render).join('')
  const voidTags = new Set(['input', 'img', 'br', 'hr', 'meta', 'link'])
  const tag = String(type)
  const parts = []
  if (props.className) parts.push(attr('class', props.className))
  if (props.style) parts.push(attr('style', styleToCss(props.style)))
  // svg 的 width/height/viewBox 必须在白名单里：否则图标拿不到尺寸，量出来的按钮高 28px、内容 89px
  // （T2 出图时发现的工装缺陷 —— 面板没问题，是预览工具把它画坏了）
  for (const key of ['data-tone', 'data-state', 'data-open', 'data-stage', 'role', 'title', 'aria-label', 'aria-current', 'aria-selected', 'aria-pressed', 'aria-expanded', 'aria-checked', 'aria-modal', 'aria-hidden', 'type', 'placeholder', 'value', 'disabled', 'width', 'height', 'viewBox', 'fill', 'stroke', 'strokeWidth', 'strokeLinecap', 'strokeLinejoin', 'd', 'x', 'y', 'rx', 'ry', 'cx', 'cy', 'r', 'points', 'transform', 'xmlns']) {
    if (props[key] !== undefined && props[key] !== false) parts.push(attr(key, props[key]))
  }
  if (keyIsVoid(tag)) return '<' + tag + parts.join('') + '>'
  return '<' + tag + parts.join('') + '>' + (props.children || []).map(render).join('') + '</' + tag + '>'
}
function keyIsVoid(tag) {
  return ['input', 'img', 'br', 'hr', 'meta', 'link'].includes(tag)
}

// 取移植来的 CSS
const clientSrc = readFileSync(join(ROOT, 'client.js'), 'utf8')
const marker = 'const PORTED_CSS = "'
const head = clientSrc.indexOf(marker) + marker.length
let i = head
while (i < clientSrc.length && clientSrc[i] !== '"') i += clientSrc[i] === '\\' ? 2 : 1
const PORTED_CSS = JSON.parse('"' + clientSrc.slice(head, i) + '"')

// 弹层样式是另一段常量（DOCK_CSS），预览也要带进来，否则弹层是"没上色"的假象
const dockMarker = 'const DOCK_CSS = `'
const dockHead = clientSrc.indexOf(dockMarker) + dockMarker.length
const dockTail = clientSrc.indexOf('`', dockHead)
const DOCK_CSS = clientSrc.slice(dockHead, dockTail)

// ── 非正常态快照：空态 / 错误态 / 暂停态 ─────────────────────────────────────
// 上面的 snapshot 是「正常态」（有守、有数据、无错误）。空态和错误态以前从来没有出过图 ——
// 「一条守都没有时面板长什么样」「守失败时红字长什么样」谁也没见过。这里单独造三份：
// 字段与真机 /state 返回同形，只改各自状态关心的那几个键，其余共用一个基座，避免三份快照漂移。
const baseBody = (over = {}) => ({
  sessionTitle: '新会话',
  sessionGoal: null,
  serverVersion: '0.9.183',
  runningVersion: '0.9.183',
  installedVersion: '0.9.183',
  routeBase: '/session-superagent',
  defaults: { sessionMaxWakes: 12, maxWakesPerHour: 6, isolateKeepDays: 3 },
  retryPolicy: { budgetAttempts: 6, slowCapMinutes: 120 },
  sessionUsage: { used: 0, cap: 12, capped: 0 },
  tokenScopes: { ok: true, scopes: ['repo', 'read:org'] },
  isolation: { roots: [], totalBytes: 0 },
  gh: { ok: true, version: 'gh version 2.101.0' },
  credentials: { token: 'none', sshKeyPath: 'none' },
  watchers: [],
  ...over,
})
const baseWatcher = (over = {}) => ({
  id: 'MYCF711/dsh-session-superagent#s1',
  repo: 'MYCF711/dsh-session-superagent',
  sessionId: 'session-1e82afca-8be2-42f9-8186-2bd274e30342',
  intervalSec: 60,
  enabled: true,
  observe: false,
  title: 'README 收尾与发布',
  lastPoll: iso(5000),
  lastWake: iso(1800000),
  filters: { labels: [], ignoreLabels: [], skipBots: true, skipDrafts: true, skipClosed: true, onlyAssigned: false, assignee: null },
  history: [],
  filteredLog: [],
  ...over,
})

/** 空态：一条守都没有。面板该给出「下一步做什么」，而不是一片空白。 */
const emptySnapshot = { loading: false, error: null, body: baseBody() }

/** 错误态：凭证失效（401）+ 连续失败 7 次 + 需要重新登录。看红字与「需要你做什么」。 */
const errorSnapshot = {
  loading: false, error: null,
  body: baseBody({
    sessionTitle: '发布 0.9.184',
    watchers: [baseWatcher({
      title: '发布 0.9.184',
      lastPoll: iso(28 * 60000),
      lastWake: iso(3 * 3600000),
      lastError: 'GitHub API 请求: 401 Unauthorized（gh 登录失效：跑 gh auth login，或在面板填 token）',
      lastErrorKind: 'auth',
      lastErrorAt: iso(28 * 60000),
      consecutiveFailures: 7,
      nextAt: new Date(now + 2 * 3600000).toISOString(),
      needsReauth: true,
      history: [{ at: iso(3 * 3600000), numbers: [42], ok: true, reason: null }],
    })],
  }),
}

/** 暂停态：enabled=false + 时段外暂停（lastDeferred 有值）。看暂停原因是否一眼可读。 */
const pausedSnapshot = {
  loading: false, error: null,
  body: baseBody({
    sessionTitle: '联调会话',
    credentials: { token: 'configured', sshKeyPath: 'none' },
    watchers: [baseWatcher({
      repo: 'MYCF711/dsh-GOkifu-compact',
      title: '联调会话',
      enabled: false,
      lastPoll: iso(10 * 60000),
      lastWake: iso(2 * 3600000),
      activeHours: '09:00-23:00',
      lastDeferred: '不在活跃时段（09:00-23:00 之外）：只攒条目，不唤醒',
      deferReason: 'active-hours',
    })],
  }),
}

// hook 槽顺序必须与 client.js 里 ZhuliPanel 的 useState 顺序完全一致：
// snap, tab, notice, form, token, goalDraft, goalTouched, [], editing, draft, search,
// glossary, update, checking, settingsSection
const blankForm = { repo: '', intervalSec: '60', goal: '', labels: '', onlyAssigned: false, activeHours: '', isolated: false, workdir: '' }
const editKey = 'MYCF711/dsh-session-superagent#s1'
const editDraft = {
  intervalSec: '60', labels: 'ai-fix', ignoreLabels: '', assignee: '', activeHours: '09:00-23:00',
  goal: '把 0.8.x 的文档补齐', ackLabel: '主理鱼:已处理', onlyAssigned: false, allowAuthors: '',
  observe: false, isolated: true, workdir: 'E:/temp/iso', batchLimit: '', maxWakesPerHour: '',
  sessionMaxWakes: '', isolateKeepDays: '', maxIsolated: '', priorityReopened: true,
  priorityComments: true, priorityLabels: true, priorityUnassigned: false, priorityStale: false,
}
const editingHooks = (dirty = false) => {
  const hooks = deskHooks({})
  hooks[8] = editKey
  hooks[9] = { ...editDraft, goal: dirty ? '修改后的目标' : editDraft.goal }
  return hooks
}
const deskHooks = ({ snap = snapshot, tab = 'overview', notice = null, glossary = false, update = null, settingsSection = 'source', tabName = '主理鱼' } = {}) => [
  snap, tab, notice, blankForm, '', '', false, [], null, {}, '', glossary, update, false, settingsSection, null, null, false, null, '', '', null, null,  // 末尾：ghDir / giteeToken / traceResult / updateResult / tabName
  tabName,
]

const ONLY_NAME = (process.argv.find((a) => a.startsWith('--only=')) || '').slice('--only='.length)

const scenarios = [
  { name: '总览', hooks: deskHooks({}) },
  { name: '行内编辑', hooks: editingHooks(false) },
  { name: '行内编辑（已修改）', hooks: editingHooks(true) },
  { name: '判定', hooks: deskHooks({ tab: 'judge' }) },
  { name: '触发', hooks: deskHooks({ tab: 'trigger' }) },
  // 页签名称：这一帧展示「已保存」的样子（输入框里就是生效中的名字；保存按钮因无改动而禁用、
  // 恢复默认可点）。不注入 toast：成功提示走 useToast 的 toastView 槽，不能拿错误色的 notice 冒充。
  { name: '设置（来源）', hooks: deskHooks({ tab: 'settings', settingsSection: 'source', tabName: '夜猫' }) },
  // 页签名称：改完之后的样子（字段里是自定义名 + 保存成功提示），深浅两套各出一张图
  { name: '设置（凭证）', hooks: deskHooks({ tab: 'settings', settingsSection: 'creds' }) },
  { name: '设置（诊断）', hooks: deskHooks({ tab: 'settings', settingsSection: 'diagnose' }) },
  { name: '设置（版本与更新）', hooks: deskHooks({ tab: 'settings', settingsSection: 'update', update: { current: '0.8.45', latest: '0.9.0', hasUpdate: true, command: 'dsh plugin add dsh-session-superagent@0.9.0' } }) },
  { name: '有新版本横幅', hooks: deskHooks({ update: { current: '0.8.45', latest: '0.9.0', hasUpdate: true } }) },
  { name: 'Toast（保存成功）', hooks: deskHooks({ notice: { id: 't1', text: '已保存：MYCF711/dsh-session-superagent', tone: 'info' } }) },
  { name: 'Toast（错误）', hooks: deskHooks({ notice: { id: 't2', text: '保存失败：gh: Not Found (HTTP 404)', tone: 'error' } }) },
  { name: '术语表', hooks: deskHooks({ glossary: true }) },
  { name: '总览（已按异常筛选）', hooks: [{ loading: false, error: null, body: snapshot.body }, 'overview', null, blankForm, '', '', false, [], null, {}, '', false, null, false, 'source', null, null, false, 'error'] },
  { name: '空态（一条都没有）', hooks: [{ loading: false, error: null, body: { sessionGoal: null, sessionTitle: '新会话', credentials: { token: 'none', sshKeyPath: 'none' }, watchers: [] } }, 'overview', null, blankForm, '', '', false, [], null, {}, '', false, null, false, 'source', null, null] },
  { name: '空态（判定页）', hooks: [{ loading: false, error: null, body: { sessionGoal: null, sessionTitle: '新会话', credentials: {}, watchers: [] } }, 'judge', null, blankForm, '', '', false, [], null, {}, '', false, null, false, 'source', null, null] },
  // 空态 / 错误态 / 暂停态：这三态以前没有出过图，各自出 shot-empty / shot-error / shot-paused
  { name: '空态（无守）', hooks: deskHooks({ snap: emptySnapshot }) },
  { name: '错误态（守失败）', hooks: deskHooks({ snap: errorSnapshot }) },
  { name: '暂停态（已停用）', hooks: deskHooks({ snap: pausedSnapshot }) },
  { name: '读取失败', hooks: [{ loading: false, error: 'Failed to fetch', body: null }, 'overview', null, blankForm, '', '', false, [], null, {}, '', false, null, false, 'source', null, null] },
]

const orbitWatchers = [
  // 第一条带 lastWakeItem：预览图要能看出「最近唤醒的是哪一条」（编号 + 标题 + 时间）
  { repo: 'MYCF711/dsh-go', sessionId: 'session-c0a5847a-d34c-4281-8521-54384849d956', title: '用 Go 实现 DSH 插件化方案', enabled: true, intervalSec: 120, lastPoll: new Date(Date.now() - 83000).toISOString(), lastWake: new Date(Date.now() - 3600000).toISOString(), lastWakeCount: 2, lastWakeItem: { number: '128', title: '插件在 0.2.3 下报 tool already registered', kind: 'issue' }, activeHours: '09:00-23:00', isolated: true, workdir: 'E:/temp/iso' },
  { repo: 'MYCF711/dsh-go', sessionId: 'session-685dfadb-f641-4a4f-95d7-6b659ee238d6', title: '询问当前情况', enabled: false, intervalSec: 120, lastPoll: new Date(Date.now() - 3 * 3600000).toISOString(), activeHours: '09:00-23:00' },
  { repo: 'acme/web', sessionId: 'session-7f7155cf-20f0-4d9a', title: '前端修 bug', enabled: true, intervalSec: 60, lastPoll: new Date(Date.now() - 5000).toISOString(), consecutiveFailures: 2, nextAt: new Date(Date.now() + 45000).toISOString(), lastError: 'GitHub API 请求: 401（gh 登录失效：跑 gh auth login，或在面板填 token）' },
]

const shown = ONLY_NAME ? scenarios.filter((s) => s.name.includes(ONLY_NAME)) : scenarios
const sections = shown.map((scenario) => {
  hookIndex = 0
  const tree = Desk({ sessionId: 'preview-session' })
  return '<h2 class="preview-title">' + scenario.name + '</h2>\n<div class="preview-frame">' + render(tree) + '</div>'
}).join('\n')

// 兜底 token：**必须用真名**（旧版这里写的是 --dsw-alias-border-default / success-500 / accent-primary，
// 宿主机上根本没有这些名字，所以预览一直是"没上色"的假象）。浅色/深色两套，供离线看布局用。
const LIGHT = `--dsw-alias-label-primary:#1f2328;-webkit-...`
const lightTokens = `
  --dsw-alias-label-primary:#1f2328; --dsw-alias-label-primary-foreground:#ffffff;
  --dsw-alias-label-secondary:#59636e; --dsw-alias-label-tertiary:#6e7781;
  --dsw-alias-label-caption:#818b98; --dsw-alias-label-dimmed:#a8b1bb;
  --dsw-alias-bg-base:#ffffff; --dsw-alias-bg-layer-1:#ffffff; --dsw-alias-bg-layer-2:#f6f8fa;
  --dsw-alias-bg-layer-3:#eef1f4; --dsw-alias-bg-module-platform:#f6f8fa; --dsw-alias-bg-mask-1:rgba(31,35,40,.35);
  --dsw-alias-border-l2:#e6eaef; --dsw-alias-border-l3:#d8dee4; --dsw-alias-border-l4:#c6cdd5;
  --dsw-alias-brand-primary:#0969da; --dsw-alias-link:#0969da;
  --dsw-alias-state-success-primary:#1a7f37; --dsw-alias-state-warn-primary:#9a6700;
  --dsw-alias-state-error-primary:#cf222e; --dsw-alias-state-business-primary:#0969da;
  --dsw-alias-state-idle-primary:#8c959f;
  --dsw-alias-button-primary-fill:#1f883d; --dsw-alias-button-primary-hover:#1a7f37;
  --dsw-alias-button-ghost-active-fill:#eef1f4; --dsw-alias-button-ghost-active-border:#d8dee4;
  --dsw-alias-interactive-bg-hover:#f3f4f6; --dsw-alias-interactive-bg-active:#eceff2;
  --dsw-alias-toast-bg:#24292f; --dsw-alias-tooltip-bg:#24292f;
  --dsw-elevation-soft:0 1px 3px rgba(31,35,40,.08); --dsw-elevation-prominent:0 8px 24px rgba(31,35,40,.14);
  --dsw-shadow-lv3:0 8px 24px rgba(31,35,40,.14); --dsw-static-neutral-bluish-00:#ffffff;
`
const darkTokens = `
  --dsw-alias-label-primary:#e6edf3; --dsw-alias-label-primary-foreground:#0d1117;
  --dsw-alias-label-secondary:#a9b4bf; --dsw-alias-label-tertiary:#8b949e;
  --dsw-alias-label-caption:#7d8590; --dsw-alias-label-dimmed:#6e7681;
  --dsw-alias-bg-base:#0d1117; --dsw-alias-bg-layer-1:#141a21; --dsw-alias-bg-layer-2:#161b22;
  --dsw-alias-bg-layer-3:#1c232c; --dsw-alias-bg-module-platform:#161b22; --dsw-alias-bg-mask-1:rgba(1,4,9,.6);
  --dsw-alias-border-l2:#21262d; --dsw-alias-border-l3:#30363d; --dsw-alias-border-l4:#3d444d;
  --dsw-alias-brand-primary:#4493f8; --dsw-alias-link:#4493f8;
  --dsw-alias-state-success-primary:#3fb950; --dsw-alias-state-warn-primary:#d29922;
  --dsw-alias-state-error-primary:#f85149; --dsw-alias-state-business-primary:#4493f8;
  --dsw-alias-state-idle-primary:#6e7681;
  --dsw-alias-button-primary-fill:#238636; --dsw-alias-button-primary-hover:#2ea043;
  --dsw-alias-button-ghost-active-fill:#21262d; --dsw-alias-button-ghost-active-border:#30363d;
  --dsw-alias-interactive-bg-hover:#1c2128; --dsw-alias-interactive-bg-active:#22272e;
  --dsw-alias-toast-bg:#30363d; --dsw-alias-tooltip-bg:#30363d;
  --dsw-elevation-soft:0 1px 3px rgba(1,4,9,.4); --dsw-elevation-prominent:0 8px 24px rgba(1,4,9,.6);
  --dsw-shadow-lv3:0 8px 24px rgba(1,4,9,.6); --dsw-static-neutral-bluish-00:#ffffff;
`

// 两套主题各出一份：左边浅色、右边深色，方便一眼看出「只在某个主题下才错」的地方。
const sectionsForTheme = shown.map((scenario) => {
  hookQueue = scenario.hooks
  hookIndex = 0
  const tree = Desk({ sessionId: 'preview-session' })
  return '<h2 class="preview-title">' + scenario.name + '</h2>' + '<div class="preview-frame">' + render(tree) + '</div>'
}).join('')

const orbitSection = (() => {
  hookQueue = [orbitWatchers, true, { x: 200, y: 400 }]
  hookIndex = 0
  const tree = Orbit()
  return '<h2 class="preview-title">卫星环弹层（点开状态栏圆环后的样子）</h2>'
    + '<div class="preview-popover">' + render(tree) + '<div class="preview-mask">宿主里弹层浮在这层内容之上</div></div>'
})()

const ONLY_POPOVER = process.argv.includes('--popover')
const outArg = process.argv.slice(2).find((a) => !a.startsWith('--') && a.endsWith('.html')) || OUT

const themePopover = (label, tokens) => '<section>'
  + '<h1 class="theme-name">' + label + '</h1>'
  + '<div class="themed" style="' + tokens.split(String.fromCharCode(10)).join(' ') + '">'
  + orbitSection
  + '</div></section>'

const themeBlock = (label, tokens) => '<section>'
  + '<h1 class="theme-name">' + label + '</h1>'
  + '<div class="themed" style="' + tokens.split(String.fromCharCode(10)).join(' ') + '">'
  + (ONLY_NAME ? '' : orbitSection) + sectionsForTheme
  + '</div></section>'



const html = '<!doctype html><meta charset="utf-8"><title>主理鱼面板预览（浅色 / 深色）</title>'
  + '<style>'
  + 'body{font:14px/1.45 -apple-system,"Segoe UI",system-ui,sans-serif;background:#eef1f4;margin:0;padding:24px;color:#1f2328}'
  + '.theme-name{font-size:18px;margin:28px 0 4px}'
  + '.preview-title{margin:20px 0 8px;font-size:15px;opacity:.7;color:inherit}'
  + (process.argv.includes('--mobile') ? '.preview-frame{width:600px !important}' : '')
  + '.preview-frame{width:900px;background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l3);'
  + 'border-radius:12px;min-height:120px;max-height:820px;overflow:auto;color:var(--dsw-alias-label-primary)}'
  + '.dt-page{height:auto!important;max-height:none!important}'
  + '.preview-popover svg{width:20px;height:20px;display:block}'
  + '.preview-popover button{height:20px}'
  + (process.argv.includes('--mobile') ? '.preview-popover{width:360px !important;padding:12px !important}' : '')
  + '.preview-popover .sa-dock-row{background:var(--dsw-alias-bg-layer-2)}'
  + '.preview-popover .sa-dock-row + .sa-dock-row{border-top:0.5px solid var(--dsw-alias-border-l2)}'
  + '.preview-mask{position:absolute;inset:0;background:rgba(128,128,128,.35);border-radius:12px;display:flex;align-items:center;justify-content:center;color:#fff;font:12px system-ui}'
  + '.preview-popover{position:relative;width:400px;margin:8px 0 4px;padding:24px;background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l3);border-radius:12px}'
  + '.preview-popover .sa-dock-panel{position:static!important;left:auto!important;bottom:auto!important;width:368px!important}'
  + DOCK_CSS
  + PORTED_CSS
  + '* { outline: 0; }'
  + (process.argv.includes('--outline') ? '.dt-page > * { outline: 1px dashed #f0f !important; }' : '')
  + '</style>'
  + (process.argv.includes('--measure') ? '<script>window.addEventListener("load", function () { var body = document.querySelectorAll(".dt-ticket-body")[0]; var rows = []; rows.push("body h" + Math.round(body.getBoundingClientRect().height)); Array.prototype.forEach.call(body.children, function (el) { var r = el.getBoundingClientRect(); rows.push((el.className.split(" ")[0] || el.tagName) + " h" + Math.round(r.height) + " " + (el.textContent || "").slice(0, 14)); }); var pre = document.createElement("pre"); pre.id = "measure"; pre.textContent = rows.join(" | "); document.body.insertBefore(pre, document.body.firstChild); });</script>' : '')
  + '<div style="font:13px/1.5 system-ui;opacity:.75">主理鱼面板静态预览 —— 真实 client.js 渲染的 DOM + 移植的官方 CSS。'
  + '兜底色值只是近似（真机以宿主注入的 --dsw-alias-* 为准），这里用来发现「某个主题下颜色写死或漏 token」。</div>'
  + (ONLY_POPOVER
    ? (process.argv.includes('--dark') ? themePopover('深色主题', darkTokens) : themePopover('浅色主题', lightTokens) + themePopover('深色主题', darkTokens))
    : (process.argv.includes('--dark') ? themeBlock('深色主题', darkTokens) : themeBlock('浅色主题', lightTokens) + themeBlock('深色主题', darkTokens)))

writeFileSync(outArg, html)
console.log('已写出：' + outArg)
console.log('字节：' + html.length)
