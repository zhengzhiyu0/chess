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
  start(opts: { engine: SfFlavour }): Promise<void>;
  send(opts: { engine: SfFlavour; cmd: string }): Promise<void>;
  info(): Promise<DeviceInfo>;
  addListener(event: 'lines', cb: (e: { engine: SfFlavour; lines: string[] }) => void): Promise<PluginListenerHandle>;
}

export interface MaiaEvalOpts {
  tokens: string;
  indices: number[];
  selfElo: number;
  oppoElo: number;
}

export interface MaiaEvalResult {
  logits: number[];
  value: number[];
  ms: number;
}

export interface MaiaNativePlugin {
  load(opts: { model: string; probeTokens?: string; probeLegal?: number[]; probeTop?: number[] }): Promise<{ provider: string }>;
  eval(opts: MaiaEvalOpts): Promise<MaiaEvalResult>;
  /** several positions in one bridge call */
  evalBatch(opts: { items: MaiaEvalOpts[] }): Promise<{ results: MaiaEvalResult[] }>;
  unload(): Promise<void>;
}

export const StockfishNative = registerPlugin<StockfishNativePlugin>('StockfishNative');
export const MaiaNative = registerPlugin<MaiaNativePlugin>('MaiaNative');

export interface SoundNativePlugin {
  /** Bundled recordings; delay is in seconds, relative to this batch. */
  play(opts: { clips: { theme: string; file: string; delay: number }[] }): Promise<void>;
  stop(): Promise<void>;
  prepareSpeech(opts: { voice: string }): Promise<void>;
  speak(opts: { text: string; voice: string }): Promise<void>;
  stopSpeech(): Promise<void>;
}

export const SoundNative = registerPlugin<SoundNativePlugin>('SoundNative');
