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

const { loadSettings, saveSettings, sanitizeSettings, defaultSettings } = await import('../src/settings');
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
});

describe('settings whitelist', () => {
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
