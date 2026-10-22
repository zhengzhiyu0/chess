import type { Chess } from 'chess.js';
import { buildTokens, legalMoveIndices, uciToIndex } from './encode';
import { softmaxMoves, type ScoredMove } from './sample';
import type { WorkerIn, WorkerOut } from './worker';
import { wdlFromValue } from './wdl';
import { isNative } from '../native';

export type ModelId = '5m' | '23m' | '79m';

export const MODELS: Record<ModelId, { label: string; mb: number }> = {
  '5m': { label: 'Maia-3 5M（最快）', mb: 21 },
  '23m': { label: 'Maia-3 23M（推荐）', mb: 91 },
  '79m': { label: 'Maia-3 79M（最准）', mb: 312 },
};

export interface MaiaResult {
  moves: ScoredMove[];
  /** side-to-move POV, probabilities */
  wdl: [number, number, number];
  ms: number;
}

export interface MaiaJob {
  chess: Chess;
  fens: string[];
  selfElo: number;
  oppoElo: number;
}

type Pending = { resolve: (v: WorkerOut) => void; reject: (e: Error) => void };
type Req = WorkerIn extends infer T ? (T extends { reqId: number } ? Omit<T, 'reqId'> : never) : never;

export type MaiaBackend = 'wasm' | 'webgpu' | 'native';

const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
const START_LEGAL = ['a2a3', 'a2a4', 'b2b3', 'b2b4', 'c2c3', 'c2c4', 'd2d3', 'd2d4', 'e2e3', 'e2e4', 'f2f3', 'f2f4', 'g2g3', 'g2g4', 'h2h3', 'h2h4', 'b1a3', 'b1c3', 'g1f3', 'g1h3'];
const START_TOP = ['e2e4', 'd2d4', 'c2c4', 'g1f3'];

function toBase64(f: Float32Array): string {
  const bytes = new Uint8Array(f.buffer, f.byteOffset, f.byteLength);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

/** The app's native Maia (ONNX Runtime + CoreML, see native-plugins/maia-native). */
class NativeMaia {
  private dead = false;
  provider = '';
  private constructor(readonly model: ModelId) {}

  get alive() {
    return !this.dead;
  }

  static async create(model: ModelId): Promise<NativeMaia> {
    const { MaiaNative } = await import('maia-native');
    const m = new NativeMaia(model);
    const res = await MaiaNative.load({
      model,
      probeTokens: toBase64(buildTokens([START])),
      probeLegal: START_LEGAL.map(uciToIndex),
      probeTop: START_TOP.map(uciToIndex),
    });
    m.provider = res.provider;
    return m;
  }

  async evaluate(chess: Chess, fens: string[], selfElo: number, oppoElo: number): Promise<MaiaResult> {
    return (await this.evaluateMany([{ chess, fens, selfElo, oppoElo }]))[0];
  }

  async evaluateMany(jobs: MaiaJob[]): Promise<MaiaResult[]> {
    if (this.dead) throw new Error('Maia 已卸载');
    const legal = jobs.map((j) => legalMoveIndices(j.chess));
    const live = jobs.map((_, i) => i).filter((i) => legal[i].length > 0);
    const out: MaiaResult[] = jobs.map(() => ({ moves: [], wdl: [0, 1, 0], ms: 0 }));
    if (!live.length) return out;
    const { MaiaNative } = await import('maia-native');
    const items = live.map((i) => ({
      tokens: toBase64(buildTokens(jobs[i].fens)),
      indices: legal[i].map((l) => l.index),
      selfElo: jobs[i].selfElo,
      oppoElo: jobs[i].oppoElo,
    }));
    const results = items.length === 1 ? [await MaiaNative.eval(items[0])] : (await MaiaNative.evalBatch({ items })).results;
    live.forEach((i, k) => {
      const res = results[k];
      const moves = softmaxMoves(legal[i].map((l, j) => ({ uci: l.uci, logit: res.logits[j] })));
      out[i] = { moves, wdl: wdlFromValue(res.value), ms: res.ms };
    });
    return out;
  }

  dispose() {
    if (this.dead) return;
    this.dead = true;
    void import('maia-native').then(({ MaiaNative }) => MaiaNative.unload());
  }
}

export class Maia {
  private worker!: Worker;
  private native: NativeMaia | null = null;
  private pending = new Map<number, Pending>();
  private nextId = 1;
  private dead = false;
  onProgress: ((loaded: number, total: number) => void) | null = null;

  private constructor(readonly model: ModelId, readonly backend: MaiaBackend) {
    if (backend === 'native') return;
    this.worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
    this.worker.onmessage = (e: MessageEvent<WorkerOut>) => {
      const msg = e.data;
      if (msg.type === 'progress') {
        this.onProgress?.(msg.loaded, msg.total);
        return;
      }
      const p = this.pending.get(msg.reqId);
      if (!p) return;
      this.pending.delete(msg.reqId);
      if (msg.type === 'error') p.reject(new Error(msg.message));
      else p.resolve(msg);
    };
    // a crashed worker (e.g. killed for memory on iOS) never answers again
    this.worker.onerror = (e) => this.fail(e.message || 'Maia worker error');
  }

  /** false once disposed or crashed; callers should create a new instance */
  get alive() {
    return !this.dead && (this.native?.alive ?? true);
  }

  /** where inference actually runs: 'coreml' / 'cpu' for the native app, else the requested backend */
  get provider(): string {
    return this.native?.provider ?? this.backend;
  }

  private fail(message: string) {
    this.dead = true;
    if (this.native) this.native.dispose();
    else this.worker.terminate();
    for (const p of this.pending.values()) p.reject(new Error(message));
    this.pending.clear();
  }

  private call(msg: Req, timeout = 0): Promise<WorkerOut> {
    if (this.dead) return Promise.reject(new Error('Maia 已卸载'));
    const reqId = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(reqId, { resolve, reject });
      this.worker.postMessage({ ...msg, reqId });
      if (!timeout) return;
      const check = () => {
        if (!this.pending.has(reqId)) return;
        // the page may be suspended in the background; only count visible time
        if (document.hidden) setTimeout(check, timeout);
        else this.fail('Maia 无响应');
      };
      setTimeout(check, timeout);
    });
  }

  /** In the iOS app `backend` is ignored: the native engine is always used. */
  static async create(
    model: ModelId,
    backend: 'wasm' | 'webgpu',
    onProgress?: (loaded: number, total: number) => void,
    lean = false,
    threads?: number,
  ): Promise<Maia> {
    if (isNative) {
      const m = new Maia(model, 'native');
      m.native = await NativeMaia.create(model);
      return m;
    }
    const m = new Maia(model, backend);
    m.onProgress = onProgress ?? null;
    const numThreads = threads ?? (self.crossOriginIsolated ? Math.max(1, Math.min(4, navigator.hardwareConcurrency || 1)) : 1);
    try {
      await m.call({
        type: 'load',
        modelBase: new URL(`models/maia3-${model}/`, document.baseURI).href,
        backend,
        numThreads,
        lean,
      });
    } catch (err) {
      m.dispose();
      throw err;
    }
    return m;
  }

  /** `fens`: all positions of the game so far (oldest first) ending with `chess`'s position. */
  async evaluate(chess: Chess, fens: string[], selfElo: number, oppoElo: number): Promise<MaiaResult> {
    if (this.native) {
      if (this.dead) throw new Error('Maia 已卸载');
      return this.native.evaluate(chess, fens, selfElo, oppoElo);
    }
    const legal = legalMoveIndices(chess);
    if (legal.length === 0) return { moves: [], wdl: [0, 1, 0], ms: 0 };
    const res = await this.call({ type: 'eval', fens, indices: legal.map((l) => l.index), selfElo, oppoElo }, 20000);
    if (res.type !== 'result') throw new Error('unexpected worker reply');
    const moves = softmaxMoves(legal.map((l, i) => ({ uci: l.uci, logit: res.logits[i] })));
    return { moves, wdl: res.wdl, ms: res.ms };
  }

  /** Several positions; in the iOS app they share one bridge round trip. */
  async evaluateMany(jobs: MaiaJob[]): Promise<MaiaResult[]> {
    if (this.native) {
      if (this.dead) throw new Error('Maia 已卸载');
      return this.native.evaluateMany(jobs);
    }
    const out: MaiaResult[] = [];
    for (const j of jobs) out.push(await this.evaluate(j.chess, j.fens, j.selfElo, j.oppoElo));
    return out;
  }

  dispose() {
    this.fail('Maia 已卸载');
  }
}
