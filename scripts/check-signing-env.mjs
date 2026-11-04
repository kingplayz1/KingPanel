#!/usr/bin/env node
/**
 * Preflight for signing credentials — CI and local.
 *
 * The release workflow runs this before it builds anything, so a missing or
 * half-configured signer costs seconds instead of a 130 MB build. It prints which
 * provider is selected, which credential *names* are missing, and the pinned
 * publisher; never a credential value.
 *
 * Exit codes: 0 when the configuration is complete (or when signing is optional
 * and simply not configured), 1 otherwise.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { signingConfig, PROVIDERS } from './signing.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function cliResolvable(command) {
  const probe = process.platform === 'win32' ? 'where' : 'which';
  const result = spawnSync(probe, [command], { encoding: 'utf8', windowsHide: true });
  return !result.error && result.status === 0;
}

function main() {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const policy = pkg.iskSigning ?? {};
  const config = signingConfig(process.env, { expectedPublisher: policy.expectedPublisher });
  const problems = [...config.problems];

  console.log(`[signing] provider: ${config.provider.label} (${config.method})`);
  if (config.method === 'esigner') {
    console.log(
      `[signing] eSigner environment: ${process.env.ESIGNER_SANDBOX === '1' ? 'TEST (sandbox)' : 'PROD'}` +
        ` (ENVIRONMENT_NAME), CLI: ${String(process.env.ESIGNER_CLI ?? '').trim() || 'CodeSignTool.bat'}`,
    );
  }
  console.log(`[signing] expected publisher: ${config.expectedPublisher || '(not pinned)'}`);
  console.log(`[signing] hash algorithm: ${config.hashAlgorithm}, timestamp: ${config.timestampServer}`);

  if (config.method === 'esigner') {
    const cli = String(process.env.ESIGNER_CLI ?? '').trim() || 'CodeSignTool.bat';
    if (!cliResolvable(cli)) {
      problems.push(
        `the eSigner CLI "${cli}" is not on PATH; install SSL.com CodeSignTool on the runner and ` +
          'set ESIGNER_CLI to its entry point',
      );
    }
  }

  if (problems.length) {
    console.error('[signing] FAILED — signing is not ready:');
    for (const problem of problems) console.error(`  - ${problem}`);
    if (config.method === 'none') {
      console.error(
        `[signing] supported providers: ${Object.values(PROVIDERS)
          .map((provider) => `${provider.id} (${provider.credentialVars.join(', ')})`)
          .join('; ')}`,
      );
    }
    process.exit(1);
  }

  console.log(
    config.configured
      ? '[signing] OK  credentials present (values not printed)'
      : '[signing] OK  no signer configured and ISK_REQUIRE_SIGNING is not set — this build will be unsigned',
  );
}

main();
