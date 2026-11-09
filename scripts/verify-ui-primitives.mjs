// 真实 Chromium + 安装版 DSH React/primitives + 主理鱼适配器验收。
// 运行：ego-browser nodejs < scripts/verify-ui-primitives.mjs
// 不访问 DSH Web GUI；仅在独立 loopback 页面捕获安装 bundle 的 staticModules。

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import http from 'node:http'

const REPO = process.env.DSH_SUPERAGENT_REPO || 'D:/DeepSeek Harness/大肥鱼工作区/dsh-session-superagent'
const ASAR = 'D:/DeepSeek Harness/Desktop/resources/app.asar'
const ELECTRON = 'D:/DeepSeek Harness/Desktop/DeepSeek Harness.exe'
const FRONTEND = `${ASAR}/dsh/node_modules/@deepseek-ai/dsh-web-frontend`
const SCREENSHOTS = `${REPO}/docs/assets`
const SPACE_NAME = 'dsh-ui-primitives-chromium-0.9.269'
const results = []
const observations = []
const unverified = [
  '未进入需要认证的 DSH Web GUI，未验证真实会话 slot 挂载；本脚本只验独立页面里的同一安装版原语与适配器。',
  '未验 touch、读屏播报、双主题、reduced-motion、窗口 resize/窄视口翻转。',
  '未验 Tooltip focus-visible 与键盘 Tab 打开之间的差异；focus 用真实 DOM focus 路径。',
  '未验 Orbit 与真实 watcher 请求/轮询的集成；删除确认只使用本地静态状态组合，不发请求。',
]

function check(name, pass, detail) {
  const row = { name, pass: Boolean(pass), detail }
  results.push(row)
  console.log(`${row.pass ? 'PASS' : 'FAIL'} ${name}${detail === undefined ? '' : ` ${JSON.stringify(detail)}`}`)
  return row.pass
}

function observe(name, detail) {
  observations.push({ name, detail })
  console.log(`OBSERVE ${name} ${JSON.stringify(detail)}`)
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
process.stdout.write(JSON.stringify({
  frontendVersion: pkg.version,
  primitivesRange: pkg.devDependencies?.['@deepseek-ai/dsh-client-ui-primitives'] || null,
  asarSha256: null,
  electron: process.versions.electron,
  electronNode: process.version,
  html,
  assets,
}));
`
  const output = execFileSync(ELECTRON, ['-e', reader, FRONTEND, ASAR], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
  })
  const parsed = JSON.parse(output)
  parsed.asarSha256 = createHash('sha256').update(readFileSync(ASAR)).digest('hex')
  for (const asset of Object.values(parsed.assets)) asset.body = Buffer.from(asset.base64, 'base64')
  return parsed
}

const CAPTURE_FACADE = `
window.__captureErrors = [];
window.__nativeEvents = [];
window.__adapterEvents = [];
window.__refEvents = [];
window.__ModuleLoader__ = {
  create(options) {
    window.__capturedModules = options.staticModules;
    window.__captured = true;
    throw new Error('intentional-capture-stop: staticModules captured; DSH application boot not started');
  },
};
window.addEventListener('error', (event) => {
  window.__captureErrors.push({ kind: 'error', message: String(event.message || event.error || '') });
});
window.addEventListener('unhandledrejection', (event) => {
  window.__captureErrors.push({ kind: 'unhandledrejection', message: String(event.reason || '') });
});
`

const HARNESS_CSS = `
html, body { margin: 0; min-height: 100%; background: #101114; color: #f4f4f5; font-family: system-ui, sans-serif; }
#root { display: none !important; }
#app { min-height: 900px; padding: 24px; box-sizing: border-box; }
button { font: inherit; }
.verify-title { margin: 0 0 16px; font-size: 18px; }
.verify-section { width: 760px; margin-bottom: 18px; padding: 16px; border: 1px solid #484850; border-radius: 8px; background: #1b1c20; }
.verify-row { display: flex; align-items: center; gap: 12px; }
#tooltip-scroll { height: 150px; overflow: auto; border: 1px solid #60606a; padding: 12px; }
#tooltip-spacer { height: 460px; padding-top: 48px; }
#tooltip-trigger, #after-tooltip, #outside, #orbit-trigger, #orbit-first, #orbit-delete, #modal-cancel, #modal-confirm { min-height: 32px; padding: 4px 12px; }
#outside { margin-left: 24px; }
#orbit-trigger { position: fixed; left: 720px; top: 650px; width: 72px; height: 40px; z-index: 1; }
.sa-dock-panel { padding: 16px; box-sizing: border-box; }
.sa-dock-panel .verify-row { margin-bottom: 12px; }
#modal-cancel, #modal-confirm { margin: 4px; }
#probe-output { width: 760px; min-height: 72px; white-space: pre-wrap; color: #b9bac2; font: 12px/1.5 monospace; }
`

const HARNESS_MODULE = `
const deadline = Date.now() + 15000;
while (!window.__captured && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
if (!window.__captured) throw new Error('没有从安装 bundle 捕获 staticModules');
const modules = window.__capturedModules;
const React = modules.react;
const ReactDOM = modules['react-dom/client'];
const ReactDom = modules['react-dom'];
const primitives = modules['@deepseek-ai/dsh-client-ui-primitives'];
const [{ createHostUi }, { createOrbitPopover }] = await Promise.all([
  import('/ui-host-primitives.js'),
  import('/ui-orbit-popover.js'),
]);
const h = React.createElement;
const host = createHostUi({ React, primitives });
const orbitUi = createOrbitPopover({
  React: { ...React, createPortal: ReactDom.createPortal },
  primitives,
});
window.__verifyMeta = {
  reactVersion: React.version,
  primitiveExportCount: Object.keys(primitives).length,
  moduleNames: Object.keys(modules),
  primitivesIdentity: primitives === modules['@deepseek-ai/dsh-client-ui-primitives'],
  portalIdentity: ReactDom.createPortal === modules['react-dom'].createPortal,
};

function describe(node) {
  if (!node) return null;
  return {
    id: node.id || null,
    tag: node.tagName || null,
    role: node.getAttribute?.('role') || null,
    className: typeof node.className === 'string' ? node.className : null,
    text: node.textContent?.trim().slice(0, 160) || '',
  };
}
function box(node) {
  if (!node) return null;
  const rect = node.getBoundingClientRect();
  return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height };
}
function styleOf(node, properties) {
  if (!node) return null;
  const style = getComputedStyle(node);
  return Object.fromEntries(properties.map((name) => [name, style[name]]));
}
function tooltipInfo() {
  const trigger = document.getElementById('tooltip-trigger');
  const describedBy = trigger?.getAttribute('aria-describedby');
  const described = describedBy ? document.getElementById(describedBy) : null;
  const candidates = [...document.querySelectorAll('[role="tooltip"], [data-pinned]')];
  const bubble = described || candidates.find((node) => node.textContent.includes('主理鱼 Tooltip')) || null;
  return {
    trigger: describe(trigger),
    triggerBox: box(trigger),
    describedBy,
    bubble: describe(bubble),
    bubbleBox: box(bubble),
    bubbleParent: bubble?.parentElement?.tagName || null,
    bubblePinned: bubble?.getAttribute('data-pinned'),
    bubblePortal: bubble?.getAttribute('data-portal'),
    bubbleStyle: styleOf(bubble, ['position', 'zIndex', 'pointerEvents', 'visibility', 'display']),
    candidateCount: candidates.length,
  };
}
function orbitInfo() {
  const anchor = document.getElementById('orbit-trigger');
  const panel = document.querySelector('body > [role="dialog"][aria-label="主理鱼 watcher"]');
  return {
    anchor: describe(anchor),
    anchorBox: box(anchor),
    panel: describe(panel),
    panelBox: box(panel),
    panelParent: panel?.parentElement?.tagName || null,
    panelStyle: styleOf(panel, ['position', 'left', 'top', 'width', 'zIndex', 'visibility', 'isolation']),
    activeInside: Boolean(panel && panel.contains(document.activeElement)),
  };
}
function modalInfo() {
  const dialog = document.querySelector('[role="dialog"][aria-modal="true"]');
  const root = dialog?.parentElement;
  return {
    dialog: describe(dialog),
    dialogBox: box(dialog),
    root: describe(root),
    rootStyle: styleOf(root, ['position', 'zIndex', 'inset']),
    dialogStyle: styleOf(dialog, ['position', 'zIndex']),
    activeInside: Boolean(dialog && dialog.contains(document.activeElement)),
  };
}
window.__verify = {
  snapshot() {
    return {
      meta: window.__verifyMeta,
      active: describe(document.activeElement),
      tooltip: tooltipInfo(),
      orbit: orbitInfo(),
      modal: modalInfo(),
      scrollTop: document.getElementById('tooltip-scroll')?.scrollTop,
      nativeEvents: window.__nativeEvents.slice(),
      adapterEvents: window.__adapterEvents.slice(),
      refEvents: window.__refEvents.slice(),
      captureErrors: window.__captureErrors.slice(),
    };
  },
  clearEvents() {
    window.__nativeEvents.length = 0;
    window.__adapterEvents.length = 0;
    window.__refEvents.length = 0;
  },
};

function eventTarget(node) {
  const element = node instanceof Element ? node : null;
  return describe(element?.closest('[id], [role="tooltip"], [role="dialog"]') || element);
}
for (const type of ['pointerdown', 'mousedown', 'click', 'focusin', 'focusout', 'keydown']) {
  document.addEventListener(type, (event) => {
    const row = {
      type,
      key: event.key || null,
      repeat: event.repeat || false,
      defaultPreventedAtCapture: type === 'keydown' ? event.defaultPrevented : null,
      defaultPrevented: event.defaultPrevented,
      target: eventTarget(event.target),
      active: describe(document.activeElement),
      at: performance.now(),
    };
    window.__nativeEvents.push(row);
    if (type === 'keydown') {
      // Chromium 可在相邻监听器之间清空微任务；timeout 在完整事件分发后采样。
      setTimeout(() => {
        row.defaultPrevented = event.defaultPrevented;
        row.activeAfterDispatch = describe(document.activeElement);
      }, 0);
    }
  }, type === 'keydown');
}
for (const target of [window, document]) {
  target.addEventListener('scroll', (event) => {
    window.__nativeEvents.push({
      type: 'scroll',
      target: eventTarget(event.target),
      scrollTop: document.getElementById('tooltip-scroll')?.scrollTop,
      active: describe(document.activeElement),
      at: performance.now(),
    });
  }, true);
}

function TooltipFixture() {
  const originalRef = React.useRef(null);
  const setOriginalRef = React.useCallback((node) => {
    originalRef.current = node;
    window.__refEvents.push({ kind: node ? 'attach' : 'detach', id: node?.id || null });
  }, []);
  return h('section', { className: 'verify-section', id: 'tooltip-section' },
    h('h2', null, 'Tooltip · DSH pinned + 主理鱼 scroll-close'),
    h('div', { id: 'tooltip-scroll' },
      h('div', { id: 'tooltip-spacer' },
        h('div', { className: 'verify-row' },
          h(host.Tooltip, {
            text: '主理鱼 Tooltip：scroll-close 与焦点归还',
            children: h('button', { id: 'tooltip-trigger', ref: setOriginalRef, type: 'button' }, '说明'),
          }),
          h('button', { id: 'after-tooltip', type: 'button' }, '下一个焦点'),
        ),
      ),
    ),
  );
}

function OrbitFixture() {
  const anchorRef = React.useRef(null);
  const orbitRef = React.useRef(null);
  const [open, setOpen] = React.useState(false);
  const [confirmOpen, setConfirmOpen] = React.useState(false);
  const closeOrbit = React.useCallback((detail) => {
    window.__adapterEvents.push({ type: 'orbit-close', detail, at: performance.now() });
    setOpen(false);
  }, []);
  const confirm = orbitUi.useOrbitConfirm({
    orbitRef,
    onCloseOrbit: closeOrbit,
    onRequestConfirm: (detail) => {
      window.__adapterEvents.push({ type: 'confirm-request', detail, at: performance.now() });
      setConfirmOpen(true);
    },
  });
  const closeConfirm = React.useCallback(() => {
    window.__adapterEvents.push({ type: 'confirm-close', at: performance.now() });
    setConfirmOpen(false);
    setTimeout(() => {
      const restored = confirm.onConfirmClose();
      window.__adapterEvents.push({ type: 'confirm-focus-restored', restored, active: describe(document.activeElement), at: performance.now() });
    }, 0);
  }, [confirm.onConfirmClose]);
  return h(React.Fragment, null,
    h('button', {
      id: 'orbit-trigger',
      ref(node) { anchorRef.current = node; orbitRef.current = node; },
      type: 'button',
      'aria-expanded': open,
      onClick() { setOpen((value) => !value); },
    }, open ? '关闭环' : '打开环'),
    h(orbitUi.OrbitPopover, {
      open,
      anchorRef,
      orbitRef,
      onClose: closeOrbit,
      width: 368,
      className: 'dt-card sa-dock-panel',
      ariaLabel: '主理鱼 watcher',
    },
      h('div', { className: 'verify-row' }, h('strong', null, 'MYCF711/dsh-session-superagent')),
      h('div', { className: 'verify-row' },
        h('button', { id: 'orbit-first', type: 'button' }, '立刻'),
        h('button', {
          id: 'orbit-delete',
          type: 'button',
          onClick() {
            window.__adapterEvents.push({ type: 'delete-click', at: performance.now() });
            confirm.onRequestConfirm({ watcherId: 'MYCF711/dsh-session-superagent#s1' });
          },
        }, '删除'),
      ),
      h('div', null, 'top / end / gap 8 / margin 8'),
    ),
    h(host.Modal, {
      open: confirmOpen,
      title: '删除 watcher',
      description: '静态组合：orbit 已卸载，Modal 是唯一弹层。',
      onClose: closeConfirm,
      footer: h('div', null,
        h('button', { id: 'modal-cancel', type: 'button', 'data-modal-autofocus': true, onClick: closeConfirm }, '取消'),
        h('button', { id: 'modal-confirm', type: 'button', onClick: closeConfirm }, '确认删除'),
      ),
    }, h('p', null, '不会发送真实删除请求。')),
  );
}

function App() {
  return h('main', null,
    h('h1', { className: 'verify-title' }, '真实 Chromium · DSH primitives 验收'),
    h(TooltipFixture),
    h('section', { className: 'verify-section' },
      h('h2', null, '外点控制'),
      h('button', { id: 'outside', type: 'button' }, '外部按钮'),
      h('p', null, 'Orbit 圆环固定在视口右下方；弹层 portal 到 body。'),
    ),
    h(OrbitFixture),
    h('pre', { id: 'probe-output' }, 'DOM / computed style / focus / events 由 Node 驱动脚本采集'),
  );
}

ReactDOM.createRoot(document.getElementById('app')).render(h(App));
window.__harnessReady = true;
`

function htmlFor(installed) {
  const styles = Object.keys(installed.assets).filter((name) => name.endsWith('.css'))
  const entry = Object.keys(installed.assets).find((name) => name.endsWith('.js') && /index-/.test(name))
  if (!entry) throw new Error('安装 dist/index.html 中没有入口 JS')
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>DSH primitives 真实 Chromium 验收</title>
${styles.map((name) => `<link rel="stylesheet" href="/${name}">`).join('\n')}
<style>${HARNESS_CSS}</style>
<script>${CAPTURE_FACADE}</script>
</head><body><div id="root"></div><div id="app"></div>
<script type="module" src="/${entry}"></script>
<script type="module">${HARNESS_MODULE.replaceAll('</script', '<\\/script')}</script>
</body></html>`
}

async function startServer(installed) {
  const adapterSources = {
    '/ui-host-primitives.js': await readFile(`${REPO}/ui-host-primitives.js`, 'utf8'),
    '/ui-orbit-popover.js': await readFile(`${REPO}/ui-orbit-popover.js`, 'utf8'),
  }
  const html = htmlFor(installed)
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1')
    if (url.pathname === '/') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
      response.end(html)
      return
    }
    if (adapterSources[url.pathname]) {
      response.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' })
      response.end(adapterSources[url.pathname])
      return
    }
    const name = url.pathname.slice(1)
    const asset = installed.assets[name]
    if (asset) {
      response.writeHead(200, {
        'content-type': name.endsWith('.css') ? 'text/css; charset=utf-8' : 'text/javascript; charset=utf-8',
        'cache-control': 'no-store',
      })
      response.end(asset.body)
      return
    }
    response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
    response.end('not found')
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  return { server, origin: `http://127.0.0.1:${address.port}` }
}

const installed = loadInstalledAssets()
const repoPackage = JSON.parse(readFileSync(`${REPO}/package.json`, 'utf8'))
const adapterHashes = Object.fromEntries(['ui-host-primitives.js', 'ui-orbit-popover.js'].map((name) => [
  name,
  createHash('sha256').update(readFileSync(`${REPO}/${name}`)).digest('hex'),
]))
const { server, origin } = await startServer(installed)
const task = await taskSpace(SPACE_NAME)
const page = task.page('p1')
let completed = false
try {
  const browserWindow = await page.cdp('Browser.getWindowForTarget')
  if (browserWindow.bounds?.windowState === 'minimized') {
    await page.cdp('Browser.setWindowBounds', {
      windowId: browserWindow.windowId,
      bounds: { windowState: 'normal' },
    })
  }
  await page.cdp('Page.bringToFront')
  console.log(`ENV ${JSON.stringify({
    origin,
    repoVersion: repoPackage.version,
    adapterHashes,
    frontendVersion: installed.frontendVersion,
    primitivesRange: installed.primitivesRange,
    asarSha256: installed.asarSha256,
    assets: Object.fromEntries(Object.entries(installed.assets).map(([name, asset]) => [name, { bytes: asset.body.length, sha256: asset.sha256 }])),
  })}`)
  await page.goto(origin)
  await page.waitForFunction(() => window.__harnessReady === true, undefined, { timeout: 20000 })
  const browser = await page.evaluate(async () => ({
    userAgent: navigator.userAgent,
    highEntropy: navigator.userAgentData
      ? await navigator.userAgentData.getHighEntropyValues(['fullVersionList'])
      : null,
  }))
  const chromium = browser.highEntropy?.fullVersionList?.find((item) => item.brand === 'Chromium')?.version
    || browser.userAgent.match(/Chrome\/([^ ]+)/)?.[1]
    || 'unknown'
  console.log(`BROWSER ${JSON.stringify({ chromium, ...browser })}`)
  check('真实 Chromium 页面与独立 harness 已加载', chromium.startsWith('156.'), { chromium, url: await page.url() })

  let snap = await page.evaluate(() => window.__verify.snapshot())
  check('React 来自安装 bundle 且版本为 18.3.1', snap.meta.reactVersion === '18.3.1', snap.meta)
  check('primitives 是捕获的同一导出对象且包含目标原语', snap.meta.primitivesIdentity
    && snap.meta.primitiveExportCount === 290
    && snap.meta.moduleNames.includes('react-dom')
    && snap.meta.moduleNames.includes('react-dom/client'), snap.meta)
  observe('安装包基线', {
    frontendVersion: installed.frontendVersion,
    primitivesRange: installed.primitivesRange,
    asarSha256: installed.asarSha256,
    assets: Object.fromEntries(Object.entries(installed.assets).map(([name, asset]) => [name, asset.sha256])),
  })

  const tooltipOpen = async () => {
    const state = await page.evaluate(() => window.__verify.snapshot().tooltip)
    return Boolean(state.bubble && state.bubbleStyle.display !== 'none' && state.bubbleStyle.visibility !== 'hidden')
  }
  const waitTooltip = async (open) => {
    await page.waitForFunction((expected) => {
      const trigger = document.getElementById('tooltip-trigger')
      const id = trigger?.getAttribute('aria-describedby')
      const described = id ? document.getElementById(id) : null
      const candidates = [...document.querySelectorAll('[role="tooltip"], [data-pinned]')]
      const found = described || candidates.find((node) => node.textContent.includes('主理鱼 Tooltip'))
      if (!expected) return !found
      if (!found) return false
      const style = getComputedStyle(found)
      return style.display !== 'none' && style.visibility === 'visible'
    }, open, { timeout: 5000 })
  }
  const waitKeySettled = async (key) => {
    await page.waitForFunction((expectedKey) => window.__nativeEvents.some((event) => (
      event.type === 'keydown' && event.key === expectedKey && event.activeAfterDispatch !== undefined
    )), key, { timeout: 3000 })
  }
  const resetPointer = async () => {
    await page.mouse.move(1080, 80, { label: '移开 Tooltip 指针' })
    await page.waitForTimeout(120)
  }
  const focusOutside = async () => {
    await page.focus('#outside')
    await resetPointer()
  }

  // Tooltip hover：真实鼠标移入/移出。
  await focusOutside()
  await page.hover('#tooltip-trigger', { label: '悬停 Tooltip 触发器' })
  await waitTooltip(true)
  snap = await page.evaluate(() => window.__verify.snapshot())
  check('Tooltip hover 打开且 portal 到 body', await tooltipOpen()
    && snap.tooltip.bubbleParent === 'BODY'
    && snap.tooltip.bubblePortal !== null
    && snap.tooltip.bubble.text.includes('scroll-close'), snap.tooltip)
  observe('Tooltip hover DOM/computed style', { tooltip: snap.tooltip, active: snap.active })
  await resetPointer()
  await waitTooltip(false)
  check('Tooltip 未 pin 时移出指针关闭', !(await tooltipOpen()), await page.evaluate(() => window.__verify.snapshot().tooltip))

  // Tooltip focus：真实 focus/blur。
  await page.focus('#tooltip-trigger')
  await waitTooltip(true)
  snap = await page.evaluate(() => window.__verify.snapshot())
  check('Tooltip focus 打开且 trigger 获得焦点', snap.active.id === 'tooltip-trigger' && await tooltipOpen(), {
    active: snap.active,
    tooltip: snap.tooltip,
  })
  await page.focus('#outside')
  await waitTooltip(false)
  check('Tooltip blur 后关闭', !(await tooltipOpen()), await page.evaluate(() => window.__verify.snapshot().tooltip))

  // click pinned：先移开指针，再从关闭状态点击。
  await resetPointer()
  await page.click('#tooltip-trigger', { label: '点击固定 Tooltip' })
  await waitTooltip(true)
  await resetPointer()
  snap = await page.evaluate(() => window.__verify.snapshot())
  check('Tooltip click 后 pinned，指针移开仍打开', await tooltipOpen()
    && snap.tooltip.bubblePinned !== null
    && snap.tooltip.bubbleStyle.pointerEvents === 'auto', snap.tooltip)
  await page.screenshot({ path: `${SCREENSHOTS}/ui-primitives-chromium-tooltip.png` })
  observe('Tooltip pinned 截图与真实状态', {
    path: 'docs/assets/ui-primitives-chromium-tooltip.png',
    tooltip: snap.tooltip,
    active: snap.active,
  })

  // scroll-close + trigger 焦点归还：嵌套滚动容器，真实 wheel。
  await page.evaluate(() => window.__verify.clearEvents())
  await page.mouse.move(360, 210, { label: '移到嵌套滚动容器' })
  await page.mouse.wheel(0, 70, { label: '滚动 Tooltip 容器' })
  await waitTooltip(false)
  await page.waitForTimeout(100)
  snap = await page.evaluate(() => window.__verify.snapshot())
  check('Tooltip 嵌套 scroll 后 pinned bubble 关闭', !(await tooltipOpen()) && snap.scrollTop > 0, {
    scrollTop: snap.scrollTop,
    tooltip: snap.tooltip,
  })
  check('Tooltip scroll-close 后焦点归还新 trigger', snap.active.id === 'tooltip-trigger', {
    active: snap.active,
    scrollTop: snap.scrollTop,
    refEvents: snap.refEvents,
  })
  check('Tooltip keyed remount 的原 ref 真实 detach/attach 对称', snap.refEvents.some((event) => event.kind === 'detach')
    && snap.refEvents.at(-1)?.kind === 'attach'
    && snap.refEvents.at(-1)?.id === 'tooltip-trigger', snap.refEvents)
  observe('Tooltip scroll/focus 原生事件', snap.nativeEvents)

  // Escape：官方 pinned 行为，preventDefault/stopPropagation，trigger 不卸载。
  await page.click('#tooltip-trigger', { label: '重新固定 Tooltip' })
  await waitTooltip(true)
  await page.evaluate(() => window.__verify.clearEvents())
  await page.keyboard.press('Escape')
  await waitTooltip(false)
  await waitKeySettled('Escape')
  snap = await page.evaluate(() => window.__verify.snapshot())
  const escapeEvent = snap.nativeEvents.find((event) => event.type === 'keydown' && event.key === 'Escape')
  check('Tooltip pinned Escape 关闭', !(await tooltipOpen()), snap.tooltip)
  check('Tooltip 官方 Escape preventDefault 且焦点留在 trigger', escapeEvent?.defaultPrevented === true && snap.active.id === 'tooltip-trigger', {
    escapeEvent,
    active: snap.active,
  })

  // Tab：官方 pinned capture 关闭，不阻止浏览器默认 Tab 焦点移动。
  await page.click('#tooltip-trigger', { label: '再次固定 Tooltip' })
  await waitTooltip(true)
  await page.evaluate(() => window.__verify.clearEvents())
  await page.keyboard.press('Tab')
  await waitTooltip(false)
  await waitKeySettled('Tab')
  snap = await page.evaluate(() => window.__verify.snapshot())
  const tabEvent = snap.nativeEvents.find((event) => event.type === 'keydown' && event.key === 'Tab')
  check('Tooltip pinned Tab 关闭', !(await tooltipOpen()), snap.tooltip)
  observe('Tooltip 官方 Tab 真实焦点/defaultPrevented', { tabEvent, active: snap.active })
  check('Tooltip Tab 不阻止默认焦点移动', tabEvent?.defaultPrevented === false && snap.active.id === 'after-tooltip', {
    tabEvent,
    active: snap.active,
  })

  // 外点：官方 useDismissOnOutsidePointer 路径。
  await page.click('#tooltip-trigger', { label: '外点前固定 Tooltip' })
  await waitTooltip(true)
  await page.evaluate(() => window.__verify.clearEvents())
  await page.click('#outside', { label: '点击 Tooltip 外部' })
  await waitTooltip(false)
  snap = await page.evaluate(() => window.__verify.snapshot())
  check('Tooltip pinned 外点关闭且外部按钮获得焦点', !(await tooltipOpen()) && snap.active.id === 'outside', {
    active: snap.active,
    tooltip: snap.tooltip,
  })
  observe('Tooltip 官方外点事件序列', snap.nativeEvents)

  const openOrbit = async () => {
    const current = await page.evaluate(() => window.__verify.snapshot().orbit)
    if (!current.panel) {
      await page.click('#orbit-trigger', { label: '打开 OrbitPopover' })
      await page.waitForSelector('body > [role="dialog"][aria-label="主理鱼 watcher"]', { state: 'visible', timeout: 5000 })
      await page.waitForTimeout(80)
    }
  }
  const closeOrbitIfOpen = async () => {
    const current = await page.evaluate(() => window.__verify.snapshot().orbit)
    if (current.panel) {
      await page.keyboard.press('Escape')
      await page.waitForFunction(() => !document.querySelector('body > [role="dialog"][aria-label="主理鱼 watcher"]'), undefined, { timeout: 5000 })
    }
  }

  // Orbit portal/top/end/初始焦点。
  await page.evaluate(() => window.__verify.clearEvents())
  await openOrbit()
  await page.waitForTimeout(420)
  snap = await page.evaluate(() => window.__verify.snapshot())
  const orbit = snap.orbit
  const expectedLeft = orbit.anchorBox.right - orbit.panelBox.width
  const expectedTop = orbit.anchorBox.top - orbit.panelBox.height - 8
  check('OrbitPopover 主 surface portal 到 body', orbit.panelParent === 'BODY'
    && orbit.panel.role === 'dialog'
    && orbit.panelStyle.position === 'fixed'
    && orbit.panelStyle.zIndex === '1100', orbit)
  check('OrbitPopover top/end 坐标符合 anchor、8px gap', Math.abs(orbit.panelBox.left - expectedLeft) <= 1
    && Math.abs(orbit.panelBox.top - expectedTop) <= 1, {
    expected: { left: expectedLeft, top: expectedTop },
    actual: { left: orbit.panelBox.left, top: orbit.panelBox.top },
    anchor: orbit.anchorBox,
    panel: orbit.panelBox,
  })
  check('OrbitPopover 初始焦点在非 Modal dialog', snap.active.role === 'dialog'
    && snap.active.className.includes('sa-dock-panel')
    && orbit.activeInside, { active: snap.active, orbit, nativeEvents: snap.nativeEvents })
  await page.screenshot({ path: `${SCREENSHOTS}/ui-primitives-chromium-orbit.png` })
  observe('Orbit 截图/DOM/computed style', {
    path: 'docs/assets/ui-primitives-chromium-orbit.png',
    orbit,
    active: snap.active,
  })

  // Orbit 外点关闭与回焦。
  await page.evaluate(() => window.__verify.clearEvents())
  await page.click('#outside', { label: '点击 Orbit 外部' })
  await page.waitForFunction(() => !document.querySelector('body > [role="dialog"][aria-label="主理鱼 watcher"]'), undefined, { timeout: 5000 })
  await page.waitForTimeout(80)
  snap = await page.evaluate(() => window.__verify.snapshot())
  check('OrbitPopover 外点关闭并记录 outside-pointer', !snap.orbit.panel
    && snap.adapterEvents.some((event) => event.type === 'orbit-close' && event.detail?.reason === 'outside-pointer'), {
    orbit: snap.orbit,
    adapterEvents: snap.adapterEvents,
  })
  observe('Orbit 外点后的真实焦点', { active: snap.active, events: snap.nativeEvents })
  check('OrbitPopover 外点保留用户点击目标焦点', snap.active.id === 'outside', {
    active: snap.active,
    adapterEvents: snap.adapterEvents,
  })

  // Orbit Escape 与回焦。
  await openOrbit()
  await page.evaluate(() => window.__verify.clearEvents())
  await page.keyboard.press('Escape')
  await page.waitForFunction(() => !document.querySelector('body > [role="dialog"][aria-label="主理鱼 watcher"]'), undefined, { timeout: 5000 })
  await page.waitForTimeout(80)
  await waitKeySettled('Escape')
  snap = await page.evaluate(() => window.__verify.snapshot())
  const orbitEscape = snap.nativeEvents.find((event) => event.type === 'keydown' && event.key === 'Escape')
  check('OrbitPopover Escape preventDefault 后关闭并回焦圆环', !snap.orbit.panel
    && orbitEscape?.defaultPrevented === true
    && snap.active.id === 'orbit-trigger'
    && snap.adapterEvents.some((event) => event.type === 'orbit-close' && event.detail?.reason === 'escape'), {
    orbitEscape,
    active: snap.active,
    adapterEvents: snap.adapterEvents,
  })

  // 删除确认：真实点击，但只组合本地静态状态，不发 watcher 请求。
  await openOrbit()
  await page.evaluate(() => window.__verify.clearEvents())
  await page.click('#orbit-delete', { label: '打开静态删除确认' })
  await page.waitForSelector('[role="dialog"][aria-modal="true"]', { state: 'visible', timeout: 5000 })
  await page.waitForTimeout(500)
  snap = await page.evaluate(() => window.__verify.snapshot())
  const order = snap.adapterEvents.map((event) => event.type)
  check('删除确认顺序为 orbit close → confirm request', order.indexOf('orbit-close') >= 0
    && order.indexOf('confirm-request') === order.indexOf('orbit-close') + 1
    && snap.adapterEvents.find((event) => event.type === 'orbit-close')?.detail?.reason === 'confirm', snap.adapterEvents)
  check('确认期间 Orbit(1100) 已卸载，仅 Modal(1000) 在顶层', !snap.orbit.panel
    && snap.modal.rootStyle.zIndex === '1000', {
    orbit: snap.orbit,
    modal: snap.modal,
    active: snap.active,
  })
  check('Modal 初始焦点落在 data-modal-autofocus 取消按钮', snap.active.id === 'modal-cancel', {
    active: snap.active,
    modal: snap.modal,
  })
  await page.screenshot({ path: `${SCREENSHOTS}/ui-primitives-chromium-modal.png` })
  observe('Orbit→Modal 静态组合截图与 computed style', {
    path: 'docs/assets/ui-primitives-chromium-modal.png',
    modal: snap.modal,
    orbit: snap.orbit,
    adapterEvents: snap.adapterEvents,
    nativeEvents: snap.nativeEvents,
  })
  await page.click('#modal-cancel', { label: '取消静态删除确认' })
  await page.waitForFunction(() => !document.querySelector('[role="dialog"][aria-modal="true"]'), undefined, { timeout: 5000 })
  await page.waitForTimeout(100)
  snap = await page.evaluate(() => window.__verify.snapshot())
  check('确认关闭后只回焦圆环而非已卸载删除按钮', snap.active.id === 'orbit-trigger'
    && snap.adapterEvents.some((event) => event.type === 'confirm-focus-restored' && event.restored === true), {
    active: snap.active,
    adapterEvents: snap.adapterEvents,
  })

  snap = await page.evaluate(() => window.__verify.snapshot())
  const unexpectedErrors = snap.captureErrors.filter((event) => !String(event.message).includes('intentional-capture-stop'))
  check('harness 无未预期页面错误', unexpectedErrors.length === 0, unexpectedErrors)
  await closeOrbitIfOpen()

  const passed = results.filter((row) => row.pass).length
  const failed = results.length - passed
  const summary = {
    passed,
    failed,
    total: results.length,
    chromium,
    repoVersion: repoPackage.version,
    adapterHashes,
    frontendVersion: installed.frontendVersion,
    react: snap.meta.reactVersion,
    primitiveExportCount: snap.meta.primitiveExportCount,
    screenshots: [
      'docs/assets/ui-primitives-chromium-tooltip.png',
      'docs/assets/ui-primitives-chromium-orbit.png',
      'docs/assets/ui-primitives-chromium-modal.png',
    ],
    unverified,
  }
  console.log(`SUMMARY ${JSON.stringify(summary, null, 2)}`)
  completed = true
  if (failed > 0) process.exitCode = 1
} catch (error) {
  console.error('VERIFY_ERROR', error)
  try {
    console.error('LAST_SNAPSHOT', JSON.stringify(await page.evaluate(() => ({
      ready: window.__harnessReady,
      captured: window.__captured,
      errors: window.__captureErrors,
      snapshot: window.__verify?.snapshot(),
      body: document.body.innerText.slice(0, 3000),
    })), null, 2))
  } catch {}
  process.exitCode = 1
} finally {
  const closing = new Promise((resolve) => server.close(resolve))
  server.closeAllConnections?.()
  await closing
  if (completed) {
    // 产品断言失败也是已完成的验收；退出码表达失败，不遗留 ego 连接或浏览器页。
    await task.finish({ keep: [] })
  } else {
    console.log(`TASK_SPACE_KEPT ${task.spaceId}（脚本异常，保留未完成现场）`)
  }
}
