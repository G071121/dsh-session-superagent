// C1：`extends` 写盘防丢失。
//
// `writeGateConfig()` 是**整层重写**：它只写 `version/name/rules/semantic`。历史上调用方
// 传进来的 `extends` 会在这里被静默丢掉（Q1-F3），改一条规则就把共享基文件里的规则
// 一起冲掉，而且文件看起来「保存成功」。
//
// 冻结行为（docs/任务书-dsh-gate-v3.md）：写盘侧 fail closed ——
//   - `false` / `"none"`：允许，原样写回；
//   - `true` / `"default"` / 路径字符串 / 内联对象：显式报错，错误含**配置路径**与**解决方式**；
//   - 文件里已经有这种共享 `extends`：即使入参不带 `extends`（或带 `false`）也拒绝整层重写。
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import {
  loadGateConfig,
  localGatePath,
  projectGatePath,
  readGateScope,
  userGatePath,
  validateConfig,
  writeGateConfig,
} from '../lib/index.js'
import { tempDir, writeJsonFile, writeTextFile } from '../test-support/helpers.mjs'

const rule = (id = 'own', extra = {}) => ({
  id,
  label: '自定义 ' + id,
  type: 'contains',
  value: '禁止词-' + id,
  triggers: ['issue.reply'],
  message: '命中',
  ...extra,
})

/** 一个仓库 + 一个独立 home，避免碰到真实用户配置。 */
function sandbox() {
  const repo = tempDir('gate-ext-')
  const home = tempDir('gate-home-')
  return { repo, home, env: {}, path: projectGatePath(repo), dir: join(repo, '.superagent') }
}

const leftovers = (dir) => readdirSync(dir).filter((name) => name.includes('.tmp-'))

/** 断言：抛出的 extends 错误必须点名路径、给出解决方式，并且带稳定的 code。 */
function assertExtendsError(fn, path) {
  assert.throws(fn, (error) => {
    const message = String((error && error.message) || error)
    assert.match(message, /无法安全写入 extends/)
    assert.ok(message.includes(path), '错误必须点名配置文件路径，实际：' + message)
    assert.match(message, /解决方式/)
    assert.equal(error.code, 'extends_not_preservable')
    assert.equal(error.path, path)
    return true
  })
}

test('writeGateConfig：入参 extends 是共享路径时显式报错，不写盘也不丢字段', () => {
  const { repo, home, env, path, dir } = sandbox()
  writeJsonFile(join(dir, 'shared.json'), { version: 1, rules: [rule('shared-a')] })
  writeJsonFile(path, { version: 1, name: 'project', rules: [rule('own')] })
  const before = readFileSync(path, 'utf8')

  assertExtendsError(
    () => writeGateConfig('project', {
      version: 1,
      name: 'project',
      extends: './shared.json',
      rules: [rule('own'), rule('extra')],
    }, { repo, home, env }),
    path,
  )

  assert.equal(readFileSync(path, 'utf8'), before, '报错时磁盘文件必须原样不动')
  assert.equal(existsSync(path + '.bak'), false, '没有写盘就不该产生 .bak')
  assert.deepEqual(leftovers(dir), [], '不能留下临时文件')
})

test('writeGateConfig：extends 的其他共享形式（true / "default" / 内联对象）同样拒绝', () => {
  for (const shared of [true, 'default', { rules: [rule('inline-base')] }]) {
    const { repo, home, env, path } = sandbox()
    assertExtendsError(
      () => writeGateConfig('project', { version: 1, name: 'project', extends: shared, rules: [rule('own')] }, { repo, home, env }),
      path,
    )
    assert.equal(existsSync(path), false, '拒绝时不创建文件：' + JSON.stringify(shared))
  }
})

test('writeGateConfig：extends:false 允许保存，原样写回，读回后仍是「替换」语义', () => {
  const { repo, home, env, path } = sandbox()
  // 用户层放一条规则：项目层 extends:false 时它必须不再参与合并。
  writeJsonFile(userGatePath({ home, env }), { version: 1, name: 'user', rules: [rule('user-only')] })

  const saved = writeGateConfig('project', {
    version: 1,
    name: 'project',
    extends: false,
    rules: [rule('proj-only')],
  }, { repo, home, env })

  assert.equal(saved.path, path)
  const written = JSON.parse(readFileSync(path, 'utf8'))
  assert.equal(written.extends, false, 'extends:false 必须原样写回，不能被整层重写丢掉')
  assert.deepEqual(written.rules.map((item) => item.id), ['proj-only'])

  // 读回：面板看的是本层原始形状，extends 不能在这一步消失。
  const scope = readGateScope('project', { repo, home, env })
  assert.equal(scope.config.extends, false)

  // 合并：extends:false = 丢掉之前所有层，只剩本层规则。
  const loaded = loadGateConfig({ repo, home, env })
  assert.deepEqual(loaded.config.rules.map((item) => item.id), ['proj-only'], 'extends:false 写入后仍必须是替换语义')
  assert.equal(loaded.config.rules.length, 1, '默认层的 10 条规则也不能在 extends:false 后出现')
})

test('writeGateConfig：extends:"none" 与 false 等价，且字符串原样保留', () => {
  const { repo, home, env, path } = sandbox()
  writeJsonFile(userGatePath({ home, env }), { version: 1, name: 'user', rules: [rule('user-only')] })

  writeGateConfig('local', { version: 1, name: 'local', extends: 'none', rules: [rule('local-only')] }, { repo, home, env })

  const written = JSON.parse(readFileSync(localGatePath(repo), 'utf8'))
  assert.equal(written.extends, 'none', '"none" 必须按原样写回（不归一化成 false）')
  const loaded = loadGateConfig({ repo, home, env })
  assert.deepEqual(loaded.config.rules.map((item) => item.id), ['local-only'], 'extends:"none" 写入后仍是替换语义')
  assert.equal(readGateScope('local', { repo, home, env }).config.extends, 'none')
  assert.equal(existsSync(path), false, '本用例只写本地层，项目层文件不应被创建')
})

test('writeGateConfig：磁盘上已有共享 extends 时拒绝整层重写（不被无提示改写）', () => {
  const { repo, home, env, path, dir } = sandbox()
  writeJsonFile(join(dir, 'shared.json'), { version: 1, rules: [rule('shared-secret')] })
  writeJsonFile(path, { version: 1, name: 'project', extends: './shared.json', rules: [rule('own')] })
  const before = readFileSync(path, 'utf8')
  assert.ok(loadGateConfig({ repo, home, env }).config.rules.some((item) => item.id === 'shared-secret'),
    '前置：共享基文件里的规则确实在生效')

  // 入参不带 extends：旧实现会静默把它冲掉。
  assertExtendsError(() => writeGateConfig('project', { version: 1, name: 'project', rules: [rule('own')] }, { repo, home, env }), path)

  assert.equal(readFileSync(path, 'utf8'), before, '磁盘文件必须原样不动')
  assert.equal(existsSync(path + '.bak'), false, '拒绝写盘不该产生 .bak')
  assert.deepEqual(leftovers(dir), [], '不能留下临时文件')
  assert.equal(readGateScope('project', { repo, home, env }).config.extends, './shared.json')
})

test('writeGateConfig：磁盘上的共享 extends 不能靠传 extends:false 抹掉', () => {
  const { repo, home, env, path } = sandbox()
  writeJsonFile(join(repo, '.superagent', 'shared.json'), { version: 1, rules: [rule('shared-secret')] })
  writeJsonFile(path, { version: 1, name: 'project', extends: './shared.json', rules: [rule('own')] })
  const before = readFileSync(path, 'utf8')

  assertExtendsError(() => writeGateConfig('project', {
    version: 1,
    name: 'project',
    extends: false,
    rules: [rule('own')],
  }, { repo, home, env }), path)

  assert.equal(readFileSync(path, 'utf8'), before, '共享基没有被合法地「替换」掉，文件就不能变')
})

test('writeGateConfig：磁盘上是 extends:false 时，入参不带 extends 也不会把它丢掉', () => {
  const { repo, home, env, path } = sandbox()
  writeJsonFile(userGatePath({ home, env }), { version: 1, name: 'user', rules: [rule('user-only')] })
  writeJsonFile(path, { version: 1, name: 'project', extends: false, rules: [rule('own')] })

  writeGateConfig('project', { version: 1, name: 'project', rules: [rule('own'), rule('extra')] }, { repo, home, env })

  const written = JSON.parse(readFileSync(path, 'utf8'))
  assert.equal(written.extends, false, '可安全保留的形式必须保留：否则 replace 会变成 merge')
  assert.deepEqual(written.rules.map((item) => item.id), ['own', 'extra'])
  const loaded = loadGateConfig({ repo, home, env })
  assert.deepEqual(loaded.config.rules.map((item) => item.id), ['own', 'extra'], '保存后用户层规则不能重新混进来')
})

test('validateConfig 保留 extends（形状校验），写盘语义由 writeGateConfig 按路径判定', () => {
  // 面板 → 服务端 POST 走的就是 validateConfig → writeGateConfig。validateConfig 一旦把
  // extends 从结果里抹掉，服务端就再也没有机会知道调用方传过 extends。
  const shared = validateConfig({ version: 1, name: 'project', extends: './shared.json', rules: [rule('own')] })
  assert.equal(shared.ok, true, '路径形状本身合法：能不能写由 writeGateConfig 决定')
  assert.equal(shared.config.extends, './shared.json', 'validateConfig 不能丢掉 extends')

  const keep = validateConfig({ version: 1, name: 'project', extends: false, rules: [rule('own')] })
  assert.equal(keep.ok, true)
  assert.equal(keep.config.extends, false)
  assert.equal(keep.config.rules[0].id, 'own', '其余字段仍按老规矩整理')

  // 完全不是 extends 的形状（数字 / null / 数组）：结构上就该拒绝。
  for (const bad of [123, null, [], () => {}]) {
    const checked = validateConfig({ rules: [], extends: bad })
    assert.equal(checked.ok, false, '非法 extends 形状必须拒绝：' + String(bad))
    assert.match(checked.error, /extends/)
  }
})

test('writeGateConfig：旧配置（没有 extends）写盘不凭空加 extends 字段', () => {
  const { repo, home, env, path } = sandbox()
  writeGateConfig('project', { version: 1, name: 'project', rules: [rule('own')] }, { repo, home, env })
  writeGateConfig('project', { version: 1, name: 'project', rules: [rule('own'), rule('extra')] }, { repo, home, env })
  const written = JSON.parse(readFileSync(path, 'utf8'))
  assert.equal(Object.prototype.hasOwnProperty.call(written, 'extends'), false, '没写 extends 就不要加字段')
  assert.deepEqual(written.rules.map((item) => item.id), ['own', 'extra'])
})

test('writeGateConfig：坏 JSON 层的原文先进 .bak，再写新配置（可恢复，不静默抹掉）', () => {
  const { repo, home, env, path } = sandbox()
  writeTextFile(path, '{ broken json')

  writeGateConfig('project', { version: 1, name: 'project', rules: [rule('fixed')] }, { repo, home, env })

  assert.equal(readFileSync(path + '.bak', 'utf8'), '{ broken json', '坏文件原文必须留在 .bak，不能只留在记忆里')
  assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')).rules.map((item) => item.id), ['fixed'])
})
