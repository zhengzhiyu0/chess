import { describe, expect, it } from 'vitest';

// settings.ts reads a few browser globals for its defaults
Object.assign(globalThis, { matchMedia: () => ({ matches: false }) });
import { assistFactor, computeRating, emptyAssists, expectedAccuracy } from '../src/game/rating';
import { sanitizeSettings, defaultSettings } from '../src/settings';
import { sanitizeGame } from '../src/game/history';
import { parsePgn, splitPgn } from '../src/game/pgn';
import { mergeMistakes, mistakeStats, sanitizeMistake, type Mistake } from '../src/training/mistakes';
import { acceptsMove, parsePuzzles, puzzleDelta, sanitizeProgress } from '../src/training/puzzles';
import { SETTLED, recommendThemes, themesForTag, trainingLevel } from '../src/training/recommend';
import { mergeBackup, parseBackup, makeBackup } from '../src/backup';
import { mistakeTag } from '../src/coach/explain';
import { GameTree } from '../src/game/tree';
import { START_FEN } from '../src/game/rules';

describe('rating', () => {
  const base = { elo: 1500, ratedGames: 20, assists: emptyAssists() };
  it('win gains, loss loses, quality scales the amount', () => {
    const good = computeRating({ ...base, result: 1, accuracy: 95 });
    const bad = computeRating({ ...base, result: 1, accuracy: 50 });
    expect(good.delta).toBeGreaterThan(bad.delta);
    expect(bad.delta).toBeGreaterThan(0);
    const lossGood = computeRating({ ...base, result: 0, accuracy: 95 });
    const lossBad = computeRating({ ...base, result: 0, accuracy: 50 });
    expect(lossGood.delta).toBeLessThan(0);
    expect(lossGood.delta).toBeGreaterThan(lossBad.delta);
  });
  it('a typical draw is neutral, a strong draw gains', () => {
    expect(computeRating({ ...base, result: 0.5, accuracy: expectedAccuracy(1500) }).delta).toBe(0);
    expect(computeRating({ ...base, result: 0.5, accuracy: 95 }).delta).toBeGreaterThan(0);
  });
  it('assists shrink gains only', () => {
    const a = { undo: 2, hint: 1, retry: 0 };
    const win = computeRating({ ...base, result: 1, accuracy: 80 });
    const helped = computeRating({ ...base, result: 1, accuracy: 80, assists: a });
    expect(helped.delta).toBeLessThan(win.delta);
    expect(helped.delta).toBeGreaterThanOrEqual(0);
    const loss = computeRating({ ...base, result: 0, accuracy: 80 });
    expect(computeRating({ ...base, result: 0, accuracy: 80, assists: a }).delta).toBe(loss.delta);
    expect(assistFactor({ undo: 10, hint: 0, retry: 0 })).toBe(0);
    expect(assistFactor({ undo: 0, hint: 0, retry: 0, best: true })).toBeCloseTo(0.2);
  });
  it('abandoning is the worst loss', () => {
    const r = computeRating({ ...base, result: 0, accuracy: 95, abandoned: true });
    expect(r.delta).toBe(computeRating({ ...base, result: 0, accuracy: 0 }).delta);
  });
});

describe('validation', () => {
  it('drops malformed settings', () => {
    const s = sanitizeSettings({ model: 'evil', elo: 99999, customLight: 'red;}', sound: false, avatar: '<img onerror=1>' });
    const d = defaultSettings();
    expect(s.model).toBe(d.model);
    expect(s.elo).toBe(d.elo);
    expect(s.customLight).toBe(d.customLight);
    expect(s.sound).toBe(false);
    expect(s.avatar).toBe('');
  });
  it('drops malformed games and fields', () => {
    expect(sanitizeGame({ id: 1 })).toBeNull();
    const g = sanitizeGame({ id: 'a', date: 1, startFen: START_FEN, tree: {}, userColor: 'w', result: 'x', headers: { White: 'A', 'bad key': 'x' } });
    expect(g?.result).toBe('');
    expect(g?.headers).toEqual({ White: 'A' });
  });
  it('rejects tampered move trees', () => {
    expect(() => GameTree.deserialize(START_FEN, { c: [{ u: 'e2e5' }] })).toThrow();
    expect(() => GameTree.deserialize(START_FEN, { c: ['x' as never] })).toThrow();
  });
});

describe('pgn', () => {
  it('splits multi-game files', () => {
    const two = '[White "A"]\n\n1. e4 e5 1-0\n\n[White "B"]\n\n1. d4 d5 0-1\n';
    const parts = splitPgn(two);
    expect(parts).toHaveLength(2);
    expect(parsePgn(parts[1]).headers.White).toBe('B');
  });
  it('skips the rest of a line after a null move', () => {
    const p = parsePgn('1. e4 e5 (1... -- 2. d4 d5) 2. Nf3 *');
    expect(p.truncated).toBe(true);
    expect(p.tree.mainline().map((n) => n.san).slice(1)).toEqual(['e4', 'e5', 'Nf3']);
  });
});

const mistake = (over: Partial<Mistake> = {}): Mistake => ({
  id: 'g:1',
  gameId: 'g',
  date: Date.now(),
  fen: START_FEN,
  played: 'f2f3',
  playedSan: 'f3',
  best: 'e2e4',
  line: ['e2e4'],
  judgement: 'mistake',
  drop: 20,
  tag: 'positional',
  tagLabel: '局面判断失误',
  streak: 0,
  due: 0,
  tries: 0,
  solved: 0,
  ...over,
});

describe('mistakes', () => {
  it('validates, merges and counts', () => {
    expect(sanitizeMistake({ ...mistake(), best: 'x' })).toBeNull();
    expect(sanitizeMistake(mistake())).not.toBeNull();
    const merged = mergeMistakes([mistake()], [mistake({ tries: 3 }), mistake({ id: 'g:2' })]);
    expect(merged).toHaveLength(2);
    expect(merged.find((m) => m.id === 'g:1')!.tries).toBe(3);
    expect(mistakeStats(merged)[0]).toMatchObject({ tag: 'positional', total: 2, recent: 2 });
  });
  it('tags a hung piece and a missed mate', () => {
    // 1. e4 e5 2. Qh5 Nc6 3. Bc4 Nf6?? 4. Qxf7#: black ignored the mate threat
    const fen = 'r1bqkbnr/pppp1ppp/2n5/4p2Q/2B1P3/8/PPPP1PPP/RNB1K1NR b KQkq - 3 3';
    expect(mistakeTag({ fen, uci: 'g8f6', best: 'd8e7', replyLine: { multipv: 1, depth: 10, mate: 1, pv: ['h5f7'] } }).id).toBe('allow-mate');
    const w = 'r1bqkb1r/pppp1ppp/2n2n2/4p2Q/2B1P3/8/PPPP1PPP/RNB1K1NR w KQkq - 4 4';
    expect(mistakeTag({ fen: w, uci: 'h5h4', best: 'h5f7', bestLine: { multipv: 1, depth: 10, mate: 1, pv: ['h5f7'] } }).id).toBe('miss-mate');
  });
});

describe('puzzles', () => {
  it('parses and grades', () => {
    const [p] = parsePuzzles('00008,r6k/pp2r2p/4Rp1Q/3p4/8/1N1P2R1/PqP2bPP/7K b - - 0 24,f2g3 e6e7 b2b1 b3c1 b1c1 h6c1,1900,crushing middlegame\n');
    expect(p.moves).toHaveLength(6);
    expect(p.themes).toEqual(['crushing', 'middlegame']);
    expect(puzzleDelta(1500, 1500, true, 100)).toBe(10);
    expect(puzzleDelta(1500, 1500, false, 100)).toBe(-10);
    expect(sanitizeProgress({ rating: 'x', games: 3 }).games).toBe(3);
  });
  it('accepts any mating move', () => {
    // back-rank: both Re8# and Rd8# would mate; only the listed one is "expected"
    const fen = '6k1/5ppp/8/8/8/8/5PPP/3R2K1 w - - 0 1';
    expect(acceptsMove(fen, 'd1d8', 'd1d8')).toBe(true);
    expect(acceptsMove(fen, 'd1d2', 'd1d8')).toBe(false);
  });
});

describe('puzzle recommendations', () => {
  const available = Object.fromEntries(['mateIn1', 'hangingPiece', 'fork', 'backRankMate', 'pin', 'skewer', 'mateIn2', 'deflection', 'quietMove', 'endgame'].map((t) => [t, 500]));
  const stat = (tag: string, total: number) => ({ tag, label: tag, total, recent: total, previous: 0, mastered: 0 });
  it('new players get the curriculum of their game rating', () => {
    const r = recommendThemes({ progress: sanitizeProgress({}), elo: 800, mistakes: [], available });
    expect(r.map((x) => x.theme)).toEqual(['mateIn1', 'hangingPiece', 'fork']);
    expect(trainingLevel(sanitizeProgress({ games: 5, rating: 1700 }), 800)).toBe(800);
    expect(trainingLevel(sanitizeProgress({ games: SETTLED, rating: 1700 }), 800)).toBe(1700);
  });
  it('weak themes and game errors come first', () => {
    const progress = sanitizeProgress({ games: 60, solved: 40, failed: 20, rating: 1300, byTheme: { pin: [2, 8], fork: [18, 2] } });
    const r = recommendThemes({ progress, elo: 1300, mistakes: [stat('allow-skewer', 4)], available });
    expect(r.slice(0, 2).map((x) => x.theme).sort()).toEqual(['pin', 'skewer']);
    expect(r.find((x) => x.theme === 'skewer')!.reasons[0]).toContain('错题');
    expect(r.find((x) => x.theme === 'pin')!.reasons[0]).toContain('正确率 20%');
    expect(r.map((x) => x.theme)).not.toContain('fork');
    expect(themesForTag('hanging', 1000)).toEqual(['hangingPiece']);
    expect(themesForTag('positional', 1000)).toEqual([]);
  });
});

describe('backup', () => {
  it('round-trips and merges without losing progress', () => {
    const s = { ...defaultSettings(), elo: 1700, ratedGames: 30 };
    const game = { id: 'x', date: 2, startFen: START_FEN, tree: {}, userColor: 'w' as const, result: '1-0' };
    const file = JSON.stringify(makeBackup({ settings: s, history: [game], mistakes: [mistake()], puzzles: sanitizeProgress({ games: 5, rating: 1400 }) }, 'test'));
    const { data, skipped } = parseBackup(file);
    expect(skipped).toBe(0);
    expect(data.settings.elo).toBe(1700);
    const cur = { settings: { ...defaultSettings(), ratedGames: 2 }, history: [{ ...game, id: 'y' }], mistakes: [], puzzles: sanitizeProgress({}) };
    const m = mergeBackup(cur, data);
    expect(m.history.map((g) => g.id).sort()).toEqual(['x', 'y']);
    expect(m.settings.elo).toBe(1700);
    expect(m.puzzles.games).toBe(5);
    expect(() => parseBackup('{"format":"other"}')).toThrow();
    expect(() => parseBackup('nope')).toThrow();
  });
});
