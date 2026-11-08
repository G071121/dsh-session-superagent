// 一条命令跑完「发版必跑」的七项检查，输出 PASS/FAIL 表并以退出码给出结论。
//
// 目的：把 HANDOFF 里那段散文式检查清单变成可执行的东西 —— 清单会过期，脚本不会。
//
// 用法：
//   node scripts/preflight.mjs            全部检查（gh 不可用时冒烟自动 SKIP）
//   node scripts/preflight.mjs --fast     跳过冒烟（不请求 GitHub、不建 worktree）
import { execFileSync, spawnSync } from 'node:child_process'
import { FAST_SKIPS } from './preflight-modes.mjs'
import { acquireGate } from './gate-lock.mjs'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

// 本文件既是 CLI，也是「profile 行怎么记」的**单一事实来源**。
// v3 审查 R4：第四段「门禁子包漂移」的解析一直只有人工实跑，没有仓库内用例 ——
// 于是 `test/sync-profile-drift.test.mjs` 需要 import 下面的纯函数来钉住 clean / drift 两种文案。
// 被 import 时不能跑整轮门禁（node --test 会 import 本文件），所以主体包在 IS_MAIN 里。
// 判据用 import.meta.main（Node 22.18+/24）—— 它按「是不是入口模块」判，不受调用路径影响；
// 老 Node 没有这个字段时退回 argv[1] 比对，比对不出来就**当 CLI 跑**（宁可多跑，不许静默不跑）。
const IS_MAIN = (() => {
  if (typeof import.meta.main === 'boolean') return import.meta.main
  try {
    return fileURLToPath(import.meta.url) === process.argv[1]
  } catch {
    return true
  }
})()

/**
 * 解析 `node scripts/sync-profile.mjs --check` 的输出 → 这一行怎么记、详情怎么写。
 *
 * 为什么要在 preflight 里解析第四段：只认前三段时，子包内容不一致会被静默丢掉 ——
 * 「缺失 0 / 断链 0 / 陈旧 0」看着全绿，实际 profile 里跑的是旧门禁（0.10.8 假绿的形状）。
 * S1 新增第五段「TARGETS 缺源」（清单条目在仓库里不存在）：出现就点名，且不能算干净。
 *
 * 返回 { clean, drifted, gateDrift, changed, manifest, detail }：
 *   clean    = 四段全零且没有 TARGETS 缺源（看不到四段时也算不干净：证明不了就没资格算过）
 *   detail   = 给人看的文案；没有漂移时不加第四段（别给全绿加噪音）
 */
export function summarizeProfileCheck(out) {
  const text = String(out || '')
  const four = text.match(/缺失 (\d+) \/ 断链 (\d+) \/ 陈旧 (\d+) \/ 门禁子包漂移 (\d+)/)
  const manifest = text.match(/TARGETS 缺源 (\d+)(?:（([^）\n]*)）)?/)
  const manifestCount = manifest ? Number(manifest[1]) : 0
  if (!four) {
    // 老格式（只有三段）：读不出第四段就没法证明子包不漂移，按不干净处理（preflight 与 sync-profile 同版发布）
    return {
      clean: false, drifted: 0, gateDrift: 0, changed: null, manifest: manifestCount,
      detail: (text.match(/缺失 \d+ \/ 断链 \d+ \/ 陈旧 \d+/) || ['(无输出)'])[0],
    }
  }
  const gateDrift = Number(four[4])
  const drifted = Number(four[1]) + Number(four[2]) + Number(four[3]) + gateDrift
  const changed = gateDrift > 0 ? (text.match(/内容与 packages\/dsh-gate 不一致：([^；\n]+)/) || [])[1] || null : null
  let detail = `缺失 ${four[1]} / 断链 ${four[2]} / 陈旧 ${four[3]}`
  if (gateDrift > 0) detail += ` / 门禁子包漂移 ${four[4]}` + (changed ? `（${changed}）` : '')
  if (manifestCount > 0) {
    detail += ` / TARGETS 缺源 ${manifestCount}` + (manifest[2] ? `（${manifest[2]}）` : '') + '，清单条目不成立（--repair 修不了）'
  } else if (drifted > 0) {
    detail += '，跑 node scripts/sync-profile.mjs --repair'
  }
  return { clean: drifted === 0 && manifestCount === 0, drifted, gateDrift, changed, manifest: manifestCount, detail }
}

// 下面整段是 CLI 主体。为了不让 500 行的缩进变化淹掉真改动，这里只外包一层条件、不重排缩进。
if (IS_MAIN) {

// 审核 T18 M2：整轮门禁**只持一把锁**。
// 以前只有 2/39 项（audit-pack / regression-cases）自己抢锁，而 verify-gates 在 14 个路径上注入写入 ——
// 两个会话同时跑门禁就是双向假红（「改坏后 code=1 / 还原后 code=1」）。
// 这里在入口拿锁：子进程通过继承的 token 重入，不会死锁。
let releaseGate = null
try {
  releaseGate = acquireGate('preflight', { timeoutMs: 600000 })
} catch (error) {
  if (error && error.code === 'GATE_BUSY') {
    console.error('SKIP 另一个门禁正在跑（pid ' + (error.owner && error.owner.pid) + '），本次不跑 —— 退出码 3（不算通过）')
    process.exit(3)
  }
  throw error
}
process.on('exit', () => { try { releaseGate && releaseGate() } catch { /* 尽力而为 */ } })
const FAST = process.argv.includes('--fast')
// PR 分支上跳过维护一致性：版本号已 bump 但 tag 只在合并后才打，这条必然红。
// CI 里用 --no-maintenance 跳过它，改成 push 到 main 时单独跑一步。
const SKIP_MAINTENANCE = process.argv.includes('--no-maintenance')
const rows = []
// 记一项检查；耗时用「距上一项记录」的差值算出来 —— 不用改任何调用点
let lastMark = Date.now()
const record = (name, ok, detail = '', ms = null) => {
  const now = Date.now()
  if (ms === null) ms = now - lastMark
  lastMark = now
  // 审核 M6：'skip' 是第三种状态 —— 这项**没跑**（比如另一个门禁占着锁）。
  // 以前调用方传 exit 0 就被记成 PASS，汇总里含一项没跑的检查，是假绿。
  rows.push({ name, ok, detail, ms })
  const tag = ok === 'skip' ? 'SKIP ' : ok ? 'PASS ' : 'FAIL '
  console.log(tag + name.padEnd(34) + detail + (ms === null ? '' : '  (' + (ms / 1000).toFixed(1) + 's)'))
}

const CHILD_ENV = { ...process.env }
delete CHILD_ENV.DSH_SUPERAGENT_STATE      // 本脚本自己的临时目录，不能污染子进程
delete CHILD_ENV.DSH_SUPERAGENT_NO_POLL    // 路由检查用的开关，冒烟必须真轮询
delete CHILD_ENV.DSH_SUPERAGENT_TRIGGER
// 单测/门禁不该依赖真实 GitHub：没有有效凭证时每次 gh 调用要等到超时（实测单文件 100 秒）
CHILD_ENV.DSH_SUPERAGENT_OFFLINE = '1'
const tryRun = (cmd, args, opts = {}) => spawnSync(cmd, args, { cwd: ROOT, encoding: 'utf8', env: CHILD_ENV, ...opts })

// ① 单测
{
  const res = tryRun('node', ['--test'])
  const out = String(res.stdout || '') + String(res.stderr || '')
  const tests = (out.match(/# tests (\d+)/) || out.match(/ℹ tests (\d+)/) || [])[1]
  const pass = (out.match(/# pass (\d+)/) || out.match(/ℹ pass (\d+)/) || [])[1]
  const fail = (out.match(/# fail (\d+)/) || out.match(/ℹ fail (\d+)/) || [])[1]
  record('单测 node --test', res.status === 0 && fail === '0', `${pass}/${tests} 通过，失败 ${fail}`)
  // 审核 T28 M1：失败时**必须**把失败用例名打出来。
  // 以前整段输出被吞掉，CI 日志只剩「361/363 通过，失败 1」—— 本地复现不了就永远查不出是哪个。
  if (res.status !== 0) {
    const failed = out.split(String.fromCharCode(10)).filter((line) => /^(✖|not ok |  AssertionError|ℹ fail )/.test(line.trim()))
    console.log('--- 失败详情（最多 40 行）---')
    for (const line of failed.slice(0, 40)) console.log('  ' + line.trim())
    if (failed.length === 0) console.log('  （没解析到失败行，下面贴输出末尾 40 行）')
    if (failed.length === 0) for (const line of out.trim().split(String.fromCharCode(10)).slice(-40)) console.log('  ' + line)
    // 只列 not ok 标题看不到真正断言。再贴首个失败的完整上下文，CI 才能定位平台差异。
    const lines = out.split(String.fromCharCode(10))
    const firstFailure = lines.findIndex((line) => /^(✖|not ok )/.test(line.trim()))
    if (firstFailure >= 0) {
      console.log('--- 首个失败完整上下文（最多 100 行）---')
      for (const line of lines.slice(firstFailure, firstFailure + 100)) console.log('  ' + line)
      console.log('--- 首个失败上下文结束 ---')
    }
    console.log('--- 失败详情结束 ---')
  }
  // README 里写着“N 项单测”：这个数最容易悄悄过期（本轮从 136 掉到 181 才发现）
  const claimed = (readFileSync(join(ROOT, 'README.md'), 'utf8').match(/(\d+) 项单测/) || [])[1]
  const res2 = tryRun('node', ['scripts/audit-readme-tests.mjs', String(tests)], { timeout: 60000 })
  const line2 = (String(res2.stdout || '').trim().split(String.fromCharCode(10)).pop() || '无输出')
  record('README 单测数', res2.status === 0, line2.replace(/^(PASS|FAIL) README 单测数\s*/, ''))
}

// ①.45 跳过必须可见（skip 要带原因；用例体内不许静默 return）
{
  const res = tryRun('node', ['scripts/audit-test-skips.mjs'], { timeout: 60000 })
  const out = String(res.stdout || '')
  const bad = out.split(String.fromCharCode(10)).filter((line) => line.startsWith('FAIL '))
  const warn = out.split(String.fromCharCode(10)).filter((line) => line.startsWith('WARN '))
  record('跳过可见性', res.status === 0 && bad.length === 0,
    bad.length > 0 ? bad[0].replace(/^FAIL /, '') : (warn.length > 0 ? warn[0].replace(/^WARN /, '') : 'skip 都有原因，无用例体内 return'))
}

// ①.5 临时目录收口（独立脚本，注入验证也能单独跑）
{
  const res = tryRun('node', ['scripts/audit-tmp-dirs.mjs'], { timeout: 60000 })
  const line = (String(res.stdout || '').trim().split(String.fromCharCode(10))[0] || '无输出')
  record('临时目录收口', res.status === 0, line.replace(/^(PASS|FAIL) 临时目录收口\s*/, ''))
}

// ①.6 错误建议体检（每条建议要短、要能做 —— 文字会随版本漂移）
{
  const res = tryRun('node', ['scripts/audit-error-hints.mjs'], { timeout: 60000 })
  const out = String(res.stdout || '').split(String.fromCharCode(10))
  const bad = out.filter((line) => line.startsWith('FAIL'))
  const cover = (String(res.stdout || '').match(/覆盖 (\d+) 类错误/) || [])[1]
  record('错误建议', res.status === 0 && bad.length === 0,
    bad.length > 0 ? bad[0].replace(/^FAIL /, '') : (cover ? cover + ' 类：都 ≤60 字符且有可执行动作' : '无输出'))
}

// ①.65 知识库 ←→ 代码的反向连接（T34：182 条里生产代码只引用 3 条，规则写完就忘）
{
  const res = tryRun('node', ['scripts/audit-kb-links.mjs'], { timeout: 60000 })
  const out = String(res.stdout || '')
  const bad = out.split(String.fromCharCode(10)).filter((line) => line.startsWith('FAIL'))
  const count = (out.match(/代码里的 KB 引用：(\d+) 处/) || [])[1]
  record('知识库反查', res.status === 0 && bad.length === 0,
    bad.length > 0 ? bad[0].replace(/^FAIL /, '') : (count || '?') + ' 处引用，关键行为类条目都有')
}

// ①.66 React 语义陷阱（客户实拍 0.9.248：`props.key` 在真机上是 undefined，桩里却能跑）
{
  const res = tryRun('node', ['scripts/audit-react-semantics.mjs'], { timeout: 60000 })
  const out = String(res.stdout || '')
  const bad = out.split(String.fromCharCode(10)).filter((line) => line.startsWith('FAIL'))
  record('React 语义', res.status === 0 && bad.length === 0,
    bad.length > 0 ? bad[0].replace(/^FAIL /, '') : '不依赖 props.key、不改写 props，桩也按 React 语义剥 key')
}

// ①.7 门禁自检（注入式验证：确认检查真的会红；--fast 跳过，约 10 秒）
if (!FAST) {
  const res = tryRun('node', ['scripts/verify-gates.mjs'], { timeout: 180000 })
  const out = String(res.stdout || '')
  const summary = (out.match(/PASS (\d+)\/(\d+) 项注入都被检测到/) || [])
  record('门禁自检', res.status === 0 && summary.length > 0,
    summary.length > 0 ? summary[1] + '/' + summary[2] + ' 项注入都被检测到（' + (String(res.stdout || '').match(/注入覆盖：(\d+)\/(\d+)/) || ['', '?', '?'])[1] + '/' + (String(res.stdout || '').match(/注入覆盖：(\d+)\/(\d+)/) || ['', '?', '?'])[2] + ' 项有注入）' : (out.split(String.fromCharCode(10)).filter((l) => l.startsWith('FAIL'))[0] || '无输出').replace(/^FAIL /, ''))
}

// ② 语法（独立脚本：注入验证直接跑它，不必跑整套 preflight）
{
  const res = tryRun('node', ['scripts/audit-syntax.mjs'], { timeout: 60000 })
  const line = (String(res.stdout || '').trim().split(String.fromCharCode(10)).pop() || '无输出')
  record('语法 node --check', res.status === 0, line.replace(/^(PASS|FAIL) 语法 node --check\s*/, ''))
}

// ③ profile 一致性（CI 上没有 profile，自动 SKIP）
{
  const home = process.env.DSH_HOME || join(process.env.USERPROFILE || process.env.HOME || '', '.dsh')
  const profileDir = join(home, 'profiles', 'desktop', 'node_modules', 'dsh-session-superagent')
  if (!existsSync(profileDir)) {
    console.log('SKIP profile 一致性 --check        没有 profile 安装目录（CI 环境正常）')
  } else {
    const res = tryRun('node', ['scripts/sync-profile.mjs', '--check'])
    const out = String(res.stdout || '')
    // 解析逻辑在文件顶部的 summarizeProfileCheck（纯函数）：第四段「门禁子包漂移」必须解析 ——
    // 只认前三段时（S1 之前），子包内容不一致会被静默丢掉，「缺失 0 / 断链 0 / 陈旧 0」看着全绿，
    // 实际 profile 里跑的是旧门禁（0.10.8 假绿）；S1 新增的第五段「TARGETS 缺源」同理必须点名。
    // 没有漂移时不加第四段：正常状态只该看到三个数（别给全绿加噪音）。
    // 判定要**两个都成立**：sync-profile 退出码 0，且解析结果 clean（计数非零却 exit 0 也算假绿）。
    const summary = summarizeProfileCheck(out)
    record('profile 一致性 --check', res.status === 0 && summary.clean, summary.detail)
  }
}

// ④ 版本五处一致
{
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
  const client = readFileSync(join(ROOT, 'client.js'), 'utf8')
  const readme = readFileSync(join(ROOT, 'README.md'), 'utf8')
  const changelog = readFileSync(join(ROOT, 'CHANGELOG.md'), 'utf8')
  const clientVersion = (client.match(/const CLIENT_VERSION = '([^']+)'/) || [])[1]
  const badge = (readme.match(/badge\/version-([0-9.]+)-green/) || [])[1]
  const top = (changelog.match(/## \[([0-9.]+)\]/) || [])[1]
  const same = clientVersion === pkg.version && badge === pkg.version && top === pkg.version
  record('版本一致（4 处）', same, `${pkg.version} / client ${clientVersion} / badge ${badge} / changelog ${top}`)
}

// ⑤ 路由面（独立脚本，注入验证也能单独跑）
{
  const res = tryRun('node', ['scripts/audit-routes.mjs'], { timeout: 60000 })
  const line = (String(res.stdout || '').trim().split(String.fromCharCode(10))[0] || '无输出')
  record('路由面（13 条）', res.status === 0, line.replace(/^(PASS|FAIL) 路由面（13 条）\s*/, ''))
}

// ⑥ 打包内容（脚本独立，注入验证也能单独跑它）
{
  const res = tryRun('node', ['scripts/audit-pack.mjs'], { timeout: 120000 })
  const line = (String(res.stdout || '').trim().split(String.fromCharCode(10))[0] || '无输出')
  // 审核 M6：exit 3 = 另一个门禁在跑、本次跳过。跳过**不是通过** —— 记成 SKIP，不进「全部通过」。
  if (res.status === 3) record('npm pack 内容', 'skip', '另一个门禁正在跑，本次跳过（不算通过）')
  else record('npm pack 内容', res.status === 0, line.replace(/^(PASS|FAIL) npm pack 内容\s*/, ''))
}

// ⑥.4 离线挂载冒烟（真机服务端一改就是几十个版本一起跳，挂不上去等于整块功能消失）
{
  const res = tryRun('node', ['scripts/smoke-mount.mjs', '--json'], { timeout: 60000 })
  let detail = '无法解析输出'
  let ok = false
  try {
    const data = JSON.parse(String(res.stdout || '{}'))
    ok = res.status === 0 && data.ok === true
    detail = ok
      ? `${data.version} / 工具 ${data.tools.length} / 路由 ${data.routes.length}`
      : (data.failure || ('缺路由：' + (data.missing || []).join(',')))
  } catch { ok = false }
  record('离线挂载冒烟', ok, detail)
}

// ⑥.45 文档链接体检（45+ 篇互相引用，写错了没人会发现）
{
  const res = tryRun('node', ['scripts/check-docs.mjs'], { timeout: 60000 })
  const out = String(res.stdout || '').trim().split(String.fromCharCode(10))
  record('文档链接', res.status === 0, out[1] ? out[1].replace(/^PASS /, '') : '无输出')
}

// ⑥.49 并发隔离（两个会话守同一仓库时会不会互相踩）
{
  const res = tryRun('node', ['scripts/verify-concurrency.mjs'], { timeout: 120000 })
  const lines = String(res.stdout || '').trim().split(String.fromCharCode(10))
  const last = lines[lines.length - 1] || ''
  const failedLines = lines.filter((line) => line.startsWith('FAIL'))
  record('并发隔离', res.status === 0 && failedLines.length === 0,
    failedLines.length > 0 ? failedLines[0].trim() : last.replace(/^PASS /, ''))
}

// ⑥.48 隔离执行真机链路（唯一还停留在"读过代码"的环节）
{
  const res = tryRun('node', ['scripts/verify-isolation.mjs'], { timeout: 120000 })
  const lines = String(res.stdout || '').trim().split(String.fromCharCode(10))
  const last = lines[lines.length - 1] || ''
  const failedLines = lines.filter((line) => line.startsWith('FAIL'))
  record('隔离链路', res.status === 0 && failedLines.length === 0,
    failedLines.length > 0 ? failedLines[0].trim() : last.replace(/^PASS /, ''))
}

// ⑥.47 客户会读到的文字有没有被改动（示例文档是快照，改动必须是有意的）
{
  const res = tryRun('node', ['scripts/first-run.mjs', '--check'], { timeout: 60000 })
  const out = String(res.stdout || '').trim().split(String.fromCharCode(10))
  record('文案快照', res.status === 0, res.status === 0 ? (out[0] || '').replace(/^PASS /, '') : '文案变了：跑 node scripts/first-run.mjs --write 再看 diff')
}

// ⑥.461 面板文案快照（消息文案早有快照，面板上那几十条提示一直没有）
{
  const res = tryRun('node', ['scripts/render-panel-copy.mjs', '--check'], { timeout: 90000 })
  const out = String(res.stdout || '').trim().split(String.fromCharCode(10))
  record('面板文案快照', res.status === 0, (res.status === 0 ? out[0] : (out[0] || '无输出')).replace(/^(PASS|提示) /, ''))
}

// ⑥.46 验收清单与 preflight 一致（每项检查都要能解释"防什么"，否则门禁不可信）
{
  const res = tryRun('node', ['scripts/render-acceptance.mjs', '--check'], { timeout: 60000 })
  const out = String(res.stdout || '').trim().split(String.fromCharCode(10))
  const bad = out.filter((line) => line.startsWith('FAIL'))
  record('验收清单', res.status === 0 && bad.length === 0, (res.status === 0 ? out[0] : bad[0] || '无输出').replace(/^PASS /, ''))
}

// ⑥.459 JSON 契约文档与字段清单一致（契约要出现在客户看得见的地方）
{
  const res = tryRun('node', ['scripts/render-contract.mjs', '--check'], { timeout: 60000 })
  const out = String(res.stdout || '').trim()
  record('JSON 契约', res.status === 0, out.replace(/^PASS /, '') || '无输出')
}

// ⑥.460 文档里的序号引用（「preflight 第 N 项」必然错位 —— 脚本不打印序号）
{
  const res = tryRun('node', ['scripts/audit-doc-ordinals.mjs'], { timeout: 30000 })
  const out = String(res.stdout || '')
  const line = (out.split(String.fromCharCode(10)).find((l) => l.startsWith('PASS') || l.startsWith('FAIL')) || '无输出')
  record('文档序号引用', res.status === 0, line.replace(/^(PASS|FAIL) /, ''))

}

// ⑥.459 对比度体检（只对「变多」报警：基线里已经登记的不达标项是官方设计语言）
{
  const res = tryRun('node', ['scripts/audit-contrast.mjs'], { timeout: 180000 })
  const out = String(res.stdout || '')
  const base = JSON.parse(readFileSync(join(ROOT, 'test/fixtures/contrast-baseline.json'), 'utf8'))
  const grab = (theme) => { const m = out.match(new RegExp('· ' + theme + '：\\d+ 个节点 / \\d+ 组 ｜ 不达标 (\\d+) 组 (\\d+) 节点')); return m ? { groups: Number(m[1]), nodes: Number(m[2]) } : null }
  const light = grab('light'); const dark = grab('dark')
  const bad = []
  // 退出码 2 = 环境问题（本机没有浏览器 / 渲染空）。CI 上没有浏览器是正常的，
  // 这种情况必须 SKIP 而不是 FAIL —— 否则「没量」会被当成「不达标」，门禁在 CI 里永远红。
  //
  // 审核 T28 M2：以前这里先 record 一次 PASS，末尾又**无条件** record 一次 →
  // 同名两行 PASS，而且「没量」被记成「达标」，对比度回归在 CI 里永远绿。
  // 现在用第三种状态 skip：不进「全部通过」，也不谎报达标。
  const skippedContrast = res.status === 2
  if (skippedContrast) {
    record('对比度体检', 'skip', '没量：本机没有可用的浏览器（CI 环境正常现象，但不算通过）')
  } else if (!light || !dark) bad.push('量不到数据（渲染/浏览器失败）')
  else {
    if (light.groups > base.light.groups) bad.push('浅色不达标 ' + light.groups + ' 组 > 基线 ' + base.light.groups)
    if (dark.groups > base.dark.groups) bad.push('深色不达标 ' + dark.groups + ' 组 > 基线 ' + base.dark.groups)
  }
  if (!skippedContrast) {
    record('对比度体检', bad.length === 0, bad.length ? bad[0] : (light && dark ? '浅色 ' + light.groups + ' / 深色 ' + dark.groups + ' 组（不高于基线）' : '无数据'))
  }
}

// ⑥.458 全 docs/ 一致性（老文档最容易把人带到不存在的工具/路由/文件）
{
  const res = tryRun('node', ['scripts/audit-docs-all.mjs'], { timeout: 60000 })
  const out = String(res.stdout || '')
  const bad = out.split(String.fromCharCode(10)).filter((line) => line.startsWith('FAIL'))
  const scanned = (out.match(/扫描 (\d+) 份文档/) || [])[1]
  record('全库文档一致', res.status === 0 && bad.length === 0,
    bad.length > 0 ? bad[0].replace(/^FAIL /, '') : (scanned || '?') + ' 份文档的工具/路由/版本/路径都对得上')
}

// ⑥.457 唤醒消息单行长度（聊天窗口里太长会挤成一团）
{
  const res = tryRun('node', ['scripts/audit-line-length.mjs'], { timeout: 60000 })
  const out = String(res.stdout || '')
  const worst = out.match(/最长一行 (\d+) 字符/)
  const bad = out.split(String.fromCharCode(10)).filter((line) => line.startsWith('FAIL'))
  record('单行长度', res.status === 0 && bad.length === 0,
    bad.length > 0 ? bad[0].replace(/^FAIL /, '') : (worst ? '最长 ' + worst[1] + ' 字符（上限 120）' : '无输出'))
}

// ⑥.456 信息密度（默认展开的区块不该太多；判据写死在脚本里）
{
  const res = tryRun('node', ['scripts/audit-density.mjs'], { timeout: 60000 })
  const out = String(res.stdout || '')
  const worst = out.match(/最密集的一页有 (\d+) 个区块/)
  const bad = out.split(String.fromCharCode(10)).filter((line) => line.startsWith('FAIL'))
  record('信息密度', res.status === 0 && bad.length === 0,
    bad.length > 0 ? bad[0].replace(/^FAIL /, '') : (worst ? '最密集一页 ' + worst[1] + ' 个区块（上限 6）' : '无输出'))
}

// ⑥.455 文档里提到的工具名/路由必须真实存在（重构改名后文档不会自己报错）
{
  const res = tryRun('node', ['scripts/audit-claims-consistency.mjs'], { timeout: 60000 })
  const out = String(res.stdout || '')
  const bad = out.split(String.fromCharCode(10)).filter((line) => line.startsWith('FAIL'))
  const tools = (out.match(/工具 (\d+) 个/) || [])[1]
  const routes = (out.match(/路由 (\d+) 条/) || [])[1]
  record('文档标识符', res.status === 0 && bad.length === 0,
    bad.length > 0 ? bad[0].replace(/^FAIL /, '') : (tools || '?') + ' 个工具 / ' + (routes || '?') + ' 条路由都对得上')
}

// ⑥.46 知识库的 ✅ 必须能在 CHANGELOG 里找到对应版本（KB 不能只靠自己声称）
{
  const res = tryRun('node', ['scripts/audit-kb-claims.mjs'], { timeout: 60000 })
  const out = String(res.stdout || '')
  const claims = (out.match(/声明\s+(\d+) 条/) || [])[1]
  const paths = (out.match(/提到的文件路径\s+(\d+) 个/) || [])[1]
  const bad = out.split(String.fromCharCode(10)).filter((line) => line.startsWith('FAIL') || line.includes('没写落地状态：'))
  record('知识库有据', res.status === 0 && bad.length === 0,
    bad.length > 0 ? bad[0].trim() : (claims ? claims + ' 条 ✅ 都能找到发布 / ' + (paths || '?') + ' 个路径都存在' : '无输出'))
}

// ⑥.15 退出码一致：打印 FAIL 的脚本必须返回非 0
{
  const res = tryRun('node', ['scripts/audit-exit-codes.mjs'], { timeout: 60000 })
  const line = (String(res.stdout || '').trim().split(String.fromCharCode(10)).pop() || '无输出')
  record('退出码一致', res.status === 0, line.replace(/^(PASS|FAIL) 退出码一致\s*/, ''))
}

// ⑥.2 模式差异文档（--fast 跳过哪些项，必须写清楚）
{
  const res = tryRun('node', ['scripts/render-preflight-modes.mjs', '--check'], { timeout: 60000 })
  const line = (String(res.stdout || '').trim().split(String.fromCharCode(10)).pop() || '无输出')
  record('模式差异文档', res.status === 0, line.replace(/^(PASS|FAIL) 模式差异文档\s*/, '').replace(/与清单一致/, '与清单一致'))
}

// ⑥.22 反向用例：最容易退化的五项，改坏了必须红
{
  const res = tryRun('node', ['scripts/regression-cases.mjs'], { timeout: 180000 })
  const out = String(res.stdout || '')
  const summary = (out.match(/PASS 反向用例 (\d+)\/(\d+) 项/) || [])
  const bad = out.split(String.fromCharCode(10)).filter((line) => line.startsWith('FAIL ') && line.includes('改坏'))
  record('反向用例', res.status === 0 && summary.length > 0,
    summary.length > 0 ? summary[1] + '/' + summary[2] + ' 项都能抓住退化' : (bad[0] || '无输出').replace(/^FAIL /, ''))
}

// ⑥.23 回归清单文档（与用例清单同步）
{
  const res = tryRun('node', ['scripts/render-regression-doc.mjs', '--check'], { timeout: 60000 })
  const line = (String(res.stdout || '').trim().split(String.fromCharCode(10)).pop() || '无输出')
  record('回归清单文档', res.status === 0, line.replace(/^(PASS|FAIL) 回归清单与(用例)?(清单)?一致?/g, '与用例一致').trim() || '与用例一致')
}

// ⑥.25 整句文案不该重复（复制粘贴后改一处忘另一处）
{
  const res = tryRun('node', ['scripts/audit-duplicate-copy.mjs'], { timeout: 60000 })
  const out = String(res.stdout || '')
  const first = out.trim().split(String.fromCharCode(10))[0] || '无输出'
  record('整句文案不重复', res.status === 0 && /重复 0 处/.test(out), first)
}

// ⑥.3 README 的说法要和代码常量对得上
{
  const res = tryRun('node', ['scripts/verify-readme-claims.mjs'], { timeout: 60000 })
  const out = String(res.stdout || '')
  const bad = out.split(String.fromCharCode(10)).filter((line) => line.startsWith('FAIL ') && line.includes('：'))
  record('README 与代码一致', res.status === 0, bad.length > 0 ? bad[0].replace(/^FAIL /, '') : '8 组说法都对得上')
}

// ⑥.4 面板请求体积（/state @ 20 条守，现实上限 ≤ 50 KB）
{
  const res = tryRun('node', ['scripts/measure-state.mjs', '20'], { timeout: 60000 })
  const out = String(res.stdout || '').trim().split(String.fromCharCode(10))
  const last = out[out.length - 1] || '无输出'
  record('面板请求体积', res.status === 0, last.replace(/^(PASS|FAIL)\s*/, ''))
}

// ⑥.45 长跑体积：20 条守跑 30 天的状态文件要 ≤ 200 KB
{
  const res = tryRun('node', ['scripts/measure-growth.mjs', '30'], { timeout: 180000 })
  const out = String(res.stdout || '').trim().split(String.fromCharCode(10))
  const last = out[out.length - 1] || '无输出'
  record('长跑体积', res.status === 0, last.replace(/^(PASS|FAIL)\s*/, ''))
}

// ⑥.5 双主题预览能渲染（独立脚本，注入验证也能单独跑）
{
  const res = tryRun('node', ['scripts/audit-preview.mjs'], { timeout: 120000 })
  const line = (String(res.stdout || '').trim().split(String.fromCharCode(10))[0] || '无输出')
  record('双主题预览可渲染', res.status === 0, line.replace(/^(PASS|FAIL) 双主题预览可渲染\s*/, ''))
}

// ⑥.65 工具描述里的承诺要在对账表里有一行
{
  const res = tryRun('node', ['scripts/audit-promises.mjs'], { timeout: 60000 })
  const out = String(res.stdout || '')
  const miss = out.split(String.fromCharCode(10)).filter((line) => line.startsWith('FAIL 对账表缺'))
  record('工具承诺对照', res.status === 0, miss.length > 0 ? miss[0].replace(/^FAIL /, '') : '5 条承诺都有对应行')
}

// ⑥.6 术语表双向对照（面板用了的必须解释；术语表里的不能是死词）
{
  const res = tryRun('node', ['scripts/audit-glossary.mjs'], { timeout: 90000 })
  const out = String(res.stdout || '')
  const bad = out.split(String.fromCharCode(10)).filter((line) => line.startsWith('  ') && line.trim())
  // 审核 T25 FN-1：以前看的是字符串「PASS 术语表的每个词」，而那句现在是报告项（死词不红）。
  // 真正的判据是**脚本自己的退出码**（术语表为空 / 有词没解释都会 exit 1）。
  record('术语表对照', res.status === 0,
    bad.length > 0 ? '待补：' + bad.map((l) => l.trim()).join(' / ') : '双向对齐（15 条术语）')
}

// ⑦ UI 体检（不需要宿主：量的是源码里的可访问性与 token 使用）
{
  const res = tryRun('node', ['scripts/ui-audit.mjs', '--json'])
  let score = 0
  let failed = []
  try {
    const data = JSON.parse(String(res.stdout || '{}'))
    score = data.score || 0
    failed = (data.results || []).filter((r) => !r.ok).map((r) => r.name)
  } catch { failed = ['ui-audit 输出无法解析'] }
  record('UI 体检', res.status === 0 && score === 100,
    `${score} 分` + (failed.length ? '（未过：' + failed.join('；') + '）' : ''))
}

// ⑧ 冒烟（需要 gh；不可用则 SKIP，不算失败）
if (FAST) {
  console.log('SKIP 冒烟 smoke:observe              --fast 跳过')
} else {
  const ghOk = tryRun('gh', ['auth', 'status']).status === 0
  if (!ghOk) {
    console.log('SKIP 冒烟 smoke:observe              gh 未登录')
  } else {
    const res = tryRun('node', ['scripts/smoke-observe.mjs'], { timeout: 180000 })
    const out = String(res.stdout || '')
    if (out.startsWith('SKIP')) {
      console.log('SKIP 冒烟 smoke:observe              需要真机宿主（已列进攒批清单）')
    } else {
    const okCount = (out.match(/^OK /gm) || []).length
    const badCount = (out.match(/^FAIL /gm) || []).length
    record('冒烟 smoke:observe', res.status === 0 && badCount === 0, `${okCount} 项 OK / ${badCount} 项 FAIL`)
    }
  }
}

// ⑨ 维护一致性（版本 / tag / CHANGELOG / 徽章 是否真的对齐）
//    本地化自 magpie-plugin-scaffold 的 check-maintenance：六条都不报错也都不崩，
//    但任何一条不满足，用户拿到的就是旧版。
if (SKIP_MAINTENANCE) {
  console.log('SKIP 维护一致性                        --no-maintenance 跳过（PR 分支还没打 tag）')
} else {
  const res = tryRun('node', ['scripts/check-maintenance.mjs'])
  const out = String(res.stdout || '')
  const bad = out.split(String.fromCharCode(10)).filter((line) => line.startsWith('FAIL ')).map((l) => l.slice(5).split('  ')[0])
  record('维护一致性', res.status === 0, res.status === 0 ? '版本/tag/CHANGELOG/徽章 对齐' : '不一致：' + bad.join('；'))
}

const failures = rows.filter((r) => !r.ok)
// 最慢的 3 项：下次优化先从这里挑
{
  const slowest = rows.filter((row) => typeof row.ms === 'number').sort((a, b) => b.ms - a.ms).slice(0, 3)
  if (slowest.length > 0) {
    console.log('最慢：' + slowest.map((row) => row.name + ' ' + (row.ms / 1000).toFixed(1) + 's').join(' / '))
  }
}
console.log('---')
const skipped = rows.filter((row) => row.ok === 'skip')
console.log(
  failures.length > 0
    ? `${failures.length} 项失败`
    : skipped.length > 0
      ? `通过 ${rows.length - skipped.length} 项，跳过 ${skipped.length} 项（跳过的没跑，不算通过）`
      : `全部通过（${rows.length} 项检查）`,
)
if (failures.length > 0) process.exit(1)
} // IS_MAIN 结束：import 本文件（test/sync-profile-drift.test.mjs 只用 summarizeProfileCheck）不跑门禁
