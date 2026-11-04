import Foundation
import os
import Capacitor
import UIKit
import StockfishFull
#if !MAIA_STOCKFISH_FULL_ONLY
import StockfishLite
#endif

/// Native Stockfish 19, compiled into the app with real pthreads and NEON.
/// JS sends UCI commands with `send`; engine output arrives as batched `lines` events.
@objc(StockfishNativePlugin)
public class StockfishNativePlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "StockfishNativePlugin"
    public let jsName = "StockfishNative"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "start", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "send", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "resetSession", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "info", returnType: CAPPluginReturnPromise),
    ]

    private static let nets: [String: String] = {
#if MAIA_STOCKFISH_FULL_ONLY
        return ["full": "nn-1a298aa575a0"]
#else
        return ["full": "nn-1a298aa575a0", "lite": "nn-61e7af4bb97d"]
#endif
    }()

    /// Engine output is coalesced and flushed at most every 150ms so a deep search's info stream
    /// doesn't flood the JS bridge; terminal lines (bestmove/readyok/uciok) flush immediately.
    final class Outbox {
        let flavour: String
        weak var plugin: StockfishNativePlugin?
        private var generation: Int = 0
        private var pending: [String] = []
        private let lock = NSLock()
        private var scheduled = false
        private var hasStarted = false
        private var startupStart: UInt64?
        private var firstOutputSeen = false

        func beginStartup() -> Bool {
            lock.lock()
            defer { lock.unlock() }
            if hasStarted { return true }
            hasStarted = true
            startupStart = NativeRuntimeLog.now()
            return false
        }

        private var accepting = false
        private var handoff: ((Result<Int, Error>) -> Void)?

        func beginSession(_ completion: @escaping (Result<Int, Error>) -> Void) -> Int {
            lock.lock()
            generation += 1
            let next = generation
            accepting = false
            pending.removeAll()
            let previous = handoff
            handoff = completion
            lock.unlock()
            previous?(.failure(NSError(domain: "Stockfish", code: 1, userInfo: [NSLocalizedDescriptionKey: "session superseded"])))
            return next
        }

        func failSession(_ expected: Int) {
            lock.lock()
            guard generation == expected, let completion = handoff else { lock.unlock(); return }
            handoff = nil
            accepting = false
            lock.unlock()
            completion(.failure(NSError(domain: "Stockfish", code: 2, userInfo: [NSLocalizedDescriptionKey: "session handoff timed out"])))
        }

        func owns(_ expected: Int) -> Bool {
            lock.lock()
            defer { lock.unlock() }
            return accepting && generation == expected
        }

        init(flavour: String) { self.flavour = flavour }

        func push(_ line: String) {
            lock.lock()
            if line.hasPrefix("__host_session ") {
                guard line == "__host_session \(generation)", let completion = handoff else { lock.unlock(); return }
                handoff = nil
                accepting = true
                let current = generation
                lock.unlock()
                DispatchQueue.main.async { completion(.success(current)) }
                return
            }
            guard accepting else { lock.unlock(); return }
            var startupMessage: String?
            if let startupStart {
                if line == "uciok" {
                    // The C bridge loads NNUE before processing UCI. This interval also includes
                    // engine initialization and command queueing; it is not an isolated NNUE timer.
                    startupMessage = "startup handshake uciok engine=\(flavour) startup_handshake_ms=\(NativeRuntimeLog.elapsed(startupStart)) includes=initialization/possibly_NNUE_loading NNUE_only_ms=unavailable"
                    self.startupStart = nil
                } else if !firstOutputSeen {
                    firstOutputSeen = true
                    startupMessage = "first output engine=\(flavour) since_start_ms=\(NativeRuntimeLog.elapsed(startupStart))"
                }
            }
            pending.append(line)
            let urgent = line.hasPrefix("bestmove") || line == "readyok" || line == "uciok"
            let schedule = !urgent && !scheduled
            if schedule { scheduled = true }
            lock.unlock()
            if let startupMessage { NativeRuntimeLog.record(startupMessage, subsystem: "Stockfish") }
            if urgent {
                flush()
            } else if schedule {
                DispatchQueue.global(qos: .userInitiated).asyncAfter(deadline: .now() + .milliseconds(150)) { [weak self] in
                    self?.flush()
                }
            }
        }

        func flush() {
            // enqueue onto main while still holding the lock: the timer flush and an urgent flush from the
            // search thread can interleave, and batches must reach JS in the order they were taken out
            lock.lock()
            defer { lock.unlock() }
            let lines = pending
            pending.removeAll()
            scheduled = false
            guard !lines.isEmpty, let plugin else { return }
            let flavour = flavour
            let generation = generation
            DispatchQueue.main.async { [weak self, weak plugin] in
                guard let self, let plugin else { return }
                self.lock.lock()
                let current = self.generation
                self.lock.unlock()
                guard current == generation else { return }
                plugin.notifyListeners("lines", data: ["engine": flavour, "generation": generation, "lines": lines])
            }
        }
    }

    // the C engines keep raw pointers to these for the life of the process
    private static let outboxes: [String: Outbox] = {
#if MAIA_STOCKFISH_FULL_ONLY
        return ["full": Outbox(flavour: "full")]
#else
        return ["full": Outbox(flavour: "full"), "lite": Outbox(flavour: "lite")]
#endif
    }()
    private var started = Set<String>()
    private var backgroundObserver: NSObjectProtocol?

    override public func load() {
        backgroundObserver = NotificationCenter.default.addObserver(
            forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: nil
        ) { _ in
            // 不依赖 WebView 在被挂起前及时发送 visibilitychange。
            "stop".withCString { cmd in
                sf_full_send(cmd)
#if !MAIA_STOCKFISH_FULL_ONLY
                sf_lite_send(cmd)
#endif
            }
        }
    }

    deinit {
        if let backgroundObserver { NotificationCenter.default.removeObserver(backgroundObserver) }
    }

    private static let onLine: @convention(c) (UnsafeMutableRawPointer?, UnsafePointer<CChar>) -> Void = { ctx, line in
        guard let ctx else { return }
        Unmanaged<Outbox>.fromOpaque(ctx).takeUnretainedValue().push(String(cString: line))
    }

    private func flavour(_ call: CAPPluginCall) -> String? {
        let f = call.getString("engine") ?? "full"
        return Self.nets[f] != nil ? f : nil
    }

    @objc func start(_ call: CAPPluginCall) {
        let requested = NativeRuntimeLog.now()
        guard let f = flavour(call), let box = Self.outboxes[f], let netName = Self.nets[f] else {
            NativeRuntimeLog.record("start failed reason=unknown_engine total_ms=\(NativeRuntimeLog.elapsed(requested))", subsystem: "Stockfish")
            return call.reject("unknown engine")
        }
        let context = "engine=\(f) network=\(netName)"
        NativeRuntimeLog.record("start requested \(context)", subsystem: "Stockfish")
        let resourceStart = NativeRuntimeLog.now()
        guard let net = Bundle.main.path(forResource: netName, ofType: "nnue", inDirectory: "public/native") else {
            NativeRuntimeLog.record("start failed \(context) stage=NNUE_resource resource_ms=\(NativeRuntimeLog.elapsed(resourceStart)) total_ms=\(NativeRuntimeLog.elapsed(requested)) reason=network_not_bundled", subsystem: "Stockfish")
            return call.reject("network \(netName).nnue is missing from the app bundle")
        }
        NativeRuntimeLog.record("NNUE resource found \(context) resource_ms=\(NativeRuntimeLog.elapsed(resourceStart))", subsystem: "Stockfish")
        box.plugin = self
        let generation = box.beginSession { result in
            switch result {
            case .success(let generation): call.resolve(["generation": generation])
            case .failure(let error): call.reject(error.localizedDescription)
            }
        }
        let ctx = Unmanaged.passUnretained(box).toOpaque()
        let reused = box.beginStartup()
        let dispatchStart = NativeRuntimeLog.now()
        net.withCString { path in
#if MAIA_STOCKFISH_FULL_ONLY
            sf_full_start(path, Self.onLine, ctx)
#else
            if f == "full" {
                sf_full_start(path, Self.onLine, ctx)
            } else {
                sf_lite_start(path, Self.onLine, ctx)
            }
#endif
        }
        started.insert(f)
        NativeRuntimeLog.record("start dispatched \(context) reused=\(reused) dispatch_ms=\(NativeRuntimeLog.elapsed(dispatchStart)) total_ms=\(NativeRuntimeLog.elapsed(requested)) ready=pending_uci_handshake", subsystem: "Stockfish")
        // Plain isready does not join an ongoing search. The private command does so on the
        // engine thread before activating this generation, without blocking the UI thread.
        sendCommand(f, "__host_session \(generation)")
        DispatchQueue.main.asyncAfter(deadline: .now() + 90) { box.failSession(generation) }
    }

    @objc func send(_ call: CAPPluginCall) {
        guard let f = flavour(call), started.contains(f) else { return call.reject("engine not started") }
        guard let cmd = call.getString("cmd") else { return call.reject("missing cmd") }
        guard let generation = call.getInt("generation"), Self.outboxes[f]?.owns(generation) == true else {
            return call.reject("stale engine session")
        }
        sendCommand(f, cmd)
        call.resolve()
    }

    private func sendCommand(_ flavour: String, _ command: String) {
        command.withCString {
#if MAIA_STOCKFISH_FULL_ONLY
            sf_full_send($0)
#else
            if flavour == "full" {
                sf_full_send($0)
            } else {
                sf_lite_send($0)
            }
#endif
        }
    }

    @objc func resetSession(_ call: CAPPluginCall) {
        for (flavour, box) in Self.outboxes {
            _ = box.beginSession { _ in }
            sendCommand(flavour, "stop")
        }
        call.resolve()
    }

    /// Hardware hints for picking defaults: cores, performance cores, memory still available to the app.
    @objc func info(_ call: CAPPluginCall) {
        var perf: Int32 = 0
        var size = MemoryLayout<Int32>.size
        if sysctlbyname("hw.perflevel0.physicalcpu", &perf, &size, nil, 0) != 0 { perf = 0 }
        let cores = ProcessInfo.processInfo.activeProcessorCount
        call.resolve([
            "cores": cores,
            "perfCores": perf > 0 ? Int(perf) : cores,
            "availableMemory": Int(os_proc_available_memory()),
            "physicalMemory": Int(ProcessInfo.processInfo.physicalMemory),
            "thermalState": ProcessInfo.processInfo.thermalState.rawValue,
        ])
    }
}
