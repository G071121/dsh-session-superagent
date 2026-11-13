# PR 响应监控 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 监控我们通过 fork 提给他人的 open PR 的新讨论评论，检测到后唤醒当前会话继续处理（改代码 → 可选审计 → 提交 → 回评），同时支持 GitHub 与 Gitee。

**Architecture:** 复用 `~/.dsh/state/session-superagent/watchers.json`，新 watcher 用 `pr:` 前缀的 key 与现有 issue watcher 隔离。轮询走现有 `startWatcher` 的 `tick` 调度，但 `pollOnce` 增加一个 PR 分支：先列出 base 仓库里 `author=我们` 的 open PR，再逐 PR 比对评论水位（`seenComments[number]`），有非本人新评论就 `Agent.followup(结构化消息)`。插件**只读**——不评论、不加标签、不改状态，回评由会话自己用 `gh pr comment` / `gitee api` 完成。

**Tech Stack:** Node 22 ESM、`node --test`、GitHub GraphQL（`gh api graphql`）、Gitee REST v5（`gitee api`）、DSH 原生面板（client.js，无框架 Hooks 风格）。

**Spec:** `docs/设计-PR响应监控.md`

## Global Constraints

- 版本基线 **0.10.12**；全量测试 **992/992**、preflight **42 项 = 41 PASS / 1 SKIP**、UI **11/11**、真实 Chromium **72/72**。任一项退化都视为失败。
- 所有 `.js` 文件必须 **LF 行尾**（本地 `core.autocrlf=true` 会把测试搞红；`test/client.test.mjs` 的 needle 硬编码 `\n`）。
- 测试必须可离线：`npm test` 走 `scripts/test.mjs`，默认设置 `DSH_SUPERAGENT_NO_POLL=1`；裸 `node --test` 会真去 spawn `gh`。
- 只读约束：PR 监控不得调用任何写接口（评论/标签/状态/合并）。
- 面板 UI：复用 DSH 官方结构树与 `--dsw-alias-*` token，**不得**手画组件或写死颜色；改 `client.js` 必须出双主题图 + `ui-audit` 100 分。
- 文案：用户可见文案改动要同步 `scripts/render-panel-copy.mjs` 快照（`--write`）。
- 文档：新增文档后跑 `node scripts/check-docs.mjs`，索引总数要跟着改。
- 没有实测的不得写成「通过」（AGENTS.md 第十节）。

## Review Focus

1. **`headRepository` 为 `null`**（fork 已被删除）——GraphQL 会返回 `null`，`isForkPr` 不能抛异常，应视为「非 fork PR」跳过。
2. **Gitee 评论 `id` 可能是字符串**——`Number(comment.id)` 才能做数值比较，否则 `'999' > 1000` 是 `true`（字符串比较）。
3. **账号大小写**——GitHub 登录名大小写不敏感（`iJetLi` vs `ijetli`），`normalizeSelf` 必须 `toLowerCase()` 后再比。
4. **会话忙碌**——`Agent.followup` 在会话忙时进 `wakeQueues` 排队；排队失败时必须**不推进水位**，否则评论永久丢失。
5. **同一条评论重复唤醒**——ETag 304 早退、`inFlight` 并发闸、退避窗口三条路径都必须在**不推进 `seenComments`** 的前提下返回。

---

### Task 1: PR 监控核心纯函数

**Files:**
- Create: `lib/pr-watch.js`
- Test: `test/pr-watch.test.mjs`

**Interfaces:**
- Produces:
  - `normalizeSelf(login: string): string` — 去 `@`、trim、`toLowerCase()`
  - `isForkPr(pr: { headRepo: string|null, baseRepo: string|null }): boolean` — 两边都非空且不相等才为 `true`
  - `pickNewComments(comments: Array<{ id: number, author: string, body: string, createdAt: string }>, seenId: number): Array` — 返回 `id > seenId` 的评论（`seenId` 为 0/undefined 时返回全部）
  - `shouldWake(comments: Array, self: string): boolean` — 任一评论 `normalizeSelf(author) !== normalizeSelf(self)` 即为 `true`
  - `buildPrWakeText(opts: { base: string, number: number, title: string, branch: string, self: string, comments: Array, goal?: string }): string` — 结构化唤醒消息
  - `pruneSeen(seen: Record<string, number>, openNumbers: number[]): Record<string, number>` — 只保留仍 open 的 PR
  - `advanceSeen(seen: Record<string, number>, updates: Array<{ number: number, latestId: number }>): Record<string, number>` — 合并水位（取较大值）

- [ ] **Step 1: 写失败测试**

`test/pr-watch.test.mjs`，至少覆盖：

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { normalizeSelf, isForkPr, pickNewComments, shouldWake, buildPrWakeText, pruneSeen, advanceSeen } from '../lib/pr-watch.js'

test('normalizeSelf 去 @ 并小写', () => {
  assert.equal(normalizeSelf('@iJetLi '), 'ijetli')
  assert.equal(normalizeSelf(''), '')
})

test('isForkPr：head 与 base 不同才是 fork', () => {
  assert.equal(isForkPr({ headRepo: 'iJetLi/repo', baseRepo: 'MYCF711/repo' }), true)
  assert.equal(isForkPr({ headRepo: 'MYCF711/repo', baseRepo: 'MYCF711/repo' }), false)
  assert.equal(isForkPr({ headRepo: null, baseRepo: 'MYCF711/repo' }), false)  // fork 已删
})

test('pickNewComments 按 id 水位过滤', () => {
  const comments = [{ id: 1 }, { id: 5 }, { id: 9 }]
  assert.deepEqual(pickNewComments(comments, 5).map((c) => c.id), [9])
  assert.equal(pickNewComments(comments, 0).length, 3)
  assert.equal(pickNewComments(comments, 100).length, 0)
})

test('pickNewComments 兼容字符串 id', () => {
  const comments = [{ id: '10' }, { id: '2' }]
  assert.deepEqual(pickNewComments(comments, 5).map((c) => Number(c.id)), [10])
})

test('shouldWake：只有非本人评论才叫醒', () => {
  assert.equal(shouldWake([{ author: 'MYCF711' }], 'iJetLi'), true)
  assert.equal(shouldWake([{ author: 'iJetLi' }], 'iJetLi'), false)
  assert.equal(shouldWake([{ author: '@iJetLi' }], 'ijetli'), false)  // 大小写/@ 不敏感
})

test('buildPrWakeText 带 PR 号、评论者、正文', () => {
  const text = buildPrWakeText({
    base: 'MYCF711/repo', number: 48, title: 'fix: xxx', branch: 'fix/a',
    self: 'iJetLi', comments: [{ author: 'MYCF711', body: '这里漏了边界', createdAt: '2026-11-13T04:32:15Z' }],
    goal: '改完回评',
  })
  assert.match(text, /#48/)
  assert.match(text, /MYCF711/)
  assert.match(text, /这里漏了边界/)
  assert.match(text, /改完回评/)
})

test('pruneSeen 移除已关闭 PR', () => {
  assert.deepEqual(pruneSeen({ 48: 9, 41: 7 }, [48]), { 48: 9 })
})

test('advanceSeen 取较大水位', () => {
  assert.deepEqual(advanceSeen({ 48: 5 }, [{ number: 48, latestId: 9 }, { number: 50, latestId: 3 }]), { 48: 9, 50: 3 })
  assert.deepEqual(advanceSeen({ 48: 9 }, [{ number: 48, latestId: 5 }]), { 48: 9 })  // 不回退
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test test/pr-watch.test.mjs`
Expected: FAIL — `Cannot find module '../lib/pr-watch.js'`

- [ ] **Step 3: 实现 `lib/pr-watch.js`**

纯函数，无 I/O、无 `Date.now()`（时间由调用方传），便于测试。`buildPrWakeText` 的格式固定为：

```text
【PR 响应】MYCF711/repo#48 有 2 条新评论

PR: fix: 唤醒只推进…
分支: fix/a
评论者: MYCF711（非本人）
时间: 2026-11-13T04:32:15Z

> 这里漏了边界

处理建议: 阅读评论 → 修改代码 → 自审 → 提交 → 回评
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test test/pr-watch.test.mjs`
Expected: PASS（8 个用例全绿）

- [ ] **Step 5: 提交**

```bash
git add lib/pr-watch.js test/pr-watch.test.mjs
git commit -m "feat(pr-watch): 新增 PR 评论水位与唤醒消息纯函数"
```

---

### Task 2: GitHub GraphQL 查询构造与解析

**Files:**
- Modify: `lib/gh-format.js`（文件末尾追加）
- Test: `test/gh-format.test.mjs`（追加用例）

**Interfaces:**
- Consumes: 无
- Produces:
  - `buildPrSearchQuery({ base: string, first?: number }): string` — 返回完整 GraphQL 查询串
  - `parsePrSearch(stdout: string): { ok: boolean, prs?: Array<{ number, title, isDraft, headRepo, baseRepo, comments }>, error?: string }`
  - `formatPrCommentLine(comment: { author, createdAt, body }): string`

**关键点（已实测）**：评论 id **必须用 `databaseId`**（`id` 是 base64 node id，不能比大小）。查询串固定为：

```graphql
query{search(query:"repo:MYCF711/repo is:pr is:open author:@me",type:ISSUE,first:20){nodes{... on PullRequest{number title isDraft headRepository{nameWithOwner} baseRepository{nameWithOwner} comments(last:10){nodes{databaseId author{login} createdAt body}}}}}}
```

- [ ] **Step 1: 写失败测试**

追加到 `test/gh-format.test.mjs`：

```js
test('buildPrSearchQuery 带 repo 与 author:@me', () => {
  const q = buildPrSearchQuery({ base: 'MYCF711/repo' })
  assert.match(q, /repo:MYCF711\/repo/)
  assert.match(q, /is:pr/)
  assert.match(q, /author:@me/)
  assert.match(q, /databaseId/)          // 必须是 databaseId，不是 id
})

test('parsePrSearch 解析真实返回形状', () => {
  const stdout = JSON.stringify({ data: { search: { nodes: [{
    number: 48, title: 'fix', isDraft: false,
    headRepository: { nameWithOwner: 'iJetLi/repo' },
    baseRepository: { nameWithOwner: 'MYCF711/repo' },
    comments: { nodes: [{ databaseId: 6843186090, author: { login: 'MYCF711' }, createdAt: '2026-11-13T03:46:07Z', body: 'ok' }] },
  }] } } })
  const out = parsePrSearch(stdout)
  assert.equal(out.ok, true)
  assert.equal(out.prs.length, 1)
  assert.equal(out.prs[0].headRepo, 'iJetLi/repo')
  assert.equal(out.prs[0].comments[0].id, 6843186090)   // databaseId → id
})

test('parsePrSearch 坏 JSON 返回 ok:false', () => {
  assert.equal(parsePrSearch('not json').ok, false)
  assert.equal(parsePrSearch('').ok, false)
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test test/gh-format.test.mjs`
Expected: FAIL — `buildPrSearchQuery is not a function`

- [ ] **Step 3: 实现三个函数**

`parsePrSearch` 必须做**防御性归一**：`headRepository` / `baseRepository` 为 `null` 时输出 `headRepo: null` / `baseRepo: null`（不抛异常）；`comments.nodes` 缺失时输出 `[]`；`databaseId` 统一转成 `Number`。

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test test/gh-format.test.mjs`
Expected: PASS（原有用例 + 3 个新用例）

- [ ] **Step 5: 提交**

```bash
git add lib/gh-format.js test/gh-format.test.mjs
git commit -m "feat(gh-format): PR 搜索查询构造与解析"
```

---

### Task 3: Gitee PR 列表与评论

**Files:**
- Modify: `lib/gitee.js`（文件末尾追加）
- Test: `test/gitee.test.mjs`（追加用例）

**Interfaces:**
- Consumes: 现有 `giteeRequest` / `giteeApi`（先读 `lib/gitee.js` 确认内部请求函数名与签名）
- Produces:
  - `listGiteePrs({ repo: string, token: string, author?: string, perPage?: number, fetchImpl?: Function }): Promise<{ ok: boolean, prs?: Array<{ number, title, draft, headRepo, baseRepo, headLogin, headRef }>, status?: number, error?: string }>`
  - `fetchGiteePrComments({ repo: string, token: string, number: number, perPage?: number, fetchImpl?: Function }): Promise<{ ok: boolean, comments?: Array<{ id: number, author: string, body: string, createdAt: string }>, status?: number, error?: string }>`

**端点（已实测）**：
- 列表：`GET /repos/{base}/pulls?state=open&author={self}&per_page=100&sort=updated&direction=desc`
- 评论：`GET /repos/{base}/pulls/{n}/comments?comment_type=pr_comment&direction=desc&per_page=10`

**坑**：`gitee api -q/--quiet` 会吞掉正常输出，不要加；输出末尾带更新提示，解析必须用 `json.JSONDecoder().raw_decode()` 等价策略（Node 侧用 `JSON.parse` 前截取第一个 `{`…`}`）。

- [ ] **Step 1: 写失败测试**

用 `fetchImpl` 注入假响应（不真打网络）：

```js
test('listGiteePrs 归一化 head/base 仓库', async () => {
  const fetchImpl = async () => ({
    ok: true, status: 200,
    text: async () => JSON.stringify([{ number: 9, title: 't', draft: false, head: { repo: { full_name: 'iJetLi/r' }, user: { login: 'iJetLi' }, ref: 'b' }, base: { repo: { full_name: 'o/r' } } }]),
  })
  const out = await listGiteePrs({ repo: 'o/r', token: 'x', author: 'iJetLi', fetchImpl })
  assert.equal(out.ok, true)
  assert.equal(out.prs[0].headRepo, 'iJetLi/r')
  assert.equal(out.prs[0].baseRepo, 'o/r')
})

test('listGiteePrs head.repo 为 null 时不崩', async () => { /* 返回 head:{} */ })
test('fetchGiteePrComments 把字符串 id 转数字', async () => { /* id: '123' → 123 */ })
test('fetchGiteePrComments 404 返回 ok:false', async () => { /* status 404 */ })
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test test/gitee.test.mjs`
Expected: FAIL — `listGiteePrs is not a function`

- [ ] **Step 3: 实现两个函数**

复用文件里现有的请求封装（先读 `lib/gitee.js` 找到 `giteeRequest` 或等价函数），不要新造 HTTP 层。

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test test/gitee.test.mjs`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add lib/gitee.js test/gitee.test.mjs
git commit -m "feat(gitee): PR 列表与评论端点"
```

---

### Task 4: 状态迁移

**Files:**
- Modify: `lib/state-migration.js`
- Test: `test/state-migration.test.mjs`（若不存在则新建；先 `ls test/` 确认）

**Interfaces:**
- Consumes: 现有 `migrateState(input)`
- Produces: `migratePrWatchers(state: object): object` — 给缺 `kind` 的 watcher 补 `kind: 'issue'`，给 `pr:` 前缀的补 `kind: 'pr'` + `seenComments: {}`；**幂等**

**背景**：`watchers.json` 是**人也会手改**的文件（AGENTS.md 坑 #1）。迁移必须容忍 `enabled: "false"` 这类字符串，且**不能**把未知字段丢掉（客户可能有自定义键）。

- [ ] **Step 1: 写失败测试**

```js
test('migratePrWatchers 给老 watcher 补 kind:issue', () => {
  const out = migratePrWatchers({ watchers: { 'o/r#s1': { repo: 'o/r' } } })
  assert.equal(out.watchers['o/r#s1'].kind, 'issue')
})

test('migratePrWatchers 给 pr: 前缀补 kind:pr 与 seenComments', () => {
  const out = migratePrWatchers({ watchers: { 'pr:o/r#s1': { repo: 'o/r' } } })
  assert.equal(out.watchers['pr:o/r#s1'].kind, 'pr')
  assert.deepEqual(out.watchers['pr:o/r#s1'].seenComments, {})
})

test('migratePrWatchers 幂等', () => {
  const once = migratePrWatchers({ watchers: { 'pr:o/r#s1': { repo: 'o/r', kind: 'pr', seenComments: { 1: 2 } } } })
  const twice = migratePrWatchers(once)
  assert.deepEqual(twice, once)
})

test('migratePrWatchers 保留未知字段', () => {
  const out = migratePrWatchers({ watchers: { 'o/r#s1': { repo: 'o/r', custom: 1 } } })
  assert.equal(out.watchers['o/r#s1'].custom, 1)
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test test/state-migration.test.mjs`
Expected: FAIL — `migratePrWatchers is not a function`

- [ ] **Step 3: 实现并接入 `migrateState`**

在 `migrateState` 的返回值上调用 `migratePrWatchers`（保持现有导出签名不变）。

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test test/state-migration.test.mjs && npm test`
Expected: 新用例 PASS 且全量 **992/992 + 4 新** 全绿

- [ ] **Step 5: 提交**

```bash
git add lib/state-migration.js test/state-migration.test.mjs
git commit -m "feat(state): PR watcher 状态迁移"
```

---

### Task 5: 轮询接入与工具注册

**Files:**
- Modify: `lib/index.js`
  - 工具注册区（`watch_start` 附近，约 3213 行）
  - `pollOnce` 之前新增 `pollPrOnce`
  - `startWatcher.tick` 里按 `entry.kind === 'pr'` 分流
- Test: `test/watch.test.mjs`（追加用例）

**Interfaces:**
- Consumes: Task 1 `lib/pr-watch.js` 全部导出、Task 2 `buildPrSearchQuery`/`parsePrSearch`、Task 3 `listGiteePrs`/`fetchGiteePrComments`
- Produces:
  - `pollPrOnce(ctx, entry, baseMs, brand): Promise<void>`
  - 三个工具：`watch_pr_start` / `watch_pr_status` / `watch_pr_stop`

**工具参数（`watch_pr_start`）**：

```jsonc
{
  "repo": "MYCF711/dsh-session-superagent",  // 必填，对方原仓库
  "intervalSec": 300,                         // 可选，默认 300，范围 30–3600
  "audit": false,                             // 可选，默认 false
  "adversarialAudit": false,                  // 可选，默认 false
  "auditMode": "subagent",                    // 可选，inline | subagent，默认 subagent
  "observe": false, "isolated": true, "workdir": null,
  "activeHours": null, "goal": null, "format": "text"
}
```

**`pollPrOnce` 流程**（严格按此顺序，早退路径都不能推进水位）：

1. `activeHours` 不在窗口 → `enterActiveHoursDefer` 并 return
2. `nextAt` 退避窗口未到 → return
3. GitHub：`run('gh', ['api','graphql','-f','query='+buildPrSearchQuery({base}), ...])`；Gitee：`listGiteePrs(...)`
4. 失败 → `setEntryError` + `bumpFailure`，**return（不推进水位）**
5. `prs.filter(isForkPr)` → 去掉非 fork PR
6. `pruneSeen(entry.seenComments, prs.map(p => p.number))`
7. 逐 PR：`fresh = pickNewComments(comments, seenComments[number] || 0)`；`shouldWake(fresh, self)` 为真 → 收集
8. 收集为空 → `entry.lastPoll = now`；return（**不推进水位**，因为 304/无新评论）
9. `observe` 为真 → 记 `noteEvent(entry, 'observe', ...)` 并**不推进水位**（与现有 observe 语义一致：只记录不消费）
10. 构造消息（`buildPrWakeText` + `goal` + 审计说明）→ `enqueueWake(ctx, sessionId, text, settled, key)`
11. 发送成功 → `entry.seenComments = advanceSeen(...)` + `entry.lastWake = now`
12. 失败 → `bumpFailure(entry, baseMs)`；**不推进水位**

**审计说明段**（拼在消息末尾）：

```text
审计: 开启（subagent 模式）           // audit=true 时
审计: 开启（inline 模式）
对抗性审计: 开启（subagent 模式）     // adversarialAudit=true 时
```

- [ ] **Step 1: 写失败测试**

`test/watch.test.mjs` 追加（用 `__test.pollWithItems` 或直接 mock `run`）：

```js
test('pollPrOnce 无新评论不唤醒也不推进水位', async () => { /* ... */ })
test('pollPrOnce 自己发的最后一条不唤醒', async () => { /* ... */ })
test('pollPrOnce 唤醒成功后水位推进到最后一条', async () => { /* ... */ })
test('pollPrOnce 唤醒失败不推进水位', async () => { /* ... */ })
test('pollPrOnce 跳过非 fork PR', async () => { /* ... */ })
test('watch_pr_start 存 kind:pr 与 seenComments', async () => { /* ... */ })
test('watch_pr_start auditMode 非法值被拒', async () => { /* ... */ })
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test test/watch.test.mjs`
Expected: FAIL — `pollPrOnce is not defined` / `watch_pr_start` 不存在

- [ ] **Step 3: 实现 `pollPrOnce` + 三个工具**

工具注册照 `watch_start` 的写法（`defineTool({ name, description, parameters, async execute(args) {...} })`），`sessionId` 从 `agentsService(ctx).currentInitiator()` 取。key 统一为 `'pr:' + (provider === 'gitee' ? 'gitee:' : '') + `${repo}#${sessionId}``。

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test test/watch.test.mjs`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add lib/index.js test/watch.test.mjs
git commit -m "feat(watch): PR 响应轮询与 watch_pr_* 工具"
```

---

### Task 6: 面板 UI

**Files:**
- Modify: `client.js`
  - `WATCHER_FIELD_SCHEMA`（约 1275 行）新增 4 个字段
  - 新增 `kind: 'segmented'` 控件（现有只有 text/number/switch/hours/priority）
- Test: `test/client.test.mjs`（追加用例）

**Interfaces:**
- Consumes: 无（纯渲染）
- Produces: 表单值 `{ watchKind, audit, adversarialAudit, auditMode }`

**新增字段**：

```js
{ key: 'watchKind', label: '监控类型', kind: 'segmented', options: [{ value: 'issue', label: 'Issue' }, { value: 'pr', label: 'PR 响应' }] },
{ key: 'audit', label: '审计', kind: 'switch', when: (v) => v.watchKind === 'pr', hint: '修改后先自审一遍再提交' },
{ key: 'adversarialAudit', label: '对抗性审计', kind: 'switch', when: (v) => v.watchKind === 'pr', hint: '专门挑刺：假设这段代码一定有 bug' },
{ key: 'auditMode', label: '执行方式', kind: 'segmented', when: (v) => v.watchKind === 'pr', options: [{ value: 'inline', label: '当前会话' }, { value: 'subagent', label: '子代理' }], disabledWhen: (v) => !v.audit && !v.adversarialAudit },
```

**UI 硬约束**：`segmented` 控件必须用 DSH 官方 `--dsw-alias-*` token（先读 `$DSH_HOME/DSH-UI-official.md` 找对应组件），不得手画。`disabledWhen` 为真时控件必须 `disabled` 且视觉上置灰（`--dsw-alias-text-disabled` 或官方等价 token）。

- [ ] **Step 1: 写失败测试**

```js
test('watcher 表单：pr 类型显示审计开关', () => { /* 渲染后断言 audit switch 存在 */ })
test('watcher 表单：两个审计都关时执行方式 disabled', () => { /* 断言 disabled 属性 */ })
test('watcher 表单：任一审计开启时执行方式可点', () => { /* ... */ })
test('watcher 表单：issue 类型不显示审计开关', () => { /* ... */ })
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test test/client.test.mjs`
Expected: FAIL — 找不到 `audit` 字段

- [ ] **Step 3: 实现 `segmented` 控件与 4 个字段**

- [ ] **Step 4: 跑测试与 UI 门禁**

Run: `node --test test/client.test.mjs && node scripts/ui-audit.mjs`
Expected: 全绿 + UI **11/11**

- [ ] **Step 5: 出双主题图 + 提交**

Run: `node scripts/render-preview.mjs preview.html`

```bash
git add client.js test/client.test.mjs
git commit -m "feat(panel): PR 响应监控表单（审计开关 + 执行方式）"
```

---

### Task 7: 文档与版本

**Files:**
- Modify: `docs/01-架构.md`（补 PR 监控链路）
- Modify: `docs/回归清单.md`（补 PR 场景）
- Modify: `AGENTS.md`（基线数字）
- Modify: `CHANGELOG.md`（0.11.0 条目）
- Modify: `package.json`（version 0.11.0）

- [ ] **Step 1: 更新架构文档**

在 `docs/01-架构.md` 的轮询章节后追加「PR 响应监控」小节，说明：key 前缀、`seenComments` 水位、只读约束、审计说明段。

- [ ] **Step 2: 更新回归清单**

`docs/回归清单.md` 补 5 条：
- 新评论触发唤醒
- 自己评论不触发
- 唤醒失败不推进水位
- 非 fork PR 被跳过
- 两审计都关时执行方式置灰

- [ ] **Step 3: 跑文档门禁**

Run: `node scripts/check-docs.mjs`
Expected: 四项 PASS（含总数与板块合计一致）

- [ ] **Step 4: 更新版本与 CHANGELOG**

`package.json` → `0.11.0`；`CHANGELOG.md` 写条目（含「PR 响应监控」新增、`watch_pr_*` 三个工具、面板字段）。

- [ ] **Step 5: 全量门禁 + 提交**

Run: `npm test && node scripts/preflight.mjs --fast`
Expected: 全量全绿 + preflight 通过

```bash
git add -A
git commit -m "docs: PR 响应监控文档与 0.11.0 版本"
```

---

## Self-Review

**1. Spec coverage**

| 设计文档章节 | 对应 Task |
|---|---|
| 三、核心流程 | Task 1（纯函数）+ Task 5（轮询） |
| 四、数据模型 | Task 4（迁移）+ Task 5（写入） |
| 五、平台实现 | Task 2（GitHub）+ Task 3（Gitee） |
| 六、工具接口 | Task 5 |
| 七、面板 UI | Task 6 |
| 八、文件改动清单 | 全部 Task 覆盖 |
| 九、测试计划 | 各 Task 的 Step 1 |

无遗漏。

**2. Step scan**：每个 Step 都是单一动作（写测试 / 跑失败 / 实现 / 跑通过 / 提交），无「TBD」「处理边界」这类空话。

**3. Type consistency**：`pr-watch.js` 的 `{ id, author, body, createdAt }` 与 `gh-format.js` 的 `parsePrSearch` 输出、`gitee.js` 的 `fetchGiteePrComments` 输出三者字段名一致（Task 2/3 的测试断言都用了 `id`/`author`/`body`/`createdAt`）。

**4. Review Focus**：5 条失败模式分别由 Task 1（`isForkPr` null、字符串 id、大小写）、Task 5（会话忙碌、重复唤醒）的测试覆盖。

**5. Proportion**：计划约 400 行，设计文档约 250 行——计划更细（含具体断言），符合「计划是决策集」的定位。
