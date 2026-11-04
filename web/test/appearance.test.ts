import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { PIECE_SETS, pieceUrl } from '../src/app/appearance';
import { sanitizeSettings } from '../src/settings';

Object.assign(globalThis, { matchMedia: () => ({ matches: false }) });

describe('offline piece sets', () => {
  for (const set of Object.keys(PIECE_SETS)) {
    it(`${set} survives settings restore and has all twelve local pieces`, () => {
      expect(sanitizeSettings({ pieceSet: set }).pieceSet).toBe(set);
      const files = readdirSync(new URL(`../public/pieces/${set}/`, import.meta.url));
      for (const color of ['w', 'b'] as const) {
        for (const role of ['k', 'q', 'r', 'b', 'n', 'p']) {
          const url = pieceUrl(set, color, role);
          expect(files).toContain(url.split('/').at(-1));
          const bytes = readFileSync(new URL(`../public/${url}`, import.meta.url));
          expect(bytes.length).toBeGreaterThan(100);
          if (url.endsWith('.svg')) {
            const svg = bytes.toString('utf8');
            expect(svg).toContain('<svg');
            expect(svg).not.toMatch(/(?:xlink:)?href\s*=\s*["'](?:https?:|\/\/)/);
          }
        }
      }
    });
  }
});
