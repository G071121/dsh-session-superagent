# gate v6 独立验收（V1）

> 验收人：verifier（V1）。日期：2026-11-09。
> 需求来源：`docs/任务书-dsh-gate-v6.md`（提交 `c3753a1`，= main `7846678` + 该任务书）。
> 被验实现：C1（锁残留回收按「搬走时间」计龄 + 大小写语义跟随文件系统）、S1（profile 真原子与错误分类）、
> B1（模型来源 Chromium 场景入库）。
> 本文件是 V1 写权限内的唯一产物；源码只读，未改实现文件，未重启 / 未重载 DSH，未改真实 profile。

## 一、结论

1. **三条交付分支可以进入 Q1 / Q2 审查。** 独立集成 worktree 合并三个分支后全部复跑：根 `npm test` **965/965**、
   gate 包 **180/180**、`test/client.test.mjs` **168/168**、`test/sync-profile-drift.test.mjs` **22/22**、
   `PANEL_STRICT` 门禁组 **46/46**、UI 体检 **11/11（100 分）**、面板文案快照 **PASS**、
   官方正式 Chromium 套件 **64/64（exit 0）**；其余 audit 全 PASS。
   失败只有 preflight 的两条**交接项**（§3.1），都不在 V1 写作用域内。
2. **先红后绿在独立探针里成立，不是只看实现方用例。** 同一份探针分别跑「合并树」与「基线 `c3753a1`」：
   - **C1**（`packages/dsh-gate` 公开 API，9 项）：合并树 **9/9**，基线 **2 PASS / 7 FAIL**。
     红点是「5 分钟前的 stale 锁搬成证据后生下来就够旧 → 并发 prune 在『搬走 → 核对』窗口里删掉它」
     （L4a/L4b/L4c）、「名字里的时间戳不是权威 → 旧证据靠 touch mtime 永驻」（L4d）、
     「Windows 上 `.STALE-` / `.RELEASE-` 永远不回收（有界失效）」（L5/L5b/L5c）。
   - **S1**（临时副本 `--dir`，8 项）：合并树 **8/8**，基线 **2 PASS / 6 FAIL**。
     红点是「相对 import 缺失时 `--repair` **先改盘再 exit 2**」（S1a/S1a2）、
     「整个 `lib/` 目录在仓库里缺失 → 逐条刷 10 行『陈旧』+ `ENOENT` 栈 + exit 1」（S1b）、
     「profile 侧整个 `lib/` 缺失 → `readdirSync` 抛 `ENOENT` 栈」（S1c）、
     「`packages/dsh-gate` 被塞进『TARGETS 缺源』且仍建议 `--repair`」（S1e/S1f）。
   - **B1** 的红是**覆盖红**（不是产品红）：基线正式套件 47 条场景里 **0 条**打 `/gates` 或 `/gates/models`，
     合并后 64 条含全部 17 条门禁/模型场景；且 `client.js` 两边 sha256 完全相同（`c6fe935d…`）——
     B1 只是把 v5 的临时 harness 收进仓库，不改变产品行为。
3. **下列红项不在 V1 写作用域，I1 发布前必须清掉**（V1 不算通过）：README 单测数仍写 **953**（合并树实测 **965**）；
   真实安装 profile 仍 **断链 21 / 门禁子包漂移 1（`lib/config-lock.js`）**，需要 `--repair`；
   版本未 bump（`packages/dsh-gate` 仍 `0.1.4`、根仍 `0.10.11`）。
4. **本报告不宣称真机 WebView 通过。** 浏览器段是「安装版前端 `0.2.2-rc.1` + loopback fixture 页面 +
   仓库里真实 `client.js` + 安装版 React 18.3.1 + 310 个 primitives 导出 + Chromium 156.0.8078.74」；
   `/gates`、`/gates/models`、`POST /gates` 全部是脚本自带 fixture。截图通道沿用既有结论继续 SKIP
   （desk 0/8、orbit 0/2），不计产品失败。

## 二、环境与集成副本

| 项 | 值 |
|---|---|
| 集成 worktree | `D:/主工作区/projects/dsh-gate-v6-integration`，分支 `task/gate-v6-integration` |
| 合并来源 | `task/gate-v6-core` @ `133a398`、`task/gate-v6-scripts` @ `dfe5a62`、`task/gate-v6-browser` @ `fc35b4b` |
| 合并方式 | 三次 `git merge --no-ff`（`2b9bad4` / `f5dc66d` / `628a32a`），无冲突；相对 `c3753a1` 共 **9 个文件 +1250 / −103** |
| 逐分支一致性 | `git diff task/gate-v6-core HEAD -- packages/dsh-gate/{README.md,lib/config-lock.js,test/config-lock.test.mjs}`、`…-scripts HEAD -- scripts/{preflight,sync-profile}.mjs test/sync-profile-drift.test.mjs`、`…-browser HEAD -- README.md scripts/verify-panel-chromium.mjs test/client.test.mjs` **全部为空**（合并没有吃掉任何一侧改动） |
| 基线 | `c3753a1`（= main `7846678` + v6 任务书；两者仅差该文档）。基线计数在独立 worktree `task/gate-v6-v1-baseline` 实测，测完已删除 |
| 运行时 | Windows 11 Pro `10.0.26200` x64、Node **v24.20.0**、npm **11.19.0** |
| Chromium / React | Chromium **156.0.8078.74**、React **18.3.1**、primitives **310** 个导出 |
| 安装版前端 | `D:/DeepSeek Harness/Desktop-0.2.2-rc.1`，asar sha256 `5fa8a6b21bceb8f3e99e30efa2270efd0cc773a11e42aa0488f804a64b34e637`，前端 `0.2.2-rc.1` |
| 版本 | 根 `0.10.11`、gate `0.1.4`（本轮未 bump，I1 负责） |
| 依赖处理 | `npm install --prefer-offline`（5 个包）；`@mycf711/dsh-gate` 是 workspace symlink，指向本 worktree 的 `packages/dsh-gate`（不是主树副本） |
| 副本一致性（sha256 前 8 位） | `client.js` `c6fe935d`、gate `lib/index.js` `c69daf19`、`lib/config-lock.js` `67501b02`、`scripts/preflight.mjs` `8304fca0`、`scripts/sync-profile.mjs` `2f42f695`、`scripts/verify-panel-chromium.mjs` `d78b9986`、`test/client.test.mjs` `b681f552`、`test/sync-profile-drift.test.mjs` `20ccf642`、`packages/dsh-gate/test/config-lock.test.mjs` `d51168b7`、`README.md` `9730be8e` |
| 真实 profile | `D:/DeepSeek Harness/home/profiles/desktop/node_modules/dsh-session-superagent`：**断链 21 / 门禁子包漂移 1**（`lib/config-lock.js`）。本 worktree 只读检查，未 `--repair`（§3.3 证明是副本路径现象） |

## 三、实跑计数（原始输出，不是字符串宣称）

| 命令（集成 worktree 内） | 结果 | 退出码 |
|---|---|---|
| `npm test` | `ℹ tests 965 / pass 965 / fail 0`，duration **38.7 s** | 0 |
| `npm run check`（第二次全量） | `ℹ tests 965 / pass 965 / fail 0`，duration **25.1 s** | 0 |
| `cd packages/dsh-gate && npm test` | `ℹ tests 180 / pass 180 / fail 0`，duration **18.1 s** | 0 |
| `cd packages/dsh-gate && npm run check` | 5 个文件 `node --check` 通过 | 0 |
| `node scripts/test.mjs test/client.test.mjs` | `ℹ tests 168 / pass 168 / fail 0`，duration 4.8 s | 0 |
| `node scripts/test.mjs test/sync-profile-drift.test.mjs` | `ℹ tests 22 / pass 22 / fail 0`，duration 6.6 s | 0 |
| `PANEL_STRICT=1 node scripts/test.mjs --test-name-pattern='门禁' test/client.test.mjs` | `ℹ tests 46 / pass 46 / fail 0` | 0 |
| `node scripts/ui-audit.mjs` | `UI 体检：11/11 通过（100 分）` | 0 |
| `node scripts/render-panel-copy.mjs --check` | `PASS 面板文案与当前实现一致（178 行；最长 77 字符；超 80 字符 0 条（上限 3））` | 0 |
| `node scripts/verify-readme-claims.mjs` | `PASS README 的说法与代码一致（8 组）` | 0 |
| `node scripts/audit-syntax.mjs` | `PASS 语法 node --check  78 个文件` | 0 |
| `node scripts/audit-tmp-dirs.mjs` | `PASS 临时目录收口` | 0 |
| `node scripts/audit-duplicate-copy.mjs` | 扫描 4 个文件，整句（≥16 汉字）重复 **0** 处 | 0 |
| `node scripts/audit-docs-all.mjs` | 工具名 / 路由 / 版本号 / 文件路径 **全 PASS** | 0 |
| `node scripts/check-maintenance.mjs` | **6 项通过** | 0 |
| `node scripts/preflight.mjs --fast --no-maintenance` | 41 行 = **37 PASS / 2 FAIL / 2 SKIP** | **1** |
| `node scripts/preflight.mjs`（完整口径） | 42 行 = **39 PASS / 2 FAIL / 1 SKIP** | **1** |
| `node scripts/audit-readme-tests.mjs 965` | `FAIL README 单测数  README 写 953，实际 965（改 README）` | **1** |
| 官方正式 Chromium（`scripts/verify-panel-chromium.mjs`） | **64 PASS / 0 FAIL / total 64** | 0 |
| **基线对照**（`c3753a1` 独立 worktree 实测） | 根 `npm test` **952/952**（39.0 s）、gate **172/172**（17.8 s）、client **167/167**、drift **18/18**、`PANEL_STRICT` 门禁组 **45/45** | 0 |
| 基线官方 Chromium（同一脚本 `c3753a1` 版本） | **47 PASS / 0 FAIL / total 47** | 0 |

### 3.1 红项原文（preflight 完整口径）

```
FAIL README 单测数                        README 写 953，实际 965（改 README）
FAIL profile 一致性 --check               缺失 0 / 断链 21 / 陈旧 0 / 门禁子包漂移 1（lib/config-lock.js），跑 node scripts/sync-profile.mjs --repair
SKIP 冒烟 smoke:observe              需要真机宿主（已列进攒批清单）
```

`--fast --no-maintenance` 少「门禁自检」（`21/21 项注入都被检测到（26/42 项有注入）`，PASS）与「维护一致性」（PASS），
其余两条一致。断链 21 是集成 worktree 与 profile 硬链 inode 不同导致的副本现象，门禁子包漂移 1 是 v6 C1 的真实改动
未同步进 profile —— 两者都留给 I1 的 `--repair`（§3.3 已在副本上证明可修到全绿）。

### 3.2 计数对账

| 口径 | 基线 `c3753a1`（独立 worktree 实测） | 本轮合并树 | 增量 |
|---|---|---|---|
| 根 `npm test` | **952** | **965** | **+13** = gate `config-lock` **+8**（`172→180`）+ client **+1**（`167→168`）+ drift **+4**（`18→22`） |
| gate 包 | **172** | **180** | **+8**（全部是 `v6 C1：…` 前缀的新用例） |
| `test/client.test.mjs` | **167** | **168** | **+1**（`浏览器证据入库：…` 静态护栏；U5-M4 把 `3` 改成语义下界 `>=2`，条数不变） |
| `test/sync-profile-drift.test.mjs` | **18** | **22** | **+4**（第五段分类、相对 import 写前失败、仓库侧 `lib/` 缺失、profile 侧 `lib/` 缺失） |
| `PANEL_STRICT` 门禁组 | **45** | **46** | **+1**（静态护栏用例名含「门禁」，被 `--test-name-pattern='门禁'` 选中） |
| UI 体检 | 11 | 11 | 0 |
| 官方 Chromium 套件 | **47** | **64** | **+17**（U1-V0…V6 共 7 条 + U5-V0…V6b 共 10 条） |
| README 声称 | 953 | — | I1 要改成 **965**；README 的「42 项 preflight / 11 项 UI / 64 项 Chromium」三项**本轮实测相符** |

根计数与「各测试文件声明数」对得上（952 + 8 + 1 + 4 = 965），不是靠新增 fixture 文件凑数。

### 3.3 真实 profile 的断链 21 是副本路径现象（非产品缺陷）

三组实测（同一台机器、同一个真实 profile，只换跑脚本的 worktree）：

| 跑脚本的 worktree | `--check` 结果 | 退出码 |
|---|---|---|
| `dsh-gate-v5-integration`（`c3753a1`，**profile 硬链的源**） | `缺失 0 / 断链 0 / 陈旧 0 / 门禁子包漂移 0` | **0** |
| `dsh-gate-v6-integration`（本树，直接指向真实 profile） | `缺失 0 / 断链 21 / 陈旧 0 / 门禁子包漂移 1（lib/config-lock.js）` | **1** |
| 本树 + **真实 profile 的完整副本**（`--dir` 指副本） | `--check` 1 → `--repair`（`本次处理 22 个`）→ `--check` **四段全零** | 1 → 0 → **0** |

结论：`断链 21` 全部是「profile 的硬链指向另一个 worktree 路径」，`门禁子包漂移 1` 是 v6 C1 改了
`packages/dsh-gate/lib/config-lock.js` 而 profile 还是旧内容。本树能把**真实 profile 的完整副本**修到四段全零，
说明脚本本身没问题；真实 profile 保持只读，`--repair` 留给 I1。

## 四、C1：锁回收边界（prune 计龄 mtime / 大小写）

独立探针 `/tmp/v6-v1/probe-c1.mjs`（sha256 `209fd006…`）只调 `packages/dsh-gate` 的公开 API
（`acquireGateConfigLock` / `gateLockPath` / `gateGuardPath` / `pruneLockArtifacts` / `projectGatePath`），
临时目录全在 `os.tmpdir()`；基线对照是把 `git archive c3753a1 packages/dsh-gate` 解出来跑**同一份探针**。

| # | 场景 | 合并后 | 基线 `c3753a1` |
|---|---|---|---|
| L4a | 所有者已死 + 源锁 mtime 5 分钟前 → 接管搬走后证据的 mtime **是搬走时间** | **PASS**（`mtimeAge=28ms`） | **FAIL：`300036ms`**（`rename` 把源锁旧 mtime 一起搬走） |
| L4b | 上一条留下的证据再 `pruneLockArtifacts({keep:0,minAgeMs:60000})` → **不许回收** | **PASS**（`removed=0`） | **FAIL：被回收 1 份**（在途证据被删） |
| L4c | 注入 `rename` 在「搬走 → 核对」窗口并发 prune → 不许回收隔离文件、接管仍完成 | **PASS**（`raced.removed=0`，`broken.length=1`） | **FAIL：并发 prune 删掉了正在核对的隔离文件** |
| L4d | 名字说「10 分钟前搬走」、mtime 被 touch 成刚刚 → 按名字时间戳判旧 | **PASS**（`removed=1`） | **FAIL：`removed=0`**（旧证据靠 touch mtime 永驻，有界失效） |
| L5 | `.stale-` / 大写 `.STALE-` / 大写 `.RELEASE-` / `.release-` + 4 个无关文件 | **PASS**：`caseInsensitive:false` 只回收 2 个小写；`caseInsensitive:true` 再回收 2 个大写；**4 个无关文件一个不动** | **FAIL**：`caseInsensitive:true` 下 `removed=[]`（大写变体永远不回收） |
| L5b | 默认语义跟随平台（win32 不区分 / POSIX 区分） | **PASS**（`platform=win32 removed=1`） | **FAIL：`removed=0`** |
| L5c | 守护锁路径的残留同规则，且不被主锁的回收顺带删掉 | **PASS**（`lock.removed=0 guard.removed=1`） | **FAIL**：刚搬走的守护锁证据被当旧残留回收 |
| R1 | 30 轮 `acquire → assertOwner → release` 成功路径不留 `.lock` / `.guard` / `.stale-*` / `.release-*` | **PASS**（目录空） | PASS |
| R2 | 旧版无 token 锁 + 所有者已死 → 按原文身份接管并留证（`reason=owner_dead`） | **PASS** | PASS |

合并后 **9/9 PASS**；基线 **2 PASS / 7 FAIL**。另外 gate 包 180/180 与根 965/965 都包含 C1 的 12 写者栅栏、
stale 接管、release 窗口、extends 用例，本轮各复跑两轮（`npm test` + `packages/dsh-gate` 单跑），均 exit 0。

**实现要点（只读审查）**：`takeOverStale` 用同一个 `movedAt` 同时生成文件名里的 `<ts>` 与 `utimes` 刷 mtime；
`artifactTimeMs` 优先取名字里的 `<ts>`（10–16 位、`>= 2001-09-09`、不超前 24h），取不到才退回 mtime；
`artifactPatterns(base, {caseInsensitive})` 把基名与后缀一起按 flags 匹配，`caseInsensitive` 默认 `platform === 'win32'`。

边界：真实 ACL / 独占句柄不可读只用 `EISDIR` 复现；残留回收只发生在「下一次拿锁」；
接管者被挂起超过 60s 的回收窗口未压测（实现方 README 已声明）；SMB / NFS 共享盘上的大小写与 mtime 语义未验。

## 五、S1：profile 真原子与错误分类

做法：`git archive` 把「合并树 HEAD」与「基线 `c3753a1`」各解到同一卷的临时目录，各自
`--repair --dir <tmp>` 建一份 profile，再注入同一组仓库侧 / profile 侧缺失；每一步对比退出码、点名文案，
以及 profile 快照（相对路径 + sha256）看是否发生写盘。探针 `/tmp/v6-v1/probe-s1.mjs`（sha256 `1adc3bd4…`）。

| 场景 | 合并后 | 基线 `c3753a1` |
|---|---|---|
| 干净副本 | `--repair` 后 `--check` `缺失 0 / 断链 0 / 陈旧 0 / 门禁子包漂移 0`，exit 0 | 同（对照前提） |
| **相对 import 缺失**（`lib/body.js` 多一条 `./definitely-missing-module.js`，同时预置断链 / 陈旧 / 门禁子包漂移） | `--check` / `--repair` 都 **exit 2**、点名 `import   body.js -> ./definitely-missing-module.js`；磁盘**零变化** | **FAIL：`--repair` 改了 profile**（先 `relinked lib/body.js` / `pruned lib/zzz-stale.js` / `recopied …` 再 exit 2） |
| 同上，看汇总行 | `缺失 0 / 断链 0 / 陈旧 0 / 门禁子包漂移 0 / 相对 import 缺失 1（body.js -> ./definitely-missing-module.js）` | **FAIL：汇总行完全没有这一段**（只有四个 0） |
| **整个 `lib/` 目录在仓库里缺失** | `--check` / `--repair` 都 **exit 2**、点名 `缺源     lib/`、汇总 `lib 目录缺失 1（lib）`；**不逐文件刷 10 行**、不抛 `ENOENT`、磁盘零变化 | **FAIL：exit 1 + `ENOENT` 栈**；先刷 10 行「陈旧 lib/*.js」再崩 |
| **profile 侧整个 `lib/` 目录缺失**（`--repair` 能修） | `--check` **exit 1**、`缺失 10 / 断链 0 / 陈旧 0 / 门禁子包漂移 0` + 点名 `缺失     lib/（profile 里没有整个 lib 目录…）`；`--repair` exit 0，复验全绿 | **FAIL：`readdirSync` 抛 `ENOENT` 栈**（exit 1 但是崩溃形状，`--check` 永远红不了） |
| **TARGETS 缺源**（删 `bin/check.mjs`） | exit 2、点名 `缺源     bin/check.mjs`、汇总 `TARGETS 缺源 1（bin/check.mjs）` | PASS（v5 已修） |
| **门禁子包源缺失**（删 `packages/dsh-gate` 整目录） | exit 2、汇总 `门禁子包源缺失 1（packages/dsh-gate）`，**不算进 TARGETS 缺源** | **FAIL：汇总写成 `TARGETS 缺源 1（packages/dsh-gate）`**（v5 Q1 L3 的措辞问题） |
| `summarizeProfileCheck` 的 clean 语义 | 四段全零 + 无第五段 → `clean:true` 且 `detail` 只有三个数；四类仓库侧缺源**各自** `clean:false` 且都提示「仓库侧问题（--repair 修不了）」；profile 侧漂移才提示 `--repair`；空输出 `clean:false` | **FAIL**：`TARGETS 缺源` 仍说「清单条目不成立（--repair 修不了）」，五段分类未实现 |

合并后 **8/8 PASS**；基线 **2 PASS / 6 FAIL**。真实 profile 未跑 `--repair`，只做了 §3.3 的副本证明。

## 六、B1：模型来源场景入库（仓库内可复跑）

### 6.1 正式 Chromium 套件（真实浏览器）

同一条命令（worktree 根，Git Bash）：

```bash
REPO_W=$(pwd -W) && { echo "process.env.DSH_SUPERAGENT_REPO='$REPO_W'"; cat scripts/verify-panel-chromium.mjs; } | ego-browser nodejs
```

`SUMMARY {"passed":64,"failed":0,"total":64,"chromium":"156.0.8078.74","repoVersion":"0.10.11",`
`"clientSha256":"c6fe935d…","scriptSha256":"d78b9986…","frontendVersion":"0.2.2-rc.1",`
`"asarSha256":"5fa8a6b2…","exitCode":0}` —— 跑的就是提交里的 `client.js`（`c6fe935d…`）与
`scripts/verify-panel-chromium.mjs`（`d78b9986…`）。**64 PASS / 0 FAIL / exit 0**，SKIP 14 全是截图通道
（desk 0/8、orbit 0/2 + 12 张单项），按既有约定不记为产品 FAIL。

17 条新增场景（全部 PASS，摘原始 detail 的关键判据）：

| # | 场景 | 关键证据 |
|---|---|---|
| U1-V0 | 门禁分区真实渲染且第一次读取由真实 effect 发出 | `GET /session-superagent/gates?repo=…/apple` seq 1 一条 |
| U1-V1 | 乱序（跨仓库）：迟到的旧仓库响应不覆盖新仓库数据 | 落地值 `仓库 …/banana 的提示词 #1`，旧仓库 seq 1 迟到 2000ms 未上屏 |
| U1-V2 | 在途 dirty：响应回来时不清掉新草稿 | `value=手工草稿-未保存`，`savebar=未保存放弃保存` |
| U1-V3 | 乱序（同仓库）：先发的后到不能覆盖最新一次读取 | 最终 `…/damson 的提示词 #3`（`seq 3, delay 0`） |
| U1-V4 | 取消换仓库：保留草稿且不去读新仓库 | `elderBefore=0`、`elderAfterCancel=0`、草稿仍是「保存前草稿-保留」 |
| U1-V5 | targetRepo：保存/预览写的是 GET 回显的 `data.repo` | `previewBody.repo=…/damson`、`saveBody.repo=…/damson`（不是刚切过去的仓库） |
| U1-V6 | 保存成功后按当前仓库重读并清掉保留草稿提示 | 重读 `…/elder 的提示词 #2`，提示条消失 |
| U5-V0 | 切仓库后模型列表跟随面板仓库读取（alpha） | `["group/deepseek-v4.1-flash-1017","group/model-alpha-1","group/shared-alpha"]` |
| U5-V1（M1 user） | 保留草稿时按钮只读草稿来源 alpha，不读新仓库 bravo | 新请求 1 条 `repo=…/alpha`；下拉含 `model-alpha-2`、**不含 bravo 模型** |
| U5-V2（M2） | 闸门挡住 charlie 时重读 bravo models（`>=1`）、没有 charlie 请求 | `restoredRows=[bravo seq 3]`、`charlie=[]` |
| U5-V2b | 被作废的在途 bravo 列表（seq 更小）迟到后不能覆盖最新列表 | 最终 `model-bravo-3`（seq 2 delay 3000 被作废） |
| U5-V3a | 渲染护栏：面板已切 delta、列表还是 charlie 时提示忽略，下拉只剩当前值 | `guard={visible:true, options:1}` |
| U5-V3b | 迟到的 charlie 列表不能覆盖 delta，护栏消失 | 最终 `model-delta-1`，`stale=false` |
| U5-V4（M4） | 确认放弃草稿并切换：模型列表跟着切到 echo（`>=1`），不含 delta 模型 | `echoBefore=0`，确认后 echo seq 1 |
| U5-V5（U2-F2） | 取消换仓库：保留草稿、重读 echo 模型、不读 foxtrot | `fresh=[echo seq 2]`、`foxtrot=[]` |
| U5-V6a | 项目层前提：作用域可切「项目」、模型下拉禁用、草稿能变脏 | `scopeSwitch.ok=true`、`projectDisabled=true`、`dirty=true` |
| U5-V6b（M1 project） | 项目层保留草稿：确认条在、按钮读草稿来源 foxtrot，不读 golf | `fresh=[foxtrot seq 2]`、`golf=[]` |

**先红后绿（覆盖红）**：基线 `c3753a1` 的同一脚本 **47 PASS / 0 FAIL / total 47**，
其中 `check('U1-…')` / `check('U5-…')` 计数为 **0**（合并后 17）；`client.js` 两边 sha256 相同
（`c6fe935d…`）—— 即 v5 修好的面板行为本来就有，v6 的交付物是**把证据搬进仓库、一条命令可复跑**。

### 6.2 单测层护栏

`test/client.test.mjs` 新增静态护栏（**+1**，168/168 绿）：断言正式套件里必须含 8 条点名场景、
`GET /gates` 与 `GET /gates/models` 两个 fixture、`/__fixture/gate-delays` 与 `/__fixture/model-delays`
两个延迟注入开关；**代码行**里不许出现 `/tmp/`（注释里的「不依赖 /tmp 探针」正是要保留的说明），
且必须写明「不是真实 WebView」。另把 U5-M4 的 `api.pending.length === 3` 改成语义下界 `>= 2`
（v5 面板审查 Q2-L2：把两条 load 合并成一条是合理优化，钉精确次数会假红）。

### 6.3 浏览器层的边界

- **不是真机 WebView**：没有重启 / 重载 DSH，没有在真实宿主会话里点门禁面板；`/gates`、`/gates/models`、
  `POST /gates/preview`、`POST /gates` 全部打脚本自带的 loopback fixture，**不是真实服务端、不是真实模型**。
- 同仓库两次 `/gates` 的乱序在浏览器层仍不可稳定构造（HTTP/1.1 连接串行化），该分支由 node 桩 U1-G3 覆盖。
- 真实 `/gates/models` 服务端跨仓库返回、真实模型 id 未验；fixture 只按 `?repo=` 区分。
- 未验物理读屏 / 触摸 / IME、真实 GitHub / Gitee 响应、真实 watcher 状态变化。

## 七、代码审查（只读）

| # | 严重度 | 位置 | 问题 | 建议 |
|---|---|---|---|---|
| R1 | low | `scripts/check-maintenance.mjs:71` | 「自上个 tag 起未改动运行时代码」只 `git diff v0.10.11..HEAD -- lib/ client.js`，**不扫 `packages/dsh-gate/lib/**` 与 `scripts/`**。v6 只改了子包运行时（`lib/config-lock.js`），这条却报「干净」—— 若 I1 只看这一行决定是否 bump，会漏掉 `packages/dsh-gate` 的版本 bump（正是 v4 F8 / v5 假绿的发布层同形） | 把 `packages/dsh-gate/lib`、`packages/dsh-gate/bin`、`packages/dsh-gate/gates` 并入扫描；或至少把提示文案改成「根插件运行时代码」 |
| R2 | info | `README.md:147` | 单测数仍写 953，合并树实测 965（`audit-readme-tests 965` 红） | I1 回填 **965**（preflight / UI / Chromium 三项本轮实测相符，不用改） |
| R3 | info | `scripts/sync-profile.mjs:108` `scanMissingImports` | 只认**行首** `import …` 且只认单引号：`export … from './x.js'`、双引号、`import('./x.js')` 动态导入都不扫。当前 `lib/*.js` 全是单引号静态 import（已 grep 确认 0 处双引号 / 0 处 `export … from`），但这是个「新写法静默漏检」的口子 | 与 TARGETS 的派生守卫同类：可在 `test/sync-profile-drift.test.mjs` 加一条「lib/ 里只允许单引号静态 import」的静态断言，或把扫描扩到 `export … from` |
| R4 | info | `packages/dsh-gate/lib/config-lock.js` `artifactTimeMs` | 名字里的 `<ts>` 超过 `now + 24h` 视为「不是时间戳」而退回 mtime；时钟回拨超过 24h 的机器上，刚搬走的证据会被当成旧残留（与 v5 行为一致，不是回归） | 可接受；如要更稳可把「未来时间戳」也按「新鲜」保护 |
| R5 | info | `scripts/preflight.mjs` `summarizeProfileCheck` | 四段仓库侧缺源靠**文案正则**从 stdout 解析（`/lib 目录缺失 (\d+)/` 等），改文案会静默降级为「detail 缺段」 | 已有用例逐字钉住（`test/sync-profile-drift.test.mjs` 第五段四条），改文案会立刻红，可接受 |
| R6 | info | `packages/dsh-gate/lib/config-lock.js` `pruneLockArtifacts` | `caseInsensitive` 默认 `process.platform === 'win32'`；WSL 挂载的 `/mnt/c`（Node 报 `linux`）上 `.STALE-` 与 `.stale-` 是同一命名空间，会被判成「不同文件」而不回收 | 文档已写入「按平台判定」；如需覆盖 WSL 可加 `DSH_GATE_ARTIFACT_CASE_INSENSITIVE` 覆盖 |

## 八、I1 发布前必须处理（V1 不算通过的部分）

1. README 单测数 **953 → 965**；CHANGELOG 补 v6 口径：残留回收按「搬走时间」计龄（名字里的 `<ts>` 优先）、
   大小写变体跟随文件系统（Windows 回收 / POSIX 不碰）、四类仓库侧缺源（TARGETS 条目 / 整个 `lib/` 目录 /
   门禁子包源目录 / 相对 `import` 缺失）全部在任何写盘之前判红 exit 2 且各自成段、
   `summarizeProfileCheck` 按类别解析且不再对仓库侧问题建议 `--repair`、
   模型/门禁 17 条场景进正式 Chromium 套件（47→64）。README 的「42 项 preflight / 11 项 UI」不变。
2. 对真实 profile 执行 `node scripts/sync-profile.mjs --repair`，再 `--check` 到
   **缺失 0 / 断链 0 / 陈旧 0 / 门禁子包漂移 0** 且第五段不出现；只声明磁盘一致，
   **不声明宿主运行时生效**（要重载后另验，本报告未做）。
3. 版本 bump：根下一 patch；`packages/dsh-gate` 按真实变更 bump（`packages/dsh-gate/package.json`、
   `PACKAGE_VERSION`、测试断言、根依赖），并**顺手修掉 §七 R1 的 `check-maintenance` 扫描范围**，
   否则子包 bump 与否它都报「干净」。CHANGELOG 写清 C1 / S1 / B1。
4. 合并 main 后按最终树复跑全量（本报告的 965 是集成分支数字），`npm pack`、TARGETS 派生守卫、
   preflight、Chromium 跟 bump 复跑。
5. （建议）把 §七 R3 的 import 形态静态护栏加进 drift 用例，避免「换个 import 写法就静默漏检」。

## 九、未验项 / 边界

- **不是真机 WebView**：没有重启 / 重载 DSH，没有在真实宿主会话里点门禁面板；profile 安装副本仍是旧内容（§八）。
- 未验物理读屏 / 触摸 / IME、真实 GitHub / Gitee 写操作、真实模型调用、真实 watcher 状态变化。
- 跨主机共享盘（NFS / SMB）上的写锁语义、大小写与 mtime 语义、真实长期文件句柄占用下的
  `rename` / `utimes` `EPERM`：实现方已声明未验，本轮沿用。
- 锁内容不可读只用 `EISDIR`（目录占位）复现；真实 ACL / `EBUSY` 句柄未验；残留回收只在下次拿锁时发生；
  「接管者被挂起 > 60s」的回收窗口未压测。
- 老 Node（< 22.18，无 `import.meta.main`）没有二进制实跑：回退分支由 `resolveIsMain` 纯函数 +
  基线的等价复刻对照覆盖（v5 结论沿用，v6 未改该函数）。
- 同仓库 `/gates` 乱序在浏览器层不可稳定构造（§6.3）；`/gates/models` 的真实服务端跨仓库返回未验。
- CI 矩阵 Node 22 / 24 未跑（本机 Node 24.20；`engines >= 22.19`）。
- 截图通道 SKIP（desk 0/8、orbit 0/2），没有拿截图当任何证据。

## 十、证据文件（临时，不进仓库）

| 文件 | 内容 |
|---|---|
| `/tmp/v6-v1/npm-test.log` / `npm-check.log` / `gate-test.log` / `client-test.log` / `drift-test.log` / `panel-strict.log` | §三 合并后计数原始输出 |
| `/tmp/v6-v1/baseline-root-test.log` / `baseline-gate-test.log` / `baseline-client-test.log` / `baseline-drift-test.log` / `baseline-panel-strict.log` | §3.2 基线计数 |
| `/tmp/v6-v1/ui-audit.log` / `panel-copy.log` / `preflight-fast.log` / `preflight-full.log` / `maintenance.log` / `audit-*.log` / `verify-readme-claims.log` | UI 体检、文案快照、preflight 红项原文、各 audit |
| `/tmp/v6-v1/chromium.log` | 官方正式 Chromium 套件 **64/64**（含 `SUMMARY` 与完整 `checks[]`） |
| `/tmp/v6-v1/baseline-chromium.log` | 基线 `c3753a1` 官方套件 **47/47**（覆盖红对照） |
| `/tmp/v6-v1/probe-c1.mjs`（sha256 `209fd006…`） | §四 C1 探针（只走公开 API，临时目录在 `os.tmpdir()`） |
| `/tmp/v6-v1/probe-s1.mjs`（sha256 `1adc3bd4…`） | §五 S1 探针（`git archive` 临时副本 + profile 快照） |

本报告单独提交在 `task/gate-v6-integration`（提交信息 `docs: gate v6 独立验收报告（V1）`），提交后工作树干净。
