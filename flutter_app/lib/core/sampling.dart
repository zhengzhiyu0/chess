import 'dart:convert';

import 'package:shared_preferences/shared_preferences.dart';

const samplingCaptureMaxGames = 10;
const samplingCaptureMaxBytes = 8 * 1024 * 1024;

/// A diagnostic failure is data for the caller, never an exception in move play.
class SamplingResult {
  final String? error;

  const SamplingResult.success() : error = null;
  const SamplingResult.failure(this.error);

  bool get ok => error == null;
}

/// Optional local diagnostics, completely separate from the ordinary backup.
///
/// The controller constructs a JSON record AFTER committing a move, with a
/// non-empty `gameId`, `rawMoves` and `distribution`. Both move arrays contain
/// `{uci, p, logit?}`; distribution is the actual normalized sampling probability
/// after temperature/top-p. This module preserves both arrays and all additional
/// fields verbatim. It never predicts, samples, or recomputes probabilities.
///
/// Call [load] before [append]. Mutations are ordered and return errors rather
/// than throwing. The caller can append without awaiting it on the move path,
/// then inspect [SamplingResult] to report a diagnostic failure separately.
class SamplingStore {
  static const storageKey = 'maia-coach.flutter.sampling.v1';

  SamplingStore({this._preferences});

  SharedPreferences? _preferences;
  Future<void> _tail = Future<void>.value();
  List<_CaptureLine> _lines = [];
  String _text = '';
  int _bytes = 0;
  bool _loaded = false;
  bool _needsReload = false;

  bool get loaded => _loaded;
  int get games => _lines.map((entry) => entry.gameId).toSet().length;
  int get decisions => _lines.length;

  /// UTF-8 JSONL bytes, including every separating LF (no trailing LF is added).
  int get bytes => _bytes;

  /// Deep copies: editing an exported snapshot cannot alter queued/persisted data.
  List<Map<String, dynamic>> get records => List.unmodifiable(
    _lines.map((entry) => jsonDecode(entry.text) as Map<String, dynamic>),
  );

  Future<SamplingResult> _enqueue(Future<void> Function() operation) {
    final result = _tail.then<SamplingResult>((_) async {
      try {
        await operation();
        return const SamplingResult.success();
      } catch (error) {
        return SamplingResult.failure('采样诊断存储失败：$error');
      }
    });
    // Failures are values, so a failed platform write cannot poison later work.
    _tail = result.then<void>((_) {});
    return result;
  }

  Future<SamplingResult> load() => _enqueue(() async {
    _loaded = false;
    final preferences = _preferences ??= await SharedPreferences.getInstance();
    if (_needsReload) {
      await preferences.reload();
      _needsReload = false;
    }
    final text = preferences.getString(storageKey) ?? '';
    final size = utf8.encode(text).length;
    if (size > samplingCaptureMaxBytes) {
      throw const FormatException('诊断数据超过 8 MiB，原始数据已保留');
    }
    final rawLines = text.isEmpty ? <String>[] : text.split('\n');
    // Accept standard JSONL with an optional final newline as well as our own
    // no-trailing-newline format. Blank records in the middle are corrupt.
    if (rawLines.isNotEmpty && rawLines.last.isEmpty) rawLines.removeLast();
    final lines = rawLines.map(_CaptureLine.fromText).toList();
    if (lines.map((entry) => entry.gameId).toSet().length >
        samplingCaptureMaxGames) {
      throw const FormatException('诊断数据超过 10 局，原始数据已保留');
    }
    _commit(lines, text, size);
  });

  Future<SamplingResult> append(Map<String, dynamic> record) {
    // Freeze at invocation, before waiting for earlier disk writes. A controller
    // may reuse/mutate its candidate list immediately after calling append.
    final _CaptureLine entry;
    try {
      entry = _CaptureLine.fromText(jsonEncode(record));
      if (entry.bytes > samplingCaptureMaxBytes) {
        throw const FormatException('单条采样诊断超过 8 MiB');
      }
    } catch (error) {
      return Future.value(SamplingResult.failure('采样诊断存储失败：$error'));
    }
    return _enqueue(() async {
      _requireLoaded();
      final staged = [..._lines, entry];
      final recentGames = <String>{};
      for (final item in staged.reversed) {
        recentGames.add(item.gameId);
        if (recentGames.length == samplingCaptureMaxGames) break;
      }
      final retained = staged
          .where((item) => recentGames.contains(item.gameId))
          .toList();
      var size =
          retained.fold<int>(0, (sum, item) => sum + item.bytes) +
          retained.length -
          1;
      var start = 0;
      while (size > samplingCaptureMaxBytes) {
        size -= retained[start++].bytes + 1;
      }
      final lines = retained.sublist(start);
      final text = lines.map((item) => item.text).join('\n');
      await _write(text);
      _commit(lines, text, size);
    });
  }

  /// Explicit reset also works after a failed/corrupt load. Never clears prefs.
  Future<SamplingResult> clear() => _enqueue(() async {
    _preferences ??= await SharedPreferences.getInstance();
    await _write(null);
    _needsReload = false;
    _commit([], '', 0);
  });

  Future<void> _write(String? text) async {
    final preferences = _preferences!;
    try {
      final ok = text == null
          ? await preferences.remove(storageKey)
          : await preferences.setString(storageKey, text);
      if (!ok) throw StateError('平台拒绝保存采样诊断');
    } catch (_) {
      // Legacy SharedPreferences changes its cache before awaiting a platform
      // write. Undo that optimistic cache before allowing an explicit retry.
      _needsReload = true;
      try {
        await preferences.reload();
        _needsReload = false;
      } catch (_) {
        _loaded = false;
      }
      rethrow;
    }
  }

  void _commit(List<_CaptureLine> lines, String text, int size) {
    _lines = lines;
    _text = text;
    _bytes = size;
    _loaded = true;
  }

  void _requireLoaded() {
    if (!_loaded) throw StateError('请先成功 load 采样诊断，或显式 clear 后重试');
  }

  /// Synchronous snapshot of the last successful load/write; await queued writes
  /// before exporting when they must be included. Unread/corrupt data is an error.
  String exportJsonl() {
    _requireLoaded();
    return _text;
  }

  /// Offline report without scripts. Every user-controlled value is HTML escaped,
  /// including the complete original record so unknown fields remain inspectable.
  String exportHtml() {
    _requireLoaded();
    final html = StringBuffer('''<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<title>Maia 本地采样诊断</title>
<style>body{font:16px system-ui,sans-serif;max-width:1080px;margin:auto;padding:20px;color:#222;overflow-wrap:anywhere}section{border-top:1px solid #aaa;margin-top:24px}table{border-collapse:collapse;width:100%}th,td{border:1px solid #aaa;padding:6px;text-align:left}pre{white-space:pre-wrap;overflow-wrap:anywhere}</style>
</head><body><h1>Maia 本地采样诊断</h1>
<p>共 $games 局 / $decisions 次决策 / $bytes UTF-8 字节。最多保留最近 10 局且 JSONL 不超过 8 MiB；旧记录可能被淘汰，不保证完整对局。</p>
<p>原始 p 是模型概率；实际 p 是 controller 提供的温度调整后采样概率，报告不会重新计算。概率不代表着法质量或胜率。本报告完全离线。</p>
''');
    for (var index = 0; index < _lines.length; index++) {
      final record = jsonDecode(_lines[index].text) as Map<String, dynamic>;
      final raw = (record['rawMoves'] as List).cast<Map<String, dynamic>>();
      final distribution = (record['distribution'] as List)
          .cast<Map<String, dynamic>>();
      final actual = {
        for (final move in distribution)
          move['uci'] as String: move['p'] as num,
      };
      html.write(
        '<section><h2>决策 ${index + 1} · ${_escape(record['gameId'])}</h2>'
        '<p>Temperature：${_escape(record['temperature'])}；'
        '模型：${_escape(record['model'])}</p>'
        '<table><thead><tr><th>着法</th><th>原始 logit</th>'
        '<th>原始 p</th><th>实际 p</th></tr></thead><tbody>',
      );
      for (final move in raw) {
        html.write(
          '<tr><td>${_escape(move['uci'])}</td>'
          '<td>${_escape(move['logit'])}</td>'
          '<td>${_percent(move['p'] as num)}</td>'
          '<td>${_percent(actual[move['uci']] ?? 0)}</td></tr>',
        );
      }
      html.write(
        '</tbody></table><details><summary>完整原始记录</summary>'
        '<pre>${_escape(const JsonEncoder.withIndent('  ').convert(record))}</pre>'
        '</details></section>',
      );
    }
    html.write('</body></html>');
    return html.toString();
  }

  static String _escape(Object? value) =>
      const HtmlEscape(HtmlEscapeMode.unknown)
          .convert(value?.toString() ?? '—');
  static String _percent(num value) => '${(value * 100).toStringAsFixed(3)}%';
}

class _CaptureLine {
  final String text;
  final String gameId;
  final int bytes;

  _CaptureLine._(this.text, this.gameId, this.bytes);

  factory _CaptureLine.fromText(String text) {
    final record = jsonDecode(text);
    if (record is! Map<String, dynamic> ||
        record['gameId'] is! String ||
        (record['gameId'] as String).trim().isEmpty) {
      throw const FormatException('采样记录必须含非空 gameId');
    }
    Set<String> checkMoves(Object? value, {bool normalized = false}) {
      if (value is! List || value.isEmpty) {
        throw const FormatException('采样记录必须同时保留 rawMoves 和 distribution');
      }
      final moves = <String>{};
      var total = 0.0;
      for (final move in value) {
        if (move is! Map<String, dynamic> ||
            move['uci'] is! String ||
            (move['uci'] as String).isEmpty ||
            !moves.add(move['uci'] as String) ||
            move['p'] is! num) {
          throw const FormatException('候选着法必须含唯一 uci 和有限概率 p');
        }
        final probability = move['p'] as num;
        if (!probability.isFinite || probability < 0 || probability > 1) {
          throw const FormatException('采样概率 p 必须在 0 至 1 之间');
        }
        if (move.containsKey('logit') &&
            (move['logit'] is! num || !(move['logit'] as num).isFinite)) {
          throw const FormatException('logit 必须为有限数值');
        }
        total += probability;
      }
      if (normalized && (total - 1).abs() > 1e-6) {
        throw const FormatException('distribution 必须是实际归一化概率');
      }
      return moves;
    }

    final raw = checkMoves(record['rawMoves']);
    final actual = checkMoves(record['distribution'], normalized: true);
    if (!raw.containsAll(actual)) {
      throw const FormatException('distribution 着法必须存在于 rawMoves');
    }
    return _CaptureLine._(
      text,
      record['gameId'] as String,
      utf8.encode(text).length,
    );
  }
}
