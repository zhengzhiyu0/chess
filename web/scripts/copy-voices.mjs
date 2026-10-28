// One source of truth: the approved, already baked recordings. No generation/API calls here.
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const source = join(root, '..', 'ChessCoachResources');
const { clips } = JSON.parse(readFileSync(join(source, 'coach_lines.json'), 'utf8'));
if (clips.length !== 121 || new Set(clips.map(c => c.id)).size !== 121) throw new Error('Expected 121 distinct Lia clips');
const destination = join(root, 'public', 'voices', 'lia');
mkdirSync(destination, { recursive: true });
const catalog = clips.map(({ id, category, text, file }) => {
  if (file !== `${id}.m4a` || !/^lia_[a-z_]+_\d{2}$/.test(id)) throw new Error(`Invalid Lia clip: ${id}`);
  copyFileSync(join(source, 'Audio', file), join(destination, file));
  return { id, category, text, file };
});
const json = JSON.stringify(catalog, null, 2) + '\n';
mkdirSync(join(root, 'src', 'lia'), { recursive: true });
writeFileSync(join(root, 'src', 'lia', 'lines.json'), json);
writeFileSync(join(destination, 'catalog.json'), json);
console.log(`Lia: ${catalog.length} bundled recordings`);
