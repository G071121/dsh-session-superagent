// 路由层单测：之前 0 覆盖，全靠真机 curl 手测。
// 用环境变量把状态目录指到临时目录，并把轮询关掉，避免打到真 GitHub。
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { assertTempStateDir, tempDir } from './fixtures/tmpdir.mjs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zstdCompressSync } from 'node:zlib'
import test from 'node:test'
// 审核 T30：这些用例会改 process.env.DSH_SUPERAGENT_STATE 却从不还原 ——
import assert from 'node:assert/strict'

const STATE_DIR = tempDir('superagent-routes-')
process.env.DSH_SUPERAGENT_STATE = STATE_DIR
// 审核 T30：本文件会改 process.env.DSH_SUPERAGENT_STATE —— 每个用例结束后还原，
// 否则同一个进程里后跑的用例会拿到前一个的目录（isolation=none 下实测 10 红）。
const __envBaseline = { ...process.env }
test.afterEach?.(() => {
  for (const key of Object.keys(process.env)) { if (!(key in __envBaseline)) delete process.env[key] }
  Object.assign(process.env, __envBaseline)
})
process.env.DSH_SUPERAGENT_NO_POLL = '1'

const { apply } = await import('../lib/index.js')

const tools = []
const routes = new Map()

const ctx = {
  tools: { register: (tool) => tools.push(tool) },
  webServer: {
    register: (route) => {
      routes.set(route.path, route)
      return () => {}
    },
  },
  agents: { currentInitiator: () => ({ id: 'session-test' }), get: () => null },
  get: () => null,
  effect: (fn) => fn(),
  inject: () => {},
}

apply(ctx)

/** 造一个够用的 req：readBody 只用到 on('data') / on('end')。 */
function makeReq(method, url, body, headers) {
  const handlers = {}
  const req = {
    method,
    url,
    headers: headers || {},
    on(event, cb) {
      ;(handlers[event] ||= []).push(cb)
      return req
    },
    destroy() {},
  }
  queueMicrotask(() => {
    if (body !== undefined) for (const cb of handlers.data || []) cb(Buffer.from(body))
    for (const cb of handlers.end || []) cb()
  })
  return req
}

function makeRes() {
  return {
    statusCode: 200,
    headers: {},
    chunks: [],
    setHeader(k, v) {
      this.headers[k] = v
    },
    end(chunk) {
      if (chunk !== undefined) this.chunks.push(chunk)
    },
    get body() {
      return this.chunks.join('')
    },
    json() {
      return JSON.parse(this.body)
    },
  }
}

async function call(method, path, body, headers) {
  const route = routes.get(path.split('?')[0])
  assert.ok(route, '路由不存在：' + path.split('?')[0])
  const res = makeRes()
  await route.handler(makeReq(method, path, body === undefined ? undefined : JSON.stringify(body), headers), res)
  return res
}

test('注册了预期的工具与路由', () => {
  const names = tools.map((t) => t.name).sort()
  for (const want of ['github', 'repo_here', 'watch_ack', 'watch_doctor', 'watch_trace', 'watch_start', 'watch_status', 'watch_stop']) {
    assert.ok(names.includes(want), '缺工具 ' + want + '（实际：' + names.join(',') + '）')
  }
  for (const want of ['/session-superagent/state', '/session-superagent/watch', '/session-superagent/client-note']) {
    assert.ok(routes.has(want), '缺路由 ' + want)
  }
})

test('POST /watch：缺 repo 或 sessionId 都拒绝', async () => {
  const bad = await call('POST', '/session-superagent/watch', { sessionId: 's1' })
  assert.equal(bad.statusCode, 400)
  assert.match(bad.json().error, /repo/)

  const bad2 = await call('POST', '/session-superagent/watch', { repo: 'o/r' })
  assert.equal(bad2.statusCode, 400)
  assert.match(bad2.json().error, /sessionId/)
})

test('建 → 查 → 暂停 → 恢复 → 删，全链路', async () => {
  const created = await call('POST', '/session-superagent/watch', {
    repo: 'o/r',
    sessionId: 's1',
    intervalSec: 30,
    filters: { labels: ['ai-fix'] },
    batchLimit: 2,
    maxWakesPerHour: 3,
    activeHours: '09:00-23:00',
  })
  assert.equal(created.statusCode, 200)
  const id = created.json().id
  assert.equal(id, 'o/r#s1')

  const state = (await call('GET', '/session-superagent/state')).json()
  assert.equal(state.watchers.length, 1)
  const w = state.watchers[0]
  assert.equal(w.id, id)
  assert.deepEqual(w.filters.labels, ['ai-fix'])
  assert.equal(w.batchLimit, 2)
  assert.equal(w.maxWakesPerHour, 3)
  assert.equal(w.activeHours, '09:00-23:00')
  assert.equal(w.enabled, true)

  const paused = (await call('POST', '/session-superagent/watch', { action: 'pause', id })).json()
  assert.equal(paused.enabled, false)
  assert.equal((await call('GET', '/session-superagent/state')).json().watchers[0].enabled, false)

  const resumed = (await call('POST', '/session-superagent/watch', { action: 'resume', id })).json()
  assert.equal(resumed.enabled, true)

  const deleted = (await call('POST', '/session-superagent/watch', { action: 'delete', id })).json()
  assert.equal(deleted.deleted, true)
  assert.equal((await call('GET', '/session-superagent/state')).json().watchers.length, 0)
})

test('POST /watch：watchKind=pr 建出 PR 守，与同仓库的 issue 守并存', async () => {
  // 面板的「监控类型」分段控件提交的就是 watchKind。它必须落成 `pr:` 前缀的 id ——
  // 否则同一仓库的两条守（issue 一条、PR 一条）会互相覆盖，后建的把先建的顶掉。
  const issue = await call('POST', '/session-superagent/watch', { repo: 'o/both', sessionId: 's1' })
  assert.equal(issue.statusCode, 200)
  assert.equal(issue.json().id, 'o/both#s1', 'issue 守的 id 不带前缀')

  const pr = await call('POST', '/session-superagent/watch', {
    repo: 'o/both',
    sessionId: 's1',
    watchKind: 'pr',
    intervalSec: 300,
    audit: true,
    adversarialAudit: true,
    auditMode: 'inline',
  })
  assert.equal(pr.statusCode, 200)
  assert.equal(pr.json().id, 'pr:o/both#s1', 'PR 守的 id 要带 pr: 前缀')

  const state = (await call('GET', '/session-superagent/state')).json()
  const ids = state.watchers.map((w) => w.id).sort()
  assert.deepEqual(ids, ['o/both#s1', 'pr:o/both#s1'], '两条守必须并存')
  const prView = state.watchers.find((w) => w.id === 'pr:o/both#s1')
  assert.equal(prView.kind, 'pr', '/state 要回 kind，面板靠它决定审计三项显不显示')
  assert.equal(prView.audit, true)
  assert.equal(prView.adversarialAudit, true)
  assert.equal(prView.auditMode, 'inline')
  assert.equal(prView.intervalSec, 300)

  // seenComments 不经过 /state 投影（它是轮询内部水位），直接读状态文件
  const raw = JSON.parse(readFileSync(join(STATE_DIR, 'watchers.json'), 'utf8'))
  assert.deepEqual(raw.watchers['pr:o/both#s1'].seenComments, {}, 'PR 守新建时水位是空对象')
  assert.equal(raw.watchers['pr:o/both#s1'].kind, 'pr')
  assert.equal('seenComments' in raw.watchers['o/both#s1'], false, 'issue 守不该带 PR 字段')

  // 编辑已有 PR 守时只改间隔：审计配置不能因为「没传」被重置
  await call('POST', '/session-superagent/watch', { repo: 'o/both', sessionId: 's1', watchKind: 'pr', intervalSec: 600 })
  const afterEdit = JSON.parse(readFileSync(join(STATE_DIR, 'watchers.json'), 'utf8')).watchers['pr:o/both#s1']
  assert.equal(afterEdit.intervalSec, 600)
  assert.equal(afterEdit.audit, true, '没传 audit 不能清空')
  assert.equal(afterEdit.adversarialAudit, true)
  assert.equal(afterEdit.auditMode, 'inline')
  assert.deepEqual(afterEdit.seenComments, {}, '编辑不能重置水位')

  for (const id of ids) await call('POST', '/session-superagent/watch', { action: 'delete', id })
})

test('非法 action / 未知 id / 非 POST 都有明确响应', async () => {
  const badAction = await call('POST', '/session-superagent/watch', { action: 'explode', id: 'x/y#z' })
  assert.equal(badAction.statusCode, 400)

  const unknown = await call('POST', '/session-superagent/watch', { action: 'pause', id: 'nope/nope#nope' })
  assert.equal(unknown.statusCode, 400)

  const pollUnknown = await call('POST', '/session-superagent/watch', { action: 'poll', id: 'nope/nope#nope' })
  assert.equal(pollUnknown.statusCode, 404)

  const getWatch = await call('GET', '/session-superagent/watch')
  assert.equal(getWatch.statusCode, 405)
})

test('client-note 写入探针且返回 204', async () => {
  const res = await call('GET', '/session-superagent/client-note?key=client-version&value=9.9.9')
  assert.equal(res.statusCode, 204)
  // 探针写在状态文件里，不从 /state 返回
  const raw = JSON.parse(readFileSync(join(STATE_DIR, 'watchers.json'), 'utf8'))
  assert.equal(raw.client['note:client-version'].detail, '9.9.9')
})

test('未知路由不注册（不会误吞）', () => {
  assert.equal(routes.has('/session-superagent/nope'), false)
})


test('/state 返回 gh 健康；/config 已下线', async () => {
  const state = (await call('GET', '/session-superagent/state')).json()
  assert.ok('gh' in state, '/state 必须回传 gh 字段（设置页「来源」卡片要用）')
  // 没有 GitHub 守时不再 spawn `gh`：ok 允许为 null，但必须说明原因（否则面板分不清「没探」和「探失败」）
  assert.ok(typeof state.gh.ok === 'boolean' || state.gh.ok === null, 'ok 只能是 boolean 或 null')
  if (state.gh.ok === null) assert.ok(state.gh.skipped, '跳过探测时必须给原因：' + JSON.stringify(state.gh))

  // /config 已删除（与 /state 重复、是未鉴权 GET，且曾因引用未定义变量抛 ReferenceError）
  // 路由表里不应再注册它 —— 未注册即 404（宿主不会为未知路径分发到 handler）
  assert.equal(routes.has('/session-superagent/config'), false, '/config 必须已从路由表移除')
})

test('编辑保存不会清空 goal、不会抹掉没暴露的 filters、isolated 可以关', async () => {
  const created = (await call('POST', '/session-superagent/watch', {
    repo: 'o/edit',
    sessionId: 's2',
    intervalSec: 60,
    goal: '把 widget 的 issue 都处理完',
    filters: { labels: ['ai-fix'], ignoreLabels: ['wontfix'], skipClosed: false, assignee: 'alice', onlyAssigned: true },
    isolated: true,
  })).json()
  const id = created.id

  // GUI 行内编辑发出的正是这种 body：只有 labels/onlyAssigned，没有 goal / ignoreLabels / skip*
  await call('POST', '/session-superagent/watch', {
    repo: 'o/edit',
    sessionId: 's2',
    intervalSec: 120,
    filters: { labels: ['ai-fix'], onlyAssigned: false },
    activeHours: '09:00-23:00',
    isolated: false,
    observe: true,
  })

  // entry.goal 不经过 /state 投影（那里回的是真会话 goal），直接读状态文件
  const raw = JSON.parse(readFileSync(join(STATE_DIR, 'watchers.json'), 'utf8'))
  const watcher = raw.watchers[id]
  assert.equal(watcher.intervalSec, 120)
  assert.equal(watcher.goal, '把 widget 的 issue 都处理完', '没传 goal 不能清空')
  assert.deepEqual(watcher.filters.labels, ['ai-fix'])
  assert.deepEqual(watcher.filters.ignoreLabels, ['wontfix'], '没暴露的字段要保持原值')
  assert.equal(watcher.filters.skipClosed, false)
  assert.equal(watcher.filters.assignee, 'alice')
  assert.equal(watcher.isolated, false, 'isolated 必须能关掉')
  assert.equal(watcher.observe, true)

  await call('POST', '/session-superagent/watch', { action: 'delete', id })
})

test('watch_doctor 会报告挂载状态（面板接口死没死）', async () => {
  const tool = tools.find((t) => t.name === 'watch_doctor')
  assert.ok(tool, '没注册 watch_doctor')
  const text = String(await tool.execute({ repo: 'no-such-owner/no-such-repo-xyz' }))
  assert.match(text, /面板接口挂载/, '必须有一行讲挂载状态')
  assert.match(text, /13 条，无失败|部分失败|挂载：/, '挂载行要给出具体结论')
})

test('cleanup', () => {
  rmSync(STATE_DIR, { recursive: true, force: true })
})

test('路由面收敛：只保留 13 条（/config 与 /client-hello 已下线，新增 /update /trace 与四条 /gates）', () => {
  const expected = [
    '/session-superagent/state',
    '/session-superagent/client-note',
    '/session-superagent/client-error',
    '/session-superagent/watch',
    '/session-superagent/credentials',
    '/session-superagent/goal',
    '/session-superagent/update',
    '/session-superagent/trace',
    '/session-superagent/diagnose',
    '/session-superagent/gates',
    '/session-superagent/gates/preview',
    '/session-superagent/gates/optimize',
    '/session-superagent/gates/models',
  ].sort()
  assert.deepEqual([...routes.keys()].sort(), expected)
})

// ── 四条 /gates 路由（G2：门禁实现搬到 @mycf711/dsh-gate，路由行为不许变） ──
// 用例都指向临时 repo：不读也不写本机真实的 .superagent 配置。

test('GET /gates：四层配置形状稳定，默认层随包发布', async () => {
  const repo = tempDir('gate-route-')
  const res = await call('GET', '/session-superagent/gates?repo=' + encodeURIComponent(repo))
  assert.equal(res.statusCode, 200)
  const body = res.json()
  assert.equal(body.ok, true)
  assert.equal(body.repo, repo)
  assert.deepEqual(Object.keys(body.scopes).sort(), ['default', 'local', 'project', 'user'])
  for (const scope of Object.values(body.scopes)) {
    assert.equal(typeof scope.path, 'string')
    assert.equal(typeof scope.exists, 'boolean')
  }
  assert.ok(body.scopes.default.exists, '默认规则随包发布，必须能读到')
  assert.ok(Array.isArray(body.config.rules) && body.config.rules.length >= 8, '默认规则至少 8 条')
  assert.ok(body.sources.some((source) => source.name === 'default'), '默认层的来源要能被面板看到')
})

test('POST /gates：非法配置 400，合法配置写盘并能再读回', async () => {
  const repo = tempDir('gate-route-')
  const bad = await call('POST', '/session-superagent/gates', {
    scope: 'project', repo, config: { rules: [{ id: 'BAD ID', type: 'regex' }] },
  })
  assert.equal(bad.statusCode, 400)
  assert.equal(bad.json().code, 'invalid_config')

  const good = await call('POST', '/session-superagent/gates', {
    scope: 'project',
    repo,
    config: {
      version: 1,
      rules: [{ id: 'route-only', label: '路由用例', type: 'contains', value: '路由命中词', triggers: ['issue.reply'], message: '命中' }],
    },
  })
  assert.equal(good.statusCode, 200)
  const savedPath = join(repo, '.superagent', 'gates.json')
  assert.ok(existsSync(savedPath), '合法配置要写进项目层')
  const saved = JSON.parse(readFileSync(savedPath, 'utf8'))
  assert.equal(saved.rules[0].id, 'route-only')

  const reread = (await call('GET', '/session-superagent/gates?repo=' + encodeURIComponent(repo))).json()
  assert.ok(reread.sources.some((source) => source.name === 'project'))
  assert.ok(reread.config.rules.some((rule) => rule.id === 'route-only'))
})

test('POST /gates/preview：确定性门禁先跑，命中就返回且不调语义', async () => {
  const repo = tempDir('gate-route-')
  const leaked = await call('POST', '/session-superagent/gates/preview', {
    repo, trigger: 'issue.reply', current: 15, semantic: true, body: 'token=ghp_' + 'a'.repeat(30),
  })
  assert.equal(leaked.statusCode, 200)
  const dirty = leaked.json()
  assert.equal(dirty.ok, false, '硬门禁命中就必须不过')
  assert.ok(dirty.hits.some((hit) => hit.id === 'secret'))
  assert.deepEqual(dirty.semantic, { skipped: true }, '硬门禁已失败时不该再花一次模型调用')

  const clean = (await call('POST', '/session-superagent/gates/preview', {
    repo, trigger: 'issue.reply', current: 15, body: '本 issue #15 已修复。',
  })).json()
  assert.equal(clean.ok, true)
  assert.deepEqual(clean.hits, [])
  assert.deepEqual(clean.semantic, { skipped: true }, '没勾语义复审时不许调用模型')
})

test('POST /gates/preview：宿主注入的 ctx.get(\'gate\') 优先于内置 createGate', async () => {
  const calls = []
  const injected = {
    id: 'fake-gate',
    async check(input) {
      calls.push(input)
      return {
        ok: true,
        hits: [{ id: 'semantic-fake', label: '语义复审', severity: 'warn', message: '来自注入的 provider' }],
        semantic: { skipped: false, ok: true, hits: [] },
      }
    },
  }
  const originalGet = ctx.get
  ctx.get = (name) => (name === 'gate' ? injected : null)
  try {
    const repo = tempDir('gate-route-')
    // 硬门禁不过时，provider 不该被调用（即使勾了语义复审）
    const blocked = (await call('POST', '/session-superagent/gates/preview', {
      repo, trigger: 'merge', semantic: true, body: 'token=ghp_' + 'a'.repeat(30),
    })).json()
    assert.equal(blocked.ok, false)
    assert.deepEqual(calls, [], '确定性门禁没过就不该进 provider')

    const res = (await call('POST', '/session-superagent/gates/preview', {
      repo, trigger: 'merge', semantic: true, body: '草稿正文，没有命中任何硬规则。',
    })).json()
    assert.equal(calls.length, 1, '勾了语义复审就走 provider')
    assert.equal(calls[0].trigger, 'merge')
    assert.equal(calls[0].repo, repo)
    assert.ok(res.hits.some((hit) => hit.id === 'semantic-fake'), 'provider 的命中要并进响应')
    assert.deepEqual(res.semantic, { skipped: false, ok: true, hits: [] })
  } finally {
    ctx.get = originalGet
  }
})

test('GET /gates/models：网关不可达时降级成空列表而不是 500', async () => {
  const res = await call('GET', '/session-superagent/gates/models?baseURL=' + encodeURIComponent('http://127.0.0.1:1/v1'))
  assert.equal(res.statusCode, 200)
  const body = res.json()
  assert.equal(body.ok, false)
  assert.deepEqual(body.models, [])
  assert.equal(typeof body.error, 'string')
})

test('POST /gates/preview：语义复审开启但模型不可用时放行并给 warning', async () => {
  // 项目 / 本地层只能关语义复审，能开的只有用户层 —— 用 DSH_GATE_USER_CONFIG 指向临时文件。
  const userConfig = join(tempDir('gate-user-'), 'gates.json')
  writeFileSync(userConfig, JSON.stringify({
    version: 1,
    name: 'user',
    rules: [],
    semantic: { enabled: true, baseURL: 'http://127.0.0.1:1/v1', model: 'unreachable-model', prompt: 'p', timeoutMs: 2000, mode: 'warn' },
  }), 'utf8')
  const previous = process.env.DSH_GATE_USER_CONFIG
  process.env.DSH_GATE_USER_CONFIG = userConfig
  try {
    const res = (await call('POST', '/session-superagent/gates/preview', {
      repo: tempDir('gate-route-'), trigger: 'merge', semantic: true, body: '草稿正文，没有命中任何硬规则。',
    })).json()
    assert.equal(res.ok, true, '模型不可用时不许阻断硬门禁放行的正文')
    assert.deepEqual(res.hits, [])
    assert.equal(res.semantic.skipped, false)
    assert.match(String(res.semantic.warning), /语义复审不可用/)
  } finally {
    if (previous === undefined) delete process.env.DSH_GATE_USER_CONFIG
    else process.env.DSH_GATE_USER_CONFIG = previous
  }
})

// 这条会真的去 npm registry 查最新版本，机器慢/网络抖时会撑到超时（跑过 5010ms 才失败）。
// 给它单独的宽松超时：要验的是「离线也必须给出 current」，不是网络速度。
test('/update 只读地报告版本（离线/在线都必须给出 current）', { timeout: 60000 }, async () => {
  // 走离线开关：这条用例不该因为 npm registry 抖动而红（曾经偶发超时 5 秒）
  process.env.DSH_SUPERAGENT_UPDATE_OFFLINE = '1'
  const res = await call('GET', '/session-superagent/update')
  assert.equal(res.statusCode, 200)
  const body = JSON.parse(res.body)
  assert.equal(typeof body.current, 'string', '必须给出当前版本')
  assert.equal(typeof body.hasUpdate, 'boolean', 'hasUpdate 必须是布尔值')
  // 命令模板里必须带包名，客户复制出去就能跑
  assert.ok(String(body.command).includes('dsh-session-superagent'), 'command 要含包名：' + body.command)
})

test('面板可设限流：batchLimit / maxWakesPerHour 会被夹紧并回传', async () => {
  const created = (await call('POST', '/session-superagent/watch', {
    repo: 'o/limits', sessionId: 's9', intervalSec: 60, batchLimit: 3, maxWakesPerHour: 99,
  })).json()
  const watcher = (await call('GET', '/session-superagent/state')).json().watchers.find((w) => w.id === created.id)
  assert.equal(watcher.batchLimit, 3)
  assert.equal(watcher.maxWakesPerHour, 60, '每小时上限要夹到 1-60')
  await call('POST', '/session-superagent/watch', { action: 'delete', id: created.id })
})

test('watch_start 工具能配过滤/观察/限流，并夹紧取值', async () => {
  const tool = tools.find((t) => t.name === 'watch_start')
  assert.ok(tool, '没注册 watch_start')

  const result = await tool.execute({
    repo: 'o/tool', intervalSec: 5,
    labels: ['ai-fix'], onlyAssigned: true, assignee: 'alice',
    observe: true, goal: '把 widget 的 issue 都处理完',
    batchLimit: 99, maxWakesPerHour: 0, activeHours: '09:00-23:00',
  })
  assert.match(String(result), /watching o\/tool/)

  const raw = JSON.parse(readFileSync(join(STATE_DIR, 'watchers.json'), 'utf8'))
  const entry = raw.watchers['o/tool#session-test']
  assert.equal(entry.intervalSec, 30, 'intervalSec 要夹到最小 30 秒')
  assert.deepEqual(entry.filters.labels, ['ai-fix'])
  assert.equal(entry.filters.onlyAssigned, true)
  assert.equal(entry.filters.assignee, 'alice')
  assert.equal(entry.observe, true)
  assert.equal(entry.goal, '把 widget 的 issue 都处理完')
  assert.equal(entry.batchLimit, 20, 'batchLimit 夹到 1-20')
  assert.equal(entry.maxWakesPerHour, 1, 'maxWakesPerHour 夹到 1-60')
  assert.equal(entry.activeHours, '09:00-23:00')
})

test('watch_start 拒绝相对路径的 workdir', async () => {
  const tool = tools.find((t) => t.name === 'watch_start')
  const result = await tool.execute({ repo: 'o/tool2', workdir: 'relative/path' })
  assert.match(String(result), /must be an absolute path/)
})

test('/state 字段契约：client.js 引用的每个字段都必须真的回传', async () => {
  // 之前是人工核对的（审核员做过一次），这里固化成守门：
  // client 用 body.X 取顶层、用 watcher.X 取每条，任何一个字段漏了，
  // 面板上就会安静地显示 undefined。
  const clientSrc = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  const topLevel = new Set([...clientSrc.matchAll(/body\.([a-zA-Z]+)/g)].map((m) => m[1]))
  const perWatcher = new Set([...clientSrc.matchAll(/watcher\.([a-zA-Z]+)/g)].map((m) => m[1]))

  const created = (await call('POST', '/session-superagent/watch', {
    repo: 'o/contract', sessionId: 's7', intervalSec: 60, observe: true,
    isolated: true, workdir: process.cwd(), activeHours: '09:00-23:00', goal: 'x',
    filters: { labels: ['a'], ignoreLabels: ['b'], onlyAssigned: true, assignee: 'a' },
    batchLimit: 3, maxWakesPerHour: 2,
  })).json()
  const state = (await call('GET', '/session-superagent/state')).json()
  const watcher = state.watchers.find((w) => w.id === created.id)

  // call() 里有个通用 `body.error`（任何路由的错误响应），它不属于 /state 契约
  const allowedTop = new Set(['error'])
  const missingTop = [...topLevel].filter((key) => !allowedTop.has(key) && !(key in state))
  assert.deepEqual(missingTop, [], '顶层缺字段：' + missingTop.join(', '))
  assert.ok(state.gh !== undefined, 'gh 必须回传')

  const missingPer = [...perWatcher].filter((key) => !(key in watcher))
  assert.deepEqual(missingPer, [], '每条缺字段：' + missingPer.join(', '))

  await call('POST', '/session-superagent/watch', { action: 'delete', id: created.id })
})

test('新增守会回传 warnings 字段（添加前体检的结论；测试环境跳过网络但字段要在）', async () => {
  const res = await call('POST', '/session-superagent/watch', { repo: 'o/precheck', sessionId: 's10', intervalSec: 60 })
  assert.equal(res.statusCode, 200)
  const body = JSON.parse(res.body)
  assert.ok(Array.isArray(body.warnings), 'warnings 必须始终是数组：' + res.body.slice(0, 120))
})

test('/state 回传 lastWakeItem（弹层靠它显示「最近唤醒的是哪一条」）', async () => {
  // 上面那条契约测试只认 `watcher.X` 字面量；弹层里写的是 `w.lastWakeItem`，
  // 提取不到，所以这里显式钉住两件事：从未唤醒给 null；写过之后对象原样回传。
  const created = (await call('POST', '/session-superagent/watch', {
    repo: 'o/wakeitems', sessionId: 's13', intervalSec: 60,
  })).json()
  const before = (await call('GET', '/session-superagent/state')).json()
  assert.equal(before.watchers.find((w) => w.id === created.id).lastWakeItem, null, '从没唤醒过要给 null')

  // 真实写入路径在 test/wake-items.test.mjs 覆盖；这里只钉投影：写进去必须能读出来
  const { __test } = await import('../lib/index.js')
  const state = __test.readState()
  state.watchers[created.id].lastWakeItem = { number: '128', title: '插件 0.2.3 下报 tool already registered', kind: 'issue' }
  __test.writeState(state)

  const after = (await call('GET', '/session-superagent/state')).json()
  assert.deepEqual(after.watchers.find((w) => w.id === created.id).lastWakeItem,
    { number: '128', title: '插件 0.2.3 下报 tool already registered', kind: 'issue' },
    '/state 必须把条目原样回传，否则弹层永远显示不出标题')
  await call('POST', '/session-superagent/watch', { action: 'delete', id: created.id })
})

test('/state 不回传客户端从不读的字段（面板每 5 秒拉一次，省的是真流量）', async () => {
  await call('POST', '/session-superagent/watch', { repo: 'o/lean', sessionId: 's11', intervalSec: 60 })
  const res = await call('GET', '/session-superagent/state')
  const body = JSON.parse(res.body)
  const entry = body.watchers.find((w) => w.repo === 'o/lean')
  assert.ok(entry, '应该能找到刚建的守')
  for (const field of ['wakeTimes', 'cooldownMs', 'lastBatch']) {
    assert.equal(entry[field], undefined, field + ' 不该出现在 /state 里（服务端自己用即可）')
  }
  // 但真正在用的字段必须在
  for (const field of ['id', 'repo', 'intervalSec', 'enabled', 'filters', 'priority', 'history']) {
    assert.notEqual(entry[field], undefined, field + ' 必须在')
  }
})

test('/state 带 ETag：同一份内容再问一次回 304（面板轮询省流量）', async () => {
  await call('POST', '/session-superagent/watch', { repo: 'o/etag', sessionId: 's12', intervalSec: 60 })
  const first = await call('GET', '/session-superagent/state')
  assert.equal(first.statusCode, 200)
  const etag = first.headers && first.headers.etag
  assert.ok(etag, '200 响应必须带 ETag：' + JSON.stringify(first.headers || {}))
  // 同样的内容 + If-None-Match → 304，且没有正文
  const second = await call('GET', '/session-superagent/state', null, { 'if-none-match': etag })
  assert.equal(second.statusCode, 304, '内容没变应该回 304，实际 ' + second.statusCode)
  assert.ok(!second.body || second.body.length === 0, '304 不该带正文')
  // ETag 不匹配时必须给完整内容（否则客户端会丢状态）
  const third = await call('GET', '/session-superagent/state', null, { 'if-none-match': '"stale"' })
  assert.equal(third.statusCode, 200)
  assert.ok(JSON.parse(third.body).watchers.length > 0)
})

test('/state 带 sessionUsage（近一小时用了几次、上限多少、几条守被上限挡住）', async () => {
  await call('POST', '/session-superagent/watch', { repo: 'o/usage', sessionId: 'session-usage', intervalSec: 60 })
  const res = await call('GET', '/session-superagent/state')
  const body = JSON.parse(res.body)
  assert.ok(body.sessionUsage, '要有 sessionUsage')
  assert.equal(typeof body.sessionUsage.used, 'number')
  assert.equal(typeof body.sessionUsage.cap, 'number')
  assert.ok(body.sessionUsage.cap >= 1, '上限要有值：' + JSON.stringify(body.sessionUsage))
  assert.equal(typeof body.sessionUsage.capped, 'number')
})

test('/state?sessionId 返回当前会话 goal/title/usage；无 sessionId 不泄漏其它会话 goal', async () => {
  const focusSession = 'session-focus-contract'
  const otherSession = 'session-other-contract'
  const focusAgent = { id: focusSession }
  const otherAgent = { id: otherSession }
  const goalByAgent = new Map([
    [focusAgent, { objective: '当前会话 goal', phase: 'active', ref: { revision: 7 } }],
    [otherAgent, { objective: '其它会话 goal', phase: 'active', ref: { revision: 3 } }],
  ])
  const agents = {
    get: (id) => id === focusSession ? focusAgent : (id === otherSession ? otherAgent : null),
    currentInitiator: () => focusAgent,
  }
  const goals = { get: (agent) => goalByAgent.get(agent) || null }
  const localRoutes = new Map()
  const dir = tempDir('zhuli-state-session-contract-')
  const home = tempDir('zhuli-state-session-home-')
  process.env.DSH_SUPERAGENT_STATE = dir
  process.env.DSH_SUPERAGENT_NO_POLL = '1'
  process.env.DSH_HOME = home

  // sessionTitle() 的真实输入是宿主 zstd 会话日志；不能用 watcher.note 或手写标题冒充。
  const sessionDir = join(home, 'sessions', 'contract', focusSession)
  mkdirSync(sessionDir, { recursive: true })
  writeFileSync(join(sessionDir, 'session.v4.jsonl.zstd'), zstdCompressSync(Buffer.from(
    JSON.stringify({ type: 'session/title', data: { title: '当前会话标题' } }) + '\n', 'utf8',
  )))

  const ctx = {
    tools: { register: () => {} },
    webServer: { register: (route) => { localRoutes.set(route.path, route); return () => {} } },
    agents,
    get: (name) => name === 'goals' ? goals : (name === 'agents' ? agents : null),
    effect: (fn) => fn(), inject: () => {},
  }
  const mod = await import('../lib/index.js?state-session-contract=' + Date.now())
  mod.apply(ctx)
  const now = Date.now()
  mod.__test.writeState({ watchers: {
    ['acme/focus#' + focusSession]: {
      id: 'acme/focus#' + focusSession, repo: 'acme/focus', sessionId: focusSession,
      intervalSec: 60, enabled: true, sessionMaxWakes: 9,
      wakeTimes: [now - 1000, now - 2000],
    },
    ['acme/other#' + otherSession]: {
      id: 'acme/other#' + otherSession, repo: 'acme/other', sessionId: otherSession,
      intervalSec: 60, enabled: true, sessionMaxWakes: 9,
      wakeTimes: [now - 1000, now - 2000, now - 3000, now - 4000],
    },
  } })

  const getState = async (path) => {
    const res = makeRes()
    await localRoutes.get('/session-superagent/state').handler(makeReq('GET', path), res)
    assert.equal(res.statusCode, 200, path + '：' + res.body)
    return res.json()
  }
  const focused = await getState('/session-superagent/state?sessionId=' + encodeURIComponent(focusSession))
  assert.deepEqual(focused.sessionGoal, { objective: '当前会话 goal', phase: 'active', revision: 7 })
  assert.equal(focused.sessionTitle, '当前会话标题')
  assert.equal(focused.sessionUsage.used, 2, '只统计当前会话，不得把其它会话的 4 次加进来')
  assert.equal(focused.sessionUsage.cap, 9)

  const anonymous = await getState('/session-superagent/state')
  assert.equal(anonymous.sessionGoal, null, '无 sessionId 时不能拿其它会话 goal 顶替')
  assert.equal(anonymous.sessionTitle, null)
  assert.equal(anonymous.sessionUsage.used, 0)
})

test('/state 每条守都带 deferReason（面板按字段统计，不再匹配文案）', async () => {
  await call('POST', '/session-superagent/watch', { repo: 'o/reason', sessionId: 'session-reason', intervalSec: 60 })
  const res = await call('GET', '/session-superagent/state')
  const body = JSON.parse(res.body)
  const list = body.watchers || []
  assert.ok(list.length > 0, '应该有守')
  for (const w of list) assert.ok('deferReason' in w, '缺 deferReason：' + JSON.stringify(w).slice(0, 120))
  // 新加的守还没被暂停过 —— 应当是 null 而不是 undefined
  assert.equal(list[0].deferReason, null)
})

test('watch_start 能设面板里的三项（会话上限 / 隔离保留天数 / 最多几个隔离区）', async () => {
  const tools = []
  const ctx = {
    tools: { register: (tool) => tools.push(tool) },
    webServer: { register: () => () => {} },
    agents: { get: () => null, currentInitiator: () => ({ id: 'session-parity' }) },
    get: () => null,
    effect: (fn) => fn(),
    inject: () => {},
  }
  const mod = await import('../lib/index.js?parity=' + Date.now())
  mod.apply(ctx)
  const start = tools.find((tool) => tool.name === 'watch_start')
  assert.ok(start, '要有 watch_start')
  // 面板里能改的三项，工具参数里必须也有（否则 agent 无从下手）
  for (const key of ['sessionMaxWakes', 'isolateKeepDays', 'maxIsolated']) {
    assert.ok(start.parameters.properties[key], '缺参数 ' + key)
  }
  const res = await start.execute({
    repo: assertTempStateDir('o/parity 用例') && 'o/parity', sessionMaxWakes: 24, isolateKeepDays: 7, maxIsolated: 3,
  })
  assert.equal(typeof res, 'string')
  const state = JSON.parse(JSON.stringify(mod.__test.readState()))
  const entry = Object.values(state.watchers || {}).find((w) => w.repo === 'o/parity')
  assert.ok(entry, '应该登记成功：' + res)
  assert.equal(entry.sessionMaxWakes, 24)
  assert.equal(entry.isolateKeepDays, 7)
  assert.equal(entry.maxIsolated, 3)
})

test('watch_status 带诊断：暂停原因、未回音、会话用量（agent 自诊不用看面板）', async () => {
  const tools = []
  const dir = tempDir('zhuli-st-')
  process.env.DSH_SUPERAGENT_STATE = dir
  process.env.DSH_SUPERAGENT_NO_POLL = '1'
  const ctx = {
    tools: { register: (tool) => tools.push(tool) },
    webServer: { register: () => () => {} },
    agents: { get: () => null, currentInitiator: () => ({ id: 'session-status' }) },
    get: () => null, effect: (fn) => fn(), inject: () => {},
  }
  const mod = await import('../lib/index.js?status=' + Date.now())
  mod.apply(ctx)
  await tools.find((t) => t.name === 'watch_start').execute({ repo: 'o/st', sessionMaxWakes: 12 })
  // 直接改状态：模拟"被上限挡住 + 连续没回音"
  const state = mod.__test.readState()
  const key = Object.keys(state.watchers)[0]
  state.watchers[key].deferReason = 'cap-session'
  state.watchers[key].silentWakes = 3
  mod.__test.writeState(state)

  const text = String(await tools.find((t) => t.name === 'watch_status').execute({}))
  // 0.9.86 起文本改成"人话 + 只在需要时追加原因"，信息量不变
  assert.ok(text.includes('暂停：cap-session'), '要带暂停原因码：' + text)
  assert.ok(text.includes('叫醒 3 次没回音'), '要带未回音次数：' + text)
  assert.ok(!text.includes('lastPoll='), '不再堆无意义字段（lastPoll=- 之类）')
  assert.match(text, /session:\s*\d+\/12 wakes last hour/, '要有会话用量行')
})

test('watch_status 支持 format=json（同一份数据的机器可读形式）', async () => {
  const tools = []
  const dir = tempDir('zhuli-json-')
  process.env.DSH_SUPERAGENT_STATE = dir
  process.env.DSH_SUPERAGENT_NO_POLL = '1'
  const ctx = {
    tools: { register: (tool) => tools.push(tool) },
    webServer: { register: () => () => {} },
    agents: { get: () => null, currentInitiator: () => ({ id: 'session-json' }) },
    get: () => null, effect: (fn) => fn(), inject: () => {},
  }
  const mod = await import('../lib/index.js?json=' + Date.now())
  mod.apply(ctx)
  await tools.find((t) => t.name === 'watch_start').execute({ repo: 'o/js', sessionMaxWakes: 12 })
  const status = tools.find((t) => t.name === 'watch_status')
  const json = JSON.parse(await status.execute({ format: 'json' }))
  assert.equal(json.watchers.length, 1)
  assert.equal(json.watchers[0].repo, 'o/js')
  assert.equal(json.session.cap, 12)
  assert.equal(typeof json.session.used, 'number')
  // 默认仍是文本（老调用方不受影响）
  const text = String(await status.execute({}))
  assert.ok(text.includes('session:'), '默认输出要保持文本：' + text.slice(0, 80))
})

test('三个只读工具口径一致：都支持 format=json 且带 schemaVersion', async () => {
  const tools = []
  const dir = tempDir('zhuli-fmt-')
  process.env.DSH_SUPERAGENT_STATE = dir
  process.env.DSH_SUPERAGENT_NO_POLL = '1'
  const ctx = {
    tools: { register: (tool) => tools.push(tool) },
    webServer: { register: () => () => {} },
    agents: { get: () => null, currentInitiator: () => ({ id: 'session-fmt' }) },
    get: () => null, effect: (fn) => fn(), inject: () => {},
  }
  const mod = await import('../lib/index.js?fmt=' + Date.now())
  mod.apply(ctx)
  for (const name of ['watch_status', 'watch_doctor', 'watch_trace']) {
    const tool = tools.find((t) => t.name === name)
    assert.ok(tool.parameters.properties.format, name + ' 缺 format 参数')
  }

  const status = JSON.parse(await tools.find((t) => t.name === 'watch_status').execute({ format: 'json' }))
  assert.equal(status.schemaVersion, 1)
  assert.ok(Array.isArray(status.watchers))

  const doctor = JSON.parse(await tools.find((t) => t.name === 'watch_doctor').execute({ format: 'json' }))
  assert.equal(doctor.schemaVersion, 1)
  assert.ok(Array.isArray(doctor.checks) && doctor.checks.length > 0)
  assert.ok(doctor.checks.every((c) => typeof c.status === 'string' && typeof c.text === 'string'))

  // 没有任何守时，错误也要是 JSON（消费方不该在两种格式间猜）
  const traceEmpty = JSON.parse(await tools.find((t) => t.name === 'watch_trace').execute({ number: 1, format: 'json' }))
  assert.equal(traceEmpty.schemaVersion, 1)
  assert.ok(typeof traceEmpty.error === 'string')

  await tools.find((t) => t.name === 'watch_start').execute({ repo: 'o/fmt' })
  const trace = JSON.parse(await tools.find((t) => t.name === 'watch_trace').execute({ number: 1, format: 'json' }))
  assert.equal(trace.schemaVersion, 1)
  assert.ok(Array.isArray(trace.results))
})

test('写工具也给 JSON：成功/失败都能被程序判断（不再靠读中文）', async () => {
  const tools = []
  const dir = tempDir('zhuli-wr-')
  process.env.DSH_SUPERAGENT_STATE = dir
  process.env.DSH_SUPERAGENT_NO_POLL = '1'
  const ctx = {
    tools: { register: (tool) => tools.push(tool) },
    webServer: { register: () => () => {} },
    agents: { get: () => null, currentInitiator: () => ({ id: 'session-wr' }) },
    get: () => null, effect: (fn) => fn(), inject: () => {},
  }
  const mod = await import('../lib/index.js?wr=' + Date.now())
  mod.apply(ctx)
  const start = tools.find((t) => t.name === 'watch_start')
  const stop = tools.find((t) => t.name === 'watch_stop')

  const started = JSON.parse(await start.execute({ repo: 'o/wr', format: 'json', sessionMaxWakes: 12 }))
  assert.equal(started.schemaVersion, 1)
  assert.equal(started.ok, true)
  assert.equal(started.repo, 'o/wr')
  assert.equal(started.updated, false, '第一次是新建')

  const again = JSON.parse(await start.execute({ repo: 'o/wr', format: 'json' }))
  assert.equal(again.updated, true, '第二次是更新')

  const stopped = JSON.parse(await stop.execute({ repo: 'o/wr', format: 'json' }))
  assert.equal(stopped.ok, true)

  // 停一条不存在的：也要能用 ok:false 判断
  const missing = JSON.parse(await stop.execute({ repo: 'o/none', format: 'json' }))
  assert.equal(missing.ok, false)
  assert.ok(typeof missing.error === 'string')

  // 文本形态保持不变
  const text = String(await start.execute({ repo: 'o/wr' }))
  assert.ok(text.startsWith('watching '), '默认仍返回文本：' + text.slice(0, 60))
})

test('watch_doctor 能发现"定时器丢了"和"隔离目录不可写"', async () => {
  const tools = []
  const dir = tempDir('zhuli-doctor-')
  process.env.DSH_SUPERAGENT_STATE = dir
  process.env.DSH_SUPERAGENT_NO_POLL = '1'
  const ctx = {
    tools: { register: (tool) => tools.push(tool) },
    webServer: { register: () => () => {} },
    agents: { get: () => null, currentInitiator: () => ({ id: 'session-doc' }) },
    get: () => null, on() {}, effect: (fn) => fn(), inject: () => {},
  }
  const mod = await import('../lib/index.js?doc=' + Date.now())
  mod.apply(ctx)
  const doctor = tools.find((t) => t.name === 'watch_doctor')
  const start = tools.find((t) => t.name === 'watch_start')

  // 造一个"两小时没轮询过"的守（定时器丢了的样子）
  await start.execute({ repo: 'o/stale' })
  const state = mod.__test.readState()
  const key = Object.keys(state.watchers)[0]
  state.watchers[key].lastPoll = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString()
  // 进程也跑了很久（否则会被判成「刚重启」，见下一条用例）
  state.server = { ...(state.server || {}), startedAt: new Date(Date.now() - 4 * 60 * 60 * 1000).toISOString() }
  mod.__test.writeState(state)

  const text = String(await doctor.execute({}))
  assert.ok(/没轮询过/.test(text), '停滞的守要报出来：' + text.slice(0, 300))
})

test('watch_trace 能说清"被冷却期吸收"，而不是三合一猜测', async () => {
  const tools = []
  const dir = tempDir('zhuli-absorb-')
  process.env.DSH_SUPERAGENT_STATE = dir
  process.env.DSH_SUPERAGENT_NO_POLL = '1'
  const ctx = {
    tools: { register: (tool) => tools.push(tool) },
    webServer: { register: () => () => {} },
    agents: { get: () => null, currentInitiator: () => ({ id: 'session-ab' }) },
    get: () => null, on() {}, effect: (fn) => fn(), inject: () => {},
  }
  const mod = await import('../lib/index.js?ab=' + Date.now())
  mod.apply(ctx)
  const start = tools.find((t) => t.name === 'watch_start')
  const trace = tools.find((t) => t.name === 'watch_trace')
  await start.execute({ repo: 'o/ab' })

  const state = mod.__test.readState()
  const key = Object.keys(state.watchers)[0]
  state.watchers[key].absorbedLog = [{ at: '2026-11-02T10:00:00.000Z', number: '42', title: '被吸收的条目' }]
  state.watchers[key].seen = { 42: '2026-11-02T09:59:00.000Z' }
  mod.__test.writeState(state)

  const text = String(await trace.execute({ number: 42 }))
  assert.ok(text.includes('被冷却期吸收'), '结论要指名吸收：' + text.slice(0, 200))
  assert.ok(!text.includes('仅观察，或上报前就已存在'), '不该再给三合一猜测')

  const json = JSON.parse(String(await trace.execute({ number: 42, format: 'json' })))
  const item = json.results[0]
  assert.equal(item.absorbed.length, 1, 'JSON 里要有 absorbed 明细')
})

test('watch_ack 失败要区分"会自动恢复"和"需要你处理"', async () => {
  const tools = []
  const dir = tempDir('zhuli-ackfail-')
  process.env.DSH_SUPERAGENT_STATE = dir
  process.env.DSH_SUPERAGENT_NO_POLL = '1'
  const ctx = {
    tools: { register: (tool) => tools.push(tool) },
    webServer: { register: () => () => {} },
    agents: { get: () => null, currentInitiator: () => ({ id: 'session-ack' }) },
    get: () => null, on() {}, effect: (fn) => fn(), inject: () => {},
  }
  const mod = await import('../lib/index.js?ackfail=' + Date.now())
  mod.apply(ctx)
  const ack = tools.find((t) => t.name === 'watch_ack')

  // 不建守直接 ack：会走 "没有这个守" 的错误分支
  const missing = String(await ack.execute({ repo: 'o/none', number: 1 }))
  assert.ok(missing.includes('error'), '没有守时要报错：' + missing.slice(0, 120))

  // 分类函数本身的判据：可恢复的三类 vs 需动手的三类
  const { classifyGhError } = await import('../lib/gh-format.js')
  for (const [text, expectRetry] of [
    ['Get "https://api.github.com/x": EOF', true],
    ['HTTP 403: API rate limit exceeded', true],
    ['HTTP 502: Bad Gateway', true],
    ['HTTP 401: Bad credentials', false],
    ['HTTP 404: Not Found', false],
    ['gh: command not found', false],
    ['HTTP 301: Moved Permanently', false],
    ['Repository has been moved', false],
  ]) {
    const kind = classifyGhError(text).kind
    const retryable = ['network', 'ratelimit', 'gateway'].includes(kind)
    assert.equal(retryable, expectRetry, text + ' → ' + kind)
  }
})

test('watch_status 文本：正常的守不堆字段，异常的守才追加原因', async () => {
  const tools = []
  const dir = tempDir('zhuli-dense-')
  process.env.DSH_SUPERAGENT_STATE = dir
  process.env.DSH_SUPERAGENT_NO_POLL = '1'
  const ctx = {
    tools: { register: (tool) => tools.push(tool) },
    webServer: { register: () => () => {} },
    agents: { get: () => null, currentInitiator: () => ({ id: 'session-dense' }) },
    get: () => null, on() {}, effect: (fn) => fn(), inject: () => {},
  }
  const mod = await import('../lib/index.js?dense=' + Date.now())
  mod.apply(ctx)
  const start = tools.find((t) => t.name === 'watch_start')
  await start.execute({ repo: 'o/ok' })
  await start.execute({ repo: 'o/bad' })

  const state = mod.__test.readState()
  const keys = Object.keys(state.watchers)
  const badKey = keys.find((k) => k.includes('o/bad'))
  state.watchers[badKey].deferReason = 'active-hours'
  state.watchers[badKey].lastError = null
  mod.__test.writeState(state)

  const text = String(await tools.find((t) => t.name === 'watch_status').execute({}))
  const lines = text.split(String.fromCharCode(10))
  const okLine = lines.find((l) => l.includes('o/ok')) || ''
  const badLine = lines.find((l) => l.includes('o/bad')) || ''

  assert.ok(okLine.length < 60, '正常的守行要短：' + okLine)
  assert.ok(!okLine.includes('暂停'), '正常的守不该有暂停原因')
  assert.ok(badLine.includes('暂停：active-hours'), '异常的守要说原因：' + badLine)
  assert.equal(lines.filter((l) => l.includes('| 每 ')).length, 2, '每条守一行')
})

test('/state 的事件按预算收缩：守越多，每守带的事件越少', async () => {
  const tools = []
  const localRoutes = new Map()
  const dir = tempDir('zhuli-budget-')
  process.env.DSH_SUPERAGENT_STATE = dir
  process.env.DSH_SUPERAGENT_NO_POLL = '1'
  const ctx = {
    tools: { register: (tool) => tools.push(tool) },
    // 必须用本实例自己的路由表：共享的 call() 会打到别的实例/别的 state 目录（第一版就这么假失败）
    webServer: { register: (route) => { localRoutes.set(route.path, route); return () => {} } },
    agents: { get: () => null, currentInitiator: () => ({ id: 'session-budget' }) },
    get: () => null, on() {}, effect: (fn) => fn(), inject: () => {},
  }
  const mod = await import('../lib/index.js?budget=' + Date.now())
  mod.apply(ctx)

  // 造 40 条守，每条 20 个事件
  const state = mod.__test.readState()
  state.watchers = {}
  for (let i = 0; i < 40; i += 1) {
    const id = 'acme/r' + i + '#session-budget'
    state.watchers[id] = {
      id, repo: 'acme/r' + i, sessionId: 'session-budget', intervalSec: 60, enabled: true,
      events: Array.from({ length: 20 }, (_, k) => ({ at: new Date().toISOString(), kind: 'poll', text: 'x' + k })),
    }
  }
  mod.__test.writeState(state)

  const route = localRoutes.get('/session-superagent/state')
  const fakeRes = {
    statusCode: 200, headers: {}, chunks: [],
    setHeader(k, v) { this.headers[k] = v },
    end(chunk) { if (chunk !== undefined) this.chunks.push(chunk) },
    get body() { return this.chunks.join('') },
  }
  await route.handler({ method: 'GET', url: '/session-superagent/state' }, fakeRes)
  const parsed = JSON.parse(fakeRes.body)
  const total = parsed.watchers.reduce((sum, w) => sum + (w.events || []).length, 0)
  assert.equal(parsed.watchers.length, 40)
  assert.ok(total <= 240, '总事件数不该超过预算 240：' + total)
  assert.ok(parsed.watchers[0].events.length <= 6, '每守最多 6 条')
})

test('watch_start 一次加多个仓库：逗号/空格都认，JSON 列出每个的结果', async () => {
  const tools = []
  const dir = tempDir('zhuli-multi-')
  process.env.DSH_SUPERAGENT_STATE = dir
  process.env.DSH_SUPERAGENT_NO_POLL = '1'
  const ctx = {
    tools: { register: (tool) => tools.push(tool) },
    webServer: { register: () => () => {} },
    agents: { get: () => null, currentInitiator: () => ({ id: 'session-multi' }) },
    get: () => null, on() {}, effect: (fn) => fn(), inject: () => {},
  }
  const mod = await import('../lib/index.js?multi=' + Date.now())
  mod.apply(ctx)
  const start = tools.find((t) => t.name === 'watch_start')

  const text = String(await start.execute({ repo: 'acme/a, acme/b acme/c' }))
  assert.equal(text.split(String.fromCharCode(10)).length, 3, '三个仓库三行：' + text)
  const state = mod.__test.readState()
  assert.equal(Object.keys(state.watchers).length, 3, '三个守都要建好')

  const json = JSON.parse(String(await start.execute({ repo: 'acme/d acme/e', format: 'json' })))
  assert.equal(json.repos.length, 2, 'JSON 要列出每个仓库的结果')
  assert.equal(json.repo, 'acme/d', '旧的 repo 字段保留（兼容）')

  // 有一个写错就整体拒绝，不能只加一半
  const bad = String(await start.execute({ repo: 'acme/f not-a-repo' }))
  assert.ok(bad.includes('仓库要写成 owner/name'), '错误要说清格式：' + bad)
  const after = mod.__test.readState()
  assert.equal(Object.keys(after.watchers).length, 5, '失败时不该写进任何一条')
})

test('一条会话最多 20 条守：第 21 条被拒绝，批量请求整批拒绝', async () => {
  const tools = []
  const dir = tempDir('zhuli-cap-')
  process.env.DSH_SUPERAGENT_STATE = dir
  process.env.DSH_SUPERAGENT_NO_POLL = '1'
  const ctx = {
    tools: { register: (tool) => tools.push(tool) },
    webServer: { register: () => () => {} },
    agents: { get: () => null, currentInitiator: () => ({ id: 'session-cap' }) },
    get: () => null, on() {}, effect: (fn) => fn(), inject: () => {},
  }
  const mod = await import('../lib/index.js?cap=' + Date.now())
  mod.apply(ctx)
  const start = tools.find((t) => t.name === 'watch_start')

  for (let i = 0; i < 20; i += 1) {
    const out = String(await start.execute({ repo: 'acme/r' + i }))
    assert.ok(!out.includes('最多挂'), '第 ' + (i + 1) + ' 条不该被拦：' + out)
  }
  const over = String(await start.execute({ repo: 'acme/overflow' }))
  assert.ok(over.includes('最多同时挂 20 条'), '第 21 条要被拦下：' + over)

  // 批量：整批拒绝（不能只加进去一半）
  const batch = String(await start.execute({ repo: 'acme/x acme/y' }))
  assert.ok(batch.includes('最多同时挂'), '批量也要拦：' + batch)
  const state = mod.__test.readState()
  assert.equal(Object.keys(state.watchers).length, 20, '总数仍是 20')
  assert.ok(!state.watchers['acme/x#session-cap'], '批量里的第一个也不该写进去')

  // 更新已有守不受上限影响
  const update = String(await start.execute({ repo: 'acme/r0', intervalSec: 120 }))
  assert.ok(!update.includes('最多挂'), '更新已有守不该被拦：' + update)
})

test('/state 回传 otherSessions：同仓库的其它会话', async () => {
  const tools = []
  const localRoutes = new Map()
  const dir = tempDir('zhuli-peers-')
  process.env.DSH_SUPERAGENT_STATE = dir
  process.env.DSH_SUPERAGENT_NO_POLL = '1'
  const ctx = {
    tools: { register: (tool) => tools.push(tool) },
    webServer: { register: (route) => { localRoutes.set(route.path, route); return () => {} } },
    agents: { get: () => null, currentInitiator: () => ({ id: 'session-a' }) },
    get: () => null, on() {}, effect: (fn) => fn(), inject: () => {},
  }
  const mod = await import('../lib/index.js?peers=' + Date.now())
  mod.apply(ctx)
  const start = tools.find((t) => t.name === 'watch_start')
  await start.execute({ repo: 'acme/shared' })

  // 手写另一个会话的守（模拟另一个会话也在守同一仓库）
  const state = mod.__test.readState()
  state.watchers['acme/shared#session-b'] = {
    id: 'acme/shared#session-b', repo: 'acme/shared', sessionId: 'session-b', intervalSec: 60, enabled: true,
  }
  mod.__test.writeState(state)

  const route = localRoutes.get('/session-superagent/state')
  const fakeRes = {
    statusCode: 200, headers: {}, chunks: [],
    setHeader(k, v) { this.headers[k] = v }, end(c) { if (c !== undefined) this.chunks.push(c) },
    get body() { return this.chunks.join('') },
  }
  await route.handler({ method: 'GET', url: '/session-superagent/state' }, fakeRes)
  const parsed = JSON.parse(fakeRes.body)
  const mine = parsed.watchers.find((w) => w.sessionId === 'session-a')
  const theirs = parsed.watchers.find((w) => w.sessionId === 'session-b')
  assert.deepEqual(mine.otherSessions, ['session-b'], '我方要看到对方')
  assert.deepEqual(theirs.otherSessions, ['session-a'], '对方也要看到我方')
})

test('刚重启不该被当成「定时器丢了」', async () => {
  const tools = []
  const dir = tempDir('zhuli-restart-')
  process.env.DSH_SUPERAGENT_STATE = dir
  process.env.DSH_SUPERAGENT_NO_POLL = '1'
  const ctx = {
    tools: { register: (tool) => tools.push(tool) },
    webServer: { register: () => () => {} },
    agents: { get: () => null, currentInitiator: () => ({ id: 'session-restart' }) },
    get: () => null, on() {}, effect: (fn) => fn(), inject: () => {},
  }
  const mod = await import('../lib/index.js?restart=' + Date.now())
  mod.apply(ctx)
  const doctor = tools.find((t) => t.name === 'watch_doctor')
  await tools.find((t) => t.name === 'watch_start').execute({ repo: 'acme/old' })

  // 上次轮询是 2 小时前，但进程是刚启动的（startedAt = 现在）
  const state = mod.__test.readState()
  const key = Object.keys(state.watchers)[0]
  state.watchers[key].lastPoll = new Date(Date.now() - 2 * 3600 * 1000).toISOString()
  state.server = { ...(state.server || {}), startedAt: new Date().toISOString() }
  mod.__test.writeState(state)

  const fresh = String(await doctor.execute({}))
  assert.ok(fresh.includes('刚重启'), '刚重启要如实说明：' + fresh.slice(0, 300))
  assert.ok(!fresh.includes('定时器可能丢了'), '刚重启不该报故障')

  // 进程已经跑够久（uptime 3 小时）时，同样的陈旧就要报故障
  const state2 = mod.__test.readState()
  state2.server = { ...(state2.server || {}), startedAt: new Date(Date.now() - 3 * 3600 * 1000).toISOString() }
  mod.__test.writeState(state2)
  const stale = String(await doctor.execute({}))
  assert.ok(stale.includes('没轮询过'), '跑久了还陈旧才算故障：' + stale.slice(0, 300))
})

test('watch_trace 文本：一切正常时一行说完，异常才展开', async () => {
  const tools = []
  const dir = tempDir('zhuli-trace-quiet-')
  process.env.DSH_SUPERAGENT_STATE = dir
  process.env.DSH_SUPERAGENT_NO_POLL = '1'
  const ctx = {
    tools: { register: (tool) => tools.push(tool) },
    webServer: { register: () => () => {} },
    agents: { get: () => null, currentInitiator: () => ({ id: 'session-tq' }) },
    get: () => null, on() {}, effect: (fn) => fn(), inject: () => {},
  }
  const mod = await import('../lib/index.js?tq=' + Date.now())
  mod.apply(ctx)
  const start = tools.find((t) => t.name === 'watch_start')
  const trace = tools.find((t) => t.name === 'watch_trace')
  await start.execute({ repo: 'acme/q' })

  const state = mod.__test.readState()
  const key = Object.keys(state.watchers)[0]
  state.watchers[key].seen = { 55: '2026-11-01T10:00:00.000Z' }
  state.watchers[key].history = [{ at: '2026-11-02T09:00:00.000Z', numbers: [55], ok: true }]
  mod.__test.writeState(state)

  const quiet = String(await trace.execute({ number: 55 }))
  assert.equal(quiet.split(String.fromCharCode(10)).length, 2, '正常情况两行（结论 + 最近一次）：' + quiet)
  assert.ok(!quiet.includes('水位 seen'), '不堆细节')
  assert.ok(quiet.includes('最近一次唤醒'), '要给出时间')

  // 有失败唤醒时展开
  const state2 = mod.__test.readState()
  state2.watchers[key].history = [
    { at: '2026-11-02T09:00:00.000Z', numbers: [55], ok: true },
    { at: '2026-11-02T10:00:00.000Z', numbers: [55], ok: false, reason: 'agent busy' },
  ]
  mod.__test.writeState(state2)
  const loud = String(await trace.execute({ number: 55 }))
  assert.ok(loud.includes('唤醒尝试'), '有失败要展开：' + loud)
  assert.ok(loud.includes('agent busy'), '要说明失败原因')
})

test('/state 的 304 真的会命中：60 秒 12 次拉取，只有变化那几次返回 200', async () => {
  const tools = []
  const localRoutes = new Map()
  const dir = tempDir('zhuli-304-')
  process.env.DSH_SUPERAGENT_STATE = dir
  process.env.DSH_SUPERAGENT_NO_POLL = '1'
  const ctx = {
    tools: { register: (tool) => tools.push(tool) },
    webServer: { register: (route) => { localRoutes.set(route.path, route); return () => {} } },
    agents: { get: () => null, currentInitiator: () => ({ id: 'session-304' }) },
    get: () => null, on() {}, effect: (fn) => fn(), inject: () => {},
  }
  const mod = await import('../lib/index.js?e304=' + Date.now())
  mod.apply(ctx)
  await tools.find((t) => t.name === 'watch_start').execute({ repo: 'acme/etag' })

  const route = localRoutes.get('/session-superagent/state')
  const fetchOnce = async (ifNoneMatch) => {
    const res = {
      statusCode: 200, headers: {}, chunks: [],
      setHeader(k, v) { this.headers[k.toLowerCase()] = v },
      end(chunk) { if (chunk !== undefined) this.chunks.push(chunk) },
      get body() { return this.chunks.join('') },
    }
    const headers = ifNoneMatch ? { 'if-none-match': ifNoneMatch } : {}
    await route.handler({ method: 'GET', url: '/session-superagent/state', headers }, res)
    return res
  }

  // 12 次拉取：第 1 次拿 ETag，之后内容不变应有 10 次 304；第 6 次改一下状态
  const budget = { statuses: [], bytes: 0, saved: 0 }
  let etag = ''
  for (let i = 1; i <= 12; i += 1) {
    if (i === 6) {
      const state = mod.__test.readState()
      const key = Object.keys(state.watchers)[0]
      state.watchers[key].cursor = '2026-11-02T00:00:00.000Z'
      mod.__test.writeState(state)
    }
    const res = await fetchOnce(etag)
    budget.statuses.push(res.statusCode)
    budget.bytes += Buffer.byteLength(res.body)
    if (res.statusCode === 200) {
      etag = res.headers.etag
      budget.saved += 0 // 200 就是要下载的
    } else if (res.statusCode === 304) {
      budget.saved += 1
    }
  }
  const not304 = budget.statuses.filter((code) => code !== 304).length
  assert.equal(not304, 2, '12 次里只有 2 次 200（首次 + 改状态那次），实际：' + budget.statuses.join(','))
  assert.ok(budget.bytes < 8 * 1024, '省下来的正文要明显（实际收到 ' + budget.bytes + ' 字节）')
})

test('watch_start 能设 ackLabel：两个会话可各用各的标签，互不挡', async () => {
  const tools = []
  const dir = tempDir('zhuli-acklabel-')
  process.env.DSH_SUPERAGENT_STATE = dir
  process.env.DSH_SUPERAGENT_NO_POLL = '1'
  const ctx = {
    tools: { register: (tool) => tools.push(tool) },
    webServer: { register: () => () => {} },
    agents: { get: () => null, currentInitiator: () => ({ id: 'session-a' }) },
    get: () => null, on() {}, effect: (fn) => fn(), inject: () => {},
  }
  const mod = await import('../lib/index.js?acklabel=' + Date.now())
  mod.apply(ctx)
  const start = tools.find((t) => t.name === 'watch_start')
  await start.execute({ repo: 'acme/shared', ackLabel: '团队A:已处理' })
  const state = mod.__test.readState()
  const entry = Object.values(state.watchers)[0]
  assert.equal(entry.ackLabel, '团队A:已处理', '自定义标签要写进状态')

  // 不传时保持默认
  await start.execute({ repo: 'acme/other' })
  const after = mod.__test.readState()
  const other = Object.values(after.watchers).find((w) => w.repo === 'acme/other')
  assert.equal(other.ackLabel, '主理鱼:已处理', '不传就用默认标签')
})

test('gh 把 304 当失败时，不该记成错误（条件请求命中 ≠ 出错）', async () => {
  const { classifyGhError } = await import('../lib/gh-format.js')
  for (const text of ['gh: HTTP 304', 'HTTP 304 Not Modified']) {
    const why = classifyGhError(text)
    assert.equal(why.kind, 'notmodified', text + ' → ' + why.kind)
    assert.ok(/不是错误/.test(why.hint), '提示要说清这不是错误：' + why.hint)
  }
  // 304 不属于任何"要人动手"的分类
  const notActionable = ['auth', 'notfound', 'moved']
  for (const text of ['gh: HTTP 304']) {
    assert.ok(!notActionable.includes(classifyGhError(text).kind))
  }
})

test('暂停一条守时会清掉旧的错误（否则暂停后永远显示"异常"）', async () => {
  const tools = []
  const localRoutes = new Map()
  const dir = tempDir('zhuli-pause-')
  process.env.DSH_SUPERAGENT_STATE = dir
  process.env.DSH_SUPERAGENT_NO_POLL = '1'
  const ctx = {
    tools: { register: (tool) => tools.push(tool) },
    webServer: { register: (route) => { localRoutes.set(route.path, route); return () => {} } },
    agents: { get: () => null, currentInitiator: () => ({ id: 'session-pause' }) },
    get: () => null, on() {}, effect: (fn) => fn(), inject: () => {},
  }
  const mod = await import('../lib/index.js?pause=' + Date.now())
  mod.apply(ctx)
  await tools.find((t) => t.name === 'watch_start').execute({ repo: 'acme/pause' })

  // 先造一个错误（模拟刚才那条 304 误报）
  const state = mod.__test.readState()
  const key = Object.keys(state.watchers)[0]
  state.watchers[key].lastError = 'gh: HTTP 304（没归类的错误）'
  state.watchers[key].deferReason = 'unchanged'
  mod.__test.writeState(state)

  // 在面板点「暂停」
  const route = localRoutes.get('/session-superagent/watch')
  const fakeRes = makeRes()
  const body = JSON.stringify({ id: key, repo: 'acme/pause', sessionId: 'session-pause', enabled: false })
  await route.handler(makeReq('POST', '/session-superagent/watch', body, { 'content-type': 'application/json' }), fakeRes)
  assert.ok(fakeRes.statusCode === 200 || fakeRes.statusCode === 201, 'POST 应成功：' + fakeRes.statusCode + ' ' + fakeRes.body.slice(0, 120))

  const after = mod.__test.readState()
  const entry = after.watchers[key]
  assert.equal(entry.enabled, false, '要真的暂停')
  assert.equal(entry.lastError, null, '旧错误要清掉')
  assert.equal(entry.deferReason, null, '旧的暂停原因也要清掉')
})

test('非错误状态码聚一遍：200/204/304 都不该被当成失败', async () => {
  const { classifyGhError, parseGhInclude } = await import('../lib/gh-format.js')
  const CRLF = String.fromCharCode(13, 10)
  const LF = String.fromCharCode(10)

  // 解析层：能从 gh --include 输出里认出状态码
  const notModified = parseGhInclude('HTTP/2.0 304 Not Modified' + CRLF + 'ETag: "abc"' + CRLF + CRLF)
  assert.equal(notModified.status, 304)
  assert.equal(notModified.etag, '"abc"')

  const ok = parseGhInclude('HTTP/2.0 200 OK' + CRLF + 'ETag: "def"' + CRLF + CRLF + '[{"number":1}]')
  assert.equal(ok.status, 200)
  // 这里以前只断言 body.includes('number') —— 整段未切开的输出当然也含 number，
  // 于是「头没被切掉」的 bug 一路绿灯。正文必须**只剩** JSON。
  assert.equal(ok.body, '[{"number":1}]', 'body 要只剩正文，不能把状态行/响应头带进来')

  // 真机 gh 2.103.3（Windows）的输出行尾是**混的**：状态行以 LF 结尾，响应头以 CRLF 结尾，
  // 于是头体之间是 "\r\n\r\n" —— 里面没有连续两个 LF。只认 "\n\n" 会切不开，
  // 正文变成「状态行 + 头 + JSON」，JSON.parse 必失败，面板报「不是合法 JSON：可能是代理干扰」。
  const realGh = 'HTTP/2.0 200 OK' + LF
    + 'content-type: application/json; charset=utf-8' + CRLF
    + 'etag: W/"abc"' + CRLF + CRLF
    + '[{"number":16,"title":"中文标题也不该被切坏"}]'
  const mixed = parseGhInclude(realGh)
  assert.equal(mixed.status, 200, '混合行尾也要认出状态码')
  assert.equal(mixed.etag, 'W/"abc"')
  assert.equal(mixed.body, '[{"number":16,"title":"中文标题也不该被切坏"}]')
  assert.doesNotThrow(() => JSON.parse(mixed.body), '正文必须是能直接 JSON.parse 的纯 JSON')

  const noContent = parseGhInclude('HTTP/2.0 204 No Content' + CRLF + CRLF)
  assert.equal(noContent.status, 204)

  // 分类层：304 归 notmodified，且提示要说清「不是错误」
  const why = classifyGhError('gh: HTTP 304')
  assert.equal(why.kind, 'notmodified')
  assert.ok(why.hint.includes('不是错误'), '提示要直说不是错误：' + why.hint)
})

test('尊重 x-poll-interval：GitHub 要求更慢就照它等（解析 + 间隔下限）', async () => {
  const { parseGhInclude } = await import('../lib/gh-format.js')
  const CRLF = String.fromCharCode(13, 10)
  const withHeader = parseGhInclude('HTTP/2.0 200 OK' + CRLF + 'x-poll-interval: 90' + CRLF + CRLF + '[]')
  assert.equal(withHeader.pollInterval, 90, '要解析出 x-poll-interval')
  const without = parseGhInclude('HTTP/2.0 200 OK' + CRLF + CRLF + '[]')
  assert.equal(without.pollInterval, null, '没有这个头时是 null（不是 0）')

  // 间隔下限：min(配置, GitHub 要求) 取大者。
  // 审核 T23：这里以前是**测试自己算 Math.max** —— effectiveIntervalMs 一次没被调用，
  // 写反、写成 Math.min、忘了乘 1000，测试全绿。现在调真函数。
  const { nextDelayMs, effectiveIntervalMs } = await import('../lib/watch.js')
  const entry = { consecutiveFailures: 1, minIntervalSec: 90 }
  const base = 60000
  assert.equal(effectiveIntervalMs(entry, base), 90000, '下限应当是 90 秒（且乘了 1000）')
  assert.equal(effectiveIntervalMs({ minIntervalSec: 10 }, 300000), 300000, '自己更大时用自己的')
  assert.ok(nextDelayMs(entry, effectiveIntervalMs(entry, base)) >= 90000, '退避只在更大的方向上生效')
})

test('github 工具失败时带「下一步」与 kind（不再只贴原始 stderr）', async () => {
  const { formatGhCall, classifyGhError } = await import('../lib/gh-format.js')

  const notFound = formatGhCall({ code: 1, text: 'gh: HTTP 404 Not Found', classify: classifyGhError })
  assert.ok(notFound.includes('owner/name'), '404 要说下一步：' + notFound)
  assert.ok(notFound.includes('[kind: notfound]'), '要给出机器可读的 kind')

  const auth = formatGhCall({ code: 1, text: 'gh: HTTP 401 Bad credentials', classify: classifyGhError })
  assert.ok(auth.includes('gh auth login'), '登录失效要指出怎么修')
  assert.ok(auth.includes('[kind: auth]'))

  // 304：不是错误，别让调用方以为失败了
  const notModified = formatGhCall({ code: 1, text: 'gh: HTTP 304', classify: classifyGhError })
  assert.ok(notModified.includes('不是错误'), '304 要说清不是错误')
  assert.ok(notModified.includes('[kind: notmodified]'))

  // 成功：不追加 kind，保持轻量
  const ok = formatGhCall({ code: 0, text: '[{"number":1}]', classify: classifyGhError })
  assert.ok(ok.includes('[exit code: 0]'))
  assert.ok(!ok.includes('[kind:'), '成功时不该带 kind')
})

test('凭证失效时 doctor 要明说「不会自愈，需要重新登录」', async () => {
  const tools = []
  const dir = tempDir('zhuli-reauth-')
  process.env.DSH_SUPERAGENT_STATE = dir
  process.env.DSH_SUPERAGENT_NO_POLL = '1'
  const ctx = {
    tools: { register: (tool) => tools.push(tool) },
    webServer: { register: () => () => {} },
    agents: { get: () => null, currentInitiator: () => ({ id: 'session-reauth' }) },
    get: () => null, on() {}, effect: (fn) => fn(), inject: () => {},
  }
  const mod = await import('../lib/index.js?reauth=' + Date.now())
  mod.apply(ctx)
  await tools.find((t) => t.name === 'watch_start').execute({ repo: 'acme/reauth' })

  const state = mod.__test.readState()
  const key = Object.keys(state.watchers)[0]
  state.watchers[key].lastError = 'GitHub API 请求: 401（gh 登录失效：跑 gh auth login，或在面板填 token）'
  state.watchers[key].needsReauth = true
  mod.__test.writeState(state)

  const doctor = String(await tools.find((t) => t.name === 'watch_doctor').execute({}))
  assert.ok(doctor.includes('凭证失效'), 'doctor 要单独报凭证失效：' + doctor.slice(0, 300))
  assert.ok(doctor.includes('不会自己恢复'), '要说清不会自愈')
  assert.ok(doctor.includes('gh auth login'), '要给出具体动作')
})

test('连续失败很多次时，doctor 要解释「间隔已放慢」而不是让人以为卡住了', async () => {
  const tools = []
  const dir = tempDir('zhuli-budget-')
  process.env.DSH_SUPERAGENT_STATE = dir
  process.env.DSH_SUPERAGENT_NO_POLL = '1'
  const ctx = {
    tools: { register: (tool) => tools.push(tool) },
    webServer: { register: () => () => {} },
    agents: { get: () => null, currentInitiator: () => ({ id: 'session-budget' }) },
    get: () => null, on() {}, effect: (fn) => fn(), inject: () => {},
  }
  const mod = await import('../lib/index.js?budget=' + Date.now())
  mod.apply(ctx)
  await tools.find((t) => t.name === 'watch_start').execute({ repo: 'acme/budget' })

  const state = mod.__test.readState()
  const key = Object.keys(state.watchers)[0]
  state.watchers[key].consecutiveFailures = 8
  state.watchers[key].lastPoll = new Date().toISOString()
  state.server = { ...(state.server || {}), startedAt: new Date().toISOString() }
  mod.__test.writeState(state)

  const doctor = String(await tools.find((t) => t.name === 'watch_doctor').execute({}))
  assert.ok(doctor.includes('已连续失败 8 次'), '要报出失败次数：' + doctor.slice(0, 300))
  const { RETRY_SLOW_CAP_MINUTES } = await import('../lib/watch.js')
  assert.ok(doctor.includes(String(RETRY_SLOW_CAP_MINUTES / 60) + ' 小时'), '间隔文案要来自常量 ' + RETRY_SLOW_CAP_MINUTES)
})

test('gh 返回空内容时先查凭证，再谈代理（真机：令牌失效却怪代理）', async () => {
  const { diagnoseEmptyBody } = await import('../lib/gh-format.js')
  const invalidToken = 'X Failed to log in to github.com account MYCF711 (keyring)' + String.fromCharCode(10)
    + '  - The token in keyring is invalid.'
  const okAuth = 'github.com' + String.fromCharCode(10) + '  Logged in to github.com account me (keyring)'

  const auth = diagnoseEmptyBody({ bodyText: '', authStatusText: invalidToken })
  assert.equal(auth.kind, 'auth', '空内容 + 凭证失效 → 归 auth')
  assert.ok(auth.hint.includes('gh auth login'), '要直接给出修复动作：' + auth.hint)

  const empty = diagnoseEmptyBody({ bodyText: '', authStatusText: okAuth })
  assert.equal(empty.kind, 'empty', '凭证正常但内容为空 → 归 empty（代理/网络）')

  // 有内容就不该报诊断
  assert.equal(diagnoseEmptyBody({ bodyText: '[]', authStatusText: invalidToken }), null)
})

test('已知凭证失效时，工具直接拒绝发起请求（断路器的意思）', async () => {
  const tools = []
  const dir = tempDir('zhuli-breaker-')
  process.env.DSH_SUPERAGENT_STATE = dir
  process.env.DSH_SUPERAGENT_NO_POLL = '1'
  const ctx = {
    tools: { register: (tool) => tools.push(tool) },
    webServer: { register: () => () => {} },
    agents: { get: () => null, currentInitiator: () => ({ id: 'session-breaker' }) },
    get: () => null, on() {}, effect: (fn) => fn(), inject: () => {},
  }
  const mod = await import('../lib/index.js?breaker=' + Date.now())
  mod.apply(ctx)

  // 把一个"凭证失效"的结论塞进缓存（模拟刚才轮询时已经发现）
  mod.__test.setAuthStatusCache('X Failed to log in to github.com account u (keyring)' + String.fromCharCode(10) + '  - The token in keyring is invalid.')

  const out = String(await tools.find((t) => t.name === 'github').execute({ path: 'repos/o/r' }))
  assert.ok(out.includes('凭证已失效'), '要直接说凭证失效：' + out.slice(0, 200))
  assert.ok(out.includes('gh auth login'), '要给出修复动作')
  assert.ok(out.includes('没有发起请求'), '要说清这次没有真的调用')

  // 缓存清空后恢复正常调用路径（离线模式下会拿到桩数据，不再短路）
  mod.__test.setAuthStatusCache('')
  const ok = String(await tools.find((t) => t.name === 'github').execute({ path: 'repos/o/r' }))
  assert.ok(!ok.includes('凭证已失效'), '缓存清掉后不该再短路：' + ok.slice(0, 120))
})

test('断路器在 run() 里统一生效：ack 打标签等内部调用也一并短路', async () => {
  const tools = []
  const dir = tempDir('zhuli-breaker2-')
  process.env.DSH_SUPERAGENT_STATE = dir
  process.env.DSH_SUPERAGENT_NO_POLL = '1'
  const ctx = {
    tools: { register: (tool) => tools.push(tool) },
    webServer: { register: () => () => {} },
    agents: { get: () => null, currentInitiator: () => ({ id: 'session-breaker2' }) },
    get: () => null, on() {}, effect: (fn) => fn(), inject: () => {},
  }
  const mod = await import('../lib/index.js?breaker2=' + Date.now())
  mod.apply(ctx)
  await tools.find((t) => t.name === 'watch_start').execute({ repo: 'acme/b2' })

  mod.__test.setAuthStatusCache('  - The token in keyring is invalid.')

  // ack 要给 GitHub 打标签：凭证坏的情况下不该真的尝试，且要说明原因
  const ack = JSON.parse(await tools.find((t) => t.name === 'watch_ack').execute({ repo: 'acme/b2', number: 7, format: 'json' }))
  const text = JSON.stringify(ack)
  assert.ok(/凭证已失效|auth/i.test(text), 'ack 的结果要体现凭证失效：' + text.slice(0, 200))

  mod.__test.setAuthStatusCache('')
})

test('/state 顶层给 defaults：面板的默认值提示要从这里读', async () => {
  const tools = []
  const localRoutes = new Map()
  const dir = tempDir('zhuli-defaults-')
  process.env.DSH_SUPERAGENT_STATE = dir
  process.env.DSH_SUPERAGENT_NO_POLL = '1'
  const ctx = {
    tools: { register: (tool) => tools.push(tool) },
    webServer: { register: (route) => { localRoutes.set(route.path, route); return () => {} } },
    agents: { get: () => null, currentInitiator: () => ({ id: 'session-defaults' }) },
    get: () => null, on() {}, effect: (fn) => fn(), inject: () => {},
  }
  const mod = await import('../lib/index.js?defaults=' + Date.now())
  mod.apply(ctx)
  const route = localRoutes.get('/session-superagent/state')
  const res = makeRes()
  await route.handler(makeReq('GET', '/session-superagent/state', undefined, {}), res)
  const body = JSON.parse(res.chunks.join(''))
  assert.deepEqual(body.defaults, { sessionMaxWakes: 12, maxWakesPerHour: 6, isolateKeepDays: 3, batchLimit: 5 })
})

test('面板术语表里写死的 6/12 必须等于服务端默认值（两边不能各写一份）', async () => {
  const tools = []
  const localRoutes = new Map()
  const dir = tempDir('zhuli-glossary-')
  process.env.DSH_SUPERAGENT_STATE = dir
  process.env.DSH_SUPERAGENT_NO_POLL = '1'
  const ctx = {
    tools: { register: (tool) => tools.push(tool) },
    webServer: { register: (route) => { localRoutes.set(route.path, route); return () => {} } },
    agents: { get: () => null, currentInitiator: () => ({ id: 'session-gloss' }) },
    get: () => null, on() {}, effect: (fn) => fn(), inject: () => {},
  }
  const mod = await import('../lib/index.js?gloss=' + Date.now())
  mod.apply(ctx)
  const res = makeRes()
  await localRoutes.get('/session-superagent/state').handler(makeReq('GET', '/session-superagent/state', undefined, {}), res)
  const body = JSON.parse(res.chunks.join(''))
  const { readFileSync } = await import('node:fs')
  const client = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  const glossary = (client.match(/'两种：单条守每小时最多 (\d+) 次、整条会话 (\d+) 次/) || [])
  assert.ok(glossary.length === 3, '术语表那句必须还在（否则这条守卫失效）')
  assert.equal(Number(glossary[1]), body.defaults.maxWakesPerHour, '单守上限要与默认值一致')
  assert.equal(Number(glossary[2]), body.defaults.sessionMaxWakes, '会话上限要与默认值一致')
})

test('代理返回网页而不是 JSON：要明说是"被拦截"，不是"代理干扰"这种含糊话', async () => {
  const { diagnoseBadBody } = await import('../lib/gh-format.js')
  const html = '<!DOCTYPE html><html><body><h1>502 Bad Gateway</h1></body></html>'
  const why = diagnoseBadBody({ bodyText: html })
  assert.equal(why.kind, 'gateway')
  assert.ok(why.hint.includes('网页'), '要说清收到的是网页：' + why.hint)
  assert.ok(why.hint.includes('代理'), '要指向代理设置')

  // 合法 JSON 不该报
  // 本地切分错误：正文以 HTTP 状态行开头，不该被当成代理问题（真机踩过两次）
  const localParse = diagnoseBadBody({ bodyText: 'HTTP/2.0 200 OK' + String.fromCharCode(10) + 'content-type: application/json' + String.fromCharCode(10) + '[{"number":1}]' })
  assert.equal(localParse && localParse.kind, 'local-parse', '状态行开头的正文应判为本地解析问题')
  assert.ok(!/代理/.test((localParse && localParse.hint) || ''), '不要再把本地解析错误说成代理问题：' + (localParse && localParse.hint))
  assert.equal(diagnoseBadBody({ bodyText: 'HTTP/1.1 404 Not Found' })?.kind, 'local-parse', 'HTTP/1.1 变体也要认')
  assert.equal(diagnoseBadBody({ bodyText: '[]' }), null)

  // 空内容仍然走原来的判断（凭证优先）
  const auth = diagnoseBadBody({ bodyText: '', authStatusText: 'token in keyring is invalid' })
  assert.equal(auth.kind, 'auth')
})
test('ghConfigDir：路由只收绝对路径，摘要只回「配没配」（吸收自 PR #7）', () => {
  const src = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')
  // ① 相对路径必须被拒：它会随 cwd 漂移，把设置指向一个不存在的地方
  assert.ok(src.includes('ghConfigDir must be absolute'), '要拒绝相对路径')
  assert.ok(/if \(!isAbsolute\(dir\)\) return json\(res, 400/.test(src), '拒绝要发生在写盘之前')
  // ② 摘要里只能有 configured / none，不能把路径回显出去
  assert.ok(/ghConfigDir: s\.ghConfigDir \? 'configured' : 'none'/.test(src), '只回配置状态')
  assert.ok(!/ghConfigDir: s\.ghConfigDir \? s\.ghConfigDir/.test(src), '不许回显路径')
  // ③ 空串等于清除（回到宿主账号）
  assert.ok(/if \(dir === ''\) delete next\.ghConfigDir/.test(src), '空串要能清除')
})

test('手改成 enabled:"false" / 0 的守要真的算暂停（不能只看 === false）', async () => {
  // 真机踩过：watchers.json 是人也会手改的文件，写成字符串 "false" 时守照常轮询。
  const original = readFileSync(join(STATE_DIR, 'watchers.json'), 'utf8')
  try {
    writeFileSync(join(STATE_DIR, 'watchers.json'), JSON.stringify({
      watchers: {
        'o/str#s1': { id: 'o/str#s1', repo: 'o/str', sessionId: 's1', intervalSec: 60, enabled: 'false', seen: {}, lastReported: {} },
        'o/zero#s1': { id: 'o/zero#s1', repo: 'o/zero', sessionId: 's1', intervalSec: 60, enabled: 0, seen: {}, lastReported: {} },
      },
    }, null, 2))
    const snap = (await call('GET', '/session-superagent/state')).json()
    const byRepo = new Map((snap.watchers || []).map((w) => [w.repo, w]))
    assert.equal(byRepo.get('o/str').enabled, false, 'enabled:"false" 必须是暂停')
    assert.equal(byRepo.get('o/zero').enabled, false, 'enabled:0 必须是暂停')
  } finally {
    writeFileSync(join(STATE_DIR, 'watchers.json'), original)
  }
})

test('跨站写操作必须 403（T19：任意网页 text/plain 简单请求就能删守/清凭证）', async () => {
  const post = (path, body, headers = {}) => call('POST', path, body, headers)
  // 带恶意 Origin：拒绝
  const evil = await post('/session-superagent/watch', { action: 'delete', id: 'x#y' }, { origin: 'https://evil.example' })
  assert.equal(evil.statusCode, 403, '跨站写操作必须 403')
  assert.match(String(evil.json().error || ''), /cross-origin/)
  // 带本机 Origin：放行（未知 id 会走到正常错误路径）
  const local = await post('/session-superagent/watch', { action: 'delete', id: 'x#y' }, { origin: 'http://127.0.0.1:65466' })
  assert.notEqual(local.statusCode, 403, '本机来源不该被挡')
  // 不带 Origin（curl / 测试）：放行
  const none = await post('/session-superagent/watch', { action: 'delete', id: 'x#y' })
  assert.notEqual(none.statusCode, 403, '非浏览器客户端不该被挡')
})

test('守数量有上限（T19：100 次 POST 就是 100 条守，每条一个定时器）', async () => {
  // 直接把状态文件写成「已经 20 条」，再建第 21 条
  const stateFile = join(STATE_DIR, 'watchers.json')
  const original = readFileSync(stateFile, 'utf8')
  try {
    const watchers = {}
    for (let i = 0; i < 20; i += 1) {
      watchers['o/r' + i + '#s1'] = { id: 'o/r' + i + '#s1', repo: 'o/r' + i, sessionId: 's1', intervalSec: 60, enabled: true, seen: {}, lastReported: {} }
    }
    writeFileSync(stateFile, JSON.stringify({ watchers }, null, 2))
    const res = await call('POST', '/session-superagent/watch', { repo: 'o/new', sessionId: 's1' })
    assert.equal(res.statusCode, 429, '第 21 条必须被拒')
    assert.match(String(res.json().error || ''), /最多同时挂/)
    // 审核 T40 M1：已暂停的不该占名额 —— 停一条之后必须能再加
    const stopped = JSON.parse(readFileSync(stateFile, 'utf8'))
    stopped.watchers['o/r0#s1'].enabled = false
    writeFileSync(stateFile, JSON.stringify(stopped, null, 2))
    const again = await call('POST', '/session-superagent/watch', { repo: 'o/new', sessionId: 's1' })
    assert.ok(again.statusCode !== 429, '停掉一条之后面板应当能再加，实际 ' + again.statusCode)
  } finally {
    writeFileSync(stateFile, original)
  }
})

test('sessionId 超长要拒绝（T19：它进 id、进状态文件、进唤醒消息）', async () => {
  const res = await call('POST', '/session-superagent/watch', { repo: 'o/r', sessionId: 'x'.repeat(201) })
  assert.equal(res.statusCode, 400)
  assert.match(String(res.json().error || ''), /too long/)
})

test('Gitee 令牌形状不对要拒绝（别把垃圾存成凭证）', async () => {
  const res = await call('POST', '/session-superagent/credentials', { giteeToken: 'not-a-token' })
  assert.equal(res.statusCode, 400)
  assert.match(String(res.json().error || ''), /32 位十六进制/)
})

test('凭证写入校验：sshKeyPath 必须绝对、ghConfigDir 必须绝对（T20：以前只有一个 grep 源码的测试在守）', async () => {
  const rel = await call('POST', '/session-superagent/credentials', { sshKeyPath: 'relative/key' })
  assert.equal(rel.statusCode, 400, '相对路径必须被拒')
  const relDir = await call('POST', '/session-superagent/credentials', { ghConfigDir: 'relative/dir' })
  assert.equal(relDir.statusCode, 400, 'ghConfigDir 相对路径必须被拒')
  // 清空是合法的
  const cleared = await call('POST', '/session-superagent/credentials', { token: '', sshKeyPath: '', ghConfigDir: '' })
  assert.equal(cleared.statusCode, 200)
})

test('状态路径是惰性的：同一个实例改 env 之后立刻生效（T30：以前模块加载时就定死了）', async () => {
  const mod = await import('../lib/index.js?lazy=' + Date.now())
  const first = tempDir('lazy-a-')
  const second = tempDir('lazy-b-')
  process.env.DSH_SUPERAGENT_STATE = first
  mod.__test.writeState({ watchers: { 'a/x#s': { id: 'a/x#s', repo: 'a/x', sessionId: 's' } } })
  // 只换 env，**不重新 import** —— 惰性实现下这应该立刻指向新目录
  process.env.DSH_SUPERAGENT_STATE = second
  const state = mod.__test.readState()
  assert.equal(Object.keys(state.watchers || {}).length, 0, '换目录后不该还读到上一个目录的内容')
  mod.__test.writeState({ watchers: { 'b/y#s': { id: 'b/y#s', repo: 'b/y', sessionId: 's' } } })
  assert.ok(existsSync(join(second, 'watchers.json')), '应该写到新目录')
  assert.ok(existsSync(join(first, 'watchers.json')), '老目录的文件还在（没被搬走）')
})

test('format:json 时错误也必须是结构化的（T32 M2：纯文本让 JSON.parse 直接抛错）', async () => {
  const tools = []
  const dir = tempDir('zhuli-jsonerr-')
  process.env.DSH_SUPERAGENT_STATE = dir
  process.env.DSH_SUPERAGENT_NO_POLL = '1'
  const ctx = {
    tools: { register: (tool) => tools.push(tool) },
    webServer: { register: () => () => {} },
    agents: { get: () => null, currentInitiator: () => ({ id: 'session-jsonerr' }) },
    get: () => null, effect: (fn) => fn(), inject: () => {},
  }
  const mod = await import('../lib/index.js?jsonerr=' + Date.now())
  mod.apply(ctx)
  const ack = tools.find((t) => t.name === 'watch_ack')
  const res = String(await ack.execute({ repo: 'acme/none', format: 'json' }))
  const parsed = JSON.parse(res) // 抛错就说明还是纯文本
  assert.equal(parsed.ok, false, '要明确说失败')
  assert.ok(parsed.error, '要带 error 字段')
  assert.equal(parsed.schemaVersion, 1)
})

test('watch_stop 认「带 gitee: 前缀」和「不带」两种写法（T32 M1：照 watch_status 的 JSON 调必然失败）', async () => {
  const tools = []
  const dir = tempDir('zhuli-giteestop-')
  process.env.DSH_SUPERAGENT_STATE = dir
  process.env.DSH_SUPERAGENT_NO_POLL = '1'
  const ctx = {
    tools: { register: (tool) => tools.push(tool) },
    webServer: { register: () => () => {} },
    agents: { get: () => null, currentInitiator: () => ({ id: 'session-gs' }) },
    get: () => null, effect: (fn) => fn(), inject: () => {},
  }
  const mod = await import('../lib/index.js?gs=' + Date.now())
  mod.apply(ctx)
  const start = tools.find((t) => t.name === 'watch_start')
  const stop = tools.find((t) => t.name === 'watch_stop')
  await start.execute({ repo: 'gitee:acme/gone' })
  // 不带前缀（watch_status 的 JSON 就是这么给的）也必须能停掉
  const out = String(await stop.execute({ repo: 'acme/gone' }))
  assert.match(out, /stopped/, '应当停成功，实际：' + out)
})

test('停掉一条守之后能再挂新的（T32 M3：上限把 watch_stop 卡成死结）', async () => {
  const tools = []
  const dir = tempDir('zhuli-cap-')
  process.env.DSH_SUPERAGENT_STATE = dir
  process.env.DSH_SUPERAGENT_NO_POLL = '1'
  const ctx = {
    tools: { register: (tool) => tools.push(tool) },
    webServer: { register: () => () => {} },
    agents: { get: () => null, currentInitiator: () => ({ id: 'session-cap' }) },
    get: () => null, effect: (fn) => fn(), inject: () => {},
  }
  const mod = await import('../lib/index.js?cap=' + Date.now())
  mod.apply(ctx)
  const start = tools.find((t) => t.name === 'watch_start')
  const stop = tools.find((t) => t.name === 'watch_stop')
  for (let i = 0; i < 20; i += 1) await start.execute({ repo: 'cap/r' + i })
  const over = String(await start.execute({ repo: 'cap/over' }))
  assert.match(over, /最多同时挂/, '第 21 条该被拒，实际：' + over)
  await stop.execute({ repo: 'cap/r0' })
  const again = String(await start.execute({ repo: 'cap/over' }))
  assert.match(again, /watching/, '停掉一条后应当能加，实际：' + again)
})

test('编号带 # 时不能报「没给」（T33 M1：假报错会让这条 issue 永远关不掉）', async () => {
  const tools = []
  const dir = tempDir('zhuli-hashnum-')
  process.env.DSH_SUPERAGENT_STATE = dir
  process.env.DSH_SUPERAGENT_NO_POLL = '1'
  const ctx = {
    tools: { register: (tool) => tools.push(tool) },
    webServer: { register: () => () => {} },
    agents: { get: () => null, currentInitiator: () => ({ id: 'session-hash' }) },
    get: () => null, effect: (fn) => fn(), inject: () => {},
  }
  const mod = await import('../lib/index.js?hash=' + Date.now())
  mod.apply(ctx)
  const trace = tools.find((t) => t.name === 'watch_trace')
  const ack = tools.find((t) => t.name === 'watch_ack')
  // 先挂一条守，否则会先报「no watcher」（那是另一个错误分支）
  await tools.find((t) => t.name === 'watch_start').execute({ repo: 'acme/hash' })
  for (const [name, tool, args] of [['watch_trace', trace, { number: '#14' }], ['watch_ack', ack, { number: '#14' }]]) {
    const out = String(await tool.execute(args))
    assert.ok(!/is required/.test(out), name + ' 不该说「没给」：' + out)
    assert.match(out, /# 号|去掉/, name + ' 要说清是写法问题：' + out)
  }
})

test('状态文件里有一个 null 守时，/state 与 /diagnose 不能整个崩（T37 M1：一个坏值 = 面板全灭）', async () => {
  const tools = []
  const localRoutes = new Map()
  const dir = tempDir('zhuli-nullentry-')
  process.env.DSH_SUPERAGENT_STATE = dir
  process.env.DSH_SUPERAGENT_NO_POLL = '1'
  const ctx = {
    tools: { register: (tool) => tools.push(tool) },
    webServer: { register: (route) => { localRoutes.set(route.path, route); return () => {} } },
    agents: { get: () => null, currentInitiator: () => ({ id: 'session-null' }) },
    get: () => null, on() {}, effect: (fn) => fn(), inject: () => {},
  }
  const mod = await import('../lib/index.js?nullentry=' + Date.now())
  mod.apply(ctx)
  // 手写一份「有 null 值 + 字段类型坏掉」的状态文件
  writeFileSync(join(dir, 'watchers.json'), JSON.stringify({
    watchers: {
      'a/b#s': { id: 'a/b#s', repo: 'a/b', sessionId: 's', intervalSec: 60, enabled: true },
      broken: null,
      'c/d#s': { id: 'c/d#s', repo: 'c/d', sessionId: 's', intervalSec: 60, enabled: true, filteredLog: 42, events: 'x', history: 7 },
    },
  }, null, 2))

  for (const [path, label] of [['/session-superagent/state', '/state'], ['/session-superagent/diagnose', '/diagnose']]) {
    const route = localRoutes.get(path)
    const res = makeRes()
    await route.handler(makeReq('GET', path, undefined, {}), res)
    const text = res.chunks.join('')
    assert.ok(!/Cannot read properties of null/.test(text), label + ' 不该抛 null 异常：' + text.slice(0, 200))
    assert.ok(res.statusCode === undefined || res.statusCode < 500, label + ' 不该 5xx：' + String(res.statusCode))
  }
})

test('allowAuthors 要走通真实链路（T40 M2：只用 filterReason 测，测不出 mergeFilters 漏了键）', async () => {
  const tools = []
  const dir = tempDir('zhuli-allow-')
  process.env.DSH_SUPERAGENT_STATE = dir
  process.env.DSH_SUPERAGENT_NO_POLL = '1'
  const ctx = {
    tools: { register: (tool) => tools.push(tool) },
    webServer: { register: () => () => {} },
    agents: { get: () => null, currentInitiator: () => ({ id: 'session-allow' }) },
    get: () => null, on() {}, effect: (fn) => fn(), inject: () => {},
  }
  const mod = await import('../lib/index.js?allow=' + Date.now())
  mod.apply(ctx)
  const start = tools.find((t) => t.name === 'watch_start')
  const out = String(await start.execute({ repo: 'acme/allow', allowAuthors: ['@Alice', 'bob'] }))
  assert.match(out, /watching/, out)
  // 真的落到状态文件里了吗（以前这里静默丢成 []，而用例全绿）
  const state = JSON.parse(readFileSync(join(dir, 'watchers.json'), 'utf8'))
  const entry = Object.values(state.watchers)[0]
  assert.deepEqual(entry.filters.allowAuthors, ['Alice', 'bob'], '作者名单必须真的存下来：' + JSON.stringify(entry.filters))
})

test('面板填错 activeHours 要被拒（T40：HTTP 路径以前原样收下 = 静默全天有效）', async () => {
  const tools = []
  const localRoutes = new Map()
  const dir = tempDir('zhuli-hours-http-')
  process.env.DSH_SUPERAGENT_STATE = dir
  process.env.DSH_SUPERAGENT_NO_POLL = '1'
  const ctx = {
    tools: { register: (tool) => tools.push(tool) },
    webServer: { register: (route) => { localRoutes.set(route.path, route); return () => {} } },
    agents: { get: () => null, currentInitiator: () => ({ id: 'session-h' }) },
    get: () => null, on() {}, effect: (fn) => fn(), inject: () => {},
  }
  const mod = await import('../lib/index.js?hh=' + Date.now())
  mod.apply(ctx)
  const res = makeRes()
  await localRoutes.get('/session-superagent/watch').handler(
    makeReq('POST', '/session-superagent/watch', JSON.stringify({ repo: 'a/b', activeHours: '9-23', sessionId: 'session-h' })), res)
  const text = res.chunks.join('')
  assert.equal(res.statusCode, 400, '非法格式要 400，实际 ' + res.statusCode + ' / ' + text.slice(0, 100))
  assert.match(text, /HH:MM/, '要说明正确格式')
  // 合法格式：先建一条守（走工具，不联网），再用 HTTP 改 activeHours（编辑路径不触发 precheckRepo）
  await tools.find((t) => t.name === 'watch_start').execute({ repo: 'a/b' })
  const ok = makeRes()
  await localRoutes.get('/session-superagent/watch').handler(
    makeReq('POST', '/session-superagent/watch', JSON.stringify({ repo: 'a/b', activeHours: '09:00-23:00', sessionId: 'session-h' })), ok)
  assert.ok(ok.statusCode === undefined || ok.statusCode < 400, '合法格式不该被拒：' + ok.chunks.join('').slice(0, 120))
  const after = JSON.parse(readFileSync(join(dir, 'watchers.json'), 'utf8'))
  assert.equal(Object.values(after.watchers)[0].activeHours, '09:00-23:00', '合法值要真的存下来')
})

test('watch_start 恢复暂停的守要在回执里说明（T40 W12：不许静默恢复）', async () => {
  const tools = []
  const dir = tempDir('zhuli-resume-')
  process.env.DSH_SUPERAGENT_STATE = dir
  process.env.DSH_SUPERAGENT_NO_POLL = '1'
  const ctx = {
    tools: { register: (tool) => tools.push(tool) },
    webServer: { register: () => () => {} },
    agents: { get: () => null, currentInitiator: () => ({ id: 'session-r' }) },
    get: () => null, on() {}, effect: (fn) => fn(), inject: () => {},
  }
  const mod = await import('../lib/index.js?rs=' + Date.now())
  mod.apply(ctx)
  const start = tools.find((t) => t.name === 'watch_start')
  const stop = tools.find((t) => t.name === 'watch_stop')
  await start.execute({ repo: 'a/b' })
  await stop.execute({ repo: 'a/b' })
  const out = String(await start.execute({ repo: 'a/b', labels: ['bug'] }))
  assert.match(out, /之前是暂停的/, '回执必须说「之前是暂停的」：' + out)
  assert.match(out, /已恢复/, '要说清已恢复')
  // resume:false = 只改配置，保持暂停
  await stop.execute({ repo: 'a/b' })
  const quiet = String(await start.execute({ repo: 'a/b', labels: ['bug', 'p1'], resume: false }))
  assert.match(quiet, /保持暂停/, 'resume:false 要说明仍暂停：' + quiet)
  const state = JSON.parse(readFileSync(join(dir, 'watchers.json'), 'utf8'))
  const entry = Object.values(state.watchers)[0]
  assert.equal(entry.enabled, false, 'resume:false 时不能悄悄恢复')
  assert.deepEqual(entry.filters.labels, ['bug', 'p1'], '但配置要真的改上')
})

test('HTTP 与工具的 intervalSec 都先取整再夹取（T40 W7：30.7 不能一路存成 30.7）', async () => {
  const start = tools.find((t) => t.name === 'watch_start')
  await start.execute({ repo: 'acme/round' })
  const res = await call('POST', '/session-superagent/watch', {
    repo: 'acme/round', sessionId: 'session-test', intervalSec: 30.7,
  })
  assert.equal(res.statusCode, 200, res.body)
  const state = JSON.parse(readFileSync(join(STATE_DIR, 'watchers.json'), 'utf8'))
  const entry = state.watchers['acme/round#session-test']
  assert.equal(entry.intervalSec, 31, 'HTTP 必须与 watch_start 一样取整')
  await call('POST', '/session-superagent/watch', { action: 'delete', id: 'acme/round#session-test' })
})
