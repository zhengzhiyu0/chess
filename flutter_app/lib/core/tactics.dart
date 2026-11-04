/// Native counterpart of web/src/coach/explain.ts. Material values are in pawns.
/// Motifs describe tactical patterns; [confirmedMotifs] checks that a supplied
/// principal variation actually wins their targets before a review claims gain.
library;

import 'dart:math' as math;

import 'package:chess/chess.dart' as chess;

import 'chess.dart';
import 'rating.dart' show judgeMove;

const pieceNames = {'p': '兵', 'n': '马', 'b': '象', 'r': '车', 'q': '后', 'k': '王'};
const _values = {'p': 1, 'n': 3, 'b': 3, 'r': 5, 'q': 9, 'k': 100};
const motifLabels = {
  'mate': '将杀',
  'double-check': '双将',
  'fork': '捉双',
  'discovered': '闪击',
  'pin': '牵制',
  'skewer': '串击',
  'remove-defender': '吃掉保护者',
  'trapped': '困子',
  'trade-up': '以小换大',
  'free': '白吃子',
  'mate-threat': '杀棋威胁',
  'promote': '升变',
  'check': '将军',
};
const _priority = [
  'mate',
  'double-check',
  'fork',
  'discovered',
  'pin',
  'skewer',
  'remove-defender',
  'trapped',
  'trade-up',
  'free',
  'mate-threat',
  'promote',
  'check',
];
const _tactical = {
  'mate',
  'double-check',
  'fork',
  'discovered',
  'pin',
  'skewer',
  'remove-defender',
  'trapped',
  'trade-up',
  'free',
  'mate-threat',
};
const _followUp = {
  'double-check',
  'fork',
  'discovered',
  'pin',
  'skewer',
  'remove-defender',
  'trapped',
};
const _weak = {'free', 'trade-up'};
const _factual = {'mate', 'double-check', 'mate-threat', 'promote', 'check'};
const _directions = <String, List<int>>{
  'b': [-17, -15, 15, 17],
  'r': [-16, -1, 1, 16],
  'q': [-17, -15, 15, 17, -16, -1, 1, 16],
};
final _squarePattern = RegExp(r'^[a-h][1-8]$');

class Motif {
  final String kind;
  final String text;

  /// Opposing pieces targeted, excluding the king. Empty for factual motifs.
  final List<String> targets;
  final bool immediate;
  Motif(
    this.kind,
    this.text, {
    Iterable<String> targets = const [],
    this.immediate = false,
  }) : targets = List.unmodifiable(targets.toSet());
}

class Tactic {
  final Motif motif;
  final int ply;
  final String? san;
  const Tactic(this.motif, this.ply, this.san);
}

class MistakeExplanation {
  /// Stable notebook id, matching the web app (e.g. allow-fork, hanging).
  final String tag;
  final String tagLabel;
  final List<String> problem;
  final List<String> better;
  final String? praise;
  MistakeExplanation({
    required this.tag,
    required this.tagLabel,
    Iterable<String> problem = const [],
    Iterable<String> better = const [],
    this.praise,
  }) : problem = List.unmodifiable(problem),
       better = List.unmodifiable(better);

  /// Plain text suitable for Flutter Text; no HTML parsing is required.
  String get text => [...problem, ...better, ?praise].join('\n');
}

/// Full coach.ts classification. before/after/oppDrop/secondGap are win
/// percentages (0..100), not centipawns. Pass [isSacrifice] or [soundSacrifice]
/// as sacrifice; classifications alone do not infer a sound sacrifice.
String classifyMove({
  required double before,
  required double after,
  required bool playedBest,
  bool book = false,
  bool forced = false,
  bool sacrifice = false,
  double? oppDrop,
  double? secondGap,
}) => judgeMove(
  before: before,
  after: after,
  playedBest: playedBest,
  book: book,
  forced: forced,
  sacrifice: sacrifice,
  oppDrop: oppDrop,
  secondGap: secondGap,
);

/// An actual newly offered minor piece (or more), supported by mover-POV engine
/// winning chances. This is the original brilliant-move gate: loss <3 points,
/// at least 50% after, and not already at >=97% before. SEE alone cannot prove
/// that a material sacrifice is sound; engine evidence is required here.
bool soundSacrifice(
  String fen,
  String uci, {
  required double before,
  required double after,
}) =>
    before.isFinite &&
    after.isFinite &&
    before >= 0 &&
    before < 97 &&
    after >= 50 &&
    after <= 100 &&
    before - after < 3 &&
    isSacrifice(fen, uci);

chess.Color _color(String color) {
  if (color == 'w') return chess.Color.WHITE;
  if (color == 'b') return chess.Color.BLACK;
  throw ArgumentError.value(color, 'color', '须为 w 或 b');
}

String _colorId(chess.Color color) => color == chess.Color.WHITE ? 'w' : 'b';
chess.Color _other(chess.Color color) => chess.Chess.swap_color(color);
int _value(chess.PieceType? type) => type == null ? 0 : _values[type.name]!;
String _name(chess.PieceType type) => pieceNames[type.name]!;
String _uci(chess.Move move) =>
    '${move.fromAlgebraic}${move.toAlgebraic}${move.promotion?.name ?? ''}';
int _gain(chess.Move move) =>
    _value(move.captured) +
    (move.promotion == null ? 0 : _value(move.promotion) - 1);
int _capturedSquare(chess.Move move) =>
    move.flags & chess.Chess.BITS_EP_CAPTURE != 0
    ? move.to + (move.color == chess.Color.WHITE ? 16 : -16)
    : move.to;
bool _onBoard(int square) => square >= 0 && square < 128 && square & 0x88 == 0;

Iterable<int> _squares(chess.Chess board, chess.Color color) sync* {
  for (var square = 0; square < 128; square++) {
    if (square & 0x88 != 0) {
      square += 7;
      continue;
    }
    if (board.board[square]?.color == color) yield square;
  }
}

chess.Chess _copy(chess.Chess board) =>
    chess.Chess.fromFEN(board.fen, check_validity: false);

/// Hypothetical turn used only for questions about threats/defenders. Do not
/// revalidate this FEN: the other king may currently be in check. All generated
/// moves still have to leave the moving side's king safe, and never capture king.
chess.Chess _withTurn(chess.Chess board, chess.Color color) {
  final copy = _copy(board);
  if (copy.turn != color) {
    copy.turn = color;
    copy.ep_square = chess.Chess.EMPTY;
  }
  return copy;
}

List<chess.Move> _legal(chess.Chess board, [int? from]) => board
    .generate_moves(
      from == null ? null : {'square': chess.Chess.algebraic(from)},
    )
    .where((move) => move.captured != chess.Chess.KING)
    .toList();

chess.Move? _find(chess.Chess board, String uci) {
  if (!uciPattern.hasMatch(uci)) return null;
  final from = chess.Chess.SQUARES[uci.substring(0, 2)] as int;
  for (final move in _legal(board, from)) {
    if (_uci(move) == uci) return move;
  }
  return null;
}

/// Geometric attacks are used only to find candidates, never as proof of a
/// legal capture. Even pinned pieces attack king escape squares under the rules.
List<int> _attackers(chess.Chess board, int target, chess.Color by) {
  final out = <int>[];
  for (final from in _squares(board, by)) {
    final piece = board.board[from]!;
    final diff = from - target;
    if (chess.Chess.ATTACKS[diff + 119] & (1 << piece.type.shift) == 0) {
      continue;
    }
    if (piece.type == chess.Chess.PAWN) {
      if ((diff > 0) == (by == chess.Color.WHITE)) out.add(from);
      continue;
    }
    if (piece.type == chess.Chess.KNIGHT || piece.type == chess.Chess.KING) {
      out.add(from);
      continue;
    }
    final step = chess.Chess.RAYS[diff + 119];
    var square = from + step;
    while (square != target && board.board[square] == null) {
      square += step;
    }
    if (square == target) out.add(from);
  }
  return out;
}

/// Optional-stop exchange minimax, restricted to legal captures on one square.
/// Unlike the TS least-attacker approximation, equal attackers, x-rays and all
/// four promotion choices are evaluated; memoization is per request, not global.
class _See {
  final Map<String, int?> _cache = {};

  int? exchange(chess.Chess board, int square) {
    final key = '${board.fen}|$square';
    if (_cache.containsKey(key)) return _cache[key];
    final captures =
        _legal(board)
            .where((m) => m.to == square && m.captured != null)
            .toList()
          ..sort((a, b) => _value(a.piece).compareTo(_value(b.piece)));
    if (captures.isEmpty) {
      _cache[key] = null;
      return null;
    }
    final ceiling = captures.map(_gain).reduce(math.max);
    int? best;
    for (final move in captures) {
      board.make_move(move);
      final reply = exchange(board, square);
      board.undo_move();
      final score = _gain(move) - math.max(0, reply ?? 0);
      best = best == null ? score.toInt() : math.max(best, score.toInt());
      if (best == ceiling) break;
    }
    _cache[key] = best;
    return best;
  }

  int? forSide(chess.Chess board, int square, chess.Color by) {
    final copy = _withTurn(board, by);
    var best = exchange(copy, square);
    // En passant removes a pawn from a different square than the landing square.
    // Highlight the threatened pawn, and evaluate recaptures where the taker lands.
    if (copy.ep_square != chess.Chess.EMPTY) {
      for (final move in _legal(copy).where(
        (m) =>
            m.flags & chess.Chess.BITS_EP_CAPTURE != 0 &&
            _capturedSquare(m) == square,
      )) {
        copy.make_move(move);
        final score =
            _gain(move) - math.max(0, exchange(copy, move.to) ?? 0).toInt();
        copy.undo_move();
        best = best == null ? score : math.max(best, score);
      }
    }
    return best;
  }

  int? withFrom(chess.Chess board, int from, int to, chess.Color by) {
    final copy = _withTurn(board, by);
    int? best;
    for (final move in _legal(
      copy,
      from,
    ).where((m) => m.to == to && m.captured != null)) {
      copy.make_move(move);
      final score = _gain(move) - math.max(0, exchange(copy, to) ?? 0);
      copy.undo_move();
      best = best == null ? score.toInt() : math.max(best, score.toInt());
    }
    return best;
  }
}

/// Net material of the specified legal move, including en passant/promotion and
/// optimal legal recaptures. Positive means the mover gains; null means illegal.
/// This is static material evaluation, not an engine score or a mate search.
int? staticExchange(String fen, String uci) {
  try {
    final board = position(fen);
    final move = _find(board, uci);
    if (move == null) return null;
    board.make_move(move);
    return _gain(move) - math.max(0, _See().exchange(board, move.to) ?? 0);
  } on FormatException {
    return null;
  }
}

int? seeFor(String fen, String square, String by) {
  if (!_squarePattern.hasMatch(square)) return null;
  try {
    return _See().forSide(
      position(fen),
      chess.Chess.SQUARES[square] as int,
      _color(by),
    );
  } on FormatException {
    return null;
  }
}

int? seeWith(String fen, String from, String square, String by) {
  if (!_squarePattern.hasMatch(from) || !_squarePattern.hasMatch(square)) {
    return null;
  }
  try {
    return _See().withFrom(
      position(fen),
      chess.Chess.SQUARES[from] as int,
      chess.Chess.SQUARES[square] as int,
      _color(by),
    );
  } on FormatException {
    return null;
  }
}

class _Pin {
  final int pinner, pinned, behind;
  final bool absolute;
  const _Pin(this.pinner, this.pinned, this.behind, this.absolute);
}

List<int> _ray(chess.Chess board, int from, int step) {
  final hit = <int>[];
  for (
    var square = from + step;
    _onBoard(square) && hit.length < 2;
    square += step
  ) {
    if (board.board[square] != null) hit.add(square);
  }
  return hit;
}

List<_Pin> _pinsBy(chess.Chess board, chess.Color by, _See see) {
  final pins = <_Pin>[];
  for (final from in _squares(board, by)) {
    final piece = board.board[from]!;
    for (final step in _directions[piece.type.name] ?? <int>[]) {
      final hit = _ray(board, from, step);
      if (hit.length < 2) continue;
      final front = board.board[hit[0]]!;
      final rear = board.board[hit[1]]!;
      if (front.color == by ||
          rear.color == by ||
          front.type == chess.Chess.KING) {
        continue;
      }
      final absolute = rear.type == chess.Chess.KING;
      if (!absolute &&
          (front.type == chess.Chess.PAWN ||
              _value(rear.type) <= _value(front.type) ||
              _value(rear.type) <= _value(piece.type))) {
        continue;
      }
      if (see.withFrom(board, from, hit[0], by) == null) continue;
      if (absolute || _value(rear.type) > _value(front.type)) {
        pins.add(_Pin(from, hit[0], hit[1], absolute));
      }
    }
  }
  return pins;
}

bool _pinnedToKing(chess.Chess board, int square, int king, chess.Color by) {
  final before = _attackers(board, king, by).length;
  final copy = _copy(board)..remove(chess.Chess.algebraic(square));
  return _attackers(copy, king, by).length > before;
}

bool _worthHitting(
  chess.Chess board,
  int from,
  int target,
  chess.Color by,
  _See see,
) =>
    board.board[target]?.type == chess.Chess.KING ||
    (see.withFrom(board, from, target, by) ?? 0) > 0;

bool _trapped(chess.Chess board, int square, chess.Color by, _See see) {
  final piece = board.board[square]!;
  final attackers = _attackers(board, square, by);
  if (attackers.isEmpty ||
      attackers.map((sq) => _value(board.board[sq]!.type)).reduce(math.min) >=
          _value(piece.type)) {
    return false;
  }
  // Check escapes and defensive moves by other pieces, not just geometry.
  for (final move in _legal(board)) {
    board.make_move(move);
    final target = move.from == square ? move.to : square;
    final lost = see.forSide(board, target, by) ?? 0;
    board.undo_move();
    if (_gain(move) - math.max(0, lost) >= 0) return false;
  }
  return true;
}

List<Motif> detectMotifs(String fen, String uci, {String victim = '对方的'}) {
  try {
    return _detect(position(fen), uci, victim);
  } on FormatException {
    return [];
  }
}

List<Motif> _detect(chess.Chess before, String uci, String victim) {
  final after = _copy(before);
  final move = _find(after, uci);
  if (move == null) return [];
  after.make_move(move);
  final by = move.color;
  final enemy = _other(by);
  final type = move.promotion ?? move.piece;
  final to = move.to;
  final mated = after.in_checkmate;
  final check = after.in_check;
  final out = <Motif>[];
  final see = _See();
  final enemies = _squares(after, enemy).toList();
  final king = after.kings[enemy];
  String name(int square) => _name(after.board[square]!.type);
  String sq(int square) => chess.Chess.algebraic(square);

  if (mated) out.add(Motif('mate', '直接将杀！'));
  if (check && !mated && _attackers(after, king, by).length >= 2) {
    out.add(Motif('double-check', '双将：两个子同时将军，对方只能走王'));
  }

  final forked = enemies
      .where(
        (square) =>
            after.board[square]!.type != chess.Chess.PAWN &&
            _attackers(after, square, by).contains(to) &&
            _worthHitting(after, to, square, by, see),
      )
      .toList();
  if (forked.length >= 2 &&
      !mated &&
      (see.forSide(after, to, enemy) ?? 0) <= 0) {
    forked.sort(
      (a, b) =>
          _value(after.board[b]!.type).compareTo(_value(after.board[a]!.type)),
    );
    out.add(
      Motif(
        'fork',
        '${_name(type)}捉双：同时攻击$victim${forked.map(name).join('和')}',
        targets: forked.where((s) => s != king).map(sq),
      ),
    );
  }

  if (move.flags &
          (chess.Chess.BITS_KSIDE_CASTLE | chess.Chess.BITS_QSIDE_CASTLE) ==
      0) {
    for (final target in enemies) {
      final previous = _attackers(before, target, by).toSet();
      final fresh = _attackers(
        after,
        target,
        by,
      ).where((a) => a != to && a != move.from && !previous.contains(a));
      final attacker = fresh
          .where((a) => _worthHitting(after, a, target, by, see))
          .firstOrNull;
      if (attacker == null) continue;
      out.add(
        Motif(
          'discovered',
          target == king
              ? '闪将：${_name(move.piece)}让开后，${name(attacker)}将军'
              : '闪击：${_name(move.piece)}让开后，${name(attacker)}攻击$victim${name(target)}',
          targets: target == king ? [] : [sq(target)],
        ),
      );
      break;
    }
  }

  List<String> guarded(_Pin pin) => enemies
      .where(
        (s) => s != king && _attackers(after, s, enemy).contains(pin.pinned),
      )
      .map(sq)
      .toList();
  final old = _pinsBy(
    before,
    by,
    see,
  ).map((p) => '${p.pinned}/${p.behind}').toSet();
  final pins = _pinsBy(after, by, see);
  bool escapes(_Pin pin, int attacker) =>
      (see.withFrom(after, pin.pinned, attacker, enemy) ?? -1) >= 0;
  final fresh = pins
      .where(
        (p) =>
            !old.contains('${p.pinned}/${p.behind}') && !escapes(p, p.pinner),
      )
      .firstOrNull;
  final hitPinned = pins
      .where(
        (p) =>
            _attackers(after, p.pinned, by).contains(to) &&
            !_attackers(before, p.pinned, by).contains(move.from) &&
            !escapes(p, to) &&
            !escapes(p, p.pinner) &&
            (_value(type) < _value(after.board[p.pinned]!.type) ||
                _worthHitting(after, to, p.pinned, by, see)),
      )
      .firstOrNull;
  if (fresh != null) {
    out.add(
      Motif(
        'pin',
        fresh.absolute
            ? '牵制$victim${name(fresh.pinned)}：它身后是王，不能走开'
            : '牵制$victim${name(fresh.pinned)}：它一走开，身后的${name(fresh.behind)}就会被吃',
        targets: [
          sq(fresh.pinned),
          if (fresh.absolute) ...guarded(fresh) else sq(fresh.behind),
        ],
      ),
    );
  } else if (hitPinned != null) {
    out.add(
      Motif(
        'pin',
        '攻击被牵制的$victim${name(hitPinned.pinned)}：它不能走开',
        targets: [sq(hitPinned.pinned), ...guarded(hitPinned)],
      ),
    );
  }

  for (final step in _directions[type.name] ?? <int>[]) {
    final hit = _ray(after, to, step);
    if (hit.length < 2) continue;
    final a = after.board[hit[0]]!;
    final b = after.board[hit[1]]!;
    if (a.color != enemy ||
        b.color != enemy ||
        _value(a.type) <= _value(b.type) ||
        ![chess.Chess.KING, chess.Chess.QUEEN].contains(a.type) ||
        _value(b.type) < 3) {
      continue;
    }
    if (a.type == chess.Chess.KING
        ? !check
        : (see.withFrom(after, to, hit[0], by) ?? 0) <= 0) {
      continue;
    }
    if ((see.withFrom(after, hit[0], to, enemy) ?? -1) >= 0) continue;
    // The rear target must be legally winnable after the front piece escapes.
    var exposed = false;
    for (final escape in _legal(after, hit[0])) {
      after.make_move(escape);
      final gain = after.board[to]?.color == by
          ? see.withFrom(after, to, hit[1], by)
          : null;
      after.undo_move();
      if ((gain ?? 0) > 0) {
        exposed = true;
        break;
      }
    }
    if (!exposed) continue;
    out.add(
      Motif(
        'skewer',
        '串击：$victim${_name(a.type)}被迫躲开后，身后的${_name(b.type)}会被吃',
        targets: (a.type == chess.Chess.KING ? [hit[1]] : hit).map(sq),
      ),
    );
    break;
  }

  if (move.captured != null) {
    final recapture = see.exchange(after, to);
    final net = _gain(move) - math.max(0, recapture ?? 0);
    if (_value(move.captured) > _value(move.piece) && net > 0) {
      out.add(
        Motif(
          'trade-up',
          '用${_name(move.piece)}吃$victim${_name(move.captured!)}，以小换大',
          immediate: true,
        ),
      );
    } else if (recapture == null) {
      final guards = _attackers(
        after,
        to,
        enemy,
      ).where((s) => after.board[s]!.type != chess.Chess.KING).toList();
      final pinned = guards
          .where((s) => _pinnedToKing(after, s, king, by))
          .firstOrNull;
      final checker = check
          ? out.indexWhere(
              (m) => m.kind == 'discovered' || m.kind == 'double-check',
            )
          : -1;
      final lost = '${_name(move.captured!)}白白丢掉';
      if (pinned != null) {
        out.add(
          Motif('pin', '$victim${name(pinned)}被牵制，不能回吃，$lost', immediate: true),
        );
      } else if (guards.isNotEmpty && checker >= 0) {
        final motif = out[checker];
        out[checker] = Motif(
          motif.kind,
          '${motif.text}，${victim.replaceFirst(RegExp(r'的$'), '')}正被将军，无法回吃，$lost',
          targets: motif.targets,
        );
      } else if (guards.isNotEmpty && check) {
        out.add(
          Motif(
            'free',
            '${victim.replaceFirst(RegExp(r'的$'), '')}正被将军，${name(guards.first)}无法回吃，$lost',
            immediate: true,
          ),
        );
      } else {
        out.add(
          Motif(
            'free',
            '免费吃掉$victim${_name(move.captured!)}（它没有保护）',
            immediate: true,
          ),
        );
      }
    }
    for (final target in enemies) {
      if (target == king ||
          after.board[target]!.type == chess.Chess.PAWN ||
          !_attackers(before, target, enemy).contains(to)) {
        continue;
      }
      if (_attackers(after, to, enemy).contains(target)) continue;
      if ((see.forSide(before, target, by) ?? 0) > 0 ||
          (see.forSide(after, target, by) ?? 0) <= 0) {
        continue;
      }
      out.add(
        Motif(
          'remove-defender',
          '吃掉保护者：$victim${_name(move.captured!)}原本保护着${name(target)}，现在${name(target)}保不住了',
          targets: [sq(target)],
        ),
      );
      break;
    }
  }

  if (!check) {
    for (final target in enemies) {
      final type = after.board[target]!.type;
      if (_value(type) < 3 ||
          type == chess.Chess.KING ||
          !_attackers(after, target, by).contains(to)) {
        continue;
      }
      if ((see.forSide(before, target, by) ?? 0) > 0 ||
          (see.forSide(after, target, by) ?? 0) <= 0 ||
          !_trapped(after, target, by, see)) {
        continue;
      }
      out.add(
        Motif(
          'trapped',
          '困住$victim${_name(type)}：它被攻击了，却无路可逃',
          targets: [sq(target)],
        ),
      );
      break;
    }
  }
  if (move.captured == null && !check && !after.in_stalemate) {
    final hypothetical = _withTurn(after, by);
    for (final threat in _legal(hypothetical)) {
      hypothetical.make_move(threat);
      final mate = hypothetical.in_checkmate;
      hypothetical.undo_move();
      if (mate) {
        out.add(
          Motif('mate-threat', '威胁下一步 ${hypothetical.move_to_san(threat)} 将杀'),
        );
        break;
      }
    }
  }
  if (move.promotion != null) {
    out.add(Motif('promote', '兵升变成${_name(move.promotion!)}'));
  }
  if (check && !mated) out.add(Motif('check', '将军'));
  out.sort(
    (a, b) => _priority.indexOf(a.kind).compareTo(_priority.indexOf(b.kind)),
  );
  return out;
}

/// Pieces of [color] that the opponent could legally capture for positive SEE.
/// Equal exchanges, illegal pinned captures and the king are excluded.
List<String> hangingPieces(String fen, String color) {
  return hangingMaterial(fen, color).keys.toList();
}

/// Positive opponent SEE per threatened piece, in pawn units (p=1,n/b=3,r=5,q=9).
/// Independent alternatives, not additive forced gains. The map excludes kings.
Map<String, int> hangingMaterial(String fen, String color) {
  try {
    final board = position(fen);
    final own = _color(color);
    final see = _See();
    final result = <String, int>{};
    for (final square in _squares(board, own)) {
      if (board.board[square]!.type == chess.Chess.KING) continue;
      final gain = see.forSide(board, square, _other(own)) ?? 0;
      if (gain > 0) result[chess.Chess.algebraic(square)] = gain;
    }
    return result;
  } on FormatException {
    return {};
  }
}

/// Threats BY [color]: immediate mate, profitable legal capture or safe promotion.
/// If it is the other side's turn, this means "if they ignore this threat";
/// en-passant rights are cleared on that hypothetical turn. Sorted mate first,
/// then by material gain and UCI. These are tactical candidates, not engine best.
List<String> threatMoves(String fen, String color) {
  try {
    final original = position(fen);
    if (original.game_over) return [];
    final board = _withTurn(original, _color(color));
    final see = _See();
    final threats = <({String uci, bool mate, int gain})>[];
    for (final move in _legal(board)) {
      board.make_move(move);
      final mate = board.in_checkmate;
      final gain = move.captured != null || move.promotion != null
          ? _gain(move) - math.max(0, see.exchange(board, move.to) ?? 0)
          : 0;
      board.undo_move();
      if (mate || gain > 0) {
        threats.add((uci: _uci(move), mate: mate, gain: gain.toInt()));
      }
    }
    threats.sort((a, b) {
      if (a.mate != b.mate) return a.mate ? -1 : 1;
      final gain = b.gain.compareTo(a.gain);
      return gain != 0 ? gain : a.uci.compareTo(b.uci);
    });
    return threats.map((t) => t.uci).toList();
  } on FormatException {
    return [];
  }
}

bool isSacrifice(String fen, String uci) {
  try {
    final before = position(fen);
    final after = _copy(before);
    final move = _find(after, uci);
    if (move == null) return false;
    after.make_move(move);
    if (after.in_checkmate) return false;
    final old = hangingPieces(fen, _colorId(move.color)).toSet();
    final see = _See();
    for (final square in _squares(after, move.color)) {
      final piece = after.board[square]!;
      if (piece.type == chess.Chess.KING ||
          _value(piece.type) < 3 ||
          (old.contains(chess.Chess.algebraic(square)) && square != move.to)) {
        continue;
      }
      if ((see.forSide(after, square, _other(move.color)) ?? 0) - _gain(move) >=
          2) {
        return true;
      }
    }
    return false;
  } on FormatException {
    return false;
  }
}

int _balance(chess.Chess board, chess.Color pov) {
  var sum = 0;
  for (final color in [pov, _other(pov)]) {
    for (final square in _squares(board, color)) {
      final type = board.board[square]!.type;
      if (type != chess.Chess.KING) {
        sum += (color == pov ? 1 : -1) * _value(type);
      }
    }
  }
  return sum;
}

/// Stop after a settled exchange rather than at an arbitrary mid-capture ply.
int pvMaterialSwing(String fen, List<String> pv, {int maxPly = 8}) {
  try {
    final board = position(fen);
    final side = board.turn;
    final base = _balance(board, side);
    var capturing = false;
    for (var i = 0; i < pv.length && (i < maxPly || capturing); i++) {
      final move = _find(board, pv[i]);
      if (move == null) break;
      capturing = move.captured != null;
      board.make_move(move);
    }
    return _balance(board, side) - base;
  } on FormatException {
    return 0;
  }
}

bool _wonTarget(chess.Chess board, List<String> line, List<String> targets) {
  final side = board.turn;
  final tracked = targets.toSet();
  for (final uci in line.take(8)) {
    final move = _find(board, uci);
    if (move == null) break;
    final capturedSquare = chess.Chess.algebraic(_capturedSquare(move));
    if (move.color == side &&
        move.captured != null &&
        tracked.contains(capturedSquare)) {
      return true;
    }
    if (move.color != side && tracked.remove(move.fromAlgebraic)) {
      tracked.add(move.toAlgebraic);
    }
    board.make_move(move);
  }
  return false;
}

List<Motif> confirmedMotifs(
  String fen,
  List<String> line, {
  String victim = '对方的',
  bool mates = false,
  int owed = 0,
}) {
  if (line.isEmpty) return [];
  final motifs = detectMotifs(fen, line.first, victim: victim);
  final gain = pvMaterialSwing(fen, line) - owed;
  return motifs.where((motif) {
    if (_factual.contains(motif.kind)) return true;
    final capture = motif.immediate || _weak.contains(motif.kind);
    if (line.length < 2 && !capture) return false;
    if (mates && !capture) return true;
    if (gain < 1) return false;
    return motif.targets.isEmpty ||
        _wonTarget(position(fen), line, motif.targets);
  }).toList();
}

Tactic? firstTactic(
  String fen,
  List<String> line, {
  String victim = '对方的',
  bool mates = false,
  Set<String> kinds = _tactical,
  int maxPly = 4,
  int owed = 0,
}) {
  try {
    final board = position(fen);
    Tactic? fallback;
    for (var i = 0; i < line.length && i <= maxPly; i += 2) {
      final motifs = confirmedMotifs(
        board.fen,
        line.sublist(i),
        victim: victim,
        mates: mates,
        owed: i == 0 ? owed : 0,
      );
      final motif = motifs
          .where((m) => (i == 0 ? kinds : _followUp).contains(m.kind))
          .firstOrNull;
      if (motif != null) {
        final move = _find(board, line[i]);
        final tactic = Tactic(
          motif,
          i,
          i == 0 || move == null ? null : board.move_to_san(move),
        );
        if (!_weak.contains(motif.kind)) return tactic;
        fallback ??= tactic;
      }
      final own = _find(board, line[i]);
      if (own == null) break;
      board.make_move(own);
      if (i + 1 < line.length) {
        final reply = _find(board, line[i + 1]);
        if (reply == null) break;
        board.make_move(reply);
      }
    }
    return fallback;
  } on FormatException {
    return null;
  }
}

String materialWords(num points) => points >= 9
    ? '大约一个后'
    : points >= 5
    ? '大约一个车'
    : points >= 3
    ? '大约一个马或象'
    : points >= 2
    ? '大约两个兵'
    : '大约一个兵';

String _plainEval(
  num? cp,
  int? mate, {
  bool reverse = false,
  String me = '你',
  String opp = '对手',
}) {
  if (mate != null) {
    if (mate == 0) return '';
    final who = (mate > 0) != reverse ? me : opp;
    return '$who能在 ${mate.abs()} 步内将杀';
  }
  final value = (reverse ? -1 : 1) * (cp ?? 0) / 100;
  final who = value > 0 ? me : opp;
  final a = value.abs();
  if (a < 0.3) return '双方大致均势';
  if (a < 0.8) return '$who稍好一点';
  if (a < 1.6) return '$who大约多一个兵的优势';
  if (a < 2.6) return '$who明显占优（约多两个兵）';
  if (a < 4.5) return '$who大优（约相当于多一个马或象）';
  if (a < 7) return '$who胜势（约相当于多一个车）';
  return '$who几乎必胜';
}

/// [pv] starts with the opponent's reply AFTER [played]. [bestPv] starts with
/// [best] from [fen]. cp/mate scores use each line's side-to-move POV, as UCI.
/// Incomplete/illegal PV tails stop at their last legal move. Without a line,
/// only immediately demonstrable losses are claimed; other reasons say unknown.
/// [bad] can be false to obtain web-style praise for a confirmed good tactic.
MistakeExplanation explainMistake(
  String fen,
  String played,
  String? best, {
  List<String> pv = const [],
  List<String> bestPv = const [],
  num? replyCp,
  num? bestCp,
  int? replyMate,
  int? bestMate,
  bool bad = true,
  String me = '你',
  String opp = '对手',
}) {
  try {
    return _explain(
      position(fen),
      played,
      best,
      pv,
      bestPv,
      replyCp,
      bestCp,
      replyMate,
      bestMate,
      bad,
      me,
      opp,
    );
  } on FormatException {
    return MistakeExplanation(
      tag: 'other',
      tagLabel: '其他',
      problem: ['局面无效，无法进行战术讲解。'],
    );
  }
}

List<String> _validLine(chess.Chess board, List<String> line) {
  final valid = <String>[];
  for (final uci in line) {
    final move = _find(board, uci);
    if (move == null) break;
    valid.add(uci);
    board.make_move(move);
  }
  return valid;
}

bool _mates(chess.Chess board, List<String> line, chess.Color winner) {
  _validLine(board, line);
  return board.in_checkmate && board.turn != winner;
}

MistakeExplanation _explain(
  chess.Chess before,
  String played,
  String? best,
  List<String> rawPv,
  List<String> rawBestPv,
  num? replyCp,
  num? bestCp,
  int? replyMate,
  int? bestMate,
  bool bad,
  String me,
  String opp,
) {
  final move = _find(before, played);
  if (move == null) {
    return MistakeExplanation(
      tag: 'other',
      tagLabel: '其他',
      problem: ['该着法不合法，无法进行战术讲解。'],
    );
  }
  final after = _copy(before)..make_move(move);
  final fen = before.fen;
  final afterFen = after.fen;
  final pv = _validLine(_copy(after), rawPv);
  final bestMove = best == null ? null : _find(before, best);
  final bestLine = bestMove == null
      ? <String>[]
      : _validLine(
          _copy(before),
          rawBestPv.isNotEmpty && rawBestPv.first == best ? rawBestPv : [best!],
        );
  final reply = pv.isEmpty ? null : _find(after, pv.first);
  final replySan = reply == null ? null : after.move_to_san(reply);
  final bestSan = bestMove == null ? null : before.move_to_san(bestMove);
  final problem = <String>[];
  final better = <String>[];
  final problemKinds = _priority
      .where(
        (kind) =>
            kind != 'check' &&
            (move.captured == null ||
                reply?.to != move.to ||
                !_weak.contains(kind)),
      )
      .toSet();
  final allowsMate =
      (replyMate != null && replyMate > 0) ||
      _mates(_copy(after), pv, _other(move.color));
  final missedMate =
      bestMove != null &&
      best != played &&
      ((bestMate != null && bestMate > 0) ||
          _mates(_copy(before), bestLine, move.color));
  final tactic = pv.isEmpty
      ? null
      : firstTactic(
          afterFen,
          pv,
          victim: '$me的',
          kinds: problemKinds,
          owed: _gain(move),
        );
  final opportunity = bestMove == null || best == played
      ? null
      : firstTactic(fen, bestLine, victim: '$opp的');
  final lost = -pvMaterialSwing(fen, [played, ...pv]);
  final exposed =
      (_See().forSide(after, move.to, _other(move.color)) ?? 0) - _gain(move) >
      0;
  String tag = 'positional';
  String tagLabel = '局面判断失误';
  if (allowsMate) {
    tag = 'allow-mate';
    tagLabel = '没看到对方的杀棋';
  } else if (missedMate) {
    tag = 'miss-mate';
    tagLabel = '错过将杀';
  } else if (tactic != null && _weak.contains(tactic.motif.kind)) {
    tag = 'hanging';
    tagLabel = '丢子（没保护好棋子）';
  } else if (tactic != null && motifLabels.containsKey(tactic.motif.kind)) {
    tag = 'allow-${tactic.motif.kind}';
    tagLabel = '被对方${motifLabels[tactic.motif.kind]}';
  } else if (opportunity != null && _weak.contains(opportunity.motif.kind)) {
    tag = 'miss-material';
    tagLabel = '没吃到对方送的子';
  } else if (opportunity != null && opportunity.motif.kind != 'mate') {
    tag = 'miss-${opportunity.motif.kind}';
    tagLabel = '错过${motifLabels[opportunity.motif.kind]}';
  } else if (exposed || lost >= 2) {
    tag = 'hanging';
    tagLabel = '丢子（没保护好棋子）';
  }

  if (!bad && !allowsMate) {
    final line = [played, ...pv];
    final tactic = firstTactic(
      fen,
      line,
      victim: '$opp的',
      mates: _mates(_copy(before), line, move.color),
    );
    String? praise;
    if (tactic != null) {
      final motif = tactic.motif;
      praise = tactic.ply > 0
          ? '妙着！这步为后面铺路：接着 ${tactic.san}，${motif.text}'
          : motif.kind == 'mate'
          ? '漂亮，直接将杀！'
          : _weak.contains(motif.kind)
          ? '好棋！${motif.text}'
          : '妙着！${motif.text}';
    } else if (best == played &&
        (pv.isNotEmpty || replyCp != null || replyMate != null)) {
      final gain = pvMaterialSwing(fen, line);
      if (gain >= 2) {
        praise = '好棋！照这样下去$me能赢得${materialWords(gain)}';
      } else if (replyMate != null
          ? replyMate < 0
          : replyCp != null && -replyCp >= -60) {
        praise =
            '引擎认可的好棋。按主变，${_plainEval(replyCp, replyMate, reverse: true, me: me, opp: opp)}';
      }
    }
    return MistakeExplanation(tag: tag, tagLabel: tagLabel, praise: praise);
  }

  if (allowsMate) {
    problem.add(
      replyMate != null && replyMate > 0
          ? '$opp有 $replyMate 步杀${replySan == null ? '' : '，从 $replySan 开始'}'
          : '$opp可以${replySan == null ? '' : '从 $replySan 开始'}，沿主变将杀',
    );
  } else if (replySan != null) {
    if (tactic == null) {
      final evaluated = (replyCp?.abs() ?? 0) >= 60 || replyMate != null
          ? _plainEval(replyCp, replyMate, reverse: true, me: me, opp: opp)
          : '';
      problem.add(
        '$opp的最佳应对是 $replySan${evaluated.isEmpty ? '' : '；照主变发展，$evaluated'}',
      );
    } else {
      problem.add(
        tactic.ply == 0
            ? '$opp可以走 $replySan：${tactic.motif.text}'
            : '$opp可以走 $replySan，接着 ${tactic.san}：${tactic.motif.text}',
      );
    }
    if (lost >= 1) problem.add('照这样走下去，$me会丢掉${materialWords(lost)}');
  } else if (bad) {
    if (exposed) {
      problem.add(
        '$me刚走的${_name(move.promotion ?? move.piece)}在 ${move.toAlgebraic} 没有足够的保护，对方可以净得子力。',
      );
    }
    problem.add('$opp的后续变化数据不足，暂时无法可靠确认这步棋具体输在哪里。');
  }

  if (bestMove != null && best != played) {
    if (rawBestPv.isEmpty && bestCp == null && bestMate == null) {
      better.add('Stockfish 建议尝试 $bestSan，但当前没有足够的主变数据说明它具体好在哪里。');
    } else if (missedMate) {
      better.add(
        bestMate != null && bestMate > 0 ? '$bestMate 步杀' : '沿最佳主变可以将杀',
      );
    } else {
      final motifs = confirmedMotifs(
        fen,
        bestLine,
        victim: '$opp的',
      ).take(2).toList();
      better.addAll(motifs.map((m) => m.text));
      if (!motifs.any((m) => _tactical.contains(m.kind))) {
        final next = firstTactic(fen, bestLine, victim: '$opp的', kinds: {});
        if (next != null) better.add('接着 ${next.san}：${next.motif.text}');
      }
      final gain = pvMaterialSwing(fen, bestLine);
      if (gain >= 1) better.add('能赢得${materialWords(gain)}');
      if (better.isEmpty) {
        better.add(
          bestCp != null || bestMate != null
              ? '引擎主变评估：${_plainEval(bestCp, bestMate, me: me, opp: opp)}'
              : 'Stockfish 在当前分析深度下更倾向这步棋',
        );
      }
    }
  } else if (bad && bestMove == null) {
    better.add('当前分析没有可靠的最佳着法，建议加深 Stockfish 分析后再比较。');
  }
  return MistakeExplanation(
    tag: tag,
    tagLabel: tagLabel,
    problem: problem,
    better: better,
  );
}
