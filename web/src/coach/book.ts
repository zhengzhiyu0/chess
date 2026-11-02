export interface Opening {
  eco: string;
  name: string;
}

interface BookData {
  /** 所有命名开局局面（FEN 前四段）的 32 位 FNV-1a 哈希，升序、空格分隔的 base36。 */
  data: string;
  /** 与 data 等长的名称 id（base36）；空串表示该局面没有名称。 */
  ids: string;
  /** `ECO\t名称`，id 即数组下标。 */
  names: string[];
}

// 开局库：局面（FEN 前四段）是否出现在 Lichess 命名开局变化中，以及对应的 ECO / 名称。
// 数据见 scripts/build-book.mjs，按需加载（独立 chunk）。
let book: Set<number> | null = null;
let openings: Map<number, Opening> | null = null;
let loading: Promise<void> | null = null;

export function fnv(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

const epd = (fen: string) => fen.split(' ').slice(0, 4).join(' ');

/** Loads the book once (separate chunk); resolves when ready. */
export function loadBook(): Promise<void> {
  loading ??= import('./book-data').then((m) => {
    const raw = m.default as BookData;
    const hashes = raw.data.split(' ');
    const ids = raw.ids.split(' ');
    const names = raw.names.map((value) => {
      const tab = value.indexOf('\t');
      return { eco: value.slice(0, tab), name: value.slice(tab + 1) };
    });
    book = new Set(hashes.map((h) => parseInt(h, 36)));
    openings = new Map();
    for (let i = 0; i < hashes.length; i++) {
      const id = ids[i];
      if (!id) continue;
      openings.set(parseInt(hashes[i], 36), names[parseInt(id, 36)]);
    }
  });
  return loading;
}

export const bookReady = () => book !== null;

/** False until loaded. */
export function inBook(fen: string): boolean {
  return book?.has(fnv(epd(fen))) ?? false;
}

/** Returns the named opening for a position, or null before loading/no match. */
export function openingOf(fen: string): Opening | null {
  return openings?.get(fnv(epd(fen))) ?? null;
}

/** Returns the deepest named opening along a FEN path. */
export function identifyOpening(fens: readonly string[]): Opening | null {
  for (let i = fens.length - 1; i >= 0; i--) {
    const opening = openingOf(fens[i]);
    if (opening) return opening;
  }
  return null;
}
