/** Synthesized move sounds (Web Audio, no asset files) plus haptic feedback where supported. */

export type SoundKind = 'move' | 'capture' | 'check' | 'castle' | 'promote' | 'illegal' | 'start' | 'end' | 'lowtime';

/** 一次落子撞击：低频"砰" + 滤波噪声"咔" + 若干衰减的共振泛音 */
interface Hit {
  /** body thump: start freq, end freq, oscillator type, gain, decay seconds */
  body?: { f: number; f2: number; type: OscillatorType; gain: number; decay: number };
  /** noise click: filter type, centre freq, Q, gain, length seconds */
  noise?: { type: BiquadFilterType; f: number; q: number; gain: number; len: number };
  /** resonant partials: [freq, gain, decay] */
  modes?: [number, number, number][];
}

interface Theme {
  label: string;
  hit: Hit;
  /** oscillator for check / promote / start / end jingles */
  bell: OscillatorType;
}

export const SOUND_THEMES = {
  wood: {
    label: '经典木质',
    hit: {
      body: { f: 190, f2: 120, type: 'sine', gain: 0.5, decay: 0.06 },
      noise: { type: 'bandpass', f: 1900, q: 0.9, gain: 0.75, len: 0.05 },
      modes: [
        [1150, 0.22, 0.045],
        [2650, 0.1, 0.03],
      ],
    },
    bell: 'triangle',
  },
  felt: {
    label: '柔和绒布',
    hit: {
      body: { f: 130, f2: 80, type: 'sine', gain: 0.7, decay: 0.08 },
      noise: { type: 'lowpass', f: 800, q: 0.7, gain: 0.6, len: 0.06 },
    },
    bell: 'sine',
  },
  plastic: {
    label: '清脆塑料',
    hit: {
      body: { f: 320, f2: 240, type: 'sine', gain: 0.22, decay: 0.025 },
      noise: { type: 'bandpass', f: 4200, q: 1.6, gain: 0.7, len: 0.025 },
      modes: [[3300, 0.14, 0.018]],
    },
    bell: 'sine',
  },
  marble: {
    label: '石质棋子',
    hit: {
      body: { f: 240, f2: 180, type: 'sine', gain: 0.35, decay: 0.04 },
      noise: { type: 'bandpass', f: 3000, q: 2, gain: 0.45, len: 0.03 },
      modes: [
        [2100, 0.2, 0.14],
        [3350, 0.1, 0.1],
        [4750, 0.08, 0.08],
      ],
    },
    bell: 'sine',
  },
  pop: {
    label: '气泡',
    hit: {
      body: { f: 950, f2: 380, type: 'sine', gain: 0.4, decay: 0.08 },
      noise: { type: 'highpass', f: 3000, q: 0.7, gain: 0.08, len: 0.01 },
    },
    bell: 'sine',
  },
  retro: {
    label: '复古 8 位',
    hit: {
      body: { f: 520, f2: 520, type: 'square', gain: 0.12, decay: 0.05 },
    },
    bell: 'square',
  },
} satisfies Record<string, Theme>;

export type SoundTheme = keyof typeof SOUND_THEMES;

let ctx: AudioContext | null = null;
let out: AudioNode | null = null;
let noiseBuf: AudioBuffer | null = null;
let enabled = true;
let hapticsOn = true;
let theme: Theme = SOUND_THEMES.wood;

export function configureSound(sound: boolean, haptics: boolean, themeId: string = 'wood') {
  enabled = sound;
  hapticsOn = haptics;
  theme = SOUND_THEMES[themeId as SoundTheme] ?? SOUND_THEMES.wood;
}

function audio(force = false): AudioContext | null {
  if (!enabled && !force) return null;
  try {
    if (!ctx) {
      ctx = new AudioContext();
      // 轻压缩，避免多个声音叠加时破音
      const comp = ctx.createDynamicsCompressor();
      comp.threshold.value = -10;
      comp.ratio.value = 4;
      comp.connect(ctx.destination);
      out = comp;
      noiseBuf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
      const d = noiseBuf.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    }
    if (ctx.state === 'suspended') void ctx.resume();
    return ctx;
  } catch {
    return null;
  }
}

/** iOS only allows audio after a user gesture; call from the first tap. */
export function unlockAudio() {
  const a = audio();
  if (!a) return;
  const s = a.createBufferSource();
  s.buffer = a.createBuffer(1, 1, 22050);
  s.connect(a.destination);
  s.start();
}

function env(a: AudioContext, at: number, peak: number, decay: number): GainNode {
  const g = a.createGain();
  g.gain.setValueAtTime(0.0001, at);
  g.gain.exponentialRampToValueAtTime(Math.max(peak, 0.0002), at + 0.002);
  g.gain.exponentialRampToValueAtTime(0.0001, at + 0.002 + decay);
  return g;
}

/** Plays one impact; `force` scales loudness, `pitch` shifts all frequencies. */
function hit(a: AudioContext, at: number, h: Hit, force = 1, pitch = 1) {
  const dest = out!;
  if (h.body) {
    const b = h.body;
    const osc = a.createOscillator();
    osc.type = b.type;
    osc.frequency.setValueAtTime(b.f * pitch, at);
    if (b.f2 !== b.f) osc.frequency.exponentialRampToValueAtTime(b.f2 * pitch, at + b.decay);
    osc.connect(env(a, at, b.gain * force, b.decay)).connect(dest);
    osc.start(at);
    osc.stop(at + b.decay + 0.03);
  }
  if (h.noise && noiseBuf) {
    const n = h.noise;
    const src = a.createBufferSource();
    src.buffer = noiseBuf;
    const f = a.createBiquadFilter();
    f.type = n.type;
    f.frequency.value = n.f * pitch;
    f.Q.value = n.q;
    src.connect(f).connect(env(a, at, n.gain * force, n.len)).connect(dest);
    src.start(at, Math.random() * 0.5);
    src.stop(at + n.len + 0.03);
  }
  for (const [freq, gain, decay] of h.modes ?? []) {
    const osc = a.createOscillator();
    osc.type = 'sine';
    osc.frequency.value = freq * pitch;
    osc.connect(env(a, at, gain * force, decay)).connect(dest);
    osc.start(at);
    osc.stop(at + decay + 0.03);
  }
}

function beep(a: AudioContext, at: number, freq: number, len: number, gain = 0.15, type: OscillatorType = 'sine') {
  const osc = a.createOscillator();
  osc.type = type;
  osc.frequency.value = freq;
  const g = a.createGain();
  // square/sawtooth 听感更响，降低一些
  const k = type === 'square' || type === 'sawtooth' ? 0.5 : 1;
  g.gain.setValueAtTime(0.0001, at);
  g.gain.exponentialRampToValueAtTime(gain * k, at + 0.015);
  g.gain.exponentialRampToValueAtTime(0.0001, at + len);
  osc.connect(g).connect(out!);
  osc.start(at);
  osc.stop(at + len + 0.02);
}

const VIBRATE: Partial<Record<SoundKind, number | number[]>> = {
  capture: 18,
  check: [20, 40, 20],
  illegal: [10, 30, 10],
  end: [30, 60, 30],
  lowtime: 12,
};

function render(a: AudioContext, kind: SoundKind, th: Theme = theme, delay = 0) {
  const t = a.currentTime + 0.005 + delay;
  const h = th.hit;
  const tone = (_: AudioContext, at: number, freq: number, len: number, gain?: number, type: OscillatorType = th.bell) =>
    beep(a, at, freq, len, gain, type);
  switch (kind) {
    case 'move':
      hit(a, t, h);
      break;
    case 'capture':
      hit(a, t, h, 1.3, 0.85);
      hit(a, t + 0.04, h, 0.6, 1.2);
      break;
    case 'castle':
      hit(a, t, h, 0.9);
      hit(a, t + 0.11, h, 0.9, 0.92);
      break;
    case 'check':
      hit(a, t, h);
      tone(a, t + 0.03, 880, 0.18, 0.09);
      tone(a, t + 0.03, 1320, 0.14, 0.04);
      break;
    case 'promote':
      hit(a, t, h);
      tone(a, t + 0.04, 660, 0.12);
      tone(a, t + 0.12, 990, 0.18);
      break;
    case 'illegal':
      tone(a, t, 180, 0.12, 0.12, 'sawtooth');
      break;
    case 'start':
      tone(a, t, 523, 0.12);
      tone(a, t + 0.1, 784, 0.2);
      break;
    case 'end':
      tone(a, t, 784, 0.16);
      tone(a, t + 0.13, 659, 0.16);
      tone(a, t + 0.26, 523, 0.32);
      break;
    case 'lowtime':
      tone(a, t, 1200, 0.06, 0.07, 'square');
      break;
  }
}

export function play(kind: SoundKind) {
  if (hapticsOn && VIBRATE[kind] !== undefined) navigator.vibrate?.(VIBRATE[kind]!);
  const a = audio();
  if (a) render(a, kind);
}

/** Plays a short sample (move, then capture) of a theme, even when sound is switched off. */
export function previewTheme(themeId: string) {
  const a = audio(true);
  if (!a) return;
  const th = SOUND_THEMES[themeId as SoundTheme] ?? SOUND_THEMES.wood;
  render(a, 'move', th);
  render(a, 'capture', th, 0.35);
}

/** Picks the sound for a move from its SAN. */
export function soundForSan(san: string): SoundKind {
  if (san.includes('+') || san.includes('#')) return 'check';
  if (san.includes('=')) return 'promote';
  if (san.startsWith('O-O')) return 'castle';
  if (san.includes('x')) return 'capture';
  return 'move';
}
