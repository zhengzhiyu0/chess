/// <reference types="vitest/config" />
import { defineConfig } from 'vite';

// SharedArrayBuffer (multi-threaded Stockfish / ORT) needs cross-origin isolation.
const isolation = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
};

export default defineConfig({
  base: './',
  server: { headers: isolation, host: true },
  preview: { headers: isolation, host: true },
  worker: { format: 'es' },
  optimizeDeps: { exclude: ['onnxruntime-web'] },
  build: { target: 'es2022', chunkSizeWarningLimit: 2000 },
  test: { testTimeout: 120000 },
});
