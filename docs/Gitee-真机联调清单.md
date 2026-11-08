# Gitee 真机联调清单

> 插件：`dsh-session-superagent`（主理鱼）**0.9.180**（磁盘）· 宿主：DSH
> （本机宿主当前仍在跑 0.9.179 —— `/state` 的 `installedVersion` 已是 0.9.180，属于「代码已更新但未生效」，见 1.5 末条与 5.5。）
> Gitee 支持是 0.9.177–0.9.180 加的：**离线用例 + 一次公开仓库探测**验过，**没在真实 Gitee 仓库上跑完整闭环**。这份清单就是补那一步。
> 用法：从上往下做，一条做一次、打一次勾（把标题前的 `[ ]` 改成 `[x]`）。每条固定三段：
> **怎么操作** → 点哪里/敲什么；**期望看到什么** → 精确到文案或字段；**看到别的说明什么** → 故障归因，别瞎猜。
>
> 本机现场（下面的输出都是本次真跑的原样）：node v24.20.0、gh 2.101.0（账号 `MYCF711`）、宿主在跑的 0.9.179（磁盘已 0.9.180）、Gitee 私人令牌已配置（`GET /api/v5/user` → 200，`login=MYCF711`）。
>
> 代码定位：`lib/gitee.js`、`lib/watch.js` 用 `文件:行号`；`lib/index.js` 写这份清单期间被并行改动过，行号会漂，**统一按函数名/代码段定位**。

---

## 零、先把只读地基跑出来

> 这一节只做 **GET / 离线用例**，不往任何仓库写数据（不调 POST/PATCH/PUT/DELETE）。
> 下面每条都是可复制执行的命令 + 本次真实输出。**这一节不过，后面五组不用做** —— 又会把「网络/令牌」问题误判成插件 bug。

### 0.1 环境

```bash
$ node --version
v24.20.0
$ gh --version | head -2
gh version 2.101.0 (2026-09-15)
https://github.com/cli/cli/releases/tag/v2.101.0
```

### 0.2 离线用例（12 条）

```bash
$ node --test test/gitee.test.mjs
✔ repoAccess 映射：Gitee 的 permissions 形状 → 内部形状（别把只读误报成可写） (5.6732ms)
ℹ tests 12
ℹ suites 0
ℹ pass 12
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 119.5215
```

判据：`fail 0`。有 fail 先修代码，别上真机。

### 0.3 Gitee REST v5 能通（HTTP 码）

```bash
$ curl -s -m 15 "https://gitee.com/api/v5/repos/oschina/git-osc/issues?per_page=1" -o /tmp/gitee-issues.json -w "HTTP %{http_code} | %{size_download} bytes | %{time_total}s\n"
HTTP 200 | 10591 bytes | 3.268813s

$ curl -s -m 15 "https://gitee.com/api/v5/repos/oschina/git-osc/pulls?state=all&per_page=1" -o /tmp/gitee-pulls.json -w "HTTP %{http_code} | %{size_download} bytes\n"
HTTP 200 | 9453 bytes

$ curl -s -m 15 "https://gitee.com/api/v5/repos/oschina/git-osc" -o /tmp/gitee-repo.json -w "HTTP %{http_code} | %{size_download} bytes\n"
HTTP 200 | 6931 bytes
```

三条都 200 = 本机能出网、Gitee 没拦、插件要用的三个端点（issue 列表 / PR 列表 / 仓库信息）都活着。

### 0.4 失败长什么样（**这两个形状必须记住**）

```bash
$ curl -s -m 15 "https://gitee.com/api/v5/repos/this-owner-does-not-exist-xyz/nope" -o /tmp/notfound.json -w "HTTP %{http_code} | %{size_download} bytes\n"
HTTP 404 | 31 bytes
$ cat /tmp/notfound.json
{"message":"Not Found Project"}

$ curl -s -m 15 -H "authorization: token deadbeef" "https://gitee.com/api/v5/user" -o /tmp/badtoken.json -w "HTTP %{http_code}\n"
HTTP 401
$ cat /tmp/badtoken.json
{"message":"401 Unauthorized: Access token does not exist"}
```

**但 404 不一定是上面那种 JSON。** 仓库路径里出现非法字符（例如把 `gitee:owner/name` 整串当路径）时，Gitee 回的是 **HTML 错误页**：

```bash
$ curl -s -m 15 "https://gitee.com/api/v5/repos/gitee:Ghandi/workbuddy-pro/issues?per_page=1" -o /tmp/badrepo.json -w "HTTP %{http_code}\n"
HTTP 404
$ head -c 200 /tmp/badrepo.json
<!DOCTYPE html>
<html>

<head>
  <meta http-equiv="Content-Type" content="text/html; charset=UTF-8" />
  <title>你所访问的页面不存在 (404)</title>
  <link href="/static/errors/favicon.ico" r
```

这个形状在 5.4 会变成一个可观测现象（ack 失败时看不到「标签不存在」，只看到「没归类的错误」）。

### 0.5 真实条目形状（0.9.178 就是为这个改的）

```bash
$ node -e "读 /tmp/gitee-issues.json + /tmp/gitee-pulls.json + /tmp/gitee-repo.json 打印关键字段"
issues array? true len 1
{
  number: 'IKSQJH',
  numberType: 'string',
  id: 34933085,
  state: 'open',
  title: 'International phone verificati',
  user: 'yonijd',
  labels: [],
  updated_at: '2026-11-04T07:23:04+08:00',
  html_url: 'https://gitee.com/oschina/git-osc/issues/IKSQJH'
}
pulls len 1 { number: 14, numberType: 'number', state: 'closed', hasHead: false }
repo permissions: undefined private: false has_issues: true
```

三个结论，后面每一组都要用到：

1. **issue 的 `number` 是字符串（`IKSQJH`），PR 的是数字（`14`）。** 任何 `Number(number)` 都会把 issue 编号变成 `NaN`/`0` —— 去重、ack、评论 URL 全废。
2. **条目里没有 `state_reason` 字段。** 这是 3.4 的根因。
3. 未带令牌读公开仓库时 `permissions` 是 `undefined` → `mapGiteeRepoAccess` 会算成「只读」（`push:false`），这是对的，不是 bug。

### 0.6 `since` 真的能省（Gitee 没有 ETag，只能靠它）

```bash
$ node -e "console.log(new Date(Date.parse('2026-11-05T00:34:28+08:00') - 30*60*1000).toISOString())"
2026-11-04T16:04:28.000Z

$ curl -s -m 15 "https://gitee.com/api/v5/repos/Ghandi/workbuddy-pro/issues?state=all&sort=updated&direction=desc&per_page=20&since=2026-11-04T16:04:28.000Z" -o /tmp/wb.json -w "issues HTTP %{http_code} | %{size_download} bytes\n"
issues HTTP 200 | 2 bytes
$ curl -s -m 15 "https://gitee.com/api/v5/repos/Ghandi/workbuddy-pro/pulls?state=all&sort=updated&direction=desc&per_page=20&since=2026-11-04T16:04:28.000Z" -o /tmp/wbp.json -w "pulls  HTTP %{http_code} | %{size_download} bytes\n"
pulls  HTTP 200 | 12944 bytes
issues: 0 | pulls: 1
```

传未来时间 → `200` + `[]`：

```bash
$ curl -s -m 15 "https://gitee.com/api/v5/repos/oschina/git-osc/issues?state=all&sort=updated&direction=desc&per_page=20&since=2026-11-05T18:35:37.479Z" -o /tmp/since-future.json -w "HTTP %{http_code} | %{size_download} bytes\n"
HTTP 200 | 2 bytes
$ cat /tmp/since-future.json
[]
```

判据：`since` 是「水位 − 30 分钟」的 UTC ISO（`lib/index.js · pollOnce 的 Gitee 分支（since 计算）`）。`since` 之后没更新的条目**不会**回来 —— 所以水位一旦错前，会静默漏条；3.6 就是查这个。

### 0.7 三种写法解析（真跑 `parseRepoSpec`）

```bash
$ node --input-type=module -e "import { parseRepoSpec } from './lib/watch.js'; ..."
"Ghandi/workbuddy-pro"                        -> ok=true provider=github repo=Ghandi/workbuddy-pro id前缀=(无)
"gitee:Ghandi/workbuddy-pro"                  -> ok=true provider=gitee repo=Ghandi/workbuddy-pro id前缀=gitee:
"https://gitee.com/Ghandi/workbuddy-pro"      -> ok=true provider=gitee repo=Ghandi/workbuddy-pro id前缀=gitee:
"https://gitee.com/Ghandi/workbuddy-pro.git"  -> ok=true provider=gitee repo=Ghandi/workbuddy-pro id前缀=gitee:
"gitee：Ghandi/workbuddy-pro"                  -> ok=true provider=gitee repo=Ghandi/workbuddy-pro id前缀=gitee:
```

**注意：`parseRepoSpec` 现在有两个调用点** —— 面板那条 HTTP 路由（`lib/index.js · /watch 路由里的 parseRepoSpec(body.repo)`）和 `watch_start` 工具。两处算出来的 `id` 必须一致，这是 2.5 的回归点。

### 0.8 现场状态（`/state` 与状态文件）

```bash
$ curl -s -m 10 "http://127.0.0.1:65466/session-superagent/state" -o /tmp/dsh-state.json -w "HTTP %{http_code} | %{size_download} bytes\n"
HTTP 200 | 8242 bytes

$ node -e "读 /tmp/dsh-state.json 遍历 watchers"
serverVersion: 0.9.179 | routeBase: /session-superagent | giteeToken: configured
id=MYCF711/dsh-go#session-c0a5847a-d34c-4281-8521-54384849d956 | repo=MYCF711/dsh-go | provider字段存在? false | lastDeferred="不在活跃时段（09:00-23:00），600 分钟后开始" | lastPoll=2026-11-04T14:58:25.620Z
id=MYCF711/dsh-session-superagent#session-1e82afca-8be2-42f9-8186-2bd274e30342 | repo=MYCF711/dsh-session-superagent | provider字段存在? false | lastDeferred="未变化（304，不计入速率限制）" | lastPoll=2026-11-04T18:36:59.768Z
id=gitee:Ghandi/workbuddy-pro#session-543cf0b2-a992-4f9f-89c4-6ea45cb1ac96 | repo=Ghandi/workbuddy-pro | provider字段存在? false | lastDeferred=null | lastPoll=2026-11-04T18:35:42.250Z
watcher 的字段清单: id,repo,sessionId,intervalSec,enabled,cursor,lastPoll,lastWake,lastWakeCount,lastAbsorbed,lastError,filters,batchLimit,maxWakesPerHour,sessionMaxWakes,consecutiveFailures,nextAt,lastDeferred,observe,filteredLog,filterCounts,repoAccess,lastReopened,priority,isolated,workdir,lastWorktree,activeHours,isolateKeepDays,maxIsolated,history,events,otherSessions,lastErrorKind,lastErrorAt,needsReauth,deferReason,daily,busy,silentWakes,note,title,goal
```

三条一起读出一个**关键事实**：`id` 带 `gitee:` 前缀，但 `/state` 的投影里**没有 `provider` 字段**（`lib/index.js · /state 路由里的 watcher 投影` 的投影列表里没有它）。要确认 provider 只能看磁盘：

```bash
$ node -e "读 ~/.dsh/state/session-superagent/watchers.json"
gitee:Ghandi/workbuddy-pro#session-543cf0b2-a992-4f9f-89c4-6ea45cb1ac96 | provider=gitee | repo=Ghandi/workbuddy-pro | enabled=true | lastDeferred=null | lastPoll=2026-11-04T18:35:42.250Z
```

### 0.9 令牌是好的（不打印令牌本身）

```bash
$ node --input-type=module -e "import { giteeWhoami } from './lib/gitee.js'; 读 secrets.json 的 giteeToken 调 /user"
HTTP 200 | ok=true | login=MYCF711 | token 长度=32（不打印内容）
```

### 0.10 唤醒消息长什么样（真渲染三种情况）

```bash
$ node --input-type=module -e "import { formatWatchText } from './lib/watch.js'; ..."
--- 别人评论 ---
【主理鱼】Ghandi/workbuddy-pro 有 1 条新动态：
#IKSQJH [open] 登录后 502 — @yonijd
  (issue) 标签: bug https://gitee.com/oschina/git-osc/issues/IKSQJH 未认领 最后评论: @yonijd 2026-11-04T07:23:04Z

--- 自己评论（self=true）---
【主理鱼】Ghandi/workbuddy-pro 有 1 条新动态：
#IKSQJH [open] 登录后 502 — @yonijd
  (issue) 标签: bug https://gitee.com/oschina/git-osc/issues/IKSQJH 未认领 最后评论: 2026-11-04T09:00:00Z我（上一轮留的）

--- 被重新打开（state_reason=reopened）---
【主理鱼】Ghandi/workbuddy-pro 有 1 条新动态：
#IKSQJH [open] 登录后 502 — @yonijd
  (issue) 标签: bug https://gitee.com/oschina/git-osc/issues/IKSQJH ⚠ 这条被重新打开过（之前关过，判"不做"可能不对） 未认领
```

记两件事，第四组要用：

- 自己评论那行，**时间与「我（上一轮留的）」之间没有空格**（`09:00:00Z我（…`）—— 当前渲染的已知小瑕疵，不影响判断。
- ⚠ 那行只在条目带 `state_reason: "reopened"` 时出现，而 **Gitee 根本不发这个字段**（0.5）。

### 0.11 ack 失败时到底说什么（用真实 HTML 404 复刻）

```bash
$ node --input-type=module -e "用 /tmp/badrepo.json 的 HTML 跑 classifyGhError，复刻 watch_ack 的 gitee 失败分支"
kind = other | retryable = false
watch_ack 实际会返回: [error: #IKSQJH 需要你处理] （没归类的错误：已按退避自动重试；持续出现就跑 watch_doctor 看检查清单，或把这行贴给对方）
```

**这正是「标签不存在」的表现** —— 不是「仓库或编号不存在」。5.1 会再讲一次。

---

## 一、前置：Gitee 令牌怎么拿、放哪、公开/私有的差别

### [ ] 1.1 拿一个 Gitee 私人令牌

**怎么操作**：浏览器登录 Gitee → <https://gitee.com/profile/personal_access_tokens>（未登录会 307 到登录页，这是正常的）→「生成新令牌」→ 勾 **`issues`（读写）** 与 **`pull_requests`（读写）**，需要读仓库信息再加 `projects` → 生成后**立刻复制**（只显示一次）。

**期望看到什么**：页面给出 32 位令牌串；拿它打一次只读接口：

```bash
$ curl -s -m 15 -H "authorization: token <TOKEN>" https://gitee.com/api/v5/user -o /tmp/me.json -w "HTTP %{http_code}\n"
HTTP 200
$ node -e "console.log(require('/tmp/me.json').login)"   # 本机实测：MYCF711
```

**看到别的说明什么**：
- `HTTP 401` + `{"message":"401 Unauthorized: Access token does not exist"}`（0.4 原文）→ 令牌抄错 / 已被删 / 已过期。**不是插件问题**，重生成。
- `HTTP 403` → 令牌没勾 `issues` 权限；插件读列表会 403，而 403 在代码里被归成 `auth`（`lib/index.js · pollOnce 把 401/403 归成 auth`），面板会提示「Gitee token 无效或没权限」。
- 超时 / `Could not resolve host` → 本机到 `gitee.com` 的出口问题，与插件无关（0.3 三条都能 200 就排除）。

### [ ] 1.2 令牌放哪：面板「设置 → 凭证 → Gitee 令牌」

**怎么操作**：DSH 面板 → 设置 → 凭证 → 找到字段 **「Gitee 令牌」**（placeholder 原文：`私人令牌（留空不改）；只盯 GitHub 可以不管`）→ 粘贴 → 点 **保存凭证**。

**期望看到什么**：`GET /session-superagent/state` 的 `credentials.giteeToken` 变成 `"configured"`（本机实测就是 `"configured"`，见 0.8 第一行）；`~/.dsh/state/session-superagent/secrets.json` 里存着 `giteeToken`，**接口只回 `configured`/`none`，永不回显令牌**（`lib/index.js · secretsSummary()`）。

**看到别的说明什么**：
- 仍是 `"none"` → 没点到「保存凭证」（客户端是 `POST /session-superagent/credentials` 才落盘，改输入框不算）。
- 保存时报 `token shape not recognized (ghp_… or github_pat_…)` → 你粘到了上面那行 **Token**（GitHub）里。`giteeToken` 不做形状校验，报这个错只有一种可能：粘错行。
- 面板「凭证」区显示 `Gitee 令牌  已配置` → 说明落盘了；显示 `未配置（公开仓库也能读，私有仓库需要）` → 没落盘。

### [ ] 1.3 公开仓库：不填令牌也能读（但打不了 ack）

**怎么操作**：把 Gitee 令牌清空（输入框留空 → 保存凭证，走 `delete next.giteeToken`）→ 用一条**公开** Gitee 仓库建守（写法见第二组）→ 跑 `watch_doctor`。

**期望看到什么**：

```text
WARN 没有配置 Gitee token：公开仓库能读，私有仓库读不到，也打不了 ack 标签
OK   gitee:owner/name 可访问
INFO Gitee 没有 ETag 条件请求，所以这条守每轮都会真的读一次列表（注意额度）
```

（文案出处 `lib/index.js · watch_doctor 的 Gitee 分支`。`OK … 可访问` 是因为 `GET /repos/{owner}/{repo}` 匿名可读，0.3 实测 200。）

**看到别的说明什么**：
- `FAIL gitee:owner/name 不可访问：Gitee 仓库不存在，或 token 看不到这个私有仓库` → 这个仓库其实是**私有**的（Gitee 对无权限仓库回 404，不回 403），或名字拼错。
- 轮询正常但 `watch_ack` 必失败 → 预期内：无令牌时 `POST /issues/{n}/labels` 一定失败（401/403，或 Gitee 对未认证写操作直接 404）。

### [ ] 1.4 私有仓库：必须有令牌，且 doctor 要翻绿

**怎么操作**：1.2 填回令牌 → 用一条**私有** Gitee 仓库建守 → `watch_doctor`。

**期望看到什么**：`OK   gitee:owner/name 可访问`，且**没有**上面那条 `WARN 没有配置 Gitee token`。

**看到别的说明什么**：
- `FAIL gitee:… 不可访问：Gitee token 无效或没权限（在设置里填私人令牌）` → 401/403。此时 `entry.needsReauth = true`（`lib/index.js · pollOnce 的 needsReauth 分支`），`watch_doctor` 顶部会多一行 `FAIL 凭证失效（N 条守）：跑 gh auth login 重新登录…` —— **这行是 GitHub 口径的文案，对 Gitee 是误导**，真实动作是去填 Gitee 令牌。
- `FAIL … Gitee 仓库不存在，或 token 看不到这个私有仓库` → 令牌账号不在这个仓库的成员里。

### [ ] 1.5 面板新增时的添加前体检（Gitee 走 REST，不再误报）

**怎么操作**：面板 → 新增主理鱼 → 仓库填 `gitee:owner/name` → 添加。

**期望看到什么**：**直接建出来，不弹警告**。`/state` 里多一条，`id` 形如 `gitee:owner/name#session-…`（0.8 原文）；这条的 `repoAccess.push = false`（公开仓库 + 你的令牌不是该仓库成员 → 只读，正常）。复刻体检结果（真跑）：

```bash
$ node --input-type=module -e "giteeRepo + mapGiteeRepoAccess + repoStructureNote"
giteeRepo ok=true status=200
repoAccess = {"push":false,"private":false,"fork":false,"hasIssues":true,"archived":false}
添加前警告 = []
```

**看到别的说明什么**：
- 弹 `Gitee 仓库 owner/name 不存在，或 token 看不到这个私有仓库` → 体检拿到 404：名字错，或令牌账号不在成员里。
- 弹 `Gitee token 无效或没权限（设置 → 凭证里重新填一次）` → 401/403，先跑 1.1 / 1.2。
- 弹 `添加前没能确认这个 Gitee 仓库（…），稍后会在面板里再次探测。` → 网络/超时。**不影响建守**，下一轮 `probeAccess` 会补上 `repoAccess`。
- **历史坑（0.9.180 已修）**：0.9.179 及以前，这里的 `isNew = !created && !state.watchers[id]` 两项互为否定 → **体检从来没跑过**（既不会误报也不会发现真问题）；0.9.180 改成 `isNew = created` 才接上，并给 Gitee 补了 REST 分支（否则 Gitee 守会去 `gh api` 必然 404）。看到「仓库不存在」的假警告说明宿主还在跑更早的代码 —— `watch_doctor` 会给 `WARN 代码已更新但未生效`。

---

## 二、建守：三种写法各建一条，`/state` 里能看到 provider 与 `gitee:` 前缀

> 三种写法**面板和 `watch_start` 工具共用同一个解析器**（`parseRepoSpec`），所以三种在哪边建都认。唯一差别：工具在没有活跃会话时直接报 `watch_start must be called from a session turn`。

### [ ] 2.1 写法一 `owner/name`（GitHub 默认，对照组）

**怎么操作**：面板新增，仓库填 `MYCF711/dsh-session-superagent`（换成任一你在盯的 GitHub 仓库）→ 添加。

**期望看到什么**：`/state` 里 `id = "MYCF711/dsh-session-superagent#session-…"`，**没有** `gitee:` 前缀；磁盘 `watchers.json` 里这条的 `provider` 是 `github`（新建的会显式写；0.8 里那两条老条目没有这个字段 —— 缺省也按 github 处理）。

**看到别的说明什么**：`id` 里出现 `gitee:` → 你填了 `gitee:` 前缀；`repo` 里带前缀（`gitee:owner/name`）→ 解析器没走通，轮询会落到 `gh` 上并 404（2.5 的判据）。

### [ ] 2.2 写法二 `gitee:owner/name`

**怎么操作**：面板新增，仓库填 `gitee:Ghandi/workbuddy-pro`（换成你的仓库）→ 添加。

**期望看到什么**：
- `/state` 里 `id = "gitee:Ghandi/workbuddy-pro#session-…"`（前缀**保留在 id 里**）；
- 同一条的 `repo = "Ghandi/workbuddy-pro"`（**前缀被剥掉**，`lib/index.js · /watch 路由里的 spec.repo`）；
- `/state` 的 watcher 投影**没有 `provider`**（0.8 已证），要确认得看磁盘：`watchers.json` 里这条 `"provider": "gitee"`。

**看到别的说明什么**：`repo` 仍是 `gitee:Ghandi/workbuddy-pro` → 解析没生效，轮询会去 `gh api repos/gitee:Ghandi/workbuddy-pro/issues` → 404（Gitee 端也是 HTML 404，见 0.4）。删掉重建，先跑 2.5 的公式核对。

### [ ] 2.3 写法三 `https://gitee.com/owner/name`

**怎么操作**：面板新增（或 `watch_start`），仓库直接粘浏览器地址栏：`https://gitee.com/Ghandi/workbuddy-pro`（带 `.git`、带 `/issues/IKSQJH` 尾巴都行）。

**期望看到什么**：同 2.2 —— `repo` 归一成 `owner/name`，`id` 带 `gitee:` 前缀。`parseRepoSpec` 的实测输出见 0.7（`.git` 也认）。

**看到别的说明什么**：报 `[error: 仓库要写成 owner/name 或 gitee:owner/name，这些不对：https://gitee.com/…]` → 这个版本的 `parseRepoSpec` 认不出该 URL（它只认 `github.com` / `gitee.com` 两个域）。用 `gitee:owner/name` 兜底，并记下这个域名。

### [ ] 2.4 全角冒号 `gitee：owner/name`（中文输入法）

**怎么操作**：中文输入法下打 `gitee：Ghandi/workbuddy-pro`（冒号是全角 `：`）→ 添加。

**期望看到什么**：与 2.2 完全一致（`parseRepoSpec` 的正则是 `[:：]`，0.7 最后一行实测 `ok=true provider=gitee`）。

**看到别的说明什么**：报 `[error: 仓库要写成 owner/name 或 gitee:owner/name，这些不对：gitee：owner/name]` → 解析器没认全角冒号。改成半角重建（全角冒号若漏到 `repo` 里，轮询 URL 会带非法字符 → 404 HTML）。

### [ ] 2.5 建守后核对 id 公式（工具与面板必须一致）

**怎么操作**：分别用**面板**和 `watch_start` 工具各建一条同一个 Gitee 仓库（工具：`watch_start({ repo: "gitee:owner/name" })`），比对 `/state` 里的 `id`。复刻工具当前的解析 + id 公式（真跑）：

```bash
$ node --input-type=module -e "parseRepoSpec + id 公式"
"Ghandi/workbuddy-pro"                         -> provider=github | repo=Ghandi/workbuddy-pro         | id=Ghandi/workbuddy-pro#session-demo
"gitee:Ghandi/workbuddy-pro"                   -> provider=gitee  | repo=Ghandi/workbuddy-pro         | id=gitee:Ghandi/workbuddy-pro#session-demo
"https://gitee.com/Ghandi/workbuddy-pro"       -> provider=gitee  | repo=Ghandi/workbuddy-pro         | id=gitee:Ghandi/workbuddy-pro#session-demo
"gitee：Ghandi/workbuddy-pro"                   -> provider=gitee  | repo=Ghandi/workbuddy-pro         | id=gitee:Ghandi/workbuddy-pro#session-demo
"bad"                                          -> 被拒: [error: 仓库要写成 owner/name 或 gitee:owner/name，这些不对：bad]
```

**期望看到什么**：两边建出来的 `id` **完全一样**（`gitee:owner/name#session-…`）、`repo` 都是归一后的 `owner/name`、磁盘里都是 `"provider": "gitee"`。第二次建是**幂等更新**（返回里带 `(updated existing watcher)`），不会多出一条。`watch_start` 算「一条会话最多挂 20 条守」的余量时用的是同一个公式（`idOf`），对不上就会漏算。

**看到别的说明什么**：
- 两条 `id` 不同 → 工具与面板的解析分叉了，带 `gitee:` 前缀那条的 `repo` 会原样进 URL，**每轮 404**。删掉重建。
- 工具返回 `[error: …这些不对：…]` → 解析器不认这个写法（2.3 / 2.4）。
- 建完 `/state` 里没有新条目但工具返回成功 → 幂等更新了已有那条（同 id），不是失败。

---

## 三、轮询：新建 / 改状态 / 关闭 / 重新打开，各应产生什么 `lastDeferred` 或唤醒

> 观察点三处：会话里有没有收到 `【主理鱼】…` 唤醒；`/state` 里这条的 `lastWake` / `lastDeferred` / `filteredLog` / `filterCounts` / `events`；磁盘 `watchers.json` 里 `seen` / `cursor`。
> 冷却期默认 180 s（`DEFAULT_COOLDOWN_MS`），每小时唤醒上限默认 6。**同一轮里改太多次会互相吸收**，每次改完等一个 `intervalSec` 再看。

### [ ] 3.1 新建一条 issue → 应该唤醒

**怎么操作**：Gitee 网页 → 你的仓库 → 新建 Issue（标题写 `联调 A`）→ 等一个轮询周期（默认 60 s，面板可改）。

**期望看到什么**：会话收到

```text
【主理鱼】owner/name 有 1 条新动态：
#IKSQJH [open] 联调 A — @<你的账号>
  (issue) https://gitee.com/owner/name/issues/IKSQJH 未认领
```

同时 `/state`：`lastWake` 前进、`lastWakeCount` +1、`seen["IKSQJH"]` = 该条的 `updated_at`、`cursor` 前进。

**看到别的说明什么**：
- `filteredLog` 出现 **「机器人」** → 你是用 Gitee 的机器人/自动化账号建的（`isBot` 认 `type==='Bot'` 或 `[bot]` 后缀，`lib/watch.js:247`）；想收就把 `skipBots` 关掉。
- `filteredLog` 出现 **「不在标签白名单: xxx」** → 守上设了 `labels` 但这条没打对应标签。
- `filteredLog` 出现 **「已 ack」** → 这条已经打过 ack 标签（`主理鱼:已处理`），`hasAckLabel` 是大小写不敏感的精确匹配（`lib/watch.js:462-465`）。
- 什么都没发生且 `lastError` 为空、`lastPoll` 在动 → 看 `deferReason`：`active-hours`（不在活跃时段）或 `cap-*`（撞上每小时上限）。

### [ ] 3.2 把状态改成「进行中」（`progressing`）→ 应该唤醒（**Gitee 特有**）

**怎么操作**：把 3.1 那条 issue 的状态从「待办」改成「进行中」。

**期望看到什么**：**会唤醒**。Gitee 的 `state` 是四值（`open`/`progressing`/`closed`/`rejected`），`normalizeGiteeState` 只把 `closed`/`rejected` 归成关闭，`progressing` 归成 `open`（`lib/gitee.js:17-21`）。实测：

```bash
$ node --input-type=module -e "import { normalizeGiteeItem } from './lib/gitee.js'; import { filterReason } from './lib/watch.js'; ..."
Gitee state=open        → 内部 state=open   | 默认过滤器: 通过（会唤醒）
Gitee state=progressing → 内部 state=open   | 默认过滤器: 通过（会唤醒）
Gitee state=closed      → 内部 state=closed | 默认过滤器: 已关闭
Gitee state=rejected    → 内部 state=closed | 默认过滤器: 已关闭
```

**看到别的说明什么**：不唤醒且 `filteredLog` 写「已关闭」→ 你改的是「已完成 / 已关闭 / 已拒绝」里的一个（Gitee 的这些状态在 API 里都是 `closed`/`rejected`）。**只改 base URL 的实现会在这里静默失效**（把 `progressing` 当关闭），这正是这条要盯的。

### [ ] 3.3 关闭一条 issue → 不应该唤醒

**怎么操作**：把 3.1 那条关掉（不改其它）。

**期望看到什么**：**不唤醒**。`/state` 里 `filteredLog` 出现 `{"reason":"已关闭", "number":"IKSQJH", …}`，`filterCounts` 里有 `已关闭: 1`；没有新增时 `lastDeferred` 会被清成 `未变化（304，不计入速率限制）`。

> 注意最后这句文案：**Gitee 没有 304**，这句是 GitHub 口径的遗留（`UNCHANGED_TEXT`，`lib/index.js · UNCHANGED_TEXT`）。看到它别以为在做条件请求 —— Gitee 每轮都是真读一次列表。

**看到别的说明什么**：
- 收到唤醒且条目 `[closed]` → 这个守关掉了 `skipClosed`（默认开）。
- `filteredLog` 里看不到「已关闭」但也没唤醒 → 可能是同轮被冷却期吸收（看 `absorbedLog` 和 `lastAbsorbed`）。

### [ ] 3.4 重新打开同一条 → 应该唤醒，但**不会**有 ⚠ 标记

**怎么操作**：把 3.3 关掉的那条重新打开。

**期望看到什么**：**会唤醒**（`state` 回到 `open`），但消息里**没有** `⚠ 这条被重新打开过（之前关过，判"不做"可能不对）` 这一行，`/state` 的 `lastReopened` **仍是 null**。

**为什么**：Gitee 的条目里**没有 `state_reason` 字段**（0.5 的真实字段清单：`id,url,repository_url,…,state,title,body,user,labels,assignee,collaborators,repository,milestone,created_at,updated_at,…,issue_state,issue_state_detail` —— 没有 `state_reason`）。`normalizeGiteeItem` 那条兜底只认 `state === 'reopened'`，而 Gitee 重开后 `state` 仍是 `open`（`lib/gitee.js:43`）。

**看到别的说明什么**：
- 看到 ⚠ → 说明 Gitee 开始发 `state_reason` 了（上游变了），该补归一化并加用例。
- 完全没唤醒 → 水位把这条吸收了（`seen` 里已有更晚的 `updated_at`），或撞上 cooldown/上限。先看 `absorbedLog`，别先怀疑 provider 分派。

### [ ] 3.5 增量：两轮之间真的只取「水位 − 30 分钟」之后

**怎么操作**：连续看两轮（间隔 ≥ `intervalSec`）。用 `/state` 取 `cursor`，复刻 `since` 并打一次只读接口。

**期望看到什么**：`since = (cursor || lastPoll) − 30min` 的 UTC ISO（`lib/index.js · pollOnce 的 Gitee 分支（since 计算）`），两个端点（`/issues` 与 `/pulls`）都带它（`lib/gitee.js:98-107`）。本机实测：`cursor=2026-11-05T00:34:28+08:00` → `since=2026-11-04T16:04:28.000Z` → issues `0` 条、pulls `1` 条（0.6 原文）。首次轮询**没有** `cursor` 时不带 `since`（全量）。

**看到别的说明什么**：
- 每轮都是全量（`since` 为空）→ `cursor` 没前进。看 `advanceSeen`/`partitionItems` 之后有没有写入：被过滤的条目不写水位，被吸收的会写。
- 传未来时间 → `200 []`（0.6 第二条）。这说明「水位错前」的表现是**静默漏条**，不是报错 —— 3.1 收不到唤醒而 `lastPoll` 在动时，先把 `cursor` 手动往前推到比现在更早的值再看一轮。

### [ ] 3.6 一半成功（`partial`）要说出来

**怎么操作**：找一个人为关掉 PR 功能的仓库（或临时把 PR 端点弄 404 的环境）建守，跑一轮。

**期望看到什么**：`/state` 的 `events` 里出现 `{"kind":"partial","text":"Gitee PR 列表这一轮没拿到"}`（`lib/index.js · pollOnce 的 partial 事件`），**issue 照常处理**（`listGiteeItems` 只要有一个端点成功就 `ok:true`）。

**看到别的说明什么**：
- 两个端点都失败 → 走失败分支：401/403 → `auth`、429 → `ratelimit`（等 60 s，`lastDeferred="被 Gitee 限流，等 60 秒"`）、404 → `notfound`、其它 → `network`（`lib/index.js · pollOnce 的 Gitee 失败分类`）。
- 没有任何 `partial` 事件但 PR 全看不见 → 这个仓库可能真的没有 PR；先 `curl` 一下 `/pulls` 确认。

---

## 四、评论与自回声：唤醒消息里「最后评论」与「我（上一轮留的）」要分清

> 这一段靠 `giteeWhoami` 拿令牌对应的 `login`（本机实测 `MYCF711`，0.9），再和「最后一条评论的作者」比。Gitee 没有 GraphQL 批量，**只取每轮前 3 条**（`lib/index.js · fetchLastComments 的 Gitee 分支`）。

### [ ] 4.1 别人评论 → 显示 `@对方`

**怎么操作**：用**另一个账号**（或让同事）在 3.1 那条 issue 下评论一句。

**期望看到什么**：

```text
#IKSQJH [open] 联调 A — @<issue 作者>
  (issue) … 最后评论: @<评论者> 2026-11-04T07:23:04Z
```

（0.10 第一段是同一段代码的真渲染原文。）

**看到别的说明什么**：
- **没有「最后评论」这行** → 评论接口失败被静默吞了（`fetchGiteeLastComment` 失败返回 `null`，`lib/index.js · fetchLastComments 的 Gitee 分支`里的注释：少一行信息不阻断唤醒）。用 `curl …/issues/IKSQJH/comments?per_page=1&sort=created&direction=desc` 单独验一次。
- 显示成 `@你自己` 而不是「我（上一轮留的）」→ `giteeWhoami` 失败（令牌失效时 `viewerLogin('gitee')` 返回空 → `self` 恒 `false`，`lib/gitee.js:133`）。先跑 0.9。

### [ ] 4.2 自己评论 → 必须显示「我（上一轮留的）」

**怎么操作**：用**令牌对应账号**（本次 `MYCF711`）在 issue 下评论一句。

**期望看到什么**：

```text
… 最后评论: 2026-11-04T09:00:00Z我（上一轮留的）
```

（原文如此 —— 时间与「我（上一轮留的）」之间**少一个空格**，是当前渲染的小瑕疵，不影响判断。）

**看到别的说明什么**：
- 显示 `@MYCF711 2026-…` → 自回声判定没生效。两家登录名是**分开缓存**的（`viewerCache.github` / `viewerCache.gitee`），Gitee 守拿 GitHub 的 login 去比是永远不成立的 —— 这条正是 0.9.177 之后的修复点。若仍不生效，先确认 `GET /api/v5/user` 的 `login` 与你评论时显示的账号名**完全一致**（大小写不影响，代码做了 `toLowerCase`）。
- 该行整体消失 → issue 的评论数为 0（Gitee 的列表接口带 `comments` 字段，但 Gitee 分支**不按计数过滤**，取的是前 3 条）。

### [ ] 4.3 ack 之后不会「自己叫醒自己」

**怎么操作**：对 3.1 那条跑 `watch_ack`（见 5.1），之后**不再动**仓库，等两轮。

**期望看到什么**：不唤醒；`/state` 里 `seen["IKSQJH"]` 前移、`cursor` = ack 那一刻的 `nowIso`（`lib/index.js · watch_ack 收尾（advanceSeen + cursor 推到 nowIso）` 把光标推到当下，就是为了避免自己打标签把自己叫醒）。

**看到别的说明什么**：ack 完又唤醒 → 你 ack 的是**另一个编号**（`numbers` 逗号分隔，别把 Gitee 的 `id` 34933085 当编号），或标签没打上（5.2/5.4）。

### [ ] 4.4 一轮里 4 条以上同时变化：只有前 3 条带「最后评论」

**怎么操作**：一次改 4 条以上的 `updated_at`（比如批量打标签）。

**期望看到什么**：唤醒消息里只有 `updated` 最前的 **3** 条带「最后评论」行（`maxItems = 3`）。

**看到别的说明什么**：没有「最后评论」行 ≠ 评论接口坏了，只是这条不在前 3 条。想全看就一条条改（每轮只看前 3 条是有意的，避免 N 条 × 一次请求把额度打光）。

---

## 五、ack 与 doctor

### [ ] 5.1 `watch_ack` 打标签（标签已存在）

**怎么操作**：先在 Gitee 仓库里**手工建好**标签 `主理鱼:已处理`（Gitee 的标签必须先存在，插件不会自动建）→ 在会话里：

```text
watch_ack({ repo: "owner/name", numbers: "IKSQJH" })
```

**期望看到什么**：

```text
acked owner/name #IKSQJH with label "主理鱼:已处理"
```

Gitee 网页上该 issue 出现这个标签；`/state` 里 `lastAcked = { numbers: ["IKSQJH"], label: "主理鱼:已处理", at: … }`、`cursor` 推到当下。请求形状就是 `POST /repos/{owner}/{repo}/issues/{number}/labels`，body 是**裸字符串数组** `["主理鱼:已处理"]`，头 `authorization: token …`（`lib/gitee.js · addGiteeLabel`，0.10.7 起；离线用例断言裸数组）。注意：包成 `{"labels":[…]}` 会被 Gitee 回 `400 {"message":"Problems parsing JSON"}` —— 0.10.6 在项目看板式仓库真机复现过，这也是本函数以前必失败的原因。

**看到别的说明什么**：
- `[error: #IKSQJH 需要你处理] （没归类的错误：已按退避自动重试；持续出现就跑 watch_doctor 看检查清单，或把这行贴给对方）` → **这就是「标签不存在」的表现**（0.11 复刻原文）。根因：Gitee 回的是 HTML 404 页，`classifyGhError` 只认 GitHub 的措辞，归到 `other`。**别去查网络**，先确认标签名与仓库里的一字不差。
- `[error: #IKSQJH 暂时失败，稍后再 ack 一次即可（被 GitHub 限流）]` → 429（可恢复）。Gitee 也会 429，但标签表里写的是 GitHub，属于未修的措辞问题。
- `[error: no watcher for that repo — start one with watch_start first]` → `repo` 对不上。注意守上存的是**归一后的** `owner/name`（2.2 已确认前缀被剥掉），传 `gitee:owner/name` 会找不到。

### [ ] 5.2 标签不存在 → 明确失败，不假装成功

**怎么操作**：`watch_ack({ repo: "owner/name", numbers: "IKSQJH", label: "不存在的标签xyz" })`。

**期望看到什么**：**报错**（`[error: …]` 开头），并且 Gitee 网页上**没有**标签被创建。源码注释写得很清楚：Gitee 没有「建标签」独立端点，所以不幂等建，**让调用方看到真实原因**（`lib/index.js · watch_ack 里「Gitee 没有『建标签』独立端点」那段注释`）。

**看到别的说明什么**：返回 `acked …` 但网页没标签 → 版本不对（0.9.177 之前没有 Gitee 分支，会走 `gh api` 直接 404 或被当成 GitHub 仓库）；或者你 ack 的编号在另一个仓库。

### [ ] 5.3 编号是字符串：用 `numbers` 传 `IKSQJH`

**怎么操作**：同上，但注意参数名。`number` 的 schema 声明是 `type: 'number'`；Gitee 的 issue 编号是字符串，**用 `numbers: "IKSQJH"` 最稳**。

**期望看到什么**：能 ack。`watch_ack` 的解析是 `String(args.numbers || args.number).split(',').filter(v => /^[A-Za-z0-9_-]+$/.test(v))`，`IKSQJH` 能过。

**看到别的说明什么**：
- `[error: number (or numbers) is required]` → 传了空串，或编号里带了斜杠/空格（比如把 `issues/IKSQJH` 整段贴进去）。
- 想用 `watch_trace` 追这条：**现在能追了** —— schema 已改成 `type: ['number','string']`，实现里走 `String(args.number)`（此前 `Number("IKSQJH")` 会变 NaN，已修）。

### [ ] 5.4 `watch_doctor` 的 Gitee 两项输出

**怎么操作**：`watch_doctor({ repo: "owner/name" })`。

**期望看到什么**：Gitee 那条守打出**这些行**（顺序固定）：

```text
OK   版本一致：0.9.180
OK   面板接口挂载：6 条，无失败
INFO 没有 GitHub 守：跳过 gh 登录检查（Gitee 那条走令牌，见上面）
OK   gitee:owner/name 可访问
INFO Gitee 没有 ETag 条件请求，所以这条守每轮都会真的读一次列表（注意额度）
```

（第三行**只在全是 Gitee 守时**出现；只要还挂着一条 GitHub 守，它就换成 `OK   gh 登录：正常` —— 见 5.5。有令牌时**没有** `WARN 没有配置 Gitee token…`，没令牌时多这一行。）

> 0.9.180 在「ack 标签」块里加了 Gitee 的 `INFO ack 标签「…」：Gitee 需要先在仓库里手动建好这个标签…`，但那一段在 gitee 分支的 `continue` **之后**，对 Gitee **不可达**（死代码）。所以预期仍然**看不到**这行 —— 这是新引入的缺陷，不是清单写错。

同时注意：Gitee 条目**不会**打出下面这三行 —— 因为 gitee 分支在 `lib/index.js · watch_doctor 的 Gitee 分支末尾的 continue` 直接 `continue` 了：

- `OK/WARN ack 标签「主理鱼:已处理」：…`（GitHub 才有）
- `OK/FAIL 隔离工作目录 …`（GitHub 才有）
- `WARN 这条守已 N 分钟没轮询 …`（GitHub 才有）

**看到别的说明什么**：
- `FAIL gitee:… 不可访问：连不上 Gitee（…）` → 网络/超时，先跑 0.3。
- `FAIL gitee:… 不可访问：Gitee 仓库不存在，或 token 看不到这个私有仓库` → 名字错，或令牌不在成员里（私有仓库对无权限账号回 404）。
- 看到 `ack 标签「…」` 那一行 → 你看的是 GitHub 那条守，不是 Gitee 的。**Gitee 的 ack 标签存在性 doctor 目前不检查**，这是缺口，不是通过。

### [ ] 5.5 全 Gitee 时 `gh` 那行应该是 `INFO`，不是 `OK` / `FAIL`

**怎么操作**：只留 Gitee 守（把 GitHub 守全 pause 或删掉），再跑一次 `watch_doctor`；然后恢复一条 GitHub 守再跑。

**期望看到什么**：
- 全 Gitee → `INFO 没有 GitHub 守：跳过 gh 登录检查（Gitee 那条走令牌，见上面）`，**不再 spawn `gh`**（`/state` 里 `gh` 字段会变成 `{"ok":null,"skipped":"没有 GitHub 守"}`）；
- 只要有 GitHub 守 → `OK   gh 登录：正常`（或 `FAIL gh 登录：…`）。

**看到别的说明什么**：全 Gitee 却看到 `FAIL gh 登录：…` → 宿主还在跑旧代码（旧版无条件检查 `gh`，全 Gitee 的机器会一直红）。这属于**假故障**：Gitee 走 REST + 私人令牌，与 `gh` 无关。`watch_doctor` 会同时给 `WARN 代码已更新但未生效`，以那条为准（需要重启宿主）。

---

## 顺带看到的（这次没动代码，只登记）

1. **唤醒消息结尾写死了「写回 GitHub」** —— `lib/watch.js:215`：`做完一条就写回 GitHub，并调用 watch_ack 打上已处理标签`。Gitee 守醒来也会看到这句。
2. **`UNCHANGED_TEXT` 写着「未变化（304，不计入速率限制）」** —— Gitee 没有 304，3.3 会看到这句。
3. **`watch_ack` 的失败标签表是 GitHub 措辞**（`被 GitHub 限流` / `gh 登录失效`），Gitee 429 也会套用。
4. **自回声那行少一个空格**：`09:00:00Z我（上一轮留的）`（0.10 原文）。
5. **建守走两套入口时容易分叉**：面板（`POST /session-superagent/watch`）与 `watch_start` 工具各有各的 id 公式，0.9.180 已统一成 `parseRepoSpec` + `gitee:` 前缀；再改其中一处必须同时改另一处，否则同一条守会有两个 id（2.5 的回归点）。
6. **添加前体检**现在也分两家（`precheckRepo(repo, provider)`），Gitee 走 `giteeRepo`；1.5 的三个警告文案是 Gitee 专属分支。
7. **`/state` 投影没有 `provider`** —— 只能从 `id` 前缀或磁盘 `watchers.json` 判断。
8. **`watch_trace` 对字符串编号不可用**（`Number("IKSQJH") = NaN`）。
9. **`watch_doctor` 里 Gitee 的 ack 标签 `INFO` 是死代码**：它写在 gitee 分支 `continue` 之后，永远打不出来（5.4 已说明预期输出）。

## 还没做的

这份清单**没有覆盖**下面这些，别把它当「Gitee 全绿」：

1. **私有仓库的完整闭环**：本机只验了公开仓库 + 令牌有效性（0.9），没在真私有仓库上跑过 issue/评论/ack。
2. **Gitee 的 PR ack**：`addGiteeLabel` 打的是 `/issues/{number}/labels`，PR 编号在 Gitee 是否同路径**没验证**（这次不做写操作，所以没测）。
3. ~~标签自动创建~~：**已做**（`ensureGiteeLabel`：先按 Gitee 规则校验名字 → 翻页查重 → 不存在才建；查不到就不盲发 POST）。
4. **429 限流路径**：需要打满额度才能触发；`nextAt = +60s` 与 `lastDeferred="被 Gitee 限流，等 60 秒"` 只做了代码走读。
5. **`partial`（一半端点失败）**：3.6 需要人为把 PR 关掉的仓库，本次没找到。
6. ~~`watch_trace` 处理 Gitee 字符串编号~~：**已修**（同上，schema 收字符串 + `String()`）。
7. **跨平台多仓库**：一条会话同时挂 GitHub + Gitee 两条守（provider 分派是否互不干扰）没联调。
8. **隔离执行（`isolated`）+ Gitee**：`watch_doctor` 对 gitee 条目 `continue` 掉了 workdir 检查，所以「隔离区建在 Gitee 仓库上」这条路完全没验。
9. ~~Gitee 自定义状态（`issue_state`）~~：**已接**（`normalizeGiteeItem` 同时看 `state` 与 `issue_state`，`resolved` / `rejected` 都判关闭）。真机上还没跑过一遍，但逻辑有单测钉住。
10. **时区**：Gitee 返回 `+08:00`，`since` 传 UTC ISO（0.6 已证能工作），但没在非 +08:00 的机器 / 夏令时场景下验过。
11. **评论数上限**：每轮只取前 3 条（4.4），第 4 条之后的「最后评论」到底会不会丢、丢几轮，没实测。
12. **`watch_ack` 的 `format=json` 分支**：Gitee 失败时 `retryable=false` + `advice="需要你处理"`，机器消费方的重试逻辑没验。
