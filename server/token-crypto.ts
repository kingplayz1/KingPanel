/**
 * Encryption at rest for provider OAuth tokens.
 *
 * A Discord access/refresh token is a credential that acts as the signed-in
 * user against the provider, so a plaintext copy in the SQLite file is exactly
 * the kind of thing that leaks through a support bundle, a backup, or a copied
 * database.
 *
 * The key
 * -------
 * The main process wraps a random 32-byte key with Electron `safeStorage`
 * (DPAPI on Windows, bound to the logged-in OS user) and passes the unwrapped
 * value to this backend through `OAUTH_TOKEN_KEY`. The wrapped file can sit next
 * to the database: it is useless on another machine or to another OS user.
 *
 * When the variable is absent (a dev run, a test, a non-Electron host) the key
 * falls back to `.oauth-key` in the state directory, created 0600. That is
 * weaker — the key sits beside the ciphertext — and it is logged as such. What
 * it still buys is that the tokens are not readable by grepping the database.
 *
 * An invalid key is never silently replaced: doing so would make every stored
 * token undecryptable and quietly log the user out everywhere. The caller gets
 * an explicit error, keeps the existing ciphertext, and asks the account to
 * reconnect once the key is fixed.
 *
 * Format: `enc:v1:<iv-b64>:<tag-b64>:<ciphertext-b64>` (AES-256-GCM).
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const PREFIX = 'enc:v1:';
const KEY_FILE = '.oauth-key';
const KEY_BYTES = 32;

export interface ResolvedTokenKey {
  key: Buffer | null;
  source: 'env' | 'file' | 'none';
  /** Set when a key was supplied but could not be used; never contains the key. */
  error?: string;
}

function parseKey(value: string | undefined | null): Buffer | null {
  if (!value) return null;
  const trimmed = String(value).trim();
  if (!trimmed) return null;
  let buffer: Buffer;
  try {
    buffer = Buffer.from(trimmed, 'base64');
  } catch {
    return null;
  }
  return buffer.length === KEY_BYTES ? buffer : null;
}

/**
 * Resolve the token key from the environment, then from the state directory.
 * Never throws: a caller that gets `key: null` must treat stored tokens as
 * unreadable rather than crash the request.
 */
export function resolveTokenKey(
  stateDir: string,
  envValue: string | undefined | null
): ResolvedTokenKey {
  const supplied = typeof envValue === 'string' ? envValue.trim() : '';
  if (supplied) {
    const key = parseKey(supplied);
    if (key) return { key, source: 'env' };
    return {
      key: null,
      source: 'none',
      error: `OAUTH_TOKEN_KEY is not a valid ${KEY_BYTES}-byte base64 key; stored provider tokens stay encrypted and unreadable until it is corrected`,
    };
  }

  const file = path.join(stateDir, KEY_FILE);
  try {
    if (fs.existsSync(file)) {
      const key = parseKey(fs.readFileSync(file, 'utf8'));
      if (key) return { key, source: 'file' };
      return {
        key: null,
        source: 'none',
        error: `the key file ${file} does not contain a valid ${KEY_BYTES}-byte base64 key`,
      };
    }
    const key = crypto.randomBytes(KEY_BYTES);
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(file, key.toString('base64'), { mode: 0o600 });
    try {
      fs.chmodSync(file, 0o600);
    } catch {
      // Windows ACLs come from the parent directory.
    }
    return { key, source: 'file' };
  } catch (err) {
    return {
      key: null,
      source: 'none',
      error: `could not read or create ${file}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

export function isEncryptedSecret(value: unknown): boolean {
  return typeof value === 'string' && value.startsWith(PREFIX);
}

/** AES-256-GCM: a fresh IV per value, and the tag stored alongside it. */
export function encryptSecret(key: Buffer | null, plain: string | null | undefined): string | null {
  if (!key) return null;
  if (plain === null || plain === undefined || plain === '') return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${PREFIX}${iv.toString('base64')}:${tag.toString('base64')}:${ciphertext.toString('base64')}`;
}

/**
 * Decrypt a stored value. Legacy plaintext is returned unchanged so a database
 * written by an earlier build keeps working until the migration pass rewrites
 * it. A value that cannot be authenticated returns null — the caller then treats
 * the account as "reconnect required" instead of using garbage as a bearer token.
 */
export function decryptSecret(key: Buffer | null, stored: string | null | undefined): string | null {
  if (stored === null || stored === undefined || stored === '') return null;
  const value = String(stored);
  if (!value.startsWith(PREFIX)) return value;
  if (!key) return null;

  const parts = value.slice(PREFIX.length).split(':');
  if (parts.length !== 3) return null;
  try {
    const iv = Buffer.from(parts[0], 'base64');
    const tag = Buffer.from(parts[1], 'base64');
    const ciphertext = Buffer.from(parts[2], 'base64');
    if (iv.length !== 12 || tag.length !== 16) return null;
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}
