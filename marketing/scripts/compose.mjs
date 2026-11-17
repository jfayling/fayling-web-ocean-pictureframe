// Assembles captured scene clips, title frames and captured app audio into the final MP4s.
//   node scripts/compose.mjs [--format landscape]
// Needs: build/clips/<format>/<scene>.mp4|.wav (capture.mjs), build/titles/<format>/ (titles.mjs)
import fs from 'node:fs';
import path from 'node:path';
import { buildDir, cliOptions, formatScenes, loadConfig, resolveOut, selectedFormats, timeline } from './lib/config.mjs';
import { ffmpeg, probe } from './lib/ffmpeg.mjs';

function sceneInputs(config, format) {
  const spans = timeline(config);
  return formatScenes(config, format).map((scene, i) => {
    const from = scene.source && scene.source !== format ? scene.source : format;
    const dir = buildDir(config, 'clips', from);
    const clip = path.join(dir, `${scene.id}.mp4`);
    const wav = path.join(dir, `${scene.id}.wav`);
    if (!fs.existsSync(clip)) throw new Error(`missing ${clip}; run capture.mjs --format ${from}`);
    return { scene, span: spans[i], clip, wav: fs.existsSync(wav) ? wav : null, from };
  });
}

// Fits a clip of another aspect ratio: blurred, darkened cover fill behind a sharp inset.
function blurFit(label, out, fmt, scene, k) {
  const { width: W, height: H } = fmt;
  const insetY = scene.insetY ?? 0.56;
  return `${label}split[bf_a${k}][bf_b${k}];`
    + `[bf_a${k}]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},gblur=sigma=36,eq=brightness=-0.10:saturation=1.1[bf_bg${k}];`
    + `[bf_b${k}]scale=${W}:-2:flags=lanczos[bf_fg${k}];`
    + `[bf_bg${k}][bf_fg${k}]overlay=x=(W-w)/2:y=${H}*${insetY}-h/2${out}`;
}

async function mixAudio(config, format, inputs, workDir) {
  const A = config.audio;
  const duration = config.video.duration;
  const args = [];
  const labels = [];
  inputs.forEach((inp, i) => {
    if (inp.wav) args.push('-i', inp.wav);
    else args.push('-f', 'lavfi', '-t', String(inp.span.clipDuration), '-i', `anullsrc=r=${A.sampleRate}:cl=stereo`);
    labels.push(`[${i}:a]atrim=duration=${inp.span.clipDuration},asetpts=PTS-STARTPTS,aformat=sample_fmts=fltp:channel_layouts=stereo[a${i}]`);
  });
  let chain = '[a0]';
  for (let i = 1; i < inputs.length; i++) {
    const d = inputs[i - 1].span.transitionOut;
    labels.push(`${chain}[a${i}]acrossfade=d=${d}:c1=qsin:c2=qsin[x${i}]`);
    chain = `[x${i}]`;
  }
  labels.push(`${chain}aresample=${A.outputSampleRate}:filter_size=64:cutoff=0.97,atrim=duration=${duration},apad=whole_dur=${duration}[mix]`);
  const raw = path.join(workDir, `${format}-mix.wav`);
  await ffmpeg([...args, '-filter_complex', labels.join(';'), '-map', '[mix]', '-c:a', 'pcm_f32le', raw]);

  // Two-pass EBU R128 loudness normalisation.
  // AAC encoding overshoots peaks by a few tenths of a dB, so the limiter aims lower.
  const target = `I=${A.loudnessLUFS}:TP=${A.truePeak - (A.codecHeadroom ?? 0.6)}:LRA=11`;
  const { err } = await ffmpeg(['-i', raw, '-af', `loudnorm=${target}:print_format=json`, '-f', 'null', '-']);
  const m = JSON.parse(err.slice(err.lastIndexOf('{'), err.lastIndexOf('}') + 1));
  const norm = `loudnorm=${target}:measured_I=${m.input_i}:measured_TP=${m.input_tp}:measured_LRA=${m.input_lra}`
    + `:measured_thresh=${m.input_thresh}:offset=${m.target_offset}:linear=true`;
  const out = path.join(workDir, `${format}-audio.wav`);
  await ffmpeg(['-i', raw, '-af',
    `${norm},aresample=${A.outputSampleRate}:filter_size=64:cutoff=0.97,atrim=duration=${duration},`
    + `afade=t=in:d=${A.fadeIn},afade=t=out:st=${duration - A.fadeOut}:d=${A.fadeOut}`,
    '-c:a', 'pcm_s24le', out]);
  return { file: out, measured: m };
}

async function compose(config, format) {
  const fmt = config.formats[format];
  const { fps, width: W, height: H } = fmt;
  const duration = config.video.duration;
  const workDir = buildDir(config, 'compose');
  const inputs = sceneInputs(config, format);
  const titleDir = buildDir(config, 'titles', format);
  const titleFrames = fs.readdirSync(titleDir).filter((f) => /^f\d+\.png$/.test(f)).length;
  if (titleFrames < Math.round(duration * fps)) throw new Error(`title frames incomplete in ${titleDir}; run titles.mjs --format ${format}`);

  const args = [];
  const graph = [];
  inputs.forEach((inp, i) => {
    args.push('-i', inp.clip);
    const base = `[${i}:v]trim=duration=${inp.span.clipDuration},setpts=PTS-STARTPTS,fps=${fps}`;
    if (inp.from !== format) {
      graph.push(blurFit(`${base},`, `,setsar=1,format=yuv420p[v${i}]`, fmt, inp.scene, i));
    } else {
      graph.push(`${base},scale=${W}:${H}:flags=lanczos,setsar=1,format=yuv420p[v${i}]`);
    }
  });
  let chain = '[v0]';
  for (let i = 1; i < inputs.length; i++) {
    const d = inputs[i - 1].span.transitionOut;
    const transition = inputs[i].scene.transitionStyle || 'fade';
    graph.push(`${chain}[v${i}]xfade=transition=${transition}:duration=${d}:offset=${inputs[i].span.start}[c${i}]`);
    chain = `[c${i}]`;
  }
  const t = inputs.length;
  args.push('-framerate', String(fps), '-i', path.join(titleDir, 'f%05d.png'));
  graph.push(`[${t}:v]format=rgba[ttl]`);
  graph.push(`${chain}[ttl]overlay=format=auto:shortest=0,trim=duration=${duration},format=yuv420p[vout]`);

  const audio = config.audio.enabled !== false ? await mixAudio(config, format, inputs, workDir) : null;
  if (audio) args.push('-i', audio.file);

  const outFile = resolveOut(fmt.output);
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  const t0 = Date.now();
  await ffmpeg([
    ...args,
    '-filter_complex', graph.join(';'),
    '-map', '[vout]',
    ...(audio ? ['-map', `${t + 1}:a`, '-c:a', 'aac', '-b:a', config.audio.bitrate, '-ar', String(config.audio.outputSampleRate)] : []),
    '-c:v', 'libx264', '-preset', config.video.preset, '-crf', String(config.video.crf),
    '-profile:v', 'high', '-pix_fmt', 'yuv420p', '-r', String(fps),
    '-g', String(fps * 2), '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709',
    '-t', String(duration), '-movflags', '+faststart',
    '-metadata', `title=Ocean - real-time WebGPU ocean (${format})`,
    '-metadata', `comment=Rendered by ${config.repo}; footage captured from the running app`,
    outFile,
  ]);
  const info = await probe(outFile);
  const v = info.streams.find((s) => s.codec_type === 'video');
  if (Math.abs(Number(v.duration) - duration) > 0.05) throw new Error(`video stream is ${v.duration}s, expected ${duration}s`);
  console.log(`${format}: ${path.relative(process.cwd(), outFile)} ${v.width}x${v.height} ${v.r_frame_rate} `
    + `${Number(info.format.duration).toFixed(3)}s ${(info.format.size / 1048576).toFixed(1)} MB in ${((Date.now() - t0) / 1000).toFixed(0)}s`
    + (audio ? ` | audio in ${audio.measured.input_i} LUFS -> ${config.audio.loudnessLUFS}` : ''));
}

if (process.argv[1]?.endsWith('compose.mjs')) {
  const config = loadConfig();
  const opts = cliOptions();
  for (const format of selectedFormats(config, opts)) await compose(config, format);
}

export { compose };
