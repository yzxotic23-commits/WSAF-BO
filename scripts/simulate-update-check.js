#!/usr/bin/env node
/**
 * Simulate electron-updater generic feed check (no Electron required).
 */
const https = require('https');
const current = process.argv[2] || '1.0.19';

function gt(a, b) {
  const pa = String(a).split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b).split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    if ((pa[i] || 0) > (pb[i] || 0)) return true;
    if ((pa[i] || 0) < (pb[i] || 0)) return false;
  }
  return false;
}
const feed = (process.argv[3] || process.env.APP_UPDATE_URL || 'https://github.com/yzxotic23-commits/WSAF-BO/releases/latest/download/').replace(/\/?$/, '/');

function get(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'FeedFlow-Sim' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        get(res.headers.location).then(resolve).catch(reject);
        return;
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks) }));
    }).on('error', reject);
  });
}

function parseYml(text) {
  const version = text.match(/^version:\s*(.+)$/m)?.[1]?.trim();
  const path = text.match(/^path:\s*(.+)$/m)?.[1]?.trim();
  return { version, path };
}

(async () => {
  console.log('[sim] current:', current);
  console.log('[sim] feed:', feed);
  const yml = await get(feed + 'latest.yml');
  if (yml.status !== 200) {
    console.error('[sim] latest.yml HTTP', yml.status);
    process.exit(1);
  }
  const meta = parseYml(yml.body.toString('utf8'));
  console.log('[sim] remote version:', meta.version);
  console.log('[sim] installer:', meta.path);
  const cmp = gt(meta.version, current);
  console.log('[sim] update available:', cmp);
  if (meta.path) {
    const exe = await get(feed + encodeURIComponent(meta.path));
    console.log('[sim] installer HTTP:', exe.status);
  }
})().catch((e) => {
  console.error('[sim]', e.message);
  process.exit(1);
});
