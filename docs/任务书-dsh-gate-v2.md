# 任务书 v2：dsh-gate 收尾与真实门禁链

> 状态：**R1 已冻结**（2026-11-08）。本文件是唯一需求来源，实现 / 验收 / 审查 / 发布都以这里的字面为准；
> 改本文件必须回到 R1 复审，不允许子任务顺手改。
> 冻结人：architect（R1）。
> 执行模型：所有子代理 `group/deepseek-v4.1-flash-1017`，`reasoning_effort=max`。

一句话：门禁 v2 只剩三件事 —— **规则级 `enabled:false` 真停用**（核心 + 面板写盘）、
**发送前 CLI 契约**（实现已在，本轮补「停用不命中」与文档口径）、**面板真实启停**（主面板零新增 hook）。
另外三条基线红项（profile 缺包、Chromium 硬编码旧安装、本文件版本号）必须在发布前清掉。

---

## 一、基线（2026-11-08 实测，命令都能复跑）

### 1.1 仓库与提交

| 项 | 值 | 证据 |
|---|---|---|
| 工作仓库 | `D:/主工作区/projects/.tmp-issue9-push-20261106-1244` | 本文件所在仓库 |
| `origin` | `D:/主工作区/projects/dsh-session-superagent`（**本机路径，不是 GitHub 远端**） | `git remote -v` |
| 当前分支 | `feat/gate-v2` = `0d0d585`（`docs: 门禁 v2 任务书与团队依赖`） | `git log --oneline -1` |
| 交付基线 | tag `v0.10.6` = `ff6b43b`（`feat/gate-monorepo` 头，PR #21 合入） | `git rev-list -n1 v0.10.6` |
| gate 包 tag | `gate-v0.1.0` = `8330f05` | `git rev-list -n1 gate-v0.1.0` |

**修正（v1 任务书写错了，以本节为准）**：本地 `main` 是 `5a93684`（0.10.2 时代），
比 `ff6b43b` **落后 16 个提交**；`origin/main` 是 `7086251`。
`ff6b43b` 不是 main 头，它是 0.10.6 的发布提交。所有子任务从 `ff6b43b` 起分支；
`main` 要不要快进到 `ff6b43b` 由 I1 在集成时决定并把结论写进报告。

### 1.2 版本与发布面（六处，改版本必须一起改）

| 位置 | 当前值 |
|---|---|
| `package.json` 第 3 行 | `0.10.6` |
| `lib/index.js` 的 `SERVER_VERSION` | `0.10.6` |
| `client.js` 的 `CLIENT_VERSION` | `0.10.6` |
| `README.md` 徽章 | `0.10.6` |
| `packages/dsh-gate/package.json` 与 `PACKAGE_VERSION` | `0.1.0` |
| `CHANGELOG.md` 顶部条目 | `[0.10.6] - 2026-11-07` |

npm 实测（`npm view <包名> version`）：`dsh-session-superagent@0.10.6`、`@mycf711/dsh-gate@0.1.0`。

### 1.3 门禁与测试基线（全量实跑，不是字符串宣称）

```text
$ npm test
ℹ tests 869 / ℹ pass 869 / ℹ fail 0 / exit 0

$ cd packages/dsh-gate && npm test
ℹ tests 133 / ℹ pass 133 / ℹ fail 0 / exit 0

$ node scripts/preflight.mjs
# R1 改写本文件之前：42 项 = 39 PASS / 2 FAIL / 1 SKIP（exit 1）
# R1 改写之后：42 项 = 40 PASS / 1 FAIL / 1 SKIP（exit 1）
# R2 改写之后（当前）：--fast --no-maintenance 实跑 41 项 = 38 PASS / 1 FAIL / 2 SKIP（exit 1）
#   唯一红是 profile 断链（I1 跑 sync-profile --repair 后清）；全量再 +1 项「门禁自检」= 42 项

$ node scripts/ui-audit.mjs
UI 体检：11/11 通过（100 分）
```

R1 改写前有两条红；改写后只剩 profile 一条（谁负责见 §四）：

1. `profile 一致性 --check` → `缺失 1 / 断链 17 / 陈旧 0`。
   profile 安装副本 `D:/DeepSeek Harness/home/profiles/desktop/node_modules/dsh-session-superagent`
   里**没有** `node_modules/@mycf711/dsh-gate`，另有 17 个文件 inode 不同（是旧副本）。
   而 `lib/index.js` 第 32 行是**静态** `import ... from '@mycf711/dsh-gate'` ——
   也就是说：**当前 profile 里的插件根本挂不起来**，不是理论风险。
2. `全库文档一致` → 版本号对不上（1 个）：本文件写了高于当前版本的版本号。**R1 已改写**，这条现已 PASS（见 §六）。

一条 SKIP：`冒烟 smoke:observe`（需要真机宿主，已列进攒批清单）。

### 1.4 UI / 架构事实

- 主面板 `ZhuliPanel`（`client.js` 第 2587 行起）**22 个 `useState`**；
  `test/fixtures/panel-harness.mjs` 的 `deskQueue` 是 **23 槽**、**按位置取值**（槽位下标即 hook 调用顺序）。
- 门禁子组件 `GateSettings`（`client.js` 第 2277 行起）**独立 11 个 `useState`**，不占主面板槽位；
  `test/client.test.mjs` 的 `gateQueue` = `deskQueue` 23 + 门禁 11 = **34 槽**。
- 路由 13 条，其中门禁四条：`/session-superagent/gates`、`/session-superagent/gates/preview`、
  `/session-superagent/gates/optimize`、`/session-superagent/gates/models`。
- 默认规则文件 `packages/dsh-gate/gates/default.json` 共 **10 条**规则，`semantic.enabled` 为 `false`。

---

## 二、已确认缺口（现状复核，带行号）

### 2.1 规则级 `enabled` 完全没实现（缺口 1 的真实形态）

| 位置 | 现状 |
|---|---|
| `packages/dsh-gate/lib/index.js` `normalizeRule`（第 99 行起） | 重建规则对象时**不带** `enabled` —— 任何层写 `enabled:false` 都被静默丢掉 |
| 同上 `normalizeConfig`（145）/ `validateConfig`（344）/ `writeGateConfig`（433） | 三个出口都过同一套 normalize → 保存时 `enabled` 被剥掉，写回读不一致 |
| 同上 `lintText`（328） | 遍历规则时不看 `enabled` → 就算配置里残留 `enabled:false` 也照跑 |
| `client.js` `gateConfigOf`（2247） | 用 `filter((rule) => rule.enabled && changed(rule))`：关掉**只等于「本层不覆盖」**，落盘没有 `enabled` |
| `client.js` `gateDraftOf`（2222）/ `gateRuleKey`（2182） | 开关默认全开；比较快照**明确排除** `enabled` |

`CHANGELOG.md` 0.10.6 条目已登记这条限制：「`POST /gates` 仍不能真正停用默认层规则」。
面板上写着同一件事的两处文案：`client.js` 第 2448 行（「关掉只是本层不覆盖，上层同名规则照旧生效」）
与第 2491 行（「关掉一条只表示本层不覆盖」）—— U1 改完必须让这两句不再成立。

### 2.2 CLI 已实现，但契约没冻结

`packages/dsh-gate/bin/gate.mjs` 已实现 `--trigger` / `--body-file` / `--current` / `--repo` /
`--config` / `--json` / `--semantic` / `--help` 与退出码 0 / 1 / 2，实测见 §五。
本轮不重写 CLI，只补「停用规则不命中」的用例与文档口径。

### 2.3 语义只 merge / release 已实现（两层兜底）

- `packages/dsh-gate/lib/semantic.js` 第 14 行：`SEMANTIC_TRIGGERS = ['merge','release']`。
- CLI 门控 `packages/dsh-gate/bin/gate.mjs` 第 147–148 行。
- provider 兜底 `semantic.js` 第 152 行（`enabled !== true || !SEMANTIC_TRIGGER_SET.has(trigger)`）。
- 实测：`--trigger issue.reply --semantic` 与 `pr.handle` 都返回 `semantic: {"skipped":true}`，不请求模型。

### 2.4 面板已有，但没写真启停

默认层只读、我的 / 项目可写、正则收进每张规则卡的「高级」、预览失败有「预览失败：」文案 —— 这些**已经在了**。
缺的只有一件事：开关没有落成 `enabled:false` / `enabled:true`。

### 2.5 三条基线红项（不修就发不出去）

1. profile 缺包 + 断链 17 → I1 跑 `node scripts/sync-profile.mjs --repair`（发布第 7 步）。
2. 本文件版本号 → R1 已改写（§六）。
3. `scripts/verify-panel-chromium.mjs` 第 16–19 行硬编码**旧安装**
   `D:/DeepSeek Harness/Desktop/resources/app.asar`（不是当前运行的 `D:/DeepSeek Harness/Desktop-0.2.2-rc.1`，
   两个目录的 exe 与 app.asar 都在）→ I1 改成指向当前安装或改成可配置，
   **改完必须复跑并贴新计数**；V1 跑出来的 47/47 是旧前端的，必须标注。

---

## 三、冻结契约

### 3.1 规则启停（本轮唯一新增语义）

- 规则增加可选 `enabled`（缺省 `true`）；`enabled:false` = 该层明确停用同 id 规则。
- 合并顺序：默认 → 用户全局 → 项目 → 本地；同 id **后层完整覆盖**前层（含 `enabled`）。
- 停用不可被更前层复活；后层写 `enabled:true` 即恢复。
  复启必须写**同 id 完整规则**：只写 `{ id, enabled:true }` 而缺 `type` 的规则一律判非法，
  面板保存要报错（`validateConfig` 给具体原因），不许静默变回停用。
- 写盘保留 `enabled:false`：`normalizeRule` 不丢、`validateConfig` 接受布尔且非布尔报错、
  `writeGateConfig` 写回读一致（JSON 往返仍是 `false`）。
- `lintText` 跳过 `enabled === false` 的规则（连 warn 都不出）；`ok` 的判定口径不变。
- 默认配置 `packages/dsh-gate/gates/default.json` **不新增**停用项（现在 10 条），
  旧配置行为完全不变；`semantic.enabled` 是另一码事，别混。
- 纯函数改动：不加依赖、不改包结构、不动 `TRIGGERS`（5 个 trigger 不变）。

### 3.2 四层路径（写死，别改）

| 层 | 路径 | 说明 |
|---|---|---|
| 默认 | `packages/dsh-gate/gates/default.json` | 随包发布，只读 |
| 用户全局 | `~/.dsh/state/session-superagent/gates.json` | `DSH_GATE_USER_CONFIG` 整体覆盖；`DSH_SUPERAGENT_STATE` 改状态目录 |
| 项目 | `<repo>/.superagent/gates.json` | 跟着仓库走 |
| 本地 | `<repo>/.superagent/gates.local.json` | 不进版本库 |

- 项目 / 本地层**只能关**语义复审，不能开或换模型（现有 `restrictSemantic` 行为，别动）。
- 读不到 / `extends` 循环 / 层数过深：fail-open 并记 `errors`，不抛异常。

### 3.3 CLI 契约（发送前唯一入口）

入口 `packages/dsh-gate/bin/gate.mjs`，bin 名 `dsh-gate`。

- 参数：`--trigger <issue.reply|pr.reply|pr.handle|merge|release>`、`--body-file <path|->`、
  `--current <编号>`、`--repo <目录>`、`--config <文件>`、`--json`、`--semantic`、`--help`。
- 退出码：`0` 通过（warn 不阻断）/ `1` 有 error 命中 / `2` 用法、配置、IO 错误。
  `2` 覆盖：未知参数、缺 `--body-file`、未知 trigger、`--current` 非数字、配置文件不存在或非法 JSON。
- 语义复审只在 `merge` / `release`；其余 trigger 即使给 `--semantic` 也 `skipped`。
- 硬门禁失败时**不请求模型**（先确定性、后语义）。
- 不在 gate 内调用 `gh` / `git` / `npm`（包内零 `child_process`）；不自动发送、不自动合并、不自动发布。
- `--json` 形状：`{ ok, trigger, current, hits, semantic }`，`current` 缺省为 `null`。

### 3.4 语义复审

- 只 `merge` / `release`；默认关闭（默认配置里 `semantic.enabled` 为 `false`）。
- 模型不可用 / 超时：放行并给 warning，不阻断硬门禁。
- 面板只如实说明，不另开判断（`client.js` 的 `GATE_SEMANTIC_TRIGGERS` 与包内常量必须一致）。

### 3.5 UI 面板

- `GateSettings` 保持独立子组件；**主面板 22 个 `useState` 槽位必须还是 22**，
  新增状态一律加在 `GateSettings` 里（位置化队列的旧规则：只能在末尾追加）。
- 三作用域：默认（只读）/ 我的 / 项目；开关真实写 `enabled:false` 到当前层，
  重新打开写完整规则 + `enabled:true`。
- 面板的「改动判定」必须把 `enabled` 纳入比较（`gateRuleKey`），
  否则「本层规则只有开关不同」会被当成没改 → 不落盘，等于假启停。
- 落盘形状 `gateRuleBody` 必须带布尔 `enabled`（默认层不写；我的 / 项目按开关写）。
- 保存后重读配置；卡片状态 = 四层合并结果，不再用「本层不覆盖」当托词。
- 正则收进每张规则卡的「高级」；保存 / 预览 / 优化提示词都有成功与失败态
  （失败文案以「预览失败：」「保存失败」开头）。
- 文案改动必须跑 `node scripts/render-panel-copy.mjs --write` 同步 `docs/面板文案.md`；
  预览快照（`scripts/render-preview.mjs` 的 `deskHooks`）与 `deskQueue` 槽位数同步。

---

## 四、工作流与依赖

| ID | 工作 | 写作用域 | 依赖 | 验收（真实命令） |
|---|---|---|---|---|
| R1 | 需求 / 现状冻结 | 本文件 | 无 | `npm test`、`node scripts/preflight.mjs`、`node scripts/ui-audit.mjs` 实跑；verdict=pass 才往下 |
| C1 | 规则启停 + CLI 用例 | `packages/dsh-gate/**` | R1 | `cd packages/dsh-gate && npm test` 全绿；停用 / 复启 / 只写 enabled 报错 先红后绿；CLI 0/1/2 |
| U1 | 面板真实启停 | `client.js`、`test/client.test.mjs`、`test/update-ui.test.mjs`、`docs/面板文案.md` | R1，可与 C1 并行 | 不再写「关掉仍生效」；主面板 22 槽不变；`npm test` 全绿；`node scripts/render-panel-copy.mjs --write` 后 `--check` 绿 |
| V1 | 独立验收 | 只读源码；可写 `docs/报告-gate-v2验收.md` 与临时证据 | C1、U1 | 全量 `npm test`、`node scripts/preflight.mjs`、`node scripts/ui-audit.mjs`、Chromium；贴真实计数与未验项 |
| Q1 | 严格审查 | 只读；产出 `docs/报告-gate-v2审查.md` | V1 | 查停用复活、越权、假绿、profile 缺包、CI 契约；无 blocker 才 verdict=pass |
| I1 | 集成发布 | 根配置 / 文档 / CI / 发布脚本 | Q1 | 只合全绿分支；版本、npm、tag、Release、main CI 证据齐全；`sync-profile --repair` 后 `--check` 绿 |

### 4.1 并行与集成纪律

- R1 后 C1 与 U1 同轮并行；V1 等两者完成；Q1 等 V1；I1 等 Q1。
- **子任务各自 worktree**：`git worktree add ../gate-v2-<id> -b task/gate-v2-<id> ff6b43b`，禁止共用 main。
- worktree 第一次跑测试前必须装依赖：`npm ci --ignore-scripts --no-audit --no-fund`
  （`node_modules` 不进版本库；不装的话 `semver` 与 `@mycf711/dsh-gate` 解析失败，**那不是代码问题**）。
- 同文件单写者：C1 只写 `packages/dsh-gate/**`；U1 只写列出的四个路径。
- 禁止 `git add -A`、禁止强推、禁止改写已推送的 PR 分支；失败先看产物，不盲重试。
- 跑 `preflight` 走 `scripts/gate-lock.mjs` 的锁：并发时会 `SKIP … 退出码 3`，**3 不算通过**。
- 交付第一行要求：自己跑过并贴原始计数 / 退出码；没有输出不算完成。
- 不改 DSH、不重启、不动 magpie proxy、不向外部仓库发 PR；issue #19 不动。

---

## 五、验收命令与当前真实输出

```sh
# 全量单测（唯一入口，自带离线开关）
npm test
# → ℹ tests 869 / ℹ pass 869 / ℹ fail 0 / exit 0

# 门禁包单测
cd packages/dsh-gate && npm test
# → ℹ tests 133 / ℹ pass 133 / ℹ fail 0 / exit 0

# 发布门禁（全量 42 项；CI 用 --fast，届时 41 项）
node scripts/preflight.mjs
# → 当前 --fast --no-maintenance：38 PASS / 1 FAIL / 2 SKIP（唯一红是 profile，见 §1.3，I1 清）

# UI 体检（11 项）
node scripts/ui-audit.mjs
# → UI 体检：11/11 通过（100 分）

# 文档契约
node scripts/check-docs.mjs

# CLI 正反向（实测退出码）
printf '收到，我看一下。\n' | node packages/dsh-gate/bin/gate.mjs --trigger issue.reply --body-file - --current 19 --repo .
# → PASS issue.reply  无命中 / exit 0
printf '直接 git push --force 覆盖远端\n' | node packages/dsh-gate/bin/gate.mjs --trigger issue.reply --body-file - --current 19 --repo .
# → FAIL issue.reply  1 项未通过（destructive）/ exit 1
node packages/dsh-gate/bin/gate.mjs --trigger nope --body-file -
# → gate: 未知 trigger… / exit 2
node packages/dsh-gate/bin/gate.mjs --trigger issue.reply
# → gate: 缺少 --body-file（传 - 从 stdin 读）/ exit 2

# 语义只 merge / release（不请求模型）
printf 'hello\n' | node packages/dsh-gate/bin/gate.mjs --trigger pr.reply --body-file - --semantic --json
# → {"ok":true,…,"semantic":{"skipped":true}}

# 面板真实交互（Chromium；I1 修完硬编码路径后复跑）
# ego-browser 的 nodejs 沙箱不继承父进程 env、cwd 是 ego 安装目录，仓库根要显式传进去：
{ echo "process.env.DSH_SUPERAGENT_REPO='$(pwd -W)'"; cat scripts/verify-panel-chromium.mjs; } | ego-browser nodejs
```

---

## 六、发布与非目标

- 目标版本：主插件 = 当前 `0.10.6` 的**下一 patch**；gate 包只有真实改动才 bump（当前 `0.1.0`）。
  本文件**故意不写死**下一个版本号字面量：`scripts/audit-docs-all.mjs` 拦「文档里出现高于当前版本的版本号」，
  写死就会让整条 preflight 在发布前一直是红的。发布后再回填。
- 发布三件套：npm + tag + Release（标题只写版本号）；`main` CI 必须 success。
- `main` 上的 CI 跑 `node scripts/preflight.mjs --fast`、`node scripts/ui-audit.mjs`、
  `node scripts/check-docs.mjs` 与维护一致性，见 `.github/workflows/ci.yml`。
- 不做：官方工具权限审批的替代、LLM 兜底放行、自动评论 / 合并 / 发布、重启宿主。
- 不把预览截图当成真机 WebView 验收；未验项必须逐条写明。

---

## 七、未验项（不许写成通过）

- 真实 DSH WebView 重载后的读屏 / 触摸 / IME。
- 真实 GitHub / Gitee 写操作（本轮只做本地门禁与本地 CLI）。
- Chromium 套件：V1 跑的是硬编码旧安装（不是当前运行的 0.2.2-rc.1）；I1 修路径后必须复跑并把新计数写进报告。
