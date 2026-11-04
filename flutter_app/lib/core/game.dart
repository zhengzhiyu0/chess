import 'dart:convert';

import 'chess.dart';

Map<String, dynamic>? sanitizeMoveEvidence(dynamic raw) {
  if (raw is! Map) return null;
  final result = <String, dynamic>{};
  for (final key in ['hints', 'best']) {
    final values = raw[key];
    if (values is List) {
      final moves = values
          .whereType<String>()
          .where(uciPattern.hasMatch)
          .toSet()
          .take(64)
          .toList();
      if (moves.isNotEmpty) result[key] = moves;
    }
  }
  for (final key in ['info', 'analysis', 'reconsidered']) {
    if (raw[key] == true) result[key] = true;
  }
  return result.isEmpty ? null : result;
}

class GameNode {
  final int id;
  final String fen;
  final String uci;
  final String san;
  final GameNode? parent;
  final List<GameNode> children = [];
  final int ply;
  String? comment;
  List<int> nags = [];
  List<double>? clock;
  bool exploration;

  /// Transient analysis, not included in the stored game tree.
  final Map<String, dynamic> annotations = {};
  Map<String, dynamic>? evidence;
  final Map<String, dynamic> _extra = {};

  GameNode({
    required this.id,
    required this.fen,
    required this.uci,
    required this.san,
    required this.parent,
    required this.ply,
    this.exploration = false,
  });

  GameNode? get mainChild {
    if (children.isEmpty) return null;
    final first = children.first;
    return !first.exploration || exploration ? first : null;
  }
}

class GameTree {
  final GameNode root;
  int _nextId = 1;
  String get startFen => root.fen;

  GameTree(String startFen)
    : root = GameNode(
        id: 0,
        fen: fenOf(position(startFen)),
        uci: '',
        san: '',
        parent: null,
        ply: 0,
      );

  GameNode? add(GameNode parent, String uci, {bool explore = false}) {
    if (!uciPattern.hasMatch(uci)) return null;
    for (final child in parent.children) {
      if (child.uci != uci) continue;
      if (!explore && child.exploration && !parent.exploration) {
        child.exploration = false;
        parent.children.remove(child);
        _insertReal(parent.children, child);
      }
      return child;
    }
    final moves = legalMoves(parent.fen);
    ChessMove? move;
    for (final candidate in moves) {
      if (candidate.uci == uci) {
        move = candidate;
        break;
      }
    }
    if (move == null) return null;
    final game = position(parent.fen);
    if (!playUci(game, uci)) return null;
    final node = GameNode(
      id: _nextId++,
      fen: fenOf(game),
      uci: uci,
      san: move.san,
      parent: parent,
      ply: parent.ply + 1,
      exploration: explore || parent.exploration,
    );
    if (node.exploration) {
      parent.children.add(node);
    } else {
      _insertReal(parent.children, node);
    }
    return node;
  }

  void _insertReal(List<GameNode> siblings, GameNode node) {
    final index = siblings.indexWhere((child) => child.exploration);
    if (index < 0) {
      siblings.add(node);
    } else {
      siblings.insert(index, node);
    }
  }

  List<GameNode> pathTo(GameNode node) {
    final result = <GameNode>[];
    for (GameNode? current = node; current != null; current = current.parent) {
      result.add(current);
    }
    return result.reversed.toList();
  }

  List<GameNode> lineThrough(GameNode node) {
    final result = pathTo(node);
    for (
      var current = node.mainChild;
      current != null;
      current = current.mainChild
    ) {
      result.add(current);
    }
    return result;
  }

  List<GameNode> mainline() => lineThrough(root);

  Iterable<GameNode> nodes([GameNode? from]) sync* {
    // Iterative traversal also handles long imported games without stack growth.
    final pending = <GameNode>[from ?? root];
    while (pending.isNotEmpty) {
      final node = pending.removeLast();
      yield node;
      pending.addAll(node.children.reversed);
    }
  }

  bool isMainline(GameNode node) {
    for (
      var current = node;
      current.parent != null;
      current = current.parent!
    ) {
      if (current.exploration || current.parent!.children.first != current) {
        return false;
      }
    }
    return true;
  }

  void makeMainline(GameNode node) {
    for (
      GameNode? current = node;
      current != null;
      current = current.children.isEmpty ? null : current.children.first
    ) {
      current.exploration = false;
    }
    for (
      var current = node;
      current.parent != null;
      current = current.parent!
    ) {
      current.exploration = false;
      final siblings = current.parent!.children;
      siblings.remove(current);
      siblings.insert(0, current);
    }
  }

  void remove(GameNode node) => node.parent?.children.remove(node);

  Map<String, dynamic> serialize([GameNode? node]) {
    final current = node ?? root;
    return {
      ...current._extra,
      if (current.uci.isNotEmpty) 'u': current.uci,
      if (current.children.isNotEmpty)
        'c': current.children.map(serialize).toList(),
      if (current.comment?.isNotEmpty == true) 't': current.comment,
      if (current.nags.isNotEmpty) 'n': List<int>.from(current.nags),
      if (current.clock != null) 'k': List<double>.from(current.clock!),
      if (current.exploration) 'x': 1,
      if (current.evidence != null) 'e': current.evidence,
    };
  }

  static GameTree deserialize(String startFen, Map raw) {
    final tree = GameTree(startFen);
    final pending = <(GameNode, Map)>[(tree.root, raw)];
    var count = 0;
    while (pending.isNotEmpty) {
      final (node, source) = pending.removeLast();
      if (++count > 100000) throw const FormatException('对局数据过大');
      for (final entry in source.entries) {
        if (entry.key is String &&
            !{'u', 'c', 't', 'n', 'k', 'x', 'e'}.contains(entry.key)) {
          node._extra[entry.key as String] = entry.value;
        }
      }
      if (source['t'] is String) node.comment = source['t'] as String;
      final nags = source['n'];
      if (nags is List &&
          nags.every(
            (n) => n is num && n.isFinite && n == n.truncateToDouble(),
          )) {
        node.nags = nags.map((n) => (n as num).toInt()).toList();
      }
      final clock = source['k'];
      if (clock is List &&
          clock.length == 2 &&
          clock.every((n) => n is num && n.isFinite)) {
        node.clock = clock.map((n) => (n as num).toDouble()).toList();
      }
      node.evidence = sanitizeMoveEvidence(source['e']);
      final children = source['c'];
      if (children != null && children is! List) {
        throw const FormatException('对局数据损坏');
      }
      if (children is List) {
        for (final child in children) {
          if (child is! Map || child['u'] is! String) {
            throw const FormatException('对局数据损坏');
          }
          final added = tree.add(
            node,
            child['u'] as String,
            explore: child['x'] == 1 || child['x'] == true,
          );
          if (added == null) throw FormatException('非法着法：${child['u']}');
          pending.add((added, child));
        }
      }
    }
    return tree;
  }

  static GameTree fromMoves(String startFen, Iterable<String> moves) {
    final tree = GameTree(startFen);
    var node = tree.root;
    for (final uci in moves) {
      final next = tree.add(node, uci);
      if (next == null) throw FormatException('非法着法：$uci');
      node = next;
    }
    return tree;
  }
}

class ParsedGame {
  final GameTree tree;
  final Map<String, String> headers;
  final String result;
  final bool truncated;
  const ParsedGame(
    this.tree,
    this.headers,
    this.result, {
    this.truncated = false,
  });
}

const _results = {'1-0', '0-1', '1/2-1/2', '*'};
const nagSymbols = {1: '!', 2: '?', 3: '!!', 4: '??', 5: '!?', 6: '?!'};
const _suffixNags = {'!': 1, '?': 2, '!!': 3, '??': 4, '!?': 5, '?!': 6};

class _Token {
  final String kind;
  final String value;
  final String? name;
  final int offset;
  const _Token(this.kind, this.value, this.offset, [this.name]);
}

List<_Token> _tokenize(String text) {
  final tokens = <_Token>[];
  final wordPattern = RegExp(r'^[^\s{}()\[\];$]+');
  var i = 0;
  while (i < text.length) {
    final start = i;
    final ch = text[i];
    if (RegExp(r'\s').hasMatch(ch)) {
      i++;
    } else if (ch == '[') {
      var end = i + 1;
      var quoted = false;
      for (; end < text.length; end++) {
        if (text[end] == '\\' && quoted) {
          end++;
        } else if (text[end] == '"') {
          quoted = !quoted;
        } else if (text[end] == ']' && !quoted) {
          break;
        } else if (text[end] == '\n' && quoted) {
          break;
        }
      }
      if (end >= text.length || text[end] != ']') end = text.indexOf(']', i);
      final body = text.substring(i + 1, end < 0 ? text.length : end);
      final match = RegExp(r'^\s*(\w+)\s+"((?:[^"\\]|\\.)*)"\s*$')
          .firstMatch(body);
      if (match != null) {
        final value = match[2]!.replaceAllMapped(
          RegExp(r'\\(.)'),
          (m) => m[1]!,
        );
        tokens.add(_Token('header', value, start, match[1]));
      }
      i = end < 0 ? text.length : end + 1;
    } else if (ch == '{' || ch == ';') {
      final end = text.indexOf(ch == '{' ? '}' : '\n', i + 1);
      tokens.add(
        _Token(
          'comment',
          text.substring(i + 1, end < 0 ? text.length : end),
          start,
        ),
      );
      i = end < 0 ? text.length : end + 1;
    } else if (ch == '%' && (i == 0 || text[i - 1] == '\n')) {
      final end = text.indexOf('\n', i);
      i = end < 0 ? text.length : end + 1;
    } else if (ch == '(' || ch == ')') {
      tokens.add(_Token(ch == '(' ? 'open' : 'close', ch, start));
      i++;
    } else if (ch == r'$') {
      final match = RegExp(r'^\$(\d+)').firstMatch(text.substring(i));
      if (match != null) tokens.add(_Token('nag', match[1]!, start));
      i += match?[0]?.length ?? 1;
    } else {
      final match = wordPattern.firstMatch(text.substring(i));
      if (match == null) {
        i++;
        continue;
      }
      final word = match[0]!;
      i += word.length;
      if (_results.contains(word)) {
        tokens.add(_Token('result', word, start));
      } else {
        final san = word.replaceFirst(RegExp(r'^\d+\.+'), '');
        if (san.isNotEmpty && san != '...' && !RegExp(r'^\d+$').hasMatch(san)) {
          tokens.add(_Token('san', san, start));
        }
      }
    }
  }
  return tokens;
}

double? parsePgnClock(String text) {
  final match = RegExp(r'^(\d+):(\d{1,2}):(\d{1,2}(?:\.\d+)?)$')
      .firstMatch(text.trim());
  if (match == null) return null;
  final minutes = int.parse(match[2]!);
  final seconds = double.parse(match[3]!);
  if (minutes >= 60 || seconds >= 60) return null;
  return ((int.parse(match[1]!) * 3600 + minutes * 60 + seconds) * 1000)
      .roundToDouble();
}

ParsedGame parsePgn(String text) {
  final tokens = _tokenize(
    text.replaceAll('\r\n', '\n').replaceAll('\r', '\n'),
  );
  final headers = <String, String>{};
  var i = 0;
  while (i < tokens.length && tokens[i].kind == 'header') {
    headers[tokens[i].name!] = tokens[i].value;
    i++;
  }
  final tree = GameTree(headers['FEN'] ?? startFen);
  var current = tree.root;
  final stack = <GameNode>[];
  var result = _results.contains(headers['Result']) ? headers['Result']! : '*';
  var moves = 0;
  var skip = -1;
  var truncated = false;
  String? leadComment;
  List<int>? leadNags;
  movetext:
  for (; i < tokens.length; i++) {
    final token = tokens[i];
    if (token.kind == 'header') break;
    if (skip >= 0) {
      if (token.kind == 'open') {
        skip++;
      } else if (token.kind == 'close') {
        if (skip-- == 0) {
          skip = -1;
          if (stack.isNotEmpty) current = stack.removeLast();
          leadComment = null;
          leadNags = null;
        }
      } else if (token.kind == 'result' && stack.isEmpty) {
        result = token.value;
        break;
      }
      continue;
    }
    switch (token.kind) {
      case 'result':
        if (stack.isEmpty) {
          result = token.value;
          break movetext;
        }
      case 'open':
        if (current.parent == null) throw const FormatException('变着位置错误');
        stack.add(current);
        current = current.parent!;
        leadComment = null;
        leadNags = [];
      case 'close':
        if (stack.isNotEmpty) current = stack.removeLast();
        leadComment = null;
        leadNags = null;
      case 'nag':
        final nag = int.tryParse(token.value);
        if (nag != null) {
          if (leadNags != null) {
            leadNags.add(nag);
          } else if (current != tree.root) {
            current.nags.add(nag);
          }
        }
      case 'comment':
        var note = token.value.replaceAllMapped(
          RegExp(r'\[%clk\s+([^\]]+)\]'),
          (match) {
            final ms = parsePgnClock(match[1]!);
            if (ms != null && current.parent != null && leadNags == null) {
              final previous =
                  current.clock ?? current.parent!.clock ?? [ms, ms];
              current.clock = List<double>.from(previous);
              current.clock![turnOf(current.parent!.fen) == 'w' ? 0 : 1] = ms;
            }
            return '';
          },
        );
        note = note.replaceAll(RegExp(r'\s+'), ' ').trim();
        if (note.isNotEmpty) {
          if (leadNags != null) {
            leadComment = [leadComment, note].whereType<String>().join(' ');
          } else {
            current.comment = [
              current.comment,
              note,
            ].whereType<String>().join(' ');
          }
        }
      case 'san':
        var san = token.value
            .replaceFirst(RegExp(r'^0-0-0'), 'O-O-O')
            .replaceFirst(RegExp(r'^0-0'), 'O-O');
        final suffix = RegExp(r'[!?]+$').firstMatch(san)?[0];
        if (suffix != null) san = san.substring(0, san.length - suffix.length);
        if (san == '--' || san == 'Z0') {
          truncated = true;
          skip = 0;
          continue;
        }
        final plain = san.replaceAll(RegExp(r'[+#=]'), '');
        ChessMove? selected;
        for (final move in legalMoves(current.fen)) {
          if (move.san.replaceAll(RegExp(r'[+#=]'), '') == plain ||
              move.uci == san) {
            selected = move;
            break;
          }
        }
        if (selected == null) {
          throw FormatException(
            '第 ${moveNumberOf(current.fen)} 回合着法非法：${token.value}',
          );
        }
        current = tree.add(current, selected.uci)!;
        if (leadComment != null) {
          current.comment = [
            leadComment,
            current.comment,
          ].whereType<String>().join(' ');
        }
        if (leadNags != null) current.nags.addAll(leadNags);
        leadComment = null;
        leadNags = null;
        if (suffix != null && _suffixNags.containsKey(suffix)) {
          current.nags.add(_suffixNags[suffix]!);
        }
        moves++;
    }
  }
  if (moves == 0 && headers.isEmpty) throw const FormatException('没有找到着法');
  return ParsedGame(tree, headers, result, truncated: truncated);
}

List<String> splitPgn(String text) {
  final normalized = text
      .replaceAll('\r\n', '\n')
      .replaceAll('\r', '\n')
      .trim();
  if (normalized.isEmpty) return [];
  final out = <String>[];
  var start = 0;
  var depth = 0;
  var inMoves = false;
  var finished = false;
  for (final token in _tokenize(normalized)) {
    if (depth == 0 &&
        ((token.kind == 'header' && inMoves) ||
            (finished && token.kind == 'san'))) {
      final game = normalized.substring(start, token.offset).trim();
      if (game.isNotEmpty) out.add(game);
      start = token.offset;
      inMoves = false;
      finished = false;
    }
    if (token.kind == 'open') depth++;
    if (token.kind == 'close' && depth > 0) depth--;
    if (token.kind == 'san' || token.kind == 'result') inMoves = true;
    if (depth == 0 && token.kind == 'result') finished = true;
  }
  final last = normalized.substring(start).trim();
  if (last.isNotEmpty) out.add(last);
  return out;
}

String _formatPgnClock(double ms) {
  final millis = ms < 0 ? 0 : ms.round();
  final total = millis ~/ 1000;
  final fraction = millis % 1000;
  final suffix = fraction == 0
      ? ''
      : '.${fraction.toString().padLeft(3, '0').replaceFirst(RegExp(r'0+$'), '')}';
  return '${total ~/ 3600}:${(total ~/ 60 % 60).toString().padLeft(2, '0')}:${(total % 60).toString().padLeft(2, '0')}$suffix';
}

String exportPgn(GameTree tree, Map<String, String> headers) {
  final tags = Map<String, String>.from(headers);
  if (tree.root.fen != startFen) {
    tags.addAll({'SetUp': '1', 'FEN': tree.root.fen});
  }
  tags.putIfAbsent('Result', () => '*');
  const order = ['Event', 'Site', 'Date', 'Round', 'White', 'Black', 'Result'];
  final keys = [
    ...order.where(tags.containsKey),
    ...tags.keys.where((k) => !order.contains(k)),
  ];
  final head = keys
      .map((key) {
        final value = tags[key]!
            .replaceAll('\\', '\\\\')
            .replaceAll('"', '\\"')
            .replaceAll(RegExp(r'[\r\n]'), ' ');
        return '[$key "$value"]';
      })
      .join('\n');
  final out = <String>[];
  String noteOf(GameNode node, String? mover) {
    final commands = node.annotations['commands'];
    final notes = <String>[
      if (commands is List) ...commands.whereType<String>(),
      if (node.clock != null && mover != null)
        '[%clk ${_formatPgnClock(node.clock![mover == 'w' ? 0 : 1])}]',
      if (node.comment?.isNotEmpty == true) node.comment!,
    ];
    return notes.join(' ').replaceAll(RegExp('[{}]'), '');
  }

  void emitLine(GameNode from, GameNode first) {
    var parent = from;
    GameNode? node = first;
    var needNumber = true;
    while (node != null) {
      final mover = turnOf(parent.fen);
      final number = moveNumberOf(parent.fen);
      out.add(
        mover == 'w'
            ? '$number. ${node.san}'
            : needNumber
            ? '$number... ${node.san}'
            : node.san,
      );
      final extraNags = node.annotations['nags'];
      final nags = {
        ...node.nags,
        if (extraNags is List) ...extraNags.whereType<int>(),
      };
      out.addAll(nags.map((nag) => '\$$nag'));
      final note = noteOf(node, mover);
      if (note.isNotEmpty) out.add('{ $note }');
      var interrupted = note.isNotEmpty;
      final real = parent.children
          .where((child) => !child.exploration)
          .toList();
      if (real.isNotEmpty && real.first == node) {
        for (final variation in real.skip(1)) {
          out.add('(');
          emitLine(parent, variation);
          out.add(')');
          interrupted = true;
        }
      }
      needNumber = interrupted;
      parent = node;
      final children = node.children.where((child) => !child.exploration);
      node = children.isEmpty ? null : children.first;
    }
  }

  final rootNote = noteOf(tree.root, null);
  if (rootNote.isNotEmpty) out.add('{ $rootNote }');
  final real = tree.root.children.where((child) => !child.exploration);
  if (real.isNotEmpty) emitLine(tree.root, real.first);
  out.add(tags['Result']!);
  final text = out.join(' ').replaceAll('( ', '(').replaceAll(' )', ')');
  final lines = <String>[];
  var line = '';
  for (final word in text.split(' ')) {
    if (line.isNotEmpty && line.length + word.length + 1 > 80) {
      lines.add(line);
      line = word;
    } else {
      line = line.isEmpty ? word : '$line $word';
    }
  }
  if (line.isNotEmpty) lines.add(line);
  return '$head\n\n${lines.join('\n')}\n';
}

/// JSON wrapper: historical opponent settings, annotations and unknown backup
/// fields stay intact. Hydrate [tree] with GameTree.deserialize when opened.
class StoredGame {
  final Map<String, dynamic> data;
  StoredGame(this.data);

  factory StoredGame.fromJson(Map raw) {
    final data = Map<String, dynamic>.from(raw);
    final id = data['id'];
    final date = data['date'];
    if (id is! String ||
        !RegExp(r'^[\w-]{1,64}$').hasMatch(id) ||
        date is! num ||
        !date.isFinite ||
        data['startFen'] is! String ||
        data['tree'] is! Map ||
        !{'w', 'b'}.contains(data['userColor'])) {
      throw const FormatException('对局数据损坏');
    }
    position(data['startFen'] as String);
    final result = data['result'];
    data['result'] = result == '*' || !{'', ..._results}.contains(result)
        ? ''
        : result;
    return StoredGame(
      Map<String, dynamic>.from(jsonDecode(jsonEncode(data)) as Map),
    );
  }

  String get id => data['id'] as String;
  int get date => (data['date'] as num).toInt();
  String get startFen => data['startFen'] as String;
  String get userColor => data['userColor'] as String;
  String get result => data['result'] as String? ?? '';
  set result(String value) => data['result'] = value;
  Map<String, dynamic> get tree =>
      Map<String, dynamic>.from(data['tree'] as Map);
  Map<String, dynamic> toJson() => Map<String, dynamic>.from(data);
}

String? outcomeOf(Map game) {
  if (game['result'] == '1/2-1/2') return 'draw';
  if (game['result'] == '1-0') return game['userColor'] == 'w' ? 'win' : 'loss';
  if (game['result'] == '0-1') return game['userColor'] == 'b' ? 'win' : 'loss';
  return null;
}

Map<String, dynamic> computeStats(List<Map<String, dynamic>> history) {
  final played = history
      .where((g) => g['imported'] != true && outcomeOf(g) != null)
      .toList();
  Map<String, dynamic> tally(Iterable<Map<String, dynamic>> games) {
    var win = 0;
    var draw = 0;
    var loss = 0;
    for (final game in games) {
      switch (outcomeOf(game)) {
        case 'win':
          win++;
        case 'draw':
          draw++;
        case 'loss':
          loss++;
      }
    }
    final count = win + draw + loss;
    return {
      'games': count,
      'win': win,
      'draw': draw,
      'loss': loss,
      'score': count == 0 ? 0.0 : (win + draw / 2) / count * 100,
    };
  }

  played.sort((a, b) => (b['date'] as num).compareTo(a['date'] as num));
  final buckets = <int, List<Map<String, dynamic>>>{};
  for (final game in played) {
    final elo = game['elo'];
    if (elo is num && elo.isFinite) {
      (buckets[(elo / 200).floor() * 200] ??= []).add(game);
    }
  }
  final recent = played.take(10).map((g) => outcomeOf(g)!).toList();
  final count = recent.isEmpty
      ? 0
      : played.takeWhile((g) => outcomeOf(g) == recent.first).length;
  return {
    'all': tally(played),
    'white': tally(played.where((g) => g['userColor'] == 'w')),
    'black': tally(played.where((g) => g['userColor'] == 'b')),
    'byElo': [
      for (final elo in buckets.keys.toList()..sort())
        {'elo': elo, 't': tally(buckets[elo]!)},
    ],
    'recent': recent,
    'streak': count == 0 ? null : {'kind': recent.first, 'n': count},
  };
}
