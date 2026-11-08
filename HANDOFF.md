# HANDOFF —— 主理鱼 / dsh-gate 会话交接

> 快照时间：2026-11-09（Asia/Shanghai），gate v6 集成树 I1-prep 收口后。**给新会话直接接手用，不要凭聊天记录重推。**
> 本文件只记录当次实测；后续状态可能变化，先复核再动作。

## 1. 一句话现状

**v6 已在独立集成树 `D:\主工作区\projects\dsh-gate-v6-integration`（分支 `task/gate-v6-integration`）本地集成完毕并提交，版本已 bump 到主包 `0.10.12` / `@mycf711/dsh-gate@0.1.5`，但还没发布**：没有 push、没有 tag、没有 `npm publish`。V1 验收 → Q1 核心/脚本审查（PASS）→ Q2 浏览器/面板审查（NEEDS_REVISION：2 medium）→ 面板修复 → Q2R 独立复审 → 收尾修复 R1/R2 → I1-prep（版本 + 文档 + check-maintenance 范围 + 全量验证 + 本地提交）全部走完。**下一步是 t7 的发布，必须等用户确认。**

## 2. 仓库与版本基线

- GitHub：`MYCF711/dsh-session-superagent`
- 远端已发布（旧）：主包 `0.10.11` / gate `0.1.4`（tag `v0.10.11` / `gate-v0.1.4`）；正式 main `7846678`（PR #30）
- 集成树新的目标版本：主包 **`0.10.12`** / gate **`0.1.5`**（工作区已 bump，**未发布**）
- v6 任务书：`docs/任务书-dsh-gate-v6.md`，提交 `c3753a1`
- 当前工作树：`D:\主工作区\projects\dsh-gate-v6-integration`
- 当前分支：`task/gate-v6-integration`，基线 `b580681`（V1 报告）+ 本次本地提交
  `release: 0.10.12（门禁 v6 锁回收、profile 原子性与模型证据）`（= 本文件所在提交）
- 另一棵只含任务书的树：`D:\主工作区\projects\dsh-gate-v5-integration`，`feat/gate-v6` @ `c3753a1`

**不要把旧 `.tmp-issue9-push-20261106-1244` 或其它历史 worktree 当成最新代码。**

## 3. v6 的三个实现分支（已合并，不要重做）

| 工作 | 分支 / commit | 已独立复跑 |
|---|---|---|
| C1 锁回收按搬走时间计龄、大小写语义跟随文件系统 | `task/gate-v6-core` @ `133a398` | gate **180/180**，`npm run check` 通过 |
| S1 profile 真原子、lib 缺失与错误分类 | `task/gate-v6-scripts` @ `dfe5a62` | drift **22/22** |
| B1 模型来源场景入正式 Chromium 套件 | `task/gate-v6-browser` @ `fc35b4b` | client、UI 100 分；Chromium **64/64** |

合并顺序（三次 `--no-ff`，无冲突）：

```text
2b9bad4  merge C1
f5dc66d  merge S1
628a32a  merge B1
b580681  docs: gate v6 独立验收报告（V1）
<本次>   release: 0.10.12（门禁 v6 锁回收、profile 原子性与模型证据）
```

## 4. 审查与修复的最终状态

| 步骤 | 结论 | 报告 |
|---|---|---|
| V1 独立验收 | 通过（三条分支可进审查）；交接项：README 953→实测、profile 断链、版本未 bump | `docs/报告-gate-v6验收.md` |
| Q1 核心 / 脚本审查 | **PASS**：blocker 0 / high 0 / medium 0 / low 4 / info 3（均可留到后续） | `docs/报告-gate-v6核心审查.md` |
| Q2 浏览器 / 面板审查 | **NEEDS_REVISION**：medium 2（Q2-1 场景空转、Q2-2 静态护栏假绿）/ low 3 / info 2 | `docs/报告-gate-v6面板审查.md` |
| 面板修复（t3） | Q2-1 / Q2-2 / Q2-4 已修，Q2-3 定性为「第二道闸门不可达」；`client.js` 一个字节没动 | `docs/报告-gate-v6面板修复.md` |
| Q2R 独立复审 | Q2-1 / Q2-2 / Q2-4 **resolved: true**；Q2-3 **resolved: false**（low，不可达）；新出 R1/R2（low）/ R3–R5（info） | `docs/报告-gate-v6面板复审.md` |
| 收尾修复（t5） | **R1/R2 已修**：运行期完整性断言加存在性护栏、去注释改八态状态机（支持块注释 / 正则字面量）；变异两向验证 | `docs/报告-gate-v6收尾修复.md` |
| I1-prep（t6） | 版本 bump + 文档计数回填 + `check-maintenance` 扫描范围 + 全量验证 + 本地精确提交 | `docs/报告-gate-v6I1-prep.md` |

## 5. 本轮实测计数（跑过才算）

- 根 `npm test`：**968/968**（exit 0）
- gate 包：**180/180** + `npm run check` 通过
- `test/client.test.mjs`：**171/171**；`test/sync-profile-drift.test.mjs`：**22/22**
- `PANEL_STRICT=1 … --test-name-pattern='门禁'`：**48/48**
- UI 体检：**11/11（100 分）**；面板文案快照 PASS
- 正式 Chromium：**64/64**（安装版前端 `0.2.2-rc.1`、Chromium 156、loopback fixture，**不是**真实 WebView）
- `preflight` 全量：**42 项 = 41 PASS / 1 SKIP**（`smoke:observe` 需真机宿主）
- `check-maintenance`：**4/6** —— ⑤（四处版本一致）/ ⑥（自上个 tag 起未改动运行时代码）PASS；
  ③④ 因为**还没打 `v0.10.12` tag**（本轮明确不打）而红。**这不是版本不一致**，发布步骤打 tag 后就 6/6。
- `sync-profile --check`（只读）：缺失 0 / 断链 21 / 陈旧 0 / 门禁子包漂移 1 —— 断链 21 是「profile 硬链指向
  另一个 worktree」的副本现象，`--repair` 留到发布后；真实 profile 全程只读。

## 6. 下一步（按顺序，别跳）

1. **等用户确认后发布 `0.10.12` / `gate 0.1.5`**（t7）：`git tag v0.10.12` / `gate-v0.1.5` → `npm publish` 双包 →
   `node scripts/release-gh.mjs --latest` → 合并 main（PR + merge commit）→ main CI 绿；
2. 发布后 `node scripts/sync-profile.mjs --repair`，再 `--check` 到四段全零；只声明**磁盘副本一致**；
3. 回来更新本文件与 `MAINTENANCE.md` 的「当前状态」，并把 `check-maintenance` 复跑到 6/6；
4. 之后才是 v6 的 low 残余（Q1-1~Q1-4、Q2-3）与真机走查，见 `MAINTENANCE.md` §三。

## 7. 主理鱼真实运行状态（本轮未重启，快照来自 0.10.11 运行期）

GUI：`http://127.0.0.1:51092`（**端口每次重启会变，不要写死**）。当时 `GET /session-superagent/state` 实测
`serverVersion / runningVersion / installedVersion = 0.10.11`，两条 watcher 都 `consecutiveFailures=0`、
`lastError=null`、`lastDeferred=未变化（304，不计入速率限制）`。

**本轮没有重载宿主**，所以：磁盘上是 `0.10.12`（仓库 + 待同步的 profile），**运行中的仍是 `0.10.11`** ——
这是预期状态，不是没生效。宿主重载后 profile 运行时是否生效 **未验**。

## 8. 复跑命令（集成树内）

```bash
cd /d/主工作区/projects/dsh-gate-v6-integration
npm test                                            # 968/968
(cd packages/dsh-gate && npm test && npm run check)  # 180/180 + 语法
node scripts/test.mjs test/client.test.mjs           # 171/171
node scripts/test.mjs test/sync-profile-drift.test.mjs  # 22/22
PANEL_STRICT=1 node scripts/test.mjs --test-name-pattern='门禁' test/client.test.mjs  # 48/48
node scripts/preflight.mjs                           # 全量 42 项（发布前必跑，不要只跑 --fast）
node scripts/check-maintenance.mjs                   # 发布前看 tag 项；发布前 4/6 是正常的
node scripts/ui-audit.mjs                            # 11/11 = 100
node scripts/audit-readme-tests.mjs 968              # README 单测数与实测一致
node scripts/sync-profile.mjs --check                # 只读；--repair 留到发布后

# 正式 Chromium（loopback fixture，不是 DSH WebView）
REPO_W=$(pwd -W)
{ echo "process.env.DSH_SUPERAGENT_REPO='$REPO_W'"; cat scripts/verify-panel-chromium.mjs; } | ego-browser nodejs
```

## 9. 硬约束

- 禁止重启/关闭 DSH；禁止动 magpie proxy；禁止直接写 `cordis.patch.yml`。
- 团队 `dsh-gate-v6`：子代理固定 `group/deepseek-v4.1-flash-1017`、`reasoning_effort=max`；automatic 审批。
- 每个实现分支独立 worktree、同文件单写者；**禁止 `git add -A`**、禁止强推、禁止改别人 PR 分支。
- main 受保护，必须 PR + Node 22/24 两个检查；tag 必须可达 main，不能 squash 脱钩。
- 不向外部仓库发 PR；凭证与本机路径不外泄。
- Chromium fixture ≠ 真实 WebView；真实读屏、触摸、IME、NFS/SMB 锁、真实长期句柄 EPERM 仍未验。
- profile 硬链接会断：切分支/原子替换后可能大批断链，但只能在验收/发布阶段 repair。

## 10. 历史闭环（只作定位，不再重做）

- PR #27/#28：v4 已发布并 ack。
- PR #29/#30：v5 已发布并 ack，main `7846678`。
- v6：C1 / S1 / B1 已合并实现，V1 → Q1 / Q2 → 修复 → Q2R → 收尾 → I1-prep 全部完成，**等发布**。
