/**
 * IS King Panel — Native Windows Desktop Application (.EXE) Main Process
 * Run with Electron (`npx electron electron-main.cjs`) or package via `electron-builder --win --x64`
 */
const { app, BrowserWindow, shell, ipcMain } = require('electron');
const path = require('path');
const { spawn } = require('child_process');

let mainWindow = null;
let backendProcess = null;
const PORT = process.env.PORT || 3000;

function startEmbeddedBackend() {
  const serverPath = path.join(__dirname, 'server.ts');
  backendProcess = spawn(process.execPath, ['--import', 'tsx', serverPath], {
    cwd: __dirname,
    env: {
      ...process.env,
      NODE_ENV: 'production',
      IS_WINDOWS_DESKTOP_APP: 'true',
      APPDATA_DB_DIR: app ? path.join(app.getPath('userData'), 'database') : path.join(__dirname, 'database'),
    },
    stdio: 'inherit',
  });
}

function createWindowsAppWindow() {
  mainWindow = new BrowserWindow({
    width: 1520,
    height: 940,
    minWidth: 1180,
    minHeight: 720,
    frame: false,
    titleBarStyle: 'hidden',
    backgroundColor: '#0a0d14',
    title: 'IS King Panel — Windows 11 Localhost Minecraft Server Workstation',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  mainWindow.loadURL(`http://127.0.0.1:${PORT}`);

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://discord.gg') || url.startsWith('https://discord.com') || url.startsWith('https://modrinth.com')) {
      shell.openExternal(url);
      return { action: 'deny' };
    }
    return { action: 'allow' };
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.whenReady().then(() => {
  startEmbeddedBackend();
  setTimeout(createWindowsAppWindow, 1200);
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
