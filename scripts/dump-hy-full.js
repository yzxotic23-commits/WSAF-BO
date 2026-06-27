const fs = require('fs');
const js = fs.readFileSync('client/dist/assets/index-CbZz9OZp.js', 'utf8');
const i = js.indexOf('function hy(');
console.log(js.slice(i, i + 12000));
