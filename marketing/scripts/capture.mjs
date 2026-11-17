// Captures every scene of the storyboard from the real WebGPU app, one clip per scene.
//
//   node scripts/capture.mjs                          all formats, all scenes (cached clips are kept)
//   node scripts/capture.mjs --format vertical --scene sky --force
//   node scripts/capture.mjs --scene hook --stills 0,2,4   save preview stills only
//
// Output: build/clips/<format>/<scene>.mp4, <scene>.wav and <scene>.json
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { launchBrowser } from './lib/browser.mjs';
import { buildDir, cliOptions, formatScenes, loadConfig, selectedFormats, timeline } from './lib/config.mjs';
import { frameEncoder } from './lib/ffmpeg.mjs';
import { openScene } from './lib/session.mjs';
import { startServer } from './lib/server.mjs';
import { assertHardwareAdapter, probeAdapter } from './probe-webgpu.mjs';

const config = loadConfig();
const opts = cliOptions();
const stills = typeof opts.stills === 'string' ? opts.stills.split(',').map(Number) : null;

function sceneHash(config, format, scene) {
  const relevant = {
    fmt: config.formats[format], capture: { ...config.capture }, defaults: config.app.defaults, audio: config.audio,
    scene: { ...scene, titles: undefined },
  };
  delete relevant.capture.headless;
  return crypto.createHash('sha1').update(JSON.stringify(relevant)).digest('hex').slice(0, 12);
}

function rampValue(r, t) {
  const k = Math.max(0, Math.min(1, (t - r.start) / Math.max(1e-6, r.end - r.start)));
  const e = k * k * (3 - 2 * k);
  return r.from + (r.to - r.from) * e;
}

async function captureScene(browser, server, format, scene, outDir, log) {
  const fps = config.formats[format].fps;
  if (stills) {
    for (const f of fs.readdirSync(outDir)) if (f.startsWith(scene.id + '@')) fs.unlinkSync(path.join(outDir, f));
  }
  const s = await openScene(browser, server, config, format, scene, { log });
  try {
    const info = await probeAdapter(s.page);
    assertHardwareAdapter(info);
    for (const r of scene.ramps || []) await s.setSetting(r.key, r.from);
    await s.warmup();
    const audioStart = await s.audioTime();
    const frames = Math.round(scene.clipDuration * fps);
    const stillFrames = stills ? new Map(stills.map((t) => [Math.min(frames - 1, Math.round(t * fps)), t])) : null;
    const clip = path.join(outDir, `${scene.id}.mp4`);
    const enc = stills ? null : frameEncoder(clip + '.part.mp4', { fps, crf: config.capture.intermediateCrf });
    const actions = (scene.actions || []).map((a) => ({ ...a, done: false }));
    const t0 = Date.now();
    try {
      for (let i = 0; i < frames; i++) {
        const t = i / fps;
        if (i === 0) for (const k of scene.camera?.hold || []) await s.key(k, true);
        for (const r of scene.ramps || []) if (t >= r.start && t <= r.end + 1 / fps) await s.setSetting(r.key, +rampValue(r, t).toFixed(3));
        const pan = scene.camera?.pan;
        if (pan && t >= (pan.start ?? 0) && t < (pan.end ?? Infinity)) await s.look(pan.x || 0, pan.y || 0);
        else if (pan && t >= (pan.end ?? Infinity)) await s.endLook();
        for (const a of actions) {
          if (a.done || t < a.at) continue;
          a.done = true;
          for (const [k, v] of Object.entries(a.set || {})) await s.setSetting(k, v);
        }
        await s.step(1);
        if (stillFrames && i > Math.max(...stillFrames.keys())) break;
        if (stillFrames && !stillFrames.has(i)) continue;
        const img = await s.grab();
        if (enc) await enc.write(img);
        else fs.writeFileSync(path.join(outDir, `${scene.id}@${stillFrames.get(i)}s.jpg`), img);
        if (i % (fps * 2) === 0) log(`  ${scene.id} frame ${i}/${frames} (${((Date.now() - t0) / 1000).toFixed(0)}s)`);
      }
    } catch (e) {
      enc?.kill();
      throw e;
    }
    if (s.errors.length) log(`  page reported: ${s.errors.slice(0, 5).join(' | ')}`);
    if (stills) return null;
    await enc.end();
    fs.renameSync(clip + '.part.mp4', clip);
    let audio = null;
    if (audioStart !== null) {
      audio = await s.takeAudio(audioStart, audioStart + frames / fps);
      if (audio) fs.writeFileSync(path.join(outDir, `${scene.id}.wav`), Buffer.from(audio.wav, 'base64'));
    }
    return {
      frames, fps, seconds: frames / fps, adapter: info,
      audio: audio ? { peak: audio.peak, sampleRate: audio.sampleRate, seconds: audio.seconds } : null,
      captureSeconds: (Date.now() - t0) / 1000, pageErrors: s.errors,
    };
  } finally {
    await s.close();
  }
}

const server = await startServer(config.capture.port);
let browser = await launchBrowser(config, { headless: opts.headed ? false : config.capture.headless });
const log = (m) => console.log(m);
try {
  for (const format of selectedFormats(config, opts)) {
    const outDir = buildDir(config, stills ? 'stills' : 'clips', format);
    const spans = Object.fromEntries(timeline(config).map((t) => [t.id, t]));
    for (const scene of formatScenes(config, format)) {
      if (opts.scenes.length && !opts.scenes.includes(scene.id)) continue;
      if (scene.source && scene.source !== format) { log(`${format}/${scene.id}: uses the ${scene.source} clip`); continue; }
      const full = { ...scene, clipDuration: spans[scene.id].clipDuration };
      const hash = sceneHash(config, format, full);
      const metaFile = path.join(outDir, `${scene.id}.json`);
      if (!stills && !opts.force && fs.existsSync(metaFile) && JSON.parse(fs.readFileSync(metaFile, 'utf8')).hash === hash
          && fs.existsSync(path.join(outDir, `${scene.id}.mp4`))) {
        log(`${format}/${scene.id}: up to date`);
        continue;
      }
      log(`${format}/${scene.id}: capturing ${full.clipDuration}s at ${config.formats[format].fps} fps`);
      for (let attempt = 0; ; attempt++) {
        try {
          const meta = await captureScene(browser, server, format, full, outDir, log);
          if (meta) {
            fs.writeFileSync(metaFile, JSON.stringify({ hash, ...meta }, null, 2));
            log(`${format}/${scene.id}: ${meta.frames} frames in ${meta.captureSeconds.toFixed(0)}s, audio peak ${meta.audio?.peak?.toFixed(3) ?? 'none'}`);
          }
          break;
        } catch (e) {
          log(`${format}/${scene.id}: attempt ${attempt + 1} failed: ${e.message}`);
          if (attempt >= (config.capture.retries ?? 2)) throw e;
          // A crashed renderer or lost device usually needs a fresh browser.
          await browser.close().catch(() => {});
          browser = await launchBrowser(config, { headless: opts.headed ? false : config.capture.headless });
        }
      }
    }
  }
} finally {
  await browser.close().catch(() => {});
  server.stop();
}
