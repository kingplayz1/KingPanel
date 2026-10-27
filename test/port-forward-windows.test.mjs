/**
 * Port forwarding on Windows — argv, parsing and the honesty rules.
 *
 * Every OS touch is injected, so this suite proves the classification logic
 * (declined UAC, failed netsh, unverifiable "success") without ever prompting
 * for elevation or changing this machine's firewall.
 *
 * Run with:  npm test
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  applyForward,
  buildCleanupCommands,
  buildElevationScript,
  buildForwardSteps,
  buildLaunchArguments,
  buildRevertSteps,
  firewallRuleName,
  parseElevationLog,
  parseFirewallRuleShow,
  parsePortProxyShow,
  pickDisposablePort,
  revertForward,
  selfTestTarget,
  verifyForward,
  SELF_TEST_PORT_MAX,
  SELF_TEST_PORT_MIN,
} from '../server/port-forward-windows.ts';

const TCP_RULE = {
  externalPort: 25565,
  internalPort: 25565,
  internalIp: '127.0.0.1',
  protocol: 'TCP',
};

// Real `netsh interface portproxy show v4tov4` shape.
const PORT_PROXY_ROW = `
Listen on ipv4:             Connect to ipv4:

Address         Port        Address         Port
--------------- ----------  --------------- ----------
0.0.0.0         25565       127.0.0.1       25565
`;

// Real `netsh advfirewall firewall show rule name="..."` shape.
const FIREWALL_RULE = `Rule Name:                            IS King Panel Forward 25565
----------------------------------------------------------------------
Enabled:                              Yes
Direction:                            In
Profiles:                             Domain,Private,Public
Grouping:
LocalIP:                              Any
RemoteIP:                             Any
Protocol:                             TCP
LocalPort:                            25565
RemotePort:                           Any
Edge traversal:                       No
Action:                               Allow

Ok.
`;

const FIREWALL_MISSING = `
No rules match the specified criteria.
`;

const tmpWorkDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'iskingpanel-fwd-test-'));

/**
 * Builds deps whose "elevated" run only writes a log, and whose `netsh show`
 * answers come from the test rather than the OS.
 */
function deps({
  target = TCP_RULE,
  addExit = 0,
  outerExit = 0,
  outerStderr = '',
  timedOut = false,
  logText,
  portProxyVisible = true,
  firewallVisible = true,
  platform = 'win32',
  elevationDisabled = false,
} = {}) {
  return {
    platform,
    elevationDisabled,
    workDir: tmpWorkDir(),
    runElevated: async (_scriptPath, logPath) => {
      const text =
        logText ??
        [
          `start ${new Date().toISOString()}`,
          ...buildForwardSteps(target).map(
            (step) => `STEP ${step.name} EXIT ${step.name.endsWith('-add') ? addExit : 1}`
          ),
          'DONE',
        ].join('\n');
      fs.writeFileSync(logPath, text, 'utf8');
      return { exitCode: outerExit, stdout: '', stderr: outerStderr, timedOut };
    },
    showPortProxy: async () => (portProxyVisible ? PORT_PROXY_ROW : ''),
    showFirewall: async () =>
      firewallVisible ? FIREWALL_RULE : FIREWALL_MISSING,
  };
}

describe('netsh argv construction', () => {
  test('a TCP rule becomes delete-then-add for portproxy and firewall', () => {
    const steps = buildForwardSteps(TCP_RULE);
    assert.deepEqual(
      steps.map((s) => s.name),
      ['portproxy-delete', 'portproxy-add', 'firewall-delete', 'firewall-add']
    );
    const add = steps.find((s) => s.name === 'portproxy-add');
    assert.deepEqual(add.args, [
      'interface',
      'portproxy',
      'add',
      'v4tov4',
      'listenport=25565',
      'listenaddress=0.0.0.0',
      'connectport=25565',
      'connectaddress=127.0.0.1',
    ]);
    const firewall = steps.find((s) => s.name === 'firewall-add');
    assert.ok(firewall.args.includes('dir=in'));
    assert.ok(firewall.args.includes('action=allow'));
    assert.ok(firewall.args.includes('protocol=TCP'));
    assert.ok(firewall.args.includes('localport=25565'));
    // The rule name is derived from the port only — no request text.
    assert.ok(firewall.args.includes(`name=${firewallRuleName(25565)}`));
  });

  test('TCP/UDP maps to one protocol=any firewall rule', () => {
    const steps = buildForwardSteps({ ...TCP_RULE, protocol: 'TCP/UDP' });
    const firewall = steps.find((s) => s.name === 'firewall-add');
    assert.ok(firewall.args.includes('protocol=any'));
    assert.ok(steps.some((s) => s.name === 'portproxy-add'), 'a TCP path still needs portproxy');
  });

  test('a UDP-only rule skips portproxy (v4tov4 proxies TCP only)', () => {
    const steps = buildForwardSteps({ ...TCP_RULE, protocol: 'UDP' });
    assert.deepEqual(steps.map((s) => s.name), ['firewall-delete', 'firewall-add']);
    const firewall = steps.find((s) => s.name === 'firewall-add');
    assert.ok(firewall.args.includes('protocol=UDP'));
  });

  test('invalid ports and addresses are refused before any command exists', () => {
    assert.throws(() => buildForwardSteps({ ...TCP_RULE, externalPort: 70000 }), /Refusing/);
    assert.throws(() => buildForwardSteps({ ...TCP_RULE, internalPort: 0 }), /Refusing/);
    assert.throws(() => buildForwardSteps({ ...TCP_RULE, internalIp: '127.0.0.1; calc' }), /Refusing/);
  });

  test('the elevated script carries nothing from the request', () => {
    const script = buildElevationScript(buildForwardSteps(TCP_RULE), 'C:\\Temp\\f.log');
    assert.match(script, /listenport=25565/);
    assert.match(script, /connectaddress=127\.0\.0\.1/);
    // No request-supplied text can appear: the only strings are argv we built.
    assert.doesNotMatch(script, /;[A-Za-z]/);
    assert.match(script, /Invoke-NetshStep 'portproxy-add'/);
    // Revert argv is the inverse pair.
    assert.deepEqual(
      buildRevertSteps(TCP_RULE).map((s) => s.name),
      ['firewall-delete', 'portproxy-delete']
    );
  });

  test('the launcher requests elevation explicitly and reserves 1223', () => {
    const args = buildLaunchArguments('C:\\Temp\\f.ps1');
    const command = args[args.length - 1];
    assert.match(command, /-Verb RunAs/);
    assert.match(command, /-PassThru/);
    assert.match(command, /exit 1223/);
  });
});

describe('netsh output parsing', () => {
  test('portproxy rows are read', () => {
    const rows = parsePortProxyShow(PORT_PROXY_ROW);
    assert.equal(rows.length, 1);
    assert.deepEqual(rows[0], {
      listenAddress: '0.0.0.0',
      listenPort: 25565,
      connectAddress: '127.0.0.1',
      connectPort: 25565,
    });
  });

  test('empty output means no mappings (and headers are not mistaken for rows)', () => {
    assert.deepEqual(parsePortProxyShow(''), []);
    assert.deepEqual(
      parsePortProxyShow(
        'Address         Port        Address         Port\n--------------- ----------  --------------- ----------'
      ),
      []
    );
  });

  test('a firewall rule is parsed with its real fields', () => {
    const rule = parseFirewallRuleShow(FIREWALL_RULE);
    assert.equal(rule.found, true);
    assert.equal(rule.enabled, true);
    assert.equal(rule.inbound, true);
    assert.equal(rule.allow, true);
    assert.equal(rule.localPort, 25565);
    assert.equal(rule.protocol, 'TCP');
  });

  test('a missing firewall rule is reported as missing, not as a rule', () => {
    const rule = parseFirewallRuleShow(FIREWALL_MISSING);
    assert.equal(rule.found, false);
    assert.equal(rule.enabled, false);
  });

  test('elevated step exit codes are read from the log', () => {
    const log = parseElevationLog('start x\nSTEP portproxy-add EXIT 0\nDONE');
    assert.equal(log.started, true);
    assert.equal(log.done, true);
    assert.deepEqual(log.steps, [{ name: 'portproxy-add', exitCode: 0 }]);
  });
});

describe('verification decides what "active" means', () => {
  test('matching portproxy + firewall passes', async () => {
    const v = await verifyForward(TCP_RULE, deps());
    assert.equal(v.firewall, true);
    assert.equal(v.portProxy, true);
    assert.equal(v.portProxyRequired, true);
  });

  test('a firewall rule alone is not enough for a TCP rule', async () => {
    const v = await verifyForward(TCP_RULE, deps({ portProxyVisible: false }));
    assert.equal(v.firewall, true);
    assert.equal(v.portProxy, false);
  });

  test('a matching portproxy with no firewall rule does not pass', async () => {
    const v = await verifyForward(TCP_RULE, deps({ firewallVisible: false }));
    assert.equal(v.portProxy, true);
    assert.equal(v.firewall, false);
  });

  test('a UDP-only rule needs no portproxy', async () => {
    const v = await verifyForward({ ...TCP_RULE, protocol: 'UDP' }, deps({ portProxyVisible: false }));
    assert.equal(v.portProxyRequired, false);
    assert.equal(v.firewall, true);
  });
});

describe('apply', () => {
  test('non-Windows is refused without touching anything', async () => {
    const outcome = await applyForward(TCP_RULE, deps({ platform: 'linux' }));
    assert.equal(outcome.ok, false);
    assert.equal(outcome.code, 'UNSUPPORTED_PLATFORM');
  });

  test('elevation can be disabled and then fails closed', async () => {
    const outcome = await applyForward(TCP_RULE, deps({ elevationDisabled: true }));
    assert.equal(outcome.ok, false);
    assert.equal(outcome.code, 'ELEVATION_DISABLED');
  });

  test('a declined UAC prompt is a decline, not a success', async () => {
    for (const outer of [{ outerExit: 1223 }, { outerExit: 1, outerStderr: 'The operation was canceled by the user.' }]) {
      const outcome = await applyForward(TCP_RULE, deps(outer));
      assert.equal(outcome.ok, false);
      assert.equal(outcome.code, 'ELEVATION_DECLINED');
    }
  });

  test('a failed netsh add is reported with the step that failed', async () => {
    const outcome = await applyForward(TCP_RULE, deps({ addExit: 1 }));
    assert.equal(outcome.ok, false);
    assert.equal(outcome.code, 'APPLY_FAILED');
    assert.match(outcome.message, /portproxy-add/);
  });

  test('a missing result log cannot be read as success', async () => {
    const outcome = await applyForward(
      TCP_RULE,
      { ...deps(), runElevated: async () => ({ exitCode: 0, stdout: '', stderr: '', timedOut: false }) }
    );
    assert.equal(outcome.ok, false);
    assert.equal(outcome.code, 'ELEVATION_FAILED');
  });

  test('a timeout is reported as a timeout', async () => {
    const outcome = await applyForward(TCP_RULE, deps({ timedOut: true }));
    assert.equal(outcome.ok, false);
    assert.equal(outcome.code, 'ELEVATION_TIMEOUT');
  });

  test('netsh claiming success is not enough — the read-back must match', async () => {
    const outcome = await applyForward(TCP_RULE, deps({ portProxyVisible: false }));
    assert.equal(outcome.ok, false);
    assert.equal(outcome.code, 'VERIFY_FAILED');
    assert.match(String(outcome.detail), /no portproxy entry/);
  });

  test('only a verified apply reports success', async () => {
    const outcome = await applyForward(TCP_RULE, deps());
    assert.equal(outcome.ok, true);
    assert.ok(outcome.appliedAt);
    assert.equal(outcome.verification.firewall, true);
    assert.equal(outcome.verification.portProxy, true);
  });
});

describe('elevated-apply self-test helpers', () => {
  test('picks the first free port in the private range', () => {
    assert.equal(pickDisposablePort(), SELF_TEST_PORT_MIN);
  });

  test('skips ports that are taken or reserved', () => {
    const taken = [SELF_TEST_PORT_MIN, SELF_TEST_PORT_MIN + 1];
    assert.equal(pickDisposablePort([...taken, SELF_TEST_PORT_MIN + 2]), SELF_TEST_PORT_MIN + 3);
    assert.equal(pickDisposablePort([], [SELF_TEST_PORT_MIN]), SELF_TEST_PORT_MIN + 1);
  });

  test('ignores values that are not usable ports instead of blocking on them', () => {
    assert.equal(pickDisposablePort([0, 70000, NaN, 1.5]), SELF_TEST_PORT_MIN);
  });

  test('returns null only when the entire range is occupied', () => {
    const all = [];
    for (let port = SELF_TEST_PORT_MIN; port <= SELF_TEST_PORT_MAX; port += 1) all.push(port);
    assert.equal(pickDisposablePort(all), null);
  });

  test('the throwaway target maps a loopback port onto itself', () => {
    assert.deepEqual(selfTestTarget(SELF_TEST_PORT_MIN), {
      externalPort: SELF_TEST_PORT_MIN,
      internalPort: SELF_TEST_PORT_MIN,
      internalIp: '127.0.0.1',
      protocol: 'TCP/UDP',
    });
    assert.throws(() => selfTestTarget(0), /Refusing to build a netsh command/);
  });

  test('cleanup commands name the exact rule and mapping to remove', () => {
    const commands = buildCleanupCommands(selfTestTarget(49999));
    assert.match(commands.firewall, /delete rule name="IS King Panel Forward 49999"/);
    assert.match(commands.portProxy, /delete v4tov4 listenport=49999/);
  });
});

describe('revert', () => {
  test('removing a mapping that is gone afterwards succeeds', async () => {
    const outcome = await revertForward(TCP_RULE, deps({ portProxyVisible: false, firewallVisible: false }));
    assert.equal(outcome.ok, true);
  });

  test('a mapping that is still present after the delete is reported as a failure', async () => {
    const outcome = await revertForward(TCP_RULE, deps());
    assert.equal(outcome.ok, false);
    assert.equal(outcome.code, 'REVERT_FAILED');
  });

  test('a declined prompt never claims the port was closed', async () => {
    const outcome = await revertForward(TCP_RULE, deps({ outerExit: 1223 }));
    assert.equal(outcome.ok, false);
    assert.equal(outcome.code, 'ELEVATION_DECLINED');
  });
});
