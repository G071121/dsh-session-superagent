# MAINTENANCE.md —— 维护台账（给接手的 agent 看）

> 接手前先读这一页，再按 [AGENTS.md](./AGENTS.md) 的「先定位你在哪一步」读对应文档。
> **每次干完活必须更新「二、当前状态」与「三、下一步」** —— 这页不是历史，是交接单。
>
> 形态参照 `MYCF711/magpie-plugin-scaffold` 的维护台账，本地化成这个仓库的真实命令与数字。

## 一、身份

| 项 | 值 |
|---|---|
| 仓库 | `MYCF711/dsh-session-superagent` |
| npm 包名 | `dsh-session-superagent` |
| 当前版本 | `0.10.12`（npm 已发布 / tag `v0.10.12` / GitHub Release 为 Latest）；门禁子包 `@mycf711/dsh-gate@0.1.5` 同样已发布 |
| 形态 | DSH 插件：7 个工具 + 自带 `cordis.patch.yml` + 客户端面板与状态栏圆环 |
| 目标宿主 | DeepSeek Harness ≥ 0.2.1-rc.5；Node ≥ 22.19；需已登录 `gh` CLI |

## 二、当前状态（2026-11-09）

```text
分支        main（主仓 D:\DeepSeek Harness\大肥鱼工作区\dsh-session-superagent；HEAD 以 origin/main 为准，2026-11-09 为 9df0fe2；发布 commit ec36ddec = PR #31）
仓库结构    主仓 + 5 个 worktree（v6-integration / gate-adapter / gate-core / deep-ui / 主仓 main）；旧的 .tmp-issue9-push 已迁移，51 棵历史 worktree 已清理，本地 tag 已与远端对齐
版本        0.10.12 / gate 0.1.5；tag v0.10.12 / gate-v0.1.5（远端已推、可达 main）；Release v0.10.12 = Latest
npm         dist-tags.latest = 0.10.12 / 0.1.5（双包已发布）
工作区      clean；安装副本 %DSH_HOME%\profiles\desktop\node_modules\... 已 --repair 到四段全零（只声明磁盘一致）
```

| 资产 | 数量 |
|---|---:|
| `node --test` | 968 例全过（gate 180 / client 171 / drift 22，含 update-ui 53） |
| `scripts/preflight.mjs` | 42 项 = 41 PASS / 1 SKIP（`smoke:observe` 需真机宿主） |
| `scripts/ui-audit.mjs` | 11/11，100 分（写死颜色 0 / 自造 token 0） |
| `docs/kb` | 183 篇 / 9 板块（`check-docs` 五项 PASS，含总数校验） |
| `scripts/` | 68 个门禁与工装脚本 |
| GitHub Release | 328 个（最新 `v0.10.12` = Latest、`gate-v0.1.5`）；历史版本仍在按批次回填 |
| CI / 分支保护 | `ci`（Node 22/24）；main 需 PR + 2 个必需检查，禁强推禁删 |

已验证（发布后实测）：

- `node --test` → 968/968；gate 包 180/180 且 `npm run check` 通过；client 171/171；drift 22/22；
  `PANEL_STRICT` 门禁组 48/48；preflight 全量 **42 项 = 41 PASS / 1 SKIP**；ui-audit 11/11 = 100；
  `check-docs` 五项 PASS（183 篇）；`check-maintenance` **6/6**；
- 真实 Chromium **64/64**（安装版前端 `0.2.2-rc.1`；17 条门禁 / 模型场景已进正式套件，不再有单独的临时 harness）；
- `sync-profile --repair` 处理 22 项（relinked 21 + recopied 1）→ `--check` →
  **缺失 0 / 断链 0 / 陈旧 0 / 门禁子包漂移 0**（**只声明磁盘副本一致**，宿主运行时是否生效要重载后另验）；
- 发布：`npm publish` 双包（`0.10.12` + `0.1.5`）；PR #31 merge commit `ec36ddec`；
  tag `v0.10.12` / `gate-v0.1.5` 可达 main；Release `v0.10.12`（Latest）+ `gate-v0.1.5`；
  发布时 main CI run `42551155750` 在两个 tag 上远端后重跑，Node 22/24 绿；
- 回填：PR #32 merge commit `d8359e5`（仅 README / AGENTS / MAINTENANCE / HANDOFF），
  回填后 main CI run `42553248097` 一次 success；随后 PR #33（交接刷新，`2ba7ada`）只改
  HANDOFF / MAINTENANCE 的 main 表述，不再写死 main HEAD。

未验证（不能写成"通过"）：

- **真机走查 22 项**（`docs/真机走查清单-弹层.md`）—— 需要人在界面上按 Tab/Escape、看两套主题；
- 宿主重载后 profile 运行时是否生效（本轮只声明磁盘一致，未重启 DSH）；
- 跨主机共享盘（NFS/SMB）锁语义、真实长期数据句柄占用下的 rename EPERM、不经过本锁的外部写者并发；
- 连续 24 小时运行的误唤醒率、限流表现；物理读屏 / 触摸 / IME；CI 矩阵 Node 22（本机只 Node 24.20）；
- **v6 的 low 残余（Q1，未修）**：Q1-1 `scanMissingImports` 只认「行首 + 单引号 + 单行 + 静态 import」
  —— 双引号 / `export … from` / 多行 `import { … } from` / 动态 `import()` 静默漏检（仓库里已有两处多行 import）；
  Q1-2 `lib/` 里名字以 `.js` 结尾的目录会抛 `EISDIR` 栈而不是「exit 2 + 点名」；
  Q1-3 profile 侧**部分** TARGETS 缺失只给计数、不点名；Q1-4 macOS 默认 APFS 上大小写变体仍互不回收
  （本机 Windows 不可复现）。均 low、不阻塞。
- **v6 的 low 残余（Q2，未修）**：Q2-3 `client.js:2523` / `:2530` 的第二道闸门**不可达**
  （`panelRepoOf() === modelsPanelRepo` 恒成立，序号闸门总先 `return`）—— 行为仍正确，现为不变式 tripwire，
  删除留到下次动这块时；Q2R 的两条 low（R1 运行期完整性断言自身无判据、R2 去注释只按行首 `//`）已由收尾修复关闭。
- 真实 `/gates/models` 服务端跨仓库返回、真实模型调用：v6 的浏览器证据仍是 loopback fixture（17 条场景），
  **不是**真实服务端 / 真实模型。
- **发版顺序的已知竞态**：main 上「先合并、后推 tag」时，CI 的 `checkout(fetch-depth: 0)` 可能早于 tag 推送，
  `check-maintenance` ③④ 会红（v6 首次 main CI 就这样红过）。本轮靠 `gh run rerun` 转绿，
  根治方案见「三、下一步」第 6 条。

## 三、下一步

按价值排序，**不要一次混着做**：

1. 真机走查 22 项（需要用户配合，或按用户截图逐条对照）；
2. 补验跨主机共享盘（NFS/SMB）锁语义与真实长期句柄下的 `rename` EPERM；
3. 宿主重载后复验 profile 运行时是否生效（现在只声明**磁盘副本一致**，未重启 DSH）；
4. 继续回填历史 GitHub Release（`node scripts/release-gh.mjs`，用户要求"之前的慢慢改"）；
5. 收 v6 的 low 残余：Q1-1 把 `scanMissingImports` 扩到双引号 / `export … from` / 动态 `import()`，
   并跳过多行 import 的续行（小状态机，别用正则硬凑）；Q1-2 非普通文件条目归入 `repoMissing` 并点名；
   Q1-3 TARGETS 部分缺失逐条点名；Q1-4 `caseInsensitive` 覆盖 `darwin` 或加环境变量开关；
   Q2-3 删掉 `client.js:2523` / `:2530` 不可达的第二道闸门（连同不变式 tripwire 一起改）。
6. 修掉发版顺序竞态：把流程改成「**tag 先推、再合并 main**」（tag 指向的 commit 合并后即可达），
   或给 main CI 的 `check-maintenance` 步骤加一次「tag 未到 → 等待重试」。别把 ③④ 的红当噪声忽略。

## 四、硬约束

1. **不重启、不关闭宿主的 DSH**；需要重启才生效的改动（服务端部分）只提示用户，自己不执行。
2. **凭证永不出插件**：所有返回必须过 `redact()`；新增输出路径要补测试；
   **路径也不回显**（Windows 反斜杠曾让掩码整段漏出）。
3. **不修改用户 profile 的 `bundles`**；本项目只随包带 `cordis.patch.yml`。
4. **没跑过的写成"未验证"**，不写"通过"；"包含"式断言不算验证过（见 AGENTS 坑 7）。
5. **发布三处必须一致**：`package.json` / `lib/index.js` / `client.js` / README 徽章 / CHANGELOG
   （`test/meta.test.mjs` 会拦），外加 **tag 与 Release 标题只写版本号**。
6. **不代改他人 PR**：给意见让对方改，改完我复核合入。
7. **标准写在文档里不算数**：新加的检查必须接进 `preflight` 或 CI，否则就是「标准悬空」
   （写好了没人调用 = 没写）。见 [docs/维护标准.md](./docs/维护标准.md)。

## 五、给接手者的最短路径

1. 读本文件 + [AGENTS.md](./AGENTS.md) 的两张表（定位 / 坑）；
2. `git status` + `git log --oneline -5` + `node --test` 核实现状（**别信本文件的数字，跑一遍**）；
3. 按 AGENTS 定位表读对应专档，别通读；
4. 改完跑 `node scripts/preflight.mjs`（全量）再交付；
5. 发版按 [UPDATING.md](./UPDATING.md)，最后回来更新本文件的「当前状态」。
