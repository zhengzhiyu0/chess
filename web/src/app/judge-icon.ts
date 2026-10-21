import { JUDGEMENT_INFO, type Judgement } from '../coach/coach';

const ICON_COLOR: Record<Judgement, string> = {
  best: '#81b64c',
  good: '#95b776',
  inaccuracy: '#f7c045',
  mistake: '#e58f2a',
  blunder: '#ca3431',
};

/** Badge centred on (0,0) with radius 20. */
function badge(j: Judgement): string {
  let glyph: string;
  if (j === 'best')
    glyph = '<path d="M0-12 3.5-4.3 12-3.7 5.6 2 7.4 10.3 0 6-7.4 10.3-5.6 2-12-3.7-3.5-4.3z" fill="#fff"/>';
  else if (j === 'good')
    glyph = '<path d="M-8.5 0.5l5.5 5.5 11.5-12" fill="none" stroke="#fff" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/>';
  else {
    const sym = JUDGEMENT_INFO[j].symbol;
    glyph = `<text y="1.5" text-anchor="middle" dominant-baseline="central" font-family="Arial,Helvetica,sans-serif" font-weight="900" font-size="${sym.length > 1 ? 19 : 25}" letter-spacing="-1" fill="#fff">${sym}</text>`;
  }
  return `<circle cy="1.5" r="19" fill="rgba(0,0,0,.3)"/><circle r="19" fill="${ICON_COLOR[j]}" stroke="#fff" stroke-width="2"/>${glyph}`;
}

/** Inline icon for HTML (move list, summary, notes). */
export function judgeIcon(j: Judgement, cls = 'jicon'): string {
  return `<svg class="${cls}" viewBox="-21 -21 42 44" aria-label="${JUDGEMENT_INFO[j].label}">${badge(j)}</svg>`;
}

/** chessground customSvg (100×100 = one square, origin at its top-left corner): badge on the top-right corner. */
export function judgeBoardSvg(j: Judgement): string {
  return `<g transform="translate(84 16) scale(0.8)">${badge(j)}</g>`;
}

export const judgeColor = (j: Judgement) => ICON_COLOR[j];

/** Under-piece glow for an attacked, under-defended piece (customSvg, drawn below pieces). */
export const HANGING_GLOW =
  '<defs><radialGradient id="jg-hang"><stop offset="0" stop-color="#ff5a4a" stop-opacity=".75"/><stop offset=".55" stop-color="#e8402f" stop-opacity=".4"/><stop offset="1" stop-color="#e8402f" stop-opacity="0"/></radialGradient></defs>' +
  '<rect width="100" height="100" fill="url(#jg-hang)"/>';

/** Small warning badge on the bottom-left corner of a threatened piece. */
export const HANGING_BADGE =
  '<g transform="translate(16 84) scale(0.62)"><circle cy="1.5" r="19" fill="rgba(0,0,0,.3)"/><circle r="19" fill="#e8402f" stroke="#fff" stroke-width="2"/>' +
  '<path d="M0-10v11" stroke="#fff" stroke-width="5" stroke-linecap="round"/><circle cy="9" r="3" fill="#fff"/></g>';
