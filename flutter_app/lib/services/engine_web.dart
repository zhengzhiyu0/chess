import 'dart:async';
import 'dart:convert';
import 'dart:js_interop';

import 'engine_types.dart';

@JS('maiaFlutter')
external _MaiaFlutter? get _bridge;

extension type _MaiaFlutter._(JSObject _) implements JSObject {
  external JSPromise<JSString> initialize(JSString request);
  external JSPromise<JSString> predict(JSString request);
  external JSPromise<JSString> analyse(JSString request);
  external JSPromise<JSString> stop();
  external JSPromise<JSString> suspend();
  external JSPromise<JSString> unloadMaia();
  external JSPromise<JSString> deviceInfo();
  external JSPromise<JSString> logs();
  external JSPromise<JSString> dispose();
  external JSString state();
  external JSFunction? get onChanged;
  external set onChanged(JSFunction? callback);
}

EngineBackend createEngineBackend() => WebEngineBackend();

class WebEngineBackend extends EngineBackend {
  _MaiaFlutter? _connected;
  JSFunction? _callback;
  bool _disposed = false;
  @override
  String status = '引擎尚未初始化';
  @override
  String? error;
  @override
  bool get native => false;
  bool _stockfishReady = false;
  bool _maiaReady = false;
  @override
  bool get stockfishReady => !_disposed && _stockfishReady;
  @override
  bool get maiaReady => !_disposed && _maiaReady;

  _MaiaFlutter _connect() {
    if (_disposed) throw StateError('引擎服务已释放');
    if (_connected != null) return _connected!;
    final bridge = _bridge;
    if (bridge == null) {
      throw StateError(
        'Web 引擎桥未加载，请在 flutter_bootstrap.js 前 await import("./engine/bridge.js")',
      );
    }
    _connected = bridge;
    _callback = (() => _refresh()).toJS;
    bridge.onChanged = _callback;
    _refresh();
    return bridge;
  }

  void _refresh() {
    final bridge = _connected;
    if (bridge == null || _disposed) return;
    final state = jsonDecode(bridge.state().toDart) as Map<String, dynamic>;
    status = state['status'] as String? ?? status;
    error = state['error'] as String?;
    _stockfishReady = state['stockfishReady'] == true;
    _maiaReady = state['maiaReady'] == true;
    onChanged?.call();
  }

  Future<Map<String, dynamic>> _call(
    JSPromise<JSString> Function(_MaiaFlutter) invoke, {
    Duration timeout = const Duration(seconds: 45),
  }) async {
    try {
      final response = await invoke(_connect()).toDart.timeout(timeout);
      final result = jsonDecode(response.toDart);
      if (result is! Map) throw const FormatException('Web 引擎返回了无效的 JSON');
      return Map<String, dynamic>.from(result);
    } catch (failure) {
      if (!_disposed) {
        error = failure.toString();
        status = '引擎错误：$error';
        onChanged?.call();
      }
      rethrow;
    } finally {
      _refresh();
    }
  }

  @override
  Future<void> initialize(EngineOptions options) async {
    options.validate();
    await _call(
      (bridge) => bridge.initialize(jsonEncode(options.toJson()).toJS),
      timeout: const Duration(minutes: 4),
    );
  }

  @override
  Future<MaiaPrediction> predict(
    String fen, {
    required int selfElo,
    required int opponentElo,
  }) async => MaiaPrediction.fromJson(
    await _call(
      (bridge) => bridge.predict(
        jsonEncode({'fen': fen, 'selfElo': selfElo, 'opponentElo': opponentElo})
            .toJS,
      ),
    ),
  );

  @override
  Future<Analysis> analyse(
    String fen, {
    required int milliseconds,
    required int multipv,
    String? startFen,
    required List<String> moves,
  }) async {
    if (milliseconds < 1 || milliseconds > 120000) {
      throw ArgumentError.value(milliseconds, 'milliseconds');
    }
    if (multipv < 1 || multipv > 256) {
      throw ArgumentError.value(multipv, 'multipv');
    }
    return Analysis.fromJson(
      await _call(
        (bridge) => bridge.analyse(
          jsonEncode({
            'fen': fen,
            'milliseconds': milliseconds,
            'multipv': multipv,
            'startFen': ?startFen,
            'moves': moves,
          }).toJS,
        ),
        timeout: Duration(milliseconds: milliseconds + 30000),
      ),
    );
  }

  @override
  Future<void> stop() async {
    await _call(
      (bridge) => bridge.stop(),
      timeout: const Duration(seconds: 15),
    );
  }

  @override
  Future<void> suspend() async {
    await _call(
      (bridge) => bridge.suspend(),
      timeout: const Duration(seconds: 15),
    );
  }

  @override
  Future<void> unloadMaia() async {
    await _call(
      (bridge) => bridge.unloadMaia(),
      timeout: const Duration(seconds: 15),
    );
  }

  @override
  Future<Map<String, dynamic>> deviceInfo() => _call(
    (bridge) => bridge.deviceInfo(),
    timeout: const Duration(seconds: 5),
  );
  @override
  Future<String> logs() async =>
      (await _call(
            (bridge) => bridge.logs(),
            timeout: const Duration(seconds: 5),
          ))['logs']
          as String? ??
      '';

  @override
  Future<void> dispose() async {
    if (_disposed) return;
    final bridge = _connected;
    try {
      if (bridge != null) {
        await bridge.dispose().toDart.timeout(const Duration(seconds: 15));
      }
    } finally {
      if (bridge != null && bridge.onChanged == _callback) {
        bridge.onChanged = null;
      }
      _connected = null;
      _callback = null;
      _disposed = true;
      _stockfishReady = false;
      _maiaReady = false;
      status = '引擎已释放';
      onChanged?.call();
      onChanged = null;
    }
  }
}
