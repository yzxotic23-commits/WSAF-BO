#!/usr/bin/env node
/**
 * Regenerate latest-mac.yml from the actual .zip on disk (fixes name/hash mismatch).
 * Usage: node scripts/fix-latest-mac-yml.js [releaseDir] [zipFileName]
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const releaseDir = path.resolve(process.argv[2] || 'release');
const version = process.argv[4] || require('../package.json').version;

function listMacZips() {
  if (!fs.existsSync(releaseDir)) return [];
  return fs
    .readdirSync(releaseDir)
    .filter((f) => /\.zip$/i.test(f) && /arm64-mac|arm64\.mac/i.test(f));
}

let fileName = process.argv[3];
if (!fileName) {
  const candidates = listMacZips();
  if (candidates.length === 0) {
    console.error(`[fix-latest-mac-yml] No arm64-mac .zip in ${releaseDir}`);
    process.exit(1);
  }
  fileName = candidates.sort(
    (a, b) => fs.statSync(path.join(releaseDir, b)).size - fs.statSync(path.join(releaseDir, a)).size
  )[0];
}

const full = path.join(releaseDir, fileName);
if (!fs.existsSync(full)) {
  console.error(`[fix-latest-mac-yml] Missing: ${full}`);
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

const out = path.join(releaseDir, 'latest-mac.yml');
fs.writeFileSync(out, yml, 'utf8');
console.log(`[ok] ${out}`);
console.log(`[ok] zip: ${fileName}`);
