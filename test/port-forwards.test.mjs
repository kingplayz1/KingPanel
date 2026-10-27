/**
 * Port-forwarding rules — persistence and honesty.
 *
 * The panel cannot apply a mapping (no router, no netsh, no firewall rule), so a
 * stored rule must be (a) really persisted across a restart and (b) reported as
 * `RECORDED`, never as an active/pinhole state. This suite boots the REAL server
 * twice against the same temp data directory to prove both.
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
const STATE_FILE = '.local-port-forwards.json';
const SUPER_ADMIN = { identifier: 'kingplayz', password: 'KingPlayz#2026' };

let tmpDir;
let dataDir;
let child = null;
let baseUrl = '';
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

async function boot() {
  const port = await freePort();
  baseUrl = `http://127.0.0.1:${port}`;
  childLog = '';
  child = spawn(process.execPath, ['--import', 'tsx', 'server.ts'], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      APPDATA_DB_DIR: dataDir,
      NODE_ENV: 'test',
      // Never pop a real UAC prompt from a test run: the apply/revert routes must
      // fail closed instead of escalating.
      KINGPANEL_PORT_FORWARD_ELEVATION: 'off',
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

  const started = Date.now();
  while (Date.now() - started < 45_000) {
    if (child.exitCode !== null) {
      throw new Error(`server exited early (code ${child.exitCode}):\n${childLog}`);
    }
    try {
      const res = await fetch(`${baseUrl}/api/auth/login`);
      if (res.status > 0) return;
    } catch {
      // not listening yet
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`server did not answer within 45s:\n${childLog}`);
}

async function stop() {
  if (!child || child.exitCode !== null) return;
  child.kill();
  await new Promise((r) => setTimeout(r, 400));
  if (child.exitCode === null) child.kill('SIGKILL');
  child = null;
}

function client() {
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
      if (pair.startsWith('king_session=') && pair.length > 'king_session='.length) cookie = pair;
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
    get: (p) => request('GET', p),
    post: (p, b) => request('POST', p, b),
    del: (p) => request('DELETE', p),
    async login() {
      const res = await request('POST', '/api/auth/login', SUPER_ADMIN);
      assert.equal(res.status, 200, `super-admin login failed: ${res.text.slice(0, 200)}`);
    },
  };
}

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'iskingpanel-fwd-'));
  dataDir = path.join(tmpDir, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  await boot();
});

after(async () => {
  await stop();
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    // best effort
  }
});

describe('port forwarding rules', () => {
  const rule = {
    externalPort: 25565,
    internalPort: 25565,
    internalIp: '127.0.0.1',
    protocol: 'TCP/UDP',
    serviceName: 'Test rule',
    method: 'UPnP IGDv2',
  };

  test('an anonymous caller cannot create a rule', async () => {
    const c = client();
    const res = await c.post('/api/network/forward', rule);
    assert.equal(res.status, 401);
  });

  test('a signed-in account without the Discord role is refused', async () => {
    const c = client();
    await c.post('/api/auth/register', {
      username: 'fwd_plain',
      displayName: 'Fwd Plain',
      email: 'fwd@example.test',
      password: 'secret123',
    });
    const res = await c.post('/api/network/forward', rule);
    assert.equal(res.status, 403);
    assert.equal(res.body?.code, 'ADVANCED_PANEL_REQUIRED');
  });

  test('invalid payloads are rejected with a reason', async () => {
    const c = client();
    await c.login();

    const outOfRange = await c.post('/api/network/forward', { ...rule, externalPort: 70000 });
    assert.equal(outOfRange.status, 400);

    const zero = await c.post('/api/network/forward', { ...rule, internalPort: 0 });
    assert.equal(zero.status, 400);

    const badProto = await c.post('/api/network/forward', { ...rule, protocol: 'SCTP' });
    assert.equal(badProto.status, 400);

    const badIp = await c.post('/api/network/forward', {
      ...rule,
      internalIp: '127.0.0.1; rm -rf /',
    });
    assert.equal(badIp.status, 400);

    const badMethod = await c.post('/api/network/forward', { ...rule, method: 'Magic' });
    assert.equal(badMethod.status, 400);

    // Nothing above may have been stored.
    const statePath = path.join(dataDir, STATE_FILE);
    assert.equal(fs.existsSync(statePath), false, 'rejected input must not write the rule store');
  });

  test('a valid rule is stored as RECORDED, not ACTIVE', async () => {
    const c = client();
    await c.login();
    const res = await c.post('/api/network/forward', rule);
    assert.equal(res.status, 200, res.text.slice(0, 300));
    assert.equal(res.body.ok, true);
    assert.equal(res.body.applied, false, 'the panel must not claim it applied the mapping');
    assert.equal(res.body.rule.status, 'RECORDED');
    assert.equal(res.body.rule.externalPort, 25565);
    assert.match(String(res.body.note || ''), /nothing was applied/i);
    assert.match(String(res.body.commands?.netsh || ''), /netsh interface portproxy/);

    // Written to disk, not only held in memory.
    const statePath = path.join(dataDir, STATE_FILE);
    assert.ok(fs.existsSync(statePath), 'the rule store must exist on disk');
    const stored = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    assert.equal(stored.forwards.length, 1);
    assert.equal(stored.forwards[0].status, 'RECORDED');
  });

  test('the scan endpoint lists the rule from the backend', async () => {
    const c = client();
    await c.login();
    const res = await c.get('/api/network/local-ports');
    assert.equal(res.status, 200);
    const listed = res.body.forwards.find((f) => f.internalPort === 25565);
    assert.ok(listed, 'the stored rule must be returned by the scan');
    assert.equal(listed.status, 'RECORDED');
    assert.ok(listed.liveProbe, 'a live local probe must be attached');
  });

  test('apply is refused without elevation and never claims success', async () => {
    const c = client();
    await c.login();

    // A disposable rule so the main 25565 assertions stay independent of what
    // this machine happens to have in netsh.
    const created = await c.post('/api/network/forward', {
      ...rule,
      externalPort: 25567,
      internalPort: 25567,
      serviceName: 'Apply probe',
    });
    assert.equal(created.status, 200, created.text.slice(0, 300));

    try {
      const applied = await c.post('/api/network/forward/25567/apply', {});
      assert.equal(applied.status, 503);
      assert.equal(applied.body?.code, 'ELEVATION_DISABLED');
      assert.equal(applied.body?.rule?.status, 'FAILED');
      assert.notEqual(applied.body?.rule?.status, 'ACTIVE');
      assert.match(String(applied.body?.error || ''), /Elevation is disabled/i);

      const verified = await c.post('/api/network/forward/25567/verify', {});
      if (verified.status === 501) {
        assert.equal(verified.body?.code, 'UNSUPPORTED_PLATFORM');
      } else {
        assert.equal(verified.status, 200);
        assert.equal(typeof verified.body?.verified, 'boolean');
        // A rule may only read ACTIVE when the OS read-back actually matched.
        assert.equal(
          verified.body.rule.status === 'ACTIVE',
          verified.body.verified === true,
          'status must follow the read-back, never the stored claim'
        );
      }

      const reverted = await c.post('/api/network/forward/25567/revert', {});
      assert.equal(reverted.status, 503);
      assert.equal(reverted.body?.code, 'ELEVATION_DISABLED');
      assert.notEqual(reverted.body?.rule?.status, 'ACTIVE');

      const unknown = await c.post('/api/network/forward/25999/apply', {});
      assert.equal(unknown.status, 404);
    } finally {
      // Always drop the disposable rule: later assertions expect exactly one.
      const removed = await c.del('/api/network/forward/25567');
      assert.equal(removed.status, 200, removed.text.slice(0, 200));
    }
  });

  test('removing an unknown port answers 404 and removes nothing', async () => {
    const c = client();
    await c.login();
    const res = await c.del('/api/network/forward/12345');
    assert.equal(res.status, 404);

    const listed = await c.get('/api/network/local-ports');
    assert.equal(listed.body.forwards.length, 1, 'the existing rule must survive');
  });
});

describe('elevated apply self-test', () => {
  test('anonymous callers and unentitled accounts cannot run it', async () => {
    const anon = client();
    const unauthorized = await anon.post('/api/network/forward/self-test', {});
    assert.equal(unauthorized.status, 401);

    const plain = client();
    const reg = await plain.post('/api/auth/register', {
      username: 'selftest_plain',
      displayName: 'Self Test Plain',
      email: 'selftest@example.test',
      password: 'secret123',
    });
    assert.ok([200, 400, 409].includes(reg.status), reg.text.slice(0, 200));
    assert.equal((await plain.post('/api/auth/login', { identifier: 'selftest_plain', password: 'secret123' })).status, 200);

    const forbidden = await plain.post('/api/network/forward/self-test', {});
    assert.equal(forbidden.status, 403);
    assert.equal(forbidden.body?.code, 'ADVANCED_PANEL_REQUIRED');
  });

  test('without elevation it reports nothing proven and records no rule', async () => {
    const c = client();
    await c.login();

    const statePath = path.join(dataDir, STATE_FILE);
    const countStored = () =>
      fs.existsSync(statePath)
        ? JSON.parse(fs.readFileSync(statePath, 'utf8')).forwards.length
        : 0;
    const before = countStored();

    const res = await c.post('/api/network/forward/self-test', {});
    assert.equal(res.status, 503, res.text.slice(0, 400));
    assert.equal(res.body?.ok, false);
    assert.equal(res.body?.proven, false, 'a blocked apply must never be reported as proven');
    assert.equal(res.body?.code, 'ELEVATION_DISABLED');
    assert.equal(res.body?.cleanup, 'nothing-to-clean');

    const port = res.body?.port;
    assert.ok(
      Number.isInteger(port) && port >= 49152 && port <= 65535,
      `the throwaway port must come from the private range, got ${port}`
    );
    assert.equal(res.body?.target?.externalPort, port);
    assert.equal(res.body?.target?.internalPort, port);
    assert.equal(res.body?.target?.internalIp, '127.0.0.1');

    assert.equal(res.body?.stages?.length, 1, 'no revert stage should be attempted');
    assert.equal(res.body?.stages[0].name, 'apply');
    assert.equal(res.body?.stages[0].ok, false);
    assert.equal(res.body?.stages[0].code, 'ELEVATION_DISABLED');

    // The probe is not a rule: the store and the scan stay untouched.
    assert.equal(countStored(), before, 'a self-test must never record a rule');
    const listed = await c.get('/api/network/local-ports');
    assert.equal(listed.body.forwards.length, before);
    assert.ok(
      !listed.body.forwards.some((rule) => rule.externalPort === port),
      'the throwaway port must not appear as a stored rule'
    );
  });
});

describe('port forwarding survives a restart', () => {
  test('the rule is still listed after the backend is restarted', async () => {
    await stop();
    await boot();

    const c = client();
    await c.login();
    const res = await c.get('/api/network/local-ports');
    assert.equal(res.status, 200);
    const listed = res.body.forwards.find((f) => f.internalPort === 25565);
    assert.ok(listed, 'a saved rule must be re-read from disk on boot');
    assert.equal(listed.status, 'RECORDED');
    assert.equal(listed.serviceName, 'Test rule');
  });

  test('deleting the rule removes it from disk too', async () => {
    const c = client();
    await c.login();
    const res = await c.del('/api/network/forward/25565');
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);

    const stored = JSON.parse(fs.readFileSync(path.join(dataDir, STATE_FILE), 'utf8'));
    assert.equal(stored.forwards.length, 0);

    const listed = await c.get('/api/network/local-ports');
    assert.equal(listed.body.forwards.length, 0);
  });
});
