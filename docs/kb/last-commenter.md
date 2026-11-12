# 叫醒一个人时，先告诉他"有没有人已经在处理"

## 出处
- GitHub REST《List issue comments》`GET /repos/{owner}/{repo}/issues/{issue_number}/comments`
  **只支持** `per_page` / `page` / `since`，**不支持** `sort` / `direction` —— 那是 issue 列表的参数，
  传了会被**静默忽略**。所以 `per_page=1` 恒返回**最早**一条，不是最新一条。
  <https://docs.github.com/en/rest/issues/comments#list-issue-comments>
- 要拿全线程最后一条：`per_page=100`（接口上限）+ `--paginate` +
  `--jq '.[-1] | {login: .user.login, at: .created_at}'`。`--paginate` 下 `--jq` 是**逐页**生效的，
  stdout 每页一行；全线程最后一条在**最后一行**，解析必须取最后一行有效记录
  （否则评论超过 100 条时只能看到第 100 条）。
  <https://cli.github.com/manual/gh_api>

## 它怎么做的
评论是**独立资源**，不在 issue 对象里（issue 只带 `comments` 计数）。要"最后一条评论是谁"，
必须单独取一次 —— 所以这是**有成本的**信息。

## 我们能怎么用
会话被叫醒后第一件事是判断「是不是已经有人处理了」。我们原来只给：
issue 作者、更新时间、标签、指派。问题是：**更新时间可能是我自己打标签引起的**，
而作者永远是开 issue 的人 —— 真正该看的是最后一条评论。

改法（成本受控）：
- 只对批次**前 3 条**且 `comments > 0` 的条目取；
- 首选一次 GraphQL 批量（`comments(last: 1)`，`lib/gh-format.js` 的 `buildCommentBatchQuery`）；
- GraphQL 不可用时逐条 REST 兜底：`lib/gh-format.js` 的 `lastCommentArgs`
  （`per_page=100` + `--paginate` + `.[-1]`），再由 `parseLastComment` 取多页 stdout 的最后一行；
- 并发取，单条 12 秒超时；
- 失败 / 空输出 / 坏 JSON / `login` 为空都**静默省略**这一行，绝不阻断唤醒；
- 消息里呈现为 `最后评论: @helper 2026-11-02T07:00:00Z`。

## 是否已落地
✅ 0.8.70（`watch.js:commentSummaryLine` + `index.js:fetchLastComments`）。
用例：null/空对象给空、只有 login 也能出、完整信息拼成一行、消息里出现「最后评论: @helper」。

**修正（Issue #39 Bug 2，本轮修复、未发版）**：本节原来的出处写的是
「`sort=created&direction=desc&per_page=1` 一次拿到最新一条」—— 这是**错的**：
comments 接口不认 `sort` / `direction`，参数被静默忽略，REST 兜底从上线起拿到的就一直是
**第一条**评论（主路径 GraphQL 的 `comments(last: 1)` 是对的，只有 GraphQL 失败时才走这条错路）。
现在参数由 `lib/gh-format.js` 的 `lastCommentArgs` 构造、输出由 `parseLastComment` 解析；
`test/gh-format.test.mjs` 用严格 `deepEqual` 锁住参数形状，并反向锁住
`sort` / `direction` / `per_page=1` / `.[0]` 四种旧写法。

## 还没做的
- 没有取评论**正文摘要**（能更有用，但要多传一份数据，先不做）；
- 「自己发的」已由 0.8.71 的 `self` 字段区分（见 [「我发的」≠「有人在处理」](viewer-self-comment.md)）。
