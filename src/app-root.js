const path = require('path');
const fs = require('fs');

/** Folder data app (.env, auth/, proxies.txt) — sama untuk UI desktop dan CLI feeding. */
function getAppRoot() {
  return process.env.APP_ROOT || process.cwd();
}

function getAuthDir(sessionName) {
  return path.join(getAppRoot(), 'auth', sessionName);
}

/**
 * Durable proxies.txt path — on Railway the volume is /app/auth, so prefer auth/proxies.txt.
 * Feeding CLI must use the same path as the bridge or WA reconnects on Railway egress → logout.
 */
function getProxiesPath(root = getAppRoot()) {
  if (process.env.WSAF_PROXIES_FILE) return process.env.WSAF_PROXIES_FILE;
  const rootFile = path.join(root, 'proxies.txt');
  const onRailway = Boolean(
    process.env.RAILWAY_ENVIRONMENT
    || process.env.RAILWAY_PROJECT_ID
    || process.env.WSAF_STICKY_PROXY === '1'
  );
  if (onRailway) {
    const volumeFile = path.join(root, 'auth', 'proxies.txt');
    try {
      if (!fs.existsSync(volumeFile) && fs.existsSync(rootFile)) {
        fs.mkdirSync(path.dirname(volumeFile), { recursive: true });
        fs.copyFileSync(rootFile, volumeFile);
      }
    } catch {
      /* ignore migrate errors */
    }
    return volumeFile;
  }
  return rootFile;
}

function ensureAppRoot() {
  const root = getAppRoot();
  if (process.env.APP_ROOT) {
    try {
      process.chdir(root);
    } catch {
      /* ignore */
    }
  }
  return root;
}

module.exports = { getAppRoot, getAuthDir, getProxiesPath, ensureAppRoot };
