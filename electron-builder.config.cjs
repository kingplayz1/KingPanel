/**
 * electron-builder configuration, derived from package.json.
 *
 * Why this file exists: `build` in package.json is JSON, so it cannot select a
 * signer at runtime or carry a function. The two requirements it must satisfy are
 * conditional:
 *
 *   - SHA-256 only. electron-builder's default is `['sha1','sha256']`, which
 *     produces a deprecated SHA-1 signature on every artifact. That default has to
 *     be overridden for both providers, unconditionally.
 *   - A custom sign hook for cloud signing. `win.signtoolOptions.sign` must only be
 *     set when a cloud provider is configured: when it is set, electron-builder
 *     stops invoking signtool itself, so the PFX path would stop working.
 *
 * Everything else (NSIS options, files, extraResources, publish) is taken from
 * package.json unchanged, so this file cannot drift into a second source of truth
 * for the installer.
 */
const path = require('node:path');
const pkg = require('./package.json');
const { DEFAULT_TIMESTAMP_SERVER, PROVIDERS } = require('./scripts/signing-config.cjs');

const build = JSON.parse(JSON.stringify(pkg.build ?? {}));
const policy = pkg.iskSigning ?? {};
const env = process.env;
const present = (name) => Boolean(String(env[name] ?? '').trim());

const requested = String(env.ISK_SIGN_PROVIDER ?? '').trim().toLowerCase();
const detected = present('CSC_LINK')
  ? 'pfx'
  : PROVIDERS.esigner.credentialVars.some(present)
    ? 'esigner'
    : 'none';
const provider = requested || detected;

const expectedPublisher = String(policy.expectedPublisher ?? '').trim();
const timestampServer =
  String(env.ISK_TIMESTAMP_SERVER ?? '').trim() ||
  String(policy.timestampServer ?? '').trim() ||
  DEFAULT_TIMESTAMP_SERVER;

// Deliberately not conditioned on the environment: a SHA-1 signature must not be
// produced by any build of this project, signed or not.
build.win = {
  ...(build.win ?? {}),
  signtoolOptions: {
    ...(build.win?.signtoolOptions ?? {}),
    signingHashAlgorithms: ['sha256'],
    rfc3161TimeStampServer: timestampServer,
    // electron-builder writes this into resources/app-update.yml, which is what
    // electron-updater checks a downloaded installer against. Without it the
    // updater skips signature verification entirely (NsisUpdater.verifySignature
    // returns null when publisherName is absent).
    ...(expectedPublisher ? { publisherName: expectedPublisher } : {}),
    ...(provider === 'esigner'
      ? { sign: path.join(__dirname, 'scripts', 'cloud-sign-hook.cjs') }
      : {}),
  },
};

module.exports = build;
