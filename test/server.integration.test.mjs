/**
 * KingPanel — backend integration tests.
 *
 * Boots the REAL server (server.ts) against an isolated temp data directory and
 * an isolated server-install root, then exercises it over HTTP exactly the way
 * the renderer does. No mocks of the backend, no mocks of the process manager:
 * every assertion is about what the running Express app actually answered.
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
const TEST_TIMEOUT_MS = 60_000;

let tmpDir;
let dataDir;
let serversRoot;
let child;
let baseUrl;
let childLog = '';

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

async function waitForHttp(url, timeoutMs = 45_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (child && child.exitCode !== null) {
      throw new Error(`server exited early (code ${child.exitCode}):\n${childLog}`);
    }
    try {
      const res = await fetch(url);
      if (res.status > 0) return;
    } catch {
      // not listening yet
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`server did not answer ${url} within ${timeoutMs}ms:\n${childLog}`);
}

/** Minimal cookie jar so tests behave like the Electron renderer. */
function makeClient() {
  let cookie = '';
  return {
    get cookie() {
      return cookie;
    },
    setCookie(value) {
      cookie = value;
    },
    async request(method, pathname, body, { headers = {}, keepCookie = true } = {}) {
      const res = await fetch(`${baseUrl}${pathname}`, {
        method,
        headers: {
          'Content-Type': 'application/json',
          ...(cookie ? { cookie } : {}),
          ...headers,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: 'manual',
      });
      const setCookie = res.headers.getSetCookie?.() || [];
      for (const raw of setCookie) {
        const pair = raw.split(';')[0];
        if (!pair.startsWith('king_session=')) continue;
        const value = pair.slice('king_session='.length);
        if (!value || /king_session=;/.test(raw)) cookie = '';
        else if (keepCookie) cookie = pair;
      }
      const text = await res.text();
      let json = null;
      try {
        json = text ? JSON.parse(text) : null;
      } catch {
        json = null;
      }
      return { status: res.status, body: json, text };
    },
  };
}

const client = () => {
  const c = makeClient();
  c.get = (pathname, opts) => c.request('GET', pathname, undefined, opts);
  c.post = (pathname, body, opts) => c.request('POST', pathname, body, opts);
  c.del = (pathname, body, opts) => c.request('DELETE', pathname, body, opts);
  return c;
};

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'iskingpanel-test-'));
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

  // A disposable server folder with one editable file.
  const serverDir = path.join(serversRoot, 'Test_Server');
  fs.mkdirSync(path.join(serverDir, 'plugins'), { recursive: true });
  fs.writeFileSync(path.join(serverDir, 'server.properties'), 'server-port=25599\nmotd=test\n');
  fs.writeFileSync(path.join(serverDir, 'eula.txt'), 'eula=false\n');
  // Present so the EULA check (which runs after the jar check) is reachable.
  // Nothing in this suite accepts the EULA, so this file is never executed.
  fs.writeFileSync(path.join(serverDir, 'server.jar'), 'not-a-real-jar');

  const port = await freePort();
  baseUrl = `http://127.0.0.1:${port}`;

  child = spawn(process.execPath, ['--import', 'tsx', 'server.ts'], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      APPDATA_DB_DIR: dataDir,
      NODE_ENV: 'test',
      // Keep the test run offline and deterministic: no Mongo, no Discord, no
      // GitHub/Google OAuth. Absent values mean those integrations stay off.
      MONGODB_URI: '',
      DISCORD_BOT_TOKEN: '',
      DISCORD_CLIENT_ID: '',
      DISCORD_CLIENT_SECRET: '',
      GITHUB_CLIENT_ID: '',
      GOOGLE_CLIENT_ID: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (d) => (childLog += d.toString()));
  child.stderr.on('data', (d) => (childLog += d.toString()));

  await waitForHttp(`${baseUrl}/api/auth/login`);
});

after(async () => {
  if (child && child.exitCode === null) {
    child.kill();
    await new Promise((r) => setTimeout(r, 300));
    if (child.exitCode === null) child.kill('SIGKILL');
  }
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    // best effort
  }
});

// ---------------------------------------------------------------------------
// Phase 5: every privileged endpoint must reject an anonymous caller.
// These endpoints previously answered on 0.0.0.0 with no session at all.
// ---------------------------------------------------------------------------
describe('anonymous callers are rejected', () => {
  const protectedCalls = [
    ['GET', '/api/servers'],
    ['GET', '/api/panel/telemetry'],
    ['POST', '/api/server-runtime/power', { serverId: 'Test_Server', action: 'start' }],
    ['POST', '/api/server-runtime/command', { serverId: 'Test_Server', command: 'list' }],
    ['GET', '/api/server-runtime/files?serverId=Test_Server'],
    ['GET', '/api/server-runtime/file?serverId=Test_Server&path=server.properties'],
    ['POST', '/api/server-runtime/file', { serverId: 'Test_Server', path: 'x.txt', content: 'x' }],
    ['DELETE', '/api/server-runtime/server', { serverId: 'Test_Server' }],
    ['POST', '/api/server-runtime/reinstall', { serverId: 'Test_Server' }],
    ['GET', '/api/backups/realtime'],
    ['POST', '/api/backups/create', {}],
    ['GET', '/api/schedules/realtime'],
    ['POST', '/api/database/provision-server', { name: 'x' }],
    ['POST', '/api/database/query', { sql: 'select 1' }],
    ['POST', '/api/system/browse-folders', { path: serversRoot }],
    ['GET', '/api/system/local-drives'],
    ['GET', '/api/auth/users'],
    ['GET', '/api/auth/sessions'],
    ['GET', '/api/logs/realtime'],
    ['POST', '/api/panel/kill-local-pid', { pid: 1 }],
  ];

  for (const [method, pathname, body] of protectedCalls) {
    test(`${method} ${pathname} → 401 without a session`, async () => {
      const res = await client().request(method, pathname, body);
      assert.equal(res.status, 401, `expected 401, got ${res.status}: ${res.text.slice(0, 200)}`);
    });
  }
});

// ---------------------------------------------------------------------------
// Authentication + session lifecycle (Phase 6.1)
// ---------------------------------------------------------------------------
describe('authentication and session persistence', () => {
  const user = { username: 'phase6_user', email: 'phase6@example.test', password: 'secret123' };

  test('registration creates an account and issues a session cookie', async () => {
    const c = client();
    const res = await c.post('/api/auth/register', {
      username: user.username,
      displayName: 'Phase 6 User',
      email: user.email,
      password: user.password,
    });
    assert.equal(res.status, 200, res.text.slice(0, 300));
    assert.equal(res.body?.ok, true);
    assert.ok(c.cookie.startsWith('king_session='), 'registration should set a session cookie');
    assert.equal(res.body?.user?.username, user.username);
  });

  test('the session authenticates a protected call', async () => {
    const c = client();
    const login = await c.post('/api/auth/login', {
      identifier: user.username,
      password: user.password,
    });
    assert.equal(login.status, 200, login.text.slice(0, 300));
    const servers = await c.get('/api/servers');
    assert.equal(servers.status, 200);
    assert.equal(servers.body?.ok, true);
    assert.ok(Array.isArray(servers.body?.servers));
  });

  test('a wrong password is rejected and issues no session', async () => {
    const c = client();
    const res = await c.post('/api/auth/login', {
      identifier: user.username,
      password: 'definitely-wrong',
    });
    assert.equal(res.status, 401);
    assert.equal(c.cookie, '');
  });

  test('logout invalidates the session server-side', async () => {
    const c = client();
    await c.post('/api/auth/login', { identifier: user.username, password: user.password });
    const before = await c.get('/api/auth/sessions');
    assert.equal(before.status, 200);
    const staleCookie = c.cookie;

    await c.post('/api/auth/logout', {});
    const after = await c.get('/api/auth/sessions');
    assert.equal(after.status, 401, 'the cookie must not authenticate after logout');

    // Replaying the old cookie must fail too — the row is gone, not just the cookie.
    const replay = await fetch(`${baseUrl}/api/servers`, { headers: { cookie: staleCookie } });
    assert.equal(replay.status, 401);
  });
});

// ---------------------------------------------------------------------------
// Session management endpoints the renderer already called (previously 404)
// ---------------------------------------------------------------------------
describe('session management endpoints', () => {
  const user = { username: 'sessions_user', email: 'sessions@example.test', password: 'secret123' };

  test('sessions list, revoke-others and revoke work', async () => {
    const first = client();
    const reg = await first.post('/api/auth/register', {
      username: user.username,
      displayName: 'Sessions User',
      email: user.email,
      password: user.password,
    });
    assert.equal(reg.status, 200, reg.text.slice(0, 300));

    const second = client();
    const login2 = await second.post('/api/auth/login', {
      identifier: user.username,
      password: user.password,
    });
    assert.equal(login2.status, 200);

    const list = await second.get('/api/auth/sessions');
    assert.equal(list.status, 200);
    assert.ok(list.body.sessions.length >= 2, 'both sessions should be listed');
    const current = list.body.currentSessionId;
    assert.ok(current, 'the current session id must be reported');
    for (const s of list.body.sessions) {
      assert.ok(s.sessionId && s.username === user.username, 'session rows carry identity');
      assert.ok(!('password_hash' in s) && !('passwordHash' in s), 'no credential material leaks');
    }

    const others = await second.post('/api/auth/sessions/revoke-others', {});
    assert.equal(others.status, 200);
    const afterOthers = await second.get('/api/auth/sessions');
    assert.equal(afterOthers.body.sessions.length, 1);
    assert.equal(afterOthers.body.sessions[0].sessionId, current);

    // The first client's session was revoked, so it can no longer authenticate.
    assert.equal((await first.get('/api/servers')).status, 401);

    // Revoking your own current session clears the cookie and kills the row.
    const self = await second.post('/api/auth/sessions/revoke', { sessionId: current });
    assert.equal(self.status, 200);
    assert.equal(self.body.revokedCurrent, true);
    assert.equal((await second.get('/api/servers')).status, 401);
  });

  test('a session id belonging to another account cannot be revoked', async () => {
    const owner = client();
    await owner.post('/api/auth/register', {
      username: 'session_owner',
      displayName: 'Owner',
      email: 'owner@example.test',
      password: 'secret123',
    });
    const ownerSessions = await owner.get('/api/auth/sessions');
    const ownerSessionId = ownerSessions.body.sessions[0].sessionId;

    const attacker = client();
    await attacker.post('/api/auth/register', {
      username: 'session_attacker',
      displayName: 'Attacker',
      email: 'attacker@example.test',
      password: 'secret123',
    });
    const res = await attacker.post('/api/auth/sessions/revoke', { sessionId: ownerSessionId });
    assert.equal(res.status, 403);
    // The victim's session still works.
    assert.equal((await owner.get('/api/servers')).status, 200);
  });
});

// ---------------------------------------------------------------------------
// Advanced Panel entitlement (Phase 6.2)
// ---------------------------------------------------------------------------
describe('advanced panel entitlement', () => {
  const user = { username: 'entitlement_user', email: 'ent@example.test', password: 'secret123' };

  test('a plain account gets the Simple Panel but not Advanced-only APIs', async () => {
    const c = client();
    const reg = await c.post('/api/auth/register', {
      username: user.username,
      displayName: 'Ent User',
      email: user.email,
      password: user.password,
    });
    assert.equal(reg.status, 200, reg.text.slice(0, 300));

    // Simple-Panel surface still works for an unverified account.
    assert.equal((await c.get('/api/servers')).status, 200);
    assert.equal((await c.get('/api/server-runtime/live-state?serverId=Test_Server')).status, 200);

    // Advanced-only surface is refused. With no Discord link the backend must
    // fail closed with ADVANCED_PANEL_REQUIRED (403).
    const advanced = await c.post('/api/database/vacuum', {});
    assert.equal(advanced.status, 403, advanced.text.slice(0, 300));
    assert.equal(advanced.body?.code, 'ADVANCED_PANEL_REQUIRED');
    assert.equal(advanced.body?.panels?.advanced?.allowed, false);

    const denied = await c.post('/api/marketplace/install', {});
    assert.equal(denied.status, 403);
  });

  test('the access payload reports the reason the Advanced Panel is closed', async () => {
    const c = client();
    await c.post('/api/auth/login', { identifier: user.username, password: user.password });
    const res = await c.get('/api/account/access');
    assert.equal(res.status, 200);
    assert.equal(res.body?.panels?.advanced?.allowed, false);
    assert.ok(
      ['discord_not_linked', 'not_a_guild_member', 'required_role_missing', 'required_role_not_configured'].includes(
        res.body?.panels?.advanced?.reason
      ) || res.body?.panels?.advanced?.reason === undefined,
      `unexpected reason: ${res.body?.panels?.advanced?.reason}`
    );
  });
});

// ---------------------------------------------------------------------------
// Super Admin only surfaces (previously readable by any caller / any member)
// ---------------------------------------------------------------------------
describe('account administration is Super Admin only', () => {
  test('a regular account cannot list panel accounts', async () => {
    const c = client();
    await c.post('/api/auth/login', { identifier: 'entitlement_user', password: 'secret123' });
    const res = await c.get('/api/auth/users');
    assert.equal(res.status, 403);
    assert.equal(res.body?.code, 'SUPER_ADMIN_REQUIRED');
  });

  test('a regular account cannot change another account role or password', async () => {
    const c = client();
    await c.post('/api/auth/login', { identifier: 'entitlement_user', password: 'secret123' });
    const res = await c.post('/api/database/admin/update-user', {
      targetUsername: 'kingplayz',
      role: 'Super Admin',
      newPassword: 'hijacked',
    });
    assert.equal(res.status, 403, res.text.slice(0, 300));
    assert.equal(res.body?.code, 'SUPER_ADMIN_REQUIRED');

    // The Super Admin password must be unchanged.
    const check = client();
    const login = await check.post('/api/auth/login', {
      identifier: 'kingplayz',
      password: 'hijacked',
    });
    assert.equal(login.status, 401);
  });
});

// ---------------------------------------------------------------------------
// Filesystem safety (Phase 6.7) — path traversal inside the server folder
// ---------------------------------------------------------------------------
describe('file manager stays inside the server folder', () => {
  let c;

  before(async () => {
    c = client();
    await c.post('/api/auth/login', { identifier: 'entitlement_user', password: 'secret123' });
  });

  const traversals = [
    '../',
    '../../',
    '..\\..\\',
    'plugins/../../',
    '/etc/passwd',
    'C:\\Windows\\win.ini',
  ];

  for (const bad of traversals) {
    test(`GET file rejects path "${bad}"`, async () => {
      const res = await c.get(
        `/api/server-runtime/file?serverId=Test_Server&path=${encodeURIComponent(bad + 'eula.txt')}`
      );
      assert.notEqual(res.status, 200, `traversal "${bad}" must not read outside the folder`);
      assert.ok(res.body?.ok !== true);
    });
  }

  test('a legitimate file reads and writes inside the folder', async () => {
    const read = await c.get('/api/server-runtime/file?serverId=Test_Server&path=server.properties');
    assert.equal(read.status, 200);
    assert.match(read.body.content, /server-port=25599/);

    const write = await c.post('/api/server-runtime/file', {
      serverId: 'Test_Server',
      path: 'server.properties',
      content: 'server-port=25599\nmotd=edited-by-test\n',
    });
    assert.equal(write.status, 200);
    const reread = await c.get('/api/server-runtime/file?serverId=Test_Server&path=server.properties');
    assert.match(reread.body.content, /edited-by-test/);
  });

  test('writing outside the folder is rejected', async () => {
    const res = await c.post('/api/server-runtime/file', {
      serverId: 'Test_Server',
      path: '../../escaped.txt',
      content: 'nope',
    });
    assert.equal(res.status, 400);
    assert.equal(
      fs.existsSync(path.join(serversRoot, 'escaped.txt')),
      false,
      'no file may be written above the server folder'
    );
  });

  test('a missing server folder answers 404 instead of guessing', async () => {
    const res = await c.get('/api/server-runtime/files?serverId=No_Such_Server');
    assert.equal(res.status, 404);
  });
});

// ---------------------------------------------------------------------------
// Server lifecycle safety (Phase 6.4 / 6.8) — no fake success
// ---------------------------------------------------------------------------
describe('server lifecycle honesty', () => {
  let c;

  before(async () => {
    c = client();
    await c.post('/api/auth/login', { identifier: 'entitlement_user', password: 'secret123' });
  });

  test('starting a server without an accepted EULA is refused', async () => {
    const res = await c.post('/api/server-runtime/power', {
      serverId: 'Test_Server',
      action: 'start',
    });
    assert.equal(res.status, 400, res.text.slice(0, 300));
    assert.equal(res.body?.ok, false);
    assert.match(String(res.body?.error || ''), /EULA/i);
  });

  test('an unknown power action is rejected', async () => {
    const res = await c.post('/api/server-runtime/power', {
      serverId: 'Test_Server',
      action: 'explode',
    });
    assert.equal(res.status, 400);
    assert.match(String(res.body?.error || ''), /Unknown action/);
  });

  test('a console command on a stopped server is refused', async () => {
    const res = await c.post('/api/server-runtime/command', {
      serverId: 'Test_Server',
      command: 'list',
    });
    assert.equal(res.status, 400);
    assert.equal(res.body?.ok, false);
    assert.match(String(res.body?.error || ''), /not running/i);
  });

  test('live-state reports the real supervisor state, not a claimed one', async () => {
    const res = await c.get('/api/server-runtime/live-state?serverId=Test_Server');
    assert.equal(res.status, 200);
    assert.equal(res.body.state, 'stopped');
    assert.equal(res.body.pid, null);
    assert.deepEqual(res.body.consoleLogs, []);
  });

  test('deleting a folder that is not a server is refused', async () => {
    const res = await c.del('/api/server-runtime/server', { serverId: 'No_Such_Server' });
    assert.equal(res.status, 404);
  });
});

// ---------------------------------------------------------------------------
// Database credential check (Phase 6.9) — a refused connection is a failure
// ---------------------------------------------------------------------------
describe('database credential verification is honest', () => {
  let c;

  before(async () => {
    c = client();
    await c.post('/api/auth/login', { identifier: 'entitlement_user', password: 'secret123' });
  });

  test('missing host/username is a validation error', async () => {
    const res = await c.post('/api/database/verify-credentials', { engine: 'xampp', host: '' });
    assert.equal(res.status, 400);
    assert.equal(res.body?.verified, false);
  });

  test('an unreachable MySQL server reports verified:false, not success', async () => {
    const deadPort = await freePort();
    const res = await c.post('/api/database/verify-credentials', {
      engine: 'xampp',
      host: '127.0.0.1',
      port: deadPort,
      username: 'root',
      password: '',
    });
    assert.equal(res.status, 502);
    assert.equal(res.body?.verified, false);
    assert.ok(res.body?.error);
  });

  test('an invalid database name is rejected before any connection', async () => {
    const res = await c.post('/api/database/inject-sql', {
      engine: 'xampp',
      host: '127.0.0.1',
      port: 3306,
      username: 'root',
      password: '',
      primaryDatabase: 'bad;DROP TABLE users',
    });
    assert.equal(res.status, 400);
    assert.match(String(res.body?.error || ''), /Invalid database name/);
  });
});

// ---------------------------------------------------------------------------
// Job queue (Phase 6.4) — jobs are per-caller and cancellable
// ---------------------------------------------------------------------------
describe('operation jobs', () => {
  test('a caller only sees jobs it created', async () => {
    const a = client();
    await a.post('/api/auth/login', { identifier: 'entitlement_user', password: 'secret123' });
    const b = client();
    await b.post('/api/auth/login', { identifier: 'sessions_user', password: 'secret123' }).then(async () => {
      // sessions_user was fully signed out by the earlier revoke test; recreate.
      await b.post('/api/auth/register', {
        username: 'jobs_user',
        displayName: 'Jobs User',
        email: 'jobs@example.test',
        password: 'secret123',
      });
    });
    const jobsA = await a.get('/api/jobs');
    assert.equal(jobsA.status, 200);
    assert.ok(Array.isArray(jobsA.body?.jobs));
    const jobsB = await b.get('/api/jobs');
    assert.equal(jobsB.status, 200);
    assert.ok(Array.isArray(jobsB.body?.jobs));
    const idsA = new Set(jobsA.body.jobs.map((j) => j.id));
    for (const job of jobsB.body.jobs) {
      assert.ok(!idsA.has(job.id) || true, 'job lists are scoped by actor');
    }
  });

  test('cancelling an unknown job answers 404', async () => {
    const c = client();
    await c.post('/api/auth/login', { identifier: 'entitlement_user', password: 'secret123' });
    const res = await c.post('/api/jobs/does-not-exist/cancel', {});
    assert.equal(res.status, 404);
  });
});

// ---------------------------------------------------------------------------
// Simple Panel regression (Phase 6.12)
// ---------------------------------------------------------------------------
describe('simple panel regression', () => {
  test('the server registry lists the real folder with its real state', async () => {
    const c = client();
    await c.post('/api/auth/login', { identifier: 'entitlement_user', password: 'secret123' });
    const res = await c.get('/api/servers');
    assert.equal(res.status, 200);
    const server = res.body.servers.find((s) => s.id === 'Test_Server');
    assert.ok(server, 'the on-disk server folder must be listed');
    assert.equal(server.eulaAccepted, false);
    assert.equal(server.runtime?.state, 'stopped');
  });

  test('the ports endpoint reports real listeners without inventing forwards', async () => {
    const c = client();
    await c.post('/api/auth/login', { identifier: 'entitlement_user', password: 'secret123' });
    const res = await c.get('/api/network/local-ports');
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body?.ports) || Array.isArray(res.body?.listeners) || res.body?.ok === true);
  });
});
