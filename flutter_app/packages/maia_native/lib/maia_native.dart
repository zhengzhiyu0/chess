/// Channel names exported by the automatically registered iOS plugin.
/// The application may use these channels directly without a Dart singleton.
library;

import 'package:flutter/services.dart';

abstract final class MaiaNativeChannels {
  static const methods = MethodChannel('maia_coach/native');
  static const stockfish = EventChannel('maia_coach/stockfish');
  static const migration = MethodChannel('maia_coach/migration');
}
