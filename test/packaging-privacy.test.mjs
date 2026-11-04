/**
 * Packaged-artifact privacy — failure injection.
 *
 * The leak this gate exists for was not a weird filename: `build.files` simply
 * listed `database/**`, and the developer's account database — password hashes,
 * OAuth-token state, five users — went into every locally built installer. A
 * blocklist of suspicious names would have missed it entirely, so these tests
 * pin down the allowlist, the content checks that back it up, and the fact that a
 * clean package still passes.
 *
 * Run with:  npm test
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { readAsar, listAsarEntries, readAsarEntry } from '../scripts/asar-entries.mjs';
import {
  PACKAGED_PAYLOAD,
  PACKAGED_RESOURCES,
  sqliteRowCounts,
  statePathReason,
  verifyPackagedPrivacy,
} from '../scripts/packaging-privacy.mjs';
import {
  fixtureConfig,
  fixtureDir,
  validateFromVersion,
} from '../scripts/make-upgrade-fixtures.mjs';

const require = createRequire(import.meta.url);

let work;

before(() => {
  work = fs.mkdtempSync(path.join(os.tmpdir(), 'isk-privacy-'));
});

after(() => {
  fs.rmSync(work, { recursive: true, force: true });
});

function freshDir(label = 'pkg') {
  return fs.mkdtempSync(path.join(work, `${label}-`));
}

/**
 * A minimal, spec-shaped asar writer.
 *
 * Deliberately independent of electron-builder's implementation: the gate has to
 * read archives this project's tests produce, and a reader validated only against
 * the writer it ships with proves nothing.
 */
function buildAsar(entries) {
  const tree = { files: {} };
  const blobs = [];
  let offset = 0;
  for (const entry of entries) {
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data ?? '', 'utf8');
    const segments = entry.path.split('/');
    let node = tree;
    for (const segment of segments.slice(0, -1)) {
      node.files[segment] ??= { files: {} };
      node = node.files[segment];
    }
    node.files[segments[segments.length - 1]] = { size: data.length, offset: String(offset) };
    blobs.push(data);
    offset += data.length;
  }

  const json = Buffer.from(JSON.stringify(tree), 'utf8');
  const aligned = Math.ceil(json.length / 4) * 4;
  const payloadSize = 4 + aligned;
  const headerSize = 4 + payloadSize;
  const prologue = Buffer.alloc(8);
  prologue.writeUInt32LE(4, 0);
  prologue.writeUInt32LE(headerSize, 4);
  const header = Buffer.alloc(8 + aligned);
  header.writeUInt32LE(payloadSize, 0);
  header.writeUInt32LE(json.length, 4);
  json.copy(header, 8);
  return Buffer.concat([prologue, header, ...blobs]);
}

/**
 * Build a packaged app tree: `payload` goes into app.asar, `disk` lands in
 * `resources/` (that is where extraResources and unpacked files end up).
 */
function makePackage({ payload = [], disk = {}, omitAsar = false } = {}) {
  const dir = freshDir();
  const resources = path.join(dir, 'win-unpacked', 'resources');
  fs.mkdirSync(resources, { recursive: true });
  if (!omitAsar) {
    fs.writeFileSync(path.join(resources, 'app.asar'), buildAsar(payload));
  }
  fs.writeFileSync(path.join(resources, 'app-update.yml'), 'provider: github\nowner: kingplayz1\n');
  fs.writeFileSync(path.join(resources, 'elevate.exe'), Buffer.alloc(2048, 7));
  fs.mkdirSync(path.join(resources, 'runtime'), { recursive: true });
  fs.writeFileSync(path.join(resources, 'runtime', 'node.exe'), Buffer.alloc(4096, 3));
  fs.writeFileSync(path.join(resources, 'runtime', 'LICENSE'), 'Node.js licence\n');
  fs.mkdirSync(path.join(resources, 'app.asar.unpacked'), { recursive: true });
  fs.writeFileSync(path.join(resources, 'app.asar.unpacked', 'server.cjs'), 'module.exports = {};\n');

  for (const [rel, contents] of Object.entries(disk)) {
    const abs = path.join(resources, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, Buffer.isBuffer(contents) ? contents : String(contents));
  }
  return dir;
}

const CLEAN_PAYLOAD = [
  { path: 'dist/index.html', data: '<!doctype html><html></html>' },
  { path: 'package.json', data: JSON.stringify({ name: 'react-example', version: '1.0.2' }) },
  { path: 'server.cjs', data: 'const db = "password_hash"; module.exports = {};' },
  { path: 'node_modules/@electron/whatever/index.js', data: 'module.exports = 1;' },
  { path: 'node_modules/some-pkg/test/fixture.js', data: '// a dependency test file' },
  { path: 'src/db/schema.sql', data: 'CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY);' },
  { path: 'src/App.tsx', data: 'export const App = () => null;' },
];

/** A real SQLite database, because a magic-byte check must be tested for real. */
function makeSqlite({ users = 1 } = {}) {
  let DatabaseSync;
  try {
    ({ DatabaseSync } = require('node:sqlite'));
  } catch {
    return null;
  }
  const file = path.join(freshDir('sqlite'), 'db.sqlite');
  const db = new DatabaseSync(file);
  db.exec('CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT, password_hash TEXT)');
  db.exec('CREATE TABLE server_owners (id INTEGER PRIMARY KEY, folder TEXT, user_id INTEGER)');
  for (let i = 0; i < users; i += 1) {
    db.prepare('INSERT INTO users (username, password_hash) VALUES (?, ?)').run(`user${i}`, '$2b$12$fakehash');
  }
  db.close();
  return fs.readFileSync(file);
}

describe('asar reader', () => {
  test('lists every file and reads their exact bytes', () => {
    const entries = [
      { path: 'a.txt', data: 'alpha' },
      { path: 'nested/deep/b.bin', data: Buffer.from([0, 1, 2, 250, 251]) },
      { path: 'package.json', data: '{"v":1}' },
    ];
    const dir = makePackage({ payload: entries });
    const asarPath = path.join(dir, 'win-unpacked', 'resources', 'app.asar');

    const listed = listAsarEntries(asarPath).sort();
    assert.deepEqual(listed, entries.map((entry) => entry.path).sort());
    for (const entry of entries) {
      const read = readAsarEntry(asarPath, entry.path);
      assert.ok(read, `${entry.path} should be readable`);
      assert.deepEqual([...read], [...Buffer.from(entry.data)]);
    }
  });

  test('a truncated archive is reported, not silently empty', () => {
    const dir = makePackage({ payload: [{ path: 'a.txt', data: 'x' }] });
    const asarPath = path.join(dir, 'win-unpacked', 'resources', 'app.asar');
    fs.truncateSync(asarPath, 6);
    assert.throws(() => readAsar(asarPath), /too short|header/);
  });
});

describe('a clean package', () => {
  test('passes, including a dependency test file and an SQL schema', () => {
    const result = verifyPackagedPrivacy({ dir: makePackage({ payload: CLEAN_PAYLOAD }) });
    assert.deepEqual(result.problems, []);
    assert.equal(result.facts.payloadEntries + result.facts.dependencyEntries, CLEAN_PAYLOAD.length);
    assert.equal(result.facts.dependencyEntries, 2);
  });

  test('a schema-only SQL file is payload, an SQLite binary is not', () => {
    assert.equal(statePathReason('src/db/0001_init.sql'), null);
    assert.match(statePathReason('database/isking_panel.sqlite'), /SQLite|state directory/);
    assert.match(statePathReason('app.asar.unpacked/isking_panel.sqlite'), /SQLite/);
  });
});

describe('developer data in the package', () => {
  test('the exact leak that motivated this gate', () => {
    const sqlite = makeSqlite({ users: 3 });
    const dir = makePackage({
      payload: [
        ...CLEAN_PAYLOAD,
        { path: 'database/isking_panel.sqlite', data: sqlite ?? Buffer.concat([Buffer.from('SQLite format 3\0'), Buffer.alloc(600)]) },
        { path: 'database/.local-users-db.json', data: JSON.stringify({ users: [{ username: 'kingplayz', passwordHash: '$2b$12$x' }] }) },
      ],
    });
    const joined = verifyPackagedPrivacy({ dir }).problems.join('\n');
    assert.match(joined, /database\/isking_panel\.sqlite/);
    assert.match(joined, /password hash/);
    if (sqlite) assert.match(joined, /users=3/, 'the row count makes the leak undeniable');
  });

  test('a SQLite database renamed to something innocuous on disk', () => {
    const sqlite = makeSqlite({ users: 2 });
    if (!sqlite) return;
    const result = verifyPackagedPrivacy({ dir: makePackage({ disk: { 'blob.dat': sqlite } }) });
    assert.match(result.problems.join('\n'), /blob\.dat is a SQLite database .*users=2/);
  });

  test('an unexpected resources directory is rejected by the allowlist', () => {
    const result = verifyPackagedPrivacy({ dir: makePackage({ disk: { 'database/notes.txt': 'x' } }) });
    assert.match(result.problems.join('\n'), /resources\/database is packaged into the installer/);
  });

  test('environment files', () => {
    for (const name of ['.env', '.env.local', '.env.production']) {
      const result = verifyPackagedPrivacy({ dir: makePackage({ payload: [...CLEAN_PAYLOAD, { path: name, data: 'API_KEY=abc' }] }) });
      assert.match(result.problems.join('\n'), new RegExp(`carries ${name.replace(/\./g, '\\.')}`), name);
    }
  });

  test('a renamed env file is caught by its contents', () => {
    const result = verifyPackagedPrivacy({
      dir: makePackage({ payload: [...CLEAN_PAYLOAD, { path: 'dist/config.json', data: '{"client_secret":"abc123"}' }] }),
    });
    assert.match(result.problems.join('\n'), /dist\/config\.json, which contains an OAuth client secret/);
  });

  test('session and OAuth state', () => {
    const result = verifyPackagedPrivacy({
      dir: makePackage({
        payload: [
          ...CLEAN_PAYLOAD,
          { path: 'sessions.json', data: JSON.stringify({ sid: { accessToken: 'ya29.abc' } }) },
          { path: '.panel-sessions.json', data: '{}' },
          { path: '.local-operator-profile.json', data: '{}' },
          { path: 'database-state.json', data: '{"accessToken":"ya29.secret-token"}' },
        ],
      }),
    });
    const joined = result.problems.join('\n');
    assert.match(joined, /sessions\.json/);
    assert.match(joined, /\.panel-sessions\.json/);
    assert.match(joined, /\.local-operator-profile\.json/);
    assert.match(joined, /database-state\.json, which contains an OAuth/);
  });

  test('recovery codes', () => {
    const result = verifyPackagedPrivacy({
      dir: makePackage({ payload: [...CLEAN_PAYLOAD, { path: 'FIRST-RUN-CREDENTIALS.txt', data: 'kingplayz\tpw\trecovery code\n' }] }),
    });
    assert.match(result.problems.join('\n'), /generated Super Admin password and recovery codes/);
  });

  test('a private key is never acceptable, even inside a dependency', () => {
    const result = verifyPackagedPrivacy({
      dir: makePackage({ payload: [...CLEAN_PAYLOAD, { path: 'node_modules/dep/id_rsa', data: 'x' }, { path: 'node_modules/dep/cert.pfx', data: 'x' }] }),
    });
    const joined = result.problems.join('\n');
    assert.match(joined, /node_modules\/dep\/id_rsa \(private key\)/);
    assert.match(joined, /node_modules\/dep\/cert\.pfx \(key or certificate material\)/);
  });

  test('logs and test fixtures', () => {
    const result = verifyPackagedPrivacy({
      dir: makePackage({
        payload: [
          ...CLEAN_PAYLOAD,
          { path: 'logs/app.log', data: 'debug' },
          { path: 'dist/2026-10-08-1.log.gz', data: 'x' },
          { path: 'src/fixtures/panel.json', data: '{}' },
          { path: 'src/App.test.tsx', data: 'test()' },
        ],
      }),
    });
    const joined = result.problems.join('\n');
    assert.match(joined, /logs\/app\.log \(log file\)/);
    assert.match(joined, /2026-10-08-1\.log\.gz/);
    assert.match(joined, /src\/fixtures\/panel\.json \(test fixture\)/);
    assert.match(joined, /src\/App\.test\.tsx \(test file\)/);
  });

  test('a payload file outside the allowlist', () => {
    const result = verifyPackagedPrivacy({
      dir: makePackage({ payload: [...CLEAN_PAYLOAD, { path: 'notes-from-the-author.txt', data: 'hi' }] }),
    });
    assert.match(result.problems.join('\n'), /not an allowed payload file/);
  });

  test('backups of runtime data', () => {
    const result = verifyPackagedPrivacy({
      dir: makePackage({ disk: { 'app.asar.unpacked/isking_panel.sqlite.premigration-2026.bak': 'x' } }),
    });
    assert.match(result.problems.join('\n'), /backup copy of runtime data/);
  });

  test('a missing or unreadable app.asar fails instead of passing silently', () => {
    assert.match(verifyPackagedPrivacy({ dir: makePackage({ omitAsar: true }) }).problems.join('\n'), /app\.asar is missing/);

    const dir = makePackage({ payload: CLEAN_PAYLOAD });
    fs.writeFileSync(path.join(dir, 'win-unpacked', 'resources', 'app.asar'), 'not an archive at all');
    assert.match(verifyPackagedPrivacy({ dir }).problems.join('\n'), /app\.asar could not be read/);

    assert.match(verifyPackagedPrivacy({ dir: path.join(work, 'nope') }).problems.join('\n'), /packaged resources are missing/);
  });
});

describe('allowlists', () => {
  test('resources and payload allowlists name only application files', () => {
    for (const name of PACKAGED_RESOURCES) {
      assert.equal(statePathReason(name), null, `${name} must be a legitimate resource`);
    }
    for (const entry of PACKAGED_PAYLOAD) {
      assert.equal(statePathReason(entry.replace(/\/$/, '/index.js')), null, `${entry} must be legitimate payload`);
    }
    assert.ok(!PACKAGED_RESOURCES.includes('database'));
    assert.ok(!PACKAGED_PAYLOAD.some((entry) => entry.startsWith('database')));
  });

  test('row counts report numbers, never values', () => {
    const sqlite = makeSqlite({ users: 4 });
    if (!sqlite) return;
    const info = sqliteRowCounts(sqlite);
    assert.equal(info.available, true);
    assert.equal(info.counts.users, 4);
    assert.equal(info.counts.server_owners, 0);
    // Only tables that actually hold rows are called out.
    assert.deepEqual(info.sensitive, ['users']);
    assert.ok(!JSON.stringify(info).includes('$2b$'), 'no hash may appear in the report');
  });
});

describe('upgrade fixtures', () => {
  const pkg = {
    version: '1.0.2',
    build: {
      productName: 'IS King Panel',
      directories: { output: 'dist_electron' },
      files: ['dist/**/*', '!database/**/*'],
      extraResources: [{ from: 'runtime', to: 'runtime', filter: ['node.exe'] }],
      nsis: { include: 'build/installer.nsh', oneClick: false, perMachine: true },
      publish: { provider: 'github', owner: 'kingplayz1', repo: 'KingPanel' },
    },
  };

  test('the fixture is installable without elevation and reads the test feed', () => {
    const config = fixtureConfig(pkg, { version: '1.0.1', outDir: 'X:/out' });
    assert.equal(config.extraMetadata.version, '1.0.1');
    assert.equal(config.directories.output, 'X:/out');
    assert.equal(config.nsis.perMachine, false);
    assert.equal(config.nsis.oneClick, false);
    assert.equal(config.nsis.include, 'build/installer.nsh', 'installer hooks stay in the fixture');
    assert.deepEqual(config.publish, { provider: 'generic', url: 'http://127.0.0.1:8899/' });
    assert.deepEqual(config.files, pkg.build.files, 'a fixture packages exactly what a release does');
  });

  test('build config is not mutated', () => {
    fixtureConfig(pkg, { version: '1.0.1', outDir: 'X:/out' });
    assert.equal(pkg.build.nsis.perMachine, true);
    assert.equal(pkg.build.publish.provider, 'github');
  });

  test('the fixture lands next to the version it claims', () => {
    assert.equal(fixtureDir('.tmp/e2e', '1.0.1'), path.join('.tmp/e2e', 'v1.0.1'));
  });

  test('a fixture version that cannot produce an upgrade is rejected', () => {
    assert.match(validateFromVersion(null, '1.0.2'), /required/);
    assert.match(validateFromVersion('1.0', '1.0.2'), /not a semver/);
    assert.match(validateFromVersion('1.0.2', '1.0.2'), /two different versions/);
    assert.match(validateFromVersion('1.0.3', '1.0.2'), /older/);
    assert.equal(validateFromVersion('1.0.1', '1.0.2'), null);
    assert.equal(validateFromVersion('0.9.9', '1.0.2'), null);
  });
});
