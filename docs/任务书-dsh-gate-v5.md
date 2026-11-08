# 任务书 v5：低优先残余专项

> 基线：`dsh-session-superagent@0.10.10`、`@mycf711/dsh-gate@0.1.3`，main `54f9052`。
> 执行：AgentTeams 自动模式；`group/deepseek-v4.1-flash-1017`，`reasoning_effort=max`。
> 范围：只做 MAINTENANCE「下一步」可在本机验证的残余，不碰真机/共享盘未验项。

## 一、面板模型列表来源

- 保留旧仓库 dirty 草稿时，`/gates/models` 的按钮和响应落地必须使用 panelRepo（草稿来源），不能跟 prop repo 切到新仓库。
- 闸门挡住 `/gates` 时作废在途 models 并恢复草稿来源列表；选中模型不得跨仓库写入。
- 主面板 hook 与官方 SegmentedControl 不变；补 project/user、取消/确认、迟到 models 用例。

## 二、锁文件残余与旧格式

- `.release-*` / `.stale-*` 是接管或释放失败后的临时证据；正常成功路径必须清理，失败路径保留可诊断信息且有界。
- 旧版无 token 锁需要明确身份策略：能安全判断才接管，否则 fail closed；不得把格式解析错误当成「可删除」。
- 不放宽 C1/C2/C3 的跨进程、stale、release、extends 保证；全量锁压力用例必须复跑。

## 三、profile 检查失败原子性

- TARGETS 缺源时 `--repair` 必须在任何写盘前失败，不得先改一部分再 exit 2。
- gate 子包整目录缺失不得静默跳过：--check 点名缺失，--repair 可复制修复。
- preflight 直接执行与 import 的主入口判断必须一致；回退路径不得静默 exit 0。
- 每类都先在临时副本复现旧行为，再修绿；不得修改真实 profile（I1 才执行）。

## 四、工作流

| ID | 任务 | 写作用域 |
|---|---|---|
| U1 | 模型列表 panelRepo | `client.js`、`test/client.test.mjs`、gate fixture |
| C1 | 锁残余与旧格式 | `packages/dsh-gate/**` |
| S1 | profile 失败原子性与主入口 | `scripts/preflight.mjs`、`scripts/sync-profile.mjs`、`test/sync-profile-drift.test.mjs`、直接相关测试 |
| V1 | 独立验收 | 只读 + `docs/报告-gate-v5验收.md` |
| Q1 | 核心/脚本审查 | 只读 + 审查报告 |
| Q2 | 面板审查 | 只读 + 审查报告 |
| I1 | 集成发布 | Q1/Q2 通过后 |

## 五、验收与非目标

- 各项先红后绿，贴 tests/pass/fail 与退出码；最终合并树重新计数。
- 全量 npm test、gate、client、drift、UI、preflight、Chromium 按改动复跑。
- npm/tag/Release/main CI；profile 只声明磁盘一致。
- 不做真实 WebView/共享盘/真实句柄/真实模型，不重启 DSH，issue #19 不动。

## 结果（I1 集成与发布）

- 集成：C1（`6a582e0`）、U1（`9c3236a`）、S1（`812df38`）三个提交 + V1 / Q1 / Q2 三份报告，
  经 **PR #29**（`task/gate-v5-v1`）合入 `main`，merge commit `127bcba`；发布提交
  `release: 0.10.11（门禁 v5 锁残余、模型来源与 profile 失败原子性）`（`b607149`）打
  tag `v0.10.11` / `gate-v0.1.4`，`git merge-base --is-ancestor` 复核 tag 在 `main` 历史上；
  没有强推、没有 `git add -A`。
- 版本：主包 `0.10.10` → **`0.10.11`**（patch）；门禁子包 `@mycf711/dsh-gate` `0.1.3` → **`0.1.4`**
  （锁残余清理、旧版无 token 锁 fail closed、`pruneLockArtifacts` 公开 API；沿用仓库既有 0.x 口径按
  patch）。`package.json` / `package-lock.json` / `lib/index.js` `SERVER_VERSION` / `client.js`
  `CLIENT_VERSION` / README 徽章 / CHANGELOG 六处同步，README 单测数 934 → 952，`AGENTS.md` 当前基线同步。
- L1 收窄：`sync-profile.mjs` 的失败原子性注释改成「`repoMissing` 非空时整轮只读」，并写明
  `lib/*.js` 相对 import 失败仍在**写盘之后**才检测（Q1 L1 本轮只收窄声明、未前移计算）；
  L2–L5 与 Q2 两条 low 记录在案，不扩大本轮。
- 最终计数（合并后复跑）：根 `npm test` **952/952**（fail 0，exit 0）、gate 包 **172/172**、
  `test/client.test.mjs` **167/167**、`test/update-ui.test.mjs` **53/53**、
  `test/sync-profile-drift.test.mjs` **18/18**、`PANEL_STRICT=1` 门禁用例 **45/45**、
  UI 审计 **11/11（100 分）**、面板文案快照 PASS、真实 Chromium **47/47**（安装版前端 `0.2.2-rc.1`，
  client sha256 `c6fe935d…`）、门禁专项 Chromium **54/54**、v5 模型专项 harness **63/63**、
  `preflight` 全量 **42 项 = 41 PASS / 1 SKIP**（`smoke:observe` 需真机宿主）、`check-maintenance` **6/6**。
- profile：`node scripts/sync-profile.mjs --repair` 后 `--check` 四段全零
  （缺失 0 / 断链 0 / 陈旧 0 / 门禁子包漂移 0），第五段「TARGETS 缺源」不出现 ——
  只声明**磁盘副本一致**；宿主运行时是否生效要重载后另验，本轮不重启 DSH。
- 发布三件套：`npm publish`（`dsh-session-superagent@0.10.11` + `@mycf711/dsh-gate@0.1.4`）、
  `git tag v0.10.11` / `gate-v0.1.4`、GitHub Release（`v0.10.11` = Latest，`gate-v0.1.4` 带子包说明）；
  `main` 上 CI 绿（Node 22/24）。
- 残余（均不阻塞）：Q1 L1–L5 与 Q2-L1/L2（见两份审查报告）；跨主机共享盘（NFS/SMB）锁语义、
  真实长期文件句柄占用下的 `rename` `EPERM`、真实 WebView / 读屏 / 触摸 / IME、真实 `/gates/models`
  服务端跨仓库返回未验。
