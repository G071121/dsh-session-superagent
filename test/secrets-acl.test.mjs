// Windows 用 icacls 收紧 ACL；POSIX 用 chmod 0600。Windows 分支也模拟 POSIX，覆盖真实实现。
import { execFileSync } from 'node:child_process'
import { tempDir } from './fixtures/tmpdir.mjs'
import { rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'

function withPlatform(platform, fn) {
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')
  Object.defineProperty(process, 'platform', { value: platform, configurable: true })
  try {
    return fn()
  } finally {
    Object.defineProperty(process, 'platform', descriptor)
  }
}

test('凭证文件权限收紧到「只有当前用户」', async () => {
  const { __test } = await import('../lib/index.js')
  const dir = tempDir('zhuli-acl-')
  const file = join(dir, 'secrets.json')
  try {
    writeFileSync(file, '{"token":"x"}')
    const mode = __test.hardenSecretsFile(file)
    if (process.platform === 'win32') {
      assert.equal(mode, 'win32-acl', 'Windows 应当走 icacls 路径')
      // GBK 输出：用 iconv 太麻烦，这里只做字节层面的判断
      const out = execFileSync('icacls', [file], { encoding: 'buffer' }).toString('latin1')
      assert.ok(!/Users/i.test(out) || !/BUILTIN/.test(out.replace(/Administrators/gi, '')), '不应保留 Users 组：' + out.slice(0, 200))
      assert.match(out, /\(F\)/, '当前用户必须有完全控制')

      const simulated = withPlatform('linux', () => __test.hardenSecretsFile(file))
      assert.equal(simulated, 'posix-0600', '模拟 POSIX 应当走 chmod 0600 路径')
      assert.equal(process.platform, 'win32', '必须恢复 process.platform 描述符')
    } else {
      assert.equal(mode, 'posix-0600', 'POSIX 应当走 chmod 0600 路径')
      assert.equal(statSync(file).mode & 0o777, 0o600, '应当只有 owner 可读写')
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
