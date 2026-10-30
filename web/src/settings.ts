import { isNative } from './native';
import { safeSet } from './storage';
import { BOARD_THEMES, PIECE_SETS } from './app/appearance';
import { SOUND_THEMES, soundThemeOf } from './audio/sound';
import { TIME_CONTROLS } from './game/clock';

export type Color = 'w' | 'b';

export interface Settings {
  /** app chrome colour scheme */
  theme: 'dark' | 'light';
  model: '5m' | '23m' | '79m';
  /** Maia rating for the next game, independent of the player's estimate. */
  elo: number;
  playerElo: number;
  /** Player rating uncertainty; lower values mean a more stable estimate. */
  ratingDeviation: number;
  /** Consecutive wins (positive) or losses (negative). */
  ratingStreak: number;
  /** Number of games rated so far, retained when migrating older settings. */
  ratedGames: number;
  color: Color | 'random';
  temperature: number;
  /** Opt-in, device-local capture of committed Maia sampling decisions. */
  samplingCapture: boolean;
  /** Legacy backup field; real game history is disabled (official UCI default). */
  useHistory: boolean;
  backend: 'wasm' | 'webgpu';
  thinkDelay: boolean;
  sfMovetime: number;
  sfThreads: number;
  sfHash: number;
  /** Stockfish lite build (small NNUE, ~2MB): loads in a second and uses far less memory */
  sfLite: boolean;
  /** stop searches once a sufficient depth is reached instead of always using the full time */
  ecoAnalysis: boolean;
  lowMemory: boolean;
  /** Legacy backup field; startup now always loads the selected engines. */
  warmup: boolean;
  /** on startup, download app + Stockfish + selected Maia model into the offline cache */
  autoOffline: boolean;
  /** show the estimated winning percentage during play */
  aidWinPct: boolean;
  /** show the engine evaluation during play */
  aidEval: boolean;
  /** arrow for what the opponent threatens if you ignore it */
  aidThreats: boolean;
  /** circle your attacked, under-defended pieces */
  aidHanging: boolean;
  /** always show the engine's best move on your turn */
  aidBest: boolean;
  /** time control id, see TIME_CONTROLS ('none' = untimed) */
  timeControl: string;
  sound: boolean;
  /** move sound style, see SOUND_THEMES */
  soundTheme: string;
  haptics: boolean;
  /** board colour preset id (see BOARD_THEMES) or 'custom' */
  boardTheme: string;
  customLight: string;
  customDark: string;
  /** piece set id, see PIECE_SETS */
  pieceSet: string;
  /** queue a move while the opponent is thinking */
  premove: boolean;
  /** board animations: badge pop-in, capture particles, check pulse, mate confetti */
  boardFx: boolean;
  /** individual board effects; kept separate so motion can be reduced without disabling the board */
  boardFxBadge: boolean;
  boardFxCapture: boolean;
  boardFxCheck: boolean;
  boardFxMate: boolean;
  /** board size in % of the largest size that fits (play / review layouts) */
  boardSizePlay: number;
  boardSizeReview: number;
  /** review: also judge the opponent's moves (default: only mine) */
  reviewOpponent: boolean;
  /** my avatar, see app/avatar.ts ('' = default) */
  avatar: string;
  /** Active coach portrait. The app currently uses Lia (index 0); other portraits remain bundled for future use. */
  coachAvatar: number;
  /** Key-event bubbles for the selected coach. */
  opponentTalk: boolean;
  /** iOS app: 2 once engine settings were migrated to the native-engine defaults */
  engineGen?: number;
  /** sound theme default migration: 1 = Lichess sfx, 2 = wooden board set */
  soundGen?: number;
  /** coach selection default migration */
  coachGen?: number;
}

const KEY = 'maia-coach.settings';

export const isIOS =
  /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

export function defaultSettings(): Settings {
  // the iOS app runs native engines with real threads and no WebView memory cap
  const cores = navigator.hardwareConcurrency || 2;
  const motion = !matchMedia('(prefers-reduced-motion: reduce)').matches;
  return {
    theme: 'dark',
    model: isNative ? '23m' : isIOS ? '5m' : '23m',
    elo: 1500,
    playerElo: 1500,
    ratingDeviation: 350,
    ratingStreak: 0,
    ratedGames: 0,
    color: 'w',
    temperature: 1,
    samplingCapture: false,
    useHistory: false,
    backend: 'wasm',
    thinkDelay: true,
    sfMovetime: 1000,
    // iPhones have 2 performance cores; spilling the search onto the efficiency cores mostly adds heat
    sfThreads: isNative ? 2 : Math.max(1, Math.min(4, cores - 1)),
    sfHash: isNative ? 128 : isIOS ? 32 : 128,
    sfLite: isNative ? false : isIOS,
    ecoAnalysis: true,
    lowMemory: isIOS && !isNative,
    warmup: true,
    autoOffline: true,
    aidWinPct: false,
    aidEval: false,
    aidThreats: false,
    aidHanging: false,
    aidBest: false,
    timeControl: 'none',
    sound: true,
    soundTheme: 'board',
    haptics: true,
    boardTheme: 'green',
    customLight: '#ebecd0',
    customDark: '#739552',
    pieceSet: 'cburnett',
    premove: true,
    boardFx: motion,
    boardFxBadge: motion,
    boardFxCapture: motion,
    boardFxCheck: motion,
    boardFxMate: motion,
    boardSizePlay: 100,
    boardSizeReview: 100,
    reviewOpponent: false,
    avatar: '',
    coachAvatar: 0,
    opponentTalk: false,
  };
}

export function loadSettings(): Settings {
  try {
    // AI coach was removed; discard any API key left by older builds.
    localStorage.removeItem('maia-coach.ai-key');
    const saved = JSON.parse(localStorage.getItem(KEY) || '{}');
    // gen 1 moved the old synthesized default to Lichess sfx; gen 2 moves default users to the wooden board set
    if ((saved.soundGen ?? 0) < 2) {
      if (saved.soundTheme === undefined || saved.soundTheme === 'wood' || saved.soundTheme === 'sfx') saved.soundTheme = 'board';
      saved.soundGen = 2;
    }
    // settings from the WebView-engine app builds (single thread, tiny hash) would cripple the native engines
    if (isNative && (saved.engineGen ?? 0) < 2) {
      const d = defaultSettings();
      Object.assign(saved, { sfThreads: d.sfThreads, sfHash: d.sfHash, lowMemory: d.lowMemory, warmup: d.warmup, engineGen: 2 });
    }
    // gen 2 defaulted to cores-1 threads (5 on most iPhones), which ran hot; cap it at the performance cores
    if (isNative && saved.engineGen === 2) {
      if (typeof saved.sfThreads === 'number' && saved.sfThreads > 2) saved.sfThreads = 2;
      saved.engineGen = 3;
    }
    // Before coach selection existed, index 0 was silently used. Treat that legacy default as random.
    if (saved.coachGen === undefined) {
      if (saved.coachAvatar === undefined || saved.coachAvatar === 0) saved.coachAvatar = -1;
      saved.coachGen = 1;
    }
    // Lia is the first character with the new recording pack. Keep explicit other portraits.
    if ((saved.coachGen ?? 0) < 2) {
      if (saved.coachAvatar === -1 || saved.coachAvatar === undefined) saved.coachAvatar = 0;
      saved.coachGen = 2;
    }
    return sanitizeSettings(saved);
  } catch {
    return defaultSettings();
  }
}

export const ELO_MIN = 0;
export const ELO_MAX = 2600;

/** Fixed Maia opponent presets within the supported product range. */
export const MAIA_LEVELS = [600, 800, 1000, 1200, 1400, 1500, 1600, 1800, 2000, 2200, 2400, 2600] as const;

type Rule = { oneOf: readonly unknown[] } | { num: [number, number]; int?: boolean } | { bool: true } | { str: RegExp } | { optInt: true };

const HEX = /^#[0-9a-f]{6}$/i;
const RULES: Record<keyof Settings, Rule> = {
  theme: { oneOf: ['dark', 'light'] },
  model: { oneOf: ['5m', '23m', '79m'] },
  elo: { num: [ELO_MIN, ELO_MAX], int: true },
  playerElo: { num: [ELO_MIN, ELO_MAX], int: true },
  ratingDeviation: { num: [60, 350] },
  ratingStreak: { num: [-8, 8], int: true },
  ratedGames: { num: [0, 1e9], int: true },
  color: { oneOf: ['w', 'b', 'random'] },
  temperature: { num: [0, 1.5] },
  samplingCapture: { bool: true },
  useHistory: { oneOf: [false] },
  backend: { oneOf: ['wasm', 'webgpu'] },
  thinkDelay: { bool: true },
  sfMovetime: { num: [100, 20000], int: true },
  sfThreads: { num: [1, 16], int: true },
  sfHash: { num: [16, 1024], int: true },
  sfLite: { bool: true },
  ecoAnalysis: { bool: true },
  lowMemory: { bool: true },
  warmup: { bool: true },
  autoOffline: { bool: true },
  aidWinPct: { bool: true },
  aidEval: { bool: true },
  aidThreats: { bool: true },
  aidHanging: { bool: true },
  aidBest: { bool: true },
  timeControl: { oneOf: TIME_CONTROLS.map((t) => t.id) },
  sound: { bool: true },
  soundTheme: { oneOf: Object.keys(SOUND_THEMES) },
  haptics: { bool: true },
  boardTheme: { oneOf: [...Object.keys(BOARD_THEMES), 'custom'] },
  customLight: { str: HEX },
  customDark: { str: HEX },
  pieceSet: { oneOf: Object.keys(PIECE_SETS) },
  premove: { bool: true },
  boardFx: { bool: true },
  boardFxBadge: { bool: true },
  boardFxCapture: { bool: true },
  boardFxCheck: { bool: true },
  boardFxMate: { bool: true },
  boardSizePlay: { num: [60, 100] },
  boardSizeReview: { num: [60, 100] },
  reviewOpponent: { bool: true },
  // '' / '<glyph>|#rrggbb' / small JPEG data URL; rendering validates the format again
  avatar: { str: /^[^<>"]{0,200000}$/s },
  coachAvatar: { num: [-1, 999], int: true },
  opponentTalk: { bool: true },
  engineGen: { optInt: true },
  soundGen: { optInt: true },
  coachGen: { optInt: true },
};

function valid(r: Rule, v: unknown): boolean {
  if ('oneOf' in r) return r.oneOf.includes(v);
  if ('bool' in r) return typeof v === 'boolean';
  if ('str' in r) return typeof v === 'string' && r.str.test(v);
  if ('optInt' in r) return Number.isInteger(v);
  return typeof v === 'number' && Number.isFinite(v) && v >= r.num[0] && v <= r.num[1] && (!r.int || Number.isInteger(v));
}

/**
 * Keeps only well-formed fields of `raw` (corrupted storage or an imported backup), everything else
 * falls back to the default, so a bad value can never break rendering.
 */
export function sanitizeSettings(raw: unknown): Settings {
  const out = defaultSettings() as unknown as Record<string, unknown>;
  if (!raw || typeof raw !== 'object') return out as unknown as Settings;
  const src = raw as Record<string, unknown>;
  for (const k of Object.keys(RULES) as (keyof Settings)[]) {
    const legacyElo = k === 'elo' && src.elo === undefined && Object.hasOwn(src, 'maiaElo');
    if (!Object.hasOwn(src, k) && !legacyElo) continue;
    const value = k === 'soundTheme' ? soundThemeOf(src[k]) : legacyElo ? src.maiaElo : src[k];
    if (valid(RULES[k], value)) out[k] = value;
  }
  // Keep migration here so local storage and imported backups share the same rules.
  if (src.gameType === 'coach') {
    for (const [current, legacy] of [
      ['aidEval', 'coachEval'], ['aidThreats', 'coachThreats'],
      ['aidHanging', 'coachHanging'], ['aidBest', 'coachBest'],
    ] as const) {
      if (!Object.hasOwn(src, current) && typeof src[legacy] === 'boolean') out[current] = src[legacy];
    }
  }
  if (src.playerElo === undefined) out.playerElo = out.elo;
  // Only the next-game setting is snapped; persisted games keep their original opponent.
  out.elo = MAIA_LEVELS.reduce<number>((nearest, level) => Math.abs(level - (out.elo as number)) < Math.abs(nearest - (out.elo as number)) ? level : nearest, MAIA_LEVELS[0]);
  if (src.ratingDeviation === undefined) {
    const games = out.ratedGames as number;
    out.ratingDeviation = games === 0 ? 350 : games < 5 ? 250 : games < 15 ? 150 : 80;
  }
  // Lia is the only active coach; keep the other portrait definitions for future use.
  out.coachAvatar = 0;
  return out as unknown as Settings;
}

export function saveSettings(s: Settings) {
  safeSet(KEY, JSON.stringify(s));
}
