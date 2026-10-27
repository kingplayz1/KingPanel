import React, { useEffect, useState } from 'react';
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

interface NavItemDef {
  key: NavSection;
  label: string;
  icon: string;
  trailing?: string;
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
  onOpenDiscordBotGate,
  onLeaveDiscordServer,
  onSignOut,
}) => {
  // Real host identity shown in the footer, straight from panel telemetry.
  const [hostCpuModel, setHostCpuModel] = useState('');
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch('/api/panel/telemetry');
        const data = await res.json();
        if (!cancelled && data?.ok && data.host?.cpuModel) {
          setHostCpuModel(String(data.host.cpuModel));
        }
      } catch {
        // telemetry unavailable — the footer falls back to a neutral label
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const handleCycleServer = () => {
    if (!servers.length) return;
    const idx = servers.findIndex((s) => s.id === activeServer.id);
    const next = servers[(idx + 1) % servers.length];
    onSelectServer(next);
  };

  const runningServers = servers.filter((s) => s.status === 'running' || s.status === 'restarting');
  const combinedCpu = Math.min(
    100,
    runningServers.reduce((acc, s) => acc + s.cpuUsage, 0),
  );
  const combinedRam = Number(runningServers.reduce((acc, s) => acc + s.ramUsedGb, 0).toFixed(1));
  const combinedRamPercent = Math.min(100, Math.round((combinedRam / hostTotalRamGb) * 100));
  const isSuperAdmin = currentUser?.isSuperAdmin || currentUser?.role === 'Super Admin';
  const serverLimit = isSuperAdmin
    ? currentUser?.maxServerLimit || 999
    : currentUser?.discordVerified
      ? currentUser?.maxServerLimit || 10
      : 2;

  const groups: Array<{ label: string; items: NavItemDef[] }> = [
    {
      label: 'Server',
      items: [
        {
          key: 'overview',
          label: 'Overview',
          icon: 'space_dashboard',
          trailing: `${runningServers.length}/${servers.length}`,
        },
        { key: 'console', label: 'Console', icon: 'terminal' },
        { key: 'files', label: 'Files', icon: 'folder_open' },
        { key: 'plugins', label: 'Mods & Plugins', icon: 'extension' },
        { key: 'logs', label: 'Logs', icon: 'receipt_long' },
      ],
    },
    {
      label: 'Automation',
      items: [
        { key: 'schedules', label: 'Schedules', icon: 'schedule' },
        { key: 'backups', label: 'Backups', icon: 'backup', trailing: String(snapshotCount) },
        { key: 'network', label: 'Network', icon: 'hub' },
        { key: 'databases', label: 'Databases', icon: 'database' },
      ],
    },
    {
      label: 'Configuration',
      items: [
        { key: 'jvm', label: 'Startup & JVM', icon: 'tune' },
        { key: 'settings', label: 'Server Settings', icon: 'settings' },
        { key: 'panel_control', label: 'Panel Control', icon: 'admin_panel_settings' },
      ],
    },
    {
      label: 'Account',
      items: [
        { key: 'setup_guide', label: 'Setup Guide', icon: 'school' },
        { key: 'account', label: 'Sessions', icon: 'security' },
        { key: 'privacy', label: 'Privacy', icon: 'shield_lock' },
        { key: 'terms', label: 'Terms', icon: 'gavel' },
      ],
    },
  ];

  const NavItem: React.FC<{ item: NavItemDef }> = ({ item }) => {
    const active = activeSection === item.key;
    return (
      <button
        type="button"
        onClick={() => onSelectSection(item.key)}
        className={`relative w-full flex items-center gap-2.5 h-8 pl-3 pr-2.5 rounded-lg text-[12.5px] font-medium transition-colors cursor-pointer ${
          active
            ? 'bg-white/[0.055] text-white'
            : 'text-[#a7b1c6] hover:text-white hover:bg-white/[0.03]'
        }`}
        title={item.label}
      >
        {active && (
          <span className="absolute left-0 top-2 bottom-2 w-[2px] rounded-full bg-primary" />
        )}
        <span
          className={`material-symbols-outlined text-[17px] ${
            active ? 'text-primary' : 'text-[#7f8a9f]'
          }`}
        >
          {item.icon}
        </span>
        <span className="truncate">{item.label}</span>
        {item.trailing !== undefined && (
          <span className="ml-auto font-mono text-[10px] text-[#758093]">{item.trailing}</span>
        )}
      </button>
    );
  };

  return (
    <aside className="w-[244px] shrink-0 bg-[#0b0f16] border-r border-white/[0.06] flex flex-col select-none z-20">
      {/* Workspace: active server + limits */}
      <div className="px-3 pt-3 pb-2.5 space-y-2">
        <button
          type="button"
          onClick={handleCycleServer}
          title="Switch active server"
          className="w-full flex items-center gap-2.5 p-2 rounded-xl bg-white/[0.03] border border-white/[0.06] hover:border-white/[0.12] transition-colors cursor-pointer text-left"
        >
          <span
            className={`size-2 rounded-full shrink-0 ${
              activeServer.status === 'running' ? 'bg-secondary' : 'bg-white/25'
            }`}
          />
          <span className="min-w-0 flex-1">
            <span className="block text-[12.5px] font-semibold text-white truncate">
              {activeServer.name}
            </span>
            <span className="block text-[10.5px] font-mono text-[#7f8a9f] truncate">
              {activeServer.engine} · :{activeServer.port}
            </span>
          </span>
          <span className="material-symbols-outlined text-[16px] text-[#7f8a9f]">unfold_more</span>
        </button>

        {currentUser && (
          <div className="flex items-center justify-between px-1 text-[10.5px] font-mono">
            <span className="text-[#7f8a9f]">
              Servers{' '}
              <span className="text-[#c9d2e2]">
                {servers.length}/{serverLimit}
              </span>
            </span>
            {currentUser.discordVerified ? (
              <span
                className="flex items-center gap-1 text-secondary/90"
                title="Discord bot verified"
              >
                <span className="material-symbols-outlined text-[13px]">verified</span>
                {onLeaveDiscordServer && (
                  <button
                    type="button"
                    onClick={onLeaveDiscordServer}
                    className="text-[10px] text-[#7f8a9f] hover:text-error cursor-pointer"
                    title="Leave the Discord server (limit resets to 2)"
                  >
                    Leave
                  </button>
                )}
              </span>
            ) : (
              <button
                type="button"
                onClick={() => onOpenDiscordBotGate?.()}
                className="flex items-center gap-1 text-[10px] text-[#8ea1e1] hover:text-white cursor-pointer"
                title="Verify the Discord bot to raise the server limit"
              >
                <span className="material-symbols-outlined text-[13px]">verified</span>
                Verify
              </button>
            )}
          </div>
        )}
      </div>

      <div className="h-px bg-white/[0.05] mx-3" />

      {/* Navigation */}
      <nav className="flex-1 overflow-y-auto px-2 py-3 space-y-4">
        {groups.map((group) => (
          <div key={group.label}>
            <p className="px-3 mb-1 text-[10px] font-semibold tracking-[0.09em] uppercase text-[#6c7689]">
              {group.label}
            </p>
            <div className="space-y-0.5">
              {group.items.map((item) => (
                <NavItem key={item.key} item={item} />
              ))}
            </div>
          </div>
        ))}
      </nav>

      {/* Footer: host load + operator */}
      <div className="border-t border-white/[0.06] px-3 py-3 space-y-3">
        <div className="space-y-1.5">
          <div className="flex items-center justify-between text-[10px] font-mono">
            <span className="text-[#7f8a9f] truncate max-w-[140px]" title={hostCpuModel}>
              {hostCpuModel || 'Host CPU'}
            </span>
            <span className="text-[#c9d2e2]">{combinedCpu}%</span>
          </div>
          <div className="h-[3px] rounded-full bg-white/[0.06] overflow-hidden">
            <div
              className="h-full rounded-full bg-primary/75 transition-all duration-300"
              style={{ width: `${combinedCpu}%` }}
            />
          </div>
          <div className="flex items-center justify-between text-[10px] font-mono">
            <span className="text-[#7f8a9f]">
              RAM {combinedRam} / {hostTotalRamGb} GB
            </span>
            <span className="text-[#c9d2e2]">{combinedRamPercent}%</span>
          </div>
          <div className="h-[3px] rounded-full bg-white/[0.06] overflow-hidden">
            <div
              className="h-full rounded-full bg-secondary/70 transition-all duration-300"
              style={{ width: `${combinedRamPercent}%` }}
            />
          </div>
        </div>

        {currentUser && (
          <div className="flex items-center gap-2 pt-2.5 border-t border-white/[0.06]">
            <button
              type="button"
              onClick={() => onSelectSection('panel_control')}
              className="flex items-center gap-2 min-w-0 flex-1 cursor-pointer text-left group"
              title="Panel control, global RAM and profile"
            >
              <img
                src={resolveUserAvatarUrl(currentUser.avatarUrl)}
                onError={(e) => {
                  (e.currentTarget as HTMLImageElement).src = DEFAULT_PROFILE_ICON_URL;
                }}
                alt={currentUser.username}
                className="size-7 rounded-lg object-cover border border-white/[0.08] bg-surface shrink-0"
              />
              <span className="min-w-0 flex-1">
                <span className="block text-[11.5px] font-semibold text-white truncate group-hover:text-primary transition-colors">
                  {currentUser.displayName}
                </span>
                <span className="block text-[10px] text-[#7f8a9f] truncate">
                  {currentUser.role}
                </span>
              </span>
            </button>
            <button
              type="button"
              onClick={onSignOut}
              title="Sign out"
              className="p-1.5 rounded-lg text-[#8b95a9] hover:text-error hover:bg-error/10 transition-colors cursor-pointer shrink-0"
            >
              <span className="material-symbols-outlined text-[16px]">logout</span>
            </button>
          </div>
        )}
      </div>
    </aside>
  );
};
