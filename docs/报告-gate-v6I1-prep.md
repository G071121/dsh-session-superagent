# gate v6 · I1-prep（发布前收口）报告

> 执行人：releaser（t6）。日期：2026-11-09。
> 工作树：`D:/主工作区/projects/dsh-gate-v6-integration`，分支 `task/gate-v6-integration`，基线 `b580681`。
> 范围：版本 bump、文档计数回填、`check-maintenance` 扫描范围、全量验证、**本地精确提交**。
> **没有 push、没有打 tag、没有 `npm publish`**；未重启 / 未重载 DSH，未动 magpie，未写 `cordis.patch.yml`，
> 真实 profile 只读（`--repair` 留到发布后）。

## 一、结论

1. 版本已 bump 到主包 **`0.10.12`** / 门禁子包 **`@mycf711/dsh-gate@0.1.5`**，五处版本 + 子包版本 +
   依赖 pin **全部一致**（`child_process` 实跑 `check-maintenance` 的 ⑤ 项 PASS 是机器判据，不是肉眼比对）。
2. 文档计数按本轮实测回填：根 **968** / gate **180** / client **171** / drift **22** / `PANEL_STRICT` **48** /
   UI **11/11（100 分）** / 正式 Chromium **64/64** / preflight **42 项**。
3. `check-maintenance` 第⑥项的扫描范围已按 V1 R1 / Q1-7 扩大，并在 `%TEMP%` 的本地 clone 上做了
   「改前假绿 → 改后报红 → 有 tag 时 6/6」三向验证（§五）。
4. 全量命令逐条实跑并贴原文（§六）。**两处红项都是「留到发布步骤」的既有交接项**，不是本轮改动引入：
   - `check-maintenance` **4/6**：③④ 要 `v0.10.12` 这个 tag 存在，而任务书禁止打 tag；
   - `preflight` 全量 **2 FAIL**：`维护一致性`（同上）+ `profile 一致性`（断链 21 / 门禁子包漂移 1，
     `--repair` 按任务书留到发布后）。
5. 本地已精确提交（逐文件 `git add`，**没有 `git add -A`**），提交后工作树干净（§七）。

## 二、改动清单

| 文件 | 改动 |
|---|---|
| `package.json` | `version` `0.10.11` → `0.10.12`；`dependencies["@mycf711/dsh-gate"]` `0.1.4` → `0.1.5` |
| `package-lock.json` | 根 `version`、`packages[""].version`、`packages[""].dependencies` 里的 gate pin、`packages/dsh-gate.version` 四处 |
| `lib/index.js` | `SERVER_VERSION = '0.10.12'`（仅此一行） |
| `client.js` | `CLIENT_VERSION = '0.10.12'`（仅此一行，`git diff` 可证） |
| `packages/dsh-gate/package.json` | `version` `0.1.5` |
| `packages/dsh-gate/lib/index.js` | `PACKAGE_VERSION = '0.1.5'`（`gate.version` 的来源，测试守着；任务书清单没列，但不改就与 `package.json` 不一致） |
| `packages/dsh-gate/test/default-config.test.mjs` | `pkg.version` 断言 → `0.1.5` |
| `packages/dsh-gate/test/gate-provider.test.mjs` | `gate.version` 断言 → `0.1.5` |
| `README.md` | 徽章 `version-0.10.12-green.svg`；§验证 → `968 项单测…（0.10.12）` |
| `AGENTS.md` | §十 当前基线 → `0.10.12；968/968、preflight 42 项 = 41 PASS / 1 SKIP、UI 11/11、真实 Chromium 64/64`；§六 命令注释 `41 项门禁` → `42 项门禁`（原来那行本身就是错的） |
| `MAINTENANCE.md` | §一 当前版本、§二 分支/版本/工作区、资产表、已验证、未验证（v5 L1–L5 换成 v6 的 Q1-1~Q1-4 / Q2-3 / R1-R2 已修）、§三 下一步 |
| `CHANGELOG.md` | 新增 `## [0.10.12] - 2026-11-09` 一节（C1 / S1 / B1 / Q1 / Q2 / 验证 / 未验 / low 残余） |
| `HANDOFF.md` | 全篇更新为「v6 已本地集成、待发布」，含审查链路最终状态、实测计数、t7 发布步骤 |
| `scripts/check-maintenance.mjs` | 第⑥项扫描范围扩到 `lib/ client.js packages/dsh-gate/{lib,bin,gates} scripts/`，detail 带文件名 |
| `test/client.test.mjs` | **上一棒（t3 / Q2R / t5）遗留的工作区改动**，本轮未改，随本次提交一起入库 |
| `scripts/verify-panel-chromium.mjs` | 同上（t3 的 Q2-1 / Q2-2 / Q2-4 修复） |
| `scripts/gate-model-scenarios.mjs` | 同上（t3 新建，17 条场景唯一真源） |
| `docs/报告-gate-v6{核心审查,面板审查,面板修复,面板复审,收尾修复}.md` | 前几棒的产物，本轮未改，随提交入库 |
| `docs/报告-gate-v6I1-prep.md` | 本文件 |

**`client.js` 除 `CLIENT_VERSION` 一行外零改动**（产品逻辑沿用 v6 结论：sha256 从 `c6fe935d…` 变成
`d58f0fa2…` 只反映版本字符串这一行；Chromium 套件复跑 64/64 佐证）。

## 三、版本一致性（实测原文）

```bash
$ grep -n '"version"' package.json packages/dsh-gate/package.json
package.json:3:  "version": "0.10.12",
packages/dsh-gate/package.json:3:  "version": "0.1.5",

$ grep -n "SERVER_VERSION = |CLIENT_VERSION = |PACKAGE_VERSION = " lib/index.js client.js packages/dsh-gate/lib/index.js
lib/index.js:58:export const SERVER_VERSION = '0.10.12'
client.js:425:    const CLIENT_VERSION = '0.10.12'
packages/dsh-gate/lib/index.js:78:export const PACKAGE_VERSION = '0.1.5'

$ grep -n "version-0.10" README.md
13:  …badge/version-0.10.12-green.svg…

$ grep -n "@mycf711/dsh-gate\"" package.json package-lock.json
package.json:111:    "@mycf711/dsh-gate": "0.1.5"
package-lock.json:16:        "@mycf711/dsh-gate": "0.1.5"
```

机器判据（`check-maintenance` ⑤）：

```
PASS README 徽章 / lib / client 版本一致  package=0.10.12 badge=0.10.12 server=0.10.12 client=0.10.12
```

`preflight` 也有一条独立判据：

```
PASS 版本一致（4 处）  0.10.12 / client 0.10.12 / badge 0.10.12 / changelog 0.10.12
```

## 四、文档回填（数字来源）

| 文档 | 写什么 | 依据 |
|---|---|---|
| `README.md` §验证 | `968 项单测、42 项 preflight、11 项 UI、64 项 Chromium（0.10.12）；除「发布步骤才做的两条」（打 tag、profile --repair）外全绿` | 本轮实跑（§六），且 `audit-readme-tests.mjs 968` → `PASS README 单测数  README 写 968，实际 968`。**没有沿用旧的「全绿」措辞** —— preflight 现在确有 2 条发布步骤才收的红 |
| `AGENTS.md` §十 | `0.10.12；全量 968/968、preflight 42 项（发布前 39 PASS / 1 SKIP / 2 FAIL）、UI 11/11、真实 Chromium 64/64` | 同上 |
| `MAINTENANCE.md` §二 | 资产表 + 已验证 + 未验证 | 同上；`docs/kb` 183 篇由 `check-docs.mjs` 实测；`scripts/` 68 个由 `ls scripts/*.mjs | wc -l` 实测；GitHub Release 326 个由 `gh release list` 实测；Node 22 未验（本机 Node 24.20） |
| `MAINTENANCE.md` 未验证清单 | 换掉 v5 的 L1–L5（Q1 报告 §五逐条验证已被 C1/S1 收掉），改写为 v6 的 Q1-1~Q1-4（low 未修）、Q2-3（low，`client.js:2523` / `:2530` 不可达）、R1/R2（t5 已修） | `docs/报告-gate-v6核心审查.md` §五/§七、`docs/报告-gate-v6面板复审.md` §3.3、`docs/报告-gate-v6收尾修复.md` |
| `CHANGELOG.md` | 新增 `## [0.10.12]`，含 C1/S1/B1 行为、Q1/Q2 发现与修复、实测计数、**未验项**、**low 残余** | 各报告 + 本轮实跑 |
| `HANDOFF.md` | 「已集成、待发布」 | 本轮状态 |

## 五、`check-maintenance` 扫描范围（V1 R1 / Q1-7）

改的是第⑥项：`git diff <tag>..HEAD -- lib/ client.js` → 加上
`packages/dsh-gate/lib/`、`packages/dsh-gate/bin/`、`packages/dsh-gate/gates/`、`scripts/`，
并在 detail 里点名文件（最多 5 个）。

**真仓库里跑（version 已 bump、tag 还没打）**：

```
$ node scripts/check-maintenance.mjs
PASS CHANGELOG 有当前版本小节  0.10.12
PASS CHANGELOG 最新小节 = 当前版本  最新是 0.10.12，package.json 是 0.10.12
FAIL 当前版本有 git tag  缺 v0.10.12（跑 node scripts/release-gh.mjs --latest）
FAIL tag 指向已提交的 commit  解析不出 commit
PASS README 徽章 / lib / client 版本一致  package=0.10.12 badge=0.10.12 server=0.10.12 client=0.10.12
PASS 自上个 tag 起未改动运行时代码（未 bump 不算错，只提示）  干净（已扫 lib/ client.js packages/dsh-gate/{lib,bin,gates} scripts/）

2 项不一致 —— 版本没真正发出去，用户拿不到新版
[EXIT: 1]
```

③④ 红是「还没打 tag」（本轮明确不打，`check-maintenance` 就是用来问这件事的）；
⑤（版本一致）与 ⑥（本轮改的那一项）都 PASS。

**三向验证（`%TEMP%` 里的本地 clone；用 `tar` 复制工作树 + `git init` + 一次 snapshot commit，**
**不碰真仓库、不打真 tag；跑完已删）**：

| 场景 | 命令 | 结果 | 退出码 |
|---|---|---|---|
| A 有 tag | `git tag v0.10.12` 后 `node scripts/check-maintenance.mjs` | **6 项通过**（含 ③ `v0.10.12`、④ `d2ca41ff`） | **0** |
| B tag 后改子包运行时 | 追加一行到 `packages/dsh-gate/lib/config-lock.js` 并提交 | ⑥ 红：`1 个文件已改，尚未 bump 版本：packages/dsh-gate/lib/config-lock.js` | **1** |
| C 同一状态跑**改前**版本（`b580681` 的 `check-maintenance`） | 只扫 `lib/ client.js` | ⑥ **假绿「干净」，6 项通过** —— 正是 V1 R1 的形状 | **0** |
| D 同一状态跑**本版** | 扫 `lib/ client.js packages/dsh-gate/{lib,bin,gates} scripts/` | ⑥ 红：`2 个文件已改，尚未 bump 版本：packages/dsh-gate/lib/config-lock.js / scripts/preflight.mjs` | **1** |

A 原文（tag 一到位就 6/6）：

```
PASS 当前版本有 git tag  v0.10.12（本地有、远端没有 —— 先 git push origin v0.10.12）
PASS tag 指向已提交的 commit  d2ca41ff
PASS 自上个 tag 起未改动运行时代码（未 bump 不算错，只提示）  干净（已扫 lib/ client.js packages/dsh-gate/{lib,bin,gates} scripts/）

维护一致性：6 项通过
[A_EXIT: 0]
```

C 原文（改前版本在同一状态下的假绿）：

```
PASS 自上个 tag 起未改动运行时代码（未 bump 不算错，只提示）  干净

维护一致性：6 项通过
[BEFORE_EXIT: 0]
```

## 六、全量验证（原始输出 + 退出码）

| # | 命令 | 结果 | 退出码 |
|---|---|---|---|
| 1 | `npm test`（根） | `ℹ tests 968 / pass 968 / fail 0`，47.5 s | **0** |
| 2 | `cd packages/dsh-gate && npm test` | `ℹ tests 180 / pass 180 / fail 0`，48.2 s | **0** |
| 3 | `cd packages/dsh-gate && npm run check` | `> @mycf711/dsh-gate@0.1.5 check` 五个文件 `node --check` 通过 | **0** |
| 4 | `node scripts/test.mjs test/client.test.mjs` | `ℹ tests 171 / pass 171 / fail 0` | **0** |
| 5 | `node scripts/test.mjs test/sync-profile-drift.test.mjs` | `ℹ tests 22 / pass 22 / fail 0` | **0** |
| 6 | `PANEL_STRICT=1 … --test-name-pattern='门禁' test/client.test.mjs` | `ℹ tests 48 / pass 48 / fail 0` | **0** |
| 7 | `node scripts/preflight.mjs`（全量） | **42 项 = 39 PASS / 1 SKIP / 2 FAIL**（`profile 一致性`、`维护一致性`） | **1** |
| 8 | `node scripts/preflight.mjs --no-maintenance` | **42 项 = 39 PASS / 2 SKIP / 1 FAIL**（只剩 `profile 一致性`；两个 SKIP 是 `smoke:observe` 与 `维护一致性`） | **1** |
| 9 | `node scripts/check-maintenance.mjs` | **4/6**（①②⑤⑥ PASS，③④ 缺 tag） | **1** |
| 10 | `node scripts/ui-audit.mjs` | `UI 体检：11/11 通过（100 分）` | **0** |
| 11 | `node scripts/render-panel-copy.mjs --check` | `PASS 面板文案与当前实现一致（178 行；最长 77 字符；超 80 字符 0 条（上限 3））` | **0** |
| 12 | `node scripts/audit-readme-tests.mjs 968` | `PASS README 单测数  README 写 968，实际 968` | **0** |
| 13 | 正式 Chromium（`ego-browser nodejs`，注入 `DSH_SUPERAGENT_REPO`） | `passed 64 / failed 0 / total 64`，`exitCode 0`，17 条场景全命中，截图通道 14 SKIP | **0**（管道 0） |
| 14 | `npm pack --dry-run` | `dsh-session-superagent@0.10.12`，**30 个文件**，1.7 MB（tarball）/ 2.5 MB（解包） | **0** |
| 15 | `node scripts/sync-profile.mjs --check`（**只读**） | `缺失 0 / 断链 21 / 陈旧 0 / 门禁子包漂移 1` | **1**（预期，`--repair` 留发布后） |
| 16 | `node scripts/check-docs.mjs` | 五项 PASS（含 `索引总数与板块合计一致（183 篇）`） | **0** |

Chromium 的 `SUMMARY` 原文：

```json
SUMMARY {
  "passed": 64,
  "failed": 0,
  "total": 64,
  "chromium": "156.0.8078.74",
  "repoVersion": "0.10.12",
  "clientSha256": "d58f0fa2137547ca18426291349f20931ef5e01d7abc3d23bdcd3bf91d44b5e4",
  "scriptSha256": "af84b443f14b9e2e83acea77cfc91b939b6223cd8cc61d5dace0a8a34f65c28a",
  "frontendVersion": "0.2.2-rc.1",
  "asarSha256": "5fa8a6b21bceb8f3e99e30efa2270efd0cc773a11e42aa0488f804a64b34e637",
  "exitCode": 0,
```

命中的场景 id：`U1-V0 U1-V1 U1-V2 U1-V3 U1-V4 U1-V5 U1-V6 U5-V0 U5-V1 U5-V2 U5-V2b U5-V3a U5-V3b U5-V4 U5-V5 U5-V6a U5-V6b`（17 条）。

`preflight` 全量的红项原文：

```
FAIL profile 一致性 --check               缺失 0 / 断链 21 / 陈旧 0 / 门禁子包漂移 1（lib/config-lock.js, lib/index.js, package.json），跑 node scripts/sync-profile.mjs --repair
SKIP 冒烟 smoke:observe              需要真机宿主（已列进攒批清单）
FAIL 维护一致性                             不一致：当前版本有 git tag；tag 指向已提交的 commit
---
2 项失败
[PREFLIGHT_FULL_EXIT: 1]
```

`--no-maintenance` 的结尾原文：

```
SKIP 冒烟 smoke:observe              需要真机宿主（已列进攒批清单）
SKIP 维护一致性                        --no-maintenance 跳过（PR 分支还没打 tag）
---
1 项失败
[PREFLIGHT_NOM_EXIT: 1]
```

**两处红都不是本轮改动引入**：`profile 一致性`是「profile 硬链指向另一个 worktree + 子包内容未同步」的副本现象
（V1 §3.3 已三次复现并证明 `--repair` 可修到四段全零），任务书把 `--repair` 留给发布后；
`维护一致性`就是「还没打 tag」。**没有一条红来自版本、文档或 ⑥ 的改动。**

## 七、精确提交

`git add` 的文件是逐个点名的（**没有 `git add -A`**）：

```text
package.json  package-lock.json  lib/index.js  client.js
packages/dsh-gate/package.json  packages/dsh-gate/lib/index.js
packages/dsh-gate/test/default-config.test.mjs  packages/dsh-gate/test/gate-provider.test.mjs
README.md  AGENTS.md  MAINTENANCE.md  CHANGELOG.md  HANDOFF.md
scripts/check-maintenance.mjs  scripts/verify-panel-chromium.mjs  scripts/gate-model-scenarios.mjs
test/client.test.mjs
docs/报告-gate-v6核心审查.md  docs/报告-gate-v6面板审查.md  docs/报告-gate-v6面板修复.md
docs/报告-gate-v6面板复审.md  docs/报告-gate-v6收尾修复.md  docs/报告-gate-v6I1-prep.md
```

提交信息：`release: 0.10.12（门禁 v6 锁回收、profile 原子性与模型证据）`。
提交后工作树干净；**未 push、未打 tag、未 publish**。

## 八、与任务书的两处口径偏差（已由 captain 确认）

| 验收写法 | 实际 | 原因 | 处置 |
|---|---|---|---|
| `check-maintenance` **6/6 绿** | **4/6**（①②⑤⑥ PASS） | ③④ 是「当前版本有本地 tag」+「tag 指向已提交 commit」，打了 tag 才可能绿；任务书同时禁止打 tag | 按 captain 口径：不打 tag、如实报 4/6，并**在 `%TEMP%` clone 里打 tag 证明 6/6**（§五 A），t7 打 tag 后再复跑到 6/6 |
| 全量验证命令**全部 exit 0** | `preflight` 两种口径都 exit 1；`check-maintenance` exit 1；`sync-profile --check` exit 1 | 三条红分别来自「没打 tag」「profile 未 repair（任务书留到发布后）」，**没有一条来自本轮改动** | 逐条贴原文 + 归因（§六）；其余 12 条命令全部 exit 0 |

## 九、未验 / 边界（不宣称）

- **不是真机 WebView**：Chromium 段是「安装版前端 `0.2.2-rc.1` + loopback fixture + 仓库里真实 `client.js`」；
  真实读屏 / 触摸 / IME、真实宿主重载后的行为**未验**（本轮不重启 DSH）。
- **profile 只声明磁盘副本一致性的「差」**：本轮只跑只读 `--check`（缺失 0 / 断链 21 / 陈旧 0 / 漂移 1），
  **没有** `--repair`，也不声明宿主运行时生效。
- **跨主机共享盘（NFS/SMB）**锁与 mtime 语义、真实长期句柄下的 `rename` `EPERM`：未验（沿用 v6 结论）。
- **CI 矩阵 Node 22**：本机只有 Node 24.20，未在 22 上实跑。
- **没有发布**：`npm publish` / `git tag` / `git push` / GitHub Release 一件没做；这些是 t7 的动作。
- v6 的 low 残余（Q1-1~Q1-4、Q2-3）与两条 info（Q1-5/Q1-6）、Q2R 的 R3/R4/R5 **本轮未处理**（不在写作用域），
  已在 `MAINTENANCE.md` 与 `CHANGELOG.md` 如实登记。
