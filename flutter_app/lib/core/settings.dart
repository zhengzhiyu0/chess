import 'clock.dart';

export 'clock.dart' show timeControls;

const maiaLevels = [
  600,
  800,
  1000,
  1200,
  1400,
  1500,
  1600,
  1800,
  2000,
  2200,
  2400,
  2600,
];

const _boards = {
  'green',
  'brown',
  'wood',
  'wood2',
  'wood3',
  'wood4',
  'maple',
  'maple2',
  'blue',
  'blue2',
  'blue3',
  'blueMarble',
  'canvas',
  'leather',
  'ic',
  'ocean',
  'greenPlastic',
  'marble',
  'gray',
  'grey',
  'metal',
  'olive',
  'newspaper',
  'purple',
  'purpleDiag',
  'pinkPyramid',
  'horsey',
  'coral',
  'night',
  'custom',
};
const _pieces = {
  'cburnett',
  'rhosgfx',
  'merida',
  'chessnut',
  'fantasy',
  'spatial',
  'celtic',
  'mpchess',
  'pixel',
  'shapes',
  'letter',
  'pirouetti',
  'kosal',
  'firi',
  'governor',
  'kiwen-suwi',
};
const _sounds = {'board', 'wood', 'felt', 'glass', 'standard'};
const _legacySounds = {
  'plastic': 'glass',
  'marble': 'glass',
  'pop': 'felt',
  'retro': 'board',
  'sfx': 'board',
  'piano': 'board',
  'nes': 'board',
  'futuristic': 'board',
};

Map<String, dynamic> _defaults() => {
  'theme': 'dark',
  'model': '23m',
  'elo': 1500,
  'playerElo': 1500,
  'ratingDeviation': 350.0,
  'ratingStreak': 0,
  'ratedGames': 0,
  'color': 'w',
  'temperature': 1.0,
  'samplingCapture': false,
  'useHistory': false,
  'backend': 'wasm',
  'thinkDelay': true,
  'sfMovetime': 1000,
  'sfThreads': 2,
  'sfHash': 128,
  'sfLite': false,
  'ecoAnalysis': true,
  'lowMemory': false,
  'warmup': true,
  'autoOffline': true,
  'aidWinPct': false,
  'aidEval': false,
  'aidArrowOutline': false,
  'aidThreats': false,
  'aidHanging': false,
  'aidBest': false,
  'timeControl': 'none',
  'sound': true,
  'soundTheme': 'board',
  'haptics': true,
  'boardTheme': 'green',
  'customLight': '#ebecd0',
  'customDark': '#739552',
  'pieceSet': 'cburnett',
  'premove': true,
  'boardFx': true,
  'boardFxRing': true,
  'boardFxSparkle': true,
  'boardFxBadge': true,
  'boardFxHang': true,
  'boardFxCapture': true,
  'boardFxCheck': true,
  'boardFxMate': true,
  'boardFxCastle': true,
  'boardFxDodge': true,
  'boardFxShake': false,
  'boardSizePlay': 100.0,
  'boardSizeReview': 100.0,
  'reviewOpponent': false,
  'avatar': '',
  'coachAvatar': 0,
  'opponentTalk': false,
  'engineGen': 3,
  'soundGen': 2,
  'coachGen': 2,
};

const _ranges = <String, (double, double, bool)>{
  'elo': (0, 2600, true),
  'playerElo': (0, 2600, true),
  'ratingDeviation': (60, 350, false),
  'ratingStreak': (-8, 8, true),
  'ratedGames': (0, 1e9, true),
  'temperature': (0, 1.5, false),
  'sfMovetime': (100, 20000, true),
  'sfThreads': (1, 16, true),
  'sfHash': (16, 1024, true),
  'boardSizePlay': (60, 100, false),
  'boardSizeReview': (60, 100, false),
  'coachAvatar': (-1, 999, true),
};

class AppSettings {
  /// Unknown fields are deliberately retained for round trips with web backups.
  final Map<String, dynamic> values;
  AppSettings._(this.values);
  factory AppSettings.defaults() => AppSettings._(_defaults());

  factory AppSettings.fromJson(Map raw) {
    final source = Map<String, dynamic>.from(raw);
    final result = _defaults();
    final known = result.keys.toSet();
    for (final entry in source.entries) {
      if (!known.contains(entry.key)) result[entry.key] = entry.value;
    }
    final choices = <String, Set<dynamic>>{
      'theme': {'dark', 'light'},
      'model': {'5m', '23m', '79m'},
      'color': {'w', 'b', 'random'},
      'backend': {'wasm', 'webgpu'},
      'useHistory': {false},
      'boardTheme': _boards,
      'pieceSet': _pieces,
      'timeControl': timeControls.map((tc) => tc['id']).toSet(),
    };
    for (final key in known) {
      if (!source.containsKey(key)) continue;
      final value = source[key];
      if (choices.containsKey(key)) {
        if (choices[key]!.contains(value)) result[key] = value;
      } else if (_ranges.containsKey(key)) {
        final (min, max, integer) = _ranges[key]!;
        if (value is num &&
            value.isFinite &&
            value >= min &&
            value <= max &&
            (!integer || value == value.truncateToDouble())) {
          result[key] = integer ? value.toInt() : value.toDouble();
        }
      } else if (result[key] is bool) {
        if (value is bool) result[key] = value;
      } else if (key == 'customLight' || key == 'customDark') {
        if (value is String && RegExp(r'^#[0-9a-fA-F]{6}$').hasMatch(value)) {
          result[key] = value;
        }
      } else if (key == 'avatar') {
        if (value is String &&
            value.length <= 200000 &&
            !RegExp('[<>"]').hasMatch(value)) {
          result[key] = value;
        }
      } else if (key.endsWith('Gen')) {
        if (value is num &&
            value.isFinite &&
            value == value.truncateToDouble()) {
          result[key] = value.toInt();
        }
      }
    }
    if (!source.containsKey('elo') && source.containsKey('maiaElo')) {
      final legacy = source['maiaElo'];
      if (legacy is num &&
          legacy.isFinite &&
          legacy >= 0 &&
          legacy <= 2600 &&
          legacy == legacy.truncateToDouble()) {
        result['elo'] = legacy.toInt();
      }
    }
    // Migrate player rating before snapping the next opponent to a preset.
    if (!source.containsKey('playerElo')) result['playerElo'] = result['elo'];
    result['elo'] = maiaLevels.reduce(
      (a, b) =>
          (b - (result['elo'] as int)).abs() <
              (a - (result['elo'] as int)).abs()
          ? b
          : a,
    );
    if (!source.containsKey('ratingDeviation')) {
      final games = result['ratedGames'] as int;
      result['ratingDeviation'] = games == 0
          ? 350.0
          : games < 5
          ? 250.0
          : games < 15
          ? 150.0
          : 80.0;
    }
    if (source['gameType'] == 'coach') {
      for (final (current, legacy) in [
        ('aidEval', 'coachEval'),
        ('aidThreats', 'coachThreats'),
        ('aidHanging', 'coachHanging'),
        ('aidBest', 'coachBest'),
      ]) {
        if (!source.containsKey(current) && source[legacy] is bool) {
          result[current] = source[legacy];
        }
      }
    }
    final sound = source['soundTheme'];
    result['soundTheme'] = _sounds.contains(sound)
        ? sound
        : _legacySounds[sound] ?? 'board';
    final soundGen = source['soundGen'];
    if (!(soundGen is num && soundGen >= 2) &&
        (sound == null || sound == 'wood' || sound == 'sfx')) {
      result['soundTheme'] = 'board';
    }
    final engineGen = source['engineGen'];
    if (!(engineGen is num && engineGen >= 2)) {
      result.addAll({
        'sfThreads': 2,
        'sfHash': 128,
        'lowMemory': false,
        'warmup': true,
      });
    } else if (engineGen == 2 && (result['sfThreads'] as int) > 2) {
      result['sfThreads'] = 2;
    }
    result.addAll({
      'engineGen': 3,
      'soundGen': 2,
      'coachGen': 2,
      'coachAvatar': 0,
    });
    return AppSettings._(result);
  }

  Map<String, dynamic> toJson() => Map<String, dynamic>.from(values);
  dynamic operator [](String key) => values[key];
  void operator []=(String key, dynamic value) => values[key] = value;

  String get theme => values['theme'] as String;
  String get model => values['model'] as String;
  String get userColor => values['color'] as String;
  String get boardTheme => values['boardTheme'] as String;
  String get pieceSet => values['pieceSet'] as String;
  String get timeControl => values['timeControl'] as String;
  String get soundTheme => values['soundTheme'] as String;
  int get elo => (values['elo'] as num).toInt();
  int get playerElo => (values['playerElo'] as num).toInt();
  int get sfThreads => (values['sfThreads'] as num).toInt();
  int get sfHash => (values['sfHash'] as num).toInt();
  int get sfMovetime => (values['sfMovetime'] as num).toInt();
  double get temperature => (values['temperature'] as num).toDouble();
  bool get sound => values['sound'] == true;
  bool get haptics => values['haptics'] == true;
  bool get sfLite => values['sfLite'] == true;
  bool get thinkDelay => values['thinkDelay'] == true;
  bool get premove => values['premove'] == true;
  bool get boardFx => values['boardFx'] == true;
}
