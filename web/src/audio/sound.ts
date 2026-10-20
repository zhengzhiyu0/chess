/** Synthesized move sounds (Web Audio, no asset files) plus haptic feedback where supported. */

export type SoundKind = 'move' | 'capture' | 'check' | 'castle' | 'promote' | 'illegal' | 'start' | 'end' | 'lowtime';

let ctx: AudioContext | null = null;
let enabled = true;
let hapticsOn = true;

export function configureSound(sound: boolean, haptics: boolean) {
  enabled = sound;
  hapticsOn = haptics;
}

function audio(): AudioContext | null {
  if (!enabled) return null;
  try {
    ctx ??= new AudioContext();
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

/** Short percussive "wood" knock: filtered noise burst + a damped tone. */
function knock(a: AudioContext, at: number, freq: number, gain: number, len = 0.09) {
  const noise = a.createBuffer(1, Math.ceil(a.sampleRate * len), a.sampleRate);
  const d = noise.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / d.length, 4);
  const src = a.createBufferSource();
  src.buffer = noise;
  const bp = a.createBiquadFilter();
  bp.type = 'bandpass';
  bp.frequency.value = freq * 2.2;
  bp.Q.value = 1.4;
  const g = a.createGain();
  g.gain.value = gain;
  src.connect(bp).connect(g).connect(a.destination);
  src.start(at);

  const osc = a.createOscillator();
  osc.type = 'sine';
  osc.frequency.setValueAtTime(freq, at);
  osc.frequency.exponentialRampToValueAtTime(freq * 0.6, at + len);
  const og = a.createGain();
  og.gain.setValueAtTime(gain * 0.6, at);
  og.gain.exponentialRampToValueAtTime(0.0001, at + len);
  osc.connect(og).connect(a.destination);
  osc.start(at);
  osc.stop(at + len + 0.02);
}

function tone(a: AudioContext, at: number, freq: number, len: number, gain = 0.15, type: OscillatorType = 'triangle') {
  const osc = a.createOscillator();
  osc.type = type;
  osc.frequency.value = freq;
  const g = a.createGain();
  g.gain.setValueAtTime(0.0001, at);
  g.gain.exponentialRampToValueAtTime(gain, at + 0.015);
  g.gain.exponentialRampToValueAtTime(0.0001, at + len);
  osc.connect(g).connect(a.destination);
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

export function play(kind: SoundKind) {
  if (hapticsOn && VIBRATE[kind] !== undefined) navigator.vibrate?.(VIBRATE[kind]!);
  const a = audio();
  if (!a) return;
  const t = a.currentTime + 0.005;
  switch (kind) {
    case 'move':
      knock(a, t, 420, 0.55);
      break;
    case 'capture':
      knock(a, t, 300, 0.7, 0.12);
      knock(a, t + 0.035, 520, 0.35);
      break;
    case 'castle':
      knock(a, t, 420, 0.5);
      knock(a, t + 0.09, 380, 0.5);
      break;
    case 'check':
      knock(a, t, 420, 0.5);
      tone(a, t + 0.02, 880, 0.16, 0.08, 'square');
      break;
    case 'promote':
      knock(a, t, 420, 0.5);
      tone(a, t + 0.03, 660, 0.12);
      tone(a, t + 0.11, 990, 0.16);
      break;
    case 'illegal':
      tone(a, t, 180, 0.12, 0.12, 'sawtooth');
      break;
    case 'start':
      tone(a, t, 523, 0.12);
      tone(a, t + 0.1, 784, 0.18);
      break;
    case 'end':
      tone(a, t, 784, 0.16);
      tone(a, t + 0.13, 659, 0.16);
      tone(a, t + 0.26, 523, 0.3);
      break;
    case 'lowtime':
      tone(a, t, 1200, 0.06, 0.07, 'square');
      break;
  }
}

/** Picks the sound for a move from its SAN. */
export function soundForSan(san: string): SoundKind {
  if (san.includes('+') || san.includes('#')) return 'check';
  if (san.includes('=')) return 'promote';
  if (san.startsWith('O-O')) return 'castle';
  if (san.includes('x')) return 'capture';
  return 'move';
}
