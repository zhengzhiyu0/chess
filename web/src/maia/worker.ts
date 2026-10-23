import * as ort from 'onnxruntime-web';
import { buildTokens, FEAT, NUM_MOVES, uciToIndex } from './encode';
import { wdlFromValue } from './wdl';

export type WorkerIn =
  | { type: 'load'; reqId: number; modelBase: string; backend: 'wasm' | 'webgpu'; numThreads: number; lean: boolean }
  | { type: 'eval'; reqId: number; fens: string[]; indices: number[]; selfElo: number; oppoElo: number };

export type WorkerOut =
  | { type: 'progress'; loaded: number; total: number }
  /** the worker took the request off its queue; the page times the request from here */
  | { type: 'started'; reqId: number }
  | { type: 'loaded'; reqId: number; backend: string }
  | { type: 'result'; reqId: number; logits: Float32Array; wdl: [number, number, number]; ms: number }
  | { type: 'error'; reqId: number; message: string };

const ctx = self as unknown as {
  postMessage(m: WorkerOut, transfer?: Transferable[]): void;
  onmessage: ((e: MessageEvent<WorkerIn>) => void) | null;
};

let session: ort.InferenceSession | null = null;
let envConfigured = false;

const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
// the 20 legal moves of the start position, as move-vocabulary indices
const START_LEGAL = ['a2a3', 'a2a4', 'b2b3', 'b2b4', 'c2c3', 'c2c4', 'd2d3', 'd2d4', 'e2e3', 'e2e4', 'f2f3', 'f2f4', 'g2g3', 'g2g4', 'h2h3', 'h2h4', 'b1a3', 'b1c3', 'g1f3', 'g1h3'].map(uciToIndex);
const START_TOP = new Set(['e2e4', 'd2d4', 'c2c4', 'g1f3'].map(uciToIndex));

/** Every Maia size at 1500 puts a mainstream first move on top with real confidence. */
function plausibleStart(logits: Float32Array): boolean {
  if (logits.length !== NUM_MOVES || !logits.every(Number.isFinite)) return false;
  const l = START_LEGAL.map((i) => logits[i]);
  const max = Math.max(...l);
  const top = START_LEGAL[l.indexOf(max)];
  const p = 1 / l.reduce((a, x) => a + Math.exp(x - max), 0);
  return START_TOP.has(top) && p > 0.2;
}

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

async function handle(msg: WorkerIn) {
  ctx.postMessage({ type: 'started', reqId: msg.reqId });
  try {
    if (msg.type === 'load') {
      if (!envConfigured) {
        ort.env.wasm.numThreads = msg.numThreads;
        ort.env.webgpu.powerPreference = 'high-performance';
        envConfigured = true;
      }
      if (session) {
        await session.release();
        session = null;
      }
      let bytes: Uint8Array | null = await fetchModel(msg.modelBase);
      // wasm memory never shrinks, so peak usage is what counts; these trim ~15% on the 79M model
      const lean: ort.InferenceSession.SessionOptions = msg.lean
        ? { enableCpuMemArena: false, enableMemPattern: false, extra: { session: { disable_prepacking: '1' } } }
        : {};
      session = await ort.InferenceSession.create(bytes, {
        executionProviders: msg.backend === 'webgpu' ? ['webgpu', 'wasm'] : ['wasm'],
        graphOptimizationLevel: 'all',
        ...lean,
      });
      bytes = null;
      // Doubles as warm-up (the first run is several times slower) and as a sanity check: a broken
      // backend (e.g. a WebGPU shader that failed to compile) returns zero/garbage logits, which
      // makes Maia play random moves; reject it so the caller falls back to WASM.
      const probe = await session.run({
        tokens: new ort.Tensor('float32', buildTokens([START]), [1, 64, FEAT]),
        self_elo: new ort.Tensor('float32', Float32Array.of(1500), [1]),
        oppo_elo: new ort.Tensor('float32', Float32Array.of(1500), [1]),
      });
      if (!plausibleStart(probe.logits_move.data as Float32Array)) {
        await session.release();
        session = null;
        throw new Error(`${msg.backend === 'webgpu' ? 'WebGPU' : 'WASM'} 推理结果异常`);
      }
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
      const wdl = wdlFromValue(v);
      ctx.postMessage({ type: 'result', reqId: msg.reqId, logits, wdl, ms: performance.now() - t0 }, [logits.buffer]);
    }
  } catch (err) {
    ctx.postMessage({ type: 'error', reqId: msg.reqId, message: err instanceof Error ? err.message : String(err) });
  }
}

// one request at a time: a session must not run concurrently (WebGPU: "Session already started")
let chain: Promise<void> = Promise.resolve();

// ORT spawns its pthread workers from this same script; leave those to emscripten.
if (!self.name?.startsWith('em-pthread')) ctx.onmessage = (e) => {
  const msg = e.data;
  chain = chain.then(() => handle(msg));
};
