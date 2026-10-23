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
vi.mock('../src/native', () => ({ isNative: false }));

const { Engines } = await import('../src/app/engines');

const settings = { model: '23m', backend: 'wasm', lowMemory: false, sfLite: false, sfThreads: 1, sfHash: 16 } as Record<string, unknown>;
const make = () => new Engines(() => settings as never, () => false, () => undefined);
const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  maiaCreates.length = 0;
  sfCreates.length = 0;
  settings.backend = 'wasm';
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
