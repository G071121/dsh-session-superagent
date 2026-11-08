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
// 不存在 / 整个 lib 目录不存在 / 门禁子包源目录不存在 / lib 的相对 import 解析失败 —— 这几种
// --repair 修不了，只能改仓库）。
//
// 失败原子性（S1 v6 / v5 Q1 L1-L2）：**四类仓库侧问题全部在任何写盘之前判定**，任一非空时整轮只读 ——
// TARGETS 条目在仓库里不存在、整个 `lib/` 目录不存在、`packages/dsh-gate` 源目录缺失、
// 或 `lib/*.js` 的相对 import 解析不到目标文件时，所有 link / relink / copy / prune 都不执行，
// 判红（exit 2）发生在任何写盘之前。
// v5 以前只覆盖前两类（`repoMissing`）：相对 import 失败要等 relink / 子包复制 / 陈旧 prune 做完
// 才检测（Q1 L1 实测：先 `relinked lib/body.js`、`pruned lib/zzz-stale.js` 再 exit 2）——
// 修不了却改了磁盘，用户以为只是报错，实际 profile 已经被改了一半。v6 把 `missingImports`
// 计算前移，四类仓库侧错误现在**一律**只读（注释与实现一致，不再有「只覆盖 repoMissing」的边界）。
//
// 另外，本脚本只保证**磁盘上的 profile 副本**与仓库一致；
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
const absentTargets = TARGETS.filter((rel) => !existsSync(join(ROOT, rel)))
const presentTargets = TARGETS.filter((rel) => !absentTargets.includes(rel))

// 整个 `lib/` 目录缺失（S1 v6 / v5 Q1 L2）：旧实现走到下面的 `readdirSync(libDir)` 直接抛
// `ENOENT` 栈（exit 1），preflight 只能读到「(无输出)」—— 用户看到的是崩溃，不是「缺源 + 点名」。
// 它和 TARGETS 缺源同类（--repair 变不出源目录来），但汇总里**单独成段**：把 `lib` 塞进
// 「TARGETS 缺源」会重演 v5 Q1 L3 的措辞问题（`packages/dsh-gate` 不是 TARGETS 条目）。
// 目录整个没了就不再逐条报它下面的 10 个文件：同一个原因刷 10 行只会盖住根因。
const libDir = join(ROOT, 'lib')
const libDirMissing = !existsSync(libDir)
// 汇总里的「TARGETS 缺源」：整个 lib/ 目录缺失时由上面的 `lib 目录缺失` 段代表，不重复计数。
const missingSources = libDirMissing ? absentTargets.filter((rel) => !rel.startsWith('lib/')) : absentTargets

// 门禁子包源目录（仓库侧）：`packages/dsh-gate` 整个目录不存在时，旧实现 `if (existsSync(gateSrc))`
// 静默跳过 —— profile 检查可能仍然「四段全零」，门禁子包根本没人管（v4 审查 F7）。
// 它和 TARGETS 缺源同类：--repair 变不出源目录来，只能改仓库 → 一起进 `repoMissing`，
// 在任何写盘之前 exit 2。
const gateSrc = join(ROOT, 'packages', 'dsh-gate')
const gateDst = join(DEST, 'node_modules', '@mycf711', 'dsh-gate')
const gateRel = 'node_modules/@mycf711/dsh-gate'
const gateDirMissing = !existsSync(gateSrc)

/**
 * `lib/*.js` 里每个相对 import 都必须能解析（这正是事故 1 的直接原因）。
 *
 * S1 v6（v5 Q1 L1）：**必须在任何写盘之前跑**。以前它在 relink / 子包复制 / 陈旧 prune 之后，
 * 那一轮 profile 已经改了一半才 exit 2；现在它和 `repoMissing` 一起决定 `REPO_BLOCKED`。
 * 整个 `lib/` 目录缺失时调用方不进来（已收进仓库侧缺源），所以不会抛 `ENOENT`。
 */
function scanMissingImports(dir) {
  const missing = []
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.js')) continue
    const code = readFileSync(join(dir, name), 'utf8')
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
      if (spec && spec.startsWith('.') && !existsSync(join(dir, spec))) {
        missing.push(name + ' -> ' + spec)
      }
    }
  }
  return missing
}

const missingImports = libDirMissing ? [] : scanMissingImports(libDir)

// 仓库侧缺源：TARGETS 条目 / 整个 lib 目录 / 门禁子包源目录 —— 三类各自独立成段点名。
const repoMissing = [
  ...missingSources,
  ...(libDirMissing ? ['lib'] : []),
  ...(gateDirMissing ? ['packages/dsh-gate'] : []),
]
// 仓库侧问题 = 这一轮只许读、不许写（失败原子性）。相对 import 失败也算：它同样 --repair 修不了，
// 而且把它漏在外面就是「先改盘再报错」（v5 Q1 L1 的原始形状）。
const REPO_BLOCKED = repoMissing.length > 0 || missingImports.length > 0

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
    if (!CHECK && !REPO_BLOCKED) {
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
  if (REPAIR && !CHECK && !REPO_BLOCKED) {
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
// 源目录存在性在上面的 `gateDirMissing` 已经判过（缺源 = 仓库侧问题，整轮只读 + exit 2）。
if (!gateDirMissing) {
  if (!existsSync(gateDst)) {
    drift.missing.push(gateRel)
    // 整目录缺失必须点名：旧实现只让「缺失」+1，--check 里看到「缺失 1」不知道缺的是门禁子包。
    console.log('缺失     ' + gateRel + '（profile 里没有门禁子包整个目录：--repair 会递归复制）')
    if (REPAIR && !CHECK && !REPO_BLOCKED) {
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
    if (REPAIR && !CHECK && !REPO_BLOCKED) {
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

// 陈旧文件：profile 里有、仓库里已经没有（例如删掉的模块）。
// 整个仓库 `lib/` 目录缺失时**不逐文件判陈旧**：那些「陈旧」只是缺源的影子，报出来会和汇总里的
// 「lib 目录缺失」互相矛盾（汇总准确）；这一轮本来也不许写盘。
const destLibDir = join(DEST, 'lib')
if (!libDirMissing) {
  if (!existsSync(destLibDir)) {
    // profile 侧整个 lib/ 目录没装：旧实现会在这里 `readdirSync` 抛 ENOENT 栈（--check 变成崩溃）。
    // 缺失计数已经由上面的 TARGETS 循环给过（每个 lib/*.js 各一条），这里只补一句「缺的是整个目录」。
    if (!REPO_BLOCKED) console.log('缺失     lib/（profile 里没有整个 lib 目录：--repair 会按 TARGETS 重建硬链接）')
  } else {
    for (const name of readdirSync(destLibDir).filter((f) => f.endsWith('.js'))) {
      if (!existsSync(join(ROOT, 'lib', name))) {
        drift.stale.push('lib/' + name)
        if (REPAIR && !CHECK && !REPO_BLOCKED) {
          try { unlinkSync(join(destLibDir, name)); console.log('pruned   lib/' + name) } catch {}
        } else {
          console.log('陈旧     lib/' + name + '（仓库已删除，profile 里还在）')
        }
      }
    }
  }
}

// 四段各自独立计数：门禁子包漂移**不**并入「陈旧」。
// 并入是 0.10.8 的临时垫片 —— 当时 preflight 只解析「缺失 / 断链 / 陈旧」三段，
// 不并入就会显示「三个 0 却 FAIL」的假红；现在 preflight 已解析第四段（见 scripts/preflight.mjs），
// 垫片反而会报出「陈旧 1，但 profile 里没有多余文件」的误导，所以撤掉。
// 四个数的含义：缺失 = profile 少文件、断链 = inode 不同（改了不同步）、
// 陈旧 = profile 多出仓库已删的 lib 文件、门禁子包漂移 = 子包内容与 packages/dsh-gate 不一致。
//
// 第五段起是**仓库侧缺源**，每类独立成段、只在非零时出现（clean 无噪音）：
//   TARGETS 缺源 N（...）       —— 清单条目在仓库里不存在（S1 v5）
//   lib 目录缺失 1（lib）        —— 整个 lib/ 目录不存在（S1 v6 / v5 Q1 L2）
//   门禁子包源缺失 1（...）       —— packages/dsh-gate 整个目录不存在（S1 v5 / v4 审查 F7）
//   相对 import 缺失 N（...）     —— lib/*.js 的相对 import 解析不到（S1 v6 / v5 Q1 L1）
// 为什么必须进汇总行：只打印「四个 0」再 exit 2 就是 0.10.8 那种假绿/假红的形状。
// 为什么分开写：把 `packages/dsh-gate` / `lib` 塞进「TARGETS 缺源」是 v5 Q1 L3 的措辞问题
// （它们不是 TARGETS 条目），preflight 的解析与 clean 判定也按类别分开。
const drifted = drift.missing.length + drift.broken.length + drift.stale.length + drift.gate.length
for (const rel of missingSources) console.log('缺源     ' + rel + '（仓库里没有这个文件：恢复它，或把这一行从 TARGETS 删掉）')
if (libDirMissing) console.log('缺源     lib/（仓库里没有整个 lib 目录：恢复它，--repair 修不了）')
if (gateDirMissing) console.log('缺源     packages/dsh-gate（仓库里没有门禁子包整个目录：恢复它，--repair 修不了）')
for (const item of missingImports) console.log('import   ' + item + '（相对 import 解析不到目标文件：恢复它，--repair 修不了）')
console.log('---')
console.log(`目标：${DEST}`)
let summary = `缺失 ${drift.missing.length} / 断链 ${drift.broken.length} / 陈旧 ${drift.stale.length} / 门禁子包漂移 ${drift.gate.length}`
if (missingSources.length > 0) summary += ` / TARGETS 缺源 ${missingSources.length}（${missingSources.join(', ')}）`
if (libDirMissing) summary += ' / lib 目录缺失 1（lib）'
if (gateDirMissing) summary += ' / 门禁子包源缺失 1（packages/dsh-gate）'
if (missingImports.length > 0) summary += ` / 相对 import 缺失 ${missingImports.length}（${missingImports.join(', ')}）`
console.log(summary + (linked ? `，本次处理 ${linked} 个` : ''))
console.log('（只证明 profile 磁盘副本一致；宿主运行时是否生效要在重载后另验）')

// 仓库侧缺源是**仓库侧**问题：--repair 变不出文件/目录来，必须红（退出码 2），并且点名。
// 这一轮已经整轮只读（REPO_BLOCKED）：走到这里时磁盘一处都没动，失败是原子的。
if (repoMissing.length > 0) {
  if (missingSources.length > 0) console.error('TARGETS 有 ' + missingSources.length + ' 条在仓库里不存在：' + missingSources.join(', '))
  if (libDirMissing) console.error('仓库里没有整个 lib 目录：lib')
  if (gateDirMissing) console.error('仓库里没有门禁子包源目录：packages/dsh-gate')
  console.error('（--repair 修不了：恢复这些文件/目录，或把不存在的条目从 TARGETS 删掉；本轮未改任何 profile 文件）')
  process.exit(2)
}

// 相对 import 解析失败同样归仓库侧（exit 2），现在也在任何写盘之前判红（S1 v6 / v5 Q1 L1）。
if (missingImports.length > 0) {
  console.error('相对 import 解析失败：' + missingImports.join(', '))
  console.error('（--repair 修不了：恢复被 import 的文件；本轮未改任何 profile 文件）')
  process.exit(2)
}
console.log('相对 import 全部可解析 ✓')

if (CHECK && drifted > 0) {
  console.error('profile 与仓库不一致（跑 --repair 修）')
  process.exit(1)
}
