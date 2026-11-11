import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import semver from 'semver'

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const range = pkg.engines.dsh
const oldRange = '>=0.2.1-rc.5'
const modes = [
  ['default', undefined],
  ['includePrerelease', { includePrerelease: true }],
]

test('engines.dsh 只声明 rc1 及以上的 0.2.x，并排除未验 0.3.0', () => {
  // 官方 semver 对照：默认模式只自动接纳与 comparator 同 core tuple 的预发布。
  assert.equal(semver.satisfies('0.2.2-rc.1', oldRange), false)
  assert.equal(semver.satisfies('0.2.2-rc.1', oldRange, { includePrerelease: true }), true)

  for (const [mode, options] of modes) {
    for (const version of ['0.2.2-rc.1', '0.2.2', '0.2.99']) {
      assert.equal(semver.satisfies(version, range, options), true, `${mode}: 应支持 ${version}`)
    }
    for (const version of ['0.2.1-rc.5', '0.2.1', '0.2.1-rc.4', '0.2.2-rc.0', '0.3.0-alpha.0', '0.3.0']) {
      assert.equal(semver.satisfies(version, range, options), false, `${mode}: 不应支持 ${version}`)
    }
  }

  assert.equal(semver.satisfies('0.2.99-rc.1', range, { includePrerelease: true }), true)
  const skippedBundles = semver.satisfies('0.2.2-rc.1', range) ? [] : [pkg.name]
  assert.deepEqual(skippedBundles, [], '默认 semver 门禁也不应跳过 rc1 bundle')
})
