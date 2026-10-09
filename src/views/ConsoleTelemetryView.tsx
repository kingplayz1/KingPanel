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
  onShowToast: (title: string, body?: string, type?: 'success' | 'info' | 'warning' | 'error', icon?: string) => void;
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
  const terminalRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (autoScroll && terminalRef.current) {
      terminalRef.current.scrollTop = terminalRef.current.scrollHeight;
    }
  }, [logs, autoScroll]);

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

    onAddLog({
      level: 'EXEC',
      text: `> ${trimmed}`,
    });

    setCmdInput('');

    setTimeout(() => {
      const lower = trimmed.toLowerCase();
      if (lower === 'help' || lower === '/help' || lower === '/?') {
        onAddLog({
          level: 'INFO',
          text: 'Available commands: /tps, /list, /save-all, /whitelist, /gamemode, /weather, /say, /spark',
        });
      } else if (lower.startsWith('/say ') || lower.startsWith('say ')) {
        const msg = trimmed.replace(/^\/?say\s+/i, '');
        onAddLog({
          level: 'BROADCAST',
          text: `[Server] ${msg}`,
          highlightBox: 'broadcast',
        });
      } else if (lower === '/list' || lower === 'list') {
        onAddLog({
          level: 'INFO',
          text: `There are ${players.length} of a max of ${server.maxPlayers} players online: ${players
            .map((p) => p.username)
            .join(', ')}`,
        });
      } else if (lower === '/tps' || lower === 'tps') {
        onAddLog({
          level: 'INFO',
          text: `TPS from last 1m, 5m, 15m: *20.0, *20.0, *20.0 (Tick duration: ${server.tickMs}ms)`,
        });
      } else {
        onAddLog({
          level: 'INFO',
          text: `Command processed by PaperMC kernel: ${trimmed} (OK)`,
        });
      }
    }, 240);
  };

  const handleSendBroadcast = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = broadcastText.trim();
    if (!trimmed) return;
    onAddLog({
      level: 'BROADCAST',
      text: `[Server Broadcast] ${trimmed}`,
      highlightBox: 'broadcast',
    });
    setBroadcastText('');
    setBroadcastOpen(false);
    onShowToast('Broadcast Sent', `Dispatched to ${players.length} online players.`, 'success', 'campaign');
  };

  const handleDownloadLogs = () => {
    const content = logs.map((l) => `[${l.time}] [${l.level}] ${l.sender ? `<${l.sender}> ` : ''}${l.text}`).join('\n');
    const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${server.id}-live.log`;
    a.click();
    URL.revokeObjectURL(url);
    onShowToast('Live Log Exported', `Saved ${logs.length} lines to ${server.id}-live.log`, 'success', 'download');
  };

  return (
    <div className="flex flex-col w-full space-y-4">
      {/* ================= 1. TOP SERVER INSTANCE HERO BANNER ================= */}
      <div className="rounded-2xl bg-surface-container-low border border-white/5 p-5 shadow-xl flex flex-col xl:flex-row xl:items-center justify-between gap-5">
        <div className="flex items-start sm:items-center gap-4">
          {/* Pickaxe Emblem with Online Status Dot */}
          <div className="relative size-14 rounded-2xl bg-surface-container border border-white/10 flex items-center justify-center shrink-0 shadow-inner">
            <span className="text-2xl">⛏️</span>
            <span
              className={`absolute -top-1 -right-1 size-3.5 rounded-full border-2 border-surface-container-low ${
                server.status === 'running'
                  ? 'bg-secondary'
                  : server.status === 'restarting'
                  ? 'bg-primary animate-ping'
                  : 'bg-error'
              }`}
            />
          </div>

          <div className="space-y-1.5">
            <div className="flex flex-wrap items-center gap-2.5">
              <h1 className="text-xl sm:text-2xl font-bold text-white tracking-tight">{server.name}</h1>
              <span
                className={`inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-mono font-semibold border ${
                  server.status === 'running'
                    ? 'bg-secondary/10 text-secondary border-secondary/30'
                    : server.status === 'restarting'
                    ? 'bg-primary/15 text-primary border-primary/30'
                    : 'bg-error/15 text-error border-error/30'
                }`}
              >
                <span
                  className={`size-2 rounded-full ${
                    server.status === 'running'
                      ? 'bg-secondary'
                      : server.status === 'restarting'
                      ? 'bg-primary animate-spin'
                      : 'bg-error'
                  }`}
                />
                <span>
                  {server.status === 'running'
                    ? 'Running'
                    : server.status === 'restarting'
                    ? 'Restarting'
                    : 'Stopped'}{' '}
                  • {server.engine}
                </span>
              </span>
            </div>

            <div className="flex flex-wrap items-center gap-2 text-xs font-mono">
              <span className="px-2 py-0.5 rounded bg-surface-container text-on-surface-variant border border-white/5">
                {server.build}
              </span>
              <button
                type="button"
                onClick={handleCopyIp}
                className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded bg-primary/10 hover:bg-primary/20 text-primary border border-primary/30 transition-colors cursor-pointer"
                title="Copy Localhost Socket"
              >
                <span>127.0.0.1:{server.port}</span>
                <span className="material-symbols-outlined text-xs">
                  {copiedIp ? 'done' : 'content_copy'}
                </span>
              </button>
              <span className="text-white/30">•</span>
              <span className="text-on-surface-variant">
                Bungeecord Guard: <strong className="text-secondary font-semibold">Active</strong>
              </span>
            </div>

            <div className="text-xs text-on-surface-variant/80 flex flex-wrap items-center gap-2 pt-0.5">
              <span>
                Binding: <strong className="text-white font-mono">0.0.0.0 (Localhost NAT)</strong>
              </span>
              <span className="text-white/30">•</span>
              <span>
                Region: <strong className="text-white">US-East / Host</strong>
              </span>
            </div>
          </div>
        </div>

        {/* Right Action Button Cluster */}
        <div className="flex flex-col sm:items-end gap-2 shrink-0">
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => onServerAction('restart')}
              className="flex items-center gap-1.5 px-4 py-2 rounded-xl bg-primary hover:bg-primary-gold text-on-primary font-bold text-xs shadow-lg shadow-primary/20 transition-all cursor-pointer active:scale-95"
            >
              <span className="material-symbols-outlined text-sm font-bold">refresh</span>
              <span>Restart</span>
            </button>

            <button
              type="button"
              onClick={() => onServerAction(server.status === 'stopped' ? 'start' : 'stop')}
              className="flex items-center gap-1.5 px-3.5 py-2 rounded-xl bg-surface-container-high hover:bg-surface-bright text-white font-semibold text-xs border border-white/10 transition-colors cursor-pointer"
            >
              <span className="material-symbols-outlined text-sm text-primary">
                {server.status === 'stopped' ? 'play_arrow' : 'power_settings_new'}
              </span>
              <span>{server.status === 'stopped' ? 'Start Server' : 'Graceful Stop'}</span>
            </button>

            <button
              type="button"
              onClick={() => onServerAction('kill')}
              className="flex items-center gap-1.5 px-3.5 py-2 rounded-xl bg-error-container/25 hover:bg-error-container/50 text-error font-semibold text-xs border border-error/30 transition-colors cursor-pointer"
            >
              <span className="material-symbols-outlined text-sm">dangerous</span>
              <span>SIGKILL</span>
            </button>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => {
                onNavigate('network');
                onShowToast('LAN Pinhole BroadcastActive', 'Opened UPnP & Tunnel Gateway settings.', 'info', 'wifi_tethering');
              }}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-surface-container hover:bg-surface-container-high text-on-surface text-xs border border-white/5 transition-colors cursor-pointer"
            >
              <span className="material-symbols-outlined text-sm text-tertiary">wifi_tethering</span>
              <span>Share LAN</span>
            </button>

            <button
              type="button"
              onClick={onQuickSnapshot}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-surface-container hover:bg-surface-container-high text-on-surface text-xs border border-white/5 transition-colors cursor-pointer"
            >
              <span className="material-symbols-outlined text-sm text-primary-gold">folder_zip</span>
              <span>Snapshot</span>
            </button>
          </div>
        </div>
      </div>

      {/* ================= 2. 5-COLUMN TELEMETRY KPI STRIP ================= */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3.5">
        {/* Card 1: TPS Health */}
        <div className="rounded-2xl bg-surface-container-low border border-white/5 p-4 flex flex-col justify-between space-y-2 shadow-md">
          <div className="flex items-center justify-between text-xs text-on-surface-variant">
            <span>TPS Health</span>
            <span className="material-symbols-outlined text-sm text-secondary">equalizer</span>
          </div>
          <div className="flex items-baseline gap-2">
            <span className="text-2xl font-bold font-mono text-white tabular-nums">
              {server.status === 'stopped' ? '0.0' : server.tps.toFixed(1)}
            </span>
            <span className="text-xs font-semibold text-secondary">
              {server.status === 'stopped' ? 'Halted' : 'Solid'}
            </span>
          </div>
          <div className="text-[11px] font-mono text-secondary">
            Tick {server.tickMs}ms (+0% jitter)
          </div>
        </div>

        {/* Card 2: Process Uptime */}
        <div className="rounded-2xl bg-surface-container-low border border-white/5 p-4 flex flex-col justify-between space-y-2 shadow-md">
          <div className="flex items-center justify-between text-xs text-on-surface-variant">
            <span>Process Uptime</span>
            <span className="material-symbols-outlined text-sm text-primary">hourglass_top</span>
          </div>
          <div className="text-2xl font-bold font-mono text-white tabular-nums">{server.uptime}</div>
          <div className="text-[11px] font-mono text-secondary">99.99% Availability</div>
        </div>

        {/* Card 3: Online Players */}
        <div className="rounded-2xl bg-surface-container-low border border-white/5 p-4 flex flex-col justify-between space-y-2 shadow-md">
          <div className="flex items-center justify-between text-xs text-on-surface-variant">
            <span>Online Players</span>
            <span className="material-symbols-outlined text-sm text-secondary">group</span>
          </div>
          <div className="flex items-baseline gap-1.5 font-mono">
            <span className="text-2xl font-bold text-white tabular-nums">{players.length}</span>
            <span className="text-xs text-on-surface-variant">/ {server.maxPlayers}</span>
          </div>
          <div className="text-[11px] font-mono text-secondary">+40% Peak Hour</div>
        </div>

        {/* Card 4: CPU & Thermals */}
        <div className="rounded-2xl bg-surface-container-low border border-white/5 p-4 flex flex-col justify-between space-y-2 shadow-md">
          <div className="flex items-center justify-between text-xs text-on-surface-variant">
            <span>CPU &amp; Thermals</span>
            <span className="material-symbols-outlined text-sm text-primary">device_thermostat</span>
          </div>
          <div className="flex items-baseline gap-2 font-mono">
            <span className="text-2xl font-bold text-white tabular-nums">{server.cpuUsage}%</span>
            <span className="text-xs font-semibold text-secondary tabular-nums">{server.cpuTemp}°C</span>
          </div>
          <div className="text-[11px] font-mono text-on-surface-variant">AMD EPYC / Ryzen 9</div>
        </div>

        {/* Card 5: RAM Allocation */}
        <div className="rounded-2xl bg-surface-container-low border border-white/5 p-4 flex flex-col justify-between space-y-2 shadow-md">
          <div className="flex items-center justify-between text-xs text-on-surface-variant">
            <span>RAM Allocation</span>
            <span className="material-symbols-outlined text-sm text-tertiary">memory</span>
          </div>
          <div className="flex items-baseline gap-1.5 font-mono">
            <span className="text-2xl font-bold text-white tabular-nums">{server.ramUsedGb}</span>
            <span className="text-xs text-on-surface-variant">/ {server.ramMaxGb.toFixed(1)} GB</span>
          </div>
          <div className="text-[11px] font-mono text-tertiary">ZGC Low-Latency</div>
        </div>
      </div>

      {/* ================= 3. MAIN WORKSPACE SPLIT (TELEMETRY LEFT / LIVE CONSOLE RIGHT) ================= */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-4 items-start">
        {/* LEFT COLUMN (5 COLS) */}
        <div className="lg:col-span-5 flex flex-col gap-4">
          {/* CARD A: HARDWARE PERFORMANCE */}
          <div className="rounded-2xl bg-surface-container-low border border-white/5 p-4 shadow-lg space-y-3.5">
            <div className="flex items-start justify-between">
              <div>
                <span className="text-[10px] font-mono uppercase tracking-wider text-on-surface-variant block">
                  Hardware Performance
                </span>
                <div className="flex items-baseline gap-2 mt-0.5">
                  <span className="text-lg font-bold font-mono text-white">{server.cpuUsage}%</span>
                  <span className="text-xs font-mono text-on-surface-variant">CPU Allocation</span>
                </div>
              </div>
              <div className="text-right space-y-1">
                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-secondary/10 text-secondary text-[10px] font-mono">
                  <span className="size-1.5 rounded-full bg-secondary animate-pulse" />
                  60Hz Real-Time
                </span>
                <div className="text-[11px] font-mono text-secondary">Die {server.cpuTemp}°C Stable</div>
              </div>
            </div>

            {/* Smooth Amber Wave SVG Graph */}
            <div className="relative h-28 w-full pt-2">
              <svg className="w-full h-full overflow-visible" viewBox="0 0 400 100" preserveAspectRatio="none">
                <defs>
                  <linearGradient id="cpuAmberFill" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#f59e0b" stopOpacity="0.32" />
                    <stop offset="100%" stopColor="#f59e0b" stopOpacity="0.0" />
                  </linearGradient>
                </defs>
                <line x1="0" y1="25" x2="400" y2="25" stroke="rgba(255,255,255,0.04)" strokeWidth="1" />
                <line x1="0" y1="50" x2="400" y2="50" stroke="rgba(255,255,255,0.04)" strokeWidth="1" />
                <line x1="0" y1="75" x2="400" y2="75" stroke="rgba(255,255,255,0.04)" strokeWidth="1" />
                <path
                  d="M 0,68 C 30,20 55,20 85,48 C 115,75 140,70 175,38 C 210,8 235,60 270,58 C 305,56 325,85 350,30 C 375,-15 390,45 400,52 L 400,100 L 0,100 Z"
                  fill="url(#cpuAmberFill)"
                />
                <path
                  d="M 0,68 C 30,20 55,20 85,48 C 115,75 140,70 175,38 C 210,8 235,60 270,58 C 305,56 325,85 350,30 C 375,-15 390,45 400,52"
                  fill="none"
                  stroke="#f59e0b"
                  strokeWidth="2.5"
                  strokeLinecap="round"
                />
              </svg>
            </div>

            <div className="flex items-center justify-between text-[10px] font-mono text-on-surface-variant/60 px-1">
              <span>-60s</span>
              <span>-45s</span>
              <span>-30s</span>
              <span>-15s</span>
              <span className="text-primary font-bold">Now</span>
            </div>

            <div className="grid grid-cols-2 gap-2.5 pt-1">
              <div className="p-2.5 rounded-xl bg-surface-container border border-white/5 space-y-0.5">
                <span className="text-[10px] text-on-surface-variant block">Core Topology</span>
                <p className="text-xs font-bold text-white font-mono">8 Cores / 16 Threads</p>
                <span className="text-[10px] font-mono text-secondary block">Fan: 1,420 RPM</span>
              </div>
              <div className="p-2.5 rounded-xl bg-surface-container border border-white/5 space-y-0.5">
                <span className="text-[10px] text-on-surface-variant block">Tick Budget Max</span>
                <p className="text-xs font-bold text-tertiary font-mono">{server.tickMs}ms / 50ms</p>
                <span className="text-[10px] font-mono text-on-surface-variant block">Zero lag spikes</span>
              </div>
            </div>
          </div>

          {/* CARD B: JVM HEAP ALLOCATION */}
          <div className="rounded-2xl bg-surface-container-low border border-white/5 p-4 shadow-lg space-y-3">
            <div className="flex items-start justify-between">
              <div>
                <span className="text-[10px] font-mono uppercase tracking-wider text-on-surface-variant block">
                  JVM Heap Allocation
                </span>
                <div className="flex items-baseline gap-1.5 mt-0.5 font-mono">
                  <span className="text-lg font-bold text-white">4,302 MB</span>
                  <span className="text-xs text-on-surface-variant">/ 8,192 MB (52.5%)</span>
                </div>
              </div>
              <button
                type="button"
                onClick={() => onNavigate('jvm')}
                className="px-2.5 py-1 rounded-lg bg-tertiary/10 hover:bg-tertiary/20 text-tertiary border border-tertiary/20 text-[10px] font-mono font-semibold transition-colors cursor-pointer"
              >
                ZGC Generational
              </button>
            </div>

            {/* Multi-segment Heap Bar */}
            <div className="w-full h-2.5 bg-surface-container-highest rounded-full overflow-hidden flex gap-0.5 p-0.5">
              <div className="bg-primary h-full rounded-l-full" style={{ width: '42%' }} title="Old Gen: 3.4 GB" />
              <div className="bg-secondary h-full" style={{ width: '12%' }} title="Eden: 0.9 GB" />
              <div className="bg-tertiary h-full rounded-r-full" style={{ width: '6%' }} title="Native: 0.4 GB" />
            </div>

            <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] font-mono text-on-surface-variant">
              <span className="flex items-center gap-1.5">
                <span className="size-2 rounded-full bg-primary" />
                Old Gen: 3.4 GB
              </span>
              <span className="flex items-center gap-1.5">
                <span className="size-2 rounded-full bg-secondary" />
                Eden: 0.9 GB
              </span>
              <span className="flex items-center gap-1.5">
                <span className="size-2 rounded-full bg-tertiary" />
                Native: 0.4 GB
              </span>
            </div>

            <div className="pt-2 border-t border-white/5 flex items-center justify-between text-[11px] font-mono">
              <span className="text-on-surface-variant">GC Pause: &lt;1.2ms Avg</span>
              <button
                type="button"
                onClick={() => onNavigate('jvm')}
                className="text-primary hover:underline cursor-pointer"
              >
                Aikar&apos;s Flag Profile: Active
              </button>
            </div>
          </div>

          {/* CARD C: CONNECTED PLAYERS */}
          <div className="rounded-2xl bg-surface-container-low border border-white/5 p-4 shadow-lg space-y-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span className="material-symbols-outlined text-primary text-base">groups</span>
                <span className="text-xs font-bold uppercase tracking-wider font-mono text-white">
                  Connected Players ({players.length} / {server.maxPlayers})
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
              {players.map((p) => (
                <div
                  key={p.id}
                  className="p-2.5 rounded-xl bg-surface-container hover:bg-surface-container-high border border-white/5 flex items-center justify-between transition-colors group"
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <div
                      className={`size-8 rounded-lg font-mono font-bold text-xs flex items-center justify-center shrink-0 ${p.colorClass}`}
                    >
                      {p.initials}
                    </div>
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-xs font-bold text-white truncate">{p.username}</span>
                        {p.role === 'Owner' && (
                          <span className="px-1.5 py-0.5 rounded bg-primary/20 text-primary text-[10px] font-mono font-semibold">
                            Owner 👑
                          </span>
                        )}
                        {p.role === 'Admin' && (
                          <span className="px-1.5 py-0.5 rounded bg-sky-500/20 text-sky-400 text-[10px] font-mono font-semibold">
                            Admin 🛡️
                          </span>
                        )}
                        {p.role === 'Moderator' && (
                          <span className="px-1.5 py-0.5 rounded bg-purple-500/20 text-purple-300 text-[10px] font-mono font-semibold">
                            Moderator
                          </span>
                        )}
                        {p.role === 'Member' && (
                          <span className="px-1.5 py-0.5 rounded bg-white/10 text-on-surface-variant text-[10px] font-mono">
                            Member
                          </span>
                        )}
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
              ))}
            </div>
          </div>

          {/* CARD D: LOCAL UTILITY DOCK */}
          <div className="rounded-2xl bg-surface-container-low border border-white/5 p-4 shadow-lg space-y-3">
            <div className="flex items-center justify-between text-xs">
              <span className="font-bold text-white">Local Utility Dock</span>
              <span className="font-mono text-[11px] text-on-surface-variant">{server.path}</span>
            </div>
            <div className="grid grid-cols-2 gap-2.5">
              <button
                type="button"
                onClick={onQuickSnapshot}
                className="flex items-center gap-2 p-2.5 rounded-xl bg-surface-container hover:bg-surface-container-high border border-white/5 text-xs text-white transition-colors cursor-pointer"
              >
                <span className="material-symbols-outlined text-sm text-primary">folder_zip</span>
                <span>Snapshot NVMe</span>
              </button>

              <button
                type="button"
                onClick={() => {
                  onClearLogs();
                  onShowToast('Console Buffer Purged', 'Cleared active stdout scrollback.', 'info', 'cleaning_services');
                }}
                className="flex items-center gap-2 p-2.5 rounded-xl bg-surface-container hover:bg-surface-container-high border border-white/5 text-xs text-white transition-colors cursor-pointer"
              >
                <span className="material-symbols-outlined text-sm text-primary">cleaning_services</span>
                <span>Purge Logs</span>
              </button>

              <button
                type="button"
                onClick={() =>
                  onShowToast(
                    'PaperMC Build #448 Verified',
                    'Already running latest Paper 1.20.4 stable artifact.',
                    'success',
                    'update'
                  )
                }
                className="flex items-center gap-2 p-2.5 rounded-xl bg-surface-container hover:bg-surface-container-high border border-white/5 text-xs text-white transition-colors cursor-pointer"
              >
                <span className="material-symbols-outlined text-sm text-secondary">update</span>
                <span>Update JAR</span>
              </button>

              <button
                type="button"
                onClick={() => onNavigate('files')}
                className="flex items-center gap-2 p-2.5 rounded-xl bg-surface-container hover:bg-surface-container-high border border-white/5 text-xs text-white transition-colors cursor-pointer"
              >
                <span className="material-symbols-outlined text-sm text-primary-gold">folder_open</span>
                <span>Open Folder</span>
              </button>
            </div>
          </div>
        </div>

        {/* RIGHT COLUMN: LIVE CONSOLE TERMINAL (7 COLS) */}
        <div className="lg:col-span-7 rounded-2xl bg-surface-container-low border border-white/5 shadow-2xl flex flex-col overflow-hidden h-full min-h-[680px]">
          {/* Terminal Top Bar */}
          <div className="px-4 py-3 bg-surface-container border-b border-white/5 flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              {/* macOS/Terminal Window Dots */}
              <div className="flex items-center gap-1.5">
                <span className="size-2.5 rounded-full bg-error inline-block" />
                <span className="size-2.5 rounded-full bg-primary inline-block" />
                <span className="size-2.5 rounded-full bg-secondary inline-block" />
              </div>
              <span className="text-white/20">|</span>
              <div className="flex items-center gap-1.5 font-mono text-xs font-bold text-white">
                <span className="material-symbols-outlined text-sm text-primary">terminal</span>
                <span>bash • server-live.log</span>
              </div>
              <span className="px-2 py-0.5 rounded bg-secondary/10 border border-secondary/30 text-secondary font-mono text-[10px] font-semibold flex items-center gap-1">
                <span className="size-1.5 rounded-full bg-secondary animate-pulse" />
                STDOUT Pipe Active
              </span>
            </div>

            <div className="flex items-center gap-3 text-xs font-mono text-on-surface-variant">
              <span className="hidden sm:inline text-[11px]">60Hz Socket</span>
              <label className="flex items-center gap-1.5 cursor-pointer select-none text-[11px]">
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
            {logs.map((line) => {
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
                    <span className="font-bold text-white">&lt;{line.sender}&gt;</span> {line.text}
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
            })}
          </div>

          {/* Quick Command Suggestions Strip */}
          <div className="px-4 py-1.5 bg-[#0b0e17] border-t border-white/5 flex items-center gap-1.5 overflow-x-auto text-[11px] font-mono">
            <span className="text-white/40 shrink-0">Quick:</span>
            {['/tps', '/list', '/save-all flush', '/whitelist list', '/weather clear'].map((cmd) => (
              <button
                key={cmd}
                type="button"
                onClick={() => setCmdInput(cmd)}
                className="px-2 py-0.5 rounded bg-surface-container hover:bg-surface-container-high text-on-surface-variant hover:text-primary transition-colors shrink-0 cursor-pointer"
              >
                {cmd}
              </button>
            ))}
          </div>

          {/* Terminal Command Input Bar */}
          <form
            onSubmit={handleSendCommand}
            className="p-3 bg-surface-container border-t border-white/5 flex items-center gap-2.5"
          >
            <div className="flex-1 flex items-center bg-surface-container-lowest border border-white/10 focus-within:border-primary/50 rounded-xl px-3.5 py-2.5 transition-colors">
              <span className="text-primary font-mono font-bold mr-2">&gt;</span>
              <input
                type="text"
                value={cmdInput}
                onChange={(e) => setCmdInput(e.target.value)}
                placeholder="Type a server command (/whitelist, /say, /weather)..."
                className="flex-1 bg-transparent text-xs font-mono text-white placeholder:text-on-surface-variant/50 focus:outline-none"
              />
              <span className="text-[10px] font-mono text-white/30 ml-2 hidden sm:inline">↵ RETURN</span>
            </div>
            <button
              type="submit"
              className="px-5 py-2.5 rounded-xl bg-primary hover:bg-primary-gold text-on-primary font-bold text-xs flex items-center gap-1.5 shadow-lg shadow-primary/20 transition-all cursor-pointer active:scale-95 shrink-0"
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
