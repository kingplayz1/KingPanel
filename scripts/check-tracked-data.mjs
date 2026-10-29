#!/usr/bin/env node
/**
 * Fails when a *tracked* file is runtime state rather than source.
 *
 * .gitignore lists the paths the app writes while it runs (.local-users-db.json,
 * server_runtime.json, database/*.sqlite, ...), but an ignore rule does nothing
 * for a path that is already in the index — that is how a real account list and
 * a live SQLite database ended up committed and then pushed to a public repo.
 *
 * So this checks two independent things, because either alone is defeatable:
 *
 *  1. Paths — a tracked file whose name is runtime state by nature (database,
 *     cookie jar, session store, the local account list).
 *  2. Contents — the bytes themselves: a SQLite header, a Netscape cookie table,
 *     or JSON records that pair an identity with a credential. This catches a
 *     data file that was renamed to look like a fixture or a doc.
 *
 * It also asserts the .gitignore rules are still in place, so a future edit that
 * removes them fails here instead of quietly allowing `git add -A` to stage live
 * state. Keep that in mind when changing .gitignore.
 *
 * Deliberately out of scope: a user list pasted as a literal into a .ts/.tsx
 * file. Distinguishing that from schema code and test fixtures needs a parser
 * and would fail builds for legitimate seed data, so this covers data files —
 * which is the shape the leak actually took.
 *
 * Only paths and record *counts* are printed — never field values — so the check
 * is safe to run on a machine that holds real accounts.
 *
 * Usage: node scripts/check-tracked-data.mjs
 * Exit:  0 clean, 1 something user-data-shaped is tracked.
 */
import { spawnSync } from 'node:child_process';
import { closeSync, openSync, readFileSync, readSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SQLITE_MAGIC = Buffer.from('SQLite format 3\0', 'latin1');
const MAX_SCAN_BYTES = 4 * 1024 * 1024;

/** Names that are runtime state. Matched against the full repo-relative path. */
const PATH_RULES = [
  {
    test: (p) => /(^|\/)\.local-users-db\.json$/.test(p),
    why: 'the local account list (usernames, emails, password and session hashes)',
  },
  {
    test: (p) => /(^|\/)\.local-operator-profile\.json$/.test(p),
    why: 'the local operator profile',
  },
  {
    test: (p) => /(^|\/)server_runtime\.json$/.test(p),
    why: 'the live server runtime snapshot',
  },
  {
    test: (p) => /\.(sqlite|sqlite3|db)(-(shm|wal|journal))?$/i.test(p),
    why: 'a database file',
  },
  {
    // cookies.txt, Minecraft_Servercookies.txt, ... but not a source file that
    // merely mentions cookies (those are .ts/.tsx/.md and never end in .txt/.json).
    test: (p) => /(^|\/)[^/]*cookies?\.(txt|json)$/i.test(p),
    why: 'a saved cookie jar (live session tokens)',
  },
  {
    test: (p) => /(^|\/)(sessions?|session-store|sessionstore)\.(json|db|sqlite)$/i.test(p),
    why: 'a session store',
  },
  {
    test: (p) => /\.session(-journal)?$/i.test(p),
    why: 'a serialized session',
  },
  {
    test: (p) => /(^|\/)database\/mongodb_collections\/(?!\.gitkeep$).+/.test(p),
    why: 'dumped MongoDB collections',
  },
];

/** Paths that look data-shaped but are deliberately part of the repo. */
const PATH_ALLOW = new Set([
  // Describes the session schema; contains no records.
  'SESSION_SECURITY_SUMMARY.md',
]);

/**
 * Patterns .gitignore must keep ignoring. Removing one is how the leak starts,
 * and the leak is silent: nothing fails until somebody stages the file.
 */
const MUST_BE_IGNORED = [
  '.local-users-db.json',
  '.local-operator-profile.json',
  'server_runtime.json',
  'cookies.txt',
  'servercookies.txt',
  'Cookies',
  'sessions.json',
  'database/isking_panel.sqlite',
  'database/isking_panel.sqlite-wal',
  'database/mongodb_collections/users.bson',
];

const IDENTITY_KEYS = /^(id|uuid|user_?name|login|email|e_?mail|display_?name|name)$/i;
const CREDENTIAL_KEYS =
  /^(password|passwd|pass|pwd|password_?hash|passwordhash|salt|session_?sha|session_?id|sessionid|sess|sid|totp_?secret|refresh_?token|access_?token|cookie)$/i;

function fail(problems) {
  console.error('[data] FAILED — runtime user data is tracked in git:');
  for (const problem of problems) console.error(`  - ${problem}`);
  console.error(
    '\nRemove the file from the index (git rm --cached <path>) and keep it in ' +
      '.gitignore. If it was already pushed, treat the data as disclosed and ' +
      'rotate the affected credentials; deleting it in a later commit does not ' +
      'remove it from history.',
  );
  process.exit(1);
}

function git(args) {
  const result = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (result.error) throw result.error;
  return result;
}

function trackedFiles() {
  const result = git(['ls-files', '-z']);
  if (result.status !== 0) {
    throw new Error(`git ls-files failed: ${(result.stderr || '').trim() || result.status}`);
  }
  return result.stdout.split('\0').filter(Boolean);
}

/** Reads up to `limit` bytes without loading a large tracked file whole. */
function readHead(file, limit) {
  const fd = openSync(file, 'r');
  try {
    const size = Math.min(limit, statSync(file).size);
    const buffer = Buffer.alloc(size);
    readSync(fd, buffer, 0, size, 0);
    return buffer;
  } finally {
    closeSync(fd);
  }
}

function looksBinary(buffer) {
  const window = buffer.subarray(0, 8000);
  return window.includes(0);
}

/**
 * Netscape cookie file: domain<TAB>flag<TAB>path<TAB>secure<TAB>expiry<TAB>name<TAB>value
 *
 * The expiry accepts any digit count, not just an epoch: exports write 0 for a
 * session cookie, and that is exactly the row worth catching, since it holds a
 * live session token. The TRUE/FALSE columns on either side of it are what make
 * this a cookie table rather than an arbitrary seven-column TSV.
 */
const COOKIE_LINE =
  /^(?:#HttpOnly_)?\.?[A-Za-z0-9][A-Za-z0-9.-]*\t(?:TRUE|FALSE)\t\/[^\t]*\t(?:TRUE|FALSE)\t\d+\t[^\t]+\t[^\t]*$/m;

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** Every array in the document, with a path so the message points somewhere. */
function* arraysIn(value, at = '$', depth = 0) {
  if (depth > 8) return;
  if (Array.isArray(value)) {
    yield { at, items: value };
    for (const [index, item] of value.entries()) {
      if (item && typeof item === 'object') yield* arraysIn(item, `${at}[${index}]`, depth + 1);
    }
  } else if (isPlainObject(value)) {
    for (const [key, child] of Object.entries(value)) {
      if (child && typeof child === 'object') yield* arraysIn(child, `${at}.${key}`, depth + 1);
    }
  }
}

/**
 * An account record pairs who somebody is with how they authenticate. Either
 * signal alone is ordinary (a name list, a settings blob); together they are a
 * real user table.
 */
function accountRecords(items) {
  let count = 0;
  for (const item of items) {
    if (!isPlainObject(item)) continue;
    const keys = Object.keys(item);
    if (keys.some((key) => IDENTITY_KEYS.test(key)) && keys.some((key) => CREDENTIAL_KEYS.test(key))) {
      count += 1;
    }
  }
  return count;
}

/** Session records: an opaque session id plus the user or cookie it belongs to. */
function sessionRecords(items) {
  let count = 0;
  for (const item of items) {
    if (!isPlainObject(item)) continue;
    const keys = Object.keys(item);
    if (
      keys.some((key) => /^(sess|session_?id|sid)$/i.test(key)) &&
      keys.some((key) => /^(cookie|sess|user_?id|user|username)$/i.test(key))
    ) {
      count += 1;
    }
  }
  return count;
}

function inspectJson(parsed) {
  const findings = [];
  for (const { at, items } of arraysIn(parsed)) {
    if (items.length === 0) continue;
    const accounts = accountRecords(items);
    if (accounts > 0) {
      findings.push(`${accounts} account record(s) under ${at} (identity + credential fields)`);
    }
    const sessions = sessionRecords(items);
    if (sessions > 0) {
      findings.push(`${sessions} session record(s) under ${at} (session id + owner)`);
    }
  }
  // Map-shaped session stores: { "<sid>": { cookie: ..., expires: ... } }
  if (isPlainObject(parsed)) {
    const entries = Object.values(parsed).filter(isPlainObject);
    if (entries.length > 0 && entries.every((entry) => 'cookie' in entry || 'sess' in entry)) {
      findings.push(`${entries.length} session record(s) as a keyed session store`);
    }
  }
  return findings;
}

function checkContents(file, relPath) {
  const findings = [];
  let stat;
  try {
    stat = statSync(file);
  } catch {
    return findings; // tracked but absent from the worktree (sparse checkout)
  }
  if (!stat.isFile() || stat.size === 0) return findings;

  const head = readHead(file, Math.min(stat.size, 64 * 1024));
  if (head.subarray(0, SQLITE_MAGIC.length).equals(SQLITE_MAGIC)) {
    findings.push('starts with a SQLite header, so this is a real database (not a fixture)');
    return findings;
  }
  if (looksBinary(head)) return findings;

  const text = stat.size <= MAX_SCAN_BYTES ? readFileSync(file, 'latin1') : head.toString('latin1');

  const cookieLines = text.match(new RegExp(COOKIE_LINE.source, 'gm'));
  if (cookieLines && cookieLines.length > 0) {
    findings.push(`${cookieLines.length} Netscape cookie row(s) with live session cookies`);
  }

  const trimmed = text.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    let parsed;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      return findings; // not JSON after all (source file, log, partial write)
    }
    findings.push(...inspectJson(parsed));
  }
  return findings;
}

function checkIgnoreRules() {
  const problems = [];
  for (const candidate of MUST_BE_IGNORED) {
    const result = git(['check-ignore', '-q', '--', candidate]);
    if (result.status !== 0) {
      problems.push(
        `.gitignore no longer ignores ${candidate}, so \`git add -A\` would stage ` +
          'runtime state again',
      );
    }
  }
  return problems;
}

function main() {
  const tracked = trackedFiles();
  const problems = [];

  for (const relPath of tracked) {
    const normalized = relPath.split(path.sep).join('/');
    if (PATH_ALLOW.has(normalized)) continue;

    for (const rule of PATH_RULES) {
      if (rule.test(normalized)) {
        problems.push(`${normalized} is tracked and is ${rule.why}`);
      }
    }

    for (const finding of checkContents(path.join(ROOT, relPath), normalized)) {
      problems.push(`${normalized}: ${finding}`);
    }
  }

  problems.push(...checkIgnoreRules());

  if (problems.length) fail(problems);

  console.log(
    `[data] OK  ${tracked.length} tracked files contain no user list, database ` +
      `or session data; ${MUST_BE_IGNORED.length} ignore rules intact`,
  );
}

try {
  main();
} catch (err) {
  console.error(`[data] could not run: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
}
