// 开局库判定：局面（FEN 前四段）是否出现在 Lichess 命名开局变化中。数据见 scripts/build-book.mjs。
let book: Set<number> | null = null;
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
    book = new Set(m.default.split(' ').map((s) => parseInt(s, 36)));
  });
  return loading;
}

export const bookReady = () => book !== null;

/** False until loaded. */
export function inBook(fen: string): boolean {
  return book?.has(fnv(epd(fen))) ?? false;
}
