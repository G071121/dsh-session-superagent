/**
 * 门禁 / 模型浏览器场景的**唯一真源**（v6 Q2-2）。
 *
 * 为什么单独一个文件：
 *   v6 B1 把 v5 的临时 harness 收进 `scripts/verify-panel-chromium.mjs` 时，场景名是直接
 *   写在 `check(...)` 第一参数里的字面量，静态护栏只能做 `source.includes(场景名)`：
 *   掏空断言、把场景包进 `if (false)`、甚至整段删掉，护栏照样绿。
 *   现在套件用 `gateScenarioCheck(id, …)` 注册，id 从这里取；静态护栏
 *   （`test/client.test.mjs` 的「浏览器证据入库」）同时拿三份证据对齐：
 *     ① 本文件的 `GATE_MODEL_SCENARIO_IDS`（声明）；
 *     ② `verify-panel-chromium.mjs --list-scenarios` 扫出的注册点（实际注册）；
 *     ③ 套件运行期的完整性硬断言（真的执行过）。
 *   少一条、多一条、重复、掏空成 `true`、被 `if (false)` 包住，都会红。
 *
 * 只放「id → 人类可读场景名」的纯数据，不 import 任何东西：
 *   套件主体是经 stdin 注入给 `ego-browser nodejs` 的（`import.meta.url` 不可用），
 *   只能用绝对 file URL 动态 import 本文件，所以这里必须保持零依赖。
 */

/** 17 条场景：U1-V0…V6 共 7 条（门禁 /gates）+ U5-V0…V6b 共 10 条（模型列表 /gates/models）。 */
export const GATE_MODEL_SCENARIOS = Object.freeze({
  'U1-V0': 'U1-V0 门禁分区真实渲染且第一次读取由真实 effect 发出',
  'U1-V1': 'U1-V1 乱序（跨仓库）：迟到的旧仓库响应不覆盖新仓库数据',
  'U1-V2': 'U1-V2 在途 dirty：响应回来时不清掉新草稿',
  'U1-V3': 'U1-V3 乱序（同仓库）：先发的后到不能覆盖最新一次读取',
  'U1-V4': 'U1-V4 取消换仓库：保留草稿且不去读新仓库',
  'U1-V5': 'U1-V5 targetRepo：保存/预览写的是 GET 回显的 data.repo（不是刚切过去的仓库）',
  'U1-V6': 'U1-V6 保存成功后按当前仓库重读并清掉保留草稿提示',
  'U5-V0': 'U5-V0 切仓库后模型列表跟随面板仓库读取（alpha）',
  'U5-V1': 'U5-V1（M1 user）保留草稿：按钮只读草稿来源 alpha，不读新仓库 bravo，下拉不含 bravo 模型',
  'U5-V2': 'U5-V2（M2）闸门挡住 charlie 时：重读 bravo models（>=1 条）、没有 charlie models 请求',
  'U5-V2b': 'U5-V2b 被作废的在途 bravo 列表（seq 更小）迟到后不能覆盖最新列表',
  'U5-V3a': 'U5-V3a 渲染护栏：面板已切 delta、列表还是 charlie 时提示忽略，下拉只剩当前值',
  'U5-V3b': 'U5-V3b 迟到的 charlie 列表不能覆盖 delta（跨仓库响应丢弃），护栏消失',
  'U5-V4': 'U5-V4（M4）确认放弃草稿并切换：模型列表跟着切到 echo（>=1 条），不含 delta 模型',
  'U5-V5': 'U5-V5（U2-F2）取消换仓库：保留草稿、重读 echo 模型（>=1 条），不读 foxtrot',
  'U5-V6a': 'U5-V6a 项目层前提：作用域可切「项目」、模型下拉禁用、草稿能变脏',
  'U5-V6b': 'U5-V6b（M1 project）项目层保留草稿：确认条在、按钮读草稿来源 foxtrot，不读 golf',
})

/** 有序 id 列表（声明顺序 = 套件里的执行顺序）。 */
export const GATE_MODEL_SCENARIO_IDS = Object.freeze(Object.keys(GATE_MODEL_SCENARIOS))

/** 套件里注册场景用的函数名；护栏按这个名字扫注册点，改名要同时改两边。 */
export const GATE_MODEL_REGISTRAR = 'gateScenarioCheck'
