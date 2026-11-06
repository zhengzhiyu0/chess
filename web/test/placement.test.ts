import { describe, expect, it } from 'vitest';
import { placementRecommendation } from '../src/game/placement';

const base = { rating: 1500, deviation: 350, games: 0, period: [], experience: 'unknown' as const,
  levels: [600, 800, 1000, 1200, 1400, 1500, 1600, 1800, 2000, 2200, 2400, 2600] };
describe('opponent recommendations are separate from Glicko-2', () => {
  it('never mistakes an unknown player’s 1500 prior for measured skill', () => {
    expect(placementRecommendation(base).opponent).toBe(600);
    expect(placementRecommendation({ ...base, experience: 'skip' }).opponent).toBe(600);
    expect(placementRecommendation({ ...base, experience: 'casual' }).opponent).toBe(1000);
    expect(placementRecommendation({ ...base, experience: 'regular' }).opponent).toBe(1500);
    expect(base.rating).toBe(1500);
  });
  it('suggests at most one step after two results at the same level', () => {
    const period = [0, 0].map(score => ({ rating: 1000, deviation: 0, score }));
    expect(placementRecommendation({ ...base, games: 2, period }).opponent).toBe(800);
    expect(placementRecommendation({ ...base, games: 2, period: period.map(r => ({ ...r, score: 1 })) }).opponent).toBe(1200);
    expect(placementRecommendation({ ...base, games: 1, period: period.slice(0, 1) }).opponent).toBe(1000);
    expect(placementRecommendation({ ...base, games: 2, period: [period[0], { rating: 800, deviation: 0, score: 0 }] }).opponent).toBe(800);
  });
  it('keeps mixed results and range boundaries stable and uses established ratings', () => {
    expect(placementRecommendation({ ...base, games: 2, period: [1, 0].map(score => ({ rating: 600, deviation: 0, score })) }).opponent).toBe(600);
    expect(placementRecommendation({ ...base, games: 20, deviation: 80, rating: 771 }).opponent).toBe(800);
  });
  it('retains recent evidence across the ten-game period boundary', () => {
    const recent = [0, 0].map(score => ({ rating: 600, deviation: 0, score }));
    expect(placementRecommendation({ ...base, games: 10, deviation: 170, recent }).opponent).toBe(600);
    expect(placementRecommendation({ ...base, games: 10, deviation: 170,
      recent: recent.map(r => ({ ...r, rating: 1000 })) }).opponent).toBe(800);
  });
});
