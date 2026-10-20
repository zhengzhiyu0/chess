export type Color = 'w' | 'b';

export interface Settings {
  model: '5m' | '23m' | '79m';
  elo: number;
  color: Color | 'random';
  temperature: number;
  /** feed real game history to Maia (official UCI default is off: current position repeated) */
  useHistory: boolean;
  backend: 'wasm' | 'webgpu';
  thinkDelay: boolean;
  sfMovetime: number;
  sfThreads: number;
  sfHash: number;
  lowMemory: boolean;
  /** load the selected Maia model + Stockfish in the background on startup */
  warmup: boolean;
}

const KEY = 'maia-coach.settings';

export const isIOS =
  /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

export function defaultSettings(): Settings {
  return {
    model: isIOS ? '5m' : '23m',
    elo: 1500,
    color: 'w',
    temperature: 1,
    useHistory: false,
    backend: 'wasm',
    thinkDelay: true,
    sfMovetime: 1000,
    sfThreads: Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 2) - 1)),
    sfHash: isIOS ? 32 : 128,
    lowMemory: isIOS,
    warmup: !isIOS,
  };
}

export function loadSettings(): Settings {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) || '{}');
    // migrate settings saved by the earlier two-rating version
    if (saved.elo === undefined && typeof saved.maiaElo === 'number') saved.elo = saved.maiaElo;
    delete saved.maiaElo;
    delete saved.myElo;
    return { ...defaultSettings(), ...saved };
  } catch {
    return defaultSettings();
  }
}

export function saveSettings(s: Settings) {
  localStorage.setItem(KEY, JSON.stringify(s));
}
