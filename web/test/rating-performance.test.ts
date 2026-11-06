import { describe, expect, it } from 'vitest';
import {
  computeRating,
  moveDependence,
  ratingBreakdown,
  ratingEvidence,
  ratingPerformance,
  type PerformanceSample,
} from '../src/game/rating';

const base = { playerElo: 1500, opponentElo: 1500, deviation: 120, streak: 0, games: 19, period: Array.from({ length: 9 }, () => ({ rating: 1500, deviation: 0, score: 0.5 })) };

function samples(count: number, after: number, patch: Partial<PerformanceSample> = {}): PerformanceSample[] {
  return Array.from({ length: count }, () => ({ before: 50, after, ...patch }));
}

function evidenceWithDependence(dependence: number) {
  return { ...ratingEvidence([{ uci: 'e2e4' }], 0), dependence };
}

describe('评级表现与辅助证据', () => {
  it('准确率不改变相同胜负的估分', () => {
    const strongPerformance = ratingPerformance(samples(20, 50), samples(20, 45))!;
    const poorPerformance = ratingPerformance(samples(20, 20), samples(20, 45))!;
    const strong = computeRating({ ...base, result: 1, performance: strongPerformance });
    const poor = computeRating({ ...base, result: 1, performance: poorPerformance });

    expect(strongPerformance.playerAccuracy).toBeGreaterThan(poorPerformance.playerAccuracy);
    expect(strong.delta).toBe(poor.delta);
    expect(strong.calculation?.performance?.opponentAccuracy).toBe(poor.calculation?.performance?.opponentAccuracy);
  });

  it('stronger wins contribute more and player ratings have no artificial bounds', () => {
    expect(computeRating({ ...base, opponentElo: 2200, result: 1 }).delta)
      .toBeGreaterThan(computeRating({ ...base, opponentElo: 1000, result: 1 }).delta);
    for (const [playerElo, result] of [[2600, 1], [0, 0]]) {
      const period = Array.from({ length: 9 }, () => ({ rating: playerElo, deviation: 0, score: result }));
      const r = computeRating({ ...base, playerElo, opponentElo: playerElo, result, period });
      expect(result ? r.playerAfter > 2600 : r.playerAfter < 0).toBe(true);
      expect(r.delta).toBe(r.playerAfter - playerElo);
    }
  });

  it('有效着法数量不改变结果权重', () => {
    const shortPerformance = ratingPerformance(samples(1, 70), samples(1, 60))!;
    const longPerformance = ratingPerformance(samples(20, 70), samples(20, 60))!;
    const shortGame = computeRating({ ...base, result: 1, performance: shortPerformance });
    const longGame = computeRating({ ...base, result: 1, performance: longPerformance });

    expect(shortGame.calculation?.weight).toBe(0);
    expect(shortGame.delta).toBe(longGame.delta);
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

  it('首次悔棋即转为训练，无论次数都不更新独立棋力', () => {
    for (const result of [0, 0.5, 1]) {
      for (const undo of [1, 2, 8]) {
        expect(computeRating({ ...base, games: 7, result, undo }))
          .toMatchObject({ excluded: 'assisted', delta: 0, rdAfter: base.deviation, games: 7 });
      }
    }
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
    const noEvidence = ratingEvidence([{ uci: 'e2e4' }], 0);
    const plain = computeRating({ ...base, result: 1 });
    const switchesOnly = computeRating({ ...base, result: 1, evidence: noEvidence });

    expect(noEvidence.independent).toBe(1);
    expect(noEvidence.hints).toBe(0);
    expect(noEvidence.dependence).toBe(0);
    expect(switchesOnly.delta).toBe(plain.delta);
    expect(switchesOnly.rdAfter).toBe(plain.rdAfter);
  });

  it('局势信息、推荐或局中分析均排除计分，包括未采纳的建议', () => {
    for (const evidence of [evidenceWithDependence(0.9), ratingEvidence([{ uci: 'e2e4', evidence: { info: true } }], 0),
      ratingEvidence([{ uci: 'e2e4', evidence: { hints: ['d2d4'] } }], 1),
      ratingEvidence([{ uci: 'e2e4', evidence: { analysis: true } }], 0)]) {
      for (const result of [0, 1]) {
        expect(computeRating({ ...base, result, evidence }))
          .toMatchObject({ excluded: 'assisted', delta: 0, rdAfter: base.deviation });
      }
    }
  });

  it('被删除分支的曝光记录、提示次数与标准采样资格都保留', () => {
    expect(computeRating({ ...base, result: 1, assists: { undo: 0, hint: 0, positions: { deleted: { best: ['e2e4'] } } } }).excluded).toBe('assisted');
    expect(computeRating({ ...base, result: 1, assists: { undo: 0, hint: 1 } }).excluded).toBe('assisted');
    for (const result of [0, 1]) {
      expect(computeRating({ ...base, result, temperature: 0.8 })).toMatchObject({ excluded: 'sampling', delta: 0, rdAfter: 120 });
      expect(computeRating({ ...base, result, temperature: 1 }).excluded).toBeUndefined();
    }
  });

  it('新版说明解释独立估分与训练排除，历史仍保留旧说明', () => {
    const clean = computeRating({ ...base, result: 1 });
    for (const phrase of ['准确率不参与', '参考范围', '独立计分']) expect(ratingBreakdown(clean)).toContain(phrase);
    const assisted = computeRating({ ...base, result: 1, undo: 1 });
    expect(ratingBreakdown(assisted)).toContain('辅助训练');
    expect(ratingBreakdown(assisted)).toContain('保持不变');
    const legacy = { ...clean, method: undefined, calculation: { ...clean.calculation!, undo: 1 } };
    expect(ratingBreakdown(legacy)).toContain('首次容错');
  });
});
