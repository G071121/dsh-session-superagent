// 真实 Chromium：Toast 生命周期、Modal 键盘/焦点、Orbit resize/窄视口与双主题。
// 运行：ego-browser nodejs < scripts/verify-ui-toast-responsive.mjs
// 只使用安装 bundle 的 React/primitives、仓库适配器与独立 loopback harness；不进入 DSH Web GUI。

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import http from 'node:http'

const REPO = process.env.DSH_SUPERAGENT_REPO || 'D:/DeepSeek Harness/大肥鱼工作区/dsh-session-superagent'
const ASAR = 'D:/DeepSeek Harness/Desktop/resources/app.asar'
const ELECTRON = 'D:/DeepSeek Harness/Desktop/DeepSeek Harness.exe'
const FRONTEND = `${ASAR}/dsh/node_modules/@deepseek-ai/dsh-web-frontend`
const THEME_CLIENT = `${ASAR}/dsh/node_modules/@deepseek-ai/dsh-client-ui-theme/lib/client.js`
const SCREENSHOTS = `${REPO}/docs/assets`
const SPACE_NAME = 'dsh-ui-toast-responsive-chromium-0.9.270'
const results = []
const observations = []
const artifacts = []
const unverified = [
  '未进入真实 DSH Web GUI 的会话 slot；本脚本只验独立 loopback 页面中的同一安装版原语与仓库适配器。',
  '未使用物理读屏软件；role/ARIA 与 Chromium Accessibility 树已记录，但不能据此宣称 NVDA/JAWS/VoiceOver 实际播报通过。',
  '双主题原样注入安装版 ui-theme/lib/client.js 的内嵌 STYLES，并按官方 ThemePresenter DOM 契约切换 root color-scheme/data-ds-theme-source 与 body data-ds-dark-theme；未操作真实宿主主题设置 UI。',
  '窄视口使用真实 Chromium 的 CDP Emulation.setDeviceMetricsOverride，布局、resize、ResizeObserver 与键盘事件均为浏览器真实执行；未拖动物理 OS 窗口。',
  '未验 touch、reduced-motion、IME、真实 watcher 请求/轮询，以及 Toast action 按钮。',
]

function check(category, name, pass, detail) {
  const row = { category, name, pass: Boolean(pass), detail }
  results.push(row)
  console.log(`${row.pass ? 'PASS' : 'FAIL'} [${category}] ${name}${detail === undefined ? '' : ` ${JSON.stringify(detail)}`}`)
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
const themeClient = fs.readFileSync(process.argv[3], 'utf8');
const themeStyles = {};
for (const match of themeClient.matchAll(/var ([A-Za-z0-9_]+_css_default) = ("(?:[^"\\]|\\.)*");/g)) {
  themeStyles[match[1]] = JSON.parse(match[2]);
}
const requiredThemeStyles = [
  'base_css_default',
  'corner_shape_css_default',
  'design_platform_css_default',
  'focus_css_default',
  'onboarding_css_default',
  'scrollbar_css_default',
  'gradient_shadow_text_css_default',
  'shiki_css_default',
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
  })
  const parsed = JSON.parse(output)
  parsed.asarSha256 = createHash('sha256').update(readFileSync(ASAR)).digest('hex')
  for (const asset of Object.values(parsed.assets)) asset.body = Buffer.from(asset.base64, 'base64')
  return parsed
}

const CAPTURE_FACADE = `
window.__captureErrors = [];
window.__nativeEvents = [];
window.__keydownListenerEvents = [];
window.__activeKeydownListeners = [];
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

// 只审计 window/document 的 keydown 注册对称性，不替换 DOM、事件或原语行为。
(() => {
  const originalAdd = EventTarget.prototype.addEventListener;
  const originalRemove = EventTarget.prototype.removeEventListener;
  const captureOf = (options) => typeof options === 'boolean' ? options : Boolean(options && options.capture);
  const targetName = (target) => target === window ? 'window' : 'document';
  const find = (target, listener, capture) => window.__activeKeydownListeners.findIndex((row) => (
    row.target === target && row.listener === listener && row.capture === capture
  ));
  EventTarget.prototype.addEventListener = function(type, listener, options) {
    if (type === 'keydown' && listener && (this === window || this === document)) {
      const capture = captureOf(options);
      if (find(this, listener, capture) < 0) {
        const row = { target: this, listener, capture, targetName: targetName(this), at: performance.now() };
        window.__activeKeydownListeners.push(row);
        window.__keydownListenerEvents.push({ type: 'add', target: row.targetName, capture, at: row.at });
      }
    }
    return originalAdd.call(this, type, listener, options);
  };
  EventTarget.prototype.removeEventListener = function(type, listener, options) {
    if (type === 'keydown' && listener && (this === window || this === document)) {
      const capture = captureOf(options);
      const index = find(this, listener, capture);
      if (index >= 0) {
        const row = window.__activeKeydownListeners[index];
        window.__activeKeydownListeners.splice(index, 1);
        window.__keydownListenerEvents.push({ type: 'remove', target: row.targetName, capture, at: performance.now() });
      }
    }
    return originalRemove.call(this, type, listener, options);
  };
})();
`

const HARNESS_CSS = `
html, body { margin: 0; min-height: 100%; }
html { background: var(--dsw-alias-bg-base, #101114); }
body { background: var(--dsw-alias-bg-base, #101114); color: var(--dsw-alias-label-primary, #f4f4f5); font-family: var(--dsw-font-family, system-ui, sans-serif); }
#root { display: none !important; }
#app { min-height: 100vh; padding: 24px; box-sizing: border-box; }
button, input { font: inherit; }
.verify-title { margin: 0 0 16px; font-size: 18px; }
.verify-section { max-width: 760px; margin-bottom: 18px; padding: 16px; border: 1px solid var(--dsw-alias-border-l2, #484850); border-radius: 8px; background: var(--dsw-alias-bg-layer-1, #1b1c20); box-sizing: border-box; }
.verify-row { display: flex; align-items: center; flex-wrap: wrap; gap: 12px; }
.verify-row button, #modal-open, #outside { min-height: 32px; padding: 4px 12px; }
#modal-input { display: block; width: min(100%, 320px); margin: 8px 0; padding: 6px 8px; box-sizing: border-box; }
#modal-cancel, #modal-confirm { margin: 4px; min-height: 32px; padding: 4px 12px; }
.sa-dock-panel { padding: 16px; box-sizing: border-box; }
.sa-dock-panel .verify-row { margin-bottom: 12px; }
#orbit-anchor { position: fixed; right: 0; top: 0; width: 40px; height: 40px; z-index: 1; padding: 0; }
#probe-output { max-width: 760px; white-space: pre-wrap; color: var(--dsw-alias-label-secondary, #b9bac2); font: 12px/1.5 monospace; }
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
window.__toastEvents = [];
window.__toastSamples = [];
window.__toastDoneCallbacks = new Map();
window.__modalEvents = [];
window.__orbitEvents = [];
window.__resizeEvents = [];
window.__nodeIds = new WeakMap();
window.__nextNodeId = 1;

function nodeId(node) {
  if (!node) return null;
  if (!window.__nodeIds.has(node)) window.__nodeIds.set(node, window.__nextNodeId++);
  return window.__nodeIds.get(node);
}
function describe(node) {
  if (!node) return null;
  return {
    nodeId: nodeId(node),
    id: node.id || null,
    tag: node.tagName || null,
    role: node.getAttribute?.('role') || null,
    ariaLabel: node.getAttribute?.('aria-label') || null,
    ariaModal: node.getAttribute?.('aria-modal') || null,
    className: typeof node.className === 'string' ? node.className : null,
    text: node.textContent?.trim().slice(0, 180) || '',
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
  return Object.fromEntries(properties.map((name) => [name, name.startsWith('--') ? style.getPropertyValue(name).trim() : style[name]]));
}
function toastRoot() {
  return document.querySelector('body > [role="alert"]');
}
function toastInfo() {
  const root = toastRoot();
  const svg = root?.querySelector('svg');
  return {
    nodeId: nodeId(root),
    root: describe(root),
    parent: root?.parentElement?.tagName || null,
    bodyAlertCount: document.querySelectorAll('body > [role="alert"]').length,
    aria: root ? {
      role: root.getAttribute('role'),
      ariaLive: root.getAttribute('aria-live'),
      ariaAtomic: root.getAttribute('aria-atomic'),
      ariaRelevant: root.getAttribute('aria-relevant'),
      ariaDescribedBy: root.getAttribute('aria-describedby'),
    } : null,
    box: box(root),
    style: styleOf(root, [
      'position', 'top', 'left', 'zIndex', 'pointerEvents', 'visibility', 'display', 'opacity',
      'backgroundColor', 'color', 'borderRadius', 'animationName', 'animationDuration',
      'animationDelay', 'animationFillMode', '--dsh-toast-hold',
    ]),
    animations: root ? root.getAnimations().map((animation) => ({
      animationName: animation.animationName || null,
      currentTime: animation.currentTime,
      playState: animation.playState,
      duration: animation.effect?.getTiming?.().duration,
      delay: animation.effect?.getTiming?.().delay,
      fill: animation.effect?.getTiming?.().fill,
    })) : [],
    svg: svg ? {
      count: root.querySelectorAll('svg').length,
      viewBox: svg.getAttribute('viewBox'),
      ariaHidden: svg.getAttribute('aria-hidden'),
      paths: [...root.querySelectorAll('svg path')].map((path) => path.getAttribute('d')),
    } : { count: 0, paths: [] },
    currentItem: window.__toastControl?.current() || null,
  };
}
function tabbablesWithin(dialog) {
  if (!dialog) return [];
  const selector = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]';
  return [...dialog.querySelectorAll(selector)].filter((node) => {
    if (node.tabIndex < 0 || node.closest('[inert], [hidden]')) return false;
    const style = getComputedStyle(node);
    return style.display !== 'none' && style.visibility !== 'hidden' && node.getClientRects().length > 0;
  });
}
function modalInfo() {
  const dialog = document.querySelector('[role="dialog"][aria-modal="true"]');
  const root = dialog?.parentElement;
  return {
    dialog: describe(dialog),
    dialogBox: box(dialog),
    root: describe(root),
    rootBox: box(root),
    rootChildren: root ? [...root.children].map(describe) : [],
    rootStyle: styleOf(root, ['position', 'zIndex', 'inset', 'backgroundColor', 'backdropFilter']),
    dialogStyle: styleOf(dialog, ['position', 'zIndex', 'backgroundColor', 'color', 'borderRadius', 'boxShadow', 'width']),
    activeInside: Boolean(dialog && dialog.contains(document.activeElement)),
    tabbables: tabbablesWithin(dialog).map(describe),
  };
}
function orbitInfo() {
  const anchor = document.getElementById('orbit-anchor');
  const panel = document.querySelector('body > [role="dialog"][aria-label="主理鱼 responsive watcher"]');
  return {
    anchor: describe(anchor),
    anchorBox: box(anchor),
    panel: describe(panel),
    panelBox: box(panel),
    panelParent: panel?.parentElement?.tagName || null,
    panelStyle: styleOf(panel, ['position', 'left', 'top', 'width', 'zIndex', 'visibility', 'isolation']),
    activeInside: Boolean(panel && panel.contains(document.activeElement)),
    viewport: { width: innerWidth, height: innerHeight },
    frameClearance: {
      root: getComputedStyle(document.documentElement).getPropertyValue('--dsh-frame-top-clearance').trim(),
      body: getComputedStyle(document.body).getPropertyValue('--dsh-frame-top-clearance').trim(),
    },
  };
}
function themeInfo() {
  return {
    source: document.documentElement.getAttribute('data-ds-theme-source'),
    colorScheme: document.documentElement.style.colorScheme,
    bodyDark: document.body.hasAttribute('data-ds-dark-theme'),
    bodyStyle: styleOf(document.body, ['backgroundColor', 'color', 'colorScheme']),
    tokens: styleOf(document.body, [
      '--dsw-alias-bg-base', '--dsw-alias-bg-layer-1', '--dsw-alias-label-primary',
      '--dsw-alias-bg-mask-1', '--dsw-alias-toast-bg', '--dsw-static-neutral-bluish-00',
    ]),
  };
}
window.__verify = {
  snapshot() {
    return {
      meta: window.__verifyMeta,
      active: describe(document.activeElement),
      toast: toastInfo(),
      modal: modalInfo(),
      orbit: orbitInfo(),
      theme: themeInfo(),
      toastEvents: window.__toastEvents.slice(),
      modalEvents: window.__modalEvents.slice(),
      orbitEvents: window.__orbitEvents.slice(),
      resizeEvents: window.__resizeEvents.slice(),
      nativeEvents: window.__nativeEvents.slice(),
      keydownListenerEvents: window.__keydownListenerEvents.slice(),
      activeKeydownListeners: window.__activeKeydownListeners.map((row) => ({ target: row.targetName, capture: row.capture, at: row.at })),
      captureErrors: window.__captureErrors.slice(),
    };
  },
  toastInfo,
  modalInfo,
  orbitInfo,
  themeInfo,
  clearNativeEvents() { window.__nativeEvents.length = 0; },
  setTheme(theme) {
    document.documentElement.setAttribute('data-ds-theme-source', theme);
    document.documentElement.style.colorScheme = theme;
    if (theme === 'dark') document.body.setAttribute('data-ds-dark-theme', '');
    else document.body.removeAttribute('data-ds-dark-theme');
  },
};

function eventTarget(node) {
  const element = node instanceof Element ? node : null;
  return describe(element?.closest('[id], [role="alert"], [role="dialog"]') || element);
}
for (const type of ['pointerdown', 'click', 'focusin', 'focusout', 'keydown', 'animationstart', 'animationend', 'animationcancel']) {
  document.addEventListener(type, (event) => {
    const row = {
      type,
      key: event.key || null,
      repeat: event.repeat || false,
      animationName: event.animationName || null,
      animationElapsed: event.elapsedTime ?? null,
      defaultPreventedAtCapture: type === 'keydown' ? event.defaultPrevented : null,
      defaultPrevented: event.defaultPrevented,
      target: eventTarget(event.target),
      active: describe(document.activeElement),
      at: performance.now(),
    };
    window.__nativeEvents.push(row);
    if (type === 'keydown') {
      setTimeout(() => {
        row.defaultPrevented = event.defaultPrevented;
        row.activeAfterDispatch = describe(document.activeElement);
      }, 0);
    }
  }, true);
}
window.addEventListener('resize', () => {
  window.__resizeEvents.push({ at: performance.now(), width: innerWidth, height: innerHeight });
});

const toastObserver = new MutationObserver((records) => {
  for (const record of records) {
    for (const [kind, nodes] of [['add', record.addedNodes], ['remove', record.removedNodes]]) {
      for (const node of nodes) {
        if (!(node instanceof Element)) continue;
        const root = node.matches('[role="alert"]') ? node : node.querySelector?.('[role="alert"]');
        if (root) window.__toastEvents.push({ type: kind, nodeId: nodeId(root), text: root.textContent.trim(), at: performance.now() });
      }
    }
  }
});
toastObserver.observe(document.body, { childList: true, subtree: true });
setInterval(() => {
  const root = toastRoot();
  if (!root) return;
  const style = getComputedStyle(root);
  window.__toastSamples.push({
    at: performance.now(),
    nodeId: nodeId(root),
    opacity: Number(style.opacity),
    animationName: style.animationName,
    animations: root.getAnimations().map((animation) => ({ name: animation.animationName || null, currentTime: animation.currentTime, playState: animation.playState })),
  });
  if (window.__toastSamples.length > 3000) window.__toastSamples.splice(0, 1000);
}, 50);

function ToastFixture() {
  const state = host.createToastState();
  const dismiss = state.dismiss;
  const onDone = React.useCallback((id) => {
    window.__toastEvents.push({ type: 'done', id, at: performance.now() });
    dismiss(id);
  }, [dismiss]);
  const notify = (text, tone) => {
    const id = state.notify(text, tone);
    window.__toastEvents.push({ type: 'notify', id, text, tone, at: performance.now() });
    return id;
  };
  if (state.item) window.__toastDoneCallbacks.set(state.item.id, onDone);
  window.__toastControl = {
    notify,
    current: () => state.item,
    invokeDone(id) {
      const callback = window.__toastDoneCallbacks.get(id);
      window.__toastEvents.push({ type: 'stale-invoke', id, callbackFound: Boolean(callback), at: performance.now() });
      if (callback) callback(id);
    },
  };
  return h('section', { className: 'verify-section', id: 'toast-section' },
    h('h2', null, 'Toast · keyed / holdMs=3000 / onDone(id)'),
    h(host.Toast, { item: state.item, onDone }),
    h('div', { className: 'verify-row' },
      h('button', { id: 'toast-success', type: 'button', onClick: () => notify('深色保存成功', 'success') }, 'success'),
      h('button', { id: 'toast-error', type: 'button', onClick: () => notify('深色操作失败', 'error') }, 'error'),
      h('button', { id: 'toast-keyed-next', type: 'button', onClick: () => notify('连续第二条成功', 'success') }, '连续通知'),
      h('button', { id: 'toast-light-error', type: 'button', onClick: () => notify('浅色操作失败', 'error') }, '浅色 error'),
    ),
  );
}

function ModalFixture() {
  const [open, setOpen] = React.useState(false);
  const openModal = () => {
    window.__modalEvents.push({ type: 'open-request', at: performance.now() });
    setOpen(true);
  };
  const closeModal = (source) => {
    window.__modalEvents.push({ type: 'close', source, at: performance.now() });
    setOpen(false);
  };
  return h('section', { className: 'verify-section', id: 'modal-section' },
    h('h2', null, 'Modal · autofocus / focus loop / listener cleanup'),
    h('div', { className: 'verify-row' },
      h('button', { id: 'modal-open', type: 'button', onClick: openModal }, '打开 Modal'),
      h('button', { id: 'outside', type: 'button' }, '外部按钮'),
    ),
    h(host.Modal, {
      open,
      title: '真实 Chromium Modal',
      description: '键盘、背板与焦点归还验收',
      onClose: () => closeModal('host-onClose'),
      footer: h('div', null,
        h('button', { id: 'modal-cancel', type: 'button', 'data-modal-autofocus': true, onClick: () => closeModal('cancel-button') }, '取消'),
        h('button', { id: 'modal-confirm', type: 'button', onClick: () => closeModal('confirm-button') }, '确认'),
      ),
    },
      h('label', { htmlFor: 'modal-input' }, '焦点圈输入框'),
      h('input', { id: 'modal-input', defaultValue: 'Tab / Shift+Tab' }),
    ),
  );
}

function OrbitFixture() {
  const anchorRef = React.useRef(null);
  const orbitRef = React.useRef(null);
  const [open, setOpen] = React.useState(false);
  const close = (detail) => {
    window.__orbitEvents.push({ type: 'close', detail, at: performance.now() });
    setOpen(false);
  };
  return h(React.Fragment, null,
    h('button', {
      id: 'orbit-anchor',
      ref(node) { anchorRef.current = node; orbitRef.current = node; },
      type: 'button',
      'aria-expanded': open,
      onClick() { setOpen((value) => !value); },
    }, '环'),
    h(orbitUi.OrbitPopover, {
      open,
      anchorRef,
      orbitRef,
      onClose: close,
      width: 368,
      className: 'dt-card sa-dock-panel',
      ariaLabel: '主理鱼 responsive watcher',
    },
      h('div', { className: 'verify-row' }, h('strong', null, 'MYCF711/dsh-session-superagent')),
      h('div', { className: 'verify-row' }, h('button', { id: 'orbit-inside', type: 'button' }, '静态动作')),
      h('div', null, 'side=top / align=end / gap=8 / margin=8 / width=368'),
    ),
  );
}

function App() {
  return h('main', null,
    h('h1', { className: 'verify-title' }, '真实 Chromium · Toast / Modal / Responsive / Theme'),
    h(ToastFixture),
    h(ModalFixture),
    h(OrbitFixture),
    h('pre', { id: 'probe-output' }, '真实 DOM / computed style / AX / animation / listener 证据由 Node 驱动脚本采集'),
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
<title>DSH Toast/Modal/Responsive 真实 Chromium 验收</title>
${styles.map((name) => `<link rel="stylesheet" href="/${name}">`).join('\n')}
${Object.entries(installed.themeStyles).map(([name, css]) => `<style data-official-theme="${name}">${css}</style>`).join('\n')}
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

function expectedOrbit(orbit) {
  const margin = 8
  const gap = 8
  const clearance = Number.parseFloat(orbit.frameClearance.root || orbit.frameClearance.body) || 0
  const rawLeft = orbit.anchorBox.right - orbit.panelBox.width
  const rawTop = orbit.anchorBox.top - orbit.panelBox.height - gap
  return {
    rawLeft,
    rawTop,
    // 与安装版 uA 完全同序：过宽面板时右/下边界值可为负，不能交换 min/max 掩盖溢出。
    left: Math.min(Math.max(rawLeft, margin), orbit.viewport.width - orbit.panelBox.width - margin),
    top: Math.min(Math.max(rawTop, margin + clearance), orbit.viewport.height - orbit.panelBox.height - margin),
    flipTop: orbit.anchorBox.bottom + gap,
    margin,
    clearance,
  }
}

function closeTo(actual, expected, tolerance = 1) {
  return Math.abs(actual - expected) <= tolerance
}

const installed = loadInstalledAssets()
const repoPackage = JSON.parse(readFileSync(`${REPO}/package.json`, 'utf8'))
const adapterHashes = Object.fromEntries(['ui-host-primitives.js', 'ui-orbit-popover.js'].map((name) => [
  name,
  createHash('sha256').update(readFileSync(`${REPO}/${name}`)).digest('hex'),
]))
const themeStyleHashes = Object.fromEntries(Object.entries(installed.themeStyles).map(([name, css]) => [
  name,
  createHash('sha256').update(css).digest('hex'),
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
    themeStyleHashes,
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
  console.log(`TASK_SPACE ${task.spaceId}`)
  check('环境', '真实 Chromium 页面与独立 harness 已加载', chromium.startsWith('156.'), { chromium, url: await page.url() })

  let snap = await page.evaluate(() => window.__verify.snapshot())
  check('环境', 'React 来自安装 bundle 且版本为 18.3.1', snap.meta.reactVersion === '18.3.1', snap.meta)
  check('环境', 'primitives 是捕获的同一导出对象且包含 290 exports', snap.meta.primitivesIdentity
    && snap.meta.primitiveExportCount === 290
    && snap.meta.moduleNames.includes('react-dom')
    && snap.meta.moduleNames.includes('react-dom/client'), snap.meta)

  const setTheme = async (theme) => {
    await page.evaluate((value) => window.__verify.setTheme(value), theme)
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  }
  await setTheme('dark')
  snap = await page.evaluate(() => window.__verify.snapshot())
  check('主题', '深色官方 DOM 契约与 token 已生效', snap.theme.source === 'dark'
    && snap.theme.colorScheme === 'dark' && snap.theme.bodyDark
    && Boolean(snap.theme.tokens['--dsw-alias-bg-base'] && snap.theme.tokens['--dsw-alias-label-primary']), snap.theme)
  const darkBodyStyle = snap.theme

  const screenshot = async (name) => {
    const absolute = `${SCREENSHOTS}/${name}`
    await page.screenshot({ path: absolute })
    artifacts.push({ path: `docs/assets/${name}`, absolute })
  }
  const axRecord = async (label, text) => {
    try {
      await page.cdp('Accessibility.enable')
      const tree = await page.cdp('Accessibility.getFullAXTree')
      const nodes = (tree.nodes || []).filter((node) => {
        const role = node.role?.value
        const name = node.name?.value || ''
        return role === 'alert' || role === 'dialog' || (text && name.includes(text))
      }).slice(0, 20).map((node) => ({
        nodeId: node.nodeId,
        role: node.role?.value,
        name: node.name?.value,
        ignored: node.ignored,
        properties: Object.fromEntries((node.properties || []).map((property) => [property.name, property.value?.value])),
      }))
      observe(`Chromium AX · ${label}`, nodes)
      return nodes
    } catch (error) {
      observe(`Chromium AX 未取到 · ${label}`, String(error))
      return null
    }
  }
  const waitToastText = async (text) => {
    await page.waitForFunction((expected) => {
      const root = document.querySelector('body > [role="alert"]')
      return Boolean(root && root.textContent.includes(expected))
    }, text, { timeout: 5000 })
  }
  const waitToastGone = async (id) => {
    await page.waitForFunction((expectedId) => {
      const current = window.__toastControl.current()
      const done = window.__toastEvents.some((event) => event.type === 'done' && event.id === expectedId)
      return !document.querySelector('body > [role="alert"]') && current === null && done
    }, id, { timeout: 7000 })
  }
  const lifecycle = async (id, category, label) => {
    const data = await page.evaluate(() => ({
      events: window.__toastEvents.slice(),
      samples: window.__toastSamples.slice(),
      native: window.__nativeEvents.slice(),
    }))
    const notify = data.events.find((event) => event.type === 'notify' && event.id === id)
    const done = data.events.filter((event) => event.type === 'done' && event.id === id).at(-1)
    const added = data.events.find((event) => event.type === 'add' && event.text.includes(notify?.text || '___'))
    const removed = data.events.filter((event) => event.type === 'remove' && event.text.includes(notify?.text || '___')).at(-1)
    const native = data.native.filter((event) => event.target?.nodeId === added?.nodeId)
    const fadeStart = native.find((event) => event.type === 'animationstart' && /fade|out/i.test(event.animationName || ''))
    const fadeEnd = native.find((event) => event.type === 'animationend' && /fade|out/i.test(event.animationName || ''))
    const samples = data.samples.filter((sample) => sample.nodeId === added?.nodeId && notify && sample.at >= notify.at && sample.at <= (done?.at || Infinity))
    const held = samples.filter((sample) => sample.at - notify.at >= 250 && sample.at - notify.at <= 2850)
    const fading = samples.filter((sample) => sample.at - notify.at > 3050 && sample.at - notify.at < 3950 && sample.opacity > 0.01 && sample.opacity < 0.98)
    const elapsed = done && notify ? done.at - notify.at : null
    const detail = {
      id,
      elapsedMs: elapsed,
      notifyAt: notify?.at,
      addAt: added?.at,
      fadeStartMs: fadeStart && notify ? fadeStart.at - notify.at : null,
      fadeEndMs: fadeEnd && notify ? fadeEnd.at - notify.at : null,
      fadeAnimation: fadeStart?.animationName || null,
      removeAt: removed?.at,
      heldOpacityRange: held.length ? [Math.min(...held.map((sample) => sample.opacity)), Math.max(...held.map((sample) => sample.opacity))] : null,
      fadingSamples: fading.slice(0, 8).map((sample) => ({ atMs: sample.at - notify.at, opacity: sample.opacity })),
      sampleCount: samples.length,
    }
    check(category, `${label} holdMs=3000 + 1000ms fade 后真实 onDone/unmount`, elapsed >= 3700 && elapsed <= 5000
      && Boolean(added && removed && done)
      // React 在约 4000ms 的 onDone 中卸载节点，Chromium 可能不再分发 animationend；
      // fade 的真实性由 animationstart、hold 段 opacity=1 与 fade 段连续 opacity 采样共同证明。
      && Boolean(fadeStart)
      && fadeStart.at - notify.at >= 2700 && fadeStart.at - notify.at <= 3500
      && held.length > 0 && held.every((sample) => sample.opacity >= 0.98)
      && fading.length > 0, detail)
    return detail
  }

  // Toast · 深色 success 完整生命周期。
  await page.click('#toast-success', { label: '触发深色成功 Toast' })
  await waitToastText('深色保存成功')
  await page.waitForTimeout(180)
  snap = await page.evaluate(() => window.__verify.snapshot())
  const successId = snap.toast.currentItem.id
  const darkToastStyle = snap.toast
  check('Toast', 'success portal/role/3000ms/内建图标与指针语义正确', snap.toast.parent === 'BODY'
    && snap.toast.aria.role === 'alert'
    && snap.toast.style['--dsh-toast-hold'] === '3000ms'
    && snap.toast.style.position === 'fixed'
    && snap.toast.style.zIndex === '1100'
    && snap.toast.style.pointerEvents === 'none'
    && snap.toast.svg.count > 0, snap.toast)
  observe('Toast success ARIA 与 computed style', snap.toast)
  await axRecord('深色 success Toast', '深色保存成功')
  await screenshot('ui-toast-responsive-dark-toast.png')
  await waitToastGone(successId)
  await lifecycle(successId, 'Toast', 'success')

  // Toast · error 后 keyed 替换；主动调用旧 id 的真实适配器回调验证 id guard。
  await page.click('#toast-error', { label: '触发深色错误 Toast' })
  await waitToastText('深色操作失败')
  await page.waitForTimeout(350)
  snap = await page.evaluate(() => window.__verify.snapshot())
  const oldId = snap.toast.currentItem.id
  const oldNodeId = snap.toast.nodeId
  const errorSvg = snap.toast.svg
  check('Toast', 'error 使用官方 warning icon，且与 success 图标不同', snap.toast.svg.count > 0
    && JSON.stringify(errorSvg.paths) !== JSON.stringify(darkToastStyle.svg.paths), {
    success: darkToastStyle.svg,
    error: errorSvg,
    aria: snap.toast.aria,
  })
  observe('Toast error ARIA 与 computed style', snap.toast)
  await page.click('#toast-keyed-next', { label: '替换为连续第二条 Toast' })
  await page.waitForFunction((previousNodeId) => {
    const info = window.__verify.toastInfo()
    return info.currentItem?.text === '连续第二条成功' && info.nodeId !== previousNodeId
  }, oldNodeId, { timeout: 5000 })
  snap = await page.evaluate(() => window.__verify.snapshot())
  const newId = snap.toast.currentItem.id
  const newNodeId = snap.toast.nodeId
  const keyedEvents = snap.toastEvents.filter((event) => [oldId, newId].includes(event.id) || [oldNodeId, newNodeId].includes(event.nodeId))
  check('Toast', 'keyed 连续通知只保留一条且真实换 DOM/重启动画', newId !== oldId
    && snap.toast.bodyAlertCount === 1
    && snap.toast.animations.length > 0
    && keyedEvents.some((event) => event.type === 'remove' && event.nodeId === oldNodeId)
    && keyedEvents.some((event) => event.type === 'add' && event.nodeId === newNodeId), {
    oldId,
    newId,
    oldNodeId,
    newNodeId,
    animations: snap.toast.animations,
    keyedEvents,
  })
  await page.evaluate((id) => window.__toastControl.invokeDone(id), oldId)
  await page.waitForTimeout(120)
  snap = await page.evaluate(() => window.__verify.snapshot())
  check('Toast', '旧 onDone(id) 回调不清除 keyed 新通知', snap.toast.currentItem?.id === newId
    && snap.toast.nodeId === newNodeId
    && snap.toastEvents.some((event) => event.type === 'stale-invoke' && event.id === oldId && event.callbackFound)
    && snap.toastEvents.some((event) => event.type === 'done' && event.id === oldId), {
    currentItem: snap.toast.currentItem,
    nodeId: snap.toast.nodeId,
    expectedNodeId: newNodeId,
    events: snap.toastEvents.filter((event) => [oldId, newId].includes(event.id)),
  })
  await waitToastGone(newId)
  await lifecycle(newId, 'Toast', 'keyed 第二条')

  // Modal · 深色完整键盘、背板、焦点与 listener 生命周期。
  const listenerBaseline = await page.evaluate(() => window.__activeKeydownListeners.length)
  const openModal = async () => {
    await page.click('#modal-open', { label: '打开真实 Modal' })
    await page.waitForSelector('[role="dialog"][aria-modal="true"]', { state: 'visible', timeout: 5000 })
    await page.waitForFunction(() => document.activeElement?.id === 'modal-cancel', undefined, { timeout: 3000 })
    await page.waitForTimeout(60)
  }
  const waitModalGone = async () => {
    await page.waitForFunction(() => !document.querySelector('[role="dialog"][aria-modal="true"]'), undefined, { timeout: 5000 })
    await page.waitForTimeout(100)
  }
  await openModal()
  snap = await page.evaluate(() => window.__verify.snapshot())
  const darkModalStyle = snap.modal
  check('Modal', '初始 autofocus 落在 data-modal-autofocus 取消按钮', snap.active.id === 'modal-cancel'
    && snap.modal.activeInside && snap.modal.rootStyle.zIndex === '1000', {
    active: snap.active,
    modal: snap.modal,
  })
  await axRecord('深色 Modal', '真实 Chromium Modal')
  await screenshot('ui-toast-responsive-dark-modal.png')

  const tabbableIds = snap.modal.tabbables.map((node) => node.nodeId)
  const cancelNodeId = snap.active.nodeId
  const cancelIndex = tabbableIds.indexOf(cancelNodeId)
  await page.keyboard.press('Shift+Tab')
  let focusSnap = await page.evaluate(() => window.__verify.snapshot())
  const previousExpected = tabbableIds[(cancelIndex - 1 + tabbableIds.length) % tabbableIds.length]
  const shiftBackPass = focusSnap.active.nodeId === previousExpected && focusSnap.modal.activeInside
  await page.keyboard.press('Tab')
  focusSnap = await page.evaluate(() => window.__verify.snapshot())
  check('Modal', 'Shift+Tab 到上一可聚焦项，Tab 返回 autofocus', shiftBackPass
    && focusSnap.active.nodeId === cancelNodeId && focusSnap.modal.activeInside, {
    tabbables: snap.modal.tabbables,
    shiftBackNodeId: previousExpected,
    finalActive: focusSnap.active,
  })

  const tabLoop = []
  let loopInside = true
  for (let index = 0; index < tabbableIds.length; index += 1) {
    await page.keyboard.press('Tab')
    focusSnap = await page.evaluate(() => window.__verify.snapshot())
    tabLoop.push(focusSnap.active)
    loopInside = loopInside && focusSnap.modal.activeInside
  }
  check('Modal', 'Tab 完整焦点圈不逃逸且回到起点', loopInside
    && focusSnap.active.nodeId === cancelNodeId
    && new Set(tabLoop.map((node) => node.nodeId)).size === tabbableIds.length, {
    tabbables: snap.modal.tabbables,
    sequence: tabLoop,
  })
  const shiftLoop = []
  loopInside = true
  for (let index = 0; index < tabbableIds.length; index += 1) {
    await page.keyboard.press('Shift+Tab')
    focusSnap = await page.evaluate(() => window.__verify.snapshot())
    shiftLoop.push(focusSnap.active)
    loopInside = loopInside && focusSnap.modal.activeInside
  }
  check('Modal', 'Shift+Tab 完整反向焦点圈不逃逸且回到起点', loopInside
    && focusSnap.active.nodeId === cancelNodeId
    && new Set(shiftLoop.map((node) => node.nodeId)).size === tabbableIds.length, {
    sequence: shiftLoop,
  })

  await page.evaluate(() => window.__verify.clearNativeEvents())
  let beforeCloseCount = (await page.evaluate(() => window.__modalEvents.slice())).filter((event) => event.type === 'close').length
  await page.keyboard.press('Escape')
  await waitModalGone()
  await page.waitForTimeout(30)
  snap = await page.evaluate(() => window.__verify.snapshot())
  let closeEvents = snap.modalEvents.filter((event) => event.type === 'close')
  let escapeEvent = snap.nativeEvents.find((event) => event.type === 'keydown' && event.key === 'Escape')
  check('Modal', 'Escape preventDefault、单次 onClose、关闭后焦点归还 opener', closeEvents.length - beforeCloseCount === 1
    && closeEvents.at(-1)?.source === 'host-onClose'
    && escapeEvent?.defaultPrevented === true
    && snap.active.id === 'modal-open', {
    escapeEvent,
    closeEvents: closeEvents.slice(beforeCloseCount),
    active: snap.active,
  })
  check('Modal', 'Escape 关闭后 keydown listener 回到基线', snap.activeKeydownListeners.length === listenerBaseline, {
    baseline: listenerBaseline,
    active: snap.activeKeydownListeners,
  })

  await openModal()
  const backdropHit = await page.evaluate(() => {
    const node = document.elementFromPoint(16, 16)
    return {
      tag: node?.tagName,
      id: node?.id || null,
      className: typeof node?.className === 'string' ? node.className : null,
      role: node?.getAttribute?.('role'),
      insideDialog: Boolean(node?.closest?.('[role="dialog"][aria-modal="true"]')),
    }
  })
  beforeCloseCount = (await page.evaluate(() => window.__modalEvents.slice())).filter((event) => event.type === 'close').length
  await page.mouse.click(16, 16, { label: '点击 Modal 背板' })
  await waitModalGone()
  snap = await page.evaluate(() => window.__verify.snapshot())
  closeEvents = snap.modalEvents.filter((event) => event.type === 'close')
  check('Modal', '真实背板点击单次关闭且焦点归还 opener', !backdropHit.insideDialog
    && closeEvents.length - beforeCloseCount === 1
    && closeEvents.at(-1)?.source === 'host-onClose'
    && snap.active.id === 'modal-open', {
    backdropHit,
    closeEvents: closeEvents.slice(beforeCloseCount),
    active: snap.active,
  })

  const cycleRows = []
  for (let index = 0; index < 5; index += 1) {
    await openModal()
    const opened = await page.evaluate(() => window.__verify.snapshot())
    const before = opened.modalEvents.filter((event) => event.type === 'close').length
    if (index % 2 === 0) await page.keyboard.press('Escape')
    else await page.click('#modal-cancel', { label: '取消并关闭 Modal' })
    await waitModalGone()
    const closed = await page.evaluate(() => window.__verify.snapshot())
    const closes = closed.modalEvents.filter((event) => event.type === 'close')
    cycleRows.push({
      cycle: index + 1,
      autofocus: opened.active.id,
      openListeners: opened.activeKeydownListeners.length,
      closedListeners: closed.activeKeydownListeners.length,
      closeDelta: closes.length - before,
      closeSource: closes.at(-1)?.source,
      restored: closed.active.id,
    })
  }
  check('Modal', '连续 5 次打开/关闭不残留 keydown listener', cycleRows.every((row) => row.autofocus === 'modal-cancel'
    && row.closedListeners === listenerBaseline
    && row.closeDelta === 1
    && row.restored === 'modal-open'), { baseline: listenerBaseline, cycles: cycleRows })
  check('Modal', '连续打开后的 Escape 仍只触发一次宿主 onClose', cycleRows[4].closeSource === 'host-onClose'
    && cycleRows[4].closeDelta === 1, cycleRows[4])

  // Orbit · 真实 resize 与窄视口，按 DSH top/end clamp 计算，不期待 flip。
  const setViewport = async (width, height) => {
    await page.cdp('Emulation.setDeviceMetricsOverride', {
      width,
      height,
      deviceScaleFactor: 1,
      mobile: false,
    })
    await page.waitForFunction((expected) => innerWidth === expected.width && innerHeight === expected.height, { width, height }, { timeout: 5000 })
    const resizeObserved = await page.waitForFunction((expected) => window.__resizeEvents.some((event) => (
      event.width === expected.width && event.height === expected.height
    )), { width, height }, { timeout: 2500 }).then(() => true).catch(() => false)
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    await page.waitForTimeout(80)
    observe('viewport settled', {
      requested: { width, height },
      resizeObserved,
      events: await page.evaluate(() => window.__resizeEvents.slice()),
      orbit: await page.evaluate(() => window.__verify.orbitInfo()),
    })
    return resizeObserved
  }
  const checkOrbitClamp = (label, orbit, category = '响应式') => {
    const expected = expectedOrbit(orbit)
    check(category, `${label} left/top 符合 DSH top/end clamp`, closeTo(orbit.panelBox.left, expected.left)
      && closeTo(orbit.panelBox.top, expected.top), { expected, actual: orbit })
    check(category, `${label} 上边不足时 clamp 而非自动 flip`, expected.rawTop < expected.margin + expected.clearance
      && closeTo(orbit.panelBox.top, expected.top)
      && !closeTo(orbit.panelBox.top, expected.flipTop), {
      rawTop: expected.rawTop,
      clampTop: expected.top,
      hypotheticalFlipTop: expected.flipTop,
      actualTop: orbit.panelBox.top,
      anchor: orbit.anchorBox,
    })
  }
  await setViewport(900, 700)
  await page.click('#orbit-anchor', { label: '打开边缘锚定 Orbit' })
  await page.waitForSelector('body > [role="dialog"][aria-label="主理鱼 responsive watcher"]', { state: 'visible', timeout: 5000 })
  await page.waitForFunction(() => getComputedStyle(document.querySelector('body > [role="dialog"][aria-label="主理鱼 responsive watcher"]')).visibility === 'visible', undefined, { timeout: 5000 })
  await page.waitForTimeout(100)
  snap = await page.evaluate(() => window.__verify.snapshot())
  checkOrbitClamp('900×700 右上边缘', snap.orbit)
  const resizeBefore = snap.resizeEvents.length
  await setViewport(640, 560)
  snap = await page.evaluate(() => window.__verify.snapshot())
  checkOrbitClamp('resize 到 640×560', snap.orbit)
  check('响应式', 'resize 事件真实触发且 panel 随右缘 anchor 重算', snap.resizeEvents.length > resizeBefore
    && snap.resizeEvents.at(-1)?.width === 640
    && closeTo(snap.orbit.panelBox.left, expectedOrbit(snap.orbit).left), {
    before: resizeBefore,
    after: snap.resizeEvents,
    panel: snap.orbit.panelBox,
  })
  await setViewport(360, 640)
  snap = await page.evaluate(() => window.__verify.snapshot())
  checkOrbitClamp('窄视口 360×640', snap.orbit)
  check('响应式', '360px 视口 panel 横向不越界', snap.orbit.panelBox.left >= 0
    && snap.orbit.panelBox.right <= snap.orbit.viewport.width, {
    viewport: snap.orbit.viewport,
    panel: snap.orbit.panelBox,
    overflowLeft: Math.max(0, -snap.orbit.panelBox.left),
    overflowRight: Math.max(0, snap.orbit.panelBox.right - snap.orbit.viewport.width),
  })
  await screenshot('ui-toast-responsive-narrow-orbit.png')
  await setViewport(320, 568)
  snap = await page.evaluate(() => window.__verify.snapshot())
  checkOrbitClamp('窄视口 320×568', snap.orbit)
  check('响应式', '320px 视口 panel 横向不越界', snap.orbit.panelBox.left >= 0
    && snap.orbit.panelBox.right <= snap.orbit.viewport.width, {
    viewport: snap.orbit.viewport,
    panel: snap.orbit.panelBox,
    overflowLeft: Math.max(0, -snap.orbit.panelBox.left),
    overflowRight: Math.max(0, snap.orbit.panelBox.right - snap.orbit.viewport.width),
  })
  await page.keyboard.press('Escape')
  await page.waitForFunction(() => !document.querySelector('body > [role="dialog"][aria-label="主理鱼 responsive watcher"]'), undefined, { timeout: 5000 })
  await page.cdp('Emulation.clearDeviceMetricsOverride')
  await page.waitForTimeout(150)

  // 浅色不是静态 preview：真实点击 error Toast、等待自然完成，再操作 Modal 键盘。
  await setTheme('light')
  snap = await page.evaluate(() => window.__verify.snapshot())
  check('主题', '浅色官方 DOM 契约与 token 已生效', snap.theme.source === 'light'
    && snap.theme.colorScheme === 'light' && !snap.theme.bodyDark
    && Boolean(snap.theme.tokens['--dsw-alias-bg-base'] && snap.theme.tokens['--dsw-alias-label-primary']), snap.theme)
  const lightBodyStyle = snap.theme
  check('主题', '深浅主题页面 computed style/token 真实变化', darkBodyStyle.bodyStyle.backgroundColor !== lightBodyStyle.bodyStyle.backgroundColor
    && darkBodyStyle.tokens['--dsw-alias-bg-base'] !== lightBodyStyle.tokens['--dsw-alias-bg-base'], {
    dark: darkBodyStyle,
    light: lightBodyStyle,
  })
  await page.click('#toast-light-error', { label: '触发浅色错误 Toast' })
  await waitToastText('浅色操作失败')
  await page.waitForTimeout(180)
  snap = await page.evaluate(() => window.__verify.snapshot())
  const lightToastId = snap.toast.currentItem.id
  const lightToastStyle = snap.toast
  check('主题', '浅色 error Toast 为真实可交互原语且 computed style 已采集', snap.toast.parent === 'BODY'
    && snap.toast.currentItem?.tone === 'error'
    && snap.toast.svg.count > 0
    && snap.toast.style['--dsh-toast-hold'] === '3000ms', {
    dark: darkToastStyle.style,
    light: lightToastStyle.style,
    aria: lightToastStyle.aria,
  })
  await axRecord('浅色 error Toast', '浅色操作失败')
  await screenshot('ui-toast-responsive-light-toast.png')
  await waitToastGone(lightToastId)
  await lifecycle(lightToastId, '主题', '浅色 error Toast')

  await openModal()
  snap = await page.evaluate(() => window.__verify.snapshot())
  const lightModalStyle = snap.modal
  check('主题', '浅色 Modal 真实 autofocus 与键盘焦点有效', snap.active.id === 'modal-cancel' && snap.modal.activeInside, {
    active: snap.active,
    modal: lightModalStyle,
  })
  await page.keyboard.press('Tab')
  const lightTab = await page.evaluate(() => window.__verify.snapshot())
  await page.keyboard.press('Shift+Tab')
  const lightShiftTab = await page.evaluate(() => window.__verify.snapshot())
  check('主题', '浅色 Modal Tab/Shift+Tab 往返不逃逸', lightTab.modal.activeInside
    && lightTab.active.id === 'modal-confirm'
    && lightShiftTab.active.id === 'modal-cancel', {
    tab: lightTab.active,
    shiftTab: lightShiftTab.active,
  })
  observe('双主题 Modal computed style', {
    dark: darkModalStyle.dialogStyle,
    light: lightModalStyle.dialogStyle,
    darkRoot: darkModalStyle.rootStyle,
    lightRoot: lightModalStyle.rootStyle,
  })
  check('主题', '深浅 Modal 关键 computed style 真实变化', darkModalStyle.dialogStyle.backgroundColor !== lightModalStyle.dialogStyle.backgroundColor
    || darkModalStyle.dialogStyle.color !== lightModalStyle.dialogStyle.color, {
    dark: darkModalStyle.dialogStyle,
    light: lightModalStyle.dialogStyle,
  })
  await axRecord('浅色 Modal', '真实 Chromium Modal')
  await screenshot('ui-toast-responsive-light-modal.png')
  beforeCloseCount = (await page.evaluate(() => window.__modalEvents.slice())).filter((event) => event.type === 'close').length
  await page.keyboard.press('Escape')
  await waitModalGone()
  snap = await page.evaluate(() => window.__verify.snapshot())
  closeEvents = snap.modalEvents.filter((event) => event.type === 'close')
  check('主题', '浅色 Modal Escape 单次关闭、焦点归还且 listener 无残留', closeEvents.length - beforeCloseCount === 1
    && snap.active.id === 'modal-open'
    && snap.activeKeydownListeners.length === listenerBaseline, {
    closeEvents: closeEvents.slice(beforeCloseCount),
    active: snap.active,
    baseline: listenerBaseline,
    listeners: snap.activeKeydownListeners,
  })

  snap = await page.evaluate(() => window.__verify.snapshot())
  const unexpectedErrors = snap.captureErrors.filter((event) => !String(event.message).includes('intentional-capture-stop'))
  check('环境', 'harness 无未预期页面错误', unexpectedErrors.length === 0, unexpectedErrors)

  for (const artifact of artifacts) {
    const body = await readFile(artifact.absolute)
    artifact.bytes = body.length
    artifact.sha256 = createHash('sha256').update(body).digest('hex')
    if (body.length >= 24 && body.subarray(1, 4).toString() === 'PNG') {
      artifact.width = body.readUInt32BE(16)
      artifact.height = body.readUInt32BE(20)
    }
    delete artifact.absolute
  }
  const categories = {}
  for (const category of new Set(results.map((row) => row.category))) {
    const rows = results.filter((row) => row.category === category)
    categories[category] = {
      passed: rows.filter((row) => row.pass).length,
      failed: rows.filter((row) => !row.pass).length,
      total: rows.length,
      failedNames: rows.filter((row) => !row.pass).map((row) => row.name),
    }
  }
  const passed = results.filter((row) => row.pass).length
  const failed = results.length - passed
  const summary = {
    passed,
    failed,
    total: results.length,
    categories,
    chromium,
    repoVersion: repoPackage.version,
    adapterHashes,
    frontendVersion: installed.frontendVersion,
    primitivesRange: installed.primitivesRange,
    asarSha256: installed.asarSha256,
    themeStyleHashes,
    react: snap.meta.reactVersion,
    primitiveExportCount: snap.meta.primitiveExportCount,
    artifacts,
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
      toastEvents: window.__toastEvents,
      modalEvents: window.__modalEvents,
      body: document.body.innerText.slice(0, 3000),
    })), null, 2))
  } catch {}
  process.exitCode = 1
} finally {
  const closing = new Promise((resolve) => server.close(resolve))
  server.closeAllConnections?.()
  await closing
  if (completed) {
    await task.finish({ keep: [] })
  } else {
    console.log(`TASK_SPACE_KEPT ${task.spaceId}（脚本异常，保留未完成现场）`)
  }
}
