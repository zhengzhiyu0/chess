// Copies dist/ into dist-native/ for the Capacitor iOS shell, leaving out what the app can't use:
// - multi-threaded Stockfish builds (WKWebView here is not cross-origin isolated, so no SharedArrayBuffer)
// - the 79M Maia model (too much memory for a WKWebView on most iPhones)
// - service worker / download-manager files (everything is already bundled locally)
import { cpSync, existsSync, rmSync, statSync, readdirSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(root, 'dist');
const dst = join(root, 'dist-native');
if (!existsSync(src)) throw new Error('dist/ missing, run npm run build first');

const EXCLUDE = [
  /^engines\/stockfish-19(-lite)?\.(js|wasm)$/,
  /^models\/maia3-79m\//,
  /^sw\.js$/,
  /^precache\.json$/,
];

rmSync(dst, { recursive: true, force: true });
cpSync(src, dst, {
  recursive: true,
  filter: (p) => {
    const rel = relative(src, p).replace(/\\/g, '/');
    return !EXCLUDE.some((re) => re.test(rel));
  },
});

const size = (d) => readdirSync(d).reduce((a, n) => a + (statSync(join(d, n)).isDirectory() ? size(join(d, n)) : statSync(join(d, n)).size), 0);
console.log(`dist-native ready: ${(size(dst) / 1048576).toFixed(0)}MB`);
