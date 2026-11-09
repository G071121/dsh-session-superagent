// 真实 Chromium + 安装版 DSH tokens/React + 真实 client.js desk：primary 按钮对比度定向验收。
// 运行：timeout 240 ego-browser nodejs < scripts/verify-panel-button-contrast.mjs
// 独立 loopback fake API；不进入真实 DSH Web GUI，不访问 GitHub/npm，不执行保存或安装更新。

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import http from 'node:http'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = process.env.DSH_SUPERAGENT_REPO
  || (import.meta.url.startsWith('file:') && !import.meta.url.includes('[eval')
    ? resolve(dirname(fileURLToPath(import.meta.url)), '..')
    : 'D:/DeepSeek Harness/大肥鱼工作区/dsh-session-superagent')
const ASAR = 'D:/DeepSeek Harness/Desktop/resources/app.asar'
const ELECTRON = 'D:/DeepSeek Harness/Desktop/DeepSeek Harness.exe'
const FRONTEND = `${ASAR}/dsh/node_modules/@deepseek-ai/dsh-web-frontend`
const THEME_CLIENT = `${ASAR}/dsh/node_modules/@deepseek-ai/dsh-client-ui-theme/lib/client.js`
const SCREENSHOTS = `${REPO}/docs/assets`
const SESSION_ID = 'session-panel-button-contrast-fixture'
const SPACE_NAME = 'dsh-panel-button-contrast-0.9.274'
const results = []
const measurements = []
const artifacts = []
const screenshotSkips = []
const apiLog = []
const unverified = [
  '未进入需要真实会话与凭证的 DSH Web GUI；本脚本验证独立 loopback 页面中真实 client.js 的 slot 注册与 desk Component 挂载。',
  '未执行保存、安装更新、删除或真实轮询；所有 mutation 路由固定返回只读拒绝，测试只切换页签和编辑本地草稿。',
  '只量静态默认态；未量 :hover、:active、:focus-visible、动画中途、文本抗锯齿或截图像素。WCAG 比值由 computed style 的颜色与 opacity 合成。',
  '禁用控件按 WCAG 1.4.3 豁免，仍记录颜色、opacity 和参考比值，但不计入文字对比度 PASS/FAIL。',
  '会话 goal 分区本身没有普通 Btn；未添加测试 DOM，普通 Btn 对照来自同一设置页的版本与更新分区。',
]

function check(name, pass, detail) {
  const row = { name, pass: Boolean(pass), detail }
  results.push(row)
  console.log(`${row.pass ? 'PASS' : 'FAIL'} ${name}${detail === undefined ? '' : ` ${JSON.stringify(detail)}`}`)
  return row.pass
}

function sha256(body) {
  return createHash('sha256').update(body).digest('hex')
}

function srgbChannelToLinear(value) {
  const v = value <= 0 ? 0 : value >= 1 ? 1 : value
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)
}

function relativeLuminance(color) {
  return 0.2126 * srgbChannelToLinear(color.r / 255)
    + 0.7152 * srgbChannelToLinear(color.g / 255)
    + 0.0722 * srgbChannelToLinear(color.b / 255)
}

function contrastRatio(a, b) {
  const la = relativeLuminance(a)
  const lb = relativeLuminance(b)
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05)
}

function hex(color) {
  const part = (value) => Math.max(0, Math.min(255, Math.round(value))).toString(16).padStart(2, '0')
  return '#' + part(color.r) + part(color.g) + part(color.b)
}

function loadInstalledAssets() {
  const reader = String.raw`
const fs = require('fs');
const crypto = require('crypto');
const root = process.argv[1];
const dist = root + '/dist';
const html = fs.readFileSync(dist + '/index.html', 'utf8');
const names = [];
for (const match of html.matchAll(/(?:src|href)="\.\/(assets\/[^"]+)"/g)) {
  if (/\.(?:js|css)$/.test(match[1]) && !names.includes(match[1])) names.push(match[1]);
}
const assets = {};
for (const name of names) {
  const body = fs.readFileSync(dist + '/' + name);
  assets[name] = { base64: body.toString('base64'), sha256: crypto.createHash('sha256').update(body).digest('hex') };
}
const pkg = JSON.parse(fs.readFileSync(root + '/package.json', 'utf8'));
const themeClient = fs.readFileSync(process.argv[3], 'utf8');
const themeStyles = {};
for (const match of themeClient.matchAll(/var ([A-Za-z0-9_]+_css_default) = ("(?:[^"\\]|\\.)*");/g)) {
  themeStyles[match[1]] = JSON.parse(match[2]);
}
const requiredThemeStyles = [
  'base_css_default', 'corner_shape_css_default', 'design_platform_css_default',
  'focus_css_default', 'onboarding_css_default', 'scrollbar_css_default',
  'gradient_shadow_text_css_default', 'shiki_css_default',
];
for (const name of requiredThemeStyles) {
  if (typeof themeStyles[name] !== 'string') throw new Error('missing official theme style: ' + name);
}
process.stdout.write(JSON.stringify({
  frontendVersion: pkg.version,
  primitivesRange: pkg.devDependencies?.['@deepseek-ai/dsh-client-ui-primitives'] || null,
  electron: process.versions.electron,
  electronNode: process.version,
  html,
  assets,
  themeStyles: Object.fromEntries(requiredThemeStyles.map((name) => [name, themeStyles[name]])),
}));
`
  const output = execFileSync(ELECTRON, ['-e', reader, FRONTEND, ASAR, THEME_CLIENT], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
    timeout: 30000,
  })
  const parsed = JSON.parse(output)
  parsed.asarSha256 = sha256(readFileSync(ASAR))
  for (const asset of Object.values(parsed.assets)) asset.body = Buffer.from(asset.base64, 'base64')
  return parsed
}

const CAPTURE_FACADE = `
window.__captureErrors = [];
window.__networkViolations = [];
window.__slotEvents = [];
window.__registrations = {};
window.__requiredModules = [];
window.__ModuleLoader__ = {
  create(options) {
    window.__capturedModules = options.staticModules;
    window.__captured = true;
    throw new Error('intentional-capture-stop: staticModules captured; DSH application boot not started');
  },
  load(options) {
    window.__clientFactory = options.factory;
    window.__clientModuleId = options.id;
    window.__clientCaptured = true;
  },
};
window.addEventListener('error', (event) => {
  window.__captureErrors.push({ kind: 'error', message: String(event.message || event.error || '') });
});
window.addEventListener('unhandledrejection', (event) => {
  window.__captureErrors.push({ kind: 'unhandledrejection', message: String(event.reason || '') });
});
const nativeFetch = window.fetch.bind(window);
window.fetch = (input, init) => {
  const raw = typeof input === 'string' ? input : input && input.url;
  const url = new URL(raw, location.href);
  if (url.origin !== location.origin) {
    const detail = { url: url.href, method: init?.method || 'GET' };
    window.__networkViolations.push(detail);
    return Promise.reject(new Error('harness 禁止外部请求：' + url.href));
  }
  return nativeFetch(input, init);
};
`

const HARNESS_CSS = `
html, body { margin: 0; min-height: 100%; background: var(--dsw-alias-bg-base); }
body { color: var(--dsw-alias-label-primary); font-family: var(--dsw-font-family); }
#root { display: none !important; }
#app { height: 100vh; min-height: 640px; }
button, input, textarea { font: inherit; }
`

const HARNESS_MODULE = `
try {
  const deadline = Date.now() + 15000;
  while (!window.__captured && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
  if (!window.__captured) throw new Error('没有从安装 bundle 捕获 staticModules');
  const modules = window.__capturedModules;
  const React = modules.react;
  const ReactDOM = modules['react-dom/client'];
  const primitives = modules['@deepseek-ai/dsh-client-ui-primitives'];
  await import('/client.js');
  if (!window.__clientCaptured) throw new Error('真实 client.js 未调用 __ModuleLoader__.load');
  const localRequire = (name) => {
    window.__requiredModules.push(name);
    if (Object.prototype.hasOwnProperty.call(modules, name)) return modules[name];
    if (name === 'cordis' || name === 'zod') return {};
    throw new Error('安装 bundle 未提供模块：' + name);
  };
  const plugin = window.__clientFactory(localRequire);
  const ctx = {
    effect(fn) { return fn(); },
    slots: {
      inject(name, fn) {
        window.__slotEvents.push({ type: 'inject', name });
        return fn();
      },
      register(options, Component) {
        window.__registrations[options.id] = { options, Component };
        window.__slotEvents.push({ type: 'register', name: options.name, id: options.id });
        return () => { window.__slotEvents.push({ type: 'dispose', id: options.id }); };
      },
    },
  };
  plugin.apply(ctx);
  const desk = window.__registrations['session-superagent-desk'];
  if (!desk || typeof desk.Component !== 'function') throw new Error('slots.register 未捕获 session-superagent-desk Component');
  window.__verifyMeta = {
    reactVersion: React.version,
    primitiveExportCount: Object.keys(primitives).length,
    primitivesIdentity: primitives === modules['@deepseek-ai/dsh-client-ui-primitives'],
    hostButtonType: typeof primitives.Button,
    clientModuleId: window.__clientModuleId,
    desk: { ...desk.options, componentType: typeof desk.Component },
    slotEvents: window.__slotEvents,
  };
  ReactDOM.createRoot(document.getElementById('app')).render(React.createElement(desk.Component, { sessionId: ${JSON.stringify(SESSION_ID)} }));
  window.__harnessReady = true;
} catch (error) {
  window.__harnessError = String(error && error.stack || error);
  throw error;
}
`

function htmlFor(installed) {
  const styles = Object.keys(installed.assets).filter((name) => name.endsWith('.css'))
  const entry = Object.keys(installed.assets).find((name) => name.endsWith('.js') && /index-/.test(name))
  if (!entry) throw new Error('安装 dist/index.html 中没有入口 JS')
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>panel primary button contrast</title>
${styles.map((name) => `<link rel="stylesheet" href="/${name}">`).join('\n')}
<style>${Object.values(installed.themeStyles).join('\n')}</style>
<style>${HARNESS_CSS}</style>
<script>${CAPTURE_FACADE}</script>
</head><body data-ds-dark-theme="true"><div id="root"></div><div id="app"></div>
<script type="module" src="/${entry}"></script>
<script type="module">${HARNESS_MODULE.replaceAll('</script', '<\\/script')}</script>
</body></html>`
}

function makeFixture(version) {
  const now = Date.now()
  const iso = (ms) => new Date(now - ms).toISOString()
  return {
    state: {
      routeBase: '/session-superagent', serverVersion: version,
      runningVersion: version, installedVersion: version,
      sessionTitle: '按钮对比度验收',
      sessionGoal: { objective: '固定 goal：验证 primary 按钮', phase: 'active', revision: 1 },
      defaults: { sessionMaxWakes: 12, maxWakesPerHour: 6, isolateKeepDays: 3, batchLimit: 5 },
      retryPolicy: { budgetAttempts: 6, slowCapMinutes: 120 },
      sessionUsage: { used: 2, cap: 12, capped: 0 },
      tokenScopes: { ok: true, scopes: ['repo', 'read:org'] },
      isolation: { roots: [], totalBytes: 0 },
      gh: { ok: true, version: 'gh version 2.101.0-fixture' },
      credentials: { token: 'configured', sshKeyPath: 'none', ghConfigDir: 'configured', giteeToken: 'none' },
      triageSignals: [
        { key: 'reopened', label: '被重新打开', kind: 'fact', weight: 100, default: true, why: '固定事实信号' },
        { key: 'comments', label: '有人评论', kind: 'fact', weight: 10, default: true, why: '固定评论信号' },
      ],
      watchers: [{
        id: `acme/widgets#${SESSION_ID}`, repo: 'acme/widgets', provider: 'github', sessionId: SESSION_ID,
        title: '活动 watcher fixture', intervalSec: 60, enabled: true, observe: false,
        isolated: false, activeHours: '', note: '处理固定 issue', ackLabel: '主理鱼:已处理',
        lastPoll: iso(15000), lastWake: iso(300000), lastError: null,
        filters: { labels: ['ai-fix'], ignoreLabels: [], onlyAssigned: false, assignee: null, allowAuthors: [] },
        priority: { reopened: true, comments: true, labels: true, unassigned: false, stale: false },
        history: [{ at: iso(300000), numbers: [42], ok: true, reason: null }],
        filteredLog: [], filterCounts: {}, events: [],
        quality: { itemsWoken: 1, itemsAcked: 1, actionRate: 1 },
        repoAccess: { repo: 'acme/widgets', push: true, hasIssues: true },
        daily: { days: 1, total: 1 },
      }],
    },
    // 只让安装更新入口出现；不点击，mutation 仍由 server 拒绝。
    update: { current: version, latest: '0.9.275-fixture', hasUpdate: true, command: 'fixture-no-command' },
    trace: { traces: [] },
    diagnose: { text: `session-superagent ${version}\nrouteBase=/session-superagent\nfixture=true` },
  }
}

function json(response, status, body) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  response.end(JSON.stringify(body))
}

async function startServer(installed, clientSource, fixture) {
  const html = htmlFor(installed)
  const server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://127.0.0.1')
      const method = request.method || 'GET'
      let requestBody = ''
      for await (const chunk of request) requestBody += chunk
      if (url.pathname.startsWith('/session-superagent')) {
        apiLog.push({ method, path: url.pathname + url.search, body: requestBody })
      }
      if (method === 'GET' && url.pathname === '/session-superagent/state') return json(response, 200, fixture.state)
      if (method === 'GET' && url.pathname === '/session-superagent/update') return json(response, 200, fixture.update)
      if (method === 'GET' && url.pathname === '/session-superagent/trace') return json(response, 200, fixture.trace)
      if (method === 'GET' && url.pathname === '/session-superagent/diagnose') return json(response, 200, fixture.diagnose)
      if (method === 'GET' && url.pathname === '/session-superagent/client-note') return json(response, 200, { ok: true, fixture: true })
      if (url.pathname.startsWith('/session-superagent/') && method !== 'GET') {
        return json(response, 403, { error: 'fixture-read-only：本验收禁止所有写操作' })
      }
      if (url.pathname === '/') {
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
        return response.end(html)
      }
      if (url.pathname === '/client.js') {
        response.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' })
        return response.end(clientSource)
      }
      const name = url.pathname.slice(1)
      const asset = installed.assets[name]
      if (asset) {
        response.writeHead(200, {
          'content-type': name.endsWith('.css') ? 'text/css; charset=utf-8' : 'text/javascript; charset=utf-8',
          'cache-control': 'no-store',
        })
        return response.end(asset.body)
      }
      return json(response, 404, { error: 'not found', path: url.pathname })
    } catch (error) {
      return json(response, 500, { error: String(error && error.message || error) })
    }
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  return { server, origin: `http://127.0.0.1:${address.port}` }
}

// 此函数由 ego-browser 序列化进页面；不得引用 Node 侧变量。
function measureButtonInPage(config) {
  const nodes = [...document.querySelectorAll(config.selector)]
    .filter((node) => !config.text || node.textContent.replace(/\s+/g, ' ').trim() === config.text)
  if (nodes.length !== 1) {
    throw new Error(`${config.name}: 期望唯一按钮，实际 ${nodes.length}；selector=${config.selector}; text=${config.text}`)
  }
  const el = nodes[0]
  const style = getComputedStyle(el)
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = 1
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) throw new Error('无法创建颜色解析 canvas')

  function parseColor(value) {
    if (!value) return null
    ctx.fillStyle = '#010203'
    ctx.fillStyle = value
    if (ctx.fillStyle === '#010203' && String(value).trim().toLowerCase() !== '#010203') {
      throw new Error('Chromium 无法解析 computed color: ' + value)
    }
    ctx.clearRect(0, 0, 1, 1)
    ctx.fillRect(0, 0, 1, 1)
    const pixel = ctx.getImageData(0, 0, 1, 1).data
    return { r: pixel[0], g: pixel[1], b: pixel[2], a: pixel[3] / 255 }
  }

  function over(bottom, top) {
    const ba = bottom.a ?? 1
    const ta = top.a ?? 1
    const a = ta + ba * (1 - ta)
    if (a <= 0) return { r: 0, g: 0, b: 0, a: 0 }
    const channel = (t, b) => Math.round((t * ta + b * ba * (1 - ta)) / a)
    return { r: channel(top.r, bottom.r), g: channel(top.g, bottom.g), b: channel(top.b, bottom.b), a }
  }

  function parentBackdrop(start) {
    const layers = []
    let node = start
    let backgroundImages = []
    while (node && node.nodeType === 1) {
      const current = getComputedStyle(node)
      if (current.backgroundImage && current.backgroundImage !== 'none') {
        backgroundImages.push({ tag: node.tagName, className: node.className, value: current.backgroundImage })
      }
      const color = parseColor(current.backgroundColor)
      if (color && color.a > 0) layers.unshift(color)
      if (color && color.a >= 0.999) break
      node = node.parentElement
    }
    let background = { r: 255, g: 255, b: 255, a: 1 }
    for (const layer of layers) background = over(background, layer)
    return { background, backgroundImages }
  }

  let effectiveOpacity = 1
  let ancestor = el
  const opacityChain = []
  while (ancestor && ancestor.nodeType === 1) {
    const value = Number(getComputedStyle(ancestor).opacity)
    if (Number.isFinite(value)) effectiveOpacity *= value
    opacityChain.push({ tag: ancestor.tagName, id: ancestor.id, className: ancestor.className, opacity: getComputedStyle(ancestor).opacity })
    ancestor = ancestor.parentElement
  }

  const foreground = parseColor(style.color)
  const ownBackground = parseColor(style.backgroundColor)
  if (!foreground || !ownBackground) throw new Error(config.name + ': color/backgroundColor 解析失败')
  const parent = parentBackdrop(el.parentElement)
  if (style.backgroundImage && style.backgroundImage !== 'none') {
    parent.backgroundImages.push({ tag: el.tagName, className: el.className, value: style.backgroundImage })
  }
  if (parent.backgroundImages.length) {
    throw new Error(config.name + ': 背景含 background-image，本脚本不把 backgroundColor 冒充实际可见背景')
  }

  // 按钮作为 group：先在其自身底色上画文字，再按整棵按钮的有效 opacity 叠到父背景。
  const offscreenText = over(ownBackground, foreground)
  const paintedText = over(parent.background, { ...offscreenText, a: offscreenText.a * effectiveOpacity })
  const paintedBackground = over(parent.background, { ...ownBackground, a: ownBackground.a * effectiveOpacity })
  const fontSize = Number.parseFloat(style.fontSize)
  const fontWeight = Number(style.fontWeight) || (style.fontWeight === 'bold' ? 700 : 400)
  const largeText = fontSize >= 24 || (fontSize >= 18.66 && fontWeight >= 700)
  const disabled = Boolean(el.disabled || el.matches(':disabled') || el.getAttribute('aria-disabled') === 'true')
  const rect = el.getBoundingClientRect()
  const tokenNames = [
    '--dsw-alias-label-primary-foreground', '--dsw-alias-button-primary-fill',
    '--dsw-alias-button-primary-hover', '--dsw-alias-label-primary',
    '--dsw-alias-label-secondary', '--dsw-alias-bg-base', '--dsw-alias-bg-layer-1',
  ]
  const tokens = Object.fromEntries(tokenNames.map((name) => [name, style.getPropertyValue(name).trim() || null]))
  const matchedRules = []
  for (const sheet of document.styleSheets) {
    let rules
    try { rules = sheet.cssRules } catch { continue }
    for (const rule of rules) {
      if (!rule.selectorText || !rule.style) continue
      let matches = false
      try { matches = el.matches(rule.selectorText) } catch {}
      if (!matches) continue
      const css = rule.style.cssText
      if (!/(^|;)\s*(color|background|background-color|border|border-top|opacity)\s*:/.test(css)) continue
      matchedRules.push({ selector: rule.selectorText, css })
    }
  }
  return {
    name: config.name,
    role: config.role,
    implementation: config.implementation,
    theme: document.body.hasAttribute('data-ds-dark-theme') ? 'dark' : 'light',
    themeAttributes: {
      bodyDark: document.body.getAttribute('data-ds-dark-theme'),
      themeSource: document.body.getAttribute('data-ds-theme-source'),
      rootColorScheme: getComputedStyle(document.documentElement).colorScheme,
    },
    text: el.textContent.replace(/\s+/g, ' ').trim(),
    selector: config.selector,
    tag: el.tagName.toLowerCase(),
    id: el.id || null,
    className: typeof el.className === 'string' ? el.className : String(el.className),
    disabled,
    color: style.color,
    backgroundColor: style.backgroundColor,
    border: style.border,
    borderTop: style.borderTop,
    borderRight: style.borderRight,
    borderBottom: style.borderBottom,
    borderLeft: style.borderLeft,
    opacity: style.opacity,
    effectiveOpacity,
    opacityChain: opacityChain.filter((row) => row.opacity !== '1'),
    fontSize: style.fontSize,
    fontWeight: style.fontWeight,
    lineHeight: style.lineHeight,
    largeText,
    threshold: largeText ? 3 : 4.5,
    parsed: { foreground, ownBackground, parentBackground: parent.background, paintedText, paintedBackground },
    tokens,
    matchedRules,
    rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
  }
}

const installed = loadInstalledAssets()
const repoPackage = JSON.parse(readFileSync(`${REPO}/package.json`, 'utf8'))
const clientSource = readFileSync(`${REPO}/client.js`, 'utf8')
const fixture = makeFixture(repoPackage.version)
const clientSha256 = sha256(clientSource)
const scriptSha256 = sha256(readFileSync(`${REPO}/scripts/verify-panel-button-contrast.mjs`))
const task = await taskSpace(SPACE_NAME)
const { server, origin } = await startServer(installed, clientSource, fixture)
let page = null
let completed = false
let chromium = 'unknown'

try {
  const managedAtStart = await task.pages()
  page = managedAtStart.find((candidate) => candidate.label === 'p1') || await task.newPage()
  await page.cdp('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false })
  await page.cdp('Page.bringToFront')
  console.log(`ENV ${JSON.stringify({
    origin, repoVersion: repoPackage.version, clientSha256, scriptSha256,
    frontendVersion: installed.frontendVersion, primitivesRange: installed.primitivesRange,
    asarSha256: installed.asarSha256,
    assets: Object.fromEntries(Object.entries(installed.assets).map(([name, asset]) => [name, { bytes: asset.body.length, sha256: asset.sha256 }])),
  })}`)
  await page.goto(origin)
  await page.waitForFunction(() => window.__harnessReady === true || window.__harnessError, undefined, { timeout: 25000 })
  const harnessError = await page.evaluate(() => window.__harnessError || null)
  if (harnessError) throw new Error(harnessError)
  await page.waitForFunction(() => document.querySelector('.dt-page h1')?.textContent === '主理鱼'
    && !document.body.innerText.includes('正在读取…'), undefined, { timeout: 15000 })
  const browser = await page.evaluate(async () => ({
    userAgent: navigator.userAgent,
    highEntropy: navigator.userAgentData ? await navigator.userAgentData.getHighEntropyValues(['fullVersionList']) : null,
  }))
  chromium = browser.highEntropy?.fullVersionList?.find((item) => item.brand === 'Chromium')?.version
    || browser.userAgent.match(/Chrome\/([^ ]+)/)?.[1] || 'unknown'
  check('真实 Chromium 页面已加载', /^\d+\./.test(chromium) && /Chrome|Chromium/.test(browser.userAgent), { chromium, url: await page.url() })
  const meta = await page.evaluate(() => window.__verifyMeta)
  check('真实 client.js 使用安装版 React/primitives/Button', Boolean(meta.reactVersion)
    && meta.primitivesIdentity && meta.primitiveExportCount > 0 && meta.hostButtonType !== 'undefined', meta)
  check('slots.register 捕获真实 desk', meta.desk.name === 'conversation.view'
    && meta.desk.id === 'session-superagent-desk' && meta.desk.componentType === 'function', meta.desk)

  const shot = async (name) => {
    const path = `${SCREENSHOTS}/panel-button-contrast-${name}.png`
    try {
      await page.screenshot({ path, fullPage: true })
      artifacts.push(path)
      console.log(`SCREENSHOT ${name} ${path}`)
    } catch (error) {
      const detail = String((error && error.message) || error)
      screenshotSkips.push({ name, path, error: detail })
      // 截图是独立通道；computed style 测量已经完成/继续，不把通道故障记成产品 FAIL。
      console.log(`SKIP 截图 ${name} ${JSON.stringify(detail)}`)
    }
  }
  const openTab = async (label) => {
    await page.click(`loc=role:tab[name='${label}']`)
    await page.waitForFunction((expected) => document.querySelector('[role=tab][aria-selected=true]')?.textContent === expected, label, { timeout: 5000 })
  }
  const openSettings = async (label) => {
    await page.click(`css=.dt-settings-link:text-is("${label}")`)
    await page.waitForFunction((expected) => document.querySelector('.dt-settings-link[aria-current=page]')?.textContent === expected, label, { timeout: 5000 })
  }
  const applyTheme = async (theme) => {
    await page.evaluate((next) => {
      if (next === 'dark') document.body.setAttribute('data-ds-dark-theme', 'true')
      else document.body.removeAttribute('data-ds-dark-theme')
    }, theme)
    await page.waitForFunction((next) => (document.body.hasAttribute('data-ds-dark-theme') ? 'dark' : 'light') === next, theme, { timeout: 5000 })
  }
  const measure = async (theme, name, role, implementation, selector, text) => {
    const raw = await page.evaluate(measureButtonInPage, { name, role, implementation, selector, text })
    if (raw.theme !== theme) throw new Error(`${name}: 主题不符，期望 ${theme}，实际 ${raw.theme}`)
    const ratio = contrastRatio(raw.parsed.paintedText, raw.parsed.paintedBackground)
    const status = raw.disabled ? 'EXEMPT_DISABLED' : ratio + 1e-9 >= raw.threshold ? 'PASS' : 'FAIL'
    const row = {
      ...raw,
      ratio,
      ratioText: ratio.toFixed(4) + ':1',
      status,
      paintedTextHex: hex(raw.parsed.paintedText),
      paintedBackgroundHex: hex(raw.parsed.paintedBackground),
    }
    measurements.push(row)
    console.log(`MEASURE ${JSON.stringify({
      theme, name, role, implementation, text: row.text, className: row.className,
      disabled: row.disabled, color: row.color, backgroundColor: row.backgroundColor,
      border: row.border, borderTop: row.borderTop, opacity: row.opacity,
      effectiveOpacity: row.effectiveOpacity, paintedTextHex: row.paintedTextHex,
      paintedBackgroundHex: row.paintedBackgroundHex, ratio: row.ratioText,
      threshold: row.threshold, status, tokens: row.tokens, matchedRules: row.matchedRules,
    })}`)
    if (!raw.disabled) check(`${theme}/${name} 文字对比度 ≥ ${raw.threshold}:1`, status === 'PASS', { ratio: row.ratioText, status })
    else console.log(`EXEMPT ${theme}/${name} 禁用控件参考对比度 ${row.ratioText}`)
    return row
  }

  // 静态 CSS 证据：实际注入到页面的 local Btn primary 规则，不从源码字符串猜。
  const cssEvidence = await page.evaluate(() => {
    const text = document.getElementById('dsh-zhuli-ported-css')?.textContent || ''
    return text.split('}').filter((part) => part.includes('.dt-btn-primary')).map((part) => part.trim() + '}')
  })
  console.log(`LOCAL_PRIMARY_CSS ${JSON.stringify(cssEvidence)}`)

  const pageErrors = { capture: [], network: [] }
  for (const theme of ['dark', 'light']) {
    // 每个主题重新加载，确保新增表单回到真正的空白 disabled 初始态。
    // 若上一轮最后一次截图超时令 Page 消失，只在同一个 TaskSpace 内恢复新 Page。
    const managed = await task.pages()
    if (!managed.some((candidate) => candidate.label === page.label)) page = await task.newPage()
    await page.cdp('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false })
    await page.goto(origin)
    await page.waitForFunction(() => window.__harnessReady === true || window.__harnessError, undefined, { timeout: 25000 })
    const themeHarnessError = await page.evaluate(() => window.__harnessError || null)
    if (themeHarnessError) throw new Error(themeHarnessError)
    await page.waitForFunction(() => document.querySelector('.dt-page h1')?.textContent === '主理鱼'
      && !document.body.innerText.includes('正在读取…'), undefined, { timeout: 15000 })
    await applyTheme(theme)
    await openTab('触发')
    await page.waitForSelector('#watcher-new-repo', { state: 'visible', timeout: 5000 })
    await measure(theme, '新增表单 primary（空白禁用）', 'primary-disabled-observation', 'primary Btn（官方优先）', '#watcher-new button[type="submit"]', '添加到当前会话')
    await page.fill('#watcher-new-repo', 'fixture/contrast')
    await page.waitForFunction(() => {
      const button = document.querySelector('#watcher-new .dt-savebar button[type="submit"]')
      return button && !button.disabled
    }, undefined, { timeout: 5000 })
    await measure(theme, '新增表单 primary', 'primary', 'primary Btn（官方优先）', '#watcher-new .dt-savebar button[type="submit"]', '添加到当前会话')
    await measure(theme, '新增表单普通 Btn 对照', 'control', 'ghost Btn（官方优先）', '#watcher-new .dt-savebar button', '放弃')
    await shot(`${theme}-trigger`)

    await openTab('设置')
    await openSettings('凭证')
    await measure(theme, '设置保存凭证 primary', 'primary', 'primary Btn（官方优先）', '.dt-settings-body button', '保存凭证')
    await measure(theme, '凭证普通 Btn 对照', 'control', 'ghost Btn（官方优先）', '.dt-settings-body button', '解绑 gh 账号目录')
    await shot(`${theme}-settings-creds`)

    await openSettings('版本与更新')
    await page.waitForSelector("button[aria-label='安装更新']", { state: 'visible', timeout: 5000 })
    await measure(theme, '安装更新 primary', 'primary', 'installed DSH Button', ".dt-settings-body button[aria-label='安装更新']", '安装更新')
    await measure(theme, '更新普通 Btn ghost 对照', 'control', 'ghost Btn（官方优先）', '.dt-settings-body button', '重新检查')
    await measure(theme, '更新普通 Btn outline 对照', 'control', 'outline Btn（官方优先）', '.dt-settings-body button', '复制诊断信息')
    await shot(`${theme}-settings-update`)

    await openSettings('会话 goal')
    await measure(theme, '设置保存 goal primary', 'primary', 'primary Btn（官方优先）', '.dt-settings-body button', '保存 goal')
    // 最后一次截图可能使 Page 消失；先完成错误采集，之后不再访问 Page。
    const themeErrors = await page.evaluate(() => ({
      capture: window.__captureErrors.filter((event) => !String(event.message).includes('intentional-capture-stop')),
      network: window.__networkViolations,
    }))
    pageErrors.capture.push(...themeErrors.capture.map((row) => ({ theme, ...row })))
    pageErrors.network.push(...themeErrors.network.map((row) => ({ theme, ...row })))
    await shot(`${theme}-settings-goal`)
  }

  check('完整测量无未预期页面错误或外部请求', pageErrors.capture.length === 0 && pageErrors.network.length === 0, pageErrors)
  const mutations = apiLog.filter((row) => row.method !== 'GET')
  check('fake state/update 均实际命中且没有任何 mutation', apiLog.some((row) => row.path === '/session-superagent/state')
    && apiLog.some((row) => row.path === '/session-superagent/update') && mutations.length === 0, { mutations })
  const primary = measurements.filter((row) => row.role === 'primary')
  check('深浅主题各覆盖四个指定 primary', primary.length === 8
    && ['dark', 'light'].every((theme) => primary.filter((row) => row.theme === theme).length === 4),
  primary.map((row) => ({ theme: row.theme, name: row.name, ratio: row.ratioText, status: row.status })))
  check('新增/凭证/更新均有同分区普通 Btn 对照', measurements.filter((row) => row.role === 'control').length === 8,
    measurements.filter((row) => row.role === 'control').map((row) => ({ theme: row.theme, name: row.name, ratio: row.ratioText, status: row.status })))
  completed = true
  if (results.some((row) => !row.pass)) process.exitCode = 1
} catch (error) {
  console.error('VERIFY_ERROR', error)
  check('脚本执行完成（环境/测量完整性）', false, String(error && error.stack || error))
  process.exitCode = 2
  try {
    console.error('LAST_SNAPSHOT', JSON.stringify(await page.evaluate(() => ({
      ready: window.__harnessReady,
      harnessError: window.__harnessError,
      captured: window.__captured,
      clientCaptured: window.__clientCaptured,
      errors: window.__captureErrors,
      body: document.body.innerText.slice(0, 4000),
    })), null, 2))
  } catch {}
} finally {
  const summary = {
    passed: results.filter((row) => row.pass).length,
    failed: results.filter((row) => !row.pass).length,
    totalChecks: results.length,
    measurementPass: measurements.filter((row) => row.status === 'PASS').length,
    measurementFail: measurements.filter((row) => row.status === 'FAIL').length,
    measurementExemptDisabled: measurements.filter((row) => row.status === 'EXEMPT_DISABLED').length,
    chromium,
    repoVersion: repoPackage.version,
    clientSha256,
    scriptSha256,
    frontendVersion: installed.frontendVersion,
    asarSha256: installed.asarSha256,
    screenshots: artifacts.map((path) => ({
      path: path.replace(`${REPO}/`, ''),
      bytes: readFileSync(path).length,
      sha256: sha256(readFileSync(path)),
    })),
    screenshotSkips,
    measurements: measurements.map((row) => ({
      theme: row.theme, name: row.name, role: row.role, implementation: row.implementation,
      text: row.text, className: row.className, disabled: row.disabled,
      color: row.color, backgroundColor: row.backgroundColor, border: row.border,
      opacity: row.opacity, effectiveOpacity: row.effectiveOpacity,
      paintedTextHex: row.paintedTextHex, paintedBackgroundHex: row.paintedBackgroundHex,
      ratio: row.ratioText, threshold: row.threshold, status: row.status,
      fontSize: row.fontSize, fontWeight: row.fontWeight, tokens: row.tokens,
    })),
    apiLogSummary: {
      total: apiLog.length,
      stateCalls: apiLog.filter((row) => row.path === '/session-superagent/state').length,
      updateCalls: apiLog.filter((row) => row.path === '/session-superagent/update').length,
      mutations: apiLog.filter((row) => row.method !== 'GET'),
    },
    unverified,
    scriptExitCode: process.exitCode || 0,
  }
  console.log(`COUNTS ${JSON.stringify({
    passed: summary.passed, failed: summary.failed, totalChecks: summary.totalChecks,
    measurementPass: summary.measurementPass, measurementFail: summary.measurementFail,
    measurementExemptDisabled: summary.measurementExemptDisabled,
    screenshots: summary.screenshots.length, screenshotSkips: summary.screenshotSkips.length,
  })}`)
  console.log(`SUMMARY ${JSON.stringify(summary, null, 2)}`)
  console.log(`SCRIPT_EXIT_CODE ${process.exitCode || 0}`)
  const closing = new Promise((resolve) => server.close(resolve))
  server.closeAllConnections?.()
  await closing
  if (completed) await task.finish({ keep: [] })
  else console.log(`TASK_SPACE_KEPT ${task.spaceId}（脚本异常，保留未完成现场）`)
}
