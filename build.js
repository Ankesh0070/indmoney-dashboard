const fs = require('fs');
const path = require('path');

const root = __dirname;
const out = path.join(root, 'dist');

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });

for (const file of ['index.html', 'analytics_data.json']) {
  fs.copyFileSync(path.join(root, file), path.join(out, file));
}

console.log('Vercel static dashboard built in dist/');
