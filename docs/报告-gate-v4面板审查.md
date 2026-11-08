# gate v4 面板审查（Q2）

> 审查人：reviewer（Q2）。日期：2026-11-08。
> 被审范围：U1（`client.js` 门禁 `GateSettings` 的 load 代际/取消、在途草稿保护、repo/scope 一致性；`test/client.test.mjs` + `test/fixtures/gate-panel.mjs` 新用例）。
> 被审代码树：`task/gate-v4-integration` @ `4306b29`（U1 提交 `efdda5b`，diff `2cad1a6..efdda5b`：`client.js` +52/−2、`test/client.test.mjs` +195、`test/fixtures/gate-panel.mjs` +302，共 7 条新用例）。
> 本分支：`task/gate-v4-q2`（从集成树切出），本文件是唯一产物；源码只读，未重载宿主、未碰真实 profile。
> 结论：**verdict = pass**。没有 blocker / high；1 条 medium（F1：在途 dirty + 切仓库的组合会让「保留的草稿」和「data.repo」脱钩，保存把旧仓库的规则状态/提示词写进新目标层），建议发布前修，不阻塞 I1。

## 一、结论摘要

| 审查问题 | 结论 | 关键证据 |
|---|---|---|
| 乱序响应 | 通过 | `loadSeqRef` 单调序号 + `aliveRef` + `repoRef` 三重闸门（`client.js:2423-2455`）；U1-G1/G3 真跑；基线（`2cad1a6` 的 client.js + 新用例）G1/G3 红 |
| 在途 dirty | 通过（有 F1） | 响应回来只放下「与新数据一致」的草稿（`client.js:2437-2449`）；U1-G2；基线 G2 红。**但**新仓库响应提交后确认条消失、草稿来源仓库丢失 → F1 |
| repo/scope 一致性 | 通过（有 F1/F2） | 请求侧用 `requestedRepo` 校验（`2432/2452`）；保存/预览/优化用 `data.repo`（`2494/2526/2551/2573`）；U1-E/G5。F2：取消换仓库不作废在途 `/gates/models` |
| 主面板 hook | 通过 | 主面板 23 个 state 槽未被 U1 改动（diff 只动 `GateSettings`）；`GateSettings` 仍 12 个 state 槽，新增 6 个 `useRef` + 3 个 `useEffect` 都在组件内；U1-F 的 35 槽断言绿 |
| 官方控件 | 通过 | `SegmentedControl` 一行未动；Q2-F4 委托断言（id/options/value/label/disabled 全转发）绿 |
| 保存目标 | 通过 | `targetRepo = dataRepo || repo`；U1-E（data 未切走时写旧仓库）、U1-G5（保存/预览/优化都用 `data.repo`）；**F1** 是它的组合缺口 |
| 测试不是空 effect 假绿 | 通过 | 桩跑真实 `client.js`（断言注入点存在）、状态/`useRef` 持久、`useEffect` 按依赖触发、`setState` 真重渲染、卸载跑 cleanup；基线 13 条 U1 用例 **5 红**（G1/G2/G3/G4b/G6），失败信息是真实断言（「旧响应不能覆盖新仓库数据」「在途 dirty 不能被响应清掉」） |

## 二、方法与边界

- **只读源码**：没有改 `client.js` / 用例 / fixture；探针全部在 `/tmp/q2-probe/`。**没有重跑真实 Chromium/WebView**（V1 已跑：官方套件 47/47、门禁专项 54/54，基线 52/2）；本轮验证在 Node + 假 React 桩层。
- **先红后绿（独立复现）**：`git archive efdda5b` 出一份树，只把 `client.js` 换成 `2cad1a6` 的版本（fixture/用例保持 U1 版），`node --test --test-name-pattern='U1-'`：
  - 基线：`tests 13 / pass 8 / fail 5`，exit 1；失败即 G1、G2、G3、G4b、G6。
  - 集成树：`tests 13 / pass 13`，exit 0。
  说明新用例量的是真行为，不是「effect 是空实现」的假绿。
- **独立探针**（用 U1 的 fixture 跑真实 `client.js`，只调公开渲染结果）：
  - `contam2.mjs`：切仓库请求在途时改草稿 → 响应提交新仓库数据 → 保存请求体（F1）。
  - `banner-models.mjs`：仓库确认条的时间线（编辑中出现、响应到达后消失）；取消换仓库后在途 `/gates/models` 的落点（F2）。
- **复跑**（集成树）：`node --test test/client.test.mjs` 155/155 exit 0；`PANEL_STRICT=1` 门禁组 33/33 exit 0；`test/update-ui.test.mjs` 53/53 exit 0；`scripts/ui-audit.mjs` 11/11（100 分）exit 0。
- **未验**：真实 DSH WebView/宿主、真实服务端（fetch 全是用例桩）、真实 GitHub/Gitee/模型；假 React 不模拟批处理/并发渲染/StrictMode（见 F3）；同仓乱序在真实 Chromium 被 HTTP/1.1 连接串行化不可构造（V1 已记）。

## 三、U1 逐项审查

### 3.1 乱序响应（通过）

- `load()` 进来先 `seq = ++loadSeqRef.current`（`client.js:2424`），响应回来先过 `!aliveRef.current || seq !== loadSeqRef.current`（`2430`）再拿 `repoRef.current !== requestedRepo`（`2432`）——**序号管「同一仓库的多次读取」，repo 管「跨仓库的旧请求」**，两层都必要，实现没漏。
- 错误分支同样有这两道闸（`2450-2453`），旧仓库的失败不会把新仓库的页面打成错误态。
- `loadModels()` 同样有独立序号（`2459`）+ repo 校验（`2465/2472`），模型列表不会被旧响应盖掉。
- 证据：U1-G1（旧仓库后回不覆盖）、U1-G3（同仓库两次读取先发后到）真跑绿；基线两条都红。
- 备注：`confirmRepoSwitch()` 里的 `load()` 与 `[dirty]` effect 会各发一次（既知双请求），序号保证只有最后一条生效——行为正确，只是多一次读。

### 3.2 在途 dirty（通过，F1 见 3.3）

- 旧实现 `setGateDraft(null)` 无条件清草稿；新实现按「草稿 vs 新数据的落盘结果」比较（`client.js:2437-2449`）：
  - `prev` 为空 → 放下；
  - 有草稿且与新数据不一致 → 保留（`stillDirty`）；
  - 一致 → 放下；
  - 算不清（`gateConfigOf` 抛错）→ 保留（`catch` 分支，宁可多留）。
- 这个比较用 `scopeRef.current`（响应到达时的作用域）而不是请求发起时的作用域，注释也写清了理由；作用域切换有确认条，能活到响应到达的草稿一定属于当前作用域，正确。
- 证据：U1-G2 真跑绿；基线 G2 红（「在途 dirty 不能被响应清掉」）。

### 3.3 切仓库 + 在途 dirty 的组合（F1，medium）

**场景**（U1-G2 的完整时间线，用例只断言到「草稿还在」为止）：

1. 面板在仓库 A、干净；父面板把 workdir 换成 B → `[repo]` effect 发 `GET /gates?repo=B`（干净时不拦，符合设计）。
2. 请求在途，用户在门禁页改了一条规则（草稿来自 A 的合并结果），此时确认条出现（探针实测 `beforeEdit=false / afterEdit=true`）。
3. B 的响应到达：`setData(B)` 提交 + 草稿保留（两者都符合冻结行为）。
4. **提交后 `dataRepo = B`，`repoMismatch` 变 false，确认条和「已保留草稿」条一起消失**（探针实测 `afterResponse=false`），但草稿仍是 A 的。
5. 用户点保存：`targetRepo = data.repo = B`，`gateConfigOf` 用 B 的合并结果当基线，把「草稿与 B 的差异」写进目标层——**A 的规则状态差异（和 user 层的提示词/模型）被写进 B 的项目层 / 全局 user 层**。

**独立探针**（`/tmp/q2-probe/contam2.mjs`，A 的 project 层把 `secret` 关掉，用户只改了 `abs-path`）：

| scope | 保存请求体（节选） |
|---|---|
| project | `repo: E:/work/other`，`rules: [{secret, enabled:false}, {abs-path, enabled:false}]` |
| user | `repo: E:/work/other`，`semantic.prompt: "仓库 E:/work/demo 的提示词"`，`rules: [secret:false, abs-path:false]` |

也就是说：用户只动了 `abs-path` 一条，保存却把 demo 的 `secret:false`（用户没碰过的规则状态）和 demo 的提示词写进了 other 的项目层/全局 user 层。面板同时显示 other 的路径，**没有任何提示这份草稿来自 demo**。

**为什么定 medium 而不是 high**：触发要求「干净状态下切仓库 + 在往返窗口内开始编辑 + 再保存」，本地 `/gates` 往返只有几十毫秒；而且面板是 WYSIWYG（保存的正是屏幕上那份草稿），用户有概率察觉。但它确实是 U1 的「不能写错仓库」在组合场景下的缺口，且写的是门禁规则状态（把一条检查在另一个仓库静默关掉），所以建议发布前修。

**建议修复**：
- 草稿带来源仓库（`draftRepoRef`，创建草稿时记录、清草稿时清空）；`load()` 提交前若「草稿脏 且 `value.repo !== draftRepoRef.current`」→ **不提交**（保留旧数据 + 确认条），等用户明确选择；或
- 提交但保留确认条，并在保存时把目标仓库钉在草稿来源仓库（`targetRepo = draftRepo || dataRepo || repo`），直到用户放弃/确认。
- 两种改法都要补一条用例：**解析新仓库响应后，保存请求体不能包含旧仓库的规则状态/提示词**（U1-G2 目前只断言草稿还在，U1-E 只覆盖 data 未切走的分支）。

### 3.4 取消换仓库（通过，F2 见 3.5）

- `cancelRepoSwitch` 把 `loadSeqRef` 自增（作废已发出的新仓库读取）+ 挂 `{repoHeld:true}`（`client.js:2618-2621`）；晚到的 `/gates` 响应被序号拦下，数据留在旧仓库。U1-G4b 真跑绿；基线红。
- 作用域确认与仓库确认的 `repoHeld` 合并逻辑（`cancelSwitch`/`requestScope`）正确，U1-E 末段两个确认互不吞的断言绿。

### 3.5 取消换仓库后的在途模型列表（F2，low）

- `cancelRepoSwitch` 只作废 `loadSeqRef`，不动 `modelsSeqRef`；`loadModels()` 的闸门是 `repoRef.current !== requestedRepo`，而取消后 `repo` prop 仍是新仓库 → 新仓库的模型响应**照常提交**。
- 探针（`banner-models.mjs`）：取消后「已保留草稿」在、数据仍是旧仓库，但模型下拉的选项已经是新仓库的（`["group/deepseek-v4.1-flash-1017", "m-other"]`，其中 `m-other` 来自 other 的响应）。
- 影响：旧仓库的配置会看到新仓库的模型列表；选中 `m-other` 保存，会把一个只属于新仓库 baseURL 的模型 id 写进旧仓库的语义复审配置。低概率、可察觉、可改回。
- 建议：`cancelRepoSwitch` 里同时 `modelsSeqRef.current += 1`，或把 `loadModels` 的仓库校验改成「`repoRef.current` 且 `dataRepo` 都匹配」。

### 3.6 卸载（通过，F3 见 3.7）

- `aliveRef` 在 cleanup 置 false（`client.js:2421`），`load`/`loadModels` 的响应都被拦；U1-G6 用桩的 `violations()` 断言「卸载后不能再 setState」绿；基线红。

### 3.7 其它观察

| # | 严重度 | 位置 | 问题 | 建议 |
|---|---|---|---|---|
| F3 | low | `client.js:2412/2421` | `aliveRef` 只在 `useRef(true)` 初始化，cleanup 置 false 后**没有复位**：React 18 **StrictMode 开发模式**双挂载（mount → cleanup → mount）会让它永远 false，门禁页一直停在「正在读取门禁配置…」。生产构建不双挂载，只影响 `pnpm run dev:web` 开发态（V1 R3 复核：代码属实） | effect 体里先 `aliveRef.current = true` 再返回 cleanup |
| F4 | info | `client.js:2415-2418` | `repoRef.current = repo` / `scopeRef.current = scope` 在 **render 期间**赋值；并发渲染下可能指向被丢弃的 render（当前宿主用 legacy root，实际不触发） | 用 `useEffect` 同步，或 `useMemo` 包一层；至少加注释说明依赖 legacy root |
| F5 | info | `test/fixtures/gate-panel.mjs` | fixture 放在 `test/` 下，会被 `node --test` 当测试文件执行（0 断言、+1 计数）；不影响结论，但会稀释「测试数」 | 改名 `*.fixture.mjs` 或移到 `test-support/`（与 gate 包一致） |
| F6 | info | `client.js:2529-2531` | 保存 POST 在途时用户新改的草稿会在成功后被 `setGateDraft(null)` 清掉（**既有行为**，U1 未改；输入框没有 busy 禁用） | 记录在案即可；若要修，保存成功后先比较草稿是否变过再清 |
| F7 | info | `client.js:2510` | 放弃草稿/保存后 `[dirty]` effect 会补一次读取（既知双请求），序号保证只有最后一条生效 | 保持；用例已覆盖两条都回同一份数据 |

## 四、测试质量（不是空 effect 假绿）

- **桩是真的在跑组件**：`loadGatePanel` 用字符串注入把 `GateSettings` 挂到 `window.__gatePanelInternals`，并断言注入点存在（`gate-panel.mjs:109-112`）——`client.js` 一改出口就当场失败，不会静默跑空。
- **运行时语义**：`useState` 槽持久、`useRef` 槽持久、`useEffect` 按依赖触发并在重跑前跑 cleanup、`setState` 真的 `flush` 重渲染（`gate-panel.mjs:158-240`）、卸载后 setState 记 violation（`161-165`）。
- **先红后绿**：同一套用例换回 `2cad1a6` 的 `client.js` → 5 红（G1/G2/G3/G4b/G6），失败信息是真实断言（不是 harness 报错）；换回 U1 版 → 13/13 绿。
- **缺口**：U1-G2 只断言「响应不能清掉草稿」，没断言「提交后草稿与 data.repo 的一致性」；U1-E 只覆盖 data 未切走的分支。F1 正好落在这两条之间（见 3.3 的补例建议）。
- **fidelity 边界**：假 React 不模拟批处理/并发渲染/StrictMode；`queueMicrotask` 同步执行、`setTimeout` 是桩——所以 F3 这类「只有 StrictMode 才触发」的问题测不出来，只能靠代码审查（V1 已记，本轮复核）。

## 五、给 I1 的交接

1. **建议（非阻塞）**：把 F1 安排给 U1 修掉再发布——它是「不能写错仓库」的组合缺口，修法小（草稿来源仓库 + 不提交/钉住目标仓库 + 补一条用例）。若不修，CHANGELOG 的 v4「边界」里要写明「切仓库在途改草稿后保存，可能把旧仓库的规则状态写进新目标层」。
2. F2 顺手修（一行 `modelsSeqRef.current += 1`）；F3 修 StrictMode 复位（dev 体验）。
3. 计数口径：client 155 条（U1 新增 7 条）；`test/fixtures/gate-panel.mjs` 被 `node --test` 当测试文件 +1（V1 已记），若要干净可改名。
4. 发布前用合并后的最终树复跑 `test/client.test.mjs`、`PANEL_STRICT=1` 门禁组、`update-ui`、`ui-audit` 与真实 Chromium 套件；Q2 的计数是在集成树 `4306b29` 上跑的。

## 六、未验项

- 真实 DSH WebView/宿主、真实浏览器（V1 的 Chromium 47/47、54/54 未由 Q2 复跑）；
- 真实服务端（fetch 全是桩，未连 `/gates` 路由）；
- 假 React 不覆盖批处理/并发渲染/StrictMode；F3 只能代码审查；
- Linux/CI 调度下的竞态概率（本机 Windows）；
- 真实长会话下的双请求放大（F7）未做性能测量。

## 七、证据文件（临时，不进仓库）

| 文件 | 内容 |
|---|---|
| `/tmp/q2-client-full.log` | 集成树 `test/client.test.mjs` 155/155 exit 0 |
| `/tmp/q2-panel-strict.log` | `PANEL_STRICT=1` 门禁组 33/33 exit 0 |
| `/tmp/q2-update-ui.log` | `test/update-ui.test.mjs` 53/53 exit 0 |
| `/tmp/q2-ui-audit.log` | `scripts/ui-audit.mjs` 11/11（100 分）exit 0 |
| `/tmp/q2-baseline-u1.log` | 基线（`2cad1a6` client.js + U1 用例）13 tests / 8 pass / 5 fail，exit 1 |
| `/tmp/q2-probe/contam2.mjs` | F1 复现：project/user 两种 scope 的保存请求体 |
| `/tmp/q2-probe/banner-models.mjs` | 确认条时间线 + 取消后模型列表被换走（F2） |
| `/tmp/q2-baseline/` | 基线树（`git archive efdda5b`，client.js 换回 `2cad1a6`） |
