/**
 * The privacy half of the release gate: what may be inside a shipped installer.
 *
 * The build used to copy `database/**` into the installer. On the machine that
 * built it, that directory holds the developer's own account database, password
 * hashes and OAuth state, so every locally built installer shipped its author's
 * login — and the rule looked perfectly reasonable, which is exactly why a
 * filename blocklist would not have caught it.
 *
 * So this gate is an allowlist first (the only things that may appear under
 * `resources/` and inside `app.asar` are named below) and a content scan second,
 * because a state file can be renamed and is still a state file.
 *
 * `scripts/release-verify.mjs` owns the rest of the release rules and re-exports
 * these, so a caller still has a single entry point.
 */
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readAsar, readAsarEntry } from './asar-entries.mjs';

/** Everything that may sit in `resources/`. Anything else is a packaging bug. */
export const PACKAGED_RESOURCES = [
  'app.asar',
  'app.asar.unpacked',
  'app-update.yml', // electron-updater's feed pointer, written by electron-builder
  'elevate.exe', // electron-builder's NSIS helper
  'runtime', // the pinned Node.js binary, verified separately
];

/**
 * Application payload allowed inside `app.asar`.
 *
 * Deliberately a closed list. `src/` ships today because more than the renderer
 * reads those files; nothing else does. Adding an entry here is a reviewable
 * decision, which is the point.
 */
export const PACKAGED_PAYLOAD = [
  'dist/',
  'node_modules/',
  'src/',
  'server.cjs',
  'electron-main.cjs',
  'updater-policy.cjs', // updater publisher policy, required by electron-main.cjs
  'electron-preload.cjs',
  'runtime-resolver.cjs',
  'state-dirs.cjs',
  'package.json',
];

/** Directories that only ever hold per-user runtime state. */
const STATE_DIRS = new Set([
  'database',
  'kingservers',
  'legacy-install-servers',
  'backups',
  'worlds',
  'crashdumps',
  '.tmp',
]);

/** Files the app writes next to its database. None of them belong in a build. */
const STATE_FILES = [
  [/^\.local-/, 'local account or operator state'],
  [/^\.panel-/, 'panel session state'],
  [/^\.state-migration/, 'state-migration marker'],
  [/^state-migration\.json$/, 'state-migration marker'],
  [/^server_runtime\.json$/, 'managed-server runtime state'],
  [/^db_engine_config\.json$/, 'database engine configuration (may hold MySQL credentials)'],
  [/^first-run-credentials\.txt$/, 'generated Super Admin password and recovery codes'],
  [/^oauth-token-key\.dpapi$/, 'wrapped OAuth token key'],
  [/^sessions?\.json$/, 'session store'],
  [/^session-store\.json$/, 'session store'],
  [/^cookies(-journal)?$/, 'browser cookie store'],
  [/^.*cookies?.*\.(txt|json)$/, 'browser cookie store'],
];

const KEY_FILES = /(\.pfx|\.p12|\.key|\.pem)$/i;
const SQLITE_FILES = /(\.sqlite|\.sqlite3|\.db)$/i;
const SQLITE_SIDECARS = /\.sqlite-(wal|shm)$/i;
const PRIVATE_KEY_NAME = /^id_(rsa|dsa|ecdsa|ed25519)/i;

/**
 * Why a path must not be packaged, or null when it is ordinary payload.
 *
 * `dependency` relaxes the rules to what is plausible inside a third-party
 * package: a `node_modules/<pkg>/test/` folder is not a fixture leak, but an
 * `.env` or a private key is never acceptable anywhere.
 */
export function statePathReason(relPath, { dependency = false } = {}) {
  const rel = String(relPath).replace(/\\/g, '/');
  const lower = rel.toLowerCase();
  const segments = lower.split('/');
  const base = segments[segments.length - 1];

  if (base === '.env' || base.startsWith('.env.')) return 'environment file (may hold secrets)';
  if (KEY_FILES.test(base)) return 'key or certificate material';
  if (PRIVATE_KEY_NAME.test(base)) return 'private key';
  if (SQLITE_FILES.test(base) || SQLITE_SIDECARS.test(base)) return 'SQLite database';
  if (base.endsWith('.bson.json')) return 'MongoDB collection dump';

  if (dependency) return null;

  if (STATE_DIRS.has(segments[0])) {
    return segments[0] === 'database'
      ? 'the developer state directory (accounts, password hashes, database)'
      : `runtime state directory "${segments[0]}"`;
  }
  for (const [pattern, reason] of STATE_FILES) {
    if (pattern.test(base)) return reason;
  }
  if (segments.includes('mongodb_collections')) return 'MongoDB collection dump';
  if (segments.includes('logs') || /\.log(\.\d+)?$/i.test(base)) return 'log file';
  if (/\.log\.(gz|txt|json)$/i.test(base)) return 'log file';
  if (/\.bak$/i.test(base) || /\.premigration-/i.test(base)) return 'backup copy of runtime data';
  if (segments.some((segment) => ['test', 'tests', '__tests__', 'fixtures', '__fixtures__'].includes(segment))) {
    return 'test fixture';
  }
  if (/\.(test|spec)\.(m?js|cjs|ts|tsx)$/i.test(base)) return 'test file';
  return null;
}

const SQLITE_MAGIC = Buffer.from('SQLite format 3\0', 'latin1');

export function isSqliteBuffer(buffer) {
  return Buffer.isBuffer(buffer) && buffer.length >= 16 && buffer.subarray(0, 16).equals(SQLITE_MAGIC);
}

/**
 * Count the rows in a SQLite database held in memory.
 *
 * The gate reports *how much* state a database holds, never the state itself:
 * table names and counts, no column values, so a failure message is safe to
 * paste into a public build log.
 */
export function sqliteRowCounts(buffer) {
  let DatabaseSync;
  try {
    DatabaseSync = createRequire(import.meta.url)('node:sqlite').DatabaseSync;
  } catch {
    return { available: false, reason: 'this Node has no node:sqlite, so contents could not be read' };
  }
  const scratch = path.join(
    os.tmpdir(),
    `isk-privacy-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.sqlite`,
  );
  fs.writeFileSync(scratch, buffer);
  let db = null;
  try {
    db = new DatabaseSync(scratch, { readOnly: true });
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map((row) => String(row.name));
    const counts = {};
    let rows = 0;
    for (const table of tables) {
      const quoted = table.replace(/"/g, '""');
      const value = Object.values(db.prepare(`SELECT COUNT(*) AS n FROM "${quoted}"`).get() ?? {})[0];
      const count = Number(value ?? 0);
      counts[table] = count;
      rows += count;
    }
    const sensitive = ['users', 'accounts', 'sessions', 'oauth_tokens', 'recovery_codes', 'server_owners'].filter(
      (table) => (counts[table] ?? 0) > 0,
    );
    return { available: true, tables, counts, rows, sensitive };
  } catch (err) {
    return { available: true, error: err instanceof Error ? err.message : String(err) };
  } finally {
    try {
      db?.close();
    } catch {
      // already closed
    }
    fs.rmSync(scratch, { force: true });
  }
}

/**
 * Secret shapes worth failing a release over, when found in a *state* file.
 *
 * Only applied to data files, never to code: `server.cjs` mentions
 * `password_hash` in its schema, and flagging that would teach everyone to
 * ignore this gate.
 */
const SECRET_SHAPES = [
  [/"password_?hash"\s*:\s*"/i, 'a stored password hash'],
  [/"mysqlPassword"\s*:\s*"[^"]+"/i, 'a MySQL password'],
  [/"recovery_?codes?"\s*:\s*\[/i, 'account recovery codes'],
  [/"(access|refresh|id)_?token"\s*:\s*"[^"]+/i, 'an OAuth token'],
  [/"(accessToken|refreshToken|idToken|sessionToken)"\s*:\s*"[^"]+/i, 'an OAuth or session token'],
  [/"client_?secret"\s*:\s*"[^"]+/i, 'an OAuth client secret'],
  [/"private_?key"\s*:\s*"[^"]+/i, 'a private key'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, 'a private key'],
  [/^\s*[A-Z0-9_]*(SECRET|TOKEN|PASSWORD|API_KEY)[A-Z0-9_]*\s*=\s*\S+/m, 'an env-style secret assignment'],
];

function secretInText(text) {
  const labels = SECRET_SHAPES.filter(([pattern]) => pattern.test(text)).map(([, label]) => label);
  return labels.length ? [...new Set(labels)].join(', ') : null;
}

const TEXT_STATE_EXTENSIONS = new Set(['.json', '.txt', '.yml', '.yaml', '.ini', '.cfg', '.conf', '.properties', '.env']);

function isTextStateFile(relPath) {
  const base = String(relPath).split('/').pop().toLowerCase();
  if (base === '.env' || base.startsWith('.env.')) return true;
  return TEXT_STATE_EXTENSIONS.has(path.extname(base));
}

/** Every file under `root`, not descending into directories nothing may live in. */
function walkPackagedFiles(root) {
  const out = [];
  const visit = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        const name = entry.name.toLowerCase();
        // Named runtime-state folders are reported once, at the top level.
        if (STATE_DIRS.has(name) || name === 'node_modules') continue;
        visit(abs);
      } else if (entry.isFile()) {
        out.push(abs);
      }
    }
  };
  visit(root);
  return out;
}

function describeSqlite(info) {
  if (info.available === false) return info.reason;
  if (info.error) return `could not be opened (${info.error})`;
  const detail = `${info.rows} row(s) across ${info.tables.length} table(s)`;
  return info.sensitive.length
    ? `${detail}, including ${info.sensitive.map((table) => `${table}=${info.counts[table]}`).join(', ')}`
    : detail;
}

/**
 * Inspect the packaged application for developer data.
 *
 * @param {{dir: string, maxTextBytes?: number,
 *          readEntries?: Function, readEntry?: Function, inspectSqlite?: Function}} options
 *   `dir` is the electron-builder output directory. `win-unpacked/resources` is
 *   exactly the tree the NSIS installer compresses, so this inspects the real
 *   installer input rather than a hand-maintained list of paths.
 * @returns {{problems: string[], facts: object}}
 */
export function verifyPackagedPrivacy({
  dir,
  maxTextBytes = 4 * 1024 * 1024,
  readEntry = readAsarEntry,
  inspectSqlite = sqliteRowCounts,
}) {
  const resourcesDir = path.join(dir, 'win-unpacked', 'resources');
  const problems = [];
  const facts = {
    resourcesDir,
    resources: [],
    asarEntries: 0,
    payloadEntries: 0,
    dependencyEntries: 0,
    sqliteInspected: 0,
    stateFilesInspected: 0,
  };

  if (!fs.existsSync(resourcesDir)) {
    return { problems: [`packaged resources are missing: ${resourcesDir}`], facts };
  }

  for (const entry of fs.readdirSync(resourcesDir, { withFileTypes: true })) {
    facts.resources.push(entry.name);
    if (!PACKAGED_RESOURCES.includes(entry.name)) {
      const reason = statePathReason(entry.name) ?? 'not part of the application payload';
      problems.push(
        `resources/${entry.name} is packaged into the installer (${reason}); ` +
          'remove it from build.files / build.extraResources',
      );
    }
  }

  const asarPath = path.join(resourcesDir, 'app.asar');
  let header = null;
  if (!fs.existsSync(asarPath)) {
    problems.push('resources/app.asar is missing, so the packaged application could not be inspected');
  } else {
    try {
      header = readAsar(asarPath);
    } catch (err) {
      problems.push(`the packaged app.asar could not be read: ${err instanceof Error ? err.message : err}`);
    }
  }

  if (header) {
    facts.asarEntries = header.entries.length;
    for (const entry of header.entries) {
      const dependency = entry.path.startsWith('node_modules/');
      if (dependency) facts.dependencyEntries += 1;
      else facts.payloadEntries += 1;

      const reason = statePathReason(entry.path, { dependency });
      if (reason) problems.push(`app.asar carries ${entry.path} (${reason})`);

      if (
        !dependency &&
        !PACKAGED_PAYLOAD.some(
          (allowed) => entry.path === allowed || (allowed.endsWith('/') && entry.path.startsWith(allowed)),
        )
      ) {
        problems.push(`app.asar carries ${entry.path}, which is not an allowed payload file`);
      }
      if (dependency) continue;

      let buffer = null;
      try {
        buffer = readEntry(asarPath, entry.path, header);
      } catch {
        buffer = null;
      }
      if (!buffer) continue;
      if (isSqliteBuffer(buffer)) {
        facts.sqliteInspected += 1;
        problems.push(
          `app.asar carries the SQLite database ${entry.path} (${describeSqlite(inspectSqlite(buffer))})`,
        );
      } else if (isTextStateFile(entry.path) && buffer.length <= maxTextBytes) {
        facts.stateFilesInspected += 1;
        const secret = secretInText(buffer.toString('utf8'));
        if (secret) problems.push(`app.asar carries ${entry.path}, which contains ${secret}`);
      }
    }
  }

  // Entries that are unpacked live next to the archive; everything here is on
  // disk, so the same checks are applied to the files themselves.
  for (const abs of walkPackagedFiles(resourcesDir)) {
    const rel = path.relative(resourcesDir, abs).split(path.sep).join('/');
    if (rel === 'app.asar') continue;

    const reason = statePathReason(rel);
    if (reason) problems.push(`resources/${rel} is packaged into the installer (${reason})`);

    let size = 0;
    try {
      size = fs.statSync(abs).size;
    } catch {
      continue;
    }
    if (size < 512) continue;

    const head = Buffer.alloc(16);
    let read = 0;
    try {
      const fd = fs.openSync(abs, 'r');
      try {
        read = fs.readSync(fd, head, 0, 16, 0);
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      continue;
    }
    if (read < 16) continue;

    if (isSqliteBuffer(head)) {
      // A database renamed to something innocuous is still a database.
      facts.sqliteInspected += 1;
      const whole = size <= 256 * 1024 * 1024 ? fs.readFileSync(abs) : null;
      problems.push(
        `resources/${rel} is a SQLite database (` +
          `${whole ? describeSqlite(inspectSqlite(whole)) : 'too large to inspect'})`,
      );
      continue;
    }
    if (isTextStateFile(rel) && size <= maxTextBytes) {
      facts.stateFilesInspected += 1;
      const secret = secretInText(fs.readFileSync(abs, 'utf8'));
      if (secret) problems.push(`resources/${rel} contains ${secret}`);
    }
  }

  return { problems, facts };
}
