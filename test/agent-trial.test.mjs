import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

// 主理鱼值守连通性试跑用例：只依赖 node 内置模块，不引入任何依赖，
// 用来验证「改代码 → API 提交 → 开 PR」这条链路在无 git 环境下可用。
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))

test('package.json 有合法的包名与严格 semver 版本号', () => {
  assert.equal(pkg.name, 'dsh-session-superagent')
  assert.match(pkg.version, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/)
})

test('包入口与 bundle patch 指向真实文件', () => {
  assert.ok(pkg.exports && pkg.exports['.'])
  assert.equal(typeof pkg.exports['.'], 'string')
  assert.ok(pkg.dsh && pkg.dsh.bundle && pkg.dsh.bundle.patch)
})
