import React, { useCallback, useEffect, useState } from 'react';
import { SectionProps, cardClass, formatBytes, ghostBtnClass, inputClass, primaryBtnClass, smallInputClass } from './types';

/**
 * Files tab: browse the server folder (ephemeral paths stay inside it), edit
 * text files in place, create files/folders and delete entries. Every request
 * carries serverId so the backend resolves the folder itself.
 */

interface FileEntry {
  name: string;
  isDir: boolean;
  sizeBytes: number;
  modifiedAt: string;
}

interface SimpleFilesSectionProps extends SectionProps {
  onChanged?: () => void;
}

export const SimpleFilesSection: React.FC<SimpleFilesSectionProps> = ({ server, onShowToast, onChanged }) => {
  const [cwd, setCwd] = useState('.');
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [openFile, setOpenFile] = useState<{ path: string; content: string; dirty: boolean } | null>(null);
  const [saving, setSaving] = useState(false);
  const [newName, setNewName] = useState('');
  const [newKind, setNewKind] = useState<'file' | 'dir'>('file');
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  const baseQuery = `serverId=${encodeURIComponent(server.id)}&serverName=${encodeURIComponent(server.name)}`;

  const loadDir = useCallback(
    async (target: string) => {
      setLoading(true);
      setError(null);
      try {
        const res = await fetch(`/api/server-runtime/files?${baseQuery}&path=${encodeURIComponent(target)}`);
        const data = await res.json();
        if (!data?.ok) {
          setError(data?.error || 'Could not read folder');
          setEntries([]);
          return;
        }
        setEntries(data.entries || []);
        setCwd(data.path || '.');
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Could not read folder');
      } finally {
        setLoading(false);
      }
    },
    [baseQuery]
  );

  useEffect(() => {
    void loadDir('.');
  }, [loadDir, server.id]);

  const openFileAt = async (relPath: string) => {
    setLoading(true);
    try {
      const res = await fetch(`/api/server-runtime/file?${baseQuery}&path=${encodeURIComponent(relPath)}`);
      const data = await res.json();
      if (!data?.ok) {
        onShowToast('Cannot open file', data?.error || 'Unreadable file', 'error');
        return;
      }
      setOpenFile({ path: data.path, content: data.content, dirty: false });
    } finally {
      setLoading(false);
    }
  };

  const saveFile = async () => {
    if (!openFile) return;
    setSaving(true);
    try {
      const res = await fetch('/api/server-runtime/file', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          serverId: server.id,
          serverName: server.name,
          path: openFile.path,
          content: openFile.content,
        }),
      });
      const data = await res.json();
      if (!data?.ok) {
        onShowToast('Save failed', data?.error, 'error');
        return;
      }
      setOpenFile({ ...openFile, dirty: false });
      onShowToast('File saved', openFile.path, 'success', 'save');
      onChanged?.();
      void loadDir(cwd);
    } finally {
      setSaving(false);
    }
  };

  const createEntry = async () => {
    const name = newName.trim();
    if (!name) return;
    const relPath = cwd === '.' ? name : `${cwd}/${name}`;
    const res = await fetch('/api/server-runtime/file-create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ serverId: server.id, serverName: server.name, path: relPath, kind: newKind }),
    });
    const data = await res.json();
    if (!data?.ok) {
      onShowToast('Could not create', data?.error, 'error');
      return;
    }
    setNewName('');
    onShowToast(newKind === 'dir' ? 'Folder created' : 'File created', relPath, 'success', 'create_new_folder');
    void loadDir(cwd);
  };

  const deleteEntry = async (relPath: string) => {
    const res = await fetch('/api/server-runtime/file-delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ serverId: server.id, serverName: server.name, path: relPath }),
    });
    const data = await res.json();
    if (!data?.ok) {
      onShowToast('Delete failed', data?.error, 'error');
      return;
    }
    setConfirmDelete(null);
    if (openFile?.path === relPath) setOpenFile(null);
    onShowToast('Deleted', relPath, 'success', 'delete');
    void loadDir(cwd);
  };

  const segments = cwd === '.' ? [] : cwd.split('/').filter(Boolean);

  return (
    <div className="h-full min-h-0 grid grid-cols-1 xl:grid-cols-[380px_1fr] gap-4">
      <section className={`${cardClass} min-h-0 flex flex-col`}>
        <div className="flex items-center justify-between mb-2">
          <h2 className="text-sm font-bold text-white flex items-center gap-2">
            <span className="material-symbols-outlined text-[18px] text-primary">folder_open</span>
            Server Files
          </h2>
          <button type="button" onClick={() => void loadDir(cwd)} className={ghostBtnClass}>
            <span className="material-symbols-outlined text-[16px]">refresh</span>
          </button>
        </div>

        <nav className="flex flex-wrap items-center gap-1 text-[11px] font-mono text-outline mb-2">
          <button
            type="button"
            onClick={() => void loadDir('.')}
            className="px-1.5 py-0.5 rounded hover:bg-white/10 hover:text-white cursor-pointer"
          >
            {server.name}
          </button>
          {segments.map((seg, index) => {
            const target = segments.slice(0, index + 1).join('/');
            return (
              <React.Fragment key={target}>
                <span>/</span>
                <button
                  type="button"
                  onClick={() => void loadDir(target)}
                  className="px-1.5 py-0.5 rounded hover:bg-white/10 hover:text-white cursor-pointer"
                >
                  {seg}
                </button>
              </React.Fragment>
            );
          })}
        </nav>

        <div className="flex-1 min-h-0 overflow-y-auto -mx-1 px-1">
          {loading && entries.length === 0 ? (
            <p className="text-xs text-outline">Reading folder…</p>
          ) : error ? (
            <p className="text-xs text-error">{error}</p>
          ) : entries.length === 0 ? (
            <p className="text-xs text-outline">This folder is empty.</p>
          ) : (
            <ul className="space-y-0.5">
              {cwd !== '.' && (
                <li>
                  <button
                    type="button"
                    onClick={() => void loadDir(segments.slice(0, -1).join('/') || '.')}
                    className="w-full text-left px-2 py-1.5 rounded-lg hover:bg-white/5 text-xs font-mono text-outline flex items-center gap-2 cursor-pointer"
                  >
                    <span className="material-symbols-outlined text-[16px]">arrow_upward</span>
                    ..
                  </button>
                </li>
              )}
              {entries.map((entry) => {
                const relPath = cwd === '.' ? entry.name : `${cwd}/${entry.name}`;
                return (
                  <li key={entry.name} className="group flex items-center gap-1">
                    <button
                      type="button"
                      onClick={() => (entry.isDir ? void loadDir(relPath) : void openFileAt(relPath))}
                      className={`flex-1 min-w-0 text-left px-2 py-1.5 rounded-lg hover:bg-white/5 text-xs font-mono flex items-center gap-2 cursor-pointer ${
                        openFile?.path === relPath ? 'bg-primary/10 text-white' : 'text-on-surface-variant'
                      }`}
                    >
                      <span className="material-symbols-outlined text-[16px] text-primary">
                        {entry.isDir ? 'folder' : 'description'}
                      </span>
                      <span className="truncate">{entry.name}</span>
                      {!entry.isDir && (
                        <span className="ml-auto text-[10px] text-outline shrink-0">{formatBytes(entry.sizeBytes)}</span>
                      )}
                    </button>
                    <button
                      type="button"
                      onClick={() => setConfirmDelete(relPath)}
                      title={`Delete ${entry.name}`}
                      className="opacity-0 group-hover:opacity-100 px-1 text-outline hover:text-error cursor-pointer"
                    >
                      <span className="material-symbols-outlined text-[16px]">delete</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        <div className="mt-3 pt-3 border-t border-white/10 space-y-2">
          <div className="flex items-center gap-1.5">
            <select
              value={newKind}
              onChange={(e) => setNewKind(e.target.value as 'file' | 'dir')}
              className={smallInputClass}
            >
              <option value="file">File</option>
              <option value="dir">Folder</option>
            </select>
            <input
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void createEntry();
              }}
              placeholder="new-file.txt"
              className={`${smallInputClass} flex-1 min-w-0`}
            />
            <button type="button" onClick={() => void createEntry()} disabled={!newName.trim()} className={primaryBtnClass}>
              <span className="material-symbols-outlined text-[16px]">add</span>
            </button>
          </div>
          {confirmDelete && (
            <div className="rounded-xl border border-error/40 bg-error/10 p-2.5 text-[11px] text-error space-y-2">
              <p className="break-all">Delete {confirmDelete}?</p>
              <div className="flex items-center gap-2">
                <button type="button" onClick={() => void deleteEntry(confirmDelete)} className="px-2.5 py-1 rounded-lg bg-error text-white font-bold cursor-pointer">
                  Delete
                </button>
                <button type="button" onClick={() => setConfirmDelete(null)} className="px-2.5 py-1 rounded-lg bg-white/10 cursor-pointer">
                  Cancel
                </button>
              </div>
            </div>
          )}
        </div>
      </section>

      <section className={`${cardClass} min-h-0 flex flex-col`}>
        <div className="flex items-center justify-between mb-2 gap-2">
          <h2 className="text-sm font-bold text-white flex items-center gap-2 min-w-0">
            <span className="material-symbols-outlined text-[18px] text-primary">edit_document</span>
            <span className="truncate font-mono text-xs">{openFile?.path || 'No file selected'}</span>
            {openFile?.dirty && <span className="text-[10px] text-amber-300 font-mono">unsaved</span>}
          </h2>
          <div className="flex items-center gap-1.5 shrink-0">
            <button
              type="button"
              onClick={() => void saveFile()}
              disabled={!openFile || !openFile.dirty || saving}
              className={primaryBtnClass}
            >
              <span className="material-symbols-outlined text-[16px]">save</span>
              {saving ? 'Saving…' : 'Save'}
            </button>
          </div>
        </div>
        {openFile ? (
          <textarea
            value={openFile.content}
            onChange={(e) => setOpenFile({ ...openFile, content: e.target.value, dirty: true })}
            spellCheck={false}
            className="flex-1 min-h-0 w-full resize-none bg-surface-lowest border border-white/15 focus:border-primary rounded-xl p-3 text-[11.5px] font-mono text-white focus:outline-none"
          />
        ) : (
          <div className="flex-1 min-h-0 rounded-xl border border-dashed border-white/15 grid place-items-center text-xs text-outline px-6 text-center">
            Pick a file on the left to view or edit it. Text files up to 5 MB open here; binary files
            (jars, worlds) stay untouched.
          </div>
        )}
      </section>
    </div>
  );
};
