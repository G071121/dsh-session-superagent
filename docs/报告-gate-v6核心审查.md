# gate v6 核心与脚本审查（Q1）

> 审查人：reviewer（Q1，成员 `q1-core`）。日期：2026-11-09。
> 被审范围：**C1**（`packages/dsh-gate` 锁残留回收按「搬走时间」计龄 + 大小写语义）、
> **S1**（`scripts/sync-profile.mjs` profile 真原子与仓库侧缺源分类、`scripts/preflight.mjs` 第五段解析）。
> 被审代码树：`D:/主工作区/projects/dsh-gate-v6-integration`，分支 `task/gate-v6-integration` @ `b580681`
> （基线 `c3753a1` = main `7846678` + v6 任务书，依次 `--no-ff` 合并 C1 `133a398` / S1 `dfe5a62` / B1 `fc35b4b`）。
> **本文件是本次审查唯一产物**：源码只读、未 `checkout` / `reset` / `stash` / `add` / `commit`；
> 真实 profile 只做只读 `--check`，未 `--repair`；未重启 / 重载 DSH，未动 magpie 配置，未改 `cordis.patch.yml`。
>
> ## 结论：**verdict = PASS**
>
> V1 对 C1 / S1 的「先红后绿」与「合并树全绿」两条结论**独立复核成立**，没有发现假绿；
> 但 V1 的 §七 R3 / R6 覆盖面偏窄，本轮补出 **4 条 low**（脚本健壮性 / 平台语义 / 诊断可读性）
> 与 **3 条 info**，均**不阻塞 I1**。
> 计数：**blocker 0 / high 0 / medium 0 / low 4 / info 3**。

## 一、结论摘要

| # | 问题 | 结论 | 关键证据（本机实跑） |
|---|---|---|---|
| 1 | C1 残留回收是否真按「搬走时间」计龄（不继承源锁 mtime） | **通过** | 独立探针 L4a/L4b/L4c：证据 `mtimeAge=31ms`（基线 `300047ms`）、`removed=0`（基线删了在途证据）、`raced.removed=0`（基线删了正在核对的文件）；L4d 名字时间戳优先（基线 `removed=[]`） |
| 2 | C1 大小写变体回收语义是否跟随文件系统、且不误删无关文件 | **通过** | 探针 L5：`caseInsensitive:false` 只回收 2 个小写、`true` 再回收 2 个大写，4 个无关文件（`.bak` / `-notes.txt` / 前缀相似 / `.BAK`）一个不动；L5b 平台默认 `win32 removed=1`（基线 `removed=0`）；L5c 守护锁路径 `lock.removed=0 guard.removed=1` |
| 3 | C1 成功路径是否有界（不留残留、不无限堆积） | **通过** | 探针 R1：30 轮 `acquire → assertOwner → release` 后目录**空**；P3：11 份残留 `keep=3` → `removed=8`，第二次 `removed=0`，剩 3 份 |
| 4 | C1 是否引入回归（跨进程互斥 / 旧格式身份 / fail-closed） | **未回归** | 探针 R2（旧版无 token + 死 pid → `reason=owner_dead` 接管并留证）；P4：8 写者 × 5 轮真实子进程，计数 **40/40**、临界区重叠 **0**、残留 **0**；gate 套件 **180/180** exit 0 |
| 5 | S1 「四类仓库侧问题一律在任何写盘之前判红」是否成立 | **通过** | 探针 S1a：`--check` / `--repair` 都 **exit 2**，`inode+sha256` 快照**零变化**，输出无 `relinked/pruned/recopied`；基线同场景**改了 24 个文件**（含整个门禁子包）再 exit 2 |
| 6 | S1 整个 `lib/` 目录缺失是否归入缺源（不抛 `ENOENT` 栈） | **通过** | 探针 S1b：`--check` / `--repair` 都 exit 2、点名 `缺源 lib/`、汇总 `lib 目录缺失 1（lib）`、**不逐文件刷 10 行**、无 `ENOENT`、无栈；基线 exit **1** + 栈 |
| 7 | S1 门禁子包源缺失是否**单独成段**（不并进 TARGETS 缺源） | **通过** | 探针 S1e：`门禁子包源缺失 1（packages/dsh-gate）`，且**不出现** `TARGETS 缺源 1（packages/dsh-gate）`；基线正是后者 |
| 8 | S1 `summarizeProfileCheck` 的 clean 语义与五段解析 | **通过** | 探针 S1f：clean 时 `detail` 只有三个数；四类仓库侧缺源各自 `clean:false` 且都提示「仓库侧问题（--repair 修不了）」；profile 侧漂移才提示 `--repair`；基线把 `packages/dsh-gate` 写成 `TARGETS 缺源` 并提示「清单条目不成立」 |
| 9 | 全量门禁是否真绿 | **通过** | 根 `npm test` **965/965** exit 0；gate **180/180** exit 0；`npm run check` exit 0；`test/sync-profile-drift.test.mjs` **22/22** exit 0 |
| 10 | 是否存在 V1 未覆盖的假绿 | **有（均为 low，见 §七）** | Q1-1 五种 `import` 形态静默漏检（含仓库里已有的**多行 import**）；Q1-2 `lib/` 里非文件条目抛 `EISDIR` 栈；Q1-3 profile 侧**部分** TARGETS 缺失不点名；Q1-4 macOS 大小写语义 |

## 二、审查环境与命令（原始输出摘要 + 退出码）

| 项 | 值 |
|---|---|
| 工作树 | `D:/主工作区/projects/dsh-gate-v6-integration`，`task/gate-v6-integration` @ `b580681` |
| `git status --porcelain` | 只有 ` M HANDOFF.md`（**接手前就已存在**，本轮未碰） |
| 运行时 | Windows 11 `10.0.26200` x64、Node **v24.20.0**、npm 11.19.0 |
| 基线 | `c3753a1`（`git archive c3753a1` 解到 `/tmp/v6-q1/baseline` 与 `/tmp/v6-q1/baseline-full`，**未 checkout 工作树**） |
| 合并树 sha256（前 8） | `lib/config-lock.js` **`67501b02`**、基线 **`1d3d03bf`**；`scripts/sync-profile.mjs` 基线 `30e5c65f`；`scripts/preflight.mjs` 基线 `9688dd0a` |
| 探针 | `/tmp/v6-q1/probe-c1.mjs`（`1195a1b0…`）、`probe-s1.mjs`（`703b7be7…`）、`probe-extra.mjs`（`214acd64…`） |
| 临时目录 | 探针脚本在 `os.tmpdir()`；C1 临时目录在 `os.tmpdir()`；S1 的仓库副本在 `D:/主工作区/projects/.tmp-v6-q1-*`（**必须同卷**：主插件靠硬链接同步，跨卷 `linkSync` 会 `EXDEV` —— 仓库自己的 `test/sync-profile-drift.test.mjs:7-8` 有同款说明），跑完已删 |

### 2.1 必跑四条（原始输出）

```bash
$ cd packages/dsh-gate && npm test
ℹ tests 180
ℹ pass 180
ℹ fail 0
ℹ duration_ms 28164.4757
EXIT_CODE=0
```

```bash
$ cd packages/dsh-gate && npm run check
> @mycf711/dsh-gate@0.1.4 check
> node --check lib/index.js && node --check lib/config-lock.js && node --check lib/semantic.js && node --check lib/redact.js && node --check bin/gate.mjs
EXIT_CODE=0
```

```bash
$ node scripts/test.mjs test/sync-profile-drift.test.mjs
ℹ tests 22
ℹ pass 22
ℹ fail 0
ℹ duration_ms 14166.5542
EXIT_CODE=0
```

```bash
$ npm test            # 根套件（V1 §三 的 965 复核）
ℹ tests 965
ℹ pass 965
ℹ fail 0
ℹ duration_ms 31855.9241
EXIT_CODE=0
```

### 2.2 真实 profile（**只读**，未 `--repair`）

```bash
$ node scripts/sync-profile.mjs --check
注意     lib/semver.js（inode 不同：内容改动不会同步到 profile，用 --repair 重建）
注意     node_modules/@mycf711/dsh-gate（内容与 packages/dsh-gate 不一致：lib/config-lock.js；用 --repair 强制同步）
---
目标：D:\DeepSeek Harness\home\profiles\desktop\node_modules\dsh-session-superagent
缺失 0 / 断链 21 / 陈旧 0 / 门禁子包漂移 1
（只证明 profile 磁盘副本一致；宿主运行时是否生效要在重载后另验）
相对 import 全部可解析 ✓
exit=1
```

与 V1 §3.1/§3.3 一致：`断链 21` 是集成 worktree 与 profile 硬链 inode 不同的**副本路径现象**，
`门禁子包漂移 1（lib/config-lock.js）` 是 v6 C1 的真实改动未同步。两者都留给 I1 的 `--repair`。

### 2.3 合并一致性（V1 §二 复核）

```bash
$ git diff --stat c3753a1 HEAD
 README.md                                          |   2 +-
 docs/报告-gate-v6验收.md                            | 280 +++++++++++
 packages/dsh-gate/README.md                        |  20 +-
 packages/dsh-gate/lib/config-lock.js               | 117 ++++-
 packages/dsh-gate/test/config-lock.test.mjs        | 284 ++++++++++-
 scripts/preflight.mjs                              |  48 +-
 scripts/sync-profile.mjs                           | 161 ++++--
 scripts/verify-panel-chromium.mjs                  | 546 ++++++++++++++++++++-
 test/client.test.mjs                               |  44 +-
 test/sync-profile-drift.test.mjs                   | 131 ++++-
 10 files changed, 1530 insertions(+), 103 deletions(-)
# 扣掉 V1 报告自身（+280）：代码 9 个文件 +1250 / −103 —— 与 V1 §二 完全对得上

$ git diff --stat task/gate-v6-core    HEAD -- packages/dsh-gate/{README.md,lib/config-lock.js,test/config-lock.test.mjs}   # 空
$ git diff --stat task/gate-v6-scripts HEAD -- scripts/{preflight,sync-profile}.mjs test/sync-profile-drift.test.mjs        # 空
$ git diff --stat task/gate-v6-browser HEAD -- README.md scripts/verify-panel-chromium.mjs test/client.test.mjs              # 空
```

三次 `--no-ff` 合并**没有吃掉任何一侧改动**；C1 / S1 / B1 的写作用域互不重叠。

## 三、C1 逐项（锁残留回收按「搬走时间」计龄 + 大小写语义）

### 3.1 实现结构（只读审查，对照 `docs/任务书-dsh-gate-v6.md` 第二节）

- **搬走时间双写**：`takeOverStale` 用**同一个** `movedAt` 生成文件名里的 `<ts>` 并 `utimes` 刷 mtime
  （`packages/dsh-gate/lib/config-lock.js:297-304`）。文件名由 `rename` 原子落地 ⇒ 连「rename → 刷 mtime」
  的微秒窗口都盖住；`utimes` 失败（`stampArtifactTime` 返回 `false`）时名字仍是权威兜底。
- **判龄优先级**：`artifactTimeMs`（`:367-374`）先取名字里的 `<ts>`（`\d{10,16}`、`>= 2001-09-09`、
  不超前 24h），取不到才退回 `mtime` —— 旧格式残留（`.stale-old-360` / `.release-<uuid>`）行为与 v5 一致。
- **大小写语义**：`artifactPatterns(base, {caseInsensitive})`（`:350-357`）把基名与后缀一起按 `flags` 匹配；
  `pruneLockArtifacts` 的 `caseInsensitive` 默认 `process.platform === 'win32'`（`:394`）。
- **不碰无关文件**：`match` 正则锚在 `^<base>\.(?:stale|release)-`，`.bak` / `-notes.txt` / 前缀相似名 /
  守护锁路径的残留都不匹配（`:354`、`:409`）。
- **测试注入点**：`utimes` 从 `acquireGateConfigLock` 一路透传到 `releaseLock` / `acquireGuard` / `takeOverStale`
  （`:646`、`:564`、`:608`、`:748`），源码里**没有**未透传的调用点（已逐处核对）。

### 3.2 独立探针（`/tmp/v6-q1/probe-c1.mjs`，只走公开导出，16 项）

**合并树 `b580681`：16/16 PASS**

```text
PROBE D:/主工作区/projects/dsh-gate-v6-integration/packages/dsh-gate/lib/config-lock.js
PASS L4a  接管把 5 分钟前的 stale 锁搬成证据后，证据 mtime = 搬走时间  [mtimeAge=31ms]
PASS L4b  刚搬走的在途证据 minAge 内不回收（源锁 mtime 旧也不行）  [removed=0]
PASS L4c  「搬走 → 核对」窗口里并发 prune 不回收隔离文件，接管仍完成  [raced.removed=0 broken.length=1]
PASS L4d  名字说「10 分钟前搬走」+ mtime 被 touch 成刚刚 → 按名字时间戳判旧  [removed=1]
PASS L5   .stale-/.STALE-/.RELEASE-/.release- 按文件系统语义回收，无关文件一个不动  [posix=2 windows=2 unrelated=4]
PASS L5b  默认语义跟随平台（win32 不区分 / POSIX 区分）  [platform=win32 removed=1]
PASS L5c  守护锁残留按搬走时间计龄，且不被主锁的回收顺带删掉  [lock.removed=0 guard.removed=1]
PASS R1   30 轮 acquire → assertOwner → release 成功路径不留 .lock/.guard/.stale-*/.release-*  [30 轮后目录空]
PASS R2   旧版无 token 锁：所有者已死 → 按原文身份接管并留证（reason=owner_dead）  [reason=owner_dead]
PASS N1   反向：名字时间戳超前 >24h + utimes 失败 → 退回 mtime 判龄（R4 的洞）  [removed=1（在途证据被回收：R4 的洞可复现）]
PASS N2   反向：release 只删自己的锁（不碰 artifact）；prune 只删 artifact（不碰活锁）  [活锁生存 / artifact 回收 各 1]
PASS N3   旧格式残留（.stale-old-360 / 无数字）退回 mtime：旧删、新鲜留  [removed=1（按 mtime 判）]
PASS N4   keep=3 的排序基准是搬走时间：mtime 最旧但名字最新的一份必须留下  [removed=1 kept=3]
PASS N5   路径含空格与中文 → 回收语义不变，且能真实加锁/释放  [removed=1 + 一次真实加锁释放]
PASS N6   接管证据文件名里的 <ts> 是 13 位毫秒，且与 mtime 同一时刻（±5s）  [<ts>=1794167433203 Δ(mtime-ts)=0ms]
PASS N7   反向：残留位置是目录（unlink 必 EPERM/EISDIR）→ 不抛异常、记进 kept  [removed=0 kept=1]
SUMMARY pass=16 fail=0 total=16
EXIT_CODE=0
```

**基线 `c3753a1`：7/16 PASS（9 FAIL，红点与 V1 §四 完全一致）**

```text
FAIL L4a  … [证据 mtime 必须是搬走时间（实际 300033ms）]
FAIL L4b  … [不许回收在途证据，removed=["…gates.json.lock.stale-1794167678970-3d8ad585-…"]]
FAIL L4c  … [并发 prune 不能回收刚搬走的隔离文件，removed=["…gates.json.lock.stale-1794167679009-d3244036-…"]]
FAIL L4d  … [removed=[]]
FAIL L5   … [Windows 语义要一并回收大小写变体，removed=[]]
FAIL L5b  … [Windows 默认必须把大小写变体当同一个残留，removed=0]
FAIL L5c  … [守护锁自回收：旧的删，removed=["…guard.release-1794167379067-h","…guard.stale-1794167679067-g"]]
PASS R1 / PASS R2
PASS N1 / FAIL N2 / PASS N3 / PASS N4 / PASS N5 / FAIL N6 / PASS N7
SUMMARY pass=7 fail=9 total=16
```

> **V1 §四 的「合并 9/9、基线 2/9」在本机独立复现成立**（我的 L4a…R2 九项：合并 9/9、基线 2/9，
> 只有 R1 / R2 在基线也绿）。红→绿不是实现方自述。

### 3.3 测试文件是否被削弱

`git diff c3753a1 133a398 -- packages/dsh-gate/test/config-lock.test.mjs` 的**删除行只有 4 行**，
全部落在既有用例「清理失败留证有界」：

```diff
-  const leftover = join(dir, leftoverName)
-  // 让它变旧，再堆三份更新的旧残留：失败证据最多保留最新 3 份，最旧的那份必须被回收。
-  utimesSync(leftover, new Date(Date.now() - 360000), new Date(Date.now() - 360000))
-  assert.equal(existsSync(leftover), false, '最旧的失败证据必须被下一次写盘回收（有界）')
```

替换后（`test/config-lock.test.mjs:1033-1053`）改成「把残留 **rename 成 6 分钟前的名字** + utimes」再断言
回收 —— 这是**语义变强**（v6 起单纯 `utimes` 已经洗不白证据，旧写法不再能构造「旧证据」）。
`assert.equal(artifactNames(dir).length, 3, …)` 的有界断言原样保留。**没有削弱既有断言。**

## 四、S1 逐项（profile 真原子与错误分类）

### 4.1 实现结构（只读审查）

- **写前判定**：`absentTargets` / `libDirMissing` / `gateDirMissing` / `scanMissingImports` 四类全部在
  `scripts/sync-profile.mjs:79-141` 计算完，合成 `REPO_BLOCKED`；所有写盘点（`:157` `mkdirSync`、
  `:158` `linkSync`、`:169-171` `unlinkSync`+`linkSync`、`:255` `cpSync`、`:267-268` `rmSync`+`cpSync`、
  `:296` `unlinkSync`）**每一处**都带 `!REPO_BLOCKED` 守卫（已逐处核对，无遗漏）。
- **分类汇总**：第四段（`缺失/断链/陈旧/门禁子包漂移`）+ 第五段四类仓库侧缺源**各自成段、只在非零时出现**
  （`:327-332`）；退出码契约 `0 = 干净 / 1 = profile 漂移 / 2 = 仓库侧问题`（`:353-356`、`:337-343`、`:346-350`）。
- **preflight 解析**：`summarizeProfileCheck`（`scripts/preflight.mjs:86-126`）用四段 + 四类第五段正则解析，
  `clean = drifted === 0 && repoSideIssues === 0`，仓库侧问题**不给**「跑 --repair」的错误建议（`:120-121`）。
- **主入口**：`resolveIsMain` 纯函数 + `IS_MAIN` 守卫（`:40-66`），import 时不跑整轮门禁。

### 4.2 独立探针（`/tmp/v6-q1/probe-s1.mjs`；同一份探针跑「合并树」与「基线 `c3753a1`」）

| # | 场景 | 合并树 `b580681` | 基线 `c3753a1` |
|---|---|---|---|
| B0 | 干净副本：`--repair` 建出 → `--check` | **exit 0**，`缺失 0 / 断链 0 / 陈旧 0 / 门禁子包漂移 0` | exit 0（同，对照前提） |
| S1a | 相对 `import` 缺失（同时预置断链 / 陈旧 / 门禁子包漂移） | **check=2 / repair=2 / 写盘=[]**，点名 `import   body.js -> ./definitely-missing-module.js`，汇总第五段 `相对 import 缺失 1（…）` | **FAIL：repair 改了 24 个文件**（`lib/body.js`、`lib/zzz-stale.js`、`node_modules/@mycf711/dsh-gate/**` 整套）再 exit 2 |
| S1b | 仓库侧整个 `lib/` 缺失 | **check=2 / repair=2 / 写盘=0**，`缺源 lib/（仓库里没有整个 lib 目录：恢复它，--repair 修不了）`，汇总 `lib 目录缺失 1（lib）`，无 `ENOENT`、无栈、不逐文件刷 10 行 | **FAIL：`--check` exit 1**，刷 `陈旧     lib/body.js（仓库已删除，profile 里还在）` |
| S1c | profile 侧整个 `lib/` 缺失 | **check=1 / repair=0 / recheck=0**，`缺失 10 / 断链 0 / 陈旧 0 / 门禁子包漂移 0` + 点名 `缺失     lib/（…）` | **FAIL：`(无汇总行)`**（`readdirSync` 抛 `ENOENT` 栈） |
| S1d | TARGETS 条目缺失（`bin/check.mjs`） | **check=2 / 写盘=0**，汇总 `TARGETS 缺源 1（bin/check.mjs）` | PASS（v5 已修） |
| S1e | 门禁子包源目录缺失 | **check=2**，汇总 `门禁子包源缺失 1（packages/dsh-gate）`，**不出现** `TARGETS 缺源 1（packages/dsh-gate）` | **FAIL：`TARGETS 缺源 1（packages/dsh-gate）`**（v5 Q1 L3 的措辞问题） |
| S1f | `summarizeProfileCheck` 的 clean / 五段语义 | **PASS**：clean 时 `detail === '缺失 0 / 断链 0 / 陈旧 0'`；四类仓库侧各自 `clean:false` + 「仓库侧问题（--repair 修不了）」；`changed` 从「注意 … 内容与 packages/dsh-gate 不一致：lib/index.js」解析出 `lib/index.js`；profile 侧漂移才提示 `--repair` | **FAIL：`TARGETS 缺源 1（bin/check.mjs），清单条目不成立（--repair 修不了）`**（第五段分类未实现） |

```text
PROBE merged=…/dsh-gate-v6-integration baseline=…/baseline-full
SUMMARY pass=18 fail=5 total=23      # 合并树 7/7（B0,S1a–S1f）；基线 2/7（B0,S1d）
EXIT_CODE=1                          # 退出码 1 来自基线那 5 条期望红
```

> **V1 §五 的「合并 8/8、基线 2/8」独立复现成立**（我把「相对 import 缺失」与「汇总行」合成 S1a 一行，
> 场景数与 V1 的 8 行等价；基线 5 个红点 = 先改盘 / exit 1 / 崩溃 / 分类错 / 措辞错）。

### 4.3 磁盘快照口径

S1a / S1b / S1d / S1e / N11 用 `相对路径 → inode:sha256` 快照对比（**inode 是必需的**：
`--repair` 的 relink 只换 inode、内容不变，只比 sha256 会把「改了盘」判成「没改」）。
合并树全部 `写盘=[]`；基线 S1a 列出 24 个变化路径（见 §四 表）。

## 五、V1 结论复核（哪条成立 / 不成立 / 假绿风险）

| V1 出处 | V1 的说法 | 本轮复核 |
|---|---|---|
| §三 计数 | 根 965 / gate 180 / drift 22 | **成立**（本机 965/180/22，全部 exit 0）；client 168 属 B1/Q2，未复跑 |
| §二 合并 | 相对 `c3753a1` 共 9 个文件 +1250 / −103 | **成立**（`git diff --stat` 10 文件 +1530 / −103，扣掉 V1 报告自身 +280 后正好 9 / +1250 / −103） |
| §二 逐分支一致性 | 三次合并没吃掉改动 | **成立**（三条 `git diff … HEAD` 全空） |
| §四 C1 | 合并 9/9、基线 2/9 | **成立**（同一份独立探针：16/16 vs 7/16；九项子集 9/9 vs 2/9） |
| §五 S1 | 合并 8/8、基线 2/8 | **成立**（7/7 vs 2/7，红点逐条对上） |
| §七 R1 | `check-maintenance.mjs:71` 只扫 `lib/ client.js`，不扫 `packages/dsh-gate/**` 与 `scripts/` | **成立**（`scripts/check-maintenance.mjs:71` 逐字核对）。v6 恰好只改子包运行时，这一行仍报「干净」—— I1 若只看它决定 bump 会漏掉 gate 子包 |
| §七 R2 | README 写 953，实际 965 | **成立**（`node scripts/audit-readme-tests.mjs 965` → `FAIL README 单测数  README 写 953，实际 965`，exit 1）。`MAINTENANCE.md:28/:38` 仍写 **952 / gate 172 / drift 18**，V1 §八 未列——**补进 I1 清单**（见 Q1-7） |
| §七 R3 | `scanMissingImports` 只认行首 `import …` + 单引号；双引号 / `export … from` / 动态 `import()` 不扫 | **不完整**：漏了**多行 `import { … } from '…'`**（`lib/index.js:36-54` → `} from './watch.js'`、`lib/watch.js:764-766` → `} from './gh-format.js'`，**仓库里已经有两处这种形态**）与 `export * from`。实测 6 种形态只有 1 种检出（Q1-1） |
| §七 R4 | 名字 `<ts>` 超前 > 24h 视为不是时间戳、退回 mtime；时钟回拨 > 24h 时在途证据会被当旧残留 | **成立且可复现**（探针 N1：`removed=1`）。触发需两个独立故障叠加（`utimes` 失败 **且** 名字时间戳超前 > 24h），保持 info |
| §七 R5 | 四段仓库侧缺源靠文案正则解析，改文案会静默降级 | **成立**：`test/sync-profile-drift.test.mjs:303-334` 逐字钉住四类；探针 S1f 也独立核对了四种 `detail` 文案 |
| §七 R6 | WSL 挂载 `/mnt/c` 上大小写变体不回收 | **成立但不止 WSL**：`caseInsensitive` 默认是 `platform === 'win32'`，**macOS 默认 APFS 大小写不敏感**同样落进「有界失效」（Q1-4，本机不可复现 → low） |
| §四/§五 假绿风险 | （V1 未声称有假绿） | **确认无假绿**：C1 九项、S1 七项的红→绿都在本机独立复现 |

## 六、新增边界探针（V1 未覆盖）

### 6.1 C1 侧（`probe-c1.mjs` 的 N1–N7 + `probe-extra.mjs` 的 P3/P4）

| # | 场景 | 结果 |
|---|---|---|
| N1 | **未来时间戳 + `utimes` 失败**（名字 `now+25h`、mtime 10 分钟前） | `removed=1` —— **在途证据被回收**，R4 的洞可复现（见 Q1-5） |
| N2 | **release 与 prune 交错**：活锁 + 旧 `.release-` 残留 | `prune` 只删残留、活锁原样；`release()` 只删自己的锁、不碰残留 → `活锁生存 / artifact 回收 各 1` |
| N3 | **旧格式残留**（`.stale-old-360` 无数字 / `.release-<uuid>`）退回 mtime | 旧的删、新的留（`removed=1`），与 v5 行为一致 |
| N4 | **`keep` 的排序基准**：4 份都够旧、mtime 各有不同 | 只删「搬走时间」最早那份（`removed=1 kept=3`） |
| N5 | **路径含空格与中文**（`我的 配置 目录/gates 规则.json`） | `removed=1` + 一次真实加锁/释放成功 |
| N6 | **证据文件名格式** | `<ts>=1794167433203`（13 位毫秒）、`Δ(mtime-ts)=0ms` —— 名字与 mtime 是**同一时刻**；基线 `Δ=-300004ms` |
| N7 | **残留位置是目录**（`unlink` 必 `EPERM`/`EISDIR`） | 不抛异常、`removed=0 kept=1`、目录原样保留 |
| P3 | **有界增长**：11 份残留 `keep=3` | `removed=8`，第二次 `removed=0`，剩 3 份 |
| P4 | **真实多进程栅栏**：8 写者 × 5 轮（`O_EXCL` 独占标志 + 读改写计数） | 计数 **40/40**、重叠 **0**、残留 **0**（与 gate 套件的 12 写者压力互为旁证） |

### 6.2 S1 侧（`probe-s1.mjs` 的 N8–N11 + `probe-extra.mjs` 的 P1/P2）

| # | 场景 | 结果 |
|---|---|---|
| N8 | **profile 侧部分文件缺失**（删 `lib/body.js` + `lib/watch.js` + `assets/icon-app.png`） | `--check` exit 1、`缺失 3 / 断链 0 / 陈旧 0 / 门禁子包漂移 0`、**不误报仓库侧缺源**；`--repair` → 0 → 复验 0。**但逐条点名 0/3**（见 Q1-3） |
| N9 | **源目录与 `--dir` 都含空格/中文**（`仓库 副本 中文` / `我的 配置 目录`） | 干净 exit 0；删 `bin/check.mjs` 后 exit 2 且 `TARGETS 缺源 1（bin/check.mjs）` 照常点名 |
| N10 | **`import` 形态**（6 种，见 Q1-1） | 只有「单引号单行」检出（exit 2）；双引号 / `export … from` / `export * from` / **多行 import** / 动态 `import()` **全部 exit 0（静默漏检）** |
| N11 | **`--repair --check` 同时传** | exit 1、`写盘=0`（`CHECK` 优先，只读） |
| P1 | **仓库侧 `lib/` 里有一个名为 `x.js` 的目录** | **未复现「exit 2 + 点名」**：`readFileSync` 抛 `EISDIR` 栈、exit 1、stdout 为空（见 Q1-2） |
| P2 | **profile 侧 `lib/` 里有一个名为 `*.js` 的目录** | exit 1、无栈；但它被算进「陈旧」且 `unlinkSync` 静默失败 ⇒ **永远红、`--repair` 也修不好**（Q1-6） |

## 七、发现清单

> 严重度口径：blocker / high / medium 必须本机可复现；不可复现的标「未复现」并降为 low。
> 本轮 **blocker 0 / high 0 / medium 0 / low 4 / info 3**。

### Q1-1（low）`scanMissingImports` 只认「行首 + 单引号 + 单行 + 静态 import」，五种写法的相对 import 静默漏检

- **位置**：`scripts/sync-profile.mjs:108-129`（判定在 `:112` `readFileSync`、`:116` `lastIndexOf("from '")`、
  `:120` `slice('import '.length).startsWith("'")`）
- **症状**：`lib/*.js` 里出现解析不到的相对 import 时，只有「单引号单行静态 import」会 exit 2 点名；
  双引号 / `export … from` / `export * from` / **多行 `import { … } from '…'`** / 动态 `import()` 五种
  **`--check` 全绿 exit 0**。而 `lib/index.js:36-54`（`} from './watch.js'`）、
  `lib/watch.js:764-766`（`} from './gh-format.js'`）**本来就是多行 import 形态**
  —— 也就是说这个口子不是理论上的。
  代码注释（`:102`）写的是「`lib/*.js` 里**每个**相对 import 都必须能解析」，比实现宽。
- **最小复现**（探针 N10；仓库副本 + `--dir` 临时 profile，真实 profile 未碰）：
  ```bash
  # 在仓库副本的 lib/body.js 末尾追加各形态之一，然后
  $ node <copy>/scripts/sync-profile.mjs --check --dir <copy-profile>; echo "exit=$?"
  ```
  | 追加的形态 | 合并树 exit | 基线 exit |
  |---|---|---|
  | `import './definitely-missing-module.js'` | **2（检出）** | 2（检出） |
  | `import x from "./definitely-missing-module.js"` | **0** | 0 |
  | `export { x } from './definitely-missing-module.js'` | **0** | 0 |
  | `export * from './definitely-missing-module.js'` | **0** | 0 |
  | `import {\n  x,\n} from './definitely-missing-module.js'` | **0** | 0 |
  | `const m = await import('./definitely-missing-module.js')` | **0** | 0 |
- **为什么不是 medium**：「文件被删 / 改名」这一类有 TARGETS 双向守卫（`absentTargets`）与派生守卫
  （`test/sync-profile-drift.test.mjs:196-223`）兜着，只有「**新增**一条解析不到的 import」才漏，
  且需要未来编辑才触发；基线同形，不是 v6 回归。
- **建议修法**（二选一，成本从低到高）：
  1. 加一条**静态护栏**：`test/sync-profile-drift.test.mjs` 里断言 `lib/*.js` 只允许
     「行首 + 单引号 + 单行静态 import」（`/^\s*import\b[^\n]*\bfrom\s*'[^']+'\s*$/` 或侧效应形态），
     换写法立刻红 —— 最便宜，且把「清单式守卫」的老问题（漏检静默）关在文档层；
  2. 把扫描扩到 `export … from` / 双引号 / 动态 `import()`，并**跳过多行 import 的续行**（需要小状态机，
     不要用正则硬凑）。

### Q1-2（low）`lib/` 里出现非文件条目时抛 `EISDIR` / `ENOENT` 栈，而不是「exit 2 + 点名」

- **位置**：`scripts/sync-profile.mjs:110-112`（`for (const name of readdirSync(dir))` → `readFileSync(...)`）、
  调用点 `:131`
- **症状**：`lib/` 里只要有一个**名字以 `.js` 结尾但不是普通文件**的条目（目录 / 断链符号链接），
  `readFileSync` 直接抛，**exit 1 + 栈**、stdout 为空 —— 正是 v5 Q1 L2 的崩溃形状；
  v6 只把「整个 `lib/` 目录缺失」这一种收进了 `repoMissing`，非文件条目这条路没盖。
  preflight 的 `summarizeProfileCheck` 只能拿到空串 → 显示 `(无输出)`。
- **最小复现**（探针 P1）：
  ```bash
  $ mkdir -p <copy>/lib/weird.js
  $ node <copy>/scripts/sync-profile.mjs --check --dir <copy-profile>; echo "exit=$?"
  node:fs:484
      return binding.readFileUtf8(path, stringToFlags(options.flag));
                     ^
  Error: EISDIR: illegal operation on a directory, read
      at readFileSync (node:fs:484:20)
      at scanMissingImports (…/scripts/sync-profile.mjs:112:18)
      at …/scripts/sync-profile.mjs:131:45
  exit=1
  ```
- **建议修法**：`readdirSync` 结果先 `statSync(join(dir,name)).isFile()` 过滤（非普通文件按
  `repoMissing` 里新增一类「lib 条目不是文件」点名 + exit 2），或把 `readFileSync` 包进 `try/catch`
  并把读失败归入 `repoMissing`。两条都要保持「写盘前判定」。

### Q1-3（low）profile 侧**部分** TARGETS 条目缺失只给计数、不点名

- **位置**：`scripts/sync-profile.mjs:154-163`（`if (!existsSync(dst)) { drift.missing.push(rel); … continue }`，
  `--check` 分支没有任何 `console.log`）
- **症状**：删掉 profile 里 3 个 TARGETS 文件后，`--check` 只打印 `缺失 3`，**三个文件名一个都没出**。
  同一份输出里「整个 `lib/` 目录缺失」与「门禁子包整目录缺失」都点名了
  （`:290`、`:251`）—— V1 §五 正是以「用户看到『缺失 1』不知道缺的是哪个」为理由修了门禁子包那一处，
  但 **TARGETS 条目本身仍不点名**，同类问题只修了一半。
- **最小复现**（探针 N8）：
  ```bash
  $ rm <profile>/lib/body.js <profile>/lib/watch.js <profile>/assets/icon-app.png
  $ node scripts/sync-profile.mjs --check --dir <profile>
  ---
  目标：…\profile
  缺失 3 / 断链 0 / 陈旧 0 / 门禁子包漂移 0
  （只证明 profile 磁盘副本一致；宿主运行时是否生效要在重载后另验）
  相对 import 全部可解析 ✓
  exit=1
  # —— 三个文件名一个都没出现；--repair 能修（exit 0 → 复验 exit 0），只是诊断差
  ```
- **建议修法**：在 TARGETS 循环里对 `CHECK` 补一行
  `console.log('缺失     ' + rel + '（profile 里没有这个文件：--repair 会重建硬链接）')`，
  与 `:290` 的 `lib/` 整目录那条同格式；同时给 `test/sync-profile-drift.test.mjs` 加一条
  「部分缺失必须点名」的用例（现在只有「整目录缺失」被钉住）。

### Q1-4（low，**未复现**：本机是 Windows，无 macOS 文件系统）macOS 默认 APFS 上「残留有界」仍不成立

- **位置**：`packages/dsh-gate/lib/config-lock.js:394`（`caseInsensitive = process.platform === 'win32'`）
- **症状**：v5 L5 的「大小写变体互不回收 → 有界失效」在 **macOS**（默认 APFS 大小写不敏感）上照旧：
  同一配置路径被大小写不同的路径字符串写过时，两套 `.stale-*` 互相不匹配，证据永不回收。
  V1 R6 只提到 WSL；实际是「按 `platform` 判大小写」这个抽象**本身**不成立（大小写敏感性是**卷**的属性，
  不是平台属性）。
- **未复现**：Windows 上无法制造「POSIX 平台 + 大小写不敏感卷」。**降为 low**。
- **建议修法**：默认改成 `process.platform === 'win32' || process.platform === 'darwin'`，
  或提供 `DSH_GATE_ARTIFACT_CASE_INSENSITIVE=1|0` 覆盖；同时把 README 的
  「POSIX 上是不同文件」收窄成「POSIX 上默认按不同文件处理（卷不敏感时需显式打开）」。

### Q1-5（info）R4 的洞可复现：名字 `<ts>` 超前 > 24h 且 `utimes` 失败 → 在途证据被回收

- **位置**：`packages/dsh-gate/lib/config-lock.js:367-374`（`artifactTimeMs` 的未来时间戳回退）
  + `:328-336`（`stampArtifactTime` 静默 `false`）
- **最小复现**（探针 N1）：造一份名字 `now+25h`、mtime 10 分钟前的残留，再
  `pruneLockArtifacts(lockPath, { keep: 0, minAgeMs: 60000 })` → `removed=1`。
- **说明**：触发需要两个独立故障叠加（`utimes` 失败 **且** 名字时间戳超前 > 24h，即跨机器时钟差 > 24h）。
  源锁本来就已 stale，不会产生双写者；只影响「在途证据可能被并发回收 → 接管者重试」。
  **V1 R4 的描述准确**，本条只是把「不可复现」变成「可复现」。不计缺陷。

### Q1-6（info）profile 侧 `lib/` 里名为 `*.js` 的目录：永远红、`--repair` 修不好

- **位置**：`scripts/sync-profile.mjs:292-300`（`readdirSync(destLibDir).filter(f => f.endsWith('.js'))`
  → `unlinkSync` 被空 `catch {}` 吞掉，但 `drift.stale` 已经 `push`）
- **症状**（探针 P2）：profile 的 `lib/` 里若出现目录 `dir-artifact.js`，`--check` 永远 exit 1 且
  `--repair` 也无法修（`unlinkSync` 对目录 `EPERM`，被静默吞掉），**没有任何文案说明为什么修不好**。
- **建议**：`catch` 里改名打印一行 `陈旧     无法删除 lib/x.js（<code>：不是普通文件）`，
  或先 `statSync().isFile()` 再判。极窄，下一次动这块时顺手改即可。

### Q1-7（info）文档侧两个过期数字（**I1 的活**，V1 §八 漏了 `MAINTENANCE.md`）

- `README.md:147` 写 `953 项单测`，实测 **965**（`node scripts/audit-readme-tests.mjs 965` → exit 1）—— V1 §八 已列。
- **`MAINTENANCE.md:28` / `:38` 仍写 `952 例` / `gate 172` / `drift 18`**，实测 **965 / 180 / 22**；V1 §八 未列。
- **`MAINTENANCE.md:51-55` 的「未验证」清单仍把 v5 的 L1–L5 列为未处理**，而 v6 的 C1/S1 已经把
  L1（真原子）、L2（整个 `lib/` 缺失）、L3（第五段文案）、L4（prune 用 move 时间）、L5（正则加 `i`）
  全部收掉（本轮探针 S1a/S1b/S1e/L4a/L5 逐条验证）。I1 回填 README 时应同步这份交接单，
  否则下一个接手者会按它去重复已完成的活。
- 另外 `scripts/check-maintenance.mjs:71` 只扫 `lib/ client.js`（V1 R1 成立），
  **v6 恰好只改子包运行时**，这一行仍报「干净」→ I1 若只看它决定 bump 会漏掉 `packages/dsh-gate`。

## 八、未验项（不宣称通过）

- **不是真机 WebView / 不是真机宿主**：本轮没有重启 / 重载 DSH，没有在真实宿主会话里点门禁面板；
  `--repair` 未对真实 profile 执行（只做只读 `--check`，见 §2.2）。**profile 只声明磁盘一致，
  不声明宿主运行时生效。**
- **跨主机共享盘（NFS / SMB）**：写锁语义、大小写语义、mtime 语义、`rename` / `utimes` 的跨主机可见性
  **一律未验**。macOS / Linux 上只有「按平台判定」的代码推理（Q1-4），没有实跑。
- **真实 ACL / 独占句柄**：锁内容不可读只用 `EISDIR`（目录占位）复现；`EACCES` / `EBUSY` 的真实句柄未验；
  残留回收只在「下一次拿锁时」发生（这是设计，不是缺陷）。
- **「接管者被挂起 > 60s」的回收窗口**：未压测（Q1-5 只有 `utimes` 失败的等价复现）。
- **CI 矩阵 Node 22 / 24**：本机只 Node 24.20（`engines >= 22.19`）；`import.meta.main` 的回退分支
  只有纯函数 + 子进程 import 对照，没有旧运行时实跑。
- **真实 GitHub / Gitee 写操作、真实模型调用、真实 watcher 状态变化**：不在 Q1 范围。
- **B1 的 Chromium 64/64 与 `client.test.mjs` 168/168**：属 Q2 / B1 范围，**本轮未复跑**，不宣称通过。
- **`docs/报告-gate-v6验收.md` §六 的截图通道**（desk 0/8、orbit 0/2 SKIP）：沿用既有约定，未验。

## 九、证据文件（临时，不进仓库）

| 文件 | 内容 | 结果 |
|---|---|---|
| `/tmp/v6-q1/gate-test.log` | `cd packages/dsh-gate && npm test` | `tests 180 / pass 180 / fail 0`，exit 0 |
| `/tmp/v6-q1/gate-check.log` | `cd packages/dsh-gate && npm run check` | 5 个文件 `node --check` 通过，exit 0 |
| `/tmp/v6-q1/drift-test.log` | `node scripts/test.mjs test/sync-profile-drift.test.mjs` | `tests 22 / pass 22 / fail 0`，exit 0 |
| `/tmp/v6-q1/root-test.log` | 根 `npm test` | `tests 965 / pass 965 / fail 0`，exit 0 |
| `/tmp/v6-q1/probe-c1.mjs`（`1195a1b0…`） | C1 独立探针（L4a–R2 九项 + N1–N7 七项） | 合并 16/16；基线 7/16 |
| `/tmp/v6-q1/probe-c1-merged.log` / `probe-c1-baseline.log` | 上面两份的原始输出与退出码 | 见 §三 |
| `/tmp/v6-q1/probe-s1.mjs`（`703b7be7…`） | S1 独立探针（B0/S1a–S1f + N8–N11） | 合并 7/7；基线 2/7 |
| `/tmp/v6-q1/probe-s1.log` | 原始输出（含两棵树的并列结果） | 见 §四 |
| `/tmp/v6-q1/probe-extra.mjs`（`214acd64…`） | 追加探针 P1–P4（EISDIR / 目录残留 / 有界增长 / 8 写者栅栏） | 4/4（P1 记录为 low 观察） |
| `/tmp/v6-q1/probe-extra.log` | 原始输出与退出码 | 见 §六 |
| `/tmp/v6-q1/baseline`、`/tmp/v6-q1/baseline-full` | `git archive c3753a1` 解出的基线（前者只含 `packages/dsh-gate`） | 未 checkout 工作树 |

本报告是本次审查唯一新增文件（`docs/报告-gate-v6核心审查.md`）。
