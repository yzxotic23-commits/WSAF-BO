/**
 * macOS auto-update without Apple code signing.
 * Downloads the release ZIP, verifies sha512, replaces the .app bundle, and relaunches.
 */
const { app } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const http = require('http');
const https = require('https');
const { spawn } = require('child_process');

function compareVersions(latest, current) {
  const parse = (v) => String(v || '0').split('.').map((n) => parseInt(n, 10) || 0);
  const a = parse(latest);
  const b = parse(current);
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const diff = (a[i] || 0) - (b[i] || 0);
    if (diff > 0) return 1;
    if (diff < 0) return -1;
  }
  return 0;
}

function httpRequest(url, method = 'GET') {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https:') ? https : http;
    const req = lib.request(
      url,
      { method, headers: { 'User-Agent': 'FeedFlow-Mac-Updater' } },
      (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          httpRequest(res.headers.location, method).then(resolve).catch(reject);
          return;
        }
        if (method === 'HEAD') {
          res.resume();
          resolve({ status: res.statusCode, headers: res.headers });
          return;
        }
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          resolve({ status: res.statusCode, body: Buffer.concat(chunks) });
        });
      }
    );
    req.on('error', reject);
    req.end();
  });
}

function parseMacYml(text) {
  const versionMatch = String(text || '').match(/^version:\s*(.+)$/m);
  const version = versionMatch?.[1]?.trim() || null;
  const pathMatch = String(text || '').match(/^path:\s*(.+)$/m);
  const zipName = pathMatch?.[1]?.trim() || null;
  const shaMatch = String(text || '').match(/^sha512:\s*(.+)$/m);
  const sha512 = shaMatch?.[1]?.trim() || null;
  return { version, zipName, sha512 };
}

function sha512File(filePath) {
  const hash = crypto.createHash('sha512');
  hash.update(fs.readFileSync(filePath));
  return hash.digest('base64');
}

function getMacAppBundlePath() {
  const exe = app.getPath('exe');
  return path.resolve(exe, '..', '..', '..');
}

function getUpdateCacheDir() {
  const dir = path.join(app.getPath('userData'), 'mac-updates');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function findAppBundle(rootDir) {
  const entries = fs.readdirSync(rootDir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(rootDir, entry.name);
    if (entry.isDirectory() && entry.name.endsWith('.app')) {
      return full;
    }
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const nested = findAppBundle(path.join(rootDir, entry.name));
    if (nested) return nested;
  }
  return null;
}

function zipNameCandidates(zipName) {
  const names = new Set([zipName]);
  if (zipName.includes(' ')) names.add(zipName.replace(/ /g, '.'));
  if (zipName.includes('.')) names.add(zipName.replace(/\./g, ' '));
  return [...names];
}

function probeDownloadUrl(url) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https:') ? https : http;
    const req = lib.request(
      url,
      {
        method: 'GET',
        headers: { Range: 'bytes=0-0', 'User-Agent': 'FeedFlow-Mac-Updater' },
      },
      (res) => {
        res.resume();
        resolve(res.statusCode === 200 || res.statusCode === 206);
      }
    );
    req.on('error', reject);
    req.end();
  });
}

function buildZipUrlCandidates(feedBase, zipName, version, owner, repo) {
  const base = feedBase.replace(/\/?$/, '/');
  const candidates = [];
  for (const name of zipNameCandidates(zipName)) {
    const encoded = encodeURIComponent(name).replace(/%20/g, '%20');
    if (owner && repo) {
      candidates.push(`https://github.com/${owner}/${repo}/releases/download/v${version}/${name}`);
      candidates.push(`https://github.com/${owner}/${repo}/releases/download/v${version}/${encoded}`);
    }
    candidates.push(`${base}${name}`);
    candidates.push(`${base}${encoded}`);
  }
  return [...new Set(candidates)];
}

async function resolveZipUrl(feedBase, zipName, version, owner, repo) {
  const candidates = buildZipUrlCandidates(feedBase, zipName, version, owner, repo);

  for (const url of candidates) {
    try {
      const res = await httpRequest(url, 'HEAD');
      if (res.status === 200) return url;
    } catch {
      /* try next */
    }
  }

  // GitHub may reject HEAD — probe with a 1-byte range request
  for (const url of candidates) {
    try {
      const ok = await probeDownloadUrl(url);
      if (ok) return url;
    } catch {
      /* try next */
    }
  }

  const fallback = candidates[0];
  if (!/^https?:\/\//i.test(fallback)) {
    throw new Error('Could not resolve update download URL');
  }
  return fallback;
}

function downloadFile(url, destPath, onProgress) {
  return new Promise((resolve, reject) => {
    if (!url || !/^https?:\/\//i.test(String(url))) {
      reject(new Error(`Invalid download URL: ${url || '(empty)'}`));
      return;
    }
    const lib = url.startsWith('https:') ? https : http;
    const file = fs.createWriteStream(destPath);

    const request = (targetUrl) => {
      lib.get(targetUrl, { headers: { 'User-Agent': 'FeedFlow-Mac-Updater' } }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          request(res.headers.location);
          return;
        }
        if (res.statusCode !== 200) {
          file.close();
          fs.unlink(destPath, () => {});
          reject(new Error(`Download failed (HTTP ${res.statusCode})`));
          return;
        }

        const total = parseInt(res.headers['content-length'] || '0', 10);
        let transferred = 0;

        res.on('data', (chunk) => {
          transferred += chunk.length;
          if (onProgress && total > 0) {
            onProgress({
              percent: Math.round((transferred / total) * 100),
              transferred,
              total,
            });
          }
        });

        res.pipe(file);
        file.on('finish', () => {
          file.close(() => resolve(destPath));
        });
      }).on('error', (err) => {
        file.close();
        fs.unlink(destPath, () => {});
        reject(err);
      });
    };

    request(url);
  });
}

function extractZip(zipPath, destDir) {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(destDir, { recursive: true });
    const child = spawn('unzip', ['-o', '-q', zipPath, '-d', destDir], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let err = '';
    child.stderr.on('data', (d) => { err += d; });
    child.on('close', (code) => {
      if (code === 0) resolve(destDir);
      else reject(new Error(err.trim() || `unzip exited ${code}`));
    });
    child.on('error', reject);
  });
}

function quitAndInstallMacUpdate(stagedAppBundle) {
  const targetApp = getMacAppBundlePath();
  const targetDir = path.dirname(targetApp);
  const appName = path.basename(targetApp);
  const scriptPath = path.join(getUpdateCacheDir(), 'install-update.sh');
  const logPath = path.join(getUpdateCacheDir(), 'install.log');

  const script = `#!/bin/bash
set -e
LOG="${logPath.replace(/"/g, '\\"')}"
echo "FeedFlow Mac update started" >> "$LOG"
sleep 2
rm -rf "${path.join(targetDir, appName).replace(/"/g, '\\"')}"
ditto "${stagedAppBundle.replace(/"/g, '\\"')}" "${path.join(targetDir, appName).replace(/"/g, '\\"')}"
xattr -cr "${path.join(targetDir, appName).replace(/"/g, '\\"')}" || true
open "${path.join(targetDir, appName).replace(/"/g, '\\"')}"
echo "FeedFlow Mac update done" >> "$LOG"
`;

  fs.writeFileSync(scriptPath, script, { mode: 0o755 });
  spawn('/bin/bash', [scriptPath], {
    detached: true,
    stdio: 'ignore',
  }).unref();

  app.quit();
}

class MacUpdater {
  constructor(patchState) {
    this.patch = patchState;
    this.downloadPromise = null;
    this.stagedAppBundle = null;
  }

  async check(feed, currentVersion) {
    const feedUrl = feed.url.replace(/\/?$/, '/');

    const ymlRes = await httpRequest(`${feedUrl}latest-mac.yml`);
    if (ymlRes.status !== 200) {
      throw new Error(`Could not fetch latest-mac.yml (HTTP ${ymlRes.status})`);
    }

    const meta = parseMacYml(
      Buffer.isBuffer(ymlRes.body) ? ymlRes.body.toString('utf8') : ymlRes.body
    );
    if (!meta.version || !meta.zipName) {
      throw new Error('latest-mac.yml is missing version or path');
    }

    if (compareVersions(meta.version, currentVersion) <= 0) {
      this.patch({
        status: 'not-available',
        latestVersion: meta.version,
        currentVersion,
        error: null,
      });
      return;
    }

    this.patch({ status: 'checking', error: null });

    this.patch({
      status: 'available',
      latestVersion: meta.version,
      currentVersion,
      releaseNotes: `FeedFlow v${meta.version} is ready to install.`,
      error: null,
    });

    await this.downloadAndStage(feed, meta);
  }

  async downloadAndStage(feed, meta) {
    if (this.downloadPromise) return this.downloadPromise;

    this.downloadPromise = (async () => {
      this.patch({
        status: 'downloading',
        percent: 0,
        error: null,
        releaseNotes: `Preparing v${meta.version} download…`,
      });

      const cacheDir = getUpdateCacheDir();
      const zipPath = path.join(cacheDir, meta.zipName);
      const extractDir = path.join(cacheDir, `extract-${meta.version}`);

      const zipUrl = await resolveZipUrl(
        feed.url,
        meta.zipName,
        meta.version,
        feed.owner,
        feed.repo
      );

      this.patch({ status: 'downloading', percent: 0, error: null });

      if (!zipUrl || !/^https?:\/\//i.test(zipUrl)) {
        throw new Error(`Invalid download URL: ${zipUrl || '(empty)'}`);
      }

      await downloadFile(zipUrl, zipPath, (p) => {
        this.patch({
          status: 'downloading',
          percent: p.percent,
          transferred: p.transferred,
          total: p.total,
        });
      });

      if (meta.sha512) {
        const digest = sha512File(zipPath);
        if (digest !== meta.sha512) {
          throw new Error('Downloaded update failed integrity check (sha512 mismatch)');
        }
      }

      if (fs.existsSync(extractDir)) {
        fs.rmSync(extractDir, { recursive: true, force: true });
      }
      await extractZip(zipPath, extractDir);

      const bundle = findAppBundle(extractDir);
      if (!bundle) {
        throw new Error('Update archive did not contain a .app bundle');
      }

      this.stagedAppBundle = bundle;
      this.patch({
        status: 'downloaded',
        latestVersion: meta.version,
        percent: 100,
        error: null,
        releaseNotes: `v${meta.version} downloaded — click Update Now to restart and install.`,
      });
    })().catch((err) => {
      this.downloadPromise = null;
      this.patch({
        status: 'error',
        error: err.message || String(err),
      });
      throw err;
    });

    return this.downloadPromise;
  }

  quitAndInstall() {
    if (!this.stagedAppBundle || !fs.existsSync(this.stagedAppBundle)) {
      throw new Error('No downloaded update ready to install');
    }
    quitAndInstallMacUpdate(this.stagedAppBundle);
  }
}

module.exports = {
  MacUpdater,
  compareVersions,
  parseMacYml,
};
