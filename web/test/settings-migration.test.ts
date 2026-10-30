import { beforeEach, describe, expect, it, vi } from 'vitest';

// the engine migration only runs in the iOS app
vi.mock('../src/native', () => ({ isNative: true, thermalState: 0 }));

const mem = new Map<string, string>();
Object.assign(globalThis, {
  matchMedia: () => ({ matches: false }),
  localStorage: {
    getItem: (k: string) => mem.get(k) ?? null,
    setItem: (k: string, v: string) => void mem.set(k, String(v)),
    removeItem: (k: string) => void mem.delete(k),
  },
});

// Load after browser globals are installed: settings reads navigator/matchMedia during initialization.
const { loadSettings, saveSettings, sanitizeSettings, defaultSettings, MAIA_LEVELS } = await import('../src/settings');
const KEY = 'maia-coach.settings';

describe('settings engine migration (iOS app)', () => {
  beforeEach(() => mem.clear());

  it('moves WebView-era settings to the native defaults once', () => {
    mem.set(KEY, JSON.stringify({ sfThreads: 1, sfHash: 16, lowMemory: true, warmup: false }));
    const s = loadSettings();
    const d = defaultSettings();
    expect(s).toMatchObject({ sfThreads: d.sfThreads, sfHash: d.sfHash, lowMemory: d.lowMemory, warmup: d.warmup, engineGen: 3 });
  });

  it('keeps the user choices after the migration ran', () => {
    mem.set(KEY, JSON.stringify({ sfThreads: 1, sfHash: 16 }));
    const s = loadSettings();
    saveSettings({ ...s, sfThreads: 1, sfHash: 512, lowMemory: true, warmup: false });
    // every later start must not reset them again
    for (let i = 0; i < 3; i++) {
      const again = loadSettings();
      expect(again).toMatchObject({ sfThreads: 1, sfHash: 512, lowMemory: true, warmup: false, engineGen: 3 });
      saveSettings(again);
    }
  });

  it('caps gen-2 thread counts at the performance cores without resetting the rest', () => {
    mem.set(KEY, JSON.stringify({ engineGen: 2, sfThreads: 5, sfHash: 256, warmup: false }));
    expect(loadSettings()).toMatchObject({ sfThreads: 2, sfHash: 256, warmup: false, engineGen: 3 });
  });

  it('clears an API key left by the removed AI coach', () => {
    mem.set('maia-coach.ai-key', 'legacy-secret');
    loadSettings();
    expect(mem.has('maia-coach.ai-key')).toBe(false);
  });

  it('always resolves legacy coach selections to Lia', () => {
    // Older builds persisted a selectable portrait and a recording toggle.
    mem.set(KEY, JSON.stringify({ coachAvatar: 7, recordingEnabled: true }));
    expect(loadSettings()).toMatchObject({ coachAvatar: 0 });
    expect(sanitizeSettings({ coachAvatar: -1 }).coachAvatar).toBe(0);
  });
});

describe('settings whitelist', () => {
  it('replaces removed synth themes with recordings, including imported settings', () => {
    const themes = { wood: 'wood', felt: 'felt', plastic: 'glass', marble: 'glass', pop: 'felt', retro: 'nes' };
    for (const [before, after] of Object.entries(themes)) {
      expect(sanitizeSettings({ soundTheme: before }).soundTheme).toBe(after);
      mem.set(KEY, JSON.stringify({ soundTheme: before, soundGen: 2 }));
      expect(loadSettings().soundTheme).toBe(after);
    }
  });

  it('rejects prototype keys and unknown ids', () => {
    const d = defaultSettings();
    for (const bad of ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'nope']) {
      const s = sanitizeSettings({ pieceSet: bad, boardTheme: bad, soundTheme: bad, timeControl: bad });
      expect(s).toMatchObject({ pieceSet: d.pieceSet, boardTheme: d.boardTheme, soundTheme: d.soundTheme, timeControl: d.timeControl });
    }
    expect(sanitizeSettings({ pieceSet: 'merida', boardTheme: 'custom', soundTheme: 'wood', timeControl: '5+3' })).toMatchObject({
      pieceSet: 'merida',
      boardTheme: 'custom',
      soundTheme: 'wood',
      timeControl: '5+3',
    });
  });
});

describe('independent assistance migration', () => {
  const disabled = { aidWinPct: false, aidEval: false, aidThreats: false, aidHanging: false, aidBest: false };
  const legacyAids = { coachEval: true, coachThreats: true, coachHanging: true, coachBest: true };

  beforeEach(() => mem.clear());

  it.each(['normal', undefined, 'unknown'])('does not enable stale coach aids for gameType %s', (gameType) => {
    const legacy = { gameType, ...legacyAids };
    mem.set(KEY, JSON.stringify(legacy));
    expect(loadSettings()).toMatchObject(disabled);
    expect(sanitizeSettings(legacy)).toMatchObject(disabled);
  });

  it('maps enabled legacy coach options without retaining the mode or lesson controls', () => {
    const legacy = { gameType: 'coach', coachLevel: 'blunder', ...legacyAids, coachHanging: false };
    mem.set(KEY, JSON.stringify(legacy));
    const expected = { ...disabled, aidEval: true, aidThreats: true, aidBest: true };
    expect(loadSettings()).toMatchObject(expected);
    const migrated = sanitizeSettings(legacy);
    expect(migrated).toMatchObject(expected);
    for (const key of ['gameType', 'coachLevel', ...Object.keys(legacyAids)]) expect(migrated).not.toHaveProperty(key);
    expect(legacy).toEqual({ gameType: 'coach', coachLevel: 'blunder', ...legacyAids, coachHanging: false });
    saveSettings(migrated);
    expect(loadSettings()).toMatchObject(expected);
  });

  it('gives explicit new fields precedence over old coach options', () => {
    const migrated = sanitizeSettings({ gameType: 'coach', ...legacyAids, ...disabled, aidWinPct: true, opponentTalk: true });
    expect(migrated).toMatchObject({ ...disabled, aidWinPct: true, opponentTalk: true });
    expect(sanitizeSettings({ gameType: 'normal', aidThreats: true, aidBest: true })).toMatchObject({ aidThreats: true, aidBest: true });
  });

  it('does not revive legacy options when explicit new fields are malformed', () => {
    expect(sanitizeSettings({
      gameType: 'coach', ...legacyAids, aidWinPct: 1, aidEval: null, aidThreats: 'true', aidHanging: 1, aidBest: undefined,
    })).toMatchObject(disabled);
    expect(sanitizeSettings({ gameType: 'coach', coachThreats: 'true', coachHanging: 1 })).toMatchObject(disabled);
  });
});

describe('separate player rating migration', () => {
  beforeEach(() => mem.clear());

  it.each([[0, 350], [1, 250], [4, 250], [5, 150], [14, 150], [15, 80], [90, 80]])(
    'retains %i rated games and assigns legacy uncertainty %i',
    (ratedGames, ratingDeviation) => {
      const legacy = { elo: 1820, ratedGames, autoElo: false };
      mem.set(KEY, JSON.stringify(legacy));
      const expected = { elo: 1800, playerElo: 1820, ratedGames, ratingDeviation, ratingStreak: 0 };
      expect(loadSettings()).toMatchObject(expected);
      expect(sanitizeSettings(legacy)).toMatchObject(expected);
      expect(loadSettings()).not.toHaveProperty('autoElo');
      expect(legacy).toEqual({ elo: 1820, ratedGames, autoElo: false });
    },
  );

  it('migrates the earlier Maia field through the backup sanitizer too', () => {
    const migrated = sanitizeSettings({ maiaElo: 1230, myElo: 900, ratedGames: 8 });
    expect(migrated).toMatchObject({ elo: 1200, playerElo: 1230, ratingDeviation: 150, ratedGames: 8 });
    expect(migrated).not.toHaveProperty('maiaElo');
    expect(migrated).not.toHaveProperty('myElo');
    expect(sanitizeSettings({ elo: 1600, maiaElo: 1230 }).playerElo).toBe(1600);
  });

  it('keeps independent ratings and uncertainty over repeated saves and loads', () => {
    const settings = { ...defaultSettings(), elo: 1800, playerElo: 1682, ratingDeviation: 91.25, ratingStreak: -3, ratedGames: 27 };
    saveSettings(settings);
    for (let i = 0; i < 3; i++) {
      const loaded = loadSettings();
      expect(loaded).toMatchObject(settings);
      saveSettings(loaded);
    }
  });

  it('defaults malformed rating fields without discarding valid progress', () => {
    const d = defaultSettings();
    for (const value of [null, '1200', -1, 2601, 1500.5, NaN, Infinity]) {
      expect(sanitizeSettings({ elo: 1800, playerElo: value, ratedGames: 31 })).toMatchObject({
        elo: 1800, playerElo: d.playerElo, ratedGames: 31, ratingDeviation: 80,
      });
    }
    for (const value of [null, '80', 59, 351, NaN, Infinity]) {
      expect(sanitizeSettings({ ratingDeviation: value, ratedGames: 31 })).toMatchObject({ ratingDeviation: d.ratingDeviation, ratedGames: 31 });
    }
    for (const value of [null, '-3', -9, 9, 0.5, NaN, Infinity]) {
      expect(sanitizeSettings({ ratingStreak: value }).ratingStreak).toBe(0);
    }
    for (const value of [-1, 1.5, Infinity, '30']) {
      expect(sanitizeSettings({ ratedGames: value })).toMatchObject({ ratedGames: 0, ratingDeviation: 350 });
    }
  });

  it('accepts the rating and streak boundaries', () => {
    expect(sanitizeSettings({ elo: 0, playerElo: 2600, ratingDeviation: 60, ratingStreak: -8 })).toMatchObject({ elo: 600, playerElo: 2600, ratingDeviation: 60, ratingStreak: -8 });
    expect(sanitizeSettings({ elo: 300, playerElo: 0, ratingDeviation: 350, ratingStreak: 8 })).toMatchObject({ elo: 600, playerElo: 0, ratingDeviation: 350, ratingStreak: 8 });
  });

  it('snaps only the next opponent to the nearest fixed level, keeping exact player estimates', () => {
    for (const level of MAIA_LEVELS) expect(sanitizeSettings({ elo: level }).elo).toBe(level);
    for (const [old, level] of [[1810, 1800], [1740, 1800], [1450, 1400], [1499, 1500], [20, 600], [420, 600]]) {
      const settings = sanitizeSettings({ elo: old, autoElo: false });
      expect(settings.elo).toBe(level);
      expect(settings.playerElo).toBe(old);
      expect(settings).not.toHaveProperty('autoElo');
    }
    expect(sanitizeSettings({ elo: 1810, playerElo: 1682 })).toMatchObject({ elo: 1800, playerElo: 1682 });
  });
});
