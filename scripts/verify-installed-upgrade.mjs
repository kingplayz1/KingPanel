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
 * this script serves. The newer side is normally the build being signed off
 * (`dist_electron`); the older side is generated, never hand-assembled:
 *
 *   node scripts/make-upgrade-fixtures.mjs --from-version 1.0.1
 *   node scripts/verify-installed-upgrade.mjs            # .tmp/e2e/v1.0.1 -> .tmp/e2e/v1.0.2
 *
 * The generator builds both throwaway installers with nsis.perMachine=false (no
 * elevation) and publish=generic pointing at this script's feed, and records
 * where each came from in fixture.json. Nothing reads a developer-specific path.
 *
 * The real release installer is per-machine, so installing it silently needs
 * elevation — which this harness deliberately never uses. The upgrade path is
 * therefore exercised with the same code packaged per-user; the elevation
 * prompt and the per-machine install directory are not covered here.
 *
 * Isolation: the installed app and both installers run with APPDATA and
 * LOCALAPPDATA redirected into .tmp/upgrade-e2e, so an NSIS hook or an updater
 * cache can never touch the real profile, and processes are matched by their
 * path inside the install directory so the panel the developer has open is left
 * alone. Real user data is not read, moved or deleted anywhere in this file.
 *
 *   [--legacy-data]   also place a server folder inside the install dir, the
 *                     way a pre-1.0.1 build did, and report its fate
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
const PKG = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const PKG_NAME = PKG.name;
const WORK = path.join(ROOT, '.tmp', 'upgrade-e2e');
const USER_DATA = path.join(WORK, 'userdata');
const LOGS = path.join(WORK, 'logs');
// The installers and the app under test see these instead of the real profile.
// NSIS hooks write to $APPDATA, and electron-updater caches under %LOCALAPPDATA%.
const ISOLATED_APPDATA = path.join(WORK, 'appdata');
const ISOLATED_LOCALAPPDATA = path.join(WORK, 'localappdata');
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

// Defaults track the current release pair: the previous version and the build
// being signed off. Override them for any other upgrade path, but keep them in
// step with dist_electron — a stale default silently tests an ancient build.
// FROM tracks the last released version, i.e. exactly what
// `npm run fixtures:upgrade -- --from-version <that version>` produces. Bump it
// when a release ships; a stale default tests a build nobody can install.
const FROM_DIR = path.resolve(ROOT, arg('--from', '.tmp/e2e/v1.0.1'));
// TO is the candidate version as a per-user fixture, which the generator writes
// next to FROM. Derived from package.json so it cannot go stale, and not
// dist_electron: that installer is per-machine and cannot be installed without
// an elevation prompt this harness must not trigger.
const TO_DIR = path.resolve(ROOT, arg('--to', path.join('.tmp', 'e2e', `v${PKG.version}`)));
// Each run installs into its own directory. An NSIS uninstaller copies itself to
// %TEMP% and keeps deleting after the launcher has returned, so a run that reused
// one fixed path could have its fresh install deleted underneath it by the
// previous run's helper. A per-run path makes that impossible; old run
// directories are cleared at the start of the next run.
const RUN_TAG = new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14);
const RUN_DIR = path.join(WORK, `run-${RUN_TAG}`);
const INSTALL_DIR = arg('--install-dir')
  ? path.resolve(ROOT, arg('--install-dir'))
  : path.join(RUN_DIR, 'install');
const LEGACY = flag('--legacy-data');
// Debugging an upgrade failure usually means looking at the installed build, so
// cleanup can be skipped; by default the run leaves no installation behind.
const KEEP_INSTALLED = flag('--keep-installed');

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

const FIXTURE_HINT =
  'generate the older one with:\n' +
  '  node scripts/make-upgrade-fixtures.mjs --from-version <previous-version>\n' +
  'and point --to at dist_electron (or another directory holding a newer build).';

function installerIn(dir, label) {
  if (!fs.existsSync(dir)) {
    throw new Error(`the ${label} installer directory does not exist: ${dir}\n${FIXTURE_HINT}`);
  }
  const names = fs.readdirSync(dir);
  const name = names.find((f) => f.endsWith('.exe') && !f.includes('uninstaller'));
  if (!name) {
    throw new Error(`${dir} holds no installer (only: ${names.join(', ') || 'nothing'})\n${FIXTURE_HINT}`);
  }
  if (!names.includes('latest.yml')) {
    throw new Error(`${dir} has an installer but no latest.yml, so no version can be read\n${FIXTURE_HINT}`);
  }
  return path.join(dir, name);
}

/**
 * Refuse to run if any directory this test owns points into the real profile.
 *
 * A harness that installs, launches and force-kills an app is one typo away from
 * deleting something a person cares about, so the check is on paths we control
 * rather than on our own good intentions.
 */
function assertIsolated() {
  const real = [process.env.APPDATA, process.env.LOCALAPPDATA]
    .filter(Boolean)
    .map((dir) => path.resolve(dir).toLowerCase());
  const owned = [
    ['test userData', USER_DATA],
    ['install directory', INSTALL_DIR],
    ['isolated APPDATA', ISOLATED_APPDATA],
    ['isolated LOCALAPPDATA', ISOLATED_LOCALAPPDATA],
  ];
  for (const [label, dir] of owned) {
    const resolved = path.resolve(dir).toLowerCase();
    for (const realDir of real) {
      if (resolved === realDir || resolved.startsWith(`${realDir}${path.sep}`)) {
        throw new Error(
          `${label} (${dir}) is inside the real profile (${realDir}). ` +
            'This test would modify data it does not own; refusing to run.',
        );
      }
    }
  }
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

/**
 * Which files in the profile are the panel's own state.
 *
 * The Electron profile also holds Chromium's caches, Local Storage and its
 * leveldb scratch files (`*.dbtmp`), which come and go between launches on their
 * own. Counting those as "user data removed by the update" reports a data-loss
 * failure for a browser temp file, so the check is scoped to what the app owns:
 * the database, the server folders and the state files beside them.
 */
const APP_STATE_DIRS = ['database', 'KingServers', 'legacy-install-servers'];
const APP_STATE_FILE = /^(\.local-|\.panel-|\.state-migration|\.oauth-key|oauth-token-key\.dpapi|server_runtime\.json|FIRST-RUN-CREDENTIALS\.txt)/;

function isAppState(rel) {
  const [first] = rel.split(path.sep);
  if (APP_STATE_DIRS.includes(first)) return true;
  return !rel.includes(path.sep) && APP_STATE_FILE.test(rel);
}

/**
 * The app-owned subset of the profile, as {rel, size}.
 *
 * Filtered before stat() on purpose: Chromium deletes its own scratch files
 * while the app is running, and stating one mid-sweep throws ENOENT. Only files
 * the panel wrote are measured at all.
 */
function appStateFiles() {
  const entries = [];
  for (const abs of walk(USER_DATA)) {
    const rel = path.relative(USER_DATA, abs);
    if (!isAppState(rel)) continue;
    try {
      entries.push({ rel, size: fs.statSync(abs).size });
    } catch {
      // Gone between listing and stat — not ours, not relevant.
    }
  }
  return entries;
}

/**
 * Sign in as the bootstrap Super Admin.
 *
 * No password exists in the packaged app: a fresh install generates one and
 * appends it to FIRST-RUN-CREDENTIALS.txt next to the database, and an install
 * that still carries a published default gets that default rotated on the next
 * start (so the newest password line for the account is the one that works).
 *
 * The same file also collects account *recovery codes*, which are not passwords:
 * a line is only a password when its note does not say otherwise.
 */
function latestCredential(account, { password }) {
  const file = path.join(USER_DATA, 'database', 'FIRST-RUN-CREDENTIALS.txt');
  if (!fs.existsSync(file)) return null;
  const rows = fs
    .readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .map((line) => line.split('\t'))
    .filter((cols) => {
      if (cols.length < 2) return false;
      if (!new RegExp(`^${account}$`, 'i').test((cols[0] || '').trim())) return false;
      const note = (cols[2] || '').toLowerCase();
      const isRecoveryCode = note.includes('recovery code');
      return password ? !isRecoveryCode : isRecoveryCode;
    });
  return rows.at(-1) ?? null;
}

async function superAdminSession() {
  const latest = latestCredential('kingplayz', { password: true });
  if (!latest) return null;
  const login = await api(APP_PORT, '/api/auth/login', {
    method: 'POST',
    body: { identifier: latest[0].trim(), password: latest[1] },
  });
  return login.status === 200 ? login : null;
}

async function api(port, route, { method = 'GET', body, cookie } = {}) {
  const res = await fetch(`http://127.0.0.1:${port}${route}`, {
    method,
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { cookie } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: await res.json().catch(() => ({})), cookie: cookieOf(res) };
}

/**
 * Only the copies of the app that live in this test's install directory.
 *
 * Killing by image name would also kill the panel the developer has open on
 * their own machine, and whatever they were doing in it. Matching on the
 * executable path leaves other installs (and their data) untouched.
 */
function installedPids() {
  const script =
    `Get-CimInstance Win32_Process -Filter "Name='${path.basename(exePath())}'" | ` +
    'Select-Object ProcessId,ExecutablePath | ConvertTo-Json -Compress';
  const ps = spawnSync('powershell', ['-NoProfile', '-Command', script], { encoding: 'utf8' });
  const text = (ps.stdout || '').trim();
  if (!text) return [];
  let rows;
  try {
    rows = JSON.parse(text);
  } catch {
    return [];
  }
  const prefix = path.resolve(INSTALL_DIR).toLowerCase();
  return (Array.isArray(rows) ? rows : [rows])
    .filter(
      (row) =>
        typeof row?.ExecutablePath === 'string' &&
        path.resolve(row.ExecutablePath).toLowerCase().startsWith(`${prefix}${path.sep}`),
    )
    .map((row) => String(row.ProcessId));
}

function killInstalledApp() {
  const pids = installedPids();
  for (const pid of pids) spawnSync('taskkill', ['/F', '/PID', pid, '/T'], { stdio: 'ignore' });
  return pids.length;
}

async function waitForAppExit(timeoutMs = 20_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (installedPids().length === 0) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

async function waitForFile(file, timeoutMs = 60_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (fs.existsSync(file)) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  return fs.existsSync(file);
}

/**
 * Wait for the installed build to report a version.
 *
 * An update replaces files while Windows is still releasing the old ones, and the
 * installer can exit before the new executable has replaced the old one, so the
 * reported version lags the installer by a moment.
 */
async function waitForVersion(prefix, timeoutMs = 60_000) {
  const start = Date.now();
  let seen = installedVersion();
  while (Date.now() - start < timeoutMs) {
    seen = installedVersion();
    if (seen.startsWith(prefix)) return seen;
    await new Promise((r) => setTimeout(r, 1000));
  }
  return seen;
}

/**
 * Remove uninstall entries this harness left behind.
 *
 * An uninstaller that never ran leaves an HKCU entry pointing at a path inside the
 * work directory, and Windows then lists a panel that is not installed. Only
 * entries whose uninstaller lives inside this harness's tree *and* whose file is
 * gone are removed; any other installation's entry is left alone.
 */
function pruneOwnUninstallEntries() {
  const script =
    "Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*' " +
    '-ErrorAction SilentlyContinue | ' +
    'Where-Object { $_.DisplayName -like "*King Panel*" } | ' +
    'Select-Object PSChildName,UninstallString | ConvertTo-Json -Compress';
  const ps = spawnSync('powershell', ['-NoProfile', '-Command', script], { encoding: 'utf8' });
  const text = (ps.stdout || '').trim();
  if (!text) return [];
  let rows;
  try {
    rows = JSON.parse(text);
  } catch {
    return [];
  }
  const prefix = `${path.resolve(WORK).toLowerCase()}${path.sep}`;
  const removed = [];
  for (const row of Array.isArray(rows) ? rows : [rows]) {
    const match = /"([^"]+\.exe)"|(\S+\.exe)/.exec(String(row?.UninstallString ?? ''));
    const file = match?.[1] ?? match?.[2];
    if (!row?.PSChildName || !file) continue;
    if (!path.resolve(file).toLowerCase().startsWith(prefix)) continue; // another installation
    if (fs.existsSync(file)) continue; // still installed, not stale
    const key = `HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${row.PSChildName}`;
    if (spawnSync('reg', ['delete', key, '/f'], { stdio: 'ignore' }).status === 0) {
      removed.push(String(row.PSChildName));
    }
  }
  return removed;
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

/**
 * Remove the copy of the app this run installed.
 *
 * The test installs a real application and registers a real uninstaller. Left in
 * place, that puts an entry in Settings pointing into this repository, so the run
 * takes it out again — the same uninstaller a user would run, not a directory
 * delete that would strand the registry entry.
 */
async function uninstallTestCopy() {
  const uninstaller = fs.existsSync(INSTALL_DIR)
    ? fs.readdirSync(INSTALL_DIR).find((f) => /^Uninstall.*\.exe$/i.test(f))
    : undefined;
  if (!uninstaller) {
    console.log('\n[cleanup] no uninstaller left by this run');
    return;
  }
  killInstalledApp();
  await waitForAppExit();
  spawnSync(path.join(INSTALL_DIR, uninstaller), ['/S'], {
    stdio: 'ignore',
    env: { ...process.env, APPDATA: ISOLATED_APPDATA, LOCALAPPDATA: ISOLATED_LOCALAPPDATA },
  });
  // As with the install, the uninstaller returns before it has finished deleting.
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline && fs.existsSync(INSTALL_DIR)) {
    await new Promise((r) => setTimeout(r, 700));
  }
  console.log(
    `\n[cleanup] ${fs.existsSync(INSTALL_DIR) ? 'the test installation is still present' : 'the test installation was removed'}`,
  );
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
    env: {
      ...process.env,
      PORT: String(APP_PORT),
      MONGODB_URI: '',
      DISCORD_BOT_TOKEN: '',
      // Keep the app's own idea of the profile inside the work directory: the
      // legacy-state scan and the updater cache both resolve from these.
      APPDATA: ISOLATED_APPDATA,
      LOCALAPPDATA: ISOLATED_LOCALAPPDATA,
    },
  });
  // A detached child that cannot start emits 'error' asynchronously; without a
  // handler that becomes an uncaught exception that kills the whole harness
  // instead of failing one check.
  child.on('error', (err) => {
    try {
      fs.appendFileSync(log, `\n[launch] could not start: ${err.message}\n`);
    } catch {
      // the log is best effort
    }
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
  assertIsolated();

  // Old run directories are removed best-effort: a helper from an earlier run may
  // still hold one, and this run does not install there anyway. Anything left is
  // cleared at the start of the next run.
  const staleRuns = fs.existsSync(WORK)
    ? fs.readdirSync(WORK, { withFileTypes: true }).filter((entry) => entry.isDirectory() && /^run-/.test(entry.name))
    : [];
  for (const entry of staleRuns) {
    try {
      fs.rmSync(path.join(WORK, entry.name), { recursive: true, force: true });
    } catch {
      // Still held by a late uninstaller helper; harmless, and the next run retries.
    }
  }
  for (const name of pruneOwnUninstallEntries()) {
    console.log(`  removed a stale uninstall entry (${name})`);
  }

  // Only this run's own state is reset, so a late helper cannot make the run fail.
  await removeDir(USER_DATA);
  await removeDir(LOGS);
  for (const dir of [RUN_DIR, INSTALL_DIR, USER_DATA, LOGS, ISOLATED_APPDATA, ISOLATED_LOCALAPPDATA]) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const fromInstaller = installerIn(FROM_DIR, 'previous');
  const toInstaller = installerIn(TO_DIR, 'newer');
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
  console.log(`profile:    ${ISOLATED_APPDATA} (isolated from %APPDATA%)`);
  console.log(`feed:       http://127.0.0.1:${FEED_PORT} (${TO_DIR})`);

  // NSIS writes $APPDATA in the *installer's* environment, so the installers are
  // given the same isolated profile the app runs with.
  const installerEnv = { ...process.env, APPDATA: ISOLATED_APPDATA, LOCALAPPDATA: ISOLATED_LOCALAPPDATA };

  // ── install the old build ────────────────────────────────────────────────
  console.log(`\n[1/7] Installing v${fromVersion}`);
  killInstalledApp();
  await waitForAppExit();
  // The install directory belongs to this run alone, so there is nothing to uninstall.
  await removeDir(INSTALL_DIR);
  const install = spawnSync(fromInstaller, ['/S', `/D=${INSTALL_DIR}`], { stdio: 'inherit', env: installerEnv });
  if (install.error) throw new Error(`the v${fromVersion} installer could not be started: ${install.error.message}`);
  if (install.status !== 0) throw new Error(`installer exited with ${install.status}`);
  await waitForFile(exePath(), 60_000);
  check(`v${fromVersion} installed`, fs.existsSync(exePath()), exePath());
  const oldVersion = await waitForVersion(fromVersion);
  check('installed version reported as the old build', oldVersion.startsWith(fromVersion), oldVersion);
  check(
    'shipped app-update.yml points at the test feed',
    textOf(path.join(INSTALL_DIR, 'resources', 'app-update.yml')).includes(String(FEED_PORT)),
    path.join(INSTALL_DIR, 'resources', 'app-update.yml'),
  );

  // ── seed user data and a server ──────────────────────────────────────────
  console.log(`\n[2/7] Starting v${fromVersion} and seeding an account + server`);
  let app = launch('before-update');
  if (!(await waitForBackend(APP_PORT))) throw new Error('backend never became ready');

  // No role in the body: registration grants an ordinary account regardless of
  // what a client asks for, and a test that claims otherwise would hide it.
  const register = await api(APP_PORT, '/api/auth/register', {
    method: 'POST',
    body: { username: USER, displayName: 'Upgrade Probe', email: 'upgrade@example.invalid', password: PASS },
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
  // A folder created on disk has no owner row yet, and unattributed folders are
  // Super Admin only, so visibility has to be checked with the Super Admin — the
  // probe must *not* see it, which is asserted after the update.
  const seedAdmin = await superAdminSession();
  const adminSees = seedAdmin
    ? (await api(APP_PORT, '/api/servers', { cookie: seedAdmin.cookie })).json?.servers ?? []
    : [];
  check('server visible to the Super Admin', adminSees.some((s) => s.id === 'Upgrade_Survival'), `root=${root}`);
  check(
    'server not visible to the ordinary account before attribution',
    !((await api(APP_PORT, '/api/servers', { cookie: login.cookie })).json?.servers ?? []).some(
      (s) => s.id === 'Upgrade_Survival',
    ),
  );

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

  const before = appStateFiles();
  console.log(`  profile state before the update: ${before.length} file(s)`);
  killInstalledApp();
  await new Promise((r) => setTimeout(r, 2000));

  // ── serve the new release and let the old app find it ────────────────────
  console.log(`\n[3/7] Serving v${toVersion} on the update feed`);
  const feed = await startFeed(TO_DIR);
  feedServer = feed;
  const cacheRoot = path.join(ISOLATED_LOCALAPPDATA, 'react-example-updater');
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
  killInstalledApp();
  await new Promise((r) => setTimeout(r, 2000));

  // ── run the downloaded installer, as quitAndInstall does ────────────────
  console.log(`\n[5/7] Installing the downloaded update`);
  const update = spawnSync(cached, ['/S'], { stdio: 'inherit', env: installerEnv });
  if (update.error) {
    // EACCES here means Windows refused to start the file — a partially written
    // download, a lock, or (for the real release installer) an elevation demand.
    throw new Error(`the downloaded update could not be started: ${update.error.message}`);
  }
  if (update.status !== 0) throw new Error(`update installer exited with ${update.status}`);
  const updatedVersion = await waitForVersion(toVersion);
  check('installed version is now the new build', updatedVersion.startsWith(toVersion), updatedVersion);

  if (LEGACY) {
    const staged = path.join(ISOLATED_APPDATA, PKG_NAME, 'legacy-install-servers');
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

  // Ownership policy since this release: a folder with no server_owners row —
  // every folder that predates the table — is Super Admin only. It is never
  // handed to whichever account signs in first, so the probe must NOT see it,
  // the Super Admin must, and attribution must give it back.
  const after = await api(APP_PORT, '/api/servers', { cookie: relogin.cookie });
  check(
    'an unattributed legacy folder is not auto-claimed by a normal account',
    !(after.json?.servers ?? []).some((s) => s.id === 'Upgrade_Survival'),
    'visible to the probe before attribution',
  );

  const admin = await superAdminSession();
  check('the Super Admin still signs in after the update', Boolean(admin));
  const ownership = admin ? await api(APP_PORT, '/api/admin/server-ownership', { cookie: admin.cookie }) : { json: {} };
  const folderRow = (ownership.json?.folders ?? []).find((f) => f.name === 'Upgrade_Survival');
  check(
    'the legacy folder is preserved and shown to the Super Admin',
    Boolean(folderRow) && !folderRow.owner,
    folderRow ? (folderRow.owner ? `owner=@${folderRow.owner.ownerUsername}` : 'unattributed') : 'not listed',
  );

  const assign = admin
    ? await api(APP_PORT, '/api/admin/server-ownership/assign', {
        method: 'POST',
        body: { folderName: 'Upgrade_Survival', username: USER },
        cookie: admin.cookie,
      })
    : { status: 401, json: {} };
  check('the Super Admin can attribute it to the account', assign.status === 200 && assign.json?.ok === true, String(assign.status));

  const reassigned = await api(APP_PORT, '/api/servers', { cookie: relogin.cookie });
  const row = (reassigned.json?.servers ?? []).find((s) => s.id === 'Upgrade_Survival');
  check('server visible to its account again after attribution', Boolean(row), row ? `port=${row.port}` : 'missing');

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

  const now = appStateFiles();
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
  killInstalledApp();
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
  killInstalledApp();
  // The feed has to stay up until here: the final launch reads it to decide it
  // is current. Closing it earlier turned this check into a network error.
  feed.close();

  if (KEEP_INSTALLED) {
    console.log(`\n[cleanup] kept the test installation at ${INSTALL_DIR} (--keep-installed)`);
  } else {
    await uninstallTestCopy();
  }

  console.log(`\n${failures.length === 0 ? 'RESULT: PASS' : `RESULT: FAIL (${failures.length})`}`);
  for (const f of failures) console.log(`  - ${f}`);
  process.exitCode = failures.length === 0 ? 0 : 1;
}

main().catch((err) => {
  console.error(`\n[upgrade-e2e] ERROR: ${err instanceof Error ? err.message : err}`);
  // Never leave a half-tested panel running, or a feed server holding its port:
  // both would block or mislead the next run.
  killInstalledApp();
  feedServer?.close();
  process.exitCode = 1;
});
