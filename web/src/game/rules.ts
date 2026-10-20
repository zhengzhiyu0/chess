import { Chess } from 'chess.js';

export type Color = 'w' | 'b';

export const START_FEN = new Chess().fen();

export function toMove(uci: string) {
  return { from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] };
}

export function uciOf(m: { from: string; to: string; promotion?: string }) {
  return m.from + m.to + (m.promotion ?? '');
}

export function turnOf(fen: string): Color {
  return fen.split(' ')[1] === 'b' ? 'b' : 'w';
}

export function moveNumberOf(fen: string): number {
  return Number(fen.split(' ')[5]) || 1;
}

export function sanOf(fen: string, uci: string): string {
  try {
    return new Chess(fen).move(toMove(uci)).san;
  } catch {
    return uci;
  }
}

export function pvToSan(fen: string, pv: string[], max = 8): string {
  const c = new Chess(fen);
  const out: string[] = [];
  for (const u of pv.slice(0, max)) {
    try {
      const turn = c.turn();
      const num = moveNumberOf(c.fen());
      const san = c.move(toMove(u)).san;
      out.push(turn === 'w' ? `${num}. ${san}` : out.length === 0 ? `${num}… ${san}` : san);
    } catch {
      break;
    }
  }
  return out.join(' ');
}

/** Board, side to move, castling and en passant: what makes two positions "the same". */
export function positionKey(fen: string): string {
  return fen.split(' ').slice(0, 4).join(' ');
}

/** `new Chess(fen)` has no history, so repetitions are counted over the line's positions. */
export function isThreefold(fens: string[]): boolean {
  if (fens.length < 5) return false;
  const last = positionKey(fens[fens.length - 1]);
  let n = 0;
  for (const f of fens) if (positionKey(f) === last && ++n >= 3) return true;
  return false;
}

/** Whether `color` could still deliver mate (a flag fall against a side that can't is a draw). */
export function canMate(fen: string, color: Color): boolean {
  const own: string[] = [];
  let oppPieces = 0;
  for (const row of new Chess(fen).board())
    for (const sq of row) {
      if (!sq || sq.type === 'k') continue;
      if (sq.color === color) own.push(sq.type);
      else oppPieces++;
    }
  if (own.some((t) => t === 'p' || t === 'r' || t === 'q')) return true;
  // a lone minor piece can only mate with help from the opponent's own pieces
  return own.length > 1 || (own.length === 1 && oppPieces > 0);
}

export type EndReason = 'checkmate' | 'stalemate' | 'threefold' | 'insufficient' | 'fifty' | 'resign' | 'timeout' | 'agreement';

export const END_REASON_TEXT: Record<EndReason, string> = {
  checkmate: '将死',
  stalemate: '逼和',
  threefold: '三次重复',
  insufficient: '子力不足',
  fifty: '50 回合规则',
  resign: '认输',
  timeout: '超时',
  agreement: '协议和棋',
};

/** Result if the rules end the game at the last position of `fens` (the whole line, oldest first). */
export function terminalOf(fens: string[]): { result: string; reason: EndReason } | null {
  const c = new Chess(fens[fens.length - 1]);
  if (c.isCheckmate()) return { result: c.turn() === 'w' ? '0-1' : '1-0', reason: 'checkmate' };
  if (c.isStalemate()) return { result: '1/2-1/2', reason: 'stalemate' };
  if (c.isInsufficientMaterial()) return { result: '1/2-1/2', reason: 'insufficient' };
  if (isThreefold(fens)) return { result: '1/2-1/2', reason: 'threefold' };
  if (c.isDrawByFiftyMoves()) return { result: '1/2-1/2', reason: 'fifty' };
  return null;
}

/** Result when `flagged` runs out of time in `fen`. */
export function timeoutResult(fen: string, flagged: Color): string {
  const winner: Color = flagged === 'w' ? 'b' : 'w';
  if (!canMate(fen, winner)) return '1/2-1/2';
  return winner === 'w' ? '1-0' : '0-1';
}
