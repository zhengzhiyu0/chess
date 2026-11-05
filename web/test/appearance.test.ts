import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { BOARD_THEMES, PIECE_SETS, pieceUrl } from '../src/app/appearance';
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
            if (['eyes', 'freak', 'prmi', 'livius', 'meridian', 'meridian-shaded', 'papercut'].includes(set)) {
              const root = svg.match(/<svg\b[^>]*>/)?.[0] ?? '';
              expect(root).toMatch(/viewBox="[\d. -]+"/);
              expect(root).not.toMatch(/(?:width|height)="[\d.]+pt"/);
            }
          }
        }
      }
    });
  }
});

describe('offline board textures', () => {
  for (const [theme, config] of Object.entries(BOARD_THEMES)) {
    it(`${theme} has valid colors and a local texture when configured`, () => {
      expect(config.light).toMatch(/^#[\da-f]{6}$/i);
      expect(config.dark).toMatch(/^#[\da-f]{6}$/i);
      if (!config.image) return;
      const bytes = readFileSync(new URL(`../public/boards/${config.image}`, import.meta.url));
      expect(bytes.length).toBeGreaterThan(100);
      if (config.image.startsWith('staunton-')) {
        expect(bytes.subarray(0, 4).toString()).toBe('RIFF');
        expect(bytes.subarray(8, 12).toString()).toBe('WEBP');
      }
      expect(sanitizeSettings({ boardTheme: theme }).boardTheme).toBe(theme);
    });
  }
});
