// WebGPU ocean — custom renderer.
// FFT ocean (5 cascades) + CDLOD surface mesh + physically based sky + HDR post.
// All per-frame data lives in preallocated typed arrays / descriptors (no per-frame garbage
// apart from the unavoidable swap-chain view and command buffer objects).
import { N, CASCADES, SKY_W, SKY_H, ENV_SIZE, ENV_MIPS } from './wgsl/common.js';
import { SIM_INIT, SIM_EVOLVE, FFT_ROWS, FFT_COLS, SIM_MIPS, FOAM_TEX, RGBA8_MIPS, FOAM_UPDATE, ARRAY16_MIPS, FOAM_RES } from './wgsl/sim.js';
import { TRANS_LUT, MS_LUT, SKYVIEW_LUT, ENV_CUBE, CUBE_MIPS, SUN_VIS } from './wgsl/sky.js';
import { OCEAN, SKY_BG, HEIGHT_PROBE } from './wgsl/ocean.js';
import { BLOOM_DOWN, BLOOM_UP, COMPOSITE } from './wgsl/post.js';
import { createOceanAudio } from './audio.js';
import { celestialState } from './astronomy.js';
import { createStarMapData, STAR_MAP_WIDTH, STAR_MAP_HEIGHT } from './star-catalog.js';
import { createWeatherWidget } from './weather.js';
import { acceptedPlace, rememberChoice, resolvePlace, suggestPlaces } from './place.js';

const qs = new URLSearchParams(location.search);
const DBG = Number(qs.get('dbg')) || 0;
const D2R = Math.PI / 180;
const GU = GPUBufferUsage;
const TU = GPUTextureUsage;

// ----------------------------------------------------------------------------------------
// Tunable parameters (UI panel edits these)
// ----------------------------------------------------------------------------------------
export const P = {
  windSpeed: 7.0,      // m/s at 10 m
  windDir: 118,        // deg, direction waves travel (90 = towards +Z, i.e. towards the viewer)
  fetchKm: 90,
  swellHs: 1.8,        // m significant height
  swellDir: 94,
  swellLength: 120,    // m peak wavelength
  swellSpread: 48,     // cos^2s exponent
  choppy: 1.25,
  turbidity: 1.6,     // water body brightness (coastal sediment / plankton)
  foam: 1.0,
  skyMode: 'dynamic',
  zipCode: '30265',
  skyWhen: '',
  skyLapseStart: '2026-01-01T00:00',
  lapsePace: 20,
  sunElev: 2.6,        // deg
  sunAzim: 4,          // deg (0 = straight ahead of the start view)
  moon: true,
  moonElev: 28,
  moonAzim: -42,
  moonPhase: 0.78,
  moonSize: 2.5,
  moonBrightness: 4,
  stars: true,
  starMode: 'dynamic',
  starDensity: 0.55,
  starBrightness: 1.4,
  starSeed: 137,
  nightBrightness: 1,
  cloudMode: 'dynamic',
  exposure: 1.35,
  haze: 3.0,
  cloudMotion: true,
  cloudWindSpeed: 8,
  cloudWindDir: 118,
  cloudEvolution: 0.35,
  cloudScale: 1,
  cloudAltitude: 2,
  clouds: 0.40,
  cloudDensity: 2.2,
  cloudSoftness: 1,
  highCloudWindSpeed: 22,
  highCloudWindDir: 145,
  highCloudScale: 1,
  highCloudAltitude: 7,
  veil: 0.36,
  highCloudDensity: 0.9,
  cloudSilver: 1,
  cloudAmbient: 1,
  bloom: 0.10,
  audioVolume: 0.7,
  audioRumble: 1,
  audioWash: 1,
  audioHiss: 1,
  audioSync: 1,
  audioStereo: 1,
  sound: false,
  showButtons: true,
  showInfo: false,
  clock: true,
  clock24h: false,
  clockSeconds: false,
  clockDate: true,
  clockStyle: 'modern',
  clockSize: 72,
  clockColor: '#ffffff',
  clockPosition: 'top-center',
  clockOpacity: 0.9,
  clockBackground: 0.18,
  weather: true,
  weatherZip: '30265',
  weatherRefresh: 15,
  weatherUnit: 'fahrenheit',
  weatherPosition: 'bottom-left',
  weatherTemp: true,
  weatherFeels: true,
  weatherPrecip: true,
  weatherHumidity: true,
  weatherWind: true,
  weatherForecast: true,
  weatherAlerts: true,
};
const DEFAULTS = { ...P };
const CASC_L = [1103.0, 211.3, 39.7, 7.43, 1.393, 0.2617];

function fail(msg) {
  const el = document.getElementById('err');
  el.style.display = 'block';
  el.textContent = msg;
  log('FATAL ' + msg);
  throw new Error(msg);
}
function log(msg) {
  console.log(msg);
  // The dev server records this. Anywhere else the POST is rejected and only adds console noise.
  if (location.hostname !== 'localhost' && location.hostname !== '127.0.0.1') return;
  try { fetch('/__log', { method: 'POST', body: String(msg) }).catch(() => {}); } catch (e) { /* offline */ }
}

// ----------------------------------------------------------------------------------------
// Small math helpers writing into preallocated arrays
// ----------------------------------------------------------------------------------------
function mat4Mul(out, a, b) {
  for (let c = 0; c < 4; c++) {
    const b0 = b[c * 4], b1 = b[c * 4 + 1], b2 = b[c * 4 + 2], b3 = b[c * 4 + 3];
    out[c * 4] = a[0] * b0 + a[4] * b1 + a[8] * b2 + a[12] * b3;
    out[c * 4 + 1] = a[1] * b0 + a[5] * b1 + a[9] * b2 + a[13] * b3;
    out[c * 4 + 2] = a[2] * b0 + a[6] * b1 + a[10] * b2 + a[14] * b3;
    out[c * 4 + 3] = a[3] * b0 + a[7] * b1 + a[11] * b2 + a[15] * b3;
  }
}

async function main() {
  if (!navigator.gpu) fail('WebGPU is not available in this browser.');
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
  if (!adapter) fail('No WebGPU adapter found.');
  const hasTS = adapter.features.has('timestamp-query');
  const device = await adapter.requestDevice({
    requiredFeatures: hasTS ? ['timestamp-query'] : [],
  });
  device.lost.then((i) => log('device lost: ' + i.message));
  device.onuncapturederror = (e) => log('GPU error: ' + e.error.message);

  const canvas = document.getElementById('c');
  let soundControl = null;
  const oceanAudio = createOceanAudio(document.getElementById('sound'), (on) => {
    P.sound = on;
    rememberSettings();
    if (!soundControl) return;
    soundControl.input.checked = on;
    soundControl.output.textContent = on ? 'On' : 'Off';
  });
  const ctx = canvas.getContext('webgpu');
  const swapFormat = navigator.gpu.getPreferredCanvasFormat();
  ctx.configure({ device, format: swapFormat, alphaMode: 'opaque', usage: TU.RENDER_ATTACHMENT | TU.COPY_SRC });

  async function shader(code, label) {
    const m = device.createShaderModule({ code, label });
    const info = await m.getCompilationInfo();
    let bad = false;
    for (const msg of info.messages) {
      if (msg.type === 'error') bad = true;
      if (msg.type !== 'info') {
        const line = code.split('\n')[msg.lineNum - 1];
        log(`[${label}] ${msg.type} ${msg.lineNum}:${msg.linePos} ${msg.message}\n    ${line}`);
      }
    }
    if (bad) fail('Shader compile error in ' + label + ' (see console)');
    return m;
  }
  async function computePipe(code, label) {
    const module = await shader(code, label);
    return device.createComputePipelineAsync({ label, layout: 'auto', compute: { module, entryPoint: 'main' } });
  }

  // --------------------------------------------------------------------------------------
  // Simulation resources
  // --------------------------------------------------------------------------------------
  const C = CASCADES;
  const SIM_MIP_COUNT = Math.log2(N) + 1;
  const specBytes = N * N * C * 16;
  const mkBuf = (size, usage, label) => device.createBuffer({ size, usage, label });
  const simUBO = mkBuf(224, GU.UNIFORM | GU.COPY_DST, 'sim ubo');
  const h0Buf = mkBuf(specBytes, GU.STORAGE, 'h0');
  const specA = mkBuf(specBytes, GU.STORAGE, 'specA');
  const specB = mkBuf(specBytes, GU.STORAGE, 'specB');
  const tmpA = mkBuf(specBytes, GU.STORAGE, 'tmpA');
  const tmpB = mkBuf(specBytes, GU.STORAGE, 'tmpB');

  const mkSimTex = (label) => device.createTexture({
    label, size: [N, N, C], format: 'rgba16float', mipLevelCount: SIM_MIP_COUNT,
    usage: TU.TEXTURE_BINDING | TU.STORAGE_BINDING,
  });
  const dispTex = mkSimTex('disp');
  const derivTex = mkSimTex('deriv');
  const momTex = mkSimTex('moments');
  const lvl = (t, m, dim = '2d-array') => t.createView({ dimension: dim, baseMipLevel: m, mipLevelCount: 1 });
  const fullArr = (t) => t.createView({ dimension: '2d-array' });

  const [initPipe, evolvePipe, rowsPipe, colsPipe, simMipPipe, foamGenPipe, rgba8MipPipe,
    transPipe, msPipe, skyViewPipe, envPipe, cubeMipPipe, foamUpdPipe, arr16MipPipe, sunVisPipe] = await Promise.all([
    computePipe(SIM_INIT, 'sim init'),
    computePipe(SIM_EVOLVE, 'sim evolve'),
    computePipe(FFT_ROWS, 'fft rows'),
    computePipe(FFT_COLS, 'fft cols'),
    computePipe(SIM_MIPS, 'sim mips'),
    computePipe(FOAM_TEX, 'foam tex'),
    computePipe(RGBA8_MIPS, 'rgba8 mips'),
    computePipe(TRANS_LUT, 'transmittance'),
    computePipe(MS_LUT, 'multiscatter'),
    computePipe(SKYVIEW_LUT, 'skyview'),
    computePipe(ENV_CUBE, 'env cube'),
    computePipe(CUBE_MIPS, 'cube mips'),
    computePipe(FOAM_UPDATE, 'foam update'),
    computePipe(ARRAY16_MIPS, 'array16 mips'),
    computePipe(SUN_VIS, 'sun visibility'),
  ]);

  const bg = (pipe, entries, label) => device.createBindGroup({
    label, layout: pipe.getBindGroupLayout(0),
    entries: entries.map((r, i) => ({ binding: i, resource: r })),
  });
  const bgInit = bg(initPipe, [{ buffer: simUBO }, { buffer: h0Buf }], 'init');
  const bgEvolve = bg(evolvePipe, [{ buffer: simUBO }, { buffer: h0Buf }, { buffer: specA }, { buffer: specB }], 'evolve');
  const bgRows = bg(rowsPipe, [{ buffer: specA }, { buffer: specB }, { buffer: tmpA }, { buffer: tmpB }], 'rows');
  const bgCols = bg(colsPipe, [{ buffer: tmpA }, { buffer: tmpB },
    lvl(dispTex, 0), lvl(derivTex, 0), lvl(momTex, 0)], 'cols');
  const bgSimMips = [];
  for (let m = 1; m < SIM_MIP_COUNT; m++) {
    bgSimMips.push(bg(simMipPipe, [lvl(dispTex, m - 1), lvl(derivTex, m - 1), lvl(momTex, m - 1),
      lvl(dispTex, m), lvl(derivTex, m), lvl(momTex, m)], 'simmip' + m));
  }

  // Foam micro-structure texture (generated once)
  const FOAM_SIZE = 512, FOAM_MIPS = 10;
  const foamTex = device.createTexture({
    label: 'foam detail', size: [FOAM_SIZE, FOAM_SIZE], format: 'rgba8unorm', mipLevelCount: FOAM_MIPS,
    usage: TU.TEXTURE_BINDING | TU.STORAGE_BINDING,
  });
  {
    const enc = device.createCommandEncoder();
    const cp = enc.beginComputePass();
    cp.setPipeline(foamGenPipe);
    cp.setBindGroup(0, bg(foamGenPipe, [lvl(foamTex, 0, '2d')]));
    cp.dispatchWorkgroups(FOAM_SIZE / 8, FOAM_SIZE / 8);
    cp.setPipeline(rgba8MipPipe);
    for (let m = 1; m < FOAM_MIPS; m++) {
      const s = FOAM_SIZE >> m;
      cp.setBindGroup(0, bg(rgba8MipPipe, [lvl(foamTex, m - 1, '2d'), lvl(foamTex, m, '2d')]));
      cp.dispatchWorkgroups(Math.ceil(s / 8), Math.ceil(s / 8));
    }
    cp.end();
    device.queue.submit([enc.finish()]);
  }

  // World-space foam clipmaps (ping-pong)
  const FOAM_LEVEL_SIZE = [128.0, 1024.0];
  const FOAMW_MIPS = Math.log2(FOAM_RES) + 1;
  const foamW = [0, 1].map((i) => device.createTexture({
    label: 'foam world ' + i, size: [FOAM_RES, FOAM_RES, 2], format: 'rgba16float', mipLevelCount: FOAMW_MIPS,
    usage: TU.TEXTURE_BINDING | TU.STORAGE_BINDING,
  }));
  const foamUBO = mkBuf(144, GU.UNIFORM | GU.COPY_DST, 'foam ubo');
  const foamUArr = new ArrayBuffer(144);
  const foamUI = new Int32Array(foamUArr);
  const foamUF = new Float32Array(foamUArr);
  const foamSnap = new Int32Array(4);  // previous camera texel per level
  let foamFirst = true;
  let foamCur = 0;
  const samplerSim = device.createSampler({
    magFilter: 'linear', minFilter: 'linear', mipmapFilter: 'linear', addressModeU: 'repeat', addressModeV: 'repeat',
  });
  const bgFoamUpd = [0, 1].map((i) => bg(foamUpdPipe, [{ buffer: foamUBO }, lvl(foamW[1 - i], 0), lvl(foamW[i], 0),
    fullArr(dispTex), fullArr(derivTex), samplerSim, samplerSim], 'foamupd' + i));
  const bgFoamMips = [0, 1].map((i) => {
    const out = [];
    for (let m = 1; m < FOAMW_MIPS; m++) out.push(bg(arr16MipPipe, [lvl(foamW[i], m - 1), lvl(foamW[i], m)]));
    return out;
  });

  // --------------------------------------------------------------------------------------
  // Atmosphere resources
  // --------------------------------------------------------------------------------------
  const atmoUBO = mkBuf(16, GU.UNIFORM | GU.COPY_DST, 'atmo ubo');
  const mkLut = (w, h, label) => device.createTexture({
    label, size: [w, h], format: 'rgba16float', usage: TU.TEXTURE_BINDING | TU.STORAGE_BINDING,
  });
  const transLUT = mkLut(256, 64, 'transmittance');
  const msLUT = mkLut(32, 32, 'multiscatter');
  const skyLUT = mkLut(SKY_W, SKY_H, 'skyview');
  const envTex = device.createTexture({
    label: 'env cube', size: [ENV_SIZE, ENV_SIZE, 6], format: 'rgba16float', mipLevelCount: ENV_MIPS,
    usage: TU.TEXTURE_BINDING | TU.STORAGE_BINDING,
  });
  const envCubeView = envTex.createView({ dimension: 'cube' });
  const sampClamp = device.createSampler({
    magFilter: 'linear', minFilter: 'linear', mipmapFilter: 'linear',
    addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge', addressModeW: 'clamp-to-edge',
  });
  const sampRepeat = device.createSampler({
    magFilter: 'linear', minFilter: 'linear', mipmapFilter: 'linear',
    addressModeU: 'repeat', addressModeV: 'repeat', maxAnisotropy: 16,
  });
  const frameUBO = mkBuf(544, GU.UNIFORM | GU.COPY_DST, 'frame ubo');
  const sunVisBuf = mkBuf(16, GU.STORAGE, 'sun visibility');
  const transView = transLUT.createView();
  const msView = msLUT.createView();
  const skyView = skyLUT.createView();
  const starMap = device.createTexture({
    label: 'Yale bright star catalogue',
    size: [STAR_MAP_WIDTH, STAR_MAP_HEIGHT],
    format: 'rgba8unorm',
    usage: TU.TEXTURE_BINDING | TU.COPY_DST,
  });
  {
    const pixels = createStarMapData();
    device.queue.writeTexture(
      { texture: starMap },
      pixels,
      { bytesPerRow: STAR_MAP_WIDTH * 4, rowsPerImage: STAR_MAP_HEIGHT },
      [STAR_MAP_WIDTH, STAR_MAP_HEIGHT],
    );
  }
  const starView = starMap.createView();

  const bgTrans = bg(transPipe, [{ buffer: atmoUBO }, transView], 'trans');
  const bgMS = bg(msPipe, [{ buffer: atmoUBO }, transView, sampClamp, msView], 'ms');
  const bgSkyView = bg(skyViewPipe, [{ buffer: frameUBO }, transView, msView, sampClamp, skyView], 'skyview');
  const bgEnv = bg(envPipe, [{ buffer: frameUBO }, transView, skyView, sampClamp, lvl(envTex, 0), starView], 'env');
  const bgSunVis = bg(sunVisPipe, [{ buffer: frameUBO }, transView, skyView, sampClamp, { buffer: sunVisBuf }], 'sunvis');
  const bgCubeMips = [];
  for (let m = 1; m < ENV_MIPS; m++) bgCubeMips.push(bg(cubeMipPipe, [lvl(envTex, m - 1), lvl(envTex, m)], 'cubemip' + m));

  // --------------------------------------------------------------------------------------
  // Render pipelines
  // --------------------------------------------------------------------------------------
  const MSAA = 4;
  const HDR = 'rgba16float';
  const [oceanMod, skyMod, downMod, upMod, compMod] = await Promise.all([
    shader(OCEAN, 'ocean'), shader(SKY_BG, 'sky'), shader(BLOOM_DOWN, 'bloom down'),
    shader(BLOOM_UP, 'bloom up'), shader(COMPOSITE, 'composite'),
  ]);
  const oceanPipe = await device.createRenderPipelineAsync({
    label: 'ocean', layout: 'auto',
    vertex: {
      module: oceanMod, entryPoint: 'vs',
      buffers: [{ arrayStride: 16, stepMode: 'instance', attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x4' }] }],
    },
    fragment: { module: oceanMod, entryPoint: 'fs', targets: [{ format: HDR }] },
    primitive: { topology: 'triangle-list', cullMode: 'none' },
    depthStencil: { format: 'depth32float', depthWriteEnabled: true, depthCompare: 'greater' },
    multisample: { count: MSAA },
  });
  const skyPipe = await device.createRenderPipelineAsync({
    label: 'sky', layout: 'auto',
    vertex: { module: skyMod, entryPoint: 'vs' },
    fragment: { module: skyMod, entryPoint: 'fs', targets: [{ format: HDR }] },
    primitive: { topology: 'triangle-list' },
    depthStencil: { format: 'depth32float', depthWriteEnabled: false, depthCompare: 'equal' },
    multisample: { count: MSAA },
  });
  const downPipe = await device.createRenderPipelineAsync({
    label: 'bloom down', layout: 'auto',
    vertex: { module: downMod, entryPoint: 'vs' },
    fragment: { module: downMod, entryPoint: 'fs', targets: [{ format: HDR }] },
  });
  const upPipe = await device.createRenderPipelineAsync({
    label: 'bloom up', layout: 'auto',
    vertex: { module: upMod, entryPoint: 'vs' },
    fragment: {
      module: upMod, entryPoint: 'fs',
      targets: [{ format: HDR, blend: { color: { srcFactor: 'one', dstFactor: 'one', operation: 'add' }, alpha: { srcFactor: 'one', dstFactor: 'one', operation: 'add' } } }],
    },
  });
  const compPipe = await device.createRenderPipelineAsync({
    label: 'composite', layout: 'auto',
    vertex: { module: compMod, entryPoint: 'vs' },
    fragment: { module: compMod, entryPoint: 'fs', targets: [{ format: swapFormat }] },
  });

  const bgOcean = [0, 1].map((i) => bg(oceanPipe, [{ buffer: frameUBO }, transView, skyView, sampClamp,
    fullArr(dispTex), fullArr(derivTex), fullArr(momTex), foamTex.createView(), envCubeView, sampRepeat,
    fullArr(foamW[i]), { buffer: sunVisBuf }], 'ocean' + i));
  const bgSky = bg(skyPipe, [{ buffer: frameUBO }, transView, skyView, sampClamp, starView], 'sky');

  // Water height under the camera (async readback, a few frames of latency) so the
  // floating camera rides above passing crests instead of clipping into them.
  const probePipe = await computePipe(HEIGHT_PROBE, 'height probe');
  const probeOut = mkBuf(16, GU.STORAGE | GU.COPY_SRC, 'probe out');
  const probeRead = mkBuf(16, GU.MAP_READ | GU.COPY_DST, 'probe read');
  const bgProbe = bg(probePipe, [{ buffer: frameUBO }, fullArr(dispTex), samplerSim, { buffer: probeOut }], 'probe');
  let probePending = false, waterH = 0, audioWaterH = 0;
  const onProbe = () => {
    waterH = new Float32Array(probeRead.getMappedRange(0, 16))[0];
    probeRead.unmap();
    probePending = false;
  };
  const onProbeFail = () => { probePending = false; };

  // CDLOD grid mesh
  const GRID = 32;
  const LEAF = 2.0;           // finest node size (m) -> 6.25 cm vertex spacing
  const R0 = 8 * LEAF;        // LOD 0 range
  const LODS = 17;
  const MAX_DIST = 160000;
  const MAX_NODES = 8192;
  const idx = new Uint16Array(GRID * GRID * 6);
  {
    let k = 0;
    for (let j = 0; j < GRID; j++) {
      for (let i = 0; i < GRID; i++) {
        const a = i + j * (GRID + 1), b = a + 1, c = a + GRID + 1, d = c + 1;
        idx[k++] = a; idx[k++] = c; idx[k++] = d;
        idx[k++] = a; idx[k++] = d; idx[k++] = b;
      }
    }
  }
  const idxBuf = mkBuf(idx.byteLength, GU.INDEX | GU.COPY_DST, 'grid idx');
  device.queue.writeBuffer(idxBuf, 0, idx);
  const instData = new Float32Array(MAX_NODES * 4);
  const instBuf = mkBuf(instData.byteLength, GU.VERTEX | GU.COPY_DST, 'instances');

  // --------------------------------------------------------------------------------------
  // Screen-size dependent targets
  // --------------------------------------------------------------------------------------
  const BLOOM_LEVELS = 8;
  const linSamp = device.createSampler({ magFilter: 'linear', minFilter: 'linear', addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge' });
  const compUBO = mkBuf(32, GU.UNIFORM | GU.COPY_DST, 'composite ubo');
  const compData = new Float32Array(8);
  const bloomUBOs = [];
  for (let i = 0; i < BLOOM_LEVELS * 2; i++) bloomUBOs.push(mkBuf(16, GU.UNIFORM | GU.COPY_DST, 'bloom ubo'));

  let W = 0, H = 0;
  let colorMS, depthMS, hdrTex, bloomTex;
  const mainPass = {
    colorAttachments: [{ view: null, resolveTarget: null, clearValue: { r: 0, g: 0, b: 0, a: 1 }, loadOp: 'clear', storeOp: 'discard' }],
    depthStencilAttachment: { view: null, depthClearValue: 0, depthLoadOp: 'clear', depthStoreOp: 'discard' },
  };
  const compPass = {
    colorAttachments: [{ view: null, clearValue: { r: 0, g: 0, b: 0, a: 1 }, loadOp: 'clear', storeOp: 'store' }],
    timestampWrites: undefined,
  };
  let downPasses = [], upPasses = [], downBGs = [], upBGs = [], bgComp = null;

  function resize() {
    const fw = Number(qs.get('w')) || 0, fh = Number(qs.get('h')) || 0;
    const dpr = window.devicePixelRatio || 1;
    const w = fw || Math.max(1, Math.round(canvas.clientWidth * dpr));
    const h = fh || Math.max(1, Math.round(canvas.clientHeight * dpr));
    if (w === W && h === H) return;
    W = w; H = h;
    canvas.width = W; canvas.height = H;
    for (const t of [colorMS, depthMS, hdrTex, bloomTex]) t && t.destroy();
    colorMS = device.createTexture({ size: [W, H], format: HDR, sampleCount: MSAA, usage: TU.RENDER_ATTACHMENT });
    depthMS = device.createTexture({ size: [W, H], format: 'depth32float', sampleCount: MSAA, usage: TU.RENDER_ATTACHMENT });
    hdrTex = device.createTexture({ size: [W, H], format: HDR, usage: TU.RENDER_ATTACHMENT | TU.TEXTURE_BINDING });
    const bw = Math.max(1, W >> 1), bh = Math.max(1, H >> 1);
    bloomTex = device.createTexture({ size: [bw, bh], format: HDR, mipLevelCount: BLOOM_LEVELS, usage: TU.RENDER_ATTACHMENT | TU.TEXTURE_BINDING });
    mainPass.colorAttachments[0].view = colorMS.createView();
    mainPass.colorAttachments[0].resolveTarget = hdrTex.createView();
    mainPass.depthStencilAttachment.view = depthMS.createView();
    const hdrView = hdrTex.createView();
    const bv = [];
    for (let m = 0; m < BLOOM_LEVELS; m++) bv.push(bloomTex.createView({ baseMipLevel: m, mipLevelCount: 1 }));
    downPasses = []; upPasses = []; downBGs = []; upBGs = [];
    const tmp = new Float32Array(4);
    for (let m = 0; m < BLOOM_LEVELS; m++) {
      const srcW = m === 0 ? W : Math.max(1, bw >> (m - 1));
      const srcH = m === 0 ? H : Math.max(1, bh >> (m - 1));
      tmp[0] = 1 / srcW; tmp[1] = 1 / srcH; tmp[2] = m === 0 ? 1 : 0; tmp[3] = 0;
      device.queue.writeBuffer(bloomUBOs[m], 0, tmp);
      downBGs.push(bg(downPipe, [m === 0 ? hdrView : bv[m - 1], linSamp, { buffer: bloomUBOs[m] }]));
      downPasses.push({ colorAttachments: [{ view: bv[m], clearValue: { r: 0, g: 0, b: 0, a: 1 }, loadOp: 'clear', storeOp: 'store' }] });
    }
    for (let m = BLOOM_LEVELS - 1; m > 0; m--) {
      const sw = Math.max(1, bw >> m), sh = Math.max(1, bh >> m);
      tmp[0] = 1 / sw; tmp[1] = 1 / sh; tmp[2] = 1.0; tmp[3] = 1.0;
      const ubo = bloomUBOs[BLOOM_LEVELS + m];
      device.queue.writeBuffer(ubo, 0, tmp);
      upBGs.push(bg(upPipe, [bv[m], linSamp, { buffer: ubo }]));
      upPasses.push({ colorAttachments: [{ view: bv[m - 1], loadOp: 'load', storeOp: 'store' }] });
    }
    bgComp = bg(compPipe, [hdrView, bv[0], linSamp, { buffer: compUBO }]);
  }

  // --------------------------------------------------------------------------------------
  // GPU timing
  // --------------------------------------------------------------------------------------
  let tsQuery = null, tsResolve = null, tsRead = null, tsPending = false, gpuMs = 0;
  let firstPassTS = undefined;
  if (hasTS) {
    tsQuery = device.createQuerySet({ type: 'timestamp', count: 2 });
    tsResolve = mkBuf(16, GU.QUERY_RESOLVE | GU.COPY_SRC, 'ts resolve');
    tsRead = mkBuf(16, GU.MAP_READ | GU.COPY_DST, 'ts read');
    firstPassTS = { querySet: tsQuery, beginningOfPassWriteIndex: 0 };
    compPass.timestampWrites = { querySet: tsQuery, endOfPassWriteIndex: 1 };
  }
  const computeDesc = { timestampWrites: firstPassTS };
  const onTsMapped = () => {
    const t = new BigUint64Array(tsRead.getMappedRange());
    const ms = Number(t[1] - t[0]) / 1e6;
    if (ms > 0 && ms < 1000) gpuMs = gpuMs ? gpuMs * 0.8 + ms * 0.2 : ms;
    tsRead.unmap();
    tsPending = false;
  };
  const onTsFail = () => { tsPending = false; };

  // --------------------------------------------------------------------------------------
  // Uniform data
  // --------------------------------------------------------------------------------------
  const simF = new Float32Array(56);
  const frameF = new Float32Array(136);
  const atmoF = new Float32Array(4);
  const proj = new Float32Array(16), view = new Float32Array(16), viewProj = new Float32Array(16);
  const LOOP = 600.0;  // s, spectrum time loop (frequencies quantised to it)
  let needSpectrum = true, needLUT = true, envFull = 2;

  function writeSimStatic() {
    for (let c = 0; c < C; c++) {
      const L = CASC_L[c];
      simF[c] = L;
      simF[8 + c] = c === 0 ? Math.PI / L : (2 * Math.PI * 6) / L;            // kMin
      simF[16 + c] = c < C - 1 ? (2 * Math.PI * 6) / CASC_L[c + 1] : (Math.PI * N / L) * 0.98; // kMax
    }
    for (let c = 1; c < C; c++) simF[8 + c] = simF[16 + c - 1];
    simF[40] = P.windSpeed; simF[41] = P.windDir * D2R; simF[42] = P.fetchKm * 1000; simF[43] = 3.3;
    const ks = 2 * Math.PI / P.swellLength;
    simF[44] = P.swellHs; simF[45] = P.swellDir * D2R; simF[46] = Math.sqrt(9.81 * ks); simF[47] = P.swellSpread;
    simF[48] = P.choppy; simF[49] = 0.0012; simF[50] = LOOP; simF[51] = 1;
    simF[54] = 2.2; simF[55] = 1.0;
  }

  // --------------------------------------------------------------------------------------
  // Camera & input
  // --------------------------------------------------------------------------------------
  const CAM_DEFAULT = { x: 0, y: 2.4, z: 0, yaw: 0, pitch: -5.5 * D2R, fovY: 58 * D2R, speed: 6 };
  // Looks toward the sun and moon's daily arc while keeping the horizon in frame.
  const SKY_VIEW = { pitch: 16 * D2R, fovY: 75 * D2R };
  const camLocked = qs.has('cam') || qs.has('fov');
  const cam = { ...CAM_DEFAULT };
  let framedSky = false;
  function frameSkyView() {
    if (camLocked) return;
    cam.yaw = 0;
    cam.pitch = SKY_VIEW.pitch;
    cam.fovY = SKY_VIEW.fovY;
    framedSky = true;
  }
  function restoreDefaultView() {
    cam.yaw = CAM_DEFAULT.yaw;
    cam.pitch = CAM_DEFAULT.pitch;
    cam.fovY = CAM_DEFAULT.fovY;
    framedSky = false;
  }
  function resetView() {
    cam.x = CAM_DEFAULT.x; cam.y = CAM_DEFAULT.y; cam.z = CAM_DEFAULT.z;
    if (skyUsesPlace()) frameSkyView();
    else restoreDefaultView();
  }
  if (qs.get('cam')) {
    const v = qs.get('cam').split(',').map(Number);
    cam.x = v[0]; cam.y = v[1]; cam.z = v[2]; cam.yaw = (v[3] || 0) * D2R; cam.pitch = (v[4] || 0) * D2R;
  }
  if (qs.get('fov')) cam.fovY = Number(qs.get('fov')) * D2R;
  let placeDialog = null;
  const keys = Object.create(null);
  addEventListener('keydown', (e) => {
    keys[e.code] = true;
    if (e.repeat) return;
    if (e.code === 'Escape' && closePlaceDialog()) return;
    if (e.code === 'Escape') setPanelOpen(false);
    if (e.code === 'F1') { e.preventDefault(); showPanel(); }
    if (e.code === 'KeyH') togglePanel();
    if (e.code === 'KeyM') oceanAudio.toggle();
  });
  addEventListener('keyup', (e) => { keys[e.code] = false; });
  // Hold the left button to look; pressing left + right together resets the view. The chord
  // stays latched until both buttons are up so releasing one of them doesn't resume looking.
  let looking = false, chord = false;
  function setLooking(on) {
    looking = on;
    canvas.classList.toggle('looking', on);
  }
  addEventListener('blur', () => {
    for (const k in keys) keys[k] = false;
    setLooking(false);
    chord = false;
  });
  canvas.addEventListener('mousedown', (e) => {
    e.preventDefault();
    if ((e.buttons & 3) === 3) {
      chord = true;
      setLooking(false);
      resetView();
    } else if (e.button === 0 && !chord) {
      setLooking(true);
    }
  });
  addEventListener('mouseup', (e) => {
    if (!(e.buttons & 1)) setLooking(false);
    if (!(e.buttons & 3)) chord = false;
  });
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  addEventListener('mousemove', (e) => {
    if (!looking) return;
    if (!(e.buttons & 1)) { setLooking(false); return; }
    cam.yaw += e.movementX * 0.0022;
    cam.pitch = Math.max(-1.5, Math.min(1.5, cam.pitch - e.movementY * 0.0022));
  });
  addEventListener('wheel', (e) => {
    if (e.target instanceof Element && e.target.closest('#panel, .place-dialog')) return;
    e.preventDefault();
    const unit = e.deltaMode === 1 ? 1 : e.deltaMode === 2 ? 1 : 100;
    const steps = e.deltaY / unit;
    if (!steps) return;
    const boost = e.shiftKey || keys.ShiftLeft || keys.ShiftRight ? 5 : 1;
    cam.y = Math.max(1, Math.min(3000, cam.y - steps * cam.speed * boost));
  }, { passive: false });

  function updateCamera(dt) {
    const cy = Math.cos(cam.yaw), sy = Math.sin(cam.yaw), cp = Math.cos(cam.pitch), sp = Math.sin(cam.pitch);
    let mx = 0, my = 0, mz = 0;
    const fwd = (keys.KeyW ? 1 : 0) - (keys.KeyS ? 1 : 0);
    const str = (keys.KeyD ? 1 : 0) - (keys.KeyA ? 1 : 0);
    const up = (keys.KeyE || keys.Space ? 1 : 0) - (keys.KeyQ || keys.KeyC ? 1 : 0);
    mx += fwd * cp * sy + str * cy;
    my += fwd * sp + up;
    mz += -fwd * cp * cy + str * sy;
    const boost = keys.ShiftLeft || keys.ShiftRight ? 5 : 1;
    const v = cam.speed * boost * dt;
    cam.x += mx * v; cam.y += my * v; cam.z += mz * v;
    cam.y = Math.max(1.0, Math.min(3000, cam.y));
    // keep clear of the actual (displaced) water surface under the camera
    if (cam.y < waterH + 0.9) cam.y += (waterH + 0.9 - cam.y) * Math.min(1, dt * 12);
  }

  // --------------------------------------------------------------------------------------
  // CDLOD node selection (CPU, allocation free)
  // --------------------------------------------------------------------------------------
  const ranges = new Float64Array(LODS);
  for (let l = 0; l < LODS; l++) ranges[l] = R0 * Math.pow(2, l);
  const planes = new Float64Array(16);
  const HB = 4.0;   // vertical bound of displaced surface
  const XB = 4.0;   // horizontal displacement margin for culling
  let nodeCount = 0, ccx = 0, ccy = 0, ccz = 0;

  function sphereHit(x0, z0, size, r) {
    const dx = Math.max(x0 - ccx, 0, ccx - (x0 + size));
    const dz = Math.max(z0 - ccz, 0, ccz - (z0 + size));
    const dy = Math.max(-HB - ccy, 0, ccy - HB);
    return dx * dx + dy * dy + dz * dz <= r * r;
  }
  function inFrustum(x0, z0, size) {
    const minx = x0 - XB - ccx, maxx = x0 + size + XB - ccx;
    const minz = z0 - XB - ccz, maxz = z0 + size + XB - ccz;
    const miny = -HB - ccy, maxy = HB - ccy;
    for (let p = 0; p < 16; p += 4) {
      const a = planes[p], b = planes[p + 1], c = planes[p + 2], d = planes[p + 3];
      const px = a > 0 ? maxx : minx, py = b > 0 ? maxy : miny, pz = c > 0 ? maxz : minz;
      if (a * px + b * py + c * pz + d < 0) return false;
    }
    return true;
  }
  function addNode(x0, z0, size, lod) {
    if (nodeCount >= MAX_NODES) return;
    const o = nodeCount * 4;
    instData[o] = x0; instData[o + 1] = z0; instData[o + 2] = size; instData[o + 3] = lod;
    nodeCount++;
  }
  function selectNode(x0, z0, size, lod) {
    if (!sphereHit(x0, z0, size, ranges[lod])) return false;
    if (!sphereHit(x0, z0, size, MAX_DIST) || !inFrustum(x0, z0, size)) return true;
    if (lod === 0 || !sphereHit(x0, z0, size, ranges[lod - 1])) { addNode(x0, z0, size, lod); return true; }
    const h = size * 0.5;
    for (let i = 0; i < 4; i++) {
      const nx = x0 + (i & 1) * h, nz = z0 + (i >> 1) * h;
      if (!selectNode(nx, nz, h, lod - 1)) {
        if (sphereHit(nx, nz, h, MAX_DIST) && inFrustum(nx, nz, h)) addNode(nx, nz, h, lod - 1);
      }
    }
    return true;
  }
  function selectAll() {
    nodeCount = 0;
    ccx = cam.x; ccy = cam.y; ccz = cam.z;
    // side planes from the camera-relative view-projection (rows 3±0, 3±1)
    const m = viewProj;
    for (let i = 0; i < 4; i++) {
      const r = i >> 1, s = (i & 1) ? -1 : 1;
      planes[i * 4] = m[3] + s * m[r];
      planes[i * 4 + 1] = m[7] + s * m[4 + r];
      planes[i * 4 + 2] = m[11] + s * m[8 + r];
      planes[i * 4 + 3] = m[15] + s * m[12 + r];
    }
    const top = LODS - 1;
    const ts = LEAF * Math.pow(2, top);
    const x0 = Math.floor((ccx - MAX_DIST) / ts), x1 = Math.floor((ccx + MAX_DIST) / ts);
    const z0 = Math.floor((ccz - MAX_DIST) / ts), z1 = Math.floor((ccz + MAX_DIST) / ts);
    for (let zi = z0; zi <= z1; zi++) {
      for (let xi = x0; xi <= x1; xi++) selectNode(xi * ts, zi * ts, ts, top);
    }
  }

  // --------------------------------------------------------------------------------------
  // Per-frame uniforms
  // --------------------------------------------------------------------------------------
  let simTime = Number(qs.get('t')) || 0;
  let frameIndex = 0;
  let skyLocation = null;
  let liveSky = null;
  let skyInstant = null;

  function horizonDirection(elevation, azimuth) {
    const e = elevation * D2R, a = azimuth * D2R;
    return [Math.sin(a) * Math.cos(e), Math.sin(e), -Math.cos(a) * Math.cos(e)];
  }

  function skyUsesPlace() {
    return P.skyMode === 'dynamic' || P.skyMode === 'dated' || P.skyMode === 'lapse';
  }
  function localDateTimeValue(date = new Date()) {
    const pad = (n) => String(n).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
  }
  let lapseElapsedMs = 0;
  let lapseMinute = '';
  function parseLocalDateTime(value) {
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value || '')) return null;
    const when = new Date(value);
    return Number.isNaN(when.getTime()) ? null : when;
  }
  function lapseYearMs(start) {
    const end = new Date(start.getTime());
    end.setFullYear(end.getFullYear() + 1);
    return Math.max(60000, end.getTime() - start.getTime());
  }
  function resetTimeLapse() {
    lapseElapsedMs = 0;
    lapseMinute = '';
  }
  function lapseInstant() {
    const start = parseLocalDateTime(P.skyLapseStart);
    if (!start) return null;
    return new Date(start.getTime() + (lapseElapsedMs % lapseYearMs(start)));
  }
  function skyMoment() {
    if (P.skyMode === 'dynamic') return new Date();
    if (P.skyMode === 'lapse') return lapseInstant();
    return parseLocalDateTime(P.skyWhen);
  }
  function advanceTimeLapse(dt) {
    if (P.skyMode !== 'lapse' || dt <= 0) return;
    const pace = Math.max(1, Number(P.lapsePace) || 20);
    lapseElapsedMs += dt * 60000 * pace;
    const instant = lapseInstant();
    if (!instant) return;
    const minute = localDateTimeValue(instant);
    if (minute === lapseMinute) return;
    lapseMinute = minute;
    if (skyLocation) refreshPlacedSky();
    updateSkyReadout();
  }
  function refreshPlacedSky() {
    if (!skyUsesPlace() || !skyLocation) return false;
    const when = skyMoment();
    if (!when) {
      liveSky = skyInstant = null;
      return false;
    }
    liveSky = celestialState(when, skyLocation.latitude, skyLocation.longitude);
    skyInstant = when;
    envFull = 2;
    updateSkyReadout();
    return true;
  }
  function refreshDynamicSky() {
    if (P.skyMode === 'dynamic') refreshPlacedSky();
  }
  function weatherSmooth(a, b, v) {
    const x = Math.max(0, Math.min(1, (v - a) / (b - a)));
    return x * x * (3 - 2 * x);
  }
  function showDrivenSetting(key, value) {
    const control = controls.get(key);
    if (typeof DEFAULTS[key] === 'boolean') {
      P[key] = value;
      if (control) {
        control.input.checked = value;
        control.output.textContent = value ? control.onText : control.offText;
      }
      return;
    }
    P[key] = value;
    if (!control) return;
    const step = Number(control.input.step) || 0.01;
    const shown = Math.round(value / step) * step;
    const text = String(Number(shown.toFixed(4)));
    if (control.output.textContent !== text) {
      control.input.value = text;
      control.output.textContent = text;
    }
  }
  function updateDynamicClouds(dt) {
    if (P.cloudMode !== 'dynamic') return;
    cloudTime += dt;
    const when = skyUsesPlace() && skyInstant ? skyInstant : new Date();
    const hour = when.getHours() + when.getMinutes() / 60 + when.getSeconds() / 3600;
    const sunY = skyUsesPlace() && liveSky ? liveSky.sunDirection[1] : Math.sin(P.sunElev * D2R);
    const elev = Math.asin(Math.max(-1, Math.min(1, sunY))) / D2R;
    const daylight = weatherSmooth(-6, 10, elev);
    const afternoon = Math.exp(-((hour - 15.2) ** 2) / 16);
    const system = 0.5 + 0.5 * Math.sin(cloudTime * 0.0042);
    const front = 0.5 + 0.5 * Math.sin(cloudTime * 0.0017 + 1.8);
    const lowDir = (118 + 28 * Math.sin(cloudTime * 0.0011) + 360) % 360;
    const lowSun = Math.exp(-((elev - 6) ** 2) / 180) * weatherSmooth(-3, 4, elev);
    showDrivenSetting('cloudMotion', true);
    showDrivenSetting('clouds', Math.min(0.92, 0.08 + 0.58 * afternoon * daylight + 0.24 * system * (0.3 + 0.7 * daylight)));
    showDrivenSetting('cloudAltitude', 1.35 + 1.15 * afternoon * daylight);
    showDrivenSetting('cloudScale', 0.8 + 0.45 * afternoon);
    showDrivenSetting('cloudDensity', 1.3 + 2.4 * afternoon * (0.45 + 0.55 * daylight));
    showDrivenSetting('cloudWindSpeed', 3 + 8 * daylight + 7 * system);
    showDrivenSetting('cloudWindDir', lowDir);
    showDrivenSetting('cloudEvolution', 0.18 + 0.85 * daylight * (0.4 + afternoon));
    showDrivenSetting('veil', 0.06 + 0.48 * front);
    showDrivenSetting('highCloudAltitude', 6.5 + 2.4 * front);
    showDrivenSetting('highCloudScale', 0.85 + 0.55 * (1 - front));
    showDrivenSetting('highCloudDensity', 0.35 + 0.85 * front);
    showDrivenSetting('highCloudWindSpeed', 14 + 30 * (0.35 + 0.65 * front));
    showDrivenSetting('highCloudWindDir', (lowDir + 26 + 12 * Math.sin(cloudTime * 0.0007)) % 360);
    showDrivenSetting('cloudSoftness', 0.8 + 0.55 * (1 - daylight));
    showDrivenSetting('cloudSilver', 0.2 + 1.45 * lowSun);
    showDrivenSetting('cloudAmbient', 0.4 + 0.85 * daylight);
  }
  function updateDynamicStars() {
    if (P.starMode !== 'dynamic') return;
    const sunY = skyUsesPlace() && liveSky ? liveSky.sunDirection[1] : Math.sin(P.sunElev * D2R);
    const sunElev = Math.asin(Math.max(-1, Math.min(1, sunY))) / D2R;
    const moonY = skyUsesPlace() && liveSky ? liveSky.moonDirection[1] : Math.sin(P.moonElev * D2R);
    const moonElev = Math.asin(Math.max(-1, Math.min(1, moonY))) / D2R;
    const illumination = skyUsesPlace() && liveSky ? liveSky.moonIllumination : P.moonPhase;
    const moonUp = P.moon ? weatherSmooth(-1, 30, moonElev) : 0;
    const moonlight = moonUp * Math.max(0, Math.min(1, illumination));
    // A few stars remain in civil twilight; the full catalog needs astronomical darkness.
    const darkness = weatherSmooth(-5, -15, sunElev);
    const clarity = 1 - 0.55 * weatherSmooth(3, 12, P.haze);
    const cover = Math.max(0, Math.min(1, Math.max(P.clouds, P.veil * 0.65)));
    const openSky = (1 - 0.45 * cover) * clarity;
    showDrivenSetting('starDensity', Math.min(1, darkness * openSky * (1 - 0.82 * moonlight)));
    showDrivenSetting('starBrightness', Math.min(5, (0.45 + 1.15 * darkness) * (1 - 0.22 * moonlight)));
    showDrivenSetting('nightBrightness', Math.min(4, (0.35 + 0.25 * darkness + 1.7 * moonlight) * (0.65 + 0.35 * clarity)));
  }

  function writeFrame(time) {
    const aspect = W / H;
    const tanY = Math.tan(cam.fovY * 0.5), tanX = tanY * aspect;
    const near = 0.05;
    proj.fill(0);
    proj[0] = 1 / tanX; proj[5] = 1 / tanY; proj[11] = -1; proj[14] = near;
    const cy = Math.cos(cam.yaw), sy = Math.sin(cam.yaw), cp = Math.cos(cam.pitch), sp = Math.sin(cam.pitch);
    const fx = cp * sy, fy = sp, fz = -cp * cy;            // forward
    const rx = cy, ry = 0, rz = sy;                          // right
    const ux = ry * fz - rz * fy, uy = rz * fx - rx * fz, uz = rx * fy - ry * fx; // up = right x fwd
    view.fill(0);
    view[0] = rx; view[4] = ry; view[8] = rz;
    view[1] = ux; view[5] = uy; view[9] = uz;
    view[2] = -fx; view[6] = -fy; view[10] = -fz;
    view[15] = 1;
    mat4Mul(viewProj, proj, view);
    const f = frameF;
    f.set(viewProj, 0);
    f[16] = cam.x; f[17] = cam.y; f[18] = cam.z; f[19] = time;
    f[20] = rx * tanX; f[21] = ry * tanX; f[22] = rz * tanX; f[23] = 0;
    f[24] = ux * tanY; f[25] = uy * tanY; f[26] = uz * tanY; f[27] = 0;
    f[28] = fx; f[29] = fy; f[30] = fz; f[31] = 0;
    const dynamic = skyUsesPlace() && liveSky;
    const sun = dynamic ? liveSky.sunDirection : horizonDirection(P.sunElev, P.sunAzim);
    const moon = dynamic ? liveSky.moonDirection : horizonDirection(P.moonElev, P.moonAzim);
    f[32] = sun[0]; f[33] = sun[1]; f[34] = sun[2]; f[35] = 14.0;
    f[36] = W; f[37] = H; f[38] = 1 / W; f[39] = 1 / H;
    for (let c = 0; c < C; c++) { f[40 + c] = CASC_L[c]; f[48 + c] = 1 / CASC_L[c]; }
    f[56] = Math.cos(P.windDir * D2R); f[57] = Math.sin(P.windDir * D2R); f[58] = P.windSpeed;
    f[64] = R0; f[65] = GRID; f[66] = FOAM_LEVEL_SIZE[0]; f[67] = FOAM_LEVEL_SIZE[1];
    f[68] = P.exposure; f[69] = P.bloom; f[70] = frameIndex; f[71] = DBG;
    f[72] = P.haze; f[73] = Math.max(cam.y, 10) * 0.001; f[74] = P.veil; f[75] = 0;
    // deep water body scatter colour (greenish coastal water), unresolved slope variance
    f[76] = 0.016 * P.turbidity; f[77] = 0.080 * P.turbidity; f[78] = 0.096 * P.turbidity; f[79] = 0.0024;
    f[80] = 0.035; f[81] = 0.120; f[82] = 0.085; f[83] = 2.6;
    f[84] = 0.36 + 0.12 * P.foam; f[85] = 2.5; f[86] = 1.0; f[87] = 1.0;
    f[88] = (5.802e-3 + 4.40e-3 * P.haze) * 1e-3;
    f[89] = (13.558e-3 + 4.40e-3 * P.haze) * 1e-3;
    f[90] = (33.1e-3 + 4.40e-3 * P.haze) * 1e-3;
    f[91] = 1.1e-4;
    f[92] = P.cloudAltitude; f[93] = P.clouds; f[94] = P.cloudSoftness;
    f[95] = 0;
    f[96] = moon[0]; f[97] = moon[1]; f[98] = moon[2]; f[99] = P.moon ? P.moonBrightness : 0;
    let moonLight = sun;
    if (!dynamic) {
      const phaseAngle = Math.acos(Math.max(-1, Math.min(1, P.moonPhase * 2 - 1)));
      let tx = -moon[2], tz = moon[0];
      const tl = Math.hypot(tx, tz) || 1;
      tx /= tl; tz /= tl;
      moonLight = [
        -moon[0] * Math.cos(phaseAngle) + tx * Math.sin(phaseAngle),
        -moon[1] * Math.cos(phaseAngle),
        -moon[2] * Math.cos(phaseAngle) + tz * Math.sin(phaseAngle),
      ];
    }
    f[100] = moonLight[0]; f[101] = moonLight[1]; f[102] = moonLight[2]; f[103] = P.moonSize;
    const starDay = Math.trunc((skyInstant || new Date()).getTime() / 86400000);
    const dynamicSeed = skyLocation
      ? Math.abs(Math.trunc(skyLocation.latitude * 1000) * 31 + Math.trunc(skyLocation.longitude * 1000) * 17 + starDay)
      : P.starSeed;
    f[104] = P.stars ? P.starDensity : 0; f[105] = P.starBrightness;
    f[106] = dynamic ? dynamicSeed : P.starSeed; f[107] = P.nightBrightness;
    const pole = dynamic ? liveSky.poleDirection : [0, 1, 0];
    f[108] = pole[0]; f[109] = pole[1]; f[110] = pole[2]; f[111] = 0;
    f[112] = cloudScroll.lowX; f[113] = cloudScroll.lowZ; f[114] = 0; f[115] = cloudScroll.evolve;
    f[116] = cloudScroll.highX; f[117] = cloudScroll.highZ; f[118] = 0; f[119] = P.highCloudScale;
    f[120] = P.cloudScale; f[121] = P.highCloudAltitude; f[122] = P.cloudSoftness; f[123] = 0;
    f[124] = P.cloudDensity; f[125] = P.highCloudDensity;
    f[126] = P.cloudSilver; f[127] = P.cloudAmbient;
    if (dynamic) {
      f[128] = liveSky.equatorialX[0]; f[129] = liveSky.equatorialX[1]; f[130] = liveSky.equatorialX[2]; f[131] = 0;
      f[132] = liveSky.equatorialY[0]; f[133] = liveSky.equatorialY[1]; f[134] = liveSky.equatorialY[2]; f[135] = 0;
    } else {
      const rotation = P.starSeed * 0.001 * Math.PI * 2;
      f[128] = Math.cos(rotation); f[129] = 0; f[130] = Math.sin(rotation); f[131] = 0;
      f[132] = Math.sin(rotation); f[133] = 0; f[134] = -Math.cos(rotation); f[135] = 0;
    }
    device.queue.writeBuffer(frameUBO, 0, f);
  }

  // --------------------------------------------------------------------------------------
  // UI
  // --------------------------------------------------------------------------------------
  const panel = document.getElementById('panel');
  const settingsBtn = document.getElementById('settings');
  function setPanelOpen(open) {
    panel.classList.toggle('hidden', !open);
    settingsBtn.setAttribute('aria-expanded', String(open));
  }
  function togglePanel() { setPanelOpen(panel.classList.contains('hidden')); }
  function showPanel() { setPanelOpen(true); }
  settingsBtn.addEventListener('click', (event) => { event.stopPropagation(); showPanel(); });
  document.getElementById('close-settings').addEventListener('click', (event) => {
    event.stopPropagation();
    setPanelOpen(false);
  });
  const panelBody = document.getElementById('panel-body');
  const BOOL_KEYS = new Set(['sound', 'showButtons', 'showInfo', 'clock', 'clock24h', 'clockSeconds', 'clockDate',
    'weather', 'weatherTemp', 'weatherFeels', 'weatherPrecip', 'weatherHumidity', 'weatherWind', 'weatherForecast', 'weatherAlerts',
    'moon', 'stars', 'cloudMotion']);
  const STRING_KEYS = new Set(['clockStyle', 'clockColor', 'clockPosition', 'weatherZip', 'weatherUnit', 'weatherPosition',
    'skyMode', 'zipCode', 'skyWhen', 'skyLapseStart', 'cloudMode', 'starMode']);
  const CLOUD_DRIVEN = [
    'cloudMotion', 'cloudWindSpeed', 'cloudWindDir', 'cloudEvolution',
    'cloudScale', 'cloudAltitude', 'clouds', 'cloudDensity',
    'highCloudWindSpeed', 'highCloudWindDir', 'highCloudScale', 'highCloudAltitude',
    'veil', 'highCloudDensity', 'cloudSoftness', 'cloudSilver', 'cloudAmbient',
  ];
  const STAR_DRIVEN = ['starDensity', 'starBrightness', 'nightBrightness'];
  let cloudManual = null;
  let starManual = null;
  let cloudTime = 0;
  // Integrated advection. Multiplying wind by the clock jumps the field whenever the
  // wind changes, and that clock also wraps with the wave spectrum.
  const cloudScroll = { lowX: 0, lowZ: 0, highX: 0, highZ: 0, evolve: 0 };
  function advanceCloudMotion(dt) {
    if (!P.cloudMotion || dt <= 0) return;
    const low = P.cloudWindDir * D2R;
    const lowSpeed = P.cloudWindSpeed * 0.001;
    cloudScroll.lowX += Math.sin(low) * lowSpeed * dt;
    cloudScroll.lowZ += -Math.cos(low) * lowSpeed * dt;
    cloudScroll.evolve += P.cloudEvolution * dt;
    const high = P.highCloudWindDir * D2R;
    const highSpeed = P.highCloudWindSpeed * 0.001;
    cloudScroll.highX += Math.sin(high) * highSpeed * dt;
    cloudScroll.highZ += -Math.cos(high) * highSpeed * dt;
  }
  const SETTINGS_KEY = 'web-ocean-settings-v2';
  const SECTIONS = [
    { title: 'General', groups: [
      { settings: [
        ['showButtons', 'Onscreen buttons', 'toggle', 'Show', 'Hide'],
        ['showInfo', 'Onscreen information', 'toggle', 'Show', 'Hide'],
      ] },
    ] },
    { title: 'Clock', groups: [
      { title: 'Display', settings: [
        ['clock', 'Clock', 'toggle', 'On', 'Off'],
        ['clock24h', '24-hour time', 'toggle', 'On', 'Off'],
        ['clockSeconds', 'Show seconds', 'toggle', 'Show', 'Hide'],
        ['clockDate', 'Show date', 'toggle', 'Show', 'Hide'],
      ] },
      { title: 'Appearance', settings: [
        ['clockStyle', 'Style', 'select', [
          ['modern', 'Modern'],
          ['mono', 'Monospace'],
          ['classic', 'Classic'],
        ]],
        ['clockPosition', 'Position', 'select', [
          ['top-left', 'Top left'],
          ['top-center', 'Top center'],
          ['top-right', 'Top right'],
          ['bottom-left', 'Bottom left'],
          ['bottom-center', 'Bottom center'],
          ['bottom-right', 'Bottom right'],
        ]],
        ['clockSize', 'Size (px)', 32, 144, 1, 'clock'],
        ['clockColor', 'Color', 'color'],
        ['clockOpacity', 'Opacity', 0.2, 1, 0.01, 'clock'],
        ['clockBackground', 'Background', 0, 0.8, 0.01, 'clock'],
      ] },
    ] },
    { title: 'Weather', groups: [
      { title: 'Location and updates', settings: [
        ['weather', 'Weather widget', 'toggle', 'Show', 'Hide'],
        ['weatherZip', 'Location', 'text', 'Lisbon, Portugal'],
        ['weatherRefresh', 'Refresh (minutes)', 5, 60, 5, 'weather'],
        ['weatherUnit', 'Units', 'select', [
          ['fahrenheit', 'Fahrenheit / mph'],
          ['celsius', 'Celsius / km/h'],
        ]],
        ['weatherPosition', 'Position', 'select', [
          ['top-left', 'Top left'],
          ['top-right', 'Top right'],
          ['bottom-left', 'Bottom left'],
          ['bottom-right', 'Bottom right'],
        ]],
      ] },
      { title: 'Information', settings: [
        ['weatherTemp', 'Current temperature', 'toggle', 'Show', 'Hide'],
        ['weatherFeels', 'Feels like', 'toggle', 'Show', 'Hide'],
        ['weatherPrecip', 'Precipitation', 'toggle', 'Show', 'Hide'],
        ['weatherHumidity', 'Humidity', 'toggle', 'Show', 'Hide'],
        ['weatherWind', 'Wind', 'toggle', 'Show', 'Hide'],
        ['weatherForecast', 'Next 3 hours', 'toggle', 'Show', 'Hide'],
        ['weatherAlerts', 'U.S. weather alerts', 'toggle', 'Show', 'Hide'],
      ] },
    ] },
    { title: 'Ocean', groups: [
      { title: 'Wind', settings: [
        ['windSpeed', 'Wind speed (m/s)', 2, 20, 0.1, 'spec'],
        ['windDir', 'Wind direction (deg)', 0, 360, 1, 'spec'],
        ['fetchKm', 'Fetch (km)', 5, 800, 1, 'spec'],
      ] },
      { title: 'Swell', settings: [
        ['swellHs', 'Swell height (m)', 0, 4, 0.05, 'spec'],
        ['swellLength', 'Swell wavelength (m)', 30, 300, 1, 'spec'],
        ['swellDir', 'Swell direction (deg)', 0, 360, 1, 'spec'],
      ] },
      { title: 'Water', settings: [
        ['choppy', 'Choppiness', 0, 1.6, 0.01, 'spec'],
        ['turbidity', 'Water turbidity', 0.2, 3, 0.01, ''],
        ['foam', 'Foam', 0, 3, 0.01, ''],
      ] },
    ] },
    { title: 'Sound', groups: [
      { title: 'Playback', settings: [
        ['sound', 'Sound', 'toggle', 'On', 'Off'],
        ['audioVolume', 'Volume', 0, 1, 0.01, 'audio'],
      ] },
      { title: 'Layers', settings: [
        ['audioRumble', 'Swell rumble', 0, 2, 0.01, 'audio'],
        ['audioWash', 'Surface wash', 0, 2, 0.01, 'audio'],
        ['audioHiss', 'Crest hiss', 0, 2, 0.01, 'audio'],
      ] },
      { title: 'Motion', settings: [
        ['audioSync', 'Wave sync', 0, 2, 0.01, 'audio'],
        ['audioStereo', 'Stereo width', 0, 2, 0.01, 'audio'],
      ] },
    ] },
    { title: 'Sky', groups: [
      { title: 'Mode', settings: [
        ['skyMode', 'Sky behavior', 'select', [
          ['static', 'Static'],
          ['dynamic', 'Dynamic / real-time'],
          ['dated', 'Date and time'],
          ['lapse', 'Time lapse'],
        ]],
        ['zipCode', 'Location', 'text', 'Lisbon, Portugal'],
        ['skyWhen', 'View at', 'datetime'],
        ['skyLapseStart', 'Start at', 'datetime'],
        ['lapsePace', 'Sky minutes per second', 1, 100, 1, 'lapse'],
      ] },
      { title: 'Sun', settings: [
        ['sunElev', 'Sun elevation (deg)', -18, 90, 0.1, ''],
        ['sunAzim', 'Sun azimuth (deg)', -180, 180, 0.5, ''],
      ] },
      { title: 'Moon', settings: [
        ['moon', 'Moon', 'toggle', 'Show', 'Hide'],
        ['moonElev', 'Moon elevation (deg)', -18, 90, 0.1, ''],
        ['moonAzim', 'Moon azimuth (deg)', -180, 180, 0.5, ''],
        ['moonPhase', 'Phase (0 new, 1 full)', 0, 1, 0.01, ''],
        ['moonSize', 'Size (1 = true size)', 0.5, 6, 0.05, ''],
        ['moonBrightness', 'Brightness', 0, 12, 0.1, ''],
      ] },
      { title: 'Stars', settings: [
        ['starMode', 'Star behavior', 'select', [
          ['static', 'Static'],
          ['dynamic', 'Dynamic / real-world'],
        ]],
        ['stars', 'Stars', 'toggle', 'Show', 'Hide'],
      ], groups: [
        { title: 'Appearance', settings: [
          ['starDensity', 'Density', 0, 1, 0.01, ''],
          ['starBrightness', 'Brightness', 0, 5, 0.05, ''],
          ['starSeed', 'Random seed', 0, 9999, 1, ''],
          ['nightBrightness', 'Night sky brightness', 0, 4, 0.05, ''],
        ] },
      ] },
      { title: 'Clouds', settings: [
        ['cloudMode', 'Cloud behavior', 'select', [
          ['static', 'Static'],
          ['dynamic', 'Dynamic / real-world'],
        ]],
      ], groups: [
        { title: 'Motion', settings: [
          ['cloudMotion', 'Motion', 'toggle', 'On', 'Off'],
          ['cloudWindSpeed', 'Low wind speed (m/s)', 0, 40, 0.1, ''],
          ['cloudWindDir', 'Low wind direction (deg)', 0, 360, 1, ''],
          ['highCloudWindSpeed', 'High wind speed (m/s)', 0, 80, 0.1, ''],
          ['highCloudWindDir', 'High wind direction (deg)', 0, 360, 1, ''],
          ['cloudEvolution', 'Shape evolution', 0, 2, 0.01, ''],
        ] },
        { title: 'Low clouds', settings: [
          ['clouds', 'Coverage', 0, 1, 0.01, ''],
          ['cloudAltitude', 'Altitude (km)', 0.5, 5, 0.05, ''],
          ['cloudScale', 'Feature scale', 0.4, 3, 0.01, ''],
          ['cloudDensity', 'Optical density', 0.2, 6, 0.05, ''],
        ] },
        { title: 'High clouds', settings: [
          ['veil', 'Coverage', 0, 1, 0.01, ''],
          ['highCloudAltitude', 'Altitude (km)', 4, 14, 0.1, ''],
          ['highCloudScale', 'Feature scale', 0.4, 3, 0.01, ''],
          ['highCloudDensity', 'Optical density', 0.1, 3, 0.05, ''],
        ] },
        { title: 'Lighting', settings: [
          ['cloudSoftness', 'Edge softness', 0.4, 2.5, 0.01, ''],
          ['cloudSilver', 'Silver lining', 0, 2, 0.01, ''],
          ['cloudAmbient', 'Ambient light', 0, 2, 0.01, ''],
        ] },
      ] },
      { title: 'Atmosphere', settings: [
        ['haze', 'Haze', 0.5, 15, 0.1, 'lut'],
        ['exposure', 'Exposure', 0.1, 4, 0.01, ''],
        ['bloom', 'Bloom', 0, 0.3, 0.001, ''],
      ] },
    ] },
  ];
  const RANGES = new Map();
  const CHOICES = new Map();
  function eachSetting(groups, visit) {
    for (const group of groups || []) {
      for (const setting of group.settings || []) visit(setting);
      eachSetting(group.groups, visit);
    }
  }
  for (const section of SECTIONS) eachSetting(section.groups, (setting) => {
    if (setting[2] === 'select') CHOICES.set(setting[0], new Set(setting[3].map((option) => option[0])));
    else if (typeof setting[2] === 'number') RANGES.set(setting[0], [setting[2], setting[3]]);
  });
  function coerceSetting(key, raw) {
    if (BOOL_KEYS.has(key)) return booleanSetting(raw);
    if (CHOICES.has(key)) return CHOICES.get(key).has(raw) ? raw : undefined;
    if (key === 'zipCode' || key === 'weatherZip') {
      const place = acceptedPlace(raw);
      return place || undefined;
    }
    if (key === 'skyWhen' || key === 'skyLapseStart') {
      if (typeof raw !== 'string' || raw.trim() === '') return '';
      const value = raw.trim().slice(0, 16);
      if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) return undefined;
      return Number.isNaN(new Date(value).getTime()) ? undefined : value;
    }
    if (key === 'clockColor') return typeof raw === 'string' && /^#[0-9a-f]{6}$/i.test(raw) ? raw : undefined;
    const n = typeof raw === 'number' ? raw : Number(raw);
    if (!Number.isFinite(n)) return undefined;
    const range = RANGES.get(key);
    return range ? Math.min(range[1], Math.max(range[0], n)) : n;
  }
  function restoreSettings() {
    let data = null;
    try { data = JSON.parse(localStorage.getItem(SETTINGS_KEY) || 'null'); } catch { /* unavailable */ }
    if (!data || typeof data !== 'object' || Array.isArray(data)) return;
    for (const key of Object.keys(P)) {
      if (!Object.hasOwn(data, key)) continue;
      const value = coerceSetting(key, data[key]);
      if (value !== undefined) P[key] = value;
    }
  }
  let shareUrlInput = null;
  function settingsSnapshot() {
    const changed = {};
    for (const key of Object.keys(P)) {
      const stored = cloudManual && CLOUD_DRIVEN.includes(key) ? cloudManual[key]
        : starManual && STAR_DRIVEN.includes(key) ? starManual[key]
        : P[key];
      if (stored !== DEFAULTS[key]) changed[key] = stored;
    }
    return changed;
  }
  function encodeBase64Url(text) {
    const bytes = new TextEncoder().encode(text);
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/g, '');
  }
  function decodeBase64Url(value) {
    const normalized = value.replaceAll('-', '+').replaceAll('_', '/');
    const padded = normalized + '='.repeat((4 - normalized.length % 4) % 4);
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  }
  function sharedSettings(raw) {
    if (!raw) return {};
    try {
      const data = JSON.parse(decodeBase64Url(raw));
      return data && typeof data === 'object' && !Array.isArray(data) ? data : null;
    } catch {
      return null;
    }
  }
  function shareSettingsUrl() {
    const url = new URL(location.href);
    url.hash = '';
    url.search = '';
    url.searchParams.set('s', encodeBase64Url(JSON.stringify(settingsSnapshot())));
    return url.href;
  }
  function rememberSettings() {
    try {
      localStorage.removeItem('web-ocean-settings');
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(settingsSnapshot()));
    } catch { /* unavailable */ }
    if (shareUrlInput && !shareUrlInput.hidden) shareUrlInput.value = shareSettingsUrl();
  }
  restoreSettings();
  let sharedSettingsFailed = false;
  if (qs.has('s')) {
    const shared = sharedSettings(qs.get('s'));
    if (!shared) sharedSettingsFailed = true;
    else {
      for (const key of Object.keys(DEFAULTS)) P[key] = DEFAULTS[key];
      for (const key of Object.keys(shared)) {
        if (!Object.hasOwn(P, key)) continue;
        const value = coerceSetting(key, shared[key]);
        if (value !== undefined) P[key] = value;
      }
    }
  }
  for (const key of Object.keys(P)) {
    if (!qs.has(key)) continue;
    const value = coerceSetting(key, qs.get(key));
    if (value !== undefined) P[key] = value;
  }
  if (qs.get('ui') === '0') P.showButtons = P.showInfo = false;
  const controls = new Map();
  const skyReadout = document.getElementById('sky-readout');
  function updateSkyReadout() {
    const show = P.showInfo && P.skyMode === 'lapse' && skyInstant;
    skyReadout.hidden = !show;
    if (!show) return;
    const when = skyInstant.toLocaleString([], {
      weekday: 'short', month: 'short', day: 'numeric', year: 'numeric',
      hour: 'numeric', minute: '2-digit', hour12: !P.clock24h,
    });
    const place = skyLocation?.name || P.zipCode || '';
    const text = place ? `${when} · ${place}` : when;
    if (skyReadout.textContent !== text) skyReadout.textContent = text;
  }
  function applyShowInfo() {
    document.getElementById('hud').style.display = P.showInfo ? '' : 'none';
    updateSkyReadout();
    document.getElementById('toolbar').style.display = P.showButtons ? '' : 'none';
    panel.style.top = P.showButtons ? '50px' : '10px';
    panel.style.maxHeight = P.showButtons ? 'calc(100vh - 60px)' : 'calc(100vh - 20px)';
  }
  const clockWidget = document.getElementById('clock-widget');
  const clockTime = clockWidget.querySelector('.clock-time');
  const clockDate = clockWidget.querySelector('.clock-date');
  function updateClock() {
    const now = new Date();
    clockTime.textContent = now.toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit',
      second: P.clockSeconds ? '2-digit' : undefined,
      hour12: !P.clock24h,
    });
    clockDate.textContent = P.clockDate
      ? now.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' })
      : '';
    clockWidget.dateTime = now.toISOString();
  }
  function applyClock() {
    clockWidget.hidden = !P.clock;
    clockWidget.dataset.style = P.clockStyle;
    clockWidget.style.fontSize = P.clockSize + 'px';
    clockWidget.style.color = P.clockColor;
    clockWidget.style.opacity = P.clockOpacity;
    clockWidget.style.backgroundColor = `rgba(11, 15, 20, ${P.clockBackground})`;
    clockWidget.style.textShadow = P.clockBackground < 0.35 ? '0 2px 8px #000c' : 'none';
    clockWidget.style.top = clockWidget.style.right = clockWidget.style.bottom =
      clockWidget.style.left = clockWidget.style.transform = '';
    const edge = '32px';
    if (P.clockPosition.startsWith('top')) clockWidget.style.top = P.clockPosition === 'top-right' ? '58px' : edge;
    else clockWidget.style.bottom = edge;
    if (P.clockPosition.endsWith('left')) clockWidget.style.left = edge;
    else if (P.clockPosition.endsWith('right')) clockWidget.style.right = edge;
    else {
      clockWidget.style.left = '50%';
      clockWidget.style.transform = 'translateX(-50%)';
    }
    updateClock();
    updateSkyReadout();
  }
  function setDisclosure(item, open) {
    item.querySelector(':scope > button').setAttribute('aria-expanded', String(open));
    item.querySelector(':scope > div').hidden = !open;
  }
  function addDisclosure(parent, title, kind) {
    const item = document.createElement('div');
    item.className = kind;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = kind + '-toggle';
    button.textContent = title;
    button.setAttribute('aria-expanded', 'false');
    const body = document.createElement('div');
    body.className = kind + '-body';
    body.hidden = true;
    item.append(button, body);
    parent.appendChild(item);
    button.addEventListener('click', () => {
      const willOpen = button.getAttribute('aria-expanded') !== 'true';
      for (const sibling of parent.children) {
        if (sibling.classList.contains(kind)) setDisclosure(sibling, sibling === item && willOpen);
      }
    });
    return body;
  }
  function addSlider(parent, key, label, min, max, step, kind) {
    const row = document.createElement('label');
    const name = document.createElement('span'); name.textContent = label;
    const val = document.createElement('output'); val.textContent = String(P[key]);
    const inp = document.createElement('input');
    Object.assign(inp, { type: 'range', min, max, step, value: P[key] });
    inp.addEventListener('input', () => commitSetting(key, Number(inp.value)));
    row.append(name, inp, val);
    parent.appendChild(row);
    controls.set(key, { input: inp, output: val, row, min, max, kind });
  }
  function addSelect(parent, key, label, options) {
    const row = document.createElement('label');
    row.className = 'select';
    const name = document.createElement('span'); name.textContent = label;
    const inp = document.createElement('select');
    for (const [value, text] of options) {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = text;
      inp.appendChild(option);
    }
    inp.value = P[key];
    inp.addEventListener('change', () => commitSetting(key, inp.value));
    row.append(name, inp);
    parent.appendChild(row);
    controls.set(key, { input: inp, row, kind: 'string', values: new Set(options.map((o) => o[0])) });
  }
  function addColor(parent, key, label) {
    const row = document.createElement('label');
    row.className = 'color';
    const name = document.createElement('span'); name.textContent = label;
    const inp = document.createElement('input');
    inp.type = 'color';
    inp.value = P[key];
    inp.addEventListener('input', () => commitSetting(key, inp.value));
    row.append(name, inp);
    parent.appendChild(row);
    controls.set(key, { input: inp, row, kind: 'color' });
  }
  function addPlace(parent, key, label) {
    const row = document.createElement('div');
    row.className = 'place';
    const name = document.createElement('span');
    name.textContent = label;
    const display = document.createElement('span');
    display.className = 'place-value';
    display.textContent = P[key];
    display.title = P[key];
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'place-pick';
    button.textContent = '...';
    button.setAttribute('aria-haspopup', 'dialog');
    button.setAttribute('aria-label', `Choose ${label.toLowerCase()}`);
    button.addEventListener('click', () => openPlaceDialog(key));
    let stored = P[key];
    Object.defineProperty(button, 'value', {
      configurable: true,
      get() { return stored; },
      set(next) {
        stored = String(next ?? '');
        display.textContent = stored;
        display.title = stored;
      },
    });
    row.append(name, display, button);
    parent.appendChild(row);
    controls.set(key, { input: button, display, row, kind: 'text' });
  }
  function addDateTime(parent, key, label) {
    const row = document.createElement('label');
    row.className = 'datetime';
    const name = document.createElement('span'); name.textContent = label;
    const inp = document.createElement('input');
    inp.type = 'datetime-local';
    inp.value = P[key];
    inp.addEventListener('change', () => {
      if (!commitSetting(key, inp.value)) {
        inp.value = P[key];
        note('Choose a valid date and time');
      }
    });
    row.append(name, inp);
    parent.appendChild(row);
    controls.set(key, { input: inp, row, kind: 'datetime' });
  }
  function addToggle(parent, key, label, onText, offText) {
    const row = document.createElement('label');
    row.className = 'toggle';
    const name = document.createElement('span'); name.textContent = label;
    const val = document.createElement('output'); val.textContent = P[key] ? onText : offText;
    const inp = document.createElement('input');
    inp.type = 'checkbox';
    inp.checked = P[key];
    inp.addEventListener('change', () => commitSetting(key, inp.checked));
    const choice = document.createElement('span');
    choice.className = 'choice';
    choice.append(inp, val);
    row.append(name, choice);
    parent.appendChild(row);
    const control = { input: inp, output: val, row, kind: 'bool', onText, offText };
    controls.set(key, control);
    if (key === 'sound') soundControl = control;
  }
  function addSetting(host, setting) {
    if (setting[2] === 'toggle') addToggle(host, setting[0], setting[1], setting[3], setting[4]);
    else if (setting[2] === 'select') addSelect(host, setting[0], setting[1], setting[3]);
    else if (setting[2] === 'color') addColor(host, setting[0], setting[1]);
    else if (setting[2] === 'text') addPlace(host, setting[0], setting[1]);
    else if (setting[2] === 'datetime') addDateTime(host, setting[0], setting[1]);
    else addSlider(host, ...setting);
  }
  function addGroups(parent, groups, kind) {
    let firstGroup = null;
    for (const group of groups || []) {
      const host = group.title ? addDisclosure(parent, group.title, kind) : parent;
      if (group.title && !firstGroup) firstGroup = host;
      for (const setting of group.settings || []) addSetting(host, setting);
      addGroups(host, group.groups, 'subgroup');
    }
    if (firstGroup) setDisclosure(firstGroup.parentElement, true);
  }
  const sectionBodies = [];
  for (const section of SECTIONS) {
    const body = addDisclosure(panelBody, section.title, 'section');
    sectionBodies.push(body);
    addGroups(body, section.groups, 'group');
    if (section.title === 'General') addShortcuts(body);
  }
  function addShortcuts(parent) {
    const wrap = document.createElement('div');
    wrap.className = 'shortcuts';
    const heading = document.createElement('h3');
    heading.textContent = 'Shortcuts';
    const list = document.createElement('dl');
    for (const [key, action] of [
      ['F1', 'Show settings'],
      ['Esc', 'Close settings'],
      ['H', 'Show or hide settings'],
      ['M', 'Turn sound on or off'],
      ['W A S D', 'Move'],
      ['Space or E', 'Move up'],
      ['Q or C', 'Move down'],
      ['Shift', 'Move five times faster'],
      ['Mouse wheel', 'Move up or down'],
      ['Left drag', 'Look around'],
      ['Left and right click', 'Reset the view'],
    ]) {
      const term = document.createElement('dt');
      term.textContent = key;
      const detail = document.createElement('dd');
      detail.textContent = action;
      list.append(term, detail);
    }
    wrap.append(heading, list);
    parent.appendChild(wrap);
  }
  setDisclosure(sectionBodies[0].parentElement, true);
  applyShowInfo();
  applyClock();
  applySkyMode();
  applyCloudMode();
  applyStarMode();
  setInterval(updateClock, 250);
  setInterval(refreshDynamicSky, 30000);
  if (P.sound) oceanAudio.setEnabled(true);

  const io = document.createElement('div');
  io.className = 'io';
  const exportBtn = document.createElement('button');
  exportBtn.type = 'button';
  exportBtn.id = 'export-settings';
  exportBtn.textContent = 'Export';
  const importBtn = document.createElement('button');
  importBtn.type = 'button';
  importBtn.id = 'import-settings';
  importBtn.textContent = 'Import';
  const shareBtn = document.createElement('button');
  shareBtn.type = 'button';
  shareBtn.id = 'share-settings';
  shareBtn.textContent = 'Share link';
  const resetBtn = document.createElement('button');
  resetBtn.type = 'button';
  resetBtn.id = 'reset-settings';
  resetBtn.textContent = 'Reset to defaults';
  shareUrlInput = document.createElement('input');
  shareUrlInput.type = 'text';
  shareUrlInput.id = 'share-url';
  shareUrlInput.className = 'share-url';
  shareUrlInput.readOnly = true;
  shareUrlInput.hidden = true;
  shareUrlInput.spellcheck = false;
  shareUrlInput.setAttribute('aria-label', 'Share URL');
  const fileInput = document.createElement('input');
  fileInput.type = 'file';
  fileInput.id = 'import-file';
  fileInput.accept = 'application/json,.json';
  fileInput.hidden = true;
  io.append(exportBtn, importBtn, shareBtn, resetBtn, shareUrlInput, fileInput);
  const status = document.createElement('div');
  status.className = 'status';
  status.setAttribute('role', 'status');
  panelBody.append(io, status);

  let statusToken = 0;
  function note(text) {
    status.textContent = text;
    const token = ++statusToken;
    setTimeout(() => { if (token === statusToken) status.textContent = ''; }, 4000);
  }
  const weatherWidget = createWeatherWidget(document.getElementById('weather-widget'), note);
  document.getElementById('weather-widget').addEventListener('click', (event) => {
    if (event.target.closest('.weather-place')) openPlaceDialog('weatherZip');
  });
  function applyWeather(fetchNow = false) {
    weatherWidget.update(P, fetchNow);
  }
  applyWeather(true);
  let geoRequest = 0;
  function applyCloudMode() {
    const dynamic = P.cloudMode === 'dynamic';
    if (dynamic && !cloudManual) {
      cloudManual = {};
      for (const key of CLOUD_DRIVEN) cloudManual[key] = P[key];
    }
    if (!dynamic && cloudManual) {
      for (const key of CLOUD_DRIVEN) showDrivenSetting(key, cloudManual[key]);
      cloudManual = null;
    }
    for (const key of CLOUD_DRIVEN) setSettingVisible(key, !dynamic);
    refreshModeGroups();
    if (dynamic) updateDynamicClouds(0);
  }
  function refreshStarControls() {
    const manual = P.starMode !== 'dynamic';
    for (const key of STAR_DRIVEN) setSettingVisible(key, manual);
    setSettingVisible('starSeed', manual && !skyUsesPlace());
    refreshModeGroups();
  }
  function applyStarMode() {
    const dynamic = P.starMode === 'dynamic';
    if (dynamic && !starManual) {
      starManual = {};
      for (const key of STAR_DRIVEN) starManual[key] = P[key];
    }
    if (!dynamic && starManual) {
      for (const key of STAR_DRIVEN) showDrivenSetting(key, starManual[key]);
      starManual = null;
    }
    refreshStarControls();
    if (dynamic) updateDynamicStars();
    envFull = 2;
  }
  function setSettingVisible(key, visible) {
    const control = controls.get(key);
    if (!control?.row) return;
    control.row.hidden = !visible;
    control.input.disabled = !visible;
    control.row.classList.toggle('disabled', !visible);
    if (control.input.required !== undefined) control.input.required = visible;
  }
  function refreshModeGroups() {
    const items = [...panelBody.querySelectorAll('.subgroup, .group')].reverse();
    for (const item of items) {
      const body = item.querySelector(':scope > div');
      item.hidden = ![...body.children].some((child) => !child.hidden);
    }
  }
  function applySkyMode(resolveLocation = false) {
    const placed = skyUsesPlace();
    const dated = P.skyMode === 'dated';
    const lapse = P.skyMode === 'lapse';
    for (const key of ['sunElev', 'sunAzim', 'moonElev', 'moonAzim', 'moonPhase']) {
      setSettingVisible(key, !placed);
    }
    setSettingVisible('zipCode', placed);
    setSettingVisible('skyWhen', dated);
    setSettingVisible('skyLapseStart', lapse);
    setSettingVisible('lapsePace', lapse);
    if (lapse) resetTimeLapse();
    if (dated && !P.skyWhen) {
      P.skyWhen = localDateTimeValue();
      const when = controls.get('skyWhen');
      if (when) when.input.value = P.skyWhen;
      if (resolveLocation) rememberSettings();
    }
    refreshStarControls();
    if (!placed) {
      liveSky = skyInstant = null;
      if (framedSky) restoreDefaultView();
      envFull = 2;
    } else {
      if (!framedSky) frameSkyView();
      if (resolveLocation) resolveZipCode();
    }
  }
  async function resolveZipCode() {
    const query = P.zipCode;
    if (!skyUsesPlace()) return;
    if (P.skyMode === 'dated' && !skyMoment()) {
      skyLocation = liveSky = skyInstant = null;
      note('Choose the date and time to view');
      return;
    }
    const request = ++geoRequest;
    try {
      const location = await resolvePlace(query);
      if (request !== geoRequest || !skyUsesPlace() || P.zipCode !== query) return;
      skyLocation = location;
      if (!refreshPlacedSky()) return;
      const when = P.skyMode === 'dated' ? ` at ${P.skyWhen.replace('T', ' ')}`
        : P.skyMode === 'lapse' ? ` from ${P.skyLapseStart.replace('T', ' ')}` : '';
      note(`${location.name || query}${when}`);
    } catch (error) {
      if (request !== geoRequest) return;
      skyLocation = liveSky = skyInstant = null;
      note(error.message || 'Could not find that place');
    }
  }
  if (skyUsesPlace()) resolveZipCode();
  async function refreshPlaceLabel(key) {
    const control = controls.get(key);
    if (!control?.display) return;
    const query = P[key];
    try {
      const place = await resolvePlace(query);
      if (P[key] !== query) return;
      control.display.textContent = place.name || query;
      control.display.title = place.name || query;
    } catch {
      if (P[key] !== query) return;
      control.display.textContent = query;
      control.display.title = query;
    }
  }
  refreshPlaceLabel('zipCode');
  refreshPlaceLabel('weatherZip');
  placeDialog = document.createElement('div');
  placeDialog.className = 'place-dialog';
  placeDialog.hidden = true;
  const placeSheet = document.createElement('div');
  placeSheet.className = 'sheet';
  placeSheet.setAttribute('role', 'dialog');
  placeSheet.setAttribute('aria-modal', 'true');
  const placeTitle = document.createElement('h2');
  placeTitle.id = 'place-dialog-title';
  placeSheet.setAttribute('aria-labelledby', placeTitle.id);
  const placeInput = document.createElement('input');
  placeInput.type = 'text';
  placeInput.maxLength = 80;
  placeInput.spellcheck = false;
  placeInput.autocomplete = 'off';
  placeInput.placeholder = 'Toledo';
  placeInput.setAttribute('aria-label', 'Location search');
  const placeChoices = document.createElement('div');
  placeChoices.className = 'choices';
  placeChoices.setAttribute('role', 'listbox');
  const placeHintLine = document.createElement('p');
  placeHintLine.className = 'hint';
  const placeActions = document.createElement('div');
  placeActions.className = 'actions';
  const placeCancel = document.createElement('button');
  placeCancel.type = 'button';
  placeCancel.textContent = 'Cancel';
  placeActions.append(placeCancel);
  const placeSearch = document.createElement('div');
  placeSearch.className = 'search';
  placeSearch.append(placeInput, placeChoices, placeHintLine, placeActions);
  const placeConfirm = document.createElement('div');
  placeConfirm.className = 'confirm';
  placeConfirm.hidden = true;
  const placeAsk = document.createElement('p');
  const placeConfirmActions = document.createElement('div');
  placeConfirmActions.className = 'actions';
  const placeNo = document.createElement('button');
  placeNo.type = 'button';
  placeNo.textContent = 'No';
  const placeYes = document.createElement('button');
  placeYes.type = 'button';
  placeYes.className = 'yes';
  placeYes.textContent = 'Yes';
  placeConfirmActions.append(placeNo, placeYes);
  placeConfirm.append(placeAsk, placeConfirmActions);
  placeSheet.append(placeTitle, placeSearch, placeConfirm);
  placeDialog.append(placeSheet);
  document.body.append(placeDialog);
  const placeKeys = ['weatherZip', 'zipCode'];
  let placeDialogKey = '';
  let suggestToken = 0;
  let suggestTimer = 0;
  let pendingChoice = null;
  let pendingOthers = [];
  function placeSettingName(key) {
    return key === 'weatherZip' ? 'the weather location' : 'the sky location';
  }
  function placeMatchesChoice(key, choice) {
    const shown = (controls.get(key)?.display?.textContent || '').trim();
    const stored = String(P[key] || '').trim();
    const names = [choice.value, choice.name, choice.label].map((item) => String(item || '').trim()).filter(Boolean);
    return names.includes(stored) || names.includes(shown);
  }
  function showPlaceSearch() {
    pendingChoice = null;
    pendingOthers = [];
    placeConfirm.hidden = true;
    placeSearch.hidden = false;
  }
  function showPlaceConfirm(choice, others) {
    pendingChoice = choice;
    pendingOthers = others;
    const placeName = choice.name || choice.value;
    const names = others.map(placeSettingName);
    const list = names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
    placeTitle.textContent = 'Other locations';
    placeAsk.textContent = `Also use ${placeName} for ${list}?`;
    placeSearch.hidden = true;
    placeConfirm.hidden = false;
    suggestToken += 1;
    placeYes.focus();
  }
  function applyPlaceToOthers() {
    const choice = pendingChoice;
    const others = pendingOthers;
    for (const key of others) {
      if (choice && !commitSetting(key, choice.value)) note('That place could not be saved');
    }
    closePlaceDialog();
  }
  function closePlaceDialog() {
    if (!placeDialog || placeDialog.hidden) return false;
    placeDialog.hidden = true;
    suggestToken += 1;
    showPlaceSearch();
    const opener = controls.get(placeDialogKey)?.input;
    if (opener) opener.focus();
    return true;
  }
  function selectedChoice() {
    return placeChoices.querySelector('.place-choice[aria-selected="true"]');
  }
  function selectChoice(button) {
    for (const choice of placeChoices.querySelectorAll('.place-choice')) {
      choice.setAttribute('aria-selected', choice === button ? 'true' : 'false');
    }
    button?.scrollIntoView({ block: 'nearest' });
  }
  function chooseListedPlace(button) {
    const choice = button?.placeChoice;
    if (!choice || !placeDialogKey) return;
    rememberChoice(choice);
    if (!commitSetting(placeDialogKey, choice.value)) {
      note('That place could not be saved');
      return;
    }
    const others = placeKeys.filter((key) => key !== placeDialogKey && !placeMatchesChoice(key, choice));
    if (others.length) showPlaceConfirm(choice, others);
    else closePlaceDialog();
  }
  function renderPlaceChoices(choices) {
    placeChoices.replaceChildren();
    for (const choice of choices) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'place-choice';
      button.setAttribute('role', 'option');
      button.textContent = choice.label;
      button.placeChoice = choice;
      button.addEventListener('click', () => chooseListedPlace(button));
      placeChoices.append(button);
    }
    selectChoice(placeChoices.querySelector('.place-choice'));
  }
  async function searchPlaceDialog() {
    const query = placeInput.value.trim();
    const token = ++suggestToken;
    if (query.length < 2) {
      placeChoices.replaceChildren();
      placeHintLine.textContent = 'Type a city, such as Toledo';
      return;
    }
    placeHintLine.textContent = 'Searching…';
    placeChoices.replaceChildren();
    try {
      const choices = await suggestPlaces(query);
      if (token !== suggestToken || placeDialog.hidden) return;
      renderPlaceChoices(choices);
      placeHintLine.textContent = choices.length ? 'Choose a place' : 'No matching places';
    } catch (error) {
      if (token !== suggestToken || placeDialog.hidden) return;
      placeChoices.replaceChildren();
      placeHintLine.textContent = error.message || 'Could not search for that place';
    }
  }
  function openPlaceDialog(key) {
    placeDialogKey = key;
    placeTitle.textContent = key === 'weatherZip' ? 'Weather location' : 'Sky location';
    const shown = controls.get(key)?.display?.textContent || P[key];
    placeInput.value = shown;
    placeChoices.replaceChildren();
    placeHintLine.textContent = shown.trim().length < 2 ? 'Type a city, such as Toledo' : 'Searching…';
    showPlaceSearch();
    placeDialog.hidden = false;
    placeInput.focus();
    placeInput.select();
    searchPlaceDialog();
  }
  placeInput.addEventListener('input', () => {
    clearTimeout(suggestTimer);
    suggestTimer = setTimeout(searchPlaceDialog, 250);
  });
  placeInput.addEventListener('keydown', (event) => {
    const buttons = [...placeChoices.querySelectorAll('.place-choice')];
    const current = buttons.indexOf(selectedChoice());
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      if (!buttons.length) return;
      event.preventDefault();
      const step = event.key === 'ArrowDown' ? 1 : -1;
      selectChoice(buttons[(current + step + buttons.length) % buttons.length]);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      chooseListedPlace(selectedChoice() || buttons[0]);
    }
  });
  placeCancel.addEventListener('click', closePlaceDialog);
  placeNo.addEventListener('click', closePlaceDialog);
  placeYes.addEventListener('click', applyPlaceToOthers);
  placeDialog.addEventListener('click', (event) => {
    if (event.target === placeDialog) closePlaceDialog();
  });
  placeDialog.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    closePlaceDialog();
  });
  function commitSetting(key, value) {
    if (!Object.hasOwn(P, key)) return false;
    const control = controls.get(key);
    if (BOOL_KEYS.has(key)) {
      if (typeof value !== 'boolean') return false;
      P[key] = value;
      if (control) {
        control.input.checked = value;
        control.output.textContent = value ? control.onText : control.offText;
      }
      if (key === 'sound') oceanAudio.setEnabled(value);
      if (key === 'showInfo' || key === 'showButtons') applyShowInfo();
      if (key.startsWith('clock')) applyClock();
      if (key.startsWith('weather')) applyWeather();
      if (key === 'moon' || key === 'stars' || key === 'cloudMotion') envFull = 2;
      keepManualSetting(key);
      rememberSettings();
      return true;
    }
    if (STRING_KEYS.has(key)) {
      value = coerceSetting(key, value);
      if (value === undefined) return false;
      P[key] = value;
      if (control) control.input.value = value;
      if (key.startsWith('clock')) applyClock();
      if (key.startsWith('weather')) applyWeather(key === 'weatherZip' || key === 'weatherUnit');
      if (key === 'zipCode' || key === 'weatherZip') refreshPlaceLabel(key);
      if (key === 'skyMode') applySkyMode(true);
      if (key === 'cloudMode') applyCloudMode();
      if (key === 'starMode') applyStarMode();
      if (key === 'skyLapseStart') resetTimeLapse();
      if (key === 'zipCode' || key === 'skyWhen' || key === 'skyLapseStart') resolveZipCode();
      if (key === 'skyMode' || key === 'zipCode' || key === 'skyWhen' || key === 'skyLapseStart') envFull = 2;
      keepManualSetting(key);
      rememberSettings();
      return true;
    }
    if (!Number.isFinite(value)) return false;
    if (control && control.kind !== 'bool') {
      value = Math.min(control.max, Math.max(control.min, value));
      control.input.value = String(value);
      value = Number(control.input.value);
      control.output.textContent = control.input.value;
    }
    P[key] = value;
    const kind = control ? control.kind : (key === 'swellSpread' ? 'spec' : '');
    if (kind === 'spec') needSpectrum = true;
    if (kind === 'lut') needLUT = true;
    if (kind === 'clock') applyClock();
    if (kind === 'weather') applyWeather();
    if (kind !== 'audio' && kind !== 'clock' && kind !== 'weather' && kind !== 'lapse') envFull = 2;
    keepManualSetting(key);
    rememberSettings();
    return true;
  }
  function keepManualSetting(key) {
    if (cloudManual && CLOUD_DRIVEN.includes(key)) cloudManual[key] = P[key];
    if (starManual && STAR_DRIVEN.includes(key)) starManual[key] = P[key];
  }
  function booleanSetting(raw) {
    if (typeof raw === 'boolean') return raw;
    if (raw === 1 || raw === 0) return Boolean(raw);
    if (typeof raw !== 'string') return undefined;
    const value = raw.trim().toLowerCase();
    if (value === '1' || value === 'true' || value === 'on') return true;
    if (value === '0' || value === 'false' || value === 'off') return false;
    return undefined;
  }
  function exportSettings() {
    const blob = new Blob([JSON.stringify(P, null, 2) + '\n'], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'ocean-settings.json';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1500);
    note('Exported settings');
  }
  function importSettings(data) {
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      note('Settings file must be a JSON object');
      return;
    }
    let count = 0;
    for (const key of Object.keys(P)) {
      if (!Object.hasOwn(data, key)) continue;
      const value = BOOL_KEYS.has(key) ? booleanSetting(data[key])
        : STRING_KEYS.has(key) ? data[key] : Number(data[key]);
      if (commitSetting(key, value)) count++;
    }
    note(count ? `Imported ${count} setting${count === 1 ? '' : 's'}` : 'No recognized settings');
  }
  function resetAll() {
    cloudManual = null;
    starManual = null;
    for (const key of Object.keys(DEFAULTS)) commitSetting(key, DEFAULTS[key]);
    Object.assign(cam, CAM_DEFAULT);
    note('Reset to defaults');
  }
  exportBtn.addEventListener('click', exportSettings);
  importBtn.addEventListener('click', () => fileInput.click());
  shareBtn.addEventListener('click', async () => {
    const url = shareSettingsUrl();
    shareUrlInput.hidden = false;
    shareUrlInput.value = url;
    shareUrlInput.focus();
    shareUrlInput.select();
    try {
      await navigator.clipboard.writeText(url);
      note('Share link copied');
    } catch {
      note('Share link selected');
    }
  });
  shareUrlInput.addEventListener('focus', () => shareUrlInput.select());
  shareUrlInput.addEventListener('click', () => shareUrlInput.select());
  resetBtn.addEventListener('click', resetAll);
  if (sharedSettingsFailed) {
    const shareError = document.createElement('div');
    shareError.className = 'status';
    shareError.textContent = 'Could not read the shared settings';
    status.insertAdjacentElement('afterend', shareError);
  }
  fileInput.addEventListener('change', async () => {
    const file = fileInput.files && fileInput.files[0];
    if (!file) return;
    try {
      const text = await file.text();
      importSettings(JSON.parse(text));
    } catch {
      note('Could not read that settings file');
    } finally {
      fileInput.value = '';
    }
  });

  if (qs.get('ui') === '0') {
    document.getElementById('hud').style.display = 'none';
    document.getElementById('toolbar').style.display = 'none';
    panel.classList.add('hidden');
  }

  const hudFps = document.getElementById('fps');

  // --------------------------------------------------------------------------------------
  // Frame
  // --------------------------------------------------------------------------------------
  const submitList = [null];
  const shotName = qs.get('shot');
  const shotFrames = Number(qs.get('frames')) || 240;
  const shotSeq = Number(qs.get('seq')) || 1;
  let shotIdx = 0;
  const fixedDt = shotName ? 1 / 60 : 0;
  let last = performance.now();
  let fpsAcc = 0, fpsN = 0, fpsT = 0;
  let shooting = false;

  function encodeSim(cp) {
    cp.setPipeline(evolvePipe);
    cp.setBindGroup(0, bgEvolve);
    cp.dispatchWorkgroups(N / 16, N / 16, C);
    cp.setPipeline(rowsPipe);
    cp.setBindGroup(0, bgRows);
    cp.dispatchWorkgroups(N, 1, C);
    cp.setPipeline(colsPipe);
    cp.setBindGroup(0, bgCols);
    cp.dispatchWorkgroups(N, 1, C);
    cp.setPipeline(simMipPipe);
    for (let m = 1; m < SIM_MIP_COUNT; m++) {
      const s = N >> m;
      cp.setBindGroup(0, bgSimMips[m - 1]);
      cp.dispatchWorkgroups(Math.ceil(s / 8), Math.ceil(s / 8), C);
    }
    // foam clipmaps
    foamCur = 1 - foamCur;
    cp.setPipeline(foamUpdPipe);
    cp.setBindGroup(0, bgFoamUpd[foamCur]);
    cp.dispatchWorkgroups(FOAM_RES / 8, FOAM_RES / 8, 2);
    cp.setPipeline(arr16MipPipe);
    const fm = bgFoamMips[foamCur];
    for (let m = 1; m < FOAMW_MIPS; m++) {
      const s = Math.max(1, FOAM_RES >> m);
      cp.setBindGroup(0, fm[m - 1]);
      cp.dispatchWorkgroups(Math.ceil(s / 8), Math.ceil(s / 8), 2);
    }
  }

  function writeFoamUniforms(dt) {
    for (let l = 0; l < 2; l++) {
      const ts = FOAM_LEVEL_SIZE[l] / FOAM_RES;
      const cx = Math.floor(cam.x / ts), cz = Math.floor(cam.z / ts);
      foamUI[l * 4] = cx; foamUI[l * 4 + 1] = cz;
      // first frame: pretend the previous window was far away so everything is reset
      foamUI[l * 4 + 2] = foamFirst ? cx + 100000 : foamSnap[l * 2];
      foamUI[l * 4 + 3] = foamFirst ? cz + 100000 : foamSnap[l * 2 + 1];
      foamSnap[l * 2] = cx; foamSnap[l * 2 + 1] = cz;
      foamUF[8 + l] = ts;
    }
    foamFirst = false;
    foamUF[10] = dt; foamUF[11] = 0.22;          // decay 1/s
    foamUF[12] = 0.52 + 0.16 * P.foam; foamUF[13] = 2.0; foamUF[14] = 1.0; foamUF[15] = 0;
    for (let c = 0; c < C; c++) { foamUF[16 + c] = CASC_L[c]; foamUF[24 + c] = 1 / CASC_L[c]; }
    const drift = 0.03 * P.windSpeed;
    foamUF[32] = Math.cos(P.windDir * D2R) * drift; foamUF[33] = Math.sin(P.windDir * D2R) * drift;
    device.queue.writeBuffer(foamUBO, 0, foamUArr);
  }

  function frame(now) {
    if (shooting) return;  // paused while a screenshot is read back
    requestAnimationFrame(frame);
    resize();
    let dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    fpsAcc += dt; fpsN++; fpsT += dt;
    if (fpsT > 0.5) {
      const fps = fpsN / fpsAcc;
      hudFps.textContent = `${fps.toFixed(0)} fps  ${(1000 / fps).toFixed(2)} ms` +
        (hasTS ? `  |  GPU ${gpuMs.toFixed(2)} ms` : '') + `  |  ${nodeCount} nodes  ${W}x${H}`;
      fpsAcc = 0; fpsN = 0; fpsT = 0;
    }
    updateDynamicClouds(dt);
    updateDynamicStars();
    advanceTimeLapse(dt);
    if (fixedDt) dt = fixedDt;
    advanceCloudMotion(dt);
    updateCamera(dt);
    simTime += dt;
    if (simTime > LOOP) simTime -= LOOP;
    frameIndex++;
    audioWaterH += (waterH - audioWaterH) * Math.min(1, dt * 12);
    oceanAudio.update(simTime, audioWaterH, dt, cam, P);

    writeFrame(simTime);
    writeSimStatic();
    simF[52] = simTime; simF[53] = dt;
    device.queue.writeBuffer(simUBO, 0, simF);
    writeFoamUniforms(dt);
    selectAll();
    if (nodeCount) device.queue.writeBuffer(instBuf, 0, instData, 0, nodeCount * 4);

    const enc = device.createCommandEncoder();
    const cp = enc.beginComputePass(computeDesc);
    if (needSpectrum) {
      cp.setPipeline(initPipe);
      cp.setBindGroup(0, bgInit);
      cp.dispatchWorkgroups(N / 16, N / 16, C);
      needSpectrum = false;
    }
    if (needLUT) {
      atmoF[0] = P.haze;
      device.queue.writeBuffer(atmoUBO, 0, atmoF);
      cp.setPipeline(transPipe);
      cp.setBindGroup(0, bgTrans);
      cp.dispatchWorkgroups(256 / 8, 64 / 8);
      cp.setPipeline(msPipe);
      cp.setBindGroup(0, bgMS);
      cp.dispatchWorkgroups(32 / 8, 32 / 8);
      needLUT = false;
    }
    encodeSim(cp);
    cp.setPipeline(probePipe);
    cp.setBindGroup(0, bgProbe);
    cp.dispatchWorkgroups(1);
    cp.setPipeline(skyViewPipe);
    cp.setBindGroup(0, bgSkyView);
    cp.dispatchWorkgroups(Math.ceil(SKY_W / 8), Math.ceil(SKY_H / 8));
    cp.setPipeline(sunVisPipe);
    cp.setBindGroup(0, bgSunVis);
    cp.dispatchWorkgroups(1);
    cp.setPipeline(envPipe);
    cp.setBindGroup(0, bgEnv);
    // one cube face per frame (all six on start-up / after parameter changes)
    cp.dispatchWorkgroups(ENV_SIZE / 8, ENV_SIZE / 8, envFull > 0 ? 6 : 1);
    if (envFull > 0) envFull--;
    cp.setPipeline(cubeMipPipe);
    for (let m = 1; m < ENV_MIPS; m++) {
      const s = Math.max(1, ENV_SIZE >> m);
      cp.setBindGroup(0, bgCubeMips[m - 1]);
      cp.dispatchWorkgroups(Math.ceil(s / 8), Math.ceil(s / 8), 6);
    }
    cp.end();

    const rp = enc.beginRenderPass(mainPass);
    if (nodeCount) {
      rp.setPipeline(oceanPipe);
      rp.setBindGroup(0, bgOcean[foamCur]);
      rp.setVertexBuffer(0, instBuf);
      rp.setIndexBuffer(idxBuf, 'uint16');
      rp.drawIndexed(GRID * GRID * 6, nodeCount);
    }
    rp.setPipeline(skyPipe);
    rp.setBindGroup(0, bgSky);
    rp.draw(3);
    rp.end();

    for (let m = 0; m < BLOOM_LEVELS; m++) {
      const p = enc.beginRenderPass(downPasses[m]);
      p.setPipeline(downPipe);
      p.setBindGroup(0, downBGs[m]);
      p.draw(3);
      p.end();
    }
    for (let i = 0; i < upPasses.length; i++) {
      const p = enc.beginRenderPass(upPasses[i]);
      p.setPipeline(upPipe);
      p.setBindGroup(0, upBGs[i]);
      p.draw(3);
      p.end();
    }

    compData[0] = P.exposure; compData[1] = P.bloom; compData[2] = frameIndex % 64; compData[3] = 0.10;
    compData[4] = 1.05; compData[5] = 1.06; compData[6] = -0.19; compData[7] = 0;
    device.queue.writeBuffer(compUBO, 0, compData);
    const swapTex = ctx.getCurrentTexture();
    compPass.colorAttachments[0].view = swapTex.createView();
    const pc = enc.beginRenderPass(compPass);
    pc.setPipeline(compPipe);
    pc.setBindGroup(0, bgComp);
    pc.draw(3);
    pc.end();

    let doProbe = false;
    if (!probePending && (frameIndex & 7) === 0) {
      enc.copyBufferToBuffer(probeOut, 0, probeRead, 0, 16);
      doProbe = true;
    }
    let doTs = false;
    if (hasTS && !tsPending && (frameIndex & 7) === 0) {
      enc.resolveQuerySet(tsQuery, 0, 2, tsResolve, 0);
      enc.copyBufferToBuffer(tsResolve, 0, tsRead, 0, 16);
      doTs = true;
    }
    let readBuf = null;
    if (shotName && shotIdx < shotSeq && frameIndex >= shotFrames + shotIdx) {
      shooting = true;
      const bpr = Math.ceil(W * 4 / 256) * 256;
      readBuf = device.createBuffer({ size: bpr * H, usage: GU.MAP_READ | GU.COPY_DST });
      enc.copyTextureToBuffer({ texture: swapTex }, { buffer: readBuf, bytesPerRow: bpr }, [W, H]);
      saveShot(readBuf, bpr);
    }
    submitList[0] = enc.finish();
    device.queue.submit(submitList);
    if (doProbe) { probePending = true; probeRead.mapAsync(GPUMapMode.READ).then(onProbe, onProbeFail); }
    if (doTs) { tsPending = true; tsRead.mapAsync(GPUMapMode.READ).then(onTsMapped, onTsFail); }
    if (readBuf) saveShot(readBuf, Math.ceil(W * 4 / 256) * 256, true);
  }

  async function saveShot(buf, bpr, go) {
    if (!go) return;
    await buf.mapAsync(GPUMapMode.READ);
    const src = new Uint8Array(buf.getMappedRange());
    const img = new ImageData(W, H);
    const bgra = swapFormat === 'bgra8unorm';
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const s = y * bpr + x * 4, d = (y * W + x) * 4;
        img.data[d] = src[s + (bgra ? 2 : 0)];
        img.data[d + 1] = src[s + 1];
        img.data[d + 2] = src[s + (bgra ? 0 : 2)];
        img.data[d + 3] = 255;
      }
    }
    buf.unmap();
    const oc = new OffscreenCanvas(W, H);
    oc.getContext('2d').putImageData(img, 0, 0);
    const blob = await oc.convertToBlob({ type: 'image/png' });
    const nm = shotSeq > 1 ? shotName.replace('.png', `_${shotIdx}.png`) : shotName;
    await fetch('/__shot?name=' + encodeURIComponent(nm), { method: 'POST', body: blob });
    log('shot saved ' + nm + ' gpu ' + gpuMs.toFixed(2) + 'ms nodes ' + nodeCount);
    shotIdx++;
    shooting = false;
    if (shotIdx < shotSeq) { requestAnimationFrame(frame); return; }
    if (shotSeq > 1) await fetch('/__shot?name=' + encodeURIComponent(shotName), { method: 'POST', body: blob });
    document.title = 'SHOT DONE';
    if (qs.get('keep') === '1') requestAnimationFrame(frame);
  }

  resize();
  addEventListener('resize', resize);
  requestAnimationFrame(frame);
}

main().catch((e) => { log('init failed: ' + (e && e.stack || e)); });
