#!/usr/bin/env node
/**
 * Cloud signing adapter: sign one Windows executable without a private key.
 *
 * Since June 2023 a publicly trusted code-signing key cannot leave a FIPS 140-2
 * Level 2 / CC EAL4+ module, so no CA issues a PFX that a hosted runner could
 * import. The signer is therefore an external service: this module shells out to
 * SSL.com's `CodeSignTool` (the eSigner CLI), which keeps the key in SSL.com's
 * HSM and returns a signed copy of the file.
 *
 * Rules this file exists to enforce:
 *
 *  - credentials come from the environment only, and are never printed: the
 *    child's output is redacted before it reaches any log;
 *  - the child is spawned with an argument array, never a shell string, so a
 *    path or a credential cannot inject a command;
 *  - a missing CLI, a non-zero exit, a missing signature, the wrong publisher, a
 *    missing timestamp or a digest other than SHA-256 fails the build loudly;
 *  - without configured credentials it refuses to run at all, so a release cannot
 *    quietly ship an unsigned installer.
 *
 * Usage (also the electron-builder `win.signtoolOptions.sign` hook):
 *   node scripts/cloud-sign.mjs --file "dist_electron/win-unpacked/IS King Panel.exe"
 *
 * Environment:
 *   ISK_SIGN_PROVIDER=esigner
 *   ESIGNER_USERNAME, ESIGNER_PASSWORD, ESIGNER_TOTP_SECRET, ESIGNER_CREDENTIAL_ID
 *   ESIGNER_CLI          path to CodeSignTool.bat (default: found on PATH)
 *   ESIGNER_SANDBOX=1    run against SSL.com's sandbox (sets ENVIRONMENT_NAME=TEST)
 *
 * What this adapter deliberately does not do, because CodeSignTool cannot:
 *  - choose the timestamp authority or the digest. `sign` always timestamps; the
 *    TSA is `TSA_URL` in conf/code_sign_tool.properties (http://ts.ssl.com by
 *    default) and there is no hash flag. The signature is therefore *verified*
 *    here after signing, and a SHA-1 or untimestamped result fails the build.
 *  - sign without `-output_dir_path`. Without it the tool overwrites the input
 *    and prompts first, which would hang a CI job, so a temporary directory is
 *    always passed and the result copied back.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PROVIDERS,
  checkSignature,
  digestPolicy,
  readDigests,
  readSignature,
  resolveProvider,
  signingConfig,
} from './signing.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Redact every configured credential value from a string before it is printed. */
export function redact(text, env = process.env) {
  let out = String(text ?? '');
  for (const name of PROVIDERS.esigner.credentialVars) {
    const value = String(env[name] ?? '').trim();
    if (value.length >= 3) out = out.split(value).join('[redacted]');
  }
  return out;
}

function esignerCli(env) {
  const configured = String(env.ESIGNER_CLI ?? '').trim();
  // One entry point on every platform: the Windows download bundles its own JRE
  // and the supported invocation is the .bat wrapper.
  return configured || 'CodeSignTool.bat';
}

/**
 * Environment for the child process.
 *
 * SSL.com selects its endpoint with ENVIRONMENT_NAME, which is why the sandbox is
 * a variable here rather than a different executable. The generic
 * USERNAME/PASSWORD variables the tool also reads are deliberately not set: every
 * credential is passed as an explicit flag, so a runner's own variables can never
 * be mistaken for a signing account.
 */
export function esignerEnv(env = process.env) {
  return { ...env, ENVIRONMENT_NAME: env.ESIGNER_SANDBOX === '1' ? 'TEST' : 'PROD' };
}

/**
 * Arguments for one signing run. Credentials are passed as `-flag=value`, which is
 * the CLI's only supported interface; they are never echoed by this module.
 *
 * No `-override`: the output directory is always fresh, so there is nothing to
 * overwrite, and the flag is documented as a global option rather than part of
 * the `sign` synopsis.
 */
export function esignerArgs({ file, outputDir, env = process.env }) {
  return [
    'sign',
    `-username=${env.ESIGNER_USERNAME}`,
    `-password=${env.ESIGNER_PASSWORD}`,
    `-totp_secret=${env.ESIGNER_TOTP_SECRET}`,
    `-credential_id=${env.ESIGNER_CREDENTIAL_ID}`,
    `-input_file_path=${file}`,
    `-output_dir_path=${outputDir}`,
  ];
}

const DEFAULT_RUN = (command, args, options = {}) =>
  spawnSync(command, args, {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 300_000,
    ...options,
  });

/**
 * Run the provider CLI, whether it is an executable or a `.bat`/`.cmd` wrapper.
 *
 * CodeSignTool ships as `CodeSignTool.bat`, and Windows cannot execute a batch
 * file through CreateProcess: it has to go through the command interpreter. Each
 * argument is quoted here (paths contain spaces) and passed with
 * `windowsVerbatimArguments`, so the quoting is ours rather than Node's.
 */
export function runSigner(cli, args, { run = DEFAULT_RUN, env = process.env } = {}) {
  // CodeSignTool reads `./conf/code_sign_tool.properties` from the *working
  // directory*, not from its own location, and falls back to a relative
  // `jdk-11.0.2\bin\java`. Running it from anywhere else fails with
  // FileNotFoundException before a single request is made, so the signer always
  // runs in its own directory. Every path passed to it is absolute.
  const cwd = /[\\/]/.test(cli) ? path.dirname(cli) : undefined;
  const options = { env, ...(cwd ? { cwd } : {}) };
  if (!/\.(bat|cmd)$/i.test(cli)) return run(cli, args, options);

  const comspec = env.ComSpec || env.COMSPEC || 'cmd.exe';
  const quoted = [cli, ...args]
    .map((value) => `"${String(value).replace(/"/g, '""')}"`)
    .join(' ');
  // cmd /s /c needs the whole command wrapped in one more pair of quotes.
  return run(comspec, ['/d', '/s', '/c', `"${quoted}"`], {
    ...options,
    windowsVerbatimArguments: true,
  });
}

/**
 * Sign one file in place.
 *
 * @param {string} file absolute path to the executable
 * @param {{env?: object, run?: Function, log?: Function}} options
 */
export function signWithProvider(file, { env = process.env, run = DEFAULT_RUN, log = console.log } = {}) {
  const provider = resolveProvider(env);
  const config = signingConfig(env, { expectedPublisher: '' });

  if (provider.problems.length) {
    throw new Error(`signing configuration is invalid:\n  - ${provider.problems.join('\n  - ')}`);
  }
  if (provider.id !== 'esigner') {
    throw new Error(
      `cloud-sign requires ${'ISK_SIGN_PROVIDER=esigner'}; configured provider is "${provider.id}". ` +
        'A PFX build is signed by electron-builder itself and does not use this adapter.',
    );
  }
  if (!fs.existsSync(file)) throw new Error(`cannot sign a file that does not exist: ${file}`);

  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'isk-esigner-'));
  const cli = esignerCli(env);
  let result;
  try {
    result = runSigner(cli, esignerArgs({ file, outputDir, env }), { run, env: esignerEnv(env) });
  } finally {
    // The temporary directory only ever held a signed copy, but leaving it
    // behind would accumulate 130 MB installers in %TEMP%.
    setTimeout(() => fs.rmSync(outputDir, { recursive: true, force: true }), 0);
  }

  if (result.error) {
    throw new Error(
      `could not run the eSigner CLI "${cli}": ${redact(result.error.message, env)}. ` +
        'Set ESIGNER_CLI to the CodeSignTool entry point.',
    );
  }
  if (result.status !== 0) {
    const detail = redact(String(result.stderr || result.stdout || '').trim(), env).slice(-1200);
    throw new Error(`eSigner CLI exited with ${result.status} while signing ${path.basename(file)}${detail ? `:\n${detail}` : ''}`);
  }

  const signed = path.join(outputDir, path.basename(file));
  if (!fs.existsSync(signed)) {
    throw new Error(
      `the eSigner CLI reported success but wrote no signed file for ${path.basename(file)}; ` +
        `expected ${path.basename(signed)} in ${outputDir}`,
    );
  }
  fs.copyFileSync(signed, file);

  // A cloud signature is only as good as what came back: verify it here, where
  // the failure names the file, rather than later in a release gate that reports
  // the whole build as unsigned.
  const report = readSignature(file, { run });
  const problems = checkSignature({
    label: path.basename(file),
    report,
    expectedPublisher: config.expectedPublisher || undefined,
    requireSigned: true,
    requireTimestamp: true,
  });
  const digests = readDigests(file, { run });
  problems.push(...digestPolicy({ label: path.basename(file), ...digests }));
  if (problems.length) {
    throw new Error(`the eSigner signature is not acceptable:\n  - ${problems.join('\n  - ')}`);
  }

  log(`[signing] signed ${path.basename(file)} — ${report.publisher}, timestamped, SHA256`);
}

function main() {
  const index = process.argv.indexOf('--file');
  const file = index === -1 ? null : process.argv[index + 1];
  if (!file) {
    console.error('usage: node scripts/cloud-sign.mjs --file <path-to-exe>');
    process.exit(2);
  }
  try {
    signWithProvider(path.resolve(ROOT, file), { env: process.env });
  } catch (err) {
    console.error(`[signing] FAILED: ${redact(err instanceof Error ? err.message : err)}`);
    process.exit(1);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
