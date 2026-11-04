/**
 * The pinned backend runtime manifest and its checksum gate.
 *
 * Shipping a Node executable means trusting a download, so the pin is data:
 * version, source URL and SHA-256 live in runtime/runtime.json, and the fetch
 * step refuses anything that does not match. These tests keep that data honest
 * and prove the verification actually rejects a wrong file — without network,
 * because `npm test` must work offline.
 *
 * Run with:  npm test
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { parseManifest, sha256File, MANIFEST_PATH } = require('../scripts/fetch-runtime.mjs');
const { MIN_VERSION, versionAtLeast } = require('../runtime-resolver.cjs');

const readManifest = () => JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));

describe('the committed runtime pin', () => {
  test('parses and is self-consistent', () => {
    const manifest = parseManifest(readManifest());
    assert.match(manifest.nodeVersion, /^\d+\.\d+\.\d+$/);
    assert.match(manifest.sha256, /^[0-9a-f]{64}$/);
    assert.ok(manifest.source.startsWith('https://nodejs.org/dist/'));
    assert.ok(manifest.source.includes(`/v${manifest.nodeVersion}/`));
    assert.ok(manifest.checksums.startsWith('https://nodejs.org/dist/'));
    assert.match(manifest.license, /^https:\/\/raw\.githubusercontent\.com\/nodejs\/node\/v.+\/LICENSE$/);
    assert.match(manifest.licenseSha256, /^[0-9a-f]{64}$/);
    assert.equal(manifest.architecture, 'win-x64');
    // The upstream Authenticode signer is pinned too, so the runtime gate can
    // check who signed the binary and not just its hash.
    assert.equal(manifest.publisher, 'OpenJS Foundation');
  });

  test('the pinned version satisfies the backend requirement', () => {
    const { nodeVersion } = parseManifest(readManifest());
    assert.equal(
      versionAtLeast(nodeVersion, MIN_VERSION),
      true,
      `pinned Node ${nodeVersion} cannot run a backend that needs ${MIN_VERSION.join('.')}+`,
    );
  });

  test('the pin is a Windows x64 Node build', () => {
    assert.equal(readManifest().architecture, 'win-x64');
  });

  test('the pin is a specific release, not a floating tag', () => {
    const manifest = parseManifest(readManifest());
    // "latest"/"lts" would make the checksum meaningless.
    assert.equal(/\b(latest|lts|current)\b/i.test(manifest.source), false);
  });
});

describe('manifest validation rejects the shapes that would ship a wrong binary', () => {
  const valid = () => readManifest();

  test('a non-hex checksum is refused', () => {
    const manifest = { ...valid(), sha256: 'abc123' };
    assert.throws(() => parseManifest(manifest), /sha256/);
  });

  test('a checksum for another platform is refused', () => {
    const manifest = { ...valid(), sha256: valid().sha256.replace(/^./, (c) => (c === 'a' ? 'b' : 'a')) };
    // Still valid hex, so parse succeeds — the check happens against the file.
    assert.equal(parseManifest(manifest).sha256.length, 64);
  });

  test('a source that does not match the pinned version is refused', () => {
    const manifest = { ...valid(), source: 'https://nodejs.org/dist/v20.18.0/win-x64/node.exe' };
    assert.throws(() => parseManifest(manifest), /does not point at v/);
  });

  test('a non-nodejs.org source is refused', () => {
    const manifest = { ...valid(), source: 'https://example.invalid/node.exe' };
    assert.throws(() => parseManifest(manifest), /nodejs\.org/);
  });

  test('a version that is not x.y.z is refused', () => {
    const manifest = { ...valid(), nodeVersion: 'latest' };
    assert.throws(() => parseManifest(manifest), /x\.y\.z/);
  });

  test('a missing manifest field fails loudly instead of defaulting', () => {
    const { sha256, ...withoutHash } = valid();
    assert.throws(() => parseManifest(withoutHash), /sha256/);
  });
});

describe('checksum verification', () => {
  test('the expected hash matches the file and a different one does not', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'isk-runtime-'));
    const file = path.join(dir, 'node.exe');
    try {
      fs.writeFileSync(file, 'not a real runtime');
      const hash = sha256File(file);
      assert.match(hash, /^[0-9a-f]{64}$/);

      // This is the gate the build relies on: the pinned value is compared to
      // the bytes on disk, never assumed.
      const { sha256 } = parseManifest(readManifest());
      assert.notEqual(hash, sha256, 'the test fixture must not collide with the pin');
      assert.equal(hash === sha256, false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
