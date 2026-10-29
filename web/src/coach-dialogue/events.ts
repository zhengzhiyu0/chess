import { Chess, type Move } from 'chess.js';
import { classify, whiteWinPct } from '../coach/coach';
import { confirmedMotifs, isSacrifice, pvMaterialSwing } from '../coach/explain';
import { toMove, type Color } from '../game/rules';
import type { SfResult } from '../engine/stockfish';
import type { Actor, CoachCategory, CoachEvent } from './dialogue';

export interface CoachMove {
  fen: string;
  uci: string;
  player: Color;
  ply: number;
  inBook: boolean;
  wasInBook: boolean;
  /** Only complete, unbounded engine results may authorize praise or tactical claims. */
  before?: SfResult;
  after?: SfResult;
  previousMove?: Move;
}

/** Facts first. Unknown analysis never turns into guessed "brilliant" or "best" praise. */
export function coachEvents(input: CoachMove): { events: CoachEvent[]; playerWin?: number; accuratePlayerMove: boolean } {
  const board = new Chess(input.fen);
  const forced = board.moves().length === 1;
  const move = board.move(toMove(input.uci));
  const actor: Actor = move.color === input.player ? 'player' : 'opponent';
  const events: CoachEvent[] = [];
  const add = (category: CoachCategory, priority: number) => events.push({ category, actor, piece: move.piece, priority });
  if (board.isCheckmate()) {
    add('mate', 120);
    return { events, accuratePlayerMove: false };
  }
  if (board.isGameOver()) return { events, accuratePlayerMove: false };
  if (move.promotion) add('promotion', 85);
  if (move.flags.includes('k') || move.flags.includes('q')) add('castling', 35);
  if (board.inCheck()) add(actor === 'opponent' ? 'check' : 'player_check', 40);
  if (actor === 'player' && input.ply <= 24) {
    if (input.inBook) add('opening_book_entry', 10);
  }

  const before = input.before?.lines[0];
  const after = input.after?.lines[0];
  const analysed = !!before && !!after && before.depth >= 10 && after.depth >= 10 && !before.bound && !after.bound;
  // Without analysis, skip exchanges that can be immediately recaptured; actual captures still have their own tier.
  const recapture = move.captured && board.moves({ verbose: true }).some(m => m.captured && m.to === move.to);
  const swing = analysed ? pvMaterialSwing(input.fen, [input.uci, ...after!.pv]) : recapture ? 0 : 1;
  if (move.captured && swing > 0) {
    if (actor === 'opponent') add(move.captured === 'q' ? 'capture_queen' : move.captured === 'r' ? 'capture_rook' : move.captured === 'p' ? 'capture_pawn' : 'capture_minor', move.captured === 'q' ? 100 : move.captured === 'r' ? 75 : move.captured === 'p' ? 20 : 60);
    else if (move.captured !== 'p') add(move.captured === 'q' ? 'player_loses_queen' : move.captured === 'r' ? 'player_loses_rook' : 'player_loses_minor', move.captured === 'q' ? 100 : move.captured === 'r' ? 75 : 60);
  }
  if (!analysed) return { events, accuratePlayerMove: false };
  const whiteBefore = whiteWinPct(before!, move.color);
  const moverBefore = move.color === 'w' ? whiteBefore : 100 - whiteBefore;
  const whiteAfter = whiteWinPct(after!, board.turn());
  const moverAfter = move.color === 'w' ? whiteAfter : 100 - whiteAfter;
  const drop = moverBefore - moverAfter;
  const best = input.before!.bestmove === input.uci;
  const second = input.before!.lines[1];
  const gap = second && !second.bound && second.depth >= 10
    ? moverBefore - (move.color === 'w' ? whiteWinPct(second, move.color) : 100 - whiteWinPct(second, move.color)) : 0;
  const sacrificed = isSacrifice(input.fen, input.uci);
  const judgement = classify({ before: moverBefore, after: moverAfter, playedBest: best, book: input.inBook, forced, sacrifice: sacrificed, secondGap: gap });
  const playerWin = input.player === 'w' ? whiteAfter : 100 - whiteAfter;
  const accuratePlayerMove = actor === 'player' && !forced && drop < 3;
  const moverMating = (after!.mate ?? 0) < 0;
  if (actor === 'player' && (after!.mate ?? 0) > 0 && (before!.mate ?? 0) >= 0) add('blunder_into_mate', 110);
  if (actor === 'player' && (before!.mate ?? 0) > 0 && !moverMating) add('missed_mate', 95);
  if (actor === 'player' && input.wasInBook && !input.inBook && input.ply <= 24 && drop < 5) add('opening_book_exit', 30);
  if (!forced && !input.inBook && drop < 3) {
    if (actor === 'player') {
      if (judgement === 'brilliant') add('player_brilliant', 98);
      else if (best && gap >= 20 && moverBefore < 60 && moverAfter >= 35) add('defense_found', 80);
      else if (best) add('player_best', 45);
      else add('player_accurate', 25);
    } else if (best && gap >= 20) add('lia_best_move', 50);
    const motifs = confirmedMotifs(input.fen, [input.uci, ...after!.pv], '对方的', moverMating);
    for (const motif of motifs) {
      if (motif.kind === 'fork') add('tactic_fork', 82);
      if (motif.kind === 'pin') add('tactic_pin', 81);
      if (motif.kind === 'discovered') add('tactic_discovered_attack', 83);
      if (motif.kind === 'mate-threat' && actor === 'opponent') add('key_threat', 88);
    }
    if (actor === 'player' && sacrificed) add('tactic_sacrifice', 86);
    // A checking intermezzo is confirmed only if the line later completes the available recapture.
    const recaptureSquare = input.previousMove?.captured ? input.previousMove.to : undefined;
    if (actor === 'player' && best && recaptureSquare && move.to !== recaptureSquare && board.inCheck()
      && new Chess(input.fen).moves({ verbose: true }).some(m => m.captured && m.to === recaptureSquare)
      && after!.pv.length >= 2) {
      const follow = new Chess(board.fen());
      try {
        follow.move(toMove(after!.pv[0]));
        const next = follow.move(toMove(after!.pv[1]));
        if (next.captured && next.to === recaptureSquare && swing > 0) add('tactic_zwischenzug', 84);
      } catch { /* incomplete PV cannot confirm an intermezzo */ }
    }
  }
  if (actor === 'player' && drop >= 5 && !forced) {
    if (move.piece === 'q' && input.ply <= 12) add('queen_early', 50);
    if (before!.pv[0] && input.before!.bestmove !== input.uci && confirmedMotifs(input.fen, before!.pv).some(m => ['fork', 'pin', 'skewer', 'discovered'].includes(m.kind))) add('player_missed_tactic', 65);
  }
  return { events, playerWin, accuratePlayerMove };
}
