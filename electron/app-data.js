const path = require('path');
const fs = require('fs');

const DATA_SUBDIR = 'app-data';
const SIDECAR_FILES = ['.env', 'proxies.txt', 'audit-log.jsonl', 'audit-meta.json'];
const MAX_UPDATE_BACKUPS = 5;

function getLegacyAppRoot(app) {
  return path.dirname(app.getPath('exe'));
}

function getDesktopAppRoot(app) {
  return path.join(app.getPath('userData'), DATA_SUBDIR);
}

function getBackupRoot(app) {
  return path.join(app.getPath('userData'), 'app-data-backups');
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

function pruneBackupDirs(backupDir, keep = MAX_UPDATE_BACKUPS) {
  if (!fs.existsSync(backupDir)) return;
  const entries = fs
    .readdirSync(backupDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => {
      const full = path.join(backupDir, e.name);
      return { path: full, mtime: fs.statSync(full).mtimeMs };
    })
    .sort((a, b) => b.mtime - a.mtime);

  for (const old of entries.slice(keep)) {
    try {
      fs.rmSync(old.path, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

/**
 * Copy missing auth accounts / sidecar files from legacy install folder into userData.
 * Never deletes or overwrites existing user data.
 */
function syncMissingFromLegacy(app, targetRoot = getDesktopAppRoot(app)) {
  const legacyRoot = getLegacyAppRoot(app);
  if (path.resolve(legacyRoot) === path.resolve(targetRoot)) {
    return { synced: false, copied: [], reason: 'same-path' };
  }

  fs.mkdirSync(targetRoot, { recursive: true });
  const copied = [];

  const legacyAuth = path.join(legacyRoot, 'auth');
  const targetAuth = path.join(targetRoot, 'auth');
  if (fs.existsSync(legacyAuth)) {
    fs.mkdirSync(targetAuth, { recursive: true });
    for (const entry of fs.readdirSync(legacyAuth, { withFileTypes: true })) {
      const from = path.join(legacyAuth, entry.name);
      const to = path.join(targetAuth, entry.name);
      if (fs.existsSync(to)) continue;
      if (entry.isDirectory()) {
        copyDirRecursive(from, to);
      } else {
        fs.copyFileSync(from, to);
      }
      copied.push(`auth/${entry.name}`);
    }
  }

  for (const file of SIDECAR_FILES) {
    const from = path.join(legacyRoot, file);
    const to = path.join(targetRoot, file);
    if (fs.existsSync(from) && !fs.existsSync(to)) {
      fs.copyFileSync(from, to);
      copied.push(file);
    }
  }

  return { synced: copied.length > 0, copied, legacyRoot, targetRoot };
}

/**
 * One-time migration from install folder → userData (first packaged run).
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

  const sync = syncMissingFromLegacy(app, targetRoot);
  if (sync.copied.length > 0) {
    fs.writeFileSync(
      marker,
      JSON.stringify({ from: legacyRoot, copied: sync.copied, at: new Date().toISOString() }, null, 2),
      'utf8'
    );
    return { migrated: true, copied: sync.copied, legacyRoot, targetRoot };
  }

  fs.writeFileSync(
    marker,
    JSON.stringify({ from: legacyRoot, copied: [], at: new Date().toISOString(), note: 'no legacy data' }, null, 2),
    'utf8'
  );
  return { migrated: false, reason: 'no-legacy-data', legacyRoot, targetRoot };
}

function writeDataLocationMarker(app, targetRoot = getDesktopAppRoot(app)) {
  const marker = path.join(targetRoot, '.data-location.json');
  fs.mkdirSync(targetRoot, { recursive: true });
  fs.writeFileSync(
    marker,
    JSON.stringify(
      {
        appDataRoot: targetRoot,
        userData: app.getPath('userData'),
        protected: ['auth/', ...SIDECAR_FILES],
        note: 'WhatsApp sessions and settings are stored here. App updates replace only the program — this folder is kept.',
        updatedAt: new Date().toISOString(),
      },
      null,
      2
    ),
    'utf8'
  );
}

/**
 * Run on every app start: ensure user data lives outside the app bundle and rescue any legacy copies.
 */
function ensureUserDataPreserved(app) {
  const targetRoot = getDesktopAppRoot(app);
  fs.mkdirSync(targetRoot, { recursive: true });
  const migration = migrateLegacyAppData(app, targetRoot);
  const sync = syncMissingFromLegacy(app, targetRoot);
  writeDataLocationMarker(app, targetRoot);
  return { targetRoot, migration, sync };
}

/**
 * Snapshot app-data before installing an update (Windows NSIS / manual install safety net).
 */
function backupAppDataBeforeUpdate(app, reason = 'pre-update') {
  const root = getDesktopAppRoot(app);
  if (!fs.existsSync(root)) {
    return { backedUp: false, reason: 'no-data' };
  }

  const backupDir = getBackupRoot(app);
  fs.mkdirSync(backupDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const version = app.getVersion();
  const dest = path.join(backupDir, `${reason}-v${version}-${stamp}`);

  copyDirRecursive(root, dest);
  pruneBackupDirs(backupDir, MAX_UPDATE_BACKUPS);

  return { backedUp: true, dest, kept: MAX_UPDATE_BACKUPS };
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

/** Bash snippet: rescue legacy data before Mac .app bundle is replaced (merge missing only). */
function buildMacPreInstallMigrateScript(app) {
  const legacyRoot = getLegacyAppRoot(app);
  const targetRoot = getDesktopAppRoot(app);
  return [
    `LEGACY=${shellQuote(legacyRoot)}`,
    `TARGET=${shellQuote(targetRoot)}`,
    'mkdir -p "$TARGET"',
    'if [ -d "$LEGACY/auth" ]; then',
    '  mkdir -p "$TARGET/auth"',
    '  for item in "$LEGACY/auth"/*; do',
    '    [ -e "$item" ] || continue',
    '    base=$(basename "$item")',
    '    if [ ! -e "$TARGET/auth/$base" ]; then',
    '      cp -R "$item" "$TARGET/auth/$base"',
    '    fi',
    '  done',
    'fi',
    ...SIDECAR_FILES.map((file) =>
      [
        `if [ -f "$LEGACY/${file}" ] && [ ! -f "$TARGET/${file}" ]; then`,
        `  cp "$LEGACY/${file}" "$TARGET/"`,
        'fi',
      ].join('\n')
    ),
    'echo "User data preserved in $TARGET (sessions not deleted by update)" >> "$LOG"',
  ].join('\n');
}

module.exports = {
  DATA_SUBDIR,
  SIDECAR_FILES,
  getLegacyAppRoot,
  getDesktopAppRoot,
  getBackupRoot,
  migrateLegacyAppData,
  syncMissingFromLegacy,
  ensureUserDataPreserved,
  backupAppDataBeforeUpdate,
  buildMacPreInstallMigrateScript,
};
