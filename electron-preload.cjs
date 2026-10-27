/**
 * KingPanel — Electron preload bridge.
 *
 * Runs with contextIsolation enabled, so the renderer has no Node/Electron
 * access. Every window operation is forwarded to the main process over IPC;
 * `mainWindow` does not exist in this process and must never be referenced
 * (the previous version threw a ReferenceError on every call).
 *
 * Window state (minimized/maximized/visible) is pushed from the main process
 * over the 'window:state' channel and mirrored here so the renderer can read
 * it synchronously via `electronicState` / `electronic.isMaximized()`.
 */
const { contextBridge, ipcRenderer } = require('electron');

// Last-known window state, updated by pushes from the main process.
const windowState = {
  minimized: false,
  maximized: false,
  visible: true,
};

function subscribe(channel, callback) {
  if (typeof callback !== 'function') {
    return () => {};
  }
  const listener = (_event, payload) => {
    try {
      callback(payload);
    } catch (err) {
      console.error('[preload] window state listener failed:', err);
    }
  };
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

ipcRenderer.on('window:state', (_event, next) => {
  if (next && typeof next === 'object') {
    windowState.minimized = Boolean(next.minimized);
    windowState.maximized = Boolean(next.maximized);
    windowState.visible = Boolean(next.visible);
  }
});

contextBridge.exposeInMainWorld('electronic', {
  // --- window controls (fire and forget) ---
  minimize: () => ipcRenderer.invoke('window:minimize'),
  maximize: () => ipcRenderer.invoke('window:maximize'),
  // Close is intercepted by the main process: the window hides to the tray
  // unless the renderer explicitly asked for a real quit (app:quit).
  close: () => ipcRenderer.invoke('window:close'),
  hideToTray: () => ipcRenderer.invoke('window:hide-to-tray'),
  quit: () => ipcRenderer.invoke('app:quit'),
  isOpen: () => ipcRenderer.invoke('window:is-visible'),

  // --- synchronous state reads (last-known snapshot) ---
  isMinimized: () => windowState.minimized,
  isMaximized: () => windowState.maximized,
  isVisible: () => windowState.visible,

  // --- state subscriptions (return an unsubscribe function) ---
  onStateChange: (callback) => subscribe('window:state', callback),
  // Legacy event hooks kept for existing callers.
  onMinimize: (callback) => subscribe('window:minimized', callback),
  onMaximize: (callback) => subscribe('window:maximized', callback),
  onClose: (callback) => subscribe('window:closing', callback),
});

contextBridge.exposeInMainWorld('electronicState', {
  isMinimized: () => windowState.minimized,
  isMaximized: () => windowState.maximized,
  isVisible: () => windowState.visible,
});
