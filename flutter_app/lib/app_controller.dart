import 'dart:async';
import 'dart:convert';
import 'dart:math';

import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';

import 'core/chess.dart';
import 'core/clock.dart';
import 'core/game.dart';
import 'core/openings.dart';
import 'core/rating.dart';
import 'core/sampling.dart';
import 'core/settings.dart';
import 'core/storage.dart';
import 'core/tactics.dart';
import 'core/training.dart';
import 'services/engines.dart';
import 'services/feedback.dart';

enum AppPage { home, play, review, training, history, statistics, data, appearance, settings }

class MoveReview {
  MoveReview(
    this.node,
    this.before,
    this.after,
    this.best,
    this.drop,
    this.accuracy,
    this.judgement,
    this.explanation,
  );
  final GameNode node;
  final Analysis before, after;
  final String best, judgement;
  final double drop, accuracy;
  final MistakeExplanation explanation;
}

/// Flutter owns all game state. Engines receive immutable FEN snapshots only.
class AppController extends ChangeNotifier {
  AppController({AppRepository? repository, EngineService? engines})
    : repository = repository ?? AppRepository(),
      engines = engines ?? EngineService();

  final AppRepository repository;
  final EngineService engines;
  final feedback = GameFeedback();
  final openings = OpeningBook();
  final puzzles = PuzzleService();
  final clockTicks = ValueNotifier<int>(0);
  final _watch = Stopwatch()..start();
  final _random = Random();
  AppPage page = AppPage.home;
  bool loaded = false, foreground = true, thinking = false, hinting = false;
  bool storageReady = false;
  bool analysing = false, reviewPlaying = false, flipped = false;
  String? error, notice, hintUci, premoveUci;
  Map<String, dynamic>? game;
  GameTree? tree;
  GameNode? node;
  ChessClock? clock;
  Timer? _clockTimer, _unloadTimer;
  int _generation = 0, _analysisGeneration = 0, _thinkingRequest = 0;
  int _warmGeneration = 0, _lifecycleGeneration = 0;
  bool _reviewingGame = false, _disposed = false;
  String? _nativeProfile;
  Future<void>? _warming;
  String? _warmingKey;
  Future<void> _stopTail = Future.value();
  Future<void> _backgrounding = Future.value();
  Analysis? analysis;
  MaiaPrediction? humanPrediction;
  final reviews = <int, MoveReview>{};
  double reviewProgress = 0;
  String reviewFilter = 'all';
  Puzzle? puzzle;
  String? puzzleFen, puzzleTheme, trainingMessage;
  int puzzleStep = 0;
  bool puzzleComplete = false, puzzleFailed = false, trainingBusy = false;
  Map<String, dynamic>? trainingMistake;
  final samplingStore = SamplingStore();
  String? coachMessage;
  List<Map<String, dynamic>> _dialogue = [];
  String? _tacticFen;
  List<String> _hanging = [], _threats = [];

  void _refreshTactics() {
    if (_tacticFen == fen) return;
    _tacticFen = fen;
    _hanging = hangingPieces(fen, userColor);
    _threats = threatMoves(fen, opposite(userColor)).take(3).toList();
  }

  List<String> get hanging {
    if (settings['aidHanging'] != true || ended || inReview) return [];
    _refreshTactics();
    return _hanging;
  }

  List<String> get threats {
    if (settings['aidThreats'] != true || ended || inReview) return [];
    _refreshTactics();
    return _threats;
  }

  List<String> get learningSummary {
    final counts = <String, int>{};
    for (final review in reviews.values) {
      if (review.drop < 5 || turnOf(review.node.parent!.fen) != userColor) {
        continue;
      }
      final label = review.explanation.tagLabel;
      counts[label] = (counts[label] ?? 0) + 1;
    }
    final sorted = counts.entries.toList()
      ..sort((a, b) => b.value.compareTo(a.value));
    return sorted.take(3).map((e) => '${e.key}：${e.value} 次').toList();
  }

  double? accuracyFor(String color) {
    final entries = reviews.values
        .where((r) => turnOf(r.node.parent!.fen) == color)
        .toList();
    return entries.isEmpty
        ? null
        : entries.fold<double>(0, (n, r) => n + r.accuracy) / entries.length;
  }

  List<String> get recommendedThemes {
    final rating = (repository.puzzles['games'] as num) < 20
        ? settings.playerElo
        : (repository.puzzles['rating'] as num).toInt();
    final scores = <String, double>{
      'fork': rating < 1400 ? 3 : 1,
      'hangingPiece': rating < 1200 ? 4 : 1,
      'mateIn1': rating < 1000 ? 4 : 1,
      'pin': 1,
      'defensiveMove': rating >= 1600 ? 2 : 0,
    };
    final byTheme = repository.puzzles['byTheme'] as Map? ?? {};
    for (final key in byTheme.keys) {
      final values = byTheme[key];
      if (values is List && values.length == 2) {
        final correct = values[0] as num, failed = values[1] as num;
        scores[key as String] =
            (scores[key] ?? 0) + failed / (correct + failed + 1) * 10;
      }
    }
    for (final mistake in repository.mistakes) {
      final tag = mistake['tag'] as String;
      final theme = {
        'allow-fork': 'fork',
        'miss-fork': 'fork',
        'allow-pin': 'pin',
        'miss-pin': 'pin',
        'hanging': 'hangingPiece',
        'miss-mate': 'mate',
        'allow-mate': 'defensiveMove',
      }[tag];
      if (theme != null && mistake['mastered'] != true) {
        scores[theme] = (scores[theme] ?? 0) + 2;
      }
    }
    final sorted = scores.entries.toList()
      ..sort((a, b) => b.value.compareTo(a.value));
    return sorted.take(3).map((e) => e.key).toList();
  }

  AppSettings get settings => repository.settings;
  bool get fixedNativeProfile =>
      !kIsWeb &&
      defaultTargetPlatform == TargetPlatform.iOS &&
      (_nativeProfile ??
          const String.fromEnvironment('NATIVE_PROFILE', defaultValue: 'all')) ==
          '79m-full';
  String get fen => page == AppPage.training && puzzleFen != null
      ? puzzleFen!
      : node?.fen ?? startFen;
  String get userColor => game?['userColor'] as String? ?? 'w';
  String get orientation => flipped ? opposite(userColor) : userColor;
  String get result => game?['result'] as String? ?? '';
  bool get ended => result.isNotEmpty && result != '*';
  bool get inReview => page == AppPage.review;
  bool get playable =>
      page == AppPage.play &&
      !ended &&
      foreground &&
      engines.ready &&
      !thinking &&
      turnOf(fen) == userColor;
  String? get opening => tree == null || node == null
      ? null
      : openings.identify(tree!.pathTo(node!).map((n) => n.fen));
  String get engineLabel => engines.ready ? '引擎已就绪' : engines.status;
  String get progressLabel => ended
      ? '${result == '1/2-1/2'
            ? '和棋'
            : (result == '1-0') == (userColor == 'w')
            ? '你赢了'
            : 'Maia 获胜'} · ${game?['reason'] ?? ''}'
      : !engines.ready
      ? engineLabel
      : thinking
      ? 'Maia 正在思考…'
      : turnOf(fen) == userColor
      ? '轮到你走棋'
      : '轮到 Maia';
  bool get assisted =>
      (game?['assists'] as Map?)?['aids'] == true ||
      ((game?['assists'] as Map?)?['hint'] as num? ?? 0) > 0 ||
      ((game?['assists'] as Map?)?['undo'] as num? ?? 0) > 0;

  Future<void> load() async {
    loaded = false;
    storageReady = false;
    error = null;
    notifyListeners();
    try {
      await repository.load();
      if (!kIsWeb && defaultTargetPlatform == TargetPlatform.iOS) {
        final device = await engines.deviceInfo();
        _nativeProfile = device['nativeProfile'] as String?;
      }
      if (!kIsWeb &&
          defaultTargetPlatform == TargetPlatform.iOS &&
          !repository.hasLocalData) {
        final values = await const MethodChannel('maia_coach/migration')
            .invokeMapMethod<String, String>('legacy.read');
        if (values != null && values.isNotEmpty) {
          await repository.importLegacyStorage(values);
          notice = '已从原 iOS 版本恢复本地棋谱和设置';
        }
      }
      await openings.load();
      _dialogue =
          (jsonDecode(await rootBundle.loadString('assets/data/dialogue.json'))
                  as List)
              .map((entry) => Map<String, dynamic>.from(entry as Map))
              .toList();
      final saved = repository.currentGame;
      if (saved != null) _restore(saved);
      _normalizeProfile();
      storageReady = true;
      final samplingLoad = await samplingStore.load();
      if (!samplingLoad.ok) notice = samplingLoad.error;
      loaded = true;
      _configureFeedback();
      notifyListeners();
      engines.onChanged = () {
        if (loaded) notifyListeners();
      };
      unawaited(warmup());
    } catch (e) {
      error = '读取本地数据失败：$e';
      loaded = true;
      notifyListeners();
    }
  }

  void _normalizeProfile() {
    if (!fixedNativeProfile) return;
    settings['model'] = '79m';
    settings['sfLite'] = false;
    if (game != null && !ended) game!['model'] = '79m';
  }

  Future<void> applyImportedSettings() async {
    _normalizeProfile();
    _configureFeedback();
    await repository.save();
    notifyListeners();
  }

  Future<void> warmup() {
    if (!foreground || _disposed || !storageReady) return Future.value();
    _normalizeProfile();
    final model = game != null && !ended && !_reviewingGame
        ? game!['model'] as String? ?? settings.model
        : settings.model;
    final key =
        '$model/${settings.sfThreads}/${settings.sfHash}/${settings.sfLite}';
    if (_warming != null && key == _warmingKey) return _warming!;
    final generation = ++_warmGeneration;
    _warmingKey = key;
    final future = _warmup(model, generation);
    _warming = future;
    unawaited(
      future.whenComplete(() {
        if (identical(_warming, future)) {
          _warming = null;
          _warmingKey = null;
        }
      }),
    );
    return future;
  }

  Future<void> _warmup(String model, int generation) async {
    try {
      await _backgrounding;
      await _stopTail;
      if (!foreground || generation != _warmGeneration || _disposed) return;
      error = null;
      await engines.initialize(
        model: model,
        threads: settings.sfThreads,
        hash: settings.sfHash,
        lite: settings.sfLite,
      );
      if (!foreground || generation != _warmGeneration || _disposed) return;
      if (foreground && page == AppPage.play && !ended) {
        _syncClock();
        unawaited(_opponentMove());
      }
    } catch (e) {
      if (!foreground || generation != _warmGeneration || _disposed) return;
      error = '引擎未能就绪：$e';
      clock?.stop(_now);
      _syncTimer();
    }
    notifyListeners();
  }

  double get _now => _watch.elapsedMicroseconds / 1000;

  void _restore(Map<String, dynamic> value) {
    // Review trees and their mutable assists/headers never alias the live slot.
    value = Map<String, dynamic>.from(jsonDecode(jsonEncode(value)) as Map);
    final restored = GameTree.deserialize(
      value['startFen'] as String,
      Map<String, dynamic>.from(value['tree'] as Map),
    );
    game = Map<String, dynamic>.from(value);
    tree = restored;
    node = restored.mainline().last;
    clock = (value['tc'] ?? 'none') == 'none'
        ? null
        : ChessClock(
            value['tc'] as String,
            remaining: (value['clock'] as List?)
                ?.map((v) => (v as num).toDouble())
                .toList(),
          );
  }

  Future<void> startGame({String? fromFen, bool local = false}) async {
    if (!storageReady) throw StateError('请先成功读取本地数据');
    final initial = fromFen ?? startFen;
    final newTree = GameTree(
      initial,
    ); // Validate before abandoning a live game.
    _restoreLiveGame();
    if (game != null && !ended) await abandon();
    await _cancelWork();
    final color = settings.userColor == 'random'
        ? (_random.nextBool() ? 'w' : 'b')
        : settings.userColor;
    tree = newTree;
    node = newTree.root;
    final aids = [
      'aidEval',
      'aidWinPct',
      'aidThreats',
      'aidHanging',
      'aidBest',
    ].any((key) => settings[key] == true);
    game = {
      'id':
          '${DateTime.now().millisecondsSinceEpoch.toRadixString(36)}${_random.nextInt(100000).toRadixString(36)}',
      'date': DateTime.now().millisecondsSinceEpoch,
      'startFen': initial,
      'tree': newTree.serialize(),
      'userColor': color,
      'result': '',
      'elo': settings.elo,
      'playerElo': settings.playerElo,
      'ratingDeviation': settings['ratingDeviation'],
      'ratingStreak': settings['ratingStreak'],
      'temperature': settings.temperature,
      'model': settings.model,
      'tc': settings.timeControl,
      'coachAvatar': 0,
      'assists': {'undo': 0, 'hint': 0, 'aids': aids},
      if (initial != startFen || local) 'imported': true,
    };
    clock = settings.timeControl == 'none'
        ? null
        : ChessClock(settings.timeControl);
    newTree.root.clock = clock?.snapshot(_now);
    page = AppPage.play;
    flipped = false;
    reviews.clear();
    analysis = null;
    _tacticFen = null;
    coachMessage = null;
    notice = null;
    await persist();
    notifyListeners();
    final terminal = terminalOf([initial]);
    if (terminal != null) {
      await _finish(terminal.result, terminal.reason);
      return;
    }
    unawaited(warmup());
  }

  Future<void> resumeGame() async {
    _restoreLiveGame();
    if (game == null) return;
    await _cancelWork();
    node = tree!.mainline().last;
    page = ended ? AppPage.review : AppPage.play;
    notifyListeners();
    if (ended) {
      await reviewGame();
      return;
    }
    await warmup();
    _syncClock();
    unawaited(_opponentMove());
  }

  Future<void> _cancelWork() {
    _generation++;
    _analysisGeneration++;
    _thinkingRequest++;
    thinking = hinting = analysing = reviewPlaying = false;
    hintUci = premoveUci = null;
    clock?.stop(_now);
    _syncTimer();
    final operation = _stopTail.then((_) => engines.stop());
    _stopTail = operation.catchError((_) {});
    return _stopTail;
  }

  void _restoreLiveGame() {
    if (!_reviewingGame) return;
    _reviewingGame = false;
    final saved = repository.currentGame;
    if (saved == null) {
      game = null;
      tree = null;
      node = null;
      clock = null;
    } else {
      _restore(saved);
      _normalizeProfile();
    }
    reviews.clear();
    analysis = null;
    humanPrediction = null;
  }

  Future<void> showPage(AppPage next) async {
    if (next == page) return;
    if (page == AppPage.play ||
        page == AppPage.review ||
        page == AppPage.training) {
      await _cancelWork();
      await persist();
      await feedback.stop();
    }
    if (next != AppPage.review) _restoreLiveGame();
    page = next;
    notifyListeners();
  }

  Future<void> playMove(String uci) async {
    if (page == AppPage.training) return _trainingMove(uci);
    if (inReview) {
      final next = tree!.add(node!, uci, explore: true);
      if (next == null) return;
      await _cancelWork();
      node = next;
      notifyListeners();
      unawaited(analysePosition());
      return;
    }
    if (!playable) return;
    await _commitMove(uci);
    if (!ended) unawaited(_opponentMove());
  }

  Future<void> _commitMove(String uci) async {
    final before = node!;
    final generation = _generation;
    final move = legalMoves(before.fen).where((m) => m.uci == uci).firstOrNull;
    if (move == null) return;
    await _stopTail;
    await engines.stop();
    if (generation != _generation || before != node || ended || !foreground) {
      return;
    }
    final now = _now;
    final flagged = clock?.flagged(now);
    if (flagged != null) {
      await _finish(timeoutResult(before.fen, flagged), 'timeout');
      return;
    }
    final next = tree!.add(before, uci);
    if (next == null) return;
    _generation++;
    hinting = false;
    hintUci = null;
    analysis = null;
    humanPrediction = null;
    final mover = turnOf(before.fen);
    clock?.moved(mover, now);
    node = next;
    next.clock = clock?.snapshot(_now);
    final terminal = terminalOf(tree!.pathTo(next).map((n) => n.fen).toList());
    if (terminal != null) {
      await _finish(terminal.result, terminal.reason);
    } else {
      _syncClock();
      await persist();
    }
    final sound = move.san.contains('#')
        ? 'Victory'
        : move.san.contains('+')
        ? 'Check'
        : move.captured != null
        ? 'Capture'
        : move.san.startsWith('O-O')
        ? 'Castle'
        : move.promotion != null
        ? 'Promotion'
        : 'Move';
    unawaited(feedback.play(sound).catchError((_) {}));
    _coachFeedback(before, move);
    notifyListeners();
    if (!ended && settings['aidBest'] == true && mover != userColor) {
      unawaited(hint(practice: false));
    } else if (!ended &&
        (settings['aidEval'] == true || settings['aidWinPct'] == true)) {
      unawaited(analysePosition());
    }
  }

  void _coachFeedback(GameNode before, ChessMove move) {
    coachMessage = null;
    if (settings['opponentTalk'] != true) return;
    final motifs = detectMotifs(before.fen, move.uci);
    if (motifs.isNotEmpty) {
      coachMessage = motifs.first.text;
      return;
    }
    final category = openings.inBook(node!.fen)
        ? 'opening_book_entry'
        : move.captured == 'q'
        ? 'capture_queen'
        : move.captured != null
        ? 'capture_minor'
        : null;
    if (category == null) return;
    final lines = _dialogue.where((l) => l['category'] == category).toList();
    if (lines.isNotEmpty) {
      coachMessage = lines[_random.nextInt(lines.length)]['text'] as String;
    }
  }

  Future<void> _opponentMove() async {
    if (!foreground ||
        thinking ||
        ended ||
        page != AppPage.play ||
        node == null ||
        turnOf(fen) == userColor ||
        !engines.ready) {
      return;
    }
    final generation = _generation;
    final request = ++_thinkingRequest;
    final current = node!;
    thinking = true;
    notifyListeners();
    _syncClock();
    try {
      final started = DateTime.now();
      final prediction = await engines.predict(
        current.fen,
        selfElo: (game!['elo'] as num).toInt(),
        opponentElo: (game!['playerElo'] as num).toInt(),
      );
      if (prediction.moves.isEmpty) throw StateError('Maia 没有返回合法着法');
      final uci = samplePrediction(
        prediction,
        (game!['temperature'] as num).toDouble(),
      );
      if (settings.thinkDelay) {
        final delay = max(
          0,
          450 +
              _random.nextInt(650) -
              DateTime.now().difference(started).inMilliseconds,
        );
        await Future<void>.delayed(Duration(milliseconds: delay));
      }
      if (generation != _generation ||
          !foreground ||
          page != AppPage.play ||
          node != current ||
          ended) {
        return;
      }
      final capture = settings['samplingCapture'] == true
          ? _samplingRecord(current, prediction, uci)
          : null;
      thinking = false;
      final queued = premoveUci;
      premoveUci = null;
      await _commitMove(uci);
      final committed =
          request == _thinkingRequest &&
          node?.parent == current &&
          node?.uci == uci;
      if (capture != null && node?.parent == current && node?.uci == uci) {
        unawaited(
          samplingStore.append(capture).then((result) {
            if (!result.ok) {
              notice = result.error;
              notifyListeners();
            }
          }),
        );
      }
      if (committed &&
          queued != null &&
          !ended &&
          legalMoves(fen).any((m) => m.uci == queued)) {
        await playMove(queued);
      }
    } catch (e) {
      if (generation == _generation && foreground) {
        error = 'Maia 走子失败：$e';
        clock?.stop(_now);
        _syncTimer();
      }
    } finally {
      if (request == _thinkingRequest) thinking = false;
      notifyListeners();
    }
  }

  Map<String, dynamic> _samplingRecord(
    GameNode current,
    MaiaPrediction prediction,
    String selected,
  ) {
    final temperature = (game!['temperature'] as num).toDouble();
    final maximum = prediction.moves.map((m) => m.logit).reduce(max);
    final first = prediction.moves.firstWhere((m) => m.logit == maximum).uci;
    final weights = [
      for (final move in prediction.moves)
        temperature <= 0
            ? (move.uci == first ? 1.0 : 0.0)
            : exp((move.logit - maximum) / temperature),
    ];
    final total = weights.reduce((a, b) => a + b);
    return {
      'gameId': game!['id'],
      'date': DateTime.now().toUtc().toIso8601String(),
      'ply': current.ply + 1,
      'fen': current.fen,
      'model': game!['model'],
      'selfElo': game!['elo'],
      'oppoElo': game!['playerElo'],
      'temperature': temperature,
      'topP': 1,
      'selected': selected,
      'wdl': prediction.wdl,
      'expectedScore': prediction.wdl[0] + prediction.wdl[1] / 2,
      'ms': prediction.ms,
      'rawMoves': [
        for (final move in prediction.moves)
          {'uci': move.uci, 'p': move.p, 'logit': move.logit},
      ],
      'distribution': [
        for (var i = 0; i < prediction.moves.length; i++)
          {'uci': prediction.moves[i].uci, 'p': weights[i] / total},
      ],
    };
  }

  void queuePremove(String uci) {
    if (!settings.premove || !thinking || page != AppPage.play) return;
    premoveUci = uci;
    notice = '已预走 ${uci.substring(0, 2)} → ${uci.substring(2)}';
    notifyListeners();
  }

  void _syncClock() {
    if (foreground &&
        page == AppPage.play &&
        !ended &&
        engines.ready &&
        error == null &&
        node != null) {
      clock?.run(turnOf(fen), _now);
    } else {
      clock?.stop(_now);
    }
    _syncTimer();
  }

  void _syncTimer() {
    final need = foreground && clock?.active != null;
    if (need && _clockTimer == null) {
      _clockTimer = Timer.periodic(const Duration(milliseconds: 100), (_) {
        clockTicks.value++;
        final flagged = clock?.flagged(_now);
        if (flagged != null && !ended) {
          unawaited(_finish(timeoutResult(fen, flagged), 'timeout'));
        }
      });
    } else if (!need) {
      _clockTimer?.cancel();
      _clockTimer = null;
    }
  }

  double? timeFor(String color) => clock?.time(color, _now);

  Future<void> markPractice() async {
    if (game == null || ended) return;
    final assists = Map<String, dynamic>.from(game!['assists'] as Map? ?? {});
    assists['aids'] = true;
    game!['assists'] = assists;
    await persist();
  }

  Future<void> hint({bool practice = true}) async {
    if (node == null || !foreground || !engines.stockfishReady || hinting) {
      return;
    }
    if (practice && !ended && !inReview) {
      await markPractice();
      final assists = game!['assists'] as Map<String, dynamic>;
      assists['hint'] = (assists['hint'] as num? ?? 0) + 1;
    }
    final current = node!;
    final generation = _generation;
    hinting = true;
    notifyListeners();
    try {
      final response = await engines.analyse(
        current.fen,
        milliseconds: settings.sfMovetime,
      );
      if (generation != _generation || current != node || !foreground) return;
      hintUci = response.bestmove;
      analysis = response;
      notice = hintUci == null
          ? '当前局面没有可走着法'
          : '建议：${legalMoves(fen).where((m) => m.uci == hintUci).firstOrNull?.san ?? hintUci}';
      await persist();
    } catch (e) {
      if (generation == _generation) error = '提示失败：$e';
    } finally {
      if (generation == _generation) hinting = false;
      notifyListeners();
    }
  }

  Future<void> undo() async {
    if (node?.parent == null || ended || inReview) return;
    await _cancelWork();
    await markPractice();
    final assists = game!['assists'] as Map<String, dynamic>;
    assists['undo'] = (assists['undo'] as num? ?? 0) + 1;
    var target = node!.parent!;
    if (target.parent != null && turnOf(target.fen) != userColor) {
      target = target.parent!;
    }
    target.children.clear();
    node = target;
    if (clock != null) {
      if (target.clock != null) {
        clock!.set(target.clock!, _now);
      } else if (target.parent == null) {
        clock = ChessClock(game!['tc'] as String);
      }
    }
    _syncClock();
    await persist();
    notifyListeners();
  }

  Future<void> resign() => _finish(userColor == 'w' ? '0-1' : '1-0', 'resign');

  Future<bool> offerDraw() async {
    if (ended || node == null || !engines.ready) return false;
    final current = node!;
    final generation = _generation;
    final p = await engines.predict(
      fen,
      selfElo: (game!['elo'] as num).toInt(),
      opponentElo: (game!['playerElo'] as num).toInt(),
    );
    if (current != node || generation != _generation || ended) return false;
    if (p.wdl.length == 3 &&
        (p.wdl[1] >= 0.45 || (p.wdl[0] - p.wdl[2]).abs() < 0.08)) {
      await _finish('1/2-1/2', 'agreement');
      return true;
    }
    notice = 'Maia 希望继续对局';
    notifyListeners();
    return false;
  }

  Future<void> abandon() async {
    if (game == null || ended) return;
    final own = tree!
        .mainline()
        .where((n) => n.parent != null && turnOf(n.parent!.fen) == userColor)
        .length;
    if (own >= 3) {
      game!['abandoned'] = true;
      await resign();
    }
  }

  Future<void> _finish(String outcome, String reason) async {
    if (game == null || ended || _reviewingGame) return;
    // Lock the result before awaiting engine cancellation or disk writes.
    game!['result'] = outcome;
    game!['reason'] = reason;
    await _cancelWork();
    if (!assisted &&
        game!['imported'] != true &&
        game!['startFen'] == startFen &&
        game!['rating'] == null) {
      final rating = computeRating(
        result: outcome == '1/2-1/2'
            ? 0.5
            : (outcome == '1-0') == (userColor == 'w')
            ? 1.0
            : 0.0,
        playerElo: (game!['playerElo'] as num).toDouble(),
        opponentElo: (game!['elo'] as num).toDouble(),
        deviation: (game!['ratingDeviation'] as num? ?? 350).toDouble(),
        streak: (game!['ratingStreak'] as num? ?? 0).toInt(),
        abandoned: game!['abandoned'] == true,
      );
      game!['rating'] = rating;
      game!['eloAfter'] = rating['playerAfter'];
      // A mid-game change to the player's self-estimate must not be overwritten.
      if (settings.playerElo == game!['playerElo']) {
        settings['playerElo'] = rating['playerAfter'];
        settings['ratingDeviation'] = rating['rdAfter'];
        settings['ratingStreak'] = rating['streak'];
        settings['ratedGames'] = (settings['ratedGames'] as num? ?? 0) + 1;
      }
    }
    await persist();
    notifyListeners();
    unawaited(
      feedback
          .play(
            outcome == '1/2-1/2'
                ? 'Draw'
                : (outcome == '1-0') == (userColor == 'w')
                ? 'Victory'
                : 'Defeat',
          )
          .catchError((_) {}),
    );
  }

  Future<void> persist() async {
    if (!_reviewingGame && game != null && tree != null) {
      game!['tree'] = tree!.serialize();
      if (clock != null) game!['clock'] = clock!.snapshot(_now);
      repository.currentGame = Map<String, dynamic>.from(game!);
      if (ended) repository.upsertGame(Map<String, dynamic>.from(game!));
    }
    await repository.save();
  }

  Future<void> reviewGame([Map<String, dynamic>? stored]) async {
    await _cancelWork();
    // Opening a stored game may only replace the detached review copy.
    // The unfinished game's durable slot is kept for the Continue action.
    if (stored == null && !ended && !_reviewingGame) await markPractice();
    await persist();
    final source = stored ?? game;
    if (source == null) return;
    _reviewingGame = true;
    _restore(source);
    if (tree == null) return;
    page = AppPage.review;
    node = tree!.root;
    reviews.clear();
    analysis = null;
    reviewProgress = 0;
    notifyListeners();
    unawaited(analysePosition());
    unawaited(analyseGame());
  }

  void goTo(GameNode target) {
    if (tree == null) return;
    _generation++;
    hintUci = null;
    node = target;
    analysis = reviews[target.id]?.after;
    notifyListeners();
    if (inReview) unawaited(analysePosition());
  }

  List<GameNode> get reviewNodes {
    if (tree == null) return [];
    final line = tree!.mainline();
    if (reviewFilter == 'all') return line;
    return line.where((n) {
      final review = reviews[n.id];
      if (n.parent == null || review == null || review.drop < 5) return false;
      final mine = turnOf(n.parent!.fen) == userColor;
      return reviewFilter == 'mine' ? mine : !mine;
    }).toList();
  }

  void stepReview(int direction) {
    final list = reviewNodes;
    if (list.isEmpty) return;
    final index = list.indexOf(node!);
    final target = index < 0
        ? (direction > 0 ? 0 : list.length - 1)
        : (index + direction).clamp(0, list.length - 1);
    goTo(list[target]);
  }

  Future<void> analysePosition() async {
    if (node == null || !engines.stockfishReady || !foreground) return;
    final current = node!;
    final generation = _generation;
    try {
      final a = await engines.analyse(
        current.fen,
        milliseconds: settings.sfMovetime,
        multipv: inReview ? 3 : 1,
      );
      if (current != node || generation != _generation || !foreground) return;
      analysis = a;
      notifyListeners();
    } catch (e) {
      if (inReview && current == node) {
        error = '分析失败：$e';
        notifyListeners();
      }
    }
  }

  Future<void> analyseGame() async {
    if (analysing || tree == null) return;
    if (!engines.ready) await warmup();
    if (!engines.stockfishReady || page != AppPage.review) return;
    final generation = ++_analysisGeneration;
    final line = tree!.mainline();
    analysing = true;
    notifyListeners();
    try {
      Analysis? previous;
      for (var i = 0; i < line.length; i++) {
        if (!foreground ||
            generation != _analysisGeneration ||
            page != AppPage.review) {
          return;
        }
        final current = line[i];
        final response = await engines.analyse(
          current.fen,
          milliseconds: min(settings.sfMovetime, 600),
          multipv: 2,
        );
        if (generation != _analysisGeneration) return;
        if (previous != null &&
            previous.lines.isNotEmpty &&
            response.lines.isNotEmpty) {
          final mover = turnOf(line[i - 1].fen);
          final beforeWin = previous.lines.first.whiteWin(mover);
          final afterWin = response.lines.first.whiteWin(turnOf(current.fen));
          final before = mover == 'w' ? beforeWin : 100 - beforeWin;
          final after = mover == 'w' ? afterWin : 100 - afterWin;
          final best =
              previous.bestmove ?? previous.lines.first.pv.firstOrNull ?? '';
          final drop = max(0.0, before - after);
          final beforeFen = line[i - 1].fen;
          final previousDrop = reviews[line[i - 1].id]?.drop ?? 0;
          final second = previous.lines.length > 1
              ? previous.lines[1].whiteWin(mover)
              : null;
          final secondGap = second == null
              ? 0
              : (beforeWin - second) * (mover == 'w' ? 1 : -1);
          final judgement = classifyMove(
            before: before,
            after: after,
            playedBest: current.uci == best,
            forced: legalMoves(beforeFen).length == 1,
            book: openings.inBook(beforeFen) && openings.inBook(current.fen),
            sacrifice: drop < 3 && after >= 50 && before < 97 &&
                isSacrifice(beforeFen, current.uci),
            oppDrop: previousDrop,
            secondGap: secondGap.toDouble(),
          );
          final explanation = explainMistake(
            beforeFen,
            current.uci,
            best,
            pv: response.lines.first.pv,
            bestPv: previous.lines.first.pv,
            replyCp: response.lines.first.cp,
            bestCp: previous.lines.first.cp,
            replyMate: response.lines.first.mate,
            bestMate: previous.lines.first.mate,
            bad: drop >= 5,
            me: mover == userColor ? '你' : 'Maia',
            opp: mover == userColor ? 'Maia' : '你',
          );
          reviews[current.id] = MoveReview(
            current,
            previous,
            response,
            best,
            drop,
            moveAccuracy(before, after),
            judgement,
            explanation,
          );
          if (mover == userColor &&
              drop >= 10 &&
              best.isNotEmpty &&
              game?['imported'] != true) {
            repository.addMistake({
              'id': '${game!['id']}-${current.ply}',
              'gameId': game!['id'],
              'date': game!['date'],
              'fen': line[i - 1].fen,
              'played': current.uci,
              'playedSan': current.san,
              'best': best,
              'line': previous.lines.first.pv.take(12).toList(),
              'judgement': judgement,
              'drop': drop,
              'tag': explanation.tag,
              'tagLabel': explanation.tagLabel,
              'streak': 0,
              'due': 0,
              'tries': 0,
              'solved': 0,
            });
          }
        }
        previous = response;
        reviewProgress = (i + 1) / line.length;
        notifyListeners();
      }
      await repository.save();
    } catch (e) {
      if (generation == _analysisGeneration) error = '整局分析失败：$e';
    } finally {
      if (generation == _analysisGeneration) analysing = false;
      notifyListeners();
    }
  }

  Future<void> comparePlayers(int first, int second) async {
    if (node == null || !engines.maiaReady) return;
    final current = node!;
    final p = await engines.predict(
      current.fen,
      selfElo: first,
      opponentElo: second,
    );
    if (node == current) {
      humanPrediction = p;
      notifyListeners();
    }
  }

  Future<void> playVariation(List<String> moves) async {
    if (!inReview || node == null || reviewPlaying) return;
    await _cancelWork();
    final generation = _generation;
    reviewPlaying = true;
    notifyListeners();
    try {
      for (final uci in moves.take(16)) {
        await Future<void>.delayed(const Duration(milliseconds: 650));
        if (generation != _generation || !foreground || !inReview) return;
        final next = tree!.add(node!, uci, explore: true);
        if (next == null) break;
        node = next;
        analysis = null;
        notifyListeners();
      }
    } finally {
      if (generation == _generation) {
        reviewPlaying = false;
        notifyListeners();
        unawaited(analysePosition());
      }
    }
  }

  Future<void> startPuzzle({String? theme}) async {
    await _cancelWork();
    await persist();
    _restoreLiveGame();
    page = AppPage.training;
    final generation = _generation;
    trainingMistake = null;
    puzzleTheme = theme;
    trainingBusy = true;
    trainingMessage = '正在准备谜题…';
    notifyListeners();
    try {
      final selected = await puzzles.nextPuzzle(
        repository.puzzles,
        theme: theme,
      );
      if (page != AppPage.training || generation != _generation) return;
      if (selected == null) {
        trainingMessage = '当前题型暂无未做过的谜题，请换一个题型';
        return;
      }
      puzzle = selected;
      puzzleStep = 0;
      puzzleComplete = puzzleFailed = false;
      final board = position(selected.fen);
      final first = selected.moves.first;
      board.move({
        'from': first.substring(0, 2),
        'to': first.substring(2, 4),
        if (first.length == 5) 'promotion': first[4],
      });
      puzzleFen = board.fen;
      puzzleStep = 1;
      final recent = List<String>.from(repository.puzzles['recent'] as List)
        ..remove(selected.id)
        ..add(selected.id);
      repository.puzzles['recent'] = recent
          .skip(max(0, recent.length - 500))
          .toList();
      await repository.save();
      trainingMessage = '${turnOf(puzzleFen!) == 'w' ? '白方' : '黑方'}走棋，找出最佳着法';
    } catch (e) {
      error = '载入谜题失败：$e';
    } finally {
      if (generation == _generation) trainingBusy = false;
      notifyListeners();
    }
  }

  Future<void> practiceMistake(Map<String, dynamic> mistake) async {
    await _cancelWork();
    await persist();
    _restoreLiveGame();
    page = AppPage.training;
    trainingMistake = mistake;
    puzzle = null;
    puzzleFen = mistake['fen'] as String;
    puzzleComplete = puzzleFailed = trainingBusy = false;
    trainingMessage = '重走这个局面，找到更好的着法';
    notifyListeners();
  }

  String get trainingOrientation => trainingMistake != null
      ? turnOf(trainingMistake!['fen'] as String)
      : puzzle == null
      ? 'w'
      : opposite(turnOf(puzzle!.fen));

  Future<void> _trainingMove(String uci) async {
    if (trainingBusy || puzzleComplete || puzzleFen == null) return;
    final expected =
        trainingMistake?['best'] as String? ?? puzzle!.moves[puzzleStep];
    final correct = acceptsMove(puzzleFen!, uci, expected);
    if (!correct) {
      if (!puzzleFailed) {
        if (trainingMistake != null) {
          repository.gradeMistake(trainingMistake!['id'] as String, false);
        } else {
          recordPuzzle(repository.puzzles, puzzle!, false);
        }
        await repository.save();
      }
      puzzleFailed = true;
      trainingMessage = '这步还不够好，再检查将军、吃子与对手威胁';
      unawaited(feedback.play('LowTime').catchError((_) {}));
      notifyListeners();
      return;
    }
    final board = position(puzzleFen!);
    board.move({
      'from': uci.substring(0, 2),
      'to': uci.substring(2, 4),
      if (uci.length == 5) 'promotion': uci[4],
    });
    puzzleFen = board.fen;
    unawaited(feedback.play('Move').catchError((_) {}));
    if (trainingMistake != null ||
        ++puzzleStep >= puzzle!.moves.length ||
        board.in_checkmate) {
      await _completeTraining();
      return;
    }
    trainingBusy = true;
    notifyListeners();
    final generation = _generation;
    await Future<void>.delayed(const Duration(milliseconds: 350));
    if (generation != _generation || page != AppPage.training) return;
    final reply = puzzle!.moves[puzzleStep++];
    board.move({
      'from': reply.substring(0, 2),
      'to': reply.substring(2, 4),
      if (reply.length == 5) 'promotion': reply[4],
    });
    puzzleFen = board.fen;
    trainingBusy = false;
    if (puzzleStep >= puzzle!.moves.length) await _completeTraining();
    notifyListeners();
  }

  Future<void> _completeTraining() async {
    puzzleComplete = true;
    trainingBusy = false;
    if (!puzzleFailed) {
      if (trainingMistake != null) {
        repository.gradeMistake(trainingMistake!['id'] as String, true);
        trainingMessage = '回答正确，已更新复习计划';
      } else {
        final delta = recordPuzzle(repository.puzzles, puzzle!, true);
        trainingMessage = '解答正确！谜题等级分 ${delta >= 0 ? '+' : ''}$delta';
      }
      await repository.save();
    } else {
      trainingMessage = '已完成这道练习，继续加油';
    }
    unawaited(feedback.play('Victory').catchError((_) {}));
    notifyListeners();
  }

  Future<void> revealTraining() async {
    if (puzzleComplete || puzzleFen == null) return;
    final expected =
        trainingMistake?['best'] as String? ?? puzzle!.moves[puzzleStep];
    if (!puzzleFailed) {
      if (trainingMistake != null) {
        repository.gradeMistake(trainingMistake!['id'] as String, false);
      } else {
        recordPuzzle(repository.puzzles, puzzle!, false);
      }
      await repository.save();
    }
    puzzleFailed = true;
    hintUci = expected;
    trainingMessage =
        '参考着法：${legalMoves(puzzleFen!).where((m) => m.uci == expected).firstOrNull?.san ?? expected}';
    notifyListeners();
  }

  Future<void> importPgn(String text) async {
    final entries = splitPgn(text);
    if (entries.isEmpty) throw const FormatException('未找到棋谱');
    Map<String, dynamic>? first;
    for (var i = 0; i < entries.length; i++) {
      final parsed = parsePgn(entries[i]);
      final stored = <String, dynamic>{
        'id': 'pgn-${DateTime.now().millisecondsSinceEpoch}-$i',
        'date': DateTime.now().millisecondsSinceEpoch,
        'startFen': parsed.tree.root.fen,
        'tree': parsed.tree.serialize(),
        'userColor': 'w',
        'result': parsed.result == '*' ? '' : parsed.result,
        'headers': parsed.headers,
        'imported': true,
        'elo': settings.elo,
        'model': settings.model,
        'tc': 'none',
        'playerElo': settings.playerElo,
      };
      repository.upsertGame(stored);
      first ??= stored;
    }
    await repository.save();
    await reviewGame(first);
  }

  String gamePgn() {
    if (tree == null) return '';
    return exportPgn(tree!, {
      ...Map<String, String>.from(game?['headers'] as Map? ?? {}),
      'Event': 'Maia Coach',
      'Site': 'Flutter',
      'White': userColor == 'w' ? '我' : 'Maia',
      'Black': userColor == 'b' ? '我' : 'Maia',
      'WhiteElo': '${game?[userColor == 'w' ? 'playerElo' : 'elo'] ?? ''}',
      'BlackElo': '${game?[userColor == 'b' ? 'playerElo' : 'elo'] ?? ''}',
      'Result': ended ? result : '*',
    });
  }

  Future<void> updateSetting(String key, dynamic value) async {
    settings[key] = value;
    _normalizeProfile();
    if (key == 'playerElo') settings['ratingDeviation'] = 350.0;
    _configureFeedback();
    if ([
          'aidEval',
          'aidWinPct',
          'aidThreats',
          'aidHanging',
          'aidBest',
        ].contains(key) &&
        value == true) {
      await markPractice();
    }
    await repository.save();
    notifyListeners();
  }

  void _configureFeedback() {
    feedback.enabled = settings.sound;
    feedback.haptics = settings.haptics;
    feedback.theme = settings.soundTheme;
  }

  Future<void> setForeground(bool value) async {
    if (foreground == value) return;
    foreground = value;
    final lifecycle = ++_lifecycleGeneration;
    if (!value) {
      _unloadTimer?.cancel();
      _warmGeneration++;
      _warming = null;
      _warmingKey = null;
      final stopping = _cancelWork();
      final previous = _backgrounding;
      final operation = () async {
        await previous;
        await stopping;
        if (storageReady) await persist();
        await engines.suspend();
        await feedback.stop();
        if (!foreground && !_disposed) {
          _unloadTimer = Timer(const Duration(seconds: 10), () {
            if (!foreground) unawaited(engines.unloadMaia());
          });
        }
      }();
      _backgrounding = operation.catchError((Object e) {
        if (!_disposed) error = '暂停引擎失败：$e';
      });
      await _backgrounding;
    } else {
      _unloadTimer?.cancel();
      _unloadTimer = null;
      await _backgrounding;
      if (!foreground || lifecycle != _lifecycleGeneration || _disposed) return;
      _unloadTimer?.cancel();
      _unloadTimer = null;
      await warmup();
      if (!foreground || lifecycle != _lifecycleGeneration || _disposed) return;
      if (inReview) {
        unawaited(analysePosition());
        unawaited(analyseGame());
      }
    }
    notifyListeners();
  }

  Future<String> diagnosticLogs() async =>
      'Maia Coach / Flutter\n'
      'Engines: ${engines.status}\n'
      '${jsonEncode(await engines.deviceInfo())}\n'
      '${await engines.logs()}';

  void clearError() {
    error = null;
    notifyListeners();
  }

  void refresh() => notifyListeners();

  @override
  void notifyListeners() {
    if (!_disposed) super.notifyListeners();
  }

  @override
  void dispose() {
    _disposed = true;
    _generation++;
    _analysisGeneration++;
    _warmGeneration++;
    _thinkingRequest++;
    loaded = false;
    engines.onChanged = null;
    _clockTimer?.cancel();
    _unloadTimer?.cancel();
    clockTicks.dispose();
    unawaited(engines.dispose());
    unawaited(feedback.dispose());
    super.dispose();
  }
}
