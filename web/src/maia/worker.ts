import * as ort from 'onnxruntime-web';
import { buildTokens, FEAT } from './encode';

export type WorkerIn =
  | { type: 'load'; reqId: number; modelBase: string; backend: 'wasm' | 'webgpu'; numThreads: number }
  | { type: 'eval'; reqId: number; fens: string[]; indices: number[]; selfElo: number; oppoElo: number };

export type WorkerOut =
  | { type: 'progress'; loaded: number; total: number }
  | { type: 'loaded'; reqId: number; backend: string }
  | { type: 'result'; reqId: number; logits: Float32Array; wdl: [number, number, number]; ms: number }
  | { type: 'error'; reqId: number; message: string };

const ctx = self as unknown as {
  postMessage(m: WorkerOut, transfer?: Transferable[]): void;
  onmessage: ((e: MessageEvent<WorkerIn>) => void) | null;
};

let session: ort.InferenceSession | null = null;
let envConfigured = false;

async function fetchModel(base: string): Promise<Uint8Array> {
  const manifest = (await (await fetch(base + 'manifest.json')).json()) as { size: number; parts: string[] };
  const buf = new Uint8Array(manifest.size);
  let off = 0;
  for (const part of manifest.parts) {
    const res = await fetch(base + part);
    if (!res.ok || !res.body) throw new Error(`下载模型失败 ${part}: HTTP ${res.status}`);
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf.set(value, off);
      off += value.byteLength;
      ctx.postMessage({ type: 'progress', loaded: off, total: manifest.size });
    }
  }
  if (off !== manifest.size) throw new Error('模型文件不完整，请清除缓存后重试');
  return buf;
}

// ORT spawns its pthread workers from this same script; leave those to emscripten.
if (!self.name?.startsWith('em-pthread')) ctx.onmessage = async (e) => {
  const msg = e.data;
  try {
    if (msg.type === 'load') {
      if (!envConfigured) {
        ort.env.wasm.numThreads = msg.numThreads;
        envConfigured = true;
      }
      if (session) {
        await session.release();
        session = null;
      }
      const bytes = await fetchModel(msg.modelBase);
      session = await ort.InferenceSession.create(bytes, {
        executionProviders: msg.backend === 'webgpu' ? ['webgpu', 'wasm'] : ['wasm'],
        graphOptimizationLevel: 'all',
      });
      ctx.postMessage({ type: 'loaded', reqId: msg.reqId, backend: msg.backend });
    } else if (msg.type === 'eval') {
      if (!session) throw new Error('模型尚未加载');
      const t0 = performance.now();
      const out = await session.run({
        tokens: new ort.Tensor('float32', buildTokens(msg.fens), [1, 64, FEAT]),
        self_elo: new ort.Tensor('float32', Float32Array.of(msg.selfElo), [1]),
        oppo_elo: new ort.Tensor('float32', Float32Array.of(msg.oppoElo), [1]),
      });
      const all = out.logits_move.data as Float32Array;
      const v = out.logits_value.data as Float32Array;
      const logits = Float32Array.from(msg.indices, (i) => all[i]);
      // value head order is [loss, draw, win] for the side to move
      const m = Math.max(v[0], v[1], v[2]);
      const ex = [v[0], v[1], v[2]].map((x) => Math.exp(x - m));
      const s = ex[0] + ex[1] + ex[2];
      const wdl: [number, number, number] = [ex[2] / s, ex[1] / s, ex[0] / s];
      ctx.postMessage({ type: 'result', reqId: msg.reqId, logits, wdl, ms: performance.now() - t0 }, [logits.buffer]);
    }
  } catch (err) {
    ctx.postMessage({ type: 'error', reqId: msg.reqId, message: err instanceof Error ? err.message : String(err) });
  }
};
