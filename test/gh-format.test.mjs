// Gitee / GitHub 错误文本分类的单元测试：只测纯函数 classifyGhError，不联网。
//
// 为什么单独一个文件：Gitee 的报错**没有** `HTTP <code>` 前缀，形状和 GitHub 完全不同，
// 而 classifyGhError 原来是照着 GitHub 的形状写的 —— 于是 Gitee 的 404 / 401 / 429
// 全落到 other，客户看到「没归类的错误」，根本想不到是标签名写错了。
//
// 真实响应（2026-11-05 本机 curl 复刻，可原样重放）：
//   $ curl -sS -o /dev/null -w 'HTTP %{http_code} | %{size_download} bytes | %{content_type}\n' \
//       https://gitee.com/MYCF711/workbuddy-pro/labels/__no_such__
//   HTTP 404 | 7187 bytes | text/html; charset=utf-8
//     <title>你所访问的页面不存在 (404)</title>
//     <h3>你所访问的页面不存在！</h3>
//   $ curl -sS https://gitee.com/api/v5/repos/MYCF711/workbuddy-pro/labels/__no_such__
//   HTTP 404 | 27 bytes | {"message":"404 Not Found"}
//   同一天另一个接口回的正文是 {"message":"Not Found Project"}（31 bytes）
//   token 失效：HTTP 401 | {"message":"401 Unauthorized: Access token does not exist"}
//   限流：      HTTP 429（只有状态行，没有正文）
import assert from 'node:assert/strict'
import test from 'node:test'

import { classifyGhError } from '../lib/gh-format.js'

// 真实 Gitee 404 页的骨架（原页 7187 字节，这里只留分类要用的那几行，其余是 CSS / JS / 页脚）。
const GITEE_HTML_404 = [
  '<!DOCTYPE html>',
  '<html>',
  '',
  '<head>',
  '  <meta http-equiv="Content-Type" content="text/html; charset=UTF-8" />',
  '  <title>你所访问的页面不存在 (404)</title>',
  '</head>',
  '',
  '<body>',
  '  <div class="container error midCenter">',
  '    <div class="image-box"><img src="/static/errors/images/404.png"></div>',
  '    <h3>你所访问的页面不存在！</h3>',
  '    <p>资源不存在或者没有访问权限，<a href="/">点击这里</a>返回首页</p>',
  '  </div>',
  '</body>',
  '</html>',
].join('\n')

/** Gitee 的「标签/仓库/编号不存在」必须三个词都说到，否则客户还是不知道该去改哪。 */
function assertGiteeNotFound(why, label) {
  assert.equal(why.kind, 'notfound', label + ' 应归 notfound，实际 ' + why.kind + '（' + why.hint + '）')
  assert.match(why.hint, /Gitee/, label + ' 的提示要点名 Gitee：' + why.hint)
  for (const word of ['标签', '仓库', '编号']) {
    assert.ok(why.hint.includes(word), label + ' 的提示要提到「' + word + '」：' + why.hint)
  }
  assert.ok(why.hint.includes('不存在'), label + ' 的提示要说清是「不存在」：' + why.hint)
  assert.ok(why.short.length > 0, label + ' 缺可读描述')
}

test('Gitee 404 的 HTML 页：标签不存在要归 notfound，而不是「没归类」', () => {
  // 改之前这条是红的：整段 HTML 里既没有 `HTTP 404` 也没有 `Not Found`（只有「404」和「页面不存在」），
  // 于是命中文件末尾的兜底 → kind: 'other'，客户看到「（没归类的错误…）」。
  const why = classifyGhError(GITEE_HTML_404)
  assertGiteeNotFound(why, 'Gitee HTML 404 页')
})

test('Gitee 404 的 JSON 正文：Not Found Project 也要指向标签/仓库/编号', () => {
  const shapes = [
    '{"message":"Not Found Project"}',
    '{"message":"404 Not Found"}',
    // 真机把状态行、字节数、正文拼成一行时也要认（curl -w 那种输出）
    'HTTP 404 | 31 bytes | {"message":"Not Found Project"}',
    'HTTP 404 | 27 bytes | {"message":"404 Not Found"}',
  ]
  for (const text of shapes) {
    const why = classifyGhError(text)
    assertGiteeNotFound(why, text)
  }
})

test('Gitee 401：Access token does not exist 要归 auth，并指向 Gitee 私人令牌', () => {
  const shapes = [
    '{"message":"401 Unauthorized: Access token does not exist"}',
    'HTTP 401 | 65 bytes | {"message":"401 Unauthorized: Access token does not exist"}',
  ]
  for (const text of shapes) {
    const why = classifyGhError(text)
    assert.equal(why.kind, 'auth', text + ' 应归 auth，实际 ' + why.kind)
    assert.match(why.hint, /Gitee/, text + ' 的提示要点名 Gitee：' + why.hint)
    assert.ok(why.hint.includes('私人令牌'), text + ' 的提示要指向「Gitee 私人令牌」：' + why.hint)
  }
})

test('Gitee 429：只有状态行也要归 ratelimit（不是「没归类」）', () => {
  for (const text of ['HTTP 429', 'HTTP 429 | 0 bytes', '429 Too Many Requests']) {
    const why = classifyGhError(text)
    assert.equal(why.kind, 'ratelimit', text + ' 应归 ratelimit，实际 ' + why.kind)
    assert.ok(why.hint.length > 0, text + ' 缺下一步')
    assert.match(why.hint, /等/, text + ' 的提示要告诉客户「等」：' + why.hint)
  }
})

test('GitHub 的报错不能被 Gitee 规则抢走（措辞边界）', () => {
  // 401：GitHub 的正文是 Bad credentials，不是 401 Unauthorized
  const auth = classifyGhError('HTTP 401: Bad credentials')
  assert.equal(auth.kind, 'auth')
  assert.ok(auth.hint.includes('gh auth login'), 'GitHub 401 仍要指向 gh auth login：' + auth.hint)

  // 404：GitHub 的正文是 Not Found（没有 Project / 没有前缀 404）
  for (const text of ['HTTP 404: Not Found', '{"message":"Not Found"}']) {
    const why = classifyGhError(text)
    assert.equal(why.kind, 'notfound', text + ' → ' + why.kind)
    assert.ok(why.hint.includes('owner/name'), 'GitHub 404 仍要指向 owner/name：' + why.hint)
    assert.ok(!why.hint.includes('Gitee'), 'GitHub 的 404 不该提 Gitee：' + why.hint)
  }

  // 这几条老分类完全不变
  assert.equal(classifyGhError('gh: command not found').kind, 'nogh')
  assert.equal(classifyGhError('HTTP 403: API rate limit exceeded').kind, 'ratelimit')
  assert.equal(classifyGhError('HTTP 502 Bad Gateway').kind, 'gateway')
  assert.equal(classifyGhError('HTTP 304 Not Modified').kind, 'notmodified')
  assert.equal(classifyGhError('Repository has been moved').kind, 'moved')
  assert.equal(classifyGhError('Get "https://api.github.com/repos/a/b/issues?per_page=20": EOF').kind, 'network')
})

test('Gitee 的中文 401 也要归 auth（真机回的是中文）', async () => {
  const { classifyGhError } = await import('../lib/gh-format.js')
  // 真机实测：{"message":"登录失效，无权限访问该资源","code":40001}
  assert.equal(classifyGhError('{"message":"登录失效，无权限访问该资源","code":40001}').kind, 'auth')
  assert.equal(classifyGhError('登录失效').kind, 'auth')
})

test('Gitee 的 403 限流不能判成「凭证失效」（会让人去重生成 token）', async () => {
  const { classifyGhError } = await import('../lib/gh-format.js')
  // 线上真机形状：HTTP/1.1 403 + 正文 "403 Forbidden (Rate Limit Exceeded)"
  assert.equal(classifyGhError('403 Forbidden (Rate Limit Exceeded)').kind, 'ratelimit')
  // 纯 403（无正文）仍按「没权限」处理（不是限流）
  assert.equal(classifyGhError('HTTP 403 Forbidden').kind, 'permission')
})

test('`gh` 找不到的判据不能宽到抢走 404', async () => {
  const { classifyGhError } = await import('../lib/gh-format.js')
  // 以前 /not found.*gh/ 会把这条判成 nogh（安装 gh 命令）
  assert.notEqual(classifyGhError('HTTP 404: Not Found for owner/ghost-repo').kind, 'nogh')
  // 真正的「命令不存在」仍然要认
  assert.equal(classifyGhError('gh: command not found').kind, 'nogh')
})

// ── Issue #39 Bug 2：REST 兜底取「最后一条评论」 ─────────────────────────────
// 旧写法 `comments?per_page=1&sort=created&direction=desc` + `.[0]` 是错的：
// GitHub 的 issue comments 接口**不支持** `sort` / `direction`（那是 issue 列表的参数），
// 传了会被静默忽略，`per_page=1` 于是恒返回**最早**一条 —— 唤醒消息里的
// 「最后评论」永远停在第一条，会话误判成「对方没回复」后继续 ack 掉。
//
// 正确取法（lib/gh-format.js · lastCommentArgs）：`per_page=100` + `--paginate`，
// 再用 `--jq '.[-1] | {login: .user.login, at: .created_at}'`。`--paginate` 下
// `--jq` 是**逐页**执行的，stdout 每页一行，所以解析（parseLastComment）必须取
// **最后一行有效记录**，否则评论超过 100 条时只能看到第 100 条。

test('REST 兜底取最后评论：参数形状严格锁死（per_page=100 + --paginate + .[-1]）', async () => {
  const mod = await import('../lib/gh-format.js')
  assert.equal(typeof mod.lastCommentArgs, 'function', '缺少 lastCommentArgs 纯函数（Issue #39 Bug 2）')
  // 严格相等：URL、分页、jq 表达式一个字都不许多、一个字都不许少
  assert.deepEqual(mod.lastCommentArgs('owner/repo', 89), [
    'api',
    'repos/owner/repo/issues/89/comments?per_page=100',
    '--paginate',
    '--jq',
    '.[-1] | {login: .user.login, at: .created_at}',
  ])
  // 查询串只允许 per_page 一个参数，且值必须是 100（接口上限）
  const search = mod.lastCommentArgs('owner/repo', 89)[1].split('?')[1] || ''
  const params = new URLSearchParams(search)
  assert.deepEqual([...params.keys()], ['per_page'], '查询串只该有 per_page：' + search)
  assert.equal(params.get('per_page'), '100', '一页必须拉满 100 条，否则多页之间会漏评论')
})

test('REST 兜底取最后评论：反向锁住 sort / direction / per_page=1 / .[0] 四种旧写法', async () => {
  const mod = await import('../lib/gh-format.js')
  assert.equal(typeof mod.lastCommentArgs, 'function', '缺少 lastCommentArgs 纯函数（Issue #39 Bug 2）')
  const args = mod.lastCommentArgs('owner/repo', 89)
  const joined = args.join(' ')
  // 这四种写法每一种单独出现都会让「最后评论」退化（sort/direction 被忽略、per_page=1 取最早、.[0] 取首条）
  assert.ok(!joined.includes('sort='), '不许再带 sort=（comments 接口不认）：' + joined)
  assert.ok(!joined.includes('direction='), '不许再带 direction=（comments 接口不认）：' + joined)
  assert.ok(!/[?&]per_page=1(?:&|$)/.test(joined), '不许再出现 per_page=1（恒返回最早一条）：' + joined)
  assert.ok(!joined.includes('.[0]'), '不许再用 .[0]（取的是第一页第一条）：' + joined)
  assert.ok(joined.includes('--paginate'), '必须有 --paginate，否则超过 100 条时看不到最后一条：' + joined)
  assert.ok(joined.includes('.[-1]'), '必须用 .[-1] 取每页最后一条：' + joined)
})

test('REST 兜底取最后评论：多页 stdout 取最后一条有效记录（含 CRLF / 空行 / 空页 null）', async () => {
  const mod = await import('../lib/gh-format.js')
  assert.equal(typeof mod.parseLastComment, 'function', '缺少 parseLastComment 纯函数（Issue #39 Bug 2）')
  const page1 = '{"login":"first","at":"2026-11-09T02:19:11Z"}'
  const page2 = '{"login":"middle","at":"2026-11-09T03:00:00Z"}'
  const page3 = '{"login":"last","at":"2026-11-09T04:30:44Z"}'
  const last = { login: 'last', at: '2026-11-09T04:30:44Z' }
  // 三页（LF）：第 3 页的最后一条才是全线程最后一条
  assert.deepEqual(mod.parseLastComment([page1, page2, page3].join('\n')), last)
  // Windows / 真机 gh 可能吐 CRLF；行尾差异不能改变结果
  assert.deepEqual(mod.parseLastComment([page1, page2, page3].join('\r\n')), last)
  // 空行、行尾空白、末尾多一个换行都不该被当成一条记录
  assert.deepEqual(mod.parseLastComment([page1, '', page2, '  ', page3, '', ''].join('\r\n')), last)
  // --paginate 的最后一页为空时 jq 会输出 null：跳过它，取上一页的最后一条
  assert.deepEqual(mod.parseLastComment([page1, page2, page3, 'null', ''].join('\n')), last)
  // 单页只有一行：原样返回
  assert.deepEqual(mod.parseLastComment(page3 + '\n'), last)
  // 缺 at：login 仍然可用，at 补空串（消息里只显示人）
  assert.deepEqual(mod.parseLastComment('{"login":"helper"}'), { login: 'helper', at: '' })
})

test('REST 兜底取最后评论：空 / 坏 JSON / login 为空一律 null（不抛、不阻断唤醒）', async () => {
  const mod = await import('../lib/gh-format.js')
  assert.equal(typeof mod.parseLastComment, 'function', '缺少 parseLastComment 纯函数（Issue #39 Bug 2）')
  const cases = [
    '', '   ', '\r\n\r\n', 'null', 'undefined',
    'not json', '{"login":', '[]', '"just a string"', '123',
    '{"login":""}', '{"login":null}', '{"login":"   "}', '{"user":{"login":"x"}}',
    undefined, null,
  ]
  for (const bad of cases) {
    assert.equal(mod.parseLastComment(bad), null, '输入 ' + JSON.stringify(bad) + ' 应返回 null')
  }
  // 尾部坏 JSON 时不回退到上一条：宁可少一行，也不展示可能已经过期的评论
  assert.equal(mod.parseLastComment('{"login":"old","at":"2026-11-09T02:19:11Z"}\nnot json'), null)
})

test('额度推迟：deferReason 必须是稳定原因，时间只能出现在人读的那句话里（T20 真 bug 回归）', async () => {
  const { quotaDeferText, DEFER_REASONS } = await import('../lib/gh-format.js')
  const t = quotaDeferText(10, 30 * 60 * 1000, Date.parse('2026-11-05T09:00:00Z'))
  // 旧 bug：'quota' + '09:30' + 'Z' = 'quota09:30Z' —— 面板按 DEFER_LABELS 查不到，筛选永远空
  assert.equal(t.reason, 'quota')
  assert.ok(DEFER_REASONS.includes(t.reason), 'reason 必须是已知的稳定值')
  assert.ok(!t.reason.includes(':'), 'reason 里不许掺时间')
  assert.ok(t.text.includes('09:30'), '时间里该在人读的那句里')
  assert.ok(t.text.includes('剩余 10'), '要说清还剩多少')
  // 负数/非法不该崩
  assert.equal(quotaDeferText(1, -5000, Date.parse('2026-11-05T09:00:00Z')).reason, 'quota')
  assert.equal(quotaDeferText(1, 'x', 0).reason, 'quota')
})
