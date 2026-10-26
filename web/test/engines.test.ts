import { beforeEach, describe, expect, it, vi } from 'vitest';

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (v: T) => void;
  reject: (e: Error) => void;
}
function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  let reject!: (e: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

class FakeMaia {
  alive = true;
  crashed = false;
  provider = 'wasm';
  constructor(
    readonly model: string,
    readonly backend: string,
  ) {}
  dispose = vi.fn(() => {
    this.alive = false;
  });
}

class FakeSf {
  alive = true;
  lite = false;
  native = false;
  multiThreaded = false;
  threads = 1;
  terminate = vi.fn(() => {
    this.alive = false;
  });
}

const maiaCreates: { backend: string; d: Deferred<FakeMaia> }[] = [];
const sfCreates: Deferred<FakeSf>[] = [];

vi.mock('../src/maia/maia', () => ({
  MODELS: { '5m': { label: '5M', mb: 1 }, '23m': { label: '23M', mb: 1 }, '79m': { label: '79M', mb: 1 } },
  Maia: {
    create: vi.fn((_model: string, backend: string) => {
      const d = deferred<FakeMaia>();
      maiaCreates.push({ backend, d });
      return d.promise;
    }),
  },
}));
vi.mock('../src/engine/stockfish', () => ({
  Stockfish: {
    create: vi.fn(() => {
      const d = deferred<FakeSf>();
      sfCreates.push(d);
      return d.promise;
    }),
  },
}));
vi.mock('../src/app/dom', () => ({ setStatus: vi.fn() }));
const platform = vi.hoisted(() => ({ isNative: false }));
vi.mock('../src/native', () => platform);

const { Engines } = await import('../src/app/engines');

const settings = { model: '23m', backend: 'wasm', lowMemory: false, sfLite: false, sfThreads: 1, sfHash: 16 } as Record<string, unknown>;
const make = () => new Engines(() => settings as never, () => false, () => undefined);
const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  maiaCreates.length = 0;
  sfCreates.length = 0;
  Object.assign(settings, { model: '23m', backend: 'wasm', lowMemory: false, sfLite: false });
  platform.isNative = false;
});

describe('startup and game readiness', () => {
  it('reuses a startup load when entering a normal game before it finishes', async () => {
    const e = make();
    const startup = e.warmup();
    const entry = e.prepareGame(false, false);
    expect(e.readyForGame(false, false)).toBe(false);
    expect(maiaCreates).toHaveLength(1);
    maiaCreates[0].d.resolve(new FakeMaia('23m', 'wasm'));
    await entry;
    expect(e.readyForGame(false, false)).toBe(true);
    // Ordinary play can begin while the optional analysis engine is still starting.
    expect(e.readyForGame(false, true)).toBe(false);
    sfCreates[0].resolve(new FakeSf());
    await startup;
    expect(maiaCreates).toHaveLength(1);
    expect(sfCreates).toHaveLength(1);
  });

  it.each([false, true])('waits for both engines in coached play (native=%s)', async (native) => {
    platform.isNative = native;
    settings.lowMemory = true;
    const e = new Engines(() => settings as never, () => true, () => undefined);
    const startup = e.warmup();
    const entry = e.prepareGame(false, true);
    maiaCreates[0].d.resolve(new FakeMaia('23m', 'wasm'));
    await flush();
    expect(e.readyForGame(false, true)).toBe(false);
    expect(sfCreates).toHaveLength(1);
    const maia = e.maia;
    sfCreates[0].resolve(new FakeSf());
    await Promise.all([startup, entry]);
    expect(e.readyForGame(false, true)).toBe(true);
    expect(maia?.alive).toBe(true);
    expect(maiaCreates).toHaveLength(1);
  });

  it('keeps Maia ready for ordinary play in exclusive low-memory PWA mode', async () => {
    settings.lowMemory = true;
    const e = make();
    const startup = e.warmup();
    maiaCreates[0].d.resolve(new FakeMaia('23m', 'wasm'));
    await startup;
    expect(e.readyForGame(false, false)).toBe(true);
    expect(sfCreates).toHaveLength(0);
  });

  it('does not let a cancelled coach entry evict Maia from a newer ordinary game', async () => {
    settings.lowMemory = true;
    let coached = true;
    let current = true;
    const e = new Engines(() => settings as never, () => coached, () => undefined);
    const oldEntry = e.prepareGame(false, true, () => current);
    current = false;
    coached = false;
    const newEntry = e.prepareGame(false, false);
    const maia = new FakeMaia('23m', 'wasm');
    maiaCreates[0].d.resolve(maia);
    await Promise.all([oldEntry, newEntry]);
    expect(sfCreates).toHaveLength(0);
    expect(e.readyForGame(false, false)).toBe(true);
    expect(maia.alive).toBe(true);
  });

  it('loads only Stockfish when continuing a finished game in review', async () => {
    const e = make();
    const entry = e.prepareGame(true, false);
    expect(e.readyForGame(true, false)).toBe(false);
    sfCreates[0].resolve(new FakeSf());
    await entry;
    expect(e.readyForGame(true, false)).toBe(true);
    expect(maiaCreates).toHaveLength(0);
  });

  it('does not consider a different selected model or Stockfish build ready', async () => {
    const e = make();
    const entry = e.prepareGame(false, true);
    maiaCreates[0].d.resolve(new FakeMaia('23m', 'wasm'));
    await flush();
    sfCreates[0].resolve(new FakeSf());
    await entry;
    settings.model = '5m';
    expect(e.readyForGame(false, false)).toBe(false);
    settings.sfLite = true;
    expect(e.readyForGame(true, false)).toBe(false);
  });

  it('allows retrying a failed game entry without discarding the ready Maia', async () => {
    const e = make();
    const entry = e.prepareGame(false, true);
    maiaCreates[0].d.resolve(new FakeMaia('23m', 'wasm'));
    await flush();
    sfCreates[0].reject(new Error('boot failed'));
    await expect(entry).rejects.toThrow('boot failed');
    expect(e.readyForGame(false, true)).toBe(false);
    const retry = e.prepareGame(false, true);
    await flush();
    sfCreates[1].resolve(new FakeSf());
    await retry;
    expect(e.readyForGame(false, true)).toBe(true);
    expect(maiaCreates).toHaveLength(1);
  });
});

describe('Engines load generations', () => {
  it('does not resurrect a Maia unloaded while loading', async () => {
    const e = make();
    const p = e.getMaia();
    p.catch(() => undefined);
    await flush();
    e.unloadMaia();
    const m = new FakeMaia('23m', 'wasm');
    maiaCreates[0].d.resolve(m);
    await expect(p).rejects.toThrow();
    expect(e.maia).toBeNull();
    expect(m.dispose).toHaveBeenCalled();
  });

  it('a stale Maia load hands over to the newer one and keeps its handle', async () => {
    const e = make();
    const p1 = e.getMaia();
    await flush();
    e.unloadMaia();
    const p2 = e.getMaia();
    await flush();
    expect(maiaCreates).toHaveLength(2);
    const fresh = new FakeMaia('23m', 'wasm');
    maiaCreates[1].d.resolve(fresh);
    const old = new FakeMaia('23m', 'wasm');
    maiaCreates[0].d.resolve(old);
    expect(await p1).toBe(fresh);
    expect(await p2).toBe(fresh);
    expect(old.dispose).toHaveBeenCalled();
    expect(e.maia).toBe(fresh);
  });

  it('a failing stale Maia load does not clear the newer handle', async () => {
    const e = make();
    const p1 = e.getMaia();
    p1.catch(() => undefined);
    await flush();
    e.unloadMaia();
    const p2 = e.getMaia();
    await flush();
    maiaCreates[0].d.reject(new Error('boom'));
    await expect(p1).rejects.toThrow('boom');
    // the stale failure must not trigger the single-thread retry either
    expect(maiaCreates).toHaveLength(2);
    // still deduplicated onto the pending load
    const p3 = e.getMaia();
    await flush();
    expect(maiaCreates).toHaveLength(2);
    const fresh = new FakeMaia('23m', 'wasm');
    maiaCreates[1].d.resolve(fresh);
    expect(await p2).toBe(fresh);
    expect(await p3).toBe(fresh);
  });

  it('falls back to WASM for the rest of the session after WebGPU crashes', async () => {
    settings.backend = 'webgpu';
    const e = make();
    const p1 = e.getMaia();
    await flush();
    expect(maiaCreates[0].backend).toBe('webgpu');
    const gpu = new FakeMaia('23m', 'webgpu');
    maiaCreates[0].d.resolve(gpu);
    expect(await p1).toBe(gpu);
    gpu.alive = false;
    gpu.crashed = true;
    const p2 = e.getMaia();
    await flush();
    expect(maiaCreates[1].backend).toBe('wasm');
    const cpu = new FakeMaia('23m', 'wasm');
    maiaCreates[1].d.resolve(cpu);
    expect(await p2).toBe(cpu);
  });

  it('does not resurrect a Stockfish unloaded while booting', async () => {
    const e = make();
    const p = e.getSf();
    p.catch(() => undefined);
    e.unloadSf();
    const s = new FakeSf();
    sfCreates[0].resolve(s);
    await expect(p).rejects.toThrow();
    expect(e.sf).toBeNull();
    expect(s.terminate).toHaveBeenCalled();
  });

  it('a failing stale Stockfish boot does not clear the newer handle', async () => {
    const e = make();
    const p1 = e.getSf();
    p1.catch(() => undefined);
    e.unloadSf();
    const p2 = e.getSf();
    sfCreates[0].reject(new Error('boom'));
    await expect(p1).rejects.toThrow('boom');
    const p3 = e.getSf();
    expect(sfCreates).toHaveLength(2);
    const s = new FakeSf();
    sfCreates[1].resolve(s);
    expect(await p2).toBe(s);
    expect(await p3).toBe(s);
    expect(e.sf).toBe(s);
  });
});
