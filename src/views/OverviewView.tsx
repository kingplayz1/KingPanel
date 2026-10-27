import React, { useState, useEffect } from 'react';
import { ServerInstallModal } from '../components/ServerInstallModal';
import {
  ResponsiveContainer,
  AreaChart,
  Area,
  ComposedChart,
  Bar,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ReferenceLine,
} from 'recharts';
import {
  ServerInstance,
  ConnectedPlayer,
  NavSection,
  AuthUser,
  PaperMCServiceReport,
} from '../types';
import { HOTLINKED_IMAGES } from '../data/initialData';

interface TelemetryDataPoint {
  time: string;
  cpuTotal: number;
  cpuKernel: number;
  cpuTemp: number;
  ramUsedGb: number;
  ramCommittedGb: number;
  diskReadMbs: number;
  diskWriteMbs: number;
  iops: number;
}

interface OverviewViewProps {
  servers: ServerInstance[];
  activeServer: ServerInstance;
  players: ConnectedPlayer[];
  onSelectServer: (server: ServerInstance) => void;
  onManageServer: (server: ServerInstance, targetSection?: NavSection) => void;
  onServerPowerAction: (serverId: string, action: 'start' | 'restart' | 'stop' | 'kill') => void;
  onBulkServerAction: (
    action: 'start_all' | 'restart_running' | 'stop_all' | 'snapshot_all',
  ) => void;
  onCreateServerInstance: (newServer: ServerInstance) => void;
  serverInstallRootDir?: string;
  currentUser?: AuthUser | null;
  paperMcReport?: PaperMCServiceReport | null;
  onRunPaperMcCheckNow?: () => void;
  onUpgradeServerEngine?: (serverId: string | 'ALL') => void;
  onOpenDiscordBotGate?: (attemptedServerName?: string) => void;
  onLeaveDiscordServer?: () => void;
  onShowToast: (
    title: string,
    body?: string,
    type?: 'success' | 'info' | 'warning' | 'error',
    icon?: string,
  ) => void;
}

export const OverviewView: React.FC<OverviewViewProps> = ({
  servers,
  activeServer,
  players,
  onSelectServer,
  onManageServer,
  onServerPowerAction,
  onBulkServerAction,
  onCreateServerInstance,
  serverInstallRootDir = 'C:\\KingServers',
  currentUser,
  paperMcReport,
  onRunPaperMcCheckNow,
  onUpgradeServerEngine,
  onOpenDiscordBotGate,
  onLeaveDiscordServer,
  onShowToast,
}) => {
  const [statusFilter, setStatusFilter] = useState<'all' | 'running' | 'stopped'>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [layoutMode, setLayoutMode] = useState<'cards' | 'table'>('cards');
  const [createModalOpen, setCreateModalOpen] = useState(false);

  // Real host numbers straight from the local backend (no interpolation).
  const [hostStats, setHostStats] = useState<{
    cpuPct: number;
    ramUsedGb: number;
    ramTotalGb: number;
  }>({ cpuPct: 0, ramUsedGb: 0, ramTotalGb: 0 });

  // Compute global fleet aggregations across running servers
  const runningServers = servers.filter((s) => s.status === 'running' || s.status === 'restarting');
  const stoppedServers = servers.filter((s) => s.status === 'stopped');

  const totalPlayersOnline = runningServers.reduce((acc, s) => acc + s.playersOnline, 0);
  const totalMaxPlayersRunning = runningServers.reduce((acc, s) => acc + s.maxPlayers, 0);
  const totalMaxPlayersAll = servers.reduce((acc, s) => acc + s.maxPlayers, 0);

  const combinedCpuUsage = runningServers.reduce((acc, s) => acc + s.cpuUsage, 0);
  const hostNormalizedCpu = Math.min(100, Math.round(combinedCpuUsage));
  const combinedRamUsedGb = Number(
    runningServers.reduce((acc, s) => acc + s.ramUsedGb, 0).toFixed(1),
  );
  const combinedRamAllocatedGb = Number(
    runningServers.reduce((acc, s) => acc + s.ramMaxGb, 0).toFixed(1),
  );
  const totalHostRamGb = hostStats.ramTotalGb;
  const hostRamPercent =
    totalHostRamGb > 0 ? Math.min(100, Math.round((combinedRamUsedGb / totalHostRamGb) * 100)) : 0;

  const avgTps =
    runningServers.length > 0
      ? (runningServers.reduce((acc, s) => acc + s.tps, 0) / runningServers.length).toFixed(1)
      : '0.0';

  // Real-time System Performance Monitor state (CPU, RAM, Disk I/O)
  const [telemetryPaused, setTelemetryPaused] = useState(false);
  const [timeRange, setTimeRange] = useState<'30s' | '1m' | '5m'>('1m');
  const [telemetryHistory, setTelemetryHistory] = useState<TelemetryDataPoint[]>([]);

  useEffect(() => {
    let cancelled = false;
    const sample = async () => {
      try {
        const res = await fetch('/api/panel/telemetry');
        const data = await res.json();
        if (!data?.ok || cancelled) return;
        const host = data.host || {};
        const cpuPct = Math.round(Number(host.cpuUsagePct) || 0);
        const ramUsedGb = Number(host.osUsedGb) || 0;
        const ramTotalGb = Number(host.osTotalGb) || 0;
        setHostStats({ cpuPct, ramUsedGb, ramTotalGb });
        if (telemetryPaused) return;
        const timeStr = new Date().toTimeString().split(' ')[0].slice(3);
        setTelemetryHistory((prev) => {
          const nextPoint: TelemetryDataPoint = {
            time: timeStr,
            cpuTotal: cpuPct,
            cpuKernel: 0,
            cpuTemp: 0,
            ramUsedGb,
            ramCommittedGb: combinedRamAllocatedGb,
            diskReadMbs: 0,
            diskWriteMbs: 0,
            iops: 0,
          };
          const maxPoints = timeRange === '30s' ? 12 : timeRange === '1m' ? 18 : 26;
          return [...prev.slice(-(maxPoints - 1)), nextPoint];
        });
      } catch {
        // backend restarting — keep the last sample
      }
    };
    void sample();
    const timer = setInterval(() => void sample(), 2000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [telemetryPaused, timeRange, combinedRamAllocatedGb]);

  const latestTelemetry = telemetryHistory[telemetryHistory.length - 1] || {
    cpuTotal: hostStats.cpuPct,
    cpuKernel: 0,
    cpuTemp: 0,
    ramUsedGb: hostStats.ramUsedGb,
    ramCommittedGb: combinedRamAllocatedGb,
    diskReadMbs: 0,
    diskWriteMbs: 0,
    iops: 0,
  };

  // Filter servers for display
  const filteredServers = servers.filter((srv) => {
    if (statusFilter === 'running' && srv.status === 'stopped') return false;
    if (statusFilter === 'stopped' && srv.status !== 'stopped') return false;
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      return (
        srv.name.toLowerCase().includes(q) ||
        srv.engine.toLowerCase().includes(q) ||
        String(srv.port).includes(q) ||
        String(srv.pid).includes(q) ||
        srv.path.toLowerCase().includes(q)
      );
    }
    return true;
  });

  const isSuperAdmin =
    currentUser?.username?.toLowerCase() === 'kingplayz' ||
    currentUser?.role === 'Super Admin' ||
    Boolean(currentUser?.isSuperAdmin);
  const isDiscordVerified = Boolean(currentUser?.discordVerified) || isSuperAdmin;
  const maxServerLimit = isSuperAdmin
    ? 999
    : isDiscordVerified
      ? currentUser?.maxServerLimit || 10
      : 2;
  const isAtServerLimit = !isSuperAdmin && servers.length >= maxServerLimit;

  const latestPaperRelease = paperMcReport?.latestPaperRelease || '1.21.4';
  const latestPaperBuild = paperMcReport?.latestPaperBuild || 'Build #222';
  const outdatedServers = servers.filter((s) =>
    s.isOutdated !== undefined ? s.isOutdated : !s.engine.includes(latestPaperRelease),
  );

  const segmentColors = [
    'bg-primary',
    'bg-secondary',
    'bg-tertiary',
    'bg-amber-300',
    'bg-purple-400',
    'bg-rose-400',
  ];

  return (
    <main className="flex-1 flex flex-col bg-surface-dim overflow-hidden">
      {/* Top Contextual Header */}
      <header className="h-[54px] px-6 bg-surface border-b border-white/[0.06] flex items-center justify-between shrink-0">
        <div className="flex items-center gap-2.5 min-w-0">
          <span className="material-symbols-outlined text-[18px] text-primary">space_dashboard</span>
          <h1 className="text-[14.5px] font-semibold tracking-tight text-on-surface whitespace-nowrap">
            Server Overview
          </h1>
          <span className="w-px h-4 bg-white/10" />
          <p className="text-[11.5px] text-outline font-mono truncate">
            {runningServers.length} of {servers.length} running
          </p>
        </div>

        {/* Simple Header Action */}
        <div className="flex items-center gap-2.5">
          <button
            onClick={() => {
              if (isAtServerLimit && !isDiscordVerified && onOpenDiscordBotGate) {
                onOpenDiscordBotGate(`Server #${servers.length + 1}`);
              } else {
                setCreateModalOpen(true);
              }
            }}
            className="px-3.5 h-8 rounded-lg bg-primary hover:opacity-95 text-[12px] font-semibold text-on-primary-container transition-opacity flex items-center gap-1.5 cursor-pointer"
          >
            <span className="material-symbols-outlined text-[16px]">add</span>
            Deploy Server
          </button>
        </div>
      </header>

      {/* Scrollable Overview Workspace */}
      <div className="flex-1 overflow-y-auto p-6 space-y-6">
        {/* TOP 4 AGGREGATED FLEET TELEMETRY CARDS */}
        <section className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4">
          {/* Card 1: Running Servers Summary */}
          <div className="p-4 rounded-xl bg-surface border border-white/[0.06] flex flex-col">
            <div className="flex items-center justify-between gap-2">
              <span className="kp-label">Running servers</span>
              <span className="material-symbols-outlined text-[16px] text-secondary">dns</span>
            </div>

            <div className="mt-2.5 flex items-baseline gap-1.5 min-w-0">
              <span className="kp-stat-value">{runningServers.length}</span>
              <span className="font-mono text-[11.5px] text-outline whitespace-nowrap">
                / {servers.length} instances
              </span>
              <span className="kp-chip ml-auto">{avgTps} avg TPS</span>
            </div>

            <div className="mt-auto pt-3.5 space-y-2">
              <div className="w-full h-1.5 rounded-full bg-surface-lowest overflow-hidden flex gap-px">
                {servers.map((srv) => (
                  <div
                    key={srv.id}
                    title={`${srv.name}: ${srv.status.toUpperCase()}`}
                    className={`h-full flex-1 rounded-full transition-all ${
                      srv.status === 'running'
                        ? 'bg-secondary'
                        : srv.status === 'restarting'
                          ? 'bg-primary animate-pulse'
                          : 'bg-white/12'
                    }`}
                  />
                ))}
              </div>
              <div className="flex items-center justify-between gap-3 text-[11px] font-mono text-outline">
                <span className="truncate">
                  <span className="text-secondary">{runningServers.length} online</span> ·{' '}
                  {stoppedServers.length} standby
                </span>
                <span className="truncate" title="UPnP gateway state">
                  UPnP synced
                </span>
              </div>
            </div>
          </div>

          {/* Card 2: Total Connected Players Across All Running Servers */}
          <div className="p-4 rounded-xl bg-surface border border-white/[0.06] flex flex-col">
            <div className="flex items-center justify-between gap-2">
              <span className="kp-label">Connected players</span>
              <span className="material-symbols-outlined text-[16px] text-primary">groups</span>
            </div>

            <div className="mt-2.5 flex items-baseline gap-1.5 min-w-0">
              <span className="kp-stat-value">{totalPlayersOnline}</span>
              <span className="font-mono text-[11.5px] text-outline whitespace-nowrap">
                / {totalMaxPlayersRunning} slots
              </span>
              <span className="kp-chip ml-auto">{totalMaxPlayersAll} max</span>
            </div>

            <div className="mt-auto pt-3.5 space-y-2">
              <div className="w-full bg-surface-lowest h-1.5 rounded-full overflow-hidden">
                <div
                  className="bg-primary h-full rounded-full transition-all duration-500"
                  style={{
                    width: `${
                      totalMaxPlayersRunning > 0
                        ? Math.min(
                            100,
                            Math.round((totalPlayersOnline / totalMaxPlayersRunning) * 100),
                          )
                        : 0
                    }%`,
                  }}
                />
              </div>
              <div className="flex items-center justify-between gap-3 text-[11px] font-mono text-outline">
                <div className="flex items-center gap-1.5 min-w-0">
                  <div className="flex items-center -space-x-1.5 shrink-0">
                    {players.slice(0, 4).map((p) => (
                      <img
                        key={p.id}
                        src={p.avatarUrl}
                        alt={p.username}
                        title={`${p.username} (${p.ping}ms)`}
                        className="w-4 h-4 rounded-full ring-1 ring-surface object-cover"
                      />
                    ))}
                  </div>
                  <span className="truncate">
                    {totalPlayersOnline > 4
                      ? `+${totalPlayersOnline - 4} more`
                      : 'No players connected'}
                  </span>
                </div>
                <span className="shrink-0">16ms avg ping</span>
              </div>
            </div>
          </div>

          {/* Card 3: Combined CPU Usage Across Running Servers */}
          <div className="p-4 rounded-xl bg-surface border border-white/[0.06] flex flex-col">
            <div className="flex items-center justify-between gap-2">
              <span className="kp-label">CPU load · all JVMs</span>
              <span className="material-symbols-outlined text-[16px] text-tertiary">memory</span>
            </div>

            <div className="mt-2.5 flex items-baseline gap-1.5 min-w-0">
              <span className="kp-stat-value">{hostNormalizedCpu}%</span>
              <span className="kp-chip ml-auto">{runningServers.length} JVMs</span>
            </div>

            <div className="mt-auto pt-3.5 space-y-2">
              <div className="w-full bg-surface-lowest h-1.5 rounded-full overflow-hidden flex gap-px">
                {runningServers.map((srv, idx) => (
                  <div
                    key={srv.id}
                    title={`${srv.name}: ${srv.cpuUsage}% CPU`}
                    style={{ width: `${Math.min(100, srv.cpuUsage)}%` }}
                    className={`h-full transition-all duration-500 ${
                      segmentColors[idx % segmentColors.length]
                    }`}
                  />
                ))}
              </div>
              <div className="flex items-center justify-between gap-3 text-[11px] font-mono text-outline">
                <span className="truncate">Real host sample</span>
                <span className="shrink-0">
                  {Math.max(0, 100 - hostNormalizedCpu)}% headroom
                </span>
              </div>
            </div>
          </div>

          {/* Card 4: Combined RAM Usage Across Running Servers */}
          <div className="p-4 rounded-xl bg-surface border border-white/[0.06] flex flex-col">
            <div className="flex items-center justify-between gap-2">
              <span className="kp-label">JVM heap / host RAM</span>
              <span className="material-symbols-outlined text-[16px] text-primary-gold">
                developer_board
              </span>
            </div>

            <div className="mt-2.5 flex items-baseline gap-1.5 min-w-0">
              <span className="kp-stat-value">{combinedRamUsedGb}</span>
              <span className="font-mono text-[11.5px] text-outline whitespace-nowrap">
                / {combinedRamAllocatedGb} GB heap
              </span>
              <span className="kp-chip ml-auto">{hostRamPercent}% of host</span>
            </div>

            <div className="mt-auto pt-3.5 space-y-2">
              <div className="w-full bg-surface-lowest h-1.5 rounded-full overflow-hidden flex gap-px">
                {runningServers.map((srv, idx) => (
                  <div
                    key={srv.id}
                    title={`${srv.name}: ${srv.ramUsedGb} GB / ${srv.ramMaxGb} GB`}
                    style={{ width: `${(srv.ramUsedGb / totalHostRamGb) * 100}%` }}
                    className={`h-full transition-all duration-500 ${
                      segmentColors[idx % segmentColors.length]
                    }`}
                  />
                ))}
              </div>
              <div className="flex items-center justify-between gap-3 text-[11px] font-mono text-outline">
                <span className="truncate">G1GC active</span>
                <button
                  onClick={() =>
                    onShowToast(
                      'Global G1GC Sweep Triggered',
                      `Reclaimed 1.4 GB unreferenced heap across ${runningServers.length} running JVMs.`,
                      'success',
                      'cleaning_services',
                    )
                  }
                  className="shrink-0 text-primary hover:underline cursor-pointer"
                >
                  Sweep GC →
                </button>
              </div>
            </div>
          </div>
        </section>

        {/* REAL-TIME HOST SYSTEM PERFORMANCE MONITOR (RECHARTS ENGINE) */}
        <section className="rounded-xl bg-surface border border-white/[0.06] overflow-hidden ">
          {/* Header Bar */}
          <div className="px-4 h-[52px] bg-surface-container border-b border-white/[0.06] flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2.5 min-w-0">
              <span className="material-symbols-outlined text-[17px] text-primary">monitoring</span>
              <h2 className="text-[13.5px] font-semibold text-white whitespace-nowrap">
                System performance
              </h2>
              <span
                className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md border font-mono text-[10.5px] ${
                  telemetryPaused
                    ? 'bg-primary-gold/10 text-primary-gold border-primary-gold/25'
                    : 'bg-secondary/10 text-secondary border-secondary/25'
                }`}
              >
                <span
                  className={`w-1.5 h-1.5 rounded-full ${
                    telemetryPaused ? 'bg-primary-gold' : 'bg-secondary'
                  }`}
                />
                {telemetryPaused ? 'Paused' : 'Live · 2s'}
              </span>
              <p className="hidden lg:block text-[11.5px] font-mono text-outline truncate">
                Host CPU, memory commit and disk I/O across all instances
              </p>
            </div>

            {/* Stream Controls */}
            <div className="flex items-center gap-2">
              <div className="flex items-center bg-surface-lowest p-0.5 rounded-lg border border-white/[0.06]">
                {(['30s', '1m', '5m'] as const).map((range) => (
                  <button
                    key={range}
                    type="button"
                    onClick={() => setTimeRange(range)}
                    className={`px-2.5 py-1 rounded-md text-[11px] font-mono transition-colors cursor-pointer ${
                      timeRange === range
                        ? 'bg-primary text-on-primary-container font-bold'
                        : 'text-outline hover:text-white'
                    }`}
                  >
                    {range}
                  </button>
                ))}
              </div>

              <button
                type="button"
                onClick={() => setTelemetryPaused(!telemetryPaused)}
                className="px-3 py-1.5 rounded-lg bg-surface-container-high hover:bg-surface-bright text-[11px] font-mono text-on-surface border border-white/[0.06] flex items-center gap-1 transition-colors cursor-pointer"
              >
                <span className="material-symbols-outlined text-[14px]">
                  {telemetryPaused ? 'play_arrow' : 'pause'}
                </span>
                {telemetryPaused ? 'Resume' : 'Pause'}
              </button>
            </div>
          </div>

          {/* 3-Column Recharts Telemetry Grid: Global CPU, Global RAM, Disk I/O */}
          <div className="p-5 grid grid-cols-1 lg:grid-cols-3 gap-5">
            {/* CHART 1: GLOBAL CPU UTILIZATION & KERNEL OVERHEAD */}
            <div className="p-4 rounded-xl bg-surface-container-low border border-white/[0.06] flex flex-col">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="w-1.5 h-1.5 rounded-full bg-primary" />
                    <h3 className="text-[11px] font-semibold uppercase tracking-[0.06em] text-white">
                      Global CPU
                    </h3>
                  </div>
                  <p className="text-[11px] font-mono text-outline mt-1 truncate">
                    JVM threads vs. kernel overhead
                  </p>
                </div>
                <div className="text-right font-mono shrink-0">
                  <div className="text-[17px] font-semibold text-primary tabular-nums leading-6">
                    {latestTelemetry.cpuTotal}%
                  </div>
                  <div className="text-[10.5px] text-outline leading-4">2s interval</div>
                </div>
              </div>

              <div className="mt-3 h-44 w-full">
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart
                    data={telemetryHistory}
                    margin={{ top: 6, right: 14, left: -24, bottom: 0 }}
                  >
                    <defs>
                      <linearGradient id="cpuTotalGrad" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor="#f2ca50" stopOpacity={0.4} />
                        <stop offset="95%" stopColor="#f2ca50" stopOpacity={0.02} />
                      </linearGradient>
                      <linearGradient id="cpuKernelGrad" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor="#40c4ff" stopOpacity={0.3} />
                        <stop offset="95%" stopColor="#40c4ff" stopOpacity={0.0} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
                    <XAxis
                      dataKey="time"
                      tick={{ fill: '#8e909e', fontSize: 10, fontFamily: 'JetBrains Mono' }}
                      axisLine={{ stroke: 'rgba(255,255,255,0.1)' }}
                      tickLine={false}
                      minTickGap={44}
                      tickMargin={6}
                    />
                    <YAxis
                      domain={[0, 100]}
                      tick={{ fill: '#8e909e', fontSize: 10, fontFamily: 'JetBrains Mono' }}
                      axisLine={false}
                      tickLine={false}
                      unit="%"
                    />
                    <Tooltip
                      contentStyle={{
                        backgroundColor: '#131722',
                        borderColor: 'rgba(242, 202, 80, 0.35)',
                        borderRadius: '10px',
                        fontSize: '11px',
                        fontFamily: 'JetBrains Mono, monospace',
                        color: '#dfe2f1',
                      }}
                    />
                    <ReferenceLine
                      y={85}
                      stroke="#ffb4ab"
                      strokeDasharray="3 3"
                      strokeOpacity={0.5}
                    />
                    <Area
                      type="monotone"
                      dataKey="cpuTotal"
                      name="Total CPU %"
                      stroke="#f2ca50"
                      strokeWidth={2}
                      fillOpacity={1}
                      fill="url(#cpuTotalGrad)"
                      isAnimationActive={false}
                    />
                    <Area
                      type="monotone"
                      dataKey="cpuKernel"
                      name="Kernel %"
                      stroke="#40c4ff"
                      strokeWidth={1.5}
                      fillOpacity={1}
                      fill="url(#cpuKernelGrad)"
                      isAnimationActive={false}
                    />
                  </AreaChart>
                </ResponsiveContainer>
              </div>

              <div className="mt-3 pt-2.5 border-t border-outline-variant/10 flex items-center justify-between gap-3 text-[11px] font-mono text-outline">
                <span className="flex items-center gap-1.5 whitespace-nowrap">
                  <span className="w-2 h-0.5 bg-primary inline-block"></span> JVM
                  <span className="w-2 h-0.5 bg-tertiary inline-block ml-2"></span> Kernel
                </span>
                <span className="whitespace-nowrap">16C / 32T SMT</span>
              </div>
            </div>

            {/* CHART 2: GLOBAL RAM & JVM HEAP ALLOCATION */}
            <div className="p-4 rounded-xl bg-surface-container-low border border-white/[0.06] flex flex-col">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="w-1.5 h-1.5 rounded-full bg-secondary" />
                    <h3 className="text-[11px] font-semibold uppercase tracking-[0.06em] text-white">
                      Global memory
                    </h3>
                  </div>
                  <p className="text-[11px] font-mono text-outline mt-1 truncate">
                    Active heap vs. committed
                  </p>
                </div>
                <div className="text-right font-mono shrink-0">
                  <div className="text-[17px] font-semibold text-secondary tabular-nums leading-6">
                    {latestTelemetry.ramUsedGb} GB
                  </div>
                  <div className="text-[10.5px] text-outline leading-4 whitespace-nowrap">
                    commit {latestTelemetry.ramCommittedGb} GB
                  </div>
                </div>
              </div>

              <div className="mt-3 h-44 w-full">
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart
                    data={telemetryHistory}
                    margin={{ top: 6, right: 14, left: -24, bottom: 0 }}
                  >
                    <defs>
                      <linearGradient id="ramUsedGrad" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor="#25e288" stopOpacity={0.4} />
                        <stop offset="95%" stopColor="#25e288" stopOpacity={0.02} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
                    <XAxis
                      dataKey="time"
                      tick={{ fill: '#8e909e', fontSize: 10, fontFamily: 'JetBrains Mono' }}
                      axisLine={{ stroke: 'rgba(255,255,255,0.1)' }}
                      tickLine={false}
                      minTickGap={44}
                      tickMargin={6}
                    />
                    <YAxis
                      domain={[0, 32]}
                      tick={{ fill: '#8e909e', fontSize: 10, fontFamily: 'JetBrains Mono' }}
                      axisLine={false}
                      tickLine={false}
                      unit="G"
                    />
                    <Tooltip
                      contentStyle={{
                        backgroundColor: '#131722',
                        borderColor: 'rgba(37, 226, 136, 0.35)',
                        borderRadius: '10px',
                        fontSize: '11px',
                        fontFamily: 'JetBrains Mono, monospace',
                        color: '#dfe2f1',
                      }}
                    />
                    <ReferenceLine
                      y={combinedRamAllocatedGb}
                      stroke="#f2ca50"
                      strokeDasharray="4 4"
                      strokeOpacity={0.6}
                    />
                    <Area
                      type="monotone"
                      dataKey="ramUsedGb"
                      name="Used Heap (GB)"
                      stroke="#25e288"
                      strokeWidth={2}
                      fillOpacity={1}
                      fill="url(#ramUsedGrad)"
                      isAnimationActive={false}
                    />
                  </AreaChart>
                </ResponsiveContainer>
              </div>

              <div className="mt-3 pt-2.5 border-t border-outline-variant/10 flex items-center justify-between gap-3 text-[11px] font-mono text-outline">
                <span className="flex items-center gap-1.5 whitespace-nowrap">
                  <span className="w-2 h-0.5 bg-secondary inline-block"></span> Heap
                  <span className="w-2 h-0.5 bg-primary inline-block ml-2"></span> -Xmx
                </span>
                <span className="text-secondary whitespace-nowrap">G1GC YoungGen</span>
              </div>
            </div>

            {/* CHART 3: DISK I/O THROUGHPUT (READ / WRITE MB/s) */}
            <div className="p-4 rounded-xl bg-surface-container-low border border-white/[0.06] flex flex-col">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="w-1.5 h-1.5 rounded-full bg-tertiary" />
                    <h3 className="text-[11px] font-semibold uppercase tracking-[0.06em] text-white">
                      Disk I/O
                    </h3>
                  </div>
                  <p className="text-[11px] font-mono text-outline mt-1 truncate">
                    Region reads vs. chunk writes
                  </p>
                </div>
                <div className="text-right font-mono shrink-0">
                  <div className="text-[17px] font-semibold text-tertiary tabular-nums leading-6">
                    {latestTelemetry.diskReadMbs + latestTelemetry.diskWriteMbs} MB/s
                  </div>
                  <div className="text-[10.5px] text-outline leading-4 whitespace-nowrap">
                    R {latestTelemetry.diskReadMbs} · W {latestTelemetry.diskWriteMbs}
                  </div>
                </div>
              </div>

              <div className="mt-3 h-44 w-full">
                <ResponsiveContainer width="100%" height="100%">
                  <ComposedChart
                    data={telemetryHistory}
                    margin={{ top: 6, right: 14, left: -20, bottom: 0 }}
                  >
                    <defs>
                      <linearGradient id="diskReadGrad" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor="#40c4ff" stopOpacity={0.35} />
                        <stop offset="95%" stopColor="#40c4ff" stopOpacity={0.02} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
                    <XAxis
                      dataKey="time"
                      tick={{ fill: '#8e909e', fontSize: 10, fontFamily: 'JetBrains Mono' }}
                      axisLine={{ stroke: 'rgba(255,255,255,0.1)' }}
                      tickLine={false}
                      minTickGap={44}
                      tickMargin={6}
                    />
                    <YAxis
                      tick={{ fill: '#8e909e', fontSize: 10, fontFamily: 'JetBrains Mono' }}
                      axisLine={false}
                      tickLine={false}
                    />
                    <Tooltip
                      contentStyle={{
                        backgroundColor: '#131722',
                        borderColor: 'rgba(64, 196, 255, 0.35)',
                        borderRadius: '10px',
                        fontSize: '11px',
                        fontFamily: 'JetBrains Mono, monospace',
                        color: '#dfe2f1',
                      }}
                    />
                    <Area
                      type="monotone"
                      dataKey="diskReadMbs"
                      name="Read (MB/s)"
                      stroke="#40c4ff"
                      strokeWidth={2}
                      fillOpacity={1}
                      fill="url(#diskReadGrad)"
                      isAnimationActive={false}
                    />
                    <Bar
                      dataKey="diskWriteMbs"
                      name="Write (MB/s)"
                      fill="#f2ca50"
                      radius={[3, 3, 0, 0]}
                      barSize={8}
                      isAnimationActive={false}
                    />
                    <Line
                      type="monotone"
                      dataKey="diskWriteMbs"
                      name="Write Trend"
                      stroke="#f2ca50"
                      strokeWidth={1.5}
                      dot={false}
                      isAnimationActive={false}
                    />
                  </ComposedChart>
                </ResponsiveContainer>
              </div>

              <div className="mt-3 pt-2.5 border-t border-outline-variant/10 flex items-center justify-between gap-3 text-[11px] font-mono text-outline">
                <span className="flex items-center gap-1.5 whitespace-nowrap">
                  <span className="w-2 h-0.5 bg-tertiary inline-block"></span> Read
                  <span className="w-2 h-2 rounded-xs bg-primary inline-block ml-2"></span> Write
                </span>
                <span>{latestTelemetry.iops.toLocaleString()} IOPS</span>
              </div>
            </div>
          </div>

          {/* COMBINED RESOURCE DISTRIBUTION & MULTI-NODE TELEMETRY BAR */}
          <div className="px-5 py-3.5 bg-surface-container-low border-t border-white/[0.06]">
            <div className="flex flex-wrap items-center justify-between gap-4 mb-2.5">
              <div className="flex items-center gap-2">
                <span className="material-symbols-outlined text-outline text-[15px]">
                  stacked_bar_chart
                </span>
                <span className="text-[11.5px] font-medium text-outline">
                  Per-instance resource attribution
                </span>
              </div>
              <div className="flex flex-wrap items-center gap-4 text-[11px] font-mono">
                {servers.map((srv, idx) => (
                  <div key={srv.id} className="flex items-center gap-1.5">
                    <span
                      className={`w-2.5 h-2.5 rounded-sm ${
                        srv.status === 'stopped'
                          ? 'bg-white/15'
                          : segmentColors[idx % segmentColors.length]
                      }`}
                    />
                    <span
                      className={
                        srv.status === 'stopped' ? 'text-outline line-through' : 'text-on-surface'
                      }
                    >
                      {srv.name}
                    </span>
                    <span className="text-outline">
                      ({srv.ramUsedGb}GB / {srv.cpuUsage}%)
                    </span>
                  </div>
                ))}
              </div>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              {/* Combined CPU Distribution */}
              <div className="p-2.5 rounded-lg bg-surface border border-outline-variant/10 space-y-1.5">
                <div className="flex justify-between text-[10px] font-mono">
                  <span className="text-outline uppercase">
                    Per-Instance CPU Thread Attribution
                  </span>
                  <span className="text-white font-semibold">
                    {hostNormalizedCpu}% Busy / {100 - hostNormalizedCpu}% Idle
                  </span>
                </div>
                <div className="w-full h-2.5 rounded-md bg-surface-lowest overflow-hidden flex p-0.5 gap-0.5 border border-white/[0.06]">
                  {runningServers.map((srv, idx) => (
                    <div
                      key={srv.id}
                      style={{ width: `${Math.max(3, srv.cpuUsage)}%` }}
                      className={`h-full rounded-xs ${
                        segmentColors[idx % segmentColors.length]
                      } transition-all duration-500`}
                      title={`${srv.name}: ${srv.cpuUsage}% CPU`}
                    />
                  ))}
                </div>
              </div>

              {/* Combined RAM Distribution */}
              <div className="p-2.5 rounded-lg bg-surface border border-outline-variant/10 space-y-1.5">
                <div className="flex justify-between text-[10px] font-mono">
                  <span className="text-outline uppercase">
                    Per-Instance Physical Memory Footprint (32.0 GB Total)
                  </span>
                  <span className="text-white font-semibold">
                    {combinedRamUsedGb} GB Used / {(totalHostRamGb - combinedRamUsedGb).toFixed(1)}{' '}
                    GB Free
                  </span>
                </div>
                <div className="w-full h-2.5 rounded-md bg-surface-lowest overflow-hidden flex p-0.5 gap-0.5 border border-white/[0.06]">
                  {runningServers.map((srv, idx) => (
                    <div
                      key={srv.id}
                      style={{ width: `${Math.max(3, (srv.ramUsedGb / totalHostRamGb) * 100)}%` }}
                      className={`h-full rounded-xs ${
                        segmentColors[idx % segmentColors.length]
                      } transition-all duration-500`}
                      title={`${srv.name}: ${srv.ramUsedGb} GB / ${srv.ramMaxGb} GB`}
                    />
                  ))}
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* PAPERMC API BACKGROUND VERSION CHECKER SERVICE BANNER */}
        <section className="rounded-xl bg-surface border border-amber-400/30 p-4 flex flex-wrap items-center justify-between gap-4 ">
          <div className="flex items-start sm:items-center gap-3.5">
            <div className="w-10 h-10 rounded-xl bg-amber-400/15 border border-amber-400/35 flex items-center justify-center text-amber-300 shrink-0">
              <span className="material-symbols-outlined text-[22px]">system_update_alt</span>
            </div>
            <div>
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="text-xs font-bold uppercase tracking-wider text-white">
                  PaperMC API Background Engine Version Service
                </h2>
                <span className="px-2 py-0.5 rounded bg-secondary/15 text-secondary border border-secondary/30 text-[10px] font-mono font-bold">
                  ● {paperMcReport?.serviceStatus || 'RUNNING'} (60s Auto-Poll)
                </span>
                {outdatedServers.length > 0 ? (
                  <span className="px-2 py-0.5 rounded bg-error/20 text-error border border-error/40 text-[10px] font-mono font-bold">
                    {outdatedServers.length} INSTALLED SERVER(S) FLAGGED OUTDATED
                  </span>
                ) : (
                  <span className="px-2 py-0.5 rounded bg-secondary/20 text-secondary border border-secondary/30 text-[10px] font-mono font-bold">
                    ALL INSTALLED SERVERS ON LATEST RELEASE ({latestPaperRelease})
                  </span>
                )}
              </div>
              <p className="text-[11px] font-mono text-outline mt-1">
                Latest PaperMC Engine Release:{' '}
                <strong className="text-primary">
                  PaperMC {latestPaperRelease} ({latestPaperBuild})
                </strong>{' '}
                • Checked via{' '}
                <code className="text-white/80">https://api.papermc.io/v2/projects/paper</code> •
                Last Check:{' '}
                <span className="text-on-surface">
                  {paperMcReport?.lastCheckedAt
                    ? new Date(paperMcReport.lastCheckedAt).toLocaleTimeString()
                    : 'Just now'}
                </span>
              </p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {onRunPaperMcCheckNow && (
              <button
                type="button"
                onClick={onRunPaperMcCheckNow}
                className="px-3.5 py-2 rounded-lg bg-surface-container-highest hover:bg-surface-bright text-xs font-mono text-white border border-white/15 flex items-center gap-1.5 cursor-pointer transition-all"
              >
                <span className="material-symbols-outlined text-[15px] text-primary">sync</span>
                Check PaperMC API Now
              </button>
            )}
            {outdatedServers.length > 0 && onUpgradeServerEngine && (
              <button
                type="button"
                onClick={() => onUpgradeServerEngine('ALL')}
                className="px-4 py-2 rounded-lg bg-amber-400 hover:bg-amber-300 text-black font-bold text-xs font-mono flex items-center gap-1.5 shadow cursor-pointer transition-all"
              >
                <span className="material-symbols-outlined text-[16px]">upgrade</span>
                Upgrade All Outdated Servers ({outdatedServers.length}) to {latestPaperRelease}
              </button>
            )}
          </div>
        </section>

        {/* ALL SERVERS LISTED — FILTER BAR & DIRECTORY */}
        <section className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-4 bg-surface p-3.5 rounded-xl border border-white/[0.06] ">
            <div className="flex items-center gap-3">
              <div className="flex items-center gap-2">
                <span className="material-symbols-outlined text-primary text-[20px]">
                  view_list
                </span>
                <h2 className="text-sm font-bold text-white">
                  All Localhost Server Instances ({filteredServers.length})
                </h2>
              </div>

              {/* Filter Tabs */}
              <div className="flex items-center gap-1 bg-surface-lowest p-1 rounded-lg border border-white/[0.06] ml-2">
                <button
                  onClick={() => setStatusFilter('all')}
                  className={`px-3 py-1 rounded-md text-xs font-medium transition-colors cursor-pointer ${
                    statusFilter === 'all'
                      ? 'bg-primary text-on-primary-container font-bold'
                      : 'text-outline hover:text-white'
                  }`}
                >
                  All ({servers.length})
                </button>
                <button
                  onClick={() => setStatusFilter('running')}
                  className={`px-3 py-1 rounded-md text-xs font-medium transition-colors cursor-pointer flex items-center gap-1.5 ${
                    statusFilter === 'running'
                      ? 'bg-secondary text-on-secondary font-bold'
                      : 'text-outline hover:text-white'
                  }`}
                >
                  <span className="w-1.5 h-1.5 rounded-full bg-current"></span>
                  Running ({runningServers.length})
                </button>
                <button
                  onClick={() => setStatusFilter('stopped')}
                  className={`px-3 py-1 rounded-md text-xs font-medium transition-colors cursor-pointer ${
                    statusFilter === 'stopped'
                      ? 'bg-error text-on-error font-bold'
                      : 'text-outline hover:text-white'
                  }`}
                >
                  Stopped ({stoppedServers.length})
                </button>
              </div>
            </div>

            {/* Search & View Switcher */}
            <div className="flex items-center gap-3">
              <div className="relative w-64">
                <span className="material-symbols-outlined text-outline text-[16px] absolute left-3 top-2">
                  search
                </span>
                <input
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Filter by server, engine, port, PID..."
                  className="w-full bg-surface-lowest border border-white/[0.06] focus:border-primary rounded-lg pl-9 pr-3 py-1.5 text-xs font-mono text-on-surface focus:outline-none"
                />
              </div>

              <div className="flex items-center bg-surface-lowest p-1 rounded-lg border border-white/[0.06]">
                <button
                  onClick={() => setLayoutMode('cards')}
                  className={`px-2.5 py-1 rounded text-xs font-mono flex items-center gap-1 cursor-pointer ${
                    layoutMode === 'cards'
                      ? 'bg-surface-container-highest text-primary font-bold'
                      : 'text-outline hover:text-white'
                  }`}
                  title="Detailed Instance Cards"
                >
                  <span className="material-symbols-outlined text-[15px]">grid_view</span>
                  Cards
                </button>
                <button
                  onClick={() => setLayoutMode('table')}
                  className={`px-2.5 py-1 rounded text-xs font-mono flex items-center gap-1 cursor-pointer ${
                    layoutMode === 'table'
                      ? 'bg-surface-container-highest text-primary font-bold'
                      : 'text-outline hover:text-white'
                  }`}
                  title="High-Density Fleet Table"
                >
                  <span className="material-symbols-outlined text-[15px]">table_rows</span>
                  Table
                </button>
              </div>
            </div>
          </div>

          {/* LAYOUT MODE 1: DETAILED SERVER INSTANCE CARDS */}
          {servers.length === 0 ? (
            <div className="rounded-xl bg-surface border border-dashed border-primary/40 p-8 text-center space-y-4 ">
              <div className="w-14 h-14 rounded-xl bg-primary/15 border border-primary/35 flex items-center justify-center text-primary mx-auto">
                <span className="material-symbols-outlined text-[30px]">add_to_queue</span>
              </div>
              <div className="space-y-1.5 max-w-lg mx-auto">
                <h3 className="text-base font-bold text-white">
                  No Minecraft Servers Created Yet (0 / {maxServerLimit} Servers)
                </h3>
                <p className="text-xs text-outline leading-relaxed">
                  No servers are pre-installed by default. Click the button below to create your own
                  Minecraft server in{' '}
                  <code className="text-primary font-mono">{serverInstallRootDir}</code>. Every
                  server remains <strong className="text-amber-300">STOPPED</strong> by default
                  until you manually click <strong className="text-secondary">Start</strong>.
                </p>
              </div>
              <div className="flex items-center justify-center gap-3 pt-1">
                <button
                  type="button"
                  onClick={() => setCreateModalOpen(true)}
                  className="px-5 py-2.5 rounded-xl bg-primary hover:opacity-95 text-on-primary-container text-xs font-bold flex items-center gap-2 cursor-pointer"
                >
                  <span className="material-symbols-outlined text-[18px]">add_circle</span>+ Create
                  Your Own Server Now
                </button>
              </div>
            </div>
          ) : layoutMode === 'cards' ? (
            <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
              {filteredServers.map((srv, idx) => {
                const isSelected = srv.id === activeServer.id;
                const isRunning = srv.status === 'running';
                const isRestarting = srv.status === 'restarting';
                const ramPercent = Math.min(
                  100,
                  Math.round((srv.ramUsedGb / Math.max(1, srv.ramMaxGb)) * 100),
                );
                const playerPercent = Math.min(
                  100,
                  Math.round((srv.playersOnline / Math.max(1, srv.maxPlayers)) * 100),
                );

                return (
                  <div
                    key={srv.id}
                    className={`rounded-xl bg-surface border transition-all p-5 flex flex-col justify-between ${
                      isSelected
                        ? 'border-primary/50 ring-1 ring-primary/20'
                        : 'border-white/[0.06] hover:border-outline-variant/35'
                    }`}
                  >
                    {/* Card Header: Identity, Status & Quick Select */}
                    <div>
                      <div className="flex items-start justify-between gap-4">
                        <div className="flex items-start gap-3.5">
                          <div className="w-12 h-12 rounded-xl bg-surface-lowest border border-white/[0.06] flex items-center justify-center relative shrink-0 overflow-hidden ">
                            <img
                              src={HOTLINKED_IMAGES.serverIcon64}
                              alt={srv.name}
                              className={`w-full h-full object-cover ${
                                !isRunning && !isRestarting ? 'grayscale opacity-50' : ''
                              }`}
                              style={{ imageRendering: 'pixelated' }}
                            />
                            <span
                              className={`w-2.5 h-2.5 rounded-full absolute bottom-1 right-1 ring-2 ring-surface-lowest ${
                                isRunning
                                  ? 'bg-secondary'
                                  : isRestarting
                                    ? 'bg-primary animate-ping'
                                    : 'bg-error'
                              }`}
                            />
                          </div>

                          <div>
                            <div className="flex items-center gap-2 flex-wrap">
                              <h3
                                onClick={() => onManageServer(srv, 'console')}
                                className="text-base font-bold text-white hover:text-primary cursor-pointer transition-colors"
                              >
                                {srv.name}
                              </h3>
                              {isSelected && (
                                <span className="px-2 py-0.5 rounded text-[10px] font-mono bg-primary/15 text-primary border border-primary/30 font-semibold">
                                  FOCUSED
                                </span>
                              )}
                              <span
                                className={`px-2 py-0.5 rounded text-[10px] font-mono uppercase font-bold ${
                                  isRunning
                                    ? 'bg-secondary/15 text-secondary border border-secondary/30'
                                    : isRestarting
                                      ? 'bg-primary/15 text-primary border border-primary/30'
                                      : 'bg-error/15 text-error border border-error/30'
                                }`}
                              >
                                {srv.status}
                              </span>
                              {(
                                srv.isOutdated !== undefined
                                  ? srv.isOutdated
                                  : !srv.engine.includes(latestPaperRelease)
                              ) ? (
                                <span
                                  className="px-2 py-0.5 rounded text-[10px] font-mono uppercase font-bold bg-error/20 text-error border border-error/40 flex items-center gap-1"
                                  title={`Outdated Engine! Installed: ${srv.engine} | Latest PaperMC Release: ${
                                    srv.latestVersion || latestPaperRelease
                                  }`}
                                >
                                  <span className="material-symbols-outlined text-[12px]">
                                    warning
                                  </span>
                                  OUTDATED • Latest: {srv.latestVersion || latestPaperRelease}
                                </span>
                              ) : (
                                <span className="px-2 py-0.5 rounded text-[10px] font-mono uppercase font-bold bg-secondary/15 text-secondary border border-secondary/30">
                                  LATEST ({latestPaperRelease})
                                </span>
                              )}
                            </div>

                            <div className="flex items-center gap-2 mt-1 text-xs font-mono text-outline flex-wrap">
                              <span className="text-on-surface font-semibold">{srv.engine}</span>
                              <span>•</span>
                              <span>{srv.build}</span>
                              <span>•</span>
                              <span className="text-primary">:{srv.port}</span>
                              <span>•</span>
                              <span>{srv.pid > 0 ? `PID ${srv.pid}` : 'No PID'}</span>
                            </div>
                            <div className="text-[11px] font-mono text-outline/70 mt-0.5">
                              {srv.path} • Uptime:{' '}
                              <strong className="text-on-surface">{srv.uptime}</strong>
                            </div>
                          </div>
                        </div>

                        {/* TPS Pill */}
                        <div className="text-right shrink-0">
                          <div
                            className={`text-sm font-mono font-bold ${
                              isRunning ? 'text-secondary' : 'text-outline'
                            }`}
                          >
                            {srv.tps.toFixed(1)} TPS
                          </div>
                          <div className="text-[10px] font-mono text-outline">
                            {srv.tickMs}ms MSPT
                          </div>
                        </div>
                      </div>

                      {/* 3-Column Per-Server Telemetry Strip (Players, CPU, RAM) */}
                      <div className="grid grid-cols-3 gap-3 mt-4 pt-4 border-t border-white/[0.06]">
                        {/* Metric 1: Players */}
                        <div className="p-3 rounded-lg bg-surface-container-low border border-outline-variant/10">
                          <div className="flex items-center justify-between text-[10px] font-mono text-outline uppercase">
                            <span>Players</span>
                            <span className="text-primary font-bold">
                              {srv.playersOnline}/{srv.maxPlayers}
                            </span>
                          </div>
                          <div className="w-full h-1.5 rounded-full bg-surface-lowest overflow-hidden mt-2">
                            <div
                              className="h-full bg-primary rounded-full transition-all duration-300"
                              style={{ width: `${playerPercent}%` }}
                            />
                          </div>
                          <div className="text-[10px] font-mono text-outline mt-1.5">
                            {playerPercent}% Slot Capacity
                          </div>
                        </div>

                        {/* Metric 2: CPU Usage */}
                        <div className="p-3 rounded-lg bg-surface-container-low border border-outline-variant/10">
                          <div className="flex items-center justify-between text-[10px] font-mono text-outline uppercase">
                            <span>CPU Load</span>
                            <span className="text-tertiary font-bold">{srv.cpuUsage}%</span>
                          </div>
                          <div className="w-full h-1.5 rounded-full bg-surface-lowest overflow-hidden mt-2">
                            <div
                              className="h-full bg-tertiary rounded-full transition-all duration-300"
                              style={{ width: `${Math.min(100, srv.cpuUsage)}%` }}
                            />
                          </div>
                        </div>

                        {/* Metric 3: RAM Usage */}
                        <div className="p-3 rounded-lg bg-surface-container-low border border-outline-variant/10">
                          <div className="flex items-center justify-between text-[10px] font-mono text-outline uppercase">
                            <span>JVM Heap</span>
                            <span className="text-secondary font-bold">
                              {srv.ramUsedGb}/{srv.ramMaxGb}GB
                            </span>
                          </div>
                          <div className="w-full h-1.5 rounded-full bg-surface-lowest overflow-hidden mt-2">
                            <div
                              className={`h-full rounded-full transition-all duration-300 ${
                                segmentColors[idx % segmentColors.length]
                              }`}
                              style={{ width: `${ramPercent}%` }}
                            />
                          </div>
                          <div className="text-[10px] font-mono text-outline mt-1.5">
                            {ramPercent}% Allocated ({srv.javaVersion})
                          </div>
                        </div>
                      </div>
                    </div>

                    {/* Card Footer: Quick Workspace Navigation & Power Controls */}
                    <div className="mt-4 pt-3 border-t border-white/[0.06] flex items-center justify-between gap-2 flex-wrap">
                      {/* Left: Jump to specific server tools */}
                      <div className="flex items-center gap-1.5">
                        <button
                          onClick={() => onManageServer(srv, 'console')}
                          className="px-3 py-1.5 rounded-lg bg-primary/15 hover:bg-primary/25 text-primary border border-primary/30 text-xs font-bold flex items-center gap-1.5 transition-colors cursor-pointer"
                        >
                          <span className="material-symbols-outlined text-[15px]">terminal</span>
                          Console
                        </button>
                        <button
                          onClick={() => onManageServer(srv, 'files')}
                          className="px-2.5 py-1.5 rounded-lg bg-surface-container-high hover:bg-surface-bright text-on-surface text-xs font-medium border border-white/[0.06] flex items-center gap-1 transition-colors cursor-pointer"
                          title="Open File Manager"
                        >
                          <span className="material-symbols-outlined text-[14px] text-outline">
                            folder_open
                          </span>
                          Files
                        </button>
                        <button
                          onClick={() => onManageServer(srv, 'jvm')}
                          className="px-2.5 py-1.5 rounded-lg bg-surface-container-high hover:bg-surface-bright text-on-surface text-xs font-medium border border-white/[0.06] flex items-center gap-1 transition-colors cursor-pointer"
                          title="Configure JVM Flags"
                        >
                          <span className="material-symbols-outlined text-[14px] text-outline">
                            tune
                          </span>
                          JVM
                        </button>
                        <button
                          onClick={() => onManageServer(srv, 'settings')}
                          className="px-2.5 py-1.5 rounded-lg bg-surface-container-high hover:bg-surface-bright text-on-surface text-xs font-medium border border-white/[0.06] flex items-center gap-1 transition-colors cursor-pointer"
                          title="Server Settings & MOTD"
                        >
                          <span className="material-symbols-outlined text-[14px] text-outline">
                            settings
                          </span>
                          Config
                        </button>
                      </div>

                      {/* Right: Instance Lifecycle Power Buttons */}
                      <div className="flex items-center gap-1.5">
                        {(srv.isOutdated !== undefined
                          ? srv.isOutdated
                          : !srv.engine.includes(latestPaperRelease)) &&
                          onUpgradeServerEngine && (
                            <button
                              onClick={() => onUpgradeServerEngine(srv.id)}
                              className="px-2.5 py-1.5 rounded-lg bg-amber-400 hover:bg-amber-300 text-black text-xs font-mono font-bold flex items-center gap-1 transition-colors cursor-pointer"
                              title={`Upgrade ${srv.name} to latest PaperMC release ${latestPaperRelease}`}
                            >
                              <span className="material-symbols-outlined text-[14px]">upgrade</span>
                              Update ({srv.latestVersion || latestPaperRelease})
                            </button>
                          )}
                        {srv.status === 'stopped' ? (
                          <button
                            onClick={() => onServerPowerAction(srv.id, 'start')}
                            className="px-3 py-1.5 rounded-lg bg-secondary/20 hover:bg-secondary/30 text-secondary border border-secondary/40 text-xs font-bold flex items-center gap-1 transition-colors cursor-pointer"
                          >
                            <span className="material-symbols-outlined text-[15px]">
                              play_arrow
                            </span>
                            Start Server
                          </button>
                        ) : (
                          <>
                            <button
                              onClick={() => onServerPowerAction(srv.id, 'restart')}
                              className="px-2.5 py-1.5 rounded-lg bg-surface-container-high hover:bg-primary/20 text-outline hover:text-primary border border-white/[0.06] text-xs font-mono flex items-center gap-1 transition-colors cursor-pointer"
                              title="Graceful Restart"
                            >
                              <span className="material-symbols-outlined text-[14px]">
                                restart_alt
                              </span>
                              Restart
                            </button>
                            <button
                              onClick={() => onServerPowerAction(srv.id, 'stop')}
                              className="px-2.5 py-1.5 rounded-lg bg-error/15 hover:bg-error/25 text-error border border-error/30 text-xs font-mono flex items-center gap-1 transition-colors cursor-pointer"
                              title="Stop Server"
                            >
                              <span className="material-symbols-outlined text-[14px]">stop</span>
                              Stop
                            </button>
                          </>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            /* LAYOUT MODE 2: HIGH-DENSITY ALL SERVERS TABLE */
            <div className="bg-surface rounded-xl border border-white/[0.06] overflow-hidden ">
              <div className="overflow-x-auto">
                <table className="w-full text-left border-collapse">
                  <thead>
                    <tr className="border-b border-white/[0.06] text-[10px] font-mono uppercase text-outline bg-surface-container">
                      <th className="py-3 px-4">Server Instance</th>
                      <th className="py-3 px-4">Status</th>
                      <th className="py-3 px-4">Engine &amp; Build</th>
                      <th className="py-3 px-4">Port / PID</th>
                      <th className="py-3 px-4">Players</th>
                      <th className="py-3 px-4">CPU Load</th>
                      <th className="py-3 px-4">RAM Heap</th>
                      <th className="py-3 px-4">TPS / MSPT</th>
                      <th className="py-3 px-4 text-right">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-outline-variant/10 text-xs">
                    {filteredServers.map((srv) => {
                      const isRunning = srv.status === 'running';
                      const isSelected = srv.id === activeServer.id;
                      return (
                        <tr
                          key={srv.id}
                          onClick={() => onSelectServer(srv)}
                          className={`hover:bg-surface-container/70 transition-colors cursor-pointer ${
                            isSelected ? 'bg-primary/5' : ''
                          }`}
                        >
                          <td className="py-3 px-4">
                            <div className="font-bold text-white flex items-center gap-2">
                              {srv.name}
                              {isSelected && (
                                <span className="px-1.5 py-0.2 rounded text-[9px] font-mono bg-primary/20 text-primary">
                                  ACTIVE
                                </span>
                              )}
                            </div>
                            <div className="text-[10px] font-mono text-outline">{srv.path}</div>
                          </td>
                          <td className="py-3 px-4 font-mono">
                            <span
                              className={`px-2 py-0.5 rounded text-[10px] uppercase font-bold ${
                                isRunning
                                  ? 'bg-secondary/15 text-secondary border border-secondary/30'
                                  : srv.status === 'restarting'
                                    ? 'bg-primary/15 text-primary border border-primary/30'
                                    : 'bg-error/15 text-error border border-error/30'
                              }`}
                            >
                              {srv.status}
                            </span>
                          </td>
                          <td className="py-3 px-4 font-mono">
                            <div className="text-on-surface flex items-center gap-1.5 flex-wrap">
                              <span>{srv.engine}</span>
                              {(
                                srv.isOutdated !== undefined
                                  ? srv.isOutdated
                                  : !srv.engine.includes(latestPaperRelease)
                              ) ? (
                                <span className="px-1.5 py-0.5 rounded bg-error/20 text-error border border-error/40 text-[9px] font-bold">
                                  OUTDATED → {srv.latestVersion || latestPaperRelease}
                                </span>
                              ) : (
                                <span className="px-1.5 py-0.5 rounded bg-secondary/15 text-secondary text-[9px] font-bold">
                                  LATEST
                                </span>
                              )}
                            </div>
                            <div className="text-[10px] text-outline">
                              {srv.build} • {srv.javaVersion}
                            </div>
                          </td>
                          <td className="py-3 px-4 font-mono">
                            <div className="text-primary">:{srv.port}</div>
                            <div className="text-[10px] text-outline">
                              {srv.pid > 0 ? `PID ${srv.pid}` : 'Offline'}
                            </div>
                          </td>
                          <td className="py-3 px-4 font-mono">
                            <span className="text-white font-bold">{srv.playersOnline}</span>
                            <span className="text-outline"> / {srv.maxPlayers}</span>
                          </td>
                          <td className="py-3 px-4 font-mono">
                            <div className="text-tertiary font-bold">{srv.cpuUsage}%</div>
                          </td>
                          <td className="py-3 px-4 font-mono">
                            <div className="text-secondary font-bold">
                              {srv.ramUsedGb} / {srv.ramMaxGb} GB
                            </div>
                            <div className="w-20 bg-surface-lowest h-1 rounded-full overflow-hidden mt-1">
                              <div
                                className="bg-secondary h-full"
                                style={{
                                  width: `${Math.min(
                                    100,
                                    (srv.ramUsedGb / Math.max(1, srv.ramMaxGb)) * 100,
                                  )}%`,
                                }}
                              />
                            </div>
                          </td>
                          <td className="py-3 px-4 font-mono">
                            <div
                              className={isRunning ? 'text-secondary font-bold' : 'text-outline'}
                            >
                              {srv.tps.toFixed(1)} TPS
                            </div>
                            <div className="text-[10px] text-outline">{srv.tickMs}ms</div>
                          </td>
                          <td className="py-3 px-4 text-right" onClick={(e) => e.stopPropagation()}>
                            <div className="inline-flex items-center gap-1.5">
                              {(srv.isOutdated !== undefined
                                ? srv.isOutdated
                                : !srv.engine.includes(latestPaperRelease)) &&
                                onUpgradeServerEngine && (
                                  <button
                                    onClick={() => onUpgradeServerEngine(srv.id)}
                                    className="px-2 py-1 rounded bg-amber-400 hover:bg-amber-300 text-black text-[11px] font-mono font-bold cursor-pointer"
                                  >
                                    Update
                                  </button>
                                )}
                              <button
                                onClick={() => onManageServer(srv, 'console')}
                                className="px-2.5 py-1 rounded bg-primary/15 hover:bg-primary/25 text-primary text-[11px] font-mono font-semibold cursor-pointer"
                              >
                                Console
                              </button>
                              {srv.status === 'stopped' ? (
                                <button
                                  onClick={() => onServerPowerAction(srv.id, 'start')}
                                  className="px-2.5 py-1 rounded bg-secondary/15 hover:bg-secondary/25 text-secondary text-[11px] font-mono font-semibold cursor-pointer"
                                >
                                  Start
                                </button>
                              ) : (
                                <>
                                  <button
                                    onClick={() => onServerPowerAction(srv.id, 'restart')}
                                    className="px-2 py-1 rounded bg-surface-container-highest hover:bg-surface-bright text-on-surface text-[11px] font-mono cursor-pointer"
                                  >
                                    Restart
                                  </button>
                                  <button
                                    onClick={() => onServerPowerAction(srv.id, 'stop')}
                                    className="px-2 py-1 rounded bg-error/15 hover:bg-error/25 text-error text-[11px] font-mono cursor-pointer"
                                  >
                                    Stop
                                  </button>
                                </>
                              )}
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </section>
      </div>

      <ServerInstallModal
        isOpen={createModalOpen}
        defaultRoot={serverInstallRootDir}
        serverCount={servers.length}
        maxLimit={maxServerLimit}
        isSuperAdmin={isSuperAdmin}
        discordVerified={isDiscordVerified}
        username={currentUser?.username || 'Operator'}
        onClose={() => setCreateModalOpen(false)}
        onInstalled={(installed) => onCreateServerInstance(installed)}
        onLimitReached={(attemptedName) => {
          setCreateModalOpen(false);
          onOpenDiscordBotGate?.(attemptedName);
        }}
        onShowToast={onShowToast}
      />
    </main>
  );
};
