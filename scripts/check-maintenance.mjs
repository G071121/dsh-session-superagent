#!/usr/bin/env node
/**
 * 维护一致性检查（本地化自 `magpie-plugin-scaffold` 的 check-maintenance）。
 *
 * 六条都在问同一件事：**这个版本到底发出去了没有**。它们全不报错、也全不崩，
 * 但任何一条不满足，用户拿到的就是旧版 —— 所以必须有一条命令把话说明白。
 *
 *   1. package.json 的 version 在 CHANGELOG 里有一节
 *   2. CHANGELOG 最上面那节 != 更老版本（即最新一条就是当前版本）
 *   3. 当前版本有本地 git tag `vX.Y.Z`
 *   4. 该 tag 指向已提交的 commit（不是悬空）
 *   5. README 徽章 / lib/index.js / client.js 的版本与 package.json 一致
 *   6. 自上个 tag 以来动过运行时 / 工装代码（`lib/`、`client.js`、`packages/dsh-gate/{lib,bin,gates}`、
 *      `scripts/`），但版本没 bump —— 提示（不判失败）
 *
 * 用法：node scripts/check-maintenance.mjs [--json]
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const JSON_OUT = process.argv.includes('--json')
const run = (cmd, argv) => {
  try { return execFileSync(cmd, argv, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim() } catch (error) { return String(error.stdout || '').trim() }
}

const pkg = JSON.parse(readFileSync('package.json', 'utf8'))
const version = pkg.version
const tag = 'v' + version
const changelog = readFileSync('CHANGELOG.md', 'utf8')
const readme = readFileSync('README.md', 'utf8')
const serverSrc = readFileSync('lib/index.js', 'utf8')
const clientSrc = readFileSync('client.js', 'utf8')

const results = []
const check = (name, ok, detail) => results.push({ name, ok, detail })

// ① CHANGELOG 里有这一节
const hasSection = new RegExp('^## \\[' + version.replace(/\./g, '\\.') + '\\]', 'm').test(changelog)
check('CHANGELOG 有当前版本小节', hasSection, hasSection ? version : '缺 ## [' + version + ']')

// ② 最新一条就是当前版本
const firstHeading = (changelog.match(/^## \[(\d+\.\d+\.\d+)\]/m) || [])[1]
check('CHANGELOG 最新小节 = 当前版本', firstHeading === version, '最新是 ' + (firstHeading || '（无）') + '，package.json 是 ' + version)

// ③ 本地有 tag
const tags = new Set(run('git', ['tag', '-l']).split('\n').filter(Boolean))
// 审核（0.9.248 的 CI 红）：这条在 CI 上红过一次，原因是**推送顺序** ——
// 先推 main、再推 tag，中间那几秒 CI 已经开始跑，tag 还没到远端。
// 现在把话说明白：本地没有 vs 远端没有，是两种完全不同的处置。
const remoteTags = (() => { try { return run('git', ['ls-remote', '--tags', 'origin']).split(String.fromCharCode(10)) } catch { return [] } })()
const hasRemote = remoteTags.some((line) => line.trim().endsWith('refs/tags/' + tag) || line.includes('refs/tags/' + tag + '^{}'))
check(
  '当前版本有 git tag',
  tags.has(tag),
  tags.has(tag)
    ? (hasRemote ? tag : tag + '（本地有、远端没有 —— 先 git push origin ' + tag + '）')
    : '缺 ' + tag + '（跑 node scripts/release-gh.mjs --latest）'
)

// ④ tag 指向真实 commit
const tagSha = tags.has(tag) ? run('git', ['rev-parse', '--verify', tag + '^{commit}']) : ''
check('tag 指向已提交的 commit', /^[0-9a-f]{40}$/.test(tagSha), tagSha ? tagSha.slice(0, 8) : '解析不出 commit')

// ⑤ 四处版本一致
const badge = (readme.match(/version-(\d+\.\d+\.\d+)-green\.svg/) || [])[1]
const serverV = (serverSrc.match(/SERVER_VERSION = '([^']+)'/) || [])[1]
const clientV = (clientSrc.match(/CLIENT_VERSION = '([^']+)'/) || [])[1]
const consistent = [badge, serverV, clientV].every((v) => v === version)
check('README 徽章 / lib / client 版本一致', consistent, 'package=' + version + ' badge=' + (badge || '?') + ' server=' + (serverV || '?') + ' client=' + (clientV || '?'))

// ⑥ 改了代码但没 bump（提示，不失败）
//
// 扫描范围（V1 R1 / Q1-7）：只扫根 `lib/` + `client.js` 会漏掉 v6 起真正在变的那一半 ——
// 只扫**随包发布**的运行时代码（`package.json` 的 `files` 里列出的那些）：根 `lib/`、`bin/`、
// `client.js`、两个 `ui-*.js`、`cordis.patch.yml`，以及门禁子包的 `lib` / `bin` / `gates`。
// **不扫 `scripts/`** —— 那是仓库验收工装，不进 npm 包；把它算进来会让「只改验收脚本」也逼着 bump 版本
// （2026-11-09 真实误报：PR #37 只改 `scripts/verify-ui-*.mjs` 的默认路径，main CI ⑥ 直接红）。
const CODE_PATHS = [
  'lib/',
  'bin/',
  'client.js',
  'ui-host-primitives.js',
  'ui-orbit-popover.js',
  'cordis.patch.yml',
  'packages/dsh-gate/lib/',
  'packages/dsh-gate/bin/',
  'packages/dsh-gate/gates/',
]
const since = tags.has(tag) ? run('git', ['diff', '--name-only', tag + '..HEAD', '--', ...CODE_PATHS]) : ''
const dirtyFiles = since.split('\n').filter(Boolean)
const dirty = dirtyFiles.length
check(
  '自上个 tag 起未改动运行时代码（未 bump 不算错，只提示）',
  dirty === 0,
  dirty === 0
    ? '干净（已扫 lib/ bin/ client.js ui-*.js cordis.patch.yml packages/dsh-gate/{lib,bin,gates}；scripts/ 是验收工装，不计）'
    : dirty + ' 个文件已改，尚未 bump 版本：' + dirtyFiles.slice(0, 5).join(' / ') + (dirty > 5 ? ' …' : ''),
)

const failed = results.filter((r) => !r.ok)
if (JSON_OUT) {
  console.log(JSON.stringify({ version, results }, null, 2))
} else {
  for (const r of results) console.log((r.ok ? 'PASS ' : 'FAIL ') + r.name + '  ' + r.detail)
  console.log(failed.length ? '\n' + failed.length + ' 项不一致 —— 版本没真正发出去，用户拿不到新版' : '\n维护一致性：6 项通过')
}
if (failed.length) process.exitCode = 1
