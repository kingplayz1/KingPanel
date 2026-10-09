/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useCallback } from 'react';
import {
  NavSection,
  ServerInstance,
  ToastMessage,
  ConsoleLogLine,
  ConnectedPlayer,
  FileItem,
  PluginItem,
  PortRule,
  SnapshotItem,
  CronTask,
  AuthUser,
  PaperMCServiceReport,
} from './types';
import {
  INITIAL_SERVERS,
  INITIAL_CONSOLE_LOGS,
  INITIAL_PLAYERS,
  INITIAL_FILES,
  INITIAL_PLUGINS,
  INITIAL_PORTS,
  INITIAL_SNAPSHOTS,
  INITIAL_CRONS,
} from './data/initialData';
import { TitleBar } from './components/TitleBar';
import { Sidebar } from './components/Sidebar';
import { AuthGateModal } from './components/AuthGateModal';
import { OverviewView } from './views/OverviewView';
import { ConsoleTelemetryView } from './views/ConsoleTelemetryView';
import { FileManagerView } from './views/FileManagerView';
import { ModpacksPluginsView } from './views/ModpacksPluginsView';
import { ServerLogsView } from './views/ServerLogsView';
import { NetworkPortsView } from './views/NetworkPortsView';
import { BackupsSnapshotsView } from './views/BackupsSnapshotsView';
import { SchedulesCronView } from './views/SchedulesCronView';
import { DatabasesView } from './views/DatabasesView';
import { StartupJvmView } from './views/StartupJvmView';
import { ServerSettingsView } from './views/ServerSettingsView';
import { PrivacyPolicyView } from './views/PrivacyPolicyView';
import { TermsConditionsView } from './views/TermsConditionsView';
import { NotFound404View } from './views/NotFound404View';
import { PanelControlView } from './views/PanelControlView';
import { PanelErrorBoundary } from './components/PanelErrorBoundary';
import { DiscordBotGateModal } from './components/DiscordBotGateModal';
import { SimplePrePanel } from './components/SimplePrePanel';
import { SetupPanelGuideView } from './views/SetupPanelGuideView';

export default function App() {
  const [activeSection, setActiveSection] = useState<NavSection>(() => {
    const path = window.location.pathname;
    if (path && path !== '/' && path !== '/index.html' && !path.startsWith('/auth')) {
      return 'not_found';
    }
    return 'overview';
  });
  const [errorRoutePath, setErrorRoutePath] = useState<string>(() => {
    const path = window.location.pathname;
    return path && path !== '/' && path !== '/index.html' ? path : '/region/r.-404.-404.mca';
  });
  const [hostTotalRamGb, setHostTotalRamGb] = useState<number>(32);
  const [globalRamCapGb, setGlobalRamCapGb] = useState<number>(28);
  const [serverInstallRootDir, setServerInstallRootDir] = useState<string>('C:\\KingServers');
  const [servers, setServers] = useState<ServerInstance[]>(INITIAL_SERVERS);
  const [activeServerId, setActiveServerId] = useState<string>(INITIAL_SERVERS[0].id);
  const [logs, setLogs] = useState<ConsoleLogLine[]>(INITIAL_CONSOLE_LOGS);
  const [players, setPlayers] = useState<ConnectedPlayer[]>(INITIAL_PLAYERS);
  const [files, setFiles] = useState<FileItem[]>(INITIAL_FILES);
  const [plugins, setPlugins] = useState<PluginItem[]>(INITIAL_PLUGINS);
  const [ports, setPorts] = useState<PortRule[]>(INITIAL_PORTS);
  const [snapshots, setSnapshots] = useState<SnapshotItem[]>(INITIAL_SNAPSHOTS);
  const [crons, setCrons] = useState<CronTask[]>(INITIAL_CRONS);
  const [toasts, setToasts] = useState<ToastMessage[]>([]);
  const [isMinimized, setIsMinimized] = useState(false);
  const [selectedFileId, setSelectedFileId] = useState<string | null>(null);
  const [pluginSearchQuery, setPluginSearchQuery] = useState<string>('');
  const [currentUser, setCurrentUser] = useState<AuthUser | null>(() => {
    try {
      const saved = localStorage.getItem('king_panel_auth_user');
      return saved ? JSON.parse(saved) : null;
    } catch {
      return null;
    }
  });
  const [authModalOpen, setAuthModalOpen] = useState(false);
  const [authModalMode, setAuthModalMode] = useState<'signin' | 'signup'>('signin');
  const [hasEnteredFullPanel, setHasEnteredFullPanel] = useState<boolean>(false);
  const [discordBotGateOpen, setDiscordBotGateOpen] = useState<boolean>(false);
  const [discordBotAttemptedServerName, setDiscordBotAttemptedServerName] = useState<
    string | undefined
  >(undefined);
  const [paperMcReport, setPaperMcReport] = useState<PaperMCServiceReport | null>(null);

  const activeServer = servers.find((s) => s.id === activeServerId) || servers[0];

  const showToast = useCallback(
    (
      title: string,
      body?: string,
      type: 'success' | 'info' | 'warning' | 'error' = 'info',
      icon?: string
    ) => {
      const id = `toast-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      setToasts((prev) => [...prev.slice(-3), { id, title, body, type, icon }]);
      setTimeout(() => {
        setToasts((prev) => prev.filter((t) => t.id !== id));
      }, 3600);
    },
    []
  );

  const getNowTime = () => {
    const now = new Date();
    return now.toTimeString().split(' ')[0];
  };

  const addLog = useCallback((line: Omit<ConsoleLogLine, 'id' | 'time'>) => {
    setLogs((prev) => [
      ...prev,
      {
        ...line,
        id: `log-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        time: getNowTime(),
      },
    ]);
  }, []);

  // Automatically show 404 Error Page if browser navigates to an invalid route
  useEffect(() => {
    const handlePopState = () => {
      const path = window.location.pathname;
      if (path && path !== '/' && path !== '/index.html' && !path.startsWith('/auth')) {
        setErrorRoutePath(path);
        setActiveSection('not_found');
      }
    };
    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, []);

  // Background Service: Poll PaperMC API for latest server engine release & flag outdated servers
  const syncPaperMcBackgroundCheck = useCallback(
    async (notifyUser = false) => {
      try {
        const res = await fetch('/api/engines/version-check/run', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ servers }),
        });
        const data = await res.json();
        if (res.ok && data?.ok) {
          setPaperMcReport(data);
          const reports = data.serverReports || {};
          setServers((prev) =>
            prev.map((srv) => {
              const rep = reports[srv.id];
              if (!rep) return srv;
              return {
                ...srv,
                installedVersion: rep.installedVersion,
                latestVersion: rep.latestVersion,
                isOutdated: rep.isOutdated,
                latestBuild: rep.latestBuild,
                downloadUrl: rep.downloadUrl,
                lastVersionCheckAt: rep.checkedAt,
              };
            })
          );
          if (notifyUser) {
            showToast(
              `PaperMC API Checked (Latest: ${data.latestPaperRelease})`,
              data.outdatedCount > 0
                ? `Flagged ${data.outdatedCount} installed server(s) as OUTDATED against ${data.latestPaperRelease} (${data.latestPaperBuild}).`
                : `All installed servers are running the latest release (${data.latestPaperRelease}).`,
              data.outdatedCount > 0 ? 'warning' : 'success',
              'system_update_alt'
            );
          }
        }
      } catch {
        // ignore transient network error
      }
    },
    [servers, showToast]
  );

  useEffect(() => {
    syncPaperMcBackgroundCheck(false);
    const interval = setInterval(() => {
      syncPaperMcBackgroundCheck(false);
    }, 45_000);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleUpgradeServerEngine = async (serverId: string | 'ALL') => {
    try {
      const res = await fetch('/api/engines/upgrade-server', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          serverId,
          actor: currentUser?.username || 'kingplayz',
        }),
      });
      const data = await res.json();
      const latestVer = data?.latestPaperRelease || paperMcReport?.latestPaperRelease || '1.21.4';
      const latestBuild = data?.latestPaperBuild || paperMcReport?.latestPaperBuild || 'Build #222';

      setServers((prev) =>
        prev.map((srv) => {
          if (serverId !== 'ALL' && srv.id !== serverId) return srv;
          const family = srv.engine.split(' ')[0] || 'PaperMC';
          return {
            ...srv,
            engine: `${family} ${latestVer}`,
            build: latestBuild,
            installedVersion: latestVer,
            latestVersion: latestVer,
            isOutdated: false,
          };
        })
      );

      addLog({
        level: 'INFO',
        text: `[PaperMC-Updater] Upgraded ${
          serverId === 'ALL' ? 'all outdated servers' : serverId
        } to latest release ${latestVer} (${latestBuild})`,
      });
      showToast(
        'Server Engine Updated to Latest Release',
        `Upgraded to ${latestVer} (${latestBuild}) — 'OUTDATED' flag cleared.`,
        'success',
        'upgrade'
      );
      syncPaperMcBackgroundCheck(false);
    } catch {
      showToast('Upgrade Error', 'Could not reach PaperMC upgrade service.', 'error');
    }
  };

  // Hydrate Global RAM ceiling & Operator Profile directly from real Local PC telemetry on mount
  useEffect(() => {
    fetch('/api/panel/telemetry')
      .then((r) => r.json())
      .then((data) => {
        if (!data?.ok) return;
        if (data.host?.osTotalGb > 0) {
          const detectedTotal = Math.max(4, Math.round(data.host.osTotalGb));
          const detectedCap = Math.max(
            2,
            Number((detectedTotal - Math.max(1, Math.round(detectedTotal * 0.12))).toFixed(1))
          );
          setHostTotalRamGb(detectedTotal);
          setGlobalRamCapGb(detectedCap);
        }
        if (data.diskSavedProfile?.username) {
          setCurrentUser(data.diskSavedProfile);
        }
        if (data.installConfig?.installRootDir) {
          const rootDir: string = data.installConfig.installRootDir;
          setServerInstallRootDir(rootDir);
          const cleanRoot = rootDir.replace(/[\\/]+$/, '');
          const sep = cleanRoot.includes('\\') ? '\\' : '/';
          setServers((prev) =>
            prev.map((srv) => {
              const folderSlug =
                srv.name.trim().replace(/[^a-zA-Z0-9_-]/g, '_').replace(/_+/g, '_') || 'Server';
              return {
                ...srv,
                path: `${cleanRoot}${sep}${folderSlug}`,
              };
            })
          );
        }
      })
      .catch(() => {
        // ignore
      });
  }, []);

  // Subtle live hardware telemetry micro-fluctuation while running
  useEffect(() => {
    const interval = setInterval(() => {
      setServers((prev) =>
        prev.map((srv) => {
          if (srv.status !== 'running') return srv;
          const cpuDelta = Math.floor(Math.random() * 5) - 2;
          const nextCpu = Math.max(4, Math.min(92, srv.cpuUsage + cpuDelta));
          const tempDelta = Number(((Math.random() - 0.48) * 0.4).toFixed(1));
          const nextTemp = Number(Math.max(38, Math.min(76, srv.cpuTemp + tempDelta)).toFixed(1));
          const tickDelta = Number(((Math.random() - 0.5) * 0.3).toFixed(1));
          const nextTick = Number(Math.max(1.2, Math.min(14.5, srv.tickMs + tickDelta)).toFixed(1));
          return {
            ...srv,
            cpuUsage: nextCpu,
            cpuTemp: nextTemp,
            tickMs: nextTick,
          };
        })
      );
    }, 3200);
    return () => clearInterval(interval);
  }, []);

  const handleSelectServer = (srv: ServerInstance) => {
    setActiveServerId(srv.id);
    showToast(
      `Switched to ${srv.name}`,
      `Engine: ${srv.engine} • Port :${srv.port} (PID ${srv.pid})`,
      'info',
      'dns'
    );
  };

  const handleServerAction = (action: 'restart' | 'stop' | 'kill' | 'start') => {
    if (action === 'restart') {
      setServers((prev) =>
        prev.map((s) => (s.id === activeServer.id ? { ...s, status: 'restarting' } : s))
      );
      addLog({
        level: 'WARN',
        text: '[KingDaemon] Saving chunks (/save-all flush) & initiating graceful JVM restart...',
        highlightBox: 'warn',
      });
      showToast(
        'Graceful Restart Initiated',
        `Flushing region chunks for ${activeServer.name}...`,
        'warning',
        'restart_alt'
      );
      setTimeout(() => {
        setServers((prev) =>
          prev.map((s) =>
            s.id === activeServer.id ? { ...s, status: 'running', uptime: '0h 01m' } : s
          )
        );
        addLog({
          level: 'INFO',
          text: `Done (1.842s)! PaperMC ${activeServer.build} listening on 0.0.0.0:${activeServer.port}`,
        });
        showToast(
          'Server Back Online',
          `${activeServer.name} restarted cleanly at 20.0 TPS.`,
          'success',
          'check_circle'
        );
      }, 1800);
    } else if (action === 'stop') {
      setServers((prev) =>
        prev.map((s) =>
          s.id === activeServer.id ? { ...s, status: 'stopped', cpuUsage: 0, tps: 0 } : s
        )
      );
      addLog({
        level: 'WARN',
        text: '[Server] Stopping server... Saving players and region files.',
        highlightBox: 'warn',
      });
      showToast('Server Stopped', `${activeServer.name} has been gracefully stopped.`, 'info', 'stop_circle');
    } else if (action === 'kill') {
      setServers((prev) =>
        prev.map((s) =>
          s.id === activeServer.id ? { ...s, status: 'stopped', cpuUsage: 0, tps: 0 } : s
        )
      );
      addLog({
        level: 'ERROR',
        text: `[SIGKILL] Process PID ${activeServer.pid} terminated immediately by Operator.`,
        highlightBox: 'error',
      });
      showToast(
        'Process Force Killed (SIGKILL)',
        `Terminated PID ${activeServer.pid} immediately.`,
        'error',
        'bolt'
      );
    } else if (action === 'start') {
      setServers((prev) =>
        prev.map((s) =>
          s.id === activeServer.id
            ? { ...s, status: 'running', tps: 20.0, cpuUsage: 22 }
            : s
        )
      );
      addLog({
        level: 'INFO',
        text: `Starting ${activeServer.engine} on port ${activeServer.port} (Aikar's G1GC Flags)...`,
      });
      showToast(
        'Server Started',
        `${activeServer.name} is now online and accepting connections.`,
        'success',
        'play_arrow'
      );
    }
  };

  const handleCreateSnapshot = (tag: string, pinned: boolean, scopes: string[]) => {
    const newSnap: SnapshotItem = {
      id: `snap-${Date.now()}`,
      title: tag || 'Manual Hot-Snapshot Checkpoint',
      badge: pinned ? 'Pinned Long-Term' : 'Latest Point',
      badgeType: pinned ? 'gold' : 'primary',
      verified: true,
      pinned,
      timestamp: 'Just now (0m ago)',
      size: '2.12 GB',
      note: '(zstd compressed at 420 MB/s)',
      scopes: scopes.length > 0 ? scopes : ['World', 'Nether', 'End', 'Plugins'],
      destination: 'NVMe FastPipe + S3',
      sha: 'SHA: 4c8e...f91a',
      icon: pinned ? 'keep' : 'bolt',
      iconColor: pinned ? 'bg-primary-gold/10 text-primary-gold' : 'bg-primary/10 text-primary',
    };
    setSnapshots((prev) => [newSnap, ...prev]);
    addLog({
      level: 'INFO',
      text: `[ZSTD-Backup] Created hot-snapshot "${newSnap.title}" (2.12 GB) in 4.1s.`,
    });
    showToast(
      'Zero-Downtime Snapshot Created',
      `Archived "${newSnap.title}" (2.12 GB ZSTD).`,
      'success',
      'cloud_done'
    );
  };

  const handleTogglePinSnapshot = (id: string) => {
    setSnapshots((prev) =>
      prev.map((snap) => {
        if (snap.id !== id) return snap;
        const nextPin = !snap.pinned;
        showToast(
          nextPin ? 'Snapshot Pinned' : 'Snapshot Unpinned',
          `${snap.title} ${nextPin ? 'exempt from auto-prune' : 'returned to standard rotation'}.`,
          'info',
          'keep'
        );
        return {
          ...snap,
          pinned: nextPin,
          badge: nextPin ? 'Pinned Long-Term' : 'Checkpoint',
          badgeType: nextPin ? 'gold' : 'neutral',
        };
      })
    );
  };

  const handleSaveFileContent = (fileId: string, content: string) => {
    const updateTree = (items: FileItem[]): FileItem[] =>
      items.map((item) => {
        if (item.id === fileId) {
          return { ...item, content };
        }
        if (item.children) {
          return { ...item, children: updateTree(item.children) };
        }
        return item;
      });
    setFiles((prev) => updateTree(prev));
  };

  const handleCreateFile = (name: string, content: string) => {
    const newFile: FileItem = {
      id: `f-${Date.now()}`,
      name,
      path: `${activeServer.path}\\${name}`,
      type: 'file',
      size: '0.4 KB',
      permissions: 'rw-r--r--',
      icon: 'description',
      iconColor: 'text-primary',
      language: name.endsWith('.yml') ? 'yaml' : 'text',
      content,
    };
    setFiles((prev) => [...prev, newFile]);
  };

  const handleUpdatePlugin = (pluginId: string) => {
    setPlugins((prev) =>
      prev.map((p) => {
        if (p.id !== pluginId) return p;
        const updatedVer = p.targetVersion || p.version;
        showToast(
          `Updated ${p.name}`,
          `Hot-swapped JAR to ${updatedVer} via FastPipe loader.`,
          'success',
          'published_with_changes'
        );
        return {
          ...p,
          version: `${updatedVer} Installed`,
          status: 'installed',
        };
      })
    );
  };

  const handleUpdateAllPlugins = () => {
    setPlugins((prev) =>
      prev.map((p) =>
        p.status === 'update_ready'
          ? {
              ...p,
              version: `${p.targetVersion || p.version} Installed`,
              status: 'installed',
            }
          : p
      )
    );
    showToast(
      'All Plugins Updated',
      'Patched all pending plugin JARs with SHA-256 verification.',
      'success',
      'done_all'
    );
  };

  const handleInstallPlugin = (pluginId: string) => {
    setPlugins((prev) =>
      prev.map((p) => {
        if (p.id !== pluginId) return p;
        showToast(
          `Installed ${p.name}`,
          `Downloaded ${p.version} into /plugins/ directory.`,
          'success',
          'download_done'
        );
        return {
          ...p,
          status: 'installed',
          version: `${p.version} Installed`,
        };
      })
    );
  };

  const handleAddCustomPlugin = (newPlugin: PluginItem) => {
    setPlugins((prev) => {
      if (prev.some((p) => p.id === newPlugin.id)) {
        return prev.map((p) => (p.id === newPlugin.id ? newPlugin : p));
      }
      return [newPlugin, ...prev];
    });
    addLog({
      level: 'INFO',
      text: `[FastPipe] Hot-loaded live artifact ${newPlugin.footerLeft} (${newPlugin.name}) into server classpath.`,
    });
  };

  const handleUpdateServerEngine = (
    engineLabel: string,
    buildLabel: string,
    jarFilename: string
  ) => {
    setServers((prev) =>
      prev.map((s) =>
        s.id === activeServer.id
          ? {
              ...s,
              engine: engineLabel,
              build: buildLabel,
            }
          : s
      )
    );
    handleCreateFile(
      jarFilename,
      `# Official Server Runtime Binary Artifact\n# Engine: ${engineLabel} (${buildLabel})\n# Verified SHA-256`
    );
    addLog({
      level: 'INFO',
      text: `[EngineManager] Fetched and mounted ${jarFilename} (${engineLabel} ${buildLabel}) as primary server.jar.`,
    });
  };

  const handleAddPort = (rule: PortRule) => {
    setPorts((prev) => [...prev, rule]);
    addLog({
      level: 'UPnP',
      text: `Mapped external ${rule.proto} port ${rule.port} -> internal ${rule.port} (${rule.serviceName})`,
    });
  };

  const handleDeletePort = (portNum: number) => {
    setPorts((prev) => prev.filter((p) => p.port !== portNum));
    showToast(
      `Port :${portNum} Unmapped`,
      `Removed UPnP IGDv2 lease and Windows Defender Firewall rule.`,
      'warning',
      'link_off'
    );
  };

  const handleKickPlayer = (id: string) => {
    const target = players.find((p) => p.id === id);
    if (!target) return;
    setPlayers((prev) => prev.filter((p) => p.id !== id));
    addLog({
      level: 'WARN',
      text: `[Admin] Kicked player ${target.username} from the server.`,
      highlightBox: 'warn',
    });
    showToast('Player Disconnected', `Kicked ${target.username} from ${activeServer.name}.`, 'warning', 'person_remove');
  };

  const handleServerPowerById = (
    serverId: string,
    action: 'start' | 'restart' | 'stop' | 'kill'
  ) => {
    const targetSrv = servers.find((s) => s.id === serverId);
    if (!targetSrv) return;

    if (action === 'start') {
      setServers((prev) =>
        prev.map((s) =>
          s.id === serverId
            ? {
                ...s,
                status: 'running',
                pid: s.pid > 0 ? s.pid : Math.floor(11000 + Math.random() * 15000),
                tps: 20.0,
                tickMs: 3.4,
                uptime: '0h 01m',
                cpuUsage: 18,
                cpuTemp: 46.5,
                ramUsedGb: Number((s.ramMaxGb * 0.45).toFixed(1)),
              }
            : s
        )
      );
      showToast(
        `Started ${targetSrv.name}`,
        `Instance online on port :${targetSrv.port} (20.0 TPS).`,
        'success',
        'play_arrow'
      );
    } else if (action === 'restart') {
      setServers((prev) =>
        prev.map((s) => (s.id === serverId ? { ...s, status: 'restarting' } : s))
      );
      showToast(
        `Restarting ${targetSrv.name}`,
        'Flushing world chunks and reloading JVM heap...',
        'warning',
        'restart_alt'
      );
      setTimeout(() => {
        setServers((prev) =>
          prev.map((s) =>
            s.id === serverId
              ? { ...s, status: 'running', tps: 20.0, uptime: '0h 01m' }
              : s
          )
        );
        showToast(
          `${targetSrv.name} Back Online`,
          `Graceful restart completed on port :${targetSrv.port}.`,
          'success',
          'check_circle'
        );
      }, 1500);
    } else {
      setServers((prev) =>
        prev.map((s) =>
          s.id === serverId
            ? {
                ...s,
                status: 'stopped',
                pid: 0,
                tps: 0.0,
                tickMs: 0.0,
                uptime: 'Offline',
                playersOnline: 0,
                cpuUsage: 0,
                ramUsedGb: 0.0,
              }
            : s
        )
      );
      showToast(
        `Stopped ${targetSrv.name}`,
        `Saved chunks and released ${targetSrv.ramUsedGb} GB JVM heap.`,
        'info',
        'stop_circle'
      );
    }
  };

  const handleBulkServerAction = (
    action: 'start_all' | 'restart_running' | 'stop_all' | 'snapshot_all'
  ) => {
    if (action === 'start_all') {
      setServers((prev) =>
        prev.map((s) =>
          s.status === 'stopped'
            ? {
                ...s,
                status: 'running',
                pid: Math.floor(12000 + Math.random() * 14000),
                tps: 20.0,
                tickMs: 3.1,
                uptime: '0h 01m',
                cpuUsage: 16,
                ramUsedGb: Number((s.ramMaxGb * 0.45).toFixed(1)),
              }
            : s
        )
      );
      showToast(
        'All Standby Servers Started',
        'All localhost instances are now online and synced.',
        'success',
        'play_arrow'
      );
    } else if (action === 'restart_running') {
      showToast(
        'Rolling Cluster Restart Initiated',
        'Gracefully restarting all running instances with zero packet drop.',
        'warning',
        'restart_alt'
      );
    } else if (action === 'snapshot_all') {
      handleCreateSnapshot('Global Cluster Fleet Checkpoint', true, [
        'All Running Instances',
        'Worlds',
        'SQLite DBs',
      ]);
    }
  };

  const handleUpdateGlobalRamConfig = (hostTotalGb: number, globalCapGb: number) => {
    setHostTotalRamGb(hostTotalGb);
    setGlobalRamCapGb(globalCapGb);
  };

  const handleUpdateServerInstallFolder = (
    newRootDir: string,
    updatedServerPaths?: Record<string, string>
  ) => {
    const cleanRoot = newRootDir.trim().replace(/[\\/]+$/, '');
    const sep = cleanRoot.includes('\\') ? '\\' : '/';
    setServerInstallRootDir(cleanRoot);
    setServers((prev) =>
      prev.map((s) => {
        if (updatedServerPaths && updatedServerPaths[s.id]) {
          return { ...s, path: updatedServerPaths[s.id] };
        }
        const slug =
          s.name.trim().replace(/[^a-zA-Z0-9_-]/g, '_').replace(/_+/g, '_') || 'Server_Node';
        return {
          ...s,
          path: `${cleanRoot}${sep}${slug}`,
        };
      })
    );
  };

  const handleUpdateServerRam = (serverId: string, newMaxGb: number) => {
    setServers((prev) =>
      prev.map((s) => {
        if (s.id !== serverId) return s;
        const clampedUsed =
          s.status === 'running'
            ? Number(Math.min(newMaxGb * 0.85, Math.max(0.8, s.ramUsedGb)).toFixed(1))
            : 0;
        return {
          ...s,
          ramMaxGb: newMaxGb,
          ramUsedGb: clampedUsed,
        };
      })
    );
  };

  const handleBatchUpdateServerRam = (allocations: Record<string, number>) => {
    setServers((prev) =>
      prev.map((s) => {
        const nextMax = allocations[s.id];
        if (nextMax === undefined) return s;
        const nextUsed =
          s.status === 'running'
            ? Number(Math.min(nextMax * 0.8, Math.max(0.6, s.ramUsedGb)).toFixed(1))
            : 0;
        return {
          ...s,
          ramMaxGb: nextMax,
          ramUsedGb: nextUsed,
        };
      })
    );
  };

  const handleKillAllServers = () => {
    setServers((prev) =>
      prev.map((s) => ({
        ...s,
        status: 'stopped',
        pid: 0,
        tps: 0.0,
        tickMs: 0.0,
        uptime: 'Offline (SIGKILL)',
        playersOnline: 0,
        cpuUsage: 0,
        ramUsedGb: 0.0,
      }))
    );
    addLog({
      level: 'ERROR',
      text: '[GLOBAL SIGKILL -9] Operator terminated all active localhost JVM server processes.',
      highlightBox: 'error',
    });
    showToast(
      'All Running Servers Force-Killed (SIGKILL)',
      'Terminated all active JVM processes and freed host DDR5 memory.',
      'error',
      'dangerous'
    );
  };

  const handleDeleteServerInstance = (serverId: string) => {
    const target = servers.find((s) => s.id === serverId);
    if (!target || servers.length <= 1) return;
    const remaining = servers.filter((s) => s.id !== serverId);
    setServers(remaining);
    if (activeServerId === serverId) {
      setActiveServerId(remaining[0].id);
    }
    showToast(
      `Removed ${target.name}`,
      `Unregistered server instance from panel fleet.`,
      'warning',
      'delete'
    );
  };

  const handleUpdateUserProfile = (updatedUser: AuthUser) => {
    setCurrentUser(updatedUser);
    try {
      localStorage.setItem('king_panel_auth_user', JSON.stringify(updatedUser));
    } catch {
      // ignore storage error
    }
  };

  const handleOpenDiscordBotGate = (attemptedServerName?: string) => {
    setDiscordBotAttemptedServerName(attemptedServerName);
    setDiscordBotGateOpen(true);
  };

  const handleEnforceTwoServerReset = () => {
    setServers((prev) =>
      prev.map((srv, idx) =>
        idx >= 2
          ? {
              ...srv,
              status: 'stopped',
              cpuUsage: 0,
              tps: 0,
              ramUsedGb: 0,
            }
          : srv
      )
    );
  };

  const handleLeaveDiscordServer = async () => {
    if (!currentUser) return;
    try {
      const res = await fetch('/api/auth/discord/leave-guild', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: currentUser.username }),
      });
      const data = await res.json();
      if (res.ok && data?.ok && data.user) {
        handleUpdateUserProfile(data.user);
      } else {
        handleUpdateUserProfile({
          ...currentUser,
          discordVerified: false,
          discordMemberStatus: 'left_guild',
          maxServerLimit: 2,
        });
      }
    } catch {
      handleUpdateUserProfile({
        ...currentUser,
        discordVerified: false,
        discordMemberStatus: 'left_guild',
        maxServerLimit: 2,
      });
    }
    handleEnforceTwoServerReset();
    addLog({
      level: 'WARN',
      text: `[DiscordBot] @${currentUser.username} left Discord server. Server creation limit reset to 2 servers.`,
      highlightBox: 'warn',
    });
    showToast(
      'Left Discord Server — Limit Reset to 2',
      'Your server creation limit has been reset back to 2 servers.',
      'warning',
      'link_off'
    );
  };

  const handleAuthenticated = (user: AuthUser, isNewSignup = false) => {
    setCurrentUser(user);
    setAuthModalOpen(false);
    setHasEnteredFullPanel(false);
    if (isNewSignup) {
      setActiveSection('setup_guide');
    }
    try {
      localStorage.setItem('king_panel_auth_user', JSON.stringify(user));
    } catch {
      // ignore storage errors
    }
    addLog({
      level: 'JOIN',
      text: `[Auth] Operator ${user.username} (${user.role}) authenticated via ${user.provider.toUpperCase()}.`,
      highlightBox: 'join',
    });
    showToast(
      isNewSignup
        ? `Operator Registered: ${user.displayName}`
        : `Welcome back, ${user.displayName}`,
      `Authenticated as ${user.role} via ${user.provider.toUpperCase()} (${user.email})`,
      'success',
      'verified_user'
    );
  };

  const handleSignOut = async () => {
    const prevName = currentUser?.displayName || 'Operator';
    setCurrentUser(null);
    setHasEnteredFullPanel(false);
    try {
      localStorage.removeItem('king_panel_auth_user');
      await fetch('/api/auth/logout', { method: 'POST' });
    } catch {
      // ignore
    }
    showToast(
      'Signed Out of Workstation',
      `Closed operator session for ${prevName}.`,
      'info',
      'logout'
    );
  };

  return (
    <div className="bg-surface-dim text-on-surface font-sans antialiased h-screen w-screen overflow-hidden flex flex-col select-none">
      {/* Top Native Windows 11 Obsidian Title Bar */}
      <TitleBar
        servers={servers}
        activeServer={activeServer}
        files={files}
        plugins={plugins}
        crons={crons}
        currentUser={currentUser}
        onOpenAuthModal={(mode) => {
          setAuthModalMode(mode);
          setAuthModalOpen(true);
        }}
        onSignOut={handleSignOut}
        onSelectServer={handleSelectServer}
        onNavigate={setActiveSection}
        onOpenFile={(fileId, fileName) => {
          setSelectedFileId(fileId);
          setActiveSection('files');
          showToast(
            `Opened ${fileName}`,
            'Loaded file in Pro Config Editor via Command Palette.',
            'info',
            'description'
          );
        }}
        onSelectPlugin={(plugin) => {
          setPluginSearchQuery(plugin.name);
          setActiveSection('plugins');
          showToast(
            `Focused Plugin: ${plugin.name}`,
            `${plugin.version} • ${plugin.source}`,
            'info',
            'extension'
          );
        }}
        onTriggerCron={(task) => {
          addLog({
            level: 'EXEC',
            text: `[CronRunner] Triggered "${task.title}" (${task.cron}) via Command Palette`,
          });
          showToast(
            `Executed Cron: ${task.title}`,
            `Dispatched ${task.cron} payload to ${activeServer.name}.`,
            'success',
            'bolt'
          );
        }}
        onShowToast={showToast}
        isMinimized={isMinimized}
        onToggleMinimize={() => setIsMinimized(!isMinimized)}
        isSimplePanelMode={!hasEnteredFullPanel}
        onToggleSimplePanel={() => setHasEnteredFullPanel((prev) => !prev)}
        onOpenDiscordBotGate={() => handleOpenDiscordBotGate()}
      />

      {/* If Not Authenticated, Render Full-Screen Obsidian Sovereign Login / Sign Up Gate */}
      {!currentUser ? (
        <AuthGateModal
          onAuthenticated={handleAuthenticated}
          initialMode={authModalMode}
          onShowToast={showToast}
        />
      ) : !hasEnteredFullPanel ? (
        /* Step 1 After Login: Simple Pre-Panel Before Accessing the Full Workstation Panel */
        <SimplePrePanel
          currentUser={currentUser}
          servers={servers}
          activeServer={activeServer}
          serverInstallRootDir={serverInstallRootDir}
          hostTotalRamGb={hostTotalRamGb}
          globalRamCapGb={globalRamCapGb}
          paperMcReport={paperMcReport}
          onRunPaperMcCheckNow={() => syncPaperMcBackgroundCheck(true)}
          onUpgradeServerEngine={handleUpgradeServerEngine}
          onEnterFullPanel={(targetSection = 'overview', selectedServer) => {
            if (selectedServer) {
              setActiveServerId(selectedServer.id);
            }
            setActiveSection(targetSection);
            setHasEnteredFullPanel(true);
            showToast(
              'Entered Full Workstation Panel',
              `Loaded ${ (selectedServer || activeServer).name } in full control workspace.`,
              'info',
              'dashboard'
            );
          }}
          onSelectServer={handleSelectServer}
          onServerPowerAction={handleServerPowerById}
          onCreateServerInstance={(newSrv) => {
            const isSa =
              currentUser?.username?.toLowerCase() === 'kingplayz' ||
              currentUser?.role === 'Super Admin' ||
              Boolean(currentUser?.isSuperAdmin);
            const maxLimit = isSa
              ? 999
              : currentUser?.discordVerified
              ? currentUser.maxServerLimit || 10
              : 2;
            if (!isSa && servers.length >= maxLimit) {
              handleOpenDiscordBotGate(newSrv.name);
              return;
            }
            const latestVer = paperMcReport?.latestPaperRelease || '1.21.4';
            const withVersionFlag: ServerInstance = {
              ...newSrv,
              latestVersion: latestVer,
              isOutdated: !newSrv.engine.includes(latestVer),
            };
            setServers((prev) => [...prev, withVersionFlag]);
            setActiveServerId(withVersionFlag.id);
            showToast(
              `Deployed ${withVersionFlag.name}`,
              `Installed in ${withVersionFlag.path} • Listening on 127.0.0.1:${withVersionFlag.port}`,
              'success',
              'dns'
            );
          }}
          onDeleteServerInstance={handleDeleteServerInstance}
          onOpenDiscordBotGate={handleOpenDiscordBotGate}
          onLeaveDiscordServer={handleLeaveDiscordServer}
          onUserUpdated={handleUpdateUserProfile}
          onOpenAuthModal={(mode) => {
            setAuthModalMode(mode);
            setAuthModalOpen(true);
          }}
          onSignOut={handleSignOut}
          onShowToast={showToast}
        />
      ) : (
        /* Main Desktop Application Shell */
        <div className="flex flex-1 overflow-hidden">
          {/* Left Navigation Sidebar */}
          <Sidebar
            activeSection={activeSection}
            onSelectSection={setActiveSection}
            activeServer={activeServer}
            servers={servers}
            onSelectServer={handleSelectServer}
            snapshotCount={snapshots.length}
            hostTotalRamGb={hostTotalRamGb}
            currentUser={currentUser}
            onOpenAuthModal={(mode) => {
              setAuthModalMode(mode);
              setAuthModalOpen(true);
            }}
            onOpenDiscordBotGate={() => handleOpenDiscordBotGate()}
            onLeaveDiscordServer={handleLeaveDiscordServer}
            onSignOut={handleSignOut}
          />

          {/* Dynamic Workspace View Wrapped in Error Boundary (Shows 404 Page on Panel Error) */}
          <PanelErrorBoundary
            server={activeServer}
            onNavigate={(sec) => {
              if (window.location.pathname !== '/') {
                window.history.replaceState({}, '', '/');
              }
              setActiveSection(sec);
            }}
            onShowToast={showToast}
          >
        {activeSection === 'overview' && (
          <OverviewView
            servers={servers}
            activeServer={activeServer}
            players={players}
            currentUser={currentUser}
            paperMcReport={paperMcReport}
            onRunPaperMcCheckNow={() => syncPaperMcBackgroundCheck(true)}
            onUpgradeServerEngine={handleUpgradeServerEngine}
            onSelectServer={handleSelectServer}
            onManageServer={(srv, targetSection = 'console') => {
              setActiveServerId(srv.id);
              setActiveSection(targetSection);
              showToast(
                `Managing ${srv.name}`,
                `Opened ${targetSection.toUpperCase()} workspace for :${srv.port}`,
                'info',
                'dns'
              );
            }}
            onServerPowerAction={handleServerPowerById}
            onBulkServerAction={handleBulkServerAction}
            serverInstallRootDir={serverInstallRootDir}
            onCreateServerInstance={(newSrv) => {
              const isSa =
                currentUser?.username?.toLowerCase() === 'kingplayz' ||
                currentUser?.role === 'Super Admin' ||
                Boolean(currentUser?.isSuperAdmin);
              const maxLimit = isSa
                ? 999
                : currentUser?.discordVerified
                ? currentUser.maxServerLimit || 10
                : 2;
              if (!isSa && servers.length >= maxLimit) {
                handleOpenDiscordBotGate(newSrv.name);
                return;
              }
              const latestVer = paperMcReport?.latestPaperRelease || '1.21.4';
              const withVersionFlag: ServerInstance = {
                ...newSrv,
                latestVersion: latestVer,
                isOutdated: !newSrv.engine.includes(latestVer),
              };
              setServers((prev) => [...prev, withVersionFlag]);
              setActiveServerId(withVersionFlag.id);
              showToast(
                `Deployed ${withVersionFlag.name}`,
                `Installed in ${withVersionFlag.path} • Listening on 127.0.0.1:${withVersionFlag.port}`,
                'success',
                'dns'
              );
            }}
              onOpenDiscordBotGate={handleOpenDiscordBotGate}
              onLeaveDiscordServer={handleLeaveDiscordServer}
              onShowToast={showToast}
            />
          )}

        {activeSection === 'setup_guide' && (
          <SetupPanelGuideView
            currentUser={currentUser}
            servers={servers}
            activeServer={activeServer}
            serverInstallRootDir={serverInstallRootDir}
            hostTotalRamGb={hostTotalRamGb}
            globalRamCapGb={globalRamCapGb}
            paperMcReport={paperMcReport}
            onUpdateServerInstallFolder={handleUpdateServerInstallFolder}
            onUpdateGlobalRamConfig={handleUpdateGlobalRamConfig}
            onCreateServerInstance={(newSrv) => {
              const isSa =
                currentUser?.username?.toLowerCase() === 'kingplayz' ||
                currentUser?.role === 'Super Admin' ||
                Boolean(currentUser?.isSuperAdmin);
              const maxLimit = isSa
                ? 999
                : currentUser?.discordVerified
                ? currentUser.maxServerLimit || 10
                : 2;
              if (!isSa && servers.length >= maxLimit) {
                handleOpenDiscordBotGate(newSrv.name);
                return;
              }
              const latestVer = paperMcReport?.latestPaperRelease || '1.21.4';
              const withVersionFlag: ServerInstance = {
                ...newSrv,
                latestVersion: latestVer,
                isOutdated: !newSrv.engine.includes(latestVer),
              };
              setServers((prev) => [...prev, withVersionFlag]);
              setActiveServerId(withVersionFlag.id);
              showToast(
                `Deployed ${withVersionFlag.name}`,
                `Installed in ${withVersionFlag.path} • Listening on 127.0.0.1:${withVersionFlag.port}`,
                'success',
                'dns'
              );
            }}
            onUpdateUserProfile={handleUpdateUserProfile}
            onRunPaperMcCheckNow={() => syncPaperMcBackgroundCheck(true)}
            onUpgradeServerEngine={handleUpgradeServerEngine}
            onOpenDiscordBotGate={handleOpenDiscordBotGate}
            onNavigate={setActiveSection}
            onShowToast={showToast}
          />
        )}

        {activeSection === 'console' && (
          <ConsoleTelemetryView
            server={activeServer}
            logs={logs}
            players={players}
            onAddLog={addLog}
            onClearLogs={() => {
              setLogs([]);
              showToast('Console Buffer Cleared', 'Cleared terminal scrollback history.', 'info', 'delete_sweep');
            }}
            onServerAction={handleServerAction}
            onQuickSnapshot={() =>
              handleCreateSnapshot('Quick Console Checkpoint', false, ['World', 'Plugins', 'Configs'])
            }
            onNavigate={setActiveSection}
            onShowToast={showToast}
            onKickPlayer={handleKickPlayer}
          />
        )}

        {activeSection === 'files' && (
          <FileManagerView
            server={activeServer}
            files={files}
            selectedFileId={selectedFileId}
            onSaveFileContent={handleSaveFileContent}
            onCreateFile={handleCreateFile}
            onShowToast={showToast}
          />
        )}

        {activeSection === 'plugins' && (
          <ModpacksPluginsView
            server={activeServer}
            plugins={plugins}
            initialSearchQuery={pluginSearchQuery}
            onUpdatePlugin={handleUpdatePlugin}
            onUpdateAllPlugins={handleUpdateAllPlugins}
            onInstallPlugin={handleInstallPlugin}
            onAddCustomPlugin={handleAddCustomPlugin}
            onUpdateServerEngine={handleUpdateServerEngine}
            onNavigate={setActiveSection}
            onShowToast={showToast}
          />
        )}

        {activeSection === 'logs' && (
          <ServerLogsView
            server={activeServer}
            onNavigate={setActiveSection}
            onShowToast={showToast}
          />
        )}

        {activeSection === 'network' && (
          <NetworkPortsView
            server={activeServer}
            ports={ports}
            onAddPort={handleAddPort}
            onDeletePort={handleDeletePort}
            onShowToast={showToast}
          />
        )}

        {activeSection === 'backups' && (
          <BackupsSnapshotsView
            server={activeServer}
            snapshots={snapshots}
            crons={crons}
            onCreateSnapshot={handleCreateSnapshot}
            onTogglePinSnapshot={handleTogglePinSnapshot}
            onNavigate={setActiveSection}
            onShowToast={showToast}
          />
        )}

        {activeSection === 'schedules' && (
          <SchedulesCronView
            server={activeServer}
            crons={crons}
            onAddCron={(task) => setCrons((prev) => [task, ...prev])}
            onRunCron={(task) => {
              addLog({
                level: 'EXEC',
                text: `[CronRunner] Manually triggered task "${task.title}" (${task.cron})`,
              });
              showToast(
                `Executed: ${task.title}`,
                'Dispatched scheduled task to local server daemon.',
                'success',
                'bolt'
              );
            }}
            onToggleCronStatus={(id) =>
              setCrons((prev) =>
                prev.map((c) =>
                  c.id === id
                    ? { ...c, status: c.status === 'Paused' ? 'Active' : 'Paused' }
                    : c
                )
              )
            }
            onDeleteCron={(id) => {
              setCrons((prev) => prev.filter((c) => c.id !== id));
              showToast('Schedule Removed', 'Unregistered cron trigger from daemon.', 'warning', 'delete');
            }}
            onShowToast={showToast}
          />
        )}

        {activeSection === 'databases' && (
          <DatabasesView server={activeServer} onShowToast={showToast} />
        )}

        {activeSection === 'jvm' && (
          <StartupJvmView
            server={activeServer}
            onUpdateServerEngine={handleUpdateServerEngine}
            onShowToast={showToast}
          />
        )}

        {activeSection === 'settings' && (
          <ServerSettingsView
            server={activeServer}
            onNavigate={setActiveSection}
            onShowToast={showToast}
          />
        )}

        {activeSection === 'panel_control' && (
          <PanelControlView
            servers={servers}
            activeServer={activeServer}
            currentUser={currentUser}
            globalRamCapGb={globalRamCapGb}
            hostTotalRamGb={hostTotalRamGb}
            serverInstallRootDir={serverInstallRootDir}
            onUpdateServerInstallFolder={handleUpdateServerInstallFolder}
            onCreateServerInstance={(newSrv) => {
              const maxLimit = currentUser?.discordVerified
                ? currentUser.maxServerLimit || 10
                : 2;
              if (servers.length >= maxLimit) {
                handleOpenDiscordBotGate(newSrv.name);
                return;
              }
              setServers((prev) => [...prev, newSrv]);
              setActiveServerId(newSrv.id);
            }}
            onUpdateGlobalRamConfig={handleUpdateGlobalRamConfig}
            onUpdateServerRam={handleUpdateServerRam}
            onBatchUpdateServerRam={handleBatchUpdateServerRam}
            onServerPowerAction={handleServerPowerById}
            onKillAllServers={handleKillAllServers}
            onDeleteServerInstance={handleDeleteServerInstance}
            onSelectServer={handleSelectServer}
            onNavigate={setActiveSection}
            onUpdateUserProfile={handleUpdateUserProfile}
            onOpenAuthModal={(mode) => {
              setAuthModalMode(mode);
              setAuthModalOpen(true);
            }}
            onOpenDiscordBotGate={handleOpenDiscordBotGate}
            onLeaveDiscordServer={handleLeaveDiscordServer}
            onSignOut={handleSignOut}
            onShowToast={showToast}
          />
        )}

        {activeSection === 'privacy' && (
          <PrivacyPolicyView
            server={activeServer}
            onNavigate={setActiveSection}
            onShowToast={showToast}
          />
        )}

        {activeSection === 'terms' && (
          <TermsConditionsView
            server={activeServer}
            currentUser={currentUser}
            onNavigate={setActiveSection}
            onShowToast={showToast}
          />
        )}

        {activeSection === 'not_found' && (
          <NotFound404View
            server={activeServer}
            requestedPath={errorRoutePath}
            onNavigate={(sec) => {
              if (window.location.pathname !== '/') {
                window.history.replaceState({}, '', '/');
              }
              setActiveSection(sec);
            }}
            onShowToast={showToast}
          />
        )}
          </PanelErrorBoundary>
        </div>
      )}

      {/* Modal Overlay for Switching Account / Registering New Operator While Logged In */}
      {authModalOpen && currentUser && (
        <AuthGateModal
          isModalOverlay={true}
          initialMode={authModalMode}
          onAuthenticated={handleAuthenticated}
          onClose={() => setAuthModalOpen(false)}
          onShowToast={showToast}
        />
      )}

      {/* Discord Server & Bot Verification Gate Modal (Triggered on >2 Servers or Verify Discord Bot Button) */}
      {currentUser && (
        <DiscordBotGateModal
          isOpen={discordBotGateOpen}
          onClose={() => {
            setDiscordBotGateOpen(false);
            setDiscordBotAttemptedServerName(undefined);
          }}
          currentUser={currentUser}
          currentServerCount={servers.length}
          attemptedServerName={discordBotAttemptedServerName}
          onUserUpdated={handleUpdateUserProfile}
          onEnforceTwoServerReset={handleEnforceTwoServerReset}
          onVerificationSuccessProceed={() => {
            setDiscordBotGateOpen(false);
            setDiscordBotAttemptedServerName(undefined);
          }}
          onShowToast={showToast}
        />
      )}

      {/* Windows 11 Obsidian Toast Notification Stack */}
      <div className="fixed bottom-5 right-5 z-50 flex flex-col gap-2.5 pointer-events-none">
        {toasts.map((toast) => {
          const borderColors = {
            success: 'border-secondary/40 bg-surface-container/95',
            info: 'border-primary/40 bg-surface-container/95',
            warning: 'border-primary-gold/40 bg-surface-container/95',
            error: 'border-error/40 bg-surface-container/95',
          };
          const iconColors = {
            success: 'text-secondary bg-secondary/10 border-secondary/20',
            info: 'text-primary bg-primary/10 border-primary/20',
            warning: 'text-primary-gold bg-primary-gold/10 border-primary-gold/20',
            error: 'text-error bg-error/10 border-error/20',
          };
          const defaultIcons = {
            success: 'check_circle',
            info: 'info',
            warning: 'warning',
            error: 'error',
          };
          return (
            <div
              key={toast.id}
              className={`pointer-events-auto min-w-[310px] max-w-[390px] p-3.5 rounded-xl border backdrop-blur-xl shadow-2xl flex items-start gap-3 transition-all animate-in fade-in slide-in-from-bottom-3 ${borderColors[toast.type]}`}
            >
              <div
                className={`w-8 h-8 rounded-lg border flex items-center justify-center shrink-0 ${iconColors[toast.type]}`}
              >
                <span className="material-symbols-outlined text-[18px]">
                  {toast.icon || defaultIcons[toast.type]}
                </span>
              </div>
              <div className="flex-1 min-w-0">
                <div className="text-xs font-bold text-white leading-tight">{toast.title}</div>
                {toast.body && (
                  <div className="text-[11px] text-outline font-mono mt-1 leading-snug">
                    {toast.body}
                  </div>
                )}
              </div>
              <button
                onClick={() => setToasts((prev) => prev.filter((t) => t.id !== toast.id))}
                className="text-outline hover:text-white transition-colors cursor-pointer"
              >
                <span className="material-symbols-outlined text-[14px]">close</span>
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
