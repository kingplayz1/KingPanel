import React, { useState, useEffect, useCallback } from 'react';
import {
  ResponsiveContainer,
  AreaChart,
  Area,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
} from 'recharts';
import { ServerInstance, AuthUser, AuthProviderType, NavSection } from '../types';
import { HOTLINKED_IMAGES } from '../data/initialData';
import { DEFAULT_PROFILE_ICON_URL, PROFILE_ICON_OPTIONS } from '../utils/profileIcons';

interface PanelControlViewProps {
  servers: ServerInstance[];
  activeServer: ServerInstance;
  currentUser: AuthUser;
  globalRamCapGb: number;
  hostTotalRamGb: number;
  serverInstallRootDir: string;
  onUpdateServerInstallFolder: (
    newRootDir: string,
    updatedServerPaths?: Record<string, string>
  ) => void;
  onCreateServerInstance: (newServer: ServerInstance) => void;
  onUpdateGlobalRamConfig: (hostTotalGb: number, globalCapGb: number) => void;
  onUpdateServerRam: (serverId: string, newMaxGb: number) => void;
  onBatchUpdateServerRam: (allocations: Record<string, number>) => void;
  onServerPowerAction: (
    serverId: string,
    action: 'start' | 'restart' | 'stop' | 'kill'
  ) => void;
  onKillAllServers: () => void;
  onDeleteServerInstance: (serverId: string) => void;
  onSelectServer: (server: ServerInstance) => void;
  onNavigate: (section: NavSection) => void;
  onUpdateUserProfile: (updated: AuthUser) => void;
  onOpenAuthModal: (mode: 'signin' | 'signup') => void;
  onOpenDiscordBotGate?: (attemptedServerName?: string) => void;
  onLeaveDiscordServer?: () => void;
  onSignOut: () => void;
  onShowToast: (
    title: string,
    body?: string,
    type?: 'success' | 'info' | 'warning' | 'error',
    icon?: string
  ) => void;
}

interface LiveHostTelemetry {
  hostname: string;
  platform: string;
  kernelVersion: string;
  uptimeSeconds: number;
  cpuModel: string;
  cpuCores: number;
  cpuSpeedMhz: number;
  cpuUsagePct: number;
  perCorePct: number[];
  loadAvg1m: number;
  loadAvg5m: number;
  loadAvg15m: number;
  osTotalGb: number;
  osFreeGb: number;
  osAvailableGb: number;
  osUsedGb: number;
  osTotalMb: number;
  osUsedMb: number;
  osAvailableMb: number;
  buffersCachedMb: number;
  swapTotalMb: number;
  swapUsedMb: number;
  diskTotalGb: number;
  diskUsedGb: number;
  diskFreeGb: number;
  diskUsedPct: number;
  daemonPid: number;
  daemonRssMb: number;
  daemonHeapMb: number;
}

interface LocalPcUserInfo {
  username: string;
  uid: number;
  gid: number;
  homedir: string;
  shell: string;
  hostname: string;
  primaryNic: string;
  primaryIp: string;
  primaryMac: string;
  nodeVersion: string;
  v8Version: string;
  cwd: string;
  profileFilePath: string;
}

interface InstalledLocalSubfolder {
  folderName: string;
  displayPath: string;
  diskPath: string;
  hasEula: boolean;
  hasServerProperties: boolean;
  subfolders: string[];
  fileCount: number;
  modifiedAt: string;
}

interface LiveServerInstallConfig {
  installRootDir: string;
  resolvedDiskRoot: string;
  autoCreateSubfolders: boolean;
  autoAcceptEula: boolean;
  updatedAt: string;
  installedFolders: InstalledLocalSubfolder[];
}

interface LiveOsProcess {
  pid: number;
  user: string;
  command: string;
  args: string;
  cpuPct: number;
  memPct: number;
  rssMb: number;
  elapsed: string;
  isProtected: boolean;
  isSpawnedWorker: boolean;
}

interface PanelAuditEvent {
  id: string;
  time: string;
  category: 'RAM_ALLOC' | 'SIGKILL' | 'PROFILE' | 'OAUTH' | 'SYSTEM';
  message: string;
  actor: string;
}

interface RamStreamPoint {
  time: string;
  localPcUsedGb: number;
  activeUsedGb: number;
  allocatedGb: number;
}

const PRESET_AVATARS = [
  DEFAULT_PROFILE_ICON_URL,
  ...PROFILE_ICON_OPTIONS.slice(1, 3).map((p) => p.url),
  HOTLINKED_IMAGES.adminProfile,
  HOTLINKED_IMAGES.avatarMio,
  HOTLINKED_IMAGES.avatarAki,
  HOTLINKED_IMAGES.avatarKuro,
  HOTLINKED_IMAGES.avatarVoxel,
  HOTLINKED_IMAGES.serverIcon64,
];

const SERVER_BAR_COLORS = [
  'bg-primary',
  'bg-secondary',
  'bg-tertiary',
  'bg-amber-500',
  'bg-emerald-400',
  'bg-sky-400',
];

export const PanelControlView: React.FC<PanelControlViewProps> = ({
  servers,
  activeServer,
  currentUser,
  globalRamCapGb,
  hostTotalRamGb,
  serverInstallRootDir,
  onUpdateServerInstallFolder,
  onCreateServerInstance,
  onUpdateGlobalRamConfig,
  onUpdateServerRam,
  onBatchUpdateServerRam,
  onServerPowerAction,
  onKillAllServers,
  onDeleteServerInstance,
  onSelectServer,
  onNavigate,
  onUpdateUserProfile,
  onOpenAuthModal,
  onOpenDiscordBotGate,
  onLeaveDiscordServer,
  onSignOut,
  onShowToast,
}) => {
  const [activeTab, setActiveTab] = useState<
    'all' | 'install_folder' | 'ram' | 'servers' | 'profile'
  >('all');
  const [livePollEnabled, setLivePollEnabled] = useState<boolean>(true);
  const [hostTelemetry, setHostTelemetry] = useState<LiveHostTelemetry | null>(null);
  const [localPcUser, setLocalPcUser] = useState<LocalPcUserInfo | null>(null);
  const [installConfig, setInstallConfig] = useState<LiveServerInstallConfig | null>(null);
  const [osProcesses, setOsProcesses] = useState<LiveOsProcess[]>([]);
  const [auditEvents, setAuditEvents] = useState<PanelAuditEvent[]>([]);
  const [lastHeartbeat, setLastHeartbeat] = useState<string>(new Date().toLocaleTimeString());
  const [autoSyncedLocalRamOnce, setAutoSyncedLocalRamOnce] = useState<boolean>(false);
  const [spawningWorker, setSpawningWorker] = useState<boolean>(false);

  // Server Installation Folder State
  const [installRootInput, setInstallRootInput] = useState<string>(serverInstallRootDir);
  const [autoCreateSubfolders, setAutoCreateSubfolders] = useState<boolean>(true);
  const [autoAcceptEula, setAutoAcceptEula] = useState<boolean>(true);
  const [savingInstallFolder, setSavingInstallFolder] = useState<boolean>(false);

  // Quick New Server Installer (into the configured folder)
  const [quickSrvName, setQuickSrvName] = useState<string>('Survival_Kingdom_S5');
  const [quickSrvEngine, setQuickSrvEngine] = useState<string>('PaperMC 1.21.4');
  const [quickSrvPort, setQuickSrvPort] = useState<number>(25575);
  const [quickSrvRamGb, setQuickSrvRamGb] = useState<number>(6);
  const [installingServer, setInstallingServer] = useState<boolean>(false);

  // Real-Time User Profile State (with Live Sync to Local PC Disk)
  const [username, setUsername] = useState(currentUser.username);
  const [displayName, setDisplayName] = useState(currentUser.displayName);
  const [email, setEmail] = useState(currentUser.email);
  const [role, setRole] = useState<AuthUser['role']>(currentUser.role);
  const [mcUuid, setMcUuid] = useState(
    currentUser.mcUuid || '069a79f4-44e9-4726-a5be-fca90e38aaf5'
  );
  const [avatarUrl, setAvatarUrl] = useState(currentUser.avatarUrl);
  const [newPassword, setNewPassword] = useState('');
  const [liveAutoSyncProfile, setLiveAutoSyncProfile] = useState<boolean>(true);
  const [lastProfileSyncTime, setLastProfileSyncTime] = useState<string>('Synced to Local PC Disk');

  // Real-Time Mojang Lookup State
  const [mojangLookupInput, setMojangLookupInput] = useState<string>('');
  const [mojangLoading, setMojangLoading] = useState<boolean>(false);

  useEffect(() => {
    setInstallRootInput(serverInstallRootDir);
  }, [serverInstallRootDir]);

  // Global RAM Calculations
  const osReservedGb = Number(Math.max(1, hostTotalRamGb - globalRamCapGb).toFixed(1));
  const totalAllocatedGb = Number(
    servers.reduce((acc, s) => acc + s.ramMaxGb, 0).toFixed(1)
  );
  const totalActiveUsedGb = Number(
    servers
      .filter((s) => s.status === 'running' || s.status === 'restarting')
      .reduce((acc, s) => acc + s.ramUsedGb, 0)
      .toFixed(1)
  );
  const freePoolGb = Number(Math.max(0, globalRamCapGb - totalAllocatedGb).toFixed(1));
  const isOverCommitted = totalAllocatedGb > globalRamCapGb;

  const runningServersCount = servers.filter(
    (s) => s.status === 'running' || s.status === 'restarting'
  ).length;

  // Real-Time Memory Telemetry Stream for Recharts
  const [ramStream, setRamStream] = useState<RamStreamPoint[]>(() => {
    const now = Date.now();
    return Array.from({ length: 16 }, (_, i) => {
      const t = new Date(now - (15 - i) * 2000).toTimeString().split(' ')[0];
      return {
        time: t,
        localPcUsedGb: osReservedGb,
        activeUsedGb: totalActiveUsedGb,
        allocatedGb: totalAllocatedGb,
      };
    });
  });

  // Fetch Real-Time Host Telemetry, Local PC OS User, Install Config, & OS Processes from Backend
  const fetchPanelTelemetry = useCallback(async () => {
    try {
      const r = await fetch('/api/panel/telemetry');
      const data = await r.json();
      if (data.ok) {
        const liveHost: LiveHostTelemetry = data.host;
        setHostTelemetry(liveHost);
        if (data.localPcUser) {
          setLocalPcUser(data.localPcUser);
        }
        if (data.installConfig) {
          setInstallConfig(data.installConfig);
        }
        setOsProcesses(data.osProcesses || []);
        setAuditEvents(data.auditLog || []);
        setLastHeartbeat(new Date().toLocaleTimeString());

        if (!autoSyncedLocalRamOnce && liveHost.osTotalGb > 0) {
          setAutoSyncedLocalRamOnce(true);
          const detectedTotal = Math.max(4, Math.round(liveHost.osTotalGb));
          const detectedCap = Math.max(
            2,
            Number((detectedTotal - Math.max(1, Math.round(detectedTotal * 0.12))).toFixed(1))
          );
          onUpdateGlobalRamConfig(detectedTotal, detectedCap);
        }

        const nowStr = new Date().toTimeString().split(' ')[0];
        setRamStream((prev) => [
          ...prev.slice(-19),
          {
            time: nowStr,
            localPcUsedGb: liveHost.osUsedGb,
            activeUsedGb: totalActiveUsedGb,
            allocatedGb: totalAllocatedGb,
          },
        ]);
      }
    } catch {
      // ignore transient error
    }
  }, [autoSyncedLocalRamOnce, onUpdateGlobalRamConfig, totalActiveUsedGb, totalAllocatedGb]);

  useEffect(() => {
    fetchPanelTelemetry();
  }, [fetchPanelTelemetry]);

  useEffect(() => {
    if (!livePollEnabled) return;
    const interval = setInterval(() => {
      fetchPanelTelemetry();
    }, 2000);
    return () => clearInterval(interval);
  }, [livePollEnabled, fetchPanelTelemetry]);

  // Real-time Auto-Sync of Operator Profile to Local PC Disk (.local-operator-profile.json)
  useEffect(() => {
    if (!liveAutoSyncProfile) return;
    const cleanedUsername = username.trim().replace(/\s+/g, '_') || 'Operator_King';
    const nextUser: AuthUser = {
      ...currentUser,
      username: cleanedUsername,
      displayName: displayName.trim() || cleanedUsername,
      email: email.trim() || 'operator@kingsmp.local',
      role,
      mcUuid: mcUuid.trim(),
      avatarUrl: avatarUrl.trim() || PRESET_AVATARS[0],
    };

    const changed =
      nextUser.username !== currentUser.username ||
      nextUser.displayName !== currentUser.displayName ||
      nextUser.email !== currentUser.email ||
      nextUser.role !== currentUser.role ||
      nextUser.mcUuid !== currentUser.mcUuid ||
      nextUser.avatarUrl !== currentUser.avatarUrl;

    if (!changed) return;

    const timer = setTimeout(async () => {
      onUpdateUserProfile(nextUser);
      setLastProfileSyncTime(`Saved ${new Date().toLocaleTimeString()}`);
      try {
        const r = await fetch('/api/panel/profile-sync', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            user: nextUser,
            changeNote: `Real-time local PC disk profile sync: @${nextUser.username} (${nextUser.role})`,
          }),
        });
        const data = await r.json();
        if (data.ok && data.auditLog) {
          setAuditEvents(data.auditLog);
        }
      } catch {
        // ignore
      }
    }, 320);

    return () => clearTimeout(timer);
  }, [
    username,
    displayName,
    email,
    role,
    mcUuid,
    avatarUrl,
    liveAutoSyncProfile,
    currentUser,
    onUpdateUserProfile,
  ]);

  // Apply Global Server Installation Folder & Provision All Server Subfolders Inside It
  const handleApplyInstallFolder = async (customRoot?: string) => {
    const targetRoot = (customRoot ?? installRootInput).trim();
    if (!targetRoot) {
      onShowToast('Folder Path Required', 'Enter a valid installation directory path.', 'warning');
      return;
    }
    setSavingInstallFolder(true);
    try {
      const r = await fetch('/api/panel/install-folder', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          installRootDir: targetRoot,
          autoCreateSubfolders,
          autoAcceptEula,
          servers: servers.map((s) => ({
            id: s.id,
            name: s.name,
            engine: s.engine,
            port: s.port,
            ramMaxGb: s.ramMaxGb,
          })),
          actor: currentUser.displayName,
        }),
      });
      const data = await r.json();
      if (!r.ok || !data.ok) {
        throw new Error(data.error || 'Failed to configure server installation folder');
      }
      setInstallRootInput(targetRoot);
      if (data.installConfig) {
        setInstallConfig(data.installConfig);
      }
      if (data.auditLog) {
        setAuditEvents(data.auditLog);
      }
      onUpdateServerInstallFolder(targetRoot, data.updatedServerPaths);
      onShowToast(
        'Global Server Install Folder Applied',
        `All servers are now installed inside "${targetRoot}" (${servers.length} subfolders provisioned on local PC disk).`,
        'success',
        'create_new_folder'
      );
    } catch (err) {
      onShowToast(
        'Install Folder Error',
        err instanceof Error ? err.message : 'Failed to update installation folder',
        'error',
        'error'
      );
    } finally {
      setSavingInstallFolder(false);
    }
  };

  // Install a New Server Directly Inside the Configured Global Installation Folder
  const handleQuickInstallServerInFolder = async (e: React.FormEvent) => {
    e.preventDefault();
    const isDiscordVerified = Boolean(currentUser.discordVerified);
    const maxAllowed = isDiscordVerified ? currentUser.maxServerLimit || 10 : 2;
    if (servers.length >= maxAllowed) {
      if (onOpenDiscordBotGate) {
        onOpenDiscordBotGate(quickSrvName.trim() || `Server #${servers.length + 1}`);
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
    if (!quickSrvName.trim()) {
      onShowToast('Server Name Required', 'Enter a name for the new server.', 'warning');
      return;
    }
    setInstallingServer(true);
    try {
      const r = await fetch('/api/panel/install-server-instance', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          serverName: quickSrvName.trim(),
          engine: quickSrvEngine,
          port: quickSrvPort,
          ramMaxGb: quickSrvRamGb,
          actor: currentUser.displayName,
          currentServerCount: servers.length,
          discordVerified: isDiscordVerified,
        }),
      });
      const data = await r.json();
      if (r.status === 403 && data?.code === 'DISCORD_VERIFICATION_REQUIRED') {
        if (onOpenDiscordBotGate) {
          onOpenDiscordBotGate(quickSrvName.trim());
        }
        setInstallingServer(false);
        return;
      }
      if (!r.ok || !data.ok) {
        throw new Error(data.error || 'Failed to install server into folder');
      }
      if (data.installConfig) {
        setInstallConfig(data.installConfig);
      }
      if (data.auditLog) {
        setAuditEvents(data.auditLog);
      }

      const newSrv: ServerInstance = {
        id: `srv-${Date.now()}`,
        name: quickSrvName.trim(),
        engine: quickSrvEngine,
        javaVersion: 'Java 21',
        port: quickSrvPort,
        pid: Math.floor(12000 + Math.random() * 18000),
        status: 'running',
        path: data.displayPath,
        build: 'Latest Verified Build',
        tps: 20.0,
        tickMs: 2.2,
        uptime: '0h 01m',
        playersOnline: 0,
        maxPlayers: 60,
        cpuUsage: 9,
        cpuTemp: 44.0,
        ramUsedGb: Number((quickSrvRamGb * 0.35).toFixed(1)),
        ramMaxGb: quickSrvRamGb,
      };
      onCreateServerInstance(newSrv);
      setQuickSrvName(`Server_Node_${servers.length + 1}`);
      setQuickSrvPort((prev) => prev + 1);
      onShowToast(
        `Installed ${newSrv.name} in Folder`,
        `Provisioned "${data.displayPath}" with eula.txt, server.properties, plugins/, mods/, and world/.`,
        'success',
        'folder_managed'
      );
    } catch (err) {
      onShowToast(
        'Server Installation Failed',
        err instanceof Error ? err.message : 'Could not install server in folder',
        'error',
        'error'
      );
    } finally {
      setInstallingServer(false);
    }
  };

  // Sync Global RAM Allocator with Local PC Physical RAM
  const handleSyncToRealLocalPcRam = () => {
    if (!hostTelemetry) return;
    const realTotalGb = Math.max(4, Number(hostTelemetry.osTotalGb.toFixed(1)));
    const reserveGb = Math.max(1, Number((realTotalGb * 0.12).toFixed(1)));
    const realCapGb = Number(Math.max(2, realTotalGb - reserveGb).toFixed(1));
    onUpdateGlobalRamConfig(realTotalGb, realCapGb);
    syncRamWithBackend({ hostTotalGb: realTotalGb, globalCapGb: realCapGb });
    onShowToast(
      `Synced to Real Local PC RAM (${realTotalGb} GB)`,
      `Detected ${hostTelemetry.osTotalMb} MB physical memory on ${hostTelemetry.hostname}. Pool cap set to ${realCapGb} GB.`,
      'success',
      'memory'
    );
  };

  // Real-Time Backend Sync helper for RAM Allocator changes
  const syncRamWithBackend = async (payload: {
    hostTotalGb?: number;
    globalCapGb?: number;
    serverName?: string;
    newMaxGb?: number;
  }) => {
    try {
      const r = await fetch('/api/panel/ram-sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...payload,
          actor: currentUser.displayName,
        }),
      });
      const data = await r.json();
      if (data.ok && data.auditLog) {
        setAuditEvents(data.auditLog);
      }
    } catch {
      // ignore
    }
  };

  // Real-Time Backend Sync helper for Server Kill / Power Actions
  const handleLiveServerAction = async (
    srv: ServerInstance,
    action: 'start' | 'restart' | 'stop' | 'kill'
  ) => {
    onServerPowerAction(srv.id, action);
    try {
      const r = await fetch('/api/panel/server-kill', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          serverId: srv.id,
          serverName: srv.name,
          pid: srv.pid,
          action,
          actor: currentUser.displayName,
        }),
      });
      const data = await r.json();
      if (data.ok && data.auditLog) {
        setAuditEvents(data.auditLog);
      }
    } catch {
      // ignore
    }
  };

  const handleLiveKillAllServers = async () => {
    onKillAllServers();
    try {
      const r = await fetch('/api/panel/server-kill', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'kill_all',
          actor: currentUser.displayName,
        }),
      });
      const data = await r.json();
      if (data.ok && data.auditLog) {
        setAuditEvents(data.auditLog);
      }
    } catch {
      // ignore
    }
  };

  // Spawn a real background OS child process on the Local PC so user can see and kill a live OS PID
  const handleSpawnLocalPcProcess = async () => {
    setSpawningWorker(true);
    try {
      const r = await fetch('/api/panel/spawn-local-worker', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: `LocalPC-MC-Worker-${Math.floor(100 + Math.random() * 899)}`,
          memoryMb: 28,
        }),
      });
      const data = await r.json();
      if (!r.ok || !data.ok) {
        throw new Error(data.error || 'Could not spawn local PC process');
      }
      if (data.auditLog) setAuditEvents(data.auditLog);
      await fetchPanelTelemetry();
      onShowToast(
        `Spawned Real Local PC Process (PID ${data.pid})`,
        `Process "${data.name}" is now running on your local OS kernel. You can SIGKILL it below.`,
        'success',
        'terminal'
      );
    } catch (err) {
      onShowToast(
        'Local Process Spawn Error',
        err instanceof Error ? err.message : 'Failed to spawn process',
        'error',
        'error'
      );
    } finally {
      setSpawningWorker(false);
    }
  };

  // Kill a real OS PID on the Local PC using process.kill(pid, 'SIGKILL')
  const handleKillRealLocalPid = async (proc: LiveOsProcess) => {
    if (proc.isProtected) {
      onShowToast(
        `Protected Local PC Daemon (PID ${proc.pid})`,
        `PID ${proc.pid} (${proc.command}) is the active panel root daemon or OS init and is protected.`,
        'warning',
        'shield'
      );
      return;
    }
    try {
      const r = await fetch('/api/panel/kill-local-pid', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          pid: proc.pid,
          signal: 'SIGKILL',
          actor: currentUser.displayName,
        }),
      });
      const data = await r.json();
      if (!r.ok || !data.ok) {
        throw new Error(data.error || `Failed to kill PID ${proc.pid}`);
      }
      if (data.auditLog) setAuditEvents(data.auditLog);
      await fetchPanelTelemetry();
      onShowToast(
        `Killed Local PC Process PID ${proc.pid}`,
        `Dispatched OS SIGKILL (-9) to "${proc.command}" (${proc.rssMb} MB RSS freed).`,
        'error',
        'bolt'
      );
    } catch (err) {
      onShowToast(
        `Cannot Kill PID ${proc.pid}`,
        err instanceof Error ? err.message : 'OS kernel rejected SIGKILL',
        'warning',
        'lock'
      );
    }
  };

  // Import Local PC OS User Account (os.userInfo()) into Operator Profile
  const handleImportLocalPcUserToProfile = () => {
    if (!localPcUser) return;
    const osHandle = `${localPcUser.username}_${localPcUser.hostname}`.replace(
      /[^a-zA-Z0-9_-]/g,
      '_'
    );
    const osDisplay = `${localPcUser.username}@${localPcUser.hostname} (Local PC Root)`;
    const osEmail = `${localPcUser.username}@${localPcUser.hostname}.local`;
    setUsername(osHandle);
    setDisplayName(osDisplay);
    setEmail(osEmail);
    setRole('Root Admin');
    onShowToast(
      `Imported Local PC OS Account`,
      `Synced profile with ${localPcUser.username}@${localPcUser.hostname} (UID ${localPcUser.uid} • ${localPcUser.primaryIp}).`,
      'success',
      'computer'
    );
  };

  // Real-Time Mojang Minecraft Account Lookup
  const handleLookupMojangProfile = async (ignToFetch?: string) => {
    const targetIgn = (ignToFetch || mojangLookupInput || username).trim();
    if (!targetIgn) return;
    setMojangLoading(true);
    try {
      const r = await fetch(`/api/panel/mojang/${encodeURIComponent(targetIgn)}`);
      const data = await r.json();
      if (!r.ok || !data.ok) {
        throw new Error(data.error || `Mojang player "${targetIgn}" not found`);
      }
      setUsername(data.ign);
      setDisplayName(`${data.ign} — Sovereign Operator`);
      setMcUuid(data.uuid);
      setAvatarUrl(data.avatarUrl);
      if (data.auditLog) setAuditEvents(data.auditLog);

      onShowToast(
        `Mojang Identity Synced: ${data.ign}`,
        `UUID: ${data.uuid} • Live 3D head avatar applied.`,
        'success',
        'verified'
      );
    } catch (err) {
      onShowToast(
        'Mojang Lookup Notice',
        err instanceof Error ? err.message : 'Could not resolve Minecraft username',
        'warning',
        'person_search'
      );
    } finally {
      setMojangLoading(false);
    }
  };

  // Auto-Balance Presets for Global RAM Allocator
  const handleAutoBalanceEqual = () => {
    const perServer = Math.max(
      1,
      Math.floor((globalRamCapGb / Math.max(1, servers.length)) * 2) / 2
    );
    const map: Record<string, number> = {};
    servers.forEach((s) => {
      map[s.id] = perServer;
    });
    onBatchUpdateServerRam(map);
    syncRamWithBackend({
      hostTotalGb: hostTotalRamGb,
      globalCapGb: globalRamCapGb,
      serverName: 'All Fleet Instances (Equal Auto-Balance)',
      newMaxGb: perServer,
    });
    onShowToast(
      'Balanced Fleet RAM Pool',
      `Assigned ${perServer} GB (-Xmx) equally across all ${servers.length} instances.`,
      'success',
      'memory'
    );
  };

  const handlePrioritizeOnline = () => {
    const map: Record<string, number> = {};
    const onlineCount = Math.max(1, runningServersCount);
    const onlineShare = Math.max(2, Math.floor((globalRamCapGb * 0.8) / onlineCount));
    servers.forEach((s) => {
      map[s.id] = s.status === 'running' ? onlineShare : 1.5;
    });
    onBatchUpdateServerRam(map);
    syncRamWithBackend({
      serverName: 'Running Fleet Priority Pool',
      newMaxGb: onlineShare,
    });
    onShowToast(
      'Online Priority RAM Applied',
      `Allocated ${onlineShare} GB to each running server and 1.5 GB standby cap to offline nodes.`,
      'success',
      'bolt'
    );
  };

  const handleEcoFootprint = () => {
    const map: Record<string, number> = {};
    servers.forEach((s) => {
      map[s.id] = s.engine.toLowerCase().includes('velocity') ? 1 : 2.5;
    });
    onBatchUpdateServerRam(map);
    syncRamWithBackend({
      serverName: 'Eco Host Profile',
      newMaxGb: 2.5,
    });
    onShowToast(
      'Eco Host Memory Profile Active',
      'Capped standard servers at 2.5 GB and proxies at 1 GB to free Local PC memory.',
      'info',
      'eco'
    );
  };

  const handleSaveProfile = async (e: React.FormEvent) => {
    e.preventDefault();
    const cleanedUsername = username.trim().replace(/\s+/g, '_') || 'Operator_King';
    const updatedUser: AuthUser = {
      ...currentUser,
      username: cleanedUsername,
      displayName: displayName.trim() || cleanedUsername,
      email: email.trim() || 'operator@kingsmp.local',
      role,
      mcUuid: mcUuid.trim(),
      avatarUrl: avatarUrl.trim() || PRESET_AVATARS[0],
    };
    onUpdateUserProfile(updatedUser);
    setNewPassword('');
    setLastProfileSyncTime(`Saved ${new Date().toLocaleTimeString()}`);
    try {
      const r = await fetch('/api/panel/profile-sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          user: updatedUser,
          changeNote: `Committed operator profile @${updatedUser.username} to Local PC disk`,
        }),
      });
      const data = await r.json();
      if (data.ok && data.auditLog) setAuditEvents(data.auditLog);
    } catch {
      // ignore
    }
    onShowToast(
      'Profile Saved to Local PC Disk',
      `Persisted @${updatedUser.username} to ${
        localPcUser?.profileFilePath || '.local-operator-profile.json'
      }.`,
      'success',
      'manage_accounts'
    );
  };

  const handleToggleConnectedProvider = async (provider: AuthProviderType) => {
    const exists = currentUser.connectedProviders.includes(provider);
    if (exists && currentUser.connectedProviders.length <= 1) {
      onShowToast(
        'Primary Auth Required',
        'At least one authentication provider must remain linked.',
        'warning',
        'lock'
      );
      return;
    }
    const nextProviders = exists
      ? currentUser.connectedProviders.filter((p) => p !== provider)
      : [...currentUser.connectedProviders, provider];

    const updated: AuthUser = {
      ...currentUser,
      connectedProviders: nextProviders,
    };
    onUpdateUserProfile(updated);
    try {
      const r = await fetch('/api/panel/profile-sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          user: updated,
          changeNote: `${
            exists ? 'Unlinked' : 'Linked'
          } ${provider.toUpperCase()} OAuth provider on Local PC`,
        }),
      });
      const data = await r.json();
      if (data.ok && data.auditLog) setAuditEvents(data.auditLog);
    } catch {
      // ignore
    }
    onShowToast(
      exists ? `Unlinked ${provider.toUpperCase()}` : `Linked ${provider.toUpperCase()} Identity`,
      exists
        ? `Removed ${provider} OAuth token binding from local profile.`
        : `Connected ${provider} OAuth account to local operator profile.`,
      exists ? 'info' : 'success',
      'verified_user'
    );
  };

  const formatUptime = (sec?: number) => {
    if (!sec) return '0h 00m';
    const hrs = Math.floor(sec / 3600);
    const mins = Math.floor((sec % 3600) / 60);
    return `${hrs}h ${mins}m (${sec}s)`;
  };

  const previewCleanRoot = installRootInput.trim().replace(/[\\/]+$/, '') || '/KingServers';
  const previewSep = previewCleanRoot.includes('\\') ? '\\' : '/';
  const previewCleanSubfolder =
    quickSrvName
      .trim()
      .replace(/[^a-zA-Z0-9_-]/g, '_')
      .replace(/_+/g, '_') || 'New_Server';
  const previewTargetFolder = autoCreateSubfolders
    ? `${previewCleanRoot}${previewSep}${previewCleanSubfolder}`
    : previewCleanRoot;

  return (
    <div className="flex-1 overflow-y-auto p-6 space-y-6">
      {/* ================= 1. TOP REAL-TIME LOCAL PC HARDWARE, KERNEL, DISK & OS USER TELEMETRY BAR ================= */}
      <div className="p-5 rounded-xl bg-surface-container-low border border-white/10 shadow-lg space-y-4">
        <div className="flex flex-col xl:flex-row xl:items-center justify-between gap-4">
          <div className="space-y-1.5">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="font-label-caps text-label-caps uppercase text-primary tracking-widest">
                Local PC Kernel &amp; Workstation Control
              </span>
              <span className="text-on-surface-variant/40 text-xs">/</span>
              <span className="font-headline-sm text-headline-sm text-white font-bold">
                Real-Time Local PC Telemetry, Install Folder, Global RAM &amp; Profile
              </span>
              <span className="px-2.5 py-0.5 rounded-full bg-secondary/15 text-secondary border border-secondary/30 font-code-sm text-code-sm font-bold flex items-center gap-1.5">
                <span
                  className={`size-2 rounded-full ${
                    livePollEnabled ? 'bg-secondary animate-ping' : 'bg-outline'
                  }`}
                />
                {livePollEnabled ? `LOCAL PC LIVE (${lastHeartbeat})` : 'POLLING PAUSED'}
              </span>
            </div>
            <p className="font-body-sm text-body-sm text-on-surface-variant">
              Configure your Global Server Installation Folder, allocate Local PC RAM, manage live
              OS processes (`ps -eo`), and sync your operator profile to local disk in real time.
            </p>
          </div>

          {/* Section Filter Tabs + Live Stream Toggle */}
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => fetchPanelTelemetry()}
              className="px-3 py-1.5 rounded-lg bg-surface-container-high hover:bg-surface-bright text-white font-code-sm text-code-sm font-bold flex items-center gap-1.5 border border-white/10 cursor-pointer"
            >
              <span className="material-symbols-outlined text-sm text-primary">refresh</span>
              <span>Poll Local PC</span>
            </button>

            <button
              type="button"
              onClick={() => setLivePollEnabled(!livePollEnabled)}
              className={`px-3 py-1.5 rounded-lg font-code-sm text-code-sm font-bold flex items-center gap-1.5 border cursor-pointer ${
                livePollEnabled
                  ? 'bg-secondary/15 text-secondary border-secondary/30'
                  : 'bg-surface-container-high text-outline border-white/10'
              }`}
            >
              <span className="material-symbols-outlined text-sm">sensors</span>
              <span>{livePollEnabled ? '2s Stream: ON' : 'Stream: PAUSED'}</span>
            </button>

            <div className="flex flex-wrap items-center gap-1 bg-surface-container-lowest p-1 rounded-xl border border-white/10">
              {[
                { id: 'all', label: 'All Controls', icon: 'tune' },
                { id: 'install_folder', label: 'Server Install Folder', icon: 'create_new_folder' },
                { id: 'ram', label: 'Global RAM', icon: 'memory' },
                { id: 'servers', label: 'Servers & PIDs', icon: 'terminal' },
                { id: 'profile', label: 'Profile', icon: 'manage_accounts' },
              ].map((t) => (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => setActiveTab(t.id as typeof activeTab)}
                  className={`px-3 py-1.5 rounded-lg font-code-sm text-code-sm flex items-center gap-1.5 transition-all cursor-pointer ${
                    activeTab === t.id
                      ? 'bg-primary text-on-primary font-bold shadow-sm'
                      : 'text-on-surface-variant hover:text-white'
                  }`}
                >
                  <span className="material-symbols-outlined text-sm">{t.icon}</span>
                  <span>{t.label}</span>
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* Live Local PC Hardware, Kernel, Disk, NIC & OS User Telemetry Strip */}
        {hostTelemetry && (
          <div className="pt-3 border-t border-white/10 space-y-3">
            <div className="grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-6 gap-2.5 font-mono text-xs">
              <div className="p-2.5 rounded-lg bg-surface-container border border-white/5">
                <span className="text-[10px] text-outline uppercase block">
                  Local PC Hostname &amp; OS
                </span>
                <span className="text-white font-bold truncate block">
                  {hostTelemetry.hostname}
                </span>
                <span className="text-[10px] text-tertiary truncate block">
                  {hostTelemetry.platform} • Up {formatUptime(hostTelemetry.uptimeSeconds)}
                </span>
              </div>

              <div className="p-2.5 rounded-lg bg-surface-container border border-white/5">
                <span className="text-[10px] text-outline uppercase block">
                  Local PC CPU ({hostTelemetry.cpuCores} Cores)
                </span>
                <span className="text-primary font-bold truncate block">
                  {hostTelemetry.cpuUsagePct}% Load @ {hostTelemetry.cpuSpeedMhz} MHz
                </span>
                <span
                  className="text-[10px] text-secondary truncate block"
                  title={hostTelemetry.cpuModel}
                >
                  {hostTelemetry.cpuModel}
                </span>
              </div>

              <div className="p-2.5 rounded-lg bg-surface-container border border-white/5">
                <span className="text-[10px] text-outline uppercase block">
                  Local PC RAM (/proc/meminfo)
                </span>
                <span className="text-secondary font-bold">
                  {hostTelemetry.osUsedGb} / {hostTelemetry.osTotalGb} GB
                </span>
                <span className="text-[10px] text-on-surface-variant block">
                  Avail: {hostTelemetry.osAvailableGb} GB ({hostTelemetry.buffersCachedMb}M Cache)
                </span>
              </div>

              <div className="p-2.5 rounded-lg bg-surface-container border border-white/5">
                <span className="text-[10px] text-outline uppercase block">
                  Local PC Root Disk (df -k /)
                </span>
                <span className="text-white font-bold">
                  {hostTelemetry.diskUsedGb} / {hostTelemetry.diskTotalGb} GB (
                  {hostTelemetry.diskUsedPct}%)
                </span>
                <span className="text-[10px] text-secondary block">
                  Free Disk: {hostTelemetry.diskFreeGb} GB
                </span>
              </div>

              <div className="p-2.5 rounded-lg bg-surface-container border border-white/5">
                <span className="text-[10px] text-outline uppercase block">
                  Server Install Folder
                </span>
                <span
                  className="text-primary font-bold truncate block"
                  title={serverInstallRootDir}
                >
                  {serverInstallRootDir}
                </span>
                <span className="text-[10px] text-secondary truncate block">
                  {installConfig?.installedFolders.length || servers.length} Subfolders Installed
                </span>
              </div>

              <div className="p-2.5 rounded-lg bg-surface-container border border-white/5">
                <span className="text-[10px] text-outline uppercase block">
                  Local PC OS User (os.userInfo)
                </span>
                <span className="text-primary font-bold truncate block">
                  {localPcUser?.username || 'root'}@{hostTelemetry.hostname}
                </span>
                <span className="text-[10px] text-secondary truncate block">
                  UID {localPcUser?.uid ?? 0} • {localPcUser?.primaryIp || '127.0.0.1'}
                </span>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* ================= 1B. GLOBAL SERVER INSTALLATION FOLDER & SUBFOLDER PROVISIONER ================= */}
      {(activeTab === 'all' || activeTab === 'install_folder') && (
        <section className="p-6 rounded-xl bg-surface-container-low border border-primary/30 shadow-lg space-y-5">
          <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4 pb-3 border-b border-white/10">
            <div className="flex items-start gap-3">
              <div className="p-2.5 rounded-xl bg-primary/15 text-primary border border-primary/30">
                <span className="material-symbols-outlined text-2xl">create_new_folder</span>
              </div>
              <div>
                <h2 className="font-headline-sm text-headline-sm text-white font-bold flex items-center gap-2 flex-wrap">
                  Global Server Installation Root Folder &amp; Subfolder Manager
                  <span className="px-2 py-0.5 rounded bg-secondary/15 text-secondary border border-secondary/30 font-code-sm text-code-sm">
                    {installConfig?.installedFolders.length || servers.length} INSTALLED SUBFOLDERS ON LOCAL PC
                  </span>
                </h2>
                <p className="font-body-sm text-body-sm text-on-surface-variant">
                  Set the master folder where all Minecraft servers are installed. Every server
                  instance is automatically provisioned inside its own dedicated subfolder (`
                  {previewCleanRoot}
                  {previewSep}&lt;Server_Folder&gt;{previewSep}`) with `server.properties`,
                  `eula.txt`, `plugins/`, `mods/`, and `world/`.
                </p>
              </div>
            </div>

            {/* Quick Local PC Folder Presets */}
            <div className="flex flex-wrap items-center gap-1.5">
              {[
                {
                  label: 'Local PC Workspace',
                  path: `${localPcUser?.cwd || '/workspace'}/KingServers`,
                },
                {
                  label: 'Local PC Home',
                  path: `${localPcUser?.homedir || '/root'}/KingServers`,
                },
                { label: 'Windows C:\\KingServers', path: 'C:\\KingServers' },
                { label: 'NVMe Array D:\\MC_Servers', path: 'D:\\MC_Servers' },
              ].map((preset) => (
                <button
                  key={preset.label}
                  type="button"
                  onClick={() => {
                    setInstallRootInput(preset.path);
                    handleApplyInstallFolder(preset.path);
                  }}
                  className={`px-2.5 py-1.5 rounded-lg font-mono text-xs font-bold border transition-all cursor-pointer ${
                    installRootInput === preset.path
                      ? 'bg-primary text-on-primary border-primary'
                      : 'bg-surface-container-high hover:bg-surface-bright text-on-surface border-white/10'
                  }`}
                >
                  {preset.label}
                </button>
              ))}
            </div>
          </div>

          {/* Left: Set Global Install Folder Form | Right: Quick Install New Server into Folder */}
          <div className="grid grid-cols-1 xl:grid-cols-12 gap-5">
            {/* Configure Global Server Install Folder (7 cols) */}
            <div className="xl:col-span-7 p-4 rounded-xl bg-surface-container border border-white/10 space-y-4 flex flex-col justify-between">
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <label className="font-label-caps text-label-caps uppercase text-primary flex items-center gap-1.5">
                    <span className="material-symbols-outlined text-sm">folder_managed</span>
                    Master Server Installation Folder Path (All Servers Install Inside Here)
                  </label>
                  <span className="font-mono text-[11px] text-secondary">
                    Real Local Disk: {installConfig?.resolvedDiskRoot || previewCleanRoot}
                  </span>
                </div>

                <div className="flex flex-col sm:flex-row gap-2">
                  <input
                    type="text"
                    value={installRootInput}
                    onChange={(e) => setInstallRootInput(e.target.value)}
                    placeholder="Enter folder path (e.g. C:\KingServers or /home/user/KingServers)..."
                    className="flex-1 px-3.5 py-2.5 rounded-lg bg-surface-container-lowest text-white font-mono text-xs border border-white/15 focus:outline-none focus:border-primary"
                  />
                  <button
                    type="button"
                    disabled={savingInstallFolder}
                    onClick={() => handleApplyInstallFolder()}
                    className="px-4 py-2.5 rounded-lg bg-primary hover:bg-primary-fixed text-on-primary font-mono text-xs font-bold flex items-center justify-center gap-1.5 shadow-lg shadow-primary/20 cursor-pointer shrink-0"
                  >
                    <span className="material-symbols-outlined text-sm">save</span>
                    <span>
                      {savingInstallFolder
                        ? 'Provisioning Folders...'
                        : 'Set Install Folder & Apply to All Servers'}
                    </span>
                  </button>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5 pt-1">
                  <label className="p-2.5 rounded-lg bg-surface-container-lowest border border-white/5 flex items-center gap-2.5 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={autoCreateSubfolders}
                      onChange={(e) => setAutoCreateSubfolders(e.target.checked)}
                      className="accent-amber-400"
                    />
                    <div className="text-xs">
                      <span className="text-white font-bold block">
                        Dedicated Subfolder Per Server
                      </span>
                      <span className="font-mono text-[10px] text-outline">
                        Installs in {previewCleanRoot}
                        {previewSep}&lt;ServerName&gt;{previewSep}
                      </span>
                    </div>
                  </label>

                  <label className="p-2.5 rounded-lg bg-surface-container-lowest border border-white/5 flex items-center gap-2.5 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={autoAcceptEula}
                      onChange={(e) => setAutoAcceptEula(e.target.checked)}
                      className="accent-amber-400"
                    />
                    <div className="text-xs">
                      <span className="text-white font-bold block">
                        Auto-Generate EULA &amp; Sub-Directories
                      </span>
                      <span className="font-mono text-[10px] text-secondary">
                        Writes eula=true, server.properties, plugins/, mods/, world/
                      </span>
                    </div>
                  </label>
                </div>
              </div>

              <div className="p-3 rounded-lg bg-surface-container-lowest border border-white/5 font-mono text-xs flex flex-wrap items-center justify-between gap-2">
                <div>
                  <span className="text-outline uppercase text-[10px] block">
                    Active Global Installation Directory Structure
                  </span>
                  <span className="text-secondary font-bold">
                    {previewCleanRoot}
                    {previewSep}
                    <span className="text-primary">&lt;Server_Instance_Folder&gt;</span>
                    {previewSep}
                    <span className="text-white/80">
                      &#123;server.jar, eula.txt, server.properties, plugins/, mods/, world/&#125;
                    </span>
                  </span>
                </div>
                <button
                  type="button"
                  onClick={() => onNavigate('files')}
                  className="px-2.5 py-1 rounded bg-surface-container-high hover:bg-surface-bright text-white text-[11px] flex items-center gap-1 cursor-pointer"
                >
                  <span className="material-symbols-outlined text-xs text-primary">folder_open</span>
                  <span>Open File Manager</span>
                </button>
              </div>
            </div>

            {/* Right: 1-Click Install New Server Inside Configured Folder (5 cols) */}
            <form
              onSubmit={handleQuickInstallServerInFolder}
              className="xl:col-span-5 p-4 rounded-xl bg-surface-container border border-secondary/30 space-y-3 flex flex-col justify-between"
            >
              <div className="space-y-2.5">
                <div className="flex items-center justify-between">
                  <span className="font-label-caps text-label-caps uppercase text-secondary flex items-center gap-1.5">
                    <span className="material-symbols-outlined text-sm">downloading</span>
                    Install New Server Inside Configured Folder
                  </span>
                  <span className="px-2 py-0.5 rounded bg-secondary/15 text-secondary font-mono text-[10px] font-bold">
                    AUTO-PROVISION
                  </span>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                  <div>
                    <label className="block font-mono text-[10px] uppercase text-outline mb-1">
                      New Server Name (Subfolder)
                    </label>
                    <input
                      type="text"
                      value={quickSrvName}
                      onChange={(e) => setQuickSrvName(e.target.value)}
                      placeholder="e.g. Skyblock_Season_1"
                      className="w-full px-3 py-2 rounded-lg bg-surface-container-lowest text-white font-mono text-xs border border-white/10 focus:outline-none focus:border-primary"
                      required
                    />
                  </div>

                  <div>
                    <label className="block font-mono text-[10px] uppercase text-outline mb-1">
                      Server Engine (.jar)
                    </label>
                    <select
                      value={quickSrvEngine}
                      onChange={(e) => setQuickSrvEngine(e.target.value)}
                      className="w-full px-3 py-2 rounded-lg bg-surface-container-lowest text-primary font-mono font-bold text-xs border border-white/10 focus:outline-none focus:border-primary cursor-pointer"
                    >
                      <option value="PaperMC 1.21.4">PaperMC 1.21.4</option>
                      <option value="Purpur 1.21.4">Purpur 1.21.4</option>
                      <option value="Fabric 1.21.4">Fabric 1.21.4</option>
                      <option value="Vanilla 1.21.4">Vanilla 1.21.4</option>
                      <option value="Folia 1.21.4">Folia 1.21.4</option>
                      <option value="Velocity 3.4.0">Velocity 3.4.0 Proxy</option>
                    </select>
                  </div>

                  <div>
                    <label className="block font-mono text-[10px] uppercase text-outline mb-1">
                      Local Port
                    </label>
                    <input
                      type="number"
                      value={quickSrvPort}
                      onChange={(e) => setQuickSrvPort(Number(e.target.value))}
                      className="w-full px-3 py-2 rounded-lg bg-surface-container-lowest text-tertiary font-mono text-xs border border-white/10 focus:outline-none focus:border-primary"
                    />
                  </div>

                  <div>
                    <label className="block font-mono text-[10px] uppercase text-outline mb-1">
                      RAM Allocation (-Xmx GB)
                    </label>
                    <input
                      type="number"
                      min={1}
                      max={32}
                      value={quickSrvRamGb}
                      onChange={(e) => setQuickSrvRamGb(Number(e.target.value))}
                      className="w-full px-3 py-2 rounded-lg bg-surface-container-lowest text-white font-mono text-xs border border-white/10 focus:outline-none focus:border-primary"
                    />
                  </div>
                </div>
              </div>

              <div className="space-y-2 pt-1">
                <div className="p-2 rounded bg-surface-container-lowest border border-white/5 font-mono text-[11px] truncate">
                  <span className="text-outline">Target Path: </span>
                  <span className="text-secondary font-bold">{previewTargetFolder}</span>
                </div>
                <button
                  type="submit"
                  disabled={installingServer}
                  className="w-full py-2.5 rounded-lg bg-secondary hover:bg-secondary/90 text-surface-dim font-mono text-xs font-bold flex items-center justify-center gap-1.5 shadow-md cursor-pointer"
                >
                  <span className="material-symbols-outlined text-base">install_desktop</span>
                  <span>
                    {installingServer
                      ? 'Installing Server into Folder...'
                      : `Install "${quickSrvName || 'Server'}" Inside Folder Now`}
                  </span>
                </button>
              </div>
            </form>
          </div>

          {/* Live Local PC Installed Server Subfolders List (fs.readdirSync) */}
          {installConfig && installConfig.installedFolders.length > 0 && (
            <div className="pt-3 border-t border-white/10 space-y-2.5">
              <div className="flex items-center justify-between">
                <span className="font-label-caps text-label-caps uppercase text-outline flex items-center gap-1.5">
                  <span className="size-2 rounded-full bg-secondary animate-ping" />
                  Live Server Subfolders Installed Inside `{installConfig.installRootDir}` (Local PC Disk)
                </span>
                <span className="font-mono text-[11px] text-secondary">
                  Disk Path: {installConfig.resolvedDiskRoot}
                </span>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-2.5">
                {installConfig.installedFolders.map((folder) => (
                  <div
                    key={folder.folderName}
                    className="p-3 rounded-xl bg-surface-container border border-white/5 font-mono text-xs flex flex-col justify-between gap-2"
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <div className="text-white font-bold flex items-center gap-1.5 truncate">
                          <span className="material-symbols-outlined text-sm text-primary">
                            folder
                          </span>
                          <span className="truncate">{folder.folderName}</span>
                        </div>
                        <div
                          className="text-[11px] text-secondary truncate mt-0.5"
                          title={folder.displayPath}
                        >
                          {folder.displayPath}
                        </div>
                      </div>
                      <span className="px-1.5 py-0.5 rounded bg-secondary/15 text-secondary text-[10px] shrink-0">
                        {folder.fileCount} items
                      </span>
                    </div>

                    <div className="flex items-center justify-between gap-1 flex-wrap pt-1 border-t border-white/5 text-[10px]">
                      <div className="flex items-center gap-1 flex-wrap">
                        {folder.hasEula && (
                          <span className="px-1.5 py-0.2 rounded bg-primary/15 text-primary">
                            eula.txt
                          </span>
                        )}
                        {folder.hasServerProperties && (
                          <span className="px-1.5 py-0.2 rounded bg-tertiary/15 text-tertiary">
                            server.properties
                          </span>
                        )}
                        {folder.subfolders.slice(0, 3).map((sub) => (
                          <span
                            key={sub}
                            className="px-1.5 py-0.2 rounded bg-surface-container-highest text-on-surface-variant"
                          >
                            /{sub}
                          </span>
                        ))}
                      </div>
                      <button
                        type="button"
                        onClick={() => onNavigate('files')}
                        className="text-primary hover:underline cursor-pointer"
                      >
                        Browse →
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </section>
      )}

      {/* ================= 2. REAL-TIME GLOBAL RAM ALLOCATOR (SYNCED WITH LOCAL PC PHYSICAL MEMORY) ================= */}
      {(activeTab === 'all' || activeTab === 'ram') && (
        <section className="p-6 rounded-xl bg-surface-container-low border border-white/10 shadow-lg space-y-5">
          <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4 pb-3 border-b border-white/10">
            <div className="flex items-start gap-3">
              <div className="p-2.5 rounded-xl bg-primary/15 text-primary border border-primary/30">
                <span className="material-symbols-outlined text-2xl">memory</span>
              </div>
              <div>
                <h2 className="font-headline-sm text-headline-sm text-white font-bold flex items-center gap-2 flex-wrap">
                  Real-Time Global RAM Allocator &amp; Local PC `/proc/meminfo` Telemetry
                  {isOverCommitted ? (
                    <span className="px-2 py-0.5 rounded bg-error/20 text-error border border-error/40 font-code-sm text-code-sm">
                      OVER-COMMITTED ({totalAllocatedGb} / {globalRamCapGb} GB)
                    </span>
                  ) : (
                    <span className="px-2 py-0.5 rounded bg-secondary/15 text-secondary border border-secondary/30 font-code-sm text-code-sm">
                      LOCAL PC POOL SYNCED ({freePoolGb} GB BUFFER FREE)
                    </span>
                  )}
                </h2>
                <p className="font-body-sm text-body-sm text-on-surface-variant">
                  Detected Local PC Physical RAM:{' '}
                  <strong className="text-white">
                    {hostTelemetry?.osTotalGb || hostTotalRamGb} GB ({hostTelemetry?.osTotalMb || 0}{' '}
                    MB)
                  </strong>{' '}
                  • Live Used by Local PC OS:{' '}
                  <strong className="text-secondary">
                    {hostTelemetry?.osUsedGb || 0} GB ({hostTelemetry?.osUsedMb || 0} MB)
                  </strong>
                </p>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              {hostTelemetry && (
                <button
                  type="button"
                  onClick={handleSyncToRealLocalPcRam}
                  className="px-3 py-1.5 rounded-lg bg-primary/20 hover:bg-primary text-primary hover:text-on-primary font-code-sm text-code-sm font-bold flex items-center gap-1.5 border border-primary/40 transition-all cursor-pointer"
                >
                  <span className="material-symbols-outlined text-sm">sync</span>
                  <span>Sync Cap to Local PC ({hostTelemetry.osTotalGb} GB)</span>
                </button>
              )}
              <button
                type="button"
                onClick={handleAutoBalanceEqual}
                className="px-3 py-1.5 rounded-lg bg-surface-container-high hover:bg-surface-bright text-white font-code-sm text-code-sm flex items-center gap-1.5 border border-white/10 cursor-pointer"
              >
                <span className="material-symbols-outlined text-sm text-primary">balance</span>
                <span>Auto-Balance Equally</span>
              </button>
              <button
                type="button"
                onClick={handlePrioritizeOnline}
                className="px-3 py-1.5 rounded-lg bg-surface-container-high hover:bg-surface-bright text-white font-code-sm text-code-sm flex items-center gap-1.5 border border-white/10 cursor-pointer"
              >
                <span className="material-symbols-outlined text-sm text-secondary">bolt</span>
                <span>Boost Running Servers</span>
              </button>
              <button
                type="button"
                onClick={handleEcoFootprint}
                className="px-3 py-1.5 rounded-lg bg-surface-container-high hover:bg-surface-bright text-white font-code-sm text-code-sm flex items-center gap-1.5 border border-white/10 cursor-pointer"
              >
                <span className="material-symbols-outlined text-sm text-tertiary">eco</span>
                <span>Eco Footprint</span>
              </button>
            </div>
          </div>

          {/* Host Physical RAM, Pool Limit & Live Recharts Memory Stream */}
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-4 items-stretch">
            <div className="lg:col-span-7 grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="p-4 rounded-xl bg-surface-container border border-white/5 space-y-2 flex flex-col justify-between">
                <div className="flex items-center justify-between">
                  <span className="font-label-caps text-label-caps uppercase text-outline">
                    Local PC Physical RAM Ceiling
                  </span>
                  <span className="font-mono text-sm font-bold text-white">
                    {hostTotalRamGb} GB Total
                  </span>
                </div>
                <div className="flex items-center gap-1.5 pt-1 flex-wrap">
                  {hostTelemetry && (
                    <button
                      type="button"
                      onClick={handleSyncToRealLocalPcRam}
                      className={`px-2.5 py-1.5 rounded-lg font-mono text-xs font-bold transition-all cursor-pointer ${
                        Math.abs(hostTotalRamGb - hostTelemetry.osTotalGb) < 0.6
                          ? 'bg-secondary text-surface-dim shadow-sm'
                          : 'bg-secondary/15 text-secondary border border-secondary/30 hover:bg-secondary/25'
                      }`}
                    >
                      Real PC ({hostTelemetry.osTotalGb}G)
                    </button>
                  )}
                  {[16, 32, 64, 128].map((cap) => (
                    <button
                      key={cap}
                      type="button"
                      onClick={() => {
                        const nextCap = Math.min(
                          cap - 2,
                          globalRamCapGb > cap - 2 ? cap - 2 : Math.round(cap * 0.85)
                        );
                        onUpdateGlobalRamConfig(cap, nextCap);
                        syncRamWithBackend({ hostTotalGb: cap, globalCapGb: nextCap });
                        onShowToast(
                          `Host RAM Set to ${cap} GB`,
                          `Global panel allocation ceiling synced to ${nextCap} GB.`,
                          'info',
                          'memory'
                        );
                      }}
                      className={`flex-1 py-1.5 rounded-lg font-mono text-xs font-bold transition-all cursor-pointer ${
                        hostTotalRamGb === cap
                          ? 'bg-primary text-on-primary shadow-sm'
                          : 'bg-surface-container-lowest text-on-surface-variant hover:text-white'
                      }`}
                    >
                      {cap}G
                    </button>
                  ))}
                </div>
                <div className="text-[11px] font-mono text-secondary flex items-center justify-between">
                  <span>Kernel MemTotal: {hostTelemetry?.osTotalMb || 32768} MB</span>
                  <span>
                    Swap: {hostTelemetry?.swapUsedMb || 0}/{hostTelemetry?.swapTotalMb || 0} MB
                  </span>
                </div>
              </div>

              <div className="p-4 rounded-xl bg-surface-container border border-white/5 space-y-2 flex flex-col justify-between">
                <div className="flex items-center justify-between">
                  <span className="font-label-caps text-label-caps uppercase text-outline">
                    Global Panel RAM Pool Cap
                  </span>
                  <span className="font-mono text-sm font-bold text-primary">
                    {globalRamCapGb} GB ({osReservedGb}G OS)
                  </span>
                </div>
                <input
                  type="range"
                  min={2}
                  max={Math.max(4, hostTotalRamGb - 1)}
                  step={0.5}
                  value={globalRamCapGb}
                  onChange={(e) => {
                    const nextVal = Number(e.target.value);
                    onUpdateGlobalRamConfig(hostTotalRamGb, nextVal);
                    syncRamWithBackend({ hostTotalGb: hostTotalRamGb, globalCapGb: nextVal });
                  }}
                  className="w-full accent-amber-400 cursor-pointer"
                />
                <div className="flex justify-between text-[11px] font-mono text-outline">
                  <span>PC Used: {hostTelemetry?.osUsedGb ?? totalActiveUsedGb}G</span>
                  <span>Assigned: {totalAllocatedGb}G</span>
                  <span>Cap: {globalRamCapGb}G</span>
                </div>
              </div>
            </div>

            {/* Real-Time Recharts Local PC RAM vs Fleet Allocation Stream */}
            <div className="lg:col-span-5 p-3.5 rounded-xl bg-surface-container border border-white/5 flex flex-col justify-between">
              <div className="flex items-center justify-between mb-1">
                <span className="font-label-caps text-label-caps uppercase text-outline">
                  Live Local PC RAM Used vs Fleet Heap (GB)
                </span>
                <span className="font-mono text-xs text-secondary font-bold">
                  PC Used: {hostTelemetry?.osUsedGb || 0}G / Total:{' '}
                  {hostTelemetry?.osTotalGb || hostTotalRamGb}G
                </span>
              </div>
              <div className="h-24 w-full">
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={ramStream}>
                    <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" />
                    <XAxis dataKey="time" hide />
                    <YAxis
                      domain={[0, Math.max(hostTotalRamGb, hostTelemetry?.osTotalGb || 16)]}
                      hide
                    />
                    <Tooltip
                      contentStyle={{
                        backgroundColor: '#131824',
                        border: '1px solid rgba(251,191,36,0.35)',
                        borderRadius: '8px',
                        fontSize: '11px',
                        fontFamily: 'monospace',
                      }}
                    />
                    <Area
                      type="monotone"
                      dataKey="allocatedGb"
                      name="Fleet Allocated (-Xmx)"
                      stroke="#fbbf24"
                      fill="rgba(251,191,36,0.12)"
                      strokeWidth={1.6}
                      isAnimationActive={false}
                    />
                    <Area
                      type="monotone"
                      dataKey="localPcUsedGb"
                      name="Real Local PC Used RAM (GB)"
                      stroke="#38bdf8"
                      fill="rgba(56,189,248,0.2)"
                      strokeWidth={2}
                      isAnimationActive={false}
                    />
                    <Area
                      type="monotone"
                      dataKey="activeUsedGb"
                      name="Active JVM Heap (GB)"
                      stroke="#34f59b"
                      fill="rgba(52,245,155,0.22)"
                      strokeWidth={2}
                      isAnimationActive={false}
                    />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            </div>
          </div>

          {/* Per-Server Real-Time RAM Sliders Matrix */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3.5 pt-1">
            {servers.map((srv) => (
              <div
                key={srv.id}
                className="p-3.5 rounded-xl bg-surface-container border border-white/5 flex flex-col justify-between space-y-2.5"
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2 min-w-0">
                    <span
                      className={`size-2 rounded-full shrink-0 ${
                        srv.status === 'running'
                          ? 'bg-secondary'
                          : srv.status === 'restarting'
                          ? 'bg-primary animate-ping'
                          : 'bg-error'
                      }`}
                    />
                    <span className="font-bold text-white text-sm truncate">{srv.name}</span>
                    <span className="font-mono text-[11px] text-outline">:{srv.port}</span>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <span className="font-mono text-xs text-on-surface-variant">
                      Live: <strong className="text-secondary">{srv.ramUsedGb} GB</strong> /
                    </span>
                    <span className="px-2 py-0.5 rounded bg-primary/20 text-primary font-mono text-xs font-bold">
                      -Xmx {srv.ramMaxGb} GB
                    </span>
                  </div>
                </div>

                <div className="flex items-center gap-3">
                  <input
                    type="range"
                    min={1}
                    max={Math.max(2, Math.min(32, globalRamCapGb))}
                    step={0.5}
                    value={srv.ramMaxGb}
                    onChange={(e) => {
                      const val = Number(e.target.value);
                      onUpdateServerRam(srv.id, val);
                      syncRamWithBackend({ serverName: srv.name, newMaxGb: val });
                    }}
                    className="flex-1 accent-amber-400 cursor-pointer"
                  />
                  <div className="flex items-center gap-1">
                    {[2, 4, 8, 12, 16].map((presetGb) => (
                      <button
                        key={presetGb}
                        type="button"
                        onClick={() => {
                          onUpdateServerRam(srv.id, presetGb);
                          syncRamWithBackend({ serverName: srv.name, newMaxGb: presetGb });
                          onShowToast(
                            `Synced ${srv.name} RAM`,
                            `Live max heap (-Xmx) set to ${presetGb} GB.`,
                            'info',
                            'memory'
                          );
                        }}
                        className={`px-1.5 py-0.5 rounded font-mono text-[10px] cursor-pointer ${
                          srv.ramMaxGb === presetGb
                            ? 'bg-primary text-on-primary font-bold'
                            : 'bg-surface-container-high text-on-surface-variant hover:text-white'
                        }`}
                      >
                        {presetGb}G
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* ================= 3. REAL-TIME GLOBAL SERVER KILL LIST & LOCAL PC OS KERNEL PROCESSES ================= */}
      {(activeTab === 'all' || activeTab === 'servers') && (
        <section className="p-6 rounded-xl bg-surface-container-low border border-white/10 shadow-lg space-y-6">
          <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4 pb-3 border-b border-white/10">
            <div className="flex items-start gap-3">
              <div className="p-2.5 rounded-xl bg-error/15 text-error border border-error/30">
                <span className="material-symbols-outlined text-2xl">bolt</span>
              </div>
              <div>
                <h2 className="font-headline-sm text-headline-sm text-white font-bold flex items-center gap-2 flex-wrap">
                  Real-Time Global Server List &amp; Local PC OS Process Kill (`SIGKILL -9`) Manager
                  <span className="px-2 py-0.5 rounded bg-surface-container-high text-secondary font-code-sm text-code-sm">
                    {runningServersCount} Fleet Running • {osProcesses.length} Local PC OS PIDs
                  </span>
                </h2>
                <p className="font-body-sm text-body-sm text-on-surface-variant">
                  Monitor and terminate both managed Minecraft servers (installed in `
                  {serverInstallRootDir}`) and real live OS processes (`ps -eo`) on your local PC.
                </p>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                disabled={spawningWorker}
                onClick={handleSpawnLocalPcProcess}
                className="px-3.5 py-2 rounded-lg bg-secondary/15 hover:bg-secondary/25 text-secondary border border-secondary/30 font-mono text-xs font-bold flex items-center gap-1.5 transition-all cursor-pointer"
              >
                <span className="material-symbols-outlined text-base">add_circle</span>
                <span>
                  {spawningWorker ? 'Spawning Local PID...' : 'Spawn Real Local PC Worker PID'}
                </span>
              </button>

              <button
                type="button"
                onClick={handleLiveKillAllServers}
                disabled={runningServersCount === 0}
                className="px-4 py-2 rounded-lg bg-error hover:bg-error/90 disabled:opacity-40 text-on-error font-mono text-xs font-bold flex items-center gap-1.5 shadow-lg shadow-error/20 transition-all cursor-pointer"
              >
                <span className="material-symbols-outlined text-base">dangerous</span>
                <span>EMERGENCY KILL ALL SERVERS (SIGKILL -9)</span>
              </button>
            </div>
          </div>

          {/* Managed Fleet Server Table */}
          <div className="overflow-x-auto">
            <table className="w-full text-left font-body-sm text-body-sm">
              <thead>
                <tr className="bg-surface-container text-outline font-label-caps text-label-caps uppercase">
                  <th className="py-2.5 px-3 rounded-l-lg">Server Instance &amp; Install Folder</th>
                  <th className="py-2.5 px-3">PID &amp; Local Socket</th>
                  <th className="py-2.5 px-3">Engine &amp; JVM</th>
                  <th className="py-2.5 px-3">Live CPU / RAM / TPS</th>
                  <th className="py-2.5 px-3">Status</th>
                  <th className="py-2.5 px-3 text-right rounded-r-lg">
                    Real-Time Process &amp; Kill Controls
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-surface-container">
                {servers.map((srv) => {
                  const isRunning = srv.status === 'running' || srv.status === 'restarting';
                  const isCurrent = srv.id === activeServer.id;
                  return (
                    <tr
                      key={srv.id}
                      className="hover:bg-surface-container/60 transition-colors"
                    >
                      <td className="py-3 px-3">
                        <div className="flex items-center gap-2.5">
                          <span
                            className={`size-2.5 rounded-full ${
                              srv.status === 'running'
                                ? 'bg-secondary shadow-[0_0_8px_rgba(52,245,155,0.7)]'
                                : srv.status === 'restarting'
                                ? 'bg-primary animate-ping'
                                : 'bg-error'
                            }`}
                          />
                          <div>
                            <div className="font-bold text-white flex items-center gap-2">
                              <span>{srv.name}</span>
                              {isCurrent && (
                                <span className="px-1.5 py-0.2 rounded bg-primary/20 text-primary font-mono text-[10px]">
                                  ACTIVE
                                </span>
                              )}
                            </div>
                            <div className="text-[11px] font-mono text-secondary flex items-center gap-1">
                              <span className="material-symbols-outlined text-xs">folder</span>
                              <span>{srv.path}</span>
                            </div>
                          </div>
                        </div>
                      </td>

                      <td className="py-3 px-3 font-mono text-xs">
                        <div className="text-white font-bold">
                          PID: {srv.pid > 0 ? srv.pid : 'OFFLINE'}
                        </div>
                        <div className="text-tertiary">
                          {localPcUser?.primaryIp || '127.0.0.1'}:{srv.port}
                        </div>
                      </td>

                      <td className="py-3 px-3 font-mono text-xs">
                        <div className="text-on-surface">{srv.engine}</div>
                        <div className="text-outline">{srv.javaVersion}</div>
                      </td>

                      <td className="py-3 px-3 font-mono text-xs">
                        <div className="text-white">
                          CPU: <strong className="text-primary">{srv.cpuUsage}%</strong> (
                          {srv.cpuTemp}
                          °C) • <span className="text-secondary">{srv.tps} TPS</span>
                        </div>
                        <div className="text-secondary">
                          RAM: {srv.ramUsedGb} / {srv.ramMaxGb} GB ({srv.tickMs} mspt)
                        </div>
                      </td>

                      <td className="py-3 px-3">
                        <span
                          className={`px-2 py-0.5 rounded font-mono text-xs font-bold uppercase ${
                            srv.status === 'running'
                              ? 'bg-secondary/15 text-secondary'
                              : srv.status === 'restarting'
                              ? 'bg-primary/20 text-primary'
                              : 'bg-error/15 text-error'
                          }`}
                        >
                          {srv.status}
                        </span>
                      </td>

                      <td className="py-3 px-3 text-right">
                        <div className="flex items-center justify-end gap-1.5">
                          <button
                            type="button"
                            onClick={() => {
                              onSelectServer(srv);
                              onNavigate('console');
                            }}
                            className="px-2.5 py-1 rounded bg-surface-container-high hover:bg-surface-bright text-white font-mono text-xs cursor-pointer"
                          >
                            Console
                          </button>

                          {!isRunning ? (
                            <button
                              type="button"
                              onClick={() => handleLiveServerAction(srv, 'start')}
                              className="px-2.5 py-1 rounded bg-secondary/20 hover:bg-secondary text-secondary hover:text-surface-dim font-mono text-xs font-bold flex items-center gap-1 cursor-pointer transition-colors"
                            >
                              <span className="material-symbols-outlined text-sm">play_arrow</span>
                              <span>Start</span>
                            </button>
                          ) : (
                            <>
                              <button
                                type="button"
                                onClick={() => handleLiveServerAction(srv, 'restart')}
                                className="px-2.5 py-1 rounded bg-primary/20 hover:bg-primary text-primary hover:text-on-primary font-mono text-xs font-bold cursor-pointer transition-colors"
                              >
                                Restart
                              </button>
                              <button
                                type="button"
                                onClick={() => handleLiveServerAction(srv, 'stop')}
                                className="px-2.5 py-1 rounded bg-surface-container-highest hover:bg-surface-bright text-on-surface font-mono text-xs cursor-pointer"
                              >
                                Stop
                              </button>
                              <button
                                type="button"
                                onClick={() => handleLiveServerAction(srv, 'kill')}
                                className="px-3 py-1 rounded bg-error hover:bg-error/85 text-on-error font-mono text-xs font-bold flex items-center gap-1 shadow-sm cursor-pointer"
                                title={`Force Kill PID ${srv.pid} (SIGKILL -9)`}
                              >
                                <span className="material-symbols-outlined text-sm">bolt</span>
                                <span>Kill Server</span>
                              </button>
                            </>
                          )}

                          {servers.length > 1 && (
                            <button
                              type="button"
                              onClick={() => onDeleteServerInstance(srv.id)}
                              className="p-1 rounded bg-surface-container hover:bg-error/20 text-outline hover:text-error cursor-pointer"
                              title="Delete Server Instance from Panel"
                            >
                              <span className="material-symbols-outlined text-sm">delete</span>
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* Real-Time Local PC OS Kernel Process Table (ps -eo) with Real process.kill(pid, 'SIGKILL') */}
          {osProcesses.length > 0 && (
            <div className="pt-4 border-t border-white/10 space-y-3">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <span className="size-2.5 rounded-full bg-secondary animate-ping" />
                  <h3 className="font-title-md text-title-md text-white font-bold">
                    Real-Time Local PC OS Kernel Processes (`ps -eo pid,user,pcpu,pmem,rss,comm`)
                  </h3>
                </div>
                <span className="font-mono text-xs text-secondary">
                  Host: {hostTelemetry?.hostname || 'localhost'} • Live OS Process Table (Polled
                  Every 2s)
                </span>
              </div>

              <div className="overflow-x-auto">
                <table className="w-full text-left font-mono text-xs">
                  <thead>
                    <tr className="bg-surface-container text-outline uppercase text-[10px]">
                      <th className="py-2 px-3 rounded-l-lg">OS PID</th>
                      <th className="py-2 px-3">Local User</th>
                      <th className="py-2 px-3">Command &amp; Arguments</th>
                      <th className="py-2 px-3">CPU %</th>
                      <th className="py-2 px-3">RAM RSS</th>
                      <th className="py-2 px-3">Elapsed</th>
                      <th className="py-2 px-3 text-right rounded-r-lg">Real Local PC SIGKILL</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-surface-container">
                    {osProcesses.map((proc) => (
                      <tr
                        key={proc.pid}
                        className={`hover:bg-surface-container/60 transition-colors ${
                          proc.isSpawnedWorker ? 'bg-secondary/5' : ''
                        }`}
                      >
                        <td className="py-2 px-3 font-bold text-primary">
                          PID {proc.pid}
                          {proc.isSpawnedWorker && (
                            <span className="ml-1.5 px-1.5 py-0.2 rounded bg-secondary/20 text-secondary text-[9px]">
                              SPAWNED WORKER
                            </span>
                          )}
                        </td>
                        <td className="py-2 px-3 text-on-surface">{proc.user}</td>
                        <td className="py-2 px-3">
                          <div className="text-white font-bold">{proc.command}</div>
                          <div
                            className="text-[10px] text-outline truncate max-w-md"
                            title={proc.args}
                          >
                            {proc.args}
                          </div>
                        </td>
                        <td className="py-2 px-3 text-primary font-bold">{proc.cpuPct}%</td>
                        <td className="py-2 px-3 text-secondary font-bold">
                          {proc.rssMb} MB ({proc.memPct}%)
                        </td>
                        <td className="py-2 px-3 text-on-surface-variant">{proc.elapsed}</td>
                        <td className="py-2 px-3 text-right">
                          {proc.isProtected ? (
                            <span className="px-2 py-1 rounded bg-surface-container-highest text-outline text-[10px]">
                              Protected Daemon
                            </span>
                          ) : (
                            <button
                              type="button"
                              onClick={() => handleKillRealLocalPid(proc)}
                              className="px-2.5 py-1 rounded bg-error/20 hover:bg-error text-error hover:text-on-error font-bold text-[11px] inline-flex items-center gap-1 transition-colors cursor-pointer"
                            >
                              <span className="material-symbols-outlined text-xs">bolt</span>
                              <span>Kill PID {proc.pid}</span>
                            </button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </section>
      )}

      {/* ================= 4. REAL-TIME USER PROFILE, LOCAL PC OS ACCOUNT SYNC & MOJANG IDENTITY ================= */}
      {(activeTab === 'all' || activeTab === 'profile') && (
        <section className="grid grid-cols-1 xl:grid-cols-12 gap-6">
          {/* Left: Real-Time Edit Profile Form + Local PC OS Account & Mojang Fetcher (8 cols) */}
          <form
            onSubmit={handleSaveProfile}
            className="xl:col-span-8 p-6 rounded-xl bg-surface-container-low border border-white/10 shadow-lg space-y-5"
          >
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-3 border-b border-white/10">
              <div className="flex items-center gap-3">
                <img
                  src={avatarUrl}
                  alt={username}
                  className="size-12 rounded-xl border-2 border-primary object-cover"
                />
                <div>
                  <h2 className="font-headline-sm text-headline-sm text-white font-bold flex items-center gap-2 flex-wrap">
                    Real-Time Operator Profile &amp; Local PC Account Studio
                    <span className="px-2 py-0.5 rounded bg-secondary/15 text-secondary font-mono text-[10px] uppercase">
                      {lastProfileSyncTime}
                    </span>
                  </h2>
                  <p className="font-code-sm text-code-sm text-on-surface-variant">
                    Persisted in real time to Local PC disk (`
                    {localPcUser?.profileFilePath || '.local-operator-profile.json'}`)
                  </p>
                </div>
              </div>

              <label className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-surface-container border border-white/10 cursor-pointer">
                <input
                  type="checkbox"
                  checked={liveAutoSyncProfile}
                  onChange={(e) => setLiveAutoSyncProfile(e.target.checked)}
                  className="accent-amber-400"
                />
                <span className="font-mono text-xs text-secondary font-bold">
                  Instant Local Disk Sync
                </span>
              </label>
            </div>

            {/* Real-Time Local PC OS User Account Card (os.userInfo() + os.networkInterfaces()) */}
            {localPcUser && (
              <div className="p-4 rounded-xl bg-surface-container border border-secondary/30 space-y-3">
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                  <div>
                    <span className="font-label-caps text-label-caps uppercase text-secondary flex items-center gap-1.5">
                      <span className="material-symbols-outlined text-sm">computer</span>
                      Live Local PC OS Account &amp; Host Environment (`os.userInfo()`)
                    </span>
                    <p className="text-xs text-on-surface-variant">
                      Fetched directly from your local machine kernel and network stack in real
                      time.
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={handleImportLocalPcUserToProfile}
                    className="px-3.5 py-2 rounded-lg bg-secondary text-surface-dim font-mono text-xs font-bold flex items-center gap-1.5 shadow-sm cursor-pointer shrink-0"
                  >
                    <span className="material-symbols-outlined text-sm">download</span>
                    <span>
                      Use Local PC User ({localPcUser.username}@{localPcUser.hostname})
                    </span>
                  </button>
                </div>

                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5 font-mono text-xs">
                  <div className="p-2.5 rounded-lg bg-surface-container-lowest border border-white/5">
                    <span className="text-[10px] text-outline block uppercase">
                      OS Username / UID
                    </span>
                    <span className="text-white font-bold">
                      {localPcUser.username} (uid={localPcUser.uid}, gid={localPcUser.gid})
                    </span>
                  </div>
                  <div className="p-2.5 rounded-lg bg-surface-container-lowest border border-white/5">
                    <span className="text-[10px] text-outline block uppercase">
                      Home Dir &amp; Shell
                    </span>
                    <span
                      className="text-primary font-bold truncate block"
                      title={localPcUser.homedir}
                    >
                      {localPcUser.homedir}
                    </span>
                    <span className="text-[10px] text-outline">{localPcUser.shell}</span>
                  </div>
                  <div className="p-2.5 rounded-lg bg-surface-container-lowest border border-white/5">
                    <span className="text-[10px] text-outline block uppercase">
                      Primary NIC / MAC
                    </span>
                    <span className="text-secondary font-bold">
                      {localPcUser.primaryIp} ({localPcUser.primaryNic})
                    </span>
                    <span className="text-[10px] text-outline block">{localPcUser.primaryMac}</span>
                  </div>
                  <div className="p-2.5 rounded-lg bg-surface-container-lowest border border-white/5">
                    <span className="text-[10px] text-outline block uppercase">
                      Runtime &amp; Working Dir
                    </span>
                    <span className="text-tertiary font-bold">
                      Node {localPcUser.nodeVersion} (V8 {localPcUser.v8Version.slice(0, 6)})
                    </span>
                    <span
                      className="text-[10px] text-outline truncate block"
                      title={localPcUser.cwd}
                    >
                      {localPcUser.cwd}
                    </span>
                  </div>
                </div>
              </div>
            )}

            {/* Real-Time Mojang Minecraft Account Lookup Bar */}
            <div className="p-3.5 rounded-xl bg-surface-container border border-primary/30 space-y-2">
              <div className="flex items-center justify-between">
                <span className="font-label-caps text-label-caps uppercase text-primary flex items-center gap-1.5">
                  <span className="material-symbols-outlined text-sm">sports_esports</span>
                  Real-Time Mojang Minecraft Account &amp; 3D Skin Sync
                </span>
                <span className="font-mono text-[11px] text-secondary">
                  Official api.mojang.com Live Lookup
                </span>
              </div>
              <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2">
                <input
                  type="text"
                  value={mojangLookupInput}
                  onChange={(e) => setMojangLookupInput(e.target.value)}
                  placeholder="Enter any real Minecraft Java IGN (e.g. Notch, jeb_, Grian, MumboJumbo)..."
                  className="flex-1 px-3 py-2 rounded-lg bg-surface-container-lowest text-white font-mono text-xs border border-white/10 focus:outline-none focus:border-primary"
                />
                <button
                  type="button"
                  disabled={mojangLoading}
                  onClick={() => handleLookupMojangProfile()}
                  className="px-4 py-2 rounded-lg bg-primary text-on-primary font-mono text-xs font-bold flex items-center justify-center gap-1.5 cursor-pointer shrink-0"
                >
                  {mojangLoading ? (
                    <span className="size-3.5 border-2 border-black border-t-transparent rounded-full animate-spin" />
                  ) : (
                    <span className="material-symbols-outlined text-sm">cloud_download</span>
                  )}
                  <span>Fetch Live Mojang UUID &amp; Avatar</span>
                </button>
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="block font-label-caps text-label-caps uppercase text-outline mb-1">
                  Operator Username (@handle — Live Sync)
                </label>
                <input
                  type="text"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  className="w-full px-3.5 py-2.5 rounded-lg bg-surface-container text-white font-mono text-sm border border-white/10 focus:outline-none focus:border-primary"
                  required
                />
              </div>

              <div>
                <label className="block font-label-caps text-label-caps uppercase text-outline mb-1">
                  Display Name (Shown in Panel &amp; Logs)
                </label>
                <input
                  type="text"
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                  className="w-full px-3.5 py-2.5 rounded-lg bg-surface-container text-white text-sm border border-white/10 focus:outline-none focus:border-primary"
                  required
                />
              </div>

              <div>
                <label className="block font-label-caps text-label-caps uppercase text-outline mb-1">
                  Operator Email Address
                </label>
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="w-full px-3.5 py-2.5 rounded-lg bg-surface-container text-white font-mono text-sm border border-white/10 focus:outline-none focus:border-primary"
                  required
                />
              </div>

              <div>
                <label className="block font-label-caps text-label-caps uppercase text-outline mb-1">
                  Workstation Clearance Role
                </label>
                <select
                  value={role}
                  onChange={(e) => setRole(e.target.value as AuthUser['role'])}
                  className="w-full px-3.5 py-2.5 rounded-lg bg-surface-container text-primary font-mono font-bold text-sm border border-white/10 focus:outline-none focus:border-primary cursor-pointer"
                >
                  <option value="Root Admin">Root Admin (Full Kernel &amp; SIGKILL Access)</option>
                  <option value="DevOps Engineer">DevOps Engineer (JVM &amp; Network Access)</option>
                  <option value="Operator">Operator (Console &amp; Plugins Access)</option>
                  <option value="Moderator">Moderator (Player &amp; Chat Management)</option>
                </select>
              </div>

              <div>
                <label className="block font-label-caps text-label-caps uppercase text-outline mb-1">
                  Linked Minecraft Player UUID
                </label>
                <input
                  type="text"
                  value={mcUuid}
                  onChange={(e) => setMcUuid(e.target.value)}
                  className="w-full px-3.5 py-2.5 rounded-lg bg-surface-container text-secondary font-mono text-sm border border-white/10 focus:outline-none focus:border-primary"
                />
              </div>

              <div>
                <label className="block font-label-caps text-label-caps uppercase text-outline mb-1">
                  Rotate Local Passphrase / PIN
                </label>
                <input
                  type="password"
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  placeholder="Enter new operator passphrase..."
                  className="w-full px-3.5 py-2.5 rounded-lg bg-surface-container text-white font-mono text-sm border border-white/10 focus:outline-none focus:border-primary"
                />
              </div>
            </div>

            {/* Avatar Selector */}
            <div className="space-y-2">
              <label className="block font-label-caps text-label-caps uppercase text-outline">
                Operator Avatar (Choose Preset, Mojang 3D Head, or Custom URL)
              </label>
              <div className="flex flex-wrap items-center gap-3">
                {PRESET_AVATARS.map((url, i) => (
                  <button
                    key={i}
                    type="button"
                    onClick={() => setAvatarUrl(url)}
                    className={`p-1 rounded-xl border-2 transition-all cursor-pointer ${
                      avatarUrl === url
                        ? 'border-primary bg-primary/20 scale-105'
                        : 'border-white/10 hover:border-white/30'
                    }`}
                  >
                    <img
                      src={url}
                      alt={`Preset ${i + 1}`}
                      className="size-10 rounded-lg object-cover"
                    />
                  </button>
                ))}
                <input
                  type="url"
                  value={avatarUrl}
                  onChange={(e) => setAvatarUrl(e.target.value)}
                  placeholder="Or paste custom avatar image URL..."
                  className="flex-1 min-w-[220px] px-3 py-2 rounded-lg bg-surface-container text-white font-mono text-xs border border-white/10 focus:outline-none focus:border-primary"
                />
              </div>
            </div>

            <div className="flex items-center justify-end gap-3 pt-2 border-t border-white/10">
              <button
                type="submit"
                className="px-5 py-2.5 rounded-lg bg-primary hover:bg-primary-fixed text-on-primary font-bold text-sm flex items-center gap-2 shadow-lg shadow-primary/20 cursor-pointer"
              >
                <span className="material-symbols-outlined text-base">save</span>
                <span>Commit Profile to Local PC Disk Now</span>
              </button>
            </div>
          </form>

          {/* Right: Discord Bot Verification Quota, Linked OAuth Providers & Audit Stream (4 cols) */}
          <div className="xl:col-span-4 space-y-4">
            {/* Discord Server & Bot Verification Quota Card */}
            <div className="p-5 rounded-xl bg-gradient-to-br from-[#5865F2]/15 via-surface-container-low to-surface-container-low border border-[#5865F2]/35 shadow-lg space-y-3.5">
              <div className="flex items-center justify-between gap-2">
                <h3 className="font-title-md text-title-md text-white font-bold flex items-center gap-2">
                  <span className="material-symbols-outlined text-[#8ea1e1]">verified_user</span>
                  Discord Bot Server Quota
                </h3>
                <span
                  className={`px-2 py-0.5 rounded font-mono text-[10px] font-bold uppercase ${
                    currentUser.discordVerified
                      ? 'bg-secondary/20 text-secondary border border-secondary/40'
                      : currentUser.discordMemberStatus === 'left_guild'
                      ? 'bg-error/20 text-error border border-error/40'
                      : 'bg-amber-400/20 text-amber-300 border border-amber-400/40'
                  }`}
                >
                  {currentUser.discordVerified
                    ? 'Bot Verified • 10 Max'
                    : currentUser.discordMemberStatus === 'left_guild'
                    ? 'Left Discord • Reset to 2'
                    : 'Standard • 2 Max'}
                </span>
              </div>

              <div className="p-3 rounded-lg bg-surface-container border border-white/10 space-y-2 text-xs font-mono">
                <div className="flex items-center justify-between">
                  <span className="text-outline">Server Creation Limit:</span>
                  <span className="text-white font-bold">
                    {servers.length} / {currentUser.discordVerified ? currentUser.maxServerLimit || 10 : 2} Servers
                  </span>
                </div>
                <div className="w-full h-2 rounded-full bg-surface-lowest overflow-hidden">
                  <div
                    className={`h-full transition-all ${
                      currentUser.discordVerified ? 'bg-secondary' : 'bg-amber-400'
                    }`}
                    style={{
                      width: `${Math.min(
                        100,
                        (servers.length /
                          (currentUser.discordVerified ? currentUser.maxServerLimit || 10 : 2)) *
                          100
                      )}%`,
                    }}
                  />
                </div>
                <p className="text-[11px] text-on-surface-variant font-sans leading-relaxed">
                  {currentUser.discordVerified
                    ? `Verified as @${currentUser.discordUsername || currentUser.username} in "${currentUser.discordGuildName || 'IS King Official Discord Server'}". Leaving the Discord server automatically resets your limit back to 2.`
                    : 'All logged-in users can set up 1 or 2 servers only. Connect to our Discord Server and verify with the Discord Bot to unlock up to 10 servers.'}
                </p>
              </div>

              <div className="flex flex-col gap-2">
                <button
                  type="button"
                  onClick={() => onOpenDiscordBotGate && onOpenDiscordBotGate()}
                  className="w-full py-2.5 px-3 rounded-lg bg-[#5865F2] hover:bg-[#4752C4] text-white font-mono text-xs font-bold flex items-center justify-center gap-2 shadow cursor-pointer transition-all"
                >
                  <span className="material-symbols-outlined text-[16px]">
                    {currentUser.discordVerified ? 'manage_accounts' : 'verified'}
                  </span>
                  {currentUser.discordVerified
                    ? 'Open Discord Bot Verification Console'
                    : 'Connect Discord & Verify by Bot (Unlock >2 Servers)'}
                </button>

                {currentUser.discordVerified && onLeaveDiscordServer && (
                  <button
                    type="button"
                    onClick={onLeaveDiscordServer}
                    className="w-full py-2 px-3 rounded-lg bg-error/15 hover:bg-error/25 border border-error/35 text-error font-mono text-xs font-bold flex items-center justify-center gap-1.5 cursor-pointer transition-all"
                  >
                    <span className="material-symbols-outlined text-[15px]">link_off</span>
                    Leave Discord Server (Reset Limit to 2)
                  </button>
                )}
              </div>
            </div>

            <div className="p-5 rounded-xl bg-surface-container-low border border-white/10 shadow-lg space-y-4">
              <div className="flex items-center justify-between">
                <h3 className="font-title-md text-title-md text-white font-bold flex items-center gap-2">
                  <span className="material-symbols-outlined text-primary">hub</span>
                  Connected OAuth Identities
                </h3>
                <span className="font-mono text-xs text-secondary">
                  {currentUser.connectedProviders.length} Linked
                </span>
              </div>

              <div className="space-y-2.5">
                {(
                  [
                    { id: 'discord', label: 'Discord OAuth2', desc: 'Guild & Operator Sync' },
                    { id: 'github', label: 'GitHub OAuth', desc: 'Plugin Repo & CI Token' },
                    { id: 'google', label: 'Google Workspace', desc: 'Cloud Backup Identity' },
                  ] as const
                ).map((prov) => {
                  const isLinked = currentUser.connectedProviders.includes(prov.id);
                  return (
                    <div
                      key={prov.id}
                      className="p-3 rounded-lg bg-surface-container border border-white/5 flex items-center justify-between gap-2"
                    >
                      <div>
                        <div className="font-bold text-white text-xs flex items-center gap-2">
                          <span>{prov.label}</span>
                          {isLinked && (
                            <span className="px-1.5 py-0.2 rounded bg-secondary/15 text-secondary font-mono text-[10px]">
                              LINKED
                            </span>
                          )}
                        </div>
                        <p className="text-[11px] text-on-surface-variant">{prov.desc}</p>
                      </div>
                      <button
                        type="button"
                        onClick={() => handleToggleConnectedProvider(prov.id)}
                        className={`px-3 py-1 rounded font-mono text-xs font-bold cursor-pointer transition-colors ${
                          isLinked
                            ? 'bg-surface-container-highest hover:bg-error/20 text-on-surface hover:text-error'
                            : 'bg-primary text-on-primary'
                        }`}
                      >
                        {isLinked ? 'Unlink' : 'Connect'}
                      </button>
                    </div>
                  );
                })}
              </div>

              <div className="pt-2 border-t border-white/10 flex gap-2">
                <button
                  type="button"
                  onClick={() => onOpenAuthModal('signin')}
                  className="flex-1 py-2 rounded-lg bg-surface-container-high hover:bg-surface-bright text-white font-mono text-xs font-bold cursor-pointer"
                >
                  Switch Account
                </button>
                <button
                  type="button"
                  onClick={onSignOut}
                  className="flex-1 py-2 rounded-lg bg-error/15 hover:bg-error/25 text-error border border-error/30 font-mono text-xs font-bold cursor-pointer"
                >
                  Sign Out
                </button>
              </div>
            </div>

            {/* Real-Time Panel Audit Event Stream */}
            <div className="p-5 rounded-xl bg-surface-container-low border border-white/10 shadow-lg space-y-3">
              <div className="flex items-center justify-between">
                <h3 className="font-title-md text-title-md text-white font-bold flex items-center gap-2">
                  <span className="material-symbols-outlined text-secondary">rss_feed</span>
                  Live Local PC Kernel Audit Stream
                </h3>
                <span className="size-2 rounded-full bg-secondary animate-ping" />
              </div>
              <div className="space-y-2 max-h-60 overflow-y-auto pr-1 font-mono text-xs">
                {auditEvents.map((evt) => (
                  <div
                    key={evt.id}
                    className="p-2.5 rounded-lg bg-surface-container border border-white/5 space-y-1"
                  >
                    <div className="flex items-center justify-between text-[10px]">
                      <span
                        className={`px-1.5 py-0.2 rounded font-bold ${
                          evt.category === 'SIGKILL'
                            ? 'bg-error/20 text-error'
                            : evt.category === 'RAM_ALLOC'
                            ? 'bg-primary/20 text-primary'
                            : 'bg-secondary/15 text-secondary'
                        }`}
                      >
                        {evt.category}
                      </span>
                      <span className="text-outline">{evt.time}</span>
                    </div>
                    <p className="text-on-surface text-[11px] leading-snug">{evt.message}</p>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </section>
      )}
    </div>
  );
};
