const fs = require('fs');
const c = fs.readFileSync('extension/content.js', 'utf8');
const i = c.indexOf('style.textContent = ');
console.log(JSON.stringify(c.slice(i, i + 200)));
