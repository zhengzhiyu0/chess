import { Maia, MODELS } from '../maia/maia';
import { Stockfish } from '../engine/stockfish';
import type { Settings } from '../settings';
import { setStatus } from './dom';

/** Lazily loaded, cached engine instances; honours the low-memory setting. */
export class Engines {
  maia: Maia | null = null;
  sf: Stockfish | null = null;
  private maiaLoading: Promise<Maia> | null = null;
  private sfLoading: Promise<Stockfish> | null = null;

  constructor(
    private settings: () => Settings,
    /** coached play alternates Maia and Stockfish every move, so both must stay resident */
    private needBoth: () => boolean,
    private beforeSfUnload: () => void,
  ) {}

  unloadMaia() {
    this.maia?.dispose();
    this.maia = null;
    this.maiaLoading = null;
  }

  unloadSf() {
    this.beforeSfUnload();
    this.sf?.terminate();
    this.sf = null;
    this.sfLoading = null;
  }

  async getMaia(): Promise<Maia> {
    const st = this.settings();
    if (this.maia?.alive && this.maia.model === st.model && this.maia.backend === st.backend) return this.maia;
    if (this.maiaLoading) {
      const m = await this.maiaLoading;
      if (m.alive && m.model === st.model && m.backend === st.backend) return m;
    }
    this.unloadMaia();
    if (st.lowMemory && !this.needBoth()) this.unloadSf();
    const model = st.model;
    const lean = st.lowMemory;
    const progress = (l: number, t: number) => setStatus(`加载 Maia ${((l / t) * 100).toFixed(0)}%（${(t / 1048576).toFixed(0)}MB）`);
    setStatus(`加载 ${MODELS[model].label}…`);
    this.maiaLoading = Maia.create(model, st.backend, progress, lean)
      .catch(async (err) => {
        if (st.backend !== 'webgpu') throw err;
        console.warn('WebGPU 失败，回退 WASM', err);
        return Maia.create(model, 'wasm', progress, lean);
      })
      .catch(async (err) => {
        // iOS: ORT's wasm init fails ("no available backend found") when memory is tight,
        // typically with multi-threaded Stockfish resident; free it and retry single-threaded
        console.warn('Maia 加载失败，释放 Stockfish 后以单线程重试', err);
        if (this.sf || this.sfLoading) this.unloadSf();
        setStatus('内存不足，正在以省内存方式重新加载 Maia…');
        return Maia.create(model, 'wasm', progress, true, 1);
      })
      .then((m) => {
        this.maia = m;
        setStatus(`${MODELS[model].label} 就绪`);
        return m;
      })
      .catch((err) => {
        this.maiaLoading = null;
        setStatus('Maia 加载失败：' + (err as Error).message);
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
    if (st.lowMemory && !this.needBoth()) this.unloadMaia();
    setStatus('加载 Stockfish 19…');
    this.sfLoading = Stockfish.create(st.sfThreads, st.sfHash)
      .then((s) => {
        this.sf = s;
        setStatus(`Stockfish 19 就绪（${s.multiThreaded ? s.threads + ' 线程' : '单线程'}）`);
        return s;
      })
      .catch((err) => {
        this.sfLoading = null;
        setStatus('Stockfish 加载失败：' + (err as Error).message);
        throw err;
      });
    return this.sfLoading;
  }

  async warmup() {
    const st = this.settings();
    try {
      await this.getMaia();
      // in low-memory mode both engines can't be resident; keep the one needed to play
      if (!st.lowMemory) await this.getSf();
      setStatus(st.lowMemory ? `${MODELS[st.model].label} 已预加载` : 'Maia 与 Stockfish 已预加载');
    } catch (err) {
      console.warn('预加载失败', err);
    }
  }
}
