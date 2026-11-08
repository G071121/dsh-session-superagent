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
import { cpSync, existsSync, linkSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

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

function buildDest({ staleGate = false } = {}) {
  rmSync(DEST, { recursive: true, force: true })
  for (const rel of scriptTargets()) {
    const dst = join(DEST, rel)
    mkdirSync(dirname(dst), { recursive: true })
    linkSync(join(ROOT, rel), dst)
  }
  const gateDst = join(DEST, GATE_REL)
  mkdirSync(dirname(gateDst), { recursive: true })
  cpSync(GATE_SRC, gateDst, { recursive: true })
  if (staleGate) {
    const lib = join(gateDst, 'lib', 'index.js')
    writeFileSync(lib, readFileSync(lib, 'utf8') + '\n// stale profile copy（模拟 profile 里还是旧实现）\n')
  }
}

function runSync(...args) {
  try {
    return { code: 0, out: execFileSync(process.execPath, [SCRIPT, ...args], { cwd: ROOT, encoding: 'utf8' }) }
  } catch (error) {
    return {
      code: typeof error.status === 'number' ? error.status : 1,
      out: String(error.stdout || '') + String(error.stderr || ''),
    }
  }
}

const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex')

test('门禁子包 lib 变了、package.json 没变：--check 必须红（旧脚本在这里是假绿）', () => {
  buildDest({ staleGate: true })
  // 假绿的前提就是这两行：package.json 一样、lib 不一样 → 只比 package.json 必然放行
  assert.equal(sha256(join(GATE_SRC, 'package.json')), sha256(join(DEST, GATE_REL, 'package.json')))
  assert.notEqual(sha256(join(GATE_SRC, 'lib', 'index.js')), sha256(join(DEST, GATE_REL, 'lib', 'index.js')))
  const res = runSync('--check', '--dir', DEST)
  assert.equal(res.code, 1, '有漂移必须 exit 1：' + res.out)
  // 陈旧 1 = 门禁子包漂移并入陈旧（preflight 只解析三段，见脚本注释）
  assert.match(res.out, /缺失 0 \/ 断链 0 \/ 陈旧 1 \/ 门禁子包漂移 1/)
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
