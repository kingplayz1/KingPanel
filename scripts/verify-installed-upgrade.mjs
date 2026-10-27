#!/usr/bin/env node
/**
 * Installed-app upgrade check: install an older build, let it discover and
 * download a newer one, install that, then prove the user can still log in and
 * still has their server files.
 *
 * This is a release gate that cannot run in `npm test`: it needs two real NSIS
 * installers, a Windows desktop session and ~2 minutes of wall clock. Run it
 * before publishing a sign-off build.
 *
 * Prerequisites — two installers whose app-update.yml points at the local feed
 * this script serves (see .tmp/e2e/builder-test*.json, which sets
 * nsis.perMachine=false so no elevation is needed and publish=generic):
 *
 *   npm version 1.0.0 --no-git-tag-version
 *   npx electron-builder --win --x64 --publish never --config <test-config-1.0.0>
 *   npm version 1.0.1 --no-git-tag-version
 *   npx electron-builder --win --x64 --publish never --config <test-config-1.0.1>
 *
 *   node scripts/verify-installed-upgrade.mjs \
 *     --from .tmp/e2e/v100 --to .tmp/e2e/v101 \
 *     --install-dir "E:\\temp\\IS King Panel" \
 *     [--legacy-data]   also place a server folder inside the install dir, the
 *                       way a pre-1.0.1 build did, and report its fate
 *
 * Exits non-zero on the first failed assertion; every check is logged.
 */
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// The install-time rescue writes next to Electron's userData, which is
// %APPDATA%\<package.json name>.
const PKG_NAME = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).name;
const WORK = path.join(ROOT, '.tmp', 'upgrade-e2e');
const USER_DATA = path.join(WORK, 'userdata');
const LOGS = path.join(WORK, 'logs');
const FEED_PORT = 8899;
const APP_PORT = 4777;
const MARKER = 'UPGRADE-E2E-MARKER';
const USER = 'upgrade_probe';
const PASS = 'Probe#Pass2026';

function arg(name, fallback = null) {
  const i = process.argv.indexOf(name);
  return i === -1 ? fallback : (process.argv[i + 1] ?? fallback);
}
const flag = (name) => process.argv.includes(name);

const FROM_DIR = path.resolve(ROOT, arg('--from', '.tmp/e2e/v100'));
const TO_DIR = path.resolve(ROOT, arg('--to', '.tmp/e2e/v101'));
const INSTALL_DIR = path.resolve(arg('--install-dir', path.join('E:\\temp', 'IS King Panel')));
const LEGACY = flag('--legacy-data');

const failures = [];
function check(label, ok, detail = '') {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures.push(label);
  return ok;
}
const sha = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

function readYamlFlat(file) {
  // latest.yml is a fixed, tiny shape; a full YAML parser is not worth adding
  // as a runtime dependency for a test script.
  const text = fs.readFileSync(file, 'utf8');
  const version = /^version:\s*(.+)$/m.exec(text)?.[1]?.trim();
  const url = /^\s*-\s*url:\s*(.+)$/m.exec(text)?.[1]?.trim();
  return { version, url };
}

function installerIn(dir) {
  const name = fs.readdirSync(dir).find((f) => f.endsWith('.exe') && !f.includes('uninstaller'));
  if (!name) throw new Error(`no installer in ${dir}`);
  return path.join(dir, name);
}

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

const cookieOf = (res) => (res.headers.getSetCookie?.() || []).map((c) => c.split(';')[0]).join('; ');

async function api(port, route, { method = 'GET', body, cookie } = {}) {
  const res = await fetch(`http://127.0.0.1:${port}${route}`, {
    method,
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { cookie } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: await res.json().catch(() => ({})), cookie: cookieOf(res) };
}

function killImage(image) {
  const list = spawnSync('tasklist', ['/FI', `IMAGENAME eq ${image}`, '/NH'], { encoding: 'utf8' });
  const pids = [...(list.stdout || '').matchAll(/\b(\d{4,})\b/g)].map((m) => m[1]);
  for (const pid of pids) spawnSync('taskkill', ['/F', '/PID', pid, '/T'], { stdio: 'ignore' });
  return pids.length;
}

async function waitForAppExit(timeoutMs = 20_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const list = spawnSync('tasklist', ['/FI', 'IMAGENAME eq IS King Panel.exe', '/NH'], { encoding: 'utf8' });
    if (!/IS King Panel\.exe/i.test(list.stdout || '')) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

// Windows keeps a directory busy for a moment after the uninstaller exits, and
// failing the whole run on that window makes the harness flaky rather than wrong.
async function removeDir(dir, timeoutMs = 20_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 700));
    }
  }
  fs.rmSync(dir, { recursive: true, force: true });
}

async function waitForBackend(port, timeoutMs = 180_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      await fetch(`http://127.0.0.1:${port}/api/auth/login`);
      return true;
    } catch {
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  return false;
}

function exePath() {
  return path.join(INSTALL_DIR, 'IS King Panel.exe');
}

function installedVersion() {
  const ps = spawnSync(
    'powershell',
    ['-NoProfile', '-Command', `(Get-Item '${exePath()}').VersionInfo.ProductVersion`],
    { encoding: 'utf8' },
  );
  return (ps.stdout || '').trim();
}

function launch(tag) {
  fs.mkdirSync(USER_DATA, { recursive: true });
  fs.mkdirSync(LOGS, { recursive: true });
  const log = path.join(LOGS, `${tag}.log`);
  const fd = fs.openSync(log, 'w');
  const child = spawn(exePath(), [`--user-data-dir=${USER_DATA}`], {
    cwd: INSTALL_DIR,
    detached: true,
    stdio: ['ignore', fd, fd],
    env: { ...process.env, PORT: String(APP_PORT), MONGODB_URI: '', DISCORD_BOT_TOKEN: '' },
  });
  child.unref();
  return { log, pid: child.pid };
}

const textOf = (file) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '');

// Module scope so the error path can release the port: an HTTP server keeps the
// event loop alive, and a harness that fails without closing it lingers forever
// and blocks the next run with EADDRINUSE.
let feedServer = null;

function startFeed(feedDir) {
  const types = { '.yml': 'text/yaml', '.exe': 'application/octet-stream', '.blockmap': 'application/octet-stream' };
  const server = http.createServer((req, res) => {
    const name = path.basename(decodeURIComponent((req.url || '/').split('?')[0]));
    const file = path.join(feedDir, name);
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
      res.writeHead(404).end('not found');
      return;
    }
    const { size } = fs.statSync(file);
    const type = types[path.extname(file)] ?? 'application/octet-stream';
    const range = req.headers.range;
    if (range) {
      const m = /bytes=(\d*)-(\d*)/.exec(range);
      const start = m?.[1] ? Number(m[1]) : 0;
      const end = m?.[2] ? Number(m[2]) : size - 1;
      res.writeHead(206, {
        'Content-Type': type,
        'Accept-Ranges': 'bytes',
        'Content-Range': `bytes ${start}-${end}/${size}`,
        'Content-Length': end - start + 1,
      });
      fs.createReadStream(file, { start, end }).pipe(res);
      return;
    }
    res.writeHead(200, { 'Content-Type': type, 'Content-Length': size, 'Accept-Ranges': 'bytes' });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => server.listen(FEED_PORT, '127.0.0.1', () => resolve(server)));
}

async function main() {
  fs.rmSync(WORK, { recursive: true, force: true });
  fs.mkdirSync(WORK, { recursive: true });

  const fromInstaller = installerIn(FROM_DIR);
  const toInstaller = installerIn(TO_DIR);
  const fromMeta = readYamlFlat(path.join(FROM_DIR, 'latest.yml'));
  const toMeta = readYamlFlat(path.join(TO_DIR, 'latest.yml'));
  const fromVersion = fromMeta.version;
  const toVersion = toMeta.version;
  if (!fromVersion || !toVersion || fromVersion === toVersion) {
    throw new Error(`need two different versions, got ${fromVersion} -> ${toVersion}`);
  }

  console.log(`\n=== Upgrade test: v${fromVersion} -> v${toVersion} ===`);
  console.log(`install:    ${INSTALL_DIR}`);
  console.log(`userData:   ${USER_DATA}`);
  console.log(`feed:       http://127.0.0.1:${FEED_PORT} (${TO_DIR})`);

  // ── install the old build ────────────────────────────────────────────────
  console.log(`\n[1/7] Installing v${fromVersion}`);
  killImage('IS King Panel.exe');
  await waitForAppExit();
  if (fs.existsSync(INSTALL_DIR)) {
    const uninstaller = fs.readdirSync(INSTALL_DIR).find((f) => /^Uninstall.*\.exe$/i.test(f));
    if (uninstaller) {
      spawnSync(path.join(INSTALL_DIR, uninstaller), ['/S'], { stdio: 'ignore' });
      await waitForAppExit();
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  await removeDir(INSTALL_DIR);
  const install = spawnSync(fromInstaller, ['/S', `/D=${INSTALL_DIR}`], { stdio: 'inherit' });
  if (install.status !== 0) throw new Error(`installer exited with ${install.status}`);
  check(`v${fromVersion} installed`, fs.existsSync(exePath()), exePath());
  check('installed version reported as the old build', installedVersion().startsWith(fromVersion), installedVersion());
  check(
    'shipped app-update.yml points at the test feed',
    textOf(path.join(INSTALL_DIR, 'resources', 'app-update.yml')).includes(String(FEED_PORT)),
    path.join(INSTALL_DIR, 'resources', 'app-update.yml'),
  );

  // ── seed user data and a server ──────────────────────────────────────────
  console.log(`\n[2/7] Starting v${fromVersion} and seeding an account + server`);
  let app = launch('before-update');
  if (!(await waitForBackend(APP_PORT))) throw new Error('backend never became ready');

  const register = await api(APP_PORT, '/api/auth/register', {
    method: 'POST',
    body: { username: USER, displayName: 'Upgrade Probe', email: 'upgrade@example.invalid', password: PASS, role: 'Root Admin' },
  });
  check('account created', register.status === 200 || register.status === 201, String(register.status));
  const login = await api(APP_PORT, '/api/auth/login', { method: 'POST', body: { identifier: USER, password: PASS } });
  check('login before update', login.status === 200, String(login.status));
  if (login.status !== 200) throw new Error('cannot seed without a session');

  const servers = await api(APP_PORT, '/api/servers', { cookie: login.cookie });
  const root = servers.json?.installRoot;
  const serverDir = path.join(root, 'Upgrade_Survival');
  fs.mkdirSync(path.join(serverDir, 'world'), { recursive: true });
  fs.writeFileSync(path.join(serverDir, 'server.properties'), `motd=${MARKER}\nserver-port=25599\n`);
  fs.writeFileSync(path.join(serverDir, 'e2e-marker.txt'), MARKER);
  fs.writeFileSync(path.join(serverDir, 'world', 'level.dat'), MARKER);
  const listed = (await api(APP_PORT, '/api/servers', { cookie: login.cookie })).json?.servers ?? [];
  check('server visible through the API', listed.some((s) => s.id === 'Upgrade_Survival'), `root=${root}`);

  if (LEGACY) {
    // A pre-1.0.1 build kept servers in the install directory. Windows replaces
    // that directory during an update, so this folder is destroyed wholesale
    // unless the installer preserves it first.
    const legacy = path.join(INSTALL_DIR, 'KingServers', 'Legacy_World');
    fs.mkdirSync(path.join(legacy, 'world'), { recursive: true });
    fs.writeFileSync(path.join(legacy, 'server.properties'), 'motd=legacy\nserver-port=25601\n');
    fs.writeFileSync(path.join(legacy, 'eula.txt'), 'eula=true\n');
    fs.writeFileSync(path.join(legacy, 'world', 'level.dat'), MARKER);
    console.log(`  seeded a legacy server inside the install dir at ${legacy}`);
  }

  const before = walk(USER_DATA).map((p) => ({ rel: path.relative(USER_DATA, p), size: fs.statSync(p).size }));
  killImage('IS King Panel.exe');
  await new Promise((r) => setTimeout(r, 2000));

  // ── serve the new release and let the old app find it ────────────────────
  console.log(`\n[3/7] Serving v${toVersion} on the update feed`);
  const feed = await startFeed(TO_DIR);
  feedServer = feed;
  const cacheRoot = path.join(process.env.LOCALAPPDATA ?? '', 'react-example-updater');
  fs.rmSync(cacheRoot, { recursive: true, force: true });

  console.log(`\n[4/7] Launching v${fromVersion}; expecting it to find v${toVersion}`);
  app = launch('update-check');
  if (!(await waitForBackend(APP_PORT))) throw new Error('backend never became ready');
  const log = app.log;

  let found = false;
  let cached = null;
  const deadline = Date.now() + 300_000;
  while (Date.now() < deadline) {
    const text = textOf(log);
    if (!found && text.includes('Update available')) {
      found = true;
      console.log('  updater announced an available update');
    }
    // electron-updater streams into "pending\temp-<name>" and renames when the
    // download completes, so a partial file must not be mistaken for the
    // finished installer (it is not runnable and its hash will not match).
    cached = walk(cacheRoot).find((f) => path.basename(f) === path.basename(toInstaller)) ?? null;
    if (cached) break;
    await new Promise((r) => setTimeout(r, 2000));
  }
  check('updater reported an update is available', found);
  check('new installer downloaded into the updater cache', Boolean(cached), cached ?? 'no cached installer');
  check('progress was reported', /Download \d+%/.test(textOf(log)), textOf(log).match(/Download \d+%/)?.[0] ?? 'none');

  const downloadedHash = cached ? sha(cached) : null;
  const expectedHash = sha(toInstaller);
  check('downloaded bytes match the served installer', downloadedHash === expectedHash, downloadedHash ? downloadedHash.slice(0, 16) : 'n/a');
  killImage('IS King Panel.exe');
  await new Promise((r) => setTimeout(r, 2000));

  // ── run the downloaded installer, as quitAndInstall does ────────────────
  console.log(`\n[5/7] Installing the downloaded update`);
  const update = spawnSync(cached, ['/S'], { stdio: 'inherit' });
  if (update.status !== 0) throw new Error(`update installer exited with ${update.status}`);
  await new Promise((r) => setTimeout(r, 3000));

  check('installed version is now the new build', installedVersion().startsWith(toVersion), installedVersion());

  if (LEGACY) {
    const staged = path.join(process.env.APPDATA ?? '', PKG_NAME, 'legacy-install-servers');
    const rescued = path.join(staged, 'Legacy_World', 'world', 'level.dat');
    check(
      'installer copied install-dir server data out before replacing the app',
      fs.existsSync(rescued) && fs.readFileSync(rescued, 'utf8').includes(MARKER),
      staged,
    );
    check(
      'install directory itself was replaced (the old location is gone)',
      !fs.existsSync(path.join(INSTALL_DIR, 'KingServers', 'Legacy_World')),
    );
    // The harness isolates userData, so move what the installer staged into the
    // folder the running app will read. In a real install the installer already
    // wrote it to exactly this location.
    if (fs.existsSync(staged)) {
      fs.cpSync(staged, path.join(USER_DATA, 'legacy-install-servers'), { recursive: true });
      fs.rmSync(staged, { recursive: true, force: true });
    }

    // A 1.0.0 user who ever saved settings has the old default (a folder inside
    // the app directory) persisted. Writing new servers there would just queue
    // up the same data loss for the next update.
    fs.mkdirSync(path.join(USER_DATA, 'database'), { recursive: true });
    fs.writeFileSync(
      path.join(USER_DATA, 'database', '.local-install-config.json'),
      JSON.stringify(
        {
          installRootDir: path.join(INSTALL_DIR, 'KingServers'),
          autoCreateSubfolders: true,
          autoAcceptEula: true,
          updatedAt: new Date().toISOString(),
        },
        null,
        2,
      ),
    );
  }

  // ── is the app still usable? ─────────────────────────────────────────────
  console.log(`\n[6/7] Relaunching v${toVersion} and checking the user's data`);
  app = launch('after-update');
  if (!(await waitForBackend(APP_PORT))) throw new Error('backend never became ready after the update');

  const relogin = await api(APP_PORT, '/api/auth/login', { method: 'POST', body: { identifier: USER, password: PASS } });
  check('account still logs in', relogin.status === 200, String(relogin.status));

  const after = await api(APP_PORT, '/api/servers', { cookie: relogin.cookie });
  const row = (after.json?.servers ?? []).find((s) => s.id === 'Upgrade_Survival');
  check('server still registered', Boolean(row), row ? `port=${row.port}` : 'missing');

  if (LEGACY) {
    const resolvedRoot = path.resolve(after.json?.installRoot ?? '');
    const insideApp = resolvedRoot.toLowerCase().startsWith(INSTALL_DIR.toLowerCase());
    check('saved install root inside the app folder was moved to user data', !insideApp, resolvedRoot);
  }

  const files = ['server.properties', 'e2e-marker.txt', path.join('world', 'level.dat')];
  for (const rel of files) {
    const p = path.join(serverDir, rel);
    check(`server file intact: ${rel}`, fs.existsSync(p) && fs.readFileSync(p, 'utf8').includes(MARKER));
  }

  const now = walk(USER_DATA).map((p) => ({ rel: path.relative(USER_DATA, p), size: fs.statSync(p).size }));
  const lost = before.filter((b) => !now.some((n) => n.rel === b.rel));
  check('no userData files removed by the update', lost.length === 0, lost.map((f) => f.rel).join(', '));

  if (LEGACY) {
    const recoveredRoot = after.json?.installRoot;
    const recovered = (after.json?.servers ?? []).find((s) => s.id === 'Legacy_World');
    check('old install-dir server was imported into the app data folder', Boolean(recovered), recovered?.id ?? 'missing');
    const recoveredWorld = path.join(recoveredRoot ?? '', 'Legacy_World', 'world', 'level.dat');
    check(
      'imported server kept its world files',
      fs.existsSync(recoveredWorld) && fs.readFileSync(recoveredWorld, 'utf8').includes(MARKER),
      recoveredWorld,
    );
  }

  // ── updater must not claim success when it is current ────────────────────
  console.log(`\n[7/7] Checking the new build reports itself up to date`);
  killImage('IS King Panel.exe');
  await new Promise((r) => setTimeout(r, 1500));
  app = launch('up-to-date-check');
  if (!(await waitForBackend(APP_PORT))) throw new Error('backend never became ready for the final check');
  const upToDate = Date.now() + 120_000;
  let reported = false;
  while (Date.now() < upToDate) {
    const text = textOf(app.log);
    if (text.includes('Up to date') || text.includes('update-not-available')) {
      reported = true;
      break;
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  check('reports "up to date" once the newest version is installed', reported);
  killImage('IS King Panel.exe');
  // The feed has to stay up until here: the final launch reads it to decide it
  // is current. Closing it earlier turned this check into a network error.
  feed.close();

  console.log(`\n${failures.length === 0 ? 'RESULT: PASS' : `RESULT: FAIL (${failures.length})`}`);
  for (const f of failures) console.log(`  - ${f}`);
  process.exitCode = failures.length === 0 ? 0 : 1;
}

main().catch((err) => {
  console.error(`\n[upgrade-e2e] ERROR: ${err instanceof Error ? err.message : err}`);
  // Never leave a half-tested panel running, or a feed server holding its port:
  // both would block or mislead the next run.
  killImage('IS King Panel.exe');
  feedServer?.close();
  process.exitCode = 1;
});
