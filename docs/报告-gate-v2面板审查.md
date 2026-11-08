# gate v2 面板实现严格审查（Q2）

> 审查人：reviewer（Q2）。日期：2026-11-08。角色：严格审查专员（只读源码）。
> 被审对象：U1 的面板实现（`client.js` 的 `GateSettings` / `gateConfigOf` / 门禁渲染段 + `test/client.test.mjs` 门禁用例）与 V1 报告 §六 的面板证据。
> 需求来源：`docs/任务书-dsh-gate-v2.md`（R1 冻结版）§3.5 / §1.4。
> 本文件是 Q2 唯一写权限范围内的产物；源码 / 测试 / 脚本**零改动**（`git status` 与审查开始时一致，见 §二）。
>
> **版本说明（队长 2026-11-08 指示）**：本报告审的是**当前 U1 实现**（`feat/gate-v2` @ `0d0d585` + 未提交改动）。
> Q1 已判 needs_revision，`Q1-F2`（保存丢 `semantic`）与 `Q1-F3`（保存丢 `extends`）已派 U2（t9）修，
> `Q1-F1/F4` 由 R2（t10）修。**最终面板验收以 U2 之后的 Q2R（t12）为准**，本报告结论只对 **U1 快照（`client.js` sha256 `4309a700…`）** 有效，不给旧实现放行；行号也只对这份快照成立。

---

## 一、结论

**verdict = needs_revision（不通过）。**

面板的**结构项**实测通过：主面板 hook 队列（22 + 1 / 11 / 34）、默认只读、作用域合并、开关真实写 `enabled`、
成功/失败/预览三态、`DisclosureRow` 的 aria 关联与键盘、测试桩保真度、`ui-audit` 11/11 全部对得上。
但当前实现有 **2 条 high（静默丢用户配置）+ 3 条 medium**，按任务契约不得 pass：

| 编号 | 严重度 | 问题 | 归属 |
|---|---|---|---|
| Q2-F1 | **high** | 面板保存只写 `{name,rules}` + `semantic` 只在「本次改了」时写：本层 `semantic` 被整层替换**整块丢掉**；且写回时只带 `enabled/model/prompt`，**丢掉 `baseURL/mode/timeoutMs/maxInputChars`**（Q1-F2 的面板侧完整证据） | U1 → U2（t9） |
| Q2-F2 | **high** | 面板保存丢本层 `extends`：项目层 extends 的共享规则保存后静默消失（Q1-F3 的面板侧证据） | U1 → U2（t9） |
| Q2-F3 | medium | 项目层 `semantic:false`（显式退出）时，「在本项目关闭语义复审」是开的，底部却写「当前开启：命中只给提示」——同屏自相矛盾；`gateSemanticOf` 用继承值算 `enabled`，没让 `off` 覆盖它 | U1 |
| Q2-F4 | medium | 门禁作用域选择器**没接官方 `SegmentedControl`**：`client.js:940` 手写 `role="radiogroup"` + 裸 button，无方向键/Home/End，`aria-selected` 用在 radio 上；而项目自己的 UI 迁移文档明确「官方 SegmentedControl 支持方向键、Home/End、跳过 disabled，**不要再把后者写成 radiogroup**」 | U1 |
| Q2-F5 | medium | 停用来自**本地层**时，卡片写「上层已停用：打开会写一条完整规则到本层，把它恢复」——实测保存后仍停用、正文仍放行；面板没有本地层来源标签 | U1 |
| Q2-F6 | low | 门禁测试把「语义没改就不写」当正确行为（`test/client.test.mjs:3554` 断言 `!('semantic' in payload.config)`），没有 semantic 持久化/字段保留/extends 用例 | U1 |
| Q2-F7 | low | `PANEL_STRICT=1` 全量 135 条中 92 条红（desk 树把子组件 hook 一起计数：orbit 5 个只传 1/4）；「门禁 13 条全过」只是子集，严格门禁不能当全局发布门禁 | 测试基建（pre-existing） |
| Q2-F8 | low | `docs/面板文案.md` 快照不覆盖门禁文案（177 行里只有导航名「门禁」），U1 的停用文案没有快照守卫 | U1 |
| Q2-F9 | low | 切换作用域 / 仓库变化会**静默丢弃**未保存草稿（无确认），实测切到「项目」后回到「与已保存的一致」 | U1 |
| Q2-F10 | low | 折叠行两套键盘实现（官方 `primitives.DisclosureRow` 包装 vs 本地 `DisclosureRow`）；`ICON_PATHS` 缺 `chevron-up`，展开后 chevron 回退成 question 图标（`docs/ui-decomp/01-dsh-ui-tree.md:243` 已知） | pre-existing |

判断依据：任务契约「发现 blocker/high 必须列修复要求，不得 pass」。Q2-F1/F2 是**静默丢用户配置**（其中 F1 直接改变模型调用边界），
U2 修完必须带仓库内用例，再由 Q2R 复验。

---

## 二、审查环境与独立性

| 项 | 值 |
|---|---|
| 工作树 | `D:/主工作区/projects/.tmp-issue9-push-20261106-1244` |
| 分支 / HEAD | `feat/gate-v2` @ `0d0d585`（基线 tag `v0.10.6` = `ff6b43b`） |
| 运行时 | Node v24.20.0，Windows；Chromium 156.0.8078.74（V1 证据） |
| 只读声明 | 除本报告外未改任何文件；`git status --porcelain` 与审查开始时一致（新增仅本报告、Q1 报告、V1 报告、C1 的 `enabled-rule.test.mjs`） |
| **被审快照（U1）** | `client.js` sha256 `4309a700…41aa8b`、`test/client.test.mjs` sha256 `a71bfd01…7ef966`（与 V1 独立副本逐字节相同）。**本报告的行号、探针与证据都基于这份 U1 快照。** |
| **并发改动（U2 在途）** | 审查期间 U2（t9）已在同一 worktree 开始改 `client.js` / `test/client.test.mjs`（17:51 起 mtime 变化；当前 sha256 `8e032528…50c1` / `d697f02d…cc3e`，`client.js` diff 121 行、测试 +332 行）。Q2 **不对在途实现下结论**；U2 修完由 Q2R（t12）复验。 |
| 独立性 | 我没有只跑 U1 的用例：另写 `/tmp/q2-panel-probe.mjs`（8 项，真实 `client.js` 沙箱，状态落 `os.tmpdir()`）、`/tmp/q2-hook-count.mjs`（hook 槽位独立统计）、复用 Q1 的 `/tmp/q1-panel-semantic-probe.mjs`、`/tmp/q1-local-layer-probe.mjs`；同时复跑仓库全部相关命令 |

复跑的真实计数（原始输出）：

```text
$ node --test test/client.test.mjs
ℹ tests 135 / ℹ pass 135 / ℹ fail 0 / exit 0
$ PANEL_STRICT=1 node --test --test-name-pattern="门禁" test/client.test.mjs
ℹ tests 13 / ℹ pass 13 / ℹ fail 0 / exit 0        # 门禁子集（含 fixture 34 槽校验）
$ PANEL_STRICT=1 node --test test/client.test.mjs
ℹ tests 135 / ℹ pass 43 / ℹ fail 92 / exit 1       # 全量严格模式红（见 Q2-F7）
$ node --test test/update-ui.test.mjs
ℹ tests 53 / ℹ pass 53 / ℹ fail 0 / exit 0
$ node scripts/ui-audit.mjs
UI 体检：11/11 通过（100 分）
$ node scripts/render-panel-copy.mjs --check
PASS 面板文案与当前实现一致（178 行；最长 77 字符；超过 80 字符的 0 条（上限 3））
$ npm test（根全量）
ℹ tests 855 / ℹ pass 855 / ℹ fail 0 / exit 0
$ node /tmp/q2-panel-probe.mjs
Q2 探针：8 项，PASS 6，FAIL 2（A/B 失败 = 缺陷证据，见 Q2-F1/F3）
$ node /tmp/q2-hook-count.mjs
GateSettings useState = 11 / ZhuliPanel useState = 22 + useToast 1 = 23 槽 / gateQueue 34 / fixture 严格模式 34 槽对齐 ✓
```

---

## 三、面板核心项逐条核验（通过项）

### 3.1 主面板 hook 队列（任务书 §1.4 / §3.5）

| 契约 | 实测 |
|---|---|
| 主面板 `ZhuliPanel` **22 个 `useState`** | 独立统计 = **22**（`snap/tab/notice/form/token/goalDraft/goalTouched/editing/draft/search/glossary/update/checking/settingsSection/reasonFilter/badgeFilter/problemsOnly/stateFilter/ghDir/giteeToken/traceResult/updateResult`） |
| `GateSettings` 独立 **11 个** | 独立统计 = **11**（`data/loadError/scope/draft/advanced/sample/trigger/preview/models/busy/status`，`client.js:2299-2306`） |
| `deskQueue` **23 槽** | `deskQueue(...).length = 23`（第 23 槽是 `useToast` 内部的 `toastView`） |
| `gateQueue` = 23 + 11 = **34 槽** | `gateQueue(...).length = 34`；fixture 严格模式 `PANEL_STRICT=1` 渲染「设置 → 门禁」**34/34 精确对齐**（多传/少传都会抛「状态槽位对不上」） |
| 门禁状态不占主面板槽位 | `GateSettings` 只在 `settingsSection === 'gate'` 时挂载，主面板 hook 数不变 |

### 3.2 默认只读（三作用域）

- 默认层：规则开关与语义复审开关 `disabled=true`；模型 `select` 与提示词 `textarea` `disabled=true`；**没有保存栏**；显示「只读」Tag 与包内默认规则路径。
- 「我的」：开关可点、保存栏出现、显示 `~/.dsh/state/session-superagent/gates.json`；「项目」：显示 `<repo>/.superagent/gates.json`，并提示「项目层只能关闭语义复审」。

### 3.3 作用域合并

- 三个作用域 radio 齐全（默认（只读）/ 我的 / 项目），点击写入 `scope` 并重读 `/gates?repo=…`。
- 卡片来源标签只列 `default / user / project`；规则计数「规则 N / M」按**合并后的 `enabled`** 算（停用的算关）。
- 切 scope 会重置草稿与预览；保存后重新 GET `/gates`（repo 用例断言 GET 次数 = 1），卡片回到四层合并结果。

### 3.4 开关语义（U1 的核心改动）

- `gateRuleKey` 纳入 `enabled !== false` →「本层只有开关不同」不再是「没改」（仓库用例「只切开关也算改动」）。
- 关掉 → POST 完整规则 + `enabled:false`（`label/type/pattern/message/triggers` 齐）；重开 → 完整规则 + `enabled:true`（不是空壳 `{id,enabled}`）。
- 只写**改动过**的规则；本层已有的覆盖原样保留（仓库用例「本层已有的覆盖不会被别的保存动作删掉」）。
- 停用的规则在卡片上显示为关，并给「本层已停用 / 上层已停用」说明；旧文案「关掉只是本层不覆盖」已不存在。

### 3.5 成功 / 失败 / 预览态

| 交互 | 实测 |
|---|---|
| 保存成功 | `role=status`：「已保存到「我的」：…」，随后重读 |
| 保存失败 | `role=alert`：「保存失败：规则 id 重复：secret」，**不报成功** |
| 预览通过 | 「通过：没有阻断项」 |
| 预览命中 | 「命中 N 条」+ 每条 `[阻断/提示] 名称：提示` |
| 预览失败 | `role=alert`「预览失败：HTTP 500」 |
| 优化提示词 | 成功写回 textarea + 「提示词已更新」；失败 `role=alert`「提示词润色失败：…」 |
| 模型列表 | 成功填充下拉（当前值排第一）；失败显示「模型列表读取失败：…」 |

### 3.6 `DisclosureRow`（高级）

- `role="button"` + `tabIndex=0` + `aria-expanded` + `aria-controls="gate-rule-<id>-body"`；展开后 body 真的带 `id`。
- Enter / Space 都能开合（`preventDefault` 已测），长按 `event.repeat` 只认第一次；`busy/disabled` 在本层拦截。
- 默认收起：正则不展开（`ghp_…` 不出现在折叠态），展开后才显示。

### 3.7 测试桩保真度

- `test/fixtures/panel-harness.mjs` 的 `React.createElement` **剥掉 `key`**（真 React 行为），避免「桩里能跑、真机 undefined」。
- 位置化队列：`render()` 记 `__panelVerify`，`walk()` 收尾比对槽位数；`PANEL_STRICT=1` 时多传/少传都抛错。
- 有状态桩 `loadStatefulPanel`（`test/client.test.mjs:2095`）的 setter **真的更新状态**并支持重渲染，门禁开关的「点击 → 状态变化 → 保存」链路是真实行为断言，不是只断言回调被调用。
- **缺口**：`loadStatefulPanel` 不挂 `__panelVerify`，本身不校验槽位（靠 fixture 分支的门禁用例覆盖）；见 Q2-F7/F6。

### 3.8 官方 UI 采用

- `Btn → primitives.Button`、`Toggle → primitives.Switch`、`Tag → primitives.Tag`、`Pill → primitives.Pill`、`SegTabs → primitives.SegmentedTabs`、`CollapsibleList → primitives.DisclosureRow`（`client.js:369-382` 独立探测，缺导出时完整回退）。
- `ui-audit` 11/11（100 分）：官方结构采用 8/8、写死颜色 0、自造 token 0、可点裸 div 0、弹层键盘 3/3。
- **例外**：门禁作用域选择器没接官方 `SegmentedControl`（Q2-F4）。

---

## 四、发现（findings）

### Q2-F1 · high · 面板保存整块丢本层 `semantic`（并丢 `baseURL/mode/timeoutMs/maxInputChars`）

- 位置：`client.js:2256-2285`（`gateConfigOf`）；落盘 `packages/dsh-gate/lib/index.js:452-474`（整层替换）。
- **Q1-F2 的面板侧证据（已派 U2）**：
  - 用户层 `semantic {enabled:true, model, prompt}`，只切一条规则保存 → POST `{name, rules}`（无 `semantic`）→ 重读 `enabled=false`（用户开的语义复审被静默关掉）。
  - 项目层 `semantic:false`（显式退出），只切规则 → 写盘后 `semantic=undefined` → 重读 `enabled=true`，`createGate` 在 merge + 干净正文下**真的发 1 次模型请求**（项目的「不要请求模型」被抹掉）。
- **新证据（Q2 追加，`/tmp/q2-panel-probe.mjs` A）**：即使用户层 semantic 是完整对象
  `{enabled:false, baseURL:'http://my-gateway.example/v1', model:'my-model', mode:'block', timeoutMs:30000, maxInputChars:20000, prompt:'我的提示词'}`，
  在面板里把「开启语义复审」打开并保存，POST 的 `config.semantic` 只有
  `{"enabled":true,"model":"my-model","prompt":"我的提示词"}` —— **`baseURL/mode/timeoutMs/maxInputChars` 全丢**。
  重读后 baseURL 回落到默认层的 `http://127.0.0.1:3425/v1`、mode 回 None→warn、timeout 回 15000。用户自定义网关会静默失效（语义复审不可用时 fail-open 放行）。
- 测试侧：`test/client.test.mjs:3554` 断言 `!('semantic' in payload.config)`（「语义没改就不写语义」）—— 把缺陷当正确行为，正好掩盖了它。
- 修复要求（U2）：
  1. `gateConfigOf` 必须把本层原有 `semantic` **原样写回**（对象或 `false`）；只改 `enabled/model/prompt` 时也要保留 `baseURL/mode/timeoutMs/maxInputChars` 等未暴露字段。
  2. 补仓库内行为用例：① 本层 semantic 完整对象 + 只切规则 → 保存后 `semantic` 仍在且字段不变；② 项目层 `semantic:false` + 只切规则 → 保存后仍 `false`（`createGate` 0 次模型请求）；③ 只改 `enabled` → `baseURL/mode/timeout` 不丢。
  3. 修完由 Q2R 复验（U2 之后的实现）。

### Q2-F2 · high · 面板保存丢本层 `extends`（共享规则静默消失）

- 位置：`client.js:2272`（`gateConfigOf` 只写 `{name, rules}`）+ `writeGateConfig`（`normalizeConfig` 只保留 `version/name/rules/semantic`）。
- 证据（Q1 已测，Q2 复核）：项目层 `{extends:'./shared.json', rules:[proj-only]}`，保存前规则含 `shared-secret/shared-path`；面板保存（只切一条规则）后文件字段只剩 `version,name,rules`（`extends=undefined`），重读后 `shared-secret` / `shared-path` **消失**。
- 修复要求（U2）：保存时保留 `extends`（从 `data.scopes[scope].config` 原样带回），或有 `extends` 时拒绝保存并给明确文案；补项目层 extends 保存用例。

### Q2-F3 · medium · 项目层 `semantic:false` 时同屏文案自相矛盾

- 位置：`client.js:2615-2621`（项目层渲染「在本项目关闭语义复审」`checked: current.semantic.off`；底部 `semanticState`（`client.js:2463`）用 `current.semantic.enabled`）。
- 证据（探针 B）：项目层 `semantic:false`（显式退出）、合并语义 `enabled:true` 时：
  - 「在本项目关闭语义复审」开关 `aria-checked=true`（**已关闭**）；
  - 底部却显示「**当前开启**：命中只给提示，不阻断回复。」（`semanticState` 用了继承的 `enabled`）。
- 根因：`gateSemanticOf`（`client.js:2223`）里 `enabled` 只认本层对象的 `enabled` 布尔，本层写 `semantic:false`（字面量）时 `fields={}` → 回落继承值 `true`，`off` 才是 true；两处渲染各取一个字段。
- 修复要求：`off === true` 时 `semanticState` 必须走「当前关闭」；或让 `gateSemanticOf` 在 `off` 时把 `enabled` 归 false，并补项目层关闭语义复审的文案断言。
- 同源小问题：试跑预览的 `semantic` 开关也用继承的 `enabled`（`client.js:2425`），项目层已关闭时仍会带 `semantic:true` 请求（服务端会 restrict 成 skipped，但请求语义不诚实）。

### Q2-F4 · medium · 门禁作用域没接官方 `SegmentedControl`

- 位置：`client.js:939-955`（本地 `SegmentedControl`：`role="radiogroup"` + 每项裸 `h('button', {role:'radio', 'aria-selected':…})`）；使用点 `client.js:2432`（门禁作用域选择器）。
- 官方事实（项目自己的文档）：`docs/ui-decomp/01-dsh-ui-tree.md:30` 明确官方导出 `SegmentedTabs` **和** `SegmentedControl`；`:49` 写「`SegmentedControl` 用 `id/options/value/onChange/label/disabled`，**支持方向键、Home/End、跳过 disabled。不要再把后者写成 `radiogroup`**」；`:398` 要求「改内部为宿主 `SegmentedControl`」；`docs/official-gui-ia.md:522` 给出官方 props 与视觉。
- 实测差距：本地实现**没有方向键/Home/End**（三项都是原生 button，全部在 Tab 序列里，没有 roving tab stop）；`aria-selected` 对 `role="radio"` 是无效 ARIA 属性（应为 `aria-checked`，已有）；`client.js:369-382` 探测了 Button/Switch/SegmentedTabs/Tag/Pill/DisclosureRow，**唯独没有探测 `primitives.SegmentedControl`**，注释却写「官方 SegmentedControl」。
- 修复要求：按 `SegTabs` 的同一模式加 `hostSegmentedControl = primitives.SegmentedControl || null` 并委托（缺导出时保留本地回退）；补方向键/Home/End 与 disabled 的行为断言。归属 U1。

### Q2-F5 · medium · 本地层停用时「把它恢复」不成立

- 位置：`client.js:2469-2470`（「上层已停用：打开会写一条完整规则到本层，把它恢复。」）。
- 证据（探针 G + Q1 本地层探针）：`scope=user`、本地层 `gates.local.json` 停用 `secret` 时，卡片显示停用并写「上层已停用…把它恢复」；但本地层是**更后**的层，保存 user 层 `enabled:true` 完整规则后重读 `secret.enabled=false`、同一正文仍放行（`lintText.ok=true`）。面板也没有本地层来源标签（`gateLayerNames` 只列 default/user/project）。
- 修复要求：文案改成「更后层（本地层）已停用，面板不承诺能复启」或补本地作用域；至少在 `docs/面板文案.md` 写清本地层是高级手工配置。归属 U1。

### Q2-F6 · low · 门禁测试把缺陷当正确行为，且缺关键用例

- `test/client.test.mjs:3554` 断言 `!('semantic' in payload.config)`（「语义没改就不写语义」）——对**本层已有 semantic** 的层，这条断言等于要求保存动作丢掉 semantic（Q2-F1）。
- `gateApiWithLayer`（`test/client.test.mjs:3452`）只构造 `config/scopes.rules`，不含 `semantic` / `extends`，所以语义持久化、字段保留、extends 丢失都没有用例。
- 缺的用例：默认层只读（有）、语义开关写盘（有「优化/预览」）、**语义持久化（无）**、**baseURL/mode 保留（无）**、**extends（无）**、**本地层覆盖（无）**。
- 修复要求：随 Q2-F1/F2/F5 一起补仓库内行为用例；Q2R 以这些用例为验收。

### Q2-F7 · low · `PANEL_STRICT=1` 全量不可用（严格门禁只是子集）

- `PANEL_STRICT=1 node --test test/client.test.mjs` → **135 条中 92 条 fail**：desk 树会把子组件（orbit 5 个 `useState`、WatcherForm 等）一起计数，而 `deskQueue` 只传 23 个，于是「传了 23 个，组件用了 24/25/…/34 个」。
- U1 宣称的「PANEL_STRICT=1 门禁 **13 条**全过」是**门禁子集**（`--test-name-pattern="门禁"` → 13/13 exit 0，其中 fixture 分支真的校验 34 槽），不是全量绿。
- 要求：在文档/发布说明里写清严格门禁的适用范围；若要让全量严格绿，需要按「组件级 fixture」传槽位（orbit 等），不能拿 23 槽的 deskQueue 去渲染整棵树。属测试基建（pre-existing），不阻塞 U1。

### Q2-F8 · low · 面板文案快照不覆盖门禁

- `docs/面板文案.md` 177 行（脚本口径 178）只有第 133 行导航名「门禁」；U1 新写的「关掉一条会真正停用」「本层已停用 / 上层已停用」「保存失败：」都没有进快照，`render-panel-copy --check` 绿是空转。
- 要求：把门禁面板文案纳入快照，或明确写「门禁文案由组件用例守」并补断言。

### Q2-F9 · low · 切换作用域 / 仓库静默丢弃未保存草稿

- 证据（探针 H）：在「我的」有未保存草稿（`未保存`）时点「项目」→ 草稿直接清空回到「与已保存的一致」，没有任何确认；`useEffect(() => { load() }, [repo])` 同理（仓库变化会重读并清草稿）。
- 要求：dirty 时切 scope 给确认（或保留 per-scope 草稿）；至少在文档写清「切换即放弃」。

### Q2-F10 · low · 折叠行两套实现 + `chevron-up` 缺失

- 官方 `primitives.DisclosureRow` 包装在 `client.js:913`（`CollapsibleList` 用），门禁卡片与 WatcherForm 用本地 `DisclosureRow`（`client.js:957`，因官方不收 `bodyId`）——`docs/ui-decomp/01-dsh-ui-tree.md:399` 要求「包一层映射官方 props；不要保留两套折叠键盘逻辑」。
- `ICON_PATHS` 没有 `chevron-up`（`docs/ui-decomp/01-dsh-ui-tree.md:243` 已知），展开后 chevron 回退成 question 图标。
- 要求：统一折叠实现或登记 derived；补 `chevron-up` 图标。属 pre-existing（不阻塞 U1）。

---

## 五、V1 证据复核

| V1 宣称（报告 §六） | 我的复核 | 结论 |
|---|---|---|
| 主面板 22 / `GateSettings` 11 个 `useState` | 独立统计 22（+useToast 1）/ 11；`gateQueue` 34 | ✅ |
| 默认层只读（3 个开关 disabled、无保存栏） | 探针 C 复现（规则/语义开关、模型、提示词全 disabled） | ✅ |
| 关掉 → POST `enabled:false` 完整规则 → 重读「规则 2/3」 | 仓库用例 + Q1 探针复现 | ✅ |
| 重新打开 → POST `enabled:true` 完整规则 | 仓库用例「重新打开写完整规则 + enabled:true」 | ✅ |
| 项目层只写本层改动 | 仓库用例「本层已有的覆盖不会被别的保存动作删掉」 | ✅ |
| 默认层只读（fixture 3 开关） | 探针 C | ✅ |
| 往返无页面错误 / 无外部请求 | 只能核 V1 的 `/tmp` 日志（`errors:[] network:[]`）；仓库不可重放（Q1-F10） | ⚠️ 临时证据 |
| 47/47 自带 Chromium 套件 | 仓库脚本仍硬编码旧安装（Q1-F5）；V1 在 `/tmp` 改路径 | ⚠️ 临时证据 |

**V1 漏掉的面板问题**：Q2-F1（semantic 整块/字段丢失）、Q2-F2（extends）、Q2-F3（项目层文案）、Q2-F4（官方 SegmentedControl）、Q2-F5（本地层恢复）。V1 的 8 项只覆盖「规则开关 + 保存形状」，没有覆盖「整层替换会不会带走本层其它配置」——这正是 Q1-F2/F3 的同一根因。

---

## 六、未验项（不许写成通过）

1. **真实 DSH WebView / 宿主重载**：没有重启 / 重载 DSH，profile 安装副本仍可能是旧内容（Q1-F1/F5 修完必须复验）。
2. **Chromium 套件**：没有在仓库原样复跑（`scripts/verify-panel-chromium.mjs:16-17` 硬编码旧安装，Q1-F5）；V1 的 47/47、55/55 是临时副本。
3. **触摸 / 读屏 / IME / 窄屏**：只做了 DOM/ARIA 断言，没有真机交互。
4. **本地层交互**（Q2-F5）：面板没有本地作用域，只验证了「本地层覆盖会导致恢复无效」。
5. **U2 修复后的复验**：本轮只审 U1 快照（`4309a700…`）；Q2-F1/F2 由 U2 修，审查期间工作树已被 U2 改动（`8e032528…`，在途），**未对在途实现下任何结论**；最终面板验收是 Q2R（t12）。

---

## 七、复跑命令（可直接粘）

> 下列命令是在 **U1 快照**（`client.js` sha256 `4309a700…`，见 §二）上实跑的；当前工作树已被 U2 改动（`8e032528…` 在途），
> 直接复跑会得到 U2 的计数，不能与 §二 对照。Q2R 请在 U2 定稿后按同一组命令重新取数。

```sh
cd D:/主工作区/projects/.tmp-issue9-push-20261106-1244

# 面板 / 全量 / UI 门禁
node --test test/client.test.mjs                 # 135/135, exit 0
PANEL_STRICT=1 node --test --test-name-pattern="门禁" test/client.test.mjs   # 13/13, exit 0
PANEL_STRICT=1 node --test test/client.test.mjs  # 43/135（全量严格红，见 Q2-F7）
node --test test/update-ui.test.mjs              # 53/53
node scripts/ui-audit.mjs                        # 11/11（100 分）
node scripts/render-panel-copy.mjs --check       # 178 行 PASS
npm test                                         # 855/855, exit 0

# Q2 独立探针（临时证据，不进仓库）
node /tmp/q2-panel-probe.mjs                     # 8 项：6 通过；A/B 失败 = Q2-F1/F3 证据
node /tmp/q2-hook-count.mjs                      # 22+1 / 11 / 34 / 严格模式 34 槽对齐
node /tmp/q1-panel-semantic-probe.mjs            # POST config 无 semantic（Q2-F1）
node /tmp/q1-local-layer-probe.mjs               # 本地层停用 → 恢复无效（Q2-F5）
```
