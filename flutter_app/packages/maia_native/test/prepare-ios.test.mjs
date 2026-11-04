import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { assembleModel, checkedChild, NETWORKS, selection } from '../../../scripts/prepare-ios.mjs';

const plugin = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const app = resolve(plugin, '../..');
const repository = resolve(app, '..');

test('profiles retain full/lite selection and reject misspelled profiles', () => {
  assert.deepEqual(selection('all').engines, ['full', 'lite']);
  assert.deepEqual(selection('all').models, ['5m', '23m', '79m']);
  assert.deepEqual(selection('79m-full').engines, ['full']);
  assert.deepEqual(selection('79m-full').models, ['79m']);
  assert.throws(() => selection('full'), /Unknown/);
});

test('generated operation guard rejects root, traversal and redirected directories', (t) => {
  const workspace = mkdtempSync(join(tmpdir(), 'maia-native-guard-'));
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  const root = join(workspace, 'generated');
  const external = join(workspace, 'external');
  mkdirSync(root);
  mkdirSync(external);
  assert.equal(checkedChild(root, join(root, 'model.mlmodelc')), join(root, 'model.mlmodelc'));
  assert.throws(() => checkedChild(root, root), /Refusing/);
  assert.throws(() => checkedChild(root, join(root, '..', 'external')), /Refusing/);
  // Windows junctions do not need Developer Mode symlink privileges.
  symlinkSync(external, join(root, 'redirect'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => checkedChild(root, join(root, 'redirect', 'model.mlmodelc')), /symlink|redirected/);
});

test('model assembly checks order, size, full SHA-256 and part traversal before output', async (t) => {
  const workspace = mkdtempSync(join(tmpdir(), 'maia-native-model-'));
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  const directory = join(workspace, 'source');
  const destination = join(workspace, 'output', 'maia3-test.onnx');
  mkdirSync(directory);
  const parts = ['part00-1234.bin', 'part01-5678.bin'];
  const data = Buffer.from('verified model payload');
  writeFileSync(join(directory, parts[0]), data.subarray(0, 8));
  writeFileSync(join(directory, parts[1]), data.subarray(8));
  const manifest = { size: data.length, sha256: createHash('sha256').update(data).digest('hex'), parts };
  const save = (value) => writeFileSync(join(directory, 'manifest.json'), JSON.stringify(value));
  save(manifest);
  await assembleModel(directory, destination);
  assert.deepEqual(readFileSync(destination), data);
  save({ ...manifest, parts: [...parts].reverse() });
  await assert.rejects(assembleModel(directory, destination), /do not match/);
  save({ ...manifest, size: data.length + 1 });
  await assert.rejects(assembleModel(directory, destination), /do not match/);
  save({ ...manifest, sha256: '0'.repeat(64) });
  await assert.rejects(assembleModel(directory, destination), /do not match/);
  save({ ...manifest, parts: ['../secret.bin'] });
  await assert.rejects(assembleModel(directory, destination), /Unsafe/);
  assert.deepEqual(readFileSync(destination), data, 'failed verification must not overwrite a good model');
});

test('prepare-only is offline and generates correct wrapper include trees and licensed audio', () => {
  const config = selection(process.env.NATIVE_PROFILE ?? 'all');
  execFileSync(process.execPath, [join(app, 'scripts', 'prepare-ios.mjs'), '--prepare-only'], { stdio: 'pipe' });
  const generated = join(plugin, 'ios', 'EngineSources');
  assert.equal(JSON.parse(readFileSync(join(generated, 'native-profile.json'), 'utf8')).profile, config.profile);
  for (const engine of config.engines) {
    assert.match(readFileSync(join(generated, engine, 'bridge.cpp'), 'utf8'), /\.\.\/bridge\/sf_bridge.cpp/);
    assert.match(readFileSync(join(generated, engine, 'engine.cpp'), 'utf8'), /\.\.\/src\/engine.cpp/);
    assert.ok(existsSync(join(generated, engine, 'include', `sf_${engine}.h`)));
  }
  const header = readFileSync(join(generated, 'src', 'evaluate.h'), 'utf8');
  for (const name of Object.values(NETWORKS)) assert.ok(header.includes(name));
  assert.ok(existsSync(join(app, 'assets', 'native')));
  const sounds = join(plugin, 'ios', 'Resources', 'MaiaNativeAssets.bundle', 'sounds');
  assert.ok(existsSync(join(sounds, 'LICENSE-Kenney.txt')));
  assert.deepEqual(readFileSync(join(sounds, 'standard', 'move.mp3')),
    readFileSync(join(repository, 'web', 'public', 'sounds', 'standard', 'move.mp3')));
});

test('both real profiles verify all selected NNUE hashes/model manifests and remove unselected artifacts', async () => {
  const run = (profile) => execFileSync(process.execPath, [join(app, 'scripts', 'prepare-ios.mjs')], {
    env: { ...process.env, NATIVE_PROFILE: profile }, encoding: 'utf8', timeout: 240_000,
  });
  const digest = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');
  try {
    // Real checked-in ONNX parts and real NNUE, not synthetic CoreML files.
    for (const profile of ['all', '79m-full']) {
      const config = selection(profile);
      assert.match(run(profile), /Verified NNUE and assembled ONNX ready/);
      for (const engine of config.engines) {
        const name = NETWORKS[engine];
        assert.ok(digest(join(app, 'assets', 'native', name)).startsWith(name.slice(3, 15)));
        assert.ok(existsSync(join(plugin, 'ios', 'EngineSources', engine, 'bridge.cpp')));
      }
      for (const model of config.models) {
        const manifest = JSON.parse(readFileSync(join(repository, 'web', 'native-models', `maia3-${model}`, 'manifest.json'), 'utf8'));
        const assembled = join(app, 'assets', 'native', `maia3-${model}.onnx`);
        assert.equal(digest(assembled), manifest.sha256);
        assert.equal(readFileSync(assembled).length, manifest.size);
      }
      if (profile === '79m-full') {
        assert.ok(!existsSync(join(plugin, 'ios', 'EngineSources', 'lite')));
        assert.ok(!existsSync(join(app, 'assets', 'native', NETWORKS.lite)));
        for (const name of ['5m', '23m']) {
          assert.ok(!existsSync(join(app, 'assets', 'native', `maia3-${name}.onnx`)));
          assert.ok(!existsSync(join(app, 'assets', 'native', `maia3-${name}.mlmodelc`)));
        }
      }
    }
  } finally {
    // Restore the requested profile so tests never leave pod installation and
    // application defaults pointing at different native configurations.
    run(process.env.NATIVE_PROFILE ?? 'all');
  }
});
