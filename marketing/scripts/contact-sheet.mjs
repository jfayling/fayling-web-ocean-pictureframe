// Review helper: tiles preview stills or frames from a clip into one image.
//   node scripts/contact-sheet.mjs --format landscape --scene sky          stills from capture --stills
//   node scripts/contact-sheet.mjs --clip build/clips/landscape/sky.mp4 --at 0,1,2,3
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildDir, cliOptions, loadConfig, resolveOut } from './lib/config.mjs';
import { contactSheet, ffmpeg } from './lib/ffmpeg.mjs';

const config = loadConfig();
const opts = cliOptions();
const outDir = buildDir(config, 'review');

if (opts.clip) {
  const clip = resolveOut(opts.clip);
  const times = String(opts.at || '0,1,2,3').split(',').map(Number);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sheet-'));
  const frames = [];
  for (const t of times) {
    const f = path.join(tmp, `${t}.jpg`);
    await ffmpeg(['-loglevel', 'error', '-ss', String(t), '-i', clip, '-frames:v', '1', '-q:v', '2', f]);
    frames.push(f);
  }
  const out = path.join(outDir, `${path.basename(clip, '.mp4')}-sheet.jpg`);
  await contactSheet(frames, out, { cols: Number(opts.cols) || 3 });
  console.log(out);
} else {
  for (const format of opts.formats.length ? opts.formats : Object.keys(config.formats)) {
    const dir = buildDir(config, 'stills', format);
    for (const scene of opts.scenes.length ? opts.scenes : config.scenes.map((s) => s.id)) {
      const files = fs.readdirSync(dir).filter((f) => f.startsWith(scene + '@'))
        .sort((a, b) => parseFloat(a.split('@')[1]) - parseFloat(b.split('@')[1]))
        .map((f) => path.join(dir, f));
      if (!files.length) continue;
      const out = path.join(outDir, `${format}-${scene}-stills.jpg`);
      await contactSheet(files, out, { cols: Number(opts.cols) || 3 });
      console.log(out);
    }
  }
}
