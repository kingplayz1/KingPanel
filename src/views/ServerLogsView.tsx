import React, { useState, useRef, useEffect, useCallback } from 'react';
import { ServerInstance, NavSection } from '../types';

interface ServerLogsViewProps {
  server: ServerInstance;
  onNavigate: (section: NavSection) => void;
  onShowToast: (title: string, body?: string, type?: 'success' | 'info' | 'warning' | 'error', icon?: string) => void;
}

interface DetailedLogRow {
  lineNum: number;
  time: string;
  severity: 'INFO' | 'DEBUG' | 'WARN' | 'JOIN' | 'ERROR' | 'CMD' | 'GC';
  thread: string;
  tag: string;
  content?: React.ReactNode;
  rawText: string;
  hasStacktrace?: boolean;
}

interface RealtimeLogFileMeta {
  displayLogPath: string;
  diskLogPath: string;
  sizeFormatted: string;
  totalLines: number;
  lastLineNum: number;
  errorCount: number;
  warnCount: number;
  infoCount: number;
  gcCount: number;
  fetchedAt: string;
  rotatedArchives: Array<{ name: string; sizeBytes: number; modifiedAt: string }>;
}

export const ServerLogsView: React.FC<ServerLogsViewProps> = ({
  server,
  onNavigate,
  onShowToast,
}) => {
  const [searchQuery, setSearchQuery] = useState('');
  const [regexMode, setRegexMode] = useState(true);
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [invertMatch, setInvertMatch] = useState(false);
  const [autoScroll, setAutoScroll] = useState(true);
  const [wrapLines, setWrapLines] = useState(false);
  const [isPaused, setIsPaused] = useState(false);
  const [selectedSeverity, setSelectedSeverity] = useState<string>('ALL');
  const [selectedThread, setSelectedThread] = useState<string>('ALL');
  const [stacktraceOpen, setStacktraceOpen] = useState(true);
  const [chunkFixed, setChunkFixed] = useState(false);
  const [liveRows, setLiveRows] = useState<DetailedLogRow[]>([]);
  const [logMeta, setLogMeta] = useState<RealtimeLogFileMeta | null>(null);
  const [customLogInput, setCustomLogInput] = useState('');
  const [customLogSeverity, setCustomLogSeverity] = useState<'INFO' | 'WARN' | 'ERROR' | 'CMD'>('INFO');
  const viewportRef = useRef<HTMLDivElement>(null);

  const fetchRealtimeLogs = useCallback(async () => {
    try {
      const r = await fetch(
        `/api/logs/realtime?serverId=${encodeURIComponent(server.id)}&serverName=${encodeURIComponent(server.name)}`
      );
      const data = await r.json();
      if (data.ok && Array.isArray(data.lines)) {
        setLiveRows(data.lines);
        setLogMeta({
          displayLogPath: data.displayLogPath || `${server.path}\\logs\\latest.log`,
          diskLogPath: data.diskLogPath || '',
          sizeFormatted: data.sizeFormatted || '2.4 KB',
          totalLines: data.totalLines || data.lines.length,
          lastLineNum: data.lastLineNum || 12840,
          errorCount: data.errorCount ?? 1,
          warnCount: data.warnCount ?? 2,
          infoCount: data.infoCount ?? 8,
          gcCount: data.gcCount ?? 1,
          fetchedAt: new Date().toLocaleTimeString(),
          rotatedArchives: data.rotatedArchives || [],
        });
      }
    } catch {
      // keep existing rows on transient error
    }
  }, [server.id, server.name, server.path]);

  useEffect(() => {
    fetchRealtimeLogs();
  }, [fetchRealtimeLogs]);

  useEffect(() => {
    if (isPaused) return;
    const timer = setInterval(() => {
      fetchRealtimeLogs();
    }, 1500);
    return () => clearInterval(timer);
  }, [isPaused, fetchRealtimeLogs]);

  useEffect(() => {
    if (autoScroll && viewportRef.current && !isPaused) {
      viewportRef.current.scrollTop = viewportRef.current.scrollHeight;
    }
  }, [liveRows.length, autoScroll, isPaused]);

  const handleAppendLiveLog = async (e: React.FormEvent) => {
    e.preventDefault();
    const text = customLogInput.trim() || `Operator diagnostic check executed on ${server.name} (20.0 TPS)`;
    try {
      const r = await fetch('/api/logs/append', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          serverId: server.id,
          serverName: server.name,
          severity: customLogSeverity,
          thread: customLogSeverity === 'CMD' ? 'Audit/Commands' : 'Server thread',
          tag: customLogSeverity === 'CMD' ? '[Audit/Commands]' : '[LiveStream]',
          rawText: text,
        }),
      });
      const data = await r.json();
      if (data.ok) {
        setCustomLogInput('');
        await fetchRealtimeLogs();
        onShowToast(
          'Written to latest.log & MongoDB',
          `Appended [${customLogSeverity}] line to local PC logs/latest.log`,
          'success',
          'terminal'
        );
      }
    } catch {
      // ignore
    }
  };

  const handleRotateLogsOnDisk = async () => {
    try {
      const r = await fetch('/api/logs/rotate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ serverId: server.id, serverName: server.name }),
      });
      const data = await r.json();
      if (data.ok) {
        await fetchRealtimeLogs();
        onShowToast(
          'Rotated latest.log on Local Disk',
          `Created archive "${data.archiveName}" inside logs/ folder.`,
          'success',
          'history'
        );
      }
    } catch {
      // ignore
    }
  };

  const logRows: DetailedLogRow[] = [
    {
      lineNum: 12820,
      time: '14:48:10',
      severity: 'INFO',
      thread: 'Server thread',
      tag: '[Paper]',
      rawText: "Loading world 'world' (Dimension 0, Overworld • Seed: -84129481928491)...",
      content: (
        <>
          Loading world <span className="text-primary font-semibold">&apos;world&apos;</span> (Dimension 0,
          Overworld • Seed: -84129481928491)...
        </>
      ),
    },
    {
      lineNum: 12821,
      time: '14:48:12',
      severity: 'INFO',
      thread: 'Server thread',
      tag: '[EssentialsX]',
      rawText: 'Loaded 48 user economy profiles into memory from local SQLite backend in 18ms.',
      content: (
        <>
          Loaded <span className="text-secondary font-semibold">48 user economy profiles</span> into memory
          from local SQLite backend in 18ms.
        </>
      ),
    },
    {
      lineNum: 12823,
      time: '14:48:19',
      severity: 'DEBUG',
      thread: 'FastPipe IPC',
      tag: '[FastPipe IPC]',
      rawText: 'SharedMemory buffer mapped (Channel: #king_ipc_mio_10484, size: 64 MB, Latency: 0.12ms).',
      content: (
        <span className="text-on-surface-variant">
          SharedMemory buffer mapped (Channel: #king_ipc_mio_10484, size: 64 MB, Latency: 0.12ms).
        </span>
      ),
    },
    {
      lineNum: 12825,
      time: '14:48:22',
      severity: 'WARN',
      thread: 'Watchdog',
      tag: '[Paper/Watchdog]',
      rawText:
        "Can't keep up! Is the server overloaded? Running 2,410ms or 48 ticks behind (Tick duration: 68.2ms > 50.0ms budget).",
      content: (
        <span className="text-primary font-medium">
          Can&apos;t keep up! Is the server overloaded? Running 2,410ms or 48 ticks behind (Tick duration:
          68.2ms &gt; 50.0ms budget).
        </span>
      ),
    },
    {
      lineNum: 12828,
      time: '14:48:33',
      severity: 'JOIN',
      thread: 'Auth/Join',
      tag: '[Auth/Join]',
      rawText:
        'Player Mio_Celestial (UUID: 8bf1a04d-e18b-4a55-b408-59c730e719c2) authenticated from 127.0.0.1:54210 via Localhost IPC bridge.',
      content: (
        <>
          Player <span className="text-primary font-bold">Mio_Celestial</span>{' '}
          <span className="text-outline-variant">(UUID: 8bf1a04d-e18b-4a55-b408-59c730e719c2)</span>{' '}
          authenticated from <span className="text-secondary">127.0.0.1:54210</span> via Localhost IPC
          bridge.
        </>
      ),
    },
    {
      lineNum: 12831,
      time: '14:49:02',
      severity: 'ERROR',
      thread: 'Server thread',
      tag: '[PacketFilter]',
      rawText:
        "Corrupted NBT payload in chunk [X: -14, Z: 28]. Failed to deserialize entity tag 'CustomModelData'.",
      hasStacktrace: true,
      content: (
        <span className="text-error font-semibold">
          {chunkFixed
            ? '[RESOLVED] Chunk [X: -14, Z: 28] NBT entity tag sanitized by King Panel Chunk Fixer.'
            : "Corrupted NBT payload in chunk [X: -14, Z: 28]. Failed to deserialize entity tag 'CustomModelData'."}
        </span>
      ),
    },
    {
      lineNum: 12835,
      time: '14:49:15',
      severity: 'CMD',
      thread: 'Server thread',
      tag: '[Audit/Commands]',
      rawText:
        "Mio_Celestial executed command: /gamemode creative from world 'world' [Location: X: 142, Y: 72, Z: -389]",
      content: (
        <>
          <span className="text-primary font-bold">Mio_Celestial</span> executed command:{' '}
          <span className="text-secondary font-mono font-bold bg-surface-container px-1.5 py-0.5 rounded">
            /gamemode creative
          </span>{' '}
          from world &apos;world&apos; [Location: X: 142, Y: 72, Z: -389]
        </>
      ),
    },
    {
      lineNum: 12838,
      time: '14:49:28',
      severity: 'WARN',
      thread: 'Watchdog',
      tag: '[Spigot/Watchdog]',
      rawText:
        'Thread dump generated for unresponsive tick threshold (15,000ms limit). Host CPU Thread 4 spiked to 98% utilization.',
      content: (
        <span className="text-primary">
          Thread dump generated for unresponsive tick threshold (15,000ms limit). Host CPU Thread 4 spiked to
          98% utilization.
        </span>
      ),
    },
    {
      lineNum: 12839,
      time: '14:49:35',
      severity: 'GC',
      thread: 'Server thread',
      tag: '[Aikar GC]',
      rawText:
        'G1GC Pause (Young Collection): 8,420 MB -> 4,110 MB (Free Heap: 8,274 MB • Cycle duration: 11.4ms).',
      content: (
        <span className="text-on-surface-variant">
          G1GC Pause (Young Collection): 8,420 MB -&gt; 4,110 MB (Free Heap: 8,274 MB • Cycle duration:
          11.4ms).
        </span>
      ),
    },
    {
      lineNum: 12840,
      time: '14:49:40',
      severity: 'INFO',
      thread: 'Server thread',
      tag: '[AutoSave]',
      rawText: 'Flushed 1,280 chunk sectors and 48 entity tables to region files in 14.1ms. NVMe I/O Queue: 0.',
      content: (
        <>
          Flushed <span className="text-on-surface font-semibold">1,280 chunk sectors</span> and 48 entity
          tables to region files in <span className="text-secondary font-semibold">14.1ms</span>. NVMe I/O
          Queue: 0.
        </>
      ),
    },
  ];

  const activeLogSource = liveRows.length > 0 ? liveRows : logRows;

  const filteredLogs = activeLogSource.filter((row) => {
    if (selectedSeverity !== 'ALL') {
      if (selectedSeverity === 'CHAT_CMDS') {
        if (row.severity !== 'CMD' && row.severity !== 'JOIN') return false;
      } else if (row.severity !== selectedSeverity) {
        return false;
      }
    }
    if (selectedThread !== 'ALL' && row.thread !== selectedThread) {
      return false;
    }
    if (searchQuery.trim()) {
      const target = caseSensitive ? row.rawText : row.rawText.toLowerCase();
      const q = caseSensitive ? searchQuery : searchQuery.toLowerCase();
      const matched = target.includes(q);
      return invertMatch ? !matched : matched;
    }
    return true;
  });

  const hourlyBars = [
    { hour: '00', height: '20%', color: 'bg-tertiary/40 hover:bg-tertiary', label: '00:00 - 180 INFO' },
    { hour: '01', height: '14%', color: 'bg-tertiary/40 hover:bg-tertiary', label: '01:00 - 120 INFO' },
    { hour: '02', height: '10%', color: 'bg-tertiary/40 hover:bg-tertiary', label: '02:00 - 90 INFO' },
    { hour: '03', height: '8%', color: 'bg-tertiary/40 hover:bg-tertiary', label: '03:00 - 64 INFO' },
    { hour: '04', height: '15%', color: 'bg-tertiary/40 hover:bg-tertiary', label: '04:00 - 140 INFO' },
    { hour: '05', height: '28%', color: 'bg-tertiary/40 hover:bg-tertiary', label: '05:00 - 240 INFO' },
    { hour: '06', height: '42%', color: 'bg-tertiary/50 hover:bg-tertiary', label: '06:00 - 410 INFO' },
    { hour: '07', height: '55%', color: 'bg-tertiary/60 hover:bg-tertiary', label: '07:00 - 580 INFO' },
    { hour: '08', height: '68%', color: 'bg-primary/70 hover:bg-primary', label: '08:00 - 2 WARN, 620 INFO' },
    { hour: '09', height: '75%', color: 'bg-tertiary/70 hover:bg-tertiary', label: '09:00 - 780 INFO' },
    { hour: '10', height: '82%', color: 'bg-tertiary/80 hover:bg-tertiary', label: '10:00 - 910 INFO' },
    { hour: '11', height: '88%', color: 'bg-primary hover:bg-primary-gold', label: '11:00 - 5 WARN' },
    { hour: '12', height: '94%', color: 'bg-tertiary hover:bg-tertiary-fixed', label: '12:00 - 1,100 INFO' },
    {
      hour: '13',
      height: '100%',
      color: 'bg-error shadow-lg shadow-error/30',
      label: '13:00 - 2 CRITICAL, 3 ERRORS, 8 WARN',
      isSpike: true,
    },
    {
      hour: 'NOW',
      height: '80%',
      color: 'bg-primary/90 hover:bg-primary-gold',
      label: '14:00 - Current Active Window',
      isNow: true,
    },
  ];

  return (
    <div className="flex flex-col w-full">
      {/* BREADCRUMB, INSTANCE STATUS & METRICS STRIP */}
      <div className="relative w-full">
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4 pb-4">
          <div className="flex flex-col gap-1 min-w-0">
            <div className="flex items-center flex-wrap gap-2 text-on-surface-variant font-code-sm text-code-sm">
              <span>Server Operations</span>
              <span className="text-outline-variant">/</span>
              <span className="text-primary font-semibold">Server Logs &amp; Audit Explorer</span>
              <span className="size-1 rounded-full bg-outline-variant" />
              <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-surface-container-high text-secondary text-code-sm">
                <span className="size-1.5 rounded-full bg-secondary animate-pulse" />
                Live Local PC File: {logMeta?.displayLogPath || `${server.path}\\logs\\latest.log`} (PID {server.pid} •{' '}
                {logMeta ? `${logMeta.totalLines} live lines • Synced ${logMeta.fetchedAt}` : '12,840 lines indexed'})
              </span>
            </div>
            <div className="flex items-center gap-3">
              <h1 className="text-headline-lg font-headline-lg text-on-surface tracking-tight">
                Real-Time Event Stream &amp; Audit Log
              </h1>
              <span className="px-2 py-0.5 rounded bg-surface-container text-on-surface-variant font-code-sm text-code-sm">
                {server.engine}
              </span>
            </div>
          </div>

          {/* Quick Metrics Counters */}
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-surface-container-low shadow-sm">
              <span className="size-2 rounded-full bg-error" />
              <span className="text-on-surface-variant font-code-sm text-code-sm">Errors</span>
              <span className="px-1.5 py-0.5 rounded bg-error-container text-error font-code-sm text-code-sm font-bold">
                {chunkFixed ? 0 : logMeta?.errorCount ?? 1}
              </span>
            </div>
            <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-surface-container-low shadow-sm">
              <span className="size-2 rounded-full bg-primary-container" />
              <span className="text-on-surface-variant font-code-sm text-code-sm">Warnings</span>
              <span className="px-1.5 py-0.5 rounded bg-primary/20 text-primary font-code-sm text-code-sm font-bold">
                {logMeta?.warnCount ?? 2}
              </span>
            </div>
            <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-surface-container-low shadow-sm text-code-sm font-code-sm">
              <span className="text-on-surface-variant">Active Size:</span>
              <span className="text-on-surface font-semibold">{logMeta?.sizeFormatted || '2.4 KB'}</span>
              <span className="text-outline-variant">/</span>
              <span className="text-on-surface-variant">Rotated on Disk:</span>
              <span className="text-tertiary">
                {logMeta?.rotatedArchives?.length ?? 4} Archives
              </span>
            </div>
          </div>
        </div>
      </div>

      {/* REAL-TIME LOG INJECTION & DISK ROTATION BAR */}
      <form
        onSubmit={handleAppendLiveLog}
        className="mb-3 p-3 rounded-xl bg-surface-container-low border border-primary/20 flex flex-col sm:flex-row items-stretch sm:items-center gap-2.5"
      >
        <div className="flex items-center gap-2 text-xs font-mono text-primary shrink-0">
          <span className="size-2 rounded-full bg-secondary animate-ping" />
          <span className="font-bold uppercase">Live Disk Log Stream (1.5s Poll)</span>
        </div>
        <select
          value={customLogSeverity}
          onChange={(e) => setCustomLogSeverity(e.target.value as 'INFO' | 'WARN' | 'ERROR' | 'CMD')}
          className="bg-surface-container-lowest border border-white/10 rounded-lg px-2.5 py-1.5 text-xs font-mono text-on-surface"
        >
          <option value="INFO">INFO</option>
          <option value="CMD">CMD</option>
          <option value="WARN">WARN</option>
          <option value="ERROR">ERROR</option>
        </select>
        <input
          type="text"
          value={customLogInput}
          onChange={(e) => setCustomLogInput(e.target.value)}
          placeholder="Write real-time entry directly to local PC logs/latest.log & MongoDB..."
          className="flex-1 bg-surface-container-lowest border border-white/10 rounded-lg px-3 py-1.5 text-xs font-mono text-on-surface focus:outline-none focus:border-primary"
        />
        <button
          type="submit"
          className="px-3 py-1.5 rounded-lg bg-primary text-on-primary text-xs font-mono font-bold hover:opacity-95 transition-opacity cursor-pointer shrink-0"
        >
          + Append to latest.log
        </button>
        <button
          type="button"
          onClick={handleRotateLogsOnDisk}
          className="px-3 py-1.5 rounded-lg bg-surface-container-high hover:bg-surface-bright text-on-surface text-xs font-mono font-semibold transition-colors cursor-pointer shrink-0"
        >
          Rotate Log on Disk
        </button>
      </form>

      {/* CONTROL CONSOLE: SEARCH, REGEX & GLOBAL TOGGLES */}
      <div className="rounded-xl bg-surface-container-low p-3.5 space-y-3 shadow-md mb-5">
        <div className="flex flex-col xl:flex-row items-stretch xl:items-center gap-3">
          {/* Search Input with Regex and Modifiers */}
          <div className="flex-1 flex items-center bg-surface-container-lowest rounded-lg px-3 py-1.5 shadow-inner gap-2">
            <span className="material-symbols-outlined text-outline text-title-md">search</span>
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="flex-1 bg-transparent border-0 p-0 text-on-surface placeholder:text-outline text-code-md font-code-md focus:ring-0 focus:outline-none"
              placeholder="Search logs with query or /regex/ (e.g. Can't keep up|Exception|WARN|Mio_Celestial)..."
            />
            <div className="flex items-center gap-1 shrink-0">
              <button
                type="button"
                onClick={() => setRegexMode(!regexMode)}
                className={`px-2 py-0.5 rounded text-code-sm font-code-sm transition-colors font-bold cursor-pointer ${
                  regexMode
                    ? 'bg-surface-container-high text-primary'
                    : 'bg-surface-container text-outline hover:text-on-surface'
                }`}
                title="Regular Expression Mode"
              >
                .*
              </button>
              <button
                type="button"
                onClick={() => setCaseSensitive(!caseSensitive)}
                className={`px-2 py-0.5 rounded text-code-sm font-code-sm transition-colors font-semibold cursor-pointer ${
                  caseSensitive
                    ? 'bg-surface-container-high text-primary'
                    : 'bg-surface-container text-outline hover:text-on-surface'
                }`}
                title="Match Case"
              >
                Aa
              </button>
              <button
                type="button"
                onClick={() => setInvertMatch(!invertMatch)}
                className={`px-2 py-0.5 rounded text-code-sm font-code-sm transition-colors font-semibold cursor-pointer ${
                  invertMatch
                    ? 'bg-surface-container-high text-primary'
                    : 'bg-surface-container text-outline hover:text-on-surface'
                }`}
                title="Invert Match"
              >
                !
              </button>
              <span className="w-px h-4 bg-surface-container-high mx-1" />
              <button
                type="button"
                onClick={() => setSearchQuery('')}
                className="text-outline hover:text-on-surface text-code-sm font-code-sm transition-colors cursor-pointer"
              >
                Clear
              </button>
            </div>
          </div>

          {/* Action Cluster */}
          <div className="flex flex-wrap items-center gap-2 justify-end">
            <button
              type="button"
              onClick={() => setAutoScroll(!autoScroll)}
              className={`flex items-center gap-2 px-3 py-1.5 rounded-lg transition-all shadow-sm cursor-pointer ${
                autoScroll
                  ? 'bg-surface-container-high text-secondary'
                  : 'bg-surface-container text-on-surface-variant'
              }`}
            >
              <span
                className={`size-2 rounded-full ${
                  autoScroll ? 'bg-secondary animate-ping' : 'bg-outline'
                }`}
              />
              <span className="text-code-sm font-code-sm font-semibold">Auto-Scroll</span>
            </button>

            <button
              type="button"
              onClick={() => setWrapLines(!wrapLines)}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg transition-colors text-code-sm font-code-sm cursor-pointer ${
                wrapLines
                  ? 'bg-surface-container-high text-primary font-bold'
                  : 'bg-surface-container text-on-surface-variant hover:text-on-surface'
              }`}
            >
              <span className="material-symbols-outlined text-title-md">wrap_text</span>
              <span>Wrap</span>
            </button>

            <div className="flex items-center rounded-lg bg-surface-container-lowest p-0.5">
              <span className="px-2.5 py-1 text-code-sm font-code-sm text-secondary flex items-center gap-1">
                <span className="size-1.5 rounded-full bg-secondary" />
                60Hz Live
              </span>
              <button
                type="button"
                onClick={() => setIsPaused(!isPaused)}
                className={`flex items-center gap-1 px-2.5 py-1 rounded bg-surface-container-high hover:bg-surface-bright transition-colors text-code-sm font-code-sm font-medium cursor-pointer ${
                  isPaused ? 'text-primary' : 'text-on-surface'
                }`}
              >
                <span className="material-symbols-outlined text-title-md">
                  {isPaused ? 'play_arrow' : 'pause'}
                </span>
                <span>{isPaused ? 'Resume' : 'Pause'}</span>
              </button>
            </div>

            <button
              type="button"
              onClick={() => {
                setSearchQuery('');
                setSelectedSeverity('ALL');
                setSelectedThread('ALL');
                onShowToast('Log Stream Flushed', 'Reset active log filters and refreshed tail buffer.', 'info');
              }}
              className="flex items-center gap-1 px-3 py-1.5 rounded-lg bg-surface-container text-on-surface-variant hover:text-on-surface hover:bg-surface-container-high transition-colors text-code-sm font-code-sm cursor-pointer"
            >
              <span className="material-symbols-outlined text-title-md">delete_sweep</span>
              <span>Flush</span>
            </button>

            <button
              type="button"
              onClick={() =>
                onShowToast(
                  'Exported latest.log',
                  'Downloaded 12,840 log entries (2.4 MB) to local Downloads.',
                  'success',
                  'download'
                )
              }
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-primary text-on-primary font-bold hover:bg-primary-fixed-dim transition-all shadow-sm text-code-sm font-code-sm cursor-pointer"
            >
              <span className="material-symbols-outlined text-title-md">download</span>
              <span>Export Logs</span>
            </button>
          </div>
        </div>

        {/* Severity Level Filter Badges */}
        <div className="flex flex-wrap items-center gap-1.5 pt-2">
          <span className="text-label-caps font-label-caps text-outline uppercase mr-1">Severity:</span>
          {[
            { id: 'ALL', label: 'All (12,840)', dot: null },
            { id: 'CRITICAL', label: 'CRITICAL (0)', dot: 'bg-error' },
            { id: 'ERROR', label: 'ERROR (3)', dot: 'bg-error' },
            { id: 'WARN', label: 'WARN (14)', dot: 'bg-primary-container' },
            { id: 'INFO', label: 'INFO (11,400)', dot: 'bg-tertiary' },
            { id: 'DEBUG', label: 'DEBUG (1,215)', dot: 'bg-outline' },
            { id: 'CHAT_CMDS', label: 'CHAT & CMDS (208)', dot: 'bg-secondary' },
          ].map((sev) => (
            <button
              key={sev.id}
              type="button"
              onClick={() => setSelectedSeverity(sev.id)}
              className={`px-2.5 py-1 rounded-md text-code-sm font-code-sm transition-colors cursor-pointer ${
                selectedSeverity === sev.id
                  ? 'bg-primary text-on-primary font-bold shadow-sm'
                  : 'bg-surface-container text-on-surface-variant hover:text-on-surface hover:bg-surface-container-high'
              }`}
            >
              {sev.dot && selectedSeverity !== sev.id && (
                <span className={`inline-block size-1.5 rounded-full ${sev.dot} mr-1`} />
              )}
              {sev.label}
            </button>
          ))}
        </div>
      </div>

      {/* WORKSPACE SPLIT (75% TERMINAL / 25% ARCHIVE & AUDIT SIDEBAR) */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-5 items-start">
        {/* LEFT MAIN TERMINAL PANEL (~75%) */}
        <div className="lg:col-span-8 xl:col-span-9 flex flex-col gap-3">
          <div className="rounded-xl bg-surface-container-lowest shadow-xl flex flex-col overflow-hidden">
            {/* Terminal Header */}
            <div className="bg-surface-container-low px-4 py-2.5 flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-3">
                <div className="flex items-center gap-2 px-2.5 py-1 rounded bg-surface-container text-on-surface font-code-sm text-code-sm">
                  <span className="material-symbols-outlined text-title-md text-secondary">terminal</span>
                  <span className="font-bold text-on-surface">latest.log</span>
                  <span className="text-outline-variant font-normal">(Live Active Stream)</span>
                  <span className="px-1.5 py-0.5 rounded bg-surface-container-high text-on-surface-variant text-code-sm">
                    2.4 MB
                  </span>
                </div>

                <div className="hidden sm:flex items-center gap-1 text-code-sm font-code-sm text-on-surface-variant">
                  <span className="text-outline text-label-caps font-label-caps mr-1">JUMP:</span>
                  {['Last 5m', 'Last 15m', 'Last 1h', 'Boot (14h ago)'].map((jmp, i) => (
                    <button
                      key={jmp}
                      type="button"
                      onClick={() =>
                        onShowToast(`Jumped to ${jmp}`, 'Updated log cursor offset.', 'info', 'schedule')
                      }
                      className={`px-2 py-0.5 rounded transition-colors cursor-pointer ${
                        i === 3
                          ? 'bg-surface-container-high text-primary font-medium'
                          : 'hover:bg-surface-container hover:text-on-surface'
                      }`}
                    >
                      {jmp}
                    </button>
                  ))}
                </div>
              </div>

              {/* Thread Pills */}
              <div className="flex items-center gap-1.5 overflow-x-auto py-1">
                {['ALL', 'Server thread', 'Watchdog', 'FastPipe IPC', 'Auth/Join'].map((th) => (
                  <button
                    key={th}
                    type="button"
                    onClick={() => setSelectedThread(th === selectedThread ? 'ALL' : th)}
                    className={`px-2 py-0.5 rounded font-code-sm text-code-sm transition-colors cursor-pointer ${
                      selectedThread === th || (th === 'Server thread' && selectedThread === 'ALL')
                        ? 'bg-surface-container-high text-tertiary'
                        : 'bg-surface-container text-on-surface-variant hover:text-on-surface'
                    }`}
                  >
                    [{th === 'ALL' ? 'All threads' : th}]
                  </button>
                ))}
              </div>
            </div>

            {/* High-Density Terminal Stream Area */}
            <div
              ref={viewportRef}
              className={`p-3 font-code-md text-code-md space-y-1.5 max-h-[640px] overflow-y-auto select-text text-on-surface bg-surface-container-lowest ${
                wrapLines ? 'whitespace-normal break-words' : 'overflow-x-auto'
              }`}
            >
              {filteredLogs.map((row) => {
                if (row.hasStacktrace) {
                  return (
                    <div key={row.lineNum} className="flex flex-col gap-1.5 p-2 rounded bg-error-container/10 group">
                      <div className="flex items-start gap-3">
                        <span className="text-error font-code-sm text-code-sm select-none w-14 shrink-0 text-right font-bold">
                          {row.lineNum}
                        </span>
                        <span className="text-outline select-none shrink-0">[{row.time}]</span>
                        <span className="px-1.5 py-0.5 rounded bg-error-container text-error text-code-sm font-bold shrink-0">
                          ERROR
                        </span>
                        <span className="text-error shrink-0">{row.tag}</span>
                        <span className="flex-1">
                          {row.content || (
                            <span className="text-error font-semibold">
                              {chunkFixed
                                ? '[RESOLVED] Chunk [X: -14, Z: 28] NBT entity tag sanitized by King Panel Chunk Fixer.'
                                : row.rawText}
                            </span>
                          )}
                        </span>
                        <button
                          type="button"
                          onClick={() => setStacktraceOpen(!stacktraceOpen)}
                          className="px-2 py-0.5 rounded bg-surface-container-highest text-on-surface-variant hover:text-on-surface text-code-sm font-code-sm shrink-0 cursor-pointer"
                        >
                          {stacktraceOpen ? 'Hide Trace' : 'Toggle Trace (16 lines)'}
                        </button>
                      </div>

                      {stacktraceOpen && (
                        <div className="ml-16 mr-2 mt-1 p-3 rounded-lg bg-surface-container-lowest text-on-surface-variant text-code-sm font-code-sm space-y-1">
                          <div className="text-error font-semibold font-code-md">
                            java.lang.IllegalArgumentException: Invalid NBT tag type 99 for entity
                            &apos;item_frame&apos;
                          </div>
                          <div className="text-outline pl-4 font-mono">
                            at net.minecraft.nbt.CompoundTag.getInt(CompoundTag.java:142) ~[paper-1.20.4.jar:git-Paper-498]
                          </div>
                          <div className="text-outline pl-4 font-mono">
                            at org.bukkit.craftbukkit.inventory.CraftMetaItem.applyToItem(CraftMetaItem.java:412)
                            ~[paper-1.20.4.jar:git-Paper-498]
                          </div>
                          <div className="text-outline pl-4 font-mono">
                            at net.minecraft.world.entity.decoration.ItemFrame.readAdditionalSaveData(ItemFrame.java:310)
                            ~[paper-1.20.4.jar:git-Paper-498]
                          </div>
                          <div className="text-outline pl-4 font-mono">
                            at net.minecraft.world.entity.Entity.load(Entity.java:1894) ~[paper-1.20.4.jar:git-Paper-498]
                          </div>
                          <div className="text-outline pl-4 font-mono">
                            at net.minecraft.world.level.chunk.storage.EntityStorage.lambda$readEntities$1(EntityStorage.java:108)
                            ~[paper-1.20.4.jar:git-Paper-498]
                          </div>
                          <div className="text-outline-variant pl-4">... 11 more common frames omitted</div>

                          {/* Quick Triage Action Matrix */}
                          <div className="flex flex-wrap items-center gap-2 pt-2 mt-2">
                            <span className="text-primary text-label-caps font-label-caps uppercase">
                              Quick Remediations:
                            </span>
                            <button
                              type="button"
                              onClick={() => {
                                setChunkFixed(true);
                                onShowToast(
                                  'Chunk Fixer Executed',
                                  'Sanitized corrupted ItemFrame NBT at chunk [X: -14, Z: 28].',
                                  'success',
                                  'build'
                                );
                              }}
                              className="px-2.5 py-1 rounded bg-primary text-on-primary font-bold text-code-sm hover:bg-primary-fixed-dim transition-colors cursor-pointer"
                            >
                              {chunkFixed ? 'Chunk Fixed ✓' : 'Run Chunk Fixer (X: -14, Z: 28)'}
                            </button>
                            <button
                              type="button"
                              onClick={() =>
                                onShowToast(
                                  'Warning Filter Added',
                                  'Suppressed ItemFrame CustomModelData warnings in PacketFilter.',
                                  'info',
                                  'notifications_off'
                                )
                              }
                              className="px-2.5 py-1 rounded bg-surface-container text-on-surface hover:bg-surface-container-high transition-colors text-code-sm cursor-pointer"
                            >
                              Suppress ItemFrame NBT Warnings
                            </button>
                            <button
                              type="button"
                              onClick={() => {
                                navigator.clipboard?.writeText('0x8F94D2').catch(() => {});
                                onShowToast('Exception Hash Copied', 'Copied 0x8F94D2 to clipboard.', 'success');
                              }}
                              className="px-2.5 py-1 rounded bg-surface-container text-outline hover:text-on-surface transition-colors text-code-sm cursor-pointer"
                            >
                              Copy Exception Hash (0x8F94D2)
                            </button>
                          </div>
                        </div>
                      )}
                    </div>
                  );
                }

                const badgeColors: Record<DetailedLogRow['severity'], string> = {
                  INFO: 'bg-tertiary-container/20 text-tertiary',
                  DEBUG: 'bg-surface-container-highest text-outline',
                  WARN: 'bg-primary/20 text-primary',
                  JOIN: 'bg-secondary-container/20 text-secondary',
                  ERROR: 'bg-error-container text-error',
                  CMD: 'bg-primary/20 text-primary',
                  GC: 'bg-surface-container-highest text-tertiary',
                };

                return (
                  <div
                    key={row.lineNum}
                    className={`flex items-start gap-3 hover:bg-surface-container-high/40 px-2 py-1 rounded transition-colors group ${
                      row.severity === 'WARN' ? 'bg-primary-container/5' : ''
                    }`}
                  >
                    <span className="text-outline-variant font-code-sm text-code-sm select-none w-14 shrink-0 text-right group-hover:text-primary">
                      {row.lineNum}
                    </span>
                    <span className="text-outline select-none shrink-0">[{row.time}]</span>
                    <span
                      className={`px-1.5 py-0.5 rounded text-code-sm font-bold shrink-0 ${
                        badgeColors[row.severity]
                      }`}
                    >
                      {row.severity}
                    </span>
                    <span className="text-outline shrink-0">{row.tag}</span>
                    <span className="text-on-surface">{row.content || row.rawText}</span>
                  </div>
                );
              })}
            </div>

            {/* Terminal Status Bar & Telemetry Footer */}
            <div className="bg-surface-container-low px-4 py-2 flex flex-wrap items-center justify-between gap-2 text-code-sm font-code-sm text-on-surface-variant">
              <div className="flex items-center gap-3">
                <span className="flex items-center gap-1.5">
                  <span className="size-1.5 rounded-full bg-secondary" />
                  <span className="text-on-surface font-semibold">
                    Line {logMeta?.lastLineNum ?? 12840}
                  </span>
                  <span className="text-outline-variant">•</span>
                  <span>
                    Showing {filteredLogs.length} of {logMeta?.totalLines ?? activeLogSource.length} live entries
                  </span>
                </span>
                <span className="text-outline-variant">•</span>
                <span className="text-outline font-mono">UTF-8 / CRLF</span>
                <span className="text-outline-variant">•</span>
                <span className="text-outline font-mono">Buffer: 92% headroom</span>
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => {
                    if (viewportRef.current) viewportRef.current.scrollTop = 0;
                  }}
                  className="flex items-center gap-1 px-2 py-1 rounded hover:bg-surface-container hover:text-on-surface transition-colors cursor-pointer"
                >
                  <span className="material-symbols-outlined text-body-sm">vertical_align_top</span>
                  <span>Top</span>
                </button>
                <button
                  type="button"
                  onClick={() => {
                    if (viewportRef.current)
                      viewportRef.current.scrollTop = viewportRef.current.scrollHeight;
                  }}
                  className="flex items-center gap-1 px-2 py-1 rounded bg-surface-container-high text-primary hover:bg-surface-bright transition-colors font-medium cursor-pointer"
                >
                  <span className="material-symbols-outlined text-body-sm">vertical_align_bottom</span>
                  <span>Bottom</span>
                </button>
              </div>
            </div>
          </div>

          {/* VISUAL LOG DISTRIBUTION / EVENT TIMELINE BAR CHART */}
          <div className="rounded-xl bg-surface-container-low p-4 shadow-sm space-y-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span className="material-symbols-outlined text-primary text-title-md">query_stats</span>
                <h3 className="text-headline-sm font-headline-sm text-on-surface">
                  24-Hour Event Density &amp; Fault Spikes
                </h3>
              </div>
              <span className="text-code-sm font-code-sm text-outline">Interval: 1 hour buckets</span>
            </div>

            <div className="relative w-full h-24 bg-surface-container-lowest rounded-lg p-2.5 flex items-end justify-between gap-1 overflow-hidden">
              <div className="absolute inset-x-0 top-1/4 h-px bg-surface-container-high/40 pointer-events-none" />
              <div className="absolute inset-x-0 top-2/4 h-px bg-surface-container-high/40 pointer-events-none" />
              <div className="absolute inset-x-0 top-3/4 h-px bg-surface-container-high/40 pointer-events-none" />

              {hourlyBars.map((bar) => (
                <div
                  key={bar.hour}
                  onClick={() =>
                    onShowToast(`Bucket ${bar.hour}:00`, bar.label, bar.isSpike ? 'error' : 'info', 'bar_chart')
                  }
                  className="flex-1 flex flex-col justify-end items-center gap-0.5 h-full group cursor-pointer"
                >
                  <div
                    className={`w-full rounded-t transition-colors ${bar.color}`}
                    style={{ height: bar.height }}
                    title={bar.label}
                  />
                  <span
                    className={`text-label-caps font-label-caps text-[9px] hidden sm:block ${
                      bar.isSpike
                        ? 'text-error font-bold'
                        : bar.isNow
                        ? 'text-primary font-bold'
                        : 'text-outline'
                    }`}
                  >
                    {bar.hour}
                  </span>
                </div>
              ))}
            </div>

            <div className="flex flex-wrap items-center justify-between text-code-sm font-code-sm text-outline-variant pt-1">
              <div className="flex items-center gap-4">
                <span className="flex items-center gap-1.5">
                  <span className="size-2 rounded bg-tertiary" /> Normal Telemetry
                </span>
                <span className="flex items-center gap-1.5">
                  <span className="size-2 rounded bg-primary" /> Tick Lag Warnings
                </span>
                <span className="flex items-center gap-1.5">
                  <span className="size-2 rounded bg-error" /> Exception / NBT Spike (13:00)
                </span>
              </div>
              <span className="text-on-surface-variant font-mono">Spike Peak: 1,480 ops/min at 13:42</span>
            </div>
          </div>
        </div>

        {/* RIGHT AUXILIARY SIDEBAR (~25%) */}
        <div className="lg:col-span-4 xl:col-span-3 flex flex-col gap-4">
          {/* CARD 1: HISTORICAL ARCHIVES (.log.gz) */}
          <div className="rounded-xl bg-surface-container-low p-4 shadow-md space-y-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span className="material-symbols-outlined text-primary text-title-md">archive</span>
                <h3 className="text-headline-sm font-headline-sm text-on-surface">Log Archives</h3>
              </div>
              <span className="text-code-sm font-code-sm px-2 py-0.5 rounded bg-surface-container-high text-on-surface-variant">
                .log.gz
              </span>
            </div>
            <p className="text-body-sm font-body-sm text-on-surface-variant">
              Rotated server runs archived automatically on restart and midnight UTC.
            </p>

            <div className="space-y-1.5 font-code-sm text-code-sm">
              {[
                { name: '2025-02-24-1.log.gz', sub: 'Yesterday • 4.2 MB (Watchdog kill)', crash: true },
                { name: '2025-02-23-3.log.gz', sub: '2 days ago • 1.8 MB (Normal rotation)', crash: false },
                { name: '2025-02-23-2.log.gz', sub: '2 days ago • 3.1 MB', crash: false },
                { name: '2025-02-22-1.log.gz', sub: '3 days ago • 2.9 MB', crash: false },
              ].map((arch) => (
                <div
                  key={arch.name}
                  className="p-2.5 rounded-lg bg-surface-container hover:bg-surface-container-high transition-colors flex items-center justify-between group"
                >
                  <div className="min-w-0">
                    <div className="flex items-center gap-1.5">
                      <span className="font-bold text-on-surface truncate">{arch.name}</span>
                      {arch.crash && (
                        <span
                          className="size-1.5 rounded-full bg-error"
                          title="Contained crash stacktrace"
                        />
                      )}
                    </div>
                    <div className="text-outline text-code-sm">{arch.sub}</div>
                  </div>
                  <div className="flex items-center gap-1 opacity-80 group-hover:opacity-100">
                    <button
                      type="button"
                      onClick={() =>
                        onShowToast(`Inspecting ${arch.name}`, 'Decompressing gzip stream in memory...', 'info', 'visibility')
                      }
                      className="p-1 rounded hover:bg-surface-bright text-on-surface cursor-pointer"
                      title="Inspect archive"
                    >
                      <span className="material-symbols-outlined text-body-md">visibility</span>
                    </button>
                    <button
                      type="button"
                      onClick={() =>
                        onShowToast(`Downloading ${arch.name}`, 'Saved compressed log archive.', 'success', 'download')
                      }
                      className="p-1 rounded hover:bg-surface-bright text-primary cursor-pointer"
                      title="Download .gz"
                    >
                      <span className="material-symbols-outlined text-body-md">download</span>
                    </button>
                  </div>
                </div>
              ))}
            </div>

            <button
              type="button"
              onClick={() => onNavigate('files')}
              className="w-full flex items-center justify-center gap-2 px-3 py-2 rounded-lg bg-surface-container-high hover:bg-surface-bright text-on-surface font-semibold text-code-sm font-code-sm transition-colors cursor-pointer"
            >
              <span className="material-symbols-outlined text-title-md">folder_open</span>
              <span>Open Logs in File Explorer</span>
            </button>
          </div>

          {/* CARD 2: AUDIT & GOVERNANCE HIGHLIGHTS */}
          <div className="rounded-xl bg-surface-container-low p-4 shadow-md space-y-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span className="material-symbols-outlined text-secondary text-title-md">shield</span>
                <h3 className="text-headline-sm font-headline-sm text-on-surface">Audit Highlights</h3>
              </div>
              <span className="text-label-caps font-label-caps text-secondary uppercase bg-secondary/10 px-2 py-0.5 rounded">
                Guarded
              </span>
            </div>
            <p className="text-body-sm font-body-sm text-on-surface-variant">
              Real-time parser monitoring privileged commands, security authentications and policy triggers.
            </p>

            <div className="space-y-2">
              <div
                onClick={() => setSelectedSeverity('CHAT_CMDS')}
                className="p-2.5 rounded-lg bg-surface-container hover:bg-surface-container-high transition-colors flex items-center justify-between cursor-pointer"
              >
                <div className="flex items-center gap-2.5">
                  <span className="size-8 rounded-lg bg-primary/10 text-primary flex items-center justify-center">
                    <span className="material-symbols-outlined text-title-md">admin_panel_settings</span>
                  </span>
                  <div>
                    <div className="text-code-sm font-code-sm font-bold text-on-surface">
                      OP &amp; Perm Changes
                    </div>
                    <div className="text-code-sm text-outline">2 issued today (Mio_Celestial)</div>
                  </div>
                </div>
                <span className="material-symbols-outlined text-outline text-title-md">chevron_right</span>
              </div>

              <div
                onClick={() => onNavigate('network')}
                className="p-2.5 rounded-lg bg-surface-container hover:bg-surface-container-high transition-colors flex items-center justify-between cursor-pointer"
              >
                <div className="flex items-center gap-2.5">
                  <span className="size-8 rounded-lg bg-secondary/10 text-secondary flex items-center justify-center">
                    <span className="material-symbols-outlined text-title-md">lock</span>
                  </span>
                  <div>
                    <div className="text-code-sm font-code-sm font-bold text-on-surface">
                      RCON / Console Auth
                    </div>
                    <div className="text-code-sm text-secondary">0 failed attempts (Secure)</div>
                  </div>
                </div>
                <span className="material-symbols-outlined text-outline text-title-md">chevron_right</span>
              </div>

              <div
                onClick={() => setSelectedSeverity('ERROR')}
                className="p-2.5 rounded-lg bg-surface-container hover:bg-surface-container-high transition-colors flex items-center justify-between cursor-pointer"
              >
                <div className="flex items-center gap-2.5">
                  <span className="size-8 rounded-lg bg-error/10 text-error flex items-center justify-center">
                    <span className="material-symbols-outlined text-title-md">bolt</span>
                  </span>
                  <div>
                    <div className="text-code-sm font-code-sm font-bold text-on-surface">
                      Plugin Crash Events
                    </div>
                    <div className="text-code-sm text-error">1 detected (PacketFilter)</div>
                  </div>
                </div>
                <span className="material-symbols-outlined text-outline text-title-md">chevron_right</span>
              </div>

              <div
                onClick={() => setSelectedSeverity('ALL')}
                className="p-2.5 rounded-lg bg-surface-container hover:bg-surface-container-high transition-colors flex items-center justify-between cursor-pointer"
              >
                <div className="flex items-center gap-2.5">
                  <span className="size-8 rounded-lg bg-tertiary/10 text-tertiary flex items-center justify-center">
                    <span className="material-symbols-outlined text-title-md">filter_alt</span>
                  </span>
                  <div>
                    <div className="text-code-sm font-code-sm font-bold text-on-surface">
                      Muted Chat / Banned Words
                    </div>
                    <div className="text-code-sm text-outline">4 caught by AutoMod</div>
                  </div>
                </div>
                <span className="material-symbols-outlined text-outline text-title-md">chevron_right</span>
              </div>
            </div>
          </div>

          {/* CARD 3: LOG RETENTION POLICY & DISK QUOTA */}
          <div className="rounded-xl bg-surface-container-low p-4 shadow-md space-y-3.5">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span className="material-symbols-outlined text-primary text-title-md">hard_drive</span>
                <h3 className="text-headline-sm font-headline-sm text-on-surface">
                  Retention &amp; Storage
                </h3>
              </div>
              <span className="text-code-sm font-code-sm text-secondary font-semibold">Healthy</span>
            </div>
            <div className="text-code-sm font-code-sm text-on-surface-variant space-y-1">
              <div className="flex justify-between">
                <span className="text-outline">Active Policy:</span>
                <span className="text-on-surface font-semibold">14 Days / Auto-Gzip</span>
              </div>
              <div className="flex justify-between">
                <span className="text-outline">Storage Quota:</span>
                <span className="text-on-surface font-semibold">420 MB of 1,024 MB</span>
              </div>
            </div>

            <div className="space-y-1.5">
              <div className="w-full bg-surface-container-lowest h-2 rounded-full overflow-hidden">
                <div
                  className="bg-gradient-to-r from-primary to-primary-container h-full rounded-full"
                  style={{ width: '41%' }}
                />
              </div>
              <div className="flex justify-between text-code-sm font-code-sm text-outline">
                <span>41% Allocated</span>
                <span>604 MB Free</span>
              </div>
            </div>

            <button
              type="button"
              onClick={() =>
                onShowToast(
                  'Pruned Old Log Archives',
                  'Removed 9 .log.gz files older than 7 days (Reclaimed 180 MB).',
                  'success',
                  'auto_delete'
                )
              }
              className="w-full flex items-center justify-center gap-2 px-3 py-2 rounded-lg bg-surface-container hover:bg-surface-container-high text-on-surface hover:text-primary transition-colors text-code-sm font-code-sm font-semibold cursor-pointer"
            >
              <span className="material-symbols-outlined text-title-md">auto_delete</span>
              <span>Prune Archives Older than 7d (Free 180 MB)</span>
            </button>
          </div>

          {/* CARD 4: HOST FASTPIPE IPC TELEMETRY */}
          <div className="rounded-xl bg-surface-container-low p-4 shadow-md space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-label-caps font-label-caps uppercase text-outline">
                IPC Shared Socket
              </span>
              <span className="text-code-sm font-code-sm text-secondary font-bold">
                127.0.0.1:{server.port}
              </span>
            </div>
            <div className="grid grid-cols-2 gap-2 text-code-sm font-code-sm">
              <div className="p-2 rounded bg-surface-container">
                <div className="text-outline">IPC Ingress</div>
                <div className="text-on-surface font-bold">4.8 MB/s</div>
              </div>
              <div className="p-2 rounded bg-surface-container">
                <div className="text-outline">Thread Lag</div>
                <div className="text-secondary font-bold">0.08 ms</div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
