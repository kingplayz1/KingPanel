/**
 * IS King Panel — Process Supervisor
 *
 * Manages REAL Java server processes:
 *  - spawns `java` with a validated argv (never a shell string, never an
 *    arbitrary executable path supplied by the renderer)
 *  - detects readiness from actual server output ("Done (…)!"/"Listening on …"),
 *    never from a fixed timer
 *  - graceful stop by writing `stop` to the process stdin, with a grace period
 *    followed by a real tree kill (`taskkill /T /F` on Windows)
 *  - crash detection from real exit codes
 *  - console capture from live stdout/stderr (attached) or by tailing the
 *    server's own logs/latest.log (adopted after an app restart)
 *  - runtime persistence + startup reconciliation: PIDs are re-verified against
 *    their process command line before being adopted — a saved state never
 *    claims "running" unless a matching OS process actually exists
 *
 * Test hook: `commandOverride` replaces the java argv entirely. It is an
 * internal option for tests only and must never be accepted from HTTP input.
 */
import { spawn, execFile, type ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { EventEmitter } from 'events';

export type ServerRunState = 'stopped' | 'starting' | 'online' | 'stopping' | 'crashed';

export interface ConsoleLine {
  id: string;
  time: string;
  level: string;
  text: string;
  highlightBox?: 'warn' | 'join' | 'error' | 'broadcast';
}

export interface HistoryPoint {
  time: string;
  cpu: number;
  memoryMb: number;
  netRxKbps: number;
  netTxKbps: number;
}

export interface StartOptions {
  serverDir: string;
  xmxGb?: number;
  mainFile?: string;
  jvmArgs?: string[];
  programArgs?: string[];
  javaPath?: string;
  startupTimeoutMs?: number;
  /** INTERNAL TEST HOOK — never accept this from HTTP input. */
  commandOverride?: { exe: string; args: string[] };
}

export interface SupervisorSnapshot {
  id: string;
  state: ServerRunState;
  pid?: number;
  adopted: boolean;
  attached: boolean;
  startedAt?: number;
  readyAt?: number;
  lastExitCode?: number | null;
  lastExitReason?: string;
  restartPending: boolean;
}

interface PersistedRuntime {
  pid: number;
  dir: string;
  startedAt: number;
  exe: string;
  args: string[];
}

interface Sample {
  cpuSec: number;
  rssMb: number;
}

const READY_PATTERN = /Done \([\d.]+s\)!|Listening on \/|Listening on 0\.0\.0\.0/;
const MAX_CONSOLE_LINES = 500;
const MAX_HISTORY = 60;
const DEFAULT_STARTUP_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_STOP_GRACE_MS = 60_000;
const METRICS_CACHE_MS = 2_000;

function nowTime(): string {
  return new Date().toTimeString().slice(0, 8);
}

export interface JavaCandidate {
  path: string;
  major: number;
}

function probeJavaVersion(exe: string): Promise<number | null> {
  return new Promise((resolve) => {
    execFile(
      exe,
      ['-version'],
      { timeout: 6000, windowsHide: true },
      (err, _stdout, stderr) => {
        if (err && !stderr) return resolve(null);
        const text = String(stderr || _stdout || '');
        const m = text.match(/version "(\d+)(?:\.(\d+))?/);
        if (!m) return resolve(null);
        const major = m[1] === '1' ? Number(m[2]) : Number(m[1]);
        resolve(Number.isFinite(major) ? major : null);
      }
    );
  });
}

/**
 * Java major-version preference order for a given server jar name.
 * Derived from Minecraft's documented Java requirements; keeps modern
 * servers away from Java 25+ (Paper 1.21.x caps at Java 24).
 */
export function javaPreferenceForJar(jarName?: string): number[] {
  const m = (jarName || '').match(/(\d+)\.(\d+)(?:\.(\d+))?/);
  if (!m) return [21, 17, 24, 11, 8];
  const minor = Number(m[2]);
  if (minor <= 16) return [8, 11, 17, 21]; // legacy MC needs Java 8
  if (minor === 17) return [17, 16, 21, 24];
  if (minor >= 18 && minor <= 20) return [17, 21, 24];
  if (minor >= 21) return [21, 24, 17]; // 1.21+ needs 21+, capped at 24
  return [21, 17, 24, 11, 8];
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Parse one raw line of server console output into a frontend ConsoleLine. */
export function parseConsoleLine(raw: string, counter: number): ConsoleLine {
  const line = raw.replace(/\r$/, '');
  const base: ConsoleLine = { id: `cl-${counter}`, time: nowTime(), level: 'INFO', text: line };

  // Vanilla/Paper: [HH:MM:SS] [Server thread/INFO]: message
  const m = line.match(/^\[(\d{2}:\d{2}:\d{2})\]\s+\[([^\]]+)\]\/(INFO|WARN|ERROR|DEBUG|TRACE)\]:\s?(.*)$/);
  if (m) {
    const [, time, , sev, text] = m;
    base.time = time;
    base.text = text;
    base.level = sev === 'WARN' ? 'WARN' : sev === 'ERROR' ? 'ERROR' : 'INFO';
    if (sev === 'WARN') base.highlightBox = 'warn';
    if (sev === 'ERROR') base.highlightBox = 'error';
  } else if (/^\[(\d{2}:\d{2}:\d{2})\]/.test(line)) {
    base.time = line.slice(1, 9);
    if (/\bERROR\b|Exception|FATAL/i.test(line)) {
      base.level = 'ERROR';
      base.highlightBox = 'error';
    } else if (/\bWARN(ING)?\b/i.test(line)) {
      base.level = 'WARN';
      base.highlightBox = 'warn';
    }
  } else if (/joined the game|logged in with entity/i.test(line)) {
    base.level = 'JOIN';
    base.highlightBox = 'join';
  } else if (/left the game|lost connection/i.test(line)) {
    base.level = 'JOIN';
    base.highlightBox = 'join';
  } else if (/^<[^>]+>/.test(line)) {
    base.level = 'CHAT';
  } else if (/\b(ERROR|Exception|FATAL)\b/.test(line)) {
    base.level = 'ERROR';
    base.highlightBox = 'error';
  } else if (/\bWARN(ING)\b/.test(line)) {
    base.level = 'WARN';
    base.highlightBox = 'warn';
  }
  return base;
}

interface ManagedServer {
  id: string;
  dir: string;
  state: ServerRunState;
  child?: ChildProcess;
  pid?: number;
  startedAt?: number;
  readyAt?: number;
  lastExitCode?: number | null;
  lastExitReason?: string;
  adopted: boolean;
  attached: boolean;
  restartPending: boolean;
  startOpts?: StartOptions;
  console: ConsoleLine[];
  lineCounter: number;
  readinessBuf: string;
  startupTimer?: NodeJS.Timeout;
  stopTimer?: NodeJS.Timeout;
  tailTimer?: NodeJS.Timeout;
  tailOffset: number;
  lastSample?: Sample;
  lastSampleAt?: number;
  lastMetricsAt?: number;
  cachedMetrics?: { cpuPct: number; ramMb: number; at: number };
  storageMb?: number;
  storageAt?: number;
  history: HistoryPoint[];
  javaDescribe?: string;
  jarName?: string;
}

export class ProcessSupervisor extends EventEmitter {
  private servers = new Map<string, ManagedServer>();
  private runtimeFile: string;

  constructor(opts: { dataDir: string; runtimeFileName?: string }) {
    super();
    const dir = opts.dataDir;
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch {
      // best effort — persistence degrades to in-memory only
    }
    this.runtimeFile = path.join(dir, opts.runtimeFileName || 'server_runtime.json');
  }

  // ------------------------------------------------------------------ state

  getSnapshot(id: string): SupervisorSnapshot | null {
    const s = this.servers.get(id);
    if (!s) return null;
    return {
      id,
      state: s.state,
      pid: s.pid,
      adopted: s.adopted,
      attached: s.attached,
      startedAt: s.startedAt,
      readyAt: s.readyAt,
      lastExitCode: s.lastExitCode,
      lastExitReason: s.lastExitReason,
      restartPending: s.restartPending,
    };
  }

  listSnapshots(): SupervisorSnapshot[] {
    return [...this.servers.keys()].map((id) => this.getSnapshot(id)!);
  }

  getConsole(id: string): ConsoleLine[] {
    return this.servers.get(id)?.console.slice() ?? [];
  }

  getHistory(id: string): HistoryPoint[] {
    return this.servers.get(id)?.history.slice() ?? [];
  }

  private ensure(id: string, dir: string): ManagedServer {
    let s = this.servers.get(id);
    if (!s) {
      s = {
        id,
        dir,
        state: 'stopped',
        adopted: false,
        attached: false,
        restartPending: false,
        console: [],
        lineCounter: 0,
        readinessBuf: '',
        tailOffset: 0,
        history: [],
      };
      this.servers.set(id, s);
    }
    s.dir = dir;
    return s;
  }

  private setState(s: ManagedServer, state: ServerRunState, extra: Record<string, unknown> = {}) {
    s.state = state;
    this.emit('state', s.id, state, { pid: s.pid, ...extra });
  }

  private pushLine(s: ManagedServer, raw: string, opts?: { system?: boolean }) {
    const line = parseConsoleLine(raw, ++s.lineCounter);
    s.console.push(line);
    if (s.console.length > MAX_CONSOLE_LINES) s.console.splice(0, s.console.length - MAX_CONSOLE_LINES);
    this.emit('line', s.id, line);
    return line;
  }

  private pushSystemLine(s: ManagedServer, text: string, level: 'INFO' | 'WARN' | 'ERROR' = 'INFO') {
    const line: ConsoleLine = {
      id: `cl-${++s.lineCounter}`,
      time: nowTime(),
      level,
      text: `[KingPanel] ${text}`,
      highlightBox: level === 'WARN' ? 'warn' : level === 'ERROR' ? 'error' : undefined,
    };
    s.console.push(line);
    if (s.console.length > MAX_CONSOLE_LINES) s.console.splice(0, s.console.length - MAX_CONSOLE_LINES);
    this.emit('line', s.id, line);
    return line;
  }

  // ------------------------------------------------------------ persistence

  private readRuntimeFile(): Record<string, PersistedRuntime> {
    try {
      if (!fs.existsSync(this.runtimeFile)) return {};
      const data = JSON.parse(fs.readFileSync(this.runtimeFile, 'utf8'));
      return data && typeof data === 'object' && data.servers ? data.servers : {};
    } catch {
      return {};
    }
  }

  private persist() {
    const servers: Record<string, PersistedRuntime> = {};
    for (const [id, s] of this.servers) {
      if ((s.state === 'starting' || s.state === 'online' || s.state === 'stopping') && s.pid) {
        servers[id] = {
          pid: s.pid,
          dir: s.dir,
          startedAt: s.startedAt || Date.now(),
          exe: '',
          args: [],
        };
      }
    }
    try {
      fs.writeFileSync(this.runtimeFile, JSON.stringify({ v: 1, servers }, null, 2), 'utf8');
    } catch {
      // non-fatal
    }
  }

  /**
   * Startup reconciliation: verify every persisted PID against a real OS
   * process whose command line contains the server directory, then adopt it
   * (console resumes via log tail). Anything unverifiable is dropped.
   */
  async reconcile(): Promise<void> {
    const persisted = this.readRuntimeFile();
    for (const [id, rec] of Object.entries(persisted)) {
      let alive = false;
      try {
        process.kill(rec.pid, 0);
        alive = true;
      } catch {
        alive = false;
      }
      if (!alive) {
        this.pushSystemLine(
          this.ensure(id, rec.dir),
          `Saved runtime for PID ${rec.pid} is no longer running — state reset to stopped.`
        );
        continue;
      }
      const verified = await this.verifyPidBelongsToServer(rec.pid, rec.dir);
      if (!verified) {
        this.pushSystemLine(
          this.ensure(id, rec.dir),
          `PID ${rec.pid} no longer matches this server directory (PID reuse?) — not adopted.`,
          'WARN'
        );
        continue;
      }
      const s = this.ensure(id, rec.dir);
      s.pid = rec.pid;
      s.startedAt = rec.startedAt;
      s.adopted = true;
      s.attached = false;
      s.readyAt = undefined;
      this.setState(s, 'online');
      this.pushSystemLine(
        s,
        `Reattached to running server process PID ${rec.pid} after restart. Console resumes from logs/latest.log; stdin input is unavailable until the server is restarted from the panel.`
      );
      this.startLogTail(s);
    }
    this.persist();
  }

  private async verifyPidBelongsToServer(pid: number, dir: string): Promise<boolean> {
    if (process.platform !== 'win32') return true; // no cheap cross-check; PID liveness already verified
    return new Promise((resolve) => {
      execFile(
        'powershell.exe',
        [
          '-NoProfile',
          '-Command',
          `(Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}' -ErrorAction SilentlyContinue).CommandLine`,
        ],
        { timeout: 5000, windowsHide: true },
        (err, stdout) => {
          if (err) return resolve(false);
          const cmdline = String(stdout || '').toLowerCase();
          resolve(cmdline.includes(dir.toLowerCase()));
        }
      );
    });
  }

  // ------------------------------------------------------------ java runtimes

  private javaCache?: Promise<JavaCandidate[]>;

  /** Scan well-known JDK locations + PATH and probe each `java -version`. */
  private detectJavas(): Promise<JavaCandidate[]> {
    if (!this.javaCache) {
      this.javaCache = (async () => {
        const exeName = process.platform === 'win32' ? 'java.exe' : 'java';
        const candidates: string[] = [];
        const push = (p: string) => candidates.push(p);
        if (process.env.JAVA_HOME) push(path.join(process.env.JAVA_HOME, 'bin', exeName));
        const pf = process.env['ProgramFiles'] || 'C:\\Program Files';
        const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
        for (const base of [
          path.join(pf, 'Java'),
          path.join(pf86, 'Java'),
          path.join(pf, 'Eclipse Adoptium'),
          path.join(pf, 'Microsoft'),
          path.join(pf, 'Zulu'),
          path.join(pf, 'Amazon Corretto'),
          path.join(pf, 'BellSoft'),
        ]) {
          try {
            for (const entry of fs.readdirSync(base)) push(path.join(base, entry, 'bin', exeName));
          } catch {
            // location not present
          }
        }
        push(exeName); // PATH fallback
        const found: JavaCandidate[] = [];
        for (const exe of new Set(candidates)) {
          const major = await probeJavaVersion(exe);
          if (major) found.push({ path: exe, major });
        }
        return found;
      })();
    }
    return this.javaCache;
  }

  /** Pick a Java runtime compatible with the server's Minecraft version. */
  async selectJava(jarName?: string, override?: string): Promise<{ exe: string; describe: string } | { error: string }> {
    if (override) {
      const exists = fs.existsSync(override);
      const major = exists ? await probeJavaVersion(override) : null;
      if (!exists || !major) return { error: `Configured Java runtime not found or unusable: ${override}` };
      return { exe: override, describe: `Java ${major} (${override}) — configured for this server` };
    }
    const installed = await this.detectJavas();
    if (installed.length === 0) {
      return { exe: 'java', describe: 'java from PATH (no installed runtime could be probed)' };
    }
    const prefs = javaPreferenceForJar(jarName);
    for (const want of prefs) {
      const hit = installed.find((c) => c.major === want);
      if (hit) return { exe: hit.path, describe: `Java ${hit.major} (${hit.path})` };
    }
    // No exact match: never default to Java 25+ (newer servers cap at 24).
    const safe = installed.filter((c) => c.major <= 24).sort((a, b) => b.major - a.major)[0];
    if (safe) return { exe: safe.path, describe: `Java ${safe.major} (${safe.path}) — closest compatible installed runtime` };
    const any = installed[installed.length - 1];
    return { exe: any.path, describe: `Java ${any.major} (${any.path}) — no compatible runtime found, start may fail` };
  }

  // ------------------------------------------------------------------ start

  private eulaAccepted(dir: string): boolean {
    try {
      const eula = fs.readFileSync(path.join(dir, 'eula.txt'), 'utf8');
      return /^\s*eula\s*=\s*true\s*$/im.test(eula);
    } catch {
      return false;
    }
  }

  private resolveJar(dir: string, mainFile?: string): { jar?: string; error?: string } {
    const wanted = (mainFile || 'server.jar').trim();
    if (wanted && fs.existsSync(path.join(dir, wanted))) return { jar: wanted };
    const jars = fs
      .readdirSync(dir)
      .filter((f) => f.toLowerCase().endsWith('.jar') && fs.statSync(path.join(dir, f)).isFile());
    if (jars.length === 1) return { jar: jars[0] };
    if (jars.length === 0) {
      return { error: `No server jar found in ${dir}. Upload a jar or set "Main File" in Setup.` };
    }
    return {
      error: `Multiple jars found (${jars.join(', ')}). Set "Main File" in Setup to choose one.`,
    };
  }

  async start(id: string, opts: StartOptions): Promise<SupervisorSnapshot & { ok: boolean; error?: string; alreadyRunning?: boolean }> {
    const dir = opts.serverDir;
    const existing = this.servers.get(id);
    if (existing && (existing.state === 'starting' || existing.state === 'online' || existing.state === 'stopping')) {
      return { ok: true, alreadyRunning: true, ...(this.getSnapshot(id)!) };
    }
    if (!fs.existsSync(dir)) {
      return { ok: false, error: `Server directory not found: ${dir}`, ...(this.getSnapshot(id) || { id, state: 'stopped' as const, adopted: false, attached: false, restartPending: false }) };
    }
    if (!this.eulaAccepted(dir)) {
      return {
        ok: false,
        error: 'Minecraft EULA not accepted. Set eula=true in eula.txt (accept the EULA) before starting.',
        ...(this.getSnapshot(id) || { id, state: 'stopped' as const, adopted: false, attached: false, restartPending: false }),
      };
    }

    const s = this.ensure(id, dir);
    s.startOpts = opts;
    s.restartPending = false;

    let exe: string;
    let args: string[];
    if (opts.commandOverride) {
      exe = opts.commandOverride.exe;
      args = opts.commandOverride.args;
    } else {
      const jar = this.resolveJar(dir, opts.mainFile);
      if (jar.error) {
        return { ok: false, error: jar.error, ...(this.getSnapshot(id)!) };
      }
      const selected = await this.selectJava(jar.jar, opts.javaPath || process.env.ISK_JAVA_PATH || undefined);
      if ('error' in selected) {
        return { ok: false, error: selected.error, ...(this.getSnapshot(id)!) };
      }
      exe = selected.exe;
      const xmx = Math.max(1, Math.round(opts.xmxGb || 4));
      const xms = Math.min(2, xmx);
      args = [
        `-Xms${xms}G`,
        `-Xmx${xmx}G`,
        ...(opts.jvmArgs || []),
        '-jar',
        jar.jar!,
        ...(opts.programArgs && opts.programArgs.length ? opts.programArgs : ['nogui']),
      ];
      s.javaDescribe = selected.describe;
      s.jarName = jar.jar!;
    }

    let child: ChildProcess;
    try {
      child = spawn(exe, args, {
        cwd: dir,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        env: { ...process.env },
      });
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : 'Failed to spawn process',
        ...(this.getSnapshot(id) || { id, state: 'stopped' as const, adopted: false, attached: false, restartPending: false }),
      };
    }

    if (!child.pid) {
      return { ok: false, error: 'Process failed to start (no PID)', ...(this.getSnapshot(id)!) };
    }

    s.child = child;
    child.stdin?.on('error', () => {
      // Broken pipe on stdin (server exited or stdin ended) — ignore; stop()
      // handles fallback termination when the write path matters.
    });
    s.pid = child.pid;
    s.startedAt = Date.now();
    s.readyAt = undefined;
    s.adopted = false;
    s.attached = true;
    s.lastExitCode = undefined;
    s.lastExitReason = undefined;
    s.readinessBuf = '';
    s.tailOffset = 0;
    this.setState(s, 'starting');
    this.pushSystemLine(s, `Using ${s.javaDescribe || 'java from PATH'} for ${s.jarName || 'server jar'}.`);
    this.pushSystemLine(s, `Starting ${path.basename(exe)} (PID ${child.pid}) — args: ${args.join(' ')}`);
    this.persist();

    const onChunk = (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      s.readinessBuf += text;
      if (s.readinessBuf.length > 8192) s.readinessBuf = s.readinessBuf.slice(-4096);
      const parts = text.split(/\r?\n/);
      for (let i = 0; i < parts.length - 1; i++) {
        const raw = parts[i].replace(/\r$/, '');
        if (!raw) continue;
        const line = this.pushLine(s, raw);
        if (s.state === 'starting' && READY_PATTERN.test(line.text)) this.markReady(s);
      }
    };
    child.stdout?.on('data', onChunk);
    child.stderr?.on('data', onChunk);

    child.on('error', (err) => {
      this.pushSystemLine(s, `Process error: ${err.message}`, 'ERROR');
      // Spawn failures (ENOENT/EACCES) emit 'error' without an 'exit' event —
      // finalize the state here so the server never hangs in 'starting'.
      if (s.state === 'starting' && !child.pid) {
        if (s.startupTimer) {
          clearTimeout(s.startupTimer);
          s.startupTimer = undefined;
        }
        s.lastExitReason = `spawn failed: ${err.message}`;
        s.lastExitCode = null;
        s.pid = undefined;
        s.child = undefined;
        this.setState(s, 'crashed');
        this.persist();
      }
    });

    child.on('exit', (code, signal) => {
      this.handleExit(s, code, signal);
    });

    const startupTimeout = opts.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS;
    s.startupTimer = setTimeout(() => {
      if (s.state === 'starting') {
        this.pushSystemLine(
          s,
          `Startup timed out after ${Math.round(startupTimeout / 1000)}s without a readiness line — terminating process.`,
          'ERROR'
        );
        void this.forceKill(s, 'startup timeout');
      }
    }, startupTimeout);

    return { ok: true, ...(this.getSnapshot(id)!) };
  }

  private markReady(s: ManagedServer) {
    if (s.state !== 'starting') return;
    s.readyAt = Date.now();
    if (s.startupTimer) {
      clearTimeout(s.startupTimer);
      s.startupTimer = undefined;
    }
    const secs = s.startedAt ? ((s.readyAt - s.startedAt) / 1000).toFixed(1) : '?';
    this.pushSystemLine(s, `Readiness detected after ${secs}s — server is ONLINE (PID ${s.pid}).`);
    this.setState(s, 'online');
  }

  private handleExit(s: ManagedServer, code: number | null, signal: NodeJS.Signals | null) {
    // Ignore duplicate/late exits (e.g. after a spawn error already finalized).
    if (s.state === 'stopped' || s.state === 'crashed') return;
    if (s.startupTimer) {
      clearTimeout(s.startupTimer);
      s.startupTimer = undefined;
    }
    if (s.stopTimer) {
      clearTimeout(s.stopTimer);
      s.stopTimer = undefined;
    }
    this.stopLogTail(s);
    s.child = undefined;
    s.attached = false;
    const wasState = s.state;
    s.lastExitCode = code;

    if (wasState === 'stopping') {
      s.lastExitReason = s.lastExitReason || 'stopped';
      this.setState(s, 'stopped', { code });
      this.pushSystemLine(s, `Process exited (code ${code ?? 'n/a'}${signal ? `, signal ${signal}` : ''}).`);
    } else if (wasState === 'starting') {
      s.lastExitReason = 'startup failed';
      this.setState(s, 'crashed', { code });
      this.pushSystemLine(
        s,
        `Server exited during startup (code ${code ?? 'n/a'}) before readiness was detected.`,
        'ERROR'
      );
    } else {
      s.lastExitReason = 'unexpected exit';
      this.setState(s, 'crashed', { code });
      this.pushSystemLine(
        s,
        `Server process exited unexpectedly (code ${code ?? 'n/a'}${signal ? `, signal ${signal}` : ''}).`,
        'ERROR'
      );
    }
    s.pid = undefined;
    s.startedAt = undefined;
    s.adopted = false;
    this.persist();

    if (s.restartPending) {
      s.restartPending = false;
      this.pushSystemLine(s, 'Restart: graceful stop complete — starting again…');
      const opts = s.startOpts;
      if (opts) {
        void this.start(s.id, opts)
          .then((r) => {
            if (!r.ok) this.pushSystemLine(s, `Restart failed: ${r.error || 'unknown error'}`, 'ERROR');
          })
          .catch((err) => {
            this.pushSystemLine(
              s,
              `Restart failed: ${err instanceof Error ? err.message : String(err)}`,
              'ERROR'
            );
          });
      } else {
        this.pushSystemLine(s, 'Restart skipped: no stored start configuration (server was reattached, not started by this session).', 'WARN');
      }
    }
  }

  // ------------------------------------------------------------------- stop

  async stop(id: string, opts: { force?: boolean; graceMs?: number; forRestart?: boolean } = {}): Promise<SupervisorSnapshot & { ok: boolean; error?: string; alreadyStopped?: boolean }> {
    const s = this.servers.get(id);
    if (!s || s.state === 'stopped' || s.state === 'crashed') {
      return {
        ok: true,
        alreadyStopped: true,
        ...(this.getSnapshot(id) || { id, state: 'stopped' as const, adopted: false, attached: false, restartPending: false }),
      };
    }
    if (s.state === 'stopping') {
      return { ok: true, ...(this.getSnapshot(id)!) };
    }

    // A user-initiated stop cancels any pending restart; a stop that IS part
    // of a restart must keep the flag so the restart branch fires on exit.
    if (!opts.forRestart) s.restartPending = false;

    if (opts.force || !s.attached || !s.child) {
      if (!s.attached && s.pid) {
        this.pushSystemLine(s, 'Process was reattached without stdin — using direct termination.', 'WARN');
      }
      await this.forceKill(s, 'forced by user');
      return { ok: true, ...(this.getSnapshot(id)!) };
    }

    this.setState(s, 'stopping');
    try {
      s.child.stdin?.write('stop\n');
      // End stdin so the server's console-reader thread sees EOF and cannot
      // block JVM exit after the world save finishes (data flushes before FIN).
      s.child.stdin?.end();
      this.pushSystemLine(s, 'Graceful shutdown requested (stdin: stop) — waiting for process exit…');
    } catch {
      this.pushSystemLine(s, 'Failed to write to process stdin — falling back to termination.', 'WARN');
      await this.forceKill(s, 'stdin unavailable');
      return { ok: true, ...(this.getSnapshot(id)!) };
    }

    const graceMs = opts.graceMs ?? DEFAULT_STOP_GRACE_MS;
    s.stopTimer = setTimeout(() => {
      if (s.state === 'stopping') {
        this.pushSystemLine(
          s,
          `Graceful stop timed out after ${Math.round(graceMs / 1000)}s — force terminating process tree.`,
          'WARN'
        );
        void this.forceKill(s, 'graceful stop timeout');
      }
    }, graceMs);

    return { ok: true, ...(this.getSnapshot(id)!) };
  }

  private async forceKill(s: ManagedServer, reason: string): Promise<void> {
    if (!s.pid) return;
    s.lastExitReason = reason;
    if (s.state !== 'stopping') this.setState(s, 'stopping');
    const pid = s.pid;
    await new Promise<void>((resolve) => {
      if (process.platform === 'win32') {
        execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { timeout: 8000, windowsHide: true }, () => resolve());
      } else {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          // already dead
        }
        resolve();
      }
    });
    // Exit event will finalize the state; if the child is already gone (e.g.
    // adopted process with no handle), finalize directly after a short wait.
    await sleep(400);
    const cur = this.servers.get(s.id);
    if (cur && cur.pid === pid && (cur.state === 'stopping' || cur.state === 'starting')) {
      // no child handle (adopted): the exit event never fires — finalize now
      if (!cur.child) {
        let alive = false;
        try {
          process.kill(pid, 0);
          alive = true;
        } catch {
          alive = false;
        }
        if (!alive) this.handleExit(cur, 0, null);
      }
    }
  }

  async restart(id: string): Promise<SupervisorSnapshot & { ok: boolean; error?: string }> {
    const s = this.servers.get(id);
    if (!s) return { ok: false, error: 'Server is not managed by the supervisor yet (start it first).', id, state: 'stopped', adopted: false, attached: false, restartPending: false };
    if (s.state === 'stopped' || s.state === 'crashed') {
      if (s.startOpts) return this.start(id, s.startOpts);
      return { ok: false, error: 'No stored start configuration — start the server first.', ...this.getSnapshot(id)! };
    }
    s.restartPending = true;
    if (s.state !== 'stopping') await this.stop(id, { forRestart: true });
    return { ok: true, ...this.getSnapshot(id)! };
  }

  // --------------------------------------------------------------- commands

  sendCommand(id: string, command: string): { ok: boolean; error?: string } {
    const s = this.servers.get(id);
    if (!s || s.state !== 'online') return { ok: false, error: 'Server is not running.' };
    const cleaned = command.replace(/[\u0000\r\n]/g, '').trim();
    if (!cleaned) return { ok: false, error: 'Empty command.' };
    if (cleaned.length > 512) return { ok: false, error: 'Command too long (max 512 characters).' };
    if (!s.attached || !s.child?.stdin || !s.child.stdin.writable) {
      return {
        ok: false,
        error:
          'Console input unavailable (server was reattached after an app restart). Restart the server from the panel to regain console input.',
      };
    }
    try {
      s.child.stdin.write(cleaned + '\n');
      this.pushLine(s, `> ${cleaned}`); // will read back as INFO level; mark as EXEC below
      const last = s.console[s.console.length - 1];
      if (last) last.level = 'EXEC';
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : 'Failed to write command' };
    }
  }

  // ------------------------------------------------------------ log tailing

  private startLogTail(s: ManagedServer) {
    this.stopLogTail(s);
    const logPath = path.join(s.dir, 'logs', 'latest.log');
    s.tailOffset = 0;
    let carry = '';
    s.tailTimer = setInterval(() => {
      try {
        if (!fs.existsSync(logPath)) return;
        const size = fs.statSync(logPath).size;
        if (size < s.tailOffset) {
          // rotated/truncated — restart from beginning
          s.tailOffset = 0;
          carry = '';
        }
        if (size === s.tailOffset) return;
        const fd = fs.openSync(logPath, 'r');
        try {
          const len = size - s.tailOffset;
          const buf = Buffer.alloc(len);
          fs.readSync(fd, buf, 0, len, s.tailOffset);
          s.tailOffset = size;
          carry += buf.toString('utf8');
          const parts = carry.split(/\r?\n/);
          carry = parts.pop() || '';
          for (const raw of parts) {
            if (raw) this.pushLine(s, raw);
          }
        } finally {
          fs.closeSync(fd);
        }
      } catch {
        // ignore transient fs errors
      }
    }, 750);
  }

  private stopLogTail(s: ManagedServer) {
    if (s.tailTimer) {
      clearInterval(s.tailTimer);
      s.tailTimer = undefined;
    }
  }

  // ---------------------------------------------------------------- metrics

  private async sampleProcess(pid: number): Promise<Sample | null> {
    const script =
      `$p = Get-Process -Id ${pid} -ErrorAction SilentlyContinue; ` +
      `if ($p) { $cpu = $p.CPU; if ($cpu -eq $null) { $cpu = 0 }; ` +
      `Write-Output ($cpu.ToString() + '|' + $p.WorkingSet64) }`;
    return new Promise((resolve) => {
      execFile(
        'powershell.exe',
        ['-NoProfile', '-Command', script],
        { timeout: 5000, windowsHide: true, maxBuffer: 1 << 20 },
        (err, stdout) => {
          if (err) return resolve(null);
          const line = String(stdout || '').trim().split(/\r?\n/)[0];
          const m = line && line.match(/^([\d.]+)\|(\d+)$/);
          if (!m) return resolve(null);
          resolve({ cpuSec: Number(m[1]), rssMb: Number(m[2]) / (1024 * 1024) });
        }
      );
    });
  }

  async getMetrics(id: string): Promise<{ cpuPct: number; ramMb: number; uptimeMs: number } | null> {
    const s = this.servers.get(id);
    if (!s || (s.state !== 'online' && s.state !== 'starting') || !s.pid) return null;
    const now = Date.now();
    if (s.cachedMetrics && now - s.cachedMetrics.at < METRICS_CACHE_MS) {
      return { cpuPct: s.cachedMetrics.cpuPct, ramMb: s.cachedMetrics.ramMb, uptimeMs: s.startedAt ? now - s.startedAt : 0 };
    }
    const sample = await this.sampleProcess(s.pid);
    if (!sample) return null;
    let cpuPct: number;
    if (s.lastSample && s.lastSampleAt) {
      const dt = (now - s.lastSampleAt) / 1000;
      cpuPct = dt > 0 ? ((sample.cpuSec - s.lastSample.cpuSec) / dt) * 100 : 0;
    } else if (s.startedAt) {
      const age = (now - s.startedAt) / 1000;
      cpuPct = age > 1 ? (sample.cpuSec / age) * 100 : 0;
    } else {
      cpuPct = 0;
    }
    cpuPct = Math.max(0, Math.min(100, cpuPct));
    s.lastSample = sample;
    s.lastSampleAt = now;
    s.cachedMetrics = { cpuPct, ramMb: sample.rssMb, at: now };
    const point: HistoryPoint = {
      time: nowTime(),
      cpu: Math.round(cpuPct),
      memoryMb: Math.round(sample.rssMb),
      netRxKbps: 0,
      netTxKbps: 0,
    };
    s.history.push(point);
    if (s.history.length > MAX_HISTORY) s.history.splice(0, s.history.length - MAX_HISTORY);
    return { cpuPct, ramMb: sample.rssMb, uptimeMs: s.startedAt ? now - s.startedAt : 0 };
  }

  async getStorageMb(dir: string): Promise<number> {
    const script = `(Get-ChildItem -LiteralPath '${dir.replace(/'/g, "''")}' -Recurse -File -ErrorAction SilentlyContinue | Measure-Object -Property Length -Sum).Sum`;
    return new Promise((resolve) => {
      execFile(
        'powershell.exe',
        ['-NoProfile', '-Command', script],
        { timeout: 20000, windowsHide: true, maxBuffer: 1 << 20 },
        (err, stdout) => {
          if (err) return resolve(0);
          const bytes = Number(String(stdout || '').trim());
          resolve(Number.isFinite(bytes) ? bytes / (1024 * 1024) : 0);
        }
      );
    });
  }
}

export function createProcessSupervisor(opts: { dataDir: string; runtimeFileName?: string }): ProcessSupervisor {
  return new ProcessSupervisor(opts);
}
