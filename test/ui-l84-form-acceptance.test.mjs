import test from 'node:test'
import assert from 'node:assert/strict'
import { deskForm, deskQueue, loadClient, watcher } from './fixtures/panel-harness.mjs'

const EDIT_ID = 'a/b#session-a/b'
const SESSION_ID = 'session-a/b'

// panel-harness 展开函数组件后只给平铺数组；这里保留父子关系，才能验收真实 DOM。
function materialize(node) {
  if (node === null || node === undefined || node === false) return null
  if (typeof node === 'string' || typeof node === 'number') return { type: '#text', text: String(node), props: {}, children: [] }
  if (Array.isArray(node)) return { type: 'fragment', props: {}, children: node.map(materialize).filter(Boolean) }
  if (typeof node !== 'object') return null
  if (typeof node.type === 'function') return materialize(node.type(node.props || {}))
  return {
    type: node.type,
    props: node.props || {},
    children: (node.props?.children || []).map(materialize).filter(Boolean),
  }
}

function rendered(client, registration, queue, props = { sessionId: SESSION_ID }) {
  const raw = client.render(registration, queue, props)
  const tree = materialize(raw)
  if (typeof raw.__panelVerify === 'function') raw.__panelVerify()
  return tree
}

function all(node, predicate, out = []) {
  if (!node) return out
  if (predicate(node)) out.push(node)
  for (const child of node.children || []) all(child, predicate, out)
  return out
}

function one(node, predicate, message) {
  const matches = all(node, predicate)
  assert.equal(matches.length, 1, message + '；实际 ' + matches.length)
  return matches[0]
}

function text(node) {
  if (!node) return ''
  if (node.type === '#text') return node.text
  return (node.children || []).map(text).join('')
}

function hasClass(node, name) {
  return String(node.props?.className || '').split(/\s+/).includes(name)
}

function deskOf(client) {
  const desk = client.registrations.find((item) => item.opts.id === 'session-superagent-desk')
  assert.ok(desk, '找不到主面板 registration')
  return desk
}

function response(body = { ok: true }, ok = true, status = 200) {
  return { ok, status, headers: { get: () => null }, text: async () => JSON.stringify(body) }
}

function makeWatcher({ isolated = false } = {}) {
  return watcher('a/b', {
    id: EDIT_ID,
    sessionId: SESSION_ID,
    intervalSec: 30,
    note: '原始目标',
    goal: { objective: '原始目标' },
    filters: {
      labels: ['bug'], ignoreLabels: ['old'], onlyAssigned: false,
      assignee: null, allowAuthors: ['alice'],
    },
    activeHours: '', ackLabel: '主理鱼:已处理', observe: false,
    isolated, workdir: '', batchLimit: null, maxWakesPerHour: null,
    sessionMaxWakes: null, isolateKeepDays: null, maxIsolated: null,
    priority: { reopened: true, comments: true, labels: true, unassigned: false, stale: false },
  })
}

function makeForm({ isolated = false } = {}) {
  return {
    ...deskForm,
    // PR 响应监控的四项：watcherValuesFrom 会返回它们，夹具缺了 deepEqual 就会假红。
    watchKind: 'issue', audit: false, adversarialAudit: false, auditMode: 'subagent',
    repo: '', intervalSec: '60', goal: '', labels: '', ignoreLabels: '',
    assignee: '', allowAuthors: '', onlyAssigned: false, activeHours: '',
    isolated, workdir: '', observe: false, batchLimit: '', maxWakesPerHour: '',
    sessionMaxWakes: '', isolateKeepDays: '', maxIsolated: '', ackLabel: '',
    priorityReopened: true, priorityComments: true, priorityLabels: true,
    priorityUnassigned: false, priorityStale: false,
  }
}

function scenario(kind, options = {}) {
  const item = makeWatcher(options)
  const snap = {
    loading: false,
    error: null,
    body: {
      credentials: { token: 'none', sshKeyPath: 'none', ghConfigDir: 'none', giteeToken: 'none' },
      gh: { ok: true, version: '2.0' },
      defaults: { sessionMaxWakes: 12, maxWakesPerHour: 6, isolateKeepDays: 3, batchLimit: 5 },
      watchers: [item],
    },
  }
  const client = loadClient({ fetch: options.fetch })
  const desk = deskOf(client)
  let queue = deskQueue(snap, null, {}, kind === 'add' ? 'trigger' : 'overview')
  if (kind === 'add') queue[3] = makeForm(options)
  if (kind === 'edit') {
    // 不手写编辑快照：真实点击仓库标题，回放生产 setEditing/setDraft 的结果。
    const closed = rendered(client, desk, queue)
    const trigger = one(closed, (node) => node.type === 'button' && hasClass(node, 'dt-open') && text(node) === 'a/b',
      '找不到行内编辑触发按钮')
    client.resetStateCalls()
    trigger.props.onClick()
    const opened = client.stateCalls()
    assert.ok(opened.some((call) => call.next === EDIT_ID), '点击仓库标题必须打开对应行内编辑器')
    assert.ok(opened.some((call) => call.next && call.next.intervalSec === '30'), '打开编辑器必须写入生产快照 draft')
    queue = applyCalls(queue, opened)
  }
  return {
    client,
    desk,
    queue,
    snap,
    render: (nextQueue = queue) => rendered(client, desk, nextQueue),
  }
}

function labelOf(fieldNode) {
  return one(fieldNode, (node) => node.type === 'label', 'Field 内必须有唯一 label')
}

function fieldNode(tree, label) {
  return one(tree, (node) => node.type === 'div' && hasClass(node, 'dt-field')
    && all(node, (child) => child.type === 'label' && text(child) === label).length === 1,
  '找不到唯一的 div.dt-field「' + label + '」')
}

function fieldInput(tree, label) {
  const field = fieldNode(tree, label)
  const labelNode = labelOf(field)
  const id = labelNode.props.htmlFor
  assert.ok(typeof id === 'string' && id.length > 0, '「' + label + '」label 缺 htmlFor')
  return one(field, (node) => node.type === 'input' && node.props.id === id,
    '「' + label + '」label.htmlFor 必须对应一个后代 input.id')
}

function formRoot(tree) {
  return one(tree, (node) => hasClass(node, 'dt-form')
    && all(node, (child) => child.type === 'label' && text(child) === '间隔（秒）').length === 1,
  '找不到包含 watcher 字段的唯一 dt-form')
}

function saveBars(tree) {
  return all(formRoot(tree), (node) => hasClass(node, 'dt-savebar'))
}

function applyCalls(queue, calls) {
  const next = [...queue]
  for (const call of calls) next[call.index] = call.next
  return next
}

function clickAdvanced(tree) {
  const disclosure = one(formRoot(tree), (node) => node.type === 'div' && hasClass(node, 'dt-disclosure'),
    'watcher 表单必须有唯一高级项 Disclosure')
  const row = one(disclosure, (node) => hasClass(node, 'dt-disclosure-row'), '缺 Disclosure 触发行')
  assert.equal(row.props['aria-expanded'], false, '高级项默认必须收起')
  assert.notEqual(disclosure.props['data-open'], 'true')
  assert.equal(all(disclosure, (node) => hasClass(node, 'dt-disclosure-body')).length, 0,
    '收起时不能提前挂载 dt-disclosure-body')
  assert.equal(typeof row.props.onClick, 'function', '高级项触发行必须可点击')
  return row
}

function expandAdvanced(current) {
  const row = clickAdvanced(current.tree)
  current.client.resetStateCalls()
  row.props.onClick()
  const calls = current.client.stateCalls()
  assert.ok(calls.length > 0, '点击高级项必须真的调用状态 setter')
  const queue = applyCalls(current.queue, calls)
  const tree = current.render(queue)
  const disclosure = one(formRoot(tree), (node) => node.type === 'div' && hasClass(node, 'dt-disclosure'),
    '展开后仍要有唯一高级项 Disclosure')
  assert.equal(one(disclosure, (node) => hasClass(node, 'dt-disclosure-row'), '缺触发行').props['aria-expanded'], true)
  const body = one(disclosure, (node) => hasClass(node, 'dt-disclosure-body'),
    '展开后必须有 dt-disclosure-body')
  return { tree, body, queue }
}

// 动态值与唯一 id 只规范内容，事件处理函数保留“是否存在”标记；label/hint/note/control 顺序仍逐层严格比较。
// 新增/编辑各在一个 VM realm，style 等嵌套对象原型不同；先归一成宿主普通对象，避免把 realm 差异误判为 DOM 漂移。
function plain(value) {
  if (Array.isArray(value)) return value.map(plain)
  if (value && typeof value === 'object') {
    const out = {}
    for (const [key, item] of Object.entries(value)) out[key] = plain(item)
    return out
  }
  return value
}

function domShape(node) {
  if (node.type === '#text') return ['#text', node.text]
  const ignored = new Set(['children', 'key', 'ref'])
  const dynamic = new Set(['value', 'defaultValue', 'checked'])
  const props = {}
  for (const key of Object.keys(node.props || {}).sort()) {
    if (ignored.has(key)) continue
    let value = node.props[key]
    if (/^on[A-Z]/.test(key)) value = typeof value === 'function' ? '<handler>' : value
    if (dynamic.has(key)) value = '<dynamic-value>'
    if (['id', 'htmlFor', 'aria-controls', 'aria-describedby', 'aria-labelledby'].includes(key)) value = '<unique-id>'
    props[key] = plain(value)
  }
  return [typeof node.type === 'symbol' ? String(node.type) : node.type, props,
    ...(node.children || []).map(domShape)]
}

function assertAssociatedField(tree, label) {
  const field = fieldNode(tree, label)
  const labelNode = labelOf(field)
  fieldInput(tree, label)
  assert.equal(all(labelNode, (node) => ['button', 'input', 'select', 'textarea'].includes(node.type)).length, 0,
    'label「' + label + '」内不得嵌套交互控件')
}

for (const kind of ['add', 'edit']) {
  const title = kind === 'add' ? '新增' : '行内编辑'
  test('L84c ' + title + '：高级项默认收起，真实点击后挂载 dt-disclosure-body', () => {
    const current = scenario(kind)
    const opened = expandAdvanced({ ...current, tree: current.render() })
    assert.ok(all(opened.body, (node) => node.type === 'label' && text(node) === '单次最多唤醒条数').length === 1,
      '高级项展开后必须包含限额字段')
  })
}

test('L84c 新增与行内编辑：全部同名字段 DOM 一致，Field label/htmlFor 关联真实 input.id', () => {
  const addCurrent = scenario('add', { isolated: true })
  const editCurrent = scenario('edit', { isolated: true })
  const add = expandAdvanced({ ...addCurrent, tree: addCurrent.render() }).tree
  const edit = expandAdvanced({ ...editCurrent, tree: editCurrent.render() }).tree
  const common = [
    '间隔（秒）', '只处理这些标签', '排除这些标签', '只理这些人提的', '活跃时段', '目标/规则', '已处理标签',
    '单次最多唤醒条数', '每小时最多唤醒次数', '这条会话每小时最多被唤醒',
    '隔离工作目录', '隔离区保留天数', '最多保留几个隔离区',
  ]
  assertAssociatedField(add, '仓库')
  for (const label of common) {
    assertAssociatedField(add, label)
    assertAssociatedField(edit, label)
    assert.deepEqual(domShape(fieldNode(add, label)), domShape(fieldNode(edit, label)),
      '新增/编辑同名字段结构漂移：' + label)
  }
  for (const label of ['只看已指派', '仅观察', '隔离执行']) {
    const switchOf = (tree) => one(formRoot(tree), (node) => hasClass(node, 'dt-switch-row')
      && all(node, (child) => child.type === 'button' && child.props.role === 'switch'
        && child.props['aria-label'] === label).length === 1, '找不到唯一开关字段「' + label + '」')
    assert.deepEqual(domShape(switchOf(add)), domShape(switchOf(edit)), '新增/编辑开关字段结构漂移：' + label)
  }
  const priorityOf = (tree) => one(formRoot(tree), (node) => node.type === 'div' && hasClass(node, 'dt-actions')
    && (node.children || []).some((child) => hasClass(child, 'dt-field-head'))
    && (node.children || []).some((child) => hasClass(child, 'dt-actions'))
    && all(node, (child) => child.type === 'button' && child.props.role === 'switch'
      && child.props['aria-label'] === '重开优先').length === 1, '缺优先级字段')
  assert.deepEqual(domShape(priorityOf(add)), domShape(priorityOf(edit)), '新增/编辑优先级字段结构必须一致')
  for (const tree of [add, edit]) {
    const ids = all(formRoot(tree), (node) => node.type === 'input' && node.props.id).map((node) => node.props.id)
    assert.equal(new Set(ids).size, ids.length, '同一 watcher 表单内 input.id 必须唯一')
  }
})

for (const kind of ['add', 'edit']) {
  const title = kind === 'add' ? '新增' : '行内编辑'
  test('L84c ' + title + '：数字字段 type/min/max 与服务端范围一致，optional 空值不变成 0', () => {
    const current = scenario(kind, { isolated: true })
    const opened = expandAdvanced({ ...current, tree: current.render() })
    const form = formRoot(opened.tree)
    const expected = {
      '间隔（秒）': [30, 3600, false],
      '单次最多唤醒条数': [1, 20, true],
      '每小时最多唤醒次数': [1, 60, true],
      '这条会话每小时最多被唤醒': [1, 60, true],
      '隔离区保留天数': [1, 30, true],
      '最多保留几个隔离区': [1, 50, true],
    }
    for (const [label, [min, max, optional]] of Object.entries(expected)) {
      const input = fieldInput(form, label)
      assert.equal(input.props.type, 'number', label + ' 缺 type=number')
      assert.equal(Number(input.props.min), min, label + ' min 错误')
      assert.equal(Number(input.props.max), max, label + ' max 错误')
      assert.ok(input.props.min !== undefined && input.props.min !== null, label + ' 必须显式给 min')
      assert.ok(input.props.max !== undefined && input.props.max !== null, label + ' 必须显式给 max')
      if (optional) assert.equal(input.props.value, '', label + ' 空 optional 不得偷换成 0')
    }
  })
}

async function checkDirtyDiscard(kind) {
  const current = scenario(kind)
  const stateIndex = kind === 'add' ? 3 : 9
  // 编辑的 WatcherForm opening 来自 watcherValuesFrom（含 repo），放弃后 draft 也应恢复这整份快照。
  const opening = kind === 'edit' ? { ...current.queue[stateIndex], repo: 'a/b' } : { ...current.queue[stateIndex] }
  const clean = current.render()
  assert.equal(saveBars(clean).length, 0, '干净 watcher 表单不能显示 SaveBar')
  const beforeGoal = fieldInput(clean, '目标/规则').props.value
  const beforeLabels = fieldInput(clean, '只处理这些标签').props.value
  const changedGoal = kind === 'add' ? '新增草稿目标' : '编辑后的目标'

  current.client.resetStateCalls()
  fieldInput(clean, '目标/规则').props.onChange({ target: { value: changedGoal } })
  const goalChanges = current.client.stateCalls()
  const goalCall = goalChanges.find((call) => call.index === stateIndex)
  assert.ok(goalCall && goalCall.next && goalCall.next.goal === changedGoal, '目标输入必须更新正确的 form/draft 槽位')
  const goalQueue = applyCalls(current.queue, goalChanges)
  const goalTree = current.render(goalQueue)
  assert.equal(fieldInput(goalTree, '目标/规则').props.value, changedGoal)

  current.client.resetStateCalls()
  fieldInput(goalTree, '只处理这些标签').props.onChange({ target: { value: 'bug,urgent' } })
  const labelChanges = current.client.stateCalls()
  const labelCall = labelChanges.find((call) => call.index === stateIndex)
  assert.ok(labelCall && labelCall.next && labelCall.next.labels === 'bug,urgent', '标签输入必须更新正确的 form/draft 槽位')
  const dirtyQueue = applyCalls(goalQueue, labelChanges)
  const dirty = current.render(dirtyQueue)
  assert.equal(fieldInput(dirty, '目标/规则').props.value, changedGoal, '第二次输入不能丢掉第一项目标修改')
  assert.equal(fieldInput(dirty, '只处理这些标签').props.value, 'bug,urgent')
  const bar = one(dirty, (node) => hasClass(node, 'dt-savebar'), '修改后必须出现 SaveBar')
  const discard = one(bar, (node) => node.type === 'button' && text(node).includes('放弃'), 'SaveBar 缺放弃按钮')

  current.client.resetStateCalls()
  discard.props.onClick()
  const discarded = current.client.stateCalls()
  const discardCall = discarded.find((call) => call.index === stateIndex)
  assert.ok(discardCall && discardCall.next, '放弃必须恢复正确的 form/draft 槽位')
  const restoredQueue = applyCalls(dirtyQueue, discarded)
  assert.deepEqual(plain(restoredQueue[stateIndex]), plain(opening), '放弃必须恢复完整打开快照，而不是只清一个字段')
  const restored = current.render(restoredQueue)
  assert.equal(fieldInput(restored, '目标/规则').props.value, beforeGoal)
  assert.equal(fieldInput(restored, '只处理这些标签').props.value, beforeLabels)
  assert.equal(saveBars(restored).length, 0, '恢复快照后 SaveBar 必须消失')
}

test('L84c 新增：输入真实触发 SaveBar，放弃恢复快照', async () => {
  await checkDirtyDiscard('add')
})

test('L84c 行内编辑：输入真实触发 SaveBar，放弃恢复快照', async () => {
  await checkDirtyDiscard('edit')
})

test('L84c 行内编辑：真实输入并点击保存（同 render），/watch 只提交 touched 字段', async () => {
  const requests = []
  const current = scenario('edit', {
    fetch: async (url, init = {}) => {
      requests.push({ url: String(url), init })
      return response({ ok: true })
    },
  })
  // 先从干净快照真实输入，再按 T38 的 stateCalls 方式重渲染出 dirty SaveBar。
  const clean = current.render()
  assert.equal(saveBars(clean).length, 0)
  fieldInput(clean, '间隔（秒）').props.onChange({ target: { value: '90' } })
  const firstChanges = current.client.stateCalls()
  assert.ok(firstChanges.some((call) => call.next && call.next.intervalSec === '90'))
  current.queue = applyCalls(current.queue, firstChanges)
  const tree = current.render(current.queue)
  assert.equal(saveBars(tree).length, 1, '第一次真实输入后必须先出现 SaveBar')
  assert.equal(fieldInput(tree, '间隔（秒）').props.value, '90')

  // harness 的 useRef 跨 render 会重置（T38 已确认），不能宣称第一次 touched 被持久化。
  // 在同一张 dirty 表单上再次真实输入，并原地回放 state；这样执行的是真实 touchedRef → saveEdit → fetch，
  // 覆盖过滤逻辑本身，同时把「跨 render ref 持久化」明确留作未覆盖项。
  const input = fieldInput(tree, '间隔（秒）')
  current.client.resetStateCalls()
  input.props.onChange({ target: { value: '120' } })
  const changes = current.client.stateCalls()
  assert.ok(changes.some((call) => call.next && call.next.intervalSec === '120'), '数字输入必须更新 draft.intervalSec')
  const draft = current.queue[9]
  for (const call of changes) {
    const state = current.queue[call.index]
    if (state && call.next && typeof state === 'object' && typeof call.next === 'object') {
      for (const key of Object.keys(state)) delete state[key]
      Object.assign(state, call.next)
    }
  }
  assert.equal(draft.intervalSec, '120', '同一 render 内必须回放输入后的真实 draft')
  assert.equal(draft.goal, '原始目标', '未触碰字段必须保持原快照')

  const bar = one(tree, (node) => hasClass(node, 'dt-savebar'), '保存前必须有 SaveBar')
  const save = one(bar, (node) => node.type === 'button' && text(node) === '保存', 'SaveBar 缺保存按钮')
  await save.props.onClick()
  const writes = requests.filter((request) => request.url.endsWith('/watch') && request.init.method === 'POST')
  assert.equal(writes.length, 1, '点击保存必须只发一次 /watch')
  assert.deepEqual(JSON.parse(writes[0].init.body), {
    repo: 'a/b', sessionId: SESSION_ID, intervalSec: 120,
  }, '除定位 watcher 所需 repo/sessionId 外，只能发实际 touched 的 intervalSec')
})
