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

function main() {
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

  const setup = fs
    .readdirSync(outPath)
    .find((f) => f.endsWith('.exe') && f.includes('Setup'));
  if (setup) {
    console.log(`[build:win] Installer: ${path.join(output, setup)}`);
  }
}

main();
