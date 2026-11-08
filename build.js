const fs = require('fs');
const path = require('path');

const root = __dirname;
const out = path.join(root, 'dist');

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });

for (const file of ['index.html', 'analytics_data.json']) {
  fs.copyFileSync(path.join(root, file), path.join(out, file));
}

// Vercel serves index.html automatically at `/`. Keep a matching fallback so
// direct navigation never lands on a generic platform 404 page.
fs.copyFileSync(path.join(root, 'index.html'), path.join(out, '404.html'));

console.log('Vercel static dashboard built in dist/');
