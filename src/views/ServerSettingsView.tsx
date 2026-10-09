import React, { useState } from 'react';
import { ServerInstance, NavSection } from '../types';
import { HOTLINKED_IMAGES } from '../data/initialData';

interface ServerSettingsViewProps {
  server: ServerInstance;
  onNavigate: (section: NavSection) => void;
  onShowToast: (
    title: string,
    body?: string,
    type?: 'success' | 'info' | 'warning' | 'error',
    icon?: string
  ) => void;
}

interface WhitelistedPlayer {
  id: string;
  username: string;
  uuid: string;
  avatar: string;
  online: boolean;
  role: 'OP LVL 4' | 'OP LVL 3' | 'MEMBER';
}

const INITIAL_WHITELIST: WhitelistedPlayer[] = [
  {
    id: 'wl-1',
    username: 'Mio_Sakura',
    uuid: 'f84c6a79-0a4e-45e0-879b-cd49ebd4c4e2',
    avatar: HOTLINKED_IMAGES.avatarMio,
    online: true,
    role: 'OP LVL 4',
  },
  {
    id: 'wl-2',
    username: 'Aki_Craft99',
    uuid: '3b91a2e4-72c1-44d8-918a-5e2b99f01a88',
    avatar: HOTLINKED_IMAGES.avatarAki,
    online: true,
    role: 'OP LVL 3',
  },
  {
    id: 'wl-3',
    username: 'Kuro_Neko_JP',
    uuid: '99c100f2-18b4-4099-b811-77a910de3310',
    avatar: HOTLINKED_IMAGES.avatarKuro,
    online: false,
    role: 'MEMBER',
  },
  {
    id: 'wl-4',
    username: 'Voxel_Architect',
    uuid: 'a12d88e1-55f0-4c12-9001-bc88210fa912',
    avatar: HOTLINKED_IMAGES.avatarVoxel,
    online: true,
    role: 'MEMBER',
  },
];

export const ServerSettingsView: React.FC<ServerSettingsViewProps> = ({
  server,
  onNavigate,
  onShowToast,
}) => {
  const [hasUnsaved, setHasUnsaved] = useState(true);
  const [motdLine1, setMotdLine1] = useState('§6§l⚡ MIO’S SURVIVAL & SMP §8[§b1.20.4§8] §6§l⚡');
  const [motdLine2, setMotdLine2] = useState(
    '§a§lNEW SEASON 4! §7• §dCustom Enchants §7• §eEconomy & Claims'
  );
  const [activeLineInput, setActiveLineInput] = useState<1 | 2>(1);

  // General Settings State
  const [instanceName, setInstanceName] = useState(server.name);
  const [maxPlayers, setMaxPlayers] = useState(server.maxPlayers || 20);
  const [viewDistance, setViewDistance] = useState(12);
  const [simDistance, setSimDistance] = useState(10);
  const [onlineMode, setOnlineMode] = useState('true');

  // Gameplay & World Rules State
  const [gamemode, setGamemode] = useState('survival');
  const [difficulty, setDifficulty] = useState<'Peaceful' | 'Easy' | 'Normal' | 'Hard'>('Hard');
  const [worldSeed, setWorldSeed] = useState('-4918273645192837465');
  const [spawnProtection, setSpawnProtection] = useState(16);
  const [pvpCombat, setPvpCombat] = useState(true);
  const [hardcoreMode, setHardcoreMode] = useState(false);
  const [allowFlight, setAllowFlight] = useState(true);
  const [commandBlocks, setCommandBlocks] = useState(true);

  // Access & Whitelist State
  const [enforceWhitelist, setEnforceWhitelist] = useState(true);
  const [whitelistPlayers, setWhitelistPlayers] = useState<WhitelistedPlayer[]>(INITIAL_WHITELIST);
  const [newPlayerInput, setNewPlayerInput] = useState('');
  const [showAddPlayerInput, setShowAddPlayerInput] = useState(false);

  // Active Section Anchor Highlight
  const [activeSectionTab, setActiveSectionTab] = useState<
    'motd' | 'general' | 'world' | 'whitelist' | 'eula' | 'danger'
  >('motd');

  // Parse basic Minecraft § codes into styled spans for live preview
  const renderMinecraftText = (raw: string) => {
    // If default Line 1 or Line 2 aren't modified, show the rich preview or parse codes
    if (
      raw === '§6§l⚡ MIO’S SURVIVAL & SMP §8[§b1.20.4§8] §6§l⚡'
    ) {
      return (
        <>
          <span className="text-[#FFAA00] font-bold">⚡ MIO’S SURVIVAL &amp; SMP </span>
          <span className="text-[#555555]">[</span>
          <span className="text-[#55FFFF]">1.20.4</span>
          <span className="text-[#555555]">]</span>
          <span className="text-[#FFAA00] font-bold"> ⚡</span>
        </>
      );
    }
    if (raw === '§a§lNEW SEASON 4! §7• §dCustom Enchants §7• §eEconomy & Claims') {
      return (
        <>
          <span className="text-[#55FF55] font-bold">NEW SEASON 4! </span>
          <span className="text-[#AAAAAA]">• </span>
          <span className="text-[#FF55FF]">Custom Enchants </span>
          <span className="text-[#AAAAAA]">• </span>
          <span className="text-[#FFFF55]">Economy &amp; Claims</span>
        </>
      );
    }

    // Dynamic parser for user edits
    const colorMap: Record<string, string> = {
      '0': '#000000',
      '1': '#0000AA',
      '2': '#00AA00',
      '3': '#00AAAA',
      '4': '#AA0000',
      '5': '#AA00AA',
      '6': '#FFAA00',
      '7': '#AAAAAA',
      '8': '#555555',
      '9': '#5555FF',
      a: '#55FF55',
      b: '#55FFFF',
      c: '#FF5555',
      d: '#FF55FF',
      e: '#FFFF55',
      f: '#FFFFFF',
    };

    const segments = raw.split(/(§[0-9a-fk-or])/gi);
    let currentColor = '#AAAAAA';
    let isBold = false;
    let isItalic = false;
    let isUnderline = false;
    let isStrike = false;

    return segments.map((part, idx) => {
      if (part.startsWith('§') && part.length === 2) {
        const code = part[1].toLowerCase();
        if (colorMap[code]) {
          currentColor = colorMap[code];
        } else if (code === 'l') {
          isBold = true;
        } else if (code === 'o') {
          isItalic = true;
        } else if (code === 'n') {
          isUnderline = true;
        } else if (code === 'm') {
          isStrike = true;
        } else if (code === 'r') {
          currentColor = '#AAAAAA';
          isBold = false;
          isItalic = false;
          isUnderline = false;
          isStrike = false;
        }
        return null;
      }
      if (!part) return null;
      return (
        <span
          key={idx}
          style={{
            color: currentColor,
            fontWeight: isBold ? 700 : 400,
            fontStyle: isItalic ? 'italic' : 'normal',
            textDecoration: `${isUnderline ? 'underline ' : ''}${isStrike ? 'line-through' : ''}`.trim(),
          }}
        >
          {part}
        </span>
      );
    });
  };

  const insertCode = (code: string) => {
    setHasUnsaved(true);
    if (activeLineInput === 1) {
      setMotdLine1((prev) => prev + code);
    } else {
      setMotdLine2((prev) => prev + code);
    }
    onShowToast('Format Code Inserted', `Appended ${code} to MOTD Line ${activeLineInput}`, 'info', 'palette');
  };

  const handleRandomizeSeed = () => {
    const randomBig =
      (Math.random() > 0.5 ? '-' : '') +
      Math.floor(1000000000000000000 + Math.random() * 8000000000000000000).toString();
    setWorldSeed(randomBig);
    setHasUnsaved(true);
    onShowToast('World Seed Randomized', `Generated seed: ${randomBig}`, 'info', 'casino');
  };

  const handleSaveAll = () => {
    setHasUnsaved(false);
    onShowToast(
      'Configuration Saved',
      'All changes written to server.properties & whitelist.json.',
      'success',
      'save'
    );
  };

  const handleSaveAndReload = () => {
    setHasUnsaved(false);
    onShowToast(
      'Properties Applied & Reloaded',
      'Broadcasted /paper reload & updated MOTD buffer in 12ms.',
      'success',
      'sync'
    );
  };

  const handleAddWhitelistPlayer = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newPlayerInput.trim()) return;
    const newEntry: WhitelistedPlayer = {
      id: `wl-${Date.now()}`,
      username: newPlayerInput.trim(),
      uuid: `${Math.random().toString(16).slice(2, 10)}-48a1-4099-b811-${Math.random().toString(16).slice(2, 14)}`,
      avatar: HOTLINKED_IMAGES.avatarVoxel,
      online: false,
      role: 'MEMBER',
    };
    setWhitelistPlayers((prev) => [newEntry, ...prev]);
    setNewPlayerInput('');
    setShowAddPlayerInput(false);
    setHasUnsaved(true);
    onShowToast(
      'Player Added to Whitelist',
      `Resolved Mojang UUID for ${newEntry.username}`,
      'success',
      'person_add'
    );
  };

  const togglePlayerRole = (id: string) => {
    setWhitelistPlayers((prev) =>
      prev.map((p) => {
        if (p.id !== id) return p;
        const nextRole =
          p.role === 'MEMBER' ? 'OP LVL 3' : p.role === 'OP LVL 3' ? 'OP LVL 4' : 'MEMBER';
        onShowToast(
          'Operator Level Updated',
          `${p.username} is now ${nextRole}`,
          'info',
          'admin_panel_settings'
        );
        return { ...p, role: nextRole };
      })
    );
    setHasUnsaved(true);
  };

  const removeWhitelistedPlayer = (id: string, name: string) => {
    setWhitelistPlayers((prev) => prev.filter((p) => p.id !== id));
    setHasUnsaved(true);
    onShowToast('Removed from Whitelist', `Revoked access for ${name}`, 'warning', 'person_remove');
  };

  const scrollToBlock = (
    tab: 'motd' | 'general' | 'world' | 'whitelist' | 'eula' | 'danger',
    elementId: string
  ) => {
    setActiveSectionTab(tab);
    const el = document.getElementById(elementId);
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  };

  return (
    <main className="flex-1 flex flex-col bg-surface-dim overflow-hidden">
      {/* Top Contextual Action Bar */}
      <header className="h-16 px-6 bg-surface border-b border-outline-variant/15 flex items-center justify-between shrink-0">
        <div className="flex items-center gap-4">
          <div className="w-10 h-10 rounded-lg bg-primary/10 border border-primary/25 flex items-center justify-center text-primary shadow-inner">
            <span className="material-symbols-outlined text-[22px]">settings</span>
          </div>
          <div>
            <div className="flex items-center gap-2.5">
              <h1 className="text-base font-bold tracking-tight text-on-surface">
                Server Settings &amp; Visual MOTD Editor
              </h1>
              <span className="px-2 py-0.5 text-[10px] font-mono uppercase tracking-wider bg-surface-container-highest text-primary rounded border border-primary/20">
                server.properties
              </span>
              {hasUnsaved ? (
                <span className="px-2 py-0.5 text-[10px] font-mono uppercase tracking-wider bg-primary-gold/10 text-primary-gold rounded border border-primary-gold/20 flex items-center gap-1">
                  <span className="w-1.5 h-1.5 rounded-full bg-primary-gold animate-pulse"></span>
                  2 Unsaved Edits
                </span>
              ) : (
                <span className="px-2 py-0.5 text-[10px] font-mono uppercase tracking-wider bg-secondary/10 text-secondary rounded border border-secondary/20 flex items-center gap-1">
                  <span className="w-1.5 h-1.5 rounded-full bg-secondary"></span>
                  Synced to Disk
                </span>
              )}
            </div>
            <p className="text-xs text-outline font-mono mt-0.5">
              {server.path}\server.properties • Last synced: 4 mins ago
            </p>
          </div>
        </div>
        {/* Primary Global Actions */}
        <div className="flex items-center gap-2.5">
          <button
            onClick={() => onNavigate('files')}
            className="px-3.5 py-2 rounded-lg bg-surface-container-high hover:bg-surface-bright text-xs font-medium text-on-surface border border-outline-variant/20 transition-all flex items-center gap-2 cursor-pointer"
          >
            <span className="material-symbols-outlined text-[16px] text-outline">code</span>
            Open Raw Config
          </button>
          <button
            onClick={() => {
              setMotdLine1('§6§l⚡ MIO’S SURVIVAL & SMP §8[§b1.20.4§8] §6§l⚡');
              setMotdLine2('§a§lNEW SEASON 4! §7• §dCustom Enchants §7• §eEconomy & Claims');
              setMaxPlayers(20);
              setViewDistance(12);
              setSimDistance(10);
              setDifficulty('Hard');
              setHasUnsaved(false);
              onShowToast(
                'Defaults Restored',
                'Reverted all fields to last saved server.properties snapshot.',
                'info',
                'restart_alt'
              );
            }}
            className="px-3.5 py-2 rounded-lg bg-surface-container-high hover:bg-surface-bright text-xs font-medium text-outline hover:text-on-surface border border-outline-variant/20 transition-all flex items-center gap-1.5 cursor-pointer"
          >
            <span className="material-symbols-outlined text-[16px]">restart_alt</span>
            Reset Defaults
          </button>
          <div className="h-5 w-[1px] bg-outline-variant/20 mx-1"></div>
          <button
            onClick={handleSaveAll}
            className="px-4 py-2 rounded-lg bg-primary/15 hover:bg-primary/25 text-xs font-semibold text-primary border border-primary/30 transition-all flex items-center gap-2 cursor-pointer"
          >
            <span className="material-symbols-outlined text-[16px]">save</span>
            Save Changes
          </button>
          <button
            onClick={handleSaveAndReload}
            className="px-4 py-2 rounded-lg bg-gradient-to-r from-primary to-primary-container hover:opacity-95 text-xs font-bold text-on-primary-container shadow-lg shadow-primary/15 transition-all flex items-center gap-2 cursor-pointer"
          >
            <span className="material-symbols-outlined text-[16px]">sync</span>
            Save &amp; Reload Server
          </button>
        </div>
      </header>

      {/* Main Content Workspace: Split Sub-Nav + Scrollable Settings Canvas */}
      <div className="flex-1 flex overflow-hidden">
        {/* Left Settings Sub-Navigation */}
        <div className="w-56 bg-surface border-r border-outline-variant/15 p-3 flex flex-col justify-between shrink-0">
          <div className="space-y-1">
            <div className="px-2.5 py-1.5 text-[10px] font-mono uppercase tracking-widest text-outline/60 font-semibold">
              Configuration Sections
            </div>
            <button
              onClick={() => scrollToBlock('motd', 'sec-motd')}
              className={`w-full flex items-center justify-between px-3 py-2 rounded-lg text-xs transition-all cursor-pointer ${
                activeSectionTab === 'motd'
                  ? 'bg-primary/10 text-primary font-semibold border border-primary/20'
                  : 'text-outline hover:text-on-surface hover:bg-surface-container font-medium'
              }`}
            >
              <span className="flex items-center gap-2.5">
                <span className="material-symbols-outlined text-[17px]">palette</span>
                Identity &amp; MOTD
              </span>
              <span className="w-1.5 h-1.5 rounded-full bg-primary"></span>
            </button>
            <button
              onClick={() => scrollToBlock('general', 'sec-general')}
              className={`w-full flex items-center justify-between px-3 py-2 rounded-lg text-xs transition-all cursor-pointer ${
                activeSectionTab === 'general'
                  ? 'bg-primary/10 text-primary font-semibold border border-primary/20'
                  : 'text-outline hover:text-on-surface hover:bg-surface-container font-medium'
              }`}
            >
              <span className="flex items-center gap-2.5">
                <span className="material-symbols-outlined text-[17px]">tune</span>
                General Settings
              </span>
              <span className="text-[10px] font-mono text-outline/60">8</span>
            </button>
            <button
              onClick={() => scrollToBlock('world', 'sec-world')}
              className={`w-full flex items-center justify-between px-3 py-2 rounded-lg text-xs transition-all cursor-pointer ${
                activeSectionTab === 'world'
                  ? 'bg-primary/10 text-primary font-semibold border border-primary/20'
                  : 'text-outline hover:text-on-surface hover:bg-surface-container font-medium'
              }`}
            >
              <span className="flex items-center gap-2.5">
                <span className="material-symbols-outlined text-[17px]">public</span>
                World &amp; Gameplay
              </span>
              <span className="text-[10px] font-mono text-outline/60">12</span>
            </button>
            <button
              onClick={() => scrollToBlock('whitelist', 'sec-whitelist')}
              className={`w-full flex items-center justify-between px-3 py-2 rounded-lg text-xs transition-all cursor-pointer ${
                activeSectionTab === 'whitelist'
                  ? 'bg-primary/10 text-primary font-semibold border border-primary/20'
                  : 'text-outline hover:text-on-surface hover:bg-surface-container font-medium'
              }`}
            >
              <span className="flex items-center gap-2.5">
                <span className="material-symbols-outlined text-[17px]">verified_user</span>
                Access &amp; Whitelist
              </span>
              <span className="px-1.5 py-0.2 bg-secondary/15 text-secondary rounded text-[10px] font-mono">
                ON
              </span>
            </button>
            <button
              onClick={() => scrollToBlock('eula', 'sec-eula')}
              className={`w-full flex items-center justify-between px-3 py-2 rounded-lg text-xs transition-all cursor-pointer ${
                activeSectionTab === 'eula'
                  ? 'bg-primary/10 text-primary font-semibold border border-primary/20'
                  : 'text-outline hover:text-on-surface hover:bg-surface-container font-medium'
              }`}
            >
              <span className="flex items-center gap-2.5">
                <span className="material-symbols-outlined text-[17px]">gavel</span>
                Mojang EULA
              </span>
              <span className="material-symbols-outlined text-[14px] text-secondary">
                check_circle
              </span>
            </button>
            <div className="pt-2 mt-2 border-t border-outline-variant/15">
              <button
                onClick={() => scrollToBlock('danger', 'sec-danger')}
                className={`w-full flex items-center justify-between px-3 py-2 rounded-lg text-xs transition-all cursor-pointer ${
                  activeSectionTab === 'danger'
                    ? 'bg-error/15 text-error font-semibold border border-error/30'
                    : 'text-error/80 hover:text-error hover:bg-error/10 font-medium'
                }`}
              >
                <span className="flex items-center gap-2.5">
                  <span className="material-symbols-outlined text-[17px]">warning</span>
                  Danger Zone
                </span>
              </button>
            </div>
          </div>

          {/* Fast Property Filter Helper */}
          <div className="p-3 rounded-xl bg-surface-container border border-outline-variant/15 space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-[10px] font-mono uppercase tracking-wider text-outline">
                Validation Engine
              </span>
              <span className="w-2 h-2 rounded-full bg-secondary"></span>
            </div>
            <p className="text-[11px] text-outline leading-relaxed">
              All 54 keys in <span className="text-on-surface font-mono">server.properties</span>{' '}
              pass PaperMC 1.20.4 schema validation.
            </p>
            <div className="pt-1 flex items-center justify-between text-[10px] font-mono text-primary">
              <span>Encoding: UTF-8</span>
              <span>LF</span>
            </div>
          </div>
        </div>

        {/* Scrollable Configuration Canvas */}
        <div className="flex-1 overflow-y-auto p-6 space-y-6">
          {/* SECTION 1: VISUAL MOTD & SERVER ICON STUDIO */}
          <section
            id="sec-motd"
            className="bg-surface rounded-xl border border-outline-variant/15 overflow-hidden shadow-xl"
          >
            <div className="px-5 py-3.5 bg-surface-container border-b border-outline-variant/15 flex items-center justify-between">
              <div className="flex items-center gap-2.5">
                <span className="material-symbols-outlined text-primary text-[19px]">
                  campaign
                </span>
                <h2 className="text-xs font-bold uppercase tracking-wider text-on-surface">
                  Server Identity, Icon &amp; Live MOTD Studio
                </h2>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-[11px] font-mono text-outline">
                  Supports Legacy (§) &amp; MiniMessage Hex
                </span>
                <button
                  onClick={() =>
                    onShowToast(
                      'Preset Gallery Loaded',
                      'Applied "Obsidian Gold Season 4" MOTD template.',
                      'info',
                      'auto_Fix_high'
                    )
                  }
                  className="px-2.5 py-1 rounded bg-surface-container-highest hover:bg-surface-bright text-[11px] font-medium text-primary border border-primary/20 transition-all cursor-pointer"
                >
                  Load Preset
                </button>
              </div>
            </div>

            <div className="p-5 grid grid-cols-12 gap-6 items-start">
              {/* Left 4 Cols: 64x64 Server Icon Manager */}
              <div className="col-span-4 bg-surface-container-low rounded-xl p-4 border border-outline-variant/15 flex flex-col justify-between space-y-4">
                <div className="flex items-start justify-between">
                  <div>
                    <h3 className="text-xs font-bold text-on-surface">Server FavIcon</h3>
                    <p className="text-[11px] text-outline font-mono mt-0.5">
                      server-icon.png (64×64 px)
                    </p>
                  </div>
                  <span className="px-2 py-0.5 rounded text-[10px] font-mono bg-secondary/10 text-secondary border border-secondary/20">
                    Valid PNG
                  </span>
                </div>

                <div className="flex items-center gap-4">
                  <div
                    onClick={() =>
                      onShowToast(
                        'Icon Selector',
                        'Validated 64×64 PNG (4.2 KB) with alpha channel support.',
                        'info',
                        'image'
                      )
                    }
                    className="relative group w-20 h-20 rounded-lg overflow-hidden border-2 border-primary/40 bg-surface-lowest shrink-0 shadow-lg cursor-pointer"
                  >
                    <img
                      alt="64x64 Server Icon"
                      className="w-full h-full object-cover"
                      style={{ imageRendering: 'pixelated' }}
                      src={HOTLINKED_IMAGES.serverIcon64}
                    />
                    <div className="absolute inset-0 bg-surface-lowest/80 opacity-0 group-hover:opacity-100 transition-opacity flex flex-col items-center justify-center text-center p-1">
                      <span className="material-symbols-outlined text-primary text-[20px]">
                        upload
                      </span>
                      <span className="text-[9px] font-mono text-on-surface uppercase mt-0.5">
                        Replace
                      </span>
                    </div>
                  </div>
                  <div className="space-y-2 flex-1">
                    <div className="text-[11px] text-outline leading-snug">
                      Auto-resizes and quantizes uploaded images to strict 64×64 PNG spec.
                    </div>
                    <div className="flex items-center gap-2">
                      <button
                        onClick={() =>
                          onShowToast(
                            'server-icon.png Updated',
                            'Quantized & saved 64x64 PNG to server root directory.',
                            'success',
                            'upload_file'
                          )
                        }
                        className="px-3 py-1.5 rounded-lg bg-primary/15 hover:bg-primary/25 text-primary border border-primary/30 text-[11px] font-semibold transition-all flex items-center gap-1.5 cursor-pointer"
                      >
                        <span className="material-symbols-outlined text-[14px]">upload_file</span>
                        Upload PNG
                      </button>
                      <button
                        onClick={() =>
                          onShowToast(
                            'Icon Cleared',
                            'Reverted to default Minecraft dirt block server icon.',
                            'warning',
                            'delete'
                          )
                        }
                        className="p-1.5 rounded-lg bg-surface-container-highest hover:bg-error/20 text-outline hover:text-error border border-outline-variant/20 transition-all cursor-pointer"
                        title="Remove Icon"
                      >
                        <span className="material-symbols-outlined text-[15px]">delete</span>
                      </button>
                    </div>
                  </div>
                </div>
              </div>

              {/* Right 8 Cols: Live In-Game Multiplayer Server List Preview + Color Toolbar */}
              <div className="col-span-8 space-y-4">
                {/* Authentic Minecraft Multiplayer Server List Preview Box */}
                <div className="space-y-1.5">
                  <div className="flex items-center justify-between">
                    <span className="text-[10px] font-mono uppercase tracking-wider text-outline flex items-center gap-1.5">
                      <span className="w-2 h-2 rounded-full bg-secondary animate-pulse"></span>
                      Live Minecraft Multiplayer Server List Preview (1.20.4 Native Client Simulation)
                    </span>
                    <span className="text-[10px] font-mono text-outline">Ping: 1ms (Localhost)</span>
                  </div>

                  {/* Authentic MC Dirt/Obsidian Dark List Row */}
                  <div
                    className="p-3.5 rounded-xl border-2 border-[#2c3142] shadow-2xl flex items-center gap-4 relative overflow-hidden"
                    style={{
                      backgroundColor: '#11131a',
                      backgroundImage:
                        'radial-gradient(#1e2330 1px, transparent 1px), radial-gradient(#171b26 1px, #0d1017 1px)',
                      backgroundSize: '16px 16px',
                      backgroundPosition: '0 0, 8px 8px',
                    }}
                  >
                    {/* 64x64 Icon inside MC Client List */}
                    <div className="w-16 h-16 rounded border border-white/15 overflow-hidden shrink-0 bg-black relative">
                      <img
                        alt="MC Server Icon"
                        className="w-full h-full object-cover"
                        style={{ imageRendering: 'pixelated' }}
                        src={HOTLINKED_IMAGES.serverIcon64}
                      />
                    </div>

                    {/* Server Title + 2-Line Formatted MOTD */}
                    <div className="flex-1 min-w-0 font-mono">
                      {/* Top Row: Server Name + Player Slots + Ping Bars */}
                      <div className="flex items-center justify-between mb-1">
                        <span className="text-sm font-bold text-white tracking-wide drop-shadow">
                          {instanceName}
                        </span>
                        <div className="flex items-center gap-2.5">
                          <span className="text-xs text-[#AAAAAA] font-mono">
                            {server.playersOnline}
                            <span className="text-[#555555]">/</span>
                            {maxPlayers}
                          </span>
                          {/* MC Signal Bars */}
                          <div
                            className="flex items-end gap-0.5 h-3.5"
                            title="1ms Localhost Ping"
                          >
                            <div className="w-1 h-1.5 bg-[#00FF2A]"></div>
                            <div className="w-1 h-2 bg-[#00FF2A]"></div>
                            <div className="w-1 h-2.5 bg-[#00FF2A]"></div>
                            <div className="w-1 h-3 bg-[#00FF2A]"></div>
                            <div className="w-1 h-3.5 bg-[#00FF2A]"></div>
                          </div>
                        </div>
                      </div>
                      {/* MOTD Line 1 */}
                      <div className="text-[13px] leading-snug tracking-tight truncate">
                        {renderMinecraftText(motdLine1)}
                      </div>
                      {/* MOTD Line 2 */}
                      <div className="text-[13px] leading-snug tracking-tight truncate mt-0.5">
                        {renderMinecraftText(motdLine2)}
                      </div>
                    </div>
                  </div>
                </div>

                {/* Color Palette & Formatting Swatch Bar */}
                <div className="bg-surface-container-low p-3 rounded-xl border border-outline-variant/15 space-y-3">
                  <div className="flex items-center justify-between flex-wrap gap-2">
                    {/* 16 Standard Minecraft Color Swatches */}
                    <div className="flex items-center gap-1.5">
                      <span className="text-[10px] font-mono text-outline uppercase mr-1">
                        Colors:
                      </span>
                      {[
                        { code: '§4', color: '#AA0000', title: '§4 Dark Red' },
                        { code: '§c', color: '#FF5555', title: '§c Red' },
                        { code: '§6', color: '#FFAA00', title: '§6 Gold' },
                        { code: '§e', color: '#FFFF55', title: '§e Yellow' },
                        { code: '§2', color: '#00AA00', title: '§2 Dark Green' },
                        { code: '§a', color: '#55FF55', title: '§a Green' },
                        { code: '§b', color: '#55FFFF', title: '§b Aqua' },
                        { code: '§3', color: '#00AAAA', title: '§3 Dark Aqua' },
                        { code: '§1', color: '#0000AA', title: '§1 Dark Blue' },
                        { code: '§9', color: '#5555FF', title: '§9 Blue' },
                        { code: '§d', color: '#FF55FF', title: '§d Light Purple' },
                        { code: '§5', color: '#AA00AA', title: '§5 Dark Purple' },
                        { code: '§f', color: '#FFFFFF', title: '§f White' },
                        { code: '§7', color: '#AAAAAA', title: '§7 Gray' },
                        { code: '§8', color: '#555555', title: '§8 Dark Gray' },
                      ].map((swatch) => (
                        <button
                          key={swatch.code}
                          onClick={() => insertCode(swatch.code)}
                          className="w-5 h-5 rounded border border-white/20 hover:scale-110 transition-transform cursor-pointer"
                          style={{ backgroundColor: swatch.color }}
                          title={swatch.title}
                        />
                      ))}
                    </div>

                    {/* Formatting Modifiers */}
                    <div className="flex items-center gap-1">
                      <button
                        onClick={() => insertCode('§l')}
                        className="px-2 py-0.5 rounded bg-surface-container-highest hover:bg-surface-bright text-[11px] font-mono font-bold text-on-surface border border-outline-variant/25 cursor-pointer"
                        title="Bold (§l)"
                      >
                        §l Bold
                      </button>
                      <button
                        onClick={() => insertCode('§o')}
                        className="px-2 py-0.5 rounded bg-surface-container-highest hover:bg-surface-bright text-[11px] font-mono italic text-on-surface border border-outline-variant/25 cursor-pointer"
                        title="Italic (§o)"
                      >
                        §o Italic
                      </button>
                      <button
                        onClick={() => insertCode('§n')}
                        className="px-2 py-0.5 rounded bg-surface-container-highest hover:bg-surface-bright text-[11px] font-mono underline text-on-surface border border-outline-variant/25 cursor-pointer"
                        title="Underline (§n)"
                      >
                        §n Under
                      </button>
                      <button
                        onClick={() => insertCode('§m')}
                        className="px-2 py-0.5 rounded bg-surface-container-highest hover:bg-surface-bright text-[11px] font-mono line-through text-on-surface border border-outline-variant/25 cursor-pointer"
                        title="Strikethrough (§m)"
                      >
                        §m Strike
                      </button>
                      <button
                        onClick={() => insertCode('§r')}
                        className="px-2 py-0.5 rounded bg-primary/15 hover:bg-primary/25 text-[11px] font-mono text-primary border border-primary/25 cursor-pointer"
                        title="Reset Formatting (§r)"
                      >
                        §r Reset
                      </button>
                    </div>
                  </div>

                  {/* Two-Line Raw MOTD Code Input */}
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="text-[10px] font-mono text-outline uppercase block mb-1">
                        MOTD Line 1 (Primary Header)
                      </label>
                      <input
                        type="text"
                        value={motdLine1}
                        onFocus={() => setActiveLineInput(1)}
                        onChange={(e) => {
                          setMotdLine1(e.target.value);
                          setHasUnsaved(true);
                        }}
                        className="w-full bg-surface-lowest border border-outline-variant/25 focus:border-primary rounded-lg px-3 py-1.5 text-xs font-mono text-on-surface focus:outline-none"
                      />
                    </div>
                    <div>
                      <label className="text-[10px] font-mono text-outline uppercase block mb-1">
                        MOTD Line 2 (Subtitle / Event Banner)
                      </label>
                      <input
                        type="text"
                        value={motdLine2}
                        onFocus={() => setActiveLineInput(2)}
                        onChange={(e) => {
                          setMotdLine2(e.target.value);
                          setHasUnsaved(true);
                        }}
                        className="w-full bg-surface-lowest border border-outline-variant/25 focus:border-primary rounded-lg px-3 py-1.5 text-xs font-mono text-on-surface focus:outline-none"
                      />
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </section>

          {/* SECTION 2 & 3: GENERAL SETTINGS + WORLD & GAMEPLAY RULES (2-Column Grid) */}
          <div className="grid grid-cols-12 gap-6">
            {/* Left 6 Cols: General & Network Performance Settings */}
            <section
              id="sec-general"
              className="col-span-6 bg-surface rounded-xl border border-outline-variant/15 overflow-hidden shadow-lg flex flex-col justify-between"
            >
              <div>
                <div className="px-5 py-3.5 bg-surface-container border-b border-outline-variant/15 flex items-center justify-between">
                  <div className="flex items-center gap-2.5">
                    <span className="material-symbols-outlined text-primary text-[19px]">tune</span>
                    <h2 className="text-xs font-bold uppercase tracking-wider text-on-surface">
                      General &amp; Distance Parameters
                    </h2>
                  </div>
                  <span className="text-[10px] font-mono text-outline">Core Properties</span>
                </div>

                <div className="p-5 space-y-4">
                  {/* Server Name & Max Players */}
                  <div className="grid grid-cols-12 gap-4">
                    <div className="col-span-8">
                      <div className="flex items-center justify-between mb-1">
                        <label className="text-xs font-semibold text-on-surface">
                          Server Instance Display Name
                        </label>
                        <span className="text-[10px] font-mono text-outline">server-name</span>
                      </div>
                      <input
                        type="text"
                        value={instanceName}
                        onChange={(e) => {
                          setInstanceName(e.target.value);
                          setHasUnsaved(true);
                        }}
                        className="w-full bg-surface-lowest border border-outline-variant/25 focus:border-primary rounded-lg px-3 py-2 text-xs text-on-surface font-medium focus:outline-none"
                      />
                    </div>
                    <div className="col-span-4">
                      <div className="flex items-center justify-between mb-1">
                        <label className="text-xs font-semibold text-on-surface">Max Players</label>
                        <span className="text-[10px] font-mono text-primary">max-players</span>
                      </div>
                      <div className="relative">
                        <input
                          type="number"
                          value={maxPlayers}
                          onChange={(e) => {
                            setMaxPlayers(Number(e.target.value));
                            setHasUnsaved(true);
                          }}
                          className="w-full bg-surface-lowest border border-primary/40 focus:border-primary rounded-lg px-3 py-2 text-xs font-mono text-on-surface focus:outline-none"
                        />
                        <span className="absolute right-2.5 top-2 text-[10px] font-mono text-outline">
                          SLOTS
                        </span>
                      </div>
                    </div>
                  </div>

                  {/* View Distance Slider */}
                  <div className="p-3.5 rounded-xl bg-surface-container-low border border-outline-variant/15 space-y-2">
                    <div className="flex items-center justify-between">
                      <div>
                        <span className="text-xs font-semibold text-on-surface">
                          Chunk View Distance
                        </span>
                        <span className="text-[10px] font-mono text-outline ml-2">
                          (view-distance)
                        </span>
                      </div>
                      <span className="px-2 py-0.5 rounded bg-primary/15 text-primary font-mono text-xs font-bold">
                        {viewDistance} Chunks ({viewDistance * 16}m)
                      </span>
                    </div>
                    <input
                      type="range"
                      min={4}
                      max={32}
                      value={viewDistance}
                      onChange={(e) => {
                        setViewDistance(Number(e.target.value));
                        setHasUnsaved(true);
                      }}
                      className="w-full accent-primary cursor-pointer"
                    />
                    <div className="flex justify-between text-[10px] font-mono text-outline">
                      <span>4 (Potato)</span>
                      <span className="text-secondary">10–12 (PaperMC Optimal)</span>
                      <span>32 (Extreme RAM)</span>
                    </div>
                  </div>

                  {/* Simulation Distance Slider */}
                  <div className="p-3.5 rounded-xl bg-surface-container-low border border-outline-variant/15 space-y-2">
                    <div className="flex items-center justify-between">
                      <div>
                        <span className="text-xs font-semibold text-on-surface">
                          Entity Simulation Distance
                        </span>
                        <span className="text-[10px] font-mono text-outline ml-2">
                          (simulation-distance)
                        </span>
                      </div>
                      <span className="px-2 py-0.5 rounded bg-tertiary/15 text-tertiary font-mono text-xs font-bold">
                        {simDistance} Chunks
                      </span>
                    </div>
                    <input
                      type="range"
                      min={4}
                      max={16}
                      value={simDistance}
                      onChange={(e) => {
                        setSimDistance(Number(e.target.value));
                        setHasUnsaved(true);
                      }}
                      className="w-full accent-tertiary cursor-pointer"
                    />
                    <div className="flex justify-between text-[10px] font-mono text-outline">
                      <span>4 (High TPS)</span>
                      <span>8 (Balanced)</span>
                      <span>16 (Full Redstone/Farms)</span>
                    </div>
                  </div>

                  {/* Online Mode & Proxy Auth */}
                  <div className="grid grid-cols-2 gap-3 pt-1">
                    <div className="p-3 rounded-xl bg-surface-container-low border border-outline-variant/15 flex items-center justify-between">
                      <div>
                        <div className="text-xs font-semibold text-on-surface flex items-center gap-1.5">
                          Mojang Auth
                          <span className="material-symbols-outlined text-[14px] text-secondary">
                            verified
                          </span>
                        </div>
                        <div className="text-[10px] font-mono text-outline">online-mode=true</div>
                      </div>
                      <select
                        value={onlineMode}
                        onChange={(e) => {
                          setOnlineMode(e.target.value);
                          setHasUnsaved(true);
                        }}
                        className="bg-surface-lowest border border-outline-variant/30 rounded-lg px-2.5 py-1.5 text-xs font-mono text-secondary focus:outline-none cursor-pointer"
                      >
                        <option value="true">Premium (True)</option>
                        <option value="velocity">Velocity Proxy</option>
                        <option value="false">Offline / LAN</option>
                      </select>
                    </div>

                    <div className="p-3 rounded-xl bg-surface-container-low border border-outline-variant/15 flex items-center justify-between">
                      <div>
                        <div className="text-xs font-semibold text-on-surface">
                          Network Compression
                        </div>
                        <div className="text-[10px] font-mono text-outline">
                          threshold=256 bytes
                        </div>
                      </div>
                      <span className="px-2 py-1 rounded bg-surface-lowest border border-outline-variant/20 text-xs font-mono text-on-surface">
                        256 B
                      </span>
                    </div>
                  </div>
                </div>
              </div>
            </section>

            {/* Right 6 Cols: World & Gameplay Rules */}
            <section
              id="sec-world"
              className="col-span-6 bg-surface rounded-xl border border-outline-variant/15 overflow-hidden shadow-lg"
            >
              <div className="px-5 py-3.5 bg-surface-container border-b border-outline-variant/15 flex items-center justify-between">
                <div className="flex items-center gap-2.5">
                  <span className="material-symbols-outlined text-tertiary text-[19px]">
                    public
                  </span>
                  <h2 className="text-xs font-bold uppercase tracking-wider text-on-surface">
                    World Generation &amp; Gameplay Rules
                  </h2>
                </div>
                <span className="text-[10px] font-mono text-outline">Dimension: world</span>
              </div>

              <div className="p-5 space-y-4">
                {/* Gamemode & Difficulty Selectors */}
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <div className="flex items-center justify-between mb-1.5">
                      <label className="text-xs font-semibold text-on-surface">
                        Default Gamemode
                      </label>
                      <span className="text-[10px] font-mono text-outline">gamemode</span>
                    </div>
                    <select
                      value={gamemode}
                      onChange={(e) => {
                        setGamemode(e.target.value);
                        setHasUnsaved(true);
                      }}
                      className="w-full bg-surface-lowest border border-outline-variant/25 focus:border-primary rounded-lg px-3 py-2 text-xs font-medium text-on-surface focus:outline-none cursor-pointer"
                    >
                      <option value="survival">⚔️ Survival (Default)</option>
                      <option value="creative">🧱 Creative Mode</option>
                      <option value="adventure">🗺️ Adventure Mode</option>
                      <option value="spectator">👁️ Spectator Mode</option>
                    </select>
                  </div>

                  <div>
                    <div className="flex items-center justify-between mb-1.5">
                      <label className="text-xs font-semibold text-on-surface">
                        World Difficulty
                      </label>
                      <span className="text-[10px] font-mono text-primary">difficulty</span>
                    </div>
                    <div className="grid grid-cols-4 gap-1 bg-surface-lowest p-1 rounded-lg border border-outline-variant/25">
                      {(['Peaceful', 'Easy', 'Normal', 'Hard'] as const).map((diff) => (
                        <button
                          key={diff}
                          onClick={() => {
                            setDifficulty(diff);
                            setHasUnsaved(true);
                          }}
                          className={`py-1 rounded text-[11px] font-medium transition-colors cursor-pointer ${
                            difficulty === diff
                              ? 'bg-primary text-on-primary-container font-bold shadow'
                              : 'text-outline hover:text-on-surface'
                          }`}
                        >
                          {diff}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>

                {/* World Seed & Level Type */}
                <div className="grid grid-cols-12 gap-3">
                  <div className="col-span-8">
                    <div className="flex items-center justify-between mb-1">
                      <label className="text-xs font-semibold text-on-surface">
                        World Generation Seed
                      </label>
                      <span className="text-[10px] font-mono text-outline">level-seed</span>
                    </div>
                    <div className="flex items-center gap-1.5">
                      <input
                        type="text"
                        value={worldSeed}
                        onChange={(e) => {
                          setWorldSeed(e.target.value);
                          setHasUnsaved(true);
                        }}
                        className="w-full bg-surface-lowest border border-outline-variant/25 focus:border-primary rounded-lg px-3 py-1.5 text-xs font-mono text-on-surface focus:outline-none"
                      />
                      <button
                        onClick={handleRandomizeSeed}
                        className="px-2.5 py-1.5 rounded-lg bg-surface-container-highest hover:bg-surface-bright text-outline hover:text-on-surface border border-outline-variant/20 text-xs transition-all cursor-pointer"
                        title="Generate Random Seed"
                      >
                        <span className="material-symbols-outlined text-[15px]">casino</span>
                      </button>
                    </div>
                  </div>
                  <div className="col-span-4">
                    <div className="flex items-center justify-between mb-1">
                      <label className="text-xs font-semibold text-on-surface">
                        Spawn Protect
                      </label>
                      <span className="text-[10px] font-mono text-outline">Radius</span>
                    </div>
                    <input
                      type="number"
                      value={spawnProtection}
                      onChange={(e) => {
                        setSpawnProtection(Number(e.target.value));
                        setHasUnsaved(true);
                      }}
                      className="w-full bg-surface-lowest border border-outline-variant/25 focus:border-primary rounded-lg px-3 py-1.5 text-xs font-mono text-on-surface focus:outline-none"
                    />
                  </div>
                </div>

                {/* 2x2 Gameplay Boolean Toggles */}
                <div className="grid grid-cols-2 gap-3 pt-1">
                  {/* Toggle 1: PVP */}
                  <div
                    onClick={() => {
                      setPvpCombat(!pvpCombat);
                      setHasUnsaved(true);
                    }}
                    className="p-3 rounded-xl bg-surface-container-low border border-outline-variant/15 flex items-center justify-between cursor-pointer hover:border-outline-variant/30 transition-all"
                  >
                    <div>
                      <div className="text-xs font-semibold text-on-surface">PvP Combat</div>
                      <div className="text-[10px] font-mono text-outline">
                        pvp={String(pvpCombat)}
                      </div>
                    </div>
                    <button
                      type="button"
                      className={`w-10 h-5 rounded-full relative transition-colors ${
                        pvpCombat
                          ? 'bg-secondary/25 border border-secondary/50'
                          : 'bg-surface-container-highest border border-outline-variant/30'
                      }`}
                    >
                      <span
                        className={`w-3.5 h-3.5 rounded-full absolute top-0.5 transition-all ${
                          pvpCombat ? 'right-1 bg-secondary shadow' : 'left-1 bg-outline'
                        }`}
                      ></span>
                    </button>
                  </div>

                  {/* Toggle 2: Hardcore */}
                  <div
                    onClick={() => {
                      setHardcoreMode(!hardcoreMode);
                      setHasUnsaved(true);
                    }}
                    className="p-3 rounded-xl bg-surface-container-low border border-outline-variant/15 flex items-center justify-between cursor-pointer hover:border-outline-variant/30 transition-all"
                  >
                    <div>
                      <div className="text-xs font-semibold text-on-surface">
                        Hardcore Permadeath
                      </div>
                      <div className="text-[10px] font-mono text-outline">
                        hardcore={String(hardcoreMode)}
                      </div>
                    </div>
                    <button
                      type="button"
                      className={`w-10 h-5 rounded-full relative transition-colors ${
                        hardcoreMode
                          ? 'bg-error/25 border border-error/50'
                          : 'bg-surface-container-highest border border-outline-variant/30'
                      }`}
                    >
                      <span
                        className={`w-3.5 h-3.5 rounded-full absolute top-0.5 transition-all ${
                          hardcoreMode ? 'right-1 bg-error shadow' : 'left-1 bg-outline'
                        }`}
                      ></span>
                    </button>
                  </div>

                  {/* Toggle 3: Allow Flight */}
                  <div
                    onClick={() => {
                      setAllowFlight(!allowFlight);
                      setHasUnsaved(true);
                    }}
                    className="p-3 rounded-xl bg-surface-container-low border border-outline-variant/15 flex items-center justify-between cursor-pointer hover:border-outline-variant/30 transition-all"
                  >
                    <div>
                      <div className="text-xs font-semibold text-on-surface">
                        Allow Flight / Elytra
                      </div>
                      <div className="text-[10px] font-mono text-outline">
                        allow-flight={String(allowFlight)}
                      </div>
                    </div>
                    <button
                      type="button"
                      className={`w-10 h-5 rounded-full relative transition-colors ${
                        allowFlight
                          ? 'bg-secondary/25 border border-secondary/50'
                          : 'bg-surface-container-highest border border-outline-variant/30'
                      }`}
                    >
                      <span
                        className={`w-3.5 h-3.5 rounded-full absolute top-0.5 transition-all ${
                          allowFlight ? 'right-1 bg-secondary shadow' : 'left-1 bg-outline'
                        }`}
                      ></span>
                    </button>
                  </div>

                  {/* Toggle 4: Command Blocks */}
                  <div
                    onClick={() => {
                      setCommandBlocks(!commandBlocks);
                      setHasUnsaved(true);
                    }}
                    className="p-3 rounded-xl bg-surface-container-low border border-outline-variant/15 flex items-center justify-between cursor-pointer hover:border-outline-variant/30 transition-all"
                  >
                    <div>
                      <div className="text-xs font-semibold text-on-surface">Command Blocks</div>
                      <div className="text-[10px] font-mono text-outline">
                        enable-command-block={String(commandBlocks)}
                      </div>
                    </div>
                    <button
                      type="button"
                      className={`w-10 h-5 rounded-full relative transition-colors ${
                        commandBlocks
                          ? 'bg-secondary/25 border border-secondary/50'
                          : 'bg-surface-container-highest border border-outline-variant/30'
                      }`}
                    >
                      <span
                        className={`w-3.5 h-3.5 rounded-full absolute top-0.5 transition-all ${
                          commandBlocks ? 'right-1 bg-secondary shadow' : 'left-1 bg-outline'
                        }`}
                      ></span>
                    </button>
                  </div>
                </div>
              </div>
            </section>
          </div>

          {/* SECTION 4 & 5: WHITELIST / OPERATORS + EULA & DANGER ZONE */}
          <div className="grid grid-cols-12 gap-6 pb-4">
            {/* Left 7 Cols: Access Control, Whitelist & Server Operators */}
            <section
              id="sec-whitelist"
              className="col-span-7 bg-surface rounded-xl border border-outline-variant/15 overflow-hidden shadow-lg flex flex-col justify-between"
            >
              <div>
                <div className="px-5 py-3.5 bg-surface-container border-b border-outline-variant/15 flex items-center justify-between">
                  <div className="flex items-center gap-2.5">
                    <span className="material-symbols-outlined text-secondary text-[19px]">
                      verified_user
                    </span>
                    <h2 className="text-xs font-bold uppercase tracking-wider text-on-surface">
                      Whitelist &amp; Operator Access Control
                    </h2>
                  </div>
                  <div className="flex items-center gap-3">
                    <button
                      onClick={() => {
                        setEnforceWhitelist(!enforceWhitelist);
                        setHasUnsaved(true);
                      }}
                      className="flex items-center gap-2 text-xs text-outline cursor-pointer"
                    >
                      <span>Enforce Whitelist</span>
                      <span
                        className={`w-8 h-4 rounded-full relative inline-block transition-colors ${
                          enforceWhitelist
                            ? 'bg-secondary/25 border border-secondary/50'
                            : 'bg-surface-container-highest border border-outline-variant/30'
                        }`}
                      >
                        <span
                          className={`w-2.5 h-2.5 rounded-full absolute top-0.5 transition-all ${
                            enforceWhitelist ? 'right-1 bg-secondary' : 'left-1 bg-outline'
                          }`}
                        ></span>
                      </span>
                    </button>
                    <button
                      onClick={() => setShowAddPlayerInput(!showAddPlayerInput)}
                      className="px-2.5 py-1 rounded-lg bg-primary/15 hover:bg-primary/25 text-primary border border-primary/30 text-[11px] font-semibold flex items-center gap-1 cursor-pointer"
                    >
                      <span className="material-symbols-outlined text-[14px]">person_add</span>
                      Add Player
                    </button>
                  </div>
                </div>

                <div className="p-4 space-y-2.5">
                  {showAddPlayerInput && (
                    <form
                      onSubmit={handleAddWhitelistPlayer}
                      className="p-2.5 rounded-lg bg-surface-lowest border border-primary/30 flex items-center gap-2 mb-2"
                    >
                      <input
                        type="text"
                        value={newPlayerInput}
                        onChange={(e) => setNewPlayerInput(e.target.value)}
                        placeholder="Enter Minecraft Username or UUID..."
                        className="flex-1 bg-transparent text-xs font-mono text-on-surface focus:outline-none px-2"
                        autoFocus
                      />
                      <button
                        type="submit"
                        className="px-3 py-1 rounded bg-primary text-on-primary-container text-xs font-bold cursor-pointer"
                      >
                        Authorize
                      </button>
                    </form>
                  )}

                  {whitelistPlayers.map((player) => (
                    <div
                      key={player.id}
                      className="p-2.5 rounded-lg bg-surface-container-low border border-outline-variant/15 flex items-center justify-between"
                    >
                      <div className="flex items-center gap-3">
                        <img
                          alt={player.username}
                          className="w-8 h-8 rounded border border-primary/40 object-cover"
                          src={player.avatar}
                        />
                        <div>
                          <div className="flex items-center gap-2">
                            <span className="text-xs font-bold text-on-surface">
                              {player.username}
                            </span>
                            <span
                              onClick={() => togglePlayerRole(player.id)}
                              title="Click to cycle Operator Level"
                              className={`px-1.5 py-0.2 rounded text-[10px] font-mono cursor-pointer ${
                                player.role === 'OP LVL 4'
                                  ? 'bg-primary-gold/15 text-primary-gold border border-primary-gold/30'
                                  : player.role === 'OP LVL 3'
                                  ? 'bg-primary/15 text-primary border border-primary/30'
                                  : 'bg-surface-container-highest text-outline'
                              }`}
                            >
                              {player.role}
                            </span>
                          </div>
                          <div className="text-[10px] font-mono text-outline">
                            UUID: {player.uuid}
                          </div>
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        <span
                          className={`text-[10px] font-mono flex items-center gap-1 ${
                            player.online ? 'text-secondary' : 'text-outline'
                          }`}
                        >
                          <span
                            className={`w-1.5 h-1.5 rounded-full ${
                              player.online ? 'bg-secondary' : 'bg-outline/40'
                            }`}
                          ></span>
                          {player.online ? 'Online' : 'Offline'}
                        </span>
                        <button
                          onClick={() => removeWhitelistedPlayer(player.id, player.username)}
                          className="p-1.5 rounded hover:bg-error/15 text-outline hover:text-error transition-colors cursor-pointer"
                          title="Revoke Whitelist"
                        >
                          <span className="material-symbols-outlined text-[15px]">
                            person_remove
                          </span>
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              <div className="px-5 py-2.5 bg-surface-container-low border-t border-outline-variant/15 flex items-center justify-between text-[11px] font-mono text-outline">
                <span>
                  whitelist.json: {whitelistPlayers.length} Players • ops.json:{' '}
                  {whitelistPlayers.filter((p) => p.role.startsWith('OP')).length} Operators
                </span>
                <button
                  onClick={() =>
                    onShowToast(
                      'Mojang UUID Cache Synced',
                      'Verified all player profiles against sessionserver.mojang.com.',
                      'success',
                      'sync'
                    )
                  }
                  className="text-primary hover:underline cursor-pointer"
                >
                  Sync UUIDs with Mojang API →
                </button>
              </div>
            </section>

            {/* Right 5 Cols: EULA Compliance & Danger Zone */}
            <div className="col-span-5 flex flex-col gap-6">
              {/* Mojang EULA Card */}
              <section
                id="sec-eula"
                className="bg-surface rounded-xl border border-secondary/25 overflow-hidden shadow-lg p-5 flex items-center justify-between"
              >
                <div className="flex items-start gap-3.5">
                  <div className="w-10 h-10 rounded-lg bg-secondary/15 border border-secondary/30 flex items-center justify-center text-secondary shrink-0">
                    <span className="material-symbols-outlined text-[22px]">gavel</span>
                  </div>
                  <div>
                    <div className="flex items-center gap-2">
                      <h3 className="text-xs font-bold uppercase tracking-wider text-on-surface">
                        Mojang EULA Agreement
                      </h3>
                      <span className="px-2 py-0.5 rounded text-[10px] font-mono bg-secondary/15 text-secondary border border-secondary/30 font-semibold">
                        eula=true
                      </span>
                    </div>
                    <p className="text-[11px] text-outline mt-1 leading-relaxed">
                      Accepted on <span className="text-on-surface font-mono">2025-02-14</span>.
                      Required for PaperMC 1.20.4 startup execution.
                    </p>
                  </div>
                </div>
                <button
                  onClick={() => onNavigate('files')}
                  className="px-3 py-1.5 rounded-lg bg-surface-container-high hover:bg-surface-bright text-[11px] font-mono text-on-surface border border-outline-variant/25 shrink-0 cursor-pointer"
                >
                  View eula.txt
                </button>
              </section>

              {/* Critical Danger Zone Card */}
              <section
                id="sec-danger"
                className="bg-surface rounded-xl border border-error/30 overflow-hidden shadow-lg flex-1 flex flex-col justify-between"
              >
                <div className="px-5 py-3 bg-error/10 border-b border-error/20 flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span className="material-symbols-outlined text-error text-[18px]">
                      warning
                    </span>
                    <h3 className="text-xs font-bold uppercase tracking-wider text-error">
                      Instance Danger Zone
                    </h3>
                  </div>
                  <span className="text-[10px] font-mono text-error/80 uppercase">
                    Irreversible Actions
                  </span>
                </div>

                <div className="p-4 space-y-3">
                  <div className="flex items-center justify-between p-2.5 rounded-lg bg-surface-container-low border border-outline-variant/15">
                    <div>
                      <div className="text-xs font-bold text-on-surface">
                        Reset End &amp; Nether Dimensions
                      </div>
                      <div className="text-[10px] text-outline">
                        Wipes DIM1 &amp; DIM-1 folders while preserving Overworld.
                      </div>
                    </div>
                    <button
                      onClick={() =>
                        onShowToast(
                          'Snapshot Created Before Wipe',
                          'Queued DIM1 & DIM-1 dimension reset for next server restart.',
                          'warning',
                          'restart_alt'
                        )
                      }
                      className="px-3 py-1.5 rounded-lg bg-error/15 hover:bg-error/25 text-error border border-error/30 text-[11px] font-semibold transition-all shrink-0 cursor-pointer"
                    >
                      Wipe Dimensions
                    </button>
                  </div>

                  <div className="flex items-center justify-between p-2.5 rounded-lg bg-surface-container-low border border-outline-variant/15">
                    <div>
                      <div className="text-xs font-bold text-on-surface">
                        Regenerate Entire World
                      </div>
                      <div className="text-[10px] text-outline">
                        Archives current world to Backups and generates fresh seed.
                      </div>
                    </div>
                    <button
                      onClick={() =>
                        onShowToast(
                          'World Archive Queued',
                          'Current world backed up to ZSTD archive; fresh seed queued.',
                          'error',
                          'delete_forever'
                        )
                      }
                      className="px-3 py-1.5 rounded-lg bg-error hover:opacity-90 text-on-error text-[11px] font-bold transition-all shrink-0 shadow shadow-error/20 cursor-pointer"
                    >
                      Regenerate World
                    </button>
                  </div>
                </div>
              </section>
            </div>
          </div>
        </div>
      </div>
    </main>
  );
};
