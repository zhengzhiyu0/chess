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

export interface MaiaNativePlugin {
  load(opts: { model: string; probeTokens?: string; probeLegal?: number[]; probeTop?: number[] }): Promise<{ provider: string }>;
  eval(opts: { tokens: string; indices: number[]; selfElo: number; oppoElo: number }): Promise<{ logits: number[]; value: number[]; ms: number }>;
  unload(): Promise<void>;
}

export const StockfishNative = registerPlugin<StockfishNativePlugin>('StockfishNative');
export const MaiaNative = registerPlugin<MaiaNativePlugin>('MaiaNative');
