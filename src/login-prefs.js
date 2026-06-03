const path = require('path');
const fs = require('fs');
const { getAppRoot } = require('./app-root');

function getPrefsPath() {
  return path.join(getAppRoot(), 'auth', '_login-prefs.json');
}

/**
 * E.164-style digits only (no +). Strips 00 prefix and trunk 0 after country code.
 */
function normalizePairingPhone(phoneNumber) {
  let p = String(phoneNumber || '').replace(/\D/g, '');
  if (!p) return '';
  if (p.startsWith('00')) p = p.slice(2);
  // Strip trunk 0 only after a 2–3 digit country code (e.g. 60 + 0 + local), not "6" + "0" + …
  const m = p.match(
    /^(1\d{2}|2\d{1,2}|3\d{2}|4\d{2}|5\d{2}|6\d{1,2}|7\d{1,2}|8\d{2}|9\d{1,2})(0+)(\d{6,})$/
  );
  if (m) p = m[1] + m[3];
  return p;
}

function readLoginPrefs() {
  const prefsPath = getPrefsPath();
  if (!fs.existsSync(prefsPath)) return {};
  try {
    return JSON.parse(fs.readFileSync(prefsPath, 'utf8'));
  } catch {
    return {};
  }
}

function saveLoginPref(sessionName, loginOptions) {
  const prefs = readLoginPrefs();
  const method = loginOptions.method === 'pairing' ? 'pairing' : 'qr';
  const phoneNumber =
    method === 'pairing' ? normalizePairingPhone(loginOptions.phoneNumber) : null;
  prefs[sessionName] = { method, phoneNumber };
  fs.mkdirSync(path.dirname(getPrefsPath()), { recursive: true });
  fs.writeFileSync(getPrefsPath(), JSON.stringify(prefs, null, 2));
}

function clearLoginPrefForSession(sessionName) {
  const prefsPath = getPrefsPath();
  if (!fs.existsSync(prefsPath)) return;
  try {
    const prefs = JSON.parse(fs.readFileSync(prefsPath, 'utf8'));
    if (!prefs[sessionName]) return;
    delete prefs[sessionName];
    if (Object.keys(prefs).length === 0) {
      fs.unlinkSync(prefsPath);
    } else {
      fs.writeFileSync(prefsPath, JSON.stringify(prefs, null, 2));
    }
  } catch {
    /* ignore */
  }
}

module.exports = {
  getPrefsPath,
  normalizePairingPhone,
  readLoginPrefs,
  saveLoginPref,
  clearLoginPrefForSession,
};
