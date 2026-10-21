/** Maia's value head order is [loss, draw, win] for the side to move; returns [win, draw, loss] probabilities. */
export function wdlFromValue(v: ArrayLike<number>): [number, number, number] {
  const m = Math.max(v[0], v[1], v[2]);
  const ex = [v[0], v[1], v[2]].map((x) => Math.exp(x - m));
  const s = ex[0] + ex[1] + ex[2];
  return [ex[2] / s, ex[1] / s, ex[0] / s];
}
