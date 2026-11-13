import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

import { deskQueue, walk, watcher } from './fixtures/panel-harness.mjs'

const SOURCE = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
const PRIMITIVES_MODULE = '@deepseek-ai/dsh-client-ui-primitives'
const HOST = Object.freeze({
  Modal: 'dsh-host-modal',
  Toast: 'dsh-host-toast',
  Button: 'dsh-host-button',
  Input: 'dsh-host-input',
  Switch: 'dsh-host-switch',
  SegmentedTabs: 'dsh-host-segmented-tabs',
  Tag: 'dsh-host-tag',
  StateDot: 'dsh-host-state-dot',
  Pill: 'dsh-host-pill',
  DisclosureRow: 'dsh-host-disclosure-row',
  IconWarningOutlineMedium: 'dsh-host-warning-icon',
})
const MAIN_TABS = Object.freeze([
  ['overview', '总览'],
  ['judge', '判定'],
  ['trigger', '触发'],
  ['settings', '设置'],
])
const UPDATE = Object.freeze({
  current: '0.9.270',
  latest: '0.9.271',
  hasUpdate: true,
  command: 'dsh plugin --profile <你的 profile> add dsh-session-superagent@0.9.271',
})
const RECEIPT = Object.freeze({
  installedVersion: '0.9.271',
  runningVersion: '0.9.270',
  needsReload: true,
})
const UNKNOWN_HINT = '请求结果未知，请先重新检查 installed/running，再手动确认'
const UNKNOWN_RECEIPT = Object.freeze({
  installedVersion: '未知',
  runningVersion: '未知',
  needsReload: null,
  resultUnknown: true,
})

function response(body, ok = true, status = 200) {
  return { ok, status, headers: { get: () => null }, json: async () => body, text: async () => JSON.stringify(body) }
}

// 执行真实 UMD，同时注入可辨识的宿主原语；state setter 会记录并保存最新值。
function loadClient(options = {}) {
  let mod = null
  const timers = []
  const stateCalls = []
  const effects = []
  const hooks = { queue: [], index: 0 }
  const sandbox = {
    window: {
      __ModuleLoader__: { load(value) { mod = value } },
      innerWidth: 1440,
      innerHeight: 900,
      addEventListener() {},
      removeEventListener() {},
    },
    document: {
      getElementById: () => null,
      createElement: () => ({ id: '', textContent: '' }),
      head: { appendChild() {} },
      addEventListener() {},
      removeEventListener() {},
    },
    navigator: { clipboard: { writeText: options.writeText || (async () => {}) } },
    fetch: options.fetch || (async () => response({ watchers: [] })),
    setInterval: () => 0,
    clearInterval() {},
    setTimeout: (fn, ms) => {
      const id = timers.length + 1
      timers.push({ id, fn, ms })
      return id
    },
    clearTimeout: (id) => {
      const index = timers.findIndex((timer) => timer.id === id)
      if (index >= 0) timers.splice(index, 1)
    },
    queueMicrotask: (fn) => fn(),
    console,
  }
  vm.createContext(sandbox)
  // 只在定向测试显式要求时暴露真实共享控件；生产文件与分支逻辑不变，仅追加测试捕获点。
  let source = SOURCE
  if (options.captureBtn) {
    source = source.replace('    const UpdateButton = hostButton || Btn', '    window.__BtnForTest = Btn\n    const UpdateButton = hostButton || Btn')
    assert.notEqual(source, SOURCE, '必须捕获真实 Btn，不能测试手写复制品')
  }
  if (options.captureInput) {
    const before = source
    source = source.replace('    function Toggle({', '    window.__InputForTest = Input\n    function Toggle({')
    assert.notEqual(source, before, '必须捕获真实 Input，不能测试手写复制品')
  }
  if (options.captureToggle) {
    const before = source
    source = source.replace('    function StateDot({', '    window.__ToggleForTest = Toggle\n    function StateDot({')
    assert.notEqual(source, before, '必须捕获真实 Toggle，不能测试手写复制品')
  }
  if (options.captureTag) {
    const before = source
    source = source.replace('    function Tag({', '    window.__TagForTest = Tag\n    function Tag({')
    assert.notEqual(source, before, '必须捕获真实 Tag，不能测试手写复制品')
  }
  if (options.captureStateDot) {
    const before = source
    source = source.replace('    function StateDot({', '    window.__StateDotForTest = StateDot\n    function StateDot({')
    assert.notEqual(source, before, '必须捕获真实 StateDot，不能测试手写复制品')
  }
  if (options.capturePill) {
    const before = source
    source = source.replace('    /** 官方 SegmentedControl', '    window.__PillForTest = Pill\n    /** 官方 SegmentedControl')
    assert.notEqual(source, before, '必须捕获真实 Pill，不能测试手写复制品')
  }
  if (options.captureCollapsibleList) {
    const before = source
    source = source.replace('    /** DSH Pill', '    window.__CollapsibleListForTest = CollapsibleList\n    /** DSH Pill')
    assert.notEqual(source, before, '必须捕获真实 CollapsibleList，不能测试手写复制品')
  }
  vm.runInContext(source, sandbox)
  assert.ok(mod, 'client.js 必须调用 __ModuleLoader__.load')

  const React = {
    Fragment: Symbol('Fragment'),
    createElement(type, props, ...children) {
      const { key, ref, ...rest } = props || {}
      const node = {
        type,
        props: { ...rest, children: children.flat(Infinity).filter((child) => child !== null && child !== undefined && child !== false) },
      }
      if (key !== undefined) node.key = key
      if (ref !== undefined) node.ref = ref
      return node
    },
    isValidElement: (value) => Boolean(value && typeof value === 'object' && 'type' in value),
    memo: (fn) => fn,
    useState(initial) {
      const index = hooks.index
      const value = index < hooks.queue.length
        ? hooks.queue[index]
        : (typeof initial === 'function' ? initial() : initial)
      hooks.queue[index] = value
      hooks.index += 1
      const setter = (next) => {
        const resolved = typeof next === 'function' ? next(hooks.queue[index]) : next
        hooks.queue[index] = resolved
        stateCalls.push({ index, next: resolved })
      }
      return [value, setter]
    },
    useEffect(create, deps) { effects.push({ create, deps }) },
    useCallback: (fn) => fn,
    useRef: (value) => ({ current: value }),
  }

  const registrations = []
  const ctx = {
    effect: (fn) => fn(),
    slots: {
      inject: (_name, fn) => fn(),
      register(opts, Component) {
        registrations.push({ opts, Component })
        return () => {}
      },
    },
  }
  mod.factory((name) => {
    if (name === 'react') return React
    if (name === PRIMITIVES_MODULE) {
      if (options.primitives === undefined) throw new Error('MODULE_NOT_FOUND: ' + name)
      return options.primitives
    }
    throw new Error('unexpected require: ' + name)
  }).apply(ctx)

  const render = (registration, queue, props = {}) => {
    hooks.queue = [...(queue || [])]
    hooks.index = 0
    const tree = registration.Component(props)
    Object.defineProperty(tree, '__panelVerify', {
      enumerable: false,
      value: () => assert.equal(hooks.queue.length, hooks.index, 'useState 队列必须按位置完整对齐'),
    })
    return tree
  }
  return {
    registrations,
    render,
    timers,
    effects,
    Btn: sandbox.window.__BtnForTest,
    Input: sandbox.window.__InputForTest,
    Toggle: sandbox.window.__ToggleForTest,
    Tag: sandbox.window.__TagForTest,
    StateDot: sandbox.window.__StateDotForTest,
    Pill: sandbox.window.__PillForTest,
    CollapsibleList: sandbox.window.__CollapsibleListForTest,
    stateCalls: () => stateCalls,
    resetStateCalls: () => { stateCalls.length = 0 },
  }
}

function snapshot() {
  return {
    loading: false,
    error: null,
    body: {
      sessionGoal: null,
      sessionTitle: 'update UI',
      credentials: { token: 'configured', sshKeyPath: 'none', ghConfigDir: 'none', giteeToken: 'none' },
      gh: { ok: true, version: '2.0' },
      defaults: {},
      watchers: [],
    },
  }
}

function updateQueue() {
  // 本测试只依赖主面板前 22 个根槽（到 settingsSection 为止）。0.10.13 在末尾追加了
  // 「页签名称草稿」，所以 ConfirmButton 的占位从「updateResult 之后」变成
  // 「updateResult / tabNameDraft 之后」—— 见下面各用例里的 [...base, X, null, open, busy]。
  // 不切分公共 fixture，避免其它任务向共享队列追加占位后改变这里 open/busy 的位置。
  const queue = deskQueue(snapshot(), null, {}, 'settings', '', false, UPDATE).slice(0, 22)
  queue[7] = null
  queue[14] = 'update'
  return queue
}

function deskOf(client) {
  return client.registrations.find((item) => item.opts.id === 'session-superagent-desk')
}

function nodesOf(client, queue, props = {}) {
  return walk(client.render(deskOf(client), queue, props))
}

function nodeText(node) {
  if (node === null || node === undefined || node === false) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(nodeText).join('')
  return nodeText(node.props?.children || [])
}

function textOf(nodes) {
  return nodes.filter((node) => node.type === '#text').map((node) => node.text).join(' | ')
}

function one(items, message) {
  assert.equal(items.length, 1, message + '；实际 ' + items.length)
  return items[0]
}

function controls(nodes, label) {
  return nodes.filter((node) => (node.type === 'button' || node.type === HOST.Button) && nodeText(node) === label)
}

function control(nodes, label) {
  return one(controls(nodes, label), '找不到唯一按钮「' + label + '」')
}

function hostModal(nodes) {
  return one(nodes.filter((node) => node.type === HOST.Modal), '缺唯一 DSH Modal')
}

function localModal(nodes) {
  return one(nodes.filter((node) => node.type === 'div'
    && String(node.props?.className || '').split(/\s+/).includes('dt-modal')), '缺唯一本地 Modal')
}

function hasClass(node, name) {
  return String(node.props?.className || '').split(/\s+/).includes(name)
}

function postsOf(calls) {
  return calls.filter(([, init]) => init?.method === 'POST')
}

function pathnameOf(url) {
  return new URL(String(url), 'http://fixture.local').pathname
}

function isStateUrl(url) {
  return pathnameOf(url).endsWith('/state')
}

function hookIndexes(base) {
  // base 到 settingsSection（index 14）为止；之后依次是 updateResult / tabNameDraft，
  // 再后面才是 ConfirmButton 自己的 open / busy。
  return { result: base.length, open: base.length + 2, busy: base.length + 3 }
}

test('Btn 官方 variant：primary/ghost/outline/toolbar 全部委托，props 原样保留且 link 不自造映射', () => {
  const client = loadClient({ primitives: HOST, captureBtn: true })
  assert.equal(typeof client.Btn, 'function')
  const onClick = () => {}
  const ref = { current: null }
  const icon = { type: 'svg', props: { children: [] } }
  for (const variant of ['primary', 'ghost', 'outline', 'toolbar']) {
    const node = client.Btn({
      variant, size: 'sm', icon, children: '保存 goal',
      className: 'dt-btn-busy dt-danger business', type: 'submit', ref, key: variant + '-save',
      disabled: true, 'aria-label': '保存 goal', 'aria-busy': 'true', onClick,
    })
    assert.equal(node.type, HOST.Button, variant + ' 必须委托 DSH Button')
    assert.equal(node.props.variant, variant)
    assert.equal(node.props.size, 'sm')
    assert.equal(node.props.type, 'submit', variant + '：显式 type=submit 必须覆盖默认 button')
    assert.strictEqual(node.ref, ref, variant + '：DSH forwardRef 的 ref 必须留在 element.ref')
    assert.equal(node.key, variant + '-save')
    assert.equal(node.props.key, undefined, variant + '：key 不能被改写进 props')
    assert.strictEqual(node.props.icon, icon)
    assert.strictEqual(node.props.onClick, onClick)
    assert.equal(node.props.disabled, true)
    assert.equal(node.props['aria-label'], '保存 goal')
    assert.equal(node.props['aria-busy'], 'true')
    assert.equal(node.props.className, 'dt-btn-busy dt-danger business')
    assert.ok(!hasClass(node, 'dt-btn') && !hasClass(node, 'dt-btn-' + variant) && !hasClass(node, 'dt-btn-sm'),
      variant + '：宿主路径不得重新引入旧 variant/size CSS')
    assert.deepEqual(node.props.children, ['保存 goal'], variant + '：icon 交给宿主，不能复刻旧 span 结构')
  }

  const defaults = client.Btn({ children: '默认按钮' })
  assert.equal(defaults.type, HOST.Button)
  assert.equal(defaults.props.variant, 'ghost', '缺省 variant 必须对齐官方 ghost')
  assert.equal(defaults.props.size, 'md', '缺省 size 必须对齐官方 md')
  assert.equal(defaults.props.type, 'button')

  const link = client.Btn({ variant: 'link', size: 'sm', icon, children: '看建议规则', className: 'business' })
  assert.equal(link.type, 'button', '官方没有 link，必须保留旧 DOM 而不是映射成 toolbar/ghost')
  assert.equal(link.props.type, 'button')
  assert.ok(hasClass(link, 'dt-btn') && hasClass(link, 'dt-btn-link') && hasClass(link, 'dt-btn-sm'))
  assert.ok(hasClass(link, 'business'))
  assert.equal(link.props.children[0].props.className, 'dt-btn-icon')
})

test('Btn 全 variant：老宿主缺 Button 或整个 primitives 时完整回退旧 DOM 与 props', () => {
  for (const primitives of [undefined, {}]) {
    const client = loadClient({ primitives, captureBtn: true })
    const onClick = () => {}
    const ref = { current: null }
    const icon = { type: 'svg', props: { children: [] } }
    for (const variant of ['primary', 'ghost', 'outline', 'toolbar', 'link']) {
      const node = client.Btn({
        variant, size: 'sm', icon, children: '确认删除',
        className: 'dt-btn-busy dt-danger', type: 'submit', ref, key: variant + '-confirm',
        disabled: true, 'aria-label': '确认删除', 'aria-busy': 'true', onClick,
      })
      assert.equal(node.type, 'button', variant + '：缺 Button 时必须回退原生 button')
      assert.equal(node.props.type, 'submit')
      assert.strictEqual(node.ref, ref)
      assert.equal(node.key, variant + '-confirm')
      assert.equal(node.props.key, undefined)
      assert.strictEqual(node.props.onClick, onClick)
      assert.equal(node.props.disabled, true)
      assert.equal(node.props['aria-label'], '确认删除')
      assert.equal(node.props['aria-busy'], 'true')
      for (const name of ['dt-btn', 'dt-btn-' + variant, 'dt-btn-sm', 'dt-btn-busy', 'dt-danger']) {
        assert.ok(hasClass(node, name), variant + '：fallback 缺 class：' + name)
      }
      assert.equal(node.props.children[0].props.className, 'dt-btn-icon')
      assert.strictEqual(node.props.children[0].props.children[0], icon)
      assert.equal(node.props.children[1], '确认删除')
    }
  }
})

test('Input 官方委托：password/search/number、受控编辑、icon 与 ref 全部透传且无双 wrapper', () => {
  const client = loadClient({ primitives: HOST, captureInput: true })
  assert.equal(typeof client.Input, 'function')
  const icon = { type: 'svg', props: { children: [] } }
  for (const [type, value] of [['password', 'secret'], ['search', 'alice'], ['number', '60']]) {
    const changes = []
    const onChange = (event) => changes.push(event.target.value)
    const ref = { current: null }
    const numeric = type === 'number' ? { min: 30, max: 3600, step: 1 } : {}
    const node = client.Input({
      type, value, onChange, ...numeric, icon, ref, key: type + '-input', className: 'business',
      placeholder: type + ' 占位', 'aria-label': type + ' 字段', 'aria-describedby': type + '-hint',
      disabled: type === 'password', required: true,
    })
    assert.equal(node.type, HOST.Input, type + ' 必须直接委托 DSH Input')
    assert.equal(node.props.type, type)
    assert.equal(node.props.value, value, type + ' 必须保持受控 value')
    assert.strictEqual(node.props.onChange, onChange)
    assert.equal(node.props.placeholder, type + ' 占位')
    assert.equal(node.props['aria-label'], type + ' 字段')
    assert.equal(node.props['aria-describedby'], type + '-hint')
    assert.equal(node.props.disabled, type === 'password')
    assert.equal(node.props.required, true)
    assert.strictEqual(node.props.icon, icon, 'icon 只能交给官方，不能由适配层再画一次')
    assert.strictEqual(node.ref, ref, 'ref 必须交给官方 forwardRef')
    assert.equal(node.key, type + '-input')
    assert.equal(node.props.className, 'dt-input business', '官方 wrapper 同时保留业务类与现有布局类')
    assert.deepEqual(node.props.children, [], '官方路径不能再包本地 span 或原生 input')
    if (type === 'number') {
      assert.equal(node.props.min, 30)
      assert.equal(node.props.max, 3600)
      assert.equal(node.props.step, 1)
    }
    node.props.onChange({ target: { value: 'next-' + type } })
    assert.deepEqual(changes, ['next-' + type], type + ' 受控 onChange 必须原样可达')
  }
})

test('Input 回退：缺导出或整个 primitives 时保留 span.dt-input、单 icon、原生属性与 ref', () => {
  const scenarios = [undefined, {}, { ...HOST, Input: undefined }]
  const icon = { type: 'svg', props: { children: [] } }
  for (const primitives of scenarios) {
    const client = loadClient({ primitives, captureInput: true })
    for (const [type, value] of [['password', 'secret'], ['search', 'alice'], ['number', '60']]) {
      const onChange = () => {}
      const ref = { current: null }
      const numeric = type === 'number' ? { min: 30, max: 3600, step: 1 } : {}
      const wrapper = client.Input({
        type, value, onChange, ...numeric, icon, ref, key: type + '-fallback', className: 'business',
        placeholder: type + ' 占位', 'aria-label': type + ' 字段', disabled: true, required: true,
      })
      assert.equal(wrapper.type, 'span')
      assert.equal(wrapper.props.className, 'dt-input')
      assert.equal(wrapper.props.children.length, 2, 'fallback 必须是 icon + input 两个子节点')
      const [iconNode, input] = wrapper.props.children
      assert.equal(iconNode.type, 'span')
      assert.equal(iconNode.props.className, 'dt-input-icon')
      assert.strictEqual(iconNode.props.children[0], icon)
      assert.equal(input.type, 'input')
      assert.equal(input.props.type, type)
      assert.equal(input.props.value, value)
      assert.strictEqual(input.props.onChange, onChange)
      assert.equal(input.props.placeholder, type + ' 占位')
      assert.equal(input.props['aria-label'], type + ' 字段')
      assert.equal(input.props.disabled, true)
      assert.equal(input.props.required, true)
      assert.equal(input.props.className, 'business', 'fallback 业务 className 仍按原契约落在 input 上')
      assert.strictEqual(input.ref, ref, 'fallback ref 必须落在真正的 native input 上')
      assert.equal(input.key, type + '-fallback')
      if (type === 'number') {
        assert.equal(input.props.min, 30)
        assert.equal(input.props.max, 3600)
        assert.equal(input.props.step, 1)
      }
    }
    const withoutIcon = client.Input({ value: '', onChange() {} })
    assert.equal(withoutIcon.props.children.length, 1)
    assert.equal(withoutIcon.props.children[0].type, 'input')
  }
})

test('Input 真实调用面：搜索、repo/goal/数字、行内编辑与凭证统一委托，textarea/time 不迁移', () => {
  const client = loadClient({ primitives: HOST })
  const empty = snapshot()

  const searchQueue = deskQueue(empty, null, {}, 'overview', 'alice')
  const searchNodes = nodesOf(client, searchQueue)
  const search = one(searchNodes.filter((node) => node.type === HOST.Input), '总览缺唯一官方搜索 Input')
  assert.equal(search.props.value, 'alice')
  assert.equal(search.props.placeholder, '搜索仓库 / 编号 / 标题')
  assert.equal(search.props['aria-label'], '搜索')
  assert.ok(hasClass(search, 'dt-input'), '搜索布局仍靠 wrapper.dt-input 命中')
  client.resetStateCalls()
  search.props.onChange({ target: { value: 'bob' } })
  assert.deepEqual(client.stateCalls().filter((call) => call.index === 10).map((call) => call.next), ['bob'])

  const createQueue = deskQueue(empty, null, {}, 'trigger')
  createQueue[3] = { ...createQueue[3], repo: 'acme/widgets', goal: '修复 issue', intervalSec: '90' }
  const createNodes = nodesOf(client, createQueue, { sessionId: 's1' })
  const createInputs = createNodes.filter((node) => node.type === HOST.Input)
  const repo = one(createInputs.filter((node) => node.props.value === 'acme/widgets'), '新增表单缺 repo Input')
  const goal = one(createInputs.filter((node) => node.props.value === '修复 issue'), '新增表单缺 goal Input')
  const interval = one(createInputs.filter((node) => node.props.value === '90'), '新增表单缺 interval Input')
  assert.equal(repo.props.required, true)
  assert.equal(repo.props.disabled, false)
  assert.equal(repo.props.placeholder, 'owner/name，或 gitee:owner/name')
  assert.equal(goal.props.type, 'text')
  assert.equal(interval.props.type, 'number')
  assert.equal(interval.props.min, 30)
  assert.equal(interval.props.max, 3600)
  assert.equal(interval.props.step, 1)
  assert.equal(interval.props.required, true)
  assert.equal(interval.props.disabled, false)
  assert.equal(createNodes.filter((node) => node.type === 'input' && node.props.type === 'time').length, 2,
    'HoursField 的两个 time input 不属于共享 Input，必须保持原实现')
  assert.equal(createNodes.filter((node) => node.type === 'input'
    && ['text', 'password', 'search', 'number'].includes(node.props.type)).length, 0,
  '官方宿主路径不能再出现共享 Input 的本地 native input')

  const editState = snapshot()
  editState.body.watchers = [watcher('a/b', { id: 'a/b#s1', sessionId: 's1' })]
  const editQueue = deskQueue(editState, 'a/b#s1', { intervalSec: '120' })
  const editNodes = nodesOf(client, editQueue)
  const editInterval = one(editNodes.filter((node) => node.type === HOST.Input
    && node.props.type === 'number' && node.props.value === '120'), '行内编辑缺受控数字 Input')
  assert.equal(editInterval.props.min, 30)
  assert.equal(editInterval.props.max, 3600)
  assert.equal(typeof editInterval.props.onChange, 'function')

  const credsQueue = deskQueue(empty, null, {}, 'settings')
  credsQueue[14] = 'creds'
  credsQueue[4] = 'github-secret'
  credsQueue[19] = 'D:/gh-config'
  credsQueue[20] = 'gitee-secret'
  const credsNodes = nodesOf(client, credsQueue)
  const credsInputs = credsNodes.filter((node) => node.type === HOST.Input && node.props['aria-label'] !== '搜索')
  assert.equal(credsInputs.length, 3, '除顶部搜索外，Token/Gitee/ghDir 三个字段必须全部委托')
  for (const value of ['github-secret', 'gitee-secret']) {
    const password = one(credsInputs.filter((node) => node.props.value === value), '缺密码 Input ' + value)
    assert.equal(password.props.type, 'password')
    assert.equal(typeof password.props.onChange, 'function')
  }
  const ghDir = one(credsInputs.filter((node) => node.props.value === 'D:/gh-config'), '缺 ghDir Input')
  assert.equal(ghDir.props.placeholder, '绝对路径（留空 = 用宿主账号）')
  assert.equal(typeof ghDir.props.onChange, 'function')

  const goalQueue = deskQueue(empty, null, {}, 'settings')
  goalQueue[14] = 'goal'
  goalQueue[5] = '会话 goal 原文'
  const goalNodes = nodesOf(client, goalQueue, { sessionId: 's1' })
  const textarea = one(goalNodes.filter((node) => node.type === 'textarea'), '会话 goal 必须保留 textarea')
  assert.equal(textarea.props.value, '会话 goal 原文')
  assert.equal(goalNodes.filter((node) => node.type === HOST.Input && node.props['aria-label'] !== '搜索').length, 0,
    '除顶部搜索外，会话 goal 的 textarea 不得被 Input 替换')
})

test('Toggle 官方委托：受控 props/title 直传，id 仅用无样式 span 保留', () => {
  const client = loadClient({ primitives: HOST, captureToggle: true })
  assert.equal(typeof client.Toggle, 'function')
  const changes = []
  const onChange = (next) => changes.push(next)
  const wrapper = client.Toggle({
    id: 'watcher-new-observe', checked: true, onChange,
    label: '仅观察', disabled: true, title: '保存中',
  })
  assert.equal(wrapper.type, 'span', '官方不收 id 时只能增加最小 wrapper')
  assert.equal(wrapper.props.id, 'watcher-new-observe')
  assert.equal(wrapper.props.className, undefined, 'id wrapper 不得引入旧主题类或新视觉')
  assert.equal(wrapper.props.role, undefined, 'wrapper 不得抢走官方 switch 语义')
  assert.equal(wrapper.props.children.length, 1)
  const control = wrapper.props.children[0]
  assert.equal(control.type, HOST.Switch, '有官方导出时必须直接委托 DSH Switch')
  assert.equal(control.props.checked, true)
  assert.strictEqual(control.props.onChange, onChange, 'onChange(next) 回调不得被事件适配层替换')
  assert.equal(control.props.label, '仅观察')
  assert.equal(control.props.disabled, true)
  assert.equal(control.props.title, '保存中')
  assert.equal(control.props.id, undefined, '官方 Switch 没有 id API，不应伪造透传')
  assert.equal(control.props.className, undefined, '不得把 dt-switch 拼回官方主题')
  assert.equal(control.props.onClick, undefined, '点击与 next 计算由官方组件拥有')
  control.props.onChange(false)
  assert.deepEqual(changes, [false])

  const direct = client.Toggle({ checked: false, onChange, label: '重开优先' })
  assert.equal(direct.type, HOST.Switch, '无 id 时不需要任何 wrapper')
  assert.equal(direct.props.checked, false)
  assert.equal(direct.props.disabled, undefined)
})

test('Toggle 回退：缺导出或整个 primitives 时保留 button+thumb、id/aria/title 与 next', () => {
  const scenarios = [undefined, {}, { ...HOST, Switch: undefined }]
  for (const primitives of scenarios) {
    const client = loadClient({ primitives, captureToggle: true })
    for (const checked of [false, true]) {
      const changes = []
      const node = client.Toggle({
        id: 'watcher-edit-isolated', checked, onChange: (next) => changes.push(next),
        label: '隔离执行', disabled: checked, title: '隔离说明',
      })
      assert.equal(node.type, 'button')
      assert.equal(node.props.id, 'watcher-edit-isolated')
      assert.equal(node.props.type, 'button')
      assert.equal(node.props.role, 'switch')
      assert.equal(node.props['aria-checked'], checked)
      assert.equal(node.props['aria-label'], '隔离执行')
      assert.equal(node.props.disabled, checked)
      assert.equal(node.props.title, '隔离说明')
      assert.ok(hasClass(node, 'dt-switch'))
      assert.equal(node.props.children.length, 1)
      assert.equal(node.props.children[0].type, 'span')
      assert.ok(hasClass(node.props.children[0], 'dt-switch-thumb'))
      node.props.onClick()
      assert.deepEqual(changes, [!checked], 'fallback 必须按当前 checked 发出 next')
    }
  }
})

test('Toggle 真实调用面：新增/行内编辑的普通与优先级开关全部委托且业务写回不变', () => {
  const client = loadClient({ primitives: HOST })
  const state = snapshot()
  state.body.watchers = [watcher('a/b', {
    id: 'a/b#s1', sessionId: 's1', observe: true,
    filters: { onlyAssigned: false },
    priority: { reopened: true, comments: true, labels: true, unassigned: false, stale: false },
  })]
  const createQueue = deskQueue(state, null, {}, 'trigger')
  createQueue[3] = { ...createQueue[3], repo: 'acme/widgets', observe: true }
  const scenarios = [
    ['新增', createQueue, 3, 'watcher-new'],
    ['行内编辑', deskQueue(state, 'a/b#s1'), 9, 'watcher-edit-' + encodeURIComponent('a/b#s1')],
  ]
  for (const [name, queue, stateIndex, idPrefix] of scenarios) {
    const nodes = nodesOf(client, queue, { sessionId: 's1' })
    const normals = [
      ['onlyAssigned', '只看已指派', false],
      ['observe', '仅观察', true],
      ['isolated', '隔离执行', false],
    ]
    for (const [key, label, checked] of normals) {
      const control = one(nodes.filter((node) => node.type === HOST.Switch && node.props.label === label),
        name + '：缺官方开关 ' + label)
      assert.equal(control.props.checked, checked, name + '：checked 错误 ' + label)
      assert.equal(control.props.disabled, false)
      assert.equal(control.props.className, undefined, name + '：官方路径不得带旧 dt-switch')
      const wrapper = one(nodes.filter((node) => node.type === 'span' && node.props.id === idPrefix + '-' + key),
        name + '：缺 id wrapper ' + key)
      assert.deepEqual(wrapper.props.children, [control], name + '：id wrapper 必须只包对应官方 Switch')
      assert.equal(wrapper.props.className, undefined)
    }
    assert.equal(nodes.filter((node) => node.type === 'button' && node.props.role === 'switch').length, 0,
      name + '：官方路径不得再渲染本地 button.dt-switch')

    client.resetStateCalls()
    one(nodes.filter((node) => node.type === HOST.Switch && node.props.label === '只看已指派'),
      name + '：缺唯一只看已指派').props.onChange(true)
    assert.ok(client.stateCalls().some((call) => call.index === stateIndex && call.next?.onlyAssigned === true),
      name + '：普通 Switch 的 next 必须写回既有表单槽位')

    const advanced = one(nodes.filter((node) => hasClass(node, 'dt-disclosure-row') && nodeText(node).includes('高级设置')),
      name + '：缺高级设置触发器')
    client.resetStateCalls()
    advanced.props.onClick()
    const openedQueue = [...queue]
    for (const call of client.stateCalls()) openedQueue[call.index] = call.next
    const opened = nodesOf(client, openedQueue, { sessionId: 's1' })
    const priorities = [
      ['priorityReopened', '重开优先', true],
      ['priorityComments', '评论优先', true],
      ['priorityLabels', '标签优先', true],
      ['priorityUnassigned', '未认领优先', false],
      ['priorityStale', '积压优先', false],
    ]
    for (const [key, label, checked] of priorities) {
      const control = one(opened.filter((node) => node.type === HOST.Switch && node.props.label === label),
        name + '：缺优先级官方开关 ' + label)
      assert.equal(control.props.checked, checked, name + '：优先级 checked 错误 ' + label)
      assert.equal(control.props.disabled, false)
      const wrapper = one(opened.filter((node) => node.type === 'span' && node.props.id === idPrefix + '-' + key),
        name + '：缺优先级 id wrapper ' + key)
      assert.deepEqual(wrapper.props.children, [control])
    }
    assert.equal(opened.filter((node) => node.type === HOST.Switch).length, 8,
      name + '：两个 Toggle 调用面合计必须是 3 普通 + 5 优先级')
    assert.equal(new Set(opened.filter((node) => node.type === 'span' && String(node.props.id || '').startsWith(idPrefix + '-'))
      .map((node) => node.props.id)).size, 8, name + '：8 个开关 id 必须唯一')

    client.resetStateCalls()
    one(opened.filter((node) => node.type === HOST.Switch && node.props.label === '重开优先'),
      name + '：缺唯一重开优先').props.onChange(false)
    assert.ok(client.stateCalls().some((call) => call.index === stateIndex && call.next?.priorityReopened === false),
      name + '：优先级 Switch 必须仍按 key,next 写回既有业务状态')
  }
})

test('Tag 官方委托：tone/children/className 直传，title 仅用无样式 wrapper 保留', () => {
  const client = loadClient({ primitives: HOST, captureTag: true })
  assert.equal(typeof client.Tag, 'function')
  for (const tone of ['outline', 'solid', 'neutral', 'quiet', 'success', 'info', 'warning', 'danger']) {
    const node = client.Tag({ tone, className: 'business', children: '标签 ' + tone })
    assert.equal(node.type, HOST.Tag, tone + ' 必须委托 DSH Tag')
    assert.equal(node.props.tone, tone)
    assert.equal(node.props.className, 'business')
    assert.equal(node.props.title, undefined, tone + '：官方不收 title，不能伪造透传')
    assert.equal(node.props['data-tone'], undefined, tone + '：data-tone 由官方组件自己拥有')
    assert.deepEqual(node.props.children, ['标签 ' + tone])
    assert.ok(!hasClass(node, 'dt-tag'), tone + '：官方路径不得回填旧 dt-tag 主题')
  }
  const defaults = client.Tag({ children: '默认标签' })
  assert.equal(defaults.type, HOST.Tag)
  assert.equal(defaults.props.tone, 'outline')

  const titled = client.Tag({ tone: 'outline', title: '不在活跃时段：只攒条目，不唤醒', children: '时段外' })
  assert.equal(titled.type, 'span', '有 title 时只增加最小 wrapper')
  assert.equal(titled.props.title, '不在活跃时段：只攒条目，不唤醒')
  assert.equal(titled.props.className, undefined, 'title wrapper 不得引入新视觉')
  assert.equal(titled.props.children.length, 1)
  const official = titled.props.children[0]
  assert.equal(official.type, HOST.Tag)
  assert.equal(official.props.tone, 'outline')
  assert.equal(official.props.title, undefined)
  assert.deepEqual(official.props.children, ['时段外'])
})

test('Tag 回退：缺导出或整个 primitives 时保留 dt-tag、title/tone/children 与业务 className', () => {
  for (const primitives of [undefined, {}, { ...HOST, Tag: undefined }]) {
    const client = loadClient({ primitives, captureTag: true })
    for (const tone of ['outline', 'quiet', 'success', 'warning', 'danger']) {
      const node = client.Tag({ tone, title: '提示 ' + tone, className: 'business', children: '标签 ' + tone })
      assert.equal(node.type, 'span')
      assert.ok(hasClass(node, 'dt-tag'))
      assert.ok(hasClass(node, 'business'))
      assert.equal(node.props['data-tone'], tone)
      assert.equal(node.props.title, '提示 ' + tone)
      assert.deepEqual(node.props.children, ['标签 ' + tone])
    }
  }
})

test('StateDot 官方委托：done/warning/ongoing/error/idle、size 与 dt-dot className 原样直传', () => {
  const client = loadClient({ primitives: HOST, captureStateDot: true })
  assert.equal(typeof client.StateDot, 'function')
  for (const state of ['done', 'warning', 'ongoing', 'error', 'idle']) {
    const node = client.StateDot({ state, size: 12, className: 'dt-dot business' })
    assert.equal(node.type, HOST.StateDot, state + ' 必须委托 DSH StateDot')
    assert.equal(node.props.state, state, state + '：不得自造或改写状态')
    assert.equal(node.props.size, 12)
    assert.equal(node.props.className, 'dt-dot business')
    assert.equal(node.props['data-state'], undefined, state + '：data-state 由官方组件自己拥有')
    assert.deepEqual(node.props.children, [])
  }
  const defaults = client.StateDot({ state: 'done', className: 'dt-dot' })
  assert.equal(defaults.props.size, undefined, '未传 size 时保留官方默认值')
})

test('StateDot 回退：缺导出或整个 primitives 时保留四态、dt-dot 与 ongoing spinner', () => {
  for (const primitives of [undefined, {}, { ...HOST, StateDot: undefined }]) {
    const client = loadClient({ primitives, captureStateDot: true })
    for (const state of ['done', 'warning', 'error', 'idle']) {
      const node = client.StateDot({ state, className: 'dt-dot business' })
      assert.equal(node.type, 'span')
      assert.ok(hasClass(node, 'dt-state-dot'))
      assert.ok(hasClass(node, 'dt-dot'))
      assert.ok(hasClass(node, 'business'))
      assert.equal(node.props['data-state'], state)
      assert.equal(node.props['aria-hidden'], 'true')
    }
    const ongoing = client.StateDot({ state: 'ongoing', size: 16, className: 'dt-dot' })
    assert.equal(ongoing.type, 'svg')
    assert.ok(hasClass(ongoing, 'dt-spinner'))
    assert.ok(hasClass(ongoing, 'dt-dot'), 'ongoing 回退也不能丢调用方 className')
    assert.equal(ongoing.props['data-state'], 'ongoing')
    assert.equal(ongoing.props.width, 16)
    assert.equal(ongoing.props.height, 16)
    assert.equal(ongoing.props.viewBox, '0 0 24 24')
    assert.equal(ongoing.props['aria-hidden'], 'true')
  }
})

test('Tag 与 StateDot 缺导出互不影响：各自回退，另一个仍委托官方', () => {
  const withoutTag = loadClient({ primitives: { ...HOST, Tag: undefined }, captureTag: true, captureStateDot: true })
  assert.equal(withoutTag.Tag({ children: '本地标签' }).type, 'span')
  assert.equal(withoutTag.StateDot({ state: 'done', className: 'dt-dot' }).type, HOST.StateDot)

  const withoutDot = loadClient({ primitives: { ...HOST, StateDot: undefined }, captureTag: true, captureStateDot: true })
  assert.equal(withoutDot.Tag({ tone: 'success', children: '官方标签' }).type, HOST.Tag)
  const fallbackDot = withoutDot.StateDot({ state: 'idle', className: 'dt-dot' })
  assert.equal(fallbackDot.type, 'span')
  assert.equal(fallbackDot.props['data-state'], 'idle')
  assert.ok(hasClass(fallbackDot, 'dt-dot'))
})

const COLLAPSIBLE_ITEMS = Object.freeze([
  '#7 机器人提的依赖升级 — 机器人：0123456789abcdefghijklmnopqrstuvwxyz',
  '#8 草稿 — 草稿 PR',
])

function renderCollapsible(client, open) {
  return client.render({
    Component: client.CollapsibleList,
    opts: { id: 'collapsible-list-test' },
  }, [open], { title: '看被过滤的条目', items: COLLAPSIBLE_ITEMS })
}

function collapsibleRow(nodes) {
  return one(nodes.filter((node) => hasClass(node, 'dt-disclosure-row')), '缺唯一本地 CollapsibleList 行')
}

test('CollapsibleList 官方委托：整行可展开、标题计数、折叠摘要与 ul 列表全部保留', () => {
  const client = loadClient({ primitives: HOST, captureCollapsibleList: true })
  assert.equal(typeof client.CollapsibleList, 'function')
  const closed = renderCollapsible(client, false)
  assert.equal(closed.type, HOST.DisclosureRow, '有官方导出时必须直接委托，不能先渲染本地 DisclosureRow')
  assert.equal(closed.props.title, '看被过滤的条目（2）')
  assert.equal(closed.props.open, false)
  assert.equal(closed.props.expandable, true)
  assert.equal(closed.props.expandOnRowClick, true)
  assert.equal(typeof closed.props.onToggle, 'function')
  assert.equal(closed.props.bodyId, undefined, '官方不收 bodyId，不得伪造高级区关联参数')
  assert.equal(closed.props['aria-controls'], undefined)
  assert.equal(closed.props.keepContentWhenOpen, undefined, '展开后摘要由官方默认卸载')
  assert.equal(closed.props.onClick, undefined, '点击与键盘必须交给官方整行实现')
  assert.equal(closed.props.onKeyDown, undefined)

  const summary = closed.props.collapsedContent
  assert.equal(summary.type, 'span')
  assert.ok(hasClass(summary, 'dt-hint'))
  assert.equal(nodeText(summary), COLLAPSIBLE_ITEMS[0].slice(0, 40))
  assert.equal(nodeText(summary).length, 40, '摘要仍严格截到 40 个字符')
  const list = one(closed.props.children.filter((node) => node.type === 'ul'), '官方 children 缺唯一 ul')
  assert.ok(hasClass(list, 'dt-plain-list'))
  assert.deepEqual(list.props.children.map((node) => node.type), ['li', 'li'])
  assert.deepEqual(list.props.children.map(nodeText), COLLAPSIBLE_ITEMS)

  client.resetStateCalls()
  closed.props.onToggle()
  assert.deepEqual(client.stateCalls().map((call) => [call.index, call.next]), [[0, true]], '官方 onToggle 必须展开原状态槽')
  const opened = renderCollapsible(client, true)
  assert.equal(opened.type, HOST.DisclosureRow)
  assert.equal(opened.props.open, true)
  assert.equal(opened.props.expandable, true)
  assert.equal(opened.props.expandOnRowClick, true)
  client.resetStateCalls()
  opened.props.onToggle()
  assert.deepEqual(client.stateCalls().map((call) => [call.index, call.next]), [[0, false]], '再次 onToggle 必须收起')
})

test('CollapsibleList 回退：缺导出或整个 primitives 时保留本地结构、摘要与语义列表', () => {
  for (const primitives of [undefined, {}, { ...HOST, DisclosureRow: undefined }]) {
    const client = loadClient({ primitives, captureCollapsibleList: true })
    const closed = walk(renderCollapsible(client, false))
    const closedRow = collapsibleRow(closed)
    assert.equal(closedRow.props.role, 'button')
    assert.equal(closedRow.props.tabIndex, 0, '回退行必须仍在键盘 Tab 顺序中')
    assert.equal(closedRow.props['aria-expanded'], false)
    assert.equal(closedRow.props['aria-controls'], undefined, '普通过滤清单不虚构 body 关联')
    assert.ok(nodeText(closedRow).includes('看被过滤的条目（2）'))
    assert.ok(nodeText(closedRow).includes(COLLAPSIBLE_ITEMS[0].slice(0, 40)))
    assert.equal(closed.filter((node) => node.type === 'ul' && hasClass(node, 'dt-plain-list')).length, 0,
      '收起时 ul 不挂载')

    const opened = walk(renderCollapsible(client, true))
    const openedRow = collapsibleRow(opened)
    assert.equal(openedRow.props['aria-expanded'], true)
    assert.ok(!nodeText(openedRow).includes(COLLAPSIBLE_ITEMS[0].slice(0, 40)), '展开后摘要必须卸载')
    const list = one(opened.filter((node) => node.type === 'ul' && hasClass(node, 'dt-plain-list')), '展开缺唯一 ul')
    assert.deepEqual(list.props.children.map((node) => node.type), ['li', 'li'])
    assert.deepEqual(list.props.children.map(nodeText), COLLAPSIBLE_ITEMS)
  }
})

test('CollapsibleList 回退键盘与点击：click/Enter/Space 开合且焦点入口不丢', () => {
  for (const primitives of [undefined, {}, { ...HOST, DisclosureRow: undefined }]) {
    const client = loadClient({ primitives, captureCollapsibleList: true })
    client.resetStateCalls()
    collapsibleRow(walk(renderCollapsible(client, false))).props.onClick()
    assert.deepEqual(client.stateCalls().map((call) => [call.index, call.next]), [[0, true]], 'click 必须展开')

    client.resetStateCalls()
    const openedRow = collapsibleRow(walk(renderCollapsible(client, true)))
    assert.equal(openedRow.props.tabIndex, 0)
    let enterPrevented = 0
    openedRow.props.onKeyDown({ key: 'Enter', preventDefault: () => { enterPrevented += 1 } })
    assert.equal(enterPrevented, 1)
    assert.deepEqual(client.stateCalls().map((call) => [call.index, call.next]), [[0, false]], 'Enter 必须收起')

    client.resetStateCalls()
    const closedRow = collapsibleRow(walk(renderCollapsible(client, false)))
    assert.equal(closedRow.props.tabIndex, 0)
    let spacePrevented = 0
    closedRow.props.onKeyDown({ key: ' ', preventDefault: () => { spacePrevented += 1 } })
    assert.equal(spacePrevented, 1)
    assert.deepEqual(client.stateCalls().map((call) => [call.index, call.next]), [[0, true]], 'Space 必须展开')
  }
})

test('CollapsibleList 唯一业务调用点委托官方，WatcherForm 高级区仍是唯一显式本地 DisclosureRow', () => {
  assert.equal([...SOURCE.matchAll(/h\(CollapsibleList,/g)].length, 1, '过滤清单业务调用点不得增删')
  // 0.10.5 G3：设置页「门禁」规则卡的「高级」也要 aria-controls（官方 CollapsibleRow 不收），
  // 所以显式本地调用变成两处。仍然只允许这两处 —— 不许为了图省事把上面那条 CollapsibleList 迁回本地实现。
  assert.equal([...SOURCE.matchAll(/h\(DisclosureRow,/g)].length, 2,
    '显式本地 DisclosureRow 只允许两处：WatcherForm 高级区 + 设置页门禁规则卡（都需要 aria-controls）')

  const client = loadClient({ primitives: HOST })
  const state = snapshot()
  state.body.watchers = [watcher('a/b', {
    id: 'a/b#s1', sessionId: 's1', filteredLog: [
      { number: 7, title: '机器人提的依赖升级', reason: '机器人' },
      { number: 8, title: '草稿', reason: '草稿 PR' },
    ],
  })]
  const overview = nodesOf(client, deskQueue(state))
  const official = one(overview.filter((node) => node.type === HOST.DisclosureRow), '总览缺唯一官方 CollapsibleList')
  assert.equal(official.props.title, '看被过滤的条目（2）')
  assert.equal(official.props.expandable, true)
  assert.equal(official.props.expandOnRowClick, true)

  const trigger = nodesOf(client, deskQueue(state, null, {}, 'trigger'), { sessionId: 's1' })
  assert.equal(trigger.filter((node) => node.type === HOST.DisclosureRow).length, 0,
    'WatcherForm 高级区不得误走不支持 aria-controls 的官方组件')
  const advanced = one(trigger.filter((node) => hasClass(node, 'dt-disclosure-row') && nodeText(node).includes('高级设置')),
    '新增表单缺本地高级区')
  assert.equal(advanced.props['aria-controls'], 'watcher-new-advanced-body')
  assert.equal(advanced.props['aria-expanded'], false)
})

test('WatcherForm 高级区：新增/编辑 bodyId 唯一，aria-controls 关联且 Enter/Space 开合不改草稿', () => {
  const client = loadClient({ primitives: HOST })
  const state = snapshot()
  state.body.watchers = [watcher('a/b', { id: 'a/b#s1', sessionId: 's1' })]
  const scenarios = [
    ['新增', deskQueue(state, null, {}, 'trigger'), 3, 'watcher-new'],
    ['行内编辑', deskQueue(state, 'a/b#s1'), 9, 'watcher-edit-' + encodeURIComponent('a/b#s1')],
  ]
  const expandedBodyIds = []
  for (const [name, queue, draftIndex, idPrefix] of scenarios) {
    const bodyId = idPrefix + '-advanced-body'
    const advancedOf = (nodes) => one(nodes.filter((node) => hasClass(node, 'dt-disclosure-row') && nodeText(node).includes('高级设置')),
      name + '：缺高级设置触发器')
    const applyStateCalls = (base) => {
      const next = [...base]
      const calls = client.stateCalls()
      assert.equal(calls.length, 1, name + '：一次高级区键盘操作只能切换一个 open 状态')
      for (const call of calls) next[call.index] = call.next
      assert.strictEqual(next[draftIndex], base[draftIndex], name + '：开合不得改写表单草稿')
      return next
    }

    const closed = nodesOf(client, queue, { sessionId: 's1' })
    const closedRow = advancedOf(closed)
    assert.equal(closedRow.props['aria-expanded'], false, name + '：默认收起')
    assert.equal(closedRow.props['aria-controls'], bodyId, name + '：收起时 trigger 也要声明受控 body id')
    assert.equal(closed.filter((node) => node.props?.id === bodyId).length, 0, name + '：收起时 body 不挂载')
    assert.ok(nodeText(closedRow).includes('限额、优先级与隔离保留策略'), name + '：收起摘要必须保留')

    client.resetStateCalls()
    let prevented = 0
    closedRow.props.onKeyDown({ key: 'Enter', preventDefault: () => { prevented += 1 } })
    assert.equal(prevented, 1, name + '：Enter 必须阻止默认行为')
    assert.equal(client.stateCalls()[0].next, true, name + '：Enter 必须展开')
    const openedQueue = applyStateCalls(queue)
    const opened = nodesOf(client, openedQueue, { sessionId: 's1' })
    const openedRow = advancedOf(opened)
    assert.equal(openedRow.props['aria-expanded'], true)
    assert.equal(openedRow.props['aria-controls'], bodyId, name + '：展开后 aria-controls 必须稳定')
    const body = one(opened.filter((node) => node.props?.id === bodyId), name + '：展开 body 必须带 aria-controls 指向的 id')
    assert.ok(hasClass(body, 'dt-disclosure-body'), name + '：id 必须落在真实高级区 body，而不是额外容器')
    assert.ok(!nodeText(openedRow).includes('限额、优先级与隔离保留策略'), name + '：展开后收起摘要必须卸载')
    expandedBodyIds.push(body.props.id)

    client.resetStateCalls()
    openedRow.props.onKeyDown({ key: ' ', preventDefault: () => { prevented += 1 } })
    assert.equal(prevented, 2, name + '：Space 必须阻止默认行为')
    assert.equal(client.stateCalls()[0].next, false, name + '：Space 必须收起')
    const restoredQueue = applyStateCalls(openedQueue)
    const restored = nodesOf(client, restoredQueue, { sessionId: 's1' })
    const restoredRow = advancedOf(restored)
    assert.equal(restoredRow.props['aria-expanded'], false, name + '：关闭后 aria-expanded 恢复 false')
    assert.equal(restoredRow.props['aria-controls'], bodyId, name + '：关闭后关联声明保留')
    assert.equal(restored.filter((node) => node.props?.id === bodyId).length, 0, name + '：关闭后 body 卸载')
    assert.ok(nodeText(restoredRow).includes('限额、优先级与隔离保留策略'), name + '：关闭后摘要恢复')
  }
  assert.equal(new Set(expandedBodyIds).size, scenarios.length, '新增与编辑同页展开时 bodyId 不得冲突')
})

test('现有 8 个直接 Btn primary 场景全部委托；SaveBar 的 ghost 同样委托', () => {
  const client = loadClient({ primitives: HOST })
  const empty = snapshot()
  let delegated = 0
  const primary = (label, queue, props = {}) => {
    const nodes = nodesOf(client, queue, props)
    const node = control(nodes, label)
    assert.equal(node.type, HOST.Button, label + ' 必须委托 DSH Button')
    assert.equal(node.props.variant, 'primary')
    assert.ok(!hasClass(node, 'dt-btn') && !hasClass(node, 'dt-btn-primary'), label + ' 不得带旧 primary CSS')
    delegated += 1
    return node
  }

  const onboarding = primary('去添加第一条', deskQueue(empty))
  assert.equal(onboarding.props.type, 'button')
  assert.equal(onboarding.props.size, 'md')
  assert.ok(onboarding.props.icon)
  assert.equal(typeof onboarding.props.onClick, 'function')

  const judgeEmpty = primary('去添加第一条', deskQueue(empty, null, {}, 'judge'))
  assert.equal(judgeEmpty.props.size, 'sm')

  const blankCreate = primary('添加到当前会话', deskQueue(empty, null, {}, 'trigger'), { sessionId: 's1' })
  assert.equal(blankCreate.props.type, 'submit')
  assert.equal(blankCreate.props.disabled, true)
  assert.equal(blankCreate.props['aria-label'], '添加到当前会话')
  assert.ok(blankCreate.props.icon)

  const dirty = deskQueue(empty, null, {}, 'trigger')
  dirty[3] = { ...dirty[3], repo: 'acme/widgets' }
  const save = primary('添加到当前会话', dirty, { sessionId: 's1' })
  assert.equal(save.props.type, 'submit')
  assert.equal(save.props.size, 'sm')
  assert.equal(save.props.disabled, false)
  const discard = control(nodesOf(client, dirty, { sessionId: 's1' }), '放弃')
  assert.equal(discard.type, HOST.Button, 'SaveBar ghost 必须委托 DSH Button')
  assert.equal(discard.props.variant, 'ghost')
  assert.equal(discard.props.size, 'sm')
  assert.equal(typeof discard.props.onClick, 'function')
  assert.ok(!hasClass(discard, 'dt-btn') && !hasClass(discard, 'dt-btn-ghost') && !hasClass(discard, 'dt-btn-sm'))

  const creds = deskQueue(empty, null, {}, 'settings')
  creds[14] = 'creds'
  const saveCredentials = primary('保存凭证', creds)
  assert.equal(saveCredentials.props.type, 'button')
  assert.equal(typeof saveCredentials.props.onClick, 'function')

  const goal = deskQueue(empty, null, {}, 'settings')
  goal[14] = 'goal'
  const saveGoal = primary('保存 goal', goal, { sessionId: 's1' })
  assert.equal(saveGoal.props.disabled, false)
  assert.equal(typeof saveGoal.props.onClick, 'function')

  const failed = deskQueue({ ...empty, error: 'Failed to fetch' })
  assert.equal(typeof primary('重试', failed).props.onClick, 'function')

  const rules = snapshot()
  rules.body.watchers = [watcher('a/b', { silentWakes: 3 })]
  const rulesQueue = deskQueue(rules)
  rulesQueue[11] = 'rules:a/b'
  const copyRules = primary('复制这段规则', rulesQueue)
  assert.equal(copyRules.props.size, 'sm')
  assert.equal(typeof copyRules.props.onClick, 'function')
  assert.equal(delegated, 8, '必须真实渲染并验收 8 个直接 primary 场景')
})

test('普通 ghost/outline 的场景全部委托；业务 link 保留旧 variant 与完整 props', () => {
  const client = loadClient({ primitives: HOST })
  const state = snapshot()
  state.body.watchers = [watcher('a/b', {
    id: 'a/b#s1',
    lastError: 'GitHub API 请求: EOF（网络抖动：已按退避自动重试）',
    lastErrorKind: 'network',
  })]
  const overview = nodesOf(client, deskQueue(state))
  for (const [label, variant] of [['立刻', 'outline'], ['暂停', 'ghost'], ['删除', 'ghost'], ['立刻重试', 'outline']]) {
    const node = control(overview, label)
    assert.equal(node.type, HOST.Button, label + ' 必须委托 DSH Button')
    assert.equal(node.props.variant, variant)
    assert.equal(node.props.size, 'sm')
    assert.equal(node.props.type, 'button')
    assert.equal(node.props.disabled, undefined)
    assert.equal(node.props['aria-label'], label === '立刻重试' || label === '删除' ? label : undefined)
    assert.equal(typeof node.props.onClick, 'function')
    assert.ok(!hasClass(node, 'dt-btn') && !hasClass(node, 'dt-btn-' + variant) && !hasClass(node, 'dt-btn-sm'),
      label + ' 不得带旧 variant/size CSS')
  }
  assert.ok(control(overview, '立刻').props.icon, 'outline 行内轮询必须保留 icon')
  assert.ok(control(overview, '暂停').props.icon, 'ghost 暂停必须保留 icon')
  assert.ok(control(overview, '删除').props.icon, 'ghost 删除触发器必须保留 icon')
  assert.equal(control(overview, '删除').props['aria-haspopup'], 'dialog')

  const update = nodesOf(client, updateQueue())
  for (const [label, variant] of [['复制命令', 'ghost'], ['重新检查', 'ghost'], ['复制诊断信息', 'outline']]) {
    const node = control(update, label)
    assert.equal(node.type, HOST.Button, label + ' 必须委托 DSH Button')
    assert.equal(node.props.variant, variant)
    assert.equal(node.props.size, 'sm')
    assert.equal(node.props.disabled, label === '重新检查' ? false : undefined)
    assert.equal(typeof node.props.onClick, 'function')
  }

  const rules = snapshot()
  rules.body.watchers = [watcher('a/b', { silentWakes: 3 })]
  const link = control(nodesOf(client, deskQueue(rules)), '看建议规则')
  assert.equal(link.type, 'button', '官方 Button 没有 link，不得自造 variant 映射')
  assert.equal(link.props.type, 'button')
  assert.equal(link.props['aria-label'], '看建议规则')
  assert.equal(typeof link.props.onClick, 'function')
  for (const name of ['dt-btn', 'dt-btn-link', 'dt-btn-sm']) assert.ok(hasClass(link, name), 'link 缺旧 class：' + name)
})

test('共享删除确认保留 danger/busy/disabled/aria，primary 确认与 ghost 取消都委托', () => {
  const client = loadClient({ primitives: HOST })
  const state = snapshot()
  state.body.watchers = [watcher('a/b', { id: 'a/b#s1' })]
  const base = deskQueue(state)
  const opened = nodesOf(client, [...base, true, false])
  const footer = walk(hostModal(opened).props.footer)
  const cancel = control(footer, '取消')
  assert.equal(cancel.type, HOST.Button)
  assert.equal(cancel.props.variant, 'ghost')
  assert.equal(cancel.props.size, 'md')
  assert.equal(typeof cancel.props.onClick, 'function')
  assert.ok(!hasClass(cancel, 'dt-btn') && !hasClass(cancel, 'dt-btn-ghost'))
  const confirm = control(footer, '确认删除')
  assert.equal(confirm.type, HOST.Button)
  assert.equal(confirm.props.type, 'button')
  assert.equal(confirm.props.size, 'md')
  assert.equal(confirm.props.disabled, false)
  assert.equal(confirm.props['aria-label'], '确认删除')
  assert.equal(confirm.props['aria-busy'], undefined)
  assert.equal(typeof confirm.props.onClick, 'function')
  assert.ok(hasClass(confirm, 'dt-danger'))
  assert.ok(!hasClass(confirm, 'dt-btn-busy'))

  const busyFooter = walk(hostModal(nodesOf(client, [...base, true, true])).props.footer)
  const busy = control(busyFooter, '确认删除')
  assert.equal(busy.type, HOST.Button)
  assert.equal(busy.props.disabled, true)
  assert.equal(busy.props['aria-busy'], 'true')
  assert.ok(hasClass(busy, 'dt-danger') && hasClass(busy, 'dt-btn-busy'))
})

test('hasUpdate 显示官方 primary 安装按钮；点击只确认，复制命令仍是真实 fallback', async () => {
  const calls = []
  const clipboard = []
  const client = loadClient({
    primitives: HOST,
    writeText: async (text) => { clipboard.push(text) },
    fetch: async (...args) => { calls.push(args); return response({}) },
  })
  const base = updateQueue()
  const hooks = hookIndexes(base)
  const closed = nodesOf(client, base)
  const trigger = control(closed, '安装更新')
  assert.equal(trigger.type, HOST.Button)
  assert.equal(trigger.props.variant, 'primary')
  assert.equal(trigger.props.size, 'sm')
  assert.equal(trigger.props['aria-haspopup'], 'dialog')
  assert.ok(textOf(closed).includes(UPDATE.command), '命令文本必须保留')
  assert.equal(closed.filter((node) => node.type === HOST.Modal).length, 0)

  client.resetStateCalls()
  trigger.props.onClick()
  assert.ok(client.stateCalls().some((call) => call.index === hooks.open && call.next === true))
  assert.equal(postsOf(calls).length, 0, '打开确认框不能发 POST')

  const opened = nodesOf(client, [...base, null, null, true, false])
  const modal = hostModal(opened)
  assert.equal(modal.props.open, true)
  assert.equal(modal.props.title, '安装更新')
  for (const expected of ['0.9.270', '0.9.271', '修改安装副本', '需要重载宿主才生效', '不会自动重启']) {
    assert.ok(modal.props.description.includes(expected), '确认说明缺：' + expected)
  }
  const footer = walk(modal.props.footer)
  control(footer, '取消').props.onClick()
  modal.props.onClose()
  assert.equal(postsOf(calls).length, 0, '取消与 onClose 都不能发 POST')

  await control(closed, '复制命令').props.onClick()
  assert.deepEqual(clipboard, [UPDATE.command])
  assert.equal(postsOf(calls).length, 0, '复制命令不能冒充安装')
})

test('deferred POST 忙碌时取消/onClose/连点均不关闭或重发；成功后只关闭一次并展示回执', async () => {
  const calls = []
  let release
  const client = loadClient({
    primitives: HOST,
    fetch: (url, init) => {
      calls.push([url, init])
      if (init?.method === 'POST') {
        return new Promise((resolve) => { release = () => resolve(response({ ok: true, ...RECEIPT })) })
      }
      return Promise.resolve(response({ ...UPDATE, hasUpdate: false }))
    },
  })
  const base = updateQueue()
  const hooks = hookIndexes(base)
  const opened = nodesOf(client, [...base, null, null, true, false])
  const openedModal = hostModal(opened)
  const openedFooter = walk(openedModal.props.footer)
  const confirm = control(openedFooter, '确认安装')
  const pendingCancel = control(openedFooter, '取消')

  client.resetStateCalls()
  const first = confirm.props.onClick()
  assert.equal(await confirm.props.onClick(), false, '第二次连点必须被同步 busyRef 挡住')
  assert.equal(pendingCancel.props.onClick(), false, '取消处理器必须被同一个同步 busyRef 挡住')
  assert.equal(openedModal.props.onClose(), false, '遮罩/Escape/关闭共用的 onClose 必须被 guard')
  assert.equal(postsOf(calls).length, 1)
  assert.equal(postsOf(calls)[0][0], '/session-superagent/update')
  assert.deepEqual(JSON.parse(postsOf(calls)[0][1].body), { version: '0.9.271' })
  assert.ok(client.stateCalls().some((call) => call.index === hooks.busy && call.next === true))
  assert.equal(calls.filter(([url]) => url.endsWith('/update?refresh=1')).length, 0, 'POST 未完成前不能刷新')

  const busyTree = nodesOf(client, [...base, null, null, true, true])
  const busyModal = hostModal(busyTree)
  const busyFooter = walk(busyModal.props.footer)
  const cancel = control(busyFooter, '取消')
  const busy = control(busyFooter, '确认安装')
  assert.equal(cancel.props.disabled, true, '安装忙碌时取消按钮必须 disabled')
  assert.equal(busy.props.disabled, true)
  assert.equal(busy.props['aria-busy'], 'true')
  assert.ok(hasClass(busy, 'dt-btn-busy'))
  assert.ok(textOf(busyTree).includes('安装进行中，完成后才能关闭'), 'Modal 必须持续显示 busy 提示；实际：' + textOf(busyTree))
  assert.equal(cancel.props.onClick(), false, 'busy 渲染中的取消仍受 guard')
  assert.equal(busyModal.props.onClose(), false, 'busy 渲染中的 onClose 仍受 guard')
  assert.equal(postsOf(calls).length, 1)
  assert.equal(client.stateCalls().some((call) => call.index === hooks.open && call.next === false), false,
    'POST pending 时任何 dismiss 路径都不能关闭 Modal')

  release()
  assert.equal(await first, true)
  assert.equal(postsOf(calls).length, 1)
  assert.equal(calls.filter(([url]) => url.endsWith('/update?refresh=1')).length, 1)
  assert.equal(client.stateCalls().filter((call) => call.index === hooks.open && call.next === false).length, 1,
    '成功必须绕过 busy guard，且只关闭一次')
  assert.ok(client.stateCalls().some((call) => call.index === hooks.busy && call.next === false))
  const receiptCall = one(client.stateCalls().filter((call) => call.index === hooks.result), '缺安装回执 state')
  assert.deepEqual({ ...receiptCall.next }, RECEIPT)

  const finalQueue = updateQueue()
  finalQueue[12] = { ...UPDATE, hasUpdate: false }
  const finalText = textOf(nodesOf(client, [...finalQueue, RECEIPT]))
  for (const expected of ['已安装，等待重载', 'installedVersion', '0.9.271', 'runningVersion', '0.9.270']) {
    assert.ok(finalText.includes(expected), '成功回执缺：' + expected)
  }
})

test('成功回执覆盖真实 GET hasUpdate:true：等待重载且不再提示重复安装，不冒充已运行新版', async () => {
  // 真实服务端仍以 runningVersion 比较 latest；安装副本已到 latest 时 GET 仍会返回 hasUpdate:true。
  const refreshed = { ...UPDATE, hasUpdate: true }
  const calls = []
  const client = loadClient({
    primitives: HOST,
    fetch: async (url, init) => {
      calls.push([url, init])
      return init?.method === 'POST' ? response({ ok: true, ...RECEIPT }) : response(refreshed)
    },
  })
  const base = updateQueue()
  const hooks = hookIndexes(base)
  const opened = nodesOf(client, [...base, null, null, true, false])
  client.resetStateCalls()
  assert.equal(await control(walk(hostModal(opened).props.footer), '确认安装').props.onClick(), true)

  const receiptCall = one(client.stateCalls().filter((call) => call.index === hooks.result), '缺安装回执 state')
  assert.deepEqual({ ...receiptCall.next }, RECEIPT)
  assert.equal(client.stateCalls().some((call) => call.index === hooks.result && call.next === null), false,
    '安装后的强制刷新必须保留刚写入的回执')
  const updateCall = client.stateCalls().filter((call) => call.index === 12).at(-1)
  assert.deepEqual({ ...updateCall.next }, refreshed)
  const toastCall = client.stateCalls().filter((call) => call.index === 7 && call.next?.tone === 'success').at(-1)
  assert.ok(toastCall, '成功必须进入 Toast')
  assert.ok(toastCall.next.text.includes('installedVersion 0.9.271'))
  assert.ok(toastCall.next.text.includes('runningVersion 0.9.270'))
  assert.ok(toastCall.next.text.includes('需要重载才生效'))
  assert.equal(calls.filter(([url]) => url.endsWith('/update?refresh=1')).length, 1)
  const actionCalls = calls.filter(([url]) => !url.startsWith('/session-superagent/client-note'))
  assert.ok(actionCalls.every(([url]) => url.startsWith('/session-superagent/update')), '除加载探针外不得调用重启或其它执行接口：' + actionCalls.map(([url]) => url).join(', '))

  const finalQueue = updateQueue()
  finalQueue[12] = refreshed
  const finalNodes = nodesOf(client, [...finalQueue, RECEIPT])
  const finalText = textOf(finalNodes)
  for (const expected of ['已安装，等待重载', 'installedVersion', '0.9.271', 'runningVersion', '0.9.270', 'needsReload', 'true · 需要重载才生效']) {
    assert.ok(finalText.includes(expected), '成功 Section 缺：' + expected)
  }
  assert.equal(controls(finalNodes, '安装更新').length, 0, '已安装 latest 且等待重载时必须隐藏重复安装按钮')
  assert.ok(control(finalNodes, '复制命令'), '手动命令回退不应随安装按钮一起隐藏')
  assert.ok(!finalText.includes('已运行新版'), 'runningVersion 未变时不能宣称已运行新版')

  const installedOverview = updateQueue()
  installedOverview[1] = 'overview'
  installedOverview[12] = refreshed
  const overviewNodes = nodesOf(client, [...installedOverview, RECEIPT])
  assert.equal(controls(overviewNodes, '去更新').length, 0, '等待重载时顶部不再给重复安装入口')
  assert.ok(!textOf(overviewNodes).includes('有新版本'), '等待重载时顶部不再误报有新版本')

  const noReload = { ...RECEIPT, runningVersion: '0.9.271', needsReload: false }
  const noReloadQueue = updateQueue()
  noReloadQueue[12] = refreshed
  const noReloadText = textOf(nodesOf(client, [...noReloadQueue, noReload]))
  assert.ok(noReloadText.includes('false · 当前无需重载'))
  assert.ok(noReloadText.includes('runningVersion') && noReloadText.includes('0.9.271'))
  assert.ok(!noReloadText.includes('已运行新版'), '界面不凭版本相等额外推断运行状态')
})

test('未安装、其它安装版本或 needsReload=false 时仍按 GET 显示安装按钮与顶部提示', () => {
  const client = loadClient({ primitives: HOST })
  const scenarios = [
    ['未安装', null],
    ['其它安装版本', { ...RECEIPT, installedVersion: '0.9.270' }],
    ['无需重载', { ...RECEIPT, needsReload: false }],
  ]
  for (const [name, receipt] of scenarios) {
    const settings = nodesOf(client, [...updateQueue(), receipt])
    assert.ok(control(settings, '安装更新'), name + '：不能隐藏安装按钮')
    assert.ok(!textOf(settings).includes('已安装，等待重载'), name + '：不能冒充等待重载')

    const overviewQueue = updateQueue()
    overviewQueue[1] = 'overview'
    const overview = nodesOf(client, [...overviewQueue, receipt])
    assert.ok(control(overview, '去更新'), name + '：不能隐藏顶部入口')
    assert.ok(textOf(overview).includes('有新版本 0.9.271'), name + '：顶部仍按 GET 提示')
  }
})

test('手动重新检查清掉旧安装回执；顶部入口直接叫「去更新」', async () => {
  const client = loadClient({
    primitives: HOST,
    fetch: async () => response(UPDATE),
  })
  const base = updateQueue()
  const resultIndex = hookIndexes(base).result
  base[resultIndex] = RECEIPT
  const nodes = nodesOf(client, base)
  client.resetStateCalls()
  await control(nodes, '重新检查').props.onClick()
  assert.ok(client.stateCalls().some((call) => call.index === resultIndex && call.next === null),
    '手动检查必须清掉旧回执，不能遮住新的 hasUpdate 状态')

  const overview = updateQueue()
  overview[1] = 'overview'
  const banner = control(nodesOf(client, overview), '去更新')
  banner.props.onClick()
  assert.ok(client.stateCalls().some((call) => call.index === 14 && call.next === 'update'))
  assert.ok(client.stateCalls().some((call) => call.index === 1 && call.next === 'settings'))
})

test('更新 POST 首个 fetch reject 只发一次：不 discoverBase，保留 update/命令并显示结果未知', async () => {
  const calls = []
  const client = loadClient({
    primitives: HOST,
    fetch: async (url, init) => {
      calls.push([url, init])
      if (init?.method === 'POST') throw new Error('响应丢失')
      return response(UPDATE)
    },
  })
  const base = updateQueue()
  const hooks = hookIndexes(base)
  const opened = nodesOf(client, [...base, null, null, true, false])
  client.resetStateCalls()
  assert.equal(await control(walk(hostModal(opened).props.footer), '确认安装').props.onClick(), false)
  assert.equal(postsOf(calls).length, 1, 'fetch rejection 不能自动重放更新 POST')
  assert.equal(calls.filter(([url]) => isStateUrl(url)).length, 0, '更新 POST 失败不能触发 discoverBase')
  assert.equal(calls.filter(([url]) => url.endsWith('/update?refresh=1')).length, 0, '结果未知不能伪装成功后刷新')
  assert.equal(client.stateCalls().filter((call) => call.index === 12).length, 0, '失败必须保留当前 update')
  const resultCall = one(client.stateCalls().filter((call) => call.index === hooks.result), '缺结果未知回执')
  assert.deepEqual({ ...resultCall.next }, UNKNOWN_RECEIPT)

  const errorText = '安装更新' + UNKNOWN_HINT + '：响应丢失'
  assert.ok(client.stateCalls().some((call) => call.index === 2 && call.next?.text === errorText), '缺未知结果 Section notice')
  assert.ok(client.stateCalls().some((call) => call.index === 7 && call.next?.text === errorText && call.next?.tone === 'error'), '缺未知结果 Toast')
  assert.ok(!client.stateCalls().some((call) => call.index === hooks.open && call.next === false), '结果未知保持确认层')

  const visibleQueue = updateQueue()
  visibleQueue[2] = { ok: false, text: errorText }
  visibleQueue[7] = { id: 1, text: errorText, tone: 'error' }
  const visible = nodesOf(client, [...visibleQueue, UNKNOWN_RECEIPT, null, true, false])
  const text = textOf(visible)
  assert.ok(text.includes('0.9.270') && text.includes(UPDATE.command), '结果未知后当前版本或命令回退丢失')
  assert.ok(text.includes(UNKNOWN_HINT), 'Section 必须持久显示重新检查 installed/running 的提示')
  assert.ok(text.includes('安装副本（installedVersion）') && text.includes('运行版本（runningVersion）'))
  assert.ok(!text.includes('安装完成') && !text.includes('未安装'), '结果未知不能写成安装完成或未安装')
  assert.ok(control(visible, '复制命令'))
  assert.equal(hostModal(visible).props.open, true)
})

test('更新 POST 404 只发一次：即使 discoverBase 可找到新前缀也不发第二次更新', async () => {
  const calls = []
  const client = loadClient({
    primitives: HOST,
    fetch: async (url, init) => {
      calls.push([url, init])
      if (init?.method === 'POST') {
        return calls.filter(([, options]) => options?.method === 'POST').length === 1
          ? response({ error: '旧前缀不存在' }, false, 404)
          : response({ ok: true, ...RECEIPT })
      }
      if (isStateUrl(url)) {
        const base = pathnameOf(url).slice(0, -'/state'.length)
        return response({ routeBase: base, serverVersion: base.endsWith('/r2') ? '0.9.273' : '0.0.0' })
      }
      return response(UPDATE)
    },
  })
  const base = updateQueue()
  const hooks = hookIndexes(base)
  const opened = nodesOf(client, [...base, null, null, true, false])
  client.resetStateCalls()
  assert.equal(await control(walk(hostModal(opened).props.footer), '确认安装').props.onClick(), false)
  assert.equal(postsOf(calls).length, 1, '404 不能经 discoverBase 自动重放更新 POST')
  assert.equal(calls.filter(([url]) => isStateUrl(url)).length, 0, '更新 POST 404 不应触发 discoverBase')
  assert.equal(calls.filter(([url]) => url.endsWith('/update?refresh=1')).length, 0)
  const resultCall = one(client.stateCalls().filter((call) => call.index === hooks.result), '404 缺结果未知回执')
  assert.deepEqual({ ...resultCall.next }, UNKNOWN_RECEIPT)
  const errorText = '安装更新' + UNKNOWN_HINT + '：旧前缀不存在'
  assert.ok(client.stateCalls().some((call) => call.index === 2 && call.next?.text === errorText))
  assert.ok(client.stateCalls().some((call) => call.index === 7 && call.next?.text === errorText && call.next?.tone === 'error'))
})

test('GET 的 fetch rejection 与 404 仍 discoverBase 后重试，更新 POST 特例不改变只读回归', async () => {
  for (const failure of ['reject', '404']) {
    const calls = []
    const client = loadClient({
      primitives: HOST,
      fetch: async (url, init) => {
        calls.push([url, init])
        if (url.endsWith('/update?refresh=1')) {
          const attempts = calls.filter(([seen]) => seen.endsWith('/update?refresh=1')).length
          if (attempts === 1) {
            if (failure === 'reject') throw new Error('GET 首次断网')
            return response({ error: '旧前缀不存在' }, false, 404)
          }
          return response(UPDATE)
        }
        if (isStateUrl(url)) {
          const base = pathnameOf(url).slice(0, -'/state'.length)
          return response({ routeBase: base, serverVersion: base.endsWith('/r2') ? '0.9.273' : '0.0.0' })
        }
        return response({})
      },
    })
    const nodes = nodesOf(client, updateQueue())
    assert.equal(await control(nodes, '重新检查').props.onClick(), true, failure + '：GET 应重试成功')
    const updateCalls = calls.filter(([url]) => url.endsWith('/update?refresh=1'))
    assert.equal(updateCalls.length, 2, failure + '：GET 必须原样重试一次')
    assert.equal(updateCalls[0][0], '/session-superagent/update?refresh=1')
    assert.equal(updateCalls[1][0], '/session-superagent/r2/update?refresh=1', failure + '：重试必须使用发现的新前缀；实际 ' + updateCalls.map(([url]) => url).join(', '))
    assert.equal(calls.filter(([url]) => isStateUrl(url)).length, 8, failure + '：必须执行完整 discoverBase（默认前缀 + r2…r8）')
    assert.equal(postsOf(calls).length, 0)
    const updateCall = client.stateCalls().filter((call) => call.index === 12).at(-1)
    assert.deepEqual({ ...updateCall.next }, UPDATE)
  }
})

test('deferred POST 失败保留版本/命令与错误，busy 结束后取消和 onClose 恢复可关闭', async () => {
  const calls = []
  let release
  const client = loadClient({
    primitives: HOST,
    fetch: (url, init) => {
      calls.push([url, init])
      if (init?.method === 'POST') {
        return new Promise((resolve) => { release = () => resolve(response({ error: '磁盘只读' }, false, 500)) })
      }
      return Promise.resolve(response(UPDATE))
    },
  })
  const base = updateQueue()
  const hooks = hookIndexes(base)
  const opened = nodesOf(client, [...base, null, null, true, false])
  client.resetStateCalls()
  const pending = control(walk(hostModal(opened).props.footer), '确认安装').props.onClick()
  assert.equal(postsOf(calls).length, 1)
  assert.equal(client.stateCalls().some((call) => call.index === hooks.open && call.next === false), false,
    'deferred 失败完成前不能关闭')
  release()
  assert.equal(await pending, false)
  assert.equal(postsOf(calls).length, 1)
  assert.equal(calls.filter(([url]) => url.endsWith('/update?refresh=1')).length, 0, '失败不能伪装成功后刷新')
  assert.equal(client.stateCalls().filter((call) => call.index === 12).length, 0, '失败不能覆盖当前 update')
  assert.equal(client.stateCalls().filter((call) => call.index === hooks.result).length, 0, '失败不能写安装回执')
  assert.ok(!client.stateCalls().some((call) => call.index === hooks.open && call.next === false), '失败保持确认层')
  assert.ok(client.stateCalls().some((call) => call.index === hooks.busy && call.next === false), '失败后必须解除 busy')

  const errorText = '安装更新失败：磁盘只读'
  assert.ok(client.stateCalls().some((call) => call.index === 2 && call.next?.text === errorText), '缺 Section notice')
  assert.ok(client.stateCalls().some((call) => call.index === 7 && call.next?.text === errorText && call.next?.tone === 'error'), '缺 error Toast')

  const visibleQueue = updateQueue()
  visibleQueue[2] = { ok: false, text: errorText }
  visibleQueue[7] = { id: 1, text: errorText, tone: 'error' }
  const visible = nodesOf(client, [...visibleQueue, null, null, true, false])
  const text = textOf(visible)
  assert.ok(text.includes('0.9.270') && text.includes(UPDATE.command), '失败后当前版本或命令回退丢失')
  assert.ok(text.includes(errorText), 'Section 必须留住错误')
  assert.ok(control(visible, '复制命令'))
  const visibleModal = hostModal(visible)
  assert.equal(visibleModal.props.open, true)
  assert.equal(one(visible.filter((node) => node.type === HOST.Toast), '缺可见宿主 Toast').props.text, errorText)
  assert.ok(!text.includes('已运行新版'))

  client.resetStateCalls()
  const cancel = control(walk(visibleModal.props.footer), '取消')
  assert.equal(cancel.props.disabled, false, '失败后取消必须恢复可用')
  assert.equal(cancel.props.onClick(), true)
  assert.equal(visibleModal.props.onClose(), true)
  assert.equal(client.stateCalls().filter((call) => call.index === hooks.open && call.next === false).length, 2,
    '失败后取消与 onClose 都必须能关闭')
})

test('老宿主缺 Button/Modal/Toast 时保留完整本地 fallback，确认仍执行同一 POST', async () => {
  for (const primitives of [undefined, {}]) {
    const calls = []
    const client = loadClient({
      primitives,
      fetch: async (url, init) => {
        calls.push([url, init])
        return init?.method === 'POST' ? response({ ok: true, ...RECEIPT }) : response({ ...UPDATE, hasUpdate: false })
      },
    })
    const base = updateQueue()
    const closed = nodesOf(client, base)
    const trigger = control(closed, '安装更新')
    assert.equal(trigger.type, 'button')
    assert.ok(hasClass(trigger, 'dt-btn-primary'))
    assert.ok(control(closed, '复制命令'))
    assert.equal(closed.filter((node) => node.type === HOST.Button || node.type === HOST.Modal).length, 0)

    trigger.props.onClick()
    const opened = nodesOf(client, [...base, null, null, true, false])
    const modal = localModal(opened)
    assert.equal(modal.props.role, 'dialog')
    assert.ok(textOf(opened).includes('修改安装副本'))
    assert.equal(await control(opened, '确认安装').props.onClick(), true)
    assert.equal(postsOf(calls).length, 1)
    assert.deepEqual(JSON.parse(postsOf(calls)[0][1].body), { version: '0.9.271' })
    assert.equal(calls.filter(([url]) => url.endsWith('/update?refresh=1')).length, 1)
    assert.ok(client.stateCalls().some((call) => call.index === 7 && call.next?.tone === 'success'))
    assert.equal(opened.filter((node) => node.type === HOST.Button || node.type === HOST.Modal || node.type === HOST.Toast).length, 0)
  }
})

test('SegTabs 官方委托：四项 items 带稳定 id/panelId，当前 panel 唯一且反向关联', () => {
  const client = loadClient({ primitives: HOST })
  for (const [value] of MAIN_TABS) {
    const nodes = nodesOf(client, deskQueue(snapshot(), null, {}, value))
    const tabs = one(nodes.filter((node) => node.type === HOST.SegmentedTabs), value + '：缺唯一官方 SegmentedTabs')
    assert.equal(tabs.props.value, value)
    assert.equal(tabs.props.label, '主理鱼分区')
    assert.equal(tabs.props.items.length, 4)
    assert.equal(tabs.props.className, undefined, '官方路径不得回填旧 dt-tabs 外观')
    assert.equal(tabs.props.onKeyDown, undefined, '官方路径不得挂自制键盘处理')
    assert.equal(nodes.filter((node) => node.props?.role === 'tablist').length, 0, '官方路径不得再渲染本地 tablist')
    MAIN_TABS.forEach(([itemValue, itemLabel], index) => {
      const item = tabs.props.items[index]
      assert.equal(item.value, itemValue)
      assert.equal(item.label, itemLabel)
      assert.equal(item.id, 'sa-main-tab-' + itemValue)
      assert.equal(item.panelId, 'sa-main-panel-' + itemValue)
    })
    const panel = one(nodes.filter((node) => node.props?.role === 'tabpanel'), value + '：只能渲染当前 tabpanel')
    assert.equal(panel.props.id, 'sa-main-panel-' + value)
    assert.equal(panel.props['aria-labelledby'], 'sa-main-tab-' + value)
    assert.ok(hasClass(panel, 'dt-tabpanel'))
  }
})

test('SegTabs 回退：缺导出或 primitives 时保留原 tablist、唯一 tab stop 与 panel 关联', () => {
  const scenarios = [undefined, {}, { ...HOST, SegmentedTabs: undefined }]
  for (const primitives of scenarios) {
    const client = loadClient({ primitives })
    const nodes = nodesOf(client, deskQueue(snapshot(), null, {}, 'overview'))
    assert.equal(nodes.filter((node) => node.type === HOST.SegmentedTabs).length, 0)
    const tablist = one(nodes.filter((node) => node.props?.role === 'tablist'), 'fallback 缺唯一 tablist')
    assert.ok(hasClass(tablist, 'dt-tabs'))
    assert.equal(tablist.props['aria-label'], '主理鱼分区')
    assert.equal(tablist.props.style.gridTemplateColumns, 'repeat(4, minmax(0, 1fr))')
    assert.equal(typeof tablist.props.onKeyDown, 'function')
    const tabs = nodes.filter((node) => node.type === 'button' && node.props?.role === 'tab')
    assert.equal(tabs.length, 4)
    MAIN_TABS.forEach(([value, label], index) => {
      const tab = tabs[index]
      assert.equal(nodeText(tab), label)
      assert.equal(tab.props.id, 'sa-main-tab-' + value)
      assert.equal(tab.props['aria-controls'], 'sa-main-panel-' + value)
      assert.equal(tab.props['aria-selected'], value === 'overview')
      assert.equal(tab.props.tabIndex, value === 'overview' ? 0 : -1)
      assert.ok(hasClass(tab, 'dt-tab'))
    })
    assert.equal(tabs.filter((tab) => tab.props.tabIndex === 0).length, 1, 'fallback 只能有一个 tab stop')
    const panel = one(nodes.filter((node) => node.props?.role === 'tabpanel'), 'fallback 缺当前 tabpanel')
    assert.equal(panel.props.id, tabs[0].props['aria-controls'])
    assert.equal(panel.props['aria-labelledby'], tabs[0].props.id)
  }
})

test('SegTabs 当前 tab 重置：官方收到同一 onChange，fallback 点击当前仍重发', () => {
  const scenarios = [
    ['official', HOST],
    ['missing-export', { ...HOST, SegmentedTabs: undefined }],
    ['missing-primitives', undefined],
  ]
  for (const [name, primitives] of scenarios) {
    const client = loadClient({ primitives })
    const nodes = nodesOf(client, deskQueue(snapshot(), null, {}, 'overview'))
    client.resetStateCalls()
    if (name === 'official') {
      const tabs = one(nodes.filter((node) => node.type === HOST.SegmentedTabs), '缺官方 SegmentedTabs')
      // 官方 onClick 无条件调用此回调；这里验证适配层没有按 value 包一层去重。
      tabs.props.onChange('overview')
    } else {
      const current = one(nodes.filter((node) => node.type === 'button'
        && node.props?.role === 'tab' && node.props['aria-selected'] === true), name + '：缺当前 fallback tab')
      current.props.onClick()
    }
    const calls = client.stateCalls().filter((call) => call.index === 1)
    assert.equal(calls.length, 1, name + '：点击当前 tab 不能吞掉 onChange')
    assert.equal(calls[0].next, 'overview')
  }
})

test('SegTabs 键盘：fallback Arrow/Home/End 循环且焦点跟随，官方路径无自制 keydown', () => {
  const client = loadClient({ primitives: { ...HOST, SegmentedTabs: undefined } })
  const scenarios = [
    ['judge', 'ArrowRight', 'trigger'],
    ['judge', 'ArrowLeft', 'overview'],
    ['overview', 'ArrowLeft', 'settings'],
    ['settings', 'ArrowRight', 'overview'],
    ['judge', 'Home', 'overview'],
    ['judge', 'End', 'settings'],
  ]
  for (const [value, key, expected] of scenarios) {
    const nodes = nodesOf(client, deskQueue(snapshot(), null, {}, value))
    const tablist = one(nodes.filter((node) => node.props?.role === 'tablist'), value + ' ' + key + '：缺 tablist')
    const tabs = nodes.filter((node) => node.type === 'button' && node.props?.role === 'tab')
    const focused = []
    for (const tab of tabs) {
      assert.equal(typeof tab.ref, 'function', 'fallback tab 必须注册按钮 ref')
      tab.ref({ focus: () => focused.push(tab.props.id) })
    }
    let prevented = 0
    client.resetStateCalls()
    tablist.props.onKeyDown({ key, preventDefault: () => { prevented += 1 } })
    assert.equal(prevented, 1, value + ' ' + key + '：必须 preventDefault')
    assert.deepEqual(focused, ['sa-main-tab-' + expected], value + ' ' + key + '：焦点必须跟随目标 tab')
    const calls = client.stateCalls().filter((call) => call.index === 1)
    assert.equal(calls.length, 1)
    assert.equal(calls[0].next, expected)
  }

  const official = loadClient({ primitives: HOST })
  const nodes = nodesOf(official, deskQueue(snapshot()))
  const tabs = one(nodes.filter((node) => node.type === HOST.SegmentedTabs), '缺官方 SegmentedTabs')
  assert.equal(tabs.props.onKeyDown, undefined, 'Arrow/Home/End 必须全部交给官方实现')
  assert.equal(nodes.filter((node) => node.props?.role === 'tablist').length, 0)
})

function pillState() {
  const state = snapshot()
  state.body.watchers = [
    watcher('ok/one', {
      id: 'ok/one#s1', sessionId: 's1',
      repoAccess: { repo: 'ok/one', push: true, hasIssues: true },
    }),
    watcher('ro/two', {
      id: 'ro/two#s2', sessionId: 's2', lastError: 'boom',
      repoAccess: { repo: 'ro/two', push: false, hasIssues: true },
      deferReason: 'cap-session', lastDeferred: '这条会话一小时内已被唤醒 12 次',
      filterCounts: { 机器人: 1 },
      filteredLog: [{ at: '2026-11-06T08:00:00.000Z', number: 40, title: '固定过滤条目', reason: '机器人' }],
    }),
  ]
  return state
}

function officialPill(nodes, label) {
  return one(nodes.filter((node) => node.type === HOST.Pill && nodeText(node) === label), '缺唯一官方 Pill「' + label + '」')
}

test('Pill 官方委托：active/className/children/onClick/rest 完整，交互补 aria-pressed，静态仍由官方处理', () => {
  const client = loadClient({ primitives: HOST, capturePill: true })
  assert.equal(typeof client.Pill, 'function')
  for (const active of [false, true]) {
    const clicks = []
    const onClick = () => clicks.push(active)
    const node = client.Pill({
      active, className: 'business', onClick, children: '只看失败',
      id: 'filter-failed', title: '切换失败过滤', 'data-reason': 'failed', key: 'failed-' + active,
    })
    assert.equal(node.type, HOST.Pill, '有官方导出时必须直接委托，不能先渲染本地 button')
    assert.equal(node.props.active, active)
    assert.equal(node.props.className, 'business')
    assert.ok(!hasClass(node, 'dt-pill') && !hasClass(node, 'dt-pill-active'), '官方路径不得回填旧主题类')
    assert.strictEqual(node.props.onClick, onClick)
    assert.deepEqual(node.props.children, ['只看失败'])
    assert.equal(node.props['aria-pressed'], active, '官方缺少的 aria-pressed 由调用方按 active 最小补齐')
    assert.equal(node.props.id, 'filter-failed')
    assert.equal(node.props.title, '切换失败过滤')
    assert.equal(node.props['data-reason'], 'failed', 'ButtonHTMLAttributes rest 必须原样透传')
    assert.equal(node.key, 'failed-' + active)
    node.props.onClick()
    assert.deepEqual(clicks, [active])
  }

  const staticNode = client.Pill({
    active: true, className: 'business', children: '静态只读', id: 'readonly-badge', title: '只读状态',
  })
  assert.equal(staticNode.type, HOST.Pill, '无 onClick 也必须直接委托官方静态分支')
  assert.equal(staticNode.props.active, true)
  assert.equal(staticNode.props.className, 'business')
  assert.deepEqual(staticNode.props.children, ['静态只读'])
  assert.equal(staticNode.props.id, 'readonly-badge', 'rest 仍按官方合同转发，由官方决定静态分支是否消费')
  assert.equal(staticNode.props.onClick, undefined)
  assert.equal(staticNode.props.type, undefined, '适配层不得给静态 badge 自造 button type')
  assert.equal(staticNode.props['aria-pressed'], undefined, '静态 badge 不应伪装成切换按钮')

  const clearNode = client.Pill({ onClick: () => {}, children: '清除筛选' })
  assert.equal(clearNode.props.active, undefined, '清除动作没有 toggle 状态，不得补 active=false')
  assert.equal(clearNode.props['aria-pressed'], undefined, '清除动作不是 toggle，不得输出 aria-pressed=false')
})

test('Pill 回退：缺导出或整个 primitives 时交互保留 button.dt-pill，静态按官方语义渲染 span', () => {
  const scenarios = [undefined, {}, { ...HOST, Pill: undefined }]
  for (const primitives of scenarios) {
    const client = loadClient({ primitives, capturePill: true })
    for (const active of [false, true]) {
      const onClick = () => {}
      const node = client.Pill({
        active, className: 'business', onClick, children: '清除筛选',
        id: 'clear-filter', title: '清除', key: 'clear-' + active,
      })
      assert.equal(node.type, 'button', '交互回退必须保留原 button.dt-pill')
      assert.equal(node.props.type, 'button')
      assert.ok(hasClass(node, 'dt-pill') && hasClass(node, 'business'))
      assert.equal(hasClass(node, 'dt-pill-active'), active)
      assert.equal(node.props['aria-pressed'], active)
      assert.strictEqual(node.props.onClick, onClick)
      assert.deepEqual(node.props.children, ['清除筛选'])
      assert.equal(node.props.id, 'clear-filter')
      assert.equal(node.props.title, '清除')
      assert.equal(node.key, 'clear-' + active)
    }
    const clearNode = client.Pill({ onClick: () => {}, children: '清除' })
    assert.equal(clearNode.props['aria-pressed'], undefined, '未定义 active 的清除动作在回退路径也不是 toggle')
    const staticNode = client.Pill({ active: true, className: 'business', children: '只读' })
    assert.equal(staticNode.type, 'span', '无 onClick 时连回退也不能把只读 badge 强行变按钮')
    assert.ok(hasClass(staticNode, 'dt-pill') && hasClass(staticNode, 'dt-pill-active') && hasClass(staticNode, 'business'))
    assert.equal(staticNode.props.type, undefined)
    assert.equal(staticNode.props.onClick, undefined)
    assert.equal(staticNode.props['aria-pressed'], undefined)
    assert.deepEqual(staticNode.props.children, ['只读'])
  }
})

test('Pill 真实 9 调用点：徽章/问题/暂停/跳过过滤委托官方，active 与 aria-pressed 同步且再点取消', () => {
  assert.equal([...SOURCE.matchAll(/h\(Pill,/g)].length, 9, '共享适配不得增删 9 个业务调用点')
  const client = loadClient({ primitives: HOST })
  const state = pillState()
  const base = deskQueue(state)
  const overview = nodesOf(client, base)
  const readOnly = officialPill(overview, '只读')
  assert.equal(readOnly.props.active, false)
  assert.equal(readOnly.props['aria-pressed'], false)
  const problems = officialPill(overview, '只看有问题的 (1)')
  assert.equal(problems.props.active, false)
  assert.equal(overview.filter((node) => node.type === 'button' && hasClass(node, 'dt-pill')).length, 0,
    '官方路径不得再出现自制 button.dt-pill')

  client.resetStateCalls()
  readOnly.props.onClick()
  assert.deepEqual(client.stateCalls().filter((call) => call.index === 16).map((call) => call.next), ['只读'])
  const badgeQueue = [...base]
  badgeQueue[16] = '只读'
  const badgeNodes = nodesOf(client, badgeQueue)
  const activeBadge = officialPill(badgeNodes, '只读')
  assert.equal(activeBadge.props.active, true)
  assert.equal(activeBadge.props['aria-pressed'], true)
  assert.deepEqual(badgeNodes.filter((node) => hasClass(node, 'dt-open')).map(nodeText), ['ro/two'], '徽章过滤必须仍只留只读仓库')
  client.resetStateCalls()
  activeBadge.props.onClick()
  assert.deepEqual(client.stateCalls().filter((call) => call.index === 16).map((call) => call.next), [null], '已选徽章再点必须取消')

  client.resetStateCalls()
  problems.props.onClick()
  assert.deepEqual(client.stateCalls().filter((call) => call.index === 17).map((call) => call.next), [true])
  const problemQueue = [...base]
  problemQueue[17] = true
  const problemNodes = nodesOf(client, problemQueue)
  const activeProblems = officialPill(problemNodes, '只看有问题的 (1)')
  assert.equal(activeProblems.props.active, true)
  assert.equal(activeProblems.props['aria-pressed'], true)
  assert.deepEqual(problemNodes.filter((node) => hasClass(node, 'dt-open')).map(nodeText), ['ro/two'])
  client.resetStateCalls()
  officialPill(problemNodes, '全部').props.onClick()
  assert.deepEqual(client.stateCalls().filter((call) => call.index === 17).map((call) => call.next), [false], '「全部」必须清除问题过滤')

  const judgeBase = deskQueue(state, null, {}, 'judge')
  const judge = nodesOf(client, judgeBase)
  const defer = officialPill(judge, '撞会话上限 × 1')
  const reason = officialPill(judge, '机器人 × 1')
  assert.equal(defer.props.active, false)
  assert.equal(reason.props.active, false)
  client.resetStateCalls()
  defer.props.onClick()
  assert.deepEqual(client.stateCalls().filter((call) => call.index === 15).map((call) => call.next), ['defer:cap-session'])
  const deferQueue = [...judgeBase]
  deferQueue[15] = 'defer:cap-session'
  const deferNodes = nodesOf(client, deferQueue)
  const activeDefer = officialPill(deferNodes, '撞会话上限 × 1')
  assert.equal(activeDefer.props.active, true)
  assert.equal(activeDefer.props['aria-pressed'], true)
  client.resetStateCalls()
  officialPill(deferNodes, '清除').props.onClick()
  assert.deepEqual(client.stateCalls().filter((call) => call.index === 15).map((call) => call.next), [null])

  client.resetStateCalls()
  reason.props.onClick()
  assert.deepEqual(client.stateCalls().filter((call) => call.index === 15).map((call) => call.next), ['机器人'])
  const reasonQueue = [...judgeBase]
  reasonQueue[15] = '机器人'
  const reasonNodes = nodesOf(client, reasonQueue)
  const activeReason = officialPill(reasonNodes, '机器人 × 1')
  assert.equal(activeReason.props.active, true)
  assert.equal(activeReason.props['aria-pressed'], true)
  assert.ok(textOf(reasonNodes).includes('#40'), '跳过原因过滤后的真实条目必须保留')
  client.resetStateCalls()
  officialPill(reasonNodes, '清除筛选').props.onClick()
  assert.deepEqual(client.stateCalls().filter((call) => call.index === 15).map((call) => call.next), [null])
})

test('Pill 过滤汇总：单项清除与全部清除仍写回原状态槽，清除胶囊无 active 也不误报按下', () => {
  const client = loadClient({ primitives: HOST })
  const queue = deskQueue(pillState())
  queue[16] = '只读'
  queue[18] = 'error'
  queue[10] = 'ro'
  queue[17] = true
  queue[15] = 'defer:cap-session'
  const nodes = nodesOf(client, queue)
  const clearBadge = officialPill(nodes, '只读 ✕')
  const clearAll = officialPill(nodes, '全部清除')
  assert.equal(clearBadge.props.active, undefined)
  assert.equal(clearBadge.props['aria-pressed'], undefined)
  assert.equal(clearAll.props.active, undefined)
  assert.equal(clearAll.props['aria-pressed'], undefined)

  client.resetStateCalls()
  clearBadge.props.onClick()
  assert.deepEqual(client.stateCalls().map((call) => [call.index, call.next]), [[16, null]], '单项清除只能清自己的过滤')

  client.resetStateCalls()
  clearAll.props.onClick()
  assert.deepEqual(client.stateCalls().map((call) => [call.index, call.next]), [
    [16, null], [18, null], [10, ''], [17, false], [15, null],
  ], '全部清除必须保留徽章/状态/搜索/问题/暂停原因五类既有行为')
})

test('Orbit 首次 /state 失败保持 watchers=null 并写读取错误，不伪装成空数组', async () => {
  const client = loadClient({
    fetch: async () => response({ error: 'offline' }, false, 500),
  })
  const orbit = client.registrations.find((item) => item.opts.id === 'session-superagent-orbit')
  client.render(orbit, [null, null, false, null])
  const loadEffect = client.effects.find((effect) => String(effect.create).includes("noteOnce('orbit-mount'"))
  assert.ok(loadEffect, '找不到 Orbit 首次状态加载 effect')
  const cleanup = loadEffect.create()
  await new Promise((resolve) => setImmediate(resolve))
  const calls = client.stateCalls()
  assert.equal(calls.some((call) => call.index === 0 && Array.isArray(call.next)), false,
    '首次失败不得把未知 watchers 写成 []：' + JSON.stringify(calls))
  assert.ok(calls.some((call) => call.index === 1 && String(call.next).includes('读取失败：offline')),
    '首次失败必须写可见读取错误：' + JSON.stringify(calls))
  if (typeof cleanup === 'function') cleanup()
})

test('WatcherForm 校验失败 reportValidity 并 focus 无效控件；有效路径仍只发原 POST', async () => {
  for (const scenario of [
    { name: '必填仓库空缺', repo: '', intervalSec: '90' },
    { name: '数字低于 min', repo: 'acme/widgets', intervalSec: '1' },
  ]) {
    const requests = []
    const client = loadClient({
      fetch: async (url, init) => {
        requests.push([url, init])
        return response({ ok: true, watchers: [] })
      },
    })
    const queue = deskQueue(snapshot(), null, {}, 'trigger')
    queue[3] = { ...queue[3], repo: scenario.repo, intervalSec: scenario.intervalSec }
    const save = control(nodesOf(client, queue, { sessionId: 's1' }), '添加到当前会话')
    const events = { prevented: 0, checked: 0, reported: 0, queried: 0, focused: 0 }
    const invalid = { focus() { events.focused += 1 } }
    const form = {
      checkValidity() { events.checked += 1; return false },
      reportValidity() { events.reported += 1 },
      querySelector(selector) {
        events.queried += 1
        assert.equal(selector, ':invalid')
        return invalid
      },
    }
    const result = await save.props.onClick({
      preventDefault() { events.prevented += 1 },
      currentTarget: { form },
    })
    assert.equal(result, false, scenario.name + '：无效表单不能保存')
    assert.deepEqual(events, { prevented: 1, checked: 1, reported: 1, queried: 1, focused: 1 }, scenario.name)
    assert.equal(postsOf(requests).length, 0, scenario.name + '：无效表单不得 POST')
  }

  const requests = []
  const client = loadClient({
    fetch: async (url, init) => {
      requests.push([url, init])
      return response({ ok: true, watchers: [] })
    },
  })
  const queue = deskQueue(snapshot(), null, {}, 'trigger')
  queue[3] = { ...queue[3], repo: 'acme/widgets', intervalSec: '90' }
  const save = control(nodesOf(client, queue, { sessionId: 's1' }), '添加到当前会话')
  const events = { prevented: 0, checked: 0, reported: 0, queried: 0, focused: 0 }
  const form = {
    checkValidity() { events.checked += 1; return true },
    reportValidity() { events.reported += 1 },
    querySelector() { events.queried += 1; return { focus() { events.focused += 1 } } },
  }
  assert.equal(await save.props.onClick({ preventDefault() { events.prevented += 1 }, currentTarget: { form } }), true)
  assert.deepEqual(events, { prevented: 1, checked: 1, reported: 0, queried: 0, focused: 0 }, '有效路径不得显示校验错误')
  const posts = postsOf(requests)
  assert.equal(posts.length, 1, '有效路径仍只能发一次 POST')
  assert.equal(posts[0][0], '/session-superagent/watch')
  const body = JSON.parse(posts[0][1].body)
  assert.equal(body.repo, 'acme/widgets')
  assert.equal(body.sessionId, 's1')
  assert.equal(body.intervalSec, 90)
})

function deferred() {
  let resolve
  let reject
  const promise = new Promise((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

function applyCalls(queue, calls) {
  const next = [...queue]
  for (const call of calls) next[call.index] = call.next
  return next
}

function toastCalls(client) {
  return client.stateCalls().filter((call) => call.index === 7 && call.next && typeof call.next.text === 'string')
}

function goalSyncEffect(client) {
  const effect = client.effects.filter((item) => String(item.create).includes('setGoalDraft')
    && String(item.create).includes('goalTouched')).at(-1)
  assert.ok(effect, '找不到 goal 服务端值同步 effect')
  return effect
}

function pendingSaveState(section) {
  const state = snapshot()
  state.body.sessionGoal = { objective: '服务端旧 goal', phase: 'active', revision: 1 }
  const queue = deskQueue(state, null, {}, 'settings')
  queue[14] = section
  return queue
}

test('空凭证草稿禁用保存；即使直接调用也不发 {} POST 或 Toast 成功', async () => {
  const requests = []
  const client = loadClient({
    primitives: HOST,
    fetch: async (url, init) => {
      requests.push([url, init])
      return response(init?.method === 'POST' ? { ok: true } : snapshot().body)
    },
  })
  const nodes = nodesOf(client, pendingSaveState('creds'))
  const save = control(nodes, '保存凭证')
  const result = await save.props.onClick()
  assert.equal(postsOf(requests).length, 0, '没有 token/giteeToken/ghDir 改动时不得发空 POST：' + JSON.stringify(requests))
  assert.equal(result, false, '空凭证保存不能返回成功')
  assert.equal(toastCalls(client).some((call) => call.next.text === '凭证已保存'), false,
    '空凭证不得 Toast 成功：' + JSON.stringify(toastCalls(client)))
  assert.equal(save.props.disabled, true, '空凭证保存按钮必须禁用')
})

test('goal 有包含可见标签的 AX name；无 session 时说明原因并禁止编辑与保存', async () => {
  const requests = []
  const client = loadClient({
    primitives: HOST,
    fetch: async (url, init) => {
      requests.push([url, init])
      return response(init?.method === 'POST' ? { ok: true } : snapshot().body)
    },
  })
  const queue = pendingSaveState('goal')
  queue[5] = '无会话时不应提交的 goal'
  queue[6] = true
  const nodes = nodesOf(client, queue)
  const textarea = one(nodes.filter((node) => node.type === 'textarea'), '缺唯一 goal textarea')
  assert.equal(textarea.props['aria-label'], '会话 goal', 'AX name 必须包含可见标签「会话 goal」')
  assert.equal(textarea.props.disabled, true, '无 sessionId 时 goal 编辑必须禁用')
  assert.ok(textOf(nodes).includes('没有会话上下文，无法编辑或保存 goal'), '必须在 goal 分区说明禁用原因：' + textOf(nodes))

  const save = control(nodes, '保存 goal')
  assert.equal(save.props.disabled, true, '无 sessionId 时保存必须禁用')
  const result = await save.props.onClick()
  assert.equal(postsOf(requests).length, 0, '无 sessionId 时即使直接调用保存也不得 POST：' + JSON.stringify(requests))
  assert.equal(result, false, '无 sessionId 保存不能返回成功')
  assert.equal(toastCalls(client).some((call) => call.next.text === 'goal 已保存'), false,
    '无 sessionId 不得 Toast 成功：' + JSON.stringify(toastCalls(client)))
})

test('凭证 pending 新输入与重复点击：晚到的旧成功不得清掉新草稿，且只能有一个 POST', async () => {
  const post = deferred()
  const requests = []
  const client = loadClient({
    fetch: (url, init) => {
      requests.push([url, init])
      if (init?.method === 'POST') return post.promise
      return Promise.resolve(response(snapshot().body))
    },
  })
  const queue = pendingSaveState('creds')
  queue[4] = 'old-github'
  queue[19] = 'D:/old-gh'
  queue[20] = 'old-gitee'
  const nodes = nodesOf(client, queue)
  const save = control(nodes, '保存凭证')
  const pending = save.props.onClick()
  assert.equal(await save.props.onClick(), false, 'pending 重复点击必须由 busyRef 拒绝')
  assert.equal(postsOf(requests).length, 1, '重复点击不得产生第二个 POST')

  for (const [value, next] of [['old-github', 'new-github'], ['old-gitee', 'new-gitee'], ['D:/old-gh', 'D:/new-gh']]) {
    one(nodes.filter((node) => node.type === 'input' && node.props.value === value), '缺凭证输入 ' + value)
      .props.onChange({ target: { value: next } })
  }
  client.resetStateCalls()
  post.resolve(response({ ok: true }))
  assert.equal(await pending, true)
  const calls = client.stateCalls()
  for (const [index, next] of [[4, ''], [19, ''], [20, '']]) {
    assert.equal(calls.some((call) => call.index === index && call.next === next), false,
      '旧保存响应不得清空 pending 后的新输入：' + JSON.stringify(calls))
  }
  assert.deepEqual(JSON.parse(postsOf(requests)[0][1].body), {
    token: 'old-github', giteeToken: 'old-gitee', ghConfigDir: 'D:/old-gh',
  }, '请求必须保存点击时的快照，而不是 pending 中改写后的值')
})

test('goal pending 新输入与重复点击：旧响应不得标 clean 或回写旧 goal，且只能有一个 POST', async () => {
  const post = deferred()
  const requests = []
  const state = snapshot()
  state.body.sessionGoal = { objective: '点击时 goal', phase: 'active', revision: 2 }
  const client = loadClient({
    fetch: (url, init) => {
      requests.push([url, init])
      if (init?.method === 'POST') return post.promise
      return Promise.resolve(response(state.body))
    },
  })
  const queue = pendingSaveState('goal')
  queue[5] = '点击时 goal'
  queue[6] = true
  const nodes = nodesOf(client, queue, { sessionId: 's1' })
  const save = control(nodes, '保存 goal')
  const pending = save.props.onClick()
  assert.equal(await save.props.onClick(), false, 'pending 重复点击必须由 busyRef 拒绝')
  assert.equal(postsOf(requests).length, 1, '重复点击不得产生第二个 POST')
  one(nodes.filter((node) => node.type === 'textarea'), '缺 goal textarea')
    .props.onChange({ target: { value: 'pending 中的新 goal' } })
  client.resetStateCalls()
  post.resolve(response({ ok: true }))
  assert.equal(await pending, true)
  assert.equal(client.stateCalls().some((call) => call.index === 6 && call.next === false), false,
    'pending 后有新输入时不得把 dirty 清成 false：' + JSON.stringify(client.stateCalls()))
  assert.equal(client.stateCalls().some((call) => call.index === 5), false,
    '旧保存响应不得直接改写新 goal 草稿')
  assert.equal(JSON.parse(postsOf(requests)[0][1].body).objective, '点击时 goal')
})

test('凭证 POST200+GET500：不得 Toast 成功或清草稿，显示可重试回读错误', async () => {
  const requests = []
  const client = loadClient({
    fetch: async (url, init) => {
      requests.push([url, init])
      if (init?.method === 'POST') return response({ ok: true })
      return response({ error: 'state offline' }, false, 500)
    },
  })
  const queue = pendingSaveState('creds')
  queue[4] = 'github-secret'
  queue[19] = 'D:/gh'
  queue[20] = 'gitee-secret'
  const save = control(nodesOf(client, queue), '保存凭证')
  assert.equal(await save.props.onClick(), false, '回读失败不能返回保存成功')
  assert.equal(toastCalls(client).some((call) => call.next.text === '凭证已保存'), false,
    'POST200+GET500 不得 Toast 成功：' + JSON.stringify(toastCalls(client)))
  assert.ok(toastCalls(client).some((call) => call.next.tone === 'error' && /回读失败.*重试/.test(call.next.text)),
    '必须显示可重试的回读错误：' + JSON.stringify(toastCalls(client)))
  for (const index of [4, 19, 20]) {
    assert.equal(client.stateCalls().some((call) => call.index === index && call.next === ''), false,
      '回读失败必须保留凭证草稿')
  }
})

test('goal POST200+GET500：不得 Toast 成功、标 clean 或让旧服务端值覆盖 dirty 草稿', async () => {
  const state = snapshot()
  state.body.sessionGoal = { objective: '服务端旧 goal', phase: 'active', revision: 1 }
  const client = loadClient({
    fetch: async (url, init) => init?.method === 'POST'
      ? response({ ok: true })
      : response({ error: 'state offline' }, false, 500),
  })
  const queue = pendingSaveState('goal')
  queue[5] = '待保存的新 goal'
  queue[6] = true
  const save = control(nodesOf(client, queue, { sessionId: 's1' }), '保存 goal')
  assert.equal(await save.props.onClick(), false, '回读失败不能返回保存成功')
  assert.equal(toastCalls(client).some((call) => call.next.text === 'goal 已保存'), false,
    'POST200+GET500 不得 Toast 成功：' + JSON.stringify(toastCalls(client)))
  assert.ok(toastCalls(client).some((call) => call.next.tone === 'error' && /回读失败.*重试/.test(call.next.text)),
    '必须显示可重试的回读错误：' + JSON.stringify(toastCalls(client)))
  assert.equal(client.stateCalls().some((call) => call.index === 6 && call.next === false), false,
    '回读失败不得把 dirty 清成 false')

  // 模拟真实 React 在 async setter 后重渲染并运行 effect：旧实现会在这里回写服务端旧 goal。
  const rerendered = applyCalls(queue, client.stateCalls())
  client.resetStateCalls()
  nodesOf(client, rerendered, { sessionId: 's1' })
  goalSyncEffect(client).create()
  assert.equal(client.stateCalls().some((call) => call.index === 5 && call.next === '服务端旧 goal'), false,
    '回读失败后不得回写旧 goal：' + JSON.stringify(client.stateCalls()))
})

test('sessionGoal:null 同步清空干净草稿，但不误清 dirty 草稿', () => {
  const client = loadClient()
  const clean = pendingSaveState('goal')
  clean[0] = { ...clean[0], body: { ...clean[0].body, sessionGoal: null } }
  clean[5] = '此前已保存 goal'
  clean[6] = false
  nodesOf(client, clean)
  client.resetStateCalls()
  goalSyncEffect(client).create()
  assert.ok(client.stateCalls().some((call) => call.index === 5 && call.next === ''),
    'sessionGoal:null 必须清空已保存值：' + JSON.stringify(client.stateCalls()))

  const dirty = pendingSaveState('goal')
  dirty[0] = { ...dirty[0], body: { ...dirty[0].body, sessionGoal: null } }
  dirty[5] = '尚未保存的输入'
  dirty[6] = true
  nodesOf(client, dirty)
  client.resetStateCalls()
  goalSyncEffect(client).create()
  assert.equal(client.stateCalls().some((call) => call.index === 5), false,
    'sessionGoal:null 不得误清 dirty 草稿')
})

test('乱序 /state 响应：后到的旧响应不得覆盖新快照或 dirty goal', async () => {
  const older = deferred()
  const newer = deferred()
  const states = [older, newer]
  const requests = []
  const client = loadClient({
    fetch: (url) => {
      requests.push(url)
      if (!isStateUrl(url)) return Promise.resolve(response({}))
      assert.ok(states.length > 0, '只能有两次 /state：' + JSON.stringify(requests))
      return states.shift().promise
    },
  })
  const queue = pendingSaveState('goal')
  queue[5] = 'dirty 输入'
  queue[6] = true
  const nodes = nodesOf(client, queue, { sessionId: 's1' })
  const refresh = control(nodes, '刷新')
  const first = refresh.props.onClick()
  const second = refresh.props.onClick()
  assert.deepEqual(requests.filter(isStateUrl), ['/session-superagent/state?sessionId=s1', '/session-superagent/state?sessionId=s1'],
    'fixture 必须看见并保留完整 sessionId query，不能用 endsWith 把它隐藏')
  const newBody = { ...snapshot().body, sessionGoal: { objective: '新服务端 goal', phase: 'active', revision: 3 } }
  const oldBody = { ...snapshot().body, sessionGoal: { objective: '旧服务端 goal', phase: 'active', revision: 1 } }
  newer.resolve(response(newBody))
  await new Promise((resolve) => setImmediate(resolve))
  older.resolve(response(oldBody))
  await Promise.all([first, second])
  const snaps = client.stateCalls().filter((call) => call.index === 0 && call.next && call.next.body)
  assert.ok(snaps.some((call) => call.next.body.sessionGoal?.objective === '新服务端 goal'),
    '必须接收较新的响应：' + JSON.stringify(client.stateCalls()))
  assert.equal(snaps.some((call) => call.next.body.sessionGoal?.objective === '旧服务端 goal'), false,
    '后到的旧响应必须被 loadSeqRef 丢弃：' + JSON.stringify(snaps))
  assert.equal(client.stateCalls().some((call) => call.index === 5), false, '乱序响应不得直接改写 dirty goal')
})

test('无 pending 新输入的成功保存仍在 GET 后清凭证并标 goal clean', async () => {
  const requests = []
  const client = loadClient({
    fetch: async (url, init) => {
      requests.push([url, init])
      return response(init?.method === 'POST' ? { ok: true } : snapshot().body)
    },
  })
  const creds = pendingSaveState('creds')
  creds[4] = 'github-secret'
  creds[19] = 'D:/gh'
  creds[20] = 'gitee-secret'
  await control(nodesOf(client, creds), '保存凭证').props.onClick()
  for (const index of [4, 19, 20]) {
    assert.ok(client.stateCalls().some((call) => call.index === index && call.next === ''), '成功后应清理已提交字段 ' + index)
  }

  const goal = pendingSaveState('goal')
  goal[5] = '新 goal'
  goal[6] = true
  await control(nodesOf(client, goal, { sessionId: 's1' }), '保存 goal').props.onClick()
  assert.ok(client.stateCalls().some((call) => call.index === 6 && call.next === false), '成功回读后应标 goal clean')
})

function draftGuardQueue() {
  const state = snapshot()
  state.body.watchers = [
    watcher('a/b', { id: 'a/b#s1', sessionId: 's1', intervalSec: 60, note: '已经保存的规则' }),
    watcher('c/d', { id: 'c/d#s2', sessionId: 's2', intervalSec: 120, note: '另一条已保存规则' }),
  ]
  return deskQueue(state, 'a/b#s1', { intervalSec: '90', goal: '尚未保存的草稿' })
}

function watcherTitle(nodes, repo) {
  return one(nodes.filter((node) => node.type === 'button' && hasClass(node, 'dt-open') && nodeText(node) === repo),
    '找不到 watcher 标题 ' + repo)
}

function applyRootCalls(queue, client) {
  return applyCalls(queue, client.stateCalls().filter((call) => call.index < 23))
}

test('dirty 折叠：取消与 Escape 保留草稿和 touched 表单，确认放弃才收起且全程零 POST', async () => {
  const requests = []
  const client = loadClient({
    primitives: HOST,
    fetch: async (url, init) => { requests.push([url, init]); return response({}) },
  })
  const queue = draftGuardQueue()
  client.resetStateCalls()
  watcherTitle(nodesOf(client, queue), 'a/b').props.onClick()
  assert.equal(client.stateCalls().some((call) => call.index === 8 && call.next !== null), false,
    'dirty 折叠只能挂起 editing，不能切到别的 watcher')
  assert.equal(client.stateCalls().some((call) => call.index === 9), false, 'dirty 折叠不能直接重置 draft')

  const confirming = applyRootCalls(queue, client)
  const opened = nodesOf(client, confirming)
  assert.equal(opened.filter((node) => node.type === 'form' && node.props['data-mode'] === 'edit').length, 1,
    '确认期间原 dirty 表单必须继续挂载')
  const modal = hostModal(opened)
  assert.equal(modal.props.open, true)
  assert.equal(modal.props.title, '放弃未保存的修改？')
  assert.ok(modal.props.description.includes('收起'), '折叠确认必须说明实际动作')
  const footer = walk(modal.props.footer)
  control(footer, '放弃并收起')
  assert.equal(postsOf(requests).length, 0, '打开 dirty 确认不能发 POST')

  client.resetStateCalls()
  modal.props.onClose() // DSH Modal 的 Escape / 遮罩 / 关闭共用此入口。
  const escaped = applyRootCalls(confirming, client)
  assert.equal(escaped[8], 'a/b#s1')
  assert.strictEqual(escaped[9], confirming[9], 'Escape 必须原样保留 dirty draft')
  assert.equal(escaped[11], false)
  assert.equal(one(nodesOf(client, escaped).filter((node) => node.type === HOST.Input
    && node.props.type === 'number' && node.props.value === '90'), 'Escape 后 dirty 表单必须仍显示未保存值').props.value, '90')
  assert.ok(textOf(nodesOf(client, escaped)).includes('未保存'), 'Escape 后 touched/dirty SaveBar 不能消失')

  client.resetStateCalls()
  watcherTitle(nodesOf(client, escaped), 'a/b').props.onClick()
  const reopened = applyRootCalls(escaped, client)
  const reopenedModal = hostModal(nodesOf(client, reopened))
  client.resetStateCalls()
  reopenedModal.props.onClose()
  const cancelled = applyRootCalls(reopened, client)
  assert.strictEqual(cancelled[9], reopened[9], '取消必须保留同一份草稿')

  client.resetStateCalls()
  watcherTitle(nodesOf(client, cancelled), 'a/b').props.onClick()
  const discardQueue = applyRootCalls(cancelled, client)
  const discardModal = hostModal(nodesOf(client, discardQueue))
  const confirm = control(walk(discardModal.props.footer), '放弃并收起')
  client.resetStateCalls()
  const first = confirm.props.onClick()
  assert.equal(await confirm.props.onClick(), false, '确认连点必须被同一 busy 锁挡住')
  assert.equal(await first, true)
  const closed = applyRootCalls(discardQueue, client)
  assert.equal(closed[8], null, '只有确认放弃才收起')
  assert.equal(closed[11], false)
  assert.equal(nodesOf(client, closed).filter((node) => node.type === 'form'
    && node.props['data-mode'] === 'edit').length, 0, '确认收起后编辑表单必须卸载')
  assert.equal(postsOf(requests).length, 0, '折叠确认/取消/连点都不能产生意外 POST')
})

test('dirty 切换：取消留在原 dirty 表单，确认才载入目标 watcher 的干净快照且零 POST', async () => {
  const requests = []
  const client = loadClient({
    primitives: HOST,
    fetch: async (url, init) => { requests.push([url, init]); return response({}) },
  })
  const queue = draftGuardQueue()
  client.resetStateCalls()
  watcherTitle(nodesOf(client, queue), 'c/d').props.onClick()
  assert.equal(client.stateCalls().some((call) => call.index === 8), false, 'dirty 切换不能直接换 editing')
  assert.equal(client.stateCalls().some((call) => call.index === 9), false, 'dirty 切换不能直接覆盖 draft')

  const confirming = applyRootCalls(queue, client)
  const modal = hostModal(nodesOf(client, confirming))
  assert.ok(modal.props.description.includes('c/d'), '切换确认必须点出目标 watcher')
  const cancel = control(walk(modal.props.footer), '取消')
  client.resetStateCalls()
  cancel.props.onClick()
  const cancelled = applyRootCalls(confirming, client)
  assert.equal(cancelled[8], 'a/b#s1')
  assert.strictEqual(cancelled[9], confirming[9], '取消切换必须保留原 dirty draft')
  const cancelledNodes = nodesOf(client, cancelled)
  assert.ok(one(cancelledNodes.filter((node) => node.type === HOST.Input
    && node.props.value === '尚未保存的草稿'), '取消后原 goal 草稿必须仍在'))
  assert.ok(textOf(cancelledNodes).includes('未保存'), '取消后 touched/dirty 状态必须一致保留')

  client.resetStateCalls()
  watcherTitle(cancelledNodes, 'c/d').props.onClick()
  const retryQueue = applyRootCalls(cancelled, client)
  const retryModal = hostModal(nodesOf(client, retryQueue))
  client.resetStateCalls()
  assert.equal(await control(walk(retryModal.props.footer), '放弃并切换').props.onClick(), true)
  const switched = applyRootCalls(retryQueue, client)
  assert.equal(switched[8], 'c/d#s2', '确认后才切到目标 watcher')
  assert.equal(switched[9].intervalSec, '120', '切到目标后必须载入目标原值，不能带旧 dirty 数字')
  assert.equal(switched[9].goal, '另一条已保存规则', '切回/切换后的文案必须来自目标快照')
  assert.equal(switched[11], false)
  const switchedNodes = nodesOf(client, switched)
  assert.ok(one(switchedNodes.filter((node) => node.type === HOST.Input
    && node.props.value === '另一条已保存规则'), '目标 watcher 的已保存文案必须显示'))
  assert.equal(switchedNodes.filter((node) => node.type === HOST.Input && node.props.value === '尚未保存的草稿').length, 0,
    '确认放弃后旧草稿不能泄漏到目标 watcher')
  assert.equal(postsOf(requests).length, 0, '切换确认与取消都不能产生意外 POST')
})

test('无 dirty 折叠与切换保持原直达行为，不弹确认也不发 POST', () => {
  const requests = []
  const client = loadClient({
    primitives: HOST,
    fetch: async (url, init) => { requests.push([url, init]); return response({}) },
  })
  const queue = draftGuardQueue()
  queue[9] = {}

  client.resetStateCalls()
  watcherTitle(nodesOf(client, queue), 'c/d').props.onClick()
  const switched = applyRootCalls(queue, client)
  assert.equal(switched[8], 'c/d#s2')
  assert.equal(switched[11], false, 'clean 切换不能打开确认')
  assert.equal(nodesOf(client, switched).filter((node) => node.type === HOST.Modal).length, 0)

  client.resetStateCalls()
  watcherTitle(nodesOf(client, switched), 'c/d').props.onClick()
  const closed = applyRootCalls(switched, client)
  assert.equal(closed[8], null)
  assert.equal(closed[11], false, 'clean 折叠不能打开确认')
  assert.equal(postsOf(requests).length, 0)
})
