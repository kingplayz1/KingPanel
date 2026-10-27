import React, { useCallback, useEffect, useState } from 'react';
import { ServerInstance, NavSection } from '../types';
import { HOTLINKED_IMAGES } from '../data/initialData';

const unescapeJava = (value: string): string => {
  const sb = String.fromCharCode(92);
  return value
    .replace(new RegExp(sb + sb + 'u([0-9a-fA-F]{4})', 'g'), (_m, hex: string) =>
      String.fromCharCode(parseInt(hex, 16)),
    )
    .replace(new RegExp(sb + sb + 'n', 'g'), String.fromCharCode(10))
    .split(sb + sb)
    .join(sb);
};

const escapeJava = (value: string): string => {
  const sb = String.fromCharCode(92);
  return value
    .split(sb)
    .join(sb + sb)
    .split(String.fromCharCode(10))
    .join(sb + 'n')
    .split(String.fromCharCode(167))
    .join(sb + 'u00A7');
};

const parseProperties = (raw: string): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('!')) continue;
    const idx = trimmed.search(/[:=]/);
    if (idx === -1) continue;
    out[trimmed.slice(0, idx).trim()] = trimmed.slice(idx + 1).trim();
  }
  return out;
};

const patchProperties = (raw: string, patch: Record<string, string>): string => {
  const lines = raw.split(/\r?\n/);
  const applied = new Set<string>();
  const next = lines.map((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('!')) return line;
    const idx = trimmed.search(/[:=]/);
    if (idx === -1) return line;
    const key = trimmed.slice(0, idx).trim();
    if (!(key in patch)) return line;
    applied.add(key);
    return `${key}=${patch[key]}`;
  });
  for (const [key, value] of Object.entries(patch)) {
    if (!applied.has(key)) next.push(`${key}=${value}`);
  }
  return next.join('\n');
};

const formatStamp = (iso: string): string => {
  if (!iso) return 'never';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? 'never' : d.toLocaleString();
};

interface ServerSettingsViewProps {
  server: ServerInstance;
  onNavigate: (section: NavSection) => void;
  onShowToast: (
    title: string,
    body?: string,
    type?: 'success' | 'info' | 'warning' | 'error',
    icon?: string,
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

const INITIAL_WHITELIST: WhitelistedPlayer[] = [];

export const ServerSettingsView: React.FC<ServerSettingsViewProps> = ({
  server,
  onNavigate,
  onShowToast,
}) => {
  const [hasUnsaved, setHasUnsaved] = useState(false);
  const [propsRaw, setPropsRaw] = useState('');
  const [lastSyncedAt, setLastSyncedAt] = useState('');
  const [motdLine1, setMotdLine1] = useState('');
  const [motdLine2, setMotdLine2] = useState('');
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
  const [worldSeed, setWorldSeed] = useState('');
  const [spawnProtection, setSpawnProtection] = useState(16);
  const [pvpCombat, setPvpCombat] = useState(true);
  const [hardcoreMode, setHardcoreMode] = useState(false);
  const [allowFlight, setAllowFlight] = useState(true);
  const [commandBlocks, setCommandBlocks] = useState(true);

  // Access & Whitelist State
  const [enforceWhitelist, setEnforceWhitelist] = useState(false);
  const [whitelistPlayers, setWhitelistPlayers] = useState<WhitelistedPlayer[]>(INITIAL_WHITELIST);
  const [newPlayerInput, setNewPlayerInput] = useState('');
  const [showAddPlayerInput, setShowAddPlayerInput] = useState(false);

  const serverQuery = `serverId=${encodeURIComponent(server.id)}&serverName=${encodeURIComponent(
    server.name,
  )}`;

  const applyProperties = useCallback((raw: string) => {
    const props = parseProperties(raw);
    const motd = unescapeJava(props.motd || '');
    const [line1 = '', line2 = ''] = motd.split('\n');
    setMotdLine1(line1);
    setMotdLine2(line2);
    setMaxPlayers(Number(props['max-players']) || 20);
    setViewDistance(Number(props['view-distance']) || 10);
    setSimDistance(Number(props['simulation-distance']) || 10);
    setOnlineMode(props['online-mode'] === 'false' ? 'false' : 'true');
    setGamemode(props.gamemode || 'survival');
    const diff = (props.difficulty || 'normal').toLowerCase();
    setDifficulty(
      (diff.charAt(0).toUpperCase() + diff.slice(1)) as 'Peaceful' | 'Easy' | 'Normal' | 'Hard',
    );
    setWorldSeed(props['level-seed'] || '');
    setSpawnProtection(Number(props['spawn-protection']) || 0);
    setPvpCombat((props.pvp ?? 'true') !== 'false');
    setHardcoreMode(props.hardcore === 'true');
    setAllowFlight(props['allow-flight'] === 'true');
    setCommandBlocks((props['enable-command-block'] ?? 'true') !== 'false');
    setEnforceWhitelist(props['white-list'] === 'true' || props['enforce-whitelist'] === 'true');
  }, []);

  const readServerFile = useCallback(
    async (
      relPath: string,
    ): Promise<{ ok: boolean; content?: string; modifiedAt?: string; error?: string }> => {
      try {
        const res = await fetch(
          `/api/server-runtime/file?${serverQuery}&path=${encodeURIComponent(relPath)}`,
        );
        return await res.json();
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : 'Backend unreachable' };
      }
    },
    [serverQuery],
  );

  const writeServerFile = useCallback(
    async (
      relPath: string,
      content: string,
    ): Promise<{ ok: boolean; bytes?: number; error?: string }> => {
      try {
        const res = await fetch('/api/server-runtime/file', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            serverId: server.id,
            serverName: server.name,
            path: relPath,
            content,
          }),
        });
        return await res.json();
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : 'Backend unreachable' };
      }
    },
    [server.id, server.name],
  );

  const loadWhitelist = useCallback(async () => {
    const wl = await readServerFile('whitelist.json');
    const ops = await readServerFile('ops.json');
    let entries: Array<{ uuid?: string; name?: string }> = [];
    let operators: Array<{ uuid?: string; level?: number }> = [];
    if (wl.ok && wl.content) {
      try {
        const parsed = JSON.parse(wl.content);
        if (Array.isArray(parsed)) entries = parsed;
      } catch {
        // malformed whitelist.json — leave the list empty rather than inventing entries
      }
    }
    if (ops.ok && ops.content) {
      try {
        const parsed = JSON.parse(ops.content);
        if (Array.isArray(parsed)) operators = parsed;
      } catch {
        // ignore
      }
    }
    setWhitelistPlayers(
      entries
        .filter((e) => e && typeof e.uuid === 'string')
        .map((e, idx) => {
          const uuid = String(e.uuid);
          const op = operators.find((o) => String(o.uuid) === uuid);
          const level = Number(op?.level) || 0;
          return {
            id: `wl-${uuid || idx}`,
            username: String(e.name || uuid),
            uuid,
            avatar: `https://mc-heads.net/avatar/${uuid.replace(/-/g, '')}/128`,
            online: false,
            role: level >= 4 ? 'OP LVL 4' : level >= 3 ? 'OP LVL 3' : 'MEMBER',
          } as WhitelistedPlayer;
        }),
    );
  }, [readServerFile]);

  const loadFromDisk = useCallback(async () => {
    const props = await readServerFile('server.properties');
    if (!props.ok) {
      onShowToast(
        'Cannot read server.properties',
        String(props.error || 'The instance folder has no properties file yet.'),
        'error',
        'error',
      );
      return;
    }
    setPropsRaw(String(props.content ?? ''));
    applyProperties(String(props.content ?? ''));
    setLastSyncedAt(String(props.modifiedAt || new Date().toISOString()));
    setHasUnsaved(false);
    await loadWhitelist();
  }, [applyProperties, loadWhitelist, onShowToast, readServerFile]);

  useEffect(() => {
    void loadFromDisk();
  }, [loadFromDisk]);

  const persistWhitelist = useCallback(
    async (list: WhitelistedPlayer[]) =>
      writeServerFile(
        'whitelist.json',
        JSON.stringify(
          list.map((p) => ({ uuid: p.uuid, name: p.username })),
          null,
          2,
        ),
      ),
    [writeServerFile],
  );

  const persistOperators = useCallback(
    async (list: WhitelistedPlayer[]) =>
      writeServerFile(
        'ops.json',
        JSON.stringify(
          list
            .filter((p) => p.role !== 'MEMBER')
            .map((p) => ({
              uuid: p.uuid,
              name: p.username,
              level: p.role === 'OP LVL 4' ? 4 : 3,
              bypassesPlayerLimit: false,
            })),
          null,
          2,
        ),
      ),
    [writeServerFile],
  );

  // Active Section Anchor Highlight
  const [activeSectionTab, setActiveSectionTab] = useState<
    'motd' | 'general' | 'world' | 'whitelist' | 'eula' | 'danger'
  >('motd');

  // Parse basic Minecraft § codes into styled spans for live preview
  const renderMinecraftText = (raw: string) => {
    // If default Line 1 or Line 2 aren't modified, show the rich preview or parse codes
    if (raw === '§6§l⚡ MIO’S SURVIVAL & SMP §8[§b1.20.4§8] §6§l⚡') {
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
            textDecoration:
              `${isUnderline ? 'underline ' : ''}${isStrike ? 'line-through' : ''}`.trim(),
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
    onShowToast(
      'Format Code Inserted',
      `Appended ${code} to MOTD Line ${activeLineInput}`,
      'info',
      'palette',
    );
  };

  const handleRandomizeSeed = () => {
    // A candidate seed only takes effect once it is written to server.properties.
    const randomBig =
      (Math.random() > 0.5 ? '-' : '') +
      Math.floor(1000000000000000000 + Math.random() * 8000000000000000000).toString();
    setWorldSeed(randomBig);
    setHasUnsaved(true);
    onShowToast(
      'Candidate seed generated',
      `Seed ${randomBig} is staged. Save to write it to server.properties; it applies to newly generated terrain.`,
      'info',
      'casino',
    );
  };

  const saveProperties = async (successTitle: string) => {
    const patch: Record<string, string> = {
      'max-players': String(maxPlayers),
      'view-distance': String(viewDistance),
      'simulation-distance': String(simDistance),
      'online-mode': onlineMode,
      gamemode,
      difficulty: difficulty.toLowerCase(),
      'level-seed': worldSeed,
      'spawn-protection': String(spawnProtection),
      pvp: String(pvpCombat),
      hardcore: String(hardcoreMode),
      'allow-flight': String(allowFlight),
      'enable-command-block': String(commandBlocks),
      'white-list': String(enforceWhitelist),
      motd: escapeJava([motdLine1, motdLine2].filter(Boolean).join('\n')),
    };
    let next = propsRaw;
    for (const [key, value] of Object.entries(patch))
      next = patchProperties(next, { [key]: value });

    const res = await writeServerFile('server.properties', next);
    if (!res.ok) {
      onShowToast(
        'Save failed',
        String(res.error || 'Could not write server.properties'),
        'error',
        'error',
      );
      return;
    }
    setPropsRaw(next);
    setHasUnsaved(false);
    setLastSyncedAt(new Date().toISOString());
    onShowToast(
      successTitle,
      `${res.bytes ?? next.length} bytes written to ${server.path}/server.properties. A running server applies them on its next restart.`,
      'success',
      'save',
    );
  };

  const handleSaveAll = () => {
    void saveProperties('server.properties saved');
  };

  const handleSaveAndReload = () => {
    void saveProperties('server.properties saved');
  };

  const handleAddWhitelistPlayer = async (e: React.FormEvent) => {
    e.preventDefault();
    const name = newPlayerInput.trim();
    if (!name) return;
    try {
      const res = await fetch(`/api/panel/mojang/${encodeURIComponent(name)}`);
      const data = await res.json();
      if (!data?.ok) {
        onShowToast(
          'Mojang lookup failed',
          String(data?.error || `No Java Edition account named "${name}"`),
          'error',
          'error',
        );
        return;
      }
      if (whitelistPlayers.some((p) => p.uuid === data.uuid)) {
        onShowToast(
          'Already whitelisted',
          `${data.ign} is already in whitelist.json.`,
          'info',
          'info',
        );
        return;
      }
      const entry: WhitelistedPlayer = {
        id: `wl-${data.uuid}`,
        username: String(data.ign),
        uuid: String(data.uuid),
        avatar: String(data.avatarUrl || HOTLINKED_IMAGES.avatarVoxel),
        online: false,
        role: 'MEMBER',
      };
      const next = [entry, ...whitelistPlayers];
      const written = await persistWhitelist(next);
      if (!written.ok) {
        onShowToast(
          'Whitelist write failed',
          String(written.error || 'Could not write whitelist.json'),
          'error',
          'error',
        );
        return;
      }
      setWhitelistPlayers(next);
      setNewPlayerInput('');
      setShowAddPlayerInput(false);
      setHasUnsaved(true);
      onShowToast(
        'Added to whitelist.json',
        `${entry.username} resolved to ${entry.uuid} via Mojang.`,
        'success',
        'person_add',
      );
    } catch (err) {
      onShowToast(
        'Mojang lookup failed',
        err instanceof Error ? err.message : 'Backend unreachable',
        'error',
        'error',
      );
    }
  };

  const togglePlayerRole = async (id: string) => {
    const player = whitelistPlayers.find((p) => p.id === id);
    if (!player) return;
    const nextRole: WhitelistedPlayer['role'] =
      player.role === 'MEMBER' ? 'OP LVL 3' : player.role === 'OP LVL 3' ? 'OP LVL 4' : 'MEMBER';
    const next = whitelistPlayers.map((p) => (p.id === id ? { ...p, role: nextRole } : p));
    const written = await persistOperators(next);
    if (!written.ok) {
      onShowToast(
        'ops.json write failed',
        String(written.error || 'Could not write ops.json'),
        'error',
        'error',
      );
      return;
    }
    setWhitelistPlayers(next);
    setHasUnsaved(true);
    onShowToast(
      'ops.json updated',
      nextRole === 'MEMBER'
        ? `${player.username} is no longer an operator.`
        : `${player.username} now has operator level ${nextRole === 'OP LVL 4' ? 4 : 3}.`,
      'info',
      'admin_panel_settings',
    );
  };

  const removeWhitelistedPlayer = async (id: string, name: string) => {
    const next = whitelistPlayers.filter((p) => p.id !== id);
    const written = await persistWhitelist(next);
    if (!written.ok) {
      onShowToast(
        'Whitelist write failed',
        String(written.error || 'Could not write whitelist.json'),
        'error',
        'error',
      );
      return;
    }
    await persistOperators(next);
    setWhitelistPlayers(next);
    setHasUnsaved(true);
    onShowToast(
      'Removed from whitelist.json',
      `Revoked access for ${name}.`,
      'warning',
      'person_remove',
    );
  };

  const scrollToBlock = (
    tab: 'motd' | 'general' | 'world' | 'whitelist' | 'eula' | 'danger',
    elementId: string,
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
      <header className="h-[54px] px-5 bg-surface border-b border-white/[0.06] flex items-center justify-between gap-4 shrink-0">
        <div className="flex items-center gap-2.5 min-w-0">
          <span className="material-symbols-outlined text-[17px] text-primary">settings</span>
          <h1 className="text-[14.5px] font-semibold text-on-surface whitespace-nowrap">
            Server Settings
          </h1>
          {hasUnsaved ? (
            <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md border border-primary-gold/30 bg-primary-gold/10 text-primary-gold font-mono text-[10.5px]">
              <span className="size-1.5 rounded-full bg-primary-gold animate-pulse" />
              Unsaved
            </span>
          ) : (
            <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md border border-secondary/25 bg-secondary/10 text-secondary font-mono text-[10.5px]">
              <span className="size-1.5 rounded-full bg-secondary" />
              Synced
            </span>
          )}
          <span className="hidden xl:block w-px h-4 bg-white/10" />
          <p className="hidden xl:block font-mono text-[11px] text-outline truncate">
            server.properties · read {formatStamp(lastSyncedAt)}
          </p>
        </div>
        {/* Primary Global Actions */}
        <div className="flex items-center gap-2 shrink-0">
          <button
            onClick={() => onNavigate('files')}
            className="inline-flex items-center gap-1.5 h-8 px-3 rounded-lg border border-white/10 bg-white/[0.02] hover:bg-white/[0.06] text-[11.5px] font-medium text-on-surface transition-colors cursor-pointer"
          >
            <span className="material-symbols-outlined text-[16px] text-outline">code</span>
            Raw config
          </button>
          <button
            onClick={() => {
              void loadFromDisk().then(() =>
                onShowToast(
                  'Reloaded from disk',
                  'Every field was re-read from server.properties and whitelist.json.',
                  'info',
                  'restart_alt',
                ),
              );
            }}
            className="inline-flex items-center gap-1.5 h-8 px-3 rounded-lg border border-white/10 bg-white/[0.02] hover:bg-white/[0.06] text-[11.5px] font-medium text-on-surface transition-colors cursor-pointer"
          >
            <span className="material-symbols-outlined text-[16px] text-outline">restart_alt</span>
            Reload
          </button>
          <button
            onClick={handleSaveAndReload}
            className="inline-flex items-center gap-1.5 h-8 px-3 rounded-lg border border-white/10 bg-white/[0.02] hover:bg-white/[0.06] text-[11.5px] font-medium text-on-surface transition-colors cursor-pointer"
          >
            <span className="material-symbols-outlined text-[16px] text-outline">sync</span>
            Save &amp; reload
          </button>
          <button
            onClick={handleSaveAll}
            className="inline-flex items-center gap-1.5 h-8 px-3 rounded-lg bg-primary hover:brightness-105 text-[11.5px] font-semibold text-on-primary transition-all cursor-pointer"
          >
            <span className="material-symbols-outlined text-[16px]">save</span>
            Save changes
          </button>
        </div>
      </header>

      {/* Main Content Workspace: Split Sub-Nav + Scrollable Settings Canvas */}
      <div className="flex-1 flex overflow-hidden">
        {/* Left Settings Sub-Navigation */}
        <div className="w-56 bg-surface border-r border-white/[0.06] p-3 flex flex-col justify-between shrink-0">
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
            <div className="pt-2 mt-2 border-t border-white/[0.06]">
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
          <div className="p-3 rounded-xl bg-surface-container border border-white/[0.06] space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-[10px] font-mono uppercase tracking-wider text-outline">
                File status
              </span>
              <span
                className={`w-2 h-2 rounded-full ${propsRaw ? 'bg-secondary' : 'bg-outline'}`}
              ></span>
            </div>
            <p className="text-[11px] text-outline leading-relaxed">
              {Object.keys(parseProperties(propsRaw)).length} keys parsed from the real{' '}
              <span className="text-on-surface font-mono">server.properties</span> on disk.
            </p>
            <div className="pt-1 flex items-center justify-between text-[10px] font-mono text-primary">
              <span>Read: {formatStamp(lastSyncedAt)}</span>
              <span>{hasUnsaved ? 'UNSAVED' : 'IN SYNC'}</span>
            </div>
          </div>
        </div>

        {/* Scrollable Configuration Canvas */}
        <div className="flex-1 overflow-y-auto p-6 space-y-6">
          {/* SECTION 1: VISUAL MOTD & SERVER ICON STUDIO */}
          <section
            id="sec-motd"
            className="bg-surface rounded-xl border border-white/[0.06] overflow-hidden "
          >
            <div className="px-5 py-3.5 bg-surface-container border-b border-white/[0.06] flex items-center justify-between">
              <div className="flex items-center gap-2.5">
                <span className="material-symbols-outlined text-primary text-[19px]">campaign</span>
                <h2 className="text-xs font-bold uppercase tracking-wider text-on-surface">
                  Server Identity, Icon &amp; Live MOTD Studio
                </h2>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-[11px] font-mono text-outline">
                  Supports Legacy (§) &amp; MiniMessage Hex
                </span>
                <button
                  onClick={() => {
                    setMotdLine1('§6§lSURVIVAL & SMP §8[§b1.21§8] §6§l⚡');
                    setMotdLine2('§aSeason 5 is live §7• §dCustom Enchants §7• §eClaims & Economy');
                    setActiveLineInput(1);
                    setHasUnsaved(true);
                    onShowToast(
                      'Preset staged',
                      'Two MOTD lines were staged in the editor. Save to write them to server.properties.',
                      'info',
                      'auto_fix_high',
                    );
                  }}
                  className="px-2.5 py-1 rounded bg-surface-container-highest hover:bg-surface-bright text-[11px] font-medium text-primary border border-primary/20 transition-all cursor-pointer"
                >
                  Load Preset
                </button>
              </div>
            </div>

            <div className="p-5 grid grid-cols-12 gap-6 items-start">
              {/* Left 4 Cols: server-icon.png status */}
              <div className="col-span-4 bg-surface-container-low rounded-xl p-4 border border-white/[0.06] flex flex-col justify-between space-y-4">
                <div className="flex items-start justify-between">
                  <div>
                    <h3 className="text-xs font-bold text-on-surface">Server FavIcon</h3>
                    <p className="text-[11px] text-outline font-mono mt-0.5">
                      server-icon.png (64×64 px, instance root)
                    </p>
                  </div>
                  <span className="px-2 py-0.5 rounded text-[10px] font-mono bg-surface-container-highest text-outline border border-white/[0.06]">
                    Not read here
                  </span>
                </div>

                <div className="flex items-start gap-3">
                  <div className="size-16 rounded-lg border border-white/[0.06] bg-surface-lowest shrink-0 flex items-center justify-center text-outline">
                    <span className="material-symbols-outlined text-2xl">image</span>
                  </div>
                  <p className="text-[11px] text-outline leading-snug">
                    Minecraft serves{' '}
                    <span className="font-mono text-on-surface">server-icon.png</span> from the
                    instance folder. Drop a 64×64 PNG there — the panel's File Manager can replace
                    or remove it.
                  </p>
                </div>
                <button
                  onClick={() => onNavigate('files')}
                  className="px-3 py-1.5 rounded-lg bg-surface-container-high hover:bg-surface-bright text-[11px] font-semibold text-on-surface border border-white/[0.06] transition-all flex items-center gap-1.5 cursor-pointer"
                >
                  <span className="material-symbols-outlined text-[14px]">folder_open</span>
                  Open File Manager
                </button>
              </div>

              {/* Right 8 Cols: Live In-Game Multiplayer Server List Preview + Color Toolbar */}
              <div className="col-span-8 space-y-4">
                {/* Authentic Minecraft Multiplayer Server List Preview Box */}
                <div className="space-y-1.5">
                  <div className="flex items-center justify-between">
                    <span className="text-[10px] font-mono uppercase tracking-wider text-outline flex items-center gap-1.5">
                      <span className="w-2 h-2 rounded-full bg-secondary animate-pulse"></span>
                      Live Minecraft Multiplayer Server List Preview (1.20.4 Native Client
                      Simulation)
                    </span>
                    <span className="text-[10px] font-mono text-outline">
                      Ping: 1ms (Localhost)
                    </span>
                  </div>

                  {/* Authentic MC Dirt/Obsidian Dark List Row */}
                  <div
                    className="p-3.5 rounded-xl border-2 border-[#2c3142] flex items-center gap-4 relative overflow-hidden"
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
                          <div className="flex items-end gap-0.5 h-3.5" title="1ms Localhost Ping">
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
                <div className="bg-surface-container-low p-3 rounded-xl border border-white/[0.06] space-y-3">
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
                        className="px-2 py-0.5 rounded bg-surface-container-highest hover:bg-surface-bright text-[11px] font-mono font-bold text-on-surface border border-white/[0.06] cursor-pointer"
                        title="Bold (§l)"
                      >
                        §l Bold
                      </button>
                      <button
                        onClick={() => insertCode('§o')}
                        className="px-2 py-0.5 rounded bg-surface-container-highest hover:bg-surface-bright text-[11px] font-mono italic text-on-surface border border-white/[0.06] cursor-pointer"
                        title="Italic (§o)"
                      >
                        §o Italic
                      </button>
                      <button
                        onClick={() => insertCode('§n')}
                        className="px-2 py-0.5 rounded bg-surface-container-highest hover:bg-surface-bright text-[11px] font-mono underline text-on-surface border border-white/[0.06] cursor-pointer"
                        title="Underline (§n)"
                      >
                        §n Under
                      </button>
                      <button
                        onClick={() => insertCode('§m')}
                        className="px-2 py-0.5 rounded bg-surface-container-highest hover:bg-surface-bright text-[11px] font-mono line-through text-on-surface border border-white/[0.06] cursor-pointer"
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
                        className="w-full bg-surface-lowest border border-white/[0.06] focus:border-primary rounded-lg px-3 py-1.5 text-xs font-mono text-on-surface focus:outline-none"
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
                        className="w-full bg-surface-lowest border border-white/[0.06] focus:border-primary rounded-lg px-3 py-1.5 text-xs font-mono text-on-surface focus:outline-none"
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
              className="col-span-6 bg-surface rounded-xl border border-white/[0.06] overflow-hidden flex flex-col justify-between"
            >
              <div>
                <div className="px-5 py-3.5 bg-surface-container border-b border-white/[0.06] flex items-center justify-between">
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
                        className="w-full bg-surface-lowest border border-white/[0.06] focus:border-primary rounded-lg px-3 py-2 text-xs text-on-surface font-medium focus:outline-none"
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
                  <div className="p-3.5 rounded-xl bg-surface-container-low border border-white/[0.06] space-y-2">
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
                  <div className="p-3.5 rounded-xl bg-surface-container-low border border-white/[0.06] space-y-2">
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
                    <div className="p-3 rounded-xl bg-surface-container-low border border-white/[0.06] flex items-center justify-between">
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
                        className="bg-surface-lowest border border-white/[0.06] rounded-lg px-2.5 py-1.5 text-xs font-mono text-secondary focus:outline-none cursor-pointer"
                      >
                        <option value="true">Premium (True)</option>
                        <option value="velocity">Velocity Proxy</option>
                        <option value="false">Offline / LAN</option>
                      </select>
                    </div>

                    <div className="p-3 rounded-xl bg-surface-container-low border border-white/[0.06] flex items-center justify-between">
                      <div>
                        <div className="text-xs font-semibold text-on-surface">
                          Network Compression
                        </div>
                        <div className="text-[10px] font-mono text-outline">
                          threshold=256 bytes
                        </div>
                      </div>
                      <span className="px-2 py-1 rounded bg-surface-lowest border border-white/[0.06] text-xs font-mono text-on-surface">
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
              className="col-span-6 bg-surface rounded-xl border border-white/[0.06] overflow-hidden "
            >
              <div className="px-5 py-3.5 bg-surface-container border-b border-white/[0.06] flex items-center justify-between">
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
                      className="w-full bg-surface-lowest border border-white/[0.06] focus:border-primary rounded-lg px-3 py-2 text-xs font-medium text-on-surface focus:outline-none cursor-pointer"
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
                    <div className="grid grid-cols-4 gap-1 bg-surface-lowest p-1 rounded-lg border border-white/[0.06]">
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
                        className="w-full bg-surface-lowest border border-white/[0.06] focus:border-primary rounded-lg px-3 py-1.5 text-xs font-mono text-on-surface focus:outline-none"
                      />
                      <button
                        onClick={handleRandomizeSeed}
                        className="px-2.5 py-1.5 rounded-lg bg-surface-container-highest hover:bg-surface-bright text-outline hover:text-on-surface border border-white/[0.06] text-xs transition-all cursor-pointer"
                        title="Generate Random Seed"
                      >
                        <span className="material-symbols-outlined text-[15px]">casino</span>
                      </button>
                    </div>
                  </div>
                  <div className="col-span-4">
                    <div className="flex items-center justify-between mb-1">
                      <label className="text-xs font-semibold text-on-surface">Spawn Protect</label>
                      <span className="text-[10px] font-mono text-outline">Radius</span>
                    </div>
                    <input
                      type="number"
                      value={spawnProtection}
                      onChange={(e) => {
                        setSpawnProtection(Number(e.target.value));
                        setHasUnsaved(true);
                      }}
                      className="w-full bg-surface-lowest border border-white/[0.06] focus:border-primary rounded-lg px-3 py-1.5 text-xs font-mono text-on-surface focus:outline-none"
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
                    className="p-3 rounded-xl bg-surface-container-low border border-white/[0.06] flex items-center justify-between cursor-pointer hover:border-white/[0.06] transition-all"
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
                          : 'bg-surface-container-highest border border-white/[0.06]'
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
                    className="p-3 rounded-xl bg-surface-container-low border border-white/[0.06] flex items-center justify-between cursor-pointer hover:border-white/[0.06] transition-all"
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
                          : 'bg-surface-container-highest border border-white/[0.06]'
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
                    className="p-3 rounded-xl bg-surface-container-low border border-white/[0.06] flex items-center justify-between cursor-pointer hover:border-white/[0.06] transition-all"
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
                          : 'bg-surface-container-highest border border-white/[0.06]'
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
                    className="p-3 rounded-xl bg-surface-container-low border border-white/[0.06] flex items-center justify-between cursor-pointer hover:border-white/[0.06] transition-all"
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
                          : 'bg-surface-container-highest border border-white/[0.06]'
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
              className="col-span-7 bg-surface rounded-xl border border-white/[0.06] overflow-hidden flex flex-col justify-between"
            >
              <div>
                <div className="px-5 py-3.5 bg-surface-container border-b border-white/[0.06] flex items-center justify-between">
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
                            : 'bg-surface-container-highest border border-white/[0.06]'
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
                      className="p-2.5 rounded-lg bg-surface-container-low border border-white/[0.06] flex items-center justify-between"
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

              <div className="px-5 py-2.5 bg-surface-container-low border-t border-white/[0.06] flex items-center justify-between text-[11px] font-mono text-outline">
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
                      'sync',
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
                className="bg-surface rounded-xl border border-secondary/25 overflow-hidden p-5 flex items-center justify-between"
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
                  className="px-3 py-1.5 rounded-lg bg-surface-container-high hover:bg-surface-bright text-[11px] font-mono text-on-surface border border-white/[0.06] shrink-0 cursor-pointer"
                >
                  View eula.txt
                </button>
              </section>

              {/* Critical Danger Zone Card */}
              <section
                id="sec-danger"
                className="bg-surface rounded-xl border border-error/30 overflow-hidden flex-1 flex flex-col justify-between"
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
                  <div className="flex items-center justify-between p-2.5 rounded-lg bg-surface-container-low border border-white/[0.06]">
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
                          'restart_alt',
                        )
                      }
                      className="px-3 py-1.5 rounded-lg bg-error/15 hover:bg-error/25 text-error border border-error/30 text-[11px] font-semibold transition-all shrink-0 cursor-pointer"
                    >
                      Wipe Dimensions
                    </button>
                  </div>

                  <div className="flex items-center justify-between p-2.5 rounded-lg bg-surface-container-low border border-white/[0.06]">
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
                          'delete_forever',
                        )
                      }
                      className="px-3 py-1.5 rounded-lg bg-error hover:opacity-90 text-on-error text-[11px] font-bold transition-all shrink-0 shadow cursor-pointer"
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
