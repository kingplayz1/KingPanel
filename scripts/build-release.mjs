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
import { readFileSync } from 'node:fs';
import { readFile, readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import { EXTERNAL as BACKEND_EXTERNALS } from './build-backend.mjs';
import { resolveReleaseAssets } from './release-naming.mjs';

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
 * States what the produced installer is actually signed with, so a release
 * cannot silently drop from signed to unsigned (or the reverse) unnoticed.
 */
function reportSigningPosture() {
  const configured = ['CSC_LINK', 'WIN_CSC_LINK', 'CSC_NAME', 'WIN_CSC_NAME'].filter(
    (key) => process.env[key],
  );
  if (configured.length === 0) {
    console.warn(
      '[release] signing: no certificate configured (CSC_LINK/WIN_CSC_LINK unset) — ' +
        'the installer is unsigned and will warn on first run.',
    );
    return;
  }
  console.log(`[release] signing: certificate supplied via ${configured.join(', ')}`);
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

  const verifyOnly = process.argv.includes('--verify-only');
  if (verifyOnly) {
    console.log('[release] --verify-only: skipping build, verifying existing artifacts');
  } else {
    step(`Backend bundle (server.ts -> server.cjs)`);
    run('backend build', [path.join('scripts', 'build-backend.mjs')]);

    step('UI build (vite)');
    run('vite build', [path.join('node_modules', 'vite', 'bin', 'vite.js'), 'build']);

    step(`Packaging v${version} (NSIS, x64)`);
    await pruneStaleArtifacts();
    run('electron-builder', [
      path.join('node_modules', 'electron-builder', 'out', 'cli', 'cli.js'),
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

  step('Verifying release consistency');
  const installerPath = path.join(OUT_DIR, installerName);
  const { size } = await stat(installerPath).catch(() => {
    throw new Error(`Expected installer ${installerName} was not produced.`);
  });
  await stat(path.join(OUT_DIR, blockmapName)).catch(() => {
    throw new Error(`Expected blockmap ${blockmapName} was not produced.`);
  });

  const meta = yaml.load(await readFile(path.join(OUT_DIR, 'latest.yml'), 'utf8'));
  const listed = meta?.files?.[0] ?? {};
  const checksum = createHash('sha512').update(await readFile(installerPath)).digest('base64');

  const problems = [];
  if (meta?.version !== version) {
    problems.push(`latest.yml version ${meta?.version} != package.json ${version}`);
  }
  if (meta?.path !== installerName) {
    problems.push(`latest.yml path "${meta?.path}" != "${installerName}"`);
  }
  if (listed.url !== installerName) {
    problems.push(`latest.yml files[0].url "${listed.url}" != "${installerName}"`);
  }
  if (Number(listed.size) !== size) {
    problems.push(`latest.yml size ${listed.size} != ${size} bytes on disk`);
  }
  if (listed.sha512 !== checksum) {
    problems.push('latest.yml sha512 does not match the installer on disk');
  }
  if (meta?.sha512 && meta.sha512 !== listed.sha512) {
    problems.push('latest.yml top-level sha512 disagrees with files[0].sha512');
  }
  if (problems.length) {
    throw new Error(`Release metadata is inconsistent:\n  - ${problems.join('\n  - ')}`);
  }

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
  reportSigningPosture();

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
