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
