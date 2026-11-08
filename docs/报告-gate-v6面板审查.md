# gate v6 浏览器与面板审查（Q2）

> 审查人：reviewer（Q2，成员 `q2-panel`）。日期：2026-11-09。
> 被审范围：**B1**（v5 模型来源临时 harness 收进正式 Chromium 套件）+ 门禁面板的模型来源 / 仓库切换逻辑
> （`scripts/verify-panel-chromium.mjs`、`test/client.test.mjs`、`client.js` 的 `GateSettings`）。
> 被审代码树：`D:/主工作区/projects/dsh-gate-v6-integration`，分支 `task/gate-v6-integration` @ `b580681`
> （基线 `c3753a1` = main `7846678` + v6 任务书；`--no-ff` 合并 C1 `133a398` / S1 `dfe5a62` / B1 `fc35b4b`）。
> **本文件是本次审查唯一产物**：源码只读、未 `checkout` / `reset` / `stash` / `add` / `commit`；
> 所有变异都在 `os.tmpdir()` 里的副本上做，工作树 `client.js` / `test/client.test.mjs` /
> `scripts/verify-panel-chromium.mjs` 的 sha256 审查前后一致；未重启 / 重载 DSH，未动 magpie 配置，未改 `cordis.patch.yml`。
>
> ## 结论：**verdict = NEEDS_REVISION**
>
> **V1 §六 的「64 PASS / 0 FAIL / exit 0」是真实的**——我在本机独立复跑，64/64、退出码 0、可复现；
> `client.js` 与基线 sha256 完全相同（`c6fe935d…`），B1 确实没有改产品行为；17 条 U1-V\*/U5-V\* 场景
> **确实新增**（基线 47 条里 0 条打门禁/模型），根计数 47→64 对得上。
>
> **但「17 条场景全 PASS」这条证据有一半站不住**：
> - **U1-V3（同仓库两次读取乱序）与 U5-V2b（被作废的在途 bravo 列表）在浏览器层构造不出来**——
>   Chromium 对**完全相同的 URL** 做在途请求折叠，第二次请求要等第一次响应结束才发出
>   （服务端 `receivedAt` 差 **2006ms / 3003ms** ≈ 首条注入延迟）。结果这两条退化成「顺序两次读取，最后一条获胜」，
>   把它们所声称要守的 `loadSeqRef` / `modelsSeqRef` 闸门**全部拆掉，仍然 64/64 绿**。
> - **B1 自己带的静态护栏守不住删除**：它只做 `source.includes(场景名)`，17 条里只点名 8 条；
>   剩下 **9 条（U1-V0 / U1-V2 / U1-V3 / U1-V4 / U1-V6 / U5-V0 / U5-V2b / U5-V3a / U5-V6a）整段删掉，护栏仍然 1/1 绿**。
>
> 两条都**不是产品缺陷**（产品行为正确、无回归），是**证据强度缺陷**；修法合计 **2 行**，都在 B1 自己的写作用域内，
> 且我已在本机用变异验证过修法有效（见 §四）。
>
> 计数：**blocker 0 / high 0 / medium 2 / low 3 / info 2**。
> （medium = U5-V2b 空转且 `modelsSeqRef` 无任何判据、静态护栏 9/17 可删；
> low = U1-V3 空转但有单测桩兜底、双闸门只被验到一道、三条精确计数；info = 延迟队列错位风险、`/tmp` 检查偏严）
>
> **严格边界**：本文所有浏览器证据都是「安装版前端 `0.2.2-rc.1` + loopback fixture 页面 + 仓库里真实 `client.js`
> + 安装版 React 18.3.1 + Chromium 156.0.8078.74」；**不是真实 WebView、不是真实 `/gates` 服务端、不是真实模型**。
> 不宣称真机通过（见 §七）。

---

## 一、结论摘要

| # | 审查问题 | 结论 | 关键证据（本机实跑） |
|---|---|---|---|
| 1 | V1 §六 的 **64/64、exit 0** 是否真实 | **真实** | 本机独立复跑 `64 PASS / 0 FAIL / total 64`，`SUMMARY.exitCode=0`，管道退出码 **0**；`clientSha256 c6fe935d…`、`scriptSha256 d78b9986…` 与仓库文件一致 |
| 2 | **17 条** U1-V\*/U5-V\* 是否真新增 | **真新增** | 基线 `c3753a1` 同一脚本 **47 PASS / 0 FAIL**，日志里 `U1-V`/`U5-V` 命中 **0**、合并树 **17**；脚本里 `grep -c "check('U1-\|check('U5-"` 基线 **0**、合并树 **17** |
| 3 | B1 是否改了产品行为 | **没改** | `client.js` 合并树与基线 sha256 **都是** `c6fe935d7b742fa5a21336df245159a966f9dbe13ae36baeffb97c3d27e9e17f` |
| 4 | 17 条场景的**判据强度** | **15 条有效 / 2 条空转** | 变异 M1（拆掉 `load`+`loadModels` 全部 4 处代际序号闸门）→ **浏览器层仍然 64/64 绿**；U1-V3 服务端 `seq2→seq3` 到达间隔 **2006ms**、U5-V2b **3003ms**（= 首条注入延迟），两次请求根本没并发过。同一份 M1 跑**单测层 46 条门禁组** → 只有 **U1-G3** 红（`loadSeqRef` 有兜底）、模型侧 **0** 红（`modelsSeqRef` 无兜底） |
| 5 | 静态护栏是否假绿 | **是（medium）** | 把 U1-V1 的断言换成 `check('U1-V1 已被掏空', true, …)`、把 U5-V6b 包进 `if (false)` → 护栏 **1/1 PASS**；把 U1-V0 整段删掉 → 护栏 **1/1 PASS**（9/17 条可删） |
| 6 | U5-M4 的 `>= 2` 是否假绿 | **不是** | 确认前 `api.pending.length` 恒为 1（`test/client.test.mjs:4912` 有断言钉住），`>= 2` 等价于「确认后至少新发 1 条 `/gates` 读取」；实现若一条都不发就会红。这是**真的语义下界**，不是把 `3` 换成 `2` 的降级 |
| 7 | 面板自身逻辑有无回归 | **无** | `node scripts/test.mjs test/client.test.mjs` **168/168** exit 0；`PANEL_STRICT` 门禁组 **46/46** exit 0；UI 体检 **11/11（100 分）** exit 0；面板文案快照 PASS exit 0 |
| 8 | 修法是否已验证 | **已验证** | harness `fetch` 包装加 `cache:'no-store'`（1 行，不碰产品代码）：**只加修复** → 64/64 绿；**修复 + 变异 M1** → **62 PASS / 2 FAIL（U1-V3、U5-V2b）、退出码 1** |

---

## 二、审查环境与命令（原始输出 + 退出码）

### 2.1 环境

| 项 | 值 |
|---|---|
| 集成 worktree | `D:/主工作区/projects/dsh-gate-v6-integration`，分支 `task/gate-v6-integration` @ `b580681` |
| 基线 | `c3753a1`（= main `7846678` + v6 任务书），`git archive` 解到 `%TEMP%/q2-v6-baseline`，**未 checkout / 未改工作树** |
| 宿主 | Windows 11 Pro `10.0.26200` x64，Git Bash（MSYS），Node **v24.20.0** |
| 浏览器运行时 | `ego-browser 0.6.2.8`，内嵌 **Chromium 156.0.8078.74**、Node **v24.22.1** |
| 安装版前端 | `D:/DeepSeek Harness/Desktop-0.2.2-rc.1`，前端 **`0.2.2-rc.1`**，React **18.3.1**，primitives **310** 个导出 |
| asar sha256 | `5fa8a6b21bceb8f3e99e30efa2270efd0cc773a11e42aa0488f804a64b34e637` |
| `client.js` sha256 | `c6fe935d7b742fa5a21336df245159a966f9dbe13ae36baeffb97c3d27e9e17f`（**与基线相同**） |
| `scripts/verify-panel-chromium.mjs` sha256 | `d78b9986a9cc716966e0c8e0bed314de53d3bb6ce3d61928e4a23fe1404001e3`（基线 `b065c6d0…`） |
| `test/client.test.mjs` sha256 | `b681f5522eb9869fae50c5266103918be1758902e1e583f52f2d18c88a3822d6`（基线 `8a1b9e1e…`） |
| `repoVersion` | `0.10.11` |
| 工作树状态 | `git status --porcelain` = `M HANDOFF.md`（审查开始前既有）+ 本报告 + Q1 报告，**源码零改动** |

### 2.2 必跑四条（原始输出）

**① `node scripts/test.mjs test/client.test.mjs`**

```
✔ 门禁 models：确认放弃草稿并切换后，模型列表跟着切到新仓库（U5-M4） (257.7021ms)
✔ 门禁 StrictMode 双挂载：cleanup 后 effect 重跑要复位 alive（U2-F3） (64.616ms)
✔ 门禁作用域：接官方 SegmentedControl，缺导出回退也有方向键/Home/End/跳过 disabled（Q2-F4） (5.6518ms)
✔ 浏览器证据入库：门禁/模型场景留在正式 Chromium 套件里，且不依赖 /tmp 探针 (1.0113ms)
ℹ tests 168
ℹ suites 0
ℹ pass 168
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 5049.977
R1_EXIT=0
```

**② `PANEL_STRICT=1 node scripts/test.mjs --test-name-pattern='门禁' test/client.test.mjs`**

```
✔ 门禁作用域：接官方 SegmentedControl，缺导出回退也有方向键/Home/End/跳过 disabled（Q2-F4） (7.5635ms)
✔ 浏览器证据入库：门禁/模型场景留在正式 Chromium 套件里，且不依赖 /tmp 探针 (1.1809ms)
ℹ tests 46
ℹ suites 0
ℹ pass 46
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 4688.9074
R2_EXIT=0
```

**③ `node scripts/ui-audit.mjs`**

```
PASS 自造 token                   0          目标 0

UI 体检：11/11 通过（100 分）
R3_EXIT=0
```

**④ `node scripts/render-panel-copy.mjs --check`**

```
PASS 面板文案与当前实现一致（178 行；最长 77 字符；超过 80 字符的 0 条（上限 3））
R4_EXIT=0
```

### 2.3 正式 Chromium 套件（合并树，真实浏览器）

```bash
REPO_W=$(pwd -W); { echo "process.env.DSH_SUPERAGENT_REPO='$REPO_W'"; cat scripts/verify-panel-chromium.mjs; } | ego-browser nodejs
```

```
SUMMARY {
  "passed": 64,
  "failed": 0,
  "total": 64,
  "chromium": "156.0.8078.74",
  "repoVersion": "0.10.11",
  "clientSha256": "c6fe935d7b742fa5a21336df245159a966f9dbe13ae36baeffb97c3d27e9e17f",
  "scriptSha256": "d78b9986a9cc716966e0c8e0bed314de53d3bb6ce3d61928e4a23fe1404001e3",
  "frontendVersion": "0.2.2-rc.1",
  "asarSha256": "5fa8a6b21bceb8f3e99e30efa2270efd0cc773a11e42aa0488f804a64b34e637",
  "exitCode": 0,
  …
}
PIPE_EXIT=0
```

`grep -c '^PASS'` = **64**、`grep -c '^FAIL'` = **0**、`grep -c '^SKIP'` = **14**。
14 条 SKIP 全部是截图通道（`overview` / `judge` / `trigger` / `trigger-tooltip` / `trigger-advanced` /
`settings-source` / `settings-creds` / `settings-update` / `settings-diagnose` / `settings-goal` /
`orbit-open` / `orbit-modal` 共 12 张单项 + `desk 0/8` + `Orbit/Modal 0/2`），原因统一为
「Ego/CDP 截图通道已证实在 API 内部终止进程」——**不计产品 FAIL**，但也**没有拿截图当任何证据**。

### 2.4 基线对照（`c3753a1` 独立副本）

```
SUMMARY {
  "passed": 47,
  "failed": 0,
  "total": 47,
  "chromium": "156.0.8078.74",
  "repoVersion": "0.10.11",
  "clientSha256": "c6fe935d7b742fa5a21336df245159a966f9dbe13ae36baeffb97c3d27e9e17f",
  "scriptSha256": "b065c6d0e04806576079ce676fd7f0793ac72be70ba50bec760fdb20d83de173",
  "frontendVersion": "0.2.2-rc.1",
  "asarSha256": "5fa8a6b21bceb8f3e99e30efa2270efd0cc773a11e42aa0488f804a64b34e637",
  "exitCode": 0,
  …
}
PIPE_EXIT=0
```

`grep -c 'U1-V' 与 'U5-V'` 在**原始日志**里：基线 = **0**、合并树 = **17**（脚本源码里 `U1-V`/`U5-V` 共 26 处，
因为场景名在 `check()` 与 detail 里各出现一次；以日志计数为准）。

---

## 三、B1 套件逐项：17 条场景的判据强度

判定口径：**「有效」= 拆掉它声称要守的那段实现就会红**；「空转」= 拆掉也不红；「偏弱」= 能红但钉了不该钉的东西。
下面每条都标了**正面断言**（要求某值出现）与**负面断言**（要求某值不出现），负面断言只有在正面断言同时成立时才是有效证据。

| # | 场景 | 正面断言（要出现） | 负面断言（不许出现） | 强度 | 依据 |
|---|---|---|---|---|---|
| U1-V0 | 门禁分区真实渲染且第一次读取由真实 effect 发出 | `gateGets(apple).length === 1` | — | **有效（偏弱）** | 测的是「挂载即发一条读取」；精确 `=== 1` 见 §六 Q2-4 |
| U1-V1 | 乱序（跨仓库）：迟到旧仓库响应不覆盖新仓库 | `value === '仓库 …/banana 的提示词 #1'` | 正文不含 `apple 的提示词` | **有效** | 变异只拆序号闸门时仍绿，但拆 `repoRef.current !== requestedRepo`（`client.js:2472`）会红；服务端 `apple receivedAt 387302 (delay 2000)` vs `banana 387422 (delay 0)` 证明迟到响应**真的**晚 1900ms 到 |
| U1-V2 | 在途 dirty：响应回来不清新草稿 | `value === '手工草稿-未保存'`、savebar 含「未保存」 | — | **有效** | 拆 `load()` 里 `setGateDraft` 的 dirty 保留分支（`client.js:2497-2505`）会红 |
| U1-V3 | 乱序（**同仓库**）：先发的后到不能覆盖最新一次读取 | `value === '仓库 …/damson 的提示词 #' + lastDamson.seq` | 正文不含 `damson 的提示词 #2` | **空转（low）** | 服务端 `seq2 receivedAt 394912 (delay 2000)`、`seq3 396918 (delay 0)`：**差 2006ms**，seq3 是等 seq2 响应结束后才发出的。两次读取从未同时在途，`lastDamson.seq` 恒为 3、最终值恒为 `#3`。拆掉 `loadSeqRef` 闸门仍 64/64 绿（§四 M1）；**但该行为由单测桩 U1-G3 兜底**（M1 下 U1-G3 红） |
| U1-V4 | 取消换仓库：保留草稿且不去读新仓库 | 确认条含「仓库已切换到 …/elder」、`value === '保存前草稿-保留'` | `elder` 的 `/gates` 请求数 `=== 0`（取消前后各一次） | **有效** | `elderBefore === 0` 是负面断言，但同条有正面值断言；拆 `cancelRepoSwitch` 的 `loadSeqRef.current += 1`（`client.js:2700`）会让迟到的 elder 响应上屏 → 值断言红 |
| U1-V5 | targetRepo：保存/预览写 GET 回显的 `data.repo` | `previewBody.repo === saveBody.repo === '…/damson'` | — | **有效** | 实测 body：`{"repo":"D:/fixture/work/damson","trigger":"issue.reply",…}`；把 `targetRepo = panelRepo \|\| repo`（`client.js:2558`）改回 `repo` 会写成 `elder` → 红 |
| U1-V6 | 保存成功后按当前仓库重读并清掉保留草稿提示 | `/^仓库 …\/elder 的提示词 #\d+$/` | 正文不含「已保留草稿」 | **有效** | 正面是正则全匹配，不是 `includes`；拆 `save()` 末尾的 `await load()`（`client.js:2613`）会红 |
| U5-V0 | 切仓库后模型列表跟随面板仓库读取（alpha） | `model-alpha` 请求 `>= 1` 条、下拉含 `group/model-alpha-*` | — | **有效** | 拆 `[modelsPanelRepo]` effect（`client.js:2592`）会红 |
| U5-V1（M1 user） | 保留草稿时按钮只读草稿来源 alpha | 新请求恰好 1 条且 `repo === '…/alpha'`；下拉含 `model-alpha-*` | 不下含 `model-bravo-*`；bravo 的 models 请求 `=== 0` | **有效（偏弱）** | `m1Fresh.length === 1` 是精确次数，见 §六 Q2-4；但 `repo === alpha` 这条是真的 |
| U5-V2（M2） | 闸门挡住 charlie 时重读 bravo models | `m2RestoredRows.length >= 1`、`m2Restored !== r1` | 每条都 `repo === '…/bravo'`；charlie 的 models 请求 `=== 0` | **有效** | 语义下界 + 仓库全等；拆 `load()` 闸门分支里的 `loadModels(pendingSource)`（`client.js:2489`）会红 |
| U5-V2b | 被作废的在途 bravo 列表（seq 更小）迟到后不能覆盖 | 最终含 `model-bravo-{m2Restored.seq}` | 不含 `model-bravo-{r1.seq}` | **空转（medium）** | 服务端 `seq2 receivedAt 403078 (delay 3000)`、`seq3 606081 (delay 0)`：**差 3003ms**，同 URL 折叠。拆掉 `modelsSeqRef` 闸门仍绿（§四 M1）；**且单测层 0 条模型侧用例转红**——这是 `modelsSeqRef` 唯一的判据 |
| U5-V3a | 渲染护栏：面板已切 delta、列表还是 charlie 时提示忽略 | `guard.visible`（正文含「已忽略，请重新读取」）、`options === 1` | — | **有效** | charlie（`delay 2500`）与 delta（`delay 3000`）是**不同 URL**，真的并发：charlie 响应 412087 落在 panelRepo 已切 delta 之后 → 护栏真的出现；`options` 走 `gateModelOptions`（`client.js:2388-2395`），列表空且当前值存在时恒为 1 |
| U5-V3b | 迟到的 charlie 列表不能覆盖 delta | 最终含 `model-delta-{rDelta.seq}` | 不含 `model-charlie-{rCharlie.seq}`；`stale === false` | **有效** | 同上，跨仓库不同 URL 真并发 |
| U5-V4（M4） | 确认放弃草稿并切换：模型列表切到 echo | `echoBefore === 0`、`m4.requests.length >= 1`、每条 `repo === echo`、含 `model-echo-*` | 不含 `model-delta-*` | **有效** | 见 §四 4.3：`>= 1` 是语义下界 |
| U5-V5（U2-F2） | 取消换仓库：保留草稿、重读 echo 模型、不读 foxtrot | `gateValue() === 'U5 取消切换草稿'`、`cancelFresh.length >= 1` 且全 echo、含 `model-echo-*` | 不含 `model-foxtrot-*`；foxtrot 的 models 请求 `=== 0` | **有效** | 拆 `cancelRepoSwitch` 的 `loadModels(panelRepoNow)`（`client.js:2706`）会红 |
| U5-V6a | 项目层前提：作用域可切「项目」、模型下拉禁用、草稿能变脏 | `scopeSwitch.ok === true`、`projectDisabled === true`、`dirty === true` | — | **有效** | 三条前提各自 `=== true`（不是 `!x`），任一不成立就红——这正是 v5 临时 harness 打 SKIP 放过的那条 |
| U5-V6b（M1 project） | 项目层保留草稿：确认条在、按钮读 foxtrot，不读 golf | `bannerShown`、`freshProject.length === 1 且 repo === foxtrot`、含 `model-foxtrot-{seq}` | golf 的 models 请求 `=== 0` | **有效（偏弱）** | 精确次数见 §六 Q2-4 |

**汇总：17 条里 15 条有效（其中 3 条精确计数偏弱）、2 条空转（U1-V3 → low，U5-V2b → medium）。**

### 3.1 空转的根因（本机判定性复现）

不是实现的问题，是 **Chromium 的「在途请求折叠」（request collapsing）**：两个**完全相同的 URL** 同时 GET 时，
第二次请求要等第一次响应结束才真正发出。`client.js` 的 `call()`（`client.js:553`）只写了
`await fetch(BASE + path, init)`，**没有** `cache: 'no-store'`；fixture 响应虽然有 `cache-control: no-store`
（`scripts/verify-panel-chromium.mjs:410`），但**挡不住请求折叠**。

最小复现（`/tmp/q2-probe/probe3.mjs`，真实 ego-browser Chromium，服务端按到达顺序发延迟 `[1500, 0]`）：

```
"label": "call() 的真实形状：不带 cache:no-store（只靠响应头）"
    "server": [
      { "n": 1, "url": "/g", "arrivedAt": 1794167859269, "delay": 1500 },
      { "n": 2, "url": "/g", "arrivedAt": 1794167860774, "delay": 0 }
    ],
    "gapMs": 1505        ← 第二次请求是等第一次响应结束才发出的

"label": "对照：fetch init 里带 cache:no-store"
    "server": [
      { "n": 1, "url": "/g", "arrivedAt": 1794167860779, "delay": 1500 },
      { "n": 2, "url": "/g", "arrivedAt": 1794167860779, "delay": 0 }
    ],
    "gapMs": 0           ← 两次请求同时在途
```

**V1 §6.3 已经披露过「同仓库两次 `/gates` 的乱序在浏览器层仍不可稳定构造」**，但：
① 它归因成「HTTP/1.1 连接串行化」，实测**不是**连接串行化（不同 URL 的两次请求 gap 0–242ms，完全并发），
是**请求折叠**；② 它把 U1-V3 / U5-V2b 仍然算进「17 条全 PASS」。这两点是本报告要修正的。

---

## 四、静态护栏与 U5-M4 下界断言是否假绿

### 4.1 静态护栏（`test/client.test.mjs:5009-5040`）：**是假绿（medium）**

护栏做的是 `source.includes(场景名)`，逐条：

| 变异（都在 `%TEMP%` 副本上，不碰工作树） | 期望 | 实跑 | 退出码 |
|---|---|---|---|
| 把 U1-V1 的断言整段换成 `check('U1-V1 已被掏空', true, …)`，**只在注释里留场景名** | 应红 | **1/1 PASS** | 0 |
| 把 U5-V6b 整段包进 `if (false) check('U5-V6b（M1 project）…')`（**场景在、永不执行**） | 应红 | **1/1 PASS** | 0 |
| 把 U1-V0 整段（**含名字**）删掉 | 应红 | **1/1 PASS** | 0 |

原始输出（第三例）：

```
✔ 浏览器证据入库：门禁/模型场景留在正式 Chromium 套件里，且不依赖 /tmp 探针 (3.3662ms)
ℹ tests 1
ℹ pass 1
ℹ fail 0
EXIT_CODE=0
```

**根因**：`test/client.test.mjs:5017-5026` 的 `scenarios` 只列了 **8 条**——
`U1-V1` / `U1-V5` / `U5-V1` / `U5-V2` / `U5-V3b` / `U5-V4` / `U5-V5` / `U5-V6b`。
**另外 9 条（U1-V0 / U1-V2 / U1-V3 / U1-V4 / U1-V6 / U5-V0 / U5-V2b / U5-V3a / U5-V6a）整段删掉也没有任何东西会红。**
而且没有任何地方钉住「17」这个数：`README.md:147` 写着「64 项 Chromium」，但 `scripts/verify-readme-claims.mjs`
的 8 组断言里**不含** Chromium 项数，`scripts/audit-readme-tests.mjs` 只查单测数。

### 4.2 变异验证：拆掉实现闸门，套件会不会红

| 变异 | 改了 `client.js` 的什么 | 实跑 | 退出码 | 说明 |
|---|---|---|---|---|
| **M1** | `load()` 的 2 处 + `loadModels()` 的 2 处 `seq !== loadSeqRef.current` / `seq !== modelsSeqRef.current` → `false`（代际序号闸门全拆，`client.js:2470/2507/2520/2529`） | **64 PASS / 0 FAIL** | **0** | **U1-V3、U5-V2b 空转**：拆了它们声称要守的闸门也不红 |
| **M3** | `loadModels()` 的 2 处 `requestedRepo !== panelRepoOf()` → `false`（`client.js:2523/2530`） | **64 PASS / 0 FAIL** | **0** | 「只认当前面板仓库」这道闸门在浏览器层没有**独立**判据——它被代际序号闸门遮蔽了（`seq` 先 return）。**不是缺陷**（行为仍正确），但说明双闸门只被验到一道 |
| **M1 + 修复** | 同 M1，另加 harness `fetch` 包装 `cache:'no-store'` | **62 PASS / 2 FAIL** | **1** | 红点正是 **U1-V3** 与 **U5-V2b** → 证明诊断与修法都对 |
| **只加修复** | 只有 harness `cache:'no-store'`，`client.js` 不动 | **64 PASS / 0 FAIL** | **0** | 修法**不产生假红** |
| **M1 + 单测层** | 同一份 M1 `client.js`，跑 `--test-name-pattern='门禁'` 的 **46 条** node 桩 | **45 pass / 1 fail** | **1** | **只有 U1-G3 红**（`门禁 load 序号：同一仓库两次读取乱序`）。即 `loadSeqRef` 在**单测层有判据**、浏览器层空转；而 `modelsSeqRef` **两层都没有判据**（模型侧 0 红） |

M1 + 修复的原始输出：

```
FAIL U1-V3 乱序（同仓库）：先发的后到不能覆盖最新一次读取
FAIL U5-V2b 被作废的在途 bravo 列表（seq 更小）迟到后不能覆盖最新列表
  "passed": 62,
  "failed": 2,
  "total": 64,
  "clientSha256": "d4501e549a9ce38aafb9f8d4678948f6ecbb5373906acc3f3a13ee353514b83c",
  "scriptSha256": "8dd554641b481652bc1798dcfb6550145783b8f66d3da03548fde7cc3e2d4f75",
  "exitCode": 1,
PIPE_EXIT=1
```

M1 + 单测层的原始输出（`node scripts/test.mjs --test-name-pattern='门禁' test/client.test.mjs`，副本在 `%TEMP%/q2-mut-a`）：

```
ℹ pass 45
ℹ fail 1
ℹ duration_ms 4903.5865

✖ failing tests:

test at test\client.test.mjs:4409:1
✖ 门禁 load 序号：同一仓库两次读取乱序，先发的后到也不能覆盖（U1-G3） (197.1182ms)
  AssertionError [ERR_ASSERTION]: 旧请求后到不能覆盖新结果
  '第一次读取' !== '第二次读取'
EXIT_CODE=1
```

> 这条把两条空转场景的**严重度分开了**：
> - **U1-V3** 拆掉的 `loadSeqRef` 闸门，在单测层有 **U1-G3** 兜底 → 行为没丢，只是**浏览器层没有增量证据** → **low**。
> - **U5-V2b** 拆掉的 `modelsSeqRef` 闸门，**单测层与浏览器层都没有判据**（46 条门禁组里 0 条模型侧用例转红）→ 这是**唯一**声称覆盖它的场景，而它空转 → **medium**。

> 注意 `exitCode: 1` 与管道退出码 `1` 都对得上——**套件的失败真的会让进程非零退出**，这一点没问题。

### 4.3 U5-M4 的 `>= 2` 是否假绿：**不是**

```js
// test/client.test.mjs:4912
assert.equal(api.pending.length, 1, '有草稿时先不读新仓库')
…
// test/client.test.mjs:4918
assert.ok(api.pending.length >= 2, '确认后要读新仓库（>=2 条：直接 load + 草稿清空后的补读）')
```

确认前长度被上一条断言**钉死为 1**，所以 `>= 2` 等价于「确认后至少新发 1 条 `/gates` 读取」——
这是**真的语义下界**（实现若一条都不发 → 长度 1 → 红），不是把 `3` 偷偷降成 `2`。
v5 面板审查 Q2-L2 要的口径（「把两条 load 合并成一条是合理优化，那时 3 会假红」）在这里成立。
**这条不需要改。**

---

## 五、与基线 47/47 的覆盖对照

| 口径 | 基线 `c3753a1` | 合并树 `b580681` | 增量 |
|---|---|---|---|
| 正式 Chromium 套件 `passed` | **47** | **64** | **+17** |
| `failed` | 0 | 0 | 0 |
| `SKIP`（截图通道） | 14 | 14 | 0 |
| 脚本里 `check('U1-` / `check('U5-` 数 | **0** | **17** | **+17** |
| 脚本里 `check(` 总数（含条件分支） | 52 | 69 | +17 |
| 脚本里 `session-superagent/gates` 出现次数 | **0** | 9 | +9 |
| `client.js` sha256 | `c6fe935d…` | `c6fe935d…` | **相同** |
| `test/client.test.mjs` 用例数 | 167 | 168 | +1（静态护栏） |
| `PANEL_STRICT` 门禁组 | 45 | 46 | +1 |

**结论**：B1 的「+17 条覆盖红」是**真的**——基线一条门禁/模型场景都没有，合并后 17 条全在。
但 **17 条里有 2 条（U1-V3、U5-V2b）是空转**，所以**有效新增覆盖是 15 条**。
V1 §六 写「17 条新增场景（全部 PASS，摘原始 detail 的关键判据）」在**计数**上没错，在**证据强度**上高估了 2 条。
其中 U1-V3 的行为另有单测桩 U1-G3 兜底（M1 变异 → U1-G3 红），U5-V2b 的行为**两层都没有判据**（M1 变异 → 全绿）。

---

## 六、发现清单

### Q2-1（medium）U5-V2b 空转，且 `modelsSeqRef` 在**任何层级**都没有判据

- **位置**：`scripts/verify-panel-chromium.mjs:1426-1429`（U5-V2b）；被守的实现是 `client.js:2520` / `:2529`（`seq !== modelsSeqRef.current`）
- **症状**：`U5-V2b` 声称验证「被作废的在途 bravo 列表（seq 更小）迟到后不能覆盖最新列表」，
  但两次**同 URL** 的 `/gates/models` GET 被 Chromium 折叠，第二次要等第一次响应结束才发出，**两次读取从来没有同时在途**。
  于是「最后一条到达的响应 = 最后一条发出的请求」恒成立，断言退化为「顺序两次读取，最后一条获胜」。
  更关键的是：**拆掉 `modelsSeqRef` 的两处闸门后，单测层 46 条门禁/模型用例里 0 条转红**
  （同一次变异里只有 `loadSeqRef` 对应的 **U1-G3** 红）——即 `modelsSeqRef` 这道「作废在途模型列表」的闸门
  **全仓库没有任何判据**，而 U5-V2b 是唯一声称覆盖它的场景。
  真实后果：将来 `modelsSeqRef` 被重构坏（或 `client.js:2487` 的 `modelsSeqRef.current += 1` 被删），
  用户会看到「别的仓库的模型列表」并能选中保存 → 跨仓库模型 id 写进配置。**没有任何测试会红。**
- **最小复现**（本机已跑）：
  ```bash
  TMP=%TEMP%/q2-mut-b1   # 只复制 client.js / package.json / scripts/verify-panel-chromium.mjs
  sed -i 's/seq !== loadSeqRef\.current/false/g; s/seq !== modelsSeqRef\.current/false/g' "$TMP/client.js"
  cd "$TMP" && REPO_W=$(pwd -W); { echo "process.env.DSH_SUPERAGENT_REPO='$REPO_W'"; cat scripts/verify-panel-chromium.mjs; } | ego-browser nodejs
  ```
  → `"passed": 64, "failed": 0, "exitCode": 0`（拆掉闸门仍全绿）。
  服务端时间戳：U5-V2b `seq2 403078 (delay 3000)` / `seq3 606081 (delay 0)` → **差 3003ms**。
  同一份 `client.js` 跑 `node scripts/test.mjs --test-name-pattern='门禁' test/client.test.mjs`
  → `pass 45 / fail 1`，唯一红点是 **U1-G3**（`loadSeqRef`），模型侧 0 红。
- **建议修法**（1 行 harness + 1 条单测；都不碰产品行为）：
  1. **harness 侧**（打掉请求折叠，与 Q2-3 的修法同一处）：
     ```diff
     --- a/scripts/verify-panel-chromium.mjs
     +++ b/scripts/verify-panel-chromium.mjs
     @@ -252,7 +252,9 @@ window.fetch = (input, init) => {
            return Promise.reject(new Error('harness 禁止外部请求：' + url.href));
          }
     -  return nativeFetch(input, init);
     +  // 同 URL 的在途 GET 会被 Chromium 请求折叠（第二次要等第一次响应结束才发出），
     +  // 这会让「同仓库两次读取乱序」构造不出来。cache:no-store 打掉折叠，且不碰产品代码。
     +  return nativeFetch(input, { ...(init || {}), cache: 'no-store' });
        };
     ```
     验证：**只加这一行** → `64 PASS / 0 FAIL / exit 0`（无假红）；**这一行 + M1 变异** →
     `62 PASS / 2 FAIL`（U1-V3、U5-V2b 变红）、`exitCode: 1`。
  2. **单测侧**（给 `modelsSeqRef` 补一条独立判据，不依赖浏览器）：在 `test/client.test.mjs` 的
     `gateRaceFetch({ deferModels: true })` 上，让同一个 repo 连发两条 `/gates/models`（先发的后 resolve），
     断言面板最终列表来自**后发**那条。这样即使将来浏览器层再退化，`modelsSeqRef` 也不会无声失效。
  改完之后 V1 §6.3 那条边界说明也要跟着改（「同仓库乱序不可构造」不再成立）。

### Q2-1b（low）U1-V3 在浏览器层同样空转（但行为有单测桩兜底）

- **位置**：`scripts/verify-panel-chromium.mjs:1225-1259`；被守的实现是 `client.js:2470` / `:2507`（`seq !== loadSeqRef.current`）
- **症状**：与 Q2-1 同一根因（同 URL 请求折叠）。U1-V3 声称验证「同仓库两次 `/gates` 乱序」，
  实测 `seq2 receivedAt 394912 (delay 2000)` / `seq3 396918 (delay 0)` → **差 2006ms**，两次读取从未同时在途。
  与 Q2-1 不同的是：拆掉 `loadSeqRef` 后**单测桩 U1-G3 会红**（见上），所以这个行为**没有失去覆盖**，
  只是浏览器层给不出增量证据。V1 §六 把它算进「17 条全 PASS」是**计数对、证据强度不对**。
- **最小复现**：同 Q2-1 的 M1 命令；浏览器层 64/64 绿、单测层 U1-G3 红。
- **建议修法**：同 Q2-1 的 harness 一行修复即可（修完 U1-V3 会真的红）。若暂不修，
  至少把 V1 §六 的措辞改成「U1-V3 / U5-V2b 在浏览器层为**边界**（同仓库乱序构造不出），
  U1-V3 由 U1-G3 覆盖，U5-V2b 无覆盖」。

### Q2-2（medium）静态护栏是纯文本 `includes`，9/17 条场景可整段删除仍绿

- **位置**：`test/client.test.mjs:5015-5040`（`scenarios` 数组在 `:5017-5026`）
- **症状**：护栏断言的是 `source.includes('<场景名>')`。因此
  ① 把断言掏空成 `check('<名字>', true)` 但保留名字（注释里留名也算）→ 绿；
  ② 把场景包进 `if (false)`（场景在、永不执行）→ 绿；
  ③ 9 条**没被点名**的场景（U1-V0 / U1-V2 / U1-V3 / U1-V4 / U1-V6 / U5-V0 / U5-V2b / U5-V3a / U5-V6a）
  **整段删掉**（含名字）→ 绿。
  这条护栏的存在理由恰恰是「守住场景不被删 / 搬走」，现在守不住 53%。
- **最小复现**（本机已跑，副本在 `%TEMP%/q2-mut-a`）：
  ```bash
  # ① 掏空 U1-V1 + ② 把 U5-V6b 包进 if (false) → 护栏 1/1 PASS
  # ③ 把 U1-V0 整段删掉 → 护栏 1/1 PASS
  node scripts/test.mjs --test-name-pattern='浏览器证据入库' test/client.test.mjs
  # → ✔ 浏览器证据入库…  ℹ pass 1  ℹ fail 0  EXIT_CODE=0
  ```
- **建议修法**（二选一，都在 B1 写作用域内）：
  1. **补全名单 + 钉死条数**：把 `scenarios` 补到 17 条，并加
     `assert.equal((source.match(/check\('U[15]-V/g) || []).length, 17, '正式套件的 U1/U5 场景数必须是 17')`。
  2. **改成结构化断言**（更稳）：在 `scripts/verify-panel-chromium.mjs` 里把 17 条场景名导成一个
     常量数组（`export const GATE_MODEL_SCENARIOS = [...]`），套件运行时断言 `results` 里这 17 条都在；
     `test/client.test.mjs` 只断言「常量长度 = 17 且每条都有对应 `check` 调用」。这能同时挡住
     「掏空断言」与「`if (false)`」，因为它验的是**运行结果**而不是**源码文本**。
     成本：需要给套件加一个 `--list-scenarios` 的 dry-run 出口（不启动浏览器），或把常量单独放一个 `.mjs`。

### Q2-3（low）「双闸门」在浏览器层只有一道被判据钉住（M3 变异仍全绿）

- **位置**：`client.js:2470`（代际序号）vs `client.js:2472`（`repoRef` 仓库核对）；
  `client.js:2520`（代际序号）vs `client.js:2523`（`requestedRepo !== panelRepoOf()`）
- **症状**：`load()` / `loadModels()` 各自有「序号」与「仓库」两道闸门。变异 M3 把
  `requestedRepo !== panelRepoOf()` 两处拆成 `false`，套件**仍然 64/64 绿**——因为序号闸门先 `return` 了。
  反之 M1 拆序号闸门时，仓库闸门兜住。**行为是对的**（任一道在就正确），但意味着
  「只认当前面板仓库」这条**语义**在浏览器层没有独立证据，将来两道闸门合并 / 重排时不会被发现。
- **最小复现**：`%TEMP%/q2-mut-b3` 里 `sed -i 's/if (requestedRepo !== panelRepoOf()) return/if (false) return/g' client.js`，
  跑正式套件 → `64 PASS / 0 FAIL / exitCode 0`。
- **建议修法**：加一条**单测层**用例（`test/client.test.mjs`，不需要浏览器）——
  让 `panelRepoOf()` 在响应在途时返回别的仓库、同时**让序号保持最新**（只 `deferred.resolve` 那一条），
  断言响应被丢弃。这样两道闸门各有独立判据。优先级低：现有行为正确，只是覆盖冗余。

### Q2-4（low）U1-V0 / U5-V1 / U5-V6b 仍钉精确请求次数，与 U5-M4 改下界的理由同形

- **位置**：`scripts/verify-panel-chromium.mjs:1200`（`gateGets(apple).length === 1`）、
  `:1391`（`m1Fresh.length === 1`）、`:1547`（`freshProject.length === 1`）
- **症状**：任务书只要求把 **U5-M4** 改成语义下界（`>= 2`），另外三条仍是精确计数。
  但「挂载 / 点按钮只发一条读取」在未来把重复 load 合并、或加一条重试时**同样会假红**——
  这正是 v5 面板审查 Q2-L2 认定「不该钉」的那类断言。
- **最小复现**：不需要（纯静态观察；`grep -n "length === 1" scripts/verify-panel-chromium.mjs` 即可看到 3 处场景内断言）。
- **建议修法**：U1-V0 用 `>= 1` + 「这一次读取的 `repo` 是 apple」；U5-V1 把
  `m1Fresh.length === 1` 改成 `m1Fresh.length >= 1 && m1Fresh.every(r => r.repo === '…/alpha')`；
  U5-V6b 同理。**注意**：U5-V1 的「不读 bravo」那条（`modelGets(bravo).length === 0`）是**负面**断言，
  必须留着，不能一起放宽。

### Q2-5（info）fixture 的延迟队列是「全局按到达顺序」消费，不跟仓库绑定

- **位置**：`scripts/verify-panel-chromium.mjs:485`（`gateRace.delays.shift()`）、`:497`（`modelRace.delays.shift()`）
- **症状**：`delays` 是一个数组，谁先到谁拿走。如果被测实现**多发一条**请求（回归），
  延迟会错位到别的仓库的请求上，原场景可能变成「另一条请求迟到」而**以另一种方式**通过（或者超时红）。
  本机没有构造出「错位后仍绿」的例子，所以只记 info。
- **建议修法**：把延迟改成 `Map<repo, number[]>`（按仓库入队），或在 `requests` 里记下
  「这次请求消费的是第几个延迟」并在断言里核对。

### Q2-6（info）静态护栏的 `/tmp/` 检查对块注释偏严（不是洞，与注释意图不一致）

- **位置**：`test/client.test.mjs:5037`（`source.split('\n').filter(line => !line.trim().startsWith('//'))`）
- **症状**：只排除**行首** `//`。JSDoc 的 ` * /tmp/…` 行、行尾注释 `foo() // /tmp/x` 都会被当成代码 → 假红。
  方向是「偏严」不是「放过」，所以不构成假绿。
- **建议修法**：如果要精修，用「先剥注释再扫」而不是「按行首前缀筛」；也可以维持现状（更安全）。

---

## 七、未验项（不宣称通过）

- **不是真机 WebView**：没有重启 / 重载 DSH，没有在真实宿主会话里点门禁面板。`/gates`、`/gates/models`、
  `POST /gates/preview`、`POST /gates` 全部打脚本自带的 **loopback fixture**——**不是真实服务端、不是真实模型**。
- **物理读屏 / 触摸 / IME**：未验。
- **真实 `/gates/models` 服务端跨仓库返回**：未验。fixture 只按 `?repo=` 拼模型 id（`modelPayloadFor`，`:430-439`），
  真实服务端返回的模型 id 形态、跨仓库隔离语义都没有被这条套件覆盖。
- **真实模型 id 与真实 baseURL 切换**：未验。
- **真实 GitHub / Gitee 响应、真实 watcher 状态变化**：未验（`DSH_SUPERAGENT_OFFLINE=1`，fixture 只读）。
- **并发调度差异**：本套件的「乱序」依赖 CDP 驱动下的真实 Chromium 网络栈；真实 DSH WebView（Electron）
  的连接池参数、`cache: 'no-store'` 生效与否、HTTP/2 与否都**未验**——修法 Q2-1 只在 ego-browser 的 Chromium 156 上验过。
- **`packages/dsh-gate` 侧**：不在 Q2 范围（Q1 覆盖）。
- **真实 profile 的 `--repair`**：Q2 只读，未执行（V1 §八 留给 I1）。

---

## 八、证据文件（临时，不进仓库）

| 文件 | 内容 |
|---|---|
| `/tmp/q2-chromium.log` | 合并树正式套件原始输出（2547 行，64 PASS / 0 FAIL / 14 SKIP） |
| `/tmp/q2-baseline.log` | 基线 `c3753a1` 正式套件原始输出（47 PASS / 0 FAIL） |
| `/tmp/q2-r1.log` … `/tmp/q2-r4.log` | 必跑四条 |
| `/tmp/q2-mut-b1.log` | 变异 M1（拆序号闸门）→ 64/64 绿 |
| `/tmp/q2-mut-b3.log` | 变异 M3（拆 `panelRepoOf` 闸门）→ 64/64 绿 |
| `/tmp/q2-mut-fix2.log` | 变异 M1 + harness 修复 → 62/2 红（U1-V3、U5-V2b） |
| `/tmp/q2-fix-only.log` | 只加 harness 修复 → 64/64 绿 |
| `/tmp/q2-probe/probe3.mjs` | 请求折叠判定性复现（gap 1505ms vs 0ms） |
| `%TEMP%/q2-mut-a` | 静态护栏变异副本（掏空 / `if (false)` / 整段删除） |
| `%TEMP%/q2-mut-b1`、`%TEMP%/q2-mut-b3`、`%TEMP%/q2-mut-fix`、`%TEMP%/q2-fix-only` | 套件变异副本 |
| `%TEMP%/q2-v6-baseline` | 基线 `c3753a1`（`git archive` 解出，未改工作树） |
