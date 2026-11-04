import Flutter
import UIKit

@objc(MaiaNativePlugin)
public final class MaiaNativePlugin: NSObject, FlutterPlugin, FlutterStreamHandler {
    private let maia: NativeMaia
    private let stockfish: NativeStockfish
    private let sound: NativeSound
    private let legacyStorage = LegacyStorageReader()
    private var observers: [NSObjectProtocol] = []

    private init(assets: NativeAssets) {
        maia = NativeMaia(assets: assets)
        stockfish = NativeStockfish(assets: assets)
        sound = NativeSound(assets: assets)
        super.init()
        let center = NotificationCenter.default
        observers.append(center.addObserver(forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: .main) { [weak self] _ in
            guard let self else { return }
            self.stockfish.enterBackground()
            self.maia.enterBackground()
            self.sound.interrupt()
            self.legacyStorage.cancel()
            NativeRuntimeLog.record("background: searches stopped, inference cancelled, audio cleared", subsystem: "Lifecycle")
        })
        observers.append(center.addObserver(forName: UIApplication.didBecomeActiveNotification, object: nil, queue: .main) { [weak self] _ in
            self?.stockfish.leaveBackground()
            self?.maia.leaveBackground()
        })
        observers.append(center.addObserver(forName: UIApplication.willResignActiveNotification, object: nil, queue: .main) { [weak self] _ in
            self?.sound.interrupt()
        })
    }

    public static func register(with registrar: FlutterPluginRegistrar) {
        let instance = MaiaNativePlugin(assets: NativeAssets { registrar.lookupKey(forAsset: $0) })
        let methods = FlutterMethodChannel(name: "maia_coach/native", binaryMessenger: registrar.messenger())
        let events = FlutterEventChannel(name: "maia_coach/stockfish", binaryMessenger: registrar.messenger())
        let migration = FlutterMethodChannel(name: "maia_coach/migration", binaryMessenger: registrar.messenger())
        // Flutter invokes detachFromEngine only for published plugin instances.
        registrar.publish(instance)
        registrar.addMethodCallDelegate(instance, channel: methods)
        events.setStreamHandler(instance)
        migration.setMethodCallHandler { [weak instance] call, result in
            let reply = NativeReply(result)
            guard call.method == "legacy.read" else { reply.finish(FlutterMethodNotImplemented); return }
            guard let instance else { reply.fail(NativeFailure.cancelled); return }
            instance.legacyStorage.read(reply: reply)
        }
    }

    public func handle(_ call: FlutterMethodCall, result: @escaping FlutterResult) {
        let reply = NativeReply(result)
        let args = call.arguments as? [String: Any] ?? [:]
        switch call.method {
        case "stockfish.start": stockfish.start(args, reply: reply)
        case "stockfish.send": stockfish.send(args, reply: reply)
        case "device.info": reply.finish(stockfish.deviceInfo())
        case "maia.load": maia.load(args, reply: reply)
        case "maia.eval": maia.eval(args, reply: reply)
        case "maia.evalBatch": maia.evalBatch(args, reply: reply)
        case "maia.unload": maia.unload(reply: reply)
        case "sound.play": sound.play(args, reply: reply)
        case "sound.stop": sound.stop(); reply.finish()
        case "logs.get": reply.finish(["logs": NativeRuntimeLog.text()])
        default: reply.finish(FlutterMethodNotImplemented)
        }
    }

    public func onListen(withArguments arguments: Any?, eventSink events: @escaping FlutterEventSink) -> FlutterError? {
        stockfish.listen(events)
        return nil
    }

    public func onCancel(withArguments arguments: Any?) -> FlutterError? {
        stockfish.cancel()
        return nil
    }

    public func detachFromEngine(for registrar: FlutterPluginRegistrar) {
        stockfish.cancel()
        maia.cancelAndRelease()
        sound.stop()
        legacyStorage.cancel()
        removeObservers()
    }

    private func removeObservers() {
        for observer in observers { NotificationCenter.default.removeObserver(observer) }
        observers.removeAll()
    }

    deinit { removeObservers() }
}
