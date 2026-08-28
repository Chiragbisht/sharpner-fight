// Synthesised, not sampled. A convincing plastic clack is a filtered noise
// burst plus a short pitched body, which is a few lines of WebAudio and zero
// bytes of download — and it lets the strike scale continuously with how hard
// the two sharpeners actually met.

const STORE_KEY = 'sf.sound';

let ctx: AudioContext | null = null;
let master: GainNode | null = null;
let noise: AudioBuffer | null = null;
let enabled = true;

try {
  enabled = localStorage.getItem(STORE_KEY) !== 'off';
} catch {
  // Private browsing refuses storage; default to sound on.
}

function audio(): AudioContext | null {
  if (ctx) return ctx;
  const Ctor = window.AudioContext ?? window.webkitAudioContext;
  if (!Ctor) return null;
  ctx = new Ctor();
  master = ctx.createGain();
  master.gain.value = 0.9;
  master.connect(ctx.destination);

  // One second of white noise, reused for every impact.
  noise = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
  const data = noise.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  return ctx;
}

/**
 * Browsers refuse to start audio without a gesture, so this is called from the
 * first pointerdown. Safe to call repeatedly.
 */
export function unlock(): void {
  const c = audio();
  if (c && c.state === 'suspended') void c.resume();
}

export function isEnabled(): boolean {
  return enabled;
}

export function setEnabled(on: boolean): void {
  enabled = on;
  try {
    localStorage.setItem(STORE_KEY, on ? 'on' : 'off');
  } catch {
    // ignore
  }
  if (on) unlock();
}

interface BurstOptions {
  freq: number;
  q: number;
  gain: number;
  dur: number;
  type?: BiquadFilterType;
}

function burst({ freq, q, gain, dur, type = 'bandpass' }: BurstOptions): void {
  const c = audio();
  if (!c || !master || !noise) return;
  const t = c.currentTime;

  const src = c.createBufferSource();
  src.buffer = noise;
  src.playbackRate.value = 0.8 + Math.random() * 0.4;

  const filter = c.createBiquadFilter();
  filter.type = type;
  filter.frequency.value = freq;
  filter.Q.value = q;

  const g = c.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(gain, t + 0.004);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);

  src.connect(filter).connect(g).connect(master);
  src.start(t, Math.random() * 0.5);
  src.stop(t + dur);
}

interface BodyOptions {
  from: number;
  to: number;
  gain: number;
  dur: number;
  type?: OscillatorType;
}

function body({ from, to, gain, dur, type = 'triangle' }: BodyOptions): void {
  const c = audio();
  if (!c || !master) return;
  const t = c.currentTime;

  const osc = c.createOscillator();
  osc.type = type;
  osc.frequency.setValueAtTime(from, t);
  osc.frequency.exponentialRampToValueAtTime(to, t + dur);

  const g = c.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(gain, t + 0.005);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);

  osc.connect(g).connect(master);
  osc.start(t);
  osc.stop(t + dur);
}

/** Two sharpeners meeting. `strength` is 0..1. */
export function clack(strength: number): void {
  if (!enabled) return;
  const s = Math.max(0.12, Math.min(1, strength));
  burst({ freq: 1500 + s * 2200, q: 1.4, gain: 0.05 + s * 0.34, dur: 0.055 + s * 0.03 });
  body({ from: 240 + s * 200, to: 90, gain: 0.03 + s * 0.16, dur: 0.075 });
}

/** The flick itself — a small tick as it leaves your finger. */
export function flick(strength: number): void {
  if (!enabled) return;
  const s = Math.max(0.1, Math.min(1, strength));
  burst({ freq: 2600 + s * 1400, q: 0.9, gain: 0.02 + s * 0.08, dur: 0.035 });
}

/** Going over the edge: a scrape, then a clatter on the floor below. */
export function fall(): void {
  if (!enabled) return;
  const c = audio();
  if (!c) return;
  burst({ freq: 900, q: 0.7, gain: 0.14, dur: 0.13 });
  body({ from: 150, to: 55, gain: 0.14, dur: 0.22, type: 'sine' });
  setTimeout(() => {
    if (!enabled) return;
    burst({ freq: 1100, q: 1.2, gain: 0.12, dur: 0.07 });
    body({ from: 190, to: 70, gain: 0.09, dur: 0.09 });
  }, 150);
}

/** Round won / lost — a short two-note figure rather than a jingle. */
export function chime(win: boolean): void {
  if (!enabled) return;
  const notes = win ? [523, 784] : [392, 262];
  notes.forEach((f, i) =>
    setTimeout(() => body({ from: f, to: f, gain: 0.1, dur: 0.22, type: 'sine' }), i * 110)
  );
}
