# gate v3 独立验收（V1）

> 验收人：verifier（V1）。日期：2026-11-08。
> 需求来源：`docs/任务书-dsh-gate-v3.md`。
> 被验实现：C1（extends 写盘 fail closed）、U1（面板 `semantic:false` / dirty 切换）、S1（preflight 第四段 + TARGETS 防漏）。
> 本文件是 V1 唯一写权限范围内的产物；源码只读，未改任何实现文件，未重启 DSH、未重载宿主。

## 一、结论

1. **C1 / U1 / S1 可以进入 Q1 / Q2 严格审查。** 在独立副本里全部可复现：根 `npm test` **890/890**、gate 包 **143/143**、`test/client.test.mjs` **148/148**、`test/update-ui.test.mjs` **53/53**、`PANEL_STRICT=1` 门禁用例 **26/26**、UI 体检 **11/11（100 分）**、面板文案快照 **PASS**、真实 Chromium **62/62（exit 0）**；另加我自己的探针：extends **17/17**、TARGETS **4/4**、preflight 第四段 clean / drift / HEAD 基线三组对照。
2. **captain 指定的专项已补上：dirty 切仓库跑的是真实 Chromium + 安装版 React 18 的真实 effect，15/15 全过**（§五 表）。覆盖「取消保留草稿」「确认才放弃」「写盘 / 预览用 `GET /gates` 回显的 `data.repo`，不写刚切过去的仓库」，以及单测桩跑不到的 `useEffect([repo])` / `useEffect([dirty])` 两条路径。`test/fixtures/panel-harness.mjs` 的 `useEffect` 是空实现，这一块只能靠浏览器级验收。
3. **两条红项不在 V1 写作用域，必须由 I1 在发布前清掉**：`README` 单测数仍写 873（实际 890）；**真实安装 profile 需要 `--repair`**（缺失 1 / 断链 3 / 陈旧 0 / 门禁子包漂移 1）。V1 不把它们算通过。详见 §七。
4. **本报告不宣称真机 WebView 通过。** Chromium 段是「安装版前端资源（0.2.2-rc.1）+ loopback fixture 页面 + 真实 client.js」，不是 DSH WebView，也不是真实宿主会话；fixture 的 `/gates`、`/__fixture/workdir` 是进程内 mock，写盘只记录请求体，不落真实磁盘。截图通道沿用前几轮结论继续 SKIP（0/8、0/2），不计产品失败。

## 二、环境与副本

| 项 | 值 |
|---|---|
| 被测工作树 | `D:/主工作区/projects/.tmp-issue9-push-20261106-1244`，分支 `feat/gate-v3` @ `e5cf489` |
| 未提交改动 | 实现 7 改 + 1 新：`client.js`、`packages/dsh-gate/{README.md,lib/index.js}`、`scripts/{preflight.mjs,sync-profile.mjs}`、`test/{client.test.mjs,sync-profile-drift.test.mjs}`、新文件 `packages/dsh-gate/test/extends-write.test.mjs`；另有本报告（V1 唯一产物） |
| 独立验收副本 | `D:/主工作区/projects/.tmp-v1-verify-v3-20261108`（纯目录副本，排除 `.git`；`node_modules/@mycf711/dsh-gate` 复制成实体目录，不是软链） |
| 副本一致性 | `client.js` `8984d60f…`、gate `lib/index.js` `986aef27…`、`preflight.mjs` `d6bc3877…`、`sync-profile.mjs` `1498e740…`、`client.test.mjs` `d35b633e…` —— 与工作树逐字节相同 |
| 运行时 | Node **v24.20.0**，Windows；Chromium **156.0.8078.74**；安装版前端 **0.2.2-rc.1**（asar sha256 `5fa8a6b2…34e637`），React **18.3.1**，primitives 310 个导出 |
| 副本的已知偏差 | 副本没有 `.git` → `维护一致性` 必红（§三 已用真实工作树对照：`check-maintenance.mjs` 6/6 PASS，exit 0）；副本文件 inode 与硬链 profile 不同 → `断链 20`（只在副本里出现） |
| 版本 | 根 `0.10.8`、gate `0.1.1`（本轮未 bump，I1 负责） |

## 三、实跑计数（原始输出，不是字符串宣称）

| 命令（副本内） | 结果 | 退出码 |
|---|---|---|
| `npm test` | `ℹ tests 890 / pass 890 / fail 0`，duration 30809 ms | 0 |
| `cd packages/dsh-gate && npm test` | `ℹ tests 143 / pass 143 / fail 0` | 0 |
| `node --test test/client.test.mjs` | `ℹ tests 148 / pass 148 / fail 0` | 0 |
| `node --test test/update-ui.test.mjs` | `ℹ tests 53 / pass 53 / fail 0` | 0 |
| `PANEL_STRICT=1 node --test --test-name-pattern='门禁' test/client.test.mjs` | `ℹ tests 26 / pass 26 / fail 0` | 0 |
| `node scripts/ui-audit.mjs` | `UI 体检：11/11 通过（100 分）` | 0 |
| `node scripts/render-panel-copy.mjs --check` | `PASS 面板文案与当前实现一致（178 行；最长 77 字符；超过 80 字符的 0 条）` | 0 |
| `node scripts/preflight.mjs --fast --no-maintenance` | 41 行 = **37 PASS / 2 FAIL / 2 SKIP** | **1** |
| `node scripts/preflight.mjs`（完整口径） | 42 行 = **38 PASS / 3 FAIL / 1 SKIP** | **1** |
| `node scripts/check-maintenance.mjs`（真实工作树） | `维护一致性：6 项通过` | 0 |
| Chromium（当前安装，见 §五） | **62/62 PASS**（47 基线 + 15 v3） | 0 |

### 3.1 两条 / 三条红项

`preflight --fast --no-maintenance` 的两条红：

```
FAIL README 单测数        README 写 873，实际 890（改 README）
FAIL profile 一致性 --check  缺失 1 / 断链 20 / 陈旧 0 / 门禁子包漂移 1（lib/index.js），跑 node scripts/sync-profile.mjs --repair
SKIP 冒烟 smoke:observe   --fast 跳过
SKIP 维护一致性           --no-maintenance 跳过
```

完整口径多出的第三条红是**副本没有 `.git`**（`维护一致性`）；真实工作树单独跑是 6/6 PASS，不算产品红。

### 3.2 计数对账（HEAD 基线 vs 本轮，都在独立副本实跑）

| 口径 | HEAD `e5cf489` | 本轮 | 增量 |
|---|---|---|---|
| 根 `npm test` | **873** | **890** | +17 = C1 +10 + U1 +6 + S1 派生守卫 +1 |
| gate 包 | **133** | **143** | +10（`extends-write.test.mjs`） |
| `test/client.test.mjs` | **142** | **148** | +6（U1-A…U1-F） |
| `test/update-ui.test.mjs` | **53** | **53** | 0 |

`README` 里写的 873 正好是 HEAD 的真实值，不是随便写的数 —— 但它是旧值，I1 要改成 890。

## 四、C1：extends 写盘 fail closed（独立探针 17/17；HEAD 基线 1/17）

我自己写的探针（`/tmp/v1-v3-20261108/extends-probe.mjs`）只调 `packages/dsh-gate/lib/index.js`，没有跑 C1 的用例；临时目录全部落在 `os.tmpdir()`，不碰真实用户配置。

| 场景 | 实测 |
|---|---|
| 传入 `extends: './shared.json'` / `'default'` / `true` / 内联对象 | 4 种都抛 `code=extends_not_preservable`；`error.path` 是配置绝对路径；消息含路径与「解决方式」；**不写盘、无 `.bak`、无 `.tmp`** |
| 传入 `extends:false` / `'none'` | 写盘原样保留（磁盘 `false` / `'none'`，`readGateScope` 读回同值）；`loadGateConfig` 后只剩本层规则（`['only-own']`），默认 10 条不参与 → 仍是 replace 语义 |
| 磁盘已有共享 `extends:'./shared.json'`，入参不带 `extends` | 拒绝；文件 sha 不变；不生成 `.bak` |
| 磁盘已有 `extends:false`，入参不带 | 自动保留 `false`，不会悄悄退回 merge |
| `validateConfig` → `writeGateConfig` 组合（面板/API 路径） | `validateConfig` 原样带回 `extends:'./shared.json'`；组合调用仍拒绝 → API 路径不静默丢 |
| 普通保存在无 `extends` 的文件上 | 不凭空生成 `extends` 字段（键仍是 `version/name/rules`） |

**旧行为红**：同一探针跑 HEAD `git archive` 出来的 gate 包 → **1/17**（16 条 FAIL）：共享形式不拒绝、静默写盘、`extends:false` 被丢弃、`validateConfig` 丢掉 `extends`；只有「不凭空生成 extends」这条在旧实现上碰巧通过。

## 五、U1：面板 semantic:false 与 dirty 切仓库

### 5.1 单测层（真实 client.js + 假 React）

- `test/client.test.mjs` 148/148；`PANEL_STRICT=1` 门禁组 26/26。
- 「旧行为红」：把 `client.js` 换成 HEAD 版本、测试文件保持本轮版本，跑 `--test-name-pattern='U1-'` → **0 pass / 6 fail**（U1-A…U1-F 全红，其中 U1-F 报「组件用了 34 个 useState」），证明 6 条用例确实盯的是新行为。
- `GateSettings` 12 个 `useState`、主面板仍 23 槽（U1-F 用「多传一个必须抛」锁住）。

### 5.2 真实 Chromium + React effect（captain 专项，15/15）

临时 harness 由仓库 `scripts/verify-panel-chromium.mjs` 复制后只改验收夹具（不动仓库脚本）：`GET /gates?repo=` 按仓库回显 `data.repo`，`POST /__fixture/workdir` 改 `/state` 的 `watcher.workdir`；点真实面板的「刷新」按钮触发 `/state` 重读，让 `repo` prop 真正变化。

| # | 检查 | 实测证据 |
|---|---|---|
| 1 | 用户层 `semantic:false`：开关 / 底部 / 预览三处一致 | 规则 4/4；`#gate-semantic-enabled [role=switch] aria-checked=false`；正文含「当前关闭」、不含「当前开启」；merge 触发标签「这类触发支持语义复审（当前关闭）」 |
| 2 | 初始 `GET /gates` 带面板仓库 A | `GET /session-superagent/gates?repo=D%3A%2Ffixture%2Fwork%2Fapple` |
| 3 | `semantic:false` 时预览不请求语义复审 | `POST /gates/preview` body `{repo:A, semantic:false, trigger:merge}` |
| 4 | 关一条规则产生真实 dirty | 开关 `aria-checked=false`；保存栏「未保存」；保存按钮可点 |
| 5 | **dirty 切仓库：不静默丢草稿、不读新仓库** | 确认条「仓库已切换到 B：当前面板还是 A 的配置…」；规则仍是 A 的「仓库专属规则 · apple」；`aria-checked` 仍 false；「未保存」仍在；**切换后没有 `GET /gates?repo=B`** |
| 6 | 确认条挂起时预览仍打 A | `POST /gates/preview` body `repo=A`，正文是切换后输入的文本 |
| 7 | **取消保留草稿** | 「已保留草稿：面板仍是 A，保存或放弃这份草稿后才会切到 B」；开关仍 false；仍「未保存」；全程没有 `GET /gates?repo=B` |
| 8 | **取消后保存仍写 A（不写刚切过去的 B）** | `POST /gates` body `repo=A`、`scope=user`；rules 里 `secret.enabled=false` 且是完整规则（`type/pattern/label` 都在）；`config.semantic === false` |
| 9 | 保存后才读新仓库 B | 出现 `GET /gates?repo=B`；规则变成「仓库专属规则 · banana」；保存栏「与已保存的一致」 |
| 10 | **草稿干净时切仓库：`useEffect([repo])` 真实重读** | 改 workdir 到 C + 点刷新 → `GET /gates?repo=C`，规则变「…cherry」，无确认条（单测桩跑不到这条） |
| 11 | **草稿改回一致后自动补读：`useEffect([dirty])`** | dirty 时切到 A：确认条出现、期间 0 次 `GET /gates?repo=A`；把开关改回一致后自动 `GET ?repo=A`，规则变「…apple」，确认条消失 |
| 12 | **确认放弃才切** | 点「放弃草稿并切换」→ `GET /gates?repo=B`，草稿清空、开关回到合并结果、保存栏一致 |
| 13 | 全程写盘 / 预览只认 `data.repo` | 本轮所有 `POST /gates` 的 `repo` 只有 A；所有 `POST /gates/preview` 的 `repo` 也只有 A —— 从未写到 B/C |
| 14 | 切仓库序列完整 | fixture 记录 A→B→C→A→B 与脚本一致 |
| 15 | 全程无页面错误 / 无外部请求 | `captureErrors=[]`、`networkViolations=[]` |

**边界（必须写清）**：这是 Chromium + 安装版前端资源 + loopback fixture，**不是 DSH WebView**；fixture 的 `/gates` 是进程内 mock，`POST /gates` 只记录请求体、不落真实磁盘。真实服务端的规则合并 / 写盘语义由 §四 的真实包探针与 gate 包 143/143 覆盖，两者合起来才是完整链路。

### 5.3 未在浏览器里点的部分（如实列出）

- 面板对**共享 `extends` 的拒绝保存**、`extends:false/'none'` 的「原样写回」提示：只在单测层（U1-B / U1-C，`PANEL_STRICT` 26/26）验过，本轮 Chromium 没点这两条（Chromium 的 fixture 用户层是 `semantic:false`，项目层是普通规则）。
- 官方 SegmentedControl / Switch 的委托路径在 Chromium 里真实渲染并被读写（作用域 radio、规则 switch、语义 switch），但**方向键 / Home / End 键盘操作**沿用既有基线，不在本轮新增。
- 真实宿主内交互（DSH WebView、重载后运行时）没有验：见 §八。

## 六、S1：preflight 第四段与 TARGETS 防漏

### 6.1 第四段「门禁子包漂移」（clean / drift / HEAD 三组对照）

用 `DSH_HOME` 指向 D: 盘上的假 home（与仓库同盘，硬链可用），先 `sync-profile --repair` 造一份**全绿 profile**，再人为改坏 profile 里的 gate `lib/index.js`：

| 场景 | `sync-profile --check` | preflight profile 行 |
|---|---|---|
| 本轮实现，profile 干净 | `缺失 0 / 断链 0 / 陈旧 0 / 门禁子包漂移 0`，exit 0 | `PASS profile 一致性 --check 缺失 0 / 断链 0 / 陈旧 0` —— **没有第四段，不增噪音** |
| 本轮实现，gate 子包漂移 | `缺失 0 / 断链 0 / 陈旧 0 / 门禁子包漂移 1`，exit 1；明细 `内容与 packages/dsh-gate 不一致：lib/index.js` | `FAIL … 缺失 0 / 断链 0 / 陈旧 0 / 门禁子包漂移 1（lib/index.js），跑 node scripts/sync-profile.mjs --repair` |
| **HEAD 基线**，同样漂移 | `缺失 0 / 断链 0 / 陈旧 1 / 门禁子包漂移 1`（漂移被并入陈旧） | `FAIL … 缺失 0 / 断链 0 / 陈旧 1` —— **看不见第四段**，只显示一个来源不明的「陈旧 1」 |

HEAD 基线那行正是 S1 要修的盲区：旧 preflight 只解析三段，子包漂移被折进「陈旧」，报告里不会出现「门禁子包」四个字。

### 6.2 TARGETS 防漏（独立探针 + 两处模拟红）

- 我的探针（`targets-probe.mjs`）从 `package.json` 的 `files / exports / bin / dsh.bundle.patch` + `lib/**` 递归派生 20 个运行时文件，与脚本 `TARGETS` 对比：**4/4 PASS**（无遗漏、无 `test/ docs/ scripts/ packages/`、事故里真实漏掉的 `bin/check.mjs`、`assets/icon-180.png`、`assets/icon-app.png` 都在、每项磁盘存在）。
- 模拟「新增运行时文件忘加清单」两处，都**红并点名**：
  - 副本里新建 `lib/runtime-new.js` → 派生守卫 `0 pass / 1 fail`，报 `这些运行时文件没进 TARGETS…：lib/runtime-new.js`；
  - 副本里新建 `assets/icon-extra.png` 并加进 `package.json.files` → 同样红并点名 `assets/icon-extra.png`。
- **真实 profile 印证这次不是假想**：真实安装副本 `--check` = `缺失 1 / 断链 3 / 陈旧 0 / 门禁子包漂移 1`，缺的正是本轮新纳入 TARGETS 的 **`assets/icon-app.png`**；断链 3 是 `client.js`、`bin/check.mjs`、`assets/icon-180.png` —— 也就是 S1 补的三个文件在旧安装副本里确实没有同步。I1 必须 `--repair` 后复验到 `0 / 0 / 0 / 0`。

## 七、I1 发布前必须处理（V1 不算通过的部分）

1. `README` 单测数 873 → **890**（3.2 已对账；HEAD 真实值 873，本轮 890）。
2. `node scripts/sync-profile.mjs --repair`，再 `--check` 到 **缺失 0 / 断链 0 / 陈旧 0 / 门禁子包漂移 0**；真实安装副本当前的 缺失 1（`assets/icon-app.png`）、断链 3、漂移 1 都必须清零。只声明磁盘一致，**不声明宿主运行时生效**（要重载后另验）。
3. 版本 bump：主包下一 patch、gate 按真实变更 bump（`packages/dsh-gate/package.json`、`PACKAGE_VERSION`、两处测试断言、根依赖），再合并 main 后写最终测试数。
4. Chromium 套件本身仍不覆盖门禁面板（§五 用的是临时 harness）；建议 Q2 / I1 决定是否把门禁往返并入正式套件，否则下一轮改面板仍然没有浏览器级守卫。
5. `npm pack` 内容（preflight PASS，30 个文件）与 TARGETS 的发布一致性由派生守卫守着；bump 后需复跑。

## 八、未验项 / 边界

- **不是真机 WebView**：没有重启 / 重载 DSH，没有在真实宿主会话里点门禁面板；profile 安装副本仍是旧内容（见 §七）。
- **截图未产出**：`CAPTURE_SCREENSHOTS=false`，desk 0/8、orbit 0/2 沿用既有「CDP 截图通道会终止进程」的结论，不计产品失败，也没有拿截图当任何证据。
- 未验物理读屏 / 触摸 / IME、真实 GitHub / Gitee 响应、真实模型调用、真实仓库写操作。
- 面板「共享 extends 拒绝保存」与「`extends:false` 原样写回提示」只在单测层验过（§5.3）；本轮 Chromium 未点这两条。
- 并发写同一层的 TOCTOU 未压测（C1 边界，沿用实现方声明：无文件锁，靠 `.bak` + 原子 rename）。

## 九、证据文件（临时，不进仓库）

| 文件 | 内容 |
|---|---|
| `/tmp/v1-v3-20261108/npm-test.log` / `gate-test.log` / `client-test.log` / `update-ui-test.log` | §三 计数原始输出 |
| `/tmp/v1-v3-20261108/panel-strict-gate.log` | PANEL_STRICT 26/26 |
| `/tmp/v1-v3-20261108/ui-audit.log` / `panel-copy.log` | UI 体检 / 文案快照 |
| `/tmp/v1-v3-20261108/preflight-fast.log` / `preflight-full.log` | preflight 原始行与退出码 |
| `/tmp/v1-v3-20261108/extends-probe.mjs` / `extends-fixed.log` / `extends-baseline.log` | §四 探针（fixed 17/17；HEAD 1/17） |
| `/tmp/v1-v3-20261108/u1-red-baseline.log` | U1 用例跑 HEAD `client.js`：0/6 |
| `/tmp/v1-v3-20261108/gate-v3-chromium.mjs`（sha `57fcb09…`）/ `chromium3.log` | §五 Chromium harness 与 62/62 原始输出；前两次尝试因 `page.fill` / `page.click` 不自动滚动在 Ego 侧中止，已加 `scrollIntoView` 后重跑，最终一次干净通过 |
| `/tmp/v1-v3-20261108/fourth2-*.log` / `baseline-*.log` | §六 第四段 clean / drift / HEAD 对照 |
| `/tmp/v1-v3-20261108/targets-probe.mjs` / `targets-red-*.log` | §六 TARGETS 探针与模拟红 |

仓库自带 Chromium 脚本 `scripts/verify-panel-chromium.mjs` sha256 `b065c6d0…`；本轮**没有改**它，也没有改任何实现文件。
