#!/usr/bin/env node
/**
 * dsh-gate 命令行：把一份回复正文跑一遍门禁，用退出码表达结果。
 *
 * 退出码：0 = 通过（warn 不阻断），1 = 有 error 命中，2 = 用法 / 配置 / IO 错误。
 *
 * 例：
 *   node bin/gate.mjs --trigger issue.reply --body-file draft.md --current 15
 *   printf '正文' | node bin/gate.mjs --trigger pr.reply --body-file - --current 15 --json
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  SEMANTIC_TRIGGERS,
  TRIGGERS,
  lintText,
  loadGateConfig,
  validateConfig,
} from '../lib/index.js'
import { semanticReview } from '../lib/semantic.js'

const USAGE = [
  '用法: dsh-gate --trigger <trigger> --body-file <path|-> [--current <编号>] [--repo <目录>] [--json] [--semantic] [--config <文件>]',
  '',
  '  --trigger    ' + TRIGGERS.join(' | '),
  '  --body-file  回复正文；传 - 从 stdin 读',
  '  --current    当前 issue/PR 编号；缺省时 foreign-ref 规则跳过（无法判断“其它”）',
  '  --repo       仓库目录（用于 .superagent/gates.json 与 gates.local.json）',
  '  --config     直接使用一份配置，不读四层（调试 / CI 用）',
  '  --semantic   在 merge / release 上强制跑语义复审（仍受配置里的模型开关约束）',
  '  --json       输出 JSON',
  '  --help       显示本帮助',
  '',
  '退出码: 0 通过 | 1 未通过 | 2 用法或配置错误',
].join('\n')

class UsageError extends Error {}

function parseArgs(argv) {
  const options = {
    trigger: '',
    bodyFile: '',
    current: undefined,
    repo: process.cwd(),
    config: '',
    json: false,
    semantic: false,
    help: false,
  }
  const valueFlags = new Set(['--trigger', '--body-file', '--current', '--repo', '--config'])
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--help' || arg === '-h') {
      options.help = true
      continue
    }
    if (arg === '--json') {
      options.json = true
      continue
    }
    if (arg === '--semantic') {
      options.semantic = true
      continue
    }
    const equal = arg.indexOf('=')
    if (equal !== -1 && valueFlags.has(arg.slice(0, equal))) {
      const name = arg.slice(0, equal)
      const value = arg.slice(equal + 1)
      assignOption(options, name, value)
      continue
    }
    if (valueFlags.has(arg)) {
      const value = argv[index + 1]
      if (value === undefined) throw new UsageError(arg + ' 需要一个值')
      index += 1
      assignOption(options, arg, value)
      continue
    }
    throw new UsageError('未知参数：' + arg)
  }
  return options
}

function assignOption(options, name, value) {
  if (name === '--trigger') options.trigger = value
  else if (name === '--body-file') options.bodyFile = value
  else if (name === '--current') options.current = value
  else if (name === '--repo') options.repo = value
  else if (name === '--config') options.config = value
}

function readStdin() {
  return new Promise((resolvePromise, reject) => {
    const chunks = []
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', (chunk) => chunks.push(chunk))
    process.stdin.on('end', () => resolvePromise(chunks.join('')))
    process.stdin.on('error', reject)
  })
}

async function readBody(bodyFile) {
  if (!bodyFile) throw new UsageError('缺少 --body-file（传 - 从 stdin 读）')
  if (bodyFile === '-') return readStdin()
  return readFileSync(resolve(bodyFile), 'utf8')
}

function printHuman({ ok, trigger, hits, semantic }) {
  if (ok) {
    const tail = hits.length === 0 ? '无命中' : hits.length + ' 项警告（不阻断）'
    console.log('PASS ' + trigger + '  ' + tail)
  } else {
    const errors = hits.filter((hit) => hit.severity === 'error').length
    console.log('FAIL ' + trigger + '  ' + errors + ' 项未通过')
  }
  for (const hit of hits) {
    console.log('  [' + hit.severity + '] ' + hit.id + ' ' + hit.label + '：' + hit.message)
  }
  if (semantic && semantic.warning) console.log('  [semantic] ' + semantic.warning)
}

async function main(argv) {
  const options = parseArgs(argv)
  if (options.help) {
    console.log(USAGE)
    return 0
  }
  if (!options.trigger) throw new UsageError('缺少 --trigger')
  if (!TRIGGERS.includes(options.trigger)) {
    throw new UsageError('未知 trigger：' + options.trigger + '（可选：' + TRIGGERS.join(' / ') + '）')
  }
  if (options.current !== undefined && !/^\d+$/.test(String(options.current))) {
    throw new UsageError('--current 必须是数字编号')
  }
  const text = await readBody(options.bodyFile)
  let config
  if (options.config) {
    const checked = validateConfig(JSON.parse(readFileSync(resolve(options.config), 'utf8')))
    if (!checked.ok) throw new UsageError('配置非法：' + checked.error)
    config = checked.config
  } else {
    config = loadGateConfig({ repo: resolve(options.repo) }).config
  }
  const deterministic = lintText(text, config, { trigger: options.trigger, current: options.current })
  const hits = [...deterministic.hits]
  let semantic = { skipped: true }
  const semanticEnabled = Boolean(config.semantic && config.semantic.enabled === true)
  if (SEMANTIC_TRIGGERS.includes(options.trigger) && (options.semantic || semanticEnabled)) {
    if (!deterministic.ok) {
      // 先确定性、后语义：硬门禁已经不过，就不再请求模型（也不把正文发出去）。
      semantic = { skipped: true, reason: '硬门禁未通过，未请求模型' }
    } else {
      semantic = await semanticReview(text, config, { trigger: options.trigger, current: options.current })
      hits.push(...(semantic.hits || []))
    }
  }
  const ok = hits.every((hit) => hit.severity !== 'error')
  const result = { ok, trigger: options.trigger, current: options.current === undefined ? null : options.current, hits, semantic }
  if (options.json) console.log(JSON.stringify(result, null, 2))
  else printHuman(result)
  return ok ? 0 : 1
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code
  },
  (error) => {
    const message = error instanceof UsageError ? error.message : String((error && error.message) || error)
    console.error('gate: ' + message)
    process.exitCode = 2
  },
)
