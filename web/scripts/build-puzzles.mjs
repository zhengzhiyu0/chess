// 从 Lichess 谜题库（CC0，https://database.lichess.org/#puzzles）抽取一个固定的小样本，
// 生成 test/fixtures/puzzles.json，供 test/puzzle-bench.test.ts 评测战术识别的准确率。
// 用法：node scripts/build-puzzles.mjs [下载MB数=8] [每个主题题数=150]
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Decompress } from 'fzstd';

const URL_ = 'https://database.lichess.org/lichess_db_puzzle.csv.zst';
const MB = Number(process.argv[2] ?? 8);
const PER_THEME = Number(process.argv[3] ?? 150);
const THEMES = [
  'fork', 'pin', 'skewer', 'discoveredAttack', 'doubleCheck', 'hangingPiece', 'trappedPiece',
  'capturingDefender', 'deflection', 'attraction', 'sacrifice', 'backRankMate', 'smotheredMate',
  'mateIn1', 'mateIn2', 'mateIn3', 'promotion', 'quietMove', 'xRayAttack', 'clearance', 'interference',
];
const RANDOM = 400;

const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'test', 'fixtures', 'puzzles.json');

const res = await fetch(URL_, { headers: { Range: `bytes=0-${MB * 1024 * 1024 - 1}` } });
if (!res.ok) throw new Error(`下载失败：${res.status}`);
const buf = new Uint8Array(await res.arrayBuffer());

const parts = [];
const d = new Decompress((c) => parts.push(c));
try {
  d.push(buf);
} catch {
  // 只下载了文件开头，末尾的数据块不完整，忽略即可
}
const text = Buffer.concat(parts).toString('utf8');
const rows = text.split('\n').slice(1, -1).map((l) => l.split(','));
console.log(`解压出 ${rows.length} 道题`);

// 固定种子，保证每次生成的样本一致
let seed = 42;
const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
const shuffled = rows.map((r) => [rand(), r]).sort((a, b) => a[0] - b[0]).map((x) => x[1]);

const picked = new Map();
const count = Object.fromEntries(THEMES.map((t) => [t, 0]));
let random = 0;
for (const r of shuffled) {
  const [id, fen, moves, rating, , , , themes] = r;
  const ts = themes.split(' ');
  let take = false;
  for (const t of ts) if (t in count && count[t] < PER_THEME) take = true;
  if (!take && random < RANDOM) {
    take = true;
    random++;
  }
  if (!take || picked.has(id)) continue;
  for (const t of ts) if (t in count) count[t]++;
  picked.set(id, [id, fen, moves, Number(rating), themes]);
}
console.log(count);

mkdirSync(dirname(out), { recursive: true });
const list = [...picked.values()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
writeFileSync(out, JSON.stringify({ source: 'Lichess puzzle database (CC0)', fields: ['id', 'fen', 'moves', 'rating', 'themes'], puzzles: list }).replace(/\],\[/g, '],\n['));
console.log(`写入 ${list.length} 道题 → ${out}`);
