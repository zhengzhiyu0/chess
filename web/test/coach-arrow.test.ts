import { describe, expect, it } from 'vitest';
import { coachArrow, coachArrowPoints, outlinedArrow } from '../src/app/coach-arrow';

const knightMoves = [
  ['d4e6', 100, -200],
  ['d4f5', 200, -100],
  ['d4f3', 200, 100],
  ['d4e2', 100, 200],
  ['d4c2', -100, 200],
  ['d4b3', -200, 100],
  ['d4b5', -200, -100],
  ['d4c6', -100, -200],
] as const;

describe('coach arrow geometry', () => {
  for (const [uci, dx, dy] of knightMoves) {
    it(`${uci} reaches the target rank before the target file`, () => {
      expect(coachArrowPoints(uci, true, 'white')).toEqual([
        [50, 50], [50, 50 + dy], [50 + dx, 50 + dy],
      ]);
    });

    it(`${uci} rotates both L segments when the board is flipped`, () => {
      expect(coachArrowPoints(uci, true, 'black')).toEqual([
        [50, 50], [50, 50 - dy], [50 - dx, 50 - dy],
      ]);
    });
  }

  it.each([
    ['a1h1', [750, 50]],
    ['a1a8', [50, -650]],
    ['a1h8', [750, -650]],
    ['h8a1', [-650, 750]],
    ['e2e4', [50, -150]],
    ['e7e8q', [50, -50]],
    ['e1g1', [250, 50]],
    ['d4e6', [150, -150]],
  ] as const)('%s stays a straight line for non-knights', (uci, end) => {
    expect(coachArrowPoints(uci, false, 'white')).toEqual([[50, 50], end]);
    expect(coachArrowPoints(uci, false, 'black')).toEqual([[50, 50], [100 - end[0], 100 - end[1]]]);
  });

  it('does not bend non-knight displacements even if the origin piece is a knight', () => {
    expect(coachArrowPoints('d4d6', true, 'white')).toEqual([[50, 50], [50, -150]]);
  });
});

describe('coach custom SVG', () => {
  it('draws a single L shaft and one arrowhead at the knight destination', () => {
    const shape = coachArrow('d4e6', true, 'white', 'threat');
    expect(shape.orig).toBe('d4');
    expect(shape.brush).toBeUndefined();
    expect(shape.dest).toBeUndefined();
    const html = shape.customSvg!.html;
    expect(html).toContain('class="coach-arrow coach-arrow-threat"');
    expect(html).toContain('fill="#e8402f" opacity="0.75"');
    expect(html).toContain('d="M50,50 L50,-150 L123,-150"');
    expect(html).toContain('d="M150,-150 L123,-134 L123,-166 Z"');
    expect(html.match(/<path /g)).toHaveLength(2);
    expect(html.match(/ Z"/g)).toHaveLength(1);
  });

  it('flips the terminal head together with the route, not the Chessground origin square', () => {
    const shape = coachArrow('d4e6', true, 'black', 'threat');
    expect(shape.orig).toBe('d4');
    expect(shape.customSvg!.html).toContain('d="M50,50 L50,250 L-23,250"');
    expect(shape.customSvg!.html).toContain('d="M-50,250 L-23,234 L-23,266 Z"');
  });

  it('keeps best hints green and static in square-relative units for resizing', () => {
    const html = coachArrow('e2e4', false, 'white', 'best').customSvg!.html;
    expect(html).toContain('class="coach-arrow coach-arrow-best"');
    expect(html).toContain('fill="#5fa83f" opacity="0.85"');
    expect(html).toContain('d="M50,50 L50,-123"');
    expect(html).not.toMatch(/<animate|<animateTransform|\bstyle=|\bmarker-/);
  });
});

describe('slim outlined arrows', () => {
  it.each([
    ['green', '#5fa83f', '#8ed438'],
    ['human', '#3b82d6', '#54afff'],
    ['threat', '#e8402f', '#ff5058'],
    ['should', '#d9a43a', '#ffd522'],
    ['demo', '#8a5cd6', '#b18aff'],
  ])('%s uses the same route and widths with its own color', (brush, color, ink) => {
    const html = outlinedArrow('e2e4', 'white', color, 0.5, brush, 10).customSvg!.html;
    expect(html).toContain('stroke="#15232c" stroke-width="12"');
    expect(html).toContain(`stroke="${ink}" stroke-width="4.5"`);
    expect(html).toContain('fill="none" opacity="1"');
    expect(html).toContain('d="M50,10 L50,-150 M62,-137 L50,-150 L38,-137"');
  });
  it('draws the yellow route to the target with an open chevron and rounded casing', () => {
    const html = outlinedArrow('h5e5', 'white', '#d9a43a', 0.75, 'should', 6).customSvg!.html;
    expect(html).toContain('fill="none" opacity="1"');
    expect(html).toContain('stroke-linecap="round" stroke-linejoin="round"');
    expect(html).toContain('d="M10,50 L-250,50 M-237,38 L-250,50 L-237,62"');
    expect(html).toContain('stroke="#15232c" stroke-width="12"');
    expect(html).toContain('stroke="#ffd522" stroke-width="4.5"');
    expect(html.match(/<path /g)).toHaveLength(2);
    expect(html).not.toContain(' Z');
  });

  it('keeps the red knight route bent, starts at the piece edge and ends at the square center', () => {
    const html = coachArrow('f6h5', true, 'white', 'threat', true).customSvg!.html;
    expect(html).toContain('d="M50,90 L50,150 L250,150 M237,162 L250,150 L237,138"');
    expect(html).toContain('stroke="#ff5058"');
  });

  it.each(knightMoves)('flips the complete outlined route for %s', (uci) => {
    const white = outlinedArrow(uci, 'white', '#3b82d6', 0.8, 'human', 5, true).customSvg!.html;
    const black = outlinedArrow(uci, 'black', '#3b82d6', 0.8, 'human', 5, true).customSvg!.html;
    const coords = (svg: string) => [...svg.matchAll(/[ML](-?[\d.]+),(-?[\d.]+)/g)].map(m => [Number(m[1]), Number(m[2])]);
    expect(coords(black)).toEqual(coords(white).map(([x, y]) => [100 - x, 100 - y]));
  });

  it('retains a visible shaft for a one-square move', () => {
    const html = outlinedArrow('e7e8q', 'white', '#5fa83f', 0.85, 'best', 7).customSvg!.html;
    expect(html).toContain('M50,10 L50,-50');
    expect(html).not.toMatch(/NaN|Infinity/);
  });
});
