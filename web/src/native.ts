import { Capacitor } from '@capacitor/core';

/** Running inside the Capacitor iOS shell: all engines/models are bundled, no service worker. */
export const isNative = Capacitor.isNativePlatform();
