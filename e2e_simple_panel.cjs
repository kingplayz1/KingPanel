/**
 * Temporary end-to-end check for the simple panel pages.
 * Runs the app in a hidden Electron window against the dev server on :3110 and
 * asserts the DOM state after real UI clicks.
 */
const { app, BrowserWindow } = require('electron');

const BASE = process.env.E2E_BASE || 'http://127.0.0.1:3111';
const TARGET = process.env.E2E_SERVER || 'JarTestServer';
const results = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const record = (name, ok, detail) => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} — ${name}${detail ? ` :: ${detail}` : ''}`);
};

async function main() {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  const wc = win.webContents;
  const errors = [];
  wc.on('console-message', (_e, level, message) => {
    if (level >= 2) errors.push(message);
  });

  await win.loadURL(BASE);
  await sleep(2500);

  // Log in through the real API and mirror what the app stores on success.
  const login = await wc.executeJavaScript(`(async () => {
    const r = await fetch('/api/auth/login', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({identifier:'kingplayz', password:'kingpanel123'}) });
    const d = await r.json();
    if (d && d.ok) localStorage.setItem('king_panel_auth_user', JSON.stringify(d.user));
    return { status: r.status, ok: !!d.ok };
  })()`);
  record('login API succeeds', login.status === 200 && login.ok, JSON.stringify(login));
  win.reload();
  await sleep(3500);

  const list = await wc.executeJavaScript(`({
    hasServerList: (document.body.innerText||'').includes('Created Server List'),
    hasDesktopTitleBar: (document.body.innerText||'').includes('v4.8 Localhost Engine'),
    hasWindowControls: !!document.querySelector('button[title="Minimize"]'),
    servers: Array.from(document.querySelectorAll('div')).some(d => (d.innerText||'').includes('${TARGET}')),
  })`);
  record('simple server list renders', list.hasServerList === true, JSON.stringify(list));
  record('desktop title bar hidden on simple page', list.hasDesktopTitleBar === false);
  record('window controls present on simple page', list.hasWindowControls === true);
  record('real server listed', list.servers === true);

  // Open the simple panel for the real test server.
  const opened = await wc.executeJavaScript(`(() => {
    const rows = Array.from(document.querySelectorAll('div')).filter(d => (d.innerText||'').includes('${TARGET}') && (d.innerText||'').includes('Simple Panel'));
    const row = rows[rows.length - 1];
    if (!row) return 'row-missing';
    const btn = Array.from(row.querySelectorAll('button')).find(b => (b.innerText||'').includes('Simple Panel'));
    if (!btn) return 'button-missing';
    btn.click();
    return 'clicked';
  })()`);
  record('Simple Panel button clickable', opened === 'clicked', opened);
  await sleep(2000);

  const simplePanel = await wc.executeJavaScript(`({
    hasLiveConsole: (document.body.innerText||'').includes('Live Console'),
    hasLiveStatus: (document.body.innerText||'').includes('Live Status'),
    hasRepair: (document.body.innerText||'').includes('Reinstall / repair server.jar'),
    hasDesktopTitleBar: (document.body.innerText||'').includes('v4.8 Localhost Engine'),
    hasWindowControls: !!document.querySelector('button[title="Minimize"]'),
    showsJarTest: (document.body.innerText||'').includes('${TARGET}'),
  })`);
  record('simple server page renders', simplePanel.hasLiveConsole && simplePanel.hasLiveStatus, JSON.stringify(simplePanel));
  record('simple page hides desktop title bar', simplePanel.hasDesktopTitleBar === false);
  record('simple page keeps window controls', simplePanel.hasWindowControls === true);
  record('jar repair action present', simplePanel.hasRepair === true);

  // Start the real server from the simple page.
  const start = await wc.executeJavaScript(`(() => {
    const btn = Array.from(document.querySelectorAll('button')).find(b => (b.innerText||'').trim().endsWith('Start'));
    if (!btn) return 'start-missing';
    btn.click();
    return 'clicked';
  })()`);
  record('Start button clickable', start === 'clicked', start);

  let running = { ok: false, lines: 0, status: '' };
  for (let i = 0; i < 24; i++) {
    await sleep(5000);
    running = await wc.executeJavaScript(`({
      ok: (document.body.innerText||'').includes('RUNNING'),
      status: (document.body.innerText||'').includes('RUNNING') ? 'RUNNING' : 'other',
      lines: document.querySelectorAll('div.font-mono').length,
      hasPaperBoot: /Paper|Done \\(|Starting minecraft server/i.test(document.body.innerText||'')
    })`);
    if (running.ok && running.hasPaperBoot) break;
  }
  record('server reaches RUNNING from simple page', running.ok === true, JSON.stringify(running));
  record('live console shows real server output', running.hasPaperBoot === true);

  // Stop it again and confirm the page reflects it.
  const stop = await wc.executeJavaScript(`(() => {
    const btn = Array.from(document.querySelectorAll('button')).find(b => (b.innerText||'').trim().endsWith('Stop'));
    if (!btn) return 'stop-missing';
    btn.click();
    return 'clicked';
  })()`);
  record('Stop button clickable', stop === 'clicked', stop);

  let stopped = false;
  for (let i = 0; i < 12; i++) {
    await sleep(2500);
    stopped = await wc.executeJavaScript(`(document.body.innerText||'').includes('STOPPED')`);
    if (stopped) break;
  }
  record('server stops again', stopped === true);

  // Back to the list, then into the advanced panel (title bar must return).
  const debug = await wc.executeJavaScript(`({
    titles: Array.from(document.querySelectorAll('button')).map(b => b.getAttribute('title')).filter(Boolean),
    hasBackTitle: !!document.querySelector('button[title="Back to server list"]'),
    hasList: (document.body.innerText||'').includes('Created Server List'),
    hasLiveConsole: (document.body.innerText||'').includes('Live Console'),
    buttons: Array.from(document.querySelectorAll('button')).map(b => (b.innerText||'').trim()).filter(Boolean).slice(0, 14),
  })`);
  console.log('DEBUG before back:', JSON.stringify(debug));
  const back = await wc.executeJavaScript(`(() => {
    const btn = document.querySelector('button[title="Back to server list"]');
    if (!btn) return 'back-missing';
    btn.click();
    return 'clicked';
  })()`);
  record('back to server list', back === 'clicked', back);
  await sleep(1500);

  const advanced = await wc.executeJavaScript(`(() => {
    const rows = Array.from(document.querySelectorAll('div')).filter(d => (d.innerText||'').includes('${TARGET}') && (d.innerText||'').includes('Advanced Panel'));
    const row = rows[rows.length - 1];
    if (!row) return 'row-missing';
    const btn = Array.from(row.querySelectorAll('button')).find(b => (b.innerText||'').includes('Advanced Panel'));
    if (!btn) return 'button-missing';
    btn.click();
    return 'clicked';
  })()`);
  record('Advanced Panel button clickable', advanced === 'clicked', advanced);
  await sleep(2500);

  const advancedView = await wc.executeJavaScript(`({
    hasTitleBar: (document.body.innerText||'').includes('v4.8 Localhost Engine'),
    hasSidebar: !!document.querySelector('aside, nav'),
  })`);
  record('advanced panel shows desktop title bar', advancedView.hasTitleBar === true, JSON.stringify(advancedView));

  console.log('\nconsole errors:', errors.length ? errors.slice(0, 5) : 'none');
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  app.exit(failed.length === 0 ? 0 : 1);
}

app.whenReady().then(() =>
  main().catch((err) => {
    console.error('E2E ERROR', err);
    app.exit(2);
  })
);
