import React from 'react';
import type { OperationJob } from '../lib/jobs';

/**
 * Progress readout for a queued operation job: stage label, percentage bar and a
 * cancel button while the backend still allows cancellation. Every long-running
 * action (install, backup, restore, reinstall) renders this instead of a spinner.
 */
export const JobProgressBar: React.FC<{
  job: OperationJob | null;
  onCancel?: () => void;
  compact?: boolean;
  className?: string;
}> = ({ job, onCancel, compact = false, className = '' }) => {
  if (!job) return null;
  const percent = job.progress === null ? null : Math.max(0, Math.min(100, job.progress));
  const label = job.message || job.stage || 'Working…';
  const cancellable = job.cancellable && (job.status === 'queued' || job.status === 'running');

  return (
    <div
      className={`rounded-lg border border-white/10 bg-surface-lowest px-3 py-2.5 space-y-1.5 ${className}`}
      aria-live="polite"
    >
      <div className="flex items-center justify-between gap-2">
        <span className="text-[11px] text-on-surface truncate">{label}</span>
        <span className="text-[11px] font-mono text-primary shrink-0">
          {percent === null ? (job.stage || 'working') : `${percent}%`}
        </span>
      </div>
      <div className="h-1.5 rounded-full bg-white/[0.07] overflow-hidden">
        <div
          className={`h-full bg-primary transition-all duration-300 ${
            percent === null ? 'w-1/3 animate-pulse' : ''
          }`}
          style={percent === null ? undefined : { width: `${percent}%` }}
        />
      </div>
      {!compact && (
        <div className="flex items-center justify-between gap-2">
          <span className="text-[10px] text-outline font-mono truncate">
            {job.title}
            {job.actor ? ` · ${job.actor}` : ''}
          </span>
          {cancellable && onCancel && (
            <button
              type="button"
              onClick={onCancel}
              className="text-[10px] font-semibold text-[#ff8a80] hover:underline cursor-pointer shrink-0"
            >
              Cancel
            </button>
          )}
        </div>
      )}
    </div>
  );
};

export default JobProgressBar;
