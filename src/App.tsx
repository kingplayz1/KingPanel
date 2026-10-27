/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  NavSection,
  ServerInstance,
  ToastMessage,
  ConsoleLogLine,
  ConnectedPlayer,
  FileItem,
  PluginItem,
  SnapshotItem,
  CronTask,
  AuthUser,
  PaperMCServiceReport,
} from './types';
import {
  INITIAL_SERVERS,
  EMPTY_SERVER_PLACEHOLDER,
  INITIAL_CONSOLE_LOGS,
  INITIAL_PLAYERS,
  INITIAL_FILES,
  INITIAL_PLUGINS,
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
import { usePanelAccess } from './hooks/usePanelAccess';
import { SimplePrePanel } from './components/SimplePrePanel';
import { SimpleServerPanel } from './components/SimpleServerPanel';
import ProviderConnectionsPanel from './components/ProviderConnectionsPanel';
import { SetupPanelGuideView } from './views/SetupPanelGuideView';
import AccountSecurityPanel from './components/AccountSecurityPanel';
import SessionManagementPanel from './components/SessionManagementPanel';
import { DesktopCloseModal } from './components/DesktopCloseModal';
import { submitJob } from './lib/jobs';

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
  const [activeServerId, setActiveServerId] = useState<string>(
    INITIAL_SERVERS[0]?.id ?? EMPTY_SERVER_PLACEHOLDER.id
  );
  const [logs, setLogs] = useState<ConsoleLogLine[]>(INITIAL_CONSOLE_LOGS);
  const [players, setPlayers] = useState<ConnectedPlayer[]>(INITIAL_PLAYERS);
  const [files, setFiles] = useState<FileItem[]>(INITIAL_FILES);
  const [plugins, setPlugins] = useState<PluginItem[]>(INITIAL_PLUGINS);
  const [snapshots, setSnapshots] = useState<SnapshotItem[]>(INITIAL_SNAPSHOTS);
  const [crons, setCrons] = useState<CronTask[]>(INITIAL_CRONS);
  const [toasts, setToasts] = useState<ToastMessage[]>([]);
  const [isMinimized, setIsMinimized] = useState(false);
  const [isMaximized, setIsMaximized] = useState(false);
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
  // 'simple' renders the clean per-server page (no desktop title bar);
  // 'advanced' opens the full workstation shell with sidebar + views.
  const [panelMode, setPanelMode] = useState<'simple' | 'advanced'>('simple');
  const [discordBotGateOpen, setDiscordBotGateOpen] = useState<boolean>(false);
  const [discordGatePurpose, setDiscordGatePurpose] = useState<'limit' | 'advanced'>('limit');
  const [exitConfirmOpen, setExitConfirmOpen] = useState(false);
  const [discordBotAttemptedServerName, setDiscordBotAttemptedServerName] = useState<
    string | undefined
  >(undefined);
  const [paperMcReport, setPaperMcReport] = useState<PaperMCServiceReport | null>(null);
  // Delete confirmation dialog state
  const [deleteTarget, setDeleteTarget] = useState<ServerInstance | null>(null);
  const [deleteServerFiles, setDeleteServerFiles] = useState(true);
  const [deletingServer, setDeletingServer] = useState(false);

  const activeServer =
    servers.find((s) => s.id === activeServerId) || servers[0] || EMPTY_SERVER_PLACEHOLDER;

  // Every section opens at the top of its own workspace, not where the last one was left.
  const workspaceScrollRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    workspaceScrollRef.current?.scrollTo({ top: 0, behavior: 'auto' });
  }, [activeSection, activeServer.id]);

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

  // The backend is the authority for panel access; this only mirrors it.
  const {
    access: panelAccess,
    loading: panelAccessLoading,
    error: panelAccessError,
    sessionExpired,
    refresh: refreshPanelAccess,
  } = usePanelAccess(currentUser?.id);
  const advancedPanelAllowed = panelAccess?.panels.advanced.allowed === true;

  // A session cookie that is gone (or expired) invalidates the cached profile,
  // so drop back to the login gate instead of showing a half-working panel.
  useEffect(() => {
    if (!sessionExpired || !currentUser) return;
    setCurrentUser(null);
    setHasEnteredFullPanel(false);
    setPanelMode('simple');
    try {
      localStorage.removeItem('king_panel_auth_user');
    } catch {
      // ignore storage errors
    }
    showToast(
      'Session Expired',
      'Sign in again to keep managing your servers.',
      'warning',
      'lock_clock'
    );
  }, [sessionExpired, currentUser, showToast]);

  // Keep the profile badge and server limit in step with the authoritative
  // access payload (for example after an app restart or a Discord role change).
  useEffect(() => {
    if (!panelAccess || !currentUser) return;
    const verified =
      panelAccess.discord.guildMember && panelAccess.discord.requiredRolePresent;
    if (
      Boolean(currentUser.discordVerified) === verified &&
      currentUser.maxServerLimit === panelAccess.user.maxServerLimit
    ) {
      return;
    }
    const merged: AuthUser = {
      ...currentUser,
      discordVerified: verified,
      discordMemberStatus: verified
        ? 'verified_in_guild'
        : panelAccess.discord.linked
          ? 'left_guild'
          : 'not_connected',
      discordUserId: panelAccess.discord.discordUserId || currentUser.discordUserId,
      discordUsername: panelAccess.discord.username || currentUser.discordUsername,
      maxServerLimit: panelAccess.user.maxServerLimit,
    };
    setCurrentUser(merged);
    try {
      localStorage.setItem('king_panel_auth_user', JSON.stringify(merged));
    } catch {
      // ignore storage errors
    }
  }, [panelAccess, currentUser]);

  // Losing the Discord entitlement while the Advanced Panel is open moves the
  // operator back to the Simple Panel without hiding their servers.
  useEffect(() => {
    if (!currentUser || !panelAccess) return;
    if (panelMode === 'advanced' && !advancedPanelAllowed) {
      setPanelMode('simple');
      showToast(
        'Advanced Panel Locked',
        panelAccess.panels.advanced.message,
        'warning',
        'lock'
      );
    }
  }, [currentUser, panelAccess, advancedPanelAllowed, panelMode, showToast]);

  /**
   * Single entry point for switching views. Advanced mode is refused here and
   * re-checked by Express on every advanced operation.
   */
  const handleEnterPanel = (
    targetSection: Parameters<typeof setActiveSection>[0] = 'overview',
    selectedServer?: ServerInstance,
    mode: 'simple' | 'advanced' = 'advanced'
  ) => {
    if (mode === 'advanced' && !advancedPanelAllowed) {
      setDiscordBotAttemptedServerName(undefined);
      setDiscordGatePurpose('advanced');
      setDiscordBotGateOpen(true);
      showToast(
        'Advanced Panel Requires Discord Verification',
        panelAccess?.panels.advanced.message ||
          'Link Discord, join the official server and complete verification first.',
        'warning',
        'lock'
      );
      return;
    }
    if (selectedServer) {
      setActiveServerId(selectedServer.id);
    }
    setActiveSection(targetSection);
    setPanelMode(mode);
    setHasEnteredFullPanel(true);
    showToast(
      mode === 'simple' ? 'Simple Panel Opened' : 'Entered Full Workstation Panel',
      mode === 'simple'
        ? `Live status, power controls and console for ${(selectedServer || activeServer).name}.`
        : `Loaded ${(selectedServer || activeServer).name} in full control workspace.`,
      'info',
      mode === 'simple' ? 'terminal' : 'dashboard'
    );
  };

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

  // Signed-out clients must not poll: every backend endpoint requires a session,
  // so an interval started before sign-in only produces 401s.
  useEffect(() => {
    if (!currentUser) return;
    syncPaperMcBackgroundCheck(false);
    const interval = setInterval(() => {
      syncPaperMcBackgroundCheck(false);
    }, 45_000);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentUser]);

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

  // Snapshots shown in the advanced views are the archives on disk. Reload them
  // from the backend instead of keeping a local copy that drifts from reality.
  const loadSnapshots = useCallback(async (srv: ServerInstance) => {
    try {
      const res = await fetch(
        `/api/backups/realtime?serverId=${encodeURIComponent(srv.id)}&serverName=${encodeURIComponent(srv.name)}`
      );
      const data = await res.json();
      if (!data?.ok) return;
      const mapped: SnapshotItem[] = (data.snapshots || []).map((rec: Record<string, unknown>) => ({
        id: String(rec.id),
        title: String(rec.title),
        badge: String(rec.badge),
        badgeType: (rec.badgeType as SnapshotItem['badgeType']) || 'neutral',
        verified: Boolean(rec.verified),
        pinned: Boolean(rec.pinned),
        timestamp: rec.timestamp ? new Date(String(rec.timestamp)).toLocaleString() : '',
        size: String(rec.size || ''),
        note: rec.note ? String(rec.note) : undefined,
        scopes: Array.isArray(rec.scopes) ? (rec.scopes as string[]) : [],
        destination: String(rec.filePath || ''),
        sha: rec.sha256 ? String(rec.sha256) : undefined,
        icon: String(rec.icon || 'archive'),
        iconColor: String(rec.iconColor || 'bg-primary/15 text-primary'),
        serverId: rec.serverId ? String(rec.serverId) : undefined,
      }));
      setSnapshots(mapped);
    } catch {
      // backend restarting — keep the last known list
    }
  }, []);

  // Keep the advanced Backups view pointed at the real archives folder.
  useEffect(() => {
    void loadSnapshots(activeServer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeServer.id, loadSnapshots]);

  const handleSelectServer = (srv: ServerInstance) => {
    setActiveServerId(srv.id);
    showToast(
      `Switched to ${srv.name}`,
      `Engine: ${srv.engine} • Port :${srv.port} (PID ${srv.pid})`,
      'info',
      'dns'
    );
  };

  // Poll the real supervisor until the process reaches a terminal state after a
  // power action. Status, logs and toasts reflect REAL backend outcomes — no
  // locally simulated results.
  const awaitServerSettled = async (
    srv: ServerInstance,
    action: 'restart' | 'stop' | 'kill' | 'start'
  ) => {
    const limitMs = action === 'start' || action === 'restart' ? 300_000 : 60_000;
    const startedAt = Date.now();
    const applyStatus = (
      status: 'running' | 'restarting' | 'stopped',
      extra: Partial<ServerInstance> = {}
    ) =>
      setServers((prev) => prev.map((s) => (s.id === srv.id ? { ...s, ...extra, status } : s)));

    while (Date.now() - startedAt < limitMs) {
      await new Promise((r) => setTimeout(r, 1200));
      try {
        const res = await fetch(
          `/api/server-runtime/live-state?serverId=${encodeURIComponent(srv.id)}&serverName=${encodeURIComponent(
            srv.name
          )}&engine=${encodeURIComponent(srv.engine)}&port=${srv.port}&ramMaxGb=${srv.ramMaxGb}`
        );
        const data = await res.json();
        if (!res.ok || !data?.ok) continue;

        if (data.status === 'running') {
          applyStatus('running', {
            pid: data.pid ?? srv.pid,
            uptime: data.uptimeFormatted ?? srv.uptime,
            cpuUsage: Math.round(data.cpuUsagePct ?? 0),
            ramUsedGb: data.ramUsedGb ?? srv.ramUsedGb,
          });
          addLog({
            level: 'INFO',
            text: `Server is ONLINE — PID ${data.pid ?? 'n/a'}, uptime ${data.uptimeFormatted}${
              data.adopted ? ' (reattached after app restart)' : ''
            }.`,
          });
          showToast(
            'Server Online',
            `${srv.name} is running (PID ${data.pid ?? 'n/a'}).`,
            'success',
            'check_circle'
          );
          return;
        }
        if (data.status === 'restarting') continue; // transitional — keep polling

        // Terminal: the process is not running
        applyStatus('stopped', { cpuUsage: 0, tps: 0 });
        if (data.crashed) {
          addLog({
            level: 'ERROR',
            text: `[KingDaemon] Server process exited unexpectedly (code ${
              data.lastExitCode ?? 'unknown'
            })${data.lastExitReason ? ` — ${data.lastExitReason}` : ''}.`,
            highlightBox: 'error',
          });
          showToast(
            'Server Crashed',
            `${srv.name} exited (code ${data.lastExitCode ?? 'unknown'}). Check the console/logs.`,
            'error',
            'error'
          );
        } else if (action === 'start') {
          addLog({
            level: 'ERROR',
            text: `[KingDaemon] Server failed to start${data.lastExitReason ? `: ${data.lastExitReason}` : ''}.`,
            highlightBox: 'error',
          });
          showToast(
            'Server Did Not Start',
            data.lastExitReason || 'The process exited before it was ready.',
            'error',
            'error'
          );
        } else {
          addLog({ level: 'INFO', text: `[KingDaemon] Process exited — ${srv.name} is stopped.` });
          showToast('Server Stopped', `${srv.name} has been stopped.`, 'info', 'stop_circle');
        }
        return;
      } catch {
        // transient polling error — retry until the deadline
      }
    }
    addLog({
      level: 'WARN',
      text: `[KingDaemon] No terminal state after ${Math.round(limitMs / 1000)}s — check the console tab for progress.`,
      highlightBox: 'warn',
    });
    showToast('Still Waiting', `${srv.name} has not reached a final state yet.`, 'warning', 'hourglass_empty');
  };

  const handleServerAction = (action: 'restart' | 'stop' | 'kill' | 'start') => {
    const srv = activeServer;
    if (!srv || srv.id === 'no-server') {
      showToast('No Server Selected', 'Create or import a server first.', 'warning', 'add_circle');
      return;
    }
    const previousStatus = srv.status;
    const requestLines: Record<string, string> = {
      start: '[KingDaemon] Start requested — spawning the real server process...',
      stop: '[KingDaemon] Graceful stop requested (stdin: stop) — waiting for process exit...',
      kill: '[KingDaemon] Force-kill requested — terminating the process tree...',
      restart: '[KingDaemon] Restart requested — graceful stop, then start...',
    };
    setServers((prev) => prev.map((s) => (s.id === srv.id ? { ...s, status: 'restarting' } : s)));
    addLog({ level: 'INFO', text: requestLines[action] });

    (async () => {
      try {
        const res = await fetch('/api/server-runtime/power', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            serverId: srv.id,
            serverName: srv.name,
            engine: srv.engine,
            port: srv.port,
            ramMaxGb: srv.ramMaxGb,
            action,
          }),
        });
        const data = await res.json().catch(() => null);
        if (!res.ok || !data?.ok) {
          const message = data?.error || `Backend refused '${action}'`;
          setServers((prev) =>
            prev.map((s) => (s.id === srv.id ? { ...s, status: previousStatus } : s))
          );
          addLog({ level: 'ERROR', text: `[KingDaemon] ${action} failed: ${message}`, highlightBox: 'error' });
          showToast('Action Failed', message, 'error', 'error');
          return;
        }
        await awaitServerSettled(srv, action);
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Could not reach the local backend';
        setServers((prev) => prev.map((s) => (s.id === srv.id ? { ...s, status: previousStatus } : s)));
        addLog({ level: 'ERROR', text: `[KingDaemon] ${action} failed: ${message}`, highlightBox: 'error' });
        showToast('Action Failed', message, 'error', 'error');
      }
    })();
  };

  const handleCreateSnapshot = async (tag: string, pinned: boolean, scopes: string[]) => {
    const target = activeServer;
    if (!target) return;
    try {
      const outcome = await submitJob<Record<string, any>>('/api/backups/create', {
        serverId: target.id,
        serverName: target.name,
        title: tag || 'manual-checkpoint',
        scopes,
      });
      const data = (outcome.result || {}) as Record<string, any>;
      if (!outcome.ok) {
        showToast(
          'Backup failed',
          outcome.error || 'Could not write the archive',
          'error',
          'error'
        );
        return;
      }
      if (pinned && data.snapshot?.id) {
        await fetch('/api/backups/pin', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ serverId: target.id, serverName: target.name, id: data.snapshot.id }),
        });
      }
      addLog({
        level: 'INFO',
        text: `[Backup] Created archive ${data.archive?.name} (${Math.round(
          (Number(data.archive?.sizeBytes) || 0) / 1024 / 1024
        )} MB) for ${target.name}.`,
      });
      showToast(
        'Backup created',
        `${data.archive?.name || 'archive'} written to ${target.name}/backups`,
        'success',
        'archive'
      );
      await loadSnapshots(target);
    } catch (err) {
      showToast('Backup failed', err instanceof Error ? err.message : 'Backend unreachable', 'error', 'error');
    }
  };

  const handleTogglePinSnapshot = async (id: string) => {
    const target = activeServer;
    if (!target) return;
    try {
      const res = await fetch('/api/backups/pin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ serverId: target.id, serverName: target.name, id }),
      });
      const data = await res.json();
      if (!data?.ok) {
        showToast('Pin failed', data?.error, 'error', 'keep');
        return;
      }
      await loadSnapshots(target);
      showToast('Snapshot pin updated', 'Pinned archives are kept out of rotation.', 'info', 'keep');
    } catch (err) {
      showToast('Pin failed', err instanceof Error ? err.message : 'Backend unreachable', 'error', 'keep');
    }
  };

  // The palette searches real filenames from the instance folder.
  const refreshFileIndex = useCallback(async () => {
    try {
      const res = await fetch(
        `/api/server-runtime/files?serverId=${encodeURIComponent(
          activeServer.id
        )}&serverName=${encodeURIComponent(activeServer.name)}&path=.`
      );
      const data = await res.json();
      if (!data?.ok || !Array.isArray(data.entries)) return;
      const mapped: FileItem[] = data.entries.map(
        (e: { name: string; isDir: boolean; sizeBytes: number; modifiedAt: string }) => ({
          id: e.name,
          name: e.name,
          path: `${activeServer.path}/${e.name}`,
          type: e.isDir ? 'folder' : 'file',
          size: e.isDir
            ? undefined
            : e.sizeBytes < 1024
              ? `${e.sizeBytes} B`
              : e.sizeBytes < 1048576
                ? `${(e.sizeBytes / 1024).toFixed(1)} KB`
                : `${(e.sizeBytes / 1048576).toFixed(1)} MB`,
          icon: e.isDir ? 'folder' : 'description',
          iconColor: e.isDir ? 'text-primary' : 'text-on-surface-variant',
          modifiedAt: e.modifiedAt,
        })
      );
      setFiles(mapped);
    } catch {
      // backend restarting — keep the last known listing
    }
  }, [activeServer.id, activeServer.name, activeServer.path]);

  useEffect(() => {
    void refreshFileIndex();
  }, [refreshFileIndex]);

  // Registry packages are installed for real: the backend downloads the jar into
  // the instance's plugins/ or mods/ folder and reports the bytes written.
  const installRegistryPackage = async (
    plugin: PluginItem
  ): Promise<{ ok: boolean; versionNumber?: string; filename?: string; error?: string }> => {
    const slug = plugin.id.startsWith('live-') ? plugin.id.slice(5) : '';
    if (!slug) {
      return {
        ok: false,
        error: `${plugin.name} has no Modrinth project id — only registry packages can be downloaded.`,
      };
    }
    try {
      const res = await fetch('/api/marketplace/install', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          serverId: activeServer.id,
          serverName: activeServer.name,
          slug,
          projectType: plugin.category.toLowerCase().includes('plugin') ? 'plugin' : 'mod',
        }),
      });
      const data = await res.json();
      if (!res.ok || !data?.ok) {
        return { ok: false, error: String(data?.error || 'Backend refused the download') };
      }
      await refreshFileIndex();
      return {
        ok: true,
        versionNumber: String(data.versionNumber || ''),
        filename: String(data.filename || ''),
      };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : 'Backend unreachable' };
    }
  };

  const handleUpdatePlugin = async (pluginId: string) => {
    const plugin = plugins.find((p) => p.id === pluginId);
    if (!plugin) return;
    const result = await installRegistryPackage(plugin);
    if (!result.ok) {
      showToast('Update failed', result.error || 'Download failed', 'error', 'error');
      return;
    }
    setPlugins((prev) =>
      prev.map((p) =>
        p.id === pluginId
          ? { ...p, version: `${result.versionNumber} Installed`, status: 'installed' }
          : p
      )
    );
    addLog({
      level: 'INFO',
      text: `[Marketplace] Updated ${plugin.name} to ${result.versionNumber} (${result.filename}) in ${activeServer.name}`,
    });
    showToast(
      `Updated ${plugin.name}`,
      `${result.filename} written to the server folder. Restart to load it.`,
      'success',
      'published_with_changes'
    );
  };

  const handleUpdateAllPlugins = async () => {
    const targets = plugins.filter((p) => p.status === 'update_ready');
    if (!targets.length) {
      showToast('Nothing to update', 'No registry package is flagged as outdated.', 'info', 'info');
      return;
    }
    const updated: Record<string, string> = {};
    for (const plugin of targets) {
      const result = await installRegistryPackage(plugin);
      if (result.ok) {
        updated[plugin.id] = result.versionNumber || '';
      } else {
        addLog({
          level: 'ERROR',
          text: `[Marketplace] ${plugin.name}: ${result.error || 'download failed'}`,
        });
      }
    }
    const count = Object.keys(updated).length;
    setPlugins((prev) =>
      prev.map((p) =>
        updated[p.id] !== undefined ? { ...p, version: `${updated[p.id]} Installed`, status: 'installed' } : p
      )
    );
    showToast(
      count ? `Updated ${count} package(s)` : 'Update failed',
      count
        ? 'Downloaded into the server folder. Restart the server to load them.'
        : 'Every download failed — see the console log for the backend error.',
      count ? 'success' : 'error',
      count ? 'done_all' : 'error'
    );
  };

  const handleInstallPlugin = async (pluginId: string) => {
    const plugin = plugins.find((p) => p.id === pluginId);
    if (!plugin) return;
    const result = await installRegistryPackage(plugin);
    if (!result.ok) {
      showToast('Install failed', result.error || 'Download failed', 'error', 'error');
      return;
    }
    setPlugins((prev) =>
      prev.map((p) =>
        p.id === pluginId
          ? { ...p, status: 'installed', version: `${result.versionNumber} Installed` }
          : p
      )
    );
    showToast(
      `Installed ${plugin.name}`,
      `${result.filename} written to the server folder. Restart to load it.`,
      'success',
      'download_done'
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
      text: `[Marketplace] ${newPlugin.name} ${newPlugin.version} is installed in ${activeServer.name}`,
    });
  };

  // Real engine swap: the backend downloads the requested server jar straight
  // into the instance folder and reports the bytes it wrote.
  const handleUpdateServerEngine = async (
    engineLabel: string,
    buildLabel: string,
    jarFilename: string,
    build?: { downloadUrl: string; filename: string; build: string | number }
  ) => {
    const [engineToken, versionToken] = engineLabel.trim().split(/\s+/);
    try {
      const outcome = await submitJob<Record<string, any>>('/api/server-runtime/install-jar', {
        serverId: activeServer.id,
        serverName: activeServer.name,
        engine: (engineToken || '').toLowerCase(),
        version: versionToken || '',
        downloadUrl: build?.downloadUrl || '',
        filename: build?.filename || jarFilename,
        build: build ? String(build.build) : '',
      });
      const data = (outcome.result || {}) as Record<string, any>;
      if (!outcome.ok) {
        showToast(
          'JAR install failed',
          String(outcome.error || `No downloadable ${jarFilename} for ${engineLabel}`),
          'error',
          'error'
        );
        return;
      }
      setServers((prev) =>
        prev.map((s) =>
          s.id === activeServer.id
            ? {
                ...s,
                engine: `${data.engine} ${data.version}`.trim(),
                build: data.build ? `Build #${data.build}` : buildLabel,
              }
            : s
        )
      );
      addLog({
        level: 'INFO',
        text: `[EngineManager] Installed ${data.filename || jarFilename} (${data.engine} ${
          data.version
        }) into ${activeServer.path}`,
      });
      await refreshFileIndex();
      showToast(
        'Server JAR installed',
        `${data.filename || jarFilename} written to ${activeServer.path} (${(
          (Number(data.bytes) || 0) /
          1048576
        ).toFixed(1)} MB).`,
        'success',
        'download_done'
      );
    } catch (err) {
      showToast(
        'JAR install failed',
        err instanceof Error ? err.message : 'Backend unreachable',
        'error',
        'error'
      );
    }
  };

  const handleKickPlayer = async (id: string) => {
    const target = players.find((p) => p.id === id);
    if (!target) return;
    try {
      const res = await fetch('/api/server-runtime/command', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          serverId: activeServer.id,
          serverName: activeServer.name,
          command: `kick ${target.username}`,
        }),
      });
      const data = await res.json();
      if (!res.ok || !data?.ok) {
        showToast('Kick failed', String(data?.error || 'Server is not accepting commands'), 'error', 'error');
        return;
      }
      setPlayers((prev) => prev.filter((p) => p.id !== id));
      showToast(
        `kick ${target.username} queued`,
        `Command delivered to ${activeServer.name}. Check the console for the result.`,
        'warning',
        'person_remove'
      );
    } catch (err) {
      showToast(
        'Kick failed',
        err instanceof Error ? err.message : 'Backend unreachable',
        'error',
        'error'
      );
    }
  };

  const prettyEngineLabel = useCallback((engine: string, version?: string): string => {
    const names: Record<string, string> = {
      paper: 'PaperMC',
      folia: 'Folia',
      velocity: 'Velocity',
      waterfall: 'Waterfall',
      purpur: 'Purpur',
      fabric: 'Fabric',
      vanilla: 'Vanilla',
      spigot: 'Spigot',
      forge: 'Forge',
      neoforge: 'NeoForge',
    };
    const key = String(engine || '').toLowerCase();
    const label = names[key] || (key ? key.charAt(0).toUpperCase() + key.slice(1) : 'PaperMC');
    return version ? `${label} ${version}` : label;
  }, []);

  // The server list is the real set of folders in the install root, not demo data.
  const syncServersFromDisk = useCallback(async (): Promise<ServerInstance[] | undefined> => {
    try {
      const res = await fetch('/api/servers');
      const data = await res.json();
      if (!res.ok || !data?.ok || !Array.isArray(data.servers)) return undefined;
      const list: ServerInstance[] = data.servers.map(
        (srv: Record<string, unknown>): ServerInstance => {
          const runtime = (srv.runtime || {}) as { state?: string; pid?: number | null };
          const state = String(runtime.state || 'stopped');
          const status: ServerInstance['status'] =
            state === 'online'
              ? 'running'
              : state === 'starting' || state === 'stopping'
              ? 'restarting'
              : 'stopped';
          return {
            id: String(srv.id || ''),
            name: String(srv.name || srv.id || 'Server'),
            engine:
              String(srv.engineLabel || '') ||
              prettyEngineLabel(String(srv.engine || 'paper'), String(srv.version || '')),
            javaVersion: 'Java 21',
            port: Number(srv.port) || 25565,
            pid: Number(runtime.pid) || 0,
            status,
            path: String(srv.displayPath || srv.diskPath || ''),
            build: '#Latest',
            tps: 0,
            tickMs: 0,
            uptime: status === 'running' ? 'Online' : 'Stopped (Ready to Start)',
            playersOnline: 0,
            maxPlayers: 40,
            cpuUsage: 0,
            cpuTemp: 0,
            ramUsedGb: 0,
            ramMaxGb: Number(srv.ramMaxGb) || 4,
          };
        }
      );
      setServers(list);
      setActiveServerId((prev) =>
        list.some((srv) => srv.id === prev) ? prev : list[0]?.id ?? prev
      );
      if (typeof data.installRoot === 'string' && data.installRoot) {
        setServerInstallRootDir(data.installRoot);
      }
      return list;
    } catch {
      // backend still starting — keep whatever we have
      return undefined;
    }
  }, [prettyEngineLabel]);

  useEffect(() => {
    if (!currentUser) return;
    void syncServersFromDisk();
    const interval = setInterval(() => void syncServersFromDisk(), 5000);
    return () => clearInterval(interval);
  }, [currentUser, syncServersFromDisk]);

  const handleServerPowerById = useCallback(
    async (serverId: string, action: 'start' | 'restart' | 'stop' | 'kill') => {
      const targetSrv = servers.find((s) => s.id === serverId);
      if (!targetSrv) return;

      setServers((prev) =>
        prev.map((s) =>
          s.id === serverId
            ? { ...s, status: action === 'stop' || action === 'kill' ? 'restarting' : s.status }
            : s
        )
      );

      try {
        const res = await fetch('/api/server-runtime/power', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            serverId: targetSrv.id,
            serverName: targetSrv.name,
            engine: targetSrv.engine,
            port: targetSrv.port,
            ramMaxGb: targetSrv.ramMaxGb,
            action,
          }),
        });
        const data = await res.json().catch(() => null);
        if (!res.ok || !data?.ok) {
          const message = data?.error || `Backend refused “${action}”`;
          showToast('Action Failed', message, 'error', 'error');
          void syncServersFromDisk();
          return;
        }
        showToast(
          action === 'start'
            ? `Starting ${targetSrv.name}`
            : `${targetSrv.name}: ${action} requested`,
          action === 'start'
            ? `Spawning the server JVM on port :${targetSrv.port}.`
            : 'Waiting for the process to reach a terminal state.',
          'info',
          action === 'start' ? 'play_arrow' : 'sync'
        );
        // Give the JVM a moment, then read the real state back from the backend.
        setTimeout(() => void syncServersFromDisk(), 2500);
      } catch (err) {
        showToast(
          'Action Failed',
          err instanceof Error ? err.message : 'Could not reach the local backend',
          'error',
          'error'
        );
        void syncServersFromDisk();
      }
    },
    [servers, showToast, syncServersFromDisk]
  );

  const handleBulkServerAction = (
    action: 'start_all' | 'restart_running' | 'stop_all' | 'snapshot_all'
  ) => {
    void (async () => {
      const targets =
        action === 'start_all'
          ? servers.filter((s) => s.status === 'stopped')
          : action === 'restart_running'
            ? servers.filter((s) => s.status === 'running')
            : [];
      const powerAction =
        action === 'start_all' ? 'start' : action === 'restart_running' ? 'restart' : 'stop';

      if (action === 'snapshot_all') {
        // One real archive per server, sequentially, through the job queue so a
        // server that is mid-restore or mid-install is reported instead of raced.
        let archived = 0;
        for (const srv of servers) {
          const outcome = await submitJob(
            '/api/backups/create',
            { serverId: srv.id, serverName: srv.name, title: 'fleet-checkpoint' },
          ).catch(() => null);
          if (outcome?.ok) archived += 1;
        }
        await loadSnapshots(activeServer);
        showToast(
          archived === servers.length ? 'Fleet backup finished' : 'Fleet backup partly finished',
          `Archived ${archived} of ${servers.length} server(s) to their backups/ folders.`,
          archived === servers.length ? 'success' : 'warning',
          'archive'
        );
        return;
      }

      let ok = 0;
      for (const srv of targets) {
        try {
          const res = await fetch('/api/server-runtime/power', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              serverId: srv.id,
              serverName: srv.name,
              engine: srv.engine,
              port: srv.port,
              ramMaxGb: srv.ramMaxGb,
              action: powerAction,
            }),
          });
          const data = await res.json();
          if (data?.ok) ok += 1;
          else addLog({ level: 'ERROR', text: `[Fleet] ${powerAction} failed for ${srv.name}: ${data?.error || 'unknown error'}` });
        } catch (err) {
          addLog({
            level: 'ERROR',
            text: `[Fleet] ${powerAction} failed for ${srv.name}: ${err instanceof Error ? err.message : 'backend unreachable'}`,
          });
        }
      }
      await syncServersFromDisk();
      showToast(
        `${powerAction === 'start' ? 'Fleet start' : powerAction === 'restart' ? 'Fleet restart' : 'Fleet stop'}`,
        `${ok}/${targets.length} server(s) accepted the ${powerAction} request.`,
        ok === targets.length ? 'success' : 'warning',
        powerAction === 'start' ? 'play_arrow' : 'sync'
      );
    })();
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
    void (async () => {
      const running = servers.filter((s) => s.status !== 'stopped');
      let killed = 0;
      for (const srv of running) {
        try {
          const res = await fetch('/api/server-runtime/power', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ serverId: srv.id, serverName: srv.name, action: 'kill' }),
          });
          const data = await res.json();
          if (data?.ok) killed += 1;
        } catch {
          // reported below via the sync + toast counts
        }
      }
      await syncServersFromDisk();
      addLog({
        level: 'ERROR',
        text: `[Fleet] Force-killed ${killed}/${running.length} running server process(es).`,
        highlightBox: 'error',
      });
      showToast(
        'Servers force-killed',
        `${killed}/${running.length} running process(es) terminated.`,
        killed === running.length ? 'success' : 'warning',
        'dangerous'
      );
    })();
  };

  // Deleting a server is irreversible for its world data, so it always goes
  // through an explicit confirmation dialog before the backend removes it.
  const handleDeleteServerInstance = (serverId: string) => {
    const target = servers.find((s) => s.id === serverId);
    if (!target) return;
    setDeleteTarget(target);
    setDeleteServerFiles(true);
  };

  const confirmDeleteServer = async () => {
    if (!deleteTarget) return;
    setDeletingServer(true);
    try {
      const res = await fetch('/api/server-runtime/server', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          serverId: deleteTarget.id,
          serverName: deleteTarget.name,
          deleteFiles: deleteServerFiles,
        }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.ok) {
        showToast(
          'Could not delete server',
          String(data?.error || `Backend refused the delete (HTTP ${res.status})`),
          'error',
          'error'
        );
        return;
      }

      const remaining = servers.filter((s) => s.id !== deleteTarget.id);
      setServers(remaining);
      if (activeServerId === deleteTarget.id) {
        setActiveServerId(remaining[0]?.id ?? EMPTY_SERVER_PLACEHOLDER.id);
      }
      addLog({
        level: 'WARN',
        text: `[Fleet] Deleted server "${deleteTarget.name}"${
          deleteServerFiles ? ' and removed its folder from disk' : ' (folder kept on disk)'
        }.`,
        highlightBox: 'warn',
      });
      showToast(
        `Deleted ${deleteTarget.name}`,
        deleteServerFiles
          ? `Folder ${deleteTarget.path} was removed from this PC.`
          : 'The server was unregistered; its folder is still on disk.',
        'success',
        'delete'
      );
      setDeleteTarget(null);
      void syncServersFromDisk();
    } catch (err) {
      showToast(
        'Could not delete server',
        err instanceof Error ? err.message : 'Backend unreachable',
        'error',
        'error'
      );
    } finally {
      setDeletingServer(false);
    }
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
    setDiscordGatePurpose('limit');
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
    setPanelMode('simple');
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
      await fetch('/api/auth/logout', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        credentials: 'include',
        body: JSON.stringify({ logoutCurrentOnly: true }),
      });
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
      {/* Custom titlebar is hidden on login pages (unauthenticated gate) —
          the frameless Electron window then relies on Alt+F4/taskbar there. */}
      {currentUser && hasEnteredFullPanel && panelMode === 'advanced' && (
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
        onMinimize={() => setIsMinimized(true)}
        isMaximized={isMaximized}
        onToggleMaximize={() => setIsMaximized(!isMaximized)}
        isSimplePanelMode={!hasEnteredFullPanel}
        onToggleSimplePanel={() => setHasEnteredFullPanel((prev) => !prev)}
        onOpenDiscordBotGate={() => handleOpenDiscordBotGate()}
        onRequestClose={() => setExitConfirmOpen(true)}
      />
      )}

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
          onEnterFullPanel={(targetSection = 'overview', selectedServer, mode = 'advanced') =>
            handleEnterPanel(targetSection, selectedServer, mode)
          }
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
      ) : panelMode === 'simple' ? (
        /* Step 2 After Login: Clean per-server simple panel (no desktop title bar) */
        <SimpleServerPanel
          server={activeServer}
          advancedAllowed={advancedPanelAllowed}
          onRequestAdvancedAccess={() => handleEnterPanel('overview', undefined, 'advanced')}
          onBackToServerList={() => setHasEnteredFullPanel(false)}
          onOpenAdvancedPanel={() => handleEnterPanel('overview', undefined, 'advanced')}
          onServerUpdated={(patch) => {
            setServers((prev) =>
              prev.map((srv) => (srv.id === activeServer.id ? { ...srv, ...patch } : srv))
            );
          }}
          onShowToast={showToast}
        />
      ) : (
        /* Main Desktop Application Shell */
        <div className="advanced-shell flex flex-1 overflow-hidden">
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

          {/* Workspace scroll shell: keeps every view inside the window chrome */}
          <div
            ref={workspaceScrollRef}
            className="flex-1 min-w-0 flex flex-col overflow-y-auto overflow-x-hidden"
          >
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
            selectedFilePath={selectedFileId}
            onShowToast={showToast}
            onFilesChanged={() => void refreshFileIndex()}
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
          <NetworkPortsView server={activeServer} onShowToast={showToast} />
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

        {activeSection === 'account' && (
          <>
            <header className="min-h-[54px] px-6 py-2 bg-surface border-b border-white/[0.06] flex flex-wrap items-center justify-between gap-x-4 gap-y-2 shrink-0">
              <div className="flex items-center gap-2.5 min-w-0">
                <span className="material-symbols-outlined text-[18px] text-primary">security</span>
                <h1 className="text-[14.5px] font-semibold tracking-tight text-on-surface whitespace-nowrap">
                  Sessions
                </h1>
                <span className="w-px h-4 bg-white/10 shrink-0" />
                <p className="text-[11.5px] text-outline font-mono truncate">
                  Active sessions · provider connections · account security
                </p>
              </div>
              {currentUser && (
                <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md border border-white/10 bg-white/[0.03] font-mono text-[10.5px] text-[#c9d2e2] shrink-0">
                  <span className="material-symbols-outlined text-[13px] text-secondary">
                    account_circle
                  </span>
                  {currentUser.username}
                </span>
              )}
            </header>

            <div className="p-6 pt-5 space-y-4 max-w-3xl w-full">
              <SessionManagementPanel
                currentUser={currentUser}
                onShowToast={showToast}
                onSignOut={handleSignOut}
              />
              <ProviderConnectionsPanel
                currentUser={currentUser}
                onShowToast={showToast}
                onSignOut={handleSignOut}
              />
              <AccountSecurityPanel
                currentUser={currentUser}
                onShowToast={showToast}
                onSignOut={handleSignOut}
              />
            </div>
          </>
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

      {/* Exit Confirmation — hide to tray (keeps running) or quit the desktop app */}
      <DesktopCloseModal
        isOpen={exitConfirmOpen}
        onClose={() => setExitConfirmOpen(false)}
        serverRunning={servers.some((s) => s.status === 'running')}
        serverName={activeServer?.name}
      />

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
          access={panelAccess}
          accessLoading={panelAccessLoading}
          accessError={panelAccessError}
          purpose={discordGatePurpose}
          onRefreshAccess={refreshPanelAccess}
          onUserUpdated={handleUpdateUserProfile}
          onEnforceTwoServerReset={handleEnforceTwoServerReset}
          onVerificationSuccessProceed={() => {
            setDiscordBotGateOpen(false);
            setDiscordBotAttemptedServerName(undefined);
          }}
          onShowToast={showToast}
        />
      )}

      {/* Delete Server Confirmation */}
      {deleteTarget && (
        <div className="fixed inset-0 z-[70] bg-black/80 backdrop-blur-md flex items-center justify-center p-4">
          <div className="w-full max-w-md rounded-xl bg-surface border border-error/35 overflow-hidden">
            <div className="px-5 py-4 border-b border-white/[0.08] bg-surface-container flex items-start gap-3">
              <div className="size-9 rounded-lg bg-error/15 border border-error/35 flex items-center justify-center text-error shrink-0">
                <span className="material-symbols-outlined text-[20px]">delete_forever</span>
              </div>
              <div className="min-w-0">
                <h3 className="text-sm font-bold text-white">Delete “{deleteTarget.name}”?</h3>
                <p className="text-[11px] text-outline font-mono truncate">{deleteTarget.path}</p>
              </div>
            </div>

            <div className="p-5 space-y-3">
              <p className="text-xs text-outline leading-relaxed">
                The server is stopped and removed from the panel. This cannot be undone.
                {deleteServerFiles
                  ? ' Its world, plugins, mods, logs and jar will be deleted from this PC.'
                  : ' The folder stays on disk so you can re-register it later.'}
              </p>

              <label className="flex items-start gap-2.5 cursor-pointer select-none rounded-lg border border-white/[0.08] bg-surface-lowest px-3 py-2.5">
                <input
                  type="checkbox"
                  checked={deleteServerFiles}
                  onChange={(e) => setDeleteServerFiles(e.target.checked)}
                  disabled={deletingServer}
                  className="mt-0.5 size-3.5 accent-[color:var(--color-error,#ff6b6b)] cursor-pointer"
                />
                <span className="text-xs text-on-surface">
                  Also delete the server folder and all of its files
                </span>
              </label>
            </div>

            <div className="px-5 py-3.5 bg-surface-container border-t border-white/[0.08] flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={() => setDeleteTarget(null)}
                disabled={deletingServer}
                className="px-4 h-9 rounded-lg bg-white/5 hover:bg-white/10 text-xs font-medium text-outline hover:text-white cursor-pointer disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void confirmDeleteServer()}
                disabled={deletingServer}
                className="px-4 h-9 rounded-lg bg-error hover:opacity-95 text-white text-xs font-bold flex items-center gap-1.5 cursor-pointer disabled:opacity-50"
              >
                <span className="material-symbols-outlined text-[16px]">
                  {deletingServer ? 'progress_activity' : 'delete'}
                </span>
                {deletingServer ? 'Deleting…' : 'Delete server'}
              </button>
            </div>
          </div>
        </div>
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
