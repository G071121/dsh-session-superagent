# gate v6 面板审查修复（Q2 修复单）

> 修复人：`q2-panel`（Q2 审查者本人）。日期：2026-11-09。
> 上游：`docs/报告-gate-v6面板审查.md`（Q2 审查，verdict = NEEDS_REVISION，blocker 0 / high 0 / medium 2 / low 3 / info 2）。
> 被改代码树：`D:/主工作区/projects/dsh-gate-v6-integration`，分支 `task/gate-v6-integration` @ `b580681`。
> **本文件是本次修复的唯一产物**；`docs/报告-gate-v6验收.md`（V1）与 `docs/报告-gate-v6面板审查.md`（Q2）
> 都是历史快照，**未改一个字**——对它们的更正集中写在本文 §九。
> 未重启 / 重载 DSH，未动 magpie 配置，未写 `cordis.patch.yml`，真实 profile 只读；
> 未 `git checkout` / `reset` / `stash` / `add` / `commit`（`git status` 见 §十）。

## 结论

| 发现 | 严重度 | 状态 | 关键证据 |
|---|---|---|---|
| **Q2-1** U5-V2b 空转、`modelsSeqRef` 全仓库无判据 | medium | **已修** | harness `fetch` 加 `cache:'no-store'`（打掉请求折叠）+ 新增单测「门禁 models 序号…（Q2-1）」。变异 M1 → 浏览器层 **62 PASS / 2 FAIL（U1-V3、U5-V2b）exit 1**；单测层 **47 tests / 45 pass / 2 fail（U1-G3、Q2-1）exit 1** |
| **Q2-2** 静态护栏只做 `includes`、9/17 条可删 | medium | **已修** | 17 条场景收进 `scripts/gate-model-scenarios.mjs`；套件改走 `gateScenarioCheck(id, …)` + `--list-scenarios` dry-run + 运行期完整性硬断言；护栏改三道闸。三种变异 **全部真红**（§八） |
| **Q2-3** 双闸门只被验到一道 | low | **已定性：第二道不可达** | 变异 M3 → 单测 **47/47 绿**、浏览器 **64/64 绿**。证明 `panelRepoOf() === modelsPanelRepo` 恒成立 ⇒ 第二道永远轮不到。**没有**伪造一条「看起来在测它」的用例；改为把它变成不变式 tripwire 并在 §五 如实说明 |
| **Q2-4** 三条精确请求计数 | low | **已修** | U1-V0 / U5-V1 / U5-V6b 改成语义下界 `>= 1` + 每条 `repo` 全等；负面断言（不读 bravo / 不读 golf）原样保留 |

**`client.js` 一个字节都没动**（sha256 `c6fe935d7b742fa5a21336df245159a966f9dbe13ae36baeffb97c3d27e9e17f`，与 B1 / 基线 `c3753a1` 完全相同）。

---

## 一、改动清单

| 文件 | 改动 | 行数 |
|---|---|---|
| `scripts/gate-model-scenarios.mjs` | **新建**。17 条 `U1-V*` / `U5-V*` 场景的「id → 可读名」唯一真源 + `GATE_MODEL_SCENARIO_IDS` + `GATE_MODEL_REGISTRAR`。零依赖纯数据 | +45 |
| `scripts/verify-panel-chromium.mjs` | ① `window.fetch` 包装加 `cache:'no-store'`（Q2-1）；② 17 处 `check('<场景名>', …)` → `gateScenarioCheck('<id>', …)`；③ 新增 `gateScenarioCheck` / `assertAllGateScenariosRan`；④ 新增 `--list-scenarios` dry-run 出口；⑤ Q2-4 三处语义下界 | +88 / −15 |
| `test/client.test.mjs` | ① 静态护栏结构化成三道闸（Q2-2）；② 新增「门禁 models 序号…（Q2-1）」；③ 新增「panelRepoOf 与 modelsPanelRepo 同源…（Q2-3）」 | +142 / −2 |
| `docs/报告-gate-v6面板修复.md` | **新建**（本文件） | — |

sha256（修复后）：

```
c6fe935d7b742fa5a21336df245159a966f9dbe13ae36baeffb97c3d27e9e17f  client.js            ← 未改
af84b443f14b9e2e83acea77cfc91b939b6223cd8cc61d5dace0a8a34f65c28a  scripts/verify-panel-chromium.mjs
15e2abb7c07a696c6833f4e742119097f3097a309c8a75ecefb131fa6249904a  scripts/gate-model-scenarios.mjs
dfd7471b0ea469e68fc76ec09320b79a7cce90c8028979293be8e516bea54df6  test/client.test.mjs
```

计数变化：`test/client.test.mjs` **168 → 170**（+2）、`PANEL_STRICT` 门禁组 **46 → 48**（+2）、根 `npm test` **965 → 967**（+2）。
Chromium 套件仍是 **64 条**（17 条场景名不变，只是改从常量取）。

---

## 二、Q2-1：请求折叠修复 + `modelsSeqRef` 判据

### 2.1 根因（复核）

Q2 报告已用判定性探针证明：**同 URL 的在途 GET 会被 Chromium 做「请求折叠」**——第二次请求要等第一次
响应结束才真正发出。`client.js` 的 `call()`（`client.js:553`）只写 `await fetch(BASE + path, init)`，
fixture 响应头里的 `cache-control: no-store`（`scripts/verify-panel-chromium.mjs:456`）**挡不住折叠**。
于是 U1-V3 / U5-V2b 里「两次同仓库读取同时在途」根本构造不出来，服务端看到的到达间隔恒等于首条注入延迟
（实测 2006ms / 3003ms）。

### 2.2 修法（只改 harness）

```diff
--- a/scripts/verify-panel-chromium.mjs
+++ b/scripts/verify-panel-chromium.mjs
@@ window.fetch = (input, init) => {
-  return nativeFetch(input, init);
+  // Q2 修复（v6）：同 URL 的在途 GET 会被 Chromium「请求折叠」（第二次要等第一次响应结束才发出），
+  // 于是「同仓库两次读取乱序」（U1-V3 / U5-V2b）根本构造不出来 —— 服务端看到两次请求间隔
+  // 恒等于首条注入延迟（实测 2006ms / 3003ms），拆掉 client.js 的序号闸门也照样全绿。
+  // 响应头 cache-control: no-store 挡不住折叠，必须在 fetch init 里显式 cache: 'no-store'。
+  // 只改 harness，不碰产品代码（client.js 的 call() 保持原样）。
+  return nativeFetch(input, { ...(init || {}), cache: 'no-store' });
```

origin 校验（`url.origin !== location.origin` 直接 reject 并记 `__networkViolations`）原样保留。

### 2.3 新增单测（`test/client.test.mjs:4941`）

`门禁 models 序号：同一仓库两次读取乱序，先发的后到不能覆盖最新列表（Q2-1）`

用 `gateRaceFetch({ deferModels: true })` 让**同一个仓库**（`E:/work/demo`）连点两次「读取模型列表」
→ 两条 `/gates/models` 在飞（断言 `repo` 都是 demo，确保走的是**序号**闸门而不是「跨仓库」闸门）
→ 先 resolve **后发**那条（`m-second` 落地）→ 再 resolve **先发**那条（`m-first-late` 必须整体丢弃）。

```js
  assert.deepEqual(gateModelValues(panel), ['group/deepseek-v4.1-flash-1017', 'm-second'],
    '同一仓库的旧 models 响应后到时不能覆盖最新列表（拆掉 modelsSeqRef 闸门这条必红）')
  assert.equal(panel.text().includes('读取中…'), false, '两条都回来了，不能一直停在读取中')
```

这条是 `modelsSeqRef`（`client.js:2520` / `:2529`）在全仓库的**第一条**判据。

---

## 三、Q2-2：静态护栏结构化（三道闸）

### 3.1 设计

**唯一真源** `scripts/gate-model-scenarios.mjs`：17 条场景的 `id → 可读名`（`U1-V0…V6` 共 7 条 +
`U5-V0…V6b` 共 10 条）。零依赖（套件经 stdin 注入，`import.meta.url` 不可用，只能按绝对 file URL 动态 import）。

**套件侧**（`scripts/verify-panel-chromium.mjs`）：

```js
const registeredGateScenarios = []
function gateScenarioCheck(id, pass, detail) {
  const name = GATE_MODEL_SCENARIOS[id]
  if (!name) throw new Error('未声明或拼错的门禁/模型场景 id：' + id)
  if (registeredGateScenarios.includes(id)) throw new Error('门禁/模型场景重复注册：' + id)
  registeredGateScenarios.push(id)
  return check(name, pass, detail)
}
```

17 处 `check('<场景名>', …)` 全部改成 `gateScenarioCheck('<id>', …)`（`grep -c "gateScenarioCheck('U"` = **17**）。
最后一条场景之后调用 `assertAllGateScenariosRan()`（`scripts/verify-panel-chromium.mjs:1607`）做**运行期**完整性硬断言。

**dry-run 出口**（`scripts/verify-panel-chromium.mjs:116`，不启动浏览器、不连 DSH 安装）：

```js
if (process.argv.includes('--list-scenarios')) {
  const suiteSource = readFileSync(join(REPO, 'scripts', 'verify-panel-chromium.mjs'), 'utf8')
  const registered = [...suiteSource.matchAll(/gateScenarioCheck\(\s*'([A-Za-z0-9-]+)'/g)].map((match) => match[1])
  console.log(JSON.stringify({ declared: GATE_MODEL_SCENARIO_IDS, registered, total: registered.length }, null, 2))
  process.exit(0)
}
```

**护栏侧**（`test/client.test.mjs:5095`）三道闸：

- **A 声明**：`GATE_MODEL_SCENARIO_IDS` 必须正好 **17** 条、不重复、每条可读名以 id 开头
  （用负向断言 `(?![A-Za-z0-9])` 排除「`U5-V2b` 被 `U5-V2` 前缀吃掉」）。
- **B 注册**：`spawnSync(node, [suitePath, '--list-scenarios'])` → 断言 `exit 0`、`total === 17`、
  `registered` 与 `declared` **集合完全相等**（少一条 = 场景被整段删掉；多一条/重复 = 漏登记或重复注册）。
- **C 判据**：每条 id 的注册点必须存在，且**不许是字面量 `true`**（`gateScenarioCheck('<id>', true`）；
  套件代码里**不许出现 `if (false)`**。这两条都在「剥掉 `//` 注释后的代码」上跑
  （注释里正大光明写着这两个词是在解释原因）。

原有护栏（`/gates` 与 `/gates/models` fixture、`/__fixture/gate-delays` 与 `model-delays`、
`/tmp/` 探针禁令、「不是真实 WebView」说明）全部保留；另**新增**一条
「harness 的 `window.fetch` 包装必须带 `cache:no-store`」——防止 Q2-1 的修复被悄悄回退。

### 3.2 边界（如实说明）

- **① 掏空断言**、**③ 整段删掉** 由静态护栏直接挡住（§八）。
- **② `if (false)`** 由静态护栏（`if (false)` 禁令）**和**运行期完整性硬断言**双重**挡住。
- **静态护栏挡不住的是**「把判据改成语义等价但更弱的东西」（例如把 `=== 'x'` 改成 `!== ''`）——
  这类**语义降级**只能靠 code review，文本/结构断言无法覆盖。本文**不**声称挡得住它。
- dry-run 的 `registered` 是**扫套件源码里的注册点**得到的，不是「真的跑过一遍才登记」；
  真正的「跑过了」由套件内 `assertAllGateScenariosRan()` 在每次 Chromium 运行时兜底。

---

## 四、Q2-4：三条语义下界

| 位置 | 改前 | 改后 | 负面断言 |
|---|---|---|---|
| `U1-V0` | `gateGets('…/apple').length === 1` | `gateGets('…/apple').length >= 1 && gateGets().every((row) => row.repo === '…/apple')` | — |
| `U5-V1` | `m1Fresh.length === 1 && m1Fresh[0].repo === '…/alpha'` | `m1Fresh.length >= 1 && m1Fresh.every((row) => row.repo === '…/alpha')` | `modelGets('…/bravo').length === 0`、`!m1Values.some(… model-bravo-)` **原样保留** |
| `U5-V6b` | `freshProject.length === 1 && freshProject[0].repo === '…/foxtrot'` | `freshProject.length >= 1 && freshProject.every((row) => row.repo === '…/foxtrot')` | `m6.golf.length === 0` **原样保留** |

理由与 v5 面板审查 Q2-L2 / v6 Q2-4 一致：将来把重复 load 合并、或加一条重试，精确次数会假红；
而「每条请求都属于面板仓库」这个语义不变量才是真正要守的。

---

## 五、Q2-3：第二道闸门**不可达**（如实说明，未伪造判据）

任务书要求「让序号保持最新、只 resolve 迟到的那条，断言响应被丢弃，使两道闸门各有判据」。
**我做不到，而且已经证明这不是漏测，是这段代码不可达。**

### 5.1 证明

`loadModels()` 的两道闸门（`client.js:2520` 与 `:2523`，catch 分支 `:2529` / `:2530`）：

```js
if (!aliveRef.current || seq !== modelsSeqRef.current) return   // ① 代际序号
if (requestedRepo !== panelRepoOf()) return                      // ② 面板仓库
```

而：

```
panelRepoOf()        = panelRepoRef.current || gateDataRepo(dataRef.current) || repoRef.current
modelsPanelRepo      = panelRepo || repo
panelRepoRef.current = panelRepo                                  // 每次渲染同步写入
```

- 若 `panelRepo` 为**真值** ⇒ 两个表达式都等于 `panelRepo`；
- 若 `panelRepo` 为**假值** ⇒ 只可能是 `dataRepo` 为空 ⇒ 两个表达式都等于 `repo` prop。

**即 `panelRepoOf() === modelsPanelRepo` 恒成立。** 于是 `panelRepoOf()` 一旦变化，`[modelsPanelRepo]`
effect（`client.js:2592`，无任何 guard）就会调 `loadModels()` 把 `modelsSeqRef` 推高一格 ——
**闸门 ① 总是先 `return`**，闸门 ② 永远轮不到。

`loadModels` 的两个显式传参调用点（`load()` 的闸门分支 `loadModels(pendingSource)`、
`cancelRepoSwitch` 的 `loadModels(panelRepoNow)`）算出来的也**恰好等于**当时的 `panelRepoOf()`
（都从同一批 ref 读），所以同样不会让 ② 可达。

### 5.2 实测

| 变异 | 层 | 结果 |
|---|---|---|
| **M3**：`requestedRepo !== panelRepoOf()` 两处 → `false`（sha256 `949f5c9c…`） | 单测（47 条门禁/模型用例） | **47 pass / 0 fail，exit 0** |
| 同上 | 浏览器（正式套件） | **64 PASS / 0 FAIL，exitCode 0** |

### 5.3 本次做了什么

**没有**写一条「看起来在测闸门 ②」的假用例。改为：

1. 新增 `门禁 models：panelRepoOf 与 modelsPanelRepo 同源（第二道闸门不可达的前提）（Q2-3）`
   （`test/client.test.mjs:4988`）—— 把上面那个**派生关系**钉成不变式。四条源码断言
   （`modelsPanelRepo` 的派生、`panelRepoOf()` 的派生、`panelRepoRef.current = panelRepo`、
   `[modelsPanelRepo]` effect）任一被拆开，用例就红，提示「闸门 ② 现在可达了，请给它补独立判据，
   或直接删掉这段死代码」。
2. 本文 §五 把这个结论写死在这里。

### 5.4 给 I1 的建议（**不在本次写作用域**）

`client.js:2523` / `:2530` 的 `if (requestedRepo !== panelRepoOf()) return` 目前是**纯防御性死代码**：
行为正确、但没有任何判据，也永远不会生效。两条路：

- **删掉**（推荐）：少一道闸门、少一处「看起来在防什么其实防不到」的误导；
- **留着**：那就在注释里写明「不可达，理由是 `panelRepoOf() === modelsPanelRepo`；保留是为了
  `panelRepoRef` / `dataRef` 的读取时序万一变化时兜底」，别让它看起来像有判据。

本次任务硬约束「不改 `client.js` 产品逻辑」，所以**没有动**。

---

## 六、验收命令原始输出与退出码

> 全部在本工作树内实跑，未使用任何缓存结论。

### 6.1 `node scripts/test.mjs test/client.test.mjs`

```
✔ 门禁作用域：接官方 SegmentedControl，缺导出回退也有方向键/Home/End/跳过 disabled（Q2-F4） (17.9251ms)
✔ 浏览器证据入库：门禁/模型场景留在正式 Chromium 套件里，且不依赖 /tmp 探针 (481.0296ms)
ℹ tests 170
ℹ suites 0
ℹ pass 170
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 11798.5326
R1_EXIT=0
```

### 6.2 `PANEL_STRICT=1 node scripts/test.mjs --test-name-pattern='门禁' test/client.test.mjs`

```
✔ 门禁 models：panelRepoOf 与 modelsPanelRepo 同源（第二道闸门不可达的前提）（Q2-3） (11.6316ms)
✔ 门禁 StrictMode 双挂载：cleanup 后 effect 重跑要复位 alive（U2-F3） (84.1216ms)
✔ 门禁作用域：接官方 SegmentedControl，缺导出回退也有方向键/Home/End/跳过 disabled（Q2-F4） (23.5382ms)
✔ 浏览器证据入库：门禁/模型场景留在正式 Chromium 套件里，且不依赖 /tmp 探针 (233.9188ms)
ℹ tests 48
ℹ suites 0
ℹ pass 48
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 6778.7941
R2_EXIT=0
```

### 6.3 正式 Chromium 套件

```bash
REPO_W=$(pwd -W); { echo "process.env.DSH_SUPERAGENT_REPO='$REPO_W'"; cat scripts/verify-panel-chromium.mjs; } | ego-browser nodejs
```

```
SUMMARY {
  "passed": 64,
  "failed": 0,
  "total": 64,
  "chromium": "156.0.8078.74",
  "repoVersion": "0.10.11",
  "clientSha256": "c6fe935d7b742fa5a21336df245159a966f9dbe13ae36baeffb97c3d27e9e17f",
  "scriptSha256": "af84b443f14b9e2e83acea77cfc91b939b6223cd8cc61d5dace0a8a34f65c28a",
  "frontendVersion": "0.2.2-rc.1",
  "asarSha256": "5fa8a6b21bceb8f3e99e30efa2270efd0cc773a11e42aa0488f804a64b34e637",
  "exitCode": 0,
  …
}
PIPE_EXIT=0
```

`grep -c '^PASS'` = **64**、`'^FAIL'` = **0**、`'^SKIP'` = **14**（全是截图通道）、
`grep -c '^PASS U1-V\|^PASS U5-V'` = **17**。

### 6.4 `--list-scenarios` dry-run

```
{
  "declared": ["U1-V0","U1-V1","U1-V2","U1-V3","U1-V4","U1-V5","U1-V6",
               "U5-V0","U5-V1","U5-V2","U5-V2b","U5-V3a","U5-V3b","U5-V4","U5-V5","U5-V6a","U5-V6b"],
  "registered": ["U1-V0","U1-V1","U1-V2","U1-V3","U1-V4","U1-V5","U1-V6",
                 "U5-V0","U5-V1","U5-V2","U5-V2b","U5-V3a","U5-V3b","U5-V4","U5-V5","U5-V6a","U5-V6b"],
  "total": 17
}
EXIT=0
```

### 6.5 `node scripts/ui-audit.mjs`

```
PASS 自造 token                   0          目标 0

UI 体检：11/11 通过（100 分）
R3_EXIT=0
```

### 6.6 `node scripts/render-panel-copy.mjs --check`

```
PASS 面板文案与当前实现一致（178 行；最长 77 字符；超过 80 字符的 0 条（上限 3））
R4_EXIT=0
```

### 6.7 根 `npm test`

```
ℹ tests 967
ℹ suites 0
ℹ pass 967
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 70727.2365
NPM_EXIT=0
```

---

## 七、变异验证（全部在 `%TEMP%` 副本上做，不碰工作树）

| # | 变异 | 打哪一层 | 实跑结果 | 退出码 | 判定 |
|---|---|---|---|---|---|
| **M1** | `client.js` 的 `load` + `loadModels` 4 处代际序号闸门 → `false`（`if (!aliveRef.current \|\| false) return`） | 浏览器 | **62 PASS / 2 FAIL** — `FAIL U1-V3 乱序（同仓库）`、`FAIL U5-V2b 被作废的在途 bravo 列表` | **1** | ✅ 两条空转场景**真的会红**了 |
| **M1** | 同上（sha256 `d4501e54…`） | 单测（`--test-name-pattern='门禁'`） | **47 tests / 45 pass / 2 fail** — `✖ 门禁 load 序号…（U1-G3）`、`✖ 门禁 models 序号…（Q2-1）` | **1** | ✅ `modelsSeqRef` 有了判据 |
| **M3** | `loadModels` 的 `requestedRepo !== panelRepoOf()` 两处 → `false`（sha256 `949f5c9c…`） | 单测 | **47 pass / 0 fail** | 0 | ⚠️ 仍绿 → 见 §五（闸门 ② 不可达） |
| **M3** | 同上 | 浏览器 | **64 PASS / 0 FAIL** | 0 | ⚠️ 同上 |
| **Q2-2 ①** | 把 U1-V1 的断言掏空成 `gateScenarioCheck('U1-V1', true, {…})` | 静态护栏 | `✖ 浏览器证据入库…` → **`AssertionError: 场景 U1-V1 的判据是字面量 true（掏空断言）`** | **1** | ✅ |
| **Q2-2 ②** | 把 `gateScenarioCheck('U5-V6b', …)` 整段包进 `if (false)` | 静态护栏 | `✖ 浏览器证据入库…` → **`AssertionError: 正式套件里不许出现 if (false)：那会把场景变成永不执行的死代码`** | **1** | ✅ |
| **Q2-2 ②** | 同上 | 浏览器（运行期兜底） | **51 PASS / 1 FAIL** — `[error] VERIFY_ERROR Error: 门禁/模型场景没有全部执行：实跑 16/17，缺 U5-V6b` → `FAIL 脚本执行完成` | **1** | ✅ 双重挡住 |
| **Q2-2 ③** | 把 U1-V0 整段（含 id 与断言）删掉 | 静态护栏 | dry-run `"total": 16`，`✖ 浏览器证据入库…` → **`AssertionError: dry-run 报的注册条数必须是 17`** | **1** | ✅ |

副本目录：`%TEMP%/q2fix-m1`（M1）、`%TEMP%/q2fix-m3`（M3）、`%TEMP%/q2fix-mut2`（①）、
`%TEMP%/q2fix-mut2b`（②）、`%TEMP%/q2fix-mut3`（③）。日志：`/tmp/q2fix-*.log`。

> 说明：`M3` 那一行是**如实记录失败**——它说明 Q2-3 想要的「独立判据」在当前实现下**不存在**，
> 而不是我漏做了。见 §五。

---

## 八、未验项 / 边界

- **不是真机 WebView**：没有重启 / 重载 DSH，没有在真实宿主会话里点门禁面板。`/gates`、`/gates/models`、
  `POST /gates/preview`、`POST /gates` 全部打脚本自带的 **loopback fixture**——**不是真实服务端、不是真实模型**。
  本文**不**宣称真机通过。
- **请求折叠只在 Chromium 156.0.8078.74（ego-browser 0.6.2.8）上验过**：真实 DSH WebView（Electron）的
  连接池参数、`cache:'no-store'` 是否同样生效、是否 HTTP/2，均**未验**。若宿主行为不同，
  U1-V3 / U5-V2b 可能又变回空转（但静态护栏里那条 `cache:no-store` 断言至少保证 harness 没被改回去）。
- **语义降级挡不住**：见 §三.2 —— 把判据改成语义等价但更弱的东西，文本/结构断言覆盖不了。
- **物理读屏 / 触摸 / IME / 真实 GitHub·Gitee 响应 / 真实 watcher 状态变化**：未验。
- **`packages/dsh-gate` 侧**：不在本次范围（Q1 覆盖）。
- **真实 profile 的 `--repair`**：本次只读，未执行（V1 §八 留给 I1）。

---

## 九、对历史报告的更正（V1 / Q2 都是快照，不改原文）

1. **对 V1 `docs/报告-gate-v6验收.md` §6.3 的更正**：
   V1 §6.3 把「同仓库两次 `/gates` 的乱序在浏览器层不可构造」归因成「HTTP/1.1 连接串行化」。
   **归因不对**：实测不同 URL 的两次并发 GET 服务端到达间隔 0–242ms（完全并发），
   同 URL 才会被拉开到「首条注入延迟」——真实机制是 **Chromium 的在途请求折叠（request collapsing）**，
   用 `cache:'no-store'` 可以打掉。因此 V1 §6.3 的**结论**（「该分支由 node 桩 U1-G3 覆盖」）
   现在应改成「**两条都有浏览器判据**（U1-V3 / U5-V2b），node 桩 U1-G3 / Q2-1 是补充」。
2. **对 Q2 `docs/报告-gate-v6面板审查.md` 的更正**：
   - **Q2-1 / Q2-2 / Q2-4：已修**（本文 §二 / §三 / §四）。
   - **Q2-3：不变式已钉住，但「独立判据」不存在**——闸门 ② 不可达（§五）。Q2 报告里
     「使两道闸门各有判据」这个期望在当前实现下**无法满足**，只能改成「删掉死代码」或「注释标明不可达」。
   - **Q2-5 / Q2-6（info）**：本次**未处理**（不在任务书写作用域）。Q2-5 的延迟队列仍是全局按到达顺序消费；
     Q2-6 的 `/tmp` 检查仍是「按行首 `//` 前缀筛」。两条都不影响本轮结论。
3. **Q2 报告 §一 的计数**（blocker 0 / high 0 / medium 2 / low 3 / info 2）保持不变；
   本文只更正**修复状态**，不回写历史。

---

## 十、工作树状态

```
$ git status --porcelain
 M HANDOFF.md                                          ← 本次开始前既有
 M scripts/verify-panel-chromium.mjs                   ← 本次
 M test/client.test.mjs                                ← 本次
?? docs/报告-gate-v6核心审查.md                        ← Q1 产物（非本次）
?? docs/报告-gate-v6面板审查.md                        ← Q2 产物（非本次）
?? docs/报告-gate-v6面板修复.md                        ← 本次（本文件）
?? scripts/gate-model-scenarios.mjs                    ← 本次（新建）
```

未 `checkout` / `reset` / `stash` / `add` / `commit`；所有变异副本在 `%TEMP%` 下；
未重启 / 重载 DSH，未动 magpie 配置，未写 `cordis.patch.yml`。
