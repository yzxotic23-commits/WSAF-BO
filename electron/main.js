require('../src/silence-deprecation-warnings');
const { app, BrowserWindow, shell, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { createDesktopApi } = require('../server/desktop-api');
const AppUpdater = require('./updater');
const { getDesktopAppRoot, ensureUserDataPreserved } = require('./app-data');

const isDev = process.env.ELECTRON_DEV === '1';
let mainWindow = null;
let api = null;
let apiPort = 47821;
let updater = null;
let updateCheckTimer = null;
let lastBackgroundUpdateCheckAt = 0;
const MIN_FOCUS_UPDATE_CHECK_MS = 30 * 60 * 1000;

if (isDev) {
  process.env.APP_ROOT = path.join(__dirname, '..');
} else {
  const preserved = ensureUserDataPreserved(app);
  const dataRoot = preserved.targetRoot;
  if (preserved.migration?.migrated) {
    console.log(
      `[DATA] Migrated user data to ${dataRoot}: ${(preserved.migration.copied || []).join(', ')}`
    );
  }
  if (preserved.sync?.synced) {
    console.log(
      `[DATA] Synced missing files into ${dataRoot}: ${(preserved.sync.copied || []).join(', ')}`
    );
  }
  console.log(`[DATA] Sessions & settings stored at: ${dataRoot} (kept across app updates)`);
  process.env.APP_ROOT = dataRoot;
  process.chdir(dataRoot);
}

require('dotenv').config({ path: path.join(process.env.APP_ROOT, '.env') });

function emitUpdate(state) {
  if (api?.io) api.io.emit('update', state);
}

function scheduleUpdateChecks() {
  if (updateCheckTimer) clearInterval(updateCheckTimer);
  if (!updater?.state?.enabled) return;

  const hours = Math.max(1, parseFloat(process.env.APP_UPDATE_CHECK_HOURS || '4', 10));
  updateCheckTimer = setInterval(() => {
    updater.check(true).catch(() => {});
  }, hours * 60 * 60 * 1000);
}

async function startApi() {
  if (isDev) {
    // `npm run dev:api` already listens on this port — do not bind twice (EADDRINUSE).
    apiPort = parseInt(process.env.DESKTOP_API_PORT || '47821', 10);
    console.log(`[API] Dev mode — using http://127.0.0.1:${apiPort} (started by dev:api)`);
    return apiPort;
  }
  try {
    updater = new AppUpdater(emitUpdate);
    api = createDesktopApi({ updater });
    return await api.start();
  } catch (err) {
    console.error('[API] Failed to start desktop API:', err);
    return apiPort;
  }
}

function resolveIndexHtml() {
  const candidates = [
    path.join(process.resourcesPath, 'app.asar.unpacked', 'client', 'dist', 'index.html'),
    path.join(app.getAppPath(), 'client', 'dist', 'index.html'),
    path.join(__dirname, '..', 'client', 'dist', 'index.html'),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return candidates[1];
}

function resolveAppIcon() {
  if (process.platform === 'win32') {
    const ico = path.join(__dirname, 'icons', 'icon.ico');
    if (fs.existsSync(ico)) return ico;
  }
  if (process.platform === 'darwin') {
    const icns = path.join(__dirname, 'icons', 'icon.icns');
    if (fs.existsSync(icns)) return icns;
  }
  const png = path.join(__dirname, 'icons', 'icon.png');
  if (fs.existsSync(png)) return png;
  return undefined;
}

const ZOOM_MIN = -2;
const ZOOM_MAX = 2;

function resetWindowZoom(contents) {
  if (!contents || contents.isDestroyed()) return;
  contents.setZoomLevel(0);
  contents.setZoomFactor(1);
  try {
    contents.setVisualZoomLevelLimits(1, 1);
  } catch {
    /* older Electron */
  }
}

function setupWindowZoom(win) {
  const contents = win.webContents;

  resetWindowZoom(contents);

  contents.on('did-finish-load', () => {
    resetWindowZoom(contents);
  });

  contents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    if (!(input.control || input.meta)) return;

    const key = input.key;
    if (key === '0' || key === 'num0') {
      resetWindowZoom(contents);
      event.preventDefault();
      return;
    }
    if (key === '=' || key === '+' || key === 'numadd') {
      const next = Math.min(contents.getZoomLevel() + 1, ZOOM_MAX);
      contents.setZoomLevel(next);
      event.preventDefault();
      return;
    }
    if (key === '-' || key === 'numsub') {
      const next = Math.max(contents.getZoomLevel() - 1, ZOOM_MIN);
      contents.setZoomLevel(next);
      event.preventDefault();
    }
  });
}

function createWindow(port) {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1024,
    minHeight: 700,
    title: 'WhatsApp Auto Feeding',
    icon: resolveAppIcon(),
    backgroundColor: '#f0f2f5',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      additionalArguments: [`--api-port=${port}`],
      contextIsolation: true,
      nodeIntegration: false,
    },
    autoHideMenuBar: true,
    show: false,
  });

  mainWindow.once('ready-to-show', () => mainWindow.show());

  setupWindowZoom(mainWindow);

  mainWindow.webContents.on('did-fail-load', (_event, code, desc, url) => {
    console.error('[UI] did-fail-load', code, desc, url);
  });
  mainWindow.webContents.on('console-message', (_event, _level, message, line, sourceId) => {
    console.error(`[UI] ${message} (${sourceId}:${line})`);
  });

  if (isDev) {
    mainWindow.loadURL('http://127.0.0.1:5173');
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  } else {
    const indexHtml = resolveIndexHtml();
    console.error('[UI] load', indexHtml);
    mainWindow.loadFile(indexHtml);
  }

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
}

function openTerminalWindow(command) {
  const root = process.env.APP_ROOT || process.cwd();
  const safeCmd = command.replace(/"/g, '""');
  if (process.platform === 'win32') {
    spawn(
      'cmd.exe',
      ['/c', 'start', 'cmd.exe', '/k', `cd /d "${root}" && ${safeCmd}`],
      { detached: true, stdio: 'ignore', windowsHide: false }
    ).unref();
    return { ok: true };
  }
  if (process.platform === 'darwin') {
    const script = `cd '${root.replace(/'/g, "'\\''")}' && ${command}`;
    spawn('osascript', [
      '-e',
      `tell application "Terminal" to do script "${script.replace(/"/g, '\\"')}"`,
    ], { detached: true, stdio: 'ignore' }).unref();
    return { ok: true };
  }
  spawn('x-terminal-emulator', ['-e', `bash -lc "cd '${root}' && ${command}"`], {
    detached: true,
    stdio: 'ignore',
  }).unref();
  return { ok: true };
}

ipcMain.handle('get-app-root', () => process.env.APP_ROOT || process.cwd());

ipcMain.handle('open-terminal', (_e, command) => {
  if (!command || typeof command !== 'string') {
    return { ok: false, error: 'Invalid command' };
  }
  return openTerminalWindow(command);
});

ipcMain.handle('open-data-folder', async () => {
  const root = process.env.APP_ROOT || process.cwd();
  await shell.openPath(root);
  return { ok: true, path: root };
});

ipcMain.handle('reload-env', () => {
  require('dotenv').config({ path: path.join(process.env.APP_ROOT, '.env'), override: true });
  if (updater) {
    updater.refreshConfig();
    emitUpdate(updater.getState());
    scheduleUpdateChecks();
  }
  return updater?.getState() || { enabled: false };
});

app.whenReady().then(async () => {
  apiPort = await startApi();
  createWindow(apiPort);

  if (!isDev && updater?.state?.enabled) {
    setTimeout(() => {
      lastBackgroundUpdateCheckAt = Date.now();
      updater.check(true).catch(() => {});
      scheduleUpdateChecks();
    }, 4000);

    app.on('browser-window-focus', () => {
      const now = Date.now();
      if (now - lastBackgroundUpdateCheckAt < MIN_FOCUS_UPDATE_CHECK_MS) return;
      lastBackgroundUpdateCheckAt = now;
      updater.check(true).catch(() => {});
    });
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow(apiPort);
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', (event) => {
  if (updateCheckTimer) clearInterval(updateCheckTimer);

  // In-app update: quit immediately so NSIS can replace the exe and relaunch.
  if (app.isQuittingForUpdate) {
    if (api?.bridge) {
      api.bridge.stopFeeding();
    }
    return;
  }

  if (!api?.bridge) return;

  event.preventDefault();
  api.bridge.stopFeeding();
  Promise.race([
    api.bridge.disconnectAll(),
    new Promise((resolve) => setTimeout(resolve, 8000)),
  ]).finally(() => {
    app.exit(0);
  });
});
