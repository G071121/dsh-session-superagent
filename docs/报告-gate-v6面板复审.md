# gate v6 面板修复 —— 独立复审（Q2-R）

> 复审人：`q2-r`（**不是**修复人；修复人 `q2-panel`）。日期：2026-11-09。
> 工作树：`D:/主工作区/projects/dsh-gate-v6-integration`，分支 `task/gate-v6-integration` @ `b580681`。
> 被审对象：`docs/报告-gate-v6面板修复.md`（406 行，t3 产出）+ 它改的 3 个文件 + 1 个新建文件。
> 上游审查：`docs/报告-gate-v6面板审查.md`（Q2，blocker 0 / high 0 / medium 2 / low 3 / info 2）。
> **本文一切数字都是本机实跑**（§二 贴原始输出与退出码）。只读源码；**所有变异都在 `/tmp`（= `%TEMP%`）副本上做**，
> 工作树一个字节没改；未 `git checkout` / `reset` / `stash` / `add` / `commit`；未重启 / 重载 DSH、未动 magpie；
> 真实 profile 只读。

---

## 一、结论

**verdict：PASS**。
Q2 两条 medium **真关闭**（不是纸面关闭）；Q2-4 关闭；**Q2-3 判为 `resolved: false`**（low，且已证明
在「不改 `client.js`」的硬约束下**不可交付**，转 I1 处置，不阻塞本轮）。

| 发现 | 原严重度 | 我的判定 | 一句话依据（本机实跑） |
|---|---|---|---|
| **Q2-1** U5-V2b 空转 + `modelsSeqRef` 无判据 | medium | **resolved: true** | fixture 时间戳证明同 URL 两次 GET **真的同时在途**（U1-V3 两条 `damson` 请求 `receivedAt` **差 0ms**、其中一条 delay 2000）；拆闸门（M1）→ 浏览器 **62 PASS / 2 FAIL（U1-V3、U5-V2b）exit 1**、单测 **Q2-1 红** |
| **Q2-2** 静态护栏是纯文本 `includes` | medium | **resolved: true** | 三种变异（掏空 / `if(false)` / 整段删除）**静态护栏全部真红 exit 1**；`if(false)` 另有运行期兜底 → 浏览器 **51 PASS / 1 FAIL**（「实跑 16/17，缺 U5-V6b」） |
| **Q2-3** 双闸门只有一道判据 | low | **resolved: false** | M3 → 浏览器 **64/64 绿 exit 0**；插桩探针跑完整套（65 条检查）后 **第二道闸门命中次数 = 0**。交付树里 M3 会让单测红 1 条，但红因是「那个 `if` 字面量不见了」（文本指纹），**不是**「迟到响应被丢弃」的行为判据 |
| **Q2-4** 三处精确请求次数 | low | **resolved: true** | 三处改成语义下界 `>= 1` + `every(repo === …)`，负面断言（不读 bravo / 不读 golf）原样保留；基线 17 条场景全 PASS，无假红 |

**新发现计数（本复审）**：blocker **0** / high **0** / medium **0** / low **2** / info **3**（§六）。

**对 t3 自报数字的复核**：12 项里 10 项完全一致；**2 项不一致**，都是「t3 报告写的是加 tripwire 之前的快照」，
不影响结论方向（见 §二.5 对照表）：
- M1 单测：t3 报 `47 tests / 45 pass / 2 fail`，实测 `48 tests / 46 pass / 2 fail`（多的是 Q2-3 tripwire）。
- M3 单测：t3 报 `47 pass / 0 fail`，实测 `48 tests / 47 pass / 1 fail`——**红的就是那条 tripwire**（§四）。

---

## 二、环境与命令原始输出 / 退出码

### 2.1 环境

```
$ pwd && git rev-parse --abbrev-ref HEAD && git log --oneline -1
/d/主工作区/projects/dsh-gate-v6-integration
task/gate-v6-integration
b580681 docs: gate v6 独立验收报告（V1）

$ node -v && npm -v
v24.22.1 / 11.12.0            （ego-browser 内置 node 同版本）

$ ego-browser --version
ego-browser 0.6.2.8
  chromium 156.0.8078.74
  node v24.22.1
```

**哈希一致性**（`client.js` 必须与基线 `c3753a1` 完全相同）：

```
$ git show c3753a1:client.js | sha256sum
c6fe935d7b742fa5a21336df245159a966f9dbe13ae36baeffb97c3d27e9e17f *-

$ sha256sum client.js scripts/verify-panel-chromium.mjs scripts/gate-model-scenarios.mjs test/client.test.mjs
c6fe935d7b742fa5a21336df245159a966f9dbe13ae36baeffb97c3d27e9e17f *client.js
af84b443f14b9e2e83acea77cfc91b939b6223cd8cc61d5dace0a8a34f65c28a *scripts/verify-panel-chromium.mjs
15e2abb7c07a696c6833f4e742119097f3097a309c8a75ecefb131fa6249904a *scripts/gate-model-scenarios.mjs
dfd7471b0ea469e68fc76ec09320b79a7cce90c8028979293be8e516bea54df6 *test/client.test.mjs
```

`client.js` 与基线一致 ⇒ **产品逻辑一个字节没动**；`verify-panel-chromium.mjs` / `gate-model-scenarios.mjs` /
`client.test.mjs` 的哈希与 t3 报告 §一 的四个 sha256 **逐字相同** ⇒ 我审的就是 t3 交的那份，没有第三方改动。

**工作树状态**（复审开始前 = 复审结束后，一个字节没变）：

```
$ git status --porcelain
 M HANDOFF.md                                   ← t3 开工前既有（内容是从 2026-11-02 重写为 2026-11-09 03:33 快照，非 t3 本次产出）
 M scripts/verify-panel-chromium.mjs            ← t3
 M test/client.test.mjs                         ← t3
?? docs/报告-gate-v6核心审查.md                 ← Q1 产物
?? docs/报告-gate-v6面板审查.md                 ← Q2 产物
?? docs/报告-gate-v6面板修复.md                 ← t3 修复单
?? scripts/gate-model-scenarios.mjs             ← t3 新建
```

### 2.2 必跑四条（独立复跑，不看 t3 的日志）

**① `node scripts/test.mjs test/client.test.mjs` → exit 0**

```
✔ 门禁 load 序号：同一仓库两次读取乱序，先发的后到也不能覆盖（U1-G3） (247.7163ms)
✔ 门禁 models 序号：同一仓库两次读取乱序，先发的后到不能覆盖最新列表（Q2-1） (339.5501ms)
✔ 门禁 models：panelRepoOf 与 modelsPanelRepo 同源（第二道闸门不可达的前提）（Q2-3） (7.0118ms)
✔ 浏览器证据入库：门禁/模型场景留在正式 Chromium 套件里，且不依赖 /tmp 探针 (234.8662ms)
ℹ tests 170
ℹ suites 0
ℹ pass 170
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 6843.3371
[EXIT:0]
```

**② `PANEL_STRICT=1 node scripts/test.mjs --test-name-pattern='门禁' test/client.test.mjs` → exit 0**

```
✔ 门禁 models 序号：同一仓库两次读取乱序，先发的后到不能覆盖最新列表（Q2-1） (298.4683ms)
✔ 门禁 models：panelRepoOf 与 modelsPanelRepo 同源（第二道闸门不可达的前提）（Q2-3） (12.9205ms)
✔ 浏览器证据入库：门禁/模型场景留在正式 Chromium 套件里，且不依赖 /tmp 探针 (370.4399ms)
ℹ tests 48
ℹ suites 0
ℹ pass 48
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 7856.1872
[EXIT:0]
```

**③ 正式 Chromium 套件 → 64 PASS / 0 FAIL / exit 0**

```bash
REPO_W=$(pwd -W); { echo "process.env.DSH_SUPERAGENT_REPO='$REPO_W'"; cat scripts/verify-panel-chromium.mjs; } | ego-browser nodejs
```

```
$ echo "PASS=$(grep -c '^PASS' log) FAIL=$(grep -c '^FAIL' log) SKIP=$(grep -c '^SKIP' log)"
PASS=64  FAIL=0  SKIP=14
$ grep -c '^PASS U1-V\|^PASS U5-V' log
17
$ sed -n '/^SUMMARY/,/^  "checks"/p' log
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
[PIPE_EXIT:0]
```

17 条场景逐条（`grep '^PASS U1-V\|^PASS U5-V'`，原样）：

```
PASS U1-V0 门禁分区真实渲染且第一次读取由真实 effect 发出
PASS U1-V1 乱序（跨仓库）：迟到的旧仓库响应不覆盖新仓库数据
PASS U1-V2 在途 dirty：响应回来时不清掉新草稿
PASS U1-V3 乱序（同仓库）：先发的后到不能覆盖最新一次读取
PASS U1-V4 取消换仓库：保留草稿且不去读新仓库
PASS U1-V5 targetRepo：保存/预览写的是 GET 回显的 data.repo（不是刚切过去的仓库）
PASS U1-V6 保存成功后按当前仓库重读并清掉保留草稿提示
PASS U5-V0 切仓库后模型列表跟随面板仓库读取（alpha）
PASS U5-V1（M1 user）保留草稿：按钮只读草稿来源 alpha，不读新仓库 bravo，下拉不含 bravo 模型
PASS U5-V2（M2）闸门挡住 charlie 时：重读 bravo models（>=1 条）、没有 charlie models 请求
PASS U5-V2b 被作废的在途 bravo 列表（seq 更小）迟到后不能覆盖最新列表
PASS U5-V3a 渲染护栏：面板已切 delta、列表还是 charlie 时提示忽略，下拉只剩当前值
PASS U5-V3b 迟到的 charlie 列表不能覆盖 delta（跨仓库响应丢弃），护栏消失
PASS U5-V4（M4）确认放弃草稿并切换：模型列表跟着切到 echo（>=1 条），不含 delta 模型
PASS U5-V5（U2-F2）取消换仓库：保留草稿、重读 echo 模型（>=1 条），不读 foxtrot
PASS U5-V6a 项目层前提：作用域可切「项目」、模型下拉禁用、草稿能变脏
PASS U5-V6b（M1 project）项目层保留草稿：确认条在、按钮读草稿来源 foxtrot，不读 golf
```

> 14 条 SKIP **全是截图通道**（`Ego/CDP 截图通道已证实在 API 内部终止进程`），不是功能跳过——和 t3 报告一致。

**④ `node scripts/verify-panel-chromium.mjs --list-scenarios`（dry-run）→ exit 0**

```
$ DSH_SUPERAGENT_REPO="$(pwd -W)" node scripts/verify-panel-chromium.mjs --list-scenarios
{
  "declared": ["U1-V0","U1-V1","U1-V2","U1-V3","U1-V4","U1-V5","U1-V6",
               "U5-V0","U5-V1","U5-V2","U5-V2b","U5-V3a","U5-V3b","U5-V4","U5-V5","U5-V6a","U5-V6b"],
  "registered": ["U1-V0","U1-V1","U1-V2","U1-V3","U1-V4","U1-V5","U1-V6",
                 "U5-V0","U5-V1","U5-V2","U5-V2b","U5-V3a","U5-V3b","U5-V4","U5-V5","U5-V6a","U5-V6b"],
  "total": 17
}
[DRYRUN_EXIT:0]
$ grep -c "gateScenarioCheck('U" scripts/verify-panel-chromium.mjs
17
（上面 JSON 为可读起见折了行；实际输出每行一个 id）
```

### 2.3 t3 自己没跑、我补跑的两项

```
$ node scripts/ui-audit.mjs
...
PASS 自造 token                   0          目标 0
UI 体检：11/11 通过（100 分）
[UI_AUDIT_EXIT:0]

$ node scripts/render-panel-copy.mjs --check
PASS 面板文案与当前实现一致（178 行；最长 77 字符；超过 80 字符的 0 条（上限 3））
[RENDER_COPY_EXIT:0]

$ npm test
ℹ tests 967
ℹ pass 967
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 52357.8634
[NPM_EXIT:0]
```

### 2.4 我做的变异副本（全部在 `%TEMP%`，工作树不动）

```
/tmp/q2r-m1           client.js  sha256 d4501e549a9ce38aafb9f8d4678948f6ecbb5373906acc3f3a13ee353514b83c
/tmp/q2r-m3           client.js  sha256 949f5c9c8b41ed9522c99e0c4b26039f3efb41f90f11c3610a8b6a3cad17d62e
/tmp/q2r-m3probe      client.js  sha256 eb0315f2921ce60e37b91ef485d01ac5899b5d7a8abb0af4772ac0bd1e6babc4（插桩）
/tmp/q2r-gut          套件 sha256 17a2a4ed2652cd9c61a15f974ca2d11a98fa4aec85861b7b0443425d4a52d04c
/tmp/q2r-ifelse       套件 sha256 caff8e83e215f2dba5351555e859c17f55ac023da24db4158512ff6dcda77a3d
/tmp/q2r-del          套件 sha256 50668d64d04df399f3745ad995df0ba398914a8b2c406991d31d3bba008d4be0
/tmp/q2r-gutweak / q2r-noassert / q2r-blockcomment / q2r-minimal（护栏绕过探针，§五.3）
```

`q2r-m1` / `q2r-m3` 的 `client.js` sha256 与 t3 报告里写的 `d4501e54…` / `949f5c9c…` **完全相同**
⇒ 我复现的是他描述的同一份变异，不是「另一种变异」。

### 2.5 t3 自报 vs 我实测

| 项 | t3 自报 | 我实测 | 判定 |
|---|---|---|---|
| `node scripts/test.mjs test/client.test.mjs` | 170/170, 0 | **170/170**, 0 | ✅ |
| `PANEL_STRICT … --test-name-pattern='门禁'` | 48/48, 0 | **48/48**, 0 | ✅ |
| 正式 Chromium | 64 PASS / 0 FAIL, 0 | **64 / 0**, 0 | ✅ |
| M1 → 浏览器 | 62 / 2, 1 | **62 / 2**（U1-V3、U5-V2b）, 1 | ✅ |
| M1 → 单测 | 45 pass / 2 fail（47 条） | **46 pass / 2 fail（48 条）** | ⚠️ 差 1 条 = Q2-3 tripwire（t3 是加 tripwire 之前测的） |
| M3 → 单测 | 47 pass / 0 fail | **47 pass / 1 fail（48 条）** | ⚠️ 见 §四.2：红的是 tripwire 的**文本指纹**，不是行为判据 |
| M3 → 浏览器 | 64 / 0, 0 | **64 / 0**, 0 | ✅ |
| Q2-2 三变异 | 全红 | **全红**（§五.1） | ✅ |
| `ui-audit` | 11/11, 0 | **11/11**, 0 | ✅ |
| `render-panel-copy --check` | PASS 178 行, 0 | **PASS 178 行**, 0 | ✅ |
| 根 `npm test` | 967/967, 0 | **967/967**, 0 | ✅ |
| `client.js` sha256 | `c6fe935d…` | **`c6fe935d…`**（= 基线 `c3753a1`） | ✅ |

---

## 三、Q2-1 / Q2-2 / Q2-3 / Q2-4 逐条关闭判定

### 3.1 Q2-1（medium）→ **resolved: true**

**原症状**：U5-V2b 声称验「被作废的在途 bravo 列表迟到」，但同 URL 的两次 `/gates/models` 被 Chromium
**请求折叠**，从没同时在途；且 `modelsSeqRef` 全仓库无判据（拆掉 → 64/64 全绿）。

**证据 A（根因真的被打掉）**：基线一次正式跑里，fixture 侧记录的**到达时间戳**证明两次同 URL 请求同时在途——

```
# U1-V3（/gates，同仓库 damson）
damson seq=1 delay=0    fail=True  receivedAt=1794168920094
damson seq=2 delay=2000 fail=False receivedAt=1794168920311
damson seq=3 delay=0    fail=False receivedAt=1794168920311
→ seq2 与 seq3 相差 0ms，而 seq2 还要 2000ms 才回 ⇒ 两条真的同时在途

# U5-V2b（/gates/models，同仓库 bravo）
r1      seq=2 delay=3000 receivedAt=1794168927256
restored seq=3 delay=0    receivedAt=1794168929483
→ 相差 2227ms < 3000ms 的延迟 ⇒ seq3 发出时 seq2 还没回 ⇒ 同时在途
```

对照 Q2 审查当时的数据（`seq2 403078 (delay 3000)` / `seq3 606081 (delay 0)` → **差 3003ms**，即「等第一条回完才发第二条」），
可判定：**请求折叠已经被 `cache:'no-store'` 打掉，两条场景不再空转**。

**证据 B（两道闸门都有行为判据）**：M1（4 处代际序号闸门 → `false`）实跑：

```
$ (q2r-m1) … | ego-browser nodejs
PASS=62  FAIL=2
FAIL U1-V3 乱序（同仓库）：先发的后到不能覆盖最新一次读取
     {"value":"仓库 D:/fixture/work/damson 的提示词 #2", "last":{…"seq":3,"delay":0…}}
     ← 面板显示的是**旧响应 #2**，正是 loadSeqRef 挡掉的那个
FAIL U5-V2b 被作废的在途 bravo 列表（seq 更小）迟到后不能覆盖最新列表
     {"lateValues":["group/deepseek-v4.1-flash-1017","group/model-bravo-2","group/shared-bravo"],
      "r1":{…"seq":2,"delay":3000…},"restored":{…"seq":3,"delay":0…}}
     ← 下拉里出现了作废列表的 model-bravo-2
exitCode: 1   [PIPE_EXIT:1]
```

**证据 C（`modelsSeqRef` 有了独立判据）**：M1 下的单测（`PANEL_STRICT=1 --test-name-pattern='门禁'`）：

```
✖ 门禁 load 序号：同一仓库两次读取乱序，先发的后到也不能覆盖（U1-G3）
  AssertionError: 旧请求后到不能覆盖新结果
✖ 门禁 models 序号：同一仓库两次读取乱序，先发的后到不能覆盖最新列表（Q2-1）
  AssertionError: 同一仓库的旧 models 响应后到时不能覆盖最新列表（拆掉 modelsSeqRef 闸门这条必红）
ℹ tests 48 / pass 46 / fail 2      [EXIT:1]
```

**证据 D（新用例测的确实是序号闸门，不是仓库闸门）**：同一份新用例在 **M3**（仓库闸门拆掉）下**绿**
（§四.2 的 `✔ 门禁 models 序号…（Q2-1）`）——说明它走的是 `modelsSeqRef`，不是「跨仓库」那道。

**证据 E（只改 harness，不碰产品）**：`git diff scripts/verify-panel-chromium.mjs` 里唯一的行为改动是
`nativeFetch(input, init)` → `nativeFetch(input, { ...(init || {}), cache: 'no-store' })`；`client.js` sha256 = 基线。

**判定**：Q2-1 关闭。附带说明：修复**只解决 harness 侧**，`cache:'no-store'` 在真实 DSH WebView（Electron）里是否
同样打掉折叠**未验**（§七），但静态护栏里新增了一条「harness 必须带 `cache:no-store`」的断言防回退。

### 3.2 Q2-2（medium）→ **resolved: true**

**原症状**：护栏只做 `source.includes(场景名)`；① 掏空成 `check(name, true)`、② 包进 `if (false)`、
③ 9/17 条整段删掉，三种改法全绿。

**证据 A（唯一真源 + 集合对账）**：`--list-scenarios` 输出 `declared` 与 `registered` 完全相等、`total: 17`（§二.2 ④），
`grep -c "gateScenarioCheck('U"` = **17**。

**证据 B（三种变异全部真红）**——见 §五.1 原始输出：
① 掏空 → `场景 U1-V1 的判据是字面量 true（掏空断言）`、exit 1；
② `if (false)` → `正式套件里不许出现 if (false)：那会把场景变成永不执行的死代码`、exit 1；
③ 整段删除 U1-V0 → `dry-run 报的注册条数必须是 17`、exit 1。

**证据 C（`if (false)` 还有第二层兜底，我实跑过）**：把 U5-V6b 包进 `if (false)` 后**真跑浏览器**：

```
PASS=51  FAIL=1      total 52   exitCode 1
[error] VERIFY_ERROR Error: 门禁/模型场景没有全部执行：实跑 16/17，缺 U5-V6b
FAIL 脚本执行完成 "Error: 门禁/模型场景没有全部执行：实跑 16/17，缺 U5-V6b …assertAllGateScenariosRan…"
```

**判定**：Q2-2 关闭（三种原始改法都被挡住，且 `if(false)` 有双层）。**但**「挡住」有边界，我实测出三种
**挡不住**的改法（§五.3），其中两条列为本轮 low 发现 R1 / R2——**不因此推翻关闭判定**，因为 t3 报告 §三.2 已明说
「语义降级只能靠 code review」，剩下的属于同一类边界的延伸。

### 3.3 Q2-3（low）→ **resolved: false**

**原症状**：`loadModels()` 有两道闸门（`client.js:2520` 序号 / `client.js:2523` 面板仓库），M3 拆第二道仍 64/64 绿。

**证据 A（M3 在浏览器层仍然全绿）**：

```
$ (q2r-m3)  client.js sha256 = 949f5c9c8b41ed9522c99e0c4b26039f3efb41f90f11c3610a8b6a3cad17d62e
PASS=64  FAIL=0  SKIP=14
SUMMARY { "passed": 64, "failed": 0, "clientSha256": "949f5c9c…", "exitCode": 0 }   [PIPE_EXIT:0]
```

**证据 B（我加了一个「命中计数」探针，证明这道闸门整套流程一次都没走到）**：
在副本里把两处闸门改成 `if (requestedRepo !== panelRepoOf()) { globalThis.__q2rGate2Hits += 1; return }`
（**不改控制流**），并在 17 条场景跑完后加一条检查读回计数：

```
PASS=65  FAIL=0      total 65   exitCode 0
PASS Q2R-PROBE 第二道闸门命中次数 {"q2rGate2Hits":0}
```

即：**整套 64 条检查（17 条门禁/模型场景 + 全部面板流程）里，第二道闸门命中 0 次**。这与 t3 的推导一致：

```
panelRepoOf()        = panelRepoRef.current || gateDataRepo(dataRef.current) || repoRef.current
modelsPanelRepo      = panelRepo || repo
panelRepoRef.current = panelRepo                       （client.js:2557，每次渲染同步写入）
panelRepo            = dirty && draftRepo ? draftRepo : dataRepo      （client.js:2555）
⇒ panelRepo 真值 ⇒ 两者都 = panelRepo；panelRepo 假值 ⇒ dataRepo 为空 ⇒ 两者都 = repo prop
⇒ panelRepoOf() === modelsPanelRepo 恒成立 ⇒ panelRepoOf() 一变，[modelsPanelRepo] effect
   （client.js:2592，无 guard）就调 loadModels() 把 modelsSeqRef 推高一格 ⇒ 序号闸门总是先 return
```

`load()` 闸门分支的 `loadModels(pendingSource)`、`cancelRepoSwitch` 的 `loadModels(panelRepoNow)`
（`client.js:2699-2706`）算出来的也恰好等于当时的 `panelRepoOf()`（同一批 ref），同样不让第二道可达。

**证据 C（M3 下唯一变红的是「文本指纹」，不是行为）**：

```
✖ 门禁 models：panelRepoOf 与 modelsPanelRepo 同源（第二道闸门不可达的前提）（Q2-3）
  AssertionError: 第二道闸门不见了：如果是有意删除，请同步删掉本用例并在 CHANGELOG 里记一句
ℹ tests 48 / pass 47 / fail 1   [EXIT:1]
```

这条红是 `assert.ok(source.includes('if (requestedRepo !== panelRepoOf()) return'))` 命中失败——
它证明「那行字没了」，**不证明**「迟到响应会被丢弃」。按本任务「不许用『包含某段文字』式断言当证据」的尺度，
**这一条不能算第二道闸门的行为判据**。

**判定**：`resolved: false`。原发现「双闸门只有一道判据」**依然成立**：修完之后仍是「序号闸门有行为判据、
仓库闸门 0 判据（且不可达）」。t3 的处理（不伪造用例、钉不变式 tripwire、写明不可达证明）是**正确且诚实**的，
但把它记成「已修」在语义上不成立——他自己在修复单 §五 也写的是「已定性：第二道不可达」。
**给 I1 的处置**（不在我的写作用域）：`client.js:2523` / `:2530` 删掉（推荐），或补注释标注不可达。

### 3.4 Q2-4（low）→ **resolved: true**

`git diff` 逐处核对 + 基线实跑无假红：

| 场景 | 改前 | 改后（原文） | 负面断言 |
|---|---|---|---|
| U1-V0 | `gateGets('…/apple').length === 1` | `gateGets('…/apple').length >= 1 && gateGets().every((row) => row.repo === 'D:/fixture/work/apple')` | — |
| U5-V1 | `m1Fresh.length === 1 && m1Fresh[0].repo === '…/alpha'` | `m1Fresh.length >= 1 && m1Fresh.every((row) => row.repo === '…/alpha')` | `modelGets('…/bravo').length === 0`、`!m1Values.some(…model-bravo-)` **原样保留** |
| U5-V6b | `freshProject.length === 1 && freshProject[0].repo === '…/foxtrot'` | `freshProject.length >= 1 && freshProject.every((row) => row.repo === '…/foxtrot')` | `m6.golf.length === 0` **原样保留** |

`every()` 在空数组上恒真，所以三处都配了 `length >= 1`——**下界没被放宽成 0**，这点很重要，我逐条确认过。
基线 64/0 且 17 条全 PASS ⇒ 放宽后没有松到假绿（真实断言仍由 `every(repo 全等)` + 负面断言承担）。

---

## 四、M1 / M3 变异复验

### 4.1 M1（4 处代际序号闸门 → `false`）

`sed` 等价替换：`seq !== loadSeqRef.current`（4 处）→ `false`、`seq !== modelsSeqRef.current`（2 处）→ `false`；
`client.js` sha256 `d4501e54…`（**与 t3 报告一致**）。

| 层 | 原始输出 | 退出码 |
|---|---|---|
| 浏览器 | `PASS=62 FAIL=2`；`FAIL U1-V3`（value=提示词 #2）、`FAIL U5-V2b`（lateValues 含 `model-bravo-2`）；`"exitCode": 1` | **1** ✅ |
| 单测 | `ℹ tests 48 / pass 46 / fail 2`；红 = U1-G3、Q2-1 | **1** ✅ |

结论：U1-V3 与 U5-V2b **不再是空转**，`modelsSeqRef` 有了独立判据。

### 4.2 M3（`requestedRepo !== panelRepoOf()` → `false`，2 处）

`client.js` sha256 `949f5c9c…`（**与 t3 报告一致**）。

| 层 | 原始输出 | 退出码 |
|---|---|---|
| 浏览器 | `PASS=64 FAIL=0`，`"exitCode": 0` | 0（**行为层全绿**） |
| 单测 | `ℹ tests 48 / pass 47 / fail 1`，红 = Q2-3 tripwire（`第二道闸门不见了`） | **1** |

**这与本任务书「M3 变异必须让新增单测变红」的字面要求：满足；但必须说清红因。**
红的是**文本指纹**（那行 `if (...) return` 不在了），不是「迟到了的旧响应被丢弃」。
更关键的是：**M3 在浏览器层仍是 64/64 全绿 + 探针命中 0 次** ⇒ 这道闸门在当前实现里**不可达**，
所以「让新增单测变红」这件事本身**证明不了**它守住了任何行为。t3 报告 §七 写的 `M3 → 47 pass / 0 fail`
是**加 tripwire 之前**的旧数字（交付树上实测 47/1），文书与实测有 1 条差异，方向不影响结论。

### 4.3 M3 的替代证据（探针）

见 §3.3 证据 B：插桩副本跑完整套 → `PASS=65 FAIL=0`、`q2rGate2Hits: 0`。

---

## 五、Q2-2 三种变异复验

### 5.1 任务书要求的三种（全部真红）

```
$ (q2r-gut)  node scripts/test.mjs --test-name-pattern='浏览器证据入库' test/client.test.mjs
✖ 浏览器证据入库：门禁/模型场景留在正式 Chromium 套件里，且不依赖 /tmp 探针
ℹ tests 1 / pass 0 / fail 1
  AssertionError: 场景 U1-V1 的判据是字面量 true（掏空断言）
[EXIT:1]

$ (q2r-ifelse) 同上
✖ 浏览器证据入库…
  AssertionError: 正式套件里不许出现 if (false)：那会把场景变成永不执行的死代码
[EXIT:1]

$ (q2r-ifelse) 浏览器整跑
PASS=51 FAIL=1  total 52  exitCode 1
[error] VERIFY_ERROR Error: 门禁/模型场景没有全部执行：实跑 16/17，缺 U5-V6b
FAIL 脚本执行完成 "Error: 门禁/模型场景没有全部执行：实跑 16/17，缺 U5-V6b …"

$ (q2r-del)  node scripts/test.mjs --test-name-pattern='浏览器证据入库' test/client.test.mjs
✖ 浏览器证据入库…
  AssertionError: dry-run 报的注册条数必须是 17
[EXIT:1]
```

| 变异 | 静态护栏 | 运行期兜底 | 判定 |
|---|---|---|---|
| ① 掏空 U1-V1 成 `gateScenarioCheck('U1-V1', true, …)` | **红**（`场景 U1-V1 的判据是字面量 true`） | —（断言掏空后场景仍 PASS，运行期抓不到） | 挡住 ✅ |
| ② `if (false) { …U5-V6b… }` | **红**（`不许出现 if (false)`） | **红**（`实跑 16/17，缺 U5-V6b`） | 双层挡住 ✅ |
| ③ 整段删 U1-V0（含注释与 `gateScenarioCheck` 调用） | **红**（`dry-run 报的注册条数必须是 17`） | —（删了就跑不到，但它触发的也是这条） | 挡住 ✅ |

### 5.2 t3 没测、我补测的：删除**运行期兜底本身**

`assertAllGateScenariosRan()`（`scripts/verify-panel-chromium.mjs:1607`）是第三道闸，但**没有任何测试盯着它还在不在**。
删除该调用行后：

```
$ (q2r-noassert)  node scripts/test.mjs --test-name-pattern='浏览器证据入库' test/client.test.mjs
✔ 浏览器证据入库：门禁/模型场景留在正式 Chromium 套件里，且不依赖 /tmp 探针
ℹ tests 1 / pass 1 / fail 0
[EXIT:0]        ← 仍然全绿
```

→ 记为 **R1（low）**。

### 5.3 挡不住的三种（**如实记录，不许声称挡得住**）

| # | 改法 | 实测 | 归类 |
|---|---|---|---|
| ① 语义降级（保持注册点、不写字面量 `true`） | `gateScenarioCheck('U1-V1', 1 === 1, …)` → 护栏 `pass 1 / fail 0`、`[EXIT:0]` | **绿** | t3 已在报告 §三.2 声明「语义降级挡不住」，我复核**属实**；列为 **R3（info）** |
| ② 块注释注释掉整段注册 | `/* gateScenarioCheck('U1-V1', … ) */` → 护栏 `pass 1 / fail 0`、`[EXIT:0]`；`--list-scenarios` 仍报 17 | **绿**（`npm test` 层） | 违反「死代码」的实质，但只在**跑 Chromium** 时才由运行期断言抓到；列为 **R2（low）** |
| ③ 删除运行期兜底调用 | 见 §5.2 → **绿** | **绿** | 见 **R1（low）**；③ 与 ② 叠加 = 场景静默消失且两层都不红 |

---

## 六、新发现

### R1（low）运行期完整性断言「自己还在不在」没有判据

- **位置**：`scripts/verify-panel-chromium.mjs:1607`（调用点）、`test/client.test.mjs:5095-5146`（护栏测试，全文没有引用该函数）。
- **问题**：Q2-2 的第三道闸是 `assertAllGateScenariosRan()`，但护栏只查「声明 17 条 / 注册 17 条 / 非字面量 true / 无 `if (false)`」。
  删掉这一行调用，`npm test` **仍全绿**（实测 `pass 1 / fail 0`，`[EXIT:0]`），第三道闸被静默移除。
- **最小复现**：副本里 `sed -i '/^  assertAllGateScenariosRan()$/d' scripts/verify-panel-chromium.mjs` →
  `node scripts/test.mjs --test-name-pattern='浏览器证据入库' test/client.test.mjs` → PASS。
- **建议修法**：护栏 C 段加一条结构性断言 `assert.equal(/^\s*assertAllGateScenariosRan\(\)/m.test(code), true, '套件必须调用运行期完整性断言')`；
  同理建议钉住 `function assertAllGateScenariosRan` 的定义存在。

### R2（low）护栏的「去注释」只按行首 `//`，块注释可绕过

- **位置**：`test/client.test.mjs:5125`（`source.split('\n').filter((line) => !line.trim().startsWith('//'))`）。
- **问题**：把一条场景的注册点整段包进 `/* … */`，三道静态闸全绿（注册点文本还在、`--list-scenarios` 仍数到 17）。
  与 Q2-6 同源但**方向相反**：Q2-6 是「偏严（假红）」，这里是「偏松（假绿）」。
- **最小复现**：副本里把 `gateScenarioCheck('U1-V1', …)` 三行包成 `/* … */` → 护栏 PASS、`[EXIT:0]`。
- **现状缓解**：套件真跑时 `assertAllGateScenariosRan()` 会红（实测 §5.1 ② 的同类现象）——**前提是 R1 没被触发**。
- **建议修法**：先剥块注释（或在剥注释后统计 `gateScenarioCheck(` 出现次数与 17 对账），别只按行首前缀筛。

### R3（info）语义降级挡不住（t3 已声明，我复核属实）

`gateScenarioCheck('U1-V1', 1 === 1, …)` → 护栏绿。**不是新洞**，是 t3 报告 §三.2 主动写明的边界；
列在这里只为把「实测」补齐。要真正守住，只能把「判据是否有效」交给 code review 或变异测试（M1/M3 那种）。

### R4（info）t3 修复单里有 2 个数字是「加 tripwire 之前」的快照

- `docs/报告-gate-v6面板修复.md` §七 表：`M1 → 单测 47 tests / 45 pass / 2 fail`、`M3 → 单测 47 pass / 0 fail`。
- 交付树上实测：M1 → `48 / 46 / 2`；M3 → `48 / 47 / 1`（红的是 Q2-3 tripwire）。
- 影响：**只影响文书准确性**，不影响结论方向（M3 的「行为层没判据」结论反而被我加强：浏览器 64/64 + 探针 0 命中）。
- 建议：I1 合并前在这两行补一句「tripwire 加入前快照」，或改成实测值。

### R5（info）套件不再自足：漏拷 `scripts/gate-model-scenarios.mjs` 会让历史复现命令直接炸

- **位置**：`scripts/verify-panel-chromium.mjs:110-111`（按仓库根绝对 file URL 动态 import）。
- **实测**：只复制 `client.js` + `package.json` + `scripts/verify-panel-chromium.mjs` 到临时目录（= Q2 报告 §六 Q2-1
  最小复现的复制清单）→

  ```
  Error [ERR_MODULE_NOT_FOUND]: Cannot find module '…\scripts\gate-model-scenarios.mjs'
  imported from …\scripts\verify-panel-chromium.mjs
  [EXIT:1]
  ```

- 影响：产品与门禁无影响（正式跑都在仓库根）；**只影响**文档里的变异复现步骤、以及未来任何「只拷套件」的 smoke 流程。
- 建议：在报告 / CHECKLIST 的复现命令里补上这个新文件；或让套件在缺该文件时给一句人话错误。

---

## 七、未验项（不宣称通过）

- **不是真机 WebView**：没有重启 / 重载 DSH，没有在真实宿主会话里点门禁面板。`/gates`、`/gates/models`、
  `POST /gates/preview`、`POST /gates` 全部打套件自带的 **loopback fixture——不是真实服务端、不是真实模型**。
  本次**不**宣称真机通过。
- **`cache:'no-store'` 只在 ego-browser 的 Chromium 156.0.8078.74 上验过**：真实 DSH WebView（Electron）的连接池参数、
  是否 HTTP/2、该选项是否同样打掉折叠，均**未验**。若宿主行为不同，U1-V3 / U5-V2b 可能又变回空转
  （静态护栏里那条 `cache:no-store` 断言只能防「harness 被改回去」，防不了「宿主不吃这一套」）。
- **探针的覆盖边界**：`q2rGate2Hits = 0` 只说明「本套件跑到的路径里一次没命中」，**不是**数学意义上的不可达证明；
  不可达的证明是 §3.3 的派生关系推导（`panelRepoOf() === modelsPanelRepo`）。两者结合我才敢写「不可达」。
- **物理读屏 / 触摸 / IME / 真实 GitHub·Gitee 响应 / 真实 watcher 状态变化**：未验。
- **`packages/dsh-gate` 侧**：不在 Q2 范围（Q1 覆盖）。
- **真实 profile 的 `--repair`**：未执行（只读）。

---

## 八、复审结论一句话

**两条 medium（Q2-1、Q2-2）是实打实修好的**——浏览器层现在真的能构造「同 URL 两次请求同时在途」（fixture 时间戳为证），
拆闸门就红（62/2，且红点正是 U1-V3、U5-V2b）；静态护栏对「掏空 / `if(false)` / 整段删除」三种改法真红，`if(false)` 还有运行期第二层。
**Q2-3 不是修好，是定性成「不可达」**：M3 浏览器 64/64 绿、探针命中 0 次，第二道闸门没有任何行为判据——
这条按实际记 `resolved: false`（low），交 I1 删死代码或加注释。
**新增两条 low**（运行期兜底自身无护栏 R1、块注释可绕过护栏 R2），不影响 I1 放行，但建议顺手补。

> 本报告只写 `docs/报告-gate-v6面板复审.md` 这一个文件；`client.js` 与全部源码/测试**一个字节没动**；
> 所有变异副本在 `/tmp`（`%TEMP%`）下，可随时删除。
