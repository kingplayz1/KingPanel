/**
 * Signing pipeline: provider selection, digest policy, publisher pinning and
 * uninstaller coverage.
 *
 * Everything here runs against injected runners and mocked Authenticode output.
 * There is no certificate in this repository, so these tests prove the *policy*
 * and the *plumbing*, not that a real certificate chain validates. That claim
 * needs a real signed build and is reported as NOT TESTED.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  PROVIDERS,
  resolveProvider,
  signingConfig,
  digestPolicy,
  verifyDigests,
  readDigests,
  normaliseReport,
} from '../scripts/signing.mjs';
import { verifyReleaseSignatures, releaseExecutables } from '../scripts/release-verify.mjs';
import { redact, esignerArgs, esignerEnv, runSigner, signWithProvider } from '../scripts/cloud-sign.mjs';
import builderProviders from '../scripts/signing-config.cjs';
import cloudSignHook from '../scripts/cloud-sign-hook.cjs';
import builderConfig from '../electron-builder.config.cjs';

const PIN = 'IS King Panel Ltd';
const SUBJECT = `CN=${PIN}, O=${PIN}, C=IN`;
const THUMB = 'AABBCCDDEEFF00112233445566778899AABBCCDD';

const ESIGNER_ENV = {
  ISK_SIGN_PROVIDER: 'esigner',
  ESIGNER_USERNAME: 'publisher@example.com',
  ESIGNER_PASSWORD: 'not-a-real-password',
  ESIGNER_TOTP_SECRET: 'JBSWY3DPEHPK3PXP',
  ESIGNER_CREDENTIAL_ID: '01234567-89ab-cdef-0123-456789abcdef',
};

const validReport = (overrides = {}) =>
  normaliseReport({
    Status: 'Valid',
    SignerSubject: SUBJECT,
    Thumbprint: THUMB,
    TimeStamperSubject: 'CN=DigiCert Timestamp 2024, O=DigiCert, C=US',
    ...overrides,
  });

let workDir;
before(() => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'isk-pipeline-'));
});
after(() => fs.rmSync(workDir, { recursive: true, force: true }));

describe('provider resolution', () => {
  test('the CJS provider table used by the builder config matches the ESM one', () => {
    for (const id of Object.keys(PROVIDERS)) {
      assert.deepEqual(
        [...builderProviders.PROVIDERS[id].credentialVars],
        [...PROVIDERS[id].credentialVars],
        `provider ${id} drifted between signing.mjs and signing-config.cjs`,
      );
    }
    assert.equal(builderProviders.DEFAULT_TIMESTAMP_SERVER, 'http://timestamp.digicert.com');
  });

  test('no credentials means no provider, and no complaint unless signing is required', () => {
    const provider = resolveProvider({});
    assert.equal(provider.id, 'none');
    assert.equal(provider.configured, false);
    assert.deepEqual(provider.problems, []);
  });

  test('an unknown provider is refused instead of falling back', () => {
    const provider = resolveProvider({ ISK_SIGN_PROVIDER: 'acme-hsm', CSC_LINK: 'x', CSC_KEY_PASSWORD: 'y' });
    assert.equal(provider.id, 'unknown');
    assert.ok(provider.problems.some((p) => /not a supported provider/.test(p)));
  });

  test('two credential sets without an explicit provider are ambiguous', () => {
    const provider = resolveProvider({ CSC_LINK: 'x', CSC_KEY_PASSWORD: 'y', ESIGNER_USERNAME: 'u' });
    assert.ok(provider.problems.some((p) => /both PFX and eSigner credentials/.test(p)));
  });

  test('a partial eSigner configuration names the missing variables, never the values', () => {
    const env = { ...ESIGNER_ENV };
    delete env.ESIGNER_TOTP_SECRET;
    const config = signingConfig(env);
    assert.equal(config.method, 'esigner');
    assert.equal(config.configured, false);
    assert.ok(config.problems.some((p) => /ESIGNER_TOTP_SECRET is missing/.test(p)));
    const serialised = JSON.stringify(config);
    assert.equal(serialised.includes(env.ESIGNER_PASSWORD), false);
    assert.equal(serialised.includes(env.ESIGNER_TOTP_SECRET), false);
  });

  test('a complete eSigner configuration is accepted and carries no secrets', () => {
    const config = signingConfig(ESIGNER_ENV);
    assert.equal(config.configured, true);
    assert.equal(config.method, 'esigner');
    assert.deepEqual(config.problems, []);
    assert.equal(config.hashAlgorithm, 'sha256');
    const serialised = JSON.stringify(config);
    for (const name of PROVIDERS.esigner.credentialVars) {
      assert.equal(serialised.includes(ESIGNER_ENV[name]), false, `${name} leaked into the config`);
    }
  });

  test('a PFX without a password is still refused', () => {
    const config = signingConfig({ CSC_LINK: 'cert.pfx' });
    assert.ok(config.problems.some((p) => /CSC_KEY_PASSWORD is empty/.test(p)));
  });

  test('release mode without a pinned publisher is a problem', () => {
    const config = signingConfig(ESIGNER_ENV, { expectedPublisher: '' });
    config.requireSigned = false;
    const release = signingConfig({ ...ESIGNER_ENV, ISK_REQUIRE_SIGNING: '1' }, { expectedPublisher: '' });
    assert.ok(release.problems.some((p) => /no expected publisher is pinned/.test(p)));
  });

  test('a non-HTTP timestamp server is refused on the PFX path', () => {
    const config = signingConfig({
      CSC_LINK: 'cert.pfx',
      CSC_KEY_PASSWORD: 'pw',
      ISK_TIMESTAMP_SERVER: 'timestamp.example.com',
    });
    assert.ok(config.problems.some((p) => /not an http\(s\) RFC 3161 URL/.test(p)));
  });

  test('the eSigner path reports its own fixed TSA instead of pretending to choose one', () => {
    // CodeSignTool timestamps with TSA_URL from its properties file; there is no
    // flag for it, so an override here must not be described as applied.
    const config = signingConfig({
      ...ESIGNER_ENV,
      ISK_TIMESTAMP_SERVER: 'http://timestamp.example.com',
    });
    assert.match(config.timestampServer, /ts\.ssl\.com/);
    assert.deepEqual(config.problems, []);
  });
});

describe('SHA-256 only', () => {
  test('a single SHA-256 signature passes', () => {
    assert.deepEqual(digestPolicy({ label: 'app.exe', algorithms: ['SHA256'] }), []);
  });

  test('the electron-builder dual-sign default is refused', () => {
    const problems = digestPolicy({ label: 'app.exe', algorithms: ['SHA1', 'SHA256'] });
    assert.ok(problems.some((p) => /SHA-1 signature/.test(p)));
  });

  test('a SHA-1-only signature is refused', () => {
    assert.ok(digestPolicy({ label: 'app.exe', algorithms: ['SHA1'] }).some((p) => /SHA-1/.test(p)));
  });

  test('an unexpected digest and an unsigned file are refused', () => {
    assert.ok(digestPolicy({ label: 'app.exe', algorithms: ['MD5'] }).some((p) => /MD5/.test(p)));
    assert.ok(digestPolicy({ label: 'app.exe', algorithms: [] }).some((p) => /no signature digest/.test(p)));
    assert.ok(
      digestPolicy({ label: 'app.exe', algorithms: [], error: 'boom' }).some((p) => /could not be read/.test(p)),
    );
  });

  test('a missing signtool is reported instead of pretending the file is unsigned', () => {
    // The digest reader parses signtool's `Hash of file (sha256)` lines; without
    // the tool it must say so, not silently pass a signed build.
    const result = readDigests('anything.exe', {
      env: { 'ProgramFiles(x86)': 'Z:\\definitely-not-here' },
    });
    assert.deepEqual(result.algorithms, []);
    assert.match(result.error, /signtool was not found/);
  });

  test('the digest runner reads every artifact and reports each one', () => {
    const file = path.join(workDir, 'signed.exe');
    fs.writeFileSync(file, 'x');
    const result = verifyDigests({
      files: [{ label: 'signed.exe', file }],
      readDigests: () => ({ algorithms: ['SHA256'], error: null }),
    });
    assert.deepEqual(result.problems, []);
    assert.deepEqual(result.facts, [{ label: 'signed.exe', algorithms: ['SHA256'] }]);
  });
});

describe('cloud signing adapter', () => {
  test('credentials are redacted from anything that could be logged', () => {
    const text = `login failed for ${ESIGNER_ENV.ESIGNER_USERNAME} with ${ESIGNER_ENV.ESIGNER_PASSWORD}`;
    const cleaned = redact(text, ESIGNER_ENV);
    assert.equal(cleaned.includes(ESIGNER_ENV.ESIGNER_PASSWORD), false);
    assert.ok(cleaned.includes('[redacted]'));
  });

  test('the CLI receives one flag per credential and the file paths', () => {
    const args = esignerArgs({ file: 'C:\\build\\app.exe', outputDir: 'C:\\tmp\\out', env: ESIGNER_ENV });
    assert.equal(args[0], 'sign');
    assert.ok(args.includes(`-username=${ESIGNER_ENV.ESIGNER_USERNAME}`));
    assert.ok(args.includes(`-credential_id=${ESIGNER_ENV.ESIGNER_CREDENTIAL_ID}`));
    assert.ok(args.includes('-input_file_path=C:\\build\\app.exe'));
    assert.ok(args.includes('-output_dir_path=C:\\tmp\\out'));
    // The output directory is always fresh, so no overwrite flag is needed; the
    // tool's own synopsis does not list one for `sign`.
    assert.equal(args.some((value) => value.startsWith('-override')), false);
  });

  test('a .bat signer is launched through cmd, with each argument quoted', () => {
    // Windows cannot CreateProcess a batch file: CodeSignTool ships as one, so the
    // adapter has to go through the command interpreter and quote paths itself.
    const calls = [];
    runSigner('C:\\tools\\CodeSignTool.bat', ['sign', '-input_file_path=C:\\a b\\app.exe'], {
      run: (command, args, options) => {
        calls.push({ command, args, options });
        return { status: 0 };
      },
      env: { ComSpec: 'C:\\Windows\\System32\\cmd.exe' },
    });
    assert.equal(calls[0].command, 'C:\\Windows\\System32\\cmd.exe');
    assert.deepEqual(calls[0].args.slice(0, 3), ['/d', '/s', '/c']);
    assert.equal(
      calls[0].args[3],
      '""C:\\tools\\CodeSignTool.bat" "sign" "-input_file_path=C:\\a b\\app.exe""',
      'cmd /s /c wraps the whole command in an extra quote pair',
    );
    assert.equal(calls[0].options.windowsVerbatimArguments, true);
    // The tool resolves ./conf against the working directory, so it must run there.
    assert.equal(calls[0].options.cwd, 'C:\\tools');

    // A plain executable is invoked directly, with no shell in between.
    runSigner('C:\\tools\\signer.exe', ['--file', 'app.exe'], {
      run: (command, args, options) => {
        calls.push({ command, args, options });
        return { status: 0 };
      },
      env: {},
    });
    assert.equal(calls[1].command, 'C:\\tools\\signer.exe');
    assert.equal(calls[1].options.cwd, 'C:\\tools');
  });

  test('the sandbox is ENVIRONMENT_NAME=TEST, not a different executable', () => {
    assert.equal(esignerEnv({}).ENVIRONMENT_NAME, 'PROD');
    assert.equal(esignerEnv({ ESIGNER_SANDBOX: '1' }).ENVIRONMENT_NAME, 'TEST');
    // Generic names the tool also honours must not be injected from the runner.
    assert.equal(Object.hasOwn(esignerEnv({ USERNAME: 'runner' }), 'PASSWORD'), false);
  });

  test('the signing hook refuses to overwrite the bundled runtime signature', async () => {
    await assert.rejects(
      () =>
        cloudSignHook({
          path: 'E:\\build\\dist_electron\\win-unpacked\\resources\\runtime\\node.exe',
          hash: 'sha256',
        }),
      /refusing to sign/,
    );
  });

  test('the builder config signs SHA-256 only and excludes node.exe', () => {
    assert.deepEqual(builderConfig.win.signtoolOptions.signingHashAlgorithms, ['sha256']);
    assert.ok(
      builderConfig.win.signExts.includes('!node.exe'),
      'electron-builder signs every .exe unless node.exe is excluded',
    );
    assert.equal(builderConfig.nsis.perMachine, true, 'the NSIS configuration must be unchanged');
  });

  test('it refuses to run without eSigner credentials', () => {
    assert.throws(
      () => signWithProvider(path.join(workDir, 'whatever.exe'), { env: {}, run: () => ({ status: 0 }) }),
      /cloud-sign requires|not a supported|invalid/,
    );
  });

  test('it fails closed when the provider CLI is unavailable', () => {
    const file = path.join(workDir, 'app-to-sign.exe');
    fs.writeFileSync(file, 'binary');
    assert.throws(
      () =>
        signWithProvider(file, {
          env: ESIGNER_ENV,
          run: () => ({ error: new Error('spawn CodeSignTool.bat ENOENT'), status: null }),
        }),
      /could not run the eSigner CLI/,
    );
  });

  test('a non-zero exit reports the sanitised output', () => {
    const file = path.join(workDir, 'app-to-sign-2.exe');
    fs.writeFileSync(file, 'binary');
    assert.throws(
      () =>
        signWithProvider(file, {
          env: ESIGNER_ENV,
          run: () => ({ status: 1, stdout: '', stderr: `bad credentials ${ESIGNER_ENV.ESIGNER_PASSWORD}` }),
        }),
      (err) => /exited with 1/.test(err.message) && !err.message.includes(ESIGNER_ENV.ESIGNER_PASSWORD),
    );
  });
});

describe('release policy: pin and uninstaller', () => {
  const pkg = {
    name: 'react-example',
    version: '1.2.3',
    iskSigning: { expectedPublisher: PIN, uninstallerName: 'Uninstall IS King Panel.exe' },
    build: {
      productName: 'IS King Panel',
      win: { artifactName: 'IS-King-Panel-Setup-${version}.${ext}' },
    },
  };

  function releaseDir({ uninstaller = false } = {}) {
    const dir = fs.mkdtempSync(path.join(workDir, 'rel-'));
    fs.mkdirSync(path.join(dir, 'win-unpacked', 'resources', 'runtime'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'IS-King-Panel-Setup-1.2.3.exe'), 'installer');
    fs.writeFileSync(path.join(dir, 'win-unpacked', 'IS King Panel.exe'), 'app');
    fs.writeFileSync(path.join(dir, 'win-unpacked', 'resources', 'runtime', 'node.exe'), 'node');
    if (uninstaller) {
      fs.writeFileSync(path.join(dir, 'win-unpacked', 'Uninstall IS King Panel.exe'), 'uninstaller');
    }
    return dir;
  }

  const openjs = () =>
    normaliseReport({
      Status: 'Valid',
      SignerSubject: 'CN=OpenJS Foundation, O=OpenJS Foundation, C=US',
      Thumbprint: '1111111111111111111111111111111111111111',
      TimeStamperSubject: 'CN=Microsoft Public RSA Time Stamping Authority, O=Microsoft',
    });

  function withEnv(env, fn) {
    const saved = {};
    for (const [key, value] of Object.entries(env)) {
      saved[key] = process.env[key];
      process.env[key] = value;
    }
    try {
      return fn();
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  }

  const signedEnv = { ...ESIGNER_ENV, ISK_REQUIRE_SIGNING: '1' };

  test('a pinned, correctly signed release with no uninstaller yet is accepted', () => {
    const dir = releaseDir();
    const result = withEnv(signedEnv, () =>
      verifyReleaseSignatures({
        dir,
        pkg,
        runtimePublisher: 'OpenJS Foundation',
        requireSigned: true,
        readSignature: (file) => (/node\.exe$/.test(file) ? openjs() : validReport()),
        readDigests: () => ({ algorithms: ['SHA256'], error: null }),
      }),
    );
    assert.deepEqual(result.problems, []);
    assert.equal(result.uninstaller, null);
  });

  test('a certificate with the wrong publisher fails even when it is trusted', () => {
    const dir = releaseDir();
    const result = withEnv(signedEnv, () =>
      verifyReleaseSignatures({
        dir,
        pkg,
        runtimePublisher: 'OpenJS Foundation',
        requireSigned: true,
        readSignature: (file) =>
          /node\.exe$/.test(file) ? openjs() : validReport({ SignerSubject: 'CN=Someone Else, O=Elsewhere, C=US' }),
        readDigests: () => ({ algorithms: ['SHA256'], error: null }),
      }),
    );
    assert.ok(result.problems.some((p) => /publisher "Someone Else" != expected/.test(p)));
  });

  test('a SHA-1 dual-signed release is refused', () => {
    const dir = releaseDir();
    const result = withEnv(signedEnv, () =>
      verifyReleaseSignatures({
        dir,
        pkg,
        runtimePublisher: 'OpenJS Foundation',
        requireSigned: true,
        readSignature: (file) => (/node\.exe$/.test(file) ? openjs() : validReport()),
        readDigests: () => ({ algorithms: ['SHA1', 'SHA256'], error: null }),
      }),
    );
    assert.ok(result.problems.some((p) => /SHA-1/.test(p)));
  });

  test('a release with no pinned publisher is refused', () => {
    const dir = releaseDir();
    const unpinned = { ...pkg, iskSigning: {} };
    const result = withEnv(signedEnv, () =>
      verifyReleaseSignatures({
        dir,
        pkg: unpinned,
        runtimePublisher: 'OpenJS Foundation',
        requireSigned: true,
        readSignature: (file) => (/node\.exe$/.test(file) ? openjs() : validReport()),
        readDigests: () => ({ algorithms: ['SHA256'], error: null }),
      }),
    );
    assert.ok(result.problems.some((p) => /no expected publisher is pinned/.test(p)));
  });

  test('an installed uninstaller is discovered and checked with the same policy', () => {
    const dir = releaseDir({ uninstaller: true });
    const { ourFiles, uninstaller } = releaseExecutables({
      dir,
      pkg,
      runtimePublisher: 'OpenJS Foundation',
    });
    assert.ok(ourFiles.some((file) => /Uninstall/.test(file.label)));
    assert.ok(uninstaller);

    const signed = withEnv(signedEnv, () =>
      verifyReleaseSignatures({
        dir,
        pkg,
        runtimePublisher: 'OpenJS Foundation',
        requireSigned: true,
        readSignature: (file) => (/node\.exe$/.test(file) ? openjs() : validReport()),
        readDigests: () => ({ algorithms: ['SHA256'], error: null }),
      }),
    );
    assert.deepEqual(signed.problems, []);

    const wrongPublisher = withEnv(signedEnv, () =>
      verifyReleaseSignatures({
        dir,
        pkg,
        runtimePublisher: 'OpenJS Foundation',
        requireSigned: true,
        readSignature: (file) => {
          if (/node\.exe$/.test(file)) return openjs();
          if (/Uninstall/.test(file)) return validReport({ SignerSubject: 'CN=Not Us, O=Not Us, C=US' });
          return validReport();
        },
        readDigests: () => ({ algorithms: ['SHA256'], error: null }),
      }),
    );
    assert.ok(wrongPublisher.problems.some((p) => /Uninstall IS King Panel\.exe publisher/.test(p)));

    const unsignedUninstaller = withEnv(signedEnv, () =>
      verifyReleaseSignatures({
        dir,
        pkg,
        runtimePublisher: 'OpenJS Foundation',
        requireSigned: true,
        readSignature: (file) => {
          if (/node\.exe$/.test(file)) return openjs();
          if (/Uninstall/.test(file)) return normaliseReport({ Status: 'NotSigned' });
          return validReport();
        },
        readDigests: () => ({ algorithms: ['SHA256'], error: null }),
      }),
    );
    assert.ok(unsignedUninstaller.problems.some((p) => /Uninstall IS King Panel\.exe is not signed/.test(p)));
  });

  test('a required but missing uninstaller is reported, not skipped', () => {
    const dir = releaseDir();
    const result = withEnv(signedEnv, () =>
      verifyReleaseSignatures({
        dir,
        pkg,
        runtimePublisher: 'OpenJS Foundation',
        requireSigned: true,
        requireUninstaller: true,
        installedDir: path.join(dir, 'Program Files', 'IS King Panel'),
        readSignature: (file) => (/node\.exe$/.test(file) ? openjs() : validReport()),
        readDigests: () => ({ algorithms: ['SHA256'], error: null }),
      }),
    );
    assert.ok(result.problems.some((p) => /NSIS uninstaller was not found/.test(p)));
  });
});
