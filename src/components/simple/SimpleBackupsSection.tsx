import React, { useCallback, useEffect, useState } from 'react';
import { cancelJob, submitJob, type OperationJob } from '../../lib/jobs';
import { JobProgressBar } from '../JobProgressBar';
import { SectionProps, cardClass, cardTitleClass, dangerBtnClass, formatBytes, ghostBtnClass, inputClass, primaryBtnClass } from './types';

/**
 * Backups tab: real archives written into `<server>/backups` (tar.gz, with a
 * PowerShell zip fallback on Windows), restore back into the server folder and
 * delete. Creation is blocked while the server is starting; restore requires a
 * stopped server (the backend enforces both).
 */

interface Archive {
  name: string;
  sizeBytes: number;
  modifiedAt: string;
}

const SCOPE_LABELS: Array<{ key: string; label: string }> = [
  { key: 'world', label: 'World' },
  { key: 'world_nether', label: 'Nether' },
  { key: 'world_the_end', label: 'End' },
  { key: 'server.properties', label: 'server.properties' },
  { key: 'plugins', label: 'plugins/' },
  { key: 'mods', label: 'mods/' },
  { key: 'config', label: 'config/' },
  { key: 'server.jar', label: 'server.jar' },
];

export const SimpleBackupsSection: React.FC<SectionProps> = ({ server, onShowToast }) => {
  const [archives, setArchives] = useState<Archive[]>([]);
  const [title, setTitle] = useState('manual-checkpoint');
  const [scopes, setScopes] = useState<string[]>(['world', 'server.properties']);
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmRestore, setConfirmRestore] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [job, setJob] = useState<OperationJob | null>(null);

  const query = `serverId=${encodeURIComponent(server.id)}&serverName=${encodeURIComponent(server.name)}`;

  const refresh = useCallback(async () => {
    try {
      const res = await fetch(`/api/server-runtime/backups?${query}`);
      const data = await res.json();
      if (data?.ok) setArchives(data.archives || []);
    } catch {
      // backend restarting
    }
  }, [query]);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 10_000);
    return () => clearInterval(timer);
  }, [refresh]);

  const toggleScope = (key: string) =>
    setScopes((prev) => (prev.includes(key) ? prev.filter((s) => s !== key) : [...prev, key]));

  const create = async () => {
    setCreating(true);
    setJob(null);
    try {
      const outcome = await submitJob<{ archive?: { name: string; sizeBytes: number } }>(
        '/api/server-runtime/backup-create',
        { serverId: server.id, serverName: server.name, title, scopes },
        { onProgress: setJob },
      );
      if (!outcome.ok) {
        onShowToast('Backup failed', outcome.error || 'Could not write the archive', 'error', 'error');
        return;
      }
      const archive = outcome.result?.archive;
      onShowToast(
        'Backup created',
        archive ? `${archive.name} · ${formatBytes(archive.sizeBytes)}` : 'Archive written to backups/',
        'success',
        'archive',
      );
      await refresh();
    } finally {
      setCreating(false);
    }
  };

  const restore = async (file: string) => {
    setBusy(file);
    setJob(null);
    try {
      const outcome = await submitJob(
        '/api/server-runtime/backup-restore',
        { serverId: server.id, serverName: server.name, file },
        { onProgress: setJob },
      );
      if (!outcome.ok) {
        onShowToast('Restore failed', outcome.error || 'The archive could not be extracted', 'error');
        return;
      }
      setConfirmRestore(null);
      onShowToast('Backup restored', file, 'success', 'settings_backup_restore');
      await refresh();
    } finally {
      setBusy(null);
    }
  };

  const remove = async (file: string) => {
    setBusy(file);
    try {
      const res = await fetch(
        `/api/server-runtime/backup?serverId=${encodeURIComponent(server.id)}&serverName=${encodeURIComponent(
          server.name
        )}&file=${encodeURIComponent(file)}`,
        { method: 'DELETE' }
      );
      const data = await res.json();
      if (!data?.ok) {
        onShowToast('Delete failed', data?.error, 'error');
        return;
      }
      setConfirmDelete(null);
      onShowToast('Archive deleted', file, 'success', 'delete');
      await refresh();
    } finally {
      setBusy(null);
    }
  };

  const totalBytes = archives.reduce((sum, a) => sum + a.sizeBytes, 0);

  return (
    <div className="space-y-4">
      <div className={cardClass}>
        <h2 className={`${cardTitleClass} mb-3`}>
          <span className="material-symbols-outlined text-[18px] text-primary">save</span>
          Create a backup
        </h2>
        <div className="flex flex-wrap gap-2 items-center">
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="backup label"
            className={`${inputClass} max-w-xs`}
          />
          <button type="button" onClick={() => void create()} disabled={creating || scopes.length === 0} className={primaryBtnClass}>
            <span className="material-symbols-outlined text-[16px]">archive</span>
            {creating ? 'Archiving…' : 'Create backup'}
          </button>
          {creating && !job && (
            <span className="text-[11px] text-outline">Queuing the archive…</span>
          )}
          <span className="text-[11px] text-outline">
            {archives.length} archive{archives.length === 1 ? '' : 's'} · {formatBytes(totalBytes)} in{' '}
            <span className="font-mono text-white">backups/</span>
          </span>
        </div>
        <div className="flex flex-wrap gap-1.5 mt-3">
          {SCOPE_LABELS.map((scope) => {
            const active = scopes.includes(scope.key);
            return (
              <button
                key={scope.key}
                type="button"
                onClick={() => toggleScope(scope.key)}
                className={`px-2.5 py-1 rounded-lg border text-[11px] font-mono cursor-pointer ${
                  active
                    ? 'bg-primary/15 border-primary/40 text-white'
                    : 'bg-white/5 border-white/10 text-outline hover:text-white'
                }`}
              >
                {scope.label}
              </button>
            );
          })}
        </div>
        {job && (creating || busy) && (
          <JobProgressBar
            job={job}
            className="mt-3"
            onCancel={() => {
              void cancelJob(job.id);
            }}
          />
        )}
        <p className="text-[11px] text-outline mt-2">
          Only entries that exist in the folder are archived, so Forge/Fabric servers back up{' '}
          <span className="font-mono text-white">mods/</span> and Paper servers back up{' '}
          <span className="font-mono text-white">plugins/</span>.
        </p>
      </div>

      <div className={cardClass}>
        <div className="flex items-center justify-between mb-2">
          <h2 className={cardTitleClass}>
            <span className="material-symbols-outlined text-[18px] text-primary">inventory_2</span>
            Archives
          </h2>
          <button type="button" onClick={() => void refresh()} className={ghostBtnClass}>
            <span className="material-symbols-outlined text-[16px]">refresh</span>
          </button>
        </div>

        {archives.length === 0 ? (
          <p className="text-xs text-outline py-6 text-center">No backups yet — create one above.</p>
        ) : (
          <ul className="space-y-2">
            {archives.map((archive) => (
              <li key={archive.name} className="rounded-xl bg-surface-lowest border border-white/10 px-3.5 py-3">
                <div className="flex flex-wrap items-center gap-3">
                  <div className="min-w-0 flex-1">
                    <p className="text-xs font-mono text-white truncate">{archive.name}</p>
                    <p className="text-[11px] text-outline">
                      {formatBytes(archive.sizeBytes)} · {new Date(archive.modifiedAt).toLocaleString()}
                    </p>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <button
                      type="button"
                      onClick={() => setConfirmRestore(archive.name)}
                      disabled={busy === archive.name}
                      className={ghostBtnClass}
                    >
                      <span className="material-symbols-outlined text-[16px]">settings_backup_restore</span>
                      Restore
                    </button>
                    <button
                      type="button"
                      onClick={() => setConfirmDelete(archive.name)}
                      disabled={busy === archive.name}
                      className={dangerBtnClass}
                    >
                      <span className="material-symbols-outlined text-[16px]">delete</span>
                    </button>
                  </div>
                </div>

                {confirmRestore === archive.name && (
                  <div className="mt-2 rounded-xl border border-amber-400/40 bg-amber-400/10 p-2.5 text-[11px] text-amber-200 space-y-2">
                    <p>
                      Restoring overwrites the archived folders in <span className="font-mono">{server.name}</span>. Stop
                      the server first.
                    </p>
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => void restore(archive.name)}
                        className="px-2.5 py-1 rounded-lg bg-amber-400 text-black font-bold cursor-pointer"
                      >
                        Restore now
                      </button>
                      <button
                        type="button"
                        onClick={() => setConfirmRestore(null)}
                        className="px-2.5 py-1 rounded-lg bg-white/10 cursor-pointer"
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                )}

                {confirmDelete === archive.name && (
                  <div className="mt-2 rounded-xl border border-error/40 bg-error/10 p-2.5 text-[11px] text-error flex flex-wrap items-center gap-2">
                    <span>Delete {archive.name}?</span>
                    <button
                      type="button"
                      onClick={() => void remove(archive.name)}
                      className="px-2.5 py-1 rounded-lg bg-error text-white font-bold cursor-pointer"
                    >
                      Delete
                    </button>
                    <button
                      type="button"
                      onClick={() => setConfirmDelete(null)}
                      className="px-2.5 py-1 rounded-lg bg-white/10 cursor-pointer"
                    >
                      Cancel
                    </button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
};
