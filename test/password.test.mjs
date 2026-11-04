/**
 * Password storage and verification.
 *
 * These run against the real module (no server boot) so a bad hash format or a
 * broken legacy path fails here in milliseconds rather than in an installed
 * build where nobody can sign in.
 *
 * Run with:  npm test
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  hashPassword,
  verifyPassword,
  isLegacyHash,
  isScryptHash,
  legacySha256,
  passwordPolicyError,
  MIN_PASSWORD_LENGTH,
} from '../server/password.ts';

describe('password hashing', () => {
  test('new hashes use the scrypt format with a per-password salt', () => {
    const a = hashPassword('correct horse battery staple');
    const b = hashPassword('correct horse battery staple');

    assert.ok(isScryptHash(a));
    assert.match(a, /^scrypt\$\d+\$\d+\$\d+\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/);
    // Identical input, different salt, different stored value.
    assert.notEqual(a, b);
    assert.equal(isLegacyHash(a), false);
  });

  test('the stored hash never contains the password', () => {
    const password = 'Sunflower#2026';
    assert.equal(hashPassword(password).includes(password), false);
  });

  test('a correct password verifies and a wrong one does not', () => {
    const stored = hashPassword('Sunflower#2026');
    assert.deepEqual(verifyPassword('Sunflower#2026', stored), { ok: true, needsRehash: false, reason: undefined });
    const wrong = verifyPassword('sunflower#2026', stored);
    assert.equal(wrong.ok, false);
    assert.equal(wrong.needsRehash, false);
    assert.equal(wrong.reason, 'mismatch');
  });

  test('a malformed or empty stored value fails closed instead of throwing', () => {
    for (const stored of ['', 'not-a-hash', 'scrypt$1$2', 'scrypt$abc$8$1$AA$BB', null, undefined]) {
      const result = verifyPassword('anything', stored);
      assert.equal(result.ok, false, `expected rejection for ${String(stored)}`);
    }
    assert.equal(verifyPassword('', hashPassword('x')).ok, false);
  });

  test('a hostile cost parameter is rejected rather than executed', () => {
    // N far beyond any legitimate configuration: must not allocate memory for it.
    const hash = `scrypt$1048576$8$1$${Buffer.alloc(16, 1).toString('base64')}$${Buffer.alloc(64, 2).toString('base64')}`;
    const started = Date.now();
    const result = verifyPassword('anything', hash);
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'malformed');
    assert.ok(Date.now() - started < 2000, 'must not attempt the stated cost');
  });
});

describe('legacy SHA-256 migration path', () => {
  // The exact hash the published build wrote for its seeded Super Admin.
  const LEGACY_SUPER_ADMIN = legacySha256('KingPlayz#2026');

  test('the legacy format is a bare 64-byte hex digest', () => {
    assert.match(LEGACY_SUPER_ADMIN, /^[0-9a-f]{64}$/);
    assert.equal(isLegacyHash(LEGACY_SUPER_ADMIN), true);
    assert.equal(isScryptHash(LEGACY_SUPER_ADMIN), false);
  });

  test('a legacy hash still verifies so no account is locked out', () => {
    const result = verifyPassword('KingPlayz#2026', LEGACY_SUPER_ADMIN);
    assert.equal(result.ok, true);
    assert.equal(result.needsRehash, true, 'a legacy match must be reported for rehash');
  });

  test('a wrong password against a legacy hash is rejected', () => {
    const result = verifyPassword('KingPlayz#2025', LEGACY_SUPER_ADMIN);
    assert.equal(result.ok, false);
    assert.equal(result.needsRehash, false);
  });

  test('rehashing after a legacy login produces a scrypt hash that verifies', () => {
    const legacy = verifyPassword('KingPlayz#2026', LEGACY_SUPER_ADMIN);
    assert.equal(legacy.needsRehash, true);

    const upgraded = hashPassword('KingPlayz#2026');
    assert.ok(isScryptHash(upgraded));
    const after = verifyPassword('KingPlayz#2026', upgraded);
    assert.equal(after.ok, true);
    assert.equal(after.needsRehash, false);
  });

  test('the published default password is detectable from its legacy hash', () => {
    // This is what the start-up rotation relies on to find compromised rows.
    assert.equal(verifyPassword('kingpanel123', legacySha256('kingpanel123')).ok, true);
    assert.equal(verifyPassword('KingPlayz#2026', legacySha256('kingpanel123')).ok, false);
  });
});

describe('password policy', () => {
  test('rejects short passwords', () => {
    assert.ok(passwordPolicyError('a'.repeat(MIN_PASSWORD_LENGTH - 1)));
    assert.equal(passwordPolicyError('a'.repeat(MIN_PASSWORD_LENGTH)), null);
  });

  test('rejects empty, non-string and over-long values', () => {
    assert.ok(passwordPolicyError(''));
    assert.ok(passwordPolicyError(undefined));
    assert.ok(passwordPolicyError(12345678));
    assert.ok(passwordPolicyError('a'.repeat(201)));
  });

  test('names the field it is complaining about', () => {
    assert.match(String(passwordPolicyError('short', 'New password')), /New password/);
  });
});
