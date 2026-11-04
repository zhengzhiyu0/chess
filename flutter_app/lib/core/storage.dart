import 'dart:convert';
import 'dart:math' as math;

import 'package:flutter/foundation.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'chess.dart';
import 'game.dart';
import 'settings.dart';
import 'training.dart';

const backupFormat = 'maia-coach-backup';
const backupVersion = 1;
const _cacheKey = 'maia-coach.flutter.domain.v1';
const _legacyKeys = {
  'settings': 'maia-coach.settings',
  'history': 'maia-coach.history',
  'mistakes': 'maia-coach.mistakes',
  'puzzles': 'maia-coach.puzzles',
  'deletedMistakes': 'maia-coach.mistakes-deleted',
  'currentGame': 'maia-coach.game',
};
const _dayMs = 86400000;
const _intervals = [0, 1, 3, 7];

dynamic _clone(dynamic value) => jsonDecode(jsonEncode(value));
Map<String, dynamic> _copyMap(Map value) =>
    Map<String, dynamic>.from(_clone(value) as Map);

List<String> sanitizeDeleted(dynamic raw) {
  if (raw is! List) return [];
  final seen = <String>{};
  final recent = <String>[];
  for (final value in raw.reversed) {
    if (value is String && value.length < 300 && seen.add(value)) {
      recent.add(value);
    }
    if (recent.length == 2000) break;
  }
  return recent.reversed.toList();
}

Map<String, dynamic>? sanitizeMistake(dynamic raw) {
  if (raw is! Map) return null;
  for (final key in [
    'id',
    'gameId',
    'fen',
    'played',
    'playedSan',
    'best',
    'tag',
    'tagLabel',
  ]) {
    if (raw[key] is! String || (raw[key] as String).length >= 300) return null;
  }
  if (!uciPattern.hasMatch(raw['best'] as String) ||
      !uciPattern.hasMatch(raw['played'] as String) ||
      !{'mistake', 'miss', 'blunder'}.contains(raw['judgement'])) {
    return null;
  }
  for (final key in ['date', 'drop', 'streak', 'due', 'tries', 'solved']) {
    if (raw[key] is! num || !(raw[key] as num).isFinite) return null;
  }
  for (final key in ['streak', 'tries', 'solved']) {
    final value = raw[key] as num;
    if (value < 0 || value != value.truncateToDouble()) return null;
  }
  final line = raw['line'];
  if (line is! List ||
      !line.every((u) => u is String && uciPattern.hasMatch(u))) {
    return null;
  }
  try {
    final best = position(raw['fen'] as String);
    final played = position(raw['fen'] as String);
    if (!playUci(best, raw['best'] as String) ||
        !playUci(played, raw['played'] as String)) {
      return null;
    }
  } on FormatException {
    return null;
  }
  final out = _copyMap(raw);
  out['line'] = line.take(12).toList();
  if (out['mastered'] != true) out.remove('mastered');
  return out;
}

List<Map<String, dynamic>> mergeMistakes(
  List<Map<String, dynamic>> a,
  List<Map<String, dynamic>> b,
) {
  final byId = <String, Map<String, dynamic>>{};
  for (final mistake in [...a, ...b]) {
    final current = byId[mistake['id']];
    if (current == null) {
      byId[mistake['id'] as String] = mistake;
    } else if ((mistake['tries'] as num) > (current['tries'] as num)) {
      byId[mistake['id'] as String] = {...current, ...mistake};
    } else {
      // The most-trained entry owns conflicts; union additional backup fields.
      byId[mistake['id'] as String] = {...mistake, ...current};
    }
  }
  final result = byId.values.toList()
    ..sort((x, y) => (y['date'] as num).compareTo(x['date'] as num));
  return result.take(1000).toList();
}

List<Map<String, dynamic>> _normalizeHistory(List<Map<String, dynamic>> games) {
  final ordered = List<Map<String, dynamic>>.from(games)
    ..sort((a, b) => (b['date'] as num).compareTo(a['date'] as num));
  final seen = <String>{};
  return ordered.where((g) => seen.add(g['id'] as String)).take(300).toList();
}

class _BackupData {
  final AppSettings settings;
  final List<Map<String, dynamic>> history;
  final List<Map<String, dynamic>> mistakes;
  final Map<String, dynamic> puzzles;
  final List<String> deleted;
  final Map<String, dynamic> extra;
  const _BackupData(
    this.settings,
    this.history,
    this.mistakes,
    this.puzzles,
    this.deleted,
    this.extra,
  );

  Map<String, dynamic> toJson() => {
    ...extra,
    'settings': settings.toJson(),
    'history': history,
    'mistakes': mistakes,
    'puzzles': puzzles,
    'deletedMistakes': deleted,
  };
}

_BackupData _normalize(_BackupData data) {
  final deleted = sanitizeDeleted(data.deleted);
  final gone = deleted.toSet();
  return _BackupData(
    data.settings,
    _normalizeHistory(data.history),
    mergeMistakes(
      [],
      data.mistakes.where((m) => !gone.contains(m['id'])).toList(),
    ),
    sanitizeProgress(data.puzzles),
    deleted,
    data.extra,
  );
}

({Map<String, dynamic> data, int skipped}) parseBackup(String text) {
  dynamic raw;
  try {
    raw = jsonDecode(text);
  } on FormatException {
    throw const FormatException('不是有效的备份文件（JSON 解析失败）');
  }
  if (raw is! Map || raw['format'] != backupFormat) {
    throw const FormatException('不是 Maia Coach 的备份文件');
  }
  if (raw['version'] != backupVersion) {
    throw const FormatException('不支持的备份版本，请先更新应用');
  }
  var skipped = 0;
  List<Map<String, dynamic>> list(dynamic source, {bool game = false}) {
    if (source is! List) return [];
    final out = <Map<String, dynamic>>[];
    for (final item in source) {
      Map<String, dynamic>? parsed;
      if (game && item is Map) {
        try {
          parsed = StoredGame.fromJson(item).toJson();
        } on FormatException {
          parsed = null;
        }
      } else if (!game) {
        parsed = sanitizeMistake(item);
      }
      if (parsed == null) {
        skipped++;
      } else {
        out.add(parsed);
      }
    }
    return out;
  }

  final extra = Map<String, dynamic>.from(raw)
    ..removeWhere(
      (key, _) => {
        'format',
        'version',
        'exported',
        'app',
        'settings',
        'history',
        'mistakes',
        'puzzles',
        'deletedMistakes',
        'currentGame',
      }.contains(key),
    );
  final data = _normalize(
    _BackupData(
      AppSettings.fromJson(
        raw['settings'] is Map ? raw['settings'] as Map : {},
      ),
      list(raw['history'], game: true),
      list(raw['mistakes']),
      sanitizeProgress(raw['puzzles']),
      sanitizeDeleted(raw['deletedMistakes']),
      extra,
    ),
  );
  return (data: data.toJson(), skipped: skipped);
}

/// One JSON cache provides atomic logical saves across the six legacy domains.
/// A failed/corrupt load never enables save, so it cannot overwrite old data.
class AppRepository extends ChangeNotifier {
  AppSettings settings = AppSettings.defaults();
  List<Map<String, dynamic>> history = [];
  List<Map<String, dynamic>> mistakes = [];
  Map<String, dynamic> puzzles = defaultProgress();
  List<String> deletedMistakes = [];
  Map<String, dynamic>? currentGame;
  Map<String, dynamic> _extra = {};
  SharedPreferences? _preferences;
  bool _loaded = false;
  bool _hasLocalData = false;
  Future<void> _writes = Future<void>.value();

  AppRepository({SharedPreferences? preferences}) {
    _preferences = preferences;
  }

  /// Check only after load. Until then, conservatively protect unread storage.
  bool get hasLocalData =>
      !_loaded ||
      _hasLocalData ||
      currentGame != null ||
      history.isNotEmpty ||
      mistakes.isNotEmpty ||
      deletedMistakes.isNotEmpty;

  Future<void> load() async {
    _loaded = false;
    final preferences = _preferences ?? await SharedPreferences.getInstance();
    final hasLocal =
        preferences.containsKey(_cacheKey) ||
        _legacyKeys.values.any(preferences.containsKey);
    dynamic read(String key, dynamic fallback) {
      final text = preferences.getString(key);
      return text == null ? fallback : jsonDecode(text);
    }

    final cached = preferences.getString(_cacheKey);
    final Map<String, dynamic> raw;
    if (cached != null) {
      final decoded = jsonDecode(cached);
      if (decoded is! Map ||
          decoded['version'] != 1 ||
          decoded['data'] is! Map) {
        throw const FormatException('本地数据损坏，已保留原始缓存');
      }
      raw = Map<String, dynamic>.from(decoded['data'] as Map);
    } else {
      raw = {
        'settings': read('maia-coach.settings', <String, dynamic>{}),
        'history': read('maia-coach.history', <dynamic>[]),
        'mistakes': read('maia-coach.mistakes', <dynamic>[]),
        'puzzles': read('maia-coach.puzzles', <String, dynamic>{}),
        'deletedMistakes': read('maia-coach.mistakes-deleted', <String>[]),
        'currentGame': read('maia-coach.game', null),
      };
    }
    final loaded = _decodeLocal(raw);
    _preferences = preferences;
    _apply(loaded.data);
    currentGame = loaded.current;
    _hasLocalData = hasLocal;
    _loaded = true;
    notifyListeners();
  }

  ({_BackupData data, Map<String, dynamic>? current}) _decodeLocal(
    Map<String, dynamic> raw, {
    bool validateTrees = false,
  }) {
    if (raw['settings'] is! Map ||
        raw['history'] is! List ||
        raw['mistakes'] is! List ||
        raw['puzzles'] is! Map ||
        raw['deletedMistakes'] is! List ||
        (raw['currentGame'] != null && raw['currentGame'] is! Map)) {
      throw const FormatException('本地数据结构损坏，已保留原始缓存');
    }
    final loadedGames = <Map<String, dynamic>>[];
    for (final game in raw['history'] as List) {
      if (game is! Map) throw const FormatException('本地对局数据损坏');
      final parsed = StoredGame.fromJson(game);
      if (validateTrees) GameTree.deserialize(parsed.startFen, parsed.tree);
      loadedGames.add(parsed.toJson());
    }
    final loadedMistakes = <Map<String, dynamic>>[];
    for (final mistake in raw['mistakes'] as List) {
      final parsed = sanitizeMistake(mistake);
      if (parsed == null) throw const FormatException('本地错题数据损坏');
      loadedMistakes.add(parsed);
    }
    if ((raw['deletedMistakes'] as List).any((id) => id is! String)) {
      throw const FormatException('本地错题删除记录损坏');
    }
    final loadedCurrent = raw['currentGame'] == null
        ? null
        : StoredGame.fromJson(raw['currentGame'] as Map).toJson();
    if (validateTrees && loadedCurrent != null) {
      GameTree.deserialize(
        loadedCurrent['startFen'] as String,
        loadedCurrent['tree'] as Map,
      );
    }
    final extra = Map<String, dynamic>.from(raw)
      ..removeWhere(
        (key, _) => {
          'settings',
          'history',
          'mistakes',
          'puzzles',
          'deletedMistakes',
          'currentGame',
        }.contains(key),
      );
    final next = _normalize(
      _BackupData(
        AppSettings.fromJson(raw['settings'] as Map),
        loadedGames,
        loadedMistakes,
        sanitizeProgress(raw['puzzles']),
        sanitizeDeleted(raw['deletedMistakes']),
        extra,
      ),
    );
    return (data: next, current: loadedCurrent);
  }

  /// One-time migration from the original WK localStorage. Call after load and
  /// only when hasLocalData is false. This never writes or clears WebKit data.
  Future<void> importLegacyStorage(Map<String, String> values) async {
    _ensureLoaded();
    await _writes;
    if (hasLocalData) throw StateError('已有 Flutter 本地数据，不能覆盖迁移');
    if (values.isEmpty) return;
    final defaults = <String, dynamic>{
      'settings': <String, dynamic>{},
      'history': <dynamic>[],
      'mistakes': <dynamic>[],
      'puzzles': <String, dynamic>{},
      'deletedMistakes': <String>[],
      'currentGame': null,
    };
    final raw = <String, dynamic>{};
    for (final entry in _legacyKeys.entries) {
      final text = values[entry.value];
      try {
        raw[entry.key] = text == null ? defaults[entry.key] : jsonDecode(text);
      } on FormatException {
        throw FormatException('旧版数据迁移失败：${entry.value} 不是有效的 JSON');
      }
    }
    // Keep unknown localStorage entries verbatim; their values need not be JSON.
    final unknown = Map<String, String>.from(values)
      ..removeWhere((key, _) => _legacyKeys.containsValue(key));
    if (unknown.isNotEmpty) raw['legacyStorage'] = unknown;
    final decoded = _decodeLocal(raw, validateTrees: true);
    await _persist(
      decoded.data,
      game: decoded.current,
      setGame: true,
      requireEmpty: true,
    );
    _apply(decoded.data);
    currentGame = decoded.current;
    notifyListeners();
  }

  void _ensureLoaded() {
    if (!_loaded) throw StateError('请先成功加载本地数据，避免覆盖未读取的数据');
  }

  _BackupData _snapshot() => _BackupData(
    settings,
    history,
    mistakes,
    puzzles,
    deletedMistakes,
    _extra,
  );

  void _apply(_BackupData data) {
    settings = data.settings;
    history = data.history;
    mistakes = data.mistakes;
    puzzles = data.puzzles;
    deletedMistakes = data.deleted;
    _extra = data.extra;
  }

  Future<void> _persist(
    _BackupData data, {
    Map<String, dynamic>? game,
    bool setGame = false,
    bool requireEmpty = false,
  }) {
    _ensureLoaded();
    final text = jsonEncode({
      'version': 1,
      'data': {...data.toJson(), 'currentGame': setGame ? game : currentGame},
    });
    final operation = _writes.then((_) async {
      if (requireEmpty && hasLocalData) {
        throw StateError('已有 Flutter 本地数据，不能覆盖迁移');
      }
      try {
        if (!await _preferences!.setString(_cacheKey, text)) {
          throw StateError('保存本地数据失败');
        }
      } catch (error, stack) {
        // Legacy SharedPreferences updates its cache before the platform write.
        // Reload after a failure so an explicit retry reads actual disk state.
        try {
          await _preferences!.reload();
        } catch (_) {
          _loaded = false;
        }
        Error.throwWithStackTrace(error, stack);
      }
      _hasLocalData = true;
    });
    // Only the sequencing tail recovers; the returned operation propagates every
    // failure to the caller and allows an explicit later retry.
    _writes = operation.then<void>(
      (_) {},
      onError: (Object _, StackTrace _) {},
    );
    return operation;
  }

  Future<void> save() => _persist(_snapshot());

  void upsertGame(Map game) {
    final parsed = StoredGame.fromJson(game).toJson();
    history = _normalizeHistory([
      parsed,
      ...history.where((g) => g['id'] != parsed['id']),
    ]);
    notifyListeners();
  }

  int addMistake(Map mistake) {
    final parsed = sanitizeMistake(mistake);
    if (parsed == null) throw const FormatException('错题数据无效');
    if (deletedMistakes.contains(parsed['id']) ||
        mistakes.any((m) => m['id'] == parsed['id'])) {
      return 0;
    }
    mistakes = mergeMistakes([parsed], mistakes);
    notifyListeners();
    return 1;
  }

  bool gradeMistake(String id, bool correct, {int? now}) {
    final index = mistakes.indexWhere((m) => m['id'] == id);
    if (index < 0) return false;
    final time = now ?? DateTime.now().millisecondsSinceEpoch;
    final mistake = mistakes[index];
    mistake['tries'] = (mistake['tries'] as num).toInt() + 1;
    if ((mistake['due'] as num) > time) {
      notifyListeners();
      return false;
    }
    if (correct) {
      mistake['solved'] = (mistake['solved'] as num).toInt() + 1;
      final streak = (mistake['streak'] as num).toInt() + 1;
      mistake['streak'] = streak;
      if (streak >= _intervals.length) mistake['mastered'] = true;
      mistake['due'] =
          time + _intervals[math.min(streak, _intervals.length - 1)] * _dayMs;
    } else {
      mistake['streak'] = 0;
      mistake.remove('mastered');
      mistake['due'] = time + 600000;
    }
    notifyListeners();
    return true;
  }

  void removeMistake(String id) {
    deletedMistakes = sanitizeDeleted([...deletedMistakes, id]);
    mistakes = mistakes.where((m) => m['id'] != id).toList();
    notifyListeners();
  }

  List<Map<String, dynamic>> dueMistakes({int? now}) {
    final time = now ?? DateTime.now().millisecondsSinceEpoch;
    return mistakes
        .where((m) => m['mastered'] != true && (m['due'] as num) <= time)
        .toList()
      ..sort((a, b) => (b['drop'] as num).compareTo(a['drop'] as num));
  }

  String exportBackup() => const JsonEncoder.withIndent('  ').convert({
    ..._normalize(_snapshot()).toJson(),
    'format': backupFormat,
    'version': backupVersion,
    'exported': DateTime.now().toUtc().toIso8601String(),
    'app': 'Maia Coach Flutter',
  });

  /// Returns the count of malformed game/mistake entries skipped, as on web.
  /// Mutators are synchronous; callers explicitly await [save] for persistence.
  /// Import persists its complete staged result before replacing live state.
  Future<int> importBackup(String text, {bool replace = false}) async {
    _ensureLoaded();
    final parsed = parseBackup(text);
    final data = parsed.data;
    final incoming = _BackupData(
      AppSettings.fromJson(data['settings'] as Map),
      (data['history'] as List)
          .map((g) => Map<String, dynamic>.from(g as Map))
          .toList(),
      (data['mistakes'] as List)
          .map((m) => Map<String, dynamic>.from(m as Map))
          .toList(),
      Map<String, dynamic>.from(data['puzzles'] as Map),
      List<String>.from(data['deletedMistakes'] as List),
      Map<String, dynamic>.from(data)..removeWhere(
        (key, _) => {
          'settings',
          'history',
          'mistakes',
          'puzzles',
          'deletedMistakes',
        }.contains(key),
      ),
    );
    _BackupData next;
    if (replace) {
      next = incoming;
    } else {
      final mergedSettings = <String, dynamic>{
        ...incoming.settings.toJson(),
        ...settings.toJson(),
      };
      if ((incoming.settings['ratedGames'] as num) >
          (settings['ratedGames'] as num)) {
        for (final key in [
          'playerElo',
          'ratingDeviation',
          'ratingStreak',
          'ratedGames',
        ]) {
          mergedSettings[key] = incoming.settings[key];
        }
      }
      final games = <String, Map<String, dynamic>>{
        for (final g in history) g['id'] as String: g,
      };
      for (final game in incoming.history) {
        final current = games[game['id']];
        games[game['id'] as String] = current == null
            ? game
            : {...game, ...current};
      }
      next = _normalize(
        _BackupData(
          AppSettings.fromJson(mergedSettings),
          games.values.toList(),
          mergeMistakes(mistakes, incoming.mistakes),
          mergeProgress(puzzles, incoming.puzzles),
          [...deletedMistakes, ...incoming.deleted],
          {...incoming.extra, ..._extra},
        ),
      );
    }
    await _persist(next);
    _apply(next);
    notifyListeners();
    return parsed.skipped;
  }
}
