import test from 'node:test'
import assert from 'node:assert/strict'

import {
  checkAttribution,
  checkPrAttribution,
  coAuthorLogins,
  formatResult,
  hasCodeBlock,
  parseAttributionSkips,
  referencedNumbers,
  runCli,
} from '../scripts/check-pr-attribution.mjs'

const REPO = 'MYCF711/dsh-session-superagent'
const ROOT = `/repos/${REPO}`

function pull(number, login) {
  return { number, user: { login } }
}

function commit(sha, login, message = 'implement fix', parentCount = 1) {
  return {
    sha,
    author: login ? { login } : null,
    parents: Array.from({ length: parentCount }, (_, index) => ({ sha: `parent-${index}` })),
    commit: { message },
  }
}

function fakeApi(routes) {
  const calls = []
  const api = async (requestPath) => {
    calls.push(requestPath)
    const path = requestPath.split('?')[0]
    if (!Object.hasOwn(routes, path)) throw new Error(`Unexpected API request: ${requestPath}`)
    const value = routes[path]
    if (value instanceof Error) throw value
    return typeof value === 'function' ? await value(requestPath) : value
  }
  api.calls = calls
  return api
}

function sharedCommitRoutes() {
  const shared = commit('shared-sha', 'external-author')
  return {
    [`${ROOT}/pulls/49`]: pull(49, 'maintainer'),
    [`${ROOT}/pulls/49/commits`]: [shared],
    [`${ROOT}/pulls/41`]: pull(41, 'external-author'),
    [`${ROOT}/pulls/41/commits`]: [shared],
  }
}

async function checkIssue39(message, { issue, comments = [] } = {}) {
  const api = fakeApi({
    [`${ROOT}/pulls/50`]: pull(50, 'maintainer'),
    [`${ROOT}/pulls/50/commits`]: [commit('fix-39-sha', 'maintainer', message)],
    [`${ROOT}/pulls/41`]: pull(41, 'external-author'),
    [`${ROOT}/pulls/41/commits`]: [],
    [`${ROOT}/issues/39`]: issue || {
      number: 39,
      user: { login: 'octocat' },
      author_association: 'CONTRIBUTOR',
      body: '建议改法\n```js\nconst answer = 42\n```\nSECRET_ISSUE_BODY',
    },
    [`${ROOT}/issues/39/comments`]: comments,
  })
  const result = await checkAttribution({ repo: REPO, pr: 50, against: 41, api })
  return { result, api }
}

test('维护者 #49 共享 #41 外部作者的提交：FAIL / exit 1', async () => {
  const result = await checkAttribution({
    repo: REPO,
    pr: 49,
    against: 41,
    api: fakeApi(sharedCommitRoutes()),
  })

  assert.equal(result.status, 'FAIL')
  assert.equal(result.exitCode, 1)
  assert.deepEqual(result.failures.map((failure) => failure.type), ['shared-commit'])
  assert.equal(result.failures[0].sha, 'shared-sha')
  assert.equal(result.failures[0].originalPr, 41)
  assert.match(formatResult(result), /应回 PR #41/)
})

test('客户 #41 自己就是共享提交的外部作者：PASS', async () => {
  const result = await checkAttribution({
    repo: REPO,
    pr: 41,
    against: 49,
    api: fakeApi(sharedCommitRoutes()),
  })

  assert.equal(result.status, 'PASS')
  assert.equal(result.exitCode, 0)
  assert.deepEqual(result.failures, [])
  assert.ok(result.passed.some((item) => item.type === 'own-commit'))
})

test('无 against 的 #49 枚举开放 #41 commits，共享外部提交仍 FAIL', async () => {
  const shared = commit('shared-sha', 'external-author')
  const api = fakeApi({
    [`${ROOT}/pulls/49`]: pull(49, 'maintainer'),
    [`${ROOT}/pulls/49/commits`]: [shared],
    [`${ROOT}/pulls`]: [pull(49, 'maintainer'), pull(41, 'external-author')],
    [`${ROOT}/pulls/41/commits`]: [shared],
  })

  const result = await checkAttribution({ repo: REPO, pr: 49, api })
  assert.equal(result.status, 'FAIL')
  assert.equal(result.exitCode, 1)
  assert.deepEqual(result.failures.map((failure) => failure.type), ['shared-commit'])
  assert.equal(result.failures[0].originalPr, 41)
  assert.ok(api.calls.some((path) => path.startsWith(`${ROOT}/pulls?state=open`)))
  assert.equal(api.calls.some((path) => path.includes('/commits/shared-sha/pulls')), false)
})

test('无 against 的 #41 全部 own commits，不调用开放 PR 列表且 PASS', async () => {
  const api = fakeApi({
    [`${ROOT}/pulls/41`]: pull(41, 'external-author'),
    [`${ROOT}/pulls/41/commits`]: [commit('own-sha', 'external-author')],
  })

  const result = await checkAttribution({ repo: REPO, pr: 41, api })
  assert.equal(result.status, 'PASS')
  assert.deepEqual(result.failures, [])
  assert.equal(api.calls.length, 2)
  assert.equal(api.calls.some((path) => path.startsWith(`${ROOT}/pulls?`)), false)
})

test('共享 merge commit（parents.length > 1）整条跳过', async () => {
  const merge = commit('merge-sha', 'external-author', 'merge #41', 2)
  const api = fakeApi({
    [`${ROOT}/pulls/49`]: pull(49, 'maintainer'),
    [`${ROOT}/pulls/49/commits`]: [merge],
    [`${ROOT}/pulls/41`]: pull(41, 'external-author'),
    [`${ROOT}/pulls/41/commits`]: [merge],
  })

  const result = await checkAttribution({ repo: REPO, pr: 49, against: 41, api })
  assert.equal(result.status, 'PASS')
  assert.deepEqual(result.failures, [])
  assert.deepEqual(result.skipped, [{ type: 'merge', sha: 'merge-sha' }])
  assert.equal(api.calls.some((path) => path.includes('/issues/')), false)
})

test('#39 外部贡献者有 js 代码但提交缺 Co-authored-by：FAIL', async () => {
  const { result } = await checkIssue39('fix #39')

  assert.equal(result.status, 'FAIL')
  assert.equal(result.exitCode, 1)
  assert.deepEqual(result.failures.map((failure) => failure.type), ['missing-coauthor'])
  assert.equal(result.failures[0].login, 'octocat')
  assert.equal(result.failures[0].ref, 39)
  const output = formatResult(result)
  assert.match(output, /缺少 Co-authored-by: octocat/)
  assert.equal(output.includes('SECRET_ISSUE_BODY'), false)
  assert.equal(output.includes('const answer'), false)
})

test('#39 补 ID+login@users.noreply.github.com 的 Co-authored-by：PASS', async () => {
  const { result } = await checkIssue39(
    'fix #39\n\nCo-authored-by: Octo Cat <123+octocat@users.noreply.github.com>',
  )

  assert.equal(result.status, 'PASS')
  assert.deepEqual(result.failures, [])
  assert.ok(result.passed.some((item) => item.type === 'co-author' && item.login === 'octocat'))
})

test('#39 Attribution-Skip: @octocat #39 精确跳过该贡献者：PASS', async () => {
  const { result } = await checkIssue39('fix #39\n\nAttribution-Skip: @octocat #39')

  assert.equal(result.status, 'PASS')
  assert.deepEqual(result.failures, [])
  assert.deepEqual(result.skipped.at(-1), {
    type: 'attribution-skip',
    ref: 39,
    login: 'octocat',
    sha: 'fix-39-sha',
  })
})

test('普通 reporter 的无源码定位复现 js 块不算贡献：PASS', async () => {
  const body = '普通复现如下，当前会抛错：\n```js\nconst current = broken()\n```'
  const { result } = await checkIssue39('fix #39', {
    issue: {
      number: 39,
      user: { login: 'reporter' },
      author_association: 'NONE',
      body,
    },
  })

  assert.equal(hasCodeBlock(body), false)
  assert.equal(result.status, 'PASS')
  assert.deepEqual(result.failures, [])
})

test('明确建议语境后的 js 改法块必须署名：FAIL', async () => {
  const body = '建议改成：\n```js\nconst fixed = repair()\n```'
  const { result } = await checkIssue39('fix #39', {
    issue: {
      number: 39,
      user: { login: 'reporter' },
      author_association: 'NONE',
      body,
    },
  })

  assert.equal(hasCodeBlock(body), true)
  assert.equal(result.status, 'FAIL')
  assert.deepEqual(result.failures.map((failure) => failure.login), ['reporter'])
})

test('源码定位行紧跟的复现 js 块不算贡献，不要求署名', async () => {
  const body = '`lib/index.js:1494`（`pollOnce` 内）：\n\n```js\nconst current = broken()\n```\n'
    + '`lib/index.js:1286`：\n\n```javascript\nconst alsoCurrent = true\n```'
  const { result } = await checkIssue39('fix #39', {
    issue: {
      number: 39,
      user: { login: 'ZhuDiGit' },
      author_association: 'CONTRIBUTOR',
      body,
    },
  })

  assert.equal(hasCodeBlock(body), false)
  assert.equal(result.status, 'PASS')
  assert.deepEqual(result.failures, [])
})

test('同 body 除源码定位复现块外另有改法块，仍需署名', async () => {
  const body = 'lib/index.js:1494\n```js\nconst current = broken()\n```\n'
    + '建议改成：\n```ts\nconst fixed: string = repair()\n```'
  const { result } = await checkIssue39('fix #39', {
    issue: {
      number: 39,
      user: { login: 'ZhuDiGit' },
      author_association: 'CONTRIBUTOR',
      body,
    },
  })

  assert.equal(hasCodeBlock(body), true)
  assert.equal(result.status, 'FAIL')
  assert.deepEqual(result.failures.map((failure) => failure.login), ['ZhuDiGit'])
})

test('diff 围栏即使有源码定位行也仍是贡献候选', async () => {
  const body = '`lib/index.mjs:20`\n```diff\n-old\n+new\n```'
  const { result } = await checkIssue39('fix #39', {
    issue: {
      number: 39,
      user: { login: 'fixriver' },
      author_association: 'CONTRIBUTOR',
      body,
    },
  })

  assert.equal(hasCodeBlock(body), true)
  assert.equal(result.status, 'FAIL')
  assert.deepEqual(result.failures.map((failure) => failure.login), ['fixriver'])
})

test('无 PR 上下文：SKIP / exit 0，且不调用 API', async () => {
  let called = false
  const api = async () => {
    called = true
    throw new Error('must not be called')
  }
  const result = await checkPrAttribution({ repo: REPO, against: 41, api })

  assert.equal(result.status, 'SKIP')
  assert.equal(result.exitCode, 0)
  assert.equal(result.reason, 'no-pr-context')
  assert.equal(called, false)

  const output = []
  const exitCode = await runCli([], { api, log: (line) => output.push(line) })
  assert.equal(exitCode, 0)
  assert.match(output.join('\n'), /^SKIP/)
  assert.equal(called, false)
})

test('OWNER 正文代码与外部纯文本评论不要求署名', async () => {
  const { result } = await checkIssue39('fix #39', {
    issue: {
      number: 39,
      user: { login: 'maintainer' },
      author_association: 'OWNER',
      body: '```diff\n-old\n+new\n```',
    },
    comments: [{
      user: { login: 'octocat' },
      author_association: 'CONTRIBUTOR',
      body: '这里没有代码围栏',
    }],
  })

  assert.equal(result.status, 'PASS')
  assert.deepEqual(result.failures, [])
})

test('外部评论里的 typescript 围栏别名 ts 也会触发检查', async () => {
  const { result } = await checkIssue39('fix #39', {
    issue: {
      number: 39,
      user: { login: 'maintainer' },
      author_association: 'MEMBER',
      body: '维护者正文没有代码',
    },
    comments: [{
      user: { login: 'commenter' },
      author_association: 'NONE',
      body: '建议改法：\n```ts\nexport const value: number = 1\n```',
    }],
  })

  assert.equal(result.status, 'FAIL')
  assert.equal(result.failures[0].login, 'commenter')
})

test('#N 指向 PR 而非 issue 时跳过，不读取评论', async () => {
  const { result, api } = await checkIssue39('fix #39', {
    issue: { number: 39, pull_request: { url: 'https://api.github.test/pulls/39' } },
  })

  assert.equal(result.status, 'PASS')
  assert.ok(result.skipped.some((item) => item.type === 'pr-reference' && item.ref === 39))
  assert.equal(api.calls.some((path) => path.includes('/issues/39/comments')), false)
})

test('CLI 注入 fake API：共享提交返回 1，日志不泄露 token 或 issue 正文', async () => {
  const logs = []
  const errors = []
  const exitCode = await runCli(
    ['--pr', '49', '--against', '41', '--repo', REPO],
    {
      api: fakeApi(sharedCommitRoutes()),
      env: { GH_TOKEN: 'super-secret-token' },
      log: (line) => logs.push(line),
      errorLog: (line) => errors.push(line),
    },
  )

  assert.equal(exitCode, 1)
  assert.match(logs.join('\n'), /^FAIL PR #49/)
  assert.deepEqual(errors, [])
  assert.equal(logs.join('\n').includes('super-secret-token'), false)
})

test('CLI API 错误返回非 0，并脱敏 token', async () => {
  const logs = []
  const errors = []
  const api = async () => {
    throw new Error('request failed with super-secret-token')
  }
  const exitCode = await runCli(
    ['--pr', '49', '--against', '41', '--repo', REPO],
    {
      api,
      env: { GH_TOKEN: 'super-secret-token' },
      log: (line) => logs.push(line),
      errorLog: (line) => errors.push(line),
    },
  )

  assert.equal(exitCode, 2)
  assert.deepEqual(logs, [])
  assert.match(errors.join('\n'), /^ERROR/)
  assert.equal(errors.join('\n').includes('super-secret-token'), false)
  assert.match(errors.join('\n'), /\*\*\*/)
})

test('CLI 默认 gh api 传输：mock execFile，token 只走环境且不进 argv', async () => {
  const routes = sharedCommitRoutes()
  const calls = []
  const execFileImpl = (file, args, options, callback) => {
    calls.push({ file, args, options })
    const path = args[1].split('?')[0]
    if (!Object.hasOwn(routes, path)) {
      callback(new Error(`Unexpected gh request: ${args[1]}`), '', 'gh: Not Found (HTTP 404)')
      return
    }
    callback(null, JSON.stringify(routes[path]), '')
  }
  const logs = []
  const errors = []
  const exitCode = await runCli(
    ['--pr', '49', '--against', '41', '--repo', REPO],
    {
      execFileImpl,
      env: { GH_TOKEN: 'super-secret-token' },
      log: (line) => logs.push(line),
      errorLog: (line) => errors.push(line),
    },
  )

  assert.equal(exitCode, 1)
  assert.match(logs.join('\n'), /^FAIL PR #49/)
  assert.deepEqual(errors, [])
  assert.equal(calls.length, 4)
  for (const call of calls) {
    assert.equal(call.file, 'gh')
    assert.equal(call.args[0], 'api')
    assert.equal(call.args.length, 2)
    assert.equal(call.args.join(' ').includes('super-secret-token'), false)
    assert.equal(call.options.env.GH_TOKEN, 'super-secret-token')
    assert.equal(call.options.encoding, 'utf8')
    assert.ok(call.options.timeout > 0)
  }
})

test('gh api 传输失败解析 HTTP 状态并脱敏 stderr', async () => {
  const execFileImpl = (file, args, options, callback) => {
    callback(
      new Error('command failed'),
      '',
      'gh: Not Found (HTTP 404); super-secret-token',
    )
  }
  const errors = []
  const exitCode = await runCli(
    ['--pr', '49', '--against', '41', '--repo', REPO],
    {
      execFileImpl,
      env: { GH_TOKEN: 'super-secret-token' },
      log: () => {},
      errorLog: (line) => errors.push(line),
    },
  )

  assert.equal(exitCode, 2)
  assert.match(errors.join('\n'), /HTTP 404/)
  assert.equal(errors.join('\n').includes('super-secret-token'), false)
})

test('显式注入 fetchImpl 时保持原 fetch 传输且不调用 gh', async () => {
  const routes = sharedCommitRoutes()
  const calls = []
  const fetchImpl = async (url, options) => {
    calls.push({ url, options })
    const path = url.replace('https://api.github.com', '').split('?')[0]
    if (!Object.hasOwn(routes, path)) return { ok: false, status: 404, text: async () => '{}' }
    return { ok: true, status: 200, text: async () => JSON.stringify(routes[path]) }
  }
  const exitCode = await runCli(
    ['--pr', '49', '--against', '41', '--repo', REPO],
    {
      fetchImpl,
      execFileImpl: () => { throw new Error('gh must not be called') },
      env: { GH_TOKEN: 'super-secret-token' },
      log: () => {},
      errorLog: () => {},
    },
  )

  assert.equal(exitCode, 1)
  assert.equal(calls.length, 4)
  assert.equal(calls[0].options.headers.Authorization, 'Bearer super-secret-token')
})

test('纯函数解析 #N、代码围栏、skip 与 noreply co-author', () => {
  assert.deepEqual(referencedNumbers('fix (#39), #39 and #41; C#12'), [39, 41])
  assert.equal(hasCodeBlock('solution:\n```javascript\nconst x = 1\n```'), true)
  assert.equal(hasCodeBlock('```python\nprint(1)\n```'), false)
  assert.deepEqual(parseAttributionSkips('Attribution-Skip: @octocat #39'), [
    { login: 'octocat', ref: 39 },
  ])
  assert.ok(coAuthorLogins(
    'Co-authored-by: Octo Cat <123+octocat@users.noreply.github.com>',
  ).has('octocat'))
})
