// Flutter-only native staging. Does not build/copy the Capacitor app or web dist.
// --prepare-only: local source/audio preparation, no model downloads or conversion.
// Default: prepare sources and assemble verified NNUE/ONNX into assets/native.
// --bundle-only: after compile-coreml.py, verify and stage deployable pod resources.
import { createHash } from 'node:crypto';
import {
  cpSync, createReadStream, createWriteStream, existsSync, lstatSync, mkdirSync,
  readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

const app = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repository = resolve(app, '..');
const web = join(repository, 'web');
const plugin = join(app, 'packages', 'maia_native');
const ios = join(plugin, 'ios');
const engineSources = join(ios, 'EngineSources');
const native = join(app, 'assets', 'native');
const bundle = join(ios, 'Resources', 'MaiaNativeAssets.bundle');
const cache = join(plugin, '.cache', 'nnue');
const stockfish = join(web, 'native-plugins', 'maia-native', 'stockfish');
export const ALL_MODELS = ['5m', '23m', '79m'];
export const NETWORKS = { full: 'nn-1a298aa575a0.nnue', lite: 'nn-61e7af4bb97d.nnue' };

export function selection(profile) {
  if (!['all', '79m-full'].includes(profile)) throw new Error(`Unknown NATIVE_PROFILE: ${profile}`);
  return {
    profile,
    models: profile === '79m-full' ? ['79m'] : [...ALL_MODELS],
    engines: profile === '79m-full' ? ['full'] : ['full', 'lite'],
  };
}

// Check the absolute path AND existing ancestors before any generated deletion
// or overwrite. Only exact known files/model bundles below these roots are used.
export function checkedChild(root, target) {
  const absoluteRoot = resolve(root);
  const absolute = resolve(target);
  const rel = relative(absoluteRoot, absolute);
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(`Refusing generated operation outside ${absoluteRoot}: ${absolute}`);
  }
  let cursor = absolute;
  while (true) {
    if (lstatSync(cursor, { throwIfNoEntry: false })?.isSymbolicLink()) throw new Error(`Refusing symlink: ${cursor}`);
    const parent = dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  if (existsSync(absoluteRoot)) {
    const real = realpathSync(absoluteRoot);
    if (resolve(real).toLowerCase() !== absoluteRoot.toLowerCase()) throw new Error(`Generated root was redirected: ${absoluteRoot}`);
  }
  return absolute;
}

function removeGenerated(root, target) {
  rmSync(checkedChild(root, target), { recursive: true, force: true });
}

function writeGenerated(root, target, data) {
  const path = checkedChild(root, target);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, data);
}

function copyGenerated(root, source, destination) {
  checkedChild(root, destination);
  mkdirSync(dirname(destination), { recursive: true });
  cpSync(source, destination, { recursive: true, dereference: false });
}

export async function sha256(path) {
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(path)) digest.update(chunk);
  return digest.digest('hex');
}

function prepareSources(config) {
  const header = readFileSync(join(stockfish, 'src', 'evaluate.h'), 'utf8');
  for (const [engine, name] of Object.entries(NETWORKS)) {
    if (!header.includes(`"${name}"`)) throw new Error(`${engine} network constant differs from Stockfish evaluate.h`);
  }
  // Preserve wrapper-relative ../src and ../bridge includes from the original
  // separate SPM targets. Compile wrappers ONLY; src/ is included, never globbed.
  for (const directory of ['src', 'bridge', ...config.engines]) {
    const destination = join(engineSources, directory);
    // Only exact generated subtrees are replaced; stale wrappers must not survive
    // a source upgrade. rm does not traverse symlink children inside this tree.
    removeGenerated(ios, destination);
    copyGenerated(ios, join(stockfish, directory), destination);
  }
  for (const file of ['Copying.txt', 'AUTHORS', 'VERSION']) {
    copyGenerated(ios, join(stockfish, file), join(engineSources, file));
  }
  writeGenerated(ios, join(engineSources, 'native-profile.json'), `${JSON.stringify(config, null, 2)}\n`);
}

function prepareAudio() {
  const output = join(bundle, 'sounds');
  // Uses main's copied licensed sounds when available; source fallback permits
  // plugin preparation before main has run prepare-assets.mjs.
  const sounds = existsSync(join(app, 'assets', 'sounds', 'standard', 'move.mp3'))
    ? join(app, 'assets', 'sounds') : join(web, 'public', 'sounds');
  for (const theme of ['board', 'wood', 'felt', 'glass', 'standard']) {
    const files = theme === 'standard' ? ['move', 'capture', 'error', 'dong'] : ['Move', 'Capture'];
    for (const file of files) {
      copyGenerated(ios, join(sounds, theme, `${file}.mp3`), join(output, theme, `${file}.mp3`));
    }
  }
  for (const file of ['LICENSE-Kenney.txt', 'README.md']) {
    copyGenerated(ios, join(sounds, file), join(output, file));
  }
  for (const file of ['Copying.txt', 'AUTHORS', 'VERSION']) {
    copyGenerated(ios, join(stockfish, file), join(bundle, 'licenses', `Stockfish-${file}`));
  }
  writeGenerated(ios, join(bundle, 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>io.github.zhengzhiyu0.maiacoach.nativeassets</string>
<key>CFBundleName</key><string>MaiaNativeAssets</string>
<key>CFBundlePackageType</key><string>BNDL</string>
<key>CFBundleVersion</key><string>1</string>
</dict></plist>
`);
}

function pruneUnselected(config) {
  for (const model of ALL_MODELS.filter((name) => !config.models.includes(name))) {
    for (const root of [native, join(bundle, 'native')]) {
      for (const extension of ['onnx', 'mlmodelc']) removeGenerated(root, join(root, `maia3-${model}.${extension}`));
    }
  }
  for (const engine of Object.keys(NETWORKS).filter((name) => !config.engines.includes(name))) {
    for (const root of [native, join(bundle, 'native')]) removeGenerated(root, join(root, NETWORKS[engine]));
    removeGenerated(engineSources, join(engineSources, engine));
  }
}

export async function assembleModel(directory, destination) {
  const manifest = JSON.parse(readFileSync(join(directory, 'manifest.json'), 'utf8'));
  if (!Number.isSafeInteger(manifest.size) || manifest.size <= 0 || !/^[a-f0-9]{64}$/.test(manifest.sha256)
      || !Array.isArray(manifest.parts) || !manifest.parts.length
      || new Set(manifest.parts).size !== manifest.parts.length) throw new Error(`Invalid manifest: ${directory}`);
  const buffers = manifest.parts.map((part) => {
    if (typeof part !== 'string' || !/^part\d+-[a-f0-9]+\.bin$/.test(part)) throw new Error(`Unsafe model part: ${part}`);
    return readFileSync(checkedChild(directory, join(directory, part)));
  });
  const data = Buffer.concat(buffers);
  if (data.length !== manifest.size || createHash('sha256').update(data).digest('hex') !== manifest.sha256) {
    throw new Error(`Model parts do not match manifest: ${directory}`);
  }
  writeGenerated(dirname(destination), destination, data);
  return manifest;
}

async function fetchNetwork(name) {
  const expected = name.slice(3, 15);
  const valid = async (path) => existsSync(path) && (await sha256(path)).startsWith(expected);
  const destination = checkedChild(plugin, join(cache, name));
  if (await valid(destination)) return destination;
  const legacyCache = join(web, '.cache', 'nnue', name);
  if (await valid(legacyCache)) {
    copyGenerated(plugin, legacyCache, destination);
    return destination;
  }
  mkdirSync(cache, { recursive: true });
  const partial = checkedChild(plugin, `${destination}.part`);
  for (const url of [
    `https://data.stockfishchess.org/nn/${name}`,
    `https://github.com/official-stockfish/networks/raw/master/${name}`,
    `https://tests.stockfishchess.org/api/nn/${name}`,
  ]) {
    try {
      const response = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(180_000) });
      if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);
      await pipeline(Readable.fromWeb(response.body), createWriteStream(partial));
      if (!(await valid(partial))) throw new Error('NNUE SHA-256 prefix mismatch');
      renameSync(partial, destination);
      console.log(`Verified ${name}`);
      return destination;
    } catch (error) {
      removeGenerated(plugin, partial);
      console.warn(`${name}: ${url}: ${error.message}`);
    }
  }
  throw new Error(`Could not fetch a hash-verified ${name}`);
}

function hasFiles(directory) {
  return existsSync(directory) && statSync(directory).isDirectory()
    && readdirSync(directory, { withFileTypes: true }).some((entry) => entry.isFile() || (entry.isDirectory() && hasFiles(join(directory, entry.name))));
}

async function stageCompiled(config) {
  for (const model of config.models) {
    const name = `maia3-${model}.mlmodelc`;
    if (!hasFiles(join(native, name))) throw new Error(`${name} missing/empty; run web/scripts/compile-coreml.py on macOS first`);
    if (existsSync(join(native, `maia3-${model}.onnx`))) throw new Error('Raw ONNX remains in assets/native; CoreML compilation did not complete');
    const destination = join(bundle, 'native', name);
    removeGenerated(ios, destination);
    copyGenerated(ios, join(native, name), destination);
  }
  for (const engine of config.engines) {
    const name = NETWORKS[engine];
    if (!(await sha256(join(native, name))).startsWith(name.slice(3, 15))) throw new Error(`Corrupt bundled NNUE: ${name}`);
    copyGenerated(ios, join(native, name), join(bundle, 'native', name));
  }
  const metadataPath = join(native, 'maia-models.json');
  const metadata = JSON.parse(readFileSync(metadataPath, 'utf8'));
  if (metadata.format !== 'mlmodelc' || JSON.stringify(metadata.models) !== JSON.stringify(config.models)) {
    throw new Error('CoreML model metadata does not match NATIVE_PROFILE');
  }
  copyGenerated(ios, metadataPath, join(bundle, 'native', 'maia-models.json'));
  writeGenerated(ios, join(bundle, 'native', 'native-profile.json'), `${JSON.stringify(config, null, 2)}\n`);
}

export async function main(argv = process.argv.slice(2)) {
  const allowed = new Set(['--prepare-only', '--bundle-only', '--help']);
  for (const argument of argv) if (!allowed.has(argument)) throw new Error(`Unknown argument: ${argument}`);
  if (argv.includes('--help')) {
    console.log('NATIVE_PROFILE=all|79m-full node flutter_app/scripts/prepare-ios.mjs [--prepare-only|--bundle-only]');
    return;
  }
  if (argv.includes('--prepare-only') && argv.includes('--bundle-only')) throw new Error('Choose one preparation mode');
  const config = selection(process.env.NATIVE_PROFILE ?? 'all');
  // Generated trees are explicit; never remove the app, plugin, or assets root.
  for (const directory of [engineSources, native, bundle]) {
    checkedChild(repository, directory);
    mkdirSync(directory, { recursive: true });
  }
  prepareSources(config);
  prepareAudio();
  pruneUnselected(config);
  if (argv.includes('--bundle-only')) {
    await stageCompiled(config);
    console.log(`iOS deployable resource bundle ready (${config.profile})`);
    return;
  }
  if (!argv.includes('--prepare-only')) {
    for (const engine of config.engines) copyGenerated(app, await fetchNetwork(NETWORKS[engine]), join(native, NETWORKS[engine]));
    for (const model of config.models) {
      await assembleModel(join(web, 'native-models', `maia3-${model}`), join(native, `maia3-${model}.onnx`));
    }
    console.log(`Verified NNUE and assembled ONNX ready (${config.profile}); compile CoreML on macOS, then run --bundle-only`);
  } else {
    console.log(`iOS sources/audio prepared (${config.profile}); NNUE/compiled CoreML NOT prepared`);
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => { console.error(error.stack ?? error); process.exitCode = 1; });
}
