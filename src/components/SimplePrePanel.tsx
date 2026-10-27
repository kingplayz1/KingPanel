import React, { useEffect, useState } from 'react';
import { AuthUser, NavSection, PaperMCServiceReport, ServerInstance } from '../types';
import { DEFAULT_PROFILE_ICON_URL, resolveUserAvatarUrl } from '../utils/profileIcons';
import { ServerInstallModal } from './ServerInstallModal';
import { SimpleWindowControls } from './SimpleWindowControls';
import { JobProgressBar } from './JobProgressBar';
import { cancelJob, submitJob, type OperationJob } from '../lib/jobs';

interface SimplePrePanelProps {
  currentUser: AuthUser;
  servers: ServerInstance[];
  activeServer: ServerInstance;
  serverInstallRootDir: string;
  hostTotalRamGb: number;
  globalRamCapGb: number;
  paperMcReport?: PaperMCServiceReport | null;
  onRunPaperMcCheckNow?: () => void;
  onUpgradeServerEngine?: (serverId: string | 'ALL') => void;
  onUpdateServerInstallFolder?: (newRootDir: string) => void;
  onEnterFullPanel: (
    targetSection?: NavSection,
    selectedServer?: ServerInstance,
    mode?: 'simple' | 'advanced',
  ) => void;
  onSelectServer: (server: ServerInstance) => void;
  onServerPowerAction: (serverId: string, action: 'start' | 'restart' | 'stop' | 'kill') => void;
  onCreateServerInstance: (server: ServerInstance) => void;
  onDeleteServerInstance: (serverId: string) => void;
  onOpenDiscordBotGate: (attemptedServerName?: string) => void;
  onLeaveDiscordServer: () => void;
  onUserUpdated: (updatedUser: AuthUser) => void;
  onOpenAuthModal: (mode: 'signin' | 'signup') => void;
  onSignOut: () => void;
  onShowToast: (
    title: string,
    body?: string,
    type?: 'success' | 'info' | 'warning' | 'error',
    icon?: string,
  ) => void;
}

export const SimplePrePanel: React.FC<SimplePrePanelProps> = ({
  currentUser,
  servers,
  activeServer,
  serverInstallRootDir,
  paperMcReport,
  onUpgradeServerEngine,
  onUpdateServerInstallFolder,
  onEnterFullPanel,
  onSelectServer,
  onServerPowerAction,
  onCreateServerInstance,
  onDeleteServerInstance,
  onOpenDiscordBotGate,
  onLeaveDiscordServer,
  onUserUpdated,
  onSignOut,
  onShowToast,
}) => {
  // Create Server Modal State — the dialog itself owns the install form
  const [createModalOpen, setCreateModalOpen] = useState(false);

  // Container lifecycle per server folder (installer / installing / ready /
  // running / error) so the list shows which servers still need setup.
  const [containerByServer, setContainerByServer] = useState<
    Record<string, { phase: string; hasJar: boolean; blockers: string[] }>
  >({});
  const [installingFor, setInstallingFor] = useState<string | null>(null);
  const [setupJob, setSetupJob] = useState<OperationJob | null>(null);

  const serverIdKey = servers.map((srv) => srv.id).join('|');

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      const next: Record<string, { phase: string; hasJar: boolean; blockers: string[] }> = {};
      await Promise.all(
        servers.map(async (srv) => {
          try {
            const res = await fetch(
              `/api/server-runtime/container-state?serverId=${encodeURIComponent(
                srv.id,
              )}&serverName=${encodeURIComponent(srv.name)}`,
            );
            const data = await res.json();
            if (data?.ok) {
              next[srv.id] = {
                phase: String(data.phase || 'installing'),
                hasJar: Boolean(data.hasJar),
                blockers: Array.isArray(data.blockers) ? data.blockers : [],
              };
            }
          } catch {
            // backend restarting — keep the last known phase
          }
        }),
      );
      if (!cancelled) setContainerByServer(next);
    };
    void load();
    const timer = setInterval(() => void load(), 15000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverIdKey]);

  const handleFinishSetup = async (srv: ServerInstance) => {
    setInstallingFor(srv.id);
    setSetupJob(null);
    try {
      const outcome = await submitJob<Record<string, any>>(
        '/api/server-runtime/install-jar',
        { serverId: srv.id, serverName: srv.name, engine: srv.engine },
        { onProgress: setSetupJob },
      );
      const data = (outcome.result || {}) as Record<string, any>;
      if (!outcome.ok) {
        onShowToast(
          'Setup failed',
          outcome.error || 'Could not install server.jar',
          'error',
          'error',
        );
        return;
      }
      onShowToast(
        'Container ready',
        `${data.filename || 'server.jar'} installed (${Math.round((Number(data.bytes) || 0) / 1024 / 1024)} MB) for ${srv.name}`,
        'success',
        'deployed_code',
      );
      setContainerByServer((prev) => ({
        ...prev,
        [srv.id]: { phase: 'ready', hasJar: true, blockers: [] },
      }));
    } catch (err) {
      onShowToast(
        'Setup failed',
        err instanceof Error ? err.message : 'Backend unreachable',
        'error',
        'error',
      );
    } finally {
      setInstallingFor(null);
    }
  };

  const isSuperAdmin =
    currentUser.username.toLowerCase() === 'kingplayz' ||
    currentUser.role === 'Super Admin' ||
    Boolean(currentUser.isSuperAdmin);
  const isVerified = Boolean(currentUser.discordVerified) || isSuperAdmin;
  const maxServerLimit = isSuperAdmin ? 999 : isVerified ? currentUser.maxServerLimit || 10 : 2;
  const isAtServerLimit = !isSuperAdmin && servers.length >= maxServerLimit;

  const latestPaperRelease = paperMcReport?.latestPaperRelease || '1.21.4';

  // The modal performs the real install (jar download + EULA consent); the list
  // only needs to receive the finished instance.
  const handleServerInstalled = (installed: ServerInstance) => {
    onCreateServerInstance(installed);
  };

  const handleOpenCreateServerModal = () => {
    if (servers.length >= maxServerLimit) {
      onOpenDiscordBotGate();
      onShowToast(
        '2-Server Limit Reached — Verify Discord',
        'Standard users can set up 1 or 2 servers only. Join our Discord server and verify with our bot to unlock up to 10 servers!',
        'warning',
        'forum',
      );
      return;
    }
    setCreateModalOpen(true);
  };

  const runningCount = servers.filter((s) => s.status === 'running').length;
  const stoppedCount = servers.length - runningCount;

  return (
    <div className="min-h-screen w-full bg-surface-dim flex flex-col overflow-y-auto">
      {/* Simple Top Bar */}
      <header
        className="w-full bg-surface border-b border-white/[0.08] px-6 py-4"
        style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
      >
        <div className="max-w-5xl mx-auto flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          {/* Brand + User Info */}
          <div className="flex items-center gap-3.5">
            <div className="w-10 h-10 rounded-xl bg-primary/15 border border-primary/35 flex items-center justify-center text-primary shrink-0">
              <span className="material-symbols-outlined text-[22px]">dns</span>
            </div>
            <div>
              <div className="flex items-center gap-2.5">
                <h1 className="text-base sm:text-lg font-bold text-white tracking-tight">
                  Server List Panel
                </h1>
                <span className="text-xs font-mono text-outline">
                  · {servers.length} / {isSuperAdmin ? '∞' : maxServerLimit} Servers
                </span>
              </div>
              <div className="flex items-center gap-2 text-xs text-outline mt-0.5">
                <img
                  src={resolveUserAvatarUrl(currentUser.avatarUrl)}
                  onError={(e) => {
                    (e.currentTarget as HTMLImageElement).src = DEFAULT_PROFILE_ICON_URL;
                  }}
                  alt={currentUser.username}
                  className="w-4 h-4 rounded-full object-cover"
                />
                <span className="text-white font-medium">{currentUser.displayName}</span>
                <span className="font-mono text-outline">(@{currentUser.username})</span>
              </div>
            </div>
          </div>

          {/* Right Actions */}
          <div
            className="flex flex-wrap items-center gap-2.5"
            style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
          >
            <button
              type="button"
              onClick={handleOpenCreateServerModal}
              className="px-4 py-2 rounded-xl bg-primary hover:opacity-95 text-on-primary-container text-xs font-bold flex items-center gap-1.5 cursor-pointer transition-all"
            >
              <span className="material-symbols-outlined text-[17px]">add</span>
              Create Server
            </button>

            <button
              type="button"
              onClick={() => onOpenDiscordBotGate()}
              className={`px-3.5 py-2 rounded-xl text-xs font-semibold flex items-center gap-1.5 cursor-pointer transition-all ${
                isVerified
                  ? 'bg-secondary/15 hover:bg-secondary/25 text-secondary border border-secondary/35'
                  : 'bg-[#5865F2]/20 hover:bg-[#5865F2]/30 text-white border border-[#5865F2]/40'
              }`}
            >
              <span className="material-symbols-outlined text-[16px]">
                {isVerified ? 'verified' : 'forum'}
              </span>
              {isVerified ? 'Discord Verified' : 'Verify Discord'}
            </button>

            {isVerified && !isSuperAdmin && (
              <button
                type="button"
                onClick={onLeaveDiscordServer}
                className="px-3 py-2 rounded-xl bg-error/15 hover:bg-error/25 border border-error/30 text-error text-xs font-semibold cursor-pointer transition-all"
                title="Leave Discord Server and reset limit to 2"
              >
                Leave Discord
              </button>
            )}

            <button
              type="button"
              onClick={onSignOut}
              className="px-3.5 py-2 rounded-xl bg-white/5 hover:bg-error/20 border border-white/[0.08] hover:border-error/35 text-xs font-medium text-outline hover:text-error flex items-center gap-1.5 cursor-pointer transition-all"
            >
              <span className="material-symbols-outlined text-[16px]">logout</span>
              Logout
            </button>

            <SimpleWindowControls className="ml-1 pl-2 border-l border-white/[0.08]" />
          </div>
        </div>
      </header>

      {/* Main Content: Created Server List Display UI Only */}
      <main className="flex-1 p-6 sm:p-10">
        <div className="max-w-5xl mx-auto space-y-5">
          {/* Server List Section Header */}
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 pb-2 border-b border-white/[0.08]">
            <div>
              <h2 className="text-lg font-bold text-white">Created Server List</h2>
              <p className="text-xs text-outline">
                Select a server to start, stop, or open its control panel
              </p>
            </div>
            <div className="flex items-center gap-3 text-xs font-mono text-outline">
              <span>Total: {servers.length}</span>
              <span>·</span>
              <span className="text-secondary">Running: {runningCount}</span>
              <span>·</span>
              <span>Stopped: {stoppedCount}</span>
            </div>
          </div>

          {/* Server List or Empty State */}
          {servers.length === 0 ? (
            <div className="rounded-xl p-10 bg-surface-container border border-white/[0.08] text-center space-y-4">
              <div className="w-14 h-14 rounded-xl bg-primary/15 border border-primary/30 flex items-center justify-center text-primary mx-auto">
                <span className="material-symbols-outlined text-[28px]">dns</span>
              </div>
              <div className="space-y-1.5 max-w-md mx-auto">
                <h3 className="text-base font-bold text-white">No Created Servers Yet</h3>
                <p className="text-xs text-outline leading-relaxed">
                  Your server list is empty. Click the button below to create your first Minecraft
                  server. Newly created servers remain stopped until you start them.
                </p>
              </div>
              <div className="pt-1">
                <button
                  type="button"
                  onClick={handleOpenCreateServerModal}
                  className="px-5 py-2.5 rounded-xl bg-primary hover:opacity-95 text-on-primary-container text-xs font-bold inline-flex items-center gap-2 cursor-pointer transition-all"
                >
                  <span className="material-symbols-outlined text-[18px]">add_circle</span>
                  Create Your First Server
                </button>
              </div>
            </div>
          ) : (
            <div className="space-y-3">
              {servers.map((srv) => {
                const isRunning = srv.status === 'running';
                const isSelected = srv.id === activeServer.id;
                const isSrvOutdated =
                  srv.isOutdated !== undefined
                    ? srv.isOutdated
                    : !srv.engine.includes(latestPaperRelease);

                return (
                  <div
                    key={srv.id}
                    onClick={() => onSelectServer(srv)}
                    className={`rounded-xl p-5 border transition-all cursor-pointer ${
                      isSelected
                        ? 'bg-surface-container-high border-primary/40 '
                        : 'bg-surface-container border-white/[0.08] hover:border-white/20'
                    }`}
                  >
                    <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
                      {/* Left: Server Identity & Metadata */}
                      <div className="flex items-start gap-3.5 min-w-0">
                        <div
                          className={`w-11 h-11 rounded-xl border flex items-center justify-center shrink-0 ${
                            isRunning
                              ? 'bg-secondary/15 border-secondary/35 text-secondary'
                              : 'bg-surface-lowest border-white/[0.08] text-outline'
                          }`}
                        >
                          <span className="material-symbols-outlined text-[22px]">dns</span>
                        </div>
                        <div className="space-y-1 min-w-0">
                          <div className="flex flex-wrap items-center gap-2">
                            <span
                              className={`w-2.5 h-2.5 rounded-full ${
                                isRunning ? 'bg-secondary animate-pulse' : 'bg-error'
                              }`}
                            />
                            <span className="text-base font-bold text-white truncate">
                              {srv.name}
                            </span>
                            <span className="text-xs font-mono text-outline">· {srv.engine}</span>
                            <span className="text-xs font-mono text-outline">
                              · {isRunning ? 'RUNNING' : 'STOPPED'}
                            </span>
                            {containerByServer[srv.id] && !isRunning && (
                              <span
                                className={`text-[9.5px] font-bold px-1.5 py-0.5 rounded border font-mono ${
                                  containerByServer[srv.id].phase === 'ready'
                                    ? 'text-primary border-primary/40 bg-primary/10'
                                    : containerByServer[srv.id].phase === 'error'
                                      ? 'text-error border-error/40 bg-error/10'
                                      : 'text-amber-300 border-amber-400/40 bg-amber-400/10'
                                }`}
                                title={
                                  containerByServer[srv.id].blockers.join(' · ') ||
                                  'Container ready'
                                }
                              >
                                {containerByServer[srv.id].phase === 'ready'
                                  ? 'READY'
                                  : containerByServer[srv.id].phase === 'error'
                                    ? 'ERROR'
                                    : 'NEEDS SETUP'}
                              </span>
                            )}
                            {isSrvOutdated && (
                              <span className="text-xs font-mono text-amber-300">
                                · Outdated (Latest: {srv.latestVersion || latestPaperRelease})
                              </span>
                            )}
                          </div>

                          <div className="text-xs font-mono text-outline flex flex-wrap items-center gap-2">
                            <span>Address: localhost:{srv.port}</span>
                            <span>·</span>
                            <span>
                              RAM: {srv.ramUsedGb} / {srv.ramMaxGb} GB
                            </span>
                            <span>·</span>
                            <span className="truncate">Path: {srv.path}</span>
                          </div>
                        </div>
                      </div>

                      {/* Right: Direct Server Controls */}
                      <div
                        className="flex flex-wrap items-center gap-2 shrink-0"
                        onClick={(e) => e.stopPropagation()}
                      >
                        {isSrvOutdated && onUpgradeServerEngine && (
                          <button
                            type="button"
                            onClick={() => onUpgradeServerEngine(srv.id)}
                            className="px-3 py-2 rounded-xl bg-amber-400 hover:bg-amber-300 text-black text-xs font-bold flex items-center gap-1 cursor-pointer"
                          >
                            <span className="material-symbols-outlined text-[15px]">upgrade</span>
                            Update
                          </button>
                        )}

                        {!isRunning ? (
                          <button
                            type="button"
                            onClick={() => onServerPowerAction(srv.id, 'start')}
                            className="px-3.5 py-2 rounded-xl bg-secondary/20 hover:bg-secondary/30 text-secondary border border-secondary/35 text-xs font-bold flex items-center gap-1.5 cursor-pointer"
                          >
                            <span className="material-symbols-outlined text-[16px]">
                              play_arrow
                            </span>
                            Start
                          </button>
                        ) : (
                          <>
                            <button
                              type="button"
                              onClick={() => onServerPowerAction(srv.id, 'restart')}
                              className="px-3 py-2 rounded-xl bg-amber-400/15 hover:bg-amber-400/25 text-amber-300 border border-amber-400/30 text-xs font-semibold flex items-center gap-1 cursor-pointer"
                            >
                              <span className="material-symbols-outlined text-[15px]">
                                restart_alt
                              </span>
                              Restart
                            </button>
                            <button
                              type="button"
                              onClick={() => onServerPowerAction(srv.id, 'stop')}
                              className="px-3 py-2 rounded-xl bg-white/10 hover:bg-white/15 text-white text-xs font-semibold flex items-center gap-1 cursor-pointer"
                            >
                              <span className="material-symbols-outlined text-[15px]">stop</span>
                              Stop
                            </button>
                          </>
                        )}

                        {!isRunning &&
                          containerByServer[srv.id] &&
                          !containerByServer[srv.id].hasJar && (
                            <button
                              type="button"
                              onClick={() => void handleFinishSetup(srv)}
                              disabled={installingFor === srv.id}
                              className="px-3 py-2 rounded-xl bg-primary/20 hover:bg-primary/30 disabled:opacity-50 text-primary border border-primary/35 text-xs font-bold flex items-center gap-1.5 cursor-pointer"
                              title="Download server.jar and finish the container setup"
                            >
                              <span className="material-symbols-outlined text-[15px]">
                                download
                              </span>
                              {installingFor === srv.id ? 'Installing…' : 'Finish setup'}
                            </button>
                          )}

                        {installingFor === srv.id && setupJob && (
                          <div className="w-full mt-2">
                            <JobProgressBar
                              job={setupJob}
                              compact
                              onCancel={() => {
                                void cancelJob(setupJob.id);
                              }}
                            />
                          </div>
                        )}

                        <button
                          type="button"
                          onClick={() => onEnterFullPanel('console', srv, 'simple')}
                          className="px-3.5 py-2 rounded-xl bg-primary hover:opacity-95 text-on-primary-container text-xs font-bold flex items-center gap-1.5 cursor-pointer"
                        >
                          <span className="material-symbols-outlined text-[15px]">
                            space_dashboard
                          </span>
                          <span>Simple Panel</span>
                        </button>

                        <button
                          type="button"
                          onClick={() => onEnterFullPanel('console', srv, 'advanced')}
                          className="px-3 py-2 rounded-xl bg-white/10 hover:bg-white/15 border border-white/15 text-white text-xs font-semibold flex items-center gap-1.5 cursor-pointer"
                        >
                          <span className="material-symbols-outlined text-[15px] text-primary">
                            terminal
                          </span>
                          <span>Advanced Panel</span>
                        </button>

                        <button
                          type="button"
                          onClick={() => onDeleteServerInstance(srv.id)}
                          className="p-2 rounded-xl bg-error/10 hover:bg-error/20 text-error cursor-pointer"
                          title="Delete Server"
                        >
                          <span className="material-symbols-outlined text-[16px]">delete</span>
                        </button>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {/* Subtle Quota Footer Note */}
          {isAtServerLimit && !isVerified && (
            <div className="p-4 rounded-xl bg-[#5865F2]/10 border border-[#5865F2]/35 flex flex-col sm:flex-row sm:items-center justify-between gap-3 text-xs">
              <span className="text-outline">
                You have reached the standard <strong className="text-white">2-server limit</strong>
                . Connect and verify with our Discord Bot to create up to 10 servers.
              </span>
              <button
                type="button"
                onClick={() => onOpenDiscordBotGate()}
                className="px-3.5 py-2 rounded-lg bg-[#5865F2] hover:bg-[#4752C4] text-white font-bold shrink-0 cursor-pointer"
              >
                Verify Discord
              </button>
            </div>
          )}
        </div>
      </main>

      {/* Enhanced install dialog: live engine → version → build, EULA, PC folder picker */}
      <ServerInstallModal
        isOpen={createModalOpen}
        defaultRoot={serverInstallRootDir}
        serverCount={servers.length}
        maxLimit={maxServerLimit}
        isSuperAdmin={isSuperAdmin}
        discordVerified={isVerified}
        username={currentUser.username}
        onClose={() => setCreateModalOpen(false)}
        onInstalled={handleServerInstalled}
        onLimitReached={(attemptedName) => {
          setCreateModalOpen(false);
          onOpenDiscordBotGate(attemptedName);
          onShowToast(
            '2-Server Limit Reached — Verify Discord',
            `Could not install ${attemptedName || 'the server'}. Standard users can set up 1 or 2 servers only.`,
            'warning',
            'forum',
          );
        }}
        onShowToast={onShowToast}
      />

    </div>
  );
};
