#!/usr/bin/env node
/**
 * Per-machine installation check, for the **production** installer.
 *
 * This is deliberately separate from `verify:upgrade`. That harness packages and
 * installs per-user fixtures so it can run unprivileged; the release installer is
 * per-machine, writes to Program Files, registers under HKLM and needs an
 * administrator. Both matter, neither replaces the other, and their state lives
 * in different directories so one cannot satisfy the other.
 *
 * Safety rules, in order of importance:
 *  - It never elevates. If the shell is not already elevated it prints what is
 *    missing and exits 2; accepting a UAC prompt is the operator's decision.
 *  - It changes nothing without `--run --confirm=per-machine-install`, and
 *    `--preflight` (the default) only reads.
 *  - It refuses to touch an existing installation it did not create: a non-empty
 *    install directory is reported, never deleted.
 *  - The application runs with APPDATA redirected into `.tmp/machine-install`, so
 *    the developer's own profile is not read or written.
 *
 * Usage:
 *   node scripts/verify-machine-install.mjs                 # read-only preflight
 *   node scripts/verify-machine-install.mjs --run --confirm=per-machine-install
 *   node scripts/verify-machine-install.mjs --run --confirm=per-machine-install \
 *     --update-installer .tmp/e2e/v1.0.2/IS-King-Panel-Setup-1.0.2.exe
 *
 * Exit codes: 0 verified/ready, 1 checks failed, 2 environment blocked.
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assessLeftover,
  classifyInstallerResult,
  elevationProblem,
  expandWindowsPath,
  installPlan,
  isElevated,
  runMachineInstall,
} from './install-config.mjs';
import { resolveReleaseAssets } from './release-naming.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WORK = path.join(ROOT, '.tmp', 'machine-install');
const ISOLATED_APPDATA = path.join(WORK, 'appdata');
const LOGS = path.join(WORK, 'logs');
const APP_PORT = 4788;
const CONFIRMATION = 'per-machine-install';

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const basePlan = installPlan(pkg);
const arg = (name, fallback = null) => {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : (process.argv[index + 1] ?? fallback);
};
const flag = (name) => process.argv.includes(name);

const { installer } = resolveReleaseAssets(pkg);
const installerPath = path.resolve(ROOT, arg('--installer', path.join('dist_electron', installer)));
const updateInstallerArg = arg('--update-installer');
const installDir = path.resolve(arg('--install-dir', expandWindowsPath(basePlan.installDir)));
const run = flag('--run');

function queryRegistry() {
  if (process.platform !== 'win32') return [];
  const script =
    "$paths = 'HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*'," +
    "'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*'; " +
    `Get-ItemProperty $paths -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -like '*${basePlan.productName}*' } | ` +
    'Select-Object DisplayName,DisplayVersion,UninstallString,PSPath | ConvertTo-Json -Compress';
  const result = spawnSync('powershell', ['-NoProfile', '-Command', script], { encoding: 'utf8' });
  const text = (result.stdout || '').trim();
  if (!text) return [];
  try {
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return [];
  }
}

function listDir(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).map((entry) => (entry.isDirectory() ? `${entry.name}/` : entry.name));
  } catch {
    return [];
  }
}

function preflight() {
  const problems = [];
  const notes = [];
  const elevated = isElevated();
  const registry = queryRegistry();
  const entries = listDir(installDir);
  const leftover = assessLeftover({ dirExists: fs.existsSync(installDir), entries, registryEntries: [], dir: installDir });
  const ourRegistry = registry.filter((entry) =>
    String(entry.UninstallString ?? '').toLowerCase().includes(installDir.toLowerCase()),
  );
  const foreignRegistry = registry.filter((entry) => !ourRegistry.includes(entry));

  console.log(`[machine] production installer: ${basePlan.mode}${basePlan.requiresElevation ? ' (needs administrator)' : ''}`);
  console.log(`[machine] install directory:   ${installDir}`);
  console.log(`[machine] uninstall key:       ${basePlan.uninstallKeyScope}\\${basePlan.uninstallKey}`);
  console.log(`[machine] shortcuts:           desktop=${basePlan.shortcuts.desktop} start-menu=${basePlan.shortcuts.startMenu} (${basePlan.shortcuts.context})`);
  console.log(`[machine] user data:           %APPDATA%\\IS King Panel (per Windows user)`);
  console.log(`[machine] elevated shell:      ${elevated ? 'yes' : 'no'}`);
  console.log(`[machine] installer present:   ${fs.existsSync(installerPath) ? `${path.relative(ROOT, installerPath)} (${(fs.statSync(installerPath).size / 1024 / 1024).toFixed(1)} MB)` : 'MISSING'}`);

  if (!fs.existsSync(installerPath)) {
    problems.push(`the installer is missing: ${path.relative(ROOT, installerPath)} — run npm run electron:build first`);
  }
  const elevation = elevationProblem({ elevated });
  if (elevation) problems.push(elevation);

  if (leftover.state === 'empty-directory') {
    notes.push(`leftover: ${leftover.action}`);
  } else if (leftover.state === 'occupied') {
    problems.push(
      `an installation already exists at ${installDir}. This harness will not touch it: ` +
        'uninstall it yourself, or pass --install-dir for a scratch location.',
    );
  }
  for (const entry of foreignRegistry) {
    notes.push(
      `registry: ${entry.DisplayName} ${entry.DisplayVersion ?? ''} is registered elsewhere ` +
        `(${String(entry.UninstallString ?? '').trim() || 'no uninstall string'}); it is not this harness's and will be left alone`,
    );
  }

  console.log('\n[machine] the run would: install silently, launch with APPDATA redirected into .tmp/machine-install,');
  console.log('[machine]   verify backend + bundled runtime + per-user data location, uninstall, verify user data');
  console.log('[machine]   survived, then reinstall.');
  for (const note of notes) console.log(`[machine] note: ${note}`);

  if (problems.length) {
    console.log('\n[machine] BLOCKED:');
    for (const problem of problems) console.log(`  - ${problem}`);
    return 2;
  }
  console.log('\n[machine] ready. Re-run with --run --confirm=per-machine-install to perform it.');
  return 0;
}

function realDeps() {
  const appDataBase = ISOLATED_APPDATA;
  const stateDir = path.join(appDataBase, 'IS King Panel');
  let child = null;
  return {
    runInstaller: (file, args) => {
      console.log(`[machine] running ${path.basename(file)} ${args.join(' ')}`);
      return spawnSync(file, args, { stdio: 'inherit', env: process.env });
    },
    uninstall: () => {
      const uninstaller = listDir(installDir).find((name) => /^Uninstall.*\.exe$/i.test(name));
      if (!uninstaller) return { status: 1, error: new Error('no uninstaller in the install directory') };
      return spawnSync(path.join(installDir, uninstaller), ['/S'], { stdio: 'inherit', env: process.env });
    },
    exists: async (file) => fs.existsSync(file),
    version: async (file) => {
      const result = spawnSync(
        'powershell',
        ['-NoProfile', '-Command', `(Get-Item '${file}').VersionInfo.ProductVersion`],
        { encoding: 'utf8' },
      );
      return (result.stdout || '').trim();
    },
    launch: async () => {
      fs.mkdirSync(LOGS, { recursive: true });
      const log = path.join(LOGS, `app-${Date.now()}.log`);
      const fd = fs.openSync(log, 'w');
      child = spawn(path.join(installDir, `${basePlan.productName}.exe`), [`--user-data-dir=${path.join(stateDir, 'profile')}`], {
        cwd: installDir,
        detached: true,
        stdio: ['ignore', fd, fd],
        env: { ...process.env, APPDATA: appDataBase, PORT: String(APP_PORT), MONGODB_URI: '', DISCORD_BOT_TOKEN: '' },
      });
      child.unref();
      return { ok: true, detail: log };
    },
    stop: async () => {
      const pids = spawnSync(
        'powershell',
        ['-NoProfile', '-Command', `Get-Process -Name '${basePlan.productName}' -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id`],
        { encoding: 'utf8' },
      );
      for (const pid of String(pids.stdout ?? '').split(/\s+/).filter(Boolean)) {
        spawnSync('taskkill', ['/F', '/PID', pid, '/T'], { stdio: 'ignore' });
      }
      await new Promise((resolve) => setTimeout(resolve, 1500));
    },
    backendReady: async () => {
      const deadline = Date.now() + 180_000;
      while (Date.now() < deadline) {
        try {
          await fetch(`http://127.0.0.1:${APP_PORT}/api/auth/login`);
          return true;
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 500));
        }
      }
      return false;
    },
    usedBundledRuntime: async () => {
      const logs = fs.readdirSync(LOGS).filter((name) => name.endsWith('.log'));
      const latest = logs.sort().at(-1);
      if (!latest) return false;
      const text = fs.readFileSync(path.join(LOGS, latest), 'utf8');
      return /Runtime: (bundled|packaged)/i.test(text) && !/Runtime: system/i.test(text);
    },
    stateDir: async () => stateDir,
    userDataFiles: async () => {
      const files = [];
      const walk = (dir) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const abs = path.join(dir, entry.name);
          if (entry.isDirectory()) walk(abs);
          else files.push(path.relative(WORK, abs));
        }
      };
      try {
        walk(stateDir);
      } catch {
        // nothing written yet
      }
      return files;
    },
  };
}

async function main() {
  if (process.platform !== 'win32') {
    console.error('[machine] per-machine verification only runs on Windows.');
    return 2;
  }
  if (!run) return preflight();

  if (arg('--confirm') !== CONFIRMATION) {
    console.error(
      `[machine] refusing to modify this machine without confirmation.\n` +
        `  Re-run with: --run --confirm=${CONFIRMATION}\n` +
        '  This installs to a real Program Files directory and registers an uninstaller under HKLM.',
    );
    return 2;
  }
  const elevation = elevationProblem({ elevated: isElevated() });
  if (elevation) {
    console.error(`[machine] BLOCKED: ${elevation}`);
    return 2;
  }

  // The harness owns the whole work tree; a previous run's leftovers are ours.
  fs.rmSync(WORK, { recursive: true, force: true });
  for (const dir of [WORK, ISOLATED_APPDATA, LOGS]) fs.mkdirSync(dir, { recursive: true });

  const version = spawnSync(
    'powershell',
    ['-NoProfile', '-Command', `(Get-Item '${installerPath}').VersionInfo.ProductVersion`],
    { encoding: 'utf8' },
  ).stdout.trim();
  const plan = {
    ...basePlan,
    version,
    updateVersion: arg('--update-version'),
    installDir,
    exePath: path.join(installDir, `${basePlan.productName}.exe`),
    appDataBase: ISOLATED_APPDATA,
    appPort: APP_PORT,
  };

  const result = await runMachineInstall({
    plan,
    installer: installerPath,
    updateInstaller: updateInstallerArg ? path.resolve(ROOT, updateInstallerArg) : null,
    deps: realDeps(),
  });

  for (const check of result.checks) {
    console.log(`  ${check.ok ? 'PASS' : 'FAIL'}  ${check.label}${check.detail ? ` — ${check.detail}` : ''}`);
  }
  if (result.fatal) console.error(`[machine] STOPPED: ${result.fatal}`);
  console.log(`\n[machine] ${result.failures.length === 0 ? 'RESULT: PASS' : `RESULT: FAIL (${result.failures.length})`}`);
  if (result.failures.length) {
    console.log('[machine] the machine may be left with an installation; uninstall it with its own uninstaller.');
    return 1;
  }
  return 0;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err) => {
    console.error(`[machine] ERROR: ${err instanceof Error ? err.message : err}`);
    process.exitCode = 1;
  });
