#!/usr/bin/env node
/**
 * Generate electron-updater manifests (latest.yml + latest-mac.yml) from release/ artifacts.
 * Usage: node scripts/generate-update-manifest.js [releaseDir]
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const releaseDir = path.resolve(process.argv[2] || 'release');
const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
const version = pkg.version;

function sha512(filePath) {
  const hash = crypto.createHash('sha512');
  hash.update(fs.readFileSync(filePath));
  return hash.digest('base64');
}

function findFile(re) {
  if (!fs.existsSync(releaseDir)) return null;
  return fs.readdirSync(releaseDir).find((f) => re.test(f)) || null;
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

const winExe = findFile(/Setup.*\.exe$/i) || findFile(/\.exe$/i);
const macZip = findFile(/\.zip$/i);
const macDmg = findFile(/\.dmg$/i);
const macFile = macZip || macDmg;

let ok = false;
if (winExe) ok = writeYml('latest.yml', winExe) || ok;
if (macFile) ok = writeYml('latest-mac.yml', macFile) || ok;

if (!ok) {
  console.error('No release artifacts found in', releaseDir);
  process.exit(1);
}
