// Capacitor sync regenerates the SPM wrapper with its default iOS 15 floor.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

function replaceRequired(path, before, after) {
  const contents = readFileSync(path, 'utf8');
  if (!contents.includes(before)) {
    if (contents.includes(after)) return;
    throw new Error(`Could not find iOS deployment target in ${path}`);
  }
  writeFileSync(path, contents.replaceAll(before, after));
}

replaceRequired(
  join(root, 'ios', 'App', 'App.xcodeproj', 'project.pbxproj'),
  'IPHONEOS_DEPLOYMENT_TARGET = 15.0;',
  'IPHONEOS_DEPLOYMENT_TARGET = 17.0;',
);
replaceRequired(
  join(root, 'ios', 'App', 'CapApp-SPM', 'Package.swift'),
  'platforms: [.iOS(.v15)],',
  'platforms: [.iOS(.v17)],',
);
