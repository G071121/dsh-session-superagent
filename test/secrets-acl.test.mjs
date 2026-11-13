// 凭证文件权限收紧：Windows 上 chmod 无效（Node 文档 fs.chmod Caveats 写明
// owner/group/others 的区分根本没实现），所以实现里补了 icacls；POSIX 上走 chmod 0600。
//
// 这条用例两个平台都要跑：以前 `skip: process.platform !== 'win32'` 让 Linux 上的
// 用例数比本地少 1，README 的单测数在 CI 上必然对不上（2026-11-13 CI 红）。
import { execFileSync } from 'node:child_process'
import { tempDir } from './fixtures/tmpdir.mjs'
import { rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'

test('凭证文件权限收紧到「只有当前用户」', async () => {
  const { __test } = await import('../lib/index.js')
  const dir = tempDir('zhuli-acl-')
  const file = join(dir, 'secrets.json')
  try {
    writeFileSync(file, '{"token":"x"}')
    const mode = __test.hardenSecretsFile(file)
    assert.notEqual(mode, 'failed', '权限收紧不能失败')
    if (process.platform === 'win32') {
      // GBK 输出：用 iconv 太麻烦，这里只做字节层面的判断
      const out = execFileSync('icacls', [file], { encoding: 'buffer' }).toString('latin1')
      assert.ok(!/Users/i.test(out) || !/BUILTIN/.test(out.replace(/Administrators/gi, '')), '不应保留 Users 组：' + out.slice(0, 200))
      assert.match(out, /\(F\)/, '当前用户必须有完全控制')
    } else {
      assert.equal(statSync(file).mode & 0o777, 0o600, '应当只有 owner 可读写')
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
