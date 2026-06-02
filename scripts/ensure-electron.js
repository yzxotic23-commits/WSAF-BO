#!/usr/bin/env node
/** Ensure Electron binary exists (Node 26+ may fail @electron/get redirects). */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const https = require('https');

const root = path.join(__dirname, '..');
const electronDir = path.join(root, 'node_modules', 'electron');
const pathTxt = path.join(electronDir, 'path.txt');
const exe = path.join(electronDir, 'dist', 'electron.exe');
const version = require(path.join(electronDir, 'package.json')).version;

if (fs.existsSync(pathTxt) && fs.existsSync(exe)) {
  process.exit(0);
}

const zipName = `electron-v${version}-win32-x64.zip`;
const url = `https://github.com/electron/electron/releases/download/v${version}/${zipName}`;
const zipPath = path.join(require('os').tmpdir(), zipName);
const distDir = path.join(electronDir, 'dist');

console.log('[electron] Downloading', version, '…');

function download(dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    const req = https.get(url, { headers: { 'User-Agent': 'node' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        file.close();
        fs.unlinkSync(dest);
        https.get(res.headers.location, { headers: { 'User-Agent': 'node' } }, (r2) => {
          r2.pipe(file);
          file.on('finish', () => file.close(resolve));
        }).on('error', reject);
        return;
      }
      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode} for ${url}`));
        return;
      }
      res.pipe(file);
      file.on('finish', () => file.close(resolve));
    });
    req.on('error', reject);
  });
}

(async () => {
  fs.mkdirSync(distDir, { recursive: true });
  await download(zipPath);
  fs.rmSync(distDir, { recursive: true, force: true });
  fs.mkdirSync(distDir, { recursive: true });
  if (process.platform === 'win32') {
    execSync(
      `powershell -NoProfile -Command "Expand-Archive -Path '${zipPath.replace(/'/g, "''")}' -DestinationPath '${distDir.replace(/'/g, "''")}' -Force"`,
      { stdio: 'inherit' }
    );
  } else {
    execSync(`unzip -o "${zipPath}" -d "${distDir}"`, { stdio: 'inherit' });
  }
  fs.writeFileSync(pathTxt, process.platform === 'win32' ? 'electron.exe' : 'electron');
  console.log('[electron] Ready:', exe);
})().catch((err) => {
  console.error('[electron] Install failed:', err.message);
  console.error('Run manually: npm run ensure-electron');
  process.exit(1);
});
