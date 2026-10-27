import React, { useEffect, useRef } from 'react';
import { ServerInstance } from '../../types';
import { ToastFn, cardClass, cardTitleClass } from './types';

/**
 * Console tab: live status (state, uptime, CPU, RAM, storage), load meters
 * (CPU / memory / network), the live console with quick commands, and the
 * server engine + jar repair card. All data arrives already polled by the
 * parent panel.
 */

export interface SimpleConsoleLine {
  level?: string;
  text?: string;
  time?: string;
  thread?: string;
}

export interface SimpleLiveSnapshot {
  stateLabel: string;
  stateKey: string;
  dotClass: string;
  textClass: string;
  pid: number | null;
  uptime: string;
  cpuPct: number;
  ramUsedMb: number;
  storageMb: number;
  netRxKbps: number;
  netTxKbps: number;
  crashed: boolean;
  lastExitReason: string | null;
}

export const QUICK_COMMANDS: Array<{ label: string; command: string }> = [
  { label: 'list', command: 'list' },
  { label: 'tps', command: 'tps' },
  { label: 'save-all', command: 'save-all flush' },
  { label: 'plugins', command: 'plugins' },
  { label: 'weather clear', command: 'weather clear' },
];

interface LoadMeterProps {
  icon: string;
  label: string;
  pct: number;
  detail: string;
  barClass: string;
}

const LoadMeter: React.FC<LoadMeterProps> = ({ icon, label, pct, detail, barClass }) => (
  <div className="rounded-xl bg-surface-lowest border border-white/10 p-3 space-y-1.5">
    <div className="flex items-center justify-between">
      <span className="text-[11px] font-bold text-outline flex items-center gap-1.5">
        <span className="material-symbols-outlined text-[14px] text-primary">{icon}</span>
        {label}
      </span>
      <span className="text-[11px] font-mono text-white">{detail}</span>
    </div>
    <div className="h-1.5 rounded-full bg-white/10 overflow-hidden">
      <div
        className={`h-full transition-all duration-500 ${barClass}`}
        style={{ width: `${Math.min(100, Math.max(0, Math.round(pct)))}%` }}
      />
    </div>
  </div>
);

interface SimpleConsoleSectionProps {
  server: ServerInstance;
  live: SimpleLiveSnapshot;
  consoleLines: SimpleConsoleLine[];
  command: string;
  onCommandChange: (value: string) => void;
  onSendCommand: (raw?: string) => void;
  onSendQuickCommand: (command: string) => void;
  isRunning: boolean;
  onInstallJar: () => void;
  installingJar: boolean;
  /** Live progress for the jar install job, rendered under the button. */
  jobProgress?: React.ReactNode;
  engine: string;
  version: string;
  onShowToast: ToastFn;
}

export const SimpleConsoleSection: React.FC<SimpleConsoleSectionProps> = ({
  server,
  live,
  consoleLines,
  command,
  onCommandChange,
  onSendCommand,
  onSendQuickCommand,
  isRunning,
  onInstallJar,
  installingJar,
  jobProgress,
  engine,
  version,
}) => {
  const consoleRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const el = consoleRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [consoleLines]);

  const ramMaxMb = Math.round(server.ramMaxGb * 1024);
  const ramPct = ramMaxMb > 0 ? Math.min(100, (live.ramUsedMb / ramMaxMb) * 100) : 0;
  // Network meter scale: 0–10 Mbps (10,000 kbps) full-scale.
  const netTotalKbps = live.netRxKbps + live.netTxKbps;
  const netPct = Math.min(100, (netTotalKbps / 10_000) * 100);

  return (
    <div className="h-full grid grid-rows-[auto_1fr] gap-4 min-h-0">
      {/* Status + load meters */}
      <div className="space-y-3">
        <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-5 gap-3">
          <div className="rounded-xl bg-surface-container border border-white/10 px-3.5 py-3">
            <p className="text-[10px] font-bold text-outline uppercase tracking-wider">Status</p>
            <p className="text-sm font-bold flex items-center gap-2 mt-1">
              <span className={`w-2.5 h-2.5 rounded-full ${live.dotClass}`} />
              <span className={live.textClass}>{live.stateLabel}</span>
            </p>
            <p className="text-[10px] font-mono text-outline mt-0.5">
              {live.pid ? `PID ${live.pid}` : 'no process'}
            </p>
          </div>
          <div className="rounded-xl bg-surface-container border border-white/10 px-3.5 py-3">
            <p className="text-[10px] font-bold text-outline uppercase tracking-wider">Uptime</p>
            <p className="text-sm font-bold text-white font-mono mt-1">{live.uptime}</p>
          </div>
          <div className="rounded-xl bg-surface-container border border-white/10 px-3.5 py-3">
            <p className="text-[10px] font-bold text-outline uppercase tracking-wider">CPU</p>
            <p className="text-sm font-bold text-white font-mono mt-1">{live.cpuPct}%</p>
          </div>
          <div className="rounded-xl bg-surface-container border border-white/10 px-3.5 py-3">
            <p className="text-[10px] font-bold text-outline uppercase tracking-wider">RAM</p>
            <p className="text-sm font-bold text-white font-mono mt-1">
              {(live.ramUsedMb / 1024).toFixed(1)} / {server.ramMaxGb} GB
            </p>
          </div>
          <div className="rounded-xl bg-surface-container border border-white/10 px-3.5 py-3">
            <p className="text-[10px] font-bold text-outline uppercase tracking-wider">Storage</p>
            <p className="text-sm font-bold text-white font-mono mt-1">{live.storageMb} MB</p>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          <LoadMeter
            icon="speed"
            label="CPU LOAD"
            pct={live.cpuPct}
            detail={`${live.cpuPct}% of one core`}
            barClass="bg-primary"
          />
          <LoadMeter
            icon="memory"
            label="MEMORY LOAD"
            pct={ramPct}
            detail={`${Math.round(ramPct)}% of ${server.ramMaxGb} GB`}
            barClass="bg-secondary"
          />
          <LoadMeter
            icon="lan"
            label="NETWORK LOAD"
            pct={netPct}
            detail={`↓ ${live.netRxKbps} · ↑ ${live.netTxKbps} kbps`}
            barClass="bg-amber-400"
          />
        </div>
      </div>

      {/* Console + details */}
      <div className="grid grid-cols-1 xl:grid-cols-[1fr_340px] gap-4 min-h-0">
        <section className="min-h-0 flex flex-col rounded-2xl bg-surface-container border border-white/10 overflow-hidden">
          <div className="px-4 py-3 border-b border-white/10 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span className="material-symbols-outlined text-[18px] text-primary">terminal</span>
              <h2 className="text-sm font-bold text-white">Live Console</h2>
            </div>
            <span className="text-[11px] font-mono text-outline">
              {consoleLines.length} lines · auto-refresh 2.5s
            </span>
          </div>

          <div
            ref={consoleRef}
            className="flex-1 min-h-0 overflow-y-auto px-4 py-3 font-mono text-[11.5px] leading-relaxed bg-surface-lowest"
          >
            {consoleLines.length === 0 ? (
              <p className="text-outline">
                No console output yet. Press <span className="text-white">Start</span> to boot{' '}
                {server.name} — the JVM output appears here.
              </p>
            ) : (
              consoleLines.map((line, index) => (
                <div
                  key={`${index}-${line.text?.slice(0, 8) ?? ''}`}
                  className={
                    /ERROR|Exception|Caused by/.test(line.text || '')
                      ? 'text-error'
                      : /WARN/.test(line.text || '')
                        ? 'text-amber-300'
                        : 'text-on-surface-variant'
                  }
                >
                  {line.text}
                </div>
              ))
            )}
          </div>

          <div className="px-4 py-3 border-t border-white/10 space-y-2">
            <div className="flex flex-wrap items-center gap-1.5">
              {QUICK_COMMANDS.map((qc) => (
                <button
                  key={qc.command}
                  type="button"
                  disabled={!isRunning}
                  onClick={() => onSendQuickCommand(qc.command)}
                  className="px-2.5 py-1 rounded-lg bg-white/5 hover:bg-white/10 disabled:opacity-40 border border-white/10 text-[11px] font-mono text-outline hover:text-white cursor-pointer"
                >
                  {qc.label}
                </button>
              ))}
            </div>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                onSendCommand();
              }}
              className="flex items-center gap-2"
            >
              <input
                type="text"
                value={command}
                onChange={(e) => onCommandChange(e.target.value)}
                disabled={!isRunning}
                placeholder={
                  isRunning ? 'Type a server command and press Enter…' : 'Start the server to send commands'
                }
                className="flex-1 bg-surface-lowest border border-white/15 focus:border-primary disabled:opacity-50 rounded-xl px-3.5 py-2.5 text-xs font-mono text-white focus:outline-none"
              />
              <button
                type="submit"
                disabled={!isRunning || !command.trim()}
                className="px-4 py-2.5 rounded-xl bg-primary hover:opacity-95 disabled:opacity-40 text-on-primary-container text-xs font-bold cursor-pointer"
              >
                Send
              </button>
            </form>
          </div>
        </section>

        <aside className="min-h-0 overflow-y-auto space-y-4">
          <div className={cardClass}>
            <h2 className={`${cardTitleClass} mb-3`}>
              <span className="material-symbols-outlined text-[18px] text-primary">insights</span>
              Live Status
            </h2>
            <dl className="space-y-2 text-xs">
              <div className="flex items-center justify-between">
                <dt className="text-outline">State</dt>
                <dd className={`font-mono ${live.textClass}`}>{live.stateLabel}</dd>
              </div>
              <div className="flex items-center justify-between">
                <dt className="text-outline">Uptime</dt>
                <dd className="font-mono text-white">{live.uptime}</dd>
              </div>
              <div className="flex items-center justify-between">
                <dt className="text-outline">Address</dt>
                <dd className="font-mono text-white">localhost:{server.port}</dd>
              </div>
              <div className="flex items-center justify-between">
                <dt className="text-outline">Disk usage</dt>
                <dd className="font-mono text-white">{live.storageMb} MB</dd>
              </div>
            </dl>
            {live.crashed && live.lastExitReason && (
              <p className="mt-3 text-[11px] text-error border border-error/30 rounded-xl p-2.5">
                Last exit: {live.lastExitReason}
              </p>
            )}
          </div>

          <div className={cardClass}>
            <h2 className={`${cardTitleClass} mb-3`}>
              <span className="material-symbols-outlined text-[18px] text-primary">deployed_code</span>
              Server Engine
            </h2>
            <dl className="space-y-2 text-xs mb-3">
              <div className="flex items-center justify-between">
                <dt className="text-outline">Engine</dt>
                <dd className="font-mono text-white">{engine}</dd>
              </div>
              <div className="flex items-center justify-between">
                <dt className="text-outline">Version</dt>
                <dd className="font-mono text-white">{version || '—'}</dd>
              </div>
              <div className="flex items-center justify-between">
                <dt className="text-outline">Folder</dt>
                <dd className="font-mono text-white truncate max-w-[170px]" title={server.path}>
                  {server.path}
                </dd>
              </div>
            </dl>
            <button
              type="button"
              onClick={onInstallJar}
              disabled={installingJar || !version}
              className="w-full px-3.5 py-2.5 rounded-xl bg-white/5 hover:bg-white/10 disabled:opacity-40 border border-white/15 text-xs font-semibold text-white flex items-center justify-center gap-1.5 cursor-pointer"
            >
              <span className="material-symbols-outlined text-[16px] text-primary">download</span>
              {installingJar ? 'Installing server.jar…' : 'Reinstall / repair server.jar'}
            </button>
            {jobProgress && <div className="mt-2">{jobProgress}</div>}
            <p className="mt-2 text-[11px] text-outline leading-relaxed">
              Downloads the official {engine} {version || ''} build and writes it as{' '}
              <span className="font-mono text-white">server.jar</span>. A missing jar is also
              repaired automatically on the next start.
            </p>
          </div>
        </aside>
      </div>
    </div>
  );
};
