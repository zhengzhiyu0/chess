// Local Elo estimate relative to Maia presets, using result-only Glicko-2 updates.
import { moveAccuracy } from '../coach/coach';
import { DEFAULT_VOLATILITY, RATING_PERIOD_GAMES, glicko2Expected, updateGlicko2, type Glicko2Result } from './glicko2';

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
  /** Missing on historical settlements, which keep their original explanation. */
  method?: 'result-v2' | 'glicko2-v1' | 'glicko2-period-v1';
  period?: Glicko2Result[];
  periodCompleted?: boolean;
  volatilityBefore?: number;
  volatilityAfter?: number;
  excluded?: 'assisted' | 'sampling';
  games?: number;
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

/** Check the whole exposure ledger, including branches removed by takebacks. */
export function hasRatingAssistance(a?: Assists, e?: RatingEvidence): boolean {
  return Boolean(assistCount(a) || e && (e.hints || e.informed || e.suggested || e.analysis || e.dependence)
    || Object.values(a?.positions ?? {}).some(p => p.info || p.analysis || p.reconsidered || p.hints?.length || p.best?.length));
}

export function ratingEstimate(elo: number, deviation: number, games: number, levels: readonly number[]) {
  const low = Math.floor((elo - 2 * deviation) / 10) * 10;
  const high = Math.ceil((elo + 2 * deviation) / 10) * 10;
  const opponent = levels.reduce((best, level) => Math.abs(level - elo) < Math.abs(best - elo) ? level : best, levels[0]);
  return { low, high, opponent, provisional: games < 10 || deviation > 100 };
}

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
  volatility?: number;
  streak: number;
  abandoned?: boolean;
  performance?: RatingPerformance;
  undo?: number;
  evidence?: RatingEvidence;
  assists?: Assists;
  temperature?: number;
  games?: number;
  period?: readonly Glicko2Result[];
}): RatingInfo {
  const result = o.abandoned ? 0 : o.result;
  const excluded = hasRatingAssistance(o.assists ?? { undo: o.undo ?? 0, hint: 0 }, o.evidence) ? 'assisted'
    : o.temperature !== undefined && Math.abs(o.temperature - 1) > 1e-9 ? 'sampling' : undefined;
  const direction = result === 1 ? 1 : result === 0 ? -1 : 0;
  const streak = excluded ? o.streak : clamp(direction === 0 ? 0 : Math.sign(o.streak) === direction ? o.streak + direction : direction, -8, 8);
  const rdBefore = o.deviation;
  const volatilityBefore = o.volatility ?? DEFAULT_VOLATILITY;
  const expected = glicko2Expected(o.playerElo, o.opponentElo, 0);
  const p = o.performance;
  const results = [...(o.period ?? []), ...(!excluded ? [{ rating: o.opponentElo, deviation: 0, score: result }] : [])];
  const periodCompleted = !excluded && results.length === RATING_PERIOD_GAMES;
  // Every result uses the same pre-period state; incomplete periods never change it.
  const updated = !periodCompleted ? { rating: o.playerElo, deviation: rdBefore, volatility: volatilityBefore }
    : updateGlicko2({ rating: o.playerElo, deviation: rdBefore,
      volatility: volatilityBefore }, results);
  const rdAfter = updated.deviation;
  const baseDelta = updated.rating - o.playerElo;
  const undo = Math.max(0, Math.floor(o.assists?.undo ?? o.undo ?? 0));
  const playerAfter = updated.rating;
  return {
    delta: playerAfter - o.playerElo, result, expected,
    playerBefore: o.playerElo, playerAfter, opponent: o.opponentElo,
    rdBefore, rdAfter, streak,
    method: 'glicko2-period-v1', volatilityBefore, volatilityAfter: updated.volatility,
    period: periodCompleted ? [] : results, periodCompleted,
    games: (o.games ?? 0) + (excluded ? 0 : 1),
    ...(excluded ? { excluded } : {}),
    ...(o.abandoned ? { abandoned: true } : {}),
    calculation: { score: result, weight: 0, ...(p ? { performance: p } : {}), undo, undoFactor: excluded ? 0 : 1, baseDelta,
      ...(o.evidence ? { evidence: o.evidence } : {}) },
  };
}

export function ratingBreakdown(r: RatingInfo): string {
  const parts = [
    `结果：${r.result === 1 ? '胜' : r.result === 0 ? '负' : '和'}`,
    `对手 Maia ${r.opponent}`,
    `预期得分率 ${(r.expected * 100).toFixed(0)}%`,
  ];
  const c = r.calculation;
  if (r.method === 'result-v2' || r.method === 'glicko2-v1' || r.method === 'glicko2-period-v1') {
    if (r.excluded) {
      parts.push(r.excluded === 'assisted' ? '辅助训练：使用了提示、悔棋或局中辅助，不计入独立棋力'
        : '训练对局：Maia 随机性不是标准值 1，不计入棋力');
      parts.push('棋力估计与不确定度保持不变');
    } else {
      const estimate = ratingEstimate(r.playerAfter, r.rdAfter, r.games ?? 0, [r.opponent]);
      parts.push(`${r.method?.startsWith('glicko2') ? 'Glicko-2：' : ''}按胜负与对手等级结算，准确率不参与加减分`,
        `${estimate.provisional ? '暂定估计' : '棋力估计'}，参考范围 ${estimate.low}–${estimate.high}`,
        `已完成 ${r.games ?? 0} 局独立计分对局`);
      if (r.method === 'glicko2-period-v1') parts.push(r.periodCompleted ? '本周期 10/10 局，已统一更新棋力'
        : `本周期 ${r.period?.length ?? 0}/10 局，再完成 ${10 - (r.period?.length ?? 0)} 局后统一更新棋力`);
      if ((r.games ?? 0) >= 10 && Math.abs(r.playerAfter - r.opponent) > 200) parts.push('建议挑战更接近当前估分的 Maia 档位，以缩小估计范围');
    }
    if (r.abandoned) parts.push('中途离开，按认输记录');
    return parts.join(' · ');
  }
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
