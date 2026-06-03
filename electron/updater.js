const { app } = require('electron');
const path = require('path');
const fs = require('fs');

let autoUpdater = null;
try {
  ({ autoUpdater } = require('electron-updater'));
} catch {
  autoUpdater = null;
}

function readPackageVersion() {
  try {
    const pkgPath = path.join(__dirname, '..', 'package.json');
    return JSON.parse(fs.readFileSync(pkgPath, 'utf8')).version || '0.0.0';
  } catch {
    return app.getVersion();
  }
}

class AppUpdater {
  constructor(onChange) {
    this.onChange = onChange || (() => {});
    this.state = {
      enabled: false,
      status: 'idle',
      currentVersion: readPackageVersion(),
      latestVersion: null,
      releaseNotes: null,
      percent: 0,
      transferred: 0,
      total: 0,
      error: null,
      updateUrl: null,
      lastChecked: null,
    };

    if (!autoUpdater) {
      this.patch({ status: 'disabled', error: 'electron-updater not available' });
      return;
    }

    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.allowDowngrade = false;

    autoUpdater.on('checking-for-update', () => {
      this.patch({ status: 'checking', error: null });
    });

    autoUpdater.on('update-available', (info) => {
      this.patch({
        status: 'available',
        latestVersion: info.version,
        releaseNotes: normalizeNotes(info.releaseNotes),
        error: null,
      });
    });

    autoUpdater.on('update-not-available', (info) => {
      this.patch({
        status: 'not-available',
        latestVersion: info?.version || this.state.currentVersion,
        error: null,
      });
    });

    autoUpdater.on('download-progress', (p) => {
      this.patch({
        status: 'downloading',
        percent: Math.round(p.percent || 0),
        transferred: p.transferred,
        total: p.total,
      });
    });

    autoUpdater.on('update-downloaded', (info) => {
      this.patch({
        status: 'downloaded',
        latestVersion: info.version,
        releaseNotes: normalizeNotes(info.releaseNotes),
        percent: 100,
      });
    });

    autoUpdater.on('error', (err) => {
      this.patch({
        status: 'error',
        error: err?.message || String(err),
      });
    });

    this.refreshConfig();
  }

  refreshConfig() {
    const url = (process.env.APP_UPDATE_URL || '').trim();
    const enabled = this.isRuntimeEnabled(url);
    this.patch({
      enabled,
      updateUrl: url || null,
      currentVersion: readPackageVersion(),
      status: enabled ? this.state.status : 'disabled',
    });
    return enabled;
  }

  isRuntimeEnabled(url = process.env.APP_UPDATE_URL) {
    if (process.env.ELECTRON_DEV === '1') return false;
    if (!autoUpdater) return false;
    return Boolean(String(url || '').trim());
  }

  configureFeed() {
    const url = String(process.env.APP_UPDATE_URL || '').trim().replace(/\/?$/, '/');
    if (!url) throw new Error('APP_UPDATE_URL is not set in .env');
    autoUpdater.setFeedURL({ provider: 'generic', url });
    return url;
  }

  getState() {
    return { ...this.state };
  }

  patch(partial) {
    this.state = { ...this.state, ...partial, lastChecked: new Date().toISOString() };
    this.onChange(this.getState());
  }

  async check(silent = true) {
    this.refreshConfig();
    if (!this.state.enabled) {
      return this.getState();
    }
    try {
      this.configureFeed();
      await autoUpdater.checkForUpdates();
    } catch (err) {
      this.patch({
        status: 'error',
        error: err.message,
      });
      if (!silent) throw err;
    }
    return this.getState();
  }

  quitAndInstall() {
    if (!autoUpdater) return;
    autoUpdater.quitAndInstall(false, true);
  }
}

function normalizeNotes(notes) {
  if (!notes) return null;
  if (Array.isArray(notes)) {
    return notes.map((n) => (typeof n === 'string' ? n : n.note || '')).filter(Boolean).join('\n');
  }
  return String(notes);
}

module.exports = AppUpdater;
