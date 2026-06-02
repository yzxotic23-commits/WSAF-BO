const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const { seedUserData } = require('./app-data');
const SessionService = require('./session-service');
const FeedingProcess = require('./feeding-process');
const { getEnvPath } = require('../src/app-paths');

let mainWindow = null;
let sessionService = null;
let feedingProcess = null;
let projectRoot = null;
let userDataPath = null;

function getProjectRoot() {
  if (projectRoot) return projectRoot;
  projectRoot = app.isPackaged
    ? path.join(process.resourcesPath, 'app')
    : path.join(__dirname, '..');
  return projectRoot;
}

function getUserDataPath() {
  if (userDataPath) return userDataPath;
  userDataPath = seedUserData(app.getPath('userData'), getProjectRoot());
  process.env.WA_APP_DATA = userDataPath;
  return userDataPath;
}

function broadcast(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

function pushLog(entry) {
  broadcast('log', {
    time: new Date().toISOString(),
    ...entry,
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 760,
    minWidth: 900,
    minHeight: 600,
    title: 'WhatsApp Auto Feeding',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

function readEnvPairs() {
  const envPath = getEnvPath();
  if (!fs.existsSync(envPath)) return {};
  const text = fs.readFileSync(envPath, 'utf8');
  const out = {};
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || !trimmed.includes('=')) continue;
    const idx = trimmed.indexOf('=');
    out[trimmed.slice(0, idx).trim()] = trimmed.slice(idx + 1).trim();
  }
  return out;
}

app.whenReady().then(() => {
  getUserDataPath();
  getProjectRoot();

  sessionService = new SessionService((event) => pushLog(event));
  feedingProcess = new FeedingProcess(getProjectRoot(), getUserDataPath(), (line) => {
    pushLog({ type: 'feeding', message: line });
  });

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', async () => {
  feedingProcess?.stop();
  for (const session of sessionService?.sessions?.values() || []) {
    try {
      await session.shutdown();
    } catch {
      // ignore
    }
  }
});

ipcMain.handle('app:get-info', () => ({
  platform: process.platform,
  version: app.getVersion(),
  projectRoot: getProjectRoot(),
  userDataPath: getUserDataPath(),
  envPath: getEnvPath(),
}));

ipcMain.handle('accounts:list', () => {
  const env = readEnvPairs();
  const pairCount = Math.max(1, parseInt(env.PAIR_COUNT || '1', 10));
  const accountStart = Math.max(1, parseInt(env.ACCOUNT_START || '1', 10));
  return sessionService.listAccounts(pairCount, accountStart);
});

ipcMain.handle('accounts:connect', async (_e, payload) => {
  return sessionService.connectAccount(payload.name, payload);
});

ipcMain.handle('accounts:disconnect', async (_e, { name }) => {
  await sessionService.disconnectAccount(name);
  return { ok: true };
});

ipcMain.handle('accounts:logout', async (_e, { name }) => {
  await sessionService.logoutAccount(name);
  return { ok: true };
});

ipcMain.handle('feeding:start', (_e, options) => feedingProcess.start(options));
ipcMain.handle('feeding:stop', () => feedingProcess.stop());
ipcMain.handle('feeding:status', () => ({ running: feedingProcess.isRunning() }));

ipcMain.handle('env:read', () => {
  const envPath = getEnvPath();
  return fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : '';
});

ipcMain.handle('env:write', (_e, content) => {
  fs.writeFileSync(getEnvPath(), content, 'utf8');
  return { ok: true };
});

ipcMain.handle('proxies:read', () => {
  const proxiesPath = path.join(getUserDataPath(), 'proxies.txt');
  return fs.existsSync(proxiesPath) ? fs.readFileSync(proxiesPath, 'utf8') : '';
});

ipcMain.handle('proxies:write', (_e, content) => {
  const proxiesPath = path.join(getUserDataPath(), 'proxies.txt');
  fs.writeFileSync(proxiesPath, content, 'utf8');
  return { ok: true };
});

ipcMain.handle('shell:open-data-folder', () => {
  shell.openPath(getUserDataPath());
});

ipcMain.handle('shell:codex-login-hint', () => {
  const hint =
    process.platform === 'darwin'
      ? 'Di Terminal macOS:\n  cd "' + getProjectRoot() + '"\n  npm run codex-login\n\nToken: ~/.codex/auth.json'
      : 'Di terminal:\n  npm run codex-login\n\nToken: %USERPROFILE%\\.codex\\auth.json';
  return { hint };
});
