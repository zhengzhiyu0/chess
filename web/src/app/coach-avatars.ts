/**
 * Cartoon coach portraits (Maia's side), drawn as SVG so they stay crisp at any size.
 * All portraits share the same face and proportions; only hair, skin, clothes and accessories vary.
 */

type Hair = 'long' | 'bob' | 'bun' | 'ponytail' | 'short' | 'curly' | 'bald';
type Top = 'blazer' | 'tee' | 'turtleneck';

interface Coach {
  name: string;
  bg: [string, string];
  skin: string;
  hair: Hair;
  hairColor: string;
  top: Top;
  topColor: string;
  female?: boolean;
  beard?: boolean;
  glasses?: boolean;
  hoops?: boolean;
}

export const COACHES: Coach[] = [
  { name: '安娜', bg: ['#6f9bd1', '#3f679c'], skin: '#f3c6a6', hair: 'long', hairColor: '#3a2419', top: 'blazer', topColor: '#2c3e57', female: true },
  { name: '阿玛拉', bg: ['#666c74', '#33373d'], skin: '#b9784f', hair: 'bun', hairColor: '#2e1b24', top: 'tee', topColor: '#ece8e2', female: true, hoops: true },
  { name: '里奥', bg: ['#5fb3ac', '#2f7a74'], skin: '#f1c39f', hair: 'short', hairColor: '#5a3a24', top: 'blazer', topColor: '#33465e' },
  { name: '小美', bg: ['#d78ca9', '#94506f'], skin: '#f7d5ba', hair: 'bob', hairColor: '#1f1a1d', top: 'turtleneck', topColor: '#e0745e', female: true },
  { name: '维克多', bg: ['#86b07e', '#4a7447'], skin: '#ecbb98', hair: 'bald', hairColor: '#b9b4ae', top: 'blazer', topColor: '#5b4636', beard: true, glasses: true },
  { name: '索菲亚', bg: ['#f0b35a', '#bd7a2c'], skin: '#f8d8c2', hair: 'ponytail', hairColor: '#b5532c', top: 'tee', topColor: '#3f8f6a', female: true },
  { name: '奥马尔', bg: ['#d0895a', '#8c4f2e'], skin: '#8f5c3c', hair: 'curly', hairColor: '#1d1512', top: 'tee', topColor: '#2f4a6e', beard: true },
  { name: '格蕾丝', bg: ['#a993d6', '#6a539c'], skin: '#c48d65', hair: 'curly', hairColor: '#d8d3d0', top: 'turtleneck', topColor: '#5a3f7a', female: true, glasses: true },
];

/** Multiply each RGB channel of `#rrggbb` by `f`. */
function shade(hex: string, f: number): string {
  const n = parseInt(hex.slice(1), 16);
  const ch = (s: number) => Math.round(((n >> s) & 255) * f).toString(16).padStart(2, '0');
  return `#${ch(16)}${ch(8)}${ch(0)}`;
}

const BANGS = 'M20.4 28.5C20.6 18 25.6 12.6 32.6 12.6c7 0 11.6 5.4 11.4 14.6-5.4-.6-10.4-3.6-13-8.2-2.4 4.8-6.4 8.2-10.6 9.5z';

function backHair(c: Coach): string {
  const f = `fill="${c.hairColor}"`;
  switch (c.hair) {
    case 'long':
      return `<path d="M15.5 31c0-13 7.4-21 16.5-21s16.5 8 16.5 21v15.5c0 2.6-2.8 3.6-4.6 1.8L42 36H22l-1.9 12.3c-1.8 1.8-4.6.8-4.6-1.8z" ${f}/>`;
    case 'bob':
      return `<path d="M17 30c0-12 6.6-19.5 15-19.5S47 18 47 30v9.5c0 2.4-2.4 3.2-4 1.8L41.5 34h-19L21 41.3c-1.6 1.4-4 .6-4-1.8z" ${f}/>`;
    case 'bun':
      return `<circle cx="32" cy="12.4" r="5.4" ${f}/><ellipse cx="32" cy="27" rx="13" ry="14.4" ${f}/>`;
    case 'ponytail':
      return `<path d="M41.6 17.6c8.4.6 9.6 14.4 5.4 25.4-1.6-7.4-2.8-13.6-6.8-17.8z" ${f}/><ellipse cx="32" cy="27" rx="12.6" ry="14.4" ${f}/>`;
    case 'curly': {
      const pts = [[20.4, 29], [19.8, 23], [22.6, 17.6], [27, 14.2], [32, 13], [37, 14.2], [41.4, 17.6], [44.2, 23], [43.6, 29]];
      return pts.map(([x, y]) => `<circle cx="${x}" cy="${y}" r="4.6" ${f}/>`).join('');
    }
    default:
      return '';
  }
}

function frontHair(c: Coach): string {
  const f = `fill="${c.hairColor}"`;
  switch (c.hair) {
    case 'long':
    case 'bob':
    case 'bun':
    case 'ponytail':
      return `<path d="${BANGS}" ${f}/>`;
    case 'short':
      return `<path d="M20.5 28.4c-.9-9.4 3.6-15.8 11.5-15.8 7.6 0 12.6 5.4 11.6 15.8-1-4.6-2.6-7.2-4.8-8.4-4.2 1.6-9.6 1.6-13.8-.6-2.2 1.6-3.6 4.6-4.5 9z" ${f}/>`;
    case 'curly': {
      const pts = [[22.6, 21.4], [26.4, 18.4], [30.6, 17.2], [35, 17.4], [39.2, 18.8], [42, 22]];
      return pts.map(([x, y]) => `<circle cx="${x}" cy="${y}" r="3.4" ${f}/>`).join('');
    }
    case 'bald':
      return `<path d="M20.6 31.2c-.5-5 .3-8.6 2-10.6l.9 10.2zM43.4 31.2c.5-5-.3-8.6-2-10.6l-.9 10.2z" ${f}/><ellipse cx="27.6" cy="19.6" rx="3.4" ry="1.6" fill="#fff" opacity=".22"/>`;
  }
}

function clothes(c: Coach): string {
  const body = `<path d="M7 64c1.6-11 11-17.5 25-17.5S55.4 53 57 64z" fill="${c.topColor}"/>`;
  const neck =
    `<path d="M27 38h10v9.5c0 2.8-2.2 4.5-5 4.5s-5-1.7-5-4.5z" fill="${shade(c.skin, 0.93)}"/>` +
    `<path d="M27 42.5c1.5 1.2 3.2 1.8 5 1.8s3.5-.6 5-1.8V40H27z" fill="${shade(c.skin, 0.85)}"/>`;
  const dark = shade(c.topColor, 0.78);
  switch (c.top) {
    case 'blazer':
      return (
        body +
        '<path d="M25.5 47.2 32 57l6.5-9.8c-2-.5-4.2-.7-6.5-.7s-4.5.2-6.5.7z" fill="#f4f1ec"/>' +
        `<path d="M25.5 47.2 29 64h-4l-3.6-15.4zM38.5 47.2 35 64h4l3.6-15.4z" fill="${dark}"/>` +
        neck
      );
    case 'tee':
      return body + neck + `<path d="M26.6 47.6q5.4 5.6 10.8 0" fill="none" stroke="${dark}" stroke-width="1.4" stroke-linecap="round"/>`;
    case 'turtleneck':
      return body + neck + `<rect x="26.2" y="44.6" width="11.6" height="6.4" rx="3" fill="${dark}"/>`;
  }
}

function face(c: Coach): string {
  const ear = shade(c.skin, 0.96);
  const brow = c.hair === 'bald' ? shade(c.hairColor, 0.6) : c.hairColor === '#d8d3d0' ? '#7c716b' : c.hairColor;
  return (
    `<ellipse cx="20.6" cy="31.5" rx="2.4" ry="3.2" fill="${ear}"/><ellipse cx="43.4" cy="31.5" rx="2.4" ry="3.2" fill="${ear}"/>` +
    `<ellipse cx="32" cy="30" rx="11.4" ry="13.2" fill="${c.skin}"/>` +
    frontHair(c) +
    `<path d="M24.6 26.6q2.6-1.6 5 0M34.4 26.6q2.6-1.6 5 0" fill="none" stroke="${brow}" stroke-width="${c.female ? 1.3 : 1.7}" stroke-linecap="round"/>` +
    '<ellipse cx="27.2" cy="30.6" rx="1.7" ry="2" fill="#2a1a12"/><ellipse cx="36.8" cy="30.6" rx="1.7" ry="2" fill="#2a1a12"/>' +
    '<circle cx="27.8" cy="29.9" r=".55" fill="#fff"/><circle cx="37.4" cy="29.9" r=".55" fill="#fff"/>' +
    `<ellipse cx="24.4" cy="35.4" rx="2.4" ry="1.4" fill="#ec8f86" opacity="${c.female ? 0.45 : 0.25}"/><ellipse cx="39.6" cy="35.4" rx="2.4" ry="1.4" fill="#ec8f86" opacity="${c.female ? 0.45 : 0.25}"/>` +
    `<path d="M32 31.5v2.6l-1.1.6" fill="none" stroke="${shade(c.skin, 0.82)}" stroke-width="1.1" stroke-linecap="round" stroke-linejoin="round"/>` +
    `<path d="M28.2 37q3.8 3.4 7.6 0" fill="#fff" stroke="${c.female ? '#b9533f' : shade(c.skin, 0.6)}" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>`
  );
}

function extras(c: Coach): string {
  let s = '';
  if (c.beard) {
    s +=
      `<path d="M20.8 32c.6 7.6 5 12.4 11.2 12.4S42.6 39.6 43.2 32c-1.2 4-3 6.4-5.2 7.4-1 2.6-3.4 3.8-6 3.8s-5-1.2-6-3.8c-2.2-1-4-3.4-5.2-7.4z" fill="${c.hairColor}"/>` +
      `<path d="M28 35.8c1.6-1 3-.8 4 0 1-.8 2.4-1 4 0-1.4.9-2.8 1-4 .5-1.2.5-2.6.4-4-.5z" fill="${c.hairColor}"/>`;
  }
  if (c.glasses) {
    s +=
      '<g fill="rgba(255,255,255,.14)" stroke="#2b2b30" stroke-width="1.1">' +
      '<rect x="23.3" y="27.4" width="7.8" height="6.2" rx="2.4"/><rect x="32.9" y="27.4" width="7.8" height="6.2" rx="2.4"/></g>' +
      '<path d="M31.1 29.6q.9-.7 1.8 0M23.3 29.4h-2.2M40.7 29.4h2.2" fill="none" stroke="#2b2b30" stroke-width="1.1"/>';
  }
  if (c.hoops) s += '<circle cx="20.4" cy="36.6" r="2" fill="none" stroke="#e7b545" stroke-width="1"/><circle cx="43.6" cy="36.6" r="2" fill="none" stroke="#e7b545" stroke-width="1"/>';
  return s;
}

const cache = new Map<number, string>();

export function coachBg(index: number): string {
  const c = COACHES[index] ?? COACHES[0];
  return `linear-gradient(${c.bg[0]}, ${c.bg[1]})`;
}

export function coachSvg(index: number): string {
  const i = index >= 0 && index < COACHES.length ? index : 0;
  const hit = cache.get(i);
  if (hit) return hit;
  const c = COACHES[i];
  const svg = `<svg viewBox="9 7 46 46" aria-hidden="true">${backHair(c)}${clothes(c)}${face(c)}${extras(c)}</svg>`;
  cache.set(i, svg);
  return svg;
}
