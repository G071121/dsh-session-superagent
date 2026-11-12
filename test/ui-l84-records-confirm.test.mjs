import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { deskQueue, loadClient, watcher } from './fixtures/panel-harness.mjs'

const SOURCE = readFileSync(new URL('../client.js', import.meta.url), 'utf8')

function stateWith(watchers, extra = {}) {
  return {
    loading: false,
    error: null,
    body: {
      sessionGoal: null,
      sessionTitle: 'L84',
      credentials: { token: 'none', sshKeyPath: 'none', ghConfigDir: 'none', giteeToken: 'none' },
      gh: { ok: true, version: '2.0' },
      defaults: {},
      watchers,
      ...extra,
    },
  }
}

// panel-harness 展开函数组件后只给平铺数组；这里保留父子关系，验证官方 DOM 而不只看文本。
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

function rendered(render, registration, queue) {
  const raw = render(registration, queue)
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

function button(node, label) {
  return one(node, (item) => item.type === 'button' && text(item) === label, '找不到唯一按钮「' + label + '」')
}

function deleteTrigger(node) {
  return one(node, (item) => item.type === 'button' && item.props?.['aria-label'] === '删除'
    && item.props?.['aria-haspopup'] === 'dialog', '找不到唯一删除触发按钮')
}

function modal(node) {
  return one(node, (item) => item.type === 'div' && item.props?.className === 'dt-modal', '找不到唯一 dt-modal')
}

function shape(node) {
  if (node.type === '#text') return node.text
  return [
    typeof node.type === 'symbol' ? String(node.type) : node.type,
    node.props?.className || '',
    node.props?.role || '',
    node.props?.['aria-label'] || '',
    node.props?.['aria-haspopup'] || '',
    ...(node.children || []).map(shape),
  ]
}

function response(body, ok = true, status = 200) {
  return { ok, status, headers: { get: () => null }, text: async () => JSON.stringify(body) }
}

function deskOf(client) {
  return client.registrations.find((item) => item.opts.id === 'session-superagent-desk')
}

function orbitOf(client) {
  return client.registrations.find((item) => item.opts.id === 'session-superagent-orbit')
}

const anchor = { x: 720, y: 860 }

test('L84 ConfirmButton：主面板与卫星环都不是 armed，且触发按钮 DOM 完全相同', () => {
  const list = [watcher('a/b', { id: 'a/b#s1' })]
  const client = loadClient()
  const base = deskQueue(stateWith(list))
  const main = rendered(client.render, deskOf(client), [...base, false, false])
  const satellite = rendered(client.render, orbitOf(client), [list, null, true, anchor, '主理鱼', false, false])
  const mainDelete = deleteTrigger(main)
  const satelliteDelete = deleteTrigger(satellite)

  assert.equal(text(mainDelete), '删除')
  assert.equal(text(satelliteDelete), '删除')
  assert.equal(mainDelete.props.onBlur, undefined, '删除触发器不能再靠 blur 解除 armed')
  assert.equal(satelliteDelete.props.onBlur, undefined, '卫星环也不能有 armed blur')
  assert.ok(!hasClass(mainDelete, 'dt-danger'), '未打开时触发按钮不是第二段危险态')
  assert.deepEqual(shape(mainDelete), shape(satelliteDelete), '主面板与卫星环必须使用同一触发按钮 DOM')
  assert.equal(all(main, (node) => node.type === 'div' && node.props?.className === 'dt-modal').length, 0, '未点击不应渲染 Modal')
  assert.equal(all(satellite, (node) => node.type === 'div' && node.props?.className === 'dt-modal').length, 0, '卫星环未点击不应渲染 Modal')
  assert.ok(!/\barmed\b/.test(SOURCE), 'client.js 不应再保留 armed 状态')
  assert.ok(!SOURCE.includes('window.confirm'), '不得重新引入 window.confirm')
})

test('L84 ConfirmButton：点击只开官方 Modal；取消与背板不调用 action，主/卫星弹层 DOM 相同', () => {
  const list = [watcher('a/b', { id: 'a/b#s1' })]
  const calls = []
  const client = loadClient({ fetch: async (...args) => { calls.push(args); return response({ watchers: list }) } })
  const base = deskQueue(stateWith(list))
  const openHook = base.length
  const closed = rendered(client.render, deskOf(client), [...base, false, false])

  client.resetStateCalls()
  deleteTrigger(closed).props.onClick()
  assert.ok(client.stateCalls().some((call) => call.index === openHook && call.next === true), '第一次点击只应 setOpen(true)')
  assert.equal(calls.filter(([, init]) => init?.method === 'POST').length, 0, '打开确认框不能发写请求')

  const main = rendered(client.render, deskOf(client), [...base, true, false])
  const satellite = rendered(client.render, orbitOf(client), [list, null, true, anchor, '主理鱼', true, false])
  assert.deepEqual(shape(deleteTrigger(main)), shape(deleteTrigger(satellite)), '打开后两处触发按钮仍同 DOM')
  assert.deepEqual(shape(modal(main)), shape(modal(satellite)), '两处必须复用同一 Modal DOM')
  const dialog = modal(main)
  assert.equal(dialog.props.role, 'dialog')
  assert.equal(dialog.props['aria-modal'], 'true')
  assert.equal(text(one(dialog, (node) => node.props?.className === 'dt-modal-title' || node.props?.className === 'dt-title', '缺标题')), '确认删除')
  assert.ok(text(one(dialog, (node) => node.props?.className === 'dt-modal-description', '缺说明')).includes('删除'))
  assert.ok(one(dialog, (node) => node.props?.className === 'dt-modal-footer', '缺官方 footer'))

  client.resetStateCalls()
  button(dialog, '取消').props.onClick()
  assert.ok(client.stateCalls().some((call) => call.index === openHook && call.next === false), '取消只关闭 Modal')
  assert.equal(calls.filter(([, init]) => init?.method === 'POST').length, 0, '取消不能调用删除 action')

  client.resetStateCalls()
  one(main, (node) => node.props?.className === 'dt-modal-mask', '缺背板').props.onClick()
  assert.ok(client.stateCalls().some((call) => call.index === openHook && call.next === false), '背板只关闭 Modal')
  assert.equal(calls.filter(([, init]) => init?.method === 'POST').length, 0, '背板不能调用删除 action')
})

test('L84 ConfirmButton：主面板确认成功才关闭并只发一次 delete；失败保持打开', async () => {
  const list = [watcher('a/b', { id: 'a/b#s1' })]
  const requests = []
  const client = loadClient({
    fetch: async (url, init) => {
      requests.push({ url, init })
      return response({ watchers: [] })
    },
  })
  const base = deskQueue(stateWith(list))
  const openHook = base.length
  const busyHook = openHook + 1
  const opened = rendered(client.render, deskOf(client), [...base, true, false])

  client.resetStateCalls()
  const done = await button(modal(opened), '确认删除').props.onClick()
  assert.equal(done, true, '成功动作应把 true 返回给 ConfirmButton')
  const writes = requests.filter(({ init }) => init?.method === 'POST')
  assert.equal(writes.length, 1)
  assert.deepEqual(JSON.parse(writes[0].init.body), { action: 'delete', id: 'a/b#s1' })
  assert.ok(client.stateCalls().some((call) => call.index === busyHook && call.next === true), '确认开始必须 busy=true')
  assert.ok(client.stateCalls().some((call) => call.index === busyHook && call.next === false), '确认结束必须 busy=false')
  assert.ok(client.stateCalls().some((call) => call.index === openHook && call.next === false), '成功后关闭 Modal')

  const failing = loadClient({
    fetch: async (url, init) => init?.method === 'POST'
      ? response({ error: '冲突' }, false, 409)
      : response({ watchers: list }),
  })
  const failedTree = rendered(failing.render, deskOf(failing), [...base, true, false])
  failing.resetStateCalls()
  const failed = await button(modal(failedTree), '确认删除').props.onClick()
  assert.equal(failed, false)
  assert.ok(!failing.stateCalls().some((call) => call.index === openHook && call.next === false), '失败时不能假装成功并关闭')
})

test('L84 ConfirmButton：busy 禁止重复提交，连点第二次被同步 ref 锁挡住', async () => {
  const list = [watcher('a/b', { id: 'a/b#s1' })]
  const writes = []
  let release
  const client = loadClient({
    fetch: (url, init) => {
      if (init?.method === 'POST') {
        writes.push({ url, init })
        return new Promise((resolve) => { release = () => resolve(response({ ok: true })) })
      }
      return Promise.resolve(response({ watchers: [] }))
    },
  })
  const base = deskQueue(stateWith(list))
  const opened = rendered(client.render, deskOf(client), [...base, true, false])
  const confirm = button(modal(opened), '确认删除')

  const first = confirm.props.onClick()
  const second = await confirm.props.onClick()
  assert.equal(second, false, '第二次点击必须直接返回 false')
  assert.equal(writes.length, 1, '同一时刻只能有一个 delete POST')
  release()
  assert.equal(await first, true)

  const busyTree = rendered(client.render, deskOf(client), [...base, true, true])
  const disabled = button(modal(busyTree), '确认删除')
  assert.equal(disabled.props.disabled, true)
  assert.equal(disabled.props['aria-busy'], 'true')
  assert.ok(hasClass(disabled, 'dt-btn-busy'))
})

test('L84 ConfirmButton：卫星环确认走同一个 Modal action，成功只发一次 delete', async () => {
  const list = [watcher('a/b', { id: 'a/b#s1' })]
  const writes = []
  const client = loadClient({
    fetch: async (url, init) => {
      if (init?.method === 'POST') writes.push({ url, init })
      return response({ watchers: [] })
    },
  })
  const tree = rendered(client.render, orbitOf(client), [list, null, true, anchor, '主理鱼', true, false])
  const done = await button(modal(tree), '确认删除').props.onClick()
  assert.equal(done, true)
  assert.equal(writes.length, 1)
  assert.deepEqual(JSON.parse(writes[0].init.body), { action: 'delete', id: 'a/b#s1' })
  // 位置槽：0 watchers / 1 orbitError / 2 open / 3 anchor / 4 brandName（0.10.x 追加）
  // / 5 ConfirmButton.open / 6 ConfirmDialog.busy
  assert.ok(client.stateCalls().some((call) => call.index === 5 && call.next === false), '卫星环成功后也关闭同一个 ConfirmButton Modal')
})

test('L84 Modal：Escape 与焦点恢复采用官方稳定 close ref（当前 harness 的源码级回归）', () => {
  const start = SOURCE.indexOf('function Modal(')
  const end = SOURCE.indexOf('function ConfirmButton(', start)
  assert.ok(start >= 0 && end > start)
  const modalSource = SOURCE.slice(start, end)
  assert.ok(modalSource.includes('const close = useRef(onClose)'), 'onClose 必须放入 ref')
  assert.ok(modalSource.includes('close.current = onClose'), '每次渲染要更新 close ref')
  assert.ok(modalSource.includes("event.key === 'Escape'") && modalSource.includes('close.current()'), 'Escape 必须走最新 onClose')
  assert.ok(modalSource.includes('restoreTo.current = document.activeElement'), '打开时要记录触发元素')
  assert.ok(modalSource.includes('back.focus()'), '关闭清理时必须恢复焦点')
  assert.ok(modalSource.includes('}, [open])'), 'effect 只能依赖 open，不能因轮询重建焦点')
})

test('L84 DecisionLine：ul.dt-list > li.dt-row.dt-ticket，字段完整、跨守倒序、日期 Section 独立', () => {
  const today = new Date()
  today.setHours(12, 0, 0, 0)
  const newer = new Date(today.getTime() - 3600000).toISOString()
  const older = new Date(today.getTime() - 7200000).toISOString()
  const yesterday = new Date(today.getTime() - 86400000).toISOString()
  const list = [
    watcher('a/b', {
      id: 'a/b#s1',
      history: [
        { at: older, numbers: [12], ok: true, reason: null },
        { at: yesterday, numbers: [9], ok: false, reason: 'cap-session' },
      ],
    }),
    watcher('c/d', {
      id: 'c/d#s2',
      history: [{ at: newer, numbers: ['IKSQJH'], ok: false, reason: 'observe' }],
    }),
  ]
  const client = loadClient()
  const tree = rendered(client.render, deskOf(client), deskQueue(stateWith(list), null, {}, 'judge'))
  const isDecision = (node) => node.type === 'li' && hasClass(node, 'dt-row') && hasClass(node, 'dt-ticket')
  const rows = all(tree, isDecision)
  assert.equal(rows.length, 3)
  assert.ok(text(rows[0]).includes('#IKSQJH'), '跨守最新记录必须排第一')
  assert.ok(text(rows[1]).includes('#12'))
  assert.ok(text(rows[2]).includes('#9'), '跨守最旧记录必须排最后')

  for (const row of rows) {
    assert.ok(hasClass(row, 'dt-link'))
    assert.ok(!hasClass(row, 'dt-event'), 'DecisionLine 不再冒充时间线事件')
    assert.ok(one(row, (node) => node.props?.className === 'dt-ticket-stage', '缺结果 StageMark'))
    assert.ok(one(row, (node) => node.props?.className === 'dt-ticket-body', '缺 ticket body'))
    assert.ok(one(row, (node) => node.props?.className === 'dt-row-title', '缺仓库标题'))
    assert.ok(one(row, (node) => hasClass(node, 'dt-row-quote'), '缺编号行'))
    assert.ok(one(row, (node) => hasClass(node, 'dt-row-meta'), '缺原因/时间行'))
    assert.equal(all(row, (node) => node.type === 'time').length, 1, '每条都要有 time')
  }
  assert.ok(text(rows[0]).includes('c/d') && text(rows[0]).includes('仅观察'), 'Gitee 行缺仓库或结果')
  assert.ok(text(rows[1]).includes('a/b') && text(rows[1]).includes('已唤醒') && text(rows[1]).includes('判定通过'))
  assert.ok(text(rows[2]).includes('跳过：cap-session') && text(rows[2]).includes('原因：cap-session'))

  const decisionLists = all(tree, (node) => node.type === 'ul' && node.props?.className === 'dt-list' && all(node, isDecision).length > 0)
  assert.equal(decisionLists.length, 2, '今天与昨天必须各有一个 ul.dt-list')
  assert.deepEqual(decisionLists.map((listNode) => listNode.children.filter((child) => child.type === 'li').length), [2, 1])
  for (const listNode of decisionLists) {
    for (const child of listNode.children.filter((node) => node.type !== '#text')) {
      assert.ok(isDecision(child), 'ul.dt-list 的直接子节点只能是对应 DecisionLine li')
    }
  }

  const dayTitles = all(tree, (node) => node.props?.className === 'dt-timeline-day')
  assert.equal(dayTitles.length, 2)
  assert.ok(dayTitles.every((node) => node.type !== 'li'), '日期标题不能和事件混作同类 li')
  assert.deepEqual(dayTitles.map(text), ['今天', '昨天'])
  const daySections = all(tree, (node) => {
    if (node.type !== 'section') return false
    const titleNode = node.children.find((child) => child.props?.className === 'dt-section-title')
    return titleNode && all(titleNode, (child) => child.props?.className === 'dt-timeline-day').length === 1
  })
  assert.equal(daySections.length, 2, '每天必须有独立 Section')
  for (const section of daySections) {
    assert.ok(section.children.some((child) => child.type === 'ul' && child.props?.className === 'dt-list'), '日期 Section 必须直接包含自己的 ul')
  }
  for (const timeline of all(tree, (node) => node.type === 'ol' && node.props?.className === 'dt-timeline')) {
    assert.equal(all(timeline, isDecision).length, 0, 'DecisionLine 不能混入 ol.dt-timeline')
  }
})

test('L84 回归：运行时事件仍是 ol.dt-timeline，一事件一 li，日期标题不混入', () => {
  const at = new Date().toISOString()
  const list = [watcher('a/b', {
    history: [{ at, numbers: [42], ok: true, reason: null }],
    events: [
      { at, kind: 'poll', text: '第一次轮询' },
      { at, kind: 'wake', text: '第二次唤醒' },
    ],
  })]
  const client = loadClient()
  const tree = rendered(client.render, deskOf(client), deskQueue(stateWith(list), null, {}, 'judge'))
  const timeline = one(tree, (node) => node.type === 'ol' && node.props?.className === 'dt-timeline', '运行时事件必须保留唯一 ol.dt-timeline')
  const items = timeline.children.filter((node) => node.type === 'li')
  assert.equal(items.length, 2)
  assert.ok(items.every((node) => node.props?.className === 'dt-event'))
  assert.ok(text(items[0]).includes('第二次唤醒'), '运行时事件仍按倒序')
  assert.ok(text(items[1]).includes('第一次轮询'))
  assert.equal(all(timeline, (node) => node.props?.className === 'dt-timeline-day').length, 0)
})

test('L84 回归：TraceTimeline 仍是一标题加一事件一 li 的 ol.dt-timeline', () => {
  const payload = {
    ok: true,
    traces: [{
      number: '42', repo: 'a/b', verdict: '被过滤',
      seen: '2026-11-05T10:00:00Z', reported: null,
      filtered: [{ at: '2026-11-05T10:01:00Z', reason: '机器人' }],
      absorbed: [{ at: '2026-11-05T10:02:00Z' }],
      wakes: [{ at: '2026-11-05T10:03:00Z', ok: true }],
    }],
  }
  const client = loadClient()
  const queue = deskQueue(stateWith([watcher('a/b')]), null, {}, 'judge', '42')
  queue[queue.length - 3] = payload
  const tree = rendered(client.render, deskOf(client), queue)
  const timeline = one(tree, (node) => node.type === 'ol' && node.props?.className === 'dt-timeline' && text(node).includes('#42 @ a/b'), '缺 TraceTimeline')
  const items = timeline.children.filter((node) => node.type === 'li')
  assert.equal(items.length, 5, '1 个标题 + 4 个事件，每个都是独立 li')
  assert.ok(items.every((node) => node.props?.className === 'dt-event'))
  for (const expected of ['#42 @ a/b：被过滤', '被过滤：机器人', '被冷却期吸收', '唤醒成功']) {
    assert.equal(items.filter((item) => text(item).includes(expected)).length, 1, 'Trace 项必须一事件一 li：' + expected)
  }
  assert.equal(all(timeline, (node) => hasClass(node, 'dt-ticket')).length, 0, 'Trace 不应被 DecisionLine 重构污染')
})
