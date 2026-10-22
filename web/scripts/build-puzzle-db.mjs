// Builds the bundled puzzle library public/puzzles/ from the Lichess puzzle database (CC0,
// https://database.lichess.org/#puzzles). Only the head of the ~300MB archive is streamed: it is
// enough to fill every rating band with well-played, well-rated puzzles.
// Usage: node scripts/build-puzzle-db.mjs [total=50000]
// Output: index.json + one file per 200-point rating band, lines "id,fen,moves,rating,themes".
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Decompress } from 'fzstd';

const URL_ = 'https://database.lichess.org/lichess_db_puzzle.csv.zst';
const TOTAL = Number(process.argv[2] ?? 50000);
const MAX_MB = Number(process.argv[3] ?? 45);
// themes the app can filter by (others are dropped to keep the files small)
const THEMES = new Set([
  'fork', 'pin', 'skewer', 'discoveredAttack', 'doubleCheck', 'hangingPiece', 'trappedPiece', 'capturingDefender',
  'deflection', 'attraction', 'sacrifice', 'backRankMate', 'smotheredMate', 'mateIn1', 'mateIn2', 'mateIn3', 'mate',
  'promotion', 'quietMove', 'xRayAttack', 'clearance', 'interference', 'intermezzo', 'defensiveMove', 'advantage',
  'crushing', 'endgame', 'opening', 'middlegame', 'short', 'long', 'oneMove',
]);
const BANDS = [];
for (let lo = 400; lo < 2800; lo += 200) BANDS.push({ lo, hi: lo + 199 });
BANDS[0].lo = 0;
BANDS[BANDS.length - 1].hi = 9999;
const PER_BAND = Math.ceil(TOTAL / BANDS.length);

const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'puzzles');
const bucket = BANDS.map(() => []);
const bandOf = (r) => BANDS.findIndex((b) => r >= b.lo && r <= b.hi);
const full = () => bucket.every((b) => b.length >= PER_BAND);

let rows = 0;
let rest = '';
function onLine(line) {
  const f = line.split(',');
  if (f.length < 8 || f[0] === 'PuzzleId') return;
  rows++;
  const [id, fen, moves, rating, rd, pop, plays, themes] = f;
  const r = Number(rating);
  // well-established rating, liked and played a lot
  if (Number(rd) > 100 || Number(pop) < 60 || Number(plays) < 100) return;
  const i = bandOf(r);
  if (i < 0 || bucket[i].length >= PER_BAND) return;
  const t = themes.split(' ').filter((x) => THEMES.has(x)).join(' ');
  bucket[i].push(`${id},${fen},${moves},${r},${t}`);
}

const ctrl = new AbortController();
const res = await fetch(URL_, { signal: ctrl.signal });
if (!res.ok || !res.body) throw new Error(`download failed: ${res.status}`);
const dec = new TextDecoder();
const d = new Decompress((chunk) => {
  const text = rest + dec.decode(chunk, { stream: true });
  const lines = text.split('\n');
  rest = lines.pop() ?? '';
  for (const l of lines) onLine(l);
});
let got = 0;
const reader = res.body.getReader();
while (!full() && got < MAX_MB * 1048576) {
  const { value, done } = await reader.read();
  if (done) break;
  got += value.byteLength;
  d.push(value);
  if (got % (4 * 1048576) < value.byteLength) console.log(`${(got / 1048576).toFixed(0)}MB, ${rows} rows, ${bucket.map((b) => b.length).join('/')}`);
}
ctrl.abort();

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
const themeCount = {};
const index = { source: 'Lichess puzzle database (CC0), https://database.lichess.org/#puzzles', built: new Date().toISOString().slice(0, 10), total: 0, bands: [], themes: themeCount };
BANDS.forEach((b, i) => {
  const lines = bucket[i].sort((x, y) => Number(x.split(',')[3]) - Number(y.split(',')[3]));
  if (!lines.length) return;
  const file = `b${String(b.lo).padStart(4, '0')}.csv`;
  writeFileSync(join(out, file), lines.join('\n') + '\n');
  for (const l of lines) for (const t of l.split(',')[4].split(' ')) if (t) themeCount[t] = (themeCount[t] ?? 0) + 1;
  index.bands.push({ lo: b.lo, hi: b.hi, file, count: lines.length });
  index.total += lines.length;
});
writeFileSync(join(out, 'index.json'), JSON.stringify(index));
console.log(`wrote ${index.total} puzzles in ${index.bands.length} bands from ${rows} rows (${(got / 1048576).toFixed(0)}MB downloaded)`);

