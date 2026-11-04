import 'dart:convert';
import 'dart:io';

import 'package:chess/chess.dart' as chess;
import 'package:flutter_test/flutter_test.dart';
import 'package:maia_coach/core/chess.dart';
import 'package:maia_coach/core/tactics.dart';

List<String> _kinds(String fen, String uci) =>
    detectMotifs(fen, uci).map((m) => m.kind).toList();

void main() {
  group('full coach.ts move classification', () {
    test('all ten classes, thresholds and priority match the TS examples', () {
      expect(classifyMove(before: 50, after: 50, playedBest: true), 'best');
      expect(classifyMove(before: 60, after: 56, playedBest: false), 'good');
      expect(
        classifyMove(before: 60, after: 55, playedBest: false),
        'inaccuracy',
      );
      expect(classifyMove(before: 60, after: 50, playedBest: false), 'mistake');
      expect(classifyMove(before: 60, after: 45, playedBest: false), 'blunder');
      expect(
        classifyMove(before: 80, after: 20, playedBest: false, book: true),
        'book',
      );
      expect(
        classifyMove(
          before: 80,
          after: 20,
          playedBest: false,
          book: true,
          forced: true,
        ),
        'forced',
      );
      expect(
        classifyMove(before: 55, after: 56, playedBest: true, sacrifice: true),
        'brilliant',
      );
      expect(
        classifyMove(before: 55, after: 48, playedBest: false, sacrifice: true),
        'inaccuracy',
      );
      expect(
        classifyMove(before: 99, after: 99, playedBest: true, sacrifice: true),
        'best',
      );
      expect(
        classifyMove(before: 50, after: 55, playedBest: true, secondGap: 25),
        'great',
      );
      expect(
        classifyMove(before: 75, after: 75, playedBest: true, oppDrop: 12),
        'great',
      );
      expect(
        classifyMove(before: 75, after: 75, playedBest: true, oppDrop: 8),
        'best',
      );
      expect(
        classifyMove(before: 75, after: 63, playedBest: false, oppDrop: 12),
        'miss',
      );
      expect(
        classifyMove(before: 75, after: 55, playedBest: false, oppDrop: 12),
        'blunder',
      );
      expect(
        classifyMove(before: 55, after: 40, playedBest: true, secondGap: 20),
        'great',
      );
      expect(
        classifyMove(before: 55, after: 39.9, playedBest: true, secondGap: 20),
        'best',
      );
    });

    test('sound sacrifice needs both actual material exposure and engine evidence', () {
      const fen =
          'rnbq1rk1/pppn1ppp/4p3/3pP3/1b1P4/2NB1N2/PPP2PPP/R1BQK2R w KQ - 0 7';
      expect(soundSacrifice(fen, 'd3h7', before: 55, after: 56), isTrue);
      expect(soundSacrifice(fen, 'd3h7', before: 55, after: 48), isFalse);
      expect(soundSacrifice(fen, 'd3h7', before: 99, after: 99), isFalse);
      expect(soundSacrifice(fen, 'd3h7', before: 55, after: 52), isFalse);
      expect(
        soundSacrifice(fen, 'd3h7', before: double.nan, after: 50),
        isFalse,
      );
      expect(soundSacrifice(startFen, 'e2e4', before: 50, after: 50), isFalse);
      expect(
        soundSacrifice(
          '3qk3/8/8/8/8/8/8/3RK3 w - - 0 1',
          'd1d8',
          before: 55,
          after: 56,
        ),
        isFalse,
      );
      expect(hangingMaterial('4k3/8/8/3n4/8/8/8/3RK3 b - - 0 1', 'b'), {
        'd5': 3,
      });
      expect(
        hangingMaterial('4k3/8/2p5/3p4/8/8/8/3RK3 w - - 0 1', 'b'),
        isEmpty,
      );
    });
  });

  group('web explain.ts motif examples', () {
    test('knight forks king and rook, with exact Chinese text and targets', () {
      final motifs = detectMotifs('r3k3/8/8/1N6/8/8/8/4K3 w - - 0 1', 'b5c7');
      final fork = motifs.firstWhere((m) => m.kind == 'fork');
      expect(fork.text, '马捉双：同时攻击对方的王和车');
      expect(fork.targets, ['a8']);
      expect(fork.immediate, isFalse);
      expect(motifs.last.kind, 'check');
    });

    test('absolute pin and king-rook skewer', () {
      final pin = detectMotifs(
        '4k3/8/2n5/8/8/8/8/4KB2 w - - 0 1',
        'f1b5',
      ).first;
      expect(pin.kind, 'pin');
      expect(pin.text, '牵制对方的马：它身后是王，不能走开');
      expect(pin.targets, ['c6']);
      final skewer = detectMotifs(
        'r3k3/8/8/8/8/8/8/4K2R w - - 0 1',
        'h1h8',
      ).firstWhere((m) => m.kind == 'skewer');
      expect(skewer.targets, ['a8']);
      expect(skewer.text, contains('王被迫躲开'));
    });

    test('discovered attack, free capture, trade up and immediate mate', () {
      expect(
        _kinds('3qk3/8/8/8/8/8/3N4/3RK3 w - - 0 1', 'd2f3'),
        contains('discovered'),
      );
      expect(
        _kinds('4k3/8/8/3n4/8/8/8/3RK3 w - - 0 1', 'd1d5'),
        contains('free'),
      );
      expect(
        _kinds('4k3/8/8/3q4/4P3/8/8/4K3 w - - 0 1', 'e4d5'),
        contains('trade-up'),
      );
      expect(_kinds('6k1/5ppp/8/8/8/8/8/R5K1 w - - 0 1', 'a1a8').first, 'mate');
    });

    test('defended knight is not free; absolutely pinned defender cannot recapture', () {
      expect(
        _kinds('4k3/8/4p3/3n4/8/8/8/3RK3 w - - 0 1', 'd1d5'),
        isNot(contains('free')),
      );
      const fen = '4k3/8/2n5/4p3/B7/8/8/4R2K w - - 0 1';
      final pin = detectMotifs(fen, 'e1e5').firstWhere((m) => m.kind == 'pin');
      expect(pin.text, contains('不能回吃'));
      expect(pin.immediate, isTrue);
      expect(hangingPieces(fen.replaceFirst(' w ', ' b '), 'b'), ['c6', 'e5']);
    });

    test('attacking a pawn is not a fork', () {
      expect(
        _kinds('b3k3/1p6/8/8/2N5/8/8/4K3 w - - 0 1', 'c4d6'),
        isNot(contains('fork')),
      );
    });

    test('discovered check prevents recapture without inventing a pin', () {
      final motifs = detectMotifs(
        '4k3/8/2p5/3n4/4B3/8/8/4R2K w - - 0 1',
        'e4d5',
      );
      expect(motifs.map((m) => m.kind), isNot(contains('pin')));
      expect(
        motifs.firstWhere((m) => m.kind == 'discovered').text,
        contains('正被将军，无法回吃'),
      );
    });

    test('double check requires two actual checkers', () {
      const fen = '4k3/8/8/8/4N3/8/8/4R2K w - - 0 1';
      expect(_kinds(fen, 'e4f6'), contains('double-check'));
      expect(_kinds(fen, 'e4c5'), isNot(contains('double-check')));
    });

    test('removes defender, traps bishop and threatens Scholar mate', () {
      expect(
        _kinds('6k1/8/3b4/4n3/8/8/3R4/4R2K w - - 0 1', 'd2d6'),
        contains('remove-defender'),
      );
      expect(
        _kinds('4k3/8/1p6/b7/8/2P5/1P6/4K3 w - - 0 1', 'b2b4'),
        contains('trapped'),
      );
      final threat = detectMotifs(
        'r1bqkbnr/pppp1ppp/2n5/4p3/2B1P3/8/PPPP1PPP/RNBQK1NR w KQkq - 2 3',
        'd1h5',
      ).firstWhere((m) => m.kind == 'mate-threat');
      expect(threat.text, '威胁下一步 Qxf7# 将杀');
      expect(threat.text, isNot(contains('<b>')));
    });

    test('promotions identify the chosen piece including underpromotion', () {
      const fen = '8/P7/8/8/8/8/8/k6K w - - 0 1';
      expect(
        detectMotifs(fen, 'a7a8q').firstWhere((m) => m.kind == 'promote').text,
        '兵升变成后',
      );
      expect(
        detectMotifs(fen, 'a7a8n').firstWhere((m) => m.kind == 'promote').text,
        '兵升变成马',
      );
      expect(detectMotifs(fen, 'a7a8'), isEmpty);
    });
  });

  group('legal SEE and geometric false positives', () {
    test('free, defended, pinned and king recaptures use legal moves', () {
      expect(staticExchange('4k3/8/8/3n4/8/8/8/3RK3 w - - 0 1', 'd1d5'), 3);
      expect(staticExchange('4k3/8/4p3/3n4/8/8/8/3RK3 w - - 0 1', 'd1d5'), -2);
      expect(staticExchange('4k3/8/2p5/3p4/8/8/8/3QK3 w - - 0 1', 'd1d5'), -8);
      expect(staticExchange('4k3/8/2n5/4p3/B7/8/8/4R2K w - - 0 1', 'e1e5'), 1);
      expect(staticExchange('4k3/3p4/8/8/8/8/8/3RK3 w - - 0 1', 'd1d7'), -4);
      expect(staticExchange('4k3/3p4/8/8/6B1/8/8/3RK3 w - - 0 1', 'd1d7'), 1);
    });

    test('pinned attackers and checked-side captures cannot win material', () {
      const pin = '4k3/8/4n3/2P5/8/8/8/4R2K w - - 0 1';
      expect(seeFor(pin, 'c5', 'b'), isNull);
      expect(seeWith(pin, 'e6', 'c5', 'b'), isNull);
      expect(hangingPieces(pin, 'w'), isNot(contains('c5')));
      expect(threatMoves(pin, 'b'), isNot(contains('e6c5')));
      expect(
        seeWith('4k3/8/8/3n4/8/8/3P4/4R2K b - - 0 1', 'd5', 'd2', 'b'),
        isNull,
      );
    });

    test(
      'en passant accounts for removed pawn, x-rays and illegal exposed king',
      () {
        expect(staticExchange('4k3/8/8/3pP3/8/8/8/4K3 w - d6 0 1', 'e5d6'), 1);
        expect(staticExchange('3rk3/8/8/3pP3/8/8/8/4K3 w - d6 0 1', 'e5d6'), 0);
        expect(
          staticExchange('4r1k1/8/8/3pP3/8/8/8/4K3 w - d6 0 1', 'e5d6'),
          isNull,
        );
        expect(
          threatMoves('4k3/8/8/3pP3/8/8/8/4K3 w - d6 0 1', 'w'),
          contains('e5d6'),
        );
        expect(hangingMaterial('4k3/8/8/3pP3/8/8/8/4K3 w - d6 0 1', 'b'), {
          'd5': 1,
        });
        expect(seeFor('4k3/8/8/3pP3/8/8/8/4K3 w - d6 0 1', 'd5', 'w'), 1);
        expect(
          hangingPieces('3rk3/8/8/3pP3/8/8/8/4K3 w - d6 0 1', 'b'),
          isNot(contains('d5')),
        );
        expect(
          seeFor('4r1k1/8/8/3pP3/8/8/8/4K3 w - d6 0 1', 'd5', 'w'),
          isNull,
        );
      },
    );

    test(
      'promotion gains and recaptured promotions use actual chosen value',
      () {
        const safe = '8/P7/8/8/8/8/8/k6K w - - 0 1';
        expect(staticExchange(safe, 'a7a8q'), 8);
        expect(staticExchange(safe, 'a7a8n'), 2);
        const captured = '1r5k/P7/8/8/8/8/8/7K w - - 0 1';
        expect(staticExchange(captured, 'a7b8q'), 13);
        const recaptured = '1r5k/P1b5/8/8/8/8/8/7K w - - 0 1';
        expect(staticExchange(recaptured, 'a7b8q'), 4);
        expect(staticExchange(recaptured, 'a7b8n'), 4);
      },
    );

    test('fork that can be captured and illusory pins/skewers are rejected', () {
      expect(
        _kinds('r2bk3/8/8/1N6/8/8/8/4K3 w - - 0 1', 'b5c7'),
        isNot(contains('fork')),
      );
      // Nc6 can capture Bb5 without uncovering its king: d7 blocks that diagonal.
      expect(
        _kinds('4k3/3p4/2n5/8/8/8/8/4KB2 w - - 0 1', 'f1b5'),
        isNot(contains('pin')),
      );
      // Queen can simply capture the rook instead of moving off a skewer line.
      expect(
        _kinds('r3q2k/8/8/8/8/8/8/4K2R w - - 0 1', 'h1h8'),
        isNot(contains('skewer')),
      );
      // The apparent pinner is itself absolutely pinned to the white king.
      expect(
        _kinds('4r2k/8/8/4R1nq/8/8/8/4K3 w - - 0 1', 'e5e4'),
        isNot(contains('pin')),
      );
    });

    test('hanging and threat APIs exclude equal exchanges and give color-by semantics', () {
      const hanging = '4k3/8/8/3n4/8/8/8/3RK3 b - - 0 1';
      expect(hangingPieces(hanging, 'b'), ['d5']);
      expect(threatMoves(hanging, 'w'), contains('d1d5'));
      expect(threatMoves(hanging, 'b'), isNot(contains('d1d5')));
      const defended = '4k3/8/2p5/3p4/8/8/8/3RK3 w - - 0 1';
      expect(threatMoves(defended, 'w'), isNot(contains('d1d5')));
      expect(
        threatMoves('6k1/5ppp/8/8/8/8/8/R5K1 w - - 0 1', 'w').first,
        'a1a8',
      );
      expect(threatMoves('7k/8/8/8/8/8/8/K7 w - - 0 1', 'w'), isEmpty);
    });

    test('invalid inputs are safe and no input board or FEN is mutated', () {
      expect(detectMotifs(startFen, 'e2e5'), isEmpty);
      expect(detectMotifs('broken', 'e2e4'), isEmpty);
      expect(hangingPieces('broken', 'w'), isEmpty);
      expect(staticExchange(startFen, 'a7a8q'), isNull);
      expect(seeFor(startFen, 'z9', 'b'), isNull);
      expect(seeWith(startFen, 'e2', 'e4', 'w'), isNull);
      final board = position(startFen);
      final fen = board.fen;
      detectMotifs(fen, 'e2e4');
      threatMoves(fen, 'b');
      hangingPieces(fen, 'w');
      expect(board.fen, fen);
      expect(board.history, isEmpty);
    });

    test('Greek gift is a sacrifice, a developing move or winning trade is not', () {
      expect(
        isSacrifice(
          'rnbq1rk1/pppn1ppp/4p3/3pP3/1b1P4/2NB1N2/PPP2PPP/R1BQK2R w KQ - 0 7',
          'd3h7',
        ),
        isTrue,
      );
      expect(
        isSacrifice(
          'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1',
          'g8f6',
        ),
        isFalse,
      );
      expect(isSacrifice('3qk3/8/8/8/8/8/8/3RK3 w - - 0 1', 'd1d8'), isFalse);
    });
  });

  group('PV confirmation, same fixtures as web explain.test.ts', () {
    test('pin needs the line to win the tracked target', () {
      const fen = '4k3/8/2n5/8/8/8/8/4KB2 w - - 0 1';
      expect(
        confirmedMotifs(fen, ['f1b5', 'e8d7', 'b5c6']).map((m) => m.kind),
        contains('pin'),
      );
      expect(confirmedMotifs(fen, ['f1b5', 'e8d7']), isEmpty);
      expect(confirmedMotifs(fen, ['f1b5']), isEmpty);
      expect(
        confirmedMotifs('4k3/8/8/3n4/8/8/8/3RK3 w - - 0 1', [
          'd1d5',
        ]).map((m) => m.kind),
        contains('free'),
      );
    });

    test('material includes recaptures beyond ply limit', () {
      expect(pvMaterialSwing('4k3/8/8/3n4/8/8/8/3RK3 w - - 0 1', ['d1d5']), 3);
      expect(
        pvMaterialSwing('4k3/8/2p5/3p4/8/8/8/3QK3 w - - 0 1', ['d1d5', 'c6d5']),
        -8,
      );
      expect(
        pvMaterialSwing('3qk3/8/8/8/3R4/2P5/8/4K3 w - - 0 1', [
          'e1f1',
          'e8f8',
          'f1e1',
          'f8e8',
          'e1f1',
          'e8f8',
          'f1e1',
          'd8d4',
          'c3d4',
        ]),
        4,
      );
      expect(materialWords(5), '大约一个车');
    });

    test('bad move permits a knight fork and loses rook', () {
      final result = explainMistake(
        '4k3/8/8/8/3n4/8/7P/R3K3 w - - 0 1',
        'h2h3',
        'e1d2',
        pv: ['d4c2', 'e1d2', 'c2a1'],
        replyCp: 400,
      );
      expect(result.tag, 'allow-fork');
      expect(result.tagLabel, '被对方捉双');
      expect(result.problem.first, contains('你的王和车'));
      expect(result.text, contains('会丢掉大约一个车'));
    });

    test('unrealized fork is not used as the explanation', () {
      final result = explainMistake(
        '4k3/8/8/8/3n4/8/7P/R3K3 w - - 0 1',
        'h2h3',
        'e1d2',
        pv: ['d4c2', 'e1d2'],
        replyCp: 0,
      );
      expect(result.problem.first, isNot(contains('捉双')));
      expect(result.problem.first, contains('Nc2+'));
      expect(result.tag, isNot('allow-fork'));
    });

    test(
      'even recapture is an exchange rather than free material or hanging',
      () {
        final result = explainMistake(
          'rnbqkb1r/pppp1ppp/5n2/4p1B1/4P3/8/PPPP1PPP/RN1QKBNR w KQkq - 0 3',
          'g5f6',
          'g1f3',
          pv: ['d8f6', 'g1f3', 'b8c6'],
          replyCp: 30,
        );
        expect(result.problem, ['对手的最佳应对是 Qxf6']);
        expect(result.tag, isNot('hanging'));
        expect(result.text, isNot(contains('白吃')));
      },
    );

    test('losing queen capture accounts for the pawn already taken', () {
      final result = explainMistake(
        '4k3/8/2p5/3p4/8/8/8/3QK3 w - - 0 1',
        'd1d5',
        'e1e2',
        pv: ['c6d5'],
        replyCp: 800,
      );
      expect(result.problem.join(), contains('会丢掉大约一个车'));
      expect(result.tag, 'hanging');
    });

    test(
      'missing engine lines are explicit and evaluations use the correct POV',
      () {
        const fen = '4k3/7p/8/8/8/8/8/R3K3 w - - 0 1';
        final missing = explainMistake(fen, 'a1a2', 'a1a4');
        expect(missing.problem.join(), contains('无法可靠确认'));
        expect(missing.better.join(), contains('没有足够的主变数据'));
        final evaluated = explainMistake(
          fen,
          'a1a2',
          'a1a4',
          pv: ['h7h6'],
          bestPv: ['a1a4'],
          replyCp: 220,
          bestCp: 180,
        );
        expect(evaluated.problem.join(), contains('对手明显占优'));
        expect(evaluated.better.join(), contains('你明显占优'));
        final mate = explainMistake(
          fen,
          'a1a2',
          'a1a8',
          pv: ['h7h6'],
          bestPv: ['a1a8'],
          bestMate: 1,
        );
        expect(mate.tag, 'miss-mate');
        expect(mate.better, ['1 步杀']);
      },
    );

    test('praises a confirmed fork and a sacrifice preparing a later fork', () {
      final fork = explainMistake(
        'r3k3/8/8/1N6/8/8/8/4K3 w - - 0 1',
        'b5c7',
        'b5c7',
        pv: ['e8d7', 'c7a8'],
        replyCp: -500,
        bad: false,
      );
      expect(fork.praise, contains('捉双'));
      final sacrifice = explainMistake(
        '1q3rk1/6pp/8/4N3/8/8/6PP/5R1K w - - 0 1',
        'f1f8',
        'f1f8',
        pv: ['g8f8', 'e5d7', 'f8e7', 'd7b8'],
        replyCp: -600,
        bad: false,
      );
      expect(sacrifice.praise, contains('接着 Nd7+'));
      expect(sacrifice.praise, contains('捉双'));
      final refuted = explainMistake(
        'r2bk3/8/8/1N6/8/8/8/4K3 w - - 0 1',
        'b5c7',
        'b5c7',
        pv: ['d8c7'],
        replyCp: 300,
        bad: false,
      );
      expect(refuted.praise, isNull);
    });

    test('illegal PV stops safely and immediate checkmate dominates tags', () {
      final result = explainMistake(
        '4k3/8/8/8/3n4/8/7P/R3K3 w - - 0 1',
        'h2h3',
        'e1d2',
        pv: ['d4c2', 'e1e8', 'c2a1'],
      );
      expect(result.tag, isNot('allow-fork'));
      expect(result.text, isNot(contains('会丢掉')));
      final mate = explainMistake(
        'rnbqkbnr/pppp1ppp/8/4p3/8/5P2/PPPPP1PP/RNBQKBNR w KQkq - 0 2',
        'g2g4',
        'e2e4',
        pv: ['d8h4'],
      );
      expect(mate.tag, 'allow-mate');
      expect(mate.problem.first, contains('Qh4#'));
      expect(explainMistake(startFen, 'e2e5', 'e2e4').tag, 'other');
      expect(explainMistake('invalid', 'e2e4', null).tag, 'other');
    });
  });

  test('SEE agrees with an independent legal capture-tree oracle on Lichess fixtures', () {
    // Read the existing CC0 fixture; no extra copied assets or JS business code.
    final rows =
        (jsonDecode(
              File('../web/test/fixtures/puzzles.json').readAsStringSync(),
            ) as Map)['puzzles']
            as List;
    var checked = 0;
    for (final row in rows.take(28)) {
      final board = position(row[1] as String);
      final moves = (row[2] as String).split(' ');
      expect(playUci(board, moves.first), isTrue);
      final captures = board
          .generate_moves()
          .where((m) => m.captured != null && m.captured != chess.Chess.KING)
          .take(4)
          .toList();
      for (final capture in captures) {
        final fen = board.fen;
        final uci =
            '${capture.fromAlgebraic}${capture.toAlgebraic}${capture.promotion?.name ?? ''}';
        board.make_move(capture);
        final expected = _gain(capture) - _bestRecapture(board, capture.to);
        board.undo_move();
        expect(staticExchange(fen, uci), expected, reason: '${row[0]} $uci');
        checked++;
      }
    }
    expect(checked, greaterThan(40));
  });
}

const _value = {'p': 1, 'n': 3, 'b': 3, 'r': 5, 'q': 9, 'k': 100};
int _gain(chess.Move m) =>
    (m.captured == null ? 0 : _value[m.captured!.name]!) +
    (m.promotion == null ? 0 : _value[m.promotion!.name]! - 1);
int _bestRecapture(chess.Chess board, int target) {
  var result = 0;
  for (final move
      in board
          .generate_moves()
          .where(
            (m) =>
                m.to == target &&
                m.captured != null &&
                m.captured != chess.Chess.KING,
          )
          .toList()) {
    board.make_move(move);
    final gain = _gain(move) - _bestRecapture(board, target);
    board.undo_move();
    if (gain > result) result = gain;
  }
  return result;
}
