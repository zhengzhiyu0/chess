/** Glickman's March 2022 specification, including the revised volatility solver.
 * https://www.glicko.net/glicko/glicko2.pdf
 * This mathematical core keeps full precision and applies no product rating bounds.
 */
export interface Glicko2State {
  rating: number;
  deviation: number;
  volatility: number;
}

export interface Glicko2Result {
  rating: number;
  deviation: number;
  score: number;
}

export const DEFAULT_VOLATILITY = 0.06;
export const GLICKO2_TAU = 0.5;
export const RATING_PERIOD_GAMES = 10;

/** Pending fixed-Maia results; an incomplete period contains at most nine games. */
export function sanitizeRatingPeriod(raw: unknown): Glicko2Result[] {
  if (!Array.isArray(raw) || raw.length >= RATING_PERIOD_GAMES) return [];
  if (!raw.every(r => r && typeof r === 'object' && Number.isInteger(r.rating) && r.rating >= 0 && r.rating <= 2600
    && r.deviation === 0 && [0, 0.5, 1].includes(r.score))) return [];
  return raw.map(r => ({ rating: r.rating, deviation: 0, score: r.score }));
}
const SCALE = 173.7178;
const EPSILON = 0.000001;

export function glicko2Expected(player: number, opponent: number, opponentDeviation: number): number {
  const g = 1 / Math.sqrt(1 + 3 * (opponentDeviation / SCALE) ** 2 / Math.PI ** 2);
  return 1 / (1 + Math.exp(-g * (player - opponent) / SCALE));
}

/** All results in one period use the same pre-period player state. */
export function updateGlicko2(state: Glicko2State, results: readonly Glicko2Result[], tau = GLICKO2_TAU): Glicko2State {
  const mu = (state.rating - 1500) / SCALE;
  const phi = state.deviation / SCALE;
  if (!results.length) return { ...state, deviation: SCALE * Math.hypot(phi, state.volatility) };
  let information = 0;
  let residual = 0;
  for (const result of results) {
    const g = 1 / Math.sqrt(1 + 3 * (result.deviation / SCALE) ** 2 / Math.PI ** 2);
    const expected = glicko2Expected(state.rating, result.rating, result.deviation);
    information += g * g * expected * (1 - expected);
    residual += g * (result.score - expected);
  }
  const variance = 1 / information;
  const delta = variance * residual;
  const a = Math.log(state.volatility ** 2);
  const f = (x: number): number => {
    const ex = Math.exp(x);
    return ex * (delta ** 2 - phi ** 2 - variance - ex) / (2 * (phi ** 2 + variance + ex) ** 2) - (x - a) / tau ** 2;
  };
  let A = a;
  let B: number;
  if (delta ** 2 > phi ** 2 + variance) B = Math.log(delta ** 2 - phi ** 2 - variance);
  else {
    let k = 1;
    while (f(a - k * tau) < 0) {
      if (++k > 1000) throw new Error('Glicko-2 volatility bracket did not converge');
    }
    B = a - k * tau;
  }
  let fA = f(A);
  let fB = f(B);
  let iterations = 0;
  while (Math.abs(B - A) > EPSILON) {
    if (++iterations > 1000) throw new Error('Glicko-2 volatility solver did not converge');
    const C = A + (A - B) * fA / (fB - fA);
    const fC = f(C);
    if (fC * fB <= 0) { A = B; fA = fB; }
    else fA /= 2;
    B = C;
    fB = fC;
  }
  const volatility = Math.exp(A / 2);
  const preDeviation = Math.hypot(phi, volatility);
  const deviation = 1 / Math.sqrt(1 / preDeviation ** 2 + 1 / variance);
  return {
    rating: 1500 + SCALE * (mu + deviation ** 2 * residual),
    deviation: SCALE * deviation,
    volatility,
  };
}
