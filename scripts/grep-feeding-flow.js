const fs = require('fs');
const js = fs.readFileSync('client/dist/assets/index-CbZz9OZp.js', 'utf8');
const terms = [
  'Start feeding',
  'Stop feeding',
  'Ready for feeding',
  'feedingRunning',
  'feedingStarting',
  'Continue',
  'Clear all sessions',
  'feeding/stop',
  'feeding/start',
  'allReadyForFeeding',
  'wa-feeding-launch',
  'Done',
  'finished',
];
for (const t of terms) {
  let idx = 0;
  let c = 0;
  while ((idx = js.indexOf(t, idx + 1)) !== -1 && c < 2) {
    console.log('\n=== ' + t + ' @ ' + idx + ' ===');
    console.log(js.slice(Math.max(0, idx - 100), idx + 220).replace(/\s+/g, ' '));
    c++;
  }
}
