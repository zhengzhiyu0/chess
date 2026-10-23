// Mistake notebook: the player's own errors from reviewed games, retrained with spaced repetition.
import { Chess } from 'chess.js';
import { isObj, readJson, safeSet } from '../storage';
import { toMove } from '../game/rules';

export interface Mistake {
  /** game id + ply: the same mistake is only stored once */
  id: string;
  gameId: string;
  /** ms since epoch the game was played */
  date: number;
  /** position before the bad move, the player to move */
  fen: string;
  played: string;
  playedSan: string;
  /** engine best move and its line from `fen` */
  best: string;
  line: string[];
  judgement: 'mistake' | 'miss' | 'blunder';
  /** win% lost by the move */
  drop: number;
  /** error type, see mistakeTag */
  tag: string;
  tagLabel: string;
  /** spaced repetition: consecutive correct answers, next due time */
  streak: number;
  due: number;
  tries: number;
  solved: number;
  /** learnt: enough correct answers in a row */
  mastered?: boolean;
}

const KEY = 'maia-coach.mistakes';
/** ids the player deleted, so reviewing the game again does not bring them back */
const DELETED_KEY = 'maia-coach.mistakes-deleted';
const CAP = 1000;
export const DELETED_CAP = 2000;
const DAY = 86_400_000;
/** days until the next review after 0, 1, 2, 3 correct answers in a row */
const INTERVALS = [0, 1, 3, 7];
/** learnt once answered right on time after every interval, the 7-day one included */
export const MASTER_STREAK = INTERVALS.length;
const UCI = /^[a-h][1-8][a-h][1-8][qrbn]?$/;

let list: Mistake[] | null = null;
let deleted: string[] | null = null;

const str = (v: unknown) => typeof v === 'string' && v.length < 300;
const num = (v: unknown) => typeof v === 'number' && Number.isFinite(v);

export function sanitizeMistake(raw: unknown): Mistake | null {
  if (!isObj(raw)) return null;
  const r = raw;
  if (![r.id, r.gameId, r.fen, r.played, r.playedSan, r.best, r.tag, r.tagLabel].every(str)) return null;
  if (!UCI.test(r.best as string) || !UCI.test(r.played as string)) return null;
  if (!['mistake', 'miss', 'blunder'].includes(r.judgement as string)) return null;
  if (![r.date, r.drop, r.streak, r.due, r.tries, r.solved].every(num)) return null;
  if (!Array.isArray(r.line) || !r.line.every((u) => typeof u === 'string' && UCI.test(u))) return null;
  // a broken position would make the trainer throw on every attempt
  if (!legalIn(r.fen as string, r.best as string) || !legalIn(r.fen as string, r.played as string)) return null;
  return {
    id: r.id as string,
    gameId: r.gameId as string,
    date: r.date as number,
    fen: r.fen as string,
    played: r.played as string,
    playedSan: r.playedSan as string,
    best: r.best as string,
    line: (r.line as string[]).slice(0, 12),
    judgement: r.judgement as Mistake['judgement'],
    drop: r.drop as number,
    tag: r.tag as string,
    tagLabel: r.tagLabel as string,
    streak: r.streak as number,
    due: r.due as number,
    tries: r.tries as number,
    solved: r.solved as number,
    ...(r.mastered === true ? { mastered: true } : {}),
  };
}

function legalIn(fen: string, uci: string): boolean {
  try {
    new Chess(fen).move(toMove(uci));
    return true;
  } catch {
    return false;
  }
}

export function loadMistakes(): Mistake[] {
  if (list) return list;
  const v = readJson(KEY);
  list = Array.isArray(v) ? v.map(sanitizeMistake).filter((m): m is Mistake => m !== null) : [];
  return list;
}

export function setMistakes(ms: Mistake[]): boolean {
  list = ms.slice(0, CAP);
  return safeSet(KEY, JSON.stringify(list));
}

/** Valid, unique deleted ids, oldest first, capped to the newest DELETED_CAP. */
export function sanitizeDeleted(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const ids = raw.filter((x): x is string => typeof x === 'string' && x.length < 300);
  // keep the last occurrence of each id so a re-deletion counts as recent
  return [...new Set(ids.reverse())].reverse().slice(-DELETED_CAP);
}

export function loadDeletedMistakes(): string[] {
  deleted ??= sanitizeDeleted(readJson(DELETED_KEY));
  return deleted;
}

export function setDeletedMistakes(ids: string[]): boolean {
  deleted = sanitizeDeleted(ids);
  return safeSet(DELETED_KEY, JSON.stringify(deleted));
}

/** Adds new mistakes; existing ones keep their training progress, deleted ones stay deleted. Returns how many were new. */
export function addMistakes(ms: Mistake[]): number {
  const cur = loadMistakes();
  const skip = new Set([...cur.map((m) => m.id), ...loadDeletedMistakes()]);
  const fresh = ms.filter((m) => !skip.has(m.id));
  if (!fresh.length) return 0;
  setMistakes([...fresh, ...cur].sort((a, b) => b.date - a.date));
  return fresh.length;
}

export function removeMistake(id: string) {
  setDeletedMistakes([...loadDeletedMistakes(), id]);
  setMistakes(loadMistakes().filter((m) => m.id !== id));
}

/**
 * Records one training attempt and schedules the next review. Practice before the review is due
 * only counts the try: the spacing is what makes a mistake learnt. Returns whether it was graded.
 */
export function gradeMistake(id: string, correct: boolean, now = Date.now()): boolean {
  const m = loadMistakes().find((x) => x.id === id);
  if (!m) return false;
  m.tries++;
  if (m.due > now) {
    setMistakes(loadMistakes());
    return false;
  }
  if (correct) {
    m.solved++;
    m.streak++;
    if (m.streak >= MASTER_STREAK) m.mastered = true;
    m.due = now + INTERVALS[Math.min(m.streak, INTERVALS.length - 1)] * DAY;
  } else {
    m.streak = 0;
    delete m.mastered;
    m.due = now + 10 * 60_000;
  }
  setMistakes(loadMistakes());
  return true;
}

/** Training queue: due and not yet learnt, worst errors first. */
export function dueMistakes(now = Date.now()): Mistake[] {
  return loadMistakes()
    .filter((m) => !m.mastered && m.due <= now)
    .sort((a, b) => b.drop - a.drop);
}

export interface TagStat {
  tag: string;
  label: string;
  total: number;
  /** last 30 days vs. the 30 days before */
  recent: number;
  previous: number;
  mastered: number;
}

/** Most common error types with a 30-day trend. */
export function mistakeStats(ms: Mistake[], now = Date.now()): TagStat[] {
  const by = new Map<string, TagStat>();
  for (const m of ms) {
    const s = by.get(m.tag) ?? { tag: m.tag, label: m.tagLabel, total: 0, recent: 0, previous: 0, mastered: 0 };
    s.total++;
    const age = now - m.date;
    if (age < 30 * DAY) s.recent++;
    else if (age < 60 * DAY) s.previous++;
    if (m.mastered) s.mastered++;
    by.set(m.tag, s);
  }
  return [...by.values()].sort((a, b) => b.total - a.total);
}

/** Backup import: merge by id, keeping the entry with more training. */
export function mergeMistakes(a: Mistake[], b: Mistake[]): Mistake[] {
  const map = new Map(a.map((m) => [m.id, m]));
  for (const m of b) {
    const cur = map.get(m.id);
    if (!cur || m.tries > cur.tries) map.set(m.id, m);
  }
  return [...map.values()].sort((x, y) => y.date - x.date).slice(0, CAP);
}

export function resetMistakeCache() {
  list = null;
  deleted = null;
}
