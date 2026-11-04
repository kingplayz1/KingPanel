/**
 * Chooses the Node runtime that hosts the bundled backend (server.cjs).
 *
 * The backend opens SQLite through `node:sqlite`, which needs Node >= 22.5.
 * Electron's own Node is 20.18 in this build, so `ELECTRON_RUN_AS_NODE` cannot
 * host it yet; the previous code silently fell back to whatever `node` happened
 * to be on PATH, and a machine without Node produced a running app whose every
 * account call answered 500/503.
 *
 * This resolver tries candidates in a fixed order and *proves* each one before
 * using it: the runtime must start, report a Node version >= 22.5 and load
 * `node:sqlite`. The first that passes wins; if none does, the caller reports a
 * clear, actionable failure instead of launching a backend that cannot work.
 *
 * Order in a packaged install (no system dependency at all):
 *   1. ISK_NODE_PATH        — explicit operator override, for support only
 *   2. runtime/node.exe     — the runtime shipped in the installer
 *
 * A packaged build deliberately stops there. It must not fall back to a user's
 * PATH or to a system Node: those make the app work on the developer's machine
 * and fail on a clean one, which is the bug this resolver exists to prevent.
 * If the bundled runtime is missing, the install itself is incomplete and the
 * caller says so.
 *
 * In development the search is wider, because the checkout has no bundled
 * runtime: Electron's own Node (if it is new enough), then a system Node.
 */
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const MIN_VERSION = [22, 5];

/** "v22.5.0" -> [22, 5, 0]; null when it is not a version string. */
function parseNodeVersion(value) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(value || '').trim());
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function versionAtLeast(version, minimum) {
  const parsed = Array.isArray(version) ? version : parseNodeVersion(version);
  if (!parsed) return false;
  if (parsed[0] !== minimum[0]) return parsed[0] > minimum[0];
  return parsed[1] >= minimum[1];
}

/**
 * Ask a candidate to load `node:sqlite`. Returns
 * `{ ok, version, reason }`; never throws.
 */
function probeRuntime(command, args = [], env = {}, timeoutMs = 20000) {
  const script =
    "try{const s=require('node:sqlite');" +
    "if(typeof s.DatabaseSync!=='function')throw new Error('DatabaseSync missing');" +
    "process.stdout.write(JSON.stringify({ok:true,version:process.versions.node}))}" +
    "catch(e){process.stdout.write(JSON.stringify({ok:false,version:process.versions.node,reason:String(e&&e.message)}))}";
  let result;
  try {
    result = spawnSync(command, [...args, '-e', script], {
      env: { ...process.env, ...env },
      encoding: 'utf8',
      timeout: timeoutMs,
      windowsHide: true,
    });
  } catch (err) {
    return { ok: false, version: null, reason: err && err.message ? err.message : String(err) };
  }
  if (result.error) {
    return { ok: false, version: null, reason: result.error.message };
  }
  if (result.status !== 0) {
    return {
      ok: false,
      version: null,
      reason: (result.stderr || result.stdout || `exited with ${result.status}`).trim().slice(0, 300),
    };
  }
  let parsed;
  try {
    parsed = JSON.parse(String(result.stdout || '').trim());
  } catch {
    return { ok: false, version: null, reason: 'the runtime did not answer the probe' };
  }
  if (!parsed.ok) {
    return { ok: false, version: parsed.version || null, reason: parsed.reason || 'node:sqlite unavailable' };
  }
  if (!versionAtLeast(parsed.version, MIN_VERSION)) {
    return { ok: false, version: parsed.version, reason: `Node ${parsed.version} is older than 22.5` };
  }
  return { ok: true, version: parsed.version };
}

/**
 * Build the candidate list for this environment. Exposed separately so a test
 * can assert the order and the conditions without spawning anything.
 */
function buildCandidates({
  packaged = false,
  resourcesPath = '',
  appDir = '',
  env = process.env,
  execPath = process.execPath,
  platform = process.platform,
  exists = fs.existsSync,
} = {}) {
  const exe = platform === 'win32' ? 'node.exe' : 'node';
  const candidates = [];

  if (env.ISK_NODE_PATH) {
    candidates.push({ source: 'ISK_NODE_PATH', command: env.ISK_NODE_PATH, args: [], env: {}, required: true });
  }

  const bundled = packaged
    ? path.join(resourcesPath || '', 'runtime', exe)
    : path.join(appDir || '', 'runtime', exe);
  const bundledExists = Boolean(bundled) && exists(bundled);
  if (bundledExists) {
    candidates.push({ source: 'bundled', command: bundled, args: [], env: {}, required: false });
  }

  // Packaged: the bundled runtime or nothing. A missing file is an incomplete
  // install, not an invitation to borrow whatever happens to be on the machine.
  if (packaged) return candidates;

  // Electron can run as plain Node, but only when its Node is new enough.
  if (execPath) {
    candidates.push({
      source: 'electron',
      command: execPath,
      args: [],
      env: { ELECTRON_RUN_AS_NODE: '1' },
      required: false,
    });
  }

  if (platform === 'win32') {
    const programFiles = env.ProgramFiles || 'C:\\Program Files';
    const systemNode = path.join(programFiles, 'nodejs', exe);
    if (exists(systemNode)) {
      candidates.push({ source: 'system', command: systemNode, args: [], env: {}, required: false });
    }
  }
  candidates.push({ source: 'path', command: exe, args: [], env: {}, required: false });

  return candidates;
}

/**
 * Pick the first candidate that passes the probe.
 * Returns `{ ok: true, command, args, env, source, version }`
 *      or `{ ok: false, attempts: [{ source, reason }] }`.
 */
function resolveBackendRuntime(options = {}, probe = probeRuntime) {
  const candidates = buildCandidates(options);
  const attempts = [];
  for (const candidate of candidates) {
    const outcome = probe(candidate.command, candidate.args, candidate.env);
    attempts.push({ source: candidate.source, version: outcome.version, reason: outcome.ok ? null : outcome.reason });
    if (outcome.ok) {
      return {
        ok: true,
        command: candidate.command,
        args: candidate.args,
        env: candidate.env,
        source: candidate.source,
        version: outcome.version,
      };
    }
  }
  return { ok: false, attempts };
}

module.exports = {
  MIN_VERSION,
  parseNodeVersion,
  versionAtLeast,
  probeRuntime,
  buildCandidates,
  resolveBackendRuntime,
};
