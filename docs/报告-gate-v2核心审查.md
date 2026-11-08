# gate v2 核心实现严格审查（Q1）

> 审查人：reviewer（Q1）。日期：2026-11-08。角色：严格审查专员（只读源码）。
> 被审对象：C1（`packages/dsh-gate/**` 规则启停 + 发送前 CLI）与 V1 的独立验收报告 `docs/报告-gate-v2验收.md`。
> 需求来源：`docs/任务书-dsh-gate-v2.md`（R1 冻结版）。
> 本文件是 Q1 唯一写权限范围内的产物；源码 / 测试 / 脚本**零改动**（`git status` 与审查开始前一致，见 §二）。
>
> 文件名说明：任务书 §四（第 201 行）写的 Q1 产物是 `docs/报告-gate-v2审查.md`，本任务的写作用域是
> `docs/报告-gate-v2核心审查.md`（本文件）。I1 若按任务书找文件，改名/加链接即可，内容以本文件为准。

---

## 一、结论

**verdict = needs_revision（不通过）。**

C1 的**核心语义**（`enabled` 四层合并、停用复活、写盘往返、lintText 口径、CLI 退出码 0/1/2、模型调用边界、旧配置兼容）
经我另写的 36 项独立探针 + 仓库全量用例复跑，**没有发现 blocker / high**；但发布链上有 **1 条 blocker + 3 条 high** 必须先修，
所以不能给通过结论：

| 编号 | 严重度 | 问题 | 归属 |
|---|---|---|---|
| Q1-F1 | **blocker** | `sync-profile` 对门禁子包只比 `package.json`：`--repair` 后 gate `lib/` 仍是旧实现，`--check` 却 exit 0（假绿）→ profile 里「真实启停」退化成旧的剥字段行为 | I1（发布脚本） |
| Q1-F2 | **high** | 面板保存只带 `rules` 不带 `semantic`：我的层「开了语义复审」被静默关掉；项目层 `semantic:false` 被抹掉后 merge/release **真的发模型请求**（实测 1 次） | U1 + C1 写盘语义 |
| Q1-F3 | **high** | 面板保存丢 `extends`：项目层 extends 的共享规则静默消失（实测 `shared-secret` / `shared-path` 消失） | U1 + C1 写盘语义 |
| Q1-F4 | **high** | `README.md` 单测数 824 ≠ 实测 855，preflight 红；且 main 已到 0.10.7（827 项），集成后计数还会变（预计 858） | I1（发布） |
| Q1-F5 | medium | `scripts/verify-panel-chromium.mjs:16-17` 仍硬编码旧安装 `D:/DeepSeek Harness/Desktop`；V1 的 47/47、55/55 是临时副本改路径跑的 | I1 |
| Q1-F6 | medium | 版本目标应为 0.10.8（GitHub main 已 0.10.7 `e68da40`），本分支仍基于 0.10.6 `ff6b43b`；任务书「0.10.6 的下一 patch」需回填 | I1 |
| Q1-F7 | medium | 面板「上层已停用：……把它恢复」在停用来自**本地层**时不成立（实测保存后仍停用、正文仍放行） | U1 |
| Q1-F8 | low | `docs/面板文案.md` 快照不覆盖门禁文案（177 行里只有导航名「门禁」），U1 文案改动无快照守卫 | U1 |
| Q1-F9 | low | `GateResult.semantic` 接口表未写 `reason`；硬失败 skip 时缺 `semantic.ok`（与语义不可用分支形状不一致） | C1 文档 |
| Q1-F10 | low | V1 的 44/44、47/47、55/55 都是 `/tmp` 临时脚本，仓库不可复跑；发布证据不可重放 | V1 / I1 |

判断依据：任务契约「发现 blocker/high 必须列修复要求，不得 pass」。F1 是明确的发布阻断（队长 2026-11-08 消息也要求 Q1 按发布 blocker 审）；
F2/F3 是**静默丢用户配置**（其中 F2 直接改变模型调用边界），F4 是发布门禁红 —— 四条都不允许带进 0.10.8。

---

## 二、审查环境与独立性

| 项 | 值 |
|---|---|
| 工作树 | `D:/主工作区/projects/.tmp-issue9-push-20261106-1244` |
| 分支 / HEAD | `feat/gate-v2` @ `0d0d585`（基线 tag `v0.10.6` = `ff6b43b`） |
| 运行时 | Node v24.20.0，Windows |
| 未提交改动 | 8 个修改 + 2 个新文件（`packages/dsh-gate/test/enabled-rule.test.mjs`、`docs/报告-gate-v2验收.md`），审查前后 `git status --porcelain` 完全一致 |
| 独立性 | 我没有把 C1 的用例当唯一证据：另写 `/tmp/q1-gate-probe.mjs`（36 项）、`/tmp/q1-write-probe.mjs`、`/tmp/q1-panel-semantic-probe.mjs`、`/tmp/q1-local-layer-probe.mjs`，只调用公开 API / 真实 CLI / 真实 `client.js` 沙箱，状态全部落 `os.tmpdir()`；同时复跑了仓库自带的全部相关命令 |

复跑的真实计数（原始输出）：

```text
$ cd packages/dsh-gate && npm test
ℹ tests 133 / ℹ pass 133 / ℹ fail 0 / duration_ms 3438.86 / exit 0

$ node scripts/test.mjs          # 根全量
ℹ tests 855 / ℹ pass 855 / ℹ fail 0 / duration_ms 34084.94 / exit 0

$ node --test test/client.test.mjs
ℹ tests 135 / ℹ pass 135 / ℹ fail 0 / exit 0

$ node --test test/update-ui.test.mjs
ℹ tests 53 / ℹ pass 53 / ℹ fail 0 / exit 0

$ node scripts/ui-audit.mjs
UI 体检：11/11 通过（100 分）

$ node scripts/render-panel-copy.mjs --check
PASS 面板文案与当前实现一致（178 行；最长 77 字符；超过 80 字符的 0 条（上限 3））

$ node scripts/check-docs.mjs        # 全 PASS（索引 183 篇）
$ node scripts/check-maintenance.mjs # 6 项通过 / exit 0

$ node scripts/preflight.mjs --fast --no-maintenance
41 项 = 37 PASS / 2 FAIL / 2 SKIP，exit 1
  FAIL README 单测数        README 写 824，实际 855（改 README）
  FAIL profile 一致性 --check 缺失 0 / 断链 18 / 陈旧 0

$ node scripts/sync-profile.mjs --check
缺失 0 / 断链 18 / 陈旧 0，exit 1

$ node --check packages/dsh-gate/lib/index.js && node --check .../bin/gate.mjs \
  && node --check .../lib/semantic.js && node --check client.js
exit 0
```

---

## 三、C1 核心：逐条核验（36/36 独立探针全过）

| 冻结契约（任务书 §三） | 实现 | 我的独立实测 | 结论 |
|---|---|---|---|
| 规则可选 `enabled`，缺省 `true`；`false` = 本层停用 | `normalizeRule`（index.js:143-146）只保留**显式布尔** | 缺省时归一化结果**没有** `enabled` 字段；`false`/`true` 原样保留 | ✅ |
| 同 id 后层完整覆盖前层（含 `enabled`） | `mergeConfig`（165-177）按 id 覆盖 | 用户层停用 + 项目层不同 id → 仍停用；项目层完整规则 → 覆盖 | ✅ |
| 停用不被更前层复活；后层 `enabled:true` 即恢复 | 同上 | 用户开 / 项目关 → 关；项目关 / 本地开 → 开 | ✅ |
| 复启必须写同 id 完整规则；只写 `{id,enabled}` 判非法 | `validateConfig`（369-378） | `{id:'secret',enabled:true}` → `规则缺少 type…请写完整规则`；read 路径丢弃不完整规则、不静默复启 | ✅ |
| 非布尔 `enabled` 报错 / 读时 fail-closed | `validateConfig` 366-368；`normalizeRule` 145 | `enabled:'false'` → `enabled 必须是布尔值`；**读配置时规则仍生效**（不把保护关掉） | ✅ |
| 写盘保留 `enabled:false`（JSON 往返） | `writeGateConfig` → `normalizeConfig` | 写盘 → 读盘（`readGateScope`）→ 四层合并 → `lintText` 全链路 `false` 保持 | ✅ |
| 旧配置（没写 `enabled`）写回不凭空加字段 | `normalizeRule` 条件赋值 | 默认 10 条规则整份写回：10/10 都没有 `enabled` 字段 | ✅ |
| `lintText` 跳过 `enabled===false`（连 warn 都不出），`ok` 口径不变 | index.js:337-344 | error 停用 → 0 命中；warn 停用 → 0 命中；**未停用** warn → 1 条 hit 且 `ok=true`；`nonEmpty` 停用后空回复放行 | ✅ |
| 默认配置不新增停用项（10 条） | `gates/default.json` 无 diff | 10 条、无 `enabled`、`semantic.enabled=false` | ✅ |
| 四层路径写死、`extends` fail-open | index.js:92-98 / 191-234 | `DSH_GATE_USER_CONFIG` 整份覆盖、`DSH_SUPERAGENT_STATE` 改目录；基文件 / 本层覆盖 / `extends:false` 替换 / 循环 / 目标不存在 / >8 层：**全部不抛异常**并记 `errors` | ✅ |
| 项目 / 本地层只能关语义复审 | `restrictSemantic`（240-252） | 项目层写 `semantic.enabled:true` → `errors` 记「只能关闭」、生效值仍 `false` | ✅ |
| 纯函数改动、不改包结构 / `TRIGGERS` | 无新依赖 | `TRIGGERS` 5、`RULE_TYPES` 5、`PACKAGE_VERSION=0.1.0` 与 package.json 一致 | ✅ |
| 包内零 `child_process`（lib + bin） | — | 4 个运行时代码文件全部无 `child_process/spawn/exec` | ✅ |

### 3.1 CLI 契约（真实子进程，14 档全过）

| 场景 | 实测 |
|---|---|
| 干净回复 `issue.reply` | `PASS issue.reply  无命中` / **0** |
| 含 `ghp_*` | `FAIL issue.reply  1 项未通过` + `[error] secret …` / **1** |
| 规则 `enabled:false` | `PASS` / **0**（停用真的不命中） |
| 项目层停用 + 本地层完整规则 `enabled:true` | **1**（四层真实合并生效） |
| 未知 trigger / 缺 `--body-file` / `--current abc` / 配置文件不存在 / 未知参数 / 非法 JSON | 全部 **2**，stderr 带具体原因 |
| `--help` / `--json` 形状 | **0**；keys = `ok,trigger,current,hits,semantic`，`current` 缺省 `null` |
| 非布尔 `enabled`（`--config`） | **2** + `enabled 必须是布尔值` |
| `pr.reply --semantic` | `semantic.skipped=true` / **0**，不请求模型 |
| `merge --semantic` + 硬门禁失败（本地模型桩计数） | **模型请求 0 次** / **1**；`semantic={skipped:true,reason:"…"}` |
| `merge --semantic` + 干净回复（正对照） | **模型请求 1 次** / **0**；URL 命中 `/v1/chat/completions` |

### 3.2 模型调用边界（先确定性、后语义）

- `createGate`：硬门禁失败 → `fetchImpl` **0 次**、`semantic.skipped=true`；**只剩 warn 命中**（`ok=true`）→ 仍然请求 1 次（warn 不阻断，语义照跑）；`issue.reply` / `pr.handle` 即使开了语义也 0 次。正对照齐全，不是「断言函数没被调用」式的假绿。
- 主插件发送/预览侧：`lib/index.js:2519-2526` 预览路由本来就在 `!first.ok` 时提前返回；`gate.check` 只作为 provider 兜底。全库没有绕过 `createGate` 直接 `semanticReview` 的调用点。

### 3.3 测试是否「行为断言」

C1 新增的 `test/enabled-rule.test.mjs`（21 条）与 `test/cli.test.mjs` 新增 5 条、`test/gate-provider.test.mjs` 拆分 2 条，断言的都是**可观察行为**：归一化后的字段、`lintText` 的 `ok/hits`、写盘后文件内容与读回值、子进程退出码与 stdout/stderr、模型桩调用次数。没有「读源码正则命中」式的伪断言。
`gate-provider.test.mjs` 原用例「语义复审不可用时放行，硬门禁仍然生效」原来断言的是「硬门禁已失败仍请求模型」，与 §3.3 冲突；C1 已拆成「硬失败 → 0 次」「干净 → warning 放行」两条，拆分正确。

---

## 四、V1 证据复核

| V1 宣称 | 我的复核 | 结论 |
|---|---|---|
| 根 `npm test` 855/855 | 实跑 855/855 / exit 0 | ✅ 可复现 |
| gate 包 133/133 | 实跑 133/133 / exit 0 | ✅ |
| `client.test` 135 / `update-ui` 53 | 实跑 135、53 | ✅ |
| `ui-audit` 11/11（100） / `render-panel-copy --check` 178 行 / `check-docs` PASS | 全部复现 | ✅ |
| `preflight --fast --no-maintenance` 41 行 = 37 PASS / 2 FAIL / 2 SKIP | 实跑完全一致，exit 1 | ✅ |
| 独立副本与工作树逐字节一致 | `client.js` sha256 `4309a700…aa8b`、gate `lib/index.js` `e7d51471…ac0` 两边相同 | ✅ |
| 44/44 独立规则/CLI 用例 | `/tmp/v1-independent-gate.log` 末行「汇总：44/44 通过，失败 0」，脚本在 `/tmp` | ⚠️ 日志可信但**不可从仓库复跑**（Q1-F10） |
| Chromium 47/47（当前安装 0.2.2-rc.1） | `/tmp/v1-panel-chromium-baseline.log` 有完整 PASS；临时副本第 16-17 行确实被改成 `Desktop-0.2.2-rc.1` | ⚠️ 仓库脚本仍指向旧安装（Q1-F5） |
| 门禁面板 8 项 + 合计 55/55 | `/tmp/v1-chromium-gates2.log` 有「门禁面板真实渲染…」「无页面错误或外部请求」 | ⚠️ 临时副本，未入库 |
| 未验项（真机 WebView / 真实模型 / 真实 GitHub 写 / 截图） | 与我的判断一致 | ✅ 声明诚实 |

**V1 漏掉的三处**（不是「未验」，而是可验未验）：面板保存丢 `semantic`（Q1-F2）、丢 `extends`（Q1-F3）、本地层停用时「恢复」文案不成立（Q1-F7）。V1 的 Chromium 8 项只覆盖了规则开关与保存形状，没覆盖「本层其它配置是否被整层替换带走」。

---

## 五、发现（findings）

### Q1-F1 · blocker · `sync-profile` 对门禁子包假绿（发布阻断）

- 位置：`scripts/sync-profile.mjs:80-100`（门禁子包只比 `package.json` 内容）。
- 证据（全部实测）：
  1. profile 与仓库的 `packages/dsh-gate/package.json` sha256 **都是** `8de9bd73…f0a5` → 判「同一份」，不进 `missing`；
  2. profile 里 gate `lib/index.js` 的 `typeof rule.enabled === 'boolean'` 命中 **0**，仓库里 **1**（旧实现）；
  3. 同盘临时 DEST 跑 `--repair` 后：`缺失 7 / 断链 11 / 陈旧 0，本次处理 18 个`，gate `lib/index.js` 仍是旧内容（grep **0**）；随后 `--check` **exit 0**（缺失 0 / 断链 0 / 陈旧 0）；同一份 DEST 的 `client.js` 已是新内容（grep「本层已停用」= 1）。
- 后果：profile 会拿到**新面板 + 旧门禁包**。面板 POST `enabled:false`，旧 `normalizeRule` 把它剥掉 → 用户看到「已保存」，实际规则照跑 —— 正是本轮要消灭的「假启停」，而且 `--check` 全绿。
- 修复要求（二选一，I1）：
  ① bump gate 包版本（`packages/dsh-gate/package.json` + `PACKAGE_VERSION` + tag），让 `package.json` 内容变化触发整目录替换；或
  ② 让 `sync-profile.mjs` 对门禁子包做内容比对（`lib/**` 哈希）并在 `--repair` 强制替换。
- 修完必须复验：`--check` 缺失 0 / 断链 0 / 陈旧 0 **且** profile 里 `grep -c "typeof rule.enabled === 'boolean'"` = 1，再复跑本报告 §三/§四。
- **不得只靠文档说明绕过**（队长 2026-11-08 明确要求）。

### Q1-F2 · high · 面板保存静默丢本层 `semantic`（并改变模型调用边界）

- 位置：`client.js:2256-2285`（`gateConfigOf` 只构造 `{name, rules}`，`semantic` 仅在「本次相对基准有变化」时写入）；落盘 `packages/dsh-gate/lib/index.js:452-474`（整层替换）。
- 证据 A（我的层开启语义复审后，任何一次只改规则的保存）：
  `保存前 semantic.enabled = true（model=my-model）` → 写盘后 user 文件字段 `version,name,rules`、`semantic=undefined` → `保存后 semantic.enabled = false`。
- 证据 B（项目层显式退出语义复审）：项目层 `semantic:false`，只切一条规则保存 → 写盘后 `semantic=undefined` → 重读 `project 生效 semantic.enabled = true`；用该配置跑 `createGate`（`merge` + 干净正文）→ **模型调用 1 次**。项目层的「不要请求模型」被一次无关保存抹掉。
- 修复要求：`gateConfigOf` 必须把本层原有 `semantic` **原样写回**（对象或 `false`），不能只在「这次改了」时才写；并补 `test/client.test.mjs` 行为用例（保存规则后重读，本层 `semantic` 仍在、`semantic:false` 仍生效）。
- 归属：U1（client.js）；I1 复验。

### Q1-F3 · high · 面板保存丢 `extends`（共享规则静默消失）

- 位置：`client.js:2256-2285` + `writeGateConfig`（`normalizeConfig` 只保留 `version/name/rules/semantic`，`extends` 被丢）。
- 证据：项目层 `{name:'project', extends:'./shared.json', rules:[proj-only]}`，保存前 project 层规则含 `shared-secret,shared-path`；面板保存（只切一条规则）后文件字段 `version,name,rules`、`extends=undefined`；重读 project 层规则里 `shared-secret` / `shared-path` **消失**。
- 后果：README 明确文档化的 `extends` 在面板保存后失效；共享的凭证/路径规则静默不再生效。
- 修复要求：保存时保留 `extends`（从 `data.scopes[scope].config` 原样带回），或在有 `extends` 时拒绝保存并给出明确文案；补对应行为用例。

### Q1-F4 · high · 单测计数与发布门禁（README / 任务书）

- `README.md:147` 仍写「824 项单测、41 项 preflight、11 项 UI、47 项 Chromium 全绿（0.10.5）」；实测根 `npm test` **855**。
- `preflight --fast --no-maintenance` 因此红：`FAIL README 单测数  README 写 824，实际 855（改 README）`。
- **注意**：GitHub main 已推进到 0.10.7（`e68da40`，见 Q1-F6），main 的 README 已写 827；本分支合过去后预计 **858**（827 + 31）。直接回填 855 会在集成后再次变红。
- 要求（I1）：集成到 `e68da40` 之后**重跑全量**，按实测回填 README 的单测 / preflight 项数；`docs/任务书-dsh-gate-v2.md` §1.3 / §五 的 824、106 也要回填（R1 冻结文件，由 I1 复审后改）。

### Q1-F5 · medium · Chromium 验证脚本硬编码旧安装（发布前必须改）

- 位置：`scripts/verify-panel-chromium.mjs:16-17`：`ASAR = 'D:/DeepSeek Harness/Desktop/resources/app.asar'`、`ELECTRON = …/Desktop/DeepSeek Harness.exe`。
- 当前运行安装是 `D:/DeepSeek Harness/Desktop-0.2.2-rc.1`（两个目录都存在）。V1 的 47/47、55/55 是在 `/tmp` 副本里把这两行改到当前安装跑的（我核对了副本第 16-17 行与日志）；**仓库里的脚本没有改**。
- 要求：改成可配置（`DSH_PANEL_ASAR` / `DSH_PANEL_ELECTRON`）或指向当前安装，修完复跑并贴新计数；否则 CI / 下一个审查者仍会验到旧前端。

### Q1-F6 · medium · 版本目标与集成基线

- 实测：`D:/主工作区/projects/dsh-session-superagent` 的 `remotes/origin/main` = `e68da40`（`Merge pull request #23 from MYCF711/integrate/pr22`），`git show e68da40:package.json` → `"version": "0.10.7"`。
- 本分支基于 `ff6b43b`（0.10.6）。任务书 §六「目标版本：当前 0.10.6 的下一 patch」已被占用。
- 要求（I1）：目标版本改 **0.10.8**；集成前先把 `feat/gate-v2` 合到 `e68da40`（或 rebase），再统一改六处版本面（package.json / SERVER_VERSION / CLIENT_VERSION / README 徽章 / gate 包 / CHANGELOG），并回填任务书。

### Q1-F7 · medium · 本地层停用时「恢复」文案不成立

- 位置：`client.js:2469-2470`（「上层已停用：打开会写一条完整规则到本层，把它恢复」）。
- 实测：`scope=user`、本地层 `gates.local.json` 停用 `secret`；面板显示停用；按文案保存 user 层完整规则 `enabled:true` 后重读 → `secret.enabled=false`、同一正文仍放行（`lintText.ok=true`）。停用来自**更后**的本地层，user/project 层无法复活它，文案的「上层」「把它恢复」都不准确（与 V1 §七 F6 同一问题）。
- 要求：明确「本地层属于手工高级配置，面板不承诺能复启」，或把「上层」改成「更后层（本地优先）」；至少不能让用户以为点一下就能恢复。

### Q1-F8 · low · 面板文案快照不覆盖门禁

- `docs/面板文案.md` 共 177 行（脚本口径 178），只有第 133 行导航名「门禁」；`render-panel-copy.mjs --check` 绿是空转。U1 新改的两句停用文案目前只有 `test/client.test.mjs` 的负断言守着。
- 建议：把门禁面板文案纳入快照（或明确写「门禁文案由组件用例守」），否则下一轮改文案无人拦。

### Q1-F9 · low · `GateResult.semantic` 形状文档不一致

- `packages/dsh-gate/README.md` 的 `GateResult` 接口写 `semantic?: { skipped: boolean; warning?: string }`；硬门禁失败时实际返回 `{skipped:true, reason:'硬门禁未通过，未请求模型'}`（`reason` 只在正文说明里，接口表没有），且此时**没有 `ok` 字段**（语义不可用分支是 `{skipped:false, ok:true, warning}`）。
- 现有调用方都不读 `semantic.ok`，不构成行为回归；建议接口表补 `reason?: string`，并统一两处 skip 形状，避免第三方 GateProvider 消费者踩空。

### Q1-F10 · low · V1 的独立用例不可复跑

- V1 的 44/44（`/tmp/v1-independent-gate.mjs`）、47/47、55/55（`/tmp/v1-panel-chromium-*.mjs`）都在临时目录，未入库。我核对了脚本内容、哈希与日志，但**无法从仓库重放**。
- 建议：把「规则启停 + CLI 退出码 + 面板保存形状」并进仓库套件；Q1-F2 / Q1-F3 的修复必须带仓库内用例。

---

## 六、明确不构成问题的核对（避免下游重复怀疑）

- `normalizeRule` 对**非布尔** `enabled` 是「忽略并保留规则」，不是「当 false」——失败方向是保护仍在，符合 §3.1「fail-closed」。
- `validateConfig` 对 `{id, enabled:false}`（缺 type）同样判非法：比「只写 id + enabled:true」更严格，但方向正确（面板始终写完整规则），不构成缺陷。
- `mergeConfig` 在「后层完整规则不写 `enabled`」时按缺省 `true` 覆盖前层停用 —— 这是 §3.1「同 id 后层完整覆盖（含 enabled）」的字面结果，不是「停用被更前层复活」。
- `extends` 的**读取**侧（基文件 / 替换 / 循环 / 目标不存在 / >8 层）全部 fail-open 且不抛异常；本轮问题只在**写盘**（Q1-F3）。
- 预览路由 `/gates/preview` 的语义边界本来就先判 `!first.ok` 再请求模型；C1 的改动没有破坏它。
- 包内零 `child_process` 的断言只针对 `lib/` + `bin/`（测试需要 `spawn` 跑 CLI，不算运行时调用）。

---

## 七、未验项（不许写成通过）

1. 真实 DSH WebView / 宿主重载：本轮没有重启 / 重载 DSH，profile 安装副本仍是旧内容（Q1-F1 / Q1-F5 修完必须复验）。
2. 真实模型调用：只验了桩（成功 / 不可用 / 跳过 / 0 次边界），没有调真实网关。
3. 真实 GitHub / Gitee 写操作：本轮不做。
4. 仓库自带 Chromium 套件：没有在仓库原样复跑（硬编码旧安装，Q1-F5）；V1 的 47/47、55/55 是临时副本。
5. 本地层面板交互（Q1-F7）：面板没有本地作用域，只验证了「本地层覆盖会导致恢复无效」。
6. 截图：无（V1 的 `CAPTURE_SCREENSHOTS=false`），没有把截图当 WebView 证据。

---

## 八、复跑命令（可直接粘）

```sh
cd D:/主工作区/projects/.tmp-issue9-push-20261106-1244

# 全量 / 包 / 面板
npm test                                        # 855/855, exit 0
(cd packages/dsh-gate && npm test)              # 133/133, exit 0
node --test test/client.test.mjs                # 135/135
node --test test/update-ui.test.mjs             # 53/53
node scripts/ui-audit.mjs                       # 11/11（100 分）
node scripts/render-panel-copy.mjs --check      # 178 行 PASS
node scripts/check-docs.mjs                     # PASS
node scripts/check-maintenance.mjs              # 6/6, exit 0

# 发布门禁（两条红见 Q1-F4 / Q1-F1）
node scripts/preflight.mjs --fast --no-maintenance   # 41 项 37/2/2, exit 1
node scripts/sync-profile.mjs --check               # 缺失 0 / 断链 18 / 陈旧 0, exit 1

# Q1 独立探针（临时证据，不进仓库）
node /tmp/q1-gate-probe.mjs                     # 36/36, exit 0
node /tmp/q1-write-probe.mjs                    # Q1-F2 / F3 的服务端证据
node /tmp/q1-panel-semantic-probe.mjs           # 面板保存丢 semantic 的 POST 形状
node /tmp/q1-local-layer-probe.mjs              # Q1-F7 本地层覆盖证据
Q1_CLIENT=/tmp/client-head.js node /tmp/q1-panel-semantic-probe.mjs  # 对照 0.10.6 HEAD（同样丢）
```
