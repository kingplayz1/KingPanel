declare global {
  interface Window {
    electronic: {
      minimize: () => Promise<void>;
      maximize: () => Promise<boolean>;
      close: () => Promise<void>;
      hideToTray: () => Promise<void>;
      quit: () => Promise<void>;
      isOpen: () => Promise<boolean>;
      isMinimized: () => boolean;
      isMaximized: () => boolean;
      isVisible: () => boolean;
      onStateChange: (
        callback: (state: {
          minimized: boolean;
          maximized: boolean;
          visible: boolean;
        }) => void
      ) => () => void;
      onMinimize: (callback: (state?: unknown) => void) => () => void;
      onMaximize: (callback: (state?: unknown) => void) => () => void;
      onClose: (callback: (state?: unknown) => void) => () => void;
    };
    electronicState: {
      isMinimized: () => boolean;
      isMaximized: () => boolean;
      isVisible: () => boolean;
    };
  }
}

export {};
