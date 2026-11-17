// Opens one scene of the real app in a fresh browser context and steps it frame by frame.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MARKETING_DIR, REPO_DIR, resolveOut } from './config.mjs';

const HARNESS = path.join(path.dirname(fileURLToPath(import.meta.url)), 'page-harness.js');
const NET_HOSTS = /(^|\.)(open-meteo\.com|zippopotam\.us|weather\.gov)$/i;

// Setting key -> panel label, read from the app's own settings table so runtime changes go
// through the same inputs a viewer would use.
let labelCache = null;
export function settingLabels() {
  if (labelCache) return labelCache;
  const src = fs.readFileSync(path.join(REPO_DIR, 'js', 'main.js'), 'utf8');
  labelCache = {};
  for (const m of src.matchAll(/\['(\w+)', '([^']+)', (?:'(toggle|select)'|-?[\d.]+)/g)) {
    if (!labelCache[m[1]]) labelCache[m[1]] = { label: m[2], kind: m[3] || 'range' };
  }
  return labelCache;
}

function localStamp(value) {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value || '') ? value : null;
}

// Shift a YYYY-MM-DDTHH:MM wall-clock value by minutes without timezone math.
function shiftLocal(value, minutes) {
  const [d, t] = value.split('T');
  const [Y, M, D] = d.split('-').map(Number);
  const [h, m] = t.split(':').map(Number);
  const u = new Date(Date.UTC(Y, M - 1, D, h, m) + Math.round(minutes) * 60000);
  const p = (n) => String(n).padStart(2, '0');
  return `${u.getUTCFullYear()}-${p(u.getUTCMonth() + 1)}-${p(u.getUTCDate())}T${p(u.getUTCHours())}:${p(u.getUTCMinutes())}`;
}

export function sceneUrl(base, config, format, scene) {
  const fmt = config.formats[format];
  const app = { ...config.app.defaults, ...(scene.app || {}) };
  const warm = scene.warmup ?? config.capture.warmupSeconds;
  // The lapse also runs during warm-up, so start it early by that much sky time.
  if (app.skyMode === 'lapse' && localStamp(app.skyLapseStart)) {
    app.skyLapseStart = shiftLocal(app.skyLapseStart, -warm * (Number(app.lapsePace) || 20));
  }
  const q = new URLSearchParams();
  q.set('w', fmt.width);
  q.set('h', fmt.height);
  const cam = scene.camera || {};
  if (cam.position || cam.yaw !== undefined || cam.pitch !== undefined) {
    const [x, y, z] = cam.position || [0, 2.4, 0];
    q.set('cam', [x, y, z, cam.yaw ?? 0, cam.pitch ?? -5.5].join(','));
  }
  if (cam.fov) q.set('fov', cam.fov);
  for (const [k, v] of Object.entries(app)) q.set(k, String(v));
  return `${base}${config.app.page || 'index.html'}?${q}`;
}

function fixturePath(config, url, method) {
  const u = new URL(url);
  const key = crypto.createHash('sha1').update(method + ' ' + url).digest('hex').slice(0, 16);
  return path.join(resolveOut(config.paths.fixtures), `${u.hostname}-${key}.json`);
}

async function routeNetwork(context, config, log) {
  const mode = config.capture.network || 'auto';
  await context.route((url) => NET_HOSTS.test(url.hostname), async (route) => {
    const req = route.request();
    const file = fixturePath(config, req.url(), req.method());
    const cors = { 'access-control-allow-origin': '*' };
    if (mode !== 'live' && fs.existsSync(file)) {
      const f = JSON.parse(fs.readFileSync(file, 'utf8'));
      return route.fulfill({ status: f.status, headers: { 'content-type': f.contentType, ...cors }, body: f.body });
    }
    if (mode === 'replay') {
      log(`no fixture for ${req.url()}`);
      return route.abort();
    }
    try {
      const res = await route.fetch();
      const body = await res.text();
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify({
        url: req.url(), status: res.status(), contentType: res.headers()['content-type'] || 'application/json',
        fetchedAt: new Date().toISOString(), body,
      }, null, 1));
      log(`recorded ${req.url()}`);
      return route.fulfill({ status: res.status(), headers: { 'content-type': res.headers()['content-type'] || 'application/json', ...cors }, body });
    } catch (e) {
      log(`network failed for ${req.url()}: ${e.message}`);
      return route.abort();
    }
  });
}

export async function openScene(browser, server, config, format, scene, { log = console.log } = {}) {
  const fmt = config.formats[format];
  const fps = fmt.fps;
  const warm = scene.warmup ?? config.capture.warmupSeconds;
  const audio = config.audio.enabled && scene.audio !== false
    ? { sampleRate: config.audio.sampleRate, seconds: warm + scene.clipDuration + 2 }
    : null;
  // uiScale enlarges the page's HTML widgets like a TV's display scaling. The WebGPU canvas
  // still renders at the full output size because w/h are forced in the URL.
  const uiScale = scene.uiScale || 1;
  const context = await browser.newContext({
    viewport: { width: Math.round(fmt.width / uiScale), height: Math.round(fmt.height / uiScale) },
    deviceScaleFactor: uiScale,
    timezoneId: config.capture.timezone,
    locale: config.capture.locale || 'en-US',
  });
  await routeNetwork(context, config, log);
  const capture = { seed: scene.seed ?? config.capture.seed, fps, audio, dateLocal: scene.clock || null };
  await context.addInitScript(`window.__CAPTURE__ = ${JSON.stringify(capture)};
    if (window.__CAPTURE__.dateLocal) window.__CAPTURE__.dateMs = new Date(window.__CAPTURE__.dateLocal).getTime();`);
  await context.addInitScript({ path: HARNESS });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  const url = sceneUrl(server.base, config, format, { ...scene, warmup: warm });
  log(`open ${url}`);
  await page.goto(url, { waitUntil: 'load' });
  await page.waitForFunction(() => {
    const err = document.getElementById('err');
    if (err && err.style.display === 'block') return true;
    const l = document.getElementById('loading');
    return !l || l.classList.contains('done');
  }, null, { timeout: 120000 });
  const fatal = await page.evaluate(() => {
    const err = document.getElementById('err');
    return err && err.style.display === 'block' ? err.textContent : null;
  });
  if (fatal) throw new Error('app failed to start: ' + fatal);
  await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
  // The loading veil fades out on real time.
  await page.waitForFunction(() => !document.getElementById('loading'), null, { timeout: 10000 }).catch(() => {});
  await page.waitForTimeout(config.capture.settleMs ?? 800);
  await page.evaluate(() => window.__cap.hold());

  const cdp = await context.newCDPSession(page);
  const session = {
    page, context, cdp, fps, errors, audio,
    async step(n = 1) { await page.evaluate((k) => window.__cap.step(k), n); },
    async warmup() {
      const total = Math.round(warm * fps);
      for (let i = 0; i < total; i += 30) await session.step(Math.min(30, total - i));
    },
    async grab() {
      await page.evaluate(() => window.__cap.presented());
      const shot = await cdp.send('Page.captureScreenshot', {
        format: config.capture.imageFormat || 'jpeg',
        quality: config.capture.jpegQuality ?? 95,
        optimizeForSpeed: true,
        captureBeyondViewport: false,
        // Headless screenshots default to CSS pixels; ask for device pixels explicitly.
        ...(uiScale !== 1 ? { clip: { x: 0, y: 0, width: fmt.width / uiScale, height: fmt.height / uiScale, scale: uiScale } } : {}),
      });
      return Buffer.from(shot.data, 'base64');
    },
    async audioTime() { return page.evaluate(() => window.__cap.audioTime()); },
    async takeAudio(start, end) { return page.evaluate(([a, b]) => window.__cap.takeAudio(a, b), [start, end]); },
    async setSetting(key, value) {
      const meta = settingLabels()[key];
      if (!meta) throw new Error(`unknown setting for runtime change: ${key}`);
      const ok = await page.evaluate(({ label, kind, value }) => {
        for (const row of document.querySelectorAll('#panel label')) {
          const span = row.querySelector(':scope > span');
          if (!span || span.textContent !== label) continue;
          const input = row.querySelector(kind === 'select' ? 'select' : 'input');
          if (!input) continue;
          if (kind === 'toggle') { input.checked = Boolean(value); input.dispatchEvent(new Event('change')); }
          else if (kind === 'select') { input.value = String(value); input.dispatchEvent(new Event('change')); }
          else { input.value = String(value); input.dispatchEvent(new Event('input')); }
          return true;
        }
        return false;
      }, { ...meta, value });
      if (!ok) throw new Error(`no panel control labelled "${meta.label}" for ${key}`);
    },
    // Drag-to-look with the left button, as a viewer would. Chrome rounds movement to whole
    // pixels; the app turns 0.0022 rad (0.126°) per pixel.
    async look(dx, dy) {
      await page.evaluate(([x, y]) => {
        const c = document.getElementById('c');
        if (!window.__capLooking) {
          c.dispatchEvent(new MouseEvent('mousedown', { button: 0, buttons: 1, bubbles: true, cancelable: true }));
          window.__capLooking = true;
        }
        dispatchEvent(new MouseEvent('mousemove', { movementX: x, movementY: y, buttons: 1, bubbles: true }));
      }, [dx, dy]);
    },
    async endLook() {
      await page.evaluate(() => {
        if (!window.__capLooking) return;
        dispatchEvent(new MouseEvent('mouseup', { button: 0, buttons: 0, bubbles: true }));
        window.__capLooking = false;
      });
    },
    async key(code, down) {
      await page.evaluate(([c, d]) => dispatchEvent(new KeyboardEvent(d ? 'keydown' : 'keyup', { code: c, key: c, bubbles: true })), [code, down]);
    },
    async close() { await context.close(); },
  };
  return session;
}

export { MARKETING_DIR };
