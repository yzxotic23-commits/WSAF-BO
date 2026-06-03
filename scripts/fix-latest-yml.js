#!/usr/bin/env node
/**
 * Regenerate latest.yml from the actual .exe on disk (fixes name/hash mismatch).
 * Usage: node scripts/fix-latest-yml.js [releaseDir] [exeFileName]
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const releaseDir = path.resolve(process.argv[2] || 'release');
const version = process.argv[4] || require('../package.json').version;

function listSetupExes() {
  if (!fs.existsSync(releaseDir)) return [];
  return fs
    .readdirSync(releaseDir)
    .filter((f) => /\.exe$/i.test(f) && /setup/i.test(f));
}

let fileName = process.argv[3];
if (!fileName) {
  const candidates = listSetupExes();
  if (candidates.length === 0) {
    console.error(`[fix-latest-yml] No Setup .exe in ${releaseDir}`);
    process.exit(1);
  }
  fileName = candidates.sort((a, b) => fs.statSync(path.join(releaseDir, b)).size - fs.statSync(path.join(releaseDir, a)).size)[0];
}

const full = path.join(releaseDir, fileName);
if (!fs.existsSync(full)) {
  console.error(`[fix-latest-yml] Missing: ${full}`);
  process.exit(1);
}

const hash = crypto.createHash('sha512');
hash.update(fs.readFileSync(full));
const digest = hash.digest('base64');

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

const out = path.join(releaseDir, 'latest.yml');
fs.writeFileSync(out, yml, 'utf8');
console.log(`[ok] ${out}`);
console.log(`[ok] installer: ${fileName}`);
console.log(yml);
