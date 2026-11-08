# 任务书 v3：门禁配置边界与验收口径收尾

> 基线：`dsh-session-superagent@0.10.8`、`@mycf711/dsh-gate@0.1.1`，main `a78c501`。
> 执行：AgentTeams 自动模式；成员 `group/deepseek-v4.1-flash-1017`，`reasoning_effort=max`。
> 原则：只修已审查确认的配置丢失/误导/门禁盲区，不重做权限审批，不扩大 UI 架构。

## 已确认问题

1. `writeGateConfig` 直调会静默丢 `extends`；面板拒绝保存不能替代服务端防数据丢失。
2. 用户层手写 `semantic:false` 时开关与底部状态不一致；`extends:false/'none'` 被误判为共享配置而禁止保存。
3. 有未保存草稿时切换作用域/仓库会静默丢失。
4. preflight 只显示「缺失/断链/陈旧」三段，看不到「门禁子包漂移」第四段。
5. 主插件 profile `TARGETS` 固定清单，新增运行时文件容易漏同步；需在不扩大打包范围的前提下加可测试的保障。

## 冻结行为

### extends

- 核心写盘不得静默丢弃调用方传入的 `extends`。
- 最小安全方案：对无法安全保留的 extends 形式显式报错（fail closed），错误含配置路径与解决方式；`false/'none'` 允许。
- 面板只对字符串/对象/true 的共享 extends 拒绝保存；`false/'none'` 可保存。
- 已存在 extends 的文件不得被面板或 API 无提示改写。

### 面板

- 用户层 `semantic:false` 时开关和底部都显示关闭，预览不请求语义复审。
- dirty 时切作用域/仓库：显示确认；取消保留草稿，确认才放弃。不得新增主面板 useState，状态留在 GateSettings。
- 官方 SegmentedControl 委托与本地回退不得回归。

### 发布与 profile

- preflight profile 行显示第四段「门禁子包漂移」；没有漂移时不增加噪音。
- 新增运行时文件必须有自动测试防止漏进 TARGETS；不要无条件递归把 test/docs 打包。
- preflight/Chromium 使用当前安装路径；不把 fixture 当真机。

## 工作流

| ID | 任务 | 写作用域 | 依赖 |
|---|---|---|---|
| C1 | extends 写盘防丢失 | `packages/dsh-gate/**` | 无 |
| U1 | 面板语义/dirty/extends false | `client.js`、`test/client.test.mjs`、`test/update-ui.test.mjs`、`docs/面板文案.md` | 无，可与 C1 并行 |
| S1 | preflight 与 TARGETS 防漏 | `scripts/preflight.mjs`、`scripts/sync-profile.mjs`、`test/sync-profile-drift.test.mjs`、相关测试 | 无，可并行 |
| V1 | 独立验收 | 只读实现 + `docs/报告-gate-v3验收.md` | C1/U1/S1 |
| Q1 | 核心与发布审查 | 只读 + `docs/报告-gate-v3核心审查.md` | V1 |
| Q2 | 面板审查 | 只读 + `docs/报告-gate-v3面板审查.md` | V1 |
| I1 | 集成发布 | 根配置/文档/发布脚本 | Q1/Q2 均通过 |

## 验收

- 每项实现先证明旧行为会红，再修绿；贴 tests/pass/fail 与退出码。
- 全量 `npm test`、gate 包、client、update-ui、ui-audit、preflight、Chromium 按改动复跑。
- 临时目录验证 extends 不丢/明确拒绝、semantic:false、dirty 取消与确认、第四段显示、TARGETS 漏文件会红。
- 合并 main 后再写最终测试数；目标为主包下一 patch、gate 按真实变更 bump。
- 发布三件套与 main CI；profile 只声明磁盘一致，不声明运行时生效。

## 非目标

- 不修 PANEL_STRICT 全量测试基建（另立任务）。
- 不做真实 WebView/读屏/触摸/IME，不调用真实模型或真实仓库写操作。
- 不向外部仓库发 PR，不重启 DSH，issue #19 不动。
