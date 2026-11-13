import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { deskForm, deskQueue, loadClient, watcher } from './fixtures/panel-harness.mjs'

const EDIT_ID = 'a/b#session-a/b'
const SESSION_ID = 'session-a/b'
const SOURCE = readFileSync(new URL('../client.js', import.meta.url), 'utf8')

function response(body = { ok: true }, ok = true, status = 200) {
  return { ok, status, headers: { get: () => null }, text: async () => JSON.stringify(body) }
}

function makeWatcher() {
  return watcher('a/b', {
    id: EDIT_ID, sessionId: SESSION_ID, intervalSec: 30,
    note: '原始目标', goal: { objective: '原始目标' },
    filters: { labels: ['bug'], ignoreLabels: ['old'], onlyAssigned: false, assignee: null, allowAuthors: ['alice'] },
    activeHours: '', ackLabel: '主理鱼:已处理', observe: false, isolated: true, workdir: '',
    batchLimit: null, maxWakesPerHour: null, sessionMaxWakes: null, isolateKeepDays: null, maxIsolated: null,
    priority: { reopened: true, comments: true, labels: true, unassigned: false, stale: false },
  })
}

function makeDraft() {
  return {
    // PR 响应监控的四项：与 watcherValuesFrom 返回的键保持一致，否则「放弃恢复快照」会假红。
    watchKind: 'issue', audit: false, adversarialAudit: false, auditMode: 'subagent',
    intervalSec: '30', labels: 'bug', ignoreLabels: 'old', assignee: '', activeHours: '',
    goal: '原始目标', ackLabel: '主理鱼:已处理', onlyAssigned: false, allowAuthors: 'alice',
    observe: false, isolated: true, workdir: '', batchLimit: '', maxWakesPerHour: '',
    sessionMaxWakes: '', isolateKeepDays: '', maxIsolated: '',
    priorityReopened: true, priorityComments: true, priorityLabels: true,
    priorityUnassigned: false, priorityStale: false,
  }
}

function makeForm() {
  return {
    ...deskForm, watchKind: 'issue', audit: false, adversarialAudit: false, auditMode: 'subagent',
    repo: '', intervalSec: '60', goal: '', labels: '', ignoreLabels: '', assignee: '',
    allowAuthors: '', onlyAssigned: false, activeHours: '', isolated: true, workdir: '', observe: false,
    batchLimit: '', maxWakesPerHour: '', sessionMaxWakes: '', isolateKeepDays: '', maxIsolated: '',
  }
}

function scenario(kind, fetch) {
  const item = makeWatcher()
  const snap = {
    loading: false, error: null,
    body: {
      credentials: {}, gh: { ok: true }, defaults: { batchLimit: 5, maxWakesPerHour: 6, sessionMaxWakes: 12, isolateKeepDays: 3 },
      watchers: [item],
    },
  }
  const client = loadClient({ fetch: fetch || (async (url) => response(String(url).includes('/state') ? snap.body : { ok: true })) })
  const desk = client.registrations.find((entry) => entry.opts.id === 'session-superagent-desk')
  const queue = deskQueue(snap, kind === 'edit' ? EDIT_ID : null, kind === 'edit' ? makeDraft() : {}, kind === 'add' ? 'trigger' : 'overview')
  if (kind === 'add') queue[3] = makeForm()
  return {
    client, snap, queue,
    render(next = queue) {
      const raw = client.render(desk, next, { sessionId: SESSION_ID })
      const tree = materialize(raw)
      if (typeof raw.__panelVerify === 'function') raw.__panelVerify()
      return tree
    },
  }
}

function materialize(node) {
  if (node === null || node === undefined || node === false) return null
  if (typeof node === 'string' || typeof node === 'number') return { type: '#text', text: String(node), props: {}, children: [] }
  if (Array.isArray(node)) return { type: 'fragment', props: {}, children: node.map(materialize).filter(Boolean) }
  if (typeof node.type === 'function') return materialize(node.type(node.props || {}))
  return { type: node.type, props: node.props || {}, children: (node.props?.children || []).map(materialize).filter(Boolean) }
}

function all(node, predicate, out = []) {
  if (!node) return out
  if (predicate(node)) out.push(node)
  for (const child of node.children || []) all(child, predicate, out)
  return out
}

function one(node, predicate, message) {
  const found = all(node, predicate)
  assert.equal(found.length, 1, message + '；实际 ' + found.length)
  return found[0]
}

function text(node) {
  if (!node) return ''
  return node.type === '#text' ? node.text : (node.children || []).map(text).join('')
}

function hasClass(node, name) {
  return String(node.props?.className || '').split(/\s+/).includes(name)
}

function formRoot(tree) {
  return one(tree, (node) => hasClass(node, 'dt-form') && all(node, (child) => child.type === 'label' && text(child) === '间隔（秒）').length === 1, '缺 watcher form')
}

function field(tree, label) {
  return one(formRoot(tree), (node) => node.type === 'div' && hasClass(node, 'dt-field')
    && all(node, (child) => child.type === 'label' && text(child) === label).length === 1, '缺字段 ' + label)
}

function fieldInput(tree, label) {
  const container = field(tree, label)
  const labelNode = one(container, (node) => node.type === 'label', '字段缺 label ' + label)
  const id = labelNode.props.htmlFor
  assert.ok(id, '字段缺 htmlFor ' + label)
  return one(container, (node) => node.type === 'input' && node.props.id === id, 'label 未关联 input ' + label)
}

function saveBar(tree) {
  return one(formRoot(tree), (node) => hasClass(node, 'dt-savebar'), '缺 SaveBar')
}

function applyCalls(queue, calls) {
  const next = [...queue]
  for (const call of calls) next[call.index] = call.next
  return next
}

function plain(value) {
  if (Array.isArray(value)) return value.map(plain)
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, plain(item)]))
  return value
}

function shape(node) {
  if (node.type === '#text') return ['#text', node.text]
  const ignored = new Set(['children', 'key', 'ref', 'value', 'defaultValue', 'checked'])
  const props = {}
  for (const key of Object.keys(node.props || {}).sort()) {
    if (ignored.has(key) || /^on[A-Z]/.test(key)) continue
    props[key] = ['id', 'htmlFor', 'aria-controls', 'aria-describedby', 'aria-labelledby'].includes(key) ? '<unique-id>' : plain(node.props[key])
  }
  return [typeof node.type === 'symbol' ? String(node.type) : node.type, props, ...(node.children || []).map(shape)]
}

function openAdvanced(current) {
  const disclosure = one(formRoot(current.tree), (node) => hasClass(node, 'dt-disclosure'), '缺高级 Disclosure')
  const row = one(disclosure, (node) => hasClass(node, 'dt-disclosure-row'), '缺 Disclosure 行')
  assert.equal(row.props['aria-expanded'], false)
  assert.equal(all(disclosure, (node) => hasClass(node, 'dt-disclosure-body')).length, 0)
  current.client.resetStateCalls()
  row.props.onClick()
  const queue = applyCalls(current.queue, current.client.stateCalls())
  const tree = current.render(queue)
  const body = one(formRoot(tree), (node) => hasClass(node, 'dt-disclosure-body'), '展开缺 body')
  return { tree, body, queue }
}

for (const kind of ['add', 'edit']) {
  test('L84c ' + kind + '：共用 Field DOM、唯一 id，Disclosure 默认收起并可展开', () => {
    const current = scenario(kind)
    const tree = current.render()
    for (const label of ['间隔（秒）', '只处理这些标签', '只理这些人提的', '目标/规则']) {
      const container = field(tree, label)
      const labelNode = one(container, (node) => node.type === 'label', 'label 不唯一')
      assertAssociated(labelNode)
      fieldInput(tree, label)
    }
    const ids = all(formRoot(tree), (node) => node.type === 'input' && node.props.id).map((node) => node.props.id)
    assert.equal(new Set(ids).size, ids.length, 'input id 必须唯一')
    const opened = openAdvanced({ ...current, tree })
    assert.ok(all(opened.body, (node) => node.type === 'label' && text(node) === '单次最多唤醒条数').length === 1)
  })
}

function assertAssociated(labelNode) {
  assert.equal(all(labelNode, (node) => ['button', 'input', 'select', 'textarea'].includes(node.type)).length, 0, 'label 内不得有交互控件')
}

test('L84c 新建/编辑同名字段的 label/hint/note/control 顺序一致', () => {
  const add = scenario('add').render()
  const edit = scenario('edit').render()
  for (const label of ['间隔（秒）', '只处理这些标签', '只理这些人提的', '目标/规则']) {
    assert.deepEqual(shape(field(add, label)), shape(field(edit, label)), label)
  }
})

for (const kind of ['add', 'edit']) {
  test('L84c ' + kind + '：数字 min/max 与 optional 空值不被改成 0', () => {
    const current = scenario(kind)
    const opened = openAdvanced({ ...current, tree: current.render() })
    const expected = {
      '间隔（秒）': [30, 3600],
      '单次最多唤醒条数': [1, 20],
      '每小时最多唤醒次数': [1, 60],
      '这条会话每小时最多被唤醒': [1, 60],
      '隔离区保留天数': [1, 30],
      '最多保留几个隔离区': [1, 50],
    }
    for (const [label, [min, max]] of Object.entries(expected)) {
      const input = fieldInput(opened.tree, label)
      assert.equal(input.props.type, 'number', label)
      assert.equal(input.props.min, min, label)
      assert.equal(input.props.max, max, label)
      if (label !== '间隔（秒）') assert.equal(input.props.value, '', label)
      assert.notEqual(input.props.value, 0, label)
    }
  })
}

for (const kind of ['add', 'edit']) {
  test('L84c ' + kind + '：dirty 后出现 SaveBar，放弃恢复打开时快照', () => {
    const current = scenario(kind)
    if (kind === 'add') current.queue[3] = { ...current.queue[3], isolated: false }
    const clean = current.render()
    assert.equal(all(formRoot(clean), (node) => hasClass(node, 'dt-savebar')).length, 0)
    current.client.resetStateCalls()
    fieldInput(clean, '目标/规则').props.onChange({ target: { value: '临时目标' } })
    const dirtyQueue = applyCalls(current.queue, current.client.stateCalls())
    const dirty = current.render(dirtyQueue)
    assert.ok(saveBar(dirty))
    one(saveBar(dirty), (node) => node.type === 'button' && text(node) === '放弃', '缺放弃').props.onClick()
    const restored = current.render(applyCalls(dirtyQueue, current.client.stateCalls()))
    assert.equal(fieldInput(restored, '目标/规则').props.value, kind === 'add' ? '' : '原始目标')
    assert.equal(all(formRoot(restored), (node) => hasClass(node, 'dt-savebar')).length, 0)
  })
}

test('L84c 保存中 fieldset 禁用，忙时不重复提交', async () => {
  let release
  const requests = []
  const current = scenario('edit', async (url, init = {}) => {
    requests.push({ url: String(url), init })
    if (String(url).endsWith('/watch')) return new Promise((resolve) => { release = () => resolve(response({ ok: true })) })
    return response(current.snap.body)
  })
  const dirtyQueue = [...current.queue]
  dirtyQueue[9] = { ...makeDraft(), intervalSec: '90' }
  const tree = current.render(dirtyQueue)
  current.client.resetStateCalls()
  const save = one(saveBar(tree), (node) => node.type === 'button' && text(node) === '保存', '缺保存')
  const pending = save.props.onClick()
  assert.equal(await save.props.onClick(), false, 'busy 时第二次点击必须被同步锁挡住')
  const busyQueue = applyCalls(dirtyQueue, current.client.stateCalls())
  const busyTree = current.render(busyQueue)
  assert.equal(one(formRoot(busyTree), (node) => node.type === 'fieldset', '缺 fieldset').props.disabled, true)
  assert.ok(all(formRoot(busyTree), (node) => node.type === 'input').every((node) => node.props.disabled === true))
  assert.equal(requests.filter((request) => request.url.endsWith('/watch')).length, 1)
  release()
  await pending
})

test('L84c 保存失败保留输入与原始错误，不关闭编辑器', async () => {
  const current = scenario('edit', async (url) => {
    if (String(url).endsWith('/watch')) return response({ error: '服务端拒绝了这次保存' }, false, 500)
    return response(current.snap.body)
  })
  const dirtyQueue = [...current.queue]
  dirtyQueue[9] = { ...makeDraft(), intervalSec: '90', goal: '未触碰目标' }
  const tree = current.render(dirtyQueue)
  current.client.resetStateCalls()
  const result = await one(saveBar(tree), (node) => node.type === 'button' && text(node) === '保存', '缺保存').props.onClick()
  assert.equal(result, false)
  const failed = current.render(applyCalls(dirtyQueue, current.client.stateCalls()))
  assert.equal(fieldInput(failed, '间隔（秒）').props.value, '90')
  assert.ok(!current.client.stateCalls().some((call) => call.index === 8 && call.next === null), '失败不能关闭编辑器')
  assert.ok(all(saveBar(failed), (node) => node.props.role === 'alert' && text(node).includes('服务端拒绝了这次保存')).length === 1)
})

test('L84c 编辑只提交 touched 字段，保留定位键而不伪造 revision/merge3', async () => {
  const requests = []
  const current = scenario('edit', async (url, init = {}) => {
    requests.push({ url: String(url), init })
    return response(String(url).includes('/state') ? current.snap.body : { ok: true })
  })
  const queue = [...current.queue]
  queue[9] = { ...makeDraft(), intervalSec: '90', goal: '未触碰目标' }
  const tree = current.render(queue)
  current.client.resetStateCalls()
  fieldInput(tree, '间隔（秒）').props.onChange({ target: { value: '120' } })
  // harness 的 useRef 每次 render 重建；在同一 render 回放 draft，模拟真实受控输入后的保存。
  for (const call of current.client.stateCalls()) {
    if (call.index === 9 && call.next && typeof call.next === 'object') Object.assign(queue[9], call.next)
  }
  await one(saveBar(tree), (node) => node.type === 'button' && text(node) === '保存', '缺保存').props.onClick()
  const writes = requests.filter((request) => request.url.endsWith('/watch') && request.init.method === 'POST')
  assert.equal(writes.length, 1)
  assert.deepEqual(JSON.parse(writes[0].init.body), { repo: 'a/b', sessionId: SESSION_ID, intervalSec: 120 })
  assert.ok(!SOURCE.includes('h(InlineEditor'))
  assert.ok(!SOURCE.includes('merge3('))
})

test('L84c 新增成功只重置既定仓库字段，保留限额与隔离策略', async () => {
  const calls = []
  const current = scenario('add', async (url, init = {}) => {
    calls.push({ url: String(url), init })
    return response(String(url).includes('/state') ? current.snap.body : { ok: true, warnings: [] })
  })
  const queue = [...current.queue]
  queue[3] = { ...makeForm(), repo: 'acme/demo', goal: 'goal', labels: 'bug', allowAuthors: '@alice', isolated: true, batchLimit: '3', maxWakesPerHour: '4', sessionMaxWakes: '8', isolateKeepDays: '2', maxIsolated: '4' }
  const tree = current.render(queue)
  current.client.resetStateCalls()
  await one(formRoot(tree), (node) => node.type === 'button' && text(node) === '添加到当前会话', '缺添加').props.onClick()
  const reset = current.client.stateCalls().find((call) => call.index === 3 && call.next && call.next.repo === '')
  assert.ok(reset, '新增成功必须重置既定字段')
  assert.equal(reset.next.goal, '')
  assert.equal(reset.next.labels, '')
  assert.equal(reset.next.allowAuthors, '')
  assert.equal(reset.next.onlyAssigned, false)
  assert.equal(reset.next.batchLimit, '3')
  assert.equal(reset.next.maxWakesPerHour, '4')
  assert.equal(reset.next.sessionMaxWakes, '8')
  assert.equal(reset.next.isolateKeepDays, '2')
  assert.equal(reset.next.maxIsolated, '4')
  const created = calls.find((call) => call.url.endsWith('/watch'))
  assert.ok(created)
  const body = JSON.parse(created.init.body)
  assert.equal(body.repo, 'acme/demo')
  assert.equal(body.sessionMaxWakes, 8)
  assert.equal(body.isolateKeepDays, 2)
  assert.equal(body.maxIsolated, 4)
  assert.equal(body.activeHours, undefined, '未触碰的 activeHours 不应提交')
  assert.equal(body.observe, undefined, '未触碰的 observe 不应提交')
})
