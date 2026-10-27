import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { ServerInstance } from '../types';
import { SIMPLE_SECTIONS, SimpleSectionKey, ToastFn } from './simple/types';
import { SimpleConsoleSection, SimpleLiveSnapshot } from './simple/SimpleConsoleSection';
import { SimpleFilesSection } from './simple/SimpleFilesSection';
import { SimpleDatabaseSection } from './simple/SimpleDatabaseSection';
import { SimpleSchedulesSection } from './simple/SimpleSchedulesSection';
import { SimpleBackupsSection } from './simple/SimpleBackupsSection';
import { SimpleNetworkSection } from './simple/SimpleNetworkSection';
import { SimpleStartupSection } from './simple/SimpleStartupSection';
import { SimpleSettingsSection } from './simple/SimpleSettingsSection';
import { SimpleLogsSection } from './simple/SimpleLogsSection';
import { SimpleServerHeader } from './simple/SimpleServerHeader';
import { JobProgressBar } from './JobProgressBar';
import { cancelJob, submitJob, type OperationJob } from '../lib/jobs';

/**
 * Simple per-server panel page.
 *
 * One compact page with a left sidebar for Console / Files / Database /
 * Schedules / Backups / Network / Startup / Settings / Logs. Everything talks to
 * the real local runtime (`/api/server-runtime/*`, `/api/database/*`,
 * `/api/network/*`) — no demo data. The advanced panel stays available from the
 * header for power users.
 */

export type SimpleServerState = 'running' | 'starting' | 'stopping' | 'stopped' | 'crashed';

interface RuntimeConsoleLine {
  level?: string;
  text?: string;
  time?: string;
  thread?: string;
}

interface LiveStatePayload {
  ok?: boolean;
  state?: string;
  status?: string;
  pid?: number | null;
  crashed?: boolean;
  lastExitReason?: string | null;
  uptimeFormatted?: string;
  cpuUsagePct?: number;
  ramUsedMb?: number;
  storageUsedMb?: number;
  networkRxKbps?: number;
  networkTxKbps?: number;
  consoleLogs?: RuntimeConsoleLine[];
}

interface ContainerPhaseState {
  phase: string;
  engine: string;
  version: string;
  mainFile: string;
  hasJar: boolean;
  eulaAccepted: boolean;
  blockers: string[];
  port: number | null;
}

interface SimpleServerPanelProps {
  server: ServerInstance;
  /** Mirrors the backend entitlement; advanced sections stay locked without it. */
  advancedAllowed?: boolean;
  onRequestAdvancedAccess?: () => void;
  onBackToServerList: () => void;
  onOpenAdvancedPanel: () => void;
  onServerUpdated?: (patch: Partial<ServerInstance>) => void;
  onShowToast: (
    title: string,
    body?: string,
    type?: 'success' | 'info' | 'warning' | 'error',
    icon?: string,
  ) => void;
}

const statusStyles: Record<SimpleServerState, { dot: string; text: string; label: string }> = {
  running: { dot: 'bg-secondary animate-pulse', text: 'text-secondary', label: 'RUNNING' },
  starting: { dot: 'bg-amber-400 animate-pulse', text: 'text-amber-300', label: 'STARTING' },
  stopping: { dot: 'bg-amber-400 animate-pulse', text: 'text-amber-300', label: 'STOPPING' },
  stopped: { dot: 'bg-error', text: 'text-outline', label: 'STOPPED' },
  crashed: { dot: 'bg-error animate-pulse', text: 'text-error', label: 'CRASHED' },
};

const parseEngineVersion = (engineLabel: string): { engine: string; version: string } => {
  const parts = String(engineLabel || '')
    .trim()
    .split(/\s+/);
  const engine = parts.find((p) => /^[a-zA-Z]+$/.test(p)) || parts[0] || 'PaperMC';
  const version = parts.find((p) => /^\d+\.\d+/.test(p)) || '';
  return { engine, version };
};

export const SimpleServerPanel: React.FC<SimpleServerPanelProps> = ({
  server,
  advancedAllowed = false,
  onRequestAdvancedAccess,
  onBackToServerList,
  onOpenAdvancedPanel,
  onServerUpdated,
  onShowToast,
}) => {
  const [section, setSection] = useState<SimpleSectionKey>('console');
  const [state, setState] = useState<SimpleServerState>('stopped');
  const [pid, setPid] = useState<number | null>(null);
  const [uptime, setUptime] = useState('Offline (0h 00m 00s)');
  const [cpuPct, setCpuPct] = useState(0);
  const [ramUsedMb, setRamUsedMb] = useState(0);
  const [storageMb, setStorageMb] = useState(0);
  const [netRx, setNetRx] = useState(0);
  const [netTx, setNetTx] = useState(0);
  const [consoleLines, setConsoleLines] = useState<RuntimeConsoleLine[]>([]);
  const [command, setCommand] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [installingJar, setInstallingJar] = useState(false);
  const [jarJob, setJarJob] = useState<OperationJob | null>(null);
  const [lastError, setLastError] = useState<string | null>(null);
  const [container, setContainer] = useState<ContainerPhaseState | null>(null);
  const { engine, version } = parseEngineVersion(server.engine);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch(
        `/api/server-runtime/live-state?serverId=${encodeURIComponent(
          server.id,
        )}&serverName=${encodeURIComponent(server.name)}&port=${server.port}&ramMaxGb=${server.ramMaxGb}`,
      );
      const data = (await res.json()) as LiveStatePayload;
      if (!data?.ok) return;
      const rawState = String(data.state || 'stopped');
      const next: SimpleServerState =
        rawState === 'online'
          ? 'running'
          : rawState === 'starting'
            ? 'starting'
            : rawState === 'stopping'
              ? 'stopping'
              : rawState === 'crashed'
                ? 'crashed'
                : 'stopped';
      setState(next);
      setPid(typeof data.pid === 'number' ? data.pid : null);
      setUptime(data.uptimeFormatted || 'Offline (0h 00m 00s)');
      setCpuPct(Number(data.cpuUsagePct) || 0);
      setRamUsedMb(Number(data.ramUsedMb) || 0);
      setStorageMb(Number(data.storageUsedMb) || 0);
      setNetRx(Number(data.networkRxKbps) || 0);
      setNetTx(Number(data.networkTxKbps) || 0);
      setConsoleLines(data.consoleLogs || []);
      if (data.crashed && data.lastExitReason) setLastError(String(data.lastExitReason));
      onServerUpdated?.({
        status:
          next === 'starting' || next === 'stopping'
            ? 'restarting'
            : next === 'running'
              ? 'running'
              : 'stopped',
        pid: typeof data.pid === 'number' ? data.pid : 0,
        uptime: data.uptimeFormatted || server.uptime,
        cpuUsage: Number(data.cpuUsagePct) || 0,
        ramUsedGb: Math.round((Number(data.ramUsedMb) || 0) / 102.4) / 10,
      });
    } catch {
      // backend restarting / transient — keep the last known state
    }
  }, [server.id, server.name, server.port, server.ramMaxGb, server.uptime, onServerUpdated]);

  const refreshContainer = useCallback(async () => {
    try {
      const res = await fetch(
        `/api/server-runtime/container-state?serverId=${encodeURIComponent(
          server.id,
        )}&serverName=${encodeURIComponent(server.name)}`,
      );
      const data = await res.json();
      if (data?.ok) {
        setContainer({
          phase: String(data.phase || 'installing'),
          engine: String(data.engine || ''),
          version: String(data.version || ''),
          mainFile: String(data.mainFile || 'server.jar'),
          hasJar: Boolean(data.hasJar),
          eulaAccepted: Boolean(data.eulaAccepted),
          blockers: Array.isArray(data.blockers) ? data.blockers : [],
          port: typeof data.port === 'number' ? data.port : null,
        });
      }
    } catch {
      // backend restarting
    }
  }, [server.id, server.name]);

  useEffect(() => {
    void refresh();
    void refreshContainer();
    const interval = setInterval(() => void refresh(), 2500);
    const containerInterval = setInterval(() => void refreshContainer(), 10_000);
    return () => {
      clearInterval(interval);
      clearInterval(containerInterval);
    };
  }, [refresh, refreshContainer]);

  const power = async (action: 'start' | 'restart' | 'stop' | 'kill') => {
    setBusy(action);
    setLastError(null);
    try {
      const res = await fetch('/api/server-runtime/power', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          serverId: server.id,
          serverName: server.name,
          engine: server.engine,
          port: server.port,
          ramMaxGb: server.ramMaxGb,
          action,
        }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.ok) {
        const message = data?.error || `Backend refused “${action}”`;
        setLastError(message);
        onShowToast('Action Failed', message, 'error', 'error');
        return;
      }
      onShowToast(
        action === 'start' ? `Starting ${server.name}` : `${server.name}: ${action} requested`,
        action === 'start'
          ? 'Spawning the server JVM — the live console will show the boot sequence.'
          : 'Waiting for the process to reach a terminal state.',
        'info',
        action === 'start' ? 'play_arrow' : 'sync',
      );
      void refresh();
      void refreshContainer();
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Could not reach the local backend';
      setLastError(message);
      onShowToast('Action Failed', message, 'error', 'error');
    } finally {
      setBusy(null);
    }
  };

  const sendCommand = async (raw?: string) => {
    const payload = (raw ?? command).trim();
    if (!payload) return;
    try {
      const res = await fetch('/api/server-runtime/command', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ serverId: server.id, serverName: server.name, command: payload }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.ok) {
        onShowToast(
          'Command Rejected',
          data?.error || 'Server is not accepting commands.',
          'warning',
          'terminal',
        );
        return;
      }
      setCommand('');
      void refresh();
    } catch {
      onShowToast('Command Failed', 'Could not reach the local backend.', 'error', 'error');
    }
  };

  const installJar = async () => {
    setInstallingJar(true);
    setJarJob(null);
    try {
      const outcome = await submitJob<Record<string, any>>(
        '/api/server-runtime/install-jar',
        { serverId: server.id, serverName: server.name, engine: server.engine, version },
        { onProgress: setJarJob },
      );
      const data = (outcome.result || {}) as Record<string, any>;
      if (!outcome.ok) {
        onShowToast(
          'server.jar Install Failed',
          outcome.error || 'Unknown error',
          'error',
          'download',
        );
        return;
      }
      onShowToast(
        'server.jar Installed',
        `${data.filename || 'server.jar'} (${Math.round((Number(data.bytes) || 0) / 1024 / 1024)} MB).`,
        'success',
        'download_done',
      );
      void refresh();
      void refreshContainer();
    } catch (err) {
      onShowToast(
        'server.jar Install Failed',
        err instanceof Error ? err.message : 'Could not reach the local backend.',
        'error',
        'error',
      );
    } finally {
      setInstallingJar(false);
    }
  };

  const style = statusStyles[state] || statusStyles.stopped;
  const isRunning = state === 'running' || state === 'starting';
  const phase = container?.phase || 'installing';

  const live: SimpleLiveSnapshot = useMemo(
    () => ({
      stateLabel: style.label,
      stateKey: state,
      dotClass: style.dot,
      textClass: style.text,
      pid,
      uptime,
      cpuPct,
      ramUsedMb,
      storageMb,
      netRxKbps: netRx,
      netTxKbps: netTx,
      crashed: state === 'crashed',
      lastExitReason: lastError,
    }),
    [style, state, pid, uptime, cpuPct, ramUsedMb, storageMb, netRx, netTx, lastError],
  );

  const activeSection = SIMPLE_SECTIONS.find((s) => s.key === section) || SIMPLE_SECTIONS[0];

  const renderSection = () => {
    const common = { server, onShowToast: onShowToast as ToastFn };
    // Schedules and the advanced startup editor are Advanced-Panel features; the
    // matching API routes reject this account on the backend as well.
    if (!advancedAllowed && (section === 'schedules' || section === 'startup')) {
      return (
        <AdvancedSectionLock
          section={section}
          onRequestAdvancedAccess={onRequestAdvancedAccess || onOpenAdvancedPanel}
        />
      );
    }
    switch (section) {
      case 'console':
        return (
          <SimpleConsoleSection
            server={server}
            live={live}
            consoleLines={consoleLines}
            command={command}
            onCommandChange={setCommand}
            onSendCommand={() => void sendCommand()}
            onSendQuickCommand={(cmd) => void sendCommand(cmd)}
            isRunning={isRunning}
            jobProgress={
              jarJob ? (
                <JobProgressBar
                  job={jarJob}
                  onCancel={() => {
                    void cancelJob(jarJob.id);
                  }}
                />
              ) : null
            }
            onInstallJar={() => void installJar()}
            installingJar={installingJar}
            engine={engine}
            version={version}
            onShowToast={common.onShowToast}
          />
        );
      case 'files':
        return <SimpleFilesSection {...common} onChanged={() => void refreshContainer()} />;
      case 'database':
        return <SimpleDatabaseSection {...common} />;
      case 'schedules':
        return <SimpleSchedulesSection {...common} />;
      case 'backups':
        return <SimpleBackupsSection {...common} />;
      case 'network':
        return <SimpleNetworkSection {...common} />;
      case 'startup':
        return (
          <SimpleStartupSection
            {...common}
            containerVersion={container?.version || version}
            containerEngine={container?.engine || engine}
          />
        );
      case 'settings':
        return (
          <SimpleSettingsSection
            {...common}
            onServerUpdated={(patch) => {
              onServerUpdated?.(patch as Partial<ServerInstance>);
              void refreshContainer();
            }}
          />
        );
      case 'logs':
        return <SimpleLogsSection {...common} />;
      default:
        return null;
    }
  };

  return (
    <div className="flex-1 flex flex-col min-h-0 bg-surface-dim">
      <SimpleServerHeader
        server={server}
        state={state}
        pid={pid}
        uptime={uptime}
        cpuPct={cpuPct}
        ramUsedMb={ramUsedMb}
        phase={phase}
        engine={engine}
        version={version}
        mainFile={container?.mainFile || 'server.jar'}
        hasJar={Boolean(container?.hasJar)}
        blockers={container?.blockers || []}
        busy={busy}
        onBack={onBackToServerList}
        onOpenAdvanced={onOpenAdvancedPanel}
        onPower={(action) => void power(action)}
        onShowToast={onShowToast as ToastFn}
      />

      <div className="flex-1 min-h-0 flex">
        {/* Section sidebar */}
        <nav className="shrink-0 w-48 border-r border-white/[0.08] bg-surface py-3 px-2 overflow-y-auto">
          <p className="px-2 text-[10px] font-bold text-outline uppercase tracking-wider mb-2">
            Server
          </p>
          <ul className="space-y-0.5">
            {SIMPLE_SECTIONS.map((item) => {
              const active = item.key === section;
              return (
                <li key={item.key}>
                  <button
                    type="button"
                    onClick={() => setSection(item.key)}
                    className={`w-full text-left px-2.5 py-2 rounded-xl text-xs font-semibold flex items-center gap-2.5 cursor-pointer transition-colors ${
                      active
                        ? 'bg-primary/15 text-white border border-primary/30'
                        : 'text-outline hover:text-white hover:bg-white/5 border border-transparent'
                    }`}
                  >
                    <span
                      className={`material-symbols-outlined text-[17px] ${active ? 'text-primary' : ''}`}
                    >
                      {item.icon}
                    </span>
                    {item.label}
                    {!advancedAllowed && (item.key === 'schedules' || item.key === 'startup') && (
                      <span
                        className="material-symbols-outlined text-[13px] text-amber-300 ml-auto"
                        title="Requires Discord verification"
                      >
                        lock
                      </span>
                    )}
                  </button>
                </li>
              );
            })}
          </ul>

          <div className="mt-3 px-2 pt-3 border-t border-white/[0.08] space-y-1 text-[10.5px]">
            <p className="text-outline flex items-center justify-between">
              <span>Port</span>
              <span className="font-mono text-white">{server.port || '—'}</span>
            </p>
            <p className="text-outline flex items-center justify-between">
              <span>RAM</span>
              <span className="font-mono text-white">{server.ramMaxGb} GB</span>
            </p>
            <p className="text-outline flex items-center justify-between">
              <span>Jar</span>
              <span
                className={
                  container?.hasJar ? 'text-secondary font-mono' : 'text-amber-300 font-mono'
                }
              >
                {container?.hasJar ? 'installed' : 'missing'}
              </span>
            </p>
          </div>
        </nav>

        <main className="flex-1 min-h-0 overflow-y-auto p-5">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-sm font-bold text-white flex items-center gap-2">
              <span className="material-symbols-outlined text-[18px] text-primary">
                {activeSection.icon}
              </span>
              {activeSection.label}
            </h2>
            {lastError && section !== 'console' && (
              <span className="text-[11px] text-error truncate max-w-md">{lastError}</span>
            )}
          </div>
          <div
            className={
              section === 'console' || section === 'files'
                ? 'h-[calc(100%-2.25rem)] min-h-[440px]'
                : ''
            }
          >
            {renderSection()}
          </div>
        </main>
      </div>
    </div>
  );
};

const AdvancedSectionLock: React.FC<{
  section: 'schedules' | 'startup';
  onRequestAdvancedAccess: () => void;
}> = ({ section, onRequestAdvancedAccess }) => (
  <div className="max-w-xl rounded-2xl border border-white/[0.08] bg-surface-container p-6 space-y-4">
    <div className="flex items-start gap-3">
      <div className="size-10 rounded-xl bg-amber-400/15 border border-amber-400/30 flex items-center justify-center text-amber-300 shrink-0">
        <span className="material-symbols-outlined text-[20px]">lock</span>
      </div>
      <div>
        <h3 className="text-sm font-bold text-white">
          {section === 'schedules' ? 'Schedules' : 'Advanced Startup'} needs the Advanced Panel
        </h3>
        <p className="text-xs text-outline mt-1 leading-relaxed">
          This tool is limited to verified members of the IS King Discord server. Link your Discord
          account, join the server, and complete the verification step to unlock it. The backend
          rejects these requests until the verification role is confirmed.
        </p>
      </div>
    </div>
    <button
      type="button"
      onClick={onRequestAdvancedAccess}
      className="px-4 py-2.5 rounded-xl bg-[#5865F2] hover:bg-[#4752C4] text-white text-xs font-bold flex items-center gap-2 cursor-pointer"
    >
      <span className="material-symbols-outlined text-[17px]">verified_user</span>
      Unlock with Discord verification
    </button>
  </div>
);
