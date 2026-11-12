// 量一下 /state 在守很多时有多大 —— 先量再决定要不要裁剪。
//
// 判据（写死）：单次 /state 超过 100 KB 才值得动；否则裁剪只会增加复杂度。
//
// 用法：node scripts/measure-state.mjs [数量...]
import { statusView } from '../lib/watch.js'

const counts = process.argv.slice(2).map(Number).filter((n) => n > 0)
const sizes = counts.length > 0 ? counts : [1, 5, 20, 50, 100]

function makeWatcher(index) {
  const now = Date.now()
  return {
    id: 'acme/repo-' + index + '#session-1',
    repo: 'acme/repo-' + index,
    sessionId: 'session-1',
    intervalSec: 60,
    enabled: true,
    observe: index % 7 === 0,
    isolated: index % 5 === 0,
    activeHours: index % 4 === 0 ? '09:00-23:00' : null,
    filters: { labels: index % 3 === 0 ? ['ai-fix', 'bug'] : [], onlyAssigned: index % 2 === 0 },
    deferReason: index % 9 === 0 ? 'cap-session' : null,
    lastDeferred: index % 9 === 0 ? '这条会话一小时内已被唤醒 12 次' : null,
    silentWakes: index % 11 === 0 ? 2 : 0,
    cursor: new Date(now - index * 60000).toISOString(),
    lastPoll: new Date(now - index * 30000).toISOString(),
    lastWake: index % 2 === 0 ? new Date(now - index * 120000).toISOString() : null,
    lastError: index % 13 === 0 ? 'GitHub API 请求: EOF（网络抖动：已按退避自动重试，不需要手动处理）' : null,
    lastReopened: index % 17 === 0 ? 42 : null,
    repoAccess: { push: index % 6 !== 0, archived: false, hasIssues: true },
    filteredLog: Array.from({ length: 5 }, (_, k) => ({ at: new Date(now - k * 1000).toISOString(), number: 100 + k, title: '示例条目 ' + k, reason: '已关闭' })),
    absorbedLog: Array.from({ length: 5 }, (_, k) => ({ at: new Date(now - k * 1000).toISOString(), number: 200 + k, title: '被吸收的条目 ' + k })),
    history: Array.from({ length: 10 }, (_, k) => ({ at: new Date(now - k * 60000).toISOString(), numbers: [100 + k], ok: true, reason: null })),
  }
}

console.log('守数量 | statusView JSON | 每守平均')
console.log('---|---|---')
const rows = []
for (const count of sizes) {
  const list = Array.from({ length: count }, (_, i) => makeWatcher(i))
  // 模拟 /state 的真实形状：比 statusView 还多 filteredLog(5) / history(5) / events(20)
  const view = statusView(list)
  view.watchers = view.watchers.map((w, index) => ({
    ...w,
    // 弹层「最近唤醒的是哪一条」：只有 /state 投影有（statusView 不带给工具），
    // 单条对象；不放进 fixture 就量不出它对请求体积的真实贡献
    lastWakeItem: index % 2 === 0
      ? { number: String(100 + index), title: '插件安装后工具同名重复注册（示例标题，接近真实长度）', kind: index % 3 === 0 ? 'pr' : 'issue' }
      : null,
    filteredLog: list[index].filteredLog.slice(-5),
    history: list[index].history.slice(-5),
    // 按新的预算算：每守 min(6, 240/N) 条
    events: Array.from({ length: Math.max(1, Math.min(6, Math.floor(240 / count))) }, (_, k) => ({
      at: new Date(Date.now() - k * 60000).toISOString(),
      kind: k % 3 === 0 ? 'wake' : (k % 3 === 1 ? 'filter' : 'poll'),
      text: '第 ' + k + ' 条事件的说明文字，长度接近真实情况',
    })),
  }))
  const t0 = performance.now()
  const json = JSON.stringify(view)
  const ms = performance.now() - t0
  const bytes = Buffer.byteLength(json, 'utf8')
  rows.push({ count, bytes, ms })
  console.log(count + ' | ' + (bytes / 1024).toFixed(1) + ' KB | ' + (bytes / count / 1024).toFixed(2) + ' KB')
}

// 判据按"现实上限"定：面板是会话级的，一个会话挂 20 条守已经很极端（100 条不是目标）。
// 100 条守时靠"每守事件数随总数收缩"控制增长率，不是零成本。
const LIMIT_KB = 50
const REALISTIC = 20
const realistic = rows.find((row) => row.count === REALISTIC) || rows[rows.length - 1]
const worst = realistic
if (worst.bytes / 1024 > LIMIT_KB) {
  console.log('---')
  console.log('FAIL ' + worst.count + ' 条守时 ' + (worst.bytes / 1024).toFixed(1) + ' KB，超过 ' + LIMIT_KB + ' KB 上限（现实上限）—— 需要裁剪字段')
  process.exitCode = 1
} else {
  console.log('---')
  console.log('PASS ' + worst.count + ' 条守（现实上限）' + (worst.bytes / 1024).toFixed(1) + ' KB ≤ ' + LIMIT_KB + ' KB；' +
    '生成耗时 ' + worst.ms.toFixed(1) + ' ms')
}
