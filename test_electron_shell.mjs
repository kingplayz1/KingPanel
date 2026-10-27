/**
 * Electron desktop-shell verification (run while the app is launched with
 * --remote-debugging-port=9222):
 *
 *   node test_electron_shell.mjs
 *
 * Verifies, against the REAL renderer inside Electron:
 *   1. The preload bridge (window.electronic / window.electronicState) exists
 *   2. minimize() actually minimizes the OS window
 *   3. maximize() toggles and state syncs back over IPC
 *   4. The title-bar close button exists and opens the exit modal
 *   5. Ticking "Hide to Tray" hides the window while the app keeps running
 *
 * Exits 0 when every assertion passes, 1 otherwise.
 */
const DEBUG_BASE = process.env.CDP_BASE || 'http://127.0.0.1:9222';
const APP_HOST = process.env.APP_HOST || '127.0.0.1';

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} :: ${name}${detail === undefined ? '' : ' :: ' + JSON.stringify(detail)}`);
}

const list = await (await fetch(`${DEBUG_BASE}/json/list`)).json();
// The panel window: any http://127.0.0.1:<port> page (the port is resolved at
// runtime when 3000 is occupied by another application).
const page = list.find((t) => t.type === 'page' && t.url.includes(APP_HOST));
if (!page) {
  console.error('No page target for ' + APP_HOST + '; targets: ' + list.map((t) => t.type + ':' + t.url).join(' | '));
  process.exit(1);
}
console.log('panel window: ' + page.url);

const ws = new WebSocket(page.webSocketDebuggerUrl);
let msgId = 0;
const pending = new Map();
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) {
    pending.get(m.id)(m);
    pending.delete(m.id);
  }
};
await new Promise((res, rej) => {
  ws.onopen = res;
  ws.onerror = rej;
});

const send = (method, params) =>
  new Promise((res) => {
    const i = ++msgId;
    pending.set(i, res);
    ws.send(JSON.stringify({ id: i, method, params }));
  });

const ev = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.result?.exceptionDetails) {
    return { __exception: r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text };
  }
  return r.result?.result?.value;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 0. The served UI really is the panel (not another app sharing the port)
const title = await ev('document.title');
check('served page is the KingPanel UI', typeof title === 'string' && title.includes('KingPanel'), { title });

// 1. Preload bridge present
const bridge = await ev('({ electronic: typeof window.electronic, state: typeof window.electronicState, close: typeof window.electronic?.close, tray: typeof window.electronic?.hideToTray, quit: typeof window.electronic?.quit, onStateChange: typeof window.electronic?.onStateChange })');
check('preload bridge exposes electronic + electronicState', bridge?.electronic === 'object' && bridge?.state === 'object', bridge);

// 2. minimize is real
const min = await ev('(async () => { await window.electronic.minimize(); await new Promise(r => setTimeout(r, 900)); return { minimized: window.electronicState.isMinimized() }; })()');
check('minimize() minimizes the OS window', min?.minimized === true, min);

// 3. maximize toggles and syncs back
const max = await ev('(async () => { await window.electronic.minimize(); await new Promise(r => setTimeout(r, 500)); await window.electronic.maximize(); await new Promise(r => setTimeout(r, 800)); const a = window.electronicState.isMaximized(); await window.electronic.maximize(); await new Promise(r => setTimeout(r, 800)); const b = window.electronicState.isMaximized(); return { afterMax: a, afterRestore: b }; })()');
check('maximize() toggles and state syncs back over IPC', max?.afterMax === true && max?.afterRestore === false, max);

// 4. Title-bar close button opens the exit modal
const btn = await ev('(() => { const b = document.querySelector(\'[title="Close Window"]\'); if (!b) return { found: false }; b.click(); return { found: true }; })()');
check('title-bar close button present in DOM', btn?.found === true, btn);
await sleep(700);
const modal = await ev('({ open: document.body.innerText.includes("Exit KingPanel"), hideBtn: Array.from(document.querySelectorAll("button")).some(b => b.innerText.includes("Hide to Tray")), quitBtn: Array.from(document.querySelectorAll("button")).some(b => b.innerText.includes("Quit KingPanel")) })');
check('exit modal opens with Hide-to-Tray + Quit actions', modal?.open === true && modal?.hideBtn === true && modal?.quitBtn === true, modal);

// 5. Hide to tray hides the window while the renderer stays alive
const hide = await ev('(async () => { const b = Array.from(document.querySelectorAll("button")).find(x => x.innerText.includes("Hide to Tray")); if (!b) return { err: "no button" }; b.click(); await new Promise(r => setTimeout(r, 900)); return { visible: window.electronicState.isVisible(), stillAlive: typeof window.electronic === "object" }; })()');
check('Hide to Tray hides window, app stays alive', hide?.visible === false && hide?.stillAlive === true, hide);

ws.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
