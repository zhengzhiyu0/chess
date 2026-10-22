import type { SfLine } from '../engine/stockfish';

/** Lichess win-probability model, centipawns from the side to move → 0..100. */
export function winPct(cp: number): number {
  return 50 + 50 * (2 / (1 + Math.exp(-0.00368208 * cp)) - 1);
}

/** Win% for White from a Stockfish line computed in `turn`'s POV. */
export function whiteWinPct(line: SfLine, turn: 'w' | 'b'): number {
  let w: number;
  if (line.mate !== undefined) w = line.mate > 0 ? 100 : line.mate < 0 ? 0 : 50;
  else w = winPct(line.cp ?? 0);
  return turn === 'w' ? w : 100 - w;
}

/** Evaluation text for White's POV, e.g. "+1.25" / "#-3". */
export function evalText(line: SfLine, turn: 'w' | 'b'): string {
  const sign = turn === 'w' ? 1 : -1;
  if (line.mate !== undefined) {
    if (line.mate === 0) return turn === 'w' ? '#-0' : '#0';
    return `#${sign * line.mate}`;
  }
  const v = (sign * (line.cp ?? 0)) / 100;
  return (v > 0 ? '+' : '') + v.toFixed(2);
}

export type Judgement =
  | 'brilliant'
  | 'great'
  | 'best'
  | 'book'
  | 'forced'
  | 'good'
  | 'inaccuracy'
  | 'mistake'
  | 'miss'
  | 'blunder';

/** Display order, best to worst. */
export const JUDGEMENTS: Judgement[] = ['brilliant', 'great', 'best', 'book', 'forced', 'good', 'inaccuracy', 'mistake', 'miss', 'blunder'];

export const JUDGEMENT_INFO: Record<Judgement, { label: string; symbol: string; color: string }> = {
  brilliant: { label: '妙着', symbol: '!!', color: '#1fb5ad' },
  great: { label: '关键一着', symbol: '!', color: '#5b8fd6' },
  best: { label: '最佳', symbol: '★', color: '#5bb85b' },
  book: { label: '开局库', symbol: '', color: '#a8865e' },
  forced: { label: '唯一着法', symbol: '', color: '#8f9aa3' },
  good: { label: '好棋', symbol: '', color: '#9ab' },
  inaccuracy: { label: '不精确', symbol: '?!', color: '#e6b422' },
  mistake: { label: '错误', symbol: '?', color: '#e08a1e' },
  miss: { label: '错失良机', symbol: '?', color: '#e5675a' },
  blunder: { label: '漏着', symbol: '??', color: '#d9443a' },
};

/** 0 = fine; coach pauses at or above the configured level. */
export const SEVERITY: Record<Judgement, number> = {
  brilliant: 0,
  great: 0,
  best: 0,
  book: 0,
  forced: 0,
  good: 0,
  inaccuracy: 1,
  mistake: 2,
  miss: 2,
  blunder: 3,
};

/** Lichess thresholds: drop in mover's win% of 10/20/30 points. */
export function judge(moverBefore: number, moverAfter: number, playedBest: boolean): Judgement {
  if (playedBest) return 'best';
  const drop = moverBefore - moverAfter;
  if (drop >= 30) return 'blunder';
  if (drop >= 20) return 'mistake';
  if (drop >= 10) return 'inaccuracy';
  return 'good';
}

export interface MoveContext {
  /** mover's win% before / after the move */
  before: number;
  after: number;
  playedBest: boolean;
  /** the position after the move is a named opening position (and so was the one before) */
  book: boolean;
  /** the mover had exactly one legal move */
  forced: boolean;
  /** the move leaves a minor piece or more en prise for a net material loss */
  sacrifice: boolean;
  /** win% the opponent threw away with the move just before this one */
  oppDrop?: number;
  /** win% gap between the engine's best and second-best move, when a multi-PV search is known */
  secondGap?: number;
}

/**
 * chess.com-style classification on top of the Lichess thresholds:
 * - 妙着 brilliant: a sound sacrifice (best or near-best, not already completely winning, still fine after)
 * - 关键一着 great: the only good move (big gap to the 2nd best) or punishing the opponent's mistake
 * - 错失良机 miss: the opponent just erred and the reply gives most of it back
 */
export function classify(m: MoveContext): Judgement {
  if (m.forced) return 'forced';
  if (m.book) return 'book';
  const base = judge(m.before, m.after, m.playedBest);
  const drop = m.before - m.after;
  if (m.sacrifice && drop < 3 && m.after >= 50 && m.before < 97) return 'brilliant';
  if (m.playedBest) {
    if ((m.secondGap ?? 0) >= 20 && m.after >= 40) return 'great';
    if ((m.oppDrop ?? 0) >= 20 && m.after >= 60 && m.before < 97) return 'great';
    return 'best';
  }
  if ((base === 'inaccuracy' || base === 'mistake') && (m.oppDrop ?? 0) >= 20) return 'miss';
  return base;
}

/** Lichess per-move accuracy formula. */
export function moveAccuracy(moverBefore: number, moverAfter: number): number {
  const drop = Math.max(0, moverBefore - moverAfter);
  return Math.max(0, Math.min(100, 103.1668 * Math.exp(-0.04354 * drop) - 3.1669));
}
