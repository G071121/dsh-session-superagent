// 面板渲染桩：不用浏览器，用假 React 跑真实 client.js。
//
// 为什么抽成模块：测试与「面板文案快照」脚本都要用它 —— 两份实现必然漂移。
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const SOURCE = readFileSync(fileURLToPath(new URL('../../client.js', import.meta.url)), 'utf8')

/**
 * 把 client.js 装进一个最小浏览器沙箱，返回它注册的槽位条目。
 *
 * options.fetch：替换沙箱里的 fetch，用来复现「服务端回 304 / 报错」这类分支。
 * 不传时保持老行为（永远 200 + `{}`），已有用例不受影响。
 */
export function loadClient(options = {}) {
  let mod = null
  // setTimeout 的登记表（用例调 flushTimers() 才真的执行）+ 微任务队列
  const timers = []
  const micro = []
  // window 级监听要能被用例触发（页签名称靠 'storage' 事件跟随其它页面）：
  // 以前 addEventListener 是空函数，注册了也永远收不到事件 —— 桩比运行时干净就会掩盖 bug。
  const windowListeners = new Map()
  const sandbox = {
    window: {
      __ModuleLoader__: { load(m) { mod = m } },
      innerWidth: 1440,
      innerHeight: 900,
      addEventListener(type, fn) {
        if (typeof fn !== 'function') return
        if (!windowListeners.has(type)) windowListeners.set(type, new Set())
        windowListeners.get(type).add(fn)
      },
      removeEventListener(type, fn) {
        const set = windowListeners.get(type)
        if (set) set.delete(fn)
      },
    },
    document: {
      getElementById: () => null,
      createElement: () => ({ id: '', textContent: '' }),
      head: { appendChild() {} },
      addEventListener() {},
      removeEventListener() {},
    },
    fetch: options.fetch || (() => Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve('{}') })),
    // 页签名称的本地覆盖存在 localStorage 里（本浏览器 profile 范围）。沙箱默认**没有**它 ——
    // 等同于隐私模式/受限沙箱，用例要模拟「存得住」时显式传一个内存版实现。
    localStorage: options.localStorage,
    setInterval: () => 0,
    clearInterval: () => {},
    // 审核 T38 第 5 条：沙箱里没有 setTimeout —— 点「保存凭证」实测
    // `ReferenceError: setTimeout is not defined`，于是**所有 Toast 反馈文案零覆盖**。
    // 这里给一个「记录但不自动跑」的版本：用例自己调用 flushTimers() 决定什么时候到点。
    setTimeout: (fn, ms) => { const id = timers.length + 1; timers.push({ id, fn, ms }); return id },
    clearTimeout: (id) => { const i = timers.findIndex((t) => t.id === id); if (i >= 0) timers.splice(i, 1) },
    queueMicrotask: (fn) => { micro.push(fn) },
    console,
  }
  vm.createContext(sandbox)
  vm.runInContext(SOURCE, sandbox)
  assert.ok(mod, '模块没有调用 __ModuleLoader__.load')

  // stateCalls 记录「setter 被调用」，用例据此断言「点了按钮 → 状态真的变了」（T38）
  const hooks = { queue: [], index: 0, stateCalls: [] }
  const React = {
    Fragment: Symbol('Fragment'),
    createElement(type, props, ...children) {
      // 审核（客户实拍发现的真 bug）：**真 React 会把 `key` 从 props 里剥掉**，
      // 而这里以前把它留在 props 里 —— 于是「靠 props.key 找子节点」的代码在桩里能跑、
      // 在真机上是 undefined。桩比运行时干净，就会掩盖 bug（T26 的老毛病）。
      const { key, ...rest } = props || {}
      const node = {
        type,
        props: { ...rest, children: children.flat(Infinity).filter((c) => c !== null && c !== undefined && c !== false) },
      }
      if (key !== undefined) node.key = key
      return node
    },
    memo: (fn) => fn,
    // 审核 T38（测试桩保真度审计）：
    // 以前 setter 是**空函数** —— 于是「点击 → 状态变化」这条链 0 覆盖。
    // 实证：把 `setSettingsSection(item.key)` 改成 `setSettingsSection('source')`，
    // 82 条用例全绿 —— 而真机上就是客户看到的那一屏（高亮动了、内容不动）。
    //
    // 最小可用版本（不引入真重渲染，风险最低）：setter **记录调用**，
    // 用例可以断言「点这个按钮 → setSettingsSection('creds') 被调用」。
    // 完整版（setter 真的触发重渲染）见 docs/报告-测试桩保真度审计.md §1.1。
    useState(init) {
      const index = hooks.index
      const value = index < hooks.queue.length ? hooks.queue[index] : (typeof init === 'function' ? init() : init)
      hooks.index += 1
      const setter = (next) => {
        hooks.stateCalls.push({ index, next: typeof next === 'function' ? next(value) : next })
      }
      return [value, setter]
    },
    // effect 默认**不执行**（真跑起来会触发 /state 轮询，破坏既有静态用例）。
    // 但「订阅 → 外部事件 → 改状态」这类行为必须能验：这里记下来，用例显式 runEffects() 才执行。
    useEffect(fn, deps) { if (typeof fn === 'function') effects.push({ fn, deps }) },
    useCallback: (fn) => fn,
    useRef: (value) => ({ current: value }),
  }

  // 本 render 里登记的 effect（runEffects() 才执行），每次 render 清空
  const effects = []
  const registrations = []
  // 槽位注册的「活着」集合：真宿主对 list 槽位「同 id + 同 priority」重复注册会抛错
  // （ui-conversation 的 viewTabs 靠它保证页签不重复）。桩以前返回空 disposer、从不检查，
  // 于是「改名忘了先 dispose」这种错在桩里全绿、到真机才炸。这里按宿主语义照做。
  const live = new Set()
  const ctx = {
    effect: (fn) => fn(),
    slots: {
      inject: (_name, fn) => fn(),
      register(opts, Component) {
        const clash = registrations.find((r) => live.has(r)
          && r.opts.name === opts.name && r.opts.id === opts.id
          && (r.opts.priority ?? 0) === (opts.priority ?? 0))
        if (clash) {
          throw new Error('list slot "' + opts.name + '" already has an entry with id "' + opts.id
            + '" — register at a different priority to shadow it (lowest renders)')
        }
        const registration = { opts, Component }
        registrations.push(registration)
        live.add(registration)
        return () => { live.delete(registration) }
      },
    },
  }
  mod.factory((name) => {
    if (name === 'react') return React
    throw new Error('unexpected require: ' + name)
  }).apply(ctx)

  // props 可以传：面板有些文案取决于宿主给的 sessionId（"添加到当前会话" vs "先打开一个会话"）
  const render = (registration, queue, props = {}) => {
    effects.length = 0
    hooks.queue = queue || []
    hooks.index = 0
    const tree = registration.Component(props)
    // 审核 T38：位置化队列会**静默错位**。但校验不能在这里做 ——
    // 此刻只跑完**根组件**，子组件（如 ConfirmBtn 自带 useState）要等 walk() 展开时才跑。
    // 所以把「预期槽位数」记在树上，由 walk() 收尾时比对。
    Object.defineProperty(tree, '__panelVerify', {
      enumerable: false,
      value: () => {
        const message = '状态槽位对不上：传了 ' + hooks.queue.length + ' 个，组件用了 ' + hooks.index
          + ' 个 useState（' + registration.opts.id + '）—— 位置化队列错位会静默渲染出错误的状态'
        if (hooks.queue.length === hooks.index) return
        // 传多了 = 一定错（多余的值被静默丢掉）；传少了可能是「只用默认值」，只在严格模式抛。
        const strict = globalThis.process && globalThis.process.env && globalThis.process.env.PANEL_STRICT === '1'
        if (hooks.queue.length > hooks.index || strict) throw new Error(message)
        if (globalThis.process && globalThis.process.env && globalThis.process.env.PANEL_WARN === '1') {
          console.warn('[panel-harness] ' + message)
        }
      },
    })
    return tree
  }
  // 改视口宽度：窄屏相关的断言要靠它，别让测试自己去碰沙箱内部
  const setViewport = (width) => { sandbox.window.innerWidth = width }
  return {
    id: mod.id,
    registrations,
    // 还活着的注册（dispose 过的会被剔掉）—— 「改名只重注册一条」要按它断言，
    // 按 registrations 长度断言会把「旧的一条已释放」误判成重复。
    liveRegistrations: () => registrations.filter((registration) => live.has(registration)),
    // 执行上一次 render 登记的 effect，返回清理函数数组（顺序与登记一致，由用例显式调用）
    runEffects: () => {
      const cleanups = []
      for (const effect of effects) {
        const cleanup = effect.fn()
        if (typeof cleanup === 'function') cleanups.push(cleanup)
      }
      return cleanups
    },
    // 触发 window 级事件（如 'storage'），返回真正被调用的监听数 —— 0 就说明代码没挂监听。
    dispatchWindowEvent: (type, event) => {
      const set = windowListeners.get(type)
      if (!set) return 0
      let called = 0
      for (const fn of [...set]) { fn(event); called += 1 }
      return called
    },
    windowListenerCount: (type) => (windowListeners.get(type) || new Set()).size,
    render,
    setViewport,
    // 审核 T38：setter 以前是空函数，「点击 → 状态变化」零覆盖。
    // 现在 setter 会把调用记进这里，用例可以断言「点了这个按钮，状态真的变了」。
    stateCalls: () => hooks.stateCalls,
    resetStateCalls: () => { hooks.stateCalls.length = 0 },
  }
}

/**
 * 展开函数组件，收集整棵树（文本节点记为 #text）。
 *
 * 收尾时校验「状态槽位传够了吗」：位置化队列传少了会让值落进错误的槽，
 * 这种错位不会报错，只会渲染出一棵**看起来合理、其实不对**的树
 * （T38：14 条弹层用例就是这么错的，弹层的视口夹紧从来没执行过）。
 */
export function walk(node, out = [], check = { top: true }) {
  if (check.top) {
    const result = walkInner(node, out)
    // 整棵树展开完了，现在才知道一共用掉几个状态槽 —— 比对放在这里
    if (node && typeof node === 'object' && typeof node.__panelVerify === 'function') node.__panelVerify()
    return result
  }
  return walkInner(node, out)
}

function walkInner(node, out) {
  if (node === null || node === undefined || node === false) return out
  if (typeof node === 'string' || typeof node === 'number') {
    out.push({ type: '#text', text: String(node) })
    return out
  }
  if (typeof node !== 'object') return out
  if (typeof node.type === 'function') return walkInner(node.type(node.props || {}), out)
  out.push(node)
  for (const child of node.props?.children || []) walkInner(child, out)
  return out
}


/** 主理鱼面板的 useState 队列：snap / tab / notice / form / token / goalDraft / goalTouched / toast / editing / draft */
export const deskForm = { repo: '', intervalSec: '60', goal: '', labels: '', onlyAssigned: false, activeHours: '', isolated: false, workdir: '' }
export const deskQueue = (snapshot, editing = null, draft = {}, tab = 'overview', search = '', glossary = false, update = null, tabName = '主理鱼') =>
  // 末尾依次是：update / checking（0.8.38 版本检查）、settingsSection / reasonFilter / badgeFilter、
  // 以及 0.9.15 追加的 problemsOnly —— 顺序必须跟组件里的 useState 一致（测试桩按位置取值）
  // 末尾依次是：update / checking、settingsSection / reasonFilter / badgeFilter、problemsOnly，
  // 以及 0.9.157 追加的 stateFilter（统计条筛选）—— 顺序必须跟组件里的 useState 一致
  // 以及 0.9.175 追加的 ghDir（gh 账号配置目录输入框）—— 只能在末尾追加
  // 0.9.263 追加 traceResult（判定页内联追溯）—— 仍然只能在末尾追加
  // 0.9.271 追加 updateResult（界面内安装回执）—— 仍然只能在末尾追加
  // 0.10.13 追加 tabName（设置→来源的页签名称草稿）—— 只能追加在最后
  [snapshot, tab, null, deskForm, '', '', false, [], editing, draft, search, glossary, update, false, 'source', null, null, false, null, '', '', null, null, tabName]

export const watcher = (repo, extra = {}) => ({
  repo,
  sessionId: 'session-' + repo,
  intervalSec: 30,
  enabled: true,
  cursor: null,
  // 2026-11-04 修：定值 '2026-11-01T13:00:00.000Z' 会被 client.js 渲染成「轮询 N 小时前」，
  // 快照于是每过一小时漂一格（和 render-panel-copy.mjs 里 lastWake 是同一个坑）。
  // 固定成「相对生成时刻 68 小时前」，输出恒定。
  lastPoll: new Date(Date.now() - 68 * 3600 * 1000).toISOString(),
  lastWake: null,
  lastError: null,
  title: '会话 ' + repo,
  goal: null,
  ...extra,
})


/**
 * 「脏数据」夹具（审核 T26 的教训）。
 *
 * `watcher()` 桩比**真 /state** 干净：`intervalSec: 30` 恒存在、`goal: null` 恒为空、`gh` 根本不在桩里。
 * 于是「假数据造出来的正确」掩盖了「真数据下的错误」——
 * 真机上 `goal` 是**对象**（`goalView()` 的返回）、`gh.ok` 是**三态**（含 `null`）。
 *
 * 这个夹具按**后端真实形状**造：宁可脏，也不要干净 —— 干净会让测试变成装饰。
 */
export const dirtyWatcher = (repo, extra = {}) => ({
  repo,
  sessionId: 'session-' + repo,
  // 真实条目一定有这些，但**不保证**都有值（老条目/迁移过来的缺字段）
  intervalSec: undefined,
  enabled: true,
  cursor: null,
  lastPoll: null,
  lastWake: null,
  lastError: null,
  title: null,
  // 真机上 goal 是对象（goalView），不是字符串
  goal: { objective: '把登录流程补完', phase: 'active', revision: 3, updatedAt: '2026-11-05T00:00:00.000Z' },
  note: '',
  repoAccess: { private: true, archived: true, canPush: false, hasIssues: false, isFork: true },
  filters: { labels: null, onlyAssigned: null },
  priority: null,
  wakeTimes: null,
  dailyWakes: null,
  history: null,
  silentWakes: null,
  batchLimit: null,
  maxWakesPerHour: null,
  deferReason: 'quota',
  lastDeferred: null,
  ...extra,
})

/** 真 /state 的顶层形状（含 gh 三态、credentials 哨兵值、defaults）。 */
export const dirtyState = (watchers = []) => ({
  loading: false,
  error: null,
  body: {
    sessionGoal: null,
    sessionTitle: null,
    credentials: { token: 'none', sshKeyPath: 'none', ghConfigDir: 'none', giteeToken: 'none' },
    sessionUsage: { used: 0, cap: 12, capped: 0 },
    // 零守 / 纯 Gitee 时后端就是这么回的
    gh: { ok: null, skipped: '没有 GitHub 守' },
    defaults: { sessionMaxWakes: 12, maxWakesPerHour: 6, isolateKeepDays: 3, batchLimit: 5 },
    watchers,
  },
})
