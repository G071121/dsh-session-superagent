// 门禁子包漂移必须被 sync-profile 抓住（0.10.8 修复 F8 假绿）。
//
// 现场还原：C1 改了 packages/dsh-gate/lib/index.js、版本没 bump → 两份 package.json 逐字节相同。
// 旧脚本只比 package.json，于是 --check 报「缺失 0 / 断链 0 / 陈旧 0」、exit 0（假绿），
// --repair 也不替换，profile 里跑的还是旧实现。
//
// DEST 必须与仓库同卷：主插件文件用硬链接才能做到 inode 相同（脚本用 inode 判「已同步」），
// 跨卷硬链接会 EXDEV，所以这里不用 os.tmpdir()。
import assert from 'node:assert/strict'
import test, { after } from 'node:test'
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, existsSync, linkSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
// preflight 的 profile 行解析（纯函数）：第四段「门禁子包漂移」的 clean / drift 文案由本文件钉住。
// 本文件是 CLI 也是模块：import 时只导出纯函数，不会真的跑整轮门禁（主体包在 IS_MAIN 里）。
// S1 v5：主入口判定（resolveIsMain）也导出成纯函数 —— 直接执行与 import 必须用同一套判断，
// 且回退分支不许静默 exit 0（v4 审查 F8）。
import { IS_MAIN, resolveIsMain, summarizeProfileCheck } from '../scripts/preflight.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SCRIPT = join(ROOT, 'scripts', 'sync-profile.mjs')
const GATE_SRC = join(ROOT, 'packages', 'dsh-gate')
const GATE_REL = 'node_modules/@mycf711/dsh-gate'
const DEST = join(dirname(ROOT), '.tmp-sync-profile-drift-' + process.pid)
after(() => rmSync(DEST, { recursive: true, force: true }))

/** 从脚本里读 TARGETS：测试与实现不各维护一份清单（少一处会漂的地方）。 */
function scriptTargets() {
  const text = readFileSync(SCRIPT, 'utf8')
  const start = text.indexOf('const TARGETS = [')
  const block = text.slice(start + 'const TARGETS = ['.length)
  return [...block.slice(0, block.indexOf(']')).matchAll(/'([^']+)'/g)].map((match) => match[1])
}

function buildDest({ staleGate = false, root = ROOT, dest = DEST } = {}) {
  rmSync(dest, { recursive: true, force: true })
  for (const rel of scriptTargets()) {
    const dst = join(dest, rel)
    mkdirSync(dirname(dst), { recursive: true })
    linkSync(join(root, rel), dst)
  }
  const gateDst = join(dest, GATE_REL)
  mkdirSync(dirname(gateDst), { recursive: true })
  cpSync(join(root, 'packages', 'dsh-gate'), gateDst, { recursive: true })
  if (staleGate) {
    const lib = join(gateDst, 'lib', 'index.js')
    writeFileSync(lib, readFileSync(lib, 'utf8') + '\n// stale profile copy（模拟 profile 里还是旧实现）\n')
  }
}

/** 跑任意一份 sync-profile（仓库里的或副本里的），失败也把 stdout/stderr 带回来。 */
function runScript(script, ...args) {
  try {
    return { code: 0, out: execFileSync(process.execPath, [script, ...args], { cwd: ROOT, encoding: 'utf8' }) }
  } catch (error) {
    return {
      code: typeof error.status === 'number' ? error.status : 1,
      out: String(error.stdout || '') + String(error.stderr || ''),
    }
  }
}

const runSync = (...args) => runScript(SCRIPT, ...args)

const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex')

/** 递归列出目录下的文件（相对路径，`/` 分隔）。 */
function listFiles(root, rel = '', out = []) {
  for (const name of readdirSync(join(root, rel))) {
    const childRel = rel ? rel + '/' + name : name
    if (statSync(join(root, childRel)).isDirectory()) { listFiles(root, childRel, out); continue }
    out.push(childRel)
  }
  return out
}

/** 目录快照：相对路径 → sha256。用来证明「写盘前失败」时一处都没动。 */
function snapshot(root) {
  const out = new Map()
  for (const rel of listFiles(root)) out.set(rel, sha256(join(root, rel)))
  return out
}

/**
 * 在仓库同卷建最小可运行副本：`scripts/sync-profile.mjs` + TARGETS 指向的文件 + 门禁子包。
 * 不复制 test/ docs/（免得被 `node --test` 再扫一遍）。调用方负责 rmSync 清理。
 */
function makeRepoCopy(prefix, { withGate = true } = {}) {
  const copy = join(ROOT, '.tmp-' + prefix + '-' + process.pid)
  const dest = join(copy, '.tmp-dest')
  rmSync(copy, { recursive: true, force: true })
  mkdirSync(join(copy, 'scripts'), { recursive: true })
  cpSync(SCRIPT, join(copy, 'scripts', 'sync-profile.mjs'))
  for (const rel of scriptTargets()) {
    mkdirSync(dirname(join(copy, rel)), { recursive: true })
    cpSync(join(ROOT, rel), join(copy, rel))
  }
  if (withGate) cpSync(GATE_SRC, join(copy, 'packages', 'dsh-gate'), { recursive: true })
  mkdirSync(dest, { recursive: true })
  return { copy, dest, script: join(copy, 'scripts', 'sync-profile.mjs') }
}

test('门禁子包 lib 变了、package.json 没变：--check 必须红（旧脚本在这里是假绿）', () => {
  buildDest({ staleGate: true })
  // 假绿的前提就是这两行：package.json 一样、lib 不一样 → 只比 package.json 必然放行
  assert.equal(sha256(join(GATE_SRC, 'package.json')), sha256(join(DEST, GATE_REL, 'package.json')))
  assert.notEqual(sha256(join(GATE_SRC, 'lib', 'index.js')), sha256(join(DEST, GATE_REL, 'lib', 'index.js')))
  const res = runSync('--check', '--dir', DEST)
  assert.equal(res.code, 1, '有漂移必须 exit 1：' + res.out)
  // 陈旧仍为 0：漂移只记在第四段（S1 撤掉了「并入陈旧」的垫片 —— preflight 已解析第四段）
  assert.match(res.out, /缺失 0 \/ 断链 0 \/ 陈旧 0 \/ 门禁子包漂移 1/)
  assert.match(res.out, /内容与 packages\/dsh-gate 不一致：lib\/index\.js/)
})

test('--repair 强制同步后 --check 全零，且门禁子包逐文件 hash 一致', () => {
  buildDest({ staleGate: true })
  const repaired = runSync('--repair', '--dir', DEST)
  assert.equal(repaired.code, 0)
  assert.match(repaired.out, /recopied node_modules\/@mycf711\/dsh-gate/)
  const check = runSync('--check', '--dir', DEST)
  assert.equal(check.code, 0, '修完必须全绿：' + check.out)
  assert.match(check.out, /缺失 0 \/ 断链 0 \/ 陈旧 0 \/ 门禁子包漂移 0/)
  for (const rel of ['package.json', 'lib/index.js', 'bin/gate.mjs']) {
    assert.equal(sha256(join(GATE_SRC, rel)), sha256(join(DEST, GATE_REL, rel)), rel + ' 必须与仓库逐字节一致')
  }
})

test('门禁子包的 test/ 与 README 改动不算漂移（只比运行时文件，别为开发件反复重拷）', () => {
  buildDest()
  writeFileSync(join(DEST, GATE_REL, 'README.md'), '# 本地临时说明\n')
  const anyTest = join(DEST, GATE_REL, 'test', 'cli.test.mjs')
  if (existsSync(anyTest)) writeFileSync(anyTest, readFileSync(anyTest, 'utf8') + '\n// local note\n')
  const res = runSync('--check', '--dir', DEST)
  assert.equal(res.code, 0, '运行时文件一致就不该报漂移：' + res.out)
  assert.match(res.out, /门禁子包漂移 0/)
})

test('只改 gates/default.json 也必须报漂移（Q1R-M1：默认规则是运行时行为）', () => {
  // `packages/dsh-gate/lib/index.js` 的 DEFAULT_GATE_PATH 指向 gates/default.json：
  // 只换默认规则 = 行为变了、profile 没变。漏掉它，假绿就换个文件重演一遍。
  buildDest()
  const defaultRule = join(DEST, GATE_REL, 'gates', 'default.json')
  assert.equal(existsSync(defaultRule), true, '门禁子包必须有运行时默认规则 gates/default.json')
  writeFileSync(defaultRule, readFileSync(defaultRule, 'utf8').replace('{', '{\n'))
  const res = runSync('--check', '--dir', DEST)
  assert.equal(res.code, 1, '默认规则改了必须红：' + res.out)
  assert.match(res.out, /内容与 packages\/dsh-gate 不一致：gates\/default\.json/)
  assert.match(res.out, /门禁子包漂移 1/)
  const repaired = runSync('--repair', '--dir', DEST)
  assert.equal(repaired.code, 0)
  assert.equal(sha256(join(GATE_SRC, 'gates', 'default.json')), sha256(defaultRule), '--repair 后默认规则要逐字节一致')
})

// ── TARGETS 防漏（S1）───────────────────────────────────────────────────────
// 事故 1 的复发形态（2026-11-01）：新增 lib/body.js 没进 TARGETS → profile 缺文件 → 插件整体不挂载。
// 更隐蔽的同款：装完自检 `bin/check.mjs`（T35）和宿主直接读的 `assets/icon-*.png` 一直没进 TARGETS，
// 而 `--check` 照样打印「缺失 0 / 断链 0 / 陈旧 0」—— 改了不同步、不同步也不报，等于没有门禁。
// 所以清单不能只靠人眼维护：下面从**发布契约**派生「必须在 TARGETS 里」的运行时文件，
// 多一个漏加就红；同时反向守住「不把 test/ docs/ 塞进安装副本」。
const walkFiles = (root, rel, out) => {
  for (const name of readdirSync(join(root, rel))) {
    const childRel = rel + '/' + name
    if (statSync(join(root, childRel)).isDirectory()) { walkFiles(root, childRel, out); continue }
    out.push(childRel)
  }
}

/** 从 package.json 派生运行时文件：lib 递归 + 随包发布的非文档件 + exports / bin / cordis patch。 */
function derivedRuntimeFiles(root = ROOT) {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  const out = new Set(['package.json'])
  const addTree = (rel) => {
    if (!existsSync(join(root, rel))) return
    if (!statSync(join(root, rel)).isDirectory()) { out.add(rel); return }
    const found = []
    walkFiles(root, rel, found)
    for (const file of found) out.add(file)
  }
  // lib/ 递归：新增一个 .js 就算运行时文件，哪怕还没进 package.json.files（那是另一条门禁在管）
  addTree('lib')
  // 随包发布且不是文档的：新增的根级运行时文件（client.js / ui-*.js / bin / assets 之类）都会在这里出现。
  // 故意**不**收 docs/ 和 *.md —— 文档不该同步进安装副本（任务书：不扩大打包范围）。
  for (const entry of pkg.files || []) {
    if (entry.startsWith('docs/') || entry.endsWith('.md')) continue
    addTree(entry.replace(/\/$/, ''))
  }
  const bare = (target) => String(target).replace(/^\.\//, '')
  for (const target of Object.values(pkg.exports || {})) if (typeof target === 'string') out.add(bare(target))
  for (const target of Object.values(pkg.bin || {})) out.add(bare(target))
  if (pkg.dsh && pkg.dsh.bundle && pkg.dsh.bundle.patch) out.add(bare(pkg.dsh.bundle.patch))
  return [...out].sort()
}

test('TARGETS 必须覆盖全部运行时文件，且不把 test/ docs/ 塞进安装副本', () => {
  const listed = new Set(scriptTargets())
  const missing = derivedRuntimeFiles().filter((rel) => !listed.has(rel))
  assert.deepEqual(missing, [],
    '这些运行时文件没进 TARGETS：改了会同步不到 profile，而 --check 仍全零（新增运行时文件必须加清单）：' + missing.join(', '))

  // 反向：清单里不许出现开发件 —— 否则 profile 会多出测试和文档（也不该靠递归目录把它带进来）
  const dev = scriptTargets().filter((rel) => /^(test|docs|scripts|packages)\//.test(rel))
  assert.deepEqual(dev, [], 'TARGETS 不该包含开发件（test/ docs/ scripts/ packages/）：' + dev.join(', '))

  // 只有随包发布的文件才可能出现在 profile 里：清单里写了没发布的东西，npm 安装出来的副本照样缺
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
  const published = pkg.files || []
  const notPublished = scriptTargets().filter((rel) => rel !== 'package.json'
    && !published.some((entry) => entry.endsWith('/') ? rel.startsWith(entry) : entry === rel))
  assert.deepEqual(notPublished, [], '这些文件没随包发布，npm 装出来的 profile 会没有它们：' + notPublished.join(', '))
})

// ── TARGETS 反向守卫（S1）───────────────────────────────────────────────────
// 事故 1 的另一种复发形态：清单条目还在、**文件被删了**。
// 旧实现在循环里 `if (!existsSync(src)) continue` 静默跳过 —— `--check` 照样「缺失 0 / 断链 0 / 陈旧 0」
// exit 0（假绿），派生用例（仓库 → 清单方向）也全绿。2026-11-08 在仓库副本里删掉 bin/check.mjs 实测过。

test('TARGETS 每一条都必须真的在仓库里（清单条目和文件对不上就点名）', () => {
  const absent = scriptTargets().filter((rel) => !existsSync(join(ROOT, rel)))
  assert.deepEqual(absent, [],
    '这些 TARGETS 条目在仓库里不存在：--check 拿不到源文件（旧实现静默跳过 → 假绿）；恢复文件，或把它们从 TARGETS 删掉：' + absent.join(', '))
})

test('仓库副本里删掉一条 TARGETS：--check 红（退出码 2）并点名，旧实现这里是 exit 0', () => {
  const { copy, dest: copyDest, script } = makeRepoCopy('s1-targets-copy')
  try {
    assert.equal(runScript(script, '--repair', '--dir', copyDest).code, 0, '副本先要能建出干净 profile')

    // 删掉一条清单条目指向的文件：dest 里的硬链接还在（inode 还活着），所以「缺失」仍然是 0
    rmSync(join(copy, 'bin', 'check.mjs'))
    const res = runScript(script, '--check', '--dir', copyDest)
    assert.equal(res.code, 2, '清单条目在仓库里不存在必须红（2 = 仓库侧问题，--repair 修不了）：' + res.out)
    assert.match(res.out, /缺源\s+bin\/check\.mjs/, '必须点名是哪一条：' + res.out)
    assert.match(res.out, /缺失 0 \/ 断链 0 \/ 陈旧 0 \/ 门禁子包漂移 0 \/ TARGETS 缺源 1（bin\/check\.mjs）/)

    // 旧假绿的另一半：派生规则只看「仓库 → 清单」，这时**仍然成立** —— 所以必须有上面的存在性守卫
    const listed = new Set(scriptTargets())
    assert.deepEqual(derivedRuntimeFiles(copy).filter((rel) => !listed.has(rel)), [],
      '派生方向在缺文件时不会报，这就是旧实现的全绿形状')

    // --repair 也不许假装修好（文件不会自己回来）
    const repaired = runScript(script, '--repair', '--dir', copyDest)
    assert.equal(repaired.code, 2, '--repair 也不行：' + repaired.out)
    assert.match(repaired.out, /TARGETS 有 1 条在仓库里不存在/)
  } finally {
    rmSync(copy, { recursive: true, force: true })
  }
})

// ── preflight 第四段（门禁子包漂移）：clean / drift 两类仓库内用例 ────────────────
// v3 审查 R4：这一行一直只有人工实跑与 V1 复核 —— 把第四段解析删掉（0.10.8 假绿的形状）测试也全绿。
// 现在把 preflight 的解析（scripts/preflight.mjs 的 summarizeProfileCheck，单一事实来源）钉在
// clean / drift 两份**真跑输出** + 一份老格式上：clean 不许加第四段噪音，drift 必须点名。

test('preflight 第四段 clean：真跑 --check 的解析结果是「干净且不加第四段噪音」', () => {
  buildDest()
  const res = runSync('--check', '--dir', DEST)
  assert.equal(res.code, 0, '干净 profile 必须 exit 0：' + res.out)
  const summary = summarizeProfileCheck(res.out)
  assert.equal(summary.clean, true)
  assert.equal(summary.drifted, 0)
  assert.equal(summary.gateDrift, 0)
  assert.equal(summary.detail, '缺失 0 / 断链 0 / 陈旧 0', '全绿时只该看到三个数（第四段只在漂移时出现）')
  // clean 无噪音（S1 v6）：第五段起只在非零时出现，干净时汇总行必须**只有**四段，
  // 也不许打印任何「缺源 / import 失败」明细。
  const summaryLine = (res.out.match(/^缺失 \d+ \/ 断链 \d+ \/ 陈旧 \d+ \/ 门禁子包漂移 \d+.*$/m) || [''])[0]
  assert.equal(summaryLine, '缺失 0 / 断链 0 / 陈旧 0 / 门禁子包漂移 0', '干净时汇总行只该有四段（clean 无噪音）')
  assert.doesNotMatch(res.out, /缺源|import   /, '干净时不该出现缺源 / import 明细：' + res.out)
})

test('preflight 第四段 drift：真跑 --check 的解析结果必须 FAIL 并点名不一致的文件', () => {
  buildDest({ staleGate: true })
  const res = runSync('--check', '--dir', DEST)
  assert.equal(res.code, 1, '有漂移必须 exit 1：' + res.out)
  const summary = summarizeProfileCheck(res.out)
  assert.equal(summary.clean, false, '第四段非零不能算干净（这正是 0.10.8 假绿）')
  assert.equal(summary.gateDrift, 1)
  assert.match(String(summary.changed), /^lib\/index\.js$/, '必须点名到文件：' + summary.changed)
  assert.equal(summary.detail,
    '缺失 0 / 断链 0 / 陈旧 0 / 门禁子包漂移 1（lib/index.js），跑 node scripts/sync-profile.mjs --repair')
})

test('preflight 第四段：老格式（只有三段）读不出漂移，必须按不干净处理', () => {
  const summary = summarizeProfileCheck('缺失 0 / 断链 2 / 陈旧 0' + String.fromCharCode(10) + '相对 import 全部可解析 ✓')
  assert.equal(summary.clean, false, '看不到第四段就证明不了门禁子包不漂移')
  assert.equal(summary.detail, '缺失 0 / 断链 2 / 陈旧 0')
})

test('preflight 第五段 TARGETS 缺源：必须解析、点名，且不算干净', () => {
  const out = '缺源     bin/check.mjs（仓库里没有这个文件：恢复它，或把这一行从 TARGETS 删掉）'
    + String.fromCharCode(10) + '缺失 0 / 断链 0 / 陈旧 0 / 门禁子包漂移 0 / TARGETS 缺源 1（bin/check.mjs）'
  const summary = summarizeProfileCheck(out)
  assert.equal(summary.clean, false)
  assert.equal(summary.manifest, 1)
  assert.equal(summary.detail,
    '缺失 0 / 断链 0 / 陈旧 0 / TARGETS 缺源 1（bin/check.mjs），仓库侧问题（--repair 修不了）')
})

// ── S1 v6：第五段按类别分开（v5 Q1 L3）────────────────────────────────────
// 以前 `TARGETS 缺源 N` 里同时收 `packages/dsh-gate`（整目录缺失）—— 它不是 TARGETS 条目，
// 汇总行会让人以为清单里写了它。现在三类仓库侧缺源各自成段，preflight 分开解析、分开点名。
test('preflight 第五段：lib 目录缺失 / 门禁子包源缺失 / 相对 import 缺失各自成段，都不算干净', () => {
  const base = '缺失 0 / 断链 0 / 陈旧 0 / 门禁子包漂移 0'

  const libDir = summarizeProfileCheck('缺源     lib/（仓库里没有整个 lib 目录：恢复它，--repair 修不了）'
    + String.fromCharCode(10) + base + ' / lib 目录缺失 1（lib）')
  assert.equal(libDir.clean, false)
  assert.equal(libDir.libDirMissing, 1)
  assert.equal(libDir.manifest, 0, 'lib 不是 TARGETS 条目（v5 Q1 L3）')
  assert.equal(libDir.detail, '缺失 0 / 断链 0 / 陈旧 0 / lib 目录缺失 1（lib），仓库侧问题（--repair 修不了）')

  const gate = summarizeProfileCheck(base + ' / 门禁子包源缺失 1（packages/dsh-gate）')
  assert.equal(gate.clean, false)
  assert.equal(gate.gateSourceMissing, 1)
  assert.equal(gate.manifest, 0, 'packages/dsh-gate 不是 TARGETS 条目（v5 Q1 L3）')
  assert.equal(gate.detail, '缺失 0 / 断链 0 / 陈旧 0 / 门禁子包源缺失 1（packages/dsh-gate），仓库侧问题（--repair 修不了）')

  const imports = summarizeProfileCheck(base + ' / 相对 import 缺失 2（body.js -> ./a.js, index.js -> ./b.js）')
  assert.equal(imports.clean, false)
  assert.equal(imports.importMissing, 2)
  assert.equal(imports.detail,
    '缺失 0 / 断链 0 / 陈旧 0 / 相对 import 缺失 2（body.js -> ./a.js, index.js -> ./b.js），仓库侧问题（--repair 修不了）')

  // 四类同时出现：每一段都要解析出来（别只认第一段）
  const all = summarizeProfileCheck(base
    + ' / TARGETS 缺源 1（bin/check.mjs） / lib 目录缺失 1（lib）'
    + ' / 门禁子包源缺失 1（packages/dsh-gate） / 相对 import 缺失 1（body.js -> ./x.js）')
  assert.equal(all.clean, false)
  assert.equal(all.manifest, 1)
  assert.equal(all.libDirMissing, 1)
  assert.equal(all.gateSourceMissing, 1)
  assert.equal(all.importMissing, 1)
})

// ── S1 v5：缺源写盘前失败 / 门禁子包整目录缺失 / 主入口 ─────────────────────
// v4 审查 F6：缺源时 `--repair` 会先把能做的 relink / 子包复制 / 陈旧 prune 做完，再 exit 2。
// 缺的是 `lib/*.js` 时 profile 副本已经被当「陈旧」删掉 —— 修不了却改了磁盘，是最坏的失败方式
// （用户以为只是报错，实际 profile 已经被改了一半）。所以仓库侧问题必须在**任何写盘之前**判红。

test('TARGETS 缺源：--check / --repair 都必须在任何写盘之前失败（不先 relink / 复制 / prune）', () => {
  const { copy, dest, script } = makeRepoCopy('s1-repair-atomic')
  try {
    assert.equal(runScript(script, '--repair', '--dir', dest).code, 0, '副本先要能建出干净 profile')
    // 制造三类「--repair 本来会动磁盘」的漂移：断链 / 陈旧 / 门禁子包内容不一致
    rmSync(join(dest, 'lib', 'body.js'))
    writeFileSync(join(dest, 'lib', 'body.js'), readFileSync(join(copy, 'lib', 'body.js')))
    writeFileSync(join(dest, 'lib', 'zzz-stale.js'), '// 仓库已删除的陈旧文件\n')
    const gateIndex = join(dest, GATE_REL, 'lib', 'index.js')
    writeFileSync(gateIndex, readFileSync(gateIndex, 'utf8') + '\n// stale gate copy（profile 里还是旧实现）\n')
    const before = snapshot(dest)

    // 仓库侧删掉一条 TARGETS：--repair 变不出文件来，就必须在写盘前红
    rmSync(join(copy, 'assets', 'icon-180.png'))
    const check = runScript(script, '--check', '--dir', dest)
    assert.equal(check.code, 2, '缺源是仓库侧问题（2）：' + check.out)
    assert.match(check.out, /缺源\s+assets\/icon-180\.png/, '必须点名是哪一条：' + check.out)
    assert.match(check.out, /TARGETS 缺源 1（assets\/icon-180\.png）/, '汇总行要算进第五段：' + check.out)
    assert.deepEqual(snapshot(dest), before, '--check 不该写盘')

    const repaired = runScript(script, '--repair', '--dir', dest)
    assert.equal(repaired.code, 2, '--repair 也修不了缺源（2）：' + repaired.out)
    assert.match(repaired.out, /TARGETS 有 1 条在仓库里不存在：assets\/icon-180\.png/)
    assert.doesNotMatch(repaired.out, /relinked|pruned|recopied/, '缺源时 --repair 不该先改一半磁盘：' + repaired.out)
    assert.deepEqual(snapshot(dest), before, '缺源时 --repair 改了 profile（必须在写盘前失败）')
  } finally {
    rmSync(copy, { recursive: true, force: true })
  }
})

// v4 审查 F7：`packages/dsh-gate` 整个目录在仓库里缺失时，旧实现 `if (existsSync(gateSrc))` 静默跳过 ——
// profile 检查可能仍然「四段全零」，门禁子包根本没人管。这也是仓库侧问题：--repair 修不了，必须点名 + exit 2。
test('门禁子包整个目录在仓库里缺失：--check / --repair 都点名并 exit 2（旧实现静默跳过）', () => {
  const { copy, dest, script } = makeRepoCopy('s1-gate-src-missing')
  try {
    assert.equal(runScript(script, '--repair', '--dir', dest).code, 0, '副本先要能建出干净 profile')
    rmSync(join(copy, 'packages', 'dsh-gate'), { recursive: true, force: true })
    const before = snapshot(dest)

    const check = runScript(script, '--check', '--dir', dest)
    assert.equal(check.code, 2, '门禁子包源目录缺失必须红（旧实现 exit 0）：' + check.out)
    assert.match(check.out, /缺源\s+packages\/dsh-gate/, '必须点名缺的是门禁子包目录：' + check.out)
    assert.match(check.out, /门禁子包源缺失 1（packages\/dsh-gate）/, '第五段要按类别分开点名（v5 Q1 L3）')
    assert.doesNotMatch(check.out, /TARGETS 缺源 1（packages\/dsh-gate）/,
      'packages/dsh-gate 不是 TARGETS 条目，不能算进「TARGETS 缺源」')
    assert.doesNotMatch(check.out, /缺失 0 \/ 断链 0 \/ 陈旧 0 \/ 门禁子包漂移 0$/m,
      '旧假绿：四段全零却没有门禁子包')

    const repaired = runScript(script, '--repair', '--dir', dest)
    assert.equal(repaired.code, 2, '--repair 修不了缺源：' + repaired.out)
    assert.deepEqual(snapshot(dest), before, '缺源时 --repair 不该写盘')
  } finally {
    rmSync(copy, { recursive: true, force: true })
  }
})

// profile 侧相反方向：`node_modules/@mycf711/dsh-gate` 整个目录没装 —— 这一条 --repair **能**修（递归复制）。
// 旧实现在 --check 里只让「缺失」+1，不点名；用户看到「缺失 1」不知道缺的是哪个。
test('profile 里门禁子包整个目录缺失：--check 点名（缺失 1），--repair 递归复制修复', () => {
  buildDest()
  const gateDst = join(DEST, GATE_REL)
  rmSync(gateDst, { recursive: true, force: true })

  const check = runSync('--check', '--dir', DEST)
  assert.equal(check.code, 1, 'profile 缺门禁子包必须红：' + check.out)
  assert.match(check.out, /缺失\s+node_modules\/@mycf711\/dsh-gate/, '必须点名缺的是门禁子包目录：' + check.out)
  assert.match(check.out, /缺失 1 \/ 断链 0 \/ 陈旧 0 \/ 门禁子包漂移 0/)

  const repaired = runSync('--repair', '--dir', DEST)
  assert.equal(repaired.code, 0, repaired.out)
  assert.match(repaired.out, /copied\s+node_modules\/@mycf711\/dsh-gate/)
  const clean = runSync('--check', '--dir', DEST)
  assert.equal(clean.code, 0, '修完必须全绿：' + clean.out)
  assert.match(clean.out, /缺失 0 \/ 断链 0 \/ 陈旧 0 \/ 门禁子包漂移 0/)
  for (const rel of ['package.json', 'lib/index.js', 'bin/gate.mjs']) {
    assert.equal(sha256(join(GATE_SRC, rel)), sha256(join(gateDst, rel)), rel + ' 必须与仓库逐字节一致')
  }
})

// ── S1 v6：相对 import 写前失败 / 整个 lib 目录缺失（v5 Q1 L1-L2）──────────────
// Q1 L1 实测（探针 4）：旧实现先 `relinked lib/body.js`、`pruned lib/zzz-stale.js` 再
// `相对 import 解析失败` + exit 2 —— 原子性只覆盖 `repoMissing`，第三种仓库侧错误仍会改盘。
// 现在 `missingImports` 计算前移到任何写盘之前，和缺源一起决定 `REPO_BLOCKED`。
test('相对 import 缺失：--check / --repair 都必须在任何写盘之前失败（旧实现先 relink / prune 再 exit 2）', () => {
  const { copy, dest, script } = makeRepoCopy('s1-import-missing')
  try {
    assert.equal(runScript(script, '--repair', '--dir', dest).code, 0, '副本先要能建出干净 profile')
    // 制造三类「--repair 本来会动磁盘」的漂移：断链 / 陈旧 / 门禁子包内容不一致
    rmSync(join(dest, 'lib', 'body.js'))
    writeFileSync(join(dest, 'lib', 'body.js'), readFileSync(join(copy, 'lib', 'body.js')))
    writeFileSync(join(dest, 'lib', 'zzz-stale.js'), '// 仓库已删除的陈旧文件\n')
    const gateIndex = join(dest, GATE_REL, 'lib', 'index.js')
    writeFileSync(gateIndex, readFileSync(gateIndex, 'utf8') + '\n// stale gate copy（profile 里还是旧实现）\n')
    const before = snapshot(dest)

    // 仓库侧：lib/body.js 里多一条解析不到的相对 import
    writeFileSync(join(copy, 'lib', 'body.js'),
      readFileSync(join(copy, 'lib', 'body.js'), 'utf8') + "\nimport './definitely-missing-module.js'\n")

    const check = runScript(script, '--check', '--dir', dest)
    assert.equal(check.code, 2, '相对 import 缺失是仓库侧问题（2）：' + check.out)
    assert.match(check.out, /import\s+body\.js -> \.\/definitely-missing-module\.js/, '必须点名是哪条 import：' + check.out)
    assert.match(check.out, /相对 import 缺失 1（body\.js -> \.\/definitely-missing-module\.js）/, '汇总行要算进第五段：' + check.out)
    assert.deepEqual(snapshot(dest), before, '--check 不该写盘')

    const repaired = runScript(script, '--repair', '--dir', dest)
    assert.equal(repaired.code, 2, '--repair 修不了相对 import 缺失（2）：' + repaired.out)
    assert.match(repaired.out, /相对 import 解析失败：body\.js -> \.\/definitely-missing-module\.js/)
    assert.doesNotMatch(repaired.out, /relinked|pruned|recopied/, '缺 import 时 --repair 不该先改一半磁盘：' + repaired.out)
    assert.deepEqual(snapshot(dest), before, '缺 import 时 --repair 改了 profile（必须在写盘前失败）')
  } finally {
    rmSync(copy, { recursive: true, force: true })
  }
})

// Q1 L2：整个 `lib/` 目录缺失时，旧实现的 `readdirSync(libDir)` 先抛 `ENOENT` —— `--check`
// exit 1 + 栈（preflight 只能读到「(无输出)」），而不是「缺源 + exit 2 + 点名」。
test('整个 lib/ 目录在仓库里缺失：--check / --repair 都 exit 2 + 点名，不抛 ENOENT 栈', () => {
  const { copy, dest, script } = makeRepoCopy('s1-lib-dir-missing')
  try {
    assert.equal(runScript(script, '--repair', '--dir', dest).code, 0, '副本先要能建出干净 profile')
    const before = snapshot(dest)
    rmSync(join(copy, 'lib'), { recursive: true, force: true })

    const check = runScript(script, '--check', '--dir', dest)
    assert.equal(check.code, 2, '整个 lib 目录缺失是仓库侧问题（旧实现 exit 1 + ENOENT 栈）：' + check.out)
    assert.match(check.out, /缺源\s+lib\//, '必须点名整个 lib 目录：' + check.out)
    assert.match(check.out, /lib 目录缺失 1（lib）/, '汇总行要单独成段（不能算进 TARGETS 缺源）：' + check.out)
    assert.doesNotMatch(check.out, /缺源\s+lib\/index\.js/, '整个目录没了就别逐文件刷 10 行（同一个原因）：' + check.out)
    assert.doesNotMatch(check.out, /ENOENT/, '不许把 ENOENT 甩给用户：' + check.out)
    assert.doesNotMatch(check.out, /^\s+at .+sync-profile\.mjs:\d+/m, '不许抛栈：' + check.out)
    assert.deepEqual(snapshot(dest), before, '--check 不该写盘')

    const repaired = runScript(script, '--repair', '--dir', dest)
    assert.equal(repaired.code, 2, '--repair 也修不了缺源（2）：' + repaired.out)
    assert.match(repaired.out, /仓库里没有整个 lib 目录：lib/)
    assert.doesNotMatch(repaired.out, /relinked|pruned|recopied/, '缺源时 --repair 不该先改一半磁盘：' + repaired.out)
    assert.deepEqual(snapshot(dest), before, '缺源时 --repair 改了 profile（必须在写盘前失败）')
  } finally {
    rmSync(copy, { recursive: true, force: true })
  }
})

// profile 侧相反方向：整个 `lib/` 目录没装 —— 这一条 --repair **能**修（按 TARGETS 重建硬链接）。
// 旧实现在这里 `readdirSync(join(DEST, 'lib'))` 抛 ENOENT 栈（exit 1 + 崩），--check 永远红不了。
test('profile 里整个 lib/ 目录缺失：--check 点名并 exit 1（旧实现 readdirSync 抛 ENOENT 栈）', () => {
  buildDest()
  rmSync(join(DEST, 'lib'), { recursive: true, force: true })

  const check = runSync('--check', '--dir', DEST)
  assert.equal(check.code, 1, 'profile 缺整个 lib 目录（--repair 能修）：' + check.out)
  // 数量从 TARGETS 派生，不写死：新增一个 lib/ 模块就要改常量，这条用例会以「改清单的人没改这里」为由变红，
  // 而它真正要证明的是「整个 lib 目录下每一条都计入了缺失」。
  const libCount = scriptTargets().filter((rel) => rel.startsWith('lib/')).length
  assert.match(check.out, new RegExp('缺失 ' + libCount + ' \\/ 断链 0 \\/ 陈旧 0 \\/ 门禁子包漂移 0'), libCount + ' 个 lib 文件都要计入缺失：' + check.out)
  assert.match(check.out, /缺失\s+lib\/（profile 里没有整个 lib 目录/, '要点名缺的是整个目录：' + check.out)
  assert.doesNotMatch(check.out, /ENOENT/, '旧实现在这里 readdirSync 抛 ENOENT 栈：' + check.out)

  const repaired = runSync('--repair', '--dir', DEST)
  assert.equal(repaired.code, 0, repaired.out)
  const clean = runSync('--check', '--dir', DEST)
  assert.equal(clean.code, 0, '修完必须全绿：' + clean.out)
  assert.match(clean.out, /缺失 0 \/ 断链 0 \/ 陈旧 0 \/ 门禁子包漂移 0$/m)
})

// v4 审查 F8：preflight 的主入口判定以前是「import.meta.main 不存在 → 逐字符比 argv[1]」，
// 比对上不了就返回 false —— 整轮门禁**静默 exit 0**（无输出、无锁、CI 绿）。这比少跑一项更坏：它是假绿。
// 现在判定收口成纯函数 resolveIsMain：只有「两边都是确定的路径且确实不同」才算被 import。
const PREFLIGHT = join(ROOT, 'scripts', 'preflight.mjs')
const PREFLIGHT_URL = pathToFileURL(PREFLIGHT).href

test('preflight 主入口：import.meta.main 可用时以它为准（直接执行 / 被 import 一致）', () => {
  assert.equal(resolveIsMain({ mainFlag: true, moduleUrl: PREFLIGHT_URL, argv1: 'whatever.mjs' }), true)
  assert.equal(resolveIsMain({ mainFlag: false, moduleUrl: PREFLIGHT_URL, argv1: PREFLIGHT }), false)
  // 真模块被 import 时只导出纯函数（不跑门禁）—— 这是测试能 import 它的前提
  assert.equal(IS_MAIN, false, 'node --test 里 import preflight 必须判成「非入口」')
})

test('preflight 主入口回退：相对路径 / 大小写不同也算同一个入口（旧实现逐字符比较 → 静默 exit 0）', () => {
  const relativeEntry = relative(process.cwd(), PREFLIGHT)
  assert.equal(resolveIsMain({ mainFlag: undefined, moduleUrl: PREFLIGHT_URL, argv1: relativeEntry }), true,
    '相对路径直接执行必须当 CLI 跑（旧实现这里 false → 静默 exit 0）')
  if (process.platform === 'win32') {
    assert.equal(resolveIsMain({ mainFlag: undefined, moduleUrl: PREFLIGHT_URL, argv1: PREFLIGHT.toUpperCase() }), true,
      'Windows 大小写不同是同一个文件')
  }
  assert.equal(resolveIsMain({ mainFlag: undefined, moduleUrl: PREFLIGHT_URL, argv1: PREFLIGHT }), true)
})

test('preflight 主入口回退：比不出来时必须当 CLI 跑，不许静默 exit 0', () => {
  // 没有 argv[1]（node -e / REPL）：当 CLI
  assert.equal(resolveIsMain({ mainFlag: undefined, moduleUrl: PREFLIGHT_URL, argv1: undefined }), true)
  assert.equal(resolveIsMain({ mainFlag: undefined, moduleUrl: PREFLIGHT_URL, argv1: '' }), true)
  // 路径解析失败（文件不存在 / 权限）：当 CLI
  assert.equal(resolveIsMain({ mainFlag: undefined, moduleUrl: PREFLIGHT_URL, argv1: join(ROOT, 'no-such-entry.mjs') }), true)
  assert.equal(resolveIsMain({
    mainFlag: undefined, moduleUrl: PREFLIGHT_URL, argv1: PREFLIGHT,
    realpath: () => { throw new Error('EPERM: realpath 解析失败') },
  }), true)
  // 只有「确实是另一个真实文件」才判「被 import」
  assert.equal(resolveIsMain({ mainFlag: undefined, moduleUrl: PREFLIGHT_URL, argv1: SCRIPT }), false)
})

test('preflight 被 import 时不跑整轮门禁（子进程对照：只有自己的输出）', () => {
  const res = spawnSync(process.execPath,
    ['--input-type=module', '-e', `const m = await import(${JSON.stringify(PREFLIGHT_URL)}); console.log('IS_MAIN=' + m.IS_MAIN)`],
    { cwd: ROOT, encoding: 'utf8', timeout: 60000 })
  assert.equal(res.status, 0, String(res.stderr || ''))
  assert.equal(String(res.stdout || '').trim(), 'IS_MAIN=false', 'import 不该跑门禁（更不该静默 exit 0）')
})
