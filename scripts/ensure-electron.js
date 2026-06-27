#!/usr/bin/env node
/** Ensure Electron binary exists (sync — safe for npm run desktop && chain). */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const os = require('os');

const root = path.join(__dirname, '..');
const electronDir = path.join(root, 'node_modules', 'electron');
const distDir = path.join(electronDir, 'dist');
const pathTxt = path.join(electronDir, 'path.txt');

function getPlatformPath() {
  switch (process.platform) {
    case 'darwin':
      return 'Electron.app/Contents/MacOS/Electron';
    case 'win32':
      return 'electron.exe';
    case 'linux':
      return 'electron';
    default:
      throw new Error(`Unsupported platform: ${process.platform}`);
  }
}

function getArchiveSuffix() {
  const { platform, arch } = process;
  if (platform === 'win32') {
    return arch === 'ia32' ? 'win32-ia32' : 'win32-x64';
  }
  if (platform === 'darwin') {
    return arch === 'arm64' ? 'darwin-arm64' : 'darwin-x64';
  }
  if (platform === 'linux') {
    return arch === 'arm64' ? 'linux-arm64' : 'linux-x64';
  }
  throw new Error(`Unsupported platform: ${platform} ${arch}`);
}

function isReady() {
  const platformPath = getPlatformPath();
  if (!fs.existsSync(path.join(distDir, platformPath))) {
    return false;
  }
  if (!fs.existsSync(pathTxt)) {
    return false;
  }
  try {
    return fs.readFileSync(pathTxt, 'utf8').trim() === platformPath;
  } catch {
    return false;
  }
}

function writePathTxt() {
  fs.writeFileSync(pathTxt, getPlatformPath(), 'utf8');
}

function downloadFileSync(url, dest) {
  const follow = (currentUrl) => {
    execSync(
      `curl -fsSL ${JSON.stringify(currentUrl)} -o ${JSON.stringify(dest)}`,
      { stdio: 'inherit' }
    );
  };

  if (process.platform === 'win32') {
    execSync(
      `powershell -NoProfile -Command "$ProgressPreference='SilentlyContinue'; Invoke-WebRequest -Uri ${JSON.stringify(url)} -OutFile ${JSON.stringify(dest)}"`,
      { stdio: 'inherit' }
    );
    return;
  }

  try {
    follow(url);
  } catch {
    // curl -f fails on redirect chains to some hosts; retry via Node redirect follower.
    const tmp = `${dest}.part`;
    const done = require('child_process').spawnSync(
      process.execPath,
      [
        '-e',
        `const fs=require('fs');const https=require('https');
const url=${JSON.stringify(url)};
const dest=${JSON.stringify(tmp)};
const go=(u)=>https.get(u,{headers:{'User-Agent':'node'}},(res)=>{
  if(res.statusCode>=300&&res.statusCode<400&&res.headers.location)return go(res.headers.location);
  if(res.statusCode!==200){process.exit(2);return;}
  const f=fs.createWriteStream(dest);res.pipe(f);f.on('finish',()=>f.close());
}).on('error',()=>process.exit(3));go(url);`,
      ],
      { stdio: 'inherit' }
    );
    if (done.status !== 0) {
      throw new Error(`Download failed for ${url}`);
    }
    fs.renameSync(tmp, dest);
  }
}

function extractZipSync(zipPath, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  if (process.platform === 'win32') {
    execSync(
      `powershell -NoProfile -Command "Expand-Archive -Path ${JSON.stringify(zipPath)} -DestinationPath ${JSON.stringify(destDir)} -Force"`,
      { stdio: 'inherit' }
    );
    return;
  }
  execSync(`unzip -o ${JSON.stringify(zipPath)} -d ${JSON.stringify(destDir)}`, {
    stdio: 'inherit',
  });
}

function installElectronSync() {
  const pkg = require(path.join(electronDir, 'package.json'));
  const suffix = getArchiveSuffix();
  const zipName = `electron-v${pkg.version}-${suffix}.zip`;
  const url = `https://github.com/electron/electron/releases/download/v${pkg.version}/${zipName}`;
  const zipPath = path.join(os.tmpdir(), zipName);
  const platformPath = getPlatformPath();

  console.log('[electron] Installing binary for', suffix, '…');

  fs.rmSync(distDir, { recursive: true, force: true });
  downloadFileSync(url, zipPath);

  if (!fs.existsSync(zipPath) || fs.statSync(zipPath).size < 1_000_000) {
    throw new Error(`Download failed or too small: ${zipPath}`);
  }

  extractZipSync(zipPath, distDir);

  if (!fs.existsSync(path.join(distDir, platformPath))) {
    throw new Error(`Binary not found after extract: ${platformPath}`);
  }

  writePathTxt();
  console.log('[electron] Ready:', path.join(distDir, platformPath));
}

function main() {
  if (isReady()) {
    return;
  }

  if (!fs.existsSync(path.join(electronDir, 'package.json'))) {
    console.error('[electron] node_modules/electron belum terpasang. Jalankan: npm install');
    process.exit(1);
  }

  const platformPath = getPlatformPath();
  if (fs.existsSync(path.join(distDir, platformPath)) && !fs.existsSync(pathTxt)) {
    writePathTxt();
    console.log('[electron] Ready:', path.join(distDir, platformPath));
    return;
  }

  try {
    installElectronSync();
  } catch (err) {
    console.error('[electron] Install failed:', err.message);
    console.error('Coba: tutup semua app Electron, lalu:');
    if (process.platform === 'win32') {
      console.error('  Remove-Item -Recurse -Force node_modules\\electron\\dist');
    } else {
      console.error('  rm -rf node_modules/electron/dist node_modules/electron/path.txt');
    }
    console.error('  npm run ensure-electron');
    process.exit(1);
  }

  if (!isReady()) {
    console.error('[electron] path.txt atau binary masih hilang setelah install.');
    process.exit(1);
  }
}

main();
