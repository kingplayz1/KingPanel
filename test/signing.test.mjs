/**
 * Authenticode policy — tested against mocked verifier output.
 *
 * There is no certificate in this repository and no signed build to inspect, so
 * these tests prove the *policy*: which reported states are refused, and that an
 * unsigned local build is allowed but never described as signed. They do not
 * prove real certificate trust — only a real signing run plus signtool can.
 *
 * Run with:  npm test
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  signingConfig,
  publisherName,
  normaliseReport,
  checkSignature,
  verifySignatures,
} from '../scripts/signing.mjs';
import { verifyReleaseSignatures } from '../scripts/release-verify.mjs';

const OUR_PUBLISHER = 'IS King Panel Ltd';
const OUR_SUBJECT = `CN=${OUR_PUBLISHER}, O=${OUR_PUBLISHER}, C=AU`;
const THUMB = 'AABBCCDDEEFF00112233445566778899AABBCCDD';

const valid = (overrides = {}) =>
  normaliseReport({
    Status: 'Valid',
    SignerSubject: OUR_SUBJECT,
    Thumbprint: THUMB,
    TimeStamperSubject: 'CN=DigiCert Timestamp 2024, O=DigiCert, C=US',
    ...overrides,
  });

let workDir;
before(() => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'isk-signing-'));
});
after(() => fs.rmSync(workDir, { recursive: true, force: true }));

describe('signing configuration', () => {
  test('release mode without a certificate is a problem, not a silent pass', () => {
    const config = signingConfig({ ISK_REQUIRE_SIGNING: '1' });
    assert.equal(config.requireSigned, true);
    assert.equal(config.configured, false);
    assert.ok(config.problems.some((p) => /CSC_LINK is not set/.test(p)));
  });

  test('a certificate without its password is refused', () => {
    const config = signingConfig({ CSC_LINK: 'base64-or-path' });
    assert.ok(config.problems.some((p) => /CSC_KEY_PASSWORD is empty/.test(p)));
  });

  test('a complete configuration is accepted and reports no secrets', () => {
    const config = signingConfig({ CSC_LINK: '/secrets/cert.pfx', CSC_KEY_PASSWORD: 'hunter2' });
    assert.deepEqual(config.problems, []);
    assert.equal(config.configured, true);
    // The config object must never carry the values themselves.
    assert.equal(JSON.stringify(config).includes('hunter2'), false);
    assert.equal(JSON.stringify(config).includes('/secrets/cert.pfx'), false);
  });

  test('a local build with no certificate is simply unsigned', () => {
    const config = signingConfig({});
    assert.equal(config.configured, false);
    assert.equal(config.requireSigned, false);
    assert.deepEqual(config.problems, []);
  });
});

describe('publisher parsing', () => {
  test('reads CN from a Windows subject', () => {
    assert.equal(publisherName('CN=Acme Ltd, O=Acme Ltd, L=Sydney, C=AU'), 'Acme Ltd');
  });

  test('handles a quoted CN and a missing CN', () => {
    assert.equal(publisherName('O=Acme, CN="Acme Holdings, Inc."'), 'Acme Holdings, Inc.');
    assert.equal(publisherName('O=Acme, C=AU'), '');
    assert.equal(publisherName(''), '');
  });

  test('maps Get-AuthenticodeSignature statuses onto the policy vocabulary', () => {
    assert.equal(normaliseReport({ Status: 'Valid' }).status, 'valid');
    assert.equal(normaliseReport({ Status: 'NotSigned' }).status, 'missing');
    assert.equal(normaliseReport({ Status: 'HashMismatch' }).status, 'tampered');
    assert.equal(normaliseReport({ Status: 'NotTrusted' }).status, 'untrusted');
    assert.equal(normaliseReport({ Status: 'UnknownError' }).status, 'unknown');
  });
});

describe('single-file policy', () => {
  test('a signed file is fine only when trusted, timestamped and expected', () => {
    assert.deepEqual(
      checkSignature({ label: 'app.exe', report: valid(), expectedPublisher: OUR_PUBLISHER }),
      [],
    );
  });

  test('missing signature fails in release mode and passes in local mode', () => {
    const report = normaliseReport({ Status: 'NotSigned' });
    assert.ok(
      checkSignature({ label: 'app.exe', report, requireSigned: true }).some((p) => /is not signed/.test(p)),
    );
    assert.deepEqual(checkSignature({ label: 'app.exe', report, requireSigned: false }), []);
  });

  test('an invalid or tampered signature always fails', () => {
    const tampered = normaliseReport({ Status: 'HashMismatch', SignerSubject: OUR_SUBJECT });
    assert.ok(checkSignature({ label: 'app.exe', report: tampered }).some((p) => /tampered/.test(p)));

    const untrusted = valid({ Status: 'NotTrusted' });
    assert.ok(checkSignature({ label: 'app.exe', report: untrusted }).some((p) => /trusted root/.test(p)));
  });

  test('a valid signature without a timestamp fails, because it will expire', () => {
    const report = valid({ TimeStamperSubject: '' });
    assert.ok(checkSignature({ label: 'app.exe', report }).some((p) => /not timestamped/.test(p)));
  });

  test('a different publisher is refused', () => {
    const report = valid({ SignerSubject: 'CN=Someone Else, O=Elsewhere, C=US' });
    assert.ok(
      checkSignature({ label: 'app.exe', report, expectedPublisher: OUR_PUBLISHER }).some((p) =>
        /publisher "Someone Else" != expected/.test(p),
      ),
    );
  });

  test('a different certificate for the same publisher is refused', () => {
    const report = valid({ Thumbprint: 'FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF' });
    assert.ok(
      checkSignature({ label: 'app.exe', report, expectedThumbprint: THUMB }).some((p) =>
        /different certificate/.test(p),
      ),
    );
  });
});

describe('artifact set', () => {
  function touch(name) {
    const file = path.join(workDir, name);
    fs.writeFileSync(file, 'binary');
    return { label: name, file };
  }

  const runtime = () => ({
    label: 'resources/runtime/node.exe',
    file: touch('node.exe').file,
    expectedPublisher: 'OpenJS Foundation',
  });

  const openjs = () =>
    normaliseReport({
      Status: 'Valid',
      SignerSubject: 'CN=OpenJS Foundation, O=OpenJS Foundation, C=US',
      Thumbprint: '1111111111111111111111111111111111111111',
      TimeStamperSubject: 'CN=Microsoft Public RSA Time Stamping Authority, O=Microsoft',
    });

  test('consistent publishers pass', () => {
    const app = touch('app.exe');
    const installer = touch('installer.exe');
    const result = verifySignatures({
      ourFiles: [app, installer],
      runtime: runtime(),
      requireSigned: true,
      readSignature: (file) =>
        file === runtime().file ? openjs() : valid(),
    });
    assert.deepEqual(result.problems, []);
  });

  test('two different certificates across our files are refused', () => {
    const app = touch('app2.exe');
    const installer = touch('installer2.exe');
    const result = verifySignatures({
      ourFiles: [app, installer],
      requireSigned: true,
      readSignature: (file) =>
        file === app.file ? valid() : valid({ Thumbprint: '2222222222222222222222222222222222222222' }),
    });
    assert.ok(result.problems.some((p) => /different certificates/.test(p)));
  });

  test('an unsigned runtime is refused even when our files are signed', () => {
    const app = touch('app3.exe');
    const result = verifySignatures({
      ourFiles: [app],
      runtime: runtime(),
      requireSigned: true,
      readSignature: (file) =>
        file === runtime().file ? normaliseReport({ Status: 'NotSigned' }) : valid(),
    });
    assert.ok(result.problems.some((p) => /runtime\/node\.exe is not signed/.test(p)));
  });

  test('a runtime signed by the wrong publisher is refused', () => {
    const app = touch('app4.exe');
    const result = verifySignatures({
      ourFiles: [app],
      runtime: runtime(),
      requireSigned: true,
      readSignature: (file) =>
        file === runtime().file
          ? valid({ SignerSubject: 'CN=Not Node, O=Not Node, C=US' })
          : valid(),
    });
    assert.ok(result.problems.some((p) => /publisher "Not Node" != expected "OpenJS Foundation"/.test(p)));
  });

  test('a missing file is reported instead of being skipped', () => {
    const result = verifySignatures({
      ourFiles: [{ label: 'installer.exe', file: path.join(workDir, 'nope.exe') }],
      requireSigned: true,
      readSignature: () => valid(),
    });
    assert.ok(result.problems.some((p) => /installer\.exe is missing/.test(p)));
  });
});

describe('release verification', () => {
  const pkg = {
    name: 'react-example',
    version: '1.2.3',
    build: {
      productName: 'IS King Panel',
      win: { artifactName: 'IS-King-Panel-Setup-${version}.${ext}' },
    },
  };

  function releaseDir() {
    const dir = fs.mkdtempSync(path.join(workDir, 'rel-'));
    fs.mkdirSync(path.join(dir, 'win-unpacked', 'resources', 'runtime'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'IS-King-Panel-Setup-1.2.3.exe'), 'installer');
    fs.writeFileSync(path.join(dir, 'win-unpacked', 'IS King Panel.exe'), 'app');
    fs.writeFileSync(path.join(dir, 'win-unpacked', 'resources', 'runtime', 'node.exe'), 'node');
    return dir;
  }

  test('local mode tolerates unsigned app/installer but never an unsigned runtime', () => {
    const dir = releaseDir();
    const nodeExe = path.join(dir, 'win-unpacked', 'resources', 'runtime', 'node.exe');
    const result = verifyReleaseSignatures({
      dir,
      pkg,
      runtimePublisher: 'OpenJS Foundation',
      requireSigned: false,
      readSignature: (file) =>
        file === nodeExe
          ? normaliseReport({
              Status: 'Valid',
              SignerSubject: 'CN=OpenJS Foundation, O=OpenJS Foundation, C=US',
              Thumbprint: '1111111111111111111111111111111111111111',
              TimeStamperSubject: 'CN=Microsoft Public RSA Time Stamping Authority, O=Microsoft',
            })
          : normaliseReport({ Status: 'NotSigned' }),
    });
    assert.deepEqual(result.problems, []);
  });

  test('release mode refuses an unsigned build', () => {
    const dir = releaseDir();
    const previous = process.env.ISK_REQUIRE_SIGNING;
    process.env.ISK_REQUIRE_SIGNING = '1';
    try {
      const result = verifyReleaseSignatures({
        dir,
        pkg,
        runtimePublisher: 'OpenJS Foundation',
        requireSigned: true,
        readSignature: () => normaliseReport({ Status: 'NotSigned' }),
      });
      assert.ok(result.problems.some((p) => /requires a signing certificate/.test(p)));
      assert.ok(result.problems.some((p) => /is not signed/.test(p)));
    } finally {
      if (previous === undefined) delete process.env.ISK_REQUIRE_SIGNING;
      else process.env.ISK_REQUIRE_SIGNING = previous;
    }
  });

  test('release mode refuses a tampered executable', () => {
    const dir = releaseDir();
    const result = verifyReleaseSignatures({
      dir,
      pkg,
      runtimePublisher: 'OpenJS Foundation',
      requireSigned: false,
      readSignature: () => normaliseReport({ Status: 'HashMismatch', SignerSubject: OUR_SUBJECT }),
    });
    assert.ok(result.problems.some((p) => /tampered/.test(p)));
  });
});
