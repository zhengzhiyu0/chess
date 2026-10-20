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

export class Stockfish {
  private worker: Worker;
  private listeners = new Set<(line: string) => void>();
  private queue: Promise<unknown> = Promise.resolve();
  private failed: ((e: Error) => void) | null = null;
  private dead = false;

  private constructor(url: string, readonly multiThreaded: boolean, readonly threads: number) {
    this.worker = new Worker(url);
    this.worker.onmessage = (e: MessageEvent) => {
      if (typeof e.data !== 'string') return;
      for (const h of [...this.listeners]) h(e.data);
    };
    this.worker.onerror = (e) => {
      const err = new Error(e.message || 'Stockfish worker error');
      if (this.failed) this.failed(err);
      else {
        console.error(err);
        this.terminate();
      }
    };
  }

  /** false once terminated or crashed; callers should create a new instance */
  get alive() {
    return !this.dead;
  }

  static async create(threads: number, hash: number): Promise<Stockfish> {
    const multi = self.crossOriginIsolated && typeof SharedArrayBuffer !== 'undefined';
    try {
      return await Stockfish.boot(multi, threads, hash);
    } catch (err) {
      if (!multi) throw err;
      console.warn('多线程 Stockfish 启动失败，改用单线程', err);
      return Stockfish.boot(false, 1, hash);
    }
  }

  private static async boot(multi: boolean, threads: number, hash: number): Promise<Stockfish> {
    const file = multi ? 'engines/stockfish-19.js' : 'engines/stockfish-19-single.js';
    const sf = new Stockfish(new URL(file, document.baseURI).href, multi, multi ? threads : 1);
    try {
      await new Promise<void>((resolve, reject) => {
        sf.failed = reject;
        setTimeout(() => reject(new Error('Stockfish 启动超时')), 30000);
        sf.waitFor('uci', (l) => l === 'uciok').then(resolve, reject);
      });
      sf.failed = null;
      if (multi) sf.send(`setoption name Threads value ${threads}`);
      sf.send(`setoption name Hash value ${hash}`);
      sf.send('setoption name UCI_ShowWDL value true');
      await sf.waitFor('isready', (l) => l === 'readyok');
    } catch (err) {
      sf.terminate();
      throw err;
    }
    return sf;
  }

  send(cmd: string) {
    this.worker.postMessage(cmd);
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
    this.worker.terminate();
    // flush pending searches so awaiting callers resolve instead of hanging
    for (const h of [...this.listeners]) h('bestmove (none)');
    this.listeners.clear();
  }
}
