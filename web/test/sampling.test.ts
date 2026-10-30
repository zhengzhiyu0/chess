import { describe, expect, it } from 'vitest';
import { sampleMove, samplingDistribution, softmaxMoves } from '../src/maia/sample';

const policy = () => softmaxMoves([
  { uci: 'e2e4', logit: Math.log(0.5) },
  { uci: 'd2d4', logit: Math.log(0.3) },
  { uci: 'g1f3', logit: Math.log(0.2) },
]);

describe('samplingDistribution', () => {
  it('normalizes actual temperature probabilities while preserving original logits and input', () => {
    const moves = policy();
    const snapshot = structuredClone(moves);
    const distribution = samplingDistribution(moves, 0.5, 1);
    expect(distribution.reduce((sum, move) => sum + move.p, 0)).toBeCloseTo(1, 14);
    const squaredTotal = 0.25 + 0.09 + 0.04;
    distribution.forEach((move, i) => {
      expect(move.logit).toBe(moves[i].logit);
      expect(move.p).toBeCloseTo(moves[i].p ** 2 / squaredTotal, 14);
    });
    expect(moves).toEqual(snapshot);
    expect(samplingDistribution(moves, 1, 1)).toEqual(moves);
  });

  it('includes the crossing move, excludes the tail, then renormalizes', () => {
    const distribution = samplingDistribution(policy(), 1, 0.7);
    expect(distribution.map((move) => move.uci)).toEqual(['e2e4', 'd2d4']);
    expect(distribution[0].p).toBeCloseTo(0.625, 14);
    expect(distribution[1].p).toBeCloseTo(0.375, 14);
    expect(distribution.reduce((sum, move) => sum + move.p, 0)).toBeCloseTo(1, 14);
    expect(samplingDistribution(policy(), 1, 0.01)).toEqual([{ ...policy()[0], p: 1 }]);
    expect(samplingDistribution(policy(), 1, 0).length).toBe(1);
  });

  it('stops at an exact threshold and retains all moves for Top-P 1', () => {
    const equal = softmaxMoves([{ uci: 'a', logit: 0 }, { uci: 'b', logit: 0 }]);
    expect(samplingDistribution(equal, 1, 0.5)).toEqual([{ ...equal[0], p: 1 }]);
    expect(samplingDistribution(equal, 1, 1)).toEqual(equal);
  });

  it('uses logit argmax at temperature zero regardless of stale raw p or Top-P', () => {
    const moves = [
      { uci: 'a', logit: 1, p: 0.9 },
      { uci: 'b', logit: 3, p: 0.01 },
      { uci: 'c', logit: 2, p: 0.09 },
    ];
    expect(samplingDistribution(moves, 0, 0)).toEqual([{ ...moves[1], p: 1 }]);
    const neverDraw = () => { throw new Error('argmax must not draw randomness'); };
    expect(sampleMove(moves, 0, 1, neverDraw)).toBe(moves[1]);
  });

  it('keeps the first tied argmax and handles empty distributions explicitly', () => {
    const tied = [{ uci: 'a', logit: 3, p: 0.5 }, { uci: 'b', logit: 3, p: 0.5 }];
    expect(samplingDistribution(tied, 0, 1)[0].uci).toBe('a');
    expect(samplingDistribution([], 1, 1)).toEqual([]);
    expect(() => sampleMove([], 1, 1)).toThrow('empty move list');
  });

  it('remains numerically stable at very small positive temperatures', () => {
    const moves = [{ uci: 'a', logit: 1000, p: 0.6 }, { uci: 'b', logit: 999, p: 0.4 }];
    const distribution = samplingDistribution(moves, Number.MIN_VALUE, 1);
    expect(distribution.map((move) => move.p)).toEqual([1, 0]);
    expect(sampleMove(moves, Number.MIN_VALUE, 1, () => 0)).toBe(moves[0]);
  });

  it('rejects non-finite sampling controls', () => {
    expect(() => samplingDistribution(policy(), NaN, 1)).toThrow('finite');
    expect(() => samplingDistribution(policy(), 1, NaN)).toThrow('finite');
    expect(() => samplingDistribution(policy(), Infinity, 1)).toThrow('finite');
  });
});

describe('sampleMove shared distribution', () => {
  it('samples the adjusted distribution but returns the original object and raw p', () => {
    const moves = policy();
    const distribution = samplingDistribution(moves, 1, 0.7);
    expect(sampleMove(moves, 1, 0.7, () => 0)).toBe(moves[0]);
    expect(sampleMove(moves, 1, 0.7, () => distribution[0].p + 1e-6)).toBe(moves[1]);
    const picked = sampleMove(moves, 1, 0.7, () => 0.999999);
    expect(picked).toBe(moves[1]);
    expect(picked.p).toBeCloseTo(0.3, 14);
    expect(picked.logit).toBe(Math.log(0.3));
  });

  it('agrees with actual probabilities across deterministic uniform draws', () => {
    const moves = policy();
    for (const [temperature, topP] of [[1, 1], [0.5, 1], [1, 0.7]]) {
      const expected = samplingDistribution(moves, temperature, topP);
      const counts = new Map<string, number>();
      const draws = 10_000;
      for (let i = 0; i < draws; i++) {
        const picked = sampleMove(moves, temperature, topP, () => (i + 0.5) / draws);
        counts.set(picked.uci, (counts.get(picked.uci) ?? 0) + 1);
      }
      for (const move of moves) {
        const p = expected.find((candidate) => candidate.uci === move.uci)?.p ?? 0;
        expect(Math.abs((counts.get(move.uci) ?? 0) / draws - p)).toBeLessThanOrEqual(1 / draws);
      }
    }
  });
});
