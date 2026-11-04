import 'dart:async';

import 'package:audioplayers/audioplayers.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';

/// Short recorded effects. iOS keeps its native AVAudioPlayer / mixing behavior.
class GameFeedback {
  static const _channel = MethodChannel('maia_coach/native');
  final _players = <AudioPlayer>[];
  DateTime _last = DateTime.fromMillisecondsSinceEpoch(0);
  bool enabled = true;
  bool haptics = true;
  String theme = 'board';

  Future<void> play(String event) async {
    if (haptics) {
      unawaited(
        event == 'Capture' || event == 'Check'
            ? HapticFeedback.mediumImpact()
            : HapticFeedback.lightImpact(),
      );
    }
    if (!enabled) return;
    final now = DateTime.now();
    if (now.difference(_last).inMilliseconds < 70 && event == 'Move') return;
    _last = now;
    if (!kIsWeb && defaultTargetPlatform == TargetPlatform.iOS) {
      await _channel.invokeMethod<void>('sound.play', {
        'clips': [
          {'theme': theme, 'file': event, 'delay': 0.0},
        ],
      });
      return;
    }
    // Compact themes override only the move and capture recordings.
    final selected = event == 'Move' || event == 'Capture' ? theme : 'standard';
    final file = selected == 'standard'
        ? switch (event) {
            'Move' || 'Check' => 'move',
            'Capture' => 'capture',
            'LowTime' => 'error',
            _ => 'dong',
          }
        : event;
    final player = AudioPlayer();
    _players.add(player);
    player.onPlayerComplete.first.then((_) {
      _players.remove(player);
      unawaited(player.dispose());
    });
    try {
      await player.play(AssetSource('sounds/$selected/$file.mp3'));
    } catch (_) {
      _players.remove(player);
      await player.dispose();
      rethrow;
    }
  }

  Future<void> stop() async {
    for (final player in _players.toList()) {
      await player.stop();
      await player.dispose();
    }
    _players.clear();
    if (!kIsWeb && defaultTargetPlatform == TargetPlatform.iOS) {
      await _channel.invokeMethod<void>('sound.stop');
    }
  }

  Future<void> dispose() => stop();
}
