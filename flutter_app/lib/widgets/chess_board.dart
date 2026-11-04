import 'dart:async';
import 'dart:math' as math;

import 'package:chess/chess.dart' as chess;
import 'package:flutter/gestures.dart';
import 'package:flutter/material.dart';
import 'package:flutter/semantics.dart';
import 'package:flutter/services.dart';
import 'package:flutter_svg/flutter_svg.dart';

class BoardArrow {
  const BoardArrow(this.uci, this.color);

  final String uci;
  final Color color;
}

/// A native, controlled chessboard. The parent owns the position and applies
/// moves; this widget never advances [fen] or executes a queued premove itself.
class ChessBoard extends StatefulWidget {
  const ChessBoard({
    super.key,
    required this.fen,
    this.orientation = 'w',
    this.interactive = true,
    this.playerColor,
    required this.onMove,
    this.lastMove,
    this.arrows = const [],
    this.hanging = const [],
    this.pieceSet = 'cburnett',
    this.lightColor = const Color(0xffebecd0),
    this.darkColor = const Color(0xff739552),
    this.texture,
    this.coordinates = true,
    this.animate = true,
    this.haptics = true,
    this.arrowOutline = false,
    this.premove = false,
    this.onPremove,
  });

  final String fen, orientation, pieceSet;
  final bool interactive, coordinates, animate, haptics, arrowOutline, premove;
  final String? playerColor, lastMove, texture;
  final List<BoardArrow> arrows;
  final List<String> hanging;
  final Color lightColor, darkColor;
  final Future<void> Function(String uci) onMove;
  final void Function(String uci)? onPremove;

  @override
  State<ChessBoard> createState() => _ChessBoardState();
}

class _ChessBoardState extends State<ChessBoard> {
  final _dragPosition = ValueNotifier<Offset?>(null);
  chess.Chess? _game;
  Map<String, _Piece> _pieces = {};
  List<_Move> _moves = const [];
  List<_Move>? _premoveMoves;
  String? _selected, _dragSource, _queued, _checkSquare, _error;
  DialogRoute<String>? _promotionRoute;
  int _nextId = 0, _revision = 0;
  bool _busy = false;
  double _extent = 0;

  bool get _flipped => widget.orientation == 'b';
  String get _turn => _game?.turn == chess.Chess.BLACK ? 'b' : 'w';
  bool get _canInteract =>
      !_busy && _game != null && (widget.interactive || _isPremove);
  bool get _isPremove =>
      widget.premove &&
      widget.onPremove != null &&
      (widget.playerColor == 'w' || widget.playerColor == 'b') &&
      widget.playerColor != _turn;

  @override
  void initState() {
    super.initState();
    _readPosition();
  }

  @override
  void didUpdateWidget(covariant ChessBoard oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.fen != widget.fen) {
      _revision++;
      _clearInteraction();
      _queued = null;
      _readPosition();
      _dismissPromotion();
    } else if (oldWidget.orientation != widget.orientation ||
        oldWidget.interactive != widget.interactive ||
        oldWidget.playerColor != widget.playerColor ||
        oldWidget.premove != widget.premove ||
        (oldWidget.onPremove == null) != (widget.onPremove == null)) {
      _revision++;
      _clearInteraction();
      _queued = null;
      _premoveMoves = null;
      _dismissPromotion();
    }
  }

  void _dismissPromotion() {
    final route = _promotionRoute;
    if (route == null) return;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      final navigator = route.navigator;
      if (navigator != null && route.isActive) navigator.removeRoute(route);
    });
  }

  void _readPosition() {
    final previous = _pieces;
    _game = null;
    _pieces = {};
    _moves = const [];
    _premoveMoves = null;
    _checkSquare = null;
    _error = null;
    try {
      final fen = widget.fen.trim();
      // fromFEN silently returns an uninitialised game for invalid input.
      if (chess.Chess.validate_fen(fen)['valid'] != true ||
          !fen.split(' ').first.contains('K') ||
          !fen.split(' ').first.contains('k')) {
        throw const FormatException('Invalid chess position');
      }
      final game = chess.Chess.fromFEN(fen);
      final position = <String, _Piece>{};
      for (final square in _squares) {
        final piece = game.get(square);
        if (piece == null) continue;
        position[square] = _Piece(
          id: -1,
          square: square,
          color: piece.color == chess.Chess.WHITE ? 'w' : 'b',
          role: piece.type.toLowerCase(),
        );
      }
      _matchPieces(previous, position);
      _moves = _readMoves(game);
      if (game.in_check) {
        _checkSquare = position.values
            .firstWhere((p) => p.role == 'k' && p.color == _turnOf(game))
            .square;
      }
      _game = game;
      _pieces = position;
    } catch (_) {
      _error = '无法显示棋局：FEN 无效，请重新载入有效局面。';
    }
  }

  void _matchPieces(Map<String, _Piece> previous, Map<String, _Piece> next) {
    final used = <int>{};
    void carry(String from, String to, {bool promotion = false}) {
      final old = previous[from], piece = next[to];
      if (old == null || piece == null || used.contains(old.id)) return;
      if (old.color != piece.color || (!promotion && old.role != piece.role)) {
        return;
      }
      next[to] = piece.withId(old.id);
      used.add(old.id);
    }

    final move = _uciSquares(widget.lastMove);
    if (move != null && !next.containsKey(move.$1)) {
      carry(move.$1, move.$2, promotion: widget.lastMove!.length == 5);
      final king = previous[move.$1];
      if (king?.role == 'k' &&
          (move.$1.codeUnitAt(0) - move.$2.codeUnitAt(0)).abs() == 2) {
        final rank = move.$1[1];
        if (move.$2[0] == 'g') carry('h$rank', 'f$rank');
        if (move.$2[0] == 'c') carry('a$rank', 'd$rank');
      }
    }
    for (final square in next.keys.toList()) {
      if (next[square]!.id == -1) carry(square, square);
    }
    for (final square in next.keys.toList()) {
      final piece = next[square]!;
      if (piece.id != -1) continue;
      final candidates =
          previous.values
              .where(
                (p) =>
                    !used.contains(p.id) &&
                    p.color == piece.color &&
                    p.role == piece.role,
              )
              .toList()
            ..sort(
              (a, b) => (_squarePoint(a.square) - _squarePoint(square))
                  .distanceSquared
                  .compareTo(
                    (_squarePoint(b.square) - _squarePoint(square))
                        .distanceSquared,
                  ),
            );
      final id = candidates.isEmpty ? _nextId++ : candidates.first.id;
      next[square] = piece.withId(id);
      used.add(id);
    }
  }

  static String _turnOf(chess.Chess game) =>
      game.turn == chess.Chess.WHITE ? 'w' : 'b';

  static List<_Move> _readMoves(chess.Chess game, {bool legal = true}) {
    // chess 0.8.x verbose maps omit the promotion role. Request its typed
    // objects so all four underpromotions survive without parsing SAN.
    return game
        .moves({'asObjects': true, 'legal': legal})
        .cast<chess.Move>()
        .map(
          (move) => _Move(
            move.fromAlgebraic,
            move.toAlgebraic,
            move.promotion?.toLowerCase(),
            (move.flags &
                    (chess.Chess.BITS_CAPTURE | chess.Chess.BITS_EP_CAPTURE)) !=
                0,
          ),
        )
        .toList(growable: false);
  }

  List<_Move> get _availableMoves {
    if (!_isPremove) return _moves;
    return _premoveMoves ??= _readMoves(
      _game!.copy()
        ..turn = widget.playerColor == 'w'
            ? chess.Chess.WHITE
            : chess.Chess.BLACK
        // An en passant target belongs to the current turn, not a future turn.
        ..ep_square = chess.Chess.EMPTY,
      legal: false,
    );
  }

  bool _canSelect(String square) {
    if (!_canInteract) return false;
    final piece = _pieces[square];
    if (piece == null) return false;
    if (widget.playerColor != null && piece.color != widget.playerColor) {
      return false;
    }
    return piece.color == _turn || _isPremove;
  }

  void _haptic() {
    if (widget.haptics) {
      unawaited(HapticFeedback.selectionClick().catchError((Object _) {}));
    }
  }

  Future<void> _tap(String square) async {
    if (!_canInteract) return;
    if (_selected == square) {
      setState(() => _selected = null);
      return;
    }
    final from = _selected;
    if (from != null &&
        _availableMoves.any((move) => move.from == from && move.to == square)) {
      await _submit(from, square);
    } else {
      setState(() {
        _selected = _canSelect(square) ? square : null;
        _queued = null;
        _error = null;
      });
      if (_selected != null) _haptic();
    }
  }

  void _startDrag(DragStartDetails details) {
    final square = _squareAt(details.localPosition, _extent, _flipped);
    if (square == null || !_canSelect(square)) return;
    setState(() {
      _dragSource = square;
      _selected = square;
      _queued = null;
      _error = null;
    });
    _dragPosition.value = details.localPosition;
    _haptic();
  }

  void _updateDrag(DragUpdateDetails details) {
    // Pointer movement rebuilds only _DragPiece and repaints _DragTarget.
    if (_dragSource != null) _dragPosition.value = details.localPosition;
  }

  void _endDrag(DragEndDetails details) {
    final from = _dragSource, position = _dragPosition.value;
    if (from == null) return;
    final to = position == null ? null : _squareAt(position, _extent, _flipped);
    setState(_clearInteraction);
    if (to != null && to != from) unawaited(_submit(from, to));
  }

  void _cancelDrag() {
    if (_dragSource != null) setState(_clearInteraction);
  }

  void _clearInteraction() {
    _selected = null;
    _dragSource = null;
    _dragPosition.value = null;
  }

  Future<void> _submit(String from, String to) async {
    if (!_canInteract) return;
    final choices = _availableMoves
        .where((move) => move.from == from && move.to == to)
        .toList(growable: false);
    if (choices.isEmpty) return;
    final revision = _revision;
    final premove = _isPremove;
    setState(() {
      _busy = true;
      _selected = null;
      _error = null;
    });
    try {
      String? promotion;
      if (choices.any((move) => move.promotion != null)) {
        promotion = await _choosePromotion(_pieces[from]!.color);
        if (promotion == null) return;
      }
      if (!mounted ||
          revision != _revision ||
          !(widget.interactive || (premove && _isPremove))) {
        return;
      }
      final chosen = choices.where((move) => move.promotion == promotion);
      if (chosen.isEmpty) return;
      final uci = chosen.first.uci;
      if (premove) {
        widget.onPremove?.call(uci);
        if (mounted && revision == _revision) setState(() => _queued = uci);
      } else {
        await widget.onMove(uci);
      }
      _haptic();
    } catch (_) {
      if (mounted && revision == _revision) {
        setState(() => _error = '走棋未成功，请重试。');
      }
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<String?> _choosePromotion(String color) async {
    final navigator = Navigator.of(context);
    final route = DialogRoute<String>(
      context: context,
      barrierDismissible: false,
      builder: (dialogContext) => PopScope(
        canPop: false,
        child: AlertDialog(
          title: const Text('选择升变棋子'),
          contentPadding: const EdgeInsets.fromLTRB(16, 8, 16, 8),
          content: SizedBox(
            width: 288,
            child: LayoutBuilder(
              builder: (context, constraints) {
                final size = math.min(68.0, constraints.maxWidth / 4);
                return Wrap(
                  alignment: WrapAlignment.center,
                  children: [
                    for (final role in ['q', 'r', 'b', 'n'])
                      Semantics(
                        label: '升变为${_roleNames[role]}',
                        button: true,
                        excludeSemantics: true,
                        onTap: () => navigator.pop(role),
                        child: Tooltip(
                          message: _roleNames[role]!,
                          child: InkWell(
                            key: ValueKey('promotion-$role'),
                            borderRadius: BorderRadius.circular(12),
                            onTap: () => navigator.pop(role),
                            child: SizedBox(
                              width: size,
                              height: size + 24,
                              child: Column(
                                children: [
                                  SizedBox.square(
                                    dimension: size,
                                    child: Padding(
                                      padding: const EdgeInsets.all(4),
                                      child: _PieceImage(
                                        color: color,
                                        role: role,
                                        set: widget.pieceSet,
                                      ),
                                    ),
                                  ),
                                  Text(_roleNames[role]!),
                                ],
                              ),
                            ),
                          ),
                        ),
                      ),
                  ],
                );
              },
            ),
          ),
          actions: [
            TextButton(
              onPressed: () => navigator.pop(),
              child: const Text('取消'),
            ),
          ],
        ),
      ),
    );
    _promotionRoute = route;
    try {
      return await navigator.push(route);
    } finally {
      if (_promotionRoute == route) _promotionRoute = null;
    }
  }

  @override
  void dispose() {
    _dismissPromotion();
    _dragPosition.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return LayoutBuilder(
      builder: (context, constraints) {
        final limit = math.min(constraints.maxWidth, constraints.maxHeight);
        final extent = limit.isFinite
            ? limit
            : MediaQuery.sizeOf(context).shortestSide;
        _extent = extent;
        if (extent <= 0) return const SizedBox.shrink();
        final cell = extent / 8;
        final destinations = <String, bool>{};
        if (_selected != null && _canInteract) {
          for (final move in _availableMoves) {
            if (move.from == _selected) destinations[move.to] = move.capture;
          }
        }
        final dragPiece = _pieces[_dragSource];
        final animation =
            widget.animate && !MediaQuery.disableAnimationsOf(context)
            ? const Duration(milliseconds: 170)
            : Duration.zero;
        final texture = widget.texture;
        final texturePath = texture == null || texture.isEmpty
            ? null
            : texture.startsWith('assets/')
            ? texture
            : 'assets/boards/$texture';
        return Center(
          child: SizedBox.square(
            dimension: extent,
            child: RepaintBoundary(
              key: const ValueKey('chess-board-paint'),
              child: Semantics(
                container: true,
                explicitChildNodes: true,
                label:
                    '国际象棋棋盘，${_flipped ? '黑' : '白'}方视角，轮到${_turn == 'w' ? '白' : '黑'}方',
                child: MouseRegion(
                  cursor: _canInteract
                      ? SystemMouseCursors.click
                      : MouseCursor.defer,
                  child: Listener(
                    onPointerCancel: (_) => _cancelDrag(),
                    child: GestureDetector(
                      key: const ValueKey('chess-board-input'),
                      behavior: HitTestBehavior.opaque,
                      excludeFromSemantics: true,
                      dragStartBehavior: DragStartBehavior.down,
                      onTapUp: (details) {
                        final square = _squareAt(
                          details.localPosition,
                          extent,
                          _flipped,
                        );
                        if (square != null) unawaited(_tap(square));
                      },
                      onPanStart: _startDrag,
                      onPanUpdate: _updateDrag,
                      onPanEnd: _endDrag,
                      onPanCancel: _cancelDrag,
                      child: ClipRRect(
                        borderRadius: BorderRadius.circular(4),
                        child: Stack(
                          fit: StackFit.expand,
                          children: [
                            RepaintBoundary(
                              child: CustomPaint(
                                painter: _SquaresPainter(
                                  widget.lightColor,
                                  widget.darkColor,
                                ),
                              ),
                            ),
                            if (texturePath != null)
                              IgnorePointer(
                                child: Image.asset(
                                  texturePath,
                                  fit: BoxFit.fill,
                                  excludeFromSemantics: true,
                                  errorBuilder: (_, _, _) =>
                                      const SizedBox.shrink(),
                                ),
                              ),
                            CustomPaint(
                              painter: _HighlightsPainter(
                                flipped: _flipped,
                                lastMove: widget.lastMove,
                                selected: _selected,
                                queued: _queued,
                                check: _checkSquare,
                                destinations: destinations,
                                hanging: widget.hanging,
                              ),
                            ),
                            for (final piece in _pieces.values)
                              AnimatedPositioned(
                                key: ValueKey('chess-piece-${piece.id}'),
                                duration: _dragSource == piece.square
                                    ? Duration.zero
                                    : animation,
                                curve: Curves.easeOutCubic,
                                left:
                                    _displayPoint(piece.square, _flipped).dx *
                                    cell,
                                top:
                                    _displayPoint(piece.square, _flipped).dy *
                                    cell,
                                width: cell,
                                height: cell,
                                child: IgnorePointer(
                                  child: Opacity(
                                    opacity: _dragSource == piece.square
                                        ? 0
                                        : 1,
                                    child: RepaintBoundary(
                                      child: Padding(
                                        key: ValueKey('piece-${piece.square}'),
                                        padding: EdgeInsets.all(cell * .045),
                                        child: _PieceImage(
                                          color: piece.color,
                                          role: piece.role,
                                          set: widget.pieceSet,
                                        ),
                                      ),
                                    ),
                                  ),
                                ),
                              ),
                            IgnorePointer(
                              child: RepaintBoundary(
                                child: CustomPaint(
                                  key: const ValueKey('board-arrows'),
                                  painter: _ArrowsPainter(
                                    List.of(widget.arrows),
                                    _flipped,
                                    widget.arrowOutline,
                                  ),
                                ),
                              ),
                            ),
                            if (widget.coordinates)
                              IgnorePointer(
                                child: CustomPaint(
                                  painter: _CoordinatesPainter(
                                    _flipped,
                                    widget.lightColor,
                                    widget.darkColor,
                                  ),
                                ),
                              ),
                            if (dragPiece != null) ...[
                              IgnorePointer(
                                child: CustomPaint(
                                  painter: _DragTarget(_dragPosition, _flipped),
                                ),
                              ),
                              IgnorePointer(
                                child: _DragPiece(
                                  position: _dragPosition,
                                  cell: cell,
                                  child: _PieceImage(
                                    color: dragPiece.color,
                                    role: dragPiece.role,
                                    set: widget.pieceSet,
                                  ),
                                ),
                              ),
                            ],
                            if (_game != null)
                              for (var row = 0; row < 8; row++)
                                for (var column = 0; column < 8; column++)
                                  _squareSemantics(
                                    row,
                                    column,
                                    cell,
                                    destinations,
                                  ),
                            if (_error != null)
                              Positioned(
                                left: 12,
                                right: 12,
                                top: _game == null ? extent * .3 : null,
                                bottom: _game == null ? null : 12,
                                child: Semantics(
                                  liveRegion: true,
                                  child: Material(
                                    color: Theme.of(context)
                                        .colorScheme
                                        .errorContainer,
                                    borderRadius: BorderRadius.circular(12),
                                    child: Padding(
                                      padding: const EdgeInsets.all(12),
                                      child: Text(
                                        _error!,
                                        textAlign: TextAlign.center,
                                        style: TextStyle(
                                          color: Theme.of(context)
                                              .colorScheme
                                              .onErrorContainer,
                                        ),
                                      ),
                                    ),
                                  ),
                                ),
                              ),
                          ],
                        ),
                      ),
                    ),
                  ),
                ),
              ),
            ),
          ),
        );
      },
    );
  }

  Widget _squareSemantics(
    int row,
    int column,
    double cell,
    Map<String, bool> destinations,
  ) {
    final square = _squareAt(Offset(column + .5, row + .5), 8, _flipped)!;
    final piece = _pieces[square];
    final actionable =
        _canSelect(square) ||
        (_canInteract && destinations.containsKey(square));
    return Positioned(
      top: row * cell,
      left: column * cell,
      width: cell,
      height: cell,
      child: Semantics(
        key: ValueKey('square-$square'),
        container: true,
        sortKey: OrdinalSortKey((row * 8 + column).toDouble()),
        label:
            '$square，${piece == null ? '空格' : '${piece.color == 'w' ? '白' : '黑'}方${_roleNames[piece.role]}'}'
            '${square == _checkSquare ? '，将军' : ''}'
            '${destinations.containsKey(square) ? '，${_isPremove ? '预走' : '合法'}目标' : ''}',
        selected: _selected == square,
        button: actionable,
        onTap: actionable ? () => unawaited(_tap(square)) : null,
        child: const SizedBox.expand(),
      ),
    );
  }
}

const _roleNames = {
  'p': '兵',
  'n': '马',
  'b': '象',
  'r': '车',
  'q': '后',
  'k': '国王',
};
final _squares = [
  for (var rank = 8; rank >= 1; rank--)
    for (final file in 'abcdefgh'.split('')) '$file$rank',
];
final _uciPattern = RegExp(r'^[a-h][1-8][a-h][1-8][qrbn]?$');

(String, String)? _uciSquares(String? uci) =>
    uci != null && _uciPattern.hasMatch(uci)
    ? (uci.substring(0, 2), uci.substring(2, 4))
    : null;

Offset _squarePoint(String square) => Offset(
  (square.codeUnitAt(0) - 97).toDouble(),
  (8 - int.parse(square[1])).toDouble(),
);

Offset _displayPoint(String square, bool flipped) {
  final point = _squarePoint(square);
  return flipped ? Offset(7 - point.dx, 7 - point.dy) : point;
}

String? _squareAt(Offset point, double extent, bool flipped) {
  if (extent <= 0 ||
      !point.dx.isFinite ||
      !point.dy.isFinite ||
      point.dx < 0 ||
      point.dy < 0 ||
      point.dx >= extent ||
      point.dy >= extent) {
    return null;
  }
  final column = (point.dx * 8 / extent).floor();
  final row = (point.dy * 8 / extent).floor();
  return '${'abcdefgh'[flipped ? 7 - column : column]}${flipped ? row + 1 : 8 - row}';
}

class _Piece {
  const _Piece({
    required this.id,
    required this.square,
    required this.color,
    required this.role,
  });
  final int id;
  final String square, color, role;
  _Piece withId(int value) =>
      _Piece(id: value, square: square, color: color, role: role);
}

class _Move {
  const _Move(this.from, this.to, this.promotion, this.capture);
  final String from, to;
  final String? promotion;
  final bool capture;
  String get uci => '$from$to${promotion ?? ''}';
}

class _PieceImage extends StatelessWidget {
  const _PieceImage({
    required this.color,
    required this.role,
    required this.set,
  });
  final String color, role, set;
  static const _webpSets = {
    'pirouetti',
    'kosal',
    'firi',
    'governor',
    'kiwen-suwi',
  };
  static const _svgSets = {
    'cburnett',
    'rhosgfx',
    'merida',
    'chessnut',
    'fantasy',
    'spatial',
    'celtic',
    'mpchess',
    'pixel',
    'shapes',
    'letter',
  };

  @override
  Widget build(BuildContext context) {
    final name = '$color${role.toUpperCase()}';
    final safeSet = _svgSets.contains(set) || _webpSets.contains(set)
        ? set
        : 'cburnett';
    if (_webpSets.contains(safeSet)) {
      return Image.asset(
        'assets/pieces/$safeSet/$name.webp',
        fit: BoxFit.contain,
        filterQuality: FilterQuality.medium,
        excludeFromSemantics: true,
        errorBuilder: (_, _, _) => _fallback(name),
      );
    }
    return SvgPicture.asset(
      'assets/pieces/$safeSet/$name.svg',
      fit: BoxFit.contain,
      excludeFromSemantics: true,
      errorBuilder: (_, _, _) => _fallback(name),
    );
  }

  Widget _fallback(String name) {
    final symbol = FittedBox(
      child: Text(
        (color == 'w' ? '♙♘♗♖♕♔' : '♟♞♝♜♛♚')['pnbrqk'.indexOf(role)],
        style: TextStyle(
          color: color == 'w' ? Colors.white : Colors.black,
          shadows: const [Shadow(color: Colors.black54, blurRadius: 2)],
        ),
      ),
    );
    if (set == 'cburnett') return symbol;
    return SvgPicture.asset(
      'assets/pieces/cburnett/$name.svg',
      excludeFromSemantics: true,
      errorBuilder: (_, _, _) => symbol,
    );
  }
}

class _DragPiece extends StatelessWidget {
  const _DragPiece({
    required this.position,
    required this.cell,
    required this.child,
  });
  final ValueNotifier<Offset?> position;
  final double cell;
  final Widget child;

  @override
  Widget build(BuildContext context) => ValueListenableBuilder<Offset?>(
    valueListenable: position,
    child: RepaintBoundary(
      child: SizedBox.square(dimension: cell * 1.12, child: child),
    ),
    builder: (context, point, child) => Stack(
      children: [
        if (point != null)
          Positioned(
            left: point.dx - cell * .56,
            top: point.dy - cell * .56,
            child: child!,
          ),
      ],
    ),
  );
}

class _SquaresPainter extends CustomPainter {
  const _SquaresPainter(this.light, this.dark);
  final Color light, dark;

  @override
  void paint(Canvas canvas, Size size) {
    final cell = size.width / 8;
    final paint = Paint()..isAntiAlias = false;
    for (var row = 0; row < 8; row++) {
      for (var col = 0; col < 8; col++) {
        paint.color = (row + col).isEven ? light : dark;
        canvas.drawRect(
          Rect.fromLTWH(col * cell, row * cell, cell, cell),
          paint,
        );
      }
    }
  }

  @override
  bool shouldRepaint(_SquaresPainter old) =>
      light != old.light || dark != old.dark;
}

class _HighlightsPainter extends CustomPainter {
  _HighlightsPainter({
    required this.flipped,
    required this.lastMove,
    required this.selected,
    required this.queued,
    required this.check,
    required this.destinations,
    required this.hanging,
  });
  final bool flipped;
  final String? lastMove, selected, queued, check;
  final Map<String, bool> destinations;
  final List<String> hanging;

  @override
  void paint(Canvas canvas, Size size) {
    final cell = size.width / 8;
    Rect rect(String square) =>
        (_displayPoint(square, flipped) * cell) & Size.square(cell);
    final paint = Paint();
    for (final square in hanging) {
      if (!RegExp(r'^[a-h][1-8]$').hasMatch(square)) continue;
      canvas.drawCircle(
        rect(square).center,
        cell * .43,
        Paint()
          ..color = const Color(0xffeb8d35)
          ..style = PaintingStyle.stroke
          ..strokeWidth = cell * .055,
      );
    }
    void highlight(String square, Color color) =>
        canvas.drawRect(rect(square), paint..color = color);
    final last = _uciSquares(lastMove);
    if (last != null) {
      for (final square in [last.$1, last.$2]) {
        highlight(square, const Color(0x66f5d442));
      }
    }
    final premove = _uciSquares(queued);
    if (premove != null) {
      for (final square in [premove.$1, premove.$2]) {
        highlight(square, const Color(0x805882ed));
      }
    }
    if (selected != null) highlight(selected!, const Color(0x88f7ee56));
    if (check != null) {
      final bounds = rect(check!);
      canvas.drawRect(
        bounds,
        Paint()
          ..shader = const RadialGradient(
            colors: [Color(0xffe53935), Color(0xccee3333), Color(0x00ee3333)],
            stops: [0, .4, 1],
          ).createShader(bounds),
      );
    }
    for (final target in destinations.entries) {
      final bounds = rect(target.key);
      canvas.drawCircle(
        bounds.center,
        cell * (target.value ? .43 : .145),
        Paint()
          ..color = const Color(0x500a1912)
          ..style = target.value ? PaintingStyle.stroke : PaintingStyle.fill
          ..strokeWidth = cell * .08,
      );
    }
  }

  @override
  bool shouldRepaint(_HighlightsPainter old) => true;
}

class _CoordinatesPainter extends CustomPainter {
  const _CoordinatesPainter(this.flipped, this.light, this.dark);
  final bool flipped;
  final Color light, dark;

  @override
  void paint(Canvas canvas, Size size) {
    final cell = size.width / 8;
    void text(String value, int col, int row, bool file) {
      final painter = TextPainter(
        text: TextSpan(
          text: value,
          style: TextStyle(
            color: (col + row).isEven ? dark : light,
            fontSize: (cell * .19).clamp(8.0, 15.0),
            fontWeight: FontWeight.w700,
            height: 1,
          ),
        ),
        textDirection: TextDirection.ltr,
      )..layout();
      painter.paint(
        canvas,
        Offset(
          col * cell + (file ? cell - painter.width - 3 : 3),
          row * cell + (file ? cell - painter.height - 2 : 2),
        ),
      );
      painter.dispose();
    }

    for (var index = 0; index < 8; index++) {
      text('abcdefgh'[flipped ? 7 - index : index], index, 7, true);
      text('${flipped ? index + 1 : 8 - index}', 0, index, false);
    }
  }

  @override
  bool shouldRepaint(_CoordinatesPainter old) =>
      flipped != old.flipped || light != old.light || dark != old.dark;
}

class _DragTarget extends CustomPainter {
  _DragTarget(this.position, this.flipped) : super(repaint: position);
  final ValueNotifier<Offset?> position;
  final bool flipped;

  @override
  void paint(Canvas canvas, Size size) {
    final point = position.value;
    if (point == null) return;
    final square = _squareAt(point, size.width, flipped);
    if (square == null) return;
    final cell = size.width / 8;
    canvas.drawRect(
      ((_displayPoint(square, flipped) * cell) & Size.square(cell)).deflate(2),
      Paint()
        ..color = const Color(0xaaffffff)
        ..style = PaintingStyle.stroke
        ..strokeWidth = 3,
    );
  }

  @override
  bool shouldRepaint(_DragTarget old) =>
      flipped != old.flipped || position != old.position;
}

class _ArrowsPainter extends CustomPainter {
  const _ArrowsPainter(this.arrows, this.flipped, this.outline);
  final List<BoardArrow> arrows;
  final bool flipped, outline;

  @override
  void paint(Canvas canvas, Size size) {
    final cell = size.width / 8;
    for (final arrow in arrows) {
      final squares = _uciSquares(arrow.uci);
      if (squares == null || squares.$1 == squares.$2) continue;
      final start =
          (_displayPoint(squares.$1, flipped) + const Offset(.5, .5)) * cell;
      final tip =
          (_displayPoint(squares.$2, flipped) + const Offset(.5, .5)) * cell;
      final delta = tip - start;
      final knight =
          (delta.dx.abs() / cell - 1).abs() < .01 &&
              (delta.dy.abs() / cell - 2).abs() < .01 ||
          (delta.dx.abs() / cell - 2).abs() < .01 &&
              (delta.dy.abs() / cell - 1).abs() < .01;
      final elbow = knight
          ? delta.dx.abs() > delta.dy.abs()
                ? Offset(tip.dx, start.dy)
                : Offset(start.dx, tip.dy)
          : start;
      final direction = (tip - elbow) / (tip - elbow).distance;
      final normal = Offset(-direction.dy, direction.dx);
      final base = tip - direction * cell * .28;
      final firstDirection = knight
          ? (elbow - start) / (elbow - start).distance
          : direction;
      final shaft = Path()
        ..moveTo(
          start.dx + firstDirection.dx * cell * .16,
          start.dy + firstDirection.dy * cell * .16,
        );
      if (knight) shaft.lineTo(elbow.dx, elbow.dy);
      shaft.lineTo(base.dx, base.dy);
      final head = Path()
        ..moveTo(tip.dx, tip.dy)
        ..lineTo(
          base.dx + normal.dx * cell * .21,
          base.dy + normal.dy * cell * .21,
        )
        ..lineTo(
          base.dx - normal.dx * cell * .21,
          base.dy - normal.dy * cell * .21,
        )
        ..close();
      final paint = Paint()
        ..strokeCap = StrokeCap.round
        ..strokeJoin = StrokeJoin.round;
      if (outline) {
        final border = arrow.color.computeLuminance() > .45
            ? const Color(0xcc202629)
            : const Color(0xddffffff);
        canvas.drawPath(
          shaft,
          paint
            ..color = border
            ..style = PaintingStyle.stroke
            ..strokeWidth = cell * .2,
        );
        canvas.drawPath(head, paint..strokeWidth = cell * .055);
      }
      final color = arrow.color.withValues(alpha: arrow.color.a * .84);
      canvas.drawPath(
        shaft,
        paint
          ..color = color
          ..style = PaintingStyle.stroke
          ..strokeWidth = cell * .14,
      );
      canvas.drawPath(head, paint..style = PaintingStyle.fill);
    }
  }

  @override
  bool shouldRepaint(_ArrowsPainter old) =>
      flipped != old.flipped ||
      outline != old.outline ||
      arrows.length != old.arrows.length ||
      Iterable<int>.generate(arrows.length).any(
        (i) =>
            arrows[i].uci != old.arrows[i].uci ||
            arrows[i].color != old.arrows[i].color,
      );
}
