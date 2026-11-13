// 文档里提到的「工具名 / 路由 / 面板小节」必须真的存在。
//
// 为什么需要：README 与 docs 里的标识符是客户会照着敲的；重构改名后文档不会报错，
// 只有人去试才发现。版本号与链接已有门禁，这里补的是**标识符**。
//
// 用法：node scripts/audit-claims-consistency.mjs
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const index = readFileSync(join(root, 'lib', 'index.js'), 'utf8')
const client = readFileSync(join(root, 'client.js'), 'utf8')

// 真实存在的工具与路由
const tools = new Set([...index.matchAll(/name: '(watch_[a-z_]+)'/g)].map((m) => m[1]))
const routes = new Set([...index.matchAll(/path: '(\/session-superagent\/[a-z-]+)'/g)].map((m) => m[1]))

// 面板里真实存在的小节标题
const sectionTitles = new Set([...client.matchAll(/title: '([^']{2,24})'/g)].map((m) => m[1]))

// 要检查的文档
// 审核 T25：以前清单写死 5 份文档 —— 其余 40+ 份里的死工具名 / 死路由完全看不见。
// 改成扫描**全部** Markdown；只跳过 CHANGELOG（它记录历史，允许出现已经删掉的名字）与报告类（历史快照）。
// 点号开头的目录（`.git` / `.superpowers` / `.tmp-*` 之类）一律不扫：
// 那是本地工作区，里面的 task 报告会写 `watch_pr_*` 这类通配占位，不是客户会照着敲的文档。
const collectDocs = (dir, out = []) => {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.')) continue
    const full = join(dir, name)
    if (statSync(full).isDirectory()) { collectDocs(full, out); continue }
    if (!name.endsWith('.md')) continue
    if (name === 'CHANGELOG.md') continue
    out.push(full)
  }
  return out
}
const docs = collectDocs(root).map((full) => full.slice(root.length + 1).replace(/\\/g, '/')).filter((rel) => !rel.split('/').pop().startsWith('报告-'))

const mentionsTools = []
const mentionsRoutes = []
const mentionsSections = []

for (const name of docs) {
  const text = readFileSync(join(root, name), 'utf8')
  for (const match of text.matchAll(/`?(watch_[a-z_]+)`?/g)) mentionsTools.push({ doc: name, id: match[1] })
  for (const match of text.matchAll(/`(\/session-superagent\/[a-z-]+)`/g)) mentionsRoutes.push({ doc: name, id: match[1] })
  for (const match of text.matchAll(/「([^」]{2,12})」/g)) mentionsSections.push({ doc: name, id: match[1] })
}

const badTools = [...new Set(mentionsTools.map((m) => m.id))].filter((id) => !tools.has(id))
const badRoutes = [...new Set(mentionsRoutes.map((m) => m.id))].filter((id) => !routes.has(id))
// 小节标题只警告不失败：文档里的「」多是引用概念，不一定是我们面板的标题
const unknownSections = [...new Set(mentionsSections.map((m) => m.id))]
  .filter((id) => !sectionTitles.has(id))

console.log('工具 ' + tools.size + ' 个：' + [...tools].join(' '))
console.log('路由 ' + routes.size + ' 条')
console.log('文档提到的工具 ' + new Set(mentionsTools.map((m) => m.id)).size + ' 个 / 路由 ' + new Set(mentionsRoutes.map((m) => m.id)).size + ' 条')
console.log('---')

let failed = false
if (badTools.length > 0) {
  failed = true
  console.log('FAIL 文档里提到但不存在的工具：' + badTools.join('、'))
  for (const id of badTools) {
    const owners = [...new Set(mentionsTools.filter((m) => m.id === id).map((m) => m.doc))]
    console.log('  ' + id + '  ← ' + owners.join(', '))
  }
} else {
  console.log('PASS 文档里提到的工具名都真实存在')
}

if (badRoutes.length > 0) {
  failed = true
  console.log('FAIL 文档里提到但不存在（或已改名）的路由：' + badRoutes.join('、'))
} else {
  console.log('PASS 文档里提到的路由都真实存在')
}

if (unknownSections.length > 0) {
  console.log('提示 这些「」不是面板小节标题（多半是概念引用，正常）：' + unknownSections.slice(0, 8).join('、') + (unknownSections.length > 8 ? ' …' : ''))
}

if (failed) process.exitCode = 1
