// README 里写的「N 项单测」和实际用例数对得上吗？
//
// 用例数由调用方传进来（preflight 刚跑完 node --test，它知道真实数字）——
// 这样这条检查本身是零成本的；单独跑时才自己去数。
//
// 用法：node scripts/audit-readme-tests.mjs [实际用例数]
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const readme = readFileSync(join(ROOT, 'README.md'), 'utf8')
// 审核 T25：以前用 `match` 只取**第一处** —— README 里第二处写错也看不见。
// README 同时说「369 项单测」的地方不止一处，全部收集，要求它们一致。
const claims = [...readme.matchAll(/(\d+)\s*项单测/g)].map((m) => m[1])
const claimed = claims.length > 0 ? claims[0] : null
const claimsDisagree = new Set(claims).size > 1

let actual = process.argv[2]
if (!actual) {
  // 与 scripts/test.mjs 同口径：单测不许出网，也不许真的探测更新。
  // 少了这几个变量，routes.test.mjs 里那几条会真的 spawn gh（30s 超时起步），
  // 于是这里拿到 status 1 崩掉，看起来像「README 数字写错了」。
  const env = { ...process.env, DSH_SUPERAGENT_OFFLINE: '1', DSH_SUPERAGENT_UPDATE_OFFLINE: '1' }
  for (const key of ['DSH_SUPERAGENT_STATE', 'DSH_SUPERAGENT_NO_POLL', 'DSH_SUPERAGENT_TRIGGER', 'DSH_GATE_LOCK_TOKEN']) {
    delete env[key]
  }
  const out = execFileSync('node', ['--test'], { cwd: ROOT, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
  actual = (out.match(/^ℹ tests (\d+)/m) || out.match(/# tests (\d+)/) || [])[1]
}

if (claimsDisagree) {
  console.log('FAIL README 单测数  README 里几处单测数不一致：' + claims.join(' / '))
  process.exitCode = 1
} else if (!claimed) {
  console.log('FAIL README 单测数  README 没写单测数')
  process.exitCode = 1
} else if (claimed !== String(actual)) {
  console.log('FAIL README 单测数  README 写 ' + claimed + '，实际 ' + actual + '（改 README）')
  process.exitCode = 1
} else {
  console.log('PASS README 单测数  README 写 ' + claimed + '，实际 ' + actual)
}
