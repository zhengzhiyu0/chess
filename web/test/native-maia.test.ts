import { Chess } from 'chess.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const native = vi.hoisted(() => ({ load: vi.fn(), eval: vi.fn(), evalBatch: vi.fn(), unload: vi.fn() }));
beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  vi.doMock('../src/native', () => ({ isNative: true }));
  vi.doMock('maia-native', () => ({ MaiaNative: native }));
  native.load.mockResolvedValue({ provider: 'coreml' });
  native.unload.mockResolvedValue(undefined);
});
afterEach(() => {
  vi.doUnmock('../src/native');
  vi.doUnmock('maia-native');
});

const position = () => {
  const chess = new Chess();
  return { chess, fens: [chess.fen()], selfElo: 1500, oppoElo: 1500 };
};
const settle = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };

describe('原生 Maia 所有权与恢复', () => {
  it('推理失败后不再复用失效的原生会话', async () => {
    const { Maia } = await import('../src/maia/maia');
    const maia = await Maia.create('5m', 'wasm');
    native.eval.mockRejectedValueOnce(new Error('ORT failed'));
    const job = position();
    await expect(maia.evaluate(job.chess, job.fens, 1500, 1500)).rejects.toThrow('ORT failed');
    expect(maia.alive).toBe(false);
    await settle();
    expect(native.unload).toHaveBeenCalledOnce();
  });

  it('新模型开始加载后，旧实例的延迟卸载不会卸载新会话', async () => {
    const { Maia } = await import('../src/maia/maia');
    const old = await Maia.create('5m', 'wasm');
    old.dispose();
    const next = await Maia.create('23m', 'wasm');
    await settle();
    expect(next.alive).toBe(true);
    const unloadOrder = native.unload.mock.invocationCallOrder[0];
    const nextLoadOrder = native.load.mock.invocationCallOrder[1];
    if (unloadOrder !== undefined) expect(unloadOrder).toBeLessThan(nextLoadOrder);
    next.dispose();
    await settle();
  });

  it('不返回已被新模型取代的推理结果', async () => {
    const { Maia } = await import('../src/maia/maia');
    const old = await Maia.create('5m', 'wasm');
    let resolve!: (result: unknown) => void;
    native.eval.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    const job = position();
    const result = old.evaluate(job.chess, job.fens, 1500, 1500);
    await settle();
    const next = await Maia.create('23m', 'wasm');
    resolve({ logits: Array(20).fill(0), value: [0, 0, 0], ms: 1 });
    await expect(result).rejects.toThrow('已卸载');
    old.dispose();
    next.dispose();
    await settle();
  });
});
