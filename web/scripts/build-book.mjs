// 从 Lichess 开局库（CC0，https://github.com/lichess-org/chess-openings）生成 src/coach/book-data.ts：
// 所有命名开局变化沿途出现过的局面（FEN 前四段）的 32 位 FNV-1a 哈希，用于判定“开局库着法”；
// 同时为每个局面记录命中的 ECO / 开局名称，供对局界面显示当前开局。
// 数据固定在 scripts/data/openings/manifest.json 记录的 commit，并按其中的 SHA-256 校验。
// 用法：node scripts/build-book.mjs [已下载的 a..e.tsv 所在目录]
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Chess } from 'chess.js';

const here = dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(readFileSync(join(here, 'data', 'openings', 'manifest.json'), 'utf8'));
const BASE = `https://raw.githubusercontent.com/lichess-org/chess-openings/${manifest.commit}/`;
const out = join(here, '..', 'src', 'coach', 'book-data.ts');
const sha256 = (text) => createHash('sha256').update(text, 'utf8').digest('hex');
const expected = new Map(manifest.files.map((f) => [f.file, f.sha256]));

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
const named = new Map();
let lines = 0;
for (const f of 'abcde') {
  const file = f + '.tsv';
  let text;
  if (local) text = readFileSync(join(local, file), 'utf8');
  else {
    const res = await fetch(BASE + file);
    if (!res.ok) throw new Error(`下载 ${file} 失败：${res.status}`);
    text = await res.text();
  }
  const want = expected.get(file);
  if (want && sha256(text) !== want) throw new Error(`${file} 与 manifest.json 的 SHA-256 不一致`);
  for (const row of text.split('\n').slice(1)) {
    const [eco, name, pgn] = row.split('\t');
    if (!pgn) continue;
    const moves = pgn.split(/\s+/).filter((tok) => tok && !/^\d+\.+$/.test(tok));
    const c = new Chess();
    moves.forEach((tok, i) => {
      c.move(tok);
      const ply = i + 1;
      const hash = fnv(epd(c.fen()));
      hashes.add(hash);
      // 每条 TSV 行的终点才是这个名称“定义”的局面；中途局面只是被更深的变化穿过。
      // 因此终点优先于途经，例如 1.e4 应取 “King's Pawn Game”（B00，线就是 1.e4），
      // 而不是把它当作 Tennison Gambit（A06，1.e4 d5 2.Nf3）的中途局面。
      // 同为终点时取较短的变化（更泛化的名称），再相同则保留文件顺序靠前的。
      const isEnd = ply === moves.length;
      const prev = named.get(hash);
      const better = !prev || (isEnd && !prev.isEnd) || (isEnd === prev.isEnd && ply < prev.ply);
      if (better) named.set(hash, { text: `${eco}\t${name}`, ply, isEnd });
    });
    lines++;
  }
}
// data 升序；ids 与 data 等长，指向 names 的下标（base36，空串表示该局面没有名称）。
// 这样只存一份哈希，避免在 named 里重复记录同样的 hash。
const sorted = [...hashes].sort((a, b) => a - b);
const data = sorted.map((h) => h.toString(36)).join(' ');
const names = [...new Set([...named.values()].map((entry) => entry.text))];
const nameIds = new Map(names.map((name, i) => [name, i]));
const ids = sorted
  .map((h) => {
    const entry = named.get(h);
    return entry === undefined ? '' : nameIds.get(entry.text).toString(36);
  })
  .join(' ');
const payload = JSON.stringify({ data, ids, names });
writeFileSync(
  out,
  '// 由 scripts/build-book.mjs 生成，勿手改。数据：Lichess chess-openings（CC0）。\n' + `export default ${payload};\n`,
);
console.log(
  `${lines} 条开局变化，${hashes.size} 个局面，${names.length} 个名称 → ${out}（${(payload.length / 1024).toFixed(0)} KB）`,
);
