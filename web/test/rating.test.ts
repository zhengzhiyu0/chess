import { describe, expect, it } from 'vitest';
import { assistCount, computeRating, emptyAssists } from '../src/game/rating';

describe('独立棋力评级', () => {
  const base = { playerElo: 1500, opponentElo: 1500, deviation: 80, streak: 0 };

  it('相同分数的新玩家单局定位符合已知数值基准', () => {
    const loss = computeRating({ ...base, deviation: 350, result: 0 });
    expect(loss.playerAfter).toBe(1325);
    expect(loss.rdAfter).toBeCloseTo(246.575715, 5);
    expect(computeRating({ ...base, deviation: 350, result: 1 }).playerAfter).toBe(1675);
  });

  it('战胜强手收益更多，负于弱手损失更多', () => {
    const strongWin = computeRating({ ...base, opponentElo: 1800, result: 1 });
    const weakWin = computeRating({ ...base, opponentElo: 1200, result: 1 });
    expect(strongWin.delta).toBeGreaterThan(weakWin.delta);
    expect(weakWin.delta).toBeGreaterThan(0);
    expect(strongWin.expected).toBeLessThan(weakWin.expected);
    const strongLoss = computeRating({ ...base, opponentElo: 1800, result: 0 });
    const weakLoss = computeRating({ ...base, opponentElo: 1200, result: 0 });
    expect(weakLoss.delta).toBeLessThan(strongLoss.delta);
    expect(strongLoss.delta).toBeLessThan(0);
  });

  it('和棋取决于对手强弱，并清除连胜负', () => {
    expect(computeRating({ ...base, result: 0.5 }).delta).toBe(0);
    expect(computeRating({ ...base, opponentElo: 1800, result: 0.5 }).delta).toBeGreaterThan(0);
    expect(computeRating({ ...base, opponentElo: 1200, result: 0.5 }).delta).toBeLessThan(0);
    const draw = computeRating({ ...base, streak: 7, result: 0.5 });
    expect(draw.streak).toBe(0);
    expect(draw.rdBefore).toBe(80);
  });

  it('定位阶段调整更快，交替胜负逐渐稳定', () => {
    expect(computeRating({ ...base, deviation: 350, result: 1 }).delta)
      .toBeGreaterThan(computeRating({ ...base, result: 1 }).delta);
    let playerElo = 1500;
    let deviation = 350;
    let streak = 0;
    for (let i = 0; i < 40; i++) {
      const r = computeRating({ playerElo, opponentElo: playerElo, deviation, streak, result: i % 2 === 0 ? 1 : 0 });
      expect(Math.abs(r.streak)).toBe(1);
      expect(r.rdAfter).toBeLessThanOrEqual(deviation);
      playerElo = r.playerAfter;
      deviation = r.rdAfter;
      streak = r.streak;
    }
    expect(deviation).toBeLessThan(100);
    expect(deviation).toBeGreaterThanOrEqual(60);
  });

  it('第三次同向结果重新定位，反向结果重置连胜负', () => {
    for (const direction of [-1, 1]) {
      const result = direction === 1 ? 1 : 0;
      const second = computeRating({ ...base, streak: direction, result });
      const third = computeRating({ ...base, streak: direction * 2, result });
      expect(second.rdBefore).toBe(80);
      expect(third.rdBefore).toBe(180);
      expect(Math.abs(third.delta)).toBeGreaterThan(Math.abs(second.delta));
      expect(third.streak).toBe(direction * 3);
      expect(computeRating({ ...base, streak: direction * 6, result: 1 - result }).streak).toBe(-direction);
    }
  });

  it('分数、不确定度和连胜负保持边界，delta是实际变化', () => {
    for (const [playerElo, result, streak] of [[2600, 1, 8], [0, 0, -8]]) {
      const r = computeRating({ playerElo, opponentElo: playerElo, deviation: 999, streak, result });
      expect(r.playerAfter).toBe(playerElo);
      expect(r.delta).toBe(0);
      expect(r.streak).toBe(streak);
      expect(r.rdBefore).toBe(350);
      expect(r.rdAfter).toBeLessThanOrEqual(350);
    }
    const low = computeRating({ ...base, deviation: 1, result: 0.5 });
    expect(low.rdBefore).toBe(60);
    expect(low.rdAfter).toBe(60);
    const win = computeRating({ ...base, result: 1 });
    expect(win.delta).toBe(win.playerAfter - win.playerBefore);
  });

  it('放弃仅按认输，不额外处罚', () => {
    const loss = computeRating({ ...base, result: 0 });
    const abandoned = computeRating({ ...base, result: 1, abandoned: true });
    expect(abandoned).toEqual({ ...loss, abandoned: true });
  });


  it('保留辅助使用记录但不参与评级', () => {
    expect(assistCount(undefined)).toBe(0);
    expect(assistCount(emptyAssists())).toBe(0);
    expect(emptyAssists()).toEqual({ undo: 0, hint: 0 });
    expect(assistCount({ undo: 3, hint: 1, aids: true, best: true })).toBe(6);
  });
});
