# gate v2 面板第二轮复审（Q2R）

> 审查人：reviewer（Q2R）。日期：2026-11-08。角色：严格审查专员（只读源码）。
> 被审对象：U2（t9）定稿后的面板实现——`client.js` 的 `GateSettings` / `gateConfigOf` / `SemanticControl` 段 + `test/client.test.mjs` 门禁用例。
> 需求来源：`docs/任务书-dsh-gate-v2.md` §3.5 / §1.4；Q1、Q2 报告（`docs/报告-gate-v2核心审查.md`、`docs/报告-gate-v2面板审查.md`）。
> 本文件是 Q2R 唯一写权限范围内的产物；源码 / 测试 / 脚本**零改动**。
>
> **结论：verdict = pass。** 所有 blocker / high / medium 已闭合；7 条 low 遗留（§五），不阻塞发布。

---

## 一、判定表（Q1/Q2 未闭合项 → 本轮状态）

| 原编号 | 严重度 | 问题 | 本轮状态 | 证据 |
|---|---|---|---|---|
| Q1-F2 / Q2-F1 | **high** | 面板保存整块丢本层 `semantic`；只写 `enabled/model/prompt` 丢 `baseURL/mode/timeoutMs/maxInputChars` | ✅ 已闭合 | 探针 A1–A7；仓库用例「semantic 原样写回」「只改开关未暴露字段不丢」 |
| Q1-F3 / Q2-F2 | **high** | 面板保存丢 `extends`，共享规则静默消失 | ✅ 已闭合 | 探针 B1–B3；仓库用例「本层有 extends 时拒绝保存」+ 真实磁盘回读 |
| Q2-F3 | medium | 项目层 `semantic:false` 时「已关闭 + 当前开启」同屏矛盾 | ✅ 已闭合 | 探针 C1/C2；仓库用例「项目层 semantic:false 时底部文案与预览都用当前关闭」 |
| Q2-F4 | medium | 门禁作用域没接官方 `SegmentedControl`（手写 radiogroup、无方向键/Home/End） | ✅ 已闭合 | 探针 D1–D4；仓库用例「接官方 SegmentedControl，缺导出回退键盘」；安装版 bundle 确认导出 `SegmentedControl` |
| Q2-F5 | medium | 本地层停用时「上层已停用…把它恢复」不成立、无本地来源标签 | ✅ 已闭合 | 探针 E1–E3；仓库用例「停用来自本地层时如实说明本地优先」 |
| Q2-F6 | low | 测试把「语义没改就不写」当正确行为，缺语义/extends 用例 | ✅ 已闭合 | 旧断言已删除；新增 7 条行为用例（语义写回、未暴露字段、项目 false、extends、本地层、项目文案、官方控件） |
| Q2-F7 | low | `PANEL_STRICT=1` 全量 92/142 红（desk 树把子组件 hook 一起计数） | ⏳ 仍开（low，pre-existing） | 见 §五 L1 |
| Q2-F8 | low | 面板文案快照不覆盖门禁 | ⏳ 仍开（low） | 见 §五 L2 |
| Q2-F9 | low | 切换作用域静默丢弃未保存草稿 | ⏳ 仍开（low） | 见 §五 L3 |
| Q2-F10 | low | 折叠行两套实现 + `chevron-up` 缺失 | ⏳ 仍开（low，pre-existing） | 见 §五 L4 |

新增低优先观察 3 条（G1 / H1 / H2，见 §五），均为手写高级配置或文案边界，不阻塞。

---

## 二、被审快照与环境

| 项 | 值 |
|---|---|
| 工作树 | `D:/主工作区/projects/.tmp-issue9-push-20261106-1244` |
| 分支 / HEAD | `feat/gate-v2` @ `0d0d585`（基线 tag `v0.10.6` = `ff6b43b`） |
| 运行时 | Node v24.20.0，Windows |
| **被审快照（U2 定稿）** | `client.js` sha256 `a4559cfd…434c21`、`test/client.test.mjs` sha256 `06f524b1…05db`（2026-11-08 17:59；审查期间两者哈希未变） |
| **并发改动（非 U2）** | 审查期间 I1/R2 在同一工作树改 `scripts/sync-profile.mjs`、`scripts/verify-panel-chromium.mjs`，新增 `test/chromium-install-paths.test.mjs`（18:05）→ 根测试数 862→869。Q2R 只对 U2 快照下结论，并发改动不在本轮范围。 |
| 只读声明 | 除本报告外未改任何文件；`docs/面板文案.md`、`test/update-ui.test.mjs` 无改动（`git status` 可证） |
| 独立性 | 另写 `/tmp/q2r-probe.mjs`（**25 项**独立探针，真实 `client.js` 沙箱 + 真实 gate 包），不依赖 U2 的用例；同时复跑仓库全部相关命令 |

---

## 三、逐项独立验证

### 3.1 `semantic` 整对象保留（Q1-F2 / Q2-F1）

| 场景（探针） | 结果 |
|---|---|
| A1 用户层完整 semantic 对象（enabled/baseURL/model/mode/timeoutMs/maxInputChars/prompt）+ 只切规则保存 | POST `semantic` 与原始对象 **deepEqual**（含所有未暴露字段） |
| A2 用户层只改 `enabled` | POST `semantic` = `{...原对象, enabled:true}`，`baseURL/mode/timeoutMs/maxInputChars` 全保留 |
| A3 用户层 `semantic:false` 字面量 + 只切规则 | POST `semantic === false`（不被对象化） |
| A4 项目层 `semantic:false` + 只切规则 | POST `semantic === false`（项目层仍关闭） |
| A5 项目层 semantic 对象 + 只切规则 | POST 原样写回（deepEqual） |
| A6 项目层取消「关闭」 | POST **不写** `semantic` 键（回到继承，符合「取消关闭」语义） |
| A7 项目层勾选「关闭」 | POST `semantic === false` |
| C3 面板 payload 真实落盘 → `loadGateConfig` → `createGate(merge)` | 项目层 false 时**模型请求 0 次**；删掉项目层覆盖后**正对照 1 次** |

仓库用例同时覆盖：真实 `writeGateConfig` 写盘 → 重读 `mode/baseURL/timeoutMs/maxInputChars` 全在；`gate.check` 正对照 1 次（`test/client.test.mjs:3753`、`:3811`、`:3854`）。

### 3.2 `extends` 共享规则保留（Q1-F3 / Q2-F2）

U2 采用「本层有 extends 时明确拒绝保存」而不是整层重写：

- B1 用户层 `extends:'./shared.json'`：保存按钮 `disabled=true`；直接调用保存守卫也**不发 POST**；`role=alert` 出现「这一层用了 extends…请直接改配置文件：<路径>」；路径来自 `scopePath`。
- B2 项目层 extends：同上（保存禁用、不 POST）。
- B3 正对照（无 extends）：保存按钮可用且真的 POST。
- 真实磁盘（仓库用例 `:3907`）：保存被拒后，`shared.json` 的 `secret/abs-path` 与项目层 `proj-only` 都在，磁盘 `extends` 仍是 `./shared.json`，没有被冲掉。

> 设计取舍：拒绝保存而非静默丢 extends。面板同时显示顶部 alert + 保存栏「本层有 extends：保存已禁用」，用户有明确下一步（手改文件）。符合「共享规则不消失」的验收目标。

### 3.3 项目层 `semantic:false`：文案、预览、模型边界（Q2-F3）

- C1：项目层 `semantic:false`（合并值仍 `enabled:true`）时，「在本项目关闭语义复审」`aria-checked=true`；底部只出现「当前关闭：规则照跑，语义复审不发请求。」，**没有**「当前开启」。
- C2：`merge` 触发点「预览」→ POST `/gates/preview` 的 `semantic === false`；预览区显示「这类触发支持语义复审（当前关闭）」，不再说「会追加」；正对照（用户层语义开着）仍显示「会追加」。
- C3：真实 gate 包边界——面板保存后的项目层配置 `createGate(merge)` **0 次模型请求**；正对照 1 次。

### 3.4 官方 `SegmentedControl` + 回退键盘（Q2-F4）

- D1：注入 `primitives.SegmentedControl` 时，门禁作用域**原样委托**官方组件，转发 `id/options/value/label/disabled/onChange`（id=`gate-scope`）。
- D2：缺导出回退实现——`role=radiogroup`；每项 `role=radio` + `aria-checked`，**无** `aria-selected`；roving tabIndex（`[0,-1,-1]`）；ArrowLeft/Right 跳过 disabled、回绕；Home/End；焦点跟随；整体 `disabled` 时键盘与点击都不生效；点击 disabled 项不回调。
- D3：真实 `client.js` 渲染的作用域选择器带 `id=gate-scope`，三项文案与顺序正确。
- D4：有官方导出时，面板里的作用域节点类型就是官方组件（不是本地 radiogroup）。
- 官方 API 事实：安装版 bundle 导出 `SegmentedControl`（`grep -a app.asar` 命中 `SegmentedControl:eR`）；`docs/official-gui-ia.md:522` 的 props 为 `{options,value,onChange,label,disabled?,className?}`，与委托一致。

### 3.5 本地层来源与文案（Q2-F5）

- E1：本地层停用 `secret` 时，`scope=user` 的开关 `disabled=true`；文案含「本地层」「手改」；**不含**「把它恢复」「打开会写一条完整规则到本层」；卡片有「本地」来源标签。
- E2：项目层停用 + 当前在「我的」：开关禁用；文案指向「更靠后」「请到「项目」层处理」。
- E3：本层（我的）停用：开关可点；文案「本层已停用…打开会把完整规则…写回本层」。
- 回归：`gateDisabledLayer` 取最靠后定义层；`gateLayerNames` 纳入 `local`。

### 3.6 默认只读与 hook 数

- F1：默认层无保存栏；规则/语义开关全 `disabled`；模型下拉与提示词禁用；显示「只读」。
- F2：`GateSettings` **11** 个 `useState`；`ZhuliPanel` **22**（+`useToast` 1 = 23 槽）；`gateQueue` **34**；`PANEL_STRICT=1` 门禁子集 **20/20** 精确对齐（多/少一个槽都会抛错）。

---

## 四、原始计数（U2 快照）

```text
$ node --test test/client.test.mjs
ℹ tests 142 / ℹ pass 142 / ℹ fail 0 / exit 0
$ node --test test/update-ui.test.mjs
ℹ tests 53 / ℹ pass 53 / ℹ fail 0 / exit 0
$ PANEL_STRICT=1 node --test --test-name-pattern="门禁" test/client.test.mjs
ℹ tests 20 / ℹ pass 20 / ℹ fail 0 / exit 0
$ PANEL_STRICT=1 node --test test/client.test.mjs
ℹ tests 142 / ℹ pass 50 / ℹ fail 92 / exit 1     # pre-existing；见 §五 L1
$ node scripts/ui-audit.mjs
UI 体检：11/11 通过（100 分）
$ node scripts/render-panel-copy.mjs --check
PASS 面板文案与当前实现一致（178 行；最长 77 字符；超过 80 字符的 0 条）
$ npm test（U2 快照，18:04）
ℹ tests 862 / ℹ pass 862 / ℹ fail 0 / exit 0
$ node /tmp/q2r-probe.mjs
Q2R 探针：25 项，PASS 25，FAIL 0
```

> 当前工作树（18:05 后）根测试是 **869** 项：I1/R2 新增了 `test/chromium-install-paths.test.mjs` 并改了 `scripts/sync-profile.mjs` / `scripts/verify-panel-chromium.mjs`；
> 因此 `preflight --fast` 的 README 门禁变红（README 写 824，实际 869），profile 一条仍红——两条都属 I1/R2，不在 Q2R 范围。

---

## 五、遗留 low（不阻塞发布，需登记）

| 编号 | 严重度 | 问题 | 说明 / 建议 |
|---|---|---|---|
| Q2R-L1 | low | `PANEL_STRICT=1` 全量 142 条中 92 条红 | desk 树会把子组件（orbit 5 个 `useState` 等）一起计数，而 `deskQueue` 只传 23 个。严格门禁只对「门禁子集」有效（20/20）。测试基建问题，pre-existing；建议文档写清适用范围，或按组件级 fixture 传槽位。 |
| Q2R-L2 | low | 面板文案快照不覆盖门禁 | `docs/面板文案.md` 只有导航名「门禁」；`render-panel-copy --check` 对门禁是空转。U2 已说明快照由脚本生成、改它超范围；当前由组件行为用例守文案。 |
| Q2R-L3 | low | 切换作用域/仓库静默丢弃未保存草稿 | 有 dirty 草稿时点「项目」直接回到「与已保存的一致」，无确认。可接受但建议 dirty 时确认或 per-scope 草稿。 |
| Q2R-L4 | low | 折叠行两套实现 + `chevron-up` 缺失 | 官方 `primitives.DisclosureRow` 包装（`client.js:913`）与本地 `DisclosureRow`（`:957`）并存；`ICON_PATHS` 缺 `chevron-up`，展开后 chevron 回退 question。pre-existing（`docs/ui-decomp/01-dsh-ui-tree.md:243/399` 已记）。 |
| Q2R-L5 | low | 用户层 `semantic:false` 字面量时开关与底部不一致 | 探针 G1：底部「当前关闭」，但「开启语义复审」开关 `checked=true`（用了继承 `enabled`）。面板自己不会写用户层字面量 `false`（只写对象），仅手写配置可达；不影响项目层（已修）。 |
| Q2R-L6 | low | `extends:false` 也被当成「有共享规则」拒绝保存 | 探针 H1：`extends:false` 是合法的「替换默认」标记，但 `hasOwnProperty('extends')` 命中 → 保存禁用 + alert 说「共享规则」。建议只对字符串/对象/true 的 extends 拒绝，`false/'none'` 放行。 |
| Q2R-L7 | low | extends 基文件里停用的规则，文案承诺「把它恢复」但保存被禁用 | 探针 H2：基文件规则停用 → `gateDisabledLayer` 返回 `''` → 落到「上层已停用…把它恢复」；同屏又有 extends 保存禁用 alert。建议文案改成「extends 基文件里的停用需改配置文件」。 |

---

## 六、未验项（不许写成通过）

1. **真实 DSH WebView / 宿主重载**：没有重启/重载 DSH；本轮只验代码与沙箱。
2. **真实宿主 `primitives.SegmentedControl` 的渲染外观与键盘**：无头沙箱只验「委托 props」与「本地回退语义」；安装版 bundle 已确认导出该原语、官方文档 props 与委托一致，但**未在真实 Chromium 里点过**。
3. **Chromium 套件**：本轮没有在 U2 快照上重跑。原因：仓库脚本正被 I1/R2 并发重写（`scripts/verify-panel-chromium.mjs`），且该套件不覆盖「设置→门禁」分区（V1 的 47/47、55/55 是 U1 快照 + 临时副本）。
4. **preflight 2 红**：README 单测数（824 vs 当前 869）与 profile 一致性（断链 18）——I1/R2 范围，不是 Q2R 验收项。
5. **真实 GitHub / Gitee 写、真实模型调用**：本轮不做。

---

## 七、复跑命令

```sh
cd D:/主工作区/projects/.tmp-issue9-push-20261106-1244

# U2 快照（client.js a4559cfd… / test/client.test.mjs 06f524b1…）
node --test test/client.test.mjs                 # 142/142
node --test test/update-ui.test.mjs              # 53/53
PANEL_STRICT=1 node --test --test-name-pattern="门禁" test/client.test.mjs   # 20/20
node scripts/ui-audit.mjs                        # 11/11（100 分）
node scripts/render-panel-copy.mjs --check       # 178 行 PASS
npm test                                         # U2 快照 862/862（当前工作树含 I1/R2 新测试 = 869）

# Q2R 独立探针（临时证据，不进仓库）
node /tmp/q2r-probe.mjs                          # 25 项全过；G1/H1/H2 打印 low 观察
```
