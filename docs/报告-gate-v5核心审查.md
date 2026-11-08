# gate v5 核心与脚本审查（Q1）

> 审查人：reviewer（Q1）。日期：2026-11-08。
> 被审范围：C1（`packages/dsh-gate` 锁残余清理与旧版无 token 锁）、S1（`scripts/preflight.mjs` 主入口、`scripts/sync-profile.mjs` 失败原子性与门禁子包目录）。
> 被审代码树：`task/gate-v5-v1` @ `96fa08b`（集成树 `D:/主工作区/projects/dsh-gate-v5-integration`；合并 `6a582e0` / `9c3236a` / `812df38`，基线 `54f9052`）。`git status --short` 为空；`git diff task/gate-v5-core HEAD -- packages/dsh-gate` 为空。
> 本文件是唯一产物；源码只读，未重载 / 未重启 DSH，未对真实 profile 执行 `--repair`。
> **结论：verdict = pass。** 任务书要求的 7 项审查全部通过；没有 blocker / high / medium。5 条 low 观察见 §五，均不阻塞 I1。

## 一、结论摘要

| # | 审查问题 | 结论 | 关键证据 |
|---|---|---|---|
| 1 | 锁残余（`.stale-*` / 旧版 `.release-*`）成功路径是否清理 | 通过 | 独立探针 A/B/D：正常接管与超时等待后隔离文件均为 0；`broken[].leftover === null`；实现方 6 条新用例在**基线 lib** 上 5 failed / 24 passed，在本树 29/29 通过（不是「本来就绿」） |
| 2 | 清理失败是否**有界**且**不损诊断** | 通过 | 探针 F：注入 EPERM → 恰好 3 次退避重试、`leftover` 点名且文件真实存在；下一次写盘按「最新 3 份」回收最旧证据、最终只剩 3 份。探针 E：8 份旧证据 + `.release-` 只留最新 3 份，新鲜的、`-notes.txt`、`.bak` 一个不动；连续两次 prune 第二次 0 删除 |
| 3 | 旧格式锁是否 **fail closed** | 通过 | 探针 A/C/D：无 token 活锁原文原样 + 超时；EISDIR 不搬不删、错误点名「内容不可读 / fail-closed / 手工删除」；空锁新鲜不抢、超龄只按 `reason=age` 接管（解析失败本身不是接管理由）；核对窗口被换成活锁必须还原（用例 5/5） |
| 4 | C1–C3 是否回归 | 未回归 | gate **172/172**（两次独立运行，fail 0）；既有用例未改（diff 删除行只有两行 import）；12 写者 × 10 轮、release 窗口（2 MB 锁放大）、守护锁接管、extends、rename EPERM/EBUSY 全在套件内；我的 8 写者 × 6 轮独立栅栏（O_EXCL 独占标志 + 读改写计数）48/48 无重叠、无残留 |
| 5 | TARGETS 缺源时 `--repair` 是否**写盘前**失败 | 通过 | 探针 1：`--check` / `--repair` 都 exit 2、点名 `assets/icon-180.png`、dest 快照零变化、输出无 `relinked/pruned/recopied`。基线对照探针：基线同场景先 `pruned lib/zzz-stale.js` 再 exit 2（磁盘已改） |
| 6 | 门禁子包**整目录缺失**（源侧 / profile 侧） | 通过 | 探针 2：源侧 `packages/dsh-gate` 缺失 → exit 2、点名、零写入；基线对照：同场景四段全零 **exit 0**（假绿）。探针 3：profile 侧整目录缺失 → `--check` 点名 `缺失 1`（exit 1）、`--repair` 递归复制（exit 0）、复验四段全零、5 个运行时文件 sha256 一致；基线对照：只写「缺失 1」不点名 |
| 7 | preflight 主入口「真假绿」 | 通过 | 子进程 import → 输出恰好 `IS_MAIN=false` 与 `resolveIsMain=function`，不跑门禁；直接执行 → 41 行完整门禁（37 PASS / 2 FAIL / 2 SKIP，exit 1，2 FAIL 均为交接项）；回退分支 7 种写法（相对 / `..` / 大小写 / 无 argv / 空 argv / 不存在路径 / realpath 抛错）全部当 CLI，只有「另一个真实文件」判 false；本机 Node 24.20 的 `import.meta.main` 为 boolean |

## 二、方法与边界

- **只读源码**：没有改任何实现文件；探针放 `/tmp`；仓库副本在 `D:/主工作区/.tmp-q1-*`（同卷，跑完已删）。未对真实 `D:/DeepSeek Harness/home/profiles/desktop` 执行 `--repair`，只通过 preflight 的只读 `--check` 看到它的漂移。
- **独立探针不复用实现方用例**：只 import 公共导出（`acquireGateConfigLock` / `writeGateConfig` / `gateLockPath` / `pruneLockArtifacts` / `resolveIsMain` / `summarizeProfileCheck`），子进程用 `node:child_process` 真起。基线对照用 `git show 54f9052:<file>` 覆盖基线库 / 脚本。
- **先红后绿复核**：C1 用「新测试 + 基线 lib」跑出 5 red；S1 用「基线脚本 + 我的探针」复现 F6/F7 的旧行为。两条都不是只看实现方自述。
- **复跑命令**：gate 套件 172/172（两次）、根 `npm test` 952/952、`test/sync-profile-drift.test.mjs` 18/18、`node scripts/preflight.mjs --fast --no-maintenance`（直接执行，41 行）/ 退出码 1。
- **未验边界**：真实 ACL / 独占句柄造成的不可读（只用 `EISDIR` 复现）；接管者被挂起 > 60s 的回收窗口；旧 Node（< 22.18）无二进制实跑（只有纯函数 + 子进程 import 对照）；真实 profile 的 `--repair`；跨主机共享盘；真实 WebView。

## 三、C1：锁残余与旧版无 token 锁

### 3.1 实现结构（对照任务书第二节）

- **成功路径清理**：`takeOverStale` 把锁 rename 成 `<lock>.stale-<ts>-<uuid>`，核对身份后用 `removeArtifact` 删除；后者只对 `EPERM` / `EBUSY` 做 3 次线性退避（5 / 10 / 15 ms），其余错误立即返回路径（`packages/dsh-gate/lib/config-lock.js:254-265`、`:276-303`）。
- **失败留证**：清理失败时 `broken[].leftover` 是真实残留路径（`:293-302`）；`writeGateConfig` 把 `broken` 原样带回调用方（`packages/dsh-gate/lib/index.js:650`）。
- **有界回收**：`pruneLockArtifacts` 只认 `<lock>.stale-*` / `<lock>.release-*`，按 mtime 倒序「保留最新 3 份 + mtime 缺口 < 60s」，其余 unlink；每次 `acquireGateConfigLock` 前对主锁与守护锁路径各调一次，异常一律吞掉不挡写盘（`:317-360`、`:569-575`）。
- **旧格式身份**：`lockIdentity` = 有非空 `token` 用 token；否则 `raw:` + 原文逐字节；`contentReadable === false` 返回 `null`（`:172-177`）。`takeOverStale` 在 `null` 时**连 rename 都不做**（`:278-280`）。
- **拒绝「解析失败 = 可删除」**：接管理由仍只有 `staleReason` 的 `age` / `owner_dead`（`:200-206`），坏 JSON / 空文件只是「没有 owner」，不是接管理由。
- **诊断**：`lockTimeoutError` 对不可读锁追加「内容不可读（code）… fail-closed … 手工删除」（`:374-394`）。

### 3.2 独立探针（`/tmp/c1-q1-probe.mjs`，7/7 PASS）

| 探针 | 场景 | 结果 |
|---|---|---|
| A | 旧版无 token + 活着的本进程 pid，新鲜锁 | `gate_lock_timeout`，`error.owner.pid === process.pid`，锁文件**逐字节原样**，无 `.stale-`，无 `.guard`，未创建配置 |
| B | 旧版无 token + 死 pid（999999） | 接管成功；`broken.length === 1`、`reason === 'owner_dead'`、`owner.pid === 999999`、`leftover === null`；锁/隔离文件均 0；配置写入 |
| C | 锁路径是目录（EISDIR）、mtime 120s 前 | 超时错误点名锁路径 +「内容不可读」+「fail-closed」；目录仍在原位；未写配置；无 `.stale-` / `.guard` |
| D | 空锁：新鲜 → 不抢；mtime 120s 前 → 接管 | 新鲜时空锁原样；超龄接管 `reason === 'age'`、`owner === null`、`leftover === null`、无残留 |
| E | 直接调 `pruneLockArtifacts({keep:3,minAgeMs:60000})`：8 份 10–800s 残留 + 1 份 900s `.release-` + 无关文件 + `.bak` | 只留最新 3 份（10s/20s/30s），`removed.length === 6`，无关文件与 `.bak` 原样；第二次调用 `removed.length === 0` |
| F | 注入 `unlink` 对 `.stale-` 恒 EPERM | 恰好 3 次尝试；`leftover` 含 `.stale-` 且文件存在；锁仍 `isOwner()`；把 leftover 调旧 + 造 3 份更新的证据后下一次 `writeGateConfig`：leftover 被回收、最终 3 份 |
| G | 8 写者 × 6 轮真实子进程栅栏（锁内 O_EXCL 独占标志 + 读改写计数 2ms） | 计数 48/48；`OVERLAP` 0 次；结束后无 `.stale-` / `.release-` / `.lock` / `.guard` |

### 3.3 用例敏感度（先红后绿不是自述）

把新测试文件与**基线** `lib/config-lock.js` / `lib/index.js`（`git show 54f9052:...`）放进临时副本，跑 `node --test test/config-lock.test.mjs`：

```
ℹ tests 29   ℹ pass 24   ℹ fail 5   （exit 1）
✖ v5 C1：旧版无 token 锁 + 所有者已死 → 可接管（原文身份），成功路径不留 .stale-   （leftover 期望 null，实得 undefined）
✖ v5 C1：锁内容读不出来（EISDIR）→ fail closed…                              （Missing expected exception：旧实现把不可读锁当空锁接管了）
✖ v5 C1：核对窗口内被换成活着的旧版锁 → 不得当成同一把接管                    （Missing expected exception：旧实现没有 rename 注入点）
✖ v5 C1：残留证据有界…                                                        （旧实现留下 6 份，期望 3 份）
✖ v5 C1：清理失败留证有界…                                                    （旧实现无 leftover）
```

与实现方「旧实现 5 failed / 24 passed」完全对上。本树同一文件 29/29 通过（属于 172 的一部分）。

### 3.4 C1–C3 不回归

- **既有用例未被削弱**：`git diff 54f9052 HEAD -- packages/dsh-gate/test/config-lock.test.mjs` 的删除行只有两行 import；其余是追加的 6 条 v5 用例。
- **全量复跑**：`cd packages/dsh-gate && node --test` 两次均 `tests 172 / pass 172 / fail 0`（22.6s / 22.1s）。套件内含：12 写者 × 10 轮同抢 stale 锁、release 窗口（A 挂起 → B 接管 → A 恢复释放，第三写者不得进临界区）、stale 守护锁接管、活锁不抢、`isOwner` / `assertOwner`、rename EPERM/EBUSY 退避、`extends:"none"` 不丢、`.bak` 语义。
- **独立栅栏**：探针 G 不复用实现方 worker；8 写者 × 6 轮全部成功、计数无丢更新、无临界区重叠、无锁 / 隔离文件残留 —— 与套件的 12 写者压力互为旁证。

### 3.5 C1 其他观察（low，见 §五）

- **L4**：`minAge` 判的是**文件 mtime**，而 `rename` 保留被搬锁的旧 mtime。一个 mtime 已经 > 60s 的 stale 锁被搬成 `.stale-*` 后，它的证据文件**生下来就「够旧」**：注释里「1 分钟的年龄阈值保证永远不会删到另一个进程正在用的隔离文件」（`config-lock.js:76-79`）不是严格成立。并发 prune 理论上能在「rename → 核对」的微秒窗口里删掉这份隔离文件，接管者 `restoreFile` 失败后重试；**不会产生双写者**（源锁本来就已 stale），所以不计行为缺陷，只计注释 / 未验项的边界。
- **L5**：Windows 上 `pruneLockArtifacts` 的匹配正则大小写敏感（`config-lock.js:330`）。同一仓库若被不同大小写路径的进程写盘（例如 `D:\...\PROJECTS\...` vs `projects`），各自生成的 `.stale-*` 不会被对方的 prune 匹配，该路径下证据可能不回收。极窄，但「有界」在字符串路径维度上不是绝对的。
- 守护锁接管（`acquireGuard:532` 的 `takeOverStale(guardPath, …)`）返回的证据被丢弃，不进 `broken`；若守护锁证据清理失败，`leftover` 也不再被点名（只能等下次 prune）。这是既有行为，不进本轮 findings。

## 四、S1：profile 失败原子性与 preflight 主入口

### 4.1 TARGETS 缺源：写盘前失败（探针 1）

- 临时仓库副本 + 干净 dest 后制造三类漂移：断链 `lib/body.js`、陈旧 `lib/zzz-stale.js`、门禁子包内容不一致；再删掉仓库侧 `assets/icon-180.png`。
- `--check`：exit 2，输出 `缺源 assets/icon-180.png`，dest 快照（相对路径 → sha256）**零变化**。
- `--repair`：exit 2，输出 `TARGETS 有 1 条在仓库里不存在：assets/icon-180.png`，输出**不含** `relinked|pruned|recopied`，dest 快照**零变化**。
- 基线对照：同一套副本换回 `54f9052` 的脚本，`--repair` 先 `pruned lib/zzz-stale.js` 再 exit 2，dest 快照出现删除 —— 修的是真问题。

### 4.2 门禁子包整目录缺失（探针 2 / 3 + 基线对照）

| 场景 | 本树 | 基线 `54f9052` |
|---|---|---|
| 源侧 `packages/dsh-gate` 缺失 `--check` | exit 2，`缺源 packages/dsh-gate`，`TARGETS 缺源 1（packages/dsh-gate）`，零写入 | **exit 0**，`缺失 0 / 断链 0 / 陈旧 0 / 门禁子包漂移 0`（假绿） |
| 源侧缺失 `--repair` | exit 2，零写入 | 同左（exit 2 但 gate 段被 `if (existsSync(gateSrc))` 静默跳过） |
| profile 侧 `node_modules/@mycf711/dsh-gate` 整目录缺失 `--check` | exit 1，点名 `缺失 node_modules/@mycf711/dsh-gate`，`缺失 1 / 断链 0 / 陈旧 0 / 门禁子包漂移 0` | exit 1，只有 `缺失 1`，**不点名** |
| profile 侧缺失 `--repair` | exit 0，`copied node_modules/@mycf711/dsh-gate`；复验 `--check` exit 0 四段全零；`package.json` / `lib/index.js` / `lib/config-lock.js` / `bin/gate.mjs` / `gates/default.json` sha256 与源一致 | 能复制（既有行为） |

- 源侧缺失实现了「仓库侧问题 = `repoMissing` → `REPO_BLOCKED`」；所有 `mkdir/link/relink/cp/rm/prune` 都带 `!REPO_BLOCKED` 守卫（`scripts/sync-profile.mjs:102,113,198,211,232`），本轮不再有「修不了却改磁盘」。
- 第五段同时收「门禁子包源目录缺失」，preflight 的 `summarizeProfileCheck` 认得它（探针 7：`manifest === 1`、`detail` 含 `TARGETS 缺源 1（packages/dsh-gate）`）。

### 4.3 主入口：直接执行与 import（探针 6）

- **import 不跑门禁**：`node --input-type=module -e "const m = await import(<preflight url>); console.log(...)"` 输出恰好 `IS_MAIN=false|resolveIsMain=function`，无门禁行、无锁（`resolveIsMain` 见 `scripts/preflight.mjs:40-66`；主体包在 `if (IS_MAIN)`，`:105-603`）。
- **直接执行真跑**：`node scripts/preflight.mjs --fast --no-maintenance` 输出 41 行，`37 PASS / 2 FAIL / 2 SKIP`、`2 项失败`、退出码 **1**。两条 FAIL 是交接项（README 单测数 934 vs 实际 952；真实 profile 断链 21 + 门禁子包漂移 1 = `lib/config-lock.js, lib/index.js`），不是假绿。
- **回退分支**（模拟 `import.meta.main` 不存在）：相对路径、`scripts/../scripts/...`、Windows 全大写、无 argv[1]、空 argv[1]、不存在的 argv[1]、realpath 抛错 —— 全部 `true`（当 CLI 跑）；`mainFlag=true` → true、`mainFlag=false` → false；只有「另一个真实文件」(`scripts/sync-profile.mjs`) → false。旧实现「逐字符比较」在这些写法上会返回 false → 静默 exit 0，本树已不可能。
- **本机运行时**：Node v24.20.0 的 `typeof import.meta.main === 'boolean'`，直接执行以它为准；`test/sync-profile-drift.test.mjs` 的子进程用例（import 只输出 `IS_MAIN=false`）也通过。

### 4.4 S1 其他观察（L1 / L2 / L3，low）

- **L1（注释的「一律」比实现宽）**：`sync-profile.mjs:24` 新写「仓库侧问题一律在**任何写盘之前**判红」，但 `lib/*.js` 的**相对 import 解析失败**同样被脚本归为仓库侧问题（exit 2，`:241-260,289-292`），它的判定发生在所有写操作之后。实测（探针 4）：`--repair` 先 `relinked lib/body.js`（把带坏 import 的文件推进 profile）、`pruned lib/zzz-stale.js`，然后才 `相对 import 解析失败：body.js -> ./definitely-missing-module.js` 并 exit 2。原子性要求（任务书只点名 TARGETS）不违反，但注释的「仓库侧问题一律」不成立，属既有 F6 同类问题在第三种仓库侧错误上的残留。
- **L2（整目录缺失的崩溃路径）**：整个 `lib/` 目录被删时，`TARGETS` 缺源已让 `REPO_BLOCKED=true`（不会写盘），但 `:241-260` 的 `readdirSync(libDir)` 先抛 `ENOENT`：实测 `--check` **exit 1 + 栈**，没有「缺源 + exit 2 + 点名」，preflight 的 `summarizeProfileCheck` 只能得到 `(无输出)`。既有行为，原子性未破。
- **L3（第五段措辞）**：汇总行叫 `TARGETS 缺源 N`，但 `packages/dsh-gate` 不是 `TARGETS` 条目；代码注释说明了合并原因，输出层仍可能让人误以为清单里写了它。

## 五、发现汇总（全部 low，均不阻塞 I1）

| ID | 严重度 | 位置 | 问题 | 建议（required fix） |
|---|---|---|---|---|
| L1 | low | `scripts/sync-profile.mjs:24` 对比 `:241-260, 289-292` | 「仓库侧问题一律写盘前判红」的注释与「lib 相对 import 失败仍先 relink/prune 再 exit 2」不一致（探针 4 实测） | 二选一：把 `missingImports` 计算提前到任何写盘前、并入 `REPO_BLOCKED`；或把注释收窄成「`repoMissing` 非空时整轮只读」 |
| L2 | low | `scripts/sync-profile.mjs:241-260` | 整个 `lib/` 目录缺失时 `readdirSync(libDir)` 抛 `ENOENT`，`--check` exit 1 + 栈，而不是「缺源 + exit 2 + 点名」；preflight 只能显示 `(无输出)` | 先 `existsSync(libDir)` 判定；缺时按 TARGETS 缺源走 `repoMissing` / exit 2 |
| L3 | low | `scripts/sync-profile.mjs:276-278` | 第五段「TARGETS 缺源」里收了一个非 TARGETS 条目（`packages/dsh-gate`） | 文案改成「缺源 N（TARGETS / 门禁子包）」，`preflight.mjs` 的正则与用例同步 |
| L4 | low | `packages/dsh-gate/lib/config-lock.js:76-79, 317-360` | `minAge` 用继承的 mtime：> 60s 的 stale 锁搬成 `.stale-*` 后立即「够旧」，与注释「1 分钟阈值保证永远不会删到在途隔离文件」不符；并发 prune 只会让接管者重试（源锁已 stale，不会双写者） | 搬走后 `utimesSync(moved, now)`（或名字里带 move 时间并按它判龄）；或把注释降级为近似保护并写进 README 未验项 |
| L5 | low | `packages/dsh-gate/lib/config-lock.js:330` | prune 正则大小写敏感；Windows 上同仓库的不同大小写路径进程产生的残留互相不回收，「有界」在路径字符串维度不绝对 | 正则加 `i` 标志，并在用例里加一条大小写变体（可选） |

## 六、给 I1 的交接（不是 Q1 的写作用域）

1. **README 单测数**：README 写 934，实际 952（preflight 实跑 `FAIL README 单测数`；AGENTS.md 同数）。I1 回填。
2. **真实 profile**：`--check` = 断链 21 + 门禁子包漂移 1（`lib/config-lock.js`、`lib/index.js`）；需要在集成树执行 `node scripts/sync-profile.mjs --repair` 后复验四段全零。我未执行 `--repair`，未碰真实 profile。
3. **版本 bump / CHANGELOG / tag**：`--no-maintenance` 下跳过；I1 按主包 patch + gate 真实变更 bump，`check-maintenance` 全绿。
4. **发布前建议（非阻塞）**：L1 的二选一（改注释最便宜）；L2/L4 可留到下一轮，但 L1 若保留注释「一律」，建议至少改成与实现一致。
5. 合并树复验：本报告基于 `96fa08b` 干净树；I1 合入 main 后按任务书重新计数（当前实测根 952、gate 172、drift 18、preflight 37/2/2）。

## 七、未验项

- 真实 ACL / 独占句柄造成的锁内容不可读：只用 `EISDIR` 复现；`EACCES` / `EBUSY` 的 fail-closed 未在真实句柄上验。
- 接管者被挂起 > 60s 时，并发 prune 删掉其隔离文件的窗口：未压测（L4 的边界）。
- 旧 Node（< 22.18）无二进制实跑：回退分支由纯函数用例 + 子进程 import 对照覆盖，未做旧运行时验证。
- 真实 profile 的 `--repair`（I1 执行）；真实 DSH 宿主重载后的运行时生效性（脚本只声明磁盘一致）。
- 跨主机共享盘（NFS/SMB）的锁语义；Linux 调度下的并发概率。
- 真实 WebView / Chromium 面板交互不在 Q1 范围（Q2 / V1 另有证据）。

## 八、证据文件（临时，不进仓库）

| 文件 | 用途 | 结果 |
|---|---|---|
| `/tmp/c1-q1-probe.mjs` | C1 独立探针 A–G（旧格式 / EISDIR / prune / leftover / 8 写者栅栏） | 7/7 PASS |
| `/tmp/s1-q1-probe.mjs` | S1 独立探针（TARGETS 缺源 / 两类目录缺失 / 主入口 / summarize） | 任务书 7 项全 PASS；另 2 项更严期望红 = L1 / L2 |
| `/tmp/s1-baseline-q1-probe.mjs` | 基线 `54f9052` 对照：F6 先改磁盘、F7 假绿、F7b 不点名 | 3/3 PASS（基线旧行为被复现） |
| `/tmp/q1-gate-exit.log` 等 | 本树 gate / drift / 根测试的原始输出与退出码 | 见 §三、§四 |
