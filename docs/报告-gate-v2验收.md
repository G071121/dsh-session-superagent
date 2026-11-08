# gate v2 独立验收（V1）

> 验收人：verifier（V1）。日期：2026-11-08。
> 需求来源：`docs/任务书-dsh-gate-v2.md`（R1 冻结版）。
> 被验实现：C1（规则启停 + CLI，`packages/dsh-gate/**`）与 U1（面板真实启停，`client.js` + `test/client.test.mjs`）。
> 本文件是 V1 唯一写权限范围内的产物；源码只读，未改任何实现文件。

## 一、结论

1. **C1 / U1 的实现可以进入 Q1 严格审查。** 在独立副本里全部可复现：根 `npm test` 855/855、gate 包 133/133、面板用例 135/135、UI 体检 11/11（100 分）、Chromium 47/47（已按当前安装 0.2.2-rc.1 复跑，不是旧安装那次的 47/47），另加我补的门禁面板真实往返 8 项全过；我自己写的规则 / CLI 复跑 44/44（不是跑他们的用例）。
2. **preflight 不是全绿，但两条红项都不在 C1/U1 写作用域内**：`README 单测数`（824 → 实际 855）与 `profile 一致性`（断链 18）必须由 I1 在发布前清掉。V1 不把这两项算通过。
3. **另有一条发布阻断（F8，I1）**：`sync-profile.mjs` 对门禁子包只比对 `package.json`；C1 改了 gate 的 `lib/`，版本没 bump → `--repair` **不会**更新 profile 里的门禁子包，`--check` 还会显示「缺失 0」，属于假绿风险。见 §七。
4. 另外几条非阻塞问题见 §七（文档回填、Chromium 套件不覆盖门禁面板、面板文案快照不覆盖门禁文案）。
5. **本报告不宣称真机 WebView 通过**：本轮没有重启 / 重载 DSH，profile 安装副本仍是旧内容（见 §七 F2）。

## 二、环境与副本

| 项 | 值 |
|---|---|
| 被测工作树 | `D:/主工作区/projects/.tmp-issue9-push-20261106-1244`，分支 `feat/gate-v2` @ `0d0d585` |
| 未提交改动 | 8 个修改（`client.js`、`packages/dsh-gate/{README.md,bin/gate.mjs,lib/index.js,test/cli.test.mjs,test/gate-provider.test.mjs}`、`test/client.test.mjs`、本任务书文档）+ 1 个新文件 `packages/dsh-gate/test/enabled-rule.test.mjs` |
| 独立验收副本 | `D:/主工作区/projects/.tmp-v1-verify-20261108`（纯目录副本，排除 `.git`） |
| 副本一致性 | `client.js` sha256 `4309a700…41aa8b` 与工作树逐字节相同；`node_modules/@mycf711/dsh-gate/lib` 与 `packages/dsh-gate/lib` `diff -rq` 无差异，且 inode 与工作树不同（不是共享链接） |
| 运行时 | Node v24.20.0，Windows；Chromium **156.0.8078.74**；安装版前端 **0.2.2-rc.1**（asar sha256 `5fa8a6b2…34e637`） |
| 副本的已知偏差 | 副本没有 `.git`，所以 `维护一致性` 在副本里必然红（§五 已用工作树对照证明） |

## 三、实跑计数（原始输出，不是字符串宣称）

| 命令 | 结果 | 退出码 |
|---|---|---|
| `npm test`（副本根，`node scripts/test.mjs`） | `ℹ tests 855 / ℹ pass 855 / ℹ fail 0`，duration 32700 ms | 0 |
| `cd packages/dsh-gate && npm test` | `ℹ tests 133 / ℹ pass 133 / ℹ fail 0`，duration 3402 ms | 0 |
| `node --test test/client.test.mjs` | `ℹ tests 135 / ℹ pass 135 / ℹ fail 0` | 0 |
| `node --test test/update-ui.test.mjs` | `ℹ tests 53 / ℹ pass 53 / ℹ fail 0` | 0 |
| `node scripts/ui-audit.mjs` | `UI 体检：11/11 通过（100 分）` | 0 |
| `node scripts/render-panel-copy.mjs --check` | `PASS 面板文案与当前实现一致（178 行；最长 77 字符；超过 80 字符的 0 条）` | 0 |
| `node scripts/check-docs.mjs` | 全 PASS（索引 183 篇、板块篇数一致） | 0 |
| `node scripts/preflight.mjs --fast --no-maintenance` | 41 行 = 37 PASS / 2 FAIL / 2 SKIP（见 §五） | **1** |
| `node scripts/preflight.mjs`（任务书 §五 的完整口径，额外跑） | 42 行 = 38 PASS / 3 FAIL / 1 SKIP（第三红是副本无 `.git`，见 §五） | **1** |

计数对账（基线是在 HEAD `0d0d585` 的 `git archive` 副本里实跑，不是抄别人的数）：

| 口径 | HEAD 基线 | 本轮 | 增量 |
|---|---|---|---|
| 根 `npm test` | 824 | 855 | +31 |
| gate 包 | 106 | 133 | +27 = `enabled-rule.test.mjs` 21 + `cli.test.mjs` +5 + `gate-provider.test.mjs` +1（拆成「硬失败不请求模型 / 语义不可用仍放行」两条） |
| `test/client.test.mjs` | 131 | 135 | +4（启停用例） |

面板结构（独立计数，不依赖他们的用例）：`ZhuliPanel` **22** 个 `useState`、`GateSettings` **11** 个（`data/loadError/scope/draft/advanced/sample/trigger/preview/models/busy/status`），主面板里没有夹带任何 gate 专属状态。

## 四、规则启停与 CLI：独立复跑（44/44，exit 0）

用例是我自己写的（`/tmp/v1-independent-gate.mjs`，临时证据，不进仓库），只读调用 `packages/dsh-gate/lib/index.js` 与 `bin/gate.mjs`，状态全部落在 `os.tmpdir()`。没有跑 C1 写的任何用例。

### 4.1 规则启停与契约（28 项，下表摘关键场景）

| 场景 | 实测 |
|---|---|
| 默认层 | 10 条规则、`semantic.enabled=false`、**没有任何 `enabled` 字段**（旧配置行为不变） |
| 用户层完整规则 + `enabled:false` | 合并后仍在且 `enabled === false`；同一正文 0 命中、`ok=true`；其它规则（abs-path）照旧拦 |
| 项目层完整规则 + `enabled:true` | 复启：`enabled === true`，同一正文再次被拦 |
| 前层开 / 后层关 | 项目层 `enabled:false` 覆盖用户层 `enabled:true` → 停用（停用不会被更前层复活） |
| 本地层最后生效 | 项目层停用 + 本地层 `enabled:true` → 复启（四层顺序 default→user→project→local） |
| 只写 `{id, enabled:true}` | `validateConfig` → `规则缺少 type：secret（只写 id + enabled 不能停用或复启，请写完整规则）`；直接写盘也会被合并丢弃（不会误复启） |
| `enabled:"false"`（字符串） | `validateConfig` → `enabled 必须是布尔值：secret`；读盘时忽略并**保持规则生效**（fail-closed） |
| `writeGateConfig` 往返 | 磁盘 JSON `enabled === false`；`readGateScope` 读回 `false`；重新 `loadGateConfig` 仍停用 |
| warn 规则停用 | 开：1 条 warn 命中（`ok=true`）；停用：0 命中（连 warn 都不出） |
| 四层路径 | `~/.dsh/state/session-superagent/gates.json`（`DSH_GATE_USER_CONFIG` 可整体覆盖）、`<repo>/.superagent/gates.json`、`gates.local.json` 均未变 |
| fail-open | `extends` 指向自身 / 坏 JSON：`errors` 记 1 条、不抛异常、默认 10 条仍在 |
| 项目层越权 | 项目层写 `semantic.enabled:true` → `errors` 记「项目/本地配置只能关闭语义复审，不能开启或更换模型」，生效值仍 `false` |
| 包边界 | `TRIGGERS` 仍是 5 个、`RULE_TYPES` 仍是 5 个；（`lib/` + `bin/`）零 `child_process` / `spawn` |
| 默认配置 | `gates/default.json` 仍 10 条、都不带 `enabled`（没有偷偷塞停用项） |

### 4.2 CLI 退出码（真实子进程，14 项）

| 场景 | 实测输出 / 退出码 |
|---|---|
| 干净回复 `issue.reply` | `PASS issue.reply  无命中` / **0** |
| 含 `ghp_*` | `FAIL issue.reply  1 项未通过` + `[error] secret …` / **1** |
| 该规则 `enabled:false` | `PASS issue.reply  无命中` / **0** |
| 项目层完整规则复启 | **1** |
| 未知 trigger | `gate: 未知 trigger：nope（可选：…）` / **2** |
| 缺 `--body-file` | `gate: 缺少 --body-file（传 - 从 stdin 读）` / **2** |
| `--current abc` | `gate: --current 必须是数字编号` / **2** |
| 配置文件不存在 | `gate: ENOENT: no such file or directory, open '…'` / **2** |
| 未知参数 `--nope` | `gate: 未知参数：--nope` / **2** |
| 配置 JSON 非法 | `gate: Expected property name or '}' in JSON at position 2` / **2** |
| `--json` 形状 | `{ok,trigger,current,hits,semantic}`，`current` 缺省 `null` / **0** |
| `pr.reply --semantic` | `semantic:{skipped:true}` / **0** |
| `merge --semantic` + 硬门禁失败 | `semantic:{skipped:true,reason:"硬门禁未通过，未请求模型"}` / **1** |
| `merge --semantic` + 干净回复（语义开启但没配模型） | `semantic:{skipped:true,ok:true,warning:"语义复审未配置模型，已跳过"}` / **0**（正对照：证明它真的走进了语义分支） |

### 4.3 硬门禁失败不请求模型（直接测 `createGate`）

- 语义开启 + `fetchImpl` 计数桩 + 正文含 `ghp_*` + `trigger=merge` → **调用 0 次**，`semantic={skipped:true, reason:"硬门禁未通过，未请求模型"}`，`ok=false`。
- 同一 gate 换成干净正文 → **调用 1 次**（正对照，桩确实会被调用）。
- 桩抛错（模拟模型不可用）→ `ok=true`、`warning:"语义复审不可用，已放行：…"`（不阻断硬门禁，符合 §3.4）。

## 五、preflight（两条真红，都不在 C1/U1 写作用域）

### 5.1 任务要求的口径：`node scripts/preflight.mjs --fast --no-maintenance`

41 行 = **37 PASS / 2 FAIL / 2 SKIP**，退出码 **1**。（完整口径是 42 行；`--fast` 会整条跳过「门禁自检」，不记行，所以少 1 行。）

```
FAIL README 单测数       README 写 824，实际 855（改 README）
FAIL profile 一致性 --check   缺失 0 / 断链 18 / 陈旧 0
SKIP 冒烟 smoke:observe   --fast 跳过
SKIP 维护一致性           --no-maintenance 跳过（PR 分支还没打 tag）
```

### 5.2 完整口径：`node scripts/preflight.mjs`（任务书 §五，额外跑）

42 行 = **38 PASS / 3 FAIL / 1 SKIP**，退出码 **1**。多出来的第三红是 **副本没有 `.git`**：

```
FAIL 维护一致性   不一致：当前版本有 git tag；tag 指向已提交的 commit
SKIP 冒烟 smoke:observe   需要真机宿主（已列进攒批清单）
PASS 门禁自检     21/21 项注入都被检测到（26/42 项有注入）
```

对照：在开发工作树跑 `node scripts/check-maintenance.mjs` → **6 项通过**（`PASS 当前版本有 git tag v0.10.6`、`PASS tag 指向已提交的 commit ff6b43b0`、…），退出码 0。**所以这条是副本环境偏差，不是代码问题。**

### 5.3 两条真红的归属

| 红项 | 实测 | 归属 |
|---|---|---|
| `README 单测数` | README 写 824，实际 855 | I1：C1/U1 新增 31 条后必须回填 README（另外 README 第 147 行还写「41 项 preflight」，实际 42） |
| `profile 一致性` | 缺失 0 / 断链 18 / 陈旧 0 | I1：`sync-profile.mjs --repair`（在要安装的那份仓库上跑），之后 `--check` 必须 缺失 0 / 断链 0 / 陈旧 0。判据是 **inode 相同**（硬链接），所以 18 条断链是「profile 副本不是这个 checkout 的硬链接」，与本轮改没改内容无关；真正的内容代差只有 `client.js` 与门禁子包（见 F2 / F8） |

## 六、面板：真实 Chromium 往返（47/47 + 8 项追加，exit 0）

### 6.1 仓库自带 Chromium 套件

- 仓库里的 `scripts/verify-panel-chromium.mjs:16-17` **仍然硬编码旧安装** `D:/DeepSeek Harness/Desktop/…`。按任务书 §2.5-3，我只在建在 `/tmp` 的临时副本里把 `ASAR` / `ELECTRON` 指向当前安装 `D:/DeepSeek Harness/Desktop-0.2.2-rc.1/…`，`REPO` 指向验收副本后运行；**仓库那份脚本本身没有改**（I1 必须改）。
- 结果：**47/47 PASS，exit 0**；`frontendVersion=0.2.2-rc.1`、`chromium=156.0.8078.74`、`reactVersion=18.3.1`、`primitivesIdentity=true`、`slotEvents` 捕获 desk + orbit 注册。
- 这套件覆盖的是主面板 / 设置页 / Orbit / Modal；**门禁面板只断言了设置左栏有「门禁」两个字**，没有任何规则开关或保存的检查。

### 6.2 V1 追加：门禁面板真实启停 8 项（临时 fixture，不属于仓库套件）

在临时副本里给 loopback fixture 补了 `GET /gates`、`GET /gates/models` 与 `POST /gates`（POST 会把层写回内存并让下一次 GET 读到），然后驱动真实 `client.js`：

| 检查 | 结果 |
|---|---|
| 面板真实渲染：3 条规则 / 3 个开关 / 初始「与已保存的一致」/ 路径 `fixture://user.json` | PASS |
| 关掉一条：开关 `aria-checked=false`、出现「上层已停用：打开会写一条完整规则到本层，把它恢复。」、保存栏「未保存」 | PASS |
| 保存「关掉」：POST `scope=user`，`rules[0]` 是完整规则 + `enabled:false`（`label/type/message/triggers/pattern` 齐） | PASS |
| 保存后重读 `/gates`：卡片回到四层合并结果（「规则 2 / 3」，开关仍关），状态「已保存到「我的」」 | PASS |
| 保存「重新打开」：POST `rules[0].enabled=true`，**仍是完整规则**（不是只写 `{id, enabled}`） | PASS |
| 项目层保存：POST `scope=project`、只写本层改动（`abs-path` + `enabled:false`，不带其他规则） | PASS |
| 默认层只读：3 个开关全部 `disabled`、没有保存栏 | PASS |
| 往返全程无页面错误、无外部请求（`window.__captureErrors` / `__networkViolations` 均为空） | PASS |

合计 **55/55 PASS，exit 0**（47 自带 + 8 追加）。

**边界（必须写清）**：这是 **Chromium + 安装版前端资源（0.2.2-rc.1）+ loopback fixture 页面**，**不是 DSH WebView**，也不是真实宿主会话；fixture 的 `/gates` 是进程内 mock。规则合并 / 写盘的语义由 §四 的真实包复跑覆盖，两者合起来才是完整链路。本轮**没有产出截图**，也没有把 Chromium 截图当作真机 WebView 证据。

## 七、发现（不阻塞 Q1，但会阻塞发布或降低后续可维护性）

- **F1（阻塞发布，I1）**：`README.md` 单测数 824 → 855；同文件第 147 行「41 项 preflight」→ 42。`preflight` 的 `README 单测数` 因此红。
- **F2（阻塞发布，I1）**：profile 安装副本 `D:/DeepSeek Harness/home/profiles/desktop/node_modules/dsh-session-superagent` 与仓库 `缺失 0 / 断链 18`。实测该副本里 `node_modules/@mycf711/dsh-gate/lib/index.js` **不含**本轮 `enabled` 语义、`client.js` 也**不含**「本层已停用 / 上层已停用」新文案 —— 也就是说：**`sync-profile --repair` 之前，运行中的插件还是旧行为**。修完必须 `--check` 到 缺失 0 / 断链 0 / 陈旧 0 并复跑本报告的 §四、§六。
- **F3（I1 回填）**：`docs/任务书-dsh-gate-v2.md` §1.3 / §五 仍写 `tests 824`、gate 包 `106/106`（实际 133/133）。这是 R1 冻结文件，V1 没改。
- **F4（建议 I1/Q1 决策）**：仓库的 Chromium 套件不覆盖门禁面板（只查设置分区名）。我用临时扩展补了 8 项并通过；建议把门禁面板往返并入正式套件（否则下一轮改面板仍然没有浏览器级守卫）。
- **F5（覆盖率缺口，不阻塞）**：`docs/面板文案.md` 快照**不含**门禁面板文案（178 行里关于门禁只有导航名）。U1 改的两句停用文案目前只有 `test/client.test.mjs` 的负断言守着，「文案改动必须同步快照」这条对本轮改动实际是空转。
- **F6（已知边界，任务书未要求）**：面板只有默认 / 我的 / 项目三个作用域。若本地层 `.superagent/gates.local.json` 停用了某条规则，面板切到「我的」重新打开并保存后，本地层仍然后覆盖 → 重读后开关又变回关。UI 没有撒谎（显示的就是合并结果），但用户可能困惑。建议在 Q1 里明确「本地层属于高级手工配置，面板不承诺能复启」。
- **F7（观察，给后续自动化）**：本机安装了官方 `Switch` 原语，`Toggle` 会把 `id` 落在无样式 **wrapper span** 上，真实 DOM 里 `#gate-rule-*-switch` 是 span，`role=switch` 在里面一层。写浏览器自动化时要选 `#gate-rule-secret-switch [role=switch]`（我第一轮就踩了这个，已改）。
- **F8（发布阻断，I1）**：`scripts/sync-profile.mjs` 对门禁子包 `node_modules/@mycf711/dsh-gate` 的判定**只比对 `package.json` 内容**。C1 改了 gate 的 `lib/index.js` / `bin/gate.mjs`，但 `packages/dsh-gate/package.json` 没动、版本仍是 `0.1.0`，与 profile 里那份**逐字节相同**（两边 sha256 都是 `8de9bd73…`）→ `--check` 判「缺失 0」，`--repair` 也**不会**替换门禁子包。实测 profile 里的 gate `lib/index.js` 不含 `enabled` 语义（`typeof rule.enabled === 'boolean'` 命中 **0**；仓库里命中 **1**）。**后果：I1 跑完 `sync-profile --repair` 后，profile 里的门禁子包可能仍是旧实现，真机行为与仓库不一致，而 `--check` 是绿的。** 修复方向（二选一）：① 按「gate 包有真实改动」bump 版本（package.json 变化会触发整目录替换）；② 让 `sync-profile.mjs` 对门禁子包做内容比对（例如 `lib/**` 哈希）并在 `--repair` 强制替换。修完必须复验：profile 里 `grep -c "typeof rule.enabled === 'boolean'"` 应为 1、`client.js` 应含「本层已停用 / 上层已停用」。

## 八、未验项（不许写成通过）

1. **真实 DSH WebView**：没有重启 / 重载 DSH，没有在真实宿主会话里看面板与读屏；profile 安装副本仍是旧内容（F2）。
2. **真实宿主内交互**：§六 是 Chromium harness，不是 DSH WebView。
3. **真实 GitHub / Gitee 写操作**：本轮不做（CLI 只到「不请求模型 / 不自动发送」这一层）。
4. **语义复审真实模型调用**：只验了桩的成功 / 不可用 / 跳过三态，没调真实网关。
5. **面板的语义复审开关、试跑预览、提示词优化、模型下拉**：没做真实 Chromium 往返（只验了规则启停与保存）。
6. **截图**：仓库脚本 `CAPTURE_SCREENSHOTS=false`；本轮没有截图证据，也没有把页面截图冒充真机 WebView。
7. **本地层面板交互**（F6）。
8. **三条门禁红项**（README / profile / 维护一致性）由 I1 处理，本报告不算通过。
9. **profile 修复后的真机行为**：本轮没有跑 `--repair`（会改 profile 安装副本，属于 I1 的发布步骤），也没有重启 / 重载宿主，所以「装进 profile 后插件真的按新语义跑」这件事**未验**——尤其 F8 说的门禁子包代差。

## 九、复跑命令（可直接粘）

```sh
# 0) 建独立副本（或用自己的 worktree + npm ci --ignore-scripts --no-audit --no-fund）
#    本报告用的是：D:/主工作区/projects/.tmp-v1-verify-20261108

cd D:/主工作区/projects/.tmp-v1-verify-20261108
npm test                                     # 855/855, exit 0
(cd packages/dsh-gate && npm test)           # 133/133, exit 0
node --test test/client.test.mjs             # 135/135, exit 0
node --test test/update-ui.test.mjs          # 53/53, exit 0
node scripts/ui-audit.mjs                    # 11/11（100 分）
node scripts/render-panel-copy.mjs --check   # 178 行 PASS
node scripts/check-docs.mjs                  # PASS
node scripts/preflight.mjs --fast --no-maintenance   # 41 行 37/2/2，exit 1（两条红见 §5.3）

# 规则 / CLI 独立复跑（临时脚本，不进仓库）
node /tmp/v1-independent-gate.mjs            # 44/44, exit 0

# Chromium（临时副本里把 ASAR/ELECTRON 指向 Desktop-0.2.2-rc.1、REPO 指向副本）
ego-browser nodejs < /tmp/v1-panel-chromium-baseline.mjs   # 47/47, exit 0
ego-browser nodejs < /tmp/v1-panel-chromium-gates.mjs      # 55/55（47+8）, exit 0
```

证据文件（临时，不进仓库）：`/tmp/v1-npm-test.log`、`/tmp/v1-preflight.log`、`/tmp/v1-preflight-full.log`、`/tmp/v1-chromium-baseline.log`、`/tmp/v1-chromium-gates2.log`、`/tmp/v1-independent-gate.mjs`。
