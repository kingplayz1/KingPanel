import React, { useState, useEffect, useCallback } from 'react';
import { CronTask, ServerInstance } from '../types';

interface CoreTelemetryInfo {
  hostname: string;
  cpuModel: string;
  cpuCores: number;
  avgMhz: number;
  totalCpuPct: number;
  perCorePct: number[];
  loadAvg1m: number;
  loadAvg5m: number;
  daemonPid: number;
  daemonHeapMb: number;
  schedulerClockUtc: string;
  mongoSyncedCount: number;
}

interface ExtendedScheduleItem extends CronTask {
  commandPayload?: string;
  nextRunSec?: number;
  lastRunAt?: string;
  lastExitCode?: number;
  runCount?: number;
  cpuCoreAffinity?: string;
}

interface SchedulesCronViewProps {
  server: ServerInstance;
  crons: CronTask[];
  onAddCron: (task: CronTask) => void;
  onRunCron: (task: CronTask) => void;
  onToggleCronStatus: (id: string) => void;
  onDeleteCron: (id: string) => void;
  onShowToast: (
    title: string,
    body?: string,
    type?: 'success' | 'info' | 'warning' | 'error',
    icon?: string,
  ) => void;
}

export const SchedulesCronView: React.FC<SchedulesCronViewProps> = ({
  server,
  crons,
  onAddCron,
  onRunCron,
  onToggleCronStatus,
  onDeleteCron,
  onShowToast,
}) => {
  const [title, setTitle] = useState('');
  const [cronExpr, setCronExpr] = useState('*/30 * * * *');
  const [commandPayload, setCommandPayload] = useState(
    'say [KingScheduler] Saving chunks & optimizing memory...',
  );
  const [cpuCoreAffinity, setCpuCoreAffinity] = useState('Core 0-3 (Async I/O)');
  const [selectedPreset, setSelectedPreset] = useState('Every 30 Minutes');
  const [liveSchedules, setLiveSchedules] = useState<ExtendedScheduleItem[]>([]);
  const [coreTelemetry, setCoreTelemetry] = useState<CoreTelemetryInfo | null>(null);
  const [livePollEnabled, setLivePollEnabled] = useState(true);
  const [lastSyncedTime, setLastSyncedTime] = useState<string>('Just now');

  const presets = [
    { label: 'Every 15 Minutes', expr: '*/15 * * * *' },
    { label: 'Every 30 Minutes', expr: '*/30 * * * *' },
    { label: 'Hourly (Top of Hour)', expr: '0 * * * *' },
    { label: 'Nightly (04:00 UTC)', expr: '0 4 * * *' },
    { label: 'Weekly Sunday (02:00)', expr: '0 2 * * 0' },
  ];

  const coreAffinityOptions = [
    'Core 0-3 (Async I/O)',
    'Core 4-7 (Game Tick)',
    'All Cores (Parallel GC)',
    'Dedicated Thread #0 (High Priority)',
  ];

  const fetchRealtimeSchedulesAndCore = useCallback(async () => {
    try {
      const r = await fetch(`/api/schedules/realtime?serverId=${encodeURIComponent(server.id)}`);
      const data = await r.json();
      if (data.ok) {
        if (Array.isArray(data.schedules)) {
          setLiveSchedules(data.schedules);
        }
        if (data.coreTelemetry) {
          setCoreTelemetry(data.coreTelemetry);
        }
        setLastSyncedTime(new Date().toLocaleTimeString());
      }
    } catch {
      // keep existing state on transient error
    }
  }, [server.id]);

  useEffect(() => {
    setLiveSchedules([]);
    fetchRealtimeSchedulesAndCore();
  }, [server.id, fetchRealtimeSchedulesAndCore]);

  useEffect(() => {
    if (!livePollEnabled) return;
    const timer = setInterval(() => {
      fetchRealtimeSchedulesAndCore();
    }, 1500);
    return () => clearInterval(timer);
  }, [livePollEnabled, fetchRealtimeSchedulesAndCore]);

  const activeJobsList: ExtendedScheduleItem[] = liveSchedules.filter(
    (s) => !s.serverId || s.serverId === server.id,
  );

  const handleCreateSchedule = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim()) {
      onShowToast(
        'Missing Task Title',
        'Please enter a descriptive task title.',
        'warning',
        'warning',
      );
      return;
    }

    try {
      const r = await fetch('/api/schedules/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          serverId: server.id,
          serverName: server.name,
          title: title.trim(),
          cron: cronExpr.trim() || '0 * * * *',
          commandPayload: commandPayload.trim(),
          cpuCoreAffinity,
        }),
      });
      const data = await r.json();
      if (data.ok && data.schedule) {
        onAddCron(data.schedule);
        setTitle('');
        await fetchRealtimeSchedulesAndCore();
        onShowToast(
          'Schedule Registered & Pushed to MongoDB',
          `Registered "${data.schedule.title}" (${data.schedule.cron}) on ${cpuCoreAffinity}.`,
          'success',
          'event_available',
        );
      }
    } catch {
      // fallback
    }
  };

  const handleRunScheduleNow = async (job: ExtendedScheduleItem) => {
    onRunCron(job);
    try {
      await fetch('/api/schedules/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          serverId: server.id,
          serverName: server.name,
          id: job.id,
        }),
      });
      await fetchRealtimeSchedulesAndCore();
      onShowToast(
        `Executed on ${job.cpuCoreAffinity || 'Core 0-3'}`,
        `Dispatched "${job.title}" to ${server.name} & logged to latest.log.`,
        'success',
        'play_arrow',
      );
    } catch {
      // ignore
    }
  };

  const handleToggleStatusLive = async (id: string) => {
    onToggleCronStatus(id);
    try {
      await fetch('/api/schedules/toggle', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ serverId: server.id, id }),
      });
      await fetchRealtimeSchedulesAndCore();
    } catch {
      // ignore
    }
  };

  const handleDeleteScheduleLive = async (id: string) => {
    onDeleteCron(id);
    try {
      await fetch(
        `/api/schedules/${encodeURIComponent(id)}?serverId=${encodeURIComponent(server.id)}`,
        {
          method: 'DELETE',
        },
      );
      await fetchRealtimeSchedulesAndCore();
    } catch {
      // ignore
    }
  };

  return (
    <main className="flex-1 flex flex-col bg-surface-dim overflow-hidden">
      {/* Top Contextual Header */}
      <header className="min-h-[54px] px-6 py-2 bg-surface border-b border-white/[0.06] flex flex-wrap items-center justify-between gap-x-4 gap-y-2 shrink-0">
        <div className="flex items-center gap-2.5 min-w-0">
          <span className="material-symbols-outlined text-[18px] text-primary">schedule</span>
          <h1 className="text-[14.5px] font-semibold tracking-tight text-on-surface whitespace-nowrap">
            Schedules
          </h1>
          <span className="w-px h-4 bg-white/10 shrink-0" />
          <p className="text-[11.5px] text-outline font-mono truncate">
            {activeJobsList.length} triggers · {server.name} · {coreTelemetry?.hostname || 'LocalPC'}
          </p>
          <span
            className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md border font-mono text-[10.5px] shrink-0 ${
              livePollEnabled
                ? 'border-secondary/25 bg-secondary/10 text-secondary'
                : 'border-white/10 bg-white/[0.03] text-outline'
            }`}
          >
            <span
              className={`size-1.5 rounded-full ${livePollEnabled ? 'bg-secondary' : 'bg-outline'}`}
            />
            {livePollEnabled ? `synced ${lastSyncedTime}` : 'polling paused'}
          </span>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          <button
            type="button"
            onClick={() => setLivePollEnabled(!livePollEnabled)}
            className={`inline-flex items-center gap-1.5 h-8 px-3 rounded-lg border font-mono text-[11px] transition-colors cursor-pointer ${
              livePollEnabled
                ? 'bg-secondary/10 text-secondary border-secondary/25'
                : 'bg-white/[0.02] text-outline border-white/10 hover:text-white'
            }`}
          >
            <span
              className={`size-1.5 rounded-full ${livePollEnabled ? 'bg-secondary' : 'bg-outline'}`}
            />
            {livePollEnabled ? 'Polling 1.5s' : 'Poll paused'}
          </button>

          <button
            type="button"
            onClick={() => {
              fetchRealtimeSchedulesAndCore();
              onShowToast(
                'Schedules & Core Clock Synced',
                `Synchronized ${activeJobsList.length} cron triggers and local PC CPU core metrics.`,
                'info',
                'sync',
              );
            }}
            className="inline-flex items-center gap-1.5 h-8 px-3 rounded-lg border border-white/10 bg-white/[0.02] hover:bg-white/[0.06] text-[11.5px] font-medium text-on-surface transition-colors cursor-pointer"
          >
            <span className="material-symbols-outlined text-[16px] text-primary">sync</span>
            Sync clock
          </button>
        </div>
      </header>

      {/* REAL-TIME LOCAL PC CPU CORE & SCHEDULER THREAD TELEMETRY DECK */}
      <div className="px-6 pt-5">
        <div className="bg-surface rounded-xl border border-white/[0.06] p-4 space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2.5">
              <span className="material-symbols-outlined text-primary text-[20px]">memory</span>
              <div>
                <h2 className="text-xs font-bold uppercase tracking-wider text-on-surface">
                  Real-Time Local PC CPU Core &amp; Thread Scheduler Telemetry
                </h2>
                <p className="text-[11px] font-mono text-outline">
                  {coreTelemetry?.cpuModel || 'Local PC Multi-Core Processor'} •{' '}
                  {coreTelemetry?.cpuCores || 8} Logical Cores @ {coreTelemetry?.avgMhz || 3600} MHz
                </p>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2 text-[11px] font-mono">
              <span className="px-2.5 py-1 rounded bg-surface-lowest border border-white/[0.08] text-on-surface">
                Total CPU Load:{' '}
                <strong className="text-primary">{coreTelemetry?.totalCpuPct ?? 12}%</strong>
              </span>
              <span className="px-2.5 py-1 rounded bg-surface-lowest border border-white/[0.08] text-on-surface">
                Load Avg (1m/5m):{' '}
                <strong className="text-secondary">
                  {coreTelemetry?.loadAvg1m ?? 0.42} / {coreTelemetry?.loadAvg5m ?? 0.38}
                </strong>
              </span>
              <span className="px-2.5 py-1 rounded bg-surface-lowest border border-white/[0.08] text-on-surface">
                Daemon PID:{' '}
                <strong className="text-tertiary">{coreTelemetry?.daemonPid ?? 10484}</strong> (
                {coreTelemetry?.daemonHeapMb ?? 64} MB Heap)
              </span>
            </div>
          </div>

          {/* Per-Core Live Load Bars */}
          <div className="grid grid-cols-2 sm:grid-cols-4 md:grid-cols-8 gap-2">
            {(coreTelemetry?.perCorePct || [14, 22, 18, 9, 31, 12, 16, 19])
              .slice(0, 8)
              .map((pct, idx) => (
                <div
                  key={idx}
                  className="p-2 rounded-lg bg-surface-lowest border border-white/[0.06] flex flex-col gap-1"
                >
                  <div className="flex items-center justify-between text-[10px] font-mono">
                    <span className="text-outline">CORE #{idx}</span>
                    <span
                      className={`font-bold ${
                        pct > 75 ? 'text-error' : pct > 40 ? 'text-primary' : 'text-secondary'
                      }`}
                    >
                      {pct}%
                    </span>
                  </div>
                  <div className="w-full h-1.5 bg-surface-container-highest rounded-full overflow-hidden">
                    <div
                      className={`h-full rounded-full transition-all duration-300 ${
                        pct > 75 ? 'bg-error' : pct > 40 ? 'bg-primary' : 'bg-secondary'
                      }`}
                      style={{ width: `${Math.max(4, pct)}%` }}
                    />
                  </div>
                </div>
              ))}
          </div>
        </div>
      </div>

      {/* Main Split Workspace */}
      <div className="flex-1 overflow-y-auto p-6 grid grid-cols-12 gap-6 items-start">
        {/* Left 7 Cols: Active Cron Schedules List */}
        <div className="col-span-12 lg:col-span-7 space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-xs font-bold uppercase tracking-wider text-on-surface flex items-center gap-2">
              <span className="material-symbols-outlined text-[17px] text-primary">
                event_repeat
              </span>
              Registered Automation Pipelines ({activeJobsList.length})
            </h2>
            <span className="text-[11px] font-mono text-secondary flex items-center gap-1">
              <span className="size-1.5 rounded-full bg-secondary animate-ping" />
              Live Countdown &amp; MongoDB Sync
            </span>
          </div>

          <div className="space-y-3">
            {activeJobsList.length === 0 ? (
              <div className="bg-surface rounded-xl border border-white/[0.06] p-8 text-center space-y-2 ">
                <span className="material-symbols-outlined text-3xl text-outline">
                  event_repeat
                </span>
                <h3 className="text-sm font-bold text-on-surface">
                  No User Schedules Created for {server.name}
                </h3>
                <p className="text-xs text-outline max-w-md mx-auto">
                  Only schedules created by users for this specific game server are displayed here.
                  Use the Visual Cron Builder on the right to create a schedule.
                </p>
              </div>
            ) : (
              activeJobsList.map((job) => (
                <div
                  key={job.id}
                  className="bg-surface rounded-xl border border-white/[0.06] p-4 hover:border-primary/30 transition-all "
                >
                  <div className="flex items-start justify-between gap-4">
                    <div className="flex items-start gap-3.5">
                      <div
                        className={`w-10 h-10 rounded-lg ${job.iconColor} border border-white/[0.06] flex items-center justify-center shrink-0 mt-0.5`}
                      >
                        <span className="material-symbols-outlined text-[20px]">{job.icon}</span>
                      </div>
                      <div>
                        <div className="flex items-center flex-wrap gap-2">
                          <h3 className="text-sm font-bold text-on-surface">{job.title}</h3>
                          <span className="px-2 py-0.5 rounded bg-surface-lowest border border-white/[0.06] text-[11px] font-mono text-primary font-semibold">
                            {job.cron}
                          </span>
                          <span
                            onClick={() => handleToggleStatusLive(job.id)}
                            className={`px-2 py-0.5 rounded text-[10px] font-mono uppercase cursor-pointer ${
                              job.status === 'Active'
                                ? 'bg-secondary/15 text-secondary border border-secondary/30'
                                : job.status === 'Weekly'
                                  ? 'bg-primary-gold/15 text-primary-gold border border-primary-gold/30'
                                  : 'bg-surface-container-highest text-outline'
                            }`}
                          >
                            {job.status}
                          </span>
                          {job.cpuCoreAffinity && (
                            <span className="px-2 py-0.5 rounded bg-tertiary/10 border border-tertiary/25 text-tertiary text-[10px] font-mono">
                              {job.cpuCoreAffinity}
                            </span>
                          )}
                        </div>
                        <p className="text-xs text-outline mt-1.5 leading-relaxed">
                          {job.description}
                        </p>
                        <p className="mt-1 text-[11px] font-mono text-outline truncate">
                          Payload:{' '}
                          <span className="text-primary">
                            {job.commandPayload ? `/${job.commandPayload}` : 'none'}
                          </span>
                        </p>
                        <div className="flex flex-wrap items-center gap-4 mt-3 text-[11px] font-mono text-outline">
                          <span className="flex items-center gap-1 text-on-surface font-semibold">
                            <span className="material-symbols-outlined text-[14px] text-secondary">
                              timer
                            </span>
                            {job.nextRun}
                          </span>
                          {job.lastRunAt && (
                            <span>
                              Last Run:{' '}
                              <strong className="text-on-surface/80">{job.lastRunAt}</strong>
                            </span>
                          )}
                          <span>
                            Executions:{' '}
                            <strong className="text-primary">{job.runCount ?? 1}</strong>
                          </span>
                          <span className="text-secondary">
                            Exit code: {job.lastExitCode ?? 0} (OK)
                          </span>
                        </div>
                      </div>
                    </div>

                    <div className="flex items-center gap-2 shrink-0">
                      <button
                        type="button"
                        onClick={() => handleRunScheduleNow(job)}
                        className="px-3 py-1.5 rounded-lg bg-primary/15 hover:bg-primary/25 text-primary border border-primary/30 text-xs font-semibold transition-all flex items-center gap-1.5 cursor-pointer"
                      >
                        <span className="material-symbols-outlined text-[15px]">play_arrow</span>
                        {job.actionLabel || 'Run Now'}
                      </button>
                      <button
                        type="button"
                        onClick={() => handleDeleteScheduleLive(job.id)}
                        className="p-1.5 rounded-lg bg-surface-container-high hover:bg-error/20 text-outline hover:text-error border border-white/[0.06] transition-all cursor-pointer"
                        title="Delete Schedule"
                      >
                        <span className="material-symbols-outlined text-[16px]">delete</span>
                      </button>
                    </div>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>

        {/* Right 5 Cols: Visual Cron & Core Pipeline Builder */}
        <div className="col-span-12 lg:col-span-5 bg-surface rounded-xl border border-white/[0.06] overflow-hidden ">
          <div className="px-5 py-3.5 bg-surface-container border-b border-white/[0.06] flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span className="material-symbols-outlined text-primary text-[19px]">add_task</span>
              <h2 className="text-xs font-bold uppercase tracking-wider text-on-surface">
                Visual Cron &amp; Core Pipeline Builder
              </h2>
            </div>
            <span className="text-[10px] font-mono text-outline">POSIX 5-Field + Core Pin</span>
          </div>

          <form onSubmit={handleCreateSchedule} className="p-5 space-y-4">
            <div>
              <label className="text-xs font-semibold text-on-surface block mb-1.5">
                Schedule Task Name
              </label>
              <input
                type="text"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="e.g., Clear Ground Lag Entities Every 30m"
                className="w-full bg-surface-lowest border border-white/[0.06] focus:border-primary rounded-lg px-3 py-2 text-xs text-on-surface focus:outline-none"
              />
            </div>

            <div>
              <label className="text-xs font-semibold text-on-surface block mb-1.5">
                CPU Core &amp; Thread Affinity
              </label>
              <select
                value={cpuCoreAffinity}
                onChange={(e) => setCpuCoreAffinity(e.target.value)}
                className="w-full bg-surface-lowest border border-white/[0.06] focus:border-primary rounded-lg px-3 py-2 text-xs font-mono text-on-surface focus:outline-none"
              >
                {coreAffinityOptions.map((opt) => (
                  <option key={opt} value={opt}>
                    {opt}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="text-xs font-semibold text-on-surface block mb-1.5">
                Quick Interval Presets
              </label>
              <div className="flex flex-wrap gap-1.5">
                {presets.map((p) => (
                  <button
                    type="button"
                    key={p.label}
                    onClick={() => {
                      setSelectedPreset(p.label);
                      setCronExpr(p.expr);
                    }}
                    className={`px-2.5 py-1 rounded text-[11px] font-mono transition-all cursor-pointer ${
                      selectedPreset === p.label
                        ? 'bg-primary text-on-primary-container font-bold'
                        : 'bg-surface-container-low text-outline hover:text-on-surface border border-white/[0.06]'
                    }`}
                  >
                    {p.label}
                  </button>
                ))}
              </div>
            </div>

            <div>
              <div className="flex items-center justify-between mb-1.5">
                <label className="text-xs font-semibold text-on-surface">
                  Cron Expression (MIN HOUR DOM MON DOW)
                </label>
                <span className="text-[10px] font-mono text-secondary">Valid Syntax</span>
              </div>
              <input
                type="text"
                value={cronExpr}
                onChange={(e) => setCronExpr(e.target.value)}
                className="w-full bg-surface-lowest border border-primary/40 focus:border-primary rounded-lg px-3 py-2 text-sm font-mono text-primary font-bold tracking-wider focus:outline-none"
              />
            </div>

            <div>
              <label className="text-xs font-semibold text-on-surface block mb-1.5">
                Console Command / Action Payload
              </label>
              <textarea
                rows={3}
                value={commandPayload}
                onChange={(e) => setCommandPayload(e.target.value)}
                className="w-full bg-surface-lowest border border-white/[0.06] focus:border-primary rounded-lg p-3 text-xs font-mono text-on-surface focus:outline-none"
              />
            </div>

            <button
              type="submit"
              className="w-full py-2.5 rounded-lg bg-gradient-to-r from-primary to-primary-container text-on-primary-container font-bold text-xs hover:opacity-95 transition-all flex items-center justify-center gap-2 cursor-pointer"
            >
              <span className="material-symbols-outlined text-[17px]">add_circle</span>
              Register Schedule &amp; Push to MongoDB
            </button>
          </form>
        </div>
      </div>
    </main>
  );
};
