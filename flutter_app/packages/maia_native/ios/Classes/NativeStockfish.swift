import Foundation
import Flutter
import Darwin
import os
import StockfishFull
#if !MAIA_STOCKFISH_FULL_ONLY
import StockfishLite
#endif

final class NativeStockfish {
    private let assets: NativeAssets
    private var sink: FlutterEventSink?
    private var subscription = UUID()
    private var background = false

    private static let networks: [String: String] = {
#if MAIA_STOCKFISH_FULL_ONLY
        return ["full": "nn-1a298aa575a0.nnue"]
#else
        return ["full": "nn-1a298aa575a0.nnue", "lite": "nn-61e7af4bb97d.nnue"]
#endif
    }()

    /// C callbacks retain raw pointers for the process lifetime. Never give them
    /// an instance owned by a Flutter engine (hot restart can dispose that engine).
    private static let outboxes: [String: Outbox] = {
        Dictionary(uniqueKeysWithValues: networks.keys.map { ($0, Outbox(engine: $0)) })
    }()

    private final class Outbox {
        let engine: String
        private let lock = NSLock()
        private var pending: [String] = []
        private var timer: UInt64 = 0
        private var scheduled = false
        private var started = false
        private var enabled = false
        private var epoch = UUID()
        private var startup: UInt64?
        // Owner is set/read on main only. All output is delivered on main too.
        weak var owner: NativeStockfish?

        init(engine: String) { self.engine = engine }

        var hasStarted: Bool {
            lock.lock()
            defer { lock.unlock() }
            return started
        }

        func begin() -> Bool {
            lock.lock()
            defer { lock.unlock() }
            let reused = started
            if !started { startup = NativeRuntimeLog.now() }
            started = true
            return reused
        }

        func bind(_ owner: NativeStockfish?, epoch: UUID) {
            self.owner = owner
            lock.lock()
            self.epoch = epoch
            enabled = owner != nil
            pending.removeAll()
            timer &+= 1
            scheduled = false
            lock.unlock()
        }

        func push(_ line: String) {
            lock.lock()
            if line.hasPrefix("bestmove") || line.contains("CRITICAL ERROR") {
                NativeRuntimeLog.record("engine=\(engine) \(line)", subsystem: "Stockfish")
            }
            if line == "uciok", let startup {
                NativeRuntimeLog.record("uciok engine=\(engine) startup_handshake_ms=\(NativeRuntimeLog.milliseconds(startup)) includes=initialization/NNUE", subsystem: "Stockfish")
                self.startup = nil
            }
            guard enabled else { lock.unlock(); return }
            pending.append(line)
            let urgent = line.hasPrefix("bestmove") || line == "readyok" || line == "uciok"
            if urgent {
                flushLocked()
            } else if !scheduled {
                scheduled = true
                timer &+= 1
                let ticket = timer
                DispatchQueue.global(qos: .userInitiated).asyncAfter(deadline: .now() + .milliseconds(150)) { [weak self] in
                    guard let self else { return }
                    self.lock.lock()
                    defer { self.lock.unlock() }
                    if self.scheduled && self.timer == ticket { self.flushLocked() }
                }
            }
            lock.unlock()
        }

        /// Must enqueue on main while holding the lock, so timer and urgent
        /// flushes cannot reverse two batches from concurrent search threads.
        private func flushLocked() {
            let lines = pending
            pending.removeAll(keepingCapacity: true)
            scheduled = false
            timer &+= 1
            let epoch = self.epoch
            guard !lines.isEmpty else { return }
            DispatchQueue.main.async { [weak self] in
                guard let self else { return }
                self.owner?.emit(engine: self.engine, lines: lines, epoch: epoch)
            }
        }
    }

    private static let onLine: @convention(c) (UnsafeMutableRawPointer?, UnsafePointer<CChar>) -> Void = { context, line in
        guard let context else { return }
        Unmanaged<Outbox>.fromOpaque(context).takeUnretainedValue().push(String(cString: line))
    }

    init(assets: NativeAssets) { self.assets = assets }

    private func flavour(_ args: [String: Any]) throws -> String {
        let engine = args["engine"] as? String ?? "full"
        guard Self.networks[engine] != nil else {
            throw NativeFailure(code: "engine_unavailable", message: "Stockfish \(engine) is not included in this native profile")
        }
        return engine
    }

    func start(_ args: [String: Any], reply: NativeReply) {
        do {
            guard !background else { throw NativeFailure.cancelled }
            let engine = try flavour(args)
            guard let name = Self.networks[engine], let box = Self.outboxes[engine],
                  let net = assets.url("native/\(name)") else {
                throw NativeFailure(code: "network_missing", message: "Stockfish NNUE network is not bundled")
            }
            let reused = box.begin()
            let context = Unmanaged.passUnretained(box).toOpaque()
            net.path.withCString { path in
                if engine == "full" { sf_full_start(path, Self.onLine, context); return }
#if !MAIA_STOCKFISH_FULL_ONLY
                sf_lite_start(path, Self.onLine, context)
#endif
            }
            NativeRuntimeLog.record("start dispatched engine=\(engine) reused=\(reused) ready=pending_uci", subsystem: "Stockfish")
            reply.finish()
        } catch {
            NativeRuntimeLog.record("start failed: \(error.localizedDescription)", subsystem: "Stockfish")
            reply.fail(error)
        }
    }

    private func sendCommand(_ command: String, engine: String) {
        command.withCString {
            if engine == "full" { sf_full_send($0); return }
#if !MAIA_STOCKFISH_FULL_ONLY
            sf_lite_send($0)
#endif
        }
    }

    func send(_ args: [String: Any], reply: NativeReply) {
        do {
            let engine = try flavour(args)
            guard Self.outboxes[engine]?.hasStarted == true else {
                throw NativeFailure(code: "engine_not_started", message: "Stockfish \(engine) is not started")
            }
            guard let raw = args["cmd"] as? String, !raw.isEmpty, raw.utf8.count <= 65536,
                  !raw.contains("\0"), !raw.contains("\n"), !raw.contains("\r") else {
                throw NativeFailure.invalid("cmd must be one UCI line")
            }
            let command = raw.trimmingCharacters(in: .whitespaces)
            guard !command.isEmpty else { throw NativeFailure.invalid("cmd is empty") }
            // Embedded engines are process-lived; quit is a cancellation request.
            let effective = command == "quit" ? "stop" : command
            guard !background || effective == "stop" else { throw NativeFailure.cancelled }
            sendCommand(effective, engine: engine)
            reply.finish()
        } catch { reply.fail(error) }
    }

    func listen(_ sink: @escaping FlutterEventSink) {
        subscription = UUID()
        self.sink = sink
        for box in Self.outboxes.values { box.bind(self, epoch: subscription) }
    }

    private func emit(engine: String, lines: [String], epoch: UUID) {
        guard epoch == subscription else { return }
        sink?(["engine": engine, "lines": lines])
    }

    private func stopAll() {
        for (engine, box) in Self.outboxes where box.hasStarted { sendCommand("stop", engine: engine) }
    }

    func cancel() {
        subscription = UUID()
        sink = nil
        for box in Self.outboxes.values where box.owner === self { box.bind(nil, epoch: subscription) }
        stopAll()
        NativeRuntimeLog.record("event subscription cancelled; searches stopped", subsystem: "Stockfish")
    }

    func enterBackground() { background = true; stopAll() }
    func leaveBackground() { background = false }

    func deviceInfo() -> [String: Any] {
#if MAIA_STOCKFISH_FULL_ONLY
        let profile = "79m-full"
#else
        let profile = "all"
#endif
        var perf: Int32 = 0
        var size = MemoryLayout<Int32>.size
        if sysctlbyname("hw.perflevel0.physicalcpu", &perf, &size, nil, 0) != 0 { perf = 0 }
        let process = ProcessInfo.processInfo
        let cores = process.activeProcessorCount
        return [
            "nativeProfile": profile,
            "cores": cores,
            "perfCores": perf > 0 ? Int(perf) : cores,
            "availableMemory": Int(os_proc_available_memory()),
            "physicalMemory": Int(process.physicalMemory),
            "thermalState": process.thermalState.rawValue,
        ]
    }
}
