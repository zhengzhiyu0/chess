import { describe, expect, it } from 'vitest';
import { updateGlicko2 } from '../src/game/glicko2';

describe('Glicko-2 official specification', () => {
  it('matches Glickman’s three-opponent worked example', () => {
    const next = updateGlicko2({ rating: 1500, deviation: 200, volatility: 0.06 }, [
      { rating: 1400, deviation: 30, score: 1 },
      { rating: 1550, deviation: 100, score: 0 },
      { rating: 1700, deviation: 300, score: 0 },
    ]);
    expect(next.rating).toBeCloseTo(1464.050671, 5);
    expect(next.deviation).toBeCloseTo(151.516524, 5);
    expect(next.volatility).toBeCloseTo(0.059995984, 8);
  });

  it('an empty period increases uncertainty without changing rating or volatility', () => {
    const next = updateGlicko2({ rating: 1400, deviation: 70, volatility: 0.06 }, []);
    expect(next.rating).toBe(1400);
    expect(next.volatility).toBe(0.06);
    expect(next.deviation).toBeCloseTo(Math.hypot(70, 173.7178 * 0.06));
  });

  it('uncertain opponents contribute less information than fixed anchors', () => {
    const state = { rating: 1500, deviation: 200, volatility: 0.06 };
    const fixed = updateGlicko2(state, [{ rating: 1500, deviation: 0, score: 1 }]);
    const uncertain = updateGlicko2(state, [{ rating: 1500, deviation: 350, score: 1 }]);
    expect(uncertain.deviation).toBeGreaterThan(fixed.deviation);
    expect(uncertain.rating).toBeLessThan(fixed.rating);
  });

  it('stable but surprising performances exercise the alternate volatility bracket', () => {
    const state = { rating: 1000, deviation: 30, volatility: 0.06 };
    const next = updateGlicko2(state, Array.from({ length: 12 }, () => ({ rating: 2000, deviation: 30, score: 1 })));
    expect(next.volatility).toBeGreaterThan(state.volatility);
    expect(Number.isFinite(next.rating)).toBe(true);
    expect(Number.isFinite(next.deviation)).toBe(true);
  });
});
