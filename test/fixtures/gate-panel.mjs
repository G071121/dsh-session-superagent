/**
 * 门禁面板（GateSettings）的**异步**渲染桩。
 *
 * 为什么单独造一个：通用 panel-harness 的 `useEffect` 是空实现、hook 槽位也不持久，
 * 量不了「load 在途时切仓库 / 改草稿 / 卸挂载」这类竞态 —— 而那正是 U1 要修的东西。
 * 这里仍执行**真实 client.js**（源码里插一行调试出口暴露 GateSettings），只把
 * React 的最小运行时按语义补全：状态槽持久、effect 按依赖触发、卸载跑 cleanup、
 * setState 真的触发重渲染（而不是只记录调用）。
 *
 * 子组件（Section / Btn / Toggle …）**不展开**：断言只用 GateSettings 自己传下去的
 * props（id / value / onChange / onClick）与直接子字符串，避免这里再造一个 React。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const SOURCE = readFileSync(new URL('../../client.js', import.meta.url), 'utf8')

/**
 * GET /gates 的响应。每个仓库用不同的 user 层路径和提示词，才能在面板上区分
 * 「现在显示的到底是哪个仓库的数据」。
 */
export function gatePayload(repo, options = {}) {
  const rules = options.rules || [
    {
      id: 'secret',
      label: '禁止凭证与密钥',
      description: '回复里不能出现 token、私钥、Authorization 或 password 赋值。',
      severity: 'error',
      triggers: ['issue.reply', 'pr.reply', 'merge', 'release'],
      type: 'regex',
      pattern: 'ghp_[A-Za-z0-9]{20,}',
      message: '删掉凭证；需要引用时写 <redacted>。',
    },
    {
      id: 'abs-path',
      label: '禁止本机绝对路径',
      description: '不要贴 D: 盘或 /Users/ 这类本机路径。',
      severity: 'warn',
      triggers: ['issue.reply', 'pr.reply'],
      type: 'regex',
      pattern: '(?<![A-Za-z0-9])[A-Za-z]:[\\\\/]',
      message: '改成仓库相对路径，或只描述文件位置。',
    },
  ]
  const prompt = options.prompt === undefined ? '仓库 ' + repo + ' 的提示词' : options.prompt
  return {
    ok: true,
    repo,
    sources: [{ name: 'default', path: 'packages/dsh-gate/gates/default.json' }],
    config: {
      version: 1,
      name: 'default',
      rules,
      semantic: { enabled: false, model: 'group/deepseek-v4.1-flash-1017', prompt },
    },
    scopes: {
      default: { path: 'packages/dsh-gate/gates/default.json', exists: true, config: { rules } },
      user: { path: '/home/u/.dsh/state/session-superagent/gates.json', exists: false, config: null },
      project: { path: repo + '/.superagent/gates.json', exists: false, config: null },
      local: { path: repo + '/.superagent/gates.local.json', exists: false, config: null },
    },
  }
}

/** 与 test/client.test.mjs 的 raceResponse 同形，只多一个 JSON 正文出口。 */
export function gateResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    text: async () => (status === 304 ? '' : JSON.stringify(body)),
  }
}

export function gateDeferred() {
  let resolve
  let reject
  const promise = new Promise((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

/** 从请求 URL 里取 ?repo= 的值（client.js 会加 /session-superagent 前缀并 encodeURIComponent）。 */
export function gateUrlRepo(url) {
  const text = String(url)
  const at = text.indexOf('?')
  if (at < 0) return ''
  const query = text.slice(at + 1).split('&')
  for (const pair of query) {
    const [key, value] = pair.split('=')
    if (key === 'repo') return decodeURIComponent(value || '')
  }
  return ''
}

const sameDeps = (a, b) => {
  if (!Array.isArray(a) || !Array.isArray(b)) return false
  if (a.length !== b.length) return false
  return a.every((value, index) => Object.is(value, b[index]))
}

/**
 * 挂载 GateSettings。
 *
 * options.fetch：真实 fetch 的替身（测试自己决定什么时候 resolve，才能造乱序）。
 * options.repo：初始仓库 prop（默认 E:/work/demo）。
 */
export function loadGatePanel(options = {}) {
  const needle = "    return {\n      inject: ['slots'],"
  assert.ok(SOURCE.includes(needle), '找不到 client.js 的返回出口，无法暴露 GateSettings')
  const instrumented = SOURCE.replace(needle,
    '    window.__gatePanelInternals = { GateSettings }\n' + needle)

  let mod = null
  const fetchImpl = options.fetch || (() => Promise.resolve(gateResponse(gatePayload(options.repo || 'E:/work/demo'))))
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
    navigator: { clipboard: { writeText: async () => {} } },
    fetch: fetchImpl,
    setInterval: () => 0,
    clearInterval() {},
    // client.js 里 Toast 之类会排定时器；门禁页用不到，但沙箱里不能缺。
    setTimeout: () => 1,
    clearTimeout() {},
    queueMicrotask: (fn) => fn(),
    console,
  }
  vm.createContext(sandbox)
  vm.runInContext(instrumented, sandbox)
  assert.ok(mod, '异步门禁桩也必须执行真实 client.js')

  // ── 最小 React 运行时：状态槽持久 + effect 语义 + 卸载 guard ──────────────
  const stateSlots = []
  const refSlots = []
  const effectSlots = []
  const violations = []
  let stateCursor = 0
  let refCursor = 0
  let effectCursor = 0
  let collected = []
  let pending = false
  let mounted = true
  let tree = null

  const setStateAt = (index, next) => {
    const value = typeof next === 'function' ? next(stateSlots[index]) : next
    if (Object.is(value, stateSlots[index])) return
    if (!mounted) {
      // 真实 React 会警告「卸载后 setState 不生效」；门禁页应当靠 alive/seq 自己拦住。
      violations.push('卸载后仍然调用了第 ' + index + ' 个状态的 setter')
      return
    }
    stateSlots[index] = value
    pending = true
  }

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
    memo: (fn) => fn,
    useCallback: (fn) => fn,
    useState(initial) {
      const index = stateCursor++
      if (index >= stateSlots.length) stateSlots[index] = typeof initial === 'function' ? initial() : initial
      return [stateSlots[index], (next) => setStateAt(index, next)]
    },
    useRef(initial) {
      const index = refCursor++
      if (!refSlots[index]) refSlots[index] = { current: initial }
      return refSlots[index]
    },
    useEffect(fn, deps) {
      const index = effectCursor++
      collected.push({ index, fn, deps })
    },
  }

  const registrations = []
  const ctx = {
    effect: (fn) => fn(),
    slots: {
      inject: (_name, fn) => fn(),
      register(opts, Component) { registrations.push({ opts, Component }); return () => {} },
    },
  }
  mod.factory((name) => {
    if (name === 'react') return React
    throw new Error('unexpected require: ' + name)
  }).apply(ctx)
  const internals = sandbox.window.__gatePanelInternals
  assert.ok(internals && typeof internals.GateSettings === 'function', '调试出口里没有 GateSettings')

  let props = { repo: options.repo || 'E:/work/demo', notify: options.notify || (() => {}) }
  // StrictMode（开发态）双挂载：首轮 effect 跑完立刻 cleanup，再原样重跑一遍。
  // 只影响挂载，之后与普通模式一致。
  let strictEffects = Boolean(options.strictEffects)

  const runEffects = () => {
    for (const item of collected) {
      const prev = effectSlots[item.index]
      if (prev && sameDeps(prev.deps, item.deps)) continue
      if (prev && typeof prev.cleanup === 'function') prev.cleanup()
      const cleanup = item.fn()
      effectSlots[item.index] = { deps: item.deps, cleanup }
    }
  }

  /** 跑到没有新的 setState 为止（React 的 render → effect → 可能再 render）。 */
  const flush = () => {
    if (!mounted) return
    let guard = 0
    do {
      pending = false
      stateCursor = 0
      refCursor = 0
      effectCursor = 0
      collected = []
      tree = internals.GateSettings(props)
      runEffects()
      if (strictEffects) {
        strictEffects = false
        // mount → cleanup → mount：cleanup 必须能被随后的 effect 重跑复位，
        // 否则 alive 之类的 ref 会永远停在 false（真实 React StrictMode 的坑）。
        for (const slot of effectSlots) {
          if (slot && typeof slot.cleanup === 'function') slot.cleanup()
        }
        effectSlots.length = 0
        runEffects()
      }
      if (++guard > 50) throw new Error('门禁桩渲染没有收敛（effect 里在无限 setState？）')
    } while (pending)
  }

  const nodes = () => walkRaw(tree)
  const text = () => nodes().filter((node) => typeof node.text === 'string').map((node) => node.text).join(' | ')
  const control = (id) => {
    const found = nodes().find((node) => node.props && node.props.id === id)
    assert.ok(found, '找不到控件：' + id)
    return found
  }
  const button = (label) => {
    // 子组件（Btn / SegmentedControl …）不展开，所以这里按「带 onClick 且直接子串匹配」找。
    const found = nodes().find((node) => node.props && typeof node.props.onClick === 'function'
      && (node.props.children || []).includes(label))
    assert.ok(found, '找不到按钮：' + label)
    return found
  }

  flush()
  return {
    internals,
    nodes,
    text,
    control,
    button,
    /** 当前 12 个状态槽（诊断用；断言仍以渲染结果为主）。 */
    values: () => stateSlots.slice(0, 12),
    /** 把仓库 prop 换掉并重渲染（模拟 /state 后到或 watcher 换仓库）。 */
    setRepo(next) {
      props = { ...props, repo: next }
      flush()
    },
    flush,
    /** 排空异步链：先 flush 渲染，再让微任务/下一轮 timers 跑完，再 flush。 */
    async settle(rounds = 6) {
      for (let i = 0; i < rounds; i += 1) {
        flush()
        await new Promise((resolve) => setTimeout(resolve, 0))
      }
      flush()
    },
    unmount() {
      mounted = false
      for (const slot of effectSlots) {
        if (slot && typeof slot.cleanup === 'function') slot.cleanup()
      }
    },
    violations: () => violations.slice(),
    isMounted: () => mounted,
  }
}

/** 只走 props.children 的展开：不调用子组件（它们可能自己用 hook）。 */
function walkRaw(node, out = []) {
  if (node === null || node === undefined || node === false) return out
  if (typeof node === 'string' || typeof node === 'number') {
    out.push({ type: '#text', text: String(node) })
    return out
  }
  if (typeof node !== 'object') return out
  out.push(node)
  for (const child of node.props?.children || []) walkRaw(child, out)
  return out
}
