/**
 * Web mode entry point — runs FeedFlow as a plain web server (no Electron).
 * Open http://localhost:47821 in your browser after starting.
 *
 * Usage:  node web.js
 *   or:   npm run web
 */
const path = require('path');
const { ensureAppRoot, getAppRoot } = require('./src/app-root');
ensureAppRoot();
require('./src/silence-deprecation-warnings');
require('dotenv').config({ path: path.join(getAppRoot(), '.env') });
require('./src/silence-libsignal-logs');

if (process.env.AI_SDK_LOG_WARNINGS === undefined) {
  process.env.AI_SDK_LOG_WARNINGS = 'false';
}

// Enable desktop feeding events so the UI receives live updates
process.env.DESKTOP_FEEDING = '1';

const { createDesktopApi } = require('./server/desktop-api');

const PORT = parseInt(process.env.DESKTOP_API_PORT || '47821', 10);

// Bind to all interfaces in web mode so LAN access works
const api = createDesktopApi({ host: '0.0.0.0' });

api.start().then(() => {
  console.log('');
  console.log('  FeedFlow — Web Mode');
  console.log(`  App (unified): http://localhost:${PORT}/`);
  console.log(`  Dev UI:        http://localhost:5173  (npm run dev:ui + npm run dev:api)`);
  console.log('');
});
