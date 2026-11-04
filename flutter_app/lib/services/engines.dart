import 'engine_types.dart';
import 'engine_native.dart'
    if (dart.library.js_interop) 'engine_web.dart'
    as platform;

export 'engine_types.dart'
    show ScoredMove, MaiaPrediction, Analysis, EngineLine, samplePrediction;

/// Flutter widgets only talk to this service. iOS uses platform channels;
/// browser previews use an independent engine-only JS module, without a WebView.
class EngineService {
  final EngineBackend _backend = platform.createEngineBackend();
  void Function()? onChanged;

  EngineService({this.onChanged}) {
    _backend.onChanged = () => onChanged?.call();
  }

  String get status => _backend.status;
  String? get error => _backend.error;
  bool get native => _backend.native;
  bool get stockfishReady => _backend.stockfishReady;
  bool get maiaReady => _backend.maiaReady;
  bool get ready => stockfishReady && maiaReady;

  Future<void> initialize({
    String model = '23m',
    int threads = 2,
    int hash = 128,
    bool lite = false,
  }) {
    final options = EngineOptions(
      model: model,
      threads: threads,
      hash: hash,
      lite: lite,
    );
    options.validate();
    return _backend.initialize(options);
  }

  Future<MaiaPrediction> predict(
    String fen, {
    required int selfElo,
    required int opponentElo,
  }) => _backend.predict(fen, selfElo: selfElo, opponentElo: opponentElo);

  /// When history is supplied, [fen] is the final position and [startFen] is
  /// the position before [moves]. Moves must never be applied to the final FEN.
  Future<Analysis> analyse(
    String fen, {
    int milliseconds = 1000,
    int multipv = 3,
    String? startFen,
    List<String> moves = const [],
  }) => _backend.analyse(
    fen,
    milliseconds: milliseconds,
    multipv: multipv,
    startFen: startFen,
    moves: List.of(moves),
  );

  Future<void> stop() => _backend.stop();
  Future<void> suspend() => _backend.suspend();
  Future<void> unloadMaia() => _backend.unloadMaia();
  Future<Map<String, dynamic>> deviceInfo() => _backend.deviceInfo();
  Future<String> logs() => _backend.logs();
  Future<void> dispose() => _backend.dispose();
}
