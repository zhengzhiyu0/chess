import { Capacitor } from '@capacitor/core';

/** Running inside the Capacitor iOS shell: all engines/models are bundled, no service worker. */
export const isNative = Capacitor.isNativePlatform();

/** ProcessInfo.ThermalState of the device: 0 nominal, 1 fair, 2 serious, 3 critical (always 0 on the web). */
export let thermalState = 0;

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('热状态查询超时')), ms);
    p.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

if (isNative) {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let polling = false;

  function schedule() {
    if (document.hidden || timer !== null) return;
    timer = setTimeout(() => {
      timer = null;
      void poll();
    }, 15000);
  }

  async function poll() {
    if (document.hidden || polling) return;
    polling = true;
    try {
      const { StockfishNative } = await import('maia-native');
      // a stuck bridge call must not leave `polling` true, which would silently stop the poller
      const info = await withTimeout(StockfishNative.info(), 5000);
      thermalState = info.thermalState;
    } catch {
      thermalState = 0;
    } finally {
      polling = false;
      schedule();
    }
  }

  const resume = () => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    if (!document.hidden) void poll();
  };

  document.addEventListener('visibilitychange', resume);
  resume();
}
