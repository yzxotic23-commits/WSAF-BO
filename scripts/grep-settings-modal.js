const fs = require('fs');
const js = fs.readFileSync('client/dist/assets/index-CbZz9OZp.js', 'utf8');
const terms = [
  'wa-settings-overlay',
  'wa-settings-sheet',
  'wa-settings-modal',
  'wa-settings-backdrop',
  'wa-preferences',
  'getSettingsBundle',
  '/api/settings',
  'd(!1)',
  'onClose:()=>d(!1)',
  'function cy(',
  'function uy(',
  'function ly(',
  'function my(',
  'function ny(',
  'function oy(',
  'function py(',
  'function qy(',
  'function sy(',
];
for (const t of terms) {
  let idx = 0;
  let c = 0;
  while ((idx = js.indexOf(t, idx + 1)) !== -1 && c < 2) {
    console.log('\n=== ' + t + ' @ ' + idx + ' ===');
    console.log(js.slice(Math.max(0, idx - 120), idx + 280).replace(/\s+/g, ' '));
    c++;
  }
}
