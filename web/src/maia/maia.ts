import type { Chess } from 'chess.js';
import { legalMoveIndices } from './encode';
import { softmaxMoves, type ScoredMove } from './sample';
import type { WorkerIn, WorkerOut } from './worker';

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

type Pending = { resolve: (v: WorkerOut) => void; reject: (e: Error) => void };
type Req = WorkerIn extends infer T ? (T extends { reqId: number } ? Omit<T, 'reqId'> : never) : never;

export class Maia {
  private worker: Worker;
  private pending = new Map<number, Pending>();
  private nextId = 1;
  onProgress: ((loaded: number, total: number) => void) | null = null;

  private constructor(readonly model: ModelId, readonly backend: 'wasm' | 'webgpu') {
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
    this.worker.onerror = (e) => {
      for (const p of this.pending.values()) p.reject(new Error(e.message || 'Maia worker error'));
      this.pending.clear();
    };
  }

  private call(msg: Req): Promise<WorkerOut> {
    const reqId = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(reqId, { resolve, reject });
      this.worker.postMessage({ ...msg, reqId });
    });
  }

  static async create(
    model: ModelId,
    backend: 'wasm' | 'webgpu',
    onProgress?: (loaded: number, total: number) => void,
  ): Promise<Maia> {
    const m = new Maia(model, backend);
    m.onProgress = onProgress ?? null;
    const numThreads = self.crossOriginIsolated ? Math.max(1, Math.min(4, navigator.hardwareConcurrency || 1)) : 1;
    try {
      await m.call({
        type: 'load',
        modelBase: new URL(`models/maia3-${model}/`, document.baseURI).href,
        backend,
        numThreads,
      });
    } catch (err) {
      m.dispose();
      throw err;
    }
    return m;
  }

  /** `fens`: all positions of the game so far (oldest first) ending with `chess`'s position. */
  async evaluate(chess: Chess, fens: string[], selfElo: number, oppoElo: number): Promise<MaiaResult> {
    const legal = legalMoveIndices(chess);
    if (legal.length === 0) return { moves: [], wdl: [0, 1, 0], ms: 0 };
    const res = await this.call({ type: 'eval', fens, indices: legal.map((l) => l.index), selfElo, oppoElo });
    if (res.type !== 'result') throw new Error('unexpected worker reply');
    const moves = softmaxMoves(legal.map((l, i) => ({ uci: l.uci, logit: res.logits[i] })));
    return { moves, wdl: res.wdl, ms: res.ms };
  }

  dispose() {
    this.worker.terminate();
    for (const p of this.pending.values()) p.reject(new Error('Maia 已卸载'));
    this.pending.clear();
  }
}
