export interface ScoredMove {
  uci: string;
  logit: number;
  p: number;
}

export function softmaxMoves(moves: { uci: string; logit: number }[]): ScoredMove[] {
  const max = Math.max(...moves.map((m) => m.logit));
  const exps = moves.map((m) => Math.exp(m.logit - max));
  const sum = exps.reduce((a, b) => a + b, 0);
  return moves
    .map((m, i) => ({ uci: m.uci, logit: m.logit, p: exps[i] / sum }))
    .sort((a, b) => b.p - a.p);
}

/**
 * Actual draw probabilities, not the model's raw policy. Keep the smallest
 * probability-sorted prefix that reaches topP, including the crossing move.
 */
export function samplingDistribution(
  moves: ScoredMove[],
  temperature: number,
  topP: number,
): ScoredMove[] {
  if (moves.length === 0) return [];
  if (temperature <= 0) {
    const best = moves.reduce((a, b) => (b.logit > a.logit ? b : a));
    return [{ ...best, p: 1 }];
  }
  if (!Number.isFinite(temperature) || !Number.isFinite(topP)) {
    throw new Error('Sampling temperature and topP must be finite');
  }
  const ordered = [...moves].sort((a, b) => b.logit - a.logit);
  const max = ordered[0].logit;
  // Subtract before dividing so small positive temperatures cannot overflow.
  const weights = ordered.map((m) => Math.exp((m.logit - max) / temperature));
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  let keptTotal = 0;
  let count = 0;
  do {
    keptTotal += weights[count++];
  } while (count < ordered.length && (topP >= 1 || keptTotal / total < topP));
  return ordered.slice(0, count).map((m, i) => ({ ...m, p: weights[i] / keptTotal }));
}

/** Returns the original move object: its p remains the raw model probability. */
export function sampleMove(
  moves: ScoredMove[],
  temperature: number,
  topP: number,
  rng: () => number = Math.random,
): ScoredMove {
  const pool = samplingDistribution(moves, temperature, topP);
  if (pool.length === 0) throw new Error('Cannot sample an empty move list');
  if (pool.length === 1) return moves.find((m) => m.uci === pool[0].uci)!;
  let r = rng();
  for (const m of pool) {
    r -= m.p;
    if (r < 0) return moves.find((original) => original.uci === m.uci)!;
  }
  return moves.find((m) => m.uci === pool[pool.length - 1].uci)!;
}
