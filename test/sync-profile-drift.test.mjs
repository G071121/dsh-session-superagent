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
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, existsSync, linkSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
// preflight 的 profile 行解析（纯函数）：第四段「门禁子包漂移」的 clean / drift 文案由本文件钉住。
// 本文件是 CLI 也是模块：import 时只导出纯函数，不会真的跑整轮门禁（主体包在 IS_MAIN 里）。
import { summarizeProfileCheck } from '../scripts/preflight.mjs'

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
  const copy = join(ROOT, '.tmp-s1-targets-copy-' + process.pid)
  const copyDest = join(copy, '.tmp-dest')
  const script = join(copy, 'scripts', 'sync-profile.mjs')
  try {
    rmSync(copy, { recursive: true, force: true })
    // 最小可运行副本：脚本 + 清单里的文件 + 门禁子包（**不**复制 test/docs，免得被 node --test 再扫一遍）
    mkdirSync(join(copy, 'scripts'), { recursive: true })
    cpSync(SCRIPT, script)
    for (const rel of scriptTargets()) {
      mkdirSync(dirname(join(copy, rel)), { recursive: true })
      cpSync(join(ROOT, rel), join(copy, rel))
    }
    cpSync(GATE_SRC, join(copy, 'packages', 'dsh-gate'), { recursive: true })

    mkdirSync(copyDest, { recursive: true })
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
    '缺失 0 / 断链 0 / 陈旧 0 / TARGETS 缺源 1（bin/check.mjs），清单条目不成立（--repair 修不了）')
})
