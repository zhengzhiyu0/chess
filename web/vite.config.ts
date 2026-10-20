/// <reference types="vitest/config" />
import { defineConfig, type Plugin } from 'vite';
import { readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

// SharedArrayBuffer (multi-threaded Stockfish / ORT) needs cross-origin isolation.
const isolation = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
};

const NOT_PRECACHED = new Set(['sw.js', 'precache.json']);

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

/** Emits precache.json (every deployable file + size) for the in-app download manager. */
function precacheManifest(): Plugin {
  let publicDir = '';
  return {
    name: 'precache-manifest',
    apply: 'build',
    configResolved(c) {
      publicDir = c.publicDir;
    },
    generateBundle(_, bundle) {
      const files: { url: string; size: number }[] = [{ url: './', size: 0 }];
      for (const [name, chunk] of Object.entries(bundle)) {
        const size = chunk.type === 'chunk' ? Buffer.byteLength(chunk.code) : typeof chunk.source === 'string' ? Buffer.byteLength(chunk.source) : chunk.source.byteLength;
        files.push({ url: name, size });
      }
      for (const p of walk(publicDir)) {
        const url = relative(publicDir, p).replace(/\\/g, '/');
        if (!NOT_PRECACHED.has(url)) files.push({ url, size: statSync(p).size });
      }
      this.emitFile({ type: 'asset', fileName: 'precache.json', source: JSON.stringify({ built: Date.now(), files }) });
    },
  };
}

export default defineConfig({
  base: './',
  plugins: [precacheManifest()],
  server: { headers: isolation, host: true },
  preview: { headers: isolation, host: true },
  worker: { format: 'es' },
  optimizeDeps: { exclude: ['onnxruntime-web'] },
  build: { target: 'es2022', chunkSizeWarningLimit: 2000 },
  test: { testTimeout: 120000 },
});
