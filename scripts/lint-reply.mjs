#!/usr/bin/env node
/**
 * 本地回复门禁：在发 issue/PR 评论之前跑，PASS 才允许发。
 *
 * 为什么不是 GitHub Actions：Actions 只能事后看到评论，拦不住已经发出去的内容。
 * 这里只查「明显串台」，不评价文风，也不自动改写。
 *
 * 用法：
 *   node scripts/lint-reply.mjs --body-file draft.md --current 15
 *   echo "..." | node scripts/lint-reply.mjs --current 15
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const CHECKS = [
  ['绝对路径', /(?:^|[\s(])(?:[A-Za-z]:[\\/]|\/(?:d|c|e)\/|\\\\Users\\\\)/m],
  ['本机运行版本', /\b(?:runningVersion|serverVersion|installedVersion)\b/],
  ['本机/开发机口吻', /(?:本机|开发机|宿主当前|这台机器|我这台)/],
  ['后台任务', /(?:ComfyUI|后台任务|job[_ -]?id|bash-[0-9a-f]{8})/i],
  ['内部任务 ID', /\b(?:n|e|goal|session)[-_]?[0-9a-f]{4,}\b/i],
  ['凭证/密钥', /(?:ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9]{20,}|-----BEGIN [A-Z ]*PRIVATE KEY-----)/],
  ['未发布版本承诺', /(?:计划|下个版本|以后|稍后).{0,20}\d+\.\d+\.\d+/],
]

/** 返回问题列表；空数组 = 通过。 */
export function lintReply(text, { current } = {}) {
  const body = String(text ?? '').trim()
  const issues = []
  if (!body) issues.push('空回复')
  for (const [label, re] of CHECKS) {
    if (re.test(body)) issues.push(label)
  }
  if (current !== undefined && current !== null && String(current) !== '') {
    const refs = [...body.matchAll(/#(\d+)/g)].map((m) => m[1])
    const foreign = [...new Set(refs.filter((n) => n !== String(current)))]
    if (foreign.length > 0) issues.push('引用了其它 issue/PR：# ' + foreign.join(', #'))
  }
  return issues
}

function main() {
  const args = process.argv.slice(2)
  const get = (name) => {
    const i = args.indexOf(name)
    return i >= 0 ? args[i + 1] : undefined
  }
  const file = get('--body-file')
  const current = get('--current')
  let body = ''
  try {
    body = file ? readFileSync(resolve(file), 'utf8') : readFileSync(0, 'utf8')
  } catch (error) {
    console.error('FAIL 回复门禁：读不到正文（' + String(error && error.message || error) + '）')
    process.exit(2)
  }
  const issues = lintReply(body, { current })
  if (issues.length === 0) {
    console.log('PASS 回复门禁：只谈论当前 issue/PR 自身')
    return
  }
  console.log('FAIL 回复门禁：' + issues.length + ' 项')
  for (const issue of issues) console.log('  - ' + issue)
  process.exit(1)
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) main()
