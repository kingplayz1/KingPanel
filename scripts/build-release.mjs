#!/usr/bin/env node
/**
 * Single entry point for producing a Windows release: backend bundle -> UI build
 * -> NSIS installer, then a consistency check between the artifacts on disk and
 * the update metadata (latest.yml) that clients will read.
 *
 * Fails the run when:
 *  - the packaged backend is not byte-identical to the freshly built one, or
 *  - latest.yml points at an installer name that does not exist, or
 *  - latest.yml's size/hash do not match the installer that was produced.
 *
 * Run: npm run electron:build
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { readFile, readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import { EXTERNAL as BACKEND_EXTERNALS } from './build-backend.mjs';
import { resolveReleaseAssets } from './release-naming.mjs';
import { verifyArtifacts, verifyPackagedPrivacy, verifyPackagedRuntime } from './release-verify.mjs';
import { signingConfig } from './signing.mjs';
import {
  MANIFEST_PATH,
  parseManifest,
  verifyRuntimeExecutable,
} from './fetch-runtime.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = path.join(ROOT, 'dist_electron');
const UNPACKED = path.join(OUT_DIR, 'win-unpacked', 'resources', 'app.asar.unpacked', 'server.cjs');
// electron-builder writes this from build.publish; electron-updater reads it at
// runtime. It is the only thing that tells an installed copy where to look for
// a newer version, so a build without it silently loses the update feature.
const APP_UPDATE = path.join(OUT_DIR, 'win-unpacked', 'resources', 'app-update.yml');
const BACKEND = path.join(ROOT, 'server.cjs');

function step(name) {
  console.log(`\n=== ${name} ===`);
}

function run(label, args, opts = {}) {
  const result = spawnSync(process.execPath, args, {
    cwd: ROOT,
    stdio: 'inherit',
    env: { ...process.env, ...opts.env },
  });
  if (result.error) {
    throw new Error(`${label} failed to start: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(`${label} exited with code ${result.status ?? 'unknown'}`);
  }
}

async function sha256(file) {
  return createHash('sha256').update(await readFile(file)).digest('hex');
}

/**
 * electron-builder only sanitises the name it writes into latest.yml; it leaves
 * whatever it produced on disk untouched. Keeping the output directory clean
 * guarantees that the installer a human downloads is the one the updater
 * describes.
 */
async function pruneStaleArtifacts() {
  let entries;
  try {
    entries = await readdir(OUT_DIR);
  } catch {
    return; // first build
  }
  const stale = entries.filter(
    (name) =>
      /\.exe(\.blockmap)?$/i.test(name) ||
      /^latest.*\.ya?ml$/i.test(name),
  );
  for (const name of stale) {
    await rm(path.join(OUT_DIR, name), { force: true });
    console.log(`[release] removed stale artifact ${name}`);
  }
}

/**
 * An installed copy finds updates through resources/app-update.yml alone. If it
 * is absent, empty or points somewhere other than the configured publisher, the
 * app reports "no updates" forever instead of failing, which is impossible to
 * notice from the UI — so the release refuses to finish in that state.
 */
function verifyAppUpdateConfig(pkg) {
  const publish = pkg.build?.publish;
  if (!publish) {
    throw new Error(
      'build.publish is missing from package.json, so electron-builder emitted no ' +
        'app-update.yml. Installed copies would never find an update.',
    );
  }

  let raw;
  try {
    raw = readFileSync(APP_UPDATE, 'utf8');
  } catch {
    throw new Error(
      `The packaged build has no app-update.yml at ${path.relative(ROOT, APP_UPDATE)}. ` +
        'electron-updater would skip its check at runtime.',
    );
  }

  let config;
  try {
    config = yaml.load(raw);
  } catch (err) {
    throw new Error(`app-update.yml is not valid YAML: ${err.message}`);
  }
  if (!config || typeof config !== 'object') {
    throw new Error('app-update.yml did not parse to an object.');
  }

  const problems = [];
  if (config.provider !== publish.provider) {
    problems.push(`provider "${config.provider}" != "${publish.provider}"`);
  }
  if (publish.provider === 'github') {
    if (config.owner !== publish.owner) {
      problems.push(`owner "${config.owner}" != "${publish.owner}"`);
    }
    if (config.repo !== publish.repo) {
      problems.push(`repo "${config.repo}" != "${publish.repo}"`);
    }
  }
  if (!String(config.updaterCacheDirName || '').trim()) {
    problems.push('updaterCacheDirName is empty');
  }

  // electron-updater's only publisher check reads this field, and it *skips*
  // signature verification when the field is absent (NsisUpdater.verifySignature
  // returns null). A signed release must therefore declare the pinned identity,
  // and it must be the one we expect.
  const signing = signingConfig(process.env, { expectedPublisher: pkg.iskSigning?.expectedPublisher });
  if (signing.configured || signing.requireSigned) {
    const pinned = signing.expectedPublisher;
    const declared = Array.isArray(config.publisherName)
      ? config.publisherName
      : [config.publisherName].filter(Boolean);
    if (!declared.length) {
      problems.push(
        'publisherName is missing from app-update.yml, so electron-updater would skip signature ' +
          'verification of every downloaded installer',
      );
    } else if (pinned && !declared.some((name) => String(name).trim().toLowerCase() === pinned.toLowerCase())) {
      problems.push(`publisherName "${declared.join(' | ')}" != pinned "${pinned}"`);
    }
  }
  if (problems.length) {
    throw new Error(`app-update.yml does not describe the configured feed:\n  - ${problems.join('\n  - ')}`);
  }

  const feed =
    config.provider === 'github'
      ? `github:${config.owner}/${config.repo}`
      : `${config.provider}:${config.url || config.bucket || ''}`;
  console.log(`[release] app-update.yml -> ${feed} (cache dir: ${config.updaterCacheDirName})`);
}

/**
 * Modules deliberately left out of server.cjs (`node:sqlite` and the native
 * drivers are loaded by name at runtime). The packaged app is the only copy the
 * backend can resolve them from — node cannot read inside app.asar — so an
 * external that the bundle requires but the installer omits crashes the backend
 * on first use, long after the build reported success.
 */
function verifyBackendExternals() {
  const bundle = readFileSync(BACKEND, 'utf8');
  const appDir = path.join(OUT_DIR, 'win-unpacked', 'resources', 'app.asar.unpacked');
  const requireFromApp = createRequire(path.join(appDir, 'server.cjs'));

  const referenced = BACKEND_EXTERNALS.filter((name) => bundle.includes(`require("${name}")`));
  const missing = referenced.filter((name) => {
    try {
      requireFromApp.resolve(name);
      return false;
    } catch {
      return true;
    }
  });
  if (missing.length) {
    throw new Error(
      'server.cjs requires modules that the packaged app does not contain: ' +
        `${missing.join(', ')}. The backend would crash when that code path runs.`,
    );
  }

  console.log(
    `[release] backend externals: ${referenced.length} required, ` +
      `${referenced.length - missing.length} resolvable from the packaged app ` +
      `(${BACKEND_EXTERNALS.length - referenced.length} not referenced)`,
  );
}

/**
 * The installer must carry the pinned runtime, outside the asar (a binary inside
 * an archive cannot be executed). Checked after packaging rather than trusted
 * from the config: an `extraResources` typo produces a build that installs and
 * then cannot start its backend.
 */
async function verifyBundledRuntime() {
  const manifest = parseManifest(JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')));
  const resourcesDir = path.join(OUT_DIR, 'win-unpacked', 'resources');
  const problems = verifyPackagedRuntime({ resourcesDir, manifestPath: MANIFEST_PATH });
  if (problems.length) {
    throw new Error(`The packaged app is not releasable:\n  - ${problems.join('\n  - ')}`);
  }

  // Structural checks above; this one proves the shipped bytes actually run and
  // can load node:sqlite, which a matching hash alone cannot establish.
  const packaged = path.join(resourcesDir, 'runtime', 'node.exe');
  const problem = verifyRuntimeExecutable(packaged, manifest);
  if (problem) throw new Error(`The packaged runtime does not work: ${problem}`);

  console.log(
    `[release] runtime: resources/runtime/node.exe Node ${manifest.nodeVersion}, ` +
      `sha256 ${manifest.sha256.slice(0, 16)}… verified with node:sqlite`,
  );
}

/**
 * States what the produced installer is actually signed with, so a release
 * cannot silently drop from signed to unsigned (or the reverse) unnoticed.
 */
function reportSigningPosture(pkg) {
  const config = signingConfig(process.env, { expectedPublisher: pkg.iskSigning?.expectedPublisher });
  if (config.problems.length) {
    throw new Error(`Signing configuration is invalid:\n  - ${config.problems.join('\n  - ')}`);
  }
  if (!config.configured) {
    console.warn(
      '[release] signing: no signing provider configured — the installer is unsigned and ' +
        'will warn on first run. That is fine locally and is refused in release mode.',
    );
    return;
  }
  console.log(
    `[release] signing: ${config.provider.label}, ${config.hashAlgorithm.toUpperCase()} only, ` +
      `timestamp ${config.timestampServer}`,
  );
  console.log(
    `[release] signing: expected publisher "${config.expectedPublisher || '(not pinned)'}"`,
  );
}

async function main() {
  const pkg = JSON.parse(await readFile(path.join(ROOT, 'package.json'), 'utf8'));
  // Shared with scripts/release-assets.mjs so the names on disk, the names in
  // latest.yml and the names CI publishes cannot drift apart.
  const {
    version,
    installer: installerName,
    blockmap: blockmapName,
  } = resolveReleaseAssets(pkg);

  // Refuse before packaging, not mid-way: electron-builder cannot derive a
  // publisher from a cloud signer, so a cloud build without a pinned identity
  // fails deep inside packaging with an unhelpful message.
  const signing = signingConfig(process.env, { expectedPublisher: pkg.iskSigning?.expectedPublisher });
  if (signing.method === 'esigner' && !signing.expectedPublisher) {
    throw new Error(
      'Cloud signing needs the certificate identity: set iskSigning.expectedPublisher in ' +
        'package.json to the CN of the eSigner certificate before building.',
    );
  }

  const verifyOnly = process.argv.includes('--verify-only');
  if (verifyOnly) {
    console.log('[release] --verify-only: skipping build, verifying existing artifacts');
  } else {
    step(`Backend bundle (server.ts -> server.cjs)`);
    run('backend build', [path.join('scripts', 'build-backend.mjs')]);

    step('UI build (vite)');
    run('vite build', [path.join('node_modules', 'vite', 'bin', 'vite.js'), 'build']);

    // The packaged backend cannot use Electron's Node (20.18) and must not rely
    // on the user's PATH, so the installer has to carry a runtime. This fetches
    // the pinned build, refuses anything whose SHA-256 does not match, and
    // proves the binary reports the pinned version and loads node:sqlite.
    step('Backend runtime (pinned Node)');
    run('runtime fetch', [path.join('scripts', 'fetch-runtime.mjs')]);

    step(`Packaging v${version} (NSIS, x64)`);
    await pruneStaleArtifacts();
    // The config file carries what package.json cannot: SHA-256-only signing and,
    // for a cloud provider, the custom sign hook. It is derived from
    // package.json, so the NSIS options still have exactly one definition.
    run('electron-builder', [
      path.join('node_modules', 'electron-builder', 'out', 'cli', 'cli.js'),
      '--config',
      path.join(ROOT, 'electron-builder.config.cjs'),
      '--win',
      '--x64',
      // Metadata is generated, but uploading is a separate, authorised decision.
      '--publish',
      'never',
    ], {
      // Never pick up an unrelated certificate from the Windows store.
      env: { CSC_IDENTITY_AUTO_DISCOVERY: 'false' },
    });
  }

  step('Verifying the installer carries the pinned runtime');
  await verifyBundledRuntime();

  // Fails the build, not just the tag workflow: a locally built installer that
  // carries this machine's database must not even reach dist_electron as
  // something a human could hand to someone else.
  step('Verifying the installer carries no developer data');
  const privacy = verifyPackagedPrivacy({ dir: OUT_DIR });
  if (privacy.problems.length) {
    throw new Error(`The packaged app contains data that must not be shipped:\n  - ${privacy.problems.join('\n  - ')}`);
  }
  console.log(
    `[release] privacy: ${privacy.facts.payloadEntries} payload file(s), ` +
      `${privacy.facts.dependencyEntries} dependency file(s), ` +
      `${privacy.facts.sqliteInspected} database(s) inspected, ` +
      `${privacy.facts.stateFilesInspected} state file(s) scanned`,
  );

  // Same checks the publish workflow applies to the downloaded copies, from one
  // definition (scripts/release-verify.mjs): tag, artifact set, latest.yml and
  // blockmap consistency, stray artifacts.
  step('Verifying release consistency');
  const verified = await verifyArtifacts({ dir: OUT_DIR, pkg, tag: `v${version}` });
  if (verified.problems.length) {
    throw new Error(`Release metadata is inconsistent:\n  - ${verified.problems.join('\n  - ')}`);
  }
  const size = verified.sizes.installer;

  // Authenticode, after the manifest check: the signature must be on the exact
  // bytes latest.yml describes, or a signed build would still fail to update.
  // Fails in release mode (ISK_REQUIRE_SIGNING=1) and prints the unsigned notice
  // for a local build. The certificate itself is never read or logged here.
  step('Verifying code signatures');
  run('signature verification', [path.join('scripts', 'verify-signatures.mjs')]);

  const packagedBackend = await sha256(UNPACKED).catch(() => null);
  const builtBackend = await sha256(BACKEND);
  if (packagedBackend !== builtBackend) {
    throw new Error(
      'The packaged backend (app.asar.unpacked/server.cjs) does not match the ' +
        'freshly built server.cjs. The installer would ship a stale backend.',
    );
  }

  verifyAppUpdateConfig(pkg);
  verifyBackendExternals();
  reportSigningPosture(pkg);

  console.log(`\n[release] v${version} ready in dist_electron/`);
  console.log(`[release]   ${installerName}  ${(size / 1024 / 1024).toFixed(1)} MB`);
  console.log(`[release]   ${blockmapName}`);
  console.log(`[release]   latest.yml  (sha512 verified against the installer)`);
  console.log(`[release]   app-update.yml (feed matches build.publish)`);
  console.log(`[release]   backend    sha256=${builtBackend.slice(0, 16)}… (packaged copy matches)`);
}

main().catch((err) => {
  console.error(`\n[release] FAILED: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
