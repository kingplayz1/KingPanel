/**
 * Release gate — failure injection.
 *
 * A release gate is only worth having if it actually stops a bad release, so
 * each test builds a *valid* artifact set and then breaks exactly one thing the
 * way the real world breaks it: a version bump that never landed, an upload that
 * dropped the blockmap, a manifest that describes a deleted installer, a stale
 * installer from the previous version sitting in the output directory.
 *
 * Run with:  npm test
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import yaml from 'js-yaml';
import { verifyArtifacts, verifyPackagedRuntime, verifyTag } from '../scripts/release-verify.mjs';

const VERSION = '1.2.3';
const INSTALLER = `IS-King-Panel-Setup-${VERSION}.exe`;
const BLOCKMAP = `${INSTALLER}.blockmap`;
const LATEST = 'latest.yml';

const pkg = {
  name: 'react-example',
  version: VERSION,
  build: {
    productName: 'IS King Panel',
    win: { artifactName: 'IS-King-Panel-Setup-${version}.${ext}' },
  },
};

let workRoot;

function freshDir() {
  return fs.mkdtempSync(path.join(workRoot, 'release-'));
}

/**
 * Write a valid release into `dir`. `overrides` mutate the pieces afterwards, so
 * each test states the one thing it breaks.
 */
function makeRelease(dir, overrides = {}) {
  const installerBytes = overrides.installerBytes ?? randomBytes(2048);
  const installer = overrides.installerName ?? INSTALLER;
  fs.writeFileSync(path.join(dir, installer), installerBytes);

  const sha512 = createHash('sha512').update(installerBytes).digest('base64');
  const blockmap = overrides.blockmap ??
    gzipSync(
      Buffer.from(
        JSON.stringify({
          version: 2,
          files: [{ name: 'file', offset: 0, checksums: [sha512.slice(0, 24)] }],
        }),
      ),
    );
  fs.writeFileSync(path.join(dir, `${installer}.blockmap`), blockmap);

  const meta = {
    version: overrides.manifestVersion ?? VERSION,
    files: [
      {
        url: overrides.manifestUrl ?? installer,
        sha512: overrides.manifestSha512 ?? sha512,
        size: overrides.manifestSize ?? installerBytes.length,
      },
    ],
    path: overrides.manifestPath ?? installer,
    sha512: overrides.topLevelSha512 ?? sha512,
    releaseDate: overrides.releaseDate ?? new Date().toISOString(),
  };
  if (overrides.latestRaw !== undefined) {
    fs.writeFileSync(path.join(dir, LATEST), overrides.latestRaw);
  } else {
    fs.writeFileSync(path.join(dir, LATEST), yaml.dump(meta));
  }

  for (const name of overrides.remove ?? []) {
    fs.rmSync(path.join(dir, name), { force: true });
  }
  for (const name of overrides.extra ?? []) {
    fs.writeFileSync(path.join(dir, name), 'stale');
  }
  return dir;
}

const run = (dir, tag = `v${VERSION}`) => verifyArtifacts({ dir, pkg, tag });
const has = (problems, re) => problems.some((p) => re.test(p));

before(() => {
  workRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'isk-release-'));
});

after(() => {
  fs.rmSync(workRoot, { recursive: true, force: true });
});

describe('a complete release passes', () => {
  test('tag, artifacts, manifest and blockmap agree', async () => {
    const result = await run(makeRelease(freshDir()));
    assert.deepEqual(result.problems, []);
    assert.equal(result.installer, INSTALLER);
    assert.equal(result.version, VERSION);
    assert.ok(result.sizes.installer > 0);
  });
});

describe('tag and version', () => {
  test('a tag without the v prefix is rejected', async () => {
    const result = await run(makeRelease(freshDir()), VERSION);
    assert.ok(has(result.problems, /tag "?1\.2\.3"? is malformed/), result.problems.join('; '));
  });

  test('a tag for a version package.json never got is rejected', async () => {
    const result = await run(makeRelease(freshDir()), 'v9.9.9');
    assert.ok(has(result.problems, /does not match package\.json version 1\.2\.3/));
  });

  test('verifyTag is empty for a matching tag', () => {
    assert.deepEqual(verifyTag('v1.2.3', '1.2.3'), []);
    assert.equal(verifyTag('', '1.2.3').length, 1);
  });
});

describe('missing artifacts', () => {
  test('a missing installer stops the release', async () => {
    const result = await run(makeRelease(freshDir(), { remove: [INSTALLER] }));
    assert.ok(has(result.problems, /installer is missing or empty/));
  });

  test('a missing blockmap stops the release', async () => {
    const result = await run(makeRelease(freshDir(), { remove: [BLOCKMAP] }));
    assert.ok(has(result.problems, /blockmap is missing or empty/));
  });

  test('a missing latest.yml stops the release', async () => {
    const result = await run(makeRelease(freshDir(), { remove: [LATEST] }));
    assert.ok(has(result.problems, /latest is missing or empty/));
  });

  test('a partial set names every missing file at once', async () => {
    const result = await run(
      makeRelease(freshDir(), { remove: [BLOCKMAP, LATEST] }),
    );
    assert.equal(result.problems.filter((p) => /missing or empty/.test(p)).length, 2);
  });
});

describe('manifest disagreement', () => {
  test('a different version in latest.yml is rejected', async () => {
    const result = await run(makeRelease(freshDir(), { manifestVersion: '1.2.2' }));
    assert.ok(has(result.problems, /version 1\.2\.2 != package\.json 1\.2\.3/));
  });

  test('an installer renamed after the manifest was written is rejected', async () => {
    const dir = freshDir();
    // Renamed artifact: the manifest still points at the old name.
    fs.writeFileSync(path.join(dir, 'IS-King-Panel-Setup-old.exe'), randomBytes(64));
    const result = await run(makeRelease(dir, { extra: ['IS-King-Panel-Setup-old.exe'] }));
    // The expected installer exists, but a stray artifact sits beside it.
    assert.ok(has(result.problems, /stale artifact IS-King-Panel-Setup-old\.exe/));
  });

  test('a manifest url that names another file is rejected', async () => {
    const result = await run(makeRelease(freshDir(), { manifestUrl: 'other-installer.exe' }));
    assert.ok(has(result.problems, /files\[0\]\.url "other-installer\.exe"/));
  });

  test('a manifest path that names another file is rejected', async () => {
    const result = await run(makeRelease(freshDir(), { manifestPath: 'other-installer.exe' }));
    assert.ok(has(result.problems, /path "other-installer\.exe"/));
  });

  test('a wrong size is rejected', async () => {
    const result = await run(makeRelease(freshDir(), { manifestSize: 1 }));
    assert.ok(has(result.problems, /size 1 !=/));
  });

  test('a checksum mismatch is rejected', async () => {
    const result = await run(
      makeRelease(freshDir(), { manifestSha512: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=' }),
    );
    assert.ok(has(result.problems, /sha512 does not match/));
  });

  test('a top-level sha512 that disagrees is rejected', async () => {
    const result = await run(
      makeRelease(freshDir(), { topLevelSha512: 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB=' }),
    );
    assert.ok(has(result.problems, /top-level sha512 disagrees/));
  });

  test('a manifest with no files[] entry is rejected', async () => {
    const result = await run(
      makeRelease(freshDir(), {
        latestRaw: yaml.dump({ version: VERSION, path: INSTALLER, sha512: 'x', releaseDate: new Date().toISOString() }),
      }),
    );
    assert.ok(has(result.problems, /no files\[\] entry/));
  });

  test('a release date in the future is rejected', async () => {
    const future = new Date(Date.now() + 72 * 60 * 60 * 1000).toISOString();
    const result = await run(makeRelease(freshDir(), { releaseDate: future }));
    assert.ok(has(result.problems, /is in the future/));
  });

  test('unreadable YAML is rejected rather than guessed at', async () => {
    const result = await run(makeRelease(freshDir(), { latestRaw: 'version: [unclosed\n' }));
    assert.ok(has(result.problems, /not readable YAML/));
  });
});

describe('blockmap', () => {
  test('a blockmap that is not gzip JSON is rejected', async () => {
    const result = await run(
      makeRelease(freshDir(), { blockmap: Buffer.from('this is not a blockmap') }),
    );
    assert.ok(has(result.problems, /not a readable blockmap/));
  });

  test('a blockmap with no checksums is rejected', async () => {
    const empty = gzipSync(Buffer.from(JSON.stringify({ version: 2, files: [{ name: 'file', offset: 0, checksums: [] }] })));
    const result = await run(makeRelease(freshDir(), { blockmap: empty }));
    assert.ok(has(result.problems, /no block checksums/));
  });
});

describe('packaged runtime', () => {
  const pin = { sha256: createHash('sha256').update('pinned-bytes').digest('hex') };

  function makeResources({ runtimeBytes = Buffer.from('pinned-bytes'), mutate } = {}) {
    const dir = freshDir();
    const resources = path.join(dir, 'resources');
    fs.mkdirSync(path.join(resources, 'runtime'), { recursive: true });
    fs.mkdirSync(path.join(resources, 'app.asar.unpacked'), { recursive: true });
    fs.writeFileSync(path.join(resources, 'runtime', 'node.exe'), runtimeBytes);
    fs.writeFileSync(path.join(resources, 'runtime', 'LICENSE'), 'Node.js licence');
    fs.writeFileSync(path.join(resources, 'app.asar.unpacked', 'server.cjs'), '// backend');
    fs.writeFileSync(path.join(resources, 'app-update.yml'), 'provider: github\n');
    const manifestPath = path.join(dir, 'runtime.json');
    fs.writeFileSync(manifestPath, JSON.stringify(pin));
    if (mutate) mutate(resources);
    return { resources, manifestPath };
  }

  test('a correct package has no problems', () => {
    const { resources, manifestPath } = makeResources();
    assert.deepEqual(verifyPackagedRuntime({ resourcesDir: resources, manifestPath }), []);
  });

  test('a missing runtime is reported', () => {
    const { resources, manifestPath } = makeResources({
      mutate: (r) => fs.rmSync(path.join(r, 'runtime', 'node.exe')),
    });
    assert.ok(has(verifyPackagedRuntime({ resourcesDir: resources, manifestPath }), /carries no runtime/));
  });

  test('a runtime that is not the pinned binary is reported', () => {
    const { resources, manifestPath } = makeResources({ runtimeBytes: Buffer.from('tampered') });
    assert.ok(has(verifyPackagedRuntime({ resourcesDir: resources, manifestPath }), /not the pinned build/));
  });

  test('a missing licence is reported', () => {
    const { resources, manifestPath } = makeResources({
      mutate: (r) => fs.rmSync(path.join(r, 'runtime', 'LICENSE')),
    });
    assert.ok(has(verifyPackagedRuntime({ resourcesDir: resources, manifestPath }), /without its Node\.js licence/));
  });

  test('a duplicated runtime inside the asar is reported', () => {
    const { resources, manifestPath } = makeResources({
      mutate: (r) => fs.mkdirSync(path.join(r, 'app.asar.unpacked', 'runtime'), { recursive: true }),
    });
    assert.ok(has(verifyPackagedRuntime({ resourcesDir: resources, manifestPath }), /duplicated/));
  });

  test('a missing backend bundle is reported', () => {
    const { resources, manifestPath } = makeResources({
      mutate: (r) => fs.rmSync(path.join(r, 'app.asar.unpacked', 'server.cjs')),
    });
    assert.ok(has(verifyPackagedRuntime({ resourcesDir: resources, manifestPath }), /server\.cjs\) is missing/));
  });

  test('a missing app-update.yml is reported', () => {
    const { resources, manifestPath } = makeResources({
      mutate: (r) => fs.rmSync(path.join(r, 'app-update.yml')),
    });
    assert.ok(has(verifyPackagedRuntime({ resourcesDir: resources, manifestPath }), /app-update\.yml is missing/));
  });
});
