import 'dart:math';

class ScoredMove {
  final String uci;
  final double logit;
  final double p;

  const ScoredMove({required this.uci, required this.logit, required this.p});

  factory ScoredMove.fromJson(Map<String, dynamic> json) => ScoredMove(
    uci: json['uci'] as String,
    logit: engineNumber(json['logit'], 'logit'),
    p: engineNumber(json['p'], 'p'),
  );
}

class MaiaPrediction {
  final List<ScoredMove> moves;

  /// Probabilities in [win, draw, loss] order, from the side to move's POV.
  final List<double> wdl;
  final double ms;

  const MaiaPrediction({
    required this.moves,
    required this.wdl,
    required this.ms,
  });

  factory MaiaPrediction.fromJson(Map<String, dynamic> json) {
    final wdl = (json['wdl'] as List)
        .map((v) => engineNumber(v, 'wdl'))
        .toList(growable: false);
    if (wdl.length != 3 ||
        wdl.any((v) => v < 0 || v > 1) ||
        (wdl.reduce((a, b) => a + b) - 1).abs() > 0.0001) {
      throw const FormatException('Maia 返回了无效的 WDL 概率');
    }
    final moves = (json['moves'] as List)
        .map((v) => ScoredMove.fromJson(Map<String, dynamic>.from(v as Map)))
        .toList(growable: false);
    if (moves.any((m) => m.p < 0 || m.p > 1)) {
      throw const FormatException('Maia 返回了无效的走子概率');
    }
    return MaiaPrediction(
      moves: moves,
      wdl: wdl,
      ms: engineNumber(json['ms'], 'ms'),
    );
  }
}

class EngineLine {
  final int depth;
  final int multipv;
  final int? cp;
  final int? mate;
  final List<String> pv;
  final String? bound;

  const EngineLine({
    this.depth = 0,
    this.multipv = 1,
    this.cp,
    this.mate,
    this.pv = const [],
    this.bound,
  });

  factory EngineLine.fromJson(Map<String, dynamic> json) => EngineLine(
    depth: (json['depth'] as num?)?.toInt() ?? 0,
    multipv: (json['multipv'] as num?)?.toInt() ?? 1,
    cp: (json['cp'] as num?)?.toInt(),
    mate: (json['mate'] as num?)?.toInt(),
    pv: List<String>.from(json['pv'] as List? ?? const []),
    bound: json['bound'] as String?,
  );

  /// White's win percentage, 0..100, matching the original coach.
  double whiteWin(String turn) {
    final double win;
    if (mate != null) {
      win = mate! > 0 ? 100 : (mate! < 0 ? 0 : 50);
    } else {
      win = 100 / (1 + exp(-0.00368208 * (cp ?? 0)));
    }
    return turn == 'b' ? 100 - win : win;
  }

  String display(String turn) {
    final sign = turn == 'b' ? -1 : 1;
    if (mate != null) {
      if (mate == 0) return turn == 'b' ? '#0' : '#-0';
      return '#${sign * mate!}';
    }
    final value = sign * (cp ?? 0) / 100;
    return '${value > 0 ? '+' : ''}${value.toStringAsFixed(2)}';
  }
}

class Analysis {
  final List<EngineLine> lines;
  final String? bestmove;

  const Analysis({this.lines = const [], this.bestmove});

  factory Analysis.fromJson(Map<String, dynamic> json) => Analysis(
    lines: (json['lines'] as List? ?? const [])
        .map((v) => EngineLine.fromJson(Map<String, dynamic>.from(v as Map)))
        .toList(growable: false),
    bestmove: json['bestmove'] as String?,
  );
}

/// Full-distribution sampling (topP = 1). Subtract before dividing so even a
/// very small positive temperature never overflows the leading exponential.
String samplePrediction(
  MaiaPrediction prediction,
  double temperature, {
  Random? random,
}) {
  if (!temperature.isFinite) {
    throw ArgumentError.value(temperature, 'temperature');
  }
  if (prediction.moves.isEmpty) throw StateError('没有可采样的合法走子');
  if (prediction.moves.any((m) => !m.logit.isFinite)) {
    throw const FormatException('Maia 返回了非有限 logit');
  }
  final ordered = [...prediction.moves]
    ..sort((a, b) => b.logit.compareTo(a.logit));
  if (temperature <= 0) return ordered.first.uci;
  final maximum = ordered.first.logit;
  final weights = ordered
      .map((m) => exp((m.logit - maximum) / temperature))
      .toList();
  final total = weights.reduce((a, b) => a + b);
  var draw = (random ?? Random()).nextDouble() * total;
  for (var i = 0; i < ordered.length; i++) {
    draw -= weights[i];
    if (draw < 0) return ordered[i].uci;
  }
  return ordered.last.uci;
}

double engineNumber(Object? value, String name) {
  if (value is! num || !value.isFinite) {
    throw FormatException('引擎返回了无效的 $name');
  }
  return value.toDouble();
}

class EngineOptions {
  final String model;
  final int threads;
  final int hash;
  final bool lite;

  const EngineOptions({
    this.model = '23m',
    this.threads = 2,
    this.hash = 128,
    this.lite = false,
  });

  String get key => '$model/$threads/$hash/$lite';
  String get stockfishKey => '$threads/$hash/$lite';

  void validate() {
    if (!const ['5m', '23m', '79m'].contains(model)) {
      throw ArgumentError.value(model, 'model');
    }
    if (threads < 1 || threads > 32) {
      throw ArgumentError.value(threads, 'threads', '须为 1..32');
    }
    if (hash < 1 || hash > 2048) {
      throw ArgumentError.value(hash, 'hash', '须为 1..2048 MiB');
    }
  }

  Map<String, dynamic> toJson() => {
    'model': model,
    'threads': threads,
    'hash': hash,
    'lite': lite,
  };
}

abstract class EngineBackend {
  void Function()? onChanged;
  String get status;
  String? get error;
  bool get native;
  bool get stockfishReady;
  bool get maiaReady;
  Future<void> initialize(EngineOptions options);
  Future<MaiaPrediction> predict(
    String fen, {
    required int selfElo,
    required int opponentElo,
  });
  Future<Analysis> analyse(
    String fen, {
    required int milliseconds,
    required int multipv,
    String? startFen,
    required List<String> moves,
  });
  Future<void> stop();
  Future<void> suspend();
  Future<void> unloadMaia();
  Future<Map<String, dynamic>> deviceInfo();
  Future<String> logs();
  Future<void> dispose();
}
