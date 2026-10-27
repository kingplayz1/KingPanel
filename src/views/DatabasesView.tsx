import React, { useState, useEffect, useCallback } from 'react';
import { ServerInstance, AuthUser } from '../types';

interface DatabasesViewProps {
  server: ServerInstance;
  onShowToast: (
    title: string,
    body?: string,
    type?: 'success' | 'info' | 'warning' | 'error',
    icon?: string,
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

export const DatabasesView: React.FC<DatabasesViewProps> = ({ onShowToast }) => {
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

  useEffect(() => {
    fetchDatabaseOverview();
  }, [fetchDatabaseOverview]);

  // Real-time 2s polling of Database Status (XAMPP / MariaDB port 3306, MongoDB collections, SQLite)
  useEffect(() => {
    if (!livePollDb) return;
    const timer = setInterval(() => {
      fetchDatabaseOverview();
    }, 2000);
    return () => clearInterval(timer);
  }, [livePollDb, fetchDatabaseOverview]);

  const handleSaveAndTestEngine = async (
    engineType: 'xampp' | 'mariadb' | 'mongodb' | 'sqlite',
  ) => {
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
          'database',
        );
      }
    } catch {
      onShowToast(
        'Configuration Error',
        'Failed to update database engine configuration.',
        'error',
      );
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
          'cloud_upload',
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

  const xamppSqlBootstrapScript = `-- KingPanel v4.8 — Local PC XAMPP / MariaDB SQL Bootstrap
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
);`;

  const currentMongoCol =
    rtStatus?.engines.mongodb.collections.find((c) => c.name === activeMongoCollection) ||
    rtStatus?.engines.mongodb.collections[0];

  return (
    <main className="flex-1 flex flex-col bg-surface-dim overflow-hidden">
      {/* Top Contextual Header */}
      <header className="min-h-[54px] px-6 py-2 bg-surface border-b border-white/[0.06] flex flex-wrap items-center justify-between gap-x-4 gap-y-2 shrink-0">
        <div className="flex items-center gap-2.5 min-w-0">
          <span className="material-symbols-outlined text-[18px] text-primary">database</span>
          <h1 className="text-[14.5px] font-semibold tracking-tight text-on-surface whitespace-nowrap">
            Databases
          </h1>
          <span className="w-px h-4 bg-white/10 shrink-0" />
          <p className="text-[11.5px] text-outline font-mono truncate">
            XAMPP :{mysqlPort} · MongoDB {mongoDatabase} · {overview?.sizeFormatted || '0 KB'}
          </p>
          <span
            className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md border font-mono text-[10.5px] shrink-0 ${
              livePollDb
                ? 'border-secondary/25 bg-secondary/10 text-secondary'
                : 'border-white/10 bg-white/[0.03] text-outline'
            }`}
          >
            <span
              className={`size-1.5 rounded-full ${livePollDb ? 'bg-secondary' : 'bg-outline'}`}
            />
            {livePollDb ? `synced ${lastSyncedAt}` : 'polling paused'}
          </span>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          <button
            type="button"
            onClick={() => setLivePollDb(!livePollDb)}
            className={`inline-flex items-center gap-1.5 h-8 px-3 rounded-lg border font-mono text-[11px] transition-colors cursor-pointer ${
              livePollDb
                ? 'bg-secondary/10 text-secondary border-secondary/25'
                : 'bg-white/[0.02] text-outline border-white/10 hover:text-white'
            }`}
          >
            <span
              className={`size-1.5 rounded-full ${livePollDb ? 'bg-secondary' : 'bg-outline'}`}
            />
            {livePollDb ? 'Polling 2s' : 'Poll paused'}
          </button>

          <button
            type="button"
            onClick={handlePushAllToMongoDB}
            disabled={pushingMongo}
            className="inline-flex items-center gap-1.5 h-8 px-3 rounded-lg border border-white/10 bg-white/[0.02] hover:bg-white/[0.06] text-[11.5px] font-medium text-on-surface transition-colors disabled:opacity-50 cursor-pointer"
          >
            <span className="material-symbols-outlined text-[16px] text-secondary">cloud_upload</span>
            {pushingMongo ? 'Pushing...' : 'Push to MongoDB'}
          </button>

          <button
            type="button"
            onClick={handleVacuum}
            className="inline-flex items-center gap-1.5 h-8 px-3 rounded-lg border border-white/10 bg-white/[0.02] hover:bg-white/[0.06] text-[11.5px] font-medium text-on-surface transition-colors cursor-pointer"
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
                ? 'bg-primary/10 border-primary/50 '
                : 'bg-surface border-white/[0.06] hover:border-primary/30'
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
            <div className="mt-3 pt-2 border-t border-white/[0.06] flex items-center justify-between text-[10px] font-mono">
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
                ? 'bg-tertiary/10 border-tertiary/50 '
                : 'bg-surface border-white/[0.06] hover:border-tertiary/30'
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
            <div className="mt-3 pt-2 border-t border-white/[0.06] flex items-center justify-between text-[10px] font-mono">
              <span className="text-on-surface-variant">
                Host: {mysqlHost}:{mysqlPort}
              </span>
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
                ? 'bg-secondary/10 border-secondary/50 '
                : 'bg-surface border-white/[0.06] hover:border-secondary/30'
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
            <div className="mt-3 pt-2 border-t border-white/[0.06] flex items-center justify-between text-[10px] font-mono">
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
                ? 'bg-primary/10 border-primary/50 '
                : 'bg-surface border-white/[0.06] hover:border-primary/30'
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
            <div className="mt-3 pt-2 border-t border-white/[0.06] flex items-center justify-between text-[10px] font-mono">
              <span className="text-on-surface-variant">
                Size: {overview?.sizeFormatted || '64 KB'}
              </span>
              <span className="text-primary-gold font-bold">Active Engine ✓</span>
            </div>
          </div>
        </div>

        {/* 2. LOCAL PC DATABASE SYSTEM SETUP (XAMPP / MARIADB / MONGODB) & STEP-BY-STEP GUIDE */}
        <div className="bg-surface rounded-xl border border-primary/25 overflow-hidden">
          <div className="px-5 py-3.5 bg-surface-container border-b border-white/[0.06] flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2.5">
              <span className="material-symbols-outlined text-primary text-[20px]">
                build_circle
              </span>
              <div>
                <h2 className="text-xs font-bold uppercase tracking-wider text-on-surface">
                  Local PC Database System Setup (XAMPP or MariaDB on Your PC + MongoDB Push)
                </h2>
                <p className="text-[11px] font-mono text-outline">
                  Configure XAMPP (MySQL) or MariaDB on your Local PC, follow the step-by-step setup
                  guide, and inspect live MongoDB document pushes
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
                      ? 'bg-primary text-on-primary-container '
                      : 'bg-surface-lowest text-outline hover:text-on-surface border border-white/[0.08]'
                  }`}
                >
                  {tab.label}
                </button>
              ))}
            </div>
          </div>

          <div className="p-5 grid grid-cols-1 lg:grid-cols-12 gap-6">
            {/* Left 5 Cols: Live Connection Configurator for XAMPP / MariaDB / MongoDB */}
            <div className="lg:col-span-5 space-y-4 bg-surface-lowest p-4 rounded-xl border border-white/[0.08]">
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
                    className="w-full bg-surface border border-white/[0.06] rounded-lg px-3 py-1.5 text-xs font-mono text-on-surface"
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
                    className="w-full bg-surface border border-white/[0.06] rounded-lg px-3 py-1.5 text-xs font-mono text-primary font-bold"
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
                    className="w-full bg-surface border border-white/[0.06] rounded-lg px-3 py-1.5 text-xs font-mono text-on-surface"
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
                    className="w-full bg-surface border border-white/[0.06] rounded-lg px-3 py-1.5 text-xs font-mono text-on-surface"
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
                    className="w-full bg-surface border border-white/[0.06] rounded-lg px-3 py-1.5 text-xs font-mono text-secondary font-bold"
                  />
                </div>
              </div>

              <div className="pt-2 border-t border-white/[0.08]">
                <label className="text-[10px] font-mono uppercase text-outline block mb-1">
                  MongoDB Connection URI (For User &amp; Profile Data Push)
                </label>
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={mongoUri}
                    onChange={(e) => setMongoUri(e.target.value)}
                    className="flex-1 bg-surface border border-white/[0.06] rounded-lg px-3 py-1.5 text-xs font-mono text-on-surface"
                  />
                  <input
                    type="text"
                    value={mongoDatabase}
                    onChange={(e) => setMongoDatabase(e.target.value)}
                    className="w-28 bg-surface border border-white/[0.06] rounded-lg px-2.5 py-1.5 text-xs font-mono text-secondary"
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
            <div className="lg:col-span-7 bg-surface-lowest p-4 rounded-xl border border-white/[0.08] flex flex-col justify-between gap-4">
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
                    <div className="p-3 rounded-lg bg-surface border border-white/[0.06] space-y-1">
                      <div className="font-mono font-bold text-primary">
                        STEP 1: Install XAMPP on Local PC
                      </div>
                      <p className="text-on-surface-variant text-[11px] leading-relaxed">
                        Download XAMPP for Windows from{' '}
                        <span className="text-on-surface font-mono">apachefriends.org</span> and
                        install into <span className="text-primary font-mono">C:\xampp</span>.
                      </p>
                    </div>
                    <div className="p-3 rounded-lg bg-surface border border-white/[0.06] space-y-1">
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
                    <div className="p-3 rounded-lg bg-surface border border-white/[0.06] space-y-1">
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
                    <div className="p-3 rounded-lg bg-surface border border-white/[0.06] space-y-1">
                      <div className="font-mono font-bold text-primary">
                        STEP 4: Link KingPanel
                      </div>
                      <p className="text-on-surface-variant text-[11px] leading-relaxed">
                        Default XAMPP user is{' '}
                        <span className="text-on-surface font-mono">root</span> with an empty
                        password. Click <strong>Connect XAMPP</strong> on the left!
                      </p>
                    </div>
                  </div>

                  <div className="p-3 rounded-lg bg-[#080b11] border border-white/[0.08] space-y-2">
                    <div className="flex items-center justify-between text-[11px] font-mono">
                      <span className="text-outline">XAMPP / phpMyAdmin SQL Bootstrap Script:</span>
                      <button
                        type="button"
                        onClick={() => {
                          navigator.clipboard?.writeText(xamppSqlBootstrapScript).catch(() => {});
                          onShowToast(
                            'Copied XAMPP SQL Script',
                            'Paste this into http://localhost/phpmyadmin -> SQL tab!',
                            'success',
                            'content_copy',
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
                    <div className="p-3 rounded-lg bg-surface border border-white/[0.06] space-y-1">
                      <div className="font-mono font-bold text-tertiary">
                        STEP 1: Install MariaDB 11.4 MSI
                      </div>
                      <p className="text-on-surface-variant text-[11px] leading-relaxed">
                        Download MariaDB Server for Windows from{' '}
                        <span className="text-on-surface font-mono">mariadb.org/download</span> and
                        run the x64 MSI installer.
                      </p>
                    </div>
                    <div className="p-3 rounded-lg bg-surface border border-white/[0.06] space-y-1">
                      <div className="font-mono font-bold text-tertiary">
                        STEP 2: Enable TCP Port 3306 &amp; Root Password
                      </div>
                      <p className="text-on-surface-variant text-[11px] leading-relaxed">
                        Check <strong>Install as Windows Service (MariaDB)</strong>, enable
                        networking on port <span className="text-secondary font-mono">3306</span>,
                        and set your root password.
                      </p>
                    </div>
                    <div className="p-3 rounded-lg bg-surface border border-white/[0.06] space-y-1">
                      <div className="font-mono font-bold text-tertiary">
                        STEP 3: Start MariaDB Service in PowerShell
                      </div>
                      <p className="text-on-surface-variant text-[11px] leading-relaxed">
                        Run <span className="text-primary font-mono">net start MariaDB</span> in
                        Administrator PowerShell, then create database via{' '}
                        <span className="text-on-surface font-mono">
                          mysql -u root -p -e &quot;CREATE DATABASE isking_panel;&quot;
                        </span>
                      </p>
                    </div>
                    <div className="p-3 rounded-lg bg-surface border border-white/[0.06] space-y-1">
                      <div className="font-mono font-bold text-tertiary">
                        STEP 4: Connect MariaDB in Panel
                      </div>
                      <p className="text-on-surface-variant text-[11px] leading-relaxed">
                        Enter your MariaDB root password on the left and click{' '}
                        <strong>Connect MariaDB</strong> to verify real-time socket connectivity.
                      </p>
                    </div>
                  </div>

                  <div className="p-3 rounded-lg bg-[#080b11] border border-white/[0.08] flex items-center justify-between text-[11px] font-mono">
                    <span className="text-on-surface-variant">
                      PowerShell Quick Command:{' '}
                      <code className="text-tertiary">
                        net start MariaDB &amp;&amp; mysql -u root -p -e &quot;CREATE DATABASE IF
                        NOT EXISTS isking_panel;&quot;
                      </code>
                    </span>
                    <button
                      type="button"
                      onClick={() => {
                        navigator.clipboard
                          ?.writeText(
                            'net start MariaDB && mysql -u root -p -e "CREATE DATABASE IF NOT EXISTS isking_panel;"',
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
                        <span className="material-symbols-outlined text-secondary">cloud_sync</span>
                        MongoDB Live Collections (Users, Default Profile Icons, Backups &amp; Logs)
                      </h3>
                      <p className="text-[11px] font-mono text-outline">
                        Every new user signup, profile icon change, backup, and schedule is
                        automatically pushed to MongoDB
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
                              : 'bg-surface border border-white/[0.08] text-outline hover:text-on-surface'
                          }`}
                        >
                          {col.name} ({col.count})
                        </button>
                      ))}
                    </div>
                  </div>

                  <div className="p-3 rounded-lg bg-[#080b11] border border-white/[0.08] max-h-48 overflow-y-auto">
                    <pre className="text-[10px] font-mono text-secondary leading-relaxed">
                      {JSON.stringify(currentMongoCol?.sample || [], null, 2)}
                    </pre>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </main>
  );
};
