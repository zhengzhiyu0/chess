/** Bundled MP3s: native AVAudioPlayer on iOS, Web Audio on the web, plus haptics. */

import { configureHaptics, haptic } from './haptics';
import { isNative } from '../native';
import { SoundNative } from 'maia-native';

export type SoundKind = 'move' | 'capture' | 'check' | 'castle' | 'promote' | 'illegal' | 'start' | 'end' | 'lowtime';

/**
 * Recorded sound sets (public/sounds/<id>/): Lichess sets are AGPLv3+ by Enigmahack;
 * `board` is Kenney's CC0 wooden impacts for Move / Capture and borrows the rest from `sfx`.
 */
const SAMPLE_FILES = ['Move', 'Capture', 'Check', 'GenericNotify', 'Victory', 'Defeat', 'Draw', 'LowTime'] as const;
type SampleFile = (typeof SAMPLE_FILES)[number];

export const SAMPLE_THEMES = {
  board: '实木棋盘',
  wood: '轻柔木质',
  felt: '柔和落子',
  glass: '清脆玻璃',
  sfx: 'Lichess 音效',
  piano: 'Lichess 钢琴',
  nes: 'Lichess 8 位',
  futuristic: 'Lichess 未来',
} as const;
type SampleThemeId = keyof typeof SAMPLE_THEMES;

/** Files a theme takes from another set instead of shipping its own. */
const BOARD_NOTIFICATIONS: readonly SampleFile[] = ['Check', 'GenericNotify', 'Victory', 'Defeat', 'Draw', 'LowTime'];
const SAMPLE_BORROW: Partial<Record<SampleThemeId, { from: SampleThemeId; files: readonly SampleFile[] }>> = {
  board: { from: 'sfx', files: BOARD_NOTIFICATIONS },
  wood: { from: 'sfx', files: BOARD_NOTIFICATIONS },
  felt: { from: 'sfx', files: BOARD_NOTIFICATIONS },
  glass: { from: 'sfx', files: BOARD_NOTIFICATIONS },
};

const isSampleTheme = (id: string): id is SampleThemeId => Object.hasOwn(SAMPLE_THEMES, id);

/** How a game ended, from the player's point of view; picks Victory / Defeat / Draw. */
export type EndKind = 'win' | 'loss' | 'draw';

/** All selectable themes use finished recordings. */
export const SOUND_THEMES: Record<string, { label: string }> = Object.fromEntries(
  Object.entries(SAMPLE_THEMES).map(([id, label]) => [id, { label }]),
);

export const DEFAULT_SOUND_THEME: SampleThemeId = 'board';

const LEGACY_SOUND_THEMES: Record<string, SampleThemeId> = {
  plastic: 'glass', marble: 'glass', pop: 'felt', retro: 'nes',
};

/** Migrate removed synth themes, including settings imported from an old backup. */
export function soundThemeOf(id: unknown): SampleThemeId {
  if (typeof id !== 'string') return DEFAULT_SOUND_THEME;
  if (isSampleTheme(id)) return id;
  return Object.hasOwn(LEGACY_SOUND_THEMES, id) ? LEGACY_SOUND_THEMES[id] : DEFAULT_SOUND_THEME;
}

let ctx: AudioContext | null = null;
let out: AudioNode | null = null;
let pendingSounds: [SoundKind, EndKind | undefined, number][] = [];
let soundEpoch = 0;
let hasRun = false;
const activeSources = new Set<AudioScheduledSourceNode>();

function discardSounds() {
  pendingSounds = [];
  stopSounds();
  if (isNative) void SoundNative.stop().catch((err) => console.warn('停止原生音效失败', err));
}

function stopSounds() {
  soundEpoch++;
  for (const source of activeSources) {
    try { source.stop(); } catch { /* 已结束的音源无需再次停止。 */ }
  }
  activeSources.clear();
}

function trackSource<T extends AudioScheduledSourceNode>(source: T): T {
  activeSources.add(source);
  source.addEventListener('ended', () => activeSources.delete(source), { once: true });
  return source;
}

if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) discardSounds();
    else if (ctx && hasRun) unlockAudio();
  });
}
let lastMoveAt = -Infinity;
let enabled = true;
let themeId: string = DEFAULT_SOUND_THEME;

// Decoded samples per theme; a failed load falls back to the Lichess recording.
const samples = new Map<SampleThemeId, Record<SampleFile, Promise<AudioBuffer | undefined>>>();

function loadSamples(a: AudioContext, id: SampleThemeId) {
  let p = samples.get(id);
  if (!p) {
    // Each sound can play as soon as its own file is decoded.
    p = Object.fromEntries(
      SAMPLE_FILES.map((f) => [f, (async () => {
        try {
          const borrow = SAMPLE_BORROW[id];
          const dir = borrow?.files.includes(f) ? borrow.from : id;
          const res = await fetch(new URL(`sounds/${dir}/${f}.mp3`, document.baseURI).href);
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          return await a.decodeAudioData(await res.arrayBuffer());
        } catch (err) {
          console.warn(`音效 ${id}/${f} 加载失败`, err);
          return undefined;
        }
      })()]),
    ) as Record<SampleFile, Promise<AudioBuffer | undefined>>;
    samples.set(id, p);
  }
  return p;
}

export function configureSound(sound: boolean, haptics: boolean, theme: string = DEFAULT_SOUND_THEME) {
  if (!sound || themeId !== theme) discardSounds();
  enabled = sound;
  configureHaptics(haptics);
  themeId = soundThemeOf(theme);
  // decode ahead so the first move isn't silent; needs an AudioContext, which exists after the first tap
  if (ctx && isSampleTheme(themeId)) void loadSamples(ctx, themeId);
}

function audio(force = false): AudioContext | null {
  if (!enabled && !force) return null;
  try {
    if (ctx?.state === 'closed') {
      discardSounds();
      ctx = null;
    }
    if (!ctx) {
      const a = new AudioContext();
      ctx = a;
      hasRun = a.state === 'running';
      a.addEventListener('statechange', () => {
        if (a !== ctx) return;
        if (a.state === 'running') {
          hasRun = true;
          flushSounds(a);
        } else {
          // Stop old sources, but preserve fresh events waiting for resume().
          stopSounds();
        }
      });
      // 轻压缩，避免多个声音叠加时破音
      const comp = ctx.createDynamicsCompressor();
      comp.threshold.value = -10;
      comp.ratio.value = 4;
      comp.connect(ctx.destination);
      out = comp;
      if (isSampleTheme(themeId)) void loadSamples(ctx, themeId);
    }
    return ctx;
  } catch {
    return null;
  }
}

function flushSounds(a: AudioContext) {
  if (a !== ctx || a.state !== 'running' || document.hidden || !enabled) return;
  hasRun = true;
  const sounds = pendingSounds;
  pendingSounds = [];
  for (const [kind, end, at] of sounds) {
    if (performance.now() - at < 500) void render(a, kind, themeId, 0, end, at);
  }
}

/** iOS only allows audio after a user gesture; call from the first tap. */
export function unlockAudio() {
  if (isNative || document.hidden) return;
  const a = audio();
  if (!a) return;
  if (a.state === 'running') {
    flushSounds(a);
    return;
  }
  // A WebKit interruption can leave a resume promise pending indefinitely.
  // Allow the next gesture to retry instead of locking recovery behind it.
  void a.resume().then(() => flushSounds(a), () => {});
  const s = a.createBufferSource();
  s.buffer = a.createBuffer(1, 1, 22050);
  s.connect(a.destination);
  s.start();
}

/** Which recorded file plays for each event; promote/castle reuse Move like Lichess does. */
function sampleFor(kind: SoundKind, end?: EndKind): SampleFile {
  switch (kind) {
    case 'move':
    case 'castle':
    case 'promote':
      return 'Move';
    case 'capture':
      return 'Capture';
    case 'check':
      return 'Check';
    case 'start':
      return 'GenericNotify';
    case 'end':
      return end === 'win' ? 'Victory' : end === 'loss' ? 'Defeat' : 'Draw';
    case 'lowtime':
      return 'LowTime';
    case 'illegal':
      return 'LowTime';
  }
}

function playNative(kind: SoundKind, id: string, end?: EndKind, preview = false) {
  const theme = soundThemeOf(id);
  const clips = preview
    ? [{ theme, file: 'Move', delay: 0 }, { theme, file: 'Capture', delay: 0.45 }]
    : [{ theme, file: sampleFor(kind, end), delay: 0 }];
  void SoundNative.play({ clips }).catch((err) => console.warn('原生音效播放失败', err));
}

async function render(a: AudioContext, kind: SoundKind, id: string, delay = 0, end?: EndKind, requestedAt = performance.now()) {
  const theme = soundThemeOf(id);
  const file = sampleFor(kind, end);
  const epoch = soundEpoch;
  const buf = await loadSamples(a, theme)[file]
    ?? (theme !== 'sfx' ? await loadSamples(a, 'sfx')[file] : undefined);
  if (epoch !== soundEpoch || document.hidden || a.state !== 'running' || performance.now() - requestedAt >= 500) return;
  if (!buf) return;
  const src = trackSource(a.createBufferSource());
  src.buffer = buf;
  src.connect(out!);
  src.start(a.currentTime + 0.005 + delay);
}

export function play(kind: SoundKind, end?: EndKind) {
  if (document.hidden) return;
  haptic(kind);
  if (!enabled) return;
  const now = performance.now();
  if (kind === 'move' || kind === 'capture' || kind === 'castle' || kind === 'check' || kind === 'promote') {
    if (now - lastMoveAt < 70) return;
    lastMoveAt = now;
  }
  if (isNative) {
    playNative(kind, themeId, end);
    return;
  }
  const a = audio();
  if (!a) return;
  if (a.state === 'running') {
    void render(a, kind, themeId, 0, end);
    return;
  }
  pendingSounds.push([kind, end, now]);
  if (pendingSounds.length > 4) pendingSounds.shift();
  // Recover foreground interruptions even for the opponent's move (no user gesture).
  if (hasRun) unlockAudio();
}

/** Plays a short sample (move, then capture) of a theme, even when sound is switched off. */
export function previewTheme(id: string) {
  if (document.hidden) return;
  if (isNative) {
    playNative('move', id, undefined, true);
    return;
  }
  const a = audio(true);
  if (!a || document.hidden) return;
  const epoch = soundEpoch;
  const preview = () => {
    if (epoch !== soundEpoch || document.hidden || a.state !== 'running') return;
    void render(a, 'move', id);
    void render(a, 'capture', id, 0.45);
  };
  if (a.state === 'running') preview();
  else void a.resume().then(preview, () => {});
}

/** Picks the sound for a move from its SAN. */
export function soundForSan(san: string): SoundKind {
  if (san.includes('+') || san.includes('#')) return 'check';
  if (san.includes('=')) return 'promote';
  if (san.startsWith('O-O')) return 'castle';
  if (san.includes('x')) return 'capture';
  return 'move';
}
