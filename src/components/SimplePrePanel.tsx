import React, { useState } from 'react';
import { AuthUser, NavSection, PaperMCServiceReport, ServerInstance } from '../types';
import { DEFAULT_PROFILE_ICON_URL, resolveUserAvatarUrl } from '../utils/profileIcons';

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
  onEnterFullPanel: (targetSection?: NavSection, selectedServer?: ServerInstance) => void;
  onSelectServer: (server: ServerInstance) => void;
  onServerPowerAction: (
    serverId: string,
    action: 'start' | 'restart' | 'stop' | 'kill'
  ) => void;
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
    icon?: string
  ) => void;
}

export const SimplePrePanel: React.FC<SimplePrePanelProps> = ({
  currentUser,
  servers,
  activeServer,
  serverInstallRootDir,
  hostTotalRamGb,
  globalRamCapGb,
  paperMcReport,
  onRunPaperMcCheckNow,
  onUpgradeServerEngine,
  onEnterFullPanel,
  onSelectServer,
  onServerPowerAction,
  onCreateServerInstance,
  onDeleteServerInstance,
  onOpenDiscordBotGate,
  onLeaveDiscordServer,
  onUserUpdated,
  onOpenAuthModal,
  onSignOut,
  onShowToast,
}) => {
  const [newServerName, setNewServerName] = useState('');
  const [newServerEngine, setNewServerEngine] = useState('PaperMC 1.21.4');
  const [newServerPort, setNewServerPort] = useState<number>(() => {
    const highest = servers.reduce((max, s) => Math.max(max, s.port), 25565);
    return highest + 1;
  });
  const [newServerRamGb, setNewServerRamGb] = useState<number>(4);
  const [isDeploying, setIsDeploying] = useState(false);

  // Popup state for the "Verify Discord Bot" button giving the option to Join Discord
  const [verifyBotPopupOpen, setVerifyBotPopupOpen] = useState(false);
  const [discordInviteUrl, setDiscordInviteUrl] = useState(
    currentUser.discordInviteUrl || 'https://discord.gg/iskingpanel'
  );
  const [discordUsernameInput, setDiscordUsernameInput] = useState(
    currentUser.discordUsername || `${currentUser.username}#0001`
  );
  const [hasClickedJoinDiscord, setHasClickedJoinDiscord] = useState(
    Boolean(currentUser.discordVerified)
  );
  const [isVerifyingInPopup, setIsVerifyingInPopup] = useState(false);
  const [showQuickSetupGuide, setShowQuickSetupGuide] = useState(true);

  const isSuperAdmin =
    currentUser.username.toLowerCase() === 'kingplayz' ||
    currentUser.role === 'Super Admin' ||
    Boolean(currentUser.isSuperAdmin);
  const isVerified = Boolean(currentUser.discordVerified) || isSuperAdmin;
  const maxServerLimit = isSuperAdmin
    ? 999
    : isVerified
    ? currentUser.maxServerLimit || 10
    : 2;
  const isAtServerLimit = !isSuperAdmin && servers.length >= maxServerLimit;

  const latestPaperRelease = paperMcReport?.latestPaperRelease || '1.21.4';
  const latestPaperBuild = paperMcReport?.latestPaperBuild || 'Build #222';
  const outdatedServers = servers.filter((s) => {
    if (s.isOutdated !== undefined) return s.isOutdated;
    return !s.engine.includes(latestPaperRelease);
  });

  const cleanRoot = serverInstallRootDir.replace(/[\\/]+$/, '');
  const sep = cleanRoot.includes('\\') ? '\\' : '/';
  const previewSlug =
    (newServerName.trim() || `Server_${servers.length + 1}`)
      .replace(/[^a-zA-Z0-9_-]/g, '_')
      .replace(/_+/g, '_') || 'Server_Node';
  const previewPath = `${cleanRoot}${sep}${previewSlug}`;

  const handleQuickCreateServer = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmedName = newServerName.trim() || `Minecraft Server #${servers.length + 1}`;

    // Enforce 1 or 2 server limit for standard logged-in users
    if (servers.length >= maxServerLimit) {
      setVerifyBotPopupOpen(true);
      onShowToast(
        '2-Server Limit Reached — Verify Discord Bot',
        'Standard users can set up 1 or 2 servers only. Join our Discord server and verify with our bot to unlock up to 10 servers!',
        'warning',
        'forum'
      );
      return;
    }

    setIsDeploying(true);
    const parts = newServerEngine.split(' ');
    const engineType = parts[0] || 'PaperMC';
    const mcVersion = parts[1] || '1.21.4';

    try {
      const res = await fetch('/api/panel/install-server-instance', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          serverName: trimmedName,
          engine: engineType,
          version: mcVersion,
          port: newServerPort,
          ramMaxGb: newServerRamGb,
          installRootDir: serverInstallRootDir,
          currentServerCount: servers.length,
          username: currentUser.username,
        }),
      });
      const data = await res.json();

      if (res.status === 403 || data?.requiresDiscordVerification) {
        setVerifyBotPopupOpen(true);
        setIsDeploying(false);
        return;
      }

      const finalPath = data?.serverFolder || previewPath;
      const newSrv: ServerInstance = {
        id: `srv-${Date.now().toString(36)}`,
        name: trimmedName,
        engine: newServerEngine,
        javaVersion: 'Java 21',
        port: Number(newServerPort) || 25567,
        pid: Math.floor(14000 + Math.random() * 9000),
        status: 'running',
        path: finalPath,
        tps: 20.0,
        tickMs: 2.1,
        uptime: '0h 01m',
        playersOnline: 0,
        maxPlayers: 40,
        cpuUsage: 14,
        cpuTemp: 44.0,
        ramUsedGb: Number((newServerRamGb * 0.35).toFixed(1)),
        ramMaxGb: newServerRamGb,
        build: '#Latest',
      };

      onCreateServerInstance(newSrv);
      setNewServerName('');
      setNewServerPort((prev) => prev + 1);
    } catch {
      const fallbackSrv: ServerInstance = {
        id: `srv-${Date.now().toString(36)}`,
        name: trimmedName,
        engine: newServerEngine,
        javaVersion: 'Java 21',
        port: Number(newServerPort) || 25567,
        pid: Math.floor(14000 + Math.random() * 9000),
        status: 'running',
        path: previewPath,
        tps: 20.0,
        tickMs: 2.1,
        uptime: '0h 01m',
        playersOnline: 0,
        maxPlayers: 40,
        cpuUsage: 14,
        cpuTemp: 44.0,
        ramUsedGb: Number((newServerRamGb * 0.35).toFixed(1)),
        ramMaxGb: newServerRamGb,
        build: '#Latest',
      };
      onCreateServerInstance(fallbackSrv);
      setNewServerName('');
      setNewServerPort((prev) => prev + 1);
    } finally {
      setIsDeploying(false);
    }
  };

  const handlePopupVerifyDiscordBot = async () => {
    setIsVerifyingInPopup(true);
    try {
      const res = await fetch('/api/auth/discord/verify-bot', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: currentUser.username,
          discordUsername: discordUsernameInput.trim() || `${currentUser.username}#0001`,
          discordUserId: currentUser.discordUserId || '849201938472019283',
          verificationCode: `KING-BOT-VERIFY`,
          guildInviteUrl: discordInviteUrl,
        }),
      });
      const data = await res.json();
      if (res.ok && data.ok && data.user) {
        onUserUpdated(data.user);
        setVerifyBotPopupOpen(false);
        onShowToast(
          'Discord Bot Verified! Limit Unlocked (10 Servers)',
          `Connected to Discord & verified @${discordUsernameInput}. You can now set up up to 10 servers!`,
          'success',
          'verified'
        );
      } else {
        onShowToast(
          'Verification Failed',
          data?.error || 'Please join our Discord server first.',
          'error',
          'error'
        );
      }
    } catch {
      onShowToast(
        'Verification Error',
        'Could not reach local Discord Bot verification endpoint.',
        'error',
        'error'
      );
    } finally {
      setIsVerifyingInPopup(false);
    }
  };

  return (
    <div className="flex-1 overflow-y-auto bg-surface-dim p-6 lg:p-10">
      <div className="max-w-6xl mx-auto space-y-6">
        {/* Simple Panel Top Welcome & Action Header */}
        <div className="rounded-2xl bg-surface-container border border-white/10 p-6 shadow-2xl flex flex-col lg:flex-row lg:items-center justify-between gap-5">
          <div className="flex items-start sm:items-center gap-4">
            <div className="w-14 h-14 rounded-2xl bg-primary/15 border border-primary/30 flex items-center justify-center shrink-0 shadow-lg">
              <span className="material-symbols-outlined text-primary text-[30px]">
                space_dashboard
              </span>
            </div>
            <div>
              <div className="flex flex-wrap items-center gap-2.5">
                <h1 className="text-xl sm:text-2xl font-bold text-white tracking-tight">
                  Simple Server Panel
                </h1>
                <span className="text-xs font-mono text-outline">
                  · Quick Launcher Before Full Panel
                </span>
              </div>
              <p className="text-xs sm:text-sm text-outline mt-1">
                Welcome, <strong className="text-white">{currentUser.displayName}</strong> (
                <span className="font-mono text-primary">@{currentUser.username}</span>). Manage or create your servers quickly here, or continue to the Full Workstation Panel.
              </p>
              <div className="flex flex-wrap items-center gap-3 mt-2 text-xs font-mono">
                <span className="text-on-surface-variant">
                  Server Limit:{' '}
                  <strong className={isAtServerLimit && !isVerified ? 'text-amber-300' : 'text-secondary'}>
                    {servers.length} / {maxServerLimit} Servers
                  </strong>
                </span>
                <span className="text-white/20">·</span>
                <span className={isVerified ? 'text-secondary' : 'text-amber-300'}>
                  {isVerified
                    ? `Discord Bot Verified (@${currentUser.discordUsername || currentUser.username})`
                    : 'Standard Login (1 or 2 Servers Max)'}
                </span>
                <span className="text-white/20">·</span>
                <span className="text-outline">
                  Host RAM: {globalRamCapGb} GB / {hostTotalRamGb} GB
                </span>
              </div>
            </div>
          </div>

          {/* Right Header Controls: Setup Guide + Verify Discord Bot Button + Enter Full Panel Button */}
          <div className="flex flex-wrap items-center gap-2.5 shrink-0">
            <button
              type="button"
              onClick={() => onEnterFullPanel('setup_guide')}
              className="px-4 py-2.5 rounded-xl bg-secondary/15 hover:bg-secondary/25 border border-secondary/40 text-secondary text-xs font-bold flex items-center gap-2 cursor-pointer transition-all"
            >
              <span className="material-symbols-outlined text-[18px]">school</span>
              New User Setup Guide
            </button>

            {/* Verify Discord Bot Button (Opens Popup with option to Join Discord) */}
            <button
              type="button"
              onClick={() => setVerifyBotPopupOpen(true)}
              className={`px-4 py-2.5 rounded-xl text-xs font-bold flex items-center gap-2 cursor-pointer transition-all ${
                isVerified
                  ? 'bg-secondary/15 hover:bg-secondary/25 text-secondary border border-secondary/40'
                  : 'bg-[#5865F2] hover:bg-[#4752C4] text-white shadow-lg shadow-[#5865F2]/30'
              }`}
            >
              <span className="material-symbols-outlined text-[18px]">
                {isVerified ? 'verified' : 'forum'}
              </span>
              {isVerified ? 'Discord Bot Verified (10 Max)' : 'Verify Discord Bot'}
            </button>

            {isVerified && (
              <button
                type="button"
                onClick={onLeaveDiscordServer}
                className="px-3.5 py-2.5 rounded-xl bg-error/15 hover:bg-error/25 border border-error/40 text-error text-xs font-bold flex items-center gap-1.5 cursor-pointer transition-all"
                title="Leave Discord Server and reset server limit to 2"
              >
                <span className="material-symbols-outlined text-[16px]">link_off</span>
                Leave Discord (Reset to 2)
              </button>
            )}

            <button
              type="button"
              onClick={() => onEnterFullPanel('overview')}
              className="px-5 py-2.5 rounded-xl bg-primary hover:opacity-95 text-on-primary-container text-xs sm:text-sm font-bold flex items-center gap-2 shadow-lg shadow-primary/25 cursor-pointer transition-all"
            >
              <span>Open Full Control Panel</span>
              <span className="material-symbols-outlined text-[18px]">arrow_forward</span>
            </button>
          </div>
        </div>

        {/* New User Interactive 6-Step Setup Guide Card in Simple Pre-Panel */}
        <div className="rounded-2xl bg-gradient-to-r from-primary/10 via-surface-container to-secondary/10 border border-primary/30 p-5 space-y-4">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl bg-primary/15 border border-primary/35 flex items-center justify-center text-primary shrink-0">
                <span className="material-symbols-outlined text-[22px]">school</span>
              </div>
              <div>
                <div className="flex flex-wrap items-center gap-2">
                  <h2 className="text-sm sm:text-base font-bold text-white">
                    New User Setup Panel Guide (6-Step Quick Walkthrough)
                  </h2>
                  <span className="px-2 py-0.5 rounded bg-primary text-on-primary-container text-[10px] font-mono font-bold uppercase">
                    New User Guide
                  </span>
                </div>
                <p className="text-xs text-outline">
                  First time setting up IS King Panel on your PC? Follow these 6 steps or open the interactive Setup Wizard.
                </p>
              </div>
            </div>

            <div className="flex items-center gap-2 shrink-0">
              <button
                type="button"
                onClick={() => setShowQuickSetupGuide((prev) => !prev)}
                className="px-3 py-1.5 rounded-lg bg-white/5 hover:bg-white/10 border border-white/10 text-xs font-mono text-outline hover:text-white cursor-pointer"
              >
                {showQuickSetupGuide ? 'Hide Steps' : 'Show 6 Steps'}
              </button>
              <button
                type="button"
                onClick={() => onEnterFullPanel('setup_guide')}
                className="px-4 py-2 rounded-xl bg-primary hover:opacity-95 text-on-primary-container text-xs font-bold flex items-center gap-1.5 shadow-md cursor-pointer"
              >
                <span>Open Interactive Setup Wizard</span>
                <span className="material-symbols-outlined text-[16px]">arrow_forward</span>
              </button>
            </div>
          </div>

          {showQuickSetupGuide && (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-6 gap-2.5 pt-2 border-t border-white/10 text-xs">
              <div
                onClick={() => onEnterFullPanel('setup_guide')}
                className="p-3 rounded-xl bg-surface-lowest/90 border border-white/10 hover:border-primary/40 transition-colors cursor-pointer space-y-1"
              >
                <div className="text-[10px] font-mono text-primary font-bold">STEP 1 • IDENTITY</div>
                <div className="font-bold text-white">Profile Icon &amp; Auth</div>
                <p className="text-[11px] text-outline leading-snug">
                  Default Operator Crest icon auto-assigned &amp; synced to MongoDB + SQLite3.
                </p>
              </div>

              <div
                onClick={() => onEnterFullPanel('setup_guide')}
                className="p-3 rounded-xl bg-surface-lowest/90 border border-white/10 hover:border-primary/40 transition-colors cursor-pointer space-y-1"
              >
                <div className="text-[10px] font-mono text-primary font-bold">STEP 2 • FOLDER</div>
                <div className="font-bold text-white">Server Root Folder</div>
                <p className="text-[11px] text-outline leading-snug">
                  Set install path ({serverInstallRootDir}) &amp; Host RAM cap ({globalRamCapGb} GB).
                </p>
              </div>

              <div
                onClick={() => onEnterFullPanel('setup_guide')}
                className="p-3 rounded-xl bg-surface-lowest/90 border border-white/10 hover:border-primary/40 transition-colors cursor-pointer space-y-1"
              >
                <div className="text-[10px] font-mono text-secondary font-bold">STEP 3 • DATABASE</div>
                <div className="font-bold text-white">SQLite / XAMPP / Mongo</div>
                <p className="text-[11px] text-outline leading-snug">
                  Built-in SQLite3 + MongoDB works immediately, or connect XAMPP/MariaDB 3306.
                </p>
              </div>

              <div
                onClick={() => onEnterFullPanel('setup_guide')}
                className="p-3 rounded-xl bg-surface-lowest/90 border border-white/10 hover:border-primary/40 transition-colors cursor-pointer space-y-1"
              >
                <div className="text-[10px] font-mono text-amber-300 font-bold">STEP 4 • ENGINE</div>
                <div className="font-bold text-white">Java 21 &amp; PaperMC</div>
                <p className="text-[11px] text-outline leading-snug">
                  Auto-checks PaperMC {latestPaperRelease} every 60s &amp; flags outdated servers.
                </p>
              </div>

              <div
                onClick={() => onEnterFullPanel('setup_guide')}
                className="p-3 rounded-xl bg-surface-lowest/90 border border-white/10 hover:border-primary/40 transition-colors cursor-pointer space-y-1"
              >
                <div className="text-[10px] font-mono text-primary font-bold">STEP 5 • DEPLOY</div>
                <div className="font-bold text-white">Create First Server</div>
                <p className="text-[11px] text-outline leading-snug">
                  Deploy in 1 click &amp; connect in Minecraft via <code>localhost:25565</code>.
                </p>
              </div>

              <div
                onClick={() => onEnterFullPanel('setup_guide')}
                className="p-3 rounded-xl bg-surface-lowest/90 border border-white/10 hover:border-primary/40 transition-colors cursor-pointer space-y-1"
              >
                <div className="text-[10px] font-mono text-[#8ea1e1] font-bold">STEP 6 • UNLOCK</div>
                <div className="font-bold text-white">Discord Bot &amp; .EXE</div>
                <p className="text-[11px] text-outline leading-snug">
                  Verify Discord Bot to unlock 10 servers (2 default) &amp; run Windows .EXE mode.
                </p>
              </div>
            </div>
          )}
        </div>

        {/* PaperMC Background Version Check Service + Super Admin / Windows App (.EXE) Banner */}
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-4">
          {/* Left 7 Cols: PaperMC API Background Service Status */}
          <div className="lg:col-span-7 rounded-xl p-4 bg-surface-container border border-amber-400/30 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
            <div className="flex items-start gap-3">
              <div className="w-10 h-10 rounded-xl bg-amber-400/15 border border-amber-400/35 flex items-center justify-center text-amber-300 shrink-0">
                <span className="material-symbols-outlined text-[20px]">system_update_alt</span>
              </div>
              <div className="space-y-1 text-xs">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-bold text-white">
                    PaperMC API Background Version Monitor
                  </span>
                  <span className="px-2 py-0.5 rounded bg-secondary/15 text-secondary text-[10px] font-mono font-bold">
                    ● {paperMcReport?.serviceStatus || 'RUNNING'} (60s Poll)
                  </span>
                  {outdatedServers.length > 0 ? (
                    <span className="px-2 py-0.5 rounded bg-error/20 text-error border border-error/40 text-[10px] font-mono font-bold">
                      {outdatedServers.length} SERVER(S) OUTDATED
                    </span>
                  ) : (
                    <span className="px-2 py-0.5 rounded bg-secondary/20 text-secondary text-[10px] font-mono font-bold">
                      ALL SERVERS UP TO DATE
                    </span>
                  )}
                </div>
                <p className="text-outline font-mono text-[11px]">
                  Latest PaperMC Release:{' '}
                  <strong className="text-primary">
                    PaperMC {latestPaperRelease} ({latestPaperBuild})
                  </strong>{' '}
                  • Source: <code className="text-white/80">api.papermc.io/v2/projects/paper</code>
                </p>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2 shrink-0">
              {onRunPaperMcCheckNow && (
                <button
                  type="button"
                  onClick={onRunPaperMcCheckNow}
                  className="px-3 py-1.5 rounded-lg bg-surface-lowest hover:bg-white/10 border border-white/15 text-[11px] font-mono text-white flex items-center gap-1 cursor-pointer"
                >
                  <span className="material-symbols-outlined text-[15px] text-primary">sync</span>
                  Check API
                </button>
              )}
              {outdatedServers.length > 0 && onUpgradeServerEngine && (
                <button
                  type="button"
                  onClick={() => onUpgradeServerEngine('ALL')}
                  className="px-3 py-1.5 rounded-lg bg-amber-400 hover:bg-amber-300 text-black font-bold text-[11px] font-mono flex items-center gap-1 cursor-pointer"
                >
                  <span className="material-symbols-outlined text-[15px]">upgrade</span>
                  Update Outdated ({outdatedServers.length})
                </button>
              )}
            </div>
          </div>

          {/* Right 5 Cols: Super Admin (kingplayz) & Windows Desktop App (.EXE) Status */}
          <div className="lg:col-span-5 rounded-xl p-4 bg-surface-container border border-secondary/30 flex items-center justify-between gap-3">
            <div className="space-y-1 text-xs min-w-0">
              <div className="flex items-center gap-2">
                <span className="px-2 py-0.5 rounded bg-amber-400 text-black text-[10px] font-mono font-bold">
                  SUPER ADMIN DB
                </span>
                <span className="px-2 py-0.5 rounded bg-tertiary/15 text-tertiary border border-tertiary/30 text-[10px] font-mono font-bold">
                  WINDOWS .EXE APP
                </span>
              </div>
              <div className="text-[11px] font-mono text-white truncate">
                ID: <strong className="text-amber-300 select-all">kingplayz</strong> (
                <span className="text-outline select-all">SA-KINGPLAYZ-001</span>) • Pass:{' '}
                <strong className="text-secondary select-all">KingPlayz#2026</strong>
              </div>
              <div className="text-[10px] font-mono text-outline truncate">
                SQLite3 WAL: <code>database/isking_panel.sqlite</code> •{' '}
                <code>launch-windows-app.bat</code>
              </div>
            </div>
            <button
              type="button"
              onClick={() => onEnterFullPanel('databases')}
              className="px-3 py-2 rounded-lg bg-secondary/15 hover:bg-secondary/25 border border-secondary/35 text-secondary text-xs font-mono font-bold shrink-0 cursor-pointer"
            >
              Open DB →
            </button>
          </div>
        </div>

        {/* Quota Notice Banner */}
        <div
          className={`rounded-xl p-4 border flex flex-col sm:flex-row sm:items-center justify-between gap-4 ${
            isVerified
              ? 'bg-secondary/10 border-secondary/30'
              : 'bg-[#5865F2]/10 border-[#5865F2]/35'
          }`}
        >
          <div className="flex items-start gap-3">
            <span
              className={`material-symbols-outlined text-[22px] mt-0.5 ${
                isVerified ? 'text-secondary' : 'text-[#8ea1e1]'
              }`}
            >
              {isVerified ? 'verified_user' : 'info'}
            </span>
            <div className="text-xs space-y-1">
              <div className="font-bold text-white">
                {isVerified
                  ? `Discord Server & Bot Verified — Up to ${maxServerLimit} Servers Unlocked`
                  : 'Server Creation Rule: 1 or 2 Servers Default • Verify Discord Bot for 3+ Servers'}
              </div>
              <p className="text-outline leading-relaxed">
                {isVerified ? (
                  <>
                    Your account is connected to{' '}
                    <strong className="text-white">
                      {currentUser.discordGuildName || 'IS King Official Discord'}
                    </strong>
                    . Note: If you leave the Discord server, your server limit automatically resets back to{' '}
                    <strong className="text-white">2 servers</strong>.
                  </>
                ) : (
                  <>
                    Every logged-in user can set up <strong className="text-white">1 or 2 servers only</strong>. To set up more than 2 servers, click{' '}
                    <strong className="text-white">Verify Discord Bot</strong> to join our Discord server and verify with our bot. Leaving the Discord server resets your limit to 2.
                  </>
                )}
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={() => setVerifyBotPopupOpen(true)}
              className="px-3.5 py-2 rounded-lg bg-[#5865F2] hover:bg-[#4752C4] text-white text-xs font-bold flex items-center gap-1.5 cursor-pointer shrink-0"
            >
              <span className="material-symbols-outlined text-[16px]">group_add</span>
              {isVerified ? 'Join Discord / Bot Options' : 'Join Discord & Verify Bot'}
            </button>
          </div>
        </div>

        {/* Main 2-Column Simple Panel Grid: Left = My Servers, Right = Quick Setup Server */}
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
          {/* Left 7 Columns: Simple Server List */}
          <div className="lg:col-span-7 space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <h2 className="text-base font-bold text-white">
                  Your Local Servers ({servers.length} / {maxServerLimit})
                </h2>
                <p className="text-xs text-outline">
                  Start, stop, or open any server directly in the Full Panel
                </p>
              </div>
              <span className="text-xs font-mono text-outline">
                Root: <strong className="text-primary">{serverInstallRootDir}</strong>
              </span>
            </div>

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
                    className={`rounded-xl p-4 border transition-all cursor-pointer ${
                      isSelected
                        ? 'bg-surface-container-high border-primary/40 shadow-lg'
                        : 'bg-surface-container border-white/10 hover:border-white/20'
                    }`}
                  >
                    <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                      <div className="space-y-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <span
                            className={`w-2.5 h-2.5 rounded-full ${
                              isRunning ? 'bg-secondary animate-pulse' : 'bg-error'
                            }`}
                          />
                          <span className="text-sm font-bold text-white">{srv.name}</span>
                          <span className="text-xs font-mono text-outline">
                            · {srv.engine} · :{srv.port}
                          </span>
                          {isSrvOutdated ? (
                            <span
                              className="px-2 py-0.5 rounded bg-error/20 text-error border border-error/40 text-[10px] font-mono font-bold flex items-center gap-1"
                              title={`Flagged by PaperMC Background Service — Installed: ${
                                srv.installedVersion || srv.engine
                              } | Latest Release: ${srv.latestVersion || latestPaperRelease}`}
                            >
                              <span className="material-symbols-outlined text-[12px]">warning</span>
                              OUTDATED (Latest: {srv.latestVersion || latestPaperRelease})
                            </span>
                          ) : (
                            <span className="px-2 py-0.5 rounded bg-secondary/15 text-secondary border border-secondary/30 text-[10px] font-mono font-bold">
                              LATEST ({latestPaperRelease})
                            </span>
                          )}
                        </div>
                        <div className="text-[11px] font-mono text-outline flex flex-wrap items-center gap-2 pl-5">
                          <span>Folder: {srv.path}</span>
                          <span>·</span>
                          <span>
                            RAM: {srv.ramUsedGb} / {srv.ramMaxGb} GB
                          </span>
                          <span>·</span>
                          <span>CPU: {srv.cpuUsage}%</span>
                        </div>
                      </div>

                      <div
                        className="flex flex-wrap items-center gap-1.5"
                        onClick={(e) => e.stopPropagation()}
                      >
                        {isSrvOutdated && onUpgradeServerEngine && (
                          <button
                            type="button"
                            onClick={() => onUpgradeServerEngine(srv.id)}
                            className="px-2.5 py-1.5 rounded-lg bg-amber-400 hover:bg-amber-300 text-black text-xs font-mono font-bold flex items-center gap-1 cursor-pointer"
                            title={`Upgrade ${srv.name} to latest release ${latestPaperRelease}`}
                          >
                            <span className="material-symbols-outlined text-[14px]">upgrade</span>
                            Update to {srv.latestVersion || latestPaperRelease}
                          </button>
                        )}
                        {!isRunning ? (
                          <button
                            type="button"
                            onClick={() => onServerPowerAction(srv.id, 'start')}
                            className="px-3 py-1.5 rounded-lg bg-secondary/20 hover:bg-secondary/30 text-secondary border border-secondary/30 text-xs font-bold flex items-center gap-1 cursor-pointer"
                          >
                            <span className="material-symbols-outlined text-[15px]">
                              play_arrow
                            </span>
                            Start
                          </button>
                        ) : (
                          <>
                            <button
                              type="button"
                              onClick={() => onServerPowerAction(srv.id, 'restart')}
                              className="px-2.5 py-1.5 rounded-lg bg-amber-400/15 hover:bg-amber-400/25 text-amber-300 border border-amber-400/30 text-xs font-semibold flex items-center gap-1 cursor-pointer"
                            >
                              <span className="material-symbols-outlined text-[14px]">
                                restart_alt
                              </span>
                              Restart
                            </button>
                            <button
                              type="button"
                              onClick={() => onServerPowerAction(srv.id, 'stop')}
                              className="px-2.5 py-1.5 rounded-lg bg-white/10 hover:bg-white/15 text-white text-xs font-semibold flex items-center gap-1 cursor-pointer"
                            >
                              <span className="material-symbols-outlined text-[14px]">
                                stop
                              </span>
                              Stop
                            </button>
                          </>
                        )}

                        <button
                          type="button"
                          onClick={() => onEnterFullPanel('console', srv)}
                          className="px-3 py-1.5 rounded-lg bg-primary/15 hover:bg-primary/25 text-primary border border-primary/30 text-xs font-bold flex items-center gap-1 cursor-pointer"
                        >
                          <span>Open Panel</span>
                          <span className="material-symbols-outlined text-[14px]">
                            open_in_new
                          </span>
                        </button>

                        {servers.length > 1 && (
                          <button
                            type="button"
                            onClick={() => onDeleteServerInstance(srv.id)}
                            className="p-1.5 rounded-lg bg-error/10 hover:bg-error/20 text-error cursor-pointer"
                            title="Delete Server"
                          >
                            <span className="material-symbols-outlined text-[15px]">delete</span>
                          </button>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Right 5 Columns: Quick Setup Server Card */}
          <div className="lg:col-span-5 space-y-4">
            <div className="rounded-2xl bg-surface-container border border-white/10 p-5 space-y-4">
              <div className="flex items-center justify-between">
                <div>
                  <h2 className="text-base font-bold text-white">Quick Setup New Server</h2>
                  <p className="text-xs text-outline">
                    Create a server directly from the Simple Panel
                  </p>
                </div>
                <span className="text-xs font-mono text-primary font-bold">
                  {servers.length}/{maxServerLimit} Used
                </span>
              </div>

              <form onSubmit={handleQuickCreateServer} className="space-y-3.5">
                <div>
                  <label className="text-[11px] font-mono text-outline uppercase block mb-1">
                    Server Name
                  </label>
                  <input
                    type="text"
                    value={newServerName}
                    onChange={(e) => setNewServerName(e.target.value)}
                    placeholder={`Survival Server #${servers.length + 1}`}
                    className="w-full bg-surface-lowest border border-white/15 focus:border-primary rounded-xl px-3.5 py-2 text-xs text-white focus:outline-none"
                  />
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="text-[11px] font-mono text-outline uppercase block mb-1">
                      Server Engine &amp; Version
                    </label>
                    <select
                      value={newServerEngine}
                      onChange={(e) => setNewServerEngine(e.target.value)}
                      className="w-full bg-surface-lowest border border-white/15 focus:border-primary rounded-xl px-3 py-2 text-xs text-white focus:outline-none"
                    >
                      <option value="PaperMC 1.21.4">PaperMC 1.21.4</option>
                      <option value="PaperMC 1.20.4">PaperMC 1.20.4</option>
                      <option value="Purpur 1.21.4">Purpur 1.21.4</option>
                      <option value="Fabric 1.21.1">Fabric 1.21.1</option>
                      <option value="Forge 1.20.1">Forge 1.20.1</option>
                      <option value="Vanilla 1.21.4">Vanilla 1.21.4</option>
                    </select>
                  </div>

                  <div>
                    <label className="text-[11px] font-mono text-outline uppercase block mb-1">
                      Port &amp; RAM (GB)
                    </label>
                    <div className="flex gap-2">
                      <input
                        type="number"
                        value={newServerPort}
                        onChange={(e) => setNewServerPort(Number(e.target.value))}
                        className="w-1/2 bg-surface-lowest border border-white/15 rounded-xl px-2.5 py-2 text-xs font-mono text-white focus:outline-none"
                      />
                      <select
                        value={newServerRamGb}
                        onChange={(e) => setNewServerRamGb(Number(e.target.value))}
                        className="w-1/2 bg-surface-lowest border border-white/15 rounded-xl px-2 py-2 text-xs font-mono text-white focus:outline-none"
                      >
                        <option value={2}>2 GB</option>
                        <option value={4}>4 GB</option>
                        <option value={6}>6 GB</option>
                        <option value={8}>8 GB</option>
                        <option value={12}>12 GB</option>
                      </select>
                    </div>
                  </div>
                </div>

                <div className="p-2.5 rounded-lg bg-surface-lowest border border-white/5 text-[11px] font-mono text-outline truncate">
                  Install Path: <span className="text-primary">{previewPath}</span>
                </div>

                {isAtServerLimit && !isVerified ? (
                  <div className="space-y-2">
                    <button
                      type="button"
                      onClick={() => setVerifyBotPopupOpen(true)}
                      className="w-full py-2.5 px-4 rounded-xl bg-[#5865F2] hover:bg-[#4752C4] text-white text-xs font-bold flex items-center justify-center gap-2 shadow-lg shadow-[#5865F2]/30 cursor-pointer transition-all"
                    >
                      <span className="material-symbols-outlined text-[18px]">verified</span>
                      Limit (2/2) Reached — Verify Discord Bot to Setup 3+ Servers
                    </button>
                  </div>
                ) : (
                  <button
                    type="submit"
                    disabled={isDeploying}
                    className="w-full py-2.5 px-4 rounded-xl bg-primary hover:opacity-95 text-on-primary-container text-xs font-bold flex items-center justify-center gap-2 shadow-lg shadow-primary/20 cursor-pointer transition-all"
                  >
                    <span className="material-symbols-outlined text-[18px]">add_circle</span>
                    {isDeploying ? 'Installing Server...' : '+ Setup Server Now'}
                  </button>
                )}
              </form>
            </div>

            {/* Quick Account & Session Card */}
            <div className="rounded-2xl bg-surface-container border border-white/10 p-4 flex items-center justify-between gap-3">
              <div className="flex items-center gap-3 min-w-0">
                <img
                  src={resolveUserAvatarUrl(currentUser.avatarUrl)}
                  onError={(e) => {
                    (e.currentTarget as HTMLImageElement).src = DEFAULT_PROFILE_ICON_URL;
                  }}
                  alt={currentUser.username}
                  className="w-10 h-10 rounded-xl object-cover border border-primary/40 shrink-0 bg-surface"
                />
                <div className="min-w-0">
                  <div className="text-xs font-bold text-white truncate">
                    {currentUser.displayName} (@{currentUser.username})
                  </div>
                  <div className="text-[11px] text-outline truncate">{currentUser.email}</div>
                </div>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <button
                  type="button"
                  onClick={() => onOpenAuthModal('signin')}
                  className="px-3 py-1.5 rounded-lg bg-white/5 hover:bg-white/10 text-xs font-semibold text-white cursor-pointer"
                >
                  Switch User
                </button>
                <button
                  type="button"
                  onClick={onSignOut}
                  className="px-3 py-1.5 rounded-lg bg-error/15 hover:bg-error/25 text-xs font-semibold text-error cursor-pointer"
                >
                  Sign Out
                </button>
              </div>
            </div>
          </div>
        </div>

        {/* Bottom Quick Navigation Bar into Full Panel Sections */}
        <div className="rounded-2xl bg-surface-container border border-white/10 p-5 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div>
            <div className="text-sm font-bold text-white">
              Need Advanced Controls? Enter the Full Workstation Panel
            </div>
            <p className="text-xs text-outline">
              Access real-time JVM flags, Modrinth/Spigot plugins, port forwarding, and global RAM controls.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => onEnterFullPanel('setup_guide')}
              className="px-3.5 py-2 rounded-xl bg-secondary/15 hover:bg-secondary/25 border border-secondary/35 text-xs font-bold text-secondary flex items-center gap-1.5 cursor-pointer"
            >
              <span className="material-symbols-outlined text-[16px]">school</span>
              Setup Panel Guide
            </button>
            <button
              type="button"
              onClick={() => onEnterFullPanel('console')}
              className="px-3.5 py-2 rounded-xl bg-surface-lowest hover:bg-white/10 border border-white/10 text-xs font-semibold text-white flex items-center gap-1.5 cursor-pointer"
            >
              <span className="material-symbols-outlined text-[16px] text-primary">terminal</span>
              Live Console
            </button>
            <button
              type="button"
              onClick={() => onEnterFullPanel('plugins')}
              className="px-3.5 py-2 rounded-xl bg-surface-lowest hover:bg-white/10 border border-white/10 text-xs font-semibold text-white flex items-center gap-1.5 cursor-pointer"
            >
              <span className="material-symbols-outlined text-[16px] text-secondary">
                extension
              </span>
              Mods &amp; Plugins
            </button>
            <button
              type="button"
              onClick={() => onEnterFullPanel('panel_control')}
              className="px-3.5 py-2 rounded-xl bg-surface-lowest hover:bg-white/10 border border-white/10 text-xs font-semibold text-white flex items-center gap-1.5 cursor-pointer"
            >
              <span className="material-symbols-outlined text-[16px] text-primary-gold">
                admin_panel_settings
              </span>
              RAM &amp; Profile Control
            </button>
            <button
              type="button"
              onClick={() => onEnterFullPanel('overview')}
              className="px-4 py-2 rounded-xl bg-primary hover:opacity-95 text-on-primary-container text-xs font-bold flex items-center gap-1.5 cursor-pointer"
            >
              <span>Enter Full Panel</span>
              <span className="material-symbols-outlined text-[16px]">arrow_forward</span>
            </button>
          </div>
        </div>
      </div>

      {/* Popup on clicking "Verify Discord Bot" button giving option to Join Discord */}
      {verifyBotPopupOpen && (
        <div
          className="fixed inset-0 z-50 bg-black/80 backdrop-blur-md flex items-center justify-center p-4"
          onClick={() => setVerifyBotPopupOpen(false)}
        >
          <div
            className="w-full max-w-md rounded-2xl bg-[#111726] border border-[#5865F2]/50 shadow-2xl overflow-hidden animate-in fade-in zoom-in-95 duration-150"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="px-5 py-4 bg-gradient-to-r from-[#5865F2]/25 to-surface border-b border-white/10 flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-xl bg-[#5865F2] flex items-center justify-center text-white shadow-lg shadow-[#5865F2]/30">
                  <span className="material-symbols-outlined text-[22px]">forum</span>
                </div>
                <div>
                  <h3 className="text-sm font-bold text-white">
                    Verify Discord Bot &amp; Join Discord
                  </h3>
                  <p className="text-[11px] text-outline">
                    Unlock up to 10 servers by joining our Discord server
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setVerifyBotPopupOpen(false)}
                className="p-1 rounded-lg bg-white/5 hover:bg-white/10 text-outline hover:text-white cursor-pointer"
              >
                <span className="material-symbols-outlined text-[18px]">close</span>
              </button>
            </div>

            <div className="p-5 space-y-4">
              {/* Step 1: Option to Join Discord Server */}
              <div className="p-4 rounded-xl bg-[#5865F2]/10 border border-[#5865F2]/35 space-y-3">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-bold text-white">
                    Step 1: Join Official Discord Server
                  </span>
                  <span className="text-[10px] font-mono text-secondary">● Online</span>
                </div>
                <p className="text-xs text-outline leading-relaxed">
                  Click the button below to join{' '}
                  <strong className="text-white">
                    {currentUser.discordGuildName || 'IS King Official Discord'}
                  </strong>{' '}
                  so our Discord Bot (<code className="text-primary">ISKingBot#4821</code>) can verify you.
                </p>
                <div className="flex items-center gap-2">
                  <input
                    type="text"
                    value={discordInviteUrl}
                    onChange={(e) => setDiscordInviteUrl(e.target.value)}
                    className="flex-1 bg-surface-lowest border border-white/15 rounded-lg px-3 py-1.5 text-xs font-mono text-[#8ea1e1] focus:outline-none"
                  />
                </div>
                <a
                  href={discordInviteUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={() => {
                    setHasClickedJoinDiscord(true);
                    onShowToast(
                      'Discord Invite Opened',
                      `Joined ${discordInviteUrl}. Now click "Verify with Discord Bot" below!`,
                      'info',
                      'forum'
                    );
                  }}
                  className="w-full py-2.5 px-4 rounded-xl bg-[#5865F2] hover:bg-[#4752C4] text-white text-xs font-bold flex items-center justify-center gap-2 shadow-lg shadow-[#5865F2]/30 cursor-pointer transition-all"
                >
                  <span className="material-symbols-outlined text-[18px]">group_add</span>
                  {hasClickedJoinDiscord
                    ? 'Joined Discord Server (Open Invite Again)'
                    : 'Join Discord Server Now'}
                </a>
              </div>

              {/* Step 2: Verify with Discord Bot */}
              <div className="p-4 rounded-xl bg-surface-lowest border border-white/10 space-y-3">
                <label className="text-xs font-bold text-white block">
                  Step 2: Enter Discord Username &amp; Verify Bot
                </label>
                <input
                  type="text"
                  value={discordUsernameInput}
                  onChange={(e) => setDiscordUsernameInput(e.target.value)}
                  placeholder="Your Discord Tag (e.g. Mio_Sakura#0001)"
                  className="w-full bg-surface border border-white/15 focus:border-primary rounded-lg px-3 py-2 text-xs font-mono text-white focus:outline-none"
                />
                <button
                  type="button"
                  disabled={isVerifyingInPopup}
                  onClick={handlePopupVerifyDiscordBot}
                  className="w-full py-2.5 px-4 rounded-xl bg-secondary hover:opacity-95 text-on-secondary-container text-xs font-bold flex items-center justify-center gap-2 shadow-lg shadow-secondary/20 cursor-pointer transition-all"
                >
                  <span className="material-symbols-outlined text-[18px]">verified</span>
                  {isVerifyingInPopup
                    ? 'Verifying with Discord Bot...'
                    : 'Verify with Discord Bot (Unlock 10 Servers)'}
                </button>
              </div>

              <div className="flex items-center justify-between pt-1">
                <button
                  type="button"
                  onClick={() => {
                    setVerifyBotPopupOpen(false);
                    onOpenDiscordBotGate();
                  }}
                  className="text-xs font-mono text-primary hover:underline cursor-pointer"
                >
                  Open Advanced Bot Console →
                </button>
                <button
                  type="button"
                  onClick={() => setVerifyBotPopupOpen(false)}
                  className="px-4 py-1.5 rounded-lg bg-white/5 hover:bg-white/10 text-xs text-outline hover:text-white cursor-pointer"
                >
                  Close
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
