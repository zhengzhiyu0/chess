import type { SNode } from './tree';
import { END_REASON_TEXT, type Color, type EndReason } from './rules';
import { isObj, readJson, safeSet } from '../storage';
import type { Assists, RatingInfo } from './rating';

export type { Assists, RatingInfo } from './rating';

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
  /** help used by the player during the game */
  assists?: Assists;
  /** how the rating change was computed (auto-rated games only) */
  rating?: RatingInfo;
  /** left unfinished by starting another game (counted as a resignation) */
  abandoned?: boolean;
  /** finished, rating change not applied yet (waiting for the analysis of the game) */
  ratePending?: boolean;
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

/** Plies on the main line of a serialized tree (same as GameTree.mainline: explorations are not part of it). */
export function mainlineLength(s: SNode): number {
  const next = (n: SNode) => n.c?.find((c) => !c.x);
  let n = 0;
  for (let c = next(s); c; c = next(c)) n++;
  return n;
}

const HISTORY_KEY = 'maia-coach.history';

export function loadHistory(): StoredGame[] {
  const v = readJson(HISTORY_KEY);
  return Array.isArray(v) ? v.map(sanitizeGame).filter((g): g is StoredGame => g !== null) : [];
}

export function saveHistory(h: StoredGame[]): boolean {
  return safeSet(HISTORY_KEY, JSON.stringify(h));
}

const RESULT_SET = new Set(['', '*', '1-0', '0-1', '1/2-1/2']);
const REASONS = new Set(Object.keys(END_REASON_TEXT));
const str = (v: unknown, max = 200) => typeof v === 'string' && v.length <= max;
const num = (v: unknown) => typeof v === 'number' && Number.isFinite(v);

/**
 * Structural check of a stored / imported game (cheap; the move tree itself is verified by
 * GameTree.deserialize when the game is opened). Unknown or malformed optional fields are dropped.
 */
export function sanitizeGame(raw: unknown): StoredGame | null {
  if (!isObj(raw)) return null;
  const r = raw;
  // ids come from newGameId() (base-36 time + random); anything else could break the markup they end up in
  if (typeof r.id !== 'string' || !/^[\w-]{1,64}$/.test(r.id) || !num(r.date) || !str(r.startFen) || !isObj(r.tree) || (r.userColor !== 'w' && r.userColor !== 'b')) return null;
  const g: StoredGame = {
    id: r.id as string,
    date: r.date as number,
    startFen: r.startFen as string,
    tree: r.tree as SNode,
    userColor: r.userColor,
    result: typeof r.result === 'string' && RESULT_SET.has(r.result) ? (r.result === '*' ? '' : r.result) : '',
  };
  if (typeof r.reason === 'string' && REASONS.has(r.reason)) g.reason = r.reason as EndReason;
  if (r.coach === true) g.coach = true;
  if (num(r.elo)) g.elo = r.elo as number;
  if (num(r.eloAfter)) g.eloAfter = r.eloAfter as number;
  if (str(r.model, 16)) g.model = r.model as string;
  if (str(r.tc, 16)) g.tc = r.tc as string;
  if (Array.isArray(r.clock) && r.clock.length === 2 && r.clock.every(num)) g.clock = [r.clock[0], r.clock[1]];
  if (isObj(r.headers)) {
    const h: Record<string, string> = {};
    for (const [k, v] of Object.entries(r.headers)) if (/^\w{1,40}$/.test(k) && str(v, 500)) h[k] = v as string;
    g.headers = h;
  }
  if (r.imported === true) g.imported = true;
  if (isObj(r.assists)) {
    const a = r.assists;
    g.assists = {
      undo: num(a.undo) ? (a.undo as number) : 0,
      hint: num(a.hint) ? (a.hint as number) : 0,
      retry: num(a.retry) ? (a.retry as number) : 0,
      ...(a.aids === true ? { aids: true } : {}),
      ...(a.best === true ? { best: true } : {}),
    };
  }
  if (isObj(r.rating) && num(r.rating.delta) && num(r.rating.k) && num(r.rating.result) && num(r.rating.score) && num(r.rating.assist)) {
    const x = r.rating;
    g.rating = {
      delta: x.delta as number,
      k: x.k as number,
      result: x.result as number,
      score: x.score as number,
      assist: x.assist as number,
      ...(num(x.accuracy) ? { accuracy: x.accuracy as number } : {}),
      ...(num(x.expected) ? { expected: x.expected as number } : {}),
      ...(x.abandoned === true ? { abandoned: true } : {}),
    };
  }
  if (r.abandoned === true) g.abandoned = true;
  if (r.ratePending === true) g.ratePending = true;
  return g;
}
