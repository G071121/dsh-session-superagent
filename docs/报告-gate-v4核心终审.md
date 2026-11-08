# gate v4 核心终审（Q1R2）

> 审查人：reviewer（Q1R2）。日期：2026-11-08。
> 被审：C3（`task/gate-v4-core` @ `c6212f3`，父 `4972e92`；`packages/dsh-gate` 5 个文件 +174/−51：释放改为「守护区 → 核对 token → 原位 unlink」、守护锁自身释放不嵌套、新增 2 条用例）。
> 复审树：`task/gate-v4-q1r2` = `task/gate-v4-q1r` @ `18a6771` + `git merge --no-ff c6212f3`（合并点 `ffc35e3`）。前两轮报告见 `docs/报告-gate-v4核心审查.md`、`docs/报告-gate-v4核心复审.md`。
> 本分支：本文件是唯一新增产物；源码只读，未重载宿主、未碰真实 profile。
> 结论：**verdict = pass**。**Q1R 的 R1（release-window，medium）已闭合**：同一探针下 C3 的第三写者在 B 持有期间拿不到锁（C2 基线 4/4 能拿到），A 的 release 不碰 B 的锁；**Q1-F1 仍闭合**（12 写者 × 32 轮 stale：0 丢更新 / 0 重复读数）。**没有 blocker / high / medium 未闭合 → 允许 I1。**

## 一、结论摘要

| 终审项 | 结论 | 原始证据 |
|---|---|---|
| **Q1R R1 release-window** | **闭合** | `release-window.mjs`：A（旧主，锁超龄）→ B 接管 → A 恢复 release → 第三写者 C 纯自旋抢锁：**C 拿不到**（`tokenC=null`、C exit 1）、`A.release()=false`、`B.isOwner()=true`、终态锁清理干净；**C2 基线同一探针 C 能拿到（cAcquiredWhileBHeld=true）** |
| release 不误删新锁 | 闭合 | `release-toctou.mjs`：A 的锁被 B 接管后 `A.release()=false`，B 的锁原样保留（token 仍是 B）、`B.isOwner()=true`、无 `.stale-`/`.release-`/`.guard` 残留 |
| 拿不到守护锁时不碰锁文件 | 闭合 | `release-guard-busy.mjs`：植入活守护锁 → `release()=false`（345ms 后）、锁文件原样（token 仍是自己的）、`isOwner()=true`、守护锁也没被删；守护锁消失后 `release()=true`、锁清理干净 |
| **Q1-F1 stale 并发接管** | 仍闭合 | 12 写者 × 32 轮、每轮预置死主 stale 锁：**0 丢更新 / 0 重复读数**（Q1 基线 2/44） |
| 无 stale 正对照 | 通过 | 12 写者 × 20 轮：20/20、0 重复；stale 2 写者 × 60 轮：60/60、0 重复 |
| owner 校验 | 通过 | 锁被接管后 `assertOwner()` 抛 `gate_lock_lost`（点名锁路径）；`writeGateConfig` 在 `.bak`/tmp 之前调用（`index.js:635`） |
| extends | 通过 | P2：晚到写者 `waited=746ms` 且 `extends:"none"` 保留；P7：8 进程 40/40、extends 保留；gate 用例含 stale 压力下的 extends 保护 |
| 锁超时 | 通过 | P4：`gate_lock_timeout` + 持有者证据，磁盘不动、无 `.bak` |
| rename 重试 | 通过 | P6：注入 EPERM 耗尽，原文件不变、tmp/锁清理、`code/attempts` 齐全 |
| 全量 gate 测试 | 通过 | `packages/dsh-gate npm test` **166/166** exit 0（21.0s，真实多进程）；`npm run check` exit 0；根 `npm test` **927/927** exit 0 |
| 实现与 README 守护区口径 | 一致 | README:275「创建 / 接管 / 释放全部串行在 `<lock>.guard` 里」、README:317「拿不到守护锁返回 false 且不碰锁文件」、代码注释与 `lib/index.js` JSDoc 都与 `releaseLock`（`config-lock.js:348`）一致；守护锁自身释放用 `unlinkIfOwned`（`393`），不嵌套、README 未作相反承诺 |

## 二、方法与计数

- **独立探针不依赖 C3 用例**：`/tmp/q1-probe/`，只调公开 API；真实子进程；临时目录在 `os.tmpdir()`。
- **红/绿对照**：release-window 用同一支探针跑 C2（`task/gate-v4-q1r` 的 gate 包）与 C3；C3 的 2 条新用例用 **C2 的 lib + C3 的 test/worker** 跑出红（`/tmp/q1r2-red`）。
- **计数/退出码（Q1R2 合并树 `ffc35e3`）**：

| 命令 | 结果 |
|---|---|
| `cd packages/dsh-gate && npm test` | **166/166**，exit 0（`/tmp/q1r2-gate-test.log`，21.0s） |
| `cd packages/dsh-gate && npm run check` | exit 0（`/tmp/q1r2-gate-check.log`） |
| 根 `npm test` | **927/927**，exit 0（`/tmp/q1r2-root-test.log`，41.5s；集成 917 + C2 新增 8 + C3 新增 2） |
| 探针 P1–P7 | **7/7**（`/tmp/q1-probe/probe.mjs`） |
| `stress3` stale 12 写者 × 32 轮 | **32/32**，0 丢更新 / 0 重复，exit 0（`/tmp/q1r2-stress-stale.log`） |
| `stress3` 无 stale 12 写者 × 20 轮 | **20/20**、0 重复，exit 0（`/tmp/q1r2-stress-control.log`） |
| `stress3` stale 2 写者 × 60 轮 | **60/60**、0 重复，exit 0（`/tmp/q1r2-stress-2w.log`） |
| `release-window.mjs`（C3） | C 拿不到锁（`cAcquiredWhileBHeld=false`、C exit 1）、A release false、B 的锁保住、`lockGone=true` |
| `release-window.mjs`（C2 基线） | C 在 B 持有期间拿到锁（`cAcquiredWhileBHeld=true`）→ 红 |
| `release-guard-busy.mjs` | 见 §三.2 |
| `release-toctou.mjs` | 4 个场景全过（终态不误删、assertOwner、死主守护锁 21ms 接管、活守护锁超龄接管） |
| C2 lib + C3 test/worker（`/tmp/q1r2-red`） | 2 条新用例 **0/2**：`真实场景` 红、`拿不到守护锁…` 红（`AssertionError: 拿不到守护锁就不能删锁 true !== false`） |

## 三、C3 实现审查

### 3.1 释放顺序（核心修法）

- `releaseLock`（`config-lock.js:348-367`）：先 `acquireGuard`（超时 `min(timeout, 2000)`，`RELEASE_GUARD_TIMEOUT_MS`=`70`），再 `unlinkIfOwned(lockPath, token)`（`323-335`：**先 `lockOwnedBy` 核对 token，是自己的才 unlink**，EPERM/EBUSY 有界重试），`finally` 释放守护锁。
- **不匹配就一个字节都不碰**：旧持有者（锁被接管）调 release 时，`lockOwnedBy` 为 false → 直接返回 false，`lockPath` 原样。这从根上消掉了 Q1R R1 的「先 rename → lockPath 空窗 → 第三写者进来」。
- **为什么不会在核对与 unlink 之间被换掉**：所有创建/接管都在 `<lock>.guard` 里；release 持有同一把守护锁，别的写者进不了守护区，无法在此期间接管。
- 守护锁自身释放（`393-396`）用 `unlinkIfOwned`，不再递归取守护锁；unlink 保留 EPERM/EBUSY 退避。

### 3.2 拿不到守护锁时不碰锁文件

- `releaseLock` 的 `acquireGuard` 失败直接 `return false`（`349-359`），不进入 `unlinkIfOwned`——宁可留着自己的锁等它超龄（默认 30s），也不误删别人的新锁。
- 独立探针 `release-guard-busy.mjs`：活守护锁（自己的 pid、刚写）在位 → `release()` 345ms 后返回 **false**、锁文件 token 仍是自己的、`isOwner()` true、守护锁未被动；移除守护锁后 `release()` true、锁文件消失、无残留。README:317 的「未验项」与行为一致。

### 3.3 与 README / 注释的口径

- README:275 现在写「创建 / 接管 / 释放全部串行在 `<lock>.guard` 守护锁里」——C3 后为真；README:276-278 写明「释放先核对再从原位删、不匹配一个字节都不碰、拿不到守护锁也宁可留着」；`config-lock.js` 顶部注释（`14-25`）与 `lib/index.js` JSDoc 同步。**没发现文案与实现相反的地方。**
- 「未验项」新增了「release 2s 拿不到守护锁 → 不碰锁文件、锁留到超龄」，与代码一致。

### 3.4 残余观察（info，非阻塞）

| # | 严重度 | 位置 | 说明 |
|---|---|---|---|
| R2 | info | `config-lock.js:373-409`（守护锁自身的创建/接管/释放） | 守护锁自己没有再套 meta 锁：两个进程同时接管一把 stale 守护锁时，其中一个的 `takeOverStale` 会短暂搬走另一个刚建的新守护锁再还原，窗口内第三个进程可以创建新守护锁 → 守护区「双持」。**锁的正确性不受影响**（创建是 O_EXCL、接管有 token 核对）；release 的「核对 → unlink」依赖守护区，理论上要「stale 守护锁 + 双持 + 自己的锁超龄 >30s」三者同时才可能复现，概率远低于已修的 R1。C2 的「未验项」已声明守护锁挂起窗口未压测。 |
| R3 | info | `config-lock.js:349-359` | release 失败（守护锁 2s 拿不到 / unlink EPERM）时锁会留到超龄（默认 30s），期间后续写入会等到 5s 超时；这是「宁可留锁也不误删」的取舍，README 已写明。 |
| R4 | info | `config-lock.js:323-335` | 锁文件内容被外部写大（测试里 2MB）时 `readLockState`/`lockOwnedBy` 会整读整解析；锁文件由本模块生成（<1KB），外部写者不在保证范围。 |

## 四、release-window 独立复现（R1 闭合判定）

探针 `/tmp/q1-probe/release-window.mjs` + `rw-worker.mjs` + `slow-restore.mjs`（注入 600ms `linkSync` 延迟放大旧实现的 rename→还原窗口）：

1. A 拿锁（token A）；mtime 回拨 60s；
2. B 按「超龄」接管（token B，`broken=1`），开始持有；
3. A 恢复并 `release()`；
4. 第三写者 C（`LOCK_TIMEOUT_MS=1500`）在 A release 期间纯自旋抢锁。

| 实现 | C 是否在 B 持有期间拿到锁 | A.release() | B 的锁 | 终态 |
|---|---|---|---|---|
| C2（Q1R） | **是**（`cAcquiredWhileBHeld=true`） | false | 被搬走→还原，终态在 | 干净 |
| **C3（本轮）** | **否**（`tokenC=null`，C 超时 exit 1） | false | **原样未动**，`B.isOwner()=true` | `lockGone=true`，无残留 |

C3 的 `真实场景` 用例用另一种放大手段（把 B 的锁写成合法 2MB JSON，拉长旧实现的 read+parse 窗口；6 个第三写者纯自旋）：C2 lib + C3 test 跑出红（0/2），C3 树 166/166 绿。**两种独立手法结论一致：R1 闭合。**

## 五、其余覆盖（创建 / 接管 / 释放 / owner / extends / 超时 / rename）

- **创建**：P1（4 进程 × 10 次）40/40；P7（8 进程 × 5 次）40/40、extends 保留、无残留。
- **stale 并发接管**：stress3 12 写者 × 32 轮 0 丢 / 0 重复；无 stale 正对照 20/20；2 写者 60/60；C2 自带的 12 写者栅栏用例在 166 条里绿。
- **release**：`release-toctou` 4 场景 + `release-guard-busy` 全过；非所有者 release 返回 false 且不碰锁。
- **owner 校验**：`assertOwner()` 在写盘前抛 `gate_lock_lost`；`isOwner()` 与磁盘 token 一致。
- **extends**：P2 确定性 TOCTOU（`waited=746ms` 且 none 保留）、P7 8 进程并发写。
- **锁超时**：P4（`gate_lock_timeout` + 持有者证据、磁盘不动）。
- **rename 重试**：P6（EPERM 耗尽保原文件 + tmp/锁清理）。

## 六、发现汇总

| ID | 严重度 | 位置 | 问题 | 建议 |
|---|---|---|---|---|
| — | **无** | — | **没有 blocker / high / medium 未闭合** | — |
| R2 | info | `config-lock.js:373-409` | 守护锁自身无 meta 锁，理论双持窗口；锁安全由 O_EXCL + token 核对保证 | 保持现状；C2 未验项已声明，后续可加挂起压测 |
| R3 | info | `config-lock.js:349-359` | release 失败留锁到超龄，期间后续写入会超时 | README 已写明；可接受 |
| R4 | info | `config-lock.js:323-335` | 外部写大的锁文件会整读整解析 | 不在保证范围；可忽略 |

## 七、给 I1 的交接

1. **Q1-F1 与 Q1R R1 均已闭合，无未闭合 blocker/high/medium → 允许 I1。** C3 的 release 顺序、拿不到守护锁的不碰路径、README/注释口径都已独立验证。
2. 计数：Q1R2 合并树 `ffc35e3` 上 gate **166/166**（21.0s）、根 **927/927**（41.5s）、`npm run check` exit 0；P1–P7 7/7；stale 32/32、无 stale 20/20、2 写者 60/60；C2 基线 release-window 红、C3 绿；C2 lib + C3 test 2 条新用例 0/2 红。
3. 发布注意：gate 包真实多进程用例让 `npm test` 约 21s（C3 已声明）；README 单测数按最终合并树回填（gate 166 / 根 927，I1 以最终合并树为准）；版本 bump、真实 profile repair 未变。

## 八、未验项

- 真实跨主机共享盘（NFS/SMB）锁语义；
- 真实长期句柄占用下的 rename EPERM（替身验证退避）；
- 守护锁「活着的持有者被挂起 >10s」导致的双持窗口：C2/C3 都未做真实挂起压测（安全由 O_EXCL + token 核对兜底）；
- release 拿不到守护锁（2s）的「不碰」路径：用植入的活守护锁验证，未做真实挂起压测；
- 与**不经过本锁**的外部写者并发只靠 `assertOwner()` 兜底，未覆盖；
- CI Node 22/24 未在本地跑（本机 24.20）。

## 九、证据文件（临时，不进仓库）

| 文件 | 内容 |
|---|---|
| `/tmp/q1r2-gate-test.log` | gate 包 166/166 exit 0（21.0s） |
| `/tmp/q1r2-gate-check.log` | `npm run check` exit 0 |
| `/tmp/q1r2-root-test.log` | 根套件 927/927 exit 0（41.5s） |
| `/tmp/q1r2-stress-stale.log` | 12 写者 × 32 轮 stale：0 丢 / 0 重复 |
| `/tmp/q1r2-stress-control.log` | 无 stale 12 写者 × 20 轮：20/20 |
| `/tmp/q1r2-stress-2w.log` | stale 2 写者 × 60 轮：60/60 |
| `/tmp/q1-probe/release-window.mjs` + `rw-worker.mjs` + `slow-restore.mjs` | release-window 红/绿（C2 真 / C3 否） |
| `/tmp/q1-probe/release-guard-busy.mjs` | 拿不到守护锁：不碰锁文件、不删守护锁 |
| `/tmp/q1-probe/release-toctou.mjs` | release 终态 / assertOwner / 守护锁接管 |
| `/tmp/q1-probe/probe.mjs` | P1–P7（7/7） |
| `/tmp/q1r2-red/` | C2 lib + C3 test/worker：2 条新用例 0/2 红 |
