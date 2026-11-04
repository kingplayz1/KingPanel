/**
 * Install-mode facts, and the per-machine run as a sequence over injected IO.
 *
 * Why this is a module rather than part of a script: an installer changes a
 * machine, so the interesting logic — what mode the build is in, whether
 * elevation is present, what a cancelled UAC prompt looks like, whether a
 * leftover directory belongs to us — has to be testable without a Windows VM and
 * without ever touching the machine running the tests.
 *
 * Nothing here elevates anything. `elevationProblem` only reports whether the
 * current process already is elevated; obtaining elevation is a decision for the
 * person running the command, made in their own terminal.
 */
import { spawnSync } from 'node:child_process';

export const PER_MACHINE = 'per-machine';
export const PER_USER = 'per-user';

/**
 * Everything the installer does, derived from `build.nsis` in package.json.
 *
 * electron-builder's defaults are `perMachine: false`, `oneClick: true`; this
 * project sets `perMachine: true` for releases, so the production installer
 * writes to Program Files and registers under HKLM.
 */
export function installPlan(pkg) {
  const build = pkg.build ?? {};
  const nsis = build.nsis ?? {};
  const productName = build.productName ?? pkg.name;
  const appId = build.appId ?? pkg.name;
  const perMachine = nsis.perMachine === true;
  return {
    mode: perMachine ? PER_MACHINE : PER_USER,
    appId,
    productName,
    oneClick: nsis.oneClick !== false,
    requiresElevation: perMachine,
    installDir:
      nsis.allowToChangeInstallationDirectory === false
        ? undefined
        : perMachine
          ? `%ProgramFiles%\\${productName}`
          : `%LOCALAPPDATA%\\Programs\\${productName}`,
    uninstallKeyScope: perMachine ? 'HKLM' : 'HKCU',
    uninstallKey: `Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${appId}`,
    shortcuts: {
      desktop: nsis.createDesktopShortcut !== false,
      startMenu: nsis.createStartMenuShortcut !== false,
      // Per-machine shortcuts are written for all users, because the install is.
      context: perMachine ? 'all users' : 'current user',
    },
    // The app pins its own directory (state-dirs.cjs), so this is a fact about
    // the app rather than about the installer; it is listed here because "where
    // does the data go" is the first thing to check after an install.
    userDataDir: `%APPDATA%\\IS King Panel`,
    userDataIsPerUser: true,
  };
}

/** Expand `%VAR%` the way NSIS does, without a shell. */
export function expandWindowsPath(template, env = process.env) {
  if (!template) return '';
  return template.replace(/%([A-Za-z0-9_]+)%/g, (match, name) => {
    const key = Object.keys(env).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
    return key ? String(env[key]) : match;
  });
}

/**
 * Why a per-machine run cannot proceed here, or null when it can.
 *
 * A non-elevated run is the normal case, and it is not an error condition of the
 * software: it is why this harness exists. The message says what to do, because
 * the alternative — spawning `runas` — is exactly what this must not do.
 */
export function elevationProblem({ platform = process.platform, elevated } = {}) {
  if (platform !== 'win32') {
    return 'per-machine installation can only be verified on Windows';
  }
  if (elevated !== true) {
    return (
      'this process is not elevated, and a per-machine install needs administrator rights. ' +
      'Open an elevated terminal yourself and re-run — it never requests elevation for you.'
    );
  }
  return null;
}

/**
 * Whether the current process already has administrator rights.
 *
 * `net session` needs elevation and fails with access-denied otherwise; the
 * PowerShell principal check is the portable way and does not change state.
 */
export function isElevated(spawn = spawnSync) {
  if (process.platform !== 'win32') return false;
  const result = spawn(
    'powershell',
    [
      '-NoProfile',
      '-Command',
      '([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)',
    ],
    { encoding: 'utf8' },
  );
  return String(result.stdout ?? '').trim().toLowerCase() === 'true';
}

/**
 * Classify an installer run.
 *
 * `spawnSync` reports a cancelled UAC prompt (and a refused CreateProcess) as an
 * error with `EACCES`, not as an exit code, so a test that only looks at `status`
 * would call an elevated-only installer "successful with status null".
 */
export function classifyInstallerResult(result = {}) {
  if (result.error) {
    const message = String(result.error.message ?? result.error);
    if (/EACCES|EPERM|access is denied/i.test(message)) {
      return {
        ok: false,
        kind: 'elevation-required',
        detail: 'Windows refused to start it — a cancelled elevation prompt, or a per-machine installer launched unelevated',
      };
    }
    return { ok: false, kind: 'spawn-failed', detail: message };
  }
  if (result.signal) {
    return { ok: false, kind: 'killed', detail: `killed by ${result.signal}` };
  }
  if (result.status !== 0) {
    return { ok: false, kind: 'installer-failed', detail: `exit code ${result.status}` };
  }
  return { ok: true, kind: 'installed', detail: 'exit code 0' };
}

/**
 * What is left on the machine after an uninstall, and whether we may remove it.
 *
 * An empty directory is harmless leftovers that only an administrator can delete.
 * A directory with files is somebody's installation: the answer is never "delete
 * it", because a wrong guess here destroys an app the user still runs.
 */
export function assessLeftover({ dirExists, entries = [], registryEntries = [], dir = '' }) {
  const files = entries.filter((entry) => !String(entry).endsWith('/'));
  if (!dirExists && registryEntries.length === 0) {
    return { state: 'clean', mayRemove: false, action: 'nothing to clean up' };
  }
  if (dirExists && files.length === 0 && registryEntries.length === 0) {
    return {
      state: 'empty-directory',
      mayRemove: true,
      action: `an empty directory remains; remove it from an elevated shell: rmdir "${dir}"`,
    };
  }
  return {
    state: 'occupied',
    mayRemove: false,
    action:
      `an installation is present at ${dir || '(unknown path)'} ` +
      `(${files.length} file(s), ${registryEntries.length} registry entr(ies)); ` +
      'do not delete it — use its own uninstaller',
  };
}

/**
 * Where the app keeps its data, checked rather than assumed.
 *
 * Two Windows accounts must not share an account database, which holds as long as
 * the state directory resolves inside each user's own `%APPDATA%` and never
 * inside the (machine-wide) install directory.
 */
export function userDataVerdict({ stateDir, appDataBase, installDir, pinnedDir }) {
  const problems = [];
  const norm = (value) => String(value ?? '').replace(/\\/g, '/').toLowerCase().replace(/\/+$/, '');
  const state = norm(stateDir);
  const appData = norm(appDataBase);
  const install = norm(installDir);
  if (!state) problems.push('no state directory was resolved');
  if (appData && !state.startsWith(`${appData}/`)) {
    problems.push(`the state directory ${stateDir} is not inside %APPDATA% (${appDataBase}), so two Windows users could share it`);
  }
  if (install && state.startsWith(`${install}/`)) {
    problems.push(`the state directory ${stateDir} is inside the install directory, so an update would replace user data`);
  }
  if (pinnedDir) {
    // The pinned value is a template (`%APPDATA%\IS King Panel`), so only its
    // leaf can be compared against a resolved path; an absolute pin is compared
    // in full.
    const isTemplate = /%[A-Za-z0-9_]+%/.test(String(pinnedDir));
    const leaf = norm(String(pinnedDir).split('\\').pop());
    if (isTemplate) {
      if (leaf && !state.endsWith(`/${leaf}`)) {
        problems.push(`the resolved state directory ${stateDir} does not end with the pinned ${leaf}`);
      }
    } else if (norm(pinnedDir) !== state) {
      problems.push(`the resolved state directory ${stateDir} does not match the pinned ${pinnedDir}`);
    }
  }
  return { ok: problems.length === 0, problems };
}

const STOP = Symbol('stop');

/**
 * The per-machine sequence, over injected IO.
 *
 * Every step is a dependency so the sequence can be driven by mocks in tests and
 * by real processes in the harness — the order, the checks and the failure
 * handling are the part worth testing. It returns every check it made plus the
 * first fatal failure, so a caller can report all of them rather than just the
 * one that threw.
 *
 * @param {object} options
 * @param {object} options.plan result of installPlan()
 * @param {string} options.installer production installer path
 * @param {string} [options.updateInstaller] a newer installer, to exercise the update
 * @param {object} options.deps
 */
export async function runMachineInstall({ plan, installer, updateInstaller, deps }) {
  const checks = [];
  const check = (label, ok, detail = '') => {
    checks.push({ label, ok: Boolean(ok), detail });
    return Boolean(ok);
  };
  let fatal = null;
  const stopWith = (message) => {
    fatal = message;
    throw STOP;
  };
  const previousVersions = [];

  try {
    // ── install ──────────────────────────────────────────────────────────
    const install = classifyInstallerResult(await deps.runInstaller(installer, ['/S', `/D=${plan.installDir}`]));
    if (!check('installer completed', install.ok, `${install.kind}: ${install.detail}`)) {
      stopWith(
        install.kind === 'elevation-required'
          ? 'the installer demanded elevation (a declined UAC prompt, or an unelevated launch)'
          : `the installer failed (${install.detail})`,
      );
    }
    if (!check('application executable is in the install directory', await deps.exists(plan.exePath), plan.exePath)) {
      stopWith('the installer reported success but wrote no executable');
    }

    const version = await deps.version(plan.exePath);
    previousVersions.push(version);
    check('installed version matches the installer', String(version).startsWith(plan.version), `reported ${version}`);

    // ── launch and boot the backend on the bundled runtime ───────────────
    const launched = await deps.launch();
    if (!check('application launched', launched.ok, launched.detail)) stopWith('the application did not start');
    check('backend started on the bundled Node runtime', await deps.backendReady(), `port ${plan.appPort ?? 4777}`);
    check('runtime is the packaged one, not a system Node', await deps.usedBundledRuntime());

    const data = userDataVerdict({
      stateDir: await deps.stateDir(),
      appDataBase: plan.appDataBase,
      installDir: plan.installDir,
      pinnedDir: plan.userDataDir,
    });
    check('user data lives in this user’s own profile', data.ok, data.problems.join('; '));
    const before = await deps.userDataFiles();

    await deps.stop();

    // ── optional update, with rollback when it fails ─────────────────────
    if (updateInstaller) {
      const updated = classifyInstallerResult(
        await deps.runInstaller(updateInstaller, ['/S', `/D=${plan.installDir}`]),
      );
      if (check('update installer completed', updated.ok, `${updated.kind}: ${updated.detail}`)) {
        const next = await deps.version(plan.exePath);
        previousVersions.push(next);
        check(
          'new version is installed after the update',
          String(next) !== String(version) || String(next).startsWith(plan.updateVersion ?? ''),
          `reported ${next}`,
        );
      } else {
        // A failed update must leave a working installation behind, not a
        // half-replaced one: the previous build still runs and data is intact.
        const stillThere = await deps.exists(plan.exePath);
        check('a failed update leaves the previous build installed', stillThere, `${updated.kind}: ${updated.detail}`);
        check('the previous build still reports its version', String(await deps.version(plan.exePath)) === String(version));
        const relaunched = await deps.launch();
        check('the previous build still starts after a failed update', relaunched.ok, relaunched.detail);
        check('backend still starts after a failed update', await deps.backendReady());
        await deps.stop();
      }
      const afterUpdate = await deps.userDataFiles();
      check('user data survived the update', afterUpdate.length >= before.length, `${before.length} -> ${afterUpdate.length} file(s)`);
    }

    // ── uninstall, then prove user data is untouched ─────────────────────
    const uninstalled = classifyInstallerResult(await deps.uninstall());
    if (!check('uninstaller completed', uninstalled.ok, `${uninstalled.kind}: ${uninstalled.detail}`)) {
      stopWith('the uninstaller did not complete');
    }
    check('application executable was removed', !(await deps.exists(plan.exePath)), plan.exePath);
    const afterUninstall = await deps.userDataFiles();
    const kept = before.every((file) => afterUninstall.includes(file));
    check(
      'uninstall kept the user data',
      kept,
      `${before.length} file(s) before, ${afterUninstall.length} after`,
    );

    // ── reinstall ────────────────────────────────────────────────────────
    const reinstalled = classifyInstallerResult(await deps.runInstaller(installer, ['/S', `/D=${plan.installDir}`]));
    check('reinstall completed', reinstalled.ok, `${reinstalled.kind}: ${reinstalled.detail}`);
    check('reinstall restored the executable', await deps.exists(plan.exePath), plan.exePath);
    check('reinstall still sees the existing data', (await deps.userDataFiles()).length >= before.length);
  } catch (err) {
    if (err !== STOP) throw err;
  }

  return {
    checks,
    failures: checks.filter((entry) => !entry.ok),
    fatal,
    versions: previousVersions,
  };
}

/**
 * A filename that names the platform and cannot collide between two runs.
 *
 * Windows 10 and Windows 11 are two halves of one gate, and a shared filename is
 * how one half quietly overwrites the other. The timestamp is local-clock ISO so
 * two runs minutes apart stay distinguishable without a counter file.
 */
export function evidenceFileName({ platform, date = new Date(), hostname = '' } = {}) {
  const stamp = (date instanceof Date ? date.toISOString() : String(date))
    .replace(/\.\d+Z$/, '')
    .replace(/:/g, '-')
    .replace('T', '_');
  const tag =
    String(platform ?? 'unknown')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'unknown';
  const host = String(hostname ?? '')
    .replace(/[^A-Za-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return `evidence-${tag}${host ? `-${host}` : ''}-${stamp}.txt`;
}

/**
 * Whether the installer on disk is the one the report claims was tested.
 *
 * Installers are not bit-reproducible, so a stale hash is the normal outcome of
 * a rebuild — and testing an unnamed binary is how a phase report ends up
 * describing a build nobody has. With no expectation the check passes but says
 * so, because the operator may legitimately be recording a fresh hash.
 */
export function installerHashVerdict({ actual, expected } = {}) {
  const norm = (value) => String(value ?? '').trim().toLowerCase().replace(/^sha256[:\s-]*/, '');
  if (!String(expected ?? '').trim()) {
    return { ok: true, checked: false, detail: 'no --expect-sha256 was given; only the measured hash is recorded' };
  }
  if (!norm(actual)) {
    return { ok: false, checked: true, detail: 'the installer hash could not be read' };
  }
  if (norm(actual) !== norm(expected)) {
    return { ok: false, checked: true, detail: `measured ${norm(actual)}, expected ${norm(expected)}` };
  }
  return { ok: true, checked: true, detail: `matches ${norm(expected)}` };
}

/**
 * Parse the Windows identity the harness records, from `ConvertTo-Json` output.
 *
 * Kept separate from the PowerShell call so the parsing — including the garbage
 * case, where a run must not invent an OS version — is testable off Windows.
 */
export function parseWindowsIdentity(text) {
  const empty = { productName: '', displayVersion: '', build: '', architecture: '', summary: 'unknown' };
  let parsed;
  try {
    parsed = JSON.parse(String(text ?? '').trim());
  } catch {
    return empty;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return empty;
  const productName = String(parsed.ProductName ?? '').trim();
  const displayVersion = String(parsed.DisplayVersion ?? '').trim();
  const build = [String(parsed.CurrentBuild ?? '').trim(), String(parsed.UBR ?? '').trim()]
    .filter(Boolean)
    .join('.');
  const architecture = String(parsed.OSArchitecture ?? '').trim();
  const summary =
    [productName, displayVersion, build ? `build ${build}` : '', architecture].filter(Boolean).join(' · ') || 'unknown';
  return { productName, displayVersion, build, architecture, summary };
}

/**
 * The evidence file for one platform run.
 *
 * Three rules are encoded here, because they are the ways this record goes
 * wrong: an unreadable or mismatched installer hash fails the run; a run with no
 * checks is `BLOCKED`, never `PASS`; and the trailer says plainly which parts of
 * the phase cannot come from this file at all.
 */
export function evidenceReport({
  platform,
  identity = {},
  installer = {},
  elevated,
  result = {},
  startedAt = new Date(),
  finishedAt = new Date(),
} = {}) {
  const checks = Array.isArray(result.checks) ? result.checks : [];
  const failed = checks.filter((entry) => !entry.ok);
  const hash =
    installer.hashVerdict ?? installerHashVerdict({ actual: installer.sha256, expected: installer.expectedSha256 });
  const verdict = result.fatal || failed.length || hash.ok === false ? 'FAIL' : checks.length === 0 ? 'BLOCKED' : 'PASS';
  const when = (value) => (value instanceof Date ? value.toISOString() : String(value));
  const lines = [
    'IS King Panel — per-machine installation evidence',
    `Verdict: ${verdict}`,
    `Platform (requested): ${platform ?? 'unknown'}`,
    `Windows (observed): ${identity.summary ?? 'unknown'}`,
    `Recorded: ${when(startedAt)} → ${when(finishedAt)}`,
    '',
    `Installer: ${installer.path ?? 'unknown'}`,
    `Installer size: ${installer.size ?? 'unknown'} bytes`,
    `Installer SHA-256: ${installer.sha256 ?? 'unreadable'}`,
    `Expected SHA-256: ${String(installer.expectedSha256 ?? '').trim() || '(not given)'}`,
    `SHA-256 check: ${hash.ok ? 'PASS' : 'FAIL'} — ${hash.detail}`,
    `Elevation: ${elevated === true ? 'administrator' : elevated === false ? 'standard user' : 'unknown'}`,
    '',
    `Checks (${checks.length}, ${failed.length} failed):`,
    ...checks.map(
      (entry) => `  ${entry.ok ? 'PASS' : 'FAIL'}  ${entry.label}${entry.detail ? ` — ${entry.detail}` : ''}`,
    ),
  ];
  if (result.fatal) lines.push('', `Stopped: ${result.fatal}`);
  if (result.versions?.length) lines.push(`Versions seen: ${result.versions.join(' → ')}`);
  lines.push(
    '',
    'Recorded by the harness. The UAC prompt and its cancellation, the shortcuts, the registry',
    'entry and the two-Windows-account checks are the operator’s observations and belong in the',
    'phase document. This file is not a substitute for them, and one platform’s file is never',
    'evidence for the other.',
  );
  return lines.join('\n');
}
