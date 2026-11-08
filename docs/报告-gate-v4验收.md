# gate v4 独立验收（V1）

> 验收人：verifier（V1）。日期：2026-11-08。
> 需求来源：[任务书-dsh-gate-v4](任务书-dsh-gate-v4.md)。
> 被验实现：C1（门禁写锁与 Windows rename 重试）、U1（面板 load 竞态）、S1（TARGETS 存在性与 preflight 第四段用例）。
> 本文件是 V1 写权限内的唯一产物；源码只读，未改实现文件，未重启 DSH、未重载宿主。

## 一、结论

1. **三条交付分支可以进入 Q1 / Q2 审查。** 独立集成 worktree 合并三个分支后全部复跑：根 `npm test` **917/917**、
   gate 包 **156/156**、`test/client.test.mjs` **155/155**、`test/update-ui.test.mjs` **53/53**、
   `test/sync-profile-drift.test.mjs` **11/11**、`PANEL_STRICT` 门禁组 **33/33**、UI 体检 **11/11（100 分）**、
   面板文案快照 **PASS**、真实 Chromium 官方套件 **47/47**、门禁专项 Chromium **54/54**。
2. **先红后绿在独立探针里成立，不是只看实现方用例。** C1：基线 8 轮并发同层写只有 1 轮两个写者都成功（其余 EPERM），
   合并后 8/8 都成功且 `extends:"none"` 一轮不丢。S1：删掉一条 TARGETS 源文件，基线 `--check` **exit 0 假绿**，
   合并后 **exit 2 并点名**。U1：node 桩层基线 **5/13 红**，真实 Chromium 基线 **2 项红**
   （U1-V1 迟到的旧仓库响应覆盖新仓库、U1-V2 在途 dirty 草稿被清）。
3. **三条红项不在 V1 写作用域，I1 发布前必须清掉**：README 单测数仍写 890（实测 917）；真实安装 profile 需要
   `--repair`（断链 21 / 门禁子包漂移 1）；版本未 bump（`check-maintenance` 1 项未过）。V1 不把它们算通过。
4. **本报告不宣称真机 WebView 通过。** Chromium 段是「安装版前端资源 0.2.2-rc.1 + loopback fixture 页面 +
   真实 `client.js` + 安装版 React 18.3.1」；`test/fixtures/gate-panel.mjs` 的 node vm 桩只用于快速回归，
   **不**作为浏览器证据。截图通道沿用既有结论继续 SKIP（desk 0/8、orbit 0/2），不计产品失败。

## 二、环境与集成副本

| 项 | 值 |
|---|---|
| 集成 worktree | `D:/主工作区/projects/dsh-gate-v4-integration`，分支 `task/gate-v4-integration` @ `45faf61` |
| 合并来源 | `task/gate-v4-core` @ `c52ce02`、`task/gate-v4-scripts` @ `bc01388`、`task/gate-v4-ui` @ `efdda5b` |
| 合并方式 | 三次 `git merge --no-ff`（`dcfaeac` / `7d127d2` / `45faf61`），无冲突；相对 `8ee4abe` 共 12 个文件 +1724 / −80 |
| 基线 | `feat/gate-v4` @ `8ee4abe`（= main `2cad1a6` + v4 任务书） |
| 运行时 | Node **v24.20.0**、npm 11.19.0、Windows；Chromium **156.0.8078.74**、React **18.3.1**、primitives 310 个导出 |
| 安装版前端 | `D:/DeepSeek Harness/Desktop-0.2.2-rc.1`，asar sha256 `5fa8a6b2…34e637`，前端 `0.2.2-rc.1` |
| 版本 | 根 `0.10.9`、gate `0.1.2`（本轮未 bump，I1 负责） |
| 副本一致性 | `client.js` `47f28e89…`、gate `lib/index.js` `edb88e8a…`、`config-lock.js` `8a2829ea…`、`preflight.mjs` `8c150f01…`、`sync-profile.mjs` `c70972f2…`、`client.test.mjs` `4fcba352…`、`sync-profile-drift.test.mjs` `46fe3d16…` |
| 依赖处理 | 从共享树复制 `node_modules`（gitignored，未进提交），`@mycf711/dsh-gate` 用 junction 指向本 worktree 的 `packages/dsh-gate` |

## 三、实跑计数（原始输出，不是字符串宣称）

| 命令（集成 worktree 内） | 结果 | 退出码 |
|---|---|---|
| `npm test` | `ℹ tests 917 / pass 917 / fail 0`，duration 25841 ms | 0 |
| `cd packages/dsh-gate && npm test` | `ℹ tests 156 / pass 156 / fail 0`，duration 2334 ms | 0 |
| `cd packages/dsh-gate && npm run check` | 5 个文件 `node --check` 通过 | 0 |
| `node --test test/client.test.mjs` | `ℹ tests 155 / pass 155 / fail 0` | 0 |
| `node --test test/update-ui.test.mjs` | `ℹ tests 53 / pass 53 / fail 0` | 0 |
| `node --test test/sync-profile-drift.test.mjs` | `ℹ tests 11 / pass 11 / fail 0` | 0 |
| `PANEL_STRICT=1 node --test --test-name-pattern='门禁' test/client.test.mjs` | `ℹ tests 33 / pass 33 / fail 0` | 0 |
| `node scripts/ui-audit.mjs` | `UI 体检：11/11 通过（100 分）` | 0 |
| `node scripts/render-panel-copy.mjs --check` | `PASS 面板文案与当前实现一致（178 行；最长 77 字符；超过 80 字符的 0 条（上限 3））` | 0 |
| `node scripts/preflight.mjs --fast --no-maintenance` | 41 行 = **37 PASS / 2 FAIL / 2 SKIP** | **1** |
| `node scripts/preflight.mjs`（完整口径） | 42 行 = **38 PASS / 3 FAIL / 1 SKIP** | **1** |
| `node scripts/check-maintenance.mjs` | 5 PASS / 1 FAIL（`自上个 tag 起未改动运行时代码`） | 1 |
| `node scripts/audit-readme-tests.mjs 917` | `FAIL README 单测数  README 写 890，实际 917（改 README）` | 1 |
| Chromium 官方套件（§五） | **47/47 PASS** | 0 |
| Chromium 门禁专项（§五，临时 harness） | **54/54 PASS**（47 基线 + 7 项 U1） | 0 |
| U1 基线对照（临时 harness 换回 `2cad1a6` 的 `client.js`） | **52 PASS / 2 FAIL**（U1-V1、U1-V2 红） | 1 |

### 3.1 红项原文（preflight 完整口径）

```
FAIL README 单测数                        README 写 890，实际 917（改 README）
FAIL profile 一致性 --check               缺失 0 / 断链 21 / 陈旧 0 / 门禁子包漂移 1（lib/config-lock.js, lib/index.js, package.json），跑 node scripts/sync-profile.mjs --repair
FAIL 维护一致性                             不一致：自上个 tag 起未改动运行时代码（未 bump 不算错，只提示）
SKIP 冒烟 smoke:observe              需要真机宿主（已列进攒批清单）
```

`--fast --no-maintenance` 少了「维护一致性」这一条（被显式跳过），其余两条一致。断链 21 是集成 worktree 与
profile 硬链 inode 不同导致的副本现象；门禁子包漂移 1（3 个文件）是真实的 v4 变更未同步进 profile。

### 3.2 计数对账（基线在 `8ee4abe` 的独立副本实跑）

| 口径 | 基线 `8ee4abe` | 本轮 | 增量 |
|---|---|---|---|
| 根 `npm test` | **890**（889 pass + 1 条路由用例在并发负载下超时失败） | **917** | +27 |
| gate 包 | **143** | **156** | +13（`test/config-lock.test.mjs`） |
| `test/client.test.mjs` | **148** | **155** | +7（U1-G1…G6 + G4b） |
| `test/sync-profile-drift.test.mjs` | **5** | **11** | +6（TARGETS 2 + preflight 4） |
| 其它 | — | — | +1：新 fixture `test/fixtures/gate-panel.mjs` 被 `node --test` 当作测试文件（0 用例） |

README 写的 890 与基线实测一致；S1 报告里「基线 891」是误记，以本表为准。I1 要把 README 改成 **917**。

## 四、C1：跨进程写锁与 Windows rename 重试

独立探针（`/tmp/v1-v4-probe/probe.mjs` + `gate-worker.mjs`）只调公开 API，临时目录全部落在 `os.tmpdir()`，
不碰真实用户配置；基线是 `git archive 2cad1a6` 出来的 gate 包。

| 场景 | 合并后 | 基线 `2cad1a6` |
|---|---|---|
| 8 轮 × 2 个真实子进程 × 20 次同层写，两个写者都 exit 0 | **8/8** | **1/8**（其余轮次 EPERM/EBUSY 直接失败） |
| 最终 `extends:"none"` 保留 | **8/8** | 8/8（该轮次靠最后写者碰巧胜出，不能算通过） |
| 最终文件只有 1 条规则（整层替换语义） | **8/8** | — |
| 不留 `.tmp-` / `.lock` | **8/8** | — |
| 锁被占用：抛 `gate_lock_timeout`，带 `pid=` 与「未在无锁状态下写入」 | **PASS** | 无锁 API |
| 锁被占用：磁盘原样不动、不产生 `.bak` / `.tmp` | **PASS** | — |
| stale 锁（所有者 pid 已死）：接管并记录 `owner_dead` + 年龄 + 所有者 | **PASS** | — |
| rename 前两次 EPERM/EBUSY：第 3 次成功，目标文件被替换 | **PASS** | 无重试 |
| rename 重试耗尽：`code/path/attempts` 齐全，原文件不变、临时文件清理、锁释放 | **PASS** | — |

探针合计 **15/15 PASS**。实现侧另用 13 条真实子进程用例覆盖「计数一次不少」「两写者不丢 extends」「活锁不抢」等，
gate 包 156/156 已复跑。跨主机共享盘、真实长期句柄占用下的 EPERM 仍未验（实现方 README 已声明）。

## 五、U1：面板 load 竞态

### 5.1 单测层（真实 `client.js` + 假 React）

- `test/client.test.mjs` 155/155；`PANEL_STRICT=1` 门禁组 33/33。
- **先红**：把 `client.js` 换回 `2cad1a6`、测试文件保持本轮版本，跑 `--test-name-pattern='U1-'` →
  **13 tests / 8 pass / 5 fail / exit 1**：U1-G1 乱序旧仓库覆盖、U1-G2 在途 dirty 被清、U1-G3 同仓库乱序、
  U1-G4b 取消后仍被切走、U1-G6 卸载后 setState。
- 门禁组件仍 12 个 `useState`，主面板仍 23 槽（35 槽断言绿）。

### 5.2 真实 Chromium + 安装版 React 18（临时 harness）

harness 由 `scripts/verify-panel-chromium.mjs`（sha256 `b065c6d0…`，**未改仓库脚本**）复制后只改验收夹具：
`GET /gates` 按请求顺序消费「延迟 / 失败 / 每仓序号」，`POST /__fixture/workdir` 改 `/state` 的 watcher workdir，
点面板「刷新」让 `repo` prop 真正变化。7 项 U1 检查全过（54/54）：

| # | 检查 | 实测证据 |
|---|---|---|
| U1-V0 | 门禁分区真实渲染，第一次读取由真实 `useEffect([repo])` 发出 | `GET /gates?repo=D%3A%2Ffixture%2Fwork%2Fapple` |
| U1-V1 | **跨仓库乱序**：apple 响应迟到 2s，banana 先回；旧响应不能覆盖 | 面板停在 `banana #1`；基线同一场景显示 `apple #1`（**红**） |
| U1-V2 | **在途 dirty**：cherry 读取在途时输入草稿，响应回来不清草稿 | 值仍 `手工草稿-未保存`、保存栏「未保存」；基线被清成 `cherry #1`（**红**） |
| U1-V3 | 同仓库两次读取乱序：`重新读取` 同一帧点两次，先发的后到不能覆盖 | 最终 `damson #3`；基线同场景也过（见 §5.3） |
| U1-V4 | 取消换仓库：保留草稿，且不读新仓库 | 确认条文案完整；elder 请求 0 次；草稿仍是「保存前草稿-保留」 |
| U1-V5 | 保存 / 预览写 `GET` 回显的 `data.repo` | `POST /gates` 与 `POST /gates/preview` 的 `repo` 都是 `D:/fixture/work/damson` |
| U1-V6 | 保存成功后按当前仓库重读并清掉「保留草稿」提示 | 面板切到 `elder #2`，提示消失 |

全程 `captureErrors=[]`、`networkViolations=[]`；写操作只落 loopback fixture，未碰真实磁盘。

### 5.3 浏览器层的边界（如实列出）

- **同仓库乱序在真实 Chromium 里无法构造**：两次同 URL GET 在同一帧发出时，Chrome 复用同一条 HTTP/1.1 连接，
  服务端到达时间相差 2020 ms（= 第一次响应完成），请求被串行化。因此 U1-V3 在基线上也通过；
  它的红由 node 桩层 U1-G3 证明。跨仓库乱序（U1-V1）在浏览器层可复现，走的是同一段 `loadSeqRef` / `repoRef` 代码。
- 面板对共享 `extends` 的拒绝保存、`extends:false/'none'` 的写回提示只在单测层验过；本轮 Chromium 未点。
- 官方 Chromium 套件只断言左栏有「门禁」，**不打开门禁分区**；上面的专项 harness 是临时文件，未进仓库。
  是否并入正式套件由 Q2 / I1 决定。

## 六、S1：TARGETS 存在性与 preflight 第四段

### 6.1 TARGETS 删源（独立副本 + 基线对照）

在仓库副本里删掉 `bin/check.mjs`（dest 里的硬链还在，所以「缺失」仍是 0）：

| 实现 | `--check` | `--repair` | preflight 的 profile 行解析 |
|---|---|---|---|
| 合并后 | **exit 2**，`缺源 bin/check.mjs（仓库里没有这个文件：恢复它，或把这一行从 TARGETS 删掉）` + `缺失 0 / 断链 0 / 陈旧 0 / 门禁子包漂移 0 / TARGETS 缺源 1（bin/check.mjs）` | **exit 2**，`TARGETS 有 1 条在仓库里不存在` | `clean:false`、`manifest:1`、点名 `bin/check.mjs` |
| 基线 `2cad1a6` | **exit 0**，`缺失 0 / 断链 0 / 陈旧 0 / 门禁子包漂移 0`（假绿） | — | `clean:true`（**看不见**） |

干净副本 `--repair` 后 `--check` = `缺失 0 / 断链 0 / 陈旧 0 / 门禁子包漂移 0`，exit 0；preflight 行只显示三个数
`缺失 0 / 断链 0 / 陈旧 0`，不出现第五段噪音。老格式（只有三段）按不干净处理。

### 6.2 preflight 第四段 / 第五段

`summarizeProfileCheck` 抽成导出纯函数后，preflight 与 `test/sync-profile-drift.test.mjs` 用同一份解析：
clean / 门禁子包漂移 / TARGETS 缺源 三态分别 `PASS` / `FAIL`（`门禁子包漂移 1（lib/index.js）`）/
`FAIL`（`TARGETS 缺源 1（bin/check.mjs）`）。夹具之外，真实升级路径的 `--repair` 仍未跑（I1 项）。

## 七、代码审查（只读）

| # | 严重度 | 位置 | 问题 | 建议 |
|---|---|---|---|---|
| R1 | low | `scripts/preflight.mjs:14` | `pathToFileURL` 导入后未使用（新增 `import.meta.main` 判据时带进来的死导入） | I1 顺手删掉，或确认后续要用 |
| R2 | low | `packages/dsh-gate/lib/config-lock.js:48` | 锁路径按调用方传入的**字符串**派生：同一文件的不同写法（大小写 / 正反斜杠 / 相对 vs 绝对）会得到不同 `.lock`，跨写法并发不受同一把锁保护 | 文档里写明「同机、同路径字符串」；如需更严，在 `gateLockPath` 前 `resolve()` 归一 |
| R3 | low | `client.js:2412` / `client.js:2421`（`aliveRef`） | 只在 cleanup 里置 `false`，effect 重跑时不复位。React 18 **开发模式** StrictMode 双挂载会让门禁面板永久丢弃响应（生产构建不双挂载，不受影响） | 开发用 `dev:web` 时观察一次；真要兼容就在 effect 体里先 `aliveRef.current = true` |
| R4 | info | `scripts/verify-panel-chromium.mjs` | 官方套件没有门禁分区往返，`/gates` 直接 404；U1 的浏览器级守卫目前只在临时 harness 里 | Q2 / I1 决定是否把门禁往返并入正式套件 |
| R5 | info | `packages/dsh-gate/lib/index.js:2498` | 写盘 HTTP 路由把 `gate_lock_timeout` 折成 400 `save_failed`，返回值里的 `lock.broken` 没进响应 | 面板只展示错误文本，可接受；如需诊断可把 `broken` 带进 JSON |

## 八、I1 发布前必须处理（V1 不算通过的部分）

1. `README` 单测数 890 → **917**（§3.2 已对账）；`AGENTS.md` 的「890/890」与 docs 里引用旧计数的地方一起回填。
2. `node scripts/sync-profile.mjs --repair`，再 `--check` 到 **缺失 0 / 断链 0 / 陈旧 0 / 门禁子包漂移 0**，
   且第五段「TARGETS 缺源」不出现；只声明磁盘一致，**不声明宿主运行时生效**（要重载后另验）。
3. 版本 bump：根下一 patch、gate 按真实变更 bump（`packages/dsh-gate/package.json`、`PACKAGE_VERSION`、两处测试断言、
   根依赖），让 `check-maintenance` 6/6；CHANGELOG 写清 C1 / U1 / S1 与新的退出码 2、第五段口径。
4. 合并 main 后按最终树复跑全量（本报告的 917 是集成分支数字）；`npm pack` 与 TARGETS 派生守卫要跟着 bump 复跑。

## 九、未验项 / 边界

- **不是真机 WebView**：没有重启 / 重载 DSH，没有在真实宿主会话里点门禁面板；profile 安装副本仍是旧内容（§八）。
- 未验物理读屏 / 触摸 / IME、真实 GitHub / Gitee 写操作、真实模型调用、真实 watcher 状态变化。
- 跨主机共享盘（NFS / SMB）上的写锁语义、真实长期文件句柄占用下的 rename EPERM：实现方已声明未验，本轮沿用。
- 同仓库乱序在浏览器层不可达（§5.3）；`aliveRef` 的 StrictMode 开发模式风险（R3）未在 `dev:web` 里实测。
- CI 矩阵 Node 22 / 24 未跑（本机 Node 24.20；`import.meta.main` 需要 22.18+，engines 要求 >=22.19）。
- 截图通道 SKIP（desk 0/8、orbit 0/2），没有拿截图当任何证据。

## 十、证据文件（临时，不进仓库）

| 文件 | 内容 |
|---|---|
| `/tmp/v4-root-test.log` / `v4-gate-test.log` / `v4-client-test.log` / `v4-update-ui-test.log` | §三 计数原始输出 |
| `/tmp/v4-sync-profile-test.log` / `v4-panel-strict.log` / `v4-ui-audit.log` / `v4-panel-copy.log` | S1 用例、PANEL_STRICT、UI 体检、文案快照 |
| `/tmp/v4-preflight-fast.log` / `v4-preflight-full.log` / `v4-maintenance.log` / `v4-readme-tests.log` | §三 红项原文 |
| `/tmp/v4-baseline-count.log` | 基线 `8ee4abe` 的 890 条计数（其中 1 条路由用例在并发负载下 `'notfound' !== null` 失败，17.3s 超时形状，与本轮改动无关） |
| `/tmp/v1-v4-probe/probe.mjs` + `gate-worker.mjs` + `/tmp/v4-c1-probe.log` | §四 C1 探针（15/15）与基线对照 |
| `/tmp/v4-targets-clean-*.log` / `v4-targets-missing-*.log` | §六 TARGETS 干净 / 删源 / 基线对照 |
| `/tmp/v4-chromium.log` | 官方 Chromium 套件 47/47 |
| `/tmp/v1-v4-probe/gate-race.mjs`（sha256 `f1c60aa5…`）/ `/tmp/v4-gate-race.log` / `v4-gate-race-baseline.log` | §五 门禁专项：合并后 54/54、基线 52/2 |

仓库自带 Chromium 脚本 `scripts/verify-panel-chromium.mjs` 本轮**没有改**，也没有改任何实现文件；
本报告单独提交在 `task/gate-v4-integration`（提交信息 `docs: gate v4 独立验收报告（V1）`），提交后工作树干净。
