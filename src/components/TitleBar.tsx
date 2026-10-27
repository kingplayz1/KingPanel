import React, { useState, useRef, useEffect, useMemo } from 'react';
import { ServerInstance, FileItem, PluginItem, CronTask, NavSection, AuthUser } from '../types';
import { DEFAULT_PROFILE_ICON_URL, resolveUserAvatarUrl } from '../utils/profileIcons';
import { BrandMark } from './BrandMark';

interface TitleBarProps {
  servers: ServerInstance[];
  activeServer: ServerInstance;
  files: FileItem[];
  plugins: PluginItem[];
  crons: CronTask[];
  currentUser: AuthUser | null;
  onOpenAuthModal: (mode: 'signin' | 'signup') => void;
  onSignOut: () => void;
  onSelectServer: (server: ServerInstance) => void;
  onNavigate: (section: NavSection) => void;
  onOpenFile: (fileId: string, fileName: string) => void;
  onSelectPlugin: (plugin: PluginItem) => void;
  onTriggerCron: (task: CronTask) => void;
  onShowToast: (
    title: string,
    body?: string,
    type?: 'success' | 'info' | 'warning' | 'error',
    icon?: string,
  ) => void;
  isMinimized: boolean;
  isMaximized: boolean;
  onToggleMinimize: () => void;
  onMinimize: () => void;
  onToggleMaximize: () => void;
  isSimplePanelMode?: boolean;
  onToggleSimplePanel?: () => void;
  onOpenDiscordBotGate?: () => void;
  /** Opens the exit dialog (hide-to-tray / quit) instead of closing directly. */
  onRequestClose?: () => void;
}

type PaletteCategory = 'all' | 'servers' | 'files' | 'plugins' | 'crons';

interface PaletteResultItem {
  id: string;
  category: 'servers' | 'files' | 'plugins' | 'crons';
  title: string;
  subtitle: string;
  badge: string;
  badgeColor: string;
  icon: string;
  iconColor: string;
  metaRight: string;
  rawServer?: ServerInstance;
  rawFile?: FileItem;
  rawPlugin?: PluginItem;
  rawCron?: CronTask;
}

export const TitleBar: React.FC<TitleBarProps> = ({
  servers,
  activeServer,
  files,
  plugins,
  crons,
  currentUser,
  onOpenAuthModal,
  onSignOut,
  onSelectServer,
  onNavigate,
  onOpenFile,
  onSelectPlugin,
  onTriggerCron,
  onShowToast,
  onToggleMinimize,
  onMinimize,
  onToggleMaximize,
  isSimplePanelMode,
  onToggleSimplePanel,
  onOpenDiscordBotGate,
  onRequestClose,
}) => {
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const [isMaximized, setIsMaximized] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [activeCategory, setActiveCategory] = useState<PaletteCategory>('all');
  const [selectedIndex, setSelectedIndex] = useState(0);

  const dropdownRef = useRef<HTMLDivElement>(null);
  const userMenuRef = useRef<HTMLDivElement>(null);
  const paletteInputRef = useRef<HTMLInputElement>(null);

  // Close instance switcher and user menu dropdown on outside click
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setDropdownOpen(false);
      }
      if (userMenuRef.current && !userMenuRef.current.contains(e.target as Node)) {
        setUserMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // Sync the real OS window state (Electron) into the title-bar buttons so the
  // maximize glyph reflects the actual window, not local React state.
  useEffect(() => {
    if (!window.electronicState) return;
    setIsMaximized(window.electronicState.isMaximized());
    const unsubscribe = window.electronic?.onStateChange?.((state) => {
      setIsMaximized(Boolean(state?.maximized));
    });
    return () => {
      if (typeof unsubscribe === 'function') unsubscribe();
    };
  }, []);

  // Global keyboard shortcut Ctrl+K / Cmd+K to toggle Command Palette
  useEffect(() => {
    const handleGlobalKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPaletteOpen((prev) => !prev);
      } else if (e.key === 'Escape' && paletteOpen) {
        e.preventDefault();
        setPaletteOpen(false);
      }
    };
    window.addEventListener('keydown', handleGlobalKeyDown);
    return () => window.removeEventListener('keydown', handleGlobalKeyDown);
  }, [paletteOpen]);

  // Focus input when Command Palette opens
  useEffect(() => {
    if (paletteOpen) {
      setTimeout(() => {
        paletteInputRef.current?.focus();
      }, 20);
    }
  }, [paletteOpen]);

  // Flatten nested FileItem tree so all files and config files are searchable
  const flattenedFiles = useMemo(() => {
    const result: FileItem[] = [];
    const traverse = (items: FileItem[]) => {
      for (const item of items) {
        if (item.type === 'file') {
          result.push(item);
        }
        if (item.children && item.children.length > 0) {
          traverse(item.children);
        }
      }
    };
    traverse(files);
    return result;
  }, [files]);

  // Filter Servers, Files, Plugins, and Cron Tasks
  const { matchedServers, matchedFiles, matchedPlugins, matchedCrons, unifiedResults } =
    useMemo(() => {
      const q = searchQuery.trim().toLowerCase();

      const mServers = servers.filter(
        (s) =>
          !q ||
          s.name.toLowerCase().includes(q) ||
          s.engine.toLowerCase().includes(q) ||
          String(s.port).includes(q) ||
          String(s.pid).includes(q) ||
          s.path.toLowerCase().includes(q) ||
          s.status.toLowerCase().includes(q),
      );

      const mFiles = flattenedFiles.filter(
        (f) =>
          !q ||
          f.name.toLowerCase().includes(q) ||
          f.path.toLowerCase().includes(q) ||
          (f.language && f.language.toLowerCase().includes(q)) ||
          (f.content && f.content.toLowerCase().includes(q)),
      );

      const mPlugins = plugins.filter(
        (p) =>
          !q ||
          p.name.toLowerCase().includes(q) ||
          p.author.toLowerCase().includes(q) ||
          p.category.toLowerCase().includes(q) ||
          p.source.toLowerCase().includes(q) ||
          p.description.toLowerCase().includes(q),
      );

      const mCrons = crons.filter(
        (c) =>
          !q ||
          c.title.toLowerCase().includes(q) ||
          c.cron.toLowerCase().includes(q) ||
          c.description.toLowerCase().includes(q) ||
          c.status.toLowerCase().includes(q),
      );

      const items: PaletteResultItem[] = [];

      if (activeCategory === 'all' || activeCategory === 'servers') {
        mServers.forEach((srv) => {
          items.push({
            id: `srv-${srv.id}`,
            category: 'servers',
            title: srv.name,
            subtitle: `${srv.engine} • ${srv.path} • PID ${srv.pid || 'Offline'}`,
            badge: srv.status.toUpperCase(),
            badgeColor:
              srv.status === 'running'
                ? 'bg-secondary/15 text-secondary border-secondary/30'
                : srv.status === 'restarting'
                  ? 'bg-primary/15 text-primary border-primary/30'
                  : 'bg-error/15 text-error border-error/30',
            icon: 'dns',
            iconColor:
              srv.status === 'running'
                ? 'bg-secondary/10 text-secondary border-secondary/25'
                : 'bg-surface-container-highest text-outline border-white/[0.08]',
            metaRight: `:${srv.port} • ${srv.playersOnline}/${srv.maxPlayers} Players`,
            rawServer: srv,
          });
        });
      }

      if (activeCategory === 'all' || activeCategory === 'files') {
        mFiles.forEach((file) => {
          items.push({
            id: `file-${file.id}`,
            category: 'files',
            title: file.name,
            subtitle: file.path,
            badge: (file.language || 'config').toUpperCase(),
            badgeColor: 'bg-primary/15 text-primary border-primary/30',
            icon: file.icon || 'description',
            iconColor: 'bg-primary/10 text-primary border-primary/25',
            metaRight: file.size || 'UTF-8',
            rawFile: file,
          });
        });
      }

      if (activeCategory === 'all' || activeCategory === 'plugins') {
        mPlugins.forEach((plugin) => {
          items.push({
            id: `plg-${plugin.id}`,
            category: 'plugins',
            title: `${plugin.name} (${plugin.version})`,
            subtitle: `${plugin.category} by ${plugin.author} • ${plugin.source}`,
            badge:
              plugin.status === 'update_ready'
                ? `UPDATE → ${plugin.targetVersion}`
                : plugin.status === 'installed'
                  ? 'INSTALLED'
                  : 'AVAILABLE',
            badgeColor:
              plugin.status === 'update_ready'
                ? 'bg-primary-gold/15 text-primary-gold border-primary-gold/30'
                : plugin.status === 'installed'
                  ? 'bg-secondary/15 text-secondary border-secondary/30'
                  : 'bg-tertiary/15 text-tertiary border-tertiary/30',
            icon: 'extension',
            iconColor: 'bg-tertiary/10 text-tertiary border-tertiary/25',
            metaRight: plugin.downloads,
            rawPlugin: plugin,
          });
        });
      }

      if (activeCategory === 'all' || activeCategory === 'crons') {
        mCrons.forEach((cron) => {
          items.push({
            id: `cron-${cron.id}`,
            category: 'crons',
            title: cron.title,
            subtitle: cron.description,
            badge: cron.cron,
            badgeColor: 'bg-surface-lowest text-primary border-primary/30',
            icon: cron.icon || 'schedule',
            iconColor: 'bg-secondary/10 text-secondary border-secondary/25',
            metaRight: cron.nextRun,
            rawCron: cron,
          });
        });
      }

      return {
        matchedServers: mServers,
        matchedFiles: mFiles,
        matchedPlugins: mPlugins,
        matchedCrons: mCrons,
        unifiedResults: items,
      };
    }, [servers, flattenedFiles, plugins, crons, searchQuery, activeCategory]);

  // Reset selectedIndex when search query or category changes
  useEffect(() => {
    setSelectedIndex(0);
  }, [searchQuery, activeCategory]);

  const handleExecuteItem = (item: PaletteResultItem) => {
    if (item.category === 'servers' && item.rawServer) {
      onSelectServer(item.rawServer);
      onNavigate('console');
      setPaletteOpen(false);
    } else if (item.category === 'files' && item.rawFile) {
      onOpenFile(item.rawFile.id, item.rawFile.name);
      setPaletteOpen(false);
    } else if (item.category === 'plugins' && item.rawPlugin) {
      onSelectPlugin(item.rawPlugin);
      setPaletteOpen(false);
    } else if (item.category === 'crons' && item.rawCron) {
      onNavigate('schedules');
      onShowToast(
        `Focused Schedule: ${item.rawCron.title}`,
        `Cron Expression: ${item.rawCron.cron} (${item.rawCron.nextRun})`,
        'info',
        'schedule',
      );
      setPaletteOpen(false);
    }
  };

  const handlePaletteKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (unifiedResults.length > 0) {
        setSelectedIndex((prev) => (prev + 1) % unifiedResults.length);
      }
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (unifiedResults.length > 0) {
        setSelectedIndex((prev) => (prev - 1 + unifiedResults.length) % unifiedResults.length);
      }
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const current = unifiedResults[selectedIndex];
      if (current) {
        handleExecuteItem(current);
      }
    } else if (e.key === 'Tab') {
      e.preventDefault();
      const order: PaletteCategory[] = ['all', 'servers', 'files', 'plugins', 'crons'];
      const nextIdx =
        (order.indexOf(activeCategory) + (e.shiftKey ? order.length - 1 : 1)) % order.length;
      setActiveCategory(order[nextIdx]);
    }
  };

  const handleToggleFullscreen = () => {
    if (window.electronic?.maximize) {
      // Electron: toggle the real OS window; state syncs back via IPC.
      window.electronic.maximize();
    } else {
      onToggleMaximize();
    }
    onShowToast(
      isMaximized ? 'Window Restored' : 'Window Maximized',
      'Obsidian Sovereign workstation viewport adjusted.',
      'info',
      'aspect_ratio',
    );
  };

  const totalMatchCount =
    matchedServers.length + matchedFiles.length + matchedPlugins.length + matchedCrons.length;

  return (
    <>
      <header className="mica-titlebar relative z-50 flex items-center justify-between px-3 py-1.5 select-none shrink-0 text-xs">
        {/* Left Window Identity & Active Server Switcher */}
        <div className="flex items-center gap-3">
          {/* Brand lockup: crown crest + KingPanel wordmark */}
          <BrandMark />

          {/* Active Server Switcher Pill */}
          <div
            className="hidden md:flex items-center gap-2 ml-2 pl-3 border-l border-white/[0.08] relative"
            ref={dropdownRef}
          >
            <button
              type="button"
              onClick={() => setDropdownOpen(!dropdownOpen)}
              className="flex items-center gap-1.5 px-2.5 py-0.5 rounded-md bg-surface-container hover:bg-surface-container-high border border-white/[0.08] text-on-surface text-[11px] transition-colors cursor-pointer"
            >
              <span
                className={`size-2 rounded-full ${
                  activeServer.status === 'running'
                    ? 'bg-secondary animate-pulse'
                    : activeServer.status === 'restarting'
                      ? 'bg-primary animate-spin'
                      : 'bg-error'
                }`}
              />
              <span className="font-semibold text-white whitespace-nowrap">
                {activeServer.name}
              </span>
              <span className="material-symbols-outlined text-xs text-white/40 ml-0.5">
                unfold_more
              </span>
            </button>

            {/* Server Instance Switcher Dropdown */}
            {dropdownOpen && (
              <div className="absolute left-3 top-full mt-1.5 w-80 rounded-xl bg-surface-container-low border border-white/[0.08] p-1.5 z-50 space-y-1">
                <div className="px-2.5 py-1 text-[10px] font-mono uppercase tracking-wider text-white/40 flex items-center justify-between">
                  <span>Localhost Server Instances</span>
                  <span className="text-secondary">{servers.length} Nodes</span>
                </div>
                {servers.map((srv) => {
                  const isSelected = srv.id === activeServer.id;
                  return (
                    <button
                      key={srv.id}
                      type="button"
                      onClick={() => {
                        onSelectServer(srv);
                        setDropdownOpen(false);
                      }}
                      className={`w-full flex items-center justify-between px-2.5 py-2 rounded-lg text-left transition-colors cursor-pointer ${
                        isSelected
                          ? 'bg-primary/15 border border-primary/30 text-white'
                          : 'hover:bg-surface-container-high text-on-surface-variant hover:text-white'
                      }`}
                    >
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <span
                            className={`size-2 rounded-full ${
                              srv.status === 'running' ? 'bg-secondary' : 'bg-error'
                            }`}
                          />
                          <span className="font-semibold text-xs text-white truncate">
                            {srv.name}
                          </span>
                        </div>
                        <div className="text-[10px] font-mono text-white/50 pl-4">
                          {srv.engine} • Port {srv.port} • PID {srv.pid}
                        </div>
                      </div>
                      {isSelected && (
                        <span className="material-symbols-outlined text-primary text-sm">
                          check_circle
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        </div>

        {/* Center Global Search Bar (Command Palette Trigger) */}
        <div className="flex-1 max-w-md mx-4">
          <div
            onClick={() => setPaletteOpen(true)}
            className="w-full flex items-center justify-between gap-2 px-3 py-1 rounded-lg bg-surface-lowest/90 hover:bg-surface-container border border-white/[0.08] hover:border-primary/40 transition-all cursor-pointer group "
          >
            <div className="flex items-center gap-2 min-w-0 flex-1">
              <span className="material-symbols-outlined text-[15px] text-outline group-hover:text-primary transition-colors">
                search
              </span>
              <input
                type="text"
                readOnly
                value={searchQuery}
                onFocus={() => setPaletteOpen(true)}
                placeholder="Search or jump to…"
                className="w-full bg-transparent text-[11px] font-mono text-on-surface placeholder:text-outline/70 focus:outline-none cursor-pointer truncate"
              />
            </div>
            <div className="flex items-center gap-1.5 shrink-0">
              <span className="hidden sm:inline-flex items-center gap-1 text-[10px] font-mono text-outline/70">
                <span className="px-1.5 py-0.2 rounded bg-surface-container-high border border-white/[0.08] text-[9px] text-white/70">
                  Ctrl K
                </span>
              </span>
            </div>
          </div>
        </div>

        {/* Right: Operator Account Menu + IPC Badge + Window Management Icons */}
        <div className="flex items-center gap-2">
          {currentUser && onToggleSimplePanel && (
            <button
              type="button"
              onClick={onToggleSimplePanel}
              className={`px-2.5 py-0.5 rounded-lg text-[10px] font-mono font-bold border flex items-center gap-1 cursor-pointer transition-colors ${
                isSimplePanelMode
                  ? 'bg-primary text-on-primary-container border-primary'
                  : 'bg-surface-container hover:bg-surface-container-high text-primary border-primary/30'
              }`}
              title="Switch between Simple Pre-Panel and Full Workstation Panel"
            >
              <span className="material-symbols-outlined text-[13px]">
                {isSimplePanelMode ? 'dashboard' : 'space_dashboard'}
              </span>
              {isSimplePanelMode ? 'Enter Full Panel' : 'Simple Panel'}
            </button>
          )}

          {currentUser && onOpenDiscordBotGate && (
            <button
              type="button"
              onClick={onOpenDiscordBotGate}
              className={`hidden md:inline-flex items-center gap-1 text-[10px] font-mono px-2.5 py-0.5 rounded-lg border cursor-pointer transition-colors ${
                currentUser.discordVerified
                  ? 'bg-secondary/15 text-secondary border-secondary/35'
                  : 'bg-[#5865F2]/20 hover:bg-[#5865F2]/30 text-[#8ea1e1] border-[#5865F2]/40'
              }`}
              title="Verify Discord membership or join the official Discord server"
            >
              <span className="material-symbols-outlined text-[13px]">
                {currentUser.discordVerified ? 'verified' : 'forum'}
              </span>
              {currentUser.discordVerified
                ? `Bot Verified (${servers.length}/${currentUser.maxServerLimit || 10})`
                : `Verify Discord (${servers.length}/2)`}
            </button>
          )}

          {/* Operator Identity & Auth Menu */}
          {currentUser ? (
            <div className="relative" ref={userMenuRef}>
              <button
                type="button"
                onClick={() => setUserMenuOpen(!userMenuOpen)}
                className="flex items-center gap-2 px-2 py-0.5 rounded-lg bg-surface-container hover:bg-surface-container-high border border-white/[0.08] hover:border-primary/40 transition-colors cursor-pointer"
              >
                <img
                  src={resolveUserAvatarUrl(currentUser.avatarUrl)}
                  onError={(e) => {
                    (e.currentTarget as HTMLImageElement).src = DEFAULT_PROFILE_ICON_URL;
                  }}
                  alt={currentUser.username}
                  className="w-4 h-4 rounded-full object-cover ring-1 ring-primary/40 bg-surface"
                />
                <span className="font-semibold text-[11px] text-white hidden sm:inline">
                  {currentUser.username}
                </span>
                <span className="material-symbols-outlined text-[14px] text-white/50">
                  expand_more
                </span>
              </button>

              {userMenuOpen && (
                <div className="absolute right-0 top-full mt-1.5 w-72 rounded-xl bg-surface-container-low border border-white/15 p-3 z-50 space-y-3">
                  <div className="flex items-center gap-3 pb-2.5 border-b border-white/[0.08]">
                    <img
                      src={resolveUserAvatarUrl(currentUser.avatarUrl)}
                      onError={(e) => {
                        (e.currentTarget as HTMLImageElement).src = DEFAULT_PROFILE_ICON_URL;
                      }}
                      alt={currentUser.username}
                      className="w-10 h-10 rounded-lg border border-primary/40 object-cover bg-surface"
                    />
                    <div className="min-w-0 flex-1">
                      <div className="text-xs font-bold text-white truncate">
                        {currentUser.displayName}
                      </div>
                      <div className="text-[10px] font-mono text-outline truncate">
                        {currentUser.email}
                      </div>
                      <div className="flex items-center gap-1.5 mt-1">
                        <span className="px-1.5 py-0.2 rounded text-[9px] font-mono bg-primary/15 text-primary border border-primary/30 font-bold">
                          {currentUser.role}
                        </span>
                        <span className="px-1.5 py-0.2 rounded text-[9px] font-mono bg-secondary/15 text-secondary border border-secondary/30 uppercase">
                          {currentUser.provider} Auth
                        </span>
                      </div>
                    </div>
                  </div>

                  <div className="space-y-1 text-[10px] font-mono text-outline">
                    <div className="flex justify-between">
                      <span>Session Token:</span>
                      <span className="text-on-surface">{currentUser.sessionSha}</span>
                    </div>
                    <div className="flex justify-between">
                      <span>Linked Providers:</span>
                      <span className="text-secondary uppercase">
                        {currentUser.connectedProviders.join(', ')}
                      </span>
                    </div>
                  </div>

                  <div className="pt-2 border-t border-white/[0.08] space-y-1.5">
                    <button
                      type="button"
                      onClick={() => {
                        setUserMenuOpen(false);
                        onOpenAuthModal('signin');
                      }}
                      className="w-full px-3 py-1.5 rounded-lg bg-surface-container-high hover:bg-surface-bright text-xs font-medium text-white flex items-center gap-2 transition-colors cursor-pointer"
                    >
                      <span className="material-symbols-outlined text-[16px] text-primary">
                        switch_account
                      </span>
                      Switch Account / Link OAuth
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setUserMenuOpen(false);
                        onOpenAuthModal('signup');
                      }}
                      className="w-full px-3 py-1.5 rounded-lg bg-surface-container-high hover:bg-surface-bright text-xs font-medium text-white flex items-center gap-2 transition-colors cursor-pointer"
                    >
                      <span className="material-symbols-outlined text-[16px] text-secondary">
                        person_add
                      </span>
                      Register Operator (Sign Up)
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setUserMenuOpen(false);
                        onSignOut();
                      }}
                      className="w-full px-3 py-1.5 rounded-lg bg-error/15 hover:bg-error/25 text-xs font-bold text-error border border-error/30 flex items-center gap-2 transition-colors cursor-pointer"
                    >
                      <span className="material-symbols-outlined text-[16px]">logout</span>
                      Sign Out of Workstation
                    </button>
                  </div>
                </div>
              )}
            </div>
          ) : (
            <button
              type="button"
              onClick={() => onOpenAuthModal('signin')}
              className="px-2.5 py-1 rounded-lg bg-primary text-on-primary-container text-[11px] font-bold flex items-center gap-1 cursor-pointer"
            >
              <span className="material-symbols-outlined text-[14px]">login</span>
              Sign In
            </button>
          )}

          <div className="flex items-center">
            <button
              type="button"
              onClick={() => {
                if (window.electronic?.minimize) {
                  // Electron: minimize the real OS window.
                  window.electronic.minimize();
                } else {
                  onMinimize();
                  onToggleMinimize();
                }
              }}
              className="px-3 py-1 hover:bg-white/10 text-white/70 hover:text-white transition-colors"
              title="Minimize"
            >
              <svg className="size-3" fill="currentColor" viewBox="0 0 12 12">
                <rect height="1" width="10" x="1" y="6" />
              </svg>
            </button>
            <button
              type="button"
              onClick={handleToggleFullscreen}
              className="px-3 py-1 hover:bg-white/10 text-white/70 hover:text-white transition-colors"
              title="Maximize / Fullscreen"
            >
              <svg
                className="size-3"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.2"
                viewBox="0 0 12 12"
              >
                <rect height="8" width="8" x="2" y="2" />
              </svg>
            </button>
            <button
              type="button"
              onClick={() => {
                if (onRequestClose) {
                  onRequestClose();
                } else if (window.electronic?.close) {
                  window.electronic.close();
                }
              }}
              className="px-3 py-1 hover:bg-red-600 text-white/70 hover:text-white transition-colors"
              title="Close Window"
            >
              <svg
                className="size-3"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.2"
                viewBox="0 0 12 12"
              >
                <path d="M2 2l8 8M10 2l-8 8" />
              </svg>
            </button>
          </div>
        </div>
      </header>

      {/* GLOBAL COMMAND PALETTE OVERLAY */}
      {paletteOpen && (
        <div
          className="fixed inset-0 z-50 bg-black/75 backdrop-blur-md flex items-start justify-center pt-16 px-4 select-none"
          onClick={() => setPaletteOpen(false)}
        >
          <div
            className="w-full max-w-2xl rounded-xl bg-surface border border-primary/30 overflow-hidden flex flex-col max-h-[80vh] ring-1 ring-white/10"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Top Search Bar Input */}
            <div className="px-4 py-3.5 bg-surface-container border-b border-white/[0.06] flex items-center gap-3">
              <span className="material-symbols-outlined text-primary text-[22px]">
                manage_search
              </span>
              <input
                ref={paletteInputRef}
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                onKeyDown={handlePaletteKeyDown}
                placeholder="Filter servers, config files, plugins, or cron tasks (e.g. 'Mio', 'config.yml', 'LuckPerms', '0 4 * * *')..."
                className="flex-1 bg-transparent text-sm font-mono text-white placeholder:text-outline focus:outline-none"
              />
              {searchQuery && (
                <button
                  type="button"
                  onClick={() => setSearchQuery('')}
                  className="px-2 py-0.5 rounded bg-surface-container-highest hover:bg-surface-bright text-[11px] font-mono text-outline hover:text-white cursor-pointer"
                >
                  Clear
                </button>
              )}
              <span className="px-2 py-0.5 rounded bg-surface-lowest border border-white/[0.06] text-[10px] font-mono text-outline">
                ESC
              </span>
            </div>

            {/* Category Filter Pills */}
            <div className="px-4 py-2 bg-surface-container-low border-b border-white/[0.06] flex items-center justify-between gap-2 flex-wrap">
              <div className="flex items-center gap-1.5 flex-wrap">
                {(
                  [
                    { id: 'all', label: 'All Results', count: totalMatchCount, icon: 'apps' },
                    {
                      id: 'servers',
                      label: 'Servers',
                      count: matchedServers.length,
                      icon: 'dns',
                    },
                    {
                      id: 'files',
                      label: 'Files & Configs',
                      count: matchedFiles.length,
                      icon: 'folder_open',
                    },
                    {
                      id: 'plugins',
                      label: 'Plugins',
                      count: matchedPlugins.length,
                      icon: 'extension',
                    },
                    {
                      id: 'crons',
                      label: 'Cron Tasks',
                      count: matchedCrons.length,
                      icon: 'schedule',
                    },
                  ] as const
                ).map((tab) => {
                  const isActive = activeCategory === tab.id;
                  return (
                    <button
                      key={tab.id}
                      type="button"
                      onClick={() => setActiveCategory(tab.id)}
                      className={`px-2.5 py-1 rounded-lg text-xs font-medium flex items-center gap-1.5 transition-all cursor-pointer ${
                        isActive
                          ? 'bg-primary text-on-primary-container font-bold shadow'
                          : 'bg-surface-lowest text-outline hover:text-white border border-white/[0.06]'
                      }`}
                    >
                      <span className="material-symbols-outlined text-[14px]">{tab.icon}</span>
                      <span>{tab.label}</span>
                      <span
                        className={`px-1.5 py-0.2 rounded text-[10px] font-mono ${
                          isActive
                            ? 'bg-black/20 text-on-primary-container'
                            : 'bg-surface-container-highest text-outline'
                        }`}
                      >
                        {tab.count}
                      </span>
                    </button>
                  );
                })}
              </div>
              <span className="text-[10px] font-mono text-outline hidden sm:inline">
                Press <strong className="text-primary">Tab</strong> to switch category
              </span>
            </div>

            {/* Filtered Results Scroll List */}
            <div className="flex-1 overflow-y-auto p-3 space-y-1.5 divide-y divide-outline-variant/5">
              {unifiedResults.length === 0 ? (
                <div className="py-12 text-center space-y-2">
                  <span className="material-symbols-outlined text-4xl text-outline/40">
                    search_off
                  </span>
                  <div className="text-sm font-bold text-on-surface">
                    No matching servers, files, plugins, or cron tasks
                  </div>
                  <p className="text-xs font-mono text-outline">
                    Try searching for &quot;PaperMC&quot;, &quot;server.properties&quot;,
                    &quot;LuckPerms&quot;, or &quot;Snapshot&quot;
                  </p>
                </div>
              ) : (
                unifiedResults.map((item, idx) => {
                  const isHighlighted = idx === selectedIndex;
                  const categoryLabels: Record<PaletteResultItem['category'], string> = {
                    servers: 'SERVER INSTANCE',
                    files: 'CONFIG FILE',
                    plugins: 'PLUGIN / MOD',
                    crons: 'CRON SCHEDULE',
                  };

                  return (
                    <div
                      key={item.id}
                      onMouseEnter={() => setSelectedIndex(idx)}
                      onClick={() => handleExecuteItem(item)}
                      className={`p-3 rounded-xl border transition-all flex items-center justify-between gap-3 cursor-pointer ${
                        isHighlighted
                          ? 'bg-primary/10 border-primary/40 '
                          : 'bg-surface-container-low/60 border-transparent hover:border-white/[0.06]'
                      }`}
                    >
                      <div className="flex items-center gap-3 min-w-0 flex-1">
                        <div
                          className={`w-9 h-9 rounded-lg border flex items-center justify-center shrink-0 ${item.iconColor}`}
                        >
                          <span className="material-symbols-outlined text-[19px]">{item.icon}</span>
                        </div>

                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="text-[9px] font-mono uppercase tracking-wider px-1.5 py-0.2 rounded bg-surface-container-highest text-outline">
                              {categoryLabels[item.category]}
                            </span>
                            <span className="text-xs font-bold text-white truncate">
                              {item.title}
                            </span>
                            <span
                              className={`px-1.5 py-0.2 rounded text-[10px] font-mono border ${item.badgeColor}`}
                            >
                              {item.badge}
                            </span>
                          </div>
                          <div className="text-[11px] font-mono text-outline truncate mt-0.5">
                            {item.subtitle}
                          </div>
                        </div>
                      </div>

                      {/* Right Metadata & Quick Action Buttons */}
                      <div className="flex items-center gap-2 shrink-0">
                        <span className="text-[10px] font-mono text-outline hidden md:inline">
                          {item.metaRight}
                        </span>

                        {item.category === 'crons' && item.rawCron && (
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              onTriggerCron(item.rawCron!);
                              setPaletteOpen(false);
                            }}
                            className="px-2 py-1 rounded bg-secondary/15 hover:bg-secondary/25 text-secondary border border-secondary/30 text-[10px] font-mono font-bold cursor-pointer"
                          >
                            Run Now
                          </button>
                        )}

                        <span
                          className={`px-2 py-1 rounded text-[10px] font-mono flex items-center gap-1 ${
                            isHighlighted
                              ? 'bg-primary text-on-primary-container font-bold'
                              : 'bg-surface-container-highest text-outline'
                          }`}
                        >
                          {item.category === 'servers'
                            ? 'Switch'
                            : item.category === 'files'
                              ? 'Edit File'
                              : item.category === 'plugins'
                                ? 'Inspect'
                                : 'Open'}
                          <span className="material-symbols-outlined text-[12px]">
                            keyboard_return
                          </span>
                        </span>
                      </div>
                    </div>
                  );
                })
              )}
            </div>

            {/* Bottom Keyboard Navigation Legend */}
            <div className="px-4 py-2.5 bg-surface-container border-t border-white/[0.06] flex items-center justify-between text-[11px] font-mono text-outline">
              <div className="flex items-center gap-4">
                <span className="flex items-center gap-1">
                  <kbd className="px-1.5 py-0.5 rounded bg-surface-lowest border border-white/[0.08] text-[10px] text-white">
                    ↑↓
                  </kbd>
                  Navigate
                </span>
                <span className="flex items-center gap-1">
                  <kbd className="px-1.5 py-0.5 rounded bg-surface-lowest border border-white/[0.08] text-[10px] text-white">
                    ↵
                  </kbd>
                  Open / Jump
                </span>
                <span className="flex items-center gap-1">
                  <kbd className="px-1.5 py-0.5 rounded bg-surface-lowest border border-white/[0.08] text-[10px] text-white">
                    Tab
                  </kbd>
                  Filter Type
                </span>
              </div>
              <div>
                Indexed: {servers.length} Servers • {flattenedFiles.length} Files • {plugins.length}{' '}
                Plugins • {crons.length} Crons
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
};
