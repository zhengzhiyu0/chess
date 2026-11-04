import 'dart:convert';

import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'package:maia_coach/core/chess.dart';
import 'package:maia_coach/core/clock.dart';
import 'package:maia_coach/core/game.dart';
import 'package:maia_coach/core/openings.dart';
import 'package:maia_coach/core/rating.dart';
import 'package:maia_coach/core/settings.dart';
import 'package:maia_coach/core/storage.dart';
import 'package:maia_coach/core/training.dart';

class _Assets extends CachingAssetBundle {
  final Map<String, String> files;
  final Map<String, int> reads = {};
  _Assets(this.files);

  @override
  Future<ByteData> load(String key) async {
    reads[key] = (reads[key] ?? 0) + 1;
    final text = files[key];
    if (text == null) throw StateError('Missing asset $key');
    return ByteData.sublistView(Uint8List.fromList(utf8.encode(text)));
  }
}

class _Preferences extends Fake implements SharedPreferences {
  final Map<String, String> disk = {};
  final Map<String, String> cache = {};
  bool failWrites = false;

  @override
  bool containsKey(String key) => cache.containsKey(key);
  @override
  String? getString(String key) => cache[key];
  @override
  Future<bool> setString(String key, String value) async {
    cache[key] = value;
    if (failWrites) return false;
    disk[key] = value;
    return true;
  }

  @override
  Future<void> reload() async {
    cache
      ..clear()
      ..addAll(disk);
  }
}

Map<String, dynamic> _game(String id, {int date = 100, int elo = 1500}) => {
  'id': id,
  'date': date,
  'startFen': startFen,
  'tree': GameTree.fromMoves(startFen, ['e2e4', 'e7e5']).serialize(),
  'userColor': 'w',
  'result': '1-0',
  'elo': elo,
};

Map<String, dynamic> _mistake(String id, {int tries = 0, int date = 100}) => {
  'id': id,
  'gameId': 'game-1',
  'date': date,
  'fen': startFen,
  'played': 'a2a3',
  'playedSan': 'a3',
  'best': 'e2e4',
  'line': ['e2e4', 'e7e5'],
  'judgement': 'mistake',
  'drop': 12.0,
  'tag': 'opening',
  'tagLabel': '开局',
  'streak': 0,
  'due': 0,
  'tries': tries,
  'solved': 0,
};

String _backup({
  Map<String, dynamic>? settings,
  List<dynamic> history = const [],
  List<dynamic> mistakes = const [],
  List<String> deleted = const [],
  Map<String, dynamic>? puzzles,
}) => jsonEncode({
  'format': backupFormat,
  'version': 1,
  'app': 'web',
  'settings': settings ?? AppSettings.defaults().toJson(),
  'history': history,
  'mistakes': mistakes,
  'deletedMistakes': deleted,
  'puzzles': puzzles ?? defaultProgress(),
});

Future<AppRepository> _repository() async {
  final repository = AppRepository();
  await repository.load();
  addTearDown(repository.dispose);
  return repository;
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  group('native chess rules', () {
    test(
      'validates FEN instead of silently falling back to an empty board',
      () {
        expect(position(startFen).fen, startFen);
        for (final invalid in [
          'bad fen',
          '8/8/8/8/8/8/8/8 w - - 0 1',
          '7k/8/8/8/8/8/8/K07 w - - 0 1',
          '7k/8/8/8/8/8/8/K7 w - - -1 1',
          '7k/8/8/8/8/8/8/KP6 w - - 0 1',
        ]) {
          expect(
            () => position(invalid),
            throwsFormatException,
            reason: invalid,
          );
        }
        expect(legalMoves(startFen), hasLength(20));
        expect(turnOf(startFen), 'w');
        expect(opposite('w'), 'b');
      },
    );

    test('keeps all four promotion choices and applies underpromotion', () {
      const fen = '8/P7/8/8/8/8/8/k6K w - - 0 1';
      final choices = legalMoves(fen).where((m) => m.from == 'a7').toList();
      expect(choices.map((m) => m.promotion).toSet(), {'q', 'r', 'b', 'n'});
      expect(choices.firstWhere((m) => m.promotion == 'q').san, 'a8=Q+');
      final game = position(fen);
      expect(playUci(game, 'a7a8'), isFalse);
      expect(playUci(game, 'a7a8n'), isTrue);
      expect(game.get('a8')!.type.name, 'n');
    });

    test('castling moves king and rook and cannot create a missing rook', () {
      final game = position('r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1');
      expect(playUci(game, 'e1g1'), isTrue);
      expect(game.get('g1')!.type.name, 'k');
      expect(game.get('f1')!.type.name, 'r');
      expect(game.get('h1'), isNull);
      expect(
        legalMoves('4k3/8/8/8/8/8/8/4K3 w KQ - 0 1')
            .any((m) => m.san.startsWith('O-O')),
        isFalse,
      );
    });

    test('en passant captures a pawn and a pinned capture is illegal', () {
      const fen = '4k3/8/8/3pP3/8/8/8/4K3 w - d6 0 1';
      final move = legalMoves(fen).firstWhere((m) => m.uci == 'e5d6');
      expect(move.captured, 'p');
      final game = position(fen);
      expect(playUci(game, move.uci), isTrue);
      expect(game.get('d5'), isNull);
      expect(game.get('d6')!.type.name, 'p');
      const pinned = '4r1k1/8/8/3pP3/8/8/8/4K3 w - d6 0 1';
      expect(legalMoves(pinned).any((m) => m.uci == 'e5d6'), isFalse);
      expect(positionKey(pinned).split(' ').last, '-');
      expect(positionKey(fen).split(' ').last, 'd6');
    });

    test(
      'threefold uses the complete line and ignores non-capturable ep targets',
      () {
        final tree = GameTree.fromMoves(startFen, [
          'e2e4',
          'g8f6',
          'g1f3',
          'f6g8',
          'f3g1',
          'g8f6',
          'g1f3',
          'f6g8',
          'f3g1',
        ]);
        final fens = tree.mainline().map((n) => n.fen).toList();
        expect(fens[1].split(' ')[3], '-');
        expect(terminalOf(fens.take(6).toList()), isNull);
        expect(terminalOf(fens), (result: '1/2-1/2', reason: 'threefold'));
      },
    );

    test('terminal reasons and checkmate priority match the original app', () {
      expect(terminalOf(['7k/6Q1/6K1/8/8/8/8/8 b - - 100 1']), (
        result: '1-0',
        reason: 'checkmate',
      ));
      expect(
        terminalOf(['7k/5Q2/6K1/8/8/8/8/8 b - - 0 1'])?.reason,
        'stalemate',
      );
      expect(
        terminalOf(['7k/8/8/8/8/8/8/K7 w - - 0 1'])?.reason,
        'insufficient',
      );
      expect(terminalOf(['7k/8/8/8/8/8/R7/K7 w - - 100 1'])?.reason, 'fifty');
      expect(terminalOf([]), isNull);
      expect(timeoutResult('7k/8/8/8/8/8/2B5/K7 b - - 0 1', 'b'), '1/2-1/2');
      expect(timeoutResult('7k/7p/8/8/8/8/2B5/K7 b - - 0 1', 'b'), '1-0');
      expect(timeoutResult('7k/8/8/8/8/8/R7/K7 w - - 0 1', 'b'), '1-0');
    });
  });

  group('game tree and PGN', () {
    test('real moves precede explorations and promote an existing child', () {
      final tree = GameTree(startFen);
      final scratch = tree.add(tree.root, 'd2d4', explore: true)!;
      expect(tree.root.mainChild, isNull);
      expect(tree.mainline(), [tree.root]);
      final real = tree.add(tree.root, 'e2e4')!;
      expect(tree.root.children, [real, scratch]);
      expect(tree.add(tree.root, 'd2d4'), same(scratch));
      expect(scratch.exploration, isFalse);
      final reply = tree.add(scratch, 'd7d5')!;
      expect(tree.pathTo(reply).map((n) => n.uci), ['', 'd2d4', 'd7d5']);
      tree.makeMainline(reply);
      expect(tree.mainline().last, same(reply));
      expect(tree.add(reply, 'd7d4'), isNull);
    });

    test(
      'serialization preserves notes, evidence, clocks and legacy fields',
      () {
        final raw = <String, dynamic>{
          'custom': {'legacy': true},
          'c': [
            {
              'u': 'e2e4',
              'n': [1, 5],
              'k': [298125, 300000],
              't': '中心',
              'e': {
                'hints': ['e7e5', 'bad', 'e7e5'],
                'info': true,
                'analysis': false,
              },
            },
            {'u': 'd2d4', 'x': 1},
          ],
        };
        final tree = GameTree.deserialize(startFen, raw);
        final first = tree.root.mainChild!;
        first.annotations['cache'] = 'transient';
        expect(first.nags, [1, 5]);
        expect(first.clock, [298125.0, 300000.0]);
        expect(first.evidence, {
          'hints': ['e7e5'],
          'info': true,
        });
        expect(tree.nodes(), hasLength(3));
        final serialized = tree.serialize();
        expect(serialized['custom'], {'legacy': true});
        expect(jsonEncode(serialized), isNot(contains('transient')));
        expect(
          GameTree.deserialize(startFen, serialized).serialize(),
          serialized,
        );
        expect(
          () => GameTree.deserialize(startFen, {
            'c': [
              {'u': 'e2e5'},
            ],
          }),
          throwsFormatException,
        );
      },
    );

    test('PGN round trips nested variations, escaped headers, NAGs and fractional clocks', () {
      const source = r'''[Event "A \"quoted\" ] title"]
[Result "*"]

{Root} 1.e4! {[%clk 0:04:58.125] central} ({alternative} $5 1.d4 d5 (1...Nf6)) 1...e5 {[%clk 0:04:57]} 2.Nf3 Nc6 *''';
      final parsed = parsePgn(source);
      expect(parsed.headers['Event'], 'A "quoted" ] title');
      expect(parsed.tree.root.comment, 'Root');
      final e4 = parsed.tree.root.children.first;
      final d4 = parsed.tree.root.children[1];
      expect(e4.nags, [1]);
      expect(e4.clock![0], 298125);
      expect(e4.children.first.clock, [298125.0, 297000.0]);
      expect(d4.comment, 'alternative');
      expect(d4.nags, [5]);
      expect(d4.children.map((n) => n.san), ['d5', 'Nf6']);
      parsed.tree.add(parsed.tree.root, 'c2c4', explore: true);
      final exported = exportPgn(parsed.tree, parsed.headers);
      expect(exported, isNot(contains('c4')));
      final restored = parsePgn(exported);
      expect(restored.headers, parsed.headers);
      expect(restored.tree.root.children, hasLength(2));
      expect(restored.tree.root.mainChild!.clock![0], 298125);
      expect(restored.tree.root.children[1].children[1].san, 'Nf6');
    });

    test('PGN starts from a black-to-move FEN, truncates null variations and splits safely', () {
      final fen = GameTree.fromMoves(startFen, ['e2e4']).mainline().last.fen;
      final parsed = parsePgn(
        '[FEN "$fen"]\n\n1... e5 (1... c5 -- 2.Nf3) 2.Nf3 *',
      );
      expect(parsed.truncated, isTrue);
      expect(parsed.tree.mainline().map((n) => n.san), ['', 'e5', 'Nf3']);
      final exported = exportPgn(parsed.tree, parsed.headers);
      expect(exported, contains('1... e5'));
      expect(parsePgn(exported).tree.startFen, fen);
      const multi =
          '[Event "one"]\n\n1.e4 {comment\n[Event "inside comment"]} *\n\n[Event "two"]\n\n1.d4 *';
      final split = splitPgn(multi);
      expect(split, hasLength(2));
      expect(split.map((p) => parsePgn(p).headers['Event']), ['one', 'two']);
      expect(splitPgn('1.e4 *\n1.d4 *'), hasLength(2));
      expect(() => parsePgn('1.e5 *'), throwsFormatException);
    });

    test('StoredGame keeps historical opponent and arbitrary backup data', () {
      final raw = {
        ..._game('legacy', elo: 1810),
        'legacyExtra': {'foo': 1},
        'ratingPending': true,
      };
      final stored = StoredGame.fromJson(raw);
      expect(stored.id, 'legacy');
      expect(stored.date, 100);
      expect(stored.toJson(), raw);
      stored.result = '1/2-1/2';
      expect(stored.toJson()['result'], '1/2-1/2');
      expect(
        GameTree.deserialize(stored.startFen, stored.tree).mainline(),
        hasLength(3),
      );
    });
  });

  group('settings and clock', () {
    test('native defaults and sanitization preserve unknown backup fields', () {
      final defaults = AppSettings.defaults();
      expect(
        [defaults.model, defaults.sfLite, defaults.sfThreads, defaults.sfHash],
        ['23m', false, 2, 128],
      );
      final settings = AppSettings.fromJson({
        'maiaElo': 1820,
        'ratedGames': 8,
        'legacy': {'enabled': true},
        'engineGen': 2,
        'sfThreads': 5,
        'sfHash': 256,
        'soundTheme': 'plastic',
        'theme': 'light',
        'pieceSet': 'invalid',
        'gameType': 'coach',
        'coachEval': true,
      });
      expect(settings.elo, 1800);
      expect(settings.playerElo, 1820);
      expect(settings['ratingDeviation'], 150);
      expect(settings.sfThreads, 2);
      expect(settings.sfHash, 256);
      expect(settings.soundTheme, 'glass');
      expect(settings.pieceSet, 'cburnett');
      expect(settings['aidEval'], isTrue);
      expect(settings.toJson()['legacy'], {'enabled': true});
      expect(
        AppSettings.fromJson(settings.toJson()).toJson(),
        settings.toJson(),
      );
      final invalid = AppSettings.fromJson({
        'playerElo': -1,
        'ratingDeviation': 500,
        'ratingStreak': 9,
        'elo': 1450,
        'temperature': double.nan,
      });
      expect(invalid.playerElo, 1500);
      expect(invalid.elo, 1400);
      expect(invalid['ratingDeviation'], 350);
      expect(invalid['ratingStreak'], 0);
      expect(invalid.temperature, 1.0);
    });

    test(
      'clock commits only on switch, pauses, restores, increments and flags',
      () {
        final clock = ChessClock('3+2');
        clock.run('w', 1000);
        expect(clock.time('w', 2500), 178500);
        clock.run('w', 2500);
        expect(clock.time('w', 3000), 178000);
        clock.moved('w', 3000);
        expect(clock.active, isNull);
        expect(clock.snapshot(10000), [180000.0, 180000.0]);
        clock.run('b', 10000);
        clock.stop(11000);
        expect(clock.snapshot(50000), [180000.0, 179000.0]);
        clock.run('w', 50000);
        clock.set([1000.0, 2000.0], 51000);
        expect(clock.time('w', 51500), 500);
        expect(clock.flagged(52001), 'w');
        clock.moved('w', 52001);
        expect(
          clock.remaining[0],
          0,
          reason: 'an expired clock receives no increment',
        );
        final untimed = ChessClock('none')..run('w', 0);
        expect(untimed.active, isNull);
        expect(formatClock(9300), '0:09.3');
        expect(formatClock(245000), '4:05');
        expect(formatClock(3723000), '1:02:03');
        expect(formatClock(-100), '0:00.0');
      },
    );
  });

  group('rating parity', () {
    Map<String, dynamic> rate({
      num result = 1,
      num opponent = 1500,
      num deviation = 350,
      num streak = 0,
      int undo = 0,
      Map<String, dynamic>? evidence,
      Map<String, dynamic>? performance,
    }) => computeRating(
      result: result,
      playerElo: 1500,
      opponentElo: opponent,
      deviation: deviation,
      streak: streak,
      undo: undo,
      evidence: evidence,
      performance: performance,
    );

    test('Glicko baseline, streak reopening and JS rounding match original numbers', () {
      expect(rate()['playerAfter'], 1675);
      final loss = rate(result: 0);
      expect(loss['playerAfter'], 1325);
      expect(loss['rdAfter'], closeTo(246.575715, 0.00001));
      expect(rate(result: 0.5)['delta'], 0);
      expect(
        rate(opponent: 1800)['delta'] as num,
        greaterThan(rate(opponent: 1200)['delta'] as num),
      );
      expect(rate(deviation: 80, streak: 2)['rdBefore'], 180);
      expect(rate(deviation: 80, streak: 7, result: 0.5)['streak'], 0);
      expect(jsRound(-1.5), -1);
    });

    test(
      'undo and assistance reduce gains, preserve losses and slow confidence',
      () {
        expect(rate(undo: 1)['delta'], rate()['delta']);
        expect(
          rate(undo: 4)['delta'] as num,
          lessThan(rate(undo: 1)['delta'] as num),
        );
        expect(rate(result: 0, undo: 8)['delta'], rate(result: 0)['delta']);
        final dependent = rate(evidence: {'dependence': 0.9});
        expect(dependent['delta'] as num, greaterThan(0));
        expect(dependent['delta'] as num, lessThan(rate()['delta'] as num));
        expect(
          dependent['rdAfter'] as num,
          greaterThan(rate()['rdAfter'] as num),
        );
        expect(dependent['streak'], 0);
        final abandoned = computeRating(
          result: 1,
          playerElo: 1500,
          opponentElo: 1500,
          deviation: 350,
          streak: 0,
          abandoned: true,
        );
        expect(abandoned['delta'], rate(result: 0)['delta']);
        expect(abandoned['abandoned'], isTrue);
      },
    );

    test('classifications and move-quality evidence use win percentages', () {
      expect(winPct(0), 50);
      expect(winPct(100), closeTo(59.1025900380, 0.000001));
      expect(moveAccuracy(50, 50), closeTo(99.9999, 0.000001));
      expect(judgeMove(before: 50, after: 35, playedBest: false), 'blunder');
      expect(
        judgeMove(before: 70, after: 60, playedBest: false, oppDrop: 12),
        'miss',
      );
      expect(
        judgeMove(before: 60, after: 59, playedBest: true, sacrifice: true),
        'brilliant',
      );
      expect(
        judgeMove(before: 60, after: 60, playedBest: true, secondGap: 21),
        'great',
      );
      expect(
        judgeMove(
          before: 60,
          after: 20,
          playedBest: false,
          book: true,
          forced: true,
        ),
        'forced',
      );
      final p = ratingPerformance(
        [
          {'before': 50.0, 'after': 0.0, 'forced': true},
          {'before': 98.0, 'after': 0.0},
          {'before': 50.0, 'after': 50.0},
        ],
        [
          {'before': 50.0, 'after': 40.0},
        ],
      )!;
      expect(p['playerMoves'], 1);
      expect(p['opponentMoves'], 1);
      expect(p['blunders'], 0);
      final e = ratingEvidence([
        {
          'uci': 'e2e4',
          'evidence': {
            'hints': ['e2e4'],
          },
        },
        {'uci': 'd2d4'},
      ], 5);
      expect(e['independent'], 1);
      expect(e['hintFollowed'], 1);
      expect(e['hints'], 5);
      expect(e['dependence'], 0.45);
    });
  });

  group('repository and legacy backups', () {
    setUp(() => SharedPreferences.setMockInitialValues({}));

    test('one-time WK migration preserves current game, all six keys and unknown fields', () async {
      final repository = await _repository();
      expect(repository.hasLocalData, isFalse);
      final live = {
        ..._game('live-wk'),
        'result': '',
        'clock': [55555.5, 60000],
        'oldField': {'x': 1},
      };
      final values = <String, String>{
        'maia-coach.settings': jsonEncode({
          ...AppSettings.defaults().toJson(),
          'theme': 'light',
          'oldSetting': 42,
        }),
        'maia-coach.game': jsonEncode(live),
        'maia-coach.history': jsonEncode([
          {..._game('wk-history', elo: 1810), 'extraGame': 'kept'},
        ]),
        'maia-coach.mistakes': jsonEncode([
          {
            ..._mistake('wk-mistake', tries: 7),
            'extraMistake': [1],
          },
        ]),
        'maia-coach.puzzles': jsonEncode({
          ...defaultProgress(),
          'rating': 1680,
          'games': 12,
          'extraProgress': true,
        }),
        'maia-coach.mistakes-deleted': jsonEncode(['deleted-on-web']),
        'maia-coach.future-data': 'keep original unparsed value',
      };
      await repository.importLegacyStorage(values);
      expect(repository.hasLocalData, isTrue);
      expect(repository.settings.theme, 'light');
      expect(repository.settings['oldSetting'], 42);
      expect(repository.history.single['elo'], 1810);
      expect(repository.history.single['extraGame'], 'kept');
      expect(repository.mistakes.single['tries'], 7);
      expect(repository.mistakes.single['extraMistake'], [1]);
      expect(repository.puzzles['extraProgress'], isTrue);
      expect(repository.currentGame, live);
      expect(repository.deletedMistakes, ['deleted-on-web']);
      final restored = await _repository();
      expect(restored.hasLocalData, isTrue);
      expect(restored.currentGame, live);
      expect((jsonDecode(restored.exportBackup()) as Map)['legacyStorage'], {
        'maia-coach.future-data': 'keep original unparsed value',
      });
      await expectLater(restored.importLegacyStorage(values), throwsStateError);
      expect(values['maia-coach.game'], jsonEncode(live));
    });

    test('WK migration validates everything before writing and may retry corrected input', () async {
      final repository = await _repository();
      for (final values in <Map<String, String>>[
        {'maia-coach.settings': '{broken'},
        {'maia-coach.history': '[{"id":"bad"}]'},
        {
          'maia-coach.game': jsonEncode({
            ..._game('bad-tree'),
            'tree': {
              'c': [
                {'u': 'e2e5'},
              ],
            },
          }),
        },
        {
          'maia-coach.mistakes': jsonEncode([
            {..._mistake('bad-mistake'), 'best': 'e2e5'},
          ]),
        },
      ]) {
        await expectLater(
          repository.importLegacyStorage(values),
          throwsFormatException,
        );
        expect(repository.hasLocalData, isFalse);
        expect(repository.currentGame, isNull);
        expect(repository.history, isEmpty);
        expect((await SharedPreferences.getInstance()).getKeys(), isEmpty);
      }
      await repository.importLegacyStorage({
        'maia-coach.history': jsonEncode([_game('valid')]),
      });
      expect(repository.history.single['id'], 'valid');
    });

    test('local settings alone prevent migration; empty legacy reads do not mark migrated', () async {
      SharedPreferences.setMockInitialValues({'maia-coach.settings': '{}'});
      final existing = await _repository();
      expect(existing.hasLocalData, isTrue);
      await expectLater(
        existing.importLegacyStorage({
          'maia-coach.game': jsonEncode(_game('remote')),
        }),
        throwsStateError,
      );
      SharedPreferences.setMockInitialValues({});
      final empty = await _repository();
      await empty.importLegacyStorage({});
      expect(empty.hasLocalData, isFalse);
      expect((await SharedPreferences.getInstance()).getKeys(), isEmpty);
    });

    test('save and migration propagate write failures without committing staged state', () async {
      final preferences = _Preferences()..failWrites = true;
      final repository = AppRepository(preferences: preferences);
      addTearDown(repository.dispose);
      await repository.load();
      final values = {'maia-coach.game': jsonEncode(_game('staged'))};
      await expectLater(
        repository.importLegacyStorage(values),
        throwsStateError,
      );
      expect(repository.hasLocalData, isFalse);
      expect(repository.currentGame, isNull);
      expect(preferences.disk, isEmpty);
      expect(preferences.cache, isEmpty);
      preferences.failWrites = false;
      await repository.importLegacyStorage(values);
      expect(repository.currentGame!['id'], 'staged');
      final saved = Map<String, String>.from(preferences.disk);
      preferences.failWrites = true;
      repository.settings['theme'] = 'light';
      await expectLater(repository.save(), throwsStateError);
      expect(preferences.disk, saved);
      expect(preferences.cache, saved);
    });

    test(
      'save/load retains complete records and keeps current game out of backup',
      () async {
        final repository = await _repository();
        repository.settings['theme'] = 'light';
        repository.settings['oldOption'] = {'enabled': true};
        repository.upsertGame({
          ..._game('historic'),
          'unknown': [1, 2],
        });
        repository.currentGame = {..._game('live'), 'result': ''};
        repository.addMistake({..._mistake('mistake-1'), 'legacyTag': 'saved'});
        await repository.save();
        final restored = await _repository();
        expect(restored.settings.theme, 'light');
        expect(restored.settings['oldOption'], {'enabled': true});
        expect(restored.history.single['unknown'], [1, 2]);
        expect(restored.mistakes.single['legacyTag'], 'saved');
        expect(restored.currentGame!['id'], 'live');
        final backup = jsonDecode(restored.exportBackup()) as Map;
        expect(backup.containsKey('currentGame'), isFalse);
        expect(backup['format'], backupFormat);
      },
    );

    test('merges ids, max tries, tombstones and rated progress while keeping local opponent', () async {
      final repository = await _repository();
      repository.settings['elo'] = 1800;
      repository.settings['model'] = '79m';
      repository.settings['playerElo'] = 1600;
      repository.settings['ratedGames'] = 4;
      repository.upsertGame(_game('same', elo: 1810));
      repository.addMistake(_mistake('trained', tries: 9));
      repository.addMistake(_mistake('remote-deleted'));
      repository.removeMistake('local-deleted');
      repository.puzzles.addAll({
        'games': 3,
        'rating': 1300,
        'recent': ['local'],
      });
      final incomingSettings = AppSettings.defaults().toJson()
        ..addAll({
          'elo': 600,
          'model': '5m',
          'playerElo': 1777,
          'ratedGames': 12,
          'ratingDeviation': 95.5,
          'ratingStreak': 3,
          'unknownBackupSetting': 42,
        });
      final skipped = await repository.importBackup(
        _backup(
          settings: incomingSettings,
          history: [
            _game('same', elo: 600),
            _game('newer', date: 200),
            {'id': 'bad'},
          ],
          mistakes: [
            _mistake('trained', tries: 2),
            _mistake('local-deleted', tries: 20),
            _mistake('fresh', tries: 5),
            _mistake('fresh', tries: 8),
          ],
          deleted: ['remote-deleted'],
          puzzles: {
            ...defaultProgress(),
            'games': 8,
            'rating': 1550,
            'recent': ['remote'],
          },
        ),
      );
      expect(skipped, 1);
      expect(repository.history.map((g) => g['id']), ['newer', 'same']);
      expect(repository.history.last['elo'], 1810);
      expect(repository.settings.elo, 1800);
      expect(repository.settings.model, '79m');
      expect(repository.settings.playerElo, 1777);
      expect(repository.settings['ratedGames'], 12);
      expect(repository.settings['unknownBackupSetting'], 42);
      expect(repository.mistakes.map((m) => m['id']).toSet(), {
        'trained',
        'fresh',
      });
      expect(
        repository.mistakes.firstWhere((m) => m['id'] == 'trained')['tries'],
        9,
      );
      expect(
        repository.mistakes.firstWhere((m) => m['id'] == 'fresh')['tries'],
        8,
      );
      expect(repository.deletedMistakes.toSet(), {
        'local-deleted',
        'remote-deleted',
      });
      expect(repository.puzzles['rating'], 1550);
      expect(repository.puzzles['recent'], ['local', 'remote']);
      await repository.importBackup(
        _backup(
          settings: {...incomingSettings, 'ratedGames': 1, 'playerElo': 900},
        ),
      );
      expect(repository.settings.playerElo, 1777);
      final restored = await _repository();
      expect(restored.settings.playerElo, 1777);
      expect(restored.deletedMistakes, repository.deletedMistakes);
    });

    test(
      'replace validates v1 and preserves unknown fields through export',
      () async {
        final repository = await _repository();
        repository.upsertGame(_game('old'));
        final raw = jsonDecode(
          _backup(history: [_game('replacement')]),
        ) as Map<String, dynamic>;
        raw['legacySection'] = {
          'entries': [1, 2],
        };
        await repository.importBackup(jsonEncode(raw), replace: true);
        expect(repository.history.single['id'], 'replacement');
        expect(
          (jsonDecode(repository.exportBackup()) as Map)['legacySection'],
          {
            'entries': [1, 2],
          },
        );
        for (final version in [0, 2, '1']) {
          await expectLater(
            repository.importBackup(jsonEncode({...raw, 'version': version})),
            throwsFormatException,
          );
        }
        await expectLater(
          repository.importBackup('bad JSON'),
          throwsFormatException,
        );
        expect(repository.history.single['id'], 'replacement');
      },
    );

    test(
      'scheduled training counts early tries without accelerating mastery',
      () async {
        final repository = await _repository();
        repository.addMistake(_mistake('spaced'));
        expect(repository.gradeMistake('spaced', true, now: 0), isTrue);
        expect(repository.mistakes.single['due'], 86400000);
        expect(repository.gradeMistake('spaced', true, now: 1), isFalse);
        expect(repository.mistakes.single['tries'], 2);
        expect(repository.mistakes.single['streak'], 1);
        for (var i = 0; i < 3; i++) {
          expect(
            repository.gradeMistake(
              'spaced',
              true,
              now: (repository.mistakes.single['due'] as num).toInt(),
            ),
            isTrue,
          );
        }
        expect(repository.mistakes.single['mastered'], isTrue);
        final due = (repository.mistakes.single['due'] as num).toInt();
        expect(repository.gradeMistake('spaced', false, now: due), isTrue);
        expect(repository.mistakes.single.containsKey('mastered'), isFalse);
        expect(repository.mistakes.single['streak'], 0);
        expect(repository.mistakes.single['due'], due + 600000);
        repository.removeMistake('spaced');
        expect(repository.addMistake(_mistake('spaced')), 0);
      },
    );

    test(
      'corrupt local JSON or malformed entries throw and disable saving',
      () async {
        SharedPreferences.setMockInitialValues({
          'maia-coach.history': '{broken',
        });
        final repository = AppRepository();
        addTearDown(repository.dispose);
        await expectLater(repository.load(), throwsFormatException);
        expect(() => repository.save(), throwsStateError);
        final prefs = await SharedPreferences.getInstance();
        expect(prefs.getString('maia-coach.history'), '{broken');
        expect(
          prefs.getKeys().where((k) => k.contains('flutter.domain')),
          isEmpty,
        );
        SharedPreferences.setMockInitialValues({
          'maia-coach.history': '[{"id":"bad"}]',
        });
        final malformed = AppRepository();
        addTearDown(malformed.dispose);
        await expectLater(malformed.load(), throwsFormatException);
        expect(() => malformed.save(), throwsStateError);
      },
    );
  });

  group('puzzles and openings', () {
    test('puzzle bands load as assets, choose unseen themes and cache reads', () async {
      final assets = _Assets({
        'assets/puzzles/index.json': jsonEncode({
          'bands': [
            {'lo': 1000, 'hi': 1400, 'file': 'b1000.csv', 'count': 2},
            {'lo': 1400, 'hi': 1800, 'file': 'b1400.csv', 'count': 1},
          ],
        }),
        'assets/puzzles/b1000.csv':
            'one,$startFen,e2e4 e7e5,1200,fork opening\ntwo,$startFen,d2d4 d7d5,1250,pin',
        'assets/puzzles/b1400.csv': 'three,$startFen,e2e4 e7e5,1500,fork',
      });
      final service = PuzzleService(assets: assets, random: () => 0.5);
      final progress = defaultProgress()..['recent'] = ['one'];
      final puzzle = await service.nextPuzzle(progress, theme: 'fork');
      expect(puzzle!.id, 'three');
      expect(await service.nextPuzzle(progress, theme: 'fork'), same(puzzle));
      expect(assets.reads['assets/puzzles/index.json'], 1);
      expect(assets.reads['assets/puzzles/b1000.csv'], 1);
      expect(recordPuzzle(progress, puzzle, true), greaterThan(0));
      expect(progress['games'], 1);
      expect((progress['byTheme'] as Map)['fork'], [1, 0]);
      expect(progress['recent'], ['one', 'three']);
      expect(await service.nextPuzzle(progress, theme: 'fork'), isNull);
    });

    test(
      'failed asset loads retry and correct alternate mates are accepted',
      () async {
        final assets = _Assets({});
        final service = PuzzleService(assets: assets);
        await expectLater(
          service.nextPuzzle(defaultProgress()),
          throwsStateError,
        );
        assets.files['assets/puzzles/index.json'] = '{"bands": []}';
        expect(await service.nextPuzzle(defaultProgress()), isNull);
        const fen = '7k/8/5KQ1/8/8/8/8/8 w - - 0 1';
        expect(acceptsMove(fen, 'g6g7', 'g6h6'), isTrue);
        expect(acceptsMove(startFen, 'e2e4', 'e2e4'), isTrue);
        expect(acceptsMove(startFen, 'e2e5', 'e2e5'), isFalse);
      },
    );

    test(
      'opening FNV matches JS and identifies deepest translated family',
      () async {
        expect(fnv('hello'), 0x4f9f2cab);
        final line = GameTree.fromMoves(startFen, [
          'e2e4',
          'e7e5',
          'g1f3',
          'b8c6',
          'f1b5',
          'a7a6',
        ]);
        final named = line.mainline()[5].fen;
        final hash = fnv(named.split(' ').take(4).join(' ')).toRadixString(36);
        final assets = _Assets({
          'assets/data/openings.json': jsonEncode({
            'data': hash,
            'ids': '0',
            'names': ['C60\tRuy Lopez: Test Variation'],
          }),
          'assets/data/opening-zh.json': jsonEncode({'Ruy Lopez': '西班牙开局'}),
        });
        final book = OpeningBook(assets: assets);
        expect(book.identify([named]), isNull);
        await book.load();
        final fens = line.mainline().map((n) => n.fen);
        expect(book.identify(fens), '西班牙开局（C60）');
        expect(book.english(fens), 'Ruy Lopez: Test Variation（C60）');
        expect(book.inBook(named), isTrue);
        expect(book.inBook(startFen), isFalse);
      },
    );

    test(
      'bundled real opening and puzzle assets integrate with Dart rules',
      () async {
        final book = OpeningBook();
        await book.load();
        final tree = GameTree.fromMoves(startFen, [
          'e2e4',
          'e7e5',
          'g1f3',
          'b8c6',
          'f1b5',
        ]);
        expect(
          book.identify(tree.mainline().map((n) => n.fen)),
          contains('西班牙开局'),
        );
        final puzzle = await PuzzleService(random: () => 0.5)
            .nextPuzzle(defaultProgress());
        expect(puzzle, isNotNull);
        final game = position(puzzle!.fen);
        for (final move in puzzle.moves) {
          expect(playUci(game, move), isTrue, reason: '${puzzle.id}: $move');
        }
      },
    );
  });
}
