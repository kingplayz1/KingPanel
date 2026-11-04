/**
 * One-time move of the application state directory from the path an earlier
 * build used to the path this app pins by value.
 *
 * Why this exists
 * ---------------
 * Electron derives `userData` from the app's `name` field, which is still
 * "react-example". That directory is where every account, server registration
 * and OAuth token lives, so it is an identity, not a detail: renaming the field
 * (or letting it drift) would make an upgrade look exactly like data loss. The
 * main process now pins the directory to `%APPDATA%\IS King Panel` explicitly,
 * and this module brings existing installations across.
 *
 * Rules
 * -----
 *  - The source is copied, never moved or deleted. A timestamped snapshot of the
 *    database is taken first.
 *  - A destination file is only written when it does not already exist, so a
 *    partially migrated or newer destination is never overwritten.
 *  - The copy is verified by opening it and running `PRAGMA integrity_check`;
 *    on any failure the copied database is removed again and the caller is told
 *    to fail closed. An empty database is never created as a substitute.
 *  - Running it twice is a no-op: the destination database already exists after
 *    the first successful run.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';

// Same form as server.ts: the backend is bundled to CommonJS, so `import.meta`
// is not available at build time.
const requireModule = createRequire(__filename);

/** The SQLite file every installation opens. */
const DB_FILE = 'isking_panel.sqlite';
const DB_SIDECARS = ['-wal', '-shm'];
const MARKER_FILE = '.state-migration.json';
const SQLITE_MAGIC = Buffer.from('SQLite format 3\0', 'latin1');

export type MigrationStatus =
  | 'skipped-same-directory'
  | 'skipped-no-legacy-state'
  | 'skipped-destination-present'
  | 'migrated'
  | 'failed';

export interface MigrationResult {
  status: MigrationStatus;
  stateDir: string;
  legacyDir: string;
  copied: string[];
  skipped: string[];
  /** Present when status is `failed`; safe to log, contains no user data. */
  error?: string;
  /** Path of the source snapshot taken before copying, when one was taken. */
  snapshot?: string;
}

interface SqliteLike {
  exec: (sql: string) => void;
  prepare: (sql: string) => {
    get: (...params: unknown[]) => Record<string, unknown> | undefined;
    all: (...params: unknown[]) => Array<Record<string, unknown>>;
  };
  close: () => void;
}

function fileSize(file: string): number {
  try {
    return fs.statSync(file).size;
  } catch {
    return -1;
  }
}

/**
 * Structural check that a file really is a SQLite database: the 16-byte magic,
 * a plausible page size and a non-zero length. Cheap, and it catches a truncated
 * copy or a placeholder file before anything is overwritten.
 */
export function looksLikeSqliteFile(file: string): boolean {
  let fd: number | null = null;
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size < 512) return false;
    fd = fs.openSync(file, 'r');
    const header = Buffer.alloc(100);
    const read = fs.readSync(fd, header, 0, 100, 0);
    if (read < 100) return false;
    if (!header.subarray(0, 16).equals(SQLITE_MAGIC)) return false;
    const pageSize = header.readUInt16BE(16);
    // 512–32768, or 1 meaning 65536. Anything else is not a database we wrote.
    return pageSize === 1 || (pageSize >= 512 && pageSize <= 32768 && (pageSize & (pageSize - 1)) === 0);
  } catch {
    return false;
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        // ignore
      }
    }
  }
}

/**
 * Open a database and prove SQLite can read it. Returns null when the file is
 * usable, or a short reason string when it is not.
 */
export function verifySqliteReadable(file: string): string | null {
  type DatabaseCtor = new (filename: string, options?: { readOnly?: boolean }) => SqliteLike;
  let DatabaseSync: DatabaseCtor | null = null;
  try {
    DatabaseSync = (requireModule('node:sqlite') as { DatabaseSync: DatabaseCtor }).DatabaseSync;
  } catch {
    // No SQLite driver here (an Electron-hosted Node older than 22.5). The
    // structural check above is all that is available; the backend performs its
    // own open and fails closed if the file is unusable.
    return null;
  }
  if (!DatabaseSync) return null;
  const Ctor: DatabaseCtor = DatabaseSync;

  let db: SqliteLike | null = null;
  try {
    db = new Ctor(file, { readOnly: true });
    const rows = db.prepare('PRAGMA integrity_check').all();
    const verdict = rows.length === 1 ? String(Object.values(rows[0])[0] ?? '') : '';
    if (verdict.toLowerCase() !== 'ok') return `integrity_check returned "${verdict || 'no result'}"`;
    // A readable database that never had our schema is not our database.
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'users'")
      .all();
    if (tables.length === 0) return 'the database has no users table';
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  } finally {
    try {
      db?.close();
    } catch {
      // ignore
    }
  }
}

function sha256(file: string): string {
  try {
    return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  } catch {
    return '';
  }
}

/** Copy one file without ever replacing an existing destination file. */
function copyIfAbsent(from: string, to: string): 'copied' | 'exists' | 'missing' {
  if (!fs.existsSync(from)) return 'missing';
  if (fs.existsSync(to)) return 'exists';
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to, fs.constants.COPYFILE_EXCL);
  try {
    fs.chmodSync(to, fs.statSync(from).mode);
  } catch {
    // Windows ACLs come from the parent directory; nothing to preserve here.
  }
  return 'copied';
}

/** Top-level state files: everything the backend writes next to the database. */
function stateFilesIn(dir: string): string[] {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter(
        (entry) =>
          entry.isFile() &&
          !entry.name.startsWith('.state-migration') &&
          !entry.name.endsWith('.bak') &&
          !entry.name.endsWith('.log')
      )
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

export function migrateLegacyStateDir(options: {
  stateDir: string;
  legacyDir: string | null | undefined;
  now?: () => Date;
}): MigrationResult {
  const stateDir = path.resolve(options.stateDir);
  const legacyDir = options.legacyDir ? path.resolve(options.legacyDir) : '';
  const base: MigrationResult = { status: 'skipped-no-legacy-state', stateDir, legacyDir, copied: [], skipped: [] };

  if (!legacyDir || legacyDir === stateDir) {
    return { ...base, status: 'skipped-same-directory' };
  }

  const legacyDb = path.join(legacyDir, DB_FILE);
  if (!fs.existsSync(legacyDb)) {
    return base;
  }

  const targetDb = path.join(stateDir, DB_FILE);
  if (fs.existsSync(targetDb)) {
    // Already migrated (or created by a normal launch): never touch it again.
    return { ...base, status: 'skipped-destination-present' };
  }

  // 1. Validate the source before anything is written.
  if (!looksLikeSqliteFile(legacyDb)) {
    return {
      ...base,
      status: 'failed',
      error: `the legacy database at ${legacyDb} is not a readable SQLite file`,
    };
  }
  const sourceProblem = verifySqliteReadable(legacyDb);
  if (sourceProblem) {
    return { ...base, status: 'failed', error: `the legacy database failed verification: ${sourceProblem}` };
  }

  // 2. Back up the source so a bad migration never costs the original.
  const stamp = (options.now ? options.now() : new Date()).toISOString().replace(/[:.]/g, '-');
  const snapshot = path.join(legacyDir, `${DB_FILE}.premigration-${stamp}.bak`);
  const copied: string[] = [];
  const skipped: string[] = [];
  try {
    if (!fs.existsSync(snapshot)) {
      fs.copyFileSync(legacyDb, snapshot, fs.constants.COPYFILE_EXCL);
      copied.push(path.basename(snapshot));
    }
  } catch {
    // A missing snapshot is not itself a reason to lose the original: the
    // source is copied, not moved, so it is still intact either way.
  }

  // 3. Copy the database and its sidecars, then every other state file.
  try {
    fs.mkdirSync(stateDir, { recursive: true });
    const dbResult = copyIfAbsent(legacyDb, targetDb);
    if (dbResult !== 'copied') {
      return { ...base, status: 'skipped-destination-present', copied, skipped };
    }
    copied.push(DB_FILE);

    for (const suffix of DB_SIDECARS) {
      const result = copyIfAbsent(`${legacyDb}${suffix}`, `${targetDb}${suffix}`);
      if (result === 'copied') copied.push(`${DB_FILE}${suffix}`);
      else if (result === 'exists') skipped.push(`${DB_FILE}${suffix}`);
    }

    for (const name of stateFilesIn(legacyDir)) {
      if (name === DB_FILE || DB_SIDECARS.some((suffix) => name === `${DB_FILE}${suffix}`)) continue;
      const result = copyIfAbsent(path.join(legacyDir, name), path.join(stateDir, name));
      if (result === 'copied') copied.push(name);
      else if (result === 'exists') skipped.push(name);
    }
  } catch (err) {
    return {
      ...base,
      status: 'failed',
      copied,
      skipped,
      error: `copy step failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  // 4. Prove the copy is usable. Any doubt rolls the copied database back out.
  const destinationProblem =
    (fileSize(targetDb) !== fileSize(legacyDb) ? 'the copied database is a different size' : null) ||
    (!looksLikeSqliteFile(targetDb) ? 'the copied database is not a readable SQLite file' : null) ||
    verifySqliteReadable(targetDb);

  if (destinationProblem) {
    for (const suffix of ['', ...DB_SIDECARS]) {
      try {
        fs.rmSync(`${targetDb}${suffix}`, { force: true });
      } catch {
        // ignore
      }
    }
    return {
      ...base,
      status: 'failed',
      copied: copied.filter((name) => !name.startsWith(DB_FILE)),
      skipped,
      error: `the migrated database failed verification (${destinationProblem}); the copy was removed and the original was left untouched`,
    };
  }

  // 5. Record what happened. This doubles as the idempotency marker.
  try {
    fs.writeFileSync(
      path.join(stateDir, MARKER_FILE),
      JSON.stringify(
        {
          migratedAt: (options.now ? options.now() : new Date()).toISOString(),
          from: legacyDir,
          to: stateDir,
          sourceDatabaseSha256: sha256(legacyDb),
          snapshot: path.basename(snapshot),
          copied,
          skipped,
        },
        null,
        2
      ),
      'utf8'
    );
  } catch {
    // The marker is diagnostics; the database already proves the migration.
  }

  return { ...base, status: 'migrated', copied, skipped, snapshot };
}
