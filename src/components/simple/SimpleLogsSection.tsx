import React, { useCallback, useEffect, useState } from 'react';
import { SectionProps, cardClass, cardTitleClass, ghostBtnClass, smallInputClass } from './types';

/**
 * Logs tab: the change log for this server — every panel action that touched it
 * (jar installs, restarts, settings, backups, schedules), read from the panel
 * audit trail. Filterable and refreshable.
 */

interface ChangeEntry {
  id: string;
  time: string;
  category: string;
  message: string;
  actor: string;
}

// Audit entries carry a short clock label (`12:11:09 am`) and an id with the
// epoch millis — build a real timestamp from the id when possible.
const formatEntryTime = (entry: ChangeEntry): string => {
  const match = /^evt-(\d{10,})/.exec(entry.id || '');
  if (match) {
    const when = new Date(Number(match[1]));
    if (!Number.isNaN(when.getTime())) return when.toLocaleString();
  }
  return entry.time;
};

const categoryStyle = (category: string): string => {
  switch (category) {
    case 'RAM_ALLOC':
      return 'text-secondary border-secondary/40 bg-secondary/10';
    case 'SIGKILL':
      return 'text-error border-error/40 bg-error/10';
    case 'OAUTH':
      return 'text-amber-300 border-amber-400/40 bg-amber-400/10';
    default:
      return 'text-primary border-primary/40 bg-primary/10';
  }
};

export const SimpleLogsSection: React.FC<SectionProps> = ({ server }) => {
  const [entries, setEntries] = useState<ChangeEntry[]>([]);
  const [filter, setFilter] = useState('');
  const [loading, setLoading] = useState(false);
  const [setupUpdatedAt, setSetupUpdatedAt] = useState<string | null>(null);

  const query = `serverId=${encodeURIComponent(server.id)}&serverName=${encodeURIComponent(server.name)}`;

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/server-runtime/changelog?${query}`);
      const data = await res.json();
      if (data?.ok) {
        setEntries(data.entries || []);
        setSetupUpdatedAt(data.setupUpdatedAt || null);
      }
    } catch {
      // backend restarting
    } finally {
      setLoading(false);
    }
  }, [query]);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 10_000);
    return () => clearInterval(timer);
  }, [refresh]);

  const visible = entries.filter((entry) =>
    filter.trim() ? entry.message.toLowerCase().includes(filter.toLowerCase()) : true
  );

  return (
    <div className={cardClass}>
      <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
        <div>
          <h2 className={cardTitleClass}>
            <span className="material-symbols-outlined text-[18px] text-primary">receipt_long</span>
            Change log · {server.name}
          </h2>
          <p className="text-[11px] text-outline mt-1">
            {entries.length} entries from the panel audit trail
            {setupUpdatedAt ? ` · setup last changed ${new Date(setupUpdatedAt).toLocaleString()}` : ''}
          </p>
        </div>
        <div className="flex items-center gap-1.5">
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="filter changes…"
            className={`${smallInputClass} w-44`}
          />
          <button type="button" onClick={() => void refresh()} className={ghostBtnClass} disabled={loading}>
            <span className="material-symbols-outlined text-[16px]">{loading ? 'hourglass_top' : 'refresh'}</span>
          </button>
        </div>
      </div>

      {visible.length === 0 ? (
        <p className="text-xs text-outline py-8 text-center">
          {entries.length === 0
            ? 'No recorded changes for this server yet. Installing a jar, starting it or changing settings will show up here.'
            : 'No entries match that filter.'}
        </p>
      ) : (
        <ul className="space-y-1.5 max-h-[calc(100vh-320px)] overflow-y-auto pr-1">
          {visible.map((entry) => (
            <li
              key={entry.id}
              className="rounded-xl bg-surface-lowest border border-white/10 px-3 py-2 flex flex-wrap items-start gap-2"
            >
              <span
                className={`text-[9.5px] font-bold px-1.5 py-0.5 rounded border shrink-0 ${categoryStyle(entry.category)}`}
              >
                {entry.category}
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-[11.5px] text-white break-words">{entry.message}</p>
                <p className="text-[10px] text-outline font-mono mt-0.5">
                  {formatEntryTime(entry)} · {entry.actor}
                </p>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
};
