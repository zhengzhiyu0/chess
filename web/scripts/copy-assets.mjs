// Copies engine/runtime binaries from node_modules into public/ so they are served as static files.
import { copyFileSync, mkdirSync, existsSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import './copy-voices.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const nm = join(root, 'node_modules');

const jobs = [
  ['stockfish/bin', 'public/engines', ['stockfish-19.js', 'stockfish-19.wasm', 'stockfish-19-single.js', 'stockfish-19-single.wasm', 'stockfish-19-lite.js', 'stockfish-19-lite.wasm', 'stockfish-19-lite-single.js', 'stockfish-19-lite-single.wasm']],
];

for (const [from, to, files] of jobs) {
  mkdirSync(join(root, to), { recursive: true });
  for (const f of files) {
    const src = join(nm, from, f);
    const dst = join(root, to, f);
    if (!existsSync(src)) throw new Error(`missing ${src}, run npm install`);
    if (existsSync(dst) && statSync(dst).size === statSync(src).size && statSync(dst).mtimeMs >= statSync(src).mtimeMs) continue;
    copyFileSync(src, dst);
    console.log('copied', join(to, f));
  }
}
