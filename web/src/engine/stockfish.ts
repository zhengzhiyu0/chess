import { isNative } from '../native';
import type { SfFlavour, StockfishNativePlugin } from 'maia-native';

export interface SfLine {
  multipv: number;
  depth: number;
  /** side-to-move POV */
  cp?: number;
  mate?: number;
  bound?: 'lowerbound' | 'upperbound';
  wdl?: [number, number, number];
  pv: string[];
}

export interface SfResult {
  lines: SfLine[];
  bestmove: string | null;
}

export interface AnalyseOpts {
  /** with `depth` too, the search stops at whichever limit comes first */
  movetime?: number;
  depth?: number;
  multipv?: number;
  /** moves played from `fen` (lets Stockfish see repetitions) */
  moves?: string[];
  signal?: AbortSignal;
  onInfo?: (lines: SfLine[]) => void;
}

export function parseInfo(line: string): SfLine | null {
  if (!line.startsWith('info ') || !line.includes(' pv ')) return null;
  const t = line.split(/\s+/);
  const out: SfLine = { multipv: 1, depth: 0, pv: [] };
  for (let i = 1; i < t.length; i++) {
    switch (t[i]) {
      case 'depth':
        out.depth = Number(t[++i]);
        break;
      case 'multipv':
        out.multipv = Number(t[++i]);
        break;
      case 'score': {
        const kind = t[++i];
        const v = Number(t[++i]);
        if (kind === 'cp') out.cp = v;
        else out.mate = v;
        break;
      }
      case 'lowerbound':
      case 'upperbound':
        out.bound = t[i] as SfLine['bound'];
        break;
      case 'wdl': {
        const w = Number(t[++i]);
        const d = Number(t[++i]);
        const l = Number(t[++i]);
        out.wdl = [w, d, l];
        break;
      }
      case 'pv':
        out.pv = t.slice(i + 1);
        i = t.length;
        break;
    }
  }
  return out;
}

/** Carries UCI text to and from one engine instance. */
interface Transport {
  post(cmd: string): void;
  /** stop delivering output and free what can be freed */
  close(): void;
}

class WorkerTransport implements Transport {
  private worker: Worker;
  constructor(url: string, onLine: (l: string) => void, onError: (e: Error) => void) {
    this.worker = new Worker(url);
    this.worker.onmessage = (e: MessageEvent) => {
      if (typeof e.data === 'string') onLine(e.data);
    };
    this.worker.onerror = (e) => onError(new Error(e.message || 'Stockfish worker error'));
  }
  post(cmd: string) {
    this.worker.postMessage(cmd);
  }
  close() {
    this.worker.terminate();
  }
}

/**
 * The in-app native engine (see native-plugins/maia-native). Each flavour is a process-wide
 * singleton that can't be torn down; closing stops search, shrinks Hash, and detaches listeners.
 */
class NativeTransport implements Transport {
  private static subs: Record<SfFlavour, Set<(l: string) => void>> = { full: new Set(), lite: new Set() };
  private static hooked: Promise<unknown> | null = null;
  private onLine: (l: string) => void;

  private constructor(private flavour: SfFlavour, onLine: (l: string) => void, private plugin: StockfishNativePlugin) {
    this.onLine = onLine;
  }

  static async open(flavour: SfFlavour, onLine: (l: string) => void): Promise<NativeTransport> {
    const requested = performance.now();
    let stage = 'plugin_import';
    let stageStart = requested;
    console.info('[engine/Stockfish] native start requested', { engine: flavour });
    try {
      // Platform-specific Capacitor bridge is unavailable in browser/worker runtimes.
      const { StockfishNative } = await import('maia-native');
      console.info('[engine/Stockfish] plugin imported', { engine: flavour, import_ms: (performance.now() - stageStart).toFixed(1) });
      stage = 'output_listener';
      stageStart = performance.now();
      NativeTransport.hooked ??= StockfishNative.addListener('lines', (e) => {
        for (const h of [...NativeTransport.subs[e.engine]]) for (const l of e.lines) h(l);
      }).catch((err) => {
        NativeTransport.hooked = null;
        throw err;
      });
      await NativeTransport.hooked;
      console.info('[engine/Stockfish] output listener ready', { engine: flavour, listener_ms: (performance.now() - stageStart).toFixed(1) });
      // a previous instance may have been dropped mid-search; it must not see this one's output
      NativeTransport.subs[flavour].clear();
      const t = new NativeTransport(flavour, onLine, StockfishNative);
      NativeTransport.subs[flavour].add(onLine);
      stage = 'native_start';
      stageStart = performance.now();
      await StockfishNative.start({ engine: flavour });
      if (!NativeTransport.subs[flavour].has(onLine)) throw new Error('Stockfish 已卸载');
      t.post('stop');
      t.post('ucinewgame');
      console.info('[engine/Stockfish] native start dispatched', { engine: flavour, bridge_start_ms: (performance.now() - stageStart).toFixed(1), total_ms: (performance.now() - requested).toFixed(1), ready: 'pending_uci_handshake' });
      return t;
    } catch (err) {
      NativeTransport.subs[flavour].delete(onLine);
      console.info('[engine/Stockfish] native start failed', { engine: flavour, stage, stage_ms: (performance.now() - stageStart).toFixed(1), total_ms: (performance.now() - requested).toFixed(1), error: err instanceof Error ? err.message : String(err) });
      throw err;
    }
  }

  post(cmd: string) {
    void this.plugin.send({ engine: this.flavour, cmd }).catch((e) => console.error('Stockfish native', e));
  }

  close() {
    // a newer instance has taken over this engine; stopping it would cut that one's search short
    if (NativeTransport.subs[this.flavour].delete(this.onLine)) {
      this.post('stop');
      this.post('setoption name Hash value 1');
      this.post('ucinewgame');
    }
  }
}

export class Stockfish {
  private transport!: Transport;
  private listeners = new Set<(line: string) => void>();
  /** rejects of pending waitFor() calls, so terminate() can fail them instead of leaving them hanging */
  private waiters = new Set<(e: Error) => void>();
  private queue: Promise<unknown> = Promise.resolve();
  private failed: ((e: Error) => void) | null = null;
  private dead = false;

  private constructor(readonly multiThreaded: boolean, readonly threads: number, readonly lite: boolean, readonly native = false) {}

  private onLine = (line: string) => {
    for (const h of [...this.listeners]) h(line);
  };

  private onError = (err: Error) => {
    if (this.failed) this.failed(err);
    else {
      console.error(err);
      this.terminate();
    }
  };

  /** false once terminated or crashed; callers should create a new instance */
  get alive() {
    return !this.dead;
  }

  static async create(threads: number, hash: number, lite = false): Promise<Stockfish> {
    if (isNative) {
      const sf = new Stockfish(true, threads, lite, true);
      sf.transport = await NativeTransport.open(lite ? 'lite' : 'full', sf.onLine);
      return sf.handshake(threads, hash, 30000);
    }
    const multi = self.crossOriginIsolated && typeof SharedArrayBuffer !== 'undefined';
    try {
      return await Stockfish.boot(multi, threads, hash, lite);
    } catch (err) {
      if (!multi) throw err;
      console.warn('多线程 Stockfish 启动失败，改用单线程', err);
      return Stockfish.boot(false, 1, hash, lite);
    }
  }

  private static async boot(multi: boolean, threads: number, hash: number, lite: boolean): Promise<Stockfish> {
    const file = `engines/stockfish-19${lite ? '-lite' : ''}${multi ? '' : '-single'}.js`;
    const sf = new Stockfish(multi, multi ? threads : 1, lite);
    sf.transport = new WorkerTransport(new URL(file, document.baseURI).href, sf.onLine, sf.onError);
    console.info('[engine/Stockfish] worker created', { engine: lite ? 'lite' : 'full', multiThreaded: multi, threads: sf.threads });
    // compiling the ~100MB NNUE build takes 5-20s in Firefox / on phones (longer while Maia loads)
    return sf.handshake(threads, hash, 90000);
  }

  private async handshake(threads: number, hash: number, timeoutMs: number): Promise<Stockfish> {
    const requested = performance.now();
    const context = { engine: this.lite ? 'lite' : 'full', native: this.native, threads: this.threads, hash };
    let stage = 'uci_startup';
    let stageStart = requested;
    console.info('[engine/Stockfish] handshake requested', context);
    try {
      // Keep the executor form: the ES2022 iOS runtime baseline has no Promise.withResolvers.
      await new Promise<void>((resolve, reject) => {
        this.failed = reject;
        // only count time the page is visible, since background tabs are throttled
        let left = timeoutMs;
        const tick = () => {
          if (!this.failed || this.dead) return;
          if (!document.hidden) left -= 1000;
          if (left <= 0) reject(new Error('Stockfish 启动超时'));
          else setTimeout(tick, 1000);
        };
        setTimeout(tick, 1000);
        // The first uciok includes startup/initialization (and may include NNUE loading),
        // not a pure NNUE timer. isready barriers below measure completed option application.
        this.waitFor('uci', (l) => l === 'uciok')
          .then(async () => {
            console.info('[engine/Stockfish] startup uciok', { ...context, startup_handshake_ms: (performance.now() - stageStart).toFixed(1), includes: 'initialization/possibly_NNUE_loading', NNUE_only_ms: 'unavailable' });
            if (this.multiThreaded) {
              stage = 'Threads_ready_barrier';
              stageStart = performance.now();
              this.send(`setoption name Threads value ${threads}`);
              await this.waitFor('isready', (l) => l === 'readyok');
              console.info('[engine/Stockfish] Threads applied (isready barrier)', { ...context, Threads_ready_ms: (performance.now() - stageStart).toFixed(1) });
            } else {
              console.info('[engine/Stockfish] Threads unchanged', { ...context, reason: 'single_threaded' });
            }
            stage = 'Hash_ready_barrier';
            stageStart = performance.now();
            this.send(`setoption name Hash value ${hash}`);
            await this.waitFor('isready', (l) => l === 'readyok');
            console.info('[engine/Stockfish] Hash applied (isready barrier)', { ...context, Hash_ready_ms: (performance.now() - stageStart).toFixed(1) });
            stage = 'final_ready_barrier';
            stageStart = performance.now();
            this.send('setoption name UCI_ShowWDL value true');
            await this.waitFor('isready', (l) => l === 'readyok');
            console.info('[engine/Stockfish] final readyok (isready barrier)', { ...context, ready_ms: (performance.now() - stageStart).toFixed(1), total_ms: (performance.now() - requested).toFixed(1) });
          })
          .then(resolve, reject);
      });
    } catch (err) {
      console.info('[engine/Stockfish] handshake failed', { ...context, stage, stage_ms: (performance.now() - stageStart).toFixed(1), total_ms: (performance.now() - requested).toFixed(1), error: err instanceof Error ? err.message : String(err) });
      this.terminate();
      throw err;
    } finally {
      this.failed = null;
    }
    return this;
  }

  send(cmd: string) {
    this.transport.post(cmd);
  }

  private waitFor(cmd: string, done: (line: string) => boolean): Promise<void> {
    if (this.dead) return Promise.reject(new Error('Stockfish 已终止'));
    return new Promise((resolve, reject) => {
      const fail = (e: Error) => {
        this.listeners.delete(h);
        reject(e);
      };
      const h = (l: string) => {
        if (done(l)) {
          this.listeners.delete(h);
          this.waiters.delete(fail);
          resolve();
        }
      };
      this.listeners.add(h);
      this.waiters.add(fail);
      this.send(cmd);
    });
  }

  /** Searches are serialized; abort `signal` to stop the current or a queued search early. */
  analyse(fen: string, opts: AnalyseOpts = {}): Promise<SfResult> {
    const run = () =>
      new Promise<SfResult>((resolve) => {
        if (opts.signal?.aborted || this.dead) {
          resolve({ lines: [], bestmove: null });
          return;
        }
        const lines = new Map<number, SfLine>();
        const sorted = () => [...lines.values()].sort((a, b) => a.multipv - b.multipv);
        const onAbort = () => this.send('stop');
        opts.signal?.addEventListener('abort', onAbort, { once: true });
        // watchdog: an overrunning search gets "stop"; an engine that ignores it is killed,
        // which resolves this and every queued search instead of hanging forever
        let timer: ReturnType<typeof setTimeout> | undefined;
        const arm = (ms: number, fn: () => void) => {
          timer = setTimeout(() => (document.hidden ? arm(ms, fn) : fn()), ms);
        };
        arm(opts.depth && !opts.movetime ? 120000 : (opts.movetime ?? 1000) + 4000, () => {
          this.send('stop');
          arm(4000, () => {
            console.warn('Stockfish 无响应，已重启');
            this.terminate();
          });
        });
        const h = (l: string) => {
          const info = parseInfo(l);
          if (info) {
            const previous = lines.get(info.multipv);
            if (info.bound && previous && !previous.bound) return;
            lines.set(info.multipv, info);
            opts.onInfo?.(sorted());
            return;
          }
          if (l.startsWith('bestmove')) {
            clearTimeout(timer);
            this.listeners.delete(h);
            opts.signal?.removeEventListener('abort', onAbort);
            const bm = l.split(' ')[1];
            resolve({ lines: sorted(), bestmove: bm && bm !== '(none)' ? bm : null });
          }
        };
        this.listeners.add(h);
        this.send(`setoption name MultiPV value ${opts.multipv ?? 1}`);
        this.send(`position fen ${fen}${opts.moves?.length ? ' moves ' + opts.moves.join(' ') : ''}`);
        // both limits may be given: the search ends at whichever is reached first
        const limits = [opts.depth ? `depth ${opts.depth}` : '', opts.movetime || !opts.depth ? `movetime ${opts.movetime ?? 1000}` : ''];
        this.send(`go ${limits.filter(Boolean).join(' ')}`);
      });
    const p = this.queue.then(run, run);
    this.queue = p.catch(() => undefined);
    return p;
  }

  terminate() {
    if (this.dead) return;
    this.dead = true;
    this.transport?.close();
    // fail pending handshake steps and flush pending searches so awaiting callers don't hang
    for (const w of [...this.waiters]) w(new Error('Stockfish 已终止'));
    this.waiters.clear();
    for (const h of [...this.listeners]) h('bestmove (none)');
    this.listeners.clear();
  }
}
