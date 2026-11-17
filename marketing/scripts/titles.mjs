// Renders the title overlay as transparent PNG frames, one per video frame.
//   node scripts/titles.mjs [--format vertical] [--preview 1.2,3.0]
// Output: build/titles/<format>/f00000.png ...
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchBrowser } from './lib/browser.mjs';
import { buildDir, cliOptions, loadConfig, selectedFormats } from './lib/config.mjs';
import { titleRecords } from './lib/titles-data.mjs';

const TEMPLATE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'templates', 'titles.html');

export async function openTitles(browser, config, format) {
  const data = titleRecords(config, format);
  const page = await browser.newPage({ viewport: { width: data.width, height: data.height }, deviceScaleFactor: 1 });
  page.on('pageerror', (e) => console.error(`title page error: ${e.message}`));
  const html = fs.readFileSync(TEMPLATE, 'utf8')
    .replace('<script>', `<script>window.__TITLES__ = ${JSON.stringify(data)};</script>\n<script>`);
  await page.setContent(html, { waitUntil: 'load' });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForFunction(() => window.__ready === true);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 0 } });
  const shot = async () => Buffer.from((await cdp.send('Page.captureScreenshot', { format: 'png', optimizeForSpeed: true })).data, 'base64');
  return {
    page,
    data,
    async frame(t) {
      const visible = await page.evaluate((x) => window.renderAt(x), t);
      return visible ? shot() : null;
    },
    // Same encoder path as frame() so every PNG in the sequence has the same pixel format.
    async blank() {
      await page.evaluate(() => window.renderAt(-1));
      return shot();
    },
    close: () => page.close(),
  };
}

if (process.argv[1]?.endsWith('titles.mjs')) {
  const config = loadConfig();
  const opts = cliOptions();
  const browser = await launchBrowser(config, { headless: true });
  try {
    for (const format of selectedFormats(config, opts)) {
      const fps = config.formats[format].fps;
      const titles = await openTitles(browser, config, format);
      if (opts.preview) {
        const dir = buildDir(config, 'review');
        for (const t of String(opts.preview).split(',').map(Number)) {
          const img = await titles.frame(t);
          if (img) fs.writeFileSync(path.join(dir, `titles-${format}-${t}.png`), img);
        }
        await titles.close();
        continue;
      }
      const dir = buildDir(config, 'titles', format);
      for (const f of fs.readdirSync(dir)) fs.unlinkSync(path.join(dir, f));
      const total = Math.round(config.video.duration * fps);
      // Frames with no visible title share one blank image.
      const blank = path.join(dir, 'blank.png');
      fs.writeFileSync(blank, await titles.blank());
      const t0 = Date.now();
      let drawn = 0;
      for (let i = 0; i < total; i++) {
        const out = path.join(dir, `f${String(i).padStart(5, '0')}.png`);
        const img = await titles.frame(i / fps);
        if (img) { fs.writeFileSync(out, img); drawn++; } else fs.copyFileSync(blank, out);
      }
      console.log(`${format}: ${total} title frames (${drawn} with text) in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
      await titles.close();
    }
  } finally {
    await browser.close();
  }
}
