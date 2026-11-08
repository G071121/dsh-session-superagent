# 任务书 v4：并发一致性与异步竞态收尾

> 基线：`dsh-session-superagent@0.10.9`、`@mycf711/dsh-gate@0.1.2`，main `2cad1a6`。
> 执行：AgentTeams 自动模式；`group/deepseek-v4.1-flash-1017`，`reasoning_effort=max`。
> 原则：只修审查已复现的竞态和门禁盲区；不重做 UI，不改变官方控件结构。

## 一、已复现问题

1. 面板切仓请求在途时，新草稿会被旧响应清掉；两次切仓乱序时旧仓库数据可能覆盖新仓库。
2. 门禁配置并发写同一层存在 TOCTOU：两个写者都成功时，后写者可能把先写者要拒绝的共享 extends 覆盖。
3. Windows 目标文件被占用时原子 rename 可能 EPERM；当前 fail-safe 但无重试。
4. TARGETS 清单条目被删除后，派生用例与 `--check` 仍可能全绿。
5. preflight 第四段已有实现，但缺少仓库内专项回归用例。

## 二、冻结行为

### 面板异步

- 每次 load 有单调序号/取消机制；只有最新请求且仍匹配当前 repo/scope 的响应可提交。
- 请求在途产生或修改草稿后，响应不得清掉 dirty 草稿。
- 保存/预览/优化继续使用 GET 回显的 data.repo，不能写错仓库。
- 状态留在 GateSettings，主面板 hook 队列不变；官方 SegmentedControl 不改。

### 门禁写盘

- 同一配置路径的「读旧文件 → 校验 → 备份 → 临时写入 → rename」必须串行，跨进程也不能互相覆盖。
- 锁获取失败/超时必须显式失败，不得无锁写；stale lock 清理必须有年龄与所有者证据。
- rename EPERM/EBUSY 做有界退避重试；最终失败保留原文件与明确错误，清理临时文件。
- 现有 extends fail-closed、false/'none'、.bak 行为不回归。

### 门禁与发布检查

- TARGETS 每个条目必须存在于仓库；缺失时测试和 `--check` 都红并点名。
- preflight 第四段增加仓库内 clean/drift 两类行为用例，不靠人工截图。
- 不扩大 npm pack，不递归加入 test/docs/scripts/packages。

## 三、工作流

| ID | 任务 | 写作用域 | 依赖 |
|---|---|---|---|
| U1 | 面板 load 竞态 | `client.js`、`test/client.test.mjs`、必要的 panel fixture | 无 |
| C1 | gate 写锁与 rename 重试 | `packages/dsh-gate/**` | 无 |
| S1 | TARGETS 存在性与 preflight 用例 | `scripts/preflight.mjs`、`scripts/sync-profile.mjs`、`test/sync-profile-drift.test.mjs`、相关测试 | 无 |
| V1 | 独立验收 | 只读 + `docs/报告-gate-v4验收.md` | U1/C1/S1 |
| Q1 | 核心与脚本审查 | 只读 + `docs/报告-gate-v4核心审查.md` | V1 |
| Q2 | 面板审查 | 只读 + `docs/报告-gate-v4面板审查.md` | V1 |
| I1 | 集成发布 | 根配置/文档/发布链 | Q1/Q2 均通过 |

## 四、验收

- 每项先在旧实现复现红，再修绿；贴 tests/pass/fail 与退出码。
- U1 必须有乱序响应、在途 dirty、取消/确认、保存 repo 的行为用例；V1 用真实 Chromium 复跑。
- C1 必须有多进程同层写入、锁失败、stale lock、EPERM 重试、extends 不丢的测试；不得只测单进程 Promise 链。
- S1 必须删除临时副本的 TARGETS 条目，证明旧假绿和新报红。
- 全量 npm test、gate、client、update-ui、ui-audit、preflight、Chromium 按改动复跑。
- 合并 main 后按实数回填；发布 npm/tag/Release/main CI。profile 只声明磁盘一致。

## 五、非目标

- 不重写 PANEL_STRICT 全量基建，不改官方视觉和交互。
- 不做真实 WebView/读屏/触摸/IME，不调用真实模型或真实仓库写操作。
- 不重启 DSH，不向外部仓库发 PR，issue #19 不动。
