import 'dart:async';
import 'dart:ui' as ui;

import 'package:chess/chess.dart' as chess;
import 'package:flutter/gestures.dart';
import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:flutter_svg/flutter_svg.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:maia_coach/widgets/chess_board.dart';

const _start = chess.Chess.DEFAULT_POSITION;
const _promotion = '7k/P7/8/8/8/8/8/7K w - - 0 1';
const _inputKey = ValueKey('chess-board-input');

Future<void> _mount(
  WidgetTester tester, {
  String fen = _start,
  String orientation = 'w',
  String? playerColor,
  bool interactive = true,
  bool premove = false,
  bool animate = false,
  bool coordinates = true,
  bool arrowOutline = false,
  String pieceSet = 'cburnett',
  String? texture,
  String? lastMove,
  double size = 400,
  List<BoardArrow> arrows = const [],
  Future<void> Function(String)? onMove,
  void Function(String)? onPremove,
}) async {
  await tester.pumpWidget(
    MaterialApp(
      home: Scaffold(
        body: Center(
          child: SizedBox.square(
            dimension: size,
            child: ChessBoard(
              fen: fen,
              orientation: orientation,
              playerColor: playerColor,
              interactive: interactive,
              premove: premove,
              animate: animate,
              coordinates: coordinates,
              haptics: false,
              arrowOutline: arrowOutline,
              pieceSet: pieceSet,
              texture: texture,
              lastMove: lastMove,
              arrows: arrows,
              onMove: onMove ?? (_) async {},
              onPremove: onPremove,
            ),
          ),
        ),
      ),
    ),
  );
  await tester.pumpAndSettle();
}

Offset _center(WidgetTester tester, String square) =>
    tester.getCenter(find.byKey(ValueKey('square-$square')));

Future<void> _tap(WidgetTester tester, String square) async {
  await tester.tapAt(_center(tester, square));
  await tester.pump();
}

Semantics _semantics(WidgetTester tester, String square) =>
    tester.widget<Semantics>(find.byKey(ValueKey('square-$square')));

Future<void> _move(WidgetTester tester, String from, String to) async {
  await _tap(tester, from);
  await _tap(tester, to);
  await tester.pumpAndSettle();
}

Future<Uint8List> _pixels(WidgetTester tester) async {
  await tester.pumpAndSettle();
  final boundary = tester.renderObject<RenderRepaintBoundary>(
    find.byKey(const ValueKey('chess-board-paint')),
  );
  return (await tester.runAsync(() async {
    final image = await boundary.toImage(pixelRatio: 1);
    final data = await image.toByteData(format: ui.ImageByteFormat.rawRgba);
    image.dispose();
    return data!.buffer.asUint8List(data.offsetInBytes, data.lengthInBytes);
  }))!;
}

void main() {
  testWidgets(
    'renders real SVG assets, 64 accessible squares and square geometry',
    (tester) async {
      await _mount(tester);
      expect(find.byType(SvgPicture), findsNWidgets(32));
      expect(find.byKey(const ValueKey('square-a8')), findsOneWidget);
      expect(find.byKey(const ValueKey('square-h1')), findsOneWidget);
      final board = tester.getRect(find.byKey(_inputKey));
      expect(board.size, const Size(400, 400));
      expect(_center(tester, 'a8'), board.topLeft + const Offset(25, 25));
      expect(_center(tester, 'h1'), board.topLeft + const Offset(375, 375));
      expect(_semantics(tester, 'e1').properties.label, contains('白方国王'));
      expect(_semantics(tester, 'd8').properties.label, contains('黑方后'));
      final svg = await rootBundle.loadString('assets/pieces/cburnett/wK.svg');
      expect(svg, contains('<svg'));
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets('tap selection exposes legal targets and sends one UCI move', (
    tester,
  ) async {
    final moves = <String>[];
    await _mount(
      tester,
      playerColor: 'w',
      onMove: (uci) async => moves.add(uci),
    );
    await _tap(tester, 'e2');
    expect(_semantics(tester, 'e2').properties.selected, isTrue);
    expect(_semantics(tester, 'e4').properties.label, contains('合法目标'));
    expect(_semantics(tester, 'e3').properties.onTap, isNotNull);
    expect(_semantics(tester, 'e5').properties.onTap, isNull);
    await _tap(tester, 'e4');
    expect(moves, ['e2e4']);
    // Controlled position: only the parent is allowed to update FEN.
    expect(find.byKey(const ValueKey('piece-e2')), findsOneWidget);
    expect(find.byKey(const ValueKey('piece-e4')), findsNothing);
  });

  testWidgets('rejects illegal moves, opponent pieces and wrong player turn', (
    tester,
  ) async {
    final moves = <String>[];
    Future<void> onMove(String uci) async => moves.add(uci);
    await _mount(tester, playerColor: 'w', onMove: onMove);
    await _move(tester, 'e2', 'e5');
    await _move(tester, 'e7', 'e5');
    expect(moves, isEmpty);
    expect(_semantics(tester, 'e7').properties.onTap, isNull);
    await _mount(tester, playerColor: 'b', onMove: onMove);
    await _move(tester, 'e7', 'e5');
    expect(moves, isEmpty);
  });

  testWidgets('tapping selected square deselects and another piece reselects', (
    tester,
  ) async {
    await _mount(tester);
    await _tap(tester, 'd2');
    await _tap(tester, 'd2');
    expect(_semantics(tester, 'd2').properties.selected, isFalse);
    await _tap(tester, 'e2');
    await _tap(tester, 'g1');
    expect(_semantics(tester, 'g1').properties.selected, isTrue);
    expect(_semantics(tester, 'f3').properties.label, contains('合法目标'));
    expect(_semantics(tester, 'e4').properties.onTap, isNull);
  });

  testWidgets('black orientation reverses both coordinates and hit testing', (
    tester,
  ) async {
    final game = chess.Chess()..move('e4');
    final moves = <String>[];
    await _mount(
      tester,
      fen: game.fen,
      orientation: 'b',
      playerColor: 'b',
      onMove: (uci) async => moves.add(uci),
    );
    final board = tester.getRect(find.byKey(_inputKey));
    expect(_center(tester, 'h1'), board.topLeft + const Offset(25, 25));
    expect(_center(tester, 'a8'), board.topLeft + const Offset(375, 375));
    await _move(tester, 'e7', 'e5');
    expect(moves, ['e7e5']);
  });

  testWidgets('read-only board rejects taps and touch drags', (tester) async {
    final moves = <String>[];
    await _mount(
      tester,
      interactive: false,
      onMove: (uci) async => moves.add(uci),
    );
    await _move(tester, 'e2', 'e4');
    await tester.dragFrom(
      _center(tester, 'e2'),
      _center(tester, 'e4') - _center(tester, 'e2'),
    );
    await tester.pumpAndSettle();
    expect(moves, isEmpty);
    expect(_semantics(tester, 'e2').properties.onTap, isNull);
  });

  for (final kind in [PointerDeviceKind.touch, PointerDeviceKind.mouse]) {
    testWidgets('$kind drag begins without long press and submits on release', (
      tester,
    ) async {
      final moves = <String>[];
      await _mount(tester, onMove: (uci) async => moves.add(uci));
      final gesture = await tester.startGesture(
        _center(tester, 'g1'),
        kind: kind,
      );
      await gesture.moveBy(const Offset(0, -25));
      await tester.pump();
      expect(_semantics(tester, 'g1').properties.selected, isTrue);
      expect(moves, isEmpty);
      await gesture.moveTo(_center(tester, 'f3'));
      await gesture.up();
      await tester.pumpAndSettle();
      expect(moves, ['g1f3']);
    });
  }

  testWidgets('offboard drag release and pointer cancel restore the piece', (
    tester,
  ) async {
    final moves = <String>[];
    await _mount(tester, onMove: (uci) async => moves.add(uci));
    final gesture = await tester.startGesture(_center(tester, 'e2'));
    await gesture.moveTo(
      tester.getRect(find.byKey(_inputKey)).topLeft - const Offset(20, 20),
    );
    await gesture.up();
    await tester.pumpAndSettle();
    expect(moves, isEmpty);
    expect(_semantics(tester, 'e2').properties.selected, isFalse);
    final cancelled = await tester.startGesture(_center(tester, 'e2'));
    await cancelled.moveTo(_center(tester, 'e4'));
    await tester.pump();
    await cancelled.cancel();
    await tester.pump();
    expect(moves, isEmpty);
    expect(_semantics(tester, 'e2').properties.selected, isFalse);
    await _move(tester, 'e2', 'e4');
    expect(moves, ['e2e4']);
  });

  testWidgets('asynchronous callback locks all input until it completes', (
    tester,
  ) async {
    final gate = Completer<void>();
    final moves = <String>[];
    await _mount(
      tester,
      onMove: (uci) {
        moves.add(uci);
        return gate.future;
      },
    );
    await _move(tester, 'e2', 'e4');
    await _move(tester, 'd2', 'd4');
    await _move(tester, 'e2', 'e4');
    expect(moves, ['e2e4']);
    expect(_semantics(tester, 'd2').properties.onTap, isNull);
    gate.complete();
    await tester.pumpAndSettle();
    expect(_semantics(tester, 'd2').properties.onTap, isNotNull);
  });

  testWidgets('failed callback displays an error and unlocks input for retry', (
    tester,
  ) async {
    var attempts = 0;
    await _mount(
      tester,
      onMove: (_) async {
        if (++attempts == 1) throw StateError('rejected');
      },
    );
    await _move(tester, 'e2', 'e4');
    expect(find.text('走棋未成功，请重试。'), findsOneWidget);
    await _move(tester, 'd2', 'd4');
    expect(attempts, 2);
    expect(find.text('走棋未成功，请重试。'), findsNothing);
    expect(tester.takeException(), isNull);
  });

  for (final role in ['q', 'r', 'b', 'n']) {
    testWidgets('promotion to $role requires an explicit real-image choice', (
      tester,
    ) async {
      final moves = <String>[];
      await _mount(
        tester,
        fen: _promotion,
        onMove: (uci) async => moves.add(uci),
      );
      await _move(tester, 'a7', 'a8');
      expect(moves, isEmpty);
      expect(find.text('选择升变棋子'), findsOneWidget);
      expect(
        find.descendant(
          of: find.byType(AlertDialog),
          matching: find.byType(SvgPicture),
        ),
        findsNWidgets(4),
      );
      await tester.tapAt(const Offset(5, 5));
      await tester.pumpAndSettle();
      expect(find.byType(AlertDialog), findsOneWidget);
      await tester.tap(find.byKey(ValueKey('promotion-$role')));
      await tester.pumpAndSettle();
      expect(moves, ['a7a8$role']);
      expect(find.byType(AlertDialog), findsNothing);
      expect(tester.takeException(), isNull);
    });
  }

  testWidgets('promotion can be explicitly cancelled without a move', (
    tester,
  ) async {
    final moves = <String>[];
    await _mount(
      tester,
      fen: _promotion,
      onMove: (uci) async => moves.add(uci),
    );
    await _move(tester, 'a7', 'a8');
    await tester.tap(find.text('取消'));
    await tester.pumpAndSettle();
    expect(moves, isEmpty);
    expect(_semantics(tester, 'a7').properties.onTap, isNotNull);
  });

  testWidgets(
    'black capture promotion uses black images and keeps underpromotion',
    (tester) async {
      final moves = <String>[];
      await _mount(
        tester,
        fen: '7k/8/8/8/8/8/1p6/R6K b - - 0 1',
        orientation: 'b',
        playerColor: 'b',
        onMove: (uci) async => moves.add(uci),
      );
      await _move(tester, 'b2', 'a1');
      final image = tester.widget<SvgPicture>(
        find.descendant(
          of: find.byKey(const ValueKey('promotion-n')),
          matching: find.byType(SvgPicture),
        ),
      );
      expect(
        (image.bytesLoader as SvgAssetLoader).assetName,
        'assets/pieces/cburnett/bN.svg',
      );
      await tester.tap(find.byKey(const ValueKey('promotion-n')));
      await tester.pumpAndSettle();
      expect(moves, ['b2a1n']);
    },
  );

  testWidgets(
    'changing FEN dismisses pending promotion and never submits stale move',
    (tester) async {
      final moves = <String>[];
      Future<void> onMove(String uci) async => moves.add(uci);
      await _mount(tester, fen: _promotion, onMove: onMove);
      await _move(tester, 'a7', 'a8');
      await _mount(tester, onMove: onMove);
      expect(find.byType(AlertDialog), findsNothing);
      expect(moves, isEmpty);
      await _move(tester, 'e2', 'e4');
      expect(moves, ['e2e4']);
    },
  );

  testWidgets('legal castles and en passant come from chess rules', (
    tester,
  ) async {
    final moves = <String>[];
    Future<void> onMove(String uci) async => moves.add(uci);
    await _mount(
      tester,
      fen: 'r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1',
      onMove: onMove,
    );
    await _move(tester, 'e1', 'g1');
    await _move(tester, 'e1', 'c1');
    expect(moves, ['e1g1', 'e1c1']);
    await _mount(
      tester,
      fen: '7k/8/8/3pP3/8/8/8/7K w - d6 0 1',
      onMove: onMove,
    );
    await _move(tester, 'e5', 'd6');
    expect(moves.last, 'e5d6');
  });

  testWidgets(
    'pinned en passant, pinned moves and castling through check are rejected',
    (tester) async {
      final moves = <String>[];
      Future<void> onMove(String uci) async => moves.add(uci);
      await _mount(
        tester,
        fen: '7k/8/8/r4pPK/8/8/8/8 w - f6 0 1',
        onMove: onMove,
      );
      await _move(tester, 'g5', 'f6');
      await _mount(
        tester,
        fen: 'k3r3/8/8/8/8/8/4R3/4K3 w - - 0 1',
        onMove: onMove,
      );
      await _move(tester, 'e2', 'd2');
      await _mount(
        tester,
        fen: 'k4r2/8/8/8/8/8/8/4K2R w K - 0 1',
        onMove: onMove,
      );
      await _move(tester, 'e1', 'g1');
      expect(moves, isEmpty);
    },
  );

  testWidgets(
    'check indicator follows the checked king and clears with new FEN',
    (tester) async {
      await _mount(tester, fen: 'k3r3/8/8/8/8/8/8/4K3 w - - 0 1');
      expect(_semantics(tester, 'e1').properties.label, contains('将军'));
      expect(_semantics(tester, 'a8').properties.label, isNot(contains('将军')));
      await _mount(tester);
      expect(_semantics(tester, 'e1').properties.label, isNot(contains('将军')));
    },
  );

  testWidgets('premove queues own legal geometry without invoking onMove', (
    tester,
  ) async {
    final game = chess.Chess()..move('e4');
    final moves = <String>[], premoves = <String>[];
    await _mount(
      tester,
      fen: game.fen,
      playerColor: 'w',
      premove: true,
      onMove: (uci) async => moves.add(uci),
      onPremove: premoves.add,
    );
    await _tap(tester, 'g1');
    expect(_semantics(tester, 'f3').properties.label, contains('预走目标'));
    await _tap(tester, 'f3');
    expect(premoves, ['g1f3']);
    expect(moves, isEmpty);
    await _move(tester, 'e7', 'e5');
    expect(premoves, ['g1f3']);
    expect(moves, isEmpty);
  });

  testWidgets(
    'premove requires player color and callback and stays off by default',
    (tester) async {
      final game = chess.Chess()..move('e4');
      final moves = <String>[], premoves = <String>[];
      await _mount(
        tester,
        fen: game.fen,
        playerColor: 'w',
        onMove: (uci) async => moves.add(uci),
        onPremove: premoves.add,
      );
      await _move(tester, 'g1', 'f3');
      await _mount(
        tester,
        fen: game.fen,
        playerColor: 'w',
        premove: true,
        onMove: (uci) async => moves.add(uci),
      );
      await _move(tester, 'g1', 'f3');
      expect(moves, isEmpty);
      expect(premoves, isEmpty);
    },
  );

  testWidgets(
    'premove remains available while normal interaction is disabled',
    (tester) async {
      final game = chess.Chess()..move('e4');
      final moves = <String>[], premoves = <String>[];
      Future<void> onMove(String uci) async => moves.add(uci);
      await _mount(
        tester,
        fen: game.fen,
        playerColor: 'w',
        premove: true,
        interactive: false,
        onMove: onMove,
        onPremove: premoves.add,
      );
      await _move(tester, 'g1', 'f3');
      expect(premoves, ['g1f3']);
      expect(moves, isEmpty);
      expect(_semantics(tester, 'e7').properties.onTap, isNull);
      game.move('e5');
      await _mount(
        tester,
        fen: game.fen,
        playerColor: 'w',
        premove: true,
        interactive: false,
        onMove: onMove,
        onPremove: premoves.add,
      );
      await _move(tester, 'g1', 'f3');
      expect(premoves, ['g1f3']);
      expect(moves, isEmpty);
      expect(_semantics(tester, 'g1').properties.onTap, isNull);
    },
  );

  testWidgets('premove promotion also requires a chosen role', (tester) async {
    final moves = <String>[], premoves = <String>[];
    await _mount(
      tester,
      fen: '7k/P7/8/8/8/8/8/7K b - - 0 1',
      playerColor: 'w',
      premove: true,
      onMove: (uci) async => moves.add(uci),
      onPremove: premoves.add,
    );
    await _move(tester, 'a7', 'a8');
    expect(premoves, isEmpty);
    await tester.tap(find.byKey(const ValueKey('promotion-r')));
    await tester.pumpAndSettle();
    expect(premoves, ['a7a8r']);
    expect(moves, isEmpty);
  });

  testWidgets(
    'screen-reader square actions can select and move without pointer input',
    (tester) async {
      final semantics = tester.ensureSemantics();
      final moves = <String>[];
      await _mount(tester, onMove: (uci) async => moves.add(uci));
      final owner = tester.binding.renderViews.first.owner!.semanticsOwner!;
      owner.performAction(
        tester.getSemantics(find.byKey(const ValueKey('square-e2'))).id,
        SemanticsAction.tap,
      );
      await tester.pump();
      owner.performAction(
        tester.getSemantics(find.byKey(const ValueKey('square-e4'))).id,
        SemanticsAction.tap,
      );
      await tester.pumpAndSettle();
      expect(moves, ['e2e4']);
      semantics.dispose();
    },
  );

  testWidgets(
    'malformed and kingless FEN show meaningful fallback then recover',
    (tester) async {
      for (final fen in [
        'not a FEN',
        '8/8/8/8/8/8/8/8 w - - 0 1',
        '8/8/8/8/8/8/8/8 w - - x 1',
      ]) {
        await _mount(tester, fen: fen);
        expect(find.textContaining('FEN 无效'), findsOneWidget);
        expect(tester.takeException(), isNull);
      }
      await _mount(tester);
      expect(find.textContaining('FEN 无效'), findsNothing);
      expect(find.byType(SvgPicture), findsNWidgets(32));
    },
  );

  testWidgets(
    'responsive board, texture, and WebP set load actual bundled assets',
    (tester) async {
      await _mount(
        tester,
        size: 240,
        pieceSet: 'kosal',
        texture: 'green-plastic.webp',
      );
      expect(tester.getSize(find.byKey(_inputKey)), const Size(240, 240));
      expect(
        tester.getSize(find.byKey(const ValueKey('piece-e2'))),
        const Size(30, 30),
      );
      expect(find.byType(SvgPicture), findsNothing);
      expect(find.byType(Image), findsNWidgets(33));
      expect(
        (await rootBundle.load('assets/pieces/kosal/wK.webp')).lengthInBytes,
        greaterThan(100),
      );
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets(
    'piece identity survives normal moves, castle and underpromotion',
    (tester) async {
      Key identity(String square) {
        return tester
            .widget<AnimatedPositioned>(
              find.ancestor(
                of: find.byKey(ValueKey('piece-$square')),
                matching: find.byType(AnimatedPositioned),
              ),
            )
            .key!;
      }

      await _mount(tester, animate: true);
      final pawn = identity('e2');
      final game = chess.Chess()..move('e4');
      await _mount(tester, fen: game.fen, lastMove: 'e2e4', animate: true);
      expect(identity('e4'), pawn);
      final castle = chess.Chess.fromFEN(
        'r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1',
      );
      await _mount(tester, fen: castle.fen, animate: true);
      final king = identity('e1'), rook = identity('h1');
      castle.move({'from': 'e1', 'to': 'g1'});
      await _mount(tester, fen: castle.fen, lastMove: 'e1g1', animate: true);
      expect(identity('g1'), king);
      expect(identity('f1'), rook);
      final promotion = chess.Chess.fromFEN(_promotion);
      await _mount(tester, fen: promotion.fen, animate: true);
      final promoted = identity('a7');
      promotion.move({'from': 'a7', 'to': 'a8', 'promotion': 'n'});
      await _mount(
        tester,
        fen: promotion.fen,
        lastMove: 'a7a8n',
        animate: true,
      );
      expect(identity('a8'), promoted);
    },
  );

  testWidgets(
    'arrow painter draws oriented knight elbows, straight arrows and outlines',
    (tester) async {
      const fen = '7k/8/8/8/8/8/8/K7 w - - 0 1';
      await _mount(tester, fen: fen, coordinates: false);
      final plain = await _pixels(tester);
      await _mount(
        tester,
        fen: fen,
        coordinates: false,
        arrowOutline: true,
        arrows: const [
          BoardArrow('b1c3', Colors.blue),
          BoardArrow('a4h4', Colors.orange),
          BoardArrow('garbage', Colors.red),
          BoardArrow('a1a1', Colors.red),
        ],
      );
      final annotated = await _pixels(tester);
      bool changedAt(Offset point) {
        final offset = (point.dy.floor() * 400 + point.dx.floor()) * 4;
        return [0, 1, 2].any(
          (channel) => plain[offset + channel] != annotated[offset + channel],
        );
      }

      // b1 -> b3 -> c3: the long leg of a knight arrow is drawn first.
      expect(changedAt(const Offset(75, 325)), isTrue);
      expect(changedAt(const Offset(100, 275)), isTrue);
      expect(changedAt(const Offset(200, 225)), isTrue);
      expect(changedAt(const Offset(225, 125)), isFalse);
      await _mount(
        tester,
        fen: fen,
        orientation: 'b',
        coordinates: false,
        arrowOutline: true,
        arrows: const [BoardArrow('b1c3', Colors.blue)],
      );
      final flipped = await _pixels(tester);
      final elbow = (125 * 400 + 300) * 4;
      expect(flipped[elbow + 2], greaterThan(flipped[elbow]));
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets(
    'position changes during a drag cancel stale pointer submission',
    (tester) async {
      final moves = <String>[];
      Future<void> onMove(String uci) async => moves.add(uci);
      await _mount(tester, onMove: onMove);
      final gesture = await tester.startGesture(_center(tester, 'e2'));
      await gesture.moveBy(const Offset(0, -25));
      await tester.pump();
      final game = chess.Chess()..move('d4');
      await _mount(tester, fen: game.fen, onMove: onMove);
      await gesture.moveTo(_center(tester, 'e4'));
      await gesture.up();
      await tester.pumpAndSettle();
      expect(moves, isEmpty);
      expect(_semantics(tester, 'e2').properties.selected, isFalse);
    },
  );
}
