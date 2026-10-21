import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'io.github.zhengzhiyu0.maiacoach',
  appName: 'Maia教练',
  // produced by scripts/prepare-native.mjs from dist/
  webDir: 'dist-native',
  backgroundColor: '#262421',
  ios: {
    // let the page lay itself out under the notch / home indicator via env(safe-area-inset-*)
    contentInset: 'never',
    scrollEnabled: false,
    allowsLinkPreview: false,
  },
  plugins: {
    // DARK = light text, matching the dark app background
    StatusBar: { style: 'DARK', overlaysWebView: true },
  },
};

export default config;
