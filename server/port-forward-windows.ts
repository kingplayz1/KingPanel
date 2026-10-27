/**
 * IS King Panel — Windows port forwarding (netsh portproxy + Windows Firewall)
 *
 * The panel can only make a mapping real through netsh, and netsh needs
 * administrator rights. This module does that honestly:
 *
 *  - the operator's intent is re-expressed as netsh argv (numbers and a
 *    validated IPv4 literal only — no request text ever reaches a command)
 *  - one elevated PowerShell runs delete-then-add for the portproxy entry and
 *    the firewall rule, so applying twice is idempotent
 *  - the elevated process cannot stream stdout back, so each step's exit code
 *    and output are written to a log file the parent reads
 *  - the result is VERIFIED with the non-elevated `netsh show` commands, and
 *    only a verified mapping may be reported as applied
 *  - a cancelled UAC prompt is reported as a decline, never as success
 *
 * Everything that touches the OS is injectable (`ApplyDeps`) so tests can prove
 * the classification logic without ever prompting for elevation.
 */
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export type ForwardProtocol = 'TCP' | 'UDP' | 'TCP/UDP';

/** The validated intent of one rule; nothing else is ever applied. */
export interface ForwardTarget {
  externalPort: number;
  internalPort: number;
  internalIp: string;
  protocol: ForwardProtocol;
}

export interface ForwardVerification {
  /** Inbound Allow firewall rule for the public port is present and enabled. */
  firewall: boolean;
  /** netsh portproxy maps 0.0.0.0:externalPort to internalIp:internalPort. */
  portProxy: boolean;
  /** True when a TCP path is expected at all (UDP-only rules have none). */
  portProxyRequired: boolean;
  checkedAt: string;
  /** Parser-level evidence, used in error messages and the UI. */
  detail?: string;
}

export type ApplyErrorCode =
  | 'UNSUPPORTED_PLATFORM'
  | 'ELEVATION_DISABLED'
  | 'ELEVATION_DECLINED'
  | 'ELEVATION_FAILED'
  | 'ELEVATION_TIMEOUT'
  | 'APPLY_FAILED'
  | 'VERIFY_FAILED'
  | 'REVERT_FAILED';

export type ApplyOutcome =
  | { ok: true; verification: ForwardVerification; appliedAt: string }
  | { ok: false; code: ApplyErrorCode; message: string; detail?: string };

export type RevertOutcome =
  | { ok: true; verification: ForwardVerification; revertedAt: string }
  | { ok: false; code: ApplyErrorCode; message: string; detail?: string };

export const FIREWALL_RULE_PREFIX = 'IS King Panel Forward';
export const ELEVATION_TIMEOUT_MS = 120_000;
/** Ops/test switch: set to "off" to forbid elevation entirely (fails closed). */
export const ELEVATION_ENV = 'KINGPANEL_PORT_FORWARD_ELEVATION';

export const firewallRuleName = (externalPort: number): string =>
  `${FIREWALL_RULE_PREFIX} ${externalPort}`;

/** TCP/UDP maps to a single `protocol=any` rule: one name, both transports. */
export const firewallProtocolArg = (protocol: ForwardProtocol): string =>
  protocol === 'TCP' ? 'protocol=TCP' : protocol === 'UDP' ? 'protocol=UDP' : 'protocol=any';

/** UDP-only rules cannot use portproxy: `v4tov4` proxies TCP. */
export const needsPortProxy = (protocol: ForwardProtocol): boolean => protocol !== 'UDP';

/**
 * The self-test range: Windows' dynamic/private ports. Nothing a game server or
 * the panel itself would normally claim, so a throwaway mapping here cannot sit
 * on top of a real service.
 */
export const SELF_TEST_PORT_MIN = 49152;
export const SELF_TEST_PORT_MAX = 65535;

/**
 * First free port in the self-test range. `taken` should carry everything the
 * caller can already see (stored rules, current portproxy listeners, the panel's
 * own port); the result is still validated by the read-back after the apply.
 * Returns null only if the whole range is occupied, which is not silently
 * treated as a usable port.
 */
export function pickDisposablePort(
  taken: Iterable<number> = [],
  reserved: Iterable<number> = []
): number | null {
  const blocked = new Set<number>();
  for (const value of [...taken, ...reserved]) {
    const port = Number(value);
    if (Number.isInteger(port) && port >= 1 && port <= 65535) blocked.add(port);
  }
  for (let port = SELF_TEST_PORT_MIN; port <= SELF_TEST_PORT_MAX; port += 1) {
    if (!blocked.has(port)) return port;
  }
  return null;
}

/** The throwaway mapping: a port that only forwards to itself on loopback. */
export const selfTestTarget = (port: number): ForwardTarget => ({
  externalPort: assertPort(port),
  internalPort: port,
  internalIp: '127.0.0.1',
  protocol: 'TCP/UDP',
});

/** The exact commands that remove a mapping by hand if a revert ever fails. */
export const buildCleanupCommands = (
  target: ForwardTarget
): { firewall: string; portProxy: string } => ({
  firewall: `netsh advfirewall firewall delete rule name="${firewallRuleName(target.externalPort)}"`,
  portProxy: `netsh interface portproxy delete v4tov4 listenport=${target.externalPort} listenaddress=0.0.0.0`,
});

const assertPort = (port: number): number => {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Refusing to build a netsh command for port ${port}`);
  }
  return port;
};

const assertIpv4 = (ip: string): string => {
  const parts = ip.split('.');
  const valid = parts.length === 4 && parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255);
  if (!valid) throw new Error(`Refusing to build a netsh command for address ${ip}`);
  return ip;
};

/** The exact netsh argv for this rule. Order of operations makes re-apply safe. */
export function buildForwardSteps(target: ForwardTarget): Array<{ name: string; args: string[] }> {
  const ext = String(assertPort(target.externalPort));
  const int = String(assertPort(target.internalPort));
  const ip = assertIpv4(target.internalIp);
  const name = firewallRuleName(target.externalPort);

  const steps: Array<{ name: string; args: string[] }> = [];
  if (needsPortProxy(target.protocol)) {
    steps.push({
      name: 'portproxy-delete',
      args: ['interface', 'portproxy', 'delete', 'v4tov4', `listenport=${ext}`, 'listenaddress=0.0.0.0'],
    });
    steps.push({
      name: 'portproxy-add',
      args: [
        'interface',
        'portproxy',
        'add',
        'v4tov4',
        `listenport=${ext}`,
        'listenaddress=0.0.0.0',
        `connectport=${int}`,
        `connectaddress=${ip}`,
      ],
    });
  }
  steps.push({
    name: 'firewall-delete',
    args: ['advfirewall', 'firewall', 'delete', 'rule', `name=${name}`],
  });
  steps.push({
    name: 'firewall-add',
    args: [
      'advfirewall',
      'firewall',
      'add',
      'rule',
      `name=${name}`,
      'dir=in',
      'action=allow',
      firewallProtocolArg(target.protocol),
      `localport=${ext}`,
    ],
  });
  return steps;
}

/** Same argv, run in reverse, to take the mapping away. */
export function buildRevertSteps(target: ForwardTarget): Array<{ name: string; args: string[] }> {
  const ext = String(assertPort(target.externalPort));
  return [
    { name: 'firewall-delete', args: ['advfirewall', 'firewall', 'delete', 'rule', `name=${firewallRuleName(target.externalPort)}`] },
    { name: 'portproxy-delete', args: ['interface', 'portproxy', 'delete', 'v4tov4', `listenport=${ext}`, 'listenaddress=0.0.0.0'] },
  ];
}

const psQuote = (value: string): string => `'${value.replace(/'/g, "''")}'`;

const psArray = (args: string[]): string => `@(${args.map((a) => psQuote(a)).join(',')})`;

/**
 * Builds the elevated script. Every argument is one of: a loop constant, a
 * number, a validated IPv4 literal, or `firewallRuleName(port)` — quoted as a
 * PowerShell single-quoted string, so no request text can break out.
 */
export function buildElevationScript(
  steps: Array<{ name: string; args: string[] }>,
  logPath: string
): string {
  if (!steps.length) throw new Error('No steps to run');
  const lines = [
    '$ErrorActionPreference = "Continue"',
    `$logPath = ${psQuote(logPath)}`,
    'Set-Content -LiteralPath $logPath -Value ("start " + (Get-Date -Format o)) -Encoding utf8',
    'function Invoke-NetshStep([string]$name, [string[]]$arguments) {',
    '  $exited = $null',
    '  $output = & netsh @arguments 2>&1 | Out-String',
    '  $exited = $LASTEXITCODE',
    '  Add-Content -LiteralPath $logPath -Value ("STEP " + $name + " EXIT " + $exited)',
    '  if ($output -and $output.Trim().Length -gt 0) {',
    '    Add-Content -LiteralPath $logPath -Value $output.Trim()',
    '  }',
    '}',
    ...steps.map((step) => `Invoke-NetshStep ${psQuote(step.name)} ${psArray(step.args)}`),
    'Add-Content -LiteralPath $logPath -Value "DONE"',
    'exit 0',
  ];
  return lines.join('\r\n');
}

/**
 * `powershell -Command` wrapper that launches the script elevated and returns
 * the child's exit code. Exit 1223 is reserved for "the user declined the UAC
 * prompt" so the caller never has to guess from a localized error message.
 */
export function buildLaunchArguments(scriptPath: string): string[] {
  const inner = [
    'powershell.exe',
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    scriptPath,
  ];
  const command = [
    'try {',
    `  $p = Start-Process -FilePath ${psQuote(inner[0])} -Verb RunAs -Wait -PassThru -WindowStyle Hidden -ArgumentList ${psArray(inner.slice(1))}`,
    '  exit $p.ExitCode',
    '} catch {',
    '  Write-Error $_',
    '  exit 1223',
    '}',
  ].join(' ');
  return ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command];
}

export interface ElevationLog {
  started: boolean;
  done: boolean;
  steps: Array<{ name: string; exitCode: number }>;
  output: string;
}

export function parseElevationLog(text: string): ElevationLog {
  const steps: Array<{ name: string; exitCode: number }> = [];
  const stepRe = /^STEP (\S+) EXIT (-?\d+)$/gm;
  let match: RegExpExecArray | null;
  while ((match = stepRe.exec(text)) !== null) {
    steps.push({ name: match[1], exitCode: Number(match[2]) });
  }
  return {
    started: /^start /m.test(text),
    done: /^DONE$/m.test(text),
    steps,
    output: text,
  };
}

/** One row of `netsh interface portproxy show v4tov4`. */
export interface PortProxyRow {
  listenAddress: string;
  listenPort: number;
  connectAddress: string;
  connectPort: number;
}

export function parsePortProxyShow(text: string): PortProxyRow[] {
  const rows: PortProxyRow[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    // Address Port Address Port — the header and separators never match \d+ in
    // both port columns, so they are skipped without special-casing.
    const m = line.match(/^(\S+)\s+(\d{1,5})\s+(\S+)\s+(\d{1,5})$/);
    if (!m) continue;
    const listenPort = Number(m[2]);
    const connectPort = Number(m[4]);
    if (!listenPort || !connectPort) continue;
    if (/^-+$/.test(m[1]) || /^-+$/.test(m[3])) continue;
    rows.push({
      listenAddress: m[1],
      listenPort,
      connectAddress: m[3],
      connectPort,
    });
  }
  return rows;
}

export interface FirewallRuleInfo {
  found: boolean;
  enabled: boolean;
  inbound: boolean;
  allow: boolean;
  localPort: number | null;
  protocol: string | null;
}

export function parseFirewallRuleShow(text: string): FirewallRuleInfo {
  if (/No rules match the specified criteria/i.test(text)) {
    return { found: false, enabled: false, inbound: false, allow: false, localPort: null, protocol: null };
  }
  const field = (label: string): string | null => {
    const m = text.match(new RegExp(`^\\s*${label}:\\s*(.+)$`, 'mi'));
    return m ? m[1].trim() : null;
  };
  const name = field('Rule Name');
  if (!name) {
    return { found: false, enabled: false, inbound: false, allow: false, localPort: null, protocol: null };
  }
  const localPortRaw = field('LocalPort');
  const localPort = localPortRaw && /^\d+$/.test(localPortRaw) ? Number(localPortRaw) : null;
  return {
    found: true,
    enabled: /^yes$/i.test(field('Enabled') || ''),
    inbound: /^in$/i.test(field('Direction') || ''),
    allow: /^allow$/i.test(field('Action') || ''),
    localPort,
    protocol: field('Protocol'),
  };
}

export interface ElevationRun {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface ApplyDeps {
  platform: NodeJS.Platform;
  elevationDisabled: boolean;
  /** Runs the script elevated; the only OS-level privilege boundary. */
  runElevated: (scriptPath: string, logPath: string) => Promise<ElevationRun>;
  /** Non-elevated read used for verification. */
  showPortProxy: () => Promise<string>;
  showFirewall: (ruleName: string) => Promise<string>;
  /** Directory for the script and its log; a temp dir when omitted. */
  workDir: string;
}

function execCollect(
  file: string,
  args: string[],
  timeoutMs: number
): Promise<{ stdout: string; stderr: string; exitCode: number | null; timedOut: boolean }> {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timedOut = false;
    const child = spawn(file, args, { windowsHide: true });
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill();
      } catch {
        // ignore
      }
    }, timeoutMs);
    const finish = (exitCode: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ stdout, stderr, exitCode, timedOut });
    };
    child.stdout?.on('data', (d) => {
      stdout += d.toString();
    });
    child.stderr?.on('data', (d) => {
      stderr += d.toString();
    });
    child.on('error', (err) => {
      stderr += err instanceof Error ? err.message : String(err);
      finish(null);
    });
    child.on('close', (code) => finish(code));
  });
}

export function defaultDeps(platform: NodeJS.Platform = process.platform): ApplyDeps {
  let workDir = '';
  return {
    platform,
    get elevationDisabled() {
      return String(process.env[ELEVATION_ENV] || '').toLowerCase() === 'off';
    },
    get workDir() {
      if (!workDir) workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'iskingpanel-forward-'));
      return workDir;
    },
    runElevated: async (scriptPath) =>
      execCollect('powershell.exe', buildLaunchArguments(scriptPath), ELEVATION_TIMEOUT_MS),
    showPortProxy: async () => {
      const res = await execCollect('netsh', ['interface', 'portproxy', 'show', 'v4tov4'], 20_000);
      return `${res.stdout}\n${res.stderr}`;
    },
    showFirewall: async (ruleName) => {
      const res = await execCollect(
        'netsh',
        ['advfirewall', 'firewall', 'show', 'rule', `name=${ruleName}`],
        20_000
      );
      return `${res.stdout}\n${res.stderr}`;
    },
  } as ApplyDeps;
}

/** Reads the live OS state; never trusts the stored rule status. */
export async function verifyForward(
  target: ForwardTarget,
  deps: Pick<ApplyDeps, 'showPortProxy' | 'showFirewall'>
): Promise<ForwardVerification> {
  const checkedAt = new Date().toISOString();
  const required = needsPortProxy(target.protocol);
  const notes: string[] = [];

  let portProxy = false;
  if (required) {
    const rows = parsePortProxyShow(await deps.showPortProxy());
    portProxy = rows.some(
      (row) =>
        row.listenPort === target.externalPort &&
        row.connectPort === target.internalPort &&
        (row.connectAddress === target.internalIp || row.connectAddress === 'localhost')
    );
    notes.push(
      portProxy
        ? `portproxy :${target.externalPort} -> ${target.internalIp}:${target.internalPort}`
        : `no portproxy entry for :${target.externalPort}`
    );
  } else {
    notes.push('UDP-only rule: no TCP portproxy expected');
  }

  const rule = parseFirewallRuleShow(await deps.showFirewall(firewallRuleName(target.externalPort)));
  const firewall =
    rule.found &&
    rule.enabled &&
    rule.inbound &&
    rule.allow &&
    (rule.localPort === null || rule.localPort === target.externalPort);
  notes.push(
    firewall
      ? `firewall rule "${firewallRuleName(target.externalPort)}" allowed inbound`
      : rule.found
        ? `firewall rule "${firewallRuleName(target.externalPort)}" is present but not an enabled inbound allow`
        : `firewall rule "${firewallRuleName(target.externalPort)}" is missing`
  );

  return {
    firewall,
    portProxy,
    portProxyRequired: required,
    checkedAt,
    detail: notes.join('; '),
  };
}

const verificationPassed = (v: ForwardVerification): boolean =>
  v.firewall && (!v.portProxyRequired || v.portProxy);

const failureTail = (run: ElevationRun): string =>
  [run.stdout, run.stderr]
    .map((s) => s.trim())
    .filter(Boolean)
    .join(' ')
    .slice(0, 400);

const runStepsElevated = async (
  steps: Array<{ name: string; args: string[] }>,
  deps: ApplyDeps
): Promise<
  | { ok: true; log: ElevationLog }
  | { ok: false; code: ApplyErrorCode; message: string; detail?: string }
> => {
  const dir = deps.workDir;
  fs.mkdirSync(dir, { recursive: true });
  const scriptPath = path.join(dir, `forward-${Date.now()}.ps1`);
  const logPath = path.join(dir, `forward-${Date.now()}.log`);
  if (scriptPath.includes("'") || logPath.includes("'")) {
    return {
      ok: false,
      code: 'APPLY_FAILED',
      message: 'The temporary folder path contains a quote, which cannot be passed to PowerShell safely.',
    };
  }
  fs.writeFileSync(scriptPath, buildElevationScript(steps, logPath), 'utf8');

  let run: ElevationRun;
  try {
    run = await deps.runElevated(scriptPath, logPath);
  } catch (err) {
    return {
      ok: false,
      code: 'ELEVATION_FAILED',
      message: err instanceof Error ? err.message : 'Could not launch the elevated helper',
    };
  }

  const tail = failureTail(run);
  if (run.timedOut) {
    return {
      ok: false,
      code: 'ELEVATION_TIMEOUT',
      message:
        'The elevated helper did not finish in time. Approve the Windows prompt and check the mapping again.',
      detail: tail || undefined,
    };
  }
  if (run.exitCode === 1223 || /canceled by the user|cancelled by the user/i.test(tail)) {
    return {
      ok: false,
      code: 'ELEVATION_DECLINED',
      message: 'Administrator approval was declined, so nothing was changed on this PC.',
      detail: tail || undefined,
    };
  }
  if (run.exitCode !== 0) {
    return {
      ok: false,
      code: 'ELEVATION_FAILED',
      message: `The elevated helper exited with code ${run.exitCode ?? 'unknown'}.`,
      detail: tail || undefined,
    };
  }

  let logText = '';
  try {
    logText = fs.readFileSync(logPath, 'utf8');
  } catch {
    return {
      ok: false,
      code: 'ELEVATION_FAILED',
      message: 'The elevated helper did not write its result log, so the outcome cannot be confirmed.',
    };
  }
  const log = parseElevationLog(logText);
  if (!log.started) {
    return {
      ok: false,
      code: 'ELEVATION_FAILED',
      message: 'The elevated helper did not start properly.',
      detail: logText.slice(0, 400),
    };
  }
  // `*-delete` steps are allowed to fail (nothing to delete); `*-add` must not.
  for (const step of steps.filter((s) => s.name.endsWith('-add'))) {
    const recorded = log.steps.find((s) => s.name === step.name);
    if (!recorded) {
      return {
        ok: false,
        code: 'APPLY_FAILED',
        message: `The elevated helper never ran "${step.name}".`,
        detail: logText.slice(0, 400),
      };
    }
    if (recorded.exitCode !== 0) {
      return {
        ok: false,
        code: 'APPLY_FAILED',
        message: `netsh refused "${step.name}" (exit ${recorded.exitCode}).`,
        detail: logText.slice(0, 600),
      };
    }
  }
  return { ok: true, log };
};

/** Applies the mapping and only reports success when the OS confirms it. */
export async function applyForward(
  target: ForwardTarget,
  deps: ApplyDeps = defaultDeps()
): Promise<ApplyOutcome> {
  if (deps.platform !== 'win32') {
    return {
      ok: false,
      code: 'UNSUPPORTED_PLATFORM',
      message:
        'Applying a forward is only implemented for Windows (netsh portproxy + Windows Firewall). The rule stays recorded.',
    };
  }
  if (deps.elevationDisabled) {
    return {
      ok: false,
      code: 'ELEVATION_DISABLED',
      message: `Elevation is disabled by ${ELEVATION_ENV}=off, so nothing was applied.`,
    };
  }

  const steps = buildForwardSteps(target);
  const run = await runStepsElevated(steps, deps);
  if (!run.ok) return run;

  const verification = await verifyForward(target, deps);
  if (!verificationPassed(verification)) {
    return {
      ok: false,
      code: 'VERIFY_FAILED',
      message:
        'netsh reported success but the mapping could not be confirmed — the rule is not marked active.',
      detail: verification.detail,
    };
  }
  return { ok: true, verification, appliedAt: new Date().toISOString() };
}

/** Removes the mapping and confirms the OS no longer has it. */
export async function revertForward(
  target: ForwardTarget,
  deps: ApplyDeps = defaultDeps()
): Promise<RevertOutcome> {
  if (deps.platform !== 'win32') {
    return {
      ok: false,
      code: 'UNSUPPORTED_PLATFORM',
      message: 'Reversing a mapping is only implemented for Windows.',
    };
  }
  if (deps.elevationDisabled) {
    return {
      ok: false,
      code: 'ELEVATION_DISABLED',
      message: `Elevation is disabled by ${ELEVATION_ENV}=off, so nothing was removed.`,
    };
  }

  const steps = buildRevertSteps(target);
  const run = await runStepsElevated(
    // Delete-only: every step is expected to fail when there is nothing to
    // remove, so only the helper's own failure (non-zero exit) aborts.
    steps,
    deps
  );
  if (!run.ok) return run;

  const verification = await verifyForward(target, deps);
  if (verificationPassed(verification)) {
    return {
      ok: false,
      code: 'REVERT_FAILED',
      message:
        'The mapping is still present after the revert, so the rule was kept to avoid hiding an open port.',
      detail: verification.detail,
    };
  }
  return { ok: true, verification, revertedAt: new Date().toISOString() };
}
