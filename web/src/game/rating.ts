// Local training rating: Glicko-1 result baseline plus bounded move-quality evidence.
import { moveAccuracy } from '../coach/coach';

export interface Assists {
  undo: number;
  hint: number;
  aids?: boolean;
  best?: boolean;
  /** Exposure ledger survives deleted takeback branches; keys are the first four FEN fields. */
  positions?: Record<string, MoveEvidence>;
}

export interface MoveEvidence {
  hints?: string[];
  best?: string[];
  info?: boolean;
  analysis?: boolean;
  reconsidered?: boolean;
}

export interface RatingEvidence {
  moves: number;
  independent: number;
  informed: number;
  suggested: number;
  followed: number;
  hints: number;
  hintFollowed: number;
  analysis: number;
  dependence: number;
}

export interface PerformanceSample {
  /** Winning chances, 0..100, from the mover's point of view. */
  before: number;
  after: number;
  forced?: boolean;
  independence?: number;
}

export interface RatingPerformance {
  playerAccuracy: number;
  opponentAccuracy: number;
  playerMoves: number;
  opponentMoves: number;
  mistakes: number;
  blunders: number;
}

export interface RatingCalculation {
  score: number;
  weight: number;
  performance?: RatingPerformance;
  undo: number;
  undoFactor: number;
  baseDelta: number;
  evidence?: RatingEvidence;
  confidence?: number;
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
  abandoned?: boolean;
  calculation?: RatingCalculation;
}

export const emptyAssists = (): Assists => ({ undo: 0, hint: 0 });

export function assistCount(a: Assists | undefined): number {
  return a ? a.undo + a.hint + (a.aids ? 1 : 0) + (a.best ? 1 : 0) : 0;
}

/** Observable exposure, not a claim about the player's intent or understanding. */
export function moveDependence(e: MoveEvidence | undefined, uci: string): number {
  if (!e) return 0;
  const recommended = [...(e.hints ?? []), ...(e.best ?? [])];
  return Math.max(e.analysis ? 0.5 : 0, e.reconsidered ? 0.25 : 0,
    recommended.includes(uci) ? 0.9 : recommended.length ? 0.25 : e.info ? 0.1 : 0);
}

export function ratingEvidence(moves: { uci: string; evidence?: MoveEvidence }[], hints: number): RatingEvidence {
  const exposed = (e?: MoveEvidence) => Boolean(e && (e.info || e.analysis || e.reconsidered || e.hints?.length || e.best?.length));
  return {
    moves: moves.length,
    independent: moves.filter(m => !exposed(m.evidence)).length,
    informed: moves.filter(m => m.evidence?.info).length,
    suggested: moves.filter(m => m.evidence?.hints?.length || m.evidence?.best?.length).length,
    followed: moves.filter(m => [...(m.evidence?.hints ?? []), ...(m.evidence?.best ?? [])].includes(m.uci)).length,
    hints, hintFollowed: moves.filter(m => m.evidence?.hints?.includes(m.uci)).length,
    analysis: moves.filter(m => m.evidence?.analysis).length,
    dependence: moves.length ? moves.reduce((sum, m) => sum + moveDependence(m.evidence, m.uci), 0) / moves.length : 0,
  };
}

const clamp = (value: number, min: number, max: number): number => Math.max(min, Math.min(max, value));

/** Ignore forced moves and already decided positions, which inflate accuracy cheaply. */
export function ratingPerformance(player: PerformanceSample[], opponent: PerformanceSample[]): RatingPerformance | undefined {
  const useful = (samples: PerformanceSample[]) => samples.filter(s => !s.forced
    && Number.isFinite(s.before) && Number.isFinite(s.after)
    && s.before > 5 && s.before < 95 && s.after >= 0 && s.after <= 100);
  const p = useful(player);
  const o = useful(opponent);
  if (!p.length || !o.length) return undefined;
  const accuracy = (samples: PerformanceSample[]) => samples.reduce((sum, s) => sum + moveAccuracy(s.before, s.after) * (s.independence ?? 1), 0)
    / samples.reduce((sum, s) => sum + (s.independence ?? 1), 0);
  return {
    playerAccuracy: accuracy(p), opponentAccuracy: accuracy(o),
    playerMoves: p.length, opponentMoves: o.length,
    mistakes: p.filter(s => s.before - s.after >= 10 && s.before - s.after < 15).length,
    blunders: p.filter(s => s.before - s.after >= 15).length,
  };
}

export function computeRating(o: {
  result: number;
  playerElo: number;
  opponentElo: number;
  deviation: number;
  streak: number;
  abandoned?: boolean;
  performance?: RatingPerformance;
  undo?: number;
  evidence?: RatingEvidence;
}): RatingInfo {
  const result = o.abandoned ? 0 : o.result;
  const confidence = Math.max(0.1, 1 - (o.evidence?.dependence ?? 0));
  const direction = result === 1 ? 1 : result === 0 ? -1 : 0;
  const streak = confidence < 0.5 ? 0 : clamp(direction === 0 ? 0 : Math.sign(o.streak) === direction ? o.streak + direction : direction, -8, 8);
  // Project heuristic, not official Glicko: sustained results reopen placement.
  const rdBefore = Math.max(clamp(o.deviation, 60, 350), Math.abs(streak) >= 3 ? 180 : 60);
  const q = Math.log(10) / 400;
  const expected = 1 / (1 + 10 ** ((o.opponentElo - o.playerElo) / 400));
  const p = o.performance;
  // At most 40% performance evidence; short games contribute proportionally less.
  const weight = p ? 0.4 * clamp(Math.min(p.playerMoves, p.opponentMoves) / 20, 0, 1) * confidence : 0;
  const quality = p ? clamp(0.5 + (p.playerAccuracy - p.opponentAccuracy) / 100, 0, 1) : result;
  let score = result * (1 - weight) + quality * weight;
  if (result === 1) score = Math.max(expected, score);
  if (result === 0) score = Math.min(expected, score);
  const precision = 1 / rdBefore ** 2 + q ** 2 * expected * (1 - expected);
  const rdAfter = clamp(Math.sqrt(1 / (1 / rdBefore ** 2 + confidence * q ** 2 * expected * (1 - expected))), 60, 350);
  const baseDelta = Math.round(q / precision * (score - expected));
  const undo = Math.max(0, Math.floor(o.undo ?? 0));
  // One accidental takeback is free. Further takebacks reduce gains, never erase losses.
  const undoFactor = 1 / (1 + 0.25 * Math.max(0, undo - 1));
  const change = baseDelta > 0 ? Math.round(baseDelta * undoFactor * confidence) : baseDelta;
  const playerAfter = clamp(o.playerElo + change, 0, 2600);
  return {
    delta: playerAfter - o.playerElo, result, expected,
    playerBefore: o.playerElo, playerAfter, opponent: o.opponentElo,
    rdBefore, rdAfter, streak,
    ...(o.abandoned ? { abandoned: true } : {}),
    ...(p || o.undo !== undefined || o.evidence ? { calculation: { score, weight, ...(p ? { performance: p } : {}), undo, undoFactor, baseDelta,
      ...(o.evidence ? { evidence: o.evidence, confidence } : {}) } } : {}),
  };
}

export function ratingBreakdown(r: RatingInfo): string {
  const parts = [
    `结果：${r.result === 1 ? '胜' : r.result === 0 ? '负' : '和'}`,
    `对手 Maia ${r.opponent}`,
    `预期得分率 ${(r.expected * 100).toFixed(0)}%`,
  ];
  const c = r.calculation;
  if (c?.performance) {
    const p = c.performance;
    parts.push(`有效着法 ${p.playerMoves} / ${p.opponentMoves} 步，准确率 ${p.playerAccuracy.toFixed(1)}% / ${p.opponentAccuracy.toFixed(1)}%（我 / Maia）`,
      `我的错误 ${p.mistakes} 次、漏着 ${p.blunders} 次`, `表现权重 ${(c.weight * 100).toFixed(0)}%`);
  } else if (c) parts.push('有效着法不足，本局按结果与对手强弱结算');
  if (c?.evidence) {
    const e = c.evidence;
    parts.push(`独立落子 ${e.independent}/${e.moves} 步，局势信息 ${e.informed} 步，局中分析 ${e.analysis} 步`,
      `提示展示 ${e.hints} 次、最终主线采纳 ${e.hintFollowed} 步；推荐着法采纳 ${e.followed}/${e.suggested} 步`,
      `独立证据权重 ${((c.confidence ?? 1) * 100).toFixed(0)}%（用于加分与定位置信度）`);
  }
  if (c?.undo) parts.push(`悔棋 ${c.undo} 次${c.undo === 1 ? '（首次容错，不影响分数）' : `（加分保留 ${(c.undoFactor * 100).toFixed(0)}%，扣分不减免）`}`);
  parts.push(`定位${r.rdAfter > 150 ? '中' : '较稳定'}（不确定度 ${r.rdBefore.toFixed(0)} → ${r.rdAfter.toFixed(0)}）`);
  if (r.abandoned) parts.push('中途离开，按认输计算，无额外扣分');
  return parts.join(' · ');
}
