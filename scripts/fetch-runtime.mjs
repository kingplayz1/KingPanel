#!/usr/bin/env node
/**
 * Supplies the Node runtime the packaged backend runs on.
 *
 * The backend opens SQLite through `node:sqlite` (Node >= 22.5) and Electron 31
 * carries Node 20.18, so an installed copy needs its own runtime. Shipping one
 * means owning it: the version is pinned in runtime/runtime.json together with
 * the SHA-256 published by nodejs.org, and nothing is ever downloaded at
 * application start — only at build time, and only when the checksum matches.
 *
 * Guarantees:
 *  - The executable is fetched from the pinned HTTPS URL over the pinned
 *    checksum manifest's algorithm (SHA-256).
 *  - A file whose hash does not match is never written to runtime/node.exe; the
 *    download lands in a temp file first and is renamed only after verification.
 *  - An existing runtime/node.exe with the right hash is reused, so builds are
 *    reproducible and offline once the file is present.
 *  - After the hash check the binary is executed and must report the pinned
 *    version and load node:sqlite; a truncated-but-hash-matching file still
 *    cannot slip through.
 *
 * CLI:
 *   node scripts/fetch-runtime.mjs            # download if needed, then verify
 *   node scripts/fetch-runtime.mjs --check    # verify only; exit 1 if absent/wrong
 *
 * Exit: 0 when runtime/node.exe is present and verified, 1 otherwise.
 */
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readSignature, checkSignature } from './signing.mjs';
import fs from 'node:fs';
import https from 'node:https';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RUNTIME_DIR = path.join(ROOT, 'runtime');
export const MANIFEST_PATH = path.join(RUNTIME_DIR, 'runtime.json');
export const RUNTIME_EXE = path.join(RUNTIME_DIR, 'node.exe');
export const RUNTIME_LICENSE = path.join(RUNTIME_DIR, 'LICENSE');
const CACHE_DIR = path.join(ROOT, '.tmp', 'runtime-download');

const SHA256 = /^[0-9a-f]{64}$/;
const PINNED_VERSION = /^\d+\.\d+\.\d+$/;

/**
 * Validate the pinned manifest. Every value is used to fetch or verify a binary,
 * so a malformed field fails the build instead of producing a plausible-looking
 * runtime.
 */
export function parseManifest(raw) {
  const fail = (message) => {
    throw new Error(`runtime/runtime.json is invalid: ${message}`);
  };
  if (!raw || typeof raw !== 'object') fail('it did not parse to an object');
  const nodeVersion = String(raw.nodeVersion ?? '');
  if (!PINNED_VERSION.test(nodeVersion)) fail(`nodeVersion "${nodeVersion}" is not x.y.z`);

  const sha256 = String(raw.sha256 ?? '').toLowerCase();
  if (!SHA256.test(sha256)) fail('sha256 must be 64 lowercase hex characters');

  for (const key of ['source', 'checksums']) {
    const url = String(raw[key] ?? '');
    if (!/^https:\/\/nodejs\.org\//.test(url)) {
      fail(`${key} must be an https://nodejs.org/ URL, got "${url}"`);
    }
  }
  // nodejs.org does not serve LICENSE under dist/ (it redirects into a 404), so
  // the licence comes from the tagged release on GitHub, pinned by hash.
  const license = String(raw.license ?? '');
  if (!/^https:\/\/raw\.githubusercontent\.com\/nodejs\/node\/v[^/]+\/LICENSE$/.test(license)) {
    fail(`license must be https://raw.githubusercontent.com/nodejs/node/v<version>/LICENSE, got "${license}"`);
  }
  if (!license.includes(`/v${nodeVersion}/`)) fail('license does not point at the pinned version');

  const licenseSha256 = String(raw.licenseSha256 ?? '').toLowerCase();
  if (!SHA256.test(licenseSha256)) fail('licenseSha256 must be 64 lowercase hex characters');
  // The pinned URL and the pinned version must describe the same release,
  // otherwise a typo silently ships a different runtime than the checksum covers.
  if (!String(raw.source).includes(`/v${nodeVersion}/`)) {
    fail(`source does not point at v${nodeVersion}`);
  }

  const minimum = String(raw.minimumBackendVersion ?? '');
  if (!PINNED_VERSION.test(minimum)) fail('minimumBackendVersion is not x.y.z');

  const architecture = String(raw.architecture ?? '');
  if (architecture !== 'win-x64') fail(`architecture must be win-x64, got "${architecture}"`);

  // The official Node build is Authenticode-signed by the OpenJS Foundation.
  // Pinning the publisher means a mirrored or substituted binary cannot pass by
  // checksum alone if the pin were ever edited by mistake.
  const publisher = String(raw.publisher ?? '').trim();
  if (!publisher) fail('publisher (the Authenticode signer of node.exe) is required');

  return {
    nodeVersion,
    architecture,
    sha256,
    source: String(raw.source),
    checksums: String(raw.checksums),
    license,
    licenseSha256,
    publisher,
    minimumBackendVersion: minimum,
  };
}

export function sha256File(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

/** Download a URL to a file, following redirects; rejects non-2xx. */
export function download(url, destination, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 5) {
      reject(new Error(`too many redirects for ${url}`));
      return;
    }
    const request = https.get(url, { timeout: 60_000 }, (response) => {
      const status = response.statusCode ?? 0;
      if (status >= 300 && status < 400 && response.headers.location) {
        response.resume();
        const next = new URL(response.headers.location, url).toString();
        download(next, destination, redirects + 1).then(resolve, reject);
        return;
      }
      if (status !== 200) {
        response.resume();
        reject(new Error(`GET ${url} answered HTTP ${status}`));
        return;
      }
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      const out = fs.createWriteStream(destination);
      response.pipe(out);
      out.on('finish', () => out.close(() => resolve(destination)));
      out.on('error', reject);
      response.on('error', reject);
    });
    request.on('timeout', () => request.destroy(new Error(`timed out fetching ${url}`)));
    request.on('error', reject);
  });
}

/**
 * Prove the executable is the pinned runtime: it starts, it reports the pinned
 * version, and it can load node:sqlite (the only reason a runtime is bundled).
 */
export function verifyRuntimeExecutable(exe, manifest) {
  const version = spawnSync(exe, ['-p', 'process.versions.node'], {
    encoding: 'utf8',
    timeout: 20_000,
    windowsHide: true,
  });
  if (version.error) return `could not run ${exe}: ${version.error.message}`;
  const reported = String(version.stdout || '').trim();
  if (version.status !== 0) {
    return `${exe} exited with ${version.status}: ${String(version.stderr || '').trim().slice(0, 200)}`;
  }
  if (reported !== manifest.nodeVersion) {
    return `${exe} reports Node ${reported}, but runtime/runtime.json pins ${manifest.nodeVersion}`;
  }

  const sqlite = spawnSync(
    exe,
    [
      '-e',
      "try{const s=require('node:sqlite');if(typeof s.DatabaseSync!=='function')throw new Error('DatabaseSync missing');process.stdout.write('ok')}catch(e){process.stdout.write('fail:'+e.message)}",
    ],
    { encoding: 'utf8', timeout: 20_000, windowsHide: true },
  );
  if (sqlite.error) return `could not probe node:sqlite: ${sqlite.error.message}`;
  if (String(sqlite.stdout || '').trim() !== 'ok') {
    return `the pinned runtime cannot load node:sqlite (${String(sqlite.stdout || '').trim()})`;
  }
  return null;
}

/**
 * Prove the runtime carries the vendor's Authenticode signature and a timestamp.
 *
 * Skipped off Windows, where there is nothing to read; the Windows CI job and the
 * release build both exercise it.
 */
export function verifyRuntimeSignature(exe, manifest) {
  if (process.platform !== 'win32') return [];
  const report = readSignature(exe);
  return checkSignature({
    label: 'runtime/node.exe',
    report,
    expectedPublisher: manifest.publisher,
    requireSigned: true,
    requireTimestamp: true,
  });
}

/**
 * Ensure runtime/node.exe and its licence are present and match the manifest.
 *
 * Returns `{ downloaded, exe, version }`; throws with an actionable message when
 * the runtime cannot be supplied or fails verification.
 */
export async function ensureRuntime({ check = false, log = console.log } = {}) {
  let manifest;
  try {
    manifest = parseManifest(JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8')));
  } catch (err) {
    throw new Error(
      `Cannot read the pinned runtime manifest (${MANIFEST_PATH}): ${err instanceof Error ? err.message : err}`,
    );
  }

  const present = fs.existsSync(RUNTIME_EXE);
  const hash = present ? sha256File(RUNTIME_EXE) : null;
  const matches = present && hash === manifest.sha256;

  if (!matches && check) {
    throw new Error(
      present
        ? `runtime/node.exe does not match the pinned checksum (expected ${manifest.sha256}, got ${hash})`
        : `runtime/node.exe is missing; run "node scripts/fetch-runtime.mjs" (needs network once)`,
    );
  }

  let downloaded = false;
  if (!matches) {
    log(
      `[runtime] fetching Node ${manifest.nodeVersion} (${manifest.architecture}) from ${manifest.source}`,
    );
    const temp = path.join(CACHE_DIR, `node-${manifest.nodeVersion}.exe.tmp`);
    fs.rmSync(temp, { force: true });
    await download(manifest.source, temp);
    const got = sha256File(temp);
    if (got !== manifest.sha256) {
      fs.rmSync(temp, { force: true });
      throw new Error(
        `Refusing to install an unverified runtime: ${manifest.source} hashed to ${got}, ` +
          `but runtime/runtime.json pins ${manifest.sha256}. Nothing was written to runtime/node.exe.`,
      );
    }
    fs.mkdirSync(RUNTIME_DIR, { recursive: true });
    fs.renameSync(temp, RUNTIME_EXE);
    fs.rmSync(temp, { force: true });
    downloaded = true;
    log(`[runtime] sha256 verified (${manifest.sha256.slice(0, 16)}…)`);
  } else {
    log(`[runtime] Node ${manifest.nodeVersion} already present and verified`);
  }

  const licencePresent = fs.existsSync(RUNTIME_LICENSE);
  if (!licencePresent || sha256File(RUNTIME_LICENSE) !== manifest.licenseSha256) {
    if (check) {
      throw new Error(
        licencePresent
          ? 'runtime/LICENSE does not match the pinned licence checksum'
          : 'runtime/LICENSE is missing; the bundled runtime must ship its licence',
      );
    }
    await download(manifest.license, RUNTIME_LICENSE);
    const licenceHash = sha256File(RUNTIME_LICENSE);
    if (licenceHash !== manifest.licenseSha256) {
      fs.rmSync(RUNTIME_LICENSE, { force: true });
      throw new Error(
        `Refusing an unverified licence: ${manifest.license} hashed to ${licenceHash}, ` +
          `but runtime/runtime.json pins ${manifest.licenseSha256}.`,
      );
    }
    log('[runtime] licence downloaded and verified');
  }

  // The hash is verified everywhere; executing the binary only makes sense on
  // the platform it targets. CI still checks the checksum on a Linux runner, and
  // the Windows job proves the binary actually runs.
  if (process.platform !== 'win32') {
    log(
      `[runtime] sha256 verified; execution check skipped on ${process.platform} ` +
        '(the Windows CI job proves the binary runs)',
    );
    return { downloaded, exe: RUNTIME_EXE, version: manifest.nodeVersion };
  }

  const problem = verifyRuntimeExecutable(RUNTIME_EXE, manifest);
  if (problem) throw new Error(`The bundled runtime failed verification: ${problem}`);

  // Signature check last: it proves the bytes came from the vendor's build, not
  // only that they match the pin we shipped.
  const signatureProblems = verifyRuntimeSignature(RUNTIME_EXE, manifest);
  if (signatureProblems.length) {
    throw new Error(`The bundled runtime is not signed as expected: ${signatureProblems.join('; ')}`);
  }
  if (process.platform === 'win32') {
    log(`[runtime] Authenticode: ${manifest.publisher}, timestamped`);
  }

  log(`[runtime] Node ${manifest.nodeVersion} verified (version + node:sqlite)`);
  return { downloaded, exe: RUNTIME_EXE, version: manifest.nodeVersion };
}

const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const check = process.argv.includes('--check');
  ensureRuntime({ check }).catch((err) => {
    console.error(`[runtime] ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  });
}
