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
| 当前版本 | `0.10.11`（npm 已发布 / tag `v0.10.11` / GitHub Release 为 Latest）；门禁子包 `@mycf711/dsh-gate@0.1.4` |
| 形态 | DSH 插件：7 个工具 + 自带 `cordis.patch.yml` + 客户端面板与状态栏圆环 |
| 目标宿主 | DeepSeek Harness ≥ 0.2.1-rc.5；Node ≥ 22.19；需已登录 `gh` CLI |

## 二、当前状态（2026-11-09）

```text
分支        main（HEAD 127bcba，PR #29 合并）
版本        0.10.11；tag v0.10.11 / gate-v0.1.4（远端已推）；release v0.10.11 = Latest
工作区      clean；安装副本 %DSH_HOME%\profiles\desktop\node_modules\... = 0.10.11（仅磁盘一致）
```

| 资产 | 数量 |
|---|---:|
| `node --test` | 952 例全过 |
| `scripts/preflight.mjs` | 42 项 = 41 PASS / 1 SKIP（`smoke:observe` 需真机宿主） |
| `scripts/ui-audit.mjs` | 11/11，100 分（写死颜色 0 / 自造 token 0） |
| `docs/kb` | 183 篇 / 9 板块（`check-docs` 五项 PASS，含总数校验） |
| `scripts/` | 67 个门禁与工装脚本 |
| GitHub Release | 326 个（含 `v0.10.11` = Latest、`gate-v0.1.4`）；历史版本仍在按批次回填 |
| CI / 分支保护 | `ci`（Node 22/24）；main 需 PR + 2 个必需检查，禁强推禁删 |

已验证（本轮实测）：

- `node --test` → 952/952；gate 包 172/172；client 167/167；update-ui 53/53；drift 18/18；
  `PANEL_STRICT` 门禁组 45/45；preflight 全量 42 项 = 41 PASS / 1 SKIP；ui-audit 11/11 = 100；
  `check-docs` 五项 PASS；`check-maintenance` 6/6；
- 真实 Chromium 47/47（安装版前端 `0.2.2-rc.1`）；门禁专项 Chromium 54/54；v5 模型专项 harness 63/63；
- `sync-profile --check` → 缺失 0 / 断链 0 / 陈旧 0 / 门禁子包漂移 0；
- `npm publish` → 主包 0.10.11 + 子包 0.1.4；PR #29 合并（merge commit `127bcba`）；main CI 绿（Node 22/24）。

未验证（不能写成"通过"）：

- **真机走查 22 项**（`docs/真机走查清单-弹层.md`）—— 需要人在界面上按 Tab/Escape、看两套主题；
- 宿主重载后 profile 运行时是否生效（本轮只声明磁盘一致，未重启 DSH）；
- 跨主机共享盘（NFS/SMB）锁语义、真实长期数据句柄占用下的 rename EPERM、不经过本锁的外部写者并发；
- 连续 24 小时运行的误唤醒率、限流表现；物理读屏 / 触摸 / IME。
- v5 的 low 发现（`docs/报告-gate-v5核心审查.md` / `docs/报告-gate-v5面板审查.md`）：L1 `sync-profile`
  的 `lib/*.js` 相对 import 失败仍在写盘后检测（本轮只收窄注释）；L2 整个 `lib/` 目录缺失时
  `readdirSync` 抛 `ENOENT`（exit 1 + 栈）；L3 第五段「TARGETS 缺源」也收 `packages/dsh-gate`；
  L4 prune 的 `minAge` 用继承 mtime；L5 Windows 大小写变体残留互不回收；Q2-L1 渲染期 ref 镜像；
  Q2-L2 `U5-M4` 把 `/gates` 请求数钉成精确 3 —— 均 low、不阻塞。
- 真实 `/gates/models` 服务端跨仓库返回；模型流的真实浏览器证据只有临时 harness（63/63，未进仓库）。

## 三、下一步

按价值排序，**不要一次混着做**：

1. 真机走查 22 项（需要用户配合，或按用户截图逐条对照）；
2. 补验跨主机共享盘锁语义与真实长期句柄下的 `rename` EPERM（v4 只用替身验证）；
3. 继续回填历史 GitHub Release（`node scripts/release-gh.mjs`，用户要求"之前的慢慢改"）；
4. 收掉 v5 的 low 残余：`sync-profile` 把 `missingImports` 计算前移到任何写盘之前（L1 从「注释收窄」
   升级为真原子）、整个 `lib/` 缺失走 `repoMissing`（L2）、第五段文案（L3）、prune 用 move 时间（L4）、
   正则加 `i`（L5）；把 v5 模型 harness 并入官方 Chromium 套件。

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
