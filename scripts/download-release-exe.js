#!/usr/bin/env node
/** Download Windows installer from a GitHub release tag. */
const fs = require('fs');
const https = require('https');
const path = require('path');

const tag = process.argv[2] || 'v1.0.21';
const file =
  process.argv[3] || 'WhatsApp.Auto.Feeding.Setup.1.0.21.exe';
const outDir = path.resolve(process.argv[4] || 'release-build');
const out = path.join(outDir, file);
const url = `https://github.com/yzxotic23-commits/WSAF-BO/releases/download/${tag}/${encodeURIComponent(file)}`;

if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

function get(target, redirects = 0) {
  return new Promise((resolve, reject) => {
    https
      .get(target, { headers: { 'User-Agent': 'FeedFlow-Download' } }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          if (redirects > 8) return reject(new Error('Too many redirects'));
          get(res.headers.location, redirects + 1).then(resolve).catch(reject);
          return;
        }
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode} for ${target}`));
          return;
        }
        const fileStream = fs.createWriteStream(out);
        res.pipe(fileStream);
        fileStream.on('finish', () => fileStream.close(resolve));
        fileStream.on('error', reject);
      })
      .on('error', reject);
  });
}

console.log('[download]', url);
get(url)
  .then(() => console.log('[ok]', out))
  .catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
