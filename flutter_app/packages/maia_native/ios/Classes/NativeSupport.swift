import Flutter
import Foundation
import CoreFoundation

enum NativeRuntimeLog {
    private static let lock = NSLock()
    private static var entries: [String] = []

    static func now() -> UInt64 { DispatchTime.now().uptimeNanoseconds }
    static func milliseconds(_ start: UInt64) -> Double { Double(now() - start) / 1_000_000 }

    static func record(_ message: String, subsystem: String) {
        let line = "\(ISO8601DateFormatter().string(from: Date())) [iOS/\(subsystem)] \(message)"
        lock.lock()
        entries.append(line)
        if entries.count > 500 { entries.removeFirst(entries.count - 500) }
        lock.unlock()
        NSLog("%@", line)
    }

    static func text() -> String {
        lock.lock()
        defer { lock.unlock() }
        return entries.joined(separator: "\n")
    }
}

struct NativeFailure: LocalizedError {
    let code: String
    let message: String
    var errorDescription: String? { message }

    static let cancelled = NativeFailure(code: "cancelled", message: "Native operation cancelled")
    static func invalid(_ message: String) -> NativeFailure {
        NativeFailure(code: "invalid_arguments", message: message)
    }
}

/// Flutter results, including validation failures, are completed once on main.
final class NativeReply {
    private let lock = NSLock()
    private var callback: FlutterResult?

    init(_ callback: @escaping FlutterResult) { self.callback = callback }

    func finish(_ value: Any? = nil) {
        lock.lock()
        let callback = self.callback
        self.callback = nil
        lock.unlock()
        guard let callback else { return }
        if Thread.isMainThread { callback(value) }
        else { DispatchQueue.main.async { callback(value) } }
    }

    func fail(_ error: Error) {
        let failure = error as? NativeFailure
        finish(FlutterError(code: failure?.code ?? "native_error", message: error.localizedDescription, details: nil))
    }
}

enum NativeArguments {
    static func number(_ value: Any?) -> Double? {
        guard let number = value as? NSNumber,
              CFGetTypeID(number) != CFBooleanGetTypeID(), number.doubleValue.isFinite else { return nil }
        return number.doubleValue
    }

    static func indices(_ value: Any?, name: String) throws -> [Int] {
        guard let values = value as? [Any] else { throw NativeFailure.invalid("\(name) must be an integer array") }
        return try values.map {
            guard let n = number($0), n.rounded(.towardZero) == n,
                  n >= Double(Int32.min), n <= Double(Int32.max) else {
                throw NativeFailure.invalid("\(name) must contain integers")
            }
            return Int(n)
        }
    }
}

/// Prefer declared Flutter assets, then the directory-preserving CocoaPods bundle.
final class NativeAssets {
    private let lookup: (String) -> String

    init(lookup: @escaping (String) -> String) { self.lookup = lookup }

    func url(_ relative: String) -> URL? {
        let main = Bundle.main
        let plugin = Bundle(for: MaiaNativePlugin.self)
        var candidates: [URL] = []
        let key = lookup("assets/\(relative)")
        for bundle in [main, plugin] {
            if let root = bundle.resourceURL {
                candidates.append(root.appendingPathComponent(key))
                candidates.append(root.appendingPathComponent("flutter_assets/assets/\(relative)"))
                candidates.append(root.appendingPathComponent("MaiaNativeAssets.bundle/\(relative)"))
            }
        }
        if let frameworks = main.privateFrameworksURL {
            candidates.append(frameworks.appendingPathComponent("App.framework/flutter_assets/assets/\(relative)"))
            candidates.append(frameworks.appendingPathComponent("maia_native.framework/MaiaNativeAssets.bundle/\(relative)"))
        }
        return candidates.first {
            var isDirectory: ObjCBool = false
            guard FileManager.default.fileExists(atPath: $0.path, isDirectory: &isDirectory) else { return false }
            if $0.pathExtension == "mlmodelc" {
                return isDirectory.boolValue && !((try? FileManager.default.contentsOfDirectory(atPath: $0.path)) ?? []).isEmpty
            }
            return !isDirectory.boolValue
        }
    }
}
