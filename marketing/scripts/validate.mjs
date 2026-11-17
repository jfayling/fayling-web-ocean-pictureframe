// Validates the finished videos and thumbnails and writes build/validation.json.
//   node scripts/validate.mjs [--format landscape]
// Exit code 1 when any hard check fails.
import fs from 'node:fs';
import path from 'node:path';
import { buildDir, cliOptions, formatScenes, loadConfig, resolveOut, selectedFormats, timeline } from './lib/config.mjs';
import { contactSheet, ffmpeg, probe } from './lib/ffmpeg.mjs';

const fraction = (s) => { const [a, b] = s.split('/').map(Number); return b ? a / b : a; };

function check(list, name, ok, detail) {
  list.push({ name, ok: !!ok, detail });
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? `: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`);
}

async function brightness(file, start, duration, work) {
  const name = `yavg-${path.basename(file, '.mp4')}.txt`;
  const out = path.join(work, name);
  await ffmpeg(['-loglevel', 'error', '-ss', String(start), '-t', String(duration), '-i', path.resolve(file),
    '-vf', `scale=480:-2,signalstats,metadata=print:key=lavfi.signalstats.YAVG:file=${name}`, '-f', 'null', '-'], { cwd: work });
  const lines = fs.readFileSync(out, 'utf8').split('\n');
  const series = [];
  let t = null;
  for (const l of lines) {
    const pt = /pts_time:([\d.]+)/.exec(l);
    if (pt) t = Number(pt[1]);
    const y = /YAVG=([\d.]+)/.exec(l);
    if (y && t !== null) series.push({ t: start + t, y: Number(y[1]) });
  }
  return series;
}

async function validateFormat(config, format, work) {
  const fmt = config.formats[format];
  const file = resolveOut(fmt.output);
  const checks = [];
  console.log(`\n${format}: ${file}`);
  if (!fs.existsSync(file)) { check(checks, 'output exists', false); return { format, file, checks }; }
  const info = await probe(file);
  const v = info.streams.find((s) => s.codec_type === 'video');
  const a = info.streams.find((s) => s.codec_type === 'audio');
  const duration = Number(info.format.duration);
  const fps = fraction(v.r_frame_rate);
  const frames = Number(v.nb_frames);
  check(checks, 'video codec H.264', v.codec_name === 'h264', `${v.codec_name} ${v.profile}`);
  check(checks, 'resolution', v.width === fmt.width && v.height === fmt.height, `${v.width}x${v.height}`);
  check(checks, 'square pixels', !v.sample_aspect_ratio || v.sample_aspect_ratio === '1:1', v.sample_aspect_ratio);
  check(checks, 'pixel format yuv420p', v.pix_fmt === 'yuv420p', v.pix_fmt);
  check(checks, 'frame rate', Math.abs(fps - fmt.fps) < 0.01, `${v.r_frame_rate} (avg ${v.avg_frame_rate})`);
  check(checks, 'duration', Math.abs(duration - config.video.duration) < 0.1, `${duration.toFixed(3)} s`);
  check(checks, 'frame count', Math.abs(frames - config.video.duration * fmt.fps) <= 1, frames);
  if (config.audio.enabled !== false) {
    check(checks, 'audio AAC', a?.codec_name === 'aac', a && `${a.codec_name} ${a.sample_rate} Hz ${a.channels} ch ${Math.round(a.bit_rate / 1000)} kb/s`);
    check(checks, 'audio stereo 48 kHz', a && a.channels === 2 && Number(a.sample_rate) === config.audio.outputSampleRate);
    const { err } = await ffmpeg(['-nostats', '-i', file, '-map', '0:a', '-af', 'ebur128=peak=true', '-f', 'null', '-']);
    const summary = err.slice(err.lastIndexOf('Summary:'));
    const I = Number(/I:\s+(-?[\d.]+) LUFS/.exec(summary)?.[1]);
    const TP = Number(/Peak:\s+(-?[\d.]+) dBFS/.exec(summary)?.[1]);
    check(checks, 'loudness', Math.abs(I - config.audio.loudnessLUFS) <= 1, `${I} LUFS integrated (target ${config.audio.loudnessLUFS})`);
    check(checks, 'true peak', TP <= config.audio.truePeak, `${TP} dBTP (limit ${config.audio.truePeak})`);
    const { err: silence } = await ffmpeg(['-nostats', '-i', file, '-map', '0:a', '-af', 'silencedetect=n=-55dB:d=1', '-f', 'null', '-']);
    const gaps = [...silence.matchAll(/silence_start: ([\d.]+)/g)].map((m) => Number(m[1]));
    check(checks, 'no silent gaps (>1 s below -55 dB)', gaps.length === 0, gaps.length ? gaps : 'none');
  }
  const { err: black } = await ffmpeg(['-nostats', '-i', file, '-vf', 'blackdetect=d=0.2:pix_th=0.04:pic_th=0.995', '-an', '-f', 'null', '-']);
  const blacks = [...black.matchAll(/black_start:([\d.]+) black_end:([\d.]+)/g)].map((m) => [Number(m[1]), Number(m[2])]);
  check(checks, 'no black segments', blacks.length === 0, blacks.length ? blacks : 'none');
  const { err: freeze } = await ffmpeg(['-nostats', '-i', file, '-vf', 'freezedetect=n=0.0003:d=0.4', '-an', '-f', 'null', '-']);
  const freezes = [...freeze.matchAll(/freeze_start: ([\d.]+)/g)].map((m) => Number(m[1]));
  check(checks, 'no frozen segments (>0.4 s)', freezes.length === 0, freezes.length ? freezes : 'none');

  const spans = timeline(config);
  const storm = spans.find((s) => s.id === 'storm');
  let flashes = [];
  if (storm) {
    const series = await brightness(file, storm.start + 0.5, storm.duration - 0.5, work);
    const sorted = series.map((p) => p.y).sort((x, y) => x - y);
    const median = sorted[Math.floor(sorted.length / 2)];
    for (const p of series) if (p.y > median * 1.15 && (!flashes.length || p.t - flashes.at(-1).t > 0.25)) flashes.push({ t: +p.t.toFixed(2), y: +p.y.toFixed(1) });
    check(checks, 'lightning flashes in storm scene', flashes.length >= 2, `${flashes.length} (median luma ${median?.toFixed(1)}) ${JSON.stringify(flashes)}`);
  }

  // Review sheet: a frame from the middle of each scene plus the first and last frames.
  const times = [0.05, ...spans.map((s) => +(s.start + s.duration / 2).toFixed(2)), +(config.video.duration - 0.05).toFixed(2)];
  if (flashes[0]) times.push(flashes[0].t);
  const shots = [];
  for (const t of times) {
    const out = path.join(work, `${format}-${t}.jpg`);
    await ffmpeg(['-loglevel', 'error', '-ss', String(t), '-i', file, '-frames:v', '1', '-q:v', '3', out]);
    shots.push(out);
  }
  const sheet = path.join(buildDir(config, 'review'), `${format}-final-sheet.jpg`);
  await contactSheet(shots, sheet, { cols: format === 'vertical' ? 6 : 4, tileWidth: format === 'vertical' ? 300 : 480 });

  const thumb = resolveOut(fmt.thumbnail);
  if (fs.existsSync(thumb)) {
    const ti = (await probe(thumb)).streams[0];
    check(checks, 'thumbnail', ti.width === fmt.width && ti.height === fmt.height, `${ti.width}x${ti.height} ${(fs.statSync(thumb).size / 1024).toFixed(0)} KB`);
  } else check(checks, 'thumbnail', false, 'missing');

  const scenes = formatScenes(config, format);
  const meta = scenes.map((s) => {
    const from = s.source && s.source !== format ? s.source : format;
    const f = path.join(buildDir(config, 'clips', from), `${s.id}.json`);
    return fs.existsSync(f) ? { id: s.id, from, ...JSON.parse(fs.readFileSync(f, 'utf8')) } : { id: s.id, missing: true };
  });
  const adapters = [...new Set(meta.map((m) => m.adapter && `${m.adapter.vendor} ${m.adapter.architecture} ${m.adapter.description || ''}`.trim()))];
  check(checks, 'every scene captured on a hardware WebGPU adapter', meta.every((m) => m.adapter && !m.adapter.isFallbackAdapter), adapters);
  check(checks, 'no page errors during capture', meta.every((m) => !m.pageErrors?.length), meta.filter((m) => m.pageErrors?.length).map((m) => m.id));

  return {
    format, file, sizeBytes: info.format.size ? Number(info.format.size) : fs.statSync(file).size,
    duration, fps, width: v.width, height: v.height, frames,
    video: { codec: v.codec_name, profile: v.profile, bitRate: Number(v.bit_rate) },
    audio: a ? { codec: a.codec_name, sampleRate: Number(a.sample_rate), channels: a.channels, bitRate: Number(a.bit_rate) } : null,
    flashes, blacks, freezes, sheet, checks,
    scenes: meta.map((m) => ({ id: m.id, from: m.from, frames: m.frames, fps: m.fps, audioPeak: m.audio?.peak, captureSeconds: m.captureSeconds })),
  };
}

export async function validate(config, formats) {
  const work = buildDir(config, 'validate');
  const results = [];
  for (const format of formats) results.push(await validateFormat(config, format, work));
  const report = path.join(buildDir(config), 'validation.json');
  fs.writeFileSync(report, JSON.stringify({ generated: new Date().toISOString(), results }, null, 2));
  const failed = results.flatMap((r) => r.checks.filter((c) => !c.ok).map((c) => `${r.format}: ${c.name}`));
  console.log(`\n${failed.length ? `FAILED ${failed.length} check(s):\n  ${failed.join('\n  ')}` : 'All checks passed.'}\nReport: ${report}`);
  return failed.length === 0;
}

if (process.argv[1]?.endsWith('validate.mjs')) {
  const config = loadConfig();
  const ok = await validate(config, selectedFormats(config, cliOptions()));
  process.exitCode = ok ? 0 : 1;
}
