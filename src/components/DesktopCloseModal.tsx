import React, { useEffect } from 'react';
import { X, Server, Power, ArrowRight, ShieldAlert, Minimize2 } from 'lucide-react';
import { BRAND } from '../branding';

/**
 * Exit confirmation dialog for the desktop app — ported from the website fork's
 * DesktopCloseModal and adapted for Electron IPC.
 *
 * Three honest choices:
 * - Hide to tray: window disappears, KingPanel (and anything it runs)
 * keeps running in the background.
 * - Quit: shuts down the app and its local management service.
 * - Cancel: stay in the panel.
 */
interface DesktopCloseModalProps {
  isOpen: boolean;
  onClose: () => void;
  serverRunning: boolean;
  serverName?: string;
}

export const DesktopCloseModal: React.FC<DesktopCloseModalProps> = ({
  isOpen,
  onClose,
  serverRunning,
  serverName = 'server',
}) => {
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    if (isOpen) {
      window.addEventListener('keydown', handleKeyDown);
    }
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const hideToTray = () => {
    if (window.electronic?.hideToTray) {
      window.electronic.hideToTray();
    } else {
      onClose();
    }
  };

  const quitApp = () => {
    if (window.electronic?.quit) {
      window.electronic.quit();
    } else {
      onClose();
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 backdrop-blur-xs p-4">
      <div className="w-full max-w-md rounded-xl bg-[#0f172a] border border-white/[0.08] p-6 text-slate-200">
        <div className="flex items-center justify-between pb-4 border-b border-white/[0.08]">
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-lg bg-amber-500/10 text-amber-400">
              <ShieldAlert className="w-5 h-5" />
            </div>
            <div>
              <h3 className="text-base font-semibold text-white">Exit {BRAND.name}</h3>
              <p className="text-xs text-slate-400">{BRAND.descriptor}</p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Cancel"
            className="p-1 rounded-md text-slate-400 hover:text-white hover:bg-white/10 transition"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="py-4 text-sm text-slate-300 space-y-2">
          {serverRunning ? (
            <div className="p-3 rounded-lg bg-emerald-950/40 border border-emerald-500/20 text-emerald-300 text-xs">
              <div className="flex items-center gap-2 font-semibold">
                <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
                Active game server: {serverName}
              </div>
              <p className="mt-1 text-slate-400">
                Hide the window to keep this server running in the background, or quit to shut down
                the local management service.
              </p>
            </div>
          ) : (
            <p className="text-xs text-slate-400">
              {`Hide the window to keep ${BRAND.name} running in the system tray, or quit the application completely.`}
            </p>
          )}
        </div>

        <div className="flex flex-col gap-2 pt-2">
          <button
            type="button"
            onClick={hideToTray}
            className="w-full flex items-center justify-between px-4 py-2.5 rounded-lg bg-amber-500 hover:bg-amber-600 text-slate-950 text-xs font-semibold transition"
          >
            <div className="flex items-center gap-2">
              <Minimize2 className="w-4 h-4" />
              <span>Hide to Tray (keep running)</span>
            </div>
            <ArrowRight className="w-3.5 h-3.5" />
          </button>

          <button
            type="button"
            onClick={quitApp}
            className="w-full flex items-center justify-between px-4 py-2.5 rounded-lg bg-red-950/40 hover:bg-red-900/60 border border-red-500/30 text-red-300 text-xs font-medium transition"
          >
            <div className="flex items-center gap-2">
              <Power className="w-4 h-4 text-red-400" />
              <span>Quit {BRAND.name}</span>
            </div>
            <ArrowRight className="w-3.5 h-3.5" />
          </button>

          <button
            type="button"
            onClick={onClose}
            className="w-full px-4 py-2 rounded-lg bg-white/5 hover:bg-white/10 text-slate-300 text-xs font-medium transition"
          >
            Cancel (Return to Panel)
          </button>
        </div>

        <p className="mt-3 flex items-center gap-1.5 text-[11px] text-slate-500">
          <Server className="w-3 h-3" />
          The window can always be reopened from the system tray.
        </p>
      </div>
    </div>
  );
};

export default DesktopCloseModal;
