# gate v4 面板复审（Q2R）

> 审查人：reviewer（Q2R）。日期：2026-11-08。
> 被审：U2（`task/gate-v4-ui` @ `fccb1c1`，父 `efdda5b`；`client.js` +106/−29、`test/client.test.mjs` +263、`test/fixtures/gate-panel.mjs` +13，7 条新用例）。
> 复审树：`task/gate-v4-q2r` = `task/gate-v4-q2` @ `08d70ed` + `git merge --no-ff fccb1c1`（合并点 `32976e6`）。第一轮报告见同目录 `docs/报告-gate-v4面板审查.md`。
> 本分支：本文件是唯一新增产物；源码只读，未重载宿主、未碰真实 profile。
> 结论：**verdict = pass**。**Q2-F1 已闭合**（project / user 两 scope 独立复现：保存、预览、优化都钉在草稿来源仓库，确认条不消失，不再把旧仓库状态写进新仓库）；Q2-F2 取消路径闭合；Q2-F3 闭合。新记 1 条 low（R1：`/gates/models` 在「闸门挡住 /gates」与「读取模型列表」两条路径上仍跟 prop 仓库）。**F1 闭合 → 允许 I1。**

## 一、结论摘要

| 复审项 | 结论 | 证据 |
|---|---|---|
| **Q2-F1 跨仓库草稿污染** | **闭合** | 独立探针 `contam3.mjs`（project + user 两 scope）：B 响应到达后数据仍 A、确认条在、`prompt` 仍是 A 的；预览/优化/保存的 `repo` 全是 A；保存体只含用户动过的规则（+ A 自己 project 层的既有覆盖），**不再出现 B 的 `repo` 或 A 的语义提示词**。U2-C1/C2 真跑绿；基线（`efdda5b` 的 client.js）两条都红 |
| Q2-F2 取消换仓库后 models | 闭合（取消路径） | 独立探针 `models-gate.mjs` 第二段：取消后选项 `[当前模型, m-demo]`，**没有 m-other**；取消时重读面板仓库（demo）的模型列表，无「读取中…」残留。U2-F2 绿；基线红 |
| Q2-F3 StrictMode | 闭合 | effect 体里 `aliveRef.current = true`（`client.js:2443-2451`）；fixture 新增 `strictEffects` 模拟 mount→cleanup→mount；U2-F3 绿；基线红 |
| 乱序响应 | 通过 | 序号 + repo 闸门未回归；U2-C4（两次换仓库乱序）绿；基线红 |
| 在途 dirty | 通过 | 草稿来源仓库闸门 + clean 草稿放行；U2-C1/C5 绿；基线红 |
| 主面板 hook | 通过 | 23 槽未动；`GateSettings` 12 个 state 槽 + 新增 `draftRef`/`dataRef`（都在组件内）；35 槽断言绿 |
| 官方控件 | 通过 | `SegmentedControl` 一行未动；Q2-F4 委托断言绿；PANEL_STRICT 40/40 |
| 测试不是空 effect 假绿 | 通过 | 基线 7 条 U2 用例 **0 pass / 7 fail**（真实断言）；修复后 162/162；桩跑真实 `client.js`、状态/ref 持久、effect 按依赖、卸载 guard |

## 二、方法与计数

- **独立基线**：`git archive fccb1c1` 出一份树，只把 `client.js` 换成 `efdda5b`（U1 版），用例/fixture 保持 U2 版 → `node --test --test-name-pattern='U2-'` = **tests 7 / pass 0 / fail 7**，exit 1（C1「确认条必须还在」、C2、C3、C4、C5、F2、F3 全红，全是真实断言，不是 harness 报错）。
- **独立探针**（用 Q2R 的 fixture 跑真实 `client.js`，只读渲染结果）：
  - `/tmp/q2-probe/contam3.mjs`：Q2-F1 组合（干净切 A→B、B 响应在途编辑、保存/预览/优化 targetRepo）。
  - `/tmp/q2-probe/models-gate.mjs`：闸门挡住 `/gates` 后的 `/gates/models` 落点、「读取模型列表」按钮的仓库、取消路径的 models 纠正。
- **计数/退出码（Q2R 合并树 `32976e6`）**：

| 命令 | 结果 |
|---|---|
| `node --test test/client.test.mjs` | **162/162**，exit 0（`/tmp/q2r-client.log`） |
| `PANEL_STRICT=1 node --test --test-name-pattern='门禁' test/client.test.mjs` | **40/40**，exit 0（`/tmp/q2r-panel-strict.log`） |
| `node --test test/update-ui.test.mjs` | **53/53**，exit 0（`/tmp/q2r-update-ui.log`） |
| `node scripts/ui-audit.mjs` | **11/11（100 分）**，exit 0（`/tmp/q2r-ui-audit.log`） |
| `npm test`（全量） | **924/924**，exit 0（`/tmp/q2r-full-test.log`；V1 集成树 917 + U2 新增 7） |
| 基线（U1 client.js + U2 用例） | **0/7**，exit 1（`/tmp/q2r-baseline-u2.log`） |
| `node --check client.js` + `audit-react-semantics / line-length / conditional-asserts / test-skips / tmp-dirs / syntax` | 全 exit 0（`/tmp/q2r-audit-*.log`） |

## 三、U2 实现审查

### 3.1 草稿来源仓库（F1 的修法）

- `gateDraftRepo(draft)`（`client.js:2299`）读草稿上的 `repo` 字段；`setDraftConfig`（`2543`）在每次建/改草稿时写入 `draftSourceRepo() = draftRepo || dataRepo || repo`。**所有非 null 的草稿写入都走 `setDraftConfig`**（`optimizePrompt`/`setSemantic`/`toggleRule`；grep 只有这 3 处，其余 `setGateDraft` 都是 null 或 updater），没有漏网路径。
- `load()` 的提交闸门（`client.js:2462-2476`）：响应仓库 `replyRepo = value.repo || requestedRepo`；若「草稿来源仓库」与响应仓库不同，就用**草稿自己那个仓库的数据**（`dataRef`，repo 对得上才用）算 `gateDraftDirty`，仍脏就 **return 不提交**（数据留在旧仓库、确认条保留）；只有改回原样的 clean 草稿才 `setGateDraft(null)` 放行新数据。
- 这条闸门挡住了 Q2-F1 的整条污染链：提交不了新仓库数据 → `dataRepo` 不变 → `repoMismatch` 仍真 → 确认条不消失 → 保存/预览/优化继续走 `panelRepo`（草稿来源）。
- 边界：`sourceData` 为 null（`data.repo` 没回显）时按「仍有改动」处理，宁可让用户显式取消/放弃，也不静默换仓库——安全方向。

### 3.2 panelRepo / targetRepo

- `panelRepo = dirty && draftRepo ? draftRepo : dataRepo`（`2538`），`targetRepo = panelRepo || repo`（`2539`），保存/预览/优化统一用它（`2577/2602/2624`）；`repoMismatch` 也用 `panelRepo`（`2540`），确认条文案同步（`2720/2727`）。
- 在闸门成立时 `dataRepo === draftRepo === A`，`panelRepo = A`；闸门放行后（clean）草稿已清、`panelRepo = dataRepo = 新仓库`——两条路径都自洽。
- 审查结论：没有发现 `targetRepo` 与草稿来源脱钩的路径。

### 3.3 models（F2 取消路径，R1 残留）

- `loadModels(forRepo)` 的提交条件改成「`forRepo` 等于当前 prop 仓库 **或** 面板数据回显的仓库」（`client.js:2494-2516`）；`cancelRepoSwitch` 同时作废 `modelsSeqRef`、收尾 loading、重读面板仓库的模型列表（`2670-2679`）。
- 取消路径**闭合**（独立探针：无 `m-other`、重读 `m-demo`、无「读取中…」）。
- 残留 **R1**（low，见 §五）：闸门挡住 `/gates` 时，新仓库的 `/gates/models` 仍会落地（`forRepo === repoRef.current`），且「读取模型列表」按钮默认发 prop 仓库——保留草稿期间模型下拉会是新仓库的。

### 3.4 StrictMode

- `useEffect` 体里先 `aliveRef.current = true` 再返回 cleanup（`2443-2451`）；fixture 的 `strictEffects` 在首轮 flush 后执行 cleanup → 清槽 → 重跑 effect（`gate-panel.mjs:241-250`），与真实 React 18 语义一致。U2-F3 绿，基线红。

### 3.5 其它

- `[dirty]` effect（`2558-2563`）现在在「草稿变干净且仓库已换」时同时补 `load()` 与 `loadModels()`，与取消路径的重读互补。
- `loadModels` 的 `requestedRepo`/`dataRef` 判定、`cancelRepoSwitch` 的 loading 收尾都正确。
- Q2 报告的 F4/F5/F6/F7（render 期写 ref、fixture 计为测试文件、保存在途新草稿被清、双请求）U2 未处理，仍在（见 §六）。

## 四、Q2-F1 独立复现（闭合判定）

探针 `contam3.mjs`：demo 的 project 层把 `secret` 关掉；干净时切到 other，other 的 `/gates` 在途时用户只把 `abs-path` 关掉；other 响应到达后：

| 观测 | project scope | user scope |
|---|---|---|
| `prompt` 显示 | `仓库 E:/work/demo 的提示词`（数据没切） | 同左 |
| 确认条 | `仓库已切换到 E:/work/other` 仍在 | 同左 |
| 面板路径 | demo 的 `.superagent/gates.json` | user 层路径（本来就不是仓库路径） |
| 预览 `repo` | `E:/work/demo` | `E:/work/demo` |
| 优化 `repo` | 项目层不可优化（null，符合契约） | `E:/work/demo` |
| 保存 `repo` / `scope` | `E:/work/demo` / `project` | `E:/work/demo` / `user` |
| 保存规则 | `[secret:false（demo 自己 project 层的既有覆盖）, abs-path:false（用户动过）]` | `[abs-path:false]`（**没有** demo 的 secret 状态） |
| 保存 semantic | 不写 | `{enabled:false, model, prompt:'优化后的提示词'}`——用户主动点过「优化提示词」，写回是预期行为 |

对照 Q2 的复现（`saveRepo=other`、`secret:false` 被写进 other、demo 提示词被写进全局 user 层）：**F1 已闭合，没有残留的跨仓库写入路径。**

## 五、R1（low）：闸门/按钮路径的模型列表仍跟 prop 仓库

探针 `models-gate.mjs` 第一段（`deferModels`）：

1. demo 挂载，读 demo 的 `/gates` 与 models（`m-demo`）。
2. 切到 other → `/gates` 与 `/gates/models` 都在途；用户在往返窗口里改提示词（草稿来源 demo）。
3. other 的 `/gates` 回来 → 闸门挡住：数据仍是 demo、确认条在、`prompt` 仍是用户手改值（**F1 正确**）。
4. other 的 `/gates/models` 晚到 → **仍然落地**：模型下拉变成 `[当前模型, m-other]`。
5. 点「读取模型列表」→ 请求的是 `repo=E:/work/other`（prop），不是面板数据/草稿来源的 demo。

影响：保留草稿期间，模型下拉展示的是新仓库的模型；选中 `m-other` 保存会把只属于 other baseURL 的模型 id 写进 demo 的配置（`targetRepo` 会写 demo，所以是「跨仓库模型 id 污染 demo」，不是写错仓库）。低概率、用户可察觉、可改回，定 **low**。

建议：`load()` 的闸门 return 分支里 `modelsSeqRef.current += 1` 并 `loadModels(gateDraftRepo(draftRef.current))`；「读取模型列表」按钮改 `loadModels(panelRepo || repo)`；或给 models 也记一个「当前列表属于哪个仓库」的 ref，渲染前对不齐就重读。U2 未验项③（「models 响应在点取消之前已落地」的短暂窗口）在取消路径已由 seq 作废 + 重读收敛，R1 是**闸门路径**的残留，两者不同。

## 六、发现汇总

| ID | 严重度 | 位置 | 问题 | 建议 |
|---|---|---|---|---|
| R1 | low | `client.js:2494-2516`（`loadModels`）、`2670-2679`（cancel）、`[repo]` effect | 闸门挡住 `/gates` 后，新仓库的 `/gates/models` 仍落地；「读取模型列表」按钮默认发 prop 仓库 → 保留草稿期间模型下拉是新仓库的 | 闸门 return 时作废并重读草稿来源仓库的 models；按钮改 `loadModels(panelRepo || repo)` |
| — | info | `client.js:2431-2442` | `repoRef/scopeRef/draftRef/dataRef` 在 render 期赋值（Q2-F4 未处理；当前宿主 legacy root，不触发） | 记入 I1 边界或后续用 effect 同步 |
| — | info | `test/fixtures/gate-panel.mjs` | fixture 被 `node --test` 当测试文件（0 断言、+1 计数，Q2-F5 未处理） | 可改名 `*.fixture.mjs` |
| — | info | `client.js:2580-2581` | 保存 POST 在途时新改的草稿会在成功后清掉（Q2-F6 未处理，既有行为） | 记入边界 |
| — | info | `client.js:2558-2563` | 放弃/保存后 `[dirty]` effect 补一次读取（Q2-F7 既知双请求） | 保持 |

## 七、给 I1 的交接

1. **F1 已闭合 → 允许 I1**（task 的硬条件满足）。Q2-F2 取消路径、Q2-F3 均已闭合。
2. 计数：Q2R 合并树 `32976e6` 上 client **162/162**、PANEL_STRICT **40/40**、update-ui **53/53**、ui-audit **11/11（100 分）**、全量 `npm test` **924/924**，全部 exit 0；基线 0/7。
3. R1 建议顺手修（两行 + 一条用例），或写进 CHANGELOG 的 v4 边界；Q2 的 F4/F5/F6/F7 仍在，属既有/低风险项。
4. README 的「890 项单测」需回填为最终实测数（本树 924；I1 按合并后最终树为准）；版本 bump、真实 profile repair 未变。

## 八、未验项

- 真实 DSH WebView/宿主与真实 Chromium：V1 已跑（官方套件 47/47、门禁专项 54/54），Q2R 未复跑；
- 真实服务端：fetch 全是桩，未连 `/gates` 路由；
- 假 React 不模拟批处理/并发渲染；StrictMode 是 fixture 的 cleanup→re-run 语义（`strictEffects`），不是真 React StrictMode；
- CI Node 22/24 未在本地跑（本机 24.20）；
- R1 的修法未验证（本轮只证明问题存在）。

## 九、证据文件（临时，不进仓库）

| 文件 | 内容 |
|---|---|
| `/tmp/q2r-client.log` | Q2R client 162/162 exit 0 |
| `/tmp/q2r-panel-strict.log` | PANEL_STRICT 门禁组 40/40 exit 0 |
| `/tmp/q2r-update-ui.log` | update-ui 53/53 exit 0 |
| `/tmp/q2r-ui-audit.log` | ui-audit 11/11（100 分）exit 0 |
| `/tmp/q2r-full-test.log` | 全量 npm test 924/924 exit 0 |
| `/tmp/q2r-baseline-u2.log` | 基线（`efdda5b` client.js + U2 用例）0/7 exit 1 |
| `/tmp/q2-probe/contam3.mjs` | Q2-F1 组合（project/user、保存/预览/优化 targetRepo） |
| `/tmp/q2-probe/models-gate.mjs` | R1（闸门/按钮路径）+ 取消路径 models 纠正 |
| `/tmp/q2r-baseline/` | 基线树（`git archive fccb1c1` + client.js 换回 `efdda5b`） |
