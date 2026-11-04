/**
 * Installed-upgrade behaviour of the pinned state directory, exercised through a
 * real server boot.
 *
 * `test/state-dir.test.mjs` proves the migration module. This file proves the
 * backend wiring: with APPDATA_DB_DIR pointing at the new location and
 * LEGACY_APPDATA_DB_DIR at the old one, an existing installation's accounts are
 * found and can sign in, and a failed migration refuses to start an empty store.
 *
 * Run with:  npm test
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { DatabaseSync } from 'node:sqlite';
import { hashPassword } from '../server/password.ts';

const REPO_ROOT = path.resolve(import.meta.dirname, '..');
const DB_FILE = 'isking_panel.sqlite';

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

async function startWith({ dataDir, legacyDir }) {
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const log = { text: '' };
  const child = spawn(process.execPath, ['--import', 'tsx', 'server.ts'], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      APPDATA_DB_DIR: dataDir,
      ...(legacyDir ? { LEGACY_APPDATA_DB_DIR: legacyDir } : {}),
      NODE_ENV: 'test',
      OAUTH_TOKEN_KEY: '',
      MONGODB_URI: '',
      DISCORD_BOT_TOKEN: '',
      DISCORD_CLIENT_ID: '',
      DISCORD_CLIENT_SECRET: '',
      GITHUB_CLIENT_ID: '',
      GOOGLE_CLIENT_ID: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (d) => (log.text += d.toString()));
  child.stderr.on('data', (d) => (log.text += d.toString()));

  const started = Date.now();
  while (Date.now() - started < 60_000) {
    if (child.exitCode !== null) throw new Error(`server exited early:\n${log.text}`);
    try {
      const res = await fetch(`${baseUrl}/api/auth/login`);
      if (res.status > 0) break;
    } catch {
      // not listening yet
    }
    await new Promise((r) => setTimeout(r, 200));
  }

  const client = () => {
    let cookie = '';
    return {
      get cookie() {
        return cookie;
      },
      async post(pathname, body) {
        const res = await fetch(`${baseUrl}${pathname}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...(cookie ? { cookie } : {}) },
          body: JSON.stringify(body),
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
      },
      async get(pathname) {
        const res = await fetch(`${baseUrl}${pathname}`, { headers: cookie ? { cookie } : {} });
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
  };

  return {
    baseUrl,
    log,
    client,
    async stop() {
      if (child.exitCode === null) {
        child.kill();
        await new Promise((r) => setTimeout(r, 300));
        if (child.exitCode === null) child.kill('SIGKILL');
      }
    },
  };
}

/** A database shaped like an older build: only the columns that build had. */
function seedLegacyDatabase(dir, { username, password }) {
  fs.mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(path.join(dir, DB_FILE));
  db.exec(`
    CREATE TABLE users (
      id TEXT PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL,
      is_super_admin INTEGER DEFAULT 0,
      created_at TEXT NOT NULL
    );
    CREATE TABLE auth_sessions (
      session_id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      username TEXT NOT NULL,
      role TEXT NOT NULL,
      provider TEXT NOT NULL,
      ip_address TEXT,
      platform TEXT,
      created_at TEXT NOT NULL,
      last_active_at TEXT NOT NULL
    );
  `);
  db.prepare(
    'INSERT INTO users (id, username, email, password_hash, role, is_super_admin, created_at) VALUES (?,?,?,?,?,?,?)'
  ).run('SA-KINGPLAYZ-001', username, `${username}@example.test`, hashPassword(password), 'Super Admin', 1, new Date().toISOString());
  db.close();
  fs.writeFileSync(path.join(dir, 'FIRST-RUN-CREDENTIALS.txt'), `${username}\tnot-used-by-this-test\tlegacy\n`);
}

let root;

before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'iskingpanel-upgrade-'));
});

after(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('an existing installation is carried over', () => {
  test('its accounts still sign in after the directory pin', async () => {
    const legacyDir = path.join(root, 'legacy', 'react-example', 'database');
    const dataDir = path.join(root, 'pinned', 'IS King Panel', 'database');
    const password = 'LegacyInstall#2026';
    seedLegacyDatabase(legacyDir, { username: 'kingplayz', password });

    let state = await startWith({ dataDir, legacyDir });
    try {
      const login = await state.client().post('/api/auth/login', { identifier: 'kingplayz', password });
      assert.equal(login.status, 200, `the migrated account must sign in:\n${login.text.slice(0, 300)}\n${state.log.text.slice(-800)}`);
      assert.equal(login.body?.user?.username, 'kingplayz');
      assert.equal(login.body?.user?.isSuperAdmin, true);

      // The new location received the database and recorded the migration.
      assert.ok(fs.existsSync(path.join(dataDir, DB_FILE)));
      const marker = JSON.parse(fs.readFileSync(path.join(dataDir, '.state-migration.json'), 'utf8'));
      assert.equal(path.resolve(marker.from), path.resolve(legacyDir));

      // The original is still there, with a snapshot beside it.
      assert.ok(fs.existsSync(path.join(legacyDir, DB_FILE)));
      assert.ok(
        fs.readdirSync(legacyDir).some((name) => name.includes('.premigration-')),
        'the pre-migration snapshot must exist'
      );
    } finally {
      await state.stop();
    }

    // A second launch must reuse the migrated database, not migrate again.
    state = await startWith({ dataDir, legacyDir });
    try {
      const again = await state.client().post('/api/auth/login', { identifier: 'kingplayz', password });
      assert.equal(again.status, 200, 'the account must survive a second launch');
    } finally {
      await state.stop();
    }
  });

  test('a clean install bootstraps in the pinned directory', async () => {
    const dataDir = path.join(root, 'clean', 'database');
    const state = await startWith({ dataDir, legacyDir: null });
    try {
      assert.ok(fs.existsSync(path.join(dataDir, DB_FILE)), 'the database is created in APPDATA_DB_DIR');
      const credentials = fs
        .readFileSync(path.join(dataDir, 'FIRST-RUN-CREDENTIALS.txt'), 'utf8')
        .split(/\r?\n/)
        .find((line) => line.startsWith('kingplayz\t'));
      assert.ok(credentials, 'a bootstrap credential must be issued');
      const password = credentials.split('\t')[1];

      const login = await state.client().post('/api/auth/login', { identifier: 'kingplayz', password });
      assert.equal(login.status, 200, login.text.slice(0, 300));
    } finally {
      await state.stop();
    }
  });

  test('a broken legacy database stops the app instead of starting empty', async () => {
    const legacyDir = path.join(root, 'broken', 'react-example', 'database');
    const dataDir = path.join(root, 'broken', 'IS King Panel', 'database');
    fs.mkdirSync(legacyDir, { recursive: true });
    fs.writeFileSync(path.join(legacyDir, DB_FILE), Buffer.from('this is not a sqlite database'));

    const state = await startWith({ dataDir, legacyDir });
    try {
      const login = await state.client().post('/api/auth/login', {
        identifier: 'kingplayz',
        password: 'anything-at-all',
      });
      assert.equal(login.status, 503, `expected a fail-closed 503, got ${login.status}: ${login.text.slice(0, 200)}`);
      assert.equal(login.body?.code, 'ACCOUNT_STORE_UNAVAILABLE');
      assert.equal(fs.existsSync(path.join(dataDir, DB_FILE)), false, 'no empty database may be created');
      assert.ok(
        fs.existsSync(path.join(legacyDir, DB_FILE)),
        'the unreadable original must be left for the operator'
      );
    } finally {
      await state.stop();
    }
  });
});
