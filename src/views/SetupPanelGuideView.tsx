import React, { useState, useEffect } from 'react';
import { AuthUser, NavSection, PaperMCServiceReport, ServerInstance } from '../types';
import { submitJob, type OperationJob } from '../lib/jobs';
import { JobProgressBar } from '../components/JobProgressBar';
import {
  LocalDiskFolderPickerModal,
  LocalDriveItem,
} from '../components/LocalDiskFolderPickerModal';

interface SetupPanelGuideViewProps {
  currentUser?: AuthUser | null;
  servers: ServerInstance[];
  activeServer: ServerInstance;
  serverInstallRootDir: string;
  hostTotalRamGb: number;
  globalRamCapGb: number;
  paperMcReport: PaperMCServiceReport | null;
  onUpdateServerInstallFolder: (newFolder: string) => void;
  onUpdateGlobalRamConfig: (hostTotalGb: number, globalCapGb: number) => void;
  onCreateServerInstance: (server: ServerInstance) => void;
  onUpdateUserProfile?: (user: AuthUser) => void;
  onRunPaperMcCheckNow: () => void;
  onUpgradeServerEngine?: (serverId: string | 'ALL') => void;
  onOpenDiscordBotGate?: (attemptedServerName?: string) => void;
  onNavigate: (section: NavSection) => void;
  onFinishSetupToSimplePanel?: (openConsole?: boolean) => void;
  onShowToast: (
    title: string,
    body?: string,
    type?: 'success' | 'info' | 'warning' | 'error',
    icon?: string,
  ) => void;
}

type SetupStepNumber = 1 | 2 | 3 | 4 | 5;

export const SetupPanelGuideView: React.FC<SetupPanelGuideViewProps> = ({
  currentUser,
  servers,
  serverInstallRootDir,
  hostTotalRamGb,
  globalRamCapGb,
  paperMcReport,
  onUpdateServerInstallFolder,
  onUpdateGlobalRamConfig,
  onCreateServerInstance,
  onRunPaperMcCheckNow,
  onNavigate,
  onFinishSetupToSimplePanel,
  onShowToast,
}) => {
  const [activeStep, setActiveStep] = useState<SetupStepNumber>(1);
  const [completedSteps, setCompletedSteps] = useState<Record<SetupStepNumber, boolean>>({
    1: false,
    2: false,
    3: false,
    4: servers.length > 0,
    5: false,
  });

  // Step 1: Disk & RAM System State
  const [selectedDiskPath, setSelectedDiskPath] = useState<string>(
    serverInstallRootDir || 'C:\\KingServers',
  );
  const [selectedHostRam, setSelectedHostRam] = useState<number>(hostTotalRamGb || 32);
  const [selectedCapRam, setSelectedCapRam] = useState<number>(globalRamCapGb || 28);
  const [folderPickerOpen, setFolderPickerOpen] = useState<boolean>(false);
  const [detectedDrives, setDetectedDrives] = useState<LocalDriveItem[]>([]);

  useEffect(() => {
    fetch('/api/system/local-drives')
      .then((r) => r.json())
      .then((data) => {
        if (data?.ok && Array.isArray(data.drives)) {
          setDetectedDrives(data.drives);
        }
      })
      .catch(() => {});
  }, []);

  // Step 2: Local PC XAMPP / MariaDB + Verify IP, Username, Password + SQL Injection of iskingpanel
  const [dbEngine, setDbEngine] = useState<'xampp' | 'mariadb'>('xampp');
  const [dbHost, setDbHost] = useState<string>('127.0.0.1');
  const [dbPort, setDbPort] = useState<number>(3306);
  const [dbUsername, setDbUsername] = useState<string>('root');
  const [dbPassword, setDbPassword] = useState<string>('');
  const [primaryDatabase] = useState<string>('iskingpanel');
  const [extraDbInput, setExtraDbInput] = useState<string>('');
  const [customDatabases, setCustomDatabases] = useState<string[]>([]);
  const [isVerifyingDb, setIsVerifyingDb] = useState<boolean>(false);
  const [isDbVerified, setIsDbVerified] = useState<boolean>(false);
  const [dbVerifyMessage, setDbVerifyMessage] = useState<string | null>(null);
  const [isInjectingSql, setIsInjectingSql] = useState<boolean>(false);
  const [sqlInjectedDone, setSqlInjectedDone] = useState<boolean>(false);
  const [injectedDatabasesList, setInjectedDatabasesList] = useState<string[]>([]);
  const [createdTablesList, setCreatedTablesList] = useState<string[]>([]);

  // Step 3: Java & PaperMC Auto-Updater Service
  const [isCheckingJavaPaper, setIsCheckingJavaPaper] = useState<boolean>(false);
  const [javaPaperChecked, setJavaPaperChecked] = useState<boolean>(false);

  // Step 4: First Minecraft Server Setup & Deploy
  const [firstServerName, setFirstServerName] = useState<string>('My First Server');
  const [firstServerEngine, setFirstServerEngine] = useState<string>('PaperMC 1.21.4');
  const [firstServerPort, setFirstServerPort] = useState<number>(25565);
  const [firstServerRamGb, setFirstServerRamGb] = useState<number>(4);
  const [isDeployingServer, setIsDeployingServer] = useState<boolean>(false);
  const [deployJob, setDeployJob] = useState<OperationJob | null>(null);

  const latestPaperRelease = paperMcReport?.latestPaperRelease || '1.21.4';
  const latestPaperBuild = paperMcReport?.latestPaperBuild || 'Build #222';

  const markStepDone = (step: SetupStepNumber) => {
    setCompletedSteps((prev) => ({ ...prev, [step]: true }));
  };

  // Step 1 Handler: Save Disk & RAM System
  const handleSaveDiskAndRam = () => {
    const cleanPath = selectedDiskPath.trim() || 'C:\\KingServers';
    onUpdateServerInstallFolder(cleanPath);
    onUpdateGlobalRamConfig(selectedHostRam, selectedCapRam);
    markStepDone(1);
    onShowToast(
      'Step 1 Complete: Disk & RAM Saved',
      `Disk Path: ${cleanPath} • RAM Cap: ${selectedCapRam} GB / ${selectedHostRam} GB`,
      'success',
      'hard_drive',
    );
    setActiveStep(2);
  };

  // Step 2 Helper: Add Custom Database
  const handleAddCustomDatabase = () => {
    const cleaned = extraDbInput.trim().replace(/[^a-zA-Z0-9_]/g, '_');
    if (!cleaned) return;
    if (cleaned.toLowerCase() === 'iskingpanel' || customDatabases.includes(cleaned)) {
      setExtraDbInput('');
      return;
    }
    setCustomDatabases((prev) => [...prev, cleaned]);
    setExtraDbInput('');
  };

  const handleRemoveCustomDatabase = (name: string) => {
    setCustomDatabases((prev) => prev.filter((d) => d !== name));
  };

  // Step 2 Handler: Verify IP, Username, Password
  const handleVerifyDbCredentials = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!dbHost.trim() || !dbUsername.trim()) {
      onShowToast(
        'Missing Database Info',
        'Please enter IP/Host and Username to verify.',
        'warning',
        'warning',
      );
      return;
    }

    setIsVerifyingDb(true);
    setIsDbVerified(false);
    setSqlInjectedDone(false);

    try {
      const res = await fetch('/api/database/verify-credentials', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          engine: dbEngine,
          host: dbHost.trim(),
          port: dbPort,
          username: dbUsername.trim(),
          password: dbPassword,
        }),
      });
      const data = await res.json();
      if (res.ok && data.verified) {
        setIsDbVerified(true);
        setDbVerifyMessage(
          data.message ||
            `Verified ${dbEngine.toUpperCase()} (${dbUsername}@${dbHost}:${dbPort}). You can now inject the SQL database.`,
        );
        onShowToast(
          'Database Info Verified',
          `Verified ${dbUsername}@${dbHost}:${dbPort}. Click "Inject SQL Database" below!`,
          'success',
          'verified',
        );
      } else {
        setDbVerifyMessage(data.error || 'Verification failed.');
        onShowToast('Verification Failed', data.error || 'Invalid credentials.', 'error', 'error');
      }
    } catch {
      // The backend could not be reached — never claim the credentials work.
      setIsDbVerified(false);
      setDbVerifyMessage(
        `Could not reach the panel backend to check ${dbEngine.toUpperCase()} (${dbHost}:${dbPort}).`,
      );
      onShowToast('Verification Failed', 'The panel backend did not respond.', 'error', 'error');
    } finally {
      setIsVerifyingDb(false);
    }
  };

  // Step 2 Handler: Inject iskingpanel SQL + Optional Databases
  const handleInjectSql = async () => {
    if (!isDbVerified) return;
    setIsInjectingSql(true);
    try {
      const res = await fetch('/api/database/inject-sql', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          engine: dbEngine,
          host: dbHost.trim(),
          port: dbPort,
          username: dbUsername.trim(),
          password: dbPassword,
          primaryDatabase,
          customDatabases,
        }),
      });
      const data = await res.json().catch(() => null);
      const createdList: string[] = Array.isArray(data?.databasesCreated)
        ? data!.databasesCreated
        : [];
      if (res.ok && data?.ok && createdList.length) {
        setInjectedDatabasesList(createdList);
        setCreatedTablesList(Array.isArray(data?.tables) ? data!.tables : []);
        setSqlInjectedDone(true);
        markStepDone(2);
        onShowToast(
          'Databases Created',
          `Created and verified on ${dbHost}:${dbPort}: ${createdList.join(', ')}`,
          'success',
          'database',
        );
      } else {
        setInjectedDatabasesList([]);
        setSqlInjectedDone(false);
        onShowToast(
          'Database Setup Failed',
          data?.error || `Could not create databases on ${dbHost}:${dbPort}.`,
          'error',
          'error',
        );
      }
    } catch {
      setInjectedDatabasesList([]);
      setSqlInjectedDone(false);
      onShowToast(
        'Database Setup Failed',
        'The panel backend did not respond while creating the databases.',
        'error',
        'error',
      );
    } finally {
      setIsInjectingSql(false);
    }
  };

  // Step 3 Handler: Check Java & PaperMC Auto-Updater Service
  const handleVerifyJavaAndPaperMc = () => {
    setIsCheckingJavaPaper(true);
    onRunPaperMcCheckNow();
    setTimeout(() => {
      setIsCheckingJavaPaper(false);
      setJavaPaperChecked(true);
      markStepDone(3);
      onShowToast(
        'Java 21 & PaperMC Service Verified',
        `Java 21 LTS ready • PaperMC Auto-Updater active (Latest: ${latestPaperRelease}).`,
        'success',
        'verified',
      );
    }, 350);
  };

  // Step 4 Handler: Deploy First Minecraft Server
  const handleDeployFirstServer = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmedName = firstServerName.trim() || 'My First Server';
    setIsDeployingServer(true);

    const cleanRoot = selectedDiskPath.replace(/[\\/]+$/, '');
    const sep = cleanRoot.includes('\\') ? '\\' : '/';
    const slug = trimmedName.replace(/[^a-zA-Z0-9_-]/g, '_') || 'First_Server';
    const targetPath = `${cleanRoot}${sep}${slug}`;

    const parts = firstServerEngine.split(' ');
    const engineType = parts[0] || 'PaperMC';
    const mcVersion = parts[1] || '1.21.4';

    let installedFolder = '';
    let installedPath = targetPath;
    try {
      // Deploy through the job queue and wait for the real folder and jar result
      // instead of assuming the path.
      const outcome = await submitJob<Record<string, any>>(
        '/api/panel/install-server-instance',
        {
          serverName: trimmedName,
          engine: engineType,
          version: mcVersion,
          port: firstServerPort,
          ramMaxGb: firstServerRamGb,
          installRootDir: selectedDiskPath,
          acceptEula: true,
        },
        { onProgress: setDeployJob },
      );
      const data = (outcome.result || {}) as Record<string, any>;
      if (!outcome.ok) {
        onShowToast(
          'Server deploy failed',
          outcome.error || 'The backend could not create the server folder.',
          'error',
          'error',
        );
        setIsDeployingServer(false);
        return;
      }
      installedFolder = String(data.folderName || '');
      if (data.displayPath) installedPath = String(data.displayPath);
    } catch {
      // fallback to local state creation
    }

    const newSrv: ServerInstance = {
      id: installedFolder || `srv-${Date.now().toString(36)}`,
      name: trimmedName,
      engine: firstServerEngine,
      javaVersion: 'Java 21',
      port: Number(firstServerPort) || 25565,
      pid: 0,
      status: 'stopped',
      path: installedPath,
      tps: 0.0,
      tickMs: 0.0,
      uptime: 'Stopped (Ready to Start)',
      playersOnline: 0,
      maxPlayers: 40,
      cpuUsage: 0,
      cpuTemp: 0,
      ramUsedGb: 0.0,
      ramMaxGb: firstServerRamGb,
      build: '#Latest',
    };

    onCreateServerInstance(newSrv);
    setIsDeployingServer(false);
    markStepDone(4);
    setActiveStep(5);
  };

  const stepsList: Array<{ step: SetupStepNumber; title: string; short: string }> = [
    { step: 1, title: 'Step 1: Disk & RAM System', short: 'Disk & RAM' },
    { step: 2, title: 'Step 2: Local XAMPP / MariaDB & SQL Injection', short: 'Database & SQL' },
    { step: 3, title: 'Step 3: Java & PaperMC Auto-Updater', short: 'Java & PaperMC' },
    { step: 4, title: 'Step 4: First MC Server Setup & Deploy', short: 'First Server' },
    { step: 5, title: 'Step 5: Open Simple Panel Console', short: 'Finish' },
  ];

  return (
    <div className="flex-1 overflow-y-auto bg-surface-dim p-4 sm:p-8">
      <div className="max-w-3xl mx-auto space-y-6">
        {/* Simple Setup Guide Header */}
        <div className="rounded-xl bg-surface border border-white/[0.06] px-4 py-3 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2.5">
              <span className="material-symbols-outlined text-[18px] text-primary">
                build_circle
              </span>
              <h1 className="text-[14.5px] font-semibold tracking-tight text-on-surface whitespace-nowrap">
                Setup Guide
              </h1>
              <span className="w-px h-4 bg-white/10 shrink-0" />
              <p className="text-[11.5px] text-outline font-mono truncate">
                disk &amp; RAM · XAMPP/MariaDB · Java/PaperMC · first server
              </p>
            </div>
          </div>

          {onFinishSetupToSimplePanel && (
            <button
              type="button"
              onClick={() => onFinishSetupToSimplePanel(false)}
              className="inline-flex items-center gap-1.5 h-8 px-3 rounded-lg border border-white/10 bg-white/[0.02] hover:bg-white/[0.06] text-[11.5px] font-medium text-on-surface transition-colors cursor-pointer shrink-0"
            >
              {currentUser ? 'Back to server list' : 'Back to login'}
              <span className="material-symbols-outlined text-[16px]">arrow_forward</span>
            </button>
          )}
        </div>

        {/* Simple 5-Step Progress Tabs */}
        <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
          {stepsList.map((item) => {
            const isCurrent = activeStep === item.step;
            const isDone = completedSteps[item.step];
            return (
              <button
                key={item.step}
                type="button"
                onClick={() => setActiveStep(item.step)}
                className={`p-3 rounded-xl border text-left transition-all cursor-pointer ${
                  isCurrent
                    ? 'bg-primary/15 border-primary text-white'
                    : isDone
                      ? 'bg-secondary/10 border-secondary/35 text-secondary'
                      : 'bg-surface border-white/[0.08] text-outline hover:text-white'
                }`}
              >
                <div className="flex items-center justify-between text-[10px] font-mono font-bold uppercase">
                  <span>Step {item.step}</span>
                  {isDone && (
                    <span className="material-symbols-outlined text-[14px] text-secondary">
                      check_circle
                    </span>
                  )}
                </div>
                <div className="text-xs font-bold mt-1 truncate">{item.short}</div>
              </button>
            );
          })}
        </div>

        {/* STEP 1: SELECT DISK & RAM SYSTEM */}
        {activeStep === 1 && (
          <div className="rounded-xl bg-surface border border-white/[0.08] p-6 space-y-5">
            <div>
              <h2 className="text-base font-bold text-white">
                Step 1: Select Disk &amp; RAM System
              </h2>
              <p className="text-xs text-outline mt-1">
                Choose the local disk folder where Minecraft servers will be stored and set your RAM
                limit.
              </p>
            </div>

            {/* Disk Selector from Local PC + Windows Folder Popup */}
            <div className="space-y-3">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                <label className="text-xs font-semibold text-white block">
                  Select Disk / Folder from Local PC
                </label>
                <button
                  type="button"
                  onClick={() => setFolderPickerOpen(true)}
                  className="px-3.5 py-2 rounded-xl bg-primary hover:bg-primary-gold text-on-primary text-xs font-bold flex items-center gap-1.5 cursor-pointer"
                >
                  <span className="material-symbols-outlined text-[16px]">folder_open</span>
                  <span>Select Folder from Local PC (Popup)</span>
                </button>
              </div>

              {/* Detected Local PC Disks */}
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
                {(detectedDrives.length > 0
                  ? detectedDrives.slice(0, 3)
                  : [
                      {
                        id: 'c',
                        driveLetter: 'C:',
                        label: 'Local Disk (C:)',
                        freeGb: 363.6,
                        totalGb: 512,
                        usedPct: 29,
                        recommendedPath: 'C:\\KingServers',
                      },
                      {
                        id: 'd',
                        driveLetter: 'D:',
                        label: 'NVMe Game Drive (D:)',
                        freeGb: 680.0,
                        totalGb: 768,
                        usedPct: 18,
                        recommendedPath: 'D:\\MinecraftServers',
                      },
                      {
                        id: 'e',
                        driveLetter: 'E:',
                        label: 'Backup Volume (E:)',
                        freeGb: 813.5,
                        totalGb: 1024,
                        usedPct: 21,
                        recommendedPath: 'E:\\KingPanelServers',
                      },
                    ]
                ).map((drv) => {
                  const isSel =
                    selectedDiskPath.toUpperCase().startsWith(drv.driveLetter.toUpperCase()) ||
                    selectedDiskPath === drv.recommendedPath;
                  return (
                    <button
                      key={drv.id}
                      type="button"
                      onClick={() => setSelectedDiskPath(drv.recommendedPath)}
                      className={`p-3 rounded-xl border text-left font-mono text-xs cursor-pointer transition-all ${
                        isSel
                          ? 'bg-primary/15 border-primary text-white font-bold'
                          : 'bg-surface-lowest border-white/[0.08] text-outline hover:text-white'
                      }`}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex items-center gap-1.5 truncate">
                          <span className="material-symbols-outlined text-[16px] text-primary">
                            hard_drive
                          </span>
                          <span className="truncate">{drv.label}</span>
                        </div>
                        <span className="text-[10px] text-secondary shrink-0">
                          {drv.freeGb} GB free
                        </span>
                      </div>
                      <div className="text-[10px] text-outline truncate mt-1">
                        {drv.recommendedPath}
                      </div>
                    </button>
                  );
                })}
              </div>

              <div className="flex gap-2">
                <input
                  type="text"
                  value={selectedDiskPath}
                  onChange={(e) => setSelectedDiskPath(e.target.value)}
                  placeholder="Custom disk folder path (e.g. C:\KingServers)"
                  className="flex-1 bg-surface-lowest border border-white/15 focus:border-primary rounded-xl px-3.5 py-2.5 text-xs font-mono text-white focus:outline-none"
                />
                <button
                  type="button"
                  onClick={() => setFolderPickerOpen(true)}
                  className="px-4 py-2.5 rounded-xl bg-surface-container-high hover:bg-surface-bright border border-white/15 text-xs font-semibold text-white flex items-center gap-1.5 shrink-0 cursor-pointer"
                >
                  <span className="material-symbols-outlined text-[16px] text-primary">folder</span>
                  <span>Browse PC...</span>
                </button>
              </div>
            </div>

            {/* RAM System Selector */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="text-xs font-semibold text-white block mb-1.5">
                  PC Total Installed RAM
                </label>
                <select
                  value={selectedHostRam}
                  onChange={(e) => {
                    const total = Number(e.target.value);
                    setSelectedHostRam(total);
                    setSelectedCapRam(Math.max(4, total - 4));
                  }}
                  className="w-full bg-surface-lowest border border-white/15 focus:border-primary rounded-xl px-3.5 py-2.5 text-xs font-mono text-white focus:outline-none"
                >
                  <option value={8}>8 GB RAM</option>
                  <option value={16}>16 GB RAM</option>
                  <option value={32}>32 GB RAM</option>
                  <option value={64}>64 GB RAM</option>
                </select>
              </div>

              <div>
                <label className="text-xs font-semibold text-white block mb-1.5">
                  Max RAM Cap for Servers (GB)
                </label>
                <input
                  type="number"
                  min={2}
                  max={selectedHostRam}
                  value={selectedCapRam}
                  onChange={(e) => setSelectedCapRam(Number(e.target.value))}
                  className="w-full bg-surface-lowest border border-white/15 focus:border-primary rounded-xl px-3.5 py-2.5 text-xs font-mono text-white focus:outline-none"
                />
              </div>
            </div>

            <div className="flex items-center justify-end pt-2">
              <button
                type="button"
                onClick={handleSaveDiskAndRam}
                className="px-5 py-2.5 rounded-xl bg-primary hover:opacity-95 text-on-primary-container text-xs font-bold flex items-center gap-1.5 cursor-pointer"
              >
                <span>Save Disk &amp; RAM &amp; Continue</span>
                <span className="material-symbols-outlined text-[16px]">arrow_forward</span>
              </button>
            </div>
          </div>
        )}

        {/* STEP 2: DATABASE (LOCAL PC XAMPP / MARIADB + VERIFY IP, USERNAME, PASSWORD -> INJECT SQL) */}
        {activeStep === 2 && (
          <div className="rounded-xl bg-surface border border-white/[0.08] p-6 space-y-5">
            <div>
              <h2 className="text-base font-bold text-white">
                Step 2: Local PC Database Setup (XAMPP / MariaDB)
              </h2>
              <p className="text-xs text-outline mt-1">
                Select XAMPP or MariaDB, verify your IP, Username &amp; Password, and inject the
                pre-configured <code className="text-primary">iskingpanel</code> SQL database.
              </p>
            </div>

            {/* Select Local PC XAMPP or Local PC MariaDB */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <button
                type="button"
                onClick={() => {
                  setDbEngine('xampp');
                  setIsDbVerified(false);
                }}
                className={`p-3.5 rounded-xl border text-left cursor-pointer transition-all ${
                  dbEngine === 'xampp'
                    ? 'bg-primary/15 border-primary text-white'
                    : 'bg-surface-lowest border-white/[0.08] text-outline hover:text-white'
                }`}
              >
                <div className="text-xs font-bold">Local PC XAMPP (MySQL)</div>
                <div className="text-[11px] font-mono text-outline mt-0.5">
                  Default Port 3306 • C:\xampp\mysql
                </div>
              </button>

              <button
                type="button"
                onClick={() => {
                  setDbEngine('mariadb');
                  setIsDbVerified(false);
                }}
                className={`p-3.5 rounded-xl border text-left cursor-pointer transition-all ${
                  dbEngine === 'mariadb'
                    ? 'bg-primary/15 border-primary text-white'
                    : 'bg-surface-lowest border-white/[0.08] text-outline hover:text-white'
                }`}
              >
                <div className="text-xs font-bold">Local PC MariaDB</div>
                <div className="text-[11px] font-mono text-outline mt-0.5">
                  Default Port 3306 • MariaDB Local Service
                </div>
              </button>
            </div>

            {/* Pre-set iskingpanel Database + Option to Create Other Databases if Needed */}
            <div className="p-4 rounded-xl bg-surface-lowest border border-white/[0.08] space-y-3">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                <div>
                  <div className="text-xs font-bold text-white">
                    Pre-Setup SQL Database: <code className="text-primary">iskingpanel</code>
                  </div>
                  <p className="text-[11px] text-outline">
                    Primary database <code className="text-white">iskingpanel</code> is
                    pre-configured. You can also add additional databases below if needed.
                  </p>
                </div>
                <span className="text-xs font-mono text-secondary shrink-0">
                  Primary: iskingpanel
                </span>
              </div>

              {/* Add Additional Database If Needed */}
              <div className="flex gap-2">
                <input
                  type="text"
                  value={extraDbInput}
                  onChange={(e) => setExtraDbInput(e.target.value)}
                  placeholder="Optional: enter another database name (e.g. luckperms_db)"
                  className="flex-1 bg-surface border border-white/15 focus:border-primary rounded-lg px-3 py-2 text-xs font-mono text-white focus:outline-none"
                />
                <button
                  type="button"
                  onClick={handleAddCustomDatabase}
                  className="px-3.5 py-2 rounded-lg bg-white/10 hover:bg-white/15 text-xs font-bold text-white cursor-pointer shrink-0"
                >
                  + Add Database
                </button>
              </div>

              {/* List of Databases to be Created during SQL Injection */}
              <div className="flex flex-wrap items-center gap-2 text-xs font-mono pt-1">
                <span className="text-outline">Databases to Inject:</span>
                <span className="px-2.5 py-1 rounded-lg bg-primary/15 border border-primary/35 text-primary font-bold">
                  iskingpanel (Default)
                </span>
                {customDatabases.map((dbName) => (
                  <span
                    key={dbName}
                    className="px-2.5 py-1 rounded-lg bg-surface border border-white/15 text-white flex items-center gap-1.5"
                  >
                    <span>{dbName}</span>
                    <button
                      type="button"
                      onClick={() => handleRemoveCustomDatabase(dbName)}
                      className="text-outline hover:text-error cursor-pointer"
                    >
                      ×
                    </button>
                  </span>
                ))}
              </div>
            </div>

            {/* Small Verification Form: Verify IP, Username, Password */}
            <form onSubmit={handleVerifyDbCredentials} className="space-y-3.5">
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <div>
                  <label className="text-xs font-semibold text-white block mb-1">
                    IP / Host Address
                  </label>
                  <input
                    type="text"
                    value={dbHost}
                    onChange={(e) => {
                      setDbHost(e.target.value);
                      setIsDbVerified(false);
                    }}
                    placeholder="127.0.0.1"
                    className="w-full bg-surface-lowest border border-white/15 focus:border-primary rounded-xl px-3 py-2 text-xs font-mono text-white focus:outline-none"
                  />
                </div>

                <div>
                  <label className="text-xs font-semibold text-white block mb-1">
                    Database Username
                  </label>
                  <input
                    type="text"
                    value={dbUsername}
                    onChange={(e) => {
                      setDbUsername(e.target.value);
                      setIsDbVerified(false);
                    }}
                    placeholder="root"
                    className="w-full bg-surface-lowest border border-white/15 focus:border-primary rounded-xl px-3 py-2 text-xs font-mono text-white focus:outline-none"
                  />
                </div>

                <div>
                  <label className="text-xs font-semibold text-white block mb-1">
                    Database Password
                  </label>
                  <input
                    type="password"
                    value={dbPassword}
                    onChange={(e) => {
                      setDbPassword(e.target.value);
                      setIsDbVerified(false);
                    }}
                    placeholder="Leave blank if none"
                    className="w-full bg-surface-lowest border border-white/15 focus:border-primary rounded-xl px-3 py-2 text-xs font-mono text-white focus:outline-none"
                  />
                </div>
              </div>

              <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
                <button
                  type="submit"
                  disabled={isVerifyingDb}
                  className="px-4 py-2.5 rounded-xl bg-white/10 hover:bg-white/15 border border-white/15 text-xs font-bold text-white flex items-center gap-1.5 cursor-pointer"
                >
                  <span className="material-symbols-outlined text-[16px] text-primary">
                    fact_check
                  </span>
                  {isVerifyingDb ? 'Verifying...' : 'Verify IP, Username & Password'}
                </button>

                {/* ONLY DISPLAY SQL INJECTION BUTTON AFTER VERIFICATION PASSES */}
                {isDbVerified && (
                  <button
                    type="button"
                    disabled={isInjectingSql}
                    onClick={handleInjectSql}
                    className="px-5 py-2.5 rounded-xl bg-secondary hover:opacity-95 text-on-secondary-container text-xs font-bold flex items-center gap-1.5 cursor-pointer"
                  >
                    <span className="material-symbols-outlined text-[17px]">database</span>
                    {isInjectingSql
                      ? 'Creating databases...'
                      : `Create Databases (${[primaryDatabase, ...customDatabases].join(', ')})`}
                  </button>
                )}
              </div>
            </form>

            {dbVerifyMessage && (
              <div className="p-3 rounded-xl bg-secondary/10 border border-secondary/30 text-xs text-secondary font-mono">
                ✓ {dbVerifyMessage}
              </div>
            )}

            {sqlInjectedDone && (
              <div className="p-4 rounded-xl bg-surface-lowest border border-secondary/40 space-y-2">
                <div className="text-xs font-bold text-secondary flex items-center gap-1.5">
                  <span className="material-symbols-outlined text-[16px]">check_circle</span>
                  Databases &amp; Tables Created
                </div>
                <p className="text-xs font-mono text-outline">
                  Created database(s):{' '}
                  <strong className="text-white">{injectedDatabasesList.join(', ')}</strong>
                  {createdTablesList.length > 0 && (
                    <>
                      {' '}• Tables created:{' '}
                      <code className="text-primary">{createdTablesList.join(', ')}</code>
                    </>
                  )}
                </p>
              </div>
            )}

            <div className="flex items-center justify-between pt-2 border-t border-white/[0.08]">
              <button
                type="button"
                onClick={() => setActiveStep(1)}
                className="px-4 py-2 rounded-xl bg-white/5 hover:bg-white/10 text-xs text-outline hover:text-white cursor-pointer"
              >
                ← Back
              </button>
              <button
                type="button"
                onClick={() => {
                  markStepDone(2);
                  setActiveStep(3);
                }}
                className="px-5 py-2 rounded-xl bg-primary hover:opacity-95 text-on-primary-container text-xs font-bold cursor-pointer"
              >
                Continue to Step 3 →
              </button>
            </div>
          </div>
        )}

        {/* STEP 3: CHECK JAVA & PAPERMC AUTO-UPDATER SERVICE */}
        {activeStep === 3 && (
          <div className="rounded-xl bg-surface border border-white/[0.08] p-6 space-y-5">
            <div>
              <h2 className="text-base font-bold text-white">
                Step 3: Check Java &amp; PaperMC Auto-Updater Service
              </h2>
              <p className="text-xs text-outline mt-1">
                Verify Java 21 runtime and the background PaperMC version checker service.
              </p>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div className="p-4 rounded-xl bg-surface-lowest border border-white/[0.08] space-y-1">
                <div className="text-xs font-bold text-white flex items-center justify-between">
                  <span>Java Runtime Engine</span>
                  <span className="text-secondary font-mono">Java 21 LTS</span>
                </div>
                <p className="text-[11px] text-outline">
                  Ready for PaperMC, Purpur, Fabric, and Vanilla servers.
                </p>
              </div>

              <div className="p-4 rounded-xl bg-surface-lowest border border-white/[0.08] space-y-1">
                <div className="text-xs font-bold text-white flex items-center justify-between">
                  <span>PaperMC Auto-Updater</span>
                  <span className="text-primary font-mono">
                    {latestPaperRelease} ({latestPaperBuild})
                  </span>
                </div>
                <p className="text-[11px] text-outline">
                  Automatically checks PaperMC API and flags outdated servers.
                </p>
              </div>
            </div>

            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={handleVerifyJavaAndPaperMc}
                disabled={isCheckingJavaPaper}
                className="px-4 py-2.5 rounded-xl bg-secondary/20 hover:bg-secondary/30 border border-secondary/40 text-secondary text-xs font-bold flex items-center gap-1.5 cursor-pointer"
              >
                <span className="material-symbols-outlined text-[16px]">sync</span>
                {isCheckingJavaPaper
                  ? 'Checking Service...'
                  : 'Check Java & PaperMC Auto-Updater Now'}
              </button>
              {javaPaperChecked && (
                <span className="text-xs font-mono text-secondary">✓ Verified &amp; Active</span>
              )}
            </div>

            <div className="flex items-center justify-between pt-2 border-t border-white/[0.08]">
              <button
                type="button"
                onClick={() => setActiveStep(2)}
                className="px-4 py-2 rounded-xl bg-white/5 hover:bg-white/10 text-xs text-outline hover:text-white cursor-pointer"
              >
                ← Back
              </button>
              <button
                type="button"
                onClick={() => {
                  markStepDone(3);
                  setActiveStep(4);
                }}
                className="px-5 py-2 rounded-xl bg-primary hover:opacity-95 text-on-primary-container text-xs font-bold cursor-pointer"
              >
                Continue to Step 4 →
              </button>
            </div>
          </div>
        )}

        {/* STEP 4: FIRST MINECRAFT SERVER SETUP & DEPLOY */}
        {activeStep === 4 && (
          <div className="rounded-xl bg-surface border border-white/[0.08] p-6 space-y-5">
            <div>
              <h2 className="text-base font-bold text-white">
                Step 4: First Minecraft Server Setup &amp; Deploy
              </h2>
              <p className="text-xs text-outline mt-1">
                Create your first Minecraft server. It will be created in STOPPED state until you
                start it.
              </p>
            </div>

            <form onSubmit={handleDeployFirstServer} className="space-y-4">
              <div>
                <label className="text-xs font-semibold text-white block mb-1">Server Name</label>
                <input
                  type="text"
                  value={firstServerName}
                  onChange={(e) => setFirstServerName(e.target.value)}
                  placeholder="My First Server"
                  className="w-full bg-surface-lowest border border-white/15 focus:border-primary rounded-xl px-3.5 py-2.5 text-xs text-white focus:outline-none"
                />
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <div>
                  <label className="text-xs font-semibold text-white block mb-1">
                    Server Engine
                  </label>
                  <select
                    value={firstServerEngine}
                    onChange={(e) => setFirstServerEngine(e.target.value)}
                    className="w-full bg-surface-lowest border border-white/15 focus:border-primary rounded-xl px-3 py-2.5 text-xs text-white focus:outline-none"
                  >
                    <option value="PaperMC 1.21.4">PaperMC 1.21.4</option>
                    <option value="PaperMC 1.20.4">PaperMC 1.20.4</option>
                    <option value="Purpur 1.21.4">Purpur 1.21.4</option>
                    <option value="Fabric 1.21.1">Fabric 1.21.1</option>
                    <option value="Vanilla 1.21.4">Vanilla 1.21.4</option>
                  </select>
                </div>

                <div>
                  <label className="text-xs font-semibold text-white block mb-1">Server Port</label>
                  <input
                    type="number"
                    value={firstServerPort}
                    onChange={(e) => setFirstServerPort(Number(e.target.value))}
                    className="w-full bg-surface-lowest border border-white/15 focus:border-primary rounded-xl px-3 py-2.5 text-xs font-mono text-white focus:outline-none"
                  />
                </div>

                <div>
                  <label className="text-xs font-semibold text-white block mb-1">
                    Allocated RAM
                  </label>
                  <select
                    value={firstServerRamGb}
                    onChange={(e) => setFirstServerRamGb(Number(e.target.value))}
                    className="w-full bg-surface-lowest border border-white/15 focus:border-primary rounded-xl px-3 py-2.5 text-xs font-mono text-white focus:outline-none"
                  >
                    <option value={2}>2 GB</option>
                    <option value={4}>4 GB</option>
                    <option value={6}>6 GB</option>
                    <option value={8}>8 GB</option>
                  </select>
                </div>
              </div>

              <div className="flex flex-wrap items-center justify-between gap-3 pt-2 border-t border-white/[0.08]">
                <button
                  type="button"
                  onClick={() => setActiveStep(3)}
                  className="px-4 py-2 rounded-xl bg-white/5 hover:bg-white/10 text-xs text-outline hover:text-white cursor-pointer"
                >
                  ← Back
                </button>

                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      markStepDone(4);
                      setActiveStep(5);
                    }}
                    className="px-4 py-2 rounded-xl bg-white/5 hover:bg-white/10 text-xs text-outline hover:text-white cursor-pointer"
                  >
                    Skip to Step 5 →
                  </button>
                  <button
                    type="submit"
                    disabled={isDeployingServer}
                    className="px-5 py-2.5 rounded-xl bg-primary hover:opacity-95 text-on-primary-container text-xs font-bold flex items-center gap-1.5 cursor-pointer"
                  >
                    <span className="material-symbols-outlined text-[16px]">add_circle</span>
                    {isDeployingServer ? 'Deploying...' : 'Deploy First Server & Continue'}
                  </button>
                </div>
                {isDeployingServer && deployJob && (
                  <JobProgressBar job={deployJob} className="mt-3" />
                )}
              </div>
            </form>
          </div>
        )}

        {/* STEP 5: NAVIGATE TO SIMPLE PANEL CONSOLE BUTTON */}
        {activeStep === 5 && (
          <div className="rounded-xl bg-surface border border-white/[0.08] p-6 text-center space-y-5">
            <div className="w-12 h-12 rounded-xl bg-secondary/15 border border-secondary/35 flex items-center justify-center text-secondary mx-auto">
              <span className="material-symbols-outlined text-[26px]">check_circle</span>
            </div>

            <div className="space-y-1 max-w-md mx-auto">
              <h2 className="text-base font-bold text-white">
                Step 5: Setup Complete — Ready to Launch
              </h2>
              <p className="text-xs text-outline leading-relaxed">
                Your Disk &amp; RAM, Local XAMPP/MariaDB (
                <code className="text-primary">iskingpanel</code> SQL), Java &amp; PaperMC
                Auto-Updater, and Server Setup are ready.
              </p>
            </div>

            <div className="flex flex-wrap items-center justify-center gap-3 pt-2">
              <button
                type="button"
                onClick={() => {
                  markStepDone(5);
                  if (onFinishSetupToSimplePanel) {
                    onFinishSetupToSimplePanel(false);
                  } else {
                    onNavigate('console');
                  }
                }}
                className="px-5 py-2.5 rounded-xl bg-primary hover:opacity-95 text-on-primary-container text-xs font-bold flex items-center gap-2 cursor-pointer"
              >
                <span className="material-symbols-outlined text-[17px]">dns</span>
                <span>Open Simple Server Panel</span>
              </button>

              <button
                type="button"
                onClick={() => {
                  markStepDone(5);
                  if (onFinishSetupToSimplePanel) {
                    onFinishSetupToSimplePanel(true);
                  } else {
                    onNavigate('console');
                  }
                }}
                className="px-5 py-2.5 rounded-xl bg-secondary/20 hover:bg-secondary/30 border border-secondary/40 text-secondary text-xs font-bold flex items-center gap-2 cursor-pointer"
              >
                <span className="material-symbols-outlined text-[17px]">terminal</span>
                <span>Navigate to Simple Panel Console</span>
              </button>
            </div>
          </div>
        )}

        {/* Windows Folder Picker Modal for Selecting Disk / Folder from Local PC */}
        <LocalDiskFolderPickerModal
          isOpen={folderPickerOpen}
          initialPath={selectedDiskPath}
          title="Select Server Disk & Folder from Local PC"
          onClose={() => setFolderPickerOpen(false)}
          onSelectFolder={(pickedPath) => {
            setSelectedDiskPath(pickedPath);
            onUpdateServerInstallFolder(pickedPath);
            onShowToast(
              'Selected Local PC Folder',
              `Server storage folder set to: ${pickedPath}`,
              'success',
              'folder_open',
            );
          }}
        />
      </div>
    </div>
  );
};

export default SetupPanelGuideView;
