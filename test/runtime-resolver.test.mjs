/**
 * Backend runtime selection.
 *
 * The bug this guards against: the app used to spawn whatever `node` it could
 * find and say nothing, so on a machine without Node the panel started and every
 * account call failed. The resolver must prove a runtime before using it, and
 * must fail with the list of what it tried when nothing qualifies.
 *
 * Run with:  npm test
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  parseNodeVersion,
  versionAtLeast,
  buildCandidates,
  resolveBackendRuntime,
  probeRuntime,
  MIN_VERSION,
} = require('../runtime-resolver.cjs');

describe('version parsing', () => {
  test('parses the versions Node prints', () => {
    assert.deepEqual(parseNodeVersion('v22.5.0'), [22, 5, 0]);
    assert.deepEqual(parseNodeVersion('22.11.1'), [22, 11, 1]);
    assert.equal(parseNodeVersion('not-a-version'), null);
  });

  test('22.5 is the floor', () => {
    assert.deepEqual(MIN_VERSION, [22, 5]);
    assert.equal(versionAtLeast('v22.5.0', MIN_VERSION), true);
    assert.equal(versionAtLeast('v22.4.9', MIN_VERSION), false);
    assert.equal(versionAtLeast('v20.18.0', MIN_VERSION), false);
    assert.equal(versionAtLeast('v24.0.0', MIN_VERSION), true);
    assert.equal(versionAtLeast(null, MIN_VERSION), false);
  });
});

describe('candidate ordering', () => {
  test('packaged: the explicit override first, then only the bundled runtime', () => {
    const candidates = buildCandidates({
      packaged: true,
      resourcesPath: 'C:\\Program Files\\IS King Panel\\resources',
      appDir: 'C:\\app',
      env: { ISK_NODE_PATH: 'D:\\nodejs\\node.exe', ProgramFiles: 'C:\\Program Files' },
      execPath: 'C:\\Program Files\\IS King Panel\\IS King Panel.exe',
      platform: 'win32',
      exists: () => true,
    });
    assert.deepEqual(candidates.map((c) => c.source), ['ISK_NODE_PATH', 'bundled']);
    assert.equal(candidates[0].required, true);
  });

  test('packaged: a system Node or Electron is never a substitute', () => {
    // Both exist on this machine; neither may be used by an installed build.
    const candidates = buildCandidates({
      packaged: true,
      resourcesPath: 'C:\\res',
      env: { ProgramFiles: 'C:\\Program Files' },
      execPath: 'C:\\res\\..\\IS King Panel.exe',
      platform: 'win32',
      exists: () => true,
    });
    assert.deepEqual(candidates.map((c) => c.source), ['bundled']);
  });

  test('packaged: a missing bundled runtime leaves nothing to try', () => {
    const candidates = buildCandidates({
      packaged: true,
      resourcesPath: 'res',
      env: {},
      execPath: 'electron.exe',
      platform: 'win32',
      exists: () => false,
    });
    assert.deepEqual(candidates, []);
  });

  test('the bundled path lives under resources when packaged', () => {
    const [bundled] = buildCandidates({
      packaged: true,
      resourcesPath: path.join('C:', 'res'),
      env: {},
      execPath: 'electron.exe',
      platform: 'win32',
      exists: () => true,
    }).filter((c) => c.source === 'bundled');
    assert.equal(bundled.command, path.join('C:', 'res', 'runtime', 'node.exe'));
  });

  test('a runtime path containing spaces is passed through unchanged', () => {
    const resources = path.join('C:', 'Program Files', 'IS King Panel', 'resources');
    const [bundled] = buildCandidates({
      packaged: true,
      resourcesPath: resources,
      env: {},
      execPath: 'electron.exe',
      platform: 'win32',
      exists: () => true,
    }).filter((c) => c.source === 'bundled');
    assert.equal(bundled.command, path.join(resources, 'runtime', 'node.exe'));
    // No shell, no quoting: spawnSync receives the path as one argument.
    assert.equal(bundled.command.includes('"'), false);
    assert.deepEqual(bundled.args, []);
  });

  test('development keeps the wider search', () => {
    const sources = buildCandidates({
      packaged: false,
      appDir: 'C:\\app',
      env: { ProgramFiles: 'C:\\Program Files' },
      execPath: 'electron.exe',
      platform: 'win32',
      exists: () => true,
    }).map((c) => c.source);
    assert.deepEqual(sources, ['bundled', 'electron', 'system', 'path']);
  });

  test('the Electron candidate runs as plain Node', () => {
    const electron = buildCandidates({
      env: {},
      execPath: 'electron.exe',
      platform: 'win32',
      exists: () => false,
    }).find((c) => c.source === 'electron');
    assert.deepEqual(electron.env, { ELECTRON_RUN_AS_NODE: '1' });
  });
});

describe('resolution', () => {
  test('the first passing candidate wins', () => {
    const seen = [];
    const result = resolveBackendRuntime(
      {
        env: { ISK_NODE_PATH: 'first.exe' },
        execPath: 'electron.exe',
        platform: 'win32',
        exists: () => false,
      },
      (command) => {
        seen.push(command);
        return command === 'first.exe'
          ? { ok: true, version: '22.5.0' }
          : { ok: false, version: '20.18.0', reason: 'node:sqlite unavailable' };
      }
    );
    assert.equal(result.ok, true);
    assert.equal(result.source, 'ISK_NODE_PATH');
    assert.equal(result.command, 'first.exe');
    assert.deepEqual(seen, ['first.exe']);
  });

  test('a packaged install with no bundled runtime reports zero attempts', () => {
    const result = resolveBackendRuntime(
      { packaged: true, resourcesPath: 'C:\\res', env: {}, execPath: 'x.exe', platform: 'win32', exists: () => false },
      () => ({ ok: false, version: null, reason: 'should not be probed' })
    );
    assert.equal(result.ok, false);
    assert.deepEqual(result.attempts, []);
  });

  test('when nothing qualifies it reports every attempt', () => {
    const result = resolveBackendRuntime(
      { env: {}, execPath: 'electron.exe', platform: 'win32', exists: () => false },
      () => ({ ok: false, version: '20.18.0', reason: 'node:sqlite unavailable' })
    );
    assert.equal(result.ok, false);
    assert.ok(result.attempts.length >= 2);
    for (const attempt of result.attempts) {
      assert.equal(attempt.reason, 'node:sqlite unavailable');
      assert.equal(attempt.version, '20.18.0');
    }
  });

  test('a bundled runtime that fails the probe is not replaced by a system one', () => {
    const probed = [];
    const result = resolveBackendRuntime(
      {
        packaged: true,
        resourcesPath: path.join('C:', 'res'),
        env: { ProgramFiles: 'C:\\Program Files' },
        execPath: 'IS King Panel.exe',
        platform: 'win32',
        exists: () => true,
      },
      (command) => {
        probed.push(command);
        return { ok: false, version: '22.4.0', reason: 'older than 22.5' };
      }
    );
    assert.equal(result.ok, false);
    assert.deepEqual(result.attempts.map((a) => a.source), ['bundled']);
    assert.deepEqual(probed, [path.join('C:', 'res', 'runtime', 'node.exe')]);
  });

  test('a runtime that cannot start does not abort the search', () => {
    const result = resolveBackendRuntime(
      { env: {}, execPath: 'electron.exe', platform: 'win32', exists: () => false },
      (command) =>
        command === 'electron.exe'
          ? { ok: true, version: '22.9.0' }
          : { ok: false, version: null, reason: 'spawn ENOENT' }
    );
    assert.equal(result.ok, true);
    assert.equal(result.source, 'electron');
  });
});

describe('the real probe', () => {
  test('this machine\u2019s node passes (it is what the tests run on)', () => {
    const result = probeRuntime(process.execPath);
    assert.equal(result.ok, true, result.reason);
    assert.equal(versionAtLeast(result.version, MIN_VERSION), true);
  });

  test('a command that does not exist fails with a reason, not a throw', () => {
    const result = probeRuntime(path.join('definitely', 'not', 'a', 'runtime'));
    assert.equal(result.ok, false);
    assert.ok(result.reason);
  });
});
