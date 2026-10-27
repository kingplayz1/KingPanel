import React, { useCallback, useEffect, useState } from 'react';
import { SectionProps, cardClass, cardTitleClass, ghostBtnClass, inputClass, primaryBtnClass, dangerBtnClass, serverDbSlug } from './types';

/**
 * Database tab: provisions a real MySQL database for this server on the
 * operator's own PC (XAMPP/MariaDB). Every server DB lives inside the panel
 * base database `iskingpanel` — the panel creates `iskingpanel_<server>` and
 * hands back a ready JDBC URL for plugins.
 */

interface DatabaseStatus {
  connected: boolean;
  portOpen: boolean;
  host: string;
  port: number;
  user: string;
  passwordSet: boolean;
  baseDatabase: string;
  databases: string[];
  error?: string;
  authPluginIssue?: boolean;
  phpMyAdminUrl: string;
}

export const SimpleDatabaseSection: React.FC<SectionProps> = ({ server, onShowToast }) => {
  const [status, setStatus] = useState<DatabaseStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [provisioning, setProvisioning] = useState(false);
  const [showConfig, setShowConfig] = useState(false);
  const [config, setConfig] = useState({ host: '127.0.0.1', port: '3306', user: 'root', password: '' });
  const [savingConfig, setSavingConfig] = useState(false);
  const [confirmDrop, setConfirmDrop] = useState<string | null>(null);

  const slug = serverDbSlug(server.id);
  const serverDbName = `iskingpanel_${slug}`;
  const jdbc = status
    ? `jdbc:mysql://${status.host}:${status.port}/${serverDbName}?useSSL=false&allowPublicKeyRetrieval=true`
    : '';

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/database/server-databases');
      const data = await res.json();
      if (data?.ok) {
        setStatus(data);
        setConfig((prev) => ({
          host: data.host || prev.host,
          port: String(data.port || prev.port),
          user: data.user || prev.user,
          password: '',
        }));
      }
    } catch {
      // backend restarting
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 8000);
    return () => clearInterval(timer);
  }, [refresh]);

  const provision = async (targetServerId: string) => {
    setProvisioning(true);
    try {
      const res = await fetch('/api/database/provision-server', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ serverId: targetServerId }),
      });
      const data = await res.json();
      if (!data?.ok) {
        onShowToast('Database not created', data?.error || 'MySQL is unreachable', 'error', 'database_alert');
        return;
      }
      onShowToast('Database ready', data.database, 'success', 'database');
      await refresh();
    } finally {
      setProvisioning(false);
    }
  };

  const saveConfig = async () => {
    setSavingConfig(true);
    try {
      const res = await fetch('/api/database/configure-engine', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          activePrimaryEngine: 'xampp',
          mysqlHost: config.host,
          mysqlPort: Number(config.port) || 3306,
          mysqlUser: config.user,
          ...(config.password ? { mysqlPassword: config.password } : {}),
        }),
      });
      const data = await res.json();
      onShowToast(
        data?.ok ? 'Database connection saved' : 'Could not save',
        data?.message || data?.error,
        data?.ok ? 'success' : 'error',
        'settings'
      );
      setConfig({ ...config, password: '' });
      await refresh();
    } finally {
      setSavingConfig(false);
    }
  };

  const dropDatabase = async (name: string) => {
    const res = await fetch(`/api/database/server-database/${encodeURIComponent(name)}`, { method: 'DELETE' });
    const data = await res.json();
    if (!data?.ok) {
      onShowToast('Drop failed', data?.error, 'error');
      return;
    }
    setConfirmDrop(null);
    onShowToast('Database dropped', name, 'success', 'delete');
    await refresh();
  };

  const copy = async (value: string, label: string) => {
    try {
      await navigator.clipboard.writeText(value);
      onShowToast('Copied', label, 'success', 'content_copy');
    } catch {
      onShowToast('Copy blocked', 'Select the text and copy manually', 'warning');
    }
  };

  const mine = status?.databases.filter((name) => name === serverDbName) || [];
  const others = status?.databases.filter((name) => name !== serverDbName) || [];

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div className={`${cardClass} lg:col-span-2`}>
          <div className="flex items-start justify-between gap-3">
            <div>
              <h2 className={cardTitleClass}>
                <span className="material-symbols-outlined text-[18px] text-primary">database</span>
                MySQL on this PC
              </h2>
              <p className="text-[11px] text-outline mt-1">
                Base database <span className="font-mono text-white">{status?.baseDatabase || 'iskingpanel'}</span> — every
                server gets its own database inside it.
              </p>
            </div>
            <span
              className={`text-[10px] font-bold px-2 py-1 rounded-lg border ${
                status?.connected
                  ? 'text-secondary border-secondary/40 bg-secondary/10'
                  : status?.portOpen
                    ? 'text-amber-300 border-amber-400/40 bg-amber-400/10'
                    : 'text-error border-error/40 bg-error/10'
              }`}
            >
              {status?.connected ? 'CONNECTED' : status?.portOpen ? 'PORT OPEN · AUTH FAILED' : 'OFFLINE'}
            </span>
          </div>

          <div className="grid grid-cols-2 md:grid-cols-4 gap-2 mt-3 text-xs">
            <div className="rounded-xl bg-surface-lowest border border-white/10 px-3 py-2">
              <p className="text-[10px] text-outline uppercase">Host</p>
              <p className="font-mono text-white">{status?.host || config.host}</p>
            </div>
            <div className="rounded-xl bg-surface-lowest border border-white/10 px-3 py-2">
              <p className="text-[10px] text-outline uppercase">Port</p>
              <p className="font-mono text-white">{status?.port || config.port}</p>
            </div>
            <div className="rounded-xl bg-surface-lowest border border-white/10 px-3 py-2">
              <p className="text-[10px] text-outline uppercase">User</p>
              <p className="font-mono text-white">{status?.user || config.user}</p>
            </div>
            <div className="rounded-xl bg-surface-lowest border border-white/10 px-3 py-2">
              <p className="text-[10px] text-outline uppercase">Password</p>
              <p className="font-mono text-white">{status?.passwordSet ? 'set' : 'empty'}</p>
            </div>
          </div>

          {status?.error && (
            <p className={`mt-2 text-[11px] break-words ${status.authPluginIssue ? 'text-amber-300' : 'text-error'}`}>
              {status.error}
            </p>
          )}
          {status?.authPluginIssue && (
            <pre className="mt-2 text-[10.5px] font-mono text-white bg-surface-lowest border border-amber-400/30 rounded-xl p-2.5 whitespace-pre-wrap break-all">
              {`CREATE USER 'iskingpanel'@'localhost' IDENTIFIED BY 'choose-a-password';
GRANT ALL PRIVILEGES ON \`iskingpanel%\`.* TO 'iskingpanel'@'localhost';
FLUSH PRIVILEGES;`}
            </pre>
          )}
          {!status?.portOpen && !loading && (
            <p className="mt-2 text-[11px] text-amber-300">
              Start MySQL/MariaDB in XAMPP Control Panel (port 3306) — the panel then provisions databases
              automatically.
            </p>
          )}

          <div className="flex flex-wrap items-center gap-2 mt-3">
            <button type="button" onClick={() => void refresh()} className={ghostBtnClass} disabled={loading}>
              <span className="material-symbols-outlined text-[16px]">refresh</span>
              {loading ? 'Checking…' : 'Recheck'}
            </button>
            <button type="button" onClick={() => setShowConfig((v) => !v)} className={ghostBtnClass}>
              <span className="material-symbols-outlined text-[16px]">settings</span>
              Connection settings
            </button>
            <button
              type="button"
              onClick={() => void provision(server.id)}
              disabled={provisioning || !status?.portOpen}
              className={primaryBtnClass}
            >
              <span className="material-symbols-outlined text-[16px]">add_box</span>
              {provisioning ? 'Creating…' : `Create ${serverDbName}`}
            </button>
          </div>

          {showConfig && (
            <div className="mt-3 rounded-xl border border-white/10 p-3 space-y-2">
              <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
                <input
                  value={config.host}
                  onChange={(e) => setConfig({ ...config, host: e.target.value })}
                  placeholder="127.0.0.1"
                  className={inputClass}
                />
                <input
                  value={config.port}
                  onChange={(e) => setConfig({ ...config, port: e.target.value })}
                  placeholder="3306"
                  className={inputClass}
                />
                <input
                  value={config.user}
                  onChange={(e) => setConfig({ ...config, user: e.target.value })}
                  placeholder="root"
                  className={inputClass}
                />
                <input
                  value={config.password}
                  onChange={(e) => setConfig({ ...config, password: e.target.value })}
                  type="password"
                  placeholder="password (optional)"
                  className={inputClass}
                />
              </div>
              <div className="flex items-center gap-2">
                <button type="button" onClick={() => void saveConfig()} disabled={savingConfig} className={primaryBtnClass}>
                  {savingConfig ? 'Saving…' : 'Save connection'}
                </button>
                <span className="text-[11px] text-outline">
                  Saved to the panel&apos;s local database config — never leaves this PC.
                </span>
              </div>
            </div>
          )}
        </div>

        <div className={cardClass}>
          <h2 className={`${cardTitleClass} mb-2`}>
            <span className="material-symbols-outlined text-[18px] text-primary">link</span>
            Plugin connection
          </h2>
          <p className="text-[11px] text-outline mb-2">Use this in LuckPerms, CoreProtect, EssentialsX…</p>
          <pre className="text-[10.5px] font-mono text-white bg-surface-lowest border border-white/10 rounded-xl p-2.5 whitespace-pre-wrap break-all">
            {jdbc || '—'}
          </pre>
          <div className="flex items-center gap-2 mt-2">
            <button type="button" onClick={() => void copy(jdbc, 'JDBC URL')} disabled={!jdbc} className={ghostBtnClass}>
              <span className="material-symbols-outlined text-[16px]">content_copy</span>
              Copy URL
            </button>
            <button
              type="button"
              onClick={() => void copy(serverDbName, 'Database name')}
              className={ghostBtnClass}
            >
              Copy name
            </button>
          </div>
          <p className="text-[11px] text-outline mt-2">
            User <span className="font-mono text-white">{status?.user || 'root'}</span>, password is your local MySQL
            password{status?.passwordSet ? ' (already saved in the panel)' : ''}.
          </p>
        </div>
      </div>

      <div className={`${cardClass}`}>
        <h2 className={`${cardTitleClass} mb-3`}>
          <span className="material-symbols-outlined text-[18px] text-primary">account_tree</span>
          Databases in {status?.baseDatabase || 'iskingpanel'}
        </h2>
        <div className="space-y-2">
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-primary/30 bg-primary/5 px-3 py-2.5">
            <div className="min-w-0">
              <p className="text-xs font-mono text-white truncate">{serverDbName}</p>
              <p className="text-[11px] text-outline">
                {mine.length ? 'Provisioned for this server' : 'Not created yet — press “Create” above'}
              </p>
            </div>
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                onClick={() => void provision(server.id)}
                disabled={provisioning || !status?.portOpen}
                className={ghostBtnClass}
              >
                <span className="material-symbols-outlined text-[16px]">build</span>
                {mine.length ? 'Repair / ensure' : 'Create'}
              </button>
              {mine.length > 0 && (
                <button
                  type="button"
                  onClick={() => setConfirmDrop(serverDbName)}
                  className={dangerBtnClass}
                >
                  <span className="material-symbols-outlined text-[16px]">delete</span>
                  Drop
                </button>
              )}
            </div>
          </div>

          {confirmDrop && (
            <div className="rounded-xl border border-error/40 bg-error/10 p-2.5 text-[11px] text-error flex flex-wrap items-center gap-2">
              <span>Drop {confirmDrop}? Plugin data in it is deleted permanently.</span>
              <button type="button" onClick={() => void dropDatabase(confirmDrop)} className="px-2.5 py-1 rounded-lg bg-error text-white font-bold cursor-pointer">
                Drop now
              </button>
              <button type="button" onClick={() => setConfirmDrop(null)} className="px-2.5 py-1 rounded-lg bg-white/10 cursor-pointer">
                Cancel
              </button>
            </div>
          )}

          {others.length > 0 && (
            <div className="pt-2">
              <p className="text-[11px] font-bold text-outline uppercase tracking-wider mb-1.5">
                Other panel databases
              </p>
              <ul className="space-y-1">
                {others.map((name) => (
                  <li
                    key={name}
                    className="flex items-center justify-between gap-2 rounded-lg bg-surface-lowest border border-white/10 px-3 py-2"
                  >
                    <span className="text-xs font-mono text-on-surface-variant truncate">{name}</span>
                    <button
                      type="button"
                      onClick={() => setConfirmDrop(name)}
                      title="Drop database"
                      className="text-outline hover:text-error cursor-pointer"
                    >
                      <span className="material-symbols-outlined text-[16px]">delete</span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {others.length === 0 && mine.length === 0 && (
            <p className="text-xs text-outline">
              No panel databases yet. Creating one also creates the base database{' '}
              <span className="font-mono text-white">iskingpanel</span>.
            </p>
          )}
        </div>
      </div>
    </div>
  );
};
