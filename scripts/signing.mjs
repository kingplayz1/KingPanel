/**
 * Windows Authenticode signing: provider configuration, verification and policy.
 *
 * Signing is only worth anything if it is *verified*, so this module exists to
 * turn "electron-builder ran a signer" into facts about the shipped files: which
 * certificate, is the chain trusted, is there a timestamp, which digest, and is
 * the publisher the one this repository expects.
 *
 * Three artifacts matter and they are not all signed by the same party:
 *
 *  - `IS King Panel.exe`, the NSIS installer and its uninstaller are signed with
 *    our certificate.
 *  - `resources/runtime/node.exe` is the official Node build, already signed by
 *    the OpenJS Foundation with a timestamp. Re-signing it would discard the
 *    upstream signature and claim authorship we do not have, so the policy is to
 *    *verify* that signature instead, against the signer pinned in
 *    runtime/runtime.json.
 *
 * Two signing providers are supported (see PROVIDERS). A downloadable PFX no
 * longer exists for publicly trusted certificates (CA/B Forum, June 2023), so
 * cloud signing is the route that works on hosted CI; the contract here is
 * provider-neutral: credentials in the environment, one selected provider, and a
 * refusal to continue when the configuration is partial.
 *
 * Verification uses PowerShell's Get-AuthenticodeSignature for structured data,
 * a PowerShell PKCS#7 read for the digest algorithms, and signtool when it is
 * available for a second opinion in release mode. The runner is injectable so the
 * policy can be tested without a certificate.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/** Env var names electron-builder itself reads for the PFX provider. */
export const SIGNING_ENV = Object.freeze({
  link: 'CSC_LINK',
  password: 'CSC_KEY_PASSWORD',
  provider: 'ISK_SIGN_PROVIDER',
});

/** SHA-256 is the only digest this project produces or accepts. */
export const HASH_ALGORITHM = 'sha256';

/** RFC 3161 authority used unless overridden; a timestamp must outlive the certificate. */
export const DEFAULT_TIMESTAMP_SERVER = 'http://timestamp.digicert.com';

/**
 * SSL.com's timestamp authority, as shipped in CodeSignTool's properties file.
 * Reported for transparency only: the eSigner path cannot choose a TSA.
 */
export const ESIGNER_TSA = 'http://ts.ssl.com';

/**
 * Supported signers.
 *
 * `credentialVars` are read from the environment and are never printed: the
 * configuration object below reports *which names are missing*, never values.
 */
export const PROVIDERS = Object.freeze({
  pfx: {
    id: 'pfx',
    label: 'PKCS#12 (PFX) file',
    credentialVars: [SIGNING_ENV.link, SIGNING_ENV.password],
    hardwareBacked: false,
    /** Only usable where the key is exportable, i.e. not a hosted runner. */
    usableOnHostedRunners: true,
    note: 'A downloadable PFX is no longer issued for publicly trusted certificates; use it for a self-hosted signer or an internal build.',
  },
  esigner: {
    id: 'esigner',
    label: 'SSL.com eSigner (cloud)',
    credentialVars: [
      'ESIGNER_USERNAME',
      'ESIGNER_PASSWORD',
      'ESIGNER_TOTP_SECRET',
      'ESIGNER_CREDENTIAL_ID',
    ],
    hardwareBacked: true,
    usableOnHostedRunners: true,
    /** Provider CLI; its location is configuration, not a credential. */
    cliVar: 'ESIGNER_CLI',
    note: 'The private key stays in SSL.com’s HSM; CI authenticates with the account and a TOTP secret.',
  },
});

const STATUS = {
  Valid: 'valid',
  NotSigned: 'missing',
  HashMismatch: 'tampered',
  NotTrusted: 'untrusted',
  UnknownError: 'unknown',
  Incompatible: 'unknown',
};

/** CN from a certificate subject such as `CN=Acme Ltd, O=Acme Ltd, C=AU`. */
export function publisherName(subject) {
  if (!subject) return '';
  const match = /(?:^|,\s*)CN=("[^"]+"|[^,]+)/i.exec(String(subject));
  if (!match) return '';
  return match[1].replace(/^"|"$/g, '').trim();
}

/**
 * Which signer is configured, from the environment alone.
 *
 * Deliberately strict: two credential sets at once is a problem rather than a
 * silent preference, because signing with the wrong identity is not something a
 * build log would reveal.
 *
 * @param {Record<string, string|undefined>} env
 * @returns {{id: string, label: string, configured: boolean, missing: string[],
 *   credentialVars: string[], problems: string[]}}
 */
export function resolveProvider(env = process.env) {
  const problems = [];
  const present = (name) => Boolean(String(env[name] ?? '').trim());
  const requested = String(env[SIGNING_ENV.provider] ?? '').trim().toLowerCase();

  const detected = [];
  if (present(SIGNING_ENV.link)) detected.push('pfx');
  if (PROVIDERS.esigner.credentialVars.some(present)) detected.push('esigner');

  if (requested && !Object.hasOwn(PROVIDERS, requested)) {
    problems.push(
      `${SIGNING_ENV.provider} "${requested}" is not a supported provider ` +
        `(supported: ${Object.keys(PROVIDERS).join(', ')})`,
    );
    return { id: 'unknown', label: requested, configured: false, missing: [], credentialVars: [], problems };
  }

  const id = requested || detected[0] || 'none';
  if (!requested && detected.length > 1) {
    problems.push(
      `both PFX and eSigner credentials are set; set ${SIGNING_ENV.provider}=pfx or ` +
        `${SIGNING_ENV.provider}=esigner so the intended signer is explicit`,
    );
  }
  if (id === 'none') {
    return { id: 'none', label: 'none', configured: false, missing: [], credentialVars: [], problems };
  }

  const provider = PROVIDERS[id];
  const missing = provider.credentialVars.filter((name) => !present(name));
  if (id === 'pfx' && present(SIGNING_ENV.link) && !present(SIGNING_ENV.password)) {
    // A PFX with an empty password still needs the variable to be deliberate:
    // an unset password is almost always a broken secret, not an open PFX.
    problems.push(`${SIGNING_ENV.link} is set but ${SIGNING_ENV.password} is empty`);
  } else if (missing.length) {
    problems.push(
      `${provider.label} is configured but ${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} missing`,
    );
  }

  return {
    id,
    label: provider.label,
    configured: missing.length === 0,
    missing,
    credentialVars: [...provider.credentialVars],
    problems,
  };
}

/**
 * Reads the signing environment without ever exposing a secret.
 *
 * @param {Record<string, string|undefined>} env
 * @param {{expectedPublisher?: string}} policy pinned identity from package.json
 */
export function signingConfig(env = process.env, { expectedPublisher = '' } = {}) {
  const provider = resolveProvider(env);
  const requireSigned = env.ISK_REQUIRE_SIGNING === '1';
  const problems = [...provider.problems];

  if (requireSigned && provider.id === 'none') {
    problems.push(
      `${SIGNING_ENV.link} is not set, but ISK_REQUIRE_SIGNING=1 requires a signing certificate ` +
        `(or ${SIGNING_ENV.provider}=esigner with the eSigner credentials)`,
    );
  }

  const pin = String(expectedPublisher ?? '').trim();
  if (requireSigned && !pin) {
    problems.push(
      'no expected publisher is pinned (package.json iskSigning.expectedPublisher); a release must ' +
        'name the certificate identity it expects, or any trusted certificate would pass',
    );
  }

  // The PFX path timestamps through electron-builder's signtool invocation, so the
  // authority is ours to choose. CodeSignTool always timestamps with the TSA in its
  // own properties file and has no flag for it, so pretending a URL here would
  // describe a setting that does not exist.
  const configuredTimestamp = String(env.ISK_TIMESTAMP_SERVER ?? '').trim();
  if (provider.id === 'pfx' && configuredTimestamp && !/^https?:\/\//i.test(configuredTimestamp)) {
    problems.push(`ISK_TIMESTAMP_SERVER "${configuredTimestamp}" is not an http(s) RFC 3161 URL`);
  }
  const timestampServer =
    provider.id === 'esigner'
      ? `${ESIGNER_TSA} (CodeSignTool TSA_URL)`
      : configuredTimestamp || DEFAULT_TIMESTAMP_SERVER;

  return {
    requireSigned,
    configured: provider.configured,
    method: provider.id,
    provider: {
      id: provider.id,
      label: provider.label,
      credentialVars: provider.credentialVars,
      missing: provider.missing,
    },
    expectedPublisher: pin,
    hashAlgorithm: HASH_ALGORITHM,
    timestampServer,
    problems,
  };
}

/** Normalise one Get-AuthenticodeSignature result into the fields the policy needs. */
export function normaliseReport(raw) {
  const status = String(raw?.Status ?? raw?.status ?? '').trim();
  const signerSubject = String(raw?.SignerSubject ?? raw?.signerSubject ?? '').trim();
  const timeStamperSubject = String(raw?.TimeStamperSubject ?? raw?.timeStamperSubject ?? '').trim();
  return {
    status: STATUS[status] ?? (status ? 'unknown' : 'missing'),
    rawStatus: status || 'NotSigned',
    signerSubject,
    publisher: publisherName(signerSubject),
    thumbprint: String(raw?.Thumbprint ?? raw?.thumbprint ?? '').trim().toUpperCase(),
    timestamped: Boolean(timeStamperSubject),
    timeStamperSubject,
  };
}

/**
 * Policy for a single signed file.
 *
 * @param {{label: string, report: object, expectedPublisher?: string,
 *          expectedThumbprint?: string, requireSigned?: boolean}} options
 * @returns {string[]} problems
 */
export function checkSignature({
  label,
  report,
  expectedPublisher,
  expectedThumbprint,
  requireSigned = true,
  requireTimestamp = true,
}) {
  const problems = [];
  if (report.status === 'missing') {
    return requireSigned ? [`${label} is not signed`] : [];
  }
  if (report.status === 'tampered') {
    // A file whose signature no longer matches its bytes: either corruption or a
    // modified executable. Either way it must never ship.
    problems.push(`${label} is signed but its signature does not match its contents (tampered or corrupted)`);
    return problems;
  }
  if (report.status === 'untrusted') {
    problems.push(`${label} is signed by a certificate that does not chain to a trusted root`);
  } else if (report.status !== 'valid') {
    problems.push(`${label} signature status is ${report.rawStatus}, not Valid`);
  }
  if (requireTimestamp && report.status === 'valid' && !report.timestamped) {
    // Without a timestamp the signature dies when the certificate expires, which
    // for a multi-year-old installed copy is every user at once.
    problems.push(`${label} is signed but not timestamped, so it stops verifying when the certificate expires`);
  }
  if (expectedPublisher && report.publisher && report.publisher.toLowerCase() !== expectedPublisher.toLowerCase()) {
    problems.push(`${label} publisher "${report.publisher}" != expected "${expectedPublisher}"`);
  }
  if (expectedThumbprint && report.thumbprint && report.thumbprint !== expectedThumbprint) {
    problems.push(`${label} was signed with a different certificate (thumbprint mismatch)`);
  }
  return problems;
}

/** Locate signtool, preferring SIGNTOOL_PATH, then the installed Windows Kits. */
export function findSignTool(env = process.env) {
  if (env.SIGNTOOL_PATH && fs.existsSync(env.SIGNTOOL_PATH)) return env.SIGNTOOL_PATH;
  const kitsRoot = env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  const binRoot = path.join(kitsRoot, 'Windows Kits', '10', 'bin');
  try {
    const versions = fs
      .readdirSync(binRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
    for (const version of versions) {
      const candidate = path.join(binRoot, version, 'x64', 'signtool.exe');
      if (fs.existsSync(candidate)) return candidate;
    }
  } catch {
    // No Windows Kits on this machine.
  }
  return null;
}

const DEFAULT_RUN = (command, args, options = {}) =>
  spawnSync(command, args, {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 120_000,
    ...options,
  });

/**
 * Read one file's signature. Never prints paths into a shell string: PowerShell
 * receives the path through an argument, not string interpolation.
 */
export function readSignature(file, { run = DEFAULT_RUN } = {}) {
  const script =
    "$s = Get-AuthenticodeSignature -LiteralPath $env:ISK_SIGN_FILE; " +
    "Write-Output (ConvertTo-Json -Compress -InputObject ([pscustomobject]@{" +
    "Status=$s.Status.ToString(); " +
    "SignerSubject=if($s.SignerCertificate){$s.SignerCertificate.Subject}else{''}; " +
    "Thumbprint=if($s.SignerCertificate){$s.SignerCertificate.Thumbprint}else{''}; " +
    "TimeStamperSubject=if($s.TimeStamperCertificate){$s.TimeStamperCertificate.Subject}else{''}}))";
  const result = run('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], {
    env: { ...process.env, ISK_SIGN_FILE: file },
  });
  if (result.error) return { status: 'unknown', rawStatus: result.error.message, signerSubject: '', publisher: '', thumbprint: '', timestamped: false, timeStamperSubject: '' };
  if (result.status !== 0) {
    return {
      status: 'unknown',
      rawStatus: String(result.stderr || result.stdout || `powershell exited ${result.status}`).trim().slice(0, 300),
      signerSubject: '',
      publisher: '',
      thumbprint: '',
      timestamped: false,
      timeStamperSubject: '',
    };
  }
  try {
    return normaliseReport(JSON.parse(String(result.stdout || '').trim()));
  } catch {
    return {
      status: 'unknown',
      rawStatus: 'Get-AuthenticodeSignature returned no parseable result',
      signerSubject: '',
      publisher: '',
      thumbprint: '',
      timestamped: false,
      timeStamperSubject: '',
    };
  }
}

/**
 * The digest algorithm of each signature on a file.
 *
 * Get-AuthenticodeSignature reports the overall status but not which hash was
 * used, and PowerShell cannot decode a signature out of a 180 MB PE (`SignedCms`
 * expects the PKCS#7 blob, not the executable, and rejects the whole file as
 * "ASN1 value too large"). signtool already prints one `Hash of file (sha256)`
 * line per signature — including every nested signature with `/all` — so that is
 * the source of truth here. A dual-signed file therefore reports both `SHA1` and
 * `SHA256`, which is exactly what the SHA-256-only policy must reject.
 */
export function readDigests(file, { run = DEFAULT_RUN, env = process.env } = {}) {
  const tool = findSignTool(env);
  if (!tool) {
    return { algorithms: [], error: 'signtool was not found, so the signature digest could not be read' };
  }
  // A non-zero exit is expected whenever the chain is untrusted or incomplete;
  // the digest lines are still printed, so the output is parsed either way.
  const result = run(tool, ['verify', '/pa', '/all', '/v', file], { encoding: 'utf8' });
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  const algorithms = [
    ...new Set(
      [...output.matchAll(/Hash of file \(([a-z0-9-]+)\)/gi)].map((match) =>
        match[1].replace(/[^a-z0-9]/gi, '').toUpperCase(),
      ),
    ),
  ];
  if (algorithms.length) return { algorithms, error: null };
  if (!result.error && /no signature found|is not signed/i.test(output)) {
    return { algorithms: [], error: null };
  }
  return {
    algorithms: [],
    error: String(result.error?.message || output.trim() || `signtool exited ${result.status}`)
      .replace(/\s+/g, ' ')
      .slice(0, 300),
  };
}

/**
 * SHA-256 only.
 *
 * SHA-1 Authenticode is deprecated: Windows ignores that signature where the
 * policy allows, and a dual-signed file is two signatures to reason about for no
 * benefit. One digest, one signature.
 */
export function digestPolicy({ label, algorithms, error = null }) {
  if (error) return [`${label} signature digest could not be read: ${error}`];
  if (algorithms.length === 0) return [`${label} has no signature digest (unsigned or unreadable)`];
  const problems = [];
  if (algorithms.includes('SHA1')) {
    problems.push(`${label} carries a SHA-1 signature; SHA-1 Authenticode is deprecated and must not be produced`);
  }
  const unexpected = algorithms.filter((name) => name !== 'SHA256');
  if (unexpected.length) {
    problems.push(`${label} is signed with ${unexpected.join(', ')}; only SHA256 is allowed`);
  }
  return problems;
}

/**
 * Digest check across the artifacts we sign ourselves.
 *
 * @param {{files: Array<{label: string, file: string}>, readDigests?: Function, run?: Function}} options
 */
export function verifyDigests({ files, readDigests: read = readDigests, run }) {
  const problems = [];
  const facts = [];
  for (const { label, file } of files) {
    if (!fs.existsSync(file)) {
      problems.push(`${label} is missing, so its signature digest cannot be checked`);
      continue;
    }
    const { algorithms, error } = read(file, { run });
    facts.push({ label, algorithms });
    problems.push(...digestPolicy({ label, algorithms, error }));
  }
  return { problems, facts };
}

/**
 * Full artifact policy.
 *
 * `ourFiles` are the executables we sign; they must all share one certificate and
 * (when pinned) one expected publisher. `runtime` is the upstream Node binary,
 * checked against its pinned signer.
 *
 * @param {{ourFiles: Array<{label: string, file: string}>,
 *          runtime?: {label: string, file: string, expectedPublisher: string}|null,
 *          requireSigned: boolean, requireTimestamp?: boolean,
 *          expectedPublisher?: string,
 *          readSignature?: Function, run?: Function}} options
 * @returns {{problems: string[], reports: Array<object>}}
 */
export function verifySignatures({
  ourFiles,
  runtime = null,
  requireSigned,
  requireTimestamp = true,
  expectedPublisher = '',
  readSignature: read = readSignature,
  run,
}) {
  const problems = [];
  const reports = [];

  for (const { label, file } of ourFiles) {
    if (!fs.existsSync(file)) {
      problems.push(`${label} is missing, so its signature cannot be checked`);
      continue;
    }
    const report = read(file, { run });
    reports.push({ label, file, ...report });
    problems.push(
      ...checkSignature({
        label,
        report,
        requireSigned,
        requireTimestamp,
        expectedPublisher: requireSigned ? expectedPublisher : '',
      }),
    );
  }

  if (runtime) {
    if (!fs.existsSync(runtime.file)) {
      problems.push(`${runtime.label} is missing, so its signature cannot be checked`);
    } else {
      const report = read(runtime.file, { run });
      reports.push({ label: runtime.label, file: runtime.file, ...report });
      problems.push(
        ...checkSignature({
          label: runtime.label,
          report,
          expectedPublisher: runtime.expectedPublisher,
          requireSigned: true,
          requireTimestamp,
        }),
      );
    }
  }

  // Publisher identity across our own files: the certificate must be one, not
  // "any trusted certificate", otherwise a misconfigured build mixes two.
  const signedOurs = reports.filter(
    (r) => ourFiles.some((f) => f.label === r.label) && r.status === 'valid',
  );
  const thumbprints = new Set(signedOurs.map((r) => r.thumbprint).filter(Boolean));
  if (thumbprints.size > 1) {
    problems.push(
      `the packaged executables are signed with ${thumbprints.size} different certificates ` +
        `(${signedOurs.map((r) => `${r.label}: ${r.publisher || 'unknown'}`).join(', ')})`,
    );
  }

  return { problems, reports };
}

/** A second opinion through signtool in release mode; null when unavailable. */
export function signToolProblems(files, { run = DEFAULT_RUN, env = process.env } = {}) {
  const tool = findSignTool(env);
  if (!tool) return ['signtool was not found, so the Authenticode chain could not be independently verified'];
  const problems = [];
  for (const { label, file } of files) {
    if (!fs.existsSync(file)) continue;
    const result = run(tool, ['verify', '/pa', '/all', '/v', file], { encoding: 'utf8' });
    if (result.error || result.status !== 0) {
      const detail = String(result.stdout || result.stderr || result.error?.message || '')
        .split(/\r?\n/)
        .filter((line) => /error|Signature|issued to|SHA1 hash/i.test(line))
        .slice(0, 3)
        .join(' | ')
        .slice(0, 400);
      problems.push(`${label} failed signtool verify /pa /all${detail ? `: ${detail}` : ''}`);
    }
  }
  return problems;
}
