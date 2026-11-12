import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

import { deskQueue, watcher } from './fixtures/panel-harness.mjs'

const SOURCE = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
// 只在测试内存中暴露同一个 InfoTip，用于覆盖主面板现有调用点没有用到的 warn/icon 参数。
// 主路径用例仍执行未改行为的 ZhuliPanel；不会向磁盘上的 client.js 加测试出口。
const INSTRUMENTED_SOURCE = SOURCE.replace(
  "      inject: ['slots'],",
  "      __testInfoTip: InfoTip,\n      inject: ['slots'],",
)
assert.notEqual(INSTRUMENTED_SOURCE, SOURCE, '测试必须能暴露 client.js 内部的同一个 InfoTip')

const PRIMITIVES_MODULE = '@deepseek-ai/dsh-client-ui-primitives'
const HOST = Object.freeze({
  Modal: 'dsh-host-modal',
  Toast: 'dsh-host-toast',
  Tooltip: 'dsh-host-tooltip',
  IconWarningOutlineMedium: 'dsh-host-warning-icon',
})
const { Tooltip: _tooltip, ...HOST_WITHOUT_TOOLTIP } = HOST
const JUDGE_HINT = '每轮判定都会记一条：唤醒、仅观察，或跳过及其原因。只存最近若干条。'

function response(body, ok = true, status = 200) {
  return { ok, status, headers: { get: () => null }, text: async () => JSON.stringify(body) }
}

/** 执行真实 UMD factory；effects 记录但不自动跑，scroll 用例显式执行并清理。 */
function loadClient(options = {}) {
  let mod = null
  const windowRegistrations = []
  const removals = []
  const effects = []
  const stateCalls = []
  const hooks = { queue: [], index: 0 }
  let currentComponent = ''

  const sandbox = {
    window: {
      __ModuleLoader__: { load(value) { mod = value } },
      innerWidth: 1440,
      innerHeight: 900,
      addEventListener(...args) { windowRegistrations.push(args) },
      removeEventListener(...args) { removals.push(args) },
    },
    document: {
      getElementById: () => null,
      createElement: () => ({ id: '', textContent: '' }),
      head: { appendChild() {} },
      addEventListener() {},
      removeEventListener() {},
    },
    navigator: { clipboard: { writeText: async () => {} } },
    fetch: options.fetch || (async () => response({ watchers: [] })),
    setInterval: () => 0,
    clearInterval() {},
    setTimeout: () => 1,
    clearTimeout() {},
    queueMicrotask: (fn) => fn(),
    console,
  }
  vm.createContext(sandbox)
  vm.runInContext(INSTRUMENTED_SOURCE, sandbox)
  assert.ok(mod, 'client.js 必须调用 __ModuleLoader__.load')

  const React = {
    Fragment: Symbol('Fragment'),
    createElement(type, props, ...children) {
      const { key, ...rest } = props || {}
      const node = {
        type,
        props: { ...rest, children: children.flat(Infinity).filter((child) => child !== null && child !== undefined && child !== false) },
      }
      if (key !== undefined) node.key = key
      return node
    },
    isValidElement: (value) => Boolean(value && typeof value === 'object' && 'type' in value),
    forwardRef(render) {
      return function ForwardRef(props = {}) {
        return render(props, props.ref || null)
      }
    },
    memo: (fn) => fn,
    useState(initial) {
      const index = hooks.index
      if (index >= hooks.queue.length) {
        hooks.queue[index] = typeof initial === 'function' ? initial() : initial
      }
      hooks.index += 1
      const setter = (next) => {
        const current = hooks.queue[index]
        const resolved = typeof next === 'function' ? next(current) : next
        hooks.queue[index] = resolved
        stateCalls.push({ index, next: resolved })
      }
      return [hooks.queue[index], setter]
    },
    useEffect(create, deps) {
      effects.push({ create, deps, component: currentComponent })
    },
    useCallback: (fn) => fn,
    useRef: (value) => ({ current: value }),
  }

  function walk(node, out = []) {
    if (node === null || node === undefined || node === false) return out
    if (Array.isArray(node)) {
      for (const child of node) walk(child, out)
      return out
    }
    if (typeof node === 'string' || typeof node === 'number') {
      out.push({ type: '#text', text: String(node), props: { children: [] } })
      return out
    }
    if (typeof node !== 'object') return out
    if (typeof node.type === 'function') {
      const previous = currentComponent
      currentComponent = node.type.name || 'Anonymous'
      try {
        return walk(node.type(node.props || {}), out)
      } finally {
        currentComponent = previous
      }
    }
    out.push(node)
    for (const child of node.props?.children || []) walk(child, out)
    return out
  }

  const slotRegistrations = []
  const ctx = {
    effect: (fn) => fn(),
    slots: {
      inject: (_name, fn) => fn(),
      register(opts, Component) {
        slotRegistrations.push({ opts, Component })
        return () => {}
      },
    },
  }
  const api = mod.factory((name) => {
    if (name === 'react') return React
    if (name === PRIMITIVES_MODULE) {
      if (options.primitives === undefined) throw new Error('MODULE_NOT_FOUND: ' + name)
      return options.primitives
    }
    throw new Error('unexpected require: ' + name)
  })
  api.apply(ctx)

  const render = (Component, props, queue) => {
    hooks.queue = queue || []
    hooks.index = 0
    effects.length = 0
    currentComponent = Component.name || 'Anonymous'
    let tree
    try {
      tree = Component(props || {})
    } finally {
      currentComponent = ''
    }
    return { tree, nodes: walk(tree), queue: hooks.queue }
  }

  return {
    registrations: slotRegistrations,
    windowRegistrations,
    removals,
    effects,
    stateCalls,
    desk: slotRegistrations.find((entry) => entry.opts.id === 'session-superagent-desk'),
    renderDesk(queue, props = {}) {
      const registration = slotRegistrations.find((entry) => entry.opts.id === 'session-superagent-desk')
      return render(registration.Component, props, queue)
    },
    renderInfoTip(props, queue = []) {
      return render(api.__testInfoTip, props, queue)
    },
  }
}

function snapshot() {
  return {
    loading: false,
    error: null,
    body: {
      sessionGoal: null,
      sessionTitle: 'L84 Tooltip',
      credentials: {},
      gh: { ok: true },
      defaults: {},
      watchers: [watcher('a/b')],
    },
  }
}

function judgeQueue() {
  const queue = deskQueue(snapshot(), null, {}, 'judge')
  queue[7] = null
  return queue
}

function one(items, message) {
  assert.equal(items.length, 1, message + '；实际 ' + items.length)
  return items[0]
}

function hostTooltip(nodes) {
  return one(nodes.filter((node) => node.type === HOST.Tooltip), '必须有唯一 DSH Tooltip')
}

function infoButtons(nodes, text) {
  return nodes.filter((node) => node.type === 'button'
    && String(node.props?.className || '').split(/\s+/).includes('dt-info')
    && (text === undefined || node.props['aria-label'] === text))
}

function localBubbles(nodes) {
  return nodes.filter((node) => String(node.props?.className || '').split(/\s+/).includes('dt-tooltip'))
}

function nodeText(node) {
  if (node === null || node === undefined || node === false) return ''
  if (node.type === '#text') return node.text
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  return (node.props?.children || []).map(nodeText).join('')
}

test('主面板实际路径：InfoTip 使用 DSH 参数与原 button.dt-info，不渲染本地 bubble', () => {
  const client = loadClient({ primitives: HOST })
  const { nodes } = client.renderDesk(judgeQueue())
  const tooltip = hostTooltip(nodes)
  assert.equal(tooltip.key, 0)
  assert.equal(tooltip.props.label, JUDGE_HINT)
  assert.equal(tooltip.props.side, 'top')
  assert.equal(tooltip.props.portal, true)
  assert.equal(tooltip.props.openOnClick, true)
  assert.equal(tooltip.props.gap, 8)
  assert.equal(Object.hasOwn(tooltip.props, 'open'), false, '不得虚构受控 open API')
  assert.equal(Object.hasOwn(tooltip.props, 'onOpenChange'), false, '不得虚构 onOpenChange API')

  const trigger = one(infoButtons(nodes, JUDGE_HINT), '主面板缺原 InfoTip trigger')
  assert.equal(trigger.props.type, 'button')
  assert.equal(trigger.props.className, 'dt-info')
  assert.equal(trigger.props['aria-expanded'], false)
  assert.equal(localBubbles(nodes).length, 0)
  assert.ok(nodes.some((node) => node.type === 'svg'), 'trigger 仍使用现有 Icon')
})

test('InfoTip({text,icon,warn})：warn/trigger 文案保留，aria-expanded 映射 DSH describedby，事件与 ref 由宿主接管', () => {
  const client = loadClient({ primitives: HOST })
  const text = '风险说明原文'
  const { nodes } = client.renderInfoTip({ text, icon: 'alert', warn: true })
  const tooltip = hostTooltip(nodes)
  const trigger = one(infoButtons(nodes, text), '缺 warn InfoTip trigger')
  assert.equal(trigger.props.className, 'dt-info dt-info-warn')
  assert.equal(trigger.props['aria-label'], text)
  assert.equal(trigger.props['aria-expanded'], false)

  // 模拟安装版 Tooltip 的真实 clone 合同：describedby + handlers + ref 落到 trigger。
  const rawTrigger = tooltip.props.children[0]
  const hostHandlers = { onMouseEnter() {}, onFocus() {}, onClick() {}, onBlur() {} }
  const hostRefCalls = []
  const hostRef = (node) => { hostRefCalls.push(node) }
  const mapped = rawTrigger.type({
    ...rawTrigger.props,
    ...hostHandlers,
    ref: hostRef,
    'aria-describedby': 'dsh-tooltip-42',
  })
  assert.equal(mapped.type, 'button')
  assert.equal(mapped.props['aria-describedby'], 'dsh-tooltip-42')
  assert.equal(mapped.props['aria-expanded'], true)
  assert.notEqual(mapped.props.ref, hostRef, '适配层需要合并自己的 triggerRef，不能简单丢掉它')
  const triggerNode = { id: 'trigger-node' }
  mapped.props.ref(triggerNode)
  assert.equal(rawTrigger.props.triggerRef.current, triggerNode, '适配 ref 必须收到真实节点')
  assert.deepEqual(hostRefCalls, [triggerNode], '原 hostRef 也必须收到同一节点')
  for (const [name, handler] of Object.entries(hostHandlers)) assert.strictEqual(mapped.props[name], handler)
})

test('主面板 scroll-close：capture scroll 函数式递增 key，effect 清理用同一 listener/capture 解绑', () => {
  const client = loadClient({ primitives: HOST })
  const queue = judgeQueue()
  const first = client.renderDesk(queue)
  assert.equal(hostTooltip(first.nodes).key, 0)
  const hostEffects = client.effects.filter((item) => item.component === 'HostTooltip')
  const effect = one(hostEffects.filter((item) => Array.isArray(item.deps) && item.deps.length === 0), '主面板缺 scroll effect')
  assert.ok(hostEffects.some((item) => Array.isArray(item.deps) && item.deps.length === 1 && item.deps[0] === 0), '缺 remountKey 焦点恢复 effect')
  assert.ok(Array.isArray(effect.deps), 'HostTooltip effect 必须声明依赖数组')
  assert.equal(effect.deps.length, 0, 'scroll listener 只能在 mount/unmount 注册与清理')

  // 唯一允许的例外是页签名称跨页面同步用的 'storage'（apply 里挂、effect 清理时解绑）。
  // 其余任何 window listener 都不许在 effect 执行前出现 —— 这里断言「非 storage 集合为空」，
  // 比只数 scroll 更严：将来误挂第二个监听器会立刻红。
  assert.deepEqual(client.windowRegistrations.filter((item) => item[0] !== 'storage'), [],
    '除本功能的 storage 监听外，effect 执行前不得登记任何 window listener')
  const cleanup = effect.create()
  const registration = one(client.windowRegistrations.filter((item) => item[0] === 'scroll'), '缺 window scroll 监听')
  assert.equal(registration[0], 'scroll')
  assert.equal(registration[2], true)
  const listener = registration[1]
  assert.equal(typeof listener, 'function')
  assert.equal(listener({ type: 'scroll', target: { id: 'nested-panel-scroller' } }), undefined)

  const second = client.renderDesk(queue)
  assert.equal(hostTooltip(second.nodes).key, 1, 'scroll 后必须 remount DSH Tooltip 清除内部 pinned')
  assert.equal(hostTooltip(second.nodes).props.label, JUDGE_HINT)
  assert.equal(typeof cleanup, 'function')
  cleanup()
  const removal = one(client.removals.filter((item) => item[0] === 'scroll'), 'effect 清理必须解绑 scroll')
  assert.equal(removal[0], 'scroll')
  assert.strictEqual(removal[1], listener)
  assert.equal(removal[2], true)
})

test('fallback：require 缺失或仅缺 Tooltip 时，原 trigger 文案、warn、click/blur 与本地 bubble 完整保留', () => {
  for (const primitives of [undefined, HOST_WITHOUT_TOOLTIP]) {
    const client = loadClient({ primitives })
    assert.equal(client.registrations.length, 2)
    const text = '原样保留的说明'
    const first = client.renderInfoTip({ text, icon: 'alert', warn: true })
    assert.equal(first.nodes.filter((node) => node.type === HOST.Tooltip).length, 0)
    const closed = one(infoButtons(first.nodes, text), 'fallback 缺原 button')
    assert.equal(closed.props.className, 'dt-info dt-info-warn')
    assert.equal(closed.props['aria-expanded'], false)
    assert.equal(localBubbles(first.nodes).length, 0)

    closed.props.onClick()
    const opened = client.renderInfoTip({ text, icon: 'alert', warn: true }, first.queue)
    const expanded = one(infoButtons(opened.nodes, text), 'fallback 点击后缺 trigger')
    assert.equal(expanded.props['aria-expanded'], true)
    const bubble = one(localBubbles(opened.nodes), 'fallback 点击后缺原 dt-tooltip')
    assert.equal(bubble.props.role, 'tooltip')
    assert.equal(nodeText(bubble), text)
    assert.equal(bubble.props.style.position, 'absolute')
    assert.equal(bubble.props.style.bottom, '130%')

    expanded.props.onBlur()
    const blurred = client.renderInfoTip({ text, icon: 'alert', warn: true }, opened.queue)
    assert.equal(one(infoButtons(blurred.nodes, text), 'fallback blur 后缺 trigger').props['aria-expanded'], false)
    assert.equal(localBubbles(blurred.nodes).length, 0)
  }
})

test('主面板仅缺 Tooltip 时走本地 InfoTip，但已接入的 DSH Modal 不被连带降级', () => {
  const client = loadClient({ primitives: HOST_WITHOUT_TOOLTIP })
  const queue = judgeQueue()
  queue[11] = true
  const { nodes } = client.renderDesk(queue)
  assert.equal(nodes.filter((node) => node.type === HOST.Tooltip).length, 0)
  assert.equal(one(infoButtons(nodes, JUDGE_HINT), '主面板缺本地 InfoTip').props['aria-expanded'], false)
  assert.equal(localBubbles(nodes).length, 0, '本地 bubble 初始应保持关闭')
  assert.equal(one(nodes.filter((node) => node.type === HOST.Modal), 'DSH Modal 必须继续可用').props.open, true)
})
