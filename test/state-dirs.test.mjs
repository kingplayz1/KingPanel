/**
 * State-directory resolution — the pin, and the one documented way around it.
 *
 * The pinned directory is what keeps an installed build's accounts from looking
 * lost after a rename, so it must not depend on package.json. `--user-data-dir`
 * is Electron's own profile switch and has to keep winning, but such a run must
 * not inherit another profile's legacy data.
 *
 * Pure unit test: no Electron, no filesystem.
 *
 * Run with:  npm test
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { resolveStateDirs, explicitUserDataDir, APP_STATE_DIR_NAME } = require('../state-dirs.cjs');

const APPDATA = 'C:\\Users\\tester\\AppData\\Roaming';

describe('the application-data directory is pinned by value', () => {
  test('a normal launch resolves to %APPDATA%\\IS King Panel', () => {
    const dirs = resolveStateDirs({ appData: APPDATA, argv: ['IS King Panel.exe'] });
    assert.equal(dirs.stateDir, path.join(APPDATA, APP_STATE_DIR_NAME));
    assert.equal(dirs.pinned, true);
    assert.equal(dirs.explicit, false);
  });

  test('the pin does not depend on package.json or the product name', () => {
    // Nothing about the incoming appData can change the leaf directory name.
    const a = resolveStateDirs({ appData: APPDATA });
    const b = resolveStateDirs({ appData: 'D:\\Profiles\\other' });
    assert.equal(path.basename(a.stateDir), 'IS King Panel');
    assert.equal(path.basename(b.stateDir), 'IS King Panel');
  });

  test('the pre-pin directory is offered as the legacy source', () => {
    const dirs = resolveStateDirs({ appData: APPDATA });
    assert.deepEqual(dirs.legacyStateDirs, [path.join(APPDATA, 'react-example')]);
  });

  test('appData is required rather than silently defaulting', () => {
    assert.throws(() => resolveStateDirs({}), /appData is required/);
  });
});

describe('an explicit --user-data-dir is honoured', () => {
  test('--user-data-dir=<path> wins over the pin', () => {
    const dirs = resolveStateDirs({
      appData: APPDATA,
      argv: ['IS King Panel.exe', '--user-data-dir=C:\\temp\\isolated-profile'],
    });
    assert.equal(dirs.stateDir, path.resolve('C:\\temp\\isolated-profile'));
    assert.equal(dirs.pinned, false);
    assert.equal(dirs.explicit, true);
  });

  test('--user-data-dir <path> is accepted too', () => {
    const dirs = resolveStateDirs({
      appData: APPDATA,
      argv: ['IS King Panel.exe', '--user-data-dir', 'C:\\temp\\spaced'],
    });
    assert.equal(dirs.stateDir, path.resolve('C:\\temp\\spaced'));
  });

  test('the value Electron parsed is authoritative', () => {
    const dirs = resolveStateDirs({
      appData: APPDATA,
      argv: [],
      switchValue: 'C:\\temp\\from-command-line',
    });
    assert.equal(dirs.stateDir, path.resolve('C:\\temp\\from-command-line'));
  });

  test('an explicit profile does not inherit legacy directories', () => {
    const dirs = resolveStateDirs({
      appData: APPDATA,
      argv: ['--user-data-dir=C:\\temp\\isolated-profile'],
    });
    // A test or secondary profile must not pull in the real user's data.
    assert.deepEqual(dirs.legacyStateDirs, []);
  });

  test('a switch with no value falls back to the pin', () => {
    assert.equal(explicitUserDataDir({ argv: ['--user-data-dir'] }), '');
    assert.equal(explicitUserDataDir({ argv: ['--user-data-dir', '--no-sandbox'] }), '');
    const dirs = resolveStateDirs({ appData: APPDATA, argv: ['--user-data-dir'] });
    assert.equal(dirs.pinned, true);
  });
});
