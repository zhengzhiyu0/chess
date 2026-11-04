# Maia native Flutter plugin

Flutter registers `MaiaNativePlugin` from the application's local `maia_native`
dependency. It has no Capacitor or Cordova dependency. The engine/audio paths are
native; an optional one-shot WebKit reader preserves old localStorage on upgrade.
The app calls channels directly; `lib/maia_native.dart` only exports their names.
iOS 17 or later is required for the existing CoreML models.

## Channels

MethodChannel: `maia_coach/native`. Void methods return null; failures return
`FlutterError` with a stable code (including `cancelled`, `invalid_arguments`,
`engine_unavailable`, `model_missing`, `model_probe_failed`). All replies and
events reach Flutter on the main thread.

| Method | Arguments | Result |
| --- | --- | --- |
| `stockfish.start` | `{engine: 'full' \| 'lite'}` | null; engine readiness follows UCI |
| `stockfish.send` | `{engine, cmd}` | null |
| `device.info` | none | `{cores, perfCores, availableMemory, physicalMemory, thermalState}` |
| `maia.load` | `{model: '5m' \| '23m' \| '79m', probeTokens?, probeLegal?, probeTop?}` | `{provider: 'coreml'}` |
| `maia.eval` | `{tokens, indices, selfElo, oppoElo}` | `{logits, value, ms}` |
| `maia.evalBatch` | `{items: [same arguments as eval]}` | `{results: [same result as eval]}` |
| `maia.unload` | none | null |
| `sound.play` | `{clips: [{theme, file, delay}]}` | null |
| `sound.stop` | none | null |
| `logs.get` | none | `{logs: String}` |

Tokens are base64 encoded little-endian Float32 `[1,64,96]` (24576 bytes).
Policy output has 4352 finite logits; `indices` selects the returned logits in
caller order (out-of-range indices retain the existing `-1e9` sentinel). Value
returns three finite raw logits `[loss, draw, win]`, not probabilities. Elo inputs
default to 1500. Batch items run serially. Load checks finite outputs and, when
provided, the original legal/top-move start-position probe. Partial probes fail.

EventChannel: `maia_coach/stockfish` emits `{engine, lines: [String]}`. Output is
ordered and coalesced up to 150 ms; `bestmove`, `readyok`, `uciok` flush immediately.
Subscribe before sending UCI commands. Engines and C callback contexts live for
the process lifetime, allowing Flutter engine restarts without dangling pointers.
Cancelling the event subscription sends `stop` and drops pending event batches.
`quit` is interpreted as `stop` because these embedded engine threads persist.

Backgrounding independently stops both searches, cancels outstanding CoreML
calls, and clears active/scheduled audio. CoreML's synchronous prediction cannot
be preempted; its eventual result is discarded and later batch items are skipped.
Models remain warm for short switches and release after 10 seconds in background.
After a long background interval the caller should load again. Unload invalidates
pending inference immediately, then releases the model on its serialization queue.

Audio preserves the five themes, Standard fallback, one/two-clip batches, delays
in seconds (0 through 2), mixing with other audio, interruption cleanup and the
eight-player cap. Logs retain the most recent 500 entries.

The plugin also owns `MethodChannel('maia_coach/migration')`, method `legacy.read`,
returning `Map<String, String>` of the raw `maia-coach.*` localStorage keys. Main
can call `invokeMapMethod<String, String>('legacy.read')` directly. Do not register
a duplicate migration channel/reader in AppDelegate. The hidden one-shot WebKit
reader uses the default persistent store and the original `capacitor://localhost`
origin, serves a blank local document, blocks outside navigation, reads only,
caches a successful snapshot and releases its WebView on success/error/timeout.
It never clears/overwrites localStorage, and logs only counts. Main must import
the strings with `importLegacyStorage` and save its once-only migration marker
after a successful import. The app retains the original bundle identifier
`io.github.zhengzhiyu0.maiacoach`; real upgrade testing on iOS is still required.

## Preparing and building

Run from the repository root (PowerShell 7 on Windows):

```powershell
node flutter_app/scripts/prepare-assets.mjs
node flutter_app/scripts/prepare-ios.mjs --prepare-only
Push-Location flutter_app
& D:\dev\flutter-sdk\bin\flutter.bat pub get
Pop-Location
node --test flutter_app/packages/maia_native/test/prepare-ios.test.mjs
```

`--prepare-only` stages C++ source/audio and creates `assets/native`, allowing
local Dart checks without downloading models. It does **not** produce runnable
iOS engines by itself. The default mode also prepares hash-verified NNUE and
assembles native ONNX parts using full manifest SHA-256 and size checks. It reads
the original engine files and manifests without modifying them. Generated heavy
source/resource/cache trees inside the plugin are ignored by Git.

On macOS, use the same `NATIVE_PROFILE` (`all` or `79m-full`) for preparation,
pod installation and Flutter's `--dart-define=NATIVE_PROFILE=...`:

```sh
export NATIVE_PROFILE=all
node flutter_app/scripts/prepare-ios.mjs
# Install the pinned Python dependencies from .github/workflows/flutter-ios.yml first.
python web/scripts/compile-coreml.py --models 5m,23m,79m \
  --native-public-dir flutter_app/assets/native \
  --dist-native-dir flutter_app/assets/native \
  --cache-dir flutter_app/packages/maia_native/.cache/coreml-build
node flutter_app/scripts/prepare-ios.mjs --bundle-only
cd flutter_app
flutter config --no-enable-swift-package-manager
flutter pub get
flutter build ios --release --no-codesign --dart-define=NATIVE_PROFILE="$NATIVE_PROFILE"
```

For `79m-full`, pass `--models 79m`. The script removes only explicitly named
unselected generated model/network paths. Profile metadata is authoritative;
pod installation rejects an environment profile different from prepared sources.

`StockfishFull` and `StockfishLite` are two independent static CocoaPods targets,
with `StockfishFull`/`StockfishLite` C++ namespaces and `sf_full`/`sf_lite` C symbols.
The Podfile declares each local source path. No root pod subspec shares compile
definitions across them. Sources compile only through the existing per-flavour
wrappers, preserving their NNUE architecture. arm64 uses baseline NEON; x86_64
uses SSE2, without forcing an iPhone CPU or NEON onto Intel simulators.

Asset lookup uses the Flutter registrar key and Bundle.main's Flutter assets
(`Frameworks/App.framework/flutter_assets/assets/native` in a release app), then
`MaiaNativeAssets.bundle` in the app/plugin bundle. Flutter's directory asset
declaration does not recursively include `.mlmodelc` contents, so `--bundle-only`
also stages a complete resource bundle copied by CocoaPods. The final-app CI gate
checks those model contents, NNUE hashes, all audio hashes, profile exclusions,
native symbols and the original app identifier `io.github.zhengzhiyu0.maiacoach`.

`node --test .../prepare-ios.test.mjs` also exercises both real preparation
profiles, verifies NNUE/manifests, checks profile exclusions and restores the
requested profile afterwards. It may download networks if neither cache exists;
`--prepare-only` itself is always offline.

`.github/workflows/flutter-ios.yml` is manual only. It compiles CoreML, runs actual
generated Stockfish full/lite UCI/search/stop smoke tests, builds device and
simulator configurations, verifies packaged resources and uploads an unsigned
IPA. Building or running it requires macOS/Xcode; Windows checks do not establish
that Swift compiles or that CoreML/AVAudioPlayer work on a device.
