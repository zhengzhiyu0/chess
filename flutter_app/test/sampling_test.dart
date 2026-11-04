import 'dart:async';
import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:maia_coach/core/sampling.dart';
import 'package:maia_coach/core/storage.dart';
import 'package:shared_preferences/shared_preferences.dart';

class _Preferences extends Fake implements SharedPreferences {
  final Map<String, Object> disk;
  final Map<String, Object> cache;
  final List<String> writes = [];
  bool failWrites = false;
  bool throwWrites = false;
  bool failReload = false;
  int reloads = 0;
  Completer<void>? writeGate;

  _Preferences([Map<String, Object> values = const {}])
    : disk = Map.of(values),
      cache = Map.of(values);

  @override
  String? getString(String key) => cache[key] as String?;

  @override
  Future<bool> setString(String key, String value) async {
    writes.add(key);
    cache[key] = value;
    if (writeGate != null) await writeGate!.future;
    if (throwWrites) throw StateError('disk write exception');
    if (failWrites) return false;
    disk[key] = value;
    return true;
  }

  @override
  Future<bool> remove(String key) async {
    writes.add(key);
    cache.remove(key);
    if (throwWrites) throw StateError('disk remove exception');
    if (failWrites) return false;
    disk.remove(key);
    return true;
  }

  @override
  Future<void> reload() async {
    reloads++;
    if (failReload) throw StateError('disk reload exception');
    cache
      ..clear()
      ..addAll(disk);
  }
}

Map<String, dynamic> _record(String gameId, {int ply = 1}) => {
  'schemaVersion': 1,
  'recordedAt': 123456,
  'gameId': gameId,
  'ply': ply,
  'fen': 'test position',
  'model': '79m',
  'selfElo': 1500,
  'oppoElo': 1600,
  'temperature': 0.5,
  'topP': 1,
  'chosen': 'e2e4',
  'rawMoves': [
    {'uci': 'e2e4', 'logit': 1.5, 'p': 0.6},
    {'uci': 'd2d4', 'logit': 1.0, 'p': 0.3},
    {'uci': 'g1f3', 'logit': 0.5, 'p': 0.1},
  ],
  'distribution': [
    {'uci': 'e2e4', 'logit': 1.5, 'p': 0.36 / 0.46},
    {'uci': 'd2d4', 'logit': 1.0, 'p': 0.09 / 0.46},
    {'uci': 'g1f3', 'logit': 0.5, 'p': 0.01 / 0.46},
  ],
  'wdl': {'perspective': 'side-to-move', 'win': 0.4, 'draw': 0.3, 'loss': 0.3},
  'ms': 12.5,
};

Future<SamplingStore> _loaded(_Preferences preferences) async {
  final store = SamplingStore(preferences: preferences);
  expect((await store.load()).ok, isTrue);
  return store;
}

Map<String, dynamic> _paddedRecord(
  String gameId,
  int byteCount, {
  int ply = 1,
}) {
  final record = {..._record(gameId, ply: ply), 'note': ''};
  final extra = byteCount - utf8.encode(jsonEncode(record)).length;
  assert(extra >= 0);
  record['note'] = '${'棋' * (extra ~/ 3)}${'x' * (extra % 3)}';
  return record;
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  test(
    'empty load does not write and append requires successful load',
    () async {
      final preferences = _Preferences({'ordinary-key': 'keep'});
      final store = SamplingStore(preferences: preferences);
      final refused = await store.append(_record('unread'));
      expect(refused.ok, isFalse);
      expect(refused.error, isNotEmpty);
      expect(store.exportJsonl, throwsStateError);
      expect((await store.load()).ok, isTrue);
      expect(store.loaded, isTrue);
      expect(store.exportJsonl(), isEmpty);
      expect(store.decisions, 0);
      expect(store.games, 0);
      expect(store.bytes, 0);
      expect(preferences.writes, isEmpty);
      expect(preferences.disk, {'ordinary-key': 'keep'});
    },
  );

  test(
    'round trip preserves raw p, actual p and unknown JSON fields exactly',
    () async {
      final preferences = _Preferences();
      final store = await _loaded(preferences);
      final record = _record('game-1')
        ..['future'] = {
          'new-field': [true, null, '棋'],
        };
      expect((await store.append(record)).ok, isTrue);
      final restored = await _loaded(preferences);
      expect(jsonDecode(restored.exportJsonl()), record);
      expect(restored.records.single, record);
      expect(restored.records.single['rawMoves'][0]['p'], 0.6);
      expect(restored.records.single['distribution'][0]['p'], 0.36 / 0.46);
      expect(restored.bytes, utf8.encode(restored.exportJsonl()).length);
      expect(preferences.writes, [SamplingStore.storageKey]);
      final copy = restored.records.single;
      copy['rawMoves'][0]['p'] = 0;
      expect(restored.records.single['rawMoves'][0]['p'], 0.6);
    },
  );

  test(
    'concurrent appends snapshot caller input and retain invocation order',
    () async {
      final preferences = _Preferences();
      final store = await _loaded(preferences);
      final gate = Completer<void>();
      preferences.writeGate = gate;
      final first = store.append(_record('one'));
      final secondRecord = _record('two');
      final second = store.append(secondRecord);
      secondRecord['gameId'] = 'mutated';
      secondRecord['rawMoves'][0]['p'] = 0.1;
      await Future<void>.delayed(Duration.zero);
      expect(
        store.decisions,
        0,
        reason: 'uncommitted writes must not change state',
      );
      gate.complete();
      expect((await first).ok, isTrue);
      expect((await second).ok, isTrue);
      expect(store.records.map((r) => r['gameId']), ['one', 'two']);
      expect(store.records.last['rawMoves'][0]['p'], 0.6);
      expect((await _loaded(preferences)).records, store.records);
    },
  );

  test(
    'controller record accepts actual probabilities without duplicate logits',
    () async {
      final store = await _loaded(_Preferences());
      final record = _record('controller')
        ..remove('schemaVersion')
        ..remove('recordedAt')
        ..remove('chosen');
      record['selected'] = 'e2e4';
      record['date'] = '2026-11-03T00:00:00.000Z';
      record['wdl'] = [0.4, 0.3, 0.3];
      record['expectedScore'] = 0.55;
      record['distribution'] = [
        for (final move in record['distribution'] as List)
          {'uci': move['uci'], 'p': move['p']},
      ];
      expect((await store.append(record)).ok, isTrue);
      expect(store.records.single, record);
      expect(store.exportHtml(), contains('78.261%'));
    },
  );

  test(
    'queued clear occurs after prior append and before a subsequent append',
    () async {
      final preferences = _Preferences();
      final store = await _loaded(preferences);
      final first = store.append(_record('old'));
      final clear = store.clear();
      final last = store.append(_record('new'));
      for (final outcome in await Future.wait([first, clear, last])) {
        expect(outcome.ok, isTrue);
      }
      expect(store.records.map((r) => r['gameId']), ['new']);
      expect((await _loaded(preferences)).records, store.records);
    },
  );

  test(
    'retains ten most recently recorded games, keeping chronology',
    () async {
      final store = await _loaded(_Preferences());
      for (var i = 0; i < 10; i++) {
        expect((await store.append(_record('game-$i'))).ok, isTrue);
      }
      expect((await store.append(_record('game-0', ply: 2))).ok, isTrue);
      expect((await store.append(_record('game-10'))).ok, isTrue);
      expect(store.games, 10);
      expect(store.decisions, 11);
      expect(store.records.any((r) => r['gameId'] == 'game-1'), isFalse);
      expect(store.records.where((r) => r['gameId'] == 'game-0').length, 2);
      expect(store.records.first['gameId'], 'game-0');
      expect(store.records.last['gameId'], 'game-10');
    },
  );

  test('UTF-8 cap includes separators and accepts exactly 8 MiB', () async {
    final preferences = _Preferences();
    final store = await _loaded(preferences);
    final exact = _paddedRecord('exact', samplingCaptureMaxBytes);
    final text = jsonEncode(exact);
    expect(text.length, lessThan(samplingCaptureMaxBytes));
    expect(utf8.encode(text).length, samplingCaptureMaxBytes);
    expect((await store.append(exact)).ok, isTrue);
    expect(store.bytes, samplingCaptureMaxBytes);
    expect((await store.append(_record('new'))).ok, isTrue);
    expect(store.records.map((r) => r['gameId']), ['new']);
    final saved = store.exportJsonl();
    final oversized = _paddedRecord('too-big', samplingCaptureMaxBytes + 1);
    final failed = await store.append(oversized);
    expect(failed.ok, isFalse);
    expect(failed.error, contains('8 MiB'));
    expect(store.exportJsonl(), saved);
    expect(preferences.disk[SamplingStore.storageKey], saved);
  });

  test('byte eviction can retain only the tail of one game', () async {
    final store = await _loaded(_Preferences());
    for (var ply = 1; ply <= 3; ply++) {
      expect(
        (await store.append(
          _paddedRecord('one-game', 3 * 1024 * 1024, ply: ply),
        )).ok,
        isTrue,
      );
    }
    expect(store.games, 1);
    expect(store.records.map((r) => r['ply']), [2, 3]);
    expect(store.bytes, 6 * 1024 * 1024 + 1);
    expect(utf8.encode(store.exportJsonl()).length, store.bytes);
  });

  test(
    'failed and thrown writes return errors, repair cache and allow retry',
    () async {
      final preferences = _Preferences();
      final store = await _loaded(preferences);
      expect((await store.append(_record('saved'))).ok, isTrue);
      final saved = store.exportJsonl();
      preferences.failWrites = true;
      var failure = await store.append(_record('not-saved'));
      expect(failure.ok, isFalse);
      expect(failure.error, isNotEmpty);
      expect(store.exportJsonl(), saved);
      expect(preferences.cache[SamplingStore.storageKey], saved);
      expect(preferences.disk[SamplingStore.storageKey], saved);
      preferences
        ..failWrites = false
        ..throwWrites = true;
      failure = await store.append(_record('exception'));
      expect(failure.ok, isFalse);
      expect(store.exportJsonl(), saved);
      expect(preferences.reloads, 2);
      preferences.throwWrites = false;
      expect((await store.append(_record('retry'))).ok, isTrue);
      expect(store.records.map((r) => r['gameId']), ['saved', 'retry']);
    },
  );

  test(
    'reload failure requires a successful reload before further append',
    () async {
      final preferences = _Preferences();
      final store = await _loaded(preferences);
      expect((await store.append(_record('saved'))).ok, isTrue);
      preferences
        ..failWrites = true
        ..failReload = true;
      expect((await store.append(_record('failed'))).ok, isFalse);
      expect(store.loaded, isFalse);
      expect((await store.append(_record('must-not-overwrite'))).ok, isFalse);
      expect(store.exportJsonl, throwsStateError);
      preferences
        ..failWrites = false
        ..failReload = false;
      expect((await store.load()).ok, isTrue);
      expect(store.records.map((r) => r['gameId']), ['saved']);
      expect((await store.append(_record('retry'))).ok, isTrue);
    },
  );

  test(
    'clear removes only diagnostics and does not commit on write failure',
    () async {
      final preferences = _Preferences({'ordinary-key': 'keep'});
      final store = await _loaded(preferences);
      expect((await store.append(_record('saved'))).ok, isTrue);
      final saved = store.exportJsonl();
      preferences.failWrites = true;
      expect((await store.clear()).ok, isFalse);
      expect(store.exportJsonl(), saved);
      expect(preferences.cache[SamplingStore.storageKey], saved);
      preferences.failWrites = false;
      expect((await store.clear()).ok, isTrue);
      expect(store.exportJsonl(), isEmpty);
      expect(store.games, 0);
      expect(store.bytes, 0);
      expect(preferences.disk, {'ordinary-key': 'keep'});
      expect(preferences.writes.toSet(), {SamplingStore.storageKey});
    },
  );

  test(
    'corrupt and over-limit persisted data stay untouched until explicit clear',
    () async {
      for (final corrupt in [
        'not-json',
        jsonEncode({'gameId': 'missing-probabilities'}),
        '${jsonEncode(_record('ok'))}\n\n${jsonEncode(_record('bad'))}',
        List.generate(11, (i) => jsonEncode(_record('game-$i'))).join('\n'),
        'x' * (samplingCaptureMaxBytes + 1),
      ]) {
        final preferences = _Preferences({SamplingStore.storageKey: corrupt});
        final store = SamplingStore(preferences: preferences);
        final failed = await store.load();
        expect(failed.ok, isFalse);
        expect(failed.error, isNotEmpty);
        expect((await store.append(_record('must-not-overwrite'))).ok, isFalse);
        expect(preferences.writes, isEmpty);
        expect(preferences.disk[SamplingStore.storageKey], corrupt);
        expect((await store.clear()).ok, isTrue);
        expect((await store.append(_record('after-clear'))).ok, isTrue);
      }
    },
  );

  test(
    'standard trailing newline JSONL loads with correct byte count',
    () async {
      final text = '${jsonEncode(_record('one'))}\n';
      final store = await _loaded(
        _Preferences({SamplingStore.storageKey: text}),
      );
      expect(store.decisions, 1);
      expect(store.bytes, utf8.encode(text).length);
      expect(store.exportJsonl(), text);
      expect((await store.append(_record('two'))).ok, isTrue);
      expect(store.exportJsonl().split('\n').length, 2);
      expect(store.bytes, utf8.encode(store.exportJsonl()).length);
    },
  );

  test(
    'invalid records and non-finite values return errors without writing',
    () async {
      final preferences = _Preferences();
      final store = await _loaded(preferences);
      for (final record in [
        {..._record('ok'), 'gameId': ''},
        {..._record('ok'), 'ms': double.nan},
        {..._record('ok'), 'temperature': double.infinity},
        {..._record('ok'), 'rawMoves': []},
        {
          ..._record('ok'),
          'distribution': [
            {'uci': 'e2e4', 'p': 0.4},
          ],
        },
        {
          ..._record('ok'),
          'distribution': [
            {'uci': 'unknown', 'p': 1},
          ],
        },
        {
          ..._record('ok'),
          'distribution': [
            {'uci': 'e2e4', 'p': 1.01},
          ],
        },
        {
          ..._record('ok'),
          'distribution': [
            {'uci': 'e2e4', 'p': -0.01},
          ],
        },
      ]) {
        final outcome = await store.append(record);
        expect(outcome.ok, isFalse);
        expect(outcome.error, isNotEmpty);
      }
      expect(preferences.writes, isEmpty);
      expect(store.decisions, 0);
      expect((await store.append(_record('valid'))).ok, isTrue);
    },
  );

  test(
    'HTML escapes every field and displays raw and actual probabilities',
    () async {
      final store = await _loaded(_Preferences());
      const attack = '</pre><script>alert("&\'棋")</script><img src=x>';
      final record = _record(attack)
        ..['model'] = attack
        ..['fen'] = attack
        ..['unknown'] = attack;
      expect((await store.append(record)).ok, isTrue);
      final html = store.exportHtml();
      expect(html, startsWith('<!doctype html>'));
      expect(html, contains('Content-Security-Policy'));
      expect(html, contains('原始 p'));
      expect(html, contains('实际 p'));
      expect(html, contains('60.000%'));
      expect(html, contains('78.261%'));
      expect(html, contains('&lt;script&gt;'));
      expect(html, contains('&quot;'));
      expect(html, contains('&#39;'));
      expect(html, contains('&amp;'));
      expect(html, isNot(contains('<script')));
      expect(html, isNot(contains('<img')));
      expect(html, isNot(contains(attack)));
      expect(jsonDecode(store.exportJsonl()), record);
    },
  );

  test(
    'independent preferences key never appears in ordinary domain backup',
    () async {
      SharedPreferences.setMockInitialValues({});
      final preferences = await SharedPreferences.getInstance();
      final store = SamplingStore(preferences: preferences);
      expect((await store.load()).ok, isTrue);
      expect((await store.append(_record('diagnostic-only'))).ok, isTrue);
      final repository = AppRepository(preferences: preferences);
      addTearDown(repository.dispose);
      await repository.load();
      expect(repository.hasLocalData, isFalse);
      repository.settings['theme'] = 'light';
      await repository.save();
      final domain = preferences.getString('maia-coach.flutter.domain.v1');
      expect(domain, isNotNull);
      expect(repository.exportBackup(), isNot(contains('diagnostic-only')));
      expect(repository.exportBackup(), isNot(contains('rawMoves')));
      expect((await store.clear()).ok, isTrue);
      expect(preferences.getString('maia-coach.flutter.domain.v1'), domain);
      expect(preferences.getKeys(), {'maia-coach.flutter.domain.v1'});
    },
  );
}
