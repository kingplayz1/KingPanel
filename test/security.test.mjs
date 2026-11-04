/**
 * Release-security regression tests.
 *
 * Boots the REAL backend (server.ts) against isolated temp directories and talks
 * to it over HTTP, the same way the Electron renderer does. Nothing here mocks
 * Express, the account store or the filesystem.
 *
 * Covered:
 *   - the bootstrap Super Admin has a generated password and no fixed one works
 *   - no endpoint body carries credential material
 *   - registration cannot choose its own role
 *   - sessions are server-side and revocable
 *   - one account cannot list, read, write or download another account's server
 *   - accounts and the database survive a restart (an upgrade in miniature)
 *   - a corrupt account store fails closed instead of starting empty
 *
 * Run with:  npm test
 */
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';

const REPO_ROOT = path.resolve(import.meta.dirname, '..');
const BOOT_TIMEOUT_MS = 60_000;

/* ------------------------------------------------------------------ harness */

async function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

async function startServer({ dataDir, serversRoot, extraEnv = {} }) {
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const instance = { baseUrl, log: '', child: null };

  instance.child = spawn(process.execPath, ['--import', 'tsx', 'server.ts'], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      APPDATA_DB_DIR: dataDir,
      NODE_ENV: 'test',
      // Stay offline and deterministic: no Mongo, Discord, GitHub or Google.
      MONGODB_URI: '',
      DISCORD_BOT_TOKEN: '',
      DISCORD_CLIENT_ID: '',
      DISCORD_CLIENT_SECRET: '',
      GITHUB_CLIENT_ID: '',
      GOOGLE_CLIENT_ID: '',
      ...(serversRoot
        ? { KINGPANEL_TEST_SERVERS_ROOT: serversRoot }
        : {}),
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  instance.child.stdout.on('data', (d) => (instance.log += d.toString()));
  instance.child.stderr.on('data', (d) => (instance.log += d.toString()));

  const started = Date.now();
  while (Date.now() - started < BOOT_TIMEOUT_MS) {
    if (instance.child.exitCode !== null) {
      throw new Error(`server exited early (code ${instance.child.exitCode}):\n${instance.log}`);
    }
    try {
      const res = await fetch(`${baseUrl}/api/auth/login`);
      if (res.status > 0) break;
    } catch {
      // not listening yet
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  if (Date.now() - started >= BOOT_TIMEOUT_MS) {
    throw new Error(`server did not answer within ${BOOT_TIMEOUT_MS}ms:\n${instance.log}`);
  }

  instance.stop = async () => {
    if (instance.child && instance.child.exitCode === null) {
      instance.child.kill();
      await new Promise((r) => setTimeout(r, 300));
      if (instance.child.exitCode === null) instance.child.kill('SIGKILL');
    }
  };
  instance.client = () => makeClient(baseUrl);
  return instance;
}

/** Minimal cookie jar, so a test client behaves like the renderer. */
function makeClient(baseUrl) {
  let cookie = '';
  const request = async (method, pathname, body) => {
    const res = await fetch(`${baseUrl}${pathname}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(cookie ? { cookie } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: 'manual',
    });
    for (const raw of res.headers.getSetCookie?.() || []) {
      const pair = raw.split(';')[0];
      if (!pair.startsWith('king_session=')) continue;
      const value = pair.slice('king_session='.length);
      cookie = value ? pair : '';
    }
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    return { status: res.status, body: json, text };
  };
  return {
    get cookie() {
      return cookie;
    },
    set cookie(value) {
      cookie = value;
    },
    get: (p) => request('GET', p),
    post: (p, b) => request('POST', p, b),
    del: (p, b) => request('DELETE', p, b),
    request,
  };
}

function bootstrapCredentials(dataDir) {
  const file = path.join(dataDir, 'FIRST-RUN-CREDENTIALS.txt');
  const line = fs
    .readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .find((entry) => entry.startsWith('kingplayz\t'));
  assert.ok(line, 'the bootstrap credentials file must contain a kingplayz row');
  return { identifier: 'kingplayz', password: line.split('\t')[1] };
}

/* ------------------------------------------------- main server under test */

let tmpDir;
let dataDir;
let serversRoot;
let server;
// The dev checkout may already hold a stray database from a previous run; what
// matters is that this run writes nothing outside its own state directory.
let repoDbMtimeMs = null;
const REPO_DB = path.join(REPO_ROOT, 'database', 'isking_panel.sqlite');

before(async () => {
  repoDbMtimeMs = fs.existsSync(REPO_DB) ? fs.statSync(REPO_DB).mtimeMs : null;
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'iskingpanel-sec-'));
  dataDir = path.join(tmpDir, 'data');
  serversRoot = path.join(tmpDir, 'servers');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(serversRoot, { recursive: true });

  // Point the panel at the isolated install root before boot.
  fs.writeFileSync(
    path.join(dataDir, '.local-install-config.json'),
    JSON.stringify(
      {
        installRootDir: serversRoot,
        autoCreateSubfolders: true,
        autoAcceptEula: true,
        updatedAt: new Date().toISOString(),
      },
      null,
      2
    )
  );

  // A folder provisioned before this release: no ownership row exists for it.
  const legacyDir = path.join(serversRoot, 'Legacy_Server');
  fs.mkdirSync(legacyDir, { recursive: true });
  fs.writeFileSync(path.join(legacyDir, 'server.properties'), 'server-port=25601\nmotd=legacy\n');
  fs.writeFileSync(path.join(legacyDir, 'server.jar'), 'not-a-real-jar');
  fs.writeFileSync(path.join(legacyDir, 'secret.txt'), 'legacy-owner-only');

  server = await startServer({ dataDir, serversRoot });
});

after(async () => {
  if (server) await server.stop();
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    // best effort
  }
});

/* ------------------------------------------------------------ bootstrap */

describe('bootstrap Super Admin credentials', () => {
  test('a one-time credentials file is written next to the database', () => {
    assert.ok(fs.existsSync(path.join(dataDir, 'FIRST-RUN-CREDENTIALS.txt')));
    const { password } = bootstrapCredentials(dataDir);
    assert.ok(password.length >= 20, 'the generated password must be long');
    assert.notEqual(password, 'KingPlayz#2026');
    assert.notEqual(password, 'kingpanel123');
  });

  test('the published default passwords no longer sign in', async () => {
    for (const password of ['KingPlayz#2026', 'kingpanel123']) {
      const c = server.client();
      const res = await c.post('/api/auth/login', { identifier: 'kingplayz', password });
      assert.equal(res.status, 401, `"${password}" must not authenticate`);
      assert.equal(c.cookie, '', 'a failed sign-in must not set a session cookie');
    }
  });

  test('the generated bootstrap password signs in and yields a Super Admin', async () => {
    const c = server.client();
    const res = await c.post('/api/auth/login', bootstrapCredentials(dataDir));
    assert.equal(res.status, 200, res.text.slice(0, 300));
    assert.equal(res.body?.user?.username, 'kingplayz');
    assert.equal(res.body?.user?.isSuperAdmin, true);
    assert.ok(c.cookie.startsWith('king_session='));
  });

  test('the session id is long, random and not a timestamp', async () => {
    const c = server.client();
    await c.post('/api/auth/login', bootstrapCredentials(dataDir));
    const value = c.cookie.slice('king_session='.length);
    assert.ok(value.length >= 40, `session id too short: ${value.length}`);
    assert.equal(/\d{13}/.test(value), false, 'session id must not embed a millisecond timestamp');
  });
});

/* -------------------------------------------------- credential disclosure */

describe('no endpoint leaks a credential', () => {
  test('/api/windows-app/info contains no password', async () => {
    const c = server.client();
    await c.post('/api/auth/login', bootstrapCredentials(dataDir));
    const res = await c.get('/api/windows-app/info');
    assert.equal(res.status, 200);
    const { password } = bootstrapCredentials(dataDir);
    assert.equal(res.text.includes(password), false, 'bootstrap password must not be returned');
    assert.equal(res.text.includes('KingPlayz#2026'), false, 'a default password must not be returned');
  });

  test('/api/database/overview contains no password hint', async () => {
    const c = server.client();
    await c.post('/api/auth/login', bootstrapCredentials(dataDir));
    const res = await c.get('/api/database/overview');
    assert.equal(res.status, 200);
    assert.equal(res.text.includes('KingPlayz#2026'), false);
    assert.equal(res.text.includes('passwordHint'), false);
  });
});

/* ------------------------------------------------------------- accounts */

describe('registration cannot choose its own privileges', () => {
  const alice = { username: 'alice_owner', email: 'alice@example.test', password: 'alice-pass-123' };
  const bob = { username: 'bob_other', email: 'bob@example.test', password: 'bob-pass-1234' };

  test('a role in the request body is ignored', async () => {
    const c = server.client();
    const res = await c.post('/api/auth/register', {
      ...alice,
      role: 'Super Admin',
      isSuperAdmin: true,
    });
    assert.equal(res.status, 200, res.text.slice(0, 300));
    assert.equal(res.body?.user?.role, 'Operator');
    assert.equal(res.body?.user?.isSuperAdmin, false);
    assert.equal(res.body?.user?.maxServerLimit, 2);
  });

  test('the escalated account still cannot use Super Admin endpoints', async () => {
    const c = server.client();
    await c.post('/api/auth/login', { identifier: alice.username, password: alice.password });
    const res = await c.get('/api/auth/users');
    assert.equal(res.status, 403);
    assert.equal(res.body?.code, 'SUPER_ADMIN_REQUIRED');
  });

  test('the reserved Super Admin username cannot be taken', async () => {
    const res = await server
      .client()
      .post('/api/auth/register', {
        username: 'kingplayz',
        email: 'impostor@example.test',
        password: 'impostor-pass',
      });
    assert.equal(res.status, 409);
  });

  test('a weak password is refused', async () => {
    const res = await server.client().post('/api/auth/register', {
      username: 'shorty',
      email: 'shorty@example.test',
      password: 'abc',
    });
    assert.equal(res.status, 400);
    assert.equal(res.body?.code, 'WEAK_PASSWORD');
  });

  test('a second account can register for the isolation tests', async () => {
    const res = await server.client().post('/api/auth/register', bob);
    assert.equal(res.status, 200, res.text.slice(0, 300));
    assert.equal(res.body?.user?.role, 'Operator');
  });

  test('a wrong password is rejected with one generic message', async () => {
    const c = server.client();
    const wrong = await c.post('/api/auth/login', { identifier: alice.username, password: 'nope-nope-nope' });
    const missing = await c.post('/api/auth/login', { identifier: 'nobody_here', password: 'nope-nope-nope' });
    assert.equal(wrong.status, 401);
    assert.equal(missing.status, 401);
    assert.equal(wrong.body?.error, missing.body?.error, 'messages must not distinguish the two cases');
    assert.equal(wrong.text.includes('No operator account found'), false);
  });
});

/* -------------------------------------------------------------- sessions */

describe('session validation and revocation', () => {
  test('a protected route needs a session', async () => {
    const res = await server.client().get('/api/servers');
    assert.equal(res.status, 401);
  });

  test('a forged cookie is rejected', async () => {
    const c = server.client();
    c.cookie = 'king_session=sess-not-a-real-row';
    const res = await c.get('/api/servers');
    assert.equal(res.status, 401);
  });

  test('logout invalidates the session server-side', async () => {
    const c = server.client();
    await c.post('/api/auth/login', { identifier: 'alice_owner', password: 'alice-pass-123' });
    const cookie = c.cookie;
    assert.ok((await c.get('/api/servers')).status === 200);

    await c.post('/api/auth/logout', {});
    // Replay the cookie that used to be valid.
    c.cookie = cookie;
    const after = await c.get('/api/servers');
    assert.equal(after.status, 401, 'a logged-out session must not authenticate');
  });

  test('one account cannot revoke another account session', async () => {
    const alice = server.client();
    await alice.post('/api/auth/login', { identifier: 'alice_owner', password: 'alice-pass-123' });
    const sessions = await alice.get('/api/auth/sessions');
    assert.equal(sessions.status, 200);
    const aliceSessionId = sessions.body.sessions[0].sessionId;

    const bob = server.client();
    await bob.post('/api/auth/login', { identifier: 'bob_other', password: 'bob-pass-1234' });
    const res = await bob.post('/api/auth/sessions/revoke', { sessionId: aliceSessionId });
    assert.equal(res.status, 403);

    // Alice is still signed in.
    assert.equal((await alice.get('/api/servers')).status, 200);
  });
});

/* ------------------------------------------------------------- ownership */

describe('server ownership isolation', () => {
  const ALICE = { identifier: 'alice_owner', password: 'alice-pass-123' };
  const BOB = { identifier: 'bob_other', password: 'bob-pass-1234' };

  const aliceClient = async () => {
    const c = server.client();
    await c.post('/api/auth/login', ALICE);
    return c;
  };
  const bobClient = async () => {
    const c = server.client();
    await c.post('/api/auth/login', BOB);
    return c;
  };

  before(async () => {
    // Create a real server folder through the real endpoint, without downloading
    // a jar (skipJarInstall), and wait for the job's first file-system effect.
    const c = await aliceClient();
    const res = await c.post('/api/panel/install-server-instance', {
      serverName: 'Alice_Server',
      engine: 'PaperMC 1.21.4',
      version: '1.21.4',
      port: 25602,
      ramMaxGb: 2,
      acceptEula: true,
      skipJarInstall: true,
    });
    assert.ok([200, 201, 202].includes(res.status), res.text.slice(0, 300));

    const target = path.join(serversRoot, 'Alice_Server');
    const started = Date.now();
    while (!fs.existsSync(target) && Date.now() - started < 20_000) {
      await new Promise((r) => setTimeout(r, 200));
    }
    assert.ok(fs.existsSync(target), `server folder was never created:\n${c.text || ''}`);
    fs.writeFileSync(path.join(target, 'owner-note.txt'), 'alice-only');
  });

  test('a folder without an ownership row is invisible to a normal account', async () => {
    const c = await aliceClient();
    const res = await c.get('/api/servers');
    assert.equal(res.status, 200);
    const names = (res.body?.servers || []).map((s) => s.name);
    assert.equal(names.includes('Legacy_Server'), false, 'pre-existing folders are Super Admin only');
  });

  test('the creator sees the folder they created', async () => {
    const c = await aliceClient();
    const res = await c.get('/api/servers');
    const names = (res.body?.servers || []).map((s) => s.name);
    assert.ok(names.includes('Alice_Server'), `expected Alice_Server in ${JSON.stringify(names)}`);
  });

  test('another account cannot list it', async () => {
    const c = await bobClient();
    const res = await c.get('/api/servers');
    const names = (res.body?.servers || []).map((s) => s.name);
    assert.equal(names.includes('Alice_Server'), false);
  });

  test('another account cannot read files, list directories or download them', async () => {
    const c = await bobClient();
    const listing = await c.get('/api/server-runtime/files?serverId=Alice_Server');
    const read = await c.get('/api/server-runtime/file?serverId=Alice_Server&path=owner-note.txt');
    assert.equal(listing.status, 404);
    assert.equal(read.status, 404);
    assert.equal(read.text.includes('alice-only'), false);
  });

  test('another account cannot write or delete in it', async () => {
    const c = await bobClient();
    const write = await c.post('/api/server-runtime/file', {
      serverId: 'Alice_Server',
      path: 'owner-note.txt',
      content: 'rewritten-by-bob',
    });
    const create = await c.post('/api/server-runtime/file-create', {
      serverId: 'Alice_Server',
      path: 'bob-was-here.txt',
    });
    const remove = await c.post('/api/server-runtime/file-delete', {
      serverId: 'Alice_Server',
      path: 'owner-note.txt',
    });
    for (const res of [write, create, remove]) assert.equal(res.status, 404);

    const file = path.join(serversRoot, 'Alice_Server', 'owner-note.txt');
    assert.equal(fs.readFileSync(file, 'utf8'), 'alice-only');
    assert.equal(fs.existsSync(path.join(serversRoot, 'Alice_Server', 'bob-was-here.txt')), false);
  });

  test('another account cannot control its power state or console', async () => {
    const c = await bobClient();
    const power = await c.post('/api/server-runtime/power', { serverId: 'Alice_Server', action: 'stop' });
    const command = await c.post('/api/server-runtime/command', {
      serverId: 'Alice_Server',
      command: 'op attacker',
    });
    const setup = await c.post('/api/server-runtime/setup', {
      serverId: 'Alice_Server',
      setup: { startupCommand: 'rm -rf /' },
    });
    assert.equal(power.status, 404);
    assert.equal(command.status, 404);
    assert.equal(setup.status, 404);
  });

  test('another account cannot delete or reinstall it', async () => {
    const c = await bobClient();
    const removal = await c.del('/api/server-runtime/server', { serverId: 'Alice_Server' });
    const reinstall = await c.post('/api/server-runtime/reinstall', { serverId: 'Alice_Server' });
    assert.equal(removal.status, 404);
    assert.equal(reinstall.status, 404);
    assert.ok(fs.existsSync(path.join(serversRoot, 'Alice_Server')));
  });

  test('the owner can still use their own folder', async () => {
    const c = await aliceClient();
    const read = await c.get('/api/server-runtime/file?serverId=Alice_Server&path=owner-note.txt');
    assert.equal(read.status, 200);
    assert.equal(read.body?.content, 'alice-only');
  });

  test('the Super Admin can reach every folder, including pre-existing ones', async () => {
    const c = server.client();
    await c.post('/api/auth/login', bootstrapCredentials(dataDir));
    const list = await c.get('/api/servers');
    const names = (list.body?.servers || []).map((s) => s.name);
    assert.ok(names.includes('Legacy_Server'));
    assert.ok(names.includes('Alice_Server'));

    const legacyRead = await c.get('/api/server-runtime/file?serverId=Legacy_Server&path=secret.txt');
    assert.equal(legacyRead.status, 200);
    assert.equal(legacyRead.body?.content, 'legacy-owner-only');
  });

  test('jobs are scoped to their owner', async () => {
    const alice = await aliceClient();
    const aliceJobs = await alice.get('/api/jobs');
    assert.equal(aliceJobs.status, 200);
    assert.ok((aliceJobs.body?.jobs || []).length > 0, 'the install job should be listed for its owner');

    const bob = await bobClient();
    const bobJobs = await bob.get('/api/jobs');
    assert.equal(bobJobs.status, 200);
    assert.equal((bobJobs.body?.jobs || []).length, 0, 'another account must not see the job');

    const id = aliceJobs.body.jobs[0].id;
    assert.equal((await bob.request('GET', `/api/jobs/${id}`)).status, 404);
    assert.equal((await bob.post(`/api/jobs/${id}/cancel`, {})).status, 404);
  });

  test('a normal account cannot repoint the global install root', async () => {
    const c = await bobClient();
    const res = await c.post('/api/panel/install-folder', {
      installRootDir: path.join(tmpDir, 'elsewhere'),
      servers: [],
    });
    assert.equal(res.status, 403);
    assert.equal(res.body?.code, 'SUPER_ADMIN_REQUIRED');
  });

  test('a normal account cannot promote itself through profile sync', async () => {
    const c = await bobClient();
    await c.post('/api/panel/profile-sync', {
      user: { username: 'bob_other', role: 'Super Admin', displayName: 'Bob' },
    });
    const res = await c.get('/api/auth/users');
    assert.equal(res.status, 403, 'profile sync must not grant a role');
  });
});

/* ------------------------------------------------- storage and upgrades */

describe('data directory and upgrade survival', () => {
  test('the account store lives in APPDATA_DB_DIR, with the mirror alongside it', () => {
    assert.ok(fs.existsSync(path.join(dataDir, 'isking_panel.sqlite')), 'SQLite must be in the state dir');
    assert.ok(fs.existsSync(path.join(dataDir, '.local-users-db.json')), 'the JSON mirror must share the dir');
    // Nothing may be written next to the app itself: the dev checkout's copy,
    // if any, must be untouched by this run.
    const after = fs.existsSync(REPO_DB) ? fs.statSync(REPO_DB).mtimeMs : null;
    assert.equal(after, repoDbMtimeMs, 'the app directory must not be used as a state directory');
  });

  test('accounts, ownership and sessions survive a restart', async () => {
    const token = server.client();
    const login = await token.post('/api/auth/login', { identifier: 'alice_owner', password: 'alice-pass-123' });
    assert.equal(login.status, 200);
    const liveCookie = token.cookie;

    await server.stop();
    server = await startServer({ dataDir, serversRoot });

    const afterRestart = server.client();
    const again = await afterRestart.post('/api/auth/login', {
      identifier: 'alice_owner',
      password: 'alice-pass-123',
    });
    assert.equal(again.status, 200, `the account must still exist after a restart: ${again.text.slice(0, 200)}`);

    // The session row persisted too, so a cookie issued before the restart works.
    const replayed = server.client();
    replayed.cookie = liveCookie;
    const servers = await replayed.get('/api/servers');
    assert.equal(servers.status, 200);
    const names = (servers.body?.servers || []).map((s) => s.name);
    assert.ok(names.includes('Alice_Server'), 'ownership must survive a restart');

    // The bootstrap credentials file is not rewritten with a new password.
    const { password } = bootstrapCredentials(dataDir);
    const sa = server.client();
    assert.equal((await sa.post('/api/auth/login', { identifier: 'kingplayz', password })).status, 200);
  });
});

/* --------------------------------------------------- legacy attribution */

describe('legacy folder attribution is a Super Admin action', () => {
  const ALICE = { identifier: 'alice_owner', password: 'alice-pass-123' };
  const BOB = { identifier: 'bob_other', password: 'bob-pass-1234' };

  const signIn = async (credentials) => {
    const c = server.client();
    assert.equal((await c.post('/api/auth/login', credentials)).status, 200);
    return c;
  };

  test('a normal account cannot list ownership', async () => {
    const c = await signIn(BOB);
    const res = await c.get('/api/admin/server-ownership');
    assert.equal(res.status, 403);
    assert.equal(res.body?.code, 'SUPER_ADMIN_REQUIRED');
  });

  test('a normal account cannot claim an unowned folder', async () => {
    const c = await signIn(BOB);
    const res = await c.post('/api/admin/server-ownership/assign', {
      folderName: 'Legacy_Server',
      username: 'bob_other',
    });
    assert.equal(res.status, 403);

    // And it is still invisible to them.
    const list = await c.get('/api/servers');
    assert.equal((list.body?.servers || []).some((s) => s.name === 'Legacy_Server'), false);
  });

  test('the Super Admin sees unattributed folders and the accounts to give them to', async () => {
    const c = server.client();
    await c.post('/api/auth/login', bootstrapCredentials(dataDir));
    const res = await c.get('/api/admin/server-ownership');
    assert.equal(res.status, 200);
    const byName = new Map((res.body.folders || []).map((f) => [f.name, f]));
    assert.equal(byName.get('Legacy_Server')?.owner, null);
    assert.equal(byName.get('Alice_Server')?.owner?.ownerUsername, 'alice_owner');
    assert.ok((res.body.accounts || []).some((a) => a.username === 'bob_other'));
    assert.ok(res.body.unattributedCount >= 1);
  });

  test('attribution gives the folder to the chosen account', async () => {
    const admin = server.client();
    await admin.post('/api/auth/login', bootstrapCredentials(dataDir));
    const assign = await admin.post('/api/admin/server-ownership/assign', {
      folderName: 'Legacy_Server',
      username: 'bob_other',
    });
    assert.equal(assign.status, 200, assign.text.slice(0, 300));
    assert.equal(assign.body.changed, true);
    assert.equal(assign.body.owner.username, 'bob_other');
    assert.equal(assign.body.previousOwner, null);

    const bob = await signIn(BOB);
    const list = await bob.get('/api/servers');
    assert.ok((list.body?.servers || []).some((s) => s.name === 'Legacy_Server'));
    const file = await bob.get('/api/server-runtime/file?serverId=Legacy_Server&path=secret.txt');
    assert.equal(file.status, 200);
    assert.equal(file.body?.content, 'legacy-owner-only');
  });

  test('the same attribution is idempotent', async () => {
    const admin = server.client();
    await admin.post('/api/auth/login', bootstrapCredentials(dataDir));
    const again = await admin.post('/api/admin/server-ownership/assign', {
      folderName: 'Legacy_Server',
      username: 'bob_other',
    });
    assert.equal(again.status, 200);
    assert.equal(again.body.changed, false, 'repeating the same assignment must not rewrite it');
    assert.equal(again.body.previousOwner.ownerUsername, 'bob_other');
  });

  test('reassigning moves the folder and the previous owner loses access', async () => {
    const admin = server.client();
    await admin.post('/api/auth/login', bootstrapCredentials(dataDir));
    const reassign = await admin.post('/api/admin/server-ownership/assign', {
      folderName: 'Legacy_Server',
      username: 'alice_owner',
    });
    assert.equal(reassign.status, 200);
    assert.equal(reassign.body.changed, true);
    assert.equal(reassign.body.previousOwner.ownerUsername, 'bob_other');

    const bob = await signIn(BOB);
    assert.equal((await bob.get('/api/server-runtime/file?serverId=Legacy_Server&path=secret.txt')).status, 404);
    const alice = await signIn(ALICE);
    assert.equal((await alice.get('/api/server-runtime/file?serverId=Legacy_Server&path=secret.txt')).status, 200);
  });

  test('an unknown folder or account is refused', async () => {
    const admin = server.client();
    await admin.post('/api/auth/login', bootstrapCredentials(dataDir));
    const noFolder = await admin.post('/api/admin/server-ownership/assign', {
      folderName: 'No_Such_Folder',
      username: 'bob_other',
    });
    assert.equal(noFolder.status, 404);

    const noAccount = await admin.post('/api/admin/server-ownership/assign', {
      folderName: 'Legacy_Server',
      username: 'nobody_at_all',
    });
    assert.equal(noAccount.status, 404);
  });

  test('traversal in the folder name cannot address another directory', async () => {
    const admin = server.client();
    await admin.post('/api/auth/login', bootstrapCredentials(dataDir));
    const res = await admin.post('/api/admin/server-ownership/assign', {
      folderName: '..',
      username: 'bob_other',
    });
    assert.ok([400, 404].includes(res.status), `unexpected ${res.status}`);
  });
});

/* ------------------------------------------------------- recovery flow */

describe('account recovery needs the account\u2019s own code', () => {
  test('registration returns a recovery code exactly once', async () => {
    const res = await server.client().post('/api/auth/register', {
      username: 'recovery_user',
      email: 'recovery@example.test',
      password: 'recovery-pass-1',
    });
    assert.equal(res.status, 200, res.text.slice(0, 300));
    assert.match(String(res.body.recoveryCode), /^ISK-[A-Z0-9]{5}-[A-Z0-9]{5}-[A-Z0-9]{5}$/);
    assert.equal(res.body.recoveryCodeIssued, true);
    // It is not echoed by the account object or any other field.
    assert.equal(JSON.stringify(res.body.user).includes(res.body.recoveryCode), false);
  });

  test('the old "name an account, choose a password" path is gone', async () => {
    const res = await server.client().post('/api/auth/reset-password', {
      identifier: 'recovery_user',
      newPassword: 'hijacked-password',
    });
    assert.equal(res.status, 400);
    assert.equal(res.body?.code, 'RECOVERY_CODE_REQUIRED');

    // The password still works, so nothing was changed.
    const login = await server.client().post('/api/auth/login', {
      identifier: 'recovery_user',
      password: 'recovery-pass-1',
    });
    assert.equal(login.status, 200);
  });

  test('another account cannot be reset with the wrong code', async () => {
    const res = await server.client().post('/api/auth/reset-password', {
      identifier: 'kingplayz',
      recoveryCode: 'ISK-AAAAA-AAAAA-AAAAA',
      newPassword: 'hijacked-password',
    });
    assert.equal(res.status, 401);
    assert.equal(res.body?.code, 'INVALID_RECOVERY');

    // The Super Admin (and everyone else) is unaffected.
    const sa = server.client();
    assert.equal((await sa.post('/api/auth/login', bootstrapCredentials(dataDir))).status, 200);
  });

  test('an unknown account and a wrong code answer identically', async () => {
    const wrongCode = await server.client().post('/api/auth/reset-password', {
      identifier: 'recovery_user',
      recoveryCode: 'ISK-AAAAA-AAAAA-AAAAA',
      newPassword: 'another-password-1',
    });
    const unknown = await server.client().post('/api/auth/reset-password', {
      identifier: 'no_such_account',
      recoveryCode: 'ISK-AAAAA-AAAAA-AAAAA',
      newPassword: 'another-password-1',
    });
    assert.equal(wrongCode.status, unknown.status);
    assert.equal(wrongCode.body?.error, unknown.body?.error);
  });

  test('the correct code resets the password and is then spent', async () => {
    const fresh = server.client();
    const registered = await fresh.post('/api/auth/register', {
      username: 'recoverable_user',
      email: 'recoverable@example.test',
      password: 'original-pass-1',
    });
    assert.equal(registered.status, 200);
    const code = registered.body.recoveryCode;

    // A weak new password is still refused, even with the right code.
    const weak = await server.client().post('/api/auth/reset-password', {
      identifier: 'recoverable_user',
      recoveryCode: code,
      newPassword: 'short',
    });
    assert.equal(weak.status, 400);
    assert.equal(weak.body?.code, 'WEAK_PASSWORD');

    const reset = await server.client().post('/api/auth/reset-password', {
      identifier: 'recoverable_user',
      recoveryCode: code.toLowerCase().replace(/-/g, ' '),
      newPassword: 'brand-new-pass-1',
    });
    assert.equal(reset.status, 200, reset.text.slice(0, 300));
    assert.match(String(reset.body.recoveryCode), /^ISK-/);
    assert.notEqual(reset.body.recoveryCode, code, 'the used code must be replaced');

    // New password works, the old one does not.
    assert.equal(
      (await server.client().post('/api/auth/login', {
        identifier: 'recoverable_user',
        password: 'brand-new-pass-1',
      })).status,
      200
    );
    assert.equal(
      (await server.client().post('/api/auth/login', {
        identifier: 'recoverable_user',
        password: 'original-pass-1',
      })).status,
      401
    );

    // Replaying the spent code fails.
    const replay = await server.client().post('/api/auth/reset-password', {
      identifier: 'recoverable_user',
      recoveryCode: code,
      newPassword: 'third-password-1',
    });
    assert.equal(replay.status, 401);
    assert.equal(replay.body?.code, 'INVALID_RECOVERY');
  });

  test('a reset signs out every existing session for that account', async () => {
    const c = server.client();
    const registered = await c.post('/api/auth/register', {
      username: 'session_reset_user',
      email: 'session-reset@example.test',
      password: 'session-pass-1',
    });
    assert.equal(registered.status, 200);
    const oldCookie = c.cookie;
    assert.equal((await c.get('/api/servers')).status, 200);

    const reset = await server.client().post('/api/auth/reset-password', {
      identifier: 'session_reset_user',
      recoveryCode: registered.body.recoveryCode,
      newPassword: 'session-pass-2',
    });
    assert.equal(reset.status, 200);

    const replay = server.client();
    replay.cookie = oldCookie;
    assert.equal((await replay.get('/api/servers')).status, 401);
  });
});

describe('failed storage initialisation fails closed', () => {
  test('a corrupt database refuses sign-in instead of starting empty', async () => {
    const brokenDir = fs.mkdtempSync(path.join(os.tmpdir(), 'iskingpanel-broken-'));
    try {
      // Not a SQLite file: the open or the first statement fails.
      fs.writeFileSync(path.join(brokenDir, 'isking_panel.sqlite'), Buffer.from('this is not a database'));

      const broken = await startServer({ dataDir: brokenDir, serversRoot });
      try {
        const login = await broken.client().post('/api/auth/login', {
          identifier: 'kingplayz',
          password: 'whatever-123',
        });
        assert.equal(login.status, 503, `expected 503, got ${login.status}: ${login.text.slice(0, 200)}`);
        assert.equal(login.body?.code, 'ACCOUNT_STORE_UNAVAILABLE');

        // Registration must not invent a store either.
        const register = await broken.client().post('/api/auth/register', {
          username: 'fresh_guy',
          email: 'fresh@example.test',
          password: 'fresh-pass-123',
        });
        assert.equal(register.status, 503);

        // And it must not write a replacement account list.
        assert.equal(fs.existsSync(path.join(brokenDir, '.local-users-db.json')), false);
      } finally {
        await broken.stop();
      }
    } finally {
      fs.rmSync(brokenDir, { recursive: true, force: true });
    }
  });
});
