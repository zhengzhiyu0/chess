import 'dart:async';

import 'package:flutter/services.dart';

import 'engine_types.dart';

EngineLine? parseEngineInfo(String line) {
  if (!line.startsWith('info ') || !line.contains(' pv ')) return null;
  final tokens = line.trim().split(RegExp(r'\s+'));
  var depth = 0;
  var multipv = 1;
  int? cp;
  int? mate;
  String? bound;
  var pv = <String>[];
  for (var i = 1; i < tokens.length; i++) {
    final token = tokens[i];
    if (token == 'pv') {
      pv = tokens.sublist(i + 1);
      break;
    }
    if ((token == 'depth' || token == 'multipv') && i + 1 < tokens.length) {
      final number = int.tryParse(tokens[++i]);
      if (number == null) return null;
      if (token == 'depth') depth = number;
      if (token == 'multipv') multipv = number;
    } else if (token == 'score' && i + 2 < tokens.length) {
      final kind = tokens[++i];
      final number = int.tryParse(tokens[++i]);
      if (number == null) return null;
      if (kind == 'cp') cp = number;
      if (kind == 'mate') mate = number;
    } else if (token == 'lowerbound' || token == 'upperbound') {
      bound = token;
    }
  }
  if (pv.isEmpty || multipv < 1 || depth < 0) return null;
  return EngineLine(
    depth: depth,
    multipv: multipv,
    cp: cp,
    mate: mate,
    pv: pv,
    bound: bound,
  );
}

class _UciWaiter {
  final String reply;
  final completer = Completer<void>();
  Timer? timer;
  _UciWaiter(this.reply);
}

class _UciSearch {
  final completer = Completer<Analysis>();
  final lines = <int, EngineLine>{};
  Timer? timer;
  bool cancelled = false;
  bool accepting = false;
  List<EngineLine> get sorted =>
      lines.values.toList()..sort((a, b) => a.multipv.compareTo(b.multipv));
}

/// One ordered command stream, with bestmove drainage before the next position.
/// `isready` alone is insufficient: UCI permits readyok during a running search.
class NativeUciEngine {
  final MethodChannel channel;
  final EventChannel events;
  final void Function() changed;
  final void Function(String) record;
  final void Function(Object) failed;
  StreamSubscription<dynamic>? _subscription;
  final _waiters = <_UciWaiter>[];
  Future<void> _tail = Future.value();
  _UciSearch? _active;
  String _engine = 'full';
  String? _configuration;
  bool _started = false;
  bool _disposed = false;
  int _epoch = 0;
  bool ready = false;

  NativeUciEngine({
    required this.channel,
    required this.events,
    required this.changed,
    required this.record,
    required this.failed,
  });

  Future<T> _enqueue<T>(Future<T> Function() run) {
    final future = _tail.then((_) => run());
    _tail = future.then<void>((_) {}, onError: (Object _, StackTrace _) {});
    return future;
  }

  Future<void> _send(String cmd) async {
    if (_disposed) throw StateError('Stockfish 已释放');
    record('Stockfish > $cmd');
    await channel
        .invokeMethod<void>('stockfish.send', {'engine': _engine, 'cmd': cmd})
        .timeout(const Duration(seconds: 5));
  }

  void _fail(Object error) {
    ready = false;
    _configuration = null;
    for (final waiter in [..._waiters]) {
      waiter.timer?.cancel();
      if (!waiter.completer.isCompleted) waiter.completer.completeError(error);
    }
    _waiters.clear();
    final search = _active;
    _active = null;
    search?.timer?.cancel();
    if (search != null && !search.completer.isCompleted) {
      search.completer.completeError(error);
    }
    record('Stockfish ! $error');
    failed(error);
    changed();
  }

  void _event(dynamic event) {
    if (event is! Map || event['engine'] != _engine || _disposed) return;
    final lines = event['lines'];
    if (lines is! List) return;
    for (final raw in lines) {
      if (raw is! String) continue;
      for (final line in raw.split(RegExp(r'[\r\n]+'))) {
        if (line.isEmpty) continue;
        if (!line.startsWith('info ') || line.contains(' pv ')) {
          record('Stockfish < $line');
        }
        for (final waiter in [..._waiters]) {
          if (line.trim() == waiter.reply) {
            _waiters.remove(waiter);
            waiter.timer?.cancel();
            waiter.completer.complete();
          }
        }
        final search = _active;
        if (search == null || !search.accepting) continue;
        final info = parseEngineInfo(line);
        if (info != null) {
          final previous = search.lines[info.multipv];
          if (info.bound == null ||
              previous == null ||
              previous.bound != null) {
            search.lines[info.multipv] = info;
          }
        } else if (line.startsWith('bestmove ')) {
          _active = null;
          search.timer?.cancel();
          final move = line.split(RegExp(r'\s+'))[1];
          search.completer.complete(
            search.cancelled
                ? const Analysis()
                : Analysis(
                    lines: search.sorted,
                    bestmove: move == '(none)' || move == '0000' ? null : move,
                  ),
          );
        }
      }
    }
  }

  Future<void> _barrier(
    String command,
    String reply, {
    Duration timeout = const Duration(seconds: 30),
  }) async {
    final waiter = _UciWaiter(reply);
    _waiters.add(waiter);
    waiter.timer = Timer(timeout, () {
      if (_waiters.remove(waiter)) {
        waiter.completer.completeError(
          TimeoutException('Stockfish 等待 $reply 超时', timeout),
        );
      }
    });
    // Attach the error handler before dispatch: a platform reply/event may fail
    // synchronously while the method acknowledgement is still in flight.
    final response = waiter.completer.future;
    unawaited(
      response.then<void>((_) {}, onError: (Object _, StackTrace _) {}),
    );
    try {
      await _send(command);
      await response;
    } finally {
      _waiters.remove(waiter);
      waiter.timer?.cancel();
    }
  }

  Future<void> initialize(EngineOptions options) {
    if (ready && _configuration == options.stockfishKey) return Future.value();
    return _enqueue(() async {
      if (_disposed) throw StateError('Stockfish 已释放');
      if (ready && _configuration == options.stockfishKey) return;
      ready = false;
      changed();
      if (_started && _engine != (options.lite ? 'lite' : 'full')) {
        await _send('stop');
        await _send('setoption name Hash value 1');
        await _send('ucinewgame');
      }
      _engine = options.lite ? 'lite' : 'full';
      _subscription ??= events.receiveBroadcastStream().listen(
        _event,
        onError: (Object e) => _fail(e),
        onDone: () {
          if (!_disposed) _fail(StateError('Stockfish 输出通道已关闭'));
        },
      );
      try {
        await channel
            .invokeMethod<void>('stockfish.start', {'engine': _engine})
            .timeout(const Duration(seconds: 45));
        _started = true;
        // ucinewgame waits for any orphaned native search to finish before the
        // handshake; this also drains a bestmove from a previous Flutter owner.
        await _send('stop');
        await _send('ucinewgame');
        await _barrier('uci', 'uciok', timeout: const Duration(seconds: 45));
        await _send('setoption name Threads value ${options.threads}');
        await _barrier('isready', 'readyok');
        await _send('setoption name Hash value ${options.hash}');
        await _barrier('isready', 'readyok');
        await _send('setoption name UCI_ShowWDL value true');
        await _barrier('isready', 'readyok');
        _configuration = options.stockfishKey;
        ready = true;
        record('Stockfish ready (${options.stockfishKey})');
        changed();
      } catch (error) {
        _fail(error);
        rethrow;
      }
    });
  }

  Future<Analysis> analyse(
    String position, {
    required int milliseconds,
    required int multipv,
  }) {
    final epoch = _epoch;
    return _enqueue(() async {
      if (_disposed || epoch != _epoch) return const Analysis();
      if (!ready) throw StateError('Stockfish 尚未就绪');
      // Previous searches remain in the queue until their terminal bestmove,
      // then this barrier discards all output ahead of this search's commands.
      await _send('stop');
      await _barrier('isready', 'readyok');
      await _send('setoption name MultiPV value $multipv');
      await _barrier('isready', 'readyok');
      if (epoch != _epoch) return const Analysis();
      await _send(position);
      if (epoch != _epoch) return const Analysis();
      final search = _UciSearch();
      _active = search;
      unawaited(
        search.completer.future.then<void>(
          (_) {},
          onError: (Object _, StackTrace _) {},
        ),
      );
      search.accepting = true;
      search.timer = Timer(Duration(milliseconds: milliseconds + 4000), () {
        record('Stockfish search timed out; draining bestmove');
        search.cancelled = true;
        search.timer = Timer(
          const Duration(seconds: 4),
          () => _fail(TimeoutException('Stockfish 未响应 stop')),
        );
        unawaited(_send('stop').catchError((Object error) => _fail(error)));
      });
      try {
        await _send('go movetime $milliseconds');
        return await search.completer.future;
      } catch (error) {
        if (identical(_active, search)) _fail(error);
        rethrow;
      } finally {
        search.timer?.cancel();
      }
    });
  }

  Future<void> stop() async {
    _epoch++;
    final search = _active;
    if (search != null) search.cancelled = true;
    if (!_started || _disposed) return;
    try {
      await _send('stop');
      if (search != null) {
        await search.completer.future.timeout(const Duration(seconds: 5));
      }
    } catch (error) {
      _fail(error);
      rethrow;
    }
  }

  Future<void> dispose() async {
    if (_disposed) return;
    try {
      await stop();
      if (_started) {
        await _send('setoption name Hash value 1');
        await _send('ucinewgame');
      }
    } finally {
      _disposed = true;
      ready = false;
      _fail(StateError('Stockfish 已释放'));
      await _subscription?.cancel();
      _subscription = null;
    }
  }
}
