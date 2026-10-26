import { isNative } from './native';
import { safeSet } from './storage';
import { BOARD_THEMES, PIECE_SETS } from './app/appearance';
import { SOUND_THEMES } from './audio/sound';
import { TIME_CONTROLS } from './game/clock';

export type Color = 'w' | 'b';

export interface Settings {
  /** app chrome colour scheme */
  theme: 'dark' | 'light';
  model: '5m' | '23m' | '79m';
  elo: number;
  /** adjust `elo` after each finished game according to the result */
  autoElo: boolean;
  /** number of games rated so far (larger early adjustments) */
  ratedGames: number;
  color: Color | 'random';
  temperature: number;
  /** feed real game history to Maia (official UCI default is off: current position repeated) */
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
  /** home page choice: free play or coached game */
  gameType: 'normal' | 'coach';
  /** pause and explain moves at or worse than this level */
  coachLevel: 'inaccuracy' | 'mistake' | 'blunder';
  /** arrow for what the opponent threatens if you ignore it */
  coachThreats: boolean;
  /** circle your attacked, under-defended pieces */
  coachHanging: boolean;
  /** always show the engine's best move on your turn */
  coachBest: boolean;
  coachEval: boolean;
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
  /** threat/protection animation: a growing arrow or a square-by-square colour wash */
  boardFxArrowStyle: 'line' | 'fill';
  /** board size in % of the largest size that fits (play / review layouts) */
  boardSizePlay: number;
  boardSizeReview: number;
  /** review autoplay delay per move in ms */
  autoplayMs: number;
  /** review: also judge the opponent's moves (default: only mine) */
  reviewOpponent: boolean;
  /** my avatar, see app/avatar.ts ('' = default) */
  avatar: string;
  /** Maia's coach portrait, index into COACHES (app/coach-avatars.ts) */
  coachAvatar: number;
  /** instant local taunts in normal games only */
  opponentTalk: boolean;
  /** iOS app: 2 once engine settings were migrated to the native-engine defaults */
  engineGen?: number;
  /** sound theme default migration: 1 = Lichess sfx, 2 = wooden board set */
  soundGen?: number;
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
    autoElo: true,
    ratedGames: 0,
    color: 'w',
    temperature: 1,
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
    gameType: 'coach',
    coachLevel: 'mistake',
    coachThreats: true,
    coachHanging: true,
    coachBest: false,
    coachEval: false,
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
    boardFxArrowStyle: 'line',
    boardSizePlay: 100,
    boardSizeReview: 100,
    autoplayMs: 1200,
    reviewOpponent: false,
    avatar: '',
    coachAvatar: 0,
    opponentTalk: true,
  };
}

export function loadSettings(): Settings {
  try {
    // AI coach was removed; discard any API key left by older builds.
    localStorage.removeItem('maia-coach.ai-key');
    const saved = JSON.parse(localStorage.getItem(KEY) || '{}');
    // migrate settings saved by the earlier two-rating version
    if (saved.elo === undefined && typeof saved.maiaElo === 'number') saved.elo = saved.maiaElo;
    delete saved.maiaElo;
    delete saved.myElo;
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
    return sanitizeSettings(saved);
  } catch {
    return defaultSettings();
  }
}

export const ELO_MIN = 0;
export const ELO_MAX = 2600;

type Rule = { oneOf: readonly unknown[] } | { num: [number, number]; int?: boolean } | { bool: true } | { str: RegExp } | { optInt: true };

const HEX = /^#[0-9a-f]{6}$/i;
const RULES: Record<keyof Settings, Rule> = {
  theme: { oneOf: ['dark', 'light'] },
  model: { oneOf: ['5m', '23m', '79m'] },
  elo: { num: [ELO_MIN, ELO_MAX], int: true },
  autoElo: { bool: true },
  ratedGames: { num: [0, 1e9], int: true },
  color: { oneOf: ['w', 'b', 'random'] },
  temperature: { num: [0, 1.5] },
  useHistory: { bool: true },
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
  gameType: { oneOf: ['normal', 'coach'] },
  coachLevel: { oneOf: ['inaccuracy', 'mistake', 'blunder'] },
  coachThreats: { bool: true },
  coachHanging: { bool: true },
  coachBest: { bool: true },
  coachEval: { bool: true },
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
  boardFxArrowStyle: { oneOf: ['line', 'fill'] },
  boardSizePlay: { num: [60, 100] },
  boardSizeReview: { num: [60, 100] },
  autoplayMs: { num: [100, 10000] },
  reviewOpponent: { bool: true },
  // '' / '<glyph>|#rrggbb' / small JPEG data URL; rendering validates the format again
  avatar: { str: /^[^<>"]{0,200000}$/s },
  coachAvatar: { num: [0, 999], int: true },
  opponentTalk: { bool: true },
  engineGen: { optInt: true },
  soundGen: { optInt: true },
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
    if (Object.hasOwn(src, k) && valid(RULES[k], src[k])) out[k] = src[k];
  }
  return out as unknown as Settings;
}

/**
 * Rating change after a game against an equally rated Maia (expected score 0.5).
 * K is large for the first games so a new player quickly finds their level.
 */
export function eloDelta(score: number, ratedGames: number): number {
  const k = ratedGames < 5 ? 100 : ratedGames < 15 ? 60 : 40;
  return Math.round((k * (score - 0.5)) / 10) * 10;
}

export function saveSettings(s: Settings) {
  safeSet(KEY, JSON.stringify(s));
}
