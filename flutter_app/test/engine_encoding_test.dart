import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:math';

import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:maia_coach/services/engines.dart';

import 'package:maia_coach/services/engine_encoding.dart';
import 'package:maia_coach/services/engine_uci.dart';

// Reads the original fixture, never a second independently maintained copy.
void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  final fixture =
      jsonDecode(File('../web/test/golden.json').readAsStringSync()) as Map;
  final cases = (fixture['cases'] as List).where((c) => c['model'] == '5m');

  group('Maia PyTorch golden encoding', () {
    for (final raw in cases) {
      final c = raw as Map;
      test(c['name'] as String, () {
        final position = enginePosition(c['fen'] as String);
        final fens = [position.fen];
        for (final uci in (c['moves'] as List).cast<String>()) {
          expect(
            position.move({
              'from': uci.substring(0, 2),
              'to': uci.substring(2, 4),
              if (uci.length == 5) 'promotion': uci[4],
            }),
            isTrue,
          );
          fens.add(position.fen);
        }
        final tokens = buildMaiaTokens(fens);
        final nonzero = <List<int>>[];
        for (var square = 0; square < 64; square++) {
          for (var feature = 0; feature < maiaFeatures; feature++) {
            final value = tokens[square * maiaFeatures + feature];
            if (value != 0) {
              expect(value, 1);
              nonzero.add([square, feature]);
            }
          }
        }
        expect(nonzero, c['tokens_nonzero']);
        expect(
          maiaLegalMoves(position).map((m) => m.index).toList()..sort(),
          c['legal_idx'],
        );
      });
    }

    test(
      'single FEN repeats all eight history slots, little endian float32',
      () {
        final tokens = buildMaiaTokens([maiaStartFen]);
        expect(tokens.length, 64 * 96);
        final bytes = base64Decode(maiaTokensBase64([maiaStartFen]));
        expect(bytes.length, 64 * 96 * 4);
        final view = ByteData.sublistView(bytes);
        for (var i = 0; i < tokens.length; i++) {
          expect(view.getFloat32(i * 4, Endian.little), tokens[i]);
        }
        for (var square = 0; square < 64; square++) {
          for (var history = 1; history < 8; history++) {
            expect(
              tokens.sublist(
                square * 96 + history * 12,
                square * 96 + (history + 1) * 12,
              ),
              tokens.sublist(square * 96, square * 96 + 12),
            );
          }
        }
      },
    );

    test(
      'black promotions use qrbn and mirror ranks without mirroring files',
      () {
        expect(mirrorMaiaUci('a2b1q'), 'a7b8q');
        expect(
          [for (final p in 'qrbn'.split('')) maiaUciIndex('a7b8$p')],
          [4100, 4101, 4102, 4103],
        );
        expect(maiaUciIndex(mirrorMaiaUci('e8g8')), maiaUciIndex('e1g1'));
      },
    );

    test('value head reverses loss/draw/win after stable softmax', () {
      final result = maiaWdlFromValue([10000.0, 10001.0, 10002.0]);
      expect(result[0], closeTo(0.6652409558, 1e-9));
      expect(result[1], closeTo(0.2447284711, 1e-9));
      expect(result[2], closeTo(0.0900305732, 1e-9));
      expect(() => maiaWdlFromValue([0, double.nan, 1]), throwsFormatException);
      expect(
        () => decodeNativeMaia(
          {
            'logits': [double.infinity],
            'value': [0, 0, 0],
            'ms': 1,
          },
          const [MaiaLegalMove('e2e4', 796)],
        ),
        throwsFormatException,
      );
    });

    test('sampling is stable at tiny temperatures and includes the full distribution', () {
      const prediction = MaiaPrediction(
        moves: [
          ScoredMove(uci: 'e2e4', logit: 10001, p: 0.7),
          ScoredMove(uci: 'd2d4', logit: 10000, p: 0.3),
        ],
        wdl: [0.5, 0, 0.5],
        ms: 1,
      );
      expect(samplePrediction(prediction, 0), 'e2e4');
      expect(samplePrediction(prediction, 1e-300, random: Random(1)), 'e2e4');
      final random = Random(42);
      final drawn = List.generate(
        2000,
        (_) => samplePrediction(prediction, 1, random: random),
      );
      expect(
        drawn.where((m) => m == 'd2d4').length / drawn.length,
        closeTo(1 / (1 + exp(1)), 0.04),
      );
    });

    test('repetition history accepts canonical en passant and rejects double replay', () {
      final position = enginePosition(maiaStartFen)..move('e4');
      final canonical = position.fen.split(' ')..[3] = '-';
      expect(
        engineSearchPosition(canonical.join(' '), maiaStartFen, ['e2e4']),
        contains(' moves e2e4'),
      );
      expect(
        () => engineSearchPosition(canonical.join(' '), null, ['e2e4']),
        throwsArgumentError,
      );
      expect(
        () => engineSearchPosition(maiaStartFen, maiaStartFen, ['e2e4']),
        throwsArgumentError,
      );
    });

    test(
      'UCI parsing and white-perspective scores match the original coach',
      () {
        final line = parseEngineInfo(
          'info depth 20 multipv 2 score cp -35 wdl 50 800 150 nodes 99 pv e7e5 g1f3',
        )!;
        expect(line.depth, 20);
        expect(line.multipv, 2);
        expect(line.cp, -35);
        expect(line.pv, ['e7e5', 'g1f3']);
        expect(line.display('b'), '+0.35');
        expect(line.whiteWin('b'), greaterThan(50));
        expect(const EngineLine(mate: -3).display('b'), '#3');
        expect(const EngineLine(mate: 0).display('w'), '#-0');
        expect(parseEngineInfo('info string loading NNUE'), isNull);
      },
    );
  });

  group('native channels and UCI ownership', () {
    const methods = MethodChannel('maia_coach/native');
    const events = MethodChannel('maia_coach/stockfish');
    final messenger =
        TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger;
    var commands = <String>[];
    var loadCount = 0;
    var unloadCount = 0;
    Future<Map<String, dynamic>> Function()? load;
    Future<void> Function(String)? onCommand;
    Map<String, dynamic>? evalRequest;
    EngineService? service;

    Future<void> emit(List<String> lines) async {
      await messenger.handlePlatformMessage(
        events.name,
        const StandardMethodCodec().encodeSuccessEnvelope({
          'engine': 'full',
          'lines': lines,
        }),
        (_) {},
      );
    }

    setUp(() {
      debugDefaultTargetPlatformOverride = TargetPlatform.iOS;
      commands = [];
      loadCount = 0;
      unloadCount = 0;
      load = null;
      onCommand = null;
      evalRequest = null;
      messenger.setMockMethodCallHandler(events, (_) async => null);
      messenger.setMockMethodCallHandler(methods, (call) async {
        final args = call.arguments as Map? ?? {};
        switch (call.method) {
          case 'stockfish.start':
            return null;
          case 'stockfish.send':
            final command = args['cmd'] as String;
            commands.add(command);
            if (command == 'uci') await emit(['uciok']);
            if (command == 'isready') await emit(['readyok']);
            await onCommand?.call(command);
            return null;
          case 'maia.load':
            loadCount++;
            expect((args['probeLegal'] as List).length, 20);
            expect((args['probeTop'] as List).length, 4);
            expect(base64Decode(args['probeTokens'] as String).length, 24576);
            return load == null ? {'provider': 'coreml'} : await load!();
          case 'maia.unload':
            unloadCount++;
            return null;
          case 'maia.eval':
            evalRequest = Map<String, dynamic>.from(args);
            return {
              'logits': List.filled((args['indices'] as List).length, 0.0),
              'value': [0.0, 1.0, 2.0],
              'ms': 3.0,
            };
          case 'device.info':
            return {'cores': 8, 'thermalState': 0};
          case 'logs.get':
            return {'logs': 'native CoreML loaded'};
          default:
            throw MissingPluginException(call.method);
        }
      });
      service = EngineService();
    });
    tearDown(() async {
      onCommand = null;
      await service?.dispose();
      service = null;
      messenger.setMockMethodCallHandler(methods, null);
      messenger.setMockMethodCallHandler(events, null);
      debugDefaultTargetPlatformOverride = null;
    });

    test('coalesces initialization, probes, UCI barriers, predicts through real contract', () async {
      final first = service!.initialize();
      final second = service!.initialize();
      expect(identical(first, second), isTrue);
      await Future.wait([first, second]);
      expect(service!.ready, isTrue);
      expect(loadCount, 1);
      expect(commands, [
        'stop',
        'ucinewgame',
        'uci',
        'setoption name Threads value 2',
        'isready',
        'setoption name Hash value 128',
        'isready',
        'setoption name UCI_ShowWDL value true',
        'isready',
      ]);
      final prediction = await service!.predict(
        maiaStartFen,
        selfElo: 1200,
        opponentElo: 1800,
      );
      expect(prediction.moves.length, 20);
      expect(
        prediction.moves.map((m) => m.p).reduce((a, b) => a + b),
        closeTo(1, 1e-8),
      );
      expect(evalRequest!['selfElo'], 1200);
      expect(evalRequest!['oppoElo'], 1800);
      expect(prediction.wdl[0], greaterThan(prediction.wdl[2]));
      expect(await service!.logs(), contains('native CoreML loaded'));
    });

    test('late bestmove is drained before next search and cannot contaminate results', () async {
      await service!.initialize();
      var go = 0;
      var searching = false;
      final started = Completer<void>();
      onCommand = (command) async {
        if (command.startsWith('go ')) {
          go++;
          searching = true;
          if (go == 1) {
            started.complete();
          } else {
            await emit([
              'info depth 12 multipv 1 score cp 35 pv d2d4 d7d5',
              'bestmove d2d4',
            ]);
            searching = false;
          }
        } else if (command == 'stop' && searching) {
          searching = false;
          // stop acknowledges immediately; terminal output arrives later.
          unawaited(
            Future<void>.delayed(
              const Duration(milliseconds: 20),
              () =>
                  emit(['info depth 8 score cp -900 pv a2a3', 'bestmove a2a3']),
            ),
          );
        }
      };
      final old = service!.analyse(maiaStartFen, milliseconds: 10000);
      await started.future;
      final stopping = service!.stop();
      final next = service!.analyse(maiaStartFen, milliseconds: 20);
      await stopping;
      expect((await old).bestmove, isNull);
      final result = await next;
      expect(go, 2);
      expect(result.bestmove, 'd2d4');
      expect(result.lines.single.cp, 35);
      expect(result.lines.single.pv.first, 'd2d4');
    });

    test(
      'unload during pending load cannot resurrect or unload its successor',
      () async {
        final gate = Completer<Map<String, dynamic>>();
        final started = Completer<void>();
        load = () {
          if (!started.isCompleted) started.complete();
          return gate.future;
        };
        final stale = service!.initialize();
        final staleCheck = expectLater(stale, throwsStateError);
        await started.future;
        final unload = service!.unloadMaia();
        expect(service!.maiaReady, isFalse);
        final fresh = service!.initialize(model: '5m');
        load = null;
        gate.complete({'provider': 'coreml'});
        await staleCheck;
        await unload;
        await fresh;
        expect(service!.ready, isTrue);
        expect(loadCount, 2);
        expect(unloadCount, 1);
        await service!.unloadMaia();
        expect(service!.maiaReady, isFalse);
        await service!.initialize(model: '5m');
        expect(service!.ready, isTrue);
        expect(loadCount, 3);
      },
    );

    test(
      'suspend while loading invalidates stale handle; foreground can retry',
      () async {
        final gate = Completer<Map<String, dynamic>>();
        final started = Completer<void>();
        load = () {
          started.complete();
          return gate.future;
        };
        final stale = service!.initialize();
        final staleCheck = expectLater(stale, throwsStateError);
        await started.future;
        await service!.suspend();
        final fresh = service!.initialize();
        load = null;
        gate.complete({'provider': 'coreml'});
        await staleCheck;
        await fresh;
        expect(service!.ready, isTrue);
        expect(service!.error, isNull);
        expect(loadCount, 2);
      },
    );

    test(
      'foreground confirms retained or natively released CoreML session',
      () async {
        await service!.initialize();
        await service!.suspend();
        await service!.initialize();
        expect(loadCount, 2);
        expect(service!.ready, isTrue);
        expect(unloadCount, 0);
      },
    );
  });
}
