// Turns the storyboard's per-scene titles into absolutely timed, positioned title records.
// A `sub` hangs below the scene's headline and a `kicker` sits above the scene's url; the
// title page measures the rendered text to place them.
import { formatScenes, timeline } from './config.mjs';

export function titleRecords(config, format) {
  const fmt = config.formats[format];
  const T = config.titles;
  const F = T[format];
  const spans = Object.fromEntries(timeline(config).map((s) => [s.id, s]));
  const records = [];
  for (const scene of formatScenes(config, format)) {
    const center = scene.titleY ?? F.center;
    let headline = -1;
    let url = -1;
    const pending = [];
    for (const raw of scene.titles || []) {
      const t = { ...raw, ...(raw.formats?.[format] || {}) };
      const size = t.size ?? F[t.style] ?? F.headline;
      const color = T.colors[t.color] || t.color || (t.style === 'kicker' ? T.colors.cyan : T.colors.text);
      const rec = {
        text: t.text,
        style: t.style,
        size,
        y: t.y ?? (t.style === 'url' ? (scene.urlY ?? F.urlCenter) : center),
        color,
        glow: hexAlpha(color, 0.55),
        start: spans[scene.id].start + t.in,
        end: spans[scene.id].start + t.out,
        fadeIn: t.fadeIn ?? T.fadeIn,
        fadeOut: t.fadeOut ?? T.fadeOut,
        scrim: t.scrim,
      };
      const index = records.length;
      if (t.style === 'headline' || t.style === 'reveal') headline = index;
      if (t.style === 'url') url = index;
      if (t.style === 'sub' && t.y === undefined && headline >= 0) rec.anchor = { index: headline, side: 'below' };
      if (t.style === 'kicker' && t.y === undefined) pending.push(rec);
      records.push(rec);
    }
    for (const rec of pending) if (url >= 0) rec.anchor = { index: url, side: 'above', gap: 0.45 };
  }
  return {
    width: fmt.width, height: fmt.height, font: T.font,
    scrimStrength: T.scrimStrength ?? 0.32, scrimHeight: T.scrimHeight ?? 26,
    titles: records,
  };
}

function hexAlpha(hex, a) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
  if (!m) return `rgba(255,255,255,${a})`;
  const n = parseInt(m[1], 16);
  return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})`;
}
