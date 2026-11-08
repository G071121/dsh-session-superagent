# gate v2 核心与发布阻断第二轮复审（Q1R）

> 审查人：reviewer（Q1R）。日期：2026-11-08。角色：严格审查专员（只读源码）。
> 被审对象：U2（语义/extends 面板修复）+ R2（profile 假绿、Chromium 路径、发布计数、任务书）之后的**最新成品**。
> 需求来源：`docs/任务书-dsh-gate-v2.md`；Q1 报告 `docs/报告-gate-v2核心审查.md`；Q2/Q2R 报告。
> 本文件是 Q1R 唯一写权限范围内的产物；源码 / 测试 / 脚本**零改动**。
>
> **结论：verdict = pass（可进 I1）。** 四条 Q1 阻断（F1/F2/F3/F4）全部独立复现并闭合；
> 新增 1 条 medium（`gates/default.json` 未纳入指纹，latent 假绿）+ 5 条 low，**I1 发布前必须处理 M1 与 L1**。

---

## 一、判定表

| 原编号 | 严重度 | 问题 | Q1R 状态 | 独立证据 |
|---|---|---|---|---|
| Q1-F1 | blocker | `sync-profile` 对门禁子包只比 `package.json`，`--check` 假绿、`--repair` 不替换 | ✅ 闭合 | §三 四步对照 + 真实 profile + 隔离实验 |
| Q1-F2 | high | 面板保存丢本层 `semantic`（对象/`false`），项目层误发模型 | ✅ 闭合 | §四 服务端 5/5 + 面板 25/25 + 仓库用例 |
| Q1-F3 | high | 面板保存丢 `extends`，共享规则静默消失 | ✅ 闭合 | §五 面板拒绝保存 + 真实磁盘 + 服务端反证 |
| Q1-F4 | high | README/任务书计数与真实测试不一致，preflight 红 | ✅ 闭合 | §六 869/133/142/53/11/178/42 实跑 |
| **Q1R-M1** | **medium** | **`gates/default.json`（运行时默认规则）未纳入门禁子包指纹 → 只改默认规则时 `--check` 仍假绿** | ❌ 未闭合（I1 发布前必须补） | §三.3 隔离实验：只改 `default.json` → `0/0/0/0` exit 0，文件不同 |
| Q1R-L1 | low | 真实 profile 仍是旧实现（断链 18 + 门禁子包漂移 1），`--check` 已正确报红；`--repair` 属 I1 发布步骤 | ⏳ 待 I1 | §三.2 |
| Q1R-L2 | low | preflight 的 profile 行只解析「缺失/断链/陈旧」三段，看不到第四段「门禁子包漂移」字样（靠併入陈旧保证不假绿） | ⏳ 文档/后续 | §六 |
| Q1R-L3 | low | 主插件 `TARGETS` 是固定文件清单；未来新增 `lib/*.js` 不会自动进 profile（pre-existing） | ⏳ 后续 | §三.1 代码审阅 |
| Q1R-L4 | low | 直接调 `writeGateConfig` 仍会丢 `extends`（面板已拒绝保存；服务端 API 没有第二道守卫） | ⏳ 文档/后续 | §五 反证 |
| Q1R-L5 | low | Chromium 47/47 是 R2 的证据；Q1R 只独立验了路径解析（`--print-paths`），未重跑完整浏览器套件 | ⏳ 未验 | §六 |

---

## 二、被审快照与环境

| 项 | 值 |
|---|---|
| HEAD | `fb883b6747d1421922bfc5a4ca16cc740465c80e`（R2 提交：profile 内容判定 + Chromium 路径 + 发布计数） |
| 未提交（U2/C1/R2 工作树） | `client.js` `a4559cfd…434c21`；`test/client.test.mjs` `06f524b1…05db`；`packages/dsh-gate/lib/index.js` `e7d51471…3ac0`；`bin/gate.mjs` `0c89804a…6cd0`；`scripts/sync-profile.mjs` `e59dfc4c…438f`；`scripts/verify-panel-chromium.mjs` `b065c6d0…e173`；`README.md` `96a2617b…a7aa`；`docs/任务书-dsh-gate-v2.md` `4c18cad6…83e3` |
| 运行时 | Node v24.20.0，Windows；Chromium 安装 `D:/DeepSeek Harness/Desktop-0.2.2-rc.1` |
| 只读声明 | 除本报告外未改任何文件；所有临时实验都在 `D:/主工作区/projects/.tmp-q1r-*` 并已删除 |
| 独立性 | 另写 `/tmp/q1r-gate-probe.mjs`（服务端 5 项）、复用 `/tmp/q2r-probe.mjs`（面板 25 项）；四步/隔离实验全部自建临时副本，旧脚本取自 `git show fb883b6^:scripts/sync-profile.mjs` |

---

## 三、Q1-F1 独立复现：profile 门禁子包按内容判定

### 3.1 四步对照（自建同卷临时 DEST + 旧 profile 门禁副本）

```text
DEST = tmp-q1r-dest-3079（主插件文件从仓库硬链接；gate 目录复制真实 profile 的旧 lib）
旧脚本（fb883b6^）--check --dir DEST
  缺失 0 / 断链 0 / 陈旧 0            exit 0   ← 假绿（DEST gate lib 的 enabled 语义 grep = 0）
新脚本 --check --dir DEST
  缺失 0 / 断链 0 / 陈旧 1 / 门禁子包漂移 1   exit 1   ← 正确报红
新脚本 --repair --dir DEST
  recopied node_modules/@mycf711/dsh-gate     exit 0
新脚本 --check --dir DEST
  缺失 0 / 断链 0 / 陈旧 0 / 门禁子包漂移 0   exit 0
  DEST gate lib grep "typeof rule.enabled === 'boolean'" = 1
  sha256 package.json 8de9bd73… / lib/index.js e7d51471… / bin/gate.mjs 0c89804a… 与仓库三份逐一相同
```

### 3.2 真实 profile 只读复核（不修，只报）

```text
$ node scripts/sync-profile.mjs --check
缺失 0 / 断链 18 / 陈旧 1 / 门禁子包漂移 1   exit 1
profile 与仓库不一致（跑 --repair 修）
```

- 真实 profile 的 gate `lib/index.js` 仍是旧实现（`grep` = **0**，仓库 = 1）→ 真机仍跑旧实现。
- 真实 profile 的 `gates/default.json` 与仓库**一致**（`cmp` 无差异）→ 本次发布内容没有默认规则漂移。
- **I1 发布前必须**：`node scripts/sync-profile.mjs --repair` → 再 `--check` 四段全零，并复验 profile 里 `grep … = 1`。**不得**在报告里写「运行时已生效」——磁盘副本一致 ≠ 宿主已重载（未重启 DSH）。

### 3.3 Q1R-M1（medium）：`gates/default.json` 未纳入指纹（可复现的假绿）

隔离实验（同卷临时仓库副本 + 临时 DEST，仓库文件未动）：

```text
BEFORE（完全一致）              --check → 缺失 0 / 断链 0 / 陈旧 0 / 门禁子包漂移 0   exit 0
只改 OLD 的 gates/default.json  --check → 缺失 0 / 断链 0 / 陈旧 0 / 门禁子包漂移 0   exit 0  ← 假绿
（两份 default.json 已确认不同；仓库原文件 git diff 为空）
```

- 根因：`scripts/sync-profile.mjs` 的 `GATE_RUNTIME_FILES = ['package.json']`、`GATE_RUNTIME_DIRS = [lib/*.js, bin/*.mjs]`，**不包含 `gates/**/*.json`**；而 `packages/dsh-gate/lib/index.js:66` 的 `DEFAULT_GATE_PATH = join(PACKAGE_ROOT, 'gates', 'default.json')` 说明它是运行时默认规则（默认层 10 条）。
- 影响：将来只改默认规则、没 bump `package.json` 时，`--check` 仍绿、`--repair` 不替换 → 用户看到旧默认规则（与 Q1-F1 同类假绿）。本次 0.10.8 的 `default.json` 未变，发布内容不受影响，属 latent。
- 修复要求（I1，一行）：把 `gates/**/*.json` 加入指纹（或 `GATE_RUNTIME_FILES` 加 `gates/default.json`），补一条「只改 default.json 必须报漂移」的用例；修完复跑 `--check` 与 `--repair`。

---

## 四、Q1-F2 独立复现：semantic 不丢、项目不再误发模型

### 4.1 服务端（gate 包，`/tmp/q1r-gate-probe.mjs`，5/5 exit 0）

| 项 | 结果 |
|---|---|
| S1 用户层 semantic 完整对象（enabled/baseURL/model/mode/timeoutMs/maxInputChars/prompt）写盘→读回 | 逐字段相同；磁盘 JSON deepEqual |
| S2 用户层 `semantic:false` 写盘→读回 | 归一化为 `{enabled:false}`（语义等价），`loadGateConfig` 后 `enabled=false` |
| S3 项目层 `semantic:false` 覆盖用户层 `enabled:true` | 合并值 `false`；`createGate(merge)` **模型请求 0 次**；删掉项目覆盖后**正对照 1 次** |
| S4 规则停用写盘/读回 | `enabled:false` 保留；`lintText` 放行；复启后拦截 |
| S5 extends 读盘 | `shared-secret/shared-path/proj-only` 全在；磁盘文件字节未变 |

### 4.2 面板（`/tmp/q2r-probe.mjs`，25/25 exit 0）

- 只切规则保存 → POST `semantic` 整块 deepEqual 原对象；只改 `enabled` → 保留 `baseURL/mode/timeoutMs/maxInputChars`；用户/项目 `false` 字面量原样保留；项目取消关闭不写 `semantic`；勾选关闭写 `false`。
- 项目 `semantic:false`：关闭开关 `aria-checked=true`、底部只出现「当前关闭」、预览 POST `semantic=false`、预览区「这类触发支持语义复审（当前关闭）」。
- 仓库用例 `test/client.test.mjs:3753/3811/3854/3980` 覆盖同一行为（142/142 绿）。

---

## 五、Q1-F3 独立复现：extends 共享规则不消失

- 面板（`/tmp/q2r-probe.mjs` B1–B3）：本层 `extends` 时「保存」`disabled=true`；直接调用保存守卫**不发 POST**；`role=alert` 给「这一层用了 extends…请直接改配置文件：<路径>」；无 extends 正对照可保存并 POST。
- 真实磁盘（仓库用例 `:3907`）：保存被拒后，`shared.json` 的 `secret/abs-path` 与项目层 `proj-only` 都在，磁盘 `extends` 仍是 `./shared.json`。
- 服务端反证（S5）：直接 `writeGateConfig` 仍会丢 `extends`（写盘后 `extends=undefined`）——所以面板的「拒绝保存」是必要守卫；Q1R-L4 记录「服务端 API 没有第二道守卫」的事实。

---

## 六、Q1-F4 独立复现：计数与发布门禁

```text
$ npm test
ℹ tests 869 / ℹ pass 869 / ℹ fail 0 / duration_ms 22701.78 / exit 0
$ cd packages/dsh-gate && npm test
ℹ tests 133 / ℹ pass 133 / ℹ fail 0 / duration_ms 3023.35 / exit 0
$ node --test test/client.test.mjs
ℹ tests 142 / ℹ pass 142 / ℹ fail 0 / duration_ms 685.69 / exit 0
$ node --test test/update-ui.test.mjs
ℹ tests 53 / ℹ pass 53 / ℹ fail 0 / duration_ms 284.08 / exit 0
$ node scripts/ui-audit.mjs
UI 体检：11/11 通过（100 分）
$ node scripts/render-panel-copy.mjs --check
PASS 面板文案与当前实现一致（178 行；最长 77 字符；超过 80 字符的 0 条）
$ node scripts/check-docs.mjs
PASS 索引总数与板块合计一致（183 篇）
$ node scripts/check-maintenance.mjs
维护一致性：6 项通过
$ node scripts/audit-readme-tests.mjs 869
PASS README 单测数  README 写 869，实际 869
$ node scripts/preflight.mjs --fast --no-maintenance
41 项 = 38 PASS / 1 FAIL / 2 SKIP，exit 1
  FAIL profile 一致性 --check  缺失 0 / 断链 18 / 陈旧 1（唯一的红，I1 --repair 后清）
$ node scripts/preflight.mjs
42 项 = 40 PASS / 1 FAIL / 1 SKIP，exit 1
  PASS 门禁自检  21/21 项注入都被检测到（26/42 项有注入）
  FAIL profile 一致性 --check  缺失 0 / 断链 18 / 陈旧 1
$ node scripts/verify-panel-chromium.mjs --print-paths
{"installRoot":"D:\\DeepSeek Harness\\Desktop-0.2.2-rc.1","source":"scan:…（2 个候选取 mtime 最新）",…}  exit 0
```

- `README.md:147` = 「869 项单测、42 项 preflight、11 项 UI、47 项 Chromium 全绿（0.10.6）」；任务书 §1.3 实跑记录 = 869/133，preflight 41 项 = 38/1/2、全量 42 项 —— **与真实计数一致**，无 824/106 残留。
- preflight 唯一红是真实 profile（I1 发布步骤）；`门禁自检` 21/21 通过。
- 任务书 §六 仍写「目标版本 0.10.6 的下一 patch」——I1 发布时按 main 现状（0.10.7，`e68da40`）定 **0.10.8**（Q1-F6 遗留，属发布计划）。

---

## 七、发现（findings）

### Q1R-M1 · medium · `gates/default.json` 未纳入门禁子包指纹（latent 假绿）

- 位置：`scripts/sync-profile.mjs` 的 `GATE_RUNTIME_DIRS`（第 94 行）/ `GATE_RUNTIME_FILES`（第 98 行）；运行时依据 `packages/dsh-gate/lib/index.js:66`。
- 证据：隔离实验「只改 `gates/default.json`」→ `--check` 仍 `0/0/0/0` exit 0，两份文件已不同（§三.3）。
- 影响：将来只改默认规则（默认层 10 条）而不 bump 版本时，profile 不替换、检查仍绿；与 Q1-F1 同类假绿，但本次发布内容未变（latent）。
- 修复要求（I1）：把 `gates/**/*.json` 纳入指纹，补「改 default.json 必须报漂移」用例；修完复跑 `--check`（真实 profile 待 `--repair` 后全零）。

### Q1R-L1 · low · 真实 profile 仍是旧实现

- `--check` 已正确报 `断链 18 / 门禁子包漂移 1` exit 1；profile 的 gate `lib/index.js` grep = 0。I1 必须 `--repair` 并复验 grep = 1；未重载宿主前不得声称「运行时已生效」。

### Q1R-L2 · low · preflight 看不到第四段「门禁子包漂移」

- `scripts/preflight.mjs` 只解析「缺失 / 断链 / 陈旧」三段；靠「漂移併入陈旧」保证不假绿。`preflight.mjs` 不在本次允许路径内，建议 I1 补第四段正则。

### Q1R-L3 · low · 主插件 `TARGETS` 是固定文件清单

- 未来新增 `lib/*.js` 需要手工加进 `TARGETS`（pre-existing）。门禁子包已递归；主插件建议同样按目录遍历。

### Q1R-L4 · low · `writeGateConfig` 直调仍丢 `extends`

- 面板已拒绝保存（必要守卫）；服务端 API 没有第二道守卫。建议在 `writeGateConfig` 里对 `input.extends` 显式报错，或文档写明「不要绕过面板」。

### Q1R-L5 · low · Chromium 47/47 未独立重跑

- Q1R 只验了 `--print-paths`（当前安装 `Desktop-0.2.2-rc.1`，exit 0）。47/47 是 R2 的证据；真实宿主渲染/键盘仍未独立复核。

---

## 八、未验项（不许写成通过）

1. **真实 profile `--repair` 后的运行时效果**：未执行（I1 发布步骤），未重启 DSH；「磁盘副本一致 ≠ 运行时已生效」。
2. **真实 DSH WebView / 宿主重载**：未做。
3. **Chromium 完整套件**：未在 Q1R 重跑（R2 47/47 证据；Q1R 只做路径解析）。
4. **真实 GitHub/Gitee 写、真实模型调用**：本轮不做。
5. **`gates/default.json` 指纹修复后的复验**：待 I1 修 M1 后复跑。

---

## 九、复跑命令

```sh
cd D:/主工作区/projects/.tmp-issue9-push-20261106-1244

npm test                                            # 869/869, exit 0
(cd packages/dsh-gate && npm test)                  # 133/133, exit 0
node --test test/client.test.mjs                    # 142/142, exit 0
node --test test/update-ui.test.mjs                 # 53/53, exit 0
node scripts/ui-audit.mjs                           # 11/11（100 分）
node scripts/render-panel-copy.mjs --check          # 178 行 PASS
node scripts/check-docs.mjs                         # PASS（183 篇）
node scripts/check-maintenance.mjs                  # 6/6, exit 0
node scripts/audit-readme-tests.mjs 869             # PASS
node scripts/preflight.mjs --fast --no-maintenance  # 41 项 38/1/2, exit 1（profile）
node scripts/preflight.mjs                          # 42 项 40/1/1, exit 1（profile）

# Q1-F1：旧/新脚本四步 + 真实 profile（只读）
node scripts/sync-profile.mjs --check               # 缺失 0 / 断链 18 / 陈旧 1 / 门禁子包漂移 1, exit 1
# 临时 DEST 四步与 gates/default.json 隔离实验见 §三（脚本已清理）

# 独立探针（临时证据，不进仓库）
node /tmp/q1r-gate-probe.mjs                        # 服务端 5/5
node /tmp/q2r-probe.mjs                             # 面板 25/25（G1/H1/H2 低优先观察）
node scripts/verify-panel-chromium.mjs --print-paths # 当前安装 0.2.2-rc.1, exit 0
```
