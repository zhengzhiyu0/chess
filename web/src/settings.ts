import { isNative } from './native';

export type Color = 'w' | 'b';

export interface Settings {
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
  /** load the selected Maia model + Stockfish in the background on startup */
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
  return {
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
    warmup: isNative || !isIOS,
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
    boardFx: !matchMedia('(prefers-reduced-motion: reduce)').matches,
    boardSizePlay: 100,
    boardSizeReview: 100,
    autoplayMs: 1200,
    reviewOpponent: false,
    avatar: '',
    coachAvatar: 0,
  };
}

export function loadSettings(): Settings {
  try {
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
    if (isNative && saved.engineGen !== 2) {
      const d = defaultSettings();
      Object.assign(saved, { sfThreads: d.sfThreads, sfHash: d.sfHash, lowMemory: d.lowMemory, warmup: d.warmup, engineGen: 2 });
    }
    // gen 2 defaulted to cores-1 threads (5 on most iPhones), which ran hot; cap it at the performance cores
    if (isNative && saved.engineGen === 2) {
      if (typeof saved.sfThreads === 'number' && saved.sfThreads > 2) saved.sfThreads = 2;
      saved.engineGen = 3;
    }
    return { ...defaultSettings(), ...saved };
  } catch {
    return defaultSettings();
  }
}

export const ELO_MIN = 0;
export const ELO_MAX = 2600;

/**
 * Rating change after a game against an equally rated Maia (expected score 0.5).
 * K is large for the first games so a new player quickly finds their level.
 */
export function eloDelta(score: number, ratedGames: number): number {
  const k = ratedGames < 5 ? 100 : ratedGames < 15 ? 60 : 40;
  return Math.round((k * (score - 0.5)) / 10) * 10;
}

export function saveSettings(s: Settings) {
  localStorage.setItem(KEY, JSON.stringify(s));
}
