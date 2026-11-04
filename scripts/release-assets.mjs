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
 * The rules themselves live in scripts/release-verify.mjs, shared with the build
 * and the tests, so there is one definition of a valid release rather than three
 * that drift apart.
 *
 * Usage:
 *   node scripts/release-assets.mjs [--tag v1.0.2] [--dir dist_electron]
 *     [--runtime] [--privacy] [--signing]
 *
 * `--runtime` also verifies the packaged app under <dir>/win-unpacked: the pinned
 * runtime outside the asar, the backend bundle and app-update.yml.
 *
 * `--privacy` reads the same tree for developer data — the resources allowlist,
 * every app.asar entry, and SQLite/secret content — because a version-and-hash
 * check cannot tell a clean installer from one carrying its author's database.
 *
 * When $GITHUB_OUTPUT is set, `installer`, `blockmap`, `latest` and `version` are
 * written there so the workflow uploads exactly the files verified here.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  verifyArtifacts,
  verifyPackagedPrivacy,
  verifyPackagedRuntime,
  verifyReleaseSignatures,
  verifyTag,
} from './release-verify.mjs';

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
  const checkRuntime = process.argv.includes('--runtime');
  const checkSigning = process.argv.includes('--signing');
  const installedIndex = process.argv.indexOf('--installed');
  const installedDir =
    installedIndex === -1
      ? process.env.ISK_INSTALLED_DIR || ''
      : path.resolve(ROOT, process.argv[installedIndex + 1] ?? '');
  const checkPrivacy = process.argv.includes('--privacy');
  const tagOnly = process.argv.includes('--tag-only');

  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

  // Preflight: the tag and package.json alone, before anything is built.
  if (tagOnly) {
    const problems = verifyTag(tag, pkg.version);
    if (problems.length) fail(problems);
    console.log(`[assets] OK  tag ${tag} matches package.json ${pkg.version} (no artifacts checked)`);
    return;
  }

  const result = await verifyArtifacts({ dir, pkg, tag });
  console.log(`[assets] package.json version ${result.version}`);
  console.log(`[assets] installer ${result.installer}`);

  const problems = [...result.problems];

  if (checkRuntime && problems.length === 0) {
    problems.push(
      ...verifyPackagedRuntime({
        resourcesDir: path.join(dir, 'win-unpacked', 'resources'),
        manifestPath: path.join(ROOT, 'runtime', 'runtime.json'),
      }),
    );
  }

  // Developer data in the installer: the leak this gate was written for, and
  // the one no version/hash check can see.
  let privacy = null;
  if (checkPrivacy && problems.length === 0) {
    privacy = verifyPackagedPrivacy({ dir });
    problems.push(...privacy.problems);
  }

  // Optional here, mandatory in the release workflow: a tag build passes
  // ISK_REQUIRE_SIGNING=1 and a missing or untrusted signature stops it.
  if (checkSigning && problems.length === 0) {
    const pin = JSON.parse(fs.readFileSync(path.join(ROOT, 'runtime', 'runtime.json'), 'utf8'));
    const signing = verifyReleaseSignatures({
      dir,
      pkg,
      runtimePublisher: pin.publisher,
      requireSigned: process.env.ISK_REQUIRE_SIGNING === '1',
      installedDir,
      requireUninstaller: Boolean(installedDir) && process.env.ISK_REQUIRE_SIGNING === '1',
    });
    problems.push(...signing.problems);
    for (const problem of signing.problems) {
      // Printed through the shared failure list; keep the detail visible early.
      console.log(`[assets] signature: ${problem}`);
    }
  }
  if (problems.length) fail(problems);

  const outputs = {
    installer: result.installer,
    blockmap: result.blockmap,
    latest: result.latestYml,
    version: result.version,
  };
  if (process.env.GITHUB_OUTPUT) {
    fs.appendFileSync(
      process.env.GITHUB_OUTPUT,
      Object.entries(outputs)
        .map(([key, value]) => `${key}=${value}\n`)
        .join(''),
    );
  }

  console.log(
    `[assets] OK  ${result.installer} ${(result.sizes.installer / 1024 / 1024).toFixed(1)} MB  ` +
      `${result.blockmap}  ${result.latestYml} (version/path/size/sha512/blockmap match)` +
      (checkRuntime ? '  packaged runtime pinned' : '') +
      (privacy
        ? `  no developer data (${privacy.facts.payloadEntries} payload file(s), ` +
          `${privacy.facts.sqliteInspected} database(s) inspected, ${privacy.facts.stateFilesInspected} state file(s) scanned)`
        : ''),
  );
}

main().catch((err) => {
  console.error(`[assets] FAILED: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
