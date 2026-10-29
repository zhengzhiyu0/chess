// Builds dist-native/ (the iOS app's web assets) from dist/.
// The app uses native engines, so every WebAssembly engine and chunked web model is left out;
// dist-native/native/ gets Stockfish networks and ONNX build intermediates. CI converts the
// assembled Maia ONNX files to pre-compiled .mlmodelc bundles before xcodebuild.
//   nn-*.nnue   Stockfish networks (full + lite), downloaded once into .cache/ and verified by hash
//   maia3-*.onnx Maia models, reassembled from native-models/ parts for CoreML conversion
import { createHash } from 'node:crypto';
import { cpSync, createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(root, 'dist');
const dst = join(root, 'dist-native');
const out = join(dst, 'native');
const cache = join(root, '.cache', 'nnue');
if (!existsSync(src)) throw new Error('dist/ missing, run npm run build first');

const EXCLUDE = [
  /^engines\//,
  /^models\//,
  /\.wasm$/,
  /^assets\/ort[^/]*\.m?js$/,
  /^sw\.js$/,
  /^precache\.json$/,
];

// must match EvalFileDefaultName / EvalFileLiteName in native-plugins/maia-native/stockfish/src/evaluate.h
const NETS = ['nn-1a298aa575a0.nnue', 'nn-61e7af4bb97d.nnue'];
const NET_URLS = (n) => [
  `https://data.stockfishchess.org/nn/${n}`,
  `https://github.com/official-stockfish/networks/raw/master/${n}`,
  `https://tests.stockfishchess.org/api/nn/${n}`,
];
const MODELS = ['5m', '23m', '79m'];
const cacheKeys = {};

const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');

async function fetchNet(name) {
  const file = join(cache, name);
  const want = name.slice(3, 15);
  if (existsSync(file) && sha256(file).startsWith(want)) return file;
  mkdirSync(cache, { recursive: true });
  for (const url of NET_URLS(name)) {
    try {
      const res = await fetch(url, { redirect: 'follow' });
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
      await pipeline(Readable.fromWeb(res.body), createWriteStream(file + '.part'));
      if (!sha256(file + '.part').startsWith(want)) throw new Error('hash mismatch');
      renameSync(file + '.part', file);
      console.log(`downloaded ${name} from ${url}`);
      return file;
    } catch (err) {
      console.warn(`${name}: ${url} failed (${err.message})`);
    }
  }
  throw new Error(`could not download ${name}`);
}

rmSync(dst, { recursive: true, force: true });
cpSync(src, dst, {
  recursive: true,
  filter: (p) => {
    const rel = relative(src, p).replace(/\\/g, '/');
    return !EXCLUDE.some((re) => re.test(rel));
  },
});
mkdirSync(out, { recursive: true });

for (const n of NETS) cpSync(await fetchNet(n), join(out, n));

for (const m of MODELS) {
  // the app's own fp16 / batch-1 export (tools/export_onnx.py --targets native), not the web fp32 one
  const dir = join(root, 'native-models', `maia3-${m}`);
  const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
  const buf = Buffer.concat(manifest.parts.map((p) => readFileSync(join(dir, p))));
  if (buf.length !== manifest.size || createHash('sha256').update(buf).digest('hex') !== manifest.sha256)
    throw new Error(`maia3-${m}: parts do not match manifest`);
  if (!manifest.cacheKey) throw new Error(`maia3-${m}: not a native export (no cacheKey), rerun tools/export_onnx.py --targets native`);
  writeFileSync(join(out, `maia3-${m}.onnx`), buf);
  cacheKeys[m] = manifest.cacheKey;
}
// MaiaNativePlugin deletes compiled CoreML models whose key is not listed here (older app versions)
writeFileSync(join(out, 'maia-models.json'), JSON.stringify({ cacheKeys }));

const size = (d) => readdirSync(d).reduce((a, n) => a + (statSync(join(d, n)).isDirectory() ? size(join(d, n)) : statSync(join(d, n)).size), 0);
console.log(`dist-native ready: ${(size(dst) / 1048576).toFixed(0)}MB (native engines ${(size(out) / 1048576).toFixed(0)}MB)`);
