import 'dart:math' as math;

const labels = {
  'brilliant': '妙着',
  'great': '关键一着',
  'best': '最佳',
  'book': '开局库',
  'forced': '唯一着法',
  'good': '好棋',
  'inaccuracy': '不精确',
  'mistake': '错误',
  'miss': '错失良机',
  'blunder': '漏着',
};
const judgementInfo = {
  'brilliant': {'label': '妙着', 'symbol': '!!', 'color': '#1fb5ad'},
  'great': {'label': '关键一着', 'symbol': '!', 'color': '#5b8fd6'},
  'best': {'label': '最佳', 'symbol': '★', 'color': '#5bb85b'},
  'book': {'label': '开局库', 'symbol': '', 'color': '#a8865e'},
  'forced': {'label': '唯一着法', 'symbol': '', 'color': '#8f9aa3'},
  'good': {'label': '好棋', 'symbol': '', 'color': '#99aabb'},
  'inaccuracy': {'label': '不精确', 'symbol': '?!', 'color': '#e6b422'},
  'mistake': {'label': '错误', 'symbol': '?', 'color': '#e08a1e'},
  'miss': {'label': '错失良机', 'symbol': '?', 'color': '#e5675a'},
  'blunder': {'label': '漏着', 'symbol': '??', 'color': '#d9443a'},
};

double winPct(double cp) => 100 / (1 + math.exp(-0.00368208 * cp));

double moveAccuracy(double before, double after) =>
    (103.1668 * math.exp(-0.04354 * math.max(0, before - after)) - 3.1669)
        .clamp(0, 100)
        .toDouble();

String judgeMove({
  required double before,
  required double after,
  required bool playedBest,
  bool book = false,
  bool forced = false,
  bool sacrifice = false,
  double? oppDrop,
  double? secondGap,
}) {
  if (forced) return 'forced';
  if (book) return 'book';
  final drop = before - after;
  final base = playedBest
      ? 'best'
      : drop >= 15
      ? 'blunder'
      : drop >= 10
      ? 'mistake'
      : drop >= 5
      ? 'inaccuracy'
      : 'good';
  if (sacrifice && drop < 3 && after >= 50 && before < 97) return 'brilliant';
  final opponentErred = (oppDrop ?? 0) >= 10;
  if (playedBest) {
    if ((secondGap ?? 0) >= 20 && after >= 40) return 'great';
    if (opponentErred && after >= 60 && before < 97) return 'great';
    return 'best';
  }
  if ((base == 'inaccuracy' || base == 'mistake') && opponentErred) {
    return 'miss';
  }
  return base;
}

/// JavaScript Math.round resolves negative ties toward positive infinity.
int jsRound(num value) => (value + 0.5).floor();

double moveDependence(Map? evidence, String uci) {
  if (evidence == null) return 0;
  final recommendations = <dynamic>[
    if (evidence['hints'] is List) ...evidence['hints'] as List,
    if (evidence['best'] is List) ...evidence['best'] as List,
  ];
  return [
    evidence['analysis'] == true ? 0.5 : 0.0,
    evidence['reconsidered'] == true ? 0.25 : 0.0,
    recommendations.contains(uci)
        ? 0.9
        : recommendations.isNotEmpty
        ? 0.25
        : evidence['info'] == true
        ? 0.1
        : 0.0,
  ].reduce(math.max);
}

Map<String, dynamic> ratingEvidence(
  List<Map<String, dynamic>> moves,
  int hints,
) {
  bool nonempty(dynamic value) => value is List && value.isNotEmpty;
  bool includes(dynamic value, dynamic uci) =>
      value is List && value.contains(uci);
  Map evidence(Map move) =>
      move['evidence'] is Map ? move['evidence'] as Map : {};
  bool exposed(Map e) =>
      e['info'] == true ||
      e['analysis'] == true ||
      e['reconsidered'] == true ||
      nonempty(e['hints']) ||
      nonempty(e['best']);
  return {
    'moves': moves.length,
    'independent': moves.where((m) => !exposed(evidence(m))).length,
    'informed': moves.where((m) => evidence(m)['info'] == true).length,
    'suggested': moves
        .where(
          (m) =>
              nonempty(evidence(m)['hints']) || nonempty(evidence(m)['best']),
        )
        .length,
    'followed': moves
        .where(
          (m) =>
              includes(evidence(m)['hints'], m['uci']) ||
              includes(evidence(m)['best'], m['uci']),
        )
        .length,
    'hints': hints,
    'hintFollowed': moves
        .where((m) => includes(evidence(m)['hints'], m['uci']))
        .length,
    'analysis': moves.where((m) => evidence(m)['analysis'] == true).length,
    'dependence': moves.isEmpty
        ? 0.0
        : moves.fold<double>(
                0,
                (sum, m) =>
                    sum + moveDependence(evidence(m), m['uci'] as String),
              ) /
              moves.length,
  };
}

Map<String, dynamic>? ratingPerformance(
  List<Map<String, dynamic>> player,
  List<Map<String, dynamic>> opponent,
) {
  List<Map<String, dynamic>> useful(List<Map<String, dynamic>> samples) =>
      samples.where((s) {
        final before = s['before'];
        final after = s['after'];
        final independence = s['independence'];
        return s['forced'] != true &&
            before is num &&
            before.isFinite &&
            after is num &&
            after.isFinite &&
            before > 5 &&
            before < 95 &&
            after >= 0 &&
            after <= 100 &&
            (independence == null ||
                (independence is num &&
                    independence.isFinite &&
                    independence > 0 &&
                    independence <= 1));
      }).toList();
  final p = useful(player);
  final o = useful(opponent);
  if (p.isEmpty || o.isEmpty) return null;
  double accuracy(List<Map<String, dynamic>> samples) {
    var sum = 0.0;
    var weights = 0.0;
    for (final sample in samples) {
      final weight = (sample['independence'] as num? ?? 1).toDouble();
      weights += weight;
      sum +=
          moveAccuracy(
            (sample['before'] as num).toDouble(),
            (sample['after'] as num).toDouble(),
          ) *
          weight;
    }
    return sum / weights;
  }

  return {
    'playerAccuracy': accuracy(p),
    'opponentAccuracy': accuracy(o),
    'playerMoves': p.length,
    'opponentMoves': o.length,
    'mistakes': p
        .where(
          (s) =>
              (s['before'] as num) - (s['after'] as num) >= 10 &&
              (s['before'] as num) - (s['after'] as num) < 15,
        )
        .length,
    'blunders': p
        .where((s) => (s['before'] as num) - (s['after'] as num) >= 15)
        .length,
  };
}

Map<String, dynamic> computeRating({
  required num result,
  required num playerElo,
  required num opponentElo,
  required num deviation,
  required num streak,
  bool abandoned = false,
  int undo = 0,
  Map<String, dynamic>? performance,
  Map<String, dynamic>? evidence,
}) {
  if (![
        result,
        playerElo,
        opponentElo,
        deviation,
        streak,
      ].every((n) => n.isFinite) ||
      !{0, 0.5, 1}.contains(result)) {
    throw ArgumentError('无效的评级输入');
  }
  final settled = abandoned ? 0 : result;
  final confidence = math
      .max(0.1, 1 - (evidence?['dependence'] as num? ?? 0))
      .toDouble();
  final direction = settled == 1
      ? 1
      : settled == 0
      ? -1
      : 0;
  final nextStreak = confidence < 0.5
      ? 0
      : (direction == 0
                ? 0
                : streak.sign == direction
                ? streak.toInt() + direction
                : direction)
            .clamp(-8, 8);
  final rdBefore = math
      .max(deviation.clamp(60, 350), nextStreak.abs() >= 3 ? 180 : 60)
      .toDouble();
  final q = math.log(10) / 400;
  final expected = 1 / (1 + math.pow(10, (opponentElo - playerElo) / 400));
  final p = performance;
  final weight = p == null
      ? 0.0
      : 0.4 *
            (math.min(p['playerMoves'] as num, p['opponentMoves'] as num) / 20)
                .clamp(0, 1) *
            confidence;
  final quality = p == null
      ? settled
      : (0.5 +
                ((p['playerAccuracy'] as num) -
                        (p['opponentAccuracy'] as num)) /
                    100)
            .clamp(0, 1);
  var score = settled * (1 - weight) + quality * weight;
  if (settled == 1) score = math.max(expected, score);
  if (settled == 0) score = math.min(expected, score);
  final precision =
      1 / (rdBefore * rdBefore) + q * q * expected * (1 - expected);
  final rdAfter = math
      .sqrt(
        1 /
            (1 / (rdBefore * rdBefore) +
                confidence * q * q * expected * (1 - expected)),
      )
      .clamp(60, 350);
  final baseDelta = jsRound(q / precision * (score - expected));
  final takebacks = math.max(0, undo);
  final undoFactor = 1 / (1 + 0.25 * math.max(0, takebacks - 1));
  final change = baseDelta > 0
      ? jsRound(baseDelta * undoFactor * confidence)
      : baseDelta;
  final playerAfter = (playerElo + change).clamp(0, 2600);
  return {
    'delta': playerAfter - playerElo,
    'result': settled,
    'expected': expected,
    'playerBefore': playerElo,
    'playerAfter': playerAfter,
    'opponent': opponentElo,
    'rdBefore': rdBefore,
    'rdAfter': rdAfter,
    'streak': nextStreak,
    if (abandoned) 'abandoned': true,
    'calculation': {
      'score': score,
      'weight': weight,
      'performance': ?p,
      'undo': takebacks,
      'undoFactor': undoFactor,
      'baseDelta': baseDelta,
      'evidence': ?evidence,
      if (evidence != null) 'confidence': confidence,
    },
  };
}
