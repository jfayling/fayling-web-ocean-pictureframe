// Physically based atmosphere (Hillaire 2020 style LUTs) + procedural cloud deck.
import { FRAME_WGSL, ATMO_CORE_WGSL, NOISE_WGSL, SKY_W, SKY_H, ENV_SIZE } from './common.js';

const ATMO_UNIFORM = /* wgsl */ `
struct AtmoP { haze: vec4f };   // x = mie multiplier
@group(0) @binding(0) var<uniform> A: AtmoP;
`;

export const TRANS_LUT = ATMO_CORE_WGSL + ATMO_UNIFORM + /* wgsl */ `
@group(0) @binding(1) var dst: texture_storage_2d<rgba16float, write>;
@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) id: vec3u) {
  if (f32(id.x) >= TRANS_W || f32(id.y) >= TRANS_H) { return; }
  let uv = (vec2f(id.xy) + 0.5) / vec2f(TRANS_W, TRANS_H);
  let rm = transUVToRMu(uv);
  let ro = vec3f(0.0, rm.x, 0.0);
  let rd = vec3f(sqrt(max(0.0, 1.0 - rm.y * rm.y)), rm.y, 0.0);
  let tMax = raySphere(ro, rd, RT).y;
  var od = vec3f(0.0);
  let STEPS = 64u;
  let dt = tMax / f32(STEPS);
  for (var i = 0u; i < STEPS; i++) {
    let p = ro + rd * ((f32(i) + 0.5) * dt);
    od += medium(length(p) - RG, A.haze.x).ext * dt;
  }
  textureStore(dst, id.xy, vec4f(exp(-od), 1.0));
}
`;

export const MS_LUT = ATMO_CORE_WGSL + ATMO_UNIFORM + /* wgsl */ `
@group(0) @binding(1) var transLUT: texture_2d<f32>;
@group(0) @binding(2) var sampC: sampler;
@group(0) @binding(3) var dst: texture_storage_2d<rgba16float, write>;

fn sampleTrans(r: f32, mu: f32) -> vec3f {
  return textureSampleLevel(transLUT, sampC, transRMuToUV(r, mu), 0.0).rgb;
}

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) id: vec3u) {
  if (f32(id.x) >= MS_SIZE || f32(id.y) >= MS_SIZE) { return; }
  var uv = (vec2f(id.xy) + 0.5) / MS_SIZE;
  uv = vec2f(fromSubUvsToUnit(uv.x, MS_SIZE), fromSubUvsToUnit(uv.y, MS_SIZE));
  let cosSun = uv.x * 2.0 - 1.0;
  let h = max(uv.y * (RT - RG), 0.01);
  let r = RG + h;
  let ro = vec3f(0.0, r, 0.0);
  let sun = vec3f(sqrt(max(0.0, 1.0 - cosSun * cosSun)), cosSun, 0.0);
  var Lsum = vec3f(0.0);
  var Fsum = vec3f(0.0);
  let SQ = 8u;
  let STEPS = 20u;
  for (var a = 0u; a < SQ; a++) {
    for (var b = 0u; b < SQ; b++) {
      let th = acos(1.0 - 2.0 * (f32(b) + 0.5) / f32(SQ));
      let ph = 2.0 * PI * (f32(a) + 0.5) / f32(SQ);
      let rd = vec3f(sin(th) * cos(ph), cos(th), sin(th) * sin(ph));
      let tTop = raySphere(ro, rd, RT);
      let tGr = raySphere(ro, rd, RG);
      var tMax = tTop.y;
      let hitG = tGr.x > 0.0;
      if (hitG) { tMax = tGr.x; }
      let dt = tMax / f32(STEPS);
      var T = vec3f(1.0);
      var L = vec3f(0.0);
      var Fms = vec3f(0.0);
      for (var s = 0u; s < STEPS; s++) {
        let p = ro + rd * ((f32(s) + 0.5) * dt);
        let pr = length(p);
        let m = medium(pr - RG, A.haze.x);
        let scat = m.rayS + vec3f(m.mieS);
        let Ts = exp(-m.ext * dt);
        let smu = dot(p, sun) / pr;
        var sunT = sampleTrans(pr, smu);
        if (sunBelowHorizon(pr, smu)) { sunT = vec3f(0.0); }
        let ext = max(m.ext, vec3f(1e-9));
        let S = scat * sunT / (4.0 * PI);
        L += T * (S - S * Ts) / ext;
        Fms += T * (scat - scat * Ts) / ext;
        T *= Ts;
      }
      if (hitG) {
        let pg = ro + rd * tMax;
        let ng = normalize(pg);
        let smu = dot(ng, sun);
        L += T * sampleTrans(RG, smu) * max(smu, 0.0) * 0.06 / PI;
      }
      Lsum += L;
      Fsum += Fms;
    }
  }
  let invN = 1.0 / f32(SQ * SQ);
  let L2 = Lsum * invN;
  let fms = Fsum * invN;
  textureStore(dst, id.xy, vec4f(L2 / (1.0 - fms), 1.0));
}
`;

// Sky-view LUT, recomputed every frame (sun / camera altitude may change).
export const SKYVIEW_LUT = FRAME_WGSL + ATMO_CORE_WGSL + /* wgsl */ `
@group(0) @binding(0) var<uniform> F: Frame;
@group(0) @binding(1) var transLUT: texture_2d<f32>;
@group(0) @binding(2) var msLUT: texture_2d<f32>;
@group(0) @binding(3) var sampC: sampler;
@group(0) @binding(4) var dst: texture_storage_2d<rgba16float, write>;
const SKY_W: f32 = ${SKY_W}.0;
const SKY_H: f32 = ${SKY_H}.0;

fn sampleTrans(r: f32, mu: f32) -> vec3f {
  return textureSampleLevel(transLUT, sampC, transRMuToUV(r, mu), 0.0).rgb;
}

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) id: vec3u) {
  if (f32(id.x) >= SKY_W || f32(id.y) >= SKY_H) { return; }
  var uv = (vec2f(id.xy) + 0.5) / vec2f(SKY_W, SKY_H);
  uv = vec2f(fromSubUvsToUnit(uv.x, SKY_W), fromSubUvsToUnit(uv.y, SKY_H));
  let haze = F.atmo.x;
  let r = RG + F.atmo.y;
  let vHorizon = rhoOf(r);
  let cosBeta = vHorizon / r;
  let beta = acos(clamp(cosBeta, -1.0, 1.0));
  let zha = PI - beta;
  var vza: f32;
  if (uv.y < 0.5) {
    var coord = 2.0 * uv.y;
    coord = 1.0 - coord;
    coord *= coord;
    coord = 1.0 - coord;
    vza = zha * coord;
  } else {
    var coord = uv.y * 2.0 - 1.0;
    coord *= coord;
    vza = zha + beta * coord;
  }
  let vzc = cos(vza);
  let vzs = sin(vza);
  let cx = uv.x * uv.x;
  let lvc = -(cx * 2.0 - 1.0);
  let lvs = sqrt(max(0.0, 1.0 - lvc * lvc));
  let rd = vec3f(vzs * lvc, vzc, vzs * lvs);
  let smu = F.sunDir.y;
  let sun = vec3f(sqrt(max(0.0, 1.0 - smu * smu)), smu, 0.0);
  let ro = vec3f(0.0, r, 0.0);

  let tTop = raySphere(ro, rd, RT);
  let tGr = raySphere(ro, rd, RG);
  var tMax = tTop.y;
  if (tGr.x > 0.0) { tMax = tGr.x; }
  let cosT = dot(rd, sun);
  let pR = phaseRayleigh(cosT);
  let pM = phaseMie(cosT, 0.84);
  var L = vec3f(0.0);
  var T = vec3f(1.0);
  let STEPS = 48u;
  var tPrev = 0.0;
  for (var i = 0u; i < STEPS; i++) {
    let fa = (f32(i) + 1.0) / f32(STEPS);
    let tn = tMax * fa * fa;
    let dt = tn - tPrev;
    let t = tPrev + dt * 0.3;
    tPrev = tn;
    let p = ro + rd * t;
    let pr = length(p);
    let h = pr - RG;
    let m = medium(h, haze);
    let pmu = dot(p, sun) / pr;
    var sunT = sampleTrans(pr, pmu);
    if (sunBelowHorizon(pr, pmu)) { sunT = vec3f(0.0); }
    let msuv = vec2f(fromUnitToSubUvs(pmu * 0.5 + 0.5, MS_SIZE), fromUnitToSubUvs(clamp(h / (RT - RG), 0.0, 1.0), MS_SIZE));
    let ms = textureSampleLevel(msLUT, sampC, msuv, 0.0).rgb;
    let S = sunT * (m.rayS * pR + vec3f(m.mieS * pM)) + ms * (m.rayS + vec3f(m.mieS));
    let Ts = exp(-m.ext * dt);
    let ext = max(m.ext, vec3f(1e-9));
    L += T * (S - S * Ts) / ext;
    T *= Ts;
  }
  textureStore(dst, id.xy, vec4f(L, 1.0));
}
`;

// Functions for rendering the sky (background, env cube, ocean fog).
// Requires: F (Frame), transLUT, skyLUT, sampC declared by the including module.
export const SKY_RENDER_FUNCS = NOISE_WGSL + /* wgsl */ `
const SKY_W: f32 = ${SKY_W}.0;
const SKY_H: f32 = ${SKY_H}.0;

fn camR() -> f32 { return RG + F.atmo.y; }

fn sampleTrans(r: f32, mu: f32) -> vec3f {
  return textureSampleLevel(transLUT, sampC, transRMuToUV(r, mu), 0.0).rgb;
}

fn sunIlluminance() -> vec3f {
  return sampleTrans(camR(), F.sunDir.y) * F.sunDir.w;
}

fn skyViewUV(dir: vec3f) -> vec2f {
  let r = camR();
  let vHorizon = rhoOf(r);
  let cosBeta = vHorizon / r;
  let beta = acos(clamp(cosBeta, -1.0, 1.0));
  let zha = PI - beta;
  let vzc = clamp(dir.y, -1.0, 1.0);
  var uv: vec2f;
  if (vzc >= -cosBeta) {
    var coord = acos(vzc) / zha;
    coord = 1.0 - coord;
    coord = sqrt(max(coord, 0.0));
    coord = 1.0 - coord;
    uv.y = coord * 0.5;
  } else {
    var coord = (acos(vzc) - zha) / beta;
    coord = sqrt(max(coord, 0.0));
    uv.y = coord * 0.5 + 0.5;
  }
  let dl = length(dir.xz);
  let sl = length(F.sunDir.xz);
  var lvc = 1.0;
  if (dl > 1e-6 && sl > 1e-6) { lvc = clamp(dot(dir.xz, F.sunDir.xz) / (dl * sl), -1.0, 1.0); }
  uv.x = sqrt(max(-lvc * 0.5 + 0.5, 0.0));
  return vec2f(fromUnitToSubUvs(uv.x, SKY_W), fromUnitToSubUvs(uv.y, SKY_H));
}

fn skyAtmo(dir: vec3f) -> vec3f {
  return textureSampleLevel(skyLUT, sampC, skyViewUV(dir), 0.0).rgb * F.sunDir.w;
}
`;

// Clouds + full sky radiance (needs the same bindings as SKY_RENDER_FUNCS).
export const SKY_CLOUD_FUNCS = /* wgsl */ `

// ---- clouds -------------------------------------------------------------
// Two thin, light-aware layers: broken low cumulus with cauliflower edges (2 km) and
// high cirrus wisps (7 km). Each is shaded with self-shadowing towards the sun, bright
// sun-facing rims, silver linings on thin back-lit parts and warm multiple scattering.
// Signed "edge" functions (cloud where > 0) and their density ramps. The edge value is
// what the sky pass differentiates (fwidth) to anti-alias the cloud silhouettes analytically.
// Shape evolution is a generation clock. Each generation crossfades the domain warp to a
// new offset so a mass bulges, splits, and merges. Harmonics must be integers: the clock
// wraps at CLOUD_MORPH_WRAP, and an integer multiple lands on the same boundary.
const CLOUD_MORPH_WRAP: u32 = 4096u;
fn morphOffset(gen: f32, salt: u32) -> vec2f {
  let idx = u32(gen) % CLOUD_MORPH_WRAP;
  let n = pcgHash(idx + salt);
  let m = pcgHash(idx + salt * 3u + 11u);
  let a = f32(n) * (6.28318530718 / 4294967296.0);
  let r = 1.5 + f32(m & 255u) * (1.5 / 255.0);
  return vec2f(cos(a), sin(a)) * r;
}
fn morphFlow(t: f32, salt: u32) -> vec2f {
  let i = floor(t);
  let f = t - i;
  let u = f * f * (3.0 - 2.0 * f);
  return mix(morphOffset(i, salt), morphOffset(i + 1.0, salt), u);
}
// Scroll is integer kilometres plus a fraction, so the noise lattice stays exact after a
// time lapse has carried the field far past what an f32 coordinate can resolve.
struct Axis { i: i32, f: f32 }
struct Pos { x: Axis, y: Axis }

fn gnoiseCell(cell: vec2i, f: vec2f) -> f32 {
  let u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  let a = dot(hashGrad(cell), f);
  let b = dot(hashGrad(cell + vec2i(1, 0)), f - vec2f(1.0, 0.0));
  let c = dot(hashGrad(cell + vec2i(0, 1)), f - vec2f(0.0, 1.0));
  let d = dot(hashGrad(cell + vec2i(1, 1)), f - vec2f(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}
fn mulWide(a: u32, b: u32) -> vec2u {
  let a0 = a & 0xFFFFu;
  let a1 = a >> 16u;
  let b0 = b & 0xFFFFu;
  let b1 = b >> 16u;
  let p00 = a0 * b0;
  let p01 = a0 * b1;
  let p10 = a1 * b0;
  let p11 = a1 * b1;
  let mid = (p00 >> 16u) + (p01 & 0xFFFFu) + (p10 & 0xFFFFu);
  let lo = (p00 & 0xFFFFu) | ((mid & 0xFFFFu) << 16u);
  let hi = p11 + (p01 >> 16u) + (p10 >> 16u) + (mid >> 16u);
  return vec2u(lo, hi);
}
fn addWide(a: vec2u, b: vec2u) -> vec2u {
  let lo = a.x + b.x;
  let hi = a.y + b.y + select(0u, 1u, lo < a.x);
  return vec2u(lo, hi);
}
fn mulSigned(i: i32, m: u32) -> vec2u {
  if (i >= 0) { return mulWide(u32(i), m); }
  let w = mulWide(u32(-i), m);
  let lo = ~w.x + 1u;
  let hi = ~w.y + select(0u, 1u, lo == 0u);
  return vec2u(lo, hi);
}
fn axisMul(a: Axis, s: f32) -> Axis {
  let neg = s < 0.0;
  let mag = select(s, -s, neg);
  let sq = u32(mag * 1048576.0 + 0.5);
  var bits = mulSigned(a.i, sq);
  let fq = u32(clamp(a.f, 0.0, 0.999999) * 1048576.0);
  let extra = mulWide(fq, sq);
  bits = addWide(bits, vec2u((extra.y << 12u) | (extra.x >> 20u), extra.y >> 20u));
  if (neg) {
    let lo = ~bits.x + 1u;
    let hi = ~bits.y + select(0u, 1u, lo == 0u);
    bits = vec2u(lo, hi);
  }
  return Axis(bitcast<i32>((bits.y << 12u) | (bits.x >> 20u)), f32(bits.x & 1048575u) * (1.0 / 1048576.0));
}
fn axisAdd(a: Axis, b: Axis) -> Axis {
  var i = a.i + b.i;
  var f = a.f + b.f;
  if (f >= 1.0) { f -= 1.0; i += 1; }
  return Axis(i, f);
}
fn axisAddf(a: Axis, c: f32) -> Axis {
  let n = i32(floor(c));
  return axisAdd(a, Axis(n, c - f32(n)));
}
fn axisSub(q: f32, si: i32, sf: f32) -> Axis {
  let qi = i32(floor(q));
  var i = qi - si;
  var f = (q - f32(qi)) - sf;
  if (f < 0.0) { f += 1.0; i -= 1; }
  return Axis(i, f);
}
fn posScale(p: Pos, sx: f32, sy: f32) -> Pos { return Pos(axisMul(p.x, sx), axisMul(p.y, sy)); }
fn posAdd(p: Pos, v: vec2f) -> Pos { return Pos(axisAddf(p.x, v.x), axisAddf(p.y, v.y)); }
fn posRot(p: Pos) -> Pos {
  return Pos(
    axisAdd(axisMul(p.x, 0.8), axisMul(p.y, -0.6)),
    axisAdd(axisMul(p.x, 0.6), axisMul(p.y, 0.8))
  );
}
fn posNoise(p: Pos) -> f32 { return gnoiseCell(vec2i(p.x.i, p.y.i), vec2f(p.x.f, p.y.f)); }
fn layerPos(q: vec2f, low: bool) -> Pos {
  let ix = select(F.cloudKm.z, F.cloudKm.x, low);
  let iz = select(F.cloudKm.w, F.cloudKm.y, low);
  let fx = select(F.cloudHigh.x, F.cloudWind.x, low);
  let fz = select(F.cloudHigh.y, F.cloudWind.y, low);
  return Pos(axisSub(q.x, ix, fx), axisSub(q.y, iz, fz));
}
fn noiseAt(world: Pos, sx: f32, sy: f32, offset: vec2f) -> f32 {
  return posNoise(posAdd(posScale(world, sx, sy), offset));
}
fn cloudFbmHp(p: Pos, fp: f32, oct: i32, billow: f32) -> f32 {
  var s = 0.0;
  var a = 0.5;
  var q = p;
  var freq = 1.0;
  for (var i = 0; i < oct; i++) {
    let w = 1.0 - smoothstep(0.08, 0.28, fp * freq);
    var n = posNoise(q);
    if (i >= 2) { n = mix(n, abs(n) * 2.0 - 0.38, billow); }
    s += a * n * w;
    q = posAdd(posScale(posRot(q), 2.03, 2.03), vec2f(13.1, 7.7));
    freq *= 2.03;
    a *= 0.5;
  }
  return s;
}
fn lowEdge(q: vec2f, fp: f32, oct: i32) -> f32 {
  let scale = max(F.cloudShape.x, 0.1);
  // Scroll and evolution are integrated offsets, so a wind change cannot teleport the layer.
  let world = layerPos(q, true);
  let k = 0.38 / scale;
  var p = posScale(world, k, k);
  let morphT = F.cloudWind.w;
  // Detail churns several times per large-mass generation.
  let detail = morphFlow(morphT * 6.0, 17u);
  let w = vec2f(
    noiseAt(p, 0.3, 0.3, detail + vec2f(1.7, 9.2)),
    noiseAt(p, 0.3, 0.3, vec2f(detail.y, -detail.x) + vec2f(8.3, 2.8))
  );
  p = posAdd(p, w * 1.4);
  // slightly elongated cells (cloud streets), mildly billowy small scales for ragged edges
  let base = cloudFbmHp(posScale(p, 1.0, 1.7), fp * 0.65 / scale, oct, 0.35) * 1.3 + 0.5;
  let lf = 0.05 / scale;
  let form = morphFlow(morphT * 2.0, 29u);
  let lw = vec2f(
    noiseAt(world, lf * 0.5, lf * 0.5, form + vec2f(4.2, 1.1)),
    noiseAt(world, lf * 0.5, lf * 0.5, vec2f(form.y, -form.x) + vec2f(8.8, 2.4))
  );
  let large = noiseAt(world, lf, lf, lw * 0.9 + vec2f(3.1, 1.3)) * 0.7;
  return base + large - (1.0 - F.cloudP.y);
}
fn lowSoft(fp: f32) -> f32 { return (0.38 + min(fp * 0.65, 1.0) * 0.3) * F.cloudShape.z; }
fn lowDensity(q: vec2f, fp: f32, oct: i32) -> f32 {
  return clamp(lowEdge(q, fp, oct) / lowSoft(fp), 0.0, 1.0);
}
fn highEdge(q: vec2f, fp: f32, oct: i32) -> f32 {
  let scale = max(F.cloudHigh.w, 0.1);
  let world = layerPos(q, false);
  let morphT = F.cloudWind.w;
  // altostratus deck: smooth, slightly fibrous, and slower to reshape than the cumulus
  let fiber = morphFlow(morphT * 2.0, 47u);
  let p = posAdd(posRot(posScale(world, 0.09 / scale, 0.20 / scale)), fiber);
  let n = cloudFbmHp(p, fp * 0.2 / scale, oct, 0.0) * 1.25 + 0.5;
  let hf = 0.012 / scale;
  let form = morphFlow(morphT, 71u);
  let hw = vec2f(
    noiseAt(world, hf * 0.45, hf * 0.45, form * 0.8 + vec2f(2.2, 6.1)),
    noiseAt(world, hf * 0.45, hf * 0.45, vec2f(form.y, -form.x) * 0.8 + vec2f(7.4, 1.6))
  );
  let big = noiseAt(world, hf, hf, hw * 0.7 + vec2f(7.0, 3.0)) * 0.6;
  return n + big - (1.0 - F.atmo.z);
}
fn highSoft(fp: f32) -> f32 { return (0.85 + min(fp * 0.2, 1.0) * 0.3) * F.cloudShape.z; }
fn highDensity(q: vec2f, fp: f32, oct: i32) -> f32 {
  return clamp(highEdge(q, fp, oct) / highSoft(fp), 0.0, 1.0);
}

struct CloudHit { t: f32, q: vec2f, mu: f32, up: vec3f };
fn hitLayer(dir: vec3f, hc: f32) -> CloudHit {
  var h: CloudHit;
  let ro = vec3f(0.0, camR(), 0.0);
  h.t = raySphere(ro, dir, RG + hc).y;
  let p = ro + dir * h.t;
  h.up = p / length(p);
  h.q = p.xz + F.camPos.xz * 0.001;
  h.mu = max(dot(h.up, dir), 0.03);
  return h;
}

// d: density at the hit; s1..s3: densities 80 m / 250 m / 600 m towards the sun
fn shadeLayer(dir: vec3f, h: CloudHit, hc: f32, d: f32, s1: f32, s2: f32, s3: f32, sigma: f32, g: f32) -> vec4f {
  let tau = d * sigma / h.mu;
  let alpha = 1.0 - exp(-tau);
  let tauS = (d * 0.5 + s1 * 0.6 + s2 + s3 * 0.7) * sigma * 0.55;
  let Ts = exp(-tauS);
  // Direct sun on the deck fades out just below the horizon. The transmittance of a
  // sun that has already set is a dim red, and it was drawing a rim on night clouds.
  let sunC = sampleTrans(RG + hc, dot(h.up, F.sunDir.xyz)) * F.sunDir.w * smoothstep(-0.06, 0.04, F.sunDir.y);
  let cosT = dot(dir, F.sunDir.xyz);
  let ph = mix(phaseHG(cosT, g), phaseHG(cosT, -0.2), 0.25);
  let fwd = smoothstep(-0.2, 0.7, cosT);
  // single scattering: reflected when front-lit, transmitted through thin parts when back-lit
  let single = sunC * Ts * ph * mix(alpha * 0.55, tau * exp(-tau) * 2.2, fwd) * 3.0;
  // edges where density falls off towards the sun catch direct light
  let rim = clamp((d - s1) * 2.5, 0.0, 1.0);
  // multiple scattering: a low sun lights cloud tops and sun-facing flanks, not the bases we
  // see from below, so diffused sunlight shows mostly when looking towards the sun
  let toward = smoothstep(-0.3, 0.9, cosT);
  let ms = sunC * (0.025 + 0.22 * rim * F.cloudLight.z) * mix(1.0, Ts, 0.5) * alpha * (0.25 + 0.75 * toward);
  // bases are lit by the sky from the sides/below (horizon band + sea), cooler than the tops
  let amb = (skyAtmo(normalize(vec3f(dir.x, 0.03, dir.z))) * 0.26 + skyAtmo(vec3f(0.0, 1.0, 0.0)) * 0.42)
            * alpha * (1.0 - 0.35 * d) * F.cloudLight.w;
  // After dark the sun and the sky LUT go black. A cool ambient keeps the cloud body
  // readable with no moon, and moonlight brightens the faces turned toward the moon.
  let night = 1.0 - smoothstep(-0.05, 0.16, F.sunDir.y);
  var nightLit = vec3f(0.0);
  if (night > 0.001) {
    let moon = normalize(F.moonDir.xyz);
    let phase = 0.5 * (1.0 + dot(normalize(F.moonLight.xyz), -moon));
    let moonUp = smoothstep(-0.04, 0.12, moon.y) * step(0.001, F.moonDir.w);
    let moonE = F.moonDir.w * phase * moonUp;
    let towardMoon = smoothstep(-0.4, 0.85, dot(dir, moon));
    let cool = vec3f(0.62, 0.70, 0.88);
    let fill = (0.045 + 0.020 * moonE) * (1.0 - 0.35 * d);
    let edge = 0.014 * moonE * (0.35 + 0.65 * towardMoon) * (0.35 + 0.65 * rim) * Ts;
    nightLit = cool * (fill + edge) * alpha * F.cloudLight.w * night;
  }
  return vec4f(single + ms + amb + nightLit, alpha);
}

// returns (premultiplied radiance, fraction of the background sky hidden)
// aa: per-layer edge change per pixel (fwidth of the edge function); negative = estimate it
// from the pixel footprint (compute passes, which have no derivatives)
fn cloudLayers(dir: vec3f, pixAng: f32, aa: vec2f, sunT: ptr<function, f32>) -> vec4f {
  *sunT = 1.0;
  if (dir.y <= 0.0) { return vec4f(0.0); }
  let sxz = F.sunDir.xz / max(length(F.sunDir.xz), 1e-4);
  var lo = vec4f(0.0);
  var loVis = 1.0;
  if (F.cloudP.y > 0.001) {
    let hc = F.cloudP.x;
    let h = hitLayer(dir, hc);
    // clear band near the horizon, where the low sun shines under the clouds
    let far = 1.0 - smoothstep(18.0, 36.0, h.t);
    if (far > 0.0) {
      let fp = h.t * pixAng / h.mu;
      let e = lowEdge(h.q, fp, 7);
      let d = clamp(e / lowSoft(fp), 0.0, 1.0) * far;
      if (d > 0.002) {
        let s1 = lowDensity(h.q + sxz * 0.08, fp, 5) * far;
        let s2 = lowDensity(h.q + sxz * 0.25, fp, 4) * far;
        let s3 = lowDensity(h.q + sxz * 0.6, fp, 3) * far;
        lo = shadeLayer(dir, h, hc, d, s1, s2, s3, F.cloudLight.x, 0.75);
        // opacity saturates within a sliver of the density ramp, making a hard silhouette:
        // spread it over ~1.5 pixels
        let aw = select(fp * 0.38 * 2.5, aa.x, aa.x >= 0.0) * F.cloudShape.z;
        lo *= smoothstep(0.0, aw * 1.5 + 1e-6, e);
        loVis = exp(-h.t * 0.02 * (0.6 + 0.4 * F.atmo.x));
      }
    }
  }
  var hi = vec4f(0.0);
  var hiVis = 1.0;
  if (F.atmo.z > 0.001) {
    let hc = F.cloudShape.y;
    let h = hitLayer(dir, hc);
    let far = 1.0 - smoothstep(30.0, 70.0, h.t);
    if (far > 0.0) {
      let fp = h.t * pixAng / h.mu;
      let e = highEdge(h.q, fp, 6);
      let d = clamp(e / highSoft(fp), 0.0, 1.0) * far;
      if (d > 0.002) {
        let s1 = highDensity(h.q + sxz * 0.15, fp, 4) * far;
        let s2 = highDensity(h.q + sxz * 0.5, fp, 3) * far;
        hi = shadeLayer(dir, h, hc, d, s1, s2, s2, F.cloudLight.y, 0.80);
        let aw = select(fp * 0.2 * 2.5, aa.y, aa.y >= 0.0) * F.cloudShape.z;
        hi *= smoothstep(0.0, aw * 1.5 + 1e-6, e);
        hiVis = exp(-h.t * 0.010 * (0.6 + 0.4 * F.atmo.x));
      }
    }
  }
  *sunT = (1.0 - lo.a) * (1.0 - hi.a);
  // low layer in front; aerial perspective fades each layer into the haze without making
  // it transparent to the layer behind, or to the stars
  let col = lo.rgb * loVis + hi.rgb * hiVis * (1.0 - lo.a);
  let cover = lo.a + hi.a * (1.0 - lo.a);
  // The fade used to lower coverage, which let stars shine through solid clouds.
  // Put the missing atmosphere back into the color and keep the geometric coverage.
  let haze = skyAtmo(dir) * (lo.a * (1.0 - loVis) + hi.a * (1.0 - lo.a) * (1.0 - hiVis));
  return vec4f(col + haze, cover);
}

fn sunDisk(dir: vec3f) -> vec3f {
  if (F.sunDir.y <= -0.01) { return vec3f(0.0); }
  let c = dot(dir, F.sunDir.xyz);
  let ang = sqrt(max(2.0 * (1.0 - c), 0.0));
  let pix = F.screen.w * 2.0 * length(F.camUp.xyz) * 0.75;
  let edge = 1.0 - smoothstep(SUN_ANG_R - pix, SUN_ANG_R + pix, ang);
  if (edge <= 0.0) { return vec3f(0.0); }
  let x = min(ang / SUN_ANG_R, 1.0);
  let mu = sqrt(max(1.0 - x * x, 0.0));
  let limb = vec3f(1.0) - vec3f(0.397, 0.503, 0.652) * (1.0 - mu);
  let rad = F.sunDir.w / (PI * SUN_ANG_R * SUN_ANG_R);
  return rad * limb * edge * sampleTrans(camR(), max(dir.y, -0.01));
}

// Point-sample the star id. Linear filtering would blend neighbouring rhythms;
// the 2x2 under the sample is the same footprint the colour lookup uses.
fn starMark(uv: vec2f) -> f32 {
  let dims = vec2i(textureDimensions(starMap));
  let base = vec2i(floor(uv * vec2f(dims) - 0.5));
  var best = 0.0;
  for (var j = 0; j <= 1; j++) {
    for (var i = 0; i <= 1; i++) {
      var c = base + vec2i(i, j);
      c.x = (c.x % dims.x + dims.x) % dims.x;
      c.y = clamp(c.y, 0, dims.y - 1);
      best = max(best, textureLoad(starMap, c, 0).a);
    }
  }
  return best;
}

// Atmospheric scintillation. A point source flickers more as its line of sight
// crosses a thicker slab of turbulent air, and low bright stars shift colour.
// Frequencies are an integer number of cycles over the 600 s simulation loop,
// so the wrap does not pop. The environment cube asks for the mean (scintillate
// false) because a face is rebuilt only every few frames.
fn starScintillation(dir: vec3f, id: f32, peak: f32) -> vec3f {
  let elev = asin(clamp(dir.y, 0.0, 1.0)) * 57.2957795;
  let air = min(12.0, 1.0 / (max(dir.y, 0.0) + 0.50572 * pow(elev + 6.07995, -1.6364)));
  let sigma = min(0.88, F.nightP.z * 0.055 * pow(air, 1.22));
  let n = u32(id * 255.0 + 0.5);
  let h1 = pcgHash(n);
  let h2 = pcgHash(h1 ^ 0x9e3779b9u);
  let h3 = pcgHash(h2 ^ 0x85ebca6bu);
  let p1 = f32(h1) * (6.28318530718 / 4294967296.0);
  let p2 = f32(h2) * (6.28318530718 / 4294967296.0);
  let p3 = f32(h3) * (6.28318530718 / 4294967296.0);
  // A slow function of direction, so stars that share an 8-bit id still diverge,
  // while one splat (a fraction of a degree) stays in phase with itself.
  let sight = dot(dir, vec3f(4.0, 9.0, 2.0));
  let t = F.camPos.w;
  let burst = 0.62 + 0.38 * sin(t * (6.28318530718 * 0.35) + p1 + sight);
  let flick = sin(t * (6.28318530718 * 2.3) + p2 + sight) * 0.56
            + sin(t * (6.28318530718 * 3.7) + p3 + sight) * 0.30
            + sin(t * (6.28318530718 * 6.1) + p1 + sight) * 0.14;
  let flicker = 1.0 + sigma * burst * flick;
  let chroma = sigma * 0.5 * smoothstep(1.8, 5.5, air) * smoothstep(0.22, 0.8, peak);
  let tint = vec3f(
    sin(t * (6.28318530718 * 2.9) + p2 + sight),
    sin(t * (6.28318530718 * 2.9) + p3 + sight + 2.094395),
    sin(t * (6.28318530718 * 2.9) + p1 + sight + 4.188790)
  );
  return max(vec3f(0.05), vec3f(flicker) + tint * chroma);
}

fn starField(dir: vec3f, pixAng: f32, scintillate: bool) -> vec3f {
  let night = 1.0 - smoothstep(-0.15, -0.055, F.sunDir.y);
  if (night <= 0.0 || dir.y <= 0.0 || F.nightP.x <= 0.0) { return vec3f(0.0); }
  let eq = vec3f(dot(dir, F.starX.xyz), dot(dir, F.starY.xyz), dot(dir, F.moonUp.xyz));
  let uv = vec2f(fract(atan2(eq.y, eq.x) / (2.0 * PI) + 1.0),
                 0.5 - asin(clamp(eq.z, -1.0, 1.0)) / PI);
  let stars = textureSampleLevel(starMap, sampC, uv, 0.0).rgb;
  let gain = 0.35 + 2.65 * smoothstep(0.0, 0.35, F.nightP.x);
  // The default density keeps every catalog star. Lower values let faint stars disappear first.
  let cutoff = mix(0.48, 0.0, smoothstep(0.08, 0.55, F.nightP.x));
  let peak = max(stars.r, max(stars.g, stars.b));
  let keep = select(1.0, smoothstep(cutoff, min(cutoff + 0.07, 1.0), peak), cutoff > 0.001);
  let extinction = sampleTrans(camR(), max(dir.y, 0.0));
  let col = stars * gain * keep * F.nightP.y * night * extinction;
  if (!scintillate || F.nightP.z <= 0.001 || peak <= 0.001) { return col; }
  return col * starScintillation(dir, starMark(uv), peak);
}

const MOON_ANG_R: f32 = 0.00452;

fn moonFbm(p: vec2f) -> f32 {
  return gnoise(p) * 0.5 + gnoise(p * 2.1 + vec2f(5.2, 1.3)) * 0.25 +
         gnoise(p * 4.3 + vec2f(1.7, 9.2)) * 0.125 + gnoise(p * 8.7 + vec2f(8.3, 2.8)) * 0.0625;
}

fn mare(p: vec2f, c: vec2f, r: vec2f) -> f32 {
  let d = length((p - c) / r) + moonFbm(p * 5.0 + c * 13.0) * 0.55;
  return 1.0 - smoothstep(0.45, 1.25, d);
}

// Near-side albedo with lunar north up (x = right, y = up, in disc radii).
fn moonAlbedo(p: vec2f) -> f32 {
  var m = 0.0;
  m = max(m, mare(p, vec2f(-0.60, 0.10), vec2f(0.32, 0.58)));  // Oceanus Procellarum
  m = max(m, mare(p, vec2f(-0.26, 0.47), vec2f(0.36, 0.29)));  // Imbrium
  m = max(m, mare(p, vec2f(0.20, 0.38), vec2f(0.19, 0.19)));   // Serenitatis
  m = max(m, mare(p, vec2f(0.36, 0.10), vec2f(0.25, 0.19)));   // Tranquillitatis
  m = max(m, mare(p, vec2f(0.71, 0.29), vec2f(0.13, 0.11)));   // Crisium
  m = max(m, mare(p, vec2f(0.60, -0.14), vec2f(0.14, 0.21)));  // Fecunditatis
  m = max(m, mare(p, vec2f(0.40, -0.27), vec2f(0.11, 0.10)));  // Nectaris
  m = max(m, mare(p, vec2f(-0.17, -0.34), vec2f(0.21, 0.15))); // Nubium
  m = max(m, mare(p, vec2f(-0.51, -0.39), vec2f(0.11, 0.10))); // Humorum
  m = max(m, mare(p, vec2f(-0.02, 0.76), vec2f(0.50, 0.08)));  // Frigoris
  m = max(m, mare(p, vec2f(0.05, 0.05), vec2f(0.10, 0.09)) * 0.7); // Sinus Medii
  // maria vary in tone; highlands are bright and heavily cratered
  m *= 0.8 + 0.25 * moonFbm(p * 9.0 + vec2f(4.0, 7.0));
  var a = mix(1.0, 0.52, clamp(m, 0.0, 1.0));
  a *= 0.92 + 0.09 * moonFbm(p * 22.0) + 0.05 * gnoise(p * 61.0 + vec2f(3.1, 1.7)) * (1.0 - m * 0.6);
  // bright young craters and their ray systems
  let t = p - vec2f(-0.13, -0.72);
  let rays = pow(abs(sin(atan2(t.y, t.x) * 9.0 + 0.7)), 18.0) * exp(-length(t) * 2.6);
  a += 0.5 * exp(-dot(t, t) * 1500.0) + 0.14 * rays * (1.0 - m * 0.5);
  let c = p - vec2f(-0.33, 0.25);
  a += 0.3 * exp(-dot(c, c) * 2000.0);
  let k = p - vec2f(-0.65, 0.13);
  a += 0.25 * exp(-dot(k, k) * 2400.0);
  return a;
}

// Returns radiance and how much of the background the disc hides.
fn moonDisk(dir: vec3f, pixAng: f32) -> vec4f {
  if (F.moonDir.y <= -0.02 || F.moonDir.w <= 0.0) { return vec4f(0.0); }
  let moon = normalize(F.moonDir.xyz);
  let radius = MOON_ANG_R * F.moonLight.w;
  let cosA = dot(dir, moon);
  if (cosA < cos(radius * 8.0)) { return vec4f(0.0); }
  var up = F.moonUp.xyz - moon * dot(F.moonUp.xyz, moon);
  if (dot(up, up) < 1e-6) { up = vec3f(0.0, 1.0, 0.0) - moon * moon.y; }
  up = normalize(up);
  let right = normalize(cross(moon, up));
  let p = vec2f(dot(dir, right), dot(dir, up)) / radius;
  let dist = length(p);
  let aa = max(pixAng / radius, 0.02);
  let cover = 1.0 - smoothstep(1.0 - aa, 1.0 + aa, dist);
  let sun = normalize(F.moonLight.xyz);
  let illum = 0.5 * (1.0 + dot(sun, -moon));
  // atmospheric extinction reddens and dims the moon low over the horizon
  let ext = sampleTrans(camR(), max(moon.y, 0.0));
  let daylight = smoothstep(-0.04, 0.2, F.sunDir.y);
  // keeps lit highlands just under white after tone mapping so the maria stay readable
  let gain = F.moonDir.w * 0.4 * mix(1.0, 4.0, daylight);
  // faint aureole of scattered moonlight, scaled by how much of the disc is lit
  let halo = illum * 0.025 * exp(-max(dist - 1.0, 0.0) * 0.9) * (1.0 - cover) * (1.0 - daylight);
  var col = vec3f(0.0);
  if (cover > 0.0) {
    let q = p / max(dist, 1.0);
    let mu = sqrt(max(1.0 - dot(q, q), 0.0));
    let n = right * q.x + up * q.y - moon * mu;
    let mu0 = dot(n, sun);
    // Lommel-Seeliger: the regolith shows almost no limb darkening, so the full moon is evenly bright
    // (blended toward flat so the lit side reads at its full extent near the terminator)
    let ls = mix(2.0 * max(mu0, 0.0) / (max(mu0, 0.0) + mu + 1e-4), 1.0, 0.55) * smoothstep(-0.015, 0.04, mu0);
    // earthshine on the night side is strongest near new moon
    let es = 0.01 * pow(1.0 - illum, 3.0) * (1.0 - daylight);
    col = vec3f(1.0, 0.96, 0.9) * moonAlbedo(q) * (ls + es) * cover;
  }
  return vec4f((col + vec3f(0.85, 0.9, 1.0) * halo) * gain * ext, cover);
}

// cover is the cloud's geometric opacity. Lighting can stay soft while a cloud that is
// already visible hides the stars and the moon.
fn nightSky(dir: vec3f, pixAng: f32, cover: f32, scintillate: bool) -> vec3f {
  let night = 1.0 - smoothstep(-0.12, 0.015, F.sunDir.y);
  let base = vec3f(0.002, 0.004, 0.009) * F.nightP.w * night * (0.35 + 0.65 * max(dir.y, 0.0));
  let m = moonDisk(dir, pixAng);
  let starCover = smoothstep(0.015, 0.08, cover);
  let points = (starField(dir, pixAng, scintillate) * (1.0 - m.a) + m.rgb) * (1.0 - starCover);
  return base * (1.0 - cover) + points;
}

fn skyRadiance(dirIn: vec3f, withSun: bool, pixAng: f32) -> vec3f {
  var dir = dirIn;
  dir.y = max(dir.y, 0.0005);
  dir = normalize(dir);
  var L = skyAtmo(dir);
  var sunT = 1.0;
  let cl = cloudLayers(dir, pixAng, vec2f(-1.0), &sunT);
  L = L * (1.0 - cl.a) + cl.rgb;
  L += nightSky(dir, pixAng, cl.a, false);
  if (withSun) { L += sunDisk(dir) * sunT; }
  return L;
}
`;

export const ENV_CUBE = FRAME_WGSL + ATMO_CORE_WGSL + /* wgsl */ `
@group(0) @binding(0) var<uniform> F: Frame;
@group(0) @binding(1) var transLUT: texture_2d<f32>;
@group(0) @binding(2) var skyLUT: texture_2d<f32>;
@group(0) @binding(3) var sampC: sampler;
@group(0) @binding(4) var dst: texture_storage_2d_array<rgba16float, write>;
@group(0) @binding(5) var starMap: texture_2d<f32>;
` + SKY_RENDER_FUNCS + SKY_CLOUD_FUNCS + /* wgsl */ `
const ENV: f32 = ${ENV_SIZE}.0;
fn faceDir(face: u32, uv: vec2f) -> vec3f {
  let u = uv.x * 2.0 - 1.0;
  let v = uv.y * 2.0 - 1.0;
  switch (face) {
    case 0u: { return vec3f(1.0, -v, -u); }
    case 1u: { return vec3f(-1.0, -v, u); }
    case 2u: { return vec3f(u, 1.0, v); }
    case 3u: { return vec3f(u, -1.0, -v); }
    case 4u: { return vec3f(u, -v, 1.0); }
    default: { return vec3f(-u, -v, -1.0); }
  }
}
@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) id: vec3u) {
  if (f32(id.x) >= ENV || f32(id.y) >= ENV) { return; }
  // faces are refreshed round-robin: face = (frame + z) % 6
  let face = (u32(F.post.z) + id.z) % 6u;
  let dir = normalize(faceDir(face, (vec2f(id.xy) + 0.5) / ENV));
  var L: vec3f;
  if (dir.y >= 0.0) {
    L = skyRadiance(dir, false, 1.5708 / ENV * 1.5);
  } else {
    // below the horizon: what a reflected ray would see -> far, hazy ocean
    let hz = skyRadiance(normalize(vec3f(dir.x, 0.004, dir.z)), false, 1.5708 / ENV * 1.5);
    let body = F.waterCol.rgb * (sunIlluminance() * max(F.sunDir.y, 0.0) + skyAtmo(vec3f(0.0, 1.0, 0.0)) * 2.0);
    L = mix(hz * 0.75, body, clamp(-dir.y * 6.0, 0.0, 1.0));
  }
  textureStore(dst, id.xy, face, vec4f(L, 1.0));
}
`;

export const CUBE_MIPS = /* wgsl */ `
@group(0) @binding(0) var src: texture_2d_array<f32>;
@group(0) @binding(1) var dst: texture_storage_2d_array<rgba16float, write>;
@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) id: vec3u) {
  let size = textureDimensions(dst);
  if (id.x >= size.x || id.y >= size.y) { return; }
  let srcSize = vec2i(textureDimensions(src));
  let p = vec2i(id.xy) * 2;
  // 4x4 tent-ish filter for smoother roughness blur
  var acc = vec4f(0.0);
  var wsum = 0.0;
  for (var j = -1; j <= 2; j++) {
    for (var i = -1; i <= 2; i++) {
      let q = clamp(p + vec2i(i, j), vec2i(0), srcSize - 1);
      let w = select(1.0, 3.0, i == 0 || i == 1) * select(1.0, 3.0, j == 0 || j == 1);
      acc += textureLoad(src, q, id.z, 0) * w;
      wsum += w;
    }
  }
  textureStore(dst, id.xy, id.z, acc / wsum);
}
`;

// Cloud transmittance towards the sun (averaged over the solar disc), used to dim
// direct sunlight on the water when the sun is behind clouds.
export const SUN_VIS = FRAME_WGSL + ATMO_CORE_WGSL + /* wgsl */ `
@group(0) @binding(0) var<uniform> F: Frame;
@group(0) @binding(1) var transLUT: texture_2d<f32>;
@group(0) @binding(2) var skyLUT: texture_2d<f32>;
@group(0) @binding(3) var sampC: sampler;
@group(0) @binding(4) var<storage, read_write> sunVis: array<f32, 4>;
@group(0) @binding(5) var starMap: texture_2d<f32>;
` + SKY_RENDER_FUNCS + SKY_CLOUD_FUNCS + /* wgsl */ `
var<workgroup> part: array<f32, 16>;
// 7 rays across the sun and 7 across the moon, then a tiny reduction.
// sunVis[0] is sunlight that reaches the water; sunVis[1] is moonlight.
@compute @workgroup_size(16)
fn main(@builtin(local_invocation_index) k: u32) {
  let sd = F.sunDir.xyz;
  let tx = normalize(cross(sd, vec3f(0.0, 1.0, 0.0)));
  let ty = cross(tx, sd);
  var t = 1.0;
  if (k < 7u) {
    let a = f32(k) * 0.8975979;
    let o = select(vec2f(cos(a), sin(a)) * 0.65, vec2f(0.0), k == 0u);
    let dir = normalize(sd + (tx * o.x + ty * o.y) * SUN_ANG_R);
    let cl = cloudLayers(dir, 0.0, vec2f(-1.0), &t);
  }
  if (k >= 8u && k < 15u) {
    t = 0.0;
    if (F.moonDir.w > 0.0 && F.moonDir.y > 0.0) {
      let md = normalize(F.moonDir.xyz);
      let idx = k - 8u;
      let helper = select(vec3f(1.0, 0.0, 0.0), vec3f(0.0, 1.0, 0.0), abs(md.y) < 0.97);
      let mx = normalize(cross(md, helper));
      let my = cross(mx, md);
      let a = f32(idx) * 0.8975979;
      let o = select(vec2f(cos(a), sin(a)) * 0.65, vec2f(0.0), idx == 0u);
      let dir = normalize(md + (mx * o.x + my * o.y) * MOON_ANG_R * max(F.moonLight.w, 0.0));
      t = 1.0;
      let cl = cloudLayers(dir, 0.0, vec2f(-1.0), &t);
    }
  }
  part[k] = t;
  workgroupBarrier();
  if (k == 0u) {
    var accS = 0.0;
    var accM = 0.0;
    for (var i = 0u; i < 7u; i++) {
      accS += part[i];
      accM += part[8u + i];
    }
    sunVis[0] = accS / 7.0;
    sunVis[1] = accM / 7.0;
  }
}
`;
