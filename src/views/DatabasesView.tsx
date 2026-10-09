import React, { useState, useEffect, useCallback } from 'react';
import { ServerInstance, AuthUser } from '../types';
import { DEFAULT_PROFILE_ICON_URL, resolveUserAvatarUrl } from '../utils/profileIcons';

interface DatabasesViewProps {
  server: ServerInstance;
  onShowToast: (
    title: string,
    body?: string,
    type?: 'success' | 'info' | 'warning' | 'error',
    icon?: string
  ) => void;
}

interface SqliteTableSummary {
  name: string;
  rows: number;
  description: string;
}

interface DatabaseOverviewResponse {
  ok: boolean;
  engine: string;
  dbPath: string;
  windowsAppDataPath: string;
  sizeBytes: number;
  sizeFormatted: string;
  superAdmin: {
    id: string;
    username: string;
    email: string;
    passwordHint: string;
    role: string;
    maxServerLimit: number;
  };
  tables: SqliteTableSummary[];
  users: AuthUser[];
}

interface MongoCollectionInfo {
  name: string;
  count: number;
  sample: Array<Record<string, unknown>>;
}

interface RealtimeDatabaseStatusResponse {
  ok: boolean;
  fetchedAt: string;
  config: {
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
  };
  engines: {
    xampp: {
      name: string;
      host: string;
      port: number;
      portOpen: boolean;
      latencyMs: number;
      detectedOnDisk: boolean;
      installPath: string;
      phpMyAdminUrl: string;
      status: string;
    };
    mariadb: {
      name: string;
      host: string;
      port: number;
      portOpen: boolean;
      latencyMs: number;
      detectedOnDisk: boolean;
      installPath: string;
      status: string;
    };
    mongodb: {
      name: string;
      uri: string;
      database: string;
      port27017Open: boolean;
      liveDriverConnected: boolean;
      latencyMs: number;
      lastPushAt: string;
      totalPushedDocs: number;
      collections: MongoCollectionInfo[];
      status: string;
    };
    sqlite: {
      name: string;
      path: string;
      sizeBytes: number;
      sizeFormatted: string;
      status: string;
    };
  };
}

export const DatabasesView: React.FC<DatabasesViewProps> = ({ server, onShowToast }) => {
  const [overview, setOverview] = useState<DatabaseOverviewResponse | null>(null);
  const [rtStatus, setRtStatus] = useState<RealtimeDatabaseStatusResponse | null>(null);
  const [livePollDb, setLivePollDb] = useState(true);
  const [lastSyncedAt, setLastSyncedAt] = useState<string>('Just now');

  // Local PC XAMPP / MariaDB / MongoDB Setup State
  const [selectedSetupEngine, setSelectedSetupEngine] = useState<
    'xampp' | 'mariadb' | 'mongodb' | 'sqlite'
  >('xampp');
  const [setupGuideTab, setSetupGuideTab] = useState<'xampp' | 'mariadb' | 'mongodb'>('xampp');
  const [mysqlHost, setMysqlHost] = useState('127.0.0.1');
  const [mysqlPort, setMysqlPort] = useState(3306);
  const [mysqlUser, setMysqlUser] = useState('root');
  const [mysqlPassword, setMysqlPassword] = useState('');
  const [mysqlDatabase, setMysqlDatabase] = useState('isking_panel');
  const [mongoUri, setMongoUri] = useState('mongodb://127.0.0.1:27017/isking_panel');
  const [mongoDatabase, setMongoDatabase] = useState('isking_panel');
  const [activeMongoCollection, setActiveMongoCollection] = useState<string>('users');
  const [savingEngineConfig, setSavingEngineConfig] = useState(false);
  const [pushingMongo, setPushingMongo] = useState(false);

  // SQLite Query Runner State
  const [sqlInput, setSqlInput] = useState(
    'SELECT id, username, display_name, email, role, is_super_admin, discord_verified, max_server_limit, last_login FROM users ORDER BY is_super_admin DESC;'
  );
  const [queryColumns, setQueryColumns] = useState<string[]>([]);
  const [queryRows, setQueryRows] = useState<Array<Record<string, unknown>>>([]);
  const [queryElapsedMs, setQueryElapsedMs] = useState<number>(0.42);
  const [queryError, setQueryError] = useState<string | null>(null);
  const [isRunningQuery, setIsRunningQuery] = useState(false);

  // Super Admin Quick Edit User Modal / Form state
  const [editingUsername, setEditingUsername] = useState<string>('kingplayz');
  const [editingRole, setEditingRole] = useState<string>('Super Admin');
  const [editingLimit, setEditingLimit] = useState<number>(999);
  const [editingVerified, setEditingVerified] = useState<boolean>(true);
  const [editingPassword, setEditingPassword] = useState<string>('');

  const fetchDatabaseOverview = useCallback(async () => {
    try {
      const [rOverview, rRealtime] = await Promise.all([
        fetch('/api/database/overview'),
        fetch('/api/database/realtime-status'),
      ]);
      const dataOverview = await rOverview.json();
      if (dataOverview.ok) {
        setOverview(dataOverview);
      }
      const dataRt = await rRealtime.json();
      if (dataRt.ok) {
        setRtStatus(dataRt);
        setLastSyncedAt(new Date().toLocaleTimeString());
      }
    } catch {
      // ignore transient error
    }
  }, []);

  const executeSqlQuery = useCallback(
    async (customSql?: string, silent = false) => {
      const targetSql = customSql ?? sqlInput;
      setIsRunningQuery(true);
      setQueryError(null);
      try {
        const r = await fetch('/api/database/query', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sql: targetSql }),
        });
        const data = await r.json();
        if (!r.ok || !data.ok) {
          setQueryError(data.error || 'SQL query failed');
          if (!silent) {
            onShowToast('SQL Error', data.error || 'Failed to execute SQL', 'error', 'error');
          }
        } else {
          setQueryColumns(data.columns || []);
          setQueryRows(data.rows || []);
          setQueryElapsedMs(data.executionMs || 0.35);
          if (!silent) {
            onShowToast(
              `SQL Executed (${data.executionMs}ms)`,
              `Returned ${data.rowCount} row(s) from SQLite3 WAL database.`,
              'success',
              'database'
            );
          }
          fetchDatabaseOverview();
        }
      } catch (err) {
        setQueryError(err instanceof Error ? err.message : 'Network error');
      } finally {
        setIsRunningQuery(false);
      }
    },
    [sqlInput, onShowToast, fetchDatabaseOverview]
  );

  useEffect(() => {
    fetchDatabaseOverview();
    executeSqlQuery(undefined, true);
  }, [fetchDatabaseOverview, executeSqlQuery]);

  // Real-time 2s polling of Database Status (XAMPP / MariaDB port 3306, MongoDB collections, SQLite)
  useEffect(() => {
    if (!livePollDb) return;
    const timer = setInterval(() => {
      fetchDatabaseOverview();
    }, 2000);
    return () => clearInterval(timer);
  }, [livePollDb, fetchDatabaseOverview]);

  const handleSaveAndTestEngine = async (engineType: 'xampp' | 'mariadb' | 'mongodb' | 'sqlite') => {
    setSavingEngineConfig(true);
    setSelectedSetupEngine(engineType);
    try {
      const r = await fetch('/api/database/configure-engine', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          activePrimaryEngine: engineType,
          mysqlHost,
          mysqlPort,
          mysqlUser,
          mysqlPassword,
          mysqlDatabase,
          mongoUri,
          mongoDatabase,
        }),
      });
      const data = await r.json();
      if (data.ok) {
        await fetchDatabaseOverview();
        onShowToast(
          `Database Engine Configured: ${engineType.toUpperCase()}`,
          data.message,
          'success',
          'database'
        );
      }
    } catch {
      onShowToast('Configuration Error', 'Failed to update database engine configuration.', 'error');
    } finally {
      setSavingEngineConfig(false);
    }
  };

  const handlePushAllToMongoDB = async () => {
    setPushingMongo(true);
    try {
      const r = await fetch('/api/database/mongodb/push-all', {
        method: 'POST',
      });
      const data = await r.json();
      if (data.ok) {
        await fetchDatabaseOverview();
        onShowToast(
          'Pushed All Data to MongoDB',
          `Synchronized Users, Default Profile Icons, Backups, Schedules & Server Logs into MongoDB (${mongoDatabase}).`,
          'success',
          'cloud_upload'
        );
      }
    } catch {
      onShowToast('MongoDB Push Error', 'Failed to push data to MongoDB.', 'error');
    } finally {
      setPushingMongo(false);
    }
  };

  const handleVacuum = async () => {
    try {
      const r = await fetch('/api/database/vacuum', { method: 'POST' });
      const data = await r.json();
      if (data.ok) {
        onShowToast('SQLite3 VACUUM Complete', data.message, 'success', 'cleaning_services');
        fetchDatabaseOverview();
      }
    } catch {
      // ignore
    }
  };

  const handleUpdateUserInDb = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const r = await fetch('/api/database/admin/update-user', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          targetUsername: editingUsername,
          role: editingRole,
          maxServerLimit: editingLimit,
          discordVerified: editingVerified,
          newPassword: editingPassword.trim() || undefined,
        }),
      });
      const data = await r.json();
      if (!r.ok || !data.ok) {
        onShowToast('Update Failed', data.error || 'Could not update user', 'error', 'error');
        return;
      }
      setEditingPassword('');
      onShowToast(
        `Updated @${editingUsername} in SQLite3 & MongoDB`,
        `Role: ${editingRole} • Max Servers: ${editingLimit} • Pushed to MongoDB`,
        'success',
        'verified_user'
      );
      fetchDatabaseOverview();
      executeSqlQuery(
        'SELECT id, username, display_name, email, role, is_super_admin, discord_verified, max_server_limit, last_login FROM users ORDER BY is_super_admin DESC;',
        true
      );
    } catch {
      onShowToast('Update Failed', 'Network error while updating database', 'error', 'error');
    }
  };

  const presetQueries = [
    {
      label: 'All Users & Super Admin',
      sql: 'SELECT id, username, display_name, email, role, is_super_admin, discord_verified, max_server_limit, last_login FROM users ORDER BY is_super_admin DESC;',
    },
    {
      label: 'Installed Servers & Outdated Flags',
      sql: 'SELECT id, name, engine, installed_version, latest_version, is_outdated, latest_build, port, status, path FROM servers;',
    },
    {
      label: 'Real-Time Backups Table',
      sql: 'SELECT id, server_id, title, badge, size_formatted, sha256, pinned, created_at FROM server_backups ORDER BY created_at DESC;',
    },
    {
      label: 'Real-Time Server Logs Table',
      sql: 'SELECT id, server_id, line_num, time, severity, thread, tag, raw_text FROM server_logs ORDER BY id DESC LIMIT 20;',
    },
    {
      label: 'PaperMC Version Check Log',
      sql: 'SELECT id, engine, latest_version, latest_build, outdated_count, api_source, checked_at FROM engine_version_checks ORDER BY id DESC LIMIT 15;',
    },
  ];

  const xamppSqlBootstrapScript = `-- IS King Panel v4.8 — Local PC XAMPP / MariaDB SQL Bootstrap
CREATE DATABASE IF NOT EXISTS \`${mysqlDatabase}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE \`${mysqlDatabase}\`;

CREATE TABLE IF NOT EXISTS users (
  id VARCHAR(64) PRIMARY KEY,
  username VARCHAR(64) UNIQUE NOT NULL,
  display_name VARCHAR(120) NOT NULL,
  email VARCHAR(160) UNIQUE NOT NULL,
  role VARCHAR(40) DEFAULT 'Operator',
  avatar_url TEXT,
  discord_verified TINYINT(1) DEFAULT 0,
  max_server_limit INT DEFAULT 2,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

INSERT IGNORE INTO users (id, username, display_name, email, role, discord_verified, max_server_limit)
VALUES ('SA-KINGPLAYZ-001', 'kingplayz', 'KingPlayz (Super Admin)', 'kingplayz@iskingpanel.exe', 'Super Admin', 1, 999);`;

  const currentMongoCol =
    rtStatus?.engines.mongodb.collections.find((c) => c.name === activeMongoCollection) ||
    rtStatus?.engines.mongodb.collections[0];

  return (
    <main className="flex-1 flex flex-col bg-surface-dim overflow-hidden">
      {/* Top Contextual Header */}
      <header className="h-16 px-6 bg-surface border-b border-outline-variant/15 flex items-center justify-between shrink-0">
        <div className="flex items-center gap-4">
          <div className="w-10 h-10 rounded-lg bg-primary/10 border border-primary/25 flex items-center justify-center text-primary">
            <span className="material-symbols-outlined text-[22px]">database</span>
          </div>
          <div>
            <div className="flex items-center gap-2.5">
              <h1 className="text-base font-bold tracking-tight text-on-surface">
                Real-Time Database Hub — XAMPP, MariaDB, MongoDB &amp; SQLite3
              </h1>
              <span className="px-2 py-0.5 text-[10px] font-mono uppercase tracking-wider bg-secondary/10 text-secondary rounded border border-secondary/20 flex items-center gap-1">
                <span className="w-1.5 h-1.5 rounded-full bg-secondary animate-pulse" />
                Live Sync: {lastSyncedAt}
              </span>
              <span className="px-2 py-0.5 text-[10px] font-mono uppercase tracking-wider bg-primary/15 text-primary rounded border border-primary/30">
                Super Admin: kingplayz
              </span>
            </div>
            <p className="text-xs text-outline font-mono mt-0.5 truncate max-w-2xl">
              Local PC XAMPP/MariaDB (Port {mysqlPort}) • MongoDB ({mongoDatabase}) • SQLite3 (
              {overview?.sizeFormatted || '64 KB'})
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2.5">
          <button
            type="button"
            onClick={() => setLivePollDb(!livePollDb)}
            className={`px-3 py-2 rounded-lg text-xs font-mono font-bold border transition-all flex items-center gap-1.5 cursor-pointer ${
              livePollDb
                ? 'bg-secondary/15 text-secondary border-secondary/30'
                : 'bg-surface-container-high text-outline border-outline-variant/20'
            }`}
          >
            <span
              className={`size-2 rounded-full ${
                livePollDb ? 'bg-secondary animate-ping' : 'bg-outline'
              }`}
            />
            {livePollDb ? 'Real-Time DB Fetch: ON (2s)' : 'DB Polling Paused'}
          </button>

          <button
            type="button"
            onClick={handlePushAllToMongoDB}
            disabled={pushingMongo}
            className="px-3.5 py-2 rounded-lg bg-secondary/15 hover:bg-secondary/25 text-secondary border border-secondary/30 text-xs font-mono font-bold transition-all flex items-center gap-1.5 cursor-pointer"
          >
            <span className="material-symbols-outlined text-[16px]">cloud_upload</span>
            {pushingMongo ? 'Pushing...' : 'Push All Data to MongoDB'}
          </button>

          <button
            type="button"
            onClick={handleVacuum}
            className="px-3.5 py-2 rounded-lg bg-surface-container-high hover:bg-surface-bright text-xs font-medium text-on-surface border border-outline-variant/20 transition-all flex items-center gap-2 cursor-pointer"
          >
            <span className="material-symbols-outlined text-[16px] text-secondary">
              cleaning_services
            </span>
            VACUUM
          </button>
        </div>
      </header>

      {/* Scrollable Workspace */}
      <div className="flex-1 overflow-y-auto p-6 space-y-6">
        {/* 1. REAL-TIME MULTI-ENGINE DATABASE STATUS CARDS (XAMPP, MARIADB, MONGODB, SQLITE) */}
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4">
          {/* XAMPP Card */}
          <div
            onClick={() => {
              setSelectedSetupEngine('xampp');
              setSetupGuideTab('xampp');
            }}
            className={`rounded-xl p-4 border transition-all cursor-pointer ${
              selectedSetupEngine === 'xampp'
                ? 'bg-primary/10 border-primary/50 shadow-lg'
                : 'bg-surface border-outline-variant/15 hover:border-primary/30'
            }`}
          >
            <div className="flex items-center justify-between mb-2">
              <span className="text-[10px] font-mono uppercase tracking-wider font-bold text-primary">
                LOCAL PC OPTION #1 • XAMPP
              </span>
              <span
                className={`px-2 py-0.5 rounded text-[10px] font-mono font-bold ${
                  rtStatus?.engines.xampp.portOpen
                    ? 'bg-secondary/15 text-secondary'
                    : 'bg-amber-500/15 text-amber-300'
                }`}
              >
                {rtStatus?.engines.xampp.portOpen ? 'PORT 3306 OPEN' : 'STANDBY (3306)'}
              </span>
            </div>
            <h3 className="text-sm font-bold text-on-surface flex items-center gap-2">
              <span className="material-symbols-outlined text-primary text-lg">dns</span>
              XAMPP (MySQL + phpMyAdmin)
            </h3>
            <p className="text-[11px] font-mono text-outline mt-1 truncate">
              {rtStatus?.engines.xampp.installPath || 'C:\\xampp\\mysql\\bin\\mysqld.exe'}
            </p>
            <div className="mt-3 pt-2 border-t border-white/5 flex items-center justify-between text-[10px] font-mono">
              <span className="text-on-surface-variant">http://localhost/phpmyadmin</span>
              <span className="text-primary font-bold">Setup Guide →</span>
            </div>
          </div>

          {/* MariaDB Card */}
          <div
            onClick={() => {
              setSelectedSetupEngine('mariadb');
              setSetupGuideTab('mariadb');
            }}
            className={`rounded-xl p-4 border transition-all cursor-pointer ${
              selectedSetupEngine === 'mariadb'
                ? 'bg-tertiary/10 border-tertiary/50 shadow-lg'
                : 'bg-surface border-outline-variant/15 hover:border-tertiary/30'
            }`}
          >
            <div className="flex items-center justify-between mb-2">
              <span className="text-[10px] font-mono uppercase tracking-wider font-bold text-tertiary">
                LOCAL PC OPTION #2 • MARIADB
              </span>
              <span
                className={`px-2 py-0.5 rounded text-[10px] font-mono font-bold ${
                  rtStatus?.engines.mariadb.portOpen
                    ? 'bg-secondary/15 text-secondary'
                    : 'bg-amber-500/15 text-amber-300'
                }`}
              >
                {rtStatus?.engines.mariadb.portOpen ? 'PORT 3306 ACTIVE' : 'SERVICE STANDBY'}
              </span>
            </div>
            <h3 className="text-sm font-bold text-on-surface flex items-center gap-2">
              <span className="material-symbols-outlined text-tertiary text-lg">storage</span>
              MariaDB Server 11.4 (Local PC)
            </h3>
            <p className="text-[11px] font-mono text-outline mt-1 truncate">
              {rtStatus?.engines.mariadb.installPath ||
                'C:\\Program Files\\MariaDB 11.4\\bin\\mariadbd.exe'}
            </p>
            <div className="mt-3 pt-2 border-t border-white/5 flex items-center justify-between text-[10px] font-mono">
              <span className="text-on-surface-variant">Host: {mysqlHost}:{mysqlPort}</span>
              <span className="text-tertiary font-bold">Setup Guide →</span>
            </div>
          </div>

          {/* MongoDB Card */}
          <div
            onClick={() => {
              setSelectedSetupEngine('mongodb');
              setSetupGuideTab('mongodb');
            }}
            className={`rounded-xl p-4 border transition-all cursor-pointer ${
              selectedSetupEngine === 'mongodb'
                ? 'bg-secondary/10 border-secondary/50 shadow-lg'
                : 'bg-surface border-outline-variant/15 hover:border-secondary/30'
            }`}
          >
            <div className="flex items-center justify-between mb-2">
              <span className="text-[10px] font-mono uppercase tracking-wider font-bold text-secondary">
                DOCUMENT CLOUD / LOCAL • MONGODB
              </span>
              <span className="px-2 py-0.5 rounded bg-secondary/15 text-secondary text-[10px] font-mono font-bold">
                AUTO-PUSH ON
              </span>
            </div>
            <h3 className="text-sm font-bold text-on-surface flex items-center gap-2">
              <span className="material-symbols-outlined text-secondary text-lg">cloud_done</span>
              MongoDB Document Store
            </h3>
            <p className="text-[11px] font-mono text-outline mt-1 truncate">
              {rtStatus?.engines.mongodb.uri || mongoUri}
            </p>
            <div className="mt-3 pt-2 border-t border-white/5 flex items-center justify-between text-[10px] font-mono">
              <span className="text-secondary">
                {rtStatus?.engines.mongodb.collections.reduce((a, c) => a + c.count, 0) || 12} Docs
                Pushed
              </span>
              <span className="text-secondary font-bold">Inspect Docs →</span>
            </div>
          </div>

          {/* SQLite3 Native Card */}
          <div
            onClick={() => setSelectedSetupEngine('sqlite')}
            className={`rounded-xl p-4 border transition-all cursor-pointer ${
              selectedSetupEngine === 'sqlite'
                ? 'bg-primary/10 border-primary/50 shadow-lg'
                : 'bg-surface border-outline-variant/15 hover:border-primary/30'
            }`}
          >
            <div className="flex items-center justify-between mb-2">
              <span className="text-[10px] font-mono uppercase tracking-wider font-bold text-primary-gold">
                BUILT-IN ZERO-CONFIG • SQLITE3
              </span>
              <span className="px-2 py-0.5 rounded bg-secondary/15 text-secondary text-[10px] font-mono font-bold">
                WAL ONLINE
              </span>
            </div>
            <h3 className="text-sm font-bold text-on-surface flex items-center gap-2">
              <span className="material-symbols-outlined text-primary-gold text-lg">bolt</span>
              SQLite 3.46 Native Engine
            </h3>
            <p className="text-[11px] font-mono text-outline mt-1 truncate">
              {overview?.dbPath || 'database/isking_panel.sqlite'}
            </p>
            <div className="mt-3 pt-2 border-t border-white/5 flex items-center justify-between text-[10px] font-mono">
              <span className="text-on-surface-variant">
                Size: {overview?.sizeFormatted || '64 KB'}
              </span>
              <span className="text-primary-gold font-bold">Active Engine ✓</span>
            </div>
          </div>
        </div>

        {/* 2. LOCAL PC DATABASE SYSTEM SETUP (XAMPP / MARIADB / MONGODB) & STEP-BY-STEP GUIDE */}
        <div className="bg-surface rounded-2xl border border-primary/25 shadow-xl overflow-hidden">
          <div className="px-5 py-3.5 bg-surface-container border-b border-outline-variant/15 flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2.5">
              <span className="material-symbols-outlined text-primary text-[20px]">
                build_circle
              </span>
              <div>
                <h2 className="text-xs font-bold uppercase tracking-wider text-on-surface">
                  Local PC Database System Setup (XAMPP or MariaDB on Your PC + MongoDB Push)
                </h2>
                <p className="text-[11px] font-mono text-outline">
                  Configure XAMPP (MySQL) or MariaDB on your Local PC, follow the step-by-step setup guide, and inspect live MongoDB document pushes
                </p>
              </div>
            </div>

            <div className="flex items-center gap-1.5">
              {[
                { id: 'xampp', label: '1. XAMPP Setup Guide (Local PC)' },
                { id: 'mariadb', label: '2. MariaDB Setup Guide (Local PC)' },
                { id: 'mongodb', label: '3. MongoDB Live Collections' },
              ].map((tab) => (
                <button
                  key={tab.id}
                  type="button"
                  onClick={() => setSetupGuideTab(tab.id as 'xampp' | 'mariadb' | 'mongodb')}
                  className={`px-3 py-1.5 rounded-lg text-xs font-mono font-bold transition-all cursor-pointer ${
                    setupGuideTab === tab.id
                      ? 'bg-primary text-on-primary-container shadow-sm'
                      : 'bg-surface-lowest text-outline hover:text-on-surface border border-white/10'
                  }`}
                >
                  {tab.label}
                </button>
              ))}
            </div>
          </div>

          <div className="p-5 grid grid-cols-1 lg:grid-cols-12 gap-6">
            {/* Left 5 Cols: Live Connection Configurator for XAMPP / MariaDB / MongoDB */}
            <div className="lg:col-span-5 space-y-4 bg-surface-lowest p-4 rounded-xl border border-white/10">
              <div className="flex items-center justify-between">
                <h3 className="text-xs font-bold uppercase tracking-wider text-primary font-mono">
                  Local PC Database Connection Settings
                </h3>
                <span className="text-[10px] font-mono text-secondary">
                  Target: {selectedSetupEngine.toUpperCase()}
                </span>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-[10px] font-mono uppercase text-outline block mb-1">
                    Local PC Host IP
                  </label>
                  <input
                    type="text"
                    value={mysqlHost}
                    onChange={(e) => setMysqlHost(e.target.value)}
                    className="w-full bg-surface border border-outline-variant/25 rounded-lg px-3 py-1.5 text-xs font-mono text-on-surface"
                  />
                </div>
                <div>
                  <label className="text-[10px] font-mono uppercase text-outline block mb-1">
                    MySQL / MariaDB Port
                  </label>
                  <input
                    type="number"
                    value={mysqlPort}
                    onChange={(e) => setMysqlPort(Number(e.target.value) || 3306)}
                    className="w-full bg-surface border border-outline-variant/25 rounded-lg px-3 py-1.5 text-xs font-mono text-primary font-bold"
                  />
                </div>
              </div>

              <div className="grid grid-cols-3 gap-3">
                <div>
                  <label className="text-[10px] font-mono uppercase text-outline block mb-1">
                    DB Username
                  </label>
                  <input
                    type="text"
                    value={mysqlUser}
                    onChange={(e) => setMysqlUser(e.target.value)}
                    className="w-full bg-surface border border-outline-variant/25 rounded-lg px-3 py-1.5 text-xs font-mono text-on-surface"
                  />
                </div>
                <div>
                  <label className="text-[10px] font-mono uppercase text-outline block mb-1">
                    DB Password
                  </label>
                  <input
                    type="password"
                    value={mysqlPassword}
                    onChange={(e) => setMysqlPassword(e.target.value)}
                    placeholder="(Blank on XAMPP)"
                    className="w-full bg-surface border border-outline-variant/25 rounded-lg px-3 py-1.5 text-xs font-mono text-on-surface"
                  />
                </div>
                <div>
                  <label className="text-[10px] font-mono uppercase text-outline block mb-1">
                    Database Name
                  </label>
                  <input
                    type="text"
                    value={mysqlDatabase}
                    onChange={(e) => setMysqlDatabase(e.target.value)}
                    className="w-full bg-surface border border-outline-variant/25 rounded-lg px-3 py-1.5 text-xs font-mono text-secondary font-bold"
                  />
                </div>
              </div>

              <div className="pt-2 border-t border-white/10">
                <label className="text-[10px] font-mono uppercase text-outline block mb-1">
                  MongoDB Connection URI (For User &amp; Profile Data Push)
                </label>
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={mongoUri}
                    onChange={(e) => setMongoUri(e.target.value)}
                    className="flex-1 bg-surface border border-outline-variant/25 rounded-lg px-3 py-1.5 text-xs font-mono text-on-surface"
                  />
                  <input
                    type="text"
                    value={mongoDatabase}
                    onChange={(e) => setMongoDatabase(e.target.value)}
                    className="w-28 bg-surface border border-outline-variant/25 rounded-lg px-2.5 py-1.5 text-xs font-mono text-secondary"
                    title="MongoDB Database Name"
                  />
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 pt-1">
                <button
                  type="button"
                  disabled={savingEngineConfig}
                  onClick={() => handleSaveAndTestEngine('xampp')}
                  className="py-2 px-3 rounded-lg bg-primary text-on-primary-container font-bold text-xs font-mono hover:opacity-95 transition-opacity cursor-pointer"
                >
                  Connect XAMPP
                </button>
                <button
                  type="button"
                  disabled={savingEngineConfig}
                  onClick={() => handleSaveAndTestEngine('mariadb')}
                  className="py-2 px-3 rounded-lg bg-tertiary/20 hover:bg-tertiary/30 text-tertiary border border-tertiary/30 font-bold text-xs font-mono transition-colors cursor-pointer"
                >
                  Connect MariaDB
                </button>
                <button
                  type="button"
                  disabled={savingEngineConfig}
                  onClick={() => handleSaveAndTestEngine('mongodb')}
                  className="py-2 px-3 rounded-lg bg-secondary/20 hover:bg-secondary/30 text-secondary border border-secondary/30 font-bold text-xs font-mono transition-colors cursor-pointer"
                >
                  Connect MongoDB
                </button>
              </div>
            </div>

            {/* Right 7 Cols: Interactive Setup Guide (XAMPP / MariaDB) OR Live MongoDB Document Inspector */}
            <div className="lg:col-span-7 bg-surface-lowest p-4 rounded-xl border border-white/10 flex flex-col justify-between gap-4">
              {setupGuideTab === 'xampp' && (
                <div className="space-y-3">
                  <div className="flex items-center justify-between">
                    <h3 className="text-sm font-bold text-on-surface flex items-center gap-2">
                      <span className="material-symbols-outlined text-primary">menu_book</span>
                      How to Setup XAMPP (MySQL + phpMyAdmin) on Your Local PC
                    </h3>
                    <span className="px-2 py-0.5 rounded bg-primary/15 text-primary text-[10px] font-mono font-bold">
                      Windows 10 / 11 Guide
                    </span>
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5 text-xs">
                    <div className="p-3 rounded-lg bg-surface border border-white/5 space-y-1">
                      <div className="font-mono font-bold text-primary">
                        STEP 1: Install XAMPP on Local PC
                      </div>
                      <p className="text-on-surface-variant text-[11px] leading-relaxed">
                        Download XAMPP for Windows from{' '}
                        <span className="text-on-surface font-mono">apachefriends.org</span> and
                        install into <span className="text-primary font-mono">C:\xampp</span>.
                      </p>
                    </div>
                    <div className="p-3 rounded-lg bg-surface border border-white/5 space-y-1">
                      <div className="font-mono font-bold text-primary">
                        STEP 2: Start MySQL in XAMPP Control Panel
                      </div>
                      <p className="text-on-surface-variant text-[11px] leading-relaxed">
                        Open <span className="text-on-surface font-mono">xampp-control.exe</span>{' '}
                        and click <strong>Start</strong> on <strong>Apache</strong> and{' '}
                        <strong>MySQL</strong> until port{' '}
                        <span className="text-secondary font-mono">3306</span> turns Green.
                      </p>
                    </div>
                    <div className="p-3 rounded-lg bg-surface border border-white/5 space-y-1">
                      <div className="font-mono font-bold text-primary">
                        STEP 3: Open phpMyAdmin &amp; Run SQL
                      </div>
                      <p className="text-on-surface-variant text-[11px] leading-relaxed">
                        Click <strong>Admin</strong> next to MySQL (opens{' '}
                        <span className="text-secondary font-mono">
                          http://localhost/phpmyadmin
                        </span>
                        ), go to the <strong>SQL</strong> tab, and paste the bootstrap script below.
                      </p>
                    </div>
                    <div className="p-3 rounded-lg bg-surface border border-white/5 space-y-1">
                      <div className="font-mono font-bold text-primary">
                        STEP 4: Link IS King Panel
                      </div>
                      <p className="text-on-surface-variant text-[11px] leading-relaxed">
                        Default XAMPP user is <span className="text-on-surface font-mono">root</span>{' '}
                        with an empty password. Click <strong>Connect XAMPP</strong> on the left!
                      </p>
                    </div>
                  </div>

                  <div className="p-3 rounded-lg bg-[#080b11] border border-white/10 space-y-2">
                    <div className="flex items-center justify-between text-[11px] font-mono">
                      <span className="text-outline">
                        XAMPP / phpMyAdmin SQL Bootstrap Script:
                      </span>
                      <button
                        type="button"
                        onClick={() => {
                          navigator.clipboard?.writeText(xamppSqlBootstrapScript).catch(() => {});
                          onShowToast(
                            'Copied XAMPP SQL Script',
                            'Paste this into http://localhost/phpmyadmin -> SQL tab!',
                            'success',
                            'content_copy'
                          );
                        }}
                        className="px-2 py-0.5 rounded bg-primary/20 text-primary hover:bg-primary/30 font-bold cursor-pointer"
                      >
                        Copy SQL Script
                      </button>
                    </div>
                    <pre className="text-[10px] font-mono text-secondary overflow-x-auto max-h-24">
                      {xamppSqlBootstrapScript}
                    </pre>
                  </div>
                </div>
              )}

              {setupGuideTab === 'mariadb' && (
                <div className="space-y-3">
                  <div className="flex items-center justify-between">
                    <h3 className="text-sm font-bold text-on-surface flex items-center gap-2">
                      <span className="material-symbols-outlined text-tertiary">dns</span>
                      How to Setup MariaDB Standalone Server on Your Local PC
                    </h3>
                    <span className="px-2 py-0.5 rounded bg-tertiary/15 text-tertiary text-[10px] font-mono font-bold">
                      High-Performance InnoDB
                    </span>
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5 text-xs">
                    <div className="p-3 rounded-lg bg-surface border border-white/5 space-y-1">
                      <div className="font-mono font-bold text-tertiary">
                        STEP 1: Install MariaDB 11.4 MSI
                      </div>
                      <p className="text-on-surface-variant text-[11px] leading-relaxed">
                        Download MariaDB Server for Windows from{' '}
                        <span className="text-on-surface font-mono">mariadb.org/download</span> and
                        run the x64 MSI installer.
                      </p>
                    </div>
                    <div className="p-3 rounded-lg bg-surface border border-white/5 space-y-1">
                      <div className="font-mono font-bold text-tertiary">
                        STEP 2: Enable TCP Port 3306 &amp; Root Password
                      </div>
                      <p className="text-on-surface-variant text-[11px] leading-relaxed">
                        Check <strong>Install as Windows Service (MariaDB)</strong>, enable networking
                        on port <span className="text-secondary font-mono">3306</span>, and set your
                        root password.
                      </p>
                    </div>
                    <div className="p-3 rounded-lg bg-surface border border-white/5 space-y-1">
                      <div className="font-mono font-bold text-tertiary">
                        STEP 3: Start MariaDB Service in PowerShell
                      </div>
                      <p className="text-on-surface-variant text-[11px] leading-relaxed">
                        Run{' '}
                        <span className="text-primary font-mono">
                          net start MariaDB
                        </span>{' '}
                        in Administrator PowerShell, then create database via{' '}
                        <span className="text-on-surface font-mono">
                          mysql -u root -p -e &quot;CREATE DATABASE isking_panel;&quot;
                        </span>
                      </p>
                    </div>
                    <div className="p-3 rounded-lg bg-surface border border-white/5 space-y-1">
                      <div className="font-mono font-bold text-tertiary">
                        STEP 4: Connect MariaDB in Panel
                      </div>
                      <p className="text-on-surface-variant text-[11px] leading-relaxed">
                        Enter your MariaDB root password on the left and click{' '}
                        <strong>Connect MariaDB</strong> to verify real-time socket connectivity.
                      </p>
                    </div>
                  </div>

                  <div className="p-3 rounded-lg bg-[#080b11] border border-white/10 flex items-center justify-between text-[11px] font-mono">
                    <span className="text-on-surface-variant">
                      PowerShell Quick Command:{' '}
                      <code className="text-tertiary">
                        net start MariaDB &amp;&amp; mysql -u root -p -e &quot;CREATE DATABASE IF NOT EXISTS isking_panel;&quot;
                      </code>
                    </span>
                    <button
                      type="button"
                      onClick={() => {
                        navigator.clipboard
                          ?.writeText(
                            'net start MariaDB && mysql -u root -p -e "CREATE DATABASE IF NOT EXISTS isking_panel;"'
                          )
                          .catch(() => {});
                        onShowToast('Copied MariaDB Command', 'Run in Windows PowerShell!', 'info');
                      }}
                      className="px-2.5 py-1 rounded bg-tertiary/20 text-tertiary font-bold cursor-pointer shrink-0"
                    >
                      Copy CMD
                    </button>
                  </div>
                </div>
              )}

              {setupGuideTab === 'mongodb' && (
                <div className="space-y-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <h3 className="text-sm font-bold text-on-surface flex items-center gap-2">
                        <span className="material-symbols-outlined text-secondary">
                          cloud_sync
                        </span>
                        MongoDB Live Collections (Users, Default Profile Icons, Backups &amp; Logs)
                      </h3>
                      <p className="text-[11px] font-mono text-outline">
                        Every new user signup, profile icon change, backup, and schedule is automatically pushed to MongoDB
                      </p>
                    </div>
                    <div className="flex items-center gap-1.5 flex-wrap">
                      {(rtStatus?.engines.mongodb.collections || []).map((col) => (
                        <button
                          key={col.name}
                          type="button"
                          onClick={() => setActiveMongoCollection(col.name)}
                          className={`px-2.5 py-1 rounded text-[10px] font-mono font-bold cursor-pointer ${
                            activeMongoCollection === col.name
                              ? 'bg-secondary text-on-secondary'
                              : 'bg-surface border border-white/10 text-outline hover:text-on-surface'
                          }`}
                        >
                          {col.name} ({col.count})
                        </button>
                      ))}
                    </div>
                  </div>

                  <div className="p-3 rounded-lg bg-[#080b11] border border-white/10 max-h-48 overflow-y-auto">
                    <pre className="text-[10px] font-mono text-secondary leading-relaxed">
                      {JSON.stringify(currentMongoCol?.sample || [], null, 2)}
                    </pre>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* 3. SUPER ADMIN CREDENTIALS & SQLITE3 STUDIO */}
        <div className="grid grid-cols-12 gap-6 items-start">
          {/* Left 7 Cols: Live SQLite3 SQL Query Studio */}
          <div className="col-span-12 lg:col-span-7 space-y-4">
            <div className="bg-surface rounded-xl border border-outline-variant/15 overflow-hidden shadow-xl">
              <div className="px-5 py-3.5 bg-surface-container border-b border-outline-variant/15 flex items-center justify-between flex-wrap gap-2">
                <div className="flex items-center gap-2">
                  <span className="material-symbols-outlined text-primary text-[19px]">
                    terminal
                  </span>
                  <h2 className="text-xs font-bold uppercase tracking-wider text-on-surface">
                    Live SQLite3 Query Runner (node:sqlite)
                  </h2>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {presetQueries.map((pq) => (
                    <button
                      key={pq.label}
                      type="button"
                      onClick={() => {
                        setSqlInput(pq.sql);
                        executeSqlQuery(pq.sql);
                      }}
                      className="px-2.5 py-1 rounded bg-surface-lowest hover:bg-primary/15 text-outline hover:text-primary border border-outline-variant/25 text-[10px] font-mono transition-colors cursor-pointer"
                    >
                      {pq.label}
                    </button>
                  ))}
                </div>
              </div>

              <div className="p-4 space-y-3">
                <textarea
                  rows={3}
                  value={sqlInput}
                  onChange={(e) => setSqlInput(e.target.value)}
                  className="w-full bg-surface-lowest border border-outline-variant/30 focus:border-primary rounded-lg p-3 text-xs font-mono text-primary focus:outline-none"
                  placeholder="Enter SQL query (SELECT, INSERT, UPDATE, PRAGMA)..."
                />
                <div className="flex items-center justify-between">
                  <span className="text-[11px] font-mono text-outline">
                    Target Instance: <strong className="text-on-surface">{server.name}</strong> •
                    Execution latency: <strong className="text-secondary">{queryElapsedMs} ms</strong>
                  </span>
                  <button
                    type="button"
                    disabled={isRunningQuery}
                    onClick={() => executeSqlQuery()}
                    className="px-4 py-2 rounded-lg bg-primary text-on-primary-container font-bold text-xs flex items-center gap-1.5 hover:opacity-95 transition-opacity cursor-pointer"
                  >
                    <span className="material-symbols-outlined text-[16px]">play_arrow</span>
                    {isRunningQuery ? 'Running...' : 'Execute SQL'}
                  </button>
                </div>

                {queryError && (
                  <div className="p-3 rounded-lg bg-error/10 border border-error/30 text-error text-xs font-mono">
                    {queryError}
                  </div>
                )}

                {/* Result Set Table */}
                <div className="rounded-lg border border-outline-variant/20 bg-surface-lowest overflow-x-auto max-h-[340px]">
                  {queryRows.length === 0 ? (
                    <div className="p-6 text-center text-xs font-mono text-outline">
                      No rows returned for this query.
                    </div>
                  ) : (
                    <table className="w-full text-left border-collapse text-[11px] font-mono">
                      <thead>
                        <tr className="bg-surface-container border-b border-outline-variant/20 text-outline uppercase">
                          {queryColumns.map((col) => (
                            <th key={col} className="py-2 px-3 whitespace-nowrap">
                              {col}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-outline-variant/10">
                        {queryRows.map((row, idx) => (
                          <tr key={idx} className="hover:bg-white/5">
                            {queryColumns.map((col) => {
                              const val = row[col];
                              const strVal =
                                val === null || val === undefined ? 'NULL' : String(val);
                              const isKing = strVal.toLowerCase().includes('kingplayz');
                              return (
                                <td
                                  key={col}
                                  className={`py-2 px-3 whitespace-nowrap ${
                                    isKing ? 'text-primary font-bold' : 'text-on-surface'
                                  }`}
                                >
                                  {strVal}
                                </td>
                              );
                            })}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </div>
              </div>
            </div>
          </div>

          {/* Right 5 Cols: Super Admin User Manager with Default Profile Icons */}
          <div className="col-span-12 lg:col-span-5 space-y-4">
            <div className="bg-surface rounded-xl border border-outline-variant/15 overflow-hidden shadow-xl">
              <div className="px-5 py-3.5 bg-surface-container border-b border-outline-variant/15 flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className="material-symbols-outlined text-primary text-[19px]">
                    manage_accounts
                  </span>
                  <h2 className="text-xs font-bold uppercase tracking-wider text-on-surface">
                    User Accounts &amp; Default Profile Icons (SQLite + MongoDB)
                  </h2>
                </div>
                <span className="text-[10px] font-mono text-secondary">
                  {overview?.users?.length || 4} Accounts
                </span>
              </div>

              <div className="p-5 space-y-4">
                {/* Existing Users List with Profile Icon */}
                <div className="space-y-2 max-h-52 overflow-y-auto pr-1">
                  {(overview?.users || []).map((u) => (
                    <div
                      key={u.id}
                      onClick={() => {
                        setEditingUsername(u.username);
                        setEditingRole(u.role);
                        setEditingLimit(u.maxServerLimit || (u.isSuperAdmin ? 999 : 2));
                        setEditingVerified(Boolean(u.discordVerified));
                      }}
                      className={`p-2.5 rounded-lg border flex items-center justify-between cursor-pointer transition-all ${
                        editingUsername.toLowerCase() === u.username.toLowerCase()
                          ? 'bg-primary/10 border-primary/40'
                          : 'bg-surface-lowest border-outline-variant/15 hover:border-white/20'
                      }`}
                    >
                      <div className="flex items-center gap-2.5 min-w-0">
                        <img
                          src={resolveUserAvatarUrl(u.avatarUrl)}
                          onError={(e) => {
                            (e.currentTarget as HTMLImageElement).src = DEFAULT_PROFILE_ICON_URL;
                          }}
                          alt={u.username}
                          className="w-8 h-8 rounded-lg border border-primary/40 object-cover shrink-0 bg-surface"
                        />
                        <div className="min-w-0">
                          <div className="text-xs font-bold text-on-surface flex items-center gap-1.5">
                            <span className="truncate">@{u.username}</span>
                            {(u.isSuperAdmin || u.role === 'Super Admin') && (
                              <span className="px-1.5 py-0.5 rounded bg-primary text-on-primary-container text-[9px] font-mono font-bold uppercase">
                                SUPER ADMIN
                              </span>
                            )}
                          </div>
                          <div className="text-[10px] font-mono text-outline truncate">
                            ID: {u.id} • {u.email}
                          </div>
                        </div>
                      </div>
                      <div className="text-right font-mono text-[10px] shrink-0">
                        <div className="text-secondary font-bold">
                          Quota: {u.maxServerLimit || 2}
                        </div>
                        <div className="text-outline">
                          {u.discordVerified ? 'Bot Verified' : 'Standard'}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>

                {/* Edit Selected User Form */}
                <form
                  onSubmit={handleUpdateUserInDb}
                  className="space-y-3 pt-3 border-t border-outline-variant/15"
                >
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="text-[11px] font-semibold text-on-surface block mb-1">
                        Target Username
                      </label>
                      <input
                        type="text"
                        value={editingUsername}
                        onChange={(e) => setEditingUsername(e.target.value)}
                        className="w-full bg-surface-lowest border border-outline-variant/25 rounded-lg px-3 py-1.5 text-xs font-mono text-on-surface"
                      />
                    </div>
                    <div>
                      <label className="text-[11px] font-semibold text-on-surface block mb-1">
                        Database Role
                      </label>
                      <select
                        value={editingRole}
                        onChange={(e) => setEditingRole(e.target.value)}
                        className="w-full bg-surface-lowest border border-outline-variant/25 rounded-lg px-3 py-1.5 text-xs text-on-surface"
                      >
                        <option value="Super Admin">Super Admin</option>
                        <option value="Root Admin">Root Admin</option>
                        <option value="DevOps Engineer">DevOps Engineer</option>
                        <option value="Moderator">Moderator</option>
                        <option value="Operator">Operator</option>
                      </select>
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="text-[11px] font-semibold text-on-surface block mb-1">
                        Max Server Limit
                      </label>
                      <input
                        type="number"
                        value={editingLimit}
                        onChange={(e) => setEditingLimit(Number(e.target.value) || 2)}
                        className="w-full bg-surface-lowest border border-outline-variant/25 rounded-lg px-3 py-1.5 text-xs font-mono text-primary font-bold"
                      />
                    </div>
                    <div>
                      <label className="text-[11px] font-semibold text-on-surface block mb-1">
                        Reset Password (Optional)
                      </label>
                      <input
                        type="text"
                        value={editingPassword}
                        onChange={(e) => setEditingPassword(e.target.value)}
                        placeholder="New password..."
                        className="w-full bg-surface-lowest border border-outline-variant/25 rounded-lg px-3 py-1.5 text-xs font-mono text-on-surface"
                      />
                    </div>
                  </div>

                  <button
                    type="submit"
                    className="w-full py-2.5 rounded-lg bg-gradient-to-r from-primary to-primary-container text-on-primary-container font-bold text-xs shadow-lg shadow-primary/15 hover:opacity-95 transition-all flex items-center justify-center gap-2 cursor-pointer"
                  >
                    <span className="material-symbols-outlined text-[17px]">save</span>
                    Commit User Update to SQLite3 &amp; Push to MongoDB
                  </button>
                </form>
              </div>
            </div>
          </div>
        </div>
      </div>
    </main>
  );
};
