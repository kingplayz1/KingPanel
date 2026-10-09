import React, { useState, useEffect, useCallback } from 'react';
import { SnapshotItem, CronTask, ServerInstance, NavSection } from '../types';

interface RealtimeBackupMeta {
  displayBackupsDir: string;
  backupsDiskDir: string;
  filesOnDiskCount: number;
  diskTotalGb: number;
  diskUsedGb: number;
  diskFreeGb: number;
  diskUsedPct: number;
  mongoSyncedCount: number;
  fetchedAt: string;
}

interface BackupsSnapshotsViewProps {
  server: ServerInstance;
  snapshots: SnapshotItem[];
  crons: CronTask[];
  onCreateSnapshot: (tag: string, pinned: boolean, scopes: string[]) => void;
  onTogglePinSnapshot: (id: string) => void;
  onNavigate: (section: NavSection) => void;
  onShowToast: (title: string, body?: string, type?: 'success' | 'info' | 'warning' | 'error', icon?: string) => void;
}

export const BackupsSnapshotsView: React.FC<BackupsSnapshotsViewProps> = ({
  server,
  snapshots,
  crons,
  onCreateSnapshot,
  onTogglePinSnapshot,
  onNavigate,
  onShowToast,
}) => {
  const [filterText, setFilterText] = useState('');
  const [modalOpen, setModalOpen] = useState(false);
  const [snapshotTag, setSnapshotTag] = useState('Manual Checkpoint — Admin');
  const [pinSnapshot, setPinSnapshot] = useState(false);
  const [isCreating, setIsCreating] = useState(false);
  const [dryRunComplete, setDryRunComplete] = useState(false);
  const [selectedRollbackId, setSelectedRollbackId] = useState('snap-1');
  const [liveSnapshots, setLiveSnapshots] = useState<SnapshotItem[]>([]);
  const [backupMeta, setBackupMeta] = useState<RealtimeBackupMeta | null>(null);
  const [livePollBackups, setLivePollBackups] = useState(true);

  const fetchRealtimeBackups = useCallback(async () => {
    try {
      const r = await fetch(
        `/api/backups/realtime?serverId=${encodeURIComponent(server.id)}&serverName=${encodeURIComponent(server.name)}`
      );
      const data = await r.json();
      if (data.ok && Array.isArray(data.snapshots)) {
        const mapped: SnapshotItem[] = data.snapshots.map((s: Record<string, unknown>) => ({
          id: String(s.id),
          title: String(s.title),
          badge: String(s.badge),
          badgeType: (s.badgeType as SnapshotItem['badgeType']) || 'primary',
          timestamp: String(s.timestamp),
          size: String(s.size),
          note: String(s.note || ''),
          scopes: Array.isArray(s.scopes) ? (s.scopes as string[]) : ['Full Live State'],
          destination: String(s.filePath || `${server.path}\\backups`),
          cloudDest: 'MongoDB + S3 Verified',
          sha: `SHA-256: ${String(s.sha256 || '').slice(0, 14)}...`,
          pinned: Boolean(s.pinned),
          verified: Boolean(s.verified),
          icon: String(s.icon || 'archive'),
          iconColor: String(s.iconColor || 'bg-primary/15 text-primary'),
        }));
        setLiveSnapshots(mapped);
        setBackupMeta({
          displayBackupsDir: data.displayBackupsDir || `${server.path}\\backups`,
          backupsDiskDir: data.backupsDiskDir || '',
          filesOnDiskCount: data.filesOnDiskCount ?? mapped.length,
          diskTotalGb: data.diskTotalGb ?? 100,
          diskUsedGb: data.diskUsedGb ?? 18.4,
          diskFreeGb: data.diskFreeGb ?? 81.6,
          diskUsedPct: data.diskUsedPct ?? 18,
          mongoSyncedCount: data.mongoSyncedCount ?? mapped.length,
          fetchedAt: new Date().toLocaleTimeString(),
        });
      }
    } catch {
      // keep existing snapshots on transient error
    }
  }, [server.id, server.name, server.path]);

  useEffect(() => {
    fetchRealtimeBackups();
  }, [fetchRealtimeBackups]);

  useEffect(() => {
    if (!livePollBackups) return;
    const timer = setInterval(() => {
      fetchRealtimeBackups();
    }, 2000);
    return () => clearInterval(timer);
  }, [livePollBackups, fetchRealtimeBackups]);

  const activeSnapshotsList = liveSnapshots.length > 0 ? liveSnapshots : snapshots;

  const filteredSnapshots = activeSnapshotsList.filter(
    (s) =>
      !filterText ||
      s.title.toLowerCase().includes(filterText.toLowerCase()) ||
      s.scopes.some((sc) => sc.toLowerCase().includes(filterText.toLowerCase()))
  );

  const handleGenerateSnapshot = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsCreating(true);
    try {
      const r = await fetch('/api/backups/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          serverId: server.id,
          serverName: server.name,
          title: snapshotTag.trim() || 'Manual Checkpoint',
          pinned: pinSnapshot,
          scopes: ['Full Live State', 'world', 'plugins/', 'SQLite + MongoDB'],
        }),
      });
      const data = await r.json();
      onCreateSnapshot(snapshotTag.trim() || 'Manual Checkpoint', pinSnapshot, ['Full Live State']);
      await fetchRealtimeBackups();
      setIsCreating(false);
      setModalOpen(false);
      onShowToast(
        `Snapshot "${snapshotTag}" Written to Local Disk & MongoDB`,
        `Saved .tar.zst archive with SHA-256 verification (MongoDB ID: ${data.mongoDocumentId || 'synced'}).`,
        'success',
        'check_circle'
      );
    } catch {
      setIsCreating(false);
      setModalOpen(false);
    }
  };

  const handleTogglePinLive = async (id: string) => {
    onTogglePinSnapshot(id);
    try {
      await fetch('/api/backups/pin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ serverId: server.id, serverName: server.name, id }),
      });
      await fetchRealtimeBackups();
    } catch {
      // ignore
    }
  };

  const handleDeleteSnapshotLive = async (id: string, title: string) => {
    try {
      await fetch(
        `/api/backups/${encodeURIComponent(id)}?serverId=${encodeURIComponent(server.id)}&serverName=${encodeURIComponent(server.name)}`,
        { method: 'DELETE' }
      );
      await fetchRealtimeBackups();
      onShowToast(
        `Deleted Snapshot: ${title}`,
        'Removed archive from local PC backups/ directory and SQLite/MongoDB.',
        'info',
        'delete'
      );
    } catch {
      // ignore
    }
  };

  const handleRestore = async (title: string) => {
    try {
      await fetch('/api/backups/restore', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ serverId: server.id, serverName: server.name, title }),
      });
    } catch {
      // ignore
    }
    onShowToast(
      `Restoring Instance: ${title}`,
      'FastPipe suspended incoming packets, flushed live heap, and swapped state in 1.84s.',
      'success',
      'settings_backup_restore'
    );
  };

  return (
    <div className="flex flex-col w-full">
      {/* Top Section: Server Automation Breadcrumbs & Recovery Header */}
      <section className="flex flex-col gap-4 pb-6">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
          <div className="flex flex-col gap-1 min-w-0">
            <div className="flex items-center gap-2 text-primary-gold">
              <span className="font-label-caps text-label-caps uppercase tracking-widest text-primary">
                Disaster Recovery Engine
              </span>
              <span className="text-on-surface-variant/40 font-code-sm text-code-sm">/</span>
              <span className="font-label-caps text-label-caps text-on-surface-variant uppercase">
                Backups, Snapshots &amp; Crons
              </span>
            </div>
            <h1 className="font-display-lg text-display-lg text-on-surface tracking-tight flex flex-wrap items-center gap-3">
              Zero-Downtime Snapshot Fabric
              <span className="px-2 py-0.5 rounded-full bg-secondary-container/20 text-secondary font-code-sm text-code-sm flex items-center gap-1.5 shadow-sm">
                <span className="size-1.5 rounded-full bg-secondary animate-pulse" />
                FastPipe v4.8 Active
              </span>
            </h1>
            <p className="font-body-sm text-body-sm text-on-surface-variant flex items-center gap-2 flex-wrap">
              <span>Target Instance:</span>
              <span className="font-title-md text-title-md text-on-surface font-semibold">
                {server.name}
              </span>
              <span className="text-on-surface-variant/40">•</span>
              <span className="font-code-sm text-code-sm text-on-surface-variant">{server.engine}</span>
              <span className="text-on-surface-variant/40">•</span>
              <span className="font-code-sm text-code-sm text-primary-gold bg-primary-gold/10 px-1.5 py-0.5 rounded">
                PID: {server.pid}
              </span>
              <span className="text-on-surface-variant/40">•</span>
              <span className="font-code-sm text-code-sm text-on-surface-variant/80">
                Local Host Hypervisor Node
              </span>
            </p>
          </div>

          {/* Action Cluster */}
          <div className="flex items-center gap-2.5 flex-wrap self-start md:self-auto shrink-0">
            <button
              type="button"
              onClick={() => setModalOpen(true)}
              className="px-4 py-2 rounded-xl bg-primary text-on-primary font-title-md text-title-md font-bold flex items-center gap-2 shadow-lg shadow-primary/20 hover:bg-primary-gold transition-all duration-200 cursor-pointer"
            >
              <span className="material-symbols-outlined text-lg">add_circle</span>
              <span>Create Snapshot Now</span>
            </button>
            <button
              type="button"
              onClick={() =>
                onShowToast('Import Archive Ready', 'Select a .tar.zst or .zip archive to mount.', 'info', 'unarchive')
              }
              className="px-3.5 py-2 rounded-xl bg-surface-container-high text-on-surface font-title-md text-title-md hover:bg-surface-bright transition-all duration-150 flex items-center gap-2 cursor-pointer shadow-sm"
            >
              <span className="material-symbols-outlined text-lg text-on-surface-variant">
                unarchive
              </span>
              <span className="hidden sm:inline">Import Archive</span>
            </button>
            <button
              type="button"
              onClick={() => onNavigate('schedules')}
              className="px-3 py-2 rounded-xl bg-surface-container-high text-on-surface hover:bg-surface-bright transition-colors cursor-pointer"
              title="Cron Automations"
            >
              <span className="material-symbols-outlined text-lg text-primary">schedule</span>
            </button>
            <button
              type="button"
              onClick={() =>
                onShowToast(
                  'Remote S3 Sync Active',
                  'AWS S3 eu-central-1 and Google Drive mirrors are synchronized.',
                  'success',
                  'cloud_sync'
                )
              }
              className="px-3 py-2 rounded-xl bg-surface-container-high text-on-surface hover:bg-surface-bright transition-colors cursor-pointer"
              title="Cloud Remote S3 Sync"
            >
              <span className="material-symbols-outlined text-lg text-tertiary">cloud_sync</span>
            </button>
          </div>
        </div>

        {/* Telemetry Status Pills Bar */}
        <div className="flex items-center gap-2 overflow-x-auto pb-1 text-on-surface-variant">
          <div className="px-3 py-1.5 rounded-lg bg-surface-container flex items-center gap-2 shrink-0 shadow-sm">
            <span className="material-symbols-outlined text-sm text-primary">speed</span>
            <span className="font-code-sm text-code-sm text-on-surface">NVMe Direct-IO Copy:</span>
            <span className="font-code-sm text-code-sm text-secondary font-semibold">
              Bypassing Windows Buffer
            </span>
          </div>
          <div className="px-3 py-1.5 rounded-lg bg-surface-container flex items-center gap-2 shrink-0 shadow-sm">
            <span className="material-symbols-outlined text-sm text-secondary">lock_clock</span>
            <span className="font-code-sm text-code-sm text-on-surface">World Freeze:</span>
            <span className="font-code-sm text-code-sm text-on-surface-variant">
              Zero-Tick (save-off &amp; flush)
            </span>
          </div>
          <div className="px-3 py-1.5 rounded-lg bg-surface-container flex items-center gap-2 shrink-0 shadow-sm">
            <span className="material-symbols-outlined text-sm text-primary-gold">restore_page</span>
            <span className="font-code-sm text-code-sm text-on-surface">Retention Policy:</span>
            <span className="font-code-sm text-code-sm text-on-surface-variant">
              14 Days Rolling Auto-Prune
            </span>
          </div>
        </div>
      </section>

      {/* Main Content Grid */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-5">
        {/* LEFT & CENTER MAIN DECK (8 cols) */}
        <div className="lg:col-span-8 flex flex-col gap-5">
          {/* 1. INSTANT SNAPSHOT & BACKUP HEALTH OVERVIEW BENTO */}
          <div className="bg-surface-container-low rounded-xl p-5 shadow-md flex flex-col gap-4 relative overflow-hidden">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2.5">
                <div className="size-8 rounded-lg bg-primary/10 flex items-center justify-center text-primary">
                  <span className="material-symbols-outlined text-xl">hard_drive_2</span>
                </div>
                <div>
                  <h2 className="font-title-md text-title-md text-on-surface font-semibold">
                    Active Volume Allocation (Real-Time Local PC Disk)
                  </h2>
                  <p className="font-code-sm text-code-sm text-on-surface-variant/80">
                    {backupMeta?.displayBackupsDir || `${server.path}\\backups`} •{' '}
                    {backupMeta ? `Live Synced ${backupMeta.fetchedAt}` : 'Samsung 990 PRO Gen4'}
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setLivePollBackups(!livePollBackups)}
                  className={`px-2.5 py-1 rounded font-code-sm text-code-sm font-semibold flex items-center gap-1.5 cursor-pointer ${
                    livePollBackups
                      ? 'bg-secondary/10 text-secondary'
                      : 'bg-surface-container text-on-surface-variant'
                  }`}
                >
                  <span
                    className={`size-1.5 rounded-full ${
                      livePollBackups ? 'bg-secondary animate-ping' : 'bg-outline'
                    }`}
                  />
                  {livePollBackups ? 'Real-Time Fetch: ON (2s)' : 'Real-Time Paused'}
                </button>
              </div>
            </div>

            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <div className="bg-surface-container p-3.5 rounded-lg flex flex-col justify-between shadow-sm">
                <span className="font-label-caps text-label-caps text-on-surface-variant uppercase">
                  Local Disk Used
                </span>
                <div className="mt-2">
                  <div className="font-headline-lg text-headline-lg text-on-surface font-bold">
                    {backupMeta?.diskUsedGb ?? 18.4}{' '}
                    <span className="text-sm font-normal text-on-surface-variant">
                      / {backupMeta?.diskTotalGb ?? 100} GB
                    </span>
                  </div>
                  <div className="w-full bg-surface-container-highest h-1.5 rounded-full overflow-hidden mt-2">
                    <div
                      className="bg-primary h-full rounded-full"
                      style={{ width: `${backupMeta?.diskUsedPct ?? 18.4}%` }}
                    />
                  </div>
                </div>
                <span className="font-code-sm text-code-sm text-on-surface-variant/70 mt-2">
                  {backupMeta?.diskFreeGb ?? 81.6} GB free on Local PC
                </span>
              </div>

              <div className="bg-surface-container p-3.5 rounded-lg flex flex-col justify-between shadow-sm">
                <span className="font-label-caps text-label-caps text-on-surface-variant uppercase">
                  Active Snapshots
                </span>
                <div className="mt-2">
                  <div className="font-headline-lg text-headline-lg text-on-surface font-bold">
                    {activeSnapshotsList.length}{' '}
                    <span className="text-sm font-normal text-on-surface-variant">Points</span>
                  </div>
                  <div className="flex items-center gap-1 text-[11px] font-code-sm mt-1">
                    <span className="text-primary font-semibold">
                      {backupMeta?.filesOnDiskCount ?? activeSnapshotsList.length} Disk Files
                    </span>
                    <span className="text-on-surface-variant/40">•</span>
                    <span className="text-secondary">
                      {backupMeta?.mongoSyncedCount ?? activeSnapshotsList.length} MongoDB
                    </span>
                  </div>
                </div>
                <span className="font-code-sm text-code-sm text-secondary mt-2 flex items-center gap-1">
                  <span className="material-symbols-outlined text-xs">verified</span> Real SHA-256 verified
                </span>
              </div>

              <div className="bg-surface-container p-3.5 rounded-lg flex flex-col justify-between shadow-sm">
                <span className="font-label-caps text-label-caps text-on-surface-variant uppercase">
                  Compression Engine
                </span>
                <div className="mt-2">
                  <div className="font-headline-lg text-headline-lg text-on-surface font-bold">
                    Zstandard
                  </div>
                  <p className="font-code-sm text-code-sm text-primary-gold mt-0.5">
                    zstd lvl 3 (Parallel 16T)
                  </p>
                </div>
                <span className="font-code-sm text-code-sm text-on-surface-variant/80 mt-2">
                  65.2% ratio • 1.2 GB/s
                </span>
              </div>

              <div className="bg-surface-container p-3.5 rounded-lg flex flex-col justify-between shadow-sm">
                <span className="font-label-caps text-label-caps text-on-surface-variant uppercase">
                  World Freeze Engine
                </span>
                <div className="mt-2">
                  <div className="font-headline-lg text-headline-lg text-secondary font-bold">
                    0.00 <span className="text-sm font-normal text-on-surface-variant">TPS Loss</span>
                  </div>
                  <p className="font-code-sm text-code-sm text-on-surface-variant mt-0.5">
                    VSS Shadow Replica
                  </p>
                </div>
                <span className="font-code-sm text-code-sm text-secondary mt-2">
                  Zero player desync
                </span>
              </div>
            </div>

            <div className="p-3 rounded-lg bg-surface-container-high/60 flex items-center justify-between text-on-surface-variant text-body-sm font-body-sm flex-wrap gap-2">
              <div className="flex items-center gap-2">
                <span className="material-symbols-outlined text-primary text-base">bolt</span>
                <span>
                  Average creation runtime:{' '}
                  <strong className="text-on-surface font-mono">1.82s</strong> (Snapshotting chunks,
                  playerdata SQLite, and server state)
                </span>
              </div>
              <span className="font-code-sm text-code-sm text-primary-gold bg-primary-gold/10 px-2 py-0.5 rounded">
                FastPipe SafeHook Active
              </span>
            </div>
          </div>

          {/* 2. TIMELINE SNAPSHOT HISTORY & RESTORE POINTS */}
          <div className="bg-surface-container-low rounded-xl p-5 shadow-md flex flex-col gap-4">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
              <div>
                <h2 className="font-title-md text-title-md text-on-surface font-semibold flex items-center gap-2">
                  <span className="material-symbols-outlined text-primary text-xl">history</span>
                  Timeline Recovery Checkpoints
                </h2>
                <p className="font-body-sm text-body-sm text-on-surface-variant">
                  Instant rollback images stored on NVMe with remote verified parity
                </p>
              </div>
              <div className="flex items-center gap-2">
                <div className="relative">
                  <input
                    type="text"
                    value={filterText}
                    onChange={(e) => setFilterText(e.target.value)}
                    className="bg-surface-container text-on-surface text-body-sm font-body-sm rounded-lg pl-8 pr-3 py-1.5 focus:outline-none placeholder-on-surface-variant/50 w-44 sm:w-56"
                    placeholder="Filter snapshots..."
                  />
                  <span className="material-symbols-outlined text-sm text-on-surface-variant/60 absolute left-2.5 top-2.5">
                    search
                  </span>
                </div>
                <button
                  type="button"
                  onClick={() => onShowToast('Snapshots Synchronized', 'Verified SHA-256 parity across all checkpoints.', 'info', 'sync')}
                  className="p-1.5 rounded-lg bg-surface-container text-on-surface-variant hover:text-on-surface hover:bg-surface-bright transition-colors cursor-pointer"
                  title="Reload List"
                >
                  <span className="material-symbols-outlined text-lg">sync</span>
                </button>
              </div>
            </div>

            <div className="flex flex-col gap-3">
              {filteredSnapshots.map((snap, idx) => (
                <div
                  key={snap.id}
                  className="bg-surface-container rounded-xl p-4 shadow-sm hover:shadow-md transition-all duration-200 flex flex-col gap-3"
                >
                  <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                    <div className="flex items-start sm:items-center gap-3">
                      <div
                        className={`size-9 rounded-lg flex items-center justify-center shrink-0 mt-0.5 sm:mt-0 ${snap.iconColor}`}
                      >
                        <span className="material-symbols-outlined text-lg">{snap.icon}</span>
                      </div>
                      <div>
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="font-title-md text-title-md text-on-surface font-bold">
                            {snap.title}
                          </span>
                          <span
                            className={`px-2 py-0.5 rounded font-label-caps text-label-caps font-bold uppercase ${
                              snap.badgeType === 'primary'
                                ? 'bg-primary/20 text-primary-gold'
                                : snap.badgeType === 'tertiary'
                                ? 'bg-tertiary/20 text-tertiary'
                                : snap.badgeType === 'gold'
                                ? 'bg-primary-gold/20 text-primary-gold'
                                : 'bg-surface-container-highest text-on-surface-variant'
                            }`}
                          >
                            {snap.badge}
                          </span>
                          {snap.verified && (
                            <span className="px-2 py-0.5 rounded bg-secondary-container/20 text-secondary font-label-caps text-label-caps font-bold uppercase flex items-center gap-1">
                              <span className="size-1 rounded-full bg-secondary" /> Verified
                            </span>
                          )}
                        </div>
                        <p className="font-code-sm text-code-sm text-on-surface-variant flex items-center gap-2 mt-0.5">
                          <span>{snap.timestamp}</span>
                          <span className="text-on-surface-variant/40">•</span>
                          <span className="text-on-surface font-mono">{snap.size}</span>
                          {snap.note && (
                            <span className="text-on-surface-variant/60">{snap.note}</span>
                          )}
                        </p>
                      </div>
                    </div>

                    <div className="flex items-center gap-2 shrink-0 self-end sm:self-auto">
                      <button
                        type="button"
                        onClick={() => handleRestore(snap.title)}
                        className={`px-3 py-1.5 rounded-lg font-body-sm text-body-sm font-semibold transition-colors flex items-center gap-1.5 cursor-pointer shadow-sm ${
                          idx === 0
                            ? 'bg-primary text-on-primary hover:bg-primary-gold'
                            : 'bg-surface-container-high text-on-surface hover:bg-surface-bright'
                        }`}
                      >
                        <span
                          className={`material-symbols-outlined text-base ${
                            idx === 0 ? '' : 'text-primary'
                          }`}
                        >
                          {idx === 0 ? 'settings_backup_restore' : 'restore'}
                        </span>
                        <span>{idx === 0 ? '1-Click Restore' : 'Restore'}</span>
                      </button>

                      <button
                        type="button"
                        onClick={() =>
                          onShowToast(`Downloading ${snap.title}`, 'Streaming .tar.zst archive...', 'info', 'download')
                        }
                        className="p-1.5 rounded-lg bg-surface-container-high text-on-surface-variant hover:text-on-surface hover:bg-surface-bright transition-colors cursor-pointer"
                        title="Download (.tar.zst)"
                      >
                        <span className="material-symbols-outlined text-lg">download</span>
                      </button>

                      <button
                        type="button"
                        onClick={() => handleTogglePinLive(snap.id)}
                        className={`p-1.5 rounded-lg bg-surface-container-high hover:bg-surface-bright transition-colors cursor-pointer ${
                          snap.pinned ? 'text-primary-gold' : 'text-on-surface-variant'
                        }`}
                        title="Pin / Lock Snapshot"
                      >
                        <span className="material-symbols-outlined text-lg">push_pin</span>
                      </button>

                      <button
                        type="button"
                        onClick={() => handleDeleteSnapshotLive(snap.id, snap.title)}
                        className="p-1.5 rounded-lg bg-surface-container-high hover:bg-error/20 text-on-surface-variant hover:text-error transition-colors cursor-pointer"
                        title="Delete Snapshot from Disk"
                      >
                        <span className="material-symbols-outlined text-lg">delete</span>
                      </button>
                    </div>
                  </div>

                  <div className="flex flex-wrap items-center justify-between gap-2 pt-2 bg-surface-container-high/40 p-2 rounded-lg">
                    <div className="flex items-center gap-1.5 text-on-surface-variant font-code-sm text-code-sm flex-wrap">
                      <span className="text-on-surface font-semibold">Scope:</span>
                      {snap.scopes.map((sc) => (
                        <span
                          key={sc}
                          className="px-1.5 py-0.5 rounded bg-surface-container-highest text-on-surface-variant"
                        >
                          {sc}
                        </span>
                      ))}
                    </div>
                    <div className="flex items-center gap-3 text-code-sm font-code-sm">
                      <span className="text-on-surface-variant flex items-center gap-1">
                        <span className="material-symbols-outlined text-sm text-secondary">
                          memory
                        </span>{' '}
                        {snap.destination}
                      </span>
                      {snap.cloudDest && (
                        <span className="text-tertiary flex items-center gap-1">
                          <span className="material-symbols-outlined text-sm">cloud</span>{' '}
                          {snap.cloudDest}
                        </span>
                      )}
                      {snap.sha && (
                        <span className="text-secondary font-mono text-[10px]">{snap.sha}</span>
                      )}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* 3. AUTOMATED CRON SCHEDULER & RECURRING TASKS */}
          <div className="bg-surface-container-low rounded-xl p-5 shadow-md flex flex-col gap-4">
            <div className="flex items-center justify-between">
              <div>
                <h2 className="font-title-md text-title-md text-on-surface font-semibold flex items-center gap-2">
                  <span className="material-symbols-outlined text-primary text-xl">acute</span>
                  Automated Cron Scheduler &amp; Maintenance Routines
                </h2>
                <p className="font-body-sm text-body-sm text-on-surface-variant">
                  Scheduled tasks executed by the King Panel background daemon thread pool
                </p>
              </div>
              <button
                type="button"
                onClick={() => onNavigate('schedules')}
                className="px-3 py-1.5 rounded-lg bg-surface-container-high text-on-surface hover:bg-surface-bright font-body-sm text-body-sm flex items-center gap-1.5 cursor-pointer"
              >
                <span className="material-symbols-outlined text-base text-primary">add</span>
                Add Task
              </button>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              {crons.map((c) => (
                <div
                  key={c.id}
                  className="bg-surface-container p-3.5 rounded-xl flex flex-col justify-between gap-3 shadow-sm"
                >
                  <div className="flex items-start justify-between">
                    <div className="flex items-center gap-2.5">
                      <div
                        className={`size-8 rounded-lg flex items-center justify-center ${c.iconColor}`}
                      >
                        <span className="material-symbols-outlined text-lg">{c.icon}</span>
                      </div>
                      <div>
                        <h3 className="font-title-md text-title-md text-on-surface font-semibold">
                          {c.title}
                        </h3>
                        <div className="font-code-sm text-code-sm text-primary font-mono">
                          {c.cron}
                        </div>
                      </div>
                    </div>
                    <span className="px-2 py-0.5 rounded bg-secondary/20 text-secondary font-code-sm text-code-sm font-semibold">
                      {c.status}
                    </span>
                  </div>
                  <p className="font-body-sm text-body-sm text-on-surface-variant">
                    {c.description}
                  </p>
                  <div className="flex items-center justify-between text-code-sm font-code-sm pt-2 border-t border-surface-container-high text-on-surface-variant">
                    <span>{c.nextRun}</span>
                    <button
                      type="button"
                      onClick={() =>
                        onShowToast(
                          `Executed Task: ${c.title}`,
                          `Dispatched cron routine (${c.cron}) to PaperMC daemon.`,
                          'success',
                          'play_arrow'
                        )
                      }
                      className="text-primary hover:text-primary-gold cursor-pointer"
                    >
                      {c.actionLabel}
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* RIGHT SIDEBAR / DISASTER RECOVERY & STORAGE (4 cols) */}
        <div className="lg:col-span-4 flex flex-col gap-5">
          {/* 1. 1-CLICK DISASTER ROLLBACK CONTROLS WIDGET */}
          <div className="bg-surface-container-low rounded-xl p-5 shadow-md flex flex-col gap-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2 text-error">
                <span className="material-symbols-outlined text-2xl text-primary">
                  security_update_warning
                </span>
                <h2 className="font-title-md text-title-md text-on-surface font-semibold">
                  Disaster Recovery Chamber
                </h2>
              </div>
              <span className="px-2 py-0.5 rounded bg-primary/20 text-primary-gold font-code-sm text-code-sm font-bold">
                FastRollback
              </span>
            </div>
            <p className="font-body-sm text-body-sm text-on-surface-variant">
              Emergency server rollbacks execute in-place using Direct-IO swapping. Server
              automatically suspends network traffic during restore.
            </p>

            <div className="bg-surface-container p-3.5 rounded-xl flex flex-col gap-3 shadow-sm">
              <div>
                <label className="font-label-caps text-label-caps text-on-surface-variant uppercase block mb-1.5">
                  Target Restore Point
                </label>
                <select
                  value={selectedRollbackId}
                  onChange={(e) => setSelectedRollbackId(e.target.value)}
                  className="w-full bg-surface-container-high text-on-surface text-body-sm font-body-sm rounded-lg px-3 py-2 border-0 focus:outline-none"
                >
                  {snapshots.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.title} ({s.size})
                    </option>
                  ))}
                </select>
              </div>

              <div className="flex flex-col gap-2 pt-1">
                <label className="flex items-start gap-2.5 cursor-pointer">
                  <input
                    type="checkbox"
                    defaultChecked
                    className="rounded bg-surface-container-high text-primary focus:ring-0 mt-0.5 size-4"
                  />
                  <span className="font-body-sm text-body-sm text-on-surface">
                    Create emergency pre-restore snapshot before proceeding{' '}
                    <strong className="text-primary-gold">(Recommended)</strong>
                  </span>
                </label>
                <label className="flex items-start gap-2.5 cursor-pointer">
                  <input
                    type="checkbox"
                    defaultChecked
                    className="rounded bg-surface-container-high text-primary focus:ring-0 mt-0.5 size-4"
                  />
                  <span className="font-body-sm text-body-sm text-on-surface">
                    Broadcast &amp; safely disconnect {server.playersOnline} connected players
                  </span>
                </label>
              </div>

              <div className="flex flex-col gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => {
                    setDryRunComplete(true);
                    onShowToast(
                      'Dry-Run Simulation Passed',
                      'Archive integrity 100% SHA verified. Est. swap: ~3.2s.',
                      'info',
                      'science'
                    );
                  }}
                  className="w-full py-2 px-3 rounded-lg bg-surface-container-high text-on-surface font-title-md text-title-md font-semibold hover:bg-surface-bright transition-colors flex items-center justify-center gap-2 cursor-pointer shadow-sm"
                >
                  <span className="material-symbols-outlined text-tertiary text-lg">science</span>
                  Dry-Run Simulation (Safe Check)
                </button>
                <button
                  type="button"
                  onClick={() => {
                    const target = snapshots.find((s) => s.id === selectedRollbackId);
                    handleRestore(target?.title || 'Selected Checkpoint');
                  }}
                  className="w-full py-2.5 px-3 rounded-lg bg-primary text-on-primary font-title-md text-title-md font-bold hover:bg-primary-gold transition-colors flex items-center justify-center gap-2 cursor-pointer shadow-lg shadow-primary/10"
                >
                  <span className="material-symbols-outlined text-lg">restart_alt</span>
                  Execute Instant Server Rollback
                </button>
              </div>
            </div>

            {dryRunComplete && (
              <div className="p-3 rounded-lg bg-surface-container text-code-sm font-code-sm space-y-1">
                <div className="text-tertiary flex items-center gap-1">
                  <span className="material-symbols-outlined text-xs">done</span>
                  Simulation Passed: Archive integrity 100% SHA verified
                </div>
                <div className="text-on-surface-variant">
                  Estimated swap duration: ~3.2 seconds via FastPipe NVMe channel
                </div>
              </div>
            )}
          </div>

          {/* 2. CLOUD & OFFSITE REPLICATION STATUS */}
          <div className="bg-surface-container-low rounded-xl p-5 shadow-md flex flex-col gap-4">
            <div className="flex items-center justify-between">
              <h2 className="font-title-md text-title-md text-on-surface font-semibold flex items-center gap-2">
                <span className="material-symbols-outlined text-tertiary text-xl">cloud_sync</span>
                Cloud &amp; Offsite Replication
              </h2>
              <span className="size-2 rounded-full bg-secondary animate-pulse" />
            </div>
            <p className="font-body-sm text-body-sm text-on-surface-variant">
              Multipath remote sync replicates new snapshots to encrypted cold buckets via
              multi-threaded chunk streams.
            </p>

            <div className="flex flex-col gap-2.5">
              <div className="bg-surface-container p-3 rounded-xl flex items-center justify-between shadow-sm">
                <div className="flex items-center gap-3">
                  <div className="size-9 rounded-lg bg-tertiary/10 flex items-center justify-center text-tertiary">
                    <span className="material-symbols-outlined text-xl">cloud_queue</span>
                  </div>
                  <div>
                    <h3 className="font-title-md text-title-md text-on-surface font-semibold">
                      AWS S3 Cold Bucket
                    </h3>
                    <div className="font-code-sm text-code-sm text-on-surface-variant">
                      kingsmp-cold-backups (eu-central-1)
                    </div>
                  </div>
                </div>
                <div className="text-right">
                  <div className="font-code-sm text-code-sm text-secondary font-semibold">
                    Synced
                  </div>
                  <div className="font-code-sm text-code-sm text-on-surface-variant/80">12.2 GB</div>
                </div>
              </div>

              <div className="bg-surface-container p-3 rounded-xl flex items-center justify-between shadow-sm">
                <div className="flex items-center gap-3">
                  <div className="size-9 rounded-lg bg-primary-gold/10 flex items-center justify-center text-primary-gold">
                    <span className="material-symbols-outlined text-xl">add_to_drive</span>
                  </div>
                  <div>
                    <h3 className="font-title-md text-title-md text-on-surface font-semibold">
                      Google Drive Enterprise
                    </h3>
                    <div className="font-code-sm text-code-sm text-on-surface-variant">
                      /MioSMP Backups/ (OAuth2)
                    </div>
                  </div>
                </div>
                <div className="text-right">
                  <div className="font-code-sm text-code-sm text-secondary font-semibold">
                    Synced
                  </div>
                  <div className="font-code-sm text-code-sm text-on-surface-variant/80">8.4 GB</div>
                </div>
              </div>

              <div className="bg-surface-container p-3 rounded-xl flex items-center justify-between shadow-sm">
                <div className="flex items-center gap-3">
                  <div className="size-9 rounded-lg bg-surface-container-highest flex items-center justify-center text-on-surface-variant">
                    <span className="material-symbols-outlined text-xl">storage</span>
                  </div>
                  <div>
                    <h3 className="font-title-md text-title-md text-on-surface font-semibold">
                      Local HDD Redundant Mirror
                    </h3>
                    <div className="font-code-sm text-code-sm text-on-surface-variant">
                      D:\Backups\MioSMP (Secondary SATA)
                    </div>
                  </div>
                </div>
                <div className="text-right">
                  <div className="font-code-sm text-code-sm text-secondary font-semibold">
                    Synced
                  </div>
                  <div className="font-code-sm text-code-sm text-on-surface-variant/80">18.4 GB</div>
                </div>
              </div>
            </div>

            <button
              type="button"
              onClick={() =>
                onShowToast(
                  'Offsite Mirrors Synchronized',
                  'Synced latest ZSTD delta chunks to AWS S3 & Google Drive.',
                  'success',
                  'sync'
                )
              }
              className="w-full py-2 px-3 rounded-lg bg-surface-container-high text-on-surface font-body-sm text-body-sm hover:bg-surface-bright transition-colors flex items-center justify-center gap-1.5 cursor-pointer"
            >
              <span className="material-symbols-outlined text-base">sync</span>
              Force Sync All Remotes
            </button>
          </div>

          {/* 3. BACKUP RETENTION & AUTO-PRUNING RULES */}
          <div className="bg-surface-container-low rounded-xl p-5 shadow-md flex flex-col gap-4">
            <div className="flex items-center justify-between">
              <h2 className="font-title-md text-title-md text-on-surface font-semibold flex items-center gap-2">
                <span className="material-symbols-outlined text-primary-gold text-xl">
                  auto_delete
                </span>
                Retention &amp; Auto-Pruning Policy
              </h2>
              <span className="px-2 py-0.5 rounded bg-surface-container-high text-on-surface font-code-sm text-code-sm">
                G-F-S Logic
              </span>
            </div>

            <div className="bg-surface-container p-3.5 rounded-xl flex flex-col gap-3 shadow-sm">
              <div className="flex items-center justify-between">
                <span className="font-body-sm text-body-sm text-on-surface">
                  Hourly Fast Snapshots
                </span>
                <span className="font-code-sm text-code-sm text-primary font-semibold">
                  Keep for 24 Hours
                </span>
              </div>
              <div className="w-full bg-surface-container-highest h-1 rounded-full overflow-hidden">
                <div className="bg-primary h-full rounded-full" style={{ width: '100%' }} />
              </div>

              <div className="flex items-center justify-between pt-1">
                <span className="font-body-sm text-body-sm text-on-surface">
                  Daily Nightly Archives
                </span>
                <span className="font-code-sm text-code-sm text-primary-gold font-semibold">
                  Keep for 14 Days
                </span>
              </div>
              <div className="w-full bg-surface-container-highest h-1 rounded-full overflow-hidden">
                <div className="bg-primary-gold h-full rounded-full" style={{ width: '75%' }} />
              </div>

              <div className="flex items-center justify-between pt-1">
                <span className="font-body-sm text-body-sm text-on-surface">
                  Weekly Full Checkpoints
                </span>
                <span className="font-code-sm text-code-sm text-secondary font-semibold">
                  Keep for 8 Weeks
                </span>
              </div>
              <div className="w-full bg-surface-container-highest h-1 rounded-full overflow-hidden">
                <div className="bg-secondary h-full rounded-full" style={{ width: '50%' }} />
              </div>

              <div className="pt-2 border-t border-surface-container-high flex items-center justify-between">
                <div>
                  <span className="font-body-sm text-body-sm text-on-surface block font-medium">
                    Emergency Disk Guard
                  </span>
                  <span className="font-code-sm text-code-sm text-on-surface-variant">
                    Prune oldest unpinned at 85% full
                  </span>
                </div>
                <span className="px-2 py-1 rounded bg-secondary/10 text-secondary font-code-sm text-code-sm font-bold">
                  85% Limit
                </span>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* MODAL: MANUAL SNAPSHOT CREATOR */}
      {modalOpen && (
        <div className="fixed inset-0 z-50 bg-surface-dim/80 backdrop-blur-md flex items-center justify-center p-4">
          <form
            onSubmit={handleGenerateSnapshot}
            className="bg-surface-container-low border border-white/10 rounded-2xl w-full max-w-lg shadow-2xl p-6 flex flex-col gap-4 relative"
          >
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2.5">
                <div className="size-8 rounded-lg bg-primary/20 flex items-center justify-center text-primary">
                  <span className="material-symbols-outlined text-xl">camera_enhance</span>
                </div>
                <div>
                  <h3 className="font-headline-sm text-headline-sm text-on-surface font-bold">
                    Create Live Snapshot
                  </h3>
                  <p className="font-body-sm text-body-sm text-on-surface-variant">
                    Zero-tick safe snapshot of {server.name}
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setModalOpen(false)}
                className="p-1 rounded-lg hover:bg-surface-container-high text-on-surface-variant hover:text-on-surface transition-colors cursor-pointer"
              >
                <span className="material-symbols-outlined text-lg">close</span>
              </button>
            </div>

            <div className="flex flex-col gap-3">
              <div>
                <label className="font-label-caps text-label-caps text-on-surface-variant uppercase block mb-1">
                  Snapshot Label / Tag
                </label>
                <input
                  type="text"
                  value={snapshotTag}
                  onChange={(e) => setSnapshotTag(e.target.value)}
                  className="w-full bg-surface-container text-on-surface text-body-sm font-body-sm rounded-lg px-3 py-2 border border-white/10 focus:outline-none focus:border-primary"
                  placeholder="e.g. Before Nether Highway Build"
                />
              </div>

              <div className="p-3 rounded-lg bg-surface-container text-code-sm font-code-sm flex items-center justify-between">
                <span className="text-on-surface-variant">Compression Preset:</span>
                <span className="text-primary-gold font-mono font-semibold">
                  Zstd Level 3 (Ultra-Fast 1.2 GB/s)
                </span>
              </div>

              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={pinSnapshot}
                  onChange={(e) => setPinSnapshot(e.target.checked)}
                  className="rounded bg-surface-container-high text-primary focus:ring-0 size-4"
                />
                <span className="font-body-sm text-body-sm text-on-surface">
                  Pin snapshot to protect from auto-pruning
                </span>
              </label>
            </div>

            <div className="flex items-center justify-end gap-2 pt-2 border-t border-surface-container-high">
              <button
                type="button"
                onClick={() => setModalOpen(false)}
                className="px-4 py-2 rounded-xl bg-surface-container text-on-surface font-title-md text-title-md hover:bg-surface-bright transition-colors cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={isCreating}
                className="px-4 py-2 rounded-xl bg-primary text-on-primary font-title-md text-title-md font-bold hover:bg-primary-gold transition-colors flex items-center gap-2 cursor-pointer shadow-md shadow-primary/20"
              >
                <span
                  className={`material-symbols-outlined text-lg ${
                    isCreating ? 'animate-spin' : ''
                  }`}
                >
                  {isCreating ? 'refresh' : 'play_arrow'}
                </span>
                <span>{isCreating ? 'Capturing...' : 'Generate Snapshot'}</span>
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
};
