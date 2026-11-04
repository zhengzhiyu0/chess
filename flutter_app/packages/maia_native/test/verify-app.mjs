// macOS CI packaging gate; can also inspect any unpacked unsigned .app.
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { NETWORKS, selection, sha256 } from '../../../scripts/prepare-ios.mjs';

const config = selection(process.env.NATIVE_PROFILE ?? 'all');
const app = resolve(process.argv[2] ?? 'build/ios/iphoneos/Runner.app');
const assets = join(app, 'MaiaNativeAssets.bundle');
const flutterAssets = join(app, 'Frameworks', 'App.framework', 'flutter_assets', 'assets');
const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const filesIn = (directory) => readdirSync(directory, { withFileTypes: true })
  .flatMap((entry) => entry.isDirectory() ? filesIn(join(directory, entry.name)) : [join(directory, entry.name)]);
assert.ok(existsSync(assets), 'Directory-preserving native resource bundle is missing');
const metadata = JSON.parse(readFileSync(join(assets, 'native', 'maia-models.json'), 'utf8'));
assert.deepEqual(metadata.models, config.models);
assert.equal(metadata.format, 'mlmodelc');
for (const model of config.models) {
  const compiled = join(assets, 'native', `maia3-${model}.mlmodelc`);
  assert.ok(statSync(compiled).isDirectory() && filesIn(compiled).length > 0, `Missing/empty ${compiled}`);
}
for (const engine of config.engines) {
  const name = NETWORKS[engine];
  assert.ok((await sha256(join(assets, 'native', name))).startsWith(name.slice(3, 15)), `Corrupt pod NNUE ${name}`);
}
for (const theme of ['board', 'wood', 'felt', 'glass', 'standard']) {
  const names = theme === 'standard' ? ['move', 'capture', 'error', 'dong'] : ['Move', 'Capture'];
  for (const name of names) {
    const source = join(sourceRoot, 'web', 'public', 'sounds', theme, `${name}.mp3`);
    const expected = await sha256(source);
    assert.equal(await sha256(join(assets, 'sounds', theme, `${name}.mp3`)), expected);
    assert.equal(await sha256(join(flutterAssets, 'sounds', theme, `${name}.mp3`)), expected);
  }
}
const allFiles = filesIn(app);
assert.ok(!allFiles.some((file) => /(?:^|[\\/])maia3-[^/\\]+\.onnx$/.test(file)), 'Raw native ONNX shipped in app');
if (config.profile === '79m-full') {
  assert.ok(!allFiles.some((file) => file.includes(NETWORKS.lite) || /maia3-(5m|23m)\.mlmodelc/.test(file)), 'Unselected profile resources shipped');
}
if (process.platform === 'darwin') {
  const id = execFileSync('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleIdentifier', join(app, 'Info.plist')], { encoding: 'utf8' }).trim();
  assert.equal(id, 'io.github.zhengzhiyu0.maiacoach', 'Flutter must retain the original app identifier for upgrade storage access');
  const dependencies = execFileSync('xcrun', ['otool', '-L', join(app, 'Runner')], { encoding: 'utf8' });
  assert.doesNotMatch(dependencies, /Capacitor|Cordova/);
  const symbols = execFileSync('xcrun', ['nm', '-gj', join(app, 'Runner')], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  assert.match(symbols, /_sf_full_start/);
  if (config.profile === 'all') assert.match(symbols, /_sf_lite_start/);
  else assert.doesNotMatch(symbols, /_sf_lite_start/);
}
console.log(`Verified app bundle (${config.profile}): CoreML, isolated Stockfish, audio and original app identifier`);
