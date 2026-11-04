import { beforeEach, describe, expect, it, vi } from 'vitest';
import { bootstrapStorage, flushStorage, installStorageAdapter, removeStored, safeSet, setStored, storageRaw } from '../src/storage';
import { persistBackup, type BackupData } from '../src/backup';
import { defaultSettings } from '../src/settings';
import { defaultProgress } from '../src/training/puzzles';

const disk = new Map<string, string>();
Object.assign(globalThis, { matchMedia: () => ({ matches: false }) });
let failOpen = false;
let failWrite = false;
let release: (() => void) | undefined;
let wait: Promise<void> | undefined;
const adapter = {
  bootstrap: async () => { if (failOpen) throw new Error('open failed'); return Object.fromEntries(disk); },
  set: vi.fn(async (key: string, value: string) => {
    await wait;
    if (failWrite) throw new Error('disk full');
    disk.set(key, value);
  }),
  remove: async (key: string) => { disk.delete(key); },
  setMany: vi.fn(async (entries: Record<string, string>) => {
    await wait;
    if (failWrite) throw new Error('disk full');
    for (const [key, value] of Object.entries(entries)) disk.set(key, value);
  }),
};
beforeEach(() => {
  disk.clear(); failOpen = failWrite = false; wait = undefined; release = undefined;
  vi.clearAllMocks();
  installStorageAdapter(adapter);
});

describe('durable storage acknowledgements', () => {
  it('rejects failed bootstrap and writes, then retries without overwriting existing data', async () => {
    disk.set('settings', 'original');
    failOpen = true;
    await expect(bootstrapStorage()).rejects.toThrow('open failed');
    expect(safeSet('settings', 'default')).toBe(false);
    await expect(setStored('settings', 'default')).rejects.toThrow('尚未就绪');
    await expect(flushStorage()).rejects.toThrow('尚未就绪');
    expect(adapter.set).not.toHaveBeenCalled();
    failOpen = false;
    await bootstrapStorage();
    expect(storageRaw('settings')).toBe('original');
    await setStored('settings', 'updated');
    expect(disk.get('settings')).toBe('updated');
  });

  it('updates memory immediately but confirms queued writes only after commit, and reports flush failures', async () => {
    await bootstrapStorage();
    wait = new Promise(resolve => { release = resolve; });
    expect(safeSet('game', 'one')).toBe(true);
    expect(storageRaw('game')).toBe('one');
    expect(disk.has('game')).toBe(false);
    release!();
    await flushStorage();
    expect(disk.get('game')).toBe('one');
    failWrite = true;
    await expect(setStored('game', 'two')).rejects.toThrow('disk full');
    expect(storageRaw('game')).toBe('one');
    await expect(flushStorage()).rejects.toThrow('部分本机数据未能保存');
    failWrite = false;
    await setStored('game', 'three');
    await flushStorage();
    expect(storageRaw('game')).toBe('three');
  });

  it('preserves write ordering through delayed writes and removal', async () => {
    await bootstrapStorage();
    safeSet('game', 'one'); safeSet('game', 'two'); removeStored('game');
    expect(storageRaw('game')).toBeUndefined();
    await flushStorage();
    expect(disk.has('game')).toBe(false);
    expect(adapter.set.mock.calls.map(([, value]) => value)).toEqual(['one', 'two']);
  });

  it('keeps the newest memory value when acknowledged and queued writes overlap', async () => {
    await bootstrapStorage();
    wait = new Promise(resolve => { release = resolve; });
    const first = setStored('game', 'one');
    const second = setStored('game', 'two');
    release!();
    await Promise.all([first, second]);
    expect(storageRaw('game')).toBe('two');
    wait = new Promise(resolve => { release = resolve; });
    const third = setStored('game', 'three');
    safeSet('game', 'four');
    release!();
    await third;
    expect(storageRaw('game')).toBe('four');
    await flushStorage();
    expect(disk.get('game')).toBe('four');
  });

  it('commits every backup document together and keeps old settings/history when the transaction fails', async () => {
    disk.set('maia-coach.settings', 'old settings');
    disk.set('maia-coach.history', 'old history');
    await bootstrapStorage();
    const backup: BackupData = { settings: defaultSettings(), history: [], mistakes: [], puzzles: defaultProgress(), deletedMistakes: ['old:1'] };
    failWrite = true;
    await expect(persistBackup(backup)).rejects.toThrow('disk full');
    expect(disk.size).toBe(2);
    expect(storageRaw('maia-coach.settings')).toBe('old settings');
    expect(disk.get('maia-coach.history')).toBe('old history');
    failWrite = false;
    await persistBackup(backup);
    await flushStorage();
    expect(adapter.set).not.toHaveBeenCalled();
    expect(Object.keys(adapter.setMany.mock.calls[1][0])).toHaveLength(5);
    expect(JSON.parse(storageRaw('maia-coach.settings')!)).toEqual(backup.settings);
    expect(disk.get('maia-coach.mistakes-deleted')).toBe('["old:1"]');
  });
});
