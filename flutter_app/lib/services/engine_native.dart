import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';

import 'engine_encoding.dart';
import 'engine_types.dart';
import 'engine_uci.dart';

EngineBackend createEngineBackend() => NativeEngineBackend();

class NativeEngineBackend extends EngineBackend {
  static const _channel = MethodChannel('maia_coach/native');
  static const _events = EventChannel('maia_coach/stockfish');
  final _log = <String>[];
  late final NativeUciEngine _stockfish = NativeUciEngine(
    channel: _channel,
    events: _events,
    changed: _notify,
    record: _record,
    failed: _failure,
  );
  Future<void> _initTail = Future.value();
  Future<void> _maiaTail = Future.value();
  Future<void>? _initializing;
  Future<void>? _disposing;
  String? _initializingKey;
  EngineOptions _options = const EngineOptions();
  String? _model;
  int _maiaGeneration = 0;
  int _predictionGeneration = 0;
  bool _disposed = false;
  bool _suspended = false;
  bool _confirmMaiaSession = false;

  @override
  String status = '引擎尚未初始化';
  @override
  String? error;
  @override
  bool get native => defaultTargetPlatform == TargetPlatform.iOS;
  @override
  bool get stockfishReady => !_disposed && _stockfish.ready;
  @override
  bool get maiaReady => !_disposed && _model != null;

  void _notify() => onChanged?.call();
  void _record(String message) {
    _log.add('${DateTime.now().toIso8601String()} $message');
    if (_log.length > 500) _log.removeRange(0, _log.length - 500);
  }

  void _failure(Object failure) {
    if (_disposed) return;
    error = failure.toString();
    status = '引擎错误：$error';
    _record(status);
    _notify();
  }

  void _check() {
    if (_disposed) throw StateError('引擎服务已释放');
    if (!native) {
      throw UnsupportedError('原生引擎需要 iOS；Windows 请使用 Flutter Web 预览');
    }
  }

  Future<T> _maiaQueue<T>(Future<T> Function() run) {
    final future = _maiaTail.then((_) => run());
    _maiaTail = future.then<void>((_) {}, onError: (Object _, StackTrace _) {});
    return future;
  }

  @override
  Future<void> initialize(EngineOptions options) {
    _check();
    options.validate();
    _suspended = false;
    if (_initializing != null && _initializingKey == options.key) {
      return _initializing!;
    }
    final generation = _maiaGeneration;
    final future = _initTail.then((_) async {
      _check();
      _options = options;
      error = null;
      status = '正在准备 Stockfish 与 Maia ${options.model}…';
      _notify();
      try {
        await Future.wait([
          _stockfish.initialize(options),
          _maiaQueue(() async {
            if (generation != _maiaGeneration || _disposed) {
              throw StateError('Maia 加载已取消');
            }
            if (_model == options.model && !_confirmMaiaSession) return;
            _model = null;
            _notify();
            final response = await _channel
                .invokeMapMethod<String, dynamic>('maia.load', {
                  'model': options.model,
                  'probeTokens': maiaTokensBase64([maiaStartFen]),
                  'probeLegal': maiaProbeLegal.map(maiaUciIndex).toList(),
                  'probeTop': maiaProbeTop.map(maiaUciIndex).toList(),
                })
                .timeout(const Duration(seconds: 120));
            if (generation != _maiaGeneration || _disposed) {
              throw StateError('Maia 加载已取消');
            }
            _model = options.model;
            _confirmMaiaSession = false;
            _record(
              'Maia ready (${options.model}, ${response?['provider'] ?? 'native'})',
            );
            _notify();
          }),
        ]);
        if (_disposed) return;
        status = _suspended ? '引擎已暂停' : 'Stockfish 与 Maia 已就绪';
        _notify();
      } catch (failure) {
        if (generation == _maiaGeneration) _failure(failure);
        rethrow;
      }
    });
    _initializing = future;
    _initializingKey = options.key;
    _initTail = future.then<void>((_) {}, onError: (Object _, StackTrace _) {});
    unawaited(
      future.then<void>(
        (_) {
          if (identical(_initializing, future)) _initializing = null;
        },
        onError: (Object _, StackTrace _) {
          if (identical(_initializing, future)) _initializing = null;
        },
      ),
    );
    return future;
  }

  @override
  Future<MaiaPrediction> predict(
    String fen, {
    required int selfElo,
    required int opponentElo,
  }) async {
    _check();
    if (_suspended) throw StateError('引擎已暂停');
    if (selfElo < 0 ||
        selfElo > 10000 ||
        opponentElo < 0 ||
        opponentElo > 10000) {
      throw ArgumentError('Elo 须为 0..10000');
    }
    final predictionGeneration = _predictionGeneration;
    final position = enginePosition(fen);
    final legal = maiaLegalMoves(position);
    if (legal.isEmpty) {
      return const MaiaPrediction(moves: [], wdl: [0, 1, 0], ms: 0);
    }
    if (!maiaReady) await initialize(_options);
    final generation = _maiaGeneration;
    return _maiaQueue(() async {
      _check();
      if (_suspended ||
          generation != _maiaGeneration ||
          predictionGeneration != _predictionGeneration) {
        throw StateError('Maia 推理已取消');
      }
      try {
        final result = await _channel
            .invokeMapMethod<String, dynamic>('maia.eval', {
              'tokens': maiaTokensBase64([position.fen]),
              'indices': legal.map((move) => move.index).toList(),
              'selfElo': selfElo,
              'oppoElo': opponentElo,
            })
            .timeout(const Duration(seconds: 30));
        if (_disposed ||
            _suspended ||
            generation != _maiaGeneration ||
            predictionGeneration != _predictionGeneration) {
          throw StateError('Maia 推理已取消');
        }
        if (result == null) throw const FormatException('Maia 未返回结果');
        return decodeNativeMaia(result, legal);
      } catch (failure) {
        if (!_disposed &&
            !_suspended &&
            generation == _maiaGeneration &&
            predictionGeneration == _predictionGeneration) {
          _model = null;
          _failure(failure);
        }
        rethrow;
      }
    });
  }

  @override
  Future<Analysis> analyse(
    String fen, {
    required int milliseconds,
    required int multipv,
    String? startFen,
    required List<String> moves,
  }) async {
    _check();
    if (_suspended) return const Analysis();
    final generation = _predictionGeneration;
    if (milliseconds < 1 || milliseconds > 120000) {
      throw ArgumentError.value(milliseconds, 'milliseconds');
    }
    if (multipv < 1 || multipv > 256) {
      throw ArgumentError.value(multipv, 'multipv');
    }
    final position = engineSearchPosition(fen, startFen, moves);
    if (!stockfishReady) await initialize(_options);
    if (_suspended || _disposed || generation != _predictionGeneration) {
      return const Analysis();
    }
    return _stockfish.analyse(
      position,
      milliseconds: milliseconds,
      multipv: multipv,
    );
  }

  @override
  Future<void> stop() async {
    _predictionGeneration++;
    if (_disposed) return;
    await _stockfish.stop();
  }

  @override
  Future<void> suspend() async {
    if (_disposed) return;
    _suspended = true;
    // The native plugin rejects pending CoreML operations on background entry.
    // Invalidate that load's handle so foreground initialize cannot coalesce
    // onto the canceled operation; an already loaded model remains resident.
    _maiaGeneration++;
    _initializing = null;
    // Native lifecycle handling may release CoreML after its own 10s deadline.
    // A same-model load is cheap when retained and repairs a released session.
    _confirmMaiaSession = true;
    status = '引擎已暂停';
    _notify();
    await stop();
  }

  @override
  Future<void> unloadMaia() {
    if (_disposed) return Future.value();
    _maiaGeneration++;
    _predictionGeneration++;
    _model = null;
    _initializing = null;
    status = 'Maia 已卸载';
    _notify();
    // Unload is ordered after an in-flight load/eval, and before a subsequent
    // load. An old completion therefore cannot unload the new model session.
    return _maiaQueue(() async {
      await _channel
          .invokeMethod<void>('maia.unload')
          .timeout(const Duration(seconds: 10));
      _record('Maia unloaded');
    });
  }

  @override
  Future<Map<String, dynamic>> deviceInfo() async {
    _check();
    return await _channel
            .invokeMapMethod<String, dynamic>('device.info')
            .timeout(const Duration(seconds: 5)) ??
        {};
  }

  @override
  Future<String> logs() async {
    var nativeLogs = '';
    if (native && !_disposed) {
      try {
        final result = await _channel
            .invokeMethod<dynamic>('logs.get')
            .timeout(const Duration(seconds: 5));
        nativeLogs = result is Map
            ? (result['logs']?.toString() ?? '')
            : result?.toString() ?? '';
      } catch (failure) {
        nativeLogs = '原生日志暂不可用：$failure';
      }
    }
    return [..._log, if (nativeLogs.isNotEmpty) nativeLogs].join('\n');
  }

  @override
  Future<void> dispose() {
    return _disposing ??= _dispose();
  }

  Future<void> _dispose() async {
    if (_disposed) return;
    _disposed = true;
    _maiaGeneration++;
    _predictionGeneration++;
    _model = null;
    try {
      await Future.wait([
        _stockfish.dispose(),
        if (native)
          _maiaQueue(
            () => _channel
                .invokeMethod<void>('maia.unload')
                .timeout(const Duration(seconds: 10)),
          ),
      ]);
    } finally {
      status = '引擎已释放';
      _notify();
      onChanged = null;
    }
  }
}
