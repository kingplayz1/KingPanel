import React, { useState, useEffect } from 'react';
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
  onServerPowerAction: (
    serverId: string,
    action: 'start' | 'restart' | 'stop' | 'kill'
  ) => void;
  onBulkServerAction: (action: 'start_all' | 'restart_running' | 'stop_all' | 'snapshot_all') => void;
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
    icon?: string
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

  // New Server Instance Form State
  const [newName, setNewName] = useState('');
  const [newEngine, setNewEngine] = useState('PaperMC 1.20.4');
  const [newPort, setNewPort] = useState('25572');
  const [newRamMax, setNewRamMax] = useState(6);
  const [newMaxPlayers, setNewMaxPlayers] = useState(30);

  // Compute global fleet aggregations across running servers
  const runningServers = servers.filter((s) => s.status === 'running' || s.status === 'restarting');
  const stoppedServers = servers.filter((s) => s.status === 'stopped');

  const totalPlayersOnline = runningServers.reduce((acc, s) => acc + s.playersOnline, 0);
  const totalMaxPlayersRunning = runningServers.reduce((acc, s) => acc + s.maxPlayers, 0);
  const totalMaxPlayersAll = servers.reduce((acc, s) => acc + s.maxPlayers, 0);

  const combinedCpuUsage = runningServers.reduce((acc, s) => acc + s.cpuUsage, 0);
  const hostNormalizedCpu = Math.min(100, Math.round(combinedCpuUsage));
  const avgCpuTemp =
    runningServers.length > 0
      ? (
          runningServers.reduce((acc, s) => acc + s.cpuTemp, 0) / runningServers.length
        ).toFixed(1)
      : '36.0';

  const combinedRamUsedGb = Number(
    runningServers.reduce((acc, s) => acc + s.ramUsedGb, 0).toFixed(1)
  );
  const combinedRamAllocatedGb = Number(
    runningServers.reduce((acc, s) => acc + s.ramMaxGb, 0).toFixed(1)
  );
  const totalHostRamGb = 32.0;
  const hostRamPercent = Math.min(100, Math.round((combinedRamUsedGb / totalHostRamGb) * 100));

  const avgTps =
    runningServers.length > 0
      ? (runningServers.reduce((acc, s) => acc + s.tps, 0) / runningServers.length).toFixed(1)
      : '0.0';

  // Real-time System Performance Monitor state (CPU, RAM, Disk I/O)
  const [telemetryPaused, setTelemetryPaused] = useState(false);
  const [timeRange, setTimeRange] = useState<'30s' | '1m' | '5m'>('1m');
  const [telemetryHistory, setTelemetryHistory] = useState<TelemetryDataPoint[]>(() => {
    const now = Date.now();
    return Array.from({ length: 16 }, (_, idx) => {
      const t = new Date(now - (15 - idx) * 2000);
      const timeStr = t.toTimeString().split(' ')[0].slice(3); // MM:SS
      const jitter = Math.sin(idx * 0.6) * 6;
      const baseCpu = Math.min(100, Math.max(8, Math.round(78 + jitter)));
      const kernel = Math.max(3, Math.round(baseCpu * 0.16 + (idx % 3)));
      const readMb = Math.round(145 + Math.cos(idx * 0.8) * 55 + (idx % 4) * 18);
      const writeMb = Math.round(88 + Math.sin(idx * 0.9) * 42 + (idx % 5 === 0 ? 110 : 12));
      return {
        time: timeStr,
        cpuTotal: baseCpu,
        cpuKernel: kernel,
        cpuTemp: Number((47.5 + jitter * 0.25).toFixed(1)),
        ramUsedGb: Number((15.9 + Math.sin(idx * 0.4) * 0.4).toFixed(2)),
        ramCommittedGb: 28.0,
        diskReadMbs: Math.max(12, readMb),
        diskWriteMbs: Math.max(8, writeMb),
        iops: Math.round((readMb + writeMb) * 18.5),
      };
    });
  });

  useEffect(() => {
    if (telemetryPaused) return;
    const timer = setInterval(() => {
      const now = new Date();
      const timeStr = now.toTimeString().split(' ')[0].slice(3);
      setTelemetryHistory((prev) => {
        const cpuNoise = Math.floor(Math.random() * 9) - 4;
        const currentCpu = Math.min(100, Math.max(4, hostNormalizedCpu + cpuNoise));
        const kernelCpu = Math.max(2, Math.round(currentCpu * 0.15 + Math.random() * 4));
        const ramJitter = Number(((Math.random() - 0.48) * 0.25).toFixed(2));
        const currentRam = Math.max(
          1.2,
          Math.min(31.5, Number((combinedRamUsedGb + ramJitter).toFixed(2)))
        );
        const readSpike =
          runningServers.length > 0 ? Math.round(90 + Math.random() * 160) : Math.round(10 + Math.random() * 15);
        const writeSpike =
          runningServers.length > 0 ? Math.round(55 + Math.random() * 135) : Math.round(5 + Math.random() * 10);

        const nextPoint: TelemetryDataPoint = {
          time: timeStr,
          cpuTotal: currentCpu,
          cpuKernel: kernelCpu,
          cpuTemp: Number(avgCpuTemp),
          ramUsedGb: currentRam,
          ramCommittedGb: combinedRamAllocatedGb,
          diskReadMbs: readSpike,
          diskWriteMbs: writeSpike,
          iops: Math.round((readSpike + writeSpike) * 19.2),
        };
        const maxPoints = timeRange === '30s' ? 12 : timeRange === '1m' ? 18 : 26;
        return [...prev.slice(-(maxPoints - 1)), nextPoint];
      });
    }, 2000);
    return () => clearInterval(timer);
  }, [
    telemetryPaused,
    timeRange,
    hostNormalizedCpu,
    combinedRamUsedGb,
    combinedRamAllocatedGb,
    avgCpuTemp,
    runningServers.length,
  ]);

  const handleSimulateChunkBurst = () => {
    const now = new Date();
    const timeStr = now.toTimeString().split(' ')[0].slice(3);
    setTelemetryHistory((prev) => [
      ...prev.slice(-15),
      {
        time: timeStr,
        cpuTotal: Math.min(98, hostNormalizedCpu + 24),
        cpuKernel: 19,
        cpuTemp: Number((Number(avgCpuTemp) + 4.2).toFixed(1)),
        ramUsedGb: Math.min(31.0, Number((combinedRamUsedGb + 1.8).toFixed(2))),
        ramCommittedGb: combinedRamAllocatedGb,
        diskReadMbs: 640,
        diskWriteMbs: 510,
        iops: 21850,
      },
    ]);
    onShowToast(
      'Simulated Anvil Region Burst',
      'Flushed 2,400 region chunks across NVMe RAID-0 (Read: 640 MB/s, Write: 510 MB/s).',
      'info',
      'speed'
    );
  };

  const latestTelemetry = telemetryHistory[telemetryHistory.length - 1] || {
    cpuTotal: hostNormalizedCpu,
    cpuKernel: 10,
    cpuTemp: Number(avgCpuTemp),
    ramUsedGb: combinedRamUsedGb,
    ramCommittedGb: combinedRamAllocatedGb,
    diskReadMbs: 142,
    diskWriteMbs: 96,
    iops: 4520,
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
    s.isOutdated !== undefined ? s.isOutdated : !s.engine.includes(latestPaperRelease)
  );

  const handleDeployInstance = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isAtServerLimit) {
      setCreateModalOpen(false);
      if (onOpenDiscordBotGate) {
        onOpenDiscordBotGate(newName.trim() || `Server #${servers.length + 1}`);
      } else {
        onShowToast(
          '2-Server Limit Reached — Discord Bot Verification Required',
          'Standard logged-in users can only set up 1 or 2 servers. Connect to our Discord Server and verify with the Discord Bot to create more than 2 servers!',
          'warning',
          'lock'
        );
      }
      return;
    }
    if (!newName.trim()) {
      onShowToast('Instance Name Required', 'Please provide a name for the new server.', 'warning');
      return;
    }
    const cleanFolder = newName.trim().replace(/[^a-zA-Z0-9_-]/g, '_') || 'NewInstance';
    const portNum = parseInt(newPort, 10) || 25572;
    const cleanRoot = serverInstallRootDir.replace(/[\\/]+$/, '');
    const sep = cleanRoot.includes('\\') ? '\\' : '/';
    let targetInstallPath = `${cleanRoot}${sep}${cleanFolder}`;

    try {
      const r = await fetch('/api/panel/install-server-instance', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          serverName: newName.trim(),
          engine: newEngine,
          port: portNum,
          ramMaxGb: newRamMax,
          currentServerCount: servers.length,
          discordVerified: isDiscordVerified,
        }),
      });
      const data = await r.json();
      if (r.status === 403 && data?.code === 'DISCORD_VERIFICATION_REQUIRED') {
        setCreateModalOpen(false);
        if (onOpenDiscordBotGate) {
          onOpenDiscordBotGate(newName.trim());
        }
        return;
      }
      if (data?.ok && data.displayPath) {
        targetInstallPath = data.displayPath;
      }
    } catch {
      // fallback to computed path
    }

    const created: ServerInstance = {
      id: `srv-${Date.now()}`,
      name: newName.trim(),
      engine: newEngine,
      javaVersion: 'Java 21',
      port: portNum,
      pid: Math.floor(10000 + Math.random() * 19000),
      status: 'running',
      path: targetInstallPath,
      build: 'Build #448',
      tps: 20.0,
      tickMs: 2.1,
      uptime: '0h 01m',
      playersOnline: 0,
      maxPlayers: newMaxPlayers,
      cpuUsage: 8,
      cpuTemp: 43.5,
      ramUsedGb: Number((newRamMax * 0.35).toFixed(1)),
      ramMaxGb: newRamMax,
    };
    onCreateServerInstance(created);
    setCreateModalOpen(false);
    setNewName('');
    setNewPort(String(portNum + 1));
  };

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
      <header className="h-16 px-6 bg-surface border-b border-outline-variant/15 flex items-center justify-between shrink-0">
        <div className="flex items-center gap-4">
          <div className="w-10 h-10 rounded-lg bg-gradient-to-br from-primary/20 to-primary-container/10 border border-primary/30 flex items-center justify-center text-primary shadow-inner">
            <span className="material-symbols-outlined text-[22px]">Space_Dashboard</span>
          </div>
          <div>
            <div className="flex items-center gap-2.5">
              <h1 className="text-base font-bold tracking-tight text-on-surface">
                Localhost Node Overview &amp; Multi-Server Fleet Command
              </h1>
              <span className="px-2 py-0.5 text-[10px] font-mono uppercase tracking-wider bg-secondary/10 text-secondary rounded border border-secondary/25 flex items-center gap-1.5">
                <span className="w-1.5 h-1.5 rounded-full bg-secondary animate-pulse"></span>
                {runningServers.length} of {servers.length} Instances Online
              </span>
              <span className="px-2 py-0.5 text-[10px] font-mono uppercase tracking-wider bg-surface-container-highest text-primary rounded border border-primary/20">
                AMD Ryzen 9 7950X (16C/32T)
              </span>
            </div>
            <p className="text-xs text-outline font-mono mt-0.5">
              Host IP: 127.0.0.1 (WAN: 89.204.132.19) • FastPipe IPC Cluster • NVMe RAID-0 (3.4 GB/s)
            </p>
          </div>
        </div>

        {/* Global Fleet Actions */}
        <div className="flex items-center gap-2.5">
          <button
            type="button"
            onClick={() => onManageServer(activeServer, 'setup_guide')}
            className="px-3.5 py-2 rounded-lg bg-secondary/15 hover:bg-secondary/25 text-xs font-bold text-secondary border border-secondary/35 transition-all flex items-center gap-1.5 cursor-pointer"
          >
            <span className="material-symbols-outlined text-[16px]">school</span>
            Setup Guide
          </button>
          <button
            onClick={() => onBulkServerAction('snapshot_all')}
            className="px-3.5 py-2 rounded-lg bg-surface-container-high hover:bg-surface-bright text-xs font-medium text-on-surface border border-outline-variant/20 transition-all flex items-center gap-1.5 cursor-pointer"
          >
            <span className="material-symbols-outlined text-[16px] text-tertiary">backup</span>
            Snapshot All
          </button>
          <button
            onClick={() => onBulkServerAction('restart_running')}
            className="px-3.5 py-2 rounded-lg bg-surface-container-high hover:bg-surface-bright text-xs font-medium text-on-surface border border-outline-variant/20 transition-all flex items-center gap-1.5 cursor-pointer"
          >
            <span className="material-symbols-outlined text-[16px] text-primary">restart_alt</span>
            Restart Running
          </button>
          {stoppedServers.length > 0 && (
            <button
              onClick={() => onBulkServerAction('start_all')}
              className="px-3.5 py-2 rounded-lg bg-secondary/15 hover:bg-secondary/25 text-xs font-semibold text-secondary border border-secondary/30 transition-all flex items-center gap-1.5 cursor-pointer"
            >
              <span className="material-symbols-outlined text-[16px]">play_arrow</span>
              Start All ({stoppedServers.length})
            </button>
          )}
          <div className="h-5 w-[1px] bg-outline-variant/20 mx-0.5"></div>
          {/* Discord Bot Verification & Server Limit Status Pill */}
          {isDiscordVerified ? (
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                onClick={() => onOpenDiscordBotGate && onOpenDiscordBotGate()}
                className="px-3 py-2 rounded-lg bg-secondary/15 hover:bg-secondary/25 border border-secondary/35 text-secondary text-xs font-mono font-bold flex items-center gap-1.5 cursor-pointer"
                title="Verified by Discord Bot — Up to 10 Servers Unlocked"
              >
                <span className="material-symbols-outlined text-[15px]">verified</span>
                <span>
                  Bot Verified ({servers.length}/{maxServerLimit} Servers)
                </span>
              </button>
              {onLeaveDiscordServer && (
                <button
                  type="button"
                  onClick={onLeaveDiscordServer}
                  className="px-2.5 py-2 rounded-lg bg-error/15 hover:bg-error/25 border border-error/35 text-error text-[11px] font-mono font-bold flex items-center gap-1 cursor-pointer"
                  title="Leave Discord Server (Resets server creation limit back to 2)"
                >
                  <span className="material-symbols-outlined text-[14px]">link_off</span>
                  Leave Discord
                </button>
              )}
            </div>
          ) : (
            <button
              type="button"
              onClick={() => onOpenDiscordBotGate && onOpenDiscordBotGate()}
              className="px-3 py-2 rounded-lg bg-[#5865F2]/20 hover:bg-[#5865F2]/30 border border-[#5865F2]/40 text-white text-xs font-mono font-bold flex items-center gap-1.5 cursor-pointer"
              title="Standard users can create 1 or 2 servers. Click to verify with Discord Bot for >2 servers."
            >
              <span className="material-symbols-outlined text-[15px] text-[#8ea1e1]">
                shield_lock
              </span>
              <span>
                Limit: {servers.length}/2 Servers • Verify Discord
              </span>
            </button>
          )}
          <button
            onClick={() => {
              if (isAtServerLimit && !isDiscordVerified && onOpenDiscordBotGate) {
                onOpenDiscordBotGate(`Server #${servers.length + 1}`);
              } else {
                setCreateModalOpen(true);
              }
            }}
            className="px-4 py-2 rounded-lg bg-gradient-to-r from-primary to-primary-container hover:opacity-95 text-xs font-bold text-on-primary-container shadow-lg shadow-primary/15 transition-all flex items-center gap-1.5 cursor-pointer"
          >
            <span className="material-symbols-outlined text-[16px]">add_box</span>
            Deploy New Server ({servers.length}/{maxServerLimit})
          </button>
        </div>
      </header>

      {/* Scrollable Overview Workspace */}
      <div className="flex-1 overflow-y-auto p-6 space-y-6">
        {/* TOP 4 AGGREGATED FLEET TELEMETRY CARDS */}
        <section className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4">
          {/* Card 1: Running Servers Summary */}
          <div className="p-4 rounded-xl bg-surface border border-outline-variant/15 flex flex-col justify-between relative overflow-hidden shadow-lg">
            <div className="flex items-start justify-between">
              <div>
                <p className="text-[10px] font-mono uppercase tracking-wider text-outline font-bold">
                  Running Servers Fleet
                </p>
                <div className="flex items-baseline gap-2 mt-1">
                  <span className="text-2xl font-bold font-mono text-white tabular-nums">
                    {runningServers.length}
                  </span>
                  <span className="text-xs font-mono text-outline">
                    / {servers.length} Instances
                  </span>
                  <span className="text-[11px] font-mono px-1.5 py-0.5 rounded bg-secondary/10 text-secondary border border-secondary/20">
                    {avgTps} Avg TPS
                  </span>
                </div>
              </div>
              <div className="w-9 h-9 rounded-lg bg-secondary/10 border border-secondary/25 flex items-center justify-center text-secondary">
                <span className="material-symbols-outlined text-[20px]">dns</span>
              </div>
            </div>

            <div className="mt-4 space-y-2">
              <div className="flex items-center justify-between text-[11px] font-mono">
                <span className="text-outline">Active Daemons:</span>
                <span className="text-secondary font-semibold">
                  {runningServers.length} Online • {stoppedServers.length} Standby
                </span>
              </div>
              <div className="w-full h-2 rounded-full bg-surface-lowest overflow-hidden flex gap-0.5 p-0.5 border border-white/5">
                {servers.map((srv) => (
                  <div
                    key={srv.id}
                    title={`${srv.name}: ${srv.status.toUpperCase()}`}
                    className={`h-full flex-1 rounded-sm transition-all ${
                      srv.status === 'running'
                        ? 'bg-secondary'
                        : srv.status === 'restarting'
                        ? 'bg-primary animate-pulse'
                        : 'bg-white/10'
                    }`}
                  />
                ))}
              </div>
              <div className="flex items-center justify-between text-[10px] font-mono text-outline pt-0.5">
                <span>Cluster Health: 99.98%</span>
                <span className="text-primary">UPnP Gateway Synced</span>
              </div>
            </div>
          </div>

          {/* Card 2: Total Connected Players Across All Running Servers */}
          <div className="p-4 rounded-xl bg-surface border border-outline-variant/15 flex flex-col justify-between relative overflow-hidden shadow-lg">
            <div className="flex items-start justify-between">
              <div>
                <p className="text-[10px] font-mono uppercase tracking-wider text-outline font-bold">
                  Total Connected Players
                </p>
                <div className="flex items-baseline gap-2 mt-1">
                  <span className="text-2xl font-bold font-mono text-primary tabular-nums">
                    {totalPlayersOnline}
                  </span>
                  <span className="text-xs font-mono text-outline">
                    / {totalMaxPlayersRunning} Active Slots
                  </span>
                  <span className="text-[11px] font-mono text-secondary">
                    ({totalMaxPlayersAll} Max)
                  </span>
                </div>
              </div>
              <div className="w-9 h-9 rounded-lg bg-primary/10 border border-primary/25 flex items-center justify-center text-primary">
                <span className="material-symbols-outlined text-[20px]">groups</span>
              </div>
            </div>

            <div className="mt-4 space-y-2">
              <div className="w-full bg-surface-lowest h-2 rounded-full overflow-hidden border border-white/5">
                <div
                  className="bg-gradient-to-r from-primary to-amber-300 h-full rounded-full transition-all duration-500"
                  style={{
                    width: `${
                      totalMaxPlayersRunning > 0
                        ? Math.min(100, Math.round((totalPlayersOnline / totalMaxPlayersRunning) * 100))
                        : 0
                    }%`,
                  }}
                />
              </div>
              <div className="flex items-center justify-between text-[10px] font-mono text-outline">
                <div className="flex items-center -space-x-1.5">
                  {players.slice(0, 4).map((p) => (
                    <img
                      key={p.id}
                      src={p.avatarUrl}
                      alt={p.username}
                      title={`${p.username} (${p.ping}ms)`}
                      className="w-4 h-4 rounded-full ring-1 ring-surface object-cover"
                    />
                  ))}
                  {totalPlayersOnline > 4 && (
                    <span className="pl-2 text-[10px] text-on-surface font-mono">
                      +{totalPlayersOnline - 4} peers across nodes
                    </span>
                  )}
                </div>
                <span className="text-secondary">Avg Ping: 16ms</span>
              </div>
            </div>
          </div>

          {/* Card 3: Combined CPU Usage Across Running Servers */}
          <div className="p-4 rounded-xl bg-surface border border-outline-variant/15 flex flex-col justify-between relative overflow-hidden shadow-lg">
            <div className="flex items-start justify-between">
              <div>
                <p className="text-[10px] font-mono uppercase tracking-wider text-outline font-bold">
                  Combined CPU Load (All JVMs)
                </p>
                <div className="flex items-baseline gap-2 mt-1">
                  <span className="text-2xl font-bold font-mono text-white tabular-nums">
                    {hostNormalizedCpu}%
                  </span>
                  <span className="text-xs font-mono text-tertiary">{avgCpuTemp}°C Pkg</span>
                  <span className="text-[10px] font-mono text-outline">• 5.35 GHz Boost</span>
                </div>
              </div>
              <div className="w-9 h-9 rounded-lg bg-tertiary/10 border border-tertiary/25 flex items-center justify-center text-tertiary">
                <span className="material-symbols-outlined text-[20px]">memory</span>
              </div>
            </div>

            <div className="mt-3">
              {/* Segmented CPU Bar per Running Server */}
              <div className="w-full bg-surface-lowest h-2 rounded-full overflow-hidden flex border border-white/5">
                {runningServers.map((srv, idx) => (
                  <div
                    key={srv.id}
                    title={`${srv.name}: ${srv.cpuUsage}% CPU`}
                    style={{ width: `${Math.min(100, srv.cpuUsage)}%` }}
                    className={`h-full transition-all duration-500 ${
                      segmentColors[idx % segmentColors.length]
                    } border-r border-surface-lowest`}
                  />
                ))}
              </div>
              <div className="flex items-center justify-between text-[10px] font-mono text-outline mt-2">
                <span>{runningServers.length} JVM Processes Active</span>
                <span className="text-tertiary">
                  {Math.max(0, 100 - hostNormalizedCpu)}% Headroom Free
                </span>
              </div>
            </div>
          </div>

          {/* Card 4: Combined RAM Usage Across Running Servers */}
          <div className="p-4 rounded-xl bg-surface border border-outline-variant/15 flex flex-col justify-between relative overflow-hidden shadow-lg">
            <div className="flex items-start justify-between">
              <div>
                <p className="text-[10px] font-mono uppercase tracking-wider text-outline font-bold">
                  Combined JVM Heap / Host RAM
                </p>
                <div className="flex items-baseline gap-2 mt-1">
                  <span className="text-2xl font-bold font-mono text-white tabular-nums">
                    {combinedRamUsedGb}
                  </span>
                  <span className="text-xs font-mono text-outline">
                    / {combinedRamAllocatedGb} GB Heap
                  </span>
                  <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-primary/10 text-primary">
                    {hostRamPercent}% of 32GB
                  </span>
                </div>
              </div>
              <div className="w-9 h-9 rounded-lg bg-primary-gold/10 border border-primary-gold/25 flex items-center justify-center text-primary-gold">
                <span className="material-symbols-outlined text-[20px]">developer_board</span>
              </div>
            </div>

            <div className="mt-3">
              {/* Segmented RAM Bar per Running Server */}
              <div className="w-full bg-surface-lowest h-2 rounded-full overflow-hidden flex border border-white/5">
                {runningServers.map((srv, idx) => (
                  <div
                    key={srv.id}
                    title={`${srv.name}: ${srv.ramUsedGb} GB / ${srv.ramMaxGb} GB`}
                    style={{ width: `${(srv.ramUsedGb / totalHostRamGb) * 100}%` }}
                    className={`h-full transition-all duration-500 ${
                      segmentColors[idx % segmentColors.length]
                    } border-r border-surface-lowest`}
                  />
                ))}
              </div>
              <div className="flex items-center justify-between text-[10px] font-mono text-outline mt-2">
                <span>DDR5-6000 ECC • G1GC Active</span>
                <button
                  onClick={() =>
                    onShowToast(
                      'Global G1GC Sweep Triggered',
                      `Reclaimed 1.4 GB unreferenced heap across ${runningServers.length} running JVMs.`,
                      'success',
                      'cleaning_services'
                    )
                  }
                  className="text-primary hover:underline cursor-pointer"
                >
                  Sweep All GC →
                </button>
              </div>
            </div>
          </div>
        </section>

        {/* REAL-TIME HOST SYSTEM PERFORMANCE MONITOR (RECHARTS ENGINE) */}
        <section className="rounded-xl bg-surface border border-outline-variant/15 overflow-hidden shadow-xl">
          {/* Header Bar */}
          <div className="px-5 py-3.5 bg-surface-container border-b border-outline-variant/15 flex flex-wrap items-center justify-between gap-4">
            <div className="flex items-center gap-3">
              <div className="w-8 h-8 rounded-lg bg-primary/10 border border-primary/25 flex items-center justify-center text-primary">
                <span className="material-symbols-outlined text-[18px]">monitoring</span>
              </div>
              <div>
                <div className="flex items-center gap-2.5">
                  <h2 className="text-xs font-bold uppercase tracking-wider text-white">
                    Real-Time System Performance Monitor (Global Host Telemetry)
                  </h2>
                  <span
                    className={`px-2 py-0.5 rounded text-[10px] font-mono uppercase flex items-center gap-1 border ${
                      telemetryPaused
                        ? 'bg-primary-gold/10 text-primary-gold border-primary-gold/25'
                        : 'bg-secondary/10 text-secondary border-secondary/25'
                    }`}
                  >
                    <span
                      className={`w-1.5 h-1.5 rounded-full ${
                        telemetryPaused ? 'bg-primary-gold' : 'bg-secondary animate-ping'
                      }`}
                    />
                    {telemetryPaused ? 'Stream Paused' : 'Live 2s IPC Stream'}
                  </span>
                </div>
                <p className="text-[11px] font-mono text-outline mt-0.5">
                  Aggregated CPU Threads, Physical DDR5 Commit &amp; NVMe RAID-0 Disk I/O Across All Processes
                </p>
              </div>
            </div>

            {/* Stream Controls */}
            <div className="flex items-center gap-2">
              <div className="flex items-center bg-surface-lowest p-0.5 rounded-lg border border-outline-variant/20">
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
                onClick={handleSimulateChunkBurst}
                className="px-3 py-1.5 rounded-lg bg-surface-container-highest hover:bg-surface-bright text-[11px] font-mono text-primary border border-primary/20 flex items-center gap-1.5 transition-colors cursor-pointer"
                title="Trigger simulated region disk & CPU spike"
              >
                <span className="material-symbols-outlined text-[14px]">bolt</span>
                Simulate I/O Burst
              </button>

              <button
                type="button"
                onClick={() => setTelemetryPaused(!telemetryPaused)}
                className="px-3 py-1.5 rounded-lg bg-surface-container-high hover:bg-surface-bright text-[11px] font-mono text-on-surface border border-outline-variant/20 flex items-center gap-1 transition-colors cursor-pointer"
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
            <div className="p-4 rounded-xl bg-surface-container-low border border-outline-variant/15 flex flex-col justify-between space-y-3">
              <div className="flex items-start justify-between">
                <div>
                  <div className="flex items-center gap-2">
                    <span className="w-2 h-2 rounded-full bg-primary"></span>
                    <h3 className="text-xs font-bold uppercase tracking-wider text-white">
                      Global CPU Utilization
                    </h3>
                  </div>
                  <p className="text-[10px] font-mono text-outline mt-0.5">
                    JVM User Threads vs. Kernel Overhead
                  </p>
                </div>
                <div className="text-right font-mono">
                  <div className="text-base font-bold text-primary tabular-nums">
                    {latestTelemetry.cpuTotal}%
                  </div>
                  <div className="text-[10px] text-tertiary">
                    Kernel: {latestTelemetry.cpuKernel}% • {latestTelemetry.cpuTemp}°C
                  </div>
                </div>
              </div>

              <div className="h-44 w-full">
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart
                    data={telemetryHistory}
                    margin={{ top: 6, right: 6, left: -24, bottom: 0 }}
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

              <div className="pt-2 border-t border-outline-variant/10 flex items-center justify-between text-[10px] font-mono text-outline">
                <span className="flex items-center gap-1.5">
                  <span className="w-2 h-0.5 bg-primary inline-block"></span> JVM Load
                  <span className="w-2 h-0.5 bg-tertiary inline-block ml-2"></span> System Kernel
                </span>
                <span>16C / 32T SMT Active</span>
              </div>
            </div>

            {/* CHART 2: GLOBAL RAM & JVM HEAP ALLOCATION */}
            <div className="p-4 rounded-xl bg-surface-container-low border border-outline-variant/15 flex flex-col justify-between space-y-3">
              <div className="flex items-start justify-between">
                <div>
                  <div className="flex items-center gap-2">
                    <span className="w-2 h-2 rounded-full bg-secondary"></span>
                    <h3 className="text-xs font-bold uppercase tracking-wider text-white">
                      Global RAM &amp; Heap Commit
                    </h3>
                  </div>
                  <p className="text-[10px] font-mono text-outline mt-0.5">
                    Active Heap vs. Committed Memory (32 GB Host)
                  </p>
                </div>
                <div className="text-right font-mono">
                  <div className="text-base font-bold text-secondary tabular-nums">
                    {latestTelemetry.ramUsedGb} GB
                  </div>
                  <div className="text-[10px] text-outline">
                    Commit: {latestTelemetry.ramCommittedGb} GB / 32 GB
                  </div>
                </div>
              </div>

              <div className="h-44 w-full">
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart
                    data={telemetryHistory}
                    margin={{ top: 6, right: 6, left: -24, bottom: 0 }}
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

              <div className="pt-2 border-t border-outline-variant/10 flex items-center justify-between text-[10px] font-mono text-outline">
                <span className="flex items-center gap-1.5">
                  <span className="w-2 h-0.5 bg-secondary inline-block"></span> Active Heap Used
                  <span className="w-2 h-0.5 bg-primary inline-block ml-2"></span> -Xmx Reserved
                </span>
                <span className="text-secondary">G1GC YoungGen Optimal</span>
              </div>
            </div>

            {/* CHART 3: NVMe RAID-0 DISK I/O THROUGHPUT (READ / WRITE MB/s) */}
            <div className="p-4 rounded-xl bg-surface-container-low border border-outline-variant/15 flex flex-col justify-between space-y-3">
              <div className="flex items-start justify-between">
                <div>
                  <div className="flex items-center gap-2">
                    <span className="w-2 h-2 rounded-full bg-tertiary"></span>
                    <h3 className="text-xs font-bold uppercase tracking-wider text-white">
                      NVMe Disk I/O Throughput
                    </h3>
                  </div>
                  <p className="text-[10px] font-mono text-outline mt-0.5">
                    Region Anvil Read vs. Chunk/WAL Write (MB/s)
                  </p>
                </div>
                <div className="text-right font-mono">
                  <div className="text-base font-bold text-tertiary tabular-nums">
                    {latestTelemetry.diskReadMbs + latestTelemetry.diskWriteMbs} MB/s
                  </div>
                  <div className="text-[10px] text-outline">
                    R: {latestTelemetry.diskReadMbs} • W: {latestTelemetry.diskWriteMbs} MB/s (
                    {latestTelemetry.iops.toLocaleString()} IOPS)
                  </div>
                </div>
              </div>

              <div className="h-44 w-full">
                <ResponsiveContainer width="100%" height="100%">
                  <ComposedChart
                    data={telemetryHistory}
                    margin={{ top: 6, right: 6, left: -20, bottom: 0 }}
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

              <div className="pt-2 border-t border-outline-variant/10 flex items-center justify-between text-[10px] font-mono text-outline">
                <span className="flex items-center gap-1.5">
                  <span className="w-2 h-0.5 bg-tertiary inline-block"></span> Read MB/s
                  <span className="w-2 h-2 rounded-xs bg-primary inline-block ml-2"></span> Write
                  MB/s
                </span>
                <span>Queue Depth: 2 • 0.16ms Latency</span>
              </div>
            </div>
          </div>

          {/* COMBINED RESOURCE DISTRIBUTION & MULTI-NODE TELEMETRY BAR */}
          <div className="px-5 py-3.5 bg-surface-container-low border-t border-outline-variant/15">
            <div className="flex flex-wrap items-center justify-between gap-4 mb-2.5">
              <div className="flex items-center gap-2">
                <span className="material-symbols-outlined text-primary text-[16px]">
                  stacked_bar_chart
                </span>
                <span className="text-[11px] font-bold uppercase tracking-wider text-on-surface">
                  Per-Instance Resource Attribution Breakdown
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
                <div className="w-full h-2.5 rounded-md bg-surface-lowest overflow-hidden flex p-0.5 gap-0.5 border border-white/5">
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
                <div className="w-full h-2.5 rounded-md bg-surface-lowest overflow-hidden flex p-0.5 gap-0.5 border border-white/5">
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
        <section className="rounded-xl bg-surface border border-amber-400/30 p-4 flex flex-wrap items-center justify-between gap-4 shadow-lg">
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
                • Checked via <code className="text-white/80">https://api.papermc.io/v2/projects/paper</code> •
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
          <div className="flex flex-wrap items-center justify-between gap-4 bg-surface p-3.5 rounded-xl border border-outline-variant/15 shadow-md">
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
              <div className="flex items-center gap-1 bg-surface-lowest p-1 rounded-lg border border-outline-variant/20 ml-2">
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
                  className="w-full bg-surface-lowest border border-outline-variant/25 focus:border-primary rounded-lg pl-9 pr-3 py-1.5 text-xs font-mono text-on-surface focus:outline-none"
                />
              </div>

              <div className="flex items-center bg-surface-lowest p-1 rounded-lg border border-outline-variant/20">
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
          {layoutMode === 'cards' ? (
            <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
              {filteredServers.map((srv, idx) => {
                const isSelected = srv.id === activeServer.id;
                const isRunning = srv.status === 'running';
                const isRestarting = srv.status === 'restarting';
                const ramPercent = Math.min(
                  100,
                  Math.round((srv.ramUsedGb / Math.max(1, srv.ramMaxGb)) * 100)
                );
                const playerPercent = Math.min(
                  100,
                  Math.round((srv.playersOnline / Math.max(1, srv.maxPlayers)) * 100)
                );

                return (
                  <div
                    key={srv.id}
                    className={`rounded-xl bg-surface border transition-all p-5 flex flex-col justify-between shadow-lg ${
                      isSelected
                        ? 'border-primary/50 ring-1 ring-primary/20'
                        : 'border-outline-variant/15 hover:border-outline-variant/35'
                    }`}
                  >
                    {/* Card Header: Identity, Status & Quick Select */}
                    <div>
                      <div className="flex items-start justify-between gap-4">
                        <div className="flex items-start gap-3.5">
                          <div className="w-12 h-12 rounded-xl bg-surface-lowest border border-outline-variant/25 flex items-center justify-center relative shrink-0 overflow-hidden shadow-md">
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
                              {(srv.isOutdated !== undefined
                                ? srv.isOutdated
                                : !srv.engine.includes(latestPaperRelease)) ? (
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
                              {srv.path} • Uptime: <strong className="text-on-surface">{srv.uptime}</strong>
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
                      <div className="grid grid-cols-3 gap-3 mt-4 pt-4 border-t border-outline-variant/15">
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
                          <div className="text-[10px] font-mono text-outline mt-1.5">
                            Temp: {srv.cpuTemp}°C
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
                    <div className="mt-4 pt-3 border-t border-outline-variant/15 flex items-center justify-between gap-2 flex-wrap">
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
                          className="px-2.5 py-1.5 rounded-lg bg-surface-container-high hover:bg-surface-bright text-on-surface text-xs font-medium border border-outline-variant/20 flex items-center gap-1 transition-colors cursor-pointer"
                          title="Open File Manager"
                        >
                          <span className="material-symbols-outlined text-[14px] text-outline">
                            folder_open
                          </span>
                          Files
                        </button>
                        <button
                          onClick={() => onManageServer(srv, 'jvm')}
                          className="px-2.5 py-1.5 rounded-lg bg-surface-container-high hover:bg-surface-bright text-on-surface text-xs font-medium border border-outline-variant/20 flex items-center gap-1 transition-colors cursor-pointer"
                          title="Configure JVM Flags"
                        >
                          <span className="material-symbols-outlined text-[14px] text-outline">
                            tune
                          </span>
                          JVM
                        </button>
                        <button
                          onClick={() => onManageServer(srv, 'settings')}
                          className="px-2.5 py-1.5 rounded-lg bg-surface-container-high hover:bg-surface-bright text-on-surface text-xs font-medium border border-outline-variant/20 flex items-center gap-1 transition-colors cursor-pointer"
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
                              className="px-2.5 py-1.5 rounded-lg bg-surface-container-high hover:bg-primary/20 text-outline hover:text-primary border border-outline-variant/20 text-xs font-mono flex items-center gap-1 transition-colors cursor-pointer"
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
            <div className="bg-surface rounded-xl border border-outline-variant/15 overflow-hidden shadow-xl">
              <div className="overflow-x-auto">
                <table className="w-full text-left border-collapse">
                  <thead>
                    <tr className="border-b border-outline-variant/15 text-[10px] font-mono uppercase text-outline bg-surface-container">
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
                              {(srv.isOutdated !== undefined
                                ? srv.isOutdated
                                : !srv.engine.includes(latestPaperRelease)) ? (
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
                            <div className="text-[10px] text-outline">{srv.cpuTemp}°C</div>
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
                                    (srv.ramUsedGb / Math.max(1, srv.ramMaxGb)) * 100
                                  )}%`,
                                }}
                              />
                            </div>
                          </td>
                          <td className="py-3 px-4 font-mono">
                            <div className={isRunning ? 'text-secondary font-bold' : 'text-outline'}>
                              {srv.tps.toFixed(1)} TPS
                            </div>
                            <div className="text-[10px] text-outline">{srv.tickMs}ms</div>
                          </td>
                          <td
                            className="py-3 px-4 text-right"
                            onClick={(e) => e.stopPropagation()}
                          >
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

      {/* DEPLOY NEW SERVER INSTANCE MODAL */}
      {createModalOpen && (
        <div className="fixed inset-0 z-50 bg-black/75 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="w-full max-w-md rounded-2xl bg-surface border border-outline-variant/25 shadow-2xl overflow-hidden">
            <div className="px-5 py-4 bg-surface-container border-b border-outline-variant/15 flex items-center justify-between">
              <div className="flex items-center gap-2.5">
                <span className="material-symbols-outlined text-primary text-[20px]">add_box</span>
                <h3 className="text-sm font-bold text-white">
                  Deploy New Localhost Server Instance
                </h3>
              </div>
              <button
                onClick={() => setCreateModalOpen(false)}
                className="text-outline hover:text-white cursor-pointer"
              >
                <span className="material-symbols-outlined text-[18px]">close</span>
              </button>
            </div>

            <form onSubmit={handleDeployInstance} className="p-5 space-y-4">
              <div>
                <label className="text-xs font-semibold text-on-surface block mb-1">
                  Server Instance Name
                </label>
                <input
                  type="text"
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  placeholder="e.g., Creative Builders Hub"
                  className="w-full bg-surface-lowest border border-outline-variant/25 focus:border-primary rounded-lg px-3 py-2 text-xs text-white focus:outline-none"
                  autoFocus
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs font-semibold text-on-surface block mb-1">
                    Server Engine
                  </label>
                  <select
                    value={newEngine}
                    onChange={(e) => setNewEngine(e.target.value)}
                    className="w-full bg-surface-lowest border border-outline-variant/25 focus:border-primary rounded-lg px-3 py-2 text-xs text-white focus:outline-none"
                  >
                    <option value="PaperMC 1.20.4">PaperMC 1.20.4</option>
                    <option value="Purpur 1.20.4">Purpur 1.20.4</option>
                    <option value="Fabric 1.20.4">Fabric 1.20.4</option>
                    <option value="Folia 1.20.4">Folia 1.20.4</option>
                    <option value="Velocity 3.3.0">Velocity 3.3.0 Proxy</option>
                  </select>
                </div>

                <div>
                  <label className="text-xs font-semibold text-on-surface block mb-1">
                    TCP/UDP Port
                  </label>
                  <input
                    type="number"
                    value={newPort}
                    onChange={(e) => setNewPort(e.target.value)}
                    className="w-full bg-surface-lowest border border-outline-variant/25 focus:border-primary rounded-lg px-3 py-2 text-xs font-mono text-primary focus:outline-none"
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs font-semibold text-on-surface block mb-1">
                    Max Heap Allocation (GB)
                  </label>
                  <input
                    type="number"
                    min={1}
                    max={24}
                    value={newRamMax}
                    onChange={(e) => setNewRamMax(Number(e.target.value))}
                    className="w-full bg-surface-lowest border border-outline-variant/25 focus:border-primary rounded-lg px-3 py-2 text-xs font-mono text-white focus:outline-none"
                  />
                </div>

                <div>
                  <label className="text-xs font-semibold text-on-surface block mb-1">
                    Max Player Slots
                  </label>
                  <input
                    type="number"
                    min={1}
                    max={500}
                    value={newMaxPlayers}
                    onChange={(e) => setNewMaxPlayers(Number(e.target.value))}
                    className="w-full bg-surface-lowest border border-outline-variant/25 focus:border-primary rounded-lg px-3 py-2 text-xs font-mono text-white focus:outline-none"
                  />
                </div>
              </div>

              <div className="pt-2 flex items-center justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setCreateModalOpen(false)}
                  className="px-4 py-2 rounded-lg bg-surface-container-high text-xs font-medium text-outline hover:text-white cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="px-4 py-2 rounded-lg bg-gradient-to-r from-primary to-primary-container text-on-primary-container text-xs font-bold shadow-lg shadow-primary/20 cursor-pointer"
                >
                  Initialize &amp; Start Instance
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </main>
  );
};
