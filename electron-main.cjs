/**
 * KingPanel — Native Windows Desktop Application (.EXE) Main Process
 * Run with Electron (`npx electron electron-main.cjs`) or package via `electron-builder --win --x64`
 */
const { app, BrowserWindow, shell, ipcMain, Tray, Menu, nativeImage } = require('electron');
const path = require('path');
const { spawn } = require('child_process');
const { resolveBackendRuntime } = require('./runtime-resolver.cjs');
const net = require('net');
const http = require('http');
const fs = require('fs');

/**
 * The application-data directory is a permanent identity, not a detail: it holds
 * the account database, so moving it is indistinguishable from data loss.
 *
 * Electron derives `userData` from the package's `name` field, which is still
 * "react-example" — an artefact of the project template. Pinning the path here,
 * by value, means renaming that field (or the product) can never move the data.
 * An explicit `--user-data-dir` is still honoured (see state-dirs.cjs).
 */
const { resolveStateDirs } = require('./state-dirs.cjs');
const { evaluateUpdaterPolicy } = require('./updater-policy.cjs');
/**
 * The publisher this build expects to be signed by. Compiled in from
 * package.json, so a build can never be told at runtime which identity to trust.
 */
const SIGNING_POLICY = require('./package.json').iskSigning || {};

/** Absolute state directory, and the legacy directories worth migrating from. */
function currentStateDirs() {
  let switchValue = '';
  try {
    switchValue = app.commandLine.getSwitchValue('user-data-dir');
  } catch {
    // No command line parsed yet; argv still carries it.
  }
  return resolveStateDirs({ appData: app.getPath('appData'), argv: process.argv, switchValue });
}

const STATE_DIRS = currentStateDirs();
if (!STATE_DIRS.pinned) {
  console.log(`[State] Using the profile directory from --user-data-dir: ${STATE_DIRS.stateDir}`);
}
/** Legacy database directories, i.e. `<legacy>/database` for each old name. */
const LEGACY_DB_DIRS = STATE_DIRS.legacyStateDirs
  .filter((dir) => dir !== STATE_DIRS.stateDir)
  .map((dir) => path.join(dir, 'database'));
// Must run before anything reads userData (Electron caches window state and
// session data there too, so doing it late would split the profile).
try {
  app.setPath('userData', STATE_DIRS.stateDir);
} catch (err) {
  console.error(`Could not pin the application data directory: ${err && err.message ? err.message : err}`);
}

let mainWindow = null;
let backendProcess = null;
let backendStarted = false;
let tray = null;
// Set when the user explicitly asked to quit. Any other window close request
// (title-bar X, Alt+F4, taskbar close) is intercepted and hides to the tray.
let isQuitting = false;
let windowIpcRegistered = false;
// server.cjs listens on PORT (default 3000). Parse PORT defensively:
// an ambient value like "0" must fall back to 3000, not be used as a real port.
const PORT = Number.parseInt(process.env.PORT, 10) || 3000;
// The port actually used at runtime — differs from the preferred port when
// another application already owns it (Windows allows silent port sharing).
let activePort = PORT;

// Response body of a page served on the given port (empty string on failure).
function httpGetBody(port, timeoutMs = 3000) {
  return new Promise((resolve) => {
    let body = '';
    const req = http.get({ host: '127.0.0.1', port, path: '/', timeout: timeoutMs }, (res) => {
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        if (body.length < 65536) body += chunk;
      });
      res.on('end', () => resolve(body));
    });
    req.on('timeout', () => {
      req.destroy();
      resolve('');
    });
    req.on('error', () => resolve(''));
  });
}

// Marker that only our own UI contains (page title), used to verify that the
// HTTP response on a port belongs to KingPanel and not another app. It is served
// from index.html's <title>, so it must stay in sync with that title (and with
// BRAND.name in src/branding.ts) — a rename here alone makes the panel mistake
// its own backend for a foreign app on the port.
const PANEL_MARKER = 'KingPanel';

function isTcpOpen(port, timeoutMs = 400) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;
    const done = (open) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(open);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
    socket.connect(port, '127.0.0.1');
  });
}

function findFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
  });
}

// Pick the port the backend should use: the preferred port when it is free,
// otherwise a fresh free port — a foreign app squatting on the preferred port
// must never cause this app to load someone else's page.
async function resolveBackendPort() {
  if (await isTcpOpen(PORT)) {
    try {
      const alt = await findFreePort();
      console.warn(
        `Port ${PORT} is already in use by another application — KingPanel will use port ${alt} instead.`
      );
      return alt;
    } catch {
      return PORT;
    }
  }
  return PORT;
}

function broadcastWindowState() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const state = {
    minimized: mainWindow.isMinimized(),
    maximized: mainWindow.isMaximized(),
    visible: mainWindow.isVisible(),
  };
  try {
    mainWindow.webContents.send('window:state', state);
    if (state.minimized) mainWindow.webContents.send('window:minimized', state);
    if (state.maximized) mainWindow.webContents.send('window:maximized', state);
  } catch (err) {
    console.error('Failed to broadcast window state:', err);
  }
}

function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
  broadcastWindowState();
}

function registerWindowIpc() {
  if (windowIpcRegistered) return;
  windowIpcRegistered = true;

  ipcMain.handle('window:minimize', () => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.minimize();
  });
  ipcMain.handle('window:maximize', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return false;
    if (mainWindow.isMaximized()) mainWindow.unmaximize();
    else mainWindow.maximize();
    return mainWindow.isMaximized();
  });
  ipcMain.handle('window:is-maximized', () =>
    Boolean(mainWindow && !mainWindow.isDestroyed() && mainWindow.isMaximized())
  );
  ipcMain.handle('window:is-visible', () =>
    Boolean(mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible())
  );
  // Closes the window; the 'close' handler below decides hide-to-tray vs quit.
  ipcMain.handle('window:close', () => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.close();
  });
  ipcMain.handle('window:hide-to-tray', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.hide();
      broadcastWindowState();
    }
  });
  ipcMain.handle('app:quit', () => {
    isQuitting = true;
    app.quit();
  });
}

function createTray() {
  if (tray) return tray;
  try {
    const iconPath = path.join(__dirname, 'src', 'assets', 'tray-icon.png');
    if (!fs.existsSync(iconPath)) {
      console.warn(`Tray icon not found at ${iconPath}; tray disabled.`);
      return null;
    }
    const icon = nativeImage.createFromPath(iconPath);
    if (icon.isEmpty()) {
      console.warn('Tray icon failed to load; tray disabled.');
      return null;
    }
    tray = new Tray(icon);
    tray.setToolTip('KingPanel — Minecraft server control panel (running in background)');
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: 'Open KingPanel', click: () => showMainWindow() },
        { type: 'separator' },
        {
          label: 'Quit KingPanel',
          click: () => {
            isQuitting = true;
            app.quit();
          },
        },
      ])
    );
    tray.on('click', () => showMainWindow());
    return tray;
  } catch (err) {
    console.error('Failed to create tray:', err);
    return null;
  }
}

function waitForBackend(port, timeoutMs = 15000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const attempt = () => {
      // Per-attempt guard: exactly one terminal path per attempt (retry OR
      // marker check), so retries can never multiply.
      let phase = 'open';
      const rejectOnce = (message) => reject(new Error(message));
      const retryLater = () => {
        if (phase !== 'open') return;
        phase = 'done';
        if (Date.now() - start > timeoutMs) {
          rejectOnce(`Backend on port ${port} not ready within ${timeoutMs / 1000}s`);
        } else {
          setTimeout(attempt, 300);
        }
      };

      const socket = new net.Socket();
      socket.setTimeout(300);
      socket.once('timeout', retryLater);
      socket.once('error', retryLater);
      socket.once('connect', () => {
        if (phase !== 'open') return;
        phase = 'http';
        socket.destroy();
        // A TCP connect alone does not prove this is our backend: on Windows
        // another app can share the port. Verify the served page marker.
        httpGetBody(port, 2500).then((body) => {
          if (body.includes(PANEL_MARKER)) {
            resolve(true);
            return;
          }
          phase = 'done';
          if (Date.now() - start > timeoutMs) {
            rejectOnce(
              `Port ${port} is answering, but not with the KingPanel UI (another application may own it)`
            );
          } else {
            setTimeout(attempt, 300);
          }
        });
      });
      socket.connect(port, '127.0.0.1');
    };
    attempt();
  });
}

/**
 * The backend encrypts provider OAuth tokens with a 32-byte key.
 *
 * That key is wrapped here with Electron's safeStorage (DPAPI on Windows, bound
 * to the logged-in OS user) and only the unwrapped value is handed to the
 * backend. The file beside the database is therefore useless on another machine
 * or under another OS account, which is the property a plaintext key file or
 * plaintext tokens cannot offer.
 */
function resolveOAuthTokenKey() {
  const file = path.join(STATE_DIRS.stateDir, 'oauth-token-key.dpapi');
  try {
    const { safeStorage } = require('electron');
    if (!safeStorage.isEncryptionAvailable()) {
      console.warn(
        '[Tokens] OS encryption is not available; the backend will fall back to its local key file.'
      );
      return '';
    }
    if (fs.existsSync(file)) {
      const key = safeStorage.decryptString(fs.readFileSync(file));
      if (Buffer.from(key, 'base64').length === 32) return key;
      console.error(`[Tokens] ${file} does not contain a usable key; provider links must be renewed.`);
      return '';
    }
    const key = require('crypto').randomBytes(32).toString('base64');
    fs.mkdirSync(STATE_DIRS.stateDir, { recursive: true });
    fs.writeFileSync(file, safeStorage.encryptString(key), { mode: 0o600 });
    console.log('[Tokens] Created a DPAPI-wrapped provider-token key.');
    return key;
  } catch (err) {
    console.warn(`[Tokens] Could not prepare the token key: ${err && err.message ? err.message : err}`);
    return '';
  }
}

function startEmbeddedBackend(port) {
  if (backendStarted) {
    console.log('Backend already started, skipping');
    return;
  }

  // Check if we're in a packaged environment
  const isPackaged = app.isPackaged || false; // Default to false if app.isPackaged is undefined

  // Resolve server.cjs path:
  // - In packaged mode: server.cjs lives at resources/app.asar.unpacked/server.cjs
  // - In development mode: server.cjs is next to electron-main.cjs
  // We need to check both locations since ASAR may or may not unpack it.
  let serverPath;
  if (isPackaged) {
    // Check unpacked ASAR location first, then packed ASAR location
    const unpackedPath = path.join(process.resourcesPath, 'app.asar.unpacked', 'server.cjs');
    const packedPath = path.join(process.resourcesPath, 'server.cjs');
    serverPath = require('fs').existsSync(unpackedPath) ? unpackedPath : packedPath;
  } else {
    serverPath = path.join(__dirname, 'server.cjs');
  }

  // Pick a runtime that can actually host the backend: Node >= 22.5 with
  // node:sqlite. Each candidate is proved with a probe rather than assumed, so a
  // machine without Node fails with an explanation instead of starting a backend
  // whose every account call would answer 503.
  const runtime = resolveBackendRuntime({
    packaged: isPackaged,
    resourcesPath: process.resourcesPath,
    appDir: __dirname,
    execPath: process.execPath,
  });
  if (!runtime.ok) {
    const detail = runtime.attempts
      .map((a) => `  - ${a.source}: ${a.reason || 'unusable'}${a.version ? ` (Node ${a.version})` : ''}`)
      .join('\n');
    console.error(`No usable Node runtime found:\n${detail}`);
    const explanation = app.isPackaged
      ? 'The Node runtime that ships inside this installation is missing or unusable, so the ' +
        'installation is incomplete.\n\nReinstall IS King Panel with the installer you downloaded. ' +
        'Nothing on your PC needs to be changed, and your data has not been touched.'
      : 'No suitable Node.js runtime was found for the development checkout.\n\n' +
        'Install Node.js 22.5 or newer, or set ISK_NODE_PATH to one, then start KingPanel again.';
    try {
      require('electron').dialog.showErrorBox(
        'KingPanel cannot start its backend',
        `${explanation}\n\nTried:\n${detail}`
      );
    } catch {
      // No display available (a headless run): the console output above stands.
    }
    return false;
  }
  const nodePath = runtime.command;
  console.log(`Starting backend from: ${serverPath}`);
  console.log(`Runtime: ${runtime.source} (Node ${runtime.version}) at ${nodePath}`);
  console.log(`isPackaged: ${app.isPackaged}`);
  console.log(`resourcesPath: ${process.resourcesPath}`);
  console.log(`__dirname: ${__dirname}`);
  console.log(`server.cjs exists (resourcesPath): ${require('fs').existsSync(process.resourcesPath != null ? process.resourcesPath + '/server.cjs' : 'N/A')}`);
  console.log(`server.cjs exists (__dirname): ${require('fs').existsSync(__dirname + '/server.cjs')}`);

  // Resolve the correct working directory for the backend process.
  // We need to use the project's node_modules directory so that native
  // modules (e.g. better-sqlite3) can be found via their prebuilt binaries.
  // __dirname points to the ASAR-resources directory; the actual project
  // source lives one level up at the dist_electron\win-unpacked level.
  const backendCwd = isPackaged
    ? path.join(process.resourcesPath, '..')
    : __dirname;

  backendProcess = spawn(nodePath, [...runtime.args, serverPath], {
    cwd: backendCwd,
    env: {
      ...process.env,
      ...runtime.env,
      PORT: String(port),
      NODE_ENV: 'production',
      IS_WINDOWS_DESKTOP_APP: 'true',
      // Packaged builds keep state in the pinned per-user directory; a dev run
      // keeps it next to the source so the checkout stays self-contained.
      // LEGACY_APPDATA_DB_DIR lets the backend bring a pre-pin installation
      // across before it opens the database (see server/state-dir.ts).
      APPDATA_DB_DIR: app.isPackaged
        ? path.join(STATE_DIRS.stateDir, 'database')
        : path.join(__dirname, 'database'),
      ...(app.isPackaged && STATE_DIRS.pinned && LEGACY_DB_DIRS.length
        ? { LEGACY_APPDATA_DB_DIR: LEGACY_DB_DIRS[0] }
        : {}),
      // Passed through memory only; the wrapped copy on disk is DPAPI-encrypted.
      OAUTH_TOKEN_KEY: resolveOAuthTokenKey(),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  backendProcess.stdout?.on('data', (data) => {
    const output = data.toString().trim();
    if (output) console.log(`[Backend] ${output}`);
  });

  backendProcess.stderr?.on('data', (data) => {
    const output = data.toString().trim();
    if (output) console.error(`[Backend Error] ${output}`);
  });

  backendProcess.on('error', (err) => {
    console.error('Failed to start backend process:', err);
  });

  backendProcess.on('exit', (code, signal) => {
    console.log(`Backend process exited with code ${code}${signal ? ` (signal: ${signal})` : ''}`);
    backendStarted = false;
  });

  backendStarted = true;
  return true;
}

function createWindowsAppWindow() {
  registerWindowIpc();
  mainWindow = new BrowserWindow({
    width: 1520,
    height: 940,
    minWidth: 1180,
    minHeight: 720,
    frame: false,
    titleBarStyle: 'hidden',
    backgroundColor: '#0a0d14',
    title: 'KingPanel — Minecraft Server Control Panel',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      // Preload script to expose Electron APIs to renderer
      preload: path.join(__dirname, 'electron-preload.cjs'),
    },
  });

  mainWindow.loadURL(`http://127.0.0.1:${activePort}`);

  // Open DevTools in development
  if (!app.isPackaged) {
    mainWindow.webContents.openDevTools();
  }

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://discord.gg') || url.startsWith('https://discord.com') || url.startsWith('https://modrinth.com')) {
      shell.openExternal(url);
      return { action: 'deny' };
    }
    return { action: 'allow' };
  });

  // Keep the renderer's window-state snapshot in sync with the OS window.
  ['minimize', 'unminimize', 'maximize', 'unmaximize', 'restore', 'show', 'hide'].forEach(
    (evt) => mainWindow.on(evt, () => broadcastWindowState())
  );
  mainWindow.webContents.on('did-finish-load', () => broadcastWindowState());

  // Close-to-tray: unless the user explicitly quit, closing the window hides
  // it to the system tray instead of tearing the app (and its backend) down.
  mainWindow.on('close', (e) => {
    if (isQuitting) return;
    e.preventDefault();
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.hide();
      broadcastWindowState();
      try {
        mainWindow.webContents.send('window:closing', { action: 'hide-to-tray' });
      } catch {
        // window may be tearing down concurrently
      }
      console.log('Window close intercepted — hidden to tray (use tray menu to quit).');
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

/**
 * Reads the flat `key: value` mapping electron-builder writes into
 * resources/app-update.yml. Parsed by hand because electron-updater does the
 * authoritative read itself and js-yaml is only present at build time (it is
 * pruned from the packaged app as a devDependency of electron-builder).
 */
function readAppUpdateConfig(file) {
  const config = {};
  for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const separator = line.indexOf(':');
    if (separator < 1) continue;
    config[line.slice(0, separator).trim()] = line
      .slice(separator + 1)
      .trim()
      .replace(/^['"]|['"]$/g, '');
  }
  return config;
}

/**
 * Starts the update check, but only for an installed build that actually
 * shipped an update feed. A development run has no app-update.yml and no
 * installer to replace, so checking there can only ever produce an error; the
 * two modes are separated explicitly instead of one silently doing nothing.
 */
function scheduleAutoUpdateCheck() {
  if (!app.isPackaged) {
    console.log('[Updater] Development run (app.isPackaged=false) — update checks disabled.');
    return;
  }
  if (process.env.ISK_DISABLE_UPDATER === '1') {
    console.log('[Updater] Disabled via ISK_DISABLE_UPDATER=1.');
    return;
  }

  const appUpdatePath = path.join(process.resourcesPath, 'app-update.yml');
  if (!fs.existsSync(appUpdatePath)) {
    console.warn('[Updater] resources/app-update.yml is missing — this build cannot check for updates.');
    return;
  }

  let config;
  try {
    config = readAppUpdateConfig(appUpdatePath);
  } catch (err) {
    console.warn(`[Updater] Could not read app-update.yml: ${err.message}`);
    return;
  }

  if (!config.provider || (config.provider === 'github' && (!config.owner || !config.repo))) {
    console.warn('[Updater] app-update.yml has no usable feed (provider/owner/repo) — skipping.');
    return;
  }

  // Fail closed before any download. electron-updater skips signature
  // verification entirely when app-update.yml has no publisherName, so an
  // unpinned or mismatched feed must not be consulted at all.
  const trust = evaluateUpdaterPolicy({
    appUpdate: config,
    expectedPublisher: SIGNING_POLICY.expectedPublisher,
  });
  if (!trust.allowed) {
    console.warn(`[Updater] Update checks disabled — ${trust.problems.join('; ')}`);
    return;
  }

  const feed =
    config.provider === 'github'
      ? `github:${config.owner}/${config.repo}`
      : `${config.provider}:${config.url || config.bucket || ''}`;
  console.log(`[Updater] Checking ${feed} for updates to v${app.getVersion()} (publisher: ${trust.expected})…`);

  // Never let an update check compete with window creation or backend startup;
  // it also keeps offline launches fast. Failures (no published release yet,
  // no network, rate limit) are reported and otherwise ignored.
  setTimeout(() => {
    try {
      const { autoUpdater } = require('electron-updater');
      const log = require('electron-log');
      log.transports.file.level = 'info';
      autoUpdater.logger = log;
      autoUpdater.autoDownload = true;

      // Surface every state the updater passes through. Without these, the only
      // observable outcome is "nothing happened", which is indistinguishable
      // between up-to-date, blocked network and a malformed feed.
      autoUpdater.on('update-available', (info) => {
        console.log(`[Updater] Update available: v${info && info.version}`);
      });
      autoUpdater.on('update-not-available', (info) => {
        console.log(`[Updater] Up to date (latest published: v${(info && info.version) || app.getVersion()}).`);
      });
      let nextProgressAt = 25;
      autoUpdater.on('download-progress', (progress) => {
        const percent = Math.floor(Number(progress && progress.percent) || 0);
        if (percent < nextProgressAt) return;
        nextProgressAt = percent + 25;
        console.log(`[Updater] Download ${percent}% (${Math.round((progress.transferred || 0) / 1024 / 1024)} MB)`);
      });
      autoUpdater.on('error', (err) => {
        console.warn(`[Updater] Error: ${err && err.message ? err.message : err}`);
      });

      autoUpdater
        .checkForUpdatesAndNotify()
        .catch((err) => {
          console.warn(`[Updater] Update check failed: ${err && err.message ? err.message : err}`);
        });
    } catch (err) {
      console.warn(`[Updater] electron-updater is unavailable: ${err.message}`);
    }
  }, 5000);
}

async function initializeApp() {
  registerWindowIpc();
  activePort = await resolveBackendPort();
  if (startEmbeddedBackend(activePort) === false) {
    throw new Error('No usable Node runtime was found to host the backend.');
  }
  console.log(`Waiting for backend on port ${activePort} to be ready...`);
  try {
    await waitForBackend(activePort);
    console.log('Backend is ready, creating window...');
    createWindowsAppWindow();
    createTray();

    scheduleAutoUpdateCheck();
  } catch (err) {
    // Backend startup failed — create window with error state so user can retry
    console.error('Backend startup failed, creating error window:', err);
    mainWindow = new BrowserWindow({
      width: 1200,
      height: 800,
      title: 'KingPanel — Backend Startup Error',
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        preload: path.join(__dirname, 'electron-preload.cjs'),
      },
    });
    mainWindow.loadURL(`file://${path.join(__dirname, 'dist', 'index.html')}`);
    mainWindow.webContents.openDevTools();
    mainWindow.once('closed', () => {
      app.quit();
    });
    return;
  }
}

app.whenReady().then(initializeApp);

app.on('before-quit', () => {
  isQuitting = true;
});

app.on('window-all-closed', () => {
  if (backendProcess) {
    try {
      backendProcess.kill();
    } catch {
      // ignore
    }
  }
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
