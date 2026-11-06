import { describe, expect, it } from 'vitest';
import type { Glicko2Result } from '../src/game/glicko2';
import { computeRating, ratingEstimate } from '../src/game/rating';

// Synthetic logistic opponents test the estimator, not the strength calibration of real Maia.
function simulate(skill: number, adaptive: boolean, startingRating = 1500, gameCount = 100) {
  let seed = 42;
  const random = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32);
  const estimates: number[] = [];
  let covered = 0;
  for (let run = 0; run < 300; run++) {
    let elo = startingRating;
    let rd = 350;
    let volatility = 0.06;
    let period: Glicko2Result[] = [];
    for (let games = 0; games < gameCount; games++) {
      const opponent = adaptive ? Math.max(600, Math.min(2400, Math.round(elo / 200) * 200)) : 600;
      const result = random() < 1 / (1 + 10 ** ((opponent - skill) / 400)) ? 1 : 0;
      const r = computeRating({ playerElo: elo, opponentElo: opponent, deviation: rd, volatility, period, streak: 0, games, result });
      elo = r.playerAfter;
      rd = r.rdAfter;
      volatility = r.volatilityAfter!;
      period = r.period!;
    }
    estimates.push(elo);
    const range = ratingEstimate(elo, rd, gameCount, [600, 800, 1000]);
    if (skill >= range.low && skill <= range.high) covered++;
  }
  return { mean: estimates.reduce((a, b) => a + b, 0) / estimates.length, coverage: covered / estimates.length };
}

describe('result-only estimator simulations', () => {
  it('fixed Maia 600 with a 75% expected score converges above 600 without an artificial ceiling', () => {
    const skill = 600 + 400 * Math.log10(3);
    const stats = simulate(skill, false);
    expect(Math.abs(stats.mean - skill)).toBeLessThan(30);
    expect(stats.coverage).toBeGreaterThan(0.9);
  });

  it('long-run estimates converge from the official prior; this is not a short-placement accuracy guarantee', () => {
    for (const skill of [600, 1000, 1600]) {
      const stats = simulate(skill, true, 1500, 1000);
      expect(Math.abs(stats.mean - skill)).toBeLessThan(35);
      expect(stats.coverage).toBeGreaterThan(0.9);
    }
  });
});
