import { registerPlugin, type PluginListenerHandle } from '@capacitor/core';

export type SfFlavour = 'full' | 'lite';

export interface DeviceInfo {
  cores: number;
  perfCores: number;
  /** bytes the app may still allocate before iOS terminates it */
  availableMemory: number;
  physicalMemory: number;
  /** ProcessInfo.ThermalState: 0 nominal … 3 critical */
  thermalState: number;
}

export interface StockfishNativePlugin {
  start(opts: { engine: SfFlavour }): Promise<{ generation: number }>;
  send(opts: { engine: SfFlavour; cmd: string; generation: number }): Promise<void>;
  resetSession(): Promise<void>;
  info(): Promise<DeviceInfo>;
  addListener(event: 'lines', cb: (e: { engine: SfFlavour; generation: number; lines: string[] }) => void): Promise<PluginListenerHandle>;
}

export interface MaiaEvalOpts {
  /** Compact position input; native code builds the model tensor locally. */
  fens?: string[];
  tokens?: string;
  indices: number[];
  selfElo: number;
  oppoElo: number;
  requestId?: number;
}

export interface MaiaEvalResult {
  logits: number[];
  value: number[];
  ms: number;
}

export interface MaiaNativePlugin {
  load(opts: { model: string; probeFens?: string[]; probeTokens?: string; probeLegal?: number[]; probeTop?: number[]; requestId?: number }): Promise<{ provider: string }>;
  eval(opts: MaiaEvalOpts): Promise<MaiaEvalResult>;
  /** several positions in one bridge call */
  evalBatch(opts: { items: MaiaEvalOpts[]; requestId?: number }): Promise<{ results: MaiaEvalResult[] }>;
  cancel?(opts: { requestId: number }): Promise<void>;
  unload(): Promise<void>;
}

export const StockfishNative = registerPlugin<StockfishNativePlugin>('StockfishNative');
export const MaiaNative = registerPlugin<MaiaNativePlugin>('MaiaNative');

export interface SoundNativePlugin {
  /** Bundled sound effects; delay is in seconds, relative to this batch. */
  play(opts: { clips: { theme: string; file: string; delay: number }[] }): Promise<void>;
  stop(): Promise<void>;
  getLogs(): Promise<{ logs: string }>;
}

export const SoundNative = registerPlugin<SoundNativePlugin>('SoundNative');

/** Durable app data store. The iOS implementation is SQLite/WAL; the web fallback is IndexedDB. */
export interface AppStoreNativePlugin {
  bootstrap(): Promise<{ values: Record<string, string> }>;
  set(opts: { key: string; value: string }): Promise<void>;
  remove(opts: { key: string }): Promise<void>;
  writeBatch(opts: { entries: Record<string, string | null> }): Promise<void>;
  saveCheckpoint(opts: { game: unknown }): Promise<void>;
  loadCheckpoint(): Promise<{ game?: unknown }>;
  clear(): Promise<void>;
}

export const AppStoreNative = registerPlugin<AppStoreNativePlugin>('AppStoreNative');
