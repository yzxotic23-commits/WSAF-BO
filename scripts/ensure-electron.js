#!/usr/bin/env node
/** Ensure Electron binary exists (sync — safe for npm run desktop && chain). */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const https = require('https');

const root = path.join(__dirname, '..');
const electronDir = path.join(root, 'node_modules', 'electron');
const pathTxt = path.join(electronDir, 'path.txt');
const distDir = path.join(electronDir, 'dist');
const exeName = process.platform === 'win32' ? 'electron.exe' : 'electron';
const exe = path.join(distDir, exeName);

function isReady() {
  return fs.existsSync(pathTxt) && fs.existsSync(exe);
}

function findElectronExe(dir) {
  if (!fs.existsSync(dir)) return null;
  const direct = path.join(dir, exeName);
  if (fs.existsSync(direct)) return direct;
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    try {
      if (!fs.statSync(full).isDirectory()) continue;
    } catch {
      continue;
    }
    const hit = findElectronExe(full);
    if (hit) return hit;
  }
  return null;
}

function copyDirContents(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const name of fs.readdirSync(src)) {
    const from = path.join(src, name);
    const to = path.join(dest, name);
    if (fs.statSync(from).isDirectory()) {
      copyDirContents(from, to);
    } else {
      fs.copyFileSync(from, to);
    }
  }
}

function downloadSync(url, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    const follow = (u) => {
      https
        .get(u, { headers: { 'User-Agent': 'node' } }, (res) => {
          if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            file.close();
            try {
              fs.unlinkSync(dest);
            } catch { /* noop */ }
            follow(res.headers.location);
            return;
          }
          if (res.statusCode !== 200) {
            reject(new Error(`HTTP ${res.statusCode} for ${u}`));
            return;
          }
          res.pipe(file);
          file.on('finish', () => file.close(resolve));
        })
        .on('error', reject);
    };
    follow(url);
  });
}

function installElectron() {
  const version = require(path.join(electronDir, 'package.json')).version;
  const zipName = `electron-v${version}-win32-x64.zip`;
  const url = `https://github.com/electron/electron/releases/download/v${version}/${zipName}`;
  const zipPath = path.join(require('os').tmpdir(), zipName);
  const extractDir = path.join(electronDir, '_extract_tmp');

  console.log('[electron] Downloading', version, '…');

  fs.rmSync(extractDir, { recursive: true, force: true });
  fs.rmSync(distDir, { recursive: true, force: true });

  execSync(
    `powershell -NoProfile -Command "$ProgressPreference='SilentlyContinue'; Invoke-WebRequest -Uri '${url}' -OutFile '${zipPath.replace(/'/g, "''")}'"`,
    { stdio: 'inherit' }
  );

  if (!fs.existsSync(zipPath) || fs.statSync(zipPath).size < 1_000_000) {
    throw new Error(`Download failed or too small: ${zipPath}`);
  }

  fs.mkdirSync(extractDir, { recursive: true });

  if (process.platform === 'win32') {
    execSync(
      `powershell -NoProfile -Command "Expand-Archive -Path '${zipPath.replace(/'/g, "''")}' -DestinationPath '${extractDir.replace(/'/g, "''")}' -Force"`,
      { stdio: 'inherit' }
    );
  } else {
    execSync(`unzip -o "${zipPath}" -d "${extractDir}"`, { stdio: 'inherit' });
  }

  const found = findElectronExe(extractDir);
  if (!found) {
    throw new Error(`electron binary not found inside ${zipName}`);
  }

  const payloadRoot = path.dirname(found);
  fs.mkdirSync(distDir, { recursive: true });
  copyDirContents(payloadRoot, distDir);

  if (!fs.existsSync(exe)) {
    throw new Error(`Expected ${exe} after extract`);
  }

  fs.writeFileSync(pathTxt, exeName, 'utf8');
  fs.rmSync(extractDir, { recursive: true, force: true });

  console.log('[electron] Ready:', exe);
}

function main() {
  if (isReady()) {
    return;
  }

  try {
    installElectron();
  } catch (err) {
    console.error('[electron] Install failed:', err.message);
    console.error('Coba: tutup semua app Electron, lalu:');
    console.error('  Remove-Item -Recurse -Force node_modules\\electron');
    console.error('  npm install electron');
    console.error('  npm run ensure-electron');
    process.exit(1);
  }

  if (!isReady()) {
    console.error('[electron] path.txt atau electron.exe masih hilang.');
    process.exit(1);
  }
}

main();
