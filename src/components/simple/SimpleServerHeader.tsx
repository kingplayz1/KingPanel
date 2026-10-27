import React, { useEffect, useMemo, useState } from 'react';
import { ServerInstance } from '../../types';
import { SimpleWindowControls } from '../SimpleWindowControls';
import { ToastFn } from './types';

export type SimpleHeaderState = 'running' | 'starting' | 'stopping' | 'stopped' | 'crashed';

interface SimpleServerHeaderProps {
  server: ServerInstance;
  state: SimpleHeaderState;
  pid: number | null;
  uptime: string;
  cpuPct: number;
  ramUsedMb: number;
  phase: string;
  engine: string;
  version: string;
  mainFile: string;
  hasJar: boolean;
  blockers: string[];
  busy: string | null;
  onBack: () => void;
  onOpenAdvanced: () => void;
  onPower: (action: 'start' | 'restart' | 'stop' | 'kill') => void;
  onShowToast: ToastFn;
}

interface HostAddress {
  name: string;
  address: string;
}

const STATE_META: Record<SimpleHeaderState, { dot: string; text: string; label: string }> = {
  running: { dot: 'bg-secondary animate-pulse', text: 'text-secondary', label: 'RUNNING' },
  starting: { dot: 'bg-amber-400 animate-pulse', text: 'text-amber-300', label: 'STARTING' },
  stopping: { dot: 'bg-amber-400 animate-pulse', text: 'text-amber-300', label: 'STOPPING' },
  stopped: { dot: 'bg-error', text: 'text-outline', label: 'STOPPED' },
  crashed: { dot: 'bg-error animate-pulse', text: 'text-error', label: 'CRASHED' },
};

const PHASE_LABEL: Record<string, string> = {
  running: 'RUNNING',
  ready: 'READY',
  installing: 'NEEDS SETUP',
  error: 'ERROR',
};

const PHASE_STYLE: Record<string, string> = {
  running: 'text-secondary border-secondary/40 bg-secondary/10',
  ready: 'text-primary border-primary/40 bg-primary/10',
  installing: 'text-amber-300 border-amber-400/40 bg-amber-400/10',
  error: 'text-error border-error/40 bg-error/10',
};

const pickLanAddress = (entries: HostAddress[]): HostAddress | null => {
  const ipv4Only = entries.filter((e) => /^\d+\.\d+\.\d+\.\d+$/.test(e.address));
  const preferred = ['192.168.', '10.', '172.16.', '172.17.', '172.18.', '172.19.'];
  return (
    ipv4Only.find((e) => preferred.some((prefix) => e.address.startsWith(prefix))) ||
    ipv4Only[0] ||
    null
  );
};

const formatGb = (mb: number): string => (mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${mb} MB`);

export const SimpleServerHeader: React.FC<SimpleServerHeaderProps> = ({
  server,
  state,
  pid,
  uptime,
  cpuPct,
  ramUsedMb,
  phase,
  engine,
  version,
  mainFile,
  hasJar,
  blockers,
  busy,
  onBack,
  onOpenAdvanced,
  onPower,
  onShowToast,
}) => {
  const [addresses, setAddresses] = useState<HostAddress[]>([]);
  const meta = STATE_META[state] || STATE_META.stopped;

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch('/api/network/local-ports');
        const data = await res.json();
        if (cancelled || !data?.ok || !Array.isArray(data.interfaces)) return;
        setAddresses(
          data.interfaces
            .filter((i: { internal?: boolean; family?: string }) => !i.internal && String(i.family).includes('4'))
            .map((i: { name?: string; address?: string }) => ({
              name: String(i.name || 'adapter'),
              address: String(i.address || ''),
            }))
            .filter((i: HostAddress) => Boolean(i.address))
        );
      } catch {
        // backend restarting — the header falls back to localhost
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const lan = useMemo(() => pickLanAddress(addresses), [addresses]);
  const port = server.port || '—';
  const joinAddress = `${lan?.address || 'localhost'}:${port}`;
  const localAddress = `localhost:${port}`;

  const copy = async (value: string, label: string) => {
    try {
      await navigator.clipboard.writeText(value);
      onShowToast(`${label} copied`, value, 'success', 'content_copy');
      return;
    } catch {
      // fall through to the legacy path (unfocused windows, restricted previews)
    }
    try {
      const area = document.createElement('textarea');
      area.value = value;
      area.setAttribute('readonly', 'readonly');
      area.style.position = 'fixed';
      area.style.opacity = '0';
      document.body.appendChild(area);
      area.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(area);
      if (ok) {
        onShowToast(`${label} copied`, value, 'success', 'content_copy');
        return;
      }
    } catch {
      // ignore and report below
    }
    onShowToast('Copy blocked', `Copy ${value} manually — this window refused clipboard access.`, 'warning', 'error');
  };

  const running = state === 'running' || state === 'starting' || state === 'stopping';
  const canStart = !running;
  const canStop = running;
  const canKill = running;

  const powerButton = (
    action: 'start' | 'restart' | 'stop' | 'kill',
    label: string,
    icon: string,
    classes: string,
    enabled: boolean,
    title?: string
  ) => (
    <button
      type="button"
      onClick={() => onPower(action)}
      disabled={busy !== null || !enabled}
      title={title || label}
      className={`px-3 py-1.5 rounded-lg text-[11px] font-bold flex items-center gap-1.5 border transition-colors ${
        enabled ? 'cursor-pointer' : 'cursor-not-allowed opacity-40'
      } ${classes}`}
    >
      <span className="material-symbols-outlined text-[15px]">{icon}</span>
      {label}
    </button>
  );

  return (
    <header
      className="shrink-0 bg-surface border-b border-white/10"
      style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
    >
      <div className="px-4 pt-3 pb-2 flex items-start justify-between gap-4">
        {/* Identity block */}
        <div className="flex items-center gap-3 min-w-0">
          <button
            type="button"
            onClick={onBack}
            className="p-2 rounded-xl bg-white/5 hover:bg-white/10 border border-white/10 text-outline hover:text-white cursor-pointer"
            style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
            title="Back to server list"
          >
            <span className="material-symbols-outlined text-[18px]">arrow_back</span>
          </button>
          <div className="size-10 rounded-xl bg-primary/15 border border-primary/30 flex items-center justify-center text-primary shrink-0">
            <span className="material-symbols-outlined text-[20px]">dns</span>
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-2 min-w-0">
              <span className={`w-2.5 h-2.5 rounded-full shrink-0 ${meta.dot}`} />
              <h1 className="text-[15px] font-bold text-white truncate" title={server.name}>
                {server.name}
              </h1>
              <span className={`text-[10.5px] font-bold font-mono ${meta.text}`}>{meta.label}</span>
              <span
                className={`text-[9.5px] font-bold px-1.5 py-0.5 rounded border font-mono ${
                  PHASE_STYLE[phase] || PHASE_STYLE.installing
                }`}
                title={blockers.length ? blockers.join(' · ') : 'Server folder provisioned'}
              >
                {PHASE_LABEL[phase] || phase.toUpperCase()}
              </span>
            </div>
            <p className="text-[11px] font-mono text-outline truncate mt-0.5">
              {engine}
              {version ? ` ${version}` : ''} · {mainFile} {hasJar ? '' : '(missing)'} ·{' '}
              {pid ? `PID ${pid}` : 'no process'} · {uptime}
            </p>
          </div>
        </div>

        {/* Window controls */}
        <div className="flex items-center gap-2 shrink-0" style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
          <button
            type="button"
            onClick={onOpenAdvanced}
            className="px-3 py-1.5 rounded-lg bg-primary hover:opacity-95 text-on-primary-container text-[11px] font-bold flex items-center gap-1.5 cursor-pointer"
          >
            <span className="material-symbols-outlined text-[15px]">space_dashboard</span>
            Advanced Panel
          </button>
          <SimpleWindowControls className="ml-1 pl-2 border-l border-white/10" />
        </div>
      </div>

      {/* Address + power row */}
      <div
        className="px-4 pb-3 flex flex-wrap items-center justify-between gap-3"
        style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
      >
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => void copy(joinAddress, 'Server address')}
            className="group flex items-center gap-2 px-2.5 py-1.5 rounded-lg bg-surface-container-high border border-white/10 hover:border-primary/40 cursor-pointer"
            title={`Copy join address (${lan?.name || 'localhost'})`}
          >
            <span className="material-symbols-outlined text-[15px] text-secondary">lan</span>
            <span className="text-[10px] font-mono uppercase text-outline">IP</span>
            <span className="text-[11.5px] font-mono font-bold text-white">{joinAddress}</span>
            <span className="material-symbols-outlined text-[13px] text-outline group-hover:text-primary">
              content_copy
            </span>
          </button>

          <button
            type="button"
            onClick={() => void copy(String(port), 'Port')}
            className="group flex items-center gap-2 px-2.5 py-1.5 rounded-lg bg-surface-container-high border border-white/10 hover:border-primary/40 cursor-pointer"
            title="Copy port"
          >
            <span className="material-symbols-outlined text-[15px] text-primary">settings_ethernet</span>
            <span className="text-[10px] font-mono uppercase text-outline">Port</span>
            <span className="text-[11.5px] font-mono font-bold text-white">{port}</span>
            <span className="material-symbols-outlined text-[13px] text-outline group-hover:text-primary">
              content_copy
            </span>
          </button>

          <span className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-surface-container border border-white/5">
            <span className="material-symbols-outlined text-[15px] text-outline">memory</span>
            <span className="text-[11px] font-mono text-white">{formatGb(ramUsedMb)}</span>
            <span className="text-[10px] font-mono text-outline">/ {server.ramMaxGb} GB</span>
          </span>

          <span className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-surface-container border border-white/5">
            <span className="material-symbols-outlined text-[15px] text-outline">speed</span>
            <span className="text-[11px] font-mono text-white">{cpuPct}%</span>
            <span className="text-[10px] font-mono text-outline">CPU</span>
          </span>

          {lan && lan.address !== 'localhost' && (
            <span className="text-[10px] font-mono text-outline" title={`Adapter: ${lan.name}`}>
              local: {localAddress}
            </span>
          )}
        </div>

        <div className="flex items-center gap-2">
          {powerButton(
            'start',
            'Start',
            'play_arrow',
            'bg-secondary/20 hover:bg-secondary/30 text-secondary border-secondary/35',
            canStart,
            running ? 'Server is already running' : 'Start the server process'
          )}
          {powerButton(
            'stop',
            'Stop',
            'stop',
            'bg-white/10 hover:bg-white/15 text-white border-white/15',
            canStop,
            canStop ? 'Graceful shutdown (sends stop to the console)' : 'Server is not running'
          )}
          {powerButton(
            'kill',
            'Kill',
            'bolt',
            'bg-error/15 hover:bg-error/25 text-error border-error/30',
            canKill,
            canKill ? 'Force-kill the process (no world save)' : 'Server is not running'
          )}
          {powerButton(
            'restart',
            'Restart',
            'restart_alt',
            'bg-amber-400/15 hover:bg-amber-400/25 text-amber-300 border-amber-400/30',
            running,
            running ? 'Restart the server' : 'Start the server to restart it'
          )}
          {busy && (
            <span className="text-[10.5px] font-mono text-amber-300 flex items-center gap-1.5">
              <span className="material-symbols-outlined text-[14px] animate-spin">refresh</span>
              {busy}…
            </span>
          )}
        </div>
      </div>
    </header>
  );
};
