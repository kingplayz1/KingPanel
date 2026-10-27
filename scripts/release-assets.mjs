#!/usr/bin/env node
/**
 * Gate between "the build produced files" and "GitHub serves them".
 *
 * CI runs this twice:
 *   1. after `npm run electron:build`, to confirm the tag, the artifacts on disk
 *      and latest.yml all describe the same release;
 *   2. after `gh release download`, pointing --dir at the downloaded copies, to
 *      confirm the bytes users will actually receive still match the metadata.
 *
 * It fails (non-zero exit) when:
 *  - the pushed tag does not match package.json's version, or
 *  - the installer, its .blockmap or latest.yml is missing or empty, or
 *  - latest.yml names, sizes or hashes anything other than the installer next
 *    to it.
 *
 * Usage: node scripts/release-assets.mjs [--tag v1.0.1] [--dir dist_electron]
 *
 * When $GITHUB_OUTPUT is set, `installer`, `blockmap`, `latest` and `version`
 * are written there so the workflow uploads exactly the files verified here.
 */
import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import { resolveReleaseAssets } from './release-naming.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_DIR = path.join(ROOT, 'dist_electron');

function arg(flag) {
  const index = process.argv.indexOf(flag);
  return index === -1 ? null : (process.argv[index + 1] ?? null);
}

function fail(problems) {
  console.error('[assets] FAILED — this release must not be published:');
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}

async function main() {
  const tag = arg('--tag');
  const dir = arg('--dir') ? path.resolve(ROOT, arg('--dir')) : DEFAULT_DIR;

  const pkg = JSON.parse(await readFile(path.join(ROOT, 'package.json'), 'utf8'));
  const { version, installer, blockmap, latestYml } = resolveReleaseAssets(pkg);
  console.log(`[assets] package.json version ${version}`);
  console.log(`[assets] installer ${installer}`);

  const problems = [];

  if (!/^\d+\.\d+\.\d+([-+][0-9A-Za-z.-]+)?$/.test(version)) {
    problems.push(`package.json version "${version}" is not a valid semver release version`);
  }

  // electron-updater compares the tag's latest.yml version against the installed
  // app's version, so a mismatch here ships an update no client can ever match.
  if (tag) {
    const accepted = new Set([version, `v${version}`]);
    if (!accepted.has(tag)) {
      problems.push(
        `tag ${tag} does not match package.json version ${version} ` +
          `(expected ${tag.startsWith('v') ? 'v' : ''}${version}); ` +
          'bump the version before tagging',
      );
    }
  }

  const files = {
    installer: path.join(dir, installer),
    blockmap: path.join(dir, blockmap),
    latest: path.join(dir, latestYml),
  };
  const sizes = {};
  for (const [label, file] of Object.entries(files)) {
    try {
      const info = await stat(file);
      if (!info.isFile() || info.size === 0) throw new Error('empty');
      sizes[label] = info.size;
    } catch {
      problems.push(
        `${label} is missing or empty: ${path.relative(ROOT, file) || file} ` +
          '(run `npm run electron:build` first)',
      );
    }
  }
  if (problems.length) fail(problems);

  let meta;
  try {
    meta = yaml.load(await readFile(files.latest, 'utf8'));
  } catch (err) {
    fail([`${latestYml} is not readable YAML: ${err.message}`]);
  }
  if (!meta || typeof meta !== 'object') fail([`${latestYml} did not parse to an object`]);

  const entries = Array.isArray(meta.files) ? meta.files : [];
  const listed = entries.find((entry) => entry?.url === installer) ?? entries[0] ?? {};
  const checksum = createHash('sha512').update(await readFile(files.installer)).digest('base64');

  if (meta.version !== version) {
    problems.push(`${latestYml} version ${meta.version} != package.json ${version}`);
  }
  if (meta.path !== installer) {
    problems.push(`${latestYml} path "${meta.path}" != "${installer}"`);
  }
  if (listed.url !== installer) {
    problems.push(`${latestYml} files[0].url "${listed.url}" != "${installer}"`);
  }
  if (Number(listed.size) !== sizes.installer) {
    problems.push(
      `${latestYml} files[0].size ${listed.size} != ${sizes.installer} bytes on disk`,
    );
  }
  if (listed.sha512 !== checksum) {
    problems.push(`${latestYml} files[0].sha512 does not match ${installer} on disk`);
  }
  if (meta.sha512 && meta.sha512 !== listed.sha512) {
    problems.push(`${latestYml} top-level sha512 disagrees with files[0].sha512`);
  }
  if (problems.length) fail(problems);

  // The workflow reads these to upload the verified files by name, instead of
  // globbing a directory where a stale artifact could also match.
  const outputs = { installer, blockmap, latest: latestYml, version };
  if (process.env.GITHUB_OUTPUT) {
    const { appendFile } = await import('node:fs/promises');
    await appendFile(
      process.env.GITHUB_OUTPUT,
      Object.entries(outputs)
        .map(([key, value]) => `${key}=${value}\n`)
        .join(''),
    );
  }

  console.log(
    `[assets] OK  ${installer} ${(sizes.installer / 1024 / 1024).toFixed(1)} MB  ` +
      `${blockmap}  ${latestYml} (version/path/size/sha512 match)`,
  );
}

main().catch((err) => {
  console.error(`[assets] FAILED: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
