# 任务书 v2：dsh-gate 收尾与真实门禁链

> 基线：`dsh-session-superagent@0.10.6`、`@mycf711/dsh-gate@0.1.0`，main `ff6b43b`。
> 原则：最小模块、独立插件、稳定 provider；不重复 DSH 官方工具授权审查。
> 执行模型：所有子代理 `group/deepseek-v4.1-flash-1017`，`reasoning_effort=max`。

## 一、已确认缺口

1. 面板关闭默认层规则只表示「本层不覆盖」，不能真正停用；需要规则级 `enabled:false` 且四层合并语义一致。
2. `/gates/preview` 能检查文本，但发送 issue/PR 回复、合并、发版前没有统一 CLI/包装入口，硬门禁仍靠自觉。
3. 门禁页已有，但预览脚本 `deskHooks` 数量、`textarea/select` 的 value 渲染和 Chromium 左栏断言需要同基线复核。
4. 文档与验收脚本仍可能残留旧测试数、旧版本、旧路径；必须跑真实门禁，不靠字符串宣称。

## 二、冻结契约

### 规则启停

- 规则增加可选 `enabled`（缺省 `true`）；`enabled:false` 表示该层明确停用同 id 规则。
- 合并顺序：默认 → 用户全局 → 项目 → 本地；同 id 后层完整覆盖前层。
- 停用后的规则不得再被更前层复活；后层可显式 `enabled:true` 重新启用。
- 写盘保留 `enabled:false`，不得在 normalize/validate 中丢弃。
- 默认配置不新增停用项，旧配置行为完全不变。

### CLI

- `packages/dsh-gate/bin/gate.mjs` 是唯一发送前入口：`--trigger issue.reply|pr.reply|pr.handle|merge|release --body-file <path|-> --current <编号> --repo <目录>`。
- 退出码：0 通过；1 有 error；2 用法/配置/IO 错误。
- 硬门禁失败不得调用模型；语义复审仅 merge/release，默认关闭。
- 不在 gate 内直接调用 gh/git/npm，不自动发送、不自动合并、不自动发布。

### UI

- 独立 `GateSettings` 子组件，不增加主面板 useState 槽位。
- 规则开关真实写入启停语义；默认层只读，我的/项目可写。
- 正则默认收进「高级」；保存/预览/优化提示词都有成功和失败态。

## 三、工作流与依赖

| ID | 工作 | 写作用域 | 依赖 | 验收 |
|---|---|---|---|---|
| R1 | 需求/现状冻结 | `docs/任务书-dsh-gate-v2.md` | 无 | 核对真实版本、当前实现、缺口；verdict=pass 才往下 |
| C1 | 核心启停 + CLI | `packages/dsh-gate/**` | R1 | 包内测试全绿；停用/复启用例先红后绿；CLI 正反向 exit 码 |
| U1 | 面板真实启停 | `client.js`、`test/client.test.mjs`、`test/update-ui.test.mjs`、`docs/面板文案.md` | R1，可与 C1 并行 | 不再写「关掉仍生效」；主面板零新增 hook；client 测试全绿 |
| V1 | 独立验收 | 只读源码；可写 `docs/报告-gate-v2验收.md`、临时证据 | C1、U1 | 全量 `npm test`、`preflight`、UI、Chromium；记录真实计数和未验项 |
| Q1 | 严格审查 | 只读；产出 `docs/报告-gate-v2审查.md` | V1 | 查停用复活、越权、假绿、profile 缺包、CI 契约；无 blocker 才 pass |
| I1 | 集成发布 | 根配置/文档/CI/发布脚本 | Q1 | 只合全绿分支；版本、npm、tag、Release、main CI 证据齐全 |

## 四、并行与集成纪律

- R1 后 C1 与 U1 同轮并行；V1 等两者完成；Q1 等 V1；I1 等 Q1。
- 同文件单写者；子任务各自 worktree；Lead 只显式合并验收后的分支。
- 禁止 `git add -A`、强推、改写已推送 PR 分支；失败先检查产物，不盲重试。
- 交付第一行要求：必须自己跑测试并贴原始计数/退出码；没有输出不算完成。
- 不改 DSH、不重启、不动 magpie proxy、不向外部仓库发 PR；issue #19 不动。

## 五、发布与非目标

- 目标版本：主插件 0.10.7，gate 包按需 0.1.1；只有真实改动才 bump。
- 发布三件套：npm + tag + Release；main CI 必须 success。
- 不做官方工具权限审批、不做 LLM 兜底放行、不做自动评论/合并/发布。
- 不把预览截图当成真机 WebView 验收；未验项必须写明。
