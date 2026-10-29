import Foundation
import Capacitor
import CoreML

/// Native Maia-3 inference with pre-compiled CoreML ML Programs bundled in the app.
/// Model inputs and outputs remain Float32, preserving the Capacitor bridge contract.
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
    private static let tokenBytes = 64 * feat * MemoryLayout<Float>.size

    // One model at a time; all access is serialized to avoid concurrent predictions.
    private let queue = DispatchQueue(label: "maia.native", qos: .userInitiated)
    private var model: MLModel?
    private var loaded: String?

    private func modelURL(_ name: String) -> URL? {
        Bundle.main.url(forResource: "maia3-\(name)", withExtension: "mlmodelc", subdirectory: "public/native")
    }

    private func inputArray(_ values: [Float], shape: [NSNumber]) throws -> MLMultiArray {
        let array = try MLMultiArray(shape: shape, dataType: .float32)
        values.withUnsafeBufferPointer { buffer in
            array.dataPointer.copyMemory(from: buffer.baseAddress!, byteCount: buffer.count * MemoryLayout<Float>.size)
        }
        return array
    }

    private func tokenArray(_ data: Data) throws -> MLMultiArray {
        guard data.count == Self.tokenBytes else {
            throw NSError(domain: "maia", code: 1, userInfo: [NSLocalizedDescriptionKey: "bad tokens"])
        }
        let array = try MLMultiArray(shape: [1, 64, Self.feat], dataType: .float32)
        data.withUnsafeBytes { bytes in
            if let base = bytes.baseAddress {
                array.dataPointer.copyMemory(from: base, byteCount: bytes.count)
            }
        }
        return array
    }

    /// Reads logical elements through CoreML element strides. This handles padded/non-contiguous
    /// output buffers and both Float32 and Float16 output types.
    private func readArray(_ feature: MLFeatureValue, name: String) throws -> [Float] {
        guard let array = feature.multiArrayValue else {
            throw NSError(domain: "maia", code: 2, userInfo: [NSLocalizedDescriptionKey: "缺少输出 \(name)"])
        }
        let shape = array.shape.map(\.intValue)
        let strides = array.strides.map(\.intValue)
        guard shape.count == strides.count, !shape.isEmpty, shape.allSatisfy({ $0 > 0 }) else {
            throw NSError(domain: "maia", code: 2, userInfo: [NSLocalizedDescriptionKey: "输出 \(name) 形状异常"])
        }
        let count = shape.reduce(1, *)
        var result = [Float](repeating: 0, count: count)
        for linear in 0..<count {
            var remainder = linear
            var offset = 0
            for dimension in stride(from: shape.count - 1, through: 0, by: -1) {
                let coordinate = remainder % shape[dimension]
                remainder /= shape[dimension]
                offset += coordinate * strides[dimension]
            }
            switch array.dataType {
            case .float32:
                result[linear] = array.dataPointer.load(fromByteOffset: offset * MemoryLayout<Float>.size, as: Float.self)
            case .float16:
                let bits = array.dataPointer.load(fromByteOffset: offset * MemoryLayout<UInt16>.size, as: UInt16.self)
                result[linear] = Float(Float16(bitPattern: bits))
            default:
                throw NSError(domain: "maia", code: 2, userInfo: [NSLocalizedDescriptionKey: "输出 \(name) 类型不支持"])
            }
        }
        return result
    }

    /// Runs the network; returns (move logits, value logits [loss, draw, win]).
    private func run(_ tokens: Data, _ selfElo: Float, _ oppoElo: Float) throws -> ([Float], [Float]) {
        guard let model else {
            throw NSError(domain: "maia", code: 3, userInfo: [NSLocalizedDescriptionKey: "模型尚未加载"])
        }
        let provider = try MLDictionaryFeatureProvider(dictionary: [
            "tokens": MLFeatureValue(multiArray: try tokenArray(tokens)),
            "self_elo": MLFeatureValue(multiArray: try inputArray([selfElo], shape: [1])),
            "oppo_elo": MLFeatureValue(multiArray: try inputArray([oppoElo], shape: [1])),
        ])
        let output = try model.prediction(from: provider)
        guard let moveFeature = output.featureValue(for: "logits_move"),
              let valueFeature = output.featureValue(for: "logits_value") else {
            throw NSError(domain: "maia", code: 2, userInfo: [NSLocalizedDescriptionKey: "缺少模型输出"])
        }
        return (
            try readArray(moveFeature, name: "logits_move"),
            try readArray(valueFeature, name: "logits_value")
        )
    }

    @objc func load(_ call: CAPPluginCall) {
        guard let name = call.getString("model") else { return call.reject("missing model") }
        // Start-position probe from JS: reject a corrupt or incompatible compiled model early.
        let probe = call.getString("probeTokens").flatMap { Data(base64Encoded: $0) }
        let probeLegal = call.getArray("probeLegal", Int.self) ?? []
        let probeTop = Set(call.getArray("probeTop", Int.self) ?? [])
        queue.async { [self] in
            if loaded == name, model != nil { return call.resolve(["provider": "coreml"]) }
            model = nil
            loaded = nil
            guard let url = modelURL(name) else {
                return call.reject("模型 maia3-\(name).mlmodelc 未打包")
            }
            do {
                let config = MLModelConfiguration()
                config.computeUnits = .all
                model = try MLModel(contentsOf: url, configuration: config)
                if let probe, !probeLegal.isEmpty {
                    let (logits, _) = try run(probe, 1500, 1500)
                    guard plausible(logits, probeLegal, probeTop) else {
                        throw NSError(domain: "maia", code: 4, userInfo: [NSLocalizedDescriptionKey: "CoreML 推理结果异常"])
                    }
                }
                loaded = name
                call.resolve(["provider": "coreml"])
            } catch {
                model = nil
                call.reject("Maia 加载失败：\(error.localizedDescription)")
            }
        }
    }

    private func plausible(_ logits: [Float], _ legal: [Int], _ top: Set<Int>) -> Bool {
        guard logits.count == Self.numMoves, logits.allSatisfy({ $0.isFinite }) else { return false }
        let validLegal = legal.filter { $0 >= 0 && $0 < logits.count }
        let l = validLegal.map { logits[$0] }
        guard let mx = l.max(), let i = l.firstIndex(of: mx) else { return false }
        let p = 1 / l.reduce(0) { $0 + exp(Double($1 - mx)) }
        return top.contains(validLegal[i]) && p > 0.2
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
              tokens.count == Self.tokenBytes else { return call.reject("bad tokens") }
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

    /// Several positions in one bridge round trip; the model is batch-1 and runs serially.
    @objc func evalBatch(_ call: CAPPluginCall) {
        guard let items = call.getArray("items", JSObject.self), !items.isEmpty else { return call.reject("missing items") }
        var jobs: [(Data, [Int], Float, Float)] = []
        func num(_ value: Any?) -> Double? { (value as? NSNumber)?.doubleValue ?? (value as? Double) ?? (value as? Int).map(Double.init) }
        for item in items {
            guard let b64 = item["tokens"] as? String, let tokens = Data(base64Encoded: b64),
                  tokens.count == Self.tokenBytes else { return call.reject("bad tokens") }
            let indices = ((item["indices"] as? [Any]) ?? []).compactMap { num($0).map { Int($0) } }
            jobs.append((tokens, indices, Float(num(item["selfElo"]) ?? 1500), Float(num(item["oppoElo"]) ?? 1500)))
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
            model = nil
            loaded = nil
            call.resolve()
        }
    }
}
