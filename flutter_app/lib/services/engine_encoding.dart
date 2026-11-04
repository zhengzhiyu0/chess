import 'dart:convert';
import 'dart:math';
import 'dart:typed_data';

import 'package:chess/chess.dart' as chess;

import '../core/chess.dart' as domain;
import 'engine_types.dart';

const maiaHistory = 8;
const maiaPlanes = 12;
const maiaFeatures = maiaHistory * maiaPlanes;
const maiaMoveCount = 4352;
const maiaStartFen = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
const maiaProbeLegal = [
  'a2a3',
  'a2a4',
  'b2b3',
  'b2b4',
  'c2c3',
  'c2c4',
  'd2d3',
  'd2d4',
  'e2e3',
  'e2e4',
  'f2f3',
  'f2f4',
  'g2g3',
  'g2g4',
  'h2h3',
  'h2h4',
  'b1a3',
  'b1c3',
  'g1f3',
  'g1h3',
];
const maiaProbeTop = ['e2e4', 'd2d4', 'c2c4', 'g1f3'];
final _uci = RegExp(r'^[a-h][1-8][a-h][1-8][qrbn]?$');

chess.Chess enginePosition(String fen) {
  return domain.position(fen);
}

String mirrorMaiaUci(String uci) {
  if (!_uci.hasMatch(uci)) throw FormatException('无效的 UCI 走子', uci);
  return '${uci[0]}${9 - int.parse(uci[1])}${uci[2]}${9 - int.parse(uci[3])}${uci.substring(4)}';
}

int maiaUciIndex(String uci) {
  if (!_uci.hasMatch(uci)) throw FormatException('无效的 UCI 走子', uci);
  if (uci.length == 5) {
    return 4096 +
        (uci.codeUnitAt(0) - 97) * 32 +
        (uci.codeUnitAt(2) - 97) * 4 +
        'qrbn'.indexOf(uci[4]);
  }
  final from = (uci.codeUnitAt(1) - 49) * 8 + uci.codeUnitAt(0) - 97;
  final to = (uci.codeUnitAt(3) - 49) * 8 + uci.codeUnitAt(2) - 97;
  return from * 64 + to;
}

Float32List tokenizeMaiaFen(String fen) {
  final parts = fen.split(RegExp(r'\s+'));
  if (parts.length < 2 || !const ['w', 'b'].contains(parts[1])) {
    throw FormatException('无效的 FEN', fen);
  }
  final rows = parts[0].split('/');
  if (rows.length != 8) throw FormatException('无效的 FEN 棋盘', fen);
  final out = Float32List(64 * maiaPlanes);
  final flip = parts[1] == 'b';
  for (var row = 0; row < 8; row++) {
    var file = 0;
    for (final code in rows[row].codeUnits) {
      if (code >= 49 && code <= 56) {
        file += code - 48;
        continue;
      }
      final piece = String.fromCharCode(code);
      final type = 'pnbrqk'.indexOf(piece.toLowerCase());
      if (type < 0 || file >= 8) throw FormatException('无效的 FEN 棋盘', fen);
      final white = piece != piece.toLowerCase();
      final black = flip ? white : !white;
      final square = (flip ? row : 7 - row) * 8 + file;
      out[square * maiaPlanes + type + (black ? 6 : 0)] = 1;
      file++;
    }
    if (file != 8) throw FormatException('无效的 FEN 棋盘', fen);
  }
  return out;
}

/// Ported bit-for-bit from web/src/maia/encode.ts. Production predict() passes
/// [fen] only, so all eight history slots repeat the current position.
Float32List buildMaiaTokens(List<String> fens) {
  if (fens.isEmpty) throw ArgumentError('FEN 历史不能为空');
  final recent = fens.length > maiaHistory
      ? fens.sublist(fens.length - maiaHistory)
      : fens;
  final sequence = [
    ...List.filled(maiaHistory - recent.length, recent.first),
    ...recent,
  ];
  final out = Float32List(64 * maiaFeatures);
  for (var history = 0; history < maiaHistory; history++) {
    final token = tokenizeMaiaFen(sequence[history]);
    for (var square = 0; square < 64; square++) {
      for (var plane = 0; plane < maiaPlanes; plane++) {
        out[square * maiaFeatures + history * maiaPlanes + plane] =
            token[square * maiaPlanes + plane];
      }
    }
  }
  return out;
}

String maiaTokensBase64(List<String> fens) {
  final tokens = buildMaiaTokens(fens);
  // The native CoreML plugin reads little-endian float32 bytes explicitly.
  final bytes = ByteData(tokens.length * 4);
  for (var i = 0; i < tokens.length; i++) {
    bytes.setFloat32(i * 4, tokens[i], Endian.little);
  }
  return base64Encode(bytes.buffer.asUint8List());
}

class MaiaLegalMove {
  final String uci;
  final int index;
  const MaiaLegalMove(this.uci, this.index);
}

List<MaiaLegalMove> maiaLegalMoves(chess.Chess position) {
  final black = position.turn == chess.Color.BLACK;
  return position
      .generate_moves()
      .map((move) {
        final promotion = move.promotion?.name ?? '';
        final uci = '${move.fromAlgebraic}${move.toAlgebraic}$promotion';
        return MaiaLegalMove(
          uci,
          maiaUciIndex(black ? mirrorMaiaUci(uci) : uci),
        );
      })
      .toList(growable: false);
}

List<double> maiaWdlFromValue(List<dynamic> values) {
  if (values.length != 3) {
    throw const FormatException('Maia value head 须为 3 个 logit');
  }
  final logits = values.map((v) => engineNumber(v, 'value')).toList();
  final maximum = logits.reduce(max);
  final weights = logits.map((v) => exp(v - maximum)).toList();
  final total = weights.reduce((a, b) => a + b);
  return [weights[2] / total, weights[1] / total, weights[0] / total];
}

MaiaPrediction decodeNativeMaia(
  Map<String, dynamic> result,
  List<MaiaLegalMove> legal,
) {
  final raw = result['logits'];
  if (raw is! List || raw.length != legal.length) {
    throw const FormatException('Maia logits 与合法走子数量不一致');
  }
  final logits = raw.map((v) => engineNumber(v, 'logit')).toList();
  final maximum = logits.reduce(max);
  final weights = logits.map((v) => exp(v - maximum)).toList();
  final total = weights.reduce((a, b) => a + b);
  final moves = List.generate(
    legal.length,
    (i) =>
        ScoredMove(uci: legal[i].uci, logit: logits[i], p: weights[i] / total),
  )..sort((a, b) => b.p.compareTo(a.p));
  return MaiaPrediction(
    moves: moves,
    wdl: maiaWdlFromValue(result['value'] as List),
    ms: engineNumber(result['ms'], 'ms'),
  );
}

/// Preserve repetition history for UCI while rejecting accidental double replay.
String engineSearchPosition(String fen, String? startFen, List<String> moves) {
  final target = enginePosition(fen);
  if (moves.isNotEmpty && startFen == null) {
    throw ArgumentError('提供 moves 时必须同时提供 startFen');
  }
  final start = startFen ?? fen;
  final replay = enginePosition(start);
  for (final uci in moves) {
    if (!_uci.hasMatch(uci) ||
        !replay.move({
          'from': uci.substring(0, 2),
          'to': uci.substring(2, 4),
          if (uci.length == 5) 'promotion': uci[4],
        })) {
      throw FormatException('历史中存在非法走子', uci);
    }
  }
  if (domain.fenOf(replay) != domain.fenOf(target)) {
    throw ArgumentError('startFen + moves 与待分析 FEN 不一致');
  }
  return 'position fen $start${moves.isEmpty ? '' : ' moves ${moves.join(' ')}'}';
}
