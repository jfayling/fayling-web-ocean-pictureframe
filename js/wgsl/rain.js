// Rain drops, a camera-following ripple field, mist, and lightning.
// The frame uniform is full, so rain keeps its own block. Layout matches rainF in main.js.
import { FRAME_WGSL, CASCADES } from './common.js';

export const RAIN_RES = 512;
export const RAIN_MAP = 40;
export const MAX_DROPS = 12288;

export const RAIN_STRUCT = /* wgsl */ `
struct RainU {
  cam: vec4f,     // xyz metres, w = time (s)
  wind: vec4f,    // xy direction, z speed (m/s), w intensity
  amt: vec4f,     // ripples, splashes, lightning flash, style (0 rain, 1 storm, 2 hurricane)
  bolt: vec4f,    // xy direction, z seed, w enabled
  sim: vec4f,     // map size (m), dt, active drops, slant
  origin: vec4f,  // xy current centre, zw previous centre
  atmo: vec4f,    // extra fog, sun scale, sky darken, gust
  dropP: vec4f,   // fall speed, box radius, box height, splash chance
};
`;

const RES = RAIN_RES;

export const RAIN_DROP_INIT = RAIN_STRUCT + /* wgsl */ `
struct Drop { pos: vec4f, vel: vec4f }  // vel.w >= 1 falling; 0..1 splash life
@group(0) @binding(0) var<uniform> Rain: RainU;
@group(0) @binding(1) var<storage, read_write> drops: array<Drop>;

fn h01(n: u32) -> f32 {
  var x = n * 747796405u + 2891336453u;
  x = ((x >> ((x >> 28u) + 4u)) ^ x) * 277803737u;
  x = (x >> 22u) ^ x;
  return f32(x) / 4294967295.0;
}

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= ${MAX_DROPS}u) { return; }
  let a = h01(id.x * 17u + 3u);
  let b = h01(id.x * 29u + 11u);
  let c = h01(id.x * 47u + 19u);
  let ang = a * 6.2831853;
  let rad = sqrt(b) * Rain.dropP.y;
  let pos = vec3f(Rain.cam.x + cos(ang) * rad, Rain.cam.y + 1.0 + c * Rain.dropP.z, Rain.cam.z + sin(ang) * rad);
  let gust = 0.85 + 0.15 * a;
  let horiz = Rain.wind.xy * Rain.wind.z * Rain.sim.w * gust;
  drops[id.x].pos = vec4f(pos, a);
  drops[id.x].vel = vec4f(horiz.x, -Rain.dropP.x, horiz.y, 2.0);
}
`;

export const RAIN_DROP_UPDATE = RAIN_STRUCT + FRAME_WGSL + /* wgsl */ `
struct Drop { pos: vec4f, vel: vec4f }
@group(0) @binding(0) var<uniform> Rain: RainU;
@group(0) @binding(1) var<uniform> F: Frame;
@group(0) @binding(2) var<storage, read_write> drops: array<Drop>;
@group(0) @binding(3) var<storage, read_write> dent: array<atomic<i32>>;
@group(0) @binding(4) var<storage, read_write> splash: array<atomic<i32>>;
@group(0) @binding(5) var dispTex: texture_2d_array<f32>;
@group(0) @binding(6) var samp: sampler;

fn h01(n: f32) -> f32 {
  return fract(sin(n * 127.1 + 311.7) * 43758.5453);
}

fn waterY(xz: vec2f) -> f32 {
  var y = 0.0;
  for (var c = 0u; c < ${CASCADES}u; c++) {
    let inv = F.cascInvL[c >> 2u][c & 3u];
    y += textureSampleLevel(dispTex, samp, xz * inv, c, 0.0).y;
  }
  return y;
}

fn stamp(xz: vec2f, energy: f32) {
  let texel = Rain.sim.x / ${RES}.0;
  let local = (xz - Rain.origin.xy) / texel + vec2f(${RES / 2}.0);
  let base = vec2i(local);
  for (var j = -1; j <= 1; j++) {
    for (var i = -1; i <= 1; i++) {
      let p = base + vec2i(i, j);
      if (any(p < vec2i(0)) || any(p >= vec2i(${RES}))) { continue; }
      let idx = u32(p.y) * ${RES}u + u32(p.x);
      let centre = i == 0 && j == 0;
      let dentV = i32(energy * select(2800.0, -16000.0, centre));
      atomicAdd(&dent[idx], dentV);
      if (centre) { atomicAdd(&splash[idx], i32(energy * 26000.0)); }
    }
  }
}

fn respawn(id: u32, seed: f32) -> vec4f {
  let n = h01(f32(id) * 0.17 + Rain.cam.w * 1.7 + seed * 9.1);
  let m = h01(f32(id) * 0.93 + seed * 4.2 + 2.3);
  let k = h01(f32(id) * 1.7 + Rain.cam.w * 0.37 + 5.5);
  let ang = n * 6.2831853;
  let rad = sqrt(m) * Rain.dropP.y;
  let xz = Rain.cam.xz + vec2f(cos(ang), sin(ang)) * rad;
  let y = waterY(xz) + 2.0 + k * Rain.dropP.z;
  return vec4f(xz.x, y, xz.y, seed);
}

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) id: vec3u) {
  let live = u32(Rain.sim.z);
  if (id.x >= live) { return; }
  var d = drops[id.x];
  let dt = min(Rain.sim.y, 0.05);
  let gust = 0.78 + 0.22 * sin(Rain.cam.w * (0.7 + Rain.atmo.w) + d.pos.w * 6.2831853);
  let horiz = Rain.wind.xy * Rain.wind.z * Rain.sim.w * gust;
  if (d.vel.w >= 1.0) {
    d.vel = vec4f(horiz.x, -Rain.dropP.x * (0.82 + 0.36 * d.pos.w), horiz.y, 2.0);
  } else {
    d.vel.y -= 9.8 * dt;
    d.vel.x = mix(d.vel.x, horiz.x, 0.15);
    d.vel.z = mix(d.vel.z, horiz.y, 0.15);
    d.vel.w -= dt;
  }
  d.pos = vec4f(d.pos.xyz + d.vel.xyz * dt, d.pos.w);
  let away = length(d.pos.xz - Rain.cam.xz);
  let wy = waterY(d.pos.xz);
  let hit = d.pos.y <= wy + 0.02;
  let left = away > Rain.dropP.y * 1.35 || d.pos.y > wy + Rain.dropP.z + 8.0;
  if (d.vel.w < 1.0 && (d.vel.w <= 0.0 || hit || left)) {
    d.pos = respawn(id.x, d.pos.w);
    d.vel = vec4f(horiz.x, -Rain.dropP.x, horiz.y, 2.0);
  } else if (d.vel.w >= 1.0 && left) {
    d.pos = respawn(id.x, d.pos.w);
    d.vel = vec4f(horiz.x, -Rain.dropP.x, horiz.y, 2.0);
  } else if (d.vel.w >= 1.0 && hit) {
    let energy = (0.55 + d.pos.w) * (0.45 + Rain.wind.w);
    stamp(vec2f(d.pos.x, d.pos.z), energy);
    let roll = h01(f32(id.x) + Rain.cam.w * 13.1 + d.pos.w * 8.0);
    if (roll < Rain.dropP.w) {
      d.pos.y = wy + 0.06 + roll * 0.08;
      d.vel = vec4f(horiz.x * 0.25, Rain.dropP.x * (0.18 + roll * 0.22), horiz.y * 0.25, 0.28 + roll * 0.2);
    } else {
      d.pos = respawn(id.x, d.pos.w);
      d.vel = vec4f(horiz.x, -Rain.dropP.x, horiz.y, 2.0);
    }
  }
  drops[id.x] = d;
}
`;

export const RAIN_RIPPLE = RAIN_STRUCT + /* wgsl */ `
@group(0) @binding(0) var<uniform> Rain: RainU;
@group(0) @binding(1) var prevTex: texture_2d<f32>;
@group(0) @binding(2) var dst: texture_storage_2d<rgba16float, write>;
@group(0) @binding(3) var<storage, read_write> dent: array<atomic<i32>>;
@group(0) @binding(4) var<storage, read_write> splash: array<atomic<i32>>;

fn prevAt(p: vec2i) -> vec4f {
  if (any(p < vec2i(0)) || any(p >= vec2i(${RES}))) { return vec4f(0.0); }
  return textureLoad(prevTex, p, 0);
}

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= ${RES}u || id.y >= ${RES}u) { return; }
  let texel = Rain.sim.x / ${RES}.0;
  let shift = vec2i(
    i32(round((Rain.origin.x - Rain.origin.z) / texel)),
    i32(round((Rain.origin.y - Rain.origin.w) / texel)));
  let base = vec2i(id.xy) + shift;
  let c = prevAt(base);
  let lp = prevAt(base + vec2i(-1, 0)).r;
  let rp = prevAt(base + vec2i(1, 0)).r;
  let up = prevAt(base + vec2i(0, -1)).r;
  let dp = prevAt(base + vec2i(0, 1)).r;
  let dt = min(max(Rain.sim.y, 0.0), 0.05);
  let damp = exp(-dt * select(1.35, 3.8, Rain.wind.w < 0.01));
  let lap = lp + rp + up + dp - 4.0 * c.r;
  var vel = (c.g + lap * 0.2) * damp;
  var h = c.r + vel;
  let idx = id.y * ${RES}u + id.x;
  h += f32(atomicLoad(&dent[idx])) * 0.00000115 * Rain.amt.x;
  h = clamp(h, -0.04, 0.04);
  vel = clamp(h - c.r, -0.25, 0.25);
  let fade = exp(-dt * (2.4 + Rain.wind.z * 0.04));
  let sp = c.b * fade + f32(atomicLoad(&splash[idx])) * 0.000028 * Rain.amt.y;
  textureStore(dst, id.xy, vec4f(h, vel, clamp(sp, 0.0, 2.5), 1.0));
}
`;

export const RAIN_CLEAR = /* wgsl */ `
@group(0) @binding(0) var<storage, read_write> dent: array<atomic<i32>>;
@group(0) @binding(1) var<storage, read_write> splash: array<atomic<i32>>;
@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= ${RES}u * ${RES}u) { return; }
  atomicStore(&dent[id.x], 0);
  atomicStore(&splash[id.x], 0);
}
`;

const RAIN_VS = /* wgsl */ `
struct VO { @builtin(position) pos: vec4f, @location(0) ndc: vec2f };
@vertex fn vs(@builtin(vertex_index) i: u32) -> VO {
  let p = vec2f(f32((i << 1u) & 2u), f32(i & 2u)) * 2.0 - 1.0;
  var o: VO;
  o.pos = vec4f(p, 0.0, 1.0);
  o.ndc = p;
  return o;
}
`;

export const RAIN_DRAW = RAIN_STRUCT + FRAME_WGSL + /* wgsl */ `
struct Drop { pos: vec4f, vel: vec4f }
struct VO {
  @builtin(position) pos: vec4f,
  @location(0) across: f32,
  @location(1) along: f32,
  @location(2) splash: f32,
  @location(3) fade: f32,
}
@group(0) @binding(0) var<uniform> F: Frame;
@group(0) @binding(1) var<uniform> Rain: RainU;
@group(0) @binding(2) var<storage, read> drops: array<Drop>;

fn corner(i: u32) -> vec2f {
  switch i {
    case 0u: { return vec2f(-1.0, -1.0); }
    case 1u: { return vec2f(1.0, -1.0); }
    case 2u: { return vec2f(1.0, 1.0); }
    case 3u: { return vec2f(-1.0, -1.0); }
    case 4u: { return vec2f(1.0, 1.0); }
    default: { return vec2f(-1.0, 1.0); }
  }
}

@vertex fn vs(@builtin(vertex_index) vi: u32) -> VO {
  let drop = vi / 6u;
  let q = corner(vi % 6u);
  let d = drops[drop];
  var dir = d.vel.xyz;
  let speed = length(dir);
  dir = select(vec3f(0.0, -1.0, 0.0), dir / max(speed, 0.001), speed > 0.05);
  let toCam = F.camPos.xyz - d.pos.xyz;
  let dist = max(length(toCam), 0.15);
  var side = cross(dir, toCam / dist);
  let sl = length(side);
  side = select(normalize(cross(dir, vec3f(0.0, 0.0, 1.0))), side / max(sl, 1e-4), sl > 1e-3);
  let pixel = dist * 2.0 * length(F.camUp.xyz) * max(F.screen.w, 1e-6);
  let near = 1.0 - smoothstep(3.0, 8.0, dist);
  var len = (0.28 + speed * 0.03) * mix(0.3, 1.0, near);
  var width = (0.008 + d.pos.w * 0.008) * mix(0.4, 1.0, near);
  len = max(len, pixel * mix(1.5, 16.0, near));
  width = max(width, pixel * mix(0.45, 1.05, near));
  let splashing = d.vel.w < 1.0;
  if (splashing) { len *= 0.32; width *= 1.7; }
  let world = d.pos.xyz + dir * q.y * len + side * q.x * width;
  var o: VO;
  o.pos = F.viewProj * vec4f(world - F.camPos.xyz, 1.0);
  o.across = q.x;
  o.along = q.y;
  o.splash = select(0.0, 1.0, splashing);
  let box = length(d.pos.xz - Rain.cam.xz) / max(Rain.dropP.y, 1.0);
  o.fade = smoothstep(1.25, 0.55, box) * smoothstep(0.2, 1.1, dist) * near * Rain.wind.w;
  return o;
}

@fragment fn fs(in: VO) -> @location(0) vec4f {
  let body = smoothstep(1.0, 0.12, abs(in.across));
  let rim = smoothstep(0.25, 0.95, abs(in.across));
  let head = smoothstep(-1.0, -0.25, in.along) * smoothstep(1.0, 0.15, in.along);
  let a = body * head * in.fade * mix(0.5, 0.75, in.splash);
  let rgb = (vec3f(0.58, 0.66, 0.74) + vec3f(0.4, 0.38, 0.32) * rim + vec3f(0.25, 0.22, 0.16) * in.splash) * a;
  return vec4f(rgb, a);
}
`;

export const RAIN_MIST = RAIN_STRUCT + FRAME_WGSL + RAIN_VS + /* wgsl */ `
@group(0) @binding(0) var<uniform> F: Frame;
@group(0) @binding(1) var<uniform> Rain: RainU;

fn hash21(p: vec2f) -> f32 {
  let q = fract(p * vec2f(123.34, 345.45));
  let r = q + dot(q, q.yx + 34.345);
  return fract(r.x * r.y);
}

fn noise(p: vec2f) -> f32 {
  let i = floor(p);
  let f = fract(p);
  let u = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(hash21(i), hash21(i + vec2f(1.0, 0.0)), u.x),
    mix(hash21(i + vec2f(0.0, 1.0)), hash21(i + vec2f(1.0, 1.0)), u.x),
    u.y);
}

fn streaks(uv: vec2f, cols: f32, rows: f32, speed: f32, sx: f32, keep: f32, phase: f32) -> f32 {
  let dir = normalize(vec2f(sx * Rain.sim.w, -1.0));
  let tangent = vec2f(dir.y, -dir.x);
  var p = vec2f(dot(uv, tangent) * cols, dot(uv, dir) * rows - phase);
  p.y -= Rain.cam.w * speed;
  let id = floor(p);
  let f = fract(p);
  let n = hash21(id);
  let m = hash21(id.yx + vec2f(4.2, 8.7));
  let alive = smoothstep(keep, keep + 0.1, n);
  let halfW = 0.008 + m * 0.02;
  let line = smoothstep(halfW, 0.0, abs(f.x - mix(0.18, 0.82, m)));
  let len = 0.8 + m * 0.18;
  let y0 = (1.0 - len) * fract(n * 7.13);
  let along = smoothstep(y0, y0 + 0.1, f.y) * (1.0 - smoothstep(y0 + len - 0.18, y0 + len, f.y));
  return line * along * alive * (0.35 + m * 0.65);
}

@fragment fn fs(in: VO) -> @location(0) vec4f {
  let intensity = Rain.wind.w;
  if (intensity < 0.004) { return vec4f(0.0); }
  let ray = normalize(F.camFwd.xyz + in.ndc.x * F.camRight.xyz + in.ndc.y * F.camUp.xyz);
  let up = ray.y;
  let streakMask = smoothstep(-0.16, 0.05, up);
  let veilMask = exp(-up * up * 10.0);
  let right = normalize(F.camRight.xyz);
  let wind = vec3f(Rain.wind.x, 0.0, Rain.wind.y);
  let sx = dot(wind, right);
  let uv = in.ndc * vec2f(F.screen.x * F.screen.w, 1.0);
  let keep = mix(0.7, 0.42, intensity);
  let a = streaks(uv, 110.0, 14.0, 0.7 + intensity, sx, keep, 0.0);
  let b = streaks(uv + vec2f(2.7, 1.1), 190.0, 22.0, 1.15 + intensity * 1.3, sx * 0.85, keep + 0.05, 11.0);
  let threads = (a * 0.55 + b * 0.45) * streakMask;
  let dir = normalize(vec2f(sx * Rain.sim.w, -1.0));
  let along = dot(uv, dir);
  let across = dot(uv, vec2f(dir.y, -dir.x));
  let drift = vec2f(across * 3.5, along * 1.4 - Rain.cam.w * (0.35 + intensity * 0.4));
  let haze = noise(drift) * 0.65 + noise(drift * 2.3 + 5.0) * 0.35;
  let veil = veilMask * (0.35 + 0.65 * haze);
  let alpha = clamp((threads * 0.34 + veil * 0.22) * intensity, 0.0, 0.36);
  let rgb = vec3f(0.62, 0.7, 0.78) * alpha;
  return vec4f(rgb, alpha);
}
`;

// Sampled by the ocean shader. Bindings follow the existing ocean group.
export const RAIN_OCEAN = RAIN_STRUCT + /* wgsl */ `
@group(0) @binding(12) var<uniform> Rain: RainU;
@group(0) @binding(13) var rippleTex: texture_2d<f32>;
@group(0) @binding(14) var rippleSamp: sampler;

fn rainUv(xz: vec2f) -> vec2f {
  return (xz - Rain.origin.xy) / max(Rain.sim.x, 1.0) + 0.5;
}

fn rainEdge(uv: vec2f) -> f32 {
  return smoothstep(0.0, 0.14, uv.x) * smoothstep(1.0, 0.86, uv.x)
    * smoothstep(0.0, 0.14, uv.y) * smoothstep(1.0, 0.86, uv.y);
}

fn rainHeight(xz: vec2f) -> f32 {
  if (Rain.wind.w <= 0.001 || Rain.amt.x <= 0.0) { return 0.0; }
  let uv = rainUv(xz);
  if (uv.x <= 0.0 || uv.x >= 1.0 || uv.y <= 0.0 || uv.y >= 1.0) { return 0.0; }
  return textureSampleLevel(rippleTex, rippleSamp, uv, 0.0).r * rainEdge(uv) * Rain.amt.x;
}

// xy slope (dh/dx, dh/dz), z splash, w near-field mask
fn rainField(xz: vec2f) -> vec4f {
  let intensity = Rain.wind.w;
  if (intensity <= 0.001) { return vec4f(0.0); }
  let uv = rainUv(xz);
  var slope = vec2f(0.0);
  var splash = 0.0;
  var mask = 0.0;
  if (uv.x > 0.0 && uv.x < 1.0 && uv.y > 0.0 && uv.y < 1.0) {
    let edge = rainEdge(uv);
    let texel = 1.0 / ${RES}.0;
    let c = textureSampleLevel(rippleTex, rippleSamp, uv, 0.0);
    let hx = textureSampleLevel(rippleTex, rippleSamp, uv + vec2f(texel, 0.0), 0.0).r;
    let hz = textureSampleLevel(rippleTex, rippleSamp, uv + vec2f(0.0, texel), 0.0).r;
    let worldTexel = Rain.sim.x / ${RES}.0;
    slope = vec2f(hx - c.r, hz - c.r) / max(worldTexel, 1e-4) * edge * Rain.amt.x;
    splash = c.b * edge * Rain.amt.y;
    mask = edge;
  }
  let far = (1.0 - mask) * intensity * Rain.amt.x;
  let q = xz * (7.0 + intensity * 14.0) + Rain.wind.xy * Rain.cam.w * (1.6 + intensity * 4.5);
  let n1 = vec2f(sin(q.x * 1.71 + q.y * 0.41), cos(q.y * 1.37 - q.x * 0.23));
  let n2 = vec2f(sin(q.y * 2.83 + Rain.cam.w * 5.2), sin(q.x * 2.27 - Rain.cam.w * 4.1));
  slope += (n1 * 0.62 + n2 * 0.38) * far * 0.045;
  return vec4f(slope, splash, mask);
}

fn rainRough() -> f32 {
  let i = Rain.wind.w;
  return i * i * 0.010 + i * 0.004 * Rain.amt.x;
}

fn rainFlash(nrm: vec3f) -> vec3f {
  let flash = Rain.amt.z;
  if (flash < 0.01 || Rain.bolt.w < 0.5) { return vec3f(0.0); }
  let bolt = normalize(vec3f(Rain.bolt.x, 0.22, Rain.bolt.y));
  let fill = 0.28 + 0.72 * max(dot(nrm, bolt), 0.0);
  return vec3f(0.62, 0.74, 1.0) * flash * fill * 0.85;
}
`;

export const RAIN_SKY = RAIN_STRUCT + /* wgsl */ `
@group(0) @binding(5) var<uniform> Rain: RainU;

fn rainBolt(dir: vec3f) -> vec3f {
  if (Rain.bolt.w < 0.5 || Rain.amt.z < 0.015) { return vec3f(0.0); }
  let horiz = normalize(dir.xz + vec2f(1e-5, 0.0));
  let aim = normalize(Rain.bolt.xy + vec2f(1e-5, 0.0));
  let ang = acos(clamp(dot(horiz, aim), -1.0, 1.0));
  let yq = floor(dir.y * 46.0 + Rain.bolt.z);
  let jag = (fract(sin(yq * 91.73) * 43758.5453) - 0.5) * 0.10;
  let above = smoothstep(-0.04, 0.03, dir.y) * smoothstep(0.94, 0.28, dir.y);
  let d = abs(ang - jag);
  let core = exp(-d * d / 0.00028) * above;
  let glow = exp(-d * d / 0.009) * above;
  let branch = exp(-abs(ang - jag - 0.11) * 26.0) * smoothstep(0.04, 0.18, dir.y) * smoothstep(0.62, 0.22, dir.y);
  return vec3f(0.75, 0.84, 1.0) * (core * 22.0 + glow * 1.15 + branch * 3.2) * Rain.amt.z;
}

fn applyRainSky(dir: vec3f, L: vec3f) -> vec3f {
  var o = L * mix(1.0, 0.46, Rain.atmo.z) * mix(1.0, Rain.atmo.y, 0.72);
  o += rainBolt(dir);
  // A cool lift, kept under the bolt so the strike stays visible after tonemap.
  o += vec3f(0.55, 0.68, 1.0) * Rain.amt.z * 0.42;
  return o;
}
`;
