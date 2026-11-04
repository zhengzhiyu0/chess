import 'dart:convert';

import 'package:flutter/services.dart';

/// JS FNV-1a hashes UTF-16 code units with 32-bit integer multiplication.
int fnv(String text) {
  var hash = 0x811c9dc5;
  for (final unit in text.codeUnits) {
    hash ^= unit;
    // Split the prime so intermediates stay below 2^53 on Dart web as well.
    hash = (hash * 0x193 + ((hash & 0xff) << 24)) & 0xffffffff;
  }
  return hash;
}

class OpeningBook {
  final AssetBundle _assets;
  Future<void>? _loading;
  Map<int, ({String eco, String name})> _openings = {};
  Set<int> _hashes = {};
  Map<String, String> _translations = {};
  bool ready = false;

  OpeningBook({AssetBundle? assets}) : _assets = assets ?? rootBundle;

  Future<void> load() => _loading ??= _load();
  Future<void> _load() async {
    try {
      final sources = await Future.wait([
        _assets.loadString('assets/data/openings.json', cache: false),
        _assets.loadString('assets/data/opening-zh.json', cache: false),
      ]);
      final raw = jsonDecode(sources[0]) as Map;
      final hashes = (raw['data'] as String).split(' ');
      final ids = (raw['ids'] as String).split(' ');
      final names = List<String>.from(raw['names'] as List);
      if (hashes.length != ids.length) throw const FormatException('开局库索引损坏');
      final openings = <int, ({String eco, String name})>{};
      final all = <int>{};
      for (var i = 0; i < hashes.length; i++) {
        if (hashes[i].isEmpty) continue;
        final hash = int.parse(hashes[i], radix: 36);
        all.add(hash);
        if (ids[i].isEmpty) continue;
        final index = int.parse(ids[i], radix: 36);
        if (index < 0 || index >= names.length) {
          throw const FormatException('开局名称索引损坏');
        }
        final tab = names[index].indexOf('\t');
        if (tab <= 0) throw const FormatException('开局名称损坏');
        openings[hash] = (
          eco: names[index].substring(0, tab),
          name: names[index].substring(tab + 1),
        );
      }
      final translations = Map<String, String>.from(
        jsonDecode(sources[1]) as Map,
      );
      _openings = openings;
      _hashes = all;
      _translations = translations;
      ready = true;
    } catch (_) {
      _loading = null;
      rethrow;
    }
  }

  int _key(String fen) =>
      fnv(fen.trim().split(RegExp(r'\s+')).take(4).join(' '));
  bool inBook(String fen) => _hashes.contains(_key(fen));
  ({String eco, String name})? openingOf(String fen) => _openings[_key(fen)];

  ({String eco, String name})? _identify(Iterable<String> fens) {
    ({String eco, String name})? last;
    for (final fen in fens) {
      last = openingOf(fen) ?? last;
    }
    return last;
  }

  /// Display text without the UI's "开局：" prefix, e.g. 西班牙开局（C60）.
  String? identify(Iterable<String> fens) {
    final opening = _identify(fens);
    if (opening == null) return null;
    final family = opening.name.split(':').first.trim();
    final translated =
        _translations[family] ?? _translations[family.split(',').first.trim()];
    return '${translated ?? opening.name}（${opening.eco}）';
  }

  String? english(Iterable<String> fens) {
    final opening = _identify(fens);
    return opening == null ? null : '${opening.name}（${opening.eco}）';
  }
}
