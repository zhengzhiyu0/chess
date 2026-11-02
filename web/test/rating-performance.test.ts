import { describe, expect, it } from 'vitest';
import {
  computeRating,
  moveDependence,
  ratingBreakdown,
  ratingEvidence,
  ratingPerformance,
  type PerformanceSample,
} from '../src/game/rating';

const base = { playerElo: 1500, opponentElo: 1500, deviation: 120, streak: 0 };

function samples(count: number, after: number, patch: Partial<PerformanceSample> = {}): PerformanceSample[] {
  return Array.from({ length: count }, () => ({ before: 50, after, ...patch }));
}

function evidenceWithDependence(dependence: number) {
  return { ...ratingEvidence([{ uci: 'e2e4' }], 0), dependence };
}

describe('评级表现与辅助证据', () => {
  it('相同结果也会按双方走子质量拉开分差', () => {
    const strongPerformance = ratingPerformance(samples(20, 50), samples(20, 45))!;
    const poorPerformance = ratingPerformance(samples(20, 20), samples(20, 45))!;
    const strong = computeRating({ ...base, result: 1, performance: strongPerformance });
    const poor = computeRating({ ...base, result: 1, performance: poorPerformance });

    expect(strongPerformance.playerAccuracy).toBeGreaterThan(poorPerformance.playerAccuracy);
    expect(strong.delta).toBeGreaterThan(poor.delta);
    expect(strong.calculation?.performance?.opponentAccuracy).toBe(poor.calculation?.performance?.opponentAccuracy);
  });

  it('强对手胜利仍有更高预期外收益，且评级不会越过低分和高分边界', () => {
    const strongOpponent = computeRating({ ...base, opponentElo: 2200, result: 1 });
    const weakOpponent = computeRating({ ...base, opponentElo: 1000, result: 1 });
    expect(strongOpponent.delta).toBeGreaterThan(weakOpponent.delta);

    const top = computeRating({ playerElo: 2600, opponentElo: 2200, deviation: 120, streak: 0, result: 1 });
    const bottom = computeRating({ playerElo: 0, opponentElo: 1000, deviation: 120, streak: 0, result: 0 });
    expect(top.playerAfter).toBe(2600);
    expect(bottom.playerAfter).toBe(0);
    expect(top.delta).toBe(0);
    expect(bottom.delta).toBe(0);
  });

  it('短局的表现证据权重较小，不会盖过胜负结果', () => {
    const shortPerformance = ratingPerformance(samples(1, 70), samples(1, 60))!;
    const longPerformance = ratingPerformance(samples(20, 70), samples(20, 60))!;
    const shortGame = computeRating({ ...base, result: 1, performance: shortPerformance });
    const longGame = computeRating({ ...base, result: 1, performance: longPerformance });

    expect(shortGame.calculation?.weight).toBeLessThan(longGame.calculation?.weight ?? 0);
    expect(shortGame.delta).toBeGreaterThan(longGame.delta);
  });

  it('强制着法和胜负已定的局面不会刷高有效准确率', () => {
    const performance = ratingPerformance(
      [
        { before: 50, after: 0, forced: true },
        { before: 98, after: 0 },
        { before: 50, after: 50 },
      ],
      [
        { before: 50, after: 50, forced: true },
        { before: 2, after: 100 },
        { before: 50, after: 50 },
      ],
    )!;

    expect(performance.playerMoves).toBe(1);
    expect(performance.opponentMoves).toBe(1);
    expect(performance.playerAccuracy).toBeGreaterThan(99);
    expect(performance.mistakes).toBe(0);
    expect(performance.blunders).toBe(0);
  });

  it('只有实际曝光且被采纳的推荐着法才提高依赖度，普通信息低于精确建议', () => {
    const hiddenBest = moveDependence({}, 'e2e4');
    const infoOnly = moveDependence({ info: true }, 'e2e4');
    const suggestionMissed = moveDependence({ hints: ['d2d4'] }, 'e2e4');
    const suggestionFollowed = moveDependence({ hints: ['e2e4'] }, 'e2e4');

    expect(hiddenBest).toBe(0);
    expect(infoOnly).toBeGreaterThan(hiddenBest);
    expect(infoOnly).toBeLessThan(suggestionFollowed);
    expect(suggestionFollowed).toBeGreaterThan(suggestionMissed);
    expect(moveDependence({ best: [] }, 'e2e4')).toBe(0);
  });

  it('分析与重复悔棋会留下可观察影响，但首悔棋不改变收益', () => {
    const noAnalysis = moveDependence({}, 'e2e4');
    const analyzed = moveDependence({ analysis: true }, 'e2e4');
    const reconsidered = moveDependence({ reconsidered: true }, 'e2e4');
    expect(analyzed).toBeGreaterThan(noAnalysis);
    expect(reconsidered).toBeGreaterThan(noAnalysis);

    const cleanWin = computeRating({ ...base, result: 1 });
    const firstUndo = computeRating({ ...base, result: 1, undo: 1 });
    const secondUndo = computeRating({ ...base, result: 1, undo: 2 });
    const manyUndos = computeRating({ ...base, result: 1, undo: 5 });
    expect(firstUndo.delta).toBe(cleanWin.delta);
    expect(secondUndo.delta).toBeLessThan(firstUndo.delta);
    expect(manyUndos.delta).toBeLessThan(secondUndo.delta);
  });

  it('评级证据区分提示总次数与最终主线的采纳次数', () => {
    const e = ratingEvidence([
      { uci: 'e2e4', evidence: { hints: ['e2e4'] } },
      { uci: 'd2d4', evidence: { hints: ['e2e4'] } },
      { uci: 'g1f3', evidence: { best: ['g1f3'] } },
      { uci: 'c2c4', evidence: { best: ['d2d4'] } },
      { uci: 'b1c3' },
    ], 7);

    expect(e).toMatchObject({
      moves: 5,
      independent: 1,
      suggested: 4,
      followed: 2,
      hints: 7,
      hintFollowed: 1,
      analysis: 0,
    });
    expect(e.dependence).toBeGreaterThan(0);
  });

  it('没有实际证据时，辅助开关或空的提示记录不会改变评级', () => {
    const noEvidence = ratingEvidence([{ uci: 'e2e4' }], 9);
    const plain = computeRating({ ...base, result: 1 });
    const switchesOnly = computeRating({ ...base, result: 1, evidence: noEvidence });

    expect(noEvidence.independent).toBe(1);
    expect(noEvidence.hints).toBe(9);
    expect(noEvidence.dependence).toBe(0);
    expect(switchesOnly.delta).toBe(plain.delta);
    expect(switchesOnly.rdAfter).toBe(plain.rdAfter);
  });

  it('越依赖辅助，胜棋加分越少但仍会结算；独立证据使定位更快收敛', () => {
    const performance = ratingPerformance(samples(20, 50), samples(20, 50))!;
    const independent = computeRating({
      ...base,
      result: 1,
      performance,
      evidence: evidenceWithDependence(0),
    });
    const dependent = computeRating({
      ...base,
      result: 1,
      performance,
      evidence: evidenceWithDependence(0.9),
    });

    expect(independent.delta).toBeGreaterThan(dependent.delta);
    expect(dependent.delta).toBeGreaterThan(0);
    expect(independent.calculation?.confidence).toBeGreaterThan(dependent.calculation?.confidence ?? 1);
    expect(independent.rdAfter).toBeLessThan(dependent.rdAfter);
  });

  it('输棋的扣分不因提示后的悔棋次数而免除', () => {
    const poorPerformance = ratingPerformance(samples(20, 80), samples(20, 50))!;
    const oneUndo = computeRating({ ...base, result: 0, performance: poorPerformance, undo: 1 });
    const manyUndos = computeRating({ ...base, result: 0, performance: poorPerformance, undo: 8 });

    expect(oneUndo.delta).toBeLessThan(0);
    expect(manyUndos.delta).toBe(oneUndo.delta);
    expect(manyUndos.playerAfter).toBe(oneUndo.playerAfter);
  });

  it('评级说明包含表现、辅助证据、悔棋和定位依据', () => {
    const performance = ratingPerformance(samples(20, 50), samples(20, 60))!;
    const e = ratingEvidence([{ uci: 'e2e4', evidence: { hints: ['e2e4'] } }], 3);
    const rating = computeRating({ ...base, result: 1, performance, evidence: e, undo: 2 });
    const breakdown = ratingBreakdown(rating);

    for (const phrase of ['有效着法', '准确率', '提示展示 3 次', '最终主线采纳 1 步', '悔棋 2 次', '扣分不减免', '不确定度']) {
      expect(breakdown).toContain(phrase);
    }
  });
});
