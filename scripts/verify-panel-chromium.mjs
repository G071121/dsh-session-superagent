// 真实 Chromium + 安装版 DSH React/primitives + 完整 session-superagent-desk / orbit / Modal 验收，
// 外加门禁面板（GateSettings）与「模型列表来源」的异步竞态场景（v6 从临时 harness 收进仓库）。
//
// 覆盖（都是安装版 React 18 + 仓库里真实的 client.js，真实 Chromium 里跑）：
//   ① 主面板四页 + 设置五分区 + Orbit + 确认 Modal + 防写 403（既有）。
//   ② 门禁面板 U1：迟到的 /gates、跨仓库/同仓库乱序、在途 dirty、取消换仓库、保存与预览的 targetRepo、保存后重读。
//   ③ 模型列表 U5：按钮「读取模型列表」、迟到响应、闸门挡住 /gates、取消、确认放弃草稿、项目/我的两种作用域。
// ②③ 的 HTTP 打到**本脚本自己的 loopback fixture**（GET /gates、GET /gates/models 按仓库 + 序号应答，
//   并可按请求注入延迟/失败）：这是浏览器证据（真实 Chromium + 安装版 React），但**不是真实 WebView**，
//   也不是真实 /gates 服务端或真实模型列表。单测桩 test/fixtures/gate-panel.mjs 只做快速回归，
//   浏览器证据以本脚本为准。全部场景都在仓库里，一条命令复跑，不依赖 /tmp 探针。
//
// 运行（只解析路径，不启动浏览器）：node scripts/verify-panel-chromium.mjs --print-paths
// 运行（真实验收）：ego-browser 的 nodejs 沙箱**不继承父进程 env**、cwd 是 ego 安装目录，
//   所以仓库根要用 prelude 显式传进去（Git Bash；`pwd -W` 出的是 D:/… 形式）：
//     { echo "process.env.DSH_SUPERAGENT_REPO='$(pwd -W)'"; cat scripts/verify-panel-chromium.mjs; } | ego-browser nodejs
//   直接 `node scripts/verify-panel-chromium.mjs` 时按脚本位置推导，不需要这一步。
//
// 路径解析（原来写死过一次旧安装，见 0.10.8 修复）：
//   仓库根：$DSH_SUPERAGENT_REPO → 脚本所在目录的上一级 → 当前工作目录（后两者都必须真的有 client.js）。
//           管道/stdio 运行时 import.meta.url 不可用，所以**不再**回落到某台机器上的临时目录。
//   DSH 安装：$DSH_ASAR + $DSH_ELECTRON（必须成对）→ $DSH_INSTALL_ROOT → 扫描 $DSH_INSTALL_SCAN
//           （默认 $DSH_HOME 的上一级、$DSH_PROFILE_DIR 的三级上一级）下所有 */resources/app.asar，
//           取 app.asar mtime 最新的那个；多套安装共存时不会静默验旧版。
// 独立 loopback fake API；不进入真实 DSH Web GUI，不访问 GitHub/npm，不执行更新、删除或其他真实写操作。

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import { delimiter, dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ELECTRON_EXE = 'DeepSeek Harness.exe'

function fail(message) {
  console.error('verify-panel-chromium: ' + message)
  process.exit(2)
}

/** 仓库根：环境变量 → 脚本位置 → 当前目录（调用方随后校验真的有 client.js/package.json）。 */
function resolveRepo(env, importUrl, cwd) {
  if (env.DSH_SUPERAGENT_REPO) return resolve(env.DSH_SUPERAGENT_REPO)
  if (typeof importUrl === 'string' && importUrl.startsWith('file:') && !importUrl.includes('[eval')) {
    return resolve(dirname(fileURLToPath(importUrl)), '..')
  }
  return cwd
}

/** 扫描安装根：父目录下的子目录同时有 resources/app.asar 与 DeepSeek Harness.exe 才算候选。 */
function scanInstallRoots(parents) {
  const found = []
  for (const parent of parents) {
    let names = []
    try { names = readdirSync(parent) } catch { continue }
    for (const name of names) {
      const root = join(parent, name)
      const asar = join(root, 'resources', 'app.asar')
      const electron = join(root, ELECTRON_EXE)
      if (!existsSync(asar) || !existsSync(electron)) continue
      found.push({ root, asar, electron, mtimeMs: statSync(asar).mtimeMs })
    }
  }
  return found
}

/** 解析 DSH 安装（优先级见文件头）。解析不出来就报错，不拼一个"大概能用"的默认路径。 */
function resolveInstall(env) {
  const explicitAsar = env.DSH_ASAR ? resolve(env.DSH_ASAR) : null
  const explicitElectron = env.DSH_ELECTRON ? resolve(env.DSH_ELECTRON) : null
  if (explicitAsar || explicitElectron) {
    if (!explicitAsar || !explicitElectron) fail('DSH_ASAR 与 DSH_ELECTRON 必须同时给（只给一个无法保证验的是同一套安装）')
    if (!existsSync(explicitAsar)) fail('DSH_ASAR 不存在：' + explicitAsar)
    if (!existsSync(explicitElectron)) fail('DSH_ELECTRON 不存在：' + explicitElectron)
    return { root: resolve(dirname(explicitAsar), '..'), asar: explicitAsar, electron: explicitElectron, source: 'env:DSH_ASAR+DSH_ELECTRON' }
  }
  if (env.DSH_INSTALL_ROOT) {
    const root = resolve(env.DSH_INSTALL_ROOT)
    const foundAsar = join(root, 'resources', 'app.asar')
    const foundElectron = join(root, ELECTRON_EXE)
    if (!existsSync(foundAsar) || !existsSync(foundElectron)) {
      fail('DSH_INSTALL_ROOT 下缺 resources/app.asar 或 ' + ELECTRON_EXE + '：' + root)
    }
    return { root, asar: foundAsar, electron: foundElectron, source: 'env:DSH_INSTALL_ROOT' }
  }
  const parents = []
  if (env.DSH_INSTALL_SCAN) {
    for (const part of String(env.DSH_INSTALL_SCAN).split(delimiter)) if (part.trim()) parents.push(resolve(part.trim()))
  } else {
    if (env.DSH_HOME) parents.push(resolve(env.DSH_HOME, '..'))
    if (env.DSH_PROFILE_DIR) parents.push(resolve(env.DSH_PROFILE_DIR, '..', '..', '..'))
  }
  const unique = [...new Set(parents)]
  const candidates = scanInstallRoots(unique)
  if (candidates.length === 0) {
    fail('找不到 DSH 安装（扫描：' + (unique.join(' | ') || '无候选目录') + '）。设 DSH_INSTALL_ROOT，或 DSH_ASAR+DSH_ELECTRON。')
  }
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs)
  const chosen = candidates[0]
  return { ...chosen, source: 'scan:' + chosen.root + '（' + candidates.length + ' 个候选取 mtime 最新）' }
}

const REPO = resolveRepo(process.env, import.meta.url, process.cwd())
if (!REPO || !existsSync(join(REPO, 'client.js')) || !existsSync(join(REPO, 'package.json'))) {
  fail('仓库根无效（' + (REPO || '未解析到') + '）：请设 DSH_SUPERAGENT_REPO 指向含 client.js 的仓库根')
}
// 门禁 / 模型 17 条场景的唯一真源（scripts/gate-model-scenarios.mjs）。
// 本文件常经 stdin 注入（`cat … | ego-browser nodejs`），静态 import 的相对说明符会按 ego 的
// cwd 解析而找不到，所以只能按「仓库根的绝对 file URL」动态 import。
const { GATE_MODEL_SCENARIOS, GATE_MODEL_SCENARIO_IDS } = await import(
  pathToFileURL(join(REPO, 'scripts', 'gate-model-scenarios.mjs')).href)

// dry-run 出口（Q2-2）：不启动浏览器、不连 DSH 安装，只报「源码里实际注册了哪些门禁/模型场景」。
// 静态护栏（test/client.test.mjs）spawn 它，再把 registered 与 GATE_MODEL_SCENARIO_IDS 对集合 ——
// 少一条（场景被整段删掉）、多一条（漏登记）、重复、或掏空成字面量 true，都会红。
if (process.argv.includes('--list-scenarios')) {
  const suiteSource = readFileSync(join(REPO, 'scripts', 'verify-panel-chromium.mjs'), 'utf8')
  const registered = [...suiteSource.matchAll(/gateScenarioCheck\(\s*'([A-Za-z0-9-]+)'/g)].map((match) => match[1])
  console.log(JSON.stringify({ declared: GATE_MODEL_SCENARIO_IDS, registered, total: registered.length }, null, 2))
  process.exit(0)
}
const install = resolveInstall(process.env)
const ASAR = install.asar
const ELECTRON = install.electron
const FRONTEND = `${ASAR}/dsh/node_modules/@deepseek-ai/dsh-web-frontend`
const THEME_CLIENT = `${ASAR}/dsh/node_modules/@deepseek-ai/dsh-client-ui-theme/lib/client.js`
// rc.2 随包发主题样式源码；rc.1 没有这个目录（走 THEME_CLIENT 的 var 通道）。
const THEME_SRC_STYLES = `${ASAR}/dsh/node_modules/@deepseek-ai/dsh-client-ui-theme/src/styles`
const SCREENSHOTS = `${REPO}/docs/assets`
// Issue #35 的证据目录：真实 Chromium 的几何/点击日志与深浅窄屏截图落这里，不混进 docs/assets 基线。
// 默认在仓库内 tmp-artifacts/issue-35（tmp-* 已被 .gitignore 覆盖）——脚本绝不隐式写到仓库之外；
// 需要别的落点（例如汇总目录）时用 DSH_ISSUE35_ARTIFACTS 显式重定向。
const ISSUE35_ARTIFACTS = process.env.DSH_ISSUE35_ARTIFACTS
  ? resolve(process.env.DSH_ISSUE35_ARTIFACTS)
  : join(REPO, 'tmp-artifacts', 'issue-35')
const ISSUE35_ARTIFACTS_SOURCE = process.env.DSH_ISSUE35_ARTIFACTS
  ? 'env:DSH_ISSUE35_ARTIFACTS'
  : 'default:tmp-artifacts/issue-35'

// 只解析路径的探针：给测试与「验的到底是哪一版」取证用，不启动浏览器。
if (process.argv.includes('--print-paths')) {
  console.log(JSON.stringify({
    repo: REPO,
    installRoot: install.root,
    asar: ASAR,
    electron: ELECTRON,
    source: install.source,
    frontend: FRONTEND,
    themeClient: THEME_CLIENT,
    issue35Artifacts: ISSUE35_ARTIFACTS,
    issue35ArtifactsSource: ISSUE35_ARTIFACTS_SOURCE,
  }, null, 2))
  process.exit(0)
}
const SESSION_ID = 'session-panel-chromium-fixture'
// 每次验收用独立任务空间：崩溃重跑时不能复用上一次残留页面/事件监听，否则会伪造失败。
const SPACE_NAME = 'dsh-full-panel-chromium-deep-ui-' + String(Date.now())
const results = []
const observations = []
const artifacts = []
const deskCaptures = []
// 本机两次真实运行分别死在 desk raw CDP 与 Orbit page.screenshot 内，异常不会回到页面侧 catch。
// 本轮强制 SKIP 截图；需要重试通道时只改此 harness 开关，不触碰生产代码。
const CAPTURE_SCREENSHOTS = false
const apiLog = []
const debugLines = []
const debug = (line) => debugLines.push(line)
const unverified = [
  '未进入需要真实会话与凭证的 DSH Web GUI；本脚本验证独立 loopback 页面中真实 client.js 的 slot 注册以及 desk/orbit Component 挂载。',
  '真实 StatusOrbit 签名无 props；sessionId 传给 desk，Orbit watcher 数据由同一 fixture /state API 提供，不虚构 ctx/slot 参数。',
  '门禁/模型场景（U1/U5）的 GET /gates、GET /gates/models、POST /gates/preview 与 POST /gates 全部打本脚本的 loopback fixture：不是真实 WebView、不是真实服务端、不是真实模型；只验面板在真实 React 18 下的行为，不验服务端持久化。',
  '未执行真实保存、安装更新、删除、暂停、恢复或 watcher 轮询；除门禁 fixture 的 POST 外，另有两条显式防写探针（末尾 guardProbe 与 Issue #35 确认点击），都必须由 loopback 返回 403。',
  '未验物理读屏、触摸、IME、真实 GitHub/Gitee 响应与真实 watcher 状态变化。',
]

function check(name, pass, detail) {
  const row = { name, pass: Boolean(pass), detail }
  results.push(row)
  const line = `${row.pass ? 'PASS' : 'FAIL'} ${name}${detail === undefined ? '' : ` ${JSON.stringify(detail)}`}`
  debug(line)
  console.log(line)
  return row.pass
}

// ── 门禁 / 模型场景注册（Q2-2）──────────────────────────────────────────────
// 17 条 U1-V* / U5-V* 场景一律走这里，不再直接写 check('U1-V1 …', …)：
//   ① 场景名只有一份（scripts/gate-model-scenarios.mjs），改文案不用同步两处；
//   ② id 必须已声明，重复注册直接抛；
//   ③ 收尾用 registeredGateScenarios 做完整性硬断言 —— 有场景被 if (false) 包住时，
//      这里会抛错而不是静默少一条覆盖。
const registeredGateScenarios = []
function gateScenarioCheck(id, pass, detail) {
  const name = GATE_MODEL_SCENARIOS[id]
  if (!name) throw new Error('未声明或拼错的门禁/模型场景 id：' + id)
  if (registeredGateScenarios.includes(id)) throw new Error('门禁/模型场景重复注册：' + id)
  registeredGateScenarios.push(id)
  return check(name, pass, detail)
}

/** 收尾硬断言：17 条必须条条真的跑到。少一条就抛（=> 脚本执行完成 FAIL + exit 1）。 */
function assertAllGateScenariosRan() {
  const missing = GATE_MODEL_SCENARIO_IDS.filter((id) => !registeredGateScenarios.includes(id))
  const extra = registeredGateScenarios.filter((id) => !GATE_MODEL_SCENARIO_IDS.includes(id))
  if (missing.length === 0 && extra.length === 0 && registeredGateScenarios.length === GATE_MODEL_SCENARIO_IDS.length) return
  throw new Error('门禁/模型场景没有全部执行：实跑 ' + registeredGateScenarios.length
    + '/' + GATE_MODEL_SCENARIO_IDS.length
    + (missing.length ? '，缺 ' + missing.join(',') : '')
    + (extra.length ? '，多 ' + extra.join(',') : ''))
}

function observe(name, detail) {
  observations.push({ name, detail })
  const line = `OBSERVE ${name} ${JSON.stringify(detail)}`
  debug(line)
  console.log(line)
}

function sha256(body) {
  return createHash('sha256').update(body).digest('hex')
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
// rc.2 起主题包不再用 var *_css_default = "..." 内联整表（lib/client.js 只剩组件 CSS module），
// 官方把主题样式随包发在 src/styles/*.css；rc.1 仍走上面的 var 通道，两套都不猜顺序。
const themeStyleFiles = {
  base_css_default: 'base.css',
  corner_shape_css_default: 'corner-shape.css',
  design_platform_css_default: 'design-platform.css',
  focus_css_default: 'focus.css',
  onboarding_css_default: 'onboarding.css',
  scrollbar_css_default: 'scrollbar.css',
  gradient_shadow_text_css_default: 'gradient-shadow-text.css',
  shiki_css_default: 'shiki.css',
};
for (const name of requiredThemeStyles) {
  if (typeof themeStyles[name] === 'string') continue;
  const path = process.argv[4] + '/' + themeStyleFiles[name];
  if (fs.existsSync(path)) themeStyles[name] = fs.readFileSync(path, 'utf8');
}
for (const name of requiredThemeStyles) {
  if (typeof themeStyles[name] !== 'string') {
    throw new Error('missing official theme style: ' + name + '（rc.1 的 var 通道与 rc.2 的 src/styles 通道都没有）');
  }
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
  const output = execFileSync(ELECTRON, ['-e', reader, FRONTEND, ASAR, THEME_CLIENT, THEME_SRC_STYLES], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
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
  // Q2 修复（v6）：同 URL 的在途 GET 会被 Chromium「请求折叠」（第二次要等第一次响应结束才发出），
  // 于是「同仓库两次读取乱序」（U1-V3 / U5-V2b）根本构造不出来 —— 服务端看到两次请求间隔
  // 恒等于首条注入延迟（实测 2006ms / 3003ms），拆掉 client.js 的序号闸门也照样全绿。
  // 响应头 cache-control: no-store 挡不住折叠，必须在 fetch init 里显式 cache: 'no-store'。
  // 只改 harness，不碰产品代码（client.js 的 call() 保持原样）。
  return nativeFetch(input, { ...(init || {}), cache: 'no-store' });
};
`

const HARNESS_CSS = `
html, body { margin: 0; min-height: 100%; background: var(--dsw-alias-bg-base, #101114); }
body { color: var(--dsw-alias-label-primary, #f4f4f5); font-family: var(--dsw-font-family, system-ui, sans-serif); }
#root { display: none !important; }
#app { height: 100vh; min-height: 640px; }
#orbit-app { position: fixed; right: 32px; bottom: 32px; z-index: 20; }
/* Issue #35：真实 composer dock 的祖先条件 —— transform + contain + overflow 的窄容器。
   确认层若不 portal 到 body，position:fixed 会以这个容器为包含块并被裁掉。 */
#dock-app { position: fixed; left: 16px; bottom: 16px; width: 340px; height: 96px; overflow: hidden; contain: layout paint; transform: translateZ(0); z-index: 20; visibility: hidden; }
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
  const orbit = window.__registrations['session-superagent-orbit'];
  if (!desk || typeof desk.Component !== 'function') throw new Error('slots.register 未捕获 session-superagent-desk Component');
  if (!orbit || typeof orbit.Component !== 'function') throw new Error('slots.register 未捕获 session-superagent-orbit Component');
  window.__verifyMeta = {
    reactVersion: React.version,
    primitiveExportCount: Object.keys(primitives).length,
    moduleNames: Object.keys(modules),
    primitivesIdentity: primitives === modules['@deepseek-ai/dsh-client-ui-primitives'],
    clientModuleId: window.__clientModuleId,
    desk: { ...desk.options, componentType: typeof desk.Component, arity: desk.Component.length },
    orbit: { ...orbit.options, componentType: typeof orbit.Component, arity: orbit.Component.length },
    fixture: { deskProps: { sessionId: ${JSON.stringify(SESSION_ID)} }, orbitProps: null, stateApi: '/session-superagent/state' },
    slotEvents: window.__slotEvents,
  };
  ReactDOM.createRoot(document.getElementById('app')).render(React.createElement(desk.Component, { sessionId: ${JSON.stringify(SESSION_ID)} }));
  // 真实 StatusOrbit() 没有 props； watcher fixture 由 /state API 加载，不能伪造一个 props 适配层。
  ReactDOM.createRoot(document.getElementById('orbit-app')).render(React.createElement(orbit.Component));
  // Issue #35：第二个真实 StatusOrbit 实例挂进带 transform/contain 的窄 dock。
  ReactDOM.createRoot(document.getElementById('dock-app')).render(React.createElement(orbit.Component));
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
<title>session-superagent desk/orbit/Modal 真实 Chromium 验收</title>
${styles.map((name) => `<link rel="stylesheet" href="/${name}">`).join('\n')}
<style>${Object.values(installed.themeStyles).join('\n')}</style>
<style>${HARNESS_CSS}</style>
<script>${CAPTURE_FACADE}</script>
</head><body data-ds-dark-theme="true"><div id="root"></div><div id="app"></div><div id="orbit-app"></div><div id="dock-app"></div>
<script type="module" src="/${entry}"></script>
<script type="module">${HARNESS_MODULE.replaceAll('</script', '<\\/script')}</script>
</body></html>`
}

function makeFixture(version) {
  const now = Date.now()
  const iso = (ms) => new Date(now - ms).toISOString()
  const sessionId = SESSION_ID
  return {
    state: {
      routeBase: '/session-superagent', serverVersion: version,
      runningVersion: version, installedVersion: version,
      sessionTitle: '完整面板 Chromium 验收',
      sessionGoal: { objective: '固定 goal：验证完整面板', phase: 'active', revision: 1 },
      defaults: { sessionMaxWakes: 12, maxWakesPerHour: 6, isolateKeepDays: 3, batchLimit: 5 },
      retryPolicy: { budgetAttempts: 6, slowCapMinutes: 120 },
      sessionUsage: { used: 2, cap: 12, capped: 0 },
      tokenScopes: { ok: true, scopes: ['repo', 'read:org'] },
      isolation: { roots: [], totalBytes: 0 },
      gh: { ok: true, version: 'gh version 2.101.0-fixture' },
      credentials: { token: 'configured', sshKeyPath: 'none', ghConfigDir: 'none', giteeToken: 'none' },
      triageSignals: [
        { key: 'reopened', label: '被重新打开', kind: 'fact', weight: 100, default: true, why: '固定事实信号' },
        { key: 'comments', label: '有人评论', kind: 'fact', weight: 10, default: true, why: '固定评论信号' },
        { key: 'unassigned', label: '无人认领', kind: 'judgment', weight: 3, default: false, why: '固定判断信号' },
      ],
      watchers: [
        {
          id: `acme/widgets#${sessionId}`, repo: 'acme/widgets', provider: 'github', sessionId,
          // 门禁面板专项：项目层路径由第一条 watcher 的 workdir 决定（client.js 的 gateRepo）。
          workdir: 'D:/fixture/work/apple',
          title: '活动 watcher fixture', intervalSec: 60, enabled: true, observe: false,
          isolated: false, activeHours: '', note: '处理固定 issue', ackLabel: '主理鱼:已处理',
          lastPoll: iso(15000), lastWake: iso(300000), lastError: null,
          filters: { labels: ['ai-fix'], ignoreLabels: [], onlyAssigned: false, assignee: null, allowAuthors: [] },
          priority: { reopened: true, comments: true, labels: true, unassigned: false, stale: false },
          history: [
            { at: iso(300000), numbers: [42], ok: true, reason: null },
            { at: iso(600000), numbers: [41], ok: false, reason: 'observe' },
          ],
          filteredLog: [{ number: 40, title: '固定过滤条目', reason: '机器人', at: iso(120000) }],
          filterCounts: { 机器人: 1 },
          events: [{ kind: 'wake', at: iso(300000), since: iso(600000), count: 1, text: '固定唤醒事件 #42' }],
          quality: { itemsWoken: 2, itemsAcked: 1, actionRate: 0.5 },
          repoAccess: { repo: 'acme/widgets', push: true, hasIssues: true },
          daily: { days: 2, total: 2 },
        },
        {
          id: 'acme/paused#session-paused-fixture', repo: 'acme/paused', provider: 'github', sessionId: 'session-paused-fixture',
          title: '暂停 watcher fixture', intervalSec: 120, enabled: false, observe: true,
          isolated: false, activeHours: '09:00-23:00', note: '', ackLabel: '主理鱼:已处理',
          lastPoll: iso(900000), lastWake: null, lastError: null,
          deferReason: 'active-hours', lastDeferred: '不在活跃时段（09:00-23:00）：只攒条目，不唤醒',
          filters: { labels: [], ignoreLabels: [], onlyAssigned: false, assignee: null, allowAuthors: [] },
          priority: { reopened: true, comments: true, labels: true, unassigned: false, stale: false },
          history: [], filteredLog: [], filterCounts: {}, events: [],
          repoAccess: { repo: 'acme/paused', push: true, hasIssues: true },
        },
      ],
    },
    update: { current: version, latest: version, hasUpdate: false, command: 'fixture-no-command' },
    trace: {
      traces: [{
        number: '42', repo: 'acme/widgets', verdict: '已唤醒（fixture）', seen: iso(500000), reported: iso(400000),
        filtered: [{ at: iso(450000), reason: '固定过滤事件' }], absorbed: [],
        wakes: [{ at: iso(300000), ok: true }],
      }],
    },
    diagnose: { text: `session-superagent ${version}\nrouteBase=/session-superagent\nfixture=true` },
  }
}

function json(response, status, body) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  response.end(JSON.stringify(body))
}

// ── 门禁面板 fixture：可控延迟/失败/每仓序号的 GET /gates 与 GET /gates/models ─────────
// 门禁面板（U1）与模型列表（U5）的行为是「异步响应只能由最新一次读取提交」：单测桩自己实现了
// effect 语义，这里用安装版 React 18 + 真实 client.js，让真实的 useEffect/useRef/并发渲染来跑。
const gateRace = {
  delays: [],
  failNext: false,
  seq: new Map(),
  requests: [],
}
// 模型列表也按仓库读、响应可能迟到；独立记 seq / 延迟 / 请求日志。
const modelRace = {
  delays: [],
  seq: new Map(),
  requests: [],
}
const modelTagOfRepo = (repo) => String(repo || '').split('/').filter(Boolean).pop() || 'none'
function modelPayloadFor(repo, seq) {
  const tag = modelTagOfRepo(repo)
  return {
    ok: true,
    models: [
      { id: 'group/model-' + tag + '-' + seq, label: tag + ' 模型 #' + seq },
      { id: 'group/shared-' + tag, label: tag + ' 共享模型' },
    ],
  }
}

function gatePayloadFor(repo, seq) {
  const rules = [
    {
      id: 'secret', label: '禁止凭证与密钥', description: '回复里不能出现 token、私钥。',
      severity: 'error', triggers: ['issue.reply', 'merge'], type: 'regex',
      pattern: 'ghp_[A-Za-z0-9]{20,}', message: '删掉凭证；需要引用时写 <redacted>。', enabled: true,
    },
    {
      id: 'abs-path', label: '禁止本机绝对路径', description: '不要贴 D: 盘这类本机路径。',
      severity: 'warn', triggers: ['issue.reply'], type: 'regex',
      pattern: '(?<![A-Za-z0-9])[A-Za-z]:[\\\\/]', message: '改成仓库相对路径。', enabled: true,
    },
  ]
  const prompt = '仓库 ' + repo + ' 的提示词 #' + seq
  return {
    ok: true,
    repo,
    sources: [{ name: 'default', path: 'packages/dsh-gate/gates/default.json' }],
    config: { version: 1, name: 'default', rules, semantic: { enabled: false, model: 'group/deepseek-v4.1-flash-1017', prompt } },
    scopes: {
      default: { path: 'packages/dsh-gate/gates/default.json', exists: true, config: { rules } },
      user: { path: 'D:/fixture/home/.dsh/state/session-superagent/gates.json', exists: false, config: null },
      project: { path: repo + '/.superagent/gates.json', exists: false, config: null },
      local: { path: repo + '/.superagent/gates.local.json', exists: false, config: null },
    },
  }
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
      // 门禁专项：按请求顺序消费延迟/失败，并给每个仓库一个单调序号（同仓两次读取能区分）。
      if (url.pathname === '/session-superagent/gates' && method === 'GET') {
        const repo = url.searchParams.get('repo') || ''
        const seq = (gateRace.seq.get(repo) || 0) + 1
        gateRace.seq.set(repo, seq)
        const delay = gateRace.delays.length > 0 ? Math.max(0, Number(gateRace.delays.shift()) || 0) : 0
        const fail = gateRace.failNext
        gateRace.failNext = false
        gateRace.requests.push({ method, path: url.pathname + url.search, repo, seq, delay, fail, receivedAt: Date.now() })
        if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay))
        if (fail) return json(response, 500, { ok: false, error: 'fixture 第一次读取失败' })
        return json(response, 200, gatePayloadFor(repo, seq))
      }
      if (url.pathname === '/session-superagent/gates/models' && method === 'GET') {
        const repo = url.searchParams.get('repo') || ''
        const seq = (modelRace.seq.get(repo) || 0) + 1
        modelRace.seq.set(repo, seq)
        const delay = modelRace.delays.length > 0 ? Math.max(0, Number(modelRace.delays.shift()) || 0) : 0
        modelRace.requests.push({ repo, seq, delay, receivedAt: Date.now() })
        if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay))
        return json(response, 200, modelPayloadFor(repo, seq))
      }
      if ((url.pathname === '/session-superagent/gates/preview' || url.pathname === '/session-superagent/gates/optimize') && method === 'POST') {
        gateRace.requests.push({ method, path: url.pathname, body: requestBody })
        return json(response, 200, url.pathname.endsWith('/preview')
          ? { ok: true, hits: [], semantic: { skipped: true } }
          : { ok: true, text: '优化后的提示词（fixture）' })
      }
      if (url.pathname === '/session-superagent/gates' && method === 'POST') {
        gateRace.requests.push({ method, path: url.pathname, body: requestBody })
        return json(response, 200, { ok: true, path: 'D:/fixture/work/damson/.superagent/gates.json', config: JSON.parse(requestBody || '{}') })
      }
      if (url.pathname === '/__fixture/workdir' && method === 'POST') {
        const next = JSON.parse(requestBody || '{}')
        fixture.state.watchers[0].workdir = String(next.repo || '')
        return json(response, 200, { ok: true, workdir: fixture.state.watchers[0].workdir })
      }
      if (url.pathname === '/__fixture/gate-delays' && method === 'POST') {
        const next = JSON.parse(requestBody || '{}')
        gateRace.delays = Array.isArray(next.delays) ? next.delays.map(Number) : []
        gateRace.failNext = next.failNext === true
        return json(response, 200, { ok: true, delays: gateRace.delays, failNext: gateRace.failNext })
      }
      if (url.pathname === '/__fixture/model-delays' && method === 'POST') {
        const next = JSON.parse(requestBody || '{}')
        modelRace.delays = Array.isArray(next.delays) ? next.delays.map(Number) : []
        return json(response, 200, { ok: true, delays: modelRace.delays })
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

const installed = loadInstalledAssets()
const repoPackage = JSON.parse(readFileSync(`${REPO}/package.json`, 'utf8'))
const clientSource = readFileSync(`${REPO}/client.js`, 'utf8')
const fixture = makeFixture(repoPackage.version)
const clientSha256 = sha256(clientSource)
const scriptSha256 = sha256(readFileSync(`${REPO}/scripts/verify-panel-chromium.mjs`))
const task = await taskSpace(SPACE_NAME)
const { server, origin } = await startServer(installed, clientSource, fixture)
const page = task.page('p1')
let completed = false
let chromium = 'unknown'
try {
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
  await page.waitForFunction(() => {
    const trigger = document.querySelector('#orbit-app .sa-orbit-trigger')
    const dockTrigger = document.querySelector('#dock-app .sa-orbit-trigger')
    return trigger && !trigger.classList.contains('is-loading') && trigger.getAttribute('aria-label')?.includes('共 2 条')
      && dockTrigger && !dockTrigger.classList.contains('is-loading')
      && dockTrigger.getAttribute('aria-label')?.includes('共 2 条')
  }, undefined, { timeout: 15000 })
  const browser = await page.evaluate(async () => ({
    userAgent: navigator.userAgent,
    highEntropy: navigator.userAgentData ? await navigator.userAgentData.getHighEntropyValues(['fullVersionList']) : null,
  }))
  chromium = browser.highEntropy?.fullVersionList?.find((item) => item.brand === 'Chromium')?.version
    || browser.userAgent.match(/Chrome\/([^ ]+)/)?.[1] || 'unknown'
  check('真实 Chromium 页面已加载', /^156\./.test(chromium), { chromium, url: await page.url() })
  const meta = await page.evaluate(() => window.__verifyMeta)
  check('真实 client.js 使用安装版 React/primitives', meta.reactVersion === '18.3.1'
    && meta.primitivesIdentity && meta.primitiveExportCount > 0, meta)
  check('slots.register 捕获 session-superagent-desk', meta.desk.name === 'conversation.view'
    && meta.desk.id === 'session-superagent-desk' && meta.desk.order === 30
    && meta.desk.label === '主理鱼' && meta.desk.componentType === 'function', meta.desk)
  check('slots.register 捕获并真实挂载 session-superagent-orbit', meta.orbit.name === 'conversation.composer.dock'
    && meta.orbit.id === 'session-superagent-orbit' && meta.orbit.order === -10
    && meta.orbit.componentType === 'function' && meta.orbit.arity === 0
    && meta.fixture.deskProps.sessionId === SESSION_ID && meta.fixture.stateApi === '/session-superagent/state',
  { orbit: meta.orbit, fixture: meta.fixture })
  const overview = await page.evaluate(() => ({
    title: document.querySelector('.dt-page h1')?.textContent,
    tabs: [...document.querySelectorAll('[role=tab]')].map((node) => ({ text: node.textContent, selected: node.getAttribute('aria-selected') })),
    watchers: document.querySelectorAll('.dt-list > li.dt-ticket').length,
    stats: document.querySelectorAll('.dt-stats .dt-stat').length,
    text: document.querySelector('.dt-page')?.innerText,
  }))
  check('overview 总览真实挂载且有完整 DOM', overview.title === '主理鱼'
    && JSON.stringify(overview.tabs.map((item) => item.text)) === JSON.stringify(['总览', '判定', '触发', '设置'])
    && overview.tabs[0]?.selected === 'true' && overview.watchers === 2 && overview.stats >= 4,
  { title: overview.title, tabs: overview.tabs, watchers: overview.watchers, stats: overview.stats })
  const shot = async (name) => {
    const persist = name.startsWith('orbit') || name.startsWith('trigger-')
    const path = `${SCREENSHOTS}/deep-ui-${name}.png`
    if (!CAPTURE_SCREENSHOTS) {
      const reason = 'Ego/CDP 截图通道已证实在 API 内部终止进程；本轮跳过，DOM/焦点验收继续'
      console.log(`SKIP 截图 ${name} ${JSON.stringify(reason)}`)
      observe(`${name} 截图跳过（通道不可用）`, { path, reason })
      return
    }
    try {
      if (persist) {
        // 本任务只允许 deep-ui-*.png；既有 desk/panel-chromium PNG 不覆盖。
        await page.screenshot({ path, fullPage: true })
        artifacts.push(path)
        observe(`${name} 已截图`, { path: `docs/assets/deep-ui-${name}.png` })
      } else {
        // 保留既有八张 desk 基线；已知 raw CDP 截图可能长阻塞，因此明确 SKIP，不拖住 DOM/焦点验收。
        const detail = { name, persisted: false, reason: '保留 desk 基线；新增候选仅 deep-ui-orbit* / deep-ui-trigger-*' }
        console.log(`SKIP 截图 ${name} ${JSON.stringify(detail.reason)}`)
        observe(`${name} 截图跳过（保留 desk 基线，功能检查继续）`, detail)
      }
    } catch (error) {
      // Ego/CDP 截图通道偶发超时，不应把真实 DOM/交互验收误判为产品失败。
      const detail = String((error && error.message) || error)
      console.log(`SKIP 截图 ${name} ${JSON.stringify(detail)}`)
      observe(`${name} 截图通道跳过（功能检查继续）`, { path, error: detail })
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
  await shot('overview')

  // 第二阶段：搜索框是真实受控 input，筛选严格收敛到一个仓库，再清空恢复。
  await page.fill("input[aria-label='搜索']", 'acme/widgets')
  await page.waitForFunction(() => document.querySelectorAll('.dt-list > li.dt-ticket').length === 1, undefined, { timeout: 5000 })
  const searched = await page.evaluate(() => ({
    value: document.querySelector("input[aria-label='搜索']")?.value,
    repos: [...document.querySelectorAll('.dt-list .dt-open')].map((node) => node.textContent),
    summary: document.querySelector('.dt-row-meta')?.textContent,
  }))
  check('overview 搜索 input 可编辑且严格筛选/显示汇总', searched.value === 'acme/widgets'
    && JSON.stringify(searched.repos) === JSON.stringify(['acme/widgets']), searched)
  await page.fill("input[aria-label='搜索']", '')
  await page.waitForFunction(() => document.querySelectorAll('.dt-list > li.dt-ticket').length === 2, undefined, { timeout: 5000 })

  // 行内编辑：只修改本地 React 草稿并放弃，绝不提交 /watch。
  await page.click('.dt-list .dt-open >> nth=0')
  await page.waitForSelector("form[data-mode='edit']", { state: 'visible', timeout: 5000 })
  const editEntry = await page.evaluate(() => ({
    expanded: document.querySelector('.dt-list .dt-open')?.getAttribute('aria-expanded'),
    forms: document.querySelectorAll("form[data-mode='edit']").length,
    activeIsOpener: document.activeElement === document.querySelector('.dt-list .dt-open'),
    activeConnected: document.activeElement?.isConnected === true,
  }))
  check('overview 仓库按钮进入行内编辑且焦点不丢', editEntry.expanded === 'true'
    && editEntry.forms === 1 && editEntry.activeIsOpener && editEntry.activeConnected, editEntry)
  await page.fill("form[data-mode='edit'] input[type='number'] >> nth=0", '90')
  const edited = await page.evaluate(() => ({
    value: document.querySelector("form[data-mode='edit'] input[type='number']")?.value,
    savebar: document.querySelector("form[data-mode='edit'] .dt-savebar")?.textContent,
  }))
  check('overview 行内编辑 input 可编辑且出现未保存 SaveBar', edited.value === '90' && edited.savebar?.includes('未保存'), edited)
  await page.click("form[data-mode='edit'] .dt-savebar button >> nth=0")
  await page.waitForFunction(() => document.querySelector("form[data-mode='edit'] input[type='number']")?.value === '60', undefined, { timeout: 5000 })
  check('overview 行内编辑放弃后恢复原值且未提交', await page.evaluate(() => (
    document.querySelector("form[data-mode='edit'] input[type='number']")?.value === '60'
    && !document.querySelector("form[data-mode='edit'] .dt-savebar")
  )))
  await page.click('.dt-list .dt-open >> nth=0')

  // 判定记录 + fake trace：搜索编号后真实点击追溯按钮。
  await openTab('判定')
  await page.fill("input[aria-label='搜索']", '42')
  await page.click("text='追溯 #42'")
  await page.waitForFunction(() => [...document.querySelectorAll('.dt-event-text')].some((node) => node.textContent === '唤醒成功'), undefined, { timeout: 5000 })
  const judge = await page.evaluate(() => ({
    selected: document.querySelector('[role=tab][aria-selected=true]')?.textContent,
    sections: [...document.querySelectorAll('.dt-section-name')].map((node) => node.textContent.trim()),
    decisionRepos: [...document.querySelectorAll('.dt-list .dt-event-actor')].map((node) => node.textContent),
    decisionNumbers: [...document.querySelectorAll('.dt-list .dt-event-nums')].map((node) => node.textContent),
    traceEvents: [...document.querySelectorAll('.dt-event-text')].map((node) => node.textContent),
  }))
  check('judge/records 判定记录与运行时事件均有真实 DOM', judge.selected === '判定'
    && judge.sections.includes('判定日志（最近 5 次唤醒）')
    && judge.sections.includes('运行时事件（最近 20 条）')
    && JSON.stringify(judge.decisionRepos) === JSON.stringify(['acme/widgets', 'acme/widgets'])
    && JSON.stringify(judge.decisionNumbers) === JSON.stringify(['#42', '#41'])
    && judge.traceEvents.includes('acme/widgets · 固定唤醒事件 #42'), judge)
  check('judge fake /trace 点击后呈现 seen/filter/reported/wake 全事件', JSON.stringify(judge.traceEvents.slice(0, 4))
    === JSON.stringify(['首次看到', '被过滤：固定过滤事件', '上次上报', '唤醒成功']), judge.traceEvents)
  await shot('judge')
  await page.fill("input[aria-label='搜索']", '')

  // 触发页：必填字段与目标字段可编辑，但不点击添加。
  await openTab('触发')
  await page.waitForSelector('#watcher-new-repo', { state: 'visible', timeout: 5000 })
  const triggerStructure = await page.evaluate(() => ({
    selected: document.querySelector('[role=tab][aria-selected=true]')?.textContent,
    mode: document.getElementById('watcher-new')?.getAttribute('data-mode'),
    repoRequired: document.getElementById('watcher-new-repo')?.required,
    intervalType: document.getElementById('watcher-new-intervalSec')?.type,
  }))
  check('trigger 新增表单结构完整', triggerStructure.selected === '触发'
    && triggerStructure.mode === 'create' && triggerStructure.repoRequired === true
    && triggerStructure.intervalType === 'number', triggerStructure)
  await page.fill('#watcher-new-repo', 'fixture/editable')
  await page.fill('#watcher-new-goal', 'Chromium 可编辑 fixture，不提交')
  const triggerEdited = await page.evaluate(() => ({
    repo: document.getElementById('watcher-new-repo')?.value,
    goal: document.getElementById('watcher-new-goal')?.value,
    savebar: document.querySelector('#watcher-new .dt-savebar')?.textContent,
  }))
  check('trigger 搜索外的新增/编辑表单 input 可编辑', triggerEdited.repo === 'fixture/editable'
    && triggerEdited.goal === 'Chromium 可编辑 fixture，不提交'
    && triggerEdited.savebar?.includes('未保存'), triggerEdited)
  const switchBefore = await page.evaluate(() => ({
    count: document.querySelectorAll('#watcher-new [role=switch]').length,
    checked: document.querySelector('#watcher-new [role=switch]')?.getAttribute('aria-checked'),
  }))
  await page.click('#watcher-new [role=switch] >> nth=0')
  const switchAfter = await page.evaluate(() => ({
    checked: document.querySelector('#watcher-new [role=switch]')?.getAttribute('aria-checked'),
    dirty: document.querySelector('#watcher-new .dt-savebar')?.textContent.includes('未保存'),
  }))
  check('trigger 官方 Switch 可切换且只改本地草稿', switchBefore.count === 3
    && switchAfter.checked !== switchBefore.checked && switchAfter.dirty === true,
  { before: switchBefore, after: switchAfter })
  await shot('trigger')

  // WatcherForm 高级区：真实 Enter/Space 开合、五面优先级 Switch、Tab 顺序与本地草稿恢复。
  const advancedTrigger = '#watcher-new .dt-disclosure-row'
  const advancedBody = '#watcher-new .dt-disclosure-body'
  const priorityIds = ['priorityReopened', 'priorityComments', 'priorityLabels', 'priorityUnassigned', 'priorityStale']
  const priorityLabels = ['重开优先', '评论优先', '标签优先', '未认领优先', '积压优先']
  const priorityDefaults = [true, true, true, false, false]
  const prioritySelector = (id) => `#watcher-new-${id}[role=switch], #watcher-new-${id} [role=switch]`
  const readPriority = () => page.evaluate((ids) => ids.map((id) => {
    const wrapper = document.getElementById(`watcher-new-${id}`)
    const control = wrapper?.getAttribute('role') === 'switch' ? wrapper : wrapper?.querySelector('[role=switch]')
    return {
      id,
      role: control?.getAttribute('role') || null,
      checked: control?.getAttribute('aria-checked') || null,
      label: control?.getAttribute('aria-label') || null,
      tabIndex: control?.tabIndex,
      disabled: Boolean(control?.disabled),
      connected: control?.isConnected === true,
    }
  }), priorityIds)
  const advancedCollapsed = await page.evaluate(() => ({
    expanded: document.querySelector('#watcher-new .dt-disclosure-row')?.getAttribute('aria-expanded'),
    controls: document.querySelector('#watcher-new .dt-disclosure-row')?.getAttribute('aria-controls'),
    bodyMounted: Boolean(document.querySelector('#watcher-new .dt-disclosure-body')),
    advancedSwitches: document.querySelectorAll('#watcher-new .dt-disclosure-body [role=switch]').length,
  }))
  check('trigger 高级区默认收起且高级控件未挂载', advancedCollapsed.expanded === 'false'
    && !advancedCollapsed.bodyMounted && advancedCollapsed.advancedSwitches === 0, advancedCollapsed)

  await page.focus(advancedTrigger)
  await page.keyboard.press('Enter')
  await page.waitForFunction(() => {
    const trigger = document.querySelector('#watcher-new .dt-disclosure-row')
    return trigger?.getAttribute('aria-expanded') === 'true'
      && document.querySelectorAll('#watcher-new .dt-disclosure-body [role=switch]').length === 5
  }, undefined, { timeout: 5000 })
  const advancedOpened = await page.evaluate(() => {
    const trigger = document.querySelector('#watcher-new .dt-disclosure-row')
    const body = document.querySelector('#watcher-new .dt-disclosure-body')
    const controls = trigger?.getAttribute('aria-controls')
    return {
      expanded: trigger?.getAttribute('aria-expanded'),
      controls,
      bodyId: body?.id || null,
      controlsTargetsBody: Boolean(controls && body && document.getElementById(controls) === body),
      bodyVisible: Boolean(body && getComputedStyle(body).display !== 'none' && getComputedStyle(body).visibility === 'visible'),
      switches: body?.querySelectorAll('[role=switch]').length,
      activeIsTrigger: document.activeElement === trigger,
      activeConnected: document.activeElement?.isConnected === true,
    }
  })
  check('trigger 高级区 Enter 真实展开且焦点不丢', advancedOpened.expanded === 'true'
    && advancedOpened.bodyVisible && advancedOpened.switches === 5
    && advancedOpened.activeIsTrigger && advancedOpened.activeConnected, advancedOpened)
  check('trigger 高级区 aria-expanded/controls 与 body id 关联完整', advancedOpened.expanded === 'true'
    && Boolean(advancedOpened.controls) && Boolean(advancedOpened.bodyId)
    && advancedOpened.controls === advancedOpened.bodyId && advancedOpened.controlsTargetsBody, advancedOpened)

  const priorityInitial = await readPriority()
  check('trigger 五面优先级 Switch role/aria-checked/默认值完整', priorityInitial.every((row, index) => (
    row.id === priorityIds[index] && row.role === 'switch' && row.label === priorityLabels[index]
    && row.checked === String(priorityDefaults[index]) && row.tabIndex === 0 && !row.disabled && row.connected
  )), priorityInitial)

  // 选中高级区优先级说明这个真实 InfoTip；hover/focus、portal、Escape 与真实 wheel/scroll 均在完整面板验收。
  const priorityTipText = '全部关掉时按 GitHub 的「最近更新」顺序处理'
  const priorityTip = '#watcher-new button.dt-info[aria-label="全部关掉时按 GitHub 的「最近更新」顺序处理"]'
  const tooltipState = () => page.evaluate(({ selector, text }) => {
    const trigger = document.querySelector(selector)
    const describedBy = trigger?.getAttribute('aria-describedby') || null
    const described = describedBy ? document.getElementById(describedBy) : null
    const candidates = [...document.querySelectorAll('[role="tooltip"], [data-pinned]')]
    const bubble = described || candidates.find((node) => node.textContent?.trim() === text) || null
    const style = bubble ? getComputedStyle(bubble) : null
    const visible = Boolean(bubble && style.display !== 'none' && style.visibility === 'visible')
    return {
      selector,
      describedBy,
      triggerExpanded: trigger?.getAttribute('aria-expanded') || null,
      visible,
      bubbleId: bubble?.id || null,
      bubbleRole: bubble?.getAttribute('role') || null,
      bubbleText: bubble?.textContent?.trim() || null,
      bubbleParent: bubble?.parentElement?.tagName || null,
      bubblePinned: bubble?.getAttribute('data-pinned'),
      activeIsTrigger: document.activeElement === trigger,
      activeConnected: document.activeElement?.isConnected === true,
    }
  }, { selector: priorityTip, text: priorityTipText })
  const waitTooltip = async (open) => {
    try {
      await page.waitForFunction(({ selector, text, expected }) => {
        const trigger = document.querySelector(selector)
        const id = trigger?.getAttribute('aria-describedby')
        const described = id ? document.getElementById(id) : null
        const candidates = [...document.querySelectorAll('[role="tooltip"], [data-pinned]')]
        const bubble = described || candidates.find((node) => node.textContent?.trim() === text)
        const style = bubble ? getComputedStyle(bubble) : null
        const visible = Boolean(bubble && style.display !== 'none' && style.visibility === 'visible')
        return expected ? visible : !visible
      }, { selector: priorityTip, text: priorityTipText, expected: open }, { timeout: 5000 })
      return true
    } catch {
      return false
    }
  }
  const tipTarget = await page.evaluate((selector) => {
    const node = document.querySelector(selector)
    const rect = node?.getBoundingClientRect()
    return {
      selector,
      present: Boolean(node),
      visible: Boolean(node && rect && rect.width > 0 && rect.height > 0
        && getComputedStyle(node).display !== 'none' && getComputedStyle(node).visibility === 'visible'),
      ariaLabel: node?.getAttribute('aria-label') || null,
    }
  }, priorityTip)
  observe('InfoTip 真实验收目标', { tab: '触发 / 高级设置 / 优先级', ...tipTarget })
  if (!tipTarget.visible) {
    const reason = '选择器未命中可见 InfoTip；不伪造 hover/focus 结果'
    observe('触发页高级区 InfoTip 未验原因', { selector: priorityTip, reason })
    check('trigger 高级区 InfoTip 可见性前置检查', false, { selector: priorityTip, reason, target: tipTarget })
  } else {
    await page.evaluate((selector) => document.querySelector(selector)?.scrollIntoView({ block: 'center', inline: 'center' }), priorityTip)
    await page.mouse.move(1320, 80, { label: '移开 Tooltip 指针' })
    await page.hover(priorityTip, { label: '悬停优先级说明 Tooltip' })
    const hoverSettled = await waitTooltip(true)
    const hoverTip = await tooltipState()
    check('InfoTip hover 真实打开且 portal 到 BODY', hoverSettled && hoverTip.visible
      && hoverTip.bubbleRole === 'tooltip' && hoverTip.bubbleText === priorityTipText
      && hoverTip.bubbleParent === 'BODY' && hoverTip.triggerExpanded === 'true'
      && Boolean(hoverTip.describedBy) && hoverTip.describedBy === hoverTip.bubbleId, hoverTip)

    // click 只负责把已经 hover 打开的官方 Tooltip pin 住；Escape 前必须仍可见，避免把移出关闭误记成 Escape。
    await page.click(priorityTip, { label: '固定优先级说明 Tooltip' })
    const pinnedSettled = await waitTooltip(true)
    await page.mouse.move(1320, 80, { label: '移出已固定 Tooltip' })
    await page.waitForTimeout(150)
    const beforeEscape = await tooltipState()
    await shot('trigger-tooltip')
    await page.keyboard.press('Escape')
    const escapeSettled = await waitTooltip(false)
    const afterEscape = await tooltipState()
    check('InfoTip hover 打开后 Escape 真实关闭并保留焦点', pinnedSettled && beforeEscape.visible
      && beforeEscape.bubblePinned === 'true' && beforeEscape.triggerExpanded === 'true'
      && escapeSettled && !afterEscape.visible && afterEscape.triggerExpanded === 'false'
      && afterEscape.activeIsTrigger && afterEscape.activeConnected, { beforeEscape, afterEscape })

    await page.focus(advancedTrigger)
    await page.focus(priorityTip)
    const focusSettled = await waitTooltip(true)
    const focusTip = await tooltipState()
    check('InfoTip focus 真实打开且 trigger 不丢焦', focusSettled && focusTip.visible
      && focusTip.bubbleRole === 'tooltip' && focusTip.bubbleText === priorityTipText
      && focusTip.bubbleParent === 'BODY' && focusTip.triggerExpanded === 'true'
      && Boolean(focusTip.describedBy) && focusTip.describedBy === focusTip.bubbleId
      && focusTip.activeIsTrigger && focusTip.activeConnected, focusTip)

    // 与官方 Tooltip 验收一致：focus 已证明打开后，click pin 固定；scroll 前必须仍可见。
    await page.click(priorityTip, { label: '固定 focus 打开的 Tooltip' })
    const scrollPinSettled = await waitTooltip(true)
    const scrollPlan = await page.evaluate(() => {
      const scroller = document.querySelector('.dt-page')
      const scrollTop = scroller?.scrollTop || 0
      const max = scroller ? scroller.scrollHeight - scroller.clientHeight : 0
      const downRoom = Math.max(0, max - scrollTop)
      const delta = downRoom > 0 ? Math.min(240, downRoom) : scrollTop > 0 ? -Math.min(240, scrollTop) : 0
      return {
        selector: '.dt-page', scrollTop, max, delta,
        x: Math.round(innerWidth / 2), y: Math.round(innerHeight * 0.65),
      }
    })
    let scrollSettled = false
    let beforeScroll = await tooltipState()
    if (scrollPlan.delta !== 0) {
      await page.mouse.move(scrollPlan.x, scrollPlan.y, { label: '移到完整面板滚动区' })
      await page.waitForTimeout(150)
      beforeScroll = await tooltipState()
      await page.mouse.wheel(0, scrollPlan.delta, { label: '真实滚动关闭 Tooltip' })
      scrollSettled = await waitTooltip(false)
      await page.waitForTimeout(250)
    }
    const afterScroll = await tooltipState()
    const scrollTopAfter = await page.evaluate(() => document.querySelector('.dt-page')?.scrollTop || 0)
    check('InfoTip 真实 wheel/scroll 关闭且回焦新 trigger', scrollPinSettled && beforeScroll.visible
      && beforeScroll.bubblePinned === 'true' && scrollPlan.delta !== 0
      && scrollTopAfter !== scrollPlan.scrollTop && scrollSettled && !afterScroll.visible
      && afterScroll.triggerExpanded === 'false' && afterScroll.activeIsTrigger && afterScroll.activeConnected,
    { scrollPlan, beforeScroll, scrollTopAfter, afterScroll })
    if (afterScroll.visible) {
      await page.keyboard.press('Escape')
      await waitTooltip(false)
    }

  }

  // 从优先级 InfoTip 连续 Tab，必须依次进入五面 Switch，中间不插入隐藏控件或丢到 body。
  await page.focus(priorityTip)
  const priorityTabOrder = []
  for (let index = 0; index < priorityIds.length; index += 1) {
    await page.keyboard.press('Tab')
    priorityTabOrder.push(await page.evaluate(() => {
      const active = document.activeElement
      return {
        id: active?.closest('[id]')?.id || null,
        role: active?.getAttribute('role') || null,
        label: active?.getAttribute('aria-label') || null,
        connected: active?.isConnected === true,
      }
    }))
  }
  check('trigger 高级区 Tab 顺序覆盖五面 Switch 且不丢焦', priorityTabOrder.every((row, index) => (
    row.id === `watcher-new-${priorityIds[index]}` && row.role === 'switch'
    && row.label === priorityLabels[index] && row.connected
  )), priorityTabOrder)
  // Tab 后的延迟 scroll/focus 恢复可能让 Tooltip 再出现；先真实 Escape 复位，避免遮挡后续鼠标断言。
  await page.waitForTimeout(150)
  await page.keyboard.press('Escape')
  await waitTooltip(false)
  await page.mouse.move(1320, 80, { label: 'Switch 操作前移开指针' })

  // 每一面都真实改变一次：第 1/4 面用鼠标，其余用 Space；逐步核对 checked、焦点与 SaveBar。
  const prioritySteps = []
  for (let index = 0; index < priorityIds.length; index += 1) {
    const id = priorityIds[index]
    const method = index === 0 || index === 3 ? 'click' : 'Space'
    await page.evaluate((wanted) => document.getElementById(`watcher-new-${wanted}`)?.scrollIntoView({ block: 'center', inline: 'center' }), id)
    if (method === 'click') await page.click(prioritySelector(id))
    else {
      await page.focus(prioritySelector(id))
      await page.keyboard.press('Space')
    }
    const expected = priorityDefaults.map((value, position) => position <= index ? !value : value)
    let settled = false
    try {
      await page.waitForFunction(({ ids, wanted }) => ids.every((key, position) => (
        document.querySelector(`#watcher-new-${key}[role=switch], #watcher-new-${key} [role=switch]`)?.getAttribute('aria-checked') === String(wanted[position])
      )), { ids: priorityIds, wanted: expected }, { timeout: 3000 })
      settled = true
    } catch {}
    const step = await page.evaluate(({ ids, action }) => ({
      method: action,
      checked: ids.map((key) => document.querySelector(`#watcher-new-${key}[role=switch], #watcher-new-${key} [role=switch]`)?.getAttribute('aria-checked') || null),
      activeId: document.activeElement?.closest('[id]')?.id || null,
      activeConnected: document.activeElement?.isConnected === true,
      savebar: document.querySelector('#watcher-new .dt-savebar')?.textContent || null,
    }), { ids: priorityIds, action: method })
    prioritySteps.push({ ...step, settled })
  }
  const expectedAfterAll = priorityDefaults.map((value) => !value)
  check('trigger 五面 Switch checked/onChange/草稿与鼠标键盘真实生效', prioritySteps.every((step, index) => {
    const expected = priorityDefaults.map((value, position) => position <= index ? !value : value)
    return step.settled && JSON.stringify(step.checked) === JSON.stringify(expected.map(String))
      && step.activeId === `watcher-new-${priorityIds[index]}` && step.activeConnected
      && step.savebar?.includes('未保存')
  }) && JSON.stringify(prioritySteps.at(-1)?.checked) === JSON.stringify(expectedAfterAll.map(String)), prioritySteps)
  await shot('trigger-advanced')

  // 放弃只恢复 fixture 内的新建草稿，不提交；再 Space 收起高级区，恢复进入本项前的现场。
  await page.click('#watcher-new .dt-savebar button:text-is("放弃")')
  await page.waitForFunction(() => !document.querySelector('#watcher-new .dt-savebar'), undefined, { timeout: 5000 })
  const priorityRestored = await readPriority()
  const restoredDraft = await page.evaluate(() => ({
    repo: document.getElementById('watcher-new-repo')?.value,
    goal: document.getElementById('watcher-new-goal')?.value,
    onlyAssigned: document.querySelector('#watcher-new-onlyAssigned[role=switch], #watcher-new-onlyAssigned [role=switch]')?.getAttribute('aria-checked'),
    savebarMounted: Boolean(document.querySelector('#watcher-new .dt-savebar')),
  }))
  check('trigger 放弃恢复五面 Switch 与整个新建草稿', priorityRestored.every((row, index) => (
    row.checked === String(priorityDefaults[index])
  )) && restoredDraft.repo === '' && restoredDraft.goal === ''
    && restoredDraft.onlyAssigned === 'false' && !restoredDraft.savebarMounted,
  { priorityRestored, restoredDraft })
  await page.focus(advancedTrigger)
  await page.keyboard.press('Space')
  await page.waitForFunction(() => (
    document.querySelector('#watcher-new .dt-disclosure-row')?.getAttribute('aria-expanded') === 'false'
    && !document.querySelector('#watcher-new .dt-disclosure-body')
  ), undefined, { timeout: 5000 })
  const advancedClosed = await page.evaluate(() => ({
    expanded: document.querySelector('#watcher-new .dt-disclosure-row')?.getAttribute('aria-expanded'),
    bodyMounted: Boolean(document.querySelector('#watcher-new .dt-disclosure-body')),
    activeIsTrigger: document.activeElement === document.querySelector('#watcher-new .dt-disclosure-row'),
    activeConnected: document.activeElement?.isConnected === true,
  }))
  check('trigger 高级区 Space 真实收起且焦点不丢', advancedClosed.expanded === 'false'
    && !advancedClosed.bodyMounted && advancedClosed.activeIsTrigger && advancedClosed.activeConnected, advancedClosed)

  // 设置总壳与五个分区全部真实点击。
  await openTab('设置')
  const settingsEntry = await page.evaluate(() => ({
    selected: document.querySelector('[role=tab][aria-selected=true]')?.textContent,
    activeIsSelected: document.activeElement === document.querySelector('[role=tab][aria-selected=true]'),
    activeConnected: document.activeElement?.isConnected === true,
  }))
  check('desk 设置按钮进入设置且焦点不丢', settingsEntry.selected === '设置'
    && settingsEntry.activeIsSelected && settingsEntry.activeConnected, settingsEntry)
  const settingsNav = await page.evaluate(() => [...document.querySelectorAll('.dt-settings-link')].map((node) => node.textContent))
  check('settings 左 nav 恰好五个既定分区', JSON.stringify(settingsNav)
    === JSON.stringify(['来源', '凭证', '门禁', '版本与更新', '分诊信号', '会话 goal']), settingsNav)

  const source = await page.evaluate(() => ({
    current: document.querySelector('.dt-settings-link[aria-current=page]')?.textContent,
    title: document.querySelector('.dt-settings-body .dt-section-name')?.textContent,
    keys: [...document.querySelectorAll('.dt-settings-body dt')].map((node) => node.textContent),
    values: [...document.querySelectorAll('.dt-settings-body dd')].map((node) => node.textContent),
  }))
  check('settings/source 来源事实表完整', source.current === '来源' && source.title === '来源'
    && JSON.stringify(source.keys) === JSON.stringify(['仓库', 'gh CLI', 'GitHub 凭证', '权限范围', '隔离占用'])
    && source.values[0]?.includes('acme/widgets') && source.values[1]?.includes('gh version 2.101.0-fixture'), source)
  await shot('settings-source')

  await openSettings('凭证')
  const creds = await page.evaluate(() => ({
    current: document.querySelector('.dt-settings-link[aria-current=page]')?.textContent,
    title: document.querySelector('.dt-settings-body .dt-section-name')?.textContent,
    passwords: document.querySelectorAll(".dt-settings-body input[type='password']").length,
    saveButtons: [...document.querySelectorAll('.dt-settings-body button')].filter((node) => node.textContent === '保存凭证').length,
  }))
  check('settings/creds 凭证分区有两个 secret input 与保存入口', creds.current === '凭证'
    && creds.title === '凭证' && creds.passwords === 2 && creds.saveButtons === 1, creds)
  await page.fill(".dt-settings-body input[type='password'] >> nth=0", 'fixture-token-not-a-secret')
  await page.fill(".dt-settings-body input[type='password'] >> nth=1", 'fixture-gitee-not-a-secret')
  await page.fill(".dt-settings-body input:not([type])", 'D:/fixture/gh-config')
  const credsEdited = await page.evaluate(() => ({
    secrets: [...document.querySelectorAll(".dt-settings-body input[type='password']")].map((node) => node.value),
    ghDir: document.querySelector(".dt-settings-body input:not([type])")?.value,
  }))
  check('settings/creds 三个凭证 input 可编辑但未保存', JSON.stringify(credsEdited.secrets)
    === JSON.stringify(['fixture-token-not-a-secret', 'fixture-gitee-not-a-secret'])
    && credsEdited.ghDir === 'D:/fixture/gh-config', { ...credsEdited, secrets: ['fixture-only', 'fixture-only'] })
  await shot('settings-creds')

  await openSettings('版本与更新')
  const update = await page.evaluate(() => ({
    current: document.querySelector('.dt-settings-link[aria-current=page]')?.textContent,
    title: document.querySelector('.dt-settings-body .dt-section-name')?.textContent,
    keys: [...document.querySelectorAll('.dt-settings-body dt')].map((node) => node.textContent),
    values: [...document.querySelectorAll('.dt-settings-body dd')].map((node) => node.textContent),
    installButtons: [...document.querySelectorAll('.dt-settings-body button')].filter((node) => node.textContent === '安装更新').length,
    diagnoseButtons: [...document.querySelectorAll('.dt-settings-body button')].filter((node) => node.textContent === '复制诊断信息').length,
  }))
  check('settings/update 固定更新响应显示已是最新', update.current === '版本与更新'
    && update.title === '版本与更新'
    && JSON.stringify(update.keys) === JSON.stringify(['当前版本', 'npm 最新', '状态'])
    && update.values[0] === repoPackage.version && update.values[1] === repoPackage.version
    && update.values[2] === '已是最新' && update.installButtons === 0 && update.diagnoseButtons === 1, update)
  await shot('settings-update')

  await openSettings('分诊信号')
  const diagnose = await page.evaluate(() => ({
    current: document.querySelector('.dt-settings-link[aria-current=page]')?.textContent,
    title: document.querySelector('.dt-settings-body .dt-section-name')?.textContent,
    signals: [...document.querySelectorAll('.dt-settings-body .dt-signal-lead .dt-row-name')].map((node) => node.textContent),
    weights: [...document.querySelectorAll('.dt-settings-body .dt-signal-meta')].map((node) => node.textContent),
  }))
  check('settings/diagnose 分诊信号三分区内容完整', diagnose.current === '分诊信号'
    && diagnose.title === '分诊信号与取舍'
    && JSON.stringify(diagnose.signals) === JSON.stringify(['被重新打开', '有人评论', '无人认领'])
    && JSON.stringify(diagnose.weights) === JSON.stringify(['+100 分', '+10 分', '+3 分']), diagnose)
  await shot('settings-diagnose')

  await openSettings('会话 goal')
  const goal = await page.evaluate(() => ({
    current: document.querySelector('.dt-settings-link[aria-current=page]')?.textContent,
    title: document.querySelector('.dt-settings-body .dt-section-name')?.textContent,
    value: document.querySelector('.dt-settings-body textarea')?.value,
    saveDisabled: [...document.querySelectorAll('.dt-settings-body button')].find((node) => node.textContent === '保存 goal')?.disabled,
  }))
  check('settings/goal 固定 goal 回读且保存按钮可用', goal.current === '会话 goal'
    && goal.title === '会话 goal' && goal.value === '固定 goal：验证完整面板' && goal.saveDisabled === false, goal)
  await page.fill('.dt-settings-body textarea', '固定 goal：Chromium 已编辑但未提交')
  check('settings/goal textarea 可编辑但未保存', await page.evaluate(() => (
    document.querySelector('.dt-settings-body textarea')?.value === '固定 goal：Chromium 已编辑但未提交'
  )))
  await shot('settings-goal')

  // ── 第二节：门禁面板（U1）+ 模型列表来源（U5）——真实 Chromium + 安装版 React 18 下的异步竞态 ──
  // 跑的是真实 client.js 的 GateSettings：effect/ref/并发渲染都由 React 18 执行，
  // fetch 打到本 harness 的 loopback fixture（可按仓库/按请求注入延迟与失败），
  // 能精确控制「谁先回、谁晚回」。断言只认 client.js 的对外行为与它发出的请求，
  // 不钉 UI 内部实现细节。单测桩（test/fixtures/gate-panel.mjs）只用于快速回归，不作为 WebView 证据。
  // 场景清单（与任务书 B1 一一对应）：按钮→U5-V1；迟到响应→U1-V1/V3、U5-V2b/V3b；
  // 闸门→U5-V2；取消→U1-V4、U5-V5；确认→U5-V4；project/user→U5-V1/V6；targetRepo→U1-V5。
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const fixturePost = (path, body) => page.fetch(path, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), timeout: 5000,
  })
  const gateValue = () => page.evaluate(() => document.querySelector('#gate-semantic-prompt')?.value ?? null)
  const gateBodyText = () => page.evaluate(() => document.querySelector('.dt-settings-body')?.innerText || '')
  const waitGateValue = (expected) => page.waitForFunction(
    (value) => document.querySelector('#gate-semantic-prompt')?.value === value, expected, { timeout: 25000 })
  const clickButton = async (root, text) => {
    const clicked = await page.evaluate(({ root, text }) => {
      const target = [...document.querySelectorAll(root + ' button')].find((node) => (node.textContent || '').trim() === text)
      if (!target) return false
      target.scrollIntoView({ block: 'center' })
      target.click()
      return true
    }, { root, text })
    if (!clicked) throw new Error('找不到按钮：' + root + ' ' + text)
  }
  // ego 的 page.click / page.fill 只认「已经在视口内」的元素（不像 Playwright 会自动滚），
  // 门禁面板比一屏高：真实点击前先滚到刷新按钮，避免「窗口大小 / 滚动位置不同」把正确实现判成 FAIL。
  const clickRefresh = async () => {
    await page.evaluate(() => {
      const button = [...document.querySelectorAll('.dt-toolbar button')]
        .find((node) => (node.textContent || '').trim() === '刷新')
      if (button) button.scrollIntoView({ block: 'center', inline: 'nearest' })
    })
    await page.click('.dt-toolbar button:text-is("刷新")')
    await sleep(250)
  }
  // 同理：门禁提示词输入框在面板底部，先 scrollIntoView 再填。
  const fillPrompt = async (value) => {
    await page.evaluate(() => {
      const node = document.querySelector('#gate-semantic-prompt')
      if (!node) throw new Error('找不到门禁提示词输入框')
      node.scrollIntoView({ block: 'center', inline: 'nearest' })
    })
    await page.fill('#gate-semantic-prompt', value)
  }
  // 切换仓库确认条：用 page.waitForFunction 判「有盒子且没被 visibility 隐藏」，
  // 不依赖滚动位置（ego 的 waitForSelector visible 不保证与视口无关，而本面板会被滚上滚下）。
  const BANNER = ".dt-settings-body [aria-label='切换仓库确认']"
  const waitBanner = (timeout = 25000) => page.waitForFunction((selector) => {
    const node = document.querySelector(selector)
    return Boolean(node && node.getClientRects().length > 0 && getComputedStyle(node).visibility !== 'hidden')
  }, BANNER, { timeout })
  const gateGets = (repo) => gateRace.requests.filter((row) => row.method === 'GET'
    && row.path.startsWith('/session-superagent/gates?') && (!repo || row.repo === repo))

  // 初始：项目层路径来自 watcher.workdir；先让第一次读取迟到，再切仓库。
  await fixturePost('/__fixture/workdir', { repo: 'D:/fixture/work/apple' })
  await clickRefresh()
  await fixturePost('/__fixture/gate-delays', { delays: [2000] })
  await openSettings('门禁')
  await page.waitForFunction(() => [...document.querySelectorAll('.dt-settings-body .dt-section-name')]
    .some((node) => node.textContent === '门禁'), undefined, { timeout: 20000 })
  // Q2-4：语义下界（挂载后至少发一条读取）+ 此刻所有 /gates 读取都属于 apple，
  // 不钉「当前实现恰好一条」的精确次数。
  gateScenarioCheck('U1-V0',
    gateGets('D:/fixture/work/apple').length >= 1
      && gateGets().every((row) => row.repo === 'D:/fixture/work/apple'),
    { requests: gateRace.requests })

  // 场景 V1（U1-G1）：跨仓库乱序。apple 的响应迟到，banana 先回；旧仓库的响应不能把数据切回去。
  await fixturePost('/__fixture/workdir', { repo: 'D:/fixture/work/banana' })
  await clickRefresh()
  await waitGateValue('仓库 D:/fixture/work/banana 的提示词 #1')
  await sleep(2300)
  const lateApple = { value: await gateValue(), body: await gateBodyText() }
  gateScenarioCheck('U1-V1',
    lateApple.value === '仓库 D:/fixture/work/banana 的提示词 #1' && !lateApple.body.includes('apple 的提示词'),
    { value: lateApple.value, requests: gateRace.requests })

  // 场景 V2（U1-G2）：切仓库的读取在途时改出草稿；响应回来不许清掉这份 dirty 草稿。
  await fixturePost('/__fixture/gate-delays', { delays: [2000] })
  await fixturePost('/__fixture/workdir', { repo: 'D:/fixture/work/cherry' })
  await clickRefresh()
  await sleep(200)
  await fillPrompt('手工草稿-未保存')
  const dirtyAfterFill = await page.evaluate(() => document.querySelector('.dt-settings-body .dt-savebar')?.textContent || '')
  await sleep(2400)
  const inFlightDirty = { value: await gateValue(), savebar: await page.evaluate(() => document.querySelector('.dt-settings-body .dt-savebar')?.textContent || '') }
  gateScenarioCheck('U1-V2',
    inFlightDirty.value === '手工草稿-未保存' && inFlightDirty.savebar.includes('未保存') && dirtyAfterFill.includes('未保存'),
    { ...inFlightDirty, dirtyAfterFill })

  // 场景 V3（U1-G3）：同一仓库两次读取乱序。先放弃草稿，再让第一次读取失败拿到「重新读取」，
  // 然后同一帧点两次 —— 第一次迟到、第二次先回；迟到的旧响应不能覆盖最新一次。
  await clickButton('.dt-settings-body .dt-savebar', '放弃')
  await sleep(300)
  await fixturePost('/__fixture/gate-delays', { delays: [0], failNext: true })
  await fixturePost('/__fixture/workdir', { repo: 'D:/fixture/work/damson' })
  await clickRefresh()
  await page.waitForFunction(() => [...document.querySelectorAll('.dt-settings-body button')]
    .some((node) => (node.textContent || '').trim() === '重新读取'), undefined, { timeout: 20000 })
  await fixturePost('/__fixture/gate-delays', { delays: [2000, 0] })
  await page.evaluate(() => {
    window.__clickLog = []
    const start = Date.now()
    document.addEventListener('click', (event) => {
      window.__clickLog.push({ t: Date.now() - start, text: (event.target && event.target.textContent || '').slice(0, 30), connected: event.target?.isConnected })
    }, true)
    const button = [...document.querySelectorAll('.dt-settings-body button')]
      .find((node) => (node.textContent || '').trim() === '重新读取')
    button.click()
    window.__afterFirst = { t: Date.now() - start, connected: button.isConnected, inDom: document.contains(button) }
    button.click()
    window.__afterSecond = { t: Date.now() - start, connected: button.isConnected, inDom: document.contains(button) }
  })
  await page.waitForFunction(() => /仓库 D:\/fixture\/work\/damson 的提示词 #\d+/.test(
    document.querySelector('#gate-semantic-prompt')?.value || ''), undefined, { timeout: 25000 })
  await sleep(2400)
  const sameRepo = { value: await gateValue(), body: await gateBodyText(), clicks: await page.evaluate(() => ({ log: window.__clickLog, afterFirst: window.__afterFirst, afterSecond: window.__afterSecond })) }
  console.log('V3_CLICKS ' + JSON.stringify(sameRepo.clicks))
  // 语义断言：面板必须落在「最后一次发出的 damson 读取」上；不钉「点了两次就一定是 #3」
  // （将来把同帧两次读取合并成一次是合理优化，那时 lastDamson.seq 会变小，断言仍然成立）。
  const lastDamson = gateGets('D:/fixture/work/damson').at(-1)
  gateScenarioCheck('U1-V3',
    Boolean(lastDamson) && sameRepo.value === '仓库 D:/fixture/work/damson 的提示词 #' + lastDamson.seq
      && !sameRepo.body.includes('damson 的提示词 #2'),
    { value: sameRepo.value, last: lastDamson, requests: gateRace.requests })

  // 场景 V4（U1-G4b）：草稿 + 切仓库 → 取消保留草稿，且已经发出去的新仓库读取也要作废。
  await fillPrompt('保存前草稿-保留')
  await sleep(150)
  await fixturePost('/__fixture/workdir', { repo: 'D:/fixture/work/elder' })
  await clickRefresh()
  await waitBanner(20000)
  const confirmText = await page.evaluate(() => document.querySelector(".dt-settings-body [aria-label='切换仓库确认']")?.innerText || '')
  const elderBefore = gateGets('D:/fixture/work/elder').length
  await clickButton(".dt-settings-body [aria-label='切换仓库确认']", '取消')
  await page.waitForFunction(() => (document.querySelector('.dt-settings-body')?.innerText || '').includes('已保留草稿'), undefined, { timeout: 20000 })
  const elderAfterCancel = gateGets('D:/fixture/work/elder').length
  gateScenarioCheck('U1-V4',
    confirmText.includes('仓库已切换到 D:/fixture/work/elder') && elderBefore === 0 && elderAfterCancel === 0
      && (await gateValue()) === '保存前草稿-保留',
    { confirmText, elderBefore, elderAfterCancel, value: await gateValue() })

  // 场景 V5（U1-G5）：预览 / 保存都认 GET 回显的 data.repo（damson），不是刚切过去的 elder。
  await clickButton('.dt-settings-body', '预览')
  await sleep(400)
  const previewRequest = gateRace.requests.find((row) => row.method === 'POST' && row.path.endsWith('/gates/preview'))
  await clickButton('.dt-settings-body .dt-savebar', '保存')
  await sleep(500)
  const saveRequest = gateRace.requests.find((row) => row.method === 'POST' && row.path === '/session-superagent/gates')
  gateScenarioCheck('U1-V5',
    Boolean(previewRequest && saveRequest)
      && JSON.parse(previewRequest.body).repo === 'D:/fixture/work/damson'
      && JSON.parse(saveRequest.body).repo === 'D:/fixture/work/damson',
    {
      previewRepo: previewRequest && JSON.parse(previewRequest.body).repo,
      saveRepo: saveRequest && JSON.parse(saveRequest.body).repo,
      previewBody: previewRequest && previewRequest.body,
      saveBody: saveRequest && saveRequest.body,
    })

  // 场景 V6：保存成功后按当前仓库（elder）重读，保留草稿提示消失。
  await page.waitForFunction(() => /仓库 D:\/fixture\/work\/elder 的提示词 #\d+/.test(
    document.querySelector('#gate-semantic-prompt')?.value || ''), undefined, { timeout: 25000 })
  await sleep(400)
  const afterSave = { value: await gateValue(), body: await gateBodyText() }
  gateScenarioCheck('U1-V6',
    /^仓库 D:\/fixture\/work\/elder 的提示词 #\d+$/.test(afterSave.value || '') && !afterSave.body.includes('已保留草稿'),
    afterSave)

  // ── 模型列表来源 = panelRepo（U5，v6 从临时 harness 收进仓库）──────────────────
  // 单测桩（test/fixtures/gate-panel.mjs）只做快速回归；这里跑真实 useEffect/useRef/并发渲染，
  // fetch 打到本 harness 的 loopback fixture，可以按仓库 / 按请求控制延迟与迟到顺序。
  const modelValues = () => page.evaluate(() => [...document.querySelectorAll('#gate-semantic-model option')]
    .map((node) => node.value).filter(Boolean))
  const modelDropdownSize = () => page.evaluate(() => document.querySelectorAll('#gate-semantic-model option').length)
  const modelStaleVisible = () => page.evaluate(() => (document.querySelector('.dt-settings-body')?.innerText || '')
    .includes('已忽略，请重新读取'))
  const modelSelectDisabled = () => page.evaluate(() => document.querySelector('#gate-semantic-model')?.disabled === true)
  const waitModelsIdle = () => page.waitForFunction(() => [...document.querySelectorAll('.dt-settings-body button')]
    .some((node) => (node.textContent || '').trim() === '读取模型列表'), undefined, { timeout: 30000 })
  const clickModels = async () => {
    await waitModelsIdle()
    await clickButton('.dt-settings-body', '读取模型列表')
  }
  const modelTagOf = (repo) => String(repo || '').split('/').filter(Boolean).pop() || 'none'
  const modelIdFor = (repo, seq) => 'group/model-' + modelTagOf(repo) + '-' + seq
  const modelGets = (repo) => modelRace.requests.filter((row) => !repo || row.repo === repo)
  const waitModelRepo = (repo) => page.waitForFunction((prefix) => [...document.querySelectorAll('#gate-semantic-model option')]
    .some((node) => node.value.startsWith(prefix)), 'group/model-' + modelTagOf(repo) + '-', { timeout: 30000 })
  const waitGateRepo = (repo) => page.waitForFunction((prefix) => (document.querySelector('#gate-semantic-prompt')?.value || '')
    .startsWith(prefix), '仓库 ' + repo + ' 的提示词 #', { timeout: 30000 })
  const switchRepoOnly = async (repo, gateDelay = 0) => {
    await fixturePost('/__fixture/gate-delays', { delays: gateDelay > 0 ? [gateDelay] : [] })
    await fixturePost('/__fixture/workdir', { repo })
    await clickRefresh()
  }
  const bannerText = () => page.evaluate(() => document.querySelector(".dt-settings-body [aria-label='切换仓库确认']")?.innerText
    || document.querySelector('.dt-settings-body .dt-banner')?.innerText || '')
  const waitFor = async (predicate, timeoutMs = 10000, label = '') => {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const value = predicate()
      if (value) return value
      await sleep(50)
    }
    throw new Error('等待超时：' + label)
  }
  const activateSwitch = (id) => page.evaluate((id) => {
    const holder = document.getElementById(id)
    if (!holder) return null
    const control = holder.matches('button,[role="switch"],input')
      ? holder : holder.querySelector('button,[role="switch"],input')
    if (!control) return 'no-control:' + holder.outerHTML.slice(0, 200)
    control.click()
    return 'clicked:' + control.tagName + ':' + (control.getAttribute('role') || '')
  }, id)
  const setScope = async (label) => {
    const result = await page.evaluate((label) => {
      const groups = [...document.querySelectorAll('[role="radiogroup"]')]
      const group = groups.find((node) => (node.getAttribute('aria-label') || '').includes('门禁作用域'))
        || document.getElementById('gate-scope')?.closest('[role="radiogroup"]')
        || document.getElementById('gate-scope')
      const scope = group || document.querySelector('.dt-settings-body')
      const nodes = [...scope.querySelectorAll('button,[role="radio"],[role="tab"],label')]
      const target = nodes.find((node) => (node.textContent || '').trim() === label)
      if (!target) return { ok: false, html: scope ? scope.outerHTML.slice(0, 600) : null }
      target.click()
      return { ok: true, tag: target.tagName, role: target.getAttribute('role') }
    }, label)
    if (result.ok) await sleep(400)
    return result
  }

  // U5-V0：切到新仓库后，模型列表跟着面板仓库读（>=1 条），落地的也是它自己的列表。
  await fixturePost('/__fixture/model-delays', { delays: [] })
  await switchRepoOnly('D:/fixture/work/alpha')
  await waitGateRepo('D:/fixture/work/alpha')
  await waitModelRepo('D:/fixture/work/alpha')
  const alphaRequests = modelGets('D:/fixture/work/alpha')
  gateScenarioCheck('U5-V0',
    alphaRequests.length >= 1 && (await modelValues()).some((value) => value.startsWith('group/model-alpha-')),
    { requests: alphaRequests, values: await modelValues() })

  // U5-V1（U5-M1，user）：保留草稿时「读取模型列表」按草稿来源仓库读，不读新 prop 仓库。
  await fillPrompt('U5 草稿-按钮读面板仓库')
  await sleep(150)
  await switchRepoOnly('D:/fixture/work/bravo')
  await waitBanner()
  await fixturePost('/__fixture/model-delays', { delays: [300] })
  const beforeM1 = modelGets().length
  await clickModels()
  await sleep(800)
  const m1Fresh = modelGets().slice(beforeM1)
  const m1Values = await modelValues()
  const m1Banner = await bannerText()
  // Q2-4：语义下界（>=1 条 + 每条 repo 全等）—— 将来把重复 load 合并或加一条重试不会假红；
  // 「下拉不含 bravo 模型」「不读 bravo」是负面断言，原样保留。
  gateScenarioCheck('U5-V1',
    m1Fresh.length >= 1 && m1Fresh.every((row) => row.repo === 'D:/fixture/work/alpha')
      && modelGets('D:/fixture/work/bravo').length === 0
      && m1Values.some((value) => value.startsWith('group/model-alpha-'))
      && !m1Values.some((value) => value.startsWith('group/model-bravo-'))
      && m1Banner.includes('仓库已切换到 D:/fixture/work/bravo'),
    { fresh: m1Fresh, values: m1Values, banner: m1Banner })

  // 清理：放弃草稿切到 bravo（作为后面 M2 的基准面板仓库）。
  await clickButton(".dt-settings-body [aria-label='切换仓库确认']", '放弃草稿并切换')
  await waitGateRepo('D:/fixture/work/bravo')
  await waitModelRepo('D:/fixture/work/bravo')

  // U5-V2（U5-M2，user）：闸门挡住 /gates 时作废在途 models，并重读草稿来源列表。
  await fixturePost('/__fixture/model-delays', { delays: [3000] })
  const beforeClickBravo = modelGets().length
  await clickModels()
  await waitFor(() => modelGets().length > beforeClickBravo, 5000, 'bravo models request')
  const r1 = modelGets('D:/fixture/work/bravo').at(-1)
  const beforeGateSwitch = modelGets().length
  await fixturePost('/__fixture/gate-delays', { delays: [1500] })
  await fixturePost('/__fixture/workdir', { repo: 'D:/fixture/work/charlie' })
  await clickRefresh()
  await sleep(250)
  await fillPrompt('U5 闸门草稿-不丢')
  await waitBanner()
  await waitFor(() => modelGets().length > beforeGateSwitch, 5000, 'gate-path bravo models request')
  const m2RestoredRows = modelGets().slice(beforeGateSwitch)
  const m2Restored = m2RestoredRows.at(-1)
  // 语义下界：闸门挡住后至少重读一条 bravo（不钉当前实现重复 load 的精确次数），且绝不读 charlie。
  gateScenarioCheck('U5-V2',
    m2RestoredRows.length >= 1 && m2RestoredRows.every((row) => row.repo === 'D:/fixture/work/bravo')
      && m2Restored !== r1 && modelGets('D:/fixture/work/charlie').length === 0,
    { restoredRows: m2RestoredRows, r1, charlie: modelGets('D:/fixture/work/charlie') })
  await sleep(3400)
  const m2Late = await modelValues()
  gateScenarioCheck('U5-V2b',
    Boolean(r1) && !m2Late.includes(modelIdFor('D:/fixture/work/bravo', r1.seq))
      && Boolean(m2Restored) && m2Late.includes(modelIdFor('D:/fixture/work/bravo', m2Restored.seq)),
    { lateValues: m2Late, r1, restored: m2Restored })

  // 清理：放弃草稿切到 charlie。
  await clickButton(".dt-settings-body [aria-label='切换仓库确认']", '放弃草稿并切换')
  await waitGateRepo('D:/fixture/work/charlie')
  await waitModelRepo('D:/fixture/work/charlie')

  // U5-V3（U5-M3 + 渲染护栏）：charlie 的 models 迟到；切到 delta 后它不能上屏。
  await fixturePost('/__fixture/model-delays', { delays: [2500] })
  const beforeCharlie = modelGets('D:/fixture/work/charlie').length
  await clickModels()
  await waitFor(() => modelGets('D:/fixture/work/charlie').length > beforeCharlie, 5000, 'charlie models request')
  const rCharlie = modelGets('D:/fixture/work/charlie').at(-1)
  await fixturePost('/__fixture/model-delays', { delays: [3000] })
  await switchRepoOnly('D:/fixture/work/delta')
  await waitGateRepo('D:/fixture/work/delta')
  await waitFor(() => modelGets('D:/fixture/work/delta').length > 0, 5000, 'delta models request')
  let guardAppeared = false
  try {
    await page.waitForFunction(() => (document.querySelector('.dt-settings-body')?.innerText || '')
      .includes('已忽略，请重新读取'), undefined, { timeout: 12000 })
    guardAppeared = true
  } catch {}
  const rDelta = modelGets('D:/fixture/work/delta').at(-1)
  const guard = {
    visible: await modelStaleVisible(),
    appeared: guardAppeared,
    options: await modelDropdownSize(),
    values: await modelValues(),
    disabled: await modelSelectDisabled(),
  }
  gateScenarioCheck('U5-V3a',
    guard.visible && guard.options === 1 && guard.values.length === 1
      && Boolean(rDelta) && rDelta.repo === 'D:/fixture/work/delta',
    { guard, rDelta, charlie: rCharlie })
  await waitModelRepo('D:/fixture/work/delta')
  await sleep(2600)
  const late = { values: await modelValues(), stale: await modelStaleVisible() }
  gateScenarioCheck('U5-V3b',
    Boolean(rCharlie) && !late.values.includes(modelIdFor('D:/fixture/work/charlie', rCharlie.seq))
      && late.values.some((value) => value.startsWith('group/model-delta-'))
      && Boolean(rDelta) && late.values.includes(modelIdFor('D:/fixture/work/delta', rDelta.seq))
      && late.stale === false,
    { late, rCharlie, rDelta })

  // U5-V4（U5-M4）：确认放弃草稿后模型列表跟着切到新仓库（echo）。
  await fixturePost('/__fixture/model-delays', { delays: [] })
  await fillPrompt('U5 确认切换草稿')
  await sleep(150)
  await switchRepoOnly('D:/fixture/work/echo')
  await waitBanner()
  const echoBefore = modelGets('D:/fixture/work/echo').length
  await clickButton(".dt-settings-body [aria-label='切换仓库确认']", '放弃草稿并切换')
  await waitGateRepo('D:/fixture/work/echo')
  await waitModelRepo('D:/fixture/work/echo')
  const m4 = { values: await modelValues(), requests: modelGets('D:/fixture/work/echo') }
  // 语义下界：确认后至少一条读 echo 的 models（当前实现还会有一条草稿清空后的补读；
  // 合并重复 load 是合理优化，所以这里不钉精确次数）。
  gateScenarioCheck('U5-V4',
    echoBefore === 0 && m4.requests.length >= 1
      && m4.requests.every((row) => row.repo === 'D:/fixture/work/echo')
      && m4.values.some((value) => value.startsWith('group/model-echo-'))
      && !m4.values.some((value) => value.startsWith('group/model-delta-')),
    { echoBefore, ...m4 })

  // U5-V5（U2-F2）：取消换仓库后模型列表仍读面板仓库（echo），不读新仓库 foxtrot。
  await fillPrompt('U5 取消切换草稿')
  await sleep(150)
  await switchRepoOnly('D:/fixture/work/foxtrot')
  await waitBanner()
  await fixturePost('/__fixture/model-delays', { delays: [200] })
  const beforeCancel = modelGets().length
  await clickButton(".dt-settings-body [aria-label='切换仓库确认']", '取消')
  await page.waitForFunction(() => (document.querySelector('.dt-settings-body')?.innerText || '').includes('已保留草稿'),
    undefined, { timeout: 25000 })
  await sleep(700)
  const cancelFresh = modelGets().slice(beforeCancel)
  const m5 = { values: await modelValues(), fresh: cancelFresh, foxtrot: modelGets('D:/fixture/work/foxtrot') }
  gateScenarioCheck('U5-V5',
    cancelFresh.length >= 1 && cancelFresh.every((row) => row.repo === 'D:/fixture/work/echo')
      && m5.foxtrot.length === 0
      && (await gateValue()) === 'U5 取消切换草稿'
      && m5.values.some((value) => value.startsWith('group/model-echo-'))
      && !m5.values.some((value) => value.startsWith('group/model-foxtrot-')),
    m5)

  // U5-V6（U5-M1 project）：项目层不能换模型，但保留草稿时按钮仍应按草稿来源读列表。
  // 三个前提（作用域可切、模型下拉禁用、草稿能变脏）本身就是断言：任一条不成立就 FAIL，
  // 不再像 v5 临时 harness 那样打一行 SKIP 就放过（否则这条覆盖会静默消失）。
  await clickButton('.dt-settings-body', '放弃草稿并切换')
  await waitGateRepo('D:/fixture/work/foxtrot')
  await waitModelRepo('D:/fixture/work/foxtrot')
  const scopeSwitch = await setScope('项目')
  await sleep(500)
  const projectDisabled = await modelSelectDisabled()
  const dirtied = (await activateSwitch('gate-semantic-off')) || (await activateSwitch('gate-rule-abs-path-switch'))
  // 这里用 try/catch 而不是等它抛：dirty 的布尔值随后由 check 断言，超时就是 FAIL，不会静默放过。
  let dirty = false
  try {
    await page.waitForFunction(() => (document.querySelector('.dt-settings-body')?.innerText || '').includes('未保存'),
      undefined, { timeout: 4000 })
    dirty = true
  } catch {}
  gateScenarioCheck('U5-V6a',
    scopeSwitch.ok === true && projectDisabled === true && dirty === true,
    { scopeSwitch, projectDisabled, dirtied, dirty })
  await switchRepoOnly('D:/fixture/work/golf')
  const bannerShown = await waitBanner(20000).then(() => true).catch(() => false)
  await fixturePost('/__fixture/model-delays', { delays: [200] })
  const beforeProject = modelGets().length
  await clickModels()
  await sleep(700)
  const freshProject = modelGets().slice(beforeProject)
  const m6 = {
    values: await modelValues(), fresh: freshProject, golf: modelGets('D:/fixture/work/golf'),
    projectDisabled, dirty, dirtied, bannerShown, seq: modelRace.seq.get('D:/fixture/work/foxtrot'),
  }
  // Q2-4：语义下界（>=1 条 + 每条 repo 全等），不钉「当前实现恰好发一条」的精确次数；
  // 「不读 golf」是负面断言，原样保留。
  gateScenarioCheck('U5-V6b',
    bannerShown && projectDisabled === true && freshProject.length >= 1
      && freshProject.every((row) => row.repo === 'D:/fixture/work/foxtrot') && m6.golf.length === 0
      && m6.values.includes(modelIdFor('D:/fixture/work/foxtrot', m6.seq)),
    m6)
  // Q2-2 收尾硬断言：17 条门禁/模型场景必须条条真的跑到（有场景被 if (false) 包住时，
  // 这里抛错 => 「脚本执行完成」FAIL => exit 1，而不是静默少一条覆盖）。
  assertAllGateScenariosRan()
  // 收尾：清掉草稿切到 golf，避免后续 orbit 段落在确认条上。
  if (bannerShown) {
    await clickButton(".dt-settings-body [aria-label='切换仓库确认']", '放弃草稿并切换')
    await waitGateRepo('D:/fixture/work/golf')
  }

  // 第三阶段：同一真实 client.js 的 StatusOrbit 已由独立 root 挂载；只走只读打开、键盘与取消。
  const orbitTrigger = '#orbit-app .sa-orbit-trigger'
  const orbitPanel = '.sa-dock-panel[role="dialog"]'
  const openOrbit = async () => {
    await page.click(orbitTrigger)
    await page.waitForSelector(orbitPanel, { state: 'visible', timeout: 5000 })
    await page.waitForFunction((selector) => {
      const panel = document.querySelector(selector)
      return panel && getComputedStyle(panel).visibility === 'visible' && document.activeElement === panel
    }, orbitPanel, { timeout: 5000 })
  }
  const waitOrbitClosed = async () => {
    await page.waitForFunction((selector) => !document.querySelector(selector), orbitPanel, { timeout: 5000 })
  }

  await openOrbit()
  const orbitOpened = await page.evaluate((selector) => {
    const panel = document.querySelector(selector)
    const trigger = document.querySelector('#orbit-app .sa-orbit-trigger')
    const rect = panel?.getBoundingClientRect()
    return {
      expanded: trigger?.getAttribute('aria-expanded'),
      label: panel?.getAttribute('aria-label'),
      ariaModal: panel?.getAttribute('aria-modal'),
      parent: panel?.parentElement?.tagName,
      rows: panel?.querySelectorAll('.sa-dock-row').length,
      repos: [...(panel?.querySelectorAll('.sa-dock-name') || [])].map((node) => node.textContent),
      activeIsPanel: document.activeElement === panel,
      activeConnected: document.activeElement?.isConnected === true,
      style: panel ? { position: getComputedStyle(panel).position, visibility: getComputedStyle(panel).visibility, zIndex: getComputedStyle(panel).zIndex } : null,
      rect: rect ? { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom } : null,
      viewport: { width: innerWidth, height: innerHeight },
    }
  }, orbitPanel)
  check('Orbit 真实打开且 fixture watcher DOM 完整', orbitOpened.expanded === 'true'
    && orbitOpened.label?.includes('共 2 条') && orbitOpened.ariaModal === null && orbitOpened.parent === 'BODY'
    && orbitOpened.rows === 2 && JSON.stringify(orbitOpened.repos) === JSON.stringify(['acme/widgets', 'acme/paused'])
    && orbitOpened.style?.position === 'fixed' && orbitOpened.style?.visibility === 'visible'
    && orbitOpened.rect?.left >= 0 && orbitOpened.rect?.top >= 0
    && orbitOpened.rect?.right <= orbitOpened.viewport.width && orbitOpened.rect?.bottom <= orbitOpened.viewport.height, orbitOpened)
  check('Orbit 初始焦点落在可见非 Modal surface', orbitOpened.activeIsPanel && orbitOpened.activeConnected, {
    activeIsPanel: orbitOpened.activeIsPanel, activeConnected: orbitOpened.activeConnected,
  })
  await shot('orbit-open')

  // 同一 trigger 真实点击关闭；点击本身会把焦点放在 trigger 上，关闭后不得丢到 body。
  await page.click(orbitTrigger)
  await waitOrbitClosed()
  const orbitToggledClosed = await page.evaluate(() => ({
    expanded: document.querySelector('#orbit-app .sa-orbit-trigger')?.getAttribute('aria-expanded'),
    activeIsTrigger: document.activeElement === document.querySelector('#orbit-app .sa-orbit-trigger'),
    activeConnected: document.activeElement?.isConnected === true,
  }))
  check('Orbit trigger 再次点击关闭且焦点不丢', orbitToggledClosed.expanded === 'false'
    && orbitToggledClosed.activeIsTrigger && orbitToggledClosed.activeConnected, orbitToggledClosed)

  await openOrbit()
  await page.keyboard.press('Escape')
  await waitOrbitClosed()
  await page.waitForFunction(() => document.activeElement === document.querySelector('#orbit-app .sa-orbit-trigger'), undefined, { timeout: 3000 })
  const orbitEscaped = await page.evaluate(() => ({
    expanded: document.querySelector('#orbit-app .sa-orbit-trigger')?.getAttribute('aria-expanded'),
    activeIsTrigger: document.activeElement === document.querySelector('#orbit-app .sa-orbit-trigger'),
    activeConnected: document.activeElement?.isConnected === true,
  }))
  check('Orbit Escape 关闭并显式回焦圆环', orbitEscaped.expanded === 'false'
    && orbitEscaped.activeIsTrigger && orbitEscaped.activeConnected, orbitEscaped)

  // 删除只开到确认层并取消；不得触发 /watch mutation。
  await openOrbit()
  await page.click('.sa-dock-panel .sa-dock-row:first-child .sa-dock-actions button[aria-label="删除"]')
  await page.waitForSelector('.dt-modal-root .dt-modal[role="dialog"][aria-modal="true"]', { state: 'visible', timeout: 5000 })
  await page.waitForFunction(() => {
    const modal = document.querySelector('.dt-modal-root .dt-modal[role="dialog"][aria-modal="true"]')
    return modal && modal.contains(document.activeElement) && document.activeElement !== document.body
  }, undefined, { timeout: 3000 })
  const modalOpened = await page.evaluate(() => {
    const modal = document.querySelector('.dt-modal-root .dt-modal[role="dialog"][aria-modal="true"]')
    const root = document.querySelector('.dt-modal-root')
    return {
      title: modal?.getAttribute('aria-label'),
      description: modal?.querySelector('.dt-modal-description')?.textContent,
      footer: [...(modal?.querySelectorAll('.dt-modal-footer button') || [])].map((node) => node.textContent),
      orbitPresent: Boolean(document.querySelector('.sa-dock-panel[role="dialog"]')),
      activeInside: Boolean(modal?.contains(document.activeElement)),
      activeLabel: document.activeElement?.getAttribute('aria-label') || document.activeElement?.textContent,
      activeConnected: document.activeElement?.isConnected === true,
      rootZIndex: root ? getComputedStyle(root).zIndex : null,
    }
  })
  check('Orbit 删除先关 surface 再打开确认 Modal', !modalOpened.orbitPresent
    && modalOpened.title === '确认删除' && modalOpened.description?.includes('删除')
    && JSON.stringify(modalOpened.footer) === JSON.stringify(['取消', '确认删除']), modalOpened)
  check('Orbit 确认 Modal 初始焦点进入 dialog 且不被 cleanup 抢走', modalOpened.activeInside
    && modalOpened.activeConnected && modalOpened.activeLabel === '关闭', modalOpened)

  const modalTabCycle = []
  let modalFocusHeld = true
  for (let index = 0; index < 3; index += 1) {
    await page.keyboard.press('Tab')
    const focus = await page.evaluate(() => {
      const modal = document.querySelector('.dt-modal-root .dt-modal[role="dialog"][aria-modal="true"]')
      return {
        inside: Boolean(modal?.contains(document.activeElement)),
        label: document.activeElement?.getAttribute('aria-label') || document.activeElement?.textContent,
        connected: document.activeElement?.isConnected === true,
      }
    })
    modalTabCycle.push(focus)
    modalFocusHeld = modalFocusHeld && focus.inside && focus.connected
  }
  check('Orbit 确认 Modal Tab 焦点圈闭合且不丢焦', modalFocusHeld
    && JSON.stringify(modalTabCycle.map((row) => row.label)) === JSON.stringify(['取消', '确认删除', '关闭']), modalTabCycle)
  await shot('orbit-modal')
  await page.click('.dt-modal-root .dt-modal-footer button:text-is("取消")')
  await page.waitForFunction(() => !document.querySelector('.dt-modal-root .dt-modal[role="dialog"]'), undefined, { timeout: 5000 })
  await page.waitForFunction(() => document.activeElement === document.querySelector('#orbit-app .sa-orbit-trigger'), undefined, { timeout: 3000 })
  const modalCancelled = await page.evaluate(() => ({
    orbitPresent: Boolean(document.querySelector('.sa-dock-panel[role="dialog"]')),
    activeIsTrigger: document.activeElement === document.querySelector('#orbit-app .sa-orbit-trigger'),
    activeConnected: document.activeElement?.isConnected === true,
    expanded: document.querySelector('#orbit-app .sa-orbit-trigger')?.getAttribute('aria-expanded'),
  }))
  check('Orbit 确认 Modal 取消后回焦圆环且不重开 surface', !modalCancelled.orbitPresent
    && modalCancelled.activeIsTrigger && modalCancelled.activeConnected && modalCancelled.expanded === 'false', modalCancelled)

  const errors = await page.evaluate(() => ({
    capture: window.__captureErrors.filter((event) => !String(event.message).includes('intentional-capture-stop')),
    network: window.__networkViolations,
  }))
  check('完整走查无未预期页面错误或外部请求', errors.capture.length === 0 && errors.network.length === 0, errors)
  // 门禁专项会 POST /gates 与 /gates/preview —— 那是本 harness 自己的 loopback fixture 记录，
  // 不是真实写操作；这里只把「门禁之外的 mutation」计为违规。
  const mutations = apiLog.filter((row) => row.method !== 'GET' && !row.path.startsWith('/session-superagent/gates'))
  const traceCalls = apiLog.filter((row) => row.path.startsWith('/session-superagent/trace'))
  const updateCalls = apiLog.filter((row) => row.path.startsWith('/session-superagent/update'))
  check('fake state/update/trace 均实际命中 loopback', apiLog.some((row) => row.path === '/session-superagent/state')
    && traceCalls.length === 1 && traceCalls[0].path === '/session-superagent/trace?number=42'
    && updateCalls.length >= 1 && updateCalls.every((row) => row.method === 'GET'), { traceCalls, updateCalls, origin })
  check('禁止真实 GitHub、更新、删除与全部 mutation', mutations.length === 0 && errors.network.length === 0, { mutations, external: errors.network })

  // 功能走查保持 mutation=0 后，显式打一次独立 loopback 防写探针，证明 403 guard 本身仍有效。
  // 这不是产品保存/删除动作，不会离开 127.0.0.1，也不会改变 fixture。
  const guardProbe = await page.fetch('/session-superagent/watch', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'delete', id: 'fixture-read-only-guard-probe' }), timeout: 5000,
  })
  check('fixture mutation 防写 guard 真实返回 403', guardProbe.status === 403
    && String(guardProbe.body).includes('fixture-read-only')
    && apiLog.filter((row) => row.method !== 'GET' && !row.path.startsWith('/session-superagent/gates')).length === 1
    && apiLog.at(-1)?.body.includes('fixture-read-only-guard-probe'),
  { status: guardProbe.status, body: guardProbe.body, request: apiLog.at(-1) })
  // ── 第四阶段 · Issue #35：确认层在真实 composer dock 里的几何与真实点击 ─────────────
  // dock 是 transform + contain:layout paint + overflow:hidden 的窄容器。确认层若不 portal
  // 到 body，dt-modal-root 的 position:fixed 会以 dock 为包含块并被裁掉：footer 看不见、点不到。
  // 本段是脚本里第二条显式 mutation：真实鼠标点「确认删除」→ POST /watch → loopback 仍回 403，
  // 不离开 127.0.0.1、不真的删任何东西；它证明的是「按钮真的被点中」，不是删除成功。
  // 所有等待都带 try/catch：修复前这一步本来就该红，不能把「红」变成「脚本崩掉」。
  mkdirSync(ISSUE35_ARTIFACTS, { recursive: true })
  const dockTrigger = '#dock-app .sa-orbit-trigger'
  const dockPanelSelector = '.sa-dock-panel[role="dialog"]'
  const confirmModalSelector = '.dt-modal-root .dt-modal[role="dialog"][aria-modal="true"]'
  const dockGeometry = async () => page.evaluate((selectors) => {
    const dock = document.getElementById('dock-app')
    const root = document.querySelector('.dt-modal-root')
    const modal = document.querySelector(selectors.confirmModal)
    const footer = modal && modal.querySelector('.dt-modal-footer')
    const buttons = [...((footer && footer.querySelectorAll('button')) || [])]
    const cancel = buttons.find((node) => node.textContent === '取消')
    const confirm = buttons.find((node) => node.textContent === '确认删除')
    const box = (node) => {
      if (!node) return null
      const rect = node.getBoundingClientRect()
      return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height }
    }
    const cover = (node) => {
      const rect = box(node)
      if (!rect) return null
      return document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)
    }
    const cancelHit = cover(cancel)
    const confirmHit = cover(confirm)
    const dockRect = box(dock)
    const cancelRect = box(cancel)
    const confirmRect = box(confirm)
    const rootStyle = root ? getComputedStyle(root) : null
    const dockStyle = dock ? getComputedStyle(dock) : null
    const cancelled = cancelHit && cancel && (cancelHit === cancel || cancel.contains(cancelHit))
    const confirmed = confirmHit && confirm && (confirmHit === confirm || confirm.contains(confirmHit))
    const inViewport = (rect) => Boolean(rect && rect.left >= 0 && rect.top >= 0
      && rect.right <= innerWidth && rect.bottom <= innerHeight)
    return {
      rootParent: root && root.parentElement ? root.parentElement.tagName : null,
      root: box(root),
      dock: dockRect,
      modal: box(modal),
      footer: box(footer),
      cancel: cancelRect,
      confirm: confirmRect,
      cancelHit: cancelHit ? (cancelHit.tagName + '.' + String(cancelHit.className || '')) : null,
      confirmHit: confirmHit ? (confirmHit.tagName + '.' + String(confirmHit.className || '')) : null,
      cancelHitIsButton: Boolean(cancelled),
      confirmHitIsButton: Boolean(confirmed),
      cancelInViewport: inViewport(cancelRect),
      confirmInViewport: inViewport(confirmRect),
      dockAncestor: dockStyle ? { contain: dockStyle.contain, transform: dockStyle.transform, overflow: dockStyle.overflow } : null,
      rootPosition: rootStyle ? rootStyle.position : null,
      viewport: { width: innerWidth, height: innerHeight },
      modalInsideDock: Boolean(dockRect && box(modal)
        && box(modal).left >= dockRect.left && box(modal).right <= dockRect.right
        && box(modal).top >= dockRect.top && box(modal).bottom <= dockRect.bottom),
    }
  }, { confirmModal: confirmModalSelector })

  const openDockOrbit = async () => {
    await page.click(dockTrigger)
    await page.waitForFunction((selector) => {
      const panel = document.querySelector(selector)
      return panel && getComputedStyle(panel).visibility === 'visible'
    }, dockPanelSelector, { timeout: 5000 })
  }
  const openDockConfirm = async () => {
    await page.click('.sa-dock-panel[role="dialog"] .sa-dock-row:first-child .sa-dock-actions button[aria-label="删除"]')
    await page.waitForSelector(confirmModalSelector, { state: 'visible', timeout: 5000 })
    await page.waitForFunction((selector) => {
      const modal = document.querySelector(selector)
      return modal && modal.contains(document.activeElement) && document.activeElement !== document.body
    }, confirmModalSelector, { timeout: 3000 })
  }
  const waitDockConfirmClosed = async () => {
    try {
      await page.waitForFunction((selector) => !document.querySelector(selector), confirmModalSelector, { timeout: 4000 })
      return true
    } catch {
      return false
    }
  }
  const dockFocus = async () => page.evaluate((selector) => {
    const trigger = document.querySelector(selector)
    return {
      activeIsTrigger: document.activeElement === trigger,
      activeConnected: document.activeElement?.isConnected === true,
      expanded: trigger?.getAttribute('aria-expanded'),
      modalPresent: Boolean(document.querySelector('.dt-modal-root .dt-modal[role="dialog"]')),
      orbitPresent: Boolean(document.querySelector('.sa-dock-panel[role="dialog"]')),
    }
  }, dockTrigger)
  const dockPoint = async (text) => page.evaluate(({ selector, text }) => {
    const modal = document.querySelector(selector)
    const button = [...(modal?.querySelectorAll('.dt-modal-footer button') || [])].find((node) => node.textContent === text)
    if (!button) return null
    const rect = button.getBoundingClientRect()
    return {
      x: rect.left + rect.width / 2,
      y: rect.top + rect.height / 2,
      rect: { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom },
      inViewport: rect.left >= 0 && rect.top >= 0 && rect.right <= innerWidth && rect.bottom <= innerHeight,
    }
  }, { selector: confirmModalSelector, text })
  const dockClickButton = async (text, label) => {
    const point = await dockPoint(text)
    if (!point || !point.inViewport) return { point, clicked: false }
    await page.mouse.click(point.x, point.y, { label })
    return { point, clicked: true }
  }

  // dock 在其它阶段保持 visibility:hidden —— 否则它盖住设置页底部的控件，拦截真实点击。
  await page.evaluate(() => { document.getElementById('dock-app').style.visibility = 'visible' })
  await page.cdp('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: false })
  await page.waitForTimeout(250)
  await openDockOrbit()
  await openDockConfirm()
  const dockOpened = await dockGeometry()
  writeFileSync(join(ISSUE35_ARTIFACTS, 'dock-confirm-geometry.json'), JSON.stringify({ phase: 'modal-open-390', dockOpened }, null, 2))
  observe('Issue #35 dock 确认层几何（窄屏 390）', dockOpened)
  check('Issue #35 dock 确认层挂到 document.body（结构）', dockOpened.rootParent === 'BODY'
    && dockOpened.rootPosition === 'fixed'
    && dockOpened.root?.width >= dockOpened.viewport.width - 1
    && dockOpened.root?.height >= dockOpened.viewport.height - 1, dockOpened)
  check('Issue #35 dock 确认层 footer 完整显示且真实可点', dockOpened.footer !== null
    && dockOpened.cancelInViewport && dockOpened.confirmInViewport
    && dockOpened.cancelHitIsButton && dockOpened.confirmHitIsButton
    && dockOpened.modalInsideDock === false, dockOpened)

  // Tab 圈：确认层在 body 下仍只在 dialog 内循环（初始焦点 关闭 → 取消 → 确认删除 → 关闭）。
  const dockTabCycle = []
  let dockTabHeld = true
  for (let index = 0; index < 3; index += 1) {
    await page.keyboard.press('Tab')
    const focus = await page.evaluate((selector) => {
      const modal = document.querySelector(selector)
      return {
        inside: Boolean(modal && modal.contains(document.activeElement)),
        label: document.activeElement?.getAttribute('aria-label') || document.activeElement?.textContent,
        connected: document.activeElement?.isConnected === true,
      }
    }, confirmModalSelector)
    dockTabCycle.push(focus)
    dockTabHeld = dockTabHeld && focus.inside && focus.connected
  }
  check('Issue #35 dock 确认层 Tab 焦点圈闭合且不丢焦', dockTabHeld
    && JSON.stringify(dockTabCycle.map((row) => row.label)) === JSON.stringify(['取消', '确认删除', '关闭']), dockTabCycle)

  // 深浅两套主题各出一张窄屏图（确认层打开状态）。
  const issue35Shots = []
  const issue35Shot = async (name) => {
    const path = join(ISSUE35_ARTIFACTS, name)
    try {
      await page.screenshot({ path })
      issue35Shots.push(path)
      observe('Issue #35 截图', { path, bytes: statSync(path).size })
    } catch (error) {
      const detail = String((error && error.message) || error)
      console.log(`SKIP Issue #35 截图 ${name} ${JSON.stringify(detail)}`)
      observe('Issue #35 截图通道跳过', { name, error: detail })
    }
  }
  await issue35Shot('issue35-dock-confirm-dark-390.png')
  await page.evaluate(() => document.body.removeAttribute('data-ds-dark-theme'))
  await page.waitForTimeout(120)
  await issue35Shot('issue35-dock-confirm-light-390.png')
  await page.evaluate(() => document.body.setAttribute('data-ds-dark-theme', 'true'))
  await page.waitForTimeout(120)

  // 真实鼠标点「确认删除」：必须真的发出 POST /watch（fixture 回 403 → 错误留在确认层里）。
  const beforeConfirmPosts = apiLog.filter((row) => row.method === 'POST' && row.path === '/session-superagent/watch').length
  const confirmClick = await dockClickButton('确认删除', '确认删除')
  let confirmErrorShown = false
  if (confirmClick.clicked) {
    try {
      await page.waitForFunction((selector) => {
        const error = document.querySelector(selector + ' .dt-error')
        return Boolean(error && error.textContent.includes('删除失败'))
      }, confirmModalSelector, { timeout: 3000 })
      confirmErrorShown = true
    } catch {}
  }
  const confirmClicked = await page.evaluate((selector) => {
    const modal = document.querySelector(selector)
    const error = modal?.querySelector('.dt-error')
    const button = [...(modal?.querySelectorAll('.dt-modal-footer button') || [])].find((node) => node.textContent === '确认删除')
    return {
      error: error?.textContent || null,
      errorRole: error?.getAttribute('role') || null,
      buttonText: button?.textContent || null,
      buttonBusy: button?.getAttribute('aria-busy') || null,
      modalPresent: Boolean(modal),
    }
  }, confirmModalSelector)
  const confirmPosts = apiLog.filter((row) => row.method === 'POST' && row.path === '/session-superagent/watch')
  check('Issue #35 dock「确认删除」真实可点：点击真的发出唯一一次 delete，403 错误留在确认层里',
    confirmClick.clicked && confirmErrorShown && confirmClicked.modalPresent
    && confirmPosts.length === beforeConfirmPosts + 1
    && confirmPosts.at(-1)?.body.includes('"action":"delete"')
    && confirmClicked.errorRole === 'alert',
    { confirmClick, confirmClicked, confirmPosts: confirmPosts.length })

  // 真实鼠标点「取消」：确认层关闭、dock 圆环拿回焦点、orbit surface 不重开。
  const cancelClick = await dockClickButton('取消', '取消')
  const cancelClosed = cancelClick.clicked ? await waitDockConfirmClosed() : false
  if (cancelClosed) {
    try {
      await page.waitForFunction((selector) => document.activeElement === document.querySelector(selector), dockTrigger, { timeout: 3000 })
    } catch {}
  }
  const dockCancelled = await dockFocus()
  check('Issue #35 dock「取消」真实可点：关闭确认层并回焦圆环，不重开 surface',
    cancelClick.clicked && cancelClosed && !dockCancelled.modalPresent
    && !dockCancelled.orbitPresent && dockCancelled.activeIsTrigger
    && dockCancelled.activeConnected && dockCancelled.expanded === 'false',
    { cancelClick, cancelClosed, dockCancelled })

  // Escape：真实按键关闭确认层，同样回焦圆环。取消都没关掉时不再往下叠步骤（避免点被遮住的控件）。
  let dockEscaped = null
  if (cancelClosed) {
    await openDockOrbit()
    await openDockConfirm()
    await page.keyboard.press('Escape')
    const escapeClosed = await waitDockConfirmClosed()
    if (escapeClosed) {
      try {
        await page.waitForFunction((selector) => document.activeElement === document.querySelector(selector), dockTrigger, { timeout: 3000 })
      } catch {}
    }
    dockEscaped = await dockFocus()
    check('Issue #35 dock 确认层 Escape 关闭并回焦圆环',
      escapeClosed && !dockEscaped.modalPresent && !dockEscaped.orbitPresent
      && dockEscaped.activeIsTrigger && dockEscaped.activeConnected, dockEscaped)
  } else {
    check('Issue #35 dock 确认层 Escape 关闭并回焦圆环', false, { skipped: '取消未能关闭确认层，Escape 步骤未执行' })
  }

  // 1440 宽复核一次几何：同一份 DOM 在常规桌面视口下仍完整显示、footer 可点。
  let dockDesktop = null
  if (dockEscaped && !dockEscaped.modalPresent) {
    await page.cdp('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false })
    await page.waitForTimeout(250)
    await openDockOrbit()
    await openDockConfirm()
    dockDesktop = await dockGeometry()
    writeFileSync(join(ISSUE35_ARTIFACTS, 'dock-confirm-geometry-desktop.json'), JSON.stringify({ phase: 'desktop-1440', dockDesktop }, null, 2))
    await issue35Shot('issue35-dock-confirm-dark-1440.png')
    check('Issue #35 dock 确认层在 1440 宽仍完整显示且 footer 可点', dockDesktop.rootParent === 'BODY'
      && dockDesktop.cancelInViewport && dockDesktop.confirmInViewport
      && dockDesktop.cancelHitIsButton && dockDesktop.confirmHitIsButton, dockDesktop)
    await dockClickButton('取消', '取消')
    await waitDockConfirmClosed()
  } else {
    check('Issue #35 dock 确认层在 1440 宽仍完整显示且 footer 可点', false, { skipped: '前一步未关闭确认层，桌面复核未执行' })
  }
  if (issue35Shots.length >= 2) {
    check('Issue #35 深浅窄屏截图各一张', issue35Shots.some((path) => path.includes('dark'))
      && issue35Shots.some((path) => path.includes('light')), issue35Shots.map((path) => path.replace(`${REPO}/`, '')))
  } else {
    observe('Issue #35 截图未齐', issue35Shots)
  }
  if (deskCaptures.length === 8) {
    check('四个主页面与五个设置分区截图共八张', true, deskCaptures)
  } else {
    console.log(`SKIP desk 截图总数 ${deskCaptures.length}/8；功能检查已完成，不把 CDP 截图通道记为产品 FAIL`)
    observe('desk 截图未齐；既有仓库基线未覆盖', deskCaptures)
  }
  const orbitArtifacts = artifacts.filter((path) => /deep-ui-orbit/.test(path))
  if (orbitArtifacts.length === 2) {
    check('Orbit 与确认 Modal 截图共两张', true, orbitArtifacts.map((path) => path.replace(`${REPO}/`, '')))
  } else {
    console.log(`SKIP Orbit/Modal 截图总数 ${orbitArtifacts.length}/2；功能检查已完成，不把 CDP 截图通道记为产品 FAIL`)
    observe('Orbit/Modal 截图未齐', orbitArtifacts.map((path) => path.replace(`${REPO}/`, '')))
  }
  completed = true
  if (results.some((row) => !row.pass)) process.exitCode = 1
} catch (error) {
  debug(`VERIFY_ERROR ${String(error && error.stack || error)}`)
  console.error('VERIFY_ERROR', error)
  check('脚本执行完成', false, String(error && error.stack || error))
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
  process.exitCode = 1
} finally {
  const summary = {
    passed: results.filter((row) => row.pass).length,
    failed: results.filter((row) => !row.pass).length,
    total: results.length,
    chromium,
    repoVersion: repoPackage.version,
    clientSha256,
    scriptSha256,
    frontendVersion: installed.frontendVersion,
    asarSha256: installed.asarSha256,
    exitCode: process.exitCode || 0,
    checks: results,
    screenshots: artifacts.map((path) => ({
      path: path.replace(`${REPO}/`, ''),
      bytes: readFileSync(path).length,
      sha256: sha256(readFileSync(path)),
    })),
    deskCaptures,
    screenshotSkips: observations.filter((row) => row.name.includes('截图') && (row.detail?.error || row.detail?.reason)),
    apiLog,
    unverified,
  }
  debug(`SUMMARY ${JSON.stringify(summary, null, 2)}`)
  console.log(`SUMMARY ${JSON.stringify(summary, null, 2)}`)
  const closing = new Promise((resolve) => server.close(resolve))
  server.closeAllConnections?.()
  await closing
  if (completed) await task.finish({ keep: [] })
  else console.log(`TASK_SPACE_KEPT ${task.spaceId}（脚本异常，保留未完成现场）`)
}
