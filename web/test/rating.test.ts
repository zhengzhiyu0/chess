import { describe, expect, it } from 'vitest';
import { computeRating, ratingBreakdown, ratingEstimate } from '../src/game/rating';
import { updateGlicko2, type Glicko2Result } from '../src/game/glicko2';

const base = { playerElo: 1500, opponentElo: 1500, deviation: 350, volatility: 0.06, streak: 0 };
const draws = (n: number): Glicko2Result[] => Array.from({ length: n }, () => ({ rating: 1500, deviation: 0, score: 0.5 }));

describe('10-game Glicko-2 rating periods', () => {
  it('holds rating, RD and volatility for games one through nine and updates all ten together', () => {
    let period: Glicko2Result[] = [];
    for (let games = 0; games < 9; games++) {
      const r = computeRating({ ...base, result: 1, games, period });
      expect(r).toMatchObject({ playerAfter: 1500, rdAfter: 350, volatilityAfter: 0.06, games: games + 1, periodCompleted: false });
      expect(r.period).toHaveLength(games + 1);
      period = r.period!;
    }
    const r = computeRating({ ...base, result: 0, games: 9, period });
    const expected = updateGlicko2({ rating: 1500, deviation: 350, volatility: 0.06 }, [...period, { rating: 1500, deviation: 0, score: 0 }]);
    expect(r).toMatchObject({ method: 'glicko2-period-v1', period: [], periodCompleted: true, games: 10 });
    expect(r.playerAfter).toBe(expected.rating);
    expect(r.rdAfter).toBe(expected.deviation);
    expect(r.volatilityAfter).toBe(expected.volatility);
    expect(ratingBreakdown(r)).toContain('10/10');
  });

  it('uses each opponent and result in the period, independent of result order', () => {
    const prior = [...draws(7), { rating: 1800, deviation: 0, score: 1 }, { rating: 1200, deviation: 0, score: 0 }];
    const a = computeRating({ ...base, games: 19, period: prior, result: 0.5 });
    const b = computeRating({ ...base, games: 19, period: [...prior].reverse(), result: 0.5 });
    expect(a.playerAfter).toBe(b.playerAfter);
    expect(a.rdAfter).toBeCloseTo(b.rdAfter, 10);
    expect(a.volatilityAfter).toBeCloseTo(b.volatilityAfter!, 10);
  });

  it('training wins and losses preserve a nine-game period and all rating state', () => {
    for (const result of [0, 1]) for (const patch of [{ undo: 1 }, { temperature: 0.8 }, { assists: { undo: 0, hint: 1 } }]) {
      const r = computeRating({ ...base, deviation: 80, games: 19, period: draws(9), result, ...patch });
      expect(r).toMatchObject({ playerAfter: 1500, rdAfter: 80, volatilityAfter: 0.06, games: 19, periodCompleted: false, delta: 0 });
      expect(r.period).toEqual(draws(9));
    }
  });

  it('starts a new period from the settled state and carries volatility', () => {
    const settled = computeRating({ ...base, result: 1, games: 9, period: draws(9) });
    const next = computeRating({ ...base, playerElo: settled.playerAfter, deviation: settled.rdAfter,
      volatility: settled.volatilityAfter, games: 10, period: settled.period, result: 0 });
    expect(next.playerAfter).toBe(settled.playerAfter);
    expect(next.rdAfter).toBe(settled.rdAfter);
    expect(next.volatilityAfter).toBe(settled.volatilityAfter);
    expect(next.period).toHaveLength(1);
    expect(ratingBreakdown(next)).toContain('1/10');
  });

  it('streak count does not change the batch calculation and abandonment is an ordinary loss', () => {
    const loss = computeRating({ ...base, result: 0, games: 9, period: draws(9) });
    expect(computeRating({ ...base, result: 1, abandoned: true, games: 9, period: draws(9) })).toEqual({ ...loss, abandoned: true });
    expect(computeRating({ ...base, result: 0, games: 9, period: draws(9), streak: 8 }).playerAfter).toBe(loss.playerAfter);
  });

  it('keeps the rating range and opponent recommendation explicit', () => {
    expect(ratingEstimate(771, 143, 4, [600, 800, 1000])).toEqual({ low: 480, high: 1060, opponent: 800, provisional: true });
  });

  it('preserves fractional state across periods and never resets RD from the game count', () => {
    const state = { ...base, playerElo: 1512.3456789, deviation: 0.8, volatility: 0.047123 };
    const results = [...draws(9), { rating: 1500, deviation: 0, score: 1 }];
    const expected = updateGlicko2({ rating: state.playerElo, deviation: state.deviation, volatility: state.volatility }, results);
    const r = computeRating({ ...state, games: 9, period: draws(9), result: 1 });
    expect(r.playerAfter).toBe(expected.rating);
    expect(r.rdAfter).toBe(expected.deviation);
    expect(r.volatilityAfter).toBe(expected.volatility);
    expect(ratingEstimate(2800, 400, 20, [600, 2600])).toMatchObject({ low: 2000, high: 3600 });
  });
});
