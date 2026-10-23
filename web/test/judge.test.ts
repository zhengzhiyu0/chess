import { describe, expect, it } from 'vitest';
import { classify, type MoveContext } from '../src/coach/coach';
import { inBook, loadBook } from '../src/coach/book';
import { isSacrifice } from '../src/coach/explain';
import { moveFxOf } from '../src/app/fx';

const base: MoveContext = { before: 50, after: 50, playedBest: true, book: false, forced: false, sacrifice: false };

describe('classify', () => {
  it('keeps the Lichess thresholds (5/10/15 win% = .1/.2/.3 winning chances)', () => {
    expect(classify({ ...base, before: 80, after: 45, playedBest: false })).toBe('blunder');
    expect(classify({ ...base, before: 60, after: 45, playedBest: false })).toBe('blunder');
    expect(classify({ ...base, before: 60, after: 50, playedBest: false })).toBe('mistake');
    expect(classify({ ...base, before: 60, after: 55, playedBest: false })).toBe('inaccuracy');
    expect(classify({ ...base, before: 60, after: 56, playedBest: false })).toBe('good');
    expect(classify(base)).toBe('best');
  });
  it('book and forced win over the eval', () => {
    expect(classify({ ...base, book: true })).toBe('book');
    expect(classify({ ...base, forced: true, before: 80, after: 20 })).toBe('forced');
  });
  it('sound sacrifice is brilliant, an unsound one is not', () => {
    expect(classify({ ...base, sacrifice: true, before: 55, after: 56 })).toBe('brilliant');
    expect(classify({ ...base, sacrifice: true, before: 55, after: 48, playedBest: false })).toBe('inaccuracy');
    expect(classify({ ...base, sacrifice: true, before: 99, after: 99 })).toBe('best');
  });
  it('only move and punishing a mistake are great; failing to punish is a miss', () => {
    expect(classify({ ...base, secondGap: 25, after: 55 })).toBe('great');
    expect(classify({ ...base, oppDrop: 12, before: 75, after: 75 })).toBe('great');
    expect(classify({ ...base, oppDrop: 8, before: 75, after: 75 })).toBe('best');
    expect(classify({ ...base, oppDrop: 12, before: 75, after: 63, playedBest: false })).toBe('miss');
    expect(classify({ ...base, oppDrop: 12, before: 75, after: 55, playedBest: false })).toBe('blunder');
  });
});

describe('opening book', () => {
  it('knows the Ruy Lopez but not a random position', async () => {
    await loadBook();
    expect(inBook('r1bqkbnr/pppp1ppp/2n5/1B2p3/4P3/5N2/PPPP1PPP/RNBQK2R b KQkq - 3 3')).toBe(true);
    expect(inBook('8/8/8/4k3/8/8/4K3/8 w - - 0 1')).toBe(false);
  });
});

describe('isSacrifice', () => {
  it('Bxh7+ Greek gift is a sacrifice, a plain developing move is not', () => {
    expect(isSacrifice('rnbq1rk1/pppn1ppp/4p3/3pP3/1b1P4/2NB1N2/PPP2PPP/R1BQK2R w KQ - 0 7', 'd3h7')).toBe(true);
    expect(isSacrifice('rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1', 'g8f6')).toBe(false);
  });
  it('trading up is not a sacrifice', () => {
    // Rxd8: rook takes queen, recaptured
    expect(isSacrifice('3qk3/8/8/8/8/8/8/3RK3 w - - 0 1', 'd1d8')).toBe(false);
  });
});

describe('moveFxOf', () => {
  it('describes castling and attack paths', () => {
    const m = moveFxOf('r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1', 'e1g1')!;
    expect(m.rook).toEqual({ from: 'h1', to: 'f1' });
    const f = moveFxOf('4k3/8/8/8/3q4/8/8/4K1N1 w - - 0 1', 'g1e2')!;
    expect(f.attacks).toContain('d4');
  });
});
