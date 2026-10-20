import { describe, expect, it } from 'vitest';
import { GameTree } from '../src/game/tree';
import { exportPgn, fmtClock, parseClock, parsePgn } from '../src/game/pgn';
import { START_FEN, canMate, isThreefold, pvToSan, sanOf, terminalOf, timeoutResult } from '../src/game/rules';
import { ChessClock, fmtClockShort, pgnTimeControl, thinkBudget, timeControlOf } from '../src/game/clock';
import { computeStats, mainlineLength, outcomeOf, upsert, type StoredGame } from '../src/game/history';

const lineOf = (tree: GameTree, ...ucis: string[]) => {
  let n = tree.root;
  for (const u of ucis) n = tree.add(n, u)!;
  return n;
};

describe('rules', () => {
  it('converts UCI to SAN', () => {
    expect(sanOf(START_FEN, 'g1f3')).toBe('Nf3');
    expect(pvToSan(START_FEN, ['e2e4', 'e7e5', 'g1f3'])).toBe('1. e4 e5 2. Nf3');
  });

  it('detects checkmate and stalemate', () => {
    const t = new GameTree(START_FEN);
    const mate = lineOf(t, 'f2f3', 'e7e5', 'g2g4', 'd8h4');
    expect(terminalOf(t.pathTo(mate).map((n) => n.fen))).toEqual({ result: '0-1', reason: 'checkmate' });
    expect(terminalOf(['7k/5Q2/6K1/8/8/8/8/8 b - - 0 1'])).toEqual({ result: '1/2-1/2', reason: 'stalemate' });
    expect(terminalOf(['8/8/4k3/8/8/3K4/8/8 w - - 0 1'])?.reason).toBe('insufficient');
  });

  it('detects threefold repetition over the line', () => {
    const t = new GameTree(START_FEN);
    const shuffle = ['g1f3', 'g8f6', 'f3g1', 'f6g8'];
    const n = lineOf(t, ...shuffle, ...shuffle);
    const fens = t.pathTo(n).map((x) => x.fen);
    expect(isThreefold(fens)).toBe(true);
    expect(isThreefold(fens.slice(0, -1))).toBe(false);
    expect(terminalOf(fens)?.reason).toBe('threefold');
  });

  it('scores a flag fall as a draw when the winner cannot mate', () => {
    const kn = '8/8/4k3/8/8/3K4/8/6N1 w - - 0 1';
    expect(canMate(kn, 'w')).toBe(false);
    expect(timeoutResult(kn, 'b')).toBe('1/2-1/2');
    expect(timeoutResult(kn, 'w')).toBe('1/2-1/2');
    expect(timeoutResult(START_FEN, 'w')).toBe('0-1');
    expect(timeoutResult(START_FEN, 'b')).toBe('1-0');
  });
});

describe('GameTree', () => {
  it('reuses existing moves and keeps variations', () => {
    const t = new GameTree(START_FEN);
    const e4 = t.add(t.root, 'e2e4')!;
    expect(t.add(t.root, 'e2e4')).toBe(e4);
    const d4 = t.add(t.root, 'd2d4')!;
    expect(t.add(t.root, 'e2e5')).toBeNull();
    expect(t.root.children).toEqual([e4, d4]);
    expect(t.isMainline(e4)).toBe(true);
    expect(t.isMainline(d4)).toBe(false);
    t.makeMainline(d4);
    expect(t.root.children[0]).toBe(d4);
    t.remove(e4);
    expect(t.root.children).toEqual([d4]);
  });

  it('serializes and restores comments, NAGs and clocks', () => {
    const t = new GameTree(START_FEN);
    const e5 = lineOf(t, 'e2e4', 'e7e5');
    e5.comment = 'open game';
    e5.nags = [1];
    e5.clock = [60000, 59000];
    t.add(t.root.children[0], 'c7c5');
    const s = t.serialize();
    expect(mainlineLength(s)).toBe(2);
    const back = GameTree.deserialize(START_FEN, JSON.parse(JSON.stringify(s)));
    const ml = back.mainline();
    expect(ml.map((n) => n.san)).toEqual(['', 'e4', 'e5']);
    expect(ml[2].comment).toBe('open game');
    expect(ml[2].nags).toEqual([1]);
    expect(ml[2].clock).toEqual([60000, 59000]);
    expect(ml[1].children.map((n) => n.san)).toEqual(['e5', 'c5']);
  });

  it('builds the line through a variation', () => {
    const t = new GameTree(START_FEN);
    lineOf(t, 'e2e4', 'e7e5', 'g1f3');
    const c5 = t.add(t.root.children[0], 'c7c5')!;
    const nf3 = t.add(c5, 'g1f3')!;
    expect(t.lineThrough(c5).map((n) => n.san)).toEqual(['', 'e4', 'c5', 'Nf3']);
    expect(t.pathTo(nf3)).toHaveLength(4);
  });
});

describe('PGN', () => {
  const sample = `[Event "Test"]
[White "A"]
[Black "B"]
[Result "1-0"]

1. e4 {[%clk 0:05:00]} e5 {[%clk 0:04:58] solid} 2. Nf3 $1 (2. f4!? exf4 (2... d5) 3. Nf3) 2... Nc6 3. Bb5?! a6 1-0`;

  it('parses variations, NAGs, comments and clocks', () => {
    const { headers, tree, result } = parsePgn(sample);
    expect(headers.White).toBe('A');
    expect(result).toBe('1-0');
    const ml = tree.mainline();
    expect(ml.map((n) => n.san).slice(1)).toEqual(['e4', 'e5', 'Nf3', 'Nc6', 'Bb5', 'a6']);
    expect(ml[2].comment).toBe('solid');
    expect(ml[1].clock).toEqual([300000, 300000]);
    expect(ml[2].clock).toEqual([300000, 298000]);
    expect(ml[3].nags).toEqual([1]);
    expect(ml[5].nags).toEqual([6]);
    const f4 = ml[2].children[1];
    expect(f4.san).toBe('f4');
    expect(f4.nags).toEqual([5]);
    expect(f4.children.map((n) => n.san)).toEqual(['exf4', 'd5']);
    expect(f4.children[0].children[0].san).toBe('Nf3');
  });

  it('round-trips through export', () => {
    const a = parsePgn(sample);
    const text = exportPgn(a.tree, a.headers);
    const b = parsePgn(text);
    expect(b.tree.serialize()).toEqual(a.tree.serialize());
    expect(b.headers).toEqual(a.headers);
    const flat = text.replace(/\s+/g, ' ');
    expect(flat).toContain('(2. f4 $5 exf4 (2... d5) 3. Nf3)');
    expect(flat).toContain('3. Bb5 $6 a6 1-0');
    expect(text).toContain('[%clk 0:04:58]');
  });

  it('adds SetUp/FEN for custom positions and merges annotations', () => {
    const fen = '4k3/8/8/8/8/8/4P3/4K3 b - - 0 1';
    const t = new GameTree(fen);
    lineOf(t, 'e8d7', 'e2e4');
    const text = exportPgn(t, { Event: 'x' }, (n) => (n.san === 'e4' ? { nags: [2], commands: ['[%eval 1.20]'] } : undefined));
    expect(text).toContain('[SetUp "1"]');
    expect(text).toContain(`[FEN "${fen}"]`);
    expect(text).toContain('[Result "*"]');
    expect(text).toContain('1... Kd7 2. e4 $2 { [%eval 1.20] } *');
    const back = parsePgn(text);
    expect(back.tree.root.fen).toBe(fen);
    expect(back.tree.mainline()).toHaveLength(3);
  });

  it('rejects illegal moves with a readable error', () => {
    expect(() => parsePgn('1. e4 e5 2. Ke3')).toThrow(/着法非法/);
    expect(() => parsePgn('hello')).toThrow();
  });

  it('formats clocks', () => {
    expect(fmtClock(3_723_000)).toBe('1:02:03');
    expect(parseClock('1:02:03')).toBe(3_723_000);
    expect(parseClock('0:00:09.5')).toBe(9500);
    expect(parseClock('nope')).toBeNull();
  });
});

describe('ChessClock', () => {
  it('runs one side at a time and adds increments', () => {
    const tc = timeControlOf('3+2')!;
    expect(pgnTimeControl(tc)).toBe('180+2');
    expect(timeControlOf('none')).toBeNull();
    const c = new ChessClock(tc);
    c.run('w', 0);
    expect(c.time('w', 5000)).toBe(175000);
    c.moved('w', 5000);
    expect(c.remaining).toEqual([177000, 180000]);
    c.run('b', 5000);
    c.stop(8000);
    expect(c.snapshot(99999)).toEqual([177000, 177000]);
    c.run('b', 10000);
    expect(c.flagged(10000 + 177000)).toBe('b');
    c.set([1000, 2000], 0);
    expect(c.active).toBe('b');
    expect(c.time('b', 500)).toBe(1500);
  });

  it('formats and budgets time', () => {
    expect(fmtClockShort(245_000)).toBe('4:05');
    expect(fmtClockShort(9_300)).toBe('0:09.3');
    expect(fmtClockShort(3_723_000)).toBe('1:02:03');
    expect(thinkBudget(1000, 0, 1)).toBeLessThanOrEqual(250);
    expect(thinkBudget(300_000, 3000, 1)).toBeGreaterThan(thinkBudget(300_000, 3000, 0));
  });
});

describe('history', () => {
  const g = (id: string, date: number, userColor: 'w' | 'b', result: string, elo = 1500, imported = false): StoredGame => ({
    id,
    date,
    startFen: START_FEN,
    tree: {},
    userColor,
    result,
    elo,
    imported,
  });

  it('scores results from the user side', () => {
    expect(outcomeOf({ userColor: 'w', result: '1-0' })).toBe('win');
    expect(outcomeOf({ userColor: 'b', result: '1-0' })).toBe('loss');
    expect(outcomeOf({ userColor: 'b', result: '1/2-1/2' })).toBe('draw');
    expect(outcomeOf({ userColor: 'w', result: '' })).toBeNull();
  });

  it('computes stats and streaks, ignoring imported games', () => {
    const h = [g('a', 1, 'w', '1-0', 1450), g('b', 2, 'b', '1-0', 1500), g('c', 3, 'b', '0-1', 1650), g('d', 4, 'w', '1-0', 1700), g('e', 5, 'w', '0-1', 1500, true)];
    const s = computeStats(h);
    expect(s.all).toMatchObject({ games: 4, win: 3, loss: 1, draw: 0, score: 75 });
    expect(s.white.games).toBe(2);
    expect(s.black).toMatchObject({ win: 1, loss: 1 });
    expect(s.byElo.map((b) => b.elo)).toEqual([1400, 1600]);
    expect(s.recent).toEqual(['win', 'win', 'loss', 'win']);
    expect(s.streak).toEqual({ kind: 'win', n: 2 });
  });

  it('upserts newest first with a cap', () => {
    let h: StoredGame[] = [];
    h = upsert(h, g('a', 1, 'w', '1-0'));
    h = upsert(h, g('b', 2, 'w', '0-1'));
    h = upsert(h, { ...g('a', 1, 'w', '1/2-1/2') });
    expect(h.map((x) => x.id)).toEqual(['b', 'a']);
    expect(h[1].result).toBe('1/2-1/2');
    expect(upsert(h, g('c', 3, 'w', '1-0'), 2).map((x) => x.id)).toEqual(['c', 'b']);
  });
});
