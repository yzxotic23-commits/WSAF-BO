const path = require('path');
const fs = require('fs');

const DATA_SUBDIR = 'app-data';
const SIDEcar_FILES = ['.env', 'proxies.txt', 'audit-log.jsonl', 'audit-meta.json'];

function getLegacyAppRoot(app) {
  return path.dirname(app.getPath('exe'));
}

function getDesktopAppRoot(app) {
  return path.join(app.getPath('userData'), DATA_SUBDIR);
}

function copyDirRecursive(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirRecursive(from, to);
    } else {
      fs.copyFileSync(from, to);
    }
  }
}

/**
 * Move user data out of the app bundle (legacy) into Electron userData.
 * Safe to call multiple times — skips if already migrated.
 */
function migrateLegacyAppData(app, targetRoot = getDesktopAppRoot(app)) {
  const legacyRoot = getLegacyAppRoot(app);
  if (path.resolve(legacyRoot) === path.resolve(targetRoot)) {
    return { migrated: false, reason: 'same-path' };
  }

  fs.mkdirSync(targetRoot, { recursive: true });
  const marker = path.join(targetRoot, '.migrated-from-legacy');
  if (fs.existsSync(marker)) {
    return { migrated: false, reason: 'already-migrated' };
  }

  const copied = [];
  const legacyAuth = path.join(legacyRoot, 'auth');
  const targetAuth = path.join(targetRoot, 'auth');

  if (fs.existsSync(legacyAuth) && !fs.existsSync(targetAuth)) {
    copyDirRecursive(legacyAuth, targetAuth);
    copied.push('auth/');
  }

  for (const file of SIDEcar_FILES) {
    const from = path.join(legacyRoot, file);
    const to = path.join(targetRoot, file);
    if (fs.existsSync(from) && !fs.existsSync(to)) {
      fs.copyFileSync(from, to);
      copied.push(file);
    }
  }

  fs.writeFileSync(
    marker,
    JSON.stringify({ from: legacyRoot, copied, at: new Date().toISOString() }, null, 2),
    'utf8'
  );

  return { migrated: copied.length > 0, copied, legacyRoot, targetRoot };
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

/** Bash snippet: rescue legacy data before Mac .app bundle is replaced. */
function buildMacPreInstallMigrateScript(app) {
  const legacyRoot = getLegacyAppRoot(app);
  const targetRoot = getDesktopAppRoot(app);
  return [
    `LEGACY=${shellQuote(legacyRoot)}`,
    `TARGET=${shellQuote(targetRoot)}`,
    'mkdir -p "$TARGET"',
    'if [ -d "$LEGACY/auth" ] && [ ! -d "$TARGET/auth" ]; then',
    '  cp -R "$LEGACY/auth" "$TARGET/"',
    'fi',
    ...SIDEcar_FILES.map(
      (file) => [
        `if [ -f "$LEGACY/${file}" ] && [ ! -f "$TARGET/${file}" ]; then`,
        `  cp "$LEGACY/${file}" "$TARGET/"`,
        'fi',
      ].join('\n')
    ),
  ].join('\n');
}

module.exports = {
  DATA_SUBDIR,
  getLegacyAppRoot,
  getDesktopAppRoot,
  migrateLegacyAppData,
  buildMacPreInstallMigrateScript,
};
