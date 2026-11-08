// 把插件源码目录同步到 profile 的安装副本。
//
// 为什么需要：profile 里是 `file:` 安装 —— pnpm 为**已存在的文件**建了硬链接，
// 改内容会自动生效；但**新增文件不会**自动出现，而**被原子写入替换的文件会断链**。
//
// 真实事故 1（2026-11-01 23:59 重启）：新增的 lib/body.js 没进 profile，
//   宿主 import './body.js' 失败 → 整个插件不挂载 → 工具和 HTTP 路由全消失，
//   客户端 bundle 却照常加载，表面看起来"插件还在"。
// 真实事故 2（潜伏）：某些工具用「写临时文件再 rename」保存，profile 里那份仍是旧 inode，
//   于是宿主跑的是旧代码，而仓库里看着已经是新代码。
// 真实事故 3（假绿，2026-11-08）：门禁子包只比 package.json 就判「已同步」——
//   C1 改了 `packages/dsh-gate/lib/index.js`、版本没 bump、package.json 逐字节相同，
//   于是 `--check` 绿、`--repair` 不替换，profile 里跑的还是旧实现。见下方 gateDigest。
//
// 用法：
//   node scripts/sync-profile.mjs            补齐缺失文件（不动断链，只警告）
//   node scripts/sync-profile.mjs --repair   断链也重建硬链接、门禁子包按内容强制同步、清理陈旧文件
//   node scripts/sync-profile.mjs --check    只检查：缺失/断链/陈旧/门禁子包漂移/TARGETS 缺源 任一非零就红（给 CI 用）
//   node scripts/sync-profile.mjs --dir <path>  指定 profile 安装目录
//
// 退出码：0 = 干净；1 = profile 有漂移（--repair 能修）；2 = 仓库侧问题（TARGETS 条目在仓库里
// 不存在 / lib 的相对 import 解析失败 —— 这两种 --repair 修不了，只能改仓库）。
//
// 边界（别过度声明）：本脚本只保证**磁盘上的 profile 副本**与仓库一致；
// 宿主进程里已加载的模块不会因为替换文件而重载 —— 运行时是否生效要用户重载宿主后另验。
import { createHash } from 'node:crypto'
import { existsSync, linkSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, cpSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const REPAIR = args.includes('--repair')
const CHECK = args.includes('--check')
const dirFlag = args.indexOf('--dir')
const DEFAULT_PROFILE = join(
  process.env.DSH_HOME || join(process.env.USERPROFILE || '', '.dsh'),
  'profiles',
  'desktop',
  'node_modules',
  'dsh-session-superagent',
)
const DEST = dirFlag >= 0 ? args[dirFlag + 1] : DEFAULT_PROFILE

// 运行时要用的文件（不含 docs / test / scripts 这些开发件）。
//
// 故意写成**显式清单**而不是目录遍历：`lib/` 旁边就是 `test/` 和 `docs/`，一递归就会把开发件塞进安装副本。
// 但显式清单的代价是「新增运行时文件忘了加」—— 而这正是事故 1 的形状，且它不会报：
// profile 里缺 `bin/check.mjs` 时 `--check` 照样打印「缺失 0 / 断链 0 / 陈旧 0」exit 0（实测）。
// 所以清单由 `test/sync-profile-drift.test.mjs` 的两条派生规则守着：只要发布契约（package.json 的
// `files` / `exports` / `bin` / `dsh.bundle.patch`、`lib/**` 任意新 .js、`assets/**`）里多一个运行时件，
// 那条用例就红并点名；反过来清单里写了仓库里不存在的文件（删文件的复发形态），下面 missingSources 直接红。
// 新增运行时文件时必须在这里加一行。
const TARGETS = [
  'client.js', 'ui-host-primitives.js', 'ui-orbit-popover.js',
  'bin/check.mjs',
  'package.json', 'cordis.patch.yml', 'README.md', 'CHANGELOG.md', 'LICENSE',
  'assets/icon-180.png', 'assets/icon-app.png',
  'lib/index.js', 'lib/watch.js', 'lib/gh-format.js', 'lib/gitee.js', 'lib/gates.js', 'lib/redact.js', 'lib/body.js', 'lib/state-migration.js', 'lib/update.js', 'lib/semver.js',
]

// 反向守卫（S1）：TARGETS 里的每一条都必须真的在仓库里。
//
// 以前循环里是 `if (!existsSync(src)) continue` —— 清单条目还在、文件被删（或改名）时**静默跳过**：
// `--check` 照样打印「缺失 0 / 断链 0 / 陈旧 0」并 exit 0（假绿），profile 里那份旧文件也没人管；
// 而派生用例只查「仓库 → 清单」一个方向（发布契约里的文件有没有漏进 TARGETS），同样全绿。
// 2026-11-08 S1 在仓库副本里删掉 bin/check.mjs 实测：旧实现 `--check` exit 0、派生用例 1/1 绿。
// 现在缺一条就**点名**并按退出码 2 红（--repair 修不了：文件不会自己回来）。
const missingSources = TARGETS.filter((rel) => !existsSync(join(ROOT, rel)))
const presentTargets = TARGETS.filter((rel) => !missingSources.includes(rel))

if (!existsSync(DEST)) {
  console.error('找不到 profile 安装目录：' + DEST)
  process.exit(1)
}

const drift = { missing: [], broken: [], stale: [], gate: [] }
let linked = 0

for (const rel of presentTargets) {
  const src = join(ROOT, rel)
  const dst = join(DEST, rel)
  if (!existsSync(dst)) {
    drift.missing.push(rel)
    if (!CHECK) {
      mkdirSync(dirname(dst), { recursive: true })
      try { linkSync(src, dst); linked += 1; console.log('linked   ' + rel) } catch (error) {
        console.log('link 失败：' + rel + ' — ' + (error && error.message))
      }
    }
    continue
  }
  const same = statSync(src).ino === statSync(dst).ino
  if (same) continue
  drift.broken.push(rel)
  if (REPAIR && !CHECK) {
    try {
      unlinkSync(dst)
      linkSync(src, dst)
      linked += 1
      console.log('relinked ' + rel + '（原来断了）')
    } catch (error) {
      console.log('重建失败：' + rel + ' — ' + (error && error.message))
    }
  } else {
    console.log('注意     ' + rel + '（inode 不同：内容改动不会同步到 profile，用 --repair 重建）')
  }
}

/**
 * 门禁子包参与内容比对的文件：`package.json` + `lib/**\/*.js` + `bin/**\/*.mjs` + `gates/**\/*.json`。
 *
 * 为什么不能只比 package.json：C1 改了 `lib/index.js` / `bin/gate.mjs`，版本没 bump，
 * 两份 package.json 逐字节相同 → 旧判定认为「已同步」，于是 --check 假绿、--repair 不替换。
 * 为什么还要带 `gates/**\/*.json`（Q1R-M1）：运行时默认规则是 `gates/default.json`
 * （`packages/dsh-gate/lib/index.js` 的 DEFAULT_GATE_PATH），只改它同样是「行为变了、profile 没变」，
 * 漏掉它等于把假绿换个文件重演一遍。
 * 开发件（`test/`、`README.md`）不算运行时：改测试不该让门禁报漂移。
 */
const GATE_RUNTIME_DIRS = [
  { dir: 'lib', ext: '.js' },
  { dir: 'bin', ext: '.mjs' },
  { dir: 'gates', ext: '.json' },
]
const GATE_RUNTIME_FILES = ['package.json']

/** 递归列出目录下所有文件（相对路径，用 `/` 分隔 —— 排序后才稳定）。 */
function walkFiles(root, rel, out) {
  for (const name of readdirSync(join(root, rel))) {
    const childRel = rel + '/' + name
    if (statSync(join(root, childRel)).isDirectory()) { walkFiles(root, childRel, out); continue }
    out.push(childRel)
  }
}

/** 门禁子包的运行时文件清单（排序后）。 */
function listGateRuntimeFiles(root) {
  const out = []
  for (const rel of GATE_RUNTIME_FILES) if (existsSync(join(root, rel))) out.push(rel)
  for (const rule of GATE_RUNTIME_DIRS) {
    if (!existsSync(join(root, rule.dir))) continue
    const found = []
    walkFiles(root, rule.dir, found)
    for (const rel of found) if (rel.endsWith(rule.ext)) out.push(rel)
  }
  return out.sort()
}

/** 逐个文件的 sha256 + 相对路径汇总成一个目录指纹；目录不存在给 null（=没装）。 */
function gateDigest(root) {
  if (!root || !existsSync(root)) return null
  const hash = createHash('sha256')
  for (const rel of listGateRuntimeFiles(root)) {
    hash.update(rel + '\u0000' + createHash('sha256').update(readFileSync(join(root, rel))).digest('hex') + '\n')
  }
  return hash.digest('hex')
}

/** 列出内容不一致的文件（src 视角；profile 多出来的单独标注），给报错用。 */
function gateDiffDetail(srcRoot, dstRoot) {
  const srcFiles = listGateRuntimeFiles(srcRoot)
  const dstFiles = listGateRuntimeFiles(dstRoot)
  const changed = []
  for (const rel of srcFiles) {
    const dst = join(dstRoot, rel)
    if (!existsSync(dst) || !readFileSync(join(srcRoot, rel)).equals(readFileSync(dst))) changed.push(rel)
  }
  const known = new Set(srcFiles)
  for (const rel of dstFiles) if (!known.has(rel)) changed.push(rel + '（profile 多出来的）')
  return changed
}

// 门禁子包：主插件静态 import @mycf711/dsh-gate，profile 里必须有这一份。
// 硬链只对文件生效，目录用递归复制；**按内容判定**，不一致就整体替换（保留 package 结构）。
const gateSrc = join(ROOT, 'packages', 'dsh-gate')
const gateDst = join(DEST, 'node_modules', '@mycf711', 'dsh-gate')
const gateRel = 'node_modules/@mycf711/dsh-gate'
if (existsSync(gateSrc)) {
  if (!existsSync(gateDst)) {
    drift.missing.push(gateRel)
    if (REPAIR && !CHECK) {
      try {
        mkdirSync(dirname(gateDst), { recursive: true })
        cpSync(gateSrc, gateDst, { recursive: true })
        linked += 1
        console.log('copied   ' + gateRel)
      } catch (error) {
        console.log('复制失败：' + gateRel + ' — ' + (error && error.message))
      }
    }
  } else if (gateDigest(gateSrc) !== gateDigest(gateDst)) {
    const changed = gateDiffDetail(gateSrc, gateDst)
    drift.gate.push(gateRel)
    if (REPAIR && !CHECK) {
      try {
        rmSync(gateDst, { recursive: true, force: true })
        cpSync(gateSrc, gateDst, { recursive: true })
        linked += 1
        console.log('recopied ' + gateRel + '（内容不一致：' + changed.slice(0, 6).join(', ') +
          (changed.length > 6 ? ' 等 ' + changed.length + ' 处' : '') + '）')
      } catch (error) {
        console.log('强制同步失败：' + gateRel + ' — ' + (error && error.message))
      }
    } else {
      console.log('注意     ' + gateRel + '（内容与 packages/dsh-gate 不一致：' + changed.slice(0, 6).join(', ') +
        (changed.length > 6 ? ' 等 ' + changed.length + ' 处' : '') + '；用 --repair 强制同步）')
    }
  }
}

// 陈旧文件：profile 里有、仓库里已经没有（例如删掉的模块）
for (const name of readdirSync(join(DEST, 'lib')).filter((f) => f.endsWith('.js'))) {
  if (!existsSync(join(ROOT, 'lib', name))) {
    drift.stale.push('lib/' + name)
    if (REPAIR && !CHECK) {
      try { unlinkSync(join(DEST, 'lib', name)); console.log('pruned   lib/' + name) } catch {}
    } else {
      console.log('陈旧     lib/' + name + '（仓库已删除，profile 里还在）')
    }
  }
}

// lib/ 里每个相对 import 都必须能解析（这正是事故 1 的直接原因）
const libDir = join(ROOT, 'lib')
const missingImports = []
for (const name of readdirSync(libDir)) {
  if (!name.endsWith('.js')) continue
  const code = readFileSync(join(libDir, name), 'utf8')
  for (const line of code.split(String.fromCharCode(10))) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('import ')) continue
    const at = trimmed.lastIndexOf("from '")
    let spec = null
    if (at >= 0) {
      spec = trimmed.slice(at + 6).split("'")[0]
    } else if (trimmed.slice('import '.length).startsWith("'")) {
      spec = trimmed.slice('import '.length + 1).split("'")[0]
    }
    if (spec && spec.startsWith('.') && !existsSync(join(libDir, spec))) {
      missingImports.push(name + ' -> ' + spec)
    }
  }
}

// 四段各自独立计数：门禁子包漂移**不**并入「陈旧」。
// 并入是 0.10.8 的临时垫片 —— 当时 preflight 只解析「缺失 / 断链 / 陈旧」三段，
// 不并入就会显示「三个 0 却 FAIL」的假红；现在 preflight 已解析第四段（见 scripts/preflight.mjs），
// 垫片反而会报出「陈旧 1，但 profile 里没有多余文件」的误导，所以撤掉。
// 四个数的含义：缺失 = profile 少文件、断链 = inode 不同（改了不同步）、
// 陈旧 = profile 多出仓库已删的 lib 文件、门禁子包漂移 = 子包内容与 packages/dsh-gate 不一致。
// 第五个数「TARGETS 缺源」只在清单条目不成立时才出现（S1）：正常状态不该多一段噪音。
const drifted = drift.missing.length + drift.broken.length + drift.stale.length + drift.gate.length
for (const rel of missingSources) console.log('缺源     ' + rel + '（仓库里没有这个文件：恢复它，或把这一行从 TARGETS 删掉）')
console.log('---')
console.log(`目标：${DEST}`)
console.log(`缺失 ${drift.missing.length} / 断链 ${drift.broken.length} / 陈旧 ${drift.stale.length} / 门禁子包漂移 ${drift.gate.length}` +
  (missingSources.length > 0 ? ` / TARGETS 缺源 ${missingSources.length}（${missingSources.join(', ')}）` : '') +
  (linked ? `，本次处理 ${linked} 个` : ''))
console.log('（只证明 profile 磁盘副本一致；宿主运行时是否生效要在重载后另验）')

// 清单条目不成立是**仓库侧**问题：--repair 变不出文件来，必须红（退出码 2），并且点名。
if (missingSources.length > 0) {
  console.error('TARGETS 有 ' + missingSources.length + ' 条在仓库里不存在：' + missingSources.join(', '))
  console.error('（--repair 修不了：恢复这些文件，或把它们从 TARGETS 删掉）')
  process.exit(2)
}

if (missingImports.length > 0) {
  console.error('相对 import 解析失败：' + missingImports.join(', '))
  process.exit(2)
}
console.log('相对 import 全部可解析 ✓')

if (CHECK && drifted > 0) {
  console.error('profile 与仓库不一致（跑 --repair 修）')
  process.exit(1)
}
