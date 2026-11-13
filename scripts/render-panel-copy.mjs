// 面板文案快照：把四个 tab 上「客户会读到的字」导出成一份文档。
//
// 为什么：唤醒消息已经有文案快照（docs/示例-唤醒消息.md），但**面板上那几十条提示**
// 一直是"改了也没人看见"。这里用与测试相同的渲染桩，把可见文字抽出来。
//
// 用法：
//   node scripts/render-panel-copy.mjs           # 打印
//   node scripts/render-panel-copy.mjs --write   # 写入 docs/面板文案.md
//   node scripts/render-panel-copy.mjs --check   # 与文件比对
import { existsSync, writeFileSync } from 'node:fs'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { deskForm, deskQueue, loadClient, walk, watcher } from '../test/fixtures/panel-harness.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const target = join(root, 'docs', '面板文案.md')

const snap = {
  loading: false,
  error: null,
  body: {
    sessionGoal: null,
    sessionTitle: '会话 x',
    credentials: {},
    sessionUsage: { used: 3, cap: 12, capped: 1, suggest: 18 },
    watchers: [
      watcher('acme/widgets', {
        id: 'acme/widgets#s1',
        // 2026-11-04 修：原先这里钉死 '2026-11-02T09:55:00.000Z'，而 client.js 把它渲染成「N 小时前」
        // ⇒ 快照每过一小时就漂一格，`--check` 在 CI 上周期性变红（17:25 那次就是 47→48 导致的）。
        // 改成「相对生成时刻固定 47 小时前」：输出恒定，快照不再随真实时间腐烂。
        lastWake: new Date(Date.now() - 47 * 3600 * 1000).toISOString(),
        deferReason: 'cap-session',
        lastDeferred: '这条会话一小时内已被唤醒 12 次',
        silentWakes: 2,
        daily: { days: 3, total: 9, avg: 3, today: 4 },
        busy: true,
        repoAccess: { push: false, archived: false, hasIssues: true },
        lastError: 'GitHub API 请求: EOF',
      }),
    ],
  },
}

const { registrations, render } = loadClient()
const desk = registrations.find((r) => r.opts.id === 'session-superagent-desk')

// 「监控类型」切到 PR：审计 / 对抗性审计 / 执行方式三项的 `when` 是 `watchKind === 'pr'`，
// 停在默认的 issue 上就永远不会渲染，文案快照里也就看不到它们。
// 只在本脚本里改（deskForm 是模块级对象，独立进程跑完即弃），不动测试夹具的默认形态。
deskForm.watchKind = 'pr'

const TABS = [
  ['overview', '总览'],
  ['judge', '判定'],
  ['trigger', '触发'],
  ['settings', '设置'],
]

const lines = []
lines.push('# 面板文案（由 `scripts/render-panel-copy.mjs` 生成，不要手改）')
lines.push('')
lines.push('四个 tab 上客户能读到的文字。改文案会让 `--check` 变红 —— **改动必须是有意的**。')
lines.push('')

for (const [tab, label] of TABS) {
  const tree = render(desk, deskQueue(snap, null, {}, tab))
  const text = walk(tree)
    .filter((node) => node.type === '#text')
    .map((node) => node.text.trim())
    .filter(Boolean)
  const unique = []
  for (const item of text) if (!unique.includes(item)) unique.push(item)
  lines.push('## ' + label + '（' + tab + '）')
  lines.push('')
  lines.push('`' + unique.length + '` 条文字：')
  lines.push('')
    for (const item of unique) lines.push('- ' + item.replace(/\n/g, ' '))
  lines.push('')
}

// 首次使用（空态）：没配守、没凭证、没有用量 —— 客户第一眼看到的东西
const emptySnap = {
  loading: false,
  error: null,
  body: { sessionGoal: null, sessionTitle: null, credentials: {}, sessionUsage: null, watchers: [] },
}

for (const [tab, label] of TABS) {
  const tree = render(desk, deskQueue(emptySnap, null, {}, tab))
  const text = walk(tree)
    .filter((node) => node.type === '#text')
    .map((node) => node.text.trim())
    .filter(Boolean)
  const unique = []
  for (const item of text) if (!unique.includes(item)) unique.push(item)
  if (tab === 'overview') {
    lines.push('## 首次使用（空态 · ' + label + '）')
    lines.push('')
    lines.push('`' + unique.length + '` 条文字：')
    lines.push('')
    for (const item of unique) lines.push('- ' + item.replace(/\n/g, ' '))
    lines.push('')
  }
}

const body = lines.join(String.fromCharCode(10)) + String.fromCharCode(10)

// 分级门禁：面板里允许少数长句，但不允许越来越多。
// 上限取 3 —— 超过就说明"这次又想用长句糊过去"，该拆了。
const LIMIT_CHARS = 80
const MAX_LONG = 3
const allText = lines.filter((line) => line.startsWith('- ')).map((line) => line.slice(2))
const longOnes = allText.filter((item) => [...item].length > LIMIT_CHARS)
const worst = allText.reduce((max, item) => Math.max(max, [...item].length), 0)

const mode = process.argv[2] || ''
const limitFlag = process.argv.indexOf('--limit')
const maxLong = limitFlag > 0 ? Number(process.argv[limitFlag + 1]) : MAX_LONG

if (mode === '--write') {
  writeFileSync(target, body)
  console.log('已写入 docs/面板文案.md（' + body.split(String.fromCharCode(10)).length + ' 行）')
} else if (mode === '--check') {
  const saved = existsSync(target) ? readFileSync(target, 'utf8') : ''
  const stats = '最长 ' + worst + ' 字符；超过 ' + LIMIT_CHARS + ' 字符的 ' + longOnes.length + ' 条（上限 ' + maxLong + '）'
  if (longOnes.length > maxLong) {
    console.log('FAIL ' + stats)
    for (const item of longOnes.slice(0, 5)) console.log('  ' + [...item].length + ' 字符：' + item.slice(0, 50))
    process.exitCode = 1
  } else if (saved === body) {
    console.log('PASS 面板文案与当前实现一致（' + body.split(String.fromCharCode(10)).length + ' 行；' + stats + '）')
  } else {
    const savedLines = saved.split(String.fromCharCode(10))
    const nowLines = body.split(String.fromCharCode(10))
    const changed = nowLines.filter((line, index) => savedLines[index] !== line).length
    console.log('提示 面板文案有变化：约 ' + changed + ' 行不同 —— 确认后跑 node scripts/render-panel-copy.mjs --write')
    process.exitCode = 1
  }
} else {
  console.log(body)
}
