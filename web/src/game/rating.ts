// Performance-based rating change for a finished game against Maia (rated at the player's own level).

/** Help the player used during the game. */
export interface Assists {
  undo: number;
  hint: number;
  /** "重走这步" after the coach paused on a bad move */
  retry: number;
  /** coach aids were on while the player moved: threat arrows / under-defended pieces */
  aids?: boolean;
  /** the engine's best move was shown on every move */
  best?: boolean;
}

export interface RatingInfo {
  /** final change applied to the rating */
  delta: number;
  k: number;
  /** 1 / ½ / 0 */
  result: number;
  /** player's average move accuracy, if enough moves were analysed */
  accuracy?: number;
  /** typical accuracy at the game's rating */
  expected?: number;
  /** combined score fed into the formula, 0..1 */
  score: number;
  /** share of a gain that is kept after assists, 0..1 */
  assist: number;
  abandoned?: boolean;
}

export const emptyAssists = (): Assists => ({ undo: 0, hint: 0, retry: 0 });

export function assistCount(a: Assists | undefined): number {
  return a ? a.undo + a.hint + a.retry + (a.aids ? 1 : 0) + (a.best ? 1 : 0) : 0;
}

/** K factor: large for the first games so a new player quickly finds their level. */
export function kFactor(ratedGames: number): number {
  return ratedGames < 5 ? 100 : ratedGames < 15 ? 60 : 40;
}

/** Rough average accuracy of players at `elo` (Lichess-style accuracy). */
export function expectedAccuracy(elo: number): number {
  return Math.max(55, Math.min(90, 55 + elo * 0.0125));
}

/** How well the game was played compared with the rating: 0.5 = typical, 0 / 1 = 12.5 points worse / better. */
export function performanceOf(accuracy: number, elo: number): number {
  return Math.max(0, Math.min(1, 0.5 + (accuracy - expectedAccuracy(elo)) / 25));
}

/**
 * Result counts 70%, quality of play 30%: a win always gains and a loss always loses (only less
 * after a well-played game); a draw goes up or down depending on how well it was played.
 * `perf` is the performance from {@link performanceOf}; unknown (analysis unfinished) counts as typical.
 */
export function combinedScore(result: number, perf = 0.5): number {
  return 0.7 * result + 0.3 * perf;
}

/**
 * Share of a rating gain that is kept: every undo / hint / retry costs part of it, coach aids
 * 20%, a permanently shown best move almost all of it.
 */
export function assistFactor(a: Assists): number {
  let f = 1 - 0.2 * a.undo - 0.15 * a.hint - 0.2 * a.retry;
  if (a.aids) f *= 0.8;
  if (a.best) f *= 0.2;
  return Math.max(0, Math.min(1, f));
}

export function computeRating(o: {
  result: number;
  elo: number;
  ratedGames: number;
  accuracy?: number;
  assists: Assists;
  /** left the game unfinished: worst possible performance */
  abandoned?: boolean;
}): RatingInfo {
  const k = kFactor(o.ratedGames);
  const perf = o.abandoned ? 0 : o.accuracy === undefined ? 0.5 : performanceOf(o.accuracy, o.elo);
  const score = combinedScore(o.result, perf);
  const assist = assistFactor(o.assists);
  const raw = k * (score - 0.5);
  // help never softens a loss, it only shrinks a gain
  const delta = Math.round(raw > 0 ? raw * assist : raw);
  return {
    delta,
    k,
    result: o.result,
    accuracy: o.abandoned ? undefined : o.accuracy,
    expected: o.accuracy === undefined || o.abandoned ? undefined : expectedAccuracy(o.elo),
    score,
    assist,
    ...(o.abandoned ? { abandoned: true } : {}),
  };
}

/** Short explanation of the rating change for the result dialog / history. */
export function ratingBreakdown(r: RatingInfo): string {
  const parts = [`结果：${r.result === 1 ? '胜' : r.result === 0 ? '负' : '和'}`];
  if (r.abandoned) parts.push('中途离开，按认输且最低表现计算');
  else if (r.accuracy !== undefined) parts.push(`准确率 ${r.accuracy.toFixed(0)}%（该分段平均约 ${r.expected!.toFixed(0)}%）`);
  else parts.push('分析未完成，按平均表现计算');
  // by the sign of the unscaled change: a gain cut to 0 by heavy help is still a gain that was cut
  if (r.assist < 1) parts.push(r.score > 0.5 ? `用了辅助，加分 ×${r.assist.toFixed(2)}` : '用了辅助（不减少扣分）');
  return parts.join(' · ');
}
