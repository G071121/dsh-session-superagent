# gate v4 核心与脚本审查（Q1）

> 审查人：reviewer（Q1）。日期：2026-11-08。
> 被审范围：C1（`packages/dsh-gate` 跨进程写锁 + Windows rename 重试）、S1（`TARGETS` 反向存在性守卫 + preflight 第四/五段解析）。
> 被审代码树：`task/gate-v4-integration` @ `4306b29`（代码同 `45faf61`，V1 报告另在一次提交里）。
> 本分支：`task/gate-v4-q1`（从集成树切出），本文件是唯一产物；源码只读，未重载宿主、未碰真实 `DSH_HOME` profile。
> 结论：**verdict = pass**。没有 blocker / high；唯一行为性发现是 stale 并发接管路径的 **medium** 竞态（见 F1），建议发布前修，但不阻塞 I1。

## 一、结论摘要

| 审查问题 | 结论 | 关键证据 |
|---|---|---|
| 锁是否**真正跨进程** | 通过 | 独立探针：4 进程 × 10 次读-改-写计数 40/40；8 进程 × 5 次同层写 40/40、`extends:"none"` 不丢、无 `.lock`/`.tmp-`/`.stale-` 残留；把 acquire 换成空操作的变异副本立刻丢 27 次 |
| **stale 清理**是否安全 | **部分**（F1 medium） | 单写者接管安全；**多个写者同时**接管时，`breakStaleLock` 的 rename 不校验被搬文件身份，可把别人刚建好的新锁搬走 → 零侵入探针在 12 写者配置下复现 2/44 轮「两个持有者同时进临界区 + 丢一次更新」 |
| rename 失败是否**保原文件** | 通过 | 注入 EPERM：`code/path/attempts=3` 齐全、原文件字节不变、`.tmp-` 清理、锁释放；EACCES 只尝试 1 次 |
| `extends` 是否**不回归** | 通过 | 既有 10 条 extends 写盘用例全绿；确定性 TOCTOU 探针：慢 rename 写者持锁 682ms，晚到写者 `waited=682ms` 且 `extends:"none"` 保留；变异副本 `waited=6ms`、`extends` 被冲掉 |
| TARGETS 是否**仍假绿** | 未发现 | 仓库副本删掉 `bin/check.mjs`：新实现 `--check` exit 2 并点名；同一副本换回 `2cad1a6` 脚本 exit 0 假绿（独立复现） |
| preflight 第四/五段是否**假绿** | 未发现 | `summarizeProfileCheck` 在 clean / 门禁子包漂移 / TARGETS 缺源 / 老格式三段四种输入上判定正确；行判定 = `exit 0 && clean`，缺源时 exit 2 双重兜底；集成树实跑 profile 行 FAIL 且点名 3 个文件 |

## 二、方法与边界

- **只读**：没有改任何实现文件；临时目录全部落在 `os.tmpdir()`；没有跑 `sync-profile --repair` 到真实 profile，也没有重载/重启 DSH。
- **独立探针不依赖实现方用例**：只调 `@mycf711/dsh-gate` 的公开导出（`acquireGateConfigLock` / `writeGateConfig` / `gateLockPath`），子进程用 `node:child_process` 真起。
- **先红后绿（变异对照）**：把 `config-lock.js` 复制到 `/tmp/q1-probe/gate-nolock`，让 `acquireGateConfigLock` 直接返回假锁（= 无锁写），同一套探针立刻红：
  - 计数：4 进程 × 10 次读-改-写 = **13/40**（丢 27 次）；
  - extends：慢写者覆盖晚到写者，最终文件 `extends` 消失（`{"waited":6,"rules":["slow-a"]}`，正常实现是 `{"waited":695,"extends":"none","rules":["b-writer"]}`）。
  说明探针确实能发现「锁没生效」，不是自证。
- **实现方用例复跑**：gate 包 `npm test` 156/156 exit 0、`npm run check` exit 0；`test/sync-profile-drift.test.mjs` 11/11 exit 0；集成树 `node scripts/preflight.mjs --fast --no-maintenance` = 37 PASS / 2 FAIL / 2 SKIP、exit 1（FAIL 是 README 单测数与真实 profile 漂移，见 §4.2）。
- **未验边界**：跨主机共享盘（NFS/SMB）锁语义、真实长期句柄占用下的 rename EPERM、真实 DSH 宿主/WebView、CI 的 Node 22/24 矩阵（本机 24.20）。我的 stale 压力只在本机 Windows 上做，Linux 调度下的概率未测。

## 三、C1：写锁与 rename 重试

### 3.1 锁真的跨进程（通过）

- 实现：`open(<gates.json>.lock, 'wx', 0o600)`（`config-lock.js:169-194`）做 O_EXCL 原子创建；`EEXIST` / `EPERM` / `EBUSY` 都按「锁在别人手里」处理（`config-lock.js:45`），这正是 Windows 并发创建/delete-pending 的形态。
- 串行范围正确：`writeGateConfig` 先拿锁，`try` 内才是「读旧 `extends` → 校验 → `.bak` → 临时写入 → `renameWithRetry`」，`finally` 释放（`index.js:588-634`）。锁覆盖了整段 TOCTOU 窗口，不是只包住 rename。
- 独立探针（`/tmp/q1-probe/probe.mjs`，7/7 通过）：

| 场景 | 结果 |
|---|---|
| P1 4 进程 × 10 次「加锁 → 读 → 5ms → 写 → 释放」 | 计数 **40/40**，锁释放干净 |
| P7 8 进程 × 5 次同层 `writeGateConfig`（一半写 `extends:"none"`） | 40/40 成功，最终 `extends:"none"`、1 条规则、无 `.lock`/`.tmp-`/`.stale-` |
| P2 确定性 extends 窗口（慢 rename 写者持锁 800ms，晚 200ms 的写者） | 晚到写者 `waited=682ms`，最终 `extends:"none"` 保留 |
| 变异副本（假锁）对照 | P1 计数 13/40；P2 `waited=6ms` 且 `extends` 丢失 |

- 锁是**同机、同路径字符串**的跨进程互斥，不是分布式锁；实现方 README 已声明跨主机共享盘不保证。与 V1 R2（锁路径按字符串派生）一致，本次不重复计为新问题。

### 3.2 stale 清理安全性（F1，medium）

单写者接管是安全的，且有证据（年龄 / 所有者进 `lock.broken`；活锁不抢）。**并发接管**存在一个真实窗口：

1. 等待者 A、B 都因为「锁文件存在」而 `open(wx)` 失败；
2. B 先 `readLockState` 拿到 stale 快照（`config-lock.js:276`），判定 `owner_dead`；
3. A 也判定 stale，先 `breakStaleLock`：把旧锁 rename 走、unlink、下一轮 `open(wx)` 成功，**新锁 L_A 已经建立**；
4. B 的 `breakStaleLock` 这时才执行 `renameSync(state.path, staleName)`（`config-lock.js:118`）——它按的是**旧快照**，把 `lockPath` 上现在的 **L_A 搬走**并 unlink；
5. B 下一轮建 L_B；A 以为锁还在，B 也持锁 → 两个写者同时进临界区。

代码注释宣称「两个等待者同时看到同一把死锁时只有一个能搬走它，另一个拿 ENOENT」——这只对「同一个 inode」成立，对「已被新锁替换」不成立。`releaseLock` 的 token 校验帮不上：它只在释放时读一次，且此时锁龄远小于 30s，不会触发接管。

**复现（零侵入）**：worker 只在锁内读计数器、`sleep 5ms`、写 +1；读到的值重复即证明两个持有者同时进临界区（互斥时读值必然互不相同）。

| 配置 | 轮数 | 结果 |
|---|---|---|
| 预置「所有者已死」stale 锁 + 12 写者同时启动 | 12 + 32 = 44 轮 | **2 轮**异常：`round 4: count=11/12`；`round 27: count=11/12 DUP_READS=[[9,2]]`（两个进程都读到 9 → 丢一次更新） |
| 同样 12 写者，**没有** stale 锁（对照） | 20 轮 | 20/20 精确、0 重复读数 |
| 预置 stale 锁 + **2 写者**（更接近真实面板/CLI 并发） | 120 轮 | 120/120 精确、0 重复读数 |

**影响**：两个写者同时写同一层时，后 rename 的覆盖前一个；前一个写者仍收到成功（面板显示「已保存」），它的规则/`extends` 变化被静默丢掉——正是 C1 要消除的那类丢失。文件不会损坏（rename 原子、`.bak` 在），但丢失不可见。

**触发条件**：存在 stale 锁（上一次写盘崩在中间/进程被杀）+ 多个写者同时接管。单写者与 2 写者场景均未复现（2 写者 120 轮 0 次），12 写者下约 4.5% 轮次；属于「低概率、高要求」的窗口，但机制是结构性的，不是测不出来就不存在。

**建议修复（小改动）**：`breakStaleLock` 在 `renameSync` 之后读一眼被搬走的文件，校验 `owner.token` / `mtime` 与快照一致；不一致（说明搬的是别人的新锁）就尽量 `rename` 回去并当作竞争重试，不要 unlink。另一个做法是给 break 段再套一把 O_EXCL 的 `<lock>.break` 锁，并在 break 段内重新 `readLockState`。

**为什么定 medium 而不是 high**：触发要求 stale 锁在场 + 多个写者同时接管，2 写者 120 轮未复现，后果是单次配置写入丢失（可重存，文件不损坏），且修复前代码的常规路径（无 stale）完全正确。按任务规则「blocker/high 才必须 needs_revision」，不阻塞本分支；但建议 I1 在发布前让 C1 补掉，或在 CHANGELOG 边界里如实写明。

### 3.3 rename 失败保原文件（通过）

- 注入 `rename` 始终抛 EPERM（`renameAttempts:3, backoffMs:1`）：错误 `code=EPERM`、`attempts=3`、消息点名配置路径；原文件字节不变；`.tmp-` 清理；锁释放（P6）。
- 只对 `EPERM`/`EBUSY` 重试（`config-lock.js:36/324`），EACCES 立即失败（实现方用例）。
- 默认 6 次、20ms 线性退避（总约 300ms）是设计值；「另一个进程长期持有目标句柄」的真机 EPERM 仍用替身验证（沿用实现方未验声明）。

### 3.4 extends 不回归（通过）

- `extends` fail-closed 的 10 条既有用例（`extends-write.test.mjs`）与 `config-io.test.mjs` 全绿；
- 新增的锁把「读旧 extends」也包进临界区，P2 用确定性窗口证明：没有锁时会丢（变异副本 `extends` 消失），有锁时保留；
- `.bak` 是写盘前原文、失败不产生 `.bak`/`.tmp-`（P4/P6）均保持。

### 3.5 C1 其他观察

| # | 严重度 | 位置 | 问题 | 建议 |
|---|---|---|---|---|
| F2 | low | `config-lock.js:202-219` | `releaseLock` 是「读 token → unlink」两步：若读完之后锁被 stale 接管并换成新锁，A 会删掉新锁。窗口要求 A 自己的锁已 ≥30s 龄（长写）且恰在释放时被接管，极窄 | 与 F1 同族修法：rename 到唯一名 → 校验 token → unlink，或 unlink 前再读一次 |
| F3 | low | `config-lock.js:122-126` | stale rename 后 `unlink` 失败会留下 `.stale-*` 文件，之后无人清理，也不在 `--check` 的「陈旧」扫描里 | 下次 acquire 顺带清理同目录本前缀的过期文件，或文档写明残留无害 |
| F4 | info | `config-lock.js:169-194` | `EPERM` 当竞争处理：目录 ACL 真拒绝时也要等满 5s 才报「无法创建」，错误码仍是 EPERM（不伪装超时，实现方用例已覆盖） | 可接受；若要更快失败，把「锁文件从未出现」的判定提前到 1 次轮询后 |
| F5 | info | `packages/dsh-gate/README.md:274` | 「Windows 上并发创建同一锁文件拿到的是 EPERM / EBUSY（不是 EEXIST）」是过度绝对的说法（正常新建撞名仍是 EEXIST；EPERM/EBUSY 出现在 delete-pending/共享冲突） | 代码三种都处理、行为无风险；文案改成「可能返回 EPERM/EBUSY」 |

## 四、S1：TARGETS 与 preflight

### 4.1 TARGETS 反向存在性（通过）

独立最小副本（当前脚本 + 21 条 TARGETS 指向的文件 + `packages/dsh-gate`，dest 用 `--repair` 建好）：

| 场景 | 当前实现 | 基线 `2cad1a6` |
|---|---|---|
| 干净 | `--check` exit 0，`缺失 0 / 断链 0 / 陈旧 0 / 门禁子包漂移 0` | 同 |
| 删除 `bin/check.mjs` | **exit 2**，`缺源     bin/check.mjs（仓库里没有这个文件：…）` + 汇总行追加 ` / TARGETS 缺源 1（bin/check.mjs）` | **exit 0**，四段全零（旧假绿独立复现） |
| 同场景 `--repair` | exit 2，`TARGETS 有 1 条在仓库里不存在：bin/check.mjs` | — |

- 派生守卫（`test/sync-profile-drift.test.mjs`）从发布契约派生「必须在 TARGETS 里」的运行时文件，漏一个即红；反向禁 `test/ docs/ scripts/ packages/`，并校验都在 `package.json.files` 里。11/11 通过。
- 注意：`--repair` 在缺源场景会先做 link/copy/prune 再 exit 2；若缺的是 `lib/*.js`，会先把 profile 副本当「陈旧」删掉（见 F6）。这是既有 prune 行为，不是 S1 引入，但缺源时「修不了却已改磁盘」值得在文档里点一句。

### 4.2 preflight 第四/五段（通过）

`summarizeProfileCheck`（`preflight.mjs:44-67`）是唯一解析点，我用**真跑输出** + 一个老格式输入验证：

| 输入 | `clean` | `drifted` | `gateDrift` | `manifest` | `changed` | `detail` |
|---|---|---|---|---|---|---|
| 干净 `--check` | true | 0 | 0 | 0 | null | `缺失 0 / 断链 0 / 陈旧 0`（不加噪音） |
| profile 里门禁子包被改 | false | 1 | 1 | 0 | `lib/index.js` | `… / 门禁子包漂移 1（lib/index.js），跑 … --repair` |
| 删掉 TARGETS 源 | false | 0 | 0 | 1 | null | `… / TARGETS 缺源 1（bin/check.mjs），清单条目不成立（--repair 修不了）` |
| 老格式（只有三段） | false | 0 | 0 | 0 | null | 三段原文 |

- 行判定是 `res.status === 0 && summary.clean`（`preflight.mjs:222-223`）：缺源时 sync-profile exit 2 → FAIL；即使将来 sync-profile 退出码回归 0，`clean=false` 仍兜底，不会只靠退出码。
- 集成树实跑 `preflight --fast --no-maintenance`：**37 PASS / 2 FAIL / 2 SKIP，exit 1**；其中单测行 **917/917 PASS**，profile 行 **FAIL** 且解析出
  `缺失 0 / 断链 21 / 陈旧 0 / 门禁子包漂移 1（lib/config-lock.js, lib/index.js, package.json）`——与 V1 的结论一致，不是假绿。
- `IS_MAIN`（`preflight.mjs:24-31`）：被 `test/sync-profile-drift.test.mjs` import 时只导出纯函数、不跑门禁（11 条用例 4s 跑完，且我的解析探针 import 时只输出自己的结果）；CLI 实跑正常（就是上面这次 41 行输出）。

### 4.3 S1 其他观察

| # | 严重度 | 位置 | 问题 | 建议 |
|---|---|---|---|---|
| F6 | low | `scripts/sync-profile.mjs:211-221, 262-266` | 缺源时 `--repair` 先把能做的 relink / gate 复制 / 陈旧 prune 做完再 exit 2；缺的是 `lib/*.js` 时 profile 副本已被删 | 把 `missingSources` 的红提前到任何写操作之前（只报不做），或在文档写明「先修仓库再 repair」 |
| F7 | low | `scripts/sync-profile.mjs:178` | `packages/dsh-gate` 整个目录缺失时该段被 `if (existsSync(gateSrc))` 静默跳过 → profile 检查可能仍「四段全零」 | gateSrc 不存在时也报一条仓库侧缺源（exit 2） |
| F8 | low | `scripts/preflight.mjs:24-31` | `import.meta.main` 不存在时回退 argv 比对；**比对不上会返回 false**，preflight 静默 exit 0（无输出、无锁）。本机（Node 24.20）与 CI 的相对/绝对路径实测都相等，风险只在路径写法被改写时 | 回退分支比对不上就当 CLI 跑（按注释本意）或直接报错退出，不要静默成功 |
| F9 | info | `scripts/preflight.mjs:14` | `pathToFileURL` 导入后未使用（V1 R1 已记） | I1 顺手删 |

## 五、发现汇总

| ID | 严重度 | 位置 | 问题 | 处理 |
|---|---|---|---|---|
| F1 | **medium** | `packages/dsh-gate/lib/config-lock.js:115-134`（配合 `:276-283`） | 并发 stale 接管时，break 的 rename 按旧快照搬走 `lockPath` 上已被替换的新锁 → 两个写者同时进临界区；零侵入探针 12 写者 2/44 轮复现（2 写者 120 轮未复现） | 建议发布前修：rename 后校验被搬文件 owner/token 与快照一致，不一致还原并重试；或 `<lock>.break` O_EXCL 串行化 break 段 |
| F2 | low | `config-lock.js:202-219` | release「读 token → unlink」两步的 TOCTOU（需锁龄 ≥30s） | 同族修法（rename 到唯一名 → 校验 → unlink） |
| F3 | low | `config-lock.js:122-126` | unlink 失败留下 `.stale-*` 残留，无人清理 | 下次 acquire 顺带清理，或文档写明 |
| F6 | low | `sync-profile.mjs:211-221, 262-266` | 缺源时 `--repair` 先改磁盘再 exit 2 | 缺源红提前到写操作之前 |
| F7 | low | `sync-profile.mjs:178` | gate 子包整目录缺失时该段静默跳过 | 也报仓库侧缺源 |
| F8 | low | `preflight.mjs:24-31` | IS_MAIN 回退在路径比对失败时静默 exit 0 | 回退当 CLI 跑 / 报错 |
| F4/F5/F9 | info | — | EPERM 当竞争的 5s 延迟、README 的 EPERM/EEXIST 绝对说法、`pathToFileURL` 死导入 | 文案/清理，不阻塞 |

**没有 blocker / high。** F1 定 medium 的理由见 §3.2：常规路径与 2 写者路径均未复现，文件不损坏、可重存；但它是结构性的，建议不要把「锁不会互相覆盖」写成本轮已完全达成的结论。

## 六、给 I1 的交接

1. **建议（非阻塞）**：把 F1 安排给 C1 修掉再发布；若不修，CHANGELOG 的 v4「边界」里要写明「stale 锁并发接管存在窄窗口，极端并发下可能丢一次配置写入」，不要沿用 README 的绝对表述。
2. README 单测数 890 → **917**、真实 profile `--repair` 到四段全零（断链 21 / 门禁子包漂移 1）、版本 bump（V1 §八 已列，Q1 复核同一组红项）。
3. CHANGELOG 需补 S1 的新口径：`sync-profile` **退出码 2**（仓库侧问题）、汇总行**第五段「TARGETS 缺源」**（仅缺源时出现）、新增 6 条 drift 用例。
4. 发布前建议用**合并后的最终树**再跑一次 `preflight --fast` 与 gate 包测试；Q1 的计数是在集成树 `4306b29` 上跑的。

## 七、未验项

- 跨主机共享盘（NFS/SMB）锁语义、真实长期句柄占用下的 rename EPERM（沿用实现方声明，替身验证）；
- 真实 `DSH_HOME` profile：所有 profile 验证都用临时假 home / `--dir` 副本；真实 profile 的 `--repair` 留给 I1；
- CI Node 22/24：本机只有 24.20；`import.meta.main` 在 22.x 的可用性未独立复核（S1 声称 22.18+，无本地二进制可验）；
- F1 的修复后验证：当前 Q1 只证明「问题存在」，没验证任何修法；修完应重跑同一支压力探针（12 写者 × 32 轮应为 0 重复读数）。

## 八、证据文件（临时，不进仓库）

| 文件 | 内容 |
|---|---|
| `/tmp/q1-gate-test.log` | gate 包 156/156，exit 0 |
| `/tmp/q1-drift-test.log` | `test/sync-profile-drift.test.mjs` 11/11，exit 0 |
| `/tmp/q1-preflight-fast.log` | 集成树 `preflight --fast --no-maintenance`：37 PASS / 2 FAIL / 2 SKIP，exit 1 |
| `/tmp/q1-probe/probe.mjs` + `worker.mjs` | 独立探针 P1–P7（7/7） |
| `/tmp/q1-probe/gate-nolock/` | 空操作锁的变异副本（先红对照） |
| `/tmp/q1-probe/stress3.mjs` + `/tmp/q1-stress3.log` | stale 并发接管零侵入复现：32 轮中 round 27 `DUP_READS=[[9,2]]`、count 11/12 |
| `/tmp/q1-stress.log` + `/tmp/q1-stress-nolog2.log` | 12 轮版本（round 4 丢失）+ 20 轮对照 |
| `/tmp/q1-stress3-control.log` | 无 stale 锁对照：20/20，0 重复 |
| `/tmp/q1-stress3-2w.log` | 2 写者 120 轮：0 重复 |
| `/tmp/q1-stress4b.log` | 带 rename 观测的压力（24 轮；25 次成功 rename 中 1 次被搬文件内容不可读，旁证 F1，不作为主证据） |
| `/tmp/q1-s1/` | 最小仓库副本：干净 / 删源（新 exit 2 / 旧 exit 0）/ preflight 四态解析；`parse.mjs` |
