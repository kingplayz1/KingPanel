/**
 * Who owns which server folder.
 *
 * The panel's server registry is the filesystem: every directory under the
 * install root is a server, and `resolveRuntimeDir()` resolves one by name. On
 * its own that means the newest registered account can start, stop, wipe or edit
 * files in every other account's folder. This module records the creating
 * account per folder and answers the access question for a viewer.
 *
 * Policy, deliberately simple:
 *   - Super Admin: every folder, including ones created before this table
 *     existed. That is what keeps a single-operator install working after an
 *     upgrade, and it matches how the Super Admin already sees every account.
 *   - Anybody else: only folders this module recorded as theirs.
 *   - A folder with no row belongs to nobody, so it is Super-Admin-only. Folders
 *     provisioned before this table existed are therefore not silently handed to
 *     whichever account happens to sign in next.
 *
 * Folder names are matched case-insensitively because Windows paths are.
 */

export interface OwnershipStatement {
  run: (...params: unknown[]) => { changes: number };
  get: (...params: unknown[]) => Record<string, unknown> | undefined;
  all: (...params: unknown[]) => Array<Record<string, unknown>>;
}

export interface OwnershipDb {
  exec: (sql: string) => void;
  prepare: (sql: string) => OwnershipStatement;
}

export interface Viewer {
  id: string;
  username: string;
  isSuperAdmin: boolean;
}

export interface ServerOwner {
  folderName: string;
  ownerId: string;
  ownerUsername: string;
  createdAt: string;
}

const TABLE = 'server_owners';

/** Create the table if this database predates it. Idempotent, safe at boot. */
export function ensureOwnershipTable(db: OwnershipDb | null | undefined): void {
  if (!db) return;
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS ${TABLE} (
        folder_lc TEXT PRIMARY KEY,
        folder_name TEXT NOT NULL,
        owner_id TEXT NOT NULL,
        owner_username TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_${TABLE}_owner ON ${TABLE} (owner_id);
    `);
  } catch (err) {
    // A store that cannot hold this table must not crash the process at boot.
    // Every access check then fails closed (unowned folders are Super-Admin
    // only), and the account store reports its own error separately.
    console.error('[Ownership] server_owners table unavailable; folders are Super-Admin only:', err);
  }
}

export function recordServerOwner(
  db: OwnershipDb | null | undefined,
  folderName: string,
  ownerId: string,
  ownerUsername: string
): boolean {
  if (!db) return false;
  const folder = String(folderName || '').trim();
  if (!folder || !ownerId) return false;
  try {
    db.prepare(
      `INSERT INTO ${TABLE} (folder_lc, folder_name, owner_id, owner_username, created_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(folder_lc) DO NOTHING`
    ).run(folder.toLowerCase(), folder, String(ownerId), String(ownerUsername || ''), new Date().toISOString());
    return true;
  } catch {
    return false;
  }
}

/**
 * Assign (or reassign) a folder to an account, on a Super Admin's instruction.
 *
 * Separate from `recordServerOwner`, which is creation-time and never overwrites:
 * attribution is a deliberate administrative act, so it reports what it replaced
 * and is a no-op when the owner is already correct.
 */
export function assignServerOwner(
  db: OwnershipDb | null | undefined,
  folderName: string,
  ownerId: string,
  ownerUsername: string
): { ok: boolean; changed: boolean; previous: ServerOwner | null; error?: string } {
  const folder = String(folderName || '').trim();
  if (!db) return { ok: false, changed: false, previous: null, error: 'the database is unavailable' };
  if (!folder) return { ok: false, changed: false, previous: null, error: 'a server folder name is required' };
  if (!ownerId) return { ok: false, changed: false, previous: null, error: 'a target account is required' };

  const previous = readServerOwner(db, folder);
  if (
    previous &&
    previous.ownerId === ownerId &&
    previous.ownerUsername.toLowerCase() === String(ownerUsername || '').toLowerCase()
  ) {
    return { ok: true, changed: false, previous };
  }

  try {
    db.prepare(
      `INSERT INTO ${TABLE} (folder_lc, folder_name, owner_id, owner_username, created_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(folder_lc) DO UPDATE SET
         folder_name = excluded.folder_name,
         owner_id = excluded.owner_id,
         owner_username = excluded.owner_username`
    ).run(folder.toLowerCase(), folder, String(ownerId), String(ownerUsername || ''), new Date().toISOString());
    return { ok: true, changed: true, previous };
  } catch (err) {
    return {
      ok: false,
      changed: false,
      previous,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export function readServerOwner(
  db: OwnershipDb | null | undefined,
  folderName: string
): ServerOwner | null {
  if (!db) return null;
  try {
    const row = db
      .prepare(`SELECT * FROM ${TABLE} WHERE folder_lc = ?`)
      .get(String(folderName || '').trim().toLowerCase());
    if (!row) return null;
    return {
      folderName: String(row.folder_name),
      ownerId: String(row.owner_id),
      ownerUsername: String(row.owner_username || ''),
      createdAt: String(row.created_at || ''),
    };
  } catch {
    return null;
  }
}

/**
 * May this viewer operate on this folder?
 *
 * Fails closed: a database error answers `false`. The caller must not be able
 * to distinguish "folder does not exist" from "folder is not yours", so both
 * end up as the same 404 at the route layer.
 */
export function canAccessServer(
  db: OwnershipDb | null | undefined,
  folderName: string,
  viewer: Viewer | null | undefined
): boolean {
  if (!viewer || !viewer.id) return false;
  if (viewer.isSuperAdmin) return true;
  const owner = readServerOwner(db, folderName);
  if (!owner) return false;
  if (owner.ownerId === viewer.id) return true;
  // An account re-created with a new id but the same username keeps its folders.
  return Boolean(owner.ownerUsername) && owner.ownerUsername.toLowerCase() === viewer.username.toLowerCase();
}

/**
 * Folders this viewer may see, or `null` when the viewer may see all of them.
 * Returning `null` (rather than a magic "all" set) keeps the caller explicit
 * about the Super Admin case instead of accidentally treating "empty" as "all".
 */
export function accessibleFolders(
  db: OwnershipDb | null | undefined,
  viewer: Viewer | null | undefined
): Set<string> | null {
  if (!viewer) return new Set();
  if (viewer.isSuperAdmin) return null;
  const owned = new Set<string>();
  if (!db) return owned;
  try {
    const rows = db
      .prepare(`SELECT folder_lc, folder_name FROM ${TABLE} WHERE owner_id = ? OR lower(owner_username) = ?`)
      .all(viewer.id, viewer.username.toLowerCase());
    for (const row of rows) {
      owned.add(String(row.folder_lc));
      owned.add(String(row.folder_lc).toLowerCase());
    }
  } catch {
    return new Set();
  }
  return owned;
}
