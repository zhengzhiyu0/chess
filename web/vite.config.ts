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

/**
 * Content Security Policy for production builds (dev needs Vite's HMR websocket). Everything is
 * WebAssembly engines need 'wasm-unsafe-eval', emscripten thread pools may use blob: workers,
 * and the UI sets inline styles. HTTPS connections remain allowed for optional engine/model
 * downloads and other app resources.
 */
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval' blob:",
  "worker-src 'self' blob:",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "media-src 'self' data: blob:",
  "connect-src 'self' data: blob: https:",
  "font-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  // trailing ';': some antivirus proxies append their own directives to the meta tag
].join('; ') + ';';

function csp(): Plugin {
  return {
    name: 'csp',
    apply: 'build',
    transformIndexHtml: (html) => html.replace('<meta charset="UTF-8" />', `<meta charset="UTF-8" />\n    <meta http-equiv="Content-Security-Policy" content="${CSP}" />`),
  };
}

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
      // CSS is post-processed after generateBundle; take the final sizes from disk so the
      // download manager's completeness check doesn't reject them
      const pc = join(outDir, 'precache.json');
      const m = JSON.parse(readFileSync(pc, 'utf8')) as { files: { url: string; size: number }[] };
      for (const f of m.files) if (f.size) f.size = statSync(join(outDir, f.url)).size;
      writeFileSync(pc, JSON.stringify(m));
    },
  };
}

export default defineConfig({
  base: './',
  plugins: [csp(), precacheManifest()],
  define: { __APP_VERSION__: JSON.stringify(BUILD_ID) },
  server: { headers: isolation, host: true },
  preview: { headers: isolation, host: true },
  worker: { format: 'es' },
  optimizeDeps: { exclude: ['onnxruntime-web'] },
  build: { target: 'es2022', chunkSizeWarningLimit: 2000 },
  test: { testTimeout: 120000 },
});
