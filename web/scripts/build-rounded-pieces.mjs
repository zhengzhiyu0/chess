// Vector redraw from the user-supplied reference, using a small number of smooth curves.
// Run from any directory: node web/scripts/build-rounded-pieces.mjs
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const output = fileURLToPath(new URL('../public/pieces/rounded/', import.meta.url));
mkdirSync(output, { recursive: true });
const palettes = {
  w: { body: '#b9ceda', shade: '#96afbd', light: '#d9e9f2', mid: '#c7dce6', detail: '#809ba9' },
  b: { body: '#54717e', shade: '#3f5966', light: '#7998a5', mid: '#668692', detail: '#354f5c' },
};

function artwork(role, originalPalette, color) {
  // Restore the reference blue-grey whites, keeping dark roles free of outer outlines.
  const p = 'RNB'.includes(role) ? color === 'w'
    ? { body: '#c8d4e0', shade: '#7898a8', light: '#f2ffff', mid: '#d7e4ed', detail: '#7898a8' }
    : { body: '#435762', shade: '#101f26', light: '#6b8c99', mid: '#526f7d', detail: '#101f26' }
    : originalPalette;
  const path = (d, fill = p.body) => `<path fill="${fill}" d="${d}"/>`;
  const ellipse = (cx, cy, rx, ry, fill) => `<ellipse cx="${cx}" cy="${cy}" rx="${rx}" ry="${ry}" fill="${fill}"/>`;
  const rect = (x, y, w, h, r, fill) => `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${r}" fill="${fill}"/>`;
  // Filled shapes, with a restrained second shade; no blur or hairline outlines.
  switch (role) {
    case 'P': return [
      path('M40 49C39 59 28 67 28 77C28 86 37 90 50 90S72 86 72 77C72 67 61 59 60 49Z'),
      path('M29 73C30 82 39 85 50 85S70 82 71 73C75 85 64 91 50 91S25 85 29 73Z', p.shade),
      ellipse(50, 36, 20, 20, p.body),
      ellipse(44, 29, 8, 8, p.light),
      path('M38 53Q50 59 62 53L59 59Q50 63 41 59Z', p.shade),
    ].join('');
    case 'R': return [
      path('M29 57H71V75C71 84 62 89 50 89S29 84 29 75Z'),
      path('M34 64Q50 70 66 64Q69 63 69 66Q69 68 66 69Q50 75 34 69Q31 68 31 66Q31 63 34 64Z', p.shade),
      path('M20 32C20 23 24 17 29 13Q31 12 33 15L36 20H40V11Q40 8 44 8H56Q60 8 60 11V20H64L67 15Q69 12 71 13C76 17 80 23 80 32V47C80 59 70 65 50 65S20 59 20 47Z'),
      path('M32 35C32 26 40 21 50 21S68 26 68 35L65 41H35Z', p.mid),
      path('M35 35C35 29 41 27 50 27S65 29 65 35L63 40Q50 44 37 40Z', p.shade),
      path('M39 39Q50 42 61 39L64 46Q64 49 50 49T36 46Z', p.light),
      path('M21 29Q22 20 29 15L34 21Q29 26 29 33L31 39L25 43Q21 39 21 29Z', p.light),
      path('M79 29Q78 20 71 15L66 21Q71 26 71 33L69 39L75 43Q79 39 79 29Z', p.light),
      path('M40 11Q50 9 60 11V18Q50 16 40 18Z', p.light),
    ].join('');
    case 'N': return [
      path('M34 48C26 54 20 53 16 49C12 45 10 39 13 35L29 19Q27 13 29 8Q29 5 32 7L41 13C45 10 51 9 58 9C73 9 79 14 79 25V74C79 84 71 89 57 89C43 89 31 84 31 74C31 64 34 55 39 49Z'),
      path('M29 9L41 17C52 13 72 14 78 22V29C71 20 53 20 43 23L32 17L34 23L15 41Q12 43 12 39Q11 37 15 33L29 19Z', p.light),
      ellipse(46, 35, 2.7, 4.7, p.shade),
      `<path d="M44 49Q56 56 65 47" fill="none" stroke="${p.shade}" stroke-width="3.6" stroke-linecap="round"/>`,
    ].join('');
    case 'B': {
      const silhouette = 'M45 19L24 45C17 53 17 64 23 72C28 79 38 83 50 83C66 83 77 75 79 64C81 56 77 47 73 43Q71.5 41 69.5 43L58 53Q55 55 56.5 51.5L65 33Q66 31 64 29L54 18Z';
      return [
      path('M31 73C31 85 39 91 50 91S69 85 69 73Z', p.shade),
      path(silhouette),
      // One straight cut plane; clip only at the smooth outside edge.
      `<defs><clipPath id="body"><path d="${silhouette}"/></clipPath></defs><g clip-path="url(#body)">${path('M57 53.5L78 35L90 39Z', p.shade)}</g>`,
      path('M45 29Q48 26 51 29Q53 32 50 35L36 51Q33 54 30 51Q27 49 30 46Z', p.light),
      ellipse(50, 13, 8, 6, p.body),
      ellipse(50, 19, 4.6, 1.3, p.shade),
    ].join('');
    }
    case 'Q': return [
      // Broad rounded tips and a capsule foot, matched to the supplied reference.
      path('M31 62Q50 52 69 62L68 78Q68 92 50 92Q32 92 32 78Z', p.shade),
      path('M32 77C32 60 23 46 12 37Q8 33 13 32L23 32Q25 32 25 29L25 17Q25 12 30 15L39 19Q41 20 43 17L48 12Q50 9 53 12L59 18Q61 20 64 18L73 15Q77 13 77 18L77 29Q77 32 80 32H88Q93 32 89 36C76 46 68 60 68 77Q68 86 50 86Q32 86 32 77Z'),
      path('M28 42Q50 22 72 42Q75 45 72 48L66 54Q64 56 61 53Q50 42 39 53Q36 56 34 54L28 48Q25 45 28 42Z', p.light),
      ellipse(50, 75, 6, 6, p.mid),
    ].join('');
    case 'K': return [
      // A wide, soft heart silhouette; the lower end remains round rather than triangular.
      ellipse(50, 80, 17, 12, p.shade),
      path('M50 29C39 20 20 22 14 35C5 53 22 67 33 79Q36 87 50 88Q64 87 67 79C78 67 95 53 86 35C80 22 61 20 50 29Z'),
      path('M36 30Q50 26 64 30L65 37Q65 43 57 44H43Q35 43 35 37Z', p.mid),
      path('M34 63Q37 59 41 62L47 65Q50 67 53 65L59 62Q63 59 66 63L68 67Q69 71 64 77Q59 84 50 84Q41 84 36 77Q31 71 32 67Z', p.light),
      rect(46, 9, 8, 29, 3, p.shade),
      rect(38, 16, 24, 8, 3, p.shade),
      rect(46, 9, 8, 5, 2, p.light),
      rect(38, 16, 8, 4, 2, p.mid),
    ].join('');
  }
}

for (const [color, palette] of Object.entries(palettes)) {
  for (const role of 'KQRBNP') {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 100 100">${artwork(role, palette, color)}</svg>\n`;
    writeFileSync(`${output}/${color}${role}.svg`, svg, 'utf8');
  }
}
console.log('Generated 12 rounded SVG reference redraws.');
