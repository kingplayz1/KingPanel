/**
 * Installation modes, the per-machine sequence, and fixture caching.
 *
 * The per-machine test cannot run in `npm test` — it installs to Program Files
 * and needs an administrator. What *can* be tested is everything that decides
 * whether it runs and what it concludes: the mode derivation, the elevation
 * rules, how a cancelled UAC prompt is classified, and the order of checks that
 * prove data survived an uninstall. Those are driven here through injected IO.
 *
 * These are mocked tests. They prove the logic, not that this machine installs
 * correctly; scripts/verify-machine-install.mjs is the real thing.
 *
 * Run with:  npm test
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import {
  assessLeftover,
  classifyInstallerResult,
  elevationProblem,
  expandWindowsPath,
  installPlan,
  runMachineInstall,
  userDataVerdict,
} from '../scripts/install-config.mjs';
import {
  cacheVerdict,
  clearFixtures,
  configDigest,
  fixtureManifest,
  hashFile,
  reuseDecision,
  runtimeDigest,
  sourceDigest,
} from '../scripts/fixture-cache.mjs';

let work;
before(() => {
  work = fs.mkdtempSync(path.join(os.tmpdir(), 'isk-install-'));
});
after(() => {
  fs.rmSync(work, { recursive: true, force: true });
});

const PER_MACHINE_PKG = {
  name: 'react-example',
  build: {
    appId: 'com.kingplayz.iskingpanel',
    productName: 'IS King Panel',
    nsis: { oneClick: false, perMachine: true, allowToChangeInstallationDirectory: true },
  },
};

describe('installation configuration', () => {
  test('the production build is per-machine and needs an administrator', () => {
    const plan = installPlan(PER_MACHINE_PKG);
    assert.equal(plan.mode, 'per-machine');
    assert.equal(plan.requiresElevation, true);
    assert.equal(plan.installDir, '%ProgramFiles%\\IS King Panel');
    assert.equal(plan.uninstallKeyScope, 'HKLM');
    assert.equal(plan.shortcuts.context, 'all users');
    assert.equal(plan.userDataIsPerUser, true, 'user data stays per Windows user even for a machine-wide install');
    assert.equal(plan.userDataDir, '%APPDATA%\\IS King Panel');
  });

  test('a fixture build is per-user and needs no elevation', () => {
    const plan = installPlan({
      name: 'react-example',
      build: { productName: 'IS King Panel', nsis: { oneClick: false, perMachine: false } },
    });
    assert.equal(plan.mode, 'per-user');
    assert.equal(plan.requiresElevation, false);
    assert.equal(plan.installDir, '%LOCALAPPDATA%\\Programs\\IS King Panel');
    assert.equal(plan.uninstallKeyScope, 'HKCU');
    assert.equal(plan.shortcuts.context, 'current user');
  });

  test('per-machine is only claimed when nsis.perMachine is explicitly true', () => {
    // electron-builder's default is per-user; a missing key must not be read as
    // "this installs for everyone".
    assert.equal(installPlan({ name: 'x', build: {} }).mode, 'per-user');
    assert.equal(installPlan({ name: 'x', build: { nsis: { perMachine: 'true' } } }).mode, 'per-user');
  });

  test('install paths expand without a shell', () => {
    assert.equal(
      expandWindowsPath('%ProgramFiles%\\IS King Panel', { ProgramFiles: 'C:\\Program Files' }),
      'C:\\Program Files\\IS King Panel',
    );
    assert.equal(expandWindowsPath('%LOCALAPPDATA%\\Programs\\X', { LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' }), 'C:\\Users\\u\\AppData\\Local\\Programs\\X');
    assert.equal(expandWindowsPath('relative\\path', {}), 'relative\\path');
  });

  test('elevation is reported, never obtained', () => {
    assert.match(elevationProblem({ platform: 'win32', elevated: false }), /not elevated.*needs administrator/i);
    assert.match(elevationProblem({ platform: 'win32', elevated: false }), /never requests elevation/i);
    assert.equal(elevationProblem({ platform: 'win32', elevated: true }), null);
    assert.match(elevationProblem({ platform: 'linux', elevated: true }), /only be verified on Windows/);
  });
});

describe('installer outcomes', () => {
  test('a cancelled UAC prompt is not success', () => {
    const error = Object.assign(new Error('spawn C:\\x\\setup.exe EACCES'), { code: 'EACCES' });
    const outcome = classifyInstallerResult({ error, status: null });
    assert.equal(outcome.ok, false);
    assert.equal(outcome.kind, 'elevation-required');
    assert.match(outcome.detail, /elevation prompt|per-machine/i);
  });

  test('a failing installer, a spawn failure and a kill are distinguished', () => {
    assert.deepEqual(
      { ok: classifyInstallerResult({ status: 2 }).ok, kind: classifyInstallerResult({ status: 2 }).kind },
      { ok: false, kind: 'installer-failed' },
    );
    assert.equal(classifyInstallerResult({ error: new Error('ENOENT') }).kind, 'spawn-failed');
    assert.equal(classifyInstallerResult({ status: null, signal: 'SIGKILL' }).kind, 'killed');
    assert.equal(classifyInstallerResult({ status: 0 }).ok, true);
  });
});

describe('leftovers', () => {
  test('nothing there', () => {
    assert.equal(assessLeftover({ dirExists: false }).state, 'clean');
  });

  test('an empty directory is removable, and only by an administrator', () => {
    const result = assessLeftover({ dirExists: true, entries: [], dir: 'C:\\Program Files\\IS King Panel' });
    assert.equal(result.state, 'empty-directory');
    assert.equal(result.mayRemove, true);
    assert.match(result.action, /elevated shell: rmdir/);
  });

  test('a real installation is never deleted by cleanup advice', () => {
    const result = assessLeftover({
      dirExists: true,
      entries: ['IS King Panel.exe', 'resources/'],
      registryEntries: [{ DisplayName: 'IS King Panel 1.0.2' }],
      dir: 'C:\\Program Files\\IS King Panel',
    });
    assert.equal(result.state, 'occupied');
    assert.equal(result.mayRemove, false);
    assert.match(result.action, /do not delete it/);
  });
});

describe('user data location', () => {
  const appData = 'C:\\Users\\probe\\AppData\\Roaming';
  const install = 'C:\\Program Files\\IS King Panel';

  test('state inside the user profile is correct', () => {
    const verdict = userDataVerdict({
      stateDir: `${appData}\\IS King Panel`,
      appDataBase: appData,
      installDir: install,
      pinnedDir: '%APPDATA%\\IS King Panel',
    });
    assert.equal(verdict.ok, true);
  });

  test('state outside the profile, or inside the install directory, fails', () => {
    const shared = userDataVerdict({
      stateDir: 'C:\\ProgramData\\IS King Panel',
      appDataBase: appData,
      installDir: install,
    });
    assert.equal(shared.ok, false);
    assert.match(shared.problems.join(' '), /two Windows users could share it/);

    const inInstall = userDataVerdict({
      stateDir: `${install}\\database`,
      appDataBase: appData,
      installDir: install,
    });
    assert.equal(inInstall.ok, false);
    assert.match(inInstall.problems.join(' '), /an update would replace user data/);

    const moved = userDataVerdict({
      stateDir: `${appData}\\react-example`,
      appDataBase: appData,
      installDir: install,
      pinnedDir: '%APPDATA%\\IS King Panel',
    });
    assert.equal(moved.ok, false);
    assert.match(moved.problems.join(' '), /pinned/);
  });
});

/** The plan a real run builds, with a fake machine behind it. */
function makePlan(overrides = {}) {
  return {
    mode: 'per-machine',
    version: '1.0.2.0',
    updateVersion: '1.0.3.0',
    installDir: 'C:\\Program Files\\IS King Panel',
    exePath: 'C:\\Program Files\\IS King Panel\\IS King Panel.exe',
    appDataBase: 'C:\\Users\\probe\\AppData\\Roaming',
    userDataDir: '%APPDATA%\\IS King Panel',
    appPort: 4777,
    ...overrides,
  };
}

/**
 * A fake machine: `runInstaller` mutates it, every other dependency reads it.
 * `overrides` replace individual steps so each test breaks exactly one thing.
 */
function fakeMachine({ version = '1.0.2.0', updateVersion = '1.0.3.0' } = {}) {
  const state = {
    installed: false,
    version,
    calls: [],
    files: ['database/isking_panel.sqlite', '.local-users-db.json'],
    filesAfterUninstall: ['database/isking_panel.sqlite', '.local-users-db.json'],
    installerRuns: 0,
    launchOk: true,
    backendUp: true,
    bundled: true,
    runInstallerResult: null,
    uninstallResult: null,
    // A misleading installer: exits 0 without writing anything.
    writesNothing: false,
  };
  const deps = {
    state,
    runInstaller: async () => {
      state.calls.push('install');
      state.installerRuns += 1;
      const result = state.runInstallerResult
        ? state.runInstallerResult(state.installerRuns)
        : { status: 0 };
      if (result.status === 0 && !state.writesNothing) {
        state.installed = true;
        if (state.installerRuns > 1) state.version = updateVersion;
      }
      return result;
    },
    uninstall: async () => {
      state.calls.push('uninstall');
      state.installed = false;
      return state.uninstallResult ?? { status: 0 };
    },
    exists: async () => state.installed,
    version: async () => state.version,
    launch: async () => {
      state.calls.push('launch');
      return { ok: state.launchOk, detail: state.launchOk ? 'log' : 'no window' };
    },
    stop: async () => {
      state.calls.push('stop');
    },
    backendReady: async () => state.backendUp,
    usedBundledRuntime: async () => state.bundled,
    stateDir: async () => 'C:\\Users\\probe\\AppData\\Roaming\\IS King Panel',
    userDataFiles: async () => (state.installed ? state.files : state.filesAfterUninstall),
  };
  return deps;
}

const labels = (result) => result.checks.map((check) => check.label);

describe('per-machine sequence (mocked)', () => {
  test('install, launch, uninstall and reinstall all pass', async () => {
    const deps = fakeMachine();
    const result = await runMachineInstall({ plan: makePlan(), installer: 'setup.exe', deps });
    assert.deepEqual(result.failures, []);
    assert.equal(result.fatal, null);
    assert.deepEqual(deps.state.calls, ['install', 'launch', 'stop', 'uninstall', 'install']);
    assert.ok(labels(result).includes('uninstall kept the user data'));
    assert.ok(labels(result).includes('backend started on the bundled Node runtime'));
    assert.ok(labels(result).includes('runtime is the packaged one, not a system Node'));
    assert.ok(labels(result).includes('user data lives in this user’s own profile'));
    assert.ok(labels(result).includes('reinstall restored the executable'));
  });

  test('a declined elevation prompt stops before anything is uninstalled', async () => {
    const deps = fakeMachine();
    deps.state.runInstallerResult = () => ({ error: Object.assign(new Error('spawn EACCES'), { code: 'EACCES' }) });
    const result = await runMachineInstall({ plan: makePlan(), installer: 'setup.exe', deps });
    assert.match(result.fatal, /elevation/i);
    assert.ok(!deps.state.calls.includes('uninstall'));
    assert.ok(result.failures.some((check) => /elevation-required/.test(check.detail)));
  });

  test('an installer that exits non-zero is a failure, not a no-op', async () => {
    const deps = fakeMachine();
    deps.state.runInstallerResult = () => ({ status: 3 });
    const result = await runMachineInstall({ plan: makePlan(), installer: 'setup.exe', deps });
    assert.match(result.fatal, /installer failed/i);
    assert.ok(!deps.state.calls.includes('launch'));
  });

  test('an installer that writes no executable is caught', async () => {
    const deps = fakeMachine();
    deps.state.writesNothing = true;
    deps.state.runInstallerResult = () => ({ status: 0 }); // pretends success, writes nothing
    const result = await runMachineInstall({ plan: makePlan(), installer: 'setup.exe', deps });
    assert.match(result.fatal, /wrote no executable/);
  });

  test('an app that will not start fails the run', async () => {
    const deps = fakeMachine();
    deps.state.launchOk = false;
    const result = await runMachineInstall({ plan: makePlan(), installer: 'setup.exe', deps });
    assert.match(result.fatal, /did not start/);
  });

  test('a successful update reports the new version and keeps data', async () => {
    const deps = fakeMachine();
    const result = await runMachineInstall({
      plan: makePlan(),
      installer: 'setup-1.0.2.exe',
      updateInstaller: 'setup-1.0.3.exe',
      deps,
    });
    assert.deepEqual(result.failures, []);
    assert.ok(labels(result).includes('new version is installed after the update'));
    assert.ok(labels(result).includes('user data survived the update'));
    assert.deepEqual(result.versions, ['1.0.2.0', '1.0.3.0']);
  });

  test('a failed update leaves a working installation and its data', async () => {
    const deps = fakeMachine();
    deps.state.runInstallerResult = (run) => (run === 1 ? { status: 0 } : { status: 1 });
    const result = await runMachineInstall({
      plan: makePlan(),
      installer: 'setup-1.0.2.exe',
      updateInstaller: 'setup-1.0.3.exe',
      deps,
    });
    const failed = labels(result).filter((label) => label.includes('failed update') || label.includes('after a failed update'));
    assert.equal(failed.length, 3);
    for (const label of failed) {
      assert.ok(result.checks.find((check) => check.label === label).ok, label);
    }
    assert.ok(result.failures.some((check) => check.label === 'update installer completed'));
  });

  test('an uninstall that removes user data fails the run', async () => {
    const deps = fakeMachine();
    deps.state.filesAfterUninstall = [];
    const result = await runMachineInstall({ plan: makePlan(), installer: 'setup.exe', deps });
    const kept = result.checks.find((check) => check.label === 'uninstall kept the user data');
    assert.equal(kept.ok, false);
    assert.match(kept.detail, /2 file\(s\) before, 0 after/);
    assert.equal(result.failures.length >= 1, true);
  });

  test('an uninstaller that fails is reported instead of being ignored', async () => {
    const deps = fakeMachine();
    deps.state.uninstallResult = { status: 1 };
    const result = await runMachineInstall({ plan: makePlan(), installer: 'setup.exe', deps });
    assert.match(result.fatal, /uninstaller did not complete/);
  });
});

describe('fixture cache', () => {
  const inputs = {
    source: 'source-hash',
    config: 'config-hash',
    runtime: 'runtime-hash',
    electronBuilder: '24.13.3',
  };

  function makeFixture(name, { version = '1.0.1', inputOverrides = {}, installerBytes = randomBytes(4096) } = {}) {
    const dir = path.join(work, name);
    fs.mkdirSync(dir, { recursive: true });
    const installerPath = path.join(dir, `IS-King-Panel-Setup-${version}.exe`);
    fs.writeFileSync(installerPath, installerBytes);
    fs.writeFileSync(path.join(dir, 'latest.yml'), `version: ${version}\npath: ${path.basename(installerPath)}\n`);
    fs.writeFileSync(
      path.join(dir, 'fixture.json'),
      JSON.stringify(
        fixtureManifest({
          version,
          inputs: { ...inputs, ...inputOverrides },
          installerPath,
          buildMs: 200_000,
          commit: 'abc1234',
          dirty: false,
          config: 'fixture-builder.json',
          feed: 'http://127.0.0.1:8899/',
        }),
        null,
        2,
      ),
    );
    return { dir, installerPath, version };
  }

  test('a matching fixture is reusable', () => {
    const { dir, version } = makeFixture('hit');
    const verdict = cacheVerdict({ fixtureDir: dir, expected: { version, inputs } });
    assert.equal(verdict.usable, true, verdict.reasons.join(', '));
    assert.equal(verdict.manifest.buildMs, 200_000);
  });

  test('a missing manifest is a miss, not a guess', () => {
    const { dir, version } = makeFixture('no-manifest');
    fs.rmSync(path.join(dir, 'fixture.json'));
    const verdict = cacheVerdict({ fixtureDir: dir, expected: { version, inputs } });
    assert.equal(verdict.usable, false);
    assert.match(verdict.reasons.join(' '), /no fixture\.json/);
  });

  test('source, config and runtime changes all invalidate', () => {
    const { dir, version } = makeFixture('inputs');
    for (const key of ['source', 'config', 'runtime', 'electronBuilder']) {
      const verdict = cacheVerdict({
        fixtureDir: dir,
        expected: { version, inputs: { ...inputs, [key]: `different-${key}` } },
      });
      assert.equal(verdict.usable, false, key);
      assert.match(verdict.reasons.join(' '), new RegExp(`${key} changed`), key);
    }
  });

  test('a different version is never reused', () => {
    const { dir } = makeFixture('version');
    const verdict = cacheVerdict({ fixtureDir: dir, expected: { version: '1.0.2', inputs } });
    assert.equal(verdict.usable, false);
    assert.match(verdict.reasons.join(' '), /version 1\.0\.1 != 1\.0\.2/);
  });

  test('a corrupted or replaced installer is rejected', () => {
    const { dir, installerPath, version } = makeFixture('corrupt');
    fs.appendFileSync(installerPath, 'tampered');
    const verdict = cacheVerdict({ fixtureDir: dir, expected: { version, inputs } });
    assert.equal(verdict.usable, false);
    assert.match(verdict.reasons.join(' '), /size .* recorded/);

    const truncated = makeFixture('truncated');
    fs.writeFileSync(truncated.installerPath, Buffer.alloc(fs.statSync(truncated.installerPath).size));
    const second = cacheVerdict({ fixtureDir: truncated.dir, expected: { version: truncated.version, inputs } });
    assert.equal(second.usable, false);
    assert.match(second.reasons.join(' '), /do not match the recorded hash/);
  });

  test('a fixture without the feed file is rejected', () => {
    const { dir, version } = makeFixture('no-feed');
    fs.rmSync(path.join(dir, 'latest.yml'));
    const verdict = cacheVerdict({ fixtureDir: dir, expected: { version, inputs } });
    assert.equal(verdict.usable, false);
    assert.match(verdict.reasons.join(' '), /latest\.yml is missing/);
  });

  test('a dirty tree needs an explicit override even on a cache hit', () => {
    const { dir, version } = makeFixture('dirty');
    const verdict = cacheVerdict({ fixtureDir: dir, expected: { version, inputs } });
    assert.equal(reuseDecision({ verdict }).reuse, true);
    const dirty = reuseDecision({ verdict, dirty: true });
    assert.equal(dirty.reuse, false);
    assert.match(dirty.reasons.join(' '), /--allow-dirty/);
    assert.equal(reuseDecision({ verdict, dirty: true, allowDirty: true }).reuse, true);
  });

  test('force always rebuilds', () => {
    const { dir, version } = makeFixture('force');
    const verdict = cacheVerdict({ fixtureDir: dir, expected: { version, inputs } });
    assert.deepEqual(reuseDecision({ verdict, force: true }), { reuse: false, reasons: ['--force'] });
  });

  test('a miss rebuilds and says why', () => {
    const { dir, version } = makeFixture('miss');
    const verdict = cacheVerdict({ fixtureDir: dir, expected: { version, inputs: { ...inputs, source: 'other' } } });
    const decision = reuseDecision({ verdict });
    assert.equal(decision.reuse, false);
    assert.match(decision.reasons.join(' '), /source changed/);
  });

  test('clearing removes generated fixtures only', () => {
    const outRoot = fs.mkdtempSync(path.join(work, 'clear-'));
    makeFixture(path.join(path.basename(outRoot), 'v1.0.0'), { version: '1.0.0' });
    fs.mkdirSync(path.join(outRoot, 'v2.0.0'), { recursive: true });
    fs.writeFileSync(path.join(outRoot, 'v2.0.0', 'notes.txt'), 'not ours');
    fs.mkdirSync(path.join(outRoot, 'unrelated'), { recursive: true });
    const { removed, skipped } = clearFixtures(outRoot);
    assert.deepEqual(removed, ['v1.0.0']);
    assert.deepEqual(skipped, ['v2.0.0']);
    assert.ok(fs.existsSync(path.join(outRoot, 'unrelated')));
  });
});

describe('source digest', () => {
  function tree() {
    const root = fs.mkdtempSync(path.join(work, 'tree-'));
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src', 'App.tsx'), 'export const a = 1;');
    fs.writeFileSync(path.join(root, 'package.json'), '{"name":"x"}');
    return root;
  }

  test('changes when source changes', () => {
    const root = tree();
    const before = sourceDigest(root).digest;
    fs.writeFileSync(path.join(root, 'src', 'App.tsx'), 'export const a = 2;');
    assert.notEqual(sourceDigest(root).digest, before);
  });

  test('ignores build output, scratch directories and developer data', () => {
    const root = tree();
    const before = sourceDigest(root).digest;
    for (const [rel, contents] of Object.entries({
      'dist/index.html': 'built',
      'dist_electron/x.exe': 'artifact',
      '.tmp/log.txt': 'scratch',
      'database/isking_panel.sqlite': 'state',
      'src/node_modules/dep/index.js': 'dependency',
    })) {
      const abs = path.join(root, rel);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, contents);
    }
    assert.equal(sourceDigest(root).digest, before);
  });

  test('runtime and config digests are content hashes', () => {
    const root = tree();
    const manifest = path.join(root, 'runtime.json');
    fs.writeFileSync(manifest, '{"nodeVersion":"22.23.1"}');
    const first = runtimeDigest(manifest);
    fs.writeFileSync(manifest, '{"nodeVersion":"22.24.0"}');
    assert.notEqual(runtimeDigest(manifest), first);
    assert.equal(runtimeDigest(path.join(root, 'absent.json')), 'missing');

    assert.notEqual(configDigest({ a: 1 }), configDigest({ a: 2 }));
    assert.equal(configDigest({ a: 1 }), configDigest({ a: 1 }));
    assert.equal(typeof hashFile(manifest), 'string');
  });
});
