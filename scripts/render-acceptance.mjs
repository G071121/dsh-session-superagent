// 生成 docs/验收清单.md：把 preflight 的每一项翻译成"它能防止什么事故"。
//
// 判据（写死）：**每个 record('…') 都必须有解释**，否则 --check 失败 ——
// 门禁从"一堵墙"变成"可解释的保障"。
//
// 用法：
//   node scripts/render-acceptance.mjs           # 打印
//   node scripts/render-acceptance.mjs --write   # 写入 docs/验收清单.md
//   node scripts/render-acceptance.mjs --check   # 校验文档与代码一致 + 每项都有解释
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const preflight = readFileSync(join(root, 'scripts', 'preflight.mjs'), 'utf8')
const coverage = JSON.parse(readFileSync(join(root, 'test', 'fixtures', 'gate-coverage.json'), 'utf8'))
const covered = new Set(coverage.covered)
const suspect = new Set(Object.keys(coverage.suspect || {}))
const exempt = coverage.exempt || {}

// 代码里真实的检查项（按出现顺序，去重）
const names = []
for (const match of preflight.matchAll(/record\('([^']+)'/g)) {
  if (!names.includes(match[1])) names.push(match[1])
}

// 每项：防什么 + 证据（真实事故 / KB 条目）
const WHY = {
  '门禁自检': ['僵尸检查（永远是绿的，其实不检查任何东西）', 'KB `gate-mutation-check.md`'],
  '跳过可见性': ['测试静默跳过（显示通过，其实一行断言没跑）', 'KB `fake-pass.md`'],
  '工具承诺对照': ['工具描述里的承诺（幂等/只读/默认值）没进对账表', 'KB `tool-panel-parity.md`'],
  '术语表对照': ['面板在用但术语表没解释的词（客户会卡住）', 'KB `jargon-audit.md`'],
  '错误建议': ['错误建议过长或没有可执行动作（0.9.62 曾出现兜底建议为空）', 'KB `error-must-have-next-step.md`'],
  '知识库反查': ['知识库里的规则没人指着，写完就忘（T34 实测 182 条里生产代码只引用 3 条）', 'KB `attention-list-order-is-a-decision.md`（一条从 0.9.87 烂到 0.9.239）'],
  'React 语义': ['代码依赖了 `props.key` 或改写了 props —— 真 React 会剥掉 key、冻结 props，只有测试桩里才成立（0.9.248 客户实拍：设置页左栏点了不换内容）', 'KB `test-harness-must-match-runtime.md`（桩比运行时干净就会掩盖 bug）'],
  '临时目录收口': ['测试漏建临时目录（本机曾攒到 1654 个、一次跑漏 8 个）', 'KB `temp-dir-leak.md`'],
  '单测 node --test': ['功能回归：纯函数、路由、面板渲染', 'KB `fake-pass.md`（条件断言曾让一档用例静默跳过）'],
  'README 单测数': ['文档里的数字过期（曾写 136，实际 181）', 'KB `prose-numbers-drift.md`'],
  '语法 node --check': ['生成代码时的语法错误（模板字符串把 \\n 写成真换行）', 'CHANGELOG 0.9.44'],
  'profile 一致性 --check': ['新文件没进 profile → 插件整体不挂载（2026-11-02 真机事故）', 'KB `limits-must-track-code.md`'],
  '版本一致（4 处）': ['改了代码没重启，面板显示的样子骗人', 'KB `version-drift-inside.md`'],
  '路由面（13 条）': ['路由注册异常（数量/路径与契约不符）', 'CHANGELOG 0.9.31（加 /trace 时同步改四处期望）'],
  '路由面（13 条）': ['路由数量漂移：面板接口与工具面不一致', 'CHANGELOG 0.9.31'],
  'npm pack 内容': ['包内容泄漏或漏文件（发布后才发现的经典事故）', 'README 安装节'],
  '离线挂载冒烟': ['apply 抛错 / 挂载后路由缺失', 'KB `offline-mount-smoke.md`'],
  '文档链接': ['文档互相引用的断链', 'KB `identifier-drift.md`'],
  '并发隔离': ['两个会话守同一仓库时互相踩', 'KB `concurrent-isolation.md`'],
  '隔离链路': ['worktree 回收不掉、主工作区被污染', 'KB `verify-isolation-chain.md`'],
  '文案快照': ['客户会读到的文字被悄悄改坏', 'KB `copy-snapshot.md`'],
  'JSON 契约': ['字段清单与契约文档脱节', 'KB `field-stability-manifest.md`'],
  '全库文档一致': ['文档里提到不存在的工具/路由/文件', 'KB `audit-false-positives.md`'],
  '对比度体检': ['浅色/深色下文字与控件边界看不清', 'KB `contrast-baseline.md`'],
  '文档序号引用': ['文档用「第 N 项」引用 preflight', 'KB `prose-numbers-drift.md`'],
  '单行长度': ['唤醒消息里出现过长的行', 'KB `line-length-limit.md`'],
  '信息密度': ['首屏区块过多', 'KB `information-density.md`'],
  '文档标识符': ['工具名/路由改名后文档没跟上', 'KB `identifier-drift.md`'],
  '知识库有据': ['知识库的 ✅ 没有对应发布、路径不存在', 'KB `audit-kb-claims.md`'],
  '反向用例': ['最容易退化的五项已经退化（改坏也不会红）', 'KB recurring-theme-means-missing-check.md + 0.9.109'],
  '回归清单文档': ['回归清单与用例不同步（文档说有五项，实际不跑）', 'scripts/render-regression-doc.mjs（0.9.109）'],
  '退出码一致': ['打印了 FAIL 却不返回失败（第三类装死）', 'KB found-problem-but-exit-zero.md（0.9.111）'],
  '模式差异文档': ['--fast 跳过了什么、风险是什么，没人说得清', 'scripts/render-preflight-modes.mjs（0.9.108）'],
  '整句文案不重复': ['同一句中文在源码里出现两次（改一处忘另一处）', 'CHANGELOG 232 条里「重复」相关 22 次'],
  'README 与代码一致': ['README 写死的数字/工具名与代码漂移（客户第一份契约出错）', 'scripts/verify-readme-claims.mjs（0.9.101）'],
  '面板请求体积': ['/state 在 20 条守时过大（每 5 秒拉一次，流量直接翻倍）', 'scripts/measure-state.mjs（0.9.88 起）'],
  '长跑体积': ['状态文件随运行时间无限增长（数组没封顶）', 'KB measure-before-trimming.md + 0.9.95'],
  '双主题预览可渲染': ['面板在另一套主题下渲染失败', 'KB `information-density.md`'],
  'UI 体检': ['写死颜色 / 裸 div 可点 / 弹层键盘不可用', 'KB `information-density.md`'],
  '维护一致性': ['版本 bump 了但没打 tag / 没进 CHANGELOG / 徽章没改 —— 用户拿不到新版', 'MAINTENANCE.md 四.5'],
  '贡献归属': ['维护者另开同功能 PR 抢走客户入口，或采用 issue 评论代码却不计贡献者署名', 'PR #49 重复集成拦截 / PR #43 的 fixriver 代码署名复核'],
  '冒烟 smoke:observe': ['真机 observe 模式跑不起来', 'README 验收节'],
  '验收清单': ['门禁项没有解释（新增检查忘了写“防止什么”）', 'KB `explainable-gates.md`'],
  '面板文案快照': ['面板上那几十条提示被悄悄改坏', 'KB `copy-snapshot.md`'],
}

const missing = names.filter((name) => !WHY[name])

// 解释本身也要被验证：证据里提到的 KB 文件与 CHANGELOG 版本必须真实存在
const kbFiles = new Set(readdirSync(join(root, 'docs', 'kb')).filter((f) => f.endsWith('.md')))
const changelog = readFileSync(join(root, 'CHANGELOG.md'), 'utf8')
const versions = new Set([...changelog.matchAll(/^## \[(\d+\.\d+\.\d+)\]/gm)].map((m) => m[1]))
const badEvidence = []
for (const [name, [, evidence]] of Object.entries(WHY)) {
  for (const match of String(evidence).matchAll(/KB `([^`]+)`/g)) {
    if (!kbFiles.has(match[1])) badEvidence.push(name + ' → 知识库没有 docs/kb/' + match[1])
  }
  for (const match of String(evidence).matchAll(/CHANGELOG (\d+\.\d+\.\d+)/g)) {
    if (!versions.has(match[1])) badEvidence.push(name + ' → CHANGELOG 没有版本 ' + match[1])
  }
}
const stale = Object.keys(WHY).filter((name) => !names.includes(name))

function render() {
  const lines = []
  lines.push('# 验收清单（由 `scripts/render-acceptance.mjs` 生成，不要手改）')
  lines.push('')
  lines.push('`node scripts/preflight.mjs` 共 **' + names.length + '** 项。每一项都写清"它能防止什么"，')
  lines.push('因为**不可解释的门禁等于没有门禁** —— 红了没人知道该不该急。')
  lines.push('')
  lines.push('| # | 检查 | 防止什么 | 证据 | 注入验证 |')
  lines.push('|---|---|---|---|---|')
  names.forEach((name, index) => {
    const [why, evidence] = WHY[name] || ['（缺解释）', '（缺证据）']
    lines.push('| ' + (index + 1) + ' | `' + name + '` | ' + why + ' | ' + evidence + ' | ' + (suspect.has(name) ? '⚠️' : (covered.has(name) ? '✅' : (exempt[name] ? '⛔' : '—'))) + ' |')
  })
  const coveredCount = names.filter((name) => covered.has(name)).length
  lines.push('')
  lines.push('**注入验证**：`✅` = 有一个"故意造错看它会红"的注入样例（`scripts/verify-gates.mjs`）；`—` = 还没注入过（不等于没检查）；`⚠️` = 注入后指标没动，疑似失明；`⛔` = 不适合注入（元检查 / 需真机 / 与其他检查重叠），原因见 `test/fixtures/gate-coverage.json` 的 `exempt`。')
  lines.push('当前覆盖 **' + coveredCount + '/' + names.length + '** 项。')
  lines.push('')
  lines.push('---')
  lines.push('')
  lines.push('新增检查时：先在 `scripts/preflight.mjs` 里 `record(...)`，再到 `scripts/render-acceptance.mjs` 的 `WHY` 表里写一句话')
  lines.push('（防止什么 + 证据），然后跑 `--write`。**没写解释的检查会让 `--check` 变红。**')
  return lines.join(String.fromCharCode(10)) + String.fromCharCode(10)
}

const text = render()
const target = join(root, 'docs', '验收清单.md')
const mode = process.argv[2] || ''

if (missing.length > 0) {
  console.log('FAIL 这些检查没有解释：' + missing.join('、'))
  process.exitCode = 1
}
if (badEvidence.length > 0) {
  console.log('FAIL 这些解释的证据找不到：')
  for (const item of badEvidence) console.log('  ' + item)
  process.exitCode = 1
}
if (stale.length > 0) {
  console.log('WARN 这些解释对应的检查已不存在：' + stale.join('、'))
}

if (mode === '--write') {
  writeFileSync(target, text)
  console.log('已写入 docs/验收清单.md（' + names.length + ' 项）')
} else if (mode === '--check') {
  const saved = existsSync(target) ? readFileSync(target, 'utf8') : ''
  if (saved === text) {
    console.log('PASS 验收清单与 preflight 一致（' + names.length + ' 项，每项都有解释）')
  } else {
    console.log('FAIL docs/验收清单.md 与 preflight 不一致 —— 跑 node scripts/render-acceptance.mjs --write')
    process.exitCode = 1
  }
} else {
  console.log(text)
}
