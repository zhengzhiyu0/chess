// Single-game Glicko-1 rating against a Maia opponent with fixed rating (RD = 0).

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
  delta: number;
  result: number;
  expected: number;
  playerBefore: number;
  playerAfter: number;
  opponent: number;
  rdBefore: number;
  rdAfter: number;
  streak: number;
  opponentAfter: number;
  abandoned?: boolean;
}

export const emptyAssists = (): Assists => ({ undo: 0, hint: 0, retry: 0 });

export function assistCount(a: Assists | undefined): number {
  return a ? a.undo + a.hint + a.retry + (a.aids ? 1 : 0) + (a.best ? 1 : 0) : 0;
}

const clamp = (value: number, min: number, max: number): number => Math.max(min, Math.min(max, value));

export function computeRating(o: {
  result: number;
  playerElo: number;
  opponentElo: number;
  deviation: number;
  streak: number;
  abandoned?: boolean;
}): RatingInfo {
  const result = o.abandoned ? 0 : o.result;
  const direction = result === 1 ? 1 : result === 0 ? -1 : 0;
  const streak = clamp(direction === 0 ? 0 : Math.sign(o.streak) === direction ? o.streak + direction : direction, -8, 8);
  // Project heuristic, not official Glicko: sustained results reopen placement.
  const rdBefore = Math.max(clamp(o.deviation, 60, 350), Math.abs(streak) >= 3 ? 180 : 60);
  const q = Math.log(10) / 400;
  const expected = 1 / (1 + 10 ** ((o.opponentElo - o.playerElo) / 400));
  const precision = 1 / rdBefore ** 2 + q ** 2 * expected * (1 - expected);
  const rdAfter = clamp(Math.sqrt(1 / precision), 60, 350);
  const playerAfter = clamp(o.playerElo + Math.round(q / precision * (result - expected)), 0, 2600);
  const target = playerAfter + Math.sign(streak) * Math.min(60, Math.max(0, Math.abs(streak) - 1) * 20);
  const step = rdBefore > 150 ? 160 : 80;
  const candidate = clamp(o.opponentElo + clamp(target - o.opponentElo, -step, step), 0, 2600);
  // A manually selected opponent can be far from the estimate: never raise difficulty after a loss or lower it after a win.
  const opponentAfter = result === 0 ? Math.min(o.opponentElo, candidate) : result === 1 ? Math.max(o.opponentElo, candidate) : candidate;
  return {
    delta: playerAfter - o.playerElo,
    result,
    expected,
    playerBefore: o.playerElo,
    playerAfter,
    opponent: o.opponentElo,
    rdBefore,
    rdAfter,
    streak,
    opponentAfter,
    ...(o.abandoned ? { abandoned: true } : {}),
  };
}

/** Short explanation of the rating change for the result dialog / history. */
export function ratingBreakdown(r: RatingInfo): string {
  const parts = [
    `结果：${r.result === 1 ? '胜' : r.result === 0 ? '负' : '和'}`,
    `对手 Maia ${r.opponent}`,
    `预期得分率 ${(r.expected * 100).toFixed(0)}%`,
    `定位${r.rdAfter > 150 ? '中' : '较稳定'}（不确定度 ${r.rdBefore.toFixed(0)} → ${r.rdAfter.toFixed(0)}）`,
  ];
  if (r.abandoned) parts.push('中途离开，按认输计算，无额外扣分');
  return parts.join(' · ');
}
