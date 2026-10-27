import React, { useCallback, useEffect, useState } from 'react';
import { SectionProps, cardClass, cardTitleClass, dangerBtnClass, ghostBtnClass, inputClass, primaryBtnClass, smallInputClass } from './types';

/**
 * Schedules tab: real interval jobs executed by the panel backend through the
 * process supervisor (console command, restart, stop, backup).
 */

type ScheduleAction = 'command' | 'restart' | 'stop' | 'backup';

interface ScheduleRecord {
  id: string;
  serverId: string;
  title: string;
  action: ScheduleAction;
  payload: string;
  intervalMinutes: number;
  enabled: boolean;
  nextRunAt: number;
  lastRunAt: string | null;
  lastResult: string | null;
  runCount: number;
}

const ACTION_LABELS: Record<ScheduleAction, string> = {
  command: 'Console command',
  restart: 'Restart server',
  stop: 'Stop server',
  backup: 'Create backup',
};

const describeInterval = (minutes: number): string => {
  if (minutes % 1440 === 0 && minutes >= 1440) return `every ${minutes / 1440}d`;
  if (minutes % 60 === 0 && minutes >= 60) return `every ${minutes / 60}h`;
  return `every ${minutes}m`;
};

const formatWhen = (at: number | null): string => {
  if (!at) return '—';
  const diffMs = at - Date.now();
  if (diffMs <= 0) return 'due now';
  const mins = Math.ceil(diffMs / 60_000);
  if (mins < 60) return `in ${mins}m`;
  const hours = Math.floor(mins / 60);
  return `in ${hours}h ${mins % 60}m`;
};

export const SimpleSchedulesSection: React.FC<SectionProps> = ({ server, onShowToast }) => {
  const [schedules, setSchedules] = useState<ScheduleRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [form, setForm] = useState<{ title: string; action: ScheduleAction; payload: string; intervalMinutes: string }>({
    title: '',
    action: 'command',
    payload: 'save-all flush',
    intervalMinutes: '30',
  });

  const query = `serverId=${encodeURIComponent(server.id)}&serverName=${encodeURIComponent(server.name)}`;

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/server-runtime/schedules?${query}`);
      const data = await res.json();
      if (data?.ok) setSchedules(data.schedules || []);
    } finally {
      setLoading(false);
    }
  }, [query]);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 5000);
    return () => clearInterval(timer);
  }, [refresh]);

  const create = async () => {
    if (!form.title.trim()) {
      onShowToast('Name your schedule', 'A title helps you recognise the job later', 'warning');
      return;
    }
    const res = await fetch('/api/server-runtime/schedule-create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        serverId: server.id,
        serverName: server.name,
        title: form.title.trim(),
        action: form.action,
        payload: form.action === 'restart' || form.action === 'stop' ? '' : form.payload,
        intervalMinutes: Number(form.intervalMinutes) || 30,
      }),
    });
    const data = await res.json();
    if (!data?.ok) {
      onShowToast('Could not create schedule', data?.error, 'error');
      return;
    }
    setForm({ ...form, title: '' });
    onShowToast('Schedule created', `${form.title} — ${describeInterval(Number(form.intervalMinutes) || 30)}`, 'success', 'schedule');
    await refresh();
  };

  const toggle = async (job: ScheduleRecord) => {
    setBusy(job.id);
    try {
      const res = await fetch('/api/server-runtime/schedule-update', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: job.id, enabled: !job.enabled }),
      });
      const data = await res.json();
      if (data?.ok) setSchedules(data.schedules || []);
    } finally {
      setBusy(null);
    }
  };

  const runNow = async (job: ScheduleRecord) => {
    setBusy(job.id);
    try {
      const res = await fetch('/api/server-runtime/schedule-run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: job.id }),
      });
      const data = await res.json();
      if (!data?.ok) {
        onShowToast('Run failed', data?.error, 'error');
        return;
      }
      onShowToast('Schedule executed', `${job.title}: ${data.result}`, data.result.startsWith('failed') ? 'warning' : 'success', 'play_arrow');
      setSchedules(data.schedules || []);
    } finally {
      setBusy(null);
    }
  };

  const remove = async (job: ScheduleRecord) => {
    setBusy(job.id);
    try {
      const res = await fetch(`/api/server-runtime/schedule/${encodeURIComponent(job.id)}`, { method: 'DELETE' });
      const data = await res.json();
      if (data?.ok) setSchedules(data.schedules || []);
      onShowToast('Schedule deleted', job.title, 'success', 'delete');
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="space-y-4">
      <div className={cardClass}>
        <h2 className={`${cardTitleClass} mb-3`}>
          <span className="material-symbols-outlined text-[18px] text-primary">schedule</span>
          New schedule
        </h2>
        <div className="grid grid-cols-1 md:grid-cols-4 gap-2">
          <input
            value={form.title}
            onChange={(e) => setForm({ ...form, title: e.target.value })}
            placeholder="Nightly save + backup"
            className={inputClass}
          />
          <select
            value={form.action}
            onChange={(e) => setForm({ ...form, action: e.target.value as ScheduleAction })}
            className={inputClass}
          >
            {(Object.keys(ACTION_LABELS) as ScheduleAction[]).map((action) => (
              <option key={action} value={action}>
                {ACTION_LABELS[action]}
              </option>
            ))}
          </select>
          <input
            value={form.payload}
            onChange={(e) => setForm({ ...form, payload: e.target.value })}
            disabled={form.action === 'restart' || form.action === 'stop'}
            placeholder={
              form.action === 'backup'
                ? 'backup label (e.g. nightly)'
                : form.action === 'command'
                  ? 'save-all flush'
                  : 'not used by this action'
            }
            title="Payload: the console command (without the leading /) or the backup label"
            className={`${inputClass} disabled:opacity-50`}
          />
          <div className="flex items-center gap-1.5">
            <input
              value={form.intervalMinutes}
              onChange={(e) => setForm({ ...form, intervalMinutes: e.target.value })}
              type="number"
              min={1}
              className={`${smallInputClass} w-20`}
            />
            <span className="text-[11px] text-outline">min</span>
            <button type="button" onClick={() => void create()} className={`${primaryBtnClass} ml-auto`}>
              <span className="material-symbols-outlined text-[16px]">add</span>
              Add
            </button>
          </div>
        </div>
      </div>

      <div className={cardClass}>
        <div className="flex items-center justify-between mb-2">
          <h2 className={cardTitleClass}>
            <span className="material-symbols-outlined text-[18px] text-primary">event_repeat</span>
            Schedules for {server.name}
          </h2>
          <button type="button" onClick={() => void refresh()} className={ghostBtnClass} disabled={loading}>
            <span className="material-symbols-outlined text-[16px]">refresh</span>
          </button>
        </div>

        {schedules.length === 0 ? (
          <p className="text-xs text-outline py-6 text-center">
            No schedules yet. Jobs are executed by the panel backend, so they keep running while the panel is open.
          </p>
        ) : (
          <ul className="space-y-2">
            {schedules.map((job) => (
              <li
                key={job.id}
                className="rounded-xl bg-surface-lowest border border-white/10 px-3.5 py-3 flex flex-wrap items-center gap-3"
              >
                <div className="min-w-0 flex-1">
                  <p className="text-xs font-bold text-white flex items-center gap-2">
                    <span className={`w-2 h-2 rounded-full ${job.enabled ? 'bg-secondary' : 'bg-outline'}`} />
                    {job.title}
                  </p>
                  <p className="text-[11px] text-outline font-mono truncate">
                    {ACTION_LABELS[job.action]} · {describeInterval(job.intervalMinutes)}
                  </p>
                  <p className="text-[11px] font-mono truncate" title={job.payload || 'No payload'}
                  >
                    <span className="text-outline">Payload:</span>{' '}
                    <span className="text-primary">
                      {job.payload ? (job.action === 'backup' ? job.payload : `/${job.payload}`) : 'none'}
                    </span>
                  </p>
                  <p className="text-[10.5px] text-outline mt-0.5">
                    Next {formatWhen(job.nextRunAt)} · ran {job.runCount}×
                    {job.lastResult ? ` · last: ${job.lastResult}` : ''}
                  </p>
                </div>
                <div className="flex items-center gap-1.5">
                  <button type="button" onClick={() => void runNow(job)} disabled={busy === job.id} className={ghostBtnClass}>
                    <span className="material-symbols-outlined text-[16px]">play_arrow</span>
                    Run now
                  </button>
                  <button type="button" onClick={() => void toggle(job)} disabled={busy === job.id} className={ghostBtnClass}>
                    <span className="material-symbols-outlined text-[16px]">{job.enabled ? 'pause_circle' : 'play_circle'}</span>
                    {job.enabled ? 'Pause' : 'Resume'}
                  </button>
                  <button type="button" onClick={() => void remove(job)} disabled={busy === job.id} className={dangerBtnClass}>
                    <span className="material-symbols-outlined text-[16px]">delete</span>
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
};
