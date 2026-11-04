import React, { useCallback, useEffect, useState } from 'react';

interface ServerOwnershipSettingsProps {
  isSuperAdmin: boolean;
  onShowToast: (
    title: string,
    body?: string,
    type?: 'success' | 'info' | 'warning' | 'error',
    icon?: string,
  ) => void;
}

interface FolderOwner {
  folderName: string;
  ownerId: string;
  ownerUsername: string;
  createdAt: string;
}

interface FolderRow {
  name: string;
  diskPath: string;
  owner: FolderOwner | null;
}

interface OwnershipAccount {
  id: string;
  username: string;
  displayName?: string;
  isSuperAdmin: boolean;
}

interface OwnershipSnapshot {
  installRoot: string;
  unattributedCount: number;
  folders: FolderRow[];
  accounts: OwnershipAccount[];
}

/**
 * Super Admin control for server-folder ownership.
 *
 * A folder on disk with no `server_owners` row belongs to nobody, which makes it
 * Super Admin only — the safe default for folders that existed before ownership
 * was recorded. Handing one to an account is therefore an explicit act, recorded
 * in the panel audit log by POST /api/admin/server-ownership/assign. This card
 * only offers the form; Express re-checks the Super Admin role and that the
 * folder really sits under the install root.
 */
export const ServerOwnershipSettings: React.FC<ServerOwnershipSettingsProps> = ({
  isSuperAdmin,
  onShowToast,
}) => {
  const [open, setOpen] = useState(false);
  const [snapshot, setSnapshot] = useState<OwnershipSnapshot | null>(null);
  const [selection, setSelection] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);
  const [assigning, setAssigning] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/admin/server-ownership', {
        credentials: 'include',
        cache: 'no-store',
      });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.ok) {
        setError(String(data?.error || `The backend refused the request (HTTP ${res.status}).`));
        return;
      }
      setError(null);
      setSnapshot({
        installRoot: String(data.installRoot || ''),
        unattributedCount: Number(data.unattributedCount) || 0,
        folders: Array.isArray(data.folders) ? (data.folders as FolderRow[]) : [],
        accounts: Array.isArray(data.accounts) ? (data.accounts as OwnershipAccount[]) : [],
      });
    } catch {
      setError('The backend is unreachable.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (isSuperAdmin) void load();
  }, [isSuperAdmin, load]);

  if (!isSuperAdmin) return null;

  const unattributed = snapshot?.unattributedCount ?? 0;
  const folders = snapshot?.folders ?? [];
  const accounts = snapshot?.accounts ?? [];

  const assign = async (row: FolderRow) => {
    const target = selection[row.name];
    if (!target) return;
    setAssigning(row.name);
    try {
      const res = await fetch('/api/admin/server-ownership/assign', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ folderName: row.name, username: target }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.ok) {
        onShowToast(
          'Could not assign the folder',
          String(data?.error || `Backend refused the change (HTTP ${res.status})`),
          'error',
          'error',
        );
        return;
      }
      onShowToast(
        data.changed ? 'Folder assigned' : 'Already assigned',
        data.changed
          ? `"${row.name}" now belongs to @${target}. The previous owner loses access on their next request.`
          : `"${row.name}" already belonged to @${target}; nothing changed.`,
        'success',
        'folder_shared',
      );
      await load();
    } catch {
      onShowToast('Could not assign the folder', 'The backend is unreachable.', 'error', 'error');
    } finally {
      setAssigning(null);
    }
  };

  return (
    <div className="p-5 rounded-xl bg-surface-container-low border border-white/[0.08] space-y-3.5">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="font-title-md text-title-md text-white font-bold flex items-center gap-2">
            <span className="material-symbols-outlined text-primary">folder_shared</span>
            Server Folder Ownership
          </h3>
          <p className="text-[11px] text-outline mt-1">
            A folder with no owner is reachable by the Super Admin only, never by
            whichever account signs in first.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setOpen((prev) => !prev)}
          disabled={loading}
          className="px-3 py-1.5 rounded-lg bg-white/5 hover:bg-white/10 border border-white/10 text-[11px] font-semibold text-outline hover:text-white cursor-pointer disabled:opacity-50 shrink-0"
        >
          {open ? 'Hide' : 'Review'}
        </button>
      </div>

      <div className="flex flex-wrap gap-1.5">
        <span
          className={`px-2 py-0.5 rounded font-mono text-[10px] font-bold uppercase border ${
            unattributed > 0
              ? 'bg-amber-400/15 text-amber-300 border-amber-400/35'
              : 'bg-secondary/15 text-secondary border-secondary/35'
          }`}
        >
          {snapshot === null
            ? 'Not loaded'
            : unattributed > 0
              ? `${unattributed} unattributed`
              : 'All folders attributed'}
        </span>
        <span className="px-2 py-0.5 rounded font-mono text-[10px] font-bold uppercase border bg-white/5 text-outline border-white/10">
          {folders.length} folder{folders.length === 1 ? '' : 's'}
        </span>
      </div>

      {open && (
        <div className="space-y-3 pt-1">
          {error && (
            <div className="rounded-lg border px-3 py-2.5 text-[11px] bg-error/10 border-error/35 text-error">
              {error}
            </div>
          )}

          {!error && folders.length === 0 && (
            <p className="text-[11px] text-outline">
              No server folders exist under the install root yet.
            </p>
          )}

          {folders.length > 0 && (
            <div className="space-y-2 max-h-72 overflow-y-auto pr-1">
              {folders.map((row) => {
                const chosen = selection[row.name] ?? '';
                return (
                  <div
                    key={row.name}
                    className="p-2.5 rounded-lg bg-surface-container border border-white/[0.06] space-y-2"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-xs font-mono text-white truncate">{row.name}</span>
                      <span
                        className={`px-1.5 py-0.5 rounded font-mono text-[10px] font-bold uppercase shrink-0 ${
                          row.owner
                            ? 'bg-secondary/15 text-secondary'
                            : 'bg-amber-400/15 text-amber-300'
                        }`}
                      >
                        {row.owner ? `@${row.owner.ownerUsername}` : 'Unattributed'}
                      </span>
                    </div>
                    <div className="flex items-center gap-2">
                      <select
                        value={chosen}
                        onChange={(e) =>
                          setSelection((prev) => ({ ...prev, [row.name]: e.target.value }))
                        }
                        className="flex-1 min-w-0 bg-surface-lowest border border-white/15 focus:border-primary rounded-lg px-2 py-1.5 text-[11px] font-mono text-white focus:outline-none"
                      >
                        <option value="">Select an account…</option>
                        {accounts
                          .filter((account) => account.id !== row.owner?.ownerId)
                          .map((account) => (
                            <option key={account.id} value={account.username}>
                              @{account.username}
                              {account.displayName ? ` — ${account.displayName}` : ''}
                            </option>
                          ))}
                      </select>
                      <button
                        type="button"
                        onClick={() => void assign(row)}
                        disabled={!chosen || assigning === row.name}
                        className="px-3 py-1.5 rounded-lg bg-primary hover:opacity-95 text-on-primary-container text-[11px] font-bold cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed shrink-0"
                      >
                        {assigning === row.name ? 'Assigning…' : 'Assign'}
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          <p className="text-[10px] text-outline leading-relaxed">
            Every assignment is written to the panel audit log. Folders are listed
            from <span className="text-white">{snapshot?.installRoot || 'the install root'}</span>
            ; a folder outside it is rejected by the backend.
          </p>
        </div>
      )}
    </div>
  );
};

export default ServerOwnershipSettings;
