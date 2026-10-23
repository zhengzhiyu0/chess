// Puzzle training: bundled Lichess puzzles (CC0) with a separate puzzle rating.
import { Chess } from 'chess.js';
import { toMove } from '../game/rules';
import { isObj, readJson, safeSet } from '../storage';

export interface Puzzle {
  id: string;
  /** position before the opponent's setup move */
  fen: string;
  /** moves[0] is the opponent's move, then the solution alternates player / opponent */
  moves: string[];
  rating: number;
  themes: string[];
}

interface Band {
  lo: number;
  hi: number;
  file: string;
  count: number;
}

interface Index {
  total: number;
  bands: Band[];
  themes: Record<string, number>;
}

export interface PuzzleProgress {
  rating: number;
  games: number;
  /** recently played puzzle ids, newest last (not served again soon) */
  recent: string[];
  solved: number;
  failed: number;
  /** per theme: [solved, failed] */
  byTheme: Record<string, [number, number]>;
}

export const THEME_LABEL: Record<string, string> = {
  fork: '捉双',
  pin: '牵制',
  skewer: '串击',
  discoveredAttack: '闪击',
  doubleCheck: '双将',
  hangingPiece: '白吃子',
  trappedPiece: '困子',
  capturingDefender: '吃掉保护者',
  deflection: '引离',
  attraction: '引入',
  sacrifice: '弃子',
  backRankMate: '底线杀',
  smotheredMate: '闷杀',
  mateIn1: '一步杀',
  mateIn2: '两步杀',
  mateIn3: '三步杀',
  mate: '将杀',
  promotion: '升变',
  quietMove: '安静着',
  xRayAttack: 'X 光',
  clearance: '腾挪',
  interference: '拦截',
  intermezzo: '中间着',
  defensiveMove: '防守',
  endgame: '残局',
  opening: '开局',
  middlegame: '中局',
};

const KEY = 'maia-coach.puzzles';
const RECENT = 500;

export function defaultProgress(): PuzzleProgress {
  return { rating: 1200, games: 0, recent: [], solved: 0, failed: 0, byTheme: {} };
}

const num = (v: unknown) => typeof v === 'number' && Number.isFinite(v);

export function sanitizeProgress(raw: unknown): PuzzleProgress {
  const d = defaultProgress();
  if (!isObj(raw)) return d;
  if (num(raw.rating)) d.rating = Math.max(400, Math.min(3000, raw.rating as number));
  for (const k of ['games', 'solved', 'failed'] as const) if (num(raw[k])) d[k] = Math.max(0, raw[k] as number);
  if (Array.isArray(raw.recent)) d.recent = raw.recent.filter((x) => typeof x === 'string' && x.length < 16).slice(-RECENT);
  if (isObj(raw.byTheme))
    for (const [k, v] of Object.entries(raw.byTheme))
      if (Object.hasOwn(THEME_LABEL, k) && Array.isArray(v) && v.length === 2 && v.every(num)) d.byTheme[k] = [v[0], v[1]];
  return d;
}

let progress: PuzzleProgress | null = null;

export function loadProgress(): PuzzleProgress {
  progress ??= sanitizeProgress(readJson(KEY));
  return progress;
}

export function setProgress(p: PuzzleProgress): boolean {
  progress = p;
  return safeSet(KEY, JSON.stringify(p));
}

/** Merge for backup import: the side with more puzzles played wins, history is united. */
export function mergeProgress(a: PuzzleProgress, b: PuzzleProgress): PuzzleProgress {
  const main = b.games > a.games ? b : a;
  return { ...main, recent: [...new Set([...a.recent, ...b.recent])].slice(-RECENT) };
}

let index: Promise<Index> | null = null;
const bandCache = new Map<string, Promise<Puzzle[]>>();

const base = () => new URL('puzzles/', document.baseURI).href;

export function loadIndex(): Promise<Index> {
  index ??= fetch(base() + 'index.json')
    .then((r) => {
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json() as Promise<Index>;
    })
    .catch((err) => {
      index = null;
      throw err;
    });
  return index;
}

export function parsePuzzles(text: string): Puzzle[] {
  const out: Puzzle[] = [];
  for (const line of text.split('\n')) {
    const f = line.split(',');
    if (f.length < 5) continue;
    out.push({ id: f[0], fen: f[1], moves: f[2].split(' '), rating: Number(f[3]), themes: f[4] ? f[4].split(' ') : [] });
  }
  return out;
}

function loadBand(b: Band): Promise<Puzzle[]> {
  let p = bandCache.get(b.file);
  if (!p) {
    p = fetch(base() + b.file)
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.text();
      })
      .then(parsePuzzles);
    p.catch(() => bandCache.delete(b.file));
    bandCache.set(b.file, p);
  }
  return p;
}

/** Picks an unseen puzzle near the player's puzzle rating, optionally of one theme. */
export async function nextPuzzle(theme: string | null, rand = Math.random): Promise<Puzzle | null> {
  const idx = await loadIndex();
  const p = loadProgress();
  const seen = new Set(p.recent);
  const target = p.rating + (rand() - 0.5) * 200;
  // nearest bands first; widen until something fits
  const bands = [...idx.bands].sort((a, b) => Math.abs((a.lo + a.hi) / 2 - target) - Math.abs((b.lo + b.hi) / 2 - target));
  for (const b of bands) {
    const ps = (await loadBand(b)).filter((x) => !seen.has(x.id) && (!theme || x.themes.includes(theme)));
    if (!ps.length) continue;
    ps.sort((x, y) => Math.abs(x.rating - target) - Math.abs(y.rating - target));
    return ps[Math.floor(rand() * Math.min(20, ps.length))];
  }
  return null;
}

/** Glicko-lite: fast at the start, then a steady K of 20. */
export function puzzleDelta(rating: number, puzzle: number, solved: boolean, games: number): number {
  const k = games < 10 ? 60 : games < 30 ? 35 : 20;
  const exp = 1 / (1 + 10 ** ((puzzle - rating) / 400));
  return Math.round(k * ((solved ? 1 : 0) - exp));
}

export function recordPuzzle(pz: Puzzle, solved: boolean): number {
  const p = loadProgress();
  const d = puzzleDelta(p.rating, pz.rating, solved, p.games);
  p.rating = Math.max(400, Math.min(3000, p.rating + d));
  p.games++;
  if (solved) p.solved++;
  else p.failed++;
  p.recent = [...p.recent.filter((x) => x !== pz.id), pz.id].slice(-RECENT);
  for (const t of pz.themes) {
    if (!Object.hasOwn(THEME_LABEL, t)) continue;
    const s = (p.byTheme[t] ??= [0, 0]);
    s[solved ? 0 : 1]++;
  }
  setProgress(p);
  return d;
}

/** A puzzle left unanswered after the opponent's move: not rated, but not served again soon either. */
export function markPuzzleSeen(pz: Puzzle) {
  const p = loadProgress();
  p.recent = [...p.recent.filter((x) => x !== pz.id), pz.id].slice(-RECENT);
  setProgress(p);
}

/**
 * Whether `uci` solves the step: the expected move, or any move that mates (Lichess accepts
 * alternative mates in the final move).
 */
export function acceptsMove(fen: string, uci: string, expected: string): boolean {
  if (uci === expected) return true;
  try {
    const c = new Chess(fen);
    c.move(toMove(uci));
    return c.isCheckmate();
  } catch {
    return false;
  }
}
