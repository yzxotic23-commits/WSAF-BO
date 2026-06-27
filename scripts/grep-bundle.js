const fs = require('fs');
const js = fs.readFileSync('client/dist/assets/index-CbZz9OZp.js', 'utf8');
const patterns = ['api/update', 'on("update"', "on('update'", 'update/check', 'socket.io', 'io('];
for (const p of patterns) {
  let idx = 0;
  let count = 0;
  while ((idx = js.indexOf(p, idx + 1)) !== -1 && count < 3) {
    console.log(`\n=== ${p} @ ${idx} ===`);
    console.log(js.slice(Math.max(0, idx - 100), idx + 200).replace(/\s+/g, ' '));
    count++;
  }
}
