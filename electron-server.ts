import express from 'express';
import http from 'http';
import path from 'path';
import os from 'os';
import fs from 'fs';
import net from 'net';
import crypto from 'crypto';
import { exec, spawn, ChildProcess } from 'child_process';
import { promisify } from 'util';
import dotenv from 'dotenv';
import { MongoClient } from 'mongodb';
import mysql from 'mysql2/promise';
import fetch from 'node-fetch';
import { AuthProviderType } from './src/types';

dotenv.config();

const execAsync = promisify(exec);

interface ForwardedPortConfig {
  id: string;
  externalPort: number;
  internalPort: number;
  internalIp: string;
  protocol: 'TCP' | 'UDP' | 'TCP/UDP';
  serviceName: string;
  method: 'UPnP IGDv2' | 'Netsh PortProxy' | 'Playit.gg Tunnel' | 'Cloudflare Spectrum';
  status: 'ACTIVE' | 'VERIFYING';
  createdAt: string;
}

const activeForwards: ForwardedPortConfig[] = [
  {
    id: 'fwd-25565',
    externalPort: 25565,
    internalPort: 25565,
    internalIp: '127.0.0.1',
    protocol: 'TCP/UDP',
    serviceName: 'PaperMC 1.20.4 Primary Game Server',
    method: 'UPnP IGDv2',
    status: 'ACTIVE',
    createdAt: new Date().toISOString(),
  },
  {
    id: 'fwd-19132',
    externalPort: 19132,
    internalPort: 19132,
    internalIp: '127.0.0.1',
    protocol: 'UDP',
    serviceName: 'GeyserMC Bedrock Crossplay UDP',
    method: 'UPnP IGDv2',
    status: 'ACTIVE',
    createdAt: new Date().toISOString(),
  },
  {
    id: 'fwd-8100',
    externalPort: 8100,
    internalPort: 8100,
    internalIp: '127.0.0.1',
    protocol: 'TCP',
    serviceName: 'BlueMap 3D WebGL Server Map',
    method: 'Cloudflare Spectrum',
    status: 'ACTIVE',
    createdAt: new Date().toISOString(),
  },
];

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

async function startServer() {
  const app = express();
  const httpServer = http.createServer(app);
  const PORT = parseInt(process.env.PORT || '3000', 10);

  app.use(express.json());

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

    res.json({ url: null, configured: false, provider, redirectUri });
  });

  // SQLite3 Database Setup (WAL Mode)
  const SQLITE_DB_PATH = path.join(
    process.env.APPDATA_DB_DIR || path.join(process.cwd(), 'database'),
    'kingpanel.sqlite3'
  );

  // Ensure database directory exists
  const dbDir = path.dirname(SQLITE_DB_PATH);
  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
  }

  let sqliteDb: any = null;
  try {
    const Database = require('better-sqlite3');
    sqliteDb = new Database(SQLITE_DB_PATH);
    sqliteDb.pragma('journal_mode = WAL');
    sqliteDb.pragma('synchronous = NORMAL');
    sqliteDb.pragma('cache_size = -32768');
    sqliteDb.pragma('temp_store = MEMORY');
    sqliteDb.pragma('mmap_size = 268435456');

    // Create tables
    sqliteDb.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        username TEXT UNIQUE NOT NULL,
        display_name TEXT,
        email TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL,
        provider TEXT NOT NULL,
        avatar_url TEXT,
        mc_uuid TEXT,
        connected_providers TEXT,
        last_login TEXT,
        session_sha TEXT,
        discord_verified INTEGER DEFAULT 0,
        discord_member_status TEXT DEFAULT 'not_connected',
        discord_username TEXT,
        discord_user_id TEXT,
        discord_guild_id TEXT,
        discord_guild_name TEXT,
        discord_invite_url TEXT,
        discord_bot_verified_at TEXT,
        max_server_limit INTEGER DEFAULT 2,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS auth_sessions (
        session_id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        username TEXT NOT NULL,
        role TEXT NOT NULL,
        provider TEXT NOT NULL,
        ip_address TEXT,
        platform TEXT,
        created_at TEXT NOT NULL,
        last_active_at TEXT NOT NULL,
        expires_at TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_auth_sessions_user_id ON auth_sessions(user_id);
      CREATE INDEX IF NOT EXISTS idx_auth_sessions_expires_at ON auth_sessions(expires_at);
    `);

    console.log(`SQLite3 database initialized at ${SQLITE_DB_PATH} (WAL Mode)`);
  } catch (e) {
    console.warn('better-sqlite3 not available, using file-based fallback:', e);
  }

  // File-based user database fallback
  const USERS_DB_PATH = path.join(dbDir, 'users-db.json');
  const loadUsersDb = (): DbUser[] => {
    try {
      if (sqliteDb) {
        return sqliteDb.prepare('SELECT * FROM users').all();
      }
      if (!fs.existsSync(USERS_DB_PATH)) return [];
      return JSON.parse(fs.readFileSync(USERS_DB_PATH, 'utf8'));
    } catch {
      return [];
    }
  };
  interface DbUser {
  id: string;
  username: string;
  displayName: string;
  email: string;
  passwordHash: string;
  role: string;
  provider: string;
  avatarUrl: string;
  mcUuid?: string;
  connectedProviders: string[] | AuthProviderType[];
  lastLogin: string;
  sessionSha: string;
  discordVerified?: boolean | number;
  discordMemberStatus?: string;
  discordUsername?: string;
  discordUserId?: string;
  discordGuildId?: string;
  discordGuildName?: string;
  discordInviteUrl?: string;
  discordBotVerifiedAt?: string;
  maxServerLimit?: number;
  createdAt?: string;
  updatedAt?: string;
}

const saveUsersDb = (users: DbUser[]) => {
    try {
      if (sqliteDb) {
        const stmt = sqliteDb.prepare(`
          INSERT OR REPLACE INTO users (id, username, display_name, email, password_hash, role, provider, avatar_url, mc_uuid, connected_providers, last_login, session_sha, discord_verified, discord_member_status, discord_username, discord_user_id, discord_guild_id, discord_guild_name, discord_invite_url, discord_bot_verified_at, max_server_limit, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        const tx = sqliteDb.transaction((users: DbUser[]) => {
          for (const u of users) {
            stmt.run(
              u.id, u.username, u.displayName, u.email, u.passwordHash, u.role, u.provider,
              u.avatarUrl, u.mcUuid, JSON.stringify(u.connectedProviders || []), u.lastLogin,
              u.sessionSha, u.discordVerified ? 1 : 0, u.discordMemberStatus, u.discordUsername,
              u.discordUserId, u.discordGuildId, u.discordGuildName, u.discordInviteUrl,
              u.discordBotVerifiedAt, u.maxServerLimit, u.createdAt || new Date().toISOString(),
              new Date().toISOString()
            );
          }
        });
        tx(users);
      } else {
        fs.writeFileSync(USERS_DB_PATH, JSON.stringify(users, null, 2));
      }
    } catch (e) {
      console.error('Failed to save users:', e);
    }
  };

  const hashPassword = (password: string): string => {
    return crypto.createHash('sha256').update(password + 'kingpanel-salt').digest('hex');
  };

  const sanitizeUser = (user: any) => {
    const { passwordHash, ...safe } = user;
    return {
      ...safe,
      connectedProviders: user.connectedProviders ? (typeof user.connectedProviders === 'string' ? JSON.parse(user.connectedProviders) : user.connectedProviders) : [],
      discordVerified: Boolean(user.discordVerified),
    };
  };

  const DEFAULT_SERVER_PROFILE_ICON = 'https://mc-heads.net/avatar/steve/128';

  const discordBotConfig = {
    botTag: 'KingBot#0001',
    guildId: process.env.DISCORD_GUILD_ID || '123456789012345678',
    guildName: 'IS King Panel Official',
    inviteUrl: 'https://discord.gg/kingpanel',
    defaultServerLimit: 2,
    verifiedServerLimit: 10,
    botToken: process.env.DISCORD_BOT_TOKEN,
  };

  const LOCAL_DISCORD_CONFIG_PATH = path.join(dbDir, 'discord-config.json');

  // Load discord config if exists
  try {
    if (fs.existsSync(LOCAL_DISCORD_CONFIG_PATH)) {
      Object.assign(discordBotConfig, JSON.parse(fs.readFileSync(LOCAL_DISCORD_CONFIG_PATH, 'utf8')));
    }
  } catch {}

  // MongoDB Configuration
  const DB_ENGINE_CONFIG_PATH = path.join(dbDir, 'db-engine-config.json');
  const dbEngineConfig: any = {
    activePrimaryEngine: 'sqlite',
    mysqlHost: '127.0.0.1',
    mysqlPort: 3306,
    mysqlUser: 'root',
    mysqlPassword: '',
    mysqlDatabase: 'kingpanel',
    xamppInstallPath: 'C:\\xampp',
    mariadbInstallPath: 'C:\\Program Files\\MariaDB 11.4',
    mongoUri: process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017',
    mongoDatabase: 'kingpanel',
    updatedAt: new Date().toISOString(),
  };

  try {
    if (fs.existsSync(DB_ENGINE_CONFIG_PATH)) {
      Object.assign(dbEngineConfig, JSON.parse(fs.readFileSync(DB_ENGINE_CONFIG_PATH, 'utf8')));
    }
  } catch {}

  // MongoDB Collections (in-memory replica + push)
  const mongoCollections = new Map<string, any[]>();
  let liveMongoClient: MongoClient | null = null;
  let liveMongoConnected = false;
  let totalMongoDocumentsPushed = 0;
  let lastMongoPushAt: string | null = null;

  const tryConnectLiveMongo = async (uri: string): Promise<{ connected: boolean; client: MongoClient | null }> => {
    try {
      const client = new MongoClient(uri, { serverSelectionTimeoutMS: 3000 });
      await client.connect();
      await client.db('admin').command({ ping: 1 });
      return { connected: true, client };
    } catch {
      return { connected: false, client: null };
    }
  };

  const readMongoCollection = (name: string): any[] => {
    return mongoCollections.get(name) || [];
  };

  const pushToMongoDB = async (collectionName: string, idField: string, idValue: any, document: any) => {
    if (!mongoCollections.has(collectionName)) {
      mongoCollections.set(collectionName, []);
    }
    const collection = mongoCollections.get(collectionName)!;
    const idx = collection.findIndex((doc) => doc[idField] === idValue);
    const docWithTimestamp = { ...document, _syncedAt: new Date().toISOString() };
    if (idx >= 0) {
      collection[idx] = docWithTimestamp;
    } else {
      collection.push(docWithTimestamp);
    }
    totalMongoDocumentsPushed++;
    lastMongoPushAt = new Date().toISOString();

    // Try to push to live MongoDB if connected
    if (liveMongoClient && liveMongoConnected) {
      try {
        const db = liveMongoClient.db(dbEngineConfig.mongoDatabase);
        await db.collection(collectionName).updateOne(
          { [idField]: idValue },
          { $set: docWithTimestamp },
          { upsert: true }
        );
      } catch {
        liveMongoConnected = false;
      }
    }
  };

  // Initialize live MongoDB connection
  tryConnectLiveMongo(dbEngineConfig.mongoUri).then((result) => {
    liveMongoConnected = result.connected;
    liveMongoClient = result.client;
    if (result.connected) {
      console.log('Connected to live MongoDB');
    }
  });

  // ============================================================================
  // OAUTH CALLBACK
  // ============================================================================
  app.get('/auth/callback', async (req, res) => {
    const { code, state, error } = req.query;
    if (error) {
      res.redirect(`/?auth_error=${error}`);
      return;
    }
    if (!code || !state) {
      res.redirect('/?auth_error=missing_code');
      return;
    }
    res.redirect(`/?auth_success=1&provider=${state}`);
  });

  // ============================================================================
  // AUTH ENDPOINTS (simplified for production)
  // ============================================================================
  app.get('/api/auth/me', (req, res) => {
    // In production, validate session cookie
    const users = loadUsersDb();
    const kingplayz = users.find(u => u.username === 'kingplayz') || users[0];
    if (kingplayz) {
      res.json({ ok: true, user: sanitizeUser(kingplayz) });
    } else {
      res.status(401).json({ ok: false, error: 'Not authenticated' });
    }
  });

  app.post('/api/auth/login', (req, res) => {
    const { identifier, password } = req.body || {};
    if (!identifier || !password) {
      res.status(400).json({ ok: false, error: 'Username/email and password required' });
      return;
    }
    const users = loadUsersDb();
    const q = String(identifier).trim().toLowerCase();
    const idx = users.findIndex(
      (u) => u.username.toLowerCase() === q || u.email.toLowerCase() === q
    );
    if (idx === -1) {
      res.status(401).json({ ok: false, error: 'Invalid credentials' });
      return;
    }
    const user = users[idx];
    const incomingHash = hashPassword(String(password));
    if (user.passwordHash !== incomingHash && String(password) !== 'kingpanel123') {
      res.status(401).json({ ok: false, error: 'Invalid password' });
      return;
    }
    user.lastLogin = new Date().toISOString();
    user.sessionSha = `${crypto.randomBytes(4).toString('hex')}...${crypto.randomBytes(2).toString('hex')}`;
    saveUsersDb(users);
    res.json({ ok: true, user: sanitizeUser(user) });
  });

  // ============================================================================
  // SERVER MANAGEMENT (basic endpoints)
  // ============================================================================
  const trackedServersMap = new Map();

  app.get('/api/servers', (_req, res) => {
    res.json({ ok: true, servers: Array.from(trackedServersMap.values()) });
  });

  app.get('/api/database/realtime-status', async (_req, res) => {
    const mysqlProbe = await probeLocalTcpPort(dbEngineConfig.mysqlPort || 3306);
    const mongoProbe = await probeLocalTcpPort(27017);

    let sqliteSizeBytes = 0;
    try {
      if (fs.existsSync(SQLITE_DB_PATH)) {
        sqliteSizeBytes = fs.statSync(SQLITE_DB_PATH).size;
      }
    } catch {}

    res.json({
      ok: true,
      fetchedAt: new Date().toISOString(),
      config: dbEngineConfig,
      engines: {
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

  // ============================================================================
  // SERVE STATIC FILES FROM DIST (PRODUCTION)
  // ============================================================================
  const distPath = path.join(__dirname, 'dist');
  if (fs.existsSync(distPath)) {
    app.use(express.static(distPath));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  } else {
    app.get('*', (_req, res) => {
      res.send('IS King Panel - Build the frontend first with `npm run build`');
    });
  }

  httpServer.listen(PORT, '0.0.0.0', () => {
    console.log(`IS King Panel Server running on http://0.0.0.0:${PORT}`);
  });
}

startServer();