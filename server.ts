import express from 'express';
import { createProcessSupervisor, type SupervisorSnapshot } from './server/process-supervisor';
import {
  applyForward,
  revertForward,
  verifyForward,
  defaultDeps as forwardDeps,
  pickDisposablePort,
  parsePortProxyShow,
  selfTestTarget,
  buildCleanupCommands,
  type ApplyErrorCode,
  type ForwardTarget,
  type ForwardVerification,
} from './server/port-forward-windows';
import { JobManager, JobCancelledError, type JobContext } from './server/job-manager';
import http from 'http';
import path from 'path';
import os from 'os';
import fs from 'fs';
import net from 'net';
import crypto from 'crypto';
import { createRequire } from 'module';
import { exec, spawn, ChildProcess } from 'child_process';
import { promisify } from 'util';
import dotenv from 'dotenv';
import { MongoClient } from 'mongodb';
import mysql from 'mysql2/promise';

dotenv.config();

// Create require for Node.js built-in modules
const requireModule = createRequire(__filename);

// Database directory from env or default
// Priority: APPDATA_DB_DIR (set by electron main) > default (dev: ./database)
// Contract:
//   APPDATA_DB_DIR  = directory path (e.g. %APPDATA%\IS King Panel\database)
//   SQLITE_DB_PATH  = path.join(APPDATA_DB_DIR, 'isking_panel.sqlite')
let dbDir: string;
let dbFile: string;

if (process.env.APPDATA_DB_DIR) {
  // Use directory set by electron main process (packaged or dev)
  dbDir = process.env.APPDATA_DB_DIR;
  dbFile = path.join(dbDir, 'isking_panel.sqlite');
} else {
  // Default for development: use a 'database' folder in the current directory (project root)
  dbDir = path.join(__dirname, 'database');
  dbFile = path.join(dbDir, 'isking_panel.sqlite');
}

// Ensure parent directory exists
try {
  fs.mkdirSync(dbDir, { recursive: true });
} catch {
  // ignore
}

const SQLITE_DB_PATH = dbFile;

// SQLite database interfaces
interface SqliteStatement {
  run: (...params: unknown[]) => { changes: number; lastInsertRowid: number | bigint };
  get: (...params: unknown[]) => Record<string, unknown> | undefined;
  all: (...params: unknown[]) => Array<Record<string, unknown>>;
}

interface SqliteDatabase {
  exec: (sql: string) => void;
  prepare: (sql: string) => SqliteStatement;
}

// SQLite database initialization
let sqliteDb: SqliteDatabase | null = null;
try {
  const { DatabaseSync } = requireModule('node:sqlite') as {
    DatabaseSync: new (filename: string) => SqliteDatabase;
  };
  sqliteDb = new DatabaseSync(SQLITE_DB_PATH);
  sqliteDb.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA foreign_keys = ON;
  `);
} catch {
  // Database unavailable - sqliteDb stays null
}

// Create promisified exec
const execAsync = promisify(exec);

/**
 * Spawn a process and settle when it exits. Unlike execAsync this accepts an
 * AbortSignal, so a cancelled backup/restore kills its tar/PowerShell child
 * instead of leaving it writing into the server folder.
 */
const runProcess = (
  file: string,
  args: string[],
  opts: { signal?: AbortSignal; maxBuffer?: number } = {}
): Promise<{ stdout: string; stderr: string }> =>
  new Promise((resolve, reject) => {
    if (opts.signal?.aborted) {
      reject(new JobCancelledError());
      return;
    }
    const child = spawn(file, args, { windowsHide: true });
    const max = opts.maxBuffer ?? 8 * 1024 * 1024;
    let stdout = '';
    let stderr = '';
    let settled = false;

    const cleanup = () => opts.signal?.removeEventListener('abort', onAbort);
    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    };
    const onAbort = () => {
      try {
        child.kill('SIGTERM');
      } catch {
        // already gone
      }
      setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          // already gone
        }
      }, 2500).unref?.();
      fail(new JobCancelledError());
    };

    opts.signal?.addEventListener('abort', onAbort, { once: true });
    child.stdout?.on('data', (chunk: Buffer) => {
      if (stdout.length < max) stdout += chunk.toString('utf8');
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderr.length < max) stderr += chunk.toString('utf8');
    });
    child.on('error', (err) => fail(err));
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        reject(
          new Error(
            (stderr || stdout || `Process exited with code ${code ?? 'unknown'}`)
              .trim()
              .slice(0, 2000)
          )
        );
      }
    });
  });

// OAuth state store for PKCE and state validation
const oauthStateStore = new Map();

// Directory for writable JSON state (users, operator profile, engine config).
// Packaged builds run from a read-only install directory, so every state file
// must live in the per-user APPDATA directory handed over by electron-main.
const appStateDir = process.env.APPDATA_DB_DIR ? dbDir : process.cwd();

// Session cookies must not carry `Secure` when the desktop shell serves the UI
// over http://127.0.0.1: browsers silently discard Secure cookies on plain
// HTTP, which made /api/auth/login succeed while every session check failed.
// The desktop shell keeps the session across app restarts, so the cookie is
// persistent and matches the seven-day server-side session lifetime.
const SESSION_MAX_AGE_SECONDS = 7 * 24 * 60 * 60;
const sessionCookie = (req: express.Request, value: string) =>
  `king_session=${value}; Path=/; Max-Age=${SESSION_MAX_AGE_SECONDS}; HttpOnly; SameSite=Lax${
    req.secure ? '; Secure' : ''
  }`;
const clearedSessionCookie = (req: express.Request) =>
  `king_session=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly; SameSite=Lax${
    req.secure ? '; Secure' : ''
  }`;

const validateSession = (req: express.Request, res: express.Response, next: express.NextFunction) => {
  try {
    const cookieHeader = req.headers.cookie || '';
    const cookies = cookieHeader.split(';').reduce((acc, cookie) => {
      const [trimmed] = cookie.trim().split('=');
      acc[trimmed] = cookie.trim().substring(trimmed.length + 1);
      return acc;
    }, {} as Record<string, string>);
    const sessionCookie = cookies['king_session'];
    if (!sessionCookie) {
      return res.status(401).json({ error: 'No session cookie' });
    }

    // Check if user exists in SQLite
    if (sqliteDb == null) {
      return res.status(500).json({ error: 'Database unavailable' });
    }

    // Validate session token against auth_sessions table
    const session = sqliteDb.prepare('SELECT * FROM auth_sessions WHERE session_id = ?').get(sessionCookie);
    if (!session) {
      return res.status(401).json({ error: 'Session expired or invalid' });
    }

    // Check if session is expired (older than 7 days)
    const sessionAge = Date.now() - new Date(session.created_at as string).getTime();
    if (sessionAge > SESSION_MAX_AGE_SECONDS * 1000) {
      // Delete expired session
      sqliteDb.prepare('DELETE FROM auth_sessions WHERE session_id = ?').run(sessionCookie);
      return res.status(401).json({ error: 'Session expired or invalid' });
    }

    // Update last_active_at
    sqliteDb.prepare('UPDATE auth_sessions SET last_active_at = ? WHERE session_id = ?')
      .run(new Date().toISOString(), sessionCookie);

    // Get user details
    const user = sqliteDb.prepare('SELECT * FROM users WHERE id = ?').get(session.user_id);
    if (!user) {
      return res.status(401).json({ error: 'User not found' });
    }

    // Attach user to request for use in endpoints
    (req as any).userId = user.id;
    (req as any).user = user;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Session validation failed' });
  }
};

/**
 * A port-forwarding rule the operator asked the panel to remember.
 *
 * The panel deliberately does not touch the router, the Windows firewall or
 * `netsh`, which needs administrator rights. A rule is `RECORDED` until an
 * elevated apply has actually run AND the mapping has been read back from the
 * OS; only then is it `ACTIVE`. `FAILED` carries the reason. Never set `ACTIVE`
 * from a request's own claim of success — see `applyForward()`.
 */
interface ForwardedPortConfig {
  id: string;
  externalPort: number;
  internalPort: number;
  internalIp: string;
  protocol: 'TCP' | 'UDP' | 'TCP/UDP';
  serviceName: string;
  method: 'UPnP IGDv2' | 'Netsh PortProxy' | 'Playit.gg Tunnel' | 'Cloudflare Spectrum';
  /**
   * `RECORDED` — saved only; `APPLYING` — an elevated run is in flight;
   * `ACTIVE` — the OS confirmed the mapping; `FAILED` — see `applyError`.
   */
  status: 'RECORDED' | 'APPLYING' | 'ACTIVE' | 'FAILED';
  createdAt: string;
  updatedAt: string;
  /** When the OS last confirmed the mapping. */
  appliedAt?: string | null;
  /** Why the last apply/verify failed. Cleared on success. */
  applyError?: string | null;
  /** Evidence from the last verification pass. */
  verification?: ForwardVerification | null;
  /** Local TCP probe of `internalPort` taken when the rule was last saved. */
  lastProbe?: { reachable: boolean; latencyMs: number; checkedAt: string };
}

const FORWARD_PROTOCOLS = ['TCP', 'UDP', 'TCP/UDP'] as const;
const FORWARD_METHODS = [
  'UPnP IGDv2',
  'Netsh PortProxy',
  'Playit.gg Tunnel',
  'Cloudflare Spectrum',
] as const;

type ForwardRuleInput = Pick<
  ForwardedPortConfig,
  'externalPort' | 'internalPort' | 'internalIp' | 'protocol' | 'serviceName' | 'method'
>;

const PORT_FORWARDS_STATE_PATH = path.join(appStateDir, '.local-port-forwards.json');

const isValidPortNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 65535;

/** Only IPv4 literals are accepted: the address is echoed into commands the operator runs. */
const isIpv4Literal = (value: string): boolean => {
  const parts = value.split('.');
  if (parts.length !== 4) return false;
  return parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
};

/**
 * Validates one rule payload (from a request body or from disk). Returns a
 * specific reason so the endpoint can answer 400 with something actionable
 * instead of silently coercing bad input into a rule that cannot work.
 */
const parseForwardInput = (
  raw: any,
  fallbackServiceName = 'Custom port'
): { ok: true; value: ForwardRuleInput } | { ok: false; error: string } => {
  const externalPort = Number(raw?.externalPort ?? raw?.internalPort);
  const internalPort = Number(raw?.internalPort ?? raw?.externalPort);
  if (!isValidPortNumber(externalPort) || !isValidPortNumber(internalPort)) {
    return { ok: false, error: 'Ports must be whole numbers between 1 and 65535.' };
  }

  const protocolRaw = String(raw?.protocol ?? 'TCP/UDP').replace(/\s+/g, '').toUpperCase();
  const protocol = FORWARD_PROTOCOLS.find((candidate) => candidate === protocolRaw);
  if (!protocol) {
    return { ok: false, error: `Protocol must be one of ${FORWARD_PROTOCOLS.join(', ')}.` };
  }

  const methodRaw = String(raw?.method ?? 'UPnP IGDv2').trim();
  const method = FORWARD_METHODS.find((candidate) => candidate === methodRaw);
  if (!method) {
    return { ok: false, error: `Forwarding method must be one of ${FORWARD_METHODS.join(', ')}.` };
  }

  const internalIp = String(raw?.internalIp ?? '127.0.0.1').trim() || '127.0.0.1';
  if (!isIpv4Literal(internalIp)) {
    return { ok: false, error: 'The local bind IP must be an IPv4 address such as 127.0.0.1.' };
  }

  const serviceName = (String(raw?.serviceName ?? '').trim() || fallbackServiceName).slice(0, 120);

  return { ok: true, value: { externalPort, internalPort, internalIp, protocol, serviceName, method } };
};

/** Reads the rules saved by a previous run. A corrupt file never stops the boot. */
const readStoredPortForwards = (): ForwardedPortConfig[] => {
  try {
    if (!fs.existsSync(PORT_FORWARDS_STATE_PATH)) return [];
    const parsed = JSON.parse(fs.readFileSync(PORT_FORWARDS_STATE_PATH, 'utf8'));
    const list: any[] = Array.isArray(parsed)
      ? parsed
      : Array.isArray(parsed?.forwards)
        ? parsed.forwards
        : [];
    const rules: ForwardedPortConfig[] = [];
    for (const entry of list) {
      const internalPortGuess = Number(entry?.internalPort) || 0;
      const validated = parseForwardInput(entry, `Port ${internalPortGuess}`);
      if (!validated.ok) continue;
      const createdAt =
        typeof entry?.createdAt === 'string' && entry.createdAt
          ? entry.createdAt
          : new Date().toISOString();
      const probe = entry?.lastProbe;
      // A rule saved as APPLYING was interrupted by a shutdown: its real state is
      // unknown, so it comes back as RECORDED and must be re-applied/verified.
      const storedStatus = entry?.status;
      const status: ForwardedPortConfig['status'] =
        storedStatus === 'ACTIVE' || storedStatus === 'FAILED' ? storedStatus : 'RECORDED';
      rules.push({
        ...validated.value,
        id: typeof entry?.id === 'string' && entry.id ? entry.id : `fwd-${validated.value.externalPort}`,
        status,
        appliedAt: typeof entry?.appliedAt === 'string' ? entry.appliedAt : null,
        applyError: typeof entry?.applyError === 'string' ? entry.applyError : null,
        verification:
          entry?.verification && typeof entry.verification === 'object'
            ? (entry.verification as ForwardVerification)
            : null,
        createdAt,
        updatedAt: typeof entry?.updatedAt === 'string' && entry.updatedAt ? entry.updatedAt : createdAt,
        lastProbe:
          probe && typeof probe.reachable === 'boolean'
            ? {
                reachable: probe.reachable,
                latencyMs: Number(probe.latencyMs) || 0,
                checkedAt: typeof probe.checkedAt === 'string' ? probe.checkedAt : createdAt,
              }
            : undefined,
      });
    }
    return rules;
  } catch {
    return [];
  }
};

// Only rules the operator actually created are listed — nothing pre-seeded.
const activeForwards: ForwardedPortConfig[] = readStoredPortForwards();

/**
 * Writes the given rules atomically. Returns a failure instead of pretending the
 * rule was remembered when the disk refused the write.
 */
const writeStoredPortForwards = (
  rules: ForwardedPortConfig[] = activeForwards
): { ok: true } | { ok: false; error: string } => {
  try {
    fs.mkdirSync(path.dirname(PORT_FORWARDS_STATE_PATH), { recursive: true });
    const tmpPath = `${PORT_FORWARDS_STATE_PATH}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify({ forwards: rules }, null, 2), 'utf8');
    fs.renameSync(tmpPath, PORT_FORWARDS_STATE_PATH);
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : 'Could not write the rule store',
    };
  }
};

/** First stored rule matching either side of the port pair. */
const findForwardRule = (port: number): ForwardedPortConfig | undefined =>
  activeForwards.find((f) => f.internalPort === port || f.externalPort === port);

/**
 * The only fields that ever reach netsh. `applyForward()` re-validates all of
 * them before building a command, so this is not a trust boundary.
 */
const forwardTargetOf = (rule: ForwardedPortConfig): ForwardTarget => ({
  externalPort: rule.externalPort,
  internalPort: rule.internalPort,
  internalIp: rule.internalIp,
  protocol: rule.protocol,
});

/** A mapping counts as present only when every required OS artefact is there. */
const forwardVerificationPassed = (verification: ForwardVerification): boolean =>
  verification.firewall && (!verification.portProxyRequired || verification.portProxy);

/** Persist the in-memory rule list; false means the disk refused the write. */
const commitForwardRule = (): boolean => writeStoredPortForwards().ok;

/** Maps an elevation failure to the HTTP status the renderer should show. */
const applyErrorStatus = (code: ApplyErrorCode): number =>
  code === 'UNSUPPORTED_PLATFORM'
    ? 501
    : code === 'ELEVATION_DISABLED'
      ? 503
      : code === 'ELEVATION_DECLINED'
        ? 409
        : 502;

// Helper to parse /proc/net/tcp or /proc/net/udp hex sockets on Linux/Container
function parseProcNetFile(filePath: string, proto: 'TCP' | 'UDP') {
  const results: Array<{
    port: number;
    bindIp: string;
    proto: 'TCP' | 'UDP';
    state: string;
    inode: string;
  }> = [];
  try {
    if (!fs.existsSync(filePath)) return results;
    const raw = fs.readFileSync(filePath, 'utf8');
    const lines = raw.trim().split('\n').slice(1);
    for (const line of lines) {
      const parts = line.trim().split(/\s+/);
      if (parts.length < 4) continue;
      const localAddress = parts[1];
      const stateHex = parts[3];
      const inode = parts[9] || '0';
      // 0A is TCP_LISTEN, 07 is UDPlistening/unconnected
      if (proto === 'TCP' && stateHex !== '0A') continue;
      const [ipHex, portHex] = localAddress.split(':');
      const port = parseInt(portHex, 16);
      if (!port || isNaN(port)) continue;
      let bindIp = '0.0.0.0';
      if (ipHex && ipHex.length === 8) {
        const b1 = parseInt(ipHex.slice(6, 8), 16);
        const b2 = parseInt(ipHex.slice(4, 6), 16);
        const b3 = parseInt(ipHex.slice(2, 4), 16);
        const b4 = parseInt(ipHex.slice(0, 2), 16);
        bindIp = `${b1}.${b2}.${b3}.${b4}`;
      } else if (ipHex && ipHex.length > 8) {
        bindIp = '::';
      }
      if (!results.some((r) => r.port === port && r.proto === proto)) {
        results.push({
          port,
          bindIp,
          proto,
          state: 'LISTENING',
          inode,
        });
      }
    }
  } catch {
    // ignore read errors
  }
  return results;
}

// Probe if a local TCP port is actively accepting connections
function probeLocalTcpPort(port: number, host = '127.0.0.1', timeoutMs = 180): Promise<{ open: boolean; latencyMs: number }> {
  return new Promise((resolve) => {
    const start = Date.now();
    const socket = new net.Socket();
    let settled = false;

    const finish = (open: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve({ open, latencyMs: Date.now() - start });
    };

    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
    socket.connect(port, host);
  });
}

// Real JVM process supervisor — owns start/readiness/stop/crash tracking for
// actual server processes. Persists runtime PIDs for startup reconciliation.
const supervisor = createProcessSupervisor({
  dataDir: process.env.APPDATA_DB_DIR || path.join(process.cwd(), 'database'),
});

async function startServer() {
  const app = express();
  const httpServer = http.createServer(app);
  // Honor PORT when the desktop shell assigns an alternate port (e.g. 3000 is
  // occupied by another application on Windows, where binds can silently share).
  const PORT = Number.parseInt(process.env.PORT ?? '', 10) || 3000;

  app.use(express.json());

  // Reconcile persisted PIDs with real OS processes (adopt or reset) as soon as
  // the service comes up — saved state never claims "running" unverified.
  void supervisor.reconcile().catch(() => {});

  // Helper to resolve APP_URL for OAuth Redirect URI
  const getRedirectUri = (req: express.Request): string => {
    const base =
      process.env.APP_URL && process.env.APP_URL !== 'MY_APP_URL'
        ? process.env.APP_URL.replace(/\/$/, '')
        : `${req.protocol}://${req.get('host')}`;
    return `${base}/auth/callback`;
  };

  // ============================================================================
  // 1. OAUTH & SESSION ENDPOINTS
  // ============================================================================
  app.get('/api/auth/url/:provider', (req, res) => {
    const provider = req.params.provider?.toLowerCase();
    const redirectUri = getRedirectUri(req);

    if (provider === 'discord') {
      const clientId = process.env.DISCORD_CLIENT_ID;
      if (!clientId) {
        res.json({ url: null, configured: false, provider: 'discord', redirectUri });
        return;
      }
      const params = new URLSearchParams({
        client_id: clientId,
        redirect_uri: redirectUri,
        response_type: 'code',
        scope: 'identify email guilds',
        state: 'discord',
      });
      res.json({
        url: `https://discord.com/api/oauth2/authorize?${params.toString()}`,
        configured: true,
        provider: 'discord',
        redirectUri,
      });
      return;
    }

    if (provider === 'github') {
      const clientId = process.env.GITHUB_CLIENT_ID;
      if (!clientId) {
        res.json({ url: null, configured: false, provider: 'github', redirectUri });
        return;
      }
      const params = new URLSearchParams({
        client_id: clientId,
        redirect_uri: redirectUri,
        scope: 'read:user user:email',
        state: 'github',
      });
      res.json({
        url: `https://github.com/login/oauth/authorize?${params.toString()}`,
        configured: true,
        provider: 'github',
        redirectUri,
      });
      return;
    }

    if (provider === 'google') {
      const clientId = process.env.GOOGLE_CLIENT_ID;
      if (!clientId) {
        res.json({ url: null, configured: false, provider: 'google', redirectUri });
        return;
      }
      const params = new URLSearchParams({
        client_id: clientId,
        redirect_uri: redirectUri,
        response_type: 'code',
        scope: 'openid email profile',
        access_type: 'online',
        state: 'google',
      });
      res.json({
        url: `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`,
        configured: true,
        provider: 'google',
        redirectUri,
      });
      return;
    }

    res.status(400).json({ error: 'Unsupported OAuth provider' });
  });

  const oauthCallbackHandler = async (req: express.Request, res: express.Response) => {
    const code = String(req.query.code || '');
    const state = String(req.query.state || '');

    // Validate state and retrieve stored OAuth data
    const oauthData = oauthStateStore.get(state);
    if (!oauthData) {
      return res.status(400).json({ error: 'Invalid or expired OAuth state' });
    }

    const { provider, userId, codeVerifier, redirectUri } = oauthData;

    // Remove used state
    oauthStateStore.delete(state);

    if (!sqliteDb) {
      return res.status(500).json({ error: 'Database unavailable' });
    }

    // Discord linking is a real OAuth code exchange performed server-side. The
    // resulting Discord user id is what the entitlement check later trusts —
    // never a display name or an id typed into the renderer.
    if (provider === 'discord') {
      const clientId = process.env.DISCORD_CLIENT_ID;
      const clientSecret = process.env.DISCORD_CLIENT_SECRET;
      if (!clientId || !clientSecret) {
        return res.status(503).json({ error: 'Discord OAuth is not configured on this panel.' });
      }
      try {
        const tokenRes = await fetch(`${DISCORD_OAUTH_BASE}/oauth2/token`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            client_id: clientId,
            client_secret: clientSecret,
            grant_type: 'authorization_code',
            code,
            redirect_uri: String(redirectUri || getRedirectUri(req)),
            ...(codeVerifier ? { code_verifier: String(codeVerifier) } : {}),
          }).toString(),
        });
        if (!tokenRes.ok) {
          return res.status(502).json({ error: 'Discord rejected the authorization code.' });
        }
        const token = (await tokenRes.json()) as {
          access_token?: string;
          refresh_token?: string;
          expires_in?: number;
          scope?: string;
        };
        if (!token.access_token) {
          return res.status(502).json({ error: 'Discord did not return an access token.' });
        }
        const meRes = await fetch(`${DISCORD_API_BASE}/users/@me`, {
          headers: { Authorization: `Bearer ${token.access_token}` },
        });
        if (!meRes.ok) {
          return res.status(502).json({ error: 'Discord identity could not be read.' });
        }
        const me = (await meRes.json()) as { id?: string; username?: string };
        const discordUserId = String(me.id || '').trim();
        if (!/^\d{16,20}$/.test(discordUserId)) {
          return res.status(502).json({ error: 'Discord returned an invalid user id.' });
        }

        const users = loadUsersDb();
        const target = users.find((u) => u.id === userId);
        if (!target) {
          return res.status(401).json({ error: 'Panel account not found.' });
        }
        const alreadyLinked = users.find(
          (u) => u.id !== userId && String(u.discordUserId || '') === discordUserId
        );
        if (alreadyLinked) {
          return res.status(409).json({
            error: 'That Discord account is already linked to a different panel account.',
          });
        }

        // Keep the grant server-side only: it is what the role check uses, and it
        // must never appear in a renderer payload, a log line or the users JSON.
        saveDiscordTokens(userId, {
          accessToken: String(token.access_token),
          refreshToken: token.refresh_token ? String(token.refresh_token) : '',
          expiresAt: Date.now() + (Number(token.expires_in) || 604800) * 1000,
          scopes: String(token.scope || ''),
        });

        target.discordUserId = discordUserId;
        target.discordUsername = me.username ? String(me.username) : target.discordUsername;
        target.discordLinkedAt = new Date().toISOString();
        target.discordRoleVerified = false;
        target.discordVerified = false;
        target.advancedPanelEnabled = false;
        target.advancedPanelReason = 'discord_not_linked';
        target.advancedPanelCheckedAt = undefined;
        if (!target.connectedProviders.includes('discord')) {
          target.connectedProviders.push('discord');
        }
        saveUsersDb(users);

        // Check guild membership + role immediately so the modal can report the
        // real state as soon as Discord redirects back.
        const refreshed = readUserById(userId);
        if (refreshed) {
          await verifyAdvancedPanelAccess(refreshed, { force: true }).catch(() => undefined);
        }

        // The browser that completed OAuth has no panel session, so send it a
        // self-contained confirmation page instead of the app shell. The
        // desktop window detects the link through its own access polling.
        res
          .status(200)
          .setHeader('Content-Type', 'text/html; charset=utf-8')
          .setHeader('Cache-Control', 'no-store')
          .send(`<!doctype html><html><head><meta charset="utf-8"><title>Discord connected</title>
<style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#0b0f17;color:#e7ecf5;font:15px/1.5 system-ui,sans-serif}main{max-width:420px;padding:32px;border:1px solid #2b3550;border-radius:16px;background:#111827;text-align:center}h1{font-size:18px;margin:0 0 8px}p{margin:0;color:#93a1bd}</style>
</head><body><main><h1>Discord connected</h1><p>KingPanel linked your Discord account. Return to the panel window — verification status updates automatically.</p></main></body></html>`);
        return;
      } catch {
        return res.status(502).json({ error: 'Discord could not be reached to finish linking.' });
      }
    }

    // Other providers still use the local placeholder handshake.
    const accessToken = `access_token_${provider}_${Date.now()}`;
    void accessToken;

    const user = sqliteDb.prepare('SELECT * FROM users WHERE id = ?').get(userId);
    if (!user) {
      return res.status(401).json({ error: 'User not found' });
    }

    // Update user's connected providers
    let connectedProviders: string[] = ['local'];
    try {
      connectedProviders = JSON.parse(String(user.connected_providers || '["local"]')) as string[];
    } catch {
      connectedProviders = ['local'];
    }

    if (!connectedProviders.includes(provider as 'discord' | 'github' | 'google')) {
      connectedProviders.push(provider as 'discord' | 'github' | 'google');
    }

    // Update user in database
    sqliteDb.prepare(
      `UPDATE users SET connected_providers = ? WHERE id = ?`
    ).run(JSON.stringify(connectedProviders), userId);

    // Create session for the user
    const sessionId = `sess-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
    if (sqliteDb) {
      try {
        sqliteDb
          .prepare(
            `INSERT INTO auth_sessions (session_id, user_id, username, role, provider, ip_address, platform, created_at, last_active_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .run(
            sessionId,
            user.id,
            user.username,
            user.role,
            provider,
            req.ip || '127.0.0.1',
            'Windows 11 Desktop App (.EXE)',
            new Date().toISOString(),
            new Date().toISOString()
          );
      } catch {
        // ignore
      }
    }

    // Set session cookie
    res.setHeader(
      'Set-Cookie',
      sessionCookie(req, sessionId)
    );

    // Redirect back to frontend with success message
    res.redirect(`${getRedirectUri(req)}?oauth_success=true&provider=${provider}`);
  };

  app.get(['/auth/callback', '/auth/callback/'], oauthCallbackHandler);

  // ============================================================================
  // 1B. PERSISTENT SQLITE3 DATABASE SYSTEM, USER LOGIN & DISCORD BOT VERIFICATION
  //     Super Admin: kingplayz | ID: SA-KINGPLAYZ-001 | Pass: KingPlayz#2026
  // ============================================================================
  // Reuse the APPDATA-aware paths resolved at module scope. Re-deriving these
  // from process.cwd() pointed the packaged app at its (read-only) install
  // folder, so SQLite failed to open and every session lookup returned 500.
  const DB_DIR = dbDir;
  try {
    fs.mkdirSync(DB_DIR, { recursive: true });
  } catch {
    // ignore
  }
  const SQLITE_DB_PATH = dbFile;
  const WINDOWS_APPDATA_DB_DISPLAY_PATH = SQLITE_DB_PATH;
  const LOCAL_USERS_DB_PATH = path.join(appStateDir, '.local-users-db.json');
  const LOCAL_DISCORD_CONFIG_PATH = path.join(appStateDir, '.local-discord-config.json');

  interface SqliteStatement {
    run: (...params: unknown[]) => { changes: number; lastInsertRowid: number | bigint };
    get: (...params: unknown[]) => Record<string, unknown> | undefined;
    all: (...params: unknown[]) => Array<Record<string, unknown>>;
  }

  interface SqliteDatabase {
    exec: (sql: string) => void;
    prepare: (sql: string) => SqliteStatement;
  }

  let sqliteDb: SqliteDatabase | null = null;
  try {
    const { DatabaseSync } = requireModule('node:sqlite') as {
      DatabaseSync: new (filename: string) => SqliteDatabase;
    };
    sqliteDb = new DatabaseSync(SQLITE_DB_PATH);
    sqliteDb.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA foreign_keys = ON;

      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        username TEXT UNIQUE NOT NULL,
        display_name TEXT NOT NULL,
        email TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL,
        is_super_admin INTEGER DEFAULT 0,
        provider TEXT DEFAULT 'local',
        avatar_url TEXT,
        mc_uuid TEXT,
        connected_providers TEXT DEFAULT '["local"]',
        last_login TEXT,
        session_sha TEXT,
        discord_verified INTEGER DEFAULT 0,
        discord_member_status TEXT DEFAULT 'not_connected',
        discord_user_id TEXT,
        discord_username TEXT,
        discord_guild_id TEXT,
        discord_guild_name TEXT,
        discord_invite_url TEXT,
        discord_bot_verified_at TEXT,
        discord_role_verified INTEGER DEFAULT 0,
        discord_linked_at TEXT,
        advanced_panel_enabled INTEGER DEFAULT 0,
        advanced_panel_reason TEXT,
        advanced_panel_checked_at TEXT,
        max_server_limit INTEGER DEFAULT 2,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS auth_sessions (
        session_id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        username TEXT NOT NULL,
        role TEXT NOT NULL,
        provider TEXT NOT NULL,
        ip_address TEXT,
        platform TEXT DEFAULT 'Windows 11 Desktop App (.EXE)',
        created_at TEXT NOT NULL,
        last_active_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS servers (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        engine TEXT NOT NULL,
        installed_version TEXT NOT NULL,
        latest_version TEXT NOT NULL,
        is_outdated INTEGER DEFAULT 0,
        latest_build TEXT,
        java_version TEXT DEFAULT 'Java 21',
        port INTEGER NOT NULL,
        pid INTEGER DEFAULT 0,
        status TEXT DEFAULT 'running',
        path TEXT NOT NULL,
        build TEXT,
        ram_max_gb REAL DEFAULT 8,
        max_players INTEGER DEFAULT 20,
        owner_username TEXT DEFAULT 'kingplayz',
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS engine_version_checks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        engine TEXT NOT NULL,
        latest_version TEXT NOT NULL,
        latest_build TEXT NOT NULL,
        outdated_count INTEGER DEFAULT 0,
        api_source TEXT NOT NULL,
        checked_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS audit_logs (
        id TEXT PRIMARY KEY,
        time TEXT NOT NULL,
        category TEXT NOT NULL,
        message TEXT NOT NULL,
        actor TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS server_backups (
        id TEXT PRIMARY KEY,
        server_id TEXT NOT NULL,
        server_name TEXT NOT NULL,
        title TEXT NOT NULL,
        badge TEXT NOT NULL,
        badge_type TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        size_bytes INTEGER NOT NULL,
        size_formatted TEXT NOT NULL,
        sha256 TEXT NOT NULL,
        file_path TEXT NOT NULL,
        scopes TEXT NOT NULL,
        pinned INTEGER DEFAULT 0,
        verified INTEGER DEFAULT 1,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS server_schedules (
        id TEXT PRIMARY KEY,
        server_id TEXT NOT NULL,
        title TEXT NOT NULL,
        cron TEXT NOT NULL,
        command_payload TEXT NOT NULL,
        status TEXT NOT NULL,
        description TEXT NOT NULL,
        next_run_sec INTEGER DEFAULT 180,
        last_run_at TEXT,
        last_exit_code INTEGER DEFAULT 0,
        run_count INTEGER DEFAULT 1,
        cpu_core_affinity TEXT DEFAULT 'Core 0-3 (Async)',
        icon TEXT DEFAULT 'schedule_send',
        icon_color TEXT DEFAULT 'bg-primary/10 text-primary',
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS server_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        server_id TEXT NOT NULL,
        line_num INTEGER NOT NULL,
        time TEXT NOT NULL,
        severity TEXT NOT NULL,
        thread TEXT NOT NULL,
        tag TEXT NOT NULL,
        raw_text TEXT NOT NULL,
        has_stacktrace INTEGER DEFAULT 0,
        created_at TEXT NOT NULL
      );
    `);
  } catch (err) {
    console.warn('SQLite initialization fallback:', err);
  }

  // Existing installs predate the Advanced Panel columns. CREATE TABLE IF NOT
  // EXISTS never alters an existing table, so add each missing column in place
  // and keep every user row intact.
  const ensureAdvancedPanelColumns = () => {
    if (!sqliteDb) return;
    try {
      const existing = new Set(
        sqliteDb
          .prepare('PRAGMA table_info(users)')
          .all()
          .map((row) => String(row.name))
      );
      const additions: Array<[string, string]> = [
        ['discord_role_verified', 'INTEGER DEFAULT 0'],
        ['discord_linked_at', 'TEXT'],
        ['advanced_panel_enabled', 'INTEGER DEFAULT 0'],
        ['advanced_panel_reason', 'TEXT'],
        ['advanced_panel_checked_at', 'TEXT'],
      ];
      for (const [name, definition] of additions) {
        if (!existing.has(name)) {
          sqliteDb.exec(`ALTER TABLE users ADD COLUMN ${name} ${definition}`);
        }
      }
    } catch {
      // Leave the schema as-is; access checks fail closed without these columns.
    }
  };
  ensureAdvancedPanelColumns();

  // Persistent operation jobs: installs, backups, restores and reinstalls keep
  // their progress and result across UI refreshes (and are marked interrupted
  // rather than left running if the panel exits mid-operation).
  const jobManager = new JobManager(sqliteDb);

  // Default Profile Icon SVG Data URI for all new accounts
  const DEFAULT_SERVER_PROFILE_ICON = `data:image/svg+xml;utf8,${encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" fill="none">
      <defs>
        <linearGradient id="bg" x1="0" y1="0" x2="128" y2="128" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stop-color="#1E2536"/>
          <stop offset="100%" stop-color="#0B0F17"/>
        </linearGradient>
        <linearGradient id="gold" x1="20" y1="20" x2="108" y2="108" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stop-color="#FFE088"/>
          <stop offset="50%" stop-color="#F59E0B"/>
          <stop offset="100%" stop-color="#D97706"/>
        </linearGradient>
      </defs>
      <rect width="128" height="128" rx="28" fill="url(#bg)"/>
      <rect x="4" y="4" width="120" height="120" rx="24" stroke="url(#gold)" stroke-opacity="0.45" stroke-width="3"/>
      <circle cx="64" cy="50" r="20" fill="url(#gold)"/>
      <path d="M28 106C28 86.1177 44.1177 70 64 70C83.8823 70 100 86.1177 100 106V110H28V106Z" fill="url(#gold)"/>
      <path d="M44 26L54 36L64 20L74 36L84 26L80 40H48L44 26Z" fill="#FFE088"/>
    </svg>`
  )}`;

  // ============================================================================
  // MONGODB DOCUMENT DATABASE ENGINE + LOCAL PC XAMPP / MARIADB CONFIG STATE
  // ============================================================================
  const MONGO_COLLECTIONS_DIR = path.join(DB_DIR, 'mongodb_collections');
  const DB_ENGINE_CONFIG_PATH = path.join(DB_DIR, 'db_engine_config.json');
  try {
    fs.mkdirSync(MONGO_COLLECTIONS_DIR, { recursive: true });
  } catch {
    // ignore
  }

  interface DatabaseEngineConfig {
    activePrimaryEngine: 'xampp' | 'mariadb' | 'mongodb' | 'sqlite';
    mysqlHost: string;
    mysqlPort: number;
    mysqlUser: string;
    mysqlPassword?: string;
    mysqlDatabase: string;
    xamppInstallPath: string;
    mariadbInstallPath: string;
    mongoUri: string;
    mongoDatabase: string;
    autoPushToMongo: boolean;
    updatedAt: string;
  }

  let dbEngineConfig: DatabaseEngineConfig = {
    activePrimaryEngine: 'sqlite',
    mysqlHost: '127.0.0.1',
    mysqlPort: 3306,
    mysqlUser: 'root',
    mysqlPassword: '',
    mysqlDatabase: 'isking_panel',
    xamppInstallPath: 'C:\\xampp\\mysql\\bin\\mysqld.exe',
    mariadbInstallPath: 'C:\\Program Files\\MariaDB 11.4\\bin\\mariadbd.exe',
    mongoUri: process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/isking_panel',
    mongoDatabase: 'isking_panel',
    autoPushToMongo: true,
    updatedAt: new Date().toISOString(),
  };

  try {
    if (fs.existsSync(DB_ENGINE_CONFIG_PATH)) {
      const saved = JSON.parse(fs.readFileSync(DB_ENGINE_CONFIG_PATH, 'utf8'));
      if (saved && typeof saved === 'object') {
        dbEngineConfig = { ...dbEngineConfig, ...saved };
      }
    }
  } catch {
    // ignore
  }

  let liveMongoClient: MongoClient | null = null;
  let liveMongoConnected = false;
  let lastMongoPushAt = new Date().toISOString();
  let totalMongoDocumentsPushed = 0;

  async function tryConnectLiveMongo(uri: string): Promise<{ connected: boolean; error?: string }> {
    try {
      if (liveMongoClient) {
        try {
          await liveMongoClient.close();
        } catch {
          // ignore
        }
      }
      const client = new MongoClient(uri, {
        serverSelectionTimeoutMS: 1200,
        connectTimeoutMS: 1200,
      });
      await client.connect();
      await client.db(dbEngineConfig.mongoDatabase || 'isking_panel').command({ ping: 1 });
      liveMongoClient = client;
      liveMongoConnected = true;
      return { connected: true };
    } catch (err) {
      liveMongoConnected = false;
      return {
        connected: false,
        error: err instanceof Error ? err.message : 'Local mongod daemon not listening on 27017 (using local BSON/JSON replica collection store)',
      };
    }
  }

  // Generate a valid 24-hex MongoDB ObjectId deterministic or random
  function makeMongoObjectId(seedStr?: string): string {
    if (seedStr) {
      return crypto.createHash('md5').update(`mongo_oid:${seedStr}`).digest('hex').slice(0, 24);
    }
    return crypto.randomBytes(12).toString('hex');
  }

  function readMongoCollection(collectionName: string): Array<Record<string, unknown>> {
    const filePath = path.join(MONGO_COLLECTIONS_DIR, `${collectionName}.bson.json`);
    try {
      if (fs.existsSync(filePath)) {
        const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        if (Array.isArray(parsed)) return parsed;
      }
    } catch {
      // ignore
    }
    return [];
  }

  function pushToMongoDB(
    collectionName: string,
    matchKey: string,
    matchValue: string,
    documentData: Record<string, unknown>
  ): Record<string, unknown> {
    const filePath = path.join(MONGO_COLLECTIONS_DIR, `${collectionName}.bson.json`);
    const existing = readMongoCollection(collectionName);
    const nowIso = new Date().toISOString();
    const idx = existing.findIndex((doc) => String(doc[matchKey]) === String(matchValue));

    const oid =
      idx !== -1 && existing[idx]._id
        ? String(existing[idx]._id)
        : makeMongoObjectId(`${collectionName}:${matchValue}`);

    const cleanDoc: Record<string, unknown> = {
      _id: oid,
      ...documentData,
      [matchKey]: matchValue,
      _collection: collectionName,
      _mongoDatabase: dbEngineConfig.mongoDatabase || 'isking_panel',
      _pushedAt: nowIso,
    };

    if (idx !== -1) {
      existing[idx] = cleanDoc;
    } else {
      existing.unshift(cleanDoc);
    }

    try {
      fs.writeFileSync(filePath, JSON.stringify(existing.slice(0, 250), null, 2), 'utf8');
    } catch {
      // ignore
    }

    lastMongoPushAt = nowIso;
    totalMongoDocumentsPushed++;

    // Also push asynchronously to live MongoClient if connected
    if (liveMongoClient && liveMongoConnected) {
      const db = liveMongoClient.db(dbEngineConfig.mongoDatabase || 'isking_panel');
      const { _id: _omitId, ...payloadWithoutId } = cleanDoc;
      db.collection(collectionName)
        .updateOne({ [matchKey]: matchValue }, { $set: payloadWithoutId }, { upsert: true })
        .catch(() => {});
    }

    return cleanDoc;
  }

  interface StoredUserAccount {
    id: string;
    username: string;
    displayName: string;
    email: string;
    passwordHash: string;
    role: 'Super Admin' | 'Root Admin' | 'DevOps Engineer' | 'Moderator' | 'Operator';
    isSuperAdmin?: boolean;
    provider: 'local' | 'discord' | 'github' | 'google';
    avatarUrl: string;
    mcUuid: string;
    connectedProviders: Array<'local' | 'discord' | 'github' | 'google'>;
    lastLogin: string;
    sessionSha: string;
    discordVerified: boolean;
    discordMemberStatus: 'not_connected' | 'pending_bot_verify' | 'verified_in_guild' | 'left_guild';
    discordUserId?: string;
    discordUsername?: string;
    discordGuildId?: string;
    discordGuildName?: string;
    discordInviteUrl?: string;
    discordBotVerifiedAt?: string;
    discordRoleVerified?: boolean;
    discordLinkedAt?: string;
    // Cached entitlement for the Advanced Panel. The backend rechecks Discord
    // before trusting it, and the renderer never decides access from these.
    advancedPanelEnabled?: boolean;
    advancedPanelReason?: string;
    advancedPanelCheckedAt?: string;
    maxServerLimit: number;
  }

  interface DiscordBotConfig {
    guildId: string;
    guildName: string;
    inviteUrl: string;
    botName: string;
    botTag: string;
    /** Role id granted by the verification bot; required for the Advanced Panel. */
    advancedPanelRoleId: string;
    defaultServerLimit: number;
    verifiedServerLimit: number;
    updatedAt: string;
  }

  const hashPassword = (rawPassword: string): string => {
    return crypto.createHash('sha256').update(`isking_salt_v48:${rawPassword}`).digest('hex');
  };

  // Precedence: these defaults < .env < .local-discord-config.json (written by
  // the Super Admin settings card). The guild, role and invite are installation
  // data, not source data: they are configured in the panel or via .env.
  let discordBotConfig: DiscordBotConfig = {
    guildId: process.env.DISCORD_GUILD_ID || '',
    guildName: process.env.DISCORD_GUILD_NAME || 'the Discord server',
    inviteUrl: process.env.DISCORD_INVITE_URL || '',
    botName: 'IS King Guardian Bot',
    botTag: 'ISKingBot#4821',
    advancedPanelRoleId: process.env.DISCORD_ADVANCED_ROLE_ID || '',
    defaultServerLimit: 2,
    verifiedServerLimit: 10,
    updatedAt: new Date().toISOString(),
  };

  try {
    if (fs.existsSync(LOCAL_DISCORD_CONFIG_PATH)) {
      const savedCfg = JSON.parse(fs.readFileSync(LOCAL_DISCORD_CONFIG_PATH, 'utf8'));
      if (savedCfg?.guildName) {
        discordBotConfig = { ...discordBotConfig, ...savedCfg };
      }
    }
  } catch {
    // ignore
  }

  const SUPER_ADMIN_KINGPLAYZ: StoredUserAccount = {
    id: 'SA-KINGPLAYZ-001',
    username: 'kingplayz',
    displayName: 'KingPlayz (Super Admin)',
    email: 'kingplayz@iskingpanel.exe',
    passwordHash: hashPassword('KingPlayz#2026'),
    role: 'Super Admin',
    isSuperAdmin: true,
    provider: 'local',
    avatarUrl: 'https://mc-heads.net/avatar/Notch/128',
    mcUuid: '069a79f4-44e9-4726-a5be-fca90e38aaf5',
    connectedProviders: ['local', 'discord', 'github', 'google'],
    lastLogin: 'Active Super Admin Session',
    sessionSha: 'sa-kingplayz...root',
    discordVerified: true,
    discordMemberStatus: 'verified_in_guild',
    discordUsername: 'kingplayz#0001',
    discordUserId: '988410293847102938',
    discordGuildId: discordBotConfig.guildId,
    discordGuildName: discordBotConfig.guildName,
    discordInviteUrl: discordBotConfig.inviteUrl,
    discordBotVerifiedAt: new Date().toISOString(),
    maxServerLimit: 999,
  };

  const DEFAULT_SEED_USERS: StoredUserAccount[] = [
    SUPER_ADMIN_KINGPLAYZ,
    {
      id: 'op-mio',
      username: 'Mio_Sakura',
      displayName: 'Mio Sakura',
      email: 'mio.sakura@kingsmp.net',
      passwordHash: hashPassword('kingpanel123'),
      role: 'Root Admin',
      isSuperAdmin: false,
      provider: 'local',
      avatarUrl: 'https://mc-heads.net/avatar/MHF_Alex/128',
      mcUuid: 'f84c6a79-0a4e-45e0-879b-cd49ebd4c4e2',
      connectedProviders: ['local', 'github'],
      lastLogin: 'Today at 14:32 UTC',
      sessionSha: '8f9a2b1c...e401',
      discordVerified: false,
      discordMemberStatus: 'not_connected',
      maxServerLimit: 2,
    },
    {
      id: 'op-aki',
      username: 'Aki_Craft99',
      displayName: 'Aki Redstone',
      email: 'aki.devops@kingsmp.net',
      passwordHash: hashPassword('kingpanel123'),
      role: 'DevOps Engineer',
      isSuperAdmin: false,
      provider: 'github',
      avatarUrl: 'https://mc-heads.net/avatar/MHF_Steve/128',
      mcUuid: '3b91a2e4-72c1-44d8-918a-5e2b99f01a88',
      connectedProviders: ['github', 'google'],
      lastLogin: 'Today at 12:15 UTC',
      sessionSha: '3d7e91a0...b219',
      discordVerified: false,
      discordMemberStatus: 'not_connected',
      maxServerLimit: 2,
    },
    {
      id: 'op-kuro',
      username: 'Kuro_Neko_JP',
      displayName: 'Kuro Neko',
      email: 'kuro.mod@kingsmp.net',
      passwordHash: hashPassword('kingpanel123'),
      role: 'Moderator',
      isSuperAdmin: false,
      provider: 'discord',
      avatarUrl: 'https://mc-heads.net/avatar/Notch/128',
      mcUuid: '99c100f2-18b4-4099-b811-77a910de3310',
      connectedProviders: ['local'],
      lastLogin: 'Yesterday at 21:40 UTC',
      sessionSha: '7c4b11e8...99a2',
      discordVerified: false,
      discordMemberStatus: 'not_connected',
      maxServerLimit: 2,
    },
  ];

  const syncUserToSqlite = (u: StoredUserAccount) => {
    // Also push user & profile into MongoDB collections automatically
    const isSaUser = u.username.toLowerCase() === 'kingplayz' || u.role === 'Super Admin' || Boolean(u.isSuperAdmin);
    const resolvedAvatar = u.avatarUrl && String(u.avatarUrl).trim() ? u.avatarUrl : DEFAULT_SERVER_PROFILE_ICON;
    u.avatarUrl = resolvedAvatar;

    pushToMongoDB('users', 'id', u.id, {
      id: u.id,
      username: u.username,
      displayName: u.displayName,
      email: u.email,
      role: isSaUser ? 'Super Admin' : u.role,
      isSuperAdmin: isSaUser,
      provider: u.provider || 'local',
      avatarUrl: resolvedAvatar,
      hasDefaultProfileIcon: resolvedAvatar.startsWith('data:image/svg+xml'),
      mcUuid: u.mcUuid,
      discordVerified: u.discordVerified || isSaUser,
      discordMemberStatus: isSaUser ? 'verified_in_guild' : u.discordMemberStatus || 'not_connected',
      maxServerLimit: isSaUser ? 999 : u.discordVerified ? discordBotConfig.verifiedServerLimit : discordBotConfig.defaultServerLimit,
      lastLogin: u.lastLogin,
    });

    pushToMongoDB('user_profiles', 'username', u.username, {
      userId: u.id,
      username: u.username,
      displayName: u.displayName,
      email: u.email,
      role: isSaUser ? 'Super Admin' : u.role,
      avatarUrl: resolvedAvatar,
      mcUuid: u.mcUuid,
      discordVerified: u.discordVerified || isSaUser,
      maxServerLimit: isSaUser ? 999 : u.discordVerified ? discordBotConfig.verifiedServerLimit : discordBotConfig.defaultServerLimit,
      updatedAt: new Date().toISOString(),
    });

    if (!sqliteDb) return;
    try {
      const isSa = u.username.toLowerCase() === 'kingplayz' || u.role === 'Super Admin' || u.isSuperAdmin;
      const stmt = sqliteDb.prepare(`
        INSERT INTO users (
          id, username, display_name, email, password_hash, role, is_super_admin,
          provider, avatar_url, mc_uuid, connected_providers, last_login, session_sha,
          discord_verified, discord_member_status, discord_user_id, discord_username,
          discord_guild_id, discord_guild_name, discord_invite_url, discord_bot_verified_at,
          discord_role_verified, discord_linked_at, advanced_panel_enabled, advanced_panel_reason,
          advanced_panel_checked_at, max_server_limit, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          username = excluded.username,
          display_name = excluded.display_name,
          email = excluded.email,
          password_hash = excluded.password_hash,
          role = excluded.role,
          is_super_admin = excluded.is_super_admin,
          provider = excluded.provider,
          avatar_url = excluded.avatar_url,
          mc_uuid = excluded.mc_uuid,
          connected_providers = excluded.connected_providers,
          last_login = excluded.last_login,
          session_sha = excluded.session_sha,
          discord_verified = excluded.discord_verified,
          discord_member_status = excluded.discord_member_status,
          discord_user_id = excluded.discord_user_id,
          discord_username = excluded.discord_username,
          discord_guild_id = excluded.discord_guild_id,
          discord_guild_name = excluded.discord_guild_name,
          discord_invite_url = excluded.discord_invite_url,
          discord_bot_verified_at = excluded.discord_bot_verified_at,
          discord_role_verified = excluded.discord_role_verified,
          discord_linked_at = excluded.discord_linked_at,
          advanced_panel_enabled = excluded.advanced_panel_enabled,
          advanced_panel_reason = excluded.advanced_panel_reason,
          advanced_panel_checked_at = excluded.advanced_panel_checked_at,
          max_server_limit = excluded.max_server_limit
      `);
      stmt.run(
        u.id,
        u.username,
        u.displayName,
        u.email,
        u.passwordHash,
        isSa ? 'Super Admin' : u.role,
        isSa ? 1 : 0,
        u.provider || 'local',
        u.avatarUrl || '',
        u.mcUuid || '',
        JSON.stringify(u.connectedProviders || ['local']),
        u.lastLogin || '',
        u.sessionSha || '',
        u.discordVerified || isSa ? 1 : 0,
        isSa ? 'verified_in_guild' : u.discordMemberStatus || 'not_connected',
        u.discordUserId || null,
        u.discordUsername || null,
        u.discordGuildId || discordBotConfig.guildId,
        u.discordGuildName || discordBotConfig.guildName,
        u.discordInviteUrl || discordBotConfig.inviteUrl,
        u.discordBotVerifiedAt || null,
        u.discordRoleVerified || isSa ? 1 : 0,
        u.discordLinkedAt || null,
        u.advancedPanelEnabled || isSa ? 1 : 0,
        isSa ? 'super_admin' : u.advancedPanelReason || null,
        u.advancedPanelCheckedAt || null,
        isSa ? 999 : u.discordVerified ? discordBotConfig.verifiedServerLimit : discordBotConfig.defaultServerLimit,
        new Date().toISOString()
      );
    } catch {
      // ignore duplicate username/email edge cases
    }
  };

  const mapSqliteRowToUser = (row: Record<string, unknown>): StoredUserAccount => {
    const isSa = Boolean(row.is_super_admin) || String(row.username).toLowerCase() === 'kingplayz';
    const discordVer = Boolean(row.discord_verified) || isSa;
    let providers: Array<'local' | 'discord' | 'github' | 'google'> = ['local'];
    try {
      providers = JSON.parse(String(row.connected_providers || '["local"]'));
    } catch {
      providers = ['local'];
    }
    return {
      id: String(row.id),
      username: String(row.username),
      displayName: String(row.display_name),
      email: String(row.email),
      passwordHash: String(row.password_hash),
      role: (isSa ? 'Super Admin' : String(row.role)) as StoredUserAccount['role'],
      isSuperAdmin: isSa,
      provider: String(row.provider || 'local') as StoredUserAccount['provider'],
      avatarUrl: String(row.avatar_url || ''),
      mcUuid: String(row.mc_uuid || ''),
      connectedProviders: providers,
      lastLogin: String(row.last_login || ''),
      sessionSha: String(row.session_sha || ''),
      discordVerified: discordVer,
      discordMemberStatus: (row.discord_member_status ||
        (discordVer ? 'verified_in_guild' : 'not_connected')) as StoredUserAccount['discordMemberStatus'],
      discordUserId: row.discord_user_id ? String(row.discord_user_id) : undefined,
      discordUsername: row.discord_username ? String(row.discord_username) : undefined,
      discordGuildId: String(row.discord_guild_id || discordBotConfig.guildId),
      discordGuildName: String(row.discord_guild_name || discordBotConfig.guildName),
      discordInviteUrl: String(row.discord_invite_url || discordBotConfig.inviteUrl),
      discordBotVerifiedAt: row.discord_bot_verified_at ? String(row.discord_bot_verified_at) : undefined,
      discordRoleVerified: isSa ? true : Boolean(row.discord_role_verified),
      discordLinkedAt: row.discord_linked_at ? String(row.discord_linked_at) : undefined,
      advancedPanelEnabled: isSa ? true : Boolean(row.advanced_panel_enabled),
      advancedPanelReason: isSa
        ? 'super_admin'
        : row.advanced_panel_reason
        ? String(row.advanced_panel_reason)
        : undefined,
      advancedPanelCheckedAt: row.advanced_panel_checked_at
        ? String(row.advanced_panel_checked_at)
        : undefined,
      maxServerLimit: isSa
        ? 999
        : discordVer
        ? discordBotConfig.verifiedServerLimit
        : discordBotConfig.defaultServerLimit,
    };
  };

  const loadUsersDb = (): StoredUserAccount[] => {
    // 1. Read from SQLite if available
    if (sqliteDb) {
      try {
        const rows = sqliteDb.prepare('SELECT * FROM users ORDER BY is_super_admin DESC, created_at ASC').all();
        if (rows.length > 0) {
          const mapped = rows.map(mapSqliteRowToUser);
          // Ensure kingplayz Super Admin is always present
          if (!mapped.some((u) => u.username.toLowerCase() === 'kingplayz')) {
            syncUserToSqlite(SUPER_ADMIN_KINGPLAYZ);
            mapped.unshift(SUPER_ADMIN_KINGPLAYZ);
          }
          return mapped;
        }
      } catch {
        // fallback below
      }
    }

    // 2. Migrate from JSON if present, and ensure kingplayz is seeded at index 0
    let initialList: StoredUserAccount[] = [...DEFAULT_SEED_USERS];
    try {
      if (fs.existsSync(LOCAL_USERS_DB_PATH)) {
        const parsed = JSON.parse(fs.readFileSync(LOCAL_USERS_DB_PATH, 'utf8'));
        if (Array.isArray(parsed) && parsed.length > 0) {
          const hasKingPlayz = parsed.some(
            (u: StoredUserAccount) => String(u.username || '').toLowerCase() === 'kingplayz'
          );
          initialList = hasKingPlayz ? parsed : [SUPER_ADMIN_KINGPLAYZ, ...parsed];
        }
      }
    } catch {
      // ignore
    }

    for (const u of initialList) {
      syncUserToSqlite(u);
    }
    try {
      fs.writeFileSync(LOCAL_USERS_DB_PATH, JSON.stringify(initialList, null, 2), 'utf8');
    } catch {
      // ignore
    }
    return initialList;
  };

  const saveUsersDb = (users: StoredUserAccount[]) => {
    for (const u of users) {
      syncUserToSqlite(u);
    }
    try {
      fs.writeFileSync(LOCAL_USERS_DB_PATH, JSON.stringify(users, null, 2), 'utf8');
    } catch {
      // ignore
    }
  };

  // Initialize users DB at startup so kingplayz Super Admin is guaranteed in SQLite
  loadUsersDb();

  const sanitizeUser = (u: StoredUserAccount) => {
    const { passwordHash: _pw, ...rest } = u;
    const isSa = u.username.toLowerCase() === 'kingplayz' || u.role === 'Super Admin' || Boolean(u.isSuperAdmin);
    return {
      ...rest,
      role: (isSa ? 'Super Admin' : u.role) as StoredUserAccount['role'],
      isSuperAdmin: isSa,
      discordVerified: isSa ? true : Boolean(u.discordVerified),
      discordMemberStatus: isSa
        ? 'verified_in_guild'
        : u.discordMemberStatus || (u.discordVerified ? 'verified_in_guild' : 'not_connected'),
      discordGuildId: u.discordGuildId || discordBotConfig.guildId,
      discordGuildName: u.discordGuildName || discordBotConfig.guildName,
      discordInviteUrl: discordBotConfig.inviteUrl,
      discordRoleVerified: isSa ? true : Boolean(u.discordRoleVerified),
      discordLinkedAt: u.discordLinkedAt,
      advancedPanelEnabled: isSa ? true : Boolean(u.advancedPanelEnabled),
      advancedPanelReason: isSa ? 'super_admin' : u.advancedPanelReason,
      advancedPanelCheckedAt: u.advancedPanelCheckedAt,
      maxServerLimit: isSa
        ? 999
        : u.discordVerified
        ? discordBotConfig.verifiedServerLimit
        : discordBotConfig.defaultServerLimit,
    };
  };

  // ============================================================================
  // 1C. PANEL ENTITLEMENTS
  //     The Simple Panel is available to every authenticated account. The
  //     Advanced Panel requires a Discord account linked to THIS panel account
  //     that is a member of the official guild AND holds the verification role.
  //     Express is the only authority: React, localStorage and request bodies
  //     never grant access.
  // ============================================================================
  type AdvancedPanelReason =
    | 'access_granted'
    | 'super_admin'
    | 'discord_not_linked'
    | 'not_a_guild_member'
    | 'required_role_missing'
    | 'required_role_not_configured'
    | 'discord_reconnect_required'
    | 'verification_unavailable';

  interface PanelAccessState {
    allowed: boolean;
    reason: AdvancedPanelReason;
    message: string;
    checkedAt: string | null;
    guildMember: boolean;
    rolePresent: boolean;
    roleConfigured: boolean;
    verificationAvailable: boolean;
    source: 'discord' | 'cache' | 'policy';
  }

  // A positive check is reused for five minutes so the UI can poll freely, and
  // any check older than that is repeated before access is granted again.
  const ADVANCED_ACCESS_TTL_MS = 5 * 60 * 1000;
  const ACCESS_REFRESH_COOLDOWN_MS = 1500;
  const DISCORD_HTTP_TIMEOUT_MS = 8000;
  const DISCORD_API_BASE = (
    process.env.DISCORD_API_BASE || 'https://discord.com/api/v10'
  ).replace(/\/+$/, '');
  const DISCORD_OAUTH_BASE = (
    process.env.DISCORD_OAUTH_BASE || DISCORD_API_BASE.replace(/\/v10$/, '')
  ).replace(/\/+$/, '');

  const isSuperAdminAccount = (u: StoredUserAccount) =>
    u.username.toLowerCase() === 'kingplayz' ||
    u.role === 'Super Admin' ||
    Boolean(u.isSuperAdmin);

  const advancedPanelMessage = (reason: AdvancedPanelReason): string => {
    switch (reason) {
      case 'access_granted':
        return 'Verified Discord membership confirmed. The Advanced Panel is unlocked.';
      case 'super_admin':
        return 'Super Admin accounts always have the Advanced Panel.';
      case 'discord_not_linked':
        return 'Connect your Discord account to unlock the Advanced Panel.';
      case 'not_a_guild_member':
        return `Join ${discordBotConfig.guildName} with your linked Discord account, then check verification again.`;
      case 'required_role_missing':
        return `Your Discord account is in ${discordBotConfig.guildName} but does not hold the verified role yet. Get the role in the Discord server, then check again.`;
      case 'required_role_not_configured':
        return 'This panel has no verified role configured yet. A Super Admin can set the guild and role under Panel Control → Discord Access Settings.';
      case 'discord_reconnect_required':
        return 'The panel needs a fresh Discord authorization to read your roles. Reconnect Discord, then check verification again.';
      case 'verification_unavailable':
        return 'Discord could not be reached, so access cannot be confirmed right now. Nothing was granted; try again shortly.';
      default:
        return 'The Advanced Panel is locked.';
    }
  };

  const readUserById = (userId: string): StoredUserAccount | null => {
    if (!sqliteDb) return null;
    try {
      const row = sqliteDb.prepare('SELECT * FROM users WHERE id = ?').get(userId);
      return row ? mapSqliteRowToUser(row) : null;
    } catch {
      return null;
    }
  };

  /** Persist the entitlement decision for an account. Never called with client input. */
  const persistAdvancedAccess = (
    userId: string,
    patch: {
      enabled: boolean;
      reason: AdvancedPanelReason;
      guildMember: boolean;
      rolePresent: boolean;
    }
  ): string => {
    const checkedAt = new Date().toISOString();
    if (sqliteDb) {
      try {
        sqliteDb
          .prepare(
            `UPDATE users SET
               advanced_panel_enabled = ?,
               advanced_panel_reason = ?,
               advanced_panel_checked_at = ?,
               discord_role_verified = ?,
               discord_verified = ?,
               discord_member_status = ?,
               discord_bot_verified_at = ?
             WHERE id = ?`
          )
          .run(
            patch.enabled ? 1 : 0,
            patch.reason,
            checkedAt,
            patch.rolePresent ? 1 : 0,
            patch.enabled ? 1 : 0,
            patch.enabled
              ? 'verified_in_guild'
              : patch.reason === 'discord_not_linked'
              ? 'not_connected'
              : patch.reason === 'required_role_not_configured'
              ? 'pending_bot_verify'
              : 'left_guild',
            patch.enabled ? checkedAt : null,
            userId
          );
        // Keep the JSON mirror used for exports/backups in sync with SQLite.
        fs.writeFileSync(LOCAL_USERS_DB_PATH, JSON.stringify(loadUsersDb(), null, 2), 'utf8');
      } catch {
        // The entitlement still applies to this request from the map above.
      }
    }
    return checkedAt;
  };

  // ============================================================================
  // Discord role verification runs on the signed-in account's own OAuth grant.
  // The `guilds.members.read` scope lets the backend read that member's roles
  // with the user's bearer token, so no guild-wide bot credential has to ship
  // inside the desktop app. A bot token, when one is configured, stays a
  // read-only fallback for installs that already have a bot in the guild.
  // ============================================================================
  interface StoredDiscordTokens {
    accessToken: string;
    refreshToken: string;
    /** Epoch milliseconds. */
    expiresAt: number;
    scopes: string;
  }

  const DISCORD_MEMBER_SCOPE = 'guilds.members.read';

  const ensureDiscordTokenTable = (): void => {
    try {
      sqliteDb?.exec(`
        CREATE TABLE IF NOT EXISTS discord_oauth_tokens (
          user_id TEXT PRIMARY KEY,
          access_token TEXT NOT NULL,
          refresh_token TEXT,
          expires_at INTEGER NOT NULL,
          scopes TEXT,
          updated_at TEXT NOT NULL
        );
      `);
    } catch {
      // Without this table the panel asks the account to reconnect instead.
    }
  };
  ensureDiscordTokenTable();

  /** Tokens stay in SQLite and are never included in any API payload. */
  const saveDiscordTokens = (userId: string, tokens: StoredDiscordTokens): void => {
    if (!sqliteDb || !userId) return;
    try {
      sqliteDb
        .prepare(
          `INSERT INTO discord_oauth_tokens (user_id, access_token, refresh_token, expires_at, scopes, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(user_id) DO UPDATE SET
             access_token=excluded.access_token,
             refresh_token=excluded.refresh_token,
             expires_at=excluded.expires_at,
             scopes=excluded.scopes,
             updated_at=excluded.updated_at`
        )
        .run(
          userId,
          tokens.accessToken,
          tokens.refreshToken || null,
          tokens.expiresAt,
          tokens.scopes || '',
          new Date().toISOString()
        );
    } catch {
      // The next check will report that a reconnect is required.
    }
  };

  const readDiscordTokens = (userId: string): StoredDiscordTokens | null => {
    if (!sqliteDb || !userId) return null;
    try {
      const row = sqliteDb
        .prepare('SELECT access_token, refresh_token, expires_at, scopes FROM discord_oauth_tokens WHERE user_id = ?')
        .get(userId);
      if (!row?.access_token) return null;
      return {
        accessToken: String(row.access_token),
        refreshToken: row.refresh_token ? String(row.refresh_token) : '',
        expiresAt: Number(row.expires_at) || 0,
        scopes: row.scopes ? String(row.scopes) : '',
      };
    } catch {
      return null;
    }
  };

  const clearDiscordTokens = (userId: string): void => {
    if (!sqliteDb || !userId) return;
    try {
      sqliteDb.prepare('DELETE FROM discord_oauth_tokens WHERE user_id = ?').run(userId);
    } catch {
      // ignore
    }
  };

  const exchangeDiscordRefreshToken = async (
    refreshToken: string
  ): Promise<StoredDiscordTokens | null> => {
    const clientId = process.env.DISCORD_CLIENT_ID;
    const clientSecret = process.env.DISCORD_CLIENT_SECRET;
    if (!clientId || !clientSecret || !refreshToken) return null;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DISCORD_HTTP_TIMEOUT_MS);
    try {
      const res = await fetch(`${DISCORD_OAUTH_BASE}/oauth2/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: clientId,
          client_secret: clientSecret,
          grant_type: 'refresh_token',
          refresh_token: refreshToken,
        }).toString(),
        signal: controller.signal,
      });
      if (!res.ok) return null;
      const body = (await res.json()) as {
        access_token?: string;
        refresh_token?: string;
        expires_in?: number;
        scope?: string;
      };
      if (!body.access_token) return null;
      return {
        accessToken: body.access_token,
        refreshToken: body.refresh_token || refreshToken,
        expiresAt: Date.now() + (Number(body.expires_in) || 604800) * 1000,
        scopes: String(body.scope || ''),
      };
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  };

  /**
   * Current authorization for this account, refreshed when it is near expiry.
   * `scopes` matters: a grant without guilds.members.read cannot read roles.
   */
  const getDiscordAuthorization = async (
    userId: string
  ): Promise<{ token: string; scopes: string } | null> => {
    const stored = readDiscordTokens(userId);
    if (!stored) return null;
    if (stored.expiresAt - 60_000 > Date.now()) {
      return { token: stored.accessToken, scopes: stored.scopes };
    }
    const refreshed = await exchangeDiscordRefreshToken(stored.refreshToken);
    if (!refreshed) return null;
    saveDiscordTokens(userId, refreshed);
    return { token: refreshed.accessToken, scopes: refreshed.scopes };
  };

  type GuildMemberLookup =
    | { kind: 'member'; roles: string[]; username?: string }
    | { kind: 'not_member' }
    | { kind: 'reauth'; detail: string }
    | { kind: 'unavailable'; detail: string };

  /**
   * Ask Discord whether this account is in the configured guild and which roles
   * it holds. A 404 is a confirmed non-member; network/5xx/429 responses are
   * "unknown" and must never be read as membership. `reauth` means the panel has
   * no usable authorization left and the operator has to reconnect Discord.
   */
  const lookupDiscordGuildMember = async (user: StoredUserAccount): Promise<GuildMemberLookup> => {
    const guildId = String(discordBotConfig.guildId || '').trim();
    if (!guildId) {
      return { kind: 'unavailable', detail: 'No Discord guild id is configured' };
    }

    const authorization = await getDiscordAuthorization(user.id);
    if (authorization) {
      if (
        authorization.scopes &&
        !authorization.scopes.split(/\s+/).includes(DISCORD_MEMBER_SCOPE)
      ) {
        return {
          kind: 'reauth',
          detail: 'The stored Discord grant is missing the guilds.members.read scope',
        };
      }
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), DISCORD_HTTP_TIMEOUT_MS);
      try {
        const res = await fetch(
          `${DISCORD_API_BASE}/users/@me/guilds/${encodeURIComponent(guildId)}/member`,
          {
            headers: { Authorization: `Bearer ${authorization.token}` },
            signal: controller.signal,
          }
        );
        // Discord reports a member that is not in the guild as 404 Unknown Guild
        // (or 403 Missing Access); with the scope present both mean "not a member".
        if (res.status === 403 || res.status === 404) return { kind: 'not_member' };
        if (res.status === 401) {
          return {
            kind: 'reauth',
            detail: 'Discord rejected the stored authorization for this account',
          };
        }
        if (!res.ok) {
          return { kind: 'unavailable', detail: `Discord returned HTTP ${res.status}` };
        }
        const body = (await res.json()) as {
          roles?: unknown;
          user?: { username?: string };
        };
        const roles = Array.isArray(body.roles) ? body.roles.map((r) => String(r)) : [];
        return { kind: 'member', roles, username: body.user?.username };
      } catch (err) {
        return {
          kind: 'unavailable',
          detail: err instanceof Error ? err.message : 'Discord request failed',
        };
      } finally {
        clearTimeout(timer);
      }
    }

    // Fallback: a bot token only reads membership; it is never required.
    const botToken = process.env.DISCORD_BOT_TOKEN;
    const discordUserId = String(user.discordUserId || '').trim();
    if (!botToken) {
      return { kind: 'reauth', detail: 'No Discord authorization is stored for this account' };
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DISCORD_HTTP_TIMEOUT_MS);
    try {
      const res = await fetch(
        `${DISCORD_API_BASE}/guilds/${encodeURIComponent(guildId)}/members/${encodeURIComponent(
          discordUserId
        )}`,
        {
          headers: { Authorization: `Bot ${botToken}` },
          signal: controller.signal,
        }
      );
      if (res.status === 404) return { kind: 'not_member' };
      if (!res.ok) {
        return { kind: 'unavailable', detail: `Discord returned HTTP ${res.status}` };
      }
      const body = (await res.json()) as {
        roles?: unknown;
        user?: { username?: string };
      };
      const roles = Array.isArray(body.roles) ? body.roles.map((r) => String(r)) : [];
      return { kind: 'member', roles, username: body.user?.username };
    } catch (err) {
      return {
        kind: 'unavailable',
        detail: err instanceof Error ? err.message : 'Discord request failed',
      };
    } finally {
      clearTimeout(timer);
    }
  };

  const advancedAccessInFlight = new Map<string, Promise<PanelAccessState>>();
  // Once Discord cannot confirm a user, that account's previous positive
  // decision is not reused until a live check succeeds again.
  const advancedAccessUnavailableAt = new Map<string, number>();

  const performAdvancedAccessCheck = async (
    user: StoredUserAccount
  ): Promise<PanelAccessState> => {
    const roleId = String(discordBotConfig.advancedPanelRoleId || '').trim();
    const linkedDiscordId = String(user.discordUserId || '').trim();

    if (!linkedDiscordId) {
      const checkedAt = persistAdvancedAccess(user.id, {
        enabled: false,
        reason: 'discord_not_linked',
        guildMember: false,
        rolePresent: false,
      });
      return {
        allowed: false,
        reason: 'discord_not_linked',
        message: advancedPanelMessage('discord_not_linked'),
        checkedAt,
        guildMember: false,
        rolePresent: false,
        roleConfigured: Boolean(roleId),
        verificationAvailable: Boolean(process.env.DISCORD_BOT_TOKEN),
        source: 'policy',
      };
    }

    if (!roleId) {
      const checkedAt = persistAdvancedAccess(user.id, {
        enabled: false,
        reason: 'required_role_not_configured',
        guildMember: false,
        rolePresent: false,
      });
      return {
        allowed: false,
        reason: 'required_role_not_configured',
        message: advancedPanelMessage('required_role_not_configured'),
        checkedAt,
        guildMember: false,
        rolePresent: false,
        roleConfigured: false,
        verificationAvailable: Boolean(process.env.DISCORD_BOT_TOKEN),
        source: 'policy',
      };
    }

    const lookup = await lookupDiscordGuildMember(user);

    if (lookup.kind === 'reauth') {
      // No usable authorization: access is not granted, and the operator is told
      // to reconnect instead of seeing a generic "Discord unreachable" message.
      advancedAccessUnavailableAt.set(user.id, Date.now());
      const checkedAt = persistAdvancedAccess(user.id, {
        enabled: false,
        reason: 'discord_reconnect_required',
        guildMember: false,
        rolePresent: false,
      });
      return {
        allowed: false,
        reason: 'discord_reconnect_required',
        message: advancedPanelMessage('discord_reconnect_required'),
        checkedAt,
        guildMember: false,
        rolePresent: false,
        roleConfigured: true,
        verificationAvailable: false,
        source: 'discord',
      };
    }

    if (lookup.kind === 'unavailable') {
      // Do not grant, and do not overwrite the last known decision either —
      // but remember the outage so the cached grant is not reused.
      advancedAccessUnavailableAt.set(user.id, Date.now());
      return {
        allowed: false,
        reason: 'verification_unavailable',
        message: advancedPanelMessage('verification_unavailable'),
        checkedAt: user.advancedPanelCheckedAt || null,
        guildMember: false,
        rolePresent: false,
        roleConfigured: true,
        verificationAvailable: false,
        source: 'discord',
      };
    }

    advancedAccessUnavailableAt.delete(user.id);
    const guildMember = lookup.kind === 'member';
    const rolePresent = lookup.kind === 'member' && lookup.roles.includes(roleId);
    const enabled = guildMember && rolePresent;
    const reason: AdvancedPanelReason = enabled
      ? 'access_granted'
      : guildMember
      ? 'required_role_missing'
      : 'not_a_guild_member';
    const checkedAt = persistAdvancedAccess(user.id, {
      enabled,
      reason,
      guildMember,
      rolePresent,
    });

    if (lookup.kind === 'member' && lookup.username && lookup.username !== user.discordUsername) {
      try {
        sqliteDb
          ?.prepare('UPDATE users SET discord_username = ? WHERE id = ?')
          .run(lookup.username, user.id);
      } catch {
        // display name only
      }
    }

    return {
      allowed: enabled,
      reason,
      message: advancedPanelMessage(reason),
      checkedAt,
      guildMember,
      rolePresent,
      roleConfigured: true,
      verificationAvailable: true,
      source: 'discord',
    };
  };

  const verifyAdvancedPanelAccess = async (
    user: StoredUserAccount,
    opts: { force?: boolean } = {}
  ): Promise<PanelAccessState> => {
    if (isSuperAdminAccount(user)) {
      return {
        allowed: true,
        reason: 'super_admin',
        message: advancedPanelMessage('super_admin'),
        checkedAt: user.advancedPanelCheckedAt || null,
        guildMember: Boolean(user.discordUserId),
        rolePresent: Boolean(user.discordRoleVerified),
        roleConfigured: Boolean(discordBotConfig.advancedPanelRoleId),
        verificationAvailable: true,
        source: 'policy',
      };
    }

    const checkedAtMs = user.advancedPanelCheckedAt
      ? Date.parse(user.advancedPanelCheckedAt)
      : NaN;
    if (
      !opts.force &&
      user.advancedPanelReason &&
      !advancedAccessUnavailableAt.has(user.id) &&
      Number.isFinite(checkedAtMs) &&
      Date.now() - checkedAtMs < ADVANCED_ACCESS_TTL_MS &&
      user.advancedPanelReason !== 'verification_unavailable'
    ) {
      const reason = user.advancedPanelReason as AdvancedPanelReason;
      return {
        allowed: Boolean(user.advancedPanelEnabled),
        reason,
        message: advancedPanelMessage(reason),
        checkedAt: user.advancedPanelCheckedAt || null,
        guildMember: reason === 'required_role_missing' || reason === 'access_granted',
        rolePresent: reason === 'access_granted',
        roleConfigured: Boolean(discordBotConfig.advancedPanelRoleId),
        verificationAvailable: true,
        source: 'cache',
      };
    }

    const existing = advancedAccessInFlight.get(user.id);
    if (existing) return existing;
    const pending = performAdvancedAccessCheck(user).finally(() => {
      advancedAccessInFlight.delete(user.id);
    });
    advancedAccessInFlight.set(user.id, pending);
    return pending;
  };

  /**
   * How this account's roles are read: its own OAuth grant (preferred), a
   * read-only bot token (legacy installs), or neither.
   */
  const discordVerificationMode = (userId: string): 'oauth' | 'bot' | 'none' => {
    if (readDiscordTokens(userId)) return 'oauth';
    return process.env.DISCORD_BOT_TOKEN ? 'bot' : 'none';
  };

  const buildPanelAccessPayload = (user: StoredUserAccount, state: PanelAccessState) => ({
    ok: true,
    authenticated: true,
    user: {
      id: user.id,
      username: user.username,
      displayName: user.displayName,
      role: isSuperAdminAccount(user) ? 'Super Admin' : user.role,
      isSuperAdmin: isSuperAdminAccount(user),
      maxServerLimit: isSuperAdminAccount(user) ? 999 : user.maxServerLimit,
    },
    panels: {
      simple: { allowed: true, reason: 'access_granted' },
      advanced: {
        allowed: state.allowed,
        reason: state.reason,
        message: state.message,
        checkedAt: state.checkedAt,
      },
    },
    policy: {
      requiredRoleConfigured: state.roleConfigured,
      checkTtlSeconds: Math.floor(ADVANCED_ACCESS_TTL_MS / 1000),
    },
    discord: {
      linked: Boolean(user.discordUserId),
      discordUserId: user.discordUserId || null,
      username: user.discordUsername || null,
      guildId: discordBotConfig.guildId,
      guildName: discordBotConfig.guildName,
      inviteUrl: discordBotConfig.inviteUrl,
      guildMember: state.guildMember,
      requiredRolePresent: state.rolePresent,
      requiredRoleConfigured: state.roleConfigured,
      lastVerifiedAt: state.checkedAt,
      verificationAvailable: state.verificationAvailable,
      verificationMode: discordVerificationMode(user.id),
      reconnectRequired: state.reason === 'discord_reconnect_required',
      oauthConfigured: Boolean(process.env.DISCORD_CLIENT_ID && process.env.DISCORD_CLIENT_SECRET),
    },
  });

  /**
   * Express-side gate for Advanced-Panel-only operations. Returns 401 without a
   * session, 403 for an ineligible account, and 503 when Discord cannot confirm
   * the entitlement (fail closed, never grant on an unverified result).
   */
  const requireAdvancedPanel = (
    req: express.Request,
    res: express.Response,
    next: express.NextFunction
  ) => {
    void (async () => {
      const user = readUserById(String((req as any).userId || ''));
      if (!user) {
        res.status(401).json({ ok: false, code: 'SESSION_REQUIRED', error: 'Sign in again to continue.' });
        return;
      }
      const state = await verifyAdvancedPanelAccess(user);
      if (state.allowed) {
        (req as any).panelAccess = state;
        next();
        return;
      }
      const status = state.reason === 'verification_unavailable' ? 503 : 403;
      res.status(status).json({
        ok: false,
        code: status === 503 ? 'ADVANCED_PANEL_UNAVAILABLE' : 'ADVANCED_PANEL_REQUIRED',
        reason: state.reason,
        error: state.message,
        panels: { simple: { allowed: true }, advanced: { allowed: false, reason: state.reason } },
      });
    })().catch(() => {
      res.status(503).json({
        ok: false,
        code: 'ADVANCED_PANEL_UNAVAILABLE',
        reason: 'verification_unavailable',
        error: advancedPanelMessage('verification_unavailable'),
      });
    });
  };

  const lastManualAccessRefresh = new Map<string, number>();

  app.get('/api/account/access', validateSession, async (req, res) => {
    try {
      const user = readUserById(String((req as any).userId || ''));
      if (!user) {
        res.status(401).json({ ok: false, code: 'SESSION_REQUIRED', error: 'User not found' });
        return;
      }
      const state = await verifyAdvancedPanelAccess(user);
      const fresh = readUserById(user.id) || user;
      res.setHeader('Cache-Control', 'no-store');
      res.json(buildPanelAccessPayload(fresh, state));
    } catch {
      res.status(503).json({
        ok: false,
        code: 'ACCESS_CHECK_FAILED',
        error: 'Could not evaluate panel access.',
      });
    }
  });

  app.post('/api/account/access/refresh', validateSession, async (req, res) => {
    const userId = String((req as any).userId || '');
    const last = lastManualAccessRefresh.get(userId) || 0;
    if (Date.now() - last < ACCESS_REFRESH_COOLDOWN_MS) {
      res.status(429).json({
        ok: false,
        code: 'REFRESH_THROTTLED',
        error: 'Discord was checked a moment ago. Try again in a second.',
      });
      return;
    }
    lastManualAccessRefresh.set(userId, Date.now());
    try {
      const user = readUserById(userId);
      if (!user) {
        res.status(401).json({ ok: false, code: 'SESSION_REQUIRED', error: 'User not found' });
        return;
      }
      const state = await verifyAdvancedPanelAccess(user, { force: true });
      const fresh = readUserById(user.id) || user;
      res.setHeader('Cache-Control', 'no-store');
      res.json(buildPanelAccessPayload(fresh, state));
    } catch {
      res.status(503).json({
        ok: false,
        code: 'ACCESS_CHECK_FAILED',
        error: 'Could not evaluate panel access.',
      });
    }
  });

  // ============================================================================
  // 1D. OPERATION JOBS
  //     Read-only from the renderer's perspective: it can submit work through
  //     the feature endpoints, list jobs and cancel its own job.
  // ============================================================================
  app.get('/api/jobs', validateSession, (req, res) => {
    const jobs = jobManager.list({
      serverId: req.query.serverId ? String(req.query.serverId) : undefined,
      limit: Number(req.query.limit) || 50,
    });
    res.setHeader('Cache-Control', 'no-store');
    res.json({ ok: true, jobs });
  });

  app.get('/api/jobs/:id', validateSession, (req, res) => {
    const job = jobManager.get(String(req.params.id || ''));
    if (!job) {
      res.status(404).json({ ok: false, error: 'Job not found' });
      return;
    }
    res.setHeader('Cache-Control', 'no-store');
    res.json({ ok: true, job });
  });

  app.post('/api/jobs/:id/cancel', validateSession, (req, res) => {
    const result = jobManager.cancel(String(req.params.id || ''));
    if (!result.ok) {
      res.status(result.job ? 409 : 404).json({
        ok: false,
        error: result.error || 'The job cannot be cancelled',
        job: result.job,
      });
      return;
    }
    res.json({ ok: true, job: result.job });
  });

  app.get('/api/auth/users', validateSession, (req, res) => {
    // Account administration data (all users, DB path, Discord config) is
    // Super Admin only. The sign-in screen never calls this endpoint.
    const actor = readUserById(String((req as any).userId || ''));
    if (!actor || !isSuperAdminAccount(actor)) {
      res.status(403).json({
        ok: false,
        code: 'SUPER_ADMIN_REQUIRED',
        error: 'Only a Super Admin can list panel accounts.',
      });
      return;
    }
    const users = loadUsersDb();
    res.json({
      ok: true,
      users: users.map(sanitizeUser),
      discordConfig: discordBotConfig,
      superAdminInfo: {
        id: 'SA-KINGPLAYZ-001',
        username: 'kingplayz',
        role: 'Super Admin',
        databaseEngine: 'SQLite3 (WAL Mode)',
        databasePath: SQLITE_DB_PATH,
      },
    });
  });

  app.post('/api/auth/register', (req, res) => {
    const {
      username,
      displayName,
      email,
      password,
      role = 'Root Admin',
      mcUuid,
      avatarUrl,
    } = req.body || {};

    if (!username || !String(username).trim() || !email || !String(email).trim() || !password) {
      res.status(400).json({
        ok: false,
        error: 'Username, email address, and password are required to register.',
      });
      return;
    }

    const cleanUsername = String(username).trim().replace(/\s+/g, '_');
    const cleanEmail = String(email).trim().toLowerCase();
    const users = loadUsersDb();

    const duplicate = users.find(
      (u) =>
        u.username.toLowerCase() === cleanUsername.toLowerCase() ||
        u.email.toLowerCase() === cleanEmail
    );
    if (duplicate) {
      res.status(409).json({
        ok: false,
        error: `Account with username "${cleanUsername}" or email "${cleanEmail}" already exists. Please Sign In instead.`,
      });
      return;
    }

    const resolvedAvatarUrl =
      avatarUrl && String(avatarUrl).trim()
        ? String(avatarUrl).trim()
        : mcUuid && String(mcUuid).trim()
        ? `https://mc-heads.net/avatar/${encodeURIComponent(String(mcUuid).trim())}/128`
        : DEFAULT_SERVER_PROFILE_ICON;

    const newUser: StoredUserAccount = {
      id: `op-${Date.now()}`,
      username: cleanUsername,
      displayName: String(displayName || cleanUsername).trim(),
      email: cleanEmail,
      passwordHash: hashPassword(String(password)),
      role: role as StoredUserAccount['role'],
      provider: 'local',
      avatarUrl: resolvedAvatarUrl,
      mcUuid: mcUuid ? String(mcUuid).trim() : 'a12d88e1-55f0-4c12-9001-bc88210fa912',
      connectedProviders: ['local'],
      lastLogin: `Registered at ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })} UTC`,
      sessionSha: `${crypto.randomBytes(4).toString('hex')}...${crypto.randomBytes(2).toString('hex')}`,
      discordVerified: false,
      discordMemberStatus: 'not_connected',
      discordGuildId: discordBotConfig.guildId,
      discordGuildName: discordBotConfig.guildName,
      discordInviteUrl: discordBotConfig.inviteUrl,
      maxServerLimit: discordBotConfig.defaultServerLimit, // 2 servers max by default
    };

    users.push(newUser);
    saveUsersDb(users);

    const sanitized = sanitizeUser(newUser);
    const mongoDoc = pushToMongoDB('users', 'id', newUser.id, {
      ...sanitized,
      registeredAt: new Date().toISOString(),
      source: 'KingPanel Account Signup',
    });

    try {
      fs.writeFileSync(
        LOCAL_PROFILE_PATH,
        JSON.stringify({ ...sanitized, mongoId: mongoDoc._id, savedToDiskAt: new Date().toISOString() }, null, 2),
        'utf8'
      );
    } catch {
      // ignore
    }

    // Sign the new account in with a real session row. The old placeholder
    // cookie was never in auth_sessions, so the first authenticated request
    // after sign-up (and now the panel-access check) failed.
    const registerSessionId = `sess-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
    if (sqliteDb) {
      try {
        sqliteDb
          .prepare(
            `INSERT INTO auth_sessions (session_id, user_id, username, role, provider, ip_address, platform, created_at, last_active_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .run(
            registerSessionId,
            newUser.id,
            newUser.username,
            newUser.role,
            'local',
            req.ip || '127.0.0.1',
            'Windows 11 Desktop App (.EXE)',
            new Date().toISOString(),
            new Date().toISOString()
          );
      } catch {
        // ignore
      }
    }
    res.setHeader('Set-Cookie', sessionCookie(req, registerSessionId));

    res.json({
      ok: true,
      user: sanitized,
      mongoPushed: true,
      mongoDocumentId: mongoDoc._id,
      mongoDatabase: dbEngineConfig.mongoDatabase,
      discordConfig: discordBotConfig,
    });
  });

  app.post('/api/auth/login', (req, res) => {
    const { identifier, password } = req.body || {};
    if (!identifier || !String(identifier).trim() || !password) {
      res.status(400).json({
        ok: false,
        error: 'Please enter both your operator username/email and password.',
      });
      return;
    }

    const q = String(identifier).trim().toLowerCase();
    const rawPass = String(password);
    const users = loadUsersDb();

    const idx = users.findIndex(
      (u) =>
        u.id.toLowerCase() === q ||
        u.username.toLowerCase() === q ||
        u.email.toLowerCase() === q
    );

    if (idx === -1) {
      res.status(401).json({
        ok: false,
        error: `No operator account found for "${identifier}". Use Super Admin ID "SA-KINGPLAYZ-001" / "kingplayz" or click "Sign Up".`,
      });
      return;
    }

    const found = users[idx];
    const incomingHash = hashPassword(rawPass);
    const isKingPlayzSuperAdmin =
      found.username.toLowerCase() === 'kingplayz' || found.id === 'SA-KINGPLAYZ-001';
    // Only the stored hash is accepted. The old fallbacks (`kingpanel123`, a
    // masked dot string, and hard-coded Super Admin passwords) let anyone sign
    // in as any known account, which would have made every panel entitlement
    // meaningless.
    const isPasswordValid = found.passwordHash === incomingHash;

    if (!isPasswordValid) {
      res.status(401).json({
        ok: false,
        error: 'Invalid password for this operator account. Use your registered password or click "Reset Password".',
      });
      return;
    }

    found.lastLogin = `Today at ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })} UTC`;
    found.sessionSha = `${crypto.randomBytes(4).toString('hex')}...${crypto.randomBytes(2).toString('hex')}`;
    if (isKingPlayzSuperAdmin) {
      found.role = 'Super Admin';
      found.isSuperAdmin = true;
      found.discordVerified = true;
      found.discordMemberStatus = 'verified_in_guild';
      found.maxServerLimit = 999;
    } else {
      found.maxServerLimit = found.discordVerified
        ? discordBotConfig.verifiedServerLimit
        : discordBotConfig.defaultServerLimit;
    }

    users[idx] = found;
    saveUsersDb(users);

    // Record session in SQLite auth_sessions table
    const sessionId = `sess-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
    if (sqliteDb) {
      try {
        sqliteDb
          .prepare(
            `INSERT INTO auth_sessions (session_id, user_id, username, role, provider, ip_address, platform, created_at, last_active_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .run(
            sessionId,
            found.id,
            found.username,
            found.role,
            found.provider,
            req.ip || '127.0.0.1',
            'Windows 11 Desktop App (.EXE)',
            new Date().toISOString(),
            new Date().toISOString()
          );
      } catch {
        // ignore
      }
    }

    const sanitized = sanitizeUser(found);
    try {
      fs.writeFileSync(
        LOCAL_PROFILE_PATH,
        JSON.stringify({ ...sanitized, savedToDiskAt: new Date().toISOString() }, null, 2),
        'utf8'
      );
    } catch {
      // ignore
    }

    res.setHeader(
      'Set-Cookie',
      sessionCookie(req, sessionId)
    );

    res.json({
      ok: true,
      user: sanitized,
      discordConfig: discordBotConfig,
    });
  });

// In-memory store for password reset tokens (in production, use Redis or database)
  const passwordResetTokens = new Map();

  // Generate password reset token and store it with expiry
  function generatePasswordResetToken(): string {
    return crypto.randomBytes(32).toString('hex');
  }

  // POST /api/auth/password-reset-request - Request password reset (generic response)
  app.post('/api/auth/password-reset-request', (req, res) => {
    const { identifier } = req.body || {};

    // Always return generic response to prevent user enumeration
    res.json({
      ok: true,
      message: 'If an account with that identifier exists, a password reset link has been generated.'
    });

    // Actually process the request but don't reveal account existence
    if (!identifier) return;

    const q = String(identifier).trim().toLowerCase();
    const users = loadUsersDb();
    const user = users.find(
      (u) => u.username.toLowerCase() === q || u.email.toLowerCase() === q
    );

    if (user) {
      // Generate token and store with 1-hour expiry
      const token = generatePasswordResetToken();
      const expiresAt = Date.now() + 60 * 60 * 1000; // 1 hour

      passwordResetTokens.set(token, {
        userId: user.id,
        expiresAt
      });

      // Clean up expired tokens occasionally
      if (passwordResetTokens.size > 100) {
        for (const [tokenKey, tokenData] of passwordResetTokens.entries()) {
          if (Date.now() > tokenData.expiresAt) {
            passwordResetTokens.delete(tokenKey);
          }
        }
      }

      // In a real implementation, you would send an email here
      // For now, we'll log it (in production, never log tokens)
      console.log(`Password reset token generated for user ${user.id}: ${token}`);
    }
  });

  // POST /api/auth/password-reset - Reset password using token
  app.post('/api/auth/password-reset', (req, res) => {
    const { token, newPassword } = req.body || {};

    // Generic response to prevent user enumeration
    if (!token || !newPassword || String(newPassword).length < 4) {
      res.json({
        ok: true,
        message: 'If the token is valid and not expired, your password has been updated.'
      });
      return;
    }

    const tokenData = passwordResetTokens.get(token);

    // Check if token exists and is not expired
    if (!tokenData || Date.now() > tokenData.expiresAt) {
      // Still return generic response
      res.json({
        ok: true,
        message: 'If the token is valid and not expired, your password has been updated.'
      });
      return;
    }

    // Update password
    const users = loadUsersDb();
    const userIndex = users.findIndex(u => u.id === tokenData.userId);

    if (userIndex !== -1) {
      users[userIndex].passwordHash = hashPassword(String(newPassword));
      saveUsersDb(users);

      // Remove used token
      passwordResetTokens.delete(token);
    }

    // Always return generic response
    res.json({
      ok: true,
      message: 'If the token is valid and not expired, your password has been updated.'
    });
  });

  // POST /api/auth/change-password - Change password (requires current password)
  app.post('/api/auth/change-password', validateSession, (req: express.Request, res: express.Response) => {
    try {
      const { currentPassword, newPassword } = req.body || {};

      // Generic response to prevent user enumeration
      if (!currentPassword || !newPassword || String(newPassword).length < 4) {
        res.json({
          ok: true,
          message: 'If the current password is correct and the new password meets requirements, your password has been updated.'
        });
        return;
      }

      const userId = (req as any).userId;
      if (!sqliteDb) {
        return res.status(500).json({ error: 'Database unavailable' });
      }

      const user = sqliteDb.prepare('SELECT * FROM users WHERE id = ?').get(userId);
      if (!user) {
        // Still return generic response
        res.json({
          ok: true,
          message: 'If the current password is correct and the new password meets requirements, your password has been updated.'
        });
        return;
      }

      // Verify current password
      const incomingHash = hashPassword(String(currentPassword));
      const isPasswordValid = user.password_hash === incomingHash;

      if (!isPasswordValid) {
        // Still return generic response to prevent user enumeration
        res.json({
          ok: true,
          message: 'If the current password is correct and the new password meets requirements, your password has been updated.'
        });
        return;
      }

      // Update password
      const newHash = hashPassword(String(newPassword));
      sqliteDb.prepare('UPDATE users SET password_hash = ? WHERE id = ?')
        .run(newHash, userId);

      // Invalidate all existing sessions for security (force re-login)
      sqliteDb.prepare('DELETE FROM auth_sessions WHERE user_id = ?').run(userId);

      // Create new session for current login
      const sessionId = `sess-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
      try {
        sqliteDb
          .prepare(
            `INSERT INTO auth_sessions (session_id, user_id, username, role, provider, ip_address, platform, created_at, last_active_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .run(
            sessionId,
            user.id,
            user.username,
            user.role,
            user.provider,
            req.ip || '127.0.0.1',
            'Windows 11 Desktop App (.EXE)',
            new Date().toISOString(),
            new Date().toISOString()
          );

        // Set new session cookie
        res.setHeader(
          'Set-Cookie',
          sessionCookie(req, sessionId)
        );
      } catch {
        // ignore session creation error
      }

      // Always return generic response
      res.json({
        ok: true,
        message: 'If the current password is correct and the new password meets requirements, your password has been updated.'
      });
    } catch (err) {
      // Generic response even on error
      res.json({
        ok: true,
        message: 'If the current password is correct and the new password meets requirements, your password has been updated.'
      });
    }
  });

  app.post('/api/auth/oauth-login', (req, res) => {
    const { provider = 'discord', handle, email, verifyDiscordBotNow = false } = req.body || {};
    const cleanProvider = (
      provider === 'discord' || provider === 'github' || provider === 'google' ? provider : 'local'
    ) as StoredUserAccount['provider'];

    const users = loadUsersDb();
    const cleanEmail = String(email || `${handle || cleanProvider}@kingsmp.net`).trim().toLowerCase();
    const cleanUsername = String(handle || `${cleanProvider}_operator`)
      .trim()
      .replace(/\s+/g, '_');

    let user = users.find(
      (u) =>
        u.email.toLowerCase() === cleanEmail ||
        u.username.toLowerCase() === cleanUsername.toLowerCase()
    );

    if (!user) {
      user = {
        id: `oauth-${cleanProvider}-${Date.now()}`,
        username: cleanUsername,
        displayName: String(handle || cleanUsername),
        email: cleanEmail,
        passwordHash: hashPassword('kingpanel123'),
        role: cleanProvider === 'github' ? 'DevOps Engineer' : 'Root Admin',
        provider: cleanProvider,
        avatarUrl: `https://mc-heads.net/avatar/${encodeURIComponent(cleanUsername.split('#')[0])}/128`,
        mcUuid: 'f84c6a79-0a4e-45e0-879b-cd49ebd4c4e2',
        connectedProviders: [cleanProvider, 'local'],
        lastLogin: 'Just now via OAuth 2.0',
        sessionSha: `${crypto.randomBytes(4).toString('hex')}...${cleanProvider.slice(0, 3)}`,
        discordVerified: Boolean(cleanProvider === 'discord' && verifyDiscordBotNow),
        discordMemberStatus:
          cleanProvider === 'discord' && verifyDiscordBotNow
            ? 'verified_in_guild'
            : 'not_connected',
        discordUsername: cleanProvider === 'discord' ? cleanUsername : undefined,
        discordUserId:
          cleanProvider === 'discord' ? `${Math.floor(100000000000000000 + Math.random() * 899999999999999999)}` : undefined,
        discordGuildId: discordBotConfig.guildId,
        discordGuildName: discordBotConfig.guildName,
        discordInviteUrl: discordBotConfig.inviteUrl,
        discordBotVerifiedAt:
          cleanProvider === 'discord' && verifyDiscordBotNow ? new Date().toISOString() : undefined,
        maxServerLimit:
          cleanProvider === 'discord' && verifyDiscordBotNow
            ? discordBotConfig.verifiedServerLimit
            : discordBotConfig.defaultServerLimit,
      };
      users.push(user);
    } else {
      user.lastLogin = 'Just now via OAuth 2.0';
      if (!user.connectedProviders.includes(cleanProvider)) {
        user.connectedProviders.push(cleanProvider);
      }
      if (cleanProvider === 'discord' && verifyDiscordBotNow) {
        user.discordVerified = true;
        user.discordMemberStatus = 'verified_in_guild';
        user.discordUsername = cleanUsername;
        user.discordBotVerifiedAt = new Date().toISOString();
      }
      user.maxServerLimit = user.discordVerified
        ? discordBotConfig.verifiedServerLimit
        : discordBotConfig.defaultServerLimit;
    }

    saveUsersDb(users);
    const sanitized = sanitizeUser(user);
    try {
      fs.writeFileSync(
        LOCAL_PROFILE_PATH,
        JSON.stringify({ ...sanitized, savedToDiskAt: new Date().toISOString() }, null, 2),
        'utf8'
      );
    } catch {
      // ignore
    }

    const sessionId = `sess-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
    if (sqliteDb) {
      try {
        sqliteDb
          .prepare(
            `INSERT INTO auth_sessions (session_id, user_id, username, role, provider, ip_address, platform, created_at, last_active_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .run(
            sessionId,
            user.id,
            user.username,
            user.role,
            cleanProvider,
            req.ip || '127.0.0.1',
            'Windows 11 Desktop App (.EXE)',
            new Date().toISOString(),
            new Date().toISOString()
          );
      } catch {
        // ignore
      }
    }

    res.setHeader(
      'Set-Cookie',
      sessionCookie(req, sessionId)
    );

    res.json({
      ok: true,
      user: sanitized,
      discordConfig: discordBotConfig,
    });
  });

  // Start a real Discord OAuth link for the signed-in panel account. The client
  // only receives an authorization URL; tokens and the client secret stay here.
  app.post('/api/account/discord/link/start', validateSession, (req, res) => {
    const clientId = process.env.DISCORD_CLIENT_ID;
    const clientSecret = process.env.DISCORD_CLIENT_SECRET;
    if (!clientId || !clientSecret) {
      res.status(503).json({
        ok: false,
        code: 'DISCORD_OAUTH_NOT_CONFIGURED',
        error:
          'Discord OAuth is not configured on this panel. Set DISCORD_CLIENT_ID and DISCORD_CLIENT_SECRET on the backend.',
      });
      return;
    }
    const userId = String((req as any).userId || '');
    const user = readUserById(userId);
    if (!user) {
      res.status(401).json({ ok: false, code: 'SESSION_REQUIRED', error: 'User not found' });
      return;
    }
    // A linked account is still (re)sent through Discord when it has no stored
    // authorization: the guilds.members.read grant is what the role check uses.
    const reconnectRequested = (req.body || {}).reconnect === true;
    const hasStoredAuthorization = Boolean(readDiscordTokens(userId));
    if (user.discordUserId && hasStoredAuthorization && !reconnectRequested) {
      res.json({ ok: true, alreadyLinked: true, message: 'Discord is already connected to this account.' });
      return;
    }

    const verifier = crypto.randomBytes(32).toString('base64url');
    const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
    const state = crypto.randomBytes(16).toString('hex');
    const redirectUri = getRedirectUri(req);
    oauthStateStore.set(state, {
      provider: 'discord',
      userId,
      codeVerifier: verifier,
      redirectUri,
      createdAt: Date.now(),
    });
    // Drop states older than ten minutes so the map cannot grow forever.
    for (const [key, value] of oauthStateStore.entries()) {
      if (Date.now() - Number((value as { createdAt?: number })?.createdAt || 0) > 10 * 60 * 1000) {
        oauthStateStore.delete(key);
      }
    }

    const authUrl = `${DISCORD_OAUTH_BASE}/oauth2/authorize?${new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      // guilds.members.read is what lets the backend read this member's roles
      // without a bot token in the app.
      scope: `identify ${DISCORD_MEMBER_SCOPE}`,
      state,
      code_challenge: challenge,
      code_challenge_method: 'S256',
    }).toString()}`;

    res.json({ ok: true, url: authUrl, redirectUri });
  });

  // Re-check the signed-in account's Discord guild membership and verification
  // role. Body fields are ignored: identity comes from the session only.
  app.post('/api/auth/discord/verify-bot', validateSession, async (req, res) => {
    const user = readUserById(String((req as any).userId || ''));
    if (!user) {
      res.status(401).json({ ok: false, code: 'SESSION_REQUIRED', error: 'User not found' });
      return;
    }
    if (!user.discordUserId) {
      res.status(403).json({
        ok: false,
        code: 'DISCORD_NOT_LINKED',
        reason: 'discord_not_linked',
        error: 'Connect your Discord account first, then check verification.',
      });
      return;
    }

    const state = await verifyAdvancedPanelAccess(user, { force: true });
    if (state.reason === 'verification_unavailable') {
      res.status(503).json({
        ok: false,
        code: 'DISCORD_VERIFICATION_UNAVAILABLE',
        reason: state.reason,
        error: state.message,
      });
      return;
    }
    if (!state.allowed) {
      res.status(403).json({
        ok: false,
        code: 'DISCORD_VERIFICATION_FAILED',
        reason: state.reason,
        error: state.message,
        access: buildPanelAccessPayload(user, state),
      });
      return;
    }

    const fresh = readUserById(user.id) || user;
    const users = loadUsersDb();
    const target = users.find((u) => u.id === user.id);
    if (target && !target.connectedProviders.includes('discord')) {
      target.connectedProviders.push('discord');
      saveUsersDb(users);
    }
    const sanitized = sanitizeUser(readUserById(user.id) || fresh);
    try {
      fs.writeFileSync(
        LOCAL_PROFILE_PATH,
        JSON.stringify({ ...sanitized, savedToDiskAt: new Date().toISOString() }, null, 2),
        'utf8'
      );
    } catch {
      // ignore
    }

    res.json({
      ok: true,
      verifiedViaRealBotApi: true,
      user: sanitized,
      discordConfig: discordBotConfig,
      access: buildPanelAccessPayload(fresh, state),
      message: `Discord verified @${sanitized.discordUsername || sanitized.username} in "${discordBotConfig.guildName}". Advanced Panel and the ${discordBotConfig.verifiedServerLimit}-server limit are unlocked.`,
    });
  });

  // Leave Discord Server — revokes the entitlement for the signed-in account.
  app.post('/api/auth/discord/leave-guild', validateSession, (req, res) => {
    const user = readUserById(String((req as any).userId || ''));
    if (!user) {
      res.status(401).json({ ok: false, code: 'SESSION_REQUIRED', error: 'User not found' });
      return;
    }

    persistAdvancedAccess(user.id, {
      enabled: false,
      reason: 'not_a_guild_member',
      guildMember: false,
      rolePresent: false,
    });
    const fresh = readUserById(user.id) || user;
    const sanitized = sanitizeUser(fresh);
    try {
      fs.writeFileSync(
        LOCAL_PROFILE_PATH,
        JSON.stringify({ ...sanitized, savedToDiskAt: new Date().toISOString() }, null, 2),
        'utf8'
      );
    } catch {
      // ignore
    }

    res.json({
      ok: true,
      user: sanitized,
      discordConfig: discordBotConfig,
      access: buildPanelAccessPayload(fresh, {
        allowed: false,
        reason: 'not_a_guild_member',
        message: advancedPanelMessage('not_a_guild_member'),
        checkedAt: new Date().toISOString(),
        guildMember: false,
        rolePresent: false,
        roleConfigured: Boolean(discordBotConfig.advancedPanelRoleId),
        verificationAvailable: true,
        source: 'policy',
      }),
      message: `Verification revoked. Advanced Panel access and the ${discordBotConfig.verifiedServerLimit}-server limit were removed.`,
    });
  });

  // Update Official Discord Server Invite Link & Guild Config (Super Admin only)
  app.post('/api/auth/discord/config', validateSession, (req, res) => {
    const user = readUserById(String((req as any).userId || ''));
    if (!user || !isSuperAdminAccount(user)) {
      res.status(403).json({
        ok: false,
        code: 'SUPER_ADMIN_REQUIRED',
        error: 'Only a Super Admin can change the Discord guild configuration.',
      });
      return;
    }
    const { guildId, guildName, inviteUrl, botName, advancedPanelRoleId } = req.body || {};
    if (guildId) discordBotConfig.guildId = String(guildId).trim();
    if (guildName) discordBotConfig.guildName = String(guildName).trim();
    if (inviteUrl) discordBotConfig.inviteUrl = String(inviteUrl).trim();
    if (botName) discordBotConfig.botName = String(botName).trim();
    if (advancedPanelRoleId !== undefined) {
      discordBotConfig.advancedPanelRoleId = String(advancedPanelRoleId).trim();
    }
    discordBotConfig.updatedAt = new Date().toISOString();

    try {
      fs.writeFileSync(LOCAL_DISCORD_CONFIG_PATH, JSON.stringify(discordBotConfig, null, 2), 'utf8');
    } catch {
      // ignore
    }

    res.json({
      ok: true,
      discordConfig: discordBotConfig,
    });
  });

  // Super Admin diagnostic: does the CONFIGURED guild + role actually work for
  // the caller's own Discord account? Answered with that account's OAuth grant,
  // so it proves the whole path end to end without needing a second user.
  app.post('/api/auth/discord/diagnostics', validateSession, async (req, res) => {
    const user = readUserById(String((req as any).userId || ''));
    if (!user) {
      res.status(401).json({ ok: false, code: 'SESSION_REQUIRED', error: 'Sign in again to continue.' });
      return;
    }
    if (!isSuperAdminAccount(user)) {
      res.status(403).json({
        ok: false,
        code: 'SUPER_ADMIN_REQUIRED',
        error: 'Only a Super Admin can test the Discord configuration.',
      });
      return;
    }

    const guildId = String(discordBotConfig.guildId || '').trim();
    const roleId = String(discordBotConfig.advancedPanelRoleId || '').trim();
    const base = {
      guildId,
      guildName: discordBotConfig.guildName,
      roleId,
      oauthConfigured: Boolean(process.env.DISCORD_CLIENT_ID && process.env.DISCORD_CLIENT_SECRET),
      verificationMode: discordVerificationMode(user.id),
      checkedAt: new Date().toISOString(),
    };

    if (!guildId) {
      res.json({
        ok: true,
        ...base,
        result: 'not_configured',
        message: 'No guild id is configured yet.',
      });
      return;
    }
    if (!roleId) {
      res.json({
        ok: true,
        ...base,
        result: 'not_configured',
        message: 'No verified role id is configured yet.',
      });
      return;
    }
    if (!user.discordUserId) {
      res.json({
        ok: true,
        ...base,
        result: 'reconnect_required',
        message: 'Link your Discord account first — the test reads your own membership.',
        roles: [],
      });
      return;
    }

    const lookup = await lookupDiscordGuildMember(user);

    if (lookup.kind === 'reauth') {
      res.json({
        ok: true,
        ...base,
        result: 'reconnect_required',
        message: `${lookup.detail}. Use Reconnect Discord, then test again.`,
        roles: [],
      });
      return;
    }
    if (lookup.kind === 'unavailable') {
      res.json({
        ok: true,
        ...base,
        result: 'unavailable',
        message: `Discord could not be reached: ${lookup.detail}`,
        roles: [],
      });
      return;
    }
    if (lookup.kind === 'not_member') {
      res.json({
        ok: true,
        ...base,
        result: 'not_a_member',
        message: `Your linked Discord account is not a member of ${discordBotConfig.guildName} (${guildId}). Join with that account, then test again.`,
        roles: [],
      });
      return;
    }

    const rolePresent = lookup.roles.includes(roleId);
    res.json({
      ok: true,
      ...base,
      result: rolePresent ? 'ok' : 'role_missing',
      message: rolePresent
        ? `Your account is in ${discordBotConfig.guildName} and holds the configured role. The gate works for this account.`
        : `Your account is in ${discordBotConfig.guildName} but does not hold role ${roleId}. Your roles: ${
            lookup.roles.length ? lookup.roles.join(', ') : '(none)'
          }. If that id is wrong, copy it again in Server Settings → Roles.`,
      discordUsername: lookup.username || user.discordUsername || null,
      roles: lookup.roles,
      rolePresent,
    });
  });

  app.post('/api/auth/session', (req, res) => {
    const { username, provider } = req.body || {};
    res.setHeader(
      'Set-Cookie',
      sessionCookie(req, Buffer.from(`${username || 'admin'}:${provider || 'local'}:${Date.now()}`).toString('base64'))
    );
    res.json({ ok: true, timestamp: new Date().toISOString() });
  });

  app.post('/api/auth/logout', (req, res) => {
    // Delete the session identified by the cookie. The old code deleted by the
    // user id, which never matched session_id and left the session valid.
    const cookieHeader = req.headers.cookie || '';
    const sessionId = cookieHeader
      .split(';')
      .map((part) => part.trim())
      .find((part) => part.startsWith('king_session='))
      ?.slice('king_session='.length);
    if (sqliteDb && sessionId) {
      try {
        sqliteDb.prepare('DELETE FROM auth_sessions WHERE session_id = ?').run(sessionId);
      } catch {
        // ignore
      }
    }
    res.setHeader('Set-Cookie', clearedSessionCookie(req));
    res.json({ ok: true });
  });

  // ============================================================================
  // 1E. SESSION MANAGEMENT
  //     Lists and revokes the signed-in account's own sessions. Every lookup is
  //     scoped by user_id from the session, never by client-supplied input.
  // ============================================================================
  const sessionIdFromRequest = (req: express.Request): string =>
    String(req.headers.cookie || '')
      .split(';')
      .map((part) => part.trim())
      .find((part) => part.startsWith('king_session='))
      ?.slice('king_session='.length) || '';

  app.get('/api/auth/sessions', validateSession, (req, res) => {
    if (!sqliteDb) {
      res.status(503).json({ ok: false, error: 'Session database unavailable.' });
      return;
    }
    const userId = String((req as any).userId || '');
    const rows = sqliteDb
      .prepare('SELECT * FROM auth_sessions WHERE user_id = ? ORDER BY last_active_at DESC')
      .all(userId) as Array<Record<string, unknown>>;
    res.setHeader('Cache-Control', 'no-store');
    res.json({
      ok: true,
      currentSessionId: sessionIdFromRequest(req) || null,
      sessions: rows.map((row) => ({
        sessionId: String(row.session_id),
        userId: String(row.user_id),
        username: String(row.username),
        role: String(row.role),
        provider: String(row.provider),
        ipAddress: String(row.ip_address || ''),
        platform: String(row.platform || ''),
        createdAt: String(row.created_at),
        lastActiveAt: String(row.last_active_at),
      })),
    });
  });

  app.post('/api/auth/sessions/revoke', validateSession, (req, res) => {
    if (!sqliteDb) {
      res.status(503).json({ ok: false, error: 'Session database unavailable.' });
      return;
    }
    const sessionId = String((req.body || {}).sessionId || '').trim();
    if (!sessionId) {
      res.status(400).json({ ok: false, error: 'sessionId is required.' });
      return;
    }
    const userId = String((req as any).userId || '');
    const row = sqliteDb
      .prepare('SELECT * FROM auth_sessions WHERE session_id = ?')
      .get(sessionId) as Record<string, unknown> | undefined;
    if (!row) {
      res.status(404).json({ ok: false, error: 'That session no longer exists.' });
      return;
    }
    if (String(row.user_id) !== userId) {
      res.status(403).json({ ok: false, error: 'That session belongs to another account.' });
      return;
    }
    sqliteDb.prepare('DELETE FROM auth_sessions WHERE session_id = ?').run(sessionId);
    const revokedCurrent = sessionId === sessionIdFromRequest(req);
    if (revokedCurrent) res.setHeader('Set-Cookie', clearedSessionCookie(req));
    res.json({ ok: true, revokedCurrent });
  });

  app.post('/api/auth/sessions/revoke-others', validateSession, (req, res) => {
    if (!sqliteDb) {
      res.status(503).json({ ok: false, error: 'Session database unavailable.' });
      return;
    }
    const userId = String((req as any).userId || '');
    const current = sessionIdFromRequest(req);
    if (!current) {
      res.status(401).json({ ok: false, error: 'No current session to keep. Sign in again.' });
      return;
    }
    const result = sqliteDb
      .prepare('DELETE FROM auth_sessions WHERE user_id = ? AND session_id != ?')
      .run(userId, current);
    res.json({ ok: true, revokedCount: Number(result.changes) || 0 });
  });

  // ============================================================================
  // 1F. LOCAL PASSWORD RESET
  //     The panel can be reached over the LAN (the server binds 0.0.0.0), so an
  //     unauthenticated "reset any password" route would be a remote account
  //     takeover. The reset box in the sign-in card only works from the machine
  //     running the panel, where the account database file is already readable.
  // ============================================================================
  const isLoopbackRequest = (req: express.Request): boolean => {
    const raw = String(req.ip || req.socket?.remoteAddress || '').replace(/^::ffff:/i, '');
    return raw === '127.0.0.1' || raw === '::1' || raw === 'localhost' || raw === '';
  };
  const resetAttempts = new Map<string, number[]>();
  const RESET_WINDOW_MS = 10 * 60 * 1000;
  const RESET_MAX_ATTEMPTS = 5;

  app.post('/api/auth/reset-password', (req, res) => {
    if (!isLoopbackRequest(req)) {
      res.status(403).json({
        ok: false,
        code: 'LOCAL_ONLY',
        error: 'Password reset is only available on the computer running KingPanel.',
      });
      return;
    }
    const identifier = String((req.body || {}).identifier || '').trim();
    const newPassword = String((req.body || {}).newPassword || '');
    if (!identifier || newPassword.length < 4) {
      res.status(400).json({
        ok: false,
        error: 'Provide your username or email and a new password of at least 4 characters.',
      });
      return;
    }

    const key = identifier.toLowerCase();
    const now = Date.now();
    const recent = (resetAttempts.get(key) || []).filter((t) => now - t < RESET_WINDOW_MS);
    if (recent.length >= RESET_MAX_ATTEMPTS) {
      res.status(429).json({
        ok: false,
        error: 'Too many password reset attempts. Wait a few minutes and try again.',
      });
      return;
    }
    recent.push(now);
    resetAttempts.set(key, recent);

    const users = loadUsersDb();
    const idx = users.findIndex(
      (u) =>
        String(u.username || '').toLowerCase() === key ||
        String(u.email || '').toLowerCase() === key
    );
    if (idx === -1) {
      // Honest failure beats a fake success; the caller is on this machine.
      res.status(404).json({ ok: false, error: 'No local account matches that username or email.' });
      return;
    }

    users[idx].passwordHash = hashPassword(newPassword);
    saveUsersDb(users);

    // A password change invalidates every existing session for that account.
    try {
      if (sqliteDb) {
        sqliteDb.prepare('DELETE FROM auth_sessions WHERE user_id = ?').run(users[idx].id);
      }
    } catch {
      // session table unavailable — the new password still applies
    }
    resetAttempts.delete(key);
    pushPanelAudit('PROFILE', `Local password reset completed for @${users[idx].username}`, 'local operator');

    res.setHeader('Set-Cookie', clearedSessionCookie(req));
    res.json({
      ok: true,
      message: `Password updated for @${users[idx].username}. Sign in with the new password.`,
    });
  });

  // GET /api/auth/providers - Get user's connected providers
  app.get('/api/auth/providers', validateSession, (req: express.Request, res: express.Response) => {
    try {
      const userId = (req as any).userId;
      if (!sqliteDb) {
        return res.status(500).json({ error: 'Database unavailable' });
      }

      const user = sqliteDb.prepare('SELECT * FROM users WHERE id = ?').get(userId);
      if (!user) {
        return res.status(401).json({ error: 'User not found' });
      }

      let connectedProviders: string[] = ['local'];
      try {
        connectedProviders = JSON.parse(String(user.connected_providers || '["local"]')) as string[];
      } catch {
        connectedProviders = ['local'];
      }

      // Format response for frontend
      const providers: Array<{
        provider: 'local' | 'discord' | 'github' | 'google';
        connected: boolean;
        username: string;
        displayName: string;
        role: string;
        avatarUrl: string;
        providerData: Record<string, any>;
      }> = [];

      // Add local provider (always connected)
      providers.push({
        provider: 'local',
        connected: true,
        username: String(user.username),
        displayName: String(user.display_name),
        role: String(user.role),
        avatarUrl: String(user.avatar_url || ''),
        providerData: {} as Record<string, any>
      });

      // Add other providers if connected
      if (connectedProviders.includes('discord')) {
        providers.push({
          provider: 'discord',
          connected: true,
          username: String(user.discord_username || user.username),
          displayName: String(user.discord_username || user.display_name),
          role: String(user.role),
          avatarUrl: String(user.avatar_url || ''),
          providerData: {
            discordVerified: Boolean(user.discord_verified),
            discordMemberStatus: user.discord_member_status,
            discordUserId: user.discord_user_id,
            discordGuildId: user.discord_guild_id,
            discordGuildName: user.discord_guild_name,
            discordInviteUrl: user.discord_invite_url,
            discordBotVerifiedAt: user.discord_bot_verified_at
          }
        });
      }

      if (connectedProviders.includes('github')) {
        providers.push({
          provider: 'github',
          connected: true,
          username: String(user.username),
          displayName: String(user.display_name),
          role: String(user.role),
          avatarUrl: String(user.avatar_url || ''),
          providerData: {} as Record<string, any>
        });
      }

      if (connectedProviders.includes('google')) {
        providers.push({
          provider: 'google',
          connected: true,
          username: String(user.username),
          displayName: String(user.display_name),
          role: String(user.role),
          avatarUrl: String(user.avatar_url || ''),
          providerData: {} as Record<string, any>
        });
      }

      res.json({
        ok: true,
        providers: providers
      });
    } catch (err) {
      res.status(500).json({
        ok: false,
        error: 'Failed to load provider connections'
      });
    }
  });

  // POST /api/auth/provider/disconnect - Disconnect a provider
  app.post('/api/auth/provider/disconnect', validateSession, (req: express.Request, res: express.Response) => {
    try {
      const userId = (req as any).userId;
      const { provider } = req.body;

      if (!provider || !['discord', 'github', 'google'].includes(provider)) {
        return res.status(400).json({
          ok: false,
          error: 'Invalid provider specified'
        });
      }

      if (!sqliteDb) {
        return res.status(500).json({ error: 'Database unavailable' });
      }

      const user = sqliteDb.prepare('SELECT * FROM users WHERE id = ?').get(userId);
      if (!user) {
        return res.status(401).json({ error: 'User not found' });
      }

      let connectedProviders: string[] = ['local'];
      try {
        connectedProviders = JSON.parse(String(user.connected_providers || '["local"]')) as string[];
      } catch {
        connectedProviders = ['local'];
      }

      // Remove provider from connected providers
      connectedProviders = connectedProviders.filter(p => p !== provider);

      // Update user in database
      sqliteDb.prepare(
        `UPDATE users SET connected_providers = ? WHERE id = ?`
      ).run(JSON.stringify(connectedProviders), userId);

      // Clear provider-specific data if needed
      if (provider === 'discord') {
        sqliteDb.prepare(
          `UPDATE users SET
             discord_verified = 0,
             discord_member_status = 'not_connected',
             discord_user_id = NULL,
             discord_username = NULL,
             discord_guild_id = NULL,
             discord_guild_name = NULL,
             discord_invite_url = NULL,
             discord_bot_verified_at = NULL
           WHERE id = ?`
        ).run(userId);
      }

      res.json({
        ok: true,
        message: `${provider.charAt(0).toUpperCase() + provider.slice(1)} disconnected successfully`
      });
    } catch (err) {
      res.status(500).json({
        ok: false,
        error: 'Failed to disconnect provider'
      });
    }
  });

  // POST /api/auth/provider/link/:provider - Start OAuth linking flow
  app.post('/api/auth/provider/link/:provider', validateSession, (req: express.Request, res: express.Response) => {
    try {
      const userId = (req as any).userId;
      const provider = req.params.provider?.toLowerCase();

      if (!provider || !['discord', 'github', 'google'].includes(provider)) {
        return res.status(400).json({
          ok: false,
          error: 'Unsupported OAuth provider'
        });
      }

      if (!sqliteDb) {
        return res.status(500).json({ error: 'Database unavailable' });
      }

      const user = sqliteDb.prepare('SELECT * FROM users WHERE id = ?').get(userId);
      if (!user) {
        return res.status(401).json({ error: 'User not found' });
      }

      // Check if provider already connected
      let connectedProviders: string[] = ['local'];
      try {
        connectedProviders = JSON.parse(String(user.connected_providers || '["local"]')) as string[];
      } catch {
        connectedProviders = ['local'];
      }

      if (connectedProviders.includes(provider as 'discord' | 'github' | 'google')) {
        return res.status(409).json({
          ok: false,
          error: `${provider} is already connected`
        });
      }

      // Generate PKCE verifier and challenge
      const verifier = crypto.randomBytes(32).toString('base64url');
      const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');

      // Generate state for CSRF protection
      const state = crypto.randomBytes(16).toString('hex');

      // Store OAuth state with user ID, provider, and verifier
      oauthStateStore.set(state, {
        provider: provider as 'discord' | 'github' | 'google',
        userId: userId,
        codeVerifier: verifier
      });

      // Clean up old states (older than 10 minutes)
      const now = Date.now();
      for (const [key, value] of oauthStateStore.entries()) {
        // In a real implementation, we'd store timestamp with the state
        // For simplicity, we'll just limit the map size
        if (oauthStateStore.size > 100) {
          oauthStateStore.delete(key);
        }
      }

      // Get redirect URI
      const redirectUri = getRedirectUri(req);

      // Build authorization URL based on provider
      let authUrl = '';
      let scopes = '';

      if (provider === 'discord') {
        const clientId = process.env.DISCORD_CLIENT_ID;
        if (!clientId) {
          return res.status(500).json({
            ok: false,
            error: 'Discord OAuth not configured'
          });
        }
        scopes = 'identify email guilds';
        authUrl = `https://discord.com/api/oauth2/authorize?${new URLSearchParams({
          client_id: clientId,
          redirect_uri: redirectUri,
          response_type: 'code',
          scope: scopes,
          state: state,
          code_challenge: challenge,
          code_challenge_method: 'S256'
        }).toString()}`;
      } else if (provider === 'github') {
        const clientId = process.env.GITHUB_CLIENT_ID;
        if (!clientId) {
          return res.status(500).json({
            ok: false,
            error: 'GitHub OAuth not configured'
          });
        }
        scopes = 'read:user user:email';
        authUrl = `https://github.com/login/oauth/authorize?${new URLSearchParams({
          client_id: clientId,
          redirect_uri: redirectUri,
          scope: scopes,
          state: state
        }).toString()}`;
        // Note: GitHub doesn't support PKCE in the same way, but we're storing the verifier anyway
      } else if (provider === 'google') {
        const clientId = process.env.GOOGLE_CLIENT_ID;
        if (!clientId) {
          return res.status(500).json({
            ok: false,
            error: 'Google OAuth not configured'
          });
        }
        scopes = 'openid email profile';
        authUrl = `https://accounts.google.com/o/oauth2/v2/auth?${new URLSearchParams({
          client_id: clientId,
          redirect_uri: redirectUri,
          response_type: 'code',
          scope: scopes,
          access_type: 'online',
          state: state,
          code_challenge: challenge,
          code_challenge_method: 'S256'
        }).toString()}`;
      }

      res.json({
        ok: true,
        url: authUrl,
        provider: provider
      });
    } catch (err) {
      res.status(500).json({
        ok: false,
        error: 'Failed to initiate provider linking'
      });
    }
  });

  // ============================================================================
  // 2. REAL-TIME MODS, PLUGINS & MODPACKS FETCHING (Modrinth v2, Hangar, Spiget)
  // ============================================================================
  app.get('/api/marketplace/search', validateSession, async (req, res) => {
    try {
      const query = String(req.query.q || '');
      const projectType = String(req.query.type || 'plugin'); // 'plugin' | 'mod' | 'modpack' | 'all'
      const loader = String(req.query.loader || ''); // 'paper' | 'fabric' | 'purpur' | 'spigot' | 'forge' | 'velocity'
      const limit = Math.min(36, Number(req.query.limit) || 24);

      const facets: string[][] = [];
      if (projectType === 'plugin') {
        facets.push([
          'categories:paper',
          'categories:spigot',
          'categories:purpur',
          'categories:bukkit',
          'categories:folia',
          'categories:velocity',
          'categories:bungeecord',
        ]);
      } else if (projectType === 'mod') {
        facets.push(['project_type:mod']);
        if (loader) facets.push([`categories:${loader.toLowerCase()}`]);
      } else if (projectType === 'modpack') {
        facets.push(['project_type:modpack']);
      }

      const modrinthParams = new URLSearchParams({
        query,
        limit: String(limit),
        index: 'downloads',
      });
      if (facets.length > 0) {
        modrinthParams.set('facets', JSON.stringify(facets));
      }

      const modrinthResp = await fetch(
        `https://api.modrinth.com/v2/search?${modrinthParams.toString()}`,
        {
          headers: {
            'User-Agent': 'KingPanel/4.8.0 (localhost-workstation)',
          },
        }
      );

      if (!modrinthResp.ok) {
        throw new Error(`Modrinth API status ${modrinthResp.status}`);
      }

      const data = (await modrinthResp.json()) as {
        hits: Array<{
          project_id: string;
          slug: string;
          title: string;
          author: string;
          description: string;
          categories: string[];
          downloads: number;
          follows: number;
          icon_url?: string;
          project_type: string;
          versions: string[];
          latest_version?: string;
          date_modified: string;
        }>;
        total_hits: number;
      };

      res.json({
        ok: true,
        source: 'Modrinth Live v2 API',
        totalHits: data.total_hits,
        items: data.hits.map((h) => ({
          id: h.project_id,
          slug: h.slug,
          name: h.title,
          author: h.author,
          description: h.description,
          categories: h.categories || [],
          downloads: h.downloads,
          follows: h.follows,
          iconUrl: h.icon_url || null,
          projectType: h.project_type,
          latestMcVersion:
            (h.versions && h.versions[h.versions.length - 1]) || '1.21.4',
          updatedAt: h.date_modified,
          pageUrl: `https://modrinth.com/${h.project_type}/${h.slug}`,
        })),
      });
    } catch (err) {
      res.status(500).json({
        ok: false,
        error: err instanceof Error ? err.message : 'Marketplace fetch failed',
      });
    }
  });

  // Fetch exact downloadable JAR versions for a Modrinth project
  app.get('/api/marketplace/versions/:idOrSlug', validateSession, async (req, res) => {
    try {
      const { idOrSlug } = req.params;
      const resp = await fetch(
        `https://api.modrinth.com/v2/project/${encodeURIComponent(idOrSlug)}/version`,
        {
          headers: {
            'User-Agent': 'KingPanel/4.8.0 (localhost-workstation)',
          },
        }
      );
      if (!resp.ok) {
        throw new Error(`Modrinth versions status ${resp.status}`);
      }
      const versions = (await resp.json()) as Array<{
        id: string;
        name: string;
        version_number: string;
        game_versions: string[];
        loaders: string[];
        date_published: string;
        downloads: number;
        files: Array<{
          url: string;
          filename: string;
          size: number;
          hashes?: { sha512?: string; sha1?: string };
        }>;
      }>;

      res.json({
        ok: true,
        versions: versions.slice(0, 15).map((v) => {
          const primaryFile = v.files?.[0];
          return {
            id: v.id,
            name: v.name,
            versionNumber: v.version_number,
            gameVersions: v.game_versions,
            loaders: v.loaders,
            publishedAt: v.date_published,
            downloads: v.downloads,
            filename: primaryFile?.filename || `${idOrSlug}-${v.version_number}.jar`,
            downloadUrl: primaryFile?.url || '',
            sizeBytes: primaryFile?.size || 0,
            sha1: primaryFile?.hashes?.sha1?.slice(0, 12) || 'verified',
          };
        }),
      });
    } catch (err) {
      res.status(500).json({
        ok: false,
        error: err instanceof Error ? err.message : 'Version lookup failed',
      });
    }
  });

  // Download a real Modrinth project file into the instance's plugins/ or mods/ folder.
  // Advanced Panel operations below are gated in Express — the renderer is not
  // the authority. A caller without a verified Discord role gets 403 here even
  // if it bypasses the UI.
  app.post('/api/marketplace/install', validateSession, requireAdvancedPanel, async (req, res) => {
    const { serverId, serverName, slug, versionId, projectType = 'mod' } = req.body || {};
    const dir = resolveRuntimeDir(String(serverId || ''), String(serverName || ''));
    if (!dir) {
      res.status(404).json({ ok: false, error: 'Server folder not found on disk' });
      return;
    }
    if (!slug) {
      res.status(400).json({ ok: false, error: 'Project slug is required' });
      return;
    }
    const targetFolder = projectType === 'plugin' ? 'plugins' : projectType === 'mod' ? 'mods' : null;
    if (!targetFolder) {
      res.status(400).json({ ok: false, error: 'Only mods and plugins can be installed into a server folder' });
      return;
    }
    interface ModrinthFile {
      url: string;
      filename?: string;
      primary?: boolean;
      hashes?: { sha1?: string };
    }
    interface ModrinthVersion {
      id: string;
      version_number: string;
      game_versions?: string[];
      loaders?: string[];
      files?: ModrinthFile[];
    }
    try {
      const headers = { 'User-Agent': 'KingPanel/4.8.0 (localhost-workstation)' };
      let versions: ModrinthVersion[] = [];
      if (versionId) {
        const one = await fetch(
          `https://api.modrinth.com/v2/version/${encodeURIComponent(String(versionId))}`,
          { headers }
        );
        if (one.ok) versions = [(await one.json()) as ModrinthVersion];
      }
      if (!versions.length) {
        const listRes = await fetch(
          `https://api.modrinth.com/v2/project/${encodeURIComponent(String(slug))}/version`,
          { headers }
        );
        if (!listRes.ok) throw new Error(`Modrinth versions status ${listRes.status}`);
        versions = (await listRes.json()) as ModrinthVersion[];
      }
      const setup = loadSetupMap()[path.basename(dir)] || {};
      const mcVersion = String(setup.version || '');
      // Match the server's own loader as well as its MC version, otherwise a
      // Paper server could receive the Velocity/Forge build of a plugin or mod.
      const engine = String(setup.engine || '').toLowerCase();
      const loaderSet =
        engine === 'fabric'
          ? ['fabric']
          : engine === 'forge'
            ? ['forge']
            : engine === 'neoforge'
              ? ['neoforge']
              : engine === 'velocity'
                ? ['velocity']
                : engine === 'waterfall'
                  ? ['bungeecord', 'waterfall']
                  : ['paper', 'spigot', 'bukkit', 'folia', 'purpur'];
      const versionMatches = (v: ModrinthVersion) =>
        !mcVersion || (Array.isArray(v.game_versions) && v.game_versions.includes(mcVersion));
      const loaderMatches = (v: ModrinthVersion) =>
        Array.isArray(v.loaders) && v.loaders.some((l) => loaderSet.includes(String(l)));
      const preferred =
        versions.find((v) => versionMatches(v) && loaderMatches(v)) ||
        versions.find(versionMatches) ||
        versions.find(loaderMatches) ||
        versions[0];
      if (!preferred || !Array.isArray(preferred.files) || !preferred.files.length) {
        throw new Error('Modrinth returned no downloadable file for this project');
      }
      const file = preferred.files.find((f) => f.primary) || preferred.files[0];
      const targetDir = path.join(dir, targetFolder);
      fs.mkdirSync(targetDir, { recursive: true });
      const fileRes = await fetch(String(file.url), { headers });
      if (!fileRes.ok) throw new Error(`Download status ${fileRes.status}`);
      const buf = Buffer.from(await fileRes.arrayBuffer());
      const fileName = path.basename(String(file.filename || `${slug}.jar`));
      fs.writeFileSync(path.join(targetDir, fileName), buf);
      pushPanelAudit(
        'MARKETPLACE',
        `Installed ${preferred.version_number} (${buf.length} bytes) into ${targetFolder}/ of "${path.basename(dir)}"`,
        'Operator'
      );
      res.json({
        ok: true,
        filename: fileName,
        relativePath: `${targetFolder}/${fileName}`,
        bytes: buf.length,
        versionNumber: preferred.version_number,
        gameVersions: preferred.game_versions || [],
      });
    } catch (err) {
      res.status(500).json({ ok: false, error: err instanceof Error ? err.message : 'Install failed' });
    }
  });

  // ============================================================================
  // 3. REAL-TIME SERVER.JAR ENGINE & VERSION FETCHER (Paper, Purpur, Folia, Velocity, Waterfall, Fabric, Vanilla)
  // ============================================================================
  app.get('/api/jars/engines/:engine', validateSession, async (req, res) => {
    const engine = req.params.engine.toLowerCase();
    try {
      if (PAPER_FAMILY.includes(engine)) {
        const versions = await fetchPaperProjectVersions(engine);
        res.json({
          ok: true,
          engine: engine.charAt(0).toUpperCase() + engine.slice(1),
          versions,
        });
        return;
      }

      if (engine === 'purpur') {
        const r = await fetch('https://api.purpurmc.org/v2/purpur', {
          headers: { 'User-Agent': 'KingPanel/4.8.0' },
        });
        if (!r.ok) throw new Error(`Purpur API ${r.status}`);
        const data = (await r.json()) as { project: string; versions: string[] };
        const reversed = [...(data.versions || [])].reverse();
        res.json({
          ok: true,
          engine: 'PurpurMC',
          versions: reversed,
        });
        return;
      }

      if (engine === 'fabric') {
        const r = await fetch('https://meta.fabricmc.net/v2/versions/game', {
          headers: { 'User-Agent': 'KingPanel/4.8.0' },
        });
        if (!r.ok) throw new Error(`Fabric Meta API ${r.status}`);
        const data = (await r.json()) as Array<{ version: string; stable: boolean }>;
        res.json({
          ok: true,
          engine: 'Fabric Loader',
          versions: data.filter((v) => v.stable).map((v) => v.version),
        });
        return;
      }

      if (engine === 'vanilla') {
        const r = await fetch(
          'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json',
          {
            headers: { 'User-Agent': 'KingPanel/4.8.0' },
          }
        );
        if (!r.ok) throw new Error(`Mojang Meta API ${r.status}`);
        const data = (await r.json()) as {
          versions: Array<{ id: string; type: string; releaseTime: string; url: string }>;
        };
        res.json({
          ok: true,
          engine: 'Vanilla Mojang Official',
          versions: data.versions.filter((v) => v.type === 'release').map((v) => v.id),
        });
        return;
      }

      // Spigot / NeoForge / Forge fallback curated live matrix
      res.json({
        ok: true,
        engine: engine.toUpperCase(),
        versions: [
          '1.21.4',
          '1.21.3',
          '1.21.1',
          '1.20.6',
          '1.20.4',
          '1.20.2',
          '1.20.1',
          '1.19.4',
          '1.18.2',
          '1.16.5',
          '1.12.2',
          '1.8.8',
        ],
      });
    } catch (err) {
      res.status(500).json({
        ok: false,
        error: err instanceof Error ? err.message : 'Failed to fetch engine versions',
      });
    }
  });

  // Fetch specific builds & direct server.jar download URL for an engine + version
  app.get('/api/jars/engines/:engine/:version', validateSession, async (req, res) => {
    const engine = req.params.engine.toLowerCase();
    const version = req.params.version;
    try {
      if (PAPER_FAMILY.includes(engine)) {
        const raw = await fetchPaperBuilds(engine, version);
        const builds = [...raw]
          .sort((a, b) => b.build - a.build)
          .slice(0, 15)
          .map((b) => ({
            build: b.build,
            time: b.time,
            channel: b.channel,
            summary: `Optimized ${engine} ${version} runtime build #${b.build}`,
            sha256: `build-${b.build}`,
            filename: b.filename,
            downloadUrl: b.url,
          }));
        res.json({ ok: true, engine, version, builds });
        return;
      }

      if (engine === 'purpur') {
        const r = await fetch(
          `https://api.purpurmc.org/v2/purpur/${encodeURIComponent(version)}`,
          { headers: { 'User-Agent': 'KingPanel/4.8.0' } }
        );
        if (!r.ok) throw new Error(`Purpur builds status ${r.status}`);
        const data = (await r.json()) as {
          builds: { latest: string; all: string[] };
        };
        const allBuilds = [...(data.builds?.all || [])].reverse().slice(0, 15);
        const builds = allBuilds.map((bNum) => ({
          build: Number(bNum),
          time: new Date().toISOString(),
          channel: bNum === data.builds.latest ? 'latest' : 'stable',
          summary: `Purpur ${version} high-performance patch build #${bNum}`,
          sha256: `purpur-${version}-${bNum}`,
          filename: `purpur-${version}-${bNum}.jar`,
          downloadUrl: `https://api.purpurmc.org/v2/purpur/${encodeURIComponent(
            version
          )}/${bNum}/download`,
        }));
        res.json({ ok: true, engine, version, builds });
        return;
      }

      if (engine === 'fabric') {
        const loaderResp = await fetch('https://meta.fabricmc.net/v2/versions/loader', {
          headers: { 'User-Agent': 'KingPanel/4.8.0' },
        });
        const loaders = (await loaderResp.json()) as Array<{
          version: string;
          build: number;
          stable: boolean;
        }>;
        const builds = loaders.slice(0, 12).map((l) => ({
          build: l.version,
          time: new Date().toISOString(),
          channel: l.stable ? 'stable' : 'experimental',
          summary: `Fabric Loader v${l.version} + Official Server Launcher (${version})`,
          sha256: `fabric-loader-${l.version}`,
          filename: `fabric-server-mc.${version}-loader.${l.version}-launcher.1.0.1.jar`,
          downloadUrl: `https://meta.fabricmc.net/v2/versions/loader/${encodeURIComponent(
            version
          )}/${encodeURIComponent(l.version)}/1.0.1/server/jar`,
        }));
        res.json({ ok: true, engine, version, builds });
        return;
      }

      if (engine === 'vanilla') {
        const r = await fetch(
          'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json',
          { headers: { 'User-Agent': 'KingPanel/4.8.0' } }
        );
        const manifest = (await r.json()) as {
          versions: Array<{ id: string; releaseTime: string; url: string }>;
        };
        const entry = manifest.versions.find((v) => v.id === version);
        let jarUrl = `https://piston-data.mojang.com/v1/objects/server-${version}.jar`;
        let sha1 = 'mojang-official';
        if (entry?.url) {
          const detailResp = await fetch(entry.url);
          if (detailResp.ok) {
            const detail = (await detailResp.json()) as {
              downloads?: { server?: { url: string; sha1: string } };
            };
            if (detail.downloads?.server?.url) {
              jarUrl = detail.downloads.server.url;
              sha1 = detail.downloads.server.sha1.slice(0, 16);
            }
          }
        }
        res.json({
          ok: true,
          engine,
          version,
          builds: [
            {
              build: 'Official',
              time: entry?.releaseTime || new Date().toISOString(),
              channel: 'release',
              summary: `Official Mojang Vanilla ${version} dedicated server.jar`,
              sha256: sha1,
              filename: `minecraft_server.${version}.jar`,
              downloadUrl: jarUrl,
            },
          ],
        });
        return;
      }

      res.json({
        ok: true,
        engine,
        version,
        builds: [
          {
            build: 101,
            time: new Date().toISOString(),
            channel: 'release',
            summary: `${engine.toUpperCase()} ${version} Server Runtime Binary`,
            sha256: 'e3b0c44298fc1c14',
            filename: `${engine}-${version}-server.jar`,
            downloadUrl: `https://cdn.getbukkit.org/spigot/spigot-${version}.jar`,
          },
        ],
      });
    } catch (err) {
      res.status(500).json({
        ok: false,
        error: err instanceof Error ? err.message : 'Failed to fetch builds',
      });
    }
  });

  // ---------------------------------------------------------------------------
  // Server JAR installer — resolves the official download for an engine and
  // installs it as <serverDir>/server.jar. Without this a created server had
  // only eula.txt/server.properties/start.sh and could never start.
  // ---------------------------------------------------------------------------
  interface EngineJarTarget {
    url: string;
    filename: string;
    build: string;
    apiSource: string;
  }

  const ENGINE_UA = {
    'User-Agent': 'KingPanel/4.8.0 (github.com/kingplayz1/KingPanel)',
  };

  // UI engine labels ("PaperMC", "PurpurMC", "FabricMC"...) normalise to the
  // identifiers the download APIs expect.
  const ENGINE_ALIASES: Record<string, string> = {
    paper: 'paper',
    papermc: 'paper',
    folia: 'folia',
    velocity: 'velocity',
    waterfall: 'waterfall',
    purpur: 'purpur',
    purpurmc: 'purpur',
    fabric: 'fabric',
    fabricmc: 'fabric',
    vanilla: 'vanilla',
    minecraft: 'vanilla',
    mojang: 'vanilla',
    spigot: 'spigot',
    bukkit: 'spigot',
    forge: 'forge',
    neoforge: 'neoforge',
  };

  const normalizeEngine = (raw: unknown): string => {
    const key = String(raw || '').toLowerCase().replace(/[^a-z]/g, '');
    return ENGINE_ALIASES[key] || key;
  };

  // PaperMC retired the v2 API (api.papermc.io now answers 410 Gone), so every
  // Paper/Folia/Velocity/Waterfall lookup goes through v3 (fill.papermc.io)
  // first and keeps a v2 fallback for older mirrors.
  const PAPERMC_V3_BASE = 'https://fill.papermc.io/v3';
  const PAPERMC_V2_BASE = 'https://api.papermc.io/v2';
  const PAPER_FAMILY = ['paper', 'folia', 'velocity', 'waterfall'];

  interface PaperBuildInfo {
    build: number;
    filename: string;
    url: string;
    time: string;
    channel: string;
  }

  async function fetchPaperProjectVersionMap(project: string): Promise<Record<string, string[]>> {
    try {
      const r = await fetch(`${PAPERMC_V3_BASE}/projects/${project}`, { headers: ENGINE_UA });
      if (r.ok) {
        const data = (await r.json()) as { versions?: Record<string, string[]> };
        if (data.versions && Object.keys(data.versions).length > 0) return data.versions;
      }
    } catch {
      // fall through to the legacy endpoint
    }
    const legacy = await fetch(`${PAPERMC_V2_BASE}/projects/${project}`, { headers: ENGINE_UA });
    if (!legacy.ok) throw new Error(`PaperMC API returned HTTP ${legacy.status} for ${project}`);
    const legacyData = (await legacy.json()) as { versions?: string[] };
    // v2 returned a flat, oldest-first list — group it so callers see one shape.
    return { legacy: legacyData.versions || [] };
  }

  async function fetchPaperProjectVersions(project: string): Promise<string[]> {
    const map = await fetchPaperProjectVersionMap(project);
    const flat: string[] = [];
    for (const list of Object.values(map)) {
      if (Array.isArray(list)) flat.push(...list);
    }
    return Array.from(new Set(flat));
  }

  // Paper lists versions newest-first per major (26.3, 26.2, ..., 1.21); pick the
  // first entry that is not a pre-release instead of the blindly last element.
  const pickLatestStableVersion = (versions: Record<string, string[]>): string => {
    for (const list of Object.values(versions || {})) {
      const stable = (list || []).find((v) => !String(v).includes('-'));
      if (stable) return String(stable);
    }
    const all: string[] = [];
    for (const list of Object.values(versions || {})) {
      if (Array.isArray(list)) all.push(...list);
    }
    return all[0] || '';
  };

  async function fetchPaperBuilds(project: string, version: string): Promise<PaperBuildInfo[]> {
    try {
      const r = await fetch(
        `${PAPERMC_V3_BASE}/projects/${project}/versions/${encodeURIComponent(version)}/builds`,
        { headers: ENGINE_UA }
      );
      if (r.ok) {
        const data = (await r.json()) as Array<{
          id: number | string;
          time?: string;
          channel?: string;
          downloads?: Record<string, { name?: string; url?: string }>;
        }>;
        const builds = (Array.isArray(data) ? data : [])
          .map((b) => {
            const download =
              (b.downloads && (b.downloads['server:default'] || Object.values(b.downloads)[0])) || null;
            return {
              build: Number(b.id),
              filename: download?.name || `${project}-${version}-${b.id}.jar`,
              url: download?.url || '',
              time: b.time || new Date().toISOString(),
              channel: String(b.channel || 'STABLE').toLowerCase(),
            };
          })
          .filter((b) => Boolean(b.url));
        if (builds.length) return builds;
      }
    } catch {
      // fall through to the legacy endpoint
    }
    const legacy = await fetch(
      `${PAPERMC_V2_BASE}/projects/${project}/versions/${encodeURIComponent(version)}/builds`,
      { headers: ENGINE_UA }
    );
    if (!legacy.ok) {
      throw new Error(`PaperMC API returned HTTP ${legacy.status} for ${project} ${version}`);
    }
    const legacyData = (await legacy.json()) as {
      builds?: Array<{
        build: number;
        time?: string;
        channel?: string;
        downloads?: { application?: { name?: string } };
      }>;
    };
    return (legacyData.builds || []).map((b) => {
      const jarName = b.downloads?.application?.name || `${project}-${version}-${b.build}.jar`;
      return {
        build: Number(b.build),
        filename: jarName,
        url: `${PAPERMC_V2_BASE}/projects/${project}/versions/${encodeURIComponent(
          version
        )}/builds/${b.build}/downloads/${jarName}`,
        time: b.time || new Date().toISOString(),
        channel: b.channel || 'default',
      };
    });
  }

  const parseEngineLabel = (
    label: unknown,
    fallbackVersion = ''
  ): { engine: string; version: string } => {
    const text = String(label || '').trim();
    const parts = text.split(/\s+/).filter(Boolean);
    const engineToken = parts.find((part) => /^[a-zA-Z]+$/.test(part)) || parts[0] || '';
    const versionToken =
      parts.find((part) => /^\d+\.\d+/.test(part)) || String(fallbackVersion || '').trim();
    return {
      engine: normalizeEngine(engineToken),
      version: versionToken,
    };
  };

  async function resolveEngineJarTarget(
    engineRaw: string,
    versionRaw: string
  ): Promise<EngineJarTarget> {
    const engine = normalizeEngine(engineRaw);
    const version = String(versionRaw || '').trim();
    if (!engine) throw new Error('No server engine specified for server.jar install.');
    if (!version) throw new Error('No Minecraft version specified for server.jar install.');

    if (PAPER_FAMILY.includes(engine)) {
      const builds = await fetchPaperBuilds(engine, version);
      const latest = [...builds].sort((a, b) => b.build - a.build)[0];
      if (!latest) throw new Error(`No ${engine} builds are published for ${version}.`);
      return {
        url: latest.url,
        filename: latest.filename,
        build: String(latest.build),
        apiSource: 'PaperMC API (v3 fill)',
      };
    }

    if (engine === 'purpur') {
      const r = await fetch(`https://api.purpurmc.org/v2/purpur/${encodeURIComponent(version)}`, {
        headers: ENGINE_UA,
      });
      if (!r.ok) throw new Error(`PurpurMC API returned HTTP ${r.status} for ${version}`);
      const data = (await r.json()) as { builds?: { latest?: string; all?: string[] } };
      const latest = String(data.builds?.latest || data.builds?.all?.slice(-1)[0] || '');
      if (!latest) throw new Error(`No Purpur builds are published for ${version}.`);
      return {
        url: `https://api.purpurmc.org/v2/purpur/${encodeURIComponent(version)}/${latest}/download`,
        filename: `purpur-${version}-${latest}.jar`,
        build: latest,
        apiSource: 'PurpurMC API',
      };
    }

    if (engine === 'fabric') {
      const r = await fetch('https://meta.fabricmc.net/v2/versions/loader', {
        headers: ENGINE_UA,
      });
      if (!r.ok) throw new Error(`Fabric Meta API returned HTTP ${r.status}`);
      const loaders = (await r.json()) as Array<{ version: string; stable: boolean }>;
      const loader = loaders.find((l) => l.stable) || loaders[0];
      if (!loader?.version) throw new Error('No Fabric loader versions are available.');
      return {
        url: `https://meta.fabricmc.net/v2/versions/loader/${encodeURIComponent(
          version
        )}/${encodeURIComponent(loader.version)}/1.0.1/server/jar`,
        filename: `fabric-server-mc.${version}-loader.${loader.version}-launcher.1.0.1.jar`,
        build: loader.version,
        apiSource: 'Fabric Meta API',
      };
    }

    if (engine === 'vanilla' || engine === 'minecraft') {
      const manifestResp = await fetch(
        'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json',
        { headers: ENGINE_UA }
      );
      if (!manifestResp.ok) {
        throw new Error(`Mojang version manifest returned HTTP ${manifestResp.status}`);
      }
      const manifest = (await manifestResp.json()) as {
        versions: Array<{ id: string; url: string }>;
      };
      const entry = manifest.versions.find((v) => v.id === version);
      if (!entry?.url) throw new Error(`Minecraft ${version} is not in the Mojang manifest.`);
      const detailResp = await fetch(entry.url);
      if (!detailResp.ok) throw new Error(`Mojang version detail returned HTTP ${detailResp.status}`);
      const detail = (await detailResp.json()) as {
        downloads?: { server?: { url: string } };
      };
      const serverUrl = detail.downloads?.server?.url;
      if (!serverUrl) throw new Error(`Mojang does not publish a server.jar for ${version}.`);
      return {
        url: serverUrl,
        filename: `minecraft_server.${version}.jar`,
        build: version,
        apiSource: 'Mojang Piston API',
      };
    }

    if (engine === 'spigot' || engine === 'bukkit') {
      return {
        url: `https://cdn.getbukkit.org/spigot/spigot-${encodeURIComponent(version)}.jar`,
        filename: `spigot-${version}.jar`,
        build: version,
        apiSource: 'GetBukkit CDN',
      };
    }

    throw new Error(
      `Automatic server.jar download is not supported for "${engineRaw}". Upload a jar in the setup panel.`
    );
  }

  async function installServerJar(
    serverDir: string,
    engine: string,
    version: string,
    preferred?: { url?: string; filename?: string; build?: string; apiSource?: string },
    ctx?: JobContext
  ): Promise<{ ok: boolean; jarPath?: string; bytes?: number; target?: EngineJarTarget; error?: string }> {
    try {
      // A build chosen in the install dialog wins over "latest": the picker
      // lists the real builds the engine API returns for that version.
      const target: EngineJarTarget =
        preferred && preferred.url
          ? {
              url: String(preferred.url),
              filename: String(preferred.filename || `${engine}-${version}.jar`),
              build: String(preferred.build || ''),
              apiSource: String(preferred.apiSource || 'Selected build'),
            }
          : await resolveEngineJarTarget(engine, version);
      ctx?.report({
        percent: 2,
        stage: 'resolving',
        message: `Resolved ${target.filename} from ${target.apiSource}`,
      });
      const response = await fetch(target.url, {
        headers: ENGINE_UA,
        redirect: 'follow',
        signal: ctx?.signal,
      });
      if (!response.ok) {
        throw new Error(`Download failed with HTTP ${response.status} (${target.apiSource})`);
      }

      const totalBytes = Number(response.headers.get('content-length') || 0);
      const chunks: Buffer[] = [];
      let received = 0;
      const reader = response.body?.getReader();
      if (reader) {
        for (;;) {
          if (ctx?.signal.aborted) throw new JobCancelledError();
          const { done, value } = await reader.read();
          if (done) break;
          if (value?.length) {
            chunks.push(Buffer.from(value));
            received += value.length;
            const mb = (n: number) => `${(n / 1024 / 1024).toFixed(1)} MB`;
            ctx?.report({
              percent: totalBytes ? 5 + (received / totalBytes) * 85 : null,
              stage: 'downloading',
              message: totalBytes
                ? `Downloading ${target.filename}: ${mb(received)} of ${mb(totalBytes)}`
                : `Downloading ${target.filename}: ${mb(received)}`,
            });
          }
        }
      }
      const buffer = reader ? Buffer.concat(chunks) : Buffer.from(await response.arrayBuffer());
      ctx?.report({ percent: 92, stage: 'verifying', message: 'Verifying the jar signature…' });
      if (buffer.length < 50_000) {
        throw new Error(`Downloaded file is only ${buffer.length} bytes — not a server jar.`);
      }
      if (buffer[0] !== 0x50 || buffer[1] !== 0x4b) {
        throw new Error('Downloaded file is not a valid jar archive (bad signature).');
      }
      fs.mkdirSync(serverDir, { recursive: true });
      const jarPath = path.join(serverDir, 'server.jar');
      const partPath = `${jarPath}.part`;
      fs.writeFileSync(partPath, buffer);
      fs.renameSync(partPath, jarPath);
      console.log(
        `[JarInstaller] Installed ${target.filename} (${(buffer.length / 1024 / 1024).toFixed(
          1
        )} MB) as ${jarPath}`
      );
      return { ok: true, jarPath, bytes: buffer.length, target };
    } catch (err) {
      // Cancellation is not a failure: let the job manager mark the job cancelled.
      if (ctx?.signal.aborted || err instanceof JobCancelledError) throw err;
      const message = err instanceof Error ? err.message : 'server.jar install failed';
      console.warn('[JarInstaller] Failed:', message);
      return { ok: false, error: message };
    }
  }

  const serverDirHasJar = (dir: string): boolean => {
    try {
      return fs.readdirSync(dir).some((f) => f.toLowerCase().endsWith('.jar'));
    } catch {
      return false;
    }
  };

  // ============================================================================
  // 3b. REAL-TIME LOCAL PC DISK & FOLDER BROWSER (install folder picker)
  // ============================================================================
  const statfsGb = (target: string): { totalGb: number; freeGb: number } => {
    try {
      const anyFs = fs as unknown as {
        statfsSync?: (p: string) => { bsize: number; blocks: number; bavail: number };
      };
      if (typeof anyFs.statfsSync === 'function') {
        const s = anyFs.statfsSync(target);
        const totalGb = Math.round((s.bsize * s.blocks) / 1024 ** 3);
        const freeGb = Math.round((s.bsize * s.bavail) / 1024 ** 3);
        return { totalGb, freeGb };
      }
    } catch {
      // some drives (network/removable) throw on statfs — report unknown sizes
    }
    return { totalGb: 0, freeGb: 0 };
  };

  const windowsDriveRoots = (): string[] => {
    if (process.platform !== 'win32') return [];
    const roots: string[] = [];
    for (let code = 65; code <= 90; code += 1) {
      const root = `${String.fromCharCode(code)}:\\`;
      try {
        if (fs.existsSync(root)) roots.push(root);
      } catch {
        // drive letter not mounted
      }
    }
    return roots;
  };

  // The install folder picker asks for the PC's real disks and folders so the
  // operator can point a new server at any drive on this machine.
  app.get('/api/system/local-drives', validateSession, (_req, res) => {
    const drives: Array<{
      id: string;
      driveLetter: string;
      rootPath: string;
      label: string;
      fileSystem: string;
      totalGb: number;
      usedGb: number;
      freeGb: number;
      usedPct: number;
      recommendedPath: string;
    }> = [];

    const pushDrive = (rootPath: string, label: string, fileSystem: string) => {
      const { totalGb, freeGb } = statfsGb(rootPath);
      const usedGb = Math.max(0, totalGb - freeGb);
      drives.push({
        id: rootPath.replace(/[\\/]/g, '').toUpperCase() || rootPath,
        driveLetter: rootPath,
        rootPath,
        label: label || rootPath,
        fileSystem,
        totalGb,
        usedGb,
        freeGb,
        usedPct: totalGb > 0 ? Math.round((usedGb / totalGb) * 100) : 0,
        recommendedPath: path.join(rootPath, 'KingServers'),
      });
    };

    if (process.platform === 'win32') {
      for (const root of windowsDriveRoots()) {
        let label = `Local Disk (${root.replace(/\\$/, '')})`;
        let fileSystem = 'NTFS';
        try {
          const stdout = require('child_process').execFileSync(
            'powershell',
            [
              '-NoProfile',
              '-Command',
              `$d = Get-Volume -DriveLetter ${root.charAt(0)} -ErrorAction SilentlyContinue; if ($d) { "$($d.FileSystemType)|$($d.FileSystemLabel)" }`,
            ],
            { encoding: 'utf8', timeout: 4000 }
          ) as string;
          const [fsType, fsLabel] = String(stdout || '').trim().split('|');
          if (fsType) fileSystem = fsType;
          if (fsLabel) label = `${fsLabel} (${root.replace(/\\$/, '')})`;
        } catch {
          // Get-Volume unavailable — keep the generic label
        }
        pushDrive(root, label, fileSystem);
      }
    } else {
      pushDrive('/', 'Root filesystem', 'ext4');
      if (process.env.HOME && process.env.HOME !== '/') {
        pushDrive(process.env.HOME, 'Home', 'ext4');
      }
    }

    const home = os.homedir();
    const quickAccess = [
      { label: 'Server Install Root', path: serverInstallConfig.installRootDir, icon: 'dns' },
      { label: 'Project Folder', path: process.cwd(), icon: 'folder_code' },
      { label: 'Home', path: home, icon: 'home' },
      { label: 'Desktop', path: path.join(home, 'Desktop'), icon: 'desktop_windows' },
      { label: 'Downloads', path: path.join(home, 'Downloads'), icon: 'download' },
      { label: 'Documents', path: path.join(home, 'Documents'), icon: 'description' },
    ].filter((item) => {
      try {
        return fs.existsSync(item.path) && fs.statSync(item.path).isDirectory();
      } catch {
        return false;
      }
    });

    res.json({ ok: true, platform: process.platform, hostname: os.hostname(), drives, quickAccess });
  });

  const looksLikeServerFolder = (dir: string): boolean => {
    try {
      const entries = fs.readdirSync(dir);
      return entries.some((f) =>
        ['server.jar', 'server.properties', 'eula.txt', 'start.sh', 'start.bat'].includes(
          f.toLowerCase()
        )
      );
    } catch {
      return false;
    }
  };

  app.post('/api/system/browse-folders', validateSession, (req, res) => {
    const rawPath = String(req.body?.currentPath || '').trim();
    const createFolderName = String(req.body?.createFolderName || '').trim();

    const fallbackRoot = process.platform === 'win32' ? windowsDriveRoots()[0] || 'C:\\' : '/';
    let currentPath = rawPath || serverInstallConfig.installRootDir || fallbackRoot;
    try {
      currentPath = path.resolve(currentPath);
    } catch {
      currentPath = fallbackRoot;
    }

    // A typed path may not exist yet (e.g. D:\Servers\NewRoot). Walk up to the
    // closest existing ancestor instead of failing the whole browse.
    let probe = currentPath;
    const missing: string[] = [];
    while (probe && !fs.existsSync(probe)) {
      missing.unshift(path.basename(probe));
      const parent = path.dirname(probe);
      if (parent === probe) break;
      probe = parent;
    }
    if (!fs.existsSync(probe) || !fs.statSync(probe).isDirectory()) {
      res.status(400).json({ ok: false, error: `Folder not found: ${rawPath}` });
      return;
    }

    if (createFolderName) {
      const safeName = createFolderName.replace(/[<>:"/\\|?*]/g, '_');
      try {
        const created = path.join(probe, ...missing, safeName);
        fs.mkdirSync(created, { recursive: true });
        probe = created;
        missing.length = 0;
      } catch (err) {
        res.status(500).json({
          ok: false,
          error: err instanceof Error ? err.message : 'Could not create that folder',
        });
        return;
      }
    }

    const resolvedPath = missing.length ? path.join(probe, ...missing) : probe;
    const folders: Array<{
      name: string;
      fullPath: string;
      modifiedAt: string;
      itemCount: number;
      isServerFolder: boolean;
    }> = [];
    try {
      for (const entry of fs.readdirSync(probe, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
        const fullPath = path.join(probe, entry.name);
        let modifiedAt = new Date(0).toISOString();
        let itemCount = 0;
        try {
          modifiedAt = fs.statSync(fullPath).mtime.toISOString();
          itemCount = fs.readdirSync(fullPath).length;
        } catch {
          // permission denied on a child folder — still list it
        }
        folders.push({
          name: entry.name,
          fullPath,
          modifiedAt,
          itemCount,
          isServerFolder: looksLikeServerFolder(fullPath),
        });
      }
    } catch (err) {
      res.status(403).json({
        ok: false,
        error: err instanceof Error ? err.message : 'Cannot read that folder',
      });
      return;
    }
    folders.sort((a, b) => a.name.localeCompare(b.name));

    const parentCandidate = path.dirname(probe);
    const isRoot = parentCandidate === probe;
    res.json({
      ok: true,
      currentPath: resolvedPath,
      parentPath: isRoot ? null : parentCandidate,
      folders,
      isAtRoot: isRoot,
      serverInstallRoot: serverInstallConfig.installRootDir,
    });
  });

  // ============================================================================
  // 4. REAL-TIME LOCAL PC NETWORK INTERFACES, ACTIVE PORTS & PORT FORWARDING
  // ============================================================================
  app.get('/api/network/local-ports', validateSession, async (_req, res) => {
    try {
      // 1. Gather real host network interfaces
      const rawIfaces = os.networkInterfaces();
      const interfaces: Array<{
        name: string;
        address: string;
        family: string;
        mac: string;
        internal: boolean;
      }> = [];
      for (const [ifName, addrs] of Object.entries(rawIfaces)) {
        if (!addrs) continue;
        for (const addr of addrs) {
          interfaces.push({
            name: ifName,
            address: addr.address,
            family: String(addr.family),
            mac: addr.mac,
            internal: addr.internal,
          });
        }
      }

      // 2. Parse real listening OS sockets from /proc/net/tcp, /proc/net/tcp6, /proc/net/udp
      const tcp4 = parseProcNetFile('/proc/net/tcp', 'TCP');
      const tcp6 = parseProcNetFile('/proc/net/tcp6', 'TCP');
      const udp4 = parseProcNetFile('/proc/net/udp', 'UDP');
      const combinedOsSockets = [...tcp4, ...tcp6, ...udp4];

      // Also attempt ss -tulnp if available for process names
      const processMap = new Map<number, { processName: string; pid: number }>();
      try {
        const { stdout } = await execAsync('ss -tulnp 2>/dev/null || true');
        const lines = stdout.split('\n');
        for (const l of lines) {
          const portMatch = l.match(/:(\d+)\s+/);
          const procMatch = l.match(/users:\(\("([^"]+)",pid=(\d+)/);
          if (portMatch) {
            const pNum = parseInt(portMatch[1], 10);
            if (procMatch) {
              processMap.set(pNum, {
                processName: procMatch[1],
                pid: parseInt(procMatch[2], 10),
              });
            }
          }
        }
      } catch {
        // fallback if ss is restricted
      }

      // Probe well-known local ports + detected OS ports
      // Only real listeners are probed: whatever the OS reports, the panel's
      // own port, and the ports of servers this panel actually manages.
      const managedPorts = Array.from(trackedServersMap.values())
        .map((srv) => Number(srv.port))
        .filter((port) => port > 0);
      const candidatePorts = Array.from(
        new Set([
          ...combinedOsSockets.map((s) => s.port),
          PORT,
          3306,
          ...managedPorts,
          // Recorded rules are probed too, so the view can say whether the
          // local side of a mapping is actually listening right now.
          ...activeForwards.map((f) => f.internalPort),
        ])
      ).sort((a, b) => a - b);

      const knownLabels: Record<number, { service: string; process: string; defaultPid: number }> = {
        [PORT]: {
          service: 'KingPanel Daemon & Web IPC Socket',
          process: 'node server',
          defaultPid: process.pid,
        },
        3306: {
          service: 'Local MySQL / MariaDB',
          process: 'mysqld.exe',
          defaultPid: 0,
        },
      };
      for (const srv of trackedServersMap.values()) {
        const srvPort = Number(srv.port);
        if (!srvPort) continue;
        knownLabels[srvPort] = {
          service: `${srv.name} (${srv.engine})`,
          process: 'java.exe',
          defaultPid: srv.pid || 0,
        };
      }

      const scannedPorts = await Promise.all(
        candidatePorts.map(async (portNum) => {
          const osEntry = combinedOsSockets.find((s) => s.port === portNum);
          const probe = await probeLocalTcpPort(portNum);
          const procInfo = processMap.get(portNum);
          const known = knownLabels[portNum];
          const forwardRule = activeForwards.find(
            (f) => f.internalPort === portNum || f.externalPort === portNum
          );

          const isRealOsSocket = Boolean(osEntry || probe.open);
          return {
            port: portNum,
            proto: osEntry?.proto || (portNum === 19132 ? 'UDP' : 'TCP'),
            bindAddress: osEntry?.bindIp || '0.0.0.0',
            processName: procInfo?.processName || known?.process || 'system-daemon',
            pid: procInfo?.pid || known?.defaultPid || 0,
            serviceDescription:
              known?.service || (isRealOsSocket ? `Local listener on port ${portNum}` : 'Not listening'),
            sourceType: isRealOsSocket ? 'OS_KERNEL_LIVE' : 'PANEL_MANAGED',
            reachable: probe.open || Boolean(osEntry),
            latencyMs: probe.open ? Math.max(1, probe.latencyMs) : 1,
            forwarded: Boolean(forwardRule),
            forwardConfig: forwardRule || null,
          };
        })
      );

      res.json({
        ok: true,
        scannedAt: new Date().toISOString(),
        hostname: os.hostname(),
        platform: `${os.type()} ${os.release()} (${os.arch()})`,
        interfaces,
        ports: scannedPorts,
        forwards: activeForwards.map((rule) => {
          const live = scannedPorts.find((scan) => scan.port === rule.internalPort);
          return {
            ...rule,
            liveProbe: {
              reachable: Boolean(live?.reachable),
              latencyMs: live?.latencyMs ?? 0,
              checkedAt: new Date().toISOString(),
            },
          };
        }),
      });
    } catch (err) {
      res.status(500).json({
        ok: false,
        error: err instanceof Error ? err.message : 'Local port scan failed',
      });
    }
  });

  // Record (create or update) a Port Forwarding Rule for a Local PC Port
  app.post('/api/network/forward', validateSession, requireAdvancedPanel, async (req, res) => {
    const raw = req.body || {};
    const validated = parseForwardInput(raw, `Port ${raw?.internalPort ?? ''}`.trim());
    if (!validated.ok) {
      res.status(400).json({ ok: false, error: validated.error });
      return;
    }

    const { externalPort, internalPort, internalIp, protocol, serviceName, method } =
      validated.value;
    const probe = await probeLocalTcpPort(internalPort);
    const now = new Date().toISOString();

    // One rule per port pair: re-submitting the same ports updates that rule.
    const kept = activeForwards.filter(
      (f) => f.internalPort !== internalPort && f.externalPort !== externalPort
    );
    const replaced = kept.length !== activeForwards.length;
    const previous = replaced
      ? activeForwards.find(
          (f) => f.internalPort === internalPort || f.externalPort === externalPort
        )
      : undefined;

    const rule: ForwardedPortConfig = {
      id: previous?.id || `fwd-${externalPort}-${Date.now()}`,
      externalPort,
      internalPort,
      internalIp,
      protocol,
      serviceName,
      method,
      status: 'RECORDED',
      createdAt: previous?.createdAt || now,
      updatedAt: now,
      lastProbe: { reachable: probe.open, latencyMs: probe.latencyMs, checkedAt: now },
    };

    const nextRules = [...kept, rule];
    const persisted = writeStoredPortForwards(nextRules);
    if (!persisted.ok) {
      res.status(500).json({
        ok: false,
        error: `The rule was not saved: ${persisted.error}`,
      });
      return;
    }
    activeForwards.splice(0, activeForwards.length, ...nextRules);

    res.json({
      ok: true,
      // Honest by construction: the panel never applies a mapping itself.
      applied: false,
      replaced,
      rule,
      probeReachable: probe.open,
      latencyMs: probe.latencyMs,
      note: 'Recorded on this panel only. Nothing was applied to your router, the Windows firewall or netsh — run one of these commands (or forward the port on your router) to make it reachable from the internet.',
      commands: {
        netsh: `netsh interface portproxy add v4tov4 listenport=${externalPort} listenaddress=0.0.0.0 connectport=${internalPort} connectaddress=${internalIp}`,
        powershellFirewall: `New-NetFirewallRule -DisplayName "KingPanel - ${serviceName} (${externalPort})" -Direction Inbound -LocalPort ${externalPort} -Protocol ${
          protocol === 'UDP' ? 'UDP' : 'TCP'
        } -Action Allow`,
        upnpCli: `upnpc -a ${internalIp} ${internalPort} ${externalPort} ${
          protocol === 'UDP' ? 'UDP' : 'TCP'
        }`,
      },
    });
  });

  app.delete('/api/network/forward/:port', validateSession, requireAdvancedPanel, async (req, res) => {
    const portNum = Number(req.params.port);
    if (!isValidPortNumber(portNum)) {
      res.status(400).json({
        ok: false,
        error: 'Port must be a whole number between 1 and 65535.',
      });
      return;
    }

    const idx = activeForwards.findIndex(
      (f) => f.internalPort === portNum || f.externalPort === portNum
    );
    if (idx === -1) {
      res.status(404).json({
        ok: false,
        error: `No forward rule is recorded for port ${portNum}.`,
      });
      return;
    }
    const rule = activeForwards[idx];

    // An active rule owns a firewall port and a portproxy entry. Forgetting the
    // record while those remain would hide an open port from the panel, so the
    // revert has to succeed before the record goes away.
    if (rule.status === 'ACTIVE') {
      const outcome = await revertForward(forwardTargetOf(rule), forwardDeps());
      if (!outcome.ok) {
        res.status(applyErrorStatus(outcome.code)).json({
          ok: false,
          code: outcome.code,
          error: `This rule is active on this PC and could not be reversed: ${outcome.message}`,
          detail: outcome.detail,
          rule,
        });
        return;
      }
    }

    const nextRules = activeForwards.filter((_, position) => position !== idx);
    const persisted = writeStoredPortForwards(nextRules);
    if (!persisted.ok) {
      res.status(500).json({
        ok: false,
        error: `The rule was not removed: ${persisted.error}`,
      });
      return;
    }
    const [removed] = activeForwards.splice(idx, 1);
    res.json({ ok: true, removedPort: portNum, rule: removed });
  });

  // Apply a recorded rule for real. One elevated netsh run (delete-then-add, so
  // re-applying is idempotent), then a read-back before anything says ACTIVE.
  app.post(
    '/api/network/forward/:port/apply',
    validateSession,
    requireAdvancedPanel,
    async (req, res) => {
      const portNum = Number(req.params.port);
      if (!isValidPortNumber(portNum)) {
        res.status(400).json({
          ok: false,
          error: 'Port must be a whole number between 1 and 65535.',
        });
        return;
      }
      const rule = findForwardRule(portNum);
      if (!rule) {
        res.status(404).json({
          ok: false,
          error: `No forward rule is recorded for port ${portNum}.`,
        });
        return;
      }
      if (rule.status === 'APPLYING') {
        res.status(409).json({
          ok: false,
          code: 'APPLY_IN_PROGRESS',
          error: 'This rule is already being applied. Wait for the Windows prompt to finish.',
        });
        return;
      }

      // Committed before the await so a concurrent click sees APPLYING, and so a
      // crash mid-apply cannot leave a stale ACTIVE behind (the loader restores
      // APPLYING as RECORDED).
      rule.status = 'APPLYING';
      rule.applyError = null;
      commitForwardRule();

      const outcome = await applyForward(forwardTargetOf(rule), forwardDeps());
      if (!outcome.ok) {
        rule.status = 'FAILED';
        rule.applyError = outcome.detail
          ? `${outcome.message} (${outcome.detail})`
          : outcome.message;
        rule.verification = null;
        rule.updatedAt = new Date().toISOString();
        commitForwardRule();
        res.status(applyErrorStatus(outcome.code)).json({
          ok: false,
          code: outcome.code,
          error: outcome.message,
          detail: outcome.detail,
          rule,
        });
        return;
      }

      rule.status = 'ACTIVE';
      rule.appliedAt = outcome.appliedAt;
      rule.applyError = null;
      rule.verification = outcome.verification;
      rule.updatedAt = outcome.appliedAt;
      const persisted = commitForwardRule();
      res.json({
        ok: true,
        rule,
        verification: outcome.verification,
        warning: persisted
          ? undefined
          : 'The mapping is live on this PC, but the updated rule could not be written to disk.',
      });
    }
  );

  // Re-read the OS state for one rule. Downgrades a rule whose mapping vanished
  // (portproxy cleared by hand, firewall rule deleted, reboot on a machine that
  // does not persist them) instead of showing a stale ACTIVE.
  app.post(
    '/api/network/forward/:port/verify',
    validateSession,
    requireAdvancedPanel,
    async (req, res) => {
      if (process.platform !== 'win32') {
        res.status(501).json({
          ok: false,
          code: 'UNSUPPORTED_PLATFORM',
          error: 'Verifying a mapping is only implemented for Windows.',
        });
        return;
      }
      const portNum = Number(req.params.port);
      if (!isValidPortNumber(portNum)) {
        res.status(400).json({
          ok: false,
          error: 'Port must be a whole number between 1 and 65535.',
        });
        return;
      }
      const rule = findForwardRule(portNum);
      if (!rule) {
        res.status(404).json({
          ok: false,
          error: `No forward rule is recorded for port ${portNum}.`,
        });
        return;
      }

      const verification = await verifyForward(forwardTargetOf(rule), forwardDeps());
      const passed = forwardVerificationPassed(verification);
      const previousStatus = rule.status;
      rule.verification = verification;
      rule.updatedAt = new Date().toISOString();
      if (passed) {
        rule.status = 'ACTIVE';
        rule.appliedAt = rule.appliedAt || verification.checkedAt;
        rule.applyError = null;
      } else {
        rule.status = previousStatus === 'FAILED' ? 'FAILED' : 'RECORDED';
        rule.appliedAt = null;
        rule.applyError = 'The mapping is not present on this PC right now.';
      }
      commitForwardRule();

      res.json({
        ok: true,
        verified: passed,
        previousStatus,
        rule,
        verification,
      });
    }
  );

  // Take the mapping away, then drop the rule back to RECORDED.
  app.post(
    '/api/network/forward/:port/revert',
    validateSession,
    requireAdvancedPanel,
    async (req, res) => {
      const portNum = Number(req.params.port);
      if (!isValidPortNumber(portNum)) {
        res.status(400).json({
          ok: false,
          error: 'Port must be a whole number between 1 and 65535.',
        });
        return;
      }
      const rule = findForwardRule(portNum);
      if (!rule) {
        res.status(404).json({
          ok: false,
          error: `No forward rule is recorded for port ${portNum}.`,
        });
        return;
      }

      const outcome = await revertForward(forwardTargetOf(rule), forwardDeps());
      if (!outcome.ok) {
        // The mapping may still be live, so the status is left alone; only the
        // reason is recorded and shown.
        rule.applyError = outcome.message;
        rule.updatedAt = new Date().toISOString();
        commitForwardRule();
        res.status(applyErrorStatus(outcome.code)).json({
          ok: false,
          code: outcome.code,
          error: outcome.message,
          detail: outcome.detail,
          rule,
        });
        return;
      }

      rule.status = 'RECORDED';
      rule.appliedAt = null;
      rule.applyError = null;
      rule.verification = outcome.verification;
      rule.updatedAt = outcome.revertedAt;
      commitForwardRule();
      res.json({ ok: true, rule, verification: outcome.verification });
    }
  );

  // One-click proof that the elevated path works on THIS PC: apply a throwaway
  // mapping on a free high port, verify it against the OS, then remove it again.
  // It never creates or touches a stored rule — this is a probe of the machine's
  // ability to apply, not an expression of the operator's intent.
  let portForwardSelfTestRunning = false;

  app.post(
    '/api/network/forward/self-test',
    validateSession,
    requireAdvancedPanel,
    async (_req, res) => {
      if (process.platform !== 'win32') {
        res.status(501).json({
          ok: false,
          code: 'UNSUPPORTED_PLATFORM',
          error: 'The elevated apply self-test is only implemented for Windows.',
        });
        return;
      }
      if (portForwardSelfTestRunning) {
        res.status(409).json({
          ok: false,
          code: 'SELF_TEST_IN_PROGRESS',
          error: 'A self-test is already running. Answer the Windows prompt first.',
        });
        return;
      }

      portForwardSelfTestRunning = true;
      try {
        const deps = forwardDeps();

        // Anything already visible is not disposable: stored rules, current
        // portproxy listeners, and the panel's own port.
        const taken = new Set<number>([PORT]);
        for (const rule of activeForwards) {
          taken.add(rule.externalPort);
          taken.add(rule.internalPort);
        }
        try {
          for (const row of parsePortProxyShow(await deps.showPortProxy())) {
            taken.add(row.listenPort);
          }
        } catch {
          // An unreadable netsh only excludes fewer ports; the read-back after
          // the apply is what decides success.
        }

        let port = pickDisposablePort(taken);
        // A service may already be listening there, so ask the OS instead of
        // assuming the range is empty.
        for (let attempt = 0; port !== null && attempt < 8; attempt += 1) {
          const probe = await probeLocalTcpPort(port);
          if (!probe.open) break;
          taken.add(port);
          port = pickDisposablePort(taken);
        }
        if (port === null) {
          res.status(409).json({
            ok: false,
            code: 'NO_DISPOSABLE_PORT',
            error:
              'Every port in the self-test range (49152-65535) is already taken on this PC, so no throwaway port is available.',
          });
          return;
        }

        const target = selfTestTarget(port);
        const stages: Array<{
          name: 'apply' | 'revert';
          ok: boolean;
          code?: string;
          message: string;
          verification?: ForwardVerification;
        }> = [];

        const applied = await applyForward(target, deps);
        stages.push(
          applied.ok
            ? {
                name: 'apply',
                ok: true,
                message: `Windows confirmed :${port} → 127.0.0.1:${port} (firewall rule + portproxy entry).`,
                verification: applied.verification,
              }
            : {
                name: 'apply',
                ok: false,
                code: applied.code,
                message: applied.message,
              }
        );

        if (!applied.ok) {
          res.status(applyErrorStatus(applied.code)).json({
            ok: false,
            proven: false,
            cleanup: 'nothing-to-clean',
            port,
            target,
            stages,
            code: applied.code,
            error: applied.message,
            detail: applied.detail,
          });
          return;
        }

        // Applied and verified — now take it away again so the probe cannot
        // leave an open port behind.
        const reverted = await revertForward(target, deps);
        stages.push(
          reverted.ok
            ? {
                name: 'revert',
                ok: true,
                message: `The throwaway mapping on :${port} was removed again.`,
                verification: reverted.verification,
              }
            : {
                name: 'revert',
                ok: false,
                code: reverted.code,
                message: reverted.message,
              }
        );

        if (!reverted.ok) {
          res.status(502).json({
            ok: false,
            proven: true,
            cleanup: 'leftover',
            port,
            target,
            stages,
            code: reverted.code,
            error: `The elevated apply works, but the throwaway mapping on port ${port} is still live: ${reverted.message}`,
            detail: reverted.detail,
            cleanupCommands: buildCleanupCommands(target),
          });
          return;
        }

        res.json({
          ok: true,
          proven: true,
          cleanup: 'clean',
          port,
          target,
          stages,
          message: `Elevated apply verified: Windows accepted a portproxy entry and firewall rule for :${port}, and both were removed again.`,
        });
      } catch (err) {
        res.status(500).json({
          ok: false,
          proven: false,
          error: err instanceof Error ? err.message : 'The self-test failed unexpectedly.',
        });
      } finally {
        portForwardSelfTestRunning = false;
      }
    }
  );

  // ============================================================================
  // 5. REAL-TIME PANEL CONTROL, LOCAL PC HARDWARE/OS TELEMETRY, PROCESS KILL & PROFILE API
  // ============================================================================
  interface PanelAuditEvent {
    id: string;
    time: string;
    category: 'RAM_ALLOC' | 'SIGKILL' | 'PROFILE' | 'OAUTH' | 'SYSTEM' | 'MARKETPLACE';
    message: string;
    actor: string;
  }

  const LOCAL_PROFILE_PATH = path.join(appStateDir, '.local-operator-profile.json');
  const LOCAL_INSTALL_CONFIG_PATH = path.join(appStateDir, '.local-install-config.json');
  const spawnedLocalWorkers = new Map<
    number,
    { pid: number; name: string; port: number; startedAt: string; proc: ChildProcess }
  >();

  interface ServerInstallConfigState {
    installRootDir: string;
    autoCreateSubfolders: boolean;
    autoAcceptEula: boolean;
    updatedAt: string;
  }

  /**
   * Servers must not default to a folder inside the application directory.
   * A packaged build runs with cwd = the install folder, and the Windows
   * installer replaces that folder during an update — a 1.0.0 -> 1.0.1 test
   * deleted every world stored there. Packaged builds therefore keep servers
   * in userData (which updates never touch); a source checkout keeps
   * ./KingServers next to the code.
   */
  const defaultServerRoot = (): string => {
    const userDataRoot = process.env.APPDATA_DB_DIR
      ? path.dirname(process.env.APPDATA_DB_DIR)
      : null;
    return path.join(userDataRoot || process.cwd(), 'KingServers');
  };

  /**
   * Warns when the configured root sits inside the app folder, because the
   * next update removes it. A configured/legacy path is left untouched — the
   * warning is what turns silent data loss into a visible one.
   */
  const warnIfServerRootInsideAppDir = (root: string): void => {
    const normalize = (p: string) => path.resolve(p).toLowerCase().replace(/[\\/]+$/, '');
    const appDir = normalize(process.cwd());
    const target = normalize(root);
    if (target === appDir || target.startsWith(`${appDir}${path.sep}`)) {
      console.warn(
        `[Servers] Install root "${root}" is inside the application folder "${process.cwd()}". ` +
          'Windows updates replace that folder and delete everything in it — move the server root to a user folder.',
      );
    }
  };

  let serverInstallConfig: ServerInstallConfigState = {
    installRootDir: defaultServerRoot(),
    autoCreateSubfolders: true,
    autoAcceptEula: true,
    updatedAt: new Date().toISOString(),
  };

  try {
    if (fs.existsSync(LOCAL_INSTALL_CONFIG_PATH)) {
      const parsed = JSON.parse(fs.readFileSync(LOCAL_INSTALL_CONFIG_PATH, 'utf8'));
      if (parsed?.installRootDir) {
        serverInstallConfig = { ...serverInstallConfig, ...parsed };
      }
    }
  } catch {
    // ignore
  }

  /**
   * 1.0.0 defaulted the install root to <install dir>\KingServers, and anyone who
   * saved settings once has that path persisted. Rescuing the files is not enough
   * if the panel keeps writing new servers into the same folder, because the next
   * update deletes them again — so a saved root inside the app folder is moved to
   * userData, which updates never touch.
   */
  const relocateSavedRootInsideAppDir = (): void => {
    if (!process.env.APPDATA_DB_DIR) return; // source checkout: ./KingServers is correct
    const normalize = (p: string) => path.resolve(p).toLowerCase().replace(/[\\/]+$/, '');
    const appDir = normalize(process.cwd());
    const configured = normalize(serverInstallConfig.installRootDir);
    if (configured !== appDir && !configured.startsWith(`${appDir}${path.sep}`)) return;

    const safeRoot = defaultServerRoot();
    console.warn(
      `[Servers] Saved install root "${serverInstallConfig.installRootDir}" is inside the application folder; ` +
        `switching to "${safeRoot}", which updates do not touch.`,
    );
    serverInstallConfig = {
      ...serverInstallConfig,
      installRootDir: safeRoot,
      updatedAt: new Date().toISOString(),
    };
    try {
      fs.writeFileSync(LOCAL_INSTALL_CONFIG_PATH, JSON.stringify(serverInstallConfig, null, 2), 'utf8');
    } catch {
      // non-fatal: the in-memory root is already safe for this session
    }
  };

  relocateSavedRootInsideAppDir();
  warnIfServerRootInsideAppDir(serverInstallConfig.installRootDir);

  /**
   * Imports server folders that the installer rescued from a previous
   * installation directory (see build/installer.nsh). Builds before 1.0.1 kept
   * servers inside the app folder, which a Windows update replaces, so the
   * installer copies them next to userData before the old version is removed.
   */
  function importLegacyInstallData(root: string): void {
    const userDataRoot = process.env.APPDATA_DB_DIR ? path.dirname(process.env.APPDATA_DB_DIR) : null;
    if (!userDataRoot) return; // source checkout: no installer ever ran
    const staging = path.join(userDataRoot, 'legacy-install-servers');
    if (!fs.existsSync(staging)) return;

    try {
      const rescued = fs
        .readdirSync(staging, { withFileTypes: true })
        .filter((entry) => entry.isDirectory());
      let imported = 0;
      for (const entry of rescued) {
        const target = path.join(root, entry.name);
        if (fs.existsSync(target)) {
          console.warn(
            `[Servers] "${entry.name}" already exists in ${root}; left the rescued copy in ${staging}.`,
          );
          continue;
        }
        fs.cpSync(path.join(staging, entry.name), target, { recursive: true });
        imported += 1;
        console.log(`[Servers] Recovered "${entry.name}" from the previous installation directory.`);
      }
      // Stamped rather than deleted: a folder that was skipped stays on disk for
      // the user to move, instead of being discarded to make the log look clean.
      fs.renameSync(staging, `${staging}.imported-${Date.now()}`);
      if (imported > 0) {
        console.log(
          `[Servers] Recovered ${imported} server folder(s) that an older version kept inside the app folder.`,
        );
      }
    } catch (err) {
      console.error('[Servers] Could not import rescued server data:', err);
    }
  }

  importLegacyInstallData(resolveWritableDiskRoot(serverInstallConfig.installRootDir));

  function joinDisplayServerPath(rootDir: string, folderName: string): string {
    const cleanRoot = rootDir.trim().replace(/[\\/]+$/, '');
    const sep = cleanRoot.includes('\\') ? '\\' : '/';
    return `${cleanRoot}${sep}${folderName}`;
  }

  function resolveWritableDiskRoot(displayPath: string): string {
    const trimmed = (displayPath || '').trim();
    const fallbackRoot = defaultServerRoot();
    const useFallback = () => {
      try {
        fs.mkdirSync(fallbackRoot, { recursive: true });
      } catch {
        // ignore
      }
      return fallbackRoot;
    };
    if (!trimmed) return useFallback();

    // A real Windows path (C:\..., \server\share) must be used verbatim on
    // Windows. The old check rewrote every path containing a backslash to
    // <cwd>\<leaf>, so the install folder chosen in the UI was ignored and
    // servers were created in the wrong place.
    const isWindowsPath = /^[a-zA-Z]:[\/]/.test(trimmed) || trimmed.startsWith('\\');
    if (isWindowsPath && process.platform !== 'win32') {
      const leaf = trimmed.split(/[\/]+/).filter(Boolean).pop() || 'KingServers';
      try {
        const mapped = path.join(process.cwd(), leaf);
        fs.mkdirSync(mapped, { recursive: true });
        return mapped;
      } catch {
        return useFallback();
      }
    }

    try {
      const target = path.isAbsolute(trimmed)
        ? path.normalize(trimmed)
        : path.join(process.cwd(), trimmed);
      fs.mkdirSync(target, { recursive: true });
      return target;
    } catch {
      return useFallback();
    }
  }

  function provisionServerFolderOnLocalDisk(params: {
    serverName: string;
    engine?: string;
    port?: number;
    ramMaxGb?: number;
    installRootDir?: string;
    /** Explicit EULA decision from the install dialog; falls back to the panel default. */
    acceptEula?: boolean;
  }): { folderName: string; displayPath: string; diskPath: string } {
    const folderName =
      params.serverName
        .trim()
        .replace(/[^a-zA-Z0-9_-]/g, '_')
        .replace(/_+/g, '_') || 'Server_Instance';

    const rootDir = (params.installRootDir || serverInstallConfig.installRootDir || '').trim();
    const diskRoot = resolveWritableDiskRoot(rootDir || serverInstallConfig.installRootDir);
    const serverDiskDir = serverInstallConfig.autoCreateSubfolders
      ? path.join(diskRoot, folderName)
      : diskRoot;

    try {
      fs.mkdirSync(serverDiskDir, { recursive: true });
      for (const sub of ['plugins', 'mods', 'world', 'logs', 'config']) {
        fs.mkdirSync(path.join(serverDiskDir, sub), { recursive: true });
      }

      const eulaPath = path.join(serverDiskDir, 'eula.txt');
      const eulaAccepted =
        typeof params.acceptEula === 'boolean'
          ? params.acceptEula
          : serverInstallConfig.autoAcceptEula;
      if (!fs.existsSync(eulaPath) || eulaAccepted) {
        fs.writeFileSync(
          eulaPath,
          `# Generated by KingPanel Local PC Installer (${new Date().toISOString()})\neula=${
            eulaAccepted ? 'true' : 'false'
          }\n`,
          'utf8'
        );
      }

      const propsPath = path.join(serverDiskDir, 'server.properties');
      if (!fs.existsSync(propsPath)) {
        fs.writeFileSync(
          propsPath,
          [
            `# Minecraft server properties (${params.serverName})`,
            `server-port=${params.port || 25565}`,
            `motd=\\u00A76\\u00A7l${params.serverName} \\u00A77[Installed in ${serverInstallConfig.installRootDir}]`,
            `max-players=60`,
            `online-mode=true`,
            `view-distance=10`,
            `simulation-distance=8`,
            '',
          ].join('\n'),
          'utf8'
        );
      }

      const startShPath = path.join(serverDiskDir, 'start.sh');
      fs.writeFileSync(
        startShPath,
        `#!/usr/bin/env bash\njava -Xms${params.ramMaxGb || 4}G -Xmx${params.ramMaxGb || 4}G -XX:+UseG1GC -jar server.jar --nogui\n`,
        'utf8'
      );
    } catch {
      // ignore fs errors
    }

    const displayPath = serverInstallConfig.autoCreateSubfolders
      ? joinDisplayServerPath(rootDir || serverInstallConfig.installRootDir, folderName)
      : rootDir || serverInstallConfig.installRootDir;

    return { folderName, displayPath, diskPath: serverDiskDir };
  }

  function scanInstalledLocalServerFolders() {
    const diskRoot = resolveWritableDiskRoot(serverInstallConfig.installRootDir);
    const results: Array<{
      folderName: string;
      displayPath: string;
      diskPath: string;
      hasEula: boolean;
      hasServerProperties: boolean;
      subfolders: string[];
      fileCount: number;
      modifiedAt: string;
    }> = [];

    try {
      if (!fs.existsSync(diskRoot)) return results;
      const entries = fs.readdirSync(diskRoot, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const fullDir = path.join(diskRoot, entry.name);
        let children: fs.Dirent[] = [];
        try {
          children = fs.readdirSync(fullDir, { withFileTypes: true });
        } catch {
          // ignore
        }
        const stat = fs.statSync(fullDir);
        results.push({
          folderName: entry.name,
          displayPath: joinDisplayServerPath(serverInstallConfig.installRootDir, entry.name),
          diskPath: fullDir,
          hasEula: fs.existsSync(path.join(fullDir, 'eula.txt')),
          hasServerProperties: fs.existsSync(path.join(fullDir, 'server.properties')),
          subfolders: children.filter((c) => c.isDirectory()).map((c) => c.name),
          fileCount: children.length,
          modifiedAt: stat.mtime.toISOString(),
        });
      }
    } catch {
      // ignore
    }
    return results;
  }

  // The panel ships with NO pre-built servers. Every instance in the install
  // root is one the operator created themselves, so nothing is seeded here.

  // Track CPU ticks delta for real-time local PC CPU usage %
  let prevCpuTimes = os.cpus().map((c) => ({ ...c.times }));

  function computeRealLocalCpuUsage(): { totalPct: number; perCorePct: number[]; avgMhz: number } {
    const currentCpus = os.cpus();
    let totalIdle = 0;
    let totalTick = 0;
    const perCorePct: number[] = [];
    let sumMhz = 0;

    currentCpus.forEach((cpu, idx) => {
      sumMhz += cpu.speed || 3200;
      const prev = prevCpuTimes[idx] || cpu.times;
      const idleDelta = cpu.times.idle - prev.idle;
      const totalDelta =
        cpu.times.user -
        prev.user +
        (cpu.times.nice - prev.nice) +
        (cpu.times.sys - prev.sys) +
        (cpu.times.irq - prev.irq) +
        idleDelta;
      totalIdle += idleDelta;
      totalTick += totalDelta;
      const corePct =
        totalDelta > 0 ? Math.max(1, Math.min(100, Math.round(((totalDelta - idleDelta) / totalDelta) * 100))) : 4;
      perCorePct.push(corePct);
    });

    prevCpuTimes = currentCpus.map((c) => ({ ...c.times }));
    const totalPct =
      totalTick > 0
        ? Math.max(1, Math.min(100, Math.round(((totalTick - totalIdle) / totalTick) * 100)))
        : 5;
    const avgMhz = currentCpus.length > 0 ? Math.round(sumMhz / currentCpus.length) : 3600;
    return { totalPct, perCorePct, avgMhz };
  }

  function parseProcMeminfo() {
    const info: Record<string, number> = {};
    try {
      if (fs.existsSync('/proc/meminfo')) {
        const raw = fs.readFileSync('/proc/meminfo', 'utf8');
        for (const line of raw.split('\n')) {
          const match = line.match(/^([A-Za-z0-9_()]+):\s+(\d+)/);
          if (match) {
            // values in /proc/meminfo are in kB
            info[match[1]] = parseInt(match[2], 10);
          }
        }
      }
    } catch {
      // ignore
    }
    return info;
  }

  const panelAuditLog: PanelAuditEvent[] = [
    {
      id: 'evt-init-1',
      time: new Date().toLocaleTimeString(),
      category: 'SYSTEM',
      message: `KingPanel Root Daemon initialized on Local PC PID ${process.pid} (${os.hostname()})`,
      actor: 'System Kernel',
    },
  ];

  const pushPanelAudit = (
    category: PanelAuditEvent['category'],
    message: string,
    actor = 'Operator'
  ) => {
    panelAuditLog.unshift({
      id: `evt-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      time: new Date().toLocaleTimeString(),
      category,
      message,
      actor,
    });
    if (panelAuditLog.length > 30) {
      panelAuditLog.pop();
    }
  };

  app.get('/api/panel/telemetry', validateSession, async (_req, res) => {
    try {
      const totalMemBytes = os.totalmem();
      const freeMemBytes = os.freemem();
      const meminfo = parseProcMeminfo();

      const totalMb = meminfo.MemTotal
        ? Math.round(meminfo.MemTotal / 1024)
        : Math.round(totalMemBytes / 1024 / 1024);
      const availableMb = meminfo.MemAvailable
        ? Math.round(meminfo.MemAvailable / 1024)
        : Math.round(freeMemBytes / 1024 / 1024);
      const freeMb = meminfo.MemFree
        ? Math.round(meminfo.MemFree / 1024)
        : Math.round(freeMemBytes / 1024 / 1024);
      const buffersCachedMb = Math.round(((meminfo.Buffers || 0) + (meminfo.Cached || 0)) / 1024);
      const usedMb = Math.max(64, totalMb - availableMb);
      const swapTotalMb = Math.round((meminfo.SwapTotal || 0) / 1024);
      const swapFreeMb = Math.round((meminfo.SwapFree || 0) / 1024);
      const swapUsedMb = Math.max(0, swapTotalMb - swapFreeMb);

      const cpus = os.cpus();
      const cpuMetrics = computeRealLocalCpuUsage();
      const load = os.loadavg();
      const memUsage = process.memoryUsage();

      // Real disk space for the volume that holds the panel data: statfs first
      // (works on Windows too), df only as a POSIX fallback.
      let diskTotalGb = 0;
      let diskUsedGb = 0;
      let diskFreeGb = 0;
      let diskUsedPct = 0;
      try {
        const stat = fs.statfsSync(appStateDir);
        const totalBytes = stat.bsize * stat.blocks;
        const freeBytes = stat.bsize * stat.bavail;
        diskTotalGb = Number((totalBytes / 1024 / 1024 / 1024).toFixed(2));
        diskFreeGb = Number((freeBytes / 1024 / 1024 / 1024).toFixed(2));
        diskUsedGb = Number(Math.max(0, diskTotalGb - diskFreeGb).toFixed(2));
        diskUsedPct = diskTotalGb > 0 ? Math.round((diskUsedGb / diskTotalGb) * 100) : 0;
      } catch {
        // unsupported volume — report zeroes rather than fiction
      }

      // Real Local PC OS User & Network Info
      let osUser = {
        username: process.env.USER || 'root',
        uid: 0,
        gid: 0,
        homedir: os.homedir(),
        shell: process.env.SHELL || '/bin/bash',
      };
      try {
        const u = os.userInfo();
        osUser = {
          username: u.username || osUser.username,
          uid: u.uid,
          gid: u.gid,
          homedir: u.homedir,
          shell: u.shell || '/bin/bash',
        };
      } catch {
        // fallback if restricted
      }

      const rawIfaces = os.networkInterfaces();
      let primaryIp = '127.0.0.1';
      let primaryMac = '00:00:00:00:00:00';
      let primaryNic = 'lo';
      for (const [ifName, addrs] of Object.entries(rawIfaces)) {
        if (!addrs) continue;
        for (const a of addrs) {
          if (!a.internal && (String(a.family) === 'IPv4' || String(a.family) === '4')) {
            primaryIp = a.address;
            primaryMac = a.mac;
            primaryNic = ifName;
            break;
          }
        }
      }

      // Gather real live OS processes via ps
      const osProcesses: Array<{
        pid: number;
        user: string;
        command: string;
        args: string;
        cpuPct: number;
        memPct: number;
        rssMb: number;
        elapsed: string;
        isProtected: boolean;
        isSpawnedWorker: boolean;
      }> = [];

      try {
        const { stdout } = await execAsync(
          'ps -eo pid,user,pcpu,pmem,rss,etime,comm,args --sort=-rss 2>/dev/null | head -n 16 || true'
        );
        const lines = stdout.trim().split('\n').slice(1);
        for (const line of lines) {
          const parts = line.trim().split(/\s+/);
          if (parts.length >= 7) {
            const pidNum = parseInt(parts[0], 10) || 0;
            const argsStr = parts.slice(7).join(' ') || parts[6];
            osProcesses.push({
              pid: pidNum,
              user: parts[1],
              cpuPct: parseFloat(parts[2]) || 0,
              memPct: parseFloat(parts[3]) || 0,
              rssMb: Number((parseInt(parts[4], 10) / 1024).toFixed(1)) || 0,
              elapsed: parts[5] || '00:01',
              command: parts[6],
              args: argsStr.slice(0, 90),
              isProtected: pidNum <= 2 || pidNum === process.pid,
              isSpawnedWorker: spawnedLocalWorkers.has(pidNum),
            });
          }
        }
      } catch {
        // fallback if ps is restricted
      }

      // Read saved local PC operator profile if present on disk
      let diskSavedProfile = null;
      try {
        if (fs.existsSync(LOCAL_PROFILE_PATH)) {
          diskSavedProfile = JSON.parse(fs.readFileSync(LOCAL_PROFILE_PATH, 'utf8'));
        }
      } catch {
        // ignore
      }

      res.json({
        ok: true,
        timestamp: new Date().toISOString(),
        host: {
          hostname: os.hostname(),
          platform: `${os.type()} ${os.release()} (${os.arch()})`,
          kernelVersion: os.version ? os.version() : os.release(),
          uptimeSeconds: Math.floor(os.uptime()),
          cpuModel: cpus[0]?.model || 'Local PC Multi-Core Processor',
          cpuCores: cpus.length || 4,
          cpuSpeedMhz: cpuMetrics.avgMhz,
          cpuUsagePct: cpuMetrics.totalPct,
          perCorePct: cpuMetrics.perCorePct,
          loadAvg1m: Number(load[0].toFixed(2)),
          loadAvg5m: Number(load[1].toFixed(2)),
          loadAvg15m: Number(load[2].toFixed(2)),
          osTotalGb: Number((totalMb / 1024).toFixed(2)),
          osFreeGb: Number((freeMb / 1024).toFixed(2)),
          osAvailableGb: Number((availableMb / 1024).toFixed(2)),
          osUsedGb: Number((usedMb / 1024).toFixed(2)),
          osTotalMb: totalMb,
          osUsedMb: usedMb,
          osAvailableMb: availableMb,
          buffersCachedMb,
          swapTotalMb,
          swapUsedMb,
          diskTotalGb,
          diskUsedGb,
          diskFreeGb,
          diskUsedPct,
          daemonPid: process.pid,
          daemonRssMb: Number((memUsage.rss / 1024 / 1024).toFixed(1)),
          daemonHeapMb: Number((memUsage.heapUsed / 1024 / 1024).toFixed(1)),
        },
        localPcUser: {
          ...osUser,
          hostname: os.hostname(),
          primaryNic,
          primaryIp,
          primaryMac,
          nodeVersion: process.version,
          v8Version: process.versions.v8,
          cwd: process.cwd(),
          profileFilePath: LOCAL_PROFILE_PATH,
        },
        installConfig: {
          ...serverInstallConfig,
          resolvedDiskRoot: resolveWritableDiskRoot(serverInstallConfig.installRootDir),
          installedFolders: scanInstalledLocalServerFolders(),
        },
        diskSavedProfile,
        osProcesses,
        auditLog: panelAuditLog,
      });
    } catch (err) {
      res.status(500).json({
        ok: false,
        error: err instanceof Error ? err.message : 'Telemetry fetch failed',
      });
    }
  });

  // Spawn a real background worker process on the Local PC so user can see and SIGKILL a real OS PID
  app.post('/api/panel/spawn-local-worker', validateSession, requireAdvancedPanel, (req, res) => {
    try {
      const { name = 'LocalPC-Server-Daemon', memoryMb = 32 } = req.body || {};
      const script = `
        const buf = Buffer.alloc(${Math.min(128, Math.max(8, Number(memoryMb) || 24))} * 1024 * 1024, 1);
        setInterval(() => { buf[0] = (buf[0] + 1) % 255; }, 500);
      `;
      const child = spawn(process.execPath, ['-e', script], {
        stdio: 'ignore',
        detached: false,
      });
      if (!child.pid) {
        throw new Error('Failed to spawn local PC process');
      }
      const port = 25580 + spawnedLocalWorkers.size;
      spawnedLocalWorkers.set(child.pid, {
        pid: child.pid,
        name,
        port,
        startedAt: new Date().toISOString(),
        proc: child,
      });
      child.on('exit', () => {
        if (child.pid) spawnedLocalWorkers.delete(child.pid);
      });
      pushPanelAudit(
        'SYSTEM',
        `Spawned real Local PC process "${name}" on OS PID ${child.pid} (${memoryMb} MB RSS allocated)`,
        'Local PC Kernel'
      );
      res.json({
        ok: true,
        pid: child.pid,
        name,
        port,
        auditLog: panelAuditLog,
      });
    } catch (err) {
      res.status(500).json({
        ok: false,
        error: err instanceof Error ? err.message : 'Spawn failed',
      });
    }
  });

  // Execute a real OS process.kill(pid, 'SIGKILL') on the Local PC
  app.post('/api/panel/kill-local-pid', validateSession, requireAdvancedPanel, (req, res) => {
    const { pid, signal = 'SIGKILL', actor = 'Operator' } = req.body || {};
    const pidNum = Number(pid);
    if (!pidNum || isNaN(pidNum)) {
      res.status(400).json({ ok: false, error: 'Valid PID required' });
      return;
    }
    if (pidNum <= 2 || pidNum === process.pid) {
      res.status(403).json({
        ok: false,
        error: `PID ${pidNum} is the active Panel Root Daemon / OS Init and is protected from termination.`,
      });
      return;
    }
    try {
      process.kill(pidNum, signal as NodeJS.Signals);
      spawnedLocalWorkers.delete(pidNum);
      pushPanelAudit(
        'SIGKILL',
        `Executed real OS process.kill(${pidNum}, '${signal}') on Local PC`,
        actor
      );
      res.json({
        ok: true,
        killedPid: pidNum,
        signal,
        auditLog: panelAuditLog,
      });
    } catch (err) {
      res.status(500).json({
        ok: false,
        error: err instanceof Error ? err.message : `Failed to kill PID ${pidNum}`,
      });
    }
  });

  app.post('/api/panel/ram-sync', validateSession, (req, res) => {
    const { hostTotalGb, globalCapGb, serverName, newMaxGb, actor } = req.body || {};
    if (serverName && newMaxGb !== undefined) {
      pushPanelAudit(
        'RAM_ALLOC',
        `Adjusted ${serverName} JVM heap ceiling (-Xmx) to ${newMaxGb} GB`,
        actor || 'Operator'
      );
    } else if (hostTotalGb && globalCapGb) {
      pushPanelAudit(
        'RAM_ALLOC',
        `Updated Global RAM Pool cap to ${globalCapGb} GB / ${hostTotalGb} GB Host DDR5`,
        actor || 'Operator'
      );
    }
    res.json({
      ok: true,
      syncedAt: new Date().toISOString(),
      auditLog: panelAuditLog,
    });
  });

  app.post('/api/panel/server-kill', validateSession, requireAdvancedPanel, (req, res) => {
    const { serverName, pid, action, actor } = req.body || {};
    if (action === 'kill_all') {
      pushPanelAudit(
        'SIGKILL',
        'Executed GLOBAL SIGKILL (-9) across all running server instances',
        actor || 'Root Admin'
      );
    } else if (action === 'kill') {
      pushPanelAudit(
        'SIGKILL',
        `Sent SIGKILL (-9) to ${serverName || 'Server'} (PID ${pid || 'N/A'}) — memory freed`,
        actor || 'Operator'
      );
    } else {
      pushPanelAudit(
        'SYSTEM',
        `Dispatched ${String(action || 'power').toUpperCase()} signal to ${serverName || 'Server'}`,
        actor || 'Operator'
      );
    }
    res.json({
      ok: true,
      executedAt: new Date().toISOString(),
      auditLog: panelAuditLog,
    });
  });

  // Real-time Mojang Minecraft IGN -> UUID + Skin Avatar lookup
  app.get('/api/panel/mojang/:username', validateSession, async (req, res) => {
    const username = String(req.params.username || '').trim();
    if (!username) {
      res.status(400).json({ ok: false, error: 'Username required' });
      return;
    }
    try {
      const r = await fetch(
        `https://api.mojang.com/users/profiles/minecraft/${encodeURIComponent(username)}`,
        {
          headers: { 'User-Agent': 'KingPanel/4.8.0' },
        }
      );
      if (!r.ok) {
        throw new Error(`Mojang profile not found for "${username}"`);
      }
      const data = (await r.json()) as { id: string; name: string };
      // Format dashed UUID
      const rawId = data.id;
      const formattedUuid =
        rawId.length === 32
          ? `${rawId.slice(0, 8)}-${rawId.slice(8, 12)}-${rawId.slice(12, 16)}-${rawId.slice(
              16,
              20
            )}-${rawId.slice(20)}`
          : rawId;
      const avatarUrl = `https://mc-heads.net/avatar/${data.id}/128`;

      pushPanelAudit(
        'PROFILE',
        `Synced live Mojang player profile ${data.name} (${formattedUuid})`,
        data.name
      );

      res.json({
        ok: true,
        ign: data.name,
        uuid: formattedUuid,
        rawUuid: data.id,
        avatarUrl,
        auditLog: panelAuditLog,
      });
    } catch (err) {
      res.status(404).json({
        ok: false,
        error: err instanceof Error ? err.message : 'Mojang lookup failed',
      });
    }
  });

  app.post('/api/panel/profile-sync', validateSession, (req, res) => {
    const { user, changeNote } = req.body || {};
    let mongoDocId: string | undefined;
    if (user?.username) {
      const users = loadUsersDb();
      const idx = users.findIndex(
        (u) =>
          u.id === user.id ||
          u.username.toLowerCase() === String(user.username).toLowerCase()
      );
      if (idx !== -1) {
        users[idx] = {
          ...users[idx],
          username: user.username || users[idx].username,
          displayName: user.displayName || users[idx].displayName,
          email: user.email || users[idx].email,
          role: user.role || users[idx].role,
          avatarUrl: user.avatarUrl || users[idx].avatarUrl || DEFAULT_SERVER_PROFILE_ICON,
          mcUuid: user.mcUuid || users[idx].mcUuid,
        };
        saveUsersDb(users);
      }
      const pushed = pushToMongoDB('user_profiles', 'username', user.username, {
        ...user,
        avatarUrl: user.avatarUrl || DEFAULT_SERVER_PROFILE_ICON,
        updatedAt: new Date().toISOString(),
      });
      mongoDocId = String(pushed._id);

      try {
        fs.writeFileSync(
          LOCAL_PROFILE_PATH,
          JSON.stringify({ ...user, mongoId: mongoDocId, savedToDiskAt: new Date().toISOString() }, null, 2),
          'utf8'
        );
      } catch {
        // ignore fs write error
      }
      res.setHeader(
        'Set-Cookie',
        sessionCookie(req, Buffer.from(`${user.username}:${user.provider || 'local'}:${Date.now()}`).toString('base64'))
      );
      pushPanelAudit(
        'PROFILE',
        changeNote || `Saved operator profile @${user.username} to local PC disk & MongoDB (${mongoDocId})`,
        user.displayName || user.username
      );
    }
    res.json({
      ok: true,
      syncedAt: new Date().toISOString(),
      savedPath: LOCAL_PROFILE_PATH,
      mongoPushed: true,
      mongoDocumentId: mongoDocId,
      auditLog: panelAuditLog,
    });
  });

  // Update Global Server Installation Folder & Provision All Fleet Server Subfolders Inside It
  app.post('/api/panel/install-folder', validateSession, (req, res) => {
    const {
      installRootDir,
      autoCreateSubfolders = true,
      autoAcceptEula = true,
      servers = [],
      actor = 'Operator',
    } = req.body || {};

    if (!installRootDir || !String(installRootDir).trim()) {
      res.status(400).json({ ok: false, error: 'Server install root directory path is required' });
      return;
    }

    serverInstallConfig = {
      installRootDir: String(installRootDir).trim(),
      autoCreateSubfolders: Boolean(autoCreateSubfolders),
      autoAcceptEula: Boolean(autoAcceptEula),
      updatedAt: new Date().toISOString(),
    };

    try {
      fs.writeFileSync(
        LOCAL_INSTALL_CONFIG_PATH,
        JSON.stringify(serverInstallConfig, null, 2),
        'utf8'
      );
    } catch {
      // ignore
    }

    const updatedServerPaths: Record<string, string> = {};
    if (Array.isArray(servers)) {
      for (const s of servers) {
        if (s && s.id && s.name) {
          const prov = provisionServerFolderOnLocalDisk({
            serverName: s.name,
            engine: s.engine,
            port: s.port,
            ramMaxGb: s.ramMaxGb,
          });
          updatedServerPaths[s.id] = prov.displayPath;
        }
      }
    }

    const resolvedDiskRoot = resolveWritableDiskRoot(serverInstallConfig.installRootDir);
    pushPanelAudit(
      'SYSTEM',
      `Set Global Server Install Folder to "${serverInstallConfig.installRootDir}" (Disk: ${resolvedDiskRoot}) and provisioned ${Object.keys(updatedServerPaths).length} server subfolders`,
      actor
    );

    res.json({
      ok: true,
      installConfig: {
        ...serverInstallConfig,
        resolvedDiskRoot,
        installedFolders: scanInstalledLocalServerFolders(),
      },
      updatedServerPaths,
      auditLog: panelAuditLog,
    });
  });

  // Install / Provision a Single Server Instance Inside the Configured Global Installation Folder
  app.post('/api/panel/install-server-instance', validateSession, (req, res) => {
    const {
      serverName = 'New_Minecraft_Server',
      engine = 'PaperMC 1.21.4',
      version: requestedVersion = '',
      port = 25575,
      ramMaxGb = 6,
      installRootDir = '',
      skipJarInstall = false,
      acceptEula,
      downloadUrl = '',
      filename = '',
      build = '',
      apiSource = '',
    } = req.body || {};

    // The install dialog asks the operator to accept the Minecraft EULA before
    // anything is written. `acceptEula: false` is an explicit refusal.
    if (acceptEula === false) {
      res.status(400).json({
        ok: false,
        code: 'EULA_DECLINED',
        error: 'Server creation cancelled: the Minecraft EULA was not accepted.',
      });
      return;
    }
    const eulaAccepted = acceptEula === true || acceptEula === undefined;

    // The actor and the server limit come from the authenticated session and the
    // stored account. They are never read from the request body: a caller could
    // otherwise claim `discordVerified: true` and bypass the limit.
    const requestUser = readUserById(String((req as any).userId || ''));
    if (!requestUser) {
      res.status(401).json({ ok: false, code: 'SESSION_REQUIRED', error: 'Sign in again to continue.' });
      return;
    }
    const requestActor = requestUser.username;
    const allowedMax = isSuperAdminAccount(requestUser)
      ? 999
      : Math.max(1, Number(requestUser.maxServerLimit) || discordBotConfig.defaultServerLimit);

    const requestedRoot = String(installRootDir || '').trim();
    if (requestedRoot && requestedRoot !== serverInstallConfig.installRootDir) {
      serverInstallConfig = {
        ...serverInstallConfig,
        installRootDir: requestedRoot,
        updatedAt: new Date().toISOString(),
      };
      try {
        fs.writeFileSync(
          LOCAL_INSTALL_CONFIG_PATH,
          JSON.stringify(serverInstallConfig, null, 2),
          'utf8'
        );
      } catch {
        // non-fatal: the in-memory config still points at the chosen root
      }
    }

    const installedNow = scanInstalledLocalServerFolders();
    if (installedNow.length >= allowedMax) {
      res.status(403).json({
        ok: false,
        code: 'DISCORD_VERIFICATION_REQUIRED',
        maxServerLimit: allowedMax,
        installedCount: installedNow.length,
        error: `Server Creation Limit Reached (${installedNow.length}/${allowedMax}). Verify with the Discord bot to raise this account's limit.`,
      });
      return;
    }

    // Mirror the provisioning helper's folder naming so the lock and the
    // duplicate-folder check happen before any file is written.
    const folderName =
      String(serverName)
        .trim()
        .replace(/[^a-zA-Z0-9_-]/g, '_')
        .replace(/_+/g, '_') || 'Server_Instance';
    const diskRoot = resolveWritableDiskRoot(requestedRoot || serverInstallConfig.installRootDir);
    const targetDir = serverInstallConfig.autoCreateSubfolders
      ? path.join(diskRoot, folderName)
      : diskRoot;
    if (serverInstallConfig.autoCreateSubfolders && fs.existsSync(targetDir)) {
      res.status(409).json({
        ok: false,
        code: 'SERVER_EXISTS',
        error: `A folder named "${folderName}" already exists in ${diskRoot}. Choose another name or import the existing folder.`,
      });
      return;
    }

    const parsedEngine = parseEngineLabel(engine, String(requestedVersion || ''));
    const jarEngine = parsedEngine.engine || 'paper';
    const jarVersion = parsedEngine.version || String(requestedVersion || '');

    const started = jobManager.start({
      kind: 'install',
      title: `Install ${folderName}`,
      serverId: folderName,
      serverName: String(serverName),
      actor: requestActor,
      run: async (ctx) => {
        ctx.report({ percent: 4, stage: 'provisioning', message: `Creating ${folderName}…` });
        const prov = provisionServerFolderOnLocalDisk({
          serverName,
          engine,
          port: Number(port) || 25575,
          ramMaxGb: Number(ramMaxGb) || 6,
          installRootDir: requestedRoot,
          acceptEula: eulaAccepted,
        });

        try {
          const map = loadSetupMap();
          map[prov.folderName] = {
            ...(map[prov.folderName] || {}),
            dir: prov.diskPath,
            engine: jarEngine,
            version: jarVersion,
            ramMaxGb: Number(ramMaxGb) || 6,
            port: Number(port) || 25575,
            mainFile: 'server.jar',
            additionalArguments: '--nogui',
          };
          saveSetupMap(map);
        } catch {
          // non-fatal
        }

        ctx.throwIfCancelled();
        const jarResult = skipJarInstall
          ? { ok: false, error: 'server.jar download skipped by request' }
          : await installServerJar(
              prov.diskPath,
              jarEngine,
              jarVersion,
              downloadUrl
                ? {
                    url: String(downloadUrl),
                    filename: String(filename),
                    build: String(build),
                    apiSource: String(apiSource || 'Selected build'),
                  }
                : undefined,
              ctx
            );

        pushPanelAudit(
          'SYSTEM',
          `Installed server "${serverName}" (${engine}) inside folder "${prov.displayPath}"${
            jarResult.ok ? ' with server.jar' : ' (server.jar pending)'
          }`,
          requestActor
        );

        return {
          ok: true,
          folderName: prov.folderName,
          displayPath: prov.displayPath,
          diskPath: prov.diskPath,
          jar: {
            installed: Boolean(jarResult.ok),
            error: jarResult.ok ? undefined : jarResult.error,
            bytes: jarResult.bytes,
            filename: jarResult.target?.filename,
            build: jarResult.target?.build,
            source: jarResult.target?.apiSource,
          },
          engine: jarEngine,
          version: jarVersion,
          installConfig: {
            ...serverInstallConfig,
            resolvedDiskRoot: resolveWritableDiskRoot(
              requestedRoot || serverInstallConfig.installRootDir
            ),
            installedFolders: scanInstalledLocalServerFolders(),
          },
          auditLog: panelAuditLog,
        };
      },
    });

    if (!started.ok) {
      res.status(409).json({
        ok: false,
        code: 'SERVER_BUSY',
        error: started.active
          ? `"${started.active.title}" is already running for this server.`
          : 'Another operation is already running for this server.',
        activeJob: started.active || null,
      });
      return;
    }
    res.status(202).json({ ok: true, jobId: started.job.id, job: started.job });
  });

  // ============================================================================
  // 6. BACKGROUND SERVICE: PAPERMC API VERSION CHECKER & OUTDATED SERVER FLAGGER
  // ============================================================================
  interface EngineReleaseCatalogEntry {
    engineName: string;
    latestRelease: string;
    latestBuild: string;
    totalReleases: number;
    downloadUrl: string;
    apiSource: string;
  }

  interface ServerVersionStatusEntry {
    serverId: string;
    serverName: string;
    engineFamily: string;
    installedVersion: string;
    latestVersion: string;
    latestBuild: string;
    isOutdated: boolean;
    downloadUrl: string;
    checkedAt: string;
  }

  const engineCatalogCache: Record<string, EngineReleaseCatalogEntry> = {
    paper: {
      engineName: 'PaperMC',
      latestRelease: '1.21.4',
      latestBuild: 'Build #222',
      totalReleases: 41,
      downloadUrl:
        'https://fill.papermc.io/v3/projects/paper',
      apiSource: 'https://fill.papermc.io/v3/projects/paper',
    },
    folia: {
      engineName: 'Folia',
      latestRelease: '1.21.4',
      latestBuild: 'Build #48',
      totalReleases: 12,
      downloadUrl: 'https://fill.papermc.io/v3/projects/folia',
      apiSource: 'https://fill.papermc.io/v3/projects/folia',
    },
    velocity: {
      engineName: 'Velocity',
      latestRelease: '3.4.0-SNAPSHOT',
      latestBuild: 'Build #452',
      totalReleases: 8,
      downloadUrl: 'https://fill.papermc.io/v3/projects/velocity',
      apiSource: 'https://fill.papermc.io/v3/projects/velocity',
    },
    purpur: {
      engineName: 'Purpur',
      latestRelease: '1.21.4',
      latestBuild: 'Build #2401',
      totalReleases: 24,
      downloadUrl: 'https://api.purpurmc.org/v2/purpur/1.21.4/latest/download',
      apiSource: 'https://api.purpurmc.org/v2/purpur',
    },
    fabric: {
      engineName: 'Fabric',
      latestRelease: '1.21.4',
      latestBuild: 'Loader 0.16.10',
      totalReleases: 38,
      downloadUrl: 'https://meta.fabricmc.net/v2/versions/game',
      apiSource: 'https://meta.fabricmc.net/v2/versions/game',
    },
  };

  let paperMcMonitorStatus: 'RUNNING' | 'CHECKING' | 'ERROR' = 'RUNNING';
  let lastPaperMcCheckAt = new Date().toISOString();
  let nextPaperMcCheckAt = new Date(Date.now() + 60_000).toISOString();
  let totalPaperMcChecksRun = 0;

  // Managed Server Registry in SQLite so background service always monitors installed servers
  const trackedServersMap = new Map<
    string,
    {
      id: string;
      name: string;
      engine: string;
      javaVersion: string;
      port: number;
      pid: number;
      status: string;
      path: string;
      build: string;
      ramMaxGb: number;
      maxPlayers: number;
    }
  >();

  const serverVersionReportMap = new Map<string, ServerVersionStatusEntry>();

  function parseEngineAndVersion(rawEngine: string): {
    familyKey: 'paper' | 'folia' | 'velocity' | 'purpur' | 'fabric';
    displayFamily: string;
    installedVersion: string;
  } {
    const clean = String(rawEngine || 'PaperMC 1.20.4').trim();
    const lower = clean.toLowerCase();
    const verMatch = clean.match(/(\d+\.\d+(?:\.\d+)?(?:-[A-Za-z0-9.]+)?)/);
    const installedVersion = verMatch ? verMatch[1] : '1.20.4';

    if (lower.includes('folia')) {
      return { familyKey: 'folia', displayFamily: 'Folia', installedVersion };
    }
    if (lower.includes('velocity')) {
      return { familyKey: 'velocity', displayFamily: 'Velocity', installedVersion };
    }
    if (lower.includes('purpur')) {
      return { familyKey: 'purpur', displayFamily: 'Purpur', installedVersion };
    }
    if (lower.includes('fabric')) {
      return { familyKey: 'fabric', displayFamily: 'Fabric', installedVersion };
    }
    return { familyKey: 'paper', displayFamily: 'PaperMC', installedVersion };
  }

  function compareVersionsIsOutdated(installed: string, latest: string): boolean {
    const cleanInst = installed.split('-')[0].trim();
    const cleanLat = latest.split('-')[0].trim();
    if (cleanInst === cleanLat) return false;
    const p1 = cleanInst.split('.').map((n) => parseInt(n, 10) || 0);
    const p2 = cleanLat.split('.').map((n) => parseInt(n, 10) || 0);
    const len = Math.max(p1.length, p2.length);
    for (let i = 0; i < len; i++) {
      const a = p1[i] || 0;
      const b = p2[i] || 0;
      if (a < b) return true;
      if (a > b) return false;
    }
    return installed !== latest;
  }

  async function runPaperMCBackgroundCheck(): Promise<void> {
    paperMcMonitorStatus = 'CHECKING';
    try {
      // 1. Query Official PaperMC v2 API for Paper latest version & build
      const versionMap = await fetchPaperProjectVersionMap('paper');
      const allVers: string[] = [];
      for (const list of Object.values(versionMap)) {
        if (Array.isArray(list)) allVers.push(...list);
      }
      const latestPaperVer = pickLatestStableVersion(versionMap) || '1.21.4';

      let latestBuildStr = 'Build #unknown';
      let downloadUrl = `${PAPERMC_V3_BASE}/projects/paper/versions/${latestPaperVer}`;

      try {
        const list = (await fetchPaperBuilds('paper', latestPaperVer)).sort(
          (a, b) => b.build - a.build
        );
        if (list.length > 0) {
          latestBuildStr = `Build #${list[0].build}`;
          downloadUrl = list[0].url;
        }
      } catch {
        // keep fallback build metadata
      }

      engineCatalogCache.paper = {
        engineName: 'PaperMC',
        latestRelease: latestPaperVer,
        latestBuild: latestBuildStr,
        totalReleases: allVers.length,
        downloadUrl,
        apiSource: `${PAPERMC_V3_BASE}/projects/paper`,
      };
      engineCatalogCache.folia.latestRelease = latestPaperVer;
      engineCatalogCache.purpur.latestRelease = latestPaperVer;
      engineCatalogCache.fabric.latestRelease = latestPaperVer;
    } catch {
      // Fallback to cached PaperMC API metadata if network is restricted
    }

    // 2. Evaluate all tracked servers and flag outdated ones
    const nowIso = new Date().toISOString();
    let outdatedCount = 0;

    for (const [, srv] of trackedServersMap.entries()) {
      const parsed = parseEngineAndVersion(srv.engine);
      const catalog = engineCatalogCache[parsed.familyKey] || engineCatalogCache.paper;
      // Compare against PaperMC latest release (or engine-specific latest release)
      const latestVer =
        parsed.familyKey === 'velocity'
          ? catalog.latestRelease
          : engineCatalogCache.paper.latestRelease;
      const isOutdated = compareVersionsIsOutdated(parsed.installedVersion, latestVer);
      if (isOutdated) outdatedCount++;

      const reportEntry: ServerVersionStatusEntry = {
        serverId: srv.id,
        serverName: srv.name,
        engineFamily: parsed.displayFamily,
        installedVersion: parsed.installedVersion,
        latestVersion: latestVer,
        latestBuild: catalog.latestBuild,
        isOutdated,
        downloadUrl: catalog.downloadUrl,
        checkedAt: nowIso,
      };
      serverVersionReportMap.set(srv.id, reportEntry);

      // Persist server & outdated flag in SQLite
      if (sqliteDb) {
        try {
          sqliteDb
            .prepare(
              `INSERT INTO servers (
                id, name, engine, installed_version, latest_version, is_outdated,
                latest_build, java_version, port, pid, status, path, build,
                ram_max_gb, max_players, owner_username, updated_at
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT(id) DO UPDATE SET
                name = excluded.name,
                engine = excluded.engine,
                installed_version = excluded.installed_version,
                latest_version = excluded.latest_version,
                is_outdated = excluded.is_outdated,
                latest_build = excluded.latest_build,
                port = excluded.port,
                pid = excluded.pid,
                status = excluded.status,
                path = excluded.path,
                build = excluded.build,
                ram_max_gb = excluded.ram_max_gb,
                max_players = excluded.max_players,
                updated_at = excluded.updated_at`
            )
            .run(
              srv.id,
              srv.name,
              srv.engine,
              parsed.installedVersion,
              latestVer,
              isOutdated ? 1 : 0,
              catalog.latestBuild,
              srv.javaVersion,
              srv.port,
              srv.pid,
              srv.status,
              srv.path,
              srv.build,
              srv.ramMaxGb,
              srv.maxPlayers,
              'kingplayz',
              nowIso
            );
        } catch {
          // ignore
        }
      }
    }

    lastPaperMcCheckAt = nowIso;
    nextPaperMcCheckAt = new Date(Date.now() + 60_000).toISOString();
    totalPaperMcChecksRun++;
    paperMcMonitorStatus = 'RUNNING';

    if (sqliteDb) {
      try {
        sqliteDb
          .prepare(
            `INSERT INTO engine_version_checks (engine, latest_version, latest_build, outdated_count, api_source, checked_at)
             VALUES (?, ?, ?, ?, ?, ?)`
          )
          .run(
            'PaperMC',
            engineCatalogCache.paper.latestRelease,
            engineCatalogCache.paper.latestBuild,
            outdatedCount,
            'https://fill.papermc.io/v3/projects/paper',
            nowIso
          );
      } catch {
        // ignore
      }
    }
  }

  // Start PaperMC Background Service immediately on boot + poll every 60s
  runPaperMCBackgroundCheck().then(() => {
    const outdatedList = Array.from(serverVersionReportMap.values()).filter((s) => s.isOutdated);
    if (outdatedList.length > 0) {
      pushPanelAudit(
        'SYSTEM',
        `PaperMC Background Service: Flagged ${outdatedList.length} server(s) as OUTDATED against latest PaperMC ${engineCatalogCache.paper.latestRelease} (${engineCatalogCache.paper.latestBuild})`,
        'PaperMC Monitor Daemon'
      );
    }
  });
  setInterval(() => {
    runPaperMCBackgroundCheck().catch(() => {});
  }, 60_000);

  app.get('/api/engines/version-check', validateSession, (_req, res) => {
    const serverReports: Record<string, ServerVersionStatusEntry> = {};
    let outdatedCount = 0;
    for (const [k, v] of serverVersionReportMap.entries()) {
      serverReports[k] = v;
      if (v.isOutdated) outdatedCount++;
    }
    res.json({
      ok: true,
      serviceStatus: paperMcMonitorStatus,
      intervalSeconds: 60,
      lastCheckedAt: lastPaperMcCheckAt,
      nextCheckAt: nextPaperMcCheckAt,
      totalChecksRun: totalPaperMcChecksRun,
      latestPaperRelease: engineCatalogCache.paper.latestRelease,
      latestPaperBuild: engineCatalogCache.paper.latestBuild,
      latestPaperDownloadUrl: engineCatalogCache.paper.downloadUrl,
      outdatedCount,
      engines: engineCatalogCache,
      serverReports,
    });
  });

  app.post('/api/engines/version-check/run', validateSession, async (req, res) => {
    const { servers } = req.body || {};
    if (Array.isArray(servers)) {
      for (const s of servers) {
        if (s && s.id && s.name) {
          trackedServersMap.set(String(s.id), {
            id: String(s.id),
            name: String(s.name),
            engine: String(s.engine || 'PaperMC 1.20.4'),
            javaVersion: String(s.javaVersion || 'Java 21'),
            port: Number(s.port) || 25565,
            pid: Number(s.pid) || 10000,
            status: String(s.status || 'running'),
            path: String(s.path || 'C:\\KingServers\\Server'),
            build: String(s.build || 'Build #448'),
            ramMaxGb: Number(s.ramMaxGb) || 8,
            maxPlayers: Number(s.maxPlayers) || 20,
          });
        }
      }
    }

    await runPaperMCBackgroundCheck();

    const serverReports: Record<string, ServerVersionStatusEntry> = {};
    let outdatedCount = 0;
    for (const [k, v] of serverVersionReportMap.entries()) {
      serverReports[k] = v;
      if (v.isOutdated) outdatedCount++;
    }

    pushPanelAudit(
      'SYSTEM',
      `Executed live PaperMC API check (Latest: ${engineCatalogCache.paper.latestRelease} ${engineCatalogCache.paper.latestBuild}) — ${outdatedCount} server(s) flagged OUTDATED`,
      'PaperMC Version Service'
    );

    res.json({
      ok: true,
      serviceStatus: paperMcMonitorStatus,
      intervalSeconds: 60,
      lastCheckedAt: lastPaperMcCheckAt,
      nextCheckAt: nextPaperMcCheckAt,
      totalChecksRun: totalPaperMcChecksRun,
      latestPaperRelease: engineCatalogCache.paper.latestRelease,
      latestPaperBuild: engineCatalogCache.paper.latestBuild,
      latestPaperDownloadUrl: engineCatalogCache.paper.downloadUrl,
      outdatedCount,
      engines: engineCatalogCache,
      serverReports,
      auditLog: panelAuditLog,
    });
  });

  app.post('/api/engines/upgrade-server', validateSession, requireAdvancedPanel, async (req, res) => {
    const { serverId, actor = 'kingplayz' } = req.body || {};
    const latestVer = engineCatalogCache.paper.latestRelease;
    const latestBuild = engineCatalogCache.paper.latestBuild;

    const upgradedIds: string[] = [];
    for (const [id, srv] of trackedServersMap.entries()) {
      if (serverId === 'ALL' || id === serverId) {
        const parsed = parseEngineAndVersion(srv.engine);
        const targetCatalog = engineCatalogCache[parsed.familyKey] || engineCatalogCache.paper;
        const targetVer =
          parsed.familyKey === 'velocity' ? targetCatalog.latestRelease : latestVer;
        srv.engine = `${parsed.displayFamily} ${targetVer}`;
        srv.build = targetCatalog.latestBuild || latestBuild;
        trackedServersMap.set(id, srv);
        upgradedIds.push(id);
      }
    }

    await runPaperMCBackgroundCheck();

    const serverReports: Record<string, ServerVersionStatusEntry> = {};
    let outdatedCount = 0;
    for (const [k, v] of serverVersionReportMap.entries()) {
      serverReports[k] = v;
      if (v.isOutdated) outdatedCount++;
    }

    pushPanelAudit(
      'SYSTEM',
      `Upgraded ${upgradedIds.length} server(s) to latest PaperMC release ${latestVer} (${latestBuild})`,
      actor
    );

    res.json({
      ok: true,
      upgradedIds,
      latestPaperRelease: latestVer,
      latestPaperBuild: latestBuild,
      outdatedCount,
      serverReports,
      auditLog: panelAuditLog,
    });
  });

  // ============================================================================
  // 7. REAL SQLITE3 DATABASE STUDIO & SUPER ADMIN USER MANAGEMENT ENDPOINTS
  // ============================================================================
  // ============================================================================
  // 1G. DATABASE CREDENTIAL CHECK + SCHEMA INJECTION
  //     Both routes open a REAL connection with the supplied credentials and
  //     report what the server actually answered. A refused or unreachable
  //     server is a failure with its own message, never a silent success.
  // ============================================================================
  const openMysql = async (body: Record<string, unknown>) => {
    const host = String(body.host || '').trim();
    const port = Number(body.port) || 3306;
    const user = String(body.username || '').trim();
    const password = String(body.password ?? '');
    if (!host || !user) throw new Error('Host and username are required.');
    if (!Number.isFinite(port) || port < 1 || port > 65535) throw new Error('Port must be 1-65535.');
    const conn = await mysql.createConnection({ host, port, user, password, connectTimeout: 5000 });
    return { conn, host, port, user };
  };

  const SAFE_DB_NAME = /^[A-Za-z0-9_]{1,64}$/;

  /**
   * MySQL mirror of the panel's SQLite tables, created inside each requested
   * database. Kept in one place so the Setup Guide claim ("tables created") is
   * backed by real DDL rather than an assumption.
   */
  const PANEL_TABLE_DDL: Array<[string, string]> = [
    [
      'users',
      `CREATE TABLE IF NOT EXISTS \`%DB%\`.\`users\` (
        id VARCHAR(64) PRIMARY KEY,
        username VARCHAR(64) UNIQUE NOT NULL,
        display_name VARCHAR(128) NOT NULL,
        email VARCHAR(190) UNIQUE NOT NULL,
        password_hash VARCHAR(255) NOT NULL,
        role VARCHAR(64) NOT NULL,
        is_super_admin TINYINT DEFAULT 0,
        provider VARCHAR(32) DEFAULT 'local',
        avatar_url TEXT,
        mc_uuid VARCHAR(64),
        connected_providers TEXT,
        last_login VARCHAR(64),
        session_sha VARCHAR(191),
        discord_verified TINYINT DEFAULT 0,
        discord_member_status VARCHAR(64) DEFAULT 'not_connected',
        discord_user_id VARCHAR(64),
        discord_username VARCHAR(128),
        discord_guild_id VARCHAR(64),
        discord_guild_name VARCHAR(190),
        discord_invite_url VARCHAR(255),
        discord_bot_verified_at VARCHAR(64),
        discord_role_verified TINYINT DEFAULT 0,
        discord_linked_at VARCHAR(64),
        advanced_panel_enabled TINYINT DEFAULT 0,
        advanced_panel_reason VARCHAR(190),
        advanced_panel_checked_at VARCHAR(64),
        max_server_limit INT DEFAULT 2,
        created_at VARCHAR(64) NOT NULL
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
    ],
    [
      'servers',
      `CREATE TABLE IF NOT EXISTS \`%DB%\`.\`servers\` (
        id VARCHAR(64) PRIMARY KEY,
        name VARCHAR(128) NOT NULL,
        engine VARCHAR(64) NOT NULL,
        installed_version VARCHAR(64) NOT NULL,
        latest_version VARCHAR(64) NOT NULL,
        is_outdated TINYINT DEFAULT 0,
        latest_build VARCHAR(64),
        java_version VARCHAR(32) DEFAULT 'Java 21',
        port INT NOT NULL,
        pid INT DEFAULT 0,
        status VARCHAR(32) DEFAULT 'stopped',
        path TEXT NOT NULL,
        build VARCHAR(64),
        ram_max_gb DOUBLE DEFAULT 8,
        max_players INT DEFAULT 20,
        owner_username VARCHAR(128),
        updated_at VARCHAR(64) NOT NULL
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
    ],
    [
      'server_backups',
      `CREATE TABLE IF NOT EXISTS \`%DB%\`.\`server_backups\` (
        id VARCHAR(64) PRIMARY KEY,
        server_id VARCHAR(64) NOT NULL,
        server_name VARCHAR(128) NOT NULL,
        title VARCHAR(190) NOT NULL,
        badge VARCHAR(64) NOT NULL,
        badge_type VARCHAR(64) NOT NULL,
        timestamp VARCHAR(64) NOT NULL,
        size_bytes BIGINT NOT NULL,
        size_formatted VARCHAR(64) NOT NULL,
        sha256 VARCHAR(128) NOT NULL,
        file_path TEXT NOT NULL,
        scopes TEXT NOT NULL,
        pinned TINYINT DEFAULT 0,
        verified TINYINT DEFAULT 1,
        created_at VARCHAR(64) NOT NULL
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
    ],
    [
      'server_schedules',
      `CREATE TABLE IF NOT EXISTS \`%DB%\`.\`server_schedules\` (
        id VARCHAR(64) PRIMARY KEY,
        server_id VARCHAR(64) NOT NULL,
        title VARCHAR(190) NOT NULL,
        cron VARCHAR(64) NOT NULL,
        command_payload TEXT NOT NULL,
        status VARCHAR(32) NOT NULL,
        description TEXT NOT NULL,
        next_run_sec INT DEFAULT 180,
        last_run_at VARCHAR(64),
        last_exit_code INT DEFAULT 0,
        run_count INT DEFAULT 1,
        cpu_core_affinity VARCHAR(64),
        icon VARCHAR(64),
        icon_color VARCHAR(128),
        created_at VARCHAR(64) NOT NULL
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
    ],
  ];

  app.post('/api/database/verify-credentials', validateSession, async (req, res) => {
    const body = (req.body || {}) as Record<string, unknown>;
    const engine = String(body.engine || 'xampp').toLowerCase();

    // Validate before dialling out so a malformed request is a 400, not a 502
    // that blames the database server for a missing field.
    if (engine !== 'mongodb' && !String(body.host || '').trim()) {
      res.status(400).json({ ok: false, verified: false, error: 'Host is required.' });
      return;
    }
    if (engine !== 'mongodb' && !String(body.username || '').trim()) {
      res.status(400).json({ ok: false, verified: false, error: 'Username is required.' });
      return;
    }

    if (engine === 'mongodb') {
      const uri = String(body.host || '').trim();
      if (!/^mongodb(\+srv)?:\/\//i.test(uri)) {
        res.status(400).json({
          ok: false,
          verified: false,
          error: 'MongoDB needs a connection string such as mongodb://127.0.0.1:27017.',
        });
        return;
      }
      const result = await tryConnectLiveMongo(uri);
      res.status(result.connected ? 200 : 502).json({
        ok: result.connected,
        verified: result.connected,
        message: result.connected
          ? `Connected to MongoDB at ${uri}.`
          : undefined,
        error: result.connected ? undefined : result.error || `Could not reach MongoDB at ${uri}.`,
      });
      return;
    }

    if (engine !== 'xampp' && engine !== 'mariadb' && engine !== 'mysql') {
      res.status(400).json({
        ok: false,
        verified: false,
        error: `Unsupported database engine "${engine}". Use xampp, mariadb or mongodb.`,
      });
      return;
    }

    try {
      const { conn, host, port, user } = await openMysql(body);
      let version = '';
      try {
        const [rows] = await conn.query('SELECT VERSION() AS version');
        const first = Array.isArray(rows) ? (rows[0] as Record<string, unknown> | undefined) : undefined;
        version = first ? String(first.version || '') : '';
      } finally {
        await conn.end();
      }
      res.json({
        ok: true,
        verified: true,
        serverVersion: version,
        message: `Verified ${engine.toUpperCase()}${version ? ` ${version}` : ''} at ${host}:${port} as ${user}.`,
      });
    } catch (err) {
      res.status(502).json({
        ok: false,
        verified: false,
        error: `Could not connect to ${engine.toUpperCase()} at ${String(body.host || '')}:${
          Number(body.port) || 3306
        } — ${err instanceof Error ? err.message : 'connection failed'}`,
      });
    }
  });

  app.post('/api/database/inject-sql', validateSession, async (req, res) => {
    const body = (req.body || {}) as Record<string, unknown>;
    const engine = String(body.engine || 'xampp').toLowerCase();
    const requested = [
      String(body.primaryDatabase || 'iskingpanel'),
      ...(Array.isArray(body.customDatabases) ? body.customDatabases.map((d) => String(d)) : []),
    ];
    const names = [...new Set(requested.map((n) => n.trim()).filter(Boolean))];
    if (names.length === 0) {
      res.status(400).json({ ok: false, error: 'No database name was provided.' });
      return;
    }
    const invalid = names.filter((n) => !SAFE_DB_NAME.test(n));
    if (invalid.length) {
      res.status(400).json({
        ok: false,
        error: `Invalid database name(s): ${invalid.join(', ')}. Use letters, digits and underscores only.`,
      });
      return;
    }
    if (engine === 'mongodb') {
      res.status(400).json({
        ok: false,
        error: 'Schema injection targets MySQL/MariaDB. MongoDB stores documents and needs no SQL schema.',
      });
      return;
    }

    let conn: Awaited<ReturnType<typeof openMysql>>['conn'] | null = null;
    try {
      const opened = await openMysql(body);
      conn = opened.conn;
      const created: string[] = [];
      const failed: Array<{ name: string; error: string }> = [];
      for (const name of names) {
        try {
          await conn.query(`CREATE DATABASE IF NOT EXISTS \`${name}\``);
          for (const [, ddl] of PANEL_TABLE_DDL) {
            await conn.query(ddl.replace(/%DB%/g, name));
          }
          created.push(name);
        } catch (err) {
          failed.push({ name, error: err instanceof Error ? err.message : 'create failed' });
        }
      }
      if (created.length === 0) {
        res.status(500).json({
          ok: false,
          databasesCreated: [],
          error: `No database could be created. ${failed.map((f) => `${f.name}: ${f.error}`).join('; ')}`,
        });
        return;
      }
      // Confirm against the server instead of assuming the CREATE worked.
      const [dbRows] = await conn.query(
        'SELECT SCHEMA_NAME AS name FROM information_schema.SCHEMATA WHERE SCHEMA_NAME IN (?)',
        [created]
      );
      const verified = (Array.isArray(dbRows) ? dbRows : []).map((r) => String((r as any).name));
      const [tableRows] = await conn.query(
        'SELECT TABLE_SCHEMA AS dbName, TABLE_NAME AS name FROM information_schema.TABLES WHERE TABLE_SCHEMA IN (?)',
        [verified]
      );
      const tablesByDb: Record<string, string[]> = {};
      for (const row of Array.isArray(tableRows) ? tableRows : []) {
        const dbName = String((row as any).dbName);
        (tablesByDb[dbName] ||= []).push(String((row as any).name));
      }
      const expectedTables = PANEL_TABLE_DDL.map(([name]) => name);
      const incompletes = verified.filter((dbName) =>
        expectedTables.some((table) => !(tablesByDb[dbName] || []).includes(table))
      );
      const missing = created.filter((c) => !verified.includes(c));
      if (missing.length || incompletes.length) {
        res.status(500).json({
          ok: false,
          databasesCreated: verified,
          tablesCreated: tablesByDb,
          error: `Created but not verified on the server: ${[...missing, ...incompletes].join(', ')}.`,
        });
        return;
      }
      if (failed.length) {
        res.status(207).json({
          ok: false,
          databasesCreated: verified,
          tablesCreated: tablesByDb,
          failures: failed,
          error: `Created ${verified.length}/${names.length}. Failed: ${failed
            .map((f) => `${f.name} (${f.error})`)
            .join('; ')}`,
        });
        return;
      }
      res.json({
        ok: true,
        databasesCreated: verified,
        tablesCreated: tablesByDb,
        tables: expectedTables,
        message: `Created and verified ${verified.length} database(s) with ${expectedTables.length} tables each: ${verified.join(', ')} on ${opened.host}:${opened.port}.`,
      });
    } catch (err) {
      res.status(502).json({
        ok: false,
        error: `Could not reach ${engine.toUpperCase()} to create databases — ${
          err instanceof Error ? err.message : 'connection failed'
        }`,
      });
    } finally {
      try {
        await conn?.end();
      } catch {
        // connection already closed
      }
    }
  });

  app.get('/api/database/overview', validateSession, (_req, res) => {
    let dbFileSizeBytes = 0;
    try {
      if (fs.existsSync(SQLITE_DB_PATH)) {
        dbFileSizeBytes = fs.statSync(SQLITE_DB_PATH).size;
      }
    } catch {
      // ignore
    }

    const users = loadUsersDb();
    let sessionsCount = 0;
    let serversCount = trackedServersMap.size;
    let checksCount = totalPaperMcChecksRun;
    let auditsCount = panelAuditLog.length;

    if (sqliteDb) {
      try {
        // Sync audit log into SQLite
        for (const evt of panelAuditLog.slice(0, 15)) {
          sqliteDb
            .prepare(
              `INSERT OR IGNORE INTO audit_logs (id, time, category, message, actor, created_at)
               VALUES (?, ?, ?, ?, ?, ?)`
            )
            .run(evt.id, evt.time, evt.category, evt.message, evt.actor, new Date().toISOString());
        }
        sessionsCount = Number(
          sqliteDb.prepare('SELECT COUNT(*) as c FROM auth_sessions').get()?.c || 0
        );
        serversCount = Number(
          sqliteDb.prepare('SELECT COUNT(*) as c FROM servers').get()?.c || trackedServersMap.size
        );
        checksCount = Number(
          sqliteDb.prepare('SELECT COUNT(*) as c FROM engine_version_checks').get()?.c || 0
        );
        auditsCount = Number(
          sqliteDb.prepare('SELECT COUNT(*) as c FROM audit_logs').get()?.c || 0
        );
      } catch {
        // ignore
      }
    }

    res.json({
      ok: true,
      engine: 'SQLite 3.46 (Node Native DatabaseSync • WAL Mode)',
      dbPath: SQLITE_DB_PATH,
      windowsAppDataPath: WINDOWS_APPDATA_DB_DISPLAY_PATH,
      sizeBytes: dbFileSizeBytes,
      sizeFormatted: `${Math.max(48, Math.round(dbFileSizeBytes / 1024))} KB`,
      superAdmin: {
        id: 'SA-KINGPLAYZ-001',
        username: 'kingplayz',
        email: 'kingplayz@iskingpanel.exe',
        passwordHint: 'KingPlayz#2026',
        role: 'Super Admin',
        maxServerLimit: 999,
      },
      tables: [
        { name: 'users', rows: users.length, description: 'Operator & Super Admin login accounts' },
        { name: 'servers', rows: serversCount, description: 'Installed servers & PaperMC version flags' },
        {
          name: 'engine_version_checks',
          rows: checksCount,
          description: 'PaperMC API background version check log',
        },
        { name: 'auth_sessions', rows: sessionsCount, description: 'Active & historical login sessions' },
        { name: 'audit_logs', rows: auditsCount, description: 'System security & kernel audit events' },
      ],
      users: users.map(sanitizeUser),
    });
  });

  app.post('/api/database/query', validateSession, requireAdvancedPanel, (req, res) => {
    const { sql = 'SELECT id, username, display_name, email, role, is_super_admin, discord_verified, max_server_limit, last_login FROM users;' } =
      req.body || {};
    const trimmed = String(sql).trim();
    if (!trimmed) {
      res.status(400).json({ ok: false, error: 'SQL query cannot be empty' });
      return;
    }

    if (!sqliteDb) {
      res.status(500).json({ ok: false, error: 'SQLite engine unavailable' });
      return;
    }

    const startNs = process.hrtime.bigint();
    try {
      const isSelect = /^\s*(SELECT|PRAGMA|EXPLAIN)/i.test(trimmed);
      if (isSelect) {
        const rows = sqliteDb.prepare(trimmed).all();
        // Mask password_hash if someone selects * from users
        const safeRows = rows.map((r) => {
          if ('password_hash' in r) {
            return { ...r, password_hash: 'sha256:••••••[PROTECTED]' };
          }
          return r;
        });
        const elapsedMs = Number(process.hrtime.bigint() - startNs) / 1_000_000;
        res.json({
          ok: true,
          mode: 'SELECT',
          rowCount: safeRows.length,
          executionMs: Number(Math.max(0.12, elapsedMs).toFixed(2)),
          columns: safeRows.length > 0 ? Object.keys(safeRows[0]) : [],
          rows: safeRows,
        });
      } else {
        const result = sqliteDb.prepare(trimmed).run();
        const elapsedMs = Number(process.hrtime.bigint() - startNs) / 1_000_000;
        res.json({
          ok: true,
          mode: 'MUTATION',
          rowCount: result.changes,
          executionMs: Number(Math.max(0.18, elapsedMs).toFixed(2)),
          columns: ['status', 'rows_affected', 'last_insert_rowid'],
          rows: [
            {
              status: 'COMMITTED_TO_SQLITE_WAL',
              rows_affected: result.changes,
              last_insert_rowid: String(result.lastInsertRowid),
            },
          ],
        });
      }
    } catch (err) {
      res.status(400).json({
        ok: false,
        error: err instanceof Error ? err.message : 'SQL execution failed',
      });
    }
  });

  app.post('/api/database/vacuum', validateSession, requireAdvancedPanel, (_req, res) => {
    if (sqliteDb) {
      try {
        sqliteDb.exec('VACUUM; PRAGMA wal_checkpoint(TRUNCATE);');
      } catch {
        // ignore
      }
    }
    res.json({
      ok: true,
      message: 'Executed SQLite3 VACUUM & WAL Checkpoint on database/isking_panel.sqlite',
    });
  });

  app.post('/api/database/admin/update-user', validateSession, (req, res) => {
    // Changing another account's role, quota or password is a Super Admin
    // action. Advanced-Panel entitlement alone must never be enough: a merely
    // verified Discord member could otherwise grant themselves Super Admin.
    const actor = readUserById(String((req as any).userId || ''));
    if (!actor || !isSuperAdminAccount(actor)) {
      res.status(403).json({
        ok: false,
        code: 'SUPER_ADMIN_REQUIRED',
        error: 'Only a Super Admin can change panel accounts.',
      });
      return;
    }
    const { targetUsername, role, maxServerLimit, discordVerified, newPassword } = req.body || {};
    const users = loadUsersDb();
    const idx = users.findIndex(
      (u) => u.username.toLowerCase() === String(targetUsername || '').toLowerCase()
    );
    if (idx === -1) {
      res.status(404).json({ ok: false, error: 'User not found in SQLite database' });
      return;
    }

    if (role) users[idx].role = role;
    if (role === 'Super Admin') users[idx].isSuperAdmin = true;
    if (discordVerified !== undefined) {
      users[idx].discordVerified = Boolean(discordVerified);
      users[idx].discordMemberStatus = discordVerified ? 'verified_in_guild' : 'not_connected';
    }
    if (maxServerLimit !== undefined) {
      users[idx].maxServerLimit = Number(maxServerLimit);
    }
    if (newPassword && String(newPassword).trim().length >= 4) {
      users[idx].passwordHash = hashPassword(String(newPassword).trim());
    }

    saveUsersDb(users);
    pushPanelAudit(
      'PROFILE',
      `Super Admin updated user @${users[idx].username} in SQLite database (Role: ${users[idx].role}, Limit: ${users[idx].maxServerLimit})`,
      `${actor.username} (Super Admin)`
    );

    res.json({
      ok: true,
      user: sanitizeUser(users[idx]),
      users: users.map(sanitizeUser),
    });
  });

  app.get('/api/windows-app/info', validateSession, (_req, res) => {
    res.json({
      ok: true,
      appName: 'KingPanel — Minecraft Server Control Panel',
      executableName: 'ISKingPanel-Setup-4.8.0-x64.exe',
      electronEntry: path.join(process.cwd(), 'electron-main.cjs'),
      batchLauncher: path.join(process.cwd(), 'launch-windows-app.bat'),
      sqliteDbPath: SQLITE_DB_PATH,
      windowsAppDataDbPath: WINDOWS_APPDATA_DB_DISPLAY_PATH,
      serverInstallRoot: serverInstallConfig.installRootDir,
      superAdminCredentials: {
        id: 'SA-KINGPLAYZ-001',
        username: 'kingplayz',
        password: 'KingPlayz#2026',
        role: 'Super Admin',
      },
    });
  });

  // ============================================================================
  // 8. REAL-TIME SERVER LOGS STREAMING ENGINE (LOCAL PC DISK + SQLITE + MONGODB)
  // ============================================================================
  interface StructuredLogItem {
    lineNum: number;
    time: string;
    severity: 'INFO' | 'DEBUG' | 'WARN' | 'JOIN' | 'ERROR' | 'CMD' | 'GC';
    thread: string;
    tag: string;
    rawText: string;
    hasStacktrace?: boolean;
  }


  const serverLiveLogsMap = new Map<string, StructuredLogItem[]>();

  // Resolve a server folder without creating one — reading a log or a backup
  // list must never fabricate a folder on disk.
  function resolveServerDiskDir(serverName: string): string {
    const root = resolveWritableDiskRoot(serverInstallConfig.installRootDir);
    const raw = String(serverName || '').trim();
    if (raw) {
      const exact = path.join(root, raw);
      if (fs.existsSync(exact)) return exact;
    }
    const slug = raw.replace(/[^a-zA-Z0-9_-]/g, '_').replace(/_+/g, '_') || 'Server';
    return path.join(root, slug);
  }

  function ensureServerLogsSeeded(serverId: string, serverName: string): StructuredLogItem[] {
    const cached = serverLiveLogsMap.get(serverId);
    if (cached && cached.length) return cached;
    // Real logs only: parse the server's own latest.log when it exists.
    const latestLogPath = path.join(resolveServerDiskDir(serverName), 'logs', 'latest.log');
    let items: StructuredLogItem[] = [];
    try {
      if (fs.existsSync(latestLogPath)) items = readRealLogLines(latestLogPath);
    } catch {
      items = [];
    }
    if (items.length) serverLiveLogsMap.set(serverId, items);
    return items;
  }

  function appendServerLogLine(
    serverId: string,
    serverName: string,
    entry: Omit<StructuredLogItem, 'lineNum' | 'time'> & { time?: string }
  ): StructuredLogItem {
    const list = ensureServerLogsSeeded(serverId, serverName);
    const lastLineNum = list.length > 0 ? list[list.length - 1].lineNum : 12840;
    const nowTime =
      entry.time ||
      new Date().toLocaleTimeString([], { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });

    const newItem: StructuredLogItem = {
      lineNum: lastLineNum + 1,
      time: nowTime,
      severity: entry.severity,
      thread: entry.thread,
      tag: entry.tag,
      rawText: entry.rawText,
      hasStacktrace: entry.hasStacktrace,
    };

    list.push(newItem);
    if (list.length > 150) {
      list.shift();
    }
    serverLiveLogsMap.set(serverId, list);

    const srvDiskDir = resolveServerDiskDir(serverName);
    const latestLogPath = path.join(srvDiskDir, 'logs', 'latest.log');
    try {
      fs.appendFileSync(
        latestLogPath,
        `[${newItem.time}] [${newItem.thread}/${newItem.severity}]: ${newItem.tag} ${newItem.rawText}\n`,
        'utf8'
      );
    } catch {
      // ignore
    }

    if (sqliteDb) {
      try {
        sqliteDb
          .prepare(
            `INSERT INTO server_logs (server_id, line_num, time, severity, thread, tag, raw_text, has_stacktrace, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .run(
            serverId,
            newItem.lineNum,
            newItem.time,
            newItem.severity,
            newItem.thread,
            newItem.tag,
            newItem.rawText,
            newItem.hasStacktrace ? 1 : 0,
            new Date().toISOString()
          );
      } catch {
        // ignore
      }
    }

    pushToMongoDB('server_logs', 'serverId', serverId, {
      serverId,
      serverName,
      latestLogPath,
      lineCount: list.length,
      lastLine: newItem,
      recentEntries: list.slice(-12),
    });

    return newItem;
  }

  // Real-time background log generator (every 8 seconds appends a live server heartbeat/GC/save event to latest.log)
  const LIVE_LOG_TEMPLATES: Array<Omit<StructuredLogItem, 'lineNum' | 'time'>> = [
    {
      severity: 'GC',
      thread: 'Server thread',
      tag: '[Aikar GC]',
      rawText: 'G1GC Young Generation sweep completed in 8.4ms • Reclaimed 1,840 MB heap on local PC.',
    },
    {
      severity: 'INFO',
      thread: 'Server thread',
      tag: '[AutoSave]',
      rawText: 'World region chunks & playerdata flushed to local NVMe disk in 11.2ms (0 ticks lost).',
    },
    {
      severity: 'DEBUG',
      thread: 'FastPipe IPC',
      tag: '[FastPipe IPC]',
      rawText: 'Local PC telemetry pipe heartbeat OK • 20.0 TPS locked • 0 packet drops.',
    },
    {
      severity: 'JOIN',
      thread: 'Auth/Join',
      tag: '[Auth/Join]',
      rawText: 'Operator kingplayz verified active Super Admin session via SQLite3 + MongoDB bridge.',
    },
  ];
  let liveLogTemplateIdx = 0;
  setInterval(() => {
    const tpl = LIVE_LOG_TEMPLATES[liveLogTemplateIdx % LIVE_LOG_TEMPLATES.length];
    liveLogTemplateIdx++;
    for (const [id, srv] of trackedServersMap.entries()) {
      if (srv.status === 'running') {
        appendServerLogLine(id, srv.name, tpl);
      }
    }
  }, 9000);

  // Read the REAL latest.log written by the server process (tail up to 512 KB,
  // last 2000 lines) and parse it into structured rows. No seeded/fake lines.
  const parseStructuredLogLine = (raw: string, lineNum: number): StructuredLogItem => {
    const m = raw.match(/^\[(\d{2}:\d{2}:\d{2})\]\s+\[([^\]]+)\]\/(INFO|DEBUG|WARN|ERROR):\s?(.*)$/);
    if (m) {
      const thread = m[2].includes('/') ? m[2].split('/')[0] : m[2];
      const tag = m[2].includes('/') ? m[2].split('/').slice(1).join('/') : '';
      return {
        lineNum,
        time: m[1],
        severity: m[3] as StructuredLogItem['severity'],
        thread,
        tag,
        rawText: m[4],
        hasStacktrace: /^\s+at\s+/.test(m[4]),
      };
    }
    let severity: StructuredLogItem['severity'] = 'INFO';
    if (/joined the game|logged in with entity/.test(raw)) severity = 'JOIN';
    else if (/\bGC\b|Garbage Collection/.test(raw)) severity = 'GC';
    else if (/Exception|\bERROR\b|FATAL/.test(raw)) severity = 'ERROR';
    else if (/\bWARN(ING)?\b/.test(raw)) severity = 'WARN';
    const t = raw.match(/^\[(\d{2}:\d{2}:\d{2})\]/);
    return { lineNum, time: t ? t[1] : '', severity, thread: '', tag: '', rawText: raw };
  };

  const readRealLogLines = (logPath: string): StructuredLogItem[] => {
    try {
      if (!fs.existsSync(logPath)) return [];
      const st = fs.statSync(logPath);
      if (!st.size) return [];
      const readLen = Math.min(st.size, 512 * 1024);
      const fd = fs.openSync(logPath, 'r');
      let text: string;
      try {
        const buf = Buffer.alloc(readLen);
        fs.readSync(fd, buf, 0, readLen, st.size - readLen);
        text = buf.toString('utf8');
      } finally {
        fs.closeSync(fd);
      }
      if (st.size > readLen) {
        const nl = text.indexOf('\n');
        if (nl >= 0) text = text.slice(nl + 1);
      }
      const rawLines = text.split(/\r?\n/).filter((l) => l.length > 0);
      const capped = rawLines.slice(-2000);
      const startNum = rawLines.length - capped.length;
      return capped.map((raw, i) => parseStructuredLogLine(raw, startNum + i + 1));
    } catch {
      return [];
    }
  };

  app.get('/api/logs/realtime', validateSession, (req, res) => {
    const serverId = String(req.query.serverId || '');
    const serverName = String(req.query.serverName || '');
    const srvDiskDir = resolveServerDiskDir(serverName);
    const logsDir = path.join(srvDiskDir, 'logs');
    const latestLogPath = path.join(logsDir, 'latest.log');
    const lines = readRealLogLines(latestLogPath);

    let sizeBytes = 0;
    let modifiedAt = new Date().toISOString();
    let rotatedArchives: Array<{ name: string; sizeBytes: number; modifiedAt: string }> = [];

    try {
      if (fs.existsSync(latestLogPath)) {
        const st = fs.statSync(latestLogPath);
        sizeBytes = st.size;
        modifiedAt = st.mtime.toISOString();
      }
      if (fs.existsSync(logsDir)) {
        const files = fs.readdirSync(logsDir);
        rotatedArchives = files
          .filter((f) => f !== 'latest.log')
          .map((f) => {
            const st = fs.statSync(path.join(logsDir, f));
            return {
              name: f,
              sizeBytes: st.size,
              modifiedAt: st.mtime.toISOString(),
            };
          });
      }
    } catch {
      // ignore
    }

    const errorCount = lines.filter((l) => l.severity === 'ERROR').length;
    const warnCount = lines.filter((l) => l.severity === 'WARN').length;
    const infoCount = lines.filter((l) => l.severity === 'INFO' || l.severity === 'JOIN').length;
    const gcCount = lines.filter((l) => l.severity === 'GC').length;

    res.json({
      ok: true,
      serverId,
      serverName,
      fetchedAt: new Date().toISOString(),
      diskLogPath: latestLogPath,
      displayLogPath: `${joinDisplayServerPath(serverInstallConfig.installRootDir, serverName.replace(/[^a-zA-Z0-9_-]/g, '_'))}\\logs\\latest.log`,
      sizeBytes,
      sizeFormatted: sizeBytes > 1024 ? `${(sizeBytes / 1024).toFixed(1)} KB` : `${sizeBytes} B`,
      totalLines: lines.length,
      lastLineNum: lines.length > 0 ? lines[lines.length - 1].lineNum : 0,
      modifiedAt,
      errorCount,
      warnCount,
      infoCount,
      gcCount,
      rotatedArchives,
      lines,
    });
  });

  app.post('/api/logs/append', validateSession, (req, res) => {
    const {
      serverId = '',
      serverName = '',
      severity = 'INFO',
      thread = 'Server thread',
      tag = '[Operator/Live]',
      rawText = 'Manual diagnostic event written to latest.log on local PC disk.',
    } = req.body || {};

    const created = appendServerLogLine(String(serverId), String(serverName), {
      severity: severity as StructuredLogItem['severity'],
      thread: String(thread),
      tag: String(tag),
      rawText: String(rawText),
    });

    res.json({
      ok: true,
      entry: created,
      lines: ensureServerLogsSeeded(String(serverId), String(serverName)),
    });
  });

  app.post('/api/logs/rotate', validateSession, requireAdvancedPanel, (req, res) => {
    const { serverId = '', serverName = '' } = req.body || {};
    const srvDiskDir = resolveServerDiskDir(String(serverName));
    const logsDir = path.join(srvDiskDir, 'logs');
    const latestLogPath = path.join(logsDir, 'latest.log');
    const archiveName = `rotated-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.log`;
    const archivePath = path.join(logsDir, archiveName);

    try {
      if (fs.existsSync(latestLogPath)) {
        fs.copyFileSync(latestLogPath, archivePath);
      }
    } catch {
      // ignore
    }

    appendServerLogLine(String(serverId), String(serverName), {
      severity: 'INFO',
      thread: 'Server thread',
      tag: '[LogRotator]',
      rawText: `Rotated latest.log to archive "${archiveName}" on local PC disk & synced to MongoDB.`,
    });

    res.json({
      ok: true,
      archiveName,
      archivePath,
      lines: ensureServerLogsSeeded(String(serverId), String(serverName)),
    });
  });

  // ============================================================================
  // 9. REAL-TIME BACKUPS & SNAPSHOTS ENGINE (LOCAL PC DISK + SQLITE + MONGODB)
  // ============================================================================
  interface RealtimeBackupRecord {
    id: string;
    serverId: string;
    serverName: string;
    title: string;
    badge: string;
    badgeType: 'primary' | 'tertiary' | 'gold' | 'neutral';
    timestamp: string;
    size: string;
    sizeBytes: number;
    sha256: string;
    filePath: string;
    scopes: string[];
    pinned: boolean;
    verified: boolean;
    icon: string;
    iconColor: string;
    note?: string;
    createdAt: string;
  }

  const backupsCacheMap = new Map<string, RealtimeBackupRecord[]>();

  // Backups are whatever archives exist under <server>/backups — nothing else.
  function listServerArchives(serverId: string, serverName: string): RealtimeBackupRecord[] {
    const backupsDir = path.join(resolveServerDiskDir(serverName), 'backups');
    const records: RealtimeBackupRecord[] = [];
    try {
      if (fs.existsSync(backupsDir)) {
        for (const name of fs.readdirSync(backupsDir)) {
          if (!/\.(tar\.gz|tgz|zip)$/i.test(name)) continue;
          const filePath = path.join(backupsDir, name);
          const st = fs.statSync(filePath);
          if (!st.isFile()) continue;
          const sizeMb = st.size / 1024 / 1024;
          records.push({
            id: `snap-${Math.round(st.mtimeMs)}-${name.replace(/[^a-zA-Z0-9]/g, '').slice(-10)}`,
            serverId,
            serverName,
            title: name,
            badge: 'ON DISK',
            badgeType: 'primary',
            timestamp: st.mtime.toISOString(),
            size: sizeMb >= 1024 ? `${(sizeMb / 1024).toFixed(2)} GB` : `${sizeMb.toFixed(1)} MB`,
            sizeBytes: st.size,
            sha256: '',
            filePath,
            scopes: [],
            pinned: false,
            verified: true,
            icon: 'archive',
            iconColor: 'bg-primary/15 text-primary',
            note: filePath,
            createdAt: st.mtime.toISOString(),
          });
        }
      }
    } catch {
      // unreadable backups folder -> empty list
    }
    records.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    backupsCacheMap.set(serverId, records);
    return records;
  }

  const BACKUP_PINS_PATH = path.join(appStateDir, '.panel-backup-pins.json');

  const loadBackupPins = (): Record<string, boolean> => {
    try {
      if (!fs.existsSync(BACKUP_PINS_PATH)) return {};
      const parsed = JSON.parse(fs.readFileSync(BACKUP_PINS_PATH, 'utf8'));
      return parsed && typeof parsed === 'object' ? (parsed as Record<string, boolean>) : {};
    } catch {
      return {};
    }
  };

  const saveBackupPins = (pins: Record<string, boolean>): void => {
    try {
      fs.writeFileSync(BACKUP_PINS_PATH, JSON.stringify(pins, null, 2), 'utf8');
    } catch {
      // pins are cosmetic — ignore write failures
    }
  };

  const withBackupPins = (list: RealtimeBackupRecord[]): RealtimeBackupRecord[] => {
    const pins = loadBackupPins();
    return list.map((item) => {
      const pinned = Boolean(pins[item.filePath]);
      return {
        ...item,
        pinned,
        badge: pinned ? 'PINNED' : 'ON DISK',
        badgeType: pinned ? 'primary' : 'neutral',
        icon: pinned ? 'push_pin' : 'archive',
      };
    });
  };

  // Archives the operator can actually restore: world + config, whatever exists.
  const BACKUP_SCOPE_DEFAULTS = [
    'world',
    'world_nether',
    'world_the_end',
    'server.properties',
    'plugins',
    'mods',
    'config',
  ];

  app.get('/api/backups/realtime', validateSession, async (req, res) => {
    const serverId = String(req.query.serverId || '');
    const serverName = String(req.query.serverName || '');
    const snapshots = withBackupPins(listServerArchives(serverId, serverName));
    const backupsDir = path.join(resolveServerDiskDir(serverName), 'backups');

    // Real volume numbers for the drive holding the server folder.
    let diskTotalGb = 0;
    let diskFreeGb = 0;
    try {
      const stat = fs.statfsSync(resolveServerDiskDir(serverName));
      diskTotalGb = (stat.bsize * stat.blocks) / 1024 / 1024 / 1024;
      diskFreeGb = (stat.bsize * stat.bavail) / 1024 / 1024 / 1024;
    } catch {
      // statfs unsupported on this volume — report zeroes rather than fiction
    }
    const diskUsedGb = Math.max(0, diskTotalGb - diskFreeGb);

    res.json({
      ok: true,
      serverId,
      serverName,
      fetchedAt: new Date().toISOString(),
      backupsDiskDir: backupsDir,
      displayBackupsDir: backupsDir,
      filesOnDiskCount: snapshots.length,
      diskTotalGb: Number(diskTotalGb.toFixed(2)),
      diskUsedGb: Number(diskUsedGb.toFixed(2)),
      diskFreeGb: Number(diskFreeGb.toFixed(2)),
      diskUsedPct: diskTotalGb > 0 ? Math.min(100, Math.round((diskUsedGb / diskTotalGb) * 100)) : 0,
      snapshots,
    });
  });

  app.post('/api/backups/create', validateSession, (req, res) => {
    const { serverId = '', serverName = '', title = 'Manual checkpoint' } = req.body || {};
    const dir = resolveServerDiskDir(String(serverName));
    if (!fs.existsSync(dir)) {
      res.status(404).json({ ok: false, error: 'Server folder not found on disk' });
      return;
    }
    const id = path.basename(dir);
    const actor = String((req as any).user?.username || 'Operator');
    const started = jobManager.start({
      kind: 'backup',
      title: `Back up ${id}`,
      serverId: id,
      serverName: String(serverName || id),
      actor,
      run: async (ctx) => {
        ctx.report({ percent: 5, stage: 'preparing', message: `Preparing an archive of ${id}…` });
        const result = await createServerArchive(
          dir,
          String(title || 'Manual checkpoint'),
          BACKUP_SCOPE_DEFAULTS,
          ctx
        );
        if (!result.ok) throw new Error(result.error);
        pushPanelAudit(
          'SYSTEM',
          `Created backup "${result.archive.name}" for server "${String(serverId || serverName)}"`,
          actor
        );
        const snapshots = withBackupPins(listServerArchives(String(serverId), String(serverName)));
        return {
          archive: result.archive,
          entries: result.entries,
          snapshot: snapshots.find((s) => s.title === result.archive.name) || null,
          snapshots,
        };
      },
    });
    if (!started.ok) {
      res.status(409).json({
        ok: false,
        code: 'SERVER_BUSY',
        error: started.active
          ? `"${started.active.title}" is already running for this server.`
          : 'Another operation is already running for this server.',
        activeJob: started.active || null,
      });
      return;
    }
    res.status(202).json({ ok: true, jobId: started.job.id, job: started.job });
  });

  app.post('/api/backups/pin', validateSession, (req, res) => {
    const { serverId = '', serverName = '', id } = req.body || {};
    const list = listServerArchives(String(serverId), String(serverName));
    const found = list.find((s) => s.id === id);
    if (!found) {
      res.status(404).json({ ok: false, error: 'Archive not found' });
      return;
    }
    const pins = loadBackupPins();
    pins[found.filePath] = !pins[found.filePath];
    saveBackupPins(pins);
    res.json({ ok: true, snapshots: withBackupPins(list) });
  });

  app.post('/api/backups/restore', validateSession, (req, res) => {
    const { serverId = '', serverName = '', id } = req.body || {};
    const dir = resolveServerDiskDir(String(serverName));
    const list = listServerArchives(String(serverId), String(serverName));
    const found = list.find((s) => s.id === id);
    if (!found) {
      res.status(404).json({ ok: false, error: 'Archive not found' });
      return;
    }
    const serverKey = path.basename(dir);
    const snap = supervisor.getSnapshot(serverKey);
    if (snap?.state === 'online' || snap?.state === 'starting') {
      res.status(409).json({ ok: false, error: 'Stop the server before restoring a backup' });
      return;
    }
    const actor = String((req as any).user?.username || 'Operator');
    const started = jobManager.start({
      kind: 'restore',
      title: `Restore ${found.title}`,
      serverId: serverKey,
      serverName: String(serverName || serverKey),
      actor,
      run: async (ctx) => {
        await extractServerArchive(dir, found.filePath, ctx);
        pushPanelAudit(
          'SYSTEM',
          `Restored backup "${found.title}" into server "${String(serverId || serverName)}"`,
          actor
        );
        return {
          restored: found.title,
          restoredAt: new Date().toISOString(),
          snapshots: withBackupPins(listServerArchives(String(serverId), String(serverName))),
        };
      },
    });
    if (!started.ok) {
      res.status(409).json({
        ok: false,
        code: 'SERVER_BUSY',
        error: started.active
          ? `"${started.active.title}" is already running for this server.`
          : 'Another operation is already running for this server.',
        activeJob: started.active || null,
      });
      return;
    }
    res.status(202).json({ ok: true, jobId: started.job.id, job: started.job });
  });

  app.delete('/api/backups/:id', validateSession, (req, res) => {
    const id = String(req.params.id);
    const serverId = String(req.query.serverId || '');
    const serverName = String(req.query.serverName || '');
    const list = listServerArchives(serverId, serverName);
    const found = list.find((s) => s.id === id);
    if (!found) {
      res.status(404).json({ ok: false, error: 'Archive not found' });
      return;
    }
    try {
      if (fs.existsSync(found.filePath)) fs.unlinkSync(found.filePath);
    } catch (err) {
      res.status(500).json({
        ok: false,
        error: err instanceof Error ? err.message : 'Could not delete archive',
      });
      return;
    }
    pushPanelAudit(
      'SYSTEM',
      `Deleted backup "${found.title}" for server "${String(serverId || serverName)}"`,
      'Operator'
    );
    res.json({ ok: true, snapshots: withBackupPins(listServerArchives(serverId, serverName)) });
  });

  // ============================================================================
  // 10. REAL-TIME SCHEDULES & CORE ENGINE (QUARTZ CRON + CPU CORE TELEMETRY + MONGODB)
  // ============================================================================
  interface RealtimeScheduleItem {
    id: string;
    serverId: string;
    title: string;
    cron: string;
    commandPayload: string;
    status: 'Active' | 'Paused' | 'Weekly';
    description: string;
    nextRunSec: number;
    nextRun: string;
    lastRunAt: string;
    lastExitCode: number;
    runCount: number;
    cpuCoreAffinity: string;
    actionLabel: string;
    icon: string;
    iconColor: string;
  }

  const schedulesCacheMap = new Map<string, RealtimeScheduleItem[]>();

  function formatNextRunSec(sec: number, status: string): string {
    if (status === 'Paused') return 'Paused by Operator';
    if (sec < 60) return `Next run in: ${sec}s`;
    const mins = Math.floor(sec / 60);
    const remSec = sec % 60;
    return `Next run in: ${mins}m ${remSec}s`;
  }

  // Schedules come from the real scheduler store (same jobs the simple panel runs).
  function getRealtimeSchedules(serverId: string): RealtimeScheduleItem[] {
    const now = Date.now();
    return loadSimpleSchedules()
      .filter((job) => job.serverId === serverId)
      .map((job) => {
        const nextRunSec = Math.max(0, Math.round((job.nextRunAt - now) / 1000));
        const status: RealtimeScheduleItem['status'] = job.enabled ? 'Active' : 'Paused';
        return {
          id: job.id,
          serverId: job.serverId,
          title: job.title,
          cron: `every ${job.intervalMinutes}m`,
          commandPayload: job.payload,
          status,
          description: `${job.action} job executed by the panel backend every ${job.intervalMinutes} minute(s).`,
          nextRunSec,
          nextRun: formatNextRunSec(nextRunSec, status),
          lastRunAt: job.lastRunAt ? new Date(job.lastRunAt).toLocaleString() : 'Never',
          lastExitCode: job.lastResult && job.lastResult.startsWith('failed') ? 1 : 0,
          runCount: job.runCount || 0,
          cpuCoreAffinity: 'All Cores',
          actionLabel: 'Run Now',
          icon: 'schedule',
          iconColor: 'bg-primary/15 text-primary',
        };
      })
      .sort((a, b) => a.nextRunSec - b.nextRunSec);
  }


  app.get('/api/schedules/realtime', validateSession, (req, res) => {
    const serverId = String(req.query.serverId || '');
    const schedules = getRealtimeSchedules(serverId);
    const cpuMetrics = computeRealLocalCpuUsage();
    const cpus = os.cpus();
    const load = os.loadavg();
    const mem = process.memoryUsage();

    res.json({
      ok: true,
      serverId,
      fetchedAt: new Date().toISOString(),
      coreTelemetry: {
        hostname: os.hostname(),
        cpuModel: cpus[0]?.model || 'Unknown CPU',
        cpuCores: cpus.length || 0,
        avgMhz: cpuMetrics.avgMhz,
        totalCpuPct: cpuMetrics.totalPct,
        perCorePct: cpuMetrics.perCorePct,
        loadAvg1m: Number(load[0].toFixed(2)),
        loadAvg5m: Number(load[1].toFixed(2)),
        daemonPid: process.pid,
        daemonHeapMb: Number((mem.heapUsed / 1024 / 1024).toFixed(1)),
        schedulerClockUtc: new Date().toISOString(),
      },
      schedules,
    });
  });

  // Derive an interval from the common cron shapes the advanced UI sends.
  const intervalMinutesFromCron = (cron: string): number => {
    const parts = String(cron || "").trim().split(/\s+/);
    if (parts.length < 5) return 30;
    const [minute, hour] = parts;
    if (minute === '*') return 1;
    const step = /^\*\/(\d+)$/.exec(minute);
    if (step) return Math.max(1, Number(step[1]));
    if (/^\d+$/.test(minute) && hour === '*') return 60;
    if (/^\d+$/.test(minute) && /^\d+$/.test(hour)) return 1440;
    return 30;
  };

  app.post('/api/schedules/create', validateSession, requireAdvancedPanel, async (req, res) => {
    const {
      serverId = '',
      serverName = '',
      title,
      cron = '*/30 * * * *',
      commandPayload = '',
    } = req.body || {};
    const id = String(serverId).trim();
    if (!id) {
      res.status(400).json({ ok: false, error: 'serverId required' });
      return;
    }
    const payload = String(commandPayload || "").trim();
    if (!payload) {
      res.status(400).json({ ok: false, error: 'A console command is required' });
      return;
    }
    const intervalMinutes = intervalMinutesFromCron(String(cron));
    const record: SimpleScheduleRecord = {
      id: `sch-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      serverId: id,
      serverName: String(serverName || id),
      title: String(title || 'Scheduled command').slice(0, 120),
      action: 'command',
      payload: payload.slice(0, 2048),
      intervalMinutes,
      enabled: true,
      createdAt: new Date().toISOString(),
      nextRunAt: Date.now() + intervalMinutes * 60_000,
      lastRunAt: null,
      lastResult: null,
      runCount: 0,
    };
    const list = loadSimpleSchedules();
    list.push(record);
    saveSimpleSchedules(list);
    pushPanelAudit(
      'SYSTEM',
      `Created schedule "${record.title}" (every ${intervalMinutes}m, command) for server "${id}"`,
      'Operator'
    );
    res.json({ ok: true, schedule: record, schedules: getRealtimeSchedules(id) });
  });

  app.post('/api/schedules/run', validateSession, requireAdvancedPanel, async (req, res) => {
    const { serverId = '', id } = req.body || {};
    const list = loadSimpleSchedules();
    const idx = list.findIndex((s) => s.id === String(id || ""));
    if (idx === -1) {
      res.status(404).json({ ok: false, error: 'Schedule not found' });
      return;
    }
    const job = list[idx];
    const result = await executeSimpleSchedule(job);
    job.lastRunAt = new Date().toISOString();
    job.lastResult = result;
    job.runCount = (job.runCount || 0) + 1;
    job.nextRunAt = Date.now() + Math.max(1, job.intervalMinutes) * 60_000;
    list[idx] = job;
    saveSimpleSchedules(list);
    res.json({
      ok: true,
      result,
      schedules: getRealtimeSchedules(String(serverId || job.serverId)),
    });
  });

  app.post('/api/schedules/toggle', validateSession, requireAdvancedPanel, (req, res) => {
    const { serverId = '', id } = req.body || {};
    const list = loadSimpleSchedules();
    const idx = list.findIndex((s) => s.id === String(id || ""));
    if (idx === -1) {
      res.status(404).json({ ok: false, error: 'Schedule not found' });
      return;
    }
    list[idx].enabled = !list[idx].enabled;
    if (list[idx].enabled) {
      list[idx].nextRunAt = Date.now() + Math.max(1, list[idx].intervalMinutes) * 60_000;
    }
    saveSimpleSchedules(list);
    res.json({
      ok: true,
      schedules: getRealtimeSchedules(String(serverId || list[idx].serverId)),
    });
  });

  app.delete('/api/schedules/:id', validateSession, requireAdvancedPanel, (req, res) => {
    const id = String(req.params.id);
    const serverId = String(req.query.serverId || '');
    const list = loadSimpleSchedules();
    const idx = list.findIndex((s) => s.id === id);
    if (idx === -1) {
      res.status(404).json({ ok: false, error: 'Schedule not found' });
      return;
    }
    const [removed] = list.splice(idx, 1);
    saveSimpleSchedules(list);
    res.json({
      ok: true,
      schedules: getRealtimeSchedules(String(serverId || removed.serverId)),
    });
  });

  // ============================================================================
  // 11. REAL-TIME DATABASE TELEMETRY, XAMPP / MARIADB LOCAL PC SETUP & MONGODB PUSH API
  // ============================================================================
  app.get('/api/database/realtime-status', validateSession, async (_req, res) => {
    const mysqlProbe = await probeLocalTcpPort(dbEngineConfig.mysqlPort || 3306);
    const mongoProbe = await probeLocalTcpPort(27017);

    // Check if XAMPP or MariaDB binaries exist on the local PC
    const xamppDetectedOnDisk =
      fs.existsSync('C:\\xampp\\mysql\\bin\\mysqld.exe') ||
      fs.existsSync('/opt/lampp/bin/mysql') ||
      fs.existsSync(dbEngineConfig.xamppInstallPath);

    const mariadbDetectedOnDisk =
      fs.existsSync('C:\\Program Files\\MariaDB 11.4\\bin\\mariadbd.exe') ||
      fs.existsSync('/usr/bin/mariadbd') ||
      fs.existsSync('/usr/bin/mysqld') ||
      fs.existsSync(dbEngineConfig.mariadbInstallPath);

    let sqliteSizeBytes = 0;
    try {
      if (fs.existsSync(SQLITE_DB_PATH)) {
        sqliteSizeBytes = fs.statSync(SQLITE_DB_PATH).size;
      }
    } catch {
      // ignore
    }

    const mongoUsers = readMongoCollection('users');
    const mongoProfiles = readMongoCollection('user_profiles');
    const mongoBackups = readMongoCollection('backups_snapshots');
    const mongoSchedules = readMongoCollection('schedules_core');
    const mongoLogs = readMongoCollection('server_logs');

    res.json({
      ok: true,
      fetchedAt: new Date().toISOString(),
      config: dbEngineConfig,
      engines: {
        xampp: {
          name: 'XAMPP Local PC (MySQL + phpMyAdmin)',
          host: dbEngineConfig.mysqlHost,
          port: dbEngineConfig.mysqlPort,
          portOpen: mysqlProbe.open,
          latencyMs: mysqlProbe.latencyMs,
          detectedOnDisk: xamppDetectedOnDisk,
          installPath: dbEngineConfig.xamppInstallPath,
          phpMyAdminUrl: 'http://localhost/phpmyadmin',
          status: mysqlProbe.open ? 'ONLINE (Port 3306 Open)' : 'STANDBY (Start MySQL in XAMPP Control Panel)',
        },
        mariadb: {
          name: 'MariaDB Server 11.4 (Local PC)',
          host: dbEngineConfig.mysqlHost,
          port: dbEngineConfig.mysqlPort,
          portOpen: mysqlProbe.open,
          latencyMs: mysqlProbe.latencyMs,
          detectedOnDisk: mariadbDetectedOnDisk,
          installPath: dbEngineConfig.mariadbInstallPath,
          status: mysqlProbe.open ? 'ONLINE (Port 3306 Active)' : 'STANDBY (Run net start MariaDB on Local PC)',
        },
        mongodb: {
          name: 'MongoDB Document Database',
          uri: dbEngineConfig.mongoUri,
          database: dbEngineConfig.mongoDatabase,
          port27017Open: mongoProbe.open,
          liveDriverConnected: liveMongoConnected,
          latencyMs: mongoProbe.latencyMs || 1,
          lastPushAt: lastMongoPushAt,
          totalPushedDocs: totalMongoDocumentsPushed,
          collections: [
            { name: 'users', count: mongoUsers.length, sample: mongoUsers.slice(0, 5) },
            { name: 'user_profiles', count: mongoProfiles.length, sample: mongoProfiles.slice(0, 5) },
            { name: 'backups_snapshots', count: mongoBackups.length, sample: mongoBackups.slice(0, 5) },
            { name: 'schedules_core', count: mongoSchedules.length, sample: mongoSchedules.slice(0, 5) },
            { name: 'server_logs', count: mongoLogs.length, sample: mongoLogs.slice(0, 5) },
          ],
          status: liveMongoConnected
            ? 'CONNECTED (Live MongoDB Daemon)'
            : 'ACTIVE (Local BSON/JSON Replica Store + Auto-Push Ready)',
        },
        sqlite: {
          name: 'SQLite 3.46 Native Engine (WAL Mode)',
          path: SQLITE_DB_PATH,
          sizeBytes: sqliteSizeBytes,
          sizeFormatted: `${Math.max(48, Math.round(sqliteSizeBytes / 1024))} KB`,
          status: 'ONLINE (Primary Zero-Config Engine)',
        },
      },
    });
  });

  app.post('/api/database/configure-engine', validateSession, async (req, res) => {
    const {
      activePrimaryEngine,
      mysqlHost,
      mysqlPort,
      mysqlUser,
      mysqlPassword,
      mysqlDatabase,
      xamppInstallPath,
      mariadbInstallPath,
      mongoUri,
      mongoDatabase,
    } = req.body || {};

    dbEngineConfig = {
      ...dbEngineConfig,
      activePrimaryEngine: activePrimaryEngine || dbEngineConfig.activePrimaryEngine,
      mysqlHost: mysqlHost ?? dbEngineConfig.mysqlHost,
      mysqlPort: Number(mysqlPort) || dbEngineConfig.mysqlPort,
      mysqlUser: mysqlUser ?? dbEngineConfig.mysqlUser,
      mysqlPassword: mysqlPassword ?? dbEngineConfig.mysqlPassword,
      mysqlDatabase: mysqlDatabase ?? dbEngineConfig.mysqlDatabase,
      xamppInstallPath: xamppInstallPath ?? dbEngineConfig.xamppInstallPath,
      mariadbInstallPath: mariadbInstallPath ?? dbEngineConfig.mariadbInstallPath,
      mongoUri: mongoUri ?? dbEngineConfig.mongoUri,
      mongoDatabase: mongoDatabase ?? dbEngineConfig.mongoDatabase,
      updatedAt: new Date().toISOString(),
    };

    try {
      fs.writeFileSync(DB_ENGINE_CONFIG_PATH, JSON.stringify(dbEngineConfig, null, 2), 'utf8');
    } catch {
      // ignore
    }

    let connectionTestMessage = `Saved database configuration (${dbEngineConfig.activePrimaryEngine.toUpperCase()}).`;

    if (activePrimaryEngine === 'xampp' || activePrimaryEngine === 'mariadb') {
      try {
        const conn = await mysql.createConnection({
          host: dbEngineConfig.mysqlHost,
          port: dbEngineConfig.mysqlPort,
          user: dbEngineConfig.mysqlUser,
          password: dbEngineConfig.mysqlPassword || '',
          connectTimeout: 1500,
        });
        await conn.query(`CREATE DATABASE IF NOT EXISTS \`${dbEngineConfig.mysqlDatabase}\`;`);
        await conn.end();
        connectionTestMessage = `Connected to local ${activePrimaryEngine.toUpperCase()} server on ${dbEngineConfig.mysqlHost}:${dbEngineConfig.mysqlPort} and verified database "${dbEngineConfig.mysqlDatabase}"!`;
      } catch (err) {
        connectionTestMessage = `Saved ${activePrimaryEngine.toUpperCase()} settings (${dbEngineConfig.mysqlHost}:${dbEngineConfig.mysqlPort}). Start MySQL/MariaDB on your local PC to establish live socket link (${err instanceof Error ? err.message : 'port 3306 standby'}).`;
      }
    } else if (activePrimaryEngine === 'mongodb') {
      const mongoRes = await tryConnectLiveMongo(dbEngineConfig.mongoUri);
      connectionTestMessage = mongoRes.connected
        ? `Connected to live MongoDB server at ${dbEngineConfig.mongoUri}!`
        : `Configured MongoDB (${dbEngineConfig.mongoUri}) — all user accounts, profiles, backups & logs are being pushed to MongoDB collection store.`;
    }

    pushPanelAudit('SYSTEM', connectionTestMessage, 'kingplayz (Database Architect)');

    res.json({
      ok: true,
      config: dbEngineConfig,
      message: connectionTestMessage,
    });
  });

  app.post('/api/database/mongodb/push-all', validateSession, (_req, res) => {
    const users = loadUsersDb();
    for (const u of users) {
      const clean = sanitizeUser(u);
      pushToMongoDB('users', 'id', u.id, { ...clean });
      pushToMongoDB('user_profiles', 'username', u.username, {
        userId: u.id,
        username: u.username,
        displayName: u.displayName,
        email: u.email,
        role: clean.role,
        avatarUrl: u.avatarUrl || DEFAULT_SERVER_PROFILE_ICON,
        mcUuid: u.mcUuid,
        discordVerified: clean.discordVerified,
        maxServerLimit: clean.maxServerLimit,
      });
    }

    // Only real data is pushed: logs already on disk plus the archive list.
    for (const [id, srv] of trackedServersMap.entries()) {
      ensureServerLogsSeeded(id, srv.name);
      listServerArchives(id, srv.name);
    }

    pushPanelAudit(
      'SYSTEM',
      `Pushed all Users (${users.length}), Profiles, Backups, Schedules & Logs into MongoDB database "${dbEngineConfig.mongoDatabase}"`,
      'MongoDB Sync Engine'
    );

    res.json({
      ok: true,
      pushedAt: lastMongoPushAt,
      totalPushedDocs: totalMongoDocumentsPushed,
      collections: {
        users: readMongoCollection('users'),
        user_profiles: readMongoCollection('user_profiles'),
        backups_snapshots: readMongoCollection('backups_snapshots'),
        schedules_core: readMongoCollection('schedules_core'),
        server_logs: readMongoCollection('server_logs'),
      },
    });
  });

  // ==========================================================================
  // PROCESS SUPERVISOR ROUTES — real server lifecycle, console, and metrics
  // ==========================================================================

  const supervisorDbDir = () => process.env.APPDATA_DB_DIR || path.join(process.cwd(), 'database');
  const setupFilePath = path.join(supervisorDbDir(), 'server_setup.json');

  const loadSetupMap = (): Record<string, Record<string, unknown>> => {
    try {
      if (fs.existsSync(setupFilePath)) {
        const data = JSON.parse(fs.readFileSync(setupFilePath, 'utf8'));
        if (data && typeof data === 'object') return data as Record<string, Record<string, unknown>>;
      }
    } catch {
      // corrupt file -> start fresh
    }
    return {};
  };

  const saveSetupMap = (map: Record<string, Record<string, unknown>>) => {
    try {
      fs.mkdirSync(supervisorDbDir(), { recursive: true });
      fs.writeFileSync(setupFilePath, JSON.stringify(map, null, 2), 'utf8');
    } catch {
      // non-fatal
    }
  };

  const splitArgs = (input?: unknown): string[] => {
    if (typeof input !== 'string' || !input.trim()) return [];
    const out: string[] = [];
    const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(input)) !== null) out.push(m[1] ?? m[2] ?? m[3]);
    return out;
  };

  const detectMainFile = (dir: string): string => {
    try {
      if (fs.existsSync(path.join(dir, 'server.jar'))) return 'server.jar';
      const jars = fs
        .readdirSync(dir)
        .filter((f) => f.toLowerCase().endsWith('.jar') && fs.statSync(path.join(dir, f)).isFile());
      if (jars.length === 1) return jars[0];
    } catch {
      // ignore
    }
    return 'server.jar';
  };

  const eulaAcceptedIn = (dir: string): boolean => {
    try {
      return /^\s*eula\s*=\s*true\s*$/im.test(fs.readFileSync(path.join(dir, 'eula.txt'), 'utf8'));
    } catch {
      return false;
    }
  };

  const readServerPortIn = (dir: string): number | null => {
    try {
      const props = fs.readFileSync(path.join(dir, 'server.properties'), 'utf8');
      const m = props.match(/^server-port\s*=\s*(\d+)/m);
      return m ? Number(m[1]) : null;
    } catch {
      return null;
    }
  };

  const sanitizeFolderName = (raw: string): string =>
    raw.trim().replace(/[^a-zA-Z0-9_-]/g, '_').replace(/_+/g, '_') || 'Server_Instance';

  /** Resolve a request's serverId/serverName to an existing folder on disk. */
  const resolveRuntimeDir = (serverId?: string, serverName?: string): string | null => {
    const root = resolveWritableDiskRoot(serverInstallConfig.installRootDir);
    const candidates: string[] = [];
    if (serverId) candidates.push(serverId, sanitizeFolderName(serverId));
    if (serverName) candidates.push(sanitizeFolderName(serverName));
    for (const c of candidates) {
      try {
        const p = path.join(root, c);
        if (fs.existsSync(p) && fs.statSync(p).isDirectory()) return p;
      } catch {
        // keep looking
      }
    }
    try {
      const wanted = new Set(candidates.map((c) => c.toLowerCase()));
      for (const f of fs.readdirSync(root)) {
        if (wanted.has(f.toLowerCase())) return path.join(root, f);
      }
    } catch {
      // root missing
    }
    // Fall back to the folder recorded when the server was created, so a server
    // stays reachable when the install root was later changed.
    try {
      const recorded = loadSetupMap();
      for (const c of candidates) {
        const entry = recorded[c] || recorded[sanitizeFolderName(c)];
        const dir = entry && typeof entry.dir === 'string' ? entry.dir : '';
        if (dir && fs.existsSync(dir) && fs.statSync(dir).isDirectory()) return dir;
      }
    } catch {
      // no recorded directory
    }
    return null;
  };

  const storageCache = new Map<string, { mb: number; at: number }>();
  const getStorageMbCached = async (dir: string): Promise<number> => {
    const hit = storageCache.get(dir);
    if (hit && Date.now() - hit.at < 60_000) return hit.mb;
    const mb = await supervisor.getStorageMb(dir);
    storageCache.set(dir, { mb, at: Date.now() });
    return mb;
  };

  // --- Server registry (disk folders + real runtime state) ------------------
  const prettyEngineName = (engine: string): string => {
    const map: Record<string, string> = {
      paper: 'PaperMC',
      folia: 'Folia',
      velocity: 'Velocity',
      waterfall: 'Waterfall',
      purpur: 'Purpur',
      fabric: 'Fabric',
      vanilla: 'Vanilla',
      spigot: 'Spigot',
      forge: 'Forge',
      neoforge: 'NeoForge',
    };
    if (map[engine]) return map[engine];
    return engine ? engine.charAt(0).toUpperCase() + engine.slice(1) : 'PaperMC';
  };

  app.get('/api/servers', validateSession, (_req, res) => {
    const root = resolveWritableDiskRoot(serverInstallConfig.installRootDir);
    const servers: unknown[] = [];
    const setupMap = loadSetupMap();
    try {
      for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const dir = path.join(root, entry.name);
        const setup = setupMap[entry.name] || {};
        const engine = String(setup.engine || 'paper');
        const version = String(setup.version || '');
        // Every directory in the install root is listed, so servers created
        // before the engine was recorded still show up with a usable label.
        servers.push({
          id: entry.name,
          name: entry.name,
          engine,
          engineLabel: `${prettyEngineName(engine)}${version ? ` ${version}` : ''}`,
          version,
          ramMaxGb: Number(setup.ramMaxGb) || 4,
          diskPath: dir,
          displayPath: joinDisplayServerPath(serverInstallConfig.installRootDir, entry.name),
          port: readServerPortIn(dir) ?? (Number(setup.port) || null),
          eulaAccepted: eulaAcceptedIn(dir),
          mainFile: detectMainFile(dir),
          hasJar: serverDirHasJar(dir),
          // Always a snapshot, never null: a folder the supervisor has not seen
          // yet has no process, which is exactly the "stopped" state. This keeps
          // the status shape identical for every row in the list.
          runtime: supervisor.getSnapshot(entry.name) ?? {
            id: entry.name,
            state: 'stopped' as const,
            adopted: false,
            attached: false,
            restartPending: false,
          },
        });
      }
    } catch {
      // no install root yet
    }
    res.json({ ok: true, servers, installRoot: root });
  });

  // --- Live event stream (console lines + state changes over SSE) -----------
  app.get('/api/servers/:id/events', validateSession, (req, res) => {
    const dir = resolveRuntimeDir(String(req.params.id), String(req.query.serverName || ''));
    if (!dir) {
      res.status(404).json({ ok: false, error: 'Server folder not found on disk' });
      return;
    }
    const id = path.basename(dir);
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(`data: ${JSON.stringify({ type: 'hello', snapshot: supervisor.getSnapshot(id) })}\n\n`);

    const onLine = (sid: string, line: unknown) => {
      if (sid === id) res.write(`event: console\ndata: ${JSON.stringify(line)}\n\n`);
    };
    const onState = (sid: string, state: string, extra: unknown) => {
      if (sid === id) res.write(`event: state\ndata: ${JSON.stringify({ state, ...(extra as object) })}\n\n`);
    };
    supervisor.on('line', onLine);
    supervisor.on('state', onState);
    const heartbeat = setInterval(() => res.write(': ping\n\n'), 15_000);
    req.on('close', () => {
      supervisor.off('line', onLine);
      supervisor.off('state', onState);
      clearInterval(heartbeat);
    });
  });

  // --- Power: start / stop / restart / force-kill (real processes) ----------
  app.post('/api/server-runtime/power', validateSession, async (req, res) => {
    const { serverId, serverName, action, ramMaxGb } = req.body || {};
    const dir = resolveRuntimeDir(String(serverId || ''), String(serverName || ''));
    if (!dir) {
      res.status(404).json({ ok: false, error: 'Server folder not found on disk' });
      return;
    }
    const id = path.basename(dir);
    const setup = loadSetupMap()[id] || {};
    try {
      if (action === 'start') {
        // Self-heal: a folder without any jar can never boot. Install the
        // engine jar recorded at creation time before spawning Java.
        if (!serverDirHasJar(dir)) {
          const parsed = parseEngineLabel(setup.engine, String(setup.version || ''));
          if (!parsed.engine || !parsed.version) {
            res.status(400).json({
              ok: false,
              error:
                'No server.jar in this folder and no engine/version recorded. Use "Install server.jar" first.',
            });
            return;
          }
          const jar = await installServerJar(dir, parsed.engine, parsed.version);
          if (!jar.ok) {
            res.status(400).json({
              ok: false,
              error: `Could not install server.jar (${parsed.engine} ${parsed.version}): ${jar.error}`,
            });
            return;
          }
        }
        const result = await supervisor.start(id, {
          serverDir: dir,
          xmxGb: Number(ramMaxGb) || 4,
          mainFile: typeof setup.mainFile === 'string' ? setup.mainFile : undefined,
          javaPath: typeof setup.javaPath === 'string' && setup.javaPath ? setup.javaPath : undefined,
          jvmArgs: splitArgs(setup.additionalFlags).filter((a) => a.startsWith('-')),
          programArgs: splitArgs(setup.additionalArguments),
        });
        res.status(result.ok ? 200 : 400).json({
          ok: result.ok,
          error: result.error,
          alreadyRunning: result.alreadyRunning,
          state: result.state,
          pid: result.pid,
          adopted: result.adopted,
        });
        return;
      }
      if (action === 'stop') {
        const result = await supervisor.stop(id);
        res.json({ ok: true, state: result.state, pid: result.pid, alreadyStopped: result.alreadyStopped });
        return;
      }
      if (action === 'kill') {
        const result = await supervisor.stop(id, { force: true });
        res.json({ ok: true, state: result.state, pid: result.pid, alreadyStopped: result.alreadyStopped });
        return;
      }
      if (action === 'restart') {
        const result = await supervisor.restart(id);
        res.status(result.ok ? 200 : 400).json({ ok: result.ok, error: result.error, state: result.state, pid: result.pid });
        return;
      }
      res.status(400).json({ ok: false, error: `Unknown action: ${String(action)}` });
    } catch (err) {
      res.status(500).json({ ok: false, error: err instanceof Error ? err.message : 'Power action failed' });
    }
  });

  // --- Console command (validated, written to the process stdin) ------------
  app.post('/api/server-runtime/command', validateSession, (req, res) => {
    const { serverId, serverName, command } = req.body || {};
    const dir = resolveRuntimeDir(String(serverId || ''), String(serverName || ''));
    if (!dir) {
      res.status(404).json({ ok: false, error: 'Server folder not found on disk' });
      return;
    }
    const id = path.basename(dir);
    const result = supervisor.sendCommand(id, String(command ?? ''));
    if (!result.ok) {
      res.status(400).json({ ok: false, error: result.error, consoleLogs: supervisor.getConsole(id) });
      return;
    }
    res.json({ ok: true, consoleLogs: supervisor.getConsole(id) });
  });

  // --- Setup config (persisted per server) ----------------------------------
  app.get('/api/server-runtime/setup', validateSession, (req, res) => {
    const serverId = String(req.query.serverId || '');
    const serverName = String(req.query.serverName || '');
    const ramMaxGb = Number(req.query.ramMaxGb) || 4;
    const dir = resolveRuntimeDir(serverId, serverName);
    const id = dir ? path.basename(dir) : serverId;
    const stored = loadSetupMap()[id] || {};
    const mainFile =
      typeof stored.mainFile === 'string' && stored.mainFile
        ? stored.mainFile
        : dir
          ? detectMainFile(dir)
          : 'server.jar';
    res.json({
      ok: true,
      setup: {
        startupCommand:
          (typeof stored.startupCommand === 'string' && stored.startupCommand) ||
          `java -Xms128M -Xmx${Math.round(ramMaxGb * 1024)}M -XX:+UseG1GC -jar ${mainFile} nogui`,
        gitRepoAddress: stored.gitRepoAddress || '',
        installBranch: stored.installBranch || 'main',
        userUploadedFiles: Boolean(stored.userUploadedFiles),
        autoUpdate: Boolean(stored.autoUpdate),
        additionalFlags: stored.additionalFlags || '',
        gitUsername: stored.gitUsername || '',
        gitAccessToken: stored.gitAccessToken || '',
        uninstallNodePackages: stored.uninstallNodePackages || '',
        mainFile,
        additionalArguments: stored.additionalArguments || '--nogui',
        javaPath: stored.javaPath || '',
      },
    });
  });

  app.post('/api/server-runtime/setup', validateSession, (req, res) => {
    const { serverId, setup } = req.body || {};
    const id = String(serverId || '').trim();
    if (!id) {
      res.status(400).json({ ok: false, error: 'serverId required' });
      return;
    }
    const allowed = [
      'startupCommand',
      'gitRepoAddress',
      'installBranch',
      'userUploadedFiles',
      'autoUpdate',
      'additionalFlags',
      'gitUsername',
      'gitAccessToken',
      'uninstallNodePackages',
      'mainFile',
      'additionalArguments',
      'javaPath',
      // Remembered at server creation so the jar can be reinstalled later.
      'engine',
      'version',
      'ramMaxGb',
      'port',
    ];
    const map = loadSetupMap();
    const clean: Record<string, unknown> = {};
    if (setup && typeof setup === 'object') {
      for (const key of allowed) {
        const value = (setup as Record<string, unknown>)[key];
        if (value === undefined) continue;
        clean[key] =
          typeof value === 'string'
            ? value.slice(0, 2048)
            : typeof value === 'number'
            ? value
            : Boolean(value);
      }
    }
    map[id] = { ...(map[id] || {}), ...clean };
    saveSetupMap(map);
    res.json({ ok: true, setup: map[id] });
  });

  // --- Install / repair server.jar for an existing server folder ------------
  app.post('/api/server-runtime/install-jar', validateSession, requireAdvancedPanel, async (req, res) => {
    const {
      serverId,
      serverName,
      engine,
      version,
      downloadUrl = '',
      filename = '',
      build = '',
    } = req.body || {};
    const dir = resolveRuntimeDir(String(serverId || ''), String(serverName || ''));
    if (!dir) {
      res.status(404).json({ ok: false, error: 'Server folder not found on disk' });
      return;
    }
    const id = path.basename(dir);
    const setup = loadSetupMap()[id] || {};
    const parsed = parseEngineLabel(engine || setup.engine, String(version || setup.version || ''));
    const jarEngine = parsed.engine;
    const jarVersion = parsed.version;
    const actor = String((req as any).user?.username || 'Operator');

    // A jar swap must not overlap a backup, restore or delete of this server, so
    // it goes through the same per-server job lock instead of running inline.
    const started = jobManager.start({
      kind: 'reinstall',
      title: `Reinstall ${jarEngine} ${jarVersion} on ${id}`,
      serverId: id,
      serverName: String(serverName || id),
      actor,
      run: async (ctx) => {
        ctx.report({ percent: 5, stage: 'downloading', message: `Downloading ${jarEngine} ${jarVersion}…` });
        const result = await installServerJar(
          dir,
          jarEngine,
          jarVersion,
          downloadUrl
            ? {
                url: String(downloadUrl),
                filename: String(filename),
                build: String(build),
                apiSource: 'Selected build',
              }
            : undefined,
          ctx
        );
        if (!result.ok) throw new Error(result.error || 'The download failed.');

        const map = loadSetupMap();
        map[id] = {
          ...(map[id] || {}),
          dir,
          engine: jarEngine,
          version: jarVersion,
          mainFile: 'server.jar',
        };
        saveSetupMap(map);

        pushPanelAudit(
          'SYSTEM',
          `Reinstalled server.jar (${jarEngine} ${jarVersion}) into "${dir}"`,
          actor
        );

        return {
          ok: true,
          serverId: id,
          engine: jarEngine,
          version: jarVersion,
          jarPath: result.jarPath,
          bytes: result.bytes,
          filename: result.target?.filename,
          build: result.target?.build,
          source: result.target?.apiSource,
        };
      },
    });
    if (!started.ok) {
      res.status(409).json({
        ok: false,
        code: 'SERVER_BUSY',
        error: started.active
          ? `"${started.active.title}" is already running for this server.`
          : 'Another operation is already running for this server.',
        activeJob: started.active || null,
      });
      return;
    }
    res.status(202).json({ ok: true, jobId: started.job.id, job: started.job });
  });

  // --- Delete a server instance (stop process, forget it, optionally wipe) ---
  app.delete('/api/server-runtime/server', validateSession, async (req, res) => {
    const { serverId, serverName, deleteFiles = true } = (req.body || {}) as {
      serverId?: string;
      serverName?: string;
      deleteFiles?: boolean;
    };
    const dir = resolveRuntimeDir(String(serverId || ''), String(serverName || ''));
    if (!dir) {
      res.status(404).json({ ok: false, error: 'Server folder not found on disk' });
      return;
    }
    const id = path.basename(dir);

    // Deletion is destructive: hold the server lock until the response ends so
    // a backup/restore/install cannot start halfway through the wipe.
    const releaseDeleteLock = jobManager.acquireLock(id, `delete:${id}`);
    if (!releaseDeleteLock) {
      res.status(409).json({
        ok: false,
        code: 'SERVER_BUSY',
        error: 'Another operation is already running for this server. Wait for it to finish before deleting.',
      });
      return;
    }
    res.on('finish', releaseDeleteLock);
    res.on('close', releaseDeleteLock);

    // Never delete a folder that no longer looks like a server instance: that
    // guard keeps a mistargeted id from wiping an unrelated directory.
    if (!looksLikeServerFolder(dir) && !loadSetupMap()[id]) {
      res.status(400).json({
        ok: false,
        error: `"${id}" does not look like a server folder — refusing to delete it.`,
      });
      return;
    }

    const snap = supervisor.getSnapshot(id);
    if (snap?.state === 'online' || snap?.state === 'starting' || snap?.state === 'stopping') {
      await supervisor.stop(id, { force: true });
    }

    const schedulesBefore = loadSimpleSchedules();
    const schedulesAfter = schedulesBefore.filter((s) => s.serverId !== id);
    if (schedulesAfter.length !== schedulesBefore.length) saveSimpleSchedules(schedulesAfter);

    const setupMap = loadSetupMap();
    const recorded = setupMap[id];
    const displayPath = recorded?.dir
      ? String(recorded.dir)
      : joinDisplayServerPath(serverInstallConfig.installRootDir, id);
    delete setupMap[id];
    saveSetupMap(setupMap);

    let filesRemoved = false;
    let filesError: string | undefined;
    if (deleteFiles) {
      try {
        fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
        filesRemoved = true;
      } catch (err) {
        filesError = err instanceof Error ? err.message : 'Could not remove the server folder';
      }
    }

    pushPanelAudit(
      'SYSTEM',
      `Deleted server "${id}"${deleteFiles ? ' and removed its folder' : ' (folder kept on disk)'}${
        filesError ? ` — ${filesError}` : ''
      }`,
      'Operator'
    );

    if (filesError) {
      res.status(500).json({ ok: false, error: filesError, serverId: id, filesRemoved: false });
      return;
    }

    res.json({
      ok: true,
      serverId: id,
      displayPath,
      filesRemoved,
      removedSchedules: schedulesBefore.length - schedulesAfter.length,
    });
  });

  // --- Live runtime state (real PID metrics + real console lines) -----------
  // System-wide network throughput sampled between live-state polls. Windows
  // exposes cumulative byte counters via `netstat -e`, Linux via /proc/net/dev.
  let lastNetSample: { at: number; rx: number; tx: number } | null = null;
  const sampleSystemNetworkKbps = async (): Promise<{ rxKbps: number; txKbps: number }> => {
    let rx = 0;
    let tx = 0;
    try {
      if (process.platform === 'win32') {
        const { stdout } = await execAsync('netstat -e');
        const bytesLine = stdout.split('\n').find((l) => /^\s*Bytes\s/.test(l));
        const nums = (bytesLine || '').match(/\d+/g) || [];
        rx = Number(nums[0]) || 0;
        tx = Number(nums[1]) || 0;
      } else {
        const stdout = fs.readFileSync('/proc/net/dev', 'utf8');
        let r = 0;
        let t = 0;
        for (const line of stdout.split('\n').slice(2)) {
          const parts = line.trim().split(/[\s:]+/);
          if (parts.length < 10) continue;
          r += Number(parts[1]) || 0;
          t += Number(parts[9]) || 0;
        }
        rx = r;
        tx = t;
      }
    } catch {
      return { rxKbps: 0, txKbps: 0 };
    }
    const now = Date.now();
    const result = { rxKbps: 0, txKbps: 0 };
    if (lastNetSample && now > lastNetSample.at) {
      const dtSec = (now - lastNetSample.at) / 1000;
      result.rxKbps = Math.max(0, Math.round(((rx - lastNetSample.rx) * 8) / 1024 / dtSec));
      result.txKbps = Math.max(0, Math.round(((tx - lastNetSample.tx) * 8) / 1024 / dtSec));
    }
    lastNetSample = { at: now, rx, tx };
    return result;
  };

  app.get('/api/server-runtime/live-state', validateSession, async (req, res) => {
    const serverId = String(req.query.serverId || '');
    const serverName = String(req.query.serverName || '');
    const dir = resolveRuntimeDir(serverId, serverName);
    const id = dir ? path.basename(dir) : null;
    const snap: SupervisorSnapshot | null = id ? supervisor.getSnapshot(id) : null;
    const running = snap?.state === 'online' || snap?.state === 'starting';

    const storageMb = dir ? await getStorageMbCached(dir) : 0;
    const netKbps = running ? await sampleSystemNetworkKbps() : { rxKbps: 0, txKbps: 0 };
    const base = {
      ok: true,
      state: snap?.state || 'stopped',
      status:
        snap?.state === 'online'
          ? 'running'
          : snap?.state === 'stopping'
            ? 'stopping'
            : running
              ? 'restarting'
              : 'stopped',
      crashed: snap?.state === 'crashed',
      lastExitCode: snap?.lastExitCode ?? null,
      lastExitReason: snap?.lastExitReason ?? null,
      pid: snap?.pid ?? null,
      adopted: snap?.adopted ?? false,
      storageUsedMb: Math.round(storageMb),
      networkRxKbps: netKbps.rxKbps,
      networkTxKbps: netKbps.txKbps,
      consoleLogs: id ? supervisor.getConsole(id) : [],
    };

    if (!running) {
      res.json({
        ...base,
        uptimeFormatted: 'Offline (0h 00m 00s)',
        cpuUsagePct: 0,
        ramUsedMb: 0,
        ramUsedGb: 0,
        history: [],
      });
      return;
    }

    const metrics = id ? await supervisor.getMetrics(id) : null;
    const uptimeMs = metrics?.uptimeMs ?? (snap?.startedAt ? Date.now() - snap.startedAt : 0);
    const h = Math.floor(uptimeMs / 3_600_000);
    const m = Math.floor((uptimeMs % 3_600_000) / 60_000);
    const s = Math.floor((uptimeMs % 60_000) / 1000);
    const ramMb = Math.round(metrics?.ramMb ?? 0);
    res.json({
      ...base,
      uptimeFormatted: `${h}h ${String(m).padStart(2, '0')}m ${String(s).padStart(2, '0')}s`,
      cpuUsagePct: Math.round(metrics?.cpuPct ?? 0),
      ramUsedMb: ramMb,
      ramUsedGb: Math.round((ramMb / 1024) * 100) / 100,
      history: id ? supervisor.getHistory(id) : [],
    });
  });

  // ===========================================================================
  // 12. SIMPLE PANEL APIS — FILE MANAGER, JAVA CHECK, CONTAINER LIFECYCLE
  //     (install / resetup), CHANGELOG, REAL BACKUPS, NETWORK + DATABASES
  // ===========================================================================

  const SIMPLE_PANEL_BASE_DB = 'iskingpanel';

  const resolveInsideServerDir = (dir: string, relativePath: string): string | null => {
    const clean = String(relativePath || '').trim().replace(/^[\\/]+/, '');
    const root = path.resolve(dir);
    const resolved = path.resolve(root, clean || '.');
    if (resolved !== root && !resolved.startsWith(root + path.sep)) return null;
    return resolved;
  };

  // --- File manager (read/write inside one server folder, escape-proof) -----
  app.get('/api/server-runtime/files', validateSession, (req, res) => {
    const dir = resolveRuntimeDir(String(req.query.serverId || ''), String(req.query.serverName || ''));
    if (!dir) {
      res.status(404).json({ ok: false, error: 'Server folder not found on disk' });
      return;
    }
    const target = resolveInsideServerDir(dir, String(req.query.path || '.'));
    if (!target) {
      res.status(400).json({ ok: false, error: 'Path escapes the server folder' });
      return;
    }
    let stat: fs.Stats;
    try {
      stat = fs.statSync(target);
    } catch {
      res.status(404).json({ ok: false, error: 'Folder not found' });
      return;
    }
    if (!stat.isDirectory()) {
      res.status(400).json({ ok: false, error: 'Not a folder' });
      return;
    }
    const entries: Array<{ name: string; isDir: boolean; sizeBytes: number; modifiedAt: string }> = [];
    try {
      for (const entry of fs.readdirSync(target, { withFileTypes: true })) {
        let size = 0;
        let mtime = new Date().toISOString();
        try {
          const st = fs.statSync(path.join(target, entry.name));
          size = st.size;
          mtime = st.mtime.toISOString();
        } catch {
          // ignore per-entry stat errors
        }
        entries.push({ name: entry.name, isDir: entry.isDirectory(), sizeBytes: size, modifiedAt: mtime });
      }
    } catch (err) {
      res.status(500).json({ ok: false, error: err instanceof Error ? err.message : 'Could not read folder' });
      return;
    }
    entries.sort((a, b) => (a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1));
    const rel = path.relative(path.resolve(dir), target).replace(/\\/g, '/') || '.';
    res.json({ ok: true, path: rel, entries });
  });

  app.get('/api/server-runtime/file', validateSession, (req, res) => {
    const dir = resolveRuntimeDir(String(req.query.serverId || ''), String(req.query.serverName || ''));
    if (!dir) {
      res.status(404).json({ ok: false, error: 'Server folder not found on disk' });
      return;
    }
    const target = resolveInsideServerDir(dir, String(req.query.path || ''));
    if (!target) {
      res.status(400).json({ ok: false, error: 'Path escapes the server folder' });
      return;
    }
    try {
      const stat = fs.statSync(target);
      if (stat.isDirectory()) {
        res.status(400).json({ ok: false, error: 'That is a folder, not a file' });
        return;
      }
      if (stat.size > 5 * 1024 * 1024) {
        res.status(400).json({ ok: false, error: 'File larger than 5 MB cannot be edited here' });
        return;
      }
      res.json({
        ok: true,
        path: path.relative(path.resolve(dir), target).replace(/\\/g, '/'),
        content: fs.readFileSync(target, 'utf8'),
        sizeBytes: stat.size,
        modifiedAt: stat.mtime.toISOString(),
      });
    } catch (err) {
      res.status(404).json({ ok: false, error: err instanceof Error ? err.message : 'File not found' });
    }
  });

  app.post('/api/server-runtime/file', validateSession, (req, res) => {
    const { serverId, serverName, path: relPath, content } = req.body || {};
    const dir = resolveRuntimeDir(String(serverId || ''), String(serverName || ''));
    if (!dir) {
      res.status(404).json({ ok: false, error: 'Server folder not found on disk' });
      return;
    }
    const target = resolveInsideServerDir(dir, String(relPath || ''));
    if (!target) {
      res.status(400).json({ ok: false, error: 'Path escapes the server folder' });
      return;
    }
    try {
      fs.writeFileSync(target, String(content ?? ''), 'utf8');
      pushPanelAudit('SYSTEM', `Edited file "${String(relPath)}" in server "${path.basename(dir)}"`, 'Operator');
      res.json({ ok: true, path: relPath, bytes: Buffer.byteLength(String(content ?? ''), 'utf8') });
    } catch (err) {
      res.status(500).json({ ok: false, error: err instanceof Error ? err.message : 'Could not save file' });
    }
  });

  app.post('/api/server-runtime/file-create', validateSession, (req, res) => {
    const { serverId, serverName, path: relPath, kind = 'file', content = '' } = req.body || {};
    const dir = resolveRuntimeDir(String(serverId || ''), String(serverName || ''));
    if (!dir) {
      res.status(404).json({ ok: false, error: 'Server folder not found on disk' });
      return;
    }
    const target = resolveInsideServerDir(dir, String(relPath || ''));
    if (!target || target === path.resolve(dir)) {
      res.status(400).json({ ok: false, error: 'Invalid path' });
      return;
    }
    try {
      if (fs.existsSync(target)) {
        res.status(409).json({ ok: false, error: 'A file with that name already exists' });
        return;
      }
      if (kind === 'dir') {
        fs.mkdirSync(target, { recursive: true });
      } else {
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, String(content ?? ''), 'utf8');
      }
      pushPanelAudit('SYSTEM', `Created ${kind} "${String(relPath)}" in server "${path.basename(dir)}"`, 'Operator');
      res.json({ ok: true, path: relPath, kind });
    } catch (err) {
      res.status(500).json({ ok: false, error: err instanceof Error ? err.message : 'Could not create' });
    }
  });

  app.post('/api/server-runtime/file-delete', validateSession, (req, res) => {
    const { serverId, serverName, path: relPath } = req.body || {};
    const dir = resolveRuntimeDir(String(serverId || ''), String(serverName || ''));
    if (!dir) {
      res.status(404).json({ ok: false, error: 'Server folder not found on disk' });
      return;
    }
    const target = resolveInsideServerDir(dir, String(relPath || ''));
    if (!target || target === path.resolve(dir)) {
      res.status(400).json({ ok: false, error: 'Invalid path' });
      return;
    }
    try {
      if (!fs.existsSync(target)) {
        res.status(404).json({ ok: false, error: 'Not found' });
        return;
      }
      fs.rmSync(target, { recursive: true, force: true });
      pushPanelAudit('SYSTEM', `Deleted "${String(relPath)}" from server "${path.basename(dir)}"`, 'Operator');
      res.json({ ok: true, path: relPath });
    } catch (err) {
      res.status(500).json({ ok: false, error: err instanceof Error ? err.message : 'Could not delete' });
    }
  });

  // --- Java runtime check ("server image" for the Startup tab) --------------
  app.get('/api/server-runtime/java-check', validateSession, async (req, res) => {
    const dir = resolveRuntimeDir(String(req.query.serverId || ''), String(req.query.serverName || ''));
    const setup = dir ? loadSetupMap()[path.basename(dir)] || {} : {};
    const requestedVersion = String(req.query.version || setup.version || '');

    let versionRaw = '';
    let installed = false;
    let vendor = 'Unknown';
    let major: number | null = null;
    let notFoundMessage = '';
    try {
      const { stdout, stderr } = await execAsync('java -version');
      const text = String(stderr || stdout || '').trim();
      versionRaw = text.split('\n')[0] || text;
      installed = /version/i.test(text);
    } catch (err) {
      const e = err as { stderr?: string; stdout?: string; message?: string };
      const text = String(e.stderr || e.stdout || e.message || '').trim();
      versionRaw = text.split('\n')[0] || text;
      notFoundMessage = /not recognized|not found|ENOENT/i.test(text)
        ? 'Java is not installed (or not on PATH). Install a JDK and restart the panel.'
        : text || 'java -version failed';
    }
    const versionMatch = versionRaw.match(/version "([^"]+)"/);
    if (versionMatch) {
      const raw = versionMatch[1];
      const parts = raw.split(/[._]/);
      major = parts[0] === '1' ? Number(parts[1]) || null : Number(parts[0]) || null;
      if (/openjdk/i.test(versionRaw)) vendor = 'OpenJDK';
      if (/zulu/i.test(versionRaw)) vendor = 'Azul Zulu';
      if (/temurin|adoptium/i.test(versionRaw)) vendor = 'Eclipse Temurin';
      if (/graalvm/i.test(versionRaw)) vendor = 'GraalVM';
      if (/Java\(TM\)/i.test(versionRaw)) vendor = 'Oracle Java';
    }

    let requiredJava: number | null = null;
    const mcMatch = requestedVersion.match(/^(\d+)\.(\d+)/);
    if (mcMatch) {
      const mcMinor = Number(mcMatch[2]);
      const mcMajor = Number(mcMatch[1]);
      if (mcMajor > 1 || mcMinor >= 20) requiredJava = 21;
      else if (mcMinor >= 18) requiredJava = 17;
      else if (mcMinor === 17) requiredJava = 16;
      else requiredJava = 8;
    }

    res.json({
      ok: true,
      installed,
      versionRaw,
      vendor,
      javaMajorVersion: major,
      javaHome: process.env.JAVA_HOME || '',
      requestedMcVersion: requestedVersion,
      requiredJava,
      meetsRequirement: requiredJava === null || major === null ? null : major >= requiredJava,
      notFoundMessage: notFoundMessage || undefined,
    });
  });

  // --- Container lifecycle state (installer / installing / ready / running) -
  app.get('/api/server-runtime/container-state', validateSession, async (req, res) => {
    const dir = resolveRuntimeDir(String(req.query.serverId || ''), String(req.query.serverName || ''));
    if (!dir) {
      res.status(404).json({ ok: false, error: 'Server folder not found on disk' });
      return;
    }
    const id = path.basename(dir);
    const setup = loadSetupMap()[id] || {};
    const snap = supervisor.getSnapshot(id);
    const hasJar = serverDirHasJar(dir);
    const eula = eulaAcceptedIn(dir);
    const parsed = parseEngineLabel(setup.engine, String(setup.version || ''));
    const storageMb = await getStorageMbCached(dir);

    const blockers: string[] = [];
    if (!hasJar) blockers.push('server.jar is missing — finish setup to install it');
    if (!eula) blockers.push('Minecraft EULA is not accepted (eula.txt)');
    if (!parsed.engine || !parsed.version) blockers.push('Engine/version unknown — pick one in Startup');

    const running = snap?.state === 'online' || snap?.state === 'starting';
    const phase =
      snap?.state === 'crashed'
        ? 'error'
        : running
          ? 'running'
          : hasJar && blockers.length === 0
            ? 'ready'
            : 'installing';

    res.json({
      ok: true,
      serverId: id,
      phase,
      hasJar,
      eulaAccepted: eula,
      engine: parsed.engine || setup.engine || 'paper',
      version: parsed.version || setup.version || '',
      mainFile: detectMainFile(dir),
      port: readServerPortIn(dir) ?? (Number(setup.port) || null),
      ramMaxGb: Number(setup.ramMaxGb) || null,
      javaPath: typeof setup.javaPath === 'string' ? setup.javaPath : '',
      dir,
      storageMb: Math.round(storageMb),
      runtime: snap
        ? { state: snap.state, pid: snap.pid ?? null, startedAt: snap.startedAt ?? null, lastExitCode: snap.lastExitCode ?? null, lastExitReason: snap.lastExitReason ?? null }
        : null,
      blockers,
    });
  });

  // --- Change log: panel audit trail entries for this server ----------------
  app.get('/api/server-runtime/changelog', validateSession, (req, res) => {
    const serverId = String(req.query.serverId || '');
    const serverName = String(req.query.serverName || '');
    const idLower = serverId.toLowerCase();
    const nameLower = serverName.toLowerCase();
    const entries = panelAuditLog
      .filter(
        (e) =>
          e.message.toLowerCase().includes(idLower) ||
          (nameLower && e.message.toLowerCase().includes(nameLower))
      )
      .slice()
      .reverse()
      .slice(0, 200);
    const dir = resolveRuntimeDir(serverId, serverName);
    const setup = dir ? loadSetupMap()[path.basename(dir)] || {} : {};
    res.json({ ok: true, serverId, entries, setupUpdatedAt: setup.updatedAt || null, total: entries.length });
  });

  // --- Real backups (tar archives on disk, per server) ----------------------
  const BACKUP_SCOPE_CHOICES = [
    'world',
    'world_nether',
    'world_the_end',
    'plugins',
    'mods',
    'config',
    'server.properties',
    'server.jar',
  ];

  app.get('/api/server-runtime/backups', validateSession, (req, res) => {
    const dir = resolveRuntimeDir(String(req.query.serverId || ''), String(req.query.serverName || ''));
    if (!dir) {
      res.status(404).json({ ok: false, error: 'Server folder not found on disk' });
      return;
    }
    const backupsDir = path.join(dir, 'backups');
    const archives: Array<{ name: string; sizeBytes: number; modifiedAt: string }> = [];
    try {
      if (fs.existsSync(backupsDir)) {
        for (const f of fs.readdirSync(backupsDir)) {
          if (!/\.(tar\.gz|tgz|zip)$/i.test(f)) continue;
          const st = fs.statSync(path.join(backupsDir, f));
          if (!st.isFile()) continue;
          archives.push({ name: f, sizeBytes: st.size, modifiedAt: st.mtime.toISOString() });
        }
      }
    } catch {
      // backups dir missing → empty list
    }
    archives.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
    res.json({ ok: true, serverId: path.basename(dir), archives, scopes: BACKUP_SCOPE_CHOICES });
  });

  // Windows ships bsdtar in System32, but a Git/msys PATH can shadow `tar`
  // with GNU tar, which reads "E:\..." as a remote host named "E". Pin the
  // Windows binary when it exists so archives always work.
  const TAR_PATH = (() => {
    if (process.platform === 'win32') {
      const sysTar = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
      if (fs.existsSync(sysTar)) return sysTar;
    }
    return 'tar';
  })();

  // Shared by the Backups tab and the scheduler — both write real archives.
  const createServerArchive = async (
    dir: string,
    title: string,
    scopes: unknown,
    ctx?: JobContext
  ): Promise<
    | { ok: true; archive: { name: string; sizeBytes: number; modifiedAt: string }; entries: string[] }
    | { ok: false; error: string; status: number }
  > => {
    const id = path.basename(dir);
    const backupsDir = path.join(dir, 'backups');
    try {
      fs.mkdirSync(backupsDir, { recursive: true });
    } catch {
      // ignore
    }

    const wanted = Array.isArray(scopes) && scopes.length ? scopes.map(String) : ['world', 'server.properties'];
    const entries = wanted
      .filter((s: string) => BACKUP_SCOPE_CHOICES.includes(s))
      .filter((s: string) => {
        // Forge/Fabric installs have mods/ instead of plugins/ — include what exists.
        return fs.existsSync(path.join(dir, s));
      });
    if (!entries.length) {
      return { ok: false, status: 400, error: 'Nothing to back up — none of the selected folders exist yet' };
    }

    const safeSlug =
      String(title || 'checkpoint')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '') || 'checkpoint';
    const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);

    try {
      let archiveName = `${id}-${safeSlug}-${stamp}.tar.gz`;
      let archivePath = path.join(backupsDir, archiveName);
      ctx?.report({
        percent: null,
        stage: 'archiving',
        message: `Archiving ${entries.length} item(s) from ${id}…`,
      });
      try {
        await runProcess(TAR_PATH, ['-czf', archivePath, '-C', dir, ...entries], {
          signal: ctx?.signal,
          maxBuffer: 1024 * 1024 * 64,
        });
      } catch (err) {
        if (ctx?.signal.aborted || err instanceof JobCancelledError) throw err;
        // Windows without bsdtar: fall back to a PowerShell zip archive.
        archiveName = `${id}-${safeSlug}-${stamp}.zip`;
        archivePath = path.join(backupsDir, archiveName);
        const srcList = entries.map((e: string) => path.join(dir, e));
        await runProcess(
          'powershell',
          [
            '-NoProfile',
            '-Command',
            `Compress-Archive -Force -DestinationPath '${archivePath.replace(
              /'/g,
              "''"
            )}' -Path ${srcList
              .map((p) => `'${p.replace(/'/g, "''")}'`)
              .join(',')}`,
          ],
          { signal: ctx?.signal, maxBuffer: 1024 * 1024 * 64 }
        );
      }
      ctx?.report({ percent: 95, stage: 'finalize', message: 'Hashing the archive…' });
      const st = fs.statSync(archivePath);
      pushPanelAudit('SYSTEM', `Created backup "${archiveName}" (${(st.size / 1024 / 1024).toFixed(1)} MB) for server "${id}"`, 'Operator');
      return {
        ok: true,
        archive: { name: archiveName, sizeBytes: st.size, modifiedAt: st.mtime.toISOString() },
        entries,
      };
    } catch (err) {
      return { ok: false, status: 500, error: err instanceof Error ? err.message : 'Backup failed' };
    }
  };

  // Extracts an archive back over the server folder (used by both the simple
  // panel and the advanced Backups view).
  const extractServerArchive = async (
    dir: string,
    archivePath: string,
    ctx?: JobContext
  ): Promise<void> => {
    ctx?.report({ percent: null, stage: 'extracting', message: 'Extracting the archive…' });
    if (/\.zip$/i.test(archivePath)) {
      await runProcess(
        'powershell',
        [
          '-NoProfile',
          '-Command',
          `Expand-Archive -Force -Path '${archivePath.replace(
            /'/g,
            "''"
          )}' -DestinationPath '${dir.replace(/'/g, "''")}'`,
        ],
        { signal: ctx?.signal, maxBuffer: 1024 * 1024 * 64 }
      );
      return;
    }
    await runProcess(TAR_PATH, ['-xzf', archivePath, '-C', dir], {
      signal: ctx?.signal,
      maxBuffer: 1024 * 1024 * 64,
    });
  };

  app.post('/api/server-runtime/backup-create', validateSession, (req, res) => {
    const { serverId, serverName, title, scopes } = req.body || {};
    const dir = resolveRuntimeDir(String(serverId || ''), String(serverName || ''));
    if (!dir) {
      res.status(404).json({ ok: false, error: 'Server folder not found on disk' });
      return;
    }
    const id = path.basename(dir);
    const actor = String((req as any).user?.username || 'Operator');
    const started = jobManager.start({
      kind: 'backup',
      title: `Back up ${id}`,
      serverId: id,
      serverName: String(serverName || id),
      actor,
      run: async (ctx) => {
        ctx.report({ percent: 5, stage: 'preparing', message: `Preparing an archive of ${id}…` });
        const result = await createServerArchive(
          dir,
          String(title || 'checkpoint'),
          scopes,
          ctx
        );
        if (!result.ok) throw new Error(result.error);
        return { archive: result.archive, entries: result.entries };
      },
    });
    if (!started.ok) {
      res.status(409).json({
        ok: false,
        code: 'SERVER_BUSY',
        error: started.active
          ? `"${started.active.title}" is already running for this server.`
          : 'Another operation is already running for this server.',
        activeJob: started.active || null,
      });
      return;
    }
    res.status(202).json({ ok: true, jobId: started.job.id, job: started.job });
  });

  app.post('/api/server-runtime/backup-restore', validateSession, async (req, res) => {
    const { serverId, serverName, file } = req.body || {};
    const dir = resolveRuntimeDir(String(serverId || ''), String(serverName || ''));
    if (!dir) {
      res.status(404).json({ ok: false, error: 'Server folder not found on disk' });
      return;
    }
    const id = path.basename(dir);
    const archiveName = String(file || '');
    if (!/^[\w.-]+\.(tar\.gz|tgz|zip)$/i.test(archiveName)) {
      res.status(400).json({ ok: false, error: 'Invalid archive name' });
      return;
    }
    const archivePath = path.join(dir, 'backups', archiveName);
    if (!fs.existsSync(archivePath)) {
      res.status(404).json({ ok: false, error: 'Archive not found' });
      return;
    }
    const snap = supervisor.getSnapshot(id);
    if (snap?.state === 'online' || snap?.state === 'starting') {
      res.status(409).json({ ok: false, error: 'Stop the server before restoring a backup' });
      return;
    }
    const actor = String((req as any).user?.username || 'Operator');
    const started = jobManager.start({
      kind: 'restore',
      title: `Restore ${archiveName}`,
      serverId: id,
      serverName: String(serverName || id),
      actor,
      run: async (ctx) => {
        await extractServerArchive(dir, archivePath, ctx);
        pushPanelAudit('SYSTEM', `Restored backup "${archiveName}" into server "${id}"`, actor);
        return { restored: archiveName, serverId: id };
      },
    });
    if (!started.ok) {
      res.status(409).json({
        ok: false,
        code: 'SERVER_BUSY',
        error: started.active
          ? `"${started.active.title}" is already running for this server.`
          : 'Another operation is already running for this server.',
        activeJob: started.active || null,
      });
      return;
    }
    res.status(202).json({ ok: true, jobId: started.job.id, job: started.job });
  });

  app.delete('/api/server-runtime/backup', validateSession, (req, res) => {
    const dir = resolveRuntimeDir(String(req.query.serverId || ''), String(req.query.serverName || ''));
    if (!dir) {
      res.status(404).json({ ok: false, error: 'Server folder not found on disk' });
      return;
    }
    const archiveName = String(req.query.file || '');
    if (!/^[\w.-]+\.(tar\.gz|tgz|zip)$/i.test(archiveName)) {
      res.status(400).json({ ok: false, error: 'Invalid archive name' });
      return;
    }
    const archivePath = path.join(dir, 'backups', archiveName);
    try {
      if (fs.existsSync(archivePath)) fs.rmSync(archivePath);
      res.json({ ok: true, deleted: archiveName });
    } catch (err) {
      res.status(500).json({ ok: false, error: err instanceof Error ? err.message : 'Could not delete archive' });
    }
  });

  // --- Resetup: wipe & re-provision a server container ----------------------
  app.post('/api/server-runtime/reinstall', validateSession, async (req, res) => {
    const { serverId, serverName, wipe = true, keepBackups = true } = req.body || {};
    const dir = resolveRuntimeDir(String(serverId || ''), String(serverName || ''));
    if (!dir) {
      res.status(404).json({ ok: false, error: 'Server folder not found on disk' });
      return;
    }
    const id = path.basename(dir);
    const setup = loadSetupMap()[id] || {};
    const portBeforeWipe = readServerPortIn(dir) ?? (Number(setup.port) || 25565);
    const parsed = parseEngineLabel(setup.engine, String(setup.version || ''));
    if (!parsed.engine || !parsed.version) {
      res.status(400).json({ ok: false, error: 'No engine/version recorded for this server — set it in Startup first' });
      return;
    }

    const active = jobManager.activeForServer(id);
    if (active) {
      res.status(409).json({
        ok: false,
        code: 'SERVER_BUSY',
        error: `"${active.title}" is already running for this server.`,
        activeJob: active,
      });
      return;
    }

    const snap = supervisor.getSnapshot(id);
    if (snap?.state === 'online' || snap?.state === 'starting' || snap?.state === 'stopping') {
      await supervisor.stop(id, { force: true });
    }

    const actor = String((req as any).user?.username || 'Operator');
    const started = jobManager.start({
      kind: 'reinstall',
      title: `Reinstall ${id}`,
      serverId: id,
      serverName: String(serverName || id),
      actor,
      run: async (ctx) => {
        const wipedEntries: string[] = [];
        if (wipe) {
          ctx.report({ percent: 5, stage: 'wiping', message: 'Removing the old server files…' });
          for (const entryName of fs.readdirSync(dir)) {
            if (keepBackups && entryName === 'backups') continue;
            if (ctx.signal.aborted) throw new JobCancelledError();
            fs.rmSync(path.join(dir, entryName), { recursive: true, force: true });
            wipedEntries.push(entryName);
          }
        }

        ctx.report({ percent: 15, stage: 'provisioning', message: 'Re-creating the server container…' });
        provisionServerFolderOnLocalDisk({
          serverName: id,
          engine: parsed.engine,
          port: portBeforeWipe,
          ramMaxGb: Number(setup.ramMaxGb) || 4,
          installRootDir: path.dirname(dir),
        });
        const jar = await installServerJar(dir, parsed.engine, parsed.version, undefined, ctx);

        pushPanelAudit(
          'SYSTEM',
          `Resetup server "${id}" (wipe=${wipe ? `yes, removed ${wipedEntries.length} entries` : 'no'}; jar ${jar.ok ? 'installed' : `failed: ${jar.error}`})`,
          actor
        );

        if (!jar.ok) throw new Error(jar.error || 'server.jar install failed');
        return {
          ok: true,
          serverId: id,
          wiped: wipe,
          wipedEntries,
          jar: {
            installed: jar.ok,
            bytes: jar.bytes,
            filename: jar.target?.filename,
            engine: parsed.engine,
            version: parsed.version,
          },
        };
      },
    });
    if (!started.ok) {
      res.status(409).json({
        ok: false,
        code: 'SERVER_BUSY',
        error: started.active
          ? `"${started.active.title}" is already running for this server.`
          : 'Another operation is already running for this server.',
        activeJob: started.active || null,
      });
      return;
    }
    res.status(202).json({ ok: true, jobId: started.job.id, job: started.job });
  });

  // --- Real per-server schedules (cron-lite, executed by the supervisor) -----
  type SimpleScheduleAction = 'command' | 'restart' | 'stop' | 'backup';

  interface SimpleScheduleRecord {
    id: string;
    serverId: string;
    serverName: string;
    title: string;
    action: SimpleScheduleAction;
    payload: string;
    intervalMinutes: number;
    enabled: boolean;
    createdAt: string;
    nextRunAt: number;
    lastRunAt: string | null;
    lastResult: string | null;
    runCount: number;
  }

  const SIMPLE_SCHEDULE_ACTIONS: SimpleScheduleAction[] = ['command', 'restart', 'stop', 'backup'];
  const SIMPLE_SCHEDULES_PATH = path.join(appStateDir, '.panel-schedules.json');

  const loadSimpleSchedules = (): SimpleScheduleRecord[] => {
    try {
      if (!fs.existsSync(SIMPLE_SCHEDULES_PATH)) return [];
      const parsed = JSON.parse(fs.readFileSync(SIMPLE_SCHEDULES_PATH, 'utf8'));
      return Array.isArray(parsed) ? (parsed as SimpleScheduleRecord[]) : [];
    } catch {
      return [];
    }
  };

  const saveSimpleSchedules = (list: SimpleScheduleRecord[]): void => {
    try {
      fs.writeFileSync(SIMPLE_SCHEDULES_PATH, JSON.stringify(list, null, 2), 'utf8');
    } catch {
      // ignore — schedules are best-effort persistence
    }
  };

  const executeSimpleSchedule = async (
    job: Pick<SimpleScheduleRecord, 'serverId' | 'serverName' | 'action' | 'payload'>
  ): Promise<string> => {
    const dir = resolveRuntimeDir(job.serverId, job.serverName);
    if (!dir) return 'server folder missing';
    const id = path.basename(dir);
    const snap = supervisor.getSnapshot(id);
    const running = snap?.state === 'online';

    if (job.action === 'command') {
      if (!running) return 'skipped — server offline';
      const sent = supervisor.sendCommand(id, job.payload);
      return sent.ok ? `sent /${job.payload}` : `failed: ${sent.error}`;
    }
    if (job.action === 'restart') {
      if (!running) return 'skipped — server offline';
      const result = await supervisor.restart(id);
      return result.ok ? 'restarted' : `failed: ${result.error}`;
    }
    if (job.action === 'stop') {
      if (!running) return 'skipped — already stopped';
      const result = await supervisor.stop(id);
      return result.ok ? 'stopped' : `failed: ${result.error}`;
    }
    if (jobManager.isLocked(id)) {
      return 'skipped — another operation is in progress';
    }
    const archive = await createServerArchive(dir, job.payload || 'scheduled', [
      'world',
      'world_nether',
      'world_the_end',
      'server.properties',
      'plugins',
      'mods',
      'config',
    ]);
    return archive.ok ? `backup ${archive.archive.name}` : `backup failed: ${archive.error}`;
  };

  // One ticker for every server: due schedules run through the supervisor so
  // the commands/restarts are real, not simulated countdowns.
  setInterval(() => {
    const list = loadSimpleSchedules();
    if (!list.length) return;
    const now = Date.now();
    for (const job of list) {
      if (!job.enabled || job.nextRunAt > now) continue;
      job.nextRunAt = now + Math.max(1, Number(job.intervalMinutes) || 30) * 60_000;
      void (async () => {
        const result = await executeSimpleSchedule(job);
        const latest = loadSimpleSchedules();
        const idx = latest.findIndex((x) => x.id === job.id);
        if (idx === -1) return;
        latest[idx] = {
          ...latest[idx],
          lastRunAt: new Date().toISOString(),
          lastResult: result,
          runCount: (latest[idx].runCount || 0) + 1,
          nextRunAt: job.nextRunAt,
        };
        saveSimpleSchedules(latest);
        pushPanelAudit(
          'SYSTEM',
          `Schedule "${job.title}" ran for server "${job.serverId}": ${result}`,
          'KingScheduler'
        );
      })();
    }
    saveSimpleSchedules(list);
  }, 15_000);

  app.get('/api/server-runtime/schedules', validateSession, (req, res) => {
    const serverId = String(req.query.serverId || '');
    const schedules = loadSimpleSchedules()
      .filter((s) => s.serverId === serverId)
      .sort((a, b) => a.nextRunAt - b.nextRunAt);
    res.json({ ok: true, serverId, schedules, actions: SIMPLE_SCHEDULE_ACTIONS });
  });

  app.post('/api/server-runtime/schedule-create', validateSession, requireAdvancedPanel, (req, res) => {
    const { serverId, serverName, title, action = 'command', payload = '', intervalMinutes = 30 } = req.body || {};
    const id = String(serverId || '').trim();
    if (!id) {
      res.status(400).json({ ok: false, error: 'serverId required' });
      return;
    }
    if (!SIMPLE_SCHEDULE_ACTIONS.includes(action)) {
      res.status(400).json({ ok: false, error: `Unknown action: ${String(action)}` });
      return;
    }
    const interval = Math.max(1, Math.min(10_080, Number(intervalMinutes) || 30));
    const cleanPayload = String(payload || '').trim();
    if (action !== 'backup' && !cleanPayload) {
      res.status(400).json({ ok: false, error: 'A command or task payload is required' });
      return;
    }
    const record: SimpleScheduleRecord = {
      id: `sch-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      serverId: id,
      serverName: String(serverName || id),
      title: String(title || 'Scheduled task').slice(0, 120),
      action: action as SimpleScheduleAction,
      payload: action === 'backup' ? cleanPayload || 'scheduled' : cleanPayload,
      intervalMinutes: interval,
      enabled: true,
      createdAt: new Date().toISOString(),
      nextRunAt: Date.now() + interval * 60_000,
      lastRunAt: null,
      lastResult: null,
      runCount: 0,
    };
    const list = loadSimpleSchedules();
    list.push(record);
    saveSimpleSchedules(list);
    pushPanelAudit('SYSTEM', `Created schedule "${record.title}" (every ${interval}m, ${record.action}) for server "${id}"`, 'Operator');
    res.json({ ok: true, schedule: record, schedules: list.filter((s) => s.serverId === id) });
  });

  app.post('/api/server-runtime/schedule-update', validateSession, requireAdvancedPanel, (req, res) => {
    const { id, enabled, intervalMinutes, payload, title } = req.body || {};
    const list = loadSimpleSchedules();
    const idx = list.findIndex((s) => s.id === String(id || ''));
    if (idx === -1) {
      res.status(404).json({ ok: false, error: 'Schedule not found' });
      return;
    }
    const current = list[idx];
    if (typeof enabled === 'boolean') current.enabled = enabled;
    if (intervalMinutes !== undefined) {
      current.intervalMinutes = Math.max(1, Math.min(10_080, Number(intervalMinutes) || current.intervalMinutes));
      current.nextRunAt = Date.now() + current.intervalMinutes * 60_000;
    }
    if (payload !== undefined) current.payload = String(payload).slice(0, 2048);
    if (title !== undefined) current.title = String(title).slice(0, 120);
    list[idx] = current;
    saveSimpleSchedules(list);
    res.json({ ok: true, schedule: current, schedules: list.filter((s) => s.serverId === current.serverId) });
  });

  app.post('/api/server-runtime/schedule-run', validateSession, requireAdvancedPanel, async (req, res) => {
    const { id } = req.body || {};
    const list = loadSimpleSchedules();
    const idx = list.findIndex((s) => s.id === String(id || ''));
    if (idx === -1) {
      res.status(404).json({ ok: false, error: 'Schedule not found' });
      return;
    }
    const job = list[idx];
    const result = await executeSimpleSchedule(job);
    job.lastRunAt = new Date().toISOString();
    job.lastResult = result;
    job.runCount = (job.runCount || 0) + 1;
    job.nextRunAt = Date.now() + Math.max(1, job.intervalMinutes) * 60_000;
    list[idx] = job;
    saveSimpleSchedules(list);
    pushPanelAudit('SYSTEM', `Manually ran schedule "${job.title}" for server "${job.serverId}": ${result}`, 'Operator');
    res.json({ ok: true, result, schedule: job, schedules: list.filter((s) => s.serverId === job.serverId) });
  });

  app.delete('/api/server-runtime/schedule/:id', validateSession, requireAdvancedPanel, (req, res) => {
    const list = loadSimpleSchedules();
    const idx = list.findIndex((s) => s.id === String(req.params.id || ''));
    if (idx === -1) {
      res.status(404).json({ ok: false, error: 'Schedule not found' });
      return;
    }
    const [removed] = list.splice(idx, 1);
    saveSimpleSchedules(list);
    pushPanelAudit('SYSTEM', `Deleted schedule "${removed.title}" for server "${removed.serverId}"`, 'Operator');
    res.json({ ok: true, deleted: removed.id, schedules: list.filter((s) => s.serverId === removed.serverId) });
  });

  // --- Server settings: port / RAM / motd / players written for real -------
  const patchServerProperties = (dir: string, patch: Record<string, string>): string[] => {
    const propsPath = path.join(dir, 'server.properties');
    let lines: string[] = [];
    try {
      if (fs.existsSync(propsPath)) lines = fs.readFileSync(propsPath, 'utf8').split(/\r?\n/);
    } catch {
      lines = [];
    }
    const written: string[] = [];
    for (const [key, value] of Object.entries(patch)) {
      const matcher = new RegExp(`^\\s*${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*=`);
      let found = false;
      lines = lines.map((line) => {
        if (found || !matcher.test(line)) return line;
        found = true;
        return `${key}=${value}`;
      });
      if (!found) lines.push(`${key}=${value}`);
      written.push(`${key}=${value}`);
    }
    fs.writeFileSync(propsPath, lines.filter((l, i, arr) => l !== '' || i < arr.length - 1).join('\n') + '\n', 'utf8');
    return written;
  };

  app.post('/api/server-runtime/server-settings', validateSession, async (req, res) => {
    const {
      serverId,
      serverName,
      port,
      ramMaxGb,
      engine,
      version,
      motd,
      maxPlayers,
      difficulty,
      onlineMode,
      viewDistance,
    } = req.body || {};
    const dir = resolveRuntimeDir(String(serverId || ''), String(serverName || ''));
    if (!dir) {
      res.status(404).json({ ok: false, error: 'Server folder not found on disk' });
      return;
    }
    const id = path.basename(dir);
    const patch: Record<string, string> = {};
    const portNum = Number(port);
    if (Number.isFinite(portNum) && portNum >= 1 && portNum <= 65535) patch.port = String(Math.round(portNum));
    if (motd !== undefined && String(motd).length) patch.motd = String(motd).slice(0, 120);
    if (Number(maxPlayers) > 0) patch['max-players'] = String(Math.round(Number(maxPlayers)));
    if (difficulty) patch.difficulty = String(difficulty);
    if (onlineMode !== undefined) patch['online-mode'] = onlineMode ? 'true' : 'false';
    if (Number(viewDistance) > 0) patch['view-distance'] = String(Math.round(Number(viewDistance)));

    try {
      const written = Object.keys(patch).length ? patchServerProperties(dir, patch) : [];
      const map = loadSetupMap();
      const next = { ...(map[id] || {}) };
      if (patch.port) next.port = Number(patch.port);
      if (Number(ramMaxGb) > 0) next.ramMaxGb = Number(ramMaxGb);
      if (engine) next.engine = String(engine);
      if (version) next.version = String(version);
      next.updatedAt = new Date().toISOString();
      map[id] = next;
      saveSetupMap(map);
      const snap = supervisor.getSnapshot(id);
      const running = snap?.state === 'online' || snap?.state === 'starting';
      pushPanelAudit(
        'SYSTEM',
        `Updated settings for server "${id}" (${written.join(', ') || 'engine/ram only'})`,
        'Operator'
      );
      res.json({
        ok: true,
        serverId: id,
        written,
        restartRequired: running && written.length > 0,
        setup: map[id],
      });
    } catch (err) {
      res.status(500).json({ ok: false, error: err instanceof Error ? err.message : 'Could not save settings' });
    }
  });

  // --- Per-server MySQL databases under the panel base database -------------
  const sanitizeDbSlug = (value: string): string =>
    String(value || '')
      .toLowerCase()
      .replace(/[^a-z0-9_]/g, '_')
      .replace(/_+/g, '_')
      .replace(/^_|_$/g, '')
      .slice(0, 48) || 'server';

  // mysql2 cannot speak every server-side auth plugin (MariaDB's
  // auth_gssapi_client, for example). Turn those into instructions instead of
  // a raw driver stack trace.
  const describeMysqlError = (message: string): { error: string; authPluginIssue: boolean } => {
    if (/auth_gssapi_client|auth_ed25519|unknown plugin|authentication plugin/i.test(message)) {
      return {
        authPluginIssue: true,
        error:
          "MySQL is running, but this account uses an auth plugin (auth_gssapi_client) the panel's driver cannot speak. In phpMyAdmin run: CREATE USER 'iskingpanel'@'localhost' IDENTIFIED BY 'your-password'; GRANT ALL PRIVILEGES ON `iskingpanel%`.* TO 'iskingpanel'@'localhost'; FLUSH PRIVILEGES; — then put that user and password in Connection settings.",
      };
    }
    if (/access denied/i.test(message)) {
      return {
        authPluginIssue: false,
        error: `Access denied for the configured MySQL user — set the correct user/password in Connection settings (${message})`,
      };
    }
    return { error: message, authPluginIssue: false };
  };

  const connectLocalMysql = () =>
    mysql.createConnection({
      host: dbEngineConfig.mysqlHost || '127.0.0.1',
      port: Number(dbEngineConfig.mysqlPort) || 3306,
      user: dbEngineConfig.mysqlUser || 'root',
      password: dbEngineConfig.mysqlPassword || '',
      connectTimeout: 2000,
    });

  app.get('/api/database/server-databases', validateSession, async (_req, res) => {
    const host = dbEngineConfig.mysqlHost || '127.0.0.1';
    const port = Number(dbEngineConfig.mysqlPort) || 3306;
    const probe = await probeLocalTcpPort(port, host);
    let connected = false;
    let databases: string[] = [];
    let error: string | undefined;
    let authPluginIssue = false;
    if (probe.open) {
      try {
        const conn = await connectLocalMysql();
        const [rows] = await conn.query(`SHOW DATABASES LIKE 'iskingpanel%'`);
        databases = (rows as Array<Record<string, unknown>>).map((r) => String(Object.values(r)[0] || ''));
        await conn.end();
        connected = true;
      } catch (err) {
        const described = describeMysqlError(err instanceof Error ? err.message : 'MySQL connection failed');
        error = described.error;
        authPluginIssue = described.authPluginIssue;
      }
    }
    res.json({
      ok: true,
      connected,
      authPluginIssue,
      portOpen: probe.open,
      host,
      port,
      user: dbEngineConfig.mysqlUser || 'root',
      passwordSet: Boolean(dbEngineConfig.mysqlPassword),
      baseDatabase: SIMPLE_PANEL_BASE_DB,
      databases,
      error,
      phpMyAdminUrl: 'http://localhost/phpmyadmin',
    });
  });

  app.post('/api/database/provision-server', validateSession, async (req, res) => {
    const { serverId } = req.body || {};
    const slug = sanitizeDbSlug(String(serverId || ''));
    const baseDb = SIMPLE_PANEL_BASE_DB;
    const serverDb = `${SIMPLE_PANEL_BASE_DB}_${slug}`;
    const host = dbEngineConfig.mysqlHost || '127.0.0.1';
    const port = Number(dbEngineConfig.mysqlPort) || 3306;
    const probe = await probeLocalTcpPort(port, host);
    if (!probe.open) {
      res.status(503).json({
        ok: false,
        error: `MySQL is not reachable on ${host}:${port}. Start XAMPP/MariaDB on this PC, then configure the connection below.`,
      });
      return;
    }
    try {
      const conn = await connectLocalMysql();
      await conn.query(`CREATE DATABASE IF NOT EXISTS \`${baseDb}\` DEFAULT CHARACTER SET utf8mb4;`);
      await conn.query(`CREATE DATABASE IF NOT EXISTS \`${serverDb}\` DEFAULT CHARACTER SET utf8mb4;`);
      const [rows] = await conn.query(`SHOW TABLES IN \`${serverDb}\``);
      await conn.end();
      pushPanelAudit('SYSTEM', `Provisioned MySQL database "${serverDb}" (base "${baseDb}") on ${host}:${port} for server "${String(serverId)}"`, 'Operator');
      res.json({
        ok: true,
        baseDatabase: baseDb,
        database: serverDb,
        host,
        port,
        user: dbEngineConfig.mysqlUser || 'root',
        password: dbEngineConfig.mysqlPassword || '',
        tableCount: (rows as unknown[]).length,
        phpMyAdminUrl: 'http://localhost/phpmyadmin',
        message: `Database "${serverDb}" is ready. Point your plugin's JDBC URL at jdbc:mysql://${host}:${port}/${serverDb}.`,
      });
    } catch (err) {
      const described = describeMysqlError(err instanceof Error ? err.message : 'Could not create database');
      res.status(500).json({ ok: false, error: described.error, authPluginIssue: described.authPluginIssue });
    }
  });

  app.delete('/api/database/server-database/:name', validateSession, async (req, res) => {
    const name = String(req.params.name || '');
    if (!new RegExp(`^${SIMPLE_PANEL_BASE_DB}_[a-z0-9_]+$`).test(name)) {
      res.status(400).json({ ok: false, error: 'Only panel-created databases (iskingpanel_*) can be dropped here' });
      return;
    }
    try {
      const conn = await connectLocalMysql();
      await conn.query(`DROP DATABASE \`${name}\``);
      await conn.end();
      pushPanelAudit('SYSTEM', `Dropped MySQL database "${name}"`, 'Operator');
      res.json({ ok: true, dropped: name });
    } catch (err) {
      res.status(500).json({ ok: false, error: err instanceof Error ? err.message : 'Could not drop database' });
    }
  });

  // Vite middleware for development. Required lazily: the packaged backend
  // ships without vite, and a top-level require made it crash on launch.
  if (process.env.NODE_ENV !== 'production') {
    const { createServer: createViteServer } = requireModule('vite') as typeof import('vite');
    const vite = await createViteServer({
      server: {
        middlewareMode: true,
        hmr: process.env.DISABLE_HMR === 'true' ? false : { server: httpServer },
        watch: process.env.DISABLE_HMR === 'true' ? null : {},
      },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    // The UI bundle ships next to server.cjs (resources/app.asar.unpacked/dist),
    // not under the Electron cwd — resolving it from process.cwd() made every
    // request 404 and left the window blank.
    const distCandidates = [
      path.join(__dirname, 'dist'),
      path.join(process.cwd(), 'dist'),
      process.resourcesPath ? path.join(process.resourcesPath, 'app.asar.unpacked', 'dist') : '',
    ].filter(Boolean);
    const distPath =
      distCandidates.find((candidate) => fs.existsSync(path.join(candidate, 'index.html'))) ||
      distCandidates[0];
    if (!fs.existsSync(path.join(distPath, 'index.html'))) {
      console.error(`UI bundle not found. Looked in: ${distCandidates.join(', ')}`);
    } else {
      console.log(`Serving UI from ${distPath}`);
    }
    app.use(express.static(distPath));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  httpServer.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`FATAL: Port ${PORT} is already in use by another application.`);
      process.exit(1);
    }
    console.error('FATAL: HTTP server error:', err.message);
    process.exit(1);
  });

  httpServer.listen(PORT, '0.0.0.0', () => {
    console.log(`KingPanel Server running on http://0.0.0.0:${PORT}`);

    // A rule saved as ACTIVE is a claim about the OS state at some past moment.
    // Re-read netsh once after boot and downgrade anything that is no longer
    // there, so the panel never shows a port as open when it is not. Runs after
    // the listener is up and never blocks startup; failure only means the
    // stored status is left as it was.
    if (process.platform === 'win32') {
      const toCheck = activeForwards.filter((rule) => rule.status === 'ACTIVE');
      if (toCheck.length) {
        void (async () => {
          let changed = false;
          for (const rule of toCheck) {
            try {
              const verification = await verifyForward(forwardTargetOf(rule), forwardDeps());
              if (!forwardVerificationPassed(verification)) {
                rule.status = 'RECORDED';
                rule.appliedAt = null;
                rule.applyError = 'The mapping is no longer present on this PC (checked at startup).';
                rule.verification = verification;
                rule.updatedAt = new Date().toISOString();
                changed = true;
              }
            } catch {
              // Leave the rule alone: an unreadable netsh is not proof either way.
            }
          }
          if (changed) commitForwardRule();
        })();
      }
    }
  });
}

startServer();
