// Browser port of maia3/dataset.py + maia3/utils.py. Must stay bit-exact with the
// Python reference; test/maia.test.ts checks it against tools/make_golden.py output.
import type { Chess } from 'chess.js';

export const HISTORY = 8;
export const PLANES = 12;
export const FEAT = HISTORY * PLANES;
export const NUM_MOVES = 64 * 64 + 8 * 8 * 4;

const PIECES = 'pnbrqk';
const PROMOS = 'qrbn';
const FILES = 'abcdefgh';

export function squareIndex(sq: string): number {
  return (sq.charCodeAt(1) - 49) * 8 + (sq.charCodeAt(0) - 97);
}

export function squareName(i: number): string {
  return FILES[i % 8] + String(Math.floor(i / 8) + 1);
}

function mirrorSquare(sq: string): string {
  return sq[0] + String(9 - Number(sq[1]));
}

export function mirrorUci(uci: string): string {
  return mirrorSquare(uci.slice(0, 2)) + mirrorSquare(uci.slice(2, 4)) + uci.slice(4);
}

/** Index into the model's 4352-way move vocabulary. `uci` must be from the side-to-move POV. */
export function uciToIndex(uci: string): number {
  if (uci.length > 4) {
    const ff = uci.charCodeAt(0) - 97;
    const tf = uci.charCodeAt(2) - 97;
    return 4096 + ff * 32 + tf * 4 + PROMOS.indexOf(uci[4]);
  }
  return squareIndex(uci.slice(0, 2)) * 64 + squareIndex(uci.slice(2, 4));
}

export function indexToUci(idx: number): string {
  if (idx >= 4096) {
    const r = idx - 4096;
    return `${FILES[r >> 5]}7${FILES[(r >> 2) & 7]}8${PROMOS[r & 3]}`;
  }
  return squareName(idx >> 6) + squareName(idx & 63);
}

/** (64, 12) one-hot planes; board is mirrored (and colors swapped) when black is to move. */
export function tokenizeFen(fen: string): Float32Array {
  const out = new Float32Array(64 * PLANES);
  const [placement, turn] = fen.split(' ');
  const flip = turn === 'b';
  const rows = placement.split('/');
  for (let r = 0; r < 8; r++) {
    const rank = 7 - r;
    let file = 0;
    for (const ch of rows[r]) {
      if (ch >= '1' && ch <= '8') {
        file += Number(ch);
        continue;
      }
      const isWhite = ch !== ch.toLowerCase();
      const type = PIECES.indexOf(ch.toLowerCase());
      const sq = flip ? (7 - rank) * 8 + file : rank * 8 + file;
      const black = flip ? isWhite : !isWhite;
      out[sq * PLANES + type + (black ? 6 : 0)] = 1;
      file++;
    }
  }
  return out;
}

/** `fens`: every position of the game so far, oldest first, ending with the position to move in. */
export function buildTokens(fens: string[]): Float32Array {
  const recent = fens.slice(-HISTORY);
  const seq: string[] = Array<string>(HISTORY - recent.length).fill(recent[0]).concat(recent);
  const out = new Float32Array(64 * FEAT);
  seq.forEach((fen, j) => {
    const tok = tokenizeFen(fen);
    for (let s = 0; s < 64; s++) {
      for (let c = 0; c < PLANES; c++) {
        out[s * FEAT + j * PLANES + c] = tok[s * PLANES + c];
      }
    }
  });
  return out;
}

export interface LegalMove {
  uci: string;
  index: number;
}

export function legalMoveIndices(chess: Chess): LegalMove[] {
  const black = chess.turn() === 'b';
  return chess.moves({ verbose: true }).map((m) => {
    const uci = m.from + m.to + (m.promotion ?? '');
    return { uci, index: uciToIndex(black ? mirrorUci(uci) : uci) };
  });
}
