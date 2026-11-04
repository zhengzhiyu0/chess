// Engine-only integration. No imports from the original app/controller/DOM UI.
import { Chess } from '../../web/node_modules/chess.js';
import { Maia, type ModelId, type MaiaResult } from '../../web/src/maia/maia';
import { Stockfish, type SfResult } from '../../web/src/engine/stockfish';
import { cancelEngineStarts, pauseEngineStarts, resumeEngineStarts } from './lifecycle';

interface Options { model: ModelId; threads: number; hash: number; lite: boolean }
interface PredictRequest { fen: string; selfElo: number; opponentElo: number }
interface AnalyseRequest { fen: string; milliseconds?: number; multipv?: number; startFen?: string; moves?: string[] }
interface State { status: string; error: string | null; stockfishReady: boolean; maiaReady: boolean }

const state: State = { status: '引擎尚未初始化', error: null, stockfishReady: false, maiaReady: false };
const log: string[] = [];
let options: Options = { model: '23m', threads: 2, hash: 128, lite: false };
let sf: Stockfish | null = null;
let maia: Maia | null = null;
let sfLoading: Promise<Stockfish> | null = null;
let maiaLoading: Promise<Maia> | null = null;
let sfKey = '';
let sfGeneration = 0;
let maiaGeneration = 0;
let predictionGeneration = 0;
let searchGeneration = 0;
let suspended = false;
let disposed = false;
let initTail: Promise<void> = Promise.resolve();
let initializing: Promise<void> | null = null;
let initializingKey = '';
let searchTail: Promise<unknown> = Promise.resolve();
const searches = new Set<{ abort: AbortController; done: Promise<unknown> }>();

function record(message: string) {
  log.push(`${new Date().toISOString()} ${message}`);
  if (log.length > 500) log.splice(0, log.length - 500);
}

function changed(status?: string) {
  if (status !== undefined) state.status = status;
  state.stockfishReady = !disposed && (sf?.alive ?? false);
  state.maiaReady = !disposed && (maia?.alive ?? false);
  bridge.onChanged?.();
}

function failure(error: unknown) {
  if (disposed) return;
  state.error = error instanceof Error ? error.message : String(error);
  record(`error: ${state.error}`);
  changed(`引擎错误：${state.error}`);
}

function check() { if (disposed) throw new Error('引擎服务已释放'); }

function integer(value: unknown, fallback: number, min: number, max: number, name: string): number {
  const n = value === undefined ? fallback : value;
  if (typeof n !== 'number' || !Number.isInteger(n) || n < min || n > max) throw new Error(`无效的 ${name}`);
  return n;
}

function readOptions(json: string): Options {
  const v = JSON.parse(json) as Partial<Options>;
  const model = v.model ?? '23m';
  if (!['5m', '23m', '79m'].includes(model)) throw new Error(`无效的 Maia 模型：${model}`);
  if (v.lite !== undefined && typeof v.lite !== 'boolean') throw new Error('lite 须为布尔值');
  return { model, threads: integer(v.threads, 2, 1, 32, 'threads'), hash: integer(v.hash, 128, 1, 2048, 'hash'), lite: v.lite ?? false };
}

function key(v: Options) { return `${v.model}/${v.threads}/${v.hash}/${v.lite}`; }
function stockfishKey(v: Options) { return `${v.threads}/${v.hash}/${v.lite}`; }

function deadline<T>(promise: Promise<T>, ms: number, name: string, cancel: () => void = () => {}): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      cancel();
      reject(new Error(`${name} 超时`));
    }, ms);
    promise.then(v => { clearTimeout(timer); resolve(v); }, e => { clearTimeout(timer); reject(e); });
  });
}

async function getSf(): Promise<Stockfish> {
  check();
  const requested = { ...options };
  const wanted = stockfishKey(requested);
  if (sf?.alive && sfKey === wanted) return sf;
  if (sfLoading) return sfLoading;
  sf?.terminate();
  sf = null;
  const generation = ++sfGeneration;
  record(`Stockfish load ${wanted}`);
  let expired = false;
  const create = Stockfish.create(requested.threads, requested.hash, requested.lite).then(engine => {
    if (expired || disposed || generation !== sfGeneration) { engine.terminate(); throw new Error('Stockfish 加载已取消'); }
    sf = engine;
    sfKey = wanted;
    changed();
    return engine;
  });
  const loading = deadline(create, 100000, 'Stockfish 初始化', () => { expired = true; sfGeneration++; cancelEngineStarts('stockfish'); });
  sfLoading = loading;
  try { return await loading; }
  finally { if (sfLoading === loading) sfLoading = null; }
}

async function getMaia(): Promise<Maia> {
  check();
  const requested = { ...options };
  if (maia?.alive && maia.model === requested.model) return maia;
  if (maiaLoading) return maiaLoading;
  maia?.dispose();
  maia = null;
  const generation = ++maiaGeneration;
  record(`Maia WASM load ${requested.model}`);
  const create = Maia.create(requested.model, 'wasm', (loaded, total) => {
    if (generation === maiaGeneration && !suspended && !disposed) {
      changed(`正在加载 Maia ${requested.model}：${Math.floor(loaded / total * 100)}%`);
    }
  }, false, crossOriginIsolated ? requested.threads : 1).then(engine => {
    if (disposed || generation !== maiaGeneration) { engine.dispose(); throw new Error('Maia 加载已取消'); }
    maia = engine;
    changed();
    return engine;
  });
  const loading = deadline(create, 120000, 'Maia 初始化', () => {
    if (generation === maiaGeneration) { maiaGeneration++; maiaLoading = null; cancelEngineStarts('maia'); }
  });
  maiaLoading = loading;
  try { return await loading; }
  finally { if (maiaLoading === loading) maiaLoading = null; }
}

function initialize(requested: Options): Promise<void> {
  check();
  suspended = false;
  resumeEngineStarts();
  if (initializing && initializingKey === key(requested)) return initializing;
  const generation = predictionGeneration;
  const future = initTail.then(async () => {
    check();
    if (generation !== predictionGeneration || suspended) throw new Error('引擎初始化已取消');
    options = requested;
    state.error = null;
    changed(`正在准备 Stockfish 与 Maia ${requested.model}…`);
    const results = await Promise.allSettled([getSf(), getMaia()]);
    const rejected = results.find((r): r is PromiseRejectedResult => r.status === 'rejected');
    if (rejected) throw rejected.reason;
    check();
    changed(suspended ? '引擎已暂停' : 'Stockfish 与 Maia 已就绪');
  }).catch(error => {
    if (generation === predictionGeneration && !disposed && !suspended) failure(error);
    throw error;
  });
  initializing = future;
  initializingKey = key(requested);
  initTail = future.catch(() => {});
  void future.then(() => { if (initializing === future) initializing = null; }, () => { if (initializing === future) initializing = null; });
  return future;
}

function prediction(result: MaiaResult): MaiaResult {
  if (result.moves.some(m => !Number.isFinite(m.logit) || !Number.isFinite(m.p)) ||
      result.wdl.length !== 3 || result.wdl.some(p => !Number.isFinite(p) || p < 0 || p > 1) || !Number.isFinite(result.ms)) {
    throw new Error('Maia 返回了非有限或无效的推理结果');
  }
  return result;
}

async function predict(request: PredictRequest): Promise<MaiaResult> {
  check();
  if (suspended) throw new Error('引擎已暂停');
  const position = new Chess(request.fen);
  const self = integer(request.selfElo, 1500, 0, 10000, 'selfElo');
  const opponent = integer(request.opponentElo, 1500, 0, 10000, 'opponentElo');
  const generation = predictionGeneration;
  const engine = await getMaia();
  if (suspended || generation !== predictionGeneration) throw new Error('Maia 推理已取消');
  try {
    const result = await deadline(engine.evaluate(position, [position.fen()], self, opponent), 30000, 'Maia 推理', () => engine.dispose());
    if (disposed || suspended || maia !== engine || generation !== predictionGeneration) throw new Error('Maia 推理已取消');
    return prediction(result);
  } catch (error) {
    if (!disposed && !suspended && generation === predictionGeneration && maia === engine) {
      engine.dispose();
      maia = null;
      failure(error);
    }
    throw error;
  }
}

function searchPosition(request: AnalyseRequest): { fen: string; moves: string[] } {
  const target = new Chess(request.fen);
  const moves = request.moves ?? [];
  if (!Array.isArray(moves) || moves.some(m => typeof m !== 'string' || !/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(m))) throw new Error('无效的 UCI 历史');
  if (moves.length && !request.startFen) throw new Error('提供 moves 时必须同时提供 startFen');
  const start = new Chess(request.startFen ?? request.fen);
  const fen = start.fen();
  for (const move of moves) start.move({ from: move.slice(0, 2), to: move.slice(2, 4), promotion: move[4] });
  if (start.fen() !== target.fen()) throw new Error('startFen + moves 与待分析 FEN 不一致');
  return { fen, moves };
}

function analyse(request: AnalyseRequest): Promise<SfResult> {
  check();
  const milliseconds = integer(request.milliseconds, 1000, 1, 120000, 'milliseconds');
  const multipv = integer(request.multipv, 3, 1, 256, 'multipv');
  const position = searchPosition(request);
  const generation = searchGeneration;
  const run = async (): Promise<SfResult> => {
    if (disposed || suspended || generation !== searchGeneration) return { lines: [], bestmove: null };
    const engine = await getSf();
    if (disposed || suspended || generation !== searchGeneration) return { lines: [], bestmove: null };
    // Original Stockfish already serializes searches and consumes terminal
    // bestmove. Extra barriers are installed by the bridge-only Vite transform.
    const abort = new AbortController();
    engine.send('stop');
    const done = deadline(engine.analyse(position.fen, { movetime: milliseconds, multipv, moves: position.moves, signal: abort.signal }), milliseconds + 10000, 'Stockfish 搜索', () => engine.terminate());
    const search = { abort, done };
    searches.add(search);
    try {
      const result = await done;
      if (generation !== searchGeneration || abort.signal.aborted) return { lines: [], bestmove: null };
      return { ...result, bestmove: result.bestmove === '0000' ? null : result.bestmove };
    } catch (error) {
      engine.terminate();
      if (sf === engine) sf = null;
      failure(error);
      throw error;
    } finally {
      searches.delete(search);
      changed();
    }
  };
  const future = searchTail.then(run, run);
  searchTail = future.catch(() => {});
  return future;
}

async function stop() {
  searchGeneration++;
  predictionGeneration++;
  for (const search of searches) search.abort.abort();
  sf?.send('stop');
  const active = [...searches].map(search => search.done);
  await deadline(Promise.allSettled(active), 6000, 'Stockfish stop', () => { sf?.terminate(); sf = null; });
  changed();
}

function unloadMaia() {
  maiaGeneration++;
  predictionGeneration++;
  initializing = null;
  cancelEngineStarts('maia');
  maia?.dispose();
  maia = null;
  maiaLoading = null;
  changed('Maia 已卸载');
}

async function suspend() {
  suspended = true;
  // Inference cannot be interrupted inside ORT; terminate its worker so hidden
  // tabs actually stop consuming CPU. initialize() resumes with the same model.
  unloadMaia();
  sfGeneration++;
  sfLoading = null;
  pauseEngineStarts();
  changed('引擎已暂停');
  await stop();
}

async function dispose() {
  if (disposed) return;
  disposed = true;
  suspended = true;
  pauseEngineStarts();
  sfGeneration++;
  unloadMaia();
  for (const search of searches) search.abort.abort();
  sf?.terminate();
  sf = null;
  sfLoading = null;
  changed('引擎已释放');
}

async function jsonCall<T>(run: () => T | Promise<T>): Promise<string> {
  try { return JSON.stringify(await run()); }
  catch (error) { failure(error); throw error; }
}

const bridge = {
  onChanged: null as (() => void) | null,
  state: () => JSON.stringify(state),
  initialize: (json: string) => jsonCall(async () => { await initialize(readOptions(json)); return state; }),
  predict: (json: string) => jsonCall(() => predict(JSON.parse(json) as PredictRequest)),
  analyse: (json: string) => jsonCall(() => analyse(JSON.parse(json) as AnalyseRequest)),
  stop: () => jsonCall(async () => { await stop(); return state; }),
  suspend: () => jsonCall(async () => { await suspend(); return state; }),
  unloadMaia: () => jsonCall(() => { unloadMaia(); return state; }),
  deviceInfo: () => jsonCall(() => ({ native: false, cores: navigator.hardwareConcurrency || 1, perfCores: navigator.hardwareConcurrency || 1, availableMemory: 0, physicalMemory: 0, thermalState: 0, crossOriginIsolated, provider: maia?.provider ?? 'wasm' })),
  logs: () => jsonCall(() => ({ logs: log.join('\n') })),
  dispose: () => jsonCall(async () => { await dispose(); return state; }),
};

// Background events cancel actual computation, including worker startup. No
// polling timer or recurring background watchdog belongs to this bridge.
document.addEventListener('visibilitychange', () => {
  if (document.hidden) void suspend().catch(failure);
});
window.addEventListener('pagehide', () => { void suspend().catch(failure); });
Object.assign(globalThis, { maiaFlutter: bridge });

export type MaiaFlutterBridge = typeof bridge;
