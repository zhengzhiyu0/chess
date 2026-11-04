import 'dart:async';
import 'dart:collection';
import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:maia_coach/app_controller.dart';
import 'package:maia_coach/core/chess.dart';
import 'package:maia_coach/core/game.dart';
import 'package:maia_coach/core/rating.dart';
import 'package:maia_coach/core/sampling.dart';
import 'package:maia_coach/core/settings.dart';
import 'package:maia_coach/core/storage.dart';
import 'package:maia_coach/services/engines.dart';
import 'package:shared_preferences/shared_preferences.dart';

class _PredictionRequest {
  _PredictionRequest(this.fen);
  final String fen;
  final result = Completer<MaiaPrediction>();

  void complete(String uci) {
    result.complete(
      MaiaPrediction(
        moves: [ScoredMove(uci: uci, logit: 0, p: 1)],
        wdl: const [.3, .4, .3],
        ms: 1,
      ),
    );
  }
}

/// stop deliberately leaves prediction futures pending: a late platform reply
/// must be rejected by the controller, even if the backend cannot cancel it.
class _Engine extends Fake implements EngineService {
  @override
  void Function()? onChanged;
  final predictions = <_PredictionRequest>[];
  final events = <String>[];
  final configurations = <String>[];
  final initializeGates = Queue<Completer<void>>();
  final stopGates = Queue<Completer<void>>();
  final suspendGates = Queue<Completer<void>>();
  final _outstandingGates = <Completer<void>>{};
  int initializeCalls = 0, stopCalls = 0, suspendCalls = 0, unloadCalls = 0;
  int _initializeGeneration = 0;
  bool _ready = true, suspended = false, disposed = false;

  @override
  bool get ready => _ready && !suspended && !disposed;
  @override
  bool get maiaReady => ready;
  @override
  bool get stockfishReady => ready;
  @override
  bool get native => false;
  @override
  String get status => ready ? 'ready' : 'suspended';
  @override
  String? get error => null;

  Future<void> _wait(Queue<Completer<void>> gates) async {
    if (gates.isEmpty) return;
    final gate = gates.removeFirst();
    _outstandingGates.add(gate);
    try {
      await gate.future;
    } finally {
      _outstandingGates.remove(gate);
    }
  }

  @override
  Future<void> initialize({
    String model = '23m',
    int threads = 2,
    int hash = 128,
    bool lite = false,
  }) async {
    initializeCalls++;
    final generation = ++_initializeGeneration;
    events.add('initialize:start');
    configurations.add('$model/$threads/$hash/$lite');
    if (ready && initializeGates.isEmpty) {
      events.add('initialize:end');
      return;
    }
    _ready = false;
    suspended = false;
    await _wait(initializeGates);
    if (disposed || generation != _initializeGeneration) {
      throw StateError('initialization cancelled');
    }
    _ready = true;
    events.add('initialize:end');
    onChanged?.call();
  }

  @override
  Future<MaiaPrediction> predict(
    String fen, {
    required int selfElo,
    required int opponentElo,
  }) {
    if (!ready) throw StateError('prediction while engine is unavailable');
    final request = _PredictionRequest(fen);
    predictions.add(request);
    return request.result.future;
  }

  @override
  Future<Analysis> analyse(
    String fen, {
    int milliseconds = 1000,
    int multipv = 3,
    String? startFen,
    List<String> moves = const [],
  }) async => const Analysis();

  @override
  Future<void> stop() async {
    stopCalls++;
    events.add('stop:start');
    await _wait(stopGates);
    events.add('stop:end');
  }

  @override
  Future<void> suspend() async {
    suspendCalls++;
    events.add('suspend:start');
    _initializeGeneration++;
    suspended = true;
    _ready = false;
    await _wait(suspendGates);
    events.add('suspend:end');
  }

  @override
  Future<void> unloadMaia() async {
    unloadCalls++;
    _ready = false;
    events.add('unload');
  }

  @override
  Future<Map<String, dynamic>> deviceInfo() async => {'native': false};
  @override
  Future<String> logs() async => events.join('\n');

  @override
  Future<void> dispose() async {
    disposed = true;
    _initializeGeneration++;
    for (final gate in [
      ..._outstandingGates,
      ...initializeGates,
      ...stopGates,
      ...suspendGates,
    ]) {
      if (!gate.isCompleted) gate.complete();
    }
    for (final request in predictions) {
      if (!request.result.isCompleted) {
        request.result.complete(
          const MaiaPrediction(moves: [], wdl: [0, 1, 0], ms: 0),
        );
      }
    }
  }
}

class _Preferences extends Fake implements SharedPreferences {
  _Preferences(this.delegate);
  final SharedPreferences delegate;
  final writeGates = Queue<Completer<void>>();
  final blockedWrites = <Completer<void>>{};
  int writes = 0;

  @override
  bool containsKey(String key) => delegate.containsKey(key);
  @override
  String? getString(String key) => delegate.getString(key);
  @override
  Future<bool> setString(String key, String value) async {
    writes++;
    if (writeGates.isNotEmpty) {
      final gate = writeGates.removeFirst();
      blockedWrites.add(gate);
      try {
        await gate.future;
      } finally {
        blockedWrites.remove(gate);
      }
    }
    return delegate.setString(key, value);
  }

  @override
  Future<void> reload() => delegate.reload();
}

class _Harness {
  _Harness(this.app, this.engine, this.preferences);
  final AppController app;
  final _Engine engine;
  final _Preferences preferences;
  bool _disposed = false;

  static Future<_Harness> create({
    String timeControl = 'none',
    Map<String, Object> extraPreferences = const {},
  }) async {
    SharedPreferences.setMockInitialValues({
      'maia-coach.settings': jsonEncode({
        ...AppSettings.defaults().toJson(),
        'color': 'w',
        'sound': false,
        'haptics': false,
        'thinkDelay': false,
        'timeControl': timeControl,
      }),
      ...extraPreferences,
    });
    final preferences = _Preferences(await SharedPreferences.getInstance());
    final engine = _Engine();
    final app = AppController(
      repository: AppRepository(preferences: preferences),
      engines: engine,
    );
    final harness = _Harness(app, engine, preferences);
    addTearDown(harness.dispose);
    await app.load();
    await app.warmup();
    expect(app.storageReady, isTrue, reason: app.error);
    expect(app.error, isNull);
    return harness;
  }

  Future<AppRepository> reload() async {
    final repository = AppRepository(preferences: preferences);
    await repository.load();
    addTearDown(repository.dispose);
    return repository;
  }

  Future<_PredictionRequest> play(String uci) async {
    final index = engine.predictions.length;
    await app.playMove(uci);
    await _until(() => engine.predictions.length > index);
    return engine.predictions[index];
  }

  Future<void> reply(_PredictionRequest request, String uci) async {
    request.complete(uci);
    await _until(() => app.node?.uci == uci && !app.thinking);
  }

  Future<void> dispose() async {
    if (_disposed) return;
    _disposed = true;
    for (final gate in [
      ...preferences.blockedWrites,
      ...preferences.writeGates,
    ]) {
      if (!gate.isCompleted) gate.complete();
    }
    app.dispose();
    await _flush();
    app.repository.dispose();
  }
}

Future<void> _flush() async {
  for (var i = 0; i < 12; i++) {
    await Future<void>.delayed(Duration.zero);
  }
}

Future<void> _until(bool Function() done) async {
  for (var i = 0; i < 200 && !done(); i++) {
    await Future<void>.delayed(Duration.zero);
  }
  expect(
    done(),
    isTrue,
    reason: 'controlled asynchronous operation did not finish',
  );
}

Map<String, dynamic> _snapshot(Map<String, dynamic> value) =>
    Map<String, dynamic>.from(jsonDecode(jsonEncode(value)) as Map);

Map<String, dynamic> _historyGame(String id) => {
  'id': id,
  'date': 1700000000000,
  'startFen': startFen,
  'tree': GameTree.fromMoves(startFen, ['d2d4', 'd7d5']).serialize(),
  'userColor': 'w',
  'result': '1-0',
  'elo': 1500,
  'playerElo': 1500,
  'model': '23m',
  'tc': 'none',
  'assists': {'undo': 0, 'hint': 0, 'aids': false},
  'headers': {'White': 'Alice', 'Black': 'Bob'},
};

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  test('historical review and explorations never overwrite the durable live game or history', () async {
    final h = await _Harness.create();
    await h.app.startGame();
    await h.play('e2e4');
    h.app.repository.upsertGame(_historyGame('history-a'));
    await h.app.persist();
    final live = _snapshot(h.app.repository.currentGame!);
    final historical = _snapshot(h.app.repository.history.single);
    final liveFen = h.app.fen;

    await h.app.reviewGame(h.app.repository.history.single);
    await h.app.playMove('e2e4');
    expect(h.app.node!.exploration, isTrue);
    await h.app.persist();
    await h.app.setForeground(false);
    expect(h.app.repository.currentGame, live);
    expect(h.app.repository.history.single, historical);
    final disk = await h.reload();
    expect(disk.currentGame, live);
    expect(disk.history.single, historical);

    await h.app.showPage(AppPage.home);
    expect(h.app.game!['id'], live['id']);
    expect(h.app.fen, liveFen);
    expect(h.app.tree!.mainline().map((node) => node.uci), ['', 'e2e4']);
    expect(h.app.assisted, isFalse);
  });

  test(
    'review without a live game cannot create a resumable currentGame slot',
    () async {
      final h = await _Harness.create();
      h.app.repository.upsertGame(_historyGame('history-only'));
      await h.app.repository.save();
      await h.app.reviewGame(h.app.repository.history.single);
      await h.app.playMove('e2e4');
      await h.app.persist();
      expect((await h.reload()).currentGame, isNull);
      await h.app.showPage(AppPage.home);
      expect(h.app.game, isNull);
      expect(h.app.tree, isNull);
      expect(h.app.node, isNull);
    },
  );

  test('reviewing own unfinished game marks practice but discards exploratory moves', () async {
    final h = await _Harness.create();
    await h.app.startGame();
    final id = h.app.game!['id'];
    await h.app.reviewGame();
    await h.app.playMove('d2d4');
    await h.app.persist();
    final disk = await h.reload();
    expect(disk.currentGame!['id'], id);
    expect((disk.currentGame!['assists'] as Map)['aids'], isTrue);
    expect(
      GameTree.deserialize(
        startFen,
        disk.currentGame!['tree'] as Map,
      ).mainline(),
      hasLength(1),
    );
    await h.app.resumeGame();
    expect(h.app.fen, startFen);
    await h.app.resign();
    expect(h.app.settings['ratedGames'], 0);
    expect(h.app.game!['rating'], isNull);
  });

  test(
    'PGN import preserves a pending live game and restores it after review',
    () async {
      final h = await _Harness.create();
      await h.app.startGame();
      await h.play('e2e4');
      final live = _snapshot(h.app.repository.currentGame!);
      await h.app.importPgn(
        '[Event "External"]\n[White "Alice"]\n[Black "Bob"]\n\n1. d4 d5 1-0',
      );
      expect(h.app.inReview, isTrue);
      await h.app.persist();
      final disk = await h.reload();
      expect(disk.currentGame, live);
      expect(disk.history.single['imported'], isTrue);
      expect(disk.history.single['headers'], containsPair('White', 'Alice'));
      await h.app.showPage(AppPage.home);
      expect(h.app.game!['id'], live['id']);
    },
  );

  test(
    'concurrent resign calls lock the outcome and persist exactly one rating',
    () async {
      final h = await _Harness.create();
      await h.app.startGame();
      final expected = computeRating(
        result: 0,
        playerElo: 1500,
        opponentElo: 1500,
        deviation: 350,
        streak: 0,
      );
      final gate = Completer<void>();
      h.engine.stopGates.add(gate);
      final first = h.app.resign();
      expect(h.app.result, '0-1');
      final second = h.app.resign();
      await second;
      gate.complete();
      await first;
      await h.app.resign();
      expect(h.app.settings['ratedGames'], 1);
      expect(h.app.settings.playerElo, expected['playerAfter']);
      expect(h.app.game!['rating'], expected);
      final disk = await h.reload();
      expect(disk.settings['ratedGames'], 1);
      expect(disk.settings.playerElo, expected['playerAfter']);
      expect(disk.history, hasLength(1));
      expect(disk.history.single['rating'], expected);
      expect(disk.currentGame!['result'], '0-1');
    },
  );

  test(
    'assisted game stores its result without changing rating or rating count',
    () async {
      final h = await _Harness.create();
      await h.app.startGame();
      await h.app.markPractice();
      await h.app.resign();
      final disk = await h.reload();
      expect(disk.settings.playerElo, 1500);
      expect(disk.settings['ratedGames'], 0);
      expect(disk.history.single['rating'], isNull);
      expect(disk.history.single['result'], '0-1');
      expect((disk.history.single['assists'] as Map)['aids'], isTrue);
    },
  );

  test('midgame self-rating edit survives settlement from the original game estimate', () async {
    final h = await _Harness.create();
    await h.app.startGame();
    await h.app.updateSetting('playerElo', 1800);
    await h.app.resign();
    final disk = await h.reload();
    expect(disk.settings.playerElo, 1800);
    expect(disk.settings['ratingDeviation'], 350);
    expect((disk.history.single['rating'] as Map)['playerBefore'], 1500);
  });

  test('late prediction from the old game cannot move or clear thinking in the new game', () async {
    final h = await _Harness.create();
    await h.app.startGame();
    final old = await h.play('e2e4');
    await h.app.startGame();
    final id = h.app.game!['id'];
    final current = await h.play('d2d4');
    old.complete('e7e5');
    await _flush();
    expect(h.app.game!['id'], id);
    expect(h.app.node!.uci, 'd2d4');
    expect(h.app.thinking, isTrue);
    expect(h.app.error, isNull);
    await h.reply(current, 'd7d5');
    expect(h.app.tree!.mainline().map((node) => node.uci), [
      '',
      'd2d4',
      'd7d5',
    ]);
    expect((await h.reload()).currentGame!['id'], id);
  });

  test(
    'late failed prediction from an old game cannot stop the new game clock',
    () async {
      final h = await _Harness.create(timeControl: '3+2');
      await h.app.startGame();
      final old = await h.play('e2e4');
      await h.app.startGame();
      await h.play('d2d4');
      old.result.completeError(StateError('late native cancellation'));
      await _flush();
      expect(h.app.thinking, isTrue);
      expect(h.app.error, isNull);
      expect(h.app.clock!.active, 'b');
    },
  );

  test(
    'premove chain keeps the next Maia prediction marked as thinking',
    () async {
      final h = await _Harness.create();
      await h.app.startGame();
      final first = await h.play('e2e4');
      h.app.queuePremove('g1f3');
      first.complete('e7e5');
      await _until(() => h.engine.predictions.length == 2);
      await _flush();
      expect(h.app.node!.uci, 'g1f3');
      expect(h.app.thinking, isTrue);
      expect(h.app.premoveUci, isNull);
      await h.reply(h.engine.predictions[1], 'b8c6');
      expect(h.app.node!.ply, 4);
    },
  );

  test(
    'foreground waits for pending background suspend before reinitializing',
    () async {
      final h = await _Harness.create(timeControl: '3+2');
      await h.app.startGame();
      final gate = Completer<void>();
      h.engine.suspendGates.add(gate);
      final initializations = h.engine.initializeCalls;
      final background = h.app.setForeground(false);
      await _until(() => h.engine.events.contains('suspend:start'));
      final foreground = h.app.setForeground(true);
      await _flush();
      expect(h.app.foreground, isTrue);
      expect(h.app.clock!.active, isNull);
      expect(h.engine.initializeCalls, initializations);
      gate.complete();
      await Future.wait([background, foreground]);
      expect(
        h.engine.events.lastIndexOf('initialize:start'),
        greaterThan(h.engine.events.indexOf('suspend:end')),
      );
      expect(h.engine.ready, isTrue);
      expect(h.app.clock!.active, 'w');
      expect(h.app.error, isNull);
    },
  );

  test(
    'cancelled warmup cannot replace or clear the newer foreground warmup',
    () async {
      final h = await _Harness.create();
      final initializations = h.engine.initializeCalls;
      final oldGate = Completer<void>();
      h.engine.initializeGates.add(oldGate);
      final old = h.app.warmup();
      await _until(() => h.engine.initializeCalls == initializations + 1);
      await h.app.setForeground(false);
      final newGate = Completer<void>();
      h.engine.initializeGates.add(newGate);
      final foreground = h.app.setForeground(true);
      await _until(() => h.engine.initializeCalls == initializations + 2);
      final current = h.app.warmup();
      oldGate.complete();
      await old;
      await _flush();
      expect(identical(h.app.warmup(), current), isTrue);
      expect(h.engine.initializeCalls, initializations + 2);
      expect(h.app.error, isNull);
      newGate.complete();
      await Future.wait([current, foreground]);
      expect(h.engine.ready, isTrue);
      expect(h.app.error, isNull);
    },
  );

  test('background freezes and persists the clock, and foreground resumes the same side', () async {
    final h = await _Harness.create(timeControl: '3+2');
    await h.app.startGame();
    h.app.clock!.set([123000, 117000], 0);
    await h.app.setForeground(false);
    final pausedWhite = h.app.timeFor('w')!;
    final pausedBlack = h.app.timeFor('b')!;
    final disk = await h.reload();
    expect(disk.currentGame!['clock'], [pausedWhite, pausedBlack]);
    await _flush();
    expect(h.app.timeFor('w'), pausedWhite);
    expect(h.app.timeFor('b'), pausedBlack);
    expect(h.app.clock!.active, isNull);
    await h.app.setForeground(true);
    expect(h.app.clock!.active, 'w');
    expect(h.app.timeFor('w'), lessThanOrEqualTo(pausedWhite));
    expect(h.app.timeFor('b'), pausedBlack);
  });

  test('invalid FEN is rejected before abandoning or overwriting a rated live game', () async {
    final h = await _Harness.create();
    await h.app.startGame();
    await h.reply(await h.play('e2e4'), 'e7e5');
    await h.reply(await h.play('g1f3'), 'b8c6');
    await h.reply(await h.play('f1c4'), 'g8f6');
    final live = _snapshot(h.app.repository.currentGame!);
    final fen = h.app.fen;
    for (final invalid in ['not a FEN', '8/8/8/8/8/8/8/8 w - - 0 1']) {
      await expectLater(
        h.app.startGame(fromFen: invalid),
        throwsFormatException,
      );
      expect(h.app.repository.currentGame, live);
      expect(h.app.fen, fen);
      expect(h.app.ended, isFalse);
      expect(h.app.repository.history, isEmpty);
      expect(h.app.settings['ratedGames'], 0);
    }
    expect((await h.reload()).currentGame, live);
  });

  for (final terminal in [
    (fen: '7k/6Q1/6K1/8/8/8/8/8 b - - 0 1', result: '1-0', reason: 'checkmate'),
    (
      fen: '7k/5Q2/6K1/8/8/8/8/8 b - - 0 1',
      result: '1/2-1/2',
      reason: 'stalemate',
    ),
    (
      fen: '7k/8/8/8/8/8/8/K7 w - - 0 1',
      result: '1/2-1/2',
      reason: 'insufficient',
    ),
  ]) {
    test(
      'terminal ${terminal.reason} FEN settles without prediction, clock, or rating',
      () async {
        final h = await _Harness.create(timeControl: '3+2');
        await h.app.startGame(fromFen: terminal.fen);
        await _flush();
        expect(h.app.result, terminal.result);
        expect(h.app.game!['reason'], terminal.reason);
        expect(h.app.game!['imported'], isTrue);
        expect(h.app.clock!.active, isNull);
        expect(h.engine.predictions, isEmpty);
        final disk = await h.reload();
        expect(disk.settings['ratedGames'], 0);
        expect(disk.history.single['result'], terminal.result);
        expect(disk.history.single['rating'], isNull);
        expect(disk.currentGame!['reason'], terminal.reason);
      },
    );
  }

  for (final legacyRoot in [false, true]) {
    test(
      'undo to ${legacyRoot ? 'legacy ' : ''}root restores starting clock and marks practice',
      () async {
        final h = await _Harness.create(timeControl: '3+2');
        await h.app.startGame();
        if (legacyRoot) h.app.tree!.root.clock = null;
        h.app.clock!.set([125000, 117000], 0);
        await h.play('e2e4');
        await h.app.undo();
        expect(h.app.fen, startFen);
        expect(h.app.node, same(h.app.tree!.root));
        expect(h.app.clock!.active, 'w');
        expect(h.app.timeFor('w'), closeTo(180000, 1000));
        expect(h.app.timeFor('b'), 180000);
        expect(h.app.assisted, isTrue);
        expect((h.app.game!['assists'] as Map)['undo'], 1);
        expect(h.app.thinking, isFalse);
        await h.app.showPage(AppPage.home);
        final disk = await h.reload();
        expect((disk.currentGame!['clock'] as List)[1], 180000);
        expect(
          GameTree.deserialize(
            startFen,
            disk.currentGame!['tree'] as Map,
          ).mainline(),
          hasLength(1),
        );
      },
    );
  }

  test(
    'disposal ignores late initialization and prediction completions',
    () async {
      final h = await _Harness.create();
      await h.app.startGame();
      final prediction = await h.play('e2e4');
      final initializations = h.engine.initializeCalls;
      final initialization = Completer<void>();
      h.engine.initializeGates.add(initialization);
      final warmup = h.app.warmup();
      await _until(() => h.engine.initializeCalls == initializations + 1);
      final live = _snapshot(h.app.repository.currentGame!);
      prediction.complete('e7e5');
      await h.dispose();
      await warmup;
      await _flush();
      expect(h.app.repository.currentGame, live);
      expect(h.app.error, isNull);
      expect(h.engine.disposed, isTrue);
    },
  );

  test('corrupt optional sampling data leaves ordinary storage and game play available', () async {
    final h = await _Harness.create(
      extraPreferences: {SamplingStore.storageKey: 'broken sampling JSONL'},
    );
    expect(h.app.loaded, isTrue);
    expect(h.app.storageReady, isTrue);
    expect(h.app.samplingStore.loaded, isFalse);
    expect(h.app.notice, contains('采样'));
    expect(h.app.error, isNull);
    await h.app.startGame();
    await h.play('e2e4');
    expect((await h.reload()).currentGame, isNotNull);
    expect(
      h.preferences.getString(SamplingStore.storageKey),
      'broken sampling JSONL',
    );
  });

  test('sampling capture records committed decisions in its own slot with real probabilities', () async {
    final h = await _Harness.create();
    await h.app.updateSetting('samplingCapture', true);
    await h.app.startGame();
    final id = h.app.game!['id'];
    final reply = await h.play('e2e4');
    await h.reply(reply, 'e7e5');
    await _until(() => h.app.samplingStore.decisions == 1);
    final capture = h.app.samplingStore.records.single;
    expect(capture['gameId'], id);
    expect(capture['selected'], 'e7e5');
    expect(capture['rawMoves'], [
      {'uci': 'e7e5', 'p': 1.0, 'logit': 0.0},
    ]);
    expect((capture['distribution'] as List).single, containsPair('p', 1.0));
    expect(capture['fen'], reply.fen);
    expect(h.preferences.getString(SamplingStore.storageKey), isNotNull);
    expect(h.app.repository.exportBackup(), isNot(contains('rawMoves')));
    expect((await h.reload()).currentGame!['id'], id);
  });

  test('late cancelled prediction creates no sampling capture', () async {
    final h = await _Harness.create();
    await h.app.updateSetting('samplingCapture', true);
    await h.app.startGame();
    final old = await h.play('e2e4');
    await h.app.startGame();
    old.complete('e7e5');
    await _flush();
    expect(h.app.samplingStore.decisions, 0);
    expect(h.app.fen, startFen);
    expect(h.app.error, isNull);
  });

  test('starting a new game applies changed engine parameters even when already ready', () async {
    final h = await _Harness.create();
    await h.app.startGame();
    await h.app.warmup();
    await h.app.updateSetting('model', '5m');
    await h.app.updateSetting('sfThreads', 3);
    await h.app.updateSetting('sfHash', 64);
    await h.app.updateSetting('sfLite', true);
    await h.app.startGame();
    await h.app.warmup();
    expect(h.engine.configurations.last, '5m/3/64/true');
    expect(h.app.game!['model'], '5m');
    expect(h.engine.ready, isTrue);
  });

  test('tactical aids report the configured player color and mark the game unrated', () async {
    final h = await _Harness.create();
    await h.app.updateSetting('color', 'b');
    await h.app.updateSetting('aidHanging', true);
    await h.app.startGame(fromFen: '4k3/8/8/3n4/8/8/8/3RK3 b - - 0 1');
    await h.app.warmup();
    expect(h.app.hanging, ['d5']);
    expect(h.app.assisted, isTrue);
    await h.app.updateSetting('aidHanging', false);
    expect(h.app.hanging, isEmpty);
    expect(h.app.assisted, isTrue);
    await h.app.reviewGame();
    expect(h.app.hanging, isEmpty);
    expect(h.app.threats, isEmpty);
  });

  test('dialogue assets load and optional opening feedback does not interfere with moves', () async {
    final h = await _Harness.create();
    await h.app.updateSetting('opponentTalk', true);
    await h.app.startGame();
    await h.play('e2e4');
    expect(h.app.coachMessage, isNotNull);
    expect(h.app.coachMessage, isNot(isEmpty));
    expect(h.app.assisted, isFalse);
    await h.app.updateSetting('opponentTalk', false);
    await h.app.startGame();
    await h.play('d2d4');
    expect(h.app.coachMessage, isNull);
    expect(h.app.error, isNull);
  });

  test(
    'cancelled opponent commit cannot apply its queued premove to a new game',
    () async {
      final h = await _Harness.create();
      await h.app.startGame();
      final old = await h.play('e2e4');
      h.app.queuePremove('g1f3');
      final gate = Completer<void>();
      h.engine.stopGates.add(gate);
      final stops = h.engine.stopCalls;
      old.complete('e7e5');
      await _until(() => h.engine.stopCalls > stops);
      // Starting the new session invalidates the old commit while its stop is
      // pending. Both continuations then compete after that stop completes.
      final next = h.app.startGame();
      await _flush();
      gate.complete();
      await next;
      await _flush();
      expect(h.app.fen, startFen);
      expect(h.app.node!.ply, 0);
      expect(h.app.premoveUci, isNull);
    },
  );

  test(
    'expired clock is settled before a legal move can switch the active side',
    () async {
      final h = await _Harness.create(timeControl: '3+2');
      await h.app.startGame();
      await h.app.warmup();
      h.app.clock!.set([0, 180000], 0);
      await h.app.playMove('e2e4');
      expect(h.app.game!['reason'], 'timeout');
      expect(h.app.result, '0-1');
      expect(h.app.node!.ply, 0);
      expect(h.engine.predictions, isEmpty);
    },
  );
}
