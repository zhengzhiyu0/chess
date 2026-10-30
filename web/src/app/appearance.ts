// Board colours and piece sets. Piece assets live in public/pieces/<set>/ and board textures in public/boards/; both are precached for offline use.

type BoardTheme = { label: string; light: string; dark: string; image?: string };

export const BOARD_THEMES: Record<string, BoardTheme> = {
  green: { label: '绿白', light: '#ebecd0', dark: '#739552' },
  brown: { label: '经典棕', light: '#f0d9b5', dark: '#b58863' },
  wood: { label: '胡桃木', light: '#e9c99a', dark: '#a26c3d' },
  wood2: { label: '胡桃木 2', light: '#e9c99a', dark: '#a26c3d', image: 'wood2.jpg' },
  wood3: { label: '胡桃木 3', light: '#e9c99a', dark: '#a26c3d', image: 'wood3.jpg' },
  wood4: { label: '胡桃木 4', light: '#e9c99a', dark: '#a26c3d', image: 'wood4.jpg' },
  maple: { label: '枫木', light: '#f0d9b5', dark: '#b58863', image: 'maple.jpg' },
  maple2: { label: '枫木 2', light: '#f0d9b5', dark: '#b58863', image: 'maple2.jpg' },
  blue: { label: '冰蓝', light: '#dee3e6', dark: '#8ca2ad' },
  blue2: { label: '蓝色 2', light: '#dee3e6', dark: '#8ca2ad', image: 'blue2.jpg' },
  blue3: { label: '蓝色 3', light: '#dee3e6', dark: '#8ca2ad', image: 'blue3.jpg' },
  blueMarble: { label: '蓝色大理石', light: '#dee3e6', dark: '#8ca2ad', image: 'blue-marble.jpg' },
  canvas: { label: '画布', light: '#d8c7a7', dark: '#a88b62', image: 'canvas2.jpg' },
  leather: { label: '皮革', light: '#d5b58a', dark: '#8b5e3c', image: 'leather.jpg' },
  ic: { label: 'IC', light: '#f0f0f0', dark: '#a8a8a8', image: 'ncf-board.webp' },
  ocean: { label: '海洋', light: '#d7e6f0', dark: '#5b86b0' },
  greenPlastic: { label: '绿色塑料', light: '#d8e6c0', dark: '#6b9b45', image: 'green-plastic.webp' },
  marble: { label: '大理石', light: '#e8e4df', dark: '#aaa39a', image: 'marble.jpg' },
  gray: { label: '石墨灰', light: '#dcdcdc', dark: '#8f8f8f' },
  grey: { label: '灰色', light: '#dcdcdc', dark: '#8f8f8f', image: 'grey.jpg' },
  metal: { label: '金属', light: '#d7d9da', dark: '#8b9094', image: 'metal.jpg' },
  olive: { label: '橄榄绿', light: '#d8d8b8', dark: '#8b8b5a', image: 'olive.jpg' },
  newspaper: { label: '报纸', light: '#f4f0df', dark: '#c6bea4', image: 'newspaper.webp' },
  purple: { label: '紫罗兰', light: '#e4dbef', dark: '#8e74a8' },
  purpleDiag: { label: '紫色斜纹', light: '#e4dbef', dark: '#8e74a8', image: 'purple-diag.webp' },
  pinkPyramid: { label: '粉色金字塔', light: '#f2d7e4', dark: '#c783a4', image: 'pink-pyramid.webp' },
  horsey: { label: '马头', light: '#f0d9b5', dark: '#b58863', image: 'horsey.jpg' },
  coral: { label: '珊瑚', light: '#f3dcd2', dark: '#c0705c' },
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
  pirouetti: 'Pirouetti',
  kosal: 'Kosal',
  firi: 'Firi',
  governor: 'Governor',
  'kiwen-suwi': 'Kiwen-suwi',
};

const WEBP_PIECES: Record<string, true> = { pirouetti: true, kosal: true, firi: true, governor: true, 'kiwen-suwi': true };
const ROLE: Record<string, string> = { p: 'pawn', n: 'knight', b: 'bishop', r: 'rook', q: 'queen', k: 'king' };

export function pieceUrl(set: string, color: 'w' | 'b', role: string) {
  const safeSet = Object.hasOwn(PIECE_SETS, set) ? set : 'cburnett';
  return `pieces/${safeSet}/${color}${role.toUpperCase()}.${WEBP_PIECES[safeSet] ? 'webp' : 'svg'}`;
}

export function boardColors(theme: string, light: string, dark: string) {
  if (theme === 'custom') return { light, dark };
  return Object.hasOwn(BOARD_THEMES, theme) ? BOARD_THEMES[theme] : BOARD_THEMES.green;
}

export function boardImage(theme: string) {
  const image = BOARD_THEMES[theme]?.image;
  return image ? `url('boards/${image}')` : 'conic-gradient(var(--dark-sq) 0 25%, var(--light-sq) 0 50%, var(--dark-sq) 0 75%, var(--light-sq) 0)';
}

export function boardImageSize(theme: string) {
  return BOARD_THEMES[theme]?.image ? '100% 100%' : '25% 25%';
}

let styleEl: HTMLStyleElement | null = null;

export function applyAppearance(theme: string, light: string, dark: string, set: string) {
  const c = boardColors(theme, light, dark);
  const root = document.documentElement.style;
  root.setProperty('--light-sq', c.light);
  root.setProperty('--dark-sq', c.dark);
  root.setProperty('--board-image', boardImage(theme));
  root.setProperty('--board-image-size', boardImageSize(theme));
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

