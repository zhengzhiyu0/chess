import { describe, expect, it } from 'vitest';
import { captureAnalysis, restoreAnalysis, sanitizeAnalysis } from '../src/game/analysis-state';
import { GameTree } from '../src/game/tree';
import { START_FEN } from '../src/game/rules';
import { sanitizeGame } from '../src/game/history';
import type { SfLine } from '../src/engine/stockfish';

type Ann = { eval: { lines: SfLine[]; best: string | null } };
describe('saved per-game analysis', () => {
  it('restores completed evaluations for mainline and variation after game reload', () => {
    const tree = GameTree.fromMoves<Ann>(START_FEN, ['e2e4', 'e7e5']);
    const variation = tree.add(tree.root, 'd2d4', true)!;
    tree.root.a.eval = { best: 'e2e4', lines: [{ multipv: 1, depth: 18, cp: 20, pv: ['e2e4'], wdl: [100, 800, 100] }] };
    variation.a.eval = { best: 'd7d5', lines: [{ multipv: 1, depth: 12, cp: -10, pv: ['d7d5'] }] };
    const game = sanitizeGame(JSON.parse(JSON.stringify({ id: 'saved', date: 1, startFen: START_FEN,
      tree: tree.serialize(), userColor: 'w', result: '', analysis: captureAnalysis(tree, 'f1000e') })))!;
    const loaded = GameTree.deserialize<Ann>(START_FEN, game.tree);
    restoreAnalysis(loaded, game.analysis, 'f1000e', (n, lines, best) => { n.a.eval = { lines, best }; });
    expect(loaded.root.a.eval).toEqual(tree.root.a.eval);
    expect(loaded.root.children[1].a.eval).toEqual(variation.a.eval);
    expect(loaded.root.children[0].a.eval).toBeUndefined();
    const other = GameTree.deserialize<Ann>(START_FEN, game.tree);
    restoreAnalysis(other, game.analysis, 'l1000e', (n, lines, best) => { n.a.eval = { lines, best }; });
    expect(other.root.a.eval).toBeUndefined();
  });

  it('filters damaged evaluations and drops paths that do not exist in the game', () => {
    const saved = sanitizeAnalysis({ signature: 'sig', positions: [
      { path: [], line: { depth: 12, cp: NaN, pv: ['e2e4'] }, best: 'e2e4' },
      { path: [-1], line: null, best: null },
      { path: [7], line: null, best: null },
      { path: [], line: { depth: 12, cp: 10, pv: ['bad'] }, best: 'e2e4' },
    ] });
    expect(saved?.positions).toHaveLength(1);
    let count = 0;
    restoreAnalysis(new GameTree(START_FEN), saved, 'sig', () => count++);
    expect(count).toBe(0);
  });
});
