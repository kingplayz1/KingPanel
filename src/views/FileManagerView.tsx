import React, { useState, useEffect } from 'react';
import { FileItem, ServerInstance } from '../types';

interface FileManagerViewProps {
  server: ServerInstance;
  files: FileItem[];
  selectedFileId?: string | null;
  onSaveFileContent: (fileId: string, content: string) => void;
  onCreateFile: (name: string, content: string) => void;
  onShowToast: (title: string, body?: string, type?: 'success' | 'info' | 'warning' | 'error', icon?: string) => void;
}

export const FileManagerView: React.FC<FileManagerViewProps> = ({
  server,
  files,
  selectedFileId,
  onSaveFileContent,
  onCreateFile,
  onShowToast,
}) => {
  const [activeFileId, setActiveFileId] = useState<string>(
    selectedFileId || 'f-essentials-config'
  );
  const [openTabIds, setOpenTabIds] = useState<string[]>([
    'f-essentials-config',
    'f-server-props',
    'f-paper-world',
  ]);

  useEffect(() => {
    if (selectedFileId) {
      setActiveFileId(selectedFileId);
      setOpenTabIds((prev) =>
        prev.includes(selectedFileId) ? prev : [...prev, selectedFileId]
      );
      setPluginsOpen(true);
      setEssentialsOpen(true);
    }
  }, [selectedFileId]);
  const [searchQuery, setSearchQuery] = useState('');
  const [pluginsOpen, setPluginsOpen] = useState(true);
  const [essentialsOpen, setEssentialsOpen] = useState(true);
  const [saveStatus, setSaveStatus] = useState<'idle' | 'syncing' | 'saved'>('idle');
  const [isEditingRaw, setIsEditingRaw] = useState(false);
  const [draftContent, setDraftContent] = useState<string>('');
  const [newFileModalOpen, setNewFileModalOpen] = useState(false);
  const [newFileName, setNewFileName] = useState('');

  // Helper to locate a file by ID recursively
  const findFileById = (items: FileItem[], id: string): FileItem | undefined => {
    for (const item of items) {
      if (item.id === id) return item;
      if (item.children) {
        const found = findFileById(item.children, id);
        if (found) return found;
      }
    }
    return undefined;
  };

  const activeFile = findFileById(files, activeFileId) || files[0];

  const handleSelectFile = (file: FileItem) => {
    if (file.type === 'folder') {
      if (file.id === 'dir-plugins') setPluginsOpen(!pluginsOpen);
      if (file.id === 'dir-essentials') setEssentialsOpen(!essentialsOpen);
      return;
    }
    setActiveFileId(file.id);
    setIsEditingRaw(false);
    setDraftContent(file.content || '');
    if (!openTabIds.includes(file.id)) {
      setOpenTabIds([...openTabIds, file.id]);
    }
  };

  const handleCloseTab = (e: React.MouseEvent, tabId: string) => {
    e.stopPropagation();
    if (openTabIds.length <= 1) return;
    const filtered = openTabIds.filter((id) => id !== tabId);
    setOpenTabIds(filtered);
    if (activeFileId === tabId) {
      setActiveFileId(filtered[0]);
    }
  };

  const triggerSaveAnimation = () => {
    if (isEditingRaw && activeFile) {
      onSaveFileContent(activeFile.id, draftContent);
      setIsEditingRaw(false);
    }
    setSaveStatus('syncing');
    setTimeout(() => {
      setSaveStatus('saved');
      onShowToast(
        `Saved ${activeFile.name}`,
        'FastPipe pushed updated configuration to PaperMC runtime.',
        'success',
        'check_circle'
      );
      setTimeout(() => {
        setSaveStatus('idle');
      }, 1800);
    }, 650);
  };

  const handleCreateNewFile = (e: React.FormEvent) => {
    e.preventDefault();
    const clean = newFileName.trim();
    if (!clean) return;
    onCreateFile(clean, `# ${clean}\n# Created in IS King Panel File Manager\nenabled: true\n`);
    setNewFileName('');
    setNewFileModalOpen(false);
    onShowToast('File Created on NVMe', `Created ${clean} with rw-r--r-- permissions.`, 'success', 'note_add');
  };

  // Syntax-highlighted line renderer
  const renderHighlightedLine = (line: string, index: number) => {
    const trimmed = line.trim();
    if (trimmed.startsWith('#')) {
      return <div className="text-on-surface-variant/60 italic whitespace-pre">{line || ' '}</div>;
    }
    if (line.includes('teleport-delay: 0') && activeFile.id === 'f-essentials-config') {
      return (
        <div className="bg-surface-container px-1 py-0.5 -mx-1 rounded flex items-center">
          <span className="text-primary font-semibold">teleport-delay:</span>
          <span className="text-tertiary ml-2">0</span>
          <span className="w-1.5 h-4 bg-primary ml-1 animate-pulse inline-block" />
        </div>
      );
    }
    if (line.includes(':')) {
      const colonIdx = line.indexOf(':');
      const keyPart = line.slice(0, colonIdx + 1);
      const valPart = line.slice(colonIdx + 1);
      const isBool = valPart.trim() === 'true' || valPart.trim() === 'false';
      const isString = valPart.trim().startsWith("'") || valPart.trim().startsWith('"');
      return (
        <div className="whitespace-pre">
          <span className="text-primary font-semibold">{keyPart}</span>
          <span
            className={
              isBool
                ? 'text-secondary font-bold'
                : isString
                ? 'text-secondary'
                : 'text-tertiary'
            }
          >
            {valPart}
          </span>
        </div>
      );
    }
    if (line.includes('=')) {
      const eqIdx = line.indexOf('=');
      const keyPart = line.slice(0, eqIdx + 1);
      const valPart = line.slice(eqIdx + 1);
      return (
        <div className="whitespace-pre">
          <span className="text-primary font-semibold">{keyPart}</span>
          <span className="text-tertiary">{valPart}</span>
        </div>
      );
    }
    return (
      <div key={index} className="text-on-surface whitespace-pre">
        {line || ' '}
      </div>
    );
  };

  const lines = (activeFile.content || '').split('\n');
  const startLineNumber = activeFile.id === 'f-essentials-config' ? 135 : 1;

  return (
    <div className="flex flex-col w-full gap-5">
      {/* ================= TOP WORKSPACE ACTION & PATH METRICS BAR ================= */}
      <div className="flex flex-col gap-4">
        {/* Breadcrumb Path & Instance Header Row */}
        <div className="flex flex-wrap items-center justify-between gap-3 bg-surface-container-low p-4 rounded-xl shadow-lg shadow-black/20">
          <div className="flex items-center gap-2 min-w-0 flex-1">
            <div className="size-8 rounded-lg bg-surface-container-high flex items-center justify-center shrink-0 text-primary">
              <span className="material-symbols-outlined text-lg">folder_data</span>
            </div>
            {/* Breadcrumbs Navigation */}
            <nav aria-label="Breadcrumb" className="flex items-center flex-wrap gap-1.5 font-code-md text-code-md min-w-0">
              <button
                type="button"
                onClick={() => setActiveFileId('f-server-props')}
                className="text-on-surface-variant hover:text-white transition-colors flex items-center gap-1 cursor-pointer"
              >
                <span className="material-symbols-outlined text-sm text-primary">hard_drive</span>
                <span>NVMe Root</span>
              </button>
              <span className="text-on-surface-variant/40">/</span>
              <button
                type="button"
                onClick={() => setActiveFileId('f-server-props')}
                className="text-on-surface-variant hover:text-white transition-colors truncate max-w-[140px] cursor-pointer"
              >
                {server.path}
              </button>
              {activeFile.path.includes('plugins') && (
                <>
                  <span className="text-on-surface-variant/40">/</span>
                  <button
                    type="button"
                    onClick={() => setPluginsOpen(true)}
                    className="text-on-surface-variant hover:text-white transition-colors cursor-pointer"
                  >
                    plugins
                  </button>
                  <span className="text-on-surface-variant/40">/</span>
                  <button
                    type="button"
                    onClick={() => setEssentialsOpen(true)}
                    className="text-on-surface-variant hover:text-white transition-colors font-medium cursor-pointer"
                  >
                    EssentialsX
                  </button>
                </>
              )}
              <span className="text-on-surface-variant/40">/</span>
              <span className="text-primary font-semibold flex items-center gap-1 bg-surface-container-highest px-2 py-0.5 rounded text-code-sm">
                <span className="size-1.5 rounded-full bg-primary animate-pulse" />
                {activeFile.name}
              </span>
            </nav>
          </div>

          {/* Quick FastPipe / Hardware Sync Badge */}
          <div className="flex items-center gap-3 shrink-0">
            <div className="flex items-center gap-2 bg-surface-container px-3 py-1.5 rounded-lg text-code-sm font-code-sm">
              <span className="size-2 rounded-full bg-secondary animate-pulse" />
              <span className="text-secondary font-semibold">Zero-Latency FastPipe</span>
              <span className="text-on-surface-variant/50">•</span>
              <span className="text-on-surface-variant">PCIe 4.0 DirectSync</span>
            </div>
            <div className="flex items-center gap-1.5 bg-surface-container px-3 py-1.5 rounded-lg">
              <span className="material-symbols-outlined text-sm text-on-surface-variant">storage</span>
              <div className="flex flex-col">
                <div className="flex items-center justify-between gap-3 text-label-caps font-label-caps text-on-surface-variant">
                  <span>NVMe 4.2 / 60 GB</span>
                  <span className="text-primary font-bold">7%</span>
                </div>
                <div className="w-24 bg-surface-container-high h-1 rounded-full overflow-hidden mt-0.5">
                  <div
                    className="bg-gradient-to-r from-primary to-primary-fixed h-full rounded-full"
                    style={{ width: '7%' }}
                  />
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Operational Buttons & Global Filter Row */}
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-3 items-center">
          {/* Action Commands */}
          <div className="lg:col-span-8 flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => setNewFileModalOpen(true)}
              className="flex items-center gap-1.5 bg-surface-container hover:bg-surface-container-high text-on-surface px-3 py-2 rounded-lg text-body-sm font-body-sm transition-all shadow-sm cursor-pointer"
            >
              <span className="material-symbols-outlined text-base text-primary">note_add</span>
              <span>New File</span>
            </button>
            <button
              type="button"
              onClick={() =>
                onShowToast('Directory Created', 'Created new folder in C:\\KingServers\\MioSMP', 'success', 'create_new_folder')
              }
              className="flex items-center gap-1.5 bg-surface-container hover:bg-surface-container-high text-on-surface px-3 py-2 rounded-lg text-body-sm font-body-sm transition-all shadow-sm cursor-pointer"
            >
              <span className="material-symbols-outlined text-base text-primary">create_new_folder</span>
              <span>New Folder</span>
            </button>
            <button
              type="button"
              onClick={() =>
                onShowToast('FastPipe Upload Ready', 'Drop .jar or .yml files to sync directly.', 'info', 'upload_file')
              }
              className="flex items-center gap-1.5 bg-surface-container hover:bg-surface-container-high text-on-surface px-3 py-2 rounded-lg text-body-sm font-body-sm transition-all shadow-sm cursor-pointer"
            >
              <span className="material-symbols-outlined text-base text-secondary">upload_file</span>
              <span>Upload</span>
              <span className="text-label-caps font-label-caps bg-surface-container-highest px-1.5 py-0.5 rounded text-on-surface-variant">
                .jar .yml
              </span>
            </button>
            <button
              type="button"
              onClick={() =>
                onShowToast('Exporting Instance Archive', 'Compressing MioSMP_configs.zip (ZSTD)...', 'success', 'download')
              }
              className="flex items-center gap-1.5 bg-surface-container hover:bg-surface-container-high text-on-surface px-3 py-2 rounded-lg text-body-sm font-body-sm transition-all shadow-sm cursor-pointer"
            >
              <span className="material-symbols-outlined text-base text-tertiary">download</span>
              <span>Export .zip</span>
            </button>
            <button
              type="button"
              onClick={() =>
                onShowToast('Git Commit Created', 'Committed working tree to local branch main (8a4f21c).', 'success', 'commit')
              }
              className="flex items-center gap-1.5 bg-surface-container hover:bg-surface-container-high text-on-surface px-3 py-2 rounded-lg text-body-sm font-body-sm transition-all shadow-sm cursor-pointer"
            >
              <span className="material-symbols-outlined text-base text-primary-fixed">source_environment</span>
              <span>Git Snapshot</span>
            </button>
            <button
              type="button"
              onClick={() =>
                onShowToast('Archive Verified', '48 configuration items verified on NVMe.', 'info', 'folder_zip')
              }
              className="flex items-center gap-1.5 bg-surface-container hover:bg-surface-container-high text-on-surface px-3 py-2 rounded-lg text-body-sm font-body-sm transition-all shadow-sm cursor-pointer"
            >
              <span className="material-symbols-outlined text-base text-on-surface-variant">folder_zip</span>
              <span>Archive</span>
            </button>
          </div>

          {/* Quick Filter Search Input */}
          <div className="lg:col-span-4 relative">
            <div className="relative flex items-center">
              <span className="material-symbols-outlined absolute left-3 text-on-surface-variant/60 text-lg">
                search
              </span>
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="w-full bg-surface-container pl-9 pr-16 py-2 rounded-lg text-code-sm font-code-sm text-on-surface placeholder:text-on-surface-variant/50 focus:outline-none focus:ring-1 focus:ring-primary/40 shadow-inner"
                placeholder="Filter files or search text (Ctrl+F)..."
              />
              <div className="absolute right-2 flex items-center gap-1">
                <button
                  type="button"
                  onClick={() => onShowToast('Regex Filter Enabled', 'File filter matching regular expressions.', 'info')}
                  className="px-1.5 py-0.5 rounded bg-surface-container-high text-label-caps font-label-caps text-on-surface-variant hover:text-white cursor-pointer"
                  title="Toggle Regex Engine"
                >
                  .*
                </button>
                <span className="text-label-caps font-label-caps px-1 py-0.5 bg-surface-container-highest rounded text-on-surface-variant/60">
                  ⌘F
                </span>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* ================= DUAL PANE: FILE TREE & CONFIG EDITOR WORKSPACE ================= */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-5 items-start">
        {/* LEFT PANE: DIRECTORY TREE & BROWSER (COL 4) */}
        <div className="lg:col-span-4 bg-surface-container-low rounded-xl shadow-xl shadow-black/25 flex flex-col overflow-hidden">
          {/* Directory Tree Header */}
          <div className="p-3.5 bg-surface-container flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span className="material-symbols-outlined text-primary text-base">account_tree</span>
              <span className="font-headline-sm text-body-md text-white font-semibold">Instance File System</span>
            </div>
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                onClick={() => {
                  setPluginsOpen(false);
                  setEssentialsOpen(false);
                }}
                className="p-1 rounded hover:bg-surface-container-high text-on-surface-variant hover:text-white transition-colors cursor-pointer"
                title="Collapse All Folders"
              >
                <span className="material-symbols-outlined text-base">unfold_less</span>
              </button>
              <button
                type="button"
                onClick={() => onShowToast('Directory Synchronized', 'FastPipe re-indexed 48 items.', 'info', 'sync')}
                className="p-1 rounded hover:bg-surface-container-high text-on-surface-variant hover:text-white transition-colors cursor-pointer"
                title="Reload Directory"
              >
                <span className="material-symbols-outlined text-base">sync</span>
              </button>
              <button
                type="button"
                onClick={() => onShowToast('Sorted by Hierarchy', 'Directories grouped above config files.', 'info', 'sort')}
                className="p-1 rounded hover:bg-surface-container-high text-on-surface-variant hover:text-white transition-colors cursor-pointer"
                title="Sort Options"
              >
                <span className="material-symbols-outlined text-base">sort</span>
              </button>
            </div>
          </div>

          {/* Quick Path Status Bar */}
          <div className="px-3.5 py-2 bg-surface-container-lowest flex items-center justify-between text-label-caps font-label-caps text-on-surface-variant">
            <span>NAME &amp; PERMISSIONS</span>
            <span>SIZE</span>
          </div>

          {/* Scrollable File Explorer Tree List */}
          <div className="p-2 space-y-0.5 max-h-[640px] overflow-y-auto select-none font-code-sm text-code-sm">
            {files
              .filter((f) => !searchQuery || f.name.toLowerCase().includes(searchQuery.toLowerCase()))
              .map((item) => {
                if (item.type === 'file') {
                  const isSelected = activeFileId === item.id;
                  return (
                    <div
                      key={item.id}
                      onClick={() => handleSelectFile(item)}
                      className={`flex items-center justify-between p-2 rounded-lg transition-colors cursor-pointer group ${
                        isSelected
                          ? 'bg-primary text-on-primary font-semibold shadow-md shadow-primary/20'
                          : 'hover:bg-surface-container text-on-surface'
                      }`}
                    >
                      <div className="flex items-center gap-2 min-w-0">
                        <span
                          className={`material-symbols-outlined text-base ${
                            isSelected ? 'text-on-primary' : item.iconColor
                          }`}
                        >
                          {item.icon}
                        </span>
                        <span className="truncate">{item.name}</span>
                        {item.permissions && !isSelected && (
                          <span className="text-label-caps font-label-caps px-1 py-0.5 bg-surface-container-high rounded text-on-surface-variant/70 hidden sm:inline">
                            {item.permissions}
                          </span>
                        )}
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        <span className={isSelected ? 'text-on-primary' : 'text-on-surface-variant'}>
                          {item.size}
                        </span>
                      </div>
                    </div>
                  );
                }

                // Folder handling (plugins vs other folders)
                if (item.id === 'dir-plugins') {
                  return (
                    <div key={item.id} className="pt-1">
                      <div
                        onClick={() => setPluginsOpen(!pluginsOpen)}
                        className="flex items-center justify-between p-2 rounded-lg bg-surface-container/70 text-primary font-medium cursor-pointer"
                      >
                        <div className="flex items-center gap-1.5 min-w-0">
                          <span className="material-symbols-outlined text-base">
                            {pluginsOpen ? 'folder_open' : 'folder'}
                          </span>
                          <span className="truncate font-semibold">{item.name}</span>
                          {item.badge && (
                            <span className="text-label-caps font-label-caps text-secondary bg-secondary/10 px-1 py-0.5 rounded">
                              {item.badge}
                            </span>
                          )}
                        </div>
                        <span className="text-on-surface-variant text-code-sm font-code-sm">dir</span>
                      </div>

                      {pluginsOpen && item.children && (
                        <div className="pl-4 ml-2 space-y-0.5 mt-0.5">
                          {item.children.map((sub) => {
                            if (sub.id === 'dir-essentials') {
                              return (
                                <div key={sub.id}>
                                  <div
                                    onClick={() => setEssentialsOpen(!essentialsOpen)}
                                    className="flex items-center justify-between p-2 rounded-lg bg-surface-container-high/80 text-primary cursor-pointer"
                                  >
                                    <div className="flex items-center gap-1.5 min-w-0">
                                      <span className="material-symbols-outlined text-base text-primary">
                                        {essentialsOpen ? 'folder_open' : 'folder'}
                                      </span>
                                      <span className="truncate font-semibold">{sub.name}</span>
                                    </div>
                                    <span className="material-symbols-outlined text-xs text-primary">
                                      {essentialsOpen ? 'arrow_drop_down' : 'chevron_right'}
                                    </span>
                                  </div>

                                  {essentialsOpen && sub.children && (
                                    <div className="pl-4 ml-2 space-y-0.5 mt-0.5">
                                      {sub.children.map((leaf) => {
                                        const isLeafSelected = activeFileId === leaf.id;
                                        return (
                                          <div
                                            key={leaf.id}
                                            onClick={() => handleSelectFile(leaf)}
                                            className={`flex items-center justify-between p-2 rounded-lg cursor-pointer transition-colors ${
                                              isLeafSelected
                                                ? 'bg-primary text-on-primary font-semibold shadow-md shadow-primary/20'
                                                : 'hover:bg-surface-container text-on-surface'
                                            }`}
                                          >
                                            <div className="flex items-center gap-2 min-w-0">
                                              <span
                                                className={`material-symbols-outlined text-base ${
                                                  isLeafSelected ? 'text-on-primary' : leaf.iconColor
                                                }`}
                                              >
                                                {leaf.icon}
                                              </span>
                                              <span className="truncate">{leaf.name}</span>
                                            </div>
                                            <div className="flex items-center gap-1.5 shrink-0">
                                              {isLeafSelected && (
                                                <span className="size-1.5 rounded-full bg-on-primary animate-ping" />
                                              )}
                                              <span className="text-code-sm font-code-sm">{leaf.size}</span>
                                            </div>
                                          </div>
                                        );
                                      })}
                                    </div>
                                  )}
                                </div>
                              );
                            }

                            return (
                              <div
                                key={sub.id}
                                onClick={() =>
                                  onShowToast(
                                    `${sub.name} Directory`,
                                    `Opened ${sub.path} plugin configuration folder.`,
                                    'info',
                                    'folder'
                                  )
                                }
                                className="flex items-center justify-between p-2 rounded-lg hover:bg-surface-container text-on-surface-variant hover:text-white transition-colors cursor-pointer"
                              >
                                <div className="flex items-center gap-2 min-w-0">
                                  <span className="material-symbols-outlined text-base text-on-surface-variant">
                                    folder
                                  </span>
                                  <span className="truncate">{sub.name}</span>
                                </div>
                                <span className="text-label-caps font-label-caps text-on-surface-variant/60">
                                  {sub.permissions}
                                </span>
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  );
                }

                return (
                  <div
                    key={item.id}
                    onClick={() =>
                      onShowToast(
                        `${item.name} Volume`,
                        `Inspected ${item.path} (${item.size})`,
                        'info',
                        item.icon
                      )
                    }
                    className="flex items-center justify-between p-2 rounded-lg hover:bg-surface-container text-on-surface-variant hover:text-white transition-colors cursor-pointer"
                  >
                    <div className="flex items-center gap-2 min-w-0">
                      <span className={`material-symbols-outlined text-base ${item.iconColor}`}>
                        {item.icon}
                      </span>
                      <span className="truncate text-white">{item.name}</span>
                    </div>
                    <span
                      className={`font-code-sm ${
                        item.id === 'dir-world' ? 'text-secondary' : 'text-on-surface-variant'
                      }`}
                    >
                      {item.size}
                    </span>
                  </div>
                );
              })}
          </div>

          {/* Tree Footer Quick Stats */}
          <div className="p-3 bg-surface-container flex items-center justify-between text-code-sm font-code-sm text-on-surface-variant">
            <div className="flex items-center gap-2">
              <span className="size-2 rounded-full bg-secondary" />
              <span>48 Items Indexed</span>
            </div>
            <span className="font-mono text-label-caps font-label-caps text-primary">
              FastPipe Watcher Active
            </span>
          </div>
        </div>

        {/* RIGHT PANE: PRO-GRADE CODE & CONFIG EDITOR (COL 8) */}
        <div className="lg:col-span-8 bg-surface-container-low rounded-xl shadow-2xl shadow-black/40 flex flex-col overflow-hidden">
          {/* Multi-Tab Navigation Bar */}
          <div className="bg-surface-container flex items-center justify-between px-2 pt-2">
            <div className="flex items-center gap-1 overflow-x-auto min-w-0">
              {openTabIds.map((tabId) => {
                const tabFile = findFileById(files, tabId);
                if (!tabFile) return null;
                const isTabActive = tabFile.id === activeFile.id;
                return (
                  <div
                    key={tabFile.id}
                    onClick={() => handleSelectFile(tabFile)}
                    className={`flex items-center gap-2 px-3.5 py-2 rounded-t-lg font-code-sm text-code-sm cursor-pointer shrink-0 transition-colors ${
                      isTabActive
                        ? 'bg-surface-container-lowest text-white shadow-inner'
                        : 'bg-surface-container/60 hover:bg-surface-container-high text-on-surface-variant hover:text-white'
                    }`}
                  >
                    <span
                      className={`material-symbols-outlined text-sm ${
                        isTabActive ? 'text-primary' : tabFile.iconColor
                      }`}
                    >
                      {tabFile.id === 'f-essentials-config' ? 'data_object' : tabFile.icon}
                    </span>
                    <span className={isTabActive ? 'font-semibold text-primary' : ''}>
                      {tabFile.name}
                    </span>
                    {isTabActive && (
                      <span
                        className="size-2 rounded-full bg-primary"
                        title="Unsaved modifications"
                      />
                    )}
                    <button
                      type="button"
                      onClick={(e) => handleCloseTab(e, tabFile.id)}
                      className="hover:bg-surface-container-high rounded p-0.5 text-on-surface-variant hover:text-white"
                    >
                      <span className="material-symbols-outlined text-xs">close</span>
                    </button>
                  </div>
                );
              })}
            </div>

            {/* Right Tab Utilities */}
            <div className="flex items-center gap-1 shrink-0 pb-1.5 pr-1">
              <button
                type="button"
                onClick={() => {
                  if (!isEditingRaw) {
                    setDraftContent(activeFile.content || '');
                  }
                  setIsEditingRaw(!isEditingRaw);
                }}
                className={`px-2 py-1 rounded-lg text-code-sm font-code-sm transition-colors cursor-pointer flex items-center gap-1 ${
                  isEditingRaw
                    ? 'bg-primary text-on-primary font-bold'
                    : 'bg-surface-container-high/60 hover:bg-surface-container-high text-on-surface-variant hover:text-white'
                }`}
                title="Toggle Interactive Edit Mode"
              >
                <span className="material-symbols-outlined text-sm">edit_note</span>
                <span>{isEditingRaw ? 'Editing' : 'Edit'}</span>
              </button>
              <button
                type="button"
                onClick={() => onShowToast('Split Editor Enabled', 'Comparing active buffer with backup.', 'info', 'vertical_split')}
                className="p-1.5 rounded-lg bg-surface-container-high/60 hover:bg-surface-container-high text-on-surface-variant hover:text-white transition-colors cursor-pointer"
                title="Split Editor View"
              >
                <span className="material-symbols-outlined text-base">vertical_split</span>
              </button>
              <button
                type="button"
                onClick={() => onShowToast('Git Diff Clean', '2 lines modified from HEAD.', 'info', 'difference')}
                className="p-1.5 rounded-lg bg-surface-container-high/60 hover:bg-surface-container-high text-on-surface-variant hover:text-white transition-colors cursor-pointer"
                title="View Diff with Git / Backup"
              >
                <span className="material-symbols-outlined text-base">difference</span>
              </button>
            </div>
          </div>

          {/* Editor Tooling & Linter Status Strip */}
          <div className="px-4 py-2.5 bg-surface-container-lowest flex flex-wrap items-center justify-between gap-3 font-code-sm text-code-sm border-b border-white/5">
            <div className="flex items-center gap-3">
              {/* YAML Linter Status Badge */}
              <div className="flex items-center gap-1.5 bg-secondary/10 px-2.5 py-1 rounded text-secondary font-code-sm">
                <span className="material-symbols-outlined text-sm">verified</span>
                <span className="font-semibold">YAML Linter: Valid Structure</span>
              </div>
              <span className="text-on-surface-variant/40 hidden sm:inline">•</span>
              <div className="text-on-surface-variant flex items-center gap-1">
                <span className="material-symbols-outlined text-xs">history</span>
                <span>
                  Modified 18s ago by <strong className="text-white">admin</strong>
                </span>
              </div>
            </div>

            {/* Quick Formatting Action Pills */}
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                onClick={() =>
                  onShowToast('YAML Formatted', 'Indentation normalized to 2 spaces (YAML 1.2).', 'success', 'auto_fix')
                }
                className="flex items-center gap-1 px-2.5 py-1 rounded bg-surface-container hover:bg-surface-container-high text-on-surface transition-colors cursor-pointer"
              >
                <span className="material-symbols-outlined text-xs text-primary">auto_fix</span>
                <span>Format YAML</span>
              </button>
              <button
                type="button"
                onClick={() => {
                  setIsEditingRaw(true);
                  setDraftContent(activeFile.content || '');
                }}
                className="flex items-center gap-1 px-2.5 py-1 rounded bg-surface-container hover:bg-surface-container-high text-on-surface transition-colors cursor-pointer"
              >
                <span className="material-symbols-outlined text-xs text-tertiary">find_replace</span>
                <span>Find &amp; Replace</span>
              </button>
              <button
                type="button"
                onClick={() =>
                  onShowToast('Snapshot Diff Checked', 'Compared against Pre-Plugin Update Snapshot.', 'info', 'restore')
                }
                className="flex items-center gap-1 px-2.5 py-1 rounded bg-surface-container hover:bg-surface-container-high text-on-surface transition-colors cursor-pointer"
              >
                <span className="material-symbols-outlined text-xs text-secondary">restore</span>
                <span>Snapshot Diff</span>
              </button>
            </div>
          </div>

          {/* Code Editor Canvas */}
          <div className="relative bg-surface-container-lowest overflow-x-auto min-h-[460px] p-4 font-code-md text-code-md">
            {isEditingRaw ? (
              <textarea
                value={draftContent}
                onChange={(e) => setDraftContent(e.target.value)}
                className="w-full min-h-[430px] bg-surface-container-lowest text-on-surface font-mono text-code-md focus:outline-none resize-y leading-relaxed"
                spellCheck={false}
              />
            ) : (
              <div
                onClick={() => {
                  setDraftContent(activeFile.content || '');
                  setIsEditingRaw(true);
                }}
                title="Click anywhere in code to edit live"
                className="flex gap-4 cursor-text"
              >
                {/* Line Numbers Column */}
                <div className="flex flex-col text-right text-on-surface-variant/40 select-none pr-3 space-y-1 font-mono">
                  {lines.map((_, idx) => (
                    <span key={idx}>{startLineNumber + idx}</span>
                  ))}
                </div>
                {/* Code Stream Column */}
                <div className="flex flex-col flex-1 space-y-1 text-on-surface font-mono overflow-x-auto">
                  {lines.map((line, idx) => (
                    <React.Fragment key={idx}>{renderHighlightedLine(line, idx)}</React.Fragment>
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* Editor Bottom Status & Commit Execution Bar */}
          <div className="p-3 bg-surface-container flex flex-wrap items-center justify-between gap-3">
            {/* Editor Diagnostics Meta */}
            <div className="flex items-center flex-wrap gap-4 text-code-sm font-code-sm text-on-surface-variant">
              <div className="flex items-center gap-1.5">
                <span className="material-symbols-outlined text-xs text-primary">navigation</span>
                <span className="text-white font-medium">Ln 142, Col 18</span>
              </div>
              <span className="text-on-surface-variant/40">•</span>
              <span>Spaces: 2</span>
              <span className="text-on-surface-variant/40">•</span>
              <span>UTF-8</span>
              <span className="text-on-surface-variant/40">•</span>
              <span className="bg-surface-container-high px-2 py-0.5 rounded text-white text-label-caps font-label-caps">
                YAML Spec 1.2
              </span>
            </div>

            {/* Action Matrix Buttons */}
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => {
                  setIsEditingRaw(false);
                  setDraftContent(activeFile.content || '');
                  onShowToast('Changes Discarded', `Reverted ${activeFile.name} to saved disk state.`, 'info');
                }}
                className="px-3.5 py-2 rounded-lg bg-surface-container-high hover:bg-surface-container-highest text-on-surface transition-colors text-body-sm font-body-sm cursor-pointer"
              >
                Discard Changes
              </button>
              <button
                type="button"
                onClick={triggerSaveAnimation}
                className={`flex items-center gap-2 px-4 py-2 rounded-lg font-headline-sm text-body-sm font-bold shadow-lg transition-all cursor-pointer ${
                  saveStatus === 'saved'
                    ? 'bg-secondary text-on-secondary shadow-secondary/20'
                    : 'bg-primary text-on-primary shadow-primary/20 hover:bg-primary-gold'
                }`}
              >
                {saveStatus === 'syncing' && (
                  <>
                    <span className="material-symbols-outlined text-base animate-spin">refresh</span>
                    <span>Syncing with PaperMC...</span>
                  </>
                )}
                {saveStatus === 'saved' && (
                  <>
                    <span className="material-symbols-outlined text-base">check_circle</span>
                    <span>Saved &amp; Hot-Reloaded!</span>
                  </>
                )}
                {saveStatus === 'idle' && (
                  <>
                    <span className="material-symbols-outlined text-base">save</span>
                    <span>Save Changes (Ctrl+S)</span>
                    <span className="text-label-caps font-label-caps bg-on-primary/20 text-on-primary px-1.5 py-0.5 rounded">
                      Hot-Reload
                    </span>
                  </>
                )}
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* New File Modal */}
      {newFileModalOpen && (
        <div className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-center justify-center p-4">
          <form
            onSubmit={handleCreateNewFile}
            className="bg-surface-container-low border border-white/10 rounded-xl max-w-md w-full p-5 shadow-2xl space-y-4"
          >
            <div className="flex items-center justify-between">
              <h3 className="font-headline-sm text-white font-bold flex items-center gap-2">
                <span className="material-symbols-outlined text-primary">note_add</span>
                <span>Create New Configuration File</span>
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
              <label className="block text-label-caps uppercase text-outline mb-1">
                File Name (e.g. custom-rules.yml)
              </label>
              <input
                type="text"
                value={newFileName}
                onChange={(e) => setNewFileName(e.target.value)}
                placeholder="custom-rules.yml"
                className="w-full bg-surface-container rounded-lg p-2.5 text-white font-mono text-xs border border-white/10 focus:outline-none focus:border-primary"
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
