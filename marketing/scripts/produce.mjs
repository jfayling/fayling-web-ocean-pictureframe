// Full pipeline: capture -> titles -> compose -> thumbnails -> validate.
//   node scripts/produce.mjs [--format landscape] [--force] [--skip-capture]
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cliOptions } from './lib/config.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const opts = cliOptions();
const pass = [];
if (opts.formats.length) pass.push('--format', opts.formats.join(','));

const steps = [
  ...(opts['skip-capture'] ? [] : [['capture.mjs', ...pass, ...(opts.force ? ['--force'] : [])]]),
  ['titles.mjs', ...pass],
  ['compose.mjs', ...pass],
  ['thumbnails.mjs', ...pass],
  ['validate.mjs', ...pass],
];
const t0 = Date.now();
for (const [script, ...args] of steps) {
  console.log(`\n=== ${script} ${args.join(' ')}`);
  const r = spawnSync(process.execPath, [path.join(here, script), ...args], { stdio: 'inherit' });
  if (r.status !== 0) {
    console.error(`${script} failed (exit ${r.status})`);
    process.exit(r.status || 1);
  }
}
console.log(`\nDone in ${((Date.now() - t0) / 60000).toFixed(1)} min.`);
