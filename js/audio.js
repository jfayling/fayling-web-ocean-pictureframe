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
  let rainBus = null;
  let rainBed = null;
  let rainRoar = null;
  let rainTick = null;
  let rainWind = null;
  let thunderGain = null;
  let crackBuffer = null;
  let rumbleBuffer = null;
  const thunderQueue = [];
  let enabled = false;
  let oceanAudible = true;
  let rainAudible = true;
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

    rainBus = ctx.createGain();
    rainBus.gain.value = 0;
    const rainPink = noiseBuffer(ctx, 7.7, 'pink', 0x5a11);
    const rainBrown = noiseBuffer(ctx, 9.1, 'brown', 0x71de);
    const rainWhite = noiseBuffer(ctx, 5.3, 'white', 0x2c0d);
    rainBed = makeLayer(ctx, rainPink, [['highpass', 700], ['lowpass', 5400]]);
    rainRoar = makeLayer(ctx, rainBrown, [['highpass', 90], ['lowpass', 520]]);
    rainTick = makeLayer(ctx, rainWhite, [['highpass', 1800], ['lowpass', 7600]]);
    rainWind = makeLayer(ctx, rainBrown, [['lowpass', 240]]);
    rainBed.gain.connect(rainBus);
    rainRoar.gain.connect(rainBus);
    rainTick.gain.connect(rainBus);
    rainWind.gain.connect(rainBus);
    thunderGain = ctx.createGain();
    thunderGain.gain.value = 0.9;
    thunderGain.connect(compressor);
    rainBus.connect(compressor);
    crackBuffer = noiseBuffer(ctx, 2.0, 'pink', 0xabc1);
    rumbleBuffer = noiseBuffer(ctx, 5.5, 'brown', 0x44e2);

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
      thunderGain?.gain.setTargetAtTime(0.9, ctx.currentTime, 0.1);
    } else {
      const token = suspendToken;
      master.gain.setTargetAtTime(0, ctx.currentTime, 0.08);
      rainBus?.gain.setTargetAtTime(0, ctx.currentTime, 0.08);
      thunderGain?.gain.setTargetAtTime(0, ctx.currentTime, 0.05);
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
    oceanAudible = params.oceanPlayback !== false;
    rainAudible = params.rainPlayback !== false;
    const volume = clamp(params.audioVolume, 0, 1) * distanceFade;
    const rumbleLevel = clamp(params.audioRumble ?? 1, 0, 2);
    const washLevel = clamp(params.audioWash ?? 1, 0, 2);
    const hissLevel = clamp(params.audioHiss ?? 1, 0, 2);
    const stereo = clamp(params.audioStereo ?? 1, 0, 2);
    const now = ctx.currentTime;

    master.gain.setTargetAtTime(oceanAudible ? volume * 0.36 : 0, now, 0.12);
    rumble.gain.gain.setTargetAtTime((0.16 + surge * 0.22 + wind * 0.08) * rumbleLevel, now, 0.22);
    wash.gain.gain.setTargetAtTime((0.20 + surge * 0.28 + breaking * 0.24) * washLevel, now, 0.10);
    hiss.gain.gain.setTargetAtTime((0.025 + wind * 0.10 + breaking * 0.22) * hissLevel, now, 0.07);
    wash.tail.frequency.setTargetAtTime(800 + wind * 1100 + breaking * 850, now, 0.18);
    hiss.tail.frequency.setTargetAtTime(3500 + wind * 2800, now, 0.25);

    const windAngle = params.windDir * Math.PI / 180 - camera.yaw;
    pan.pan.setTargetAtTime(Math.sin(windAngle) * 0.28 * stereo, now, 0.3);
    updateRain(now, sampleDt, camera, params);
  }

  function updateRain(now, dt, camera, params) {
    if (!rainBus) return;
    if (!rainAudible) {
      rainBus.gain.setTargetAtTime(0, now, 0.12);
      thunderGain?.gain.setTargetAtTime(0, now, 0.08);
      thunderQueue.length = 0;
      return;
    }
    thunderGain?.gain.setTargetAtTime(0.9, now, 0.1);
    const intensity = params.rain ? clamp(params.rainIntensity, 0, 1) : 0;
    const style = params.rainStyle || 'rain';
    const storm = style === 'thunderstorm' ? 1 : 0;
    const hurricane = style === 'hurricane' ? 1 : 0;
    const volume = clamp(params.rainVolume ?? 0.8, 0, 1);
    const drops = clamp(params.rainDrops ?? 1, 0, 2);
    const windLevel = clamp(params.rainWind ?? 1, 0, 2);
    const audible = intensity * volume;
    rainBus.gain.setTargetAtTime(audible * 0.85, now, 0.18);
    rainBed.gain.gain.setTargetAtTime((0.04 + intensity * 0.22) * (1.1 - hurricane * 0.25), now, 0.2);
    rainRoar.gain.gain.setTargetAtTime(intensity * intensity * (0.08 + storm * 0.08 + hurricane * 0.16), now, 0.25);
    const tick = (0.015 + (1 - intensity) * intensity * 0.12) * drops;
    if (tick > 0.02 && Math.random() < dt * (3 + intensity * 46) * drops) {
      const hit = 0.05 + Math.random() * 0.16 * (0.4 + intensity);
      rainTick.gain.gain.setValueAtTime(Math.max(hit, 0.0008), now);
      rainTick.gain.gain.exponentialRampToValueAtTime(0.0008, now + 0.045 + Math.random() * 0.03);
    } else {
      rainTick.gain.gain.setTargetAtTime(0.008 + intensity * 0.05 * drops, now, 0.08);
    }
    const gust = 0.75 + 0.25 * Math.sin(now * (0.35 + hurricane * 0.4));
    const windAmt = intensity * (0.04 + storm * 0.12 + hurricane * 0.55) * windLevel * gust;
    rainWind.gain.gain.setTargetAtTime(windAmt, now, 0.3);
    rainWind.tail.frequency.setTargetAtTime(140 + hurricane * 90 + gust * 40, now, 0.4);
    flushThunder(now, camera, params);
  }

  function strike(azimuth, distance) {
    if (!ctx || !enabled || !rainAudible) return;
    const delay = clamp(distance, 40, 2800) / 343;
    thunderQueue.push({ azimuth, distance: clamp(distance, 40, 2800), at: ctx.currentTime + delay });
  }

  function flushThunder(now, camera, params) {
    const snap = clamp(params.rainSnap ?? 0.9, 0, 2);
    const rumbleLevel = clamp(params.rainRumble ?? 0.9, 0, 2);
    if (snap <= 0.001 && rumbleLevel <= 0.001) {
      thunderQueue.length = 0;
      return;
    }
    for (let i = thunderQueue.length - 1; i >= 0; i--) {
      const bolt = thunderQueue[i];
      if (now + 0.03 < bolt.at) continue;
      thunderQueue.splice(i, 1);
      playThunder(now, bolt, camera.yaw, snap, rumbleLevel);
    }
  }

  // A real crack is a shock, not a click. The channel arrives as a few tearing
  // bursts, each falling from a bright edge down into a low body, and then the rumble.
  function playCrack(now, near, snap, output) {
    if (snap <= 0.001) return;
    const rips = 1 + Math.round(near * 5);
    let cursor = 0;
    for (let i = 0; i < rips; i++) {
      if (i > 0) cursor += 0.016 + Math.random() * 0.05;
      const when = now + cursor;
      const src = ctx.createBufferSource();
      src.buffer = crackBuffer;
      const offset = Math.random() * Math.max(0, crackBuffer.duration - 0.45);
      src.playbackRate.value = 0.82 + Math.random() * 0.46;
      const sweep = ctx.createBiquadFilter();
      sweep.type = 'lowpass';
      sweep.Q.value = i === 0 ? 0.65 : 0.85 + Math.random() * 0.35;
      const bright = i === 0 ? 1400 + near * 2400 : 420 + near * 1100;
      const startHz = bright * (0.78 + Math.random() * 0.35);
      const endHz = Math.max(48, 80 + near * 50 + Math.random() * 30);
      const sweepTime = (i === 0 ? 0.085 : 0.04 + Math.random() * 0.045) + (1 - near) * 0.05;
      sweep.frequency.setValueAtTime(startHz, when);
      sweep.frequency.exponentialRampToValueAtTime(endHz, when + sweepTime);
      const gain = ctx.createGain();
      const falloff = i === 0 ? 1 : 0.42 * Math.pow(0.78, i - 1);
      const amp = snap * (0.22 + near * 0.34) * falloff;
      const dur = sweepTime + 0.04 + (1 - near) * 0.07;
      gain.gain.setValueAtTime(Math.max(0.001, amp), when);
      gain.gain.exponentialRampToValueAtTime(0.001, when + dur);
      src.connect(sweep);
      sweep.connect(gain);
      gain.connect(output);
      src.start(when, offset);
      src.stop(when + dur + 0.04);
    }

    const body = ctx.createOscillator();
    body.type = 'sine';
    body.frequency.setValueAtTime(70 + near * 80, now);
    body.frequency.exponentialRampToValueAtTime(36, now + 0.16);
    const bodyGain = ctx.createGain();
    bodyGain.gain.setValueAtTime(Math.max(0.001, snap * (0.08 + near * 0.2)), now);
    bodyGain.gain.exponentialRampToValueAtTime(0.001, now + 0.18);
    body.connect(bodyGain);
    bodyGain.connect(output);
    body.start(now);
    body.stop(now + 0.22);
  }

  function playThunder(now, bolt, yaw, snap, rumbleLevel) {
    const near = 1 / (1 + bolt.distance / 700);
    const panNode = ctx.createStereoPanner();
    panNode.pan.value = clamp(Math.sin(bolt.azimuth - yaw) * 0.85, -1, 1);
    panNode.connect(thunderGain);

    const crackOut = ctx.createGain();
    const distance = ctx.createBiquadFilter();
    distance.type = 'lowpass';
    distance.frequency.value = 450 + near * 5000;
    distance.Q.value = 0.4;
    crackOut.connect(distance);
    distance.connect(panNode);
    playCrack(now, near, snap, crackOut);

    if (rumbleLevel <= 0.001) return;
    const rumble = ctx.createBufferSource();
    rumble.buffer = rumbleBuffer;
    rumble.loop = true;
    const rumbleGain = ctx.createGain();
    const rumbleFilter = ctx.createBiquadFilter();
    rumbleFilter.type = 'lowpass';
    rumbleFilter.frequency.value = 90 + near * 180;
    const rumbleAmp = Math.max(0.001, (0.2 + (1 - near) * 0.35 + near * 0.25) * rumbleLevel);
    rumbleGain.gain.setValueAtTime(0.001, now);
    rumbleGain.gain.exponentialRampToValueAtTime(rumbleAmp, now + 0.25 + (1 - near) * 0.45);
    rumbleGain.gain.exponentialRampToValueAtTime(0.001, now + 2.2 + (1 - near) * 3.2);
    rumble.connect(rumbleFilter);
    rumbleFilter.connect(rumbleGain);
    rumbleGain.connect(panNode);
    rumble.start(now);
    rumble.stop(now + 6);
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
    strike,
  };
}
