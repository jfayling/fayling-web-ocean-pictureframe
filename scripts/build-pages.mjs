// Assembles the GitHub Pages site in _site/ from the committed sources:
//   _site/            docs/ (landing page, time lapse, screenshots, social preview)
//   _site/app/        ocean.min.html as index.html, plus media/ for the music track
//   node scripts/build-pages.mjs   (run `npm run build` first)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const site = path.join(root, '_site');
const app = path.join(site, 'app');

fs.rmSync(site, { recursive: true, force: true });
fs.cpSync(path.join(root, 'docs'), site, { recursive: true });
fs.mkdirSync(app, { recursive: true });
fs.copyFileSync(path.join(root, 'ocean.min.html'), path.join(app, 'index.html'));
fs.cpSync(path.join(root, 'media'), path.join(app, 'media'), { recursive: true });
fs.writeFileSync(path.join(site, '.nojekyll'), '');

let files = 0, bytes = 0;
const walk = (dir) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p); else { files++; bytes += fs.statSync(p).size; }
  }
};
walk(site);
console.log(`wrote _site/: ${files} files, ${(bytes / 1048576).toFixed(1)} MB`);
