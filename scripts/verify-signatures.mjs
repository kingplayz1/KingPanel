#!/usr/bin/env node
/**
 * Authenticode gate for a packaged Windows build.
 *
 * Release mode (`ISK_REQUIRE_SIGNING=1`, or `--require`) fails on anything but a
 * trusted, timestamped, SHA-256 signature from the pinned publisher across our
 * executables (installer, app and — after installation — the uninstaller).
 * Local mode (the default) still verifies whatever is there and says loudly that
 * the build is unsigned, so a developer can run the whole pipeline without a
 * certificate — but nothing about an unsigned build is reported as "signed".
 *
 * Usage:
 *   node scripts/verify-signatures.mjs [--dir dist_electron] [--require | --allow-unsigned]
 *   node scripts/verify-signatures.mjs --installed "C:\Program Files\IS King Panel"
 *
 * `--installed` points at an installed copy, which is the only place the NSIS
 * uninstaller exists: electron-builder generates and signs it inside the
 * installer, so before installation there is no file to verify.
 *
 * The file list comes from scripts/release-verify.mjs, so the executables checked
 * here are exactly the ones release verification ships.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyReleaseSignatures, releaseExecutables } from './release-verify.mjs';
import { signToolProblems, findSignTool } from './signing.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function arg(flag) {
  const index = process.argv.indexOf(flag);
  return index === -1 ? null : (process.argv[index + 1] ?? null);
}

const requireSigned = process.argv.includes('--require')
  ? true
  : process.argv.includes('--allow-unsigned')
    ? false
    : process.env.ISK_REQUIRE_SIGNING === '1';

const installedArg = arg('--installed') ?? process.env.ISK_INSTALLED_DIR ?? '';

function main() {
  const dir = arg('--dir') ? path.resolve(ROOT, arg('--dir')) : path.join(ROOT, 'dist_electron');
  const installedDir = installedArg ? path.resolve(ROOT, installedArg) : '';
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const pin = JSON.parse(fs.readFileSync(path.join(ROOT, 'runtime', 'runtime.json'), 'utf8'));

  const { problems, reports, config, uninstaller } = verifyReleaseSignatures({
    dir,
    pkg,
    runtimePublisher: pin.publisher,
    requireSigned,
    installedDir,
    requireUninstaller: Boolean(installedDir) && requireSigned,
  });

  // In release mode, get a second, independent answer from signtool. A signature
  // that PowerShell accepts but signtool rejects is not one to ship.
  if (requireSigned && problems.length === 0) {
    const { ourFiles } = releaseExecutables({
      dir,
      pkg,
      runtimePublisher: pin.publisher,
      installedDir,
    });
    problems.push(...signToolProblems(ourFiles));
  }

  for (const report of reports) {
    const state =
      report.status === 'valid'
        ? `${report.publisher}${report.timestamped ? ', timestamped' : ', NOT timestamped'}`
        : report.rawStatus;
    console.log(`[signing] ${report.label}: ${state}`);
  }
  console.log(
    `[signing] uninstaller: ${
      uninstaller ? `${uninstaller.label} (${uninstaller.file})` : 'not present yet — generated inside the installer'
    }`,
  );

  if (!config.configured && !requireSigned) {
    console.log(
      `[signing] no signing provider configured (${'ISK_SIGN_PROVIDER'}=${config.method}, ` +
        'CSC_LINK/CSC_KEY_PASSWORD and ESIGNER_* unset) — this build is UNSIGNED. ' +
        'That is fine locally and is refused in release mode.',
    );
  }
  if (!findSignTool() && requireSigned) {
    console.log('[signing] signtool not found in Windows Kits; relying on Get-AuthenticodeSignature.');
  }

  if (problems.length) {
    console.error('[signing] FAILED — this build must not be published:');
    for (const problem of problems) console.error(`  - ${problem}`);
    process.exit(1);
  }

  console.log(
    `[signing] OK  ${requireSigned ? 'release mode: every executable is trusted, timestamped, SHA-256, pinned publisher' : 'local build: checked, strictness off'}`,
  );
}

main();
