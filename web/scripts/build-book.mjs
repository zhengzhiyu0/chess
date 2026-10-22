// 从 Lichess 开局库（CC0，https://github.com/lichess-org/chess-openings）生成 src/coach/book-data.ts：
// 所有命名开局变化沿途出现过的局面（FEN 前四段）的 32 位 FNV-1a 哈希，用于判定“开局库着法”。
// 用法：node scripts/build-book.mjs [已下载的 a..e.tsv 所在目录]
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Chess } from 'chess.js';

const BASE = 'https://raw.githubusercontent.com/lichess-org/chess-openings/master/';
const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'coach', 'book-data.ts');

export function fnv(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

const epd = (fen) => fen.split(' ').slice(0, 4).join(' ');
const local = process.argv[2];
const hashes = new Set();
let lines = 0;
for (const f of 'abcde') {
  let text;
  if (local) text = readFileSync(join(local, f + '.tsv'), 'utf8');
  else {
    const res = await fetch(BASE + f + '.tsv');
    if (!res.ok) throw new Error(`下载 ${f}.tsv 失败：${res.status}`);
    text = await res.text();
  }
  for (const row of text.split('\n').slice(1)) {
    const pgn = row.split('\t')[2];
    if (!pgn) continue;
    const c = new Chess();
    for (const tok of pgn.split(/\s+/)) {
      if (!tok || /^\d+\.+$/.test(tok)) continue;
      c.move(tok);
      hashes.add(fnv(epd(c.fen())));
    }
    lines++;
  }
}
const data = [...hashes].sort((a, b) => a - b).map((h) => h.toString(36)).join(' ');
writeFileSync(
  out,
  '// 由 scripts/build-book.mjs 生成，勿手改。数据：Lichess chess-openings（CC0）。\n' +
    `export default ${JSON.stringify(data)};\n`,
);
console.log(`${lines} 条开局变化，${hashes.size} 个局面 → ${out}（${(data.length / 1024).toFixed(0)} KB）`);
