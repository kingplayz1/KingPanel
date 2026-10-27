import React from 'react';

/**
 * Minimal window controls for the simple panel pages.
 *
 * The desktop title bar (server switcher / search / command palette) is hidden
 * on the simple pages, but the Electron window is frameless, so these buttons
 * keep minimize / restore / close reachable there.
 */
export const SimpleWindowControls: React.FC<{ className?: string }> = ({ className = '' }) => {
  const minimize = () => {
    if (window.electronic?.minimize) {
      void window.electronic.minimize();
      return;
    }
  };

  const toggleMaximize = () => {
    if (window.electronic?.maximize) {
      void window.electronic.maximize();
    }
  };

  const close = () => {
    if (window.electronic?.close) {
      void window.electronic.close();
    }
  };

  return (
    <div className={`flex items-center gap-1.5 ${className}`}>
      <button
        type="button"
        onClick={minimize}
        title="Minimize"
        className="w-8 h-8 rounded-lg bg-white/5 hover:bg-white/15 border border-white/[0.08] text-outline hover:text-white flex items-center justify-center cursor-pointer transition-colors"
      >
        <span className="material-symbols-outlined text-[16px]">remove</span>
      </button>
      <button
        type="button"
        onClick={toggleMaximize}
        title="Maximize / Restore"
        className="w-8 h-8 rounded-lg bg-white/5 hover:bg-white/15 border border-white/[0.08] text-outline hover:text-white flex items-center justify-center cursor-pointer transition-colors"
      >
        <span className="material-symbols-outlined text-[15px]">crop_square</span>
      </button>
      <button
        type="button"
        onClick={close}
        title="Close window (keeps panel running in the tray)"
        className="w-8 h-8 rounded-lg bg-white/5 hover:bg-error/25 border border-white/[0.08] hover:border-error/40 text-outline hover:text-error flex items-center justify-center cursor-pointer transition-colors"
      >
        <span className="material-symbols-outlined text-[16px]">close</span>
      </button>
    </div>
  );
};
