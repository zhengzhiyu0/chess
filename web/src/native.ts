import { Capacitor } from '@capacitor/core';

/** Running inside the Capacitor iOS shell: all engines/models are bundled, no service worker. */
export const isNative = Capacitor.isNativePlatform();

/** ProcessInfo.ThermalState of the device: 0 nominal, 1 fair, 2 serious, 3 critical (always 0 on the web). */
export let thermalState = 0;

if (isNative) {
  const poll = async () => {
    if (document.hidden) return;
    try {
      const { StockfishNative } = await import('maia-native');
      thermalState = (await StockfishNative.info()).thermalState;
    } catch {
      thermalState = 0;
    }
  };
  void poll();
  setInterval(poll, 15000);
}
