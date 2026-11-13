// 守跑了一个月会长到多大？—— 用真实的时间推进模拟，不靠推理。
//
// 判据：20 条守跑满 30 天，watchers.json 不超过 200 KB（约等于 10 KB/守）。
// 超过就说明有数组没封顶。
//
// 用法：node scripts/measure-growth.mjs [天数]
import { bumpDailyWakes, pruneSeen, pruneWakeTimes, pushAbsorbed, pushEvent, pushFiltered, pushHistory } from '../lib/watch.js'

const DAYS = Number(process.argv[2]) || 30
const WATCHERS = 20
// 为了能在几秒内跑完，按「每 10 分钟一次」模拟（真实默认是 60 秒）；
// 各数组都封顶，轮询次数只影响到达上限的速度，不影响最终体积。
const POLLS_PER_DAY = 144
const DAY_MS = 24 * 3600 * 1000
const now0 = Date.now() - DAYS * DAY_MS

const state = {}
for (let w = 0; w < WATCHERS; w += 1) {
  state['acme/r' + w + '#s'] = { repo: 'acme/r' + w, events: [], history: [], filteredLog: [], absorbedLog: [], seen: {}, wakeTimes: [], dailyWakes: null, lastWakeItem: null }
}

const kb = (value) => (Buffer.byteLength(JSON.stringify(value)) / 1024).toFixed(1)

function row(label) {
  const first = Object.values(state)[0]
  const sizes = {
    events: first.events.length, history: first.history.length, filtered: first.filteredLog.length,
    absorbed: first.absorbedLog.length, seen: Object.keys(first.seen).length, wakeTimes: first.wakeTimes.length,
  }
  console.log(label.padEnd(7), (kb(state) + ' KB').padStart(9), JSON.stringify(sizes))
}

row('第0天')
let issue = 1000
for (let day = 1; day <= DAYS; day += 1) {
  for (let poll = 0; poll < POLLS_PER_DAY; poll += 1) {
    const now = now0 + day * DAY_MS + poll * 60000
    const at = new Date(now).toISOString()
    for (const key of Object.keys(state)) {
      const entry = state[key]
      entry.events = pushEvent(entry.events, { kind: 'poll', text: '每轮一条事件（模拟）', at })
      // 真实的推进方式是"新条目入水"，这里每 30 轮造一条新条目
      if (poll % 30 === 0) {
        issue += 1
        entry.seen[String(issue)] = at
      }
      entry.seen = pruneSeen(entry.seen, { now })
      if (poll % 20 === 0) entry.filteredLog = pushFiltered(entry.filteredLog, { at, number: issue, title: '标题', reason: '已关闭' })
      if (poll % 30 === 0) entry.absorbedLog = pushAbsorbed(entry.absorbedLog, [{ number: issue, title: '标题' }], at)
      if (poll % 60 === 0) {
        entry.history = pushHistory(entry.history, { at, numbers: [issue], ok: true })
        entry.dailyWakes = bumpDailyWakes(entry.dailyWakes, at)
        entry.wakeTimes = pruneWakeTimes([...entry.wakeTimes, at], at)
        // 每次唤醒覆盖成最新一条（恒定单条，不随天数增长）
        entry.lastWakeItem = { number: String(issue), title: '汉'.repeat(60), kind: 'issue' }
      }
    }
  }
  if ([1, 7, 30].includes(day) || day === DAYS) row('第' + day + '天')
}

const totalKb = Number(kb(state))
const LIMIT_KB = 200
if (totalKb > LIMIT_KB) {
  console.log('---')
  console.log('FAIL ' + WATCHERS + ' 条守跑 ' + DAYS + ' 天 = ' + totalKb + ' KB，超过 ' + LIMIT_KB + ' KB —— 有数组没封顶')
  process.exitCode = 1
} else {
  console.log('---')
  console.log('PASS ' + WATCHERS + ' 条守跑 ' + DAYS + ' 天 = ' + totalKb + ' KB ≤ ' + LIMIT_KB + ' KB（' +
    (totalKb / WATCHERS).toFixed(1) + ' KB/守）')
}
