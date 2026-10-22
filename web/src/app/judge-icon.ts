import { JUDGEMENT_INFO, type Judgement } from '../coach/coach';

const ICON_COLOR: Record<Judgement, string> = {
  best: '#5fae3e',
  good: '#8db86b',
  inaccuracy: '#f2b630',
  mistake: '#ec8a24',
  blunder: '#d93c34',
};

// Glyphs are drawn as paths (not <text>) so they render identically regardless of installed fonts.
const qmark = (x: number, s: number) =>
  `<g transform="translate(${x} -.5) scale(${s})"><path d="M-5.2-4.6a5.4 5.4 0 1 1 7.6 4.9c-1.7.8-2.4 1.9-2.4 3.6" fill="none" stroke="#fff" stroke-width="4.6" stroke-linecap="round" stroke-linejoin="round"/><circle cy="10" r="2.9" fill="#fff"/></g>`;
const emark = (x: number, s: number) =>
  `<g transform="translate(${x} -.5) scale(${s})"><path d="M0-10.5V3" stroke="#fff" stroke-width="5" stroke-linecap="round"/><circle cy="10" r="2.9" fill="#fff"/></g>`;

const GLYPH: Record<Judgement, string> = {
  best: '<path d="M0-11.5 3.4-4.4 11.2-3.5 5.5 1.9 7 9.6 0 5.8-7 9.6-5.5 1.9-11.2-3.5-3.4-4.4z" fill="#fff" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/>',
  good: '<path d="M-8 .5l5 5L8.5-6" fill="none" stroke="#fff" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/>',
  inaccuracy: qmark(-4.6, 0.86) + emark(6.4, 0.86),
  mistake: qmark(0, 1.05),
  blunder: qmark(-5.4, 0.84) + qmark(5.8, 0.84),
};

/** Badge centred on (0,0), radius ≈ 20 incl. drop shadow. */
function badge(j: Judgement): string {
  return (
    `<circle cy="1.6" r="18.5" fill="rgba(0,0,0,.35)"/><circle r="18.5" fill="${ICON_COLOR[j]}"/>` +
    '<path d="M-15.6-6.5A17 17 0 0 1 15.6-6.5 30 30 0 0 0-15.6-6.5z" fill="#fff" opacity=".18"/>' +
    `<circle r="17.6" fill="none" stroke="rgba(255,255,255,.55)" stroke-width="1.8"/>${GLYPH[j]}`
  );
}

/** Inline icon for HTML (move list, summary, notes). */
export function judgeIcon(j: Judgement, cls = 'jicon'): string {
  return `<svg class="${cls}" viewBox="-21 -21 42 44" aria-label="${JUDGEMENT_INFO[j].label}">${badge(j)}</svg>`;
}

/** chessground customSvg (100×100 = one square, origin at its top-left corner): badge on the top-right corner. */
export function judgeBoardSvg(j: Judgement): string {
  return `<g transform="translate(84 16) scale(0.8)"><g class="fx-badge fx-${j}">${badge(j)}</g></g>`;
}

export const judgeColor = (j: Judgement) => ICON_COLOR[j];

/** Under-piece glow for an attacked, under-defended piece (customSvg, drawn below pieces). */
export const HANGING_GLOW =
  '<defs><radialGradient id="jg-hang"><stop offset="0" stop-color="#ff5a4a" stop-opacity=".75"/><stop offset=".55" stop-color="#e8402f" stop-opacity=".4"/><stop offset="1" stop-color="#e8402f" stop-opacity="0"/></radialGradient></defs>' +
  '<rect class="fx-hang-glow" width="100" height="100" fill="url(#jg-hang)"/>';

/** Small warning badge on the bottom-left corner of a threatened piece. */
export const HANGING_BADGE =
  '<g transform="translate(16 84) scale(0.62)"><g class="fx-badge fx-hang"><circle cy="1.6" r="18.5" fill="rgba(0,0,0,.35)"/><circle r="18.5" fill="#e8402f"/><circle r="17.6" fill="none" stroke="rgba(255,255,255,.55)" stroke-width="1.8"/>' +
  `${emark(0, 1.05)}</g></g>`;
