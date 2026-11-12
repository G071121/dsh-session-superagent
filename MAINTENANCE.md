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
| 目标宿主 | DeepSeek Harness `>=0.2.2-rc.1 <0.3.0-0`（`package.json` 的 `engines.dsh`）；Node ≥ 22.19；需已登录 `gh` CLI |

## 二、当前状态（2026-11-13）

```text
分支        以 origin/main 为准（2026-11-13 为 8da9fd74；#43 / #44 / #45 / #46 已合入）；不写死某个本地 main
仓库结构    主仓 + 多个任务 worktree（gate 子包 / 各 issue·PR 分支）；已合并分支按需清理，旧副本不要当最新代码
版本        0.10.12 / gate 0.1.5；tag v0.10.12 / gate-v0.1.5（远端已推、可达 main）；Release v0.10.12 = Latest
npm         dist-tags.latest = 0.10.12 / 0.1.5（双包已发布；#43–#46 尚未 bump，本轮不发布）
工作区      本轮只改 CHANGELOG / MAINTENANCE / HANDOFF 三份文档；profile 未重验（preflight --fast 报断链 21，需 --repair）
```

| 资产 | 数量 |
|---|---:|
| `node --test` | 992 例全过（gate 180 / client 191 / drift 22，含 update-ui 53；#46 功能 12 + M1 修复 5） |
| `scripts/preflight.mjs` | 最终 main `--fast` 仅 `profile 一致性` 1 项环境失败（断链 21，需 `--repair`）；全量未跑 |
| `scripts/ui-audit.mjs` | 11/11，100 分（写死颜色 0 / 自造 token 0） |
| `docs/kb` | 183 篇 / 9 板块（`check-docs` 五项 PASS，含总数校验） |
| `scripts/` | 68 个门禁与工装脚本 |
| GitHub Release | 328 个（2026-11-09 快照；最新 `v0.10.12` = Latest、`gate-v0.1.5`）；历史版本仍在按批次回填 |
| CI / 分支保护 | PR #43 / #44 / #45 / #46 的 Node 22/24 均绿；main 的「维护一致性」因运行时改动未 bump **预期红**；main 需 PR + 2 个必需检查，禁强推禁删 |

已验证（最终 main `8da9fd74` 由 Lead 实测；本交接分支另跑 `check-docs` / `audit-readme-tests 992` / `diff-check`）：

- 根 `npm test` → **992/992**（gate 180 / client 191 / drift 22，含 update-ui 53；#46 功能 12 + M1 修复 5）；
- `scripts/check-docs.mjs` 五项 PASS（360 篇 Markdown / 183 篇 kb / 9 板块）；
- `scripts/ui-audit.mjs` **11/11（100 分）**；
- 真实 Chromium **72/72**（**rc.1 安装版前端** `0.2.2-rc.1` + 最终 `client.js` sha256
  `0da9bb0702a08a817c33811c7d803440f05495cb24d9c9747da4826e4b40618c` 基线；#35 新增 8 条；
  **不是** rc.2 宿主、**不是**真实 DSH WebView）；
- `scripts/check-maintenance.mjs` **5/6**：①–⑤ 通过，**⑥ 预期红** —— 自 `v0.10.12` 起
  `client.js` / `lib/gh-format.js` / `lib/index.js` 有改动但版本未 bump（本轮不发布）；
- #46 的 M1 复审：干净 / 脏草稿与 `localStorage.clear` 两条已修并复核 **resolved**；
- `git diff --check` 无输出（exit 0）。

历史基线（2026-11-09 v6 发布后快照，不要再当当前计数）：

- `node --test` 968/968；preflight 42 项 = 41 PASS / 1 SKIP；真实 Chromium 64/64；
  `check-maintenance` 6/6；`sync-profile --repair` 处理 22 项 → 缺失 0 / 断链 0 / 陈旧 0 / 门禁子包漂移 0；
- 发布：`npm publish` 双包（`0.10.12` + `0.1.5`）；PR #31 merge `ec36ddec`；tag `v0.10.12` /
  `gate-v0.1.5` 可达 main；Release `v0.10.12`（Latest）；回填 PR #32 `d8359e5`、PR #33 `2ba7ada`。

未验证（不能写成"通过"）：

- 真实 DSH WebView；**rc.2 host-orbit fallback 有 3 项预存失败**（旧 client 同样失败，本轮未修）；
  **#35 的 portal 场景在 rc.2 上未直达**（脚本在预存失败处超时，未能跑到第四阶段），不能把 rc.1 的
  72/72 泛化成 rc.2 或真实 WebView 通过；真实读屏 / 触摸 / IME；
- 真实 Gitee 写操作（#43 只锁请求形状、#44 的 Gitee 保存契约是单测 + 浏览器 fixture，均非真实写）；
- 宿主重载后 profile 运行时是否生效（本轮只声明磁盘一致，未重启 DSH；preflight `--fast` 的
  `profile 一致性` 仍报断链 21，需 `--repair`）；
- 跨主机共享盘（NFS/SMB）锁语义、真实长期数据句柄占用下的 rename EPERM、不经过本锁的外部写者并发；
- 连续 24 小时运行的误唤醒率、限流表现；本机只 Node 24.20（Node 22/24 矩阵以 PR CI 为准）；
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
  根治方案见「三、下一步」第 8 条。

## 三、下一步

按价值排序，**不要一次混着做**：

1. **发布**：#43–#46 改了运行时（`client.js` / `lib/gh-format.js` / `lib/index.js`）但**未 bump**，
   main 的维护一致性 ⑥ 预期红；按 [UPDATING.md](./UPDATING.md) 走五处版本 + tag + Release + npm（本轮未做）。
2. **PR #41（@iJetLi「弹层显示最近唤醒的是哪一条」）**：已回评，待作者修正文档计数与 `/state` 体积
   （120 码点上限 / `measure-state` 夹具偏乐观）；**未合入、未 ack**，不要写成已发布。
3. 真机走查 22 项（需要用户配合，或按用户截图逐条对照）；
4. 补验跨主机共享盘（NFS/SMB）锁语义与真实长期句柄下的 `rename` EPERM；
5. 宿主重载后复验 profile 运行时是否生效（现在只声明**磁盘副本一致**，未重启 DSH）；
6. 继续回填历史 GitHub Release（`node scripts/release-gh.mjs`，用户要求"之前的慢慢改"）；
7. 收 v6 的 low 残余：Q1-1 把 `scanMissingImports` 扩到双引号 / `export … from` / 动态 `import()`，
   并跳过多行 import 的续行（小状态机，别用正则硬凑）；Q1-2 非普通文件条目归入 `repoMissing` 并点名；
   Q1-3 TARGETS 部分缺失逐条点名；Q1-4 `caseInsensitive` 覆盖 `darwin` 或加环境变量开关；
   Q2-3 删掉 `client.js:2523` / `:2530` 不可达的第二道闸门（连同不变式 tripwire 一起改）。
8. 修掉发版顺序竞态：把流程改成「**tag 先推、再合并 main**」（tag 指向的 commit 合并后即可达），
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
