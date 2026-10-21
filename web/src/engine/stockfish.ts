import { isNative } from '../native';
import type { SfFlavour } from 'maia-native';

export interface SfLine {
  multipv: number;
  depth: number;
  /** side-to-move POV */
  cp?: number;
  mate?: number;
  wdl?: [number, number, number];
  pv: string[];
}

export interface SfResult {
  lines: SfLine[];
  bestmove: string | null;
}

export interface AnalyseOpts {
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
 * singleton that can't be torn down, so closing just stops the search and detaches listeners.
 */
class NativeTransport implements Transport {
  private static subs: Record<SfFlavour, Set<(l: string) => void>> = { full: new Set(), lite: new Set() };
  private static hooked: Promise<unknown> | null = null;
  private onLine: (l: string) => void;

  private constructor(private flavour: SfFlavour, onLine: (l: string) => void) {
    this.onLine = onLine;
  }

  static async open(flavour: SfFlavour, onLine: (l: string) => void): Promise<NativeTransport> {
    const { StockfishNative } = await import('maia-native');
    NativeTransport.hooked ??= StockfishNative.addListener('lines', (e) => {
      for (const h of [...NativeTransport.subs[e.engine]]) for (const l of e.lines) h(l);
    });
    await NativeTransport.hooked;
    // a previous instance may have been dropped mid-search; it must not see this one's output
    NativeTransport.subs[flavour].clear();
    const t = new NativeTransport(flavour, onLine);
    NativeTransport.subs[flavour].add(onLine);
    await StockfishNative.start({ engine: flavour });
    t.post('stop');
    t.post('ucinewgame');
    return t;
  }

  post(cmd: string) {
    void import('maia-native').then(({ StockfishNative }) =>
      StockfishNative.send({ engine: this.flavour, cmd }).catch((e) => console.error('Stockfish native', e)),
    );
  }

  close() {
    this.post('stop');
    NativeTransport.subs[this.flavour].delete(this.onLine);
  }
}

export class Stockfish {
  private transport!: Transport;
  private listeners = new Set<(line: string) => void>();
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
    // compiling the ~100MB NNUE build takes 5-20s in Firefox / on phones (longer while Maia loads)
    return sf.handshake(threads, hash, 90000);
  }

  private async handshake(threads: number, hash: number, timeoutMs: number): Promise<Stockfish> {
    try {
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
        this.waitFor('uci', (l) => l === 'uciok').then(resolve, reject);
      });
      this.failed = null;
      if (this.multiThreaded) this.send(`setoption name Threads value ${threads}`);
      this.send(`setoption name Hash value ${hash}`);
      this.send('setoption name UCI_ShowWDL value true');
      await this.waitFor('isready', (l) => l === 'readyok');
    } catch (err) {
      this.terminate();
      throw err;
    }
    return this;
  }

  send(cmd: string) {
    this.transport.post(cmd);
  }

  private waitFor(cmd: string, done: (line: string) => boolean): Promise<void> {
    return new Promise((resolve) => {
      const h = (l: string) => {
        if (done(l)) {
          this.listeners.delete(h);
          resolve();
        }
      };
      this.listeners.add(h);
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
        arm(opts.depth ? 120000 : (opts.movetime ?? 1000) + 4000, () => {
          this.send('stop');
          arm(4000, () => {
            console.warn('Stockfish 无响应，已重启');
            this.terminate();
          });
        });
        const h = (l: string) => {
          const info = parseInfo(l);
          if (info) {
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
        this.send(opts.depth ? `go depth ${opts.depth}` : `go movetime ${opts.movetime ?? 1000}`);
      });
    const p = this.queue.then(run, run);
    this.queue = p.catch(() => undefined);
    return p;
  }

  terminate() {
    if (this.dead) return;
    this.dead = true;
    this.transport?.close();
    // flush pending searches so awaiting callers resolve instead of hanging
    for (const h of [...this.listeners]) h('bestmove (none)');
    this.listeners.clear();
  }
}
