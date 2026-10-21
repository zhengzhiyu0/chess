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
  /** review: also judge the opponent's moves (default: only mine) */
  reviewOpponent: boolean;
}

const KEY = 'maia-coach.settings';

export const isIOS =
  /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

export function defaultSettings(): Settings {
  return {
    model: isIOS ? '5m' : '23m',
    elo: 1500,
    autoElo: true,
    ratedGames: 0,
    color: 'w',
    temperature: 1,
    useHistory: false,
    backend: 'wasm',
    thinkDelay: true,
    sfMovetime: 1000,
    sfThreads: Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 2) - 1)),
    sfHash: isIOS ? 32 : 128,
    sfLite: isIOS,
    lowMemory: isIOS,
    warmup: !isIOS,
    autoOffline: true,
    gameType: 'coach',
    coachLevel: 'mistake',
    coachThreats: true,
    coachHanging: true,
    coachBest: false,
    coachEval: false,
    timeControl: 'none',
    sound: true,
    soundTheme: 'wood',
    haptics: true,
    boardTheme: 'green',
    customLight: '#ebecd0',
    customDark: '#739552',
    pieceSet: 'cburnett',
    premove: true,
    reviewOpponent: false,
  };
}

export function loadSettings(): Settings {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) || '{}');
    // migrate settings saved by the earlier two-rating version
    if (saved.elo === undefined && typeof saved.maiaElo === 'number') saved.elo = saved.maiaElo;
    delete saved.maiaElo;
    delete saved.myElo;
    if (isNative && saved.model === '79m') saved.model = '23m';
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
