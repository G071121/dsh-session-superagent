/**
 * 客户端渲染冒烟测试：不用浏览器，用假 React 跑真实 client.js。
 *
 * 覆盖三件在 0.3.1 之前踩过的事：
 *   1. 组件真的被注册进槽位（不是"代码在、注册没跑"）；
 *   2. 无主理鱼时不占位（dock 行里不留死图标）；
 *   3. 卫星数 = 主理鱼数（上限 6），错误态进详情面板。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import vm from 'node:vm'
import { createGate, loadGateConfig, readGateScope, validateConfig, writeGateConfig } from '@mycf711/dsh-gate'
import { deskForm, deskQueue, loadClient, walk, watcher } from './fixtures/panel-harness.mjs'
import { gateDeferred, gatePayload, gateResponse, gateUrlRepo, loadGatePanel } from './fixtures/gate-panel.mjs'
import { tempDir } from './fixtures/tmpdir.mjs'

test('client.js 注册主理鱼与 composer dock 上的轨道环', () => {
  const { id, registrations } = loadClient()
  assert.equal(id, 'dsh-session-superagent')
  const names = registrations.map((r) => r.opts.name + '#' + r.opts.id)
  assert.ok(names.includes('conversation.view#session-superagent-desk'), names.join(','))
  assert.ok(names.includes('conversation.composer.dock#session-superagent-orbit'), names.join(','))
  // 0.3.2 起不再挂会话头部
  assert.ok(!names.some((n) => n.includes('header.actions')), '头部徽章应已移除')
  const orbit = registrations.find((r) => r.opts.id === 'session-superagent-orbit')
  assert.ok(orbit.opts.order < 0, 'order 要是负数，才能排在 activity(0)/usage(1) 左边')
})

test('0 个主理鱼也占位：灰色空环、没有卫星、不转', () => {
  const { registrations, render } = loadClient()
  const orbit = registrations.find((r) => r.opts.id === 'session-superagent-orbit')
  const tree = render(orbit, [[]])
  assert.ok(tree, '0 主理鱼不该整条消失，否则看着像功能坏了')
  const nodes = walk(tree)
  const circles = nodes.filter((n) => n.type === 'circle')
  assert.equal(circles.length, 1, '只有一个环，没有卫星')
  assert.equal(circles[0].props.stroke, 'currentColor', '空态用继承色（灰）')
  assert.equal(circles[0].props.opacity, 0.38, '空态压暗')
  assert.equal(nodes.filter((n) => n.type === 'animateTransform' || n.type === 'animate').length, 0, '空态不该有动画')
  assert.match(String(tree.props.title), /还没有主理鱼/)
})

test('空态点开面板显示引导文案', () => {
  const { registrations, render } = loadClient()
  const orbit = registrations.find((r) => r.opts.id === 'session-superagent-orbit')
  const nodes = walk(render(orbit, [[], null, true, { x: 720, y: 860 }]))
  const panel = nodes.find((n) => n.props && n.props.role === 'dialog')
  assert.ok(panel, '空态也要能展开面板')
  const text = nodes.filter((n) => n.type === '#text').map((n) => n.text).join(' ')
  assert.ok(text.includes('0 主理中'), '空态指标要写成 0 主理中：' + text.slice(0, 120))
  assert.ok(text.includes('主理鱼') && text.includes('owner/name'), '空态要告诉人去哪加：' + text.slice(0, 120))
  assert.ok(!text.includes('暂停'), '没有主理鱼时不该出现暂停/删除的说明')
  assert.equal(panel.props.style.width, 252, '空态面板要比常规面板窄')
})

test('卫星数跟随主理鱼数，超过 6 个截断', () => {
  const { registrations, render } = loadClient()
  const orbit = registrations.find((r) => r.opts.id === 'session-superagent-orbit')
  const circlesOf = (list) => walk(render(orbit, [list])).filter((n) => n.type === 'circle').length
  assert.equal(circlesOf([watcher('a/b')]), 2, '环 + 1 颗卫星')
  assert.equal(circlesOf(['a/b', 'c/d', 'e/f'].map((r) => watcher(r))), 4, '环 + 3 颗卫星')
  assert.equal(circlesOf(['a/b', 'c/d', 'e/f', 'g/h', 'i/j', 'k/l', 'm/n'].map((r) => watcher(r))), 7, '最多 6 颗')
})

test('主理中才转：靠 SVG 自带的 SMIL，不靠外部样式表', () => {
  const { registrations, render } = loadClient()
  const orbit = registrations.find((r) => r.opts.id === 'session-superagent-orbit')
  const animsOf = (list) => {
    const group = walk(render(orbit, [list])).find((n) => n.type === 'g')
    return (group.props.children || []).filter((c) => c && c.type === 'animateTransform')
  }
  assert.equal(animsOf([watcher('a/b', { enabled: false })]).length, 0, '暂停不该转')
  assert.equal(animsOf([watcher('a/b', { lastError: 'boom' })]).length, 0, '异常不该转')
  const active = animsOf([watcher('a/b')])
  assert.equal(active.length, 1, '主理中必须有一个旋转动画')
  assert.equal(active[0].props.type, 'rotate')
  assert.equal(active[0].props.from, '0 8 8', '旋转中心必须是环心')
  assert.equal(active[0].props.repeatCount, 'indefinite')
  // 没有主理鱼时仍然渲染，只是灰环没卫星（见空态那条用例）
})

test('异常卫星呼吸、正常卫星不呼吸，环自己在呼吸', () => {
  const { registrations, render } = loadClient()
  const orbit = registrations.find((r) => r.opts.id === 'session-superagent-orbit')
  const opacityDurs = (list) => walk(render(orbit, [list]))
    .filter((n) => n.type === 'animate' && n.props.attributeName === 'opacity')
    .map((n) => n.props.dur)
  // 异常：只有红点呼吸（1.6s），环不呼吸（没有 active）
  assert.deepEqual(opacityDurs([watcher('a/b', { lastError: 'boom' })]), ['1.6s'])
  // 正常主理鱼：只有环在呼吸（2.6s），点不呼吸
  assert.deepEqual(opacityDurs([watcher('a/b')]), ['2.6s'])
  // 暂停：全静止
  assert.deepEqual(opacityDurs([watcher('a/b', { enabled: false })]), [])
})

test('点击展开的面板逐条列出仓库 / 会话 / 间隔 / 轮询 / 状态', () => {
  const { registrations, render } = loadClient()
  const orbit = registrations.find((r) => r.opts.id === 'session-superagent-orbit')
  const list = [
    watcher('a/b', { sessionId: 'session-1e82afca-8be2-42f9-8186-2bd274e30342', goal: { objective: '让主理鱼实时同步 goal', phase: null, revision: 3 } }),
    watcher('c/d', { sessionId: 'session-7f7155cf-20f0-4d9a', lastError: 'HttpError: 401 bad credentials' }),
  ]
  const nodes = walk(render(orbit, [list, null, true, { x: 720, y: 860 }]))
  const panel = nodes.find((n) => n.props && n.props.role === 'dialog')
  assert.ok(panel, '面板没有渲染')
  assert.equal(panel.props.style.position, 'fixed')
  assert.equal(panel.props.style.width, 368, '弹层宽度：344 会把 MYCF711/dsh-go 这类仓库名截掉')
  const text = nodes.filter((n) => n.type === '#text').map((n) => n.text).join(' ')
  const needles = [
    '主理鱼', '2 主理中', 'a/b', 'c/d', '主理中', '异常', '每 30s', '401 bad credentials',
    // 会话名优先显示标题（客户认得出的那个），同时保留 8 位后缀去重
    '1e82afca', '7f7155cf',
  ]
  for (const needle of needles) assert.ok(text.includes(needle), '面板缺少「' + needle + '」：' + text.slice(0, 240))
  // 细节（goal / 过滤 / 退避 / 历史）进 title，鼠标悬停可读，不再挤占行内
  const titles = nodes.filter((n) => n.props && n.props.className === 'sa-dock-row').map((n) => String(n.props.title || ''))
  assert.ok(titles.some((t) => t.includes('goal · 让主理鱼实时同步 goal')), 'goal 要在悬停详情里：' + titles.join(' | '))
  assert.ok(!text.includes('[object Object]'), 'goal 被当成对象直接拼进了文案')
})

test('状态栏面板每行都带暂停/删除，能直接关掉一个主理鱼', () => {
  const { registrations, render } = loadClient()
  const orbit = registrations.find((r) => r.opts.id === 'session-superagent-orbit')
  const list = [watcher('a/b'), watcher('c/d', { enabled: false })]
  const nodes = walk(render(orbit, [list, null, true, { x: 720, y: 860 }]))
  const labels = nodes
    .filter((n) => n.type === 'button')
    .map((b) => (b.props.children || []).filter((c) => typeof c === 'string').join(''))
  assert.ok(labels.includes('暂停'), '运行中的行要有「暂停」：' + labels.join('|'))
  assert.ok(labels.includes('恢复'), '已暂停的行要有「恢复」：' + labels.join('|'))
  assert.ok(labels.includes('删除'), '每行都要能删除：' + labels.join('|'))
})

test('主理鱼面板：总览有统计与每行操作（移植官方 GUI 后）', () => {
  const { registrations, render } = loadClient()
  const desk = registrations.find((r) => r.opts.id === 'session-superagent-desk')
  const snapshot = {
    loading: false, error: null,
    body: {
      sessionGoal: null, sessionTitle: '会话',
      credentials: { token: 'none', sshKeyPath: 'none' },
      watchers: [
        watcher('a/b', { id: 'a/b#s1', enabled: true }),
        watcher('c/d', { id: 'c/d#s2', enabled: false }),
      ],
    },
  }
  const form = { repo: '', intervalSec: '60', goal: '', labels: '', onlyAssigned: false, activeHours: '', isolated: false, workdir: '' }
  const nodes = walk(render(desk, deskQueue(snapshot)))
  const text = nodes.filter((n) => n.type === '#text').map((n) => n.text).join(' ')
  for (const needle of ['主理鱼', '总览', '触发', '设置', '条主理鱼', '主理中', '已暂停', '全部暂停']) {
    assert.ok(text.includes(needle), '面板缺少「' + needle + '」：' + text.slice(0, 200))
  }
  const labels = nodes.filter((n) => n.type === 'button')
    .map((b) => (b.props.children || []).filter((c) => typeof c === 'string').join(''))
  for (const want of ['立刻', '暂停', '删除']) {
    assert.ok(labels.includes(want), '缺按钮「' + want + '」：' + labels.join('|'))
  }
})

test('主理鱼面板：退避中与隔离状态以标签形式出现', () => {
  const { registrations, render } = loadClient()
  const desk = registrations.find((r) => r.opts.id === 'session-superagent-desk')
  const snapshot = {
    loading: false, error: null,
    body: {
      sessionGoal: null, sessionTitle: '会话',
      credentials: { token: 'none', sshKeyPath: 'none' },
      watchers: [watcher('a/b', {
        id: 'a/b#s1', enabled: true, consecutiveFailures: 2,
        nextAt: new Date(Date.now() + 45000).toISOString(),
        isolated: true, workdir: 'E:/temp/iso', lastWorktree: 'E:/temp/iso/.dsh-zhuli/a-b-1',
      })],
    },
  }
  const form = { repo: '', intervalSec: '60', goal: '', labels: '', onlyAssigned: false, activeHours: '', isolated: false, workdir: '' }
  const nodes = walk(render(desk, deskQueue(snapshot)))
  const text = nodes.filter((n) => n.type === '#text').map((n) => n.text).join(' ')
  assert.ok(/退避 \d+s/.test(text), '要显示退避：' + text.slice(0, 240))
  assert.ok(text.includes('隔离 · '), '要显示隔离：' + text.slice(0, 240))
})

test('面板显示过滤器与失败退避', () => {
  const { registrations, render } = loadClient()
  const orbit = registrations.find((r) => r.opts.id === 'session-superagent-orbit')
  const list = [watcher('a/b', {
    filters: { labels: ['ai-fix'], ignoreLabels: ['wontfix'], onlyAssigned: false },
    nextAt: new Date(Date.now() + 45000).toISOString(),
    consecutiveFailures: 1,
  })]
  const nodes = walk(render(orbit, [list, null, true, { x: 720, y: 860 }]))
  const text = nodes.filter((n) => n.type === '#text').map((n) => n.text).join(' ')
  const titles = nodes.filter((n) => n.props && n.props.className === 'sa-dock-row').map((n) => String(n.props.title || '')).join(' | ')
  assert.ok(titles.includes('标签: ai-fix'), '悬停详情要含标签白名单：' + titles.slice(0, 200))
  assert.ok(titles.includes('排除: wontfix'), '悬停详情要含排除标签')
  assert.ok(/退避 \d+s/.test(titles), '悬停详情要含退避剩余秒数：' + titles.slice(0, 200))
})

test('面板显示隔离执行状态与活跃时段', () => {
  const { registrations, render } = loadClient()
  const orbit = registrations.find((r) => r.opts.id === 'session-superagent-orbit')
  const list = [watcher('a/b', {
    isolated: true,
    lastWorktree: 'E:/temp/iso/.dsh-zhuli/a-b-123',
    workdir: 'E:/temp/iso',
    activeHours: '09:00-23:00',
  })]
  const nodes = walk(render(orbit, [list, null, true, { x: 720, y: 860 }]))
  const text = nodes.filter((n) => n.type === '#text').map((n) => n.text).join(' ')
  assert.ok(text.includes('时段 09:00-23:00'), '活跃时段要留在行内副行：' + text.slice(0, 200))
  const titles = nodes.filter((n) => n.props && n.props.className === 'sa-dock-row').map((n) => String(n.props.title || '')).join(' | ')
  assert.ok(titles.includes('隔离'), '悬停详情要含隔离状态：' + titles.slice(0, 200))
  assert.ok(titles.includes('dsh-zhuli/a-b-123'), '悬停详情要含上次 worktree 尾段')
})

test('值守台有全部暂停/全部恢复按钮', () => {
  const { registrations, render } = loadClient()
  const desk = registrations.find((r) => r.opts.id === 'session-superagent-desk')
  const snapshot = {
    loading: false, error: null,
    body: {
      sessionGoal: null, sessionTitle: '会话',
      credentials: { token: 'none', sshKeyPath: 'none' },
      watchers: [watcher('a/b', { id: 'a/b#s1', enabled: true })],
    },
  }
  const nodes = walk(render(desk, deskQueue(snapshot)))
  const labels = nodes.filter((n) => n.type === 'button')
    .map((b) => (b.props.children || []).filter((c) => typeof c === 'string').join(''))
  assert.ok(labels.includes('全部暂停'), labels.join('|'))
  assert.ok(labels.includes('全部恢复'), labels.join('|'))
})

test('面板显示最近一次唤醒的结果', () => {
  const { registrations, render } = loadClient()
  const orbit = registrations.find((r) => r.opts.id === 'session-superagent-orbit')
  const at = new Date(Date.now() - 120000).toISOString()
  const list = [watcher('a/b', { history: [{ at, numbers: [12, 13], ok: true, reason: null }] })]
  const nodes = walk(render(orbit, [list, null, true, { x: 720, y: 860 }]))
  const text = nodes.filter((n) => n.type === '#text').map((n) => n.text).join(' ')
  const titles = () => nodes.filter((n) => n.props && n.props.className === 'sa-dock-row').map((n) => String(n.props.title || '')).join(' | ')
  assert.ok(titles().includes('上次唤醒 #12 #13'), titles().slice(0, 220))
  assert.ok(titles().includes('2 分钟前'), titles().slice(0, 220))

  const failed = render(orbit, [[watcher('a/b', { history: [{ at, numbers: [7], ok: false, reason: 'session not live' }] })], null, true, { x: 720, y: 860 }])
  const failedTitles = walk(failed).filter((n) => n.props && n.props.className === 'sa-dock-row').map((n) => String(n.props.title || '')).join(' | ')
  assert.ok(failedTitles.includes('上次唤醒失败 #7'), failedTitles.slice(0, 220))
})

test('主理鱼面板：失败会在「需要关注」里变成一条可读问题', () => {
  const { registrations, render } = loadClient()
  const desk = registrations.find((r) => r.opts.id === 'session-superagent-desk')
  const snapshot = {
    loading: false, error: null,
    body: {
      sessionGoal: null, sessionTitle: '会话',
      credentials: { token: 'none', sshKeyPath: 'none' },
      watchers: [watcher('a/b', { id: 'a/b#s1', enabled: true, lastError: 'gh: Not Found (HTTP 404)' })],
    },
  }
  const form = { repo: '', intervalSec: '60', goal: '', labels: '', onlyAssigned: false, activeHours: '', isolated: false, workdir: '' }
  const nodes = walk(render(desk, deskQueue(snapshot)))
  const text = nodes.filter((n) => n.type === '#text').map((n) => n.text).join(' ')
  assert.ok(text.includes('需要关注'), '要有 problems 区块：' + text.slice(0, 200))
  assert.ok(text.includes('轮询失败'), '要把 lastError 变成人话')
  assert.ok(text.includes('未配置 token'), '凭证提示也算一条问题')
})

test('主理鱼面板：每行有「编辑」按钮（点开后可改间隔/过滤/时段/隔离）', () => {
  const { registrations, render } = loadClient()
  const desk = registrations.find((r) => r.opts.id === 'session-superagent-desk')
  const snapshot = {
    loading: false, error: null,
    body: {
      sessionGoal: null, sessionTitle: '会话',
      credentials: { token: 'configured', sshKeyPath: 'none' },
      watchers: [watcher('a/b', { id: 'a/b#s1', enabled: true })],
    },
  }
  const form = { repo: '', intervalSec: '60', goal: '', labels: '', onlyAssigned: false, activeHours: '', isolated: false, workdir: '' }
  const nodes = walk(render(desk, deskQueue(snapshot)))
  // 对齐官方 TicketLine：点标题（dt-open 按钮）展开，而不是另设一个「编辑」按钮
  const opens = nodes.filter((n) => n.type === 'button' && String(n.props.className || '').includes('dt-open'))
  assert.equal(opens.length, 1, '每行应该有一个可点标题（dt-open）')
  assert.equal(opens[0].props['aria-expanded'], false, '未展开时 aria-expanded=false')
  assert.ok(String(opens[0].props.children).includes('a/b'), '标题就是仓库名')
  const labels = nodes.filter((n) => n.type === 'button')
    .map((b) => (b.props.children || []).filter((c) => typeof c === 'string').join(''))
  assert.ok(labels.includes('立刻') && labels.includes('暂停'), '行内操作仍在：' + labels.join('|'))
  // 打开编辑态：editing === id 时出现保存/放弃
  const editing = walk(render(desk, deskQueue(snapshot, 'a/b#session-a/b', { intervalSec: '60', labels: '', activeHours: '', isolated: false })))
  const editingLabels = editing.filter((n) => n.type === 'button')
    .map((b) => (b.props.children || []).filter((c) => typeof c === 'string').join(''))
  assert.ok(editingLabels.includes('保存'), '编辑态要有保存：' + editingLabels.join('|'))
  assert.ok(editingLabels.includes('放弃'), '编辑态要有放弃')
})

test('主理鱼面板：仅观察标签 + 最近被过滤清单', () => {
  const { registrations, render } = loadClient()
  const desk = registrations.find((r) => r.opts.id === 'session-superagent-desk')
  const snapshot = {
    loading: false, error: null,
    body: {
      sessionGoal: null, sessionTitle: '会话',
      credentials: { token: 'configured', sshKeyPath: 'none' },
      watchers: [watcher('a/b', {
        id: 'a/b#s1', enabled: true, observe: true,
        filteredLog: [
          { at: '2026-11-01T12:00:00Z', number: 7, title: '机器人提的依赖升级', reason: '机器人' },
          { at: '2026-11-01T12:00:00Z', number: 8, title: '草稿', reason: '草稿 PR' },
        ],
      })],
    },
  }
  const nodes = walk(render(desk, deskQueue(snapshot)))
  const text = nodes.filter((n) => n.type === '#text').map((n) => n.text).join(' ')
  assert.ok(text.includes('仅观察'), '要有仅观察标签：' + text.slice(0, 200))
  assert.ok(text.includes('最近被过滤'), '要有过滤清单')
  assert.ok(text.includes('机器人'), '要显示过滤原因')
  assert.ok(text.includes('#7'), '要显示被过滤的编号')
})

test('主理鱼面板：搜索能过滤，术语表能打开，设置页有来源卡片', () => {
  const { registrations, render } = loadClient()
  const desk = registrations.find((r) => r.opts.id === 'session-superagent-desk')
  const snapshot = {
    loading: false, error: null,
    body: {
      sessionGoal: null, sessionTitle: '会话',
      credentials: { token: 'none', sshKeyPath: 'none' },
      gh: { ok: true, version: 'gh version 2.40.0' },
      watchers: [watcher('a/b', { id: 'a/b#s1' }), watcher('c/d', { id: 'c/d#s2' })],
    },
  }
  const filtered = walk(render(desk, deskQueue(snapshot, null, {}, 'overview', 'a/b')))
  const filteredText = filtered.filter((n) => n.type === '#text').map((n) => n.text).join(' ')
  assert.ok(filteredText.includes('a/b'), '命中项要留着')
  assert.ok(!filteredText.includes('c/d'), '不命中的要被过滤掉：' + filteredText.slice(0, 160))
  assert.ok(filteredText.includes('搜索结果'), '搜索时标题变成搜索结果')

  const settings = walk(render(desk, deskQueue(snapshot, null, {}, 'settings')))
  const settingsText = settings.filter((n) => n.type === '#text').map((n) => n.text).join(' ')
  assert.ok(settingsText.includes('来源'), '设置页要有来源卡片')
  assert.ok(settingsText.includes('gh version'), '要显示 gh CLI 版本：' + settingsText.slice(0, 200))

  const glossary = walk(render(desk, deskQueue(snapshot, null, {}, 'overview', '', true)))
  const glossaryText = glossary.filter((n) => n.type === '#text').map((n) => n.text).join(' ')
  assert.ok(glossaryText.includes('主理鱼术语表'), '术语表要能打开')
  assert.ok(glossaryText.includes('盯') && glossaryText.includes('办'), '术语表要有「盯」「办」两条')
})

test('主理鱼面板：「判定」页把每轮结果和原因列出来', () => {
  const { registrations, render } = loadClient()
  const desk = registrations.find((r) => r.opts.id === 'session-superagent-desk')
  const at = new Date(Date.now() - 60000).toISOString()
  const snapshot = {
    loading: false, error: null,
    body: {
      sessionGoal: null, sessionTitle: '会话',
      credentials: { token: 'none', sshKeyPath: 'none' },
      watchers: [watcher('a/b', {
        id: 'a/b#s1',
        history: [
          { at, numbers: [12], ok: true, reason: null },
          { at, numbers: [13], ok: false, reason: 'observe' },
          { at, numbers: [14], ok: false, reason: 'agent busy (running)' },
        ],
      })],
    },
  }
  const nodes = walk(render(desk, deskQueue(snapshot, null, {}, 'judge')))
  const text = nodes.filter((n) => n.type === '#text').map((n) => n.text).join(' ')
  assert.ok(text.includes('判定日志'), text.slice(0, 200))
  assert.ok(text.includes('已唤醒'), '成功的要显示已唤醒')
  assert.ok(text.includes('仅观察（未唤醒）'), 'observe 的要标出来')
  assert.ok(text.includes('#13'), '要显示编号')
})

test('删除按钮必须保留 dt-btn 基类（第二轮审核发现 className 被 ...rest 覆盖过）', () => {
  const { registrations, render } = loadClient()
  const desk = registrations.find((r) => r.opts.id === 'session-superagent-desk')
  const snapshot = {
    loading: false, error: null,
    body: {
      sessionGoal: null, sessionTitle: '会话',
      credentials: { token: 'configured', sshKeyPath: 'none' },
      watchers: [watcher('a/b', { id: 'a/b#s1' })],
    },
  }
  const nodes = walk(render(desk, deskQueue(snapshot)))
  const buttons = nodes.filter((n) => n.type === 'button')
  const labels = buttons.map((b) => (b.props.children || []).filter((c) => typeof c === 'string').join(''))
  const deleteIndex = labels.indexOf('删除')
  assert.ok(deleteIndex >= 0, '找不到删除按钮：' + labels.join('|'))
  const deleteClass = String(buttons[deleteIndex].props.className || '')
  assert.ok(deleteClass.includes('dt-btn '), '删除按钮丢了 dt-btn 基类：' + deleteClass)
  assert.ok(deleteClass.includes('dt-btn-sm'), '删除按钮丢了尺寸类：' + deleteClass)
})

test('面板恢复显示会话标题与每行 goal', () => {
  const { registrations, render } = loadClient()
  const desk = registrations.find((r) => r.opts.id === 'session-superagent-desk')
  const snapshot = {
    loading: false, error: null,
    body: {
      sessionTitle: '主理鱼重构',
      sessionGoal: null,
      credentials: { token: 'configured', sshKeyPath: 'none' },
      watchers: [watcher('a/b', { id: 'a/b#s1', note: '把 widget 的 issue 都处理完' })],
    },
  }
  const nodes = walk(render(desk, deskQueue(snapshot)))
  const text = nodes.filter((n) => n.type === '#text').map((n) => n.text).join(' ')
  assert.ok(text.includes('会话：主理鱼重构'), '头部要显示会话标题：' + text.slice(0, 180))
  assert.ok(text.includes('目标: 把 widget 的 issue'), '每行要显示目标/规则：' + text.slice(0, 240))
})

test('删除按钮 armed 态仍然保留 dt-btn 基类（并变成危险色）', () => {
  const { registrations, render } = loadClient()
  const desk = registrations.find((r) => r.opts.id === 'session-superagent-desk')
  const snapshot = {
    loading: false, error: null,
    body: {
      sessionGoal: null, sessionTitle: '会话',
      credentials: { token: 'configured', sshKeyPath: 'none' },
      watchers: [watcher('a/b', { id: 'a/b#s1' })],
    },
  }
  // 第 13 个 hook 槽是 ConfirmBtn 的 armed
  const armed = walk(render(desk, [...deskQueue(snapshot), true]))
  const buttons = armed.filter((n) => n.type === 'button')
  const labels = buttons.map((b) => (b.props.children || []).filter((c) => typeof c === 'string').join(''))
  const index = labels.indexOf('确认删除')
  assert.ok(index >= 0, 'armed 态文案应变成「确认删除」：' + labels.join('|'))
  const className = String(buttons[index].props.className || '')
  assert.ok(className.includes('dt-btn '), 'armed 态丢了 dt-btn 基类：' + className)
  assert.ok(className.includes('dt-danger'), 'armed 态要标危险：' + className)
})

test('有新版本时面板顶部给一条横幅，点进去看升级命令', () => {
  const { registrations, render } = loadClient()
  const desk = registrations.find((r) => r.opts.id === 'session-superagent-desk')
  const snapshot = {
    loading: false, error: null,
    body: { sessionGoal: null, sessionTitle: '会话', credentials: { token: 'configured', sshKeyPath: 'none' }, watchers: [] },
  }
  const update = { current: '0.8.38', latest: '0.9.0', hasUpdate: true, command: 'dsh plugin add dsh-session-superagent@0.9.0' }
  const nodes = walk(render(desk, deskQueue(snapshot, null, {}, 'overview', '', false, update)))
  const text = nodes.filter((n) => typeof n.text === 'string').map((n) => n.text).join(' | ')
  assert.ok(text.includes('有新版本 0.9.0'), '横幅要写明新版本：' + text.slice(0, 200))
  assert.ok(text.includes('去更新'), '要有入口')

  // 没有新版本时不该出现横幅
  const quiet = walk(render(desk, deskQueue(snapshot, null, {}, 'overview', '', false, { current: '0.8.38', latest: '0.8.38', hasUpdate: false })))
  const quietText = quiet.filter((n) => typeof n.text === 'string').map((n) => n.text).join(' | ')
  assert.ok(!quietText.includes('有新版本'), '没新版本就别打扰')
})

test('活跃时段之外的 watcher 不再谎报「主理中」（改显示「时段外」）', () => {
  const { registrations, render } = loadClient()
  const desk = registrations.find((r) => r.opts.id === 'session-superagent-desk')
  // 造一个一定落在窗口外的时段：把「当前时间」往后推一小时当起点，跨度一小时
  const now = new Date()
  const pad = (n) => String(n).padStart(2, '0')
  const from = (now.getHours() + 2) % 24
  const to = (from + 1) % 24
  const window = pad(from) + ':00-' + pad(to) + ':00'
  const snapshot = {
    loading: false, error: null,
    body: {
      sessionGoal: null, sessionTitle: '会话',
      credentials: { token: 'none', sshKeyPath: 'none' },
      watchers: [watcher('a/window', { activeHours: window })],
    },
  }
  const nodes = walk(render(desk, deskQueue(snapshot)))
  const text = nodes.filter((n) => typeof n.text === 'string').map((n) => n.text).join(' | ')
  assert.ok(text.includes('时段外'), '窗口外应显示「时段外」，实际：' + text.slice(0, 200))
  assert.ok(text.includes('时段 ' + window), '时段本身仍然要显示给人看')
})

test('设置页用官方左栏导航（dt-settings + dt-settings-nav）', () => {
  const { registrations, render } = loadClient()
  const desk = registrations.find((r) => r.opts.id === 'session-superagent-desk')
  const snapshot = {
    loading: false, error: null,
    body: { sessionGoal: null, sessionTitle: '会话', credentials: { token: 'none', sshKeyPath: 'none' }, watchers: [] },
  }
  const nodes = walk(render(desk, deskQueue(snapshot, null, {}, 'settings')))
  const grid = nodes.filter((n) => String(n.props && n.props.className || '').includes('dt-settings'))
  assert.ok(grid.length >= 1, '设置页要用 dt-settings 网格')
  const links = nodes.filter((n) => String(n.props && n.props.className || '').includes('dt-settings-link'))
  assert.equal(links.length, 6, '左栏应有 6 个分区（来源/凭证/门禁/版本与更新/诊断/goal）')
  const current = links.filter((n) => n.props['aria-current'] === 'page')
  assert.equal(current.length, 1, '当前分区要有 aria-current=page')
})

test('空态不是白屏：三步引导 + 一个能直接开始的动作', () => {
  const { registrations, render } = loadClient()
  const desk = registrations.find((r) => r.opts.id === 'session-superagent-desk')
  const snapshot = {
    loading: false, error: null,
    body: { sessionGoal: null, sessionTitle: '会话', credentials: { token: 'none', sshKeyPath: 'none' }, watchers: [] },
  }
  const nodes = walk(render(desk, deskQueue(snapshot)))
  const text = nodes.filter((n) => typeof n.text === 'string').map((n) => n.text).join(' | ')
  assert.ok(text.includes('三步'), '空态要给出上手路径：' + text.slice(0, 160))
  // 0.9.152 起不再用「①」字符：列表符号和步骤号重复，改成圆形步骤号 + 标题 + 说明
  const steps = nodes.filter((n) => n.props && n.props.className === 'dt-step')
  assert.equal(steps.length, 3, '三步都要在，实际 ' + steps.length)
  const nums = nodes.filter((n) => n.props && n.props.className === 'dt-step-num').map((n) => String((n.props.children || []).join('')))
  assert.deepEqual(nums, ['1', '2', '3'], '步骤号要连号：' + nums.join(','))
  const labels = nodes.filter((n) => n.type === 'button')
    .map((b) => (b.props.children || []).filter((c) => typeof c === 'string').join(''))
  assert.ok(labels.some((l) => l.includes('去添加第一条')), '要有一个直接开始的按钮：' + labels.join('|'))
})

test('判定页：点跳过原因标签可只看这一类（知识库里的"还没做"补上）', () => {
  const { registrations, render } = loadClient()
  const desk = registrations.find((r) => r.opts.id === 'session-superagent-desk')
  const snapshot = {
    loading: false, error: null,
    body: {
      sessionGoal: null, sessionTitle: '会话',
      credentials: { token: 'none', sshKeyPath: 'none' },
      watchers: [watcher('a/b', {
        id: 'a/b#s1',
        filterCounts: { '不在标签白名单: ai-fix': 7, '机器人': 0 },
        filteredLog: [{ at: '2026-11-02T08:00:00.000Z', number: 42, title: '一个被刷掉的 issue', reason: '不在标签白名单: ai-fix' }],
      })],
    },
  }
  const nodes = walk(render(desk, deskQueue(snapshot, null, {}, 'judge')))
  const pills = nodes.filter((n) => String(n.props && n.props.className || '').includes('dt-pill'))
  assert.ok(pills.length >= 1, '原因应该渲染成可点的 Pill')
  const labels = pills.map((p) => (p.props.children || []).filter((c) => typeof c === 'string').join(''))
  assert.ok(labels.some((l) => l.includes('不在标签白名单') && l.includes('7')), labels.join('|'))

  // 选中某个原因后，列表里应出现该类条目
  const filtered = walk(render(desk, deskQueue(snapshot, null, {}, 'judge').map((v, i) => (i === 15 ? '不在标签白名单: ai-fix' : v))))
  const text = filtered.filter((n) => typeof n.text === 'string').map((n) => n.text).join(' | ')
  assert.ok(text.includes('#42'), '筛选后要列出该类条目：' + text.slice(0, 200))
})

test('能力徽章可点：点「只读」只剩只读的守', () => {
  const { registrations, render } = loadClient()
  const desk = registrations.find((r) => r.opts.id === 'session-superagent-desk')
  const snapshot = {
    loading: false, error: null,
    body: {
      sessionGoal: null, sessionTitle: '会话',
      credentials: { token: 'none', sshKeyPath: 'none' },
      watchers: [
        watcher('ok/one', { id: 'ok/one#s1', repoAccess: { repo: 'ok/one', push: true, hasIssues: true } }),
        watcher('ro/two', { id: 'ro/two#s2', repoAccess: { repo: 'ro/two', push: false, hasIssues: true } }),
      ],
    },
  }
  // 未筛选：两条都在
  const all = walk(render(desk, deskQueue(snapshot)))
  const allText = all.filter((n) => typeof n.text === 'string').map((n) => n.text).join('|')
  assert.ok(allText.includes('ok/one') && allText.includes('ro/two'), '未筛选应显示两条')

  // 选中「只读」：只剩 ro/two
  const filtered = walk(render(desk, deskQueue(snapshot).map((v, i) => (i === 16 ? '只读' : v))))
  const filteredText = filtered.filter((n) => typeof n.text === 'string').map((n) => n.text).join('|')
  assert.ok(filteredText.includes('ro/two'), '只读筛选要留下 ro/two：' + filteredText.slice(0, 160))
  assert.ok(!filteredText.includes('ok/one'), '只读筛选不该留下 ok/one')
  assert.ok(filteredText.includes('只看 只读 的守'), '要有明确的状态提示')
})

test('中间态：有守但从未唤醒过，要给"在等"的引导而不是沉默', () => {
  const { registrations, render } = loadClient()
  const desk = registrations.find((r) => r.opts.id === 'session-superagent-desk')
  const snapshot = {
    loading: false, error: null,
    body: {
      sessionGoal: null, sessionTitle: '会话',
      credentials: { token: 'none', sshKeyPath: 'none' },
      watchers: [watcher('a/b', { id: 'a/b#s1', lastPoll: '2026-11-02T08:00:00Z', lastWake: null })],
    },
  }
  const nodes = walk(render(desk, deskQueue(snapshot)))
  const text = nodes.filter((n) => typeof n.text === 'string').map((n) => n.text).join(' | ')
  assert.ok(text.includes('还没有唤醒过'), '要说明"在等"：' + text.slice(0, 200))
  assert.ok(text.includes('立刻'), '要给出可以马上试一下的动作')

  // 已经唤醒过的不该再显示这句
  const woken = {
    loading: false, error: null,
    body: { sessionGoal: null, sessionTitle: '会话', credentials: { token: 'none', sshKeyPath: 'none' },
      watchers: [watcher('a/b', { id: 'a/b#s1', lastWake: '2026-11-02T08:00:00Z' })] },
  }
  const after = walk(render(desk, deskQueue(woken))).filter((n) => typeof n.text === 'string').map((n) => n.text).join(' | ')
  assert.ok(!after.includes('还没有唤醒过'), '唤醒过就不该再提示')
})

test('需要重启时面板顶部要有横幅（"功能看起来没生效"最常见的根因）', () => {
  const { registrations, render } = loadClient()
  const desk = registrations.find((r) => r.opts.id === 'session-superagent-desk')
  const base = {
    sessionGoal: null, sessionTitle: '会话',
    credentials: { token: 'none', sshKeyPath: 'none' }, watchers: [],
  }
  const drifted = { loading: false, error: null, body: { ...base, installedVersion: '0.9.0', runningVersion: '0.8.4' } }
  const text = walk(render(desk, deskQueue(drifted))).filter((n) => typeof n.text === 'string').map((n) => n.text).join(' | ')
  assert.ok(text.includes('需要重启宿主'), '要明确说要重启：' + text.slice(0, 160))
  assert.ok(text.includes('0.9.0') && text.includes('0.8.4'), '要写出两个版本号')

  const same = { loading: false, error: null, body: { ...base, installedVersion: '0.9.0', runningVersion: '0.9.0' } }
  const quiet = walk(render(desk, deskQueue(same))).filter((n) => typeof n.text === 'string').map((n) => n.text).join(' | ')
  assert.ok(!quiet.includes('需要重启宿主'), '一致时不该出现横幅')
})

test('面板自己的错误也要说人话（Failed to fetch 客户看不懂）', () => {
  const { registrations, render } = loadClient()
  const desk = registrations.find((r) => r.opts.id === 'session-superagent-desk')
  const snap = { loading: false, error: 'Failed to fetch', body: { sessionGoal: null, sessionTitle: 'x', credentials: {}, watchers: [] } }
  // 四个页签都扫：一个页签干净不代表别的页签干净
  const texts = ['overview', 'queue', 'trigger', 'settings'].map((tab) =>
    walk(render(desk, deskQueue(snap, null, {}, tab))).filter((n) => typeof n.text === 'string').map((n) => n.text).join(' | '))
  const text = texts.join(' || ')
  assert.ok(!text.includes('Failed to fetch'), '不该把原始英文丢给客户')
  assert.ok(text.includes('连不上宿主'), '要说明发生了什么：' + text.slice(0, 200))
  assert.ok(text.includes('诊断'), '要给出下一步动作')
})

test('判定页要能看见时间线（"为什么没叫醒我"要有据可查）', () => {
  const { registrations, render } = loadClient()
  const desk = registrations.find((r) => r.opts.id === 'session-superagent-desk')
  const snap = {
    loading: false, error: null,
    body: { sessionGoal: null, sessionTitle: 'x', credentials: {}, watchers: [
      watcher('a/b', { id: 'a/b#s1', events: [
        { at: new Date().toISOString(), kind: 'cap-session', text: '这条会话一小时内已被唤醒 12 次（上限 12），已攒 3 条待处理' },
        { at: new Date().toISOString(), kind: 'wake', text: '唤醒了 2 条：#1 #2' },
      ] }),
    ] },
  }
  // 时间线在「判定」页：切 tab 再渲染
  const nodes = walk(render(desk, deskQueue(snap, null, {}, 'judge')))
  const text = nodes.filter((n) => typeof n.text === 'string').map((n) => n.text).join(' | ')
  assert.ok(nodes.some((n) => n.type === 'ol' && n.props.className === 'dt-timeline'), '运行时事件必须用官方 ol.dt-timeline')
  assert.ok(nodes.filter((n) => n.type === 'li' && n.props.className === 'dt-event').length >= 2, '每个运行时事件必须是独立 li.dt-event')
  assert.ok(text.includes('运行时事件'), '要有运行时事件区块：' + text.slice(0, 160))
  assert.ok(text.includes('cap-session'), '要显示事件类型')
  assert.ok(text.includes('已被唤醒 12 次'), '要显示人话内容')
})

test('"叫醒了没回音"要给出下一步动作：建议规则可以复制（不代写仓库文件）', () => {
  const { registrations, render } = loadClient()
  const desk = registrations.find((r) => r.opts.id === 'session-superagent-desk')
  const snap = {
    loading: false, error: null,
    body: { sessionGoal: null, sessionTitle: 'x', credentials: {}, watchers: [
      watcher('a/b', { id: 'a/b#s1', silentWakes: 3 }),
    ] },
  }
  // 1) 默认不渲染弹层内容（不该占版面）
  const closed = walk(render(desk, deskQueue(snap))).filter((n) => typeof n.text === 'string').map((n) => n.text).join(' | ')
  assert.ok(!closed.includes('主理鱼（dsh-session-superagent）处理规则'), '没点开时不该渲染规则文本')
  assert.ok(closed.includes('没有动作'), '要有那条提示（措辞已从“回音”改成“动作”，更具体）')

  // 2) 点开后能看到规则，并且明确"不代写文件"
  const opened = walk(render(desk, deskQueue(snap, null, {}, 'overview', '', 'rules:a/b'))).filter((n) => typeof n.text === 'string').map((n) => n.text).join(' | ')
  assert.ok(opened.includes('主理鱼（dsh-session-superagent）处理规则'), '要给出可复制的规则：' + opened.slice(0, 200))
  assert.ok(opened.includes('watch_ack'), '规则里要强调 ack')
  assert.ok(opened.includes('复制这段规则'), '要有复制动作')
})

test('「按仓库」汇总里的仓库名可以点（点一下只看这个仓库）', () => {
  const { registrations, render } = loadClient()
  const desk = registrations.find((r) => r.opts.id === 'session-superagent-desk')
  const snap = {
    loading: false, error: null,
    body: { sessionGoal: null, sessionTitle: 'x', credentials: {}, watchers: [
      watcher('a/b', { id: 'a/b#s1' }),
      watcher('c/d', { id: 'c/d#s2', sessionId: 'session-c/d' }),
    ] },
  }
  const nodes = walk(render(desk, deskQueue(snap)))
  const buttons = nodes.filter((n) => n.type === 'button' && n.props && typeof n.props.onClick === 'function' && n.props.title === '点一下只看这个仓库（再点取消）')
  assert.equal(buttons.length, 2, '每个仓库一个可点名字')
  // 搜索已命中某仓库时，只应看到它的明细
  const filtered = walk(render(desk, deskQueue(snap, null, {}, 'overview', 'a/b')))
    .filter((n) => typeof n.text === 'string').map((n) => n.text).join(' | ')
  assert.ok(filtered.includes('a/b'), '命中的要留下')
  assert.ok(!filtered.includes('c/d'), '不命中的要过滤掉：' + filtered.slice(0, 200))
})

test('「只看有问题的」：一键筛掉健康的守，并且能一键回到全部', () => {
  const { registrations, render } = loadClient()
  const desk = registrations.find((r) => r.opts.id === 'session-superagent-desk')
  const snap = {
    loading: false, error: null,
    body: { sessionGoal: null, sessionTitle: 'x', credentials: {}, watchers: [
      watcher('ok/healthy', { id: 'ok/healthy#s1' }),
      watcher('bad/error', { id: 'bad/error#s2', sessionId: 's2', lastError: 'boom' }),
      watcher('bad/silent', { id: 'bad/silent#s3', sessionId: 's3', silentWakes: 3 }),
    ] },
  }
  const all = walk(render(desk, deskQueue(snap))).filter((n) => typeof n.text === 'string').map((n) => n.text).join(' | ')
  assert.ok(all.includes('只看有问题的 (2)'), '要有入口并带上数量：' + all.slice(0, 200))

  // problemsOnly = true（第 18 个槽）
  const only = walk(render(desk, deskQueue(snap, null, {}, 'overview', '', '', null, false))).filter((n) => typeof n.text === 'string').map((n) => n.text).join(' | ')
  const filteredQueue = deskQueue(snap)
  filteredQueue[17] = true
  const onlyBad = walk(render(desk, filteredQueue)).filter((n) => typeof n.text === 'string').map((n) => n.text).join(' | ')
  assert.ok(onlyBad.includes('bad/error') && onlyBad.includes('bad/silent'), '有问题的要留下')
  assert.ok(!onlyBad.includes('ok/healthy'), '健康的不该出现：' + onlyBad.slice(0, 240))
  assert.ok(onlyBad.includes('全部'), '要能一键回到全部')
})

test('只读仓库要在「需要关注」里出现（不能只靠行内一个小徽章）', () => {
  const { registrations, render } = loadClient()
  const desk = registrations.find((r) => r.opts.id === 'session-superagent-desk')
  const snap = {
    loading: false, error: null,
    body: { sessionGoal: null, sessionTitle: 'x', credentials: {}, watchers: [
      watcher('me/readonly', { id: 'me/readonly#s1', repoAccess: { repo: 'me/readonly', push: false, hasIssues: true } }),
      watcher('me/writable', { id: 'me/writable#s2', sessionId: 's2', repoAccess: { repo: 'me/writable', push: true, hasIssues: true } }),
    ] },
  }
  const text = walk(render(desk, deskQueue(snap))).filter((n) => typeof n.text === 'string').map((n) => n.text).join(' | ')
  assert.ok(text.includes('只有读权限'), '要有人话说明：' + text.slice(0, 240))
  assert.ok(text.includes('换有写权限的 token'), '要给出下一步')
  assert.ok(!text.includes('你对 me/writable 只有读权限'), '有写权限的仓库不该出现这条')
})

test('gh 不可用要说清后果与下一步（不能只显示原始错误）', () => {
  const { registrations, render } = loadClient()
  const desk = registrations.find((r) => r.opts.id === 'session-superagent-desk')
  const snap = {
    loading: false, error: null,
    body: {
      sessionGoal: null, sessionTitle: 'x', credentials: { token: 'none', sshKeyPath: 'none' },
      gh: { ok: false, error: 'gh: command not found' },
      watchers: [watcher('a/b', { id: 'a/b#s1' })],
    },
  }
  const text = walk(render(desk, deskQueue(snap, null, {}, 'settings', '', false, null, false, 'source')))
    .filter((n) => typeof n.text === 'string').map((n) => n.text).join(' | ')
  assert.ok(text.includes('gh auth login'), '要给出下一步命令：' + text.slice(0, 300))
  assert.ok(text.includes('填 token'), '要给备选方案')

  const overviewText = walk(render(desk, deskQueue(snap))).filter((n) => typeof n.text === 'string').map((n) => n.text).join(' | ')
  assert.ok(overviewText.includes('所有轮询都会失败'), '总览要说明后果：' + overviewText.slice(0, 300))
})

test('token 告警与来源指引都进入「凭证」，不再误指「来源」', () => {
  const { registrations, render } = loadClient()
  const desk = registrations.find((r) => r.opts.id === 'session-superagent-desk')
  const snap = {
    loading: false, error: null,
    body: {
      sessionGoal: null, sessionTitle: 'x', credentials: { token: 'none', sshKeyPath: 'none' },
      gh: { ok: false, error: 'gh: command not found' },
      watchers: [watcher('a/b', { id: 'a/b#s1' })],
    },
  }
  const overviewText = walk(render(desk, deskQueue(snap)))
    .filter((n) => typeof n.text === 'string').map((n) => n.text).join(' | ')
  assert.ok(overviewText.includes('设置 → 凭证'), 'token 告警必须指向凭证：' + overviewText.slice(0, 400))
  assert.ok(!overviewText.includes('设置 → 来源'), 'token 告警不得再指向来源：' + overviewText.slice(0, 400))

  const sourceQueue = deskQueue(snap, null, {}, 'settings')
  sourceQueue[14] = 'source'
  const sourceText = walk(render(desk, sourceQueue))
    .filter((n) => typeof n.text === 'string').map((n) => n.text).join(' | ')
  assert.ok(sourceText.includes('「凭证」填 token'), '来源页的 token 指引必须点明凭证分区：' + sourceText.slice(0, 500))
  assert.ok(!sourceText.includes('下面填 token'), '来源页下面没有 token 表单，不能使用位置误导：' + sourceText.slice(0, 500))
})

test('归档 / 禁用仓库也要在「需要关注」里说清（客户端之前漏了这两条）', () => {
  const { registrations, render } = loadClient()
  const desk = registrations.find((r) => r.opts.id === 'session-superagent-desk')
  const snap = {
    loading: false, error: null,
    body: { sessionGoal: null, sessionTitle: 'x', credentials: {}, watchers: [
      watcher('old/archived', { id: 'old/archived#s1', repoAccess: { repo: 'old/archived', archived: true, push: false } }),
      watcher('gone/disabled', { id: 'gone/disabled#s2', sessionId: 's2', repoAccess: { repo: 'gone/disabled', disabled: true, push: true } }),
    ] },
  }
  const text = walk(render(desk, deskQueue(snap))).filter((n) => typeof n.text === 'string').map((n) => n.text).join(' | ')
  assert.ok(text.includes('已归档'), '归档要说：' + text.slice(0, 240))
  assert.ok(text.includes('已被禁用'), '禁用要说')
  assert.ok(text.includes('只能看、不能回写'), '归档要说明后果')
})

test('面板显示本会话用量，到上限时给出可执行的建议', () => {
  const { registrations, render } = loadClient()
  const desk = registrations.find((r) => r.opts.id === 'session-superagent-desk')
  const base = { sessionGoal: null, sessionTitle: 'x', credentials: {}, watchers: [watcher('a/b', { id: 'a/b#s1' })] }

  const half = walk(render(desk, deskQueue({ loading: false, error: null, body: { ...base, sessionUsage: { used: 3, cap: 12, capped: 0 } } })))
    .filter((n) => typeof n.text === 'string').map((n) => n.text).join(' | ')
  // 0.9.164 起用量也是 Stat（数值 3 / 12 + 单位「本会话近一小时唤醒」），断言两者都在
  assert.ok(half.includes('3 / 12'), '要有用量数值：' + half.slice(0, 200))
  assert.ok(half.includes('本会话近一小时唤醒'), '要有单位说明：' + half.slice(0, 200))
  assert.ok(!half.includes('已到上限'), '没用满时不该报警')

  const full = walk(render(desk, deskQueue({ loading: false, error: null, body: { ...base, sessionUsage: { used: 12, cap: 12, capped: 2, suggest: 24 } } })))
    .filter((n) => typeof n.text === 'string').map((n) => n.text).join(' | ')
  assert.ok(full.includes('已到上限'), '到上限要提示')
  assert.ok(full.includes('调到 24'), '要给出具体数字而不是只说“调大”：' + full.slice(0, 260))
  assert.ok(full.includes('2 条守正因上限暂停'), '要说清影响')
})

test('暂停原因可以按原因码筛选（点 Pill 只看那一类）', () => {
  const { registrations, render } = loadClient()
  const desk = registrations.find((r) => r.opts.id === 'session-superagent-desk')
  const snap = {
    loading: false, error: null,
    body: { sessionGoal: null, sessionTitle: 'x', credentials: {}, watchers: [
      watcher('a/cap', { id: 'a/cap#s1', deferReason: 'cap-session', lastDeferred: '这条会话一小时内已被唤醒 12 次' }),
      watcher('b/rate', { id: 'b/rate#s2', sessionId: 's2', deferReason: 'ratelimit', lastDeferred: '被 GitHub 限流' }),
    ] },
  }
  // 判定页要列出原因码与人话
  const judge = walk(render(desk, deskQueue(snap, null, {}, 'judge'))).filter((n) => typeof n.text === 'string').map((n) => n.text).join(' | ')
  assert.ok(judge.includes('撞会话上限'), '原因码要翻成人话：' + judge.slice(0, 240))
  assert.ok(judge.includes('被 GitHub 限流'), '另一个原因也要在')

  // 选中 defer:cap-session 后，明细只剩那一类
  const filtered = deskQueue(snap, null, {}, 'overview')
  filtered[15] = 'defer:cap-session'
  const text = walk(render(desk, filtered)).filter((n) => typeof n.text === 'string').map((n) => n.text).join(' | ')
  assert.ok(text.includes('a/cap'), '命中原因的要留下')
  assert.ok(!text.includes('b/rate'), '别的原因不该出现：' + text.slice(0, 240))
})

test('判定页：搜索框输入编号后可追溯（点它问服务端要结论）', () => {
  const { registrations, render } = loadClient()
  const desk = registrations.find((r) => r.opts.id === 'session-superagent-desk')
  const snap = {
    loading: false, error: null,
    body: { sessionGoal: null, sessionTitle: 'x', credentials: {}, watchers: [watcher('a/b', { id: 'a/b#s1' })] },
  }
  const empty = walk(render(desk, deskQueue(snap, null, {}, 'judge'))).filter((n) => typeof n.text === 'string').map((n) => n.text).join(' | ')
  assert.ok(empty.includes('追溯一条'), '要有追溯区块')
  assert.ok(empty.includes('输入编号'), '没输入时要提示怎么用')

  const filled = walk(render(desk, deskQueue(snap, null, {}, 'judge', '42'))).filter((n) => typeof n.text === 'string').map((n) => n.text).join(' | ')
  assert.ok(filled.includes('追溯 #42'), '输入编号后要出现追溯按钮：' + filled.slice(0, 200))
  assert.ok(filled.includes('在 a/b 里查'), '只有一条守时应说明在哪个仓库查')
})

test('面板显示近几天的累计（来自每条守的 daily）', () => {
  const { registrations, render } = loadClient()
  const desk = registrations.find((r) => r.opts.id === 'session-superagent-desk')
  const snap = {
    loading: false, error: null,
    body: { sessionGoal: null, sessionTitle: 'x', credentials: {}, sessionUsage: { used: 2, cap: 12, capped: 0 },
      watchers: [watcher('a/b', { id: 'a/b#s1', daily: { days: 3, total: 9, avg: 3 } })] },
  }
  const text = walk(render(desk, deskQueue(snap))).filter((n) => typeof n.text === 'string').map((n) => n.text).join(' | ')
  assert.ok(text.includes('过去 3 天：共 9 次'), '要显示历史累计：' + text.slice(0, 240))
})

test('"今天明显比平时忙"只有 busy=true 时才提示（阈值判断在服务端）', () => {
  const { registrations, render } = loadClient()
  const desk = registrations.find((r) => r.opts.id === 'session-superagent-desk')
  const mk = (busy) => ({
    loading: false, error: null,
    body: { sessionGoal: null, sessionTitle: 'x', credentials: {}, sessionUsage: { used: 2, cap: 12, capped: 0 },
      watchers: [watcher('a/b', { id: 'a/b#s1', daily: { days: 4, total: 12, avg: 3, today: 9 }, busy })] },
  })
  const calm = walk(render(desk, deskQueue(mk(false)))).filter((n) => typeof n.text === 'string').map((n) => n.text).join(' | ')
  assert.ok(!calm.includes('明显比平时忙'), '不该提示：' + calm.slice(0, 200))
  const hot = walk(render(desk, deskQueue(mk(true)))).filter((n) => typeof n.text === 'string').map((n) => n.text).join(' | ')
  assert.ok(hot.includes('今天明显比平时忙'), '该提示时要提示')
  assert.ok(hot.includes('上限可能不够用'), '要说明为什么值得注意')
})

test('面板与唤醒消息说的是同一套规则（AGENTS.md → 修/回/待定 → ack）', () => {
  const { registrations, render } = loadClient()
  const desk = registrations.find((r) => r.opts.id === 'session-superagent-desk')
  const snap = {
    loading: false, error: null,
    body: { sessionGoal: null, sessionTitle: 'x', credentials: {}, watchers: [watcher('a/b', { id: 'a/b#s1' })] },
  }
  const text = walk(render(desk, deskQueue(snap))).filter((n) => typeof n.text === 'string').map((n) => n.text).join(' ')
  // 三件事必须都能在面板里找到，否则客户只看到"会叫醒我"，不知道叫醒之后发生什么
  assert.ok(text.includes('AGENTS.md'), '面板要提到按仓库规则判断')
  assert.ok(text.includes('修 / 回 / 待定'), '面板要给出三种处理方式')
  assert.ok(text.includes('watch_ack'), '面板要说明最后要 ack')
  assert.ok(text.includes('不会扩大范围'), '面板要说清只处理列出的那几条')
  // 隔离执行的说明在「触发」页，单独渲染一次
  const triggerText = walk(render(desk, deskQueue(snap, null, {}, 'trigger'))).filter((n) => typeof n.text === 'string').map((n) => n.text).join(' ')
  assert.ok(triggerText.includes('自动回收'), '隔离执行要说明用完会回收：' + triggerText.slice(0, 200))
})

test('只读提示必须说出仓库名（不能是"你对 这个仓库 只有读权限"）', () => {
  const { registrations, render } = loadClient()
  const desk = registrations.find((r) => r.opts.id === 'session-superagent-desk')
  const snap = {
    loading: false, error: null,
    body: { sessionGoal: null, sessionTitle: 'x', credentials: {}, sessionUsage: { used: 0, cap: 12, capped: 0 },
      watchers: [watcher('acme/widgets', { id: 'acme/widgets#s1', repoAccess: { repo: undefined, push: false } })] },
  }
  const text = walk(render(desk, deskQueue(snap))).filter((n) => typeof n.text === 'string').map((n) => n.text).join(' | ')
  assert.ok(text.includes('你对 acme/widgets 只有读权限'), '要带上仓库名：' + text.slice(0, 240))
  assert.ok(!text.includes('你对 这个仓库'), '不该出现占位文案')
})

test('术语表覆盖客户会在面板上遇到的词（含"上限"这种歧义词）', () => {
  const { registrations, render } = loadClient()
  const desk = registrations.find((r) => r.opts.id === 'session-superagent-desk')
  const snap = {
    loading: false, error: null,
    body: { sessionGoal: null, sessionTitle: 'x', credentials: {}, watchers: [watcher('a/b', { id: 'a/b#s1' })] },
  }
  const text = walk(render(desk, deskQueue(snap, null, {}, 'overview', '', true))).filter((n) => typeof n.text === 'string').map((n) => n.text).join(' | ')
  for (const term of ['主理鱼', '唤醒', '隔离', 'ack', '上限', '没有动作', '临时副本']) {
    assert.ok(text.includes(term), '术语表缺「' + term + '」')
  }
  // "上限"必须有歧义澄清：会话上限 vs GitHub 限流
  assert.ok(text.includes('GitHub 的限流'), '要说清"上限"和 GitHub 限流不是一回事')
})

test('长错误不能把建议切掉（截断曾恰好切掉最有用的一段）', () => {
  const { registrations, render } = loadClient()
  const desk = registrations.find((r) => r.opts.id === 'session-superagent-desk')
  const longMain = '轮询失败：' + 'x'.repeat(200)
  const hint = '（网络抖动：这一轮没连上 GitHub，已按退避自动重试，不需要手动处理）'
  const snap = {
    loading: false, error: null,
    body: { sessionGoal: null, sessionTitle: 'x', credentials: {}, sessionUsage: { used: 0, cap: 12, capped: 0 },
      watchers: [watcher('a/b', { id: 'a/b#s1', lastError: longMain + hint })] },
  }
  const text = walk(render(desk, deskQueue(snap))).filter((n) => typeof n.text === 'string').map((n) => n.text).join(' | ')
  assert.ok(text.includes('已按退避自动重试'), '建议必须完整出现：' + text.slice(0, 300))
  assert.ok(!text.includes('x'.repeat(150)), '现象部分要截断，避免占满版面')
})

test('首次使用（空态）不能露出内部字段名，并且要给出三步引导', () => {
  const { registrations, render } = loadClient()
  const desk = registrations.find((r) => r.opts.id === 'session-superagent-desk')
  const empty = {
    loading: false, error: null,
    body: { sessionGoal: null, sessionTitle: null, credentials: {}, sessionUsage: null, watchers: [] },
  }
  const text = walk(render(desk, deskQueue(empty))).filter((n) => typeof n.text === 'string').map((n) => n.text).join(' | ')
  assert.ok(text.includes('三步让这个会话开始盯办'), '空态要有引导：' + text.slice(0, 200))
  for (const leaked of ['deferReason', 'silentWakes', 'cursor', 'filterCounts', 'watch_ack']) {
    assert.ok(!text.includes(leaked), '空态露出了内部字段：' + leaked)
  }
  assert.ok(!text.includes('需要会话上下文'), '「需要会话上下文」是内部说法，客户看不懂')
})

test('空态三步里提到的控件，必须在「触发」页真实存在（改名会让引导失效）', () => {
  const { registrations, render } = loadClient()
  const desk = registrations.find((r) => r.opts.id === 'session-superagent-desk')
  const empty = {
    loading: false, error: null,
    body: { sessionGoal: null, sessionTitle: 'x', credentials: {}, sessionUsage: null, watchers: [] },
  }
  const text = (tree) => walk(tree).filter((n) => typeof n.text === 'string').map((n) => n.text).join(' | ')
  const overview = text(render(desk, deskQueue(empty)))
  const trigger = text(render(desk, deskQueue(empty, null, {}, 'trigger'), { sessionId: 's1' }))

  // 从引导里抽出所有「…」引号内的控件名/标签名
  const quoted = [...overview.matchAll(/「([^」]{2,12})」/g)].map((m) => m[1])
  assert.ok(quoted.length >= 3, '引导里应该有若干可引用的控件名：' + quoted.join('/'))
  for (const name of quoted) {
    // 只查「触发」页：引导文本自己就含这个词，用整页文本会把自引用当通过（第一版就是这么假通过的）
    assert.ok(trigger.includes(name), '引导提到的「' + name + '」在「触发」页找不到（可能改名了）')
  }
  // 三个步骤里的关键词也要能对上真实字段
  for (const word of ['仓库', '间隔']) {
    assert.ok(trigger.includes(word), '「触发」页缺字段：' + word)
  }
})

test('「需要关注」按严重程度排序：会丢消息的排最前，静态提示排后', () => {
  const { registrations, render } = loadClient()
  const desk = registrations.find((r) => r.opts.id === 'session-superagent-desk')
  const snap = {
    loading: false, error: null,
    body: {
      sessionGoal: null, sessionTitle: 'x', credentials: { token: 'ok' }, sessionUsage: { used: 0, cap: 12, capped: 0 },
      watchers: [watcher('a/b', {
        id: 'a/b#s1',
        lastError: 'GitHub API 请求: EOF（网络抖动：这一轮没连上 GitHub，已按退避自动重试，不需要手动处理）',
        repoAccess: { push: false, archived: true, hasIssues: true },
        silentWakes: 3,
      })],
    },
  }
  const text = walk(render(desk, deskQueue(snap))).filter((n) => typeof n.text === 'string').map((n) => n.text).join(' | ')
  const at = (needle) => text.indexOf(needle)
  const errPos = at('轮询失败')
  const silentPos = at('没有动作')
  const structurePos = at('已归档')
  const readonlyPos = at('只有读权限')
  assert.ok(errPos >= 0 && silentPos >= 0 && structurePos >= 0 && readonlyPos >= 0, '四类提示都要在：' + text.slice(0, 300))
  assert.ok(errPos < structurePos, '轮询失败要排在"已归档"前面')
  assert.ok(errPos < readonlyPos, '轮询失败要排在"只读"前面')
  assert.ok(silentPos < structurePos, '"没回音"要排在"已归档"前面')
})

test('判定页的日志标题要说清"最近 5 次唤醒"（数据早就有，只是名字看不出来）', () => {
  const { registrations, render } = loadClient()
  const desk = registrations.find((r) => r.opts.id === 'session-superagent-desk')
  const at = (mins) => new Date(Date.now() - mins * 60000).toISOString()
  const snap = {
    loading: false, error: null,
    body: { sessionGoal: null, sessionTitle: 'x', credentials: {}, sessionUsage: { used: 1, cap: 12, capped: 0 },
      watchers: [watcher('a/b', { id: 'a/b#s1', history: [
        { at: at(50), numbers: [1], ok: true },
        { at: at(40), numbers: [2], ok: false, reason: 'agent busy' },
        { at: at(30), numbers: [3, 4], ok: true },
      ] })] },
  }
  const text = walk(render(desk, deskQueue(snap, null, {}, 'judge'))).filter((n) => typeof n.text === 'string').map((n) => n.text).join(' | ')
  assert.ok(text.includes('最近 5 次唤醒'), '标题要能看出这是最近几次：' + text.slice(0, 240))
  assert.ok(text.includes('#3 #4'), '要能看到最近一次唤醒的条目')
  assert.ok(text.includes('agent busy'), '失败原因要显示')
})

test('同一仓库被多个会话守着时，面板要说清"还有谁在守"', () => {
  const { registrations, render } = loadClient()
  const desk = registrations.find((r) => r.opts.id === 'session-superagent-desk')
  const snap = {
    loading: false, error: null,
    body: { sessionGoal: null, sessionTitle: 'x', credentials: {}, sessionUsage: { used: 1, cap: 12, capped: 0 },
      watchers: [watcher('a/b', { id: 'a/b#s1', lastWake: '2026-11-02T09:00:00.000Z', otherSessions: ['session-2', 'session-3'] })] },
  }
  const text = walk(render(desk, deskQueue(snap))).filter((n) => typeof n.text === 'string').map((n) => n.text).join(' | ')
  assert.ok(text.includes('还有 2 个会话也在守这个仓库'), '总览行要说清还有谁：' + text.slice(0, 300))
  assert.ok(text.includes('ack 标签是仓库级的'), '要说清 ack 标签是共享的：' + text.slice(0, 400))

  // 没有别的会话时不显示
  const solo = { ...snap, body: { ...snap.body, watchers: [watcher('a/b', { id: 'a/b#s1', lastWake: '2026-11-02T09:00:00.000Z', otherSessions: [] })] } }
  const soloText = walk(render(desk, deskQueue(solo, null, {}, 'judge'))).filter((n) => typeof n.text === 'string').map((n) => n.text).join(' | ')
  assert.ok(!soloText.includes('也在守这个仓库'), '独占时不显示')
})

test('错误旁边要有「下一步」按钮（登录失效 → 去填 token；改名 → 改仓库地址）', () => {
  const { registrations, render } = loadClient()
  const desk = registrations.find((r) => r.opts.id === 'session-superagent-desk')
  const at = (mins) => new Date(Date.now() - mins * 60000).toISOString()
  const base = (kind, err) => ({
    loading: false, error: null,
    body: { sessionGoal: null, sessionTitle: 'x', credentials: {}, sessionUsage: { used: 1, cap: 12, capped: 0 },
      watchers: [watcher('a/b', {
        id: 'a/b#s1', lastWake: at(30), history: [{ at: at(30), numbers: [1], ok: true }],
        lastError: err, lastErrorKind: kind,
      })] },
  })
  const text = (snap) => walk(render(desk, deskQueue(snap))).filter((n) => typeof n.text === 'string').map((n) => n.text).join(' | ')

  const auth = text(base('auth', 'GitHub API 请求: 401（gh 登录失效：跑 gh auth login，或在面板填 token）'))
  assert.ok(auth.includes('去填 token'), '登录失效要给「去填 token」：' + auth.slice(0, 300))

  const moved = text(base('moved', 'GitHub API 请求: 301（仓库改名或转移了：用新地址重新添加）'))
  assert.ok(moved.includes('改仓库地址'), '改名要给「改仓库地址」')

  const net = text(base('network', 'GitHub API 请求: EOF（网络抖动：已按退避自动重试）'))
  assert.ok(net.includes('立刻重试'), '网络问题要给「立刻重试」')

  const other = text(base('other', 'GitHub API 请求: 418 我是茶壶'))
  assert.ok(!other.includes('去填 token') && !other.includes('改仓库地址') && !other.includes('立刻重试'), '未归类的错误不给乱指路的按钮')
})

// 造一个「此刻一定在窗口外」的时段：从当前小时 +6 开始，长度 1 小时（跨夜也能算）
function outsideWindow() {
  const start = (new Date().getHours() + 6) % 24
  const pad = (n) => String(n).padStart(2, '0')
  return pad(start) + ':00-' + pad((start + 1) % 24) + ':00'
}

test('顶部四个计数必须加得上总数（互斥，不重复数）', () => {
  const { registrations, render } = loadClient()
  const desk = registrations.find((r) => r.opts.id === 'session-superagent-desk')
  const at = (mins) => new Date(Date.now() - mins * 60000).toISOString()
  // 四种状态各一条 + 一条"已暂停且出错"（以前会被数两次）
  const list = [
    watcher('a/active', { id: 'a/active#s1', lastWake: at(10) }),
    watcher('a/paused', { id: 'a/paused#s1', enabled: false, lastWake: at(10) }),
    watcher('a/error', { id: 'a/error#s1', lastError: 'GitHub API 请求: EOF（网络抖动）', lastWake: at(10) }),
    // 时段要「此刻一定不在窗口内」——写死 03:00-04:00 会在凌晨跑测试时变成 inside（真踩过）
    watcher('a/dormant', { id: 'a/dormant#s1', activeHours: outsideWindow(), lastWake: at(10) }),
    watcher('a/both', { id: 'a/both#s1', enabled: false, lastError: 'GitHub API 请求: EOF（网络抖动）', lastWake: at(10) }),
  ]
  const snap = { loading: false, error: null,
    body: { sessionGoal: null, sessionTitle: 'x', credentials: {}, sessionUsage: { used: 1, cap: 12, capped: 0 }, watchers: list } }
  const text = walk(render(desk, deskQueue(snap))).filter((n) => typeof n.text === 'string').map((n) => n.text).join(' | ')
  const value = (label) => {
    const idx = text.indexOf(' | ' + label)
    const before = text.slice(0, idx).split(' | ')
    return Number(before[before.length - 1])
  }
  const total = value('条主理鱼')
  const sum = value('主理中') + value('已暂停') + value('异常') + value('时段外')
  assert.equal(total, 5, '总数 5 条：' + text.slice(0, 200))
  assert.equal(sum, total, '分项之和要等于总数（实际 ' + sum + ' vs ' + total + '）')
})

test('历史数据里残留的 304 不该被算成「异常」', () => {
  const { registrations, render } = loadClient()
  const desk = registrations.find((r) => r.opts.id === 'session-superagent-desk')
  const at = (mins) => new Date(Date.now() - mins * 60000).toISOString()
  const snap = {
    loading: false, error: null,
    body: { sessionGoal: null, sessionTitle: 'x', credentials: {}, sessionUsage: { used: 1, cap: 12, capped: 0 },
      watchers: [watcher('a/b', { id: 'a/b#s1', lastWake: at(10), lastError: 'gh: HTTP 304（没有变化 —— 条件请求命中 304，这不是错误）' })] },
  }
  const text = walk(render(desk, deskQueue(snap))).filter((n) => typeof n.text === 'string').map((n) => n.text).join(' | ')
  const counters = text.match(/(\d+)\s*\|\s*异常/) || []
  assert.ok(!/\|\s*1\s*\|\s*异常/.test(text), '304 不该算进异常：' + text.slice(0, 200))
})

test('错误要标出「多久之前」，超过一小时标「旧记录」', () => {
  const { registrations, render } = loadClient()
  const desk = registrations.find((r) => r.opts.id === 'session-superagent-desk')
  const at = (mins) => new Date(Date.now() - mins * 60000).toISOString()
  const snap = (mins) => ({
    loading: false, error: null,
    body: { sessionGoal: null, sessionTitle: 'x', credentials: {}, sessionUsage: { used: 1, cap: 12, capped: 0 },
      watchers: [watcher('a/b', {
        id: 'a/b#s1', lastWake: at(5), lastError: 'GitHub API 请求: EOF（网络抖动）', lastErrorKind: 'network',
        lastErrorAt: at(mins),
      })] },
  })
  const text = (mins) => walk(render(desk, deskQueue(snap(mins)))).filter((n) => typeof n.text === 'string').map((n) => n.text).join(' | ')

  const fresh = text(3)
  assert.ok(/\d+ 分钟前/.test(fresh), '新错误要带时间：' + fresh.slice(0, 200))
  assert.ok(!fresh.includes('旧记录'), '刚发生的错误不该标旧记录')

  const old = text(150)
  assert.ok(old.includes('旧记录'), '150 分钟前的错误要标「旧记录」：' + old.slice(0, 200))
})

test('凭证失效时面板要显眼提示「不会自己恢复」', () => {
  const { registrations, render } = loadClient()
  const desk = registrations.find((r) => r.opts.id === 'session-superagent-desk')
  const at = (mins) => new Date(Date.now() - mins * 60000).toISOString()
  const snap = {
    loading: false, error: null,
    body: { sessionGoal: null, sessionTitle: 'x', credentials: {}, sessionUsage: { used: 1, cap: 12, capped: 0 },
      watchers: [watcher('a/b', {
        id: 'a/b#s1', lastWake: at(10), needsReauth: true,
        lastError: 'GitHub API 请求: 401（gh 登录失效：跑 gh auth login，或在面板填 token）',
        lastErrorKind: 'auth', lastErrorAt: at(5),
      })] },
  }
  const text = walk(render(desk, deskQueue(snap))).filter((n) => typeof n.text === 'string').map((n) => n.text).join(' | ')
  assert.ok(text.includes('凭证失效'), '要有凭证失效提示：' + text.slice(0, 300))
  assert.ok(text.includes('不会自己恢复'), '要说清不会自愈')
  assert.ok(text.includes('gh auth login'), '要给出具体命令')
})

test('连续失败时面板要显示「第几次失败 + 下次重试」', () => {
  const { registrations, render } = loadClient()
  const desk = registrations.find((r) => r.opts.id === 'session-superagent-desk')
  const at = (mins) => new Date(Date.now() - mins * 60000).toISOString()
  const soon = (mins) => new Date(Date.now() + mins * 60000).toISOString()
  const snap = {
    loading: false, error: null,
    body: { sessionGoal: null, sessionTitle: 'x', credentials: {}, sessionUsage: { used: 1, cap: 12, capped: 0 },
      watchers: [watcher('a/b', {
        id: 'a/b#s1', lastWake: at(10), consecutiveFailures: 7, nextAt: soon(90),
        lastError: 'GitHub API 请求: 401（gh 登录失效）', lastErrorKind: 'auth', lastErrorAt: at(30),
      })] },
  }
  const text = walk(render(desk, deskQueue(snap))).filter((n) => typeof n.text === 'string').map((n) => n.text).join(' | ')
  assert.ok(text.includes('已连续失败 7 次'), '要报失败次数：' + text.slice(0, 300))
  assert.ok(/下次重试约 \d+ 分钟后/.test(text), '要说明下次重试时间：' + text.slice(0, 300))
  assert.ok(text.includes('2 小时档'), '超过预算要说明已放慢')
})

test('「已放慢到 X 小时档」从后端 retryPolicy 算，不是写死的', () => {
  const { registrations, render } = loadClient()
  const desk = registrations.find((r) => r.opts.id === 'session-superagent-desk')
  const at = (mins) => new Date(Date.now() - mins * 60000).toISOString()
  const soon = (mins) => new Date(Date.now() + mins * 60000).toISOString()
  const snap = (policy) => ({
    loading: false, error: null,
    body: { sessionGoal: null, sessionTitle: 'x', credentials: {}, sessionUsage: { used: 1, cap: 12, capped: 0 },
      retryPolicy: policy,
      watchers: [watcher('a/b', { id: 'a/b#s1', lastWake: at(10), consecutiveFailures: 8, nextAt: soon(60) })] },
  })
  const text = (policy) => walk(render(desk, deskQueue(snap(policy)))).filter((n) => typeof n.text === 'string').map((n) => n.text).join(' | ')

  assert.ok(text({ budgetAttempts: 6, slowCapMinutes: 120 }).includes('2 小时档'), '默认应是 2 小时档')
  assert.ok(text({ budgetAttempts: 6, slowCapMinutes: 90 }).includes('1.5 小时档'), '改成 90 分钟要跟着变：' + text({ budgetAttempts: 6, slowCapMinutes: 90 }).slice(0, 200))
  // 预算调大后，8 次还没超预算，就不该说"已放慢"
  assert.ok(!text({ budgetAttempts: 20, slowCapMinutes: 120 }).includes('已放慢'), '没超预算就不该提放慢')
})

test('默认值提示从 /state 的 defaults 读，不是写死的 12/3/6', () => {
  const { registrations, render } = loadClient()
  const desk = registrations.find((r) => r.opts.id === 'session-superagent-desk')
  const base = (defaults) => ({
    loading: false, error: null,
    body: { sessionGoal: null, sessionTitle: 'x', credentials: {}, sessionUsage: { used: 0, cap: 12, capped: 0 },
      defaults, watchers: [watcher('a/b', { id: 'a/b#s1' })] },
  })
  const text = (defaults, tab) => walk(render(desk, deskQueue(base(defaults), null, {}, tab))).filter((n) => typeof n.text === 'string').map((n) => n.text).join(' | ')

  // 审核 T23：这条以前只断言 all.length > 0 —— 名字说「从 defaults 读」，实际什么都没验。
  // 占位符是**属性**不是文本，得单独收集。
  const attrs = (defaults, tab) => walk(render(desk, deskQueue(base(defaults), null, {}, tab)))
    .map((n) => (n.props && typeof n.props.placeholder === 'string' ? n.props.placeholder : ''))
    .filter(Boolean).join(' | ')
  const customPlaceholders = attrs({ sessionMaxWakes: 30, maxWakesPerHour: 4, isolateKeepDays: 7 }, 'trigger')
  const defaultPlaceholders = attrs({}, 'trigger')
  assert.ok(customPlaceholders.includes('4（1-60）'), '每小时上限的占位符要跟 defaults 走，实际：' + customPlaceholders)
  assert.ok(defaultPlaceholders.includes('6（1-60）'), '没有 defaults 时才回落到 6，实际：' + defaultPlaceholders)
  assert.ok(!/undefined/.test(customPlaceholders + defaultPlaceholders), '占位符不能渲染成 undefined')
})

test('比例条不为 0 的类别画线段（避免 1px 脏点），并保持总段数正确', () => {
  const { registrations, render } = loadClient()
  const orbit = registrations.find((r) => r.opts.id === 'session-superagent-orbit')
  const one = [watcher('a/b', { id: 'a/b#s1', enabled: true })]
  const nodes = walk(render(orbit, [one, null, true, { x: 500, y: 700 }]))
  const bar = nodes.find((n) => n.props && n.props.className === 'sa-dock-bar')
  assert.ok(bar, '有守时要有比例条')
  const segs = (bar.props.children || []).filter((c) => c && c.props && c.props['data-tone'])
  assert.equal(segs.length, 1, '只有运行中一种状态时，只该画 1 段（实际 ' + segs.length + '）')
  assert.equal(segs[0].props['data-tone'], 'ok')

  const mixed = [
    watcher('a/b', { id: 'a/b#s1', enabled: true }),
    watcher('c/d', { id: 'c/d#s2', enabled: false }),
    watcher('e/f', { id: 'e/f#s3', enabled: true, lastError: 'gh: HTTP 502（网关）', lastErrorKind: 'gateway' }),
  ]
  const segs2 = walk(render(orbit, [mixed, null, true, { x: 500, y: 700 }]))
    .find((n) => n.props && n.props.className === 'sa-dock-bar').props.children
    .filter((c) => c && c.props && c.props['data-tone'])
  assert.equal(segs2.length, 3, '三种状态都有时画 3 段')
})

test('活跃时段用两个原生时间选择器（起 / 止），不再让人手打 09:00-23:00', () => {
  const { registrations, render } = loadClient()
  const desk = registrations.find((r) => r.opts.id === 'session-superagent-desk')
  const snap = {
    loading: false, error: null,
    body: {
      sessionGoal: null, sessionTitle: '会话', credentials: { token: 'none', sshKeyPath: 'none' },
      watchers: [watcher('a/b', { id: 'a/b#s1', activeHours: '09:00-23:00' })],
    },
  }
  const nodes = walk(render(desk, deskQueue(snap, null, {}, 'trigger')))
  const times = nodes.filter((n) => n.type === 'input' && n.props && n.props.type === 'time')
  assert.ok(times.length >= 2, '要有起止两个时间选择器（实际 ' + times.length + '）')
  assert.ok(times.some((n) => n.props['aria-label'] === '起始时间'), '要有「起始时间」')
  assert.ok(times.some((n) => n.props['aria-label'] === '结束时间'), '要有「结束时间」')

  // 跨夜要写出来（22:00-06:00）
  const night = walk(render(desk, deskQueue({
    loading: false, error: null,
    body: { sessionGoal: null, sessionTitle: 's', credentials: {}, watchers: [] },
  }, null, {}, 'trigger')))
  assert.ok(night.length > 0)
})

test('弹层键盘可达：带 tabIndex=-1 且 role=dialog（打开后可聚焦进去）', () => {
  const { registrations, render } = loadClient()
  const orbit = registrations.find((r) => r.opts.id === 'session-superagent-orbit')
  const nodes = walk(render(orbit, [[watcher('a/b')], null, true, { x: 720, y: 860 }]))
  const panel = nodes.find((n) => n.props && n.props.role === 'dialog')
  assert.ok(panel, '弹层没渲染')
  assert.equal(panel.props.tabIndex, -1, '弹层要能被程序聚焦（tabIndex=-1）')
  assert.ok(panel.props['aria-label'], '弹层要有 aria-label（读屏能念出概况）')
})

test('窗口很窄时弹层不能溢出屏幕（368 -> 视口宽 - 16）', () => {
  const { registrations, render, setViewport } = loadClient()
  const orbit = registrations.find((r) => r.opts.id === 'session-superagent-orbit')
  try {
    setViewport(360)
    const nodes = walk(render(orbit, [[watcher('a/b')], null, true, { x: 180, y: 700 }]))
    const panel = nodes.find((n) => n.props && n.props.role === 'dialog')
    assert.ok(panel, '弹层没渲染')
    assert.equal(panel.props.style.width, 344, '360 视口下应该是 344（360-16）')
    const left = Number(panel.props.style.left)
    assert.ok(left >= 8, '左边距不能为负：' + left)
    assert.ok(left + 344 <= 360, '右边也不能溢出：' + (left + 344))
  } finally {
    setViewport(1440)
  }
})

test('判定页事件行两行封顶：仓库 + 右对齐时间，第二行结果带编号', () => {
  const { registrations, render } = loadClient()
  const desk = registrations.find((r) => r.opts.id === 'session-superagent-desk')
  const at = new Date(Date.now() - 600000).toISOString()
  const snap = {
    loading: false, error: null,
    body: {
      sessionGoal: null, sessionTitle: 's', credentials: {}, watchers: [
        watcher('a/b', { id: 'a/b#s1', history: [{ at, numbers: [12, 13], ok: true, reason: null }] }),
      ],
    },
  }
  const nodes = walk(render(desk, deskQueue(snap, null, {}, 'judge')))
  const head = nodes.find((n) => n.props && n.props.className === 'dt-event-head')
  assert.ok(head, '事件行要有 dt-event-head（仓库 + 时间同一行）')
  const texts = nodes.filter((n) => n.type === '#text').map((n) => n.text).join(' ')
  assert.ok(texts.includes('#12 #13'), '第二行要带编号：' + texts.slice(0, 240))
  assert.ok(texts.includes('10 分钟前'), '时间要在行内（右对齐）：' + texts.slice(0, 240))
})

test('判定页时间线按天分组：今天 / 昨天 有分节标题', () => {
  const { registrations, render } = loadClient()
  const desk = registrations.find((r) => r.opts.id === 'session-superagent-desk')
  const hours = (n) => new Date(Date.now() - n * 3600000).toISOString()
  // 今天某个时刻（若还没到，就用一分钟前），保证「今天」分组与运行时区无关
  const todayAt = (h, m) => {
    const d = new Date(); d.setHours(h, m, 0, 0)
    return (d.getTime() > Date.now() ? new Date(Date.now() - 60000) : d).toISOString()
  }
  const snap = {
    loading: false, error: null,
    body: {
      sessionGoal: null, sessionTitle: 's', credentials: {}, watchers: [
        watcher('a/b', {
          id: 'a/b#s1',
          history: [
            // 「今天」这一条不能写死「半小时前」：凌晨 00:18 跑测试时它会掉到昨天（真发生过）
            { at: todayAt(0, 30), numbers: [12], ok: true, reason: null },
            { at: hours(26), numbers: [10], ok: true, reason: null },
            { at: hours(50), numbers: [9], ok: false, reason: 'cap-session' },
          ],
        }),
      ],
    },
  }
  const nodes = walk(render(desk, deskQueue(snap, null, {}, 'judge')))
  const days = nodes.filter((n) => n.props && n.props.className === 'dt-timeline-day').map((n) => String((n.props.children || []).join('')))
  assert.ok(days.includes('今天'), '要有「今天」分组：' + days.join('|'))
  assert.ok(days.some((d) => d === '昨天' || /月/.test(d)), '更早的要单独分组：' + days.join('|'))
})

test('总览每条守都带三个动作按钮（立刻 / 暂停或恢复 / 删除）', () => {
  const { registrations, render } = loadClient()
  const desk = registrations.find((r) => r.opts.id === 'session-superagent-desk')
  const snap = {
    loading: false, error: null,
    body: {
      sessionGoal: null, sessionTitle: 's', credentials: {}, watchers: [
        watcher('a/b', { id: 'a/b#s1', enabled: true }),
        watcher('c/d', { id: 'c/d#s2', enabled: false }),
      ],
    },
  }
  const nodes = walk(render(desk, deskQueue(snap)))
  // 每个 dt-ticket-actions 容器里都要有 3 个可点控件（暂停/恢复按状态二选一）
  const groups = nodes.filter((n) => n.props && String(n.props.className || '').includes('dt-ticket-actions'))
  assert.equal(groups.length, 2, '两条守应该有两个动作容器，实际 ' + groups.length)
  for (const group of groups) {
    const buttons = walk({ type: 'div', props: group.props })
      .filter((n) => n.type === 'button' || (n.props && typeof n.props.onClick === 'function'))
    assert.ok(buttons.length >= 3, '每个动作容器至少 3 个控件，实际 ' + buttons.length)
  }
})

test('判定页空态也给路径：说明 + 去添加按钮（不是一句「还没有主理鱼」）', () => {
  const { registrations, render } = loadClient()
  const desk = registrations.find((r) => r.opts.id === 'session-superagent-desk')
  const snap = {
    loading: false, error: null,
    body: { sessionGoal: null, sessionTitle: 's', credentials: {}, watchers: [] },
  }
  const nodes = walk(render(desk, deskQueue(snap, null, {}, 'judge')))
  const empty = nodes.find((n) => n.props && n.props.className === 'dt-empty')
  assert.ok(empty, '判定页空态要有引导块')
  const text = nodes.filter((n) => n.type === '#text').map((n) => n.text).join(' ')
  assert.ok(text.includes('还没有可判定的记录'), text.slice(0, 200))
  assert.ok(text.includes('每轮判定都会记在这里'), '要说清加一条之后会发生什么：' + text.slice(0, 240))
  const labels = nodes.filter((n) => n.type === 'button')
    .map((b) => (b.props.children || []).filter((c) => typeof c === 'string').join(''))
  assert.ok(labels.some((l) => l.includes('去添加第一条')), '要能一键去添加：' + labels.join('|'))
})

test('弹层副行显示会话标题（不是只有 8 位 ID）', () => {
  const { registrations, render } = loadClient()
  const orbit = registrations.find((r) => r.opts.id === 'session-superagent-orbit')
  const list = [watcher('a/b', { title: '修复登录过期', intervalSec: 60 })]
  const nodes = walk(render(orbit, [list, null, true, { x: 700, y: 800 }]))
  const subs = nodes.filter((n) => n.props && n.props.className === 'sa-dock-sub').map((n) => (n.props.children || []).join(''))
  assert.ok(subs.length === 1, '应有一行副标题')
  assert.ok(subs[0].includes('修复登录过期'), '先给客户认得出的会话名：' + subs[0])
  assert.ok(subs[0].includes('#'), '同时保留短 ID 去重：' + subs[0])
})

test('弹层指标用官方「数值强 + 单位弱」两段（不是一句 1 / 2 主理中）', () => {
  const { registrations, render } = loadClient()
  const orbit = registrations.find((r) => r.opts.id === 'session-superagent-orbit')
  const list = [watcher('a/b', { id: 'a/b#s1', enabled: true }), watcher('c/d', { id: 'c/d#s2', enabled: false })]
  const nodes = walk(render(orbit, [list, null, true, { x: 700, y: 800 }]))
  // 0.9.155 起不再自造 sa-dock-metric-main/-unit，直接用官方 dt-stat / dt-stat-value
  const stat = nodes.find((n) => n.props && String(n.props.className || '') === 'dt-stat sa-dock-metric')
  assert.ok(stat, '指标要用官方 dt-stat')
  const value = nodes.find((n) => n.props && n.props.className === 'dt-stat-value')
  assert.ok(value, '要有 dt-stat-value（数值强）')
  assert.equal(String((value.props.children || []).join('')), '1 / 2')
})

test('面板统计条与弹层指标共用同一个 Stat（都是 dt-stat + dt-stat-value）', () => {
  const { registrations, render } = loadClient()
  const desk = registrations.find((r) => r.opts.id === 'session-superagent-desk')
  const snap = {
    loading: false, error: null,
    body: {
      sessionGoal: null, sessionTitle: 's', credentials: {}, watchers: [
        watcher('a/b', { id: 'a/b#s1', enabled: true }),
        watcher('c/d', { id: 'c/d#s2', enabled: false }),
      ],
    },
  }
  const nodes = walk(render(desk, deskQueue(snap)))
  const strip = nodes.filter((n) => n.props && n.props.className === 'dt-stats')
  assert.equal(strip.length, 1, '总览应有一个统计条')
  // 只算统计单元本身：className === 'dt-stat' 或以 'dt-stat ' 开头（dt-stat-value 不算）
  const isStatUnit = (c) => c === 'dt-stat' || c.startsWith('dt-stat ')
  const stats = nodes.filter((n) => n.props && isStatUnit(String(n.props.className || '')))
  assert.ok(stats.length >= 3, '统计条至少有 3 个统计单元，实际 ' + stats.length)
  const values = nodes.filter((n) => n.props && n.props.className === 'dt-stat-value')
  assert.ok(values.length >= stats.length, '每个统计单元都要有 dt-stat-value：' + values.length + ' vs ' + stats.length)
})

test('点统计数字能筛选：stateFilter=error 时只剩异常那条，并且「异常」是按下态', () => {
  const { registrations, render } = loadClient()
  const desk = registrations.find((r) => r.opts.id === 'session-superagent-desk')
  const snap = {
    loading: false, error: null,
    body: {
      sessionGoal: null, sessionTitle: 's', credentials: {}, watchers: [
        watcher('ok/one', { id: 'ok/one#s1', enabled: true }),
        watcher('bad/one', { id: 'bad/one#s2', enabled: true, lastError: 'gh: HTTP 502（网关）', lastErrorKind: 'gateway' }),
      ],
    },
  }
  const queue = deskQueue(snap)
  queue[18] = 'error'
  const nodes = walk(render(desk, queue))
  const pressed = nodes.filter((n) => n.type === 'button' && n.props && n.props['aria-pressed'] === true)
  const pressedText = pressed.map((b) => (b.props.children || []).map((c) => (c && c.props && c.props.children) || c).flat(2).join(''))
  assert.ok(pressedText.some((t) => String(t).includes('异常')), '「异常」统计要显示为按下：' + pressedText.join('|'))
  const text = nodes.filter((n) => n.type === '#text').map((n) => n.text).join(' ')
  assert.ok(text.includes('bad/one'), '异常那条要留下')
  assert.ok(!text.includes('ok/one'), '健康那条应被筛掉：' + text.slice(0, 200))
  // 筛选要有可见提示，并且能一键清掉
  // 提示文案按「文本块拼接」断言（横跨多个文本节点时要归一化空白再比）
  const flat = text.replace(/\s+/g, '')
  assert.ok(flat.includes('只看异常'), '要有筛选提示：' + text.slice(0, 200))
  assert.ok(flat.includes('的守（1条）'), '提示要说清剩几条：' + text.slice(0, 200))
  const labels = nodes.filter((n) => n.type === 'button')
    .map((b) => (b.props.children || []).filter((c) => typeof c === 'string').join(''))
  assert.ok(labels.some((l) => l.includes('异常')), '筛选标签要能单独清掉：' + labels.join('|'))
})

test('状态栏圆环单独挂载也要注入样式表（否则弹层是无样式裸文字）', () => {
  const src = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  const start = src.indexOf('function StatusOrbit')
  assert.ok(start > 0, '找不到 StatusOrbit')
  // 窗口按状态栏组件大小给：0.10.x 加了品牌状态与文案后 2500 字已经不够，
  // 断言本身不变（挂载副作用与弹层打开时都要调 ensurePortedCss）。
  const seg = src.slice(start, start + 3200)
  assert.ok(seg.includes('ensurePortedCss'), 'StatusOrbit 的挂载副作用里必须调 ensurePortedCss')
  assert.ok(seg.includes('ensurePortedCss(true)'), '弹层打开时要强制重建样式表（兜住建站后被清掉的情况）')
  assert.ok(!src.slice(src.indexOf('const act = async', start), src.indexOf('const act = async', start) + 500).includes('window.confirm'), '删除只走 ConfirmBtn 二段确认，不能再叠 window.confirm')
  // 更根本的一道：模块 apply() 里就要注入一次，任何槽位都能用上样式表
  const applyAt = src.indexOf('apply(ctx) {')
  assert.ok(applyAt > 0, '找不到 apply')
  assert.ok(src.slice(applyAt, applyAt + 600).includes('ensurePortedCss'), 'apply() 里必须有 ensurePortedCss')
})

test('弹层副行不出现「秒前前」这种重复后缀（真机看到过）', () => {
  const { registrations, render } = loadClient()
  const orbit = registrations.find((r) => r.opts.id === 'session-superagent-orbit')
  const list = [watcher('a/b', {
    id: 'a/b#s1', title: '修个 bug', intervalSec: 60,
    lastPoll: new Date(Date.now() - 76000).toISOString(), activeHours: '09:00-23:00',
  })]
  const nodes = walk(render(orbit, [list, null, true, { x: 700, y: 800 }]))
  const subs = nodes.filter((n) => n.props && n.props.className === 'sa-dock-sub').map((n) => (n.props.children || []).join(''))
  assert.equal(subs.length, 1)
  assert.ok(!subs[0].includes('前前'), '重复后缀：' + subs[0])
  assert.ok(subs[0].includes('76 秒前') || subs[0].includes('秒前'), '要有相对时间：' + subs[0])
})

test('首帧 304 不该把面板卡在「正在读取」：本地没有 body 时必须重取一次全量', async () => {
  // 真机现象：状态栏圆环每 5 秒全量拉一次 /state，会把模块级 etag 刷成最新；
  // 主理鱼面板首次挂载时正好带着这个 etag 去问 → 首帧 304。
  // 旧代码在 304 分支直接 return，从不 setSnap，于是面板永远停在
  // {loading:true, body:null}：统计条全 0、列表是空态、底下还挂着「正在读取…」。
  const stateBody = { routeBase: '/session-superagent', serverVersion: '0.9.167', watchers: [watcher('a/b'), watcher('c/d')] }
  const sessionId = 'session /?&=# 中文'
  const expectedStateUrl = '/session-superagent/state?sessionId=' + encodeURIComponent(sessionId)
  const calls = []
  const fakeFetch = (url, init) => {
    const headers = (init && init.headers) || {}
    const etag = headers['if-none-match'] || null
    calls.push({ url, etag })
    // 带条件头 → 服务端回 304（没有任何正文）
    if (etag) return Promise.resolve({ ok: false, status: 304, headers: { get: () => etag }, text: () => Promise.resolve('') })
    return Promise.resolve({ ok: true, status: 200, headers: { get: () => 'W/"v1"' }, text: () => Promise.resolve(JSON.stringify(stateBody)) })
  }
  // query 是契约的一部分：按 pathname 找调用，同时逐条断言完整 URL，不能用 endsWith 把 query 隐藏掉。
  const stateCalls = () => calls.filter((c) => new URL(c.url, 'http://fixture.local').pathname === '/session-superagent/state')
  const { registrations, render } = loadClient({ fetch: fakeFetch })
  const desk = registrations.find((r) => r.opts.id === 'session-superagent-desk')
  const findRefresh = (tree) => walk(tree).find((n) => n.props && typeof n.props.onClick === 'function'
    && walk(n).some((x) => x.type === '#text' && x.text === '刷新'))

  // 1) 状态栏圆环那种常规全量拉取：把模块级 etag 写上
  const first = findRefresh(render(desk, deskQueue({ loading: true, error: null, body: null }), { sessionId }))
  assert.ok(first, '面板上找不到「刷新」按钮')
  await first.props.onClick()
  assert.equal(stateCalls().length, 1, '首拉一次 /state')
  assert.equal(stateCalls()[0].url, expectedStateUrl, '主面板必须带编码后的当前 sessionId')
  assert.equal(stateCalls()[0].etag, null, '首次拉取不该带条件头')

  // 2) 面板重新挂载：本地还没有 body，却带着别人的 etag 去问 → 首帧 304
  const second = findRefresh(render(desk, deskQueue({ loading: true, error: null, body: null }), { sessionId }))
  const got = await second.props.onClick()

  assert.equal(stateCalls().length, 3, '304 之后必须重取一次全量，不能停在 loading')
  assert.equal(stateCalls()[1].etag, 'W/"v1"', '第二次是条件请求')
  assert.equal(stateCalls()[2].etag, null, '重取时不能沿用那个 etag')
  assert.deepEqual(stateCalls().map((call) => call.url), [expectedStateUrl, expectedStateUrl, expectedStateUrl],
    '条件请求与 304 重取都不能丢 sessionId')
  assert.ok(got && Array.isArray(got.watchers) && got.watchers.length === 2, 'load 要拿到能渲染的 body')
})

test('主面板 sessionId 为空或缺失时保持原 /state 请求，不追加空 query', async () => {
  for (const props of [{ sessionId: '' }, {}]) {
    const calls = []
    const { registrations, render } = loadClient({
      fetch: async (url) => {
        calls.push(url)
        return { ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify({ watchers: [] }) }
      },
    })
    const desk = registrations.find((r) => r.opts.id === 'session-superagent-desk')
    const tree = render(desk, deskQueue({ loading: true, error: null, body: null }), props)
    const refresh = walk(tree).find((n) => n.props && typeof n.props.onClick === 'function'
      && walk(n).some((x) => x.type === '#text' && x.text === '刷新'))
    assert.ok(refresh, '面板上找不到「刷新」按钮')
    await refresh.props.onClick()
    assert.deepEqual(calls.filter((url) => new URL(url, 'http://fixture.local').pathname === '/session-superagent/state'),
      ['/session-superagent/state'], '空 sessionId 不得变成 ?sessionId= 或 ?sessionId=undefined')
  }
})

test('保存编辑只发改过的字段（M2：全量 PUT 会把别处刚改的值写回旧快照）', async () => {
  const { readFileSync } = await import('node:fs')
  const src = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  // 逐字段编辑必须走 setField（它会记「改过哪些键」）
  assert.ok(src.includes('const setField = (next) => {'), '缺少 setField 包装')
  assert.ok(src.includes('touchedRef.current.add(key)'), 'setField 没有记录改过的键')
  // 保存时必须按 touchedRef 过滤，而不是整份发出去
  assert.ok(src.includes('for (const key of touchedRef.current)'), '保存没有按 touchedRef 过滤')
  assert.ok(!/body: JSON\.stringify\(\{\s*\r?\n\s*repo: watcher\.repo/.test(src), '保存体又变回全量 PUT 了')
})

test('行内编辑保存必须真的带上 filters / priority（T24 M1：控件名与字段名对不上，改了发不出去）', async () => {
  const { readFileSync } = await import('node:fs')
  const src = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  // 控件名 → 字段名的映射必须存在（否则 labels/onlyAssigned/priority* 永远发不出去）
  assert.ok(src.includes('CONTROL_TO_FIELD'), '缺少「控件名 → 字段名」映射')
  for (const control of ['labels:', 'onlyAssigned:', 'priorityReopened:', 'priorityStale:']) {
    assert.ok(src.includes(control), '映射里缺 ' + control)
  }
  assert.ok(src.includes('wanted.add(CONTROL_TO_FIELD[key] || key)'), '映射没被用上')
})

test('没有 setDeferFilter 这种未定义的 setter（T24 M2：点了直接 ReferenceError）', async () => {
  const { readFileSync } = await import('node:fs')
  const src = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  assert.ok(!src.includes('setDeferFilter('), '还残留 setDeferFilter —— 组件里没有这个 setter')
})

test('「看建议规则」这个 action 必须被渲染（T24 M4：没人消费 = 按钮永不出现）', async () => {
  const { readFileSync } = await import('node:fs')
  const src = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  assert.ok(src.includes('item.action ?'), 'item.action 没有被消费')
  assert.ok(src.includes('setGlossary('), '建议规则弹层的入口丢了')
})

test('脏数据（真 /state 的形状）渲染后不许出现 undefined / NaN / [object Object]（T26：桩比真 body 干净）', async () => {
  const { loadClient } = await import('./fixtures/panel-harness.mjs')
  const { dirtyWatcher, dirtyState } = await import('./fixtures/panel-harness.mjs')
  const { registrations, render } = loadClient()
  const desk = registrations.find((r) => r.opts.id === 'session-superagent-desk')
  const snap = dirtyState([
    dirtyWatcher('acme/dirty-one'),
    dirtyWatcher('acme/dirty-two', { enabled: false, lastError: 'HTTP 401: Bad credentials' }),
  ])
  const text = walk(render(desk, deskQueue(snap))).filter((n) => typeof n.text === 'string').map((n) => n.text).join(' | ')
  assert.ok(text.length > 0, '面板要有内容')
  for (const bad of ['undefined', 'NaN', '[object Object]']) {
    assert.ok(!text.includes(bad), '脏数据渲染出了「' + bad + '」：' + text.slice(0, 400))
  }
  // 真机上确有的几个值要真的显示出来（而不是因为取不到而静默省略）
  assert.ok(text.includes('acme/dirty-one'), '仓库名要显示')
  assert.ok(/不需要|没有 GitHub/.test(text) || text.includes('gh'), 'gh 三态要被正确处理')
})

test('两个会话守同一仓库时，「需要关注」不能出现两条一模一样的条目（T34：知识库那条规则从没落地）', async () => {
  const { loadClient, walk, deskQueue, watcher } = await import('./fixtures/panel-harness.mjs')
  const { registrations, render } = loadClient()
  const desk = registrations.find((r) => r.opts.id === 'session-superagent-desk')
  const snap = {
    loading: false, error: null,
    body: {
      credentials: { token: 'none', sshKeyPath: 'none', ghConfigDir: 'none', giteeToken: 'none' },
      gh: { ok: true, version: '2.0' },
      defaults: { sessionMaxWakes: 12, maxWakesPerHour: 6, isolateKeepDays: 3, batchLimit: 5 },
      watchers: [
        { ...watcher('a/b'), sessionId: 's1', repoAccess: { archived: true } },
        { ...watcher('a/b'), sessionId: 's2', repoAccess: { archived: true } },
      ],
    },
  }
  const text = walk(render(desk, deskQueue(snap)))
    .filter((n) => typeof n.text === 'string')
    .map((n) => n.text).join(' | ')
  // 「需要关注」里那条长句只该出现一次（行内的「已归档」徽章是另一回事，每条守各一个）
  const hits = (text.match(/已归档：GitHub 上归档仓库是只读的/g) || []).length
  assert.equal(hits, 1, '同一条问题只该出现一次，实际 ' + hits + ' 次')
})

test('设置页左栏点哪一项，右边就换哪一块（客户实拍：永远停在「来源」）', async () => {
  const { loadClient, walk, watcher, deskForm } = await import('./fixtures/panel-harness.mjs')
  const { registrations, render } = loadClient()
  const snap = {
    loading: false, error: null,
    body: {
      credentials: { token: 'none', sshKeyPath: 'none', ghConfigDir: 'none', giteeToken: 'none' },
      gh: { ok: true, version: '2.0' },
      defaults: { sessionMaxWakes: 12, maxWakesPerHour: 6, isolateKeepDays: 3, batchLimit: 5 },
      watchers: [watcher('a/b')],
    },
  }
  // 槽位：snapshot / tab / ... / settingsSection（第 15 个）
  const queue = (section) => [snap, 'settings', null, deskForm, '', '', false, [], null, {}, '', false, null, false, section, null, null, false, null, '', '']
  const bodyOf = (section) => {
    const desk = registrations.find((r) => r.opts.id === 'session-superagent-desk')
    const text = walk(render(desk, queue(section))).filter((n) => typeof n.text === 'string').map((n) => n.text).join(' | ')
    const at = text.indexOf('会话 goal |')   // 跳过多出来的导航按钮
    return at >= 0 ? text.slice(at + 10) : text
  }
  // 根因：React 会把 `key` 从 props 剥掉，靠 `props.key` 找子节点在真机上是 undefined。
  assert.match(bodyOf('source'), /^来源/, 'source 应显示来源')
  assert.match(bodyOf('creds'), /^凭证/, 'creds 应显示凭证（以前这里是来源）')
  assert.match(bodyOf('goal'), /^会话 goal|^目标/, 'goal 应显示会话 goal')
  assert.notEqual(bodyOf('creds').slice(0, 6), bodyOf('source').slice(0, 6), '两块内容不能一样')
})

test('设置页左栏点哪一项，就调用哪个 setter（T38：setter 以前是空函数，整条交互链零覆盖）', async () => {
  const { loadClient, walk, watcher, deskForm } = await import('./fixtures/panel-harness.mjs')
  const { registrations, render, stateCalls, resetStateCalls } = loadClient()
  const snap = {
    loading: false, error: null,
    body: {
      credentials: { token: 'none', sshKeyPath: 'none', ghConfigDir: 'none', giteeToken: 'none' },
      gh: { ok: true, version: '2.0' },
      defaults: { sessionMaxWakes: 12, maxWakesPerHour: 6, isolateKeepDays: 3, batchLimit: 5 },
      watchers: [watcher('a/b')],
    },
  }
  const queue = (section) => [snap, 'settings', null, deskForm, '', '', false, [], null, {}, '', false, null, false, section, null, null, false, null, '', '']
  const desk = registrations.find((r) => r.opts.id === 'session-superagent-desk')
  const tree = walk(render(desk, queue('source')))
  const navBtn = tree.filter((n) => n.type === 'button' && (n.props.children || []).join('') === '凭证')
  assert.equal(navBtn.length, 1, '设置页左栏要有「凭证」这一项')
  resetStateCalls()
  navBtn[0].props.onClick()
  const calls = stateCalls()
  assert.equal(calls.length, 1, '点一下应当触发一次 setter，实际 ' + calls.length)
  assert.equal(calls[0].next, 'creds', '应当写入 creds（分区 key），实际 ' + JSON.stringify(calls[0].next))
})

test('页签点哪一项就切到哪一项（T38 M6：把 onChange 改成空函数，82 条用例全绿）', async () => {
  const { loadClient, walk, watcher, deskQueue } = await import('./fixtures/panel-harness.mjs')
  const { registrations, render, stateCalls, resetStateCalls } = loadClient()
  const snap = {
    loading: false, error: null,
    body: {
      credentials: { token: 'none', sshKeyPath: 'none', ghConfigDir: 'none', giteeToken: 'none' },
      gh: { ok: true, version: '2.0' },
      defaults: { sessionMaxWakes: 12, maxWakesPerHour: 6, isolateKeepDays: 3, batchLimit: 5 },
      watchers: [watcher('a/b')],
    },
  }
  const desk = registrations.find((r) => r.opts.id === 'session-superagent-desk')
  const tree = walk(render(desk, deskQueue(snap, null, {}, 'overview')))
  const tab = tree.filter((n) => n.type === 'button' && (n.props.children || []).join('') === '判定')
  assert.equal(tab.length, 1, '要有「判定」页签')
  resetStateCalls()
  tab[0].props.onClick()
  const calls = stateCalls()
  assert.equal(calls.length, 1, '点页签应当触发一次 setter')
  assert.ok(['queue', 'judge', 'trace', 'trigger', 'settings'].includes(calls[0].next), '应当写入页签名，实际 ' + JSON.stringify(calls[0].next))
})

test('弹层按锚点定位，并在窗口边缘夹住（T38：这 5 个 if 从来没执行过，因为 anchor 恒为 null）', async () => {
  const { loadClient, walk, watcher } = await import('./fixtures/panel-harness.mjs')
  const { registrations, render, setViewport } = loadClient()
  const orbit = registrations.find((r) => r.opts.id === 'session-superagent-orbit')
  const list = [watcher('a/b')]
  const leftOf = (anchor, width) => {
    setViewport(width)
    const nodes = walk(render(orbit, [list, null, true, anchor]))
    const panel = nodes.find((n) => n.props && n.props.style && n.props.style.left !== undefined)
    return panel ? Number(panel.props.style.left) : NaN
  }
  const mid = leftOf({ x: 600, y: 500 }, 1200)
  assert.ok(Number.isFinite(mid) && mid > 0, '有锚点时要算出 left（不是默认的 8），实际 ' + mid)
  // 锚点贴右边：必须夹在视口内
  const right = leftOf({ x: 1195, y: 500 }, 1200)
  assert.ok(right + 240 <= 1200, '贴右边时不能溢出（left=' + right + '）')
  // 锚点贴左边：也不能溢出
  const leftEdge = leftOf({ x: 3, y: 500 }, 1200)
  assert.ok(leftEdge >= 8, '贴左边时 left 不能小于 8，实际 ' + leftEdge)
})

test('面板能设「只理这些人提的」，且不会把已有名单清空（T：官方 Policy 的最小版）', async () => {
  const { loadClient, walk, watcher } = await import('./fixtures/panel-harness.mjs')
  const { registrations, render } = loadClient()
  const desk = registrations.find((r) => r.opts.id === 'session-superagent-desk')
  const snap = {
    loading: false, error: null,
    body: {
      credentials: { token: 'none', sshKeyPath: 'none', ghConfigDir: 'none', giteeToken: 'none' },
      gh: { ok: true, version: '2.0' }, defaults: {},
      watchers: [watcher('a/b', { filters: { labels: ['bug'], onlyAssigned: false, allowAuthors: ['alice'] } })],
    },
  }
  const queue = (draft) => [snap, 'overview', null, draft, '', '', false, [], 'a/b#session-a/b', draft, '', false, null, false, 'source', null, null, false, null, '', '']
  // 打开编辑器时要把已有名单填进输入框（否则一保存就被清空 —— filters 是整块发出去的）
  const filled = { repo: '', intervalSec: '60', goal: '', labels: 'bug', onlyAssigned: false, activeHours: '', isolated: false, workdir: '', allowAuthors: 'alice' }
  const nodes = walk(render(desk, queue(filled)))
  const texts = nodes.filter((n) => typeof n.text === 'string').map((n) => n.text).join(' | ')
  assert.ok(texts.includes('只理这些人提的'), '表单要有这个字段')
  assert.ok(nodes.some((n) => n.type === 'input' && String(n.props.value) === 'alice'), '已有名单要显示在输入框里')
})

test('总览要显示「有动作率」（《为什么做这个产品》：没有这个数，「不打断」只是信念）', async () => {
  const { loadClient, walk, watcher, deskQueue } = await import('./fixtures/panel-harness.mjs')
  const { registrations, render } = loadClient()
  const desk = registrations.find((r) => r.opts.id === 'session-superagent-desk')
  const snap = {
    loading: false, error: null,
    body: {
      credentials: { token: 'none', sshKeyPath: 'none', ghConfigDir: 'none', giteeToken: 'none' },
      gh: { ok: true, version: '2.0' },
      defaults: { sessionMaxWakes: 12, maxWakesPerHour: 6, isolateKeepDays: 3, batchLimit: 5 },
      watchers: [watcher('a/b', { quality: { itemsWoken: 10, itemsAcked: 7, actionRate: 0.7 } })],
    },
  }
  const text = walk(render(desk, deskQueue(snap))).filter((n) => typeof n.text === 'string').map((n) => n.text).join(' | ')
  assert.match(text, /有动作/, '总览要有这个指标')
  assert.match(text, /7 \/ 10/, '要显示 ack 数 / 叫醒数：' + text.slice(0, 200))
})

test('新建表单能一次设好作者名单、会话上限与隔离保留策略（T40 W2）', async () => {
  const requests = []
  const { registrations, render } = loadClient({
    fetch: async (url, options = {}) => {
      requests.push({ url, options })
      return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, warnings: [] }) }
    },
  })
  const desk = registrations.find((r) => r.opts.id === 'session-superagent-desk')
  const snap = {
    loading: false, error: null,
    body: {
      credentials: { token: 'none', sshKeyPath: 'none', ghConfigDir: 'none', giteeToken: 'none' },
      gh: { ok: true, version: '2.0' },
      defaults: { sessionMaxWakes: 12, maxWakesPerHour: 6, isolateKeepDays: 3, batchLimit: 5 },
      watchers: [],
    },
  }
  const form = {
    repo: 'acme/demo', intervalSec: '60', goal: '', labels: 'bug', onlyAssigned: false,
    activeHours: '', isolated: true, workdir: '', observe: false,
    batchLimit: '3', maxWakesPerHour: '4', sessionMaxWakes: '8',
    allowAuthors: '@alice,bob', isolateKeepDays: '2', maxIsolated: '4',
  }
  const queue = deskQueue(snap, null, {}, 'trigger')
  queue[3] = form
  const nodes = walk(render(desk, queue, { sessionId: 's1' }))
  const labels = nodes.filter((n) => typeof n.text === 'string').map((n) => n.text).join(' | ')
  for (const title of ['只理这些人提的', '这条会话每小时最多被唤醒', '隔离区保留天数', '最多保留几个隔离区']) {
    assert.ok(labels.includes(title), '新建表单缺字段：' + title)
  }
  const add = nodes.find((n) => n.type === 'button' && String((n.props.children || []).join('')).includes('添加到当前会话'))
  assert.ok(add, '要有添加按钮')
  await add.props.onClick()
  const created = requests.find((r) => String(r.url).endsWith('/watch'))
  assert.ok(created, '点击后必须真的发 /watch')
  const body = JSON.parse(created.options.body)
  assert.deepEqual(body.filters.allowAuthors, ['alice', 'bob'], '@ 前缀要清掉，两个人都要保留')
  assert.equal(body.sessionMaxWakes, 8)
  assert.equal(body.isolateKeepDays, 2)
  assert.equal(body.maxIsolated, 4)
})

test('编辑过滤字段时，已有作者名单和指派人不能被顺带清空（T40 W3）', async () => {
  const requests = []
  const { registrations, render } = loadClient({
    fetch: async (url, options = {}) => {
      requests.push({ url, options })
      return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true }) }
    },
  })
  const desk = registrations.find((r) => r.opts.id === 'session-superagent-desk')
  const snap = {
    loading: false, error: null,
    body: {
      credentials: { token: 'none', sshKeyPath: 'none', ghConfigDir: 'none', giteeToken: 'none' },
      gh: { ok: true, version: '2.0' }, defaults: {},
      watchers: [watcher('a/b', {
        filters: { labels: ['bug'], ignoreLabels: ['old'], onlyAssigned: true, assignee: 'octocat', allowAuthors: ['alice'] },
      })],
    },
  }
  const draft = {
    intervalSec: '60', labels: 'bug', ignoreLabels: 'old', onlyAssigned: true,
    assignee: 'octocat', allowAuthors: 'alice', activeHours: '', goal: '', isolated: false, workdir: '',
  }
  const queue = deskQueue(snap, 'a/b#session-a/b', draft)
  const nodes = walk(render(desk, queue))
  const ignore = nodes.find((n) => n.type === 'input' && n.props.value === 'old')
  assert.ok(ignore, '已有排除标签要显示在输入框里')
  ignore.props.onChange({ target: { value: 'skip' } })
  const save = nodes.find((n) => n.type === 'button' && String((n.props.children || []).join('')) === '保存')
  assert.ok(save, '编辑器里要有保存按钮')
  await save.props.onClick()
  const saved = requests.find((r) => String(r.url).endsWith('/watch'))
  assert.ok(saved, '保存必须真的发请求')
  const body = JSON.parse(saved.options.body)
  assert.deepEqual(body.filters, {
    labels: ['bug'], ignoreLabels: ['old'], onlyAssigned: true,
    assignee: 'octocat', allowAuthors: ['alice'],
  }, '只要提交 filters，就必须保留其中所有已有值（测试桩不重渲染，所以不断言输入后的新值）')
})

test('列表显示作者白名单与 ack 标签，编辑器也能改标签（T40 W3/W4）', () => {
  const { registrations, render } = loadClient()
  const desk = registrations.find((r) => r.opts.id === 'session-superagent-desk')
  const snap = {
    loading: false, error: null,
    body: {
      credentials: { token: 'none', sshKeyPath: 'none', ghConfigDir: 'none', giteeToken: 'none' },
      gh: { ok: true, version: '2.0' }, defaults: {},
      watchers: [watcher('a/b', {
        ackLabel: 'team:done', queuedWakes: 2,
        filters: { labels: [], ignoreLabels: [], onlyAssigned: false, allowAuthors: ['alice', 'bob'] },
      })],
    },
  }
  const textOf = (nodes) => nodes.filter((n) => typeof n.text === 'string').map((n) => n.text).join(' | ')
  const overview = textOf(walk(render(desk, deskQueue(snap))))
  assert.match(overview, /作者: alice,bob/, '列表必须显示作者白名单，否则设了也看不出来')
  assert.match(overview, /回执 team:done/, '列表必须显示实际 ack 标签')
  assert.match(overview, /排队 2/, '会话忙时排了几条必须可见，不能只在内部 Map 里')

  const draft = {
    intervalSec: '60', labels: '', ignoreLabels: '', onlyAssigned: false,
    assignee: '', allowAuthors: 'alice,bob', ackLabel: 'team:done', activeHours: '', goal: '', isolated: false, workdir: '',
  }
  const editor = walk(render(desk, deskQueue(snap, 'a/b#session-a/b', draft)))
  assert.ok(textOf(editor).includes('已处理标签'), '编辑器要有 ack 标签字段')
  assert.ok(editor.some((n) => n.type === 'input' && n.props.value === 'team:done'), '编辑器要显示当前自定义标签')
})

test('追溯结果进入判定页内联时间线，不再只发一条 Toast（官方 Thread 详情最小吸收）', async () => {
  const payload = {
    ok: true,
    text: '#42 @ a/b：被过滤',
    traces: [{
      number: '42', repo: 'a/b', verdict: '被过滤',
      seen: '2026-11-05T10:00:00Z', reported: null,
      filtered: [{ at: '2026-11-05T10:01:00Z', reason: '机器人' }],
      absorbed: [{ at: '2026-11-05T10:02:00Z' }],
      wakes: [{ at: '2026-11-05T10:03:00Z', ok: true }],
    }],
  }
  const { registrations, render, stateCalls } = loadClient({
    fetch: async () => ({ ok: true, status: 200, text: async () => JSON.stringify(payload) }),
  })
  const desk = registrations.find((r) => r.opts.id === 'session-superagent-desk')
  const snap = {
    loading: false, error: null,
    body: {
      credentials: { token: 'none', sshKeyPath: 'none', ghConfigDir: 'none', giteeToken: 'none' },
      gh: { ok: true, version: '2.0' }, defaults: {}, watchers: [watcher('a/b')],
    },
  }
  const queue = deskQueue(snap, null, {}, 'judge', '42')
  const nodes = walk(render(desk, queue))
  const button = nodes.find((n) => n.type === 'button' && String((n.props.children || []).join('')).includes('追溯 #42'))
  assert.ok(button, '搜索编号后要有追溯按钮')
  await button.props.onClick()
  assert.ok(stateCalls().some((call) => call.next && Array.isArray(call.next.traces)), '点击后必须把结构化 payload 写入状态')

  queue[queue.length - 2] = payload
  const traced = walk(render(desk, queue))
  const text = traced.filter((n) => typeof n.text === 'string').map((n) => n.text).join(' | ')
  assert.equal(traced.filter((n) => n.type === 'li' && n.props.className === 'dt-event').length, 5, '1 个标题 + 4 个事件，每个都必须是独立 li.dt-event')
  assert.equal(traced.filter((n) => n.props && n.props.className === 'dt-event-text').length, 4, '事件正文使用官方 dt-event-text')
  for (const expected of ['#42 @ a/b：被过滤', '被过滤：机器人', '被冷却期吸收', '唤醒成功']) {
    assert.ok(text.includes(expected), '内联时间线缺：' + expected)
  }
})

test('通用图标直接复用 DSH 官方 16×16 path，derived 图标仍保持 24×24', () => {
  const { registrations, render } = loadClient()
  const desk = registrations.find((r) => r.opts.id === 'session-superagent-desk')
  const snap = {
    loading: false, error: null,
    body: { credentials: {}, gh: { ok: true }, defaults: {}, watchers: [watcher('a/b')] },
  }
  const emptySnap = { ...snap, body: { ...snap.body, watchers: [] } }
  const emptyNodes = walk(render(desk, deskQueue(emptySnap)))
  assert.ok(emptyNodes.some((n) => n.type === 'path' && n.props.d === 'M8 2V14'), '加号必须使用官方 composer/plus-medium path')
  assert.ok(emptyNodes.some((n) => n.type === 'path' && n.props.d === 'M2 8H14'), '官方加号的第二条 path 也不能丢')
  assert.ok(emptyNodes.some((n) => n.type === 'svg' && n.props.viewBox === '0 0 16 16'), '官方素材必须用 16×16 viewBox')
  const nodes = walk(render(desk, deskQueue(snap)))
  assert.ok(nodes.some((n) => n.type === 'svg' && n.props.viewBox === '0 0 24 24'), '官方没有的 derived 图标仍用 24×24，不能混坐标系')
})

test('升级横幅直达「版本与更新」分区，不只切到设置页（官方 settingsRoute 最小等价）', async () => {
  const { registrations, render, stateCalls } = loadClient()
  const desk = registrations.find((r) => r.opts.id === 'session-superagent-desk')
  const snap = { loading: false, error: null, body: { credentials: {}, gh: { ok: true }, defaults: {}, watchers: [watcher('a/b')] } }
  const queue = deskQueue(snap, null, {}, 'overview', '', false, { current: '1.0.0', latest: '1.0.1', hasUpdate: true, command: 'dsh plugin update' })
  const nodes = walk(render(desk, queue))
  const button = nodes.find((n) => n.type === 'button' && String((n.props.children || []).join('')).includes('去更新'))
  assert.ok(button, '有更新时必须出现升级入口')
  await button.props.onClick()
  assert.ok(stateCalls().some((call) => call.next === 'update'), '必须定位 settingsSection=update')
  assert.ok(stateCalls().some((call) => call.next === 'settings'), '同时切到设置页')
})

test('更新检查失败显示「检查失败」，不能误报「已是最新」', () => {
  const { registrations, render } = loadClient()
  const desk = registrations.find((r) => r.opts.id === 'session-superagent-desk')
  const snap = { loading: false, error: null, body: { credentials: {}, gh: { ok: true }, defaults: {}, watchers: [watcher('a/b')] } }
  const queue = deskQueue(snap, null, {}, 'settings', '', false, { current: '1.0.0', latest: null, hasUpdate: false, error: 'network down' })
  queue[14] = 'update'
  const text = walk(render(desk, queue)).filter((n) => n.type === '#text').map((n) => n.text).join(' | ')
  assert.ok(text.includes('检查失败'), text)
  assert.ok(!text.includes('已是最新'), '失败不能显示成最新：' + text)
})

test('Orbit 首次 loading/error 不显示零统计或空态，旧列表失败仍保留并提示', () => {
  const { registrations, render } = loadClient()
  const orbit = registrations.find((r) => r.opts.id === 'session-superagent-orbit')
  const anchor = { x: 720, y: 860 }
  const textOf = (queue) => walk(render(orbit, queue)).filter((n) => n.type === '#text').map((n) => n.text).join(' | ')

  const loading = textOf([null, null, true, anchor])
  assert.ok(loading.includes('正在读取…'), '首次读取要显示加载状态：' + loading)
  assert.ok(!loading.includes('0 / 0'), '未知状态不能显示零统计：' + loading)
  assert.ok(!loading.includes('还没有。在「主理鱼」标签页'), '未知状态不能显示空列表指引：' + loading)

  const failed = textOf([null, '读取失败：offline', true, anchor])
  assert.ok(failed.includes('读取失败：offline'), '首次失败要显示真实错误：' + failed)
  assert.ok(!failed.includes('0 / 0'), '首次失败不能显示零统计：' + failed)
  assert.ok(!failed.includes('还没有。在「主理鱼」标签页'), '首次失败不能伪装成空态：' + failed)

  const stale = textOf([[watcher('a/b')], '读取失败：offline', true, anchor])
  assert.ok(stale.includes('a/b'), '刷新失败必须保留旧 watcher：' + stale)
  assert.ok(stale.includes('读取失败：offline'), '旧 watcher 旁必须显示刷新错误：' + stale)
  assert.ok(!stale.includes('操作失败：读取失败'), '读取失败不能误标成写操作失败：' + stale)

  const empty = textOf([[], null, true, anchor])
  assert.ok(empty.includes('0 / 0') && empty.includes('还没有。在「主理鱼」标签页'), '成功返回真空才显示零统计与空态')
})

test('N2：上一次删除失败不得残留到下一次删除确认框，本次失败仍在框内可见', async () => {
  // 终审 N2：A 删除失败 → 取消 → 点 B 的「删除」，新确认框一打开就带着「删除失败：A …」，
  // 而 B 还没发任何请求。修法是「打开删除确认时清掉删除失败（保留读取错误）」。
  const writes = []
  const { registrations, render, stateCalls } = loadClient({
    fetch: async (url, init) => {
      if (init && init.method === 'POST') {
        writes.push(JSON.parse(init.body))
        return writes.length === 1
          ? { ok: false, status: 500, headers: { get: () => null }, text: async () => JSON.stringify({ error: 'A denied' }) }
          : { ok: true, status: 200, headers: { get: () => null }, text: async () => '{"ok":true}' }
      }
      return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        text: async () => JSON.stringify({ watchers: [watcher('a/b', { id: 'a/b#s1' }), watcher('c/d', { id: 'c/d#s2' })] }),
      }
    },
  })
  const orbit = registrations.find((r) => r.opts.id === 'session-superagent-orbit')
  const list = [watcher('a/b', { id: 'a/b#s1' }), watcher('c/d', { id: 'c/d#s2' })]
  const labelOf = (node) => walk(node).filter((n) => n.type === '#text').map((n) => n.text).join('')
  // 子树的文本（walk 只展开一层数组，弹层内部要重新走一遍）
  const textOf = (node) => labelOf(node)
  const modalText = (nodes) => modals(nodes).map(labelOf).join(' | ')
  const modals = (nodes) => nodes.filter((n) => n.type === 'div'
    && String(n.props.className || '').split(/\s+/).includes('dt-modal'))
  const buttons = (nodes, text) => nodes.filter((n) => n.type === 'button' && labelOf(n) === text)
  const take = (from) => stateCalls().slice(from)
  const applyCallsTo = (base, calls) => {
    const next = [...base]
    for (const call of calls) next[call.index] = call.next
    return next
  }

  let queue = [list, null, true, { x: 700, y: 800 }]
  let nodes = walk(render(orbit, queue))
  assert.equal(buttons(nodes, '删除').length, 2, '两条守各一个删除按钮')

  // 1) A 删除失败：错误必须留在当前确认框里（本次失败可见）
  let mark = stateCalls().length
  buttons(nodes, '删除')[0].props.onClick()
  queue = applyCallsTo(queue, take(mark))
  let opened = walk(render(orbit, queue))
  assert.equal(modals(opened).length, 1, '点删除必须打开确认框')
  mark = stateCalls().length
  await buttons(opened, '确认删除')[0].props.onClick()
  queue = applyCallsTo(queue, take(mark))
  nodes = walk(render(orbit, queue))
  assert.equal(modals(nodes).length, 1, '删除失败后确认框必须保留供重试')
  assert.ok(modalText(nodes).includes('删除失败：A denied'), '本次失败必须在框内可见：' + modalText(nodes))

  // 2) 取消后用 B 的删除重开：旧失败必须先被清掉
  mark = stateCalls().length
  buttons(nodes, '取消')[0].props.onClick()
  queue = applyCallsTo(queue, take(mark))
  assert.equal(modals(walk(render(orbit, queue))).length, 0, '取消必须关闭确认框')
  assert.equal(queue[1], '删除失败：A denied', '前置条件：旧错误还在状态里，才测得出打开时有没有清')

  mark = stateCalls().length
  buttons(walk(render(orbit, queue)), '删除')[1].props.onClick()
  const opening = take(mark)
  assert.ok(opening.some((call) => call.index === 1 && call.next === null),
    '打开删除确认时必须清掉上一次的删除失败：' + JSON.stringify(opening))
  queue = applyCallsTo(queue, opening)
  nodes = walk(render(orbit, queue))
  assert.equal(modals(nodes).length, 1, 'B 的确认框必须打开')
  assert.ok(!modalText(nodes).includes('删除失败'), 'B 还没发请求，不得显示 A 的删除失败：' + modalText(nodes))

  // 3) B 删除成功：错误与确认框一起消失
  mark = stateCalls().length
  assert.equal(await buttons(nodes, '确认删除')[0].props.onClick(), true, 'B 删除成功必须返回 true')
  queue = applyCallsTo(queue, take(mark))
  nodes = walk(render(orbit, queue))
  assert.equal(modals(nodes).length, 0, '成功后确认框关闭')
  assert.equal(queue[1], null, '成功后不得残留删除失败')
  assert.deepEqual(writes.map((write) => write.action), ['delete', 'delete'])
})

test('首次 loading/error 不渲染零统计、Onboarding 或业务页；旧快照失败仍保留', () => {
  const { registrations, render } = loadClient()
  const desk = registrations.find((r) => r.opts.id === 'session-superagent-desk')
  const scenarios = [
    { snap: { loading: true, error: null, body: null }, expected: '正在读取…' },
    { snap: { loading: false, error: 'Failed to fetch', body: null }, expected: '读不到面板数据' },
  ]
  for (const { snap, expected } of scenarios) {
    const nodes = walk(render(desk, deskQueue(snap)))
    const text = nodes.filter((n) => n.type === '#text').map((n) => n.text).join(' | ')
    assert.ok(text.includes(expected), '缺状态文案：' + expected)
    assert.ok(!text.includes('三步让这个会话开始盯办'), '首次未成功不能显示 Onboarding：' + text)
    assert.ok(!text.includes('条主理鱼'), '首次未成功不能显示零统计：' + text)
    if (snap.error) {
      assert.ok(nodes.some((node) => node.props && node.props.role === 'alert' && a11yText(node).includes('连不上宿主')), '无 body 首败也必须有 alert')
    } else {
      assert.equal(nodes.filter((node) => node.props && node.props.role === 'alert').length, 0, '加载中不得预播错误')
    }
    assert.equal(nodes.filter((n) => n.props && n.props.role === 'tabpanel').length, 0, '没有 body 时不应渲染业务页')
    assert.equal(nodes.filter((n) => n.props && String(n.props.className || '').includes('dt-stats')).length, 0, '没有 body 时不应渲染统计条')
  }

  const stale = {
    loading: false, error: 'Failed to fetch',
    body: { sessionGoal: null, sessionTitle: '旧快照', credentials: {}, watchers: [watcher('a/b')] },
  }
  const nodes = walk(render(desk, deskQueue(stale)))
  const text = nodes.filter((n) => n.type === '#text').map((n) => n.text).join(' | ')
  assert.ok(text.includes('读不到面板数据'), '旧快照也要显示刷新失败')
  assert.ok(text.includes('a/b') && text.includes('条主理鱼'), '刷新失败不能清掉旧数据：' + text)
  assert.ok(!text.includes('三步让这个会话开始盯办'), '有旧 watcher 时不能显示空态')
})

// 竞态回归需要跨 render 保留 useRef；通用 panel-harness 每次 render 都新建 ref，
// 只适合静态/单次点击断言。这里仍执行完整真实 client.js，只让 state/ref 按 React 语义持久。
function loadStatefulPanel({ fetch, queue }) {
  const states = [...queue]
  const refs = []
  let stateCursor = 0
  let refCursor = 0
  let mod = null
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
    fetch,
    setInterval: () => 0,
    clearInterval() {},
    setTimeout: () => 1,
    clearTimeout() {},
    queueMicrotask,
    console,
  }
  vm.createContext(sandbox)
  vm.runInContext(readFileSync(new URL('../client.js', import.meta.url), 'utf8'), sandbox)
  assert.ok(mod, '持久 ref 测试也必须执行真实 client.js')

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
    memo: (fn) => fn,
    useState(initial) {
      const index = stateCursor++
      if (index >= states.length) states[index] = typeof initial === 'function' ? initial() : initial
      return [states[index], (next) => {
        states[index] = typeof next === 'function' ? next(states[index]) : next
      }]
    },
    useEffect() {},
    useCallback: (fn) => fn,
    useRef(initial) {
      const index = refCursor++
      if (!refs[index]) refs[index] = { current: initial }
      return refs[index]
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
  const desk = registrations.find((item) => item.opts.id === 'session-superagent-desk')
  assert.ok(desk, '找不到主面板注册')
  const traceIndex = deskQueue({ loading: true, error: null, body: null }).length - 2
  const render = () => {
    stateCursor = 0
    refCursor = 0
    return desk.Component({ sessionId: 'session-race' })
  }
  const nodes = () => walk(render())
  const textOf = (node) => walk(node).filter((item) => item.type === '#text').map((item) => item.text).join('')
  const button = (label) => {
    const found = nodes().find((node) => node.type === 'button' && textOf(node).includes(label))
    assert.ok(found, '找不到按钮：' + label)
    return found
  }
  return {
    nodes,
    button,
    snap: () => states[0],
    trace: () => states[traceIndex],
    search(value) {
      const input = nodes().find((node) => node.type === 'input' && node.props['aria-label'] === '搜索')
      assert.ok(input, '找不到搜索框')
      input.props.onChange({ target: { value } })
    },
  }
}

function raceResponse(body, status = 200, etag = null) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => String(name).toLowerCase() === 'etag' ? etag : null },
    text: async () => status === 304 ? '' : JSON.stringify(body),
  }
}

function raceDeferred() {
  let resolve
  let reject
  const promise = new Promise((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

function raceSnapshot() {
  return {
    loading: false,
    error: null,
    body: {
      sessionGoal: null,
      sessionTitle: '竞态回归',
      credentials: { token: 'none', sshKeyPath: 'none', ghConfigDir: 'none', giteeToken: 'none' },
      gh: { ok: true, version: '2.0' },
      defaults: {},
      watchers: [watcher('a/b')],
    },
  }
}

test('trace A 慢 B 快：新编号立即 loading，慢旧结果不得回盖新编号', async () => {
  const slowA = raceDeferred()
  const fastB = raceDeferred()
  const requests = []
  const panel = loadStatefulPanel({
    queue: deskQueue(raceSnapshot(), null, {}, 'judge', '1'),
    fetch: (url) => {
      const parsed = new URL(url, 'http://fixture.local')
      if (!parsed.pathname.endsWith('/trace')) return Promise.resolve(raceResponse({ ok: true }))
      const number = parsed.searchParams.get('number')
      requests.push(number)
      return number === '1' ? slowA.promise : fastB.promise
    },
  })

  const first = panel.button('追溯 #1').props.onClick()
  assert.equal(panel.trace().loading, true)
  assert.equal(panel.trace().number, '1')
  panel.search('2')
  const second = panel.button('追溯 #2').props.onClick()
  assert.equal(panel.trace().loading, true, '新编号必须立即作废旧结果并进入自己的 loading')
  assert.equal(panel.trace().number, '2')

  const payloadB = { text: '#2 新结果', traces: [{ number: '2', repo: 'a/b', verdict: '新结果' }] }
  fastB.resolve(raceResponse(payloadB))
  await second
  assert.equal(panel.trace().text, '#2 新结果')
  assert.equal(panel.trace().loading, undefined)

  slowA.resolve(raceResponse({ text: '#1 旧结果', traces: [{ number: '1', repo: 'a/b', verdict: '旧结果' }] }))
  await first
  assert.deepEqual(requests, ['1', '2'])
  assert.equal(panel.trace().text, '#2 新结果', 'A 后到也不能把 B 的结果改回 #1')
  assert.equal(panel.trace().traces[0].number, '2')
})

test('trace 错误后可重试；较慢的旧错误不得覆盖重试成功', async () => {
  const staleRetry = raceDeferred()
  const latestRetry = raceDeferred()
  let attempt = 0
  const panel = loadStatefulPanel({
    queue: deskQueue(raceSnapshot(), null, {}, 'judge', '9'),
    fetch: (url) => {
      if (!new URL(url, 'http://fixture.local').pathname.endsWith('/trace')) return Promise.resolve(raceResponse({ ok: true }))
      attempt += 1
      if (attempt === 1) return Promise.resolve(raceResponse({ error: 'first failed' }, 500))
      return attempt === 2 ? staleRetry.promise : latestRetry.promise
    },
  })

  const button = panel.button('追溯 #9')
  await button.props.onClick()
  assert.equal(panel.trace().error, 'first failed')
  assert.equal(panel.trace().number, '9')
  assert.ok(panel.nodes().some((node) => node.props && node.props.role === 'alert' && a11yText(node).includes('first failed')),
    'trace 首败必须插入 alert')

  const stale = button.props.onClick()
  assert.equal(panel.trace().loading, true, '失败后的重试要清掉旧错误并显示 loading')
  const latest = button.props.onClick()
  latestRetry.resolve(raceResponse({ text: '#9 重试成功', traces: [{ number: '9', repo: 'a/b', verdict: '成功' }] }))
  await latest
  assert.equal(panel.trace().text, '#9 重试成功')

  staleRetry.resolve(raceResponse({ error: 'stale failed' }, 500))
  await stale
  assert.equal(panel.trace().text, '#9 重试成功', '旧错误不能回盖最新成功')
  assert.equal(panel.trace().error, undefined)
  assert.equal(panel.nodes().filter((node) => node.props && node.props.role === 'alert' && /first failed|stale failed/.test(a11yText(node))).length, 0,
    'trace 恢复后必须移除旧 alert')
})

test('/state 200→500→304：已有快照的最新 304 是成功，必须清掉旧读取错误', async () => {
  const requests = []
  let attempt = 0
  const panel = loadStatefulPanel({
    queue: deskQueue({ loading: true, error: null, body: null }),
    fetch: (url, init) => {
      if (!new URL(url, 'http://fixture.local').pathname.endsWith('/state')) return Promise.resolve(raceResponse({ ok: true }))
      attempt += 1
      requests.push({ url, etag: init?.headers?.['if-none-match'] || null })
      if (attempt === 1) return Promise.resolve(raceResponse({ watchers: [watcher('new/state')], marker: 'fresh' }, 200, 'W/"v1"'))
      if (attempt === 2) return Promise.resolve(raceResponse({ error: 'temporary failure' }, 500))
      return Promise.resolve(raceResponse(null, 304, 'W/"v1"'))
    },
  })

  const refresh = panel.button('刷新')
  await refresh.props.onClick()
  assert.equal(panel.snap().body.marker, 'fresh')
  assert.equal(panel.snap().error, null)

  await refresh.props.onClick()
  assert.equal(panel.snap().body.marker, 'fresh', '500 要保留已渲染快照')
  assert.equal(panel.snap().error, 'temporary failure')
  assert.ok(panel.nodes().some((node) => node.props && node.props.role === 'alert' && a11yText(node).includes('temporary failure')),
    'stale+500 必须有独立 alert')

  // 重新 render 让 hasBodyRef 看见 200 留下的快照；第三次命中的是 304 早退分支。
  const retry = panel.button('重试')
  await retry.props.onClick()
  assert.equal(panel.snap().body.marker, 'fresh')
  assert.equal(panel.snap().error, null, '有快照的 304 是最新成功回读，不能留下 500 的旧错误')
  assert.equal(panel.snap().loading, false)
  assert.equal(panel.nodes().filter((node) => node.props && node.props.role === 'alert' && a11yText(node).includes('temporary failure')).length, 0,
    '304 恢复后必须移除读取 alert')
  assert.deepEqual(requests.map((request) => request.etag), [null, 'W/"v1"', 'W/"v1"'])
})

test('/state 并发：旧失败不得覆盖较新的 200 成功与清错结果', async () => {
  const older = raceDeferred()
  const newer = raceDeferred()
  const initial = raceSnapshot()
  initial.error = 'previous failure'
  const panel = loadStatefulPanel({
    queue: deskQueue(initial),
    fetch: (url) => new URL(url, 'http://fixture.local').pathname.endsWith('/state')
      ? panelRequests.shift().promise
      : Promise.resolve(raceResponse({ ok: true })),
  })
  const panelRequests = [older, newer]
  const refresh = panel.button('刷新')
  const oldRequest = refresh.props.onClick()
  const newRequest = refresh.props.onClick()

  newer.resolve(raceResponse({ watchers: [watcher('new/state')], marker: 'newest' }))
  await newRequest
  assert.equal(panel.snap().body.marker, 'newest')
  assert.equal(panel.snap().error, null, '最新 200 必须清掉进入请求前的旧错误')

  older.resolve(raceResponse({ error: 'stale failure' }, 500))
  await oldRequest
  assert.equal(panel.snap().body.marker, 'newest')
  assert.equal(panel.snap().error, null, '旧失败不能重新写回错误')
})

test('N1：保存回读被刷新的新请求顶掉时等最新快照，不得假报回读失败', async () => {
  // 终审 N1 的真实时序：POST 已成功 → run() 发起回读 GET#1 → 用户点「刷新」→ GET#2（新序号）
  // → GET#1 先回、被 loadSeqRef 判为旧请求丢弃 → run() 拿到 null，误报「回读失败，请重试」。
  // 正确语义：被顶掉不是失败，等最新那次的结果；POST200+GET500 仍必须报错（见后面的用例）。
  for (const scenario of [
    { label: '保存 goal', success: 'goal 已保存', section: 'goal', setup: (queue) => { queue[5] = '新 goal'; queue[6] = true } },
    { label: '保存凭证', success: '凭证已保存', section: 'creds', setup: (queue) => { queue[4] = 'github-secret' } },
  ]) {
    const post = raceDeferred()
    const reads = []
    const queue = deskQueue(raceSnapshot(), null, {}, 'settings')
    queue[14] = scenario.section
    scenario.setup(queue)
    const panel = loadStatefulPanel({
      queue,
      fetch: (url, init) => {
        if (init && init.method === 'POST') return post.promise
        if (!new URL(url, 'http://fixture.local').pathname.endsWith('/state')) return Promise.resolve(raceResponse({ ok: true }))
        // 只把前两次读取卡住；修复前会多打一次（失败分支的回读），给它一个立即结果，让用例干净失败
        if (reads.length >= 2) return Promise.resolve(raceResponse({ watchers: [watcher('a/b')] }))
        const read = raceDeferred()
        reads.push(read)
        return read.promise
      },
    })

    const saved = panel.button(scenario.label).props.onClick()
    assert.equal(reads.length, 0, scenario.label + '：POST 未返回前不该回读')
    post.resolve(raceResponse({ ok: true }))
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(reads.length, 1, scenario.label + '：POST 成功后必须回读一次')

    const refreshed = panel.button('刷新').props.onClick()
    assert.equal(reads.length, 2, scenario.label + '：保存回读与刷新必须并发')

    // 保存那次（旧序号）先回：数据其实已经成功，但落进「被顶掉」的那一支
    reads[0].resolve(raceResponse({ watchers: [watcher('a/b')] }))
    await new Promise((resolve) => setImmediate(resolve))
    // 最新那次（刷新）后回：保存必须等它，并按成功处理
    reads[1].resolve(raceResponse({ watchers: [watcher('a/b')] }))
    assert.equal(await saved, true, scenario.label + '：被顶掉不是失败，保存必须成功返回')
    await refreshed

    const text = panel.nodes().filter((node) => node.type === '#text').map((node) => node.text).join(' | ')
    assert.ok(text.includes(scenario.success), scenario.label + '：必须 Toast 成功：' + text.slice(0, 300))
    assert.ok(!text.includes('回读失败'), scenario.label + '：不得出现红色回读失败提示：' + text.slice(0, 300))
  }
})

test('N3：条件请求的 ETag 按作用域分开，圆环的 /state 不得串给会话面板，两个会话互不复用', async () => {
  // 终审 N3：模块级 stateEtag 被 Orbit（全局 /state）与主面板（/state?sessionId=…）共用，
  // 服务端 etag 按整份 body 求值，两个作用域必然对不上 → 面板的条件请求永远打不中 304。
  const etags = {
    '/session-superagent/state': 'W/"global-1"',
    '/session-superagent/state?sessionId=s1': 'W/"s1-1"',
    '/session-superagent/state?sessionId=s2': 'W/"s2-1"',
  }
  const calls = []
  const client = loadClient({
    fetch: async (url, init) => {
      const parsed = new URL(url, 'http://fixture.local')
      // 客户端还会写 client-note 探针（与 etag 无关），别混进作用域断言
      if (!parsed.pathname.endsWith('/state')) {
        return { ok: true, status: 200, headers: { get: () => null }, text: async () => '{}' }
      }
      const scope = parsed.pathname + parsed.search
      const etag = (init && init.headers && init.headers['if-none-match']) || null
      calls.push({ scope, etag })
      const current = etags[scope]
      assert.ok(current, '意外的 /state 作用域：' + scope)
      if (etag && etag === current) {
        return { ok: false, status: 304, headers: { get: () => current }, text: async () => '' }
      }
      return { ok: true, status: 200, headers: { get: () => current }, text: async () => JSON.stringify({ watchers: [] }) }
    },
  })
  const desk = client.registrations.find((r) => r.opts.id === 'session-superagent-desk')
  const snapshot = { loading: false, error: null, body: { sessionGoal: null, sessionTitle: 'x', credentials: {}, watchers: [] } }
  const refreshOf = (props) => {
    const nodes = walk(client.render(desk, deskQueue(snapshot), props))
    const found = nodes.find((node) => node.props && typeof node.props.onClick === 'function'
      && walk(node).some((child) => child.type === '#text' && child.text === '刷新'))
    assert.ok(found, '面板上找不到刷新按钮')
    return found.props.onClick
  }

  // 1) 圆环作用域（无 sessionId）：老行为保留 —— 自己的 etag 能命中 304
  await refreshOf({})()
  assert.equal(calls.at(-1).etag, null, '首次拉取不带条件头')
  const globalRetry = await refreshOf({})()
  assert.equal(calls.at(-1).etag, 'W/"global-1"', '无 sessionId 的老行为：同一作用域复用自己的 etag')
  assert.equal(Boolean(globalRetry && globalRetry.notModified), true, '同作用域第二次必须命中 304')

  // 2) 会话面板：不得沿用圆环的 etag（沿用就永远打不中 304）
  await refreshOf({ sessionId: 's1' })()
  assert.equal(calls.at(-1).etag, null, '会话面板不得携带圆环作用域的 etag')

  // 3) 同一会话第二次：用自己的 etag → 304，且不产生新 body
  client.resetStateCalls()
  const s1Retry = await refreshOf({ sessionId: 's1' })()
  assert.equal(calls.at(-1).etag, 'W/"s1-1"', '同一会话必须复用自己的 etag')
  assert.equal(Boolean(s1Retry && s1Retry.notModified), true, '同一会话第二次必须命中 304')
  const snapCalls = client.stateCalls().filter((call) => call.index === 0)
  assert.ok(snapCalls.length === 0 || snapCalls.every((call) => call.next === snapshot),
    '304 不得产生新的 body：' + JSON.stringify(snapCalls))

  // 4) 另一个会话：不得复用 s1 的 etag
  await refreshOf({ sessionId: 's2' })()
  assert.equal(calls.at(-1).etag, null, '两个会话不得复用同一个 etag')

  // 5) 圆环作用域不受会话面板影响
  const globalAgain = await refreshOf({})()
  assert.equal(calls.at(-1).etag, 'W/"global-1"')
  assert.equal(Boolean(globalAgain && globalAgain.notModified), true)

  assert.deepEqual(calls.map((call) => call.scope), [
    '/session-superagent/state',
    '/session-superagent/state',
    '/session-superagent/state?sessionId=s1',
    '/session-superagent/state?sessionId=s1',
    '/session-superagent/state?sessionId=s2',
    '/session-superagent/state',
  ], '每次请求都必须落在自己的作用域上')
})

test('W2：仅重新打开与重新打开加报错都计入问题数和问题筛选，健康守仍排除', () => {
  const { registrations, render } = loadClient()
  const desk = registrations.find((r) => r.opts.id === 'session-superagent-desk')
  const snap = {
    loading: false, error: null,
    body: {
      sessionGoal: null, sessionTitle: 'x', credentials: { token: 'configured', sshKeyPath: 'none' },
      watchers: [
        watcher('a/reopened', { id: 'a/reopened#s1', sessionId: 's1', lastReopened: 42 }),
        watcher('b/both', { id: 'b/both#s2', sessionId: 's2', lastReopened: 7, lastError: 'boom' }),
        watcher('c/healthy', { id: 'c/healthy#s3', sessionId: 's3' }),
      ],
    },
  }
  const textOf = (nodes) => nodes.filter((n) => n.type === '#text').map((n) => n.text).join(' | ')
  const allText = textOf(walk(render(desk, deskQueue(snap))))
  assert.ok(allText.includes('共 3 条问题，涉及 2 条守'), '问题构造与涉及守数必须同口径：' + allText.slice(0, 500))
  assert.ok(allText.includes('只看有问题的 (2)'), '问题筛选计数必须包含仅 reopened 的守')
  assert.ok(allText.includes('a/reopened #42 被重新打开过'), 'reopened 仍要在问题区展示')

  const queue = deskQueue(snap)
  queue[17] = true
  const nodes = walk(render(desk, queue))
  const rows = nodes.filter((n) => n.type === 'button' && String(n.props.className || '').includes('dt-open'))
    .map((n) => String(n.props.children)).sort()
  assert.deepEqual(rows, ['a/reopened', 'b/both'], '问题筛选必须留下仅 reopened 与 reopened+error，去掉健康守')
})

test('W5：运行时事件跨守按时间倒序，只渲染全局最近 20 条并显示来源', () => {
  const { registrations, render } = loadClient()
  const desk = registrations.find((r) => r.opts.id === 'session-superagent-desk')
  const repos = ['a/one', 'b/two', 'c/three', 'd/four']
  const base = Date.parse('2026-11-06T00:00:00.000Z')
  const watchers = repos.map((repo, watcherIndex) => watcher(repo, {
    id: repo + '#s' + watcherIndex,
    sessionId: 'session-source-' + watcherIndex,
    events: Array.from({ length: 6 }, (_, eventIndex) => ({
      at: new Date(base + (eventIndex * 4 + watcherIndex) * 1000).toISOString(),
      kind: 'poll', number: watcherIndex * 10 + eventIndex,
      text: 'event-' + watcherIndex + '-' + eventIndex,
    })),
  }))
  const expected = watchers.flatMap((w) => w.events.map((event) => ({ watcher: w, event })))
    .sort((a, b) => String(b.event.at).localeCompare(String(a.event.at))).slice(0, 20)
  const snap = {
    loading: false, error: null,
    body: { sessionGoal: null, sessionTitle: 'x', credentials: { token: 'configured' }, watchers },
  }
  const nodes = walk(render(desk, deskQueue(snap, null, {}, 'judge')))
  const timeline = nodes.find((n) => n.type === 'ol' && n.props.className === 'dt-timeline')
  assert.ok(timeline, '缺运行时事件时间线')
  const items = timeline.props.children.filter((n) => n.type === 'li')
  assert.equal(items.length, 20, '标题承诺最近 20 条，就不能把 4×6=24 条全部渲染')
  const texts = items.map((item) => walk(item).filter((n) => n.type === '#text').map((n) => n.text).join(' | '))
  expected.forEach(({ watcher: w, event }, index) => {
    assert.ok(texts[index].includes(event.text), '第 ' + index + ' 条应是 ' + event.text + '，实际：' + texts[index])
    assert.ok(texts[index].includes(w.repo), '运行事件要显示 repo')
    assert.ok(texts[index].includes('source-' + watcherIndexFor(w, watchers)), '运行事件要显示 session：' + texts[index])
    assert.ok(texts[index].includes(event.at), '运行事件要显示完整时间')
  })

  const empty = { ...snap, body: { ...snap.body, watchers: watchers.map((w) => ({ ...w, events: [] })) } }
  const emptyNodes = walk(render(desk, deskQueue(empty, null, {}, 'judge')))
  assert.equal(emptyNodes.filter((n) => n.type === 'ol' && n.props.className === 'dt-timeline').length, 0,
    '有守但零事件不能渲染空 ol')
  assert.ok(emptyNodes.some((n) => n.type === '#text' && n.text.includes('还没有运行时事件')), '零事件要有明确空态')
})

function watcherIndexFor(target, watchers) {
  return watchers.findIndex((w) => w === target)
}

test('W7：同 repo 多 session 的运行事件 key 唯一，并含 session/repo/number/kind/time', () => {
  const { registrations, render } = loadClient()
  const desk = registrations.find((r) => r.opts.id === 'session-superagent-desk')
  const at = '2026-11-06T08:00:00.000Z'
  const watchers = ['session-alpha', 'session-beta'].map((sessionId) => watcher('same/repo', {
    id: 'same/repo#' + sessionId, sessionId,
    events: [
      { at, kind: 'poll', number: 7, text: 'poll-' + sessionId },
      { at, kind: 'wake', number: 7, text: 'wake-' + sessionId },
    ],
  }))
  const snap = {
    loading: false, error: null,
    body: { sessionGoal: null, sessionTitle: 'x', credentials: { token: 'configured' }, watchers },
  }
  const nodes = walk(render(desk, deskQueue(snap, null, {}, 'judge')))
  const timeline = nodes.find((n) => n.type === 'ol' && n.props.className === 'dt-timeline')
  const items = timeline.props.children.filter((n) => n.type === 'li')
  assert.equal(new Set(items.map((item) => item.key)).size, items.length, '同 repo 不同 session 不得复用 a/b-ev0')
  for (const item of items) {
    const text = walk(item).filter((n) => n.type === '#text').map((n) => n.text).join(' | ')
    const w = watchers.find((candidate) => text.includes(candidate.sessionId.replace(/^session-/, '')))
    assert.ok(w, '事件正文必须能定位 session：' + text)
    for (const part of [w.sessionId, w.repo, '7', at]) assert.ok(String(item.key).includes(part), 'key 缺 ' + part + '：' + item.key)
    assert.ok(String(item.key).includes(text.includes('wake-') ? 'wake' : 'poll'), 'key 要含事件 kind')
  }
})

test('W6：最近被过滤按全局时间排序，摘要与展开均含 repo/session/编号/原因/time，key 不冲突', () => {
  const { registrations, render } = loadClient()
  const desk = registrations.find((r) => r.opts.id === 'session-superagent-desk')
  const base = Date.parse('2026-11-06T00:00:00.000Z')
  const definitions = [
    ['same/repo', 'session-alpha', [0, 5]],
    ['same/repo', 'session-beta', [1, 4]],
    ['other/repo', 'session-gamma', [2, 3]],
  ]
  const watchers = definitions.map(([repo, sessionId, offsets]) => watcher(repo, {
    id: repo + '#' + sessionId, sessionId,
    filteredLog: offsets.map((offset) => ({
      at: new Date(base + offset * 1000).toISOString(), number: 7,
      title: 'filtered-' + offset, reason: offset % 2 ? '机器人' : '草稿 PR',
    })),
  }))
  const expected = watchers.flatMap((w) => w.filteredLog.map((entry) => ({ watcher: w, entry })))
    .sort((a, b) => String(b.entry.at).localeCompare(String(a.entry.at)))
  const snap = {
    loading: false, error: null,
    body: { sessionGoal: null, sessionTitle: 'x', credentials: { token: 'configured' }, watchers },
  }
  const opened = walk(render(desk, [...deskQueue(snap), true]))
  const list = opened.find((n) => n.type === 'ul' && n.props.className === 'dt-plain-list'
    && n.props.children.some((item) => String(item.key).includes('filtered') || typeof item.props.children[0] === 'string' && item.props.children[0].startsWith('#')))
  assert.ok(list, '展开后必须有过滤记录列表')
  const items = list.props.children.filter((n) => n.type === 'li')
  assert.equal(items.length, expected.length)
  assert.equal(new Set(items.map((item) => item.key)).size, items.length, '同编号跨 session 的过滤 key 不得重复')
  const texts = items.map((item) => walk(item).filter((n) => n.type === '#text').map((n) => n.text).join(' | '))
  expected.forEach(({ watcher: w, entry }, index) => {
    const session = w.sessionId.replace(/^session-/, '').slice(0, 8)
    for (const part of [w.repo, session, '#' + entry.number, entry.title, entry.reason, entry.at]) {
      assert.ok(texts[index].includes(part), '第 ' + index + ' 条缺 ' + part + '：' + texts[index])
    }
    for (const part of [w.sessionId, w.repo, String(entry.number), 'filtered', entry.at]) {
      assert.ok(String(items[index].key).includes(part), '过滤 key 缺 ' + part + '：' + items[index].key)
    }
    const times = walk(items[index]).filter((n) => n.type === 'time')
    assert.equal(times.length, 1, '每条过滤记录必须有一个语义化 time')
    assert.equal(times[0].props.dateTime, entry.at)
  })
  const closed = walk(render(desk, deskQueue(snap)))
  const closedText = closed.filter((n) => n.type === '#text').map((n) => n.text).join(' | ')
  assert.ok(closedText.includes('same/repo · 会话 alpha'), '折叠摘要也要取全局最新并带来源')
  assert.ok(!closedText.includes('[object Object]'), '结构化记录不能泄漏成 [object Object]')
})

test('W8：搜索/非搜索筛选/零守空态分流，恢复按钮真实清除全部条件', () => {
  const { registrations, render, stateCalls, resetStateCalls } = loadClient()
  const desk = registrations.find((r) => r.opts.id === 'session-superagent-desk')
  const snap = {
    loading: false, error: null,
    body: {
      sessionGoal: null, sessionTitle: 'x', credentials: { token: 'configured' },
      watchers: [watcher('ok/one', {
        id: 'ok/one#s1', sessionId: 's1', repoAccess: { repo: 'ok/one', push: true, hasIssues: true },
      })],
    },
  }
  const textOf = (nodes) => nodes.filter((n) => n.type === '#text').map((n) => n.text).join(' | ')
  const clear = (nodes) => nodes.find((n) => n.type === 'button'
    && (n.props.children || []).filter((child) => typeof child === 'string').join('') === '清除全部筛选')
  for (const [name, index, value] of [['徽章', 16, '只读'], ['状态', 18, 'error'], ['问题', 17, true]]) {
    const queue = deskQueue(snap)
    queue[index] = value
    const nodes = walk(render(desk, queue))
    const text = textOf(nodes)
    assert.ok(text.includes('没有符合当前筛选条件的主理鱼。'), name + '筛选要说筛选空态：' + text.slice(-500))
    assert.ok(!text.includes('没有匹配「」'), name + '筛选不得伪造空搜索词')
    assert.ok(!text.includes('点上面「全部」'), name + '筛选不得指向不存在的全部')
    const button = clear(nodes)
    assert.ok(button, name + '筛选空态必须有真实恢复按钮')
    resetStateCalls()
    button.props.onClick()
    assert.deepEqual(stateCalls().map((call) => [call.index, call.next]), [
      [16, null], [18, null], [10, ''], [17, false], [15, null],
    ], name + '筛选恢复必须清掉所有叠加条件')
  }

  for (const withBadge of [false, true]) {
    const queue = deskQueue(snap, null, {}, 'overview', 'not-found')
    if (withBadge) queue[16] = '只读'
    const nodes = walk(render(desk, queue))
    const text = textOf(nodes)
    assert.ok(text.includes('没有匹配「not-found」的主理鱼。'), '搜索空态要保留真实搜索词')
    assert.ok(clear(nodes), '搜索' + (withBadge ? '+筛选' : '') + '空态必须能恢复')
  }

  const empty = { ...snap, body: { ...snap.body, watchers: [] } }
  const zeroText = textOf(walk(render(desk, deskQueue(empty))))
  assert.ok(zeroText.includes('三步让这个会话开始盯办'), '真正零守仍走上手引导')
  assert.ok(!zeroText.includes('没有匹配「」') && !zeroText.includes('清除全部筛选'), '无筛选零守不得伪装成筛选无结果')
})

// W11–W14：直接执行 client.js 内部的共享组件，避免只靠源码字符串判断可访问性。
function loadA11yInternals(states = []) {
  const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  const needle = "    return {\n      inject: ['slots'],"
  assert.ok(source.includes(needle), '找不到 client.js 的返回出口')
  const instrumented = source.replace(needle,
    "    window.__a11yInternals = { DisclosureRow, Section, TraceTimeline, WatcherForm, restoreSaveBarFocus: typeof restoreSaveBarFocus === 'function' ? restoreSaveBarFocus : null }\n"
    + needle)
  let mod = null
  let stateCursor = 0
  const timers = []
  const stateCalls = []
  const document = { activeElement: null, body: null }
  const React = {
    Fragment: Symbol('Fragment'),
    createElement(type, props, ...children) {
      const { key, ...rest } = props || {}
      const node = { type, props: { ...rest, children: children.flat(Infinity).filter((child) => child !== null && child !== undefined && child !== false) } }
      if (key !== undefined) node.key = key
      return node
    },
    useState(initial) {
      const index = stateCursor++
      return [index < states.length ? states[index] : (typeof initial === 'function' ? initial() : initial),
        (next) => stateCalls.push({ index, next })]
    },
    useRef: (current) => ({ current }),
    useCallback: (fn) => fn,
    useEffect() {},
  }
  const sandbox = {
    window: { __ModuleLoader__: { load(value) { mod = value } } },
    document,
    setTimeout: (fn) => { timers.push(fn); return timers.length },
    clearTimeout() {},
    console,
  }
  vm.createContext(sandbox)
  vm.runInContext(instrumented, sandbox)
  assert.ok(mod, '可访问性内部组件测试也必须执行真实 client.js')
  mod.factory((name) => {
    if (name === 'react') return React
    throw new Error('unexpected require: ' + name)
  })
  return {
    internals: sandbox.window.__a11yInternals,
    document,
    timers,
    stateCalls,
    flushFocus: () => timers.splice(0).forEach((fn) => fn()),
  }
}

function a11yText(node) {
  return walk(node).filter((item) => item.type === '#text').map((item) => item.text).join('')
}

test('W11：新建/编辑放弃后回到仍存活的第一个可编辑控件', () => {
  const { internals, document, flushFocus } = loadA11yInternals()
  assert.equal(typeof internals.restoreSaveBarFocus, 'function', '缺少 SaveBar 焦点归还 helper')
  for (const mode of ['create', 'edit']) {
    const input = { name: mode + '-input', isConnected: true, focus() { document.activeElement = this } }
    const discard = { name: mode + '-discard', isConnected: true }
    const saveBar = { contains: (node) => node === discard }
    const form = {
      isConnected: true,
      querySelector: (selector) => selector.startsWith('input:not(:disabled)') ? input : null,
    }
    document.body = { name: 'body', isConnected: true }
    document.activeElement = discard
    internals.restoreSaveBarFocus({ form, saveBar })
    assert.equal(document.activeElement, discard, 'React commit 前不能抢焦点')
    flushFocus()
    assert.equal(document.activeElement, input, mode + ' 放弃后不能掉到 body')
  }
})

test('W11：编辑保存关闭表单后回 opener；用户主动移走时不抢焦点', () => {
  const { internals, document, flushFocus } = loadA11yInternals()
  assert.equal(typeof internals.restoreSaveBarFocus, 'function')
  const opener = { name: 'opener', isConnected: true, focus() { document.activeElement = this } }
  const save = { name: 'save', isConnected: true }
  const saveBar = { contains: (node) => node === save }
  const form = { isConnected: false, querySelector: () => null }
  document.body = { name: 'body', isConnected: true }
  document.activeElement = save
  internals.restoreSaveBarFocus({ form, saveBar, opener })
  document.activeElement = document.body // React 卸载表单后浏览器自然回落
  flushFocus()
  assert.equal(document.activeElement, opener, '编辑保存卸载后应回行标题')

  for (const moveTiming of ['before-schedule', 'after-schedule']) {
    const elsewhere = { name: moveTiming, isConnected: true, focus() { document.activeElement = this } }
    document.activeElement = moveTiming === 'before-schedule' ? elsewhere : save
    internals.restoreSaveBarFocus({ form, saveBar, opener })
    document.activeElement = elsewhere
    flushFocus()
    assert.equal(document.activeElement, elsewhere, moveTiming + ' 的主动焦点移动必须保留')
  }
})

function watcherFocusScenario(mode, onSave, onDiscard = () => {}) {
  const context = loadA11yInternals([false, false, null])
  const tree = context.internals.WatcherForm({
    mode, idPrefix: 'watcher-focus-' + mode,
    value: { intervalSec: '90', repo: mode === 'create' ? 'acme/new' : undefined },
    snapshot: { intervalSec: '60', repo: mode === 'create' ? '' : undefined },
    sessionId: 'session-focus', submitLabel: mode === 'create' ? '添加' : '保存',
    onChange() {}, onSave, onDiscard,
  })
  const nodes = walk(tree)
  const formView = nodes.find((node) => node.type === 'form')
  const saveView = nodes.find((node) => node.type === 'button' && a11yText(node) === (mode === 'create' ? '添加' : '保存'))
  const discardView = nodes.find((node) => node.type === 'button' && a11yText(node) === '放弃')
  const { document } = context
  document.body = { name: 'body', isConnected: true }
  const input = { name: mode + '-input', isConnected: true, focus() { document.activeElement = this } }
  const opener = { name: mode + '-opener', isConnected: true, focus() { document.activeElement = this } }
  const save = { name: mode + '-save', isConnected: true }
  const discard = { name: mode + '-discard', isConnected: true }
  let editable = true
  const saveBar = { contains: (node) => node === save || node === discard }
  const form = {
    isConnected: true,
    contains: (node) => node === save || node === discard || node === input,
    closest: () => ({ querySelector: () => opener }),
    querySelector(selector) {
      if (selector === '.dt-savebar') return saveBar
      if (selector.startsWith('input:not(:disabled)')) return editable ? input : null
      return null
    },
  }
  formView.props.ref.current = form
  formView.props.onFocusCapture()
  return { ...context, form, input, opener, save, discard, saveView, discardView, setEditable: (value) => { editable = value } }
}

test('W11：真实 WatcherForm 保存/放弃接线成功才回焦，失败保留焦点与错误', async () => {
  for (const mode of ['create', 'edit']) {
    const scenario = watcherFocusScenario(mode, async () => {
      scenario.setEditable(false)
      if (mode === 'edit') {
        scenario.form.isConnected = false
        scenario.input.isConnected = false
      }
      scenario.document.activeElement = scenario.document.body
      return true
    })
    scenario.document.activeElement = scenario.save
    assert.equal(await scenario.saveView.props.onClick({ preventDefault() {}, currentTarget: { form: null } }), true)
    scenario.setEditable(true)
    scenario.flushFocus()
    assert.equal(scenario.document.activeElement, mode === 'edit' ? scenario.opener : scenario.input,
      mode + ' 保存成功后的回焦目标错误')
  }

  for (const mode of ['create', 'edit']) {
    const scenario = watcherFocusScenario(mode, async () => true)
    scenario.document.activeElement = scenario.discard
    scenario.discardView.props.onClick()
    scenario.flushFocus()
    assert.equal(scenario.document.activeElement, scenario.input, mode + ' 放弃必须回首个字段而非 opener')
  }

  const failure = watcherFocusScenario('edit', async () => { throw new Error('save failed') })
  failure.document.activeElement = failure.save
  assert.equal(await failure.saveView.props.onClick({ preventDefault() {}, currentTarget: { form: null } }), false)
  assert.equal(failure.timers.length, 0, '失败不得安排 opener 回焦')
  assert.equal(failure.document.activeElement, failure.save)
  assert.ok(failure.stateCalls.some((call) => call.index === 2 && call.next === 'save failed'), '失败必须留给 SaveBar')
})

test('W12：busy Disclosure 不可聚焦且有 disabled/busy 语义，click/Enter/Space 均不切', () => {
  const { internals, stateCalls } = loadA11yInternals([false, true, null])
  const tree = internals.WatcherForm({
    mode: 'edit', value: { intervalSec: '60' }, snapshot: { intervalSec: '60' },
    onChange() {}, onSave: async () => true, onDiscard() {},
  })
  const row = walk(tree).find((node) => node.props && node.props.className === 'dt-disclosure-row')
  assert.ok(row, 'WatcherForm 必须渲染高级 Disclosure')
  assert.equal(row.props.tabIndex, -1, 'busy 时必须退出 Tab 顺序')
  assert.equal(row.props['aria-disabled'], true)
  assert.equal(row.props['aria-busy'], 'true')
  const key = (key, repeat = false) => row.props.onKeyDown({ key, repeat, preventDefault() {} })
  row.props.onClick()
  key('Enter')
  key(' ')
  assert.equal(stateCalls.filter((call) => call.index === 0).length, 0, 'busy 不得调用 advancedOpen setter')

  let toggles = 0
  const direct = walk(internals.DisclosureRow({
    title: '高级设置', open: false, busy: true, onToggle: () => { toggles += 1 },
  })).find((node) => node.props && node.props.className === 'dt-disclosure-row')
  direct.props.onClick()
  direct.props.onKeyDown({ key: 'Enter', repeat: false, preventDefault() {} })
  direct.props.onKeyDown({ key: ' ', repeat: false, preventDefault() {} })
  assert.equal(toggles, 0, 'Disclosure 本层也必须吞掉 busy 操作，而不是只靠调用方 guard')
})

test('W12：普通 Disclosure 单键只切一次，重复 keydown 被忽略', () => {
  const { internals } = loadA11yInternals()
  let toggles = 0
  const row = walk(internals.DisclosureRow({
    title: '高级设置', open: false, onToggle: () => { toggles += 1 },
  })).find((node) => node.props && node.props.className === 'dt-disclosure-row')
  const key = (key, repeat) => row.props.onKeyDown({ key, repeat, preventDefault() {} })
  key('Enter', true)
  key(' ', true)
  assert.equal(toggles, 0, '长按 repeat=true 不得反复开合')
  key('Enter', false)
  assert.equal(toggles, 1, '普通 Enter 必须只切一次')
  key(' ', false)
  assert.equal(toggles, 2, '普通 Space 必须只切一次')
  assert.equal(row.props['aria-disabled'], false)
  assert.equal(row.props.tabIndex, 0)
})

test('W13：总览/判定/触发/设置的每个 Section 标题都是 h2，视觉 class 保留', () => {
  const { registrations, render } = loadClient()
  const desk = registrations.find((item) => item.opts.id === 'session-superagent-desk')
  const snap = raceSnapshot()
  const scenarios = [['overview'], ['judge'], ['trigger'], ...['source', 'creds', 'update', 'diagnose', 'goal'].map((section) => ['settings', section])]
  for (const [tab, section] of scenarios) {
    const queue = deskQueue(snap, null, {}, tab)
    if (section) queue[14] = section
    const nodes = walk(render(desk, queue))
    const headings = nodes.filter((node) => node.props && node.props.className === 'dt-section-title')
    assert.ok(headings.length > 0, tab + '/' + (section || '') + ' 至少有一个 Section')
    assert.ok(headings.every((node) => node.type === 'h2'), tab + '/' + (section || '') + ' 存在非 h2 Section 标题')
    assert.ok(nodes.some((node) => node.type === 'h1'), '页面必须保留 h1→h2 层级')
  }
})

test('W14：追溯、首败/stale、持久操作与更新失败均有独立 alert，恢复后移除', () => {
  const { internals } = loadA11yInternals()
  const trace = walk(internals.TraceTimeline({ payload: { error: 'trace failed' } }))
  assert.equal(trace[0].props.role, 'alert')
  assert.equal(trace[0].props['aria-atomic'], 'true')

  const { registrations, render } = loadClient()
  const desk = registrations.find((item) => item.opts.id === 'session-superagent-desk')
  const queue = deskQueue({ ...raceSnapshot(), error: 'Failed to fetch' })
  queue[2] = { ok: false, text: 'save failed' }
  let nodes = walk(render(desk, queue))
  for (const message of ['连不上宿主', 'save failed']) {
    const alert = nodes.find((node) => node.props && node.props && node.props.role === 'alert' && a11yText(node).includes(message))
    assert.ok(alert, '缺少持久错误 alert：' + message)
    assert.equal(alert.props['aria-atomic'], 'true')
  }
  const page = nodes.find((node) => node.props && node.props.className === 'dt-page')
  assert.equal(page.props['aria-live'], undefined, '不能把整页设为 live，轮询会反复播报')

  const updateQueue = deskQueue(raceSnapshot(), null, {}, 'settings')
  updateQueue[12] = { current: '0.9.286', latest: null, hasUpdate: false, error: 'npm failed' }
  updateQueue[14] = 'update'
  nodes = walk(render(desk, updateQueue))
  const updateAlerts = nodes.filter((node) => node.props && node.props && node.props.role === 'alert' && a11yText(node).includes('npm failed'))
  assert.equal(updateAlerts.length, 1, '同一次更新失败只能有一个 alert')
})

// ── W15–W17：fallback 可访问性定向桩 ────────────────────────────────
// panel-harness 的 useEffect 是空实现、hook 槽位也不持久，量不了「一次 Escape 关几层」。
// 这里单独做一个小桩：持久化 hook 槽位、真的执行/清理 effect、记录 document 上的
// capture/bubble 监听，才能复现 Modal 与 Orbit 的同一事件竞争。
function loadFallbackA11y(options = {}) {
  const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  const needle = "    return {\n      inject: ['slots'],"
  assert.ok(source.includes(needle), '找不到 client.js 的返回出口')
  const instrumented = source.replace(needle,
    '    window.__fallbackA11y = { FallbackInfoTip, Modal, StatusOrbit, SegmentedControl, isLocalDialogOpen: () => localDialogDepth > 0 }\n'
    + needle)

  let mod = null
  const listeners = []
  const timers = []
  const document = {
    activeElement: null,
    body: { nodeName: 'BODY', isConnected: true },
    hidden: false,
    addEventListener(type, listener, capture) {
      listeners.push({ type, listener, capture: Boolean(capture) })
    },
    removeEventListener(type, listener, capture) {
      const index = listeners.findIndex((entry) => entry.type === type
        && entry.listener === listener && entry.capture === Boolean(capture))
      if (index >= 0) listeners.splice(index, 1)
    },
    getElementById: () => null,
    createElement: () => ({ id: '', textContent: '' }),
    head: { appendChild() {} },
  }
  const sandbox = {
    window: {
      __ModuleLoader__: { load(value) { mod = value } },
      innerWidth: 1440,
      innerHeight: 900,
      matchMedia: () => ({ matches: false }),
      addEventListener() {},
      removeEventListener() {},
    },
    document,
    navigator: { clipboard: { writeText: async () => {} } },
    // 状态读取永远挂着：本轮只验 Escape 分层，不让异步 loadState 改状态。
    fetch: () => new Promise(() => {}),
    setInterval: () => 0,
    clearInterval() {},
    setTimeout: (fn, ms) => {
      timers.push({ id: timers.length + 1, fn, ms })
      return timers.length
    },
    clearTimeout: (id) => {
      const index = timers.findIndex((timer) => timer.id === id)
      if (index >= 0) timers.splice(index, 1)
    },
    queueMicrotask: (fn) => fn(),
    console,
  }

  let currentCtx = null
  const depsEqual = (a, b) => Array.isArray(a) && Array.isArray(b)
    && a.length === b.length && a.every((value, index) => Object.is(value, b[index]))
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
    forwardRef: (render) => function ForwardRef(props = {}) { return render(props, props.ref || null) },
    memo: (fn) => fn,
    useState(initial) {
      const ctx = currentCtx
      const index = ctx.cursor
      ctx.cursor += 1
      if (!(index in ctx.slots)) ctx.slots[index] = typeof initial === 'function' ? initial() : initial
      const setter = (next) => {
        const resolved = typeof next === 'function' ? next(ctx.slots[index]) : next
        ctx.slots[index] = resolved
        ctx.stateCalls.push({ index, next: resolved })
      }
      return [ctx.slots[index], setter]
    },
    useRef(initial) {
      const ctx = currentCtx
      const index = ctx.cursor
      ctx.cursor += 1
      if (!(index in ctx.slots)) ctx.slots[index] = { current: initial }
      return ctx.slots[index]
    },
    useCallback(fn) {
      currentCtx.cursor += 1
      return fn
    },
    useEffect(create, deps) {
      const ctx = currentCtx
      const index = ctx.cursor
      ctx.cursor += 1
      ctx.seen.add(index)
      const previous = ctx.effects.get(index)
      if (previous && depsEqual(previous.deps, deps)) return
      if (previous && typeof previous.cleanup === 'function') previous.cleanup()
      const cleanup = create()
      ctx.effects.set(index, { deps, cleanup })
    },
  }

  vm.createContext(sandbox)
  vm.runInContext(instrumented, sandbox)
  assert.ok(mod, 'fallback 可访问性测试也必须执行真实 client.js')
  mod.factory((name) => {
    if (name === 'react') return React
    if (name === '@deepseek-ai/dsh-client-ui-primitives') {
      if (options.primitives === undefined) throw new Error('MODULE_NOT_FOUND: ' + name)
      return options.primitives
    }
    throw new Error('unexpected require: ' + name)
  })

  const mount = (Component, props = {}, seed = []) => {
    const ctx = { slots: [...seed], cursor: 0, seen: new Set(), effects: new Map(), stateCalls: [] }
    const render = () => {
      ctx.cursor = 0
      ctx.seen = new Set()
      currentCtx = ctx
      let nodes
      try {
        nodes = walk(Component(props))
      } finally {
        currentCtx = null
        // 本次渲染没再出现的 effect 视为卸载：真实 React 会在 commit 后跑清理。
        for (const [index, entry] of [...ctx.effects]) {
          if (ctx.seen.has(index)) continue
          ctx.effects.delete(index)
          if (typeof entry.cleanup === 'function') entry.cleanup()
        }
      }
      return nodes
    }
    return { render, ctx, stateCalls: ctx.stateCalls }
  }

  const dispatchEscape = (extra = {}) => {
    const event = {
      key: 'Escape', repeat: false, defaultPrevented: false,
      preventDefault() { this.defaultPrevented = true },
      stopPropagation() { this.propagationStopped = true },
      ...extra,
    }
    const keydown = listeners.filter((entry) => entry.type === 'keydown')
    // capture 先于 bubble，和真实事件分发一致。
    for (const entry of keydown) if (entry.capture) entry.listener(event)
    for (const entry of keydown) if (!entry.capture) entry.listener(event)
    return event
  }

  return {
    internals: sandbox.window.__fallbackA11y,
    document,
    listeners,
    timers,
    mount,
    dispatchEscape,
  }
}

function tipNodes(nodes) {
  return nodes.filter((node) => String(node.props?.className || '').split(/\s+/).includes('dt-tooltip'))
}

function infoTrigger(nodes, text) {
  return nodes.filter((node) => node.type === 'button'
    && String(node.props?.className || '').split(/\s+/).includes('dt-info')
    && (text === undefined || node.props['aria-label'] === text))
}

test('W15：fallback Tooltip 有稳定 id 与 aria-describedby，Escape 关闭且焦点留在 trigger', () => {
  const HOST_WITHOUT_TOOLTIP = { Modal: 'm', Toast: 't', IconWarningOutlineMedium: 'w' }
  for (const primitives of [undefined, HOST_WITHOUT_TOOLTIP]) {
    const client = loadFallbackA11y({ primitives })
    const text = '回退说明原文'
    const tip = client.mount(client.internals.FallbackInfoTip, { text, icon: 'alert', warn: true })
    let nodes = tip.render()
    let trigger = infoTrigger(nodes, text)[0]
    assert.ok(trigger, 'fallback 缺原 trigger')
    assert.equal(trigger.props['aria-describedby'], undefined, '关闭时不得保留 describedby')
    assert.equal(tipNodes(nodes).length, 0)

    trigger.props.onClick()
    nodes = tip.render()
    trigger = infoTrigger(nodes, text)[0]
    let bubble = tipNodes(nodes)[0]
    assert.ok(bubble, '点击后必须显示本地气泡')
    assert.ok(bubble.props.id, 'tooltip 必须有稳定 id')
    assert.equal(trigger.props['aria-describedby'], bubble.props.id, '打开时 trigger 必须关联 tooltip id')
    assert.equal(trigger.props['aria-expanded'], true)
    const firstId = bubble.props.id

    // Escape：preventDefault、关闭、焦点仍在 trigger 上。
    const triggerNode = { name: 'trigger', isConnected: true }
    client.document.activeElement = triggerNode
    let prevented = 0
    trigger.props.onKeyDown({ key: 'Escape', repeat: false, preventDefault() { prevented += 1 } })
    assert.equal(prevented, 1, 'Escape 必须 preventDefault')
    assert.equal(client.document.activeElement, triggerNode, 'Escape 后焦点必须留在 trigger')
    nodes = tip.render()
    trigger = infoTrigger(nodes, text)[0]
    assert.equal(tipNodes(nodes).length, 0, 'Escape 必须关闭气泡')
    assert.equal(trigger.props['aria-expanded'], false)
    assert.equal(trigger.props['aria-describedby'], undefined, '关闭后必须清除 describedby')

    // 再打开：同一 trigger 的 id 必须稳定，不能每次重建。
    trigger.props.onClick()
    nodes = tip.render()
    bubble = tipNodes(nodes)[0]
    assert.equal(bubble.props.id, firstId, '同一 trigger 反复打开必须复用同一个 tooltip id')

    // blur 仍是原有关闭路径，并同步清关联。
    trigger = infoTrigger(nodes, text)[0]
    trigger.props.onBlur()
    nodes = tip.render()
    assert.equal(tipNodes(nodes).length, 0, 'blur 必须继续关闭气泡')
    assert.equal(infoTrigger(nodes, text)[0].props['aria-describedby'], undefined)
  }
})

test('W16：fallback 确认 Modal 独占 Escape，底层 Orbit 不同时关闭且焦点回 opener', () => {
  const client = loadFallbackA11y()
  const list = [watcher('a/b', { id: 'a/b#s1', title: '会话 a/b', intervalSec: 30 })]
  // StatusOrbit hooks：watchers / orbitError / open / anchor（再往后是 refs 和 effects）。
  const orbit = client.mount(client.internals.StatusOrbit, {}, [list, null, true, { x: 700, y: 800 }])
  let nodes = orbit.render()
  const opener = { name: 'delete-opener', isConnected: true, focus() { client.document.activeElement = this } }
  client.document.activeElement = opener
  const deleteButton = nodes.find((node) => node.type === 'button' && node.props['aria-label'] === '删除')
  assert.ok(deleteButton, 'fallback 弹层缺删除按钮')
  deleteButton.props.onClick()
  nodes = orbit.render()
  const dialog = nodes.find((node) => node.props && node.props.role === 'dialog'
    && String(node.props.className || '').includes('dt-modal'))
  assert.ok(dialog, '点删除必须打开本地确认 Modal')
  assert.equal(client.internals.isLocalDialogOpen(), true, 'Modal 打开期间必须登记为最上层对话框')

  // 背板/取消的 mousedown 也不得穿透：Modal 层还在时 Orbit 不处理外点关闭。
  const mousedown = client.listeners.filter((entry) => entry.type === 'mousedown' && entry.capture)
  assert.equal(mousedown.length, 1, 'Orbit 打开时必须登记 capture mousedown')
  orbit.stateCalls.length = 0
  mousedown[0].listener({ target: {}, preventDefault() {} })
  assert.ok(!orbit.stateCalls.some((call) => call.index === 2 && call.next === false),
    'Modal 打开时点击背板不得同时关闭底层 Orbit')

  orbit.stateCalls.length = 0
  const escaped = client.dispatchEscape()
  assert.equal(escaped.defaultPrevented, true, 'Modal 必须消费这次 Escape')
  assert.ok(orbit.stateCalls.some((call) => call.index !== 2 && call.next === false), '第一次 Escape 必须关闭 Modal')
  assert.ok(!orbit.stateCalls.some((call) => call.index === 2 && call.next === false),
    '底层 Orbit 不得同时关闭：' + JSON.stringify(orbit.stateCalls))

  nodes = orbit.render()
  assert.equal(client.internals.isLocalDialogOpen(), false, 'Modal 关闭后必须释放层级')
  assert.equal(nodes.filter((node) => node.props && String(node.props.className || '').includes('dt-modal')).length, 0,
    'Modal 关闭后不得残留对话框')
  assert.equal(client.document.activeElement, opener, 'Modal 关闭后焦点必须回到 opener')

  // 第二次 Escape 才轮到 Orbit；一次按键只能关一层。
  orbit.stateCalls.length = 0
  client.dispatchEscape()
  assert.ok(orbit.stateCalls.some((call) => call.index === 2 && call.next === false),
    '第二次 Escape 应关闭底层 Orbit')
})

test('W17：fallback Toast 以 item.id 为 key，连续通知重新挂载且 hold 与 timer 对齐', () => {
  const { registrations, render } = loadClient()
  const desk = registrations.find((item) => item.opts.id === 'session-superagent-desk')
  const snapshot = {
    loading: false, error: null,
    body: {
      sessionGoal: null, sessionTitle: 'Toast key', credentials: {},
      gh: { ok: true }, defaults: {}, watchers: [watcher('a/b')],
    },
  }
  const toastOf = (item) => {
    const queue = deskQueue(snapshot)
    queue[7] = item
    const nodes = walk(render(desk, queue))
    const toast = nodes.find((node) => String(node.props?.className || '').split(/\s+/).includes('dt-toast'))
    assert.ok(toast, '缺 fallback Toast：' + JSON.stringify(item))
    return toast
  }
  const first = toastOf({ id: 'toast-a', text: '第一条', tone: 'success' })
  assert.equal(first.key, 'toast-a', 'fallback Toast 必须用 item.id 作为 React key')
  assert.equal(first.props.key, undefined, 'React key 不应留在 props')
  assert.equal(first.props.style['--dt-toast-hold'], '3000ms', 'CSS hold 必须与 4000ms timer 对齐（3000 + 1000 fade）')

  const second = toastOf({ id: 'toast-b', text: '第二条', tone: 'error' })
  assert.equal(second.key, 'toast-b')
  assert.notEqual(first.key, second.key, '连续两条通知必须换 key 才能重启动画')
})

test('W14：同文轮询失败复用 snap，不重建读取 alert；新错误仍可更新', async () => {
  let attempt = 0
  const panel = loadStatefulPanel({
    queue: deskQueue(raceSnapshot()),
    fetch: (url) => {
      if (!new URL(url, 'http://fixture.local').pathname.endsWith('/state')) return Promise.resolve(raceResponse({ ok: true }))
      attempt += 1
      return Promise.resolve(raceResponse({ error: attempt < 3 ? 'same failure' : 'changed failure' }, 500))
    },
  })
  const refresh = panel.button('刷新')
  await refresh.props.onClick()
  const first = panel.snap()
  assert.ok(panel.nodes().some((node) => node.props && node.props.role === 'alert' && a11yText(node).includes('same failure')))
  await refresh.props.onClick()
  assert.strictEqual(panel.snap(), first, '同文同状态失败必须返回 prev，避免轮询重播')
  await refresh.props.onClick()
  assert.notStrictEqual(panel.snap(), first, '错误文本变化仍是新通知')
  assert.equal(panel.snap().error, 'changed failure')
})

test('W14：更新检查失败有 alert，重新检查成功后移除', async () => {
  let attempt = 0
  const queue = deskQueue(raceSnapshot(), null, {}, 'settings')
  queue[14] = 'update'
  const panel = loadStatefulPanel({
    queue,
    fetch: (url) => {
      if (!new URL(url, 'http://fixture.local').pathname.endsWith('/update')) return Promise.resolve(raceResponse({ ok: true }))
      attempt += 1
      return Promise.resolve(attempt === 1
        ? raceResponse({ error: 'npm failed' }, 500)
        : raceResponse({ current: '0.9.286', latest: '0.9.286', hasUpdate: false }))
    },
  })
  const retry = panel.button('重新检查')
  assert.equal(await retry.props.onClick(), false)
  assert.equal(panel.nodes().filter((node) => node.props && node.props.role === 'alert' && a11yText(node).includes('npm failed')).length, 1)
  assert.equal(await retry.props.onClick(), true)
  assert.equal(panel.nodes().filter((node) => node.props && node.props.role === 'alert' && a11yText(node).includes('npm failed')).length, 0)
})

// ── G3：设置 → 门禁 ─────────────────────────────────────────────────────────────
// GET /gates 的形状照抄 lib/index.js 的四条路由：{ ok, repo, sources, config, scopes }。
// 规则取的是 packages/dsh-gate/gates/default.json 里真实的两条 —— 断言的就是客户真会看到的文案。
const GATE_SECRET_RULE = {
  id: 'secret',
  label: '禁止凭证与密钥',
  description: '回复里不能出现 token、私钥、Authorization 或 password 赋值。',
  severity: 'error',
  triggers: ['issue.reply', 'pr.reply', 'merge', 'release'],
  type: 'regex',
  pattern: 'ghp_[A-Za-z0-9]{20,}|-----BEGIN [A-Z ]*PRIVATE KEY-----',
  message: '删掉凭证；需要引用时写 <redacted>。',
}
const GATE_PATH_RULE = {
  id: 'abs-path',
  label: '禁止本机绝对路径',
  description: '不要贴 D: 盘或 /Users/ 这类本机路径。',
  severity: 'warn',
  triggers: ['issue.reply', 'pr.reply'],
  type: 'regex',
  pattern: '(?<![A-Za-z0-9])[A-Za-z]:[\\\\/]',
  message: '改成仓库相对路径，或只描述文件位置。',
}

const gateApiPayload = () => ({
  ok: true,
  repo: 'E:/work/demo',
  sources: [{ name: 'default', path: 'packages/dsh-gate/gates/default.json' }],
  config: {
    version: 1,
    name: 'default',
    rules: [GATE_SECRET_RULE, GATE_PATH_RULE],
    semantic: {
      enabled: false,
      model: 'group/deepseek-v4.1-flash-1017',
      prompt: '你是代码仓库回复审核员。',
      baseURL: 'http://127.0.0.1:3425/v1',
    },
  },
  scopes: {
    default: { path: 'packages/dsh-gate/gates/default.json', exists: true, config: { rules: [GATE_SECRET_RULE, GATE_PATH_RULE] } },
    user: { path: '/home/u/.dsh/state/session-superagent/gates.json', exists: false, config: null },
    project: { path: 'E:/work/demo/.superagent/gates.json', exists: false, config: null },
    local: { path: 'E:/work/demo/.superagent/gates.local.json', exists: false, config: null },
  },
})

const gateSnapshot = () => ({
  loading: false,
  error: null,
  body: {
    credentials: { token: 'none', sshKeyPath: 'none', ghConfigDir: 'none', giteeToken: 'none' },
    gh: { ok: true, version: '2.0' },
    defaults: { sessionMaxWakes: 12, maxWakesPerHour: 6, isolateKeepDays: 3, batchLimit: 5 },
    // workdir 是「项目层」的仓库路径来源：门禁 POST 要带上它，服务端才知道写到哪个仓库
    watchers: [watcher('a/b', { id: 'a/b#s1', workdir: 'E:/work/demo' })],
  },
})

/**
 * 门禁页的状态槽 = 主面板 23 个 + GateSettings 自己的 12 个。
 * 顺序必须与 client.js 里 GateSettings 的 useState 一致（位置化队列只能在末尾追加）：
 * data / loadError / scope / draft / advanced / sample / trigger / preview / models / busy / status / pendingSwitch
 *
 * `snapshot` 用来改 /state（例如换掉 watcher 的 workdir = 换仓库）；不传就是默认快照。
 */
const gateQueue = (over = {}) => {
  const queue = deskQueue(over.snapshot || gateSnapshot(), null, {}, 'settings')
  queue[14] = 'gate'
  return [...queue,
    'data' in over ? over.data : gateApiPayload(),
    over.loadError || '',
    over.scope || 'user',
    'draft' in over ? over.draft : null,
    over.advanced || '',
    over.sample || '',
    over.trigger || 'issue.reply',
    'preview' in over ? over.preview : null,
    over.models || { list: [], loading: false, error: '' },
    over.busy || '',
    'status' in over ? over.status : null,
    'pending' in over ? over.pending : null]
}

/** GateSettings 的状态槽下标（主面板 23 槽之后）。切作用域/仓库的确认是第 12 槽。 */
const GATE_SLOT = {
  data: 23, loadError: 24, scope: 25, draft: 26, advanced: 27, sample: 28,
  trigger: 29, preview: 30, models: 31, busy: 32, status: 33, pendingSwitch: 34,
}

// a11yText 吃的是「树」，喂已经 walk 过的节点数组只会得到空串 —— 这里按节点取文案。
const gateText = (nodes) => nodes.filter((node) => node.type === '#text').map((node) => node.text).join(' | ')

const gateDraft = (rules, semantic) => ({
  rules: rules || [GATE_SECRET_RULE, GATE_PATH_RULE].map((rule) => ({ ...rule, enabled: true })),
  semantic: semantic || { enabled: true, model: 'group/deepseek-v4.1-flash-1017', prompt: '审核提示词', off: false },
})

test('设置页左栏多了「门禁」，点它切到门禁分区', () => {
  const { registrations, render, stateCalls, resetStateCalls } = loadClient()
  const desk = registrations.find((r) => r.opts.id === 'session-superagent-desk')
  const nodes = walk(render(desk, deskQueue(gateSnapshot(), null, {}, 'settings')))
  const nav = nodes.filter((n) => n.type === 'button' && (n.props.children || []).join('') === '门禁')
  assert.equal(nav.length, 1, '设置页左栏要有「门禁」')
  resetStateCalls()
  nav[0].props.onClick()
  assert.deepEqual(stateCalls().map((call) => call.next), ['gate'], '点「门禁」要写入分区 key')
})

test('门禁作用域：默认只读，我的 / 项目可改', () => {
  const { registrations, render } = loadClient()
  const desk = registrations.find((r) => r.opts.id === 'session-superagent-desk')
  const readOnlyNodes = walk(render(desk, gateQueue({ scope: 'default' })))
  const readOnlySwitches = readOnlyNodes.filter((n) => n.type === 'button' && n.props.role === 'switch'
    && String(n.props.id || '').startsWith('gate-rule-'))
  assert.equal(readOnlySwitches.length, 2, '两条规则各一个开关')
  assert.ok(readOnlySwitches.every((node) => node.props.disabled === true), '默认层只读：规则开关都要禁用')
  const readOnlySemantic = readOnlyNodes.filter((n) => n.type === 'button' && n.props.id === 'gate-semantic-enabled')
  assert.equal(readOnlySemantic.length, 1, '默认层也要能看到语义复审的开关')
  assert.equal(readOnlySemantic[0].props.disabled, true, '默认层只读：语义复审开关也禁用')
  assert.equal(readOnlyNodes.filter((n) => n.type === 'button' && (n.props.children || []).join('') === '保存').length, 0,
    '默认层不能保存')
  assert.ok(gateText(readOnlyNodes).includes('默认规则随包发布'), '默认层要说清只读')

  const editable = walk(render(desk, gateQueue({ scope: 'user' })))
  const toggles = editable.filter((n) => n.type === 'button' && n.props.role === 'switch'
    && String(n.props.id || '').startsWith('gate-rule-'))
  assert.ok(toggles.length === 2 && toggles.every((node) => node.props.disabled === false), '我的层规则开关可点')
  assert.equal(editable.filter((n) => n.type === 'button' && (n.props.children || []).join('') === '保存').length, 1,
    '我的层要有保存')
  assert.ok(gateText(editable).includes('用户全局配置'), '我的层要说清写到哪')
  assert.ok(gateText(editable).includes('/home/u/.dsh/state/session-superagent/gates.json'), '要把配置文件路径显示出来')
})

test('门禁作用域切换：点「项目」写入 scope=project', () => {
  const { registrations, render, stateCalls, resetStateCalls } = loadClient()
  const desk = registrations.find((r) => r.opts.id === 'session-superagent-desk')
  const nodes = walk(render(desk, gateQueue({ scope: 'user' })))
  const radios = nodes.filter((n) => n.type === 'button' && n.props.role === 'radio')
  assert.deepEqual(radios.map((n) => (n.props.children || []).join('')), ['默认（只读）', '我的', '项目'],
    '三个作用域都要有')
  resetStateCalls()
  radios[2].props.onClick()
  assert.ok(stateCalls().some((call) => call.next === 'project'), '点「项目」要写入 scope=project')
  const project = walk(render(desk, gateQueue({ scope: 'project' })))
  assert.ok(gateText(project).includes('跟着仓库走'), '项目层要说清写到哪')
  assert.ok(gateText(project).includes('项目层只能关闭语义复审'), '项目层不能换模型：要说明')
})

test('门禁规则卡：中文 label / 说明，正则默认收在「高级」里', () => {
  const { registrations, render } = loadClient()
  const desk = registrations.find((r) => r.opts.id === 'session-superagent-desk')
  const closed = walk(render(desk, gateQueue({ scope: 'user' })))
  const closedText = gateText(closed)
  assert.ok(closedText.includes('禁止凭证与密钥'), '规则 label 要中文可读：' + closedText.slice(0, 200))
  assert.ok(closedText.includes('回复里不能出现 token'), '规则说明要中文可读')
  assert.ok(!closedText.includes('ghp_[A-Za-z0-9]{20,}'), '正则默认不展开：' + closedText.slice(0, 240))
  const disclosure = closed.filter((n) => n.props && n.props.role === 'button' && n.props['aria-controls'] === 'gate-rule-secret-body')
  assert.equal(disclosure.length, 1, '每条规则要有「高级」折叠行')
  assert.equal(disclosure[0].props['aria-expanded'], false, '默认收起')
  assert.ok(a11yText(disclosure[0]).includes('高级'), '折叠行要写「高级」')

  const opened = walk(render(desk, gateQueue({ scope: 'user', advanced: 'secret' })))
  const openedText = gateText(opened)
  assert.ok(openedText.includes('ghp_[A-Za-z0-9]{20,}'), '展开「高级」后才显示正则')
  assert.ok(openedText.includes('删掉凭证；需要引用时写 <redacted>。'), '高级里要有命中后提示')
})

// 带某一层已写内容的 GET /gates 形状：本层停用 / 本层覆盖都要能构造出来。
const gateApiWithLayer = (scope, layerRules, mergedRules = null) => {
  const base = gateApiPayload()
  return {
    ...base,
    config: mergedRules ? { ...base.config, rules: mergedRules } : base.config,
    scopes: {
      ...base.scopes,
      [scope]: { path: base.scopes[scope].path, exists: true, config: { name: scope, rules: layerRules } },
    },
  }
}

// 合并后的语义复审值与 gateApiPayload 的默认配置一致（避免「没改语义」被写成改动）。
const GATE_SEMANTIC_DERIVED = { enabled: false, model: 'group/deepseek-v4.1-flash-1017', prompt: '你是代码仓库回复审核员。', off: false }

test('门禁保存：关掉的规则写 enabled:false，改过的规则一起落盘，成功要有回执', async () => {
  const requests = []
  const panel = loadStatefulPanel({
    queue: gateQueue({
      scope: 'user',
      draft: gateDraft([
        { ...GATE_SECRET_RULE, enabled: false },
        { ...GATE_PATH_RULE, enabled: true, message: '改成仓库相对路径。' },
      ]),
    }),
    fetch: (url, init = {}) => {
      requests.push({ url: String(url), init })
      const parsed = new URL(String(url), 'http://fixture.local')
      if (parsed.pathname.endsWith('/gates') && init.method === 'POST') {
        return Promise.resolve(raceResponse({ ok: true, scope: 'user', path: '/home/u/.dsh/state/session-superagent/gates.json', config: {} }))
      }
      return Promise.resolve(raceResponse(gateApiPayload()))
    },
  })
  await panel.button('保存').props.onClick()
  const post = requests.find((item) => item.url.includes('/gates') && item.init.method === 'POST')
  assert.ok(post, '必须真的 POST /gates')
  const payload = JSON.parse(post.init.body)
  assert.equal(payload.scope, 'user', '写到「我的」这一层')
  assert.equal(payload.repo, 'E:/work/demo', '项目层要知道写到哪个仓库')
  assert.deepEqual(payload.config.rules.map((rule) => rule.id), ['secret', 'abs-path'], '停用和改文案的规则都要落盘')
  const secret = payload.config.rules[0]
  assert.equal(secret.enabled, false, '关掉必须写成 enabled:false，而不是「本层不覆盖」')
  assert.equal(secret.type, 'regex', '停用也要写完整规则：缺 type 的复启会被 validateConfig 判非法')
  assert.equal(secret.pattern, GATE_SECRET_RULE.pattern, '停用要保留完整规则内容')
  const path = payload.config.rules[1]
  assert.equal(path.enabled, true, '没关的规则也要写 enabled:true')
  assert.equal(path.message, '改成仓库相对路径。')
  assert.deepEqual(payload.config.semantic, { enabled: true, model: 'group/deepseek-v4.1-flash-1017', prompt: '审核提示词' })
  assert.ok(panel.nodes().some((node) => node.props && node.props.role === 'status' && /已保存/.test(String(node.props.children))),
    '保存成功要有回执')
  const reloads = requests.filter((item) => item.url.includes('/gates') && (!item.init.method || item.init.method === 'GET'))
  assert.equal(reloads.length, 1, '保存成功后必须重新读取配置（卡片回到四层合并结果）')
})

test('门禁开关：卡片状态取四层合并结果，停用的规则显示为关', () => {
  const { registrations, render } = loadClient()
  const desk = registrations.find((r) => r.opts.id === 'session-superagent-desk')
  const disabledSecret = { ...GATE_SECRET_RULE, enabled: false }
  const payload = gateApiWithLayer('user', [disabledSecret], [disabledSecret, GATE_PATH_RULE])

  const user = walk(render(desk, gateQueue({ scope: 'user', data: payload })))
  const switchOf = (id, nodes) => nodes.find((n) => n.type === 'button' && n.props.role === 'switch' && n.props.id === 'gate-rule-' + id + '-switch')
  assert.equal(switchOf('secret', user).props['aria-checked'], false, '合并后停用的规则，开关必须是关的')
  assert.equal(switchOf('abs-path', user).props['aria-checked'], true, '没停用的规则照常是开')
  const text = gateText(user)
  assert.ok(text.includes('本层已停用'), '要说明这条是本层停用的：' + text.slice(0, 240))
  assert.ok(!text.includes('关掉只是本层不覆盖'), '不许再说「关掉只是本层不覆盖」')
  assert.ok(!text.includes('关掉一条只表示本层不覆盖'), '底部说明也不许说「关掉只表示不覆盖」')
  assert.ok(!text.includes('上层同名规则照旧生效'), '不许再说上层同名规则照旧生效')
  assert.ok(text.includes('规则 1 / 2'), '规则计数按合并后的开关算：' + text.slice(0, 240))

  const readOnly = walk(render(desk, gateQueue({ scope: 'default', data: payload })))
  const readOnlySecret = switchOf('secret', readOnly)
  assert.equal(readOnlySecret.props['aria-checked'], false, '默认层只读，但状态照合并结果显示')
  assert.equal(readOnlySecret.props.disabled, true, '默认层仍然不可点')
  assert.ok(gateText(readOnly).includes('已停用：这条规则不参与检查。'), '只读层要如实说停用')
})

test('门禁开关：只切开关也算改动，落盘只写这一条 enabled:false', async () => {
  const queue = gateQueue({
    scope: 'user',
    draft: gateDraft([{ ...GATE_SECRET_RULE, enabled: false }, { ...GATE_PATH_RULE, enabled: true }], GATE_SEMANTIC_DERIVED),
  })
  const { registrations, render } = loadClient()
  const desk = registrations.find((r) => r.opts.id === 'session-superagent-desk')
  const nodes = walk(render(desk, queue))
  assert.ok(gateText(nodes).includes('未保存'), '只切开关也要算「未保存」：' + gateText(nodes).slice(0, 240))
  const save = nodes.find((n) => n.type === 'button' && (n.props.children || []).join('') === '保存')
  assert.equal(save.props.disabled, false, '只切开关也要能点保存')

  const requests = []
  const panel = loadStatefulPanel({
    queue,
    fetch: (url, init = {}) => {
      requests.push({ url: String(url), init })
      if (init.method === 'POST') return Promise.resolve(raceResponse({ ok: true, scope: 'user', path: '/home/u/.dsh/state/session-superagent/gates.json', config: {} }))
      return Promise.resolve(raceResponse(gateApiPayload()))
    },
  })
  await panel.button('保存').props.onClick()
  const post = requests.find((item) => item.init.method === 'POST')
  const payload = JSON.parse(post.init.body)
  assert.deepEqual(payload.config.rules.map((rule) => rule.id), ['secret'], '只写这一条改过的规则')
  assert.equal(payload.config.rules[0].enabled, false)
})

test('门禁开关：重新打开写完整规则 + enabled:true', async () => {
  const disabledSecret = { ...GATE_SECRET_RULE, enabled: false }
  const data = gateApiWithLayer('user', [disabledSecret], [disabledSecret, GATE_PATH_RULE])
  const requests = []
  const panel = loadStatefulPanel({
    queue: gateQueue({ scope: 'user', data }),
    fetch: (url, init = {}) => {
      requests.push({ url: String(url), init })
      if (init.method === 'POST') return Promise.resolve(raceResponse({ ok: true, scope: 'user', path: '/home/u/.dsh/state/session-superagent/gates.json', config: {} }))
      return Promise.resolve(raceResponse(data))
    },
  })
  const switchOf = () => panel.nodes().find((n) => n.type === 'button' && n.props.id === 'gate-rule-secret-switch')
  assert.equal(switchOf().props['aria-checked'], false)
  switchOf().props.onClick()
  assert.equal(switchOf().props['aria-checked'], true, '点一下开关要真的打开')
  await panel.button('保存').props.onClick()
  const post = requests.find((item) => item.init.method === 'POST')
  const sent = JSON.parse(post.init.body).config.rules
  const secret = sent.find((rule) => rule.id === 'secret')
  assert.ok(secret, '复启要把完整规则写进本层')
  assert.equal(secret.enabled, true, '重新打开写 enabled:true')
  assert.equal(secret.type, 'regex', '不能只写 { id, enabled:true }：缺 type 会被判非法')
  assert.equal(secret.pattern, GATE_SECRET_RULE.pattern, '复启要写完整规则，不是空壳')
  assert.equal(sent.length, 1, '另一条没动过，不用写')
})

test('门禁保存：本层已有的覆盖不会被别的保存动作删掉', async () => {
  const base = gateApiPayload()
  const ownPath = { ...GATE_PATH_RULE, message: '本层自定义的提示' }
  const data = {
    ...base,
    config: { ...base.config, rules: [GATE_SECRET_RULE, ownPath] },
    scopes: { ...base.scopes, user: { path: base.scopes.user.path, exists: true, config: { name: 'user', rules: [ownPath] } } },
  }
  const requests = []
  const panel = loadStatefulPanel({
    queue: gateQueue({ scope: 'user', data }),
    fetch: (url, init = {}) => {
      requests.push({ url: String(url), init })
      if (init.method === 'POST') return Promise.resolve(raceResponse({ ok: true, scope: 'user', path: base.scopes.user.path, config: {} }))
      return Promise.resolve(raceResponse(data))
    },
  })
  panel.nodes().find((n) => n.type === 'button' && n.props.id === 'gate-rule-secret-switch').props.onClick()
  await panel.button('保存').props.onClick()
  const post = requests.find((item) => item.init.method === 'POST')
  const sent = JSON.parse(post.init.body).config.rules
  assert.deepEqual(sent.map((rule) => rule.id), ['abs-path', 'secret'], '本层原有规则 + 新停用的规则都要在')
  const kept = sent.find((rule) => rule.id === 'abs-path')
  assert.equal(kept.message, '本层自定义的提示', '没动过的本层覆盖不能被保存悄悄删掉')
  assert.equal(kept.enabled, true)
  assert.equal(sent.find((rule) => rule.id === 'secret').enabled, false)
})

test('门禁保存失败：说清原因，不报成功', async () => {
  const panel = loadStatefulPanel({
    queue: gateQueue({
      scope: 'user',
      draft: gateDraft([{ ...GATE_PATH_RULE, enabled: true, message: '改过的文案' }]),
    }),
    fetch: (url, init = {}) => {
      const parsed = new URL(String(url), 'http://fixture.local')
      if (parsed.pathname.endsWith('/gates') && init.method === 'POST') {
        return Promise.resolve(raceResponse({ ok: false, error: '规则 id 重复：secret' }, 400))
      }
      return Promise.resolve(raceResponse(gateApiPayload()))
    },
  })
  await panel.button('保存').props.onClick()
  const nodes = panel.nodes()
  assert.ok(nodes.some((node) => node.props && node.props.role === 'alert' && /保存失败：规则 id 重复/.test(a11yText(node))),
    '保存失败要有 alert，文案以「保存失败」开头并说明原因')
  assert.ok(!nodes.some((node) => node.props && node.props.role === 'status' && /已保存/.test(String(node.props.children))),
    '失败不能报成功')
})

test('门禁预览：请求带触发/正文/语义开关，命中与通过都有明确结果', async () => {
  const requests = []
  const panel = loadStatefulPanel({
    queue: gateQueue({
      scope: 'user',
      sample: '这里有 ghp_abcdefghijklmnopqrstuvwxyz0123',
      trigger: 'merge',
      draft: gateDraft(),
    }),
    fetch: (url, init = {}) => {
      requests.push({ url: String(url), init })
      const parsed = new URL(String(url), 'http://fixture.local')
      if (parsed.pathname.endsWith('/gates/preview')) {
        return Promise.resolve(raceResponse({
          ok: false,
          trigger: 'merge',
          hits: [{ id: 'secret', label: '禁止凭证与密钥', severity: 'error', message: '删掉凭证；需要引用时写 <redacted>。' }],
          semantic: { skipped: true },
        }))
      }
      return Promise.resolve(raceResponse(gateApiPayload()))
    },
  })
  await panel.button('预览').props.onClick()
  const post = requests.find((item) => item.url.includes('/gates/preview'))
  assert.ok(post, '必须真的调 /gates/preview')
  const payload = JSON.parse(post.init.body)
  assert.equal(payload.trigger, 'merge')
  assert.equal(payload.body, '这里有 ghp_abcdefghijklmnopqrstuvwxyz0123', '正文要原样带上')
  assert.equal(payload.semantic, true, '合并 + 开着语义复审时要把开关带上')
  assert.ok(gateText(panel.nodes()).includes('命中 1 条'), '命中要给出条数：' + gateText(panel.nodes()).slice(0, 200))

  const passed = loadStatefulPanel({
    queue: gateQueue({ scope: 'user', preview: { ok: true, hits: [], semantic: { skipped: true } } }),
    fetch: () => Promise.resolve(raceResponse(gateApiPayload())),
  })
  assert.ok(gateText(passed.nodes()).includes('通过：没有阻断项'), '没命中要说通过')

  const failed = loadStatefulPanel({
    queue: gateQueue({ scope: 'user', preview: { ok: false, hits: [], failed: 'HTTP 500' } }),
    fetch: () => Promise.resolve(raceResponse(gateApiPayload())),
  })
  assert.ok(failed.nodes().some((node) => node.props && node.props.role === 'alert' && /预览失败/.test(a11yText(node))),
    '预览失败要有 alert')
})

test('门禁「优化提示词」：成功写回输入框，失败给错误', async () => {
  const requests = []
  const okPanel = loadStatefulPanel({
    queue: gateQueue({ scope: 'user', draft: gateDraft(null, { enabled: true, model: 'm-1', prompt: '旧提示词', off: false }) }),
    fetch: (url, init = {}) => {
      requests.push({ url: String(url), init })
      const parsed = new URL(String(url), 'http://fixture.local')
      if (parsed.pathname.endsWith('/gates/optimize')) return Promise.resolve(raceResponse({ ok: true, text: '更清楚的提示词' }))
      return Promise.resolve(raceResponse(gateApiPayload()))
    },
  })
  await okPanel.button('优化提示词').props.onClick()
  const post = requests.find((item) => item.url.includes('/gates/optimize'))
  assert.ok(post, '必须真的调 /gates/optimize')
  assert.deepEqual(JSON.parse(post.init.body), { repo: 'E:/work/demo', prompt: '旧提示词', model: 'm-1' })
  const area = okPanel.nodes().find((node) => node.type === 'textarea' && node.props.id === 'gate-semantic-prompt')
  assert.equal(area.props.value, '更清楚的提示词', '成功要把新提示词写回输入框')
  assert.ok(gateText(okPanel.nodes()).includes('提示词已更新'), '成功要有回执')

  const badPanel = loadStatefulPanel({
    queue: gateQueue({ scope: 'user', draft: gateDraft() }),
    fetch: (url) => {
      const parsed = new URL(String(url), 'http://fixture.local')
      if (parsed.pathname.endsWith('/gates/optimize')) {
        return Promise.resolve(raceResponse({ ok: false, error: '提示词润色失败：HTTP 502' }, 502))
      }
      return Promise.resolve(raceResponse(gateApiPayload()))
    },
  })
  await badPanel.button('优化提示词').props.onClick()
  assert.ok(badPanel.nodes().some((node) => node.props && node.props.role === 'alert' && /提示词润色失败/.test(a11yText(node))),
    '优化失败要有 alert')
})

test('门禁模型下拉：列表来自 /gates/models，当前值不会丢', () => {
  const { registrations, render } = loadClient()
  const desk = registrations.find((r) => r.opts.id === 'session-superagent-desk')
  const nodes = walk(render(desk, gateQueue({
    scope: 'user',
    models: { list: [{ id: 'gpt-x', label: 'GPT X' }], loading: false, error: '' },
    draft: gateDraft(null, { enabled: true, model: 'old-model', prompt: 'p', off: false }),
  })))
  const select = nodes.find((n) => n.type === 'select' && n.props.id === 'gate-semantic-model')
  assert.ok(select, '要有模型下拉')
  assert.deepEqual((select.props.children || []).map((option) => option.props.value), ['old-model', 'gpt-x'],
    '当前值排第一，网关列表跟在后面')
  assert.equal(select.props.disabled, false, '我的层可以换模型')

  const empty = walk(render(desk, gateQueue({ scope: 'user', draft: gateDraft(null, { enabled: true, model: '', prompt: 'p', off: false }) })))
  const emptySelect = empty.find((n) => n.type === 'select' && n.props.id === 'gate-semantic-model')
  assert.deepEqual((emptySelect.props.children || []).map((option) => option.props.value), [''],
    '取不到模型时也要有一个可显示的项')
  assert.ok(gateText(empty).includes('读取模型列表'), '要有重新读取的入口')
})

// ── U2（Q1-F2 / F3 / F7 修复）─────────────────────────────────────────────────
// 这三个缺口都是「保存一次就把本层其它配置整层冲掉」：composite 配置里有 semantic / extends
// 时，面板只改一条规则也会连带丢掉它们。下面用**真实 gate 包**做落盘 + 四层合并 + 模型边界，
// 不只断言 POST 形状。

/** 用真实 gate 包读一个仓库，构造 GET /gates 的响应（scopes 是服务端 readGateScope 的原始形状）。 */
const realGateData = (repo, env) => {
  const loaded = loadGateConfig({ repo, env })
  const scopes = {}
  for (const name of ['default', 'user', 'project', 'local']) {
    const value = readGateScope(name, { repo, env })
    scopes[name] = { path: value.path, exists: Boolean(value.config), config: value.config }
  }
  return { ok: true, repo, sources: loaded.sources, config: loaded.config, scopes }
}

test('门禁保存：本层 semantic 原样写回，保存后重读仍生效（Q1-F2 A）', async () => {
  const repo = tempDir('gate-u2-semantic-user-')
  const env = { ...process.env, DSH_GATE_USER_CONFIG: join(repo, '.superagent', 'user-gates.json') }
  mkdirSync(join(repo, '.superagent'), { recursive: true })
  writeGateConfig('user', {
    name: 'user',
    semantic: {
      enabled: true,
      baseURL: 'http://my-gateway.example/v1',
      model: 'my-model',
      mode: 'block',
      timeoutMs: 30000,
      maxInputChars: 20000,
      prompt: '我的审核提示词',
    },
    rules: [],
  }, { repo, env })
  const data = realGateData(repo, env)
  const rawUserSemantic = data.scopes.user.config.semantic
  assert.equal(rawUserSemantic.enabled, true, '前置：本层语义复审已开')
  const requests = []
  const panel = loadStatefulPanel({
    queue: gateQueue({ scope: 'user', data }),
    fetch: (url, init = {}) => {
      requests.push({ url: String(url), init })
      if (init.method === 'POST') return Promise.resolve(raceResponse({ ok: true, scope: 'user', path: data.scopes.user.path, config: {} }))
      return Promise.resolve(raceResponse(data))
    },
  })
  // 只切一条规则，不碰语义复审
  panel.nodes().find((n) => n.type === 'button' && n.props.id === 'gate-rule-secret-switch').props.onClick()
  await panel.button('保存').props.onClick()
  const post = requests.find((item) => item.init.method === 'POST')
  const sent = JSON.parse(post.init.body).config
  assert.deepEqual(sent.semantic, rawUserSemantic, '本层原有 semantic 必须原样写回（含面板不展示的 mode）')

  // 真实落盘 + 四层合并：语义复审与规则停用同时还在
  writeGateConfig('user', sent, { repo, env })
  const reread = loadGateConfig({ repo, env })
  assert.equal(reread.config.semantic.enabled, true, '保存后重读：语义复审仍然开启')
  assert.equal(reread.config.semantic.model, 'my-model', '模型没被冲掉')
  assert.equal(reread.config.semantic.mode, 'block', '面板不展示的 mode 也没被冲掉')
  assert.equal(reread.config.semantic.baseURL, 'http://my-gateway.example/v1', '自定义网关地址没被冲掉')
  assert.equal(reread.config.semantic.timeoutMs, 30000, '超时没被冲掉')
  assert.equal(reread.config.semantic.maxInputChars, 20000, '正文上限没被冲掉')
  assert.equal(reread.config.rules.find((rule) => rule.id === 'secret').enabled, false, '同一次保存里的规则停用也生效')

  // 模型请求边界：语义开着，merge 会请求 1 次（正对照证明计数器不是死的）
  const calls = []
  const gate = createGate({
    config: reread.config,
    semanticOptions: { fetchImpl: () => { calls.push(1); throw new Error('stub') } },
  })
  const result = await gate.check({ trigger: 'merge', text: '这次修复已完成并通过测试。' })
  assert.equal(calls.length, 1, '语义复审开着时 merge 会请求模型')
  assert.equal(result.semantic.skipped, false)
})

test('门禁保存：只改语义开关时，baseURL/mode/timeout 等未暴露字段不丢（Q2-F1 ③）', async () => {
  const repo = tempDir('gate-u2-semantic-fields-')
  const env = { ...process.env, DSH_GATE_USER_CONFIG: join(repo, 'user-gates.json') }
  writeGateConfig('user', {
    name: 'user',
    semantic: {
      enabled: false,
      baseURL: 'http://my-gateway.example/v1',
      model: 'my-model',
      mode: 'block',
      timeoutMs: 30000,
      maxInputChars: 20000,
      prompt: '我的提示词',
    },
    rules: [],
  }, { repo, env })
  const data = realGateData(repo, env)
  const rawSemantic = data.scopes.user.config.semantic
  const requests = []
  const panel = loadStatefulPanel({
    queue: gateQueue({ scope: 'user', data }),
    fetch: (url, init = {}) => {
      requests.push({ url: String(url), init })
      if (init.method === 'POST') return Promise.resolve(raceResponse({ ok: true, scope: 'user', path: data.scopes.user.path, config: {} }))
      return Promise.resolve(raceResponse(data))
    },
  })
  const toggle = panel.nodes().find((n) => n.type === 'button' && n.props.id === 'gate-semantic-enabled')
  assert.equal(toggle.props['aria-checked'], false, '前置：本层语义复审是关的')
  toggle.props.onClick()
  await panel.button('保存').props.onClick()
  const post = requests.find((item) => item.init.method === 'POST')
  const sent = JSON.parse(post.init.body).config
  assert.equal(sent.semantic.enabled, true, '面板改了开关')
  for (const key of ['baseURL', 'model', 'mode', 'timeoutMs', 'maxInputChars', 'prompt']) {
    assert.equal(sent.semantic[key], rawSemantic[key], '面板没展示的字段必须原样保留：' + key)
  }
  writeGateConfig('user', sent, { repo, env })
  const reread = loadGateConfig({ repo, env })
  assert.equal(reread.config.semantic.baseURL, 'http://my-gateway.example/v1', '重读后自定义网关仍在')
  assert.equal(reread.config.semantic.timeoutMs, 30000, '重读后超时仍在')
})

test('门禁保存：项目层 semantic:false 不因无关保存重新发模型（Q1-F2 B）', async () => {
  const repo = tempDir('gate-u2-semantic-project-')
  const env = { ...process.env, DSH_GATE_USER_CONFIG: join(repo, 'no-user.json') }
  mkdirSync(join(repo, '.superagent'), { recursive: true })
  // 「我的」层开着语义复审，项目层显式关掉 —— 项目层关掉才是真正生效的边界
  writeGateConfig('user', { name: 'user', semantic: { enabled: true, model: 'my-model' }, rules: [] }, { repo, env })
  const projectFile = join(repo, '.superagent', 'gates.json')
  writeFileSync(projectFile, JSON.stringify({
    name: 'project',
    semantic: false,
    rules: [{ ...GATE_PATH_RULE, message: '项目层自己的提示' }],
  }))
  const data = realGateData(repo, env)
  assert.equal(data.scopes.user.config.semantic.enabled, true, '前置：我的层开着语义复审')
  assert.equal(data.config.semantic.enabled, false, '前置：项目层 semantic:false 覆盖了上层')

  const requests = []
  const panel = loadStatefulPanel({
    queue: gateQueue({ scope: 'project', data }),
    fetch: (url, init = {}) => {
      requests.push({ url: String(url), init })
      if (init.method === 'POST') return Promise.resolve(raceResponse({ ok: true, scope: 'project', path: data.scopes.project.path, config: {} }))
      return Promise.resolve(raceResponse(data))
    },
  })
  panel.nodes().find((n) => n.type === 'button' && n.props.id === 'gate-rule-secret-switch').props.onClick()
  await panel.button('保存').props.onClick()
  const post = requests.find((item) => item.init.method === 'POST')
  const sent = JSON.parse(post.init.body).config
  assert.equal(sent.semantic, false, '项目层原有 semantic:false 必须原样写回，不能因为只改规则就丢掉')

  writeGateConfig('project', sent, { repo, env })
  const reread = loadGateConfig({ repo, env })
  assert.equal(reread.config.semantic.enabled, false, '保存后重读：项目层仍然关闭语义复审')
  assert.equal(reread.config.rules.find((rule) => rule.id === 'secret').enabled, false, '同一次保存的规则改动也生效')

  // 模型请求边界：项目层关着 → merge 不得请求模型；正对照证明同一计数器能数到 1
  const calls = []
  const gate = createGate({
    config: reread.config,
    semanticOptions: { fetchImpl: () => { calls.push(1); throw new Error('不应请求模型') } },
  })
  const result = await gate.check({ trigger: 'merge', text: '这次修复已完成并通过测试。' })
  assert.equal(calls.length, 0, '项目层关了语义复审：merge 不得请求模型')
  assert.equal(result.semantic.skipped, true)
  const positive = createGate({
    config: { rules: [], semantic: { enabled: true, baseURL: 'http://stub.local', model: 'm' } },
    semanticOptions: { fetchImpl: () => { calls.push(1); throw new Error('stub') } },
  })
  await positive.check({ trigger: 'merge', text: '这次修复已完成并通过测试。' })
  assert.equal(calls.length, 1, '正对照：语义开启时确实会请求模型')
})

test('门禁保存：本层有 extends 时拒绝保存，共享规则不会消失（Q1-F3）', async () => {
  const repo = tempDir('gate-u2-extends-')
  const env = { ...process.env, DSH_GATE_USER_CONFIG: join(repo, 'no-user.json') }
  mkdirSync(join(repo, '.superagent'), { recursive: true })
  writeFileSync(join(repo, '.superagent', 'shared.json'), JSON.stringify({
    version: 1,
    name: 'shared',
    rules: [GATE_SECRET_RULE, GATE_PATH_RULE],
  }))
  const projOnly = {
    id: 'proj-only', label: '项目独有规则', description: '只在这个仓库生效。', severity: 'warn',
    triggers: ['issue.reply'], type: 'contains', value: '发布', message: '先别发布。',
  }
  const projectFile = join(repo, '.superagent', 'gates.json')
  writeFileSync(projectFile, JSON.stringify({ name: 'project', extends: './shared.json', rules: [projOnly] }))
  const data = realGateData(repo, env)
  assert.equal(data.scopes.project.config.extends, './shared.json', '前置：项目层确实写了 extends')
  assert.ok(data.config.rules.some((rule) => rule.id === 'secret'), '前置：extends 基文件里的共享规则已合并')

  const requests = []
  const panel = loadStatefulPanel({
    queue: gateQueue({ scope: 'project', data }),
    fetch: (url, init = {}) => {
      requests.push({ url: String(url), init })
      return Promise.resolve(raceResponse(data))
    },
  })
  panel.nodes().find((n) => n.type === 'button' && n.props.id === 'gate-rule-secret-switch').props.onClick()
  const save = panel.button('保存')
  assert.equal(save.props.disabled, true, '本层有 extends 时保存必须禁用')
  await save.props.onClick()
  assert.ok(!requests.some((item) => item.init.method === 'POST'), '不能 POST /gates 覆盖掉 extends')
  const nodes = panel.nodes()
  assert.ok(nodes.some((node) => node.props && node.props.role === 'alert' && /extends/.test(a11yText(node))),
    '要用 alert 说明为什么不能保存')
  assert.ok(/手改|直接改配置文件/.test(gateText(nodes)), '要给出下一步：手改配置文件')

  // 真实文件没被动过：extends 与共享规则都还在
  const reread = loadGateConfig({ repo, env })
  for (const id of ['secret', 'abs-path', 'proj-only']) {
    assert.ok(reread.config.rules.some((rule) => rule.id === id), '共享规则/项目规则不能消失：' + id)
  }
  assert.equal(JSON.parse(readFileSync(projectFile, 'utf8')).extends, './shared.json', '磁盘上的 extends 没被冲掉')
})

test('门禁停用：停用来自本地层时如实说明本地优先，不承诺一键恢复（Q1-F7）', () => {
  const base = gateApiPayload()
  const disabledSecret = { ...GATE_SECRET_RULE, enabled: false }
  const data = {
    ...base,
    config: { ...base.config, rules: [disabledSecret, GATE_PATH_RULE] },
    scopes: {
      ...base.scopes,
      local: { path: 'E:/work/demo/.superagent/gates.local.json', exists: true, config: { name: 'local', rules: [disabledSecret] } },
    },
  }
  const { registrations, render } = loadClient()
  const desk = registrations.find((r) => r.opts.id === 'session-superagent-desk')
  const nodes = walk(render(desk, gateQueue({ scope: 'user', data })))
  const secretSwitch = nodes.find((n) => n.type === 'button' && n.props.id === 'gate-rule-secret-switch')
  assert.equal(secretSwitch.props['aria-checked'], false, '合并后是停用')
  assert.equal(secretSwitch.props.disabled, true, '本地层优先级更高：面板开关不该假装能改')
  const text = gateText(nodes)
  assert.ok(text.includes('本地层'), '要点明是本地层停用的：' + text.slice(0, 260))
  assert.ok(text.includes('手改'), '要给出下一步：手改本地配置文件')
  assert.ok(!text.includes('把它恢复'), '不许承诺一键恢复（本地层优先级最高）')
  assert.ok(!text.includes('打开会写一条完整规则到本层'), '不许再说「写本层就能恢复」')
  const localTag = nodes.find((node) => node.type === 'span'
    && String(node.props && node.props.className || '').includes('dt-tag')
    && (node.props.children || []).join('') === '本地')
  assert.ok(localTag, '卡片上要有「本地」来源标签（否则看不出是谁停用的）')
})

test('门禁项目层：semantic:false 时底部文案与预览都用「当前关闭」（Q2-F3）', async () => {
  const base = gateApiPayload()
  const data = {
    ...base,
    // 合并值仍是被上层继承的 enabled:true，但项目层显式写了 false —— 两处渲染必须一致。
    config: { ...base.config, semantic: { ...base.config.semantic, enabled: true } },
    scopes: {
      ...base.scopes,
      project: { path: base.scopes.project.path, exists: true, config: { name: 'project', semantic: false, rules: [] } },
    },
  }
  const requests = []
  const panel = loadStatefulPanel({
    queue: gateQueue({ scope: 'project', data, trigger: 'merge', sample: '这次修复已完成并通过测试。' }),
    fetch: (url, init = {}) => {
      requests.push({ url: String(url), init })
      if (init.method === 'POST' && String(url).includes('/gates/preview')) {
        return Promise.resolve(raceResponse({ ok: true, trigger: 'merge', hits: [], semantic: { skipped: true } }))
      }
      return Promise.resolve(raceResponse(data))
    },
  })
  const nodes = panel.nodes()
  const offToggle = nodes.find((n) => n.type === 'button' && n.props.id === 'gate-semantic-off')
  assert.equal(offToggle.props['aria-checked'], true, '「在本项目关闭语义复审」是开的')
  const text = gateText(nodes)
  assert.ok(text.includes('当前关闭'), '底部必须说「当前关闭」：' + text.slice(-320))
  assert.ok(!text.includes('当前开启'), '不许同屏出现「当前开启」')
  await panel.button('预览').props.onClick()
  const post = requests.find((item) => item.url.includes('/gates/preview'))
  assert.ok(post, '要真的调预览')
  assert.equal(JSON.parse(post.init.body).semantic, false, '项目层已关闭时预览不得带 semantic:true')
  const previewText = gateText(panel.nodes())
  assert.ok(previewText.includes('这类触发支持语义复审（当前关闭）'), '预览区也要说清当前关闭：' + previewText.slice(-240))
  assert.ok(!previewText.includes('这类触发会追加语义复审'), '已关闭时不许说「会追加语义复审」')

  // 正对照：语义开着时预览区仍然如实说「会追加」。
  const { registrations, render } = loadClient()
  const desk = registrations.find((r) => r.opts.id === 'session-superagent-desk')
  const enabledNodes = walk(render(desk, gateQueue({ scope: 'user', trigger: 'merge', draft: gateDraft() })))
  assert.ok(gateText(enabledNodes).includes('这类触发会追加语义复审'), '语义开着时预览区要说会追加')
})

// ── U1（v3）：面板语义 / extends false / dirty 切换 ───────────────────────────────
// 三条都是「面板显示的值和真正会写盘的东西不一致」：用户层 semantic:false 时开关亮着、
// extends:false 被当成共享规则拒绝保存、有草稿时切作用域/仓库直接清空草稿。

test('门禁用户层 semantic:false：开关 / 底部 / 预览三处一致显示关闭（U1-A）', async () => {
  const base = gateApiPayload()
  // 四层合并结果仍是被上层继承的 enabled:true，但「我的」这一层显式写了 semantic:false。
  const data = {
    ...base,
    config: { ...base.config, semantic: { ...base.config.semantic, enabled: true } },
    scopes: {
      ...base.scopes,
      user: { path: base.scopes.user.path, exists: true, config: { name: 'user', semantic: false, rules: [] } },
    },
  }
  const requests = []
  const panel = loadStatefulPanel({
    queue: gateQueue({ scope: 'user', data, trigger: 'merge', sample: '这次修复已完成并通过测试。' }),
    fetch: (url, init = {}) => {
      requests.push({ url: String(url), init })
      if (init.method === 'POST' && String(url).includes('/gates/preview')) {
        return Promise.resolve(raceResponse({ ok: true, trigger: 'merge', hits: [], semantic: { skipped: true } }))
      }
      return Promise.resolve(raceResponse(data))
    },
  })
  const toggle = panel.nodes().find((node) => node.type === 'button' && node.props.id === 'gate-semantic-enabled')
  assert.equal(toggle.props['aria-checked'], false, '本层写了 semantic:false：开关必须是关的')
  const text = gateText(panel.nodes())
  assert.ok(text.includes('当前关闭'), '底部必须说「当前关闭」：' + text.slice(-320))
  assert.ok(!text.includes('当前开启'), '同一屏里不许出现「当前开启」')
  await panel.button('预览').props.onClick()
  const previewPost = requests.find((item) => item.url.includes('/gates/preview'))
  assert.ok(previewPost, '要真的调预览')
  assert.equal(JSON.parse(previewPost.init.body).semantic, false, '本层已关闭时预览不得请求语义复审')
  assert.ok(gateText(panel.nodes()).includes('这类触发支持语义复审（当前关闭）'),
    '预览区也要说清当前关闭：' + gateText(panel.nodes()).slice(-240))

  // 反向正对照：把开关打开后必须真的能写掉 semantic:false（不是只能看不能改）。
  const saved = []
  const savePanel = loadStatefulPanel({
    queue: gateQueue({ scope: 'user', data }),
    fetch: (url, init = {}) => {
      saved.push({ url: String(url), init })
      if (init.method === 'POST') return Promise.resolve(raceResponse({ ok: true, scope: 'user', path: data.scopes.user.path, config: {} }))
      return Promise.resolve(raceResponse(data))
    },
  })
  savePanel.nodes().find((node) => node.type === 'button' && node.props.id === 'gate-semantic-enabled').props.onClick()
  assert.equal(savePanel.nodes().find((node) => node.type === 'button' && node.props.id === 'gate-semantic-enabled').props['aria-checked'],
    true, '打开开关后必须显示为开')
  await savePanel.button('保存').props.onClick()
  const savePost = saved.find((item) => item.init.method === 'POST')
  assert.ok(savePost, '打开开关后要能保存')
  const sentSemantic = JSON.parse(savePost.init.body).config.semantic
  assert.equal(sentSemantic.enabled, true, '保存要真的把 semantic:false 换成 enabled:true')
  assert.equal(sentSemantic.model, base.config.semantic.model, '打开始终保留继承来的模型')
  assert.equal(sentSemantic.prompt, base.config.semantic.prompt, '打开始终保留继承来的提示词')
})

test('门禁 extends:false / "none" 可以保存，落盘原样写回（U1-B）', async () => {
  const projOnly = {
    id: 'proj-only', label: '项目独有规则', description: '只在这个仓库生效。', severity: 'warn',
    triggers: ['issue.reply'], type: 'contains', value: '发布', message: '先别发布。',
  }
  const payloadFor = (extendsValue) => {
    const base = gateApiPayload()
    return {
      ...base,
      config: { ...base.config, rules: [GATE_SECRET_RULE, GATE_PATH_RULE, projOnly] },
      scopes: {
        ...base.scopes,
        project: {
          path: base.scopes.project.path, exists: true,
          config: { name: 'project', extends: extendsValue, rules: [projOnly] },
        },
      },
    }
  }

  for (const value of ['none', false]) {
    const data = payloadFor(value)
    const requests = []
    const panel = loadStatefulPanel({
      queue: gateQueue({ scope: 'project', data }),
      fetch: (url, init = {}) => {
        requests.push({ url: String(url), init })
        if (init.method === 'POST') {
          return Promise.resolve(raceResponse({ ok: true, scope: 'project', path: data.scopes.project.path, config: {} }))
        }
        return Promise.resolve(raceResponse(data))
      },
    })
    // 先改一条规则造出 dirty：这样「保存禁用」只可能来自 extends 判定，而不是「没有改动」。
    panel.nodes().find((node) => node.type === 'button' && node.props.id === 'gate-rule-secret-switch').props.onClick()
    const save = panel.button('保存')
    assert.equal(save.props.disabled, false, 'extends:' + String(value) + ' 不是共享规则：必须能保存')
    const text = gateText(panel.nodes())
    assert.ok(!text.includes('共享规则'), '不能把 extends:' + String(value) + ' 说成共享规则：' + text.slice(-320))
    assert.ok(text.includes('原样写回'), '要说明这一项会被原样保留：' + text.slice(-320))
    await save.props.onClick()
    const post = requests.find((item) => item.init.method === 'POST')
    assert.ok(post, 'extends:' + String(value) + ' 必须真的 POST /gates')
    assert.equal(JSON.parse(post.init.body).config.extends, value,
      'extends:' + String(value) + ' 必须原样写回（否则 replace 语义会变回 merge）')

    // 真落盘：面板 POST 的形状交给真实 gate 包（服务端那条链路），extends 与 replace 语义都还在。
    const repo = tempDir('gate-u1-extends-' + String(value) + '-')
    const env = { ...process.env, DSH_GATE_USER_CONFIG: join(repo, 'no-user.json') }
    const checked = validateConfig(JSON.parse(post.init.body).config)
    assert.equal(checked.ok, true, '面板发出的配置要能通过服务端校验：' + String(value))
    writeGateConfig('project', checked.config, { repo, env })
    const disk = JSON.parse(readFileSync(join(repo, '.superagent', 'gates.json'), 'utf8'))
    assert.equal(disk.extends, value, '磁盘上 extends:' + String(value) + ' 还在')
    const reread = loadGateConfig({ repo, env })
    assert.equal(reread.config.rules.some((rule) => rule.id === 'abs-path'), false,
      'extends:' + String(value) + ' 的 replace 语义还在（默认层没被本层写过的规则不能重新合进来）')
  }
})

test('门禁 extends 共享形式（字符串 / 对象 / true）仍明确拒绝，错误点名形态与路径（U1-C）', async () => {
  const cases = [
    { value: './shared.json', text: 'extends:./shared.json' },
    { value: { rules: [GATE_SECRET_RULE] }, text: 'extends 内联对象' },
    { value: true, text: 'extends:true' },
  ]
  for (const item of cases) {
    const base = gateApiPayload()
    const data = {
      ...base,
      scopes: {
        ...base.scopes,
        project: { path: base.scopes.project.path, exists: true, config: { name: 'project', extends: item.value, rules: [] } },
      },
    }
    const requests = []
    const panel = loadStatefulPanel({
      queue: gateQueue({ scope: 'project', data }),
      fetch: (url, init = {}) => {
        requests.push({ url: String(url), init })
        return Promise.resolve(raceResponse(data))
      },
    })
    panel.nodes().find((node) => node.type === 'button' && node.props.id === 'gate-rule-secret-switch').props.onClick()
    assert.equal(panel.button('保存').props.disabled, true, '共享 extends 必须禁用保存：' + item.text)
    await panel.button('保存').props.onClick()
    assert.equal(requests.some((request) => request.init.method === 'POST'), false, '不能 POST 覆盖共享 extends：' + item.text)
    const alert = panel.nodes().find((node) => node.props && node.props.role === 'alert' && /extends/.test(a11yText(node)))
    assert.ok(alert, '要用 alert 说明为什么不能保存：' + item.text)
    const alertText = a11yText(alert)
    assert.ok(alertText.includes(item.text), '要点名 extends 的形态（' + item.text + '），实际：' + alertText)
    assert.ok(alertText.includes('E:/work/demo/.superagent/gates.json'), '要给出配置文件路径：' + alertText)
    assert.ok(/直接改配置文件|手改/.test(alertText), '要给出下一步：' + alertText)
  }
})

test('门禁 dirty 切作用域：先确认；取消保留草稿，确认才放弃（U1-D）', () => {
  const dirtyDraft = gateDraft(
    [{ ...GATE_SECRET_RULE, enabled: false }, { ...GATE_PATH_RULE, enabled: true }],
    GATE_SEMANTIC_DERIVED,
  )
  const { registrations, render, stateCalls, resetStateCalls } = loadClient()
  const desk = registrations.find((r) => r.opts.id === 'session-superagent-desk')

  // 没有草稿：保持原行为，直接切（正对照，防止「一律要确认」变成新的噪音）。
  const clean = walk(render(desk, gateQueue({ scope: 'user' })))
  const cleanRadios = clean.filter((node) => node.type === 'button' && node.props.role === 'radio')
  resetStateCalls()
  cleanRadios[2].props.onClick()
  assert.ok(stateCalls().some((call) => call.index === GATE_SLOT.scope && call.next === 'project'),
    '没有草稿时点「项目」要直接切过去')

  const dirty = walk(render(desk, gateQueue({ scope: 'user', draft: dirtyDraft })))
  const radios = dirty.filter((node) => node.type === 'button' && node.props.role === 'radio')
  resetStateCalls()
  radios[2].props.onClick()
  assert.equal(stateCalls().some((call) => call.index === GATE_SLOT.scope), false, '有草稿时不能直接切作用域')
  const pending = stateCalls().find((call) => call.index === GATE_SLOT.pendingSwitch)
  assert.ok(pending, '要挂一条「切换确认」状态（留在 GateSettings 里）')
  assert.equal(pending.next.type, 'scope')
  assert.equal(pending.next.next, 'project')

  // 确认层：说清会丢什么，并且两个动作都在。
  const pendingNodes = walk(render(desk, gateQueue({ scope: 'user', draft: dirtyDraft, pending: { type: 'scope', next: 'project' } })))
  const pendingText = gateText(pendingNodes)
  assert.ok(pendingText.includes('切到「项目」会丢掉这份草稿'), '要说清目标与后果：' + pendingText.slice(0, 320))
  const cancel = pendingNodes.find((node) => node.type === 'button' && (node.props.children || []).join('') === '取消')
  assert.ok(cancel, '确认层要有「取消」')
  resetStateCalls()
  cancel.props.onClick()
  assert.equal(stateCalls().some((call) => call.index === GATE_SLOT.draft), false, '取消不能清草稿')
  assert.ok(stateCalls().some((call) => call.index === GATE_SLOT.pendingSwitch && call.next === null),
    '取消只是关掉确认层')

  const discard = pendingNodes.find((node) => node.type === 'button' && (node.props.children || []).join('') === '放弃草稿并切换')
  assert.ok(discard, '确认层要有「放弃草稿并切换」')
  resetStateCalls()
  discard.props.onClick()
  assert.ok(stateCalls().some((call) => call.index === GATE_SLOT.scope && call.next === 'project'), '确认后才切到项目层')
  assert.ok(stateCalls().some((call) => call.index === GATE_SLOT.draft && call.next === null), '确认后才放弃草稿')
  assert.ok(stateCalls().some((call) => call.index === GATE_SLOT.pendingSwitch && call.next === null), '确认后关掉确认层')
})

test('门禁 dirty 切仓库：不静默丢草稿；写盘仍落到面板数据所属仓库（U1-E）', async () => {
  const dirtyDraft = gateDraft(
    [{ ...GATE_SECRET_RULE, enabled: false }, { ...GATE_PATH_RULE, enabled: true }],
    GATE_SEMANTIC_DERIVED,
  )
  // /state 把 watcher 的 workdir 换成 E:/work/other：GET /gates 回显的仍是 E:/work/demo。
  const moved = gateSnapshot()
  const snapshot = {
    ...moved,
    body: { ...moved.body, watchers: [watcher('a/b', { id: 'a/b#s1', workdir: 'E:/work/other' })] },
  }

  const requests = []
  const panel = loadStatefulPanel({
    queue: gateQueue({ scope: 'user', draft: dirtyDraft, snapshot }),
    fetch: (url, init = {}) => {
      requests.push({ url: String(url), init })
      if (init.method === 'POST') {
        return Promise.resolve(raceResponse({ ok: true, scope: 'user', path: '/home/u/.dsh/state/session-superagent/gates.json', config: {} }))
      }
      return Promise.resolve(raceResponse(gateApiPayload()))
    },
  })
  const text = gateText(panel.nodes())
  assert.ok(text.includes('E:/work/other'), '要说明仓库已经换了：' + text.slice(0, 320))
  assert.ok(text.includes('E:/work/demo'), '要说明当前面板还是哪个仓库：' + text.slice(0, 320))
  // 草稿还属于旧仓库：保存必须写旧仓库，不能拿新仓库的路径去覆盖
  await panel.button('保存').props.onClick()
  const post = requests.find((item) => item.init.method === 'POST')
  assert.ok(post, '有草稿时保存要真的 POST')
  assert.equal(JSON.parse(post.init.body).repo, 'E:/work/demo',
    '写盘必须落在面板数据所属仓库，不能写到刚切过去的仓库')

  // 取消保留草稿；只有确认放弃才去读新仓库。
  const requests2 = []
  const panel2 = loadStatefulPanel({
    queue: gateQueue({ scope: 'user', draft: dirtyDraft, snapshot }),
    fetch: (url, init = {}) => {
      requests2.push({ url: String(url), init })
      return Promise.resolve(raceResponse(gateApiPayload()))
    },
  })
  const cancel = panel2.nodes().find((node) => node.type === 'button' && (node.props.children || []).join('') === '取消')
  assert.ok(cancel, '仓库切换也要先确认')
  cancel.props.onClick()
  const kept = panel2.nodes()
  assert.ok(gateText(kept).includes('已保留草稿'), '取消后要说清草稿还在：' + gateText(kept).slice(0, 360))
  assert.equal(kept.find((node) => node.type === 'button' && node.props.id === 'gate-rule-secret-switch').props['aria-checked'],
    false, '取消后草稿原样保留（那条规则还是关的）')
  assert.equal(requests2.some((item) => item.url.includes('other')), false, '取消不能去读新仓库（读了就等于把草稿丢掉）')
  const discard = kept.find((node) => node.type === 'button' && (node.props.children || []).join('') === '放弃草稿并切换')
  assert.ok(discard, '保留草稿后仍然要能选择切过去')
  await discard.props.onClick()
  assert.ok(requests2.some((item) => item.url.includes('/gates') && item.url.includes('other')),
    '确认放弃后才去读新仓库')

  // 两个确认互不吞：取消一次作用域切换后，之前「换仓库 → 保留草稿」的决定不能被抹掉。
  const { registrations, render } = loadClient()
  const desk = registrations.find((r) => r.opts.id === 'session-superagent-desk')
  const both = walk(render(desk, gateQueue({
    scope: 'user', draft: dirtyDraft, snapshot,
    pending: { type: 'scope', next: 'project', repoHeld: true },
  })))
  const bothText = gateText(both)
  assert.ok(bothText.includes('已保留草稿'), '换仓库保留草稿的决定还在：' + bothText.slice(0, 360))
  assert.ok(bothText.includes('切到「项目」会丢掉这份草稿'), '作用域确认也要在')
  assert.equal(bothText.includes('仓库已切换到'), false, '已经选择保留草稿，就不该再挂一条仓库确认')
})

test('门禁：状态只留在 GateSettings（主面板 23 + 门禁 12 = 35 槽，多一个都要抛）（U1-F）', () => {
  const { registrations, render } = loadClient()
  const desk = registrations.find((r) => r.opts.id === 'session-superagent-desk')
  assert.equal(deskQueue(gateSnapshot()).length, 23, '主面板仍然只有 23 个状态槽')
  assert.equal(gateQueue().length, 35, '门禁页 fixture = 主面板 23 + GateSettings 12')
  // 多传一个槽必须被抓出来：这条同时把「组件准确用了 35 个 hook」变成断言
  assert.throws(() => walk(render(desk, [...gateQueue({ scope: 'user' }), null])), /组件用了 35 个/,
    '多一个槽也要抛：位置化队列必须严格对齐（主面板不许悄悄加槽）')
  const nodes = walk(render(desk, gateQueue({ scope: 'user' })))
  assert.ok(gateText(nodes).includes('禁止凭证与密钥'), '槽位对齐下门禁页要完整渲染')
})

// ── U1：门禁 load 的异步竞态 ────────────────────────────────────────────────
// 通用桩的 useEffect 是空实现、hook 槽位也不持久 —— 量不出「在途 / 乱序 / 卸载」。
// 这里用 fixtures/gate-panel.mjs：跑真实 client.js，但状态槽持久、effect 按依赖触发、
// setState 真的重渲染；fetch 由用例决定什么时候 resolve，才能把响应排成乱序。
const gateRaceFetch = () => {
  const requests = []
  const pending = []
  const fetchStub = (url, init = {}) => {
    const text = String(url)
    requests.push({ url: text, init })
    // client.js 装载时会发 client-note 心跳：不是门禁请求，直接给成功。
    if (!text.includes('/gates')) return Promise.resolve(gateResponse({ ok: true }))
    if (text.includes('/gates/models')) return Promise.resolve(gateResponse({ ok: true, models: [] }))
    if (text.includes('/gates/preview')) return Promise.resolve(gateResponse({ ok: true, hits: [], semantic: { skipped: true } }))
    if (text.includes('/gates/optimize')) return Promise.resolve(gateResponse({ ok: true, text: '优化后的提示词' }))
    if (String(init.method || 'GET').toUpperCase() === 'POST') {
      return Promise.resolve(gateResponse({ ok: true, scope: 'user', path: '/home/u/.dsh/state/session-superagent/gates.json', config: {} }))
    }
    const deferred = gateDeferred()
    pending.push({ url: text, deferred })
    return deferred.promise
  }
  return {
    fetch: fetchStub,
    requests,
    pending,
  }
}

test('门禁 load 乱序：后到的旧仓库响应不能覆盖新仓库（U1-G1）', async () => {
  const api = gateRaceFetch()
  const panel = loadGatePanel({ repo: 'E:/work/demo', fetch: api.fetch })
  assert.equal(api.pending.length, 1, '首次挂载要读一次 /gates')
  assert.equal(gateUrlRepo(api.pending[0].url), 'E:/work/demo', '读的是当前仓库')

  // /state 后到把仓库换成 other：还没确认草稿（没有草稿），就要去读新仓库。
  panel.setRepo('E:/work/other')
  assert.equal(api.pending.length, 2, '换仓库要再读一次')
  assert.equal(gateUrlRepo(api.pending[1].url), 'E:/work/other')

  // 新仓库先回。
  api.pending[1].deferred.resolve(gateResponse(gatePayload('E:/work/other', { prompt: 'other 提示词' })))
  await panel.settle()
  assert.equal(panel.control('gate-semantic-prompt').props.value, 'other 提示词')

  // 旧仓库后回：它属于被顶掉的那次请求，不能把新仓库的数据覆盖回去。
  api.pending[0].deferred.resolve(gateResponse(gatePayload('E:/work/demo', { prompt: 'demo 提示词' })))
  await panel.settle()
  assert.equal(panel.control('gate-semantic-prompt').props.value, 'other 提示词', '旧响应不能覆盖新仓库数据')
  assert.equal(panel.text().includes('demo 提示词'), false, '旧仓库的配置不能再出现在面板上')
})

test('门禁 load 在途 dirty：切仓库的响应不能清掉新草稿（U1-G2）', async () => {
  const api = gateRaceFetch()
  const panel = loadGatePanel({ repo: 'E:/work/demo', fetch: api.fetch })
  api.pending[0].deferred.resolve(gateResponse(gatePayload('E:/work/demo', { prompt: 'demo 提示词' })))
  await panel.settle()

  // 切到 other 的请求在途时，用户改了这份草稿。
  panel.setRepo('E:/work/other')
  assert.equal(api.pending.length, 2, '干净的草稿不拦换仓库（先读新仓库）')
  panel.control('gate-semantic-prompt').props.onChange({ target: { value: '手工改的提示词' } })
  panel.flush()
  assert.ok(panel.text().includes('未保存'), '改过草稿后要显示未保存')

  api.pending[1].deferred.resolve(gateResponse(gatePayload('E:/work/other', { prompt: 'other 提示词' })))
  await panel.settle()
  assert.equal(panel.control('gate-semantic-prompt').props.value, '手工改的提示词', '在途 dirty 不能被响应清掉')
  assert.ok(panel.text().includes('未保存'), '草稿还是未保存状态')
})

test('门禁 load 序号：同一仓库两次读取乱序，先发的后到也不能覆盖（U1-G3）', async () => {
  const api = gateRaceFetch()
  const panel = loadGatePanel({ repo: 'E:/work/demo', fetch: api.fetch })
  api.pending[0].deferred.resolve(gateResponse({ error: '第一次读取失败' }, 500))
  await panel.settle()
  assert.ok(panel.text().includes('第一次读取失败'), '首次读取失败要能看见')

  // 同一帧点两次「重新读取」：两次请求在飞，仓库没变，只能靠序号分辨新旧。
  const retry = panel.button('重新读取')
  retry.props.onClick()
  retry.props.onClick()
  panel.flush()
  assert.equal(api.pending.length, 3, '两次重试 = 两次新请求')

  api.pending[2].deferred.resolve(gateResponse(gatePayload('E:/work/demo', { prompt: '第二次读取' })))
  await panel.settle()
  assert.equal(panel.control('gate-semantic-prompt').props.value, '第二次读取')

  api.pending[1].deferred.resolve(gateResponse(gatePayload('E:/work/demo', { prompt: '第一次读取' })))
  await panel.settle()
  assert.equal(panel.control('gate-semantic-prompt').props.value, '第二次读取', '旧请求后到不能覆盖新结果')
  assert.equal(panel.text().includes('第一次读取'), false)
})

test('门禁切仓库：取消不发请求并保留草稿，确认后才读新仓库（U1-G4）', async () => {
  const api = gateRaceFetch()
  const panel = loadGatePanel({ repo: 'E:/work/demo', fetch: api.fetch })
  api.pending[0].deferred.resolve(gateResponse(gatePayload('E:/work/demo', { prompt: 'demo 提示词' })))
  await panel.settle()
  panel.control('gate-semantic-prompt').props.onChange({ target: { value: '草稿提示词' } })
  panel.flush()

  panel.setRepo('E:/work/other')
  assert.equal(api.pending.length, 1, '有草稿时不能偷偷去读新仓库')
  panel.button('取消').props.onClick()
  panel.flush()
  assert.ok(panel.text().includes('已保留草稿'), '取消后要说清草稿还在')
  assert.equal(api.pending.length, 1, '取消不能发请求')
  assert.equal(panel.control('gate-semantic-prompt').props.value, '草稿提示词')

  panel.button('放弃草稿并切换').props.onClick()
  panel.flush()
  const switched = api.pending.slice(1)
  assert.ok(switched.length >= 1, '确认后才去读新仓库')
  assert.deepEqual(switched.map((item) => gateUrlRepo(item.url)), switched.map(() => 'E:/work/other'))
  // 确认放弃后草稿清空，[dirty] effect 会再补一次读取（旧行为：两条都读新仓库），两条都回同一份数据。
  for (const item of switched) item.deferred.resolve(gateResponse(gatePayload('E:/work/other', { prompt: 'other 提示词' })))
  await panel.settle()
  assert.equal(panel.control('gate-semantic-prompt').props.value, 'other 提示词')
  assert.equal(panel.text().includes('已保留草稿'), false, '确认切过去之后不能再挂保留草稿的提示')
})

test('门禁取消换仓库：已在途的新仓库响应也不能把数据切走（U1-G4b）', async () => {
  const api = gateRaceFetch()
  const panel = loadGatePanel({ repo: 'E:/work/demo', fetch: api.fetch })
  api.pending[0].deferred.resolve(gateResponse(gatePayload('E:/work/demo', { prompt: 'demo 提示词' })))
  await panel.settle()

  // 干净时换仓库 → 新仓库的读取已经发出去了；随后用户改出草稿并点「取消」。
  panel.setRepo('E:/work/other')
  assert.equal(api.pending.length, 2, '干净换仓库会先读新仓库')
  panel.control('gate-semantic-prompt').props.onChange({ target: { value: '草稿提示词' } })
  panel.flush()
  panel.button('取消').props.onClick()
  panel.flush()

  // 请求已经在飞：晚到的响应不能把数据切到新仓库（否则「已保留草稿」的承诺是假的）。
  api.pending[1].deferred.resolve(gateResponse(gatePayload('E:/work/other', { prompt: 'other 提示词' })))
  await panel.settle()
  assert.equal(panel.control('gate-semantic-prompt').props.value, '草稿提示词')
  assert.ok(panel.text().includes('已保留草稿'), '取消后仍然要显示保留草稿的提示')
  assert.equal(panel.text().includes('other 提示词'), false, '取消后不能再把数据切到新仓库')
})

test('门禁保存/预览/优化：目标仓库用 GET 回显的 data.repo（U1-G5）', async () => {
  const api = gateRaceFetch()
  const panel = loadGatePanel({ repo: 'E:/work/demo', fetch: api.fetch })
  api.pending[0].deferred.resolve(gateResponse(gatePayload('E:/work/demo', { prompt: 'demo 提示词' })))
  await panel.settle()

  // /state 换成 other，但草稿还在：面板数据仍属于 demo，三个写操作都必须落在 demo。
  panel.control('gate-semantic-prompt').props.onChange({ target: { value: '草稿提示词' } })
  panel.flush()
  panel.setRepo('E:/work/other')
  assert.equal(api.pending.length, 1, '有草稿时先不换数据')

  await panel.button('预览').props.onClick()
  panel.flush()
  const preview = api.requests.find((item) => item.url.includes('/gates/preview'))
  assert.equal(JSON.parse(preview.init.body).repo, 'E:/work/demo', '预览要用面板数据所属仓库')

  await panel.button('优化提示词').props.onClick()
  panel.flush()
  const optimize = api.requests.find((item) => item.url.includes('/gates/optimize'))
  assert.equal(JSON.parse(optimize.init.body).repo, 'E:/work/demo', '优化提示词要用面板数据所属仓库')

  const saving = panel.button('保存').props.onClick()
  panel.flush()
  const post = api.requests.find((item) => item.url.includes('/gates') && String(item.init.method || '').toUpperCase() === 'POST')
  assert.ok(post, '保存要真的 POST /gates')
  assert.equal(JSON.parse(post.init.body).repo, 'E:/work/demo', '保存要写面板数据所属仓库')

  // 保存成功后 load 按当前 repo（other）重读，才真正切过去。
  // 草稿清空后 [dirty] effect 还会补一次读取（旧行为），两条都回同一份数据，只有最后一条算数。
  await panel.settle(2)
  const reloads = api.pending.filter((item) => gateUrlRepo(item.url) === 'E:/work/other')
  assert.ok(reloads.length >= 1, '保存成功后要按当前 repo 重读')
  for (const item of reloads) item.deferred.resolve(gateResponse(gatePayload('E:/work/other', { prompt: 'other 提示词' })))
  await panel.settle()
  await saving
  assert.equal(panel.control('gate-semantic-prompt').props.value, 'other 提示词')
})

test('门禁 load 卸载后响应不再改状态（U1-G6）', async () => {
  const api = gateRaceFetch()
  const panel = loadGatePanel({ repo: 'E:/work/demo', fetch: api.fetch })
  assert.equal(api.pending.length, 1, '挂载时读取在途')
  panel.unmount()
  api.pending[0].deferred.resolve(gateResponse(gatePayload('E:/work/demo', { prompt: '迟到的响应' })))
  await panel.settle()
  assert.deepEqual(panel.violations(), [], '卸载后不能再 setState（取消/序号要拦住）')
})

test('门禁作用域：接官方 SegmentedControl，缺导出回退也有方向键/Home/End/跳过 disabled（Q2-F4）', () => {
  const options = [
    { value: 'default', label: '默认（只读）' },
    { value: 'user', label: '我的', disabled: true },
    { value: 'project', label: '项目' },
  ]

  // 有官方导出：原样委托，id/options/value/label/disabled 全转发（缺导出才允许回退）。
  const host = loadFallbackA11y({ primitives: { SegmentedControl: 'host-segmented' } })
  const delegated = host.internals.SegmentedControl({
    id: 'gate-scope', options, value: 'default', label: '门禁作用域', disabled: true, onChange() {},
  })
  assert.equal(delegated.type, 'host-segmented', '有 primitives.SegmentedControl 时必须委托官方组件')
  assert.equal(delegated.props.id, 'gate-scope')
  assert.equal(delegated.props.value, 'default')
  assert.equal(delegated.props.label, '门禁作用域')
  assert.equal(delegated.props.disabled, true)
  assert.equal(delegated.props.options, options)

  // 缺导出：本地回退也要有官方同款键盘行为与 radios 语义。
  const fallback = loadFallbackA11y()
  const render = (value, extra = {}) => {
    const changes = []
    const focused = []
    const mounted = fallback.mount(fallback.internals.SegmentedControl, {
      id: 'gate-scope', options, value, label: '门禁作用域', onChange: (next) => changes.push(next), ...extra,
    })
    const nodes = mounted.render()
    const group = nodes.find((n) => n.props && n.props.role === 'radiogroup')
    const radios = nodes.filter((n) => n.props && n.props.role === 'radio')
    for (const radio of radios) radio.props.ref({ focus: () => focused.push(radio.props['aria-checked'] === true ? 'selected' : 'other') })
    return { changes, focused, group, radios, nodes }
  }
  const state = render('default')
  assert.ok(state.group, '回退要保留 radiogroup')
  assert.equal(state.group.props.id, 'gate-scope')
  assert.deepEqual(state.radios.map((n) => n.props['aria-checked']), [true, false, false])
  assert.ok(state.radios.every((n) => !('aria-selected' in n.props)), 'role=radio 不该带 aria-selected')
  assert.deepEqual(state.radios.map((n) => n.props.tabIndex), [0, -1, -1], 'roving tab stop：只有选中项进 Tab 序列')
  assert.equal(state.radios[1].props.disabled, true, 'disabled 选项保留 disabled 语义')
  const key = (group, name) => group.props.onKeyDown({ key: name, preventDefault() {} })
  key(state.group, 'ArrowRight')
  assert.deepEqual(state.changes, ['project'], '方向键必须跳过 disabled 项')
  assert.deepEqual(state.focused, ['other'], '焦点要跟到新选中项')
  assert.deepEqual(render('default').changes, [])
  const left = render('default')
  key(left.group, 'ArrowLeft')
  assert.deepEqual(left.changes, ['project'], '左方向键从第一项回绕到最后一项（跳过 disabled）')
  const home = render('project')
  key(home.group, 'Home')
  assert.deepEqual(home.changes, ['default'])
  const end = render('default')
  key(end.group, 'End')
  assert.deepEqual(end.changes, ['project'])
  const noop = render('default')
  key(noop.group, 'Escape')
  assert.deepEqual(noop.changes, [], '无关按键不改值')
  const blocked = render('default', { disabled: true })
  key(blocked.group, 'ArrowRight')
  assert.deepEqual(blocked.changes, [], '整体 disabled 时键盘不生效')
  assert.ok(blocked.radios.every((n) => n.props.disabled === true), '整体 disabled 时每一项都不可点')
  const clicked = render('default')
  clicked.radios[1].props.onClick()
  assert.deepEqual(clicked.changes, [], '点击 disabled 项不回调')
})
