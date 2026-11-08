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
| 当前版本 | 本地集成树已 bump 到 `0.10.12`（**未发布**：没有 tag、未 `npm publish`）；门禁子包 `@mycf711/dsh-gate@0.1.5`。远端已发布的最新是 `0.10.11` / `0.1.4` |
| 形态 | DSH 插件：7 个工具 + 自带 `cordis.patch.yml` + 客户端面板与状态栏圆环 |
| 目标宿主 | DeepSeek Harness ≥ 0.2.1-rc.5；Node ≥ 22.19；需已登录 `gh` CLI |

## 二、当前状态（2026-11-09）

```text
分支        task/gate-v6-integration（v6 集成树；本地提交，未合并 main、未 push）
版本        0.10.12 / gate 0.1.5（工作区已 bump；未打 tag、未 publish）；远端最新仍是 0.10.11 / 0.1.4
工作区      clean（提交后）；安装副本 %DSH_HOME%\profiles\desktop\node_modules\... 仍是 0.10.11（仅磁盘一致）
```

| 资产 | 数量 |
|---|---:|
| `node --test` | 968 例全过（gate 180 / client 171 / drift 22，含 update-ui 53） |
| `scripts/preflight.mjs` | 42 项（本轮 39 PASS / 1 SKIP / 2 FAIL：缺 `v0.10.12` tag、profile 待 `--repair`） |
| `scripts/ui-audit.mjs` | 11/11，100 分（写死颜色 0 / 自造 token 0） |
| `docs/kb` | 183 篇 / 9 板块（`check-docs` 五项 PASS，含总数校验） |
| `scripts/` | 68 个门禁与工装脚本 |
| GitHub Release | 326 个（最近两个是 `v0.10.11` / `gate-v0.1.4`）；历史版本仍在按批次回填 |
| CI / 分支保护 | `ci`（Node 22/24）；main 需 PR + 2 个必需检查，禁强推禁删 |

已验证（本轮实测）：

- `node --test` → 968/968；gate 包 180/180 且 `npm run check` 通过；client 171/171；drift 22/22；
  `PANEL_STRICT` 门禁组 48/48；preflight 全量 42 项 = **39 PASS / 1 SKIP / 2 FAIL**
  （`维护一致性` 缺 tag、`profile 一致性` 待 `--repair`，都是发布步骤的活；`--no-maintenance` 口径
  39 PASS / 2 SKIP / 1 FAIL）；ui-audit 11/11 = 100；
  `check-docs` 五项 PASS（183 篇）；`check-maintenance` ⑤（四处版本一致）/ ⑥（自上个 tag 起未改动运行时代码）PASS；
- 真实 Chromium **64/64**（安装版前端 `0.2.2-rc.1`；17 条门禁 / 模型场景已进正式套件，不再有单独的临时 harness）；
- `sync-profile --check`（**只读**）→ 缺失 0 / 断链 21 / 陈旧 0 / 门禁子包漂移 1；
  断链 21 是「profile 硬链指向另一个 worktree」的副本现象（v6 已两次复现并证明可修），`--repair` 留到发布后；
- 本轮**没有** `npm publish` / `git tag` / `git push`：只做了本地精确提交。

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
- `check-maintenance` 的 ③④（本地有 `v0.10.12` tag、tag 指向已提交 commit）：本轮按「发布前不打 tag」执行，
  要等发布步骤打 tag 后才会 6/6。**别把 4/6 当成版本不一致。**

## 三、下一步

按价值排序，**不要一次混着做**：

1. **发布 `0.10.12` / `gate 0.1.5`**（按 [UPDATING.md](./UPDATING.md)）：打 `v0.10.12` / `gate-v0.1.5` →
   `npm publish` 双包 → `release-gh.mjs --latest` → 合并 main 并过 CI。发布后 `check-maintenance` 应转 6/6；
2. 发布后跑 `node scripts/sync-profile.mjs --repair`，再 `--check` 到「缺失 / 断链 / 陈旧 / 门禁漂移」四段全零；
   只声明**磁盘副本一致**，宿主运行时是否生效要重载后另验；
3. 真机走查 22 项（需要用户配合，或按用户截图逐条对照）；
4. 补验跨主机共享盘锁语义与真实长期句柄下的 `rename` EPERM；
5. 继续回填历史 GitHub Release（`node scripts/release-gh.mjs`，用户要求"之前的慢慢改"）；
6. 收 v6 的 low 残余：Q1-1 把 `scanMissingImports` 扩到双引号 / `export … from` / 动态 `import()`，
   并跳过多行 import 的续行（小状态机，别用正则硬凑）；Q1-2 非普通文件条目归入 `repoMissing` 并点名；
   Q1-3 TARGETS 部分缺失逐条点名；Q1-4 `caseInsensitive` 覆盖 `darwin` 或加环境变量开关；
   Q2-3 删掉 `client.js:2523` / `:2530` 不可达的第二道闸门（连同不变式 tripwire 一起改）。

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
