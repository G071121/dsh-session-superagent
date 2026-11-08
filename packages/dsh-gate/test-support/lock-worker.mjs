#!/usr/bin/env node
/**
 * C1 的真实多进程用例执行体（由 test/config-lock.test.mjs 拉起）。
 *
 * 用法：
 *   node lock-worker.mjs counter <configPath> <counterPath> <iterations>
 *   node lock-worker.mjs write <repo> <home> <iterations> <none|plain> [lockTimeoutMs]
 *
 * 退出码：0 = 成功；2 = 写盘显式失败（stdout 输出 JSON：{ ok:false, code, message }）。
 *
 * `counter` 模式故意把临界区放大到 5ms：没有跨进程锁时，两个进程的「读 → 写」必然互相
 * 覆盖（计数丢更新），有锁时计数必须一次不少 —— 这是锁真的生效、而不是单进程 Promise
 * 链「看起来串行」的判据。
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { acquireGateConfigLock, writeGateConfig } from '../lib/index.js'

const args = process.argv.slice(2)
const [mode] = args

/** 同步睡眠：临界区要真的占用一段时间，才能暴露并发窗口。 */
function sleep(ms) {
  if (!(ms > 0)) return
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

function readCounter(path) {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    return Number(parsed && parsed.value) || 0
  } catch {
    return 0
  }
}

function criticalSection(counterPath) {
  const value = readCounter(counterPath)
  sleep(5)
  writeFileSync(counterPath, JSON.stringify({ value: value + 1 }) + '\n', 'utf8')
}

function rule(id) {
  return {
    id,
    label: '规则 ' + id,
    type: 'contains',
    value: '禁止词-' + id,
    triggers: ['issue.reply'],
    message: '命中',
  }
}

function payload(variant, index) {
  if (variant === 'none') {
    return { version: 1, name: 'project', extends: 'none', rules: [rule('none-' + index)] }
  }
  return { version: 1, name: 'project', rules: [rule('plain-' + index)] }
}

if (mode === 'counter') {
  const [, configPath, counterPath, rawIterations] = args
  const iterations = Number(rawIterations)
  mkdirSync(dirname(configPath), { recursive: true })
  for (let index = 0; index < iterations; index += 1) {
    const lock = acquireGateConfigLock(configPath, { timeoutMs: 20000 })
    try {
      criticalSection(counterPath)
    } finally {
      lock.release()
    }
  }
  process.stdout.write(JSON.stringify({ ok: true, mode, iterations, waitedMs: 0 }) + '\n')
} else if (mode === 'write') {
  const [, repo, home, rawIterations, variant, rawLockTimeoutMs] = args
  const iterations = Number(rawIterations)
  const lockTimeoutMs = rawLockTimeoutMs === undefined ? 15000 : Number(rawLockTimeoutMs)
  try {
    for (let index = 0; index < iterations; index += 1) {
      writeGateConfig('project', payload(variant, index), { repo, home, env: {}, lockTimeoutMs })
    }
    process.stdout.write(JSON.stringify({ ok: true, mode, variant, iterations }) + '\n')
  } catch (error) {
    process.stdout.write(JSON.stringify({
      ok: false,
      code: (error && error.code) || null,
      message: String((error && error.message) || error),
    }) + '\n')
    process.exitCode = 2
  }
} else {
  process.stderr.write('未知模式：' + String(mode) + '\n')
  process.exitCode = 2
}
