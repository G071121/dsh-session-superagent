# HANDOFF —— 主理鱼 / dsh-gate 会话交接

> **当前快照：2026-11-13（Asia/Shanghai）**，`origin/main` 为 `8da9fd74`（已含 #43 / #44 / #45 / #46）。
> **给新会话直接接手用，不要凭聊天记录重推。** 本文件只记录实测；没跑过的写成「未验证」。

## 0. 当前快照（2026-11-13）

| 项 | 当前事实 |
|---|---|
| main | 以 `origin/main` 为准，2026-11-13 为 `8da9fd74991d0421f2a720f0d79f481bebb60041`；#43 / #44 / #45 / #46 已合入 |
| 版本 | `0.10.12`（**未 bump、未发布新版本**）；npm / tag / Release 仍是 2026-11-09 的 `v0.10.12` |
| 单测 | 根 `npm test` **992/992**（gate 180 / client 191 / drift 22，含 update-ui 53；#46 功能 12 + M1 修复 5） |
| UI / Chromium | UI **11/11（100 分）**；真实 Chromium **72/72**，边界 = **rc.1 安装版前端** `0.2.2-rc.1` + 最终 `client.js` sha256 `0da9bb0702a08a817c33811c7d803440f05495cb24d9c9747da4826e4b40618c`；**不是** rc.2 宿主、**不是**真实 DSH WebView |
| CI | PR #43 / #44 / #45 / #46 的 Node 22/24 均绿；main 的「维护一致性」因运行时改动未 bump **预期红**（发布未做，不要写成 main 全绿） |
| 已合入 | #43（Issue #39 Bug 2：REST 兜底 `per_page=100` + `--paginate` 取最后评论，+4 测试）；#44（保留 @iJetLi PR #42 的 Gitee 前缀修复，维护者 +1 条请求体契约测试）；#45（Issue #35：Orbit 删除确认层 portal 到 body，+1 单测 / +8 Chromium 场景）；#46（页签名称可设置 + M1 干净/脏草稿与 `localStorage.clear` 修复，功能 12 + M1 修复 5 条测试，已复核 resolved） |
| 未合入 | PR #41（@iJetLi，弹层显示「最近唤醒的是哪一条」）已回评，待作者修正文档计数与 `/state` 体积，**未合入未 ack** |
| 未验证 | 真实 DSH WebView、读屏 / 触摸 / IME、真实 Gitee 写操作；rc.2 host-orbit fallback 有 3 项预存失败（旧 client 同样失败，本轮未修）；**#35 portal 场景在 rc.2 上未直达**，不能把 72/72 泛化成 rc.2 / 真实 WebView 通过 |

> **历史基线说明**：下面 §1–§10 写于 **2026-11-09 v6 发布后**，其中「968 例 / `0.10.12` 已发布 /
> 64 条 Chromium」是**当时**的事实，只用于定位合并链与历史闭环；当前工作树以本节为准。

## 1. 一句话现状（2026-11-09 历史基线）

**v6 已发布：主包 `0.10.12` / `@mycf711/dsh-gate@0.1.5`。** PR **#31** 以 merge commit **`ec36ddec`** 发布，
随后 PR #32（回填）/ #33（交接刷新）两个 docs 合并把 main 推前；**main 以 `origin/main` 为准**（本文写就时 `2ba7ada`）。
tag `v0.10.12` / `gate-v0.1.5` 都指向 `ec36ddec` 且可达 main，
npm 双包已发布、GitHub Release `v0.10.12` = Latest、main CI（Node 22/24）绿、
profile 已 `--repair` 到四段全零（只声明磁盘一致）。**没有遗留开发分支待合并。**

## 2. 仓库与版本基线

- GitHub：`MYCF711/dsh-session-superagent`
- 正式 main：**以 `origin/main` 为准**（2026-11-09 写就时 `2ba7ada` = PR #33 交接刷新 merge）；发布 commit = **`ec36ddec`**（PR #31 的 merge，两个 tag 指向它）；回填 merge = `d8359e5`（PR #32）
- npm 实测：主包 **`0.10.12`**、gate **`0.1.5`**（`dist-tags.latest` 两者都是新版本）
- tag：`v0.10.12` / `gate-v0.1.5`（annotated，解引用都是 `ec36ddec`）
- GitHub Release：`v0.10.12`（Latest，标题只写版本号）+ `gate-v0.1.5`
- v6 任务书：`docs/任务书-dsh-gate-v6.md`，提交 `c3753a1`
- **主仓 + 5 个工作树（2026-11-09 整理后）**：
  - 主仓：`D:\DeepSeek Harness\大肥鱼工作区\dsh-session-superagent`（main；HEAD 以 `origin/main` 为准）
  - 当前集成树：`D:\DeepSeek Harness\大肥鱼工作区\dsh-gate-v6-integration`，分支 `task/gate-v6-handoff-refresh-2`（已合并）
  - 其余：`dsh-gate-adapter`（`task/gate-adapter`）、`dsh-gate-core`（`task/gate-core`）、`dsh-session-superagent-deep-ui`（`task/deep-ui-acceptance`，有未提交改动，已备份到 outbox）
- 旧的 `.tmp-issue9-push-20261106-1244` 已迁移为 `dsh-session-superagent`；`dsh-session-superagent-legacy-20261107` 是 11-07 的历史副本（含未提交改动，已备份到 outbox），**不要当最新代码**。

## 3. v6 的三个实现分支（已合并、已发布，不要重做）

| 工作 | 分支 / commit | 已独立复跑 |
|---|---|---|
| C1 锁回收按搬走时间计龄、大小写语义跟随文件系统 | `task/gate-v6-core` @ `133a398` | gate **180/180**，`npm run check` 通过 |
| S1 profile 真原子、lib 缺失与错误分类 | `task/gate-v6-scripts` @ `dfe5a62` | drift **22/22** |
| B1 模型来源场景入正式 Chromium 套件 | `task/gate-v6-browser` @ `fc35b4b` | client、UI 100 分；Chromium **64/64** |

合并链：

```text
2b9bad4  merge C1
f5dc66d  merge S1
628a32a  merge B1
b580681  docs: gate v6 独立验收报告（V1）
33b107c  release: 0.10.12（门禁 v6 锁回收、profile 原子性与模型证据）
ec36ddec Merge pull request #31  ← 发布 merge（两个 tag 指向它）
d8359e5  Merge pull request #32  ← docs 回填
2ba7ada  Merge pull request #33  ← 交接刷新（main 以 origin/main 为准）
9df0fe2  Merge pull request #34  ← main 表述改为 origin/main
```

## 4. 交付链路（全部已完成）

| 步骤 | 结论 | 报告 / 证据 |
|---|---|---|
| V1 独立验收 | 通过；交接项已由 I1 清掉 | `docs/报告-gate-v6验收.md` |
| Q1 核心 / 脚本审查 | **PASS**（blocker 0 / high 0 / medium 0 / low 4 / info 3） | `docs/报告-gate-v6核心审查.md` |
| Q2 浏览器 / 面板审查 | **NEEDS_REVISION**（medium 2）→ 已修 → Q2R 复审 | `docs/报告-gate-v6面板审查.md` |
| 面板修复（t3） | Q2-1 / Q2-2 / Q2-4 已修，Q2-3 定性为「第二道闸门不可达」 | `docs/报告-gate-v6面板修复.md` |
| Q2R 独立复审 | Q2-1 / Q2-2 / Q2-4 resolved；Q2-3 仍 low；R1/R2 新出 | `docs/报告-gate-v6面板复审.md` |
| 收尾修复（t5） | R1/R2 已修（存在性护栏 + 八态去注释状态机），两向变异验证 | `docs/报告-gate-v6收尾修复.md` |
| I1-prep（t6） | 版本 bump + 文档计数 + `check-maintenance` 范围 + 本地提交 `33b107c` | `docs/报告-gate-v6I1-prep.md` |
| 发布（t7） | PR #31 → merge `ec36ddec`；tag / Release / npm / main CI / profile 全绿 | 见 §5 |
| 回填（t8） | PR #32 → merge `d8359e5`（仅 4 份文档）；回填后 main CI `42553248097` success | PR #32 |
| 交接刷新 | PR #33 → merge `2ba7ada`（仅 HANDOFF / MAINTENANCE；main 表述改为「以 origin/main 为准」）；PR CI `42554849882` 双 Node pass | PR #33 |

## 5. 发布后实测计数（2026-11-09 历史基线，跑过才算）

- 根 `npm test`：**968/968**；gate 包：**180/180** + `npm run check`
- `test/client.test.mjs`：**171/171**；`test/sync-profile-drift.test.mjs`：**22/22**；`PANEL_STRICT` 门禁组：**48/48**
- `preflight` 全量：**42 项 = 41 PASS / 1 SKIP**（`smoke:observe` 需真机宿主）
- UI 体检：**11/11（100 分）**；面板文案快照 PASS；`check-docs` 五项 PASS（183 篇）
- 正式 Chromium：**64/64**（安装版前端 `0.2.2-rc.1`、Chromium 156、loopback fixture，**不是**真实 WebView；14 条截图通道 SKIP）
- `check-maintenance`：**6/6**（③ `v0.10.12`、④ `ec36ddec`、⑤ 四处版本一致、⑥ 干净）
- `sync-profile --check`：**缺失 0 / 断链 0 / 陈旧 0 / 门禁子包漂移 0**（只声明磁盘副本一致）
- main CI：发布 run `42551155750`（首次红在「维护一致性」，原因见下，rerun 后绿）；回填后 run `42553248097` 一次 success；PR #33 合并后 docs 刷新触发 main CI（不涉及运行时代码）

## 6. 发布期踩到的一次竞态（已记录，别再踩）

main 上「**先合并、后推 tag**」时，CI 的 `checkout(fetch-depth: 0)` 可能早于 tag 推送 —— runner 本地没有
`v0.10.12`，`check-maintenance` ③④ 必红（v6 首次 main CI 就这样红过一次）。这次靠 `gh run rerun` 转绿。
**根治**：发版顺序改成「tag 先推、再合并 main」，或给 main CI 的该步加一次「tag 未到 → 重试」。
`check-maintenance` 源码注释里记过同型事故（0.9.248）。

## 7. 主理鱼真实运行状态（2026-11-09 历史基线，**未重载宿主**）

GUI：`http://127.0.0.1:51092`（**端口每次重启会变，不要写死**）。发布前后**没有重启 / 重载 DSH**，
所以运行中的仍是 `0.10.11` 的代码；磁盘上（仓库 + 已 `--repair` 的 profile）是 `0.10.12`。
这是预期状态，不是没生效 —— **宿主重载后 profile 运行时是否生效未验**。

## 8. 复跑命令（当前工作树；计数以 §0 实测为准）

```bash
cd "/d/DeepSeek Harness/大肥鱼工作区/dsh-sa-docs"
npm test                                            # 992/992
(cd packages/dsh-gate && npm test && npm run check)  # 180/180 + 语法
node scripts/test.mjs test/client.test.mjs           # 191/191
node scripts/test.mjs test/sync-profile-drift.test.mjs  # 22/22
PANEL_STRICT=1 node scripts/test.mjs --test-name-pattern='门禁' test/client.test.mjs  # 48/48（2026-11-09 快照）
node scripts/preflight.mjs --fast                    # 仅 profile 一致性 1 项环境失败（断链 21，需 --repair）
node scripts/check-maintenance.mjs                   # 5/6；⑥ 因运行时改动未 bump 预期红
node scripts/ui-audit.mjs                            # 11/11 = 100
node scripts/audit-readme-tests.mjs 992              # README 单测数与实测一致
node scripts/sync-profile.mjs --check                # 只读；四段应全零（本轮未重跑）

# 正式 Chromium（loopback fixture，不是 DSH WebView）
REPO_W=$(pwd -W)
{ echo "process.env.DSH_SUPERAGENT_REPO='$REPO_W'"; cat scripts/verify-panel-chromium.mjs; } | ego-browser nodejs
```

## 9. 硬约束

- 禁止重启/关闭 DSH；禁止动 magpie proxy；禁止直接写 `cordis.patch.yml`。
- 团队 `dsh-gate-v6` 已归档（2026-11-09 发布后）；如重建：子代理固定 `group/deepseek-v4.1-flash-1017`、`reasoning_effort=max`、automatic 审批。
- 每个实现分支独立 worktree、同文件单写者；**禁止 `git add -A`**、禁止强推、禁止改别人 PR 分支。
- main 受保护，必须 PR + Node 22/24 两个检查；tag 必须可达 main，不能 squash 脱钩。
- 不向外部仓库发 PR；凭证与本机路径不外泄。
- Chromium fixture ≠ 真实 WebView；真实读屏、触摸、IME、NFS/SMB 锁、真实长期句柄 EPERM 仍未验。
- profile 硬链接会断：切分支/原子替换后可能大批断链，但只能在验收/发布阶段 repair。

## 10. 历史闭环（只作定位，不再重做）

- PR #27/#28：v4 已发布并 ack。
- PR #29/#30：v5 已发布并 ack（main `7846678`）。
- PR #31：**v6 已发布并 ack**（发布 merge `ec36ddec`，0.10.12 / gate 0.1.5）。
- PR #32：v6 发布回填已合并并 ack（`d8359e5`，仅 4 份文档）。
- PR #33：交接刷新已合并并 ack（`2ba7ada`，main 表述改为「以 origin/main 为准」）。
- PR #43：Issue #39 Bug 2 已合入（`927bf70`，REST 兜底 `per_page=100` + `--paginate` 取最后评论）。
- PR #44：保留 @iJetLi PR #42 的 Gitee 前缀修复并合入（`6077e1a`，维护者补 1 条请求体契约测试）。
- PR #45：Issue #35 已合入（`9eb543d`，Orbit 删除确认层 portal 到 body，+1 单测 / +8 Chromium 场景）。
- PR #46：页签名称功能已合入（`8da9fd74`，功能 12 + M1 修复 5；M1 干净/脏草稿与 `localStorage.clear` 已复核 resolved）。
- PR #41：**未合入**（@iJetLi 最近唤醒条目，待作者修正文档计数与 `/state` 体积；不要当已发布）。
- issue #19（awesome-ai-plugins 邀请）：**不处理、不关闭、不回复**。
