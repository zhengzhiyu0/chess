// Imports the downloaded upstream sources documented in public/licenses/piece-additions/README.md.
// Usage: node scripts/import-classic-pieces.mjs ../tmp/classic-pieces-20261105
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

if (!process.argv[2]) throw new Error('Pass the directory containing the downloaded upstream sources');
const sourceDir = resolve(process.argv[2]);
const outputDir = resolve(dirname(fileURLToPath(import.meta.url)), '../public/pieces');
const roles = { K: 'king', Q: 'queen', R: 'rook', B: 'bishop', N: 'knight', P: 'pawn' };
const johnPablok = join(sourceDir, 'cburnett-v2/JohnPablok Cburnett Chess-v2/JohnPablok Cburnett Chess set');
function save(set, color, role, svg) {
  const directory = join(outputDir, set);
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, `${color}${role}.svg`), svg);
}
for (const color of ['w', 'b']) for (const [role, name] of Object.entries(roles)) {
  for (const shadow of [false, true]) {
    const source = join(johnPablok, shadow ? 'SVG with shadow' : 'SVG No shadow', `${color}_${name}_svg_${shadow ? 'withShadow' : 'NoShadow'}.svg`);
    let svg = readFileSync(source, 'utf8');
    const [, , width, height] = svg.match(/viewBox="([^"]+)"/)[1].split(/\s+/).map(Number);
    // Upstream exports crop each piece independently. Keep the original relative sizes,
    // align their bases, and leave space for the optional embedded PNG drop shadow.
    svg = svg.replace(/viewBox="[^"]+"/, `viewBox="${-(450 - width) / 2} ${-(420 - height)} 450 450"`);
    save(shadow ? 'cburnett-v2-shadow' : 'cburnett-v2', color, role, svg);
  }
  for (const [set, directory] of [['kaneo', 'chess_kaneo'], ['kaneo-midnight', 'chess_kaneo_midnight']]) {
    let svg = readFileSync(join(sourceDir, 'kadagaden/chess-pieces-master', directory, `${color}${role}.svg`), 'utf8');
    svg = svg.replace(/\s(?:width|height)="[^"]*"/g, '');
    save(set, color, role, svg);
  }
  save('sashite', color, role, readFileSync(join(sourceDir, 'sashite', `${color}${role}.svg`), 'utf8'));
}

// DG-RA is an SVG sheet with a background group and twelve independent piece groups.
// Extract only each piece, retaining its local paths/colors, with a shared square viewBox.
const browser = await chromium.launch({ channel: 'msedge', headless: true });
try {
  const page = await browser.newPage();
  await page.setContent(readFileSync(join(sourceDir, 'dg-ra.svg'), 'utf8'));
  const ids = {
    wK: 'g10-37', wQ: 'g10-0', wR: 'g10-7', wB: 'g10-84', wN: 'g10-73', wP: 'g10-8',
    bK: 'g10-6', bQ: 'g10', bR: 'g10-3', bB: 'g10-35', bN: 'g10-78', bP: 'g10-9',
  };
  for (const [piece, id] of Object.entries(ids)) {
    const group = await page.evaluate(id => {
      const original = document.getElementById(id);
      if (!original) throw new Error(`Missing upstream group ${id}`);
      const copy = original.cloneNode(true);
      copy.removeAttribute('transform');
      for (const element of [copy, ...copy.querySelectorAll('*')]) {
        for (const attribute of [...element.attributes]) {
          if (attribute.name.includes(':') || attribute.name === 'id') element.removeAttribute(attribute.name);
        }
      }
      return copy.outerHTML;
    }, id);
    save('dg-ra', piece[0], piece[1], `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-1 -1 35.75 35.75">${group}</svg>\n`);
  }
} finally {
  await browser.close();
}
console.log('Imported six sets, 72 local SVG pieces');
