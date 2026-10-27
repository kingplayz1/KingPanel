import React, { useCallback, useEffect, useState } from 'react';
import { SectionProps, cardClass, cardTitleClass, dangerBtnClass, formatBytes, ghostBtnClass, inputClass, primaryBtnClass } from './types';

/**
 * Settings tab: change the details written into server.properties (port, motd,
 * players, difficulty, online-mode, view distance) plus RAM/engine, show debug
 * information from the container state and offer a full resetup (wipe + jar).
 */

interface ContainerState {
  phase: string;
  serverId: string;
  hasJar: boolean;
  eulaAccepted: boolean;
  engine: string;
  version: string;
  mainFile: string;
  port: number | null;
  ramMaxGb: number | null;
  javaPath: string;
  dir: string;
  storageMb: number;
  blockers: string[];
  runtime: { state: string; pid: number | null; lastExitCode: number | null; lastExitReason: string | null } | null;
}

interface SettingsForm {
  port: string;
  ramMaxGb: string;
  motd: string;
  maxPlayers: string;
  difficulty: string;
  onlineMode: boolean;
  viewDistance: string;
}

const PHASE_STYLES: Record<string, string> = {
  running: 'text-secondary border-secondary/40 bg-secondary/10',
  ready: 'text-primary border-primary/40 bg-primary/10',
  installing: 'text-amber-300 border-amber-400/40 bg-amber-400/10',
  error: 'text-error border-error/40 bg-error/10',
};

interface SimpleSettingsSectionProps extends SectionProps {
  onServerUpdated?: (patch: { name?: string; ramMaxGb?: number; port?: number }) => void;
}

export const SimpleSettingsSection: React.FC<SimpleSettingsSectionProps> = ({ server, onShowToast, onServerUpdated }) => {
  const [state, setState] = useState<ContainerState | null>(null);
  const [form, setForm] = useState<SettingsForm>({
    port: String(server.port || 25565),
    ramMaxGb: String(server.ramMaxGb || 4),
    motd: '',
    maxPlayers: '20',
    difficulty: 'normal',
    onlineMode: true,
    viewDistance: '10',
  });
  const [saving, setSaving] = useState(false);
  const [wipe, setWipe] = useState(true);
  const [keepBackups, setKeepBackups] = useState(true);
  const [confirmReinstall, setConfirmReinstall] = useState(false);
  const [reinstalling, setReinstalling] = useState(false);

  const query = `serverId=${encodeURIComponent(server.id)}&serverName=${encodeURIComponent(server.name)}`;

  // Prefill from the real server.properties so the form shows current values.
  const loadProperties = useCallback(async () => {
    try {
      const res = await fetch(`/api/server-runtime/file?${query}&path=server.properties`);
      const data = await res.json();
      if (!data?.ok || typeof data.content !== 'string') return;
      const map: Record<string, string> = {};
      for (const line of String(data.content).split(/\r?\n/)) {
        const match = /^\s*([\w.-]+)\s*=\s*(.*)$/.exec(line);
        if (match) map[match[1]] = match[2];
      }
      setForm((prev) => ({
        ...prev,
        port: map.port || prev.port,
        motd: map.motd ?? prev.motd,
        maxPlayers: map['max-players'] || prev.maxPlayers,
        difficulty: map.difficulty || prev.difficulty,
        onlineMode: map['online-mode'] !== undefined ? map['online-mode'] === 'true' : prev.onlineMode,
        viewDistance: map['view-distance'] || prev.viewDistance,
      }));
    } catch {
      // properties unreadable — keep defaults
    }
  }, [query]);

  const loadState = useCallback(async () => {
    try {
      const res = await fetch(`/api/server-runtime/container-state?${query}`);
      const data = await res.json();
      if (data?.ok) {
        const next = data as ContainerState;
        setState(next);
        setForm((prev) => ({
          ...prev,
          port: String(next.port ?? server.port ?? 25565),
          ramMaxGb: String(next.ramMaxGb ?? server.ramMaxGb ?? 4),
        }));
      }
    } catch {
      // backend restarting
    }
    await loadProperties();
  }, [query, server.port, server.ramMaxGb, loadProperties]);

  useEffect(() => {
    void loadState();
  }, [loadState]);

  const save = async () => {
    setSaving(true);
    try {
      const res = await fetch('/api/server-runtime/server-settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          serverId: server.id,
          serverName: server.name,
          port: Number(form.port),
          ramMaxGb: Number(form.ramMaxGb),
          motd: form.motd,
          maxPlayers: Number(form.maxPlayers),
          difficulty: form.difficulty,
          onlineMode: form.onlineMode,
          viewDistance: Number(form.viewDistance),
        }),
      });
      const data = await res.json();
      if (!data?.ok) {
        onShowToast('Could not save settings', data?.error, 'error');
        return;
      }
      onShowToast(
        'Server details saved',
        data.restartRequired ? 'Restart the server to apply them' : data.written?.join(', ') || 'Saved',
        'success',
        'settings'
      );
      onServerUpdated?.({ port: Number(form.port), ramMaxGb: Number(form.ramMaxGb) });
      await loadState();
    } finally {
      setSaving(false);
    }
  };

  const reinstall = async () => {
    setReinstalling(true);
    try {
      const res = await fetch('/api/server-runtime/reinstall', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ serverId: server.id, serverName: server.name, wipe, keepBackups }),
      });
      const data = await res.json();
      if (!data?.ok) {
        onShowToast('Resetup failed', data?.error, 'error', 'error');
        return;
      }
      setConfirmReinstall(false);
      onShowToast(
        'Server resetup complete',
        `jar ${data.jar?.installed ? 'installed' : 'failed'}${data.wiped ? ` · wiped ${data.wipedEntries?.length || 0} entries` : ''}`,
        'success',
        'restart_alt'
      );
      await loadState();
    } finally {
      setReinstalling(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div className={`${cardClass} lg:col-span-2`}>
          <h2 className={`${cardTitleClass} mb-3`}>
            <span className="material-symbols-outlined text-[18px] text-primary">tune</span>
            Server details
          </h2>
          <div className="grid grid-cols-2 md:grid-cols-3 gap-2">
            <div>
              <label className="text-[11px] font-bold text-outline uppercase tracking-wider">Port</label>
              <input
                value={form.port}
                onChange={(e) => setForm({ ...form, port: e.target.value })}
                type="number"
                min={1}
                max={65535}
                className={`${inputClass} mt-1`}
              />
            </div>
            <div>
              <label className="text-[11px] font-bold text-outline uppercase tracking-wider">Max RAM (GB)</label>
              <input
                value={form.ramMaxGb}
                onChange={(e) => setForm({ ...form, ramMaxGb: e.target.value })}
                type="number"
                min={1}
                max={64}
                className={`${inputClass} mt-1`}
              />
            </div>
            <div>
              <label className="text-[11px] font-bold text-outline uppercase tracking-wider">Max players</label>
              <input
                value={form.maxPlayers}
                onChange={(e) => setForm({ ...form, maxPlayers: e.target.value })}
                type="number"
                min={1}
                className={`${inputClass} mt-1`}
              />
            </div>
            <div className="col-span-2 md:col-span-3">
              <label className="text-[11px] font-bold text-outline uppercase tracking-wider">MOTD</label>
              <input
                value={form.motd}
                onChange={(e) => setForm({ ...form, motd: e.target.value })}
                placeholder={`${server.name} — powered by KingPanel`}
                className={`${inputClass} mt-1`}
              />
            </div>
            <div>
              <label className="text-[11px] font-bold text-outline uppercase tracking-wider">Difficulty</label>
              <select
                value={form.difficulty}
                onChange={(e) => setForm({ ...form, difficulty: e.target.value })}
                className={`${inputClass} mt-1`}
              >
                {['peaceful', 'easy', 'normal', 'hard'].map((d) => (
                  <option key={d} value={d}>
                    {d}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="text-[11px] font-bold text-outline uppercase tracking-wider">View distance</label>
              <input
                value={form.viewDistance}
                onChange={(e) => setForm({ ...form, viewDistance: e.target.value })}
                type="number"
                min={2}
                max={32}
                className={`${inputClass} mt-1`}
              />
            </div>
            <div>
              <label className="text-[11px] font-bold text-outline uppercase tracking-wider">Online mode</label>
              <button
                type="button"
                onClick={() => setForm({ ...form, onlineMode: !form.onlineMode })}
                className={`mt-1 w-full px-3 py-2.5 rounded-xl border text-xs font-bold cursor-pointer ${
                  form.onlineMode
                    ? 'bg-secondary/15 border-secondary/40 text-secondary'
                    : 'bg-white/5 border-white/15 text-outline'
                }`}
              >
                {form.onlineMode ? 'Premium accounts only' : 'Offline / cracked allowed'}
              </button>
            </div>
          </div>
          <div className="flex items-center gap-2 mt-3">
            <button type="button" onClick={() => void save()} disabled={saving} className={primaryBtnClass}>
              <span className="material-symbols-outlined text-[16px]">save</span>
              {saving ? 'Saving…' : 'Save details'}
            </button>
            <span className="text-[11px] text-outline">Written straight into server.properties.</span>
          </div>
        </div>

        <div className={cardClass}>
          <div className="flex items-center justify-between mb-2">
            <h2 className={cardTitleClass}>
              <span className="material-symbols-outlined text-[18px] text-primary">bug_report</span>
              Debug information
            </h2>
            <span
              className={`text-[10px] font-bold px-2 py-1 rounded-lg border ${
                PHASE_STYLES[state?.phase || ''] || 'text-outline border-white/15 bg-white/5'
              }`}
            >
              {(state?.phase || 'unknown').toUpperCase()}
            </span>
          </div>
          <dl className="space-y-1.5 text-[11px]">
            {[
              ['Container', state?.serverId || server.id],
              ['Engine', `${state?.engine || '—'} ${state?.version || ''}`.trim()],
              ['Main file', state?.mainFile || 'server.jar'],
              ['server.jar', state?.hasJar ? 'present' : 'missing'],
              ['EULA', state?.eulaAccepted ? 'accepted' : 'not accepted'],
              ['Storage', state ? formatBytes(state.storageMb * 1024 * 1024) : '—'],
              ['Process', state?.runtime?.pid ? `PID ${state.runtime.pid}` : 'not running'],
              ['Last exit', state?.runtime?.lastExitReason || '—'],
            ].map(([label, value]) => (
              <div key={label} className="flex items-center justify-between gap-2">
                <dt className="text-outline shrink-0">{label}</dt>
                <dd className="font-mono text-white truncate max-w-[200px]" title={String(value)}>
                  {value}
                </dd>
              </div>
            ))}
          </dl>
          <pre className="mt-2 text-[10px] font-mono text-outline bg-surface-lowest border border-white/10 rounded-lg p-2 whitespace-pre-wrap break-all max-h-24 overflow-y-auto">
            {state?.dir || server.path}
          </pre>
          {state?.blockers?.length ? (
            <ul className="mt-2 space-y-1">
              {state.blockers.map((blocker) => (
                <li key={blocker} className="text-[11px] text-amber-300 flex items-start gap-1.5">
                  <span className="material-symbols-outlined text-[14px]">warning</span>
                  {blocker}
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-2 text-[11px] text-secondary flex items-center gap-1.5">
              <span className="material-symbols-outlined text-[14px]">check_circle</span>
              Container is healthy
            </p>
          )}
          <button type="button" onClick={() => void loadState()} className={`${ghostBtnClass} mt-2 w-full justify-center`}>
            <span className="material-symbols-outlined text-[16px]">refresh</span>
            Refresh debug info
          </button>
        </div>
      </div>

      <div className={`${cardClass} border-error/30`}>
        <h2 className={`${cardTitleClass} mb-2`}>
          <span className="material-symbols-outlined text-[18px] text-error">restart_alt</span>
          Reinstall / resetup server
        </h2>
        <p className="text-[11px] text-outline mb-2">
          Rebuilds this server container: stops the process, optionally wipes the folder, re-provisions{' '}
          <span className="font-mono text-white">server.properties</span>, <span className="font-mono text-white">eula.txt</span>{' '}
          and <span className="font-mono text-white">start.sh</span>, then downloads a fresh{' '}
          <span className="font-mono text-white">server.jar</span> for{' '}
          <span className="font-mono text-white">
            {state?.engine || '?'} {state?.version || ''}
          </span>
          .
        </p>
        <div className="flex flex-wrap items-center gap-3 text-[11px] text-outline">
          <label className="flex items-center gap-1.5 cursor-pointer">
            <input type="checkbox" checked={wipe} onChange={(e) => setWipe(e.target.checked)} />
            Wipe world &amp; files
          </label>
          <label className="flex items-center gap-1.5 cursor-pointer">
            <input type="checkbox" checked={keepBackups} onChange={(e) => setKeepBackups(e.target.checked)} />
            Keep backups/ folder
          </label>
          <span className="font-mono">RAM {form.ramMaxGb} GB · port {form.port}</span>
        </div>
        {!confirmReinstall ? (
          <button type="button" onClick={() => setConfirmReinstall(true)} className={`${dangerBtnClass} mt-3`}>
            <span className="material-symbols-outlined text-[16px]">restart_alt</span>
            Resetup this server
          </button>
        ) : (
          <div className="mt-3 rounded-xl border border-error/40 bg-error/10 p-3 text-[11px] text-error space-y-2">
            <p>
              This deletes {wipe ? 'every file in the server folder' : 'nothing (jar + config re-applied)'}. Worlds are
              lost unless you backed them up.
            </p>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => void reinstall()}
                disabled={reinstalling}
                className="px-3 py-1.5 rounded-lg bg-error text-white font-bold cursor-pointer disabled:opacity-50"
              >
                {reinstalling ? 'Resetup running…' : 'Yes, resetup'}
              </button>
              <button
                type="button"
                onClick={() => setConfirmReinstall(false)}
                className="px-3 py-1.5 rounded-lg bg-white/10 cursor-pointer"
              >
                Cancel
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
