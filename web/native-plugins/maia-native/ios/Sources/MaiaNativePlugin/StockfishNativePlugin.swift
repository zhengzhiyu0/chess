import Foundation
import os
import Capacitor
import StockfishFull
import StockfishLite

/// Native Stockfish 19 (full and lite NNUE), compiled into the app with real pthreads and NEON.
/// JS sends UCI commands with `send`; engine output arrives as batched `lines` events.
@objc(StockfishNativePlugin)
public class StockfishNativePlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "StockfishNativePlugin"
    public let jsName = "StockfishNative"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "start", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "send", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "info", returnType: CAPPluginReturnPromise),
    ]

    private static let nets = ["full": "nn-1a298aa575a0", "lite": "nn-61e7af4bb97d"]

    /// Engine output is coalesced and flushed at most every 150ms so a deep search's info stream
    /// doesn't flood the JS bridge; terminal lines (bestmove/readyok/uciok) flush immediately.
    final class Outbox {
        let flavour: String
        weak var plugin: StockfishNativePlugin?
        private var pending: [String] = []
        private let lock = NSLock()
        private var scheduled = false

        init(flavour: String) { self.flavour = flavour }

        func push(_ line: String) {
            lock.lock()
            pending.append(line)
            let urgent = line.hasPrefix("bestmove") || line == "readyok" || line == "uciok"
            let schedule = !urgent && !scheduled
            if schedule { scheduled = true }
            lock.unlock()
            if urgent {
                flush()
            } else if schedule {
                DispatchQueue.global(qos: .userInitiated).asyncAfter(deadline: .now() + .milliseconds(150)) { [weak self] in
                    self?.flush()
                }
            }
        }

        func flush() {
            lock.lock()
            let lines = pending
            pending.removeAll()
            scheduled = false
            lock.unlock()
            guard !lines.isEmpty, let plugin else { return }
            let flavour = flavour
            DispatchQueue.main.async { plugin.notifyListeners("lines", data: ["engine": flavour, "lines": lines]) }
        }
    }

    // the C engines keep raw pointers to these for the life of the process
    private static let outboxes = ["full": Outbox(flavour: "full"), "lite": Outbox(flavour: "lite")]
    private var started = Set<String>()

    private static let onLine: @convention(c) (UnsafeMutableRawPointer?, UnsafePointer<CChar>) -> Void = { ctx, line in
        guard let ctx else { return }
        Unmanaged<Outbox>.fromOpaque(ctx).takeUnretainedValue().push(String(cString: line))
    }

    private func flavour(_ call: CAPPluginCall) -> String? {
        let f = call.getString("engine") ?? "full"
        return Self.nets[f] != nil ? f : nil
    }

    @objc func start(_ call: CAPPluginCall) {
        guard let f = flavour(call), let box = Self.outboxes[f], let netName = Self.nets[f] else {
            return call.reject("unknown engine")
        }
        guard let net = Bundle.main.path(forResource: netName, ofType: "nnue", inDirectory: "public/native") else {
            return call.reject("network \(netName).nnue is missing from the app bundle")
        }
        box.plugin = self
        let ctx = Unmanaged.passUnretained(box).toOpaque()
        net.withCString { path in
            if f == "full" { sf_full_start(path, Self.onLine, ctx) } else { sf_lite_start(path, Self.onLine, ctx) }
        }
        started.insert(f)
        call.resolve()
    }

    @objc func send(_ call: CAPPluginCall) {
        guard let f = flavour(call), started.contains(f) else { return call.reject("engine not started") }
        guard let cmd = call.getString("cmd") else { return call.reject("missing cmd") }
        cmd.withCString { if f == "full" { sf_full_send($0) } else { sf_lite_send($0) } }
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
