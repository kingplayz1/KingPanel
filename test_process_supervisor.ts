/**
 * ProcessSupervisor lifecycle tests — deterministic, stub processes, no Java
 * server required. Covers: EULA refusal, missing jar, start → readiness →
 * online, command echo, graceful stop, force kill, crash-before-ready,
 * crash-after-ready, restart, runtime persistence, and reconcile (adopt live
 * matching PID / reject dead / reject foreign process).
 *
 * Run:  npx tsx test_process_supervisor.ts
 * Exits 0 only when every check passes.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn, type ChildProcess } from 'child_process';
import { createProcessSupervisor } from './server/process-supervisor';

const results: { name: string; ok: boolean; detail?: unknown }[] = [];
function check(name: string, ok: boolean, detail?: unknown) {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} :: ${name}${detail === undefined ? '' : ' :: ' + JSON.stringify(detail)}`);
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn: () => boolean | Promise<boolean>, timeoutMs: number, every = 150): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fn()) return true;
    await sleep(every);
  }
  return fn();
}

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'isk-sup-'));
const dataDir = path.join(tmpRoot, 'data');

function makeServerDir(name: string, opts: { eula?: boolean; jar?: boolean } = {}): string {
  const dir = path.join(tmpRoot, name);
  fs.mkdirSync(path.join(dir, 'logs'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'eula.txt'), `eula=${opts.eula === false ? 'false' : 'true'}\n`);
  if (opts.jar !== false) fs.writeFileSync(path.join(dir, 'server.jar'), 'dummy-jar-bytes');
  fs.writeFileSync(path.join(dir, 'server.properties'), 'server-port=25599\n');
  return dir;
}

/** Long-lived stub that emits readiness and handles stdin like a real server. */
const STUB_SCRIPT = `
  console.log('[00:00:01] [Server thread/INFO]: Loading server properties');
  setTimeout(() => console.log('Done (1.23s)! For help, type "help"'), 400);
  process.stdin.on('data', (d) => {
    const s = d.toString();
    if (s.trim() === 'stop') {
      console.log('[00:00:02] [Server thread/INFO]: Stopping the server');
      setTimeout(() => process.exit(0), 100);
    } else {
      console.log('[00:00:03] [Server thread/INFO]: Handled: ' + s.trim());
    }
  });
  setInterval(() => {}, 1000);
`;

async function main() {
  const sup = createProcessSupervisor({ dataDir, runtimeFileName: 'runtime.json' });
  const linesSeen: Array<{ id: string; text: string }> = [];
  const statesSeen: Array<{ id: string; state: string }> = [];
  sup.on('line', (id: string, l: { text: string }) => linesSeen.push({ id, text: l.text }));
  sup.on('state', (id: string, state: string) => statesSeen.push({ id, state }));

  // --- S1: EULA refusal -----------------------------------------------------
  const dirNoEula = makeServerDir('NoEula', { eula: false });
  const r1 = await sup.start('NoEula', {
    serverDir: dirNoEula,
    commandOverride: { exe: process.execPath, args: ['-e', STUB_SCRIPT, dirNoEula] },
  });
  check('start refused when eula!=true', r1.ok === false && /EULA/i.test(r1.error || ''), r1.error);

  // --- S2: missing jar refusal ---------------------------------------------
  const dirNoJar = makeServerDir('NoJar', { jar: false });
  const r2b = await sup.start('NoJar', { serverDir: dirNoJar });
  check('start refused when no jar exists', r2b.ok === false && /jar/i.test(r2b.error || ''), r2b.error);

  // --- S3: start → readiness → online --------------------------------------
  const dirA = makeServerDir('Alpha');
  const r3 = await sup.start('Alpha', {
    serverDir: dirA,
    commandOverride: { exe: process.execPath, args: ['-e', STUB_SCRIPT, dirA] },
  });
  check('start returns ok + pid', Boolean(r3.ok && r3.pid), r3);
  const online = await waitFor(() => sup.getSnapshot('Alpha')?.state === 'online', 8000);
  check('readiness detected → state online', online, sup.getSnapshot('Alpha'));
  const hasReadyLine = sup.getConsole('Alpha').some((l) => l.text.includes('Done (1.23s)'));
  check('console captured readiness line', hasReadyLine);
  const runtimeOnDisk = fs.existsSync(path.join(dataDir, 'runtime.json'))
    ? JSON.parse(fs.readFileSync(path.join(dataDir, 'runtime.json'), 'utf8'))
    : null;
  check('runtime persisted with pid', Boolean(runtimeOnDisk?.servers?.Alpha?.pid === r3.pid), runtimeOnDisk);

  // Idempotent start
  const r3b = await sup.start('Alpha', { serverDir: dirA });
  check('second start is idempotent (alreadyRunning)', r3b.ok === true && r3b.alreadyRunning === true, r3b);

  // --- S4: console command --------------------------------------------------
  const c1 = sup.sendCommand('Alpha', 'list');
  check('command accepted while online', c1.ok === true, c1);
  const echoSeen = await waitFor(
    () => sup.getConsole('Alpha').some((l) => l.text === '> list' && l.level === 'EXEC'),
    4000
  );
  check('command echoed as EXEC line', echoSeen);
  const replySeen = await waitFor(
    () => sup.getConsole('Alpha').some((l) => l.text.includes('Handled: list')),
    4000
  );
  check('stub replied on stdout', replySeen);
  const c2 = sup.sendCommand('Alpha', 'say hi\nlist'); // newline injection attempt
  const sanitizedEcho = await waitFor(
    () => sup.getConsole('Alpha').some((l) => l.text === '> say hilist' && l.level === 'EXEC'),
    4000
  );
  check(
    'command with newline is sanitized before stdin write',
    c2.ok === true && sanitizedEcho,
    { result: c2, echo: sanitizedEcho }
  );

  // --- S5: metrics ----------------------------------------------------------
  const metrics = await sup.getMetrics('Alpha');
  check('metrics sampled for live pid', Boolean(metrics && metrics.ramMb > 0 && Number.isFinite(metrics.cpuPct)), metrics);

  // --- S6: graceful stop ----------------------------------------------------
  await sup.stop('Alpha', { graceMs: 10_000 });
  const stopped = await waitFor(() => sup.getSnapshot('Alpha')?.state === 'stopped', 8000);
  check('graceful stop via stdin → stopped', stopped, sup.getSnapshot('Alpha'));
  let alphaAlive = true;
  try {
    process.kill(r3.pid!, 0);
  } catch {
    alphaAlive = false;
  }
  check('process really exited (pid gone)', !alphaAlive);

  // --- S7: crash before ready -----------------------------------------------
  const dirB = makeServerDir('Bravo');
  await sup.start('Bravo', {
    serverDir: dirB,
    commandOverride: { exe: process.execPath, args: ['-e', "console.log('booting'); setTimeout(() => process.exit(7), 300);", dirB] },
  });
  const crashedEarly = await waitFor(() => sup.getSnapshot('Bravo')?.state === 'crashed', 8000);
  check('exit before readiness → crashed', crashedEarly, sup.getSnapshot('Bravo'));
  check('crash exit code recorded', sup.getSnapshot('Bravo')?.lastExitCode === 7, sup.getSnapshot('Bravo')?.lastExitCode);

  // --- S8: unexpected exit after ready --------------------------------------
  const dirC = makeServerDir('Charlie');
  await sup.start('Charlie', {
    serverDir: dirC,
    commandOverride: {
      exe: process.execPath,
      args: ['-e', "console.log('Done (0.50s)!'); setTimeout(() => process.exit(3), 600);", dirC],
    },
  });
  const onlineThenCrash = await waitFor(() => sup.getSnapshot('Charlie')?.state === 'online', 5000);
  const crashedLate = await waitFor(() => sup.getSnapshot('Charlie')?.state === 'crashed', 8000);
  check('went online first', onlineThenCrash);
  check('unexpected exit after online → crashed (code 3)', crashedLate && sup.getSnapshot('Charlie')?.lastExitCode === 3, sup.getSnapshot('Charlie'));

  // --- S9: restart (stop → start with stored opts) --------------------------
  const dirD = makeServerDir('Delta');
  const r9 = await sup.start('Delta', {
    serverDir: dirD,
    commandOverride: { exe: process.execPath, args: ['-e', STUB_SCRIPT, dirD] },
  });
  await waitFor(() => sup.getSnapshot('Delta')?.state === 'online', 8000);
  await sup.restart('Delta');
  const restarted = await waitFor(
    () => sup.getSnapshot('Delta')?.state === 'online' && sup.getSnapshot('Delta')?.pid !== r9.pid,
    10_000
  );
  check('restart: stopped then started with a NEW pid', restarted, sup.getSnapshot('Delta'));

  // --- S10: force kill (stub ignores stdin) ---------------------------------
  const dirE = makeServerDir('Echo');
  const r10 = await sup.start('Echo', {
    serverDir: dirE,
    commandOverride: {
      exe: process.execPath,
      args: ['-e', "console.log('Done (0.50s)!'); process.stdin.resume(); setInterval(() => {}, 1000);", dirE],
    },
  });
  await waitFor(() => sup.getSnapshot('Echo')?.state === 'online', 5000);
  await sup.stop('Echo', { force: true });
  const killed = await waitFor(() => sup.getSnapshot('Echo')?.state === 'stopped', 8000);
  check('force kill terminates process tree', killed, sup.getSnapshot('Echo'));
  let echoAlive = true;
  try {
    process.kill(r10.pid!, 0);
  } catch {
    echoAlive = false;
  }
  check('force-killed pid really gone', !echoAlive);

  // --- S11: reconcile / adoption -------------------------------------------
  const dirF = makeServerDir('Foxtrot');
  const r11 = await sup.start('Foxtrot', {
    serverDir: dirF,
    commandOverride: { exe: process.execPath, args: ['-e', STUB_SCRIPT, dirF] },
  });
  await waitFor(() => sup.getSnapshot('Foxtrot')?.state === 'online', 8000);

  // simulate a dead entry + a foreign (non-matching cmdline) entry
  const rtPath = path.join(dataDir, 'runtime.json');
  const rt = JSON.parse(fs.readFileSync(rtPath, 'utf8'));
  rt.servers['DeadOne'] = { pid: 999999999, dir: path.join(tmpRoot, 'DeadOne'), startedAt: Date.now(), exe: '', args: [] };
  const foreign: ChildProcess = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 20000)'], { stdio: 'ignore' });
  rt.servers['ForeignOne'] = { pid: foreign.pid!, dir: path.join(tmpRoot, 'NotMyDir'), startedAt: Date.now(), exe: '', args: [] };
  fs.writeFileSync(rtPath, JSON.stringify(rt, null, 2));

  const sup2 = createProcessSupervisor({ dataDir, runtimeFileName: 'runtime.json' });
  await sup2.reconcile();
  const adopted = sup2.getSnapshot('Foxtrot');
  check('reconcile adopts live matching process', adopted?.state === 'online' && adopted?.adopted === true && adopted?.pid === r11.pid, adopted);
  check('adopted server has no stdin (attached=false)', adopted?.attached === false);
  const cmdAfterAdopt = sup2.sendCommand('Foxtrot', 'list');
  check('command on adopted server refused with clear error', cmdAfterAdopt.ok === false && /reattach/i.test(cmdAfterAdopt.error || ''), cmdAfterAdopt.error);
  const deadNotAdopted = !sup2.getSnapshot('DeadOne') || sup2.getSnapshot('DeadOne')!.state !== 'online';
  check('dead pid not adopted', deadNotAdopted);
  const foreignNotAdopted = !sup2.getSnapshot('ForeignOne') || sup2.getSnapshot('ForeignOne')!.state !== 'online';
  check('foreign process (cmdline mismatch) not adopted', foreignNotAdopted);
  const rtAfter = JSON.parse(fs.readFileSync(rtPath, 'utf8'));
  check('runtime file cleaned of unverifiable entries', !rtAfter.servers['DeadOne'] && !rtAfter.servers['ForeignOne'], Object.keys(rtAfter.servers || {}));

  // adoption tail: adopted console resumes from the server's own latest.log
  const logPath = path.join(dirF, 'logs', 'latest.log');
  fs.appendFileSync(logPath, '[12:00:00] [Server thread/INFO]: tail probe line\n');
  const tailSeen = await waitFor(
    () => sup2.getConsole('Foxtrot').some((l) => l.text.includes('tail probe line')),
    5000
  );
  check('adopted console tails logs/latest.log', tailSeen);

  // cleanup
  await sup2.stop('Foxtrot', { force: true });
  await waitFor(() => sup2.getSnapshot('Foxtrot')?.state === 'stopped', 6000);
  try {
    foreign.kill();
  } catch {
    // already exited
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('FATAL', err);
  process.exit(1);
});
