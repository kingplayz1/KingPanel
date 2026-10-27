import React, { useEffect, useState } from 'react';
import type { OperationJob } from '../lib/jobs';
import { JobProgressBar } from './JobProgressBar';

interface EulaConsentModalProps {
  isOpen: boolean;
  serverName?: string;
  busy?: boolean;
  /** Live install job, shown as a progress bar once the download has started. */
  job?: OperationJob | null;
  onCancel?: () => void;
  onAccept: () => void;
  onDecline: () => void;
}

/**
 * Minecraft EULA consent step shown before a new server folder is created or a
 * server is re-provisioned. Nothing is written to disk until "I agree" is
 * checked and accepted; declining cancels the install.
 */
export const EulaConsentModal: React.FC<EulaConsentModalProps> = ({
  isOpen,
  serverName,
  busy = false,
  job = null,
  onCancel,
  onAccept,
  onDecline,
}) => {
  const [agreed, setAgreed] = useState(false);

  useEffect(() => {
    if (isOpen) setAgreed(false);
  }, [isOpen]);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-[60] bg-black/80 backdrop-blur-md flex items-center justify-center p-4">
      <div className="w-full max-w-lg rounded-xl bg-surface border border-white/15 overflow-hidden">
        <div className="px-5 py-4 border-b border-white/[0.08] bg-surface-container flex items-start gap-3">
          <div className="size-9 rounded-lg bg-primary/15 border border-primary/35 flex items-center justify-center text-primary shrink-0">
            <span className="material-symbols-outlined text-[20px]">gavel</span>
          </div>
          <div className="min-w-0">
            <h3 className="text-sm font-bold text-white">Minecraft End User License Agreement</h3>
            <p className="text-[11px] text-outline">
              {serverName ? (
                <>
                  Required before installing <span className="text-primary font-mono">{serverName}</span>
                </>
              ) : (
                'Required before installing a server'
              )}
            </p>
          </div>
        </div>

        <div className="p-5 space-y-3">
          <div className="max-h-48 overflow-y-auto rounded-lg bg-surface-lowest border border-white/[0.08] p-3 space-y-2 text-[11.5px] leading-relaxed text-outline">
            <p>
              By downloading and running the Minecraft server software you agree to Mojang's End User
              License Agreement. The panel only creates the server folder and downloads the engine
              jar you selected.
            </p>
            <p>
              You confirm you own a legitimate Minecraft account and that you will not redistribute
              the server software or use it to provide paid access without Mojang's permission.
            </p>
            <p className="text-on-surface">
              The full agreement is available at{' '}
              <a
                href="https://aka.ms/MinecraftEULA"
                target="_blank"
                rel="noopener noreferrer"
                className="text-primary hover:underline font-mono"
              >
                aka.ms/MinecraftEULA
              </a>
              .
            </p>
          </div>

          <label className="flex items-start gap-2.5 cursor-pointer select-none rounded-lg border border-white/[0.08] bg-surface-lowest px-3 py-2.5">
            <input
              type="checkbox"
              checked={agreed}
              onChange={(e) => setAgreed(e.target.checked)}
              className="mt-0.5 size-3.5 accent-[color:var(--color-primary,#e6b450)] cursor-pointer"
            />
            <span className="text-xs text-on-surface">
              I agree to the Minecraft EULA and want to install this server.
            </span>
          </label>

          {busy && job ? (
            <JobProgressBar job={job} onCancel={onCancel} />
          ) : (
            <p className="text-[11px] text-outline">
              Choosing <span className="text-white font-semibold">Don't accept</span> cancels the
              installation — no folder, jar or config file is written.
            </p>
          )}
        </div>

        <div className="px-5 py-3.5 bg-surface-container border-t border-white/[0.08] flex flex-wrap items-center justify-between gap-2">
          <button
            type="button"
            onClick={onDecline}
            disabled={busy}
            className="px-4 h-9 rounded-lg bg-error/10 hover:bg-error/20 border border-error/30 text-error text-xs font-semibold cursor-pointer disabled:opacity-50"
          >
            Don't accept
          </button>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onDecline}
              disabled={busy}
              className="px-4 h-9 rounded-lg bg-white/5 hover:bg-white/10 text-xs font-medium text-outline hover:text-white cursor-pointer disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={onAccept}
              disabled={!agreed || busy}
              className="px-4 h-9 rounded-lg bg-primary hover:opacity-95 text-on-primary-container text-xs font-bold flex items-center gap-1.5 cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
            >
              <span className="material-symbols-outlined text-[16px]">
                {busy ? 'progress_activity' : 'check_circle'}
              </span>
              {busy ? 'Installing…' : 'I agree — install'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default EulaConsentModal;
