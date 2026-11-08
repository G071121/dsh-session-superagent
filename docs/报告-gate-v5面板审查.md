# gate v5 面板模型来源审查（Q2）

> 审查人：reviewer（Q2）。日期：2026-11-09。
> 被审范围：U1「模型列表统一跟面板仓库」——`client.js` GateSettings 的模型链路（状态 / 落地 / 按钮 / effect / 闸门 / 取消 / 确认 / 保存目标）与 `test/client.test.mjs` 的新增 / 改写用例。
> 被审代码树：`task/gate-v5-v1` @ `96fa08b`（Q1 报告 `f378d8c` 只加 docs）。`git status --short` 为空；`git diff task/gate-v5-ui HEAD -- client.js test/client.test.mjs` 为空；`client.js` sha256 `b6d4e21518e70935…`（与 V1 报告一致）。
> 本文件是唯一产物；源码只读，未重载 / 未重启 DSH，未对真实 profile 或真实 DSH Web GUI 执行任何写操作。
> **结论：verdict = pass。** 任务书的模型来源要求全部满足；0 blocker / high / medium，2 条 low（实现风格边界 + 测试维护性），均不阻塞 I1。

## 一、结论摘要

| # | 审查问题 | 结论 | 关键证据 |
|---|---|---|---|
| 1 | panelRepo 是否贯穿全链 | 通过 | `models` state 记 `repo`（`client.js:2418`）；响应落地只认 `panelRepoOf()`（`:2513-2537`）；按钮与 `[modelsPanelRepo]` effect 跟面板仓库（`:2592`, `:2938`）；保存 / 预览 / 优化用 `targetRepo = panelRepo \|\| repo`（`:2558`, `:2606`, `:2631`, `:2653`）。独立探针 S1/S2/S7/S16 通过；基线 54f9052 在同一套场景里共 9 红（§四） |
| 2 | 迟到 models 是否不能落地 | 通过 | 请求序号 + 落地时仓库二次核对（`requestedRepo !== panelRepoOf()`，`:2523`, `:2530`）；闸门分支额外 `modelsSeqRef.current += 1` 作废在途（`:2484-2490`）。探针 S9（往返换仓库）、S13（迟到错误）、S14（同仓库后发先至）、S15（闸门作废）全过；基线 S15 红 |
| 3 | 取消 / 确认路径 | 通过 | 取消：作废 load + 在途 models，重读面板仓库（`:2698-2707`）；确认：先 `setGateDraft(null)` + `load()`，数据换过之后 `[modelsPanelRepo]` effect 再读新仓库（`:2709-2715`, `:2592`）。探针 S5/S6 过，基线 S5/S6 红 |
| 4 | project / user 两种作用域 | 通过 | 探针 S2/S3/S8 对 `user` 与 `project` 各跑一遍：按钮、闸门回读、project 模型控件锁死时列表仍跟面板仓库；基线这两种作用域都红（按钮读 prop、闸门后不回列表） |
| 5 | 保存目标是否与所选模型同仓库 | 通过 | 探针 S7：草稿来自 demo、prop 已切 other，POST `/gates` 的 `repo=E:/work/demo` 且 `config.semantic.model=m-demo`；S16：预览 / 优化同样 POST demo。基线这两条也过（v4 已有 targetRepo，U1 没有回退它） |
| 6 | 跨仓库模型能否被选中 | 通过 | 渲染层护栏：`models.repo !== modelsPanelRepo` 时下拉只剩当前值 + 提示重新读取（`:2563-2565`, `:2936-2942`）。探针 S12：数据切到 other、other 的列表未回来时，下拉不含 demo 的模型，提示出现；新列表落地后提示消失 |
| 7 | hook 与官方控件是否未动 | 通过 | U1 diff 全部落在 `GateSettings`（2408–2942），未新增 `useState`（仍 12 个，位置队列 23+12=35 的用例通过）；官方 `SegmentedControl` 的 import / 调用未改，PANEL_STRICT 门禁组 45/45；真实 Chromium 官方套件 47 PASS / 0 FAIL |

## 二、方法与边界

- **只读源码**：没有改任何实现文件；探针与临时副本在 `/tmp/q2probe`（跑完保留，见 §七）。
- **独立探针不复制实现方用例**：`fixtures/gate-panel.mjs` 只提供最小 React 运行时（状态槽 / ref / effect / 卸载 guard），执行的是**真实 `client.js`**；README 说明它不展开子组件，断言只走 GateSettings 自己传下去的 props。我的 16 个场景（§四）与 U1 的 6 条用例不重叠。
- **先红后绿（基线对照）**：同一份探针对 `54f9052` 的 `client.js` 跑出 **9 红 / 7 绿**，对本树 **16/16 绿**。红点正好是 R1 的旧行为：换仓库先读 prop 的模型、保留草稿时按钮读 prop、闸门后不回列表、确认前/取消后仍有新仓库 models 请求、未落地时下拉里能看到别的仓库列表。
- **复跑**：`node --test test/client.test.mjs` 167/167 exit 0；`PANEL_STRICT=1 --test-name-pattern=门禁` 45/45 exit 0；35 槽用例 1/1；`test/update-ui.test.mjs` 53/53 exit 0；`scripts/ui-audit.mjs` 11/11（100）exit 0；`render-panel-copy.mjs --check` PASS（178 行）；根 `npm test` 952/952（本树源码未变，Q1 已在本树实跑）。
- **真实浏览器**：官方 `scripts/verify-panel-chromium.mjs` 走 `ego-browser nodejs`，真实 Chromium 156.0.8078.74 + 安装版 React 18.3.1 + 310 个 primitives，47 PASS / 0 FAIL / 14 SKIP（截图通道），exit 0；`client.js` sha256 `b6d4e215…`。
- **未验边界**：真实 WebView / 真实 `/gates/models` 服务端跨仓库返回（桩按 `?repo=` 区分）；模型流的真实浏览器证据只有 V1 的临时 harness（`/tmp/v1-panel-chromium-gates.mjs`，63/63），未进仓库；真实 DSH 宿主里的面板交互与并发渲染调度。

## 三、模型链路逐段审查

### 3.1 状态与镜像

- `models` 增加 `repo`（`:2418`）：列表属于哪个仓库；`modelsStateRef` / `panelRepoRef` 两个渲染期镜像（`:2445-2448`）供异步回调同步读取。
- `panelRepoOf()`（`:2461`）= 草稿来源 → `data.repo` → prop，和渲染里的 `panelRepo` 同源（`:2555`）。异步落地、闸门分支都只认它 —— 换仓库时 prop 先变、数据/草稿还没换的窗口里，模型列表不会跟着 prop 走。

### 3.2 落地检查（迟到 / 跨仓库）

- 请求序号 `modelsSeqRef` 保持不变；新增落地前 `requestedRepo !== panelRepoOf()` 二次核对（`:2523`, `:2530`）：请求在途时仓库或草稿换过，响应直接丢弃，成功与失败（catch）两条路径都核对。
- `setModels` 只在通过核对后写 `{ repo: requestedRepo, list, ... }`；`loading` 收尾在响应内完成。探针 S9/S13/S14 覆盖成功、失败、同仓库乱序三种落地。

### 3.3 按钮与 effect

- `loadModels(forRepo = panelRepoOf())`（`:2513`）：按钮点 `onClick: () => { loadModels() }` 时按当前面板仓库取，不再默认 prop（`:2938`）。
- `[modelsPanelRepo]` effect（`:2592`）：数据换到新仓库后才读新仓库模型；`[dirty]` effect 补一条 —— 草稿清空、`repoMismatch` 变 false 时，若当前列表 `loading` 或 `repo !== modelsPanelRepo` 就补读（`:2584-2590`）。

### 3.4 闸门 / 取消 / 确认

- 闸门挡住 `/gates`（草稿来自旧仓库、响应是新仓库）时：`modelsSeqRef.current += 1`、清 `loading`、`loadModels(pendingSource)` 把列表拉回草稿来源仓库，然后 `return` 不动 data（`:2481-2490`）。探针 S3（user/project 两轮）与 S15（作废在途按钮请求）通过。
- 取消换仓库：作废 load、作废 models、清 loading、按草稿来源/数据仓库重读（`:2698-2707`）。探针 S5 验证取消后 exactly 1 条 demo models 请求、0 条 other，迟到的 other `/gates` 不上屏。
- 确认放弃草稿并切换：清草稿 → `load()`（新 repo prop）→ 数据落地后 `[modelsPanelRepo]` 读新仓库（`:2709-2715`）。探针 S6 验证确认前 0 条 other models、确认后切到 other。

### 3.5 渲染层护栏

- `modelsPanelRepo = panelRepo || repo`、`modelsStale = models.repo && models.repo !== modelsPanelRepo`，`modelsView` 在 stale 时清空 list（`:2563-2565`）：`gateModelOptions(current.semantic.model, modelsView)` 只剩当前值（`:2936`），并在按钮旁给「模型列表属于 X，不是当前面板的 Y：已忽略，请重新读取」（`:2940-2942`）。跨仓库的模型 id 无法被选中，因此保存 / 预览 / 优化带出去的模型只可能来自面板仓库。

### 3.6 保存 / 预览 / 优化目标

- `targetRepo = panelRepo || repo`（`:2558`）在 U1 前后未变；U1 只把模型列表改成同一个来源。探针 S7 同时断言 POST 的 `repo` 与 `config.semantic.model`；S16 断言预览 / 优化也带 demo。

## 四、独立探针（16/16 新树，基线 9 红）

`fixtures/gate-panel.mjs` + 真实 `client.js`；`new` = 本树，`base` = `git show 54f9052:client.js`。

| 场景 | 新树 | 基线 |
|---|---|---|
| S1 干净换仓库：数据没换前不读新仓库模型，数据换了才读 | PASS | **FAIL**（换仓库立即读 prop 模型） |
| S2 保留草稿时按钮读草稿来源仓库（user/project 两轮） | PASS | **FAIL**（按钮读 prop） |
| S3 闸门挡住 `/gates` 后重读草稿来源仓库（user/project 两轮） | PASS | **FAIL**（闸门后不回列表） |
| S4 先有草稿再换仓库：不读新仓库模型 | PASS | **FAIL**（[repo] effect 读 prop 模型） |
| S5 取消：重读面板仓库、迟到新仓库数据不上屏 | PASS | **FAIL**（取消前已请求 other models） |
| S6 确认：确认前不读新仓库，确认后跟着切 | PASS | **FAIL**（确认前已读 other） |
| S7 保存目标与所选模型同属面板仓库 | PASS | PASS（v4 targetRepo 未回退） |
| S8 project 作用域：模型锁死但列表跟面板仓库 | PASS | **FAIL**（按钮读 prop） |
| S9 迟到 models：A→B→A 往返，B 的模型后到不能上屏 | PASS | PASS（v4 已有数据仓库核对） |
| S12 列表未回来：下拉不显示其它仓库列表 + 提示重新读取 | PASS | **FAIL**（显示旧列表） |
| S13 迟到错误：旧仓库 models 失败不上屏 | PASS | PASS |
| S14 同仓库两次读取：旧响应不覆盖新响应 | PASS | PASS（既有 seq） |
| S15 闸门挡住时作废在途按钮请求 | PASS | **FAIL**（按钮读 prop，请求对象不同） |
| S16 预览与优化也跟面板仓库 | PASS | PASS（v4 targetRepo 未回退） |
| S10 卸载后在途 models 不落地 | PASS | PASS |
| S11 StrictMode 双挂载后 models 正常 | PASS | PASS |

## 五、测试与浏览器复跑

| 命令（集成树） | 结果 | 退出码 |
|---|---|---|
| `node --test test/client.test.mjs` | 167/167 pass / 0 fail | 0 |
| `PANEL_STRICT=1 node --test --test-name-pattern='门禁' test/client.test.mjs` | 45/45 pass | 0 |
| `node --test --test-name-pattern='35 槽' test/client.test.mjs` | 1/1（主面板 23 + 门禁 12 = 35 槽） | 0 |
| `node --test test/update-ui.test.mjs` | 53/53 pass | 0 |
| `node scripts/ui-audit.mjs` | 11/11（100 分） | 0 |
| `node scripts/render-panel-copy.mjs --check` | PASS（178 行，最长 77 字符） | 0 |
| `npm test`（根） | 952/952 pass | 0（本树源码未变，Q1 实跑） |
| `ego-browser nodejs < scripts/verify-panel-chromium.mjs` | 47 PASS / 0 FAIL / 14 SKIP（截图通道） | 0 |

- 官方 Chromium 环境：Chromium 156.0.8078.74、安装版 React 18.3.1、primitives 310 导出、`client.js` sha256 `b6d4e215…`、`asar` `5fa8a6b2…`；独立 loopback fake API，未进入真实 DSH Web GUI、未访问 GitHub/npm。
- 用例 diff：删除行只有 U2-F2 的旧断言（它的前提「换仓库先读新仓库模型」正是 R1 的 bug）与 models state 形状的一行；其余是新增 U5-M0…M4。既有论据未被削弱。

## 六、发现汇总（全部 low，均不阻塞 I1）

| ID | 严重度 | 位置 | 问题 | 建议（required fix） |
|---|---|---|---|---|
| Q2-L1 | low | `client.js:2445-2448, 2557` | `modelsStateRef.current` / `panelRepoRef.current` 在**渲染期**赋值（与既有 `repoRef` / `dataRef` 同一模式）。真实 React 并发渲染下，被丢弃的 render 可能短暂留下旧值，让某个 models 落地比较读到旧面板仓库；渲染护栏（`modelsStale`）与 `[modelsPanelRepo]` effect 会在提交后隐藏/重读，观察不到跨仓库可选，所以不构成功能缺陷。 | 可选：把镜像同步挪到 `useEffect`，或落地时从 state 闭包取面板仓库；若保留现状，建议在注释里写明「渲染期镜像 + 护栏自愈」的边界 |
| Q2-L2 | low | `test/client.test.mjs:4824-4863`（U5-M4） | 用例把「确认后的 `/gates` 请求数」钉成精确值 `api.pending.length === 3`（初始 1 + 直接 load 1 + `[dirty]` effect 补 1）。这是当前实现有一次重复 load 的副产物，不是需求；将来把两条 load 合并（合理优化）会让正确实现红。 | 断言改成 `>= 2` + 至少一条新仓库请求；重复 load 的数量另立一条「当前实现」的可选断言，或直接删掉精确计数 |

## 七、给 I1 的交接

1. **本项无需修复即可合并**：Q2 的 7 项审查全过；两条 low 可在下一轮处理，不进入 I1 的阻塞清单。
2. **与 Q1 相同的三项交接**（见 `docs/报告-gate-v5核心审查.md` §六）：README 单测数 934→952、真实 profile `--repair` 后复验四段全零、版本 bump / CHANGELOG / tag。
3. **模型流的浏览器回归**：仓库内的官方 Chromium 套件不覆盖 `/gates/models`；V1 的 63/63 在 `/tmp/v1-panel-chromium-gates.mjs`（临时）。本轮不要求入库，但建议下一轮把模型链路并进官方套件，避免这条 R1 只能靠临时 harness 守。

## 八、未验项

- 真实 WebView / 真实 DSH Web GUI 里的模型下拉交互（本轮为官方 Chromium + loopback fixture；未进入真实会话）。
- 真实 `/gates/models` 服务端按仓库返回不同模型（测试桩按 `?repo=` 区分；服务端返回体只校验了形状）。
- React 并发渲染下「渲染期 ref 镜像」的极端交错（Q2-L1 的理论窗口；开发态 fixture 不模拟丢弃 render）。
- 真实模型调用 / 跨仓库 baseURL 差异（v5 非目标）。
- 物理读屏 / 触摸 / IME 下的模型下拉（官方 Chromium 套件未覆盖这一控件）。

## 九、证据文件（临时，不进仓库）

| 文件 | 用途 | 结果 |
|---|---|---|
| `/tmp/q2probe/new/probe.mjs` + `/tmp/q2probe/new/client.js` | Q2 独立探针（真实 client.js + 最小 React 运行时） | 16/16 PASS |
| `/tmp/q2probe/base/probe.mjs` + `/tmp/q2probe/base/client.js` | 基线 `54f9052` 对照（同一探针） | 7 PASS / 9 FAIL |
| `/tmp/q2-client.log` 等 | client / PANEL_STRICT / slot / update-ui / ui-audit / copy 的原始输出 | 见 §五 |
| `/tmp/q2-chromium.log` | 官方 Chromium 套件原始输出（47 PASS / 0 FAIL / 14 SKIP） | exit 0 |
