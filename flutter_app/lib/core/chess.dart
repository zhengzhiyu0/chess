import 'package:chess/chess.dart' as chess;

const startFen = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
final uciPattern = RegExp(r'^[a-h][1-8][a-h][1-8][qrbn]?$');

/// chess.dart's constructor does not throw when loading fails. Always validate
/// first, including the empty-board and zero-length-square cases it accepts.
chess.Chess position(String fen) {
  final normalized = fen.trim().split(RegExp(r'\s+')).join(' ');
  final fields = normalized.split(' ');
  if (fields.length != 6 ||
      fields.first.contains('0') ||
      'K'.allMatches(fields.first).length != 1 ||
      'k'.allMatches(fields.first).length != 1 ||
      !RegExp(r'^(KQ?k?q?|Qk?q?|kq?|q|-)$').hasMatch(fields[2]) ||
      !RegExp(r'^(-|[a-h][36])$').hasMatch(fields[3]) ||
      !RegExp(r'^\d+$').hasMatch(fields[4]) ||
      !RegExp(r'^[1-9]\d*$').hasMatch(fields[5])) {
    throw const FormatException('无效的 FEN 局面');
  }
  // Validate board geometry before the library generates moves from untrusted
  // rights: a king off its home rank with stale castling can index off-board.
  final boardOnly = List<String>.from(fields);
  boardOnly[2] = '-';
  boardOnly[3] = '-';
  final validation = chess.Chess.validate_fen(boardOnly.join(' '));
  if (validation['valid'] != true) {
    throw FormatException('无效的 FEN 局面：${validation['error']}');
  }
  final game = chess.Chess.fromFEN(normalized, check_validity: false);
  // Stale castling rights must never manufacture a rook or a castling move.
  for (final color in [chess.Color.WHITE, chess.Color.BLACK]) {
    final rank = color == chess.Color.WHITE ? '1' : '8';
    bool has(String square, chess.PieceType type) {
      final piece = game.get(square);
      return piece?.color == color && piece?.type == type;
    }

    if (!has('e$rank', chess.Chess.KING)) {
      game.castling[color] = 0;
    } else {
      if (!has('h$rank', chess.Chess.ROOK)) {
        game.castling[color] &= ~chess.Chess.BITS_KSIDE_CASTLE;
      }
      if (!has('a$rank', chess.Chess.ROOK)) {
        game.castling[color] &= ~chess.Chess.BITS_QSIDE_CASTLE;
      }
    }
  }
  if (fields[3] != '-') {
    final ep = chess.Chess.SQUARES[fields[3]] as int;
    final white = game.turn == chess.Color.WHITE;
    final pawn = game.board[ep + (white ? 16 : -16)];
    if (fields[3][1] != (white ? '6' : '3') ||
        game.board[ep] != null ||
        pawn?.type != chess.Chess.PAWN ||
        pawn?.color == game.turn) {
      game.ep_square = chess.Chess.EMPTY;
    }
  }
  return game;
}

/// chess.js emits an en-passant field only when a legal capture exists. Use
/// the same canonical form for opening hashes, persisted nodes and repetition.
String fenOf(chess.Chess game) {
  final fields = game.fen.split(' ');
  if (fields[3] != '-' &&
      !game.generate_moves().any(
        (move) => move.flags & chess.Chess.BITS_EP_CAPTURE != 0,
      )) {
    fields[3] = '-';
  }
  return fields.join(' ');
}

class ChessMove {
  final String uci;
  final String san;
  final String from;
  final String to;
  final String? promotion;
  final String? captured;

  const ChessMove({
    required this.uci,
    required this.san,
    required this.from,
    required this.to,
    this.promotion,
    this.captured,
  });
}

List<ChessMove> legalMoves(String fen) {
  final game = position(fen);
  return [
    for (final move in game.generate_moves())
      ChessMove(
        uci:
            '${move.fromAlgebraic}${move.toAlgebraic}${move.promotion?.name ?? ''}',
        san: game.move_to_san(move),
        from: move.fromAlgebraic,
        to: move.toAlgebraic,
        promotion: move.promotion?.name,
        captured: move.captured?.name,
      ),
  ];
}

bool playUci(chess.Chess game, String uci) {
  if (!uciPattern.hasMatch(uci)) return false;
  for (final move in game.generate_moves()) {
    final candidate =
        '${move.fromAlgebraic}${move.toAlgebraic}${move.promotion?.name ?? ''}';
    if (candidate == uci) {
      game.make_move(move);
      return true;
    }
  }
  return false;
}

String turnOf(String fen) =>
    fen.trim().split(RegExp(r'\s+'))[1] == 'b' ? 'b' : 'w';
String opposite(String color) => color == 'w' ? 'b' : 'w';
int moveNumberOf(String fen) => int.tryParse(fen.split(' ').last) ?? 1;
String positionKey(String fen) =>
    fenOf(position(fen)).split(' ').take(4).join(' ');

const endReasonLabels = {
  'checkmate': '将死',
  'stalemate': '逼和',
  'threefold': '三次重复',
  'insufficient': '子力不足',
  'fifty': '50 回合规则',
  'resign': '认输',
  'timeout': '超时',
  'agreement': '协议和棋',
};

({String result, String reason})? terminalOf(List<String> fens) {
  if (fens.isEmpty) return null;
  final game = position(fens.last);
  if (game.in_checkmate) {
    return (
      result: turnOf(fens.last) == 'w' ? '0-1' : '1-0',
      reason: 'checkmate',
    );
  }
  if (game.in_stalemate) return (result: '1/2-1/2', reason: 'stalemate');
  if (game.insufficient_material) {
    return (result: '1/2-1/2', reason: 'insufficient');
  }
  final key = positionKey(fens.last);
  var repeats = 0;
  for (final fen in fens) {
    if (positionKey(fen) == key && ++repeats >= 3) {
      return (result: '1/2-1/2', reason: 'threefold');
    }
  }
  if (game.half_moves >= 100) return (result: '1/2-1/2', reason: 'fifty');
  return null;
}

bool canMate(String fen, String color) {
  final game = position(fen);
  final own = <String>[];
  final bishopSquares = <int>{};
  var opponents = 0;
  for (var rank = 0; rank < 8; rank++) {
    for (var file = 0; file < 8; file++) {
      final piece = game.board[rank * 16 + file];
      if (piece == null || piece.type == chess.Chess.KING) continue;
      final white = piece.color == chess.Color.WHITE;
      if (white == (color == 'w')) {
        own.add(piece.type.name);
        if (piece.type == chess.Chess.BISHOP) {
          bishopSquares.add((rank + file) % 2);
        }
      } else {
        opponents++;
      }
    }
  }
  if (own.any((type) => ['p', 'r', 'q'].contains(type))) return true;
  final sameBishops =
      own.every((type) => type == 'b') && bishopSquares.length == 1;
  if (own.length > 1 && !sameBishops) return true;
  return own.isNotEmpty && opponents > 0;
}

String timeoutResult(String fen, String flagged) {
  final winner = opposite(flagged);
  if (!canMate(fen, winner)) return '1/2-1/2';
  return winner == 'w' ? '1-0' : '0-1';
}
