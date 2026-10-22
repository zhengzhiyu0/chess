/**
 * Coach portraits (Maia's side) in a bold, flat "learning-app mascot" style: big eyes, squircle heads,
 * saturated colours and no outlines, so they still read at 36px.
 * Drawn as SVG on a 100×100 canvas; the tile background is part of the SVG.
 * No <defs>/ids: these SVGs are inlined many times on one page.
 */

type Hair = 'sweep' | 'buns' | 'quiff' | 'bald' | 'afro' | 'spiky' | 'beanie' | 'bun';
type Mouth = 'open' | 'grin' | 'smirk' | 'smile';

interface Coach {
  name: string;
  bg: string;
  skin: string;
  hair: Hair;
  hairColor: string;
  top: string;
  mouth: Mouth;
  hat?: string;
  /** half-closed eyelids */
  lid?: boolean;
  beard?: boolean;
  stache?: boolean;
  glasses?: 'round' | 'square';
  hoops?: boolean;
  /** V-neck collar */
  collar?: boolean;
}

export const COACHES: Coach[] = [
  { name: '莉亚', bg: '#8e7cf0', skin: '#f6cdb0', hair: 'sweep', hairColor: '#3a2a6b', top: '#5b45c9', mouth: 'smirk', lid: true },
  { name: '小柚', bg: '#ffb340', skin: '#f9d4b6', hair: 'buns', hairColor: '#e2672f', top: '#ff5f7a', mouth: 'open' },
  { name: '里奥', bg: '#48c6b8', skin: '#efbf98', hair: 'quiff', hairColor: '#7a4a26', top: '#2f8f5f', mouth: 'grin' },
  { name: '维克多', bg: '#7fb069', skin: '#f0c4a0', hair: 'bald', hairColor: '#eeeae4', top: '#8a5a3c', mouth: 'smile', stache: true, glasses: 'round' },
  { name: '扎拉', bg: '#ff7a59', skin: '#9a5e3a', hair: 'afro', hairColor: '#22161a', top: '#ffd23f', mouth: 'open', hoops: true },
  { name: '阿健', bg: '#4aa3f0', skin: '#f3cba5', hair: 'spiky', hairColor: '#16161c', top: '#ffffff', mouth: 'grin', glasses: 'square', collar: true },
  { name: '奥斯卡', bg: '#f0a33a', skin: '#b87a52', hair: 'beanie', hairColor: '#3b2416', hat: '#e2453c', top: '#3f5c8c', mouth: 'smile', beard: true },
  { name: '梅姨', bg: '#e886b0', skin: '#f5d0b8', hair: 'bun', hairColor: '#b9b3c4', top: '#5d8f7a', mouth: 'smile', glasses: 'round', lid: true },
];

/** Multiply each RGB channel of `#rrggbb` by `f` (clamped). */
function shade(hex: string, f: number): string {
  const n = parseInt(hex.slice(1), 16);
  const ch = (s: number) => Math.min(255, Math.round(((n >> s) & 255) * f)).toString(16).padStart(2, '0');
  return `#${ch(16)}${ch(8)}${ch(0)}`;
}

const HEAD = 'M27 45C27 29 37 21 50 21s23 8 23 24v8c0 14-9 22-23 22s-23-8-23-22z';

function backHair(c: Coach): string {
  const f = `fill="${c.hairColor}"`;
  switch (c.hair) {
    case 'sweep':
      return `<path d="M23 48c0-22 12-33 28-33s26 12 26 32v34H23z" ${f}/>`;
    case 'buns':
      return `<circle cx="28" cy="22" r="11" ${f}/><circle cx="72" cy="22" r="11" ${f}/><path d="M25 50c0-19 11-29 25-29s25 10 25 29v8H25z" ${f}/>`;
    case 'afro':
      return `<circle cx="50" cy="38" r="31" ${f}/><circle cx="24" cy="50" r="12" ${f}/><circle cx="76" cy="50" r="12" ${f}/>`;
    case 'bun':
      return `<circle cx="50" cy="13" r="10" ${f}/><path d="M26 50c0-19 10-29 24-29s24 10 24 29z" ${f}/>`;
    default:
      return '';
  }
}

function frontHair(c: Coach): string {
  const f = `fill="${c.hairColor}"`;
  switch (c.hair) {
    case 'sweep':
      return `<path d="M26 47c-1-17 10-28 25-28 14 0 23 9 23 22-11 0-24-5-31-13-2 9-8 16-17 19z" ${f}/>`;
    case 'buns':
      return `<path d="M27 42c1-13 10-21 23-21s22 8 23 21c-6-1-12-5-15-10-2 4-6 7-10 8-1-3-2-5-2-7-5 5-12 8-19 9z" ${f}/>`;
    case 'quiff':
      return `<path d="M26 47c-3-18 5-30 20-31 5-7 20-6 25 3 6 5 6 16 2 28-1-7-3-12-6-14-10 3-22 2-31-2-4 4-8 9-10 16z" ${f}/>`;
    case 'afro':
      return `<path d="M27 40c2-13 11-19 23-19s21 6 23 19c-8-4-16-6-23-6s-15 2-23 6z" ${f}/>`;
    case 'spiky':
      return `<path d="M26 46c-3-12 0-20 5-24l-1-8 8 5 5-9 5 8 7-8 3 9 9-5-1 9c5 5 7 13 5 23-2-6-5-10-9-12-9 3-21 3-29-1-3 3-5 7-7 13z" ${f}/>`;
    case 'bun':
      return `<path d="M27 44c0-14 10-23 23-23s23 9 23 23c-9-2-17-7-23-14-6 7-14 12-23 14z" ${f}/>`;
    case 'beanie': {
      // brim sits at y≈30–37 so the brows (y≈40) stay on the forehead
      const hat = c.hat ?? '#e2453c';
      return (
        `<path d="M28 44v-8h4v10zM72 44v-8h-4v10z" ${f}/>` +
        `<path d="M26 33c0-13 11-21 24-21s24 8 24 21z" fill="${hat}"/>` +
        `<path d="M38 15v18M50 12v21M62 15v18" stroke="${shade(hat, 0.86)}" stroke-width="2.4" stroke-linecap="round"/>` +
        `<rect x="24" y="29" width="52" height="9" rx="4.5" fill="${shade(hat, 0.8)}"/>` +
        `<circle cx="50" cy="10" r="5" fill="${shade(hat, 0.8)}"/>`
      );
    }
    case 'bald':
      return `<path d="M27 54c-2-7-1-13 2-17l3 17zM73 54c2-7 1-13-2-17l-3 17z" ${f}/><ellipse cx="41" cy="28" rx="7" ry="3" transform="rotate(-20 41 28)" fill="#fff" opacity=".35"/>`;
  }
}

function eyes(c: Coach): string {
  let s = '';
  for (const x of [40, 60]) {
    const look = x < 50 ? 1 : -1;
    s +=
      `<ellipse cx="${x}" cy="49" rx="6" ry="7" fill="#fff"/>` +
      `<circle cx="${x + look}" cy="50.5" r="4.2" fill="#2b1d16"/>` +
      `<circle cx="${x + look + 1.4}" cy="48.8" r="1.5" fill="#fff"/>`;
    if (c.lid) {
      s +=
        `<path d="M${x - 6.6} 48.6c0-5 3-8.4 6.6-8.4s6.6 3.4 6.6 8.4z" fill="${c.skin}"/>` +
        `<path d="M${x - 6.6} 48.6h13.2" stroke="${shade(c.skin, 0.55)}" stroke-width="1.6" stroke-linecap="round"/>`;
    }
  }
  const light = c.hair === 'bald' || c.hair === 'bun';
  const brow = light ? shade(c.hairColor, 0.55) : c.hairColor;
  const y = c.lid ? 39 : 38.5;
  s += `<path d="M34 ${y}q6-3.5 11-.6M66 ${y}q-6-3.5-11-.6" fill="none" stroke="${brow}" stroke-width="3" stroke-linecap="round"/>`;
  return s;
}

function mouth(c: Coach): string {
  const dk = '#5b1f24';
  switch (c.mouth) {
    case 'open':
      return (
        `<path d="M41 61h18c0 6-4 10-9 10s-9-4-9-10z" fill="${dk}"/>` +
        '<path d="M42 61h16c0 1.8-.6 3-1 3H43c-.4 0-1-1.2-1-3z" fill="#fff"/>' +
        '<ellipse cx="50" cy="68.4" rx="4.6" ry="2.6" fill="#f06a7a"/>'
      );
    case 'grin':
      return `<path d="M41 61q9 3 18 0c-1 6-4.5 8.6-9 8.6s-8-2.6-9-8.6z" fill="${dk}"/><path d="M42 61.6q8 2.4 16 0l-.6 2q-7.4 2-14.8 0z" fill="#fff"/>`;
    case 'smirk':
      return `<path d="M42 63q6 4 15-1" fill="none" stroke="${dk}" stroke-width="2.6" stroke-linecap="round"/>`;
    case 'smile':
      return `<path d="M42 62q8 6 16 0" fill="none" stroke="${dk}" stroke-width="2.8" stroke-linecap="round"/>`;
  }
}

function extras(c: Coach): string {
  let s = '';
  if (c.stache) s += `<path d="M38 61c3-5 8-5 12-2 4-3 9-3 12 2-4 2-8 2-12 0-4 2-8 2-12 0z" fill="${c.hairColor}"/>`;
  if (c.glasses === 'round') {
    s += '<g fill="none" stroke="#3a2a22" stroke-width="2"><circle cx="40" cy="49" r="8.6"/><circle cx="60" cy="49" r="8.6"/><path d="M48.6 48q1.4-1.4 2.8 0M31.4 48H27M68.6 48H73"/></g>';
  }
  if (c.glasses === 'square') {
    s += '<g fill="none" stroke="#1d3d7a" stroke-width="2.4"><rect x="31" y="41.5" width="18" height="14" rx="4"/><rect x="51" y="41.5" width="18" height="14" rx="4"/><path d="M49 47h2M31 47h-4M69 47h4"/></g>';
  }
  if (c.hoops) s += '<circle cx="26" cy="60" r="4" fill="none" stroke="#ffd23f" stroke-width="2.2"/><circle cx="74" cy="60" r="4" fill="none" stroke="#ffd23f" stroke-width="2.2"/>';
  return s;
}

const cache = new Map<number, string>();

export function coachBg(index: number): string {
  return (COACHES[index] ?? COACHES[0]).bg;
}

export function coachSvg(index: number): string {
  const i = index >= 0 && index < COACHES.length ? index : 0;
  const hit = cache.get(i);
  if (hit) return hit;
  const c = COACHES[i];
  const neck = shade(c.skin, 0.88);
  const svg =
    '<svg viewBox="0 0 100 100" aria-hidden="true">' +
    `<rect width="100" height="100" fill="${c.bg}"/><circle cx="50" cy="50" r="40" fill="#fff" opacity=".12"/>` +
    backHair(c) +
    `<path d="M14 100c0-13 15-21 36-21s36 8 36 21z" fill="${c.top}"/>` +
    `<path d="M43 70h14v9c0 4-3 6-7 6s-7-2-7-6z" fill="${neck}"/>` +
    (c.collar ? '<path d="M41 80l9 8 9-8" fill="none" stroke="#c9d3e0" stroke-width="2.4" stroke-linejoin="round"/>' : '') +
    `<circle cx="27" cy="52" r="5" fill="${neck}"/><circle cx="73" cy="52" r="5" fill="${neck}"/>` +
    `<path d="${HEAD}" fill="${c.skin}"/>` +
    frontHair(c) +
    eyes(c) +
    '<ellipse cx="33" cy="59" rx="4" ry="2.4" fill="#ff7b7b" opacity=".3"/><ellipse cx="67" cy="59" rx="4" ry="2.4" fill="#ff7b7b" opacity=".3"/>' +
    `<path d="M47 54.5c0 2.6 1.4 4 3 4s3-1.4 3-4" fill="${neck}"/>` +
    (c.beard
      ? `<path d="M27.5 52c1 15 9 23 22.5 23s21.5-8 22.5-23c-3 6-7 8-11 8-2-2-6-3-11.5-3s-9.5 1-11.5 3c-4 0-8-2-11-8z" fill="${c.hairColor}"/>`
      : '') +
    mouth(c) +
    extras(c) +
    '</svg>';
  cache.set(i, svg);
  return svg;
}
