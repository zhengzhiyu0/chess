import { Maia } from '../maia/maia';
import { Stockfish } from '../engine/stockfish';
import type { Settings } from '../settings';
import { setStatus } from './dom';
import { isNative } from '../native';

/** Shared startup/game engine loads; honours the low-memory setting. */
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
    return !isNative && st.lowMemory && !st.sfLite && !this.needBoth();
  }

  readyForGame(review: boolean, coached: boolean): boolean {
    const st = this.settings();
    const maiaReady = this.maia?.alive && this.maia.model === st.model && this.maiaWanted === st.backend;
    const sfReady = this.sf?.alive && this.sf.lite === st.sfLite;
    return Boolean(review ? sfReady : maiaReady && (!coached || sfReady));
  }

  async prepareGame(review: boolean, coached: boolean, isCurrent = () => true): Promise<void> {
    if (!review) await this.getMaia();
    // A user may have left or switched to ordinary low-memory play during the Maia load.
    // Starting a stale coach load now would evict the engine their new game needs.
    if ((review || coached) && isCurrent()) await this.getSf();
  }

  unloadMaia() {
    this.maiaGen++;
    this.maia?.dispose();
    this.maia = null;
    this.maiaLoading = null;
  }

  unloadSf() {
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
    this.maiaLoading = Maia.create(model, backend, undefined, lean)
      .catch(async (err) => {
        if (isNative || backend !== 'webgpu' || gen !== this.maiaGen) throw err;
        console.warn('WebGPU 失败，回退 WASM', err);
        this.webgpuFailed = true;
        return Maia.create(model, 'wasm', undefined, lean);
      })
      .catch(async (err) => {
        if (isNative || gen !== this.maiaGen) throw err;
        // iOS: ORT's wasm init fails ("no available backend found") when memory is tight,
        // typically with multi-threaded Stockfish resident; free it and retry single-threaded
        console.warn('Maia 加载失败，释放 Stockfish 后以单线程重试', err);
        if (this.sf || this.sfLoading) this.unloadSf();
        setStatus('内存不足，正在以省内存方式重新加载 Maia…');
        return Maia.create(model, 'wasm', undefined, true, 1);
      })
      .then((m) => {
        if (gen !== this.maiaGen) {
          // unloaded (or superseded) while loading: don't resurrect it
          m.dispose();
          if (this.maiaLoading) return this.maiaLoading;
          throw new Error('Maia 已卸载');
        }
        this.maia = m;
        return m;
      })
      .catch((err) => {
        // a stale load must not clear the handle of a newer one
        if (gen === this.maiaGen) {
          this.maiaLoading = null;
          setStatus('Maia 加载失败：' + (err as Error).message);
        }
        throw err;
      });
    return this.maiaLoading;
  }

  async getSf(): Promise<Stockfish> {
    if (this.sf?.alive && this.sf.lite === this.settings().sfLite) return this.sf;
    if (this.sf?.alive) this.unloadSf();
    if (this.sf) {
      // crashed or killed by the watchdog: drop it and boot a fresh one
      this.sf = null;
      this.sfLoading = null;
    }
    if (this.sfLoading) return this.sfLoading;
    const st = this.settings();
    if (this.exclusive()) this.unloadMaia();
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
        return s;
      })
      .catch((err) => {
        if (gen === this.sfGen) {
          this.sfLoading = null;
          setStatus('Stockfish 加载失败：' + (err as Error).message);
        }
        throw err;
      });
    return this.sfLoading;
  }

  async warmup() {
    // Native startup prepares both engines together; the first iOS game can then enter immediately.
    // Web low-memory mode still loads only Maia until Stockfish is needed.
    const loads = this.exclusive() ? [this.getMaia()] : [this.getMaia(), this.getSf()];
    const results = await Promise.allSettled(loads);
    for (const result of results) if (result.status === 'rejected') console.warn('预加载失败', result.reason);
  }
}
