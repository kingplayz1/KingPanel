/**
 * State-directory pin and one-time migration.
 *
 * Runs the real migration against real SQLite files: the point of the module is
 * that a bad copy cannot cost an installation its account database, so these
 * tests are about data survival, not about log lines.
 *
 * Run with:  npm test
 */
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  migrateLegacyStateDir,
  looksLikeSqliteFile,
  verifySqliteReadable,
} from '../server/state-dir.ts';

const DB_FILE = 'isking_panel.sqlite';

let root;
let legacyDir;
let stateDir;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'iskingpanel-state-'));
  legacyDir = path.join(root, 'react-example', 'database');
  stateDir = path.join(root, 'IS King Panel', 'database');
  fs.mkdirSync(legacyDir, { recursive: true });
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

/** A legacy installation: a real database with an account row, plus state JSON. */
function seedLegacyInstall({ username = 'kingplayz' } = {}) {
  const dbPath = path.join(legacyDir, DB_FILE);
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE users (
      id TEXT PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL,
      is_super_admin INTEGER DEFAULT 0
    );
    CREATE TABLE auth_sessions (session_id TEXT PRIMARY KEY, user_id TEXT NOT NULL);
  `);
  db.prepare('INSERT INTO users (id, username, email, password_hash, role, is_super_admin) VALUES (?,?,?,?,?,?)').run(
    'SA-KINGPLAYZ-001',
    username,
    `${username}@example.test`,
    'scrypt$16384$8$1$c2FsdA==$aGFzaA==',
    'Super Admin',
    1
  );
  db.close();

  fs.writeFileSync(path.join(legacyDir, '.local-users-db.json'), JSON.stringify([{ username }], null, 2));
  fs.writeFileSync(path.join(legacyDir, 'FIRST-RUN-CREDENTIALS.txt'), 'kingplayz\tgenerated-pass\tnote\n');
  return dbPath;
}

function readUsers(dir) {
  const db = new DatabaseSync(path.join(dir, DB_FILE), { readOnly: true });
  try {
    return db.prepare('SELECT username, role FROM users').all();
  } finally {
    db.close();
  }
}

describe('state directory migration', () => {
  test('a clean install is a no-op and creates nothing', () => {
    const result = migrateLegacyStateDir({ stateDir, legacyDir });
    assert.equal(result.status, 'skipped-no-legacy-state');
    assert.equal(fs.existsSync(stateDir), false, 'no directory may be created for a clean install');
  });

  test('a legacy install is migrated with its data intact', () => {
    seedLegacyInstall();

    const result = migrateLegacyStateDir({ stateDir, legacyDir });
    assert.equal(result.status, 'migrated', result.error);
    assert.ok(result.copied.includes(DB_FILE));
    assert.ok(result.copied.includes('.local-users-db.json'));
    assert.ok(result.copied.includes('FIRST-RUN-CREDENTIALS.txt'));

    const users = readUsers(stateDir);
    assert.equal(users.length, 1);
    assert.equal(users[0].username, 'kingplayz');
    assert.equal(users[0].role, 'Super Admin');

    // The source is copied, never consumed.
    assert.ok(fs.existsSync(path.join(legacyDir, DB_FILE)), 'the original must remain');
    assert.ok(result.snapshot, 'a timestamped snapshot must be reported');
    assert.ok(fs.existsSync(path.join(legacyDir, path.basename(result.snapshot))));
  });

  test('the migration records itself and is idempotent', () => {
    seedLegacyInstall();
    assert.equal(migrateLegacyStateDir({ stateDir, legacyDir }).status, 'migrated');

    const marker = JSON.parse(fs.readFileSync(path.join(stateDir, '.state-migration.json'), 'utf8'));
    assert.equal(marker.from, legacyDir);
    assert.equal(marker.to, stateDir);
    assert.match(marker.sourceDatabaseSha256, /^[0-9a-f]{64}$/);

    // A second start must not touch the migrated database (nor re-snapshot it).
    const before = fs.statSync(path.join(stateDir, DB_FILE)).mtimeMs;
    const second = migrateLegacyStateDir({ stateDir, legacyDir });
    assert.equal(second.status, 'skipped-destination-present');
    assert.equal(fs.statSync(path.join(stateDir, DB_FILE)).mtimeMs, before);
  });

  test('newer destination data is never overwritten', () => {
    seedLegacyInstall();
    fs.mkdirSync(stateDir, { recursive: true });
    // A destination that already exists wins, even with a different row.
    const dest = new DatabaseSync(path.join(stateDir, DB_FILE));
    dest.exec('CREATE TABLE users (id TEXT PRIMARY KEY, username TEXT, email TEXT, password_hash TEXT, role TEXT, is_super_admin INTEGER)');
    dest.prepare('INSERT INTO users (id, username, role) VALUES (?,?,?)').run('x', 'destination_user', 'Operator');
    dest.close();

    const result = migrateLegacyStateDir({ stateDir, legacyDir });
    assert.equal(result.status, 'skipped-destination-present');
    const users = readUsers(stateDir);
    assert.equal(users.length, 1);
    assert.equal(users[0].username, 'destination_user');
  });

  test('a corrupt legacy database fails closed and writes nothing', () => {
    fs.writeFileSync(path.join(legacyDir, DB_FILE), Buffer.from('SQLite format 3\0 truncated garbage'));
    fs.writeFileSync(path.join(legacyDir, '.local-users-db.json'), JSON.stringify([{ username: 'x' }]));

    const result = migrateLegacyStateDir({ stateDir, legacyDir });
    assert.equal(result.status, 'failed');
    assert.match(String(result.error), /not a readable SQLite file|verification/);
    assert.equal(fs.existsSync(path.join(stateDir, DB_FILE)), false, 'no database may be created');
    // The original is untouched so the operator can recover it.
    assert.ok(fs.existsSync(path.join(legacyDir, DB_FILE)));
  });

  test('a readable file that is not our database fails closed', () => {
    // Valid SQLite, but no users table: trusting it would silently replace the
    // account store with an empty one.
    const db = new DatabaseSync(path.join(legacyDir, DB_FILE));
    db.exec('CREATE TABLE something_else (id INTEGER PRIMARY KEY)');
    db.close();

    const result = migrateLegacyStateDir({ stateDir, legacyDir });
    assert.equal(result.status, 'failed');
    assert.match(String(result.error), /users table/);
    assert.equal(fs.existsSync(path.join(stateDir, DB_FILE)), false);
  });

  test('structural checks reject non-SQLite files and accept a real one', () => {
    seedLegacyInstall();
    assert.equal(looksLikeSqliteFile(path.join(legacyDir, DB_FILE)), true);
    assert.equal(verifySqliteReadable(path.join(legacyDir, DB_FILE)), null);

    const junk = path.join(legacyDir, 'junk.bin');
    fs.writeFileSync(junk, Buffer.alloc(2048, 0x41));
    assert.equal(looksLikeSqliteFile(junk), false);
  });
});
