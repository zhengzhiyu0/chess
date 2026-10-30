import type { DrawShape } from '@lichess-org/chessground/draw';
import type { Color, Key } from '@lichess-org/chessground/types';

type Point = readonly [number, number];
type HintKind = 'threat' | 'best';

/** Square-relative SVG coordinates; Chessground places (50, 50) at the origin square's center. */
export function coachArrowPoints(uci: string, knight: boolean, orientation: Color): Point[] {
  const df = uci.charCodeAt(2) - uci.charCodeAt(0);
  const dr = Number(uci[3]) - Number(uci[1]);
  const direction = orientation === 'white' ? 1 : -1;
  const end: Point = [50 + df * 100 * direction, 50 - dr * 100 * direction];
  const start: Point = [50, 50];
  if (knight && ((Math.abs(df) === 1 && Math.abs(dr) === 2) || (Math.abs(df) === 2 && Math.abs(dr) === 1))) {
    // Match the former move route: first reach the destination rank, then its file.
    return [start, [50, end[1]], end];
  }
  return [start, end];
}

function arrowSvg(points: Point[], color: string, opacity: number, className: string, outline: boolean, lineWidth: number): string {
  const end = points[points.length - 1];
  const previous = points[points.length - 2];
  const dx = end[0] - previous[0];
  const dy = end[1] - previous[1];
  const length = Math.hypot(dx, dy);
  const ux = dx / length;
  const uy = dy / length;
  const base: Point = [end[0] - ux * 27, end[1] - uy * 27];
  const shaft = points.slice(0, -1).map((p, i) => `${i ? 'L' : 'M'}${p[0]},${p[1]}`).join(' ') + ` L${base[0]},${base[1]}`;
  const shaftWidth = outline ? lineWidth * 0.85 : lineWidth;
  const headWidth = outline ? 15 : 16;
  const head = `M${end[0]},${end[1]} L${base[0] - uy * headWidth},${base[1] + ux * headWidth} L${base[0] + uy * headWidth},${base[1] - ux * headWidth} Z`;
  const outlineSvg = outline
    ? `<path d="${shaft}" fill="none" stroke="#000" stroke-width="${shaftWidth + 8}" stroke-linecap="round" stroke-linejoin="round"/><path d="${head}" fill="#000" stroke="#000" stroke-width="8" stroke-linejoin="round"/>`
    : '';
  return `<g class="${className}" fill="${color}" opacity="${outline ? 1 : opacity}">${outlineSvg}<path d="${shaft}" fill="none" stroke="${color}" stroke-width="${shaftWidth}" stroke-linecap="round" stroke-linejoin="round"/><path d="${head}"/></g>`;
}

function customArrow(uci: string, orientation: Color, color: string, opacity: number, className: string, outline: boolean, lineWidth: number, knight: boolean): DrawShape {
  return {
    orig: uci.slice(0, 2) as Key,
    customSvg: { html: arrowSvg(coachArrowPoints(uci, knight, orientation), color, opacity, className, outline, lineWidth) },
  };
}

/** Standard Chessground arrows rendered with the same optional black outline as coach arrows. */
export function outlinedArrow(uci: string, orientation: Color, color: string, opacity: number, brush: string, lineWidth: number): DrawShape {
  return customArrow(uci, orientation, color, opacity, `outlined-arrow outlined-arrow-${brush}`, true, lineWidth, false);
}

/** One static shaft and one head, with shared opacity so the join never darkens. */
export function coachArrow(uci: string, knight: boolean, orientation: Color, kind: HintKind, outline = false): DrawShape {
  const color = kind === 'threat' ? '#e8402f' : '#5fa83f';
  const opacity = kind === 'threat' ? 0.75 : 0.85;
  return customArrow(uci, orientation, color, opacity, `coach-arrow coach-arrow-${kind}`, outline, 10, knight);
}
