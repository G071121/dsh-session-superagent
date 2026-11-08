# gate v5 独立验收（V1）

> 验收人：verifier（V1）。日期：2026-11-08。
> 需求来源：`docs/任务书-dsh-gate-v5.md`（提交 `49f6ad9`，在 `feat/gate-v5` 的 `dsh-gate-v4-integration` 工作树；本分支基线 `54f9052` 不含该文件，所以这里用代码路径、不做相对链接）。
> 被验实现：C1（锁残余与旧版无 token 锁）、U1（模型列表统一 panelRepo）、S1（profile 失败原子性与 preflight 主入口）。
> 本文件是 V1 写权限内的唯一产物；源码只读，未改实现文件，未重启 / 未重载 DSH，未改真实 profile。

## 一、结论

1. **三条交付分支可以进入 Q1 / Q2 审查。** 独立集成 worktree 合并三个分支后全部复跑：根 `npm test` **952/952**、
   gate 包 **172/172**、`test/client.test.mjs` **167/167**、`test/update-ui.test.mjs` **53/53**、
   `test/sync-profile-drift.test.mjs` **18/18**、`PANEL_STRICT` 门禁组 **45/45**、UI 体检 **11/11（100 分）**、
   面板文案快照 **PASS**、官方 Chromium 套件 **47/47**、v4 门禁专项 harness **54/54**、v5 模型专项 harness **63/63**；
   全部 exit 0（preflight 的两条交接项除外，见 §3.1）。
2. **先红后绿在独立探针里成立，不是只看实现方用例。**
   - C1：同一个锁探针在基线 `54f9052` 上 6 PASS / 7 FAIL（F 内容读不出来被当成可接管、I 残留不回收、J 清理失败不留证；
     C/E/H/M 是缺 `leftover` 字段 / 缺 `pruneLockArtifacts` API 的红），合并后 **13/13**。
   - U1：同一份真实 Chromium harness 对基线 `client.js`（sha `d6e65840…`）**56 PASS / 7 FAIL / 63**，
     对合并后 `client.js`（sha `b6d4e215…`）**63/63**；7 条红正好是「按钮跟 prop 仓库、闸门后不回列表、
     跨仓库列表可选中、确认前先读新仓库、取消后仍读新仓库、项目层跟 prop」。
   - S1：临时副本对照：缺 `lib/body.js` 时基线 `--repair` **先把 profile 副本 prune 掉再 exit 2**，合并后 exit 2 且磁盘零变化；
     门禁子包源目录缺失时基线 `--check` 四段全零 **exit 0**（假绿），合并后 exit 2 并点名 `packages/dsh-gate`；
     基线的主入口回退对「相对路径 / `..` / 大小写 / 无 argv / realpath 抛错」5 种写法都判成 import（静默 exit 0），
     合并后 `resolveIsMain` 全部当 CLI。
3. **下列红项不在 V1 写作用域，I1 发布前必须清掉**（V1 不算通过）：README 单测数仍写 934（实测 952）、
   `AGENTS.md` 的基线同样是 934/934；真实安装 profile 仍断链 21 / 门禁子包漂移 1（`lib/config-lock.js`、`lib/index.js`），
   需要 `--repair`；版本未 bump（`check-maintenance` 5 PASS / 1 FAIL）。
4. **本报告不宣称真机 WebView 通过。** 浏览器段是「安装版前端 0.2.2-rc.1 + loopback fixture 页面 + 真实 `client.js` +
   安装版 React 18.3.1 + 310 个 primitives 导出 + Chromium 156」；`test/fixtures/gate-panel.mjs` 的 node vm 桩只用于快速回归，
   **不**作为浏览器证据。截图通道沿用既有结论继续 SKIP（desk 0/8、orbit 0/2），不计产品失败。

## 二、环境与集成副本

| 项 | 值 |
|---|---|
| 集成 worktree | `D:/主工作区/projects/dsh-gate-v5-integration`，分支 `task/gate-v5-v1` |
| 合并来源 | `task/gate-v5-core` @ `6a582e0`、`task/gate-v5-ui` @ `9c3236a`、`task/gate-v5-scripts` @ `812df38` |
| 合并方式 | 三次 `git merge --no-ff`（`45d2b27` / `fe462c0` / `fcea433`），无冲突；相对 `54f9052` 共 **9 个文件 +942 / −107** |
| 逐分支一致性 | `git diff task/gate-v5-core HEAD -- packages/dsh-gate`、`…-ui HEAD -- client.js test/client.test.mjs`、`…-scripts HEAD -- scripts test/sync-profile-drift.test.mjs` 均为空（合并没有吃掉任何一侧改动） |
| 基线 | `54f9052`（= main，v4 发布树） |
| 运行时 | Windows 11 Pro `10.0.26200` x64、Node **v24.20.0**、npm **11.19.0** |
| Chromium / React | Chromium **156.0.8078.74**、React **18.3.1**、primitives **310** 个导出 |
| 安装版前端 | `D:/DeepSeek Harness/Desktop-0.2.2-rc.1`，asar sha256 `5fa8a6b21bceb8f3e99e30efa2270efd0cc773a11e42aa0488f804a64b34e637`，前端 `0.2.2-rc.1` |
| 版本 | 根 `0.10.10`、gate `0.1.3`（本轮未 bump，I1 负责） |
| 依赖处理 | `npm ci --offline`（5 个包）；`@mycf711/dsh-gate` 是 workspace symlink，指向本 worktree 的 `packages/dsh-gate`（不是主树副本） |
| 副本一致性（sha256 前 8 位） | `client.js` `b6d4e215…`、gate `lib/index.js` `57c2c9b2…`、`lib/config-lock.js` `1d3d03bf…`、`scripts/preflight.mjs` `9688dd0a…`、`scripts/sync-profile.mjs` `2a8d36d6…`、`test/client.test.mjs` `8a1b9e1e…`、`test/sync-profile-drift.test.mjs` `e27bc004…`、`packages/dsh-gate/test/config-lock.test.mjs` `6e4af2d7…` |
| 真实 profile | `D:/DeepSeek Harness/home/profiles/desktop`：**断链 21 / 门禁子包漂移 1**（`lib/config-lock.js`、`lib/index.js`）；本轮只读检查，未 `--repair` |

## 三、实跑计数（原始输出，不是字符串宣称）

| 命令（集成 worktree 内） | 结果 | 退出码 |
|---|---|---|
| `npm test` | `ℹ tests 952 / pass 952 / fail 0`，duration **31.2 s** | 0 |
| `cd packages/dsh-gate && npm test` | `ℹ tests 172 / pass 172 / fail 0`，duration **20.0 s** | 0 |
| `cd packages/dsh-gate && npm run check` | 5 个文件 `node --check` 通过 | 0 |
| `node --test test/client.test.mjs` | `ℹ tests 167 / pass 167 / fail 0`，duration 5.3 s | 0 |
| `node --test test/update-ui.test.mjs` | `ℹ tests 53 / pass 53 / fail 0` | 0 |
| `node --test test/sync-profile-drift.test.mjs` | `ℹ tests 18 / pass 18 / fail 0`，duration 6.2 s | 0 |
| `PANEL_STRICT=1 node --test --test-name-pattern='门禁' test/client.test.mjs` | `ℹ tests 45 / pass 45 / fail 0` | 0 |
| `node scripts/ui-audit.mjs` | `UI 体检：11/11 通过（100 分）` | 0 |
| `node scripts/render-panel-copy.mjs --check` | `PASS 面板文案与当前实现一致（178 行；最长 77 字符；超 80 字符 0 条（上限 3））` | 0 |
| `node scripts/preflight.mjs --fast --no-maintenance` | 41 行 = **37 PASS / 2 FAIL / 2 SKIP** | **1** |
| `node scripts/preflight.mjs`（完整口径） | 42 行 = **38 PASS / 3 FAIL / 1 SKIP** | **1** |
| `node scripts/check-maintenance.mjs` | 5 PASS / 1 FAIL（`自上个 tag 起未改动运行时代码`） | **1** |
| `node scripts/audit-readme-tests.mjs 952` | `FAIL README 单测数  README 写 934，实际 952（改 README）` | **1** |
| 官方 Chromium（`scripts/verify-panel-chromium.mjs`，未改） | **47/47 PASS** | 0 |
| v4 门禁专项 Chromium（临时 harness，基于官方脚本 + 门禁 fixture） | **54/54 PASS**（47 官方 + 7 项 U1） | 0 |
| v5 模型专项 Chromium（同一 harness 再扩 U5，临时文件） | **63/63 PASS** | 0 |
| **基线对照**（`54f9052` 独立副本） | `npm test` **934/934**（26.0 s）、gate **166/166**（19.2 s）、client **162/162**、update-ui **53/53**、drift **11/11**、`PANEL_STRICT` 门禁组 **40/40** | 0 |
| 基线 Chromium（同一 v5 harness + 基线 `client.js` sha `d6e65840…`） | **56 PASS / 7 FAIL / 63** | **1** |

### 3.1 红项原文（preflight 完整口径）

```
FAIL README 单测数                        README 写 934，实际 952（改 README）
FAIL profile 一致性 --check               缺失 0 / 断链 21 / 陈旧 0 / 门禁子包漂移 1（lib/config-lock.js, lib/index.js），跑 node scripts/sync-profile.mjs --repair
FAIL 维护一致性                             不一致：自上个 tag 起未改动运行时代码（未 bump 不算错，只提示）
SKIP 冒烟 smoke:observe              需要真机宿主（已列进攒批清单）
```

`--fast --no-maintenance` 少「维护一致性」一项，其余两条一致。断链 21 是集成 worktree 与 profile 硬链 inode 不同导致的副本现象；
门禁子包漂移 1（2 个文件）是 v5 C1 的真实改动未同步进 profile —— 两者都留给 I1 的 `--repair`。

### 3.2 计数对账

| 口径 | 基线 `54f9052`（独立副本实测） | 本轮 | 增量 |
|---|---|---|---|
| 根 `npm test` | **934** | **952** | **+18** = gate `config-lock` +6（23→29 条 `test(`）+ client +5（162→167）+ drift +7（11→18） |
| gate 包 | **166** | **172** | **+6** |
| `test/client.test.mjs` | **162** | **167** | **+5**（U5-M0…M4；M1/M2 内部分别循环 user/project） |
| `test/update-ui.test.mjs` | **53** | **53** | 0（未改） |
| `test/sync-profile-drift.test.mjs` | **11** | **18** | **+7**（TARGETS 原子性、门禁子包缺目录、主入口回退、import 对照、第五段） |
| `PANEL_STRICT` 门禁组 | **40** | **45** | **+5** |
| README 声称 | 934 | — | I1 要改成 **952**；`AGENTS.md` 的「934/934」同改 |

根计数与「各测试文件声明数」对得上（934 + 6 + 5 + 7 = 952），不是靠新增 fixture 文件凑数。

## 四、C1：锁残余 / 旧格式 / 全生命周期

独立探针（`/tmp/v5-probe/c1-probe.mjs` + 三个子进程）只调 `@mycf711/dsh-gate` 公开 API，
临时目录全落在 `os.tmpdir()`；基线对照是把 `git archive 54f9052 packages/dsh-gate` 解出来跑**同一份探针**。

| # | 场景 | 合并后 | 基线 `54f9052` |
|---|---|---|---|
| A | 30 轮 acquire → assertOwner → release，成功路径不留 `.lock` / `.guard` / `.stale-*` / `.release-*` | **PASS**（目录空） | PASS |
| B | 锁 token 被换成别人的值 → `release()` 返回 false，锁原样保留 | **PASS** | PASS |
| C | 真实子进程拿锁后 SIGKILL → 下一次写盘按 `owner_dead` 接管，证据带 pid、成功路径不留 `.stale-` | **PASS**（`leftover:null`） | FAIL（接管正常，但证据没有 `leftover` 字段） |
| D | 旧版无 token 锁 + 活着的所有者 → `gate_lock_timeout`、原文逐字节不动、不产生隔离文件、不写配置 | **PASS** | PASS |
| E | 旧版无 token 锁 + 所有者已死 → 按原文身份接管（`owner_dead`），成功路径不留 `.stale-` | **PASS** | FAIL（同 C：缺 `leftover`） |
| F | 锁路径是目录（EISDIR，读到 `EACCES` 类不可读）→ **fail closed**：目录原位不动、错误点名「内容不可读 / fail-closed」 | **PASS** | **FAIL：基线直接接管并写盘**（原目录被 rename 成 `.stale-*`，配置被写入） |
| G | 解析失败（空文件）+ 新鲜 → 不接管、超时、文件原位保留 | **PASS** | PASS |
| H | 解析失败（空文件）+ 超龄 → 以「超龄」为理由接管，成功路径不留 `.stale-` | **PASS** | FAIL（缺 `leftover`） |
| I | 6 份旧 `.stale-*`/`.release-*` + 1 份新鲜 + 1 个无关文件 → 只留最新 3 份（新鲜占 1 份）+ 新鲜 + 无关文件不动 | **PASS**（最终 3 份） | **FAIL：7 份全留着**（没有回收） |
| J | 接管清理连续 EPERM → 3 次有界退避后 `leftover` 点名且文件真的留着；下一次写盘回收最旧 | **PASS**（attempts=3，回收后 3 份） | **FAIL：attempts=0、没有 leftover**（失败清理静默残留） |
| K | 12 个真实子进程 × 8 轮同层写（`extends:'none'`） | **PASS**：12/12 exit 0，最终 1 条规则，锁与隔离文件清干净 | PASS |
| L | 6 进程 × 12 轮 acquire/release 快速循环（释放窗口） | **PASS**：72 次释放全成功，无残留 | PASS |
| M | `pruneLockArtifacts(lockPath, {keep:0,minAgeMs:60000})` 纯函数边界 | **PASS**（removed 1 / kept 0；无关文件不动） | FAIL（该实现没有这个 API） |

合并后 **13/13 PASS**；基线 **6 PASS / 7 FAIL**。其中 **F / I / J 是实质回归证据**，C / E / H 是
「证据字段 `leftover` 为 v5 新增」、M 是「API 为 v5 新增」——报告里分开写，不把字段缺失当行为红。
另外 gate 包 172/172 与根 952/952 都包含 C1 的 12 写者栅栏、stale 接管、release 窗口、extends 用例，
本轮至少各复跑两轮（`npm test` + `packages/dsh-gate` 单跑），均 exit 0。

边界：真实 ACL / 独占句柄不可读只用 EISDIR 复现；残留回收只发生在「下一次拿锁」；
接管者被挂起超过 60s 的回收窗口未压测（实现方 README 已声明）。

## 五、U1：模型列表统一面板仓库（panelRepo）

### 5.1 单测层（真实 `client.js` + 假 React 桩）

- `test/client.test.mjs` **167/167**；`PANEL_STRICT=1` 门禁组 **45/45**；`test/update-ui.test.mjs` 53/53。
- 新增 U5-M0（渲染护栏：别的仓库的列表不上下拉）、U5-M1（保留草稿时按钮读草稿来源，user/project 各一轮）、
  U5-M2（闸门挡住 `/gates` 时重读草稿来源、不读新仓库，user/project 各一轮）、U5-M3（迟到旧仓库列表不覆盖）、
  U5-M4（确认放弃草稿后跟新仓库）；U2-F2 改为取消路径。主面板 23 槽 / 门禁 12 槽（=35）与官方 SegmentedControl 未动，U1-F 绿。

### 5.2 真实 Chromium + 安装版 React 18（临时 harness）

harness 由 `scripts/verify-panel-chromium.mjs` 复制后只改验收夹具（`GET /gates`、`GET /gates/models`
按仓库与请求序号可延迟、可乱序；`POST /__fixture/workdir` 改 watcher workdir 让 `repo` prop 真变）。
同一份 harness 先跑合并后、再跑基线 `client.js`（只换仓库根），设备/安装/React 完全一致：

| # | 检查（合并后） | 证据 |
|---|---|---|
| U5-V0 | 切到 alpha 后模型列表跟面板仓库读一次 | alpha 请求 1 条，下拉 `group/model-alpha-1` |
| U5-V1 | 保留草稿时「读取模型列表」按草稿来源（user 作用域） | 新请求 1 条 `?repo=…alpha`；bravo 请求 0；下拉只含 alpha 模型；确认条文案完整 |
| U5-V2 | 闸门挡住 charlie 时作废在途 models、重读 bravo | 闸门后恰好 1 条 bravo（seq3）；charlie 请求 0 |
| U5-V2b | seq 更小的在途 bravo 列表（延迟 3000）迟到后不能覆盖 | 最终下拉是 seq3 的 `group/model-bravo-3`，不是 seq2 |
| U5-V3a | 渲染护栏：面板已切 delta、列表还是 charlie | 出现「已忽略，请重新读取」；下拉只剩当前值 **1 项** |
| U5-V3b | 迟到的 charlie 列表不能覆盖 delta | 最终 `group/model-delta-1`；charlie 列表不在下拉；护栏消失 |
| U5-V4 | 确认放弃草稿并切换 → 模型跟新仓库 echo | 确认前 echo 请求 **0**；确认后 echo 1 条，下拉 echo 模型 |
| U5-V5 | 取消换仓库 → 保留草稿、重读面板仓库 echo，不读 foxtrot | 取消后 echo 1 条；foxtrot 请求 **0**；草稿值仍是「U5 取消切换草稿」 |
| U5-V6 | project 作用域的同样路径 | 模型下拉 `disabled=true`；按钮读 foxtrot 1 条；golf 请求 **0** |

合并后 **63/63 PASS，0 FAIL，exit 0**；基线 `client.js` 同一 harness **56 PASS / 7 FAIL**：

| 检查 | 基线实测 |
|---|---|
| U5-V1 | **FAIL**：按钮发的是 `?repo=…bravo`（prop 仓库），下拉出现 `group/model-bravo-2` |
| U5-V2 | **FAIL**：闸门后补读的是 `charlie`（新 prop 仓库），不是草稿来源 bravo |
| U5-V2b | **FAIL**：迟到的 charlie 列表落地（下拉 `group/model-charlie-1`） |
| U5-V3a | **FAIL**：没有渲染护栏（无「已忽略」文案，下拉 3 项） |
| U5-V3b | PASS（v4 的「跨仓库迟到响应丢弃」本来就有；v5 改的是判据来源） |
| U5-V4 | **FAIL**：确认前已经读了 1 次 echo（`echoBefore=1`） |
| U5-V5 | **FAIL**：取消后仍发了 foxtrot 请求（prop 仓库），不只是 echo |
| U5-V6 | **FAIL**：project 层按钮读 golf（prop 仓库）2 条，下拉被 golf 模型污染 |

### 5.3 浏览器层的边界

- **不是真机 WebView**：没有重启/重载 DSH，也没有在真实宿主会话里点门禁面板；面板数据全部来自 loopback fixture。
- 官方 Chromium 套件本身不打开门禁分区（`/gates` 404），上面的 U5 证据来自临时 harness，**未入库**；是否并入正式套件由 Q2/I1 决定。
- 同仓库两次 `/gates` 的乱序在浏览器层仍不可稳定构造（HTTP/1.1 连接串行化）；该分支由 node 桩 U1-G3 覆盖（v4 结论沿用）。
- 真实 `/gates/models` 服务端跨仓库返回、真实模型 id 未验；fixture 只按 `?repo=` 区分。
- U5-V3a 的护栏窗口约 3 s（fixture 延迟撑开），真实机器上的窗口取决于服务端延迟；它只保证「列表仓库 ≠ 面板仓库时不上屏」。

## 六、S1：profile 失败原子性与 preflight 主入口

做法：把「合并后 HEAD」与「`54f9052`」各自 `git archive` 到临时目录，各自建一份临时 profile
（`--repair --dir <tmp>`），再注入同一组仓库侧/ profile 侧缺失；每一步对比退出码、点名文案，
以及 profile 快照（相对路径 + inode + sha256）看是否发生写盘。

| 场景 | 合并后 | 基线 `54f9052` |
|---|---|---|
| 干净副本 | `--repair` 建 profile 后 `--check` 四段全零、exit 0 | 同（对照前提） |
| 删 `bin/check.mjs`（TARGETS 缺源） | `--check` / `--repair` 都 **exit 2**、点名 `缺源 bin/check.mjs` + `TARGETS 缺源 1（bin/check.mjs）`；磁盘**零变化** | `--check` / `--repair` 也 exit 2 并点名（v4 已有），磁盘零变化 |
| 删 `lib/body.js`（profile 里还有硬链副本） | `--repair` **exit 2 且不 prune**，磁盘零变化 | **FAIL：先 `pruned lib/body.js`（profile 副本被删）再 exit 2** |
| 删 `packages/dsh-gate` 整目录（仓库侧） | `--check` / `--repair` 都 **exit 2**、点名 `packages/dsh-gate`、磁盘零变化 | **FAIL：`--check` 四段全零 exit 0（静默跳过）**，`--repair` 也 exit 0 |
| 删 profile 的 `node_modules/@mycf711/dsh-gate` 整目录 | `--check` exit 1 且点名到目录；`--repair` exit 0，`--check` 复验四段全零 | exit 1「缺失 1」但**不点名**；`--repair` 能复制修复 |
| `import` preflight（Node 24） | `IS_MAIN=false`，不跑整轮门禁（无 PASS/FAIL 行），exit 0；导出 `IS_MAIN` / `resolveIsMain` / `summarizeProfileCheck` | import 不跑门禁（`import.meta.main` 本来就有），但**没有导出** `IS_MAIN` / `resolveIsMain` |
| 主入口回退（模拟老 Node，`mainFlag=undefined`） | 相对路径 / `..` / Windows 大小写 / 无 `argv[1]` / realpath 抛错 **全部当 CLI**；另一个真实文件才当 import | **5 种写法全判成 import**（= 静默 exit 0 的形状）；只有逐字符相等的绝对路径算 CLI |
| 第五段解析 `summarizeProfileCheck` | `TARGETS 缺源 1（packages/dsh-gate）` → `clean:false` 并点名；四段全零 → `clean:true`；老三段 → `clean:false` | 基线把「四段全零 + 第五段缺源」判成 **clean:true**（看不见门禁子包缺源） |

合并后 **9/9 PASS**；基线在 **S1b / S2 / S3（点名）/ S4b / S4c** 上红（S1a 的红在 v4 已修过，v5 只负责「写前失败」）。
真实 profile 未跑 `--repair`：preflight 仍报断链 21 / 门禁子包漂移 1，按任务书留给 I1；本报告只声明副本脚本在临时目录里的行为。

## 七、代码审查（只读）

| # | 严重度 | 位置 | 问题 | 建议 |
|---|---|---|---|---|
| R1 | low | `client.js:2455` 附近（`panelRepoOf` + `panelRepoRef.current = panelRepo`） | 在 render 期间写 ref（延续既有 `repoRef` / `dataRef` 的写法）。React 18 并发渲染下被丢弃的 render 也可能改 ref，async 回调可能读到「没提交的那次面板仓库」 | 生产构建单根同步更新、本轮 Chromium 未复现；如要更稳，把镜像写入挪进 `useEffect` 或在注释里写明前提 |
| R2 | info | `packages/dsh-gate/lib/config-lock.js`（`pruneLockArtifacts`） | README 写「每个锁路径最多保留最新 3 份」，实现是「前 3 名（含新鲜）+ 未过 60s 的所有文件」，所以实际保留数可能 >3（新鲜文件不计入上限） | 功能符合「有界留证」目标；措辞可改成「最多 3 份旧的 + 尚未过龄的」 |
| R3 | info | `packages/dsh-gate/lib/index.js`（HTTP 保存路由） | `lock.broken[].leftover` 只在 API 返回值里；HTTP 把 `gate_lock_timeout` 折成 400 `save_failed`，面板看不到 `broken/leftover`（v4 R5 沿用） | 面板只需要错误文案，可接受；运维排障时按磁盘 `.stale-*` 找证据 |
| R4 | info | `scripts/sync-profile.mjs` / `scripts/preflight.mjs` | 第五段仍叫「TARGETS 缺源」，现在同时承载「门禁子包源目录缺失」 | 功能正确；可在文案里补一句「含门禁子包源目录」避免误读 |
| R5 | info | `scripts/preflight.mjs`（`resolveIsMain`） | 两个不同 specifier 指向同一 realpath 时判 CLI（会多跑一轮而不是静默） | 符合「宁可多跑，不许静默不跑」的方向，保留 |
| R6 | info | 临时 Chromium harness | v5 模型专项（9 条检查）只在 `/tmp`，未入库 | Q2 / I1 决定是否把 `/gates/models` 往返并入正式套件 |

## 八、I1 发布前必须处理（V1 不算通过的部分）

1. README 单测数 **934 → 952**，`AGENTS.md` 的「934/934」同步；CHANGELOG 补 v5 口径：门禁子包源目录缺失 = 退出码 2、
   第五段「TARGETS 缺源」也覆盖门禁子包、锁残余「最新 3 份 + 60s」回收、旧版无 token 锁 fail closed、
   `resolveIsMain` 的回退语义。README 的「42 项 preflight / 11 项 UI / 47 项 Chromium」不变。
2. 对真实 profile 执行 `node scripts/sync-profile.mjs --repair`，再 `--check` 到 **缺失 0 / 断链 0 / 陈旧 0 / 门禁子包漂移 0**
   且第五段不出现；只声明磁盘一致，**不声明宿主运行时生效**（要重载后另验）。
3. 版本 bump：根下一 patch、gate 按真实变更 bump（`packages/dsh-gate/package.json`、`PACKAGE_VERSION`、测试断言、根依赖），
   让 `check-maintenance` 6/6；CHANGELOG 写清 C1 / U1 / S1。
4. 合并 main 后按最终树复跑全量（本报告的 952 是集成分支数字），`npm pack`、TARGETS 派生守卫、preflight、Chromium 跟 bump 复跑。
5. （建议）把 v5 模型专项 Chromium harness 并入正式套件，或在 Q2 报告里明确「不并」的理由。

## 九、未验项 / 边界

- **不是真机 WebView**：没有重启 / 重载 DSH，没有在真实宿主会话里点门禁面板；profile 安装副本仍是旧内容（§八）。
- 未验物理读屏 / 触摸 / IME、真实 GitHub / Gitee 写操作、真实模型调用、真实 watcher 状态变化。
- 跨主机共享盘（NFS / SMB）上的写锁语义、真实长期文件句柄占用下的 rename EPERM：实现方已声明未验，本轮沿用。
- 锁内容不可读只用 EISDIR（目录占位）复现；真实 ACL / EBUSY 句柄未验；残留回收只在下次拿锁时发生；
  「接管者被挂起 >60s」的回收窗口未压测。
- 老 Node（<22.18，无 `import.meta.main`）没有二进制实跑：回退分支由 `resolveIsMain` 纯函数 + 基线的等价复刻对照覆盖。
- 同仓库 `/gates` 乱序在浏览器层不可稳定构造（§5.3）；`/gates/models` 的真实服务端跨仓库返回未验。
- CI 矩阵 Node 22 / 24 未跑（本机 Node 24.20；`import.meta.main` 需要 22.18+，engines >=22.19）。
- 截图通道 SKIP（desk 0/8、orbit 0/2），没有拿截图当任何证据。

## 十、证据文件（临时，不进仓库）

| 文件 | 内容 |
|---|---|
| `/tmp/v5/root-test.log` / `gate-test.log` / `client-test.log` / `update-ui-test.log` / `drift-test.log` / `panel-strict.log` | §三 合并后计数原始输出 |
| `/tmp/v5/baseline-*.log`（root/gate/client/update-ui/sync-profile-drift/panel-strict） | §3.2 基线计数 |
| `/tmp/v5/ui-audit.log` / `panel-copy.log` / `preflight-fast.log` / `preflight-full.log` / `maintenance.log` / `readme-tests.log` | UI 体检、文案快照、preflight 红项原文 |
| `/tmp/v5/chromium-official.log` | 官方 Chromium 套件 47/47 |
| `/tmp/v5/chromium-base.log` | v4 门禁专项 harness 54/54 |
| `/tmp/v5/chromium-u5.log` / `chromium-u5-baseline.log` | v5 模型专项：合并后 63/63、基线 client 56/7（同一 harness） |
| `/tmp/v5/c1-probe.log` / `c1-probe-baseline.log` | §四 C1 探针 13/13 与基线 6/7 |
| `/tmp/v5/s1-probe.log` | §六 S1 探针 9/9（含 `BASELINE S1a…S4b` 对照行） |
| `/tmp/v5-probe/c1-probe.mjs`（sha256 `90693f3f…`）+ `c1-holder/writer/cycler.mjs` | §四 探针（只走公开 API，临时目录在 `os.tmpdir()`） |
| `/tmp/v5-probe/s1-probe.mjs`（sha256 `c9786504…`） | §六 探针（`git archive` 临时副本 + profile 快照） |
| `/tmp/v5-probe/gate-race-v5-base.mjs`（sha256 `bae98f75…`）/ `gate-race-v5-u5.mjs`（sha256 `8e3a2d9a…`） | Chromium 门禁/模型 harness（基于官方脚本复制，未改仓库脚本） |

本报告单独提交在 `task/gate-v5-v1`（提交信息 `docs: gate v5 独立验收报告（V1）`），提交后工作树干净。
