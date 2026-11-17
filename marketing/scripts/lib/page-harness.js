// Injected into the app page before any app script runs (Playwright addInitScript).
// The app itself is not modified. This only replaces the page's clocks so a capture can
// step the real renderer one video frame at a time:
//
//  - requestAnimationFrame, performance.now and Date follow a virtual clock that advances
//    exactly 1/fps per captured frame, so waves move at real speed in the video no matter
//    how long each frame takes to render and read back.
//  - Math.random is seeded, so lightning timing and thunder are repeatable.
//  - AudioContext becomes an OfflineAudioContext that renders in lockstep with the frames,
//    so the app's own procedural ocean, rain and thunder graph is recorded sample-aligned.
//
// window.__CAPTURE__ = { seed, fps, dateMs, audio: { sampleRate, seconds } } must be set
// by an earlier init script.
(() => {
  const cfg = window.__CAPTURE__ || {};
  const fps = cfg.fps || 30;

  // Seeded PRNG (mulberry32).
  let seed = (cfg.seed >>> 0) || 1;
  Math.random = function random() {
    seed = (seed + 0x6d2b79f5) >>> 0;
    let t = seed;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  // Virtual clock.
  const realNow = performance.now.bind(performance);
  const realRaf = window.requestAnimationFrame.bind(window);
  let vnow = realNow();
  const vstart = vnow;
  const RealDate = Date;
  const dateBase = Number.isFinite(cfg.dateMs) ? cfg.dateMs : RealDate.now();
  const virtualDateMs = () => dateBase + (vnow - vstart);
  performance.now = () => vnow;
  class VirtualDate extends RealDate {
    constructor(...args) {
      if (args.length === 0) super(virtualDateMs());
      else super(...args);
    }
    static now() { return virtualDateMs(); }
  }
  window.Date = VirtualDate;

  // While `free` is true the app renders on real animation frames but virtual time stands
  // still (dt = 0), so how long loading takes never changes the simulation.
  let free = true;
  let queue = [];
  let nextId = 1;
  window.requestAnimationFrame = (cb) => {
    const id = nextId++;
    queue.push({ id, cb });
    return id;
  };
  window.cancelAnimationFrame = (id) => { queue = queue.filter((q) => q.id !== id); };
  function pump() {
    if (!free) return;
    runQueue(vnow);
    realRaf(pump);
  }
  realRaf(pump);
  function runQueue(ts) {
    const list = queue;
    queue = [];
    for (const { cb } of list) {
      try { cb(ts); } catch (e) { console.error(e); state.errors.push(String(e && e.stack || e)); }
    }
  }

  // Remember the queue the app submits to, so a step can wait for the GPU.
  let gpuQueue = null;
  if (window.GPUQueue) {
    const submit = GPUQueue.prototype.submit;
    GPUQueue.prototype.submit = function (...args) {
      gpuQueue = this;
      return submit.apply(this, args);
    };
  }
  let deviceLost = null;
  if (window.GPUAdapter) {
    const requestDevice = GPUAdapter.prototype.requestDevice;
    GPUAdapter.prototype.requestDevice = async function (...args) {
      const device = await requestDevice.apply(this, args);
      device.lost.then((info) => { deviceLost = info.message || 'device lost'; });
      device.addEventListener?.('uncapturederror', (e) => state.errors.push('GPU: ' + e.error.message));
      return device;
    };
  }

  // Offline audio rendered in lockstep with the frames.
  const audioCfg = cfg.audio || null;
  let vac = null;
  let audioFrames = 0;
  let renderPromise = null;
  const NativeOffline = window.OfflineAudioContext;
  if (audioCfg && NativeOffline) {
    const length = Math.ceil(audioCfg.sampleRate * audioCfg.seconds);
    class VirtualAudioContext extends NativeOffline {
      constructor() {
        super({ numberOfChannels: 2, length, sampleRate: audioCfg.sampleRate });
        vac = this;
        audioFrames = 0;
      }
      get state() { return 'running'; }
      resume() { return Promise.resolve(); }
      suspend() { return Promise.resolve(); }
      close() { return Promise.resolve(); }
    }
    window.AudioContext = VirtualAudioContext;
    window.webkitAudioContext = VirtualAudioContext;
  }
  async function advanceAudio() {
    if (!vac) return;
    audioFrames++;
    const t = audioFrames / fps;
    if (t * audioCfg.sampleRate >= vac.length - 128) return;
    const reached = NativeOffline.prototype.suspend.call(vac, t);
    if (!renderPromise) renderPromise = NativeOffline.prototype.startRendering.call(vac);
    else NativeOffline.prototype.resume.call(vac);
    await reached;
  }

  const state = { errors: [] };
  window.__cap = {
    state,
    // Stop following real time. Every later frame comes from step().
    hold() { free = false; },
    get frozen() { return !free; },
    async step(frames = 1) {
      for (let i = 0; i < frames; i++) {
        vnow += 1000 / fps;
        runQueue(vnow);
        if (gpuQueue) await gpuQueue.onSubmittedWorkDone();
        await advanceAudio();
      }
      if (deviceLost) throw new Error('WebGPU device lost: ' + deviceLost);
    },
    // Wait for the compositor to present the last rendered frame.
    presented() { return new Promise((r) => realRaf(() => realRaf(r))); },
    audioTime() { return vac ? audioFrames / fps : null; },
    hasAudio() { return Boolean(vac); },
    // Finish rendering and return [startSec, endSec) as 16-bit PCM WAV, base64.
    async takeAudio(startSec, endSec) {
      if (!vac) return null;
      if (!renderPromise) renderPromise = NativeOffline.prototype.startRendering.call(vac);
      else NativeOffline.prototype.resume.call(vac);
      const buffer = await renderPromise;
      const sr = buffer.sampleRate;
      const a = Math.max(0, Math.round(startSec * sr));
      const b = Math.min(buffer.length, Math.round(endSec * sr));
      const n = Math.max(0, b - a);
      const ch = [buffer.getChannelData(0), buffer.getChannelData(1)];
      const out = new DataView(new ArrayBuffer(44 + n * 4));
      const str = (o, s) => { for (let i = 0; i < s.length; i++) out.setUint8(o + i, s.charCodeAt(i)); };
      str(0, 'RIFF'); out.setUint32(4, 36 + n * 4, true); str(8, 'WAVE'); str(12, 'fmt ');
      out.setUint32(16, 16, true); out.setUint16(20, 1, true); out.setUint16(22, 2, true);
      out.setUint32(24, sr, true); out.setUint32(28, sr * 4, true); out.setUint16(32, 4, true);
      out.setUint16(34, 16, true); str(36, 'data'); out.setUint32(40, n * 4, true);
      let peak = 0;
      for (let i = 0; i < n; i++) {
        for (let c = 0; c < 2; c++) {
          const v = Math.max(-1, Math.min(1, ch[c][a + i]));
          peak = Math.max(peak, Math.abs(v));
          out.setInt16(44 + i * 4 + c * 2, v < 0 ? v * 0x8000 : v * 0x7fff, true);
        }
      }
      const bytes = new Uint8Array(out.buffer);
      let bin = '';
      for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
      return { wav: btoa(bin), peak, sampleRate: sr, seconds: n / sr };
    },
  };
})();
