#!/usr/bin/env node
/**
 * Generate electron-updater manifests from release/ artifacts.
 * Usage: node scripts/generate-update-manifest.js [releaseDir] [win|mac|all]
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const releaseDir = path.resolve(process.argv[2] || 'release');
const platform = (process.argv[3] || 'all').toLowerCase();
const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
const version = pkg.version;

function sha512(filePath) {
  const hash = crypto.createHash('sha512');
  hash.update(fs.readFileSync(filePath));
  return hash.digest('base64');
}

function listArtifacts() {
  if (!fs.existsSync(releaseDir)) return [];
  return fs.readdirSync(releaseDir).filter((f) => !f.startsWith('.'));
}

function findFile(re) {
  const files = listArtifacts();
  return files.find((f) => re.test(f)) || null;
}

function writeYml(name, fileName) {
  const full = path.join(releaseDir, fileName);
  if (!fs.existsSync(full)) {
    console.warn(`[skip] ${name}: ${fileName} not found`);
    return false;
  }
  const digest = sha512(full);
  const yml = [
    `version: ${version}`,
    'files:',
    `  - url: ${fileName}`,
    `    sha512: ${digest}`,
    `path: ${fileName}`,
    `sha512: ${digest}`,
    `releaseDate: '${new Date().toISOString()}'`,
    '',
  ].join('\n');
  const out = path.join(releaseDir, name);
  fs.writeFileSync(out, yml, 'utf8');
  console.log(`[ok] ${out}`);
  return true;
}

function pickWinSetupExe() {
  const setups = listArtifacts().filter((f) => /\.exe$/i.test(f) && /setup/i.test(f));
  if (setups.length === 0) return findFile(/\.exe$/i);
  return setups.sort(
    (a, b) => fs.statSync(path.join(releaseDir, b)).size - fs.statSync(path.join(releaseDir, a)).size
  )[0];
}

const winExe = pickWinSetupExe();

function findMacZip() {
  const zips = listArtifacts().filter((f) => /\.zip$/i.test(f) && !/uninstaller/i.test(f));
  const macZips = zips.filter((f) => /arm64-mac|arm64\.mac|mac|arm64|darwin/i.test(f));
  const pool = macZips.length ? macZips : zips;
  if (pool.length === 0) return null;

  const dotted = pool.filter((f) => /^WhatsApp\.Auto\.Feeding-/i.test(f));
  const ranked = (dotted.length ? dotted : pool).sort(
    (a, b) => fs.statSync(path.join(releaseDir, b)).size - fs.statSync(path.join(releaseDir, a)).size
  );
  const picked = ranked[0];
  if (!fs.existsSync(path.join(releaseDir, picked))) return null;
  return picked;
}

const macZip = findMacZip();
const macDmg = findFile(/\.dmg$/i);
const macFile = macZip || macDmg;

let ok = false;

if (platform === 'win' || platform === 'all') {
  if (winExe) ok = writeYml('latest.yml', winExe) || ok;
}

if (platform === 'mac' || platform === 'all') {
  if (macFile) ok = writeYml('latest-mac.yml', macFile) || ok;
}

if (platform === 'mac' || platform === 'all') {
  const ymlPath = path.join(releaseDir, 'latest-mac.yml');
  if (fs.existsSync(ymlPath)) {
    const ymlText = fs.readFileSync(ymlPath, 'utf8');
    const pathMatch = ymlText.match(/^path:\s*(.+)$/m);
    const installer = pathMatch?.[1]?.trim();
    if (installer && !fs.existsSync(path.join(releaseDir, installer))) {
      console.error(`[manifest] latest-mac.yml path not on disk: ${installer}`);
      console.error('[manifest] Files:', listArtifacts().join(', ') || '(empty)');
      process.exit(1);
    }
  }
}

if (!ok) {
  console.error(`[manifest] No ${platform} artifacts in ${releaseDir}`);
  console.error('[manifest] Files:', listArtifacts().join(', ') || '(empty)');
  process.exit(1);
}

if (platform === 'win' || platform === 'all') {
  const ymlPath = path.join(releaseDir, 'latest.yml');
  const ymlText = fs.readFileSync(ymlPath, 'utf8');
  const pathMatch = ymlText.match(/^path:\s*(.+)$/m);
  const installer = pathMatch?.[1]?.trim();
  if (installer && !fs.existsSync(path.join(releaseDir, installer))) {
    console.error(`[manifest] latest.yml path not on disk: ${installer}`);
    process.exit(1);
  }
}
