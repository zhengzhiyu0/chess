// Offline human-game and opening-data helpers. Data provenance is pinned beside the files.
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Chess } from 'chess.js';

export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

/** Mulberry32: deterministic uint32 seed, no use of Math.random. */
export function seededRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), state | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export async function readPinned(manifestPath) {
  const manifestBytes = await readFile(manifestPath);
  const manifest = JSON.parse(manifestBytes.toString('utf8'));
  const bytes = await readFile(join(dirname(manifestPath), manifest.file));
  const actual = sha256(bytes);
  if (actual !== manifest.sha256) throw new Error(`数据哈希不符：${manifest.file}，预期 ${manifest.sha256}，实际 ${actual}`);
  return { manifest, manifestSha256: sha256(manifestBytes), bytes };
}

/** Validate every move of every full PGN before selecting any evaluation positions. */
export async function loadHumanGames(manifestPath) {
  const pinned = await readPinned(manifestPath);
  if (pinned.manifest.license !== 'CC0-1.0') throw new Error('人类棋谱必须带明确的 CC0-1.0 来源清单');
  const blocks = pinned.bytes.toString('utf8').trim().split(/\r?\n\s*\r?\n(?=\[Event )/);
  const sites = new Set();
  const games = blocks.map((pgn, gameIndex) => {
    const board = new Chess();
    // Accept legal over-disambiguated SAN (e.g. Rd1d2) in the original export.
    // chess.js still resolves every token against legal moves; source bytes stay pinned.
    board.loadPgn(pgn, { strict: false });
    const headers = board.getHeaders();
    const whiteElo = Number(headers.WhiteElo);
    const blackElo = Number(headers.BlackElo);
    if (!headers.Site?.startsWith('https://lichess.org/') || sites.has(headers.Site)) throw new Error(`棋谱来源缺失或重复：${gameIndex}`);
    if (!Number.isFinite(whiteElo) || whiteElo <= 0 || !Number.isFinite(blackElo) || blackElo <= 0) throw new Error(`棋谱等级缺失：${headers.Site}`);
    if (!/^Rated (Classical|Blitz) game$/.test(headers.Event ?? '') || headers.WhiteTitle === 'BOT' || headers.BlackTitle === 'BOT') throw new Error(`不接受该棋谱类别：${headers.Site}`);
    if (headers.SetUp || headers.FEN || (headers.Variant && headers.Variant !== 'Standard')) throw new Error(`只接受标准起始局面人类实战：${headers.Site}`);
    const expected = pinned.manifest.games[gameIndex];
    if (!expected || expected.site !== headers.Site || expected.whiteElo !== whiteElo || expected.blackElo !== blackElo) throw new Error(`棋谱与来源清单不匹配：${headers.Site}`);
    sites.add(headers.Site);
    const moves = board.history({ verbose: true });
    if (!moves.length) throw new Error(`空棋谱：${headers.Site}`);
    return { gameIndex, headers, whiteElo, blackElo, moves };
  });
  if (games.length !== pinned.manifest.games.length) throw new Error('棋谱数与固定清单不符');
  return { ...pinned, games };
}

/** Uniform seeded sampling without replacement over all recorded next-move positions. */
export function humanPositions(games, count, seed) {
  const positions = [];
  for (const game of games) {
    const board = new Chess();
    const fens = [board.fen()];
    for (let ply = 0; ply < game.moves.length; ply++) {
      const move = game.moves[ply];
      const white = board.turn() === 'w';
      positions.push({
        gameIndex: game.gameIndex, site: game.headers.Site, ply,
        fens: [...fens], humanUci: move.from + move.to + (move.promotion ?? ''),
        selfElo: white ? game.whiteElo : game.blackElo,
        oppoElo: white ? game.blackElo : game.whiteElo,
      });
      board.move({ from: move.from, to: move.to, promotion: move.promotion });
      fens.push(board.fen());
    }
  }
  const rng = seededRandom(seed);
  for (let i = positions.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [positions[i], positions[j]] = [positions[j], positions[i]];
  }
  return { available: positions.length, positions: positions.slice(0, count) };
}

const positionKey = (fen) => fen.split(' ').slice(0, 4).join(' ');

/** Exact named positions, not a move generator: never influences Maia's move selection. */
export async function loadOpeningFamilies(directory) {
  const manifestBytes = await readFile(join(directory, 'manifest.json'));
  const manifest = JSON.parse(manifestBytes.toString('utf8'));
  const byPosition = new Map();
  for (const file of manifest.files) {
    const bytes = await readFile(join(directory, file.file));
    if (sha256(bytes) !== file.sha256) throw new Error(`开局数据哈希不符：${file.file}`);
    if (!file.file.endsWith('.tsv')) continue;
    const [header, ...rows] = bytes.toString('utf8').trim().split(/\r?\n/);
    const fields = header.split('\t');
    for (const row of rows) {
      const values = row.split('\t');
      const name = values[fields.indexOf('name')];
      const eco = values[fields.indexOf('eco')];
      const pgn = values[fields.indexOf('pgn')];
      if (!name || !eco || !pgn) throw new Error(`开局条目不完整：${file.file}`);
      const board = new Chess();
      board.loadPgn(pgn, { strict: false });
      const key = positionKey(board.fen());
      // Files and rows have pinned order; preserve the first name on transpositions.
      if (!byPosition.has(key)) byPosition.set(key, { eco, name, family: name.split(':')[0] });
    }
  }
  return { manifest, manifestSha256: sha256(manifestBytes), byPosition };
}

export function identifyOpening(fens, book) {
  for (let i = fens.length - 1; i > 0; i--) {
    const entry = book.byPosition.get(positionKey(fens[i]));
    if (entry) return { ...entry, recognizedAtPly: i };
  }
  return null;
}

export function frequencies(values) {
  const counts = new Map();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([value, count]) => ({ value, count, frequency: count / values.length }));
}

export function entropyBits(frequencies) {
  return frequencies.reduce((sum, entry) => sum - entry.frequency * Math.log2(entry.frequency), 0);
}

export function summarizeRollouts(paths) {
  const pathFrequencies = frequencies(paths.map((path) => path.moves.join(' ')));
  const firstMoves = frequencies(paths.map((path) => path.moves[0]));
  return {
    count: paths.length,
    firstMoves,
    firstMoveEntropyBits: entropyBits(firstMoves),
    uniquePaths: pathFrequencies.length,
    duplicatePathRate: 1 - pathFrequencies.length / paths.length,
    pairCollisionRate: paths.length < 2 ? null : pathFrequencies.reduce((sum, entry) => sum + entry.count * (entry.count - 1), 0) / (paths.length * (paths.length - 1)),
    pathEntropyBits: entropyBits(pathFrequencies),
    uniqueFourPlyPrefixes: new Set(paths.map((path) => path.moves.slice(0, 4).join(' '))).size,
    openingFamilies: frequencies(paths.map((path) => path.opening?.family ?? '未识别')),
    recognizedOpeningRate: paths.filter((path) => path.opening !== null).length / paths.length,
    paths,
  };
}
