import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/maia/maia', () => ({ MODELS: { '5m': { label: '5M' }, '23m': { label: '23M' }, '79m': { label: '79M' } } }));

const engineFiles = [
  'stockfish-19.js', 'stockfish-19.wasm',
  'stockfish-19-single.js', 'stockfish-19-single.wasm',
  'stockfish-19-lite.js', 'stockfish-19-lite.wasm',
  'stockfish-19-lite-single.js', 'stockfish-19-lite-single.wasm',
];
const baseURI = 'https://example.test/chess/';

beforeEach(() => {
  vi.resetModules();
  vi.stubGlobal('self', { crossOriginIsolated: true });
  vi.stubGlobal('document', { baseURI });
  vi.stubGlobal('caches', { open: vi.fn(async () => ({ keys: async () => [] })) });
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
    built: 1,
    files: engineFiles.map((name) => ({ url: `engines/${name}`, size: 10 })),
  }))));
});
afterEach(() => vi.unstubAllGlobals());

describe('离线 Stockfish 后备', () => {
  it.each([false, true])('隔离环境缓存当前版本及单线程后备：lite=%s', async (lite) => {
    const { loadPrecache, listPackages } = await import('../src/offline');
    expect(await loadPrecache()).toBe(true);
    const stockfish = (await listPackages(lite)).find((pkg) => pkg.id === 'stockfish')!;
    expect(stockfish.files).toHaveLength(4);
    expect(stockfish.files.every((file) => file.url.includes('-lite') === lite)).toBe(true);
    expect(stockfish.files.some((file) => file.url.includes('-single'))).toBe(true);
    expect(stockfish.files.some((file) => !file.url.includes('-single'))).toBe(true);
    expect(stockfish.size).toBe(40);
  });

  it('非隔离环境只下载可用的单线程文件', async () => {
    vi.stubGlobal('self', { crossOriginIsolated: false });
    const { loadPrecache, listPackages } = await import('../src/offline');
    await loadPrecache();
    const stockfish = (await listPackages(false)).find((pkg) => pkg.id === 'stockfish')!;
    expect(stockfish.files).toHaveLength(2);
    expect(stockfish.files.every((file) => file.url.includes('-single'))).toBe(true);
  });
});
