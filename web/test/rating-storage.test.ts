import { beforeEach, describe, expect, it } from 'vitest';
import { makeBackup, mergeBackup, parseBackup, type BackupData } from '../src/backup';
import { loadHistory, sanitizeGame, saveHistory, type StoredGame } from '../src/game/history';
import { defaultSettings, type Settings } from '../src/settings';
import { computeRating } from '../src/game/rating';
import { defaultProgress } from '../src/training/puzzles';
import { START_FEN } from '../src/game/rules';

const mem = new Map<string, string>();
Object.assign(globalThis, {
  matchMedia: () => ({ matches: false }),
  localStorage: {
    getItem: (key: string) => mem.get(key) ?? null,
    setItem: (key: string, value: string) => void mem.set(key, String(value)),
    removeItem: (key: string) => void mem.delete(key),
  },
});

const rating = computeRating({ result: 1, playerElo: 1420, opponentElo: 1600, deviation: 150, streak: 1 });
const game: StoredGame = {
  id: 'rated-game', date: 100, startFen: START_FEN, tree: {}, userColor: 'w', result: '1-0',
  elo: 1600, playerElo: 1420, ratingDeviation: 150, ratingStreak: 1, autoElo: true,
  temperature: 0.8, model: '23m', eloAfter: rating.playerAfter, rating,
  assists: { undo: 0, hint: 0, retry: 0 },
};

const backupData = (settings: Partial<Settings>, history: StoredGame[] = []): BackupData => ({
  settings: { ...defaultSettings(), ...settings }, history, mistakes: [], puzzles: defaultProgress(), deletedMistakes: [],
});

beforeEach(() => mem.clear());

describe('persisted rating snapshots', () => {
  it('round-trips independent player, opponent and eligibility snapshots through local history', () => {
    const manual = { ...game, id: 'manual-game', autoElo: false, temperature: 0 };
    expect(saveHistory([game, manual])).toBe(true);
    expect(loadHistory()).toEqual([game, manual]);
  });

  it('drops old rating details and pending adjustments without losing the historical result', () => {
    const legacy = {
      ...game, playerElo: undefined, ratingDeviation: undefined, ratingStreak: undefined,
      autoElo: undefined, temperature: undefined, eloAfter: 1650, ratePending: true,
      rating: { delta: 50, k: 100, result: 1, score: 0.8, assist: 1, accuracy: 95, expected: 0.5 },
    };
    mem.set('maia-coach.history', JSON.stringify([legacy]));
    const [loaded] = loadHistory();
    expect(loaded).toMatchObject({ elo: 1600, eloAfter: 1650, result: '1-0', model: '23m' });
    expect(loaded).not.toHaveProperty('rating');
    expect(loaded).not.toHaveProperty('ratePending');
    expect(loaded).not.toHaveProperty('playerElo');
    expect(saveHistory([loaded])).toBe(true);
    expect(loadHistory()).toEqual([loaded]);
  });

  it('drops malformed optional snapshots without rejecting the game', () => {
    const invalid: Record<string, unknown[]> = {
      elo: [-1, 2601, 1000.5, Infinity, '1600'],
      eloAfter: [-1, 2601, NaN, '1500'],
      playerElo: [-1, 2601, 1000.5, NaN, null, '1420'],
      ratingDeviation: [59, 351, Infinity, null, '150'],
      ratingStreak: [-9, 9, 1.5, NaN, '-2'],
      autoElo: [0, 1, null, 'true'],
      temperature: [-0.1, 1.6, Infinity, null, '0.8'],
    };
    for (const [field, values] of Object.entries(invalid)) {
      for (const value of values) {
        const loaded = sanitizeGame({ ...game, [field]: value });
        expect(loaded?.id).toBe(game.id);
        expect(loaded).not.toHaveProperty(field);
      }
    }
    expect(sanitizeGame({ ...game, elo: 0, playerElo: 2600, ratingDeviation: 60, ratingStreak: -8, autoElo: false, temperature: 1.5 }))
      .toMatchObject({ elo: 0, playerElo: 2600, ratingDeviation: 60, ratingStreak: -8, autoElo: false, temperature: 1.5 });
  });

  it('requires a complete, bounded new rating record and keeps eloAfter if it is invalid', () => {
    for (const field of Object.keys(rating)) {
      const missing = { ...rating } as Record<string, unknown>;
      delete missing[field];
      expect(sanitizeGame({ ...game, rating: missing })).not.toHaveProperty('rating');
    }
    const invalid: Record<string, unknown[]> = {
      delta: [Infinity, 2601, -2601, 0.5], result: [-1, 0.25, 2], expected: [-0.01, 1.01, NaN],
      playerBefore: [-1, 2601], playerAfter: [-1, 2601], opponent: [-1, 2601], opponentAfter: [-1, 2601],
      rdBefore: [59, 351], rdAfter: [59, 351], streak: [-9, 9, 0.5],
    };
    for (const [field, values] of Object.entries(invalid)) {
      for (const value of values) {
        const loaded = sanitizeGame({ ...game, rating: { ...rating, [field]: value } });
        expect(loaded?.eloAfter).toBe(game.eloAfter);
        expect(loaded).not.toHaveProperty('rating');
      }
    }
    const abandoned = computeRating({ result: 0, playerElo: 1420, opponentElo: 1600, deviation: 150, streak: 0, abandoned: true });
    expect(sanitizeGame({ ...game, rating: { ...abandoned, accuracy: 99, k: 100, score: 0.8 } })?.rating).toEqual(abandoned);
  });

  it('normalizes invalid assistance counts to zero and preserves real assistance', () => {
    for (const bad of [-1, -10, NaN, Infinity, 0.5, '2', null]) {
      expect(sanitizeGame({ ...game, assists: { undo: bad, hint: bad, retry: bad, aids: true, best: true } })?.assists)
        .toEqual({ undo: 0, hint: 0, retry: 0, aids: true, best: true });
    }
    expect(sanitizeGame({ ...game, assists: { undo: 2, hint: 1, retry: 3, aids: false, best: false } })?.assists)
      .toEqual({ undo: 2, hint: 1, retry: 3 });
  });
});

describe('rating backups', () => {
  it('migrates real legacy backup settings and drops pending work without rating it', () => {
    const file = JSON.stringify({
      format: 'maia-coach-backup', version: 1,
      settings: { elo: 1810, ratedGames: 19, autoElo: false },
      history: [{ ...game, rating: { delta: 50, k: 100, result: 1, score: 0.7, assist: 1 }, ratePending: true, eloAfter: 1860 }],
    });
    const { data, skipped } = parseBackup(file);
    expect(skipped).toBe(0);
    expect(data.settings).toMatchObject({ elo: 1810, playerElo: 1810, ratedGames: 19, ratingDeviation: 80, ratingStreak: 0, autoElo: false });
    expect(data.history[0].eloAfter).toBe(1860);
    expect(data.history[0]).not.toHaveProperty('rating');
    expect(data.history[0]).not.toHaveProperty('ratePending');
  });

  it('round-trips all rating fields and merges more advanced progress as one unit in either direction', () => {
    const newer = backupData({ elo: 1800, playerElo: 1690, ratingDeviation: 83.25, ratingStreak: -2, ratedGames: 30, autoElo: false, theme: 'light' }, [game]);
    const older = backupData({ elo: 1400, playerElo: 1250, ratingDeviation: 270, ratingStreak: 1, ratedGames: 2, autoElo: true, theme: 'dark' }, [{ ...game, id: 'older-game', date: 90 }]);
    const { data: restored, skipped } = parseBackup(JSON.stringify(makeBackup(newer, 'test')));
    expect(skipped).toBe(0);
    expect(restored).toEqual(newer);
    const progress = { elo: 1800, playerElo: 1690, ratingDeviation: 83.25, ratingStreak: -2, ratedGames: 30, autoElo: false };
    const merged = mergeBackup(older, restored);
    expect(merged.settings).toMatchObject({ ...progress, theme: 'dark' });
    expect(merged.history.map((g) => g.id)).toEqual(['rated-game', 'older-game']);
    expect(mergeBackup(restored, older).settings).toEqual(newer.settings);
    expect(parseBackup(JSON.stringify(makeBackup(merged, 'test'))).data).toEqual(merged);
    expect(newer.settings).toMatchObject({ ...progress, theme: 'light' });
    expect(older.settings.playerElo).toBe(1250);
  });

  it('retains the complete current state when rated-game counts tie', () => {
    const current = backupData({ elo: 1200, playerElo: 1080, ratingDeviation: 130, ratingStreak: -1, ratedGames: 8, autoElo: true });
    const incoming = backupData({ elo: 1900, playerElo: 1830, ratingDeviation: 200, ratingStreak: 3, ratedGames: 8, autoElo: false });
    expect(mergeBackup(current, incoming).settings).toEqual(current.settings);
  });
});

