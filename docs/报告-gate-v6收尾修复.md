# gate v6 收尾修复（Q2R R1 / R2）

> 修复人：`q2-panel`。日期：2026-11-09。
> 上游：`docs/报告-gate-v6面板复审.md`（Q2R 复审）§六 **R1（low）** / **R2（low）**。
> 被改代码树：`D:/主工作区/projects/dsh-gate-v6-integration`，分支 `task/gate-v6-integration`。
> **本文件是本次修复的唯一产物**；V1 / Q2 / Q2R 三份历史报告都**未改一个字**。
> 未重启 / 重载 DSH，未动 magpie 配置，未写 `cordis.patch.yml`，真实 profile 只读；
> 未做任何 `git` 写操作（`checkout` / `reset` / `stash` / `add` / `commit` 全部没跑）。

## 结论

| 发现 | 严重度 | 状态 | 一句话 |
|---|---|---|---|
| **R1** 运行期完整性断言自身无判据，可静默删除 | low | **已修** | 静态护栏新增两条存在性断言（定义 + 调用），都跑在**剥注释后**的代码上。删掉调用后 `npm test` 立刻红 |
| **R2** 去注释只按行首 `//`，块注释可绕过 | low | **已修** | 换成八态状态机 `stripComments()`（含**正则字面量**识别），三条静态闸全部改跑剥离结果。把注册点整段包进 `/* … */` 后立刻红 |

**`client.js` 一个字节没动**（sha256 `c6fe935d7b742fa5a21336df245159a966f9dbe13ae36baeffb97c3d27e9e17f`）。
`scripts/verify-panel-chromium.mjs` **本次也没动**（sha256 仍是 `af84b443…`）——只改 `test/client.test.mjs`。

改动：`test/client.test.mjs` **+1 条自检用例**（170 → 171），新增 `stripComments()`（`:5110`）+ 两条 R1 存在的断言（`:5246` 护栏内 D 段）。

---

## 一、R1：给第三道闸本身加判据

### 症状（Q2R 原文）

`scripts/verify-panel-chromium.mjs:1607` 的 `assertAllGateScenariosRan()` 是 Q2-2 的第三道闸
（运行期兜底），但静态护栏**全文没有引用它**。把它那一行删掉，`npm test` 仍全绿 —— 闸门被静默移除。

### 修法

`test/client.test.mjs` 的「浏览器证据入库」护栏新增 **D 段**：

```js
  // D. 第三道闸本身也要有判据（Q2R R1）：`assertAllGateScenariosRan()` 是运行期兜底，
  //    但静态护栏原来**没有引用它** —— 删掉那一行调用，`npm test` 仍全绿，闸门被静默移除。
  //    这里把「定义还在」+「调用还在」都钉住（同样跑在剥注释后的代码上）。
  assert.match(code, /function\s+assertAllGateScenariosRan\s*\(/,
    '正式套件缺 assertAllGateScenariosRan 的定义（第三道闸被删了？）')
  assert.match(code, /^[ \t]*assertAllGateScenariosRan\(\)[ \t]*$/m,
    '正式套件没有调用 assertAllGateScenariosRan()：运行期完整性断言被静默移除，第三条闸失效')
```

两条都跑在 `code`（= `stripComments(source)`）上，所以 R2 的「包进注释」同样绕不过去。
调用点用的是**整行锚定**（`^…$` + `m`），不会误命中定义行（那行有 `function ` 前缀）。

---

## 二、R2：去注释改成真状态机

### 症状（Q2R 原文）

`test/client.test.mjs` 原来是
`sourcesplit('\n').filter((line) => !line.trim().startsWith('//'))`——
只按**行首** `//` 过滤。把一条场景的注册点整段包进 `/* … */`，行首不是 `//`，
三道静态闸全绿（注册点文本还在、`--list-scenarios` 仍数到 17）。

### 修法

新增 `stripComments(text)`（`test/client.test.mjs:5110`），**八态**字符扫描：

| 状态 | 触发 | 退出 |
|---|---|---|
| `code` | 默认 | 见下 |
| `line` | `//` | `\n`（换行保留，其余换空格） |
| `block` | `/*` | `*/`（换行保留，其余换空格） |
| `single` | `'` | 未转义的 `'` |
| `double` | `"` | 未转义的 `"` |
| `template` | `` ` `` | 未转义的 `` ` `` |
| （模板插值） | 模板里 `${` | 配平的 `}` 后回到 `template` |
| `regex` | `code` 里 `/` 且**上一个有效字符**允许 | 未转义、且不在字符类里的 `/` |

**为什么要正则态**：套件里有 `/\/tmp\//` 这类正则。不识别的话，尾部的 `\//` 会被当成行注释吃掉
—— 那是**剥过头**，方向是假绿。起止用标准的「看前一个有效字符」启发式：
上一个有效字符是 `( , = : [ ! & | ? { } ; + - * % ^ ~ < >` 或 `return` / `typeof` 等关键字
→ `/` 是正则开头；是标识符 / 数字 / `)` / `]` → 是除号。

**两个方向都有自检用例**（`test/client.test.mjs:5202`，`护栏自检：stripComments …（Q2R R2）`）：

- 不许少：`'http://x//y'`、`"a/*b*/c"`、`` `a//b` ``、`/\/tmp\//`、`/a[/]b/g`、`'a\'b//c'`
  —— 原样返回；
- 不许多：`a / b // c`、`(a) / 2 // c`、`n[0] / 2 // c`、`10 / 2 // c` —— 除号留住、行注释剥掉
  （把除号当正则开头会一路吃到下一个 `/`，把真代码吃掉 → 假绿）；
- 模板插值里的注释要剥、模板本身与 `${}` 嵌套要留住；
- 行号不变（注释位换空格、换行保留）且**幂等**。

文件头注释里「不依赖 `/tmp` 探针」那条语义检查**保留**：`/\/tmp\//` 只在 `code`（剥注释后）上查，
JSDoc 里的 `/tmp/` 已被剥掉，所以「注释里写了 `/tmp/`」不会假红。

---

## 三、变异验证（全部在 `%TEMP%` 副本上做，不碰工作树）

### 3.1 R1：删掉 `assertAllGateScenariosRan()` 调用

```bash
cd %TEMP%/q2r-m1
sed -i '/^  assertAllGateScenariosRan()$/d' scripts/verify-panel-chromium.mjs
node scripts/test.mjs --test-name-pattern='浏览器证据入库' test/client.test.mjs
```

```
=== 调用已删（应为 0 处调用）===
0
SYNTAX_OK
ℹ tests 1
ℹ pass 0
ℹ fail 1
  AssertionError [ERR_ASSERTION]: 正式套件没有调用 assertAllGateScenariosRan()：运行期完整性断言被静默移除，第三条闸失效
EXIT=1
```

✅ **修前**：删掉后 `npm test` 全绿（Q2R R1 实测）；**修后**：红。

### 3.2 R2：把 U5-V6b 的注册点整段包进 `/* … */`

```bash
cd %TEMP%/q2r-m2
# 用 /* … */ 包住 gateScenarioCheck('U5-V6b', …) 那五行
DSH_SUPERAGENT_REPO=$(pwd -W) node scripts/verify-panel-chromium.mjs --list-scenarios
node scripts/test.mjs --test-name-pattern='浏览器证据入库' test/client.test.mjs
```

```
R2 mutation applied
SYNTAX_OK
=== dry-run（仍数到 17：源码文本还在）===
  "total": 17
=== 静态护栏（期望红：R2 块注释剥离）===
ℹ tests 1
ℹ pass 0
ℹ fail 1
  AssertionError [ERR_ASSERTION]: 场景 U5-V6b 没有通过 gateScenarioCheck 注册
EXIT=1
```

✅ **修前**：`--list-scenarios` 数到 17、三道静态闸全绿（Q2R R2 实测）；**修后**：
dry-run 仍数到 17（它扫的是原始源码，本来就该），但**剥注释后**的 C 段立刻红。

> 这两条正是 Q2R 报告里给出的**最小复现**，我按原文重跑并确认修后变红。

---

## 四、验收命令原始输出与退出码

### 4.1 `node scripts/test.mjs test/client.test.mjs`

```
✔ 门禁 StrictMode 双挂载：cleanup 后 effect 重跑要复位 alive（U2-F3） (85.9495ms)
✔ 门禁作用域：接官方 SegmentedControl，缺导出回退也有方向键/Home/End/跳过 disabled（Q2-F4） (9.9631ms)
✔ 护栏自检：stripComments 只剥注释，不吞字符串/模板/正则里的内容（Q2R R2） (0.6867ms)
✔ 浏览器证据入库：门禁/模型场景留在正式 Chromium 套件里，且不依赖 /tmp 探针 (160.79ms)
ℹ tests 171
ℹ suites 0
ℹ pass 171
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 6673.7885
R1_EXIT=0
```

### 4.2 `PANEL_STRICT=1 node scripts/test.mjs --test-name-pattern='门禁' test/client.test.mjs`

```
✔ 门禁作用域：接官方 SegmentedControl，缺导出回退也有方向键/Home/End/跳过 disabled（Q2-F4） (16.8461ms)
✔ 浏览器证据入库：门禁/模型场景留在正式 Chromium 套件里，且不依赖 /tmp 探针 (231.8182ms)
ℹ tests 48
ℹ suites 0
ℹ pass 48
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 6179.3805
R2_EXIT=0
```

> 新加的自检用例名不含「门禁」，所以门禁组仍是 **48**（Q2R 报告的口径不变）。

### 4.3 正式 Chromium 套件

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

`grep -c '^PASS'` = **64**、`'^FAIL'` = **0**、`'^SKIP'` = **14**（全截图通道）、
`grep -c '^PASS U1-V\|^PASS U5-V'` = **17**。

### 4.4 根 `npm test`

```
ℹ tests 968
ℹ suites 0
ℹ pass 968
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 34562.7311
NPM_EXIT=0
```

### 4.5 计数对账

| 口径 | 修前（Q2R） | 修后 | 增量 |
|---|---|---|---|
| `test/client.test.mjs` | 170 | **171** | **+1**（`护栏自检：stripComments …（Q2R R2）`） |
| `PANEL_STRICT` 门禁组 | 48 | **48** | 0（新用例名不含「门禁」） |
| 正式 Chromium | 64 | **64** | 0（套件未改） |
| 根 `npm test` | 967 | **968** | **+1** |

### 4.6 文件 sha256

```
c6fe935d7b742fa5a21336df245159a966f9dbe13ae36baeffb97c3d27e9e17f  client.js                        ← 未改
af84b443f14b9e2e83acea77cfc91b939b6223cd8cc61d5dace0a8a34f65c28a  scripts/verify-panel-chromium.mjs ← 未改
8eb618d6b8fb41581f5c0ceb31283240389a8d3cd5530ef7d4733d6b665b1e3b  test/client.test.mjs              ← 本次唯一改动
```

---

## 五、Q2-2 的三道闸现在的强度

| 闸 | 挡什么 | 判据位置 | 变异实测 |
|---|---|---|---|
| **A 声明** | 17 条被改数 / 重复 / 可读名与 id 脱节 | `:5250-5259` | — |
| **B 注册** | 场景被整段删掉、漏登记、重复注册 | `:5261-5272`（spawn dry-run 对集合） | 删 U1-V0 → red |
| **C 判据** | 掏空成字面量 `true`、包进 `if (false)`、**包进块注释** | `:5274-5284`（跑在 `stripComments` 上） | ① ② ③ 全 red；R2 块注释 red |
| **D 第三道闸自身** | `assertAllGateScenariosRan()` 被静默移除 | `:5286-5292`（**本次新增**） | R1 删调用 → red |

**挡不住的（如实说明）**：把判据改成语义等价但更弱的东西（例如 `=== 'x'` → `!== ''`）——
这类语义降级文本/结构断言覆盖不了，只能靠 code review 或变异测试。Q2R R3 已认定这是
t3 报告 §三.2 主动写明的边界，本次**不声称**能挡住。

---

## 六、未验项 / 边界

- **不是真机 WebView**：本次只改单测文件与文档，没有跑真实 DSH 宿主里的门禁面板；
  Chromium 段仍是「安装版前端 `0.2.2-rc.1` + loopback fixture + 仓库真实 `client.js` +
  React 18.3.1 + Chromium 156.0.8078.74」，**不是真实服务端、不是真实模型**。
- **`stripComments` 只是「够用」的扫描器**，不是完整 JS 词法分析：
  - 正则起止用「看前一个有效字符」启发式；`if (x) /re/.test(y)` 这种「`)` 后面跟正则」的写法
    会被当成除号（**偏保守**：不剥 → 可能的假红，不是假绿）。
  - 不处理 `#!` shebang、Unicode 转义标识符、`<!--` 历史注释。
  - 这些写法套件里都没有；`test/client.test.mjs:5202` 的自检用例把已覆盖的形态钉住了。
- **Q2R R4（t3 修复单里的 2 个数字是 tripwire 加入前的快照）**：本次**未回改** t3 的报告
  （历史快照不改）。以本文 §4.5 与 Q2R §六 R4 的实测值为准。
- **Q2R R5（只拷套件会炸）**：本次未处理（不在写作用域）。复现时请把
  `scripts/gate-model-scenarios.mjs` 一起拷。
- 未验物理读屏 / 触摸 / IME / 真实 GitHub·Gitee 响应 / 真实 watcher 状态变化。

---

## 七、工作树

```
$ git status --porcelain
 M HANDOFF.md                                          ← 本次开始前既有
 M scripts/verify-panel-chromium.mjs                   ← t3 产物（本次未再改）
 M test/client.test.mjs                                ← 本次
?? docs/报告-gate-v6核心审查.md                        ← Q1
?? docs/报告-gate-v6面板审查.md                        ← Q2
?? docs/报告-gate-v6面板修复.md                        ← t3
?? docs/报告-gate-v6面板复审.md                        ← t4（Q2R）
?? docs/报告-gate-v6收尾修复.md                        ← 本次（本文件）
?? scripts/gate-model-scenarios.mjs                    ← t3 新建
```
