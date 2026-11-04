/**
 * Where the application keeps its per-user state.
 *
 * `userData` is an identity, not a detail: it holds the account database, so a
 * directory that moves is indistinguishable from data loss. Electron derives it
 * from package.json's `name` (still the template's "react-example"), so the real
 * path is pinned here by value instead.
 *
 * Two rules:
 *
 *  1. A normal launch always lands in `%APPDATA%\IS King Panel`. Renaming the
 *     package, the product or the executable cannot move it.
 *  2. An explicit `--user-data-dir` wins, and disables legacy scanning. That is
 *     Electron's own switch: the upgrade test uses it to keep a throwaway profile
 *     out of the real one, and a user who wants a second profile keeps that
 *     ability. Inheriting another profile's data in that case would defeat the
 *     point, so `legacyStateDirs` is empty when the switch is present.
 *
 * Pure on purpose — no electron import — so the resolution can be unit tested.
 */
const path = require('path');

/** The permanent directory name. Never derive this from package.json. */
const APP_STATE_DIR_NAME = 'IS King Panel';
/** Where every build before the pin actually wrote its data. */
const LEGACY_STATE_DIR_NAMES = ['react-example'];
const SWITCH = 'user-data-dir';

/**
 * Read the profile directory a caller asked for, or '' when they did not.
 *
 * Accepts both shapes Chromium accepts: `--user-data-dir=<path>` and
 * `--user-data-dir <path>`. `switchValue` is what Electron's commandLine parsed,
 * which is authoritative when present.
 */
function explicitUserDataDir({ argv = [], switchValue = '' } = {}) {
  if (switchValue) return switchValue;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = String(argv[i] ?? '');
    const prefix = arg.startsWith('--') ? '--' : arg.startsWith('-') ? '-' : '';
    if (!prefix) continue;
    const name = arg.slice(prefix.length);
    if (name === SWITCH) {
      const next = String(argv[i + 1] ?? '');
      // A following switch is not a value.
      return next && !next.startsWith('-') ? next : '';
    }
    if (name.startsWith(`${SWITCH}=`)) return name.slice(SWITCH.length + 1);
  }
  return '';
}

/**
 * Resolve the state directory and the legacy directories worth migrating from.
 *
 * `appData` is passed in rather than read from Electron so this stays testable.
 * Returns `{ stateDir, legacyStateDirs, pinned, explicit }`:
 *  - `pinned`   the directory is the app's permanent path (no override given)
 *  - `explicit` the caller named a directory
 */
function resolveStateDirs({ appData, argv = [], switchValue = '' } = {}) {
  const base = String(appData || '');
  if (!base) throw new Error('appData is required to resolve the state directory');

  const explicitDir = explicitUserDataDir({ argv, switchValue });
  if (explicitDir) {
    return {
      stateDir: path.resolve(explicitDir),
      legacyStateDirs: [],
      pinned: false,
      explicit: true,
    };
  }

  const stateDir = path.join(base, APP_STATE_DIR_NAME);
  return {
    stateDir,
    legacyStateDirs: LEGACY_STATE_DIR_NAMES.map((name) => path.join(base, name)).filter(
      (dir) => path.resolve(dir) !== path.resolve(stateDir)
    ),
    pinned: true,
    explicit: false,
  };
}

module.exports = {
  APP_STATE_DIR_NAME,
  LEGACY_STATE_DIR_NAMES,
  SWITCH,
  explicitUserDataDir,
  resolveStateDirs,
};
