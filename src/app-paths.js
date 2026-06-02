const path = require('path');
const fs = require('fs');

/**
 * Root folder for .env, auth/, proxies.txt.
 * Desktop sets WA_APP_DATA to Electron userData; CLI uses cwd.
 */
function getAppDataRoot() {
  const fromEnv = process.env.WA_APP_DATA?.trim();
  if (fromEnv) return path.resolve(fromEnv);
  return process.cwd();
}

function getAuthRoot() {
  return path.join(getAppDataRoot(), 'auth');
}

function getEnvPath() {
  return path.join(getAppDataRoot(), '.env');
}

function getProxiesPath() {
  return path.join(getAppDataRoot(), 'proxies.txt');
}

function getLoginPrefsPath() {
  return path.join(getAuthRoot(), '_login-prefs.json');
}

function getProxyWorkingPath() {
  return path.join(getAuthRoot(), '_proxy-working.json');
}

function ensureAppDataLayout() {
  const root = getAppDataRoot();
  fs.mkdirSync(getAuthRoot(), { recursive: true });
  return root;
}

module.exports = {
  getAppDataRoot,
  getAuthRoot,
  getEnvPath,
  getProxiesPath,
  getLoginPrefsPath,
  getProxyWorkingPath,
  ensureAppDataLayout,
};
