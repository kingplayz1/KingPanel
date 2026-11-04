#!/usr/bin/env node
/**
 * Build the two installers that `verify:upgrade` compares, reproducibly.
 *
 * The upgrade test needs an older build and the release candidate. Both sides
 * used to be hand-made directories in `.tmp/e2e` that nobody could recreate;
 * this script produces them from the current source tree at chosen versions:
 *
 *   node scripts/make-upgrade-fixtures.mjs --from-version 1.0.1
 *     -> .tmp/e2e/v1.0.1 (older) and .tmp/e2e/v1.0.2 (the candidate)
 *
 * Flags: --cache (reuse valid fixtures), --force (rebuild regardless),
 *        --clear-cache (delete generated fixtures), --allow-dirty,
 *        --only from|to, --out <dir>, --skip-build.
 *
 * Why this shape:
 *  - The fixtures must install without elevation and must look for updates on
 *    the harness's local feed, so `nsis.perMachine=false` and
 *    `publish.provider=generic` are forced. The real release installer is
 *    per-machine, which is why the candidate is packaged again here rather than
 *    copied out of `dist_electron` (see scripts/verify-machine-install.mjs for
 *    that side).
 *  - The version comes from `extraMetadata.version`, so `package.json` on disk is
 *    never rewritten and `git status` stays clean. Bumping the version in place
 *    is how a release ships with the wrong number.
 *  - The packaging rules are copied from the real build, so a fixture cannot
 *    contain something a release would not — including developer data.
 *
 * Each result lands in `.tmp/e2e/v<version>/` with a `fixture.json` describing
 * exactly which inputs produced it; see scripts/fixture-cache.mjs for what has to
 * match before a fixture may be reused.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  cacheVerdict,
  clearFixtures,
  configDigest,
  fixtureManifest,
  reuseDecision,
  runtimeDigest,
  sourceDigest,
} from './fixture-cache.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FEED_URL = 'http://127.0.0.1:8899/';
const SEMVER = /^\d+\.\d+\.\d+([-+][0-9A-Za-z.-]+)?$/;

export function arg(name, fallback = null) {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : (process.argv[index + 1] ?? fallback);
}

/**
 * The electron-builder config for a fixture.
 *
 * Everything a real release needs is kept (packaging rules, runtime extra
 * resources, artifact naming, the afterPack runtime check); only what the
 * upgrade test depends on is overridden.
 */
export function fixtureConfig(pkg, { version, outDir, feedUrl = FEED_URL }) {
  const build = JSON.parse(JSON.stringify(pkg.build ?? {}));
  build.directories = { ...(build.directories ?? {}), output: outDir };
  build.extraMetadata = { ...(build.extraMetadata ?? {}), version };
  build.nsis = {
    ...(build.nsis ?? {}),
    oneClick: false,
    perMachine: false, // no elevation: the harness must run as a normal user
    allowToChangeInstallationDirectory: true,
    createDesktopShortcut: false,
    createStartMenuShortcut: false,
  };
  build.publish = { provider: 'generic', url: feedUrl };
  return build;
}

export function fixtureDir(outRoot, version) {
  return path.join(outRoot, `v${version}`);
}

/** Reject inputs that would produce a test that cannot mean anything. */
export function validateFromVersion(version, currentVersion) {
  if (!version) return 'a --from-version is required (for example 1.0.1)';
  if (!SEMVER.test(version)) return `"${version}" is not a semver version`;
  if (version === currentVersion) {
    return `both sides would be ${version}; an upgrade needs two different versions`;
  }
  const rank = (v) => v.split(/[-+]/)[0].split('.').map(Number);
  const [a, b] = [rank(version), rank(currentVersion)];
  for (let i = 0; i < 3; i += 1) {
    if (a[i] < b[i]) return null;
    if (a[i] > b[i]) {
      return `the older fixture version ${version} is newer than the candidate ${currentVersion}; --from-version is the *older* build`;
    }
  }
  return null;
}

function git(args) {
  const result = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8' });
  return result.status === 0 ? (result.stdout || '').trim() : '';
}

function readYamlVersion(file) {
  const text = fs.readFileSync(file, 'utf8');
  return /^version:\s*(.+)$/m.exec(text)?.[1]?.trim() ?? null;
}

function run(label, command, args, options = {}) {
  console.log(`\n=== ${label} ===`);
  const result = spawnSync(command, args, { cwd: ROOT, stdio: 'inherit', env: { ...process.env, ...options.env } });
  if (result.error) throw new Error(`${label} could not start: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`${label} exited with code ${result.status}`);
}

/** The inputs that a fixture's bytes depend on, hashed once per run. */
function inputsFor(pkg, version, outDir) {
  return {
    source: sourceDigest(ROOT).digest,
    config: configDigest(fixtureConfig(pkg, { version, outDir })),
    runtime: runtimeDigest(path.join(ROOT, 'runtime', 'runtime.json')),
    electronBuilder: String(pkg.devDependencies?.['electron-builder'] ?? 'unknown'),
  };
}

/** Package one version of the current tree as a per-user fixture. */
function buildFixture(pkg, { version, outRoot, env }) {
  const outDir = fixtureDir(outRoot, version);
  fs.mkdirSync(outDir, { recursive: true });

  const configPath = path.join(outDir, 'fixture-builder.json');
  fs.writeFileSync(configPath, `${JSON.stringify(fixtureConfig(pkg, { version, outDir }), null, 2)}\n`, 'utf8');
  console.log(`[fixtures] packaging v${version} into ${path.relative(ROOT, outDir)}`);

  const started = Date.now();
  run(
    `Packaging fixture v${version}`,
    process.execPath,
    [
      path.join('node_modules', 'electron-builder', 'out', 'cli', 'cli.js'),
      '--win',
      '--x64',
      '--publish',
      'never',
      '--config',
      configPath,
    ],
    // Fixtures are throwaway unsigned builds; never borrow a store certificate.
    { env: { CSC_IDENTITY_AUTO_DISCOVERY: 'false' } },
  );

  const names = fs.readdirSync(outDir);
  const installer = names.find((name) => name.endsWith('.exe') && !name.includes('uninstaller'));
  if (!installer) throw new Error(`electron-builder produced no installer in ${outDir}`);
  if (!names.includes('latest.yml')) throw new Error(`electron-builder produced no latest.yml in ${outDir}`);
  const builtVersion = readYamlVersion(path.join(outDir, 'latest.yml'));
  if (builtVersion !== version) {
    throw new Error(
      `the fixture reports version ${builtVersion}, not ${version}; extraMetadata.version did not take effect, ` +
        'so the upgrade test would compare a build with itself',
    );
  }

  const manifest = fixtureManifest({
    version,
    inputs: env.inputs,
    installerPath: path.join(outDir, installer),
    buildMs: Date.now() - started,
    commit: env.commit,
    dirty: env.dirty,
    config: path.basename(configPath),
    feed: FEED_URL,
  });
  fs.writeFileSync(path.join(outDir, 'fixture.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

  console.log(
    `[fixtures] v${version} built: ${installer} (${(manifest.installer.size / 1024 / 1024).toFixed(1)} MB, ` +
      `${(manifest.buildMs / 1000).toFixed(0)}s, sha256 ${manifest.installer.sha256.slice(0, 16)}…)`,
  );
  return { outDir, manifest, reused: false };
}

function main() {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const fromVersion = arg('--from-version');
  const toVersion = arg('--to-version', pkg.version);
  const only = arg('--only'); // 'from' | 'to' | absent (both)
  const outRoot = path.resolve(ROOT, arg('--out', path.join('.tmp', 'e2e')));
  const skipBuild = process.argv.includes('--skip-build');
  const useCache = process.argv.includes('--cache');
  const force = process.argv.includes('--force');
  const allowDirty = process.argv.includes('--allow-dirty');

  if (process.argv.includes('--clear-cache')) {
    const { removed, skipped } = clearFixtures(outRoot);
    console.log(
      `[fixtures] cleared ${removed.length} fixture(s) from ${path.relative(ROOT, outRoot)}` +
        (removed.length ? `: ${removed.join(', ')}` : '') +
        (skipped.length ? `\n[fixtures] left alone (no fixture.json): ${skipped.join(', ')}` : ''),
    );
    return;
  }

  if (only && only !== 'from' && only !== 'to') {
    throw new Error(`--only takes "from" or "to", not "${only}"`);
  }

  const invalid = validateFromVersion(fromVersion, toVersion);
  if (invalid) throw new Error(invalid);

  const dirty = git(['status', '--porcelain']) !== '';
  const env = {
    commit: git(['rev-parse', 'HEAD']),
    dirty,
    inputs: null,
  };

  const sides = [];
  if (!only || only === 'from') sides.push(fromVersion);
  if (!only || only === 'to') sides.push(toVersion);

  // Decide before building anything: a fully cached run must not rebuild the UI.
  const plans = sides.map((version) => {
    const outDir = fixtureDir(outRoot, version);
    const inputs = inputsFor(pkg, version, outDir);
    const verdict = cacheVerdict({ fixtureDir: outDir, expected: { version, inputs } });
    const decision = reuseDecision({ verdict, force, dirty, allowDirty });
    return { version, outDir, inputs, verdict, decision };
  });

  const toBuild = plans.filter((plan) => !plan.decision.reuse);
  for (const plan of plans) {
    if (plan.decision.reuse) {
      console.log(
        `[fixtures] reusing v${plan.version} (built ${plan.verdict.manifest.builtAt}, ` +
          `sha256 ${plan.verdict.manifest.installer.sha256.slice(0, 16)}…)`,
      );
    } else {
      console.log(`[fixtures] v${plan.version} will be rebuilt: ${plan.decision.reasons.join('; ')}`);
    }
  }

  if (toBuild.length && !skipBuild) {
    run('Backend bundle', process.execPath, [path.join('scripts', 'build-backend.mjs')]);
    run('UI build', process.execPath, [path.join('node_modules', 'vite', 'bin', 'vite.js'), 'build']);
  }

  const results = plans.map((plan) => {
    if (plan.decision.reuse) {
      return { outDir: plan.outDir, manifest: plan.verdict.manifest, reused: true };
    }
    return buildFixture(pkg, { version: plan.version, outRoot, env: { ...env, inputs: plan.inputs } });
  });

  const saved = results.filter((result) => result.reused).reduce((total, result) => total + (result.manifest.buildMs ?? 0), 0);
  console.log(
    `\n[fixtures] source ${env.commit.slice(0, 7) || 'unknown'}${dirty ? ' (dirty)' : ''}` +
      results
        .map(
          ({ outDir, manifest, reused }) =>
            `\n  v${manifest.version}  ${path.relative(ROOT, outDir)}  ${reused ? 'reused' : 'built'}  ` +
            `${(manifest.installer.size / 1024 / 1024).toFixed(1)} MB  ${manifest.installer.sha256.slice(0, 16)}…`,
        )
        .join('') +
      (saved ? `\n[fixtures] cache saved ~${(saved / 1000).toFixed(0)}s of packaging time` : '') +
      '\n[fixtures] next: node scripts/verify-installed-upgrade.mjs',
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    main();
  } catch (err) {
    console.error(`\n[fixtures] FAILED: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }
}
