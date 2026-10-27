import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { ServerInstance } from '../types';

interface DirEntry {
  name: string;
  isDir: boolean;
  sizeBytes: number;
  modifiedAt: string;
}

interface OpenFile {
  path: string;
  name: string;
  content: string;
  sizeBytes: number;
  modifiedAt: string;
}

interface FileManagerViewProps {
  server: ServerInstance;
  selectedFilePath?: string | null;
  onShowToast: (
    title: string,
    body?: string,
    type?: 'success' | 'info' | 'warning' | 'error',
    icon?: string,
  ) => void;
  onFilesChanged?: () => void;
}

const formatBytes = (bytes: number): string => {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
};

const iconFor = (entry: { name: string; isDir: boolean }): { icon: string; color: string } => {
  if (entry.isDir) return { icon: 'folder', color: 'text-primary' };
  const name = entry.name.toLowerCase();
  if (name.endsWith('.jar')) return { icon: 'deployed_code', color: 'text-tertiary' };
  if (name.endsWith('.properties') || name.endsWith('.yml') || name.endsWith('.yaml'))
    return { icon: 'tune', color: 'text-secondary' };
  if (name.endsWith('.json') || name.endsWith('.json5'))
    return { icon: 'data_object', color: 'text-primary' };
  if (name.endsWith('.log') || name.endsWith('.gz'))
    return { icon: 'receipt_long', color: 'text-on-surface-variant' };
  if (name.endsWith('.sh') || name.endsWith('.bat'))
    return { icon: 'terminal', color: 'text-primary-fixed' };
  return { icon: 'description', color: 'text-on-surface-variant' };
};

const isTextual = (name: string): boolean =>
  /\.(txt|log|properties|yml|yaml|json|json5|toml|conf|cfg|ini|sh|bat|mcmeta|md|xml|html|css|js|ts|env)$/i.test(
    name,
  );

export const FileManagerView: React.FC<FileManagerViewProps> = ({
  server,
  selectedFilePath,
  onShowToast,
  onFilesChanged,
}) => {
  const [currentPath, setCurrentPath] = useState<string>('.');
  const [entries, setEntries] = useState<DirEntry[]>([]);
  const [dirStatus, setDirStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [dirError, setDirError] = useState<string>('');
  const [openFiles, setOpenFiles] = useState<OpenFile[]>([]);
  const [activePath, setActivePath] = useState<string>('');
  const [draftContent, setDraftContent] = useState<string>('');
  const [isEditing, setIsEditing] = useState(false);
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved'>('idle');
  const [searchQuery, setSearchQuery] = useState('');
  const [newFileModalOpen, setNewFileModalOpen] = useState(false);
  const [newFileName, setNewFileName] = useState('');

  const serverQuery = `serverId=${encodeURIComponent(server.id)}&serverName=${encodeURIComponent(
    server.name,
  )}`;

  const loadDir = useCallback(
    async (rel: string) => {
      setDirStatus('loading');
      try {
        const res = await fetch(
          `/api/server-runtime/files?${serverQuery}&path=${encodeURIComponent(rel)}`,
        );
        const data = await res.json();
        if (!data?.ok) {
          setDirStatus('error');
          setDirError(String(data?.error || 'Folder not found'));
          setEntries([]);
          return;
        }
        setCurrentPath(String(data.path || '.'));
        setEntries(
          (data.entries || []).map((e: DirEntry) => ({
            name: String(e.name),
            isDir: Boolean(e.isDir),
            sizeBytes: Number(e.sizeBytes) || 0,
            modifiedAt: String(e.modifiedAt || ''),
          })),
        );
        setDirStatus('ready');
        setDirError('');
      } catch (err) {
        setDirStatus('error');
        setDirError(err instanceof Error ? err.message : 'Backend unreachable');
        setEntries([]);
      }
    },
    [serverQuery],
  );

  useEffect(() => {
    setOpenFiles([]);
    setActivePath('');
    setDraftContent('');
    setIsEditing(false);
    void loadDir('.');
  }, [server.id, loadDir]);

  const openFile = useCallback(
    async (rel: string, name: string) => {
      const existing = openFiles.find((f) => f.path === rel);
      if (existing) {
        setActivePath(rel);
        setDraftContent(existing.content);
        setIsEditing(false);
        return;
      }
      try {
        const res = await fetch(
          `/api/server-runtime/file?${serverQuery}&path=${encodeURIComponent(rel)}`,
        );
        const data = await res.json();
        if (!data?.ok) {
          onShowToast('Cannot open file', String(data?.error || 'Unreadable'), 'error', 'error');
          return;
        }
        const file: OpenFile = {
          path: String(data.path || rel),
          name,
          content: String(data.content ?? ''),
          sizeBytes: Number(data.sizeBytes) || 0,
          modifiedAt: String(data.modifiedAt || ''),
        };
        setOpenFiles((prev) => [...prev.filter((f) => f.path !== file.path), file].slice(-8));
        setActivePath(file.path);
        setDraftContent(file.content);
        setIsEditing(false);
      } catch (err) {
        onShowToast(
          'Cannot open file',
          err instanceof Error ? err.message : 'Backend unreachable',
          'error',
          'error',
        );
      }
    },
    [onShowToast, openFiles, serverQuery],
  );

  // Deep link from the command palette (path relative to the server folder).
  useEffect(() => {
    if (!selectedFilePath) return;
    const name = selectedFilePath.split('/').pop() || selectedFilePath;
    if (!isTextual(name)) return;
    void openFile(selectedFilePath, name);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedFilePath]);

  const activeFile = openFiles.find((f) => f.path === activePath);
  const isDirty = Boolean(activeFile) && draftContent !== (activeFile?.content ?? '');

  const handleSave = useCallback(async () => {
    if (!activeFile) return;
    setSaveState('saving');
    try {
      const res = await fetch('/api/server-runtime/file', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          serverId: server.id,
          serverName: server.name,
          path: activeFile.path,
          content: draftContent,
        }),
      });
      const data = await res.json();
      if (!data?.ok) {
        setSaveState('idle');
        onShowToast('Save failed', String(data?.error || 'Unknown error'), 'error', 'error');
        return;
      }
      setOpenFiles((prev) =>
        prev.map((f) =>
          f.path === activeFile.path
            ? {
                ...f,
                content: draftContent,
                sizeBytes: Number(data.bytes) || f.sizeBytes,
                modifiedAt: new Date().toISOString(),
              }
            : f,
        ),
      );
      setIsEditing(false);
      setSaveState('saved');
      onShowToast(
        `Saved ${activeFile.name}`,
        `${Number(data.bytes) || draftContent.length} bytes written to ${activeFile.path} on disk.`,
        'success',
        'check_circle',
      );
      onFilesChanged?.();
      void loadDir(currentPath);
      setTimeout(() => setSaveState('idle'), 1800);
    } catch (err) {
      setSaveState('idle');
      onShowToast(
        'Save failed',
        err instanceof Error ? err.message : 'Backend unreachable',
        'error',
        'error',
      );
    }
  }, [
    activeFile,
    currentPath,
    draftContent,
    loadDir,
    onFilesChanged,
    onShowToast,
    server.id,
    server.name,
  ]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        void handleSave();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [handleSave]);

  const handleCreateNewFile = async (e: React.FormEvent) => {
    e.preventDefault();
    const clean = newFileName.trim().replace(/[\\/]+/g, '');
    if (!clean) return;
    const rel = currentPath === '.' ? clean : `${currentPath}/${clean}`;
    try {
      const res = await fetch('/api/server-runtime/file-create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          serverId: server.id,
          serverName: server.name,
          path: rel,
          kind: 'file',
          content: '',
        }),
      });
      const data = await res.json();
      if (!data?.ok) {
        onShowToast('Create failed', String(data?.error || 'Unknown error'), 'error', 'error');
        return;
      }
      setNewFileName('');
      setNewFileModalOpen(false);
      onShowToast('File created', `${rel} was written to disk.`, 'success', 'note_add');
      onFilesChanged?.();
      await loadDir(currentPath);
      await openFile(rel, clean);
    } catch (err) {
      onShowToast(
        'Create failed',
        err instanceof Error ? err.message : 'Backend unreachable',
        'error',
        'error',
      );
    }
  };

  const handleDeleteActive = async () => {
    if (!activeFile) return;
    if (!window.confirm(`Delete ${activeFile.path} from disk? This cannot be undone.`)) return;
    try {
      const res = await fetch('/api/server-runtime/file-delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          serverId: server.id,
          serverName: server.name,
          path: activeFile.path,
        }),
      });
      const data = await res.json();
      if (!data?.ok) {
        onShowToast('Delete failed', String(data?.error || 'Unknown error'), 'error', 'error');
        return;
      }
      setOpenFiles((prev) => prev.filter((f) => f.path !== activeFile.path));
      setActivePath('');
      setDraftContent('');
      setIsEditing(false);
      onShowToast('Deleted', `${activeFile.path} was removed from disk.`, 'warning', 'delete');
      onFilesChanged?.();
      void loadDir(currentPath);
    } catch (err) {
      onShowToast(
        'Delete failed',
        err instanceof Error ? err.message : 'Backend unreachable',
        'error',
        'error',
      );
    }
  };

  const closeTab = (e: React.MouseEvent, path: string) => {
    e.stopPropagation();
    setOpenFiles((prev) => prev.filter((f) => f.path !== path));
    if (activePath === path) {
      const remaining = openFiles.filter((f) => f.path !== path);
      setActivePath(remaining[0]?.path || '');
      setDraftContent(remaining[0]?.content || '');
      setIsEditing(false);
    }
  };

  const breadcrumbs = useMemo(() => {
    if (currentPath === '.' || currentPath === '') return [];
    return currentPath.split('/').filter(Boolean);
  }, [currentPath]);

  const visibleEntries = useMemo(
    () =>
      entries.filter(
        (e) => !searchQuery || e.name.toLowerCase().includes(searchQuery.toLowerCase()),
      ),
    [entries, searchQuery],
  );

  const lines = (activeFile ? draftContent : '').split('\n');
  const fileCount = entries.filter((e) => !e.isDir).length;
  const folderCount = entries.length - fileCount;

  const renderHighlightedLine = (line: string, index: number) => {
    const trimmed = line.trim();
    if (!activeFile) return null;
    if (trimmed.startsWith('#') || trimmed.startsWith(';')) {
      return (
        <div key={index} className="whitespace-pre text-on-surface-variant/60 italic">
          {line || ' '}
        </div>
      );
    }
    if (line.includes('=')) {
      const eqIdx = line.indexOf('=');
      return (
        <div key={index} className="whitespace-pre">
          <span className="text-primary font-semibold">{line.slice(0, eqIdx + 1)}</span>
          <span className="text-tertiary">{line.slice(eqIdx + 1)}</span>
        </div>
      );
    }
    if (line.includes(':')) {
      const colonIdx = line.indexOf(':');
      const val = line.slice(colonIdx + 1).trim();
      return (
        <div key={index} className="whitespace-pre">
          <span className="text-primary font-semibold">{line.slice(0, colonIdx + 1)}</span>
          <span
            className={
              val === 'true' || val === 'false'
                ? 'text-secondary font-bold'
                : val.startsWith('"') || val.startsWith("'")
                  ? 'text-secondary'
                  : 'text-tertiary'
            }
          >
            {line.slice(colonIdx + 1)}
          </span>
        </div>
      );
    }
    return (
      <div key={index} className="whitespace-pre text-on-surface">
        {line || ' '}
      </div>
    );
  };

  return (
    <div className="flex flex-col w-full gap-5">
      {/* TOP PATH BAR */}
      <div className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center justify-between gap-3 bg-surface border border-white/[0.06] px-4 h-[52px] rounded-xl">
          <div className="flex items-center gap-2.5 min-w-0 flex-1">
            <span className="material-symbols-outlined text-[17px] text-primary shrink-0">
              folder_open
            </span>
            <h1 className="text-[14.5px] font-semibold text-on-surface whitespace-nowrap">Files</h1>
            <span className="w-px h-4 bg-white/10 shrink-0" />
            <nav
              aria-label="Breadcrumb"
              className="flex items-center flex-wrap gap-1.5 font-code-md text-code-md min-w-0"
            >
              <button
                type="button"
                onClick={() => void loadDir('.')}
                className="text-primary hover:text-white transition-colors flex items-center gap-1 cursor-pointer"
              >
                <span className="material-symbols-outlined text-sm">hard_drive</span>
                <span>{server.name}</span>
              </button>
              {breadcrumbs.map((seg, idx) => {
                const rel = breadcrumbs.slice(0, idx + 1).join('/');
                return (
                  <React.Fragment key={rel}>
                    <span className="text-on-surface-variant/40">/</span>
                    <button
                      type="button"
                      onClick={() => void loadDir(rel)}
                      className="text-on-surface-variant hover:text-white transition-colors truncate max-w-[160px] cursor-pointer"
                    >
                      {seg}
                    </button>
                  </React.Fragment>
                );
              })}
              {activeFile && (
                <>
                  <span className="text-on-surface-variant/40">/</span>
                  <span className="text-primary font-semibold flex items-center gap-1 bg-surface-container-highest px-2 py-0.5 rounded text-code-sm">
                    <span className="size-1.5 rounded-full bg-primary animate-pulse" />
                    {activeFile.name}
                  </span>
                </>
              )}
            </nav>
          </div>

          <div className="flex items-center gap-3 shrink-0">
            <div className="flex items-center gap-2 px-2.5 h-7 rounded-lg border border-white/[0.06] bg-white/[0.02] font-mono text-[11px]">
              <span
                className={`size-1.5 rounded-full ${
                  dirStatus === 'ready'
                    ? 'bg-secondary'
                    : dirStatus === 'error'
                      ? 'bg-error'
                      : 'bg-primary animate-pulse'
                }`}
              />
              <span className="text-outline">
                {dirStatus === 'ready'
                  ? 'Live filesystem'
                  : dirStatus === 'error'
                    ? 'Disk unavailable'
                    : 'Reading disk…'}
              </span>
            </div>
            <div className="kp-chip">
              {folderCount} folders · {fileCount} files
            </div>
          </div>
        </div>

        {/* ACTIONS + FILTER */}
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-3 items-center">
          <div className="lg:col-span-8 flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => setNewFileModalOpen(true)}
              className="inline-flex items-center gap-1.5 h-8 px-3 rounded-lg border border-white/10 bg-white/[0.02] hover:bg-white/[0.06] text-[11.5px] font-medium text-on-surface transition-colors cursor-pointer"
            >
              <span className="material-symbols-outlined text-[16px] text-outline">note_add</span>
              <span>New File</span>
            </button>
            <button
              type="button"
              onClick={() => void loadDir(currentPath)}
              className="inline-flex items-center gap-1.5 h-8 px-3 rounded-lg border border-white/10 bg-white/[0.02] hover:bg-white/[0.06] text-[11.5px] font-medium text-on-surface transition-colors cursor-pointer"
            >
              <span className="material-symbols-outlined text-[16px] text-outline">sync</span>
              <span>Reload</span>
            </button>
            <button
              type="button"
              onClick={() => void handleDeleteActive()}
              disabled={!activeFile}
              className={`inline-flex items-center gap-1.5 h-8 px-3 rounded-lg border text-[11.5px] font-medium transition-colors ${
                activeFile
                  ? 'border-error/25 bg-error-container/10 hover:bg-error-container/25 text-error cursor-pointer'
                  : 'border-white/5 bg-white/[0.01] text-white/25 cursor-not-allowed'
              }`}
            >
              <span className="material-symbols-outlined text-[16px]">delete</span>
              <span>Delete</span>
            </button>
            {currentPath !== '.' && (
              <button
                type="button"
                onClick={() =>
                  void loadDir(
                    currentPath.includes('/')
                      ? currentPath.slice(0, currentPath.lastIndexOf('/'))
                      : '.',
                  )
                }
                className="inline-flex items-center gap-1.5 h-8 px-3 rounded-lg border border-white/10 bg-white/[0.02] hover:bg-white/[0.06] text-[11.5px] font-medium text-on-surface transition-colors cursor-pointer"
              >
                <span className="material-symbols-outlined text-[16px] text-outline">arrow_upward</span>
                <span>Up</span>
              </button>
            )}
          </div>

          <div className="lg:col-span-4 relative">
            <div className="relative flex items-center">
              <span className="material-symbols-outlined absolute left-3 text-on-surface-variant/60 text-lg">
                search
              </span>
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="w-full h-8 bg-surface-container-lowest border border-white/10 pl-9 pr-3 rounded-lg font-mono text-[11.5px] text-on-surface placeholder:text-outline/70 focus:outline-none focus:border-primary/50"
                placeholder="Filter this folder…"
              />
            </div>
          </div>
        </div>
      </div>

      {/* DUAL PANE */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-5 items-start">
        {/* LEFT: REAL DIRECTORY LISTING */}
        <div className="lg:col-span-4 bg-surface border border-white/[0.06] rounded-xl flex flex-col overflow-hidden">
          <div className="px-3.5 h-11 bg-surface-container flex items-center justify-between border-b border-white/[0.06]">
            <div className="flex items-center gap-2">
              <span className="material-symbols-outlined text-primary text-base">account_tree</span>
              <span className="font-headline-sm text-body-md text-white font-semibold">
                Instance File System
              </span>
            </div>
            <span className="text-label-caps font-label-caps text-on-surface-variant">
              /{currentPath === '.' ? '' : currentPath}
            </span>
          </div>

          <div className="px-3.5 py-2 bg-surface-container-lowest flex items-center justify-between text-label-caps font-label-caps text-on-surface-variant">
            <span>NAME</span>
            <span>SIZE</span>
          </div>

          <div className="p-2 space-y-0.5 max-h-[640px] overflow-y-auto select-none font-code-sm text-code-sm">
            {dirStatus === 'loading' && (
              <div className="p-3 text-on-surface-variant flex items-center gap-2">
                <span className="material-symbols-outlined text-base animate-spin">refresh</span>
                Reading server folder…
              </div>
            )}
            {dirStatus === 'error' && (
              <div className="p-3 text-error text-code-sm space-y-1">
                <div className="font-semibold">Could not read the server folder</div>
                <div className="text-on-surface-variant">{dirError}</div>
              </div>
            )}
            {dirStatus === 'ready' && visibleEntries.length === 0 && (
              <div className="p-3 text-on-surface-variant">This folder is empty.</div>
            )}
            {dirStatus === 'ready' &&
              visibleEntries.map((entry) => {
                const meta = iconFor(entry);
                const rel = currentPath === '.' ? entry.name : `${currentPath}/${entry.name}`;
                const isSelected = !entry.isDir && activePath === rel;
                return (
                  <div
                    key={rel}
                    onClick={() =>
                      entry.isDir
                        ? void loadDir(rel)
                        : isTextual(entry.name)
                          ? void openFile(rel, entry.name)
                          : onShowToast(
                              'Binary file',
                              `${entry.name} cannot be edited as text in the browser.`,
                              'info',
                              'deployed_code',
                            )
                    }
                    className={`flex items-center justify-between p-2 rounded-lg transition-colors cursor-pointer ${
                      isSelected
                        ? 'bg-primary text-on-primary font-semibold '
                        : 'hover:bg-surface-container text-on-surface'
                    }`}
                    title={
                      entry.modifiedAt
                        ? `Modified ${new Date(entry.modifiedAt).toLocaleString()}`
                        : undefined
                    }
                  >
                    <div className="flex items-center gap-2 min-w-0">
                      <span
                        className={`material-symbols-outlined text-base ${
                          isSelected ? 'text-on-primary' : meta.color
                        }`}
                      >
                        {meta.icon}
                      </span>
                      <span className="truncate">{entry.name}</span>
                    </div>
                    <span
                      className={`shrink-0 ml-2 ${
                        isSelected ? 'text-on-primary' : 'text-on-surface-variant'
                      }`}
                    >
                      {entry.isDir ? 'dir' : formatBytes(entry.sizeBytes)}
                    </span>
                  </div>
                );
              })}
          </div>

          <div className="p-3 bg-surface-container flex items-center justify-between text-code-sm font-code-sm text-on-surface-variant">
            <div className="flex items-center gap-2">
              <span className="size-2 rounded-full bg-secondary" />
              <span>{entries.length} entries on disk</span>
            </div>
            <span className="font-mono text-label-caps font-label-caps text-primary">
              {dirStatus === 'ready' ? 'Live' : '—'}
            </span>
          </div>
        </div>

        {/* RIGHT: EDITOR */}
        <div className="lg:col-span-8 bg-surface border border-white/[0.06] rounded-xl flex flex-col overflow-hidden">
          <div className="bg-surface-container flex items-center justify-between px-2 pt-2 border-b border-white/[0.06]">
            <div className="flex items-center gap-1 overflow-x-auto min-w-0">
              {openFiles.length === 0 && (
                <span className="px-3 py-2 text-code-sm text-on-surface-variant">
                  Open a file from the listing to edit it.
                </span>
              )}
              {openFiles.map((tab) => {
                const isTabActive = tab.path === activePath;
                return (
                  <div
                    key={tab.path}
                    onClick={() => {
                      setActivePath(tab.path);
                      setDraftContent(isTabActive ? draftContent : tab.content);
                      setIsEditing(false);
                    }}
                    className={`flex items-center gap-2 px-3.5 py-2 rounded-t-lg font-code-sm text-code-sm cursor-pointer shrink-0 transition-colors ${
                      isTabActive
                        ? 'bg-surface-container-lowest text-white '
                        : 'bg-surface-container/60 hover:bg-surface-container-high text-on-surface-variant hover:text-white'
                    }`}
                  >
                    <span
                      className={`material-symbols-outlined text-sm ${isTabActive ? 'text-primary' : ''}`}
                    >
                      {iconFor({ name: tab.name, isDir: false }).icon}
                    </span>
                    <span className={isTabActive ? 'font-semibold text-primary' : ''}>
                      {tab.name}
                    </span>
                    {isTabActive && isDirty && (
                      <span className="size-2 rounded-full bg-primary" title="Unsaved edits" />
                    )}
                    <button
                      type="button"
                      onClick={(e) => closeTab(e, tab.path)}
                      className="hover:bg-surface-container-high rounded p-0.5 text-on-surface-variant hover:text-white"
                    >
                      <span className="material-symbols-outlined text-xs">close</span>
                    </button>
                  </div>
                );
              })}
            </div>

            <div className="flex items-center gap-1 shrink-0 pb-1.5 pr-1">
              <button
                type="button"
                onClick={() => setIsEditing(!isEditing)}
                disabled={!activeFile}
                className={`px-2 py-1 rounded-lg text-code-sm font-code-sm transition-colors flex items-center gap-1 ${
                  isEditing
                    ? 'bg-primary text-on-primary font-bold'
                    : 'bg-surface-container-high/60 hover:bg-surface-container-high text-on-surface-variant hover:text-white'
                } ${activeFile ? 'cursor-pointer' : 'opacity-40 cursor-not-allowed'}`}
                title="Toggle edit mode"
              >
                <span className="material-symbols-outlined text-sm">edit_note</span>
                <span>{isEditing ? 'Editing' : 'Edit'}</span>
              </button>
            </div>
          </div>

          <div className="px-4 py-2.5 bg-surface-container-lowest flex flex-wrap items-center justify-between gap-3 font-code-sm text-code-sm border-b border-white/[0.06]">
            <div className="flex items-center gap-3 min-w-0">
              <div className="flex items-center gap-1.5 px-2.5 py-1 rounded bg-surface-container text-on-surface-variant">
                <span className="material-symbols-outlined text-sm">folder_open</span>
                <span className="truncate max-w-[280px]">
                  {activeFile ? activeFile.path : 'No file selected'}
                </span>
              </div>
              {activeFile && (
                <>
                  <span className="text-on-surface-variant/40 hidden sm:inline">•</span>
                  <div className="text-on-surface-variant flex items-center gap-1">
                    <span className="material-symbols-outlined text-xs">history</span>
                    <span>
                      Modified{' '}
                      {activeFile.modifiedAt
                        ? new Date(activeFile.modifiedAt).toLocaleString()
                        : 'unknown'}
                    </span>
                  </div>
                </>
              )}
            </div>
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                onClick={() => {
                  if (!activeFile) return;
                  setDraftContent(activeFile.content);
                  setIsEditing(false);
                  onShowToast(
                    'Changes discarded',
                    `Reverted ${activeFile.name} to the saved disk state.`,
                    'info',
                  );
                }}
                disabled={!activeFile}
                className={`px-2.5 py-1 rounded bg-surface-container hover:bg-surface-container-high text-on-surface transition-colors ${
                  activeFile ? 'cursor-pointer' : 'opacity-40 cursor-not-allowed'
                }`}
              >
                Discard
              </button>
            </div>
          </div>

          <div className="relative bg-surface-container-lowest overflow-x-auto min-h-[460px] p-4 font-code-md text-code-md">
            {!activeFile && (
              <div className="text-on-surface-variant text-code-md">
                Pick any text file on the left to load its real contents from disk.
              </div>
            )}
            {activeFile && isEditing && (
              <textarea
                value={draftContent}
                onChange={(e) => setDraftContent(e.target.value)}
                className="w-full min-h-[430px] bg-surface-container-lowest text-on-surface font-mono text-code-md focus:outline-none resize-y leading-relaxed"
                spellCheck={false}
              />
            )}
            {activeFile && !isEditing && (
              <div
                onClick={() => setIsEditing(true)}
                title="Click to edit"
                className="flex gap-4 cursor-text"
              >
                <div className="flex flex-col text-right text-on-surface-variant/40 select-none pr-3 space-y-1 font-mono">
                  {lines.map((_, idx) => (
                    <span key={idx}>{idx + 1}</span>
                  ))}
                </div>
                <div className="flex flex-col flex-1 space-y-1 text-on-surface font-mono overflow-x-auto">
                  {lines.map((line, idx) => (
                    <React.Fragment key={idx}>{renderHighlightedLine(line, idx)}</React.Fragment>
                  ))}
                </div>
              </div>
            )}
          </div>

          <div className="px-3 h-11 bg-surface-container flex flex-wrap items-center justify-between gap-3 border-t border-white/[0.06]">
            <div className="flex items-center flex-wrap gap-4 font-mono text-[11px] text-outline">
              <div className="flex items-center gap-1.5">
                <span className="material-symbols-outlined text-xs text-primary">list</span>
                <span className="text-white font-medium">
                  {activeFile ? `${lines.length} lines` : '—'}
                </span>
              </div>
              <span className="text-on-surface-variant/40">•</span>
              <span>{activeFile ? formatBytes(new Blob([draftContent]).size) : '—'}</span>
              <span className="text-on-surface-variant/40">•</span>
              <span>UTF-8</span>
              {isDirty && (
                <>
                  <span className="text-on-surface-variant/40">•</span>
                  <span className="bg-primary/15 text-primary px-2 py-0.5 rounded text-label-caps font-label-caps">
                    Unsaved edits
                  </span>
                </>
              )}
            </div>

            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => void handleSave()}
                disabled={!activeFile}
                className={`flex items-center gap-2 h-8 px-3 rounded-lg text-[11.5px] font-semibold transition-all ${
                  !activeFile
                    ? 'bg-surface-container-high text-on-surface-variant/50 cursor-not-allowed'
                    : saveState === 'saved'
                      ? 'bg-secondary text-on-secondary cursor-pointer'
                      : 'bg-primary text-on-primary hover:brightness-105 cursor-pointer'
                }`}
              >
                {saveState === 'saving' && (
                  <>
                    <span className="material-symbols-outlined text-base animate-spin">
                      refresh
                    </span>
                    <span>Writing to disk…</span>
                  </>
                )}
                {saveState === 'saved' && (
                  <>
                    <span className="material-symbols-outlined text-base">check_circle</span>
                    <span>Saved</span>
                  </>
                )}
                {saveState === 'idle' && (
                  <>
                    <span className="material-symbols-outlined text-base">save</span>
                    <span>Save Changes (Ctrl+S)</span>
                  </>
                )}
              </button>
            </div>
          </div>
        </div>
      </div>

      {newFileModalOpen && (
        <div className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-center justify-center p-4">
          <form
            onSubmit={handleCreateNewFile}
            className="bg-surface-container-low border border-white/[0.08] rounded-xl max-w-md w-full p-5 space-y-4"
          >
            <div className="flex items-center justify-between">
              <h3 className="font-headline-sm text-white font-bold flex items-center gap-2">
                <span className="material-symbols-outlined text-primary">note_add</span>
                <span>Create file in /{currentPath === '.' ? '' : currentPath}</span>
              </h3>
              <button
                type="button"
                onClick={() => setNewFileModalOpen(false)}
                className="text-on-surface-variant hover:text-white"
              >
                <span className="material-symbols-outlined">close</span>
              </button>
            </div>
            <div>
              <label className="block text-label-caps uppercase text-outline mb-1">File Name</label>
              <input
                type="text"
                value={newFileName}
                onChange={(e) => setNewFileName(e.target.value)}
                placeholder="custom-rules.yml"
                className="w-full bg-surface-container rounded-lg p-2.5 text-white font-mono text-xs border border-white/[0.08] focus:outline-none focus:border-primary"
                autoFocus
              />
            </div>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setNewFileModalOpen(false)}
                className="px-3.5 py-2 rounded-lg bg-surface-container text-on-surface text-xs"
              >
                Cancel
              </button>
              <button
                type="submit"
                className="px-4 py-2 rounded-lg bg-primary text-on-primary font-bold text-xs"
              >
                Create File
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
};
