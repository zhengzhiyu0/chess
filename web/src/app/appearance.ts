// Board colours and piece sets. Piece SVGs live in public/pieces/<set>/ and are precached for offline use.

export const BOARD_THEMES: Record<string, { label: string; light: string; dark: string }> = {
  green: { label: '绿白', light: '#ebecd0', dark: '#739552' },
  brown: { label: '经典棕', light: '#f0d9b5', dark: '#b58863' },
  wood: { label: '胡桃木', light: '#e9c99a', dark: '#a26c3d' },
  blue: { label: '冰蓝', light: '#dee3e6', dark: '#8ca2ad' },
  ocean: { label: '海洋', light: '#d7e6f0', dark: '#5b86b0' },
  purple: { label: '紫罗兰', light: '#e4dbef', dark: '#8e74a8' },
  coral: { label: '珊瑚', light: '#f3dcd2', dark: '#c0705c' },
  gray: { label: '石墨灰', light: '#dcdcdc', dark: '#8f8f8f' },
  night: { label: '夜间', light: '#8a93a3', dark: '#4b5466' },
};

export const PIECE_SETS: Record<string, string> = {
  cburnett: '经典（cburnett）',
  rhosgfx: 'RhosGFX',
  merida: 'Merida',
  chessnut: 'Chessnut',
  fantasy: 'Fantasy',
  spatial: 'Spatial',
  celtic: 'Celtic',
  mpchess: 'MPChess',
  pixel: '像素',
  shapes: '几何',
  letter: '字母',
};

const ROLE: Record<string, string> = { p: 'pawn', n: 'knight', b: 'bishop', r: 'rook', q: 'queen', k: 'king' };

export function pieceUrl(set: string, color: 'w' | 'b', role: string) {
  return `pieces/${PIECE_SETS[set] ? set : 'cburnett'}/${color}${role.toUpperCase()}.svg`;
}

export function boardColors(theme: string, light: string, dark: string) {
  if (theme === 'custom') return { light, dark };
  return BOARD_THEMES[theme] ?? BOARD_THEMES.green;
}

let styleEl: HTMLStyleElement | null = null;

export function applyAppearance(theme: string, light: string, dark: string, set: string) {
  const c = boardColors(theme, light, dark);
  const root = document.documentElement.style;
  root.setProperty('--light-sq', c.light);
  root.setProperty('--dark-sq', c.dark);
  if (!styleEl) {
    styleEl = document.createElement('style');
    document.head.appendChild(styleEl);
  }
  let css = '';
  for (const [r, name] of Object.entries(ROLE))
    for (const [col, cls] of [['w', 'white'], ['b', 'black']] as const)
      css += `.cg-wrap piece.${name}.${cls}{background-image:url('${pieceUrl(set, col, r)}')}\n`;
  styleEl.textContent = css;
}
