// Copy the existing, licensed offline content; no Web UI is embedded in Flutter.
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripTypeScriptTypes } from 'node:module';
import { main as prepareFonts } from './prepare-fonts.mjs';

const app = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const web = resolve(app, '../web');
const assets = join(app, 'assets');
await prepareFonts();
// Keep the same app identity visually when upgrading the same Bundle ID.
cpSync(join(web, 'ios/App/App/Assets.xcassets/AppIcon.appiconset'),
  join(app, 'ios/Runner/Assets.xcassets/AppIcon.appiconset'), { recursive: true });
for (const [source, destination] of [
  ['icon-192.png', 'icons/Icon-192.png'],
  ['icon-512.png', 'icons/Icon-512.png'],
  ['icon-192.png', 'icons/Icon-maskable-192.png'],
  ['icon-maskable-512.png', 'icons/Icon-maskable-512.png'],
]) {
  cpSync(join(web, 'public/icons', source), join(app, 'web', destination));
}
for (const folder of ['pieces', 'boards', 'puzzles', 'sounds', 'licenses']) {
  mkdirSync(join(assets, folder), { recursive: true });
  cpSync(join(web, 'public', folder), join(assets, folder), { recursive: true });
}
mkdirSync(join(assets, 'data'), { recursive: true });
mkdirSync(join(assets, 'portraits'), { recursive: true });
mkdirSync(join(assets, 'native'), { recursive: true });
const source = (name) => readFileSync(join(web, 'src', name), 'utf8');
const book = JSON.parse(source('coach/book-data.ts').replace(/^.*?export default\s*/s, '').replace(/;\s*$/, ''));
writeFileSync(join(assets, 'data', 'openings.json'), JSON.stringify(book));
// These are checked-in TS data tables; evaluating their stripped modules preserves quoted names.
const importSource = async (text) => import(`data:text/javascript;base64,${Buffer.from(stripTypeScriptTypes(text, { mode: 'transform' })).toString('base64')}`);
const zh = await importSource(source('coach/opening-zh.ts').replace('const ZH:', 'export const ZH:'));
writeFileSync(join(assets, 'data', 'opening-zh.json'), JSON.stringify(zh.ZH));
const appearance = await importSource(source('app/appearance.ts'));
writeFileSync(join(assets, 'data', 'appearance.json'), JSON.stringify({ boards: appearance.BOARD_THEMES, pieces: appearance.PIECE_SETS }));
const portraits = await importSource(source('app/coach-avatars.ts'));
for (let i = 0; i < portraits.COACHES.length; i++) {
  writeFileSync(join(assets, 'portraits', `coach-${i}.svg`), portraits.coachSvg(i));
}
cpSync(join(web, 'src', 'coach-dialogue', 'lines.json'), join(assets, 'data', 'dialogue.json'));
cpSync(join(web, 'test', 'golden.json'), join(assets, 'data', 'golden.json'));

if (process.argv.includes('--web')) {
  // Browser preview uses actual WASM Stockfish and Maia, while all UI remains Flutter.
  for (const folder of ['engines', 'models']) {
    mkdirSync(join(app, 'web', folder), { recursive: true });
    cpSync(join(web, 'public', folder), join(app, 'web', folder), { recursive: true });
  }
}
const count = (dir) => readdirSync(dir, { withFileTypes: true }).reduce((n, e) => n + (e.isDirectory() ? count(join(dir, e.name)) : 1), 0);
if (!existsSync(join(assets, 'pieces', 'cburnett', 'wK.svg'))) throw new Error('Missing piece assets');
console.log(`Flutter content ready: ${count(assets)} files; puzzles, openings, pieces, audio, portraits and licenses included.`);
