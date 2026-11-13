# 设计：PR 响应监控（GitHub + Gitee）

> 状态：**待批准**（brainstorming 产出，未写产品代码）
> 目标版本：0.11.0
> 关联：issue #？（待建）

---

## 一、目标

我们通过 fork 工作流向别人的仓库提 PR 后，对方的回复（新评论）目前**没有任何被动通知**——
只能自己隔一会儿去刷一次。对方可能提出修改意见、贴 CI 失败日志、或者只是确认收到，
而我们经常几小时甚至几天后才看到。

本功能：**监控「我们提给他人的 open PR」的新评论，检测到后唤醒会话继续处理**
（读评论 → 改代码 → 可选审计 → 提交 → 回评）。

### 范围

| 做 | 不做 |
|---|---|
| 监控**我们提的** open PR 的**讨论评论** | 监控别人提的 PR |
| GitHub + Gitee 双平台 | CI / 构建状态检测（m00285 已砍） |
| 可选审计 / 对抗性审计 | 行级 review comment（`#discussion_r`） |
| 唤醒会话，会话自己修复 + 回评 | 插件代写代码 / 代回评 |

---

## 二、已确认决策

| # | 决策 | 出处 |
|---|---|---|
| 1 | 只检测新评论，**不做 CI 检测**（数据结构留 `ci` 预留位） | m00285 |
| 2 | Gitee 用**讨论评论**（`comment_type=pr_comment`） | m00289 |
| 3 | 噪音策略：**都叫醒 + 消息里分级**（带评论正文和类型，会话自己判断动不动手） | m00289 |
| 4 | 回评由**会话自己**做（插件不碰写操作，PR 监控纯只读） | m00296 |
| 5 | 监控粒度：**repo 级**（一个 watcher 管一个 base 仓库的全部 open PR） | m00300 |
| 6 | 审计 = **2 个独立 checkbox**（审计 / 对抗性审计）；至少一个选中时执行方式可选 `inline`/`subagent`（默认 subagent），都没开时执行方式置灰 | m00303 |

---

## 三、核心流程

```
每 intervalSec（默认 300s）
  │
  ├─ 1. 发现：拉 base 仓库里 author=我们的 open PR 列表
  │     GitHub: GraphQL search "repo:{base} is:pr is:open author:@me"
  │     Gitee : GET /repos/{base}/pulls?state=open&author={self}
  │
  ├─ 2. 过滤：只保留 headRepository ≠ baseRepository 的（真 fork PR）
  │
  ├─ 3. 逐 PR 比对水位：拉最新 N 条讨论评论（N=10）
  │     找出 databaseId > seenComments[pr] 的评论
  │
  ├─ 4. 判定：未处理评论里**存在非本人**的 → 触发唤醒
  │     （最后一条是我也不漏掉中间对方发的）
  │
  ├─ 5. 唤醒：Agent.followup(结构化消息)
  │     消息含：PR 号/标题/分支、评论者、时间、正文、处理建议
  │
  └─ 6. 记账：唤醒成功后 seenComments[pr] = 最新评论 id
        PR 关闭/合并 → 从 seenComments 移除
        失败 → 指数退避（复用 bumpFailure，封顶 30 分钟）
```

### 关键语义：「新评论」的判定

**不用「最后一条不是我」**，改用**水位**：

```js
const fresh = comments.filter(c => c.databaseId > (seenComments[pr] || 0))
const hasOther = fresh.some(c => c.author.login !== self)
```

理由：如果对方连发 A、B 两条，我们是先看到 B 再处理，用「最后一条」会漏掉 A。
水位能把 A 也带进消息里。

---

## 四、数据模型

### 4.1 存储位置

复用 `~/.dsh/state/session-superagent/watchers.json`，**key 加 `pr:` 前缀**避免与现有 issue watcher 冲突：

```jsonc
{
  // 现有（issue 监控）—— 不动
  "MYCF711/dsh-session-superagent#<sessionId>": { "repo": "...", ... },

  // 新增（PR 响应监控）
  "pr:MYCF711/dsh-session-superagent#<sessionId>": {
    "kind": "pr",
    "repo": "MYCF711/dsh-session-superagent",   // 对方的原仓库（base）
    "sessionId": "…",
    "self": "iJetLi",                            // 我们的账号（自动探测）
    "intervalSec": 120,
    "enabled": true,
    "observe": false,
    "activeHours": null,
    "audit": {
      "enabled": false,          // checkbox 1：审计
      "adversarial": false,      // checkbox 2：对抗性审计
      "mode": "subagent"         // inline | subagent（默认 subagent）
    },
    "seenComments": { "48": 6843186090, "41": 6844038761 },
    "ci": null,                  // 预留位（m00285）
    "lastPoll": 0,
    "lastWake": 0,
    "lastError": null,
    "history": []
  }
}
```

### 4.2 状态迁移

- 老状态文件（无 `kind` 字段）→ 默认 `kind: 'issue'`
- 迁移函数放在 `lib/state-migration.js`（已有），新增 `migratePrWatchers()`

---

## 五、平台实现

### 5.1 GitHub（GraphQL，已实测）

```graphql
query($q: String!) {
  search(query: $q, type: ISSUE, first: 20) {
    nodes {
      ... on PullRequest {
        number
        title
        isDraft
        headRepository { nameWithOwner }
        baseRepository { nameWithOwner }
        comments(last: 10) {
          nodes { databaseId author { login } createdAt body viewerDidAuthor }
        }
      }
    }
  }
}
```

- `$q` = `repo:{base} is:pr is:open author:@me`
- **必须用 `databaseId`**（`id` 是 base64 node id，不能做数值比较）
- `viewerDidAuthor` 可作辅助判定，但主判定用 `author.login !== self`
- 配额：Search API 独立池（约 30 次/分钟），每轮 1 次查询

### 5.2 Gitee（REST）

```http
GET /repos/{base}/pulls?state=open&author={self}&per_page=100&sort=updated&direction=desc
```

返回字段（实测 36 个）：`number` / `title` / `draft` / `head.repo.full_name` / `base.repo.full_name` / `head.user.login` / `head.ref`。

评论：

```http
GET /repos/{base}/pulls/{n}/comments?comment_type=pr_comment&direction=desc&per_page=100
```

- 返回 `id`（数值，可直接比大小）/ `user.login` / `created_at` / `body` / `path`
- **`direction=desc` 意味着最新一条在首条**：取「最新评论 id」必须取 max，不能取末条
  （`advanceSeen` 只许前进，取末条会让同一批评论每轮重报）
- `per_page=100` 而不是 10：`pickNewComments` 只按 `id > 水位` 取，页越大越不容易漏掉
  突发的一串评论；代价是唤醒消息侧必须自己限长（一条消息最多列 10 条）
- **不支持 GraphQL**，无 `viewerDidAuthor`，用 `user.login === self` 判定
- 无全局 PR 搜索，只能按仓库拉（已确认）

### 5.3 账号探测

- GitHub：`gh api user --jq .login`
- Gitee：现有 `giteeWhoami()`
- 探测结果缓存 1 小时（避免每轮都调）

---

## 六、工具接口

新增 3 个工具（与现有 `watch_*` 并列，不混用参数）：

### `watch_pr_start`

```jsonc
{
  "repo": "MYCF711/dsh-session-superagent",  // 必填，对方的原仓库
  "intervalSec": 300,                        // 可选，默认 300，范围 30–3600
  "audit": false,                            // 可选，默认 false
  "adversarialAudit": false,                 // 可选，默认 false
  "auditMode": "subagent",                   // 可选，inline | subagent，默认 subagent
  "observe": false,                          // 可选，只记录不唤醒
  "activeHours": null,                       // 可选，如 "09:00-23:00"
  "goal": null,                              // 可选，追加到唤醒消息
  "format": "text"                           // 可选，text | json
}
```

### `watch_pr_status`

只有 `format`（`text` / `json`），返回**当前会话**所有 PR watcher 的状态 + 每个 PR 的
水位与未处理评论数。不做 `repo` 过滤：一个会话的守本来就不多，而 `repo` 过滤会让「有没有
别的仓库在跑」这个问题在面板上答不出来。

### `watch_pr_stop`

```jsonc
{ "repo": "…", "delete": false }
```

### `watch_pr_ack`

```jsonc
{ "repo": "…", "pr": 41, "commentId": 6844038761, "format": "text" }
```

把某个 PR 的评论水位推到指定 id（`commentId` 省略 = 现查最新一条）。

- 只前进不回退（`advanceSeen` 的 max 语义）；
- 只动本会话在该仓库的 PR 守；多条守且没给 `repo` 时报错要求指定；
- 失败（拿不到最新评论 / 守已被删）不动水位，返回 `ok: false`。

---

## 七、面板 UI

### 7.1 列表

watcher 列表里新增类型徽标：

```
[PR] MYCF711/dsh-session-superagent   #48 #41  2 个 PR 未处理  3 分钟前
[Issue] owner/repo                     5 条待处理           1 分钟前
```

### 7.2 表单（新增字段）

| 字段 | 控件 | 默认 | 说明 |
|---|---|---|---|
| 类型 | 分段控件 `issue` / `pr` | issue | 切到 pr 时下方字段变化 |
| 仓库 | 文本 | — | 填原仓库 `owner/repo` |
| 轮询间隔 | 数字（秒） | 120 | |
| 审计 | switch | off | checkbox 1 |
| 对抗性审计 | switch | off | checkbox 2 |
| 执行方式 | 分段 `inline` / `subagent` | subagent | **两个 switch 都关时 disabled** |
| 观察模式 | switch | off | |
| 活跃时段 | 文本 | — | |

**PR 守不做隔离执行**：`prepareIsolation` 要在 `entry.workdir` 的本地仓库里建 worktree，
而 PR 在别人的仓库，建出来的树对修复毫无用处。所以 `watch_pr_start` 不暴露 `isolated` / `workdir`，
`/state` 与 `watch_pr_status` 也不返回，面板在「对外发出的 PR」类型下不渲染这四个控件（2026-11-13 review B7）。
issue 守的隔离能力不受影响。

**UI 硬约束**（AGENTS.md 第〇节）：复用 DSH 官方结构树 + `--dsw-alias-*` token，
改完出双主题图 + `ui-audit` 100 分 + 文案快照 `--write`。

---

## 八、文件改动清单

| 文件 | 改动 | 预估 |
|---|---|---|
| `lib/pr-watch.js` | **新增**：发现、水位过滤、消息构造 | ~350 行 |
| `lib/index.js` | 工具注册 ×3、pollOnce 分支、状态加载 | +200 行 |
| `lib/gitee.js` | `listGiteePrs`、`fetchGiteePrComments` | +80 行 |
| `lib/gh-format.js` | `buildPrSearchQuery`、`parsePrSearch`、`formatPrWakeText` | +120 行 |
| `lib/state-migration.js` | `migratePrWatchers` | +30 行 |
| `client.js` | 类型分段、审计开关、执行方式 disabled | +250 行 |
| `test/pr-watch.test.mjs` | **新增** | ~400 行 |
| `test/client.test.mjs` | 表单渲染 + disabled 逻辑 | +80 行 |
| `docs/01-架构.md` | 补 PR 监控链路 | +40 行 |
| `docs/回归清单.md` | 补 PR 场景 | +20 行 |
| `AGENTS.md` | 基线数字更新 | 1 行 |
| `CHANGELOG.md` | 0.11.0 条目 | +20 行 |

---

## 九、测试计划

### 9.1 纯函数（test/pr-watch.test.mjs）

- 水位过滤：`fresh = comments.filter(id > seen)`，空 seen 时全量
- 本人评论不触发：`fresh` 全是我 → 不唤醒
- 混合评论：我 A、对方 B、我 C → B 触发（尽管最后一条是我）
- 连发：对方 A、B → 一次唤醒带两条
- PR 关闭/合并 → `seenComments` 移除
- 跨仓库：`headRepository === baseRepository` 的 PR 被排除（非 fork PR）

### 9.2 反向用例（AGENTS.md 要求）

- **ETag 304 时不能丢水位**：304 早退不得推进 `seenComments`
- **唤醒失败不能推进水位**：`Agent.followup` 抛错 → `seenComments` 不变
- **Search 配额耗尽**：403 限流 → 退避，不重复唤醒
- **Gitee 空 head.repo**：字段缺失时不能崩（`head.repo?.full_name`）

### 9.3 面板

- 两个 switch 都关 → 执行方式 `disabled`
- 任意一个开 → 执行方式可点
- 切 `issue`→`pr` 时字段变化、切回时恢复

### 9.4 门禁

`npm test` 全绿 + `preflight` 42 项 + `ui-audit` 11/11 + 双主题截图。

---

## 十、风险与未验项

| 风险 | 处理 |
|---|---|
| GitHub Search API 配额（30/min） | 每轮 1 次；多 watcher 时共享，超出退避 |
| Gitee `author` 参数是否真按 fork 作者过滤 | **未验**，需真机跑一次 |
| Gitee 评论 `direction=desc` 是否稳定 | **未验**，加兜底（全量拉再本地排序） |
| fork PR 与同仓库分支 PR 混杂 | 用 `head.repo.full_name !== base.repo.full_name` 排除，**未验**同仓库 PR 的字段 |
| 面板 disabled 状态在重渲染后丢失 | 加 client.test 断言 |

**没有实测的不得写成通过**（AGENTS.md）。

---

## 十一、已确认（m00328 批准）

1. 工具命名：新增 `watch_pr_start` / `watch_pr_status` / `watch_pr_stop` 三个独立工具。
2. 默认轮询间隔：**300s**（范围 30–3600）。
3. 文档路径：`docs/设计-PR响应监控.md`。

**设计已批准，进入 writing-plans 阶段。**
