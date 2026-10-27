/**
 * End-to-end lifecycle test over HTTP against a running backend:
 * real Paper 1.21.4 server in KingServers/JarTest (port 25581).
 *
 * Prereq:  node server.cjs   (backend on 127.0.0.1:3000)
 * Run:     node test_http_lifecycle.mjs
 *
 * Verifies: registry, start with readiness detection, live-state contract
 * (fields the React UI reads), console command round-trip, SSE stream,
 * real logs/latest.log parsing, setup persistence, graceful stop, and that
 * the OS process and port are actually gone afterwards.
 * Exits 0 only when every check passes.
 */
const BASE = process.env.BASE || 'http://127.0.0.1:3000';
const SERVER_ID = 'JarTest';
const SERVER_PORT = 25581;

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'} :: ${name}${detail === undefined ? '' : ' :: ' + JSON.stringify(detail).slice(0, 400)}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function get(pathname) {
  const r = await fetch(BASE + pathname);
  const j = await r.json().catch(() => null);
  return { status: r.status, body: j };
}
async function post(pathname, payload) {
  const r = await fetch(BASE + pathname, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const j = await r.json().catch(() => null);
  return { status: r.status, body: j };
}
async function waitFor(fn, timeoutMs, every = 1500) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const v = await fn();
    if (v) return v;
    await sleep(every);
  }
  return null;
}

// --- 1. registry ------------------------------------------------------------
const reg = await get('/api/servers');
const jarTest = reg.body?.servers?.find((s) => s.id === SERVER_ID);
check('GET /api/servers lists JarTest with runtime', reg.status === 200 && Boolean(jarTest), jarTest);
check('registry reports eulaAccepted + detected mainFile', jarTest?.eulaAccepted === true && jarTest?.mainFile === 'paper-1.21.4.jar', { eula: jarTest?.eulaAccepted, mainFile: jarTest?.mainFile });

// --- 2. setup contract ------------------------------------------------------
const setup0 = await get(`/api/server-runtime/setup?serverId=${SERVER_ID}&ramMaxGb=2`);
check('GET setup returns full setup shape', setup0.body?.ok === true && typeof setup0.body?.setup?.startupCommand === 'string' && typeof setup0.body?.setup?.additionalArguments === 'string', setup0.body?.setup);
const setupSave = await post('/api/server-runtime/setup', {
  serverId: SERVER_ID,
  setup: { mainFile: 'paper-1.21.4.jar', additionalArguments: '--nogui', additionalFlags: '' },
});
const setup1 = await get(`/api/server-runtime/setup?serverId=${SERVER_ID}&ramMaxGb=2`);
check('POST setup persists and is returned', setupSave.body?.ok === true && setup1.body?.setup?.mainFile === 'paper-1.21.4.jar', setup1.body?.setup?.mainFile);

// --- 3. SSE capture (started before power-on so boot events are captured) ----
const sseEvents = [];
const sseAbort = new AbortController();
const ssePromise = (async () => {
  try {
    const r = await fetch(`${BASE}/api/servers/${SERVER_ID}/events`, { signal: sseAbort.signal });
    const reader = r.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const evMatch = block.match(/^event: (.+)$/m);
        const dataMatch = block.match(/^data: (.+)$/m);
        if (dataMatch) sseEvents.push({ event: evMatch ? evMatch[1] : 'data', data: JSON.parse(dataMatch[1]) });
      }
    }
  } catch {
    // aborted — expected at the end
  }
})();

// --- 4. start (REAL java process) ------------------------------------------
const start = await post('/api/server-runtime/power', { serverId: SERVER_ID, serverName: SERVER_ID, action: 'start', ramMaxGb: 2 });
check('POST power start → ok + real pid', start.body?.ok === true && typeof start.body?.pid === 'number', start.body);

const online = await waitFor(async () => {
  const s = await get(`/api/server-runtime/live-state?serverId=${SERVER_ID}&serverName=${SERVER_ID}&port=${SERVER_PORT}&ramMaxGb=2`);
  return s.body?.status === 'running' ? s : null;
}, 300_000, 2000);
check('readiness detected → live-state running (real "Done (" line)', Boolean(online), online?.body && { uptime: online.body.uptimeFormatted, pid: online.body.pid, state: online.body.state });
check('live-state carries UI contract fields', Boolean(online && typeof online.body.uptimeFormatted === 'string' && typeof online.body.cpuUsagePct === 'number' && typeof online.body.ramUsedMb === 'number' && typeof online.body.storageUsedMb === 'number' && Array.isArray(online.body.history) && Array.isArray(online.body.consoleLogs)), online?.body && { cpu: online.body.cpuUsagePct, ram: online.body.ramUsedMb, storage: online.body.storageUsedMb, logs: online.body.consoleLogs.length, history: online.body.history.length });
check('console contains the real readiness line', Boolean(online?.body?.consoleLogs?.some((l) => /Done \(/.test(l.text))));
check('metrics are real (RAM > 0, uptime > 0)', Boolean(online && online.body.ramUsedMb > 0 && /0h 00m 0[1-9]s|0h 0[0-9]m/.test(online.body.uptimeFormatted)), { ram: online?.body?.ramUsedMb, up: online?.body?.uptimeFormatted });

// --- 5. console command round-trip -----------------------------------------
const cmd = await post('/api/server-runtime/command', { serverId: SERVER_ID, command: 'list' });
const reply = await waitFor(async () => {
  const s = await get(`/api/server-runtime/live-state?serverId=${SERVER_ID}&serverName=${SERVER_ID}&ramMaxGb=2`);
  const logs = s.body?.consoleLogs || [];
  return logs.some((l) => l.level === 'EXEC' && l.text.includes('list')) && logs.some((l) => /players?|There are/i.test(l.text)) ? true : null;
}, 20_000, 1200);
check('command accepted + server responded in console', cmd.body?.ok === true && Boolean(reply));

// --- 6. real log file view --------------------------------------------------
const logs = await get(`/api/logs/realtime?serverId=${SERVER_ID}&serverName=${SERVER_ID}`);
const rowOk = Array.isArray(logs.body?.lines) && logs.body.lines.length > 0 && typeof logs.body.lines[0].lineNum === 'number' && typeof logs.body.lines[0].rawText === 'string';
check('GET /api/logs/realtime parses the REAL latest.log', logs.body?.ok === true && rowOk, { total: logs.body?.totalLines, first: logs.body?.lines?.[0]?.rawText?.slice(0, 80) });

// --- 7. SSE received live events -------------------------------------------
sseAbort.abort();
await ssePromise.catch(() => {});
const stateEvents = sseEvents.filter((e) => e.event === 'state');
const consoleEvents = sseEvents.filter((e) => e.event === 'console');
check('SSE stream delivered state + console events', stateEvents.length >= 1 && consoleEvents.length >= 1, { states: stateEvents.map((e) => e.data.state), console: consoleEvents.length });

// --- 8. graceful stop -------------------------------------------------------
const stop = await post('/api/server-runtime/power', { serverId: SERVER_ID, action: 'stop' });
check('POST power stop accepted', stop.body?.ok === true, stop.body);
const stopped = await waitFor(async () => {
  const s = await get(`/api/server-runtime/live-state?serverId=${SERVER_ID}&serverName=${SERVER_ID}&ramMaxGb=2`);
  return s.body?.status === 'stopped' && !s.body?.crashed ? s : null;
}, 120_000, 2000);
check('graceful stop → live-state stopped (not crashed)', Boolean(stopped), stopped?.body && { state: stopped.body.state, exit: stopped.body.lastExitCode, reason: stopped.body.lastExitReason });

// process and port must really be gone
const { execSync } = await import('child_process');
let processGone = false;
try {
  const pid = start.body.pid;
  execSync(`powershell -NoProfile -Command "Get-Process -Id ${pid} -ErrorAction SilentlyContinue"`, { stdio: 'ignore' });
  // command succeeds either way; parse output instead:
  processGone = false;
} catch {
  processGone = true;
}
const out = execSync(`powershell -NoProfile -Command "if (Get-Process -Id ${start.body.pid} -ErrorAction SilentlyContinue) { 'ALIVE' } else { 'GONE' }"`, { encoding: 'utf8' });
check('OS process really exited', out.includes('GONE'), out.trim());
const portOut = execSync(`netstat -ano | findstr :${SERVER_PORT} || true`, { encoding: 'utf8', shell: 'bash' });
check(`port ${SERVER_PORT} released`, !/LISTENING/.test(portOut), portOut.trim().slice(0, 200));
void processGone;

// --- 9. idempotent stop + unknown folder ------------------------------------
const stop2 = await post('/api/server-runtime/power', { serverId: SERVER_ID, action: 'stop' });
check('second stop reports alreadyStopped', stop2.body?.ok === true && stop2.body?.alreadyStopped === true, stop2.body);
const missing = await post('/api/server-runtime/power', { serverId: 'DoesNotExist_XYZ', action: 'start' });
check('unknown server folder → 404 with clear error', missing.status === 404 && /not found/i.test(missing.body?.error || ''), missing.body);

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
