import { describe, expect, it } from 'vitest';
import { Chess } from 'chess.js';
import { classify, type MoveContext } from '../src/coach/coach';
import { identifyOpening, inBook, loadBook, openingOf } from '../src/coach/book';
import { openingZh } from '../src/coach/opening-zh';
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
  it('identifies the deepest named opening along a move path', async () => {
    await loadBook();
    const c = new Chess();
    const fens = [c.fen()];
    for (const san of ['e4', 'e5', 'Nf3', 'Nc6', 'Bb5']) {
      c.move(san);
      fens.push(c.fen());
    }
    expect(inBook('r1bqkbnr/pppp1ppp/2n5/1B2p3/4P3/5N2/PPPP1PPP/RNBQK2R b KQkq - 3 3')).toBe(true);
    expect(openingOf(fens.at(-1)!)).toEqual({ eco: 'C60', name: 'Ruy Lopez' });
    expect(identifyOpening(fens)).toEqual({ eco: 'C60', name: 'Ruy Lopez' });
  });

  it('keeps the last named opening after leaving the book', async () => {
    await loadBook();
    const c = new Chess();
    const fens = [c.fen()];
    for (const san of ['e4', 'e5', 'Nf3', 'Nc6', 'Bb5']) {
      c.move(san);
      fens.push(c.fen());
    }
    // 末局面不在开局库里：识别应回退到路径上最近一次命中，而不是报“未识别”。
    fens.push('8/8/8/4k3/8/8/4K3/8 w - - 0 1');
    expect(identifyOpening(fens)).toEqual({ eco: 'C60', name: 'Ruy Lopez' });
  });

  it('does not name an unrelated position', async () => {
    await loadBook();
    expect(identifyOpening(['8/8/8/4k3/8/8/4K3/8 w - - 0 1'])).toBeNull();
  });

  it('shows a Chinese family name and falls back to English', () => {
    expect(openingZh('Ruy Lopez: Berlin Defense')).toBe('西班牙开局');
    expect(openingZh('Sicilian Defense: Najdorf Variation')).toBe('西西里防御');
    expect(openingZh('French Defense, Classical, 4. Bg5')).toBe('法兰西防御');
    expect(openingZh('Totally Unknown Opening')).toBeNull();
  });

  it('translates every opening family in the book', async () => {
    const raw = (await import('../src/coach/book-data')).default;
    const families = new Set(raw.names.map((value) => value.slice(value.indexOf('\t') + 1).split(':')[0].trim()));
    expect([...families].filter((family) => !openingZh(family))).toEqual([]);
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
  it('describes castling', () => {
    const m = moveFxOf('r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1', 'e1g1')!;
    expect(m.rook).toEqual({ from: 'h1', to: 'f1' });
  });
});
