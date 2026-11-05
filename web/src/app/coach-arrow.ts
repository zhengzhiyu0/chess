import type { DrawShape } from '@lichess-org/chessground/draw';
import type { Color, Key } from '@lichess-org/chessground/types';

type Point = readonly [number, number];
type HintKind = 'threat' | 'best';

export const ARROW_COLORS = {
  green: '#5fa83f', blue: '#3b82d6', red: '#e8402f', yellow: '#d9a43a', purple: '#8a5cd6',
} as const;

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
  if (outline) return slimArrowSvg(points, color, className);
  const end = points[points.length - 1];
  const previous = points[points.length - 2];
  const dx = end[0] - previous[0];
  const dy = end[1] - previous[1];
  const length = Math.hypot(dx, dy);
  const ux = dx / length;
  const uy = dy / length;
  const base: Point = [end[0] - ux * 27, end[1] - uy * 27];
  const shaft = points.slice(0, -1).map((p, i) => `${i ? 'L' : 'M'}${p[0]},${p[1]}`).join(' ') + ` L${base[0]},${base[1]}`;
  const shaftWidth = lineWidth;
  const headWidth = 16;
  const head = `M${end[0]},${end[1]} L${base[0] - uy * headWidth},${base[1] + ux * headWidth} L${base[0] + uy * headWidth},${base[1] - ux * headWidth} Z`;
  return `<g class="${className}" fill="${color}" opacity="${opacity}"><path d="${shaft}" fill="none" stroke="${color}" stroke-width="${shaftWidth}" stroke-linecap="round" stroke-linejoin="round"/><path d="${head}"/></g>`;
}

/** Thin opaque route with an open chevron, rounded joins and a dark blue-black casing. */
function slimArrowSvg(points: Point[], color: string, className: string): string {
  const first = points[0];
  const next = points[1];
  const firstLength = Math.hypot(next[0] - first[0], next[1] - first[1]);
  // Start just beyond the piece, while retaining a visible segment for one-square moves.
  const inset = Math.min(40, firstLength * 0.4);
  const start: Point = [first[0] + (next[0] - first[0]) / firstLength * inset, first[1] + (next[1] - first[1]) / firstLength * inset];
  const end = points[points.length - 1];
  const previous = points[points.length - 2];
  const length = Math.hypot(end[0] - previous[0], end[1] - previous[1]);
  const ux = (end[0] - previous[0]) / length;
  const uy = (end[1] - previous[1]) / length;
  const base: Point = [end[0] - ux * 13, end[1] - uy * 13];
  const route = [start, ...points.slice(1)].map((p, i) => `${i ? 'L' : 'M'}${p[0]},${p[1]}`).join(' ');
  const chevron = `M${base[0] - uy * 12},${base[1] + ux * 12} L${end[0]},${end[1]} L${base[0] + uy * 12},${base[1] - ux * 12}`;
  const d = `${route} ${chevron}`;
  const ink = ({ '#e8402f': '#ff5058', '#d9a43a': '#ffd522', '#5fa83f': '#8ed438', '#3b82d6': '#54afff', '#8a5cd6': '#b18aff' } as Record<string, string>)[color.toLowerCase()] ?? color;
  return `<g class="${className} arrow-slim" fill="none" opacity="1" stroke-linecap="round" stroke-linejoin="round"><path d="${d}" stroke="#15232c" stroke-width="12"/><path d="${d}" stroke="${ink}" stroke-width="4.5"/></g>`;
}

function customArrow(uci: string, orientation: Color, color: string, opacity: number, className: string, outline: boolean, lineWidth: number, knight: boolean): DrawShape {
  return {
    orig: uci.slice(0, 2) as Key,
    customSvg: { html: arrowSvg(coachArrowPoints(uci, knight, orientation), color, opacity, className, outline, lineWidth) },
  };
}

/** All outlined hints share the slim route, including L-shaped knight moves. */
export function outlinedArrow(uci: string, orientation: Color, color: string, opacity: number, brush: string, lineWidth: number, knight = false): DrawShape {
  return customArrow(uci, orientation, color, opacity, `outlined-arrow outlined-arrow-${brush}`, true, lineWidth, knight);
}

/** One static shaft and one head, with shared opacity so the join never darkens. */
export function coachArrow(uci: string, knight: boolean, orientation: Color, kind: HintKind, outline = false): DrawShape {
  const color = kind === 'threat' ? '#e8402f' : '#5fa83f';
  const opacity = kind === 'threat' ? 0.75 : 0.85;
  return customArrow(uci, orientation, color, opacity, `coach-arrow coach-arrow-${kind}`, outline, 10, knight);
}
