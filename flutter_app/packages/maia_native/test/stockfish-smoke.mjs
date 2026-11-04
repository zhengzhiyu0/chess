// Compile the GENERATED target inputs, not the old package, into two isolated
// static archives and link them together. macOS CI supplies clang/pthreads.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { selection } from '../../../scripts/prepare-ios.mjs';

assert.equal(process.platform, 'darwin', 'This smoke test requires macOS clang and real native networks');
const plugin = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const config = selection(process.env.NATIVE_PROFILE ?? 'all');
const sources = join(plugin, 'ios', 'EngineSources');
const out = join(plugin, '.cache', 'stockfish-smoke');
const native = resolve(plugin, '../../assets/native');
mkdirSync(out, { recursive: true });
const run = (program, args) => execFileSync(program, args, { stdio: 'inherit', timeout: 300_000 });
const arch = process.arch === 'arm64' ? ['-DUSE_NEON=8'] : ['-DUSE_SSE2', '-msse2'];
const archives = [];
for (const engine of config.engines) {
  const objects = [];
  const namespace = engine === 'full' ? 'StockfishFull' : 'StockfishLite';
  for (const file of readdirSync(join(sources, engine)).filter((name) => name.endsWith('.cpp')).sort()) {
    const object = join(out, `${engine}_${file}.o`);
    run('xcrun', ['clang++', '-std=c++17', '-O3', '-fno-exceptions', '-w', '-DNDEBUG', '-DIS_64BIT', '-DUSE_POPCNT',
      '-DNNUE_EMBEDDING_OFF', '-DSF_EMBEDDED', '-DSF_NO_SHM', `-DStockfish=${namespace}`, `-DSF_C_PREFIX=sf_${engine}`,
      ...arch, ...(engine === 'lite' ? ['-DUSE_LITE_NET'] : []), '-c', join(sources, engine, file), '-o', object]);
    objects.push(object);
  }
  assert.ok(objects.length >= 20, `Generated ${engine} wrappers are missing`);
  const archive = join(out, `lib${namespace}.a`);
  run('xcrun', ['libtool', '-static', '-o', archive, ...objects]);
  archives.push(archive);
}
const executable = join(out, 'stockfish-smoke');
run('xcrun', ['clang++', '-std=c++17', '-O2', '-I', join(sources, 'full', 'include'),
  '-I', join(sources, 'lite', 'include'), ...(config.profile === '79m-full' ? ['-DMAIA_STOCKFISH_FULL_ONLY'] : []),
  join(plugin, 'test', 'stockfish-smoke.cpp'), ...archives, '-lpthread', '-o', executable]);
for (const engine of config.engines) assert.ok(existsSync(join(native, engine === 'full' ? 'nn-1a298aa575a0.nnue' : 'nn-61e7af4bb97d.nnue')));
run(executable, [native]);
