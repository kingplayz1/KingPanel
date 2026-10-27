import { ServerInstance } from '../../types';

export type SimpleSectionKey =
  | 'console'
  | 'files'
  | 'database'
  | 'schedules'
  | 'backups'
  | 'network'
  | 'startup'
  | 'settings'
  | 'logs';

export type ToastFn = (
  title: string,
  body?: string,
  type?: 'success' | 'info' | 'warning' | 'error',
  icon?: string
) => void;

export interface SectionProps {
  server: ServerInstance;
  onShowToast: ToastFn;
}

export const SIMPLE_SECTIONS: Array<{ key: SimpleSectionKey; label: string; icon: string }> = [
  { key: 'console', label: 'Console', icon: 'monitoring' },
  { key: 'files', label: 'Files', icon: 'folder_open' },
  { key: 'database', label: 'Database', icon: 'database' },
  { key: 'schedules', label: 'Schedules', icon: 'schedule' },
  { key: 'backups', label: 'Backups', icon: 'inventory_2' },
  { key: 'network', label: 'Network', icon: 'lan' },
  { key: 'startup', label: 'Startup', icon: 'rocket_launch' },
  { key: 'settings', label: 'Settings', icon: 'settings' },
  { key: 'logs', label: 'Logs', icon: 'receipt_long' },
];

/** Sanitize a server id the same way the backend builds per-server DB names. */
export const serverDbSlug = (serverId: string): string =>
  String(serverId || '')
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '')
    .slice(0, 48) || 'server';

export const formatBytes = (bytes: number): string => {
  if (!bytes) return '0 B';
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
};

export const cardClass = 'rounded-2xl bg-surface-container border border-white/10 p-4';
export const cardTitleClass = 'text-sm font-bold text-white flex items-center gap-2';
export const inputClass =
  'w-full bg-surface-lowest border border-white/15 focus:border-primary rounded-xl px-3.5 py-2.5 text-xs font-mono text-white focus:outline-none';
export const smallInputClass =
  'bg-surface-lowest border border-white/15 focus:border-primary rounded-lg px-2.5 py-2 text-xs font-mono text-white focus:outline-none';
export const primaryBtnClass =
  'px-4 py-2.5 rounded-xl bg-primary hover:opacity-95 text-on-primary-container text-xs font-bold flex items-center gap-1.5 cursor-pointer disabled:opacity-40';
export const ghostBtnClass =
  'px-3 py-2 rounded-xl bg-white/5 hover:bg-white/10 border border-white/15 text-xs font-semibold text-white flex items-center gap-1.5 cursor-pointer disabled:opacity-40';
export const dangerBtnClass =
  'px-3 py-2 rounded-xl bg-error/15 hover:bg-error/25 border border-error/30 text-error text-xs font-semibold flex items-center gap-1.5 cursor-pointer disabled:opacity-40';
