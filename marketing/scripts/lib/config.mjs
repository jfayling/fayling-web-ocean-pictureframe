import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const MARKETING_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const REPO_DIR = path.resolve(MARKETING_DIR, '..');

export function loadConfig(file = process.env.VIDEO_CONFIG || path.join(MARKETING_DIR, 'video-config.json')) {
  const config = JSON.parse(fs.readFileSync(file, 'utf8'));
  config.__file = file;
  return config;
}

export function resolveOut(p) {
  return path.isAbsolute(p) ? p : path.resolve(MARKETING_DIR, p);
}

export function buildDir(config, ...parts) {
  const dir = resolveOut(path.join(config.paths.build, ...parts));
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// Command-line flags shared by every script: --format landscape --scene hook
export function cliOptions(argv = process.argv.slice(2)) {
  const opts = { formats: [], scenes: [], force: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--format' || a === '-f') opts.formats.push(...argv[++i].split(','));
    else if (a === '--scene' || a === '-s') opts.scenes.push(...argv[++i].split(','));
    else if (a === '--force') opts.force = true;
    else if (a === '--headed') opts.headed = true;
    else if (a.startsWith('--')) opts[a.slice(2)] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
  }
  return opts;
}

export function selectedFormats(config, opts) {
  const all = Object.keys(config.formats);
  return opts.formats.length ? all.filter((f) => opts.formats.includes(f)) : all;
}

export function formatScenes(config, format) {
  return config.scenes.map((scene) => ({
    ...scene,
    ...(scene.formats?.[format] || {}),
    app: { ...(scene.app || {}), ...(scene.formats?.[format]?.app || {}) },
    camera: { ...(scene.camera || {}), ...(scene.formats?.[format]?.camera || {}) },
  }));
}

// Scene timeline: each scene keeps its nominal start; clips carry `transition` seconds of
// extra footage so neighbouring scenes can cross-dissolve without shortening the cut.
export function timeline(config) {
  let t = 0;
  return config.scenes.map((scene, i) => {
    const start = t;
    t += scene.duration;
    const next = config.scenes[i + 1];
    const tail = next ? (next.transition ?? config.video.transition) : 0;
    return { id: scene.id, start, duration: scene.duration, clipDuration: scene.duration + tail, transitionOut: tail };
  });
}
