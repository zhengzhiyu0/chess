import { Maia, MODELS } from '../maia/maia';
import { Stockfish } from '../engine/stockfish';
import type { Settings } from '../settings';
import { setStatus } from './dom';
import { isNative } from '../native';

/** Lazily loaded, cached engine instances; honours the low-memory setting. */
export class Engines {
  maia: Maia | null = null;
  sf: Stockfish | null = null;
  private maiaLoading: Promise<Maia> | null = null;
  /** backend the current Maia was requested with (it may have fallen back to WASM) */
  private maiaWanted: Settings['backend'] | null = null;
  private sfLoading: Promise<Stockfish> | null = null;
  /** bumped by every unload: a load that finishes under an older generation is stale */
  private maiaGen = 0;
  private sfGen = 0;
  /** WebGPU failed to load or crashed mid-game this session; use WASM from now on */
  private webgpuFailed = false;
  /** Startup preload keeps both engines resident even when low-memory mode is enabled. */
  private preloadBoth = false;
  private preloadPromise: Promise<void> | null = null;
  private silentDepth = 0;

  constructor(
    private settings: () => Settings,
    /** coached play alternates Maia and Stockfish every move, so both must stay resident */
    private needBoth: () => boolean,
    private beforeSfUnload: () => void,
  ) {}

  /**
   * Low-memory mode normally keeps only one engine resident, but swapping reloads the other one
   * every time (seconds on a phone). The lite Stockfish is small enough to always keep both.
   */
  private exclusive() {
    const st = this.settings();
    // native engines live outside the WebView's memory limit; keep both resident
    return !this.preloadBoth && !isNative && st.lowMemory && !st.sfLite && !this.needBoth();
  }

  private status(text: string) {
    if (!this.silentDepth) setStatus(text);
  }

  unloadMaia() {
    this.preloadPromise = null;
    this.maiaGen++;
    this.maia?.dispose();
    this.maia = null;
    this.maiaLoading = null;
  }

  unloadSf() {
    this.preloadPromise = null;
    this.beforeSfUnload();
    this.sfGen++;
    this.sf?.terminate();
    this.sf = null;
    this.sfLoading = null;
  }

  async getMaia(): Promise<Maia> {
    const st = this.settings();
    if (this.maia?.crashed && this.maia.backend === 'webgpu') this.webgpuFailed = true;
    if (this.maia?.alive && this.maia.model === st.model && this.maiaWanted === st.backend) return this.maia;
    if (this.maiaLoading) {
      const m = await this.maiaLoading;
      if (m.crashed && m.backend === 'webgpu') this.webgpuFailed = true;
      if (m.alive && m.model === st.model && this.maiaWanted === st.backend) return m;
    }
    this.unloadMaia();
    this.maiaWanted = st.backend;
    if (this.exclusive()) this.unloadSf();
    const gen = this.maiaGen;
    const backend = st.backend === 'webgpu' && this.webgpuFailed ? 'wasm' : st.backend;
    const model = st.model;
    const lean = st.lowMemory;
    const progress = (l: number, t: number) => this.status(`加载 Maia ${((l / t) * 100).toFixed(0)}%（${(t / 1048576).toFixed(0)}MB）`);
    this.status(`加载 ${MODELS[model].label}…`);
    this.maiaLoading = Maia.create(model, backend, progress, lean)
      .catch(async (err) => {
        if (isNative || backend !== 'webgpu' || gen !== this.maiaGen) throw err;
        console.warn('WebGPU 失败，回退 WASM', err);
        this.webgpuFailed = true;
        return Maia.create(model, 'wasm', progress, lean);
      })
      .catch(async (err) => {
        if (isNative || gen !== this.maiaGen) throw err;
        // iOS: ORT's wasm init fails ("no available backend found") when memory is tight,
        // typically with multi-threaded Stockfish resident; free it and retry single-threaded
        console.warn('Maia 加载失败，释放 Stockfish 后以单线程重试', err);
        if (this.sf || this.sfLoading) this.unloadSf();
        this.status('内存不足，正在以省内存方式重新加载 Maia…');
        return Maia.create(model, 'wasm', progress, true, 1);
      })
      .then((m) => {
        if (gen !== this.maiaGen) {
          // unloaded (or superseded) while loading: don't resurrect it
          m.dispose();
          if (this.maiaLoading) return this.maiaLoading;
          throw new Error('Maia 已卸载');
        }
        this.maia = m;
        this.status(`${MODELS[model].label} 就绪${isNative ? `（原生 · ${m.provider === 'coreml' ? 'CoreML' : 'CPU'}）` : ''}`);
        return m;
      })
      .catch((err) => {
        // a stale load must not clear the handle of a newer one
        if (gen === this.maiaGen) {
          this.maiaLoading = null;
          this.status('Maia 加载失败：' + (err as Error).message);
        }
        throw err;
      });
    return this.maiaLoading;
  }

  async getSf(): Promise<Stockfish> {
    if (this.sf?.alive) return this.sf;
    if (this.sf) {
      // crashed or killed by the watchdog: drop it and boot a fresh one
      this.sf = null;
      this.sfLoading = null;
    }
    if (this.sfLoading) return this.sfLoading;
    const st = this.settings();
    if (this.exclusive()) this.unloadMaia();
    this.status(`加载 Stockfish 19${st.sfLite ? ' 轻量版' : ''}…`);
    const gen = this.sfGen;
    this.sfLoading = Stockfish.create(st.sfThreads, st.sfHash, st.sfLite)
      .then((s) => {
        if (gen !== this.sfGen) {
          // unloaded (or superseded) while booting: don't resurrect it
          s.terminate();
          if (this.sfLoading) return this.sfLoading;
          throw new Error('Stockfish 已卸载');
        }
        this.sf = s;
        this.status(`Stockfish 19${s.lite ? ' 轻量版' : ' 满血版'} 就绪（${s.native ? '原生 · ' : ''}${s.multiThreaded ? s.threads + ' 线程' : '单线程'}）`);
        return s;
      })
      .catch((err) => {
        if (gen === this.sfGen) {
          this.sfLoading = null;
          this.status('Stockfish 加载失败：' + (err as Error).message);
        }
        throw err;
      });
    return this.sfLoading;
  }

  async warmup(silent = false) {
    if (this.preloadPromise) return this.preloadPromise;
    this.preloadBoth = true;
    if (silent) this.silentDepth++;
    this.preloadPromise = (async () => {
      try {
        await this.getMaia();
        await this.getSf();
        this.status('Maia 与 Stockfish 已预加载');
      } catch (err) {
        console.warn('预加载失败', err);
        throw err;
      } finally {
        if (silent) this.silentDepth--;
      }
    })().catch((err) => {
      // A failed preload can be retried when the user starts a game.
      this.preloadPromise = null;
      throw err;
    });
    return this.preloadPromise;
  }

  /** Wait until both engines are ready before entering a game. */
  ensureReady() {
    return this.warmup(true);
  }
}
