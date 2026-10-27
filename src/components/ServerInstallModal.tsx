import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ServerInstance } from '../types';
import { cancelJob, submitJob, type OperationJob } from '../lib/jobs';
import { LocalDiskFolderPickerModal } from './LocalDiskFolderPickerModal';
import { EulaConsentModal } from './EulaConsentModal';

interface EngineOption {
  id: string;
  label: string;
  note: string;
}

/** Engines the backend can fetch a real server.jar for. */
const ENGINE_OPTIONS: EngineOption[] = [
  { id: 'paper', label: 'PaperMC', note: 'Plugin server · highest performance' },
  { id: 'purpur', label: 'Purpur', note: 'Paper fork · extra gameplay options' },
  { id: 'folia', label: 'Folia', note: 'Multi-threaded Paper fork' },
  { id: 'fabric', label: 'Fabric', note: 'Lightweight modded server' },
  { id: 'vanilla', label: 'Vanilla', note: 'Official Mojang server' },
  { id: 'spigot', label: 'Spigot', note: 'Plugin server · Bukkit API' },
  { id: 'velocity', label: 'Velocity', note: 'Proxy for multiple servers' },
  { id: 'waterfall', label: 'Waterfall', note: 'Proxy · legacy BungeeCord fork' },
];

interface BuildOption {
  build: number | string;
  time?: string;
  channel?: string;
  summary?: string;
  sha256?: string;
  filename?: string;
  downloadUrl?: string;
}

interface ServerInstallModalProps {
  isOpen: boolean;
  defaultRoot: string;
  serverCount: number;
  maxLimit: number;
  isSuperAdmin?: boolean;
  discordVerified?: boolean;
  username?: string;
  onClose: () => void;
  onInstalled: (server: ServerInstance) => void;
  onLimitReached?: (attemptedName: string) => void;
  onShowToast: (
    title: string,
    body?: string,
    type?: 'success' | 'info' | 'warning' | 'error',
    icon?: string,
  ) => void;
}

/**
 * The single server-creation dialog: name, engine → live version → live build
 * fetched from the engine's own API, port/RAM, a real local-PC folder picker,
 * and the Minecraft EULA consent step before anything touches the disk.
 */
export const ServerInstallModal: React.FC<ServerInstallModalProps> = ({
  isOpen,
  defaultRoot,
  serverCount,
  maxLimit,
  isSuperAdmin = false,
  discordVerified = false,
  username = 'Operator',
  onClose,
  onInstalled,
  onLimitReached,
  onShowToast,
}) => {
  const [name, setName] = useState('');
  const [engineId, setEngineId] = useState('paper');
  const [version, setVersion] = useState('');
  const [buildKey, setBuildKey] = useState('');
  const [versions, setVersions] = useState<string[]>([]);
  const [builds, setBuilds] = useState<BuildOption[]>([]);
  const [loadingVersions, setLoadingVersions] = useState(false);
  const [loadingBuilds, setLoadingBuilds] = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [port, setPort] = useState('25565');
  const [ramGb, setRamGb] = useState(4);
  const [maxPlayers, setMaxPlayers] = useState(30);
  const [installRoot, setInstallRoot] = useState(defaultRoot || '');
  const [folderPickerOpen, setFolderPickerOpen] = useState(false);
  const [eulaOpen, setEulaOpen] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [job, setJob] = useState<OperationJob | null>(null);
  const versionRequest = useRef(0);

  const engine = ENGINE_OPTIONS.find((e) => e.id === engineId) || ENGINE_OPTIONS[0];

  const loadBuilds = useCallback(async (id: string, ver: string) => {
    if (!ver) return;
    setLoadingBuilds(true);
    setFetchError(null);
    setBuilds([]);
    setBuildKey('');
    try {
      const res = await fetch(
        `/api/jars/engines/${encodeURIComponent(id)}/${encodeURIComponent(ver)}`,
      );
      const data = await res.json();
      if (!res.ok || !data?.ok) {
        setFetchError(String(data?.error || `No ${id} builds for ${ver}`));
        return;
      }
      const list: BuildOption[] = Array.isArray(data.builds) ? data.builds : [];
      setBuilds(list);
      if (list.length > 0) setBuildKey(String(list[0].build));
    } catch (err) {
      setFetchError(err instanceof Error ? err.message : 'Build lookup failed');
    } finally {
      setLoadingBuilds(false);
    }
  }, []);

  const loadVersions = useCallback(
    async (id: string) => {
      const ticket = ++versionRequest.current;
      setLoadingVersions(true);
      setFetchError(null);
      setVersions([]);
      setVersion('');
      setBuilds([]);
      setBuildKey('');
      try {
        const res = await fetch(`/api/jars/engines/${encodeURIComponent(id)}`);
        const data = await res.json();
        if (ticket !== versionRequest.current) return;
        if (!res.ok || !data?.ok) {
          setFetchError(String(data?.error || `Could not list ${id} versions`));
          return;
        }
        const list: string[] = Array.isArray(data.versions)
          ? data.versions.map((v: unknown) => String(v)).filter(Boolean)
          : [];
        setVersions(list);
        if (list.length > 0) {
          // Selecting a version must also load its builds, otherwise the first
          // open leaves the Build select permanently empty.
          setVersion(list[0]);
          void loadBuilds(id, list[0]);
        }
      } catch (err) {
        if (ticket === versionRequest.current) {
          setFetchError(err instanceof Error ? err.message : 'Version lookup failed');
        }
      } finally {
        if (ticket === versionRequest.current) setLoadingVersions(false);
      }
    },
    [loadBuilds],
  );

  // Reset and start the live engine lookup every time the dialog opens.
  useEffect(() => {
    if (!isOpen) return;
    setName('');
    setEngineId('paper');
    setPort((prev) => prev || '25565');
    setInstallRoot(defaultRoot || '');
    setEulaOpen(false);
    setInstalling(false);
    void loadVersions('paper');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, defaultRoot]);

  const selectedBuild = builds.find((b) => String(b.build) === buildKey) || builds[0];

  const slug = (name.trim() || `Server_${serverCount + 1}`)
    .replace(/[^a-zA-Z0-9_-]/g, '_')
    .replace(/_+/g, '_');
  const cleanRoot = installRoot.trim().replace(/[\\/]+$/, '');
  const sep = cleanRoot.includes('\\') ? '\\' : '/';
  const previewPath = cleanRoot ? `${cleanRoot}${sep}${slug}` : slug;

  const openEula = (e: React.FormEvent) => {
    e.preventDefault();
    if (serverCount >= maxLimit && !isSuperAdmin) {
      onClose();
      onLimitReached?.(name.trim());
      return;
    }
    if (!name.trim()) {
      onShowToast('Server name required', 'Give the instance a name before installing.', 'warning');
      return;
    }
    if (!version) {
      onShowToast(
        'Pick a version',
        'Select the Minecraft version to download the server.jar for.',
        'warning',
      );
      return;
    }
    setEulaOpen(true);
  };

  const runInstall = async () => {
    setInstalling(true);
    setJob(null);
    try {
      // The install runs as a background job on the backend: this call returns a
      // job id immediately and then follows its progress until it finishes.
      const outcome = await submitJob<Record<string, any>>(
        '/api/panel/install-server-instance',
        {
          serverName: name.trim(),
          engine: engine.label,
          version,
          port: Number(port) || 25565,
          ramMaxGb: ramGb,
          installRootDir: cleanRoot,
          acceptEula: true,
          downloadUrl: selectedBuild?.downloadUrl,
          filename: selectedBuild?.filename,
          build: selectedBuild ? String(selectedBuild.build) : '',
          apiSource: engine.note,
        },
        { onProgress: setJob },
      );
      const raw = (outcome.result || {}) as Record<string, any>;
      const data = raw;

      if (outcome.status === 403 || raw?.code === 'DISCORD_VERIFICATION_REQUIRED') {
        setEulaOpen(false);
        onClose();
        onLimitReached?.(name.trim());
        return;
      }
      if (!outcome.ok || !raw?.folderName) {
        setEulaOpen(false);
        const message =
          raw?.code === 'SERVER_BUSY'
            ? raw?.error || 'Another operation is already running for this server.'
            : String(outcome.error || raw?.error || 'Backend refused the install.');
        onShowToast('Installation failed', message, 'error', 'error');
        return;
      }

      const jarInstalled = Boolean(data.jar?.installed);
      const installed: ServerInstance = {
        id: String(data.folderName || slug),
        name: name.trim(),
        engine: `${engine.label} ${version}`.trim(),
        javaVersion: 'Java 21',
        port: Number(data.port) || Number(port) || 25565,
        pid: 0,
        status: 'stopped',
        path: String(data.displayPath || previewPath),
        build: jarInstalled ? `Build ${String(data.jar?.build || selectedBuild?.build || 'latest')}` : 'Jar missing',
        tps: 0,
        tickMs: 0,
        uptime: 'Stopped (Ready to Start)',
        playersOnline: 0,
        maxPlayers,
        cpuUsage: 0,
        cpuTemp: 0,
        ramUsedGb: 0,
        ramMaxGb: ramGb,
      };

      onInstalled(installed);
      onShowToast(
        jarInstalled ? `Installed ${installed.name}` : `${installed.name} created — jar missing`,
        jarInstalled
          ? `${data.jar?.filename || 'server.jar'} (${Math.round(
              (Number(data.jar?.bytes) || 0) / 1024 / 1024,
            )} MB) written to ${installed.path}` +
              (data.jar?.build ? ` · build ${data.jar.build}` : '')
          : String(data.jar?.error || 'Use Startup → Reinstall to fetch the jar again.'),
        jarInstalled ? 'success' : 'warning',
        jarInstalled ? 'download_done' : 'warning',
      );
      setEulaOpen(false);
      setName('');
      onClose();
    } catch (err) {
      setEulaOpen(false);
      onShowToast(
        'Installation failed',
        err instanceof Error ? err.message : 'Backend unreachable',
        'error',
        'error',
      );
    } finally {
      setInstalling(false);
    }
  };

  if (!isOpen) return null;

  return (
    <>
      <div
        className="fixed inset-0 z-50 bg-black/80 backdrop-blur-md flex items-center justify-center p-4 overflow-y-auto"
        onClick={() => !installing && onClose()}
      >
        <div
          className="w-full max-w-2xl rounded-xl bg-surface border border-white/15 overflow-hidden my-6"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="px-5 py-4 border-b border-white/[0.08] bg-surface-container flex items-start justify-between gap-3">
            <div className="flex items-start gap-3 min-w-0">
              <div className="size-9 rounded-lg bg-primary/15 border border-primary/35 flex items-center justify-center text-primary shrink-0">
                <span className="material-symbols-outlined text-[20px]">add_box</span>
              </div>
              <div className="min-w-0">
                <h3 className="text-sm font-bold text-white">Install a new server</h3>
                <p className="text-[11px] text-outline">
                  {serversSummary(serverCount, maxLimit)} · jar downloads from the engine's own API
                </p>
              </div>
            </div>
            <button
              type="button"
              onClick={onClose}
              disabled={installing}
              className="p-1 rounded-lg bg-white/5 hover:bg-white/10 text-outline hover:text-white cursor-pointer disabled:opacity-40"
            >
              <span className="material-symbols-outlined text-[18px]">close</span>
            </button>
          </div>

          <form onSubmit={openEula} className="p-5 space-y-4">
            <div>
              <label className="kp-label block mb-1">Server name</label>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={`Survival Server #${serverCount + 1}`}
                autoFocus
                className="w-full bg-surface-lowest border border-white/15 focus:border-primary rounded-lg px-3 py-2 text-xs text-white focus:outline-none"
              />
            </div>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
              <div>
                <label className="kp-label block mb-1">Engine</label>
                <select
                  value={engineId}
                  onChange={(e) => {
                    setEngineId(e.target.value);
                    void loadVersions(e.target.value);
                  }}
                  className="w-full bg-surface-lowest border border-white/15 focus:border-primary rounded-lg px-3 py-2 text-xs text-white focus:outline-none cursor-pointer"
                >
                  {ENGINE_OPTIONS.map((opt) => (
                    <option key={opt.id} value={opt.id}>
                      {opt.label}
                    </option>
                  ))}
                </select>
                <p className="text-[10px] text-outline mt-1 truncate">{engine.note}</p>
              </div>

              <div>
                <label className="kp-label block mb-1">
                  Version{' '}
                  {loadingVersions && (
                    <span className="text-primary normal-case font-normal">· fetching…</span>
                  )}
                </label>
                <select
                  value={version}
                  onChange={(e) => {
                    setVersion(e.target.value);
                    void loadBuilds(engineId, e.target.value);
                  }}
                  disabled={loadingVersions || versions.length === 0}
                  className="w-full bg-surface-lowest border border-white/15 focus:border-primary rounded-lg px-3 py-2 text-xs font-mono text-white focus:outline-none cursor-pointer disabled:opacity-50"
                >
                  {versions.length === 0 && <option value="">No versions</option>}
                  {versions.map((v) => (
                    <option key={v} value={v}>
                      {v}
                    </option>
                  ))}
                </select>
                <p className="text-[10px] text-outline mt-1">
                  {versions.length > 0 ? `${versions.length} releases` : 'live from engine API'}
                </p>
              </div>

              <div>
                <label className="kp-label block mb-1">
                  Build{' '}
                  {loadingBuilds && (
                    <span className="text-primary normal-case font-normal">· fetching…</span>
                  )}
                </label>
                <select
                  value={buildKey}
                  onChange={(e) => setBuildKey(e.target.value)}
                  disabled={loadingBuilds || builds.length === 0}
                  className="w-full bg-surface-lowest border border-white/15 focus:border-primary rounded-lg px-3 py-2 text-xs font-mono text-white focus:outline-none cursor-pointer disabled:opacity-50"
                >
                  {builds.length === 0 && <option value="">No builds</option>}
                  {builds.map((b) => (
                    <option key={String(b.build)} value={String(b.build)}>
                      #{b.build} · {b.channel || 'release'}
                    </option>
                  ))}
                </select>
                <p className="text-[10px] text-outline mt-1 truncate" title={selectedBuild?.filename}>
                  {selectedBuild?.filename || 'latest available'}
                </p>
              </div>
            </div>

            {fetchError && (
              <div className="rounded-lg border border-error/30 bg-error/10 px-3 py-2 text-[11px] text-error">
                {fetchError}
              </div>
            )}

            <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
              <div>
                <label className="kp-label block mb-1">Port</label>
                <input
                  type="number"
                  value={port}
                  onChange={(e) => setPort(e.target.value)}
                  className="w-full bg-surface-lowest border border-white/15 focus:border-primary rounded-lg px-3 py-2 text-xs font-mono text-primary focus:outline-none"
                />
              </div>
              <div>
                <label className="kp-label block mb-1">RAM</label>
                <select
                  value={ramGb}
                  onChange={(e) => setRamGb(Number(e.target.value))}
                  className="w-full bg-surface-lowest border border-white/15 focus:border-primary rounded-lg px-3 py-2 text-xs font-mono text-white focus:outline-none cursor-pointer"
                >
                  {[2, 4, 6, 8, 12, 16].map((gb) => (
                    <option key={gb} value={gb}>
                      {gb} GB
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="kp-label block mb-1">Slots</label>
                <input
                  type="number"
                  min={1}
                  max={500}
                  value={maxPlayers}
                  onChange={(e) => setMaxPlayers(Number(e.target.value))}
                  className="w-full bg-surface-lowest border border-white/15 focus:border-primary rounded-lg px-3 py-2 text-xs font-mono text-white focus:outline-none"
                />
              </div>
            </div>

            <div className="space-y-2">
              <div className="flex items-center justify-between gap-2">
                <label className="kp-label">Install folder (this PC)</label>
                <button
                  type="button"
                  onClick={() => setFolderPickerOpen(true)}
                  className="inline-flex items-center gap-1.5 px-2.5 h-7 rounded-lg bg-primary/15 hover:bg-primary/25 border border-primary/40 text-primary text-[11px] font-bold cursor-pointer"
                >
                  <span className="material-symbols-outlined text-[14px]">folder_open</span>
                  Browse PC…
                </button>
              </div>
              <input
                type="text"
                value={installRoot}
                onChange={(e) => setInstallRoot(e.target.value)}
                placeholder="D:\KingServers"
                className="w-full bg-surface-lowest border border-white/15 focus:border-primary rounded-lg px-3 py-2 text-xs font-mono text-white focus:outline-none"
              />
              <div className="rounded-lg bg-surface-lowest border border-white/[0.08] px-3 py-2 text-[11px] font-mono text-outline truncate">
                Server folder: <span className="text-primary">{previewPath}</span>
                <span className="text-outline/70"> · server.jar + plugins/ + mods/ inside</span>
              </div>
            </div>

            <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
              <p className="text-[11px] text-outline flex items-center gap-1.5">
                <span className="material-symbols-outlined text-[14px] text-primary">verified_user</span>
                You'll be asked to accept the Minecraft EULA before install.
              </p>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={onClose}
                  className="px-4 h-9 rounded-lg bg-white/5 hover:bg-white/10 text-xs font-medium text-outline hover:text-white cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={loadingVersions || loadingBuilds}
                  className="px-4 h-9 rounded-lg bg-primary hover:opacity-95 text-on-primary-container text-xs font-bold flex items-center gap-1.5 cursor-pointer disabled:opacity-50"
                >
                  <span className="material-symbols-outlined text-[16px]">download</span>
                  Continue to EULA
                </button>
              </div>
            </div>
          </form>
        </div>
      </div>

      <LocalDiskFolderPickerModal
        isOpen={folderPickerOpen}
        initialPath={installRoot || defaultRoot}
        title="Choose the folder this server installs into"
        onClose={() => setFolderPickerOpen(false)}
        onSelectFolder={(picked) => setInstallRoot(picked)}
      />

      <EulaConsentModal
        isOpen={eulaOpen}
        serverName={name.trim()}
        busy={installing}
        job={job}
        onCancel={() => {
          if (job) void cancelJob(job.id);
        }}
        onAccept={() => void runInstall()}
        onDecline={() => {
          if (installing) return;
          setEulaOpen(false);
          onShowToast(
            'Install cancelled',
            'The Minecraft EULA was not accepted, so no server was created.',
            'warning',
            'block',
          );
        }}
      />
    </>
  );
};

const serversSummary = (count: number, max: number): string =>
  max >= 999 ? `${count} servers installed` : `${count} of ${max} servers used`;

export default ServerInstallModal;
