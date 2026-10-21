import type { SNode } from './tree';
import type { Color, EndReason } from './rules';

/** A game as persisted: the current game slot and every finished game in the history list. */
export interface StoredGame {
  id: string;
  /** ms since epoch when the game started */
  date: number;
  startFen: string;
  tree: SNode;
  userColor: Color;
  result: string;
  reason?: EndReason;
  coach?: boolean;
  elo?: number;
  /** player's rating after this game when automatic rating adjustment was on */
  eloAfter?: number;
  model?: string;
  /** time control id, see TIME_CONTROLS */
  tc?: string;
  /** remaining [white, black] ms when saved (live games only) */
  clock?: [number, number];
  /** PGN tags kept from an imported game */
  headers?: Record<string, string>;
  /** imported games are excluded from statistics */
  imported?: boolean;
}

export function newGameId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

export type Outcome = 'win' | 'draw' | 'loss';

export function outcomeOf(g: Pick<StoredGame, 'result' | 'userColor'>): Outcome | null {
  if (g.result === '1/2-1/2') return 'draw';
  if (g.result === '1-0') return g.userColor === 'w' ? 'win' : 'loss';
  if (g.result === '0-1') return g.userColor === 'b' ? 'win' : 'loss';
  return null;
}

export interface Tally {
  games: number;
  win: number;
  draw: number;
  loss: number;
  /** score in percent (win = 1, draw = ½) */
  score: number;
}

function tally(gs: StoredGame[]): Tally {
  const t = { games: 0, win: 0, draw: 0, loss: 0, score: 0 };
  for (const g of gs) {
    const o = outcomeOf(g);
    if (!o) continue;
    t.games++;
    t[o]++;
  }
  t.score = t.games ? ((t.win + t.draw / 2) / t.games) * 100 : 0;
  return t;
}

export interface Stats {
  all: Tally;
  white: Tally;
  black: Tally;
  /** by opponent rating, buckets of 200 (key = lower bound) */
  byElo: { elo: number; t: Tally }[];
  /** last results, newest first */
  recent: Outcome[];
  /** current run of identical outcomes, newest first */
  streak: { kind: Outcome; n: number } | null;
}

export function computeStats(history: StoredGame[]): Stats {
  const played = history.filter((g) => !g.imported && outcomeOf(g));
  const buckets = new Map<number, StoredGame[]>();
  for (const g of played) {
    if (g.elo === undefined) continue;
    const b = Math.floor(g.elo / 200) * 200;
    buckets.set(b, [...(buckets.get(b) ?? []), g]);
  }
  const newest = [...played].sort((a, b) => b.date - a.date);
  const recent = newest.slice(0, 10).map((g) => outcomeOf(g)!);
  let streak: Stats['streak'] = null;
  if (recent.length) {
    let n = 0;
    for (const g of newest) if (outcomeOf(g) === recent[0]) n++;
    else break;
    streak = { kind: recent[0], n };
  }
  return {
    all: tally(played),
    white: tally(played.filter((g) => g.userColor === 'w')),
    black: tally(played.filter((g) => g.userColor === 'b')),
    byElo: [...buckets.entries()].sort((a, b) => a[0] - b[0]).map(([elo, gs]) => ({ elo, t: tally(gs) })),
    recent,
    streak,
  };
}

/** Insert or replace by id, newest first, capped. */
export function upsert(history: StoredGame[], g: StoredGame, cap = 300): StoredGame[] {
  const rest = history.filter((x) => x.id !== g.id);
  return [g, ...rest].sort((a, b) => b.date - a.date).slice(0, cap);
}

/** Plies on the main line of a serialized tree. */
export function mainlineLength(s: SNode): number {
  let n = 0;
  for (let c = s.c?.[0]; c; c = c.c?.[0]) n++;
  return n;
}

const HISTORY_KEY = 'maia-coach.history';

export function loadHistory(): StoredGame[] {
  try {
    const v = JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]');
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

export function saveHistory(h: StoredGame[]) {
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(h));
  } catch (err) {
    // quota exceeded: drop the oldest half and retry once
    console.warn('保存历史失败', err);
    try {
      localStorage.setItem(HISTORY_KEY, JSON.stringify(h.slice(0, Math.ceil(h.length / 2))));
    } catch {
      /* give up */
    }
  }
}
