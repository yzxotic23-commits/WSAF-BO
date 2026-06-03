const { app, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');
const https = require('https');
const semver = require('semver');
const { resolveUpdateConfig } = require('./update-config');

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

function parseYmlVersion(text) {
  const match = String(text || '').match(/^version:\s*(.+)$/m);
  return match?.[1]?.trim() || null;
}

function isNewerVersion(latest, current) {
  if (!latest) return false;
  if (semver.valid(latest) && semver.valid(current)) {
    return semver.gt(latest, current);
  }
  return String(latest) !== String(current);
}

function httpRequest(url, method = 'GET') {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https:') ? require('https') : http;
    const req = lib.request(url, { method, headers: { 'User-Agent': 'FeedFlow-Updater' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        httpRequest(res.headers.location, method).then(resolve).catch(reject);
        return;
      }
      if (method === 'HEAD') {
        res.resume();
        resolve({ status: res.statusCode });
        return;
      }
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

async function resolveMacDmgUrl(version, feed, owner, repo) {
  const candidates = [
    `${feed}WhatsApp.Auto.Feeding-${version}-arm64-mac.dmg`,
    `${feed}WhatsApp.Auto.Feeding-${version}-arm64.dmg`,
  ];
  if (owner && repo) {
    candidates.unshift(
      `https://github.com/${owner}/${repo}/releases/download/v${version}/WhatsApp.Auto.Feeding-${version}-arm64-mac.dmg`,
      `https://github.com/${owner}/${repo}/releases/download/v${version}/WhatsApp.Auto.Feeding-${version}-arm64.dmg`
    );
  }
  for (const url of candidates) {
    try {
      const res = await httpRequest(url, 'HEAD');
      if (res.status === 200) return url;
    } catch {
      /* try next */
    }
  }
  return candidates[0];
}

class AppUpdater {
  constructor(onChange) {
    this.onChange = onChange || (() => {});
    this.feed = resolveUpdateConfig();
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
      manualInstall: IS_MAC,
      downloadUrl: null,
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
      updateMode: IS_MAC ? 'mac-dmg-manual' : this.feed.mode,
      currentVersion: readPackageVersion(),
      manualInstall: IS_MAC,
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

  async checkMacManual() {
    const feed = this.configureFeed();
    this.patch({ status: 'checking', error: null, downloadUrl: null });

    const ymlRes = await httpRequest(`${feed}latest-mac.yml`);
    if (ymlRes.status !== 200) {
      throw new Error(`Could not fetch latest-mac.yml (HTTP ${ymlRes.status})`);
    }

    const latestVersion = parseYmlVersion(ymlRes.body);
    if (!latestVersion) {
      throw new Error('latest-mac.yml has no version field');
    }

    const currentVersion = readPackageVersion();
    if (!isNewerVersion(latestVersion, currentVersion)) {
      this.patch({
        status: 'not-available',
        latestVersion,
        currentVersion,
        error: null,
        downloadUrl: null,
      });
      return this.getState();
    }

    const downloadUrl = await resolveMacDmgUrl(
      latestVersion,
      feed,
      this.feed.owner,
      this.feed.repo
    );

    this.patch({
      status: 'available',
      latestVersion,
      currentVersion,
      downloadUrl,
      manualInstall: true,
      error: null,
      releaseNotes: `Download the DMG for v${latestVersion}, open it, and drag WhatsApp Auto Feeding to Applications.`,
    });
    return this.getState();
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
      if (IS_MAC) {
        return await this.checkMacManual();
      }
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

  openDownloadPage() {
    const url = this.state.downloadUrl;
    if (!url) return false;
    shell.openExternal(url);
    return true;
  }

  quitAndInstall() {
    if (IS_MAC && this.state.manualInstall) {
      this.openDownloadPage();
      return;
    }
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
