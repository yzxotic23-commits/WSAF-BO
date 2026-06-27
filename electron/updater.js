const { app } = require('electron');
const path = require('path');
const fs = require('fs');
const { resolveUpdateConfig } = require('./update-config');
const { MacUpdater } = require('./mac-updater');
const { backupAppDataBeforeUpdate } = require('./app-data');

const IS_MAC = process.platform === 'darwin';

let autoUpdater = null;
if (!IS_MAC) {
  try {
    ({ autoUpdater } = require('electron-updater'));
  } catch {
    autoUpdater = null;
  }
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
    this.feed = resolveUpdateConfig();
    this.macUpdater = IS_MAC ? new MacUpdater((partial) => this.patch(partial)) : null;
    this.checkInProgress = false;
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
      updateMode: null,
      lastChecked: null,
      platform: process.platform,
      manualInstall: false,
    };

    if (IS_MAC) {
      this.refreshConfig();
      return;
    }

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
    this.feed = resolveUpdateConfig();
    const enabled = this.isRuntimeEnabled();
    this.patch({
      enabled,
      updateUrl: this.feed.url,
      updateMode: IS_MAC ? 'mac-zip-auto' : this.feed.mode,
      currentVersion: readPackageVersion(),
      manualInstall: false,
      status: enabled ? this.state.status : 'disabled',
    });
    return enabled;
  }

  isRuntimeEnabled() {
    if (process.env.ELECTRON_DEV === '1') return false;
    if (process.env.APP_UPDATE_DISABLED === '1') return false;
    if (IS_MAC) return this.feed.enabled;
    if (!autoUpdater) return false;
    return this.feed.enabled;
  }

  ensureAppUpdateConfigFile(url) {
    const ymlPath = path.join(app.getPath('userData'), 'app-update.yml');
    const content = [
      'provider: generic',
      `url: ${url.replace(/\/?$/, '/')}`,
      'updaterCacheDirName: whatsapp-auto-feeding-updater',
      '',
    ].join('\n');
    fs.mkdirSync(path.dirname(ymlPath), { recursive: true });
    fs.writeFileSync(ymlPath, content, 'utf8');
    autoUpdater._appUpdateConfigPath = ymlPath;
    return ymlPath;
  }

  configureFeed() {
    this.feed = resolveUpdateConfig();
    if (!this.feed.enabled || !this.feed.url) {
      throw new Error('Auto-update is not configured');
    }
    const url = this.feed.url.replace(/\/?$/, '/');
    if (IS_MAC) return url;
    this.ensureAppUpdateConfigFile(url);
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
    if (this.checkInProgress) {
      if (IS_MAC && this.macUpdater?.downloadPromise) {
        try {
          await this.macUpdater.downloadPromise;
        } catch {
          /* error already recorded in state */
        }
      }
      return this.getState();
    }
    this.checkInProgress = true;
    try {
      if (IS_MAC) {
        await this.macUpdater.check(this.feed, readPackageVersion());
        return this.getState();
      }
      this.configureFeed();
      await autoUpdater.checkForUpdates();
    } catch (err) {
      this.patch({
        status: 'error',
        error: err.message,
      });
      if (!silent) throw err;
    } finally {
      this.checkInProgress = false;
    }
    return this.getState();
  }

  quitAndInstall() {
    app.isQuittingForUpdate = true;

    try {
      const backup = backupAppDataBeforeUpdate(app, 'pre-update');
      if (backup.backedUp) {
        console.log(`[DATA] Pre-update backup saved: ${backup.dest}`);
      }
    } catch (err) {
      console.warn(`[DATA] Pre-update backup skipped: ${err.message}`);
    }

    if (IS_MAC) {
      this.macUpdater.quitAndInstall();
      return;
    }
    if (!autoUpdater) return;
    // Silent install + force relaunch after NSIS finishes (Update Now must not show wizard).
    autoUpdater.quitAndInstall(true, true);
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
