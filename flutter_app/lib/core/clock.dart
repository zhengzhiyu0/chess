import 'dart:math' as math;

/// Milliseconds; `none` has no running clock. Shared with settings and the UI.
const timeControls = <Map<String, dynamic>>[
  {'id': 'none', 'label': '不限时', 'baseMs': 0, 'incMs': 0},
  {'id': '3+2', 'label': '3+2 快棋', 'baseMs': 180000, 'incMs': 2000},
  {'id': '5+3', 'label': '5+3 快棋', 'baseMs': 300000, 'incMs': 3000},
  {'id': '10+5', 'label': '10+5 快棋', 'baseMs': 600000, 'incMs': 5000},
  {'id': '15+10', 'label': '15+10 慢棋', 'baseMs': 900000, 'incMs': 10000},
  {'id': '30+20', 'label': '30+20 慢棋', 'baseMs': 1800000, 'incMs': 20000},
];

Map<String, dynamic>? timeControlOf(String? id) {
  for (final tc in timeControls) {
    if (tc['id'] == id && id != 'none') return tc;
  }
  return null;
}

String pgnTimeControl(String id) {
  final tc = timeControlOf(id);
  return tc == null ? '-' : '${tc['baseMs'] ~/ 1000}+${tc['incMs'] ~/ 1000}';
}

class ChessClock {
  final String tcId;
  final double baseMs;
  final double incMs;
  List<double> remaining;
  String? active;
  double _since = 0;

  ChessClock(this.tcId, {List<double>? remaining})
    : baseMs = (timeControlOf(tcId)?['baseMs'] as num? ?? 0).toDouble(),
      incMs = (timeControlOf(tcId)?['incMs'] as num? ?? 0).toDouble(),
      remaining = _validated(
        remaining ??
            List.filled(
              2,
              (timeControlOf(tcId)?['baseMs'] as num? ?? 0).toDouble(),
            ),
      );

  static List<double> _validated(List<double> times) {
    if (times.length != 2 || times.any((t) => !t.isFinite)) {
      throw ArgumentError('棋钟必须包含两个有限的剩余时间');
    }
    return times.map((t) => math.max(0.0, t)).toList();
  }

  int _index(String color) {
    if (color != 'w' && color != 'b') throw ArgumentError.value(color, 'color');
    return color == 'w' ? 0 : 1;
  }

  double time(String color, num now) {
    final value = remaining[_index(color)];
    return active == color
        ? math.max(0.0, value - math.max(0.0, now.toDouble() - _since))
        : value;
  }

  List<double> snapshot(num now) => [time('w', now), time('b', now)];

  void stop(num now) {
    if (active != null) remaining[_index(active!)] = time(active!, now);
    active = null;
  }

  void run(String color, num now) {
    _index(color);
    if (active == color || baseMs == 0) return;
    stop(now);
    active = color;
    _since = now.toDouble();
  }

  void moved(String color, num now) {
    if (active == color) stop(now);
    final index = _index(color);
    if (remaining[index] > 0) remaining[index] += incMs;
  }

  void set(List<double> times, num now) {
    final next = _validated(times);
    final previous = active;
    active = null;
    remaining = next;
    if (previous != null) run(previous, now);
  }

  String? flagged(num now) =>
      active != null && time(active!, now) <= 0 ? active : null;
}

String formatClock(double ms) {
  final t = ms.isFinite ? math.max(0.0, ms) : 0.0;
  if (t < 10000) return '0:0${t ~/ 1000}.${(t % 1000) ~/ 100}';
  final seconds = t ~/ 1000;
  final hours = seconds ~/ 3600;
  final minutes = seconds ~/ 60 % 60;
  final tail = (seconds % 60).toString().padLeft(2, '0');
  return hours > 0
      ? '$hours:${minutes.toString().padLeft(2, '0')}:$tail'
      : '$minutes:$tail';
}

double thinkBudget(double remaining, double inc, double uncertainty) {
  final budget = remaining / 30 + inc * 0.8;
  return math.max(
    150,
    math.min(300 + uncertainty * budget * 1.6, remaining * 0.25),
  );
}
