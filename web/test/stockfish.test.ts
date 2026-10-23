import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let emit: (line: string) => void;
let commands: string[];

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  commands = [];
  vi.stubGlobal('document', { hidden: false, baseURI: 'http://localhost/' });
  vi.stubGlobal('self', { crossOriginIsolated: false });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.doUnmock('../src/native');
  vi.doUnmock('maia-native');
});

async function webEngine() {
  vi.doMock('../src/native', () => ({ isNative: false }));
  vi.stubGlobal('Worker', class {
    onmessage?: (event: { data: string }) => void;
    constructor() { emit = (line) => this.onmessage?.({ data: line }); }
    postMessage(cmd: string) {
      commands.push(cmd);
      if (cmd === 'uci') emit('uciok');
      if (cmd === 'isready') emit('readyok');
    }
    terminate() {}
  });
  const { Stockfish } = await import('../src/engine/stockfish');
  return Stockfish.create(1, 16);
}

async function nativeEngine(listenerFailure = false) {
  vi.doMock('../src/native', () => ({ isNative: true }));
  const addListener = vi.fn(async (_event: string, listener: (event: { engine: string; lines: string[] }) => void) => {
    if (listenerFailure) { listenerFailure = false; throw new Error('bridge failed'); }
    emit = (line) => listener({ engine: 'full', lines: [line] });
    return { remove: async () => {} };
  });
  vi.doMock('maia-native', () => ({ StockfishNative: {
    start: vi.fn(async () => {}),
    addListener,
    send: vi.fn(async ({ cmd }: { cmd: string }) => {
      commands.push(cmd);
      if (cmd === 'uci') emit('uciok');
      if (cmd === 'isready') emit('readyok');
    }),
  } }));
  return (await import('../src/engine/stockfish')).Stockfish;
}

const settle = async () => { for (let i = 0; i < 15; i++) await Promise.resolve(); };

describe('UCI 边界评估', () => {
  it.each(['lowerbound', 'upperbound'] as const)('解析 %s', async (bound) => {
    const { parseInfo } = await import('../src/engine/stockfish');
    expect(parseInfo(`info depth 20 score cp 125 ${bound} pv e2e4`)).toMatchObject({ cp: 125, bound });
  });

  it('更深的边界分数不会覆盖同条主变的精确分数', async () => {
    const sf = await webEngine();
    const search = sf.analyse('startpos', { multipv: 2 });
    await settle();
    emit('info depth 10 multipv 1 score cp 30 pv e2e4');
    emit('info depth 11 multipv 1 score cp 120 lowerbound pv d2d4');
    emit('info depth 11 multipv 2 score cp -20 upperbound pv g1f3');
    emit('bestmove e2e4');
    const result = await search;
    expect(result.lines[0]).toMatchObject({ depth: 10, cp: 30, pv: ['e2e4'] });
    expect(result.lines[0].bound).toBeUndefined();
    expect(result.lines[1].bound).toBe('upperbound');
    sf.terminate();
  });

  it('没有精确分数时保留边界值，随后允许精确值替换', async () => {
    const sf = await webEngine();
    const search = sf.analyse('startpos');
    await settle();
    emit('info depth 9 score cp 90 lowerbound pv d2d4');
    emit('info depth 9 score cp 40 pv e2e4');
    emit('bestmove e2e4');
    expect((await search).lines[0]).toEqual({ multipv: 1, depth: 9, cp: 40, pv: ['e2e4'] });
    sf.terminate();
  });
});

describe('原生 Stockfish 生命周期', () => {
  it('关闭当前实例后缩小 Hash，重新创建恢复设定值', async () => {
    const Stockfish = await nativeEngine();
    const sf = await Stockfish.create(2, 128);
    commands = [];
    sf.terminate();
    expect(commands).toEqual(['stop', 'setoption name Hash value 1', 'ucinewgame']);
    const next = await Stockfish.create(2, 64);
    expect(commands).toContain('setoption name Hash value 64');
    next.terminate();
  });

  it('旧实例关闭不会停止新实例或缩小新实例的 Hash', async () => {
    const Stockfish = await nativeEngine();
    const first = await Stockfish.create(2, 128);
    const next = await Stockfish.create(2, 64);
    commands = [];
    first.terminate();
    expect(commands).toEqual([]);
    next.terminate();
    expect(commands).toContain('setoption name Hash value 1');
  });

  it('桥监听注册失败后下一次创建可以重试', async () => {
    const Stockfish = await nativeEngine(true);
    await expect(Stockfish.create(2, 64)).rejects.toThrow('bridge failed');
    const sf = await Stockfish.create(2, 64);
    expect(sf.alive).toBe(true);
    sf.terminate();
  });
});
