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

export type Judgement = 'best' | 'good' | 'inaccuracy' | 'mistake' | 'blunder';

export const JUDGEMENT_INFO: Record<Judgement, { label: string; symbol: string; color: string }> = {
  best: { label: '最佳', symbol: '★', color: '#5bb85b' },
  good: { label: '好棋', symbol: '', color: '#9ab' },
  inaccuracy: { label: '不精确', symbol: '?!', color: '#e6b422' },
  mistake: { label: '错误', symbol: '?', color: '#e08a1e' },
  blunder: { label: '漏着', symbol: '??', color: '#d9443a' },
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

/** Lichess per-move accuracy formula. */
export function moveAccuracy(moverBefore: number, moverAfter: number): number {
  const drop = Math.max(0, moverBefore - moverAfter);
  return Math.max(0, Math.min(100, 103.1668 * Math.exp(-0.04354 * drop) - 3.1669));
}
