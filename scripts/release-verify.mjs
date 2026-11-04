#!/usr/bin/env node
/**
 * The release gate, as a library.
 *
 * Every check a tag-driven release depends on lives here, so the build
 * (scripts/build-release.mjs), the publish workflow (scripts/release-assets.mjs)
 * and the tests all apply the *same* rules. Before this module the build and the
 * publish step each parsed latest.yml themselves; two copies of a gate drift,
 * and a drifted gate is how a release ships a manifest no client can match.
 *
 * Nothing here writes or rewrites a version: a mismatch is reported, never
 * repaired. electron-builder generates latest.yml and the blockmap; this only
 * reads them.
 *
 * Return shape: `{ problems, ...facts }` — callers print and exit non-zero when
 * `problems` is non-empty.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import yaml from 'js-yaml';
import { listAsarEntries, readAsar, readAsarEntry } from './asar-entries.mjs';
import { resolveReleaseAssets } from './release-naming.mjs';
import { verifySignatures, verifyDigests, signingConfig } from './signing.mjs';
import { verifyPackagedPrivacy } from './packaging-privacy.mjs';

// The privacy rules live in their own module (like signing) but are part of
// this gate: callers get one entry point, and the release workflow one list of
// things that can stop a publication.
export { verifyPackagedPrivacy };

const VERSION = /^\d+\.\d+\.\d+([-+][0-9A-Za-z.-]+)?$/;
const TAG = /^v\d+\.\d+\.\d+([-+][0-9A-Za-z.-]+)?$/;
/** A build clock that is a day off is a broken runner, not clock skew. */
const MAX_CLOCK_SKEW_MS = 24 * 60 * 60 * 1000;

export function sha512(file) {
  return createHash('sha512').update(fs.readFileSync(file)).digest('base64');
}

/**
 * The tag and package.json must describe one release. An optional `v` prefix is
 * the only difference tolerated, because `v1.0.2` and `1.0.2` are the same
 * version to everyone except a string comparison.
 */
export function verifyTag(tag, version) {
  const problems = [];
  if (!tag) {
    problems.push('no tag was supplied; a release must be identified by its tag');
    return problems;
  }
  if (!TAG.test(tag)) {
    problems.push(`tag "${tag}" is malformed; expected v<major>.<minor>.<patch>`);
    return problems;
  }
  if (tag !== `v${version}`) {
    problems.push(
      `tag ${tag} does not match package.json version ${version} ` +
        `(expected v${version}); bump the version before tagging — versions are never rewritten`,
    );
  }
  return problems;
}

/** latest.yml fields that must be present and sane. */
function verifyManifestShape(meta, latestYml) {
  const problems = [];
  if (!meta || typeof meta !== 'object') {
    problems.push(`${latestYml} did not parse to an object`);
    return problems;
  }
  if (!Array.isArray(meta.files) || meta.files.length === 0) {
    problems.push(`${latestYml} has no files[] entry, so updater has nothing to download`);
  }
  if (!meta.path) problems.push(`${latestYml} has no path field`);
  if (!meta.sha512) problems.push(`${latestYml} has no top-level sha512`);
  if (!meta.releaseDate) {
    problems.push(`${latestYml} has no releaseDate`);
  } else {
    const when = Date.parse(meta.releaseDate);
    if (Number.isNaN(when)) {
      problems.push(`${latestYml} releaseDate "${meta.releaseDate}" is not a date`);
    } else if (when - Date.now() > MAX_CLOCK_SKEW_MS) {
      problems.push(
        `${latestYml} releaseDate ${meta.releaseDate} is in the future — check the runner clock`,
      );
    }
  }
  return problems;
}

/**
 * The blockmap must be the one for this installer: it is gzip-compressed JSON,
 * and a truncated or foreign file makes differential download fail in a way
 * electron-updater reports as a generic network error.
 */
function verifyBlockmap(file, installerFile) {
  let parsed;
  try {
    parsed = JSON.parse(gunzipSync(fs.readFileSync(file)).toString('utf8'));
  } catch (err) {
    return [`${path.basename(file)} is not a readable blockmap: ${err.message}`];
  }
  const problems = [];
  const entry = Array.isArray(parsed?.files) ? parsed.files[0] : null;
  if (!entry || !Array.isArray(entry.checksums) || entry.checksums.length === 0) {
    problems.push(`${path.basename(file)} contains no block checksums`);
  }
  if (!fs.existsSync(installerFile)) {
    problems.push(`${path.basename(file)} exists but its installer does not`);
  }
  return problems;
}

/**
 * Verify the artifact set on disk against package.json and (optionally) the tag.
 *
 * @param {{dir: string, pkg: object, tag?: string|null, now?: Date}} options
 * @returns {Promise<{problems: string[], version: string, installer: string,
 *   blockmap: string, latestYml: string, sizes: Record<string, number>,
 *   checksum: string|null}>}
 */
export async function verifyArtifacts({ dir, pkg, tag = null }) {
  const { version, installer, blockmap, latestYml } = resolveReleaseAssets(pkg);
  const problems = [];

  if (!VERSION.test(String(version))) {
    problems.push(`package.json version "${version}" is not a valid semver release version`);
  }
  if (tag) problems.push(...verifyTag(tag, version));

  const files = {
    installer: path.join(dir, installer),
    blockmap: path.join(dir, blockmap),
    latest: path.join(dir, latestYml),
  };

  // A partial set is the failure worth naming precisely: publishing two of the
  // three assets produces a release the updater cannot use at all.
  const sizes = {};
  const present = [];
  for (const [label, file] of Object.entries(files)) {
    try {
      const info = fs.statSync(file);
      if (!info.isFile() || info.size === 0) throw new Error('empty');
      sizes[label] = info.size;
      present.push(label);
    } catch {
      problems.push(
        `${label} is missing or empty: ${path.relative(process.cwd(), file) || file} ` +
          '(run `npm run electron:build` first)',
      );
    }
  }
  if (problems.length) {
    return { problems, version, installer, blockmap, latestYml, sizes, checksum: null };
  }

  let meta;
  try {
    meta = yaml.load(fs.readFileSync(files.latest, 'utf8'));
  } catch (err) {
    return {
      problems: [...problems, `${latestYml} is not readable YAML: ${err.message}`],
      version,
      installer,
      blockmap,
      latestYml,
      sizes,
      checksum: null,
    };
  }

  problems.push(...verifyManifestShape(meta, latestYml));

  const entries = Array.isArray(meta?.files) ? meta.files : [];
  const listed = entries.find((entry) => entry?.url === installer) ?? entries[0] ?? {};
  const checksum = sha512(files.installer);

  if (meta?.version !== version) {
    problems.push(`${latestYml} version ${meta?.version} != package.json ${version}`);
  }
  if (meta?.path !== installer) {
    problems.push(`${latestYml} path "${meta?.path}" != "${installer}"`);
  }
  if (entries.length > 1) {
    // electron-updater downloads files[0]; a second entry is either a stale
    // artifact the build forgot to prune or a different release's installer.
    problems.push(`${latestYml} lists ${entries.length} files; a Windows release has exactly one`);
  }
  if (listed.url !== installer) {
    problems.push(`${latestYml} files[0].url "${listed.url}" != "${installer}"`);
  }
  if (Number(listed.size) !== sizes.installer) {
    problems.push(`${latestYml} files[0].size ${listed.size} != ${sizes.installer} bytes on disk`);
  }
  if (listed.sha512 !== checksum) {
    problems.push(`${latestYml} files[0].sha512 does not match ${installer} on disk`);
  }
  if (meta?.sha512 && meta.sha512 !== listed.sha512) {
    problems.push(`${latestYml} top-level sha512 disagrees with files[0].sha512`);
  }

  problems.push(...verifyBlockmap(files.blockmap, files.installer));

  // Anything else in the output directory that looks like a release artifact
  // belongs to another version and must not be uploaded by accident.
  try {
    const stray = fs
      .readdirSync(dir)
      .filter((name) => /\.(exe|blockmap)$/i.test(name))
      .filter((name) => name !== installer && name !== blockmap && !/uninstaller/i.test(name));
    for (const name of stray) {
      problems.push(
        `stale artifact ${name} sits next to this release; delete it so the wrong file cannot be published`,
      );
    }
  } catch {
    // Directory listing is best-effort; the required files were already checked.
  }

  return { problems, version, installer, blockmap, latestYml, sizes, checksum };
}

/**
 * The executables a user actually receives, and the upstream-signed runtime.
 *
 * One definition, used by the signature CLI and by release verification, so the
 * files that are checked cannot drift from the files that are shipped.
 */
export function releaseExecutables({ dir, pkg, runtimePublisher, installedDir = '' }) {
  const { installer } = resolveReleaseAssets(pkg);
  const productName = pkg.build?.productName ?? pkg.name;

  // The NSIS uninstaller does not exist as a build artifact: electron-builder
  // generates and signs it inside the installer, so it only appears on disk after
  // an install. Checking it is therefore a post-install duty (--installed), and a
  // missing one is only an error once the caller has said it installed the build.
  const uninstallerName = pkg.iskSigning?.uninstallerName || `Uninstall ${productName}.exe`;
  const uninstallerCandidates = [
    installedDir ? path.join(installedDir, uninstallerName) : null,
    path.join(dir, 'win-unpacked', uninstallerName),
    path.join(dir, uninstallerName),
  ].filter(Boolean);
  const uninstallerFile = uninstallerCandidates.find((file) => fs.existsSync(file)) ?? null;

  return {
    ourFiles: [
      { label: installer, file: path.join(dir, installer) },
      { label: `${productName}.exe`, file: path.join(dir, 'win-unpacked', `${productName}.exe`) },
      ...(uninstallerFile ? [{ label: uninstallerName, file: uninstallerFile }] : []),
    ],
    runtime: {
      label: 'resources/runtime/node.exe',
      file: path.join(dir, 'win-unpacked', 'resources', 'runtime', 'node.exe'),
      expectedPublisher: runtimePublisher,
    },
    uninstaller: uninstallerFile ? { label: uninstallerName, file: uninstallerFile } : null,
    uninstallerCandidates,
  };
}

/**
 * Signing policy for a release. Phase 1.2's checks are untouched: this adds the
 * Authenticode requirement on top, and only asks for it when `requireSigned` is
 * set (release mode), so a local unsigned build still verifies as a *build*.
 *
 * @param {{dir: string, pkg: object, runtimePublisher: string, requireSigned: boolean,
 *          readSignature?: Function}} options
 * @returns {{problems: string[], reports: Array<object>, config: object}}
 */
export function verifyReleaseSignatures({
  dir,
  pkg,
  runtimePublisher,
  requireSigned,
  readSignature,
  readDigests,
  installedDir = '',
  requireUninstaller = false,
}) {
  // One authoritative identity, from package.json: the certificate CN that a
  // release must be signed with. Without it "signed by a trusted certificate"
  // would be the whole policy, which is how a wrong-but-valid certificate ships.
  const policy = pkg?.iskSigning ?? {};
  const config = signingConfig(process.env, { expectedPublisher: policy.expectedPublisher });
  const problems = [...config.problems];
  if (requireSigned && !config.configured) {
    problems.push(
      `release mode requires a signing certificate, but ${'CSC_LINK'}/${'CSC_KEY_PASSWORD'} are not configured`,
    );
  }

  const { ourFiles, runtime, uninstaller, uninstallerCandidates } = releaseExecutables({
    dir,
    pkg,
    runtimePublisher,
    installedDir,
  });
  if (requireUninstaller && !uninstaller) {
    problems.push(
      `the NSIS uninstaller was not found (looked in ${uninstallerCandidates
        .map((file) => path.relative(process.cwd(), file) || file)
        .join(', ')}), so its signature could not be checked`,
    );
  }

  const result = verifySignatures({
    ourFiles,
    runtime,
    requireSigned,
    expectedPublisher: config.expectedPublisher,
    readSignature,
  });

  // Digest algorithms only say something about a signed file, so this runs once
  // the signature policy is satisfied — and only in release mode, where a SHA-1
  // nested signature must stop the build rather than be reported as a warning.
  if (requireSigned && result.problems.length === 0) {
    const digests = verifyDigests({ files: ourFiles, readDigests });
    result.problems.push(...digests.problems);
  }

  return { ...result, problems: [...problems, ...result.problems], config, uninstaller };
}

/**
 * The packaged app must carry the pinned runtime, outside the archive.
 *
 * @param {{resourcesDir: string, manifestPath: string}} options
 * @returns {string[]} problems
 */
export function verifyPackagedRuntime({ resourcesDir, manifestPath }) {
  const problems = [];
  const pin = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const runtimeDir = path.join(resourcesDir, 'runtime');
  const exe = path.join(runtimeDir, 'node.exe');

  if (!fs.existsSync(resourcesDir)) {
    return [`packaged resources are missing: ${resourcesDir}`];
  }
  if (!fs.existsSync(exe)) {
    problems.push(`the packaged app carries no runtime at ${path.join('resources', 'runtime', 'node.exe')}`);
  } else {
    const got = createHash('sha256').update(fs.readFileSync(exe)).digest('hex');
    if (got !== String(pin.sha256).toLowerCase()) {
      problems.push(`the packaged runtime is not the pinned build (sha256 ${got})`);
    }
  }
  if (!fs.existsSync(path.join(runtimeDir, 'LICENSE'))) {
    problems.push('the packaged runtime ships without its Node.js licence');
  }
  if (exe && fs.existsSync(path.join(resourcesDir, 'app.asar.unpacked', 'runtime'))) {
    problems.push('the runtime is duplicated inside app.asar.unpacked');
  }
  if (!fs.existsSync(path.join(resourcesDir, 'app.asar.unpacked', 'server.cjs'))) {
    problems.push('the packaged backend (server.cjs) is missing from app.asar.unpacked');
  }
  if (!fs.existsSync(path.join(resourcesDir, 'app-update.yml'))) {
    problems.push('app-update.yml is missing, so installed copies cannot find updates');
  }
  return problems;
}
