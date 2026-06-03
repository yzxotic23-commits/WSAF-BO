/**
 * Windows build with auto-fallback when release\ is file-locked.
 */
const { execSync, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const releaseDir = path.join(root, 'release');
const fallbackDir = path.join(root, 'release-build');

function killLocks() {
  if (process.platform !== 'win32') return;
  for (const name of ['electron.exe', 'WhatsApp Auto Feeding.exe']) {
    try {
      execSync(`taskkill /F /IM "${name}" /T`, { stdio: 'ignore' });
    } catch {
      /* not running */
    }
  }
}

function tryRemove(dir) {
  if (!fs.existsSync(dir)) return true;
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 400 });
    return !fs.existsSync(dir);
  } catch {
    return false;
  }
}

function canUseRelease() {
  const winUnpacked = path.join(releaseDir, 'win-unpacked');
  if (!fs.existsSync(winUnpacked)) return true;
  if (tryRemove(winUnpacked)) return true;
  if (tryRemove(releaseDir)) return true;

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backup = path.join(root, `release-locked-${stamp}`);
  try {
    fs.renameSync(releaseDir, backup);
    console.log(`[build:win] Folder release dikunci — dipindah ke:\n  ${backup}`);
    return true;
  } catch {
    return false;
  }
}

function resolveOutputDir() {
  const forced = process.argv.find((a) => a.startsWith('--output='));
  if (forced) return forced.split('=')[1];

  killLocks();
  if (canUseRelease()) return 'release';

  console.warn('[build:win] Folder release masih dikunci — build ke release-build\\');
  return 'release-build';
}

async function main() {
  const output = resolveOutputDir();
  const outPath = path.join(root, output);
  const winUnpacked = path.join(outPath, 'win-unpacked');
  tryRemove(winUnpacked);

  console.log(`[build:win] Output: ${output}\\`);

  const result = spawnSync(
    'npx',
    ['electron-builder', '--win', '--x64', `--config.directories.output=${output}`],
    { cwd: root, stdio: 'inherit', shell: true }
  );

  if (result.status !== 0) process.exit(result.status || 1);

  applyWindowsIcons(outPath);

  const setup = fs
    .readdirSync(outPath)
    .find((f) => f.endsWith('.exe') && f.includes('Setup'));
  if (setup) {
    console.log(`[build:win] Installer: ${path.join(output, setup)}`);
  }
}

/** Embed custom icon (signAndEditExecutable:false skips rcedit in electron-builder). */
async function applyWindowsIcons(outPath) {
  const iconIco = path.join(root, 'electron', 'icons', 'icon.ico');
  if (!fs.existsSync(iconIco)) {
    console.warn('[build:win] Skip icon embed — missing', iconIco);
    return;
  }
  let rceditFn;
  try {
    ({ rcedit: rceditFn } = await import('rcedit'));
  } catch {
    console.warn('[build:win] Skip icon embed — rcedit not installed');
    return;
  }

  const version = require(path.join(root, 'package.json')).version;
  const targets = [];
  const unpackedExe = path.join(outPath, 'win-unpacked', 'WhatsApp Auto Feeding.exe');
  if (fs.existsSync(unpackedExe)) targets.push(unpackedExe);
  for (const f of fs.readdirSync(outPath)) {
    if (new RegExp(`Setup.*${version.replace(/\./g, '\\.')}\\.exe$`, 'i').test(f)) {
      targets.push(path.join(outPath, f));
    }
  }

  for (const exe of targets) {
    try {
      await rceditFn(exe, { icon: iconIco });
      console.log('[build:win] Icon applied:', path.basename(exe));
    } catch (err) {
      console.warn('[build:win] Icon embed failed for', path.basename(exe), err.message);
    }
  }
}

main().catch((err) => {
  console.error('[build:win]', err);
  process.exit(1);
});
