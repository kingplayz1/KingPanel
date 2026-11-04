/**
 * Strict reuse of upgrade fixtures.
 *
 * Rebuilding both installers takes about four minutes, which is long enough that
 * people skip the upgrade test. Caching is only worth having if a stale cache
 * cannot pass for a fresh build, so a fixture is reused only when every input that
 * affects its bytes still matches:
 *
 *   version · source digest · builder config digest · runtime pin · electron-builder
 *
 * and the installer is still exactly the file the manifest recorded. Anything
 * else — including a dirty tree without an explicit override — rebuilds.
 *
 * The source digest covers the files that produce the application, not the whole
 * checkout: build outputs (`dist/`, `server.cjs`, `dist_electron/`, `.tmp/`) and
 * developer data are excluded, so touching a log or the local database neither
 * invalidates a cache nor silently reuses one.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/** Files that change the built application. Directories are walked. */
export const FIXTURE_INPUTS = [
  'package.json',
  'package-lock.json',
  'server.ts',
  'electron-main.cjs',
  'electron-preload.cjs',
  'runtime-resolver.cjs',
  'state-dirs.cjs',
  'vite.config.ts',
  'tsconfig.json',
  'tsconfig.build.json',
  'index.html',
  'metadata.json',
  'build',
  'src',
  'server',
  'scripts',
];

const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex');

export function hashFile(file) {
  try {
    return sha256(fs.readFileSync(file));
  } catch {
    return null;
  }
}

/**
 * One digest over every input file, so a single changed byte anywhere invalidates
 * the fixture.
 */
export function sourceDigest(root, inputs = FIXTURE_INPUTS) {
  const files = [];
  const collect = (abs) => {
    const stat = fs.statSync(abs, { throwIfNoEntry: false });
    if (!stat) return;
    if (stat.isDirectory()) {
      for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
        if (entry.isDirectory() && ['node_modules', '.git', 'dist', 'dist_electron', '.tmp'].includes(entry.name)) {
          continue;
        }
        collect(path.join(abs, entry.name));
      }
      return;
    }
    files.push(path.relative(root, abs).split(path.sep).join('/'));
  };
  for (const input of inputs) collect(path.join(root, input));
  files.sort();
  const lines = files.map((rel) => `${rel}:${hashFile(path.join(root, rel)) ?? 'missing'}`);
  return { digest: sha256(lines.join('\n')), fileCount: files.length };
}

/** The runtime pin is an input: a different pinned Node is a different build. */
export function runtimeDigest(manifestPath) {
  return hashFile(manifestPath) ?? 'missing';
}

/** The builder config, as JSON, so a changed NSIS or packaging rule invalidates. */
export function configDigest(config) {
  return sha256(JSON.stringify(config));
}

/**
 * The record written next to each fixture.
 *
 * `installer.sha256` is what makes reuse safe: a fixture whose installer was
 * replaced or truncated is not reused even if every input still matches.
 */
export function fixtureManifest({
  version,
  inputs,
  installerPath,
  buildMs,
  commit,
  dirty,
  config,
  feed,
}) {
  const stat = fs.statSync(installerPath);
  return {
    schema: 1,
    version,
    builtAt: new Date().toISOString(),
    buildMs: buildMs ?? null,
    commit,
    dirty,
    feed,
    config,
    inputs,
    installer: {
      name: path.basename(installerPath),
      size: stat.size,
      sha256: hashFile(installerPath),
    },
  };
}

/**
 * Whether an existing fixture directory can be used for this version.
 *
 * Returns `{ usable, reasons, manifest }`; `reasons` names every mismatch so a
 * rebuild is never mysterious.
 */
export function cacheVerdict({ fixtureDir, expected }) {
  const reasons = [];
  const manifestPath = path.join(fixtureDir, 'fixture.json');
  let manifest = null;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch {
    return { usable: false, reasons: ['no fixture.json (never built, or incomplete)'], manifest: null };
  }
  if (manifest.schema !== 1) reasons.push(`unknown fixture manifest schema ${manifest.schema}`);
  if (manifest.version !== expected.version) {
    reasons.push(`version ${manifest.version} != ${expected.version}`);
  }
  for (const key of ['source', 'config', 'runtime', 'electronBuilder']) {
    const recorded = manifest.inputs?.[key];
    if (!recorded) reasons.push(`manifest records no ${key} digest`);
    else if (recorded !== expected.inputs[key]) reasons.push(`${key} changed`);
  }
  const installerName = manifest.installer?.name;
  const installerPath = installerName ? path.join(fixtureDir, installerName) : null;
  if (!installerPath || !fs.existsSync(installerPath)) {
    reasons.push('the recorded installer is missing');
  } else {
    const stat = fs.statSync(installerPath);
    if (stat.size !== manifest.installer.size) {
      reasons.push(`installer size ${stat.size} != recorded ${manifest.installer.size}`);
    }
    if (hashFile(installerPath) !== manifest.installer.sha256) {
      reasons.push('installer contents do not match the recorded hash');
    }
  }
  if (!fs.existsSync(path.join(fixtureDir, 'latest.yml'))) {
    reasons.push('latest.yml is missing, so the feed has nothing to serve');
  }
  return { usable: reasons.length === 0, reasons, manifest };
}

/**
 * Whether to rebuild, and why.
 *
 * A dirty tree is a deliberate refusal rather than a technical one: an uncommitted
 * change can be rebuilt from, but reusing a fixture built from a tree that has
 * since changed shape is how an upgrade test tells you nothing. `--allow-dirty`
 * is the explicit override, and even then the source digest must match.
 */
export function reuseDecision({ verdict, force = false, dirty = false, allowDirty = false }) {
  if (force) return { reuse: false, reasons: ['--force'] };
  if (!verdict.usable) return { reuse: false, reasons: verdict.reasons };
  if (dirty && !allowDirty) {
    return { reuse: false, reasons: ['the working tree is dirty; pass --allow-dirty to reuse a matching fixture'] };
  }
  return { reuse: true, reasons: [] };
}

/** Remove generated fixtures, leaving anything this tool did not create. */
export function clearFixtures(outRoot) {
  const removed = [];
  const skipped = [];
  let entries = [];
  try {
    entries = fs.readdirSync(outRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory());
  } catch {
    return { removed, skipped };
  }
  for (const entry of entries) {
    if (!/^v\d+\.\d+\.\d+/.test(entry.name)) continue;
    const dir = path.join(outRoot, entry.name);
    if (!fs.existsSync(path.join(dir, 'fixture.json'))) {
      skipped.push(entry.name);
      continue;
    }
    fs.rmSync(dir, { recursive: true, force: true });
    removed.push(entry.name);
  }
  return { removed, skipped };
}
