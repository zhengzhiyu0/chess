import 'dart:convert';
import 'dart:math' as math;

import 'package:flutter/services.dart';

import 'chess.dart';
import 'rating.dart' show jsRound;

const themeLabels = {
  'fork': '捉双',
  'pin': '牵制',
  'skewer': '串击',
  'discoveredAttack': '闪击',
  'doubleCheck': '双将',
  'hangingPiece': '白吃子',
  'trappedPiece': '困子',
  'capturingDefender': '吃掉保护者',
  'deflection': '引离',
  'attraction': '引入',
  'sacrifice': '弃子',
  'backRankMate': '底线杀',
  'smotheredMate': '闷杀',
  'mateIn1': '一步杀',
  'mateIn2': '两步杀',
  'mateIn3': '三步杀',
  'mate': '将杀',
  'promotion': '升变',
  'quietMove': '安静着',
  'xRayAttack': 'X 光',
  'clearance': '腾挪',
  'interference': '拦截',
  'intermezzo': '中间着',
  'defensiveMove': '防守',
  'endgame': '残局',
  'opening': '开局',
  'middlegame': '中局',
};

Map<String, dynamic> defaultProgress() => {
  'rating': 1200,
  'games': 0,
  'recent': <String>[],
  'solved': 0,
  'failed': 0,
  'byTheme': <String, dynamic>{},
};

Map<String, dynamic> sanitizeProgress(dynamic raw) {
  final out = defaultProgress();
  if (raw is! Map) return out;
  // Keep fields introduced by newer or older app versions.
  out.addAll(Map<String, dynamic>.from(raw));
  final rating = raw['rating'];
  out['rating'] = rating is num && rating.isFinite
      ? rating.clamp(400, 3000)
      : 1200;
  for (final key in ['games', 'solved', 'failed']) {
    final value = raw[key];
    out[key] = value is num && value.isFinite ? math.max(0, value) : 0;
  }
  final recent = raw['recent'];
  final ids = recent is List
      ? recent.whereType<String>().where((s) => s.length < 16).toList()
      : <String>[];
  out['recent'] = ids.skip(math.max(0, ids.length - 500)).toList();
  final themes = <String, dynamic>{};
  if (raw['byTheme'] is Map) {
    for (final entry in (raw['byTheme'] as Map).entries) {
      final value = entry.value;
      if (entry.key is String &&
          value is List &&
          value.length == 2 &&
          value.every((n) => n is num && n.isFinite && n >= 0)) {
        themes[entry.key as String] = List<num>.from(value);
      }
    }
  }
  out['byTheme'] = themes;
  return out;
}

Map<String, dynamic> mergeProgress(Map a, Map b) {
  final first = sanitizeProgress(a);
  final second = sanitizeProgress(b);
  final incomingWins = (second['games'] as num) > (first['games'] as num);
  final out = <String, dynamic>{
    ...second,
    ...first,
    ...(incomingWins ? second : first),
  };
  final recent = <String>{
    ...List<String>.from(first['recent'] as List),
    ...List<String>.from(second['recent'] as List),
  }.toList();
  out['recent'] = recent.skip(math.max(0, recent.length - 500)).toList();
  return out;
}

class Puzzle {
  final String id;
  final String fen;

  /// First move is the opponent's setup move, then player/opponent alternate.
  final List<String> moves;
  final int rating;
  final List<String> themes;
  const Puzzle({
    required this.id,
    required this.fen,
    required this.moves,
    required this.rating,
    required this.themes,
  });

  factory Puzzle.fromJson(Map raw) => Puzzle(
    id: raw['id'] as String,
    fen: raw['fen'] as String,
    moves: List<String>.from(raw['moves'] as List),
    rating: (raw['rating'] as num).toInt(),
    themes: List<String>.from(raw['themes'] as List? ?? []),
  );
}

List<Puzzle> parsePuzzles(String text) {
  final puzzles = <Puzzle>[];
  for (final line in const LineSplitter().convert(text)) {
    final fields = line.split(',');
    if (fields.length < 5) continue;
    final rating = int.tryParse(fields[3]);
    if (rating == null) continue;
    final moves = fields[2].trim().split(RegExp(r'\s+'));
    if (fields[0].isEmpty ||
        moves.length < 2 ||
        !moves.every(uciPattern.hasMatch)) {
      continue;
    }
    puzzles.add(
      Puzzle(
        id: fields[0],
        fen: fields[1],
        moves: moves,
        rating: rating,
        themes: fields[4].trim().isEmpty
            ? []
            : fields[4].trim().split(RegExp(r'\s+')),
      ),
    );
  }
  return puzzles;
}

class PuzzleService {
  final AssetBundle _assets;
  final double Function() _random;
  Future<Map<String, dynamic>>? _index;
  final Map<String, Future<List<Puzzle>>> _bands = {};

  PuzzleService({AssetBundle? assets, double Function()? random})
    : _assets = assets ?? rootBundle,
      _random = random ?? math.Random().nextDouble;

  Future<Map<String, dynamic>> loadIndex() => _index ??= _loadIndex();
  Future<Map<String, dynamic>> _loadIndex() async {
    try {
      final decoded = jsonDecode(
        await _assets.loadString('assets/puzzles/index.json', cache: false),
      );
      if (decoded is! Map || decoded['bands'] is! List) {
        throw const FormatException('题库索引损坏');
      }
      return Map<String, dynamic>.from(decoded);
    } catch (_) {
      _index = null;
      rethrow;
    }
  }

  Future<List<Puzzle>> _loadBand(String file) =>
      _bands.putIfAbsent(file, () async {
        try {
          if (!RegExp(r'^[\w-]+\.(csv|json)$').hasMatch(file)) {
            throw const FormatException('题库文件名无效');
          }
          final text = await _assets.loadString(
            'assets/puzzles/$file',
            cache: false,
          );
          if (file.endsWith('.json')) {
            return (jsonDecode(text) as List)
                .map((p) => Puzzle.fromJson(p as Map))
                .toList();
          }
          return parsePuzzles(text);
        } catch (_) {
          _bands.remove(file);
          rethrow;
        }
      });

  Future<Puzzle?> nextPuzzle(Map progress, {String? theme}) async {
    final index = await loadIndex();
    final p = sanitizeProgress(progress);
    final seen = Set<String>.from(p['recent'] as List);
    final target = (p['rating'] as num) + (_random() - 0.5) * 200;
    final bands = (index['bands'] as List)
        .map((b) => Map<String, dynamic>.from(b as Map))
        .toList();
    double distance(Map b) =>
        (((b['lo'] as num) + (b['hi'] as num)) / 2 - target).abs();
    bands.sort((a, b) => distance(a).compareTo(distance(b)));
    for (final band in bands) {
      final puzzles = (await _loadBand(band['file'] as String))
          .where(
            (p) =>
                !seen.contains(p.id) &&
                (theme == null || theme.isEmpty || p.themes.contains(theme)),
          )
          .toList();
      if (puzzles.isEmpty) continue;
      puzzles.sort(
        (a, b) =>
            (a.rating - target).abs().compareTo((b.rating - target).abs()),
      );
      final index = (_random() * math.min(20, puzzles.length)).floor().clamp(
        0,
        puzzles.length - 1,
      );
      return puzzles[index];
    }
    return null;
  }

  int recordPuzzle(Map progress, Puzzle puzzle, bool solved) =>
      _recordPuzzle(progress, puzzle, solved);
  bool acceptsMove(String fen, String uci, String expected) =>
      _acceptsMove(fen, uci, expected);
}

int puzzleDelta(num rating, num puzzle, bool solved, num games) {
  final k = games < 10
      ? 60
      : games < 30
      ? 35
      : 20;
  final expected = 1 / (1 + math.pow(10, (puzzle - rating) / 400));
  return jsRound(k * ((solved ? 1 : 0) - expected));
}

int recordPuzzle(Map progress, Puzzle puzzle, bool solved) =>
    _recordPuzzle(progress, puzzle, solved);
int _recordPuzzle(Map progress, Puzzle puzzle, bool solved) {
  final p = sanitizeProgress(progress);
  final delta = puzzleDelta(
    p['rating'] as num,
    puzzle.rating,
    solved,
    p['games'] as num,
  );
  p['rating'] = ((p['rating'] as num) + delta).clamp(400, 3000);
  p['games'] = (p['games'] as num) + 1;
  final field = solved ? 'solved' : 'failed';
  p[field] = (p[field] as num) + 1;
  final recent = List<String>.from(p['recent'] as List)
    ..removeWhere((id) => id == puzzle.id);
  recent.add(puzzle.id);
  p['recent'] = recent.skip(math.max(0, recent.length - 500)).toList();
  final themes = p['byTheme'] as Map;
  for (final theme in puzzle.themes) {
    if (!themeLabels.containsKey(theme)) continue;
    final counts = List<num>.from(themes[theme] as List? ?? [0, 0]);
    counts[solved ? 0 : 1]++;
    themes[theme] = counts;
  }
  progress.addAll(p);
  return delta;
}

bool acceptsMove(String fen, String uci, String expected) =>
    _acceptsMove(fen, uci, expected);
bool _acceptsMove(String fen, String uci, String expected) {
  try {
    final game = position(fen);
    if (!playUci(game, uci)) return false;
    return uci == expected || game.in_checkmate;
  } on FormatException {
    return false;
  }
}
