/**
 * UI-driven check of the simple pre-panel "Create Server" setup flow:
 * fill the real form, submit, and assert the backend created the folder
 * and installed server.jar (what the setup system promises).
 */
const { app, BrowserWindow } = require('electron');

const BASE = process.env.E2E_BASE || 'http://127.0.0.1:3000';
const NAME = process.env.E2E_CREATE_NAME || 'UISetupTest';
const results = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const record = (name, ok, detail) => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'} — ${name}${detail ? ` :: ${detail}` : ''}`);
};

async function main() {
  const win = new BrowserWindow({ width: 1440, height: 900, show: false });
  const wc = win.webContents;
  const errors = [];
  wc.on('console-message', (_e, level, message) => {
    if (level >= 2 && !/Security Warning/.test(message)) errors.push(message);
  });

  await win.loadURL(BASE);
  await sleep(2500);
  const login = await wc.executeJavaScript(`(async () => {
    const r = await fetch('/api/auth/login', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({identifier:'kingplayz', password:'kingpanel123'}) });
    const d = await r.json();
    if (d && d.ok) localStorage.setItem('king_panel_auth_user', JSON.stringify(d.user));
    return !!(d && d.ok);
  })()`);
  record('login succeeds', login === true);
  win.reload();
  await sleep(3500);

  const before = await wc.executeJavaScript(`(async () => {
    const r = await fetch('/api/servers'); const d = await r.json();
    return { count: d.servers.length, exists: d.servers.some(s => s.name === '${NAME}' || s.id === '${NAME}') };
  })()`);
  if (before.exists) {
    record('test server not already present', false, 'UISetupTest already exists — clean it first');
    finish(errors);
    return;
  }

  const opened = await wc.executeJavaScript(`(() => {
    const btn = Array.from(document.querySelectorAll('button')).find(b => (b.innerText||'').includes('Create Server'));
    if (!btn) return 'button-missing: ' + JSON.stringify(Array.from(document.querySelectorAll('button')).map(b => (b.innerText||'').trim().replace(/\\n/g,'|')).slice(0, 20));
    btn.click(); return 'clicked';
  })()`);
  record('Create Server button clickable', opened === 'clicked', opened);
  await sleep(800);

  const filled = await wc.executeJavaScript(`(() => {
    const modal = Array.from(document.querySelectorAll('div')).find(d => (d.innerText||'').includes('Create New Minecraft Server'));
    if (!modal) return 'modal-missing';
    const input = modal.querySelector('input[type="text"][placeholder^="Survival Server"]');
    if (!input) return 'name-input-missing';
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(input, '${NAME}');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return 'filled';
  })()`);
  record('name field accepts input', filled === 'filled', filled);
  await sleep(300);

  const submitted = await wc.executeJavaScript(`(() => {
    const btn = Array.from(document.querySelectorAll('button[type="submit"]')).find(b => (b.innerText||'').includes('Create Server'));
    if (!btn || btn.disabled) return 'submit-missing-or-disabled';
    btn.click(); return 'clicked';
  })()`);
  record('submit clicked', submitted === 'clicked', submitted);

  // Wait for deploy: modal closes + backend reports the folder with jar installed.
  let created = { modalClosed: false, exists: false, hasJar: false, toast: '' };
  for (let i = 0; i < 30; i++) {
    await sleep(2000);
    created = await wc.executeJavaScript(`(async () => {
      const body = document.body.innerText || '';
      const r = await fetch('/api/servers'); const d = await r.json();
      const srv = d.servers.find(s => s.name === '${NAME}' || s.id === '${NAME}');
      const toast = /server.jar Installed/.test(body) ? 'jar-installed-toast'
        : /server.jar Not Installed/.test(body) ? 'jar-failed-toast' : '';
      return {
        modalClosed: !Array.from(document.querySelectorAll('h3')).some(h => (h.innerText||'').includes('Create New Minecraft Server')),
        exists: !!srv, hasJar: !!(srv && srv.hasJar), toast,
        listed: body.includes('${NAME}'),
      };
    })()`);
    if (created.exists && created.hasJar) break;
  }
  record('server created via UI form', created.exists === true, JSON.stringify(created));
  record('server.jar installed by setup', created.hasJar === true, JSON.stringify(created));
  record('success toast shown', created.toast === 'jar-installed-toast', created.toast);
  record('new server visible in list UI', created.listed === true);
  record('modal closed after create', created.modalClosed === true);

  finish(errors);
}

function finish(errors) {
  console.log('console errors:', errors.length ? JSON.stringify(errors.slice(0, 5)) : 'none');
  const failed = results.filter((r) => !r.ok);
  console.log(`${results.length - failed.length}/${results.length} checks passed`);
  app.exit(failed.length === 0 ? 0 : 1);
}

app.whenReady().then(() =>
  main().catch((err) => {
    console.error('E2E ERROR', err);
    app.exit(2);
  })
);
