import CoreML
import Foundation

/// Model load, probe and predictions share one queue; no concurrent MLModel use.
final class NativeMaia {
    private static let tokenBytes = 64 * 96 * MemoryLayout<Float>.size
    private static let numMoves = 4352
    private let assets: NativeAssets
    private let queue = DispatchQueue(label: "maia.flutter.coreml", qos: .userInitiated)
    private var model: MLModel?
    private var loaded: String?
    private let stateLock = NSLock()
    private var generation: UInt64 = 0
    private var nextID: UInt64 = 0
    private var background = false
    private var pending: [UInt64: NativeReply] = [:]
    private var releaseWork: DispatchWorkItem?
    private var backgroundSince: UInt64?

    private struct Operation {
        let id: UInt64
        let generation: UInt64
        let reply: NativeReply
    }

    private struct Job {
        let tokens: Data
        let indices: [Int]
        let selfElo: Float
        let oppoElo: Float

        init(_ args: [String: Any]) throws {
            tokens = try NativeMaia.decodeTokens(args["tokens"])
            indices = try NativeArguments.indices(args["indices"] ?? [], name: "indices")
            func elo(_ name: String) throws -> Float {
                if args[name] == nil { return 1500 }
                guard let value = NativeArguments.number(args[name]), Float(value).isFinite else {
                    throw NativeFailure.invalid("\(name) must be finite")
                }
                return Float(value)
            }
            selfElo = try elo("selfElo")
            oppoElo = try elo("oppoElo")
        }
    }

    init(assets: NativeAssets) { self.assets = assets }

    private func begin(_ reply: NativeReply) -> Operation? {
        stateLock.lock()
        guard !background else {
            stateLock.unlock()
            reply.fail(NativeFailure.cancelled)
            return nil
        }
        nextID &+= 1
        let operation = Operation(id: nextID, generation: generation, reply: reply)
        pending[operation.id] = reply
        stateLock.unlock()
        return operation
    }

    private func check(_ operation: Operation) throws {
        stateLock.lock()
        let valid = !background && operation.generation == generation
        stateLock.unlock()
        if !valid { throw NativeFailure.cancelled }
    }

    private func finish(_ operation: Operation, value: Any? = nil, error: Error? = nil) {
        // Recheck on main: background/unload may arrive after prediction finishes
        // but before Flutter is allowed to consume the queued result.
        DispatchQueue.main.async { [self] in
            stateLock.lock()
            let valid = !background && operation.generation == generation
            pending.removeValue(forKey: operation.id)
            stateLock.unlock()
            if !valid { operation.reply.fail(NativeFailure.cancelled) }
            else if let error { operation.reply.fail(error) }
            else { operation.reply.finish(value) }
        }
    }

    private static func decodeTokens(_ value: Any?) throws -> Data {
        guard let b64 = value as? String, let data = Data(base64Encoded: b64), data.count == tokenBytes else {
            throw NativeFailure.invalid("tokens must be base64 Float32[1,64,96] (24576 bytes)")
        }
        // Float32 token input must be finite too; malformed bytes cannot poison a model probe.
        let finite = data.withUnsafeBytes { bytes in
            stride(from: 0, to: bytes.count, by: 4).allSatisfy {
                Float(bitPattern: UInt32(littleEndian: bytes.loadUnaligned(fromByteOffset: $0, as: UInt32.self))).isFinite
            }
        }
        guard finite else { throw NativeFailure.invalid("tokens contain non-finite Float32 values") }
        return data
    }

    private func input(_ values: [Float], shape: [NSNumber]) throws -> MLMultiArray {
        let array = try MLMultiArray(shape: shape, dataType: .float32)
        values.withUnsafeBufferPointer { buffer in
            if let base = buffer.baseAddress {
                array.dataPointer.copyMemory(from: base, byteCount: buffer.count * MemoryLayout<Float>.size)
            }
        }
        return array
    }

    private func tokenArray(_ data: Data) throws -> MLMultiArray {
        let array = try MLMultiArray(shape: [1, 64, 96], dataType: .float32)
        data.withUnsafeBytes { bytes in
            if let base = bytes.baseAddress { array.dataPointer.copyMemory(from: base, byteCount: bytes.count) }
        }
        return array
    }

    /// Read logical elements using strides, including padded Float16 ANE outputs.
    private func readArray(_ feature: MLFeatureValue?, name: String, expected: Int) throws -> [Float] {
        guard let array = feature?.multiArrayValue,
              array.count == expected, array.shape.map(\.intValue) == [1, expected] else {
            throw NativeFailure(code: "invalid_model_output", message: "Invalid \(name) shape")
        }
        let shape = array.shape.map(\.intValue)
        let strides = array.strides.map(\.intValue)
        guard shape.count == strides.count, strides.allSatisfy({ $0 >= 0 }) else {
            throw NativeFailure(code: "invalid_model_output", message: "Invalid \(name) strides")
        }
        var values = [Float](repeating: 0, count: expected)
        for linear in 0..<expected {
            var remainder = linear
            var offset = 0
            for dimension in stride(from: shape.count - 1, through: 0, by: -1) {
                offset += (remainder % shape[dimension]) * strides[dimension]
                remainder /= shape[dimension]
            }
            switch array.dataType {
            case .float32:
                values[linear] = array.dataPointer.load(fromByteOffset: offset * 4, as: Float.self)
            case .float16:
                let bits = array.dataPointer.load(fromByteOffset: offset * 2, as: UInt16.self)
                values[linear] = Float(Float16(bitPattern: bits))
            default:
                throw NativeFailure(code: "invalid_model_output", message: "Unsupported \(name) data type")
            }
        }
        guard values.allSatisfy({ $0.isFinite }) else {
            throw NativeFailure(code: "invalid_model_output", message: "Non-finite \(name) logits")
        }
        return values
    }

    private func run(_ tokens: Data, selfElo: Float, oppoElo: Float) throws -> ([Float], [Float]) {
        guard let model else { throw NativeFailure(code: "model_not_loaded", message: "Maia model is not loaded") }
        let provider = try MLDictionaryFeatureProvider(dictionary: [
            "tokens": MLFeatureValue(multiArray: try tokenArray(tokens)),
            "self_elo": MLFeatureValue(multiArray: try input([selfElo], shape: [1])),
            "oppo_elo": MLFeatureValue(multiArray: try input([oppoElo], shape: [1])),
        ])
        let output = try model.prediction(from: provider)
        return (
            try readArray(output.featureValue(for: "logits_move"), name: "logits_move", expected: Self.numMoves),
            try readArray(output.featureValue(for: "logits_value"), name: "logits_value", expected: 3)
        )
    }

    private func plausible(_ logits: [Float], legal: [Int], top: Set<Int>) -> Bool {
        let values = legal.map { logits[$0] }
        guard let maximum = values.max(), let index = values.firstIndex(of: maximum) else { return false }
        let probability = 1 / values.reduce(0.0) { $0 + exp(Double($1 - maximum)) }
        return top.contains(legal[index]) && probability > 0.2
    }

    func load(_ args: [String: Any], reply: NativeReply) {
        do {
            guard let name = args["model"] as? String, ["5m", "23m", "79m"].contains(name) else {
                throw NativeFailure.invalid("model must be 5m, 23m or 79m")
            }
            var probe: Data?
            var legal: [Int] = []
            var top = Set<Int>()
            if args["probeTokens"] != nil || args["probeLegal"] != nil || args["probeTop"] != nil {
                probe = try Self.decodeTokens(args["probeTokens"])
                legal = try NativeArguments.indices(args["probeLegal"], name: "probeLegal")
                top = Set(try NativeArguments.indices(args["probeTop"], name: "probeTop"))
                guard !legal.isEmpty, !top.isEmpty,
                      legal.allSatisfy({ $0 >= 0 && $0 < Self.numMoves }), top.isSubset(of: Set(legal)) else {
                    throw NativeFailure.invalid("probeLegal/probeTop must contain legal policy indices")
                }
            }
            guard let operation = begin(reply) else { return }
            // Capture immutable probe data; every model operation remains on the same queue.
            let probeData = probe ?? Data(repeating: 0, count: Self.tokenBytes)
            let probeLegal = legal
            let probeTop = top
            let start = NativeRuntimeLog.now()
            queue.async { [self] in
                var stage = "resource"
                do {
                    try check(operation)
                    let reused = loaded == name && model != nil
                    NativeRuntimeLog.record("load model=\(name) reused=\(reused) computeUnits=all", subsystem: "Maia")
                    if !reused {
                        model = nil
                        loaded = nil
                        guard let url = assets.url("native/maia3-\(name).mlmodelc") else {
                            throw NativeFailure(code: "model_missing", message: "maia3-\(name).mlmodelc is not bundled")
                        }
                        stage = "MLModel"
                        let config = MLModelConfiguration()
                        config.computeUnits = .all
                        model = try MLModel(contentsOf: url, configuration: config)
                        try check(operation)
                    }
                    stage = "probe"
                    let (logits, _) = try run(probeData, selfElo: 1500, oppoElo: 1500)
                    try check(operation)
                    if !probeLegal.isEmpty && !plausible(logits, legal: probeLegal, top: probeTop) {
                        throw NativeFailure(code: "model_probe_failed", message: "CoreML start-position probe failed")
                    }
                    loaded = name
                    NativeRuntimeLog.record("load success model=\(name) total_ms=\(NativeRuntimeLog.milliseconds(start))", subsystem: "Maia")
                    finish(operation, value: ["provider": "coreml"])
                } catch {
                    model = nil
                    loaded = nil
                    NativeRuntimeLog.record("load failed model=\(name) stage=\(stage) total_ms=\(NativeRuntimeLog.milliseconds(start)) error=\(error.localizedDescription)", subsystem: "Maia")
                    finish(operation, error: error)
                }
            }
        } catch { reply.fail(error) }
    }

    private func predict(_ job: Job, operation: Operation) throws -> [String: Any] {
        try check(operation)
        let start = NativeRuntimeLog.now()
        let (all, value) = try run(job.tokens, selfElo: job.selfElo, oppoElo: job.oppoElo)
        try check(operation)
        return [
            "logits": job.indices.map { $0 >= 0 && $0 < all.count ? Double(all[$0]) : -1e9 },
            "value": value.map(Double.init),
            "ms": NativeRuntimeLog.milliseconds(start),
        ]
    }

    func eval(_ args: [String: Any], reply: NativeReply) {
        do {
            let job = try Job(args)
            guard let operation = begin(reply) else { return }
            queue.async { [self] in
                do { finish(operation, value: try predict(job, operation: operation)) }
                catch {
                    NativeRuntimeLog.record("eval failed: \(error.localizedDescription)", subsystem: "Maia")
                    finish(operation, error: error)
                }
            }
        } catch { reply.fail(error) }
    }

    func evalBatch(_ args: [String: Any], reply: NativeReply) {
        do {
            guard let items = args["items"] as? [[String: Any]], !items.isEmpty else {
                throw NativeFailure.invalid("items must be a non-empty array")
            }
            let jobs = try items.map { try Job($0) }
            guard let operation = begin(reply) else { return }
            queue.async { [self] in
                do {
                    var results: [[String: Any]] = []
                    for job in jobs { results.append(try predict(job, operation: operation)) }
                    finish(operation, value: ["results": results])
                } catch {
                    NativeRuntimeLog.record("evalBatch failed: \(error.localizedDescription)", subsystem: "Maia")
                    finish(operation, error: error)
                }
            }
        } catch { reply.fail(error) }
    }

    /// CoreML's synchronous prediction cannot be preempted. Reject outstanding
    /// Flutter calls now; discard its result and skip remaining batch items later.
    private func cancelPending(background newBackground: Bool? = nil) -> UInt64 {
        stateLock.lock()
        generation &+= 1
        if let newBackground { background = newBackground }
        let replies = Array(pending.values)
        pending.removeAll()
        let ticket = generation
        stateLock.unlock()
        for reply in replies { reply.fail(NativeFailure.cancelled) }
        return ticket
    }

    func unload(reply: NativeReply) {
        releaseWork?.cancel()
        _ = cancelPending()
        queue.async { [self] in
            model = nil
            loaded = nil
            NativeRuntimeLog.record("unloaded", subsystem: "Maia")
            reply.finish()
        }
    }

    func cancelAndRelease() {
        releaseWork?.cancel()
        _ = cancelPending()
        queue.async { [self] in model = nil; loaded = nil }
    }

    func enterBackground() {
        let ticket = cancelPending(background: true)
        stateLock.lock()
        backgroundSince = NativeRuntimeLog.now()
        stateLock.unlock()
        releaseWork?.cancel()
        let work = DispatchWorkItem { [weak self] in
            guard let self else { return }
            self.queue.async { [self] in
                stateLock.lock()
                let release = background && generation == ticket
                stateLock.unlock()
                if release {
                    model = nil
                    loaded = nil
                    NativeRuntimeLog.record("released after 10s in background", subsystem: "Maia")
                }
            }
        }
        releaseWork = work
        DispatchQueue.main.asyncAfter(deadline: .now() + 10, execute: work)
    }

    func leaveBackground() {
        releaseWork?.cancel()
        releaseWork = nil
        stateLock.lock()
        let release = backgroundSince.map { NativeRuntimeLog.milliseconds($0) >= 10_000 } ?? false
        backgroundSince = nil
        background = false
        // iOS can suspend before the delayed release runs. Preserve short-switch
        // warmth; on a long switch release before any resumed inference/load.
        if release { queue.async { [self] in model = nil; loaded = nil } }
        stateLock.unlock()
    }
}
