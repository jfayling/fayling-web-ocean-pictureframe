import { spawn } from 'node:child_process';
import ffmpegStatic from 'ffmpeg-static';
import ffprobeStatic from 'ffprobe-static';

export const FFMPEG = process.env.FFMPEG_PATH || ffmpegStatic;
export const FFPROBE = process.env.FFPROBE_PATH || ffprobeStatic.path;

export function run(bin, args, { quiet = true, cwd } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'], cwd });
    let out = '', err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; if (!quiet) process.stderr.write(d); });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve({ out, err });
      else reject(new Error(`${bin} exited ${code}\n${err.slice(-4000)}`));
    });
  });
}

export const ffmpeg = (args, opts) => run(FFMPEG, ['-hide_banner', '-y', ...args], opts);

export async function probe(file) {
  const { out } = await run(FFPROBE, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file]);
  return JSON.parse(out);
}

// Tiles still images into one JPEG for review.
export async function contactSheet(images, outFile, { cols = 3, tileWidth = 640 } = {}) {
  if (!images.length) return;
  const n = images.length;
  const c = Math.min(cols, n);
  const inputs = images.flatMap((f) => ['-i', f]);
  const scaled = images.map((_, i) => `[${i}:v]scale=${tileWidth}:-2,setsar=1[v${i}]`).join(';');
  const pos = (k, size) => (k === 0 ? '0' : Array(k).fill(size).join('+'));
  const layout = images.map((_, i) => `${pos(i % c, 'w0')}_${pos(Math.floor(i / c), 'h0')}`).join('|');
  const filter = n === 1 ? `[0:v]scale=${tileWidth}:-2` : `${scaled};${images.map((_, i) => `[v${i}]`).join('')}xstack=inputs=${n}:layout=${layout}:fill=black`;
  await ffmpeg(['-loglevel', 'error', ...inputs, '-filter_complex', filter, '-frames:v', '1', '-q:v', '3', outFile]);
}

// An encoder fed one image per frame on stdin.
export function frameEncoder(outFile, { fps, crf = 12, codec = 'mjpeg' }) {
  const child = spawn(FFMPEG, [
    '-hide_banner', '-y', '-loglevel', 'error',
    '-f', 'image2pipe', '-framerate', String(fps), '-c:v', codec, '-i', '-',
    '-c:v', 'libx264', '-preset', 'fast', '-crf', String(crf), '-pix_fmt', 'yuv420p',
    '-r', String(fps), '-movflags', '+faststart', outFile,
  ], { stdio: ['pipe', 'ignore', 'pipe'] });
  let err = '';
  let pipeError = null;
  child.stderr.on('data', (d) => { err += d; });
  child.stdin.on('error', (e) => { pipeError = e; });
  const done = new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`encoder exited ${code}: ${err}`))));
  });
  return {
    async write(buf) {
      if (pipeError) throw new Error(`encoder pipe failed: ${pipeError.message} ${err}`);
      if (!child.stdin.write(buf)) await new Promise((resolve) => child.stdin.once('drain', resolve));
    },
    async end() { child.stdin.end(); await done; },
    kill() { child.kill(); },
  };
}
