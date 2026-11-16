// Dependency-free repository checks, run in CI after `npm run build`:
//   - the standalone bundles are self-contained (no module script tags left)
//   - relative links and images in the Markdown files resolve, including #anchors
//   - local references in the GitHub Pages landing page resolve
//   node scripts/check.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const errors = [];
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const exists = (p) => fs.existsSync(path.join(root, p));

for (const bundle of ['ocean.html', 'ocean.min.html']) {
  if (!exists(bundle)) { errors.push(`${bundle} is missing; run npm run build`); continue; }
  const html = read(bundle);
  if (/<script[^>]+src=/.test(html)) errors.push(`${bundle} still loads an external script`);
  if (!html.includes('navigator.gpu')) errors.push(`${bundle} does not contain the renderer`);
}

const slug = (h) => h.trim().toLowerCase().replace(/<[^>]+>/g, '').replace(/[^\p{L}\p{N}\s_-]/gu, '').replace(/\s/g, '-');
const anchorsOf = (md) => {
  const seen = new Map();
  const out = new Set();
  for (const m of md.replace(/```[\s\S]*?```/g, '').matchAll(/^#{1,6}\s+(.+)$/gm)) {
    const base = slug(m[1]);
    const n = seen.get(base) || 0;
    seen.set(base, n + 1);
    out.add(n ? `${base}-${n}` : base);
  }
  return out;
};

const markdown = ['README.md', 'CONTRIBUTING.md', 'CHANGELOG.md', 'docs/BROWSER_SUPPORT.md',
  '.github/PULL_REQUEST_TEMPLATE.md'].filter(exists);
for (const file of markdown) {
  const md = read(file);
  const body = md.replace(/```[\s\S]*?```/g, '');
  const targets = [...body.matchAll(/\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g), ...body.matchAll(/(?:src|href)="([^"]+)"/g)].map((m) => m[1]);
  for (const t of targets) {
    if (/^(https?:|mailto:)/.test(t)) continue;
    const [p, anchor] = t.split('#');
    const target = p ? path.posix.join(path.posix.dirname(file), p) : file;
    if (!exists(target)) { errors.push(`${file}: link target ${t} does not exist`); continue; }
    if (anchor && target.endsWith('.md') && !anchorsOf(read(target)).has(anchor)) errors.push(`${file}: anchor #${anchor} not found in ${target}`);
  }
}

const landing = read('docs/index.html');
for (const m of landing.matchAll(/(?:src|href|poster)="([^"]+)"|url\(([^)]+)\)/g)) {
  const t = m[1] || m[2];
  if (/^(https?:|#|mailto:)/.test(t) || t === 'app/') continue;
  if (!exists(path.posix.join('docs', t))) errors.push(`docs/index.html: ${t} does not exist`);
}

if (errors.length) {
  for (const e of errors) console.error('✗ ' + e);
  process.exit(1);
}
console.log(`ok: bundles self-contained, ${markdown.length} Markdown files and the Pages landing page have no broken local links`);
