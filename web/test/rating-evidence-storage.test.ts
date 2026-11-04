import { beforeEach, describe, expect, it } from 'vitest';
import { bootstrapStorage, installStorageAdapter } from '../src/storage';
import { makeBackup, parseBackup } from '../src/backup';
import { Chess } from 'chess.js';
import { defaultSettings } from '../src/settings';
import { GameTree } from '../src/game/tree';
import { loadHistory, sanitizeGame, saveHistory, type StoredGame } from '../src/game/history';
import { START_FEN } from '../src/game/rules';
import { defaultProgress } from '../src/training/puzzles';

const storage = new Map<string, string>();
Object.assign(globalThis, { matchMedia: () => ({ matches: false }) });
const adapter = {
  bootstrap: async () => Object.fromEntries(storage),
  get: (key: string) => storage.get(key),
  set: async (key: string, value: string) => { storage.set(key, value); },
  remove: async (key: string) => { storage.delete(key); },
};
installStorageAdapter(adapter);

const calculation = {
  score: 0.65, weight: 0.3,
  performance: { playerAccuracy: 82, opponentAccuracy: 78, playerMoves: 12, opponentMoves: 11, mistakes: 1, blunders: 0 },
  undo: 2, undoFactor: 0.8, baseDelta: 24,
  evidence: { moves: 20, independent: 14, informed: 6, suggested: 4, followed: 3, hints: 2, hintFollowed: 1, analysis: 3, dependence: 0.3 },
  confidence: 0.9,
};
const rating = { delta: 24, result: 1, expected: 0.5, playerBefore: 1400, playerAfter: 1424, opponent: 1400, rdBefore: 150, rdAfter: 145, streak: 1, calculation };
const game: StoredGame = {
  id: 'evidence-game', date: 100, startFen: START_FEN, tree: {}, userColor: 'w', result: '1-0', rating, ratingPending: true,
};

beforeEach(async () => { storage.clear(); installStorageAdapter(adapter); await bootstrapStorage(); });

describe('rating evidence persistence', () => {
  it('round-trips per-position evidence and strictly filters UCI, duplicates, and flags', () => {
    const tree = GameTree.fromMoves(START_FEN, ['e2e4']);
    tree.root.children[0].evidence = { hints: ['e7e5', 'e7e5', 'bad', 'e7e6'], best: ['d7d5'], info: true, analysis: false, reconsidered: true };
    const serialized = tree.serialize();
    const restored = GameTree.deserialize(START_FEN, JSON.parse(JSON.stringify(serialized)));
    expect(restored.root.children[0].evidence).toEqual({ hints: ['e7e5', 'e7e6'], best: ['d7d5'], info: true, reconsidered: true });

    const many = Array.from({ length: 70 }, (_, i) => `a${Math.floor(i / 8) + 1}${String.fromCharCode(97 + i % 8)}1`);
    const filtered = GameTree.deserialize(START_FEN, { c: [{ u: 'e2e4', e: { hints: [...many, 'a1a2'], best: ['A1a2'], info: 1, analysis: false } as never }] });
    expect(filtered.root.children[0].evidence?.hints).toHaveLength(64);
    expect(filtered.root.children[0].evidence?.best).toBeUndefined();
    expect(filtered.root.children[0].evidence?.info).toBeUndefined();
    expect(filtered.root.children[0].evidence?.analysis).toBeUndefined();
    expect(GameTree.deserialize(START_FEN, { c: [{ u: 'e2e4', e: { hints: ['bad'], info: false } }] }).root.children[0].evidence).toBeUndefined();
  });

  it('round-trips bounded position evidence and filters invalid keys and evidence', () => {
    const queue = [new Chess(START_FEN)];
    const seen = new Set<string>([START_FEN.split(' ').slice(0, 4).join(' ')]);
    const positions: Record<string, unknown> = { 'not a fen key': { info: true } };
    for (let i = 0; i < queue.length && Object.keys(positions).length <= 513; i++) {
      const current = queue[i];
      const key = current.fen().split(' ').slice(0, 4).join(' ');
      positions[key] = { hints: ['e7e5', 'bad'], info: true, analysis: false, reconsidered: 1 };
      for (const move of current.moves()) {
        const next = new Chess(current.fen());
        next.move(move);
        const nextKey = next.fen().split(' ').slice(0, 4).join(' ');
        if (!seen.has(nextKey)) {
          seen.add(nextKey);
          queue.push(next);
        }
      }
    }
    expect(Object.keys(positions).filter((key) => key !== 'not a fen key').length).toBeGreaterThanOrEqual(513);
    const raw = { ...game, assists: { undo: 1, hint: 2, positions } };
    expect(saveHistory([raw as unknown as StoredGame])).toBe(true);
    const restored = loadHistory()[0];
    const restoredPositions = restored.assists?.positions ?? {};
    expect(Object.keys(restoredPositions)).toHaveLength(512);
    const firstKey = START_FEN.split(' ').slice(0, 4).join(' ');
    expect(restoredPositions[firstKey]).toEqual({ hints: ['e7e5'], info: true });
    expect(restored.assists).toMatchObject({ undo: 1, hint: 2 });
    expect(restoredPositions).not.toHaveProperty('not a fen key');
  });

  it('round-trips ratingPending and complete calculation through history and backup', () => {
    expect(saveHistory([game])).toBe(true);
    expect(loadHistory()).toEqual([game]);
    const backup = makeBackup({ settings: defaultSettings(), history: [game], mistakes: [], puzzles: defaultProgress(), deletedMistakes: [] }, 'test');
    const restored = parseBackup(JSON.stringify(backup));
    expect(restored.skipped).toBe(0);
    expect(restored.data.history).toEqual([game]);
  });

  it('drops invalid calculation details without dropping the established rating', () => {
    const invalid = sanitizeGame({ ...game, rating: { ...rating, calculation: { ...calculation, evidence: { ...calculation.evidence, followed: -1 } } } });
    expect(invalid?.rating).not.toHaveProperty('calculation');
    expect(invalid?.rating).toMatchObject({ delta: rating.delta, result: rating.result, playerAfter: rating.playerAfter });
    expect(invalid?.ratingPending).toBe(true);
  });

  it('keeps legacy ratings unchanged and does not migrate ratePending', () => {
    const legacyRating = { delta: 12, result: 1, expected: 0.5, playerBefore: 1400, playerAfter: 1412, opponent: 1400, rdBefore: 150, rdAfter: 145, streak: 1 };
    const legacy = sanitizeGame({ ...game, rating: legacyRating, ratingPending: undefined, ratePending: true });
    expect(legacy?.rating).toEqual(legacyRating);
    expect(legacy).not.toHaveProperty('ratingPending');
    expect(legacy).not.toHaveProperty('ratePending');
  });
});
