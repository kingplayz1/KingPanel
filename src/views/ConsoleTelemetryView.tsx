import React, { useState, useRef, useEffect } from 'react';
import { ServerInstance, ConsoleLogLine, ConnectedPlayer, NavSection } from '../types';

interface ConsoleTelemetryViewProps {
  server: ServerInstance;
  logs: ConsoleLogLine[];
  players: ConnectedPlayer[];
  onAddLog: (line: Omit<ConsoleLogLine, 'id' | 'time'>) => void;
  onClearLogs: () => void;
  onServerAction: (action: 'restart' | 'stop' | 'kill' | 'start') => void;
  onQuickSnapshot: () => void;
  onNavigate: (section: NavSection) => void;
  onShowToast: (
    title: string,
    body?: string,
    type?: 'success' | 'info' | 'warning' | 'error',
    icon?: string,
  ) => void;
  onKickPlayer: (id: string) => void;
}

export const ConsoleTelemetryView: React.FC<ConsoleTelemetryViewProps> = ({
  server,
  logs,
  players,
  onAddLog,
  onClearLogs,
  onServerAction,
  onQuickSnapshot,
  onNavigate,
  onShowToast,
  onKickPlayer,
}) => {
  const [cmdInput, setCmdInput] = useState('');
  const [autoScroll, setAutoScroll] = useState(true);
  const [broadcastOpen, setBroadcastOpen] = useState(false);
  const [broadcastText, setBroadcastText] = useState('');
  const [copiedIp, setCopiedIp] = useState(false);
  const [cpuHistory, setCpuHistory] = useState<number[]>([]);
  const [netStats, setNetStats] = useState<{ rx: number; tx: number }>({ rx: 0, tx: 0 });
  const [livePid, setLivePid] = useState<number | null>(null);
  const seenConsoleIds = useRef<Set<string>>(new Set());
  const terminalRef = useRef<HTMLDivElement>(null);
  const hardwareThreads = typeof navigator !== 'undefined' ? navigator.hardwareConcurrency || 0 : 0;

  const isRunning = server.status === 'running';
  const activeLogs = isRunning ? logs : [];
  const activePlayers = isRunning ? players : [];
  const ramUsedMb = isRunning ? Math.round(server.ramUsedGb * 1024) : 0;
  const ramMaxMb = Math.round(server.ramMaxGb * 1024);
  const ramPct =
    isRunning && ramMaxMb > 0 ? Math.min(100, Math.round((ramUsedMb / ramMaxMb) * 100)) : 0;

  useEffect(() => {
    if (autoScroll && terminalRef.current) {
      terminalRef.current.scrollTop = terminalRef.current.scrollHeight;
    }
  }, [activeLogs, autoScroll]);

  // Live stdout pipe: poll the real supervisor while the server runs. Every line
  // rendered in this terminal comes from the actual JVM process on disk.
  useEffect(() => {
    if (!isRunning) {
      setCpuHistory([]);
      setNetStats({ rx: 0, tx: 0 });
      return;
    }
    let cancelled = false;
    const poll = async () => {
      try {
        const res = await fetch(
          `/api/server-runtime/live-state?serverId=${encodeURIComponent(server.id)}&serverName=${encodeURIComponent(
            server.name,
          )}`,
        );
        const data = await res.json().catch(() => null);
        if (cancelled || !res.ok || !data?.ok) return;
        const lines: ConsoleLogLine[] = Array.isArray(data.consoleLogs) ? data.consoleLogs : [];
        for (const line of lines) {
          if (!seenConsoleIds.current.has(line.id)) {
            seenConsoleIds.current.add(line.id);
            onAddLog({ level: line.level, text: line.text, highlightBox: line.highlightBox });
          }
        }
        if (seenConsoleIds.current.size > 4000) {
          seenConsoleIds.current = new Set(lines.map((line) => line.id));
        }
        const history = Array.isArray(data.history) ? data.history : [];
        setCpuHistory(history.map((h: { cpu: number }) => Number(h.cpu) || 0));
        setNetStats({ rx: Number(data.networkRxKbps) || 0, tx: Number(data.networkTxKbps) || 0 });
        setLivePid(data.pid ?? null);
      } catch {
        // Backend unreachable — keep the last real values on screen.
      }
    };
    void poll();
    const timer = setInterval(() => void poll(), 2500);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [isRunning, server.id, server.name, onAddLog]);

  const handleCopyIp = () => {
    const ipStr = `127.0.0.1:${server.port}`;
    navigator.clipboard?.writeText(ipStr).catch(() => {});
    setCopiedIp(true);
    onShowToast('Server Socket Copied', `${ipStr} copied to clipboard.`, 'success', 'content_copy');
    setTimeout(() => setCopiedIp(false), 1800);
  };

  const handleSendCommand = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = cmdInput.trim();
    if (!trimmed) return;
    if (!isRunning) {
      onShowToast(
        'Server is Stopped',
        'Start the server first before sending console commands.',
        'warning',
        'power_settings_new',
      );
      return;
    }

    onAddLog({
      level: 'EXEC',
      text: `> ${trimmed}`,
    });

    setCmdInput('');

    // Real dispatch: the server's own response lines stream back through the
    // live stdout poll above — nothing is fabricated locally.
    void (async () => {
      try {
        const r = await fetch('/api/server-runtime/command', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ serverId: server.id, serverName: server.name, command: trimmed }),
        });
        const data = await r.json().catch(() => null);
        if (!r.ok || !data?.ok) {
          onShowToast(
            'Command Failed',
            data?.error || 'The console rejected this command.',
            'error',
            'error',
          );
        }
      } catch {
        onShowToast(
          'Backend Unreachable',
          'Could not reach the local panel backend to send the command.',
          'error',
          'error',
        );
      }
    })();
  };

  const handleSendBroadcast = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = broadcastText.trim();
    if (!trimmed) return;
    if (!isRunning) {
      onShowToast(
        'Server is Stopped',
        'Start the server before broadcasting.',
        'warning',
        'campaign',
      );
      return;
    }
    setBroadcastText('');
    setBroadcastOpen(false);
    // Real broadcast: the server itself prints the message to every client.
    void (async () => {
      try {
        const r = await fetch('/api/server-runtime/command', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            serverId: server.id,
            serverName: server.name,
            command: `say ${trimmed}`,
          }),
        });
        const data = await r.json().catch(() => null);
        if (!r.ok || !data?.ok) {
          onShowToast(
            'Broadcast Failed',
            data?.error || 'The console rejected the say command.',
            'error',
            'error',
          );
        } else {
          onShowToast(
            'Broadcast Sent',
            'Delivered through the live console (`say`).',
            'success',
            'campaign',
          );
        }
      } catch {
        onShowToast(
          'Backend Unreachable',
          'Could not reach the local panel backend.',
          'error',
          'error',
        );
      }
    })();
  };

  const handleDownloadLogs = () => {
    const content = logs
      .map((l) => `[${l.time}] [${l.level}] ${l.sender ? `<${l.sender}> ` : ''}${l.text}`)
      .join('\n');
    const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${server.id}-live.log`;
    a.click();
    URL.revokeObjectURL(url);
    onShowToast(
      'Live Log Exported',
      `Saved ${logs.length} lines to ${server.id}-live.log`,
      'success',
      'download',
    );
  };

  // Real CPU history sampled by the supervisor (last 80 samples → 400px chart).
  const cpuPoints = cpuHistory.slice(-80);
  const cpuLinePath =
    cpuPoints.length >= 2
      ? cpuPoints
          .map(
            (v, i) =>
              `${i === 0 ? 'M' : 'L'} ${((i / (cpuPoints.length - 1)) * 400).toFixed(1)},${(
                100 - Math.min(100, Math.max(0, v))
              ).toFixed(1)}`,
          )
          .join(' ')
      : '';
  const cpuFillPath = cpuLinePath ? `${cpuLinePath} L 400,100 L 0,100 Z` : '';

  return (
    <div className="flex flex-col w-full space-y-4">
      {/* ================= 1. TOP SERVER INSTANCE HERO BANNER ================= */}
      <div className="rounded-xl bg-surface border border-white/[0.06] px-4 py-3.5 flex flex-col xl:flex-row xl:items-center justify-between gap-4">
        <div className="flex items-center gap-3 min-w-0">
          {/* Pickaxe Emblem with Online Status Dot */}
          <div className="relative size-10 rounded-lg bg-surface-container border border-white/[0.06] grid place-items-center shrink-0 text-lg">
            <span>⛏️</span>
            <span
              className={`absolute -top-0.5 -right-0.5 size-2.5 rounded-full border-2 border-surface ${
                server.status === 'running'
                  ? 'bg-secondary'
                  : server.status === 'restarting'
                    ? 'bg-primary animate-pulse'
                    : 'bg-error'
              }`}
            />
          </div>

          <div className="min-w-0">
            <div className="flex items-center gap-2 min-w-0">
              <h1 className="text-[17px] font-semibold text-white tracking-tight truncate">
                {server.name}
              </h1>
              <span
                className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md text-[10.5px] font-mono border shrink-0 ${
                  server.status === 'running'
                    ? 'bg-secondary/10 text-secondary border-secondary/30'
                    : server.status === 'restarting'
                      ? 'bg-primary/10 text-primary border-primary/30'
                      : 'bg-white/5 text-on-surface-variant border-white/10'
                }`}
              >
                <span
                  className={`size-1.5 rounded-full ${
                    server.status === 'running'
                      ? 'bg-secondary'
                      : server.status === 'restarting'
                        ? 'bg-primary animate-pulse'
                        : 'bg-white/40'
                  }`}
                />
                {server.status === 'running'
                  ? 'Running'
                  : server.status === 'restarting'
                    ? 'Restarting'
                    : 'Stopped'}{' '}
                · {server.engine}
              </span>
            </div>

            <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 mt-1 text-[11px] font-mono text-outline">
              <span className="kp-chip">{server.build}</span>
              <button
                type="button"
                onClick={handleCopyIp}
                className="inline-flex items-center gap-1 text-primary hover:text-primary-gold transition-colors cursor-pointer"
                title="Copy localhost socket"
              >
                <span>127.0.0.1:{server.port}</span>
                <span className="material-symbols-outlined text-[13px]">
                  {copiedIp ? 'done' : 'content_copy'}
                </span>
              </button>
              <span className="text-white/15">|</span>
              <span>
                PID <span className="text-on-surface">{livePid ?? '—'}</span>
              </span>
              <span className="text-white/15">|</span>
              <span className="truncate max-w-[360px]" title={server.path || server.id}>
                {server.path || server.id}
              </span>
            </div>
          </div>
        </div>

        {/* Right Action Button Cluster — one height, one radius, color = intent */}
        <div className="flex flex-wrap items-center gap-2 shrink-0">
          <button
            type="button"
            onClick={() => onServerAction(server.status === 'stopped' ? 'start' : 'stop')}
            className="inline-flex items-center gap-1.5 h-8 px-3 rounded-lg bg-primary hover:brightness-105 text-on-primary text-[11.5px] font-semibold transition-all cursor-pointer"
          >
            <span className="material-symbols-outlined text-[16px]">
              {server.status === 'stopped' ? 'play_arrow' : 'power_settings_new'}
            </span>
            <span>{server.status === 'stopped' ? 'Start Server' : 'Graceful Stop'}</span>
          </button>

          <button
            type="button"
            onClick={() => onServerAction('restart')}
            className="inline-flex items-center gap-1.5 h-8 px-3 rounded-lg border border-white/10 bg-white/[0.02] hover:bg-white/[0.06] text-on-surface text-[11.5px] font-medium transition-colors cursor-pointer"
          >
            <span className="material-symbols-outlined text-[16px] text-outline">refresh</span>
            <span>Restart</span>
          </button>

          <button
            type="button"
            onClick={onQuickSnapshot}
            className="inline-flex items-center gap-1.5 h-8 px-3 rounded-lg border border-white/10 bg-white/[0.02] hover:bg-white/[0.06] text-on-surface text-[11.5px] font-medium transition-colors cursor-pointer"
          >
            <span className="material-symbols-outlined text-[16px] text-outline">folder_zip</span>
            <span>Snapshot</span>
          </button>

          <button
            type="button"
            onClick={() => {
              onNavigate('network');
              onShowToast(
                'LAN Pinhole BroadcastActive',
                'Opened UPnP & Tunnel Gateway settings.',
                'info',
                'wifi_tethering',
              );
            }}
            className="inline-flex items-center gap-1.5 h-8 px-3 rounded-lg border border-white/10 bg-white/[0.02] hover:bg-white/[0.06] text-on-surface text-[11.5px] font-medium transition-colors cursor-pointer"
          >
            <span className="material-symbols-outlined text-[16px] text-outline">wifi_tethering</span>
            <span>Share LAN</span>
          </button>

          <button
            type="button"
            onClick={() => onServerAction('kill')}
            className="inline-flex items-center gap-1.5 h-8 px-3 rounded-lg border border-error/25 bg-error-container/10 hover:bg-error-container/25 text-error text-[11.5px] font-medium transition-colors cursor-pointer"
            title="Force kill the server process"
          >
            <span className="material-symbols-outlined text-[16px]">dangerous</span>
            <span>Kill</span>
          </button>
        </div>
      </div>

      {/* ================= 2. 5-COLUMN TELEMETRY KPI STRIP ================= */}
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
        {/* Card 1: TPS Health */}
        <div className="rounded-xl bg-surface border border-white/[0.06] p-4 flex flex-col">
          <div className="flex items-center justify-between gap-2">
            <span className="kp-label">TPS health</span>
            <span className="material-symbols-outlined text-[16px] text-outline">equalizer</span>
          </div>
          <div className="mt-2.5 flex items-baseline gap-1.5 min-w-0">
            <span className="kp-stat-value">{server.tps > 0 ? server.tps.toFixed(1) : '—'}</span>
            <span className="text-[11px] font-mono text-outline truncate">
              {server.status === 'stopped' ? 'Halted' : server.tps > 0 ? 'Solid' : 'n/a'}
            </span>
          </div>
          <div className="mt-1 text-[11px] font-mono text-outline truncate">
            {server.tps > 0 ? `Tick ${server.tickMs}ms` : 'No TPS source'}
          </div>
        </div>

        {/* Card 2: Process Uptime */}
        <div className="rounded-xl bg-surface border border-white/[0.06] p-4 flex flex-col">
          <div className="flex items-center justify-between gap-2">
            <span className="kp-label">Process uptime</span>
            <span className="material-symbols-outlined text-[16px] text-outline">
              hourglass_top
            </span>
          </div>
          <div className="mt-2.5 flex items-baseline gap-1.5 min-w-0">
            <span className="kp-stat-value truncate">
              {isRunning ? server.uptime : 'Offline'}
            </span>
          </div>
          <div className="mt-1 text-[11px] font-mono text-outline truncate">
            {isRunning ? 'Live process' : '0h 00m 00s'}
          </div>
        </div>

        {/* Card 3: Online Players */}
        <div className="rounded-xl bg-surface border border-white/[0.06] p-4 flex flex-col">
          <div className="flex items-center justify-between gap-2">
            <span className="kp-label">Online players</span>
            <span className="material-symbols-outlined text-[16px] text-outline">group</span>
          </div>
          <div className="mt-2.5 flex items-baseline gap-1.5 min-w-0">
            <span className="kp-stat-value">{activePlayers.length}</span>
            <span className="text-[11px] font-mono text-outline">/ {server.maxPlayers}</span>
          </div>
          <div className="mt-1 text-[11px] font-mono text-outline truncate">
            {activePlayers.length === 0 ? 'No players connected' : `${activePlayers.length} online`}
          </div>
        </div>

        {/* Card 4: CPU */}
        <div className="rounded-xl bg-surface border border-white/[0.06] p-4 flex flex-col">
          <div className="flex items-center justify-between gap-2">
            <span className="kp-label">CPU usage</span>
            <span className="material-symbols-outlined text-[16px] text-outline">speed</span>
          </div>
          <div className="mt-2.5 flex items-baseline gap-1.5 min-w-0">
            <span className="kp-stat-value">{isRunning ? server.cpuUsage : 0}%</span>
          </div>
          <div className="mt-1 text-[11px] font-mono text-outline truncate">
            {isRunning ? 'Live process sample' : 'Idle'}
          </div>
        </div>

        {/* Card 5: RAM Allocation */}
        <div className="rounded-xl bg-surface border border-white/[0.06] p-4 flex flex-col">
          <div className="flex items-center justify-between gap-2">
            <span className="kp-label">RAM allocation</span>
            <span className="material-symbols-outlined text-[16px] text-outline">memory</span>
          </div>
          <div className="mt-2.5 flex items-baseline gap-1.5 min-w-0">
            <span className="kp-stat-value">{isRunning ? server.ramUsedGb : 0}</span>
            <span className="text-[11px] font-mono text-outline whitespace-nowrap">
              / {server.ramMaxGb.toFixed(1)} GB
            </span>
          </div>
          <div className="mt-1 text-[11px] font-mono text-outline truncate">
            {isRunning ? `${ramUsedMb} MB in use` : 'Reserved, not in use'}
          </div>
        </div>
      </div>

      {/* ================= 3. MAIN WORKSPACE SPLIT (TELEMETRY LEFT / LIVE CONSOLE RIGHT) ================= */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-4 items-start">
        {/* LEFT COLUMN (5 COLS) */}
        <div className="lg:col-span-5 flex flex-col gap-4">
          {/* CARD A: HARDWARE PERFORMANCE */}
          <div className="rounded-xl bg-surface border border-white/[0.06] p-4 space-y-3">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <span className="kp-label block">Hardware performance</span>
                <div className="flex items-baseline gap-1.5 mt-1.5 min-w-0">
                  <span className="kp-stat-value">{server.cpuUsage}%</span>
                  <span className="text-[11px] font-mono text-outline">CPU</span>
                </div>
              </div>
              <div className="text-right shrink-0 space-y-1">
                <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md border border-secondary/25 bg-secondary/10 text-secondary text-[10.5px] font-mono">
                  <span className="size-1.5 rounded-full bg-secondary" />
                  Live 2.5s
                </span>
                <div className="text-[11px] font-mono text-outline">
                  {livePid ? `PID ${livePid}` : 'No process'}
                </div>
              </div>
            </div>

            {/* Smooth Amber Wave SVG Graph */}
            <div className="relative h-28 w-full pt-2">
              <svg
                className="w-full h-full overflow-visible"
                viewBox="0 0 400 100"
                preserveAspectRatio="none"
              >
                <defs>
                  <linearGradient id="cpuAmberFill" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#f59e0b" stopOpacity="0.32" />
                    <stop offset="100%" stopColor="#f59e0b" stopOpacity="0.0" />
                  </linearGradient>
                </defs>
                <line
                  x1="0"
                  y1="25"
                  x2="400"
                  y2="25"
                  stroke="rgba(255,255,255,0.04)"
                  strokeWidth="1"
                />
                <line
                  x1="0"
                  y1="50"
                  x2="400"
                  y2="50"
                  stroke="rgba(255,255,255,0.04)"
                  strokeWidth="1"
                />
                <line
                  x1="0"
                  y1="75"
                  x2="400"
                  y2="75"
                  stroke="rgba(255,255,255,0.04)"
                  strokeWidth="1"
                />
                {cpuFillPath && <path d={cpuFillPath} fill="url(#cpuAmberFill)" />}
                {cpuLinePath && (
                  <path
                    d={cpuLinePath}
                    fill="none"
                    stroke="#f59e0b"
                    strokeWidth="2.5"
                    strokeLinecap="round"
                  />
                )}
              </svg>
              {!cpuLinePath && (
                <div className="absolute inset-0 flex items-center justify-center text-[11px] font-mono text-on-surface-variant">
                  {isRunning ? 'Collecting live CPU samples…' : 'Server offline — no samples'}
                </div>
              )}
            </div>

            <div className="flex items-center justify-between text-[10px] font-mono text-on-surface-variant/60 px-1">
              <span>{cpuPoints.length} real samples</span>
              <span className="text-primary font-bold">Now</span>
            </div>

            <div className="grid grid-cols-2 gap-4 pt-3 border-t border-white/[0.06]">
              <div className="space-y-0.5 min-w-0">
                <span className="kp-label block">Host CPU</span>
                <p className="text-[12.5px] font-mono text-white mt-1">
                  {hardwareThreads ? `${hardwareThreads} threads` : 'n/a'}
                </p>
                <span className="text-[11px] font-mono text-outline block">
                  Load {server.cpuUsage}%
                </span>
              </div>
              <div className="space-y-0.5 min-w-0">
                <span className="kp-label block">Network I/O</span>
                <p className="text-[12.5px] font-mono text-white mt-1">
                  ↓ {netStats.rx} · ↑ {netStats.tx} KB/s
                </p>
                <span className="text-[11px] font-mono text-outline block">Sampled live</span>
              </div>
            </div>
          </div>

          {/* CARD B: JVM HEAP ALLOCATION */}
          <div className="rounded-xl bg-surface border border-white/[0.06] p-4 space-y-3">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <span className="kp-label block">JVM heap</span>
                <div className="flex items-baseline gap-1.5 mt-1.5 min-w-0">
                  <span className="kp-stat-value">{ramUsedMb.toLocaleString()}</span>
                  <span className="text-[11px] font-mono text-outline whitespace-nowrap">
                    / {ramMaxMb.toLocaleString()} MB · {ramPct}%
                  </span>
                </div>
              </div>
              <button
                type="button"
                onClick={() => onNavigate('jvm')}
                className="inline-flex items-center gap-1.5 h-7 px-2.5 rounded-lg border border-white/10 bg-white/[0.02] hover:bg-white/[0.06] text-[11px] font-medium text-on-surface transition-colors cursor-pointer shrink-0"
              >
                Tune flags
              </button>
            </div>

            {/* Real heap usage bar (RSS vs -Xmx) */}
            <div className="w-full h-1.5 bg-surface-lowest rounded-full overflow-hidden">
              <div
                className="bg-primary h-full rounded-full transition-all"
                style={{ width: isRunning ? `${ramPct}%` : '0%' }}
                title={`${ramUsedMb} MB of ${ramMaxMb} MB`}
              />
            </div>

            <div className="flex items-center justify-between gap-3 text-[11px] font-mono text-outline">
              <span className="truncate">No GC telemetry on this build</span>
              <button
                type="button"
                onClick={() => onNavigate('jvm')}
                className="shrink-0 text-primary hover:underline cursor-pointer"
              >
                Edit JVM flags
              </button>
            </div>
          </div>

          {/* CARD C: CONNECTED PLAYERS */}
          <div className="rounded-xl bg-surface-container-low border border-white/[0.06] p-4 space-y-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span className="material-symbols-outlined text-primary text-base">groups</span>
                <span className="text-xs font-bold uppercase tracking-wider font-mono text-white">
                  Connected Players ({activePlayers.length} / {server.maxPlayers})
                </span>
              </div>
              <button
                type="button"
                onClick={() => setBroadcastOpen(!broadcastOpen)}
                className="flex items-center gap-1 text-xs font-mono text-primary hover:text-primary-gold transition-colors cursor-pointer"
              >
                <span className="material-symbols-outlined text-sm">campaign</span>
                <span>Broadcast</span>
              </button>
            </div>

            {broadcastOpen && (
              <form onSubmit={handleSendBroadcast} className="flex items-center gap-2 pt-1">
                <input
                  type="text"
                  value={broadcastText}
                  onChange={(e) => setBroadcastText(e.target.value)}
                  placeholder="Broadcast alert to all players..."
                  className="flex-1 bg-surface-container-lowest border border-primary/30 rounded-lg px-2.5 py-1.5 text-xs font-mono text-white focus:outline-none"
                />
                <button
                  type="submit"
                  className="px-3 py-1.5 rounded-lg bg-primary text-on-primary font-bold text-xs cursor-pointer"
                >
                  Send
                </button>
              </form>
            )}

            <div className="space-y-2">
              {activePlayers.length === 0 ? (
                <div className="p-4 rounded-xl bg-surface-container border border-white/[0.06] text-center text-xs font-mono text-on-surface-variant">
                  No player connected
                </div>
              ) : (
                activePlayers.map((p) => (
                  <div
                    key={p.id}
                    className="p-2.5 rounded-xl bg-surface-container hover:bg-surface-container-high border border-white/[0.06] flex items-center justify-between transition-colors group"
                  >
                    <div className="flex items-center gap-3 min-w-0">
                      <div
                        className={`size-8 rounded-lg font-mono font-bold text-xs flex items-center justify-center shrink-0 ${p.colorClass}`}
                      >
                        {p.initials}
                      </div>
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="text-xs font-bold text-white truncate">
                            {p.username}
                          </span>
                        </div>
                        <span className="text-[11px] font-mono text-on-surface-variant block">
                          {p.dimension}
                        </span>
                      </div>
                    </div>

                    <div className="flex items-center gap-2 shrink-0">
                      <span className="inline-flex items-center gap-1 text-[11px] font-mono text-secondary">
                        <span className="size-1.5 rounded-full bg-secondary" />
                        {p.ping}ms
                      </span>
                      {p.role !== 'Owner' && (
                        <button
                          type="button"
                          onClick={() => onKickPlayer(p.id)}
                          className="opacity-0 group-hover:opacity-100 p-1 rounded hover:bg-error-container/40 text-error transition-opacity cursor-pointer"
                          title={`Disconnect ${p.username}`}
                        >
                          <span className="material-symbols-outlined text-xs">person_remove</span>
                        </button>
                      )}
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>

          {/* CARD D: LOCAL UTILITY DOCK */}
          <div className="rounded-xl bg-surface border border-white/[0.06] p-4 space-y-3">
            <div className="flex items-center justify-between gap-3 text-xs">
              <span className="kp-label">Instance utilities</span>
              <span
                className="font-mono text-[11px] text-outline truncate"
                title={server.path}
              >
                {server.path}
              </span>
            </div>
            <div className="grid grid-cols-2 gap-2.5">
              <button
                type="button"
                onClick={onQuickSnapshot}
                className="flex items-center gap-2 h-9 px-3 rounded-lg bg-white/[0.02] hover:bg-white/[0.06] border border-white/10 text-[11.5px] text-on-surface transition-colors cursor-pointer"
              >
                <span className="material-symbols-outlined text-sm text-primary">folder_zip</span>
                <span>Snapshot</span>
              </button>

              <button
                type="button"
                onClick={() => {
                  onClearLogs();
                  onShowToast(
                    'Console Buffer Purged',
                    'Cleared active stdout scrollback.',
                    'info',
                    'cleaning_services',
                  );
                }}
                className="flex items-center gap-2 h-9 px-3 rounded-lg bg-white/[0.02] hover:bg-white/[0.06] border border-white/10 text-[11.5px] text-on-surface transition-colors cursor-pointer"
              >
                <span className="material-symbols-outlined text-sm text-primary">
                  cleaning_services
                </span>
                <span>Purge Logs</span>
              </button>

              <button
                type="button"
                onClick={() => {
                  void (async () => {
                    try {
                      const r = await fetch('/api/engines/version-check');
                      const d = await r.json().catch(() => null);
                      if (!r.ok || !d?.ok) throw new Error('unreachable');
                      const latest = d.latestPaperBuild
                        ? `Paper ${d.latestPaperRelease} build #${d.latestPaperBuild}`
                        : 'latest catalog';
                      onShowToast(
                        d.outdatedCount > 0 ? 'Engine Update Available' : 'Engines Up To Date',
                        d.outdatedCount > 0
                          ? `${d.outdatedCount} server(s) behind — latest is ${latest}.`
                          : `All servers match the latest catalog (${latest}).`,
                        'info',
                        'update',
                      );
                    } catch {
                      onShowToast(
                        'Version Check Unreachable',
                        'Could not reach the local backend.',
                        'error',
                        'error',
                      );
                    }
                  })();
                }}
                className="flex items-center gap-2 h-9 px-3 rounded-lg bg-white/[0.02] hover:bg-white/[0.06] border border-white/10 text-[11.5px] text-on-surface transition-colors cursor-pointer"
              >
                <span className="material-symbols-outlined text-sm text-secondary">update</span>
                <span>Update JAR</span>
              </button>

              <button
                type="button"
                onClick={() => onNavigate('files')}
                className="flex items-center gap-2 h-9 px-3 rounded-lg bg-white/[0.02] hover:bg-white/[0.06] border border-white/10 text-[11.5px] text-on-surface transition-colors cursor-pointer"
              >
                <span className="material-symbols-outlined text-sm text-primary-gold">
                  folder_open
                </span>
                <span>Open Folder</span>
              </button>
            </div>
          </div>
        </div>

        {/* RIGHT COLUMN: LIVE CONSOLE TERMINAL (7 COLS) */}
        <div className="lg:col-span-7 rounded-xl bg-surface-container-low border border-white/[0.06] flex flex-col overflow-hidden h-full min-h-[680px]">
          {/* Terminal Top Bar */}
          <div className="px-4 h-11 bg-surface-container border-b border-white/[0.06] flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2.5 min-w-0">
              <span className="material-symbols-outlined text-[16px] text-outline">terminal</span>
              <span className="font-mono text-[12px] text-white truncate">server-live.log</span>
              <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md border border-secondary/25 bg-secondary/10 text-secondary font-mono text-[10.5px]">
                <span className="size-1.5 rounded-full bg-secondary" />
                {isRunning ? 'Streaming' : 'Idle'}
              </span>
            </div>

            <div className="flex items-center gap-3 text-xs font-mono text-on-surface-variant">
              <span className="hidden sm:inline text-[11px] text-outline">2.5s poll</span>
              <label className="flex items-center gap-1.5 cursor-pointer select-none text-[11px] text-outline">
                <span>Auto-scroll</span>
                <button
                  type="button"
                  onClick={() => setAutoScroll(!autoScroll)}
                  className={`w-8 h-4 rounded-full transition-colors relative ${
                    autoScroll ? 'bg-primary' : 'bg-surface-container-highest'
                  }`}
                >
                  <span
                    className={`absolute top-0.5 size-3 rounded-full bg-black transition-transform ${
                      autoScroll ? 'left-4' : 'left-0.5 bg-white/70'
                    }`}
                  />
                </button>
              </label>

              <button
                type="button"
                onClick={onClearLogs}
                className="p-1 rounded hover:bg-surface-container-high text-on-surface-variant hover:text-white transition-colors cursor-pointer"
                title="Clear Console View"
              >
                <span className="material-symbols-outlined text-sm">cleaning_services</span>
              </button>

              <button
                type="button"
                onClick={handleDownloadLogs}
                className="p-1 rounded hover:bg-surface-container-high text-on-surface-variant hover:text-white transition-colors cursor-pointer"
                title="Export Console Log"
              >
                <span className="material-symbols-outlined text-sm">download</span>
              </button>
            </div>
          </div>

          {/* Terminal Stream Output */}
          <div
            ref={terminalRef}
            className="flex-1 p-4 font-mono text-[12.5px] leading-relaxed space-y-2.5 overflow-y-auto bg-[#090c14] select-text"
          >
            {activeLogs.length === 0 ? (
              <div className="h-full min-h-[340px] flex flex-col items-center justify-center text-center text-on-surface-variant space-y-2">
                <span className="material-symbols-outlined text-3xl text-on-surface-variant/40">
                  terminal
                </span>
                <p className="text-xs font-bold text-white">
                  {isRunning ? 'Console is clean' : 'Server is Offline — Clean Console'}
                </p>
                <p className="text-[11px] text-on-surface-variant max-w-sm">
                  {isRunning
                    ? 'Waiting for live server stdout events...'
                    : '0 GB RAM in use • No player connected. Click "Start Server" above to launch the server and view live console output.'}
                </p>
              </div>
            ) : (
              activeLogs.map((line) => {
                if (line.highlightBox === 'warn') {
                  return (
                    <div
                      key={line.id}
                      className="p-2.5 rounded-lg bg-primary/10 border-l-2 border-primary text-primary-fixed"
                    >
                      <span className="text-white/40">[{line.time}]</span>{' '}
                      <span className="text-primary font-bold">[WARN]</span> {line.text}
                    </div>
                  );
                }
                if (line.highlightBox === 'join') {
                  return (
                    <div
                      key={line.id}
                      className="p-2.5 rounded-lg bg-secondary/10 border-l-2 border-secondary text-white font-medium"
                    >
                      <span className="text-white/40">[{line.time}]</span>{' '}
                      <span className="text-secondary font-bold">[JOIN]</span> {line.text}
                    </div>
                  );
                }
                if (line.highlightBox === 'error') {
                  return (
                    <div
                      key={line.id}
                      className="p-2.5 rounded-lg bg-error-container/25 border-l-2 border-error text-on-error-container"
                    >
                      <span className="text-white/40">[{line.time}]</span>{' '}
                      <span className="text-error font-bold">[ERROR]</span> {line.text}
                    </div>
                  );
                }
                if (line.highlightBox === 'broadcast') {
                  return (
                    <div
                      key={line.id}
                      className="p-2.5 rounded-lg bg-primary/15 border-l-2 border-primary text-primary-gold font-semibold"
                    >
                      <span className="text-white/40">[{line.time}]</span>{' '}
                      <span className="text-primary font-bold">[BROADCAST]</span> {line.text}
                    </div>
                  );
                }
                if (line.level === 'UPnP') {
                  return (
                    <div key={line.id} className="text-tertiary">
                      <span className="text-white/40">[{line.time}]</span>{' '}
                      <span className="font-bold">[UPnP]</span> {line.text}
                    </div>
                  );
                }
                if (line.level === 'CHAT') {
                  return (
                    <div key={line.id} className="text-white">
                      <span className="text-white/40">[{line.time}]</span>{' '}
                      <span className="font-bold text-white">&lt;{line.sender}&gt;</span>{' '}
                      {line.text}
                    </div>
                  );
                }
                if (line.level === 'EXEC') {
                  return (
                    <div key={line.id} className="text-primary">
                      <span className="text-white/40">[{line.time}]</span>{' '}
                      <span className="text-primary font-bold">[EXEC]</span>{' '}
                      <span className="text-white font-semibold">{line.text}</span>
                    </div>
                  );
                }
                return (
                  <div key={line.id} className="text-on-surface">
                    <span className="text-white/40">[{line.time}]</span>{' '}
                    <span className="text-primary font-bold">[{line.level}]</span> {line.text}
                  </div>
                );
              })
            )}
          </div>

          {/* Quick Command Suggestions Strip */}
          <div className="px-4 h-9 bg-surface-container border-t border-white/[0.06] flex items-center gap-1.5 overflow-x-auto text-[11px] font-mono">
            <span className="text-outline shrink-0">Quick</span>
            {['/tps', '/list', '/save-all flush', '/whitelist list', '/weather clear'].map(
              (cmd) => (
                <button
                  key={cmd}
                  type="button"
                  onClick={() => setCmdInput(cmd)}
                  className="px-2 py-0.5 rounded-md bg-white/[0.03] hover:bg-white/[0.08] text-outline hover:text-primary transition-colors shrink-0 cursor-pointer"
                >
                  {cmd}
                </button>
              ),
            )}
          </div>

          {/* Terminal Command Input Bar */}
          <form
            onSubmit={handleSendCommand}
            className="p-3 bg-surface-container border-t border-white/[0.06] flex items-center gap-2"
          >
            <div className="flex-1 flex items-center bg-surface-container-lowest border border-white/10 focus-within:border-primary/50 rounded-lg px-3 h-9 transition-colors">
              <span className="text-primary font-mono font-bold mr-2">&gt;</span>
              <input
                type="text"
                value={cmdInput}
                onChange={(e) => setCmdInput(e.target.value)}
                placeholder="Type a server command (/whitelist, /say, /weather)..."
                className="flex-1 bg-transparent text-xs font-mono text-white placeholder:text-on-surface-variant/50 focus:outline-none"
              />
              <span className="text-[10px] font-mono text-white/30 ml-2 hidden sm:inline">
                ↵ RETURN
              </span>
            </div>
            <button
              type="submit"
              className="h-9 px-4 rounded-lg bg-primary hover:brightness-105 text-on-primary font-semibold text-[11.5px] flex items-center gap-1.5 transition-all cursor-pointer shrink-0"
            >
              <span>Send</span>
              <span className="material-symbols-outlined text-sm">send</span>
            </button>
          </form>
        </div>
      </div>
    </div>
  );
};
