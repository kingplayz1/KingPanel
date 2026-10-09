import React from 'react';
import { NavSection, ServerInstance, AuthUser } from '../types';
import { DEFAULT_PROFILE_ICON_URL, resolveUserAvatarUrl } from '../utils/profileIcons';

interface SidebarProps {
  activeSection: NavSection;
  onSelectSection: (section: NavSection) => void;
  activeServer: ServerInstance;
  servers: ServerInstance[];
  onSelectServer: (server: ServerInstance) => void;
  snapshotCount: number;
  hostTotalRamGb?: number;
  currentUser: AuthUser | null;
  onOpenAuthModal: (mode: 'signin' | 'signup') => void;
  onOpenDiscordBotGate?: () => void;
  onLeaveDiscordServer?: () => void;
  onSignOut: () => void;
}

export const Sidebar: React.FC<SidebarProps> = ({
  activeSection,
  onSelectSection,
  activeServer,
  servers,
  onSelectServer,
  snapshotCount,
  hostTotalRamGb = 32,
  currentUser,
  onOpenAuthModal,
  onOpenDiscordBotGate,
  onLeaveDiscordServer,
  onSignOut,
}) => {
  const handleCycleServer = () => {
    const idx = servers.findIndex((s) => s.id === activeServer.id);
    const next = servers[(idx + 1) % servers.length];
    onSelectServer(next);
  };

  const navItemClass = (section: NavSection) =>
    `sidebar-link w-full flex items-center gap-2.5 px-3 py-2 rounded-lg font-medium transition-colors cursor-pointer text-left ${
      activeSection === section
        ? 'active text-white'
        : 'text-white/70 hover:text-white hover:bg-white/5'
    }`;

  const iconClass = (section: NavSection) =>
    `material-symbols-outlined text-base ${
      activeSection === section ? 'text-primary' : 'text-white/60'
    }`;

  const runningServers = servers.filter(
    (s) => s.status === 'running' || s.status === 'restarting'
  );
  const combinedCpu = Math.min(
    100,
    runningServers.reduce((acc, s) => acc + s.cpuUsage, 0)
  );
  const combinedRam = Number(
    runningServers.reduce((acc, s) => acc + s.ramUsedGb, 0).toFixed(1)
  );
  const combinedRamPercent = Math.min(100, Math.round((combinedRam / hostTotalRamGb) * 100));

  return (
    <aside className="w-64 bg-[#0e121b] border-r border-white/5 flex flex-col shrink-0 select-none z-20">
      {/* Server Selector Card & Discord Server Quota Strip in Sidebar */}
      <div className="p-3.5 border-b border-white/5 space-y-2">
        <div
          onClick={handleCycleServer}
          title="Click to cycle active server instance"
          className="p-2.5 rounded-xl bg-surface-container/70 border border-white/5 hover:border-primary/40 transition-colors cursor-pointer group"
        >
          <div className="flex items-center gap-2.5">
            <div className="size-9 rounded-lg bg-gradient-to-br from-amber-500/20 to-amber-900/30 border border-primary/30 flex items-center justify-center shrink-0">
              <span className="text-lg">⛏️</span>
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-center justify-between gap-1">
                <h3 className="text-xs font-bold text-white truncate">{activeServer.name}</h3>
                <div className="flex items-center gap-1 shrink-0">
                  {activeServer.isOutdated && (
                    <span className="px-1 py-0.5 rounded bg-amber-500/20 border border-amber-500/40 text-amber-300 text-[8px] font-mono font-bold uppercase">
                      Outdated
                    </span>
                  )}
                  <span
                    className={`size-2 rounded-full ${
                      activeServer.status === 'running' ? 'bg-secondary' : 'bg-error'
                    }`}
                  />
                </div>
              </div>
              <p className="text-[11px] text-on-surface-variant/80 font-mono truncate">
                {activeServer.engine} • {activeServer.javaVersion}
              </p>
            </div>
          </div>
        </div>

        {/* Live Server Creation Limit & Discord Bot Verification Strip */}
        {currentUser && (
          <div className="p-2 rounded-lg bg-surface-lowest/90 border border-white/10 text-[10px] font-mono space-y-1.5">
            <div className="flex items-center justify-between">
              <span className="text-white/60">Server Limit:</span>
              <span
                className={`font-bold ${
                  currentUser.isSuperAdmin || currentUser.role === 'Super Admin'
                    ? 'text-primary'
                    : currentUser.discordVerified
                    ? 'text-secondary'
                    : 'text-amber-300'
                }`}
              >
                {servers.length} /{' '}
                {currentUser.isSuperAdmin || currentUser.role === 'Super Admin'
                  ? currentUser.maxServerLimit || 999
                  : currentUser.discordVerified
                  ? currentUser.maxServerLimit || 10
                  : 2}{' '}
                {currentUser.isSuperAdmin || currentUser.role === 'Super Admin'
                  ? '(Super Admin)'
                  : currentUser.discordVerified
                  ? '(Bot Verified)'
                  : '(Max 2)'}
              </span>
            </div>
            {currentUser.discordVerified ? (
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  onClick={() => onOpenDiscordBotGate && onOpenDiscordBotGate()}
                  className="flex-1 py-1 px-2 rounded bg-secondary/15 hover:bg-secondary/25 text-secondary font-bold text-[10px] cursor-pointer truncate"
                >
                  ✓ Discord Verified
                </button>
                {onLeaveDiscordServer && (
                  <button
                    type="button"
                    onClick={onLeaveDiscordServer}
                    title="Leave Discord Server (Resets server creation limit to 2)"
                    className="py-1 px-2 rounded bg-error/15 hover:bg-error/25 text-error font-bold text-[10px] cursor-pointer shrink-0"
                  >
                    Leave
                  </button>
                )}
              </div>
            ) : (
              <button
                type="button"
                onClick={() => onOpenDiscordBotGate && onOpenDiscordBotGate()}
                className="w-full py-1 px-2 rounded bg-[#5865F2]/25 hover:bg-[#5865F2]/40 border border-[#5865F2]/40 text-white font-bold text-[10px] flex items-center justify-center gap-1 cursor-pointer transition-colors"
              >
                <span className="material-symbols-outlined text-[12px] text-[#8ea1e1]">
                  verified
                </span>
                <span>Verify Discord Bot (&gt;2 Servers)</span>
              </button>
            )}
          </div>
        )}
      </div>

      {/* Navigation Scroll Area */}
      <nav className="flex-1 overflow-y-auto px-2 py-3 space-y-4 text-xs">
        {/* SERVER OPERATIONS */}
        <div>
          <p className="px-3 text-[10px] font-bold tracking-wider text-white/40 uppercase font-mono">
            Server Operations
          </p>
          <div className="mt-1.5 space-y-0.5">
            <button
              type="button"
              onClick={() => onSelectSection('overview')}
              className={navItemClass('overview')}
            >
              <span className={iconClass('overview')}>space_dashboard</span>
              <span className="whitespace-nowrap">Overview</span>
              <span className="ml-auto text-[10px] font-mono px-1.5 py-0.5 rounded bg-secondary/10 text-secondary">
                {runningServers.length}/{servers.length} Online
              </span>
            </button>

            <button
              type="button"
              onClick={() => onSelectSection('setup_guide')}
              className={navItemClass('setup_guide')}
            >
              <span className={iconClass('setup_guide')}>school</span>
              <span className="whitespace-nowrap">Setup Panel Guide</span>
              <span className="ml-auto text-[10px] font-mono px-1.5 py-0.5 rounded bg-primary/15 text-primary border border-primary/30 font-bold">
                New User
              </span>
            </button>

            <button
              type="button"
              onClick={() => onSelectSection('console')}
              className={navItemClass('console')}
            >
              <span className={iconClass('console')}>terminal</span>
              <span className="whitespace-nowrap">Console &amp; Telemetry</span>
              {activeSection === 'console' && (
                <span className="ml-auto size-1.5 rounded-full bg-primary animate-ping" />
              )}
            </button>

            <button
              type="button"
              onClick={() => onSelectSection('files')}
              className={navItemClass('files')}
            >
              <span className={iconClass('files')}>folder_open</span>
              <span className="whitespace-nowrap">File Manager</span>
              <span className="ml-auto text-[10px] font-mono text-white/40">NVMe</span>
            </button>

            <button
              type="button"
              onClick={() => onSelectSection('plugins')}
              className={navItemClass('plugins')}
            >
              <span className={iconClass('plugins')}>extension</span>
              <span className="whitespace-nowrap">Modpacks &amp; Plugins</span>
              <span className="ml-auto text-[10px] font-mono px-1.5 py-0.5 rounded bg-primary/10 text-primary">
                Curse/Modr
              </span>
            </button>

            <button
              type="button"
              onClick={() => onSelectSection('logs')}
              className={navItemClass('logs')}
            >
              <span className={iconClass('logs')}>receipt_long</span>
              <span className="whitespace-nowrap">Server Logs</span>
              {activeSection === 'logs' && (
                <span className="ml-auto size-1.5 rounded-full bg-primary animate-ping" />
              )}
            </button>
          </div>
        </div>

        {/* INFRASTRUCTURE & AUTOMATION */}
        <div>
          <p className="px-3 text-[10px] font-bold tracking-wider text-white/40 uppercase font-mono">
            Infrastructure &amp; Automation
          </p>
          <div className="mt-1.5 space-y-0.5">
            <button
              type="button"
              onClick={() => onSelectSection('network')}
              className={navItemClass('network')}
            >
              <span className={iconClass('network')}>hub</span>
              <span className="whitespace-nowrap">Network &amp; Ports</span>
              <span className="ml-auto text-[10px] font-mono text-secondary">UPnP On</span>
            </button>

            <button
              type="button"
              onClick={() => onSelectSection('backups')}
              className={navItemClass('backups')}
            >
              <span className={iconClass('backups')}>backup</span>
              <span className="whitespace-nowrap">Backups &amp; Snapshots</span>
              <span className="ml-auto text-[10px] font-mono text-white/40">{snapshotCount} Ready</span>
            </button>

            <button
              type="button"
              onClick={() => onSelectSection('schedules')}
              className={navItemClass('schedules')}
            >
              <span className={iconClass('schedules')}>schedule</span>
              <span className="whitespace-nowrap">Schedules &amp; Crons</span>
            </button>

            <button
              type="button"
              onClick={() => onSelectSection('databases')}
              className={navItemClass('databases')}
            >
              <span className={iconClass('databases')}>database</span>
              <span className="whitespace-nowrap">Databases</span>
              <span className="ml-auto text-[10px] font-mono text-white/40">SQLite</span>
            </button>
          </div>
        </div>

        {/* CONFIGURATION */}
        <div>
          <p className="px-3 text-[10px] font-bold tracking-wider text-white/40 uppercase font-mono">
            Configuration
          </p>
          <div className="mt-1.5 space-y-0.5">
            <button
              type="button"
              onClick={() => onSelectSection('panel_control')}
              className={navItemClass('panel_control')}
            >
              <span className={iconClass('panel_control')}>admin_panel_settings</span>
              <span className="whitespace-nowrap">Panel Control &amp; Profile</span>
              <span className="ml-auto text-[10px] font-mono px-1.5 py-0.5 rounded bg-primary/15 text-primary">
                RAM / Kill
              </span>
            </button>

            <button
              type="button"
              onClick={() => onSelectSection('jvm')}
              className={navItemClass('jvm')}
            >
              <span className={iconClass('jvm')}>tune</span>
              <span className="whitespace-nowrap">Startup &amp; JVM Flags</span>
              <span className="ml-auto text-[10px] font-mono text-primary-gold">Aikar&apos;s GC</span>
            </button>

            <button
              type="button"
              onClick={() => onSelectSection('settings')}
              className={navItemClass('settings')}
            >
              <span className={iconClass('settings')}>settings</span>
              <span className="whitespace-nowrap">Server Settings</span>
            </button>
          </div>
        </div>

        {/* LEGAL & COMPLIANCE */}
        <div>
          <p className="px-3 text-[10px] font-bold tracking-wider text-white/60 uppercase font-mono">
            Legal &amp; Compliance
          </p>
          <div className="mt-1.5 space-y-0.5">
            <button
              type="button"
              onClick={() => onSelectSection('privacy')}
              className={navItemClass('privacy')}
            >
              <span className={iconClass('privacy')}>shield_lock</span>
              <span className="whitespace-nowrap">Privacy Policy</span>
            </button>

            <button
              type="button"
              onClick={() => onSelectSection('terms')}
              className={navItemClass('terms')}
            >
              <span className={iconClass('terms')}>gavel</span>
              <span className="whitespace-nowrap">Terms &amp; Conditions</span>
            </button>
          </div>
        </div>
      </nav>

      {/* FOOTER / LOCALHOST HOST SYSTEM TELEMETRY */}
      <div className="p-3 border-t border-white/5 bg-[#0b0e16]/80 text-[11px] font-mono space-y-2">
        <div className="flex items-center justify-between text-white/70">
          <span className="text-[10px] text-white/40 uppercase font-bold">Host System Node</span>
          <span className="inline-flex items-center gap-1 text-[10px] text-secondary">
            <span className="size-1.5 rounded-full bg-secondary" />
            Daemon v4.8
          </span>
        </div>
        <div className="p-2 rounded-lg bg-surface-container/60 border border-white/5 space-y-1">
          <div className="flex justify-between text-[10px]">
            <span className="text-white/60">AMD Ryzen 9 / EPYC</span>
            <span className="text-white font-semibold tabular-nums">{combinedCpu}% Total</span>
          </div>
          <div className="w-full bg-white/5 h-1 rounded-full overflow-hidden">
            <div
              className="bg-primary h-full rounded-full transition-all duration-300"
              style={{ width: `${combinedCpu}%` }}
            />
          </div>
          <div className="flex justify-between text-[10px] pt-1">
            <span className="text-white/60">
              Host RAM: {combinedRam} / {hostTotalRamGb} GB
            </span>
            <span className="text-secondary font-mono tabular-nums">{combinedRamPercent}%</span>
          </div>
          <div className="w-full bg-white/5 h-1 rounded-full overflow-hidden">
            <div
              className="bg-secondary h-full rounded-full transition-all duration-300"
              style={{ width: `${combinedRamPercent}%` }}
            />
          </div>
        </div>

        {/* Authenticated Operator Card & Sign Out */}
        {currentUser && (
          <div className="pt-2 border-t border-white/5 flex items-center justify-between gap-2">
            <div
              onClick={() => onSelectSection('panel_control')}
              title="Open Panel Control, Global RAM Allocator & User Profile"
              className="flex items-center gap-2 min-w-0 flex-1 cursor-pointer group"
            >
              <img
                src={resolveUserAvatarUrl(currentUser.avatarUrl)}
                onError={(e) => {
                  (e.currentTarget as HTMLImageElement).src = DEFAULT_PROFILE_ICON_URL;
                }}
                alt={currentUser.username}
                className="w-7 h-7 rounded-lg border border-primary/40 object-cover shrink-0 bg-surface"
              />
              <div className="min-w-0 flex-1">
                <div className="text-[11px] font-bold text-white group-hover:text-primary transition-colors truncate">
                  {currentUser.displayName}
                </div>
                <div className="text-[9px] text-white/50 uppercase truncate">
                  {currentUser.role} • {currentUser.provider}
                </div>
              </div>
            </div>
            <button
              type="button"
              onClick={onSignOut}
              title="Sign Out"
              className="p-1.5 rounded-lg bg-error/10 hover:bg-error/25 text-error border border-error/25 transition-colors cursor-pointer shrink-0"
            >
              <span className="material-symbols-outlined text-[15px]">logout</span>
            </button>
          </div>
        )}
      </div>
    </aside>
  );
};
