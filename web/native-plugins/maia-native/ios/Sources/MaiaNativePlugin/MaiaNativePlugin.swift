import Foundation
import os
import Capacitor
import OnnxRuntimeBindings

/// Native Maia-3 inference with ONNX Runtime for iOS. The app ships its own export of each model
/// (tools/export_onnx.py --targets native): batch fixed to 1 and fp16 throughout, so the CoreML
/// execution provider can compile the whole graph for the Neural Engine. Ops CoreML can't take
/// fall back to ORT's CPU kernels.
@objc(MaiaNativePlugin)
public class MaiaNativePlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "MaiaNativePlugin"
    public let jsName = "MaiaNative"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "load", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "eval", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "evalBatch", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "unload", returnType: CAPPluginReturnPromise),
    ]

    private static let feat = 96
    private static let numMoves = 64 * 64 + 8 * 8 * 4

    // one session at a time, all access on this serial queue
    private let queue = DispatchQueue(label: "maia.native", qos: .userInitiated)
    private var env: ORTEnv?
    private var session: ORTSession?
    private var loaded: String?
    private var provider = "cpu"
    private var cachePruned = false

    private func modelPath(_ model: String) -> String? {
        Bundle.main.path(forResource: "maia3-\(model)", ofType: "onnx", inDirectory: "public/native")
    }

    private static var cacheDir: URL {
        FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0].appendingPathComponent("coreml", isDirectory: true)
    }

    /// Compiled CoreML models are cached per COREML_CACHE_KEY (stable across app updates). Keys of
    /// models no longer in the bundle are from older app versions: delete them, they can be 100s of MB.
    private func pruneCache() {
        guard !cachePruned else { return }
        cachePruned = true
        guard let list = Bundle.main.path(forResource: "maia-models", ofType: "json", inDirectory: "public/native"),
              let data = FileManager.default.contents(atPath: list),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let keys = (json["cacheKeys"] as? [String: String]).map({ Set($0.values) }), !keys.isEmpty,
              let entries = try? FileManager.default.contentsOfDirectory(atPath: Self.cacheDir.path) else { return }
        for e in entries where !keys.contains(e) {
            try? FileManager.default.removeItem(at: Self.cacheDir.appendingPathComponent(e))
        }
    }

    /// Rough peak for loading: the fp16 weights in ORT, CoreML's compiled copy, and CoreML's
    /// compile-time working set on first load. Refusing up front beats being killed by jetsam.
    private func memoryCheck(_ path: String) -> String? {
        let size = (try? FileManager.default.attributesOfItem(atPath: path)[.size] as? Int) ?? 0
        let need = size * 3 + 150 << 20
        let avail = Int(os_proc_available_memory())
        guard avail > 0, avail < need else { return nil }
        return "可用内存不足（需约 \(need >> 20)MB，剩余 \(avail >> 20)MB），请改用更小的 Maia 模型或 Stockfish 轻量版"
    }

    private func makeSession(_ path: String, coreml: Bool) throws -> ORTSession {
        if env == nil { env = try ORTEnv(loggingLevel: .warning) }
        let opts = try ORTSessionOptions()
        try opts.setGraphOptimizationLevel(.all)
        // with CoreML the CPU only runs leftover glue ops; don't compete with Stockfish's threads
        let cpuThreads = max(1, min(4, ProcessInfo.processInfo.activeProcessorCount - 2))
        try opts.setIntraOpNumThreads(Int32(coreml ? 1 : cpuThreads))
        if coreml {
            pruneCache()
            try? FileManager.default.createDirectory(at: Self.cacheDir, withIntermediateDirectories: true)
            // values are case-sensitive: ORT 1.24 rejects "All", which silently fell back to CPU
            try opts.appendCoreMLExecutionProvider(withOptionsV2: [
                "MLComputeUnits": "ALL",
                "ModelFormat": "MLProgram",
                "RequireStaticInputShapes": "1",
                "SpecializationStrategy": "FastPrediction",
                "ModelCacheDirectory": Self.cacheDir.path,
            ])
        }
        return try ORTSession(env: env!, modelPath: path, sessionOptions: opts)
    }

    private func tensor(_ data: Data, _ shape: [NSNumber]) throws -> ORTValue {
        try ORTValue(tensorData: NSMutableData(data: data), elementType: .float, shape: shape)
    }

    private func floats(_ values: [Float]) -> Data { values.withUnsafeBufferPointer { Data(buffer: $0) } }

    /// Runs the network; returns (move logits, value logits [loss, draw, win]).
    private func run(_ tokens: Data, _ selfElo: Float, _ oppoElo: Float) throws -> ([Float], [Float]) {
        guard let session else { throw NSError(domain: "maia", code: 1, userInfo: [NSLocalizedDescriptionKey: "模型尚未加载"]) }
        let out = try session.run(
            withInputs: [
                "tokens": try tensor(tokens, [1, 64, NSNumber(value: Self.feat)]),
                "self_elo": try tensor(floats([selfElo]), [1]),
                "oppo_elo": try tensor(floats([oppoElo]), [1]),
            ],
            outputNames: ["logits_move", "logits_value"],
            runOptions: nil)
        func read(_ name: String) throws -> [Float] {
            guard let v = out[name] else { throw NSError(domain: "maia", code: 2, userInfo: [NSLocalizedDescriptionKey: "缺少输出 \(name)"]) }
            let d = try v.tensorData() as Data
            return d.withUnsafeBytes { Array($0.bindMemory(to: Float.self)) }
        }
        return (try read("logits_move"), try read("logits_value"))
    }

    @objc func load(_ call: CAPPluginCall) {
        guard let model = call.getString("model") else { return call.reject("missing model") }
        // start-position probe from JS: a backend that compiles but computes garbage must be rejected
        let probe = call.getString("probeTokens").flatMap { Data(base64Encoded: $0) }
        let probeLegal = call.getArray("probeLegal", Int.self) ?? []
        let probeTop = Set(call.getArray("probeTop", Int.self) ?? [])
        queue.async { [self] in
            if loaded == model, session != nil { return call.resolve(["provider": provider]) }
            session = nil
            loaded = nil
            guard let path = modelPath(model) else { return call.reject("模型 maia3-\(model).onnx 未打包") }
            if let err = memoryCheck(path) { return call.reject(err) }
            var errors: [String] = []
            for coreml in [true, false] {
                do {
                    session = try makeSession(path, coreml: coreml)
                    provider = coreml ? "coreml" : "cpu"
                    if let probe, !probeLegal.isEmpty {
                        let (logits, _) = try run(probe, 1500, 1500)
                        guard plausible(logits, probeLegal, probeTop) else { throw NSError(domain: "maia", code: 3, userInfo: [NSLocalizedDescriptionKey: "\(provider) 推理结果异常"]) }
                    }
                    loaded = model
                    return call.resolve(["provider": provider])
                } catch {
                    session = nil
                    errors.append("\(coreml ? "CoreML" : "CPU"): \(error.localizedDescription)")
                }
            }
            call.reject("Maia 加载失败：" + errors.joined(separator: "；"))
        }
    }

    private func plausible(_ logits: [Float], _ legal: [Int], _ top: Set<Int>) -> Bool {
        guard logits.count == Self.numMoves, logits.allSatisfy({ $0.isFinite }) else { return false }
        let l = legal.map { logits[$0] }
        guard let mx = l.max(), let i = l.firstIndex(of: mx) else { return false }
        let p = 1 / l.reduce(0) { $0 + exp(Double($1 - mx)) }
        return top.contains(legal[i]) && p > 0.2
    }

    private func pick(_ all: [Float], _ v: [Float], _ indices: [Int], _ ms: Double) -> [String: Any] {
        [
            "logits": indices.map { $0 >= 0 && $0 < all.count ? Double(all[$0]) : -1e9 },
            "value": v.prefix(3).map(Double.init),
            "ms": ms,
        ]
    }

    @objc func eval(_ call: CAPPluginCall) {
        guard let b64 = call.getString("tokens"), let tokens = Data(base64Encoded: b64),
              tokens.count == 64 * Self.feat * 4 else { return call.reject("bad tokens") }
        let indices = call.getArray("indices", Int.self) ?? []
        let selfElo = Float(call.getDouble("selfElo") ?? 1500)
        let oppoElo = Float(call.getDouble("oppoElo") ?? 1500)
        queue.async { [self] in
            do {
                let t0 = CFAbsoluteTimeGetCurrent()
                let (all, v) = try run(tokens, selfElo, oppoElo)
                call.resolve(pick(all, v, indices, (CFAbsoluteTimeGetCurrent() - t0) * 1000))
            } catch {
                call.reject(error.localizedDescription)
            }
        }
    }

    /// Several positions in one bridge round trip (the model is batch-1: CoreML compiles static
    /// shapes for the Neural Engine, so they run back to back on the native side).
    @objc func evalBatch(_ call: CAPPluginCall) {
        guard let items = call.getArray("items", JSObject.self), !items.isEmpty else { return call.reject("missing items") }
        var jobs: [(Data, [Int], Float, Float)] = []
        func num(_ v: Any?) -> Double? { (v as? NSNumber)?.doubleValue ?? (v as? Double) ?? (v as? Int).map(Double.init) }
        for it in items {
            guard let b64 = it["tokens"] as? String, let tokens = Data(base64Encoded: b64),
                  tokens.count == 64 * Self.feat * 4 else { return call.reject("bad tokens") }
            let indices = ((it["indices"] as? [Any]) ?? []).compactMap { num($0).map { Int($0) } }
            jobs.append((tokens, indices, Float(num(it["selfElo"]) ?? 1500), Float(num(it["oppoElo"]) ?? 1500)))
        }
        queue.async { [self] in
            do {
                var results: [[String: Any]] = []
                for (tokens, indices, selfElo, oppoElo) in jobs {
                    let t0 = CFAbsoluteTimeGetCurrent()
                    let (all, v) = try run(tokens, selfElo, oppoElo)
                    results.append(pick(all, v, indices, (CFAbsoluteTimeGetCurrent() - t0) * 1000))
                }
                call.resolve(["results": results])
            } catch {
                call.reject(error.localizedDescription)
            }
        }
    }

    @objc func unload(_ call: CAPPluginCall) {
        queue.async { [self] in
            session = nil
            loaded = nil
            call.resolve()
        }
    }
}
