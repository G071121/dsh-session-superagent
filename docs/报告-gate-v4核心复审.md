# gate v4 核心复审（Q1R）

> 审查人：reviewer（Q1R）。日期：2026-11-08。
> 被审：C2（`task/gate-v4-core` @ `4972e92`，父 `c52ce02`；`packages/dsh-gate` 5 个文件 +707/−83：守护锁、搬走后核对、释放先隔离、`assertOwner`、21 个锁用例）。
> 复审树：`task/gate-v4-q1r` = `task/gate-v4-q1` @ `5ee4a04` + `git merge --no-ff 4972e92`（合并点 `bbbd67d`）。第一轮报告见 `docs/报告-gate-v4核心审查.md`。
> 本分支：本文件是唯一新增产物；源码只读，未重载宿主、未碰真实 profile。
> 结论：**verdict = pass**。**Q1-F1（stale 并发接管竞态）已闭合**（同一支零侵入探针：12 写者 × 32 轮 stale 接管，0 丢更新、0 重复读数；Q1 基线是 2/44）。新记 1 条 **medium R1**：`releaseLock` 不在守护区内，非所有者 release 会先把「当前持有者的锁」rename 走，窗口内第三个写者可拿到锁（已用注入延迟探针 4/4 复现；C1 基线不出现）——建议发布前修，**不改变 F1 闭合结论**，**允许 I1**。

## 一、结论摘要

| 复审项 | 结论 | 关键证据 |
|---|---|---|
| **Q1-F1 stale 并发接管** | **闭合** | 零侵入重复读数探针（同一支 Q1 探针）：12 写者 × 32 轮、每轮预置死主 stale 锁 → **0 丢更新 / 0 重复读数**；Q1 基线（C1 实现）2/44 轮 |
| 无 stale 正对照 | 通过 | 12 写者 × 20 轮无 stale：20/20 精确、0 重复；2 写者 × 60 轮 stale：60/60、0 重复 |
| 不会搬走新锁 | 通过 | 守护区内创建/接管串行 + 搬走后 token 核对/还原；12 写者压力下无重复读数；`takeOverStale` 的还原分支覆盖「搬错」 |
| 不会两个写者同进临界区 | 通过（F1 场景） | 重复读数检测器在 F1 场景 0 次；**R1** 是另一条窄窗口（release 不在守护区），见 §五 |
| release 不误删新锁 | 通过（终态）+ R1（瞬态） | 探针：A 的锁被 B 接管后 `A.release()` 返回 false，B 的锁原样还在、`B.isOwner()` true、无 `.stale-`/`.release-` 残留；但 rename→还原之间的窗口可被第三个写者插入（R1） |
| `assertOwner` 写盘前兜底 | 通过 | 锁被接管后 `assertOwner()` 抛 `gate_lock_lost`（消息点名锁路径）；`writeGateConfig` 在 `.bak`/tmp 之前调用（`index.js:634`） |
| extends 不回归 | 通过 | P2 确定性 TOCTOU：晚到写者 `waited=740ms` 且 `extends:"none"` 保留；P7 8 进程 40/40 且 extends 保留 |
| 锁超时 | 通过 | P4：`gate_lock_timeout` + 持有者证据，磁盘不动、无 `.bak` |
| rename 重试 | 通过 | P6：注入 EPERM 耗尽，原文件不变、tmp/锁清理、`code/attempts` 齐全 |
| 全量 gate 测试 | 通过 | `packages/dsh-gate npm test` **164/164** exit 0（10.5s，真实多进程）；`npm run check` exit 0；根 `npm test` **925/925** exit 0 |

## 二、方法与计数

- **独立探针不依赖 C2 用例**：全部在 `/tmp/q1-probe/`，只调公开 API（`acquireGateConfigLock` / `writeGateConfig` / `gateLockPath` / `gateGuardPath`），子进程真起。
- **先红后绿**：Q1 已用同一支探针对 C1 实现跑出 12 写者 2/44 轮（Q1 报告 §3.2）；本轮同一支探针对 C2 跑 32 轮 0 次，且 C2 自带的栅栏压力用例（12 写者 × 12 轮）在 164 条里绿。
- **计数/退出码（Q1R 合并树 `bbbd67d`）**：

| 命令 | 结果 |
|---|---|
| `cd packages/dsh-gate && npm test` | **164/164**，exit 0（`/tmp/q1r-gate-test.log`，10.5s） |
| `cd packages/dsh-gate && npm run check` | exit 0（`/tmp/q1r-gate-check.log`） |
| 根 `npm test` | **925/925**，exit 0（`/tmp/q1r-root-test.log`；集成 917 + C2 新增 8） |
| 探针 P1–P7 | **7/7**（`/tmp/q1-probe/probe.mjs`） |
| `stress3` stale 12 写者 × 32 轮 | 0 丢更新 / 0 重复读数，exit 0（`/tmp/q1r-stress-stale.log`） |
| `stress3` 无 stale 12 写者 × 20 轮 | 20/20、0 重复，exit 0（`/tmp/q1r-stress-control.log`） |
| `stress3` stale 2 写者 × 60 轮 | 60/60、0 重复，exit 0（`/tmp/q1r-stress-2w.log`） |
| `release-toctou.mjs` | 4 个场景全过（`/tmp/q1r-release-toctou.log` 运行时输出） |
| `release-window.mjs`（C2） | C 在 B 持有期间拿到锁 4/4；`A.release()=false`、终态锁清理干净 |
| `release-window.mjs`（C1 基线） | C 超时拿不到（exit 1），A 的 release 不碰 B 的锁 → R1 是 C2 引入 |

## 三、C2 实现审查

### 3.1 守护锁（`<lock>.guard`）

- `gateGuardPath` = `gateLockPath + '.guard'`（`config-lock.js:79`）；`acquireGuard`（`362-406`）用同一套 O_EXCL 创建 + 快照/超龄判定 + 接管，stale 阈值独立（默认 10s，`DEFAULT_GATE_GUARD_STALE_MS`）。
- 等锁快路径（`465-475`）只读快照、不碰守护锁；只有「创建 / 接管」进守护区（`476-514`），并在 `finally` 里释放守护锁。
- 独立探针：
  - 死主守护锁（pid 999999 + 60s mtime）→ 4ms 内接管，写盘成功，`.guard` 不残留；
  - 活着的守护锁超龄（`guardStaleMs:2000` + 60s mtime）→ 按「超龄」接管（这是文档化行为：守护锁只该活几微秒）；即使双持，`takeOverStale` 的 token 核对仍兜底。
- 审查结论：**创建/接管互斥成立**；快路径只读，不引入额外写。

### 3.2 搬走后核对（`takeOverStale`）

- `renameSync(lockPath, moved)` 后读 `moved`：能解析就比 `owner.token`，不能解析就比原文（`193-246`）；不一致走 `restoreFile`（`147-184`：`link` 优先、`COPYFILE_EXCL` 兜底，都不覆盖已有文件），绝不误删。
- 还原失败（原位已被新锁占用）时删掉 `moved` 并返回 null —— 旧持有者的锁本来就不该存在，行为正确。
- 独立证据：12 写者压力下没有出现「搬走新锁后两个写者同时进临界区」（重复读数 0）；Q1 的 2/44 未复现。

### 3.3 释放（`releaseLock`）

- 实现（`317-355`）：先 `renameSync(lockPath, priv)` 隔离 → 读 `priv` 的 token → 是自己的才 `unlink`，否则 `restoreFile` 还原；rename/unlink 对 EPERM/EBUSY 各重试 3 次。
- **R1（medium）**：`handle.release()`（`453-455`）**直接调用 `releaseLock`，没有进守护区** —— 与设计注释（`15-21`「创建 / 接管 / 释放三个动作全部走守护锁」）和 README（`275`「创建 / 接管 / 释放全部串行在 `<lock>.guard` 里」）不符。详见 §五。
- 终态正确：探针里非所有者 release 返回 false、当前持有者的锁原样保留、无残留文件。

### 3.4 `assertOwner` 写盘前兜底

- `writeGateConfig` 在 `.bak` / tmp 写入之前调用 `lock.assertOwner()`（`index.js:634`）；锁被接管过就抛 `gate_lock_lost`（消息点名锁路径），`finally` 释放锁、tmp 清理路径不变。
- 探针：A 的锁被 B 接管后 `A.assertOwner()` 抛 `gate_lock_lost`；`B.assertOwner()` true；A 的 release 不影响 B 的持有。

### 3.5 兼容与性能

- 新导出 `gateGuardPath` / `GATE_GUARD_SUFFIX` / `DEFAULT_GATE_GUARD_STALE_MS`，`writeGateConfig` 增 `lockGuardStaleMs`，锁句柄增 `isOwner()` / `assertOwner()`；README 表格与「未验项」已同步（守护锁 10s 挂起窗口、外部写者只靠 `assertOwner` 兜底都写明了）。
- 真实多进程用例把 gate 包 `npm test` 从 ~3s 拉到 10.5s（C2 已声明）；根套件 25.7s，可接受。

## 四、Q1-F1 闭合判定（独立复现）

同一支零侵入探针（锁内读计数器，重复读数 = 两个持有者同时进临界区；每轮预置「死主 + 60s mtime」的 stale 锁，12 个写者同时启动）：

| 实现 | 轮数 | 丢更新 | 重复读数 | 退出码 |
|---|---|---|---|---|
| C1（Q1 基线） | 12 + 32 = 44 | **2** | **2**（`round 4 count=11/12`、`round 27 DUP_READS=[[9,2]]`） | 1 |
| **C2（本轮）** | **32** | **0** | **0** | **0** |

正对照与回归：无 stale 12 写者 × 20 轮 = 20/20；stale 2 写者 × 60 轮 = 60/60；P1/P7 计数 40/40；P2 extends 保留；P4 超时；P6 rename 耗尽 —— 全部通过。**F1 闭合。**

## 五、R1（medium）：release 不在守护区，非所有者 release 会搬走当前持有者的锁

**代码事实**：`handle.release()`（`config-lock.js:453-455`）→ `releaseLock(lockPath, token)`（`317`）→ `renameSync(lockPath, priv)`（`322`）**在核对 token 之前**。设计注释与 README 都写「释放也在守护锁里」，实际没有。

**可达场景**（与 Q1-F1 同族，但另一条路径）：

1. 写者 A 拿到锁，在临界区（`assertOwner` 之前）被挂起 > 30s（调试器断点、机器休眠、超慢写）。
2. 写者 B 按「超龄」接管 A 的锁（这是文档化行为），开始写盘，**此时锁文件是 B 的**。
3. A 恢复：`assertOwner()` 发现不是自己 → 抛 `gate_lock_lost` → `finally` 调 `A.release()`。
4. `releaseLock` 先把 **B 的锁** rename 到 `privA`（`lockPath` 瞬间为空），再读 `privA` 发现 token 不是 A → 还原。
5. 在「rename 走 → 还原」的窗口里，写者 C 的 `acquireGateConfigLock` 看到空路径 → 走守护区 → 创建自己的锁 → 进临界区。**B 与 C 同时持锁。**

**复现**（`/tmp/q1-probe/release-window.mjs` + 注入 600ms `linkSync` 延迟放大 rename→还原窗口，真实代码路径不变）：

| 实现 | C 是否在 B 持有期间拿到锁 | A.release() | 终态 |
|---|---|---|---|
| **C2** | **是**（4/4 轮；C 的取锁时刻 < B 的释放时刻） | false | 锁清理干净、无残留 |
| C1 基线 | 否（C 超时，exit 1） | false（不碰 B 的锁） | 干净 |

即：**R1 是 C2 引入的新窗口**（C1 的 release 是先读 token、不匹配就不 rename）。

**影响**：两个写者同时进临界区 → 静默丢一次配置写入（正是锁要消灭的那类）；终态文件不损坏（rename 原子、`.bak` 在）。**为何定 medium**：触发要求「旧持有者被挂起 > 30s + 第三个写者在毫秒窗口内抢锁」，比 Q1-F1（12 写者 2/44）罕见得多，且注入延迟是放大手段。

**建议修复**（任一，建议都做）：
1. `releaseLock` 在 rename **之前**先读 token：不是自己的直接 `return false`，**不碰 `lockPath`**（非所有者零副作用）；是自己的再 rename + 复核 + unlink（复核仍处理「写盘 >30s 被接管」的残余）。
2. 释放也进守护区（`<lock>.guard` 持有期间 rename/还原），与创建/接管共用同一互斥；注意守护锁自身的 release 不能递归取守护锁，需要一个 `releaseLock(..., { guard: false })` 之类的入口。

**补用例**：在 `test/config-lock.test.mjs` 增加「非所有者 release 时第三个写者不能拿到锁」（可用注入 `linkSync` 延迟放大窗口），断言 C 拿不到 / 或 A 的 release 根本没 rename 走 B 的锁。

## 六、其它观察

| # | 严重度 | 位置 | 问题 | 建议 |
|---|---|---|---|---|
| R1 | medium | `config-lock.js:317-355`（`releaseLock`）、`453-455`（handle.release） | 非所有者 release 会搬走当前持有者的锁，窗口内第三个写者可获锁 | 见 §五 修法 + 用例 |
| R2 | info | `config-lock.js:193-245` | `takeOverStale` 的「期望身份」在 owner 不可解析时退化为原文比对；无 token 的旧版锁文件之间可能误判为「同一把」 | 现实现不会产生无 token 锁；可在边界里注明 |
| R3 | info | `config-lock.js:336-352` | unlink 重试耗尽会残留 `.release-*`（不是锁，不影响正确性） | 下次 acquire 顺带清理，或文档注明 |
| R4 | info | `config-lock.js:15-21`、README:275 | 注释/README 声称「释放也在守护锁里」，与实现不符（R1 的根因之一） | 修 R1 时同步改文案 |

## 七、给 I1 的交接

1. **Q1-F1 已闭合 → 允许 I1**。R1 建议发布前修（两处小改 + 一条用例），或写进 CHANGELOG 的 v4 边界（「旧持有者 >30s 挂起 + 晚到 release」的窄窗口）。
2. 计数：Q1R 合并树 `bbbd67d` 上 gate **164/164**、根 **925/925**，`npm run check` exit 0；P1–P7 7/7；stale 压力 32/32、无 stale 20/20、2 写者 60/60；R1 探针 C2 4/4 复现、C1 基线不复现。
3. README 单测数按最终合并树回填（本树 gate 164；根 925 是 Q1R 树的口径，I1 合并 U2/S1 后以最终树为准）；版本 bump、真实 profile repair 未变。

## 八、未验项

- 真实跨主机共享盘（NFS/SMB）锁语义；真实长期句柄占用下的 rename EPERM（替身验证）；
- 守护锁「活着的持有者被挂起 >10s」的接管窗口未专门压测（C2 已声明；安全由守护区内二次校验 + token 核对兜底）；
- 与**不经过本锁**的外部写者并发只靠 `assertOwner()` 兜底，未覆盖；
- R1 的修法未实现/未验证；R1 的真实触发概率未测（探针用注入延迟放大）；
- CI Node 22/24 未在本地跑（本机 24.20）。

## 九、证据文件（临时，不进仓库）

| 文件 | 内容 |
|---|---|
| `/tmp/q1r-gate-test.log` | gate 包 164/164 exit 0（10.5s） |
| `/tmp/q1r-gate-check.log` | `npm run check` exit 0 |
| `/tmp/q1r-root-test.log` | 根套件 925/925 exit 0 |
| `/tmp/q1r-stress-stale.log` | 12 写者 × 32 轮 stale：0 丢更新 / 0 重复 |
| `/tmp/q1r-stress-control.log` | 无 stale 12 写者 × 20 轮：20/20 |
| `/tmp/q1r-stress-2w.log` | stale 2 写者 × 60 轮：60/60 |
| `/tmp/q1-probe/probe.mjs` | P1–P7（7/7） |
| `/tmp/q1-probe/release-toctou.mjs` | release 终态 / assertOwner / 守护锁接管 |
| `/tmp/q1-probe/release-window.mjs` + `rw-worker.mjs` + `slow-restore.mjs` | R1 复现（C2 4/4；C1 不复现） |
