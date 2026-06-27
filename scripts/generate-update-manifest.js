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

function resolveArtifactFileName(fileName) {
  const full = path.join(releaseDir, fileName);
  if (fs.existsSync(full)) return fileName;
  const dotted = fileName.replace(/ /g, '.');
  if (dotted !== fileName && fs.existsSync(path.join(releaseDir, dotted))) {
    return dotted;
  }
  return fileName;
}

function writeYml(name, fileName) {
  const resolvedName = resolveArtifactFileName(fileName);
  const full = path.join(releaseDir, resolvedName);
  if (!fs.existsSync(full)) {
    console.warn(`[skip] ${name}: ${fileName} not found`);
    return false;
  }
  fileName = resolvedName;
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

const winExe =
  findFile(/Setup.*\.exe$/i) ||
  findFile(/\.exe$/i);

function findMacZip() {
  const zips = listArtifacts().filter((f) => /\.zip$/i.test(f));
  return (
    zips.find((f) => /mac|arm64|darwin/i.test(f)) ||
    zips.find((f) => !/uninstaller/i.test(f)) ||
    zips[0] ||
    null
  );
}

const macZip = findMacZip();
const macDmg = findFile(/\.dmg$/i);
// Mac auto-update installs from ZIP only (DMG is for manual install fallback).
const macFile = macZip;
if (!macZip && macDmg) {
  console.warn('[warn] macOS DMG found but no ZIP — latest-mac.yml requires ZIP for in-app update');
}

let ok = false;

if (platform === 'win' || platform === 'all') {
  if (winExe) ok = writeYml('latest.yml', winExe) || ok;
}

if (platform === 'mac' || platform === 'all') {
  if (macFile) ok = writeYml('latest-mac.yml', macFile) || ok;
}

if (!ok) {
  console.error(`[manifest] No ${platform} artifacts in ${releaseDir}`);
  console.error('[manifest] Files:', listArtifacts().join(', ') || '(empty)');
  process.exit(1);
}
