#!/usr/bin/env node
/**
 * Verify GitHub (or generic) update feed: latest.yml + installer URL reachable.
 * Usage: node scripts/verify-update-feed.js [feedUrl]
 */
const https = require('https');

const feed = (process.argv[2] || process.env.APP_UPDATE_URL || 'https://github.com/yzxotic23-commits/WSAF-BO/releases/latest/download/').replace(/\/?$/, '/');

function get(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'FeedFlow-Verify' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        get(res.headers.location).then(resolve).catch(reject);
        return;
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
  });
}

function head(url) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, { method: 'HEAD', headers: { 'User-Agent': 'FeedFlow-Verify' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        head(res.headers.location).then(resolve).catch(reject);
        return;
      }
      resolve(res.statusCode);
    });
    req.on('error', reject);
    req.end();
  });
}

function parseYml(text) {
  const pathMatch = text.match(/^path:\s*(.+)$/m);
  const versionMatch = text.match(/^version:\s*(.+)$/m);
  return {
    version: versionMatch?.[1]?.trim(),
    path: pathMatch?.[1]?.trim(),
  };
}

(async () => {
  console.log('[verify] feed:', feed);
  const ymlRes = await get(feed + 'latest.yml');
  if (ymlRes.status !== 200) {
    console.error('[verify] latest.yml HTTP', ymlRes.status);
    process.exit(1);
  }
  const yml = ymlRes.body.toString('utf8');
  const meta = parseYml(yml);
  console.log('[verify] version:', meta.version);
  console.log('[verify] path:', meta.path);
  if (!meta.path) {
    console.error('[verify] path: missing in latest.yml');
    process.exit(1);
  }
  const exeUrl = feed + encodeURIComponent(meta.path).replace(/%20/g, '%20');
  const status = await head(exeUrl);
  if (status !== 200) {
    console.error('[verify] installer HTTP', status, '—', meta.path);
    console.error('[verify] FIX: regenerate latest.yml from the real .exe filename on the release.');
    process.exit(1);
  }
  console.log('[verify] installer OK (200)');
  console.log('[verify] Feed is valid for electron-updater.');
})().catch((e) => {
  console.error('[verify]', e.message);
  process.exit(1);
});
