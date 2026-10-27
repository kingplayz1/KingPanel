import React, { useState, useEffect, useRef } from 'react';

export interface LocalDriveItem {
  id: string;
  driveLetter: string;
  rootPath: string;
  label: string;
  fileSystem: string;
  totalGb: number;
  usedGb: number;
  freeGb: number;
  usedPct: number;
  recommendedPath: string;
}

export interface QuickAccessItem {
  label: string;
  path: string;
  icon: string;
}

export interface ExplorerFolderEntry {
  name: string;
  fullPath: string;
  modifiedAt: string;
  itemCount: number;
  isServerFolder?: boolean;
}

interface LocalDiskFolderPickerModalProps {
  isOpen: boolean;
  initialPath?: string;
  title?: string;
  onClose: () => void;
  onSelectFolder: (selectedPath: string) => void;
}

export const LocalDiskFolderPickerModal: React.FC<LocalDiskFolderPickerModalProps> = ({
  isOpen,
  initialPath = 'C:\\KingServers',
  title = 'Select Disk & Folder from Local PC',
  onClose,
  onSelectFolder,
}) => {
  const [drives, setDrives] = useState<LocalDriveItem[]>([]);
  const [quickAccess, setQuickAccess] = useState<QuickAccessItem[]>([]);
  const [hostname, setHostname] = useState<string>('LOCAL-PC');
  const [currentPath, setCurrentPath] = useState<string>(initialPath || 'C:\\');
  const [parentPath, setParentPath] = useState<string | null>(null);
  const [folders, setFolders] = useState<ExplorerFolderEntry[]>([]);
  const [selectedFolderPath, setSelectedFolderPath] = useState<string>(
    initialPath || 'C:\\KingServers',
  );
  const [loading, setLoading] = useState<boolean>(false);
  const [newFolderMode, setNewFolderMode] = useState<boolean>(false);
  const [newFolderName, setNewFolderName] = useState<string>('');
  const [addressBarInput, setAddressBarInput] = useState<string>(initialPath || 'C:\\');

  const nativeDirInputRef = useRef<HTMLInputElement | null>(null);

  const loadDrivesAndInitialFolder = async (startPath: string) => {
    setLoading(true);
    try {
      const drvRes = await fetch('/api/system/local-drives');
      const drvData = await drvRes.json();
      if (drvRes.ok && drvData?.ok) {
        setDrives(drvData.drives || []);
        setQuickAccess(drvData.quickAccess || []);
        setHostname(drvData.hostname || 'LOCAL-PC');
      }
    } catch {
      // fallback
    }
    await browseToPath(startPath);
    setLoading(false);
  };

  const browseToPath = async (targetPath: string, createName?: string) => {
    setLoading(true);
    try {
      const res = await fetch('/api/system/browse-folders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          currentPath: targetPath,
          createFolderName: createName,
        }),
      });
      const data = await res.json();
      if (res.ok && data?.ok) {
        setCurrentPath(data.currentPath);
        setAddressBarInput(data.currentPath);
        setParentPath(data.parentPath || null);
        setFolders(data.folders || []);
        setSelectedFolderPath(data.currentPath);
      }
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (isOpen) {
      const start = initialPath || 'C:\\';
      setSelectedFolderPath(start);
      loadDrivesAndInitialFolder(start);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);

  if (!isOpen) return null;

  const handleCreateNewFolder = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = newFolderName.trim();
    if (!trimmed) return;
    await browseToPath(currentPath, trimmed);
    const sep = currentPath.startsWith('/')
      ? currentPath.endsWith('/')
        ? ''
        : '/'
      : currentPath.endsWith('\\')
        ? ''
        : '\\';
    const createdFullPath = `${currentPath}${sep}${trimmed.replace(/[<>:"/\\|?*]/g, '_')}`;
    setSelectedFolderPath(createdFullPath);
    setNewFolderName('');
    setNewFolderMode(false);
  };

  // Trigger real OS native directory picker if supported by browser or fallback to webkitdirectory
  const handleOpenNativeOsFolderPicker = async () => {
    try {
      const winAny = window as unknown as {
        showDirectoryPicker?: () => Promise<{ name: string }>;
      };
      if (typeof winAny.showDirectoryPicker === 'function') {
        const dirHandle = await winAny.showDirectoryPicker();
        if (dirHandle && dirHandle.name) {
          const baseDrive = currentPath.match(/^[A-Za-z]:\\/) ? currentPath.slice(0, 3) : 'C:\\';
          const resolvedNativePath = `${baseDrive}${dirHandle.name}`;
          setSelectedFolderPath(resolvedNativePath);
          setAddressBarInput(resolvedNativePath);
          await browseToPath(baseDrive, dirHandle.name);
          setSelectedFolderPath(resolvedNativePath);
          return;
        }
      }
    } catch {
      // User cancelled or iframe blocked showDirectoryPicker; fallback to input[webkitdirectory]
    }
    nativeDirInputRef.current?.click();
  };

  const handleWebkitDirectoryChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const fileList = e.target.files;
    if (!fileList || fileList.length === 0) return;
    const firstFile = fileList[0] as File & { webkitRelativePath?: string };
    const relPath = firstFile.webkitRelativePath || firstFile.name || 'Selected_Server_Folder';
    const folderName = relPath.split('/')[0] || 'Selected_Server_Folder';
    const baseDrive = currentPath.match(/^[A-Za-z]:\\/) ? currentPath.slice(0, 3) : 'C:\\';
    const resolvedPath = `${baseDrive}${folderName}`;
    await browseToPath(baseDrive, folderName);
    setSelectedFolderPath(resolvedPath);
    setAddressBarInput(resolvedPath);
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4 select-none">
      <div className="w-full max-w-4xl rounded-xl bg-[#111520] border border-white/15 overflow-hidden flex flex-col max-h-[88vh]">
        {/* Windows 11 Explorer Modal Title Bar */}
        <div className="px-4 py-3 bg-[#0b0e17] border-b border-white/[0.08] flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <span className="material-symbols-outlined text-primary text-lg">folder_open</span>
            <div>
              <h3 className="text-xs font-bold text-white tracking-wide">{title}</h3>
              <p className="text-[10px] font-mono text-on-surface-variant">
                This PC ({hostname}) • Select local disk or folder path
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            {/* Hidden native directory input for fallback */}
            <input
              ref={nativeDirInputRef}
              type="file"
              // @ts-expect-error webkitdirectory is standard in Chromium/Windows browsers
              webkitdirectory="true"
              directory="true"
              multiple
              className="hidden"
              onChange={handleWebkitDirectoryChange}
            />
            <button
              type="button"
              onClick={handleOpenNativeOsFolderPicker}
              className="px-3 py-1.5 rounded-lg bg-primary/15 hover:bg-primary/25 border border-primary/40 text-primary text-[11px] font-bold flex items-center gap-1.5 transition-colors cursor-pointer"
              title="Open your PC's native Windows Folder Dialog"
            >
              <span className="material-symbols-outlined text-xs">laptop_windows</span>
              <span>Browse Native PC Dialog</span>
            </button>

            <button
              type="button"
              onClick={onClose}
              className="size-7 rounded-lg bg-white/5 hover:bg-error/20 hover:text-error text-on-surface-variant flex items-center justify-center transition-colors cursor-pointer"
            >
              <span className="material-symbols-outlined text-sm">close</span>
            </button>
          </div>
        </div>

        {/* Windows Explorer Navigation & Address Bar */}
        <div className="px-4 py-2.5 bg-[#151a28] border-b border-white/[0.08] flex flex-wrap items-center gap-2">
          <button
            type="button"
            disabled={!parentPath || loading}
            onClick={() => parentPath && browseToPath(parentPath)}
            className="p-1.5 rounded-lg bg-surface-container-lowest border border-white/[0.08] text-on-surface-variant hover:text-white disabled:opacity-35 cursor-pointer"
            title="Up One Level"
          >
            <span className="material-symbols-outlined text-sm">arrow_upward</span>
          </button>

          <button
            type="button"
            onClick={() => browseToPath(currentPath)}
            className="p-1.5 rounded-lg bg-surface-container-lowest border border-white/[0.08] text-on-surface-variant hover:text-white cursor-pointer"
            title="Refresh"
          >
            <span className="material-symbols-outlined text-sm">refresh</span>
          </button>

          {/* Address Bar Input */}
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (addressBarInput.trim()) {
                browseToPath(addressBarInput.trim());
              }
            }}
            className="flex-1 flex items-center bg-[#0b0e17] border border-white/15 focus-within:border-primary/50 rounded-lg px-3 py-1.5 gap-2"
          >
            <span className="material-symbols-outlined text-xs text-primary">hard_drive</span>
            <input
              type="text"
              value={addressBarInput}
              onChange={(e) => setAddressBarInput(e.target.value)}
              placeholder="C:\KingServers"
              className="flex-1 bg-transparent text-xs font-mono text-white focus:outline-none"
            />
            <button
              type="submit"
              className="text-[10px] font-mono text-primary hover:underline cursor-pointer"
            >
              Go
            </button>
          </form>

          <button
            type="button"
            onClick={() => setNewFolderMode(!newFolderMode)}
            className="px-3 py-1.5 rounded-lg bg-surface-container-high hover:bg-surface-bright border border-white/[0.08] text-white text-xs font-semibold flex items-center gap-1.5 cursor-pointer"
          >
            <span className="material-symbols-outlined text-sm text-primary">
              create_new_folder
            </span>
            <span>New Folder</span>
          </button>
        </div>

        {/* Optional New Folder Inline Bar */}
        {newFolderMode && (
          <form
            onSubmit={handleCreateNewFolder}
            className="px-4 py-2.5 bg-primary/10 border-b border-primary/30 flex items-center gap-2"
          >
            <span className="material-symbols-outlined text-sm text-primary">
              create_new_folder
            </span>
            <span className="text-xs font-semibold text-white">
              Create Folder in {currentPath}:
            </span>
            <input
              type="text"
              value={newFolderName}
              onChange={(e) => setNewFolderName(e.target.value)}
              placeholder="Enter folder name (e.g. Survival_Server_Node)"
              autoFocus
              className="flex-1 bg-[#0b0e17] border border-primary/40 rounded-lg px-3 py-1 text-xs font-mono text-white focus:outline-none"
            />
            <button
              type="submit"
              className="px-3 py-1 rounded-lg bg-primary text-on-primary font-bold text-xs cursor-pointer"
            >
              Create
            </button>
            <button
              type="button"
              onClick={() => setNewFolderMode(false)}
              className="px-2.5 py-1 rounded-lg bg-white/5 text-on-surface-variant text-xs cursor-pointer"
            >
              Cancel
            </button>
          </form>
        )}

        {/* Explorer Body: Left Pane (This PC Drives & Quick Access) + Right Pane (Folders) */}
        <div className="flex-1 grid grid-cols-1 md:grid-cols-12 min-h-[380px] overflow-hidden">
          {/* Left Navigation Pane */}
          <div className="md:col-span-4 bg-[#0d111a] border-r border-white/[0.08] p-3 overflow-y-auto space-y-4">
            {/* Detected Local PC Drives */}
            <div>
              <div className="text-[10px] font-mono uppercase tracking-wider text-on-surface-variant px-2 mb-2 flex items-center gap-1.5">
                <span className="material-symbols-outlined text-xs text-primary">computer</span>
                <span>This PC — Local Disks</span>
              </div>
              <div className="space-y-1.5">
                {drives.map((drv) => {
                  const isActiveDrive =
                    currentPath.toUpperCase().startsWith(drv.driveLetter.toUpperCase()) ||
                    currentPath === drv.rootPath;
                  return (
                    <button
                      key={drv.id}
                      type="button"
                      onClick={() => browseToPath(drv.rootPath)}
                      className={`w-full text-left p-2.5 rounded-xl border transition-all cursor-pointer ${
                        isActiveDrive
                          ? 'bg-primary/15 border-primary/40 text-white'
                          : 'bg-[#131824] hover:bg-white/5 border-white/[0.06] text-on-surface'
                      }`}
                    >
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2 min-w-0">
                          <span className="material-symbols-outlined text-base text-primary">
                            hard_drive
                          </span>
                          <span className="text-xs font-bold text-white truncate">{drv.label}</span>
                        </div>
                        <span className="text-[10px] font-mono text-secondary shrink-0">
                          {drv.freeGb} GB free
                        </span>
                      </div>
                      <div className="w-full h-1.5 bg-black/50 rounded-full overflow-hidden my-1.5">
                        <div
                          className="h-full bg-primary rounded-full"
                          style={{ width: `${drv.usedPct}%` }}
                        />
                      </div>
                      <div className="flex items-center justify-between text-[10px] font-mono text-on-surface-variant">
                        <span>{drv.fileSystem}</span>
                        <span>
                          {drv.usedGb} / {drv.totalGb} GB
                        </span>
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Quick Access Folders */}
            <div>
              <div className="text-[10px] font-mono uppercase tracking-wider text-on-surface-variant px-2 mb-1.5 flex items-center gap-1.5">
                <span className="material-symbols-outlined text-xs text-secondary">star</span>
                <span>Quick Access Folders</span>
              </div>
              <div className="space-y-1">
                {quickAccess.map((qa) => (
                  <button
                    key={qa.path}
                    type="button"
                    onClick={() => browseToPath(qa.path)}
                    className={`w-full text-left px-2.5 py-2 rounded-lg flex items-center gap-2 text-xs transition-colors cursor-pointer ${
                      selectedFolderPath === qa.path
                        ? 'bg-primary/15 text-primary font-bold'
                        : 'text-on-surface-variant hover:bg-white/5 hover:text-white'
                    }`}
                  >
                    <span className="material-symbols-outlined text-sm text-primary">
                      {qa.icon}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-white text-xs">{qa.label}</div>
                      <div className="truncate text-[10px] font-mono text-on-surface-variant">
                        {qa.path}
                      </div>
                    </div>
                  </button>
                ))}
              </div>
            </div>
          </div>

          {/* Right Folder Grid / List View */}
          <div className="md:col-span-8 bg-[#111520] p-4 overflow-y-auto flex flex-col">
            <div className="flex items-center justify-between pb-2.5 mb-3 border-b border-white/[0.08]">
              <div className="text-xs text-on-surface-variant">
                Folders inside <span className="text-white font-mono font-bold">{currentPath}</span>
              </div>
              <span className="text-[11px] font-mono text-on-surface-variant">
                Click to select • Double-click to open
              </span>
            </div>

            {loading ? (
              <div className="flex-1 flex items-center justify-center text-xs font-mono text-on-surface-variant">
                Scanning local PC folders...
              </div>
            ) : folders.length === 0 ? (
              <div className="flex-1 flex flex-col items-center justify-center text-center p-6 space-y-2">
                <span className="material-symbols-outlined text-3xl text-on-surface-variant/50">
                  folder_open
                </span>
                <p className="text-xs text-white font-semibold">
                  No subfolders inside this directory
                </p>
                <p className="text-[11px] text-on-surface-variant">
                  You can select <span className="text-primary font-mono">{currentPath}</span>{' '}
                  directly or click &ldquo;New Folder&rdquo; above.
                </p>
              </div>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                {folders.map((folder) => {
                  const isSelected = selectedFolderPath === folder.fullPath;
                  return (
                    <div
                      key={folder.fullPath}
                      onClick={() => setSelectedFolderPath(folder.fullPath)}
                      onDoubleClick={() => browseToPath(folder.fullPath)}
                      className={`p-3 rounded-xl border flex items-center justify-between gap-2.5 transition-all cursor-pointer ${
                        isSelected
                          ? 'bg-primary/15 border-primary text-white '
                          : 'bg-[#161c2a] hover:bg-[#1c2436] border-white/[0.06] text-on-surface'
                      }`}
                    >
                      <div className="flex items-center gap-2.5 min-w-0">
                        <span
                          className={`material-symbols-outlined text-xl shrink-0 ${
                            folder.isServerFolder ? 'text-primary' : 'text-amber-400'
                          }`}
                        >
                          {folder.isServerFolder ? 'folder_Managed' : 'folder'}
                        </span>
                        <div className="min-w-0">
                          <div className="text-xs font-bold text-white truncate">{folder.name}</div>
                          <div className="text-[10px] font-mono text-on-surface-variant truncate">
                            {folder.fullPath}
                          </div>
                        </div>
                      </div>

                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          browseToPath(folder.fullPath);
                        }}
                        className="px-2 py-1 rounded bg-white/5 hover:bg-white/10 text-[10px] font-mono text-on-surface-variant hover:text-white shrink-0 cursor-pointer"
                      >
                        Open
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>

        {/* Bottom Selection Confirmation Bar */}
        <div className="px-4 py-3 bg-[#0b0e17] border-t border-white/[0.08] flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div className="flex items-center gap-2 min-w-0 flex-1">
            <span className="text-xs text-on-surface-variant shrink-0">Selected Folder:</span>
            <input
              type="text"
              value={selectedFolderPath}
              onChange={(e) => setSelectedFolderPath(e.target.value)}
              className="flex-1 bg-[#151a28] border border-primary/40 rounded-lg px-3 py-1.5 text-xs font-mono text-primary font-bold focus:outline-none"
            />
          </div>

          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 rounded-xl bg-white/5 hover:bg-white/10 text-on-surface-variant hover:text-white text-xs font-semibold cursor-pointer"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => {
                if (selectedFolderPath.trim()) {
                  onSelectFolder(selectedFolderPath.trim());
                  onClose();
                }
              }}
              className="px-5 py-2 rounded-xl bg-primary hover:bg-primary-gold text-on-primary text-xs font-bold flex items-center gap-1.5 cursor-pointer"
            >
              <span className="material-symbols-outlined text-sm">check_circle</span>
              <span>Select Folder</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
