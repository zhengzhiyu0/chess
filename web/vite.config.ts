/// <reference types="vitest/config" />
import { defineConfig, type Plugin } from 'vite';
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

// SharedArrayBuffer (multi-threaded Stockfish / ORT) needs cross-origin isolation.
const isolation = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
};

const NOT_PRECACHED = new Set(['sw.js', 'precache.json']);

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string };
/** Changes on every build so the browser sees a new sw.js and the page can show the version. */
const BUILD_ID = `${pkg.version}+${new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '')}`;

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

/** Emits precache.json (every deployable file + size) for the in-app download manager. */
function precacheManifest(): Plugin {
  let publicDir = '';
  let outDir = '';
  return {
    name: 'precache-manifest',
    apply: 'build',
    configResolved(c) {
      publicDir = c.publicDir;
      outDir = resolve(c.root, c.build.outDir);
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
      this.emitFile({ type: 'asset', fileName: 'precache.json', source: JSON.stringify({ built: Date.now(), version: BUILD_ID, files }) });
    },
    // sw.js is copied verbatim from public/; stamp the build id so every deployment installs a new worker
    writeBundle() {
      const sw = join(outDir, 'sw.js');
      writeFileSync(sw, readFileSync(sw, 'utf8').replace('__BUILD__', BUILD_ID));
    },
  };
}

export default defineConfig({
  base: './',
  plugins: [precacheManifest()],
  define: { __APP_VERSION__: JSON.stringify(BUILD_ID) },
  server: { headers: isolation, host: true },
  preview: { headers: isolation, host: true },
  worker: { format: 'es' },
  optimizeDeps: { exclude: ['onnxruntime-web'] },
  build: { target: 'es2022', chunkSizeWarningLimit: 2000 },
  test: { testTimeout: 120000 },
});
