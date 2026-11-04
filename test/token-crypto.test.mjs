/**
 * Provider-token encryption at rest.
 *
 * The interesting failures are not "it round-trips": they are a tampered
 * ciphertext being accepted, a missing key silently re-keying and orphaning
 * every stored token, and a legacy plaintext row becoming unreadable.
 *
 * Run with:  npm test
 */
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  resolveTokenKey,
  encryptSecret,
  decryptSecret,
  isEncryptedSecret,
} from '../server/token-crypto.ts';

let dir;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iskingpanel-tokens-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('secret encryption', () => {
  const key = crypto.randomBytes(32);

  test('a token round-trips and is not stored in the clear', () => {
    const token = 'discord-access-token-value';
    const sealed = encryptSecret(key, token);
    assert.ok(isEncryptedSecret(sealed));
    assert.equal(sealed.includes(token), false, 'the ciphertext must not contain the token');
    assert.equal(decryptSecret(key, sealed), token);
  });

  test('the same plaintext encrypts differently each time', () => {
    const a = encryptSecret(key, 'same-token');
    const b = encryptSecret(key, 'same-token');
    assert.notEqual(a, b, 'a fresh IV per value');
  });

  test('a tampered ciphertext is rejected, not returned as garbage', () => {
    const sealed = encryptSecret(key, 'token');
    const parts = sealed.split(':');
    const raw = Buffer.from(parts[4], 'base64');
    raw[0] ^= 0xff;
    const tampered = [...parts.slice(0, 4), raw.toString('base64')].join(':');
    assert.equal(decryptSecret(key, tampered), null);
  });

  test('a different key cannot read the value', () => {
    const sealed = encryptSecret(key, 'token');
    assert.equal(decryptSecret(crypto.randomBytes(32), sealed), null);
    assert.equal(decryptSecret(null, sealed), null);
  });

  test('legacy plaintext still reads, so an upgrade logs nobody out', () => {
    assert.equal(decryptSecret(key, 'plain-old-token'), 'plain-old-token');
    assert.equal(isEncryptedSecret('plain-old-token'), false);
  });

  test('empty values stay empty rather than becoming null-ish strings', () => {
    assert.equal(encryptSecret(key, ''), null);
    assert.equal(encryptSecret(key, null), null);
    assert.equal(decryptSecret(key, ''), null);
  });
});

describe('key resolution', () => {
  test('a valid environment key is used and never written to disk', () => {
    const key = crypto.randomBytes(32).toString('base64');
    const resolved = resolveTokenKey(dir, key);
    assert.equal(resolved.source, 'env');
    assert.equal(resolved.key.toString('base64'), key);
    assert.equal(fs.existsSync(path.join(dir, '.oauth-key')), false);
  });

  test('an invalid environment key fails loudly instead of re-keying', () => {
    const resolved = resolveTokenKey(dir, 'not-a-key');
    assert.equal(resolved.key, null);
    assert.match(String(resolved.error), /OAUTH_TOKEN_KEY/);
    // Crucially: it must not create a replacement key, which would make every
    // stored token permanently undecryptable.
    assert.equal(fs.existsSync(path.join(dir, '.oauth-key')), false);
  });

  test('without an environment key one is created once and then reused', () => {
    const first = resolveTokenKey(dir, '');
    assert.equal(first.source, 'file');
    assert.equal(first.key.length, 32);

    // A restart (a fresh resolve) must find the same key, or existing tokens die.
    const second = resolveTokenKey(dir, '');
    assert.equal(second.source, 'file');
    assert.equal(second.key.toString('base64'), first.key.toString('base64'));
  });

  test('a corrupt key file is reported, not replaced', () => {
    fs.writeFileSync(path.join(dir, '.oauth-key'), 'garbage');
    const resolved = resolveTokenKey(dir, '');
    assert.equal(resolved.key, null);
    assert.match(String(resolved.error), /does not contain a valid/);
    assert.equal(fs.readFileSync(path.join(dir, '.oauth-key'), 'utf8'), 'garbage');
  });

  test('a token encrypted before a restart decrypts after it', () => {
    const first = resolveTokenKey(dir, '');
    const sealed = encryptSecret(first.key, 'persisted-token');

    const second = resolveTokenKey(dir, '');
    assert.equal(decryptSecret(second.key, sealed), 'persisted-token');
  });
});
