# 门禁 v3 核心与发布审查（Q1）

> 审查人：reviewer（严格审查专员）· 团队 `dsh-gate-v3` · 2026-11-08
> 审查对象：`D:\主工作区\projects\.tmp-issue9-push-20261106-1244`，分支 `feat/gate-v3`，HEAD `e5cf489`
> 结论：**PASS** —— 0 blocker / 0 high。核心写盘、`false/none` 兼容、preflight 第四段、TARGETS 防漏均达到任务书冻结行为；
> 5 条 low 残余与 4 项 I1 发布收口见 §八/§七。源码只读，本轮唯一写入是本报告。

---

## 〇、结论速览

| 审查项 | 结论 | 关键证据 |
|---|---|---|
| `extends` 单写者写盘是否仍会静默丢失 | ✅ 不会 | 独立探针 23/23 PASS；共享/非法形式全部抛错、盘上字节不变、无 `.bak`/`.tmp` |
| `false` / `'none'` 兼容 | ✅ 通过 | 原样写回、读回仍是 replace；入参没写时保留盘上值；旧客户端不发 `extends` 也不丢 |
| 写盘原子性 | ✅ 通过（有 low 残余） | 59,491 次并发读从未读到半截 JSON；失败路径原文件不坏；TOCTOU 属并发写者残余（见 §八 R1） |
| preflight 第四段是否假绿/假红 | ✅ 通过 | 真机/干净/仅漂移三场景实测：漂移显示第四段并 FAIL；干净不增噪音；撤垫片后不再假报「陈旧 1」 |
| TARGETS 是否漏文件 / 扩大打包 | ✅ 通过（有 low 残余） | 派生 19 个运行时文件对 21 条清单，缺 0；三类注入（新 lib/新 asset/加开发件）都红并点名；`package.json` 未改、`npm pack` 30 文件 |
| 发布可用性 | ⚠️ 待 I1 | README 873→890、真实 profile `--repair`、gate 版本 bump、main CI/Release（见 §七） |

---

## 一、审查对象与独立性

- 工作树改动（`git status`）：`client.js`、`packages/dsh-gate/{README.md,lib/index.js}`、`scripts/{preflight.mjs,sync-profile.mjs}`、`test/{client.test.mjs,sync-profile-drift.test.mjs}`、新文件 `packages/dsh-gate/test/extends-write.test.mjs`、`docs/报告-gate-v3验收.md`。
- 本轮 Q1 只读源码与已有产物，**未修改任何实现/测试**；所有探针放在仓库外的临时目录（`D:\主工作区\projects\.tmp-q1-review-20261108`）。
- 不依赖实现方测试的结论：`extends` 用独立探针复算；preflight 用真实 profile + 两份假 home（干净 / 仅漂移）实跑；TARGETS 用独立派生脚本 + 临时副本注入验证。
- 未重启 DSH；真实安装 profile 保持原状（审查前后 `--check` 都是 `缺失 1 / 断链 3 / 陈旧 0 / 门禁子包漂移 1`，exit 1）。
- 面板 UI 语义（dirty 确认、`semantic:false` 渲染等）属 Q2 范围；本报告只审 `extends` 核心写盘链与面板→服务端保存链的**服务端**行为。

---

## 二、`extends` 写盘防丢失（C1）

### 2.1 实现要点（源码核对）

- `classifyExtends`（`packages/dsh-gate/lib/index.js:118`）：`false`/`'none'` = 可安全保留；`true`/任意字符串（含 `'default'`）/对象 = 共享；`undefined` = 未写；其余（`null`、数组、数字……）= 非法。
- `writeGateConfig`（`:538`）顺序：① 入参 `extends` 共享/非法 → 抛 `extends_not_preservable`（含绝对路径 + 解决方式，`:139`）；② 读盘上现有 `extends`，共享/非法 → 同样抛错（即使入参写 `false`）；③ 可保留值「入参优先，入参没写就用盘上的」；④ 校验 → `.bak` → 临时文件 `0o600` → `rename`。
- `validateConfig`（`:425`）只做形状校验并把 `extends` 原样带回 `config`（`:513`），保证 `POST /gates` 的 `validateConfig → writeGateConfig` 链上服务端看得见调用方传过的 `extends`。
- 生产写路径只有一条：`lib/index.js:2494-2497`（`POST /gates`）→ `validateConfig` → `writeGateConfig`，错误以 `{ok:false, code:'save_failed', error}` 回给面板；客户端 `call()` 对非 2xx 抛错、`save()` 显示「保存失败：…」，不是静默失败。`bin/gate.mjs` 只读不写。

### 2.2 独立探针（23/23 PASS，exit 0）

探针直接 import 包内公开 API，在临时 repo/home 中运行，不读实现方用例。覆盖：

| 组 | 场景 | 结果 |
|---|---|---|
| A | 入参 `extends` = 路径 / `'default'` / `true` / 内联对象 | 全部抛错；错误含路径 + 「解决方式」+ `code`；文件字节不变、无 `.bak`、无 `.tmp` |
| B | 新文件 + 共享 `extends` | 拒绝且**不创建文件** |
| C | `false` / `'none'` | 原样写回（不归一化）；字段顺序 `version/name/extends/rules[/semantic]`；`readGateScope` 读回仍在；`loadGateConfig` 只剩本层规则（默认 10 条 + 用户层都不参与） |
| D | 盘上已有共享 `extends` + 入参不带 / 带 `false` | 都拒绝；文件字节不变、无 `.bak`、无 `.tmp` |
| E | 盘上 `false`/`'none'` + 入参不带 | 原值保留；replace 语义保持（用户层规则不回流） |
| F | 盘上 `extends` = `123` / `null` / `[]` | 拒绝，文件不动（不静默当 merge，也不静默抹掉） |
| G | `validateConfig` | `false/'none'/路径/'default'/true/对象` 都保留并原样带回；`123/null/[]/函数` 拒绝且错误点名 `extends` |
| H | API 等价链 `validateConfig → writeGateConfig` | `false` 不丢；共享形式报错且不写盘、无 `.tmp` |
| I | 无 `extends` 旧配置往返 | 不凭空加字段；`.bak` 是上一版全文；成功写盘也无 `.tmp` |
| J | 坏 JSON 层 | 原文逐字节进 `.bak`，再写新配置（可恢复，非静默） |
| K | 入参 `extends: undefined`（own 属性） | 视作未写，不写字段 |
| L | `scope='default'` | 拒绝 |
| M | 非法配置 | 先校验后备份：不产生 `.bak`/`.tmp`，文件不动 |
| N | 写 `local` 时 `project` 有共享 `extends` | 不受影响（只判定目标层） |

### 2.3 「还会不会静默丢失？」——按写者数区分

- **单进程单次写盘：不会。** 所有 `classifyExtends` 分支都有确定行为：可保留的原样写、共享/非法的显式报错；`validateConfig` 不再抹掉 `extends`。此前「面板保存静默丢 extends」的链路（Q1-F3）已闭合。
- **并发写者：仍可能（TOCTOU）。** 已用确定性探针复现：写者 A 读完「盘上无 extends」后，在 `.bak` 备份完成的瞬间，另一个写者 B 把文件改成 `extends:'./shared.json'`；A 继续 `rename`，B 的共享 extends 被覆盖，而 A 的 `writeGateConfig` **返回成功**、调用方不知道。
  - 探针输出：`注入发生=true 本次写盘抛错=否 / 最终 extends=undefined / 最终文件是否还包含 ./shared.json：false`。
  - 位置：`existingExtends(path)`（`:156`）读盘 与 `renameSync(tmp, path)`（`:576`）之间；无文件锁，实现方已在 README 与 C1 结果中声明「TOCTOU 未压测」。
  - 严重度 **low**：DSH 面板写盘在单进程内是同步调用（不可交错），CLI 不写，只有多进程/外部编辑器同时写同一层才会触发；且任务书冻结行为只要求「不得静默丢弃**调用方传入**的 extends」，A 并没有收到 extends。若要根治需文件锁（或写前 re-read + 冲突检测），超出 v3 冻结范围。

---

## 三、`false` / `'none'` 兼容与 API 链

- 读语义（`:286-302`）：`false/'none'` = `replace`（丢掉之前所有层）；写回后 `loadGateConfig` 仍只有本层规则 —— 实测见 §2.2 C/E。
- 新面板：本层有 `false/'none'` 时 `gateConfigOf` 原样带上；有共享形式则保存按钮禁用并说明形态（Q2 细审）。
- 旧客户端/外部调用方：POST 的 config 不带 `extends` 时，服务端用盘上现有值兜底 —— 盘上 `false/'none'` 不会被悄悄退化成 merge（§2.2 E）；盘上有共享形式则直接报错（§2.2 D）。
- 服务端拒绝不会静默：`POST /gates` 返回 400 `save_failed`，`error` 就是「无法安全写入 extends：<路径>。…解决方式：…」，面板 `save()` catch 后显示并 notify。

---

## 四、写盘原子性与失败路径（含实测）

- 机制：同目录临时文件 + `rename` 替换；`.bak` 在任何写入之前复制；`rename` 失败时清理临时文件并抛原错误。校验失败发生在备份/写入之前（§2.2 M）。
- **无半截文件**：跨进程探针（写者 400 次整层重写，读者紧循环读目标文件）共读到 59,491 次，`JSON 解析失败=0`、`extends 缺失=0`、`.tmp 残留=0`。读者从未看到不完整 JSON；该次写进程在并发读下中途 `EPERM` 退出（即 R2 的句柄问题，失败仍在临时代替前抛出）。无并发读者时同一写循环 400/400 成功。
- **失败即显式、不丢数据**：Windows 上若目标文件被另一进程持有打开句柄，`renameSync` 会 `EPERM`（实测 hold fd：0/8 成功；无并发时 8/8 成功）。此时写盘抛错（面板显示保存失败）、原文件保持原内容、临时文件被清理 —— 是 fail-safe，不是静默写坏。
- 残余：`rename` 没有重试（编辑器/杀软短暂占用时用户会看到一次保存失败）；该机制在 C1 之前就是如此，**非本轮引入**，见 §八 R2。

---

## 五、preflight 第四段「门禁子包漂移」（S1）

### 5.1 三场景实测（`node scripts/preflight.mjs --fast --no-maintenance`，exit 与行原文）

| 场景 | profile 行原文 | 汇总 |
|---|---|---|
| **真实安装 profile**（现有 缺失 1 / 断链 3 / 漂移 1） | `FAIL profile 一致性 --check  缺失 1 / 断链 3 / 陈旧 0 / 门禁子包漂移 1（lib/index.js），跑 node scripts/sync-profile.mjs --repair` | 2 项失败（另一项见 §七 README） |
| **假 home：干净 profile**（与仓库同盘，`sync-profile --repair` 后 `--check` 四段全零） | `PASS profile 一致性 --check  缺失 0 / 断链 0 / 陈旧 0` | 1 项失败（仅 README）；**没有第四段噪音** |
| **假 home：仅门禁子包漂移**（改 profile 里 gate `lib/index.js`） | `FAIL profile 一致性 --check  缺失 0 / 断链 0 / 陈旧 0 / 门禁子包漂移 1（lib/index.js），跑 node scripts/sync-profile.mjs --repair` | 2 项失败（README + profile） |

判读：

- 旧实现的假绿形状（`缺失 0/断链 0/陈旧 0` 但 exit 1，或子包漂移被折进「陈旧」）不再出现：第三行正是 S1 修掉的那一种。
- 撤掉「漂移并入陈旧」垫片后，`陈旧` 只表示「profile 多出仓库已删的 lib 文件」，不会再有「陈旧 1 但 profile 里没有多余文件」的误导；没有其它脚本/测试消费旧三段计数（全仓 grep：只有 `preflight.mjs`、`sync-profile.mjs`、`sync-profile-drift.test.mjs`；历史文档除外）。
- 干净场景与漂移场景的 PASS/FAIL 由 `res.status === 0` 决定，detail 只做展示；`--check` 在任一漂移时 exit 1（drift 用例 5/5 守着）。

### 5.2 残余（low，不阻塞）

- **CI 无 profile 时**：preflight 打印 `SKIP profile 一致性 --check` 但**没有** `record()`，汇总行里这项直接消失（历史审计已记为 W4）。CI 客观上没有安装副本，属既有设计；本轮未改。
- **源文件相对 import 断裂**（`--check` exit 2）时：stdout 仍是四段全零，preflight 显示 `FAIL 缺失 0 / 断链 0 / 陈旧 0` 且没有「跑 --repair」提示（原因在 stderr，preflight 只抓 stdout）。仍是正确红，但明细可读性差 —— 既有问题，见 §八 R3。
- preflight 第四段的解析没有自动化用例（`--fast` 也不跑；本次靠三场景实跑与 V1 复核）。可考虑把「三场景 → 行文本」做成轻量注入用例，见 §八 R4。

---

## 六、TARGETS 防漏与打包边界（S1）

### 6.1 独立派生（不读测试实现）

从发布契约独立派生（`package.json` 的 `files`（去掉 `docs/`、`*.md`）+ `exports` + `bin` + `dsh.bundle.patch` + `lib/**` 递归）：

- 派生 **19** 个运行时文件；脚本 `TARGETS` **21** 条；**缺失 0**。
- 多出的两条只有 `README.md`、`CHANGELOG.md`（`*.md` 被派生规则有意跳过，但它们在清单里是既有行为）。
- `TARGETS` 每一条磁盘都存在；无 `test/ docs/ scripts/ packages/` 开发件。
- 脚本清单本身也已被测试守住：`test/sync-profile-drift.test.mjs:152` 的派生用例 + `test/meta.test.mjs` 的 `lib/` 覆盖用例。

### 6.2 注入验证（临时副本，全部按预期红并点名）

| 注入 | 结果 |
|---|---|
| 新增 `lib/zz-new-runtime.js`（未进 TARGETS） | ✖ `这些运行时文件没进 TARGETS…：lib/zz-new-runtime.js`，5 项里 1 fail |
| 新增 `assets/icon-new.png` 并加入 `package.json.files`（未进 TARGETS） | ✖ 点名 `assets/icon-new.png` |
| 把 `test/zz-dev.mjs` 加进 TARGETS | ✖ `TARGETS 不该包含开发件（test/ docs/ scripts/ packages/）：test/zz-dev.mjs` |

### 6.3 打包边界

- `package.json` 在 `git diff HEAD` 里为空；`TARGETS` 只影响 profile 同步，不影响 `npm pack`。preflight 的 `npm pack 内容` = 30 个文件（PASS），无 `test/`、`.tmp-`、`node_modules/` 泄漏。
- 新增的三条（`bin/check.mjs`、`assets/icon-180.png`、`assets/icon-app.png`）都在既有 `files` 里，是**补同步**而不是扩大打包。

### 6.4 残余：清单条目的「磁盘存在性」没有守卫（low）

- `sync-profile.mjs` 对源文件不存在是 `continue`（静默跳过）；派生用例 `addTree` 对不存在的源也 `return`；`TARGETS` 反向检查只验证「在 `files` 里」，不验证文件存在。
- 实测：删掉 `assets/icon-app.png` 后（保留在 `files` 和 `TARGETS`）→ 派生用例 5/5 PASS、`sync-profile --check` = `缺失 0 / 断链 0 / 陈旧 0 / 门禁子包漂移 0` exit 0、`npm pack` 静默少这一项；而 `audit-pack.mjs` 的 `REQUIRED` 不含 `icon-app.png`（只含 `icon-180.png`）→ 所有门禁全绿，但 README 头图 `assets/icon-app.png` 已不存在。
- 当前树上文件确实存在、I1 `--repair` 会同步；这是「未来删除/改名时没有守卫」的 low 残余，见 §八 R5。

---

## 七、I1 发布前必须完成的收口（不属 Q1 阻塞项）

| # | 事项 | 现状/证据 |
|---|---|---|
| 1 | 根 `README.md` 单测数 873 → 890 | preflight `FAIL README 单测数  README 写 873，实际 890`（三份日志一致） |
| 2 | 真实安装 profile `node scripts/sync-profile.mjs --repair` 后复验四段全零 | 当前 `缺失 1（assets/icon-app.png）/ 断链 3 / 陈旧 0 / 漂移 1`，exit 1；只声明磁盘一致，不声明宿主运行时生效 |
| 3 | `@mycf711/dsh-gate` 版本 bump（行为变了） | `packages/dsh-gate/package.json`、`gates/default.json` 在 HEAD 未改；版本仍 `0.1.1`。bump 时同步：`packages/dsh-gate/package.json`、`PACKAGE_VERSION`（`lib/index.js:49`）、`test/default-config.test.mjs:22`、`test/gate-provider.test.mjs:39`、根 `package.json` 依赖/`package-lock` |
| 4 | main CI / 发布三件套 / tag | 未推送；属 I1 |

> 说明：Q1 的 PASS 是对**改动本身**的结论；上述 4 项不清掉，发布不得宣称完成（与 V1 报告 §七一致）。

---

## 八、残余风险清单（low，均不阻塞本轮）

| ID | 严重度 | 问题 | 位置 | 建议（可选，超出 v3 冻结范围） |
|---|---|---|---|---|
| R1 | low | 并发写者 TOCTOU：写者在「读 existing → rename」窗口内被另一写者改成共享 extends，会被静默覆盖且本次写返回成功（已确定性复现） | `lib/index.js:550-576` | 文件锁（仓内已有 `scripts/gate-lock.mjs` 模式）或写前 re-read + 冲突检测 |
| R2 | low | Windows 下目标文件被其它进程持有打开句柄时 `renameSync` 抛 `EPERM`（实测 hold fd 0/8），无重试；失败显式、原文件不坏、`.tmp` 清理 | `lib/index.js:576` | 3 次短退避重试（先在锁内/同目录 rename） |
| R3 | low | 源 lib 相对 import 断裂时 `--check` exit 2，preflight 明细是四段全零、没有原因（stderr 未纳入展示） | `scripts/preflight.mjs:166-175` | detail 里拼 `相对 import 解析失败` 或把 stderr 首行带上 |
| R4 | low | preflight 第四段解析没有自动化守卫（只有手工/验收实跑） | `scripts/preflight.mjs:166` | 轻量用例：三份固定 stdout → 期望 detail/ok |
| R5 | low | `TARGETS` 条目磁盘存在性无守卫；`assets/icon-app.png` 被删时全门禁仍绿（已实测） | `test/sync-profile-drift.test.mjs:152`、`scripts/audit-pack.mjs:45` | 派生用例加 `existsSync` 断言，或把 `icon-app.png` 加入 `audit-pack` 的 `REQUIRED` |

> 另：`packages/dsh-gate/README.md:66` 与 `lib/index.js:103/532` 仍写「只写 `version/name/rules/semantic`」，但实现现在会保留 `extends: false/'none'`（同段表格已说明）。措辞可顺手修，不影响行为（info 级）。

---

## 九、证据与命令（原始计数/退出码）

```
# 1) 门禁包全量
cd packages/dsh-gate && node --test
  ℹ tests 143 / pass 143 / fail 0 / exit 0

# 2) sync-profile 漂移 + TARGETS 用例
node --test test/sync-profile-drift.test.mjs
  ℹ tests 5 / pass 5 / fail 0 / exit 0

# 3) 独立 extends 探针（仓库外）
node q1-extends-probe.mjs
  23/23 PASS, fail 0, exit 0

# 4) 写盘原子性（跨进程）
写进程 400 次整层重写 + 读者紧循环：
  读次数=59491 JSON 解析失败=0 extends 缺失=0 .tmp 残留=0
  该次写进程在并发读下中途 EPERM（exit 1，见 R2）；无并发读者时 400/400 写成功（exit 0）
hold fd 并发：无并发 8/8 OK；父进程 hold fd 0/8 OK（EPERM）；紧读 14/15 OK

# 5) TOCTOU 确定性复现
注入发生=true 本次写盘抛错=否
最终 extends=undefined；最终文件是否还包含 ./shared.json：false
→ CONFIRMED（仅并发写者；low）

# 6) preflight 三场景（--fast --no-maintenance）
真实 profile：2 项失败 —— README 单测数；profile 一致性（含第四段）
干净假 home：1 项失败 —— 仅 README 单测数；profile PASS 且无第四段
仅漂移假 home：2 项失败 —— README；profile（第四段 1（lib/index.js））
三场景 node --test 均 890/890、失败 0

# 7) TARGETS 独立派生
derived 19 / listed 21 / missing 0 / TARGETS 全部磁盘存在 / 无开发件

# 8) 打包
git diff HEAD -- package.json → 空；preflight「npm pack 内容」= 30 个文件 PASS
删除 assets/icon-app.png 的副本里：guard 5/5 PASS、--check 四段全零 exit 0、npm pack 静默少该项
```

---

## 十、判据对照（Q1 contract）

| 要求 | 判据 | 结论 |
|---|---|---|
| `extends` 不得静默丢失 | 单写者所有形态 + API 链 + 旧客户端缺省 | 通过（并发写者残余见 R1，low、已文档化） |
| `false/none` 兼容 | 原样写回 + 读回 replace + 入参缺省保留盘上值 | 通过 |
| 写盘原子性 | 无半截文件、失败不坏原文件、备份可恢复、临时文件清理 | 通过（R2 为既有 Windows 句柄问题，low） |
| preflight 第四段不假绿/不假红 | 三场景实跑 + 旧垫片撤除 + 无其它消费方 | 通过（R3/R4 为既有明细与用例缺口，low） |
| TARGETS 不漏/不扩大 | 独立派生 + 三类注入 + `package.json` 未改 + pack 数 | 通过（R5 为存在性守卫缺口，low） |
| 审查结论 | 0 blocker / 0 high | **PASS** |

---

*本报告只对上述工作树快照（HEAD `e5cf489` + 未提交改动）负责；I1 完成 §七后，发布证据应以那次快照另行复验。*
