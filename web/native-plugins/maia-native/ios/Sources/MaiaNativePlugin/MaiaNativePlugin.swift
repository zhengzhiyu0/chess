import Foundation
import Capacitor
import OnnxRuntimeBindings

/// Native Maia-3 inference with ONNX Runtime for iOS. The CoreML execution provider runs the
/// network on the Neural Engine / GPU where possible; unsupported ops fall back to ORT's NEON CPU
/// kernels. Models are the same .onnx files the web build uses, bundled in the app.
@objc(MaiaNativePlugin)
public class MaiaNativePlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "MaiaNativePlugin"
    public let jsName = "MaiaNative"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "load", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "eval", returnType: CAPPluginReturnPromise),
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

    private func modelPath(_ model: String) -> String? {
        Bundle.main.path(forResource: "maia3-\(model)", ofType: "onnx", inDirectory: "public/native")
    }

    private func makeSession(_ path: String, coreml: Bool) throws -> ORTSession {
        if env == nil { env = try ORTEnv(loggingLevel: .warning) }
        let opts = try ORTSessionOptions()
        try opts.setGraphOptimizationLevel(.all)
        try opts.setIntraOpNumThreads(Int32(max(1, min(4, ProcessInfo.processInfo.activeProcessorCount - 2))))
        if coreml {
            let cache = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
                .appendingPathComponent("coreml", isDirectory: true)
            try? FileManager.default.createDirectory(at: cache, withIntermediateDirectories: true)
            try opts.appendCoreMLExecutionProvider(withOptionsV2: [
                "MLComputeUnits": "All",
                "ModelFormat": "MLProgram",
                "RequireStaticInputShapes": "0",
                "ModelCacheDirectory": cache.path,
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
                let logits = indices.map { $0 >= 0 && $0 < all.count ? Double(all[$0]) : -1e9 }
                call.resolve([
                    "logits": logits,
                    "value": v.prefix(3).map(Double.init),
                    "ms": (CFAbsoluteTimeGetCurrent() - t0) * 1000,
                ])
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
