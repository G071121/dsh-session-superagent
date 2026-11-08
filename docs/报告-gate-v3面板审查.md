# 门禁 v3 面板审查（Q2）

> 审查人：reviewer（严格审查专员）· 团队 `dsh-gate-v3` · 2026-11-08
> 审查对象：`D:\主工作区\projects\.tmp-issue9-push-20261106-1244`，分支 `feat/gate-v3`，HEAD `e5cf489`，
> 工作树 `client.js` sha256 `8984d60f…a9eb77`（与 V1 报告的 Chromium 验收同一份）
> 结论：**PASS** —— 0 blocker / 0 high。U1 的 6 项面板要求全部复算通过；
> 2 条 low 竞态（既有 `load()` 语义，非本轮引入）+ 2 条 info/未验项见 §八。源码只读，本轮唯一 repo 写入是本报告。

---

## 〇、结论速览

| 审查项 | 结论 | 证据 |
|---|---|---|
| 用户层 `semantic:false` 三处一致 | ✅ | 开关 `aria-checked=false`、底部「当前关闭」、预览 POST `semantic:false`；打开开关后保存真的写 `enabled:true`（S1 / U1-A） |
| `extends:false/'none'` | ✅ | 可保存、POST 原样带回、页面提示「原样写回」；共享形式禁用保存并点名形态+路径+下一步；真实 gate 包落盘后仍是 replace（S2 / U1-B / U1-C / 落盘探针） |
| dirty 切作用域 | ✅ | 干净直切；脏时确认条；取消保留草稿、确认才清；不吞仓库确认（S3 / S9 / U1-D） |
| dirty 切仓库 | ✅ | 有草稿不读新仓库；确认条说明 A/B；取消保留；确认/保存/放弃才读 B；保存/预览/optimize 落 `data.repo`（S4 / S5 / S10 / U1-E） |
| 主面板 hook 数 | ✅ | 主面板 23、GateSettings 12、门禁页 35；HEAD 是 34（11+23）；多一个槽会抛（S6 / U1-F） |
| 官方控件 | ✅ | `SegmentedControl` 委托/回退实现未改；Q2-F4 26/26（含方向键/Home/End/跳过 disabled） |
| 保存不丢配置 | ✅ | 本层规则+改动规则、`semantic` 未展示字段、`extends:false/'none'`、`semantic:false` 都原样/语义不变落盘（U2 890、U1-B、落盘探针 2/2） |

---

## 一、审查对象与方法

- U1 改动：`client.js` +136/−25，`test/client.test.mjs` +298/−5（新增 U1-A…U1-F）。
- 只读源码，未修改实现/测试；**没有重启 DSH**，没进真实 DSH Web GUI。
- 独立复算手段（都在仓库外 `D:\主工作区\projects\.tmp-q2-review-20261108`）：
  1. **effect 语义探针**：在 VM 里执行真实 `client.js`，用位置化 23+12 槽（与仓库测试桩同一套顺序）实现 `useState`/`useEffect`（deps 比较 + commit + setState 重渲染）跑 12 个场景（S1–S10），专门补 `panel-harness.mjs` 的 `useEffect() {}` 验不到的两条 effect 与异步竞态。
  2. **真实 gate 包落盘探针**：面板 POST 形状 → `validateConfig → writeGateConfig → 读回`，验证 `extends:'none'` + 字面量 `semantic:false` + 规则改动的组合。
  3. **官方 Chromium 验收脚本**：`ego-browser nodejs` 跑 `scripts/verify-panel-chromium.mjs`（安装版 React 18.3.1 + Chromium 156；client sha256 与工作树一致）→ **47 PASS / 0 FAIL / 14 SKIP**（截图通道不可用）。
- 说明：探针不是浏览器，不能替代 WebView/IME/物理读屏；它证的是真实 `client.js` 的状态机与 effect 路径。

---

## 二、`semantic:false` 三处一致（U1-A）

代码（`client.js`）：

- `gateSemanticOf`（`:2268`）先算 `off = own === false || (own 对象且 enabled === false)`，`enabled` 在 `off` 时恒为 `false` —— 开关、底部、预览都读 `enabled`，不会再出现「继承来的 true 顶着关闭」。
- 用户层开关（`:2785`）`onChange` 在打开时把 `off` 清成 `false`；`gateConfigOf`（`:2322`）在 `enabled/model/prompt` 变化时写 `{...本层原有字段, enabled, model, prompt}`。
- 项目层是另一个开关 `gate-semantic-off`（`:2776`），勾选写 `semantic:false`，取消勾选删掉本层覆盖。
- 预览（`:2509-2512`）`semantic: semanticOn && trigger 属于 merge/release`；`semanticOn`（`:2585`）要求 `off !== true && enabled === true`。

独立结果（S1）：数据里「我的」层 `semantic:false`、合并值 `enabled:true` 时：

- 开关 `aria-checked=false`；页面文本同时出现「当前关闭」、不出现「当前开启」；预览 POST `semantic:false`。
- 点击开关 → `aria-checked=true`；保存 POST `config.semantic.enabled === true`，且 `model/prompt` 用继承值补全。
- U1-A 单测同样断言这三处与保存；`npm test` 内 890/890 通过。

项目层口径（S1/U1 已有覆盖）：项目层只能关；`semantic:false` 时「在本项目关闭语义复审」勾选、底部「当前关闭」、预览 `semantic:false`。

---

## 三、`extends:false / 'none'`（U1-B / U1-C）

- 面板把 `extends` 分成两类（`:2448-2451`）：`false/'none'` = 断开继承（可保存，`gateConfigOf` 原样带回）；其余已定义值（路径/对象/true/非法值）= 共享/非法 → 保存禁用 + alert 点名「extends:./shared.json / extends 内联对象 / extends:true」+ 配置路径 + 「请直接改配置文件」。
- 独立结果：
  - S2（`false` 与 `'none'` 各一次）：保存按钮可用、页面不含「共享规则」、包含「原样写回」、POST `config.extends` 逐字节相等（`false` / `'none'`）。
  - S2 共享形式：保存按钮 disabled，`save()` 早退不发 POST；alert 同时包含形态、`E:/work/demo/.superagent/gates.json` 和下一步。
  - U1-B 还做了真实落盘：POST → `validateConfig → writeGateConfig` → 磁盘 `extends` 还在、`replace` 语义还在（默认层规则不回流）；U1-C 覆盖字符串/对象/true 三类。
  - **Q2 落盘探针**：用户层 `extends:'none'` + 手写字面量 `semantic:false` + 关一条规则 → 面板 POST 同时带回 `extends:'none'` 与 `semantic:false` → 服务端落盘/重读仍 replace + 语义关闭；项目层 `extends:false` 同样往返通过（2/2 PASS）。

---

## 四、dirty 取消/确认（U1-D / U1-E）

### 4.1 切作用域

- `requestScope`（`:2557`）：干净直接 `applyScope`；脏则挂 `pendingSwitch={type:'scope', next}`，不切。
- 确认条（`:2610` 附近）：文案「还有未保存的改动：切到「项目」会丢掉这份草稿。」+「取消」/「放弃草稿并切换」。
- `cancelSwitch`（`:2568`）只关确认层；若此前选择过「保留草稿」，保留 `repoHeld:true`。
- 独立结果（S3）：脏时点「项目」→ scope 不变、pending 正确；取消 → 草稿字节不变、pending 清空；再次点「项目」→ 确认后才 `scope='project'` 且 draft=null。
- S9：先「保留草稿」再点作用域 → 两条确认同时在场（不是互相吞），确认后草稿清空并读新仓库。

### 4.2 切仓库

- `targetRepo = data.repo || repo`（`:2452`），`repoMismatch`（`:2453`）决定确认条；保存/预览/optimize 全用 `targetRepo`（`:2484 / :2509 / :2531`）。
- 关键 effect（`:2462-2470`）：
  - `useEffect([repo])`：有草稿直接 return，不 `load()`（load 会 `setGateDraft(null)`，`:2416`）。
  - `useEffect([dirty])`：草稿变干净且仓库已换 → 补一次 `load()`。
- 独立结果：
  - S4：草稿 + 切到 `E:/work/other` → 页面同时出现 A/B，且 **没有** `/gates?repo=other` 的配置 GET；保存 POST `repo=E:/work/demo`（旧仓库）；保存成功后（草稿清了）才读 B。
  - S4 取消：出现「已保留草稿」，secret 开关仍是草稿里的 false，仍不读 B；点「放弃草稿并切换」才读 B 且 draft=null。
  - S5：干净切仓 → effect 直接读 B、显示 B 的项目配置文件路径、无确认条。
  - S10：有草稿时切 B 不读；把规则手工改回与 derived 一致（dirty=false）→ effect 补读 B。这正是 U1 声称的 `useEffect([dirty])` 路径。
  - U1-D/U1-E 覆盖状态与请求形状；但 **U1-E 的「取消不能去读新仓库」在单测桩里是空转**：`loadStatefulPanel` 的 `useEffect` 是空实现，取消路径本身不发请求，所以这条断言在单测层即使实现去读了 B 也会过。真实 effect 路径由本轮 S4/S10（真实 `client.js` + deps effect）与 V1 的外部 Chromium 专项覆盖，见 §八 R5。

---

## 五、hook 槽位与官方控件（U1-F / Q2-F4）

- `GateSettings` 的 12 个 `useState` 全在函数顶部，`pendingSwitch` 是**末尾追加**（`:2407`），前面 11 个顺序未动；主面板 `ZhuliPanel` 本轮没有新增/删除 hook。
- 测试桩按位置取状态；`test/client.test.mjs` 的 `gateQueue` 是 23+12=35，U1-F：
  - `deskQueue(...).length === 23`；
  - `gateQueue().length === 35`；
  - 多传一个槽必须抛「组件用了 35 个」（少传/错位不静默）。
- 我的 effect 探针：门禁页 `useState=35`；切走到「来源」分区后 `useState=23`（GateSettings 卸载），独立复算主面板没有悄悄加槽。
- HEAD 对照：HEAD `GateSettings` 11 个、总 34；把 U1 测试跑 HEAD `client.js` → **tests 6 / pass 0 / fail 6**（其中 U1-F 报 34），证明 6 条用例盯的确实是新行为。
- 官方 `SegmentedControl`（`:944`）委托/本地回退未改；`onChange` 只从直切改成 `requestScope`。Q2-F4 的委托、方向键/Home/End/跳过 disabled 断言 26/26 通过。

---

## 六、保存不丢配置

- `gateConfigOf`（`:2322-2367`）：
  - 本层原有规则全量写回（`gateRuleBody` 完整规则）；与合并结果相同的规则不重复写、不凭空加；
  - `semantic` 未改 → 本层原值（对象或 `false`）原样写回；改了 → 以本层原对象为底，保留 `mode/baseURL/timeoutMs/maxInputChars` 等面板不展示字段；
  - 本层 `extends:false/'none'` 原样写回。
- 既有 U2 用例（890 全量中）已证：只改规则时 `semantic` 及其隐藏字段不丢；只改 semantic 开关时 baseURL/mode/timeout 不丢。
- Q2 落盘探针（2/2）：
  - 用户层 `extends:'none'` + 字面量 `semantic:false` + 关规则 → POST 同时带回两者；真实 gate 包落盘后 `extends:'none'` 仍在、replace 语义仍在、语义仍关闭（服务端 `validateConfig` 把字面量 `false` 归一成 `{enabled:false}`，**语义不变**；这是既有归一化，不是丢失）。
  - 项目层 `extends:false` + 关规则 → 落盘/重读 `extends:false` 仍在，默认层规则不回流。

---

## 七、真实计数（全部本轮复跑）

| 命令 | 结果 |
|---|---|
| `npm test` | **890 / 890 pass**，fail 0，exit 0 |
| `node --test test/client.test.mjs` | **148 / 148 pass**，exit 0 |
| `PANEL_STRICT=1 node --test --test-name-pattern='门禁' test/client.test.mjs` | **26 / 26 pass**，exit 0 |
| `node --test test/update-ui.test.mjs` | **53 / 53 pass**，exit 0 |
| `node scripts/ui-audit.mjs` | **11/11 通过（100 分）**，exit 0 |
| `node scripts/render-panel-copy.mjs --check` | PASS（178 行；超 80 字符 0 条） |
| `ego-browser nodejs` 跑 `verify-panel-chromium.mjs` | **47 PASS / 0 FAIL / 14 SKIP**（截图通道不可用；React 18.3.1 / Chromium 156；client sha256 与工作树一致） |
| U1 测试跑 HEAD `client.js` | **6 tests / 0 pass / 6 fail**，exit 1（证明用例不是空转） |
| Q2 effect 探针 | **12 / 12 场景 PASS**（含 S7/S8 竞态复现） |
| Q2 落盘探针 | **2 / 2 PASS** |

---

## 八、残余风险与未验项（均不阻塞本轮）

### R1（low）`load()` 在途时新建的草稿会被响应静默清掉

- 复现（S7）：仓库从 A 切到 B（干净）→ `useEffect([repo])` 发起 `/gates?repo=B`；请求在途时用户关掉一条规则（draft 非空）→ 响应到达 `setData(B); setGateDraft(null)`（`client.js:2416`）→ **草稿槽变 null，没有任何确认**。
- 性质：`load()` 一直会清草稿，这是既有行为；U1 修的是「切仓库时已经 dirty」的主路径（S4 已过）。窗口 = 一次 `/gates` 往返（本机通常几毫秒到几十毫秒），且切仓那一刻面板本是干净的，属窄竞态。
- 建议（后续，非本轮）：给 `load()` 加请求序号；响应回来时若 `draft !== null` 或已有更新请求，就不要 `setGateDraft(null)`（或改为确认条）。

### R2（low）两次切仓库的响应乱序，旧仓库数据覆盖新仓库

- 复现（S8）：A→B（请求挂起）→C（请求挂起）→ 先回 C 再回 B；最终面板数据是 **B**，而父面板 `repo` 已是 C；草稿为空时 `repoConfirm` 不显示（它要求 dirty），页面只显示 B 的配置文件路径。
- 影响：保存/预览会用 `data.repo`（=B，与页面显示一致），不会把 A/B 配置写到 C；一旦用户开始编辑，`repoConfirm` 会出现「仓库已切换到 C：当前面板还是 B 的配置」，但用户仍可能把改动存到 B。
- 性质：既有 `load()` 无请求序号；U1 的 `targetRepo` 防的是「旧配置写新仓库」，这里是反方向。需要快速连切两次（或首挂载 `/state` 与 repo 变化重叠）才触发。
- 建议（后续）：同 R1，用请求序号丢弃过期响应；数据 `repo` 与父 `repo` 不一致时即使干净也提示。

### R3（info）切仓库时 `loadModels()` 仍会请求新仓库

- `useEffect(() => { loadModels() }, [repo])`（`:2470`）不看 dirty：草稿保留时仍会 `GET /gates/models?repo=B`（S4 观测到）。只读、不丢草稿；但模型下拉可能来自 B 而面板显示 A。属既有行为，低。

### R4（info）切仓库后旧的预览/状态文案不清

- `load()` 只 `setData/setGateDraft`，不清 `preview`/`status`；切仓库后可能短暂看到 A 的预览命中或「已保存到 A」的旧回执。既有行为，低。

### R5（info）单测桩的 `useEffect` 空实现让 U1-E 的 effect 断言空转

- `test/fixtures/panel-harness.mjs` 的 `useEffect() {}` + `loadStatefulPanel` 也不执行 effect；U1-E 的「取消后没有 `/gates?repo=other`」只证明「取消处理器没主动请求」，**不能证明 `useEffect([repo])` 没读**（真实实现若 effect 读 B，单测仍绿）。
- 本轮 S4/S10 用 deps-effect 探针补了这条；V1 报告也用外部 Chromium 补过。建议后续把 effect 语义做进测试桩（或把 U1-E 标成「仅状态断言」）。
- 不阻塞：真实行为已由独立探针确认不读 B。

### 未验项

- **v3 面板没有提交到仓库的浏览器级用例**：`scripts/verify-panel-chromium.mjs` 只覆盖到「门禁」导航，不打开门禁面板；V1 报告的 15 项 v3 Chromium 专项是外部探针，仓库里没有可复跑脚本。本轮用 effect 探针补了逻辑路径，但**真机 WebView / 真实 React 点击 v3 门禁面板仍未验**。
- 该 Chromium 脚本在普通 `node` 下会 `taskSpace is not defined`（ego-browser 沙箱的全局），必须按文件头用 `ego-browser nodejs` 跑；本轮 14 个 SKIP 都是截图通道不可用（脚本自述），不是断言跳过。
- 未验物理读屏、触摸、IME、真实 GitHub/Gitee 响应与真实 watcher 状态变化（沿用脚本自述）。

---

## 九、判据对照

| 要求 | 判据 | 结论 |
|---|---|---|
| `semantic:false` 三处一致 | 开关/底部/预览；打开后保存能写掉 false | 通过（S1 + U1-A） |
| `extends:false/'none'` | 可保存、原样写回、replace 不变；共享形式拒绝并说明 | 通过（S2 + U1-B/C + 落盘探针） |
| dirty 取消/确认 | 作用域/仓库都不静默丢；取消保留、确认才放弃；两个确认不互吞 | 通过（S3/S4/S9/S10 + U1-D/E） |
| 主面板 hook 数 | 23；门禁 12；35 槽严格对齐 | 通过（S6 + U1-F；HEAD 34 红） |
| 官方控件 | 委托官方、回退完整 | 通过（Q2-F4 26/26，实现未改） |
| 保存不丢配置 | 规则/semantic 隐藏字段/extends 往返 | 通过（U2 + U1-B + 落盘探针） |
| 结论 | 0 blocker / 0 high | **PASS**（2 low 竞态为既有行为，不阻塞） |

---

## 十、证据命令（摘要）

```text
# 全量 / 面板单测
npm test                                             → 890/890 pass, exit 0
node --test test/client.test.mjs                     → 148/148 pass, exit 0
PANEL_STRICT=1 node --test --test-name-pattern='门禁' test/client.test.mjs
                                                     → 26/26 pass, exit 0
node --test test/update-ui.test.mjs                  → 53/53 pass, exit 0
node scripts/ui-audit.mjs                            → 11/11（100 分）, exit 0
node scripts/render-panel-copy.mjs --check           → PASS（178 行）

# HEAD 红：U1 测试跑 HEAD client.js（临时副本，已清理）
tests 6 / pass 0 / fail 6, exit 1（U1-F 报「组件用了 34 个」）

# effect 探针（仓库外，真实 client.js）
S1 semantic:false 三处 + 保存写开
S2 extends=false / 'none' 可保存、原样写回；共享形式拒绝并点名
S3 dirty 切作用域：取消保留 / 确认才切
S4 dirty 切仓库：不读 B；保存 POST repo=A；取消保留；放弃才读 B
S5 干净切仓库：effect 直接读 B
S6 门禁 35 / 主面板 23
S7 在途 load 清掉新建草稿（低危竞态，已复现）
S8 响应乱序：旧仓库数据覆盖新仓库（低危竞态，已复现）
S9 两个确认互不吞
S10 草稿改回一致后 useEffect([dirty]) 补读
→ 12/12 PASS

# 落盘探针（真实 packages/dsh-gate）
用户层 extends:'none' + semantic:false + 规则改动 → 落盘/重读无损
项目层 extends:false + 规则改动 → 落盘/重读仍 replace
→ 2/2 PASS

# Chromium（ego-browser nodejs；安装版 React 18.3.1 + Chromium 156）
47 PASS / 0 FAIL / 14 SKIP（截图通道不可用）；client sha256 = 工作树
```

---

*本报告只对上述工作树快照负责；R1/R2 为既有 `load()` 语义的窄竞态，建议后续用请求序号 + 「响应时仍有草稿不清空」加固，不影响本轮 U1 验收。*
