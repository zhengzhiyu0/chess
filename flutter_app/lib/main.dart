import 'dart:async';
import 'dart:convert';
import 'dart:math';

import 'package:file_selector/file_selector.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:flutter_svg/flutter_svg.dart';
import 'package:share_plus/share_plus.dart';

import 'app_controller.dart';
import 'core/chess.dart';
import 'core/clock.dart';
import 'core/game.dart';
import 'core/training.dart' show themeLabels;
import 'ui/charts.dart';
import 'ui/theme.dart';
import 'widgets/chess_board.dart';

void main() {
  WidgetsFlutterBinding.ensureInitialized();
  for (final family in ['NotoSansSC', 'NotoSansSymbols2', 'NotoEmoji']) {
    LicenseRegistry.addLicense(() async* {
      yield LicenseEntryWithLineBreaks(
        [family],
        await rootBundle.loadString('assets/fonts/OFL-$family.txt'),
      );
    });
  }
  runApp(const MaiaCoachApp());
}

class MaiaCoachApp extends StatefulWidget {
  const MaiaCoachApp({super.key});
  @override
  State<MaiaCoachApp> createState() => _MaiaCoachAppState();
}

class _MaiaCoachAppState extends State<MaiaCoachApp>
    with WidgetsBindingObserver {
  final app = AppController();
  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    unawaited(app.load());
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    unawaited(app.setForeground(state == AppLifecycleState.resumed));
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    app.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: app,
    builder: (context, _) => MaterialApp(
      debugShowCheckedModeBanner: false,
      title: 'Maia Coach',
      theme: appTheme(Brightness.light),
      darkTheme: appTheme(Brightness.dark),
      themeMode: app.settings.theme == 'light'
          ? ThemeMode.light
          : ThemeMode.dark,
      locale: const Locale('zh', 'CN'),
      supportedLocales: const [Locale('zh', 'CN'), Locale('en')],
      localizationsDelegates: GlobalMaterialLocalizations.delegates,
      home: CoachShell(app: app),
    ),
  );
}

class CoachShell extends StatefulWidget {
  const CoachShell({super.key, required this.app});
  final AppController app;
  @override
  State<CoachShell> createState() => _CoachShellState();
}

class _CoachShellState extends State<CoachShell> {
  AppController get app => widget.app;
  final Map<String, dynamic> _boards = {}, _pieces = {};
  bool trainingBoard = false;
  final _settingControllers = <String, TextEditingController>{};

  @override
  void initState() {
    super.initState();
    rootBundle.loadString('assets/data/appearance.json').then((text) {
      final data = jsonDecode(text) as Map;
      if (mounted) {
        setState(() {
          _boards.addAll(Map<String, dynamic>.from(data['boards'] as Map));
          _pieces.addAll(Map<String, dynamic>.from(data['pieces'] as Map));
        });
      }
    });
  }

  @override
  void dispose() {
    for (final controller in _settingControllers.values) {
      controller.dispose();
    }
    super.dispose();
  }

  Future<void> _guard(Future<void> Function() action) async {
    try {
      await action();
    } catch (error) {
      if (mounted) _snack(error.toString());
    }
  }

  void _snack(String text) {
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(text)));
  }

  Color _hex(String? text, Color fallback) =>
      text != null && RegExp(r'^#[\da-fA-F]{6}$').hasMatch(text)
      ? Color(int.parse('ff${text.substring(1)}', radix: 16))
      : fallback;

  @override
  Widget build(BuildContext context) {
    final inGame =
        [AppPage.play, AppPage.review].contains(app.page) ||
        app.page == AppPage.training && trainingBoard;
    return Shortcuts(
      shortcuts: const {
        SingleActivator(LogicalKeyboardKey.arrowLeft): _NavigateIntent(-1),
        SingleActivator(LogicalKeyboardKey.arrowRight): _NavigateIntent(1),
        SingleActivator(LogicalKeyboardKey.escape): _HomeIntent(),
      },
      child: Actions(
        actions: {
          _NavigateIntent: CallbackAction<_NavigateIntent>(
            onInvoke: (intent) {
              if (app.inReview) app.stepReview(intent.direction);
              return null;
            },
          ),
          _HomeIntent: CallbackAction<_HomeIntent>(
            onInvoke: (_) {
              _guard(() => app.showPage(AppPage.home));
              return null;
            },
          ),
        },
        child: Focus(
          autofocus: true,
          child: Scaffold(
            backgroundColor: Theme.of(context).scaffoldBackgroundColor,
            body: SafeArea(
              bottom: false,
              child: Column(
                children: [
                  _chromeBar(inGame: inGame),
                  Expanded(child: _pageBody()),
                  if (inGame)
                    _gameToolbar()
                  else if (app.page != AppPage.settings && app.page != AppPage.appearance)
                    _homeToolbar(),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }

  Widget _pageBody() {
    if (!app.loaded) {
      return const Center(child: CircularProgressIndicator(strokeWidth: 2));
    }
    if (!app.storageReady) {
      return _content([
        _heading('本地数据需要重新读取', app.error),
        const Text('读取成功后即可继续。原版本的数据仍保存在设备中。'),
        const SizedBox(height: 20),
        FilledButton.icon(
          onPressed: () => _guard(app.load),
          icon: const Icon(Icons.refresh),
          label: const Text('重新读取并迁移'),
        ),
      ]);
    }
    return Column(
      children: [
        if (app.error != null) _errorStrip(),
        Expanded(
          child: switch (app.page) {
            AppPage.home => _home(),
            AppPage.play || AppPage.review => _gameLayout(),
            AppPage.training => trainingBoard
                ? _gameLayout(training: true)
                : _training(),
            AppPage.history => _history(),
            AppPage.statistics => _statistics(),
            AppPage.data => _data(),
            AppPage.appearance => _appearance(),
            AppPage.settings => _settings(),
          },
        ),
      ],
    );
  }

  Widget _errorStrip() => Container(
    width: double.infinity,
    margin: const EdgeInsets.fromLTRB(12, 8, 12, 0),
    padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
    decoration: BoxDecoration(
      color: Colors.orange.withValues(alpha: .12),
      border: Border.all(color: Colors.orange.withValues(alpha: .35)),
      borderRadius: BorderRadius.circular(8),
    ),
    child: Row(
      children: [
        const Icon(Icons.info_outline, color: Colors.orange, size: 18),
        const SizedBox(width: 8),
        Expanded(child: Text(app.error!, maxLines: 2, overflow: TextOverflow.ellipsis)),
        TextButton(onPressed: app.clearError, child: const Text('收起')),
        TextButton(onPressed: () => _guard(app.warmup), child: const Text('重试')),
      ],
    ),
  );

  Widget _chromeBar({required bool inGame}) {
    final settings = app.page == AppPage.settings;
    final appearance = app.page == AppPage.appearance;
    final training = app.page == AppPage.training && trainingBoard;
    final title = app.inReview
        ? '复盘'
        : training
        ? '谜题训练'
        : settings
        ? '设置'
        : appearance
        ? '棋盘、棋子与音效'
        : app.page == AppPage.home
        ? 'Maia Coach'
        : switch (app.page) {
            AppPage.training => '训练中心',
            AppPage.history => '历史与统计',
            AppPage.statistics => '我的分数',
            AppPage.data => '资料',
            _ => '对弈',
          };
    return Container(
      height: 52,
      color: Theme.of(context).brightness == Brightness.dark
          ? chromeBackground
          : Theme.of(context).scaffoldBackgroundColor,
      padding: const EdgeInsets.symmetric(horizontal: 8),
      child: Row(
        children: [
          if (inGame || settings || appearance || app.page != AppPage.home)
            _chromeIcon(Icons.chevron_left, '返回', () => _guard(() async {
              trainingBoard = false;
              await app.showPage(AppPage.home);
            }))
          else
            _brandMark(),
          if (inGame)
            Expanded(
              child: Row(
                mainAxisAlignment: MainAxisAlignment.center,
                children: [
                  _gameTab('对弈', !app.inReview, () {
                    if (app.inReview) _guard(() => app.showPage(AppPage.play));
                  }),
                  _gameTab('复盘', app.inReview, () {
                    if (!app.inReview && app.ended) _guard(() => app.reviewGame());
                  }),
                ],
              ),
            )
          else
            Expanded(child: Text(title, style: const TextStyle(fontSize: 19, fontWeight: FontWeight.w800))),
          if (inGame && !training)
            _chromeIcon(Icons.swap_vert, '翻转棋盘', () {
              app.flipped = !app.flipped;
              app.refresh();
            }),
          if (inGame && !training)
            _chromeIcon(Icons.dark_mode_outlined, '切换主题', _toggleTheme)
          else if (app.page == AppPage.home) ...[
            _chromeIcon(Icons.download_outlined, '引擎管理', () => _guard(app.warmup)),
            _chromeIcon(Icons.settings_outlined, '设置', () => _guard(() => app.showPage(AppPage.settings))),
            _chromeIcon(Icons.dashboard_customize_outlined, '棋盘、棋子与音效', () => _guard(() => app.showPage(AppPage.appearance))),
            _chromeIcon(Icons.dark_mode_outlined, '切换主题', _toggleTheme),
          ]
          else if (!settings && !appearance)
            _chromeIcon(Icons.tune, '设置', () => _guard(() => app.showPage(AppPage.settings)))
          else
            _chromeIcon(Icons.brightness_6_outlined, '切换主题', _toggleTheme),
        ],
      ),
    );
  }

  Widget _brandMark() => Container(
    width: 32,
    height: 32,
    alignment: Alignment.center,
    decoration: BoxDecoration(color: accent, borderRadius: BorderRadius.circular(8)),
    child: const Icon(Icons.auto_awesome, color: Colors.white, size: 20),
  );

  Widget _chromeIcon(IconData icon, String tooltip, VoidCallback onPressed) =>
      IconButton(
        tooltip: tooltip,
        onPressed: onPressed,
        icon: Icon(icon, size: 22),
        color: chromeText2,
        padding: EdgeInsets.zero,
        constraints: const BoxConstraints.tightFor(width: 40, height: 40),
      );

  Widget _gameTab(String text, bool active, VoidCallback onPressed) => TextButton(
    onPressed: onPressed,
    style: TextButton.styleFrom(
      minimumSize: const Size(66, 38),
      padding: const EdgeInsets.symmetric(horizontal: 14),
      foregroundColor: active ? accent : chromeText2,
      backgroundColor: active ? const Color(0xff102008) : Colors.transparent,
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
    ),
    child: Text(text, style: const TextStyle(fontWeight: FontWeight.w800)),
  );

  Widget _homeToolbar() => SafeArea(
    top: false,
    child: Container(
      height: 66,
      color: chromeBackground,
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
      child: Row(
        children: [
          _homeNav('对弈', Icons.star_border_rounded, 0),
          _homeNav('训练', Icons.chat_bubble_outline, 1),
          _homeNav('资料', Icons.description_outlined, 2),
        ],
      ),
    ),
  );

  Widget _homeNav(String label, IconData icon, int index) {
    final active = _navIndex == index;
    return Expanded(
      child: InkWell(
        onTap: () => _navigate(index),
        borderRadius: BorderRadius.circular(10),
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            Icon(icon, size: 21, color: active ? accent : chromeMuted),
            const SizedBox(height: 2),
            Text(label, style: TextStyle(fontSize: 11, color: active ? accent : chromeMuted)),
          ],
        ),
      ),
    );
  }

  Widget _gameToolbar() => SafeArea(
    top: false,
    child: Container(
      height: 62,
      color: chromeBackground,
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
      child: Row(
        children: [
          _toolButton(Icons.menu, '菜单', _gameMenu),
          _toolButton(Icons.chevron_left, '上一步', () => app.stepReview(-1), enabled: app.inReview && app.node?.parent != null),
          _toolButton(Icons.lightbulb_outline, '提示', () => _practiceAction(app.hint), enabled: !app.hinting && app.playable),
          _toolButton(Icons.undo, '悔棋', () => _practiceAction(app.undo), enabled: app.node?.parent != null && app.playable),
          _toolButton(Icons.visibility_outlined, '辅助', _aidsDialog, enabled: !app.inReview),
          _toolButton(Icons.chevron_right, '下一步', () => app.stepReview(1), enabled: app.inReview),
        ],
      ),
    ),
  );

  Widget _toolButton(IconData icon, String label, VoidCallback onPressed, {bool enabled = true}) => Expanded(
    child: IconButton(
      onPressed: enabled ? onPressed : null,
      tooltip: label,
      icon: Icon(icon, size: 23),
      color: chromeText2,
      padding: EdgeInsets.zero,
    ),
  );

  Future<void> _toggleTheme() async {
    await app.updateSetting('theme', app.settings.theme == 'dark' ? 'light' : 'dark');
  }

  int get _navIndex => switch (app.page) {
    AppPage.training => 1,
    AppPage.data || AppPage.history || AppPage.statistics => 2,
    _ => 0,
  };
  void _navigate(int i) => _guard(() async {
    trainingBoard = false;
    await app.showPage([AppPage.home, AppPage.training, AppPage.data][i]);
  });

  Widget _pill(String text, {bool small = false, Color? color}) => Container(
    padding: EdgeInsets.symmetric(
      horizontal: small ? 7 : 10,
      vertical: small ? 3 : 5,
    ),
    decoration: BoxDecoration(
      color: (color ?? accent).withValues(alpha: 0.12),
      borderRadius: BorderRadius.circular(7),
    ),
    child: Text(
      text,
      style: TextStyle(
        fontSize: small ? 9 : 11,
        letterSpacing: small ? 1.1 : 0,
        fontWeight: FontWeight.w700,
        color: color ?? Theme.of(context).colorScheme.primary,
      ),
    ),
  );

  Widget _content(List<Widget> children, {double width = 820}) => Align(
    alignment: Alignment.topCenter,
    child: SingleChildScrollView(
      padding: const EdgeInsets.fromLTRB(20, 16, 20, 32),
      child: ConstrainedBox(
        constraints: BoxConstraints(maxWidth: width),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: children,
        ),
      ),
    ),
  );
  Widget _heading(String title, [String? subtitle]) => Padding(
    padding: const EdgeInsets.only(top: 8, bottom: 18),
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(
          title,
          style: Theme.of(context).textTheme.headlineSmall
              ?.copyWith(fontWeight: FontWeight.w700),
        ),
        if (subtitle != null) ...[
          const SizedBox(height: 8),
          Text(
            subtitle,
            style: TextStyle(
              color: Theme.of(context).colorScheme.onSurfaceVariant,
              height: 1.6,
            ),
          ),
        ],
      ],
    ),
  );
  Widget _card(Widget child) => Card(
    child: Padding(padding: const EdgeInsets.all(20), child: child),
  );

  Widget _home() {
    final board = _boards[app.settings.boardTheme] as Map? ?? {};
    final custom = app.settings.boardTheme == 'custom';
    final light = _hex(custom ? app.settings['customLight'] as String? : board['light'] as String?, const Color(0xffebecd0));
    final dark = _hex(custom ? app.settings['customDark'] as String? : board['dark'] as String?, const Color(0xff739552));
    final texture = board['image'] == null ? null : 'assets/boards/${board['image']}';
    return LayoutBuilder(
      builder: (context, constraints) {
        final width = min(480.0, constraints.maxWidth);
        final boardSize = min(width - 64, constraints.maxHeight * .48);
        return SingleChildScrollView(
          padding: const EdgeInsets.fromLTRB(16, 14, 16, 10),
          child: Center(
            child: SizedBox(
              width: width,
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  SizedBox.square(
                    dimension: boardSize,
                    child: Center(
                      child: SizedBox.square(
                        dimension: boardSize,
                        child: ChessBoard(
                          fen: startFen,
                          orientation: 'w',
                          interactive: false,
                          coordinates: false,
                          pieceSet: app.settings.pieceSet,
                          lightColor: light,
                          darkColor: dark,
                          texture: texture,
                          onMove: (_) async {},
                        ),
                      ),
                    ),
                  ),
                  const SizedBox(height: 34),
                  Row(
                    crossAxisAlignment: CrossAxisAlignment.end,
                    children: [
                      const Expanded(child: Text('Maia', style: TextStyle(fontSize: 15, color: chromeText2))),
                      Text('${app.settings.elo}', style: const TextStyle(fontSize: 23, fontWeight: FontWeight.w800)),
                    ],
                  ),
                  Slider(
                    value: _levelIndex.toDouble(),
                    min: 0,
                    max: 11,
                    divisions: 11,
                    label: '${app.settings.elo}',
                    onChanged: (value) => _guard(() => app.updateSetting('elo', _levels[value.round()])),
                  ),
                  Padding(
                    padding: const EdgeInsets.symmetric(horizontal: 12),
                    child: Row(
                      mainAxisAlignment: MainAxisAlignment.spaceBetween,
                      children: [
                        for (var i = 0; i < 12; i++)
                          Container(width: 3, height: 12, color: i == _levelIndex ? accent : chromeMuted),
                      ],
                    ),
                  ),
                  const SizedBox(height: 13),
                  _colorChooser(),
                  const SizedBox(height: 12),
                  Row(
                    children: [
                      const Text('用时', style: TextStyle(color: accent, fontWeight: FontWeight.w700)),
                      const SizedBox(width: 22),
                      Expanded(child: _timeChooser()),
                    ],
                  ),
                  const SizedBox(height: 28),
                  _homeAction('开始对局', '固定难度，专注每一步', Icons.add, _newGame, primary: true),
                  const SizedBox(height: 12),
                  _homeAction(
                    '上一局',
                    app.game != null && !app.ended ? '继续对局' : '暂无',
                    Icons.play_arrow_outlined,
                    app.game != null && !app.ended ? () => _guard(app.resumeGame) : null,
                  ),
                ],
              ),
            ),
          ),
        );
      },
    );
  }

  Widget _colorChooser() => Container(
    height: 51,
    decoration: BoxDecoration(color: chromePanel, borderRadius: BorderRadius.circular(12), border: Border.all(color: chromePanel3)),
    padding: const EdgeInsets.all(4),
    child: Row(children: [
      _colorChoice('w', '○  执白'),
      _colorChoice('random', '⇄  随机'),
      _colorChoice('b', '●  执黑'),
    ]),
  );

  Widget _colorChoice(String value, String label) {
    final selected = app.settings.userColor == value;
    return Expanded(
      child: InkWell(
        onTap: () => _guard(() => app.updateSetting('color', value)),
        borderRadius: BorderRadius.circular(9),
        child: Container(
          alignment: Alignment.center,
          decoration: BoxDecoration(color: selected ? const Color(0xff102008) : Colors.transparent, borderRadius: BorderRadius.circular(9)),
          child: Text(label, style: TextStyle(color: selected ? accent : chromeText2, fontWeight: FontWeight.w700, fontSize: 13)),
        ),
      ),
    );
  }

  Widget _timeChooser() => Container(
    height: 38,
    padding: const EdgeInsets.symmetric(horizontal: 12),
    decoration: BoxDecoration(color: chromePanel, borderRadius: BorderRadius.circular(9)),
    child: DropdownButtonHideUnderline(
      child: DropdownButton<String>(
        isExpanded: true,
        value: app.settings.timeControl,
        dropdownColor: chromePanel,
        icon: const Icon(Icons.keyboard_arrow_down, color: chromeText2),
        items: _timeLabels.entries.map((e) => DropdownMenuItem(value: e.key, child: Text(e.value, style: const TextStyle(fontWeight: FontWeight.w700)))).toList(),
        onChanged: (v) { if (v != null) _guard(() => app.updateSetting('timeControl', v)); },
      ),
    ),
  );

  Widget _homeAction(String title, String subtitle, IconData icon, VoidCallback? onTap, {bool primary = false}) =>
      Material(
        color: primary ? const Color(0xff101e08) : chromePanel,
        borderRadius: BorderRadius.circular(12),
        child: InkWell(
          onTap: onTap,
          borderRadius: BorderRadius.circular(12),
          child: Container(
            height: 56,
            padding: const EdgeInsets.symmetric(horizontal: 16),
            decoration: BoxDecoration(borderRadius: BorderRadius.circular(12), border: Border.all(color: primary ? accent : chromePanel3)),
            child: Row(children: [
              Icon(icon, color: onTap == null ? chromeMuted : (primary ? accent : chromeText2), size: 21),
              const SizedBox(width: 14),
              Expanded(child: Column(mainAxisAlignment: MainAxisAlignment.center, crossAxisAlignment: CrossAxisAlignment.start, children: [Text(title, style: TextStyle(color: onTap == null ? chromeMuted : (primary ? accent : chromeText2), fontWeight: FontWeight.w800)), Text(subtitle, style: TextStyle(color: onTap == null ? chromeMuted : chromeText2, fontSize: 11))])),
              Text(primary ? '↗' : '→', style: TextStyle(color: onTap == null ? chromeMuted : (primary ? accent : chromeText2), fontSize: 21)),
            ]),
          ),
        ),
      );

  static const _levels = [
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
  int get _levelIndex => max(0, _levels.indexOf(app.settings.elo));
  static const _timeLabels = {
    'none': '不限时',
    '3+2': '3+2 快棋',
    '5+3': '5+3 快棋',
    '10+5': '10+5 快棋',
    '15+10': '15+10 慢棋',
    '30+20': '30+20 慢棋',
  };

  Widget _entry(
    String title,
    String subtitle,
    IconData icon,
    VoidCallback onTap, {
    bool primary = false,
  }) {
    final scheme = Theme.of(context).colorScheme;
    return Material(
      color: primary
          ? scheme.primaryContainer.withValues(alpha: 0.55)
          : scheme.surface,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(14),
        side: BorderSide(
          color: primary
              ? scheme.primary.withValues(alpha: 0.5)
              : scheme.outlineVariant.withValues(alpha: 0.6),
        ),
      ),
      child: InkWell(
        borderRadius: BorderRadius.circular(14),
        onTap: onTap,
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 18, vertical: 15),
          child: Row(
            children: [
              Icon(
                icon,
                color: primary ? scheme.primary : scheme.onSurfaceVariant,
                size: 26,
              ),
              const SizedBox(width: 15),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      title,
                      style: const TextStyle(
                        fontWeight: FontWeight.w600,
                        fontSize: 15,
                      ),
                    ),
                    const SizedBox(height: 4),
                    Text(
                      subtitle,
                      style: TextStyle(
                        fontSize: 11,
                        color: scheme.onSurfaceVariant,
                      ),
                    ),
                  ],
                ),
              ),
              const Icon(Icons.arrow_forward_rounded, size: 18),
            ],
          ),
        ),
      ),
    );
  }

  void _newGame() => _guard(() async {
    if (app.game != null &&
        !app.ended &&
        !await _confirm('开始新对局？', '当前对局自己走满 3 步后，中途离开会按认输结算。')) {
      return;
    }
    await app.startGame();
  });

  Widget _gameLayout({bool training = false}) => LayoutBuilder(
    builder: (context, constraints) {
      final wide = constraints.maxWidth >= 900;
      final side =
          min(
            wide ? constraints.maxWidth * 0.58 : constraints.maxWidth - 24,
            max(
              120.0,
              constraints.maxHeight -
                  (training
                      ? 190
                      : app.inReview
                      ? 195
                      : 220),
            ),
          ) *
          ((app.settings[app.inReview ? 'boardSizeReview' : 'boardSizePlay']
                      as num? ??
                  100) /
              100);
      final boardColumn = Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          if (!training) _player(opposite(app.orientation), top: true),
          if (!training && !wide) const SizedBox(height: 58),
          if (!training)
            SizedBox(
              height: 22,
              child: Align(
                alignment: Alignment.centerLeft,
                child: Text(
                  app.opening ?? '开局',
                  style: const TextStyle(color: chromeMuted, fontSize: 13),
                ),
              ),
            ),
          if (!training &&
              (app.settings['aidEval'] == true ||
                  app.settings['aidWinPct'] == true ||
                  app.inReview))
            _evaluation(),
          RepaintBoundary(
            child: SizedBox.square(dimension: side, child: _board(training)),
          ),
          if (!training && !wide) const SizedBox(height: 4),
          if (training)
            SizedBox(
              height: 24,
              child: Center(
                child: Text(puzzleTitle, style: const TextStyle(color: chromeMuted, fontSize: 11)),
              ),
            ),
          if (!training && app.node != null)
            SizedBox(
              height: 32,
              child: SingleChildScrollView(
                scrollDirection: Axis.horizontal,
                child: Row(
                  children: app.tree!
                      .mainline()
                      .where((n) => n.parent != null)
                      .map(
                        (n) => Padding(
                          padding: const EdgeInsets.symmetric(horizontal: 2),
                          child: TextButton(
                            onPressed: app.inReview ? () => app.goTo(n) : null,
                            style: TextButton.styleFrom(
                              minimumSize: const Size(26, 28),
                              padding: const EdgeInsets.symmetric(
                                horizontal: 7,
                              ),
                              backgroundColor: n == app.node
                                  ? accent.withValues(alpha: 0.17)
                                  : null,
                            ),
                            child: Text(
                              '${n.ply.isOdd ? '${(n.ply + 1) ~/ 2}. ' : ''}${n.san}',
                              style: TextStyle(
                                fontSize: 12,
                                color: n == app.node ? accent : null,
                              ),
                            ),
                          ),
                        ),
                      )
                      .toList(),
                ),
              ),
            ),
        ],
      );
      if (wide) {
        return SafeArea(
          top: false,
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Expanded(
                flex: 6,
                child: Center(
                  child: SingleChildScrollView(
                    child: Padding(
                      padding: const EdgeInsets.all(12),
                      child: boardColumn,
                    ),
                  ),
                ),
              ),
              Expanded(
                flex: 4,
                child: Padding(
                  padding: const EdgeInsets.fromLTRB(12, 8, 20, 12),
                  child: training
                      ? _trainingPanel()
                      : app.inReview
                      ? _reviewPanel()
                      : _playPanel(),
                ),
              ),
            ],
          ),
        );
      }
      return SafeArea(
        top: false,
        child: Column(
          children: [
            Center(child: boardColumn),
            Expanded(
              child: Padding(
                padding: const EdgeInsets.fromLTRB(0, 4, 0, 4),
                child: training
                    ? _trainingPanel()
                    : app.inReview
                    ? _reviewPanel()
                    : _playPanel(),
              ),
            ),
          ],
        ),
      );
    },
  );

  String get puzzleTitle => app.trainingMistake != null
      ? '错题重练'
      : '谜题 ${app.puzzle?.id ?? ''} · ${app.puzzle?.rating ?? ''}';

  Widget _board(bool training) {
    final board = _boards[app.settings.boardTheme] as Map? ?? {};
    final custom = app.settings.boardTheme == 'custom';
    final arrows = <BoardArrow>[];
    final hint = app.hintUci;
    if (hint != null) arrows.add(BoardArrow(hint, const Color(0xff67bf63)));
    if (!training) {
      for (final threat in app.threats) {
        arrows.add(BoardArrow(threat, const Color(0xffdb5e54)));
      }
    }
    if (app.inReview && app.analysis?.bestmove != null) {
      arrows.add(BoardArrow(app.analysis!.bestmove!, const Color(0xff67bf63)));
      final human = app.humanPrediction?.moves.firstOrNull;
      if (human != null) {
        arrows.add(BoardArrow(human.uci, const Color(0xff5fa9dd)));
      }
    }
    final last = app.node?.uci;
    return ChessBoard(
      fen: app.fen,
      orientation: training ? app.trainingOrientation : app.orientation,
      playerColor: training
          ? app.trainingOrientation
          : app.inReview
          ? null
          : app.userColor,
      interactive: training
          ? !app.trainingBusy && !app.puzzleComplete
          : app.inReview || app.playable,
      onMove: (uci) => _guard(() => app.playMove(uci)),
      lastMove: training ? null : last,
      arrows: arrows,
      hanging: training ? const [] : app.hanging,
      lightColor: _hex(
        custom
            ? app.settings['customLight'] as String?
            : board['light'] as String?,
        const Color(0xffebecd0),
      ),
      darkColor: _hex(
        custom
            ? app.settings['customDark'] as String?
            : board['dark'] as String?,
        const Color(0xff739552),
      ),
      texture: board['image'] == null
          ? null
          : 'assets/boards/${board['image']}',
      pieceSet: app.settings.pieceSet,
      animate: app.settings.boardFx,
      haptics: app.settings.haptics,
      arrowOutline: app.settings['aidArrowOutline'] == true,
      premove:
          !training && !app.inReview && app.settings.premove && app.thinking,
      onPremove: app.queuePremove,
    );
  }

  Widget _player(String color, {required bool top}) {
    final mine = color == app.userColor;
    final scheme = Theme.of(context).colorScheme;
    if (app.settings.timeControl == 'none') {
      return SizedBox(
        height: 42,
        child: Align(
          alignment: Alignment.centerLeft,
          child: Text(
            mine ? '我 ${app.game?['playerElo'] ?? app.settings.playerElo}' : 'Maia ${app.game?['elo'] ?? app.settings.elo}',
            style: const TextStyle(color: chromeText2, fontSize: 14, fontWeight: FontWeight.w700),
          ),
        ),
      );
    }
    final avatar = app.settings['avatar'] as String? ?? '';
    final glyph = avatar.contains('|') ? avatar.split('|').first : '♙';
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 7, horizontal: 4),
      child: Row(
        children: [
          ClipRRect(
            borderRadius: BorderRadius.circular(9),
            child: mine
                ? Container(
                    width: 34,
                    height: 34,
                    alignment: Alignment.center,
                    color: avatar.contains('|')
                        ? _hex(
                            avatar.split('|').last,
                            scheme.surfaceContainerHighest,
                          )
                        : scheme.surfaceContainerHighest,
                    child: Text(glyph, style: const TextStyle(fontSize: 23)),
                  )
                : SvgPicture.asset(
                    'assets/portraits/coach-0.svg',
                    width: 34,
                    height: 34,
                  ),
          ),
          const SizedBox(width: 9),
          Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                mine ? '我' : '莉亚 · Maia',
                style: const TextStyle(
                  fontWeight: FontWeight.w600,
                  fontSize: 12,
                ),
              ),
              Text(
                '${mine ? (app.game?['playerElo'] ?? app.settings.playerElo) : (app.game?['elo'] ?? app.settings.elo)} · ${color == 'w' ? '执白' : '执黑'}',
                style: TextStyle(fontSize: 10, color: scheme.onSurfaceVariant),
              ),
            ],
          ),
          const Spacer(),
          if (mine && !app.inReview && !app.ended)
            IconButton(
              onPressed: _aidsDialog,
              tooltip: '对局辅助',
              visualDensity: VisualDensity.compact,
              icon: const Icon(Icons.visibility_outlined, size: 19),
            ),
          ValueListenableBuilder<int>(
            valueListenable: app.clockTicks,
            builder: (context, _, _) {
              final remaining = app.timeFor(color);
              return Container(
                padding: const EdgeInsets.symmetric(
                  horizontal: 10,
                  vertical: 7,
                ),
                decoration: BoxDecoration(
                  borderRadius: BorderRadius.circular(8),
                  color: app.clock?.active == color
                      ? scheme.primaryContainer
                      : scheme.surfaceContainerHighest,
                ),
                child: Text(
                  remaining == null ? '∞' : formatClock(remaining),
                  style: TextStyle(
                    fontSize: remaining == null ? 20 : 17,
                    fontWeight: FontWeight.w600,
                    fontFeatures: const [FontFeature.tabularFigures()],
                    color: remaining != null && remaining < 10000
                        ? Colors.orange
                        : null,
                  ),
                ),
              );
            },
          ),
        ],
      ),
    );
  }

  Widget _evaluation() {
    final line = app.analysis?.lines.firstOrNull;
    final white = line?.whiteWin(turnOf(app.fen)) ?? 50;
    final mine = app.userColor == 'w' ? white : 100 - white;
    final label = app.inReview || app.settings['aidEval'] == true
        ? line?.display(turnOf(app.fen)) ?? '—'
        : '';
    final chances = !app.inReview && app.settings['aidWinPct'] == true
        ? '  我的获胜机会 ${line == null ? '—' : '${mine.toStringAsFixed(1)}%'}'
        : '';
    return SizedBox(
      height: 20,
      child: Stack(
        alignment: Alignment.center,
        children: [
          Row(
            children: [
              Expanded(
                flex: max(1, white.round()),
                child: Container(color: const Color(0xffe9ece6)),
              ),
              Expanded(
                flex: max(1, 100 - white.round()),
                child: Container(color: const Color(0xff373b38)),
              ),
            ],
          ),
          Text(
            '$label$chances',
            style: TextStyle(
              fontSize: 11,
              fontWeight: FontWeight.w700,
              color: white > 50 ? const Color(0xff272b27) : Colors.white,
            ),
          ),
        ],
      ),
    );
  }

  Widget _playPanel() => SingleChildScrollView(
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Text(
          app.progressLabel,
          style: const TextStyle(fontSize: 14, fontWeight: FontWeight.w600),
        ),
        if (app.notice != null) ...[
          const SizedBox(height: 8),
          Text(
            app.notice!,
            style: TextStyle(
              fontSize: 12,
              color: Theme.of(context).colorScheme.onSurfaceVariant,
            ),
          ),
        ],
        if (app.settings['opponentTalk'] == true &&
            app.coachMessage != null) ...[
          const SizedBox(height: 10),
          Text(
            '莉亚：${app.coachMessage}',
            style: const TextStyle(fontSize: 12, height: 1.6, color: accent),
          ),
        ],
        if (app.assisted)
          Padding(
            padding: const EdgeInsets.only(top: 8),
            child: Align(
              alignment: Alignment.centerLeft,
              child: _pill('辅助练习 · 不计分'),
            ),
          ),
        const SizedBox(height: 14),
        if (app.ended) ...[
          if (app.game?['rating'] is Map)
            Text(
              '玩家棋力 ${app.game!['rating']['playerBefore']} → ${app.game!['rating']['playerAfter']}',
              style: const TextStyle(color: accent),
            ),
          const SizedBox(height: 10),
          FilledButton.icon(
            onPressed: () => _guard(() => app.reviewGame()),
            icon: const Icon(Icons.analytics_outlined),
            label: const Text('开始复盘'),
          ),
          const SizedBox(height: 10),
          OutlinedButton(onPressed: _newGame, child: const Text('再来一局')),
        ] else
          Row(
            children: [
              Expanded(
                child: OutlinedButton.icon(
                  onPressed: app.hinting || !app.engines.stockfishReady
                      ? null
                      : () => _practiceAction(app.hint),
                  icon: app.hinting
                      ? const SizedBox.square(
                          dimension: 15,
                          child: CircularProgressIndicator(strokeWidth: 2),
                        )
                      : const Icon(Icons.lightbulb_outline, size: 18),
                  label: const Text('提示'),
                ),
              ),
              const SizedBox(width: 8),
              Expanded(
                child: OutlinedButton.icon(
                  onPressed: app.node?.parent == null
                      ? null
                      : () => _practiceAction(app.undo),
                  icon: const Icon(Icons.undo, size: 18),
                  label: const Text('悔棋'),
                ),
              ),
              const SizedBox(width: 8),
              IconButton(
                tooltip: '认输',
                onPressed: _resign,
                icon: const Icon(Icons.flag_outlined),
              ),
            ],
          ),
      ],
    ),
  );

  Future<void> _practiceAction(Future<void> Function() action) =>
      _guard(() async {
        if (!app.assisted &&
            !await _confirm('转为辅助练习？', '使用提示或悔棋后，本局将不更新玩家等级分。')) {
          return;
        }
        await action();
      });

  Widget _reviewPanel() {
    final current = app.reviews[app.node?.id];
    final played = app.tree!.mainline().where((n) => n.parent != null).toList();
    final scores = <double>[
      50,
      ...played.map(
        (n) =>
            app.reviews[n.id]?.after.lines.firstOrNull?.whiteWin(
              turnOf(n.fen),
            ) ??
            50,
      ),
    ];
    return SingleChildScrollView(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          if (app.analysing) ...[
            LinearProgressIndicator(value: app.reviewProgress, minHeight: 3),
            const SizedBox(height: 10),
          ],
          Row(
            children: [
              Expanded(
                child: SegmentedButton<String>(
                  showSelectedIcon: false,
                  segments: const [
                    ButtonSegment(value: 'all', label: Text('全部')),
                    ButtonSegment(value: 'mine', label: Text('我方')),
                    ButtonSegment(value: 'theirs', label: Text('对方')),
                  ],
                  selected: {app.reviewFilter},
                  onSelectionChanged: (v) {
                    app.reviewFilter = v.first;
                    app.refresh();
                  },
                ),
              ),
            ],
          ),
          const SizedBox(height: 8),
          Row(
            mainAxisAlignment: MainAxisAlignment.spaceBetween,
            children: [
              IconButton(
                tooltip: '回到开局',
                onPressed: () => app.goTo(app.tree!.root),
                icon: const Icon(Icons.first_page),
              ),
              IconButton(
                tooltip: '上一步',
                onPressed: () => app.stepReview(-1),
                icon: const Icon(Icons.chevron_left),
              ),
              Text(
                '${app.node?.ply ?? 0} / ${played.length}',
                style: const TextStyle(fontSize: 12),
              ),
              IconButton(
                tooltip: '下一步',
                onPressed: () => app.stepReview(1),
                icon: const Icon(Icons.chevron_right),
              ),
              IconButton(
                tooltip: '最后一步',
                onPressed: () => app.goTo(app.tree!.mainline().last),
                icon: const Icon(Icons.last_page),
              ),
            ],
          ),
          SizedBox(
            height: 80,
            child: LineChart(
              values: scores,
              center: 50,
              selected: app.node?.ply,
              onSelect: (i) {
                final line = app.tree!.mainline();
                if (i < line.length) app.goTo(line[i]);
              },
            ),
          ),
          const SizedBox(height: 12),
          Wrap(
            spacing: 8,
            runSpacing: 8,
            children: [
              _pill(
                '我方准确率 ${app.accuracyFor(app.userColor)?.toStringAsFixed(1) ?? '—'}%',
              ),
              _pill(
                '对方准确率 ${app.accuracyFor(opposite(app.userColor))?.toStringAsFixed(1) ?? '—'}%',
              ),
            ],
          ),
          if (app.learningSummary.isNotEmpty) ...[
            const SizedBox(height: 12),
            const Text(
              '本局学习重点',
              style: TextStyle(fontWeight: FontWeight.w600, fontSize: 12),
            ),
            for (final item in app.learningSummary)
              Padding(
                padding: const EdgeInsets.only(top: 5),
                child: Text(item, style: const TextStyle(fontSize: 12)),
              ),
            TextButton(
              onPressed: () => _navigate(1),
              child: const Text('去错题本重练'),
            ),
          ],
          const SizedBox(height: 12),
          if (current != null) ...[
            Row(
              children: [
                _pill(
                  _judgeLabels[current.judgement] ?? current.judgement,
                  color: current.drop >= 10 ? Colors.orange : accent,
                ),
                const Spacer(),
                Text(
                  '准确率 ${current.accuracy.toStringAsFixed(1)}%',
                  style: const TextStyle(fontSize: 12),
                ),
              ],
            ),
            const SizedBox(height: 8),
            Text(
              current.explanation.text.isEmpty
                  ? '这步保持了局面，继续检查对方的直接威胁。'
                  : current.explanation.text,
              style: const TextStyle(fontSize: 12, height: 1.7),
            ),
            if (current.best.isNotEmpty && app.node!.parent != null)
              TextButton.icon(
                onPressed: () => app.goTo(app.node!.parent!),
                icon: const Icon(Icons.replay, size: 17),
                label: const Text('重走这一步'),
              ),
          ],
          const SizedBox(height: 12),
          const Text(
            'Stockfish 分析',
            style: TextStyle(fontSize: 12, fontWeight: FontWeight.w700),
          ),
          const SizedBox(height: 5),
          if (app.analysis?.lines.isEmpty ?? true)
            const Padding(
              padding: EdgeInsets.all(12),
              child: Text('正在分析当前局面…', style: TextStyle(fontSize: 12)),
            ),
          ...?app.analysis?.lines.map(
            (line) => Padding(
              padding: const EdgeInsets.symmetric(vertical: 6),
              child: Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  SizedBox(
                    width: 52,
                    child: Text(
                      line.display(turnOf(app.fen)),
                      style: const TextStyle(
                        color: accent,
                        fontWeight: FontWeight.w600,
                      ),
                    ),
                  ),
                  Expanded(
                    child: Text(
                      _pvSan(app.fen, line.pv),
                      style: const TextStyle(fontSize: 12, height: 1.6),
                    ),
                  ),
                  Text(
                    'D${line.depth}',
                    style: TextStyle(
                      color: Theme.of(context).colorScheme.onSurfaceVariant,
                      fontSize: 10,
                    ),
                  ),
                  IconButton(
                    tooltip: '演示这条变化',
                    visualDensity: VisualDensity.compact,
                    icon: const Icon(Icons.play_arrow, size: 18),
                    onPressed: app.reviewPlaying
                        ? null
                        : () => _guard(() => app.playVariation(line.pv)),
                  ),
                ],
              ),
            ),
          ),
          const SizedBox(height: 8),
          OutlinedButton.icon(
            onPressed: _compareDialog,
            icon: const Icon(Icons.people_outline, size: 18),
            label: const Text('比较不同水平的棋手'),
          ),
          TextButton(
            onPressed: () => _guard(
              () => app.comparePlayers(
                app.settings.playerElo,
                app.settings.playerElo,
              ),
            ),
            child: const Text('显示当前水平的人类常走着法'),
          ),
          if (app.node?.children.length case final int count
              when count > 1) ...[
            const SizedBox(height: 12),
            const Text('变着', style: TextStyle(fontSize: 12)),
            Wrap(
              spacing: 8,
              children: app.node!.children
                  .map(
                    (child) => ActionChip(
                      label: Text(child.san),
                      onPressed: () => app.goTo(child),
                    ),
                  )
                  .toList(),
            ),
          ],
          const SizedBox(height: 8),
          TextButton(
            onPressed: () => _guard(() => app.startGame(fromFen: app.fen)),
            child: const Text('从当前局面与 Maia 对弈'),
          ),
        ],
      ),
    );
  }

  static const _judgeLabels = {
    'brilliant': '妙着',
    'great': '关键一着',
    'book': '开局库',
    'forced': '唯一着法',
    'best': '最佳',
    'good': '好棋',
    'inaccuracy': '不精确',
    'mistake': '错误',
    'blunder': '漏着',
    'miss': '错失良机',
  };
  String _pvSan(String fen, List<String> moves) {
    final board = position(fen);
    final sans = <String>[];
    for (final uci in moves.take(8)) {
      final move = legalMoves(board.fen).where((m) => m.uci == uci).firstOrNull;
      if (move == null) break;
      sans.add(move.san);
      board.move({
        'from': move.from,
        'to': move.to,
        if (move.promotion != null) 'promotion': move.promotion,
      });
    }
    return sans.join(' ');
  }

  Widget _training() {
    final progress = app.repository.puzzles;
    final mistakes = app.repository.mistakes
        .where((m) => m['mastered'] != true)
        .toList();
    return _content([
      _heading('把经验，变成直觉。', '从实战错题和精选战术开始，建立你的棋盘观察力。'),
      _card(
        Row(
          children: [
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  const Text('谜题等级分', style: TextStyle(fontSize: 12)),
                  const SizedBox(height: 8),
                  Text(
                    '${(progress['rating'] as num? ?? 1200).round()}',
                    style: const TextStyle(
                      fontSize: 34,
                      fontWeight: FontWeight.w600,
                    ),
                  ),
                  const SizedBox(height: 4),
                  Text(
                    '${progress['solved'] ?? 0} 题解答正确 · ${progress['games'] ?? 0} 题已练习',
                    style: const TextStyle(fontSize: 11),
                  ),
                ],
              ),
            ),
            const Icon(Icons.extension_outlined, color: accent, size: 40),
          ],
        ),
      ),
      const SizedBox(height: 18),
      const Text('为你推荐', style: TextStyle(fontWeight: FontWeight.w600)),
      const SizedBox(height: 10),
      Wrap(
        spacing: 8,
        runSpacing: 8,
        children: app.recommendedThemes
            .map(
              (key) => ActionChip(
                avatar: const Icon(Icons.auto_awesome, size: 16),
                label: Text(themeLabels[key] ?? key),
                onPressed: () => _launchPuzzle(key),
              ),
            )
            .toList(),
      ),
      const SizedBox(height: 18),
      FilledButton.icon(
        onPressed: () => _launchPuzzle(),
        icon: const Icon(Icons.play_arrow_rounded),
        label: const Text('综合战术练习'),
      ),
      const SizedBox(height: 24),
      const Text('按题型练习', style: TextStyle(fontWeight: FontWeight.w600)),
      const SizedBox(height: 12),
      Wrap(
        spacing: 8,
        runSpacing: 8,
        children: _themeNames.entries
            .map(
              (entry) => ActionChip(
                avatar: const Icon(Icons.extension_outlined, size: 15),
                label: Text(entry.value),
                onPressed: () => _launchPuzzle(entry.key),
              ),
            )
            .toList(),
      ),
      const SizedBox(height: 28),
      Row(
        children: [
          const Text('我的错题本', style: TextStyle(fontWeight: FontWeight.w600)),
          const Spacer(),
          _pill('${mistakes.length} 道待掌握'),
        ],
      ),
      const SizedBox(height: 12),
      if (mistakes.isEmpty)
        _card(
          const Text(
            '复盘分析会自动收录你的错误。完成一局后进入复盘，就能在这里针对练习。',
            style: TextStyle(height: 1.7, fontSize: 13),
          ),
        ),
      ...mistakes
          .take(30)
          .map(
            (mistake) => Card(
              margin: const EdgeInsets.only(bottom: 8),
              child: ListTile(
                leading: const Icon(
                  Icons.bookmark_outline,
                  color: Colors.orange,
                ),
                title: Text(
                  '${mistake['playedSan']} · ${mistake['tagLabel'] ?? '战术检查'}',
                  style: const TextStyle(fontSize: 13),
                ),
                subtitle: Text(
                  '连续答对 ${mistake['streak'] ?? 0} 次 · 练习 ${mistake['tries'] ?? 0} 次',
                  style: const TextStyle(fontSize: 11),
                ),
                trailing: IconButton(
                  tooltip: '删除错题',
                  icon: const Icon(Icons.close, size: 17),
                  onPressed: () => _guard(() async {
                    app.repository.removeMistake(mistake['id'] as String);
                    await app.repository.save();
                    app.refresh();
                  }),
                ),
                onTap: () => _guard(() async {
                  setState(() => trainingBoard = true);
                  await app.practiceMistake(mistake);
                }),
              ),
            ),
          ),
    ]);
  }

  static const _themeNames = themeLabels;

  void _launchPuzzle([String? theme]) => _guard(() async {
    setState(() => trainingBoard = true);
    await app.startPuzzle(theme: theme);
  });

  Widget _trainingPanel() => SingleChildScrollView(
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Text(
          app.trainingMessage ?? '',
          style: const TextStyle(
            fontWeight: FontWeight.w600,
            fontSize: 13,
            height: 1.6,
          ),
        ),
        const SizedBox(height: 12),
        if (app.puzzle != null)
          Wrap(
            spacing: 5,
            runSpacing: 5,
            children: app.puzzle!.themes
                .where(_themeNames.containsKey)
                .map((t) => _pill(_themeNames[t]!))
                .toList(),
          ),
        const SizedBox(height: 14),
        if (app.puzzleComplete)
          FilledButton(
            onPressed: () => _launchPuzzle(app.puzzleTheme),
            child: const Text('下一道'),
          )
        else
          Row(
            children: [
              Expanded(
                child: OutlinedButton(
                  onPressed: () => _guard(app.revealTraining),
                  child: const Text('显示提示'),
                ),
              ),
              const SizedBox(width: 8),
              Expanded(
                child: OutlinedButton(
                  onPressed: () => _launchPuzzle(app.puzzleTheme),
                  child: const Text('换一道'),
                ),
              ),
            ],
          ),
        TextButton(
          onPressed: () {
            setState(() => trainingBoard = false);
            app.showPage(AppPage.training);
          },
          child: const Text('返回训练中心'),
        ),
      ],
    ),
  );

  Widget _history() {
    final history = app.repository.history;
    return _content([
      Row(
        children: [
          Expanded(
            child: _heading(
              '每一局，都值得回看。',
              '${history.length} 局保存在本机，最多保留 300 局。',
            ),
          ),
          IconButton(
            tooltip: '导出全部 PGN',
            icon: const Icon(Icons.ios_share_rounded),
            onPressed: history.isEmpty
                ? null
                : () => _guard(() async {
                    final texts = history
                        .map(
                          (g) => exportPgn(
                            GameTree.deserialize(
                              g['startFen'] as String,
                              Map<String, dynamic>.from(g['tree'] as Map),
                            ),
                            {'Result': g['result'] as String? ?? '*'},
                          ),
                        )
                        .join('\n');
                    await _share(
                      'maia-games.pgn',
                      texts,
                      'application/x-chess-pgn',
                    );
                  }),
          ),
        ],
      ),
      if (history.isEmpty) _card(const Text('完成一局后，会自动保存到这里。你也可以导入已有 PGN 棋谱。')),
      ...history.map(
        (g) => Card(
          margin: const EdgeInsets.only(bottom: 10),
          child: ListTile(
            contentPadding: const EdgeInsets.symmetric(
              horizontal: 18,
              vertical: 8,
            ),
            leading: Container(
              width: 38,
              height: 38,
              alignment: Alignment.center,
              decoration: BoxDecoration(
                borderRadius: BorderRadius.circular(10),
                color: accent.withValues(alpha: 0.12),
              ),
              child: Text(
                g['userColor'] == 'w' ? '♔' : '♚',
                style: const TextStyle(fontSize: 26),
              ),
            ),
            title: Text(
              g['imported'] == true ? '导入棋谱' : '我 vs Maia ${g['elo'] ?? ''}',
              style: const TextStyle(fontSize: 14, fontWeight: FontWeight.w600),
            ),
            subtitle: Text(
              '${_date(g['date'])} · ${g['result'] ?? '*'} · ${g['reason'] ?? ''}',
              style: const TextStyle(fontSize: 11),
            ),
            trailing: const Icon(Icons.chevron_right),
            onTap: () => _guard(() => app.reviewGame(g)),
          ),
        ),
      ),
    ]);
  }

  String _date(dynamic ms) {
    final d = DateTime.fromMillisecondsSinceEpoch((ms as num? ?? 0).toInt());
    return '${d.year}.${d.month.toString().padLeft(2, '0')}.${d.day.toString().padLeft(2, '0')}';
  }

  Widget _statistics() {
    final history = app.repository.history
        .where((g) => g['imported'] != true)
        .toList();
    int wins = 0, draws = 0, losses = 0;
    for (final g in history) {
      if (g['result'] == '1/2-1/2') {
        draws++;
      } else if (g['result'] == '1-0' || g['result'] == '0-1') {
        if ((g['result'] == '1-0') == (g['userColor'] == 'w')) {
          wins++;
        } else {
          losses++;
        }
      }
    }
    final total = wins + draws + losses;
    final points = history.reversed
        .where((g) => g['eloAfter'] is num)
        .map((g) => (g['eloAfter'] as num).toDouble())
        .toList();
    return _content([
      _heading('看见你的进步。', '这些数据仅来自本机对局，不代表任何平台或官方等级分。'),
      _card(
        Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const Text('玩家棋力', style: TextStyle(fontSize: 12)),
            const SizedBox(height: 10),
            Text(
              '${app.settings.playerElo}',
              style: const TextStyle(fontSize: 42, fontWeight: FontWeight.w600),
            ),
            const SizedBox(height: 18),
            SizedBox(
              height: 150,
              child: LineChart(
                values: points.isEmpty
                    ? [app.settings.playerElo.toDouble()]
                    : points,
              ),
            ),
          ],
        ),
      ),
      const SizedBox(height: 16),
      _card(
        Row(
          mainAxisAlignment: MainAxisAlignment.spaceAround,
          children: [
            _stat('胜', '$wins', accent),
            _stat('和', '$draws', Colors.amber),
            _stat('负', '$losses', Colors.orange),
            _stat(
              '得分率',
              total == 0
                  ? '—'
                  : '${((wins + draws * 0.5) / total * 100).round()}%',
              null,
            ),
          ],
        ),
      ),
      const SizedBox(height: 16),
      _card(
        Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const Text('训练概览', style: TextStyle(fontWeight: FontWeight.w600)),
            const SizedBox(height: 14),
            Text(
              '谜题 ${app.repository.puzzles['games'] ?? 0} 道 · 正确 ${app.repository.puzzles['solved'] ?? 0} 道',
            ),
            const SizedBox(height: 8),
            Text(
              '错题 ${app.repository.mistakes.length} 道 · 已掌握 ${app.repository.mistakes.where((m) => m['mastered'] == true).length} 道',
            ),
          ],
        ),
      ),
    ]);
  }

  Widget _stat(String label, String value, Color? color) => Column(
    children: [
      Text(
        value,
        style: TextStyle(
          fontSize: 24,
          fontWeight: FontWeight.w600,
          color: color,
        ),
      ),
      const SizedBox(height: 5),
      Text(label, style: const TextStyle(fontSize: 11)),
    ],
  );

  Widget _data() => _content([
    _heading('资料', '管理棋谱、备份与本地诊断数据。'),
    _entry('历史与统计', '查看已完成对局和玩家棋力走势', Icons.history, () => _guard(() => app.showPage(AppPage.history))),
    const SizedBox(height: 10),
    _entry('我的分数', '当前玩家棋力与胜负统计', Icons.insights_outlined, () => _guard(() => app.showPage(AppPage.statistics))),
    const SizedBox(height: 10),
    _entry('导入复盘', '打开 PGN 或 FEN 局面', Icons.file_open_outlined, _importDialog),
    const SizedBox(height: 10),
    _entry('导出全部备份', '设置、评级、棋谱、错题与训练进度', Icons.ios_share_rounded, () => _guard(() => _share('maia-coach-backup.json', app.repository.exportBackup(), 'application/json'))),
    const SizedBox(height: 10),
    _entry('导入并合并备份', '兼容原 Web / Capacitor 版 JSON 备份', Icons.file_open_outlined, () => _guard(_importBackup)),
    const SizedBox(height: 20),
    _section('诊断', [
      _entry('导出本次启动日志', '用于排查引擎加载与原生运行问题', Icons.receipt_long_outlined, () => _guard(() async {
        await _share('maia-launch-logs.txt', await app.diagnosticLogs(), 'text/plain');
      })),
    ]),
  ]);

  Widget _appearance() => _content([
    _heading('棋盘、棋子与音效', '选择会立即保存，并可在对局中预览。'),
    _section('棋盘', [
      _dropdown('boardTheme', '棋盘主题', {
        for (final e in _boards.entries) e.key: (e.value as Map)['label'] as String,
        'custom': '自定义颜色',
      }),
      if (app.settings.boardTheme == 'custom') ...[
        _colorSetting('customLight', '浅色格'),
        _colorSetting('customDark', '深色格'),
      ],
    ]),
    _section('棋子', [_dropdown('pieceSet', '棋子样式', _pieces.cast<String, String>())]),
    _section('声音', [
      _switch('sound', '启用走棋音效', '落子、将军与结果音效'),
      _switch('haptics', '震动反馈', '支持的平台提供触感反馈'),
      _dropdown('soundTheme', '音效主题', {
        'board': '实木棋盘', 'wood': '轻柔木质', 'felt': '柔和落子',
        'glass': '清脆玻璃', 'standard': '经典',
      }),
    ]),
  ], width: 700);

  Widget _settings() => _content([
    _heading('让它更适合你。', '所有设置与棋谱保存在本机，支持与原版本互相导入备份。'),
    _entry('棋盘、棋子与音效', '打开独立页面选择外观与反馈', Icons.dashboard_customize_outlined, () => _guard(() => app.showPage(AppPage.appearance))),
    const SizedBox(height: 10),
    _section('外观与反馈', [
      _dropdown('theme', '界面主题', {'dark': '深色', 'light': '浅色'}),
      _dropdown('boardTheme', '棋盘主题', {
        for (final e in _boards.entries)
          e.key: (e.value as Map)['label'] as String,
        'custom': '自定义颜色',
      }),
      _dropdown('pieceSet', '棋子样式', _pieces.cast<String, String>()),
      if (app.settings.boardTheme == 'custom') ...[
        _colorSetting('customLight', '浅色格'),
        _colorSetting('customDark', '深色格'),
      ],
      _slider('boardSizePlay', '对局棋盘大小（%）', 60, 100, 20),
      _slider('boardSizeReview', '复盘棋盘大小（%）', 60, 100, 20),
      _switch('boardFx', '棋盘动画', '拖拽、走子与落点反馈'),
      _switch('boardFxRing', '走子光圈', '走子后显示落点反馈'),
      _switch('boardFxSparkle', '精彩着法星光', '高质量着法显示星光'),
      _switch('boardFxBadge', '着法判断徽标', '在棋盘上显示着法评价'),
      _switch('boardFxHang', '受攻棋子光晕', '标记可能被吃的棋子'),
      _switch('boardFxCapture', '吃子粒子', '吃子时显示粒子反馈'),
      _switch('boardFxCheck', '将军脉冲', '将军时显示脉冲反馈'),
      _switch('boardFxMate', '将杀彩带', '将杀时显示庆祝效果'),
      _switch('boardFxCastle', '王车易位飞跃', '易位时播放特殊动画'),
      _switch('boardFxDodge', '被吃棋子躲闪', '被吃棋子播放躲闪反馈'),
      _switch('boardFxShake', '失误时棋盘抖动', '严重失误时轻微抖动'),
      _switch('sound', '音效', '内置成品录音'),
      _dropdown('soundTheme', '音效主题', {
        'board': '实木棋盘',
        'wood': '轻柔木质',
        'felt': '柔和落子',
        'glass': '清脆玻璃',
        'standard': '经典',
      }),
      _switch('haptics', '触感反馈', 'iPhone 原生触感与拖拽反馈'),
      ListTile(
        contentPadding: EdgeInsets.zero,
        title: const Text('我的头像'),
        trailing: const Icon(Icons.chevron_right),
        onTap: _avatarDialog,
      ),
    ]),
    _section('对局', [
      _numberSetting('playerElo', '我的自估 Elo 起点', '仅影响玩家评级，保留累计计分局数', 0, 2600),
      _dropdown('timeControl', '棋钟', _timeLabels),
      _switch('premove', '预走', '对手思考时预先选择下一步，走子前再次检查合法性'),
      _switch('thinkDelay', '拟人思考时间', '保留自然的走棋节奏'),
      _switch('opponentTalk', '莉亚文字反馈', '显示关键事件与战术提示，默认关闭'),
      _slider('temperature', 'Maia 随机性', 0, 1.5, 15),
      _switch('reviewOpponent', '复盘分析对方着法', '同时显示双方的关键点'),
    ]),
    _section('引擎', [
      if (app.fixedNativeProfile)
        const Padding(
          padding: EdgeInsets.only(bottom: 16),
          child: Text('此安装包固定使用 Maia 79M 和 Stockfish 满血版。'),
        ),
      if (!app.fixedNativeProfile)
        _dropdown('model', 'Maia 模型', {
          '5m': '5M · 更快',
          '23m': '23M · 推荐',
          '79m': '79M · 更大模型',
        }),
      if (!app.fixedNativeProfile)
        _switch('sfLite', 'Stockfish 轻量版', '小网络，降低内存占用'),
      _numberSetting('sfThreads', 'Stockfish 线程', 'iPhone 推荐 2，减少发热', 1, 16),
      _numberSetting('sfHash', 'Stockfish Hash（MB）', '重载引擎后生效', 16, 1024),
      _numberSetting('sfMovetime', '单局面分析时间（毫秒）', '更长的时间可以获得更深分析', 100, 20000),
      OutlinedButton.icon(
        onPressed: () => _guard(app.warmup),
        icon: const Icon(Icons.refresh),
        label: const Text('应用并重载引擎'),
      ),
      const SizedBox(height: 8),
      Text(app.engineLabel, style: const TextStyle(fontSize: 11)),
    ]),
    _section('备份与诊断', [
      _entry(
        '导出全部备份',
        '设置、评级、棋谱、错题和训练进度',
        Icons.ios_share_rounded,
        () => _guard(
          () => _share(
            'maia-coach-backup.json',
            app.repository.exportBackup(),
            'application/json',
          ),
        ),
      ),
      const SizedBox(height: 10),
      _entry(
        '导入并合并备份',
        '兼容原 Web / Capacitor 版 JSON 备份',
        Icons.file_open_outlined,
        () => _guard(_importBackup),
      ),
      const SizedBox(height: 10),
      _switch('samplingCapture', '采样诊断', '只记录成功落子的决策，最多最近 10 局与 8 MiB；独立于棋谱备份'),
      Text(
        '${app.samplingStore.games} 局 · ${app.samplingStore.decisions} 次决策 · ${(app.samplingStore.bytes / 1024).toStringAsFixed(1)} KiB',
        style: const TextStyle(fontSize: 11),
      ),
      const SizedBox(height: 8),
      const Text(
        '原始概率来自 Maia；实际概率经过 temperature 调整（Top-P 固定为 1）。预期得分为胜率＋一半和棋率，它们均不代表着法质量。所有诊断仅保存在本机。',
        style: TextStyle(fontSize: 11, height: 1.6),
      ),
      TextButton.icon(
        onPressed: () => _guard(
          () => _share(
            'maia-sampling.jsonl',
            app.samplingStore.exportJsonl(),
            'application/x-ndjson',
          ),
        ),
        icon: const Icon(Icons.code),
        label: const Text('导出采样诊断'),
      ),
      TextButton.icon(
        onPressed: () => _guard(
          () => _share(
            'maia-sampling.html',
            app.samplingStore.exportHtml(),
            'text/html',
          ),
        ),
        icon: const Icon(Icons.description_outlined),
        label: const Text('导出离线 HTML 报告'),
      ),
      TextButton(
        onPressed: () => _guard(() async {
          if (!await _confirm('清除采样诊断？', '这会删除本机采样诊断记录，保留棋谱和训练进度。')) return;
          final result = await app.samplingStore.clear();
          if (!result.ok) throw StateError(result.error!);
          app.refresh();
        }),
        child: const Text('清除采样诊断'),
      ),
      TextButton.icon(
        onPressed: () => _guard(() async {
          await _share(
            'maia-launch-logs.txt',
            await app.diagnosticLogs(),
            'text/plain',
          );
        }),
        icon: const Icon(Icons.receipt_long_outlined),
        label: const Text('导出本次启动日志'),
      ),
      TextButton(
        onPressed: () =>
            showLicensePage(context: context, applicationName: 'Maia Coach'),
        child: const Text('开源许可'),
      ),
    ]),
    const Text(
      'Maia Coach · Flutter 迁移分支\nUI 使用 Flutter 绘制；iOS 引擎为 C++ Stockfish 与 CoreML。',
      textAlign: TextAlign.center,
      style: TextStyle(fontSize: 11, height: 1.8),
    ),
  ], width: 700);

  Widget _section(String title, List<Widget> children) => Padding(
    padding: const EdgeInsets.only(bottom: 20),
    child: _card(
      Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Text(
            title,
            style: const TextStyle(fontWeight: FontWeight.w700, color: accent),
          ),
          const SizedBox(height: 14),
          ...children,
        ],
      ),
    ),
  );

  Widget _switch(String key, String label, String subtitle) =>
      SwitchListTile.adaptive(
        contentPadding: EdgeInsets.zero,
        value: app.settings[key] == true,
        title: Text(label, style: const TextStyle(fontSize: 14)),
        subtitle: Text(subtitle, style: const TextStyle(fontSize: 11)),
        onChanged: (v) => _guard(() => app.updateSetting(key, v)),
      );
  Widget _colorSetting(String key, String label) => Padding(
    padding: const EdgeInsets.only(bottom: 12),
    child: TextFormField(
      initialValue: app.settings[key] as String,
      decoration: InputDecoration(labelText: '$label · #RRGGBB'),
      onFieldSubmitted: (value) => _guard(() async {
        if (!RegExp(r'^#[a-fA-F0-9]{6}$').hasMatch(value.trim())) {
          throw const FormatException('请输入 #RRGGBB 格式的颜色');
        }
        await app.updateSetting(key, value.trim());
      }),
    ),
  );
  Widget _dropdown(String key, String label, Map<String, String> options) {
    if (options.isEmpty) return const SizedBox.shrink();
    final value = app.settings[key] as String?;
    return Padding(
      padding: const EdgeInsets.only(bottom: 12),
      child: DropdownButtonFormField<String>(
        key: ValueKey('$key-$value'),
        initialValue: options.containsKey(value) ? value : options.keys.first,
        isExpanded: true,
        decoration: InputDecoration(labelText: label),
        items: options.entries
            .map(
              (e) => DropdownMenuItem(
                value: e.key,
                child: Text(e.value, overflow: TextOverflow.ellipsis),
              ),
            )
            .toList(),
        onChanged: (v) {
          if (v != null) _guard(() => app.updateSetting(key, v));
        },
      ),
    );
  }

  Widget _numberSetting(
    String key,
    String title,
    String subtitle,
    int minValue,
    int maxValue,
  ) {
    final controller = _settingControllers.putIfAbsent(
      key,
      () => TextEditingController(
        text: '${(app.settings[key] as num? ?? minValue).round()}',
      ),
    );
    return Padding(
      padding: const EdgeInsets.only(bottom: 14),
      child: TextField(
        controller: controller,
        keyboardType: TextInputType.number,
        inputFormatters: [FilteringTextInputFormatter.digitsOnly],
        decoration: InputDecoration(
          labelText: title,
          helperText: subtitle,
          helperMaxLines: 2,
          suffixIcon: IconButton(
            tooltip: '保存',
            icon: const Icon(Icons.check, size: 18),
            onPressed: () => _guard(() async {
              final value = int.tryParse(controller.text);
              if (value == null || value < minValue || value > maxValue) {
                throw FormatException('请输入 $minValue–$maxValue');
              }
              await app.updateSetting(key, value);
              _snack('已保存');
            }),
          ),
        ),
        onSubmitted: (text) => _guard(() async {
          final value = int.tryParse(text);
          if (value == null || value < minValue || value > maxValue) {
            throw FormatException('请输入 $minValue–$maxValue');
          }
          await app.updateSetting(key, value);
        }),
      ),
    );
  }

  Widget _slider(
    String key,
    String title,
    double low,
    double high,
    int divisions,
  ) => Column(
    children: [
      Row(
        children: [
          Text(title),
          const Spacer(),
          Text('${app.settings[key]}', style: const TextStyle(color: accent)),
        ],
      ),
      Slider(
        value: (app.settings[key] as num? ?? low).toDouble().clamp(low, high),
        min: low,
        max: high,
        divisions: divisions,
        onChanged: (v) =>
            _guard(() => app.updateSetting(key, (v * 10).round() / 10)),
      ),
    ],
  );

  Future<void> _importBackup() async {
    final file = await openFile(
      acceptedTypeGroups: const [
        XTypeGroup(label: 'JSON 备份', extensions: ['json']),
      ],
    );
    if (file == null) return;
    if (await file.length() > 50 * 1024 * 1024) {
      throw const FormatException('文件不能超过 50 MB');
    }
    final skipped = await app.repository.importBackup(
      await file.readAsString(),
    );
    await app.applyImportedSettings();
    _snack('备份已合并${skipped > 0 ? '，跳过 $skipped 条无效记录' : ''}');
  }

  Future<void> _share(String name, String text, String mime) async {
    final renderBox = context.findRenderObject() as RenderBox?;
    await SharePlus.instance.share(
      ShareParams(
        title: name,
        files: [
          XFile.fromData(
            Uint8List.fromList(utf8.encode(text)),
            mimeType: mime,
            name: name,
          ),
        ],
        fileNameOverrides: [name],
        sharePositionOrigin: renderBox == null
            ? const Rect.fromLTWH(0, 0, 1, 1)
            : renderBox.localToGlobal(Offset.zero) & renderBox.size,
      ),
    );
  }

  Future<bool> _confirm(String title, String message) async =>
      await showDialog<bool>(
        context: context,
        builder: (context) => AlertDialog(
          title: Text(title),
          content: Text(message),
          actions: [
            TextButton(
              onPressed: () => Navigator.pop(context, false),
              child: const Text('取消'),
            ),
            FilledButton(
              onPressed: () => Navigator.pop(context, true),
              child: const Text('继续'),
            ),
          ],
        ),
      ) ??
      false;

  void _resign() => _guard(() async {
    if (await _confirm('确认认输？', '对局将立即结束并保存到历史记录。')) await app.resign();
  });

  void _gameMenu() => showModalBottomSheet<void>(
    context: context,
    showDragHandle: true,
    builder: (sheet) => SafeArea(
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          if (!app.inReview)
            ListTile(
              leading: const Icon(Icons.add),
              title: const Text('新对局'),
              onTap: () { Navigator.pop(sheet); _newGame(); },
            ),
          if (!app.inReview && !app.ended)
            ListTile(
              leading: const Icon(Icons.flag_outlined),
              title: const Text('认输'),
              onTap: () { Navigator.pop(sheet); _resign(); },
            ),
          if (!app.inReview && !app.ended)
            ListTile(
              leading: const Icon(Icons.handshake_outlined),
              title: const Text('向 Maia 提和'),
              onTap: () { Navigator.pop(sheet); _guard(() async { await app.offerDraw(); }); },
            ),
          if (app.inReview || app.node != null)
            ListTile(
              leading: const Icon(Icons.play_arrow_outlined),
              title: const Text('从当前局面对弈'),
              onTap: () { final fen = app.fen; Navigator.pop(sheet); _guard(() => app.startGame(fromFen: fen)); },
            ),
          ListTile(
            leading: const Icon(Icons.history),
            title: const Text('历史与统计'),
            onTap: () { Navigator.pop(sheet); _guard(() => app.showPage(AppPage.history)); },
          ),
          ListTile(
            leading: const Icon(Icons.storage_outlined),
            title: const Text('数据备份'),
            onTap: () { Navigator.pop(sheet); _guard(() => app.showPage(AppPage.data)); },
          ),
          ListTile(
            leading: const Icon(Icons.copy_outlined),
            title: const Text('复制当前 PGN'),
            onTap: () { Navigator.pop(sheet); Clipboard.setData(ClipboardData(text: app.gamePgn())); _snack('已复制 PGN'); },
          ),
          ListTile(
            leading: const Icon(Icons.file_open_outlined),
            title: const Text('导入 PGN / FEN'),
            onTap: () { Navigator.pop(sheet); _importDialog(); },
          ),
          ListTile(
            leading: const Icon(Icons.ios_share),
            title: const Text('导出当前棋谱'),
            onTap: () { Navigator.pop(sheet); _guard(() => _share('maia-game.pgn', app.gamePgn(), 'application/x-chess-pgn')); },
          ),
          ListTile(
            leading: const Icon(Icons.copy_outlined),
            title: const Text('复制当前 FEN'),
            onTap: () { Navigator.pop(sheet); Clipboard.setData(ClipboardData(text: app.fen)); _snack('已复制 FEN'); },
          ),
          ListTile(
            leading: const Icon(Icons.tune),
            title: const Text('设置'),
            onTap: () { Navigator.pop(sheet); _guard(() => app.showPage(AppPage.settings)); },
          ),
          const SizedBox(height: 8),
        ],
      ),
    ),
  );

  void _importDialog() {
    final controller = TextEditingController();
    showDialog<String>(
          context: context,
          builder: (dialog) => AlertDialog(
            title: const Text('导入 PGN / FEN'),
            content: SizedBox(
              width: 520,
              child: TextField(
                controller: controller,
                minLines: 5,
                maxLines: 10,
                decoration: const InputDecoration(
                  hintText: '粘贴 PGN 棋谱或 FEN 局面…',
                ),
                autofocus: true,
              ),
            ),
            actions: [
              TextButton(
                onPressed: () => _guard(() async {
                  final file = await openFile(
                    acceptedTypeGroups: const [
                      XTypeGroup(
                        label: '棋谱',
                        extensions: ['pgn', 'txt', 'fen'],
                      ),
                    ],
                  );
                  if (file != null) controller.text = await file.readAsString();
                }),
                child: const Text('选择文件'),
              ),
              TextButton(
                onPressed: () => Navigator.pop(dialog),
                child: const Text('取消'),
              ),
              FilledButton(
                onPressed: () => Navigator.pop(dialog, controller.text),
                child: const Text('导入'),
              ),
            ],
          ),
        )
        .then(
          (text) => _guard(() async {
            if (text == null || text.trim().isEmpty) return;
            final value = text.trim();
            if (RegExp(r'^[prnbqkPRNBQK1-8/]+\s+[wb]\s').hasMatch(value)) {
              final board = position(value);
              await app.startGame(fromFen: board.fen);
            } else {
              await app.importPgn(value);
            }
          }),
        )
        .whenComplete(controller.dispose);
  }

  void _aidsDialog() => showDialog<void>(
    context: context,
    builder: (dialog) => StatefulBuilder(
      builder: (context, setDialogState) => AlertDialog(
        title: const Text('对局辅助'),
        content: SizedBox(
          width: 360,
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              const Text('开启辅助后，本局转为不计分练习。', style: TextStyle(fontSize: 12)),
              for (final e in {
                'aidEval': '显示评估条',
                'aidWinPct': '显示获胜机会',
                'aidThreats': '对手威胁',
                'aidHanging': '悬子标记',
                'aidBest': '显示最佳着法',
              }.entries)
                SwitchListTile.adaptive(
                  contentPadding: EdgeInsets.zero,
                  title: Text(e.value),
                  value: app.settings[e.key] == true,
                  onChanged: (v) => _guard(() async {
                    await app.updateSetting(e.key, v);
                    if (context.mounted) setDialogState(() {});
                    if (v && e.key == 'aidBest') {
                      await app.hint(practice: false);
                    } else if (v && ['aidEval', 'aidWinPct'].contains(e.key)) {
                      await app.analysePosition();
                    }
                  }),
                ),
            ],
          ),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(dialog),
            child: const Text('完成'),
          ),
        ],
      ),
    ),
  );

  void _avatarDialog() {
    const presets = [
      '',
      '🦁|#e0a243',
      '🐯|#d9773b',
      '🦊|#c8553d',
      '🐼|#6b8f71',
      '🐨|#7a8ca3',
      '🐸|#5d9948',
      '🐧|#3d6e9e',
      '🦉|#8a6d4e',
      '🐱|#b9769a',
      '🐶|#a77b4f',
      '🐰|#9b7fc4',
      '♔|#4b4847',
      '♕|#7b3f61',
      '♘|#2f6f6b',
      '😎|#c2a33a',
    ];
    showDialog<void>(
      context: context,
      builder: (dialog) => AlertDialog(
        title: const Text('我的头像'),
        content: SizedBox(
          width: 280,
          child: Wrap(
            spacing: 10,
            runSpacing: 10,
            children: presets
                .map(
                  (p) => InkWell(
                    borderRadius: BorderRadius.circular(12),
                    onTap: () {
                      app.updateSetting('avatar', p);
                      Navigator.pop(dialog);
                    },
                    child: Container(
                      width: 56,
                      height: 56,
                      alignment: Alignment.center,
                      decoration: BoxDecoration(
                        color: p.isEmpty
                            ? Colors.grey
                            : _hex(p.split('|').last, Colors.grey),
                        borderRadius: BorderRadius.circular(12),
                      ),
                      child: Text(
                        p.isEmpty ? '♙' : p.split('|').first,
                        style: const TextStyle(fontSize: 28),
                      ),
                    ),
                  ),
                )
                .toList(),
          ),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(dialog),
            child: const Text('关闭'),
          ),
        ],
      ),
    );
  }

  void _compareDialog() {
    int a = 1000, b = 2000;
    bool busy = false;
    Map<String, dynamic>? left, right;
    String? error;
    showDialog<void>(
      context: context,
      builder: (dialog) => StatefulBuilder(
        builder: (context, refresh) {
          Widget column(
            int elo,
            Map<String, dynamic>? result,
            ValueChanged<int> change,
          ) => Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              mainAxisSize: MainAxisSize.min,
              children: [
                DropdownButton<int>(
                  isExpanded: true,
                  value: elo,
                  items: _levels
                      .map(
                        (v) =>
                            DropdownMenuItem(value: v, child: Text('Maia $v')),
                      )
                      .toList(),
                  onChanged: busy
                      ? null
                      : (v) {
                          if (v != null) refresh(() => change(v));
                        },
                ),
                if (result != null) ...[
                  Text(
                    '预期得分 ${((result['expected'] as num) * 100).toStringAsFixed(1)}%',
                    style: const TextStyle(color: accent, fontSize: 12),
                  ),
                  const SizedBox(height: 6),
                ],
                ...?(result?['moves'] as List<Map<String, dynamic>>?)
                    ?.take(5)
                    .map(
                      (m) => Padding(
                        padding: const EdgeInsets.symmetric(vertical: 4),
                        child: Text(
                          '${m['san']}  ${((m['p'] as num) * 100).toStringAsFixed(1)}%',
                          style: const TextStyle(fontSize: 12),
                        ),
                      ),
                    ),
              ],
            ),
          );
          return AlertDialog(
            title: const Text('比较人类常走着法'),
            content: SizedBox(
              width: 500,
              child: Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  const Text(
                    '每列使用相同双方 Elo，展示模型原始概率。',
                    style: TextStyle(fontSize: 11),
                  ),
                  const SizedBox(height: 12),
                  Row(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      column(a, left, (v) => a = v),
                      const SizedBox(width: 24),
                      column(b, right, (v) => b = v),
                    ],
                  ),
                  if (busy) const LinearProgressIndicator(),
                  if (error != null)
                    Text(error!, style: const TextStyle(color: Colors.orange)),
                ],
              ),
            ),
            actions: [
              TextButton(
                onPressed: () => Navigator.pop(dialog),
                child: const Text('关闭'),
              ),
              FilledButton(
                onPressed: busy
                    ? null
                    : () async {
                        final fen = app.fen;
                        refresh(() {
                          busy = true;
                          error = null;
                        });
                        try {
                          final p1 = await app.engines.predict(
                            fen,
                            selfElo: a,
                            opponentElo: a,
                          );
                          final p2 = await app.engines.predict(
                            fen,
                            selfElo: b,
                            opponentElo: b,
                          );
                          Map<String, dynamic> data(dynamic p) => {
                            'expected':
                                (p.wdl[0] as num) + (p.wdl[1] as num) / 2,
                            'moves': (p.moves as List)
                                .map(
                                  (dynamic m) => <String, dynamic>{
                                    'san':
                                        legalMoves(fen)
                                            .where((x) => x.uci == m.uci)
                                            .firstOrNull
                                            ?.san ??
                                        m.uci,
                                    'p': m.p,
                                  },
                                )
                                .toList(),
                          };
                          if (context.mounted) {
                            refresh(() {
                              left = data(p1);
                              right = data(p2);
                            });
                          }
                        } catch (e) {
                          if (context.mounted) refresh(() => error = '$e');
                        } finally {
                          if (context.mounted) refresh(() => busy = false);
                        }
                      },
                child: const Text('比较'),
              ),
            ],
          );
        },
      ),
    );
  }
}

class _NavigateIntent extends Intent {
  const _NavigateIntent(this.direction);
  final int direction;
}

class _HomeIntent extends Intent {
  const _HomeIntent();
}
