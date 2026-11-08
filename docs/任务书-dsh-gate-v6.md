# 任务书 v6：原子性、锁回收与浏览器证据入库

> 基线：`dsh-session-superagent@0.10.11`、`@mycf711/dsh-gate@0.1.4`，main `7846678`。
> 执行：AgentTeams 自动模式；DeepSeek V4.1 Flash，思考 max。
> 范围：MAINTENANCE 下一步第 4 项，不碰需要真机/共享盘的第 1/2 项。

## 一、profile 真原子与错误分类

- `missingImports` 计算前移到任何写盘之前；相对 import 缺失时 --check/--repair 都只读、exit 2、点名。
- 整个 `lib/` 目录缺失归入 repoMissing，不再抛 ENOENT 栈。
- 第五段文案区分「TARGETS 缺源」与「门禁子包源缺失」；汇总准确、clean 无噪音。
- 用临时副本证明旧实现会先改盘/抛栈，再修绿。

## 二、锁回收边界

- prune 的年龄按本次 move/发现时间，不沿用源文件继承 mtime；在途文件不得因旧 mtime 被回收。
- `.stale-*` / `.release-*` 匹配在 Windows 大小写变体下行为一致；不误删无关文件。
- C1–C3 与 v5 的跨进程、stale、release、extends、清理留证全部回归。

## 三、模型浏览器证据入库

- 把 v5 的模型来源临时 harness 关键场景并入 `scripts/verify-panel-chromium.mjs`：按钮/迟到响应/闸门/取消/确认/project/user/targetRepo。
- 测试必须能在仓库内一条命令复跑，不依赖 /tmp 探针；保留 clean/dirty 与乱序场景。
- `U5-M4` 的请求数断言改成语义下界（>=2），不钉当前重复 load 的精确次数。
- 不把 loopback fixture 写成真实 WebView。

## 四、工作流

| ID | 任务 | 写作用域 |
|---|---|---|
| S1 | profile 真原子与错误分类 | `scripts/sync-profile.mjs`、`scripts/preflight.mjs`、`test/sync-profile-drift.test.mjs`、直接相关测试 |
| C1 | 锁回收边界 | `packages/dsh-gate/**` |
| B1 | 模型 Chromium 入库 | `scripts/verify-panel-chromium.mjs`、`test/client.test.mjs`、必要 fixture/文档 |
| V1 | 独立验收 | 只读 + 验收报告 |
| Q1 | 核心/脚本审查 | 只读 + 审查报告 |
| Q2 | 浏览器与面板审查 | 只读 + 审查报告 |
| I1 | 集成发布 | 两项审查通过后 |

## 五、验收与非目标

- 每项先红后绿，贴 tests/pass/fail 和退出码；最终合并树重新计数。
- 全量 npm test、gate、client、drift、UI、preflight、Chromium 全复跑。
- npm/tag/Release/main CI；profile 只声明磁盘一致。
- 不做真实 WebView/共享盘/真实句柄/真实模型，不重启 DSH，issue #19 不动。
