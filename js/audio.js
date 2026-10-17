// Procedural ocean audio. The visual height probe drives the envelopes, so passing
// crests sound stronger without requiring any downloaded audio assets.

const clamp = (v, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, v));
const smoothstep = (a, b, v) => {
  const x = clamp((v - a) / (b - a));
  return x * x * (3 - 2 * x);
};

function noiseBuffer(ctx, seconds, colour, seed) {
  const length = Math.ceil(ctx.sampleRate * seconds);
  const buffer = ctx.createBuffer(2, length, ctx.sampleRate);
  let state = seed >>> 0;
  const random = () => {
    state = (1664525 * state + 1013904223) >>> 0;
    return state / 2147483648 - 1;
  };

  for (let channel = 0; channel < 2; channel++) {
    const data = buffer.getChannelData(channel);
    let brown = 0;
    let p0 = 0, p1 = 0, p2 = 0, p3 = 0, p4 = 0, p5 = 0, p6 = 0;
    for (let i = 0; i < length; i++) {
      const white = random();
      if (colour === 'brown') {
        brown = clamp(brown + white * 0.018, -1, 1) * 0.998;
        data[i] = brown * 2.4;
      } else if (colour === 'pink') {
        // Paul Kellet's economical pink-noise filter.
        p0 = 0.99886 * p0 + white * 0.0555179;
        p1 = 0.99332 * p1 + white * 0.0750759;
        p2 = 0.96900 * p2 + white * 0.1538520;
        p3 = 0.86650 * p3 + white * 0.3104856;
        p4 = 0.55000 * p4 + white * 0.5329522;
        p5 = -0.7616 * p5 - white * 0.0168980;
        data[i] = (p0 + p1 + p2 + p3 + p4 + p5 + p6 + white * 0.5362) * 0.11;
        p6 = white * 0.115926;
      } else {
        data[i] = white;
      }
    }
  }
  return buffer;
}

function makeLayer(ctx, buffer, filters) {
  const source = ctx.createBufferSource();
  source.buffer = buffer;
  source.loop = true;
  let tail = source;
  for (const [type, frequency, q = 0.7] of filters) {
    const filter = ctx.createBiquadFilter();
    filter.type = type;
    filter.frequency.value = frequency;
    filter.Q.value = q;
    tail.connect(filter);
    tail = filter;
  }
  const gain = ctx.createGain();
  gain.gain.value = 0;
  tail.connect(gain);
  source.start();
  return { source, gain, tail };
}

export function createOceanAudio(button, onChange) {
  let ctx = null;
  let master = null;
  let pan = null;
  let rumble = null;
  let wash = null;
  let hiss = null;
  let enabled = false;
  let lastHeight = 0;
  let heightReady = false;
  let waveVelocity = 0;
  let suspendToken = 0;

  function showState() {
    if (!button) return;
    button.textContent = enabled ? 'Sound on' : 'Sound off';
    button.setAttribute('aria-pressed', String(enabled));
    button.classList.toggle('on', enabled);
  }

  function init() {
    if (ctx) return true;
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    if (!AudioContext) {
      if (button) {
        button.textContent = 'Sound unavailable';
        button.disabled = true;
      }
      return false;
    }

    ctx = new AudioContext();
    master = ctx.createGain();
    master.gain.value = 0;
    pan = ctx.createStereoPanner();
    const compressor = ctx.createDynamicsCompressor();
    compressor.threshold.value = -18;
    compressor.knee.value = 18;
    compressor.ratio.value = 3;
    compressor.attack.value = 0.02;
    compressor.release.value = 0.45;

    const brown = noiseBuffer(ctx, 7.1, 'brown', 0x51ea);
    const pink = noiseBuffer(ctx, 8.3, 'pink', 0xc0a57);
    const white = noiseBuffer(ctx, 6.7, 'white', 0x0cea);
    rumble = makeLayer(ctx, brown, [['lowpass', 190]]);
    wash = makeLayer(ctx, pink, [['highpass', 65], ['lowpass', 1450]]);
    hiss = makeLayer(ctx, white, [['highpass', 900], ['lowpass', 6200]]);

    rumble.gain.connect(pan);
    wash.gain.connect(pan);
    hiss.gain.connect(pan);
    pan.connect(master);
    master.connect(compressor);
    compressor.connect(ctx.destination);
    return true;
  }

  function resumeIfNeeded() {
    if (enabled && ctx && ctx.state === 'suspended') ctx.resume();
  }
  addEventListener('pointerdown', resumeIfNeeded);
  addEventListener('keydown', resumeIfNeeded);

  async function setEnabled(next) {
    if (next && !init()) {
      onChange?.(false);
      return false;
    }
    enabled = next;
    suspendToken++;
    showState();
    onChange?.(enabled);
    if (!ctx) return enabled;

    if (enabled) {
      await ctx.resume();
    } else {
      const token = suspendToken;
      master.gain.setTargetAtTime(0, ctx.currentTime, 0.08);
      setTimeout(() => {
        if (!enabled && token === suspendToken && ctx.state === 'running') ctx.suspend();
      }, 450);
    }
  }

  function update(simTime, waterHeight, dt, camera, params) {
    if (!enabled || !ctx || ctx.state !== 'running') return;
    if (!heightReady) {
      lastHeight = waterHeight;
      heightReady = true;
    }

    const sampleDt = clamp(dt, 1 / 240, 0.1);
    const rawVelocity = (waterHeight - lastHeight) / sampleDt;
    lastHeight = waterHeight;
    waveVelocity += (rawVelocity - waveVelocity) * Math.min(1, sampleDt * 2.5);

    const waveHeight = Math.max(0.35, params.swellHs * 0.32 + params.windSpeed * 0.025);
    const crest = smoothstep(0.05, 0.9, waterHeight / waveHeight);
    const rising = smoothstep(0.05, 1.8, waveVelocity);
    const omega = Math.sqrt(9.81 * (Math.PI * 2 / params.swellLength));
    const swellPulse = 0.5 + 0.5 * Math.sin(simTime * omega - 0.65);
    const sync = clamp(params.audioSync ?? 1, 0, 2);
    const surge = clamp(0.28 + (crest * 0.50 + rising * 0.22 + swellPulse * 0.12) * sync);
    const wind = clamp((params.windSpeed - 2) / 18);
    const breaking = clamp(crest * (0.35 + rising * 0.65) * params.foam * sync);
    const altitude = Math.max(0, camera.y - waterHeight);
    const distanceFade = 1 / (1 + Math.max(0, altitude - 3) / 85);
    const volume = clamp(params.audioVolume, 0, 1) * distanceFade;
    const rumbleLevel = clamp(params.audioRumble ?? 1, 0, 2);
    const washLevel = clamp(params.audioWash ?? 1, 0, 2);
    const hissLevel = clamp(params.audioHiss ?? 1, 0, 2);
    const stereo = clamp(params.audioStereo ?? 1, 0, 2);
    const now = ctx.currentTime;

    master.gain.setTargetAtTime(volume * 0.36, now, 0.12);
    rumble.gain.gain.setTargetAtTime((0.16 + surge * 0.22 + wind * 0.08) * rumbleLevel, now, 0.22);
    wash.gain.gain.setTargetAtTime((0.20 + surge * 0.28 + breaking * 0.24) * washLevel, now, 0.10);
    hiss.gain.gain.setTargetAtTime((0.025 + wind * 0.10 + breaking * 0.22) * hissLevel, now, 0.07);
    wash.tail.frequency.setTargetAtTime(800 + wind * 1100 + breaking * 850, now, 0.18);
    hiss.tail.frequency.setTargetAtTime(3500 + wind * 2800, now, 0.25);

    const windAngle = params.windDir * Math.PI / 180 - camera.yaw;
    pan.pan.setTargetAtTime(Math.sin(windAngle) * 0.28 * stereo, now, 0.3);
  }

  if (button) button.addEventListener('click', (event) => {
    event.stopPropagation();
    setEnabled(!enabled);
  });
  showState();

  return {
    toggle: () => setEnabled(!enabled),
    setEnabled,
    update,
  };
}
