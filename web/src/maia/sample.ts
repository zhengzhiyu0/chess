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

/** Same semantics as maia3.uci.sample_from_logits (temperature + nucleus sampling). */
export function sampleMove(
  moves: ScoredMove[],
  temperature: number,
  topP: number,
  rng: () => number = Math.random,
): ScoredMove {
  if (temperature <= 0) {
    return moves.reduce((a, b) => (b.logit > a.logit ? b : a));
  }
  let pool = softmaxMoves(moves.map((m) => ({ uci: m.uci, logit: m.logit / temperature })));
  if (topP < 1) {
    let cum = 0;
    pool = pool.filter((m, i) => {
      cum += m.p;
      return i === 0 || cum <= topP;
    });
  }
  const total = pool.reduce((a, m) => a + m.p, 0);
  let r = rng() * total;
  for (const m of pool) {
    r -= m.p;
    if (r <= 0) return moves.find((x) => x.uci === m.uci)!;
  }
  return moves.find((x) => x.uci === pool[pool.length - 1].uci)!;
}
