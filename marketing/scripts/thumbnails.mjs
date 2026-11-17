// Thumbnails: a real frame from a captured clip with browser-rendered type on top.
//   node scripts/thumbnails.mjs [--format vertical]
import fs from 'node:fs';
import path from 'node:path';
import { launchBrowser } from './lib/browser.mjs';
import { buildDir, cliOptions, formatScenes, loadConfig, resolveOut, selectedFormats } from './lib/config.mjs';
import { ffmpeg } from './lib/ffmpeg.mjs';

const esc = (s) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

function page({ width, height, frame, font, colors, headline, sub, tag, vertical }) {
  const big = vertical ? 118 : 128;
  return `<!doctype html><html><head><style>
  html,body{margin:0;width:${width}px;height:${height}px;overflow:hidden;background:#000}
  body{background:url(data:image/png;base64,${frame}) center/cover;font-family:${font};color:#fff;
       -webkit-font-smoothing:antialiased}
  .shade{position:absolute;inset:0;background:
    radial-gradient(ellipse 80% 42% at 50% ${vertical ? 30 : 36}%, rgba(0,8,20,.58), rgba(0,8,20,0) 70%),
    linear-gradient(to bottom, rgba(0,6,16,.35), rgba(0,0,0,0) 40%, rgba(0,0,0,0) 75%, rgba(0,6,16,.45))}
  .wrap{position:absolute;left:0;right:0;top:${vertical ? 17 : 15}%;text-align:center;padding:0 6%;box-sizing:border-box}
  h1{margin:0;font-weight:800;font-size:${big}px;line-height:1.02;letter-spacing:.03em;white-space:pre;
     text-shadow:0 4px 24px rgba(0,0,0,.55),0 1px 3px rgba(0,0,0,.6)}
  h2{margin:${vertical ? 40 : 30}px 0 0;font-weight:800;font-size:${Math.round(big * 0.78)}px;letter-spacing:.12em;color:${colors.cyan};
     text-shadow:0 0 34px ${colors.cyan}aa,0 3px 16px rgba(0,0,0,.6)}
  .rule{display:block;margin:${vertical ? 34 : 26}px auto 0;width:${vertical ? 180 : 220}px;height:5px;border-radius:3px;background:${colors.cyan};
        box-shadow:0 0 18px ${colors.cyan}}
  .tag{position:absolute;left:0;right:0;bottom:${vertical ? 9 : 7}%;text-align:center;font-weight:700;
       font-size:${vertical ? 34 : 30}px;letter-spacing:.32em;color:rgba(255,255,255,.88);text-shadow:0 2px 10px rgba(0,0,0,.7)}
  </style></head><body><div class="shade"></div>
  <div class="wrap"><h1>${esc(headline)}</h1><h2>${esc(sub)}</h2><span class="rule"></span></div>
  <div class="tag">${esc(tag)}</div></body></html>`;
}

export async function thumbnails(config, formats) {
  const T = config.thumbnail;
  const browser = await launchBrowser(config, { headless: true });
  try {
    for (const format of formats) {
      const fmt = config.formats[format];
      const scene = formatScenes(config, format).find((s) => s.id === T.scene);
      const from = scene.source && scene.source !== format ? scene.source : format;
      const clip = path.join(buildDir(config, 'clips', from), `${scene.id}.mp4`);
      const still = path.join(buildDir(config, 'compose'), `thumb-${format}.png`);
      await ffmpeg(['-loglevel', 'error', '-ss', String(T.at), '-i', clip, '-frames:v', '1', still]);
      const vertical = fmt.height > fmt.width;
      const html = page({
        width: fmt.width, height: fmt.height, frame: fs.readFileSync(still).toString('base64'),
        font: config.titles.font, colors: config.titles.colors,
        headline: (vertical && T.verticalHeadline) || T.headline, sub: T.sub, tag: T.tag || '', vertical,
      });
      const p = await browser.newPage({ viewport: { width: fmt.width, height: fmt.height }, deviceScaleFactor: 1 });
      await p.setContent(html, { waitUntil: 'load' });
      await p.evaluate(() => document.fonts.ready);
      const out = resolveOut(fmt.thumbnail);
      fs.mkdirSync(path.dirname(out), { recursive: true });
      await p.screenshot({ path: out, type: 'jpeg', quality: 92 });
      await p.close();
      console.log(`${format}: ${path.relative(process.cwd(), out)} ${fmt.width}x${fmt.height}`);
    }
  } finally {
    await browser.close();
  }
}

if (process.argv[1]?.endsWith('thumbnails.mjs')) {
  const config = loadConfig();
  await thumbnails(config, selectedFormats(config, cliOptions()));
}
