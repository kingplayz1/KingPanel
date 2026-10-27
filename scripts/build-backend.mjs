#!/usr/bin/env node
/**
 * Builds the packaged backend (server.cjs) from server.ts.
 *
 * Electron spawns this bundle with the system Node.js binary, so it must be a
 * self-contained CommonJS file. Bundling used to be an ad-hoc `npx esbuild`
 * command that lived only in an editor settings file, which is why packaged
 * builds could ship a backend older than the source they claimed to contain.
 *
 * Run: npm run build:backend   (also invoked by npm run electron:build)
 */
import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENTRY = path.join(ROOT, 'server.ts');
const OUTFILE = path.join(ROOT, 'server.cjs');

/**
 * Resolved at runtime rather than inlined:
 * - electron / electron-* only exist inside the Electron runtime.
 * - Native or optional drivers are loaded by name when a feature is used, so
 *   bundling them would either break (`*.node` bindings) or bloat the bundle.
 * Everything else (express, mongodb, mysql2, dotenv) is inlined, matching the
 * shape of the bundle that has been shipping until now.
 */
export const EXTERNAL = [
  'electron',
  'electron-updater',
  'electron-log',
  'better-sqlite3',
  'sqlite3',
  'sqlite',
];

/** Marker the entry point prints once the Express app is listening. */
export const ENTRY_MARKER = 'KingPanel Server running on http://0.0.0.0:';

async function main() {
  const startedAt = Date.now();

  await build({
    entryPoints: [ENTRY],
    outfile: OUTFILE,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    // The backend talks to `node:sqlite` (Node >= 22.5) via a dynamic require,
    // and is executed by the installed system Node instead of Electron's.
    target: 'node22',
    external: EXTERNAL,
    sourcemap: false,
    logLevel: 'warning',
  });

  const { size } = await stat(OUTFILE);
  const bytes = await readFile(OUTFILE);
  const sha256 = createHash('sha256').update(bytes).digest('hex');

  if (size < 1024 * 1024) {
    throw new Error(
      `server.cjs is only ${size} bytes — bundling likely dropped the entry point.`,
    );
  }
  if (!bytes.includes(ENTRY_MARKER)) {
    throw new Error(
      'server.cjs does not contain the startup banner from server.ts, so the ' +
        'bundle does not reflect the current source.',
    );
  }

  console.log(
    `[backend] server.cjs  ${(size / 1024 / 1024).toFixed(2)} MB  ` +
      `sha256=${sha256.slice(0, 16)}…  ${Date.now() - startedAt}ms`,
  );
}

// Only build when executed directly: build-release.mjs imports EXTERNAL and
// ENTRY_MARKER from this module, and an import must not trigger a build.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error('[backend] build failed:', err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
