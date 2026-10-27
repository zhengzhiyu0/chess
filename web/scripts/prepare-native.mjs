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
const speechCache = join(root, '.cache', 'piper');
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
const PIPER_REV = '5041a7a49ae5b3a0f30e6837769eb03fdbb231bd';
const PIPER_VOICES = [
  { name: 'lessac', model: '5efe09e69902187827af646e1a6e9d269dee769f9877d17b16b1b46eeaaf019f', config: 'efe19c417bed055f2d69908248c6ba650fa135bc868b0e6abb3da181dab690a0', card: 'ce49eb457742208166d399a40cdec2c7fa9db77960930031564ab56f12882645' },
  { name: 'ryan', model: 'abf4c274862564ed647ba0d2c47f8ee7c9b717d27bdad9219100eb310db4047a', config: '44034c056cb15681b2ad494307c7f3f2e4499d1253c700c711fa0a4607ffe78d', card: '3a24ae5f7aa856199f338ad9af784cda796734f397f7e1b4a1bd3c07d06945b1' },
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

async function fetchSpeechFile(voice, file, sourceFile, digest) {
  const relativePath = `en/en_US/${voice.name}/medium/${sourceFile}`;
  const cached = join(speechCache, file);
  if (existsSync(cached) && sha256(cached) === digest) return cached;
  mkdirSync(speechCache, { recursive: true });
  const url = `https://huggingface.co/rhasspy/piper-voices/resolve/${PIPER_REV}/${relativePath}`;
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
      if (attempt === 2) throw new Error(`Piper voice download failed: ${file} (${err.message})`);
    }
  }
  throw new Error(`Piper voice download failed: ${file}`);
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

const speechOut = join(out, 'speech');
mkdirSync(speechOut, { recursive: true });
for (const voice of PIPER_VOICES) {
  for (const [file, sourceFile, digest] of [
    [`en_US-${voice.name}-medium.onnx`, `en_US-${voice.name}-medium.onnx`, voice.model],
    [`en_US-${voice.name}-medium.onnx.json`, `en_US-${voice.name}-medium.onnx.json`, voice.config],
    [`en_US-${voice.name}-medium.MODEL_CARD`, 'MODEL_CARD', voice.card],
  ]) {
    cpSync(await fetchSpeechFile(voice, file, sourceFile, digest), join(speechOut, file));
  }
}
writeFileSync(join(speechOut, 'NOTICE.txt'), [
  'Piper voices are bundled for offline English speech synthesis.',
  `Source revision: https://huggingface.co/rhasspy/piper-voices/tree/${PIPER_REV}/en/en_US`,
  'See each *.MODEL_CARD file for the voice dataset and license information.',
  'Runtime: PiperPlus 2.0.2 (MIT), https://github.com/ayutaz/piper-plus',
].join('\n') + '\n');

const size = (d) => readdirSync(d).reduce((a, n) => a + (statSync(join(d, n)).isDirectory() ? size(join(d, n)) : statSync(join(d, n)).size), 0);
console.log(`dist-native ready: ${(size(dst) / 1048576).toFixed(0)}MB (native engines ${(size(out) / 1048576).toFixed(0)}MB; Piper voices ${(size(speechOut) / 1048576).toFixed(1)}MB)`);
