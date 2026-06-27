const path = require('path');

/** Folder data app (.env, auth/, proxies.txt) — sama untuk UI desktop dan CLI feeding. */
function getAppRoot() {
  return process.env.APP_ROOT || process.cwd();
}

function getAuthDir(sessionName) {
  return path.join(getAppRoot(), 'auth', sessionName);
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

module.exports = { getAppRoot, getAuthDir, ensureAppRoot };
