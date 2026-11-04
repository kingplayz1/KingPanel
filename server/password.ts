/**
 * Password hashing for the panel's local account store.
 *
 * Why scrypt and not bcrypt/argon2id: both of those are native addons. This app
 * ships inside an Electron asar with a Node-ABI-sensitive native dependency
 * already (better-sqlite3), and a second one has to be rebuilt for every
 * Electron/Node upgrade or the packaged backend refuses to load — the failure
 * only shows up in an installed build, not in `npm run dev`. `crypto.scrypt` is
 * memory-hard, available in every Node build Electron ships, and needs no
 * compiler. It is an accepted password KDF (OWASP lists it alongside argon2id),
 * and the stored format is self-describing, so swapping the algorithm later is
 * a per-hash upgrade rather than a migration.
 *
 * Stored format:
 *   scrypt$<N>$<r>$<p>$<salt-base64>$<key-base64>
 *
 * The legacy format is a bare lowercase hex SHA-256 over
 * `isking_salt_v48:<password>`: single round, one salt for every account in
 * every installation. Those hashes still verify (nobody is locked out) and are
 * reported as `needsRehash` so the caller can replace them the moment the
 * correct password is presented.
 */
import crypto from 'node:crypto';

/** Parameters for new hashes. Changing these changes the string, not the code. */
const N = 16384;
const R = 8;
const P = 1;
const KEY_LEN = 64;
const SALT_BYTES = 16;
/**
 * Upper bounds accepted from a stored hash. A row is data, and a row that asks
 * for gigabytes is a denial of service aimed at whoever signs in next (it cost
 * ~8s and 1 GB with N=2^20 in the test that caught this), so anything above
 * these ceilings is treated as malformed instead of executed.
 */
const MAX_N = 1 << 18;
const MAX_R = 16;
const MAX_P = 8;
const MAX_KDF_BYTES = 256 * 1024 * 1024;

export const MIN_PASSWORD_LENGTH = 8;
/** scrypt cost is independent of input length; this only stops absurd bodies. */
export const MAX_PASSWORD_LENGTH = 200;

const SCRYPT_PREFIX = 'scrypt';
const LEGACY_HEX = /^[0-9a-f]{64}$/;
const LEGACY_SALT = 'isking_salt_v48:';

export interface PasswordCheck {
  ok: boolean;
  /** True when the stored value used the legacy format and should be replaced. */
  needsRehash: boolean;
  /** Why the check failed. Never contains the supplied or stored password. */
  reason?: 'empty' | 'malformed' | 'mismatch';
}

/** The pre-migration hash. Kept only so existing rows keep working. */
export function legacySha256(plain: string): string {
  return crypto.createHash('sha256').update(`${LEGACY_SALT}${plain}`).digest('hex');
}

export function isLegacyHash(stored: string): boolean {
  return LEGACY_HEX.test(stored);
}

export function isScryptHash(stored: string): boolean {
  return typeof stored === 'string' && stored.startsWith(`${SCRYPT_PREFIX}$`);
}

function scryptKey(plain: string, salt: Buffer, n: number, r: number, p: number, len: number): Buffer {
  // maxmem tracks the parameters actually requested: the default cap would
  // reject the current N=16384,r=8 on some builds, and a generous fixed cap
  // would let a hostile row allocate more than it asked for.
  const needed = 128 * n * r;
  return crypto.scryptSync(plain, salt, len, { N: n, r, p, maxmem: needed * 2 });
}

/** Hash a password for storage. Always produces the current format. */
export function hashPassword(plain: string): string {
  const salt = crypto.randomBytes(SALT_BYTES);
  const key = scryptKey(String(plain), salt, N, R, P, KEY_LEN);
  return [
    SCRYPT_PREFIX,
    N,
    R,
    P,
    salt.toString('base64'),
    key.toString('base64'),
  ].join('$');
}

function safeEqual(a: Buffer, b: Buffer): boolean {
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/**
 * Verify a password against a stored hash.
 *
 * A malformed or unparseable stored value fails closed like a wrong password —
 * it never throws, so a corrupted row cannot turn into an auth bypass or a 500
 * that the client might treat as "try again".
 */
export function verifyPassword(plain: unknown, stored: unknown): PasswordCheck {
  if (typeof plain !== 'string' || typeof stored !== 'string' || !stored) {
    return { ok: false, needsRehash: false, reason: 'empty' };
  }
  if (plain.length === 0 || plain.length > MAX_PASSWORD_LENGTH) {
    return { ok: false, needsRehash: false, reason: 'empty' };
  }

  // Legacy: bare 64-hex SHA-256 with the installation-wide salt.
  if (LEGACY_HEX.test(stored)) {
    const candidate = Buffer.from(legacySha256(plain), 'hex');
    const expected = Buffer.from(stored, 'hex');
    const ok = safeEqual(candidate, expected);
    return { ok, needsRehash: ok, reason: ok ? undefined : 'mismatch' };
  }

  if (!stored.startsWith(`${SCRYPT_PREFIX}$`)) {
    return { ok: false, needsRehash: false, reason: 'malformed' };
  }
  const parts = stored.split('$');
  if (parts.length !== 6) return { ok: false, needsRehash: false, reason: 'malformed' };

  const n = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  const salt = Buffer.from(parts[4], 'base64');
  const expected = Buffer.from(parts[5], 'base64');

  // A hostile or corrupt row must not be able to demand gigabytes of memory.
  if (
    !Number.isInteger(n) || !Number.isInteger(r) || !Number.isInteger(p) ||
    n <= 1 || r <= 0 || p <= 0 ||
    n > MAX_N || r > MAX_R || p > MAX_P ||
    128 * n * r > MAX_KDF_BYTES ||
    salt.length < 8 || expected.length < 16
  ) {
    return { ok: false, needsRehash: false, reason: 'malformed' };
  }

  let candidate: Buffer;
  try {
    candidate = scryptKey(plain, salt, n, r, p, expected.length);
  } catch {
    return { ok: false, needsRehash: false, reason: 'malformed' };
  }
  const ok = safeEqual(candidate, expected);
  // A correct password against weaker-than-current parameters is rehashed.
  const needsRehash = ok && (n !== N || r !== R || p !== P || expected.length !== KEY_LEN);
  return { ok, needsRehash, reason: ok ? undefined : 'mismatch' };
}

/** Route-level password policy. Returns a message, or null when acceptable. */
export function passwordPolicyError(value: unknown, label = 'Password'): string | null {
  if (typeof value !== 'string' || value.length === 0) return `${label} is required.`;
  if (value.length < MIN_PASSWORD_LENGTH) {
    return `${label} must be at least ${MIN_PASSWORD_LENGTH} characters.`;
  }
  if (value.length > MAX_PASSWORD_LENGTH) {
    return `${label} must be at most ${MAX_PASSWORD_LENGTH} characters.`;
  }
  return null;
}
