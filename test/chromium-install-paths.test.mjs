// verify-panel-chromium.mjs 的安装/仓库路径解析（0.10.8 修复：验的是旧安装、写死本机临时路径）。
//
// 事故：脚本曾写死 `D:/DeepSeek Harness/Desktop/resources/app.asar`。宿主早已是
// `Desktop-0.2.2-rc.1`，于是那套「真实 Chromium + 安装版 React/primitives」验的是旧前端资源；
// 仓库根还有一条回落到本机 `.tmp-issue9-push-…` 的兜底。
//
// 这里测的是 --print-paths 探针（只解析、不启动浏览器），所以不依赖 ego-browser。
import assert from 'node:assert/strict'
import test from 'node:test'
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tempDir } from './fixtures/tmpdir.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SCRIPT = join(ROOT, 'scripts', 'verify-panel-chromium.mjs')

function printPaths(env) {
  const out = execFileSync(process.execPath, [SCRIPT, '--print-paths'], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  })
  return JSON.parse(out)
}

/** 造一套「安装」：resources/app.asar + DeepSeek Harness.exe，app.asar 的 mtime 决定新旧。 */
function fakeInstall(parent, name, mtimeMs) {
  const root = join(parent, name)
  mkdirSync(join(root, 'resources'), { recursive: true })
  const asar = join(root, 'resources', 'app.asar')
  writeFileSync(asar, 'fake-asar:' + name)
  writeFileSync(join(root, 'DeepSeek Harness.exe'), 'fake-electron')
  utimesSync(asar, new Date(mtimeMs), new Date(mtimeMs))
  return { root, asar, electron: join(root, 'DeepSeek Harness.exe') }
}

const CLEAR = { DSH_INSTALL_ROOT: '', DSH_ASAR: '', DSH_ELECTRON: '' }

test('源码里不再写死旧 Desktop 安装与本机临时仓库路径', () => {
  const source = readFileSync(SCRIPT, 'utf8')
  assert.equal(source.includes('Desktop/resources/app.asar'), false, '不许写死旧 Desktop 安装')
  assert.equal(source.includes('.tmp-issue9-push'), false, '不许写死本机临时仓库路径')
})

test('多套安装共存：选 app.asar mtime 最新的那套（不静默验旧版）', () => {
  const base = tempDir('superagent-install-scan-')
  const older = fakeInstall(base, 'Desktop', Date.parse('2026-10-29T22:02:00Z'))
  const newer = fakeInstall(base, 'Desktop-0.2.2-rc.1', Date.parse('2026-11-05T00:27:00Z'))
  const paths = printPaths({ ...CLEAR, DSH_INSTALL_SCAN: base })
  assert.equal(paths.installRoot, newer.root)
  assert.equal(paths.asar, newer.asar)
  assert.notEqual(paths.asar, older.asar)
  assert.match(paths.source, /scan/)
})

test('显式 DSH_ASAR + DSH_ELECTRON 优先于扫描结果', () => {
  const base = tempDir('superagent-install-explicit-')
  const explicit = fakeInstall(base, 'Desktop-explicit', Date.parse('2026-10-01T00:00:00Z'))
  const newer = fakeInstall(base, 'Desktop-newer', Date.parse('2026-11-06T00:00:00Z'))
  const paths = printPaths({ ...CLEAR, DSH_INSTALL_SCAN: base, DSH_ASAR: explicit.asar, DSH_ELECTRON: explicit.electron })
  assert.equal(paths.asar, explicit.asar)
  assert.notEqual(paths.asar, newer.asar)
  assert.equal(paths.installRoot, dirname(dirname(explicit.asar)))
  assert.match(paths.source, /DSH_ASAR/)
})

test('只给 DSH_ASAR 不给 DSH_ELECTRON 要报错（不许验半套安装）', () => {
  const base = tempDir('superagent-install-half-')
  const only = fakeInstall(base, 'Desktop-half', Date.now())
  let code = 0
  let err = ''
  try {
    execFileSync(process.execPath, [SCRIPT, '--print-paths'], {
      cwd: ROOT,
      encoding: 'utf8',
      env: { ...process.env, ...CLEAR, DSH_INSTALL_SCAN: base, DSH_ASAR: only.asar },
    })
  } catch (error) {
    code = typeof error.status === 'number' ? error.status : 1
    err = String(error.stderr || '')
  }
  assert.notEqual(code, 0)
  assert.match(err, /必须同时给/)
})
