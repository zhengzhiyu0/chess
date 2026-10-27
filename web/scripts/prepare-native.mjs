// Builds dist-native/ (the iOS app's web assets) from dist/.
// The app uses native engines (native-plugins/maia-native), so every WebAssembly engine and the
// chunked web models are left out; instead dist-native/native/ gets the files the native code loads:
//   nn-*.nnue   Stockfish networks (full + lite), downloaded once into .cache/ and verified by hash
//   maia3-*.onnx  Maia models (fp16, batch 1), reassembled from native-models/ parts
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
const kittenCache = join(root, '.cache', 'kittentts-mini');
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
const KITTEN_ASSETS = [
  { name: 'kitten_tts_mini_v0_8.onnx', url: 'https://huggingface.co/KittenML/kitten-tts-mini-0.8/resolve/c02725660cea441db4c383af69f1f26f5cd00947/kitten_tts_mini_v0_8.onnx', sha256: '0f5bbae4fc4800c98dbc544a87ecfa79510de2fb8222db30d12e5bfe9177df91' },
  { name: 'voices.npz', url: 'https://huggingface.co/KittenML/kitten-tts-mini-0.8/resolve/c02725660cea441db4c383af69f1f26f5cd00947/voices.npz', sha256: '40ad2638952b77b7b2f30127e2608e169fc69dd256b53bd8aaa3409a33193c42' },
  { name: 'en_rules', url: 'https://raw.githubusercontent.com/espeak-ng/espeak-ng/59eb19938f12e30881c81d86ce4a7de25414c9f4/dictsource/en_rules', sha256: '8e75e9341ea735cc514b29a7d3a95c6c241c1cc176ad43e5699b8f7f66ab3194' },
  { name: 'en_list', url: 'https://raw.githubusercontent.com/espeak-ng/espeak-ng/59eb19938f12e30881c81d86ce4a7de25414c9f4/dictsource/en_list', sha256: '24eb79018ed6253c10682096de672ce9265c1fe15c3e19e7f754d57a0fcd9790' },
];
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

async function fetchKittenFile(file, url, digest) {
  const cached = join(kittenCache, file);
  if (existsSync(cached) && sha256(cached) === digest) return cached;
  mkdirSync(kittenCache, { recursive: true });
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url, { redirect: 'follow' });
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
      await pipeline(Readable.fromWeb(res.body), createWriteStream(cached + '.part'));
      if (sha256(cached + '.part') !== digest) throw new Error('SHA-256 mismatch');
      renameSync(cached + '.part', cached);
      console.log(`downloaded ${file} from ${url}`);
      return cached;
    } catch (err) {
      rmSync(cached + '.part', { force: true });
      if (attempt === 2) throw new Error(`Kitten TTS asset download failed: ${file} (${err.message})`);
    }
  }
  throw new Error(`Kitten TTS asset download failed: ${file}`);
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

const speechOut = join(out, 'speech', 'kitten-mini');
mkdirSync(speechOut, { recursive: true });
for (const asset of KITTEN_ASSETS) {
  cpSync(await fetchKittenFile(asset.name, asset.url, asset.sha256), join(speechOut, asset.name));
}
writeFileSync(join(speechOut, 'NOTICE.txt'), [
  'KittenTTS 0.8 Mini and its bundled Bella/Jasper voice embeddings are provided for offline English speech synthesis.',
  'Model and voices: Apache-2.0, https://huggingface.co/KittenML/kitten-tts-mini-0.8/tree/c02725660cea441db4c383af69f1f26f5cd00947',
  'Swift runtime: KittenML/KittenTTS-swift 0.1.0, Apache-2.0.',
  'English G2P assets en_rules/en_list: eSpeak NG, GPL-3.0.',
].join('\n') + '\n');

const size = (d) => readdirSync(d).reduce((a, n) => a + (statSync(join(d, n)).isDirectory() ? size(join(d, n)) : statSync(join(d, n)).size), 0);
console.log(`dist-native ready: ${(size(dst) / 1048576).toFixed(0)}MB (native engines ${(size(out) / 1048576).toFixed(0)}MB; Kitten TTS Mini assets ${(size(speechOut) / 1048576).toFixed(1)}MB)`);
