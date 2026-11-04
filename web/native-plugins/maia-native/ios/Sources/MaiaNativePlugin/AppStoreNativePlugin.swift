import Foundation
import Capacitor
import SQLite3

private let sqliteTransient = unsafeBitCast(-1, to: sqlite3_destructor_type.self)

/// Small durable SQLite store for app state. JSON remains the domain format, while SQLite gives
/// atomic writes, WAL durability and avoids WebView localStorage quotas and synchronous blocking.
@objc(AppStoreNativePlugin)
public class AppStoreNativePlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "AppStoreNativePlugin"
    public let jsName = "AppStoreNative"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "bootstrap", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "set", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "remove", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "writeBatch", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "saveCheckpoint", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "loadCheckpoint", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "clear", returnType: CAPPluginReturnPromise),
    ]

    private let queue = DispatchQueue(label: "maia.app-store", qos: .utility)
    private var db: OpaquePointer?

    override public func load() {
        queue.sync {
            do { try open() }
            catch { NSLog("AppStore open failed: %@", error.localizedDescription) }
        }
    }

    deinit { if let db { sqlite3_close(db) } }

    private func open() throws {
        // sqlite3_open_v2 may leave a non-nil error handle; failed setup must never count as open.
        var ready = false
        defer { if !ready { if let db { sqlite3_close(db) }; db = nil } }
        let fm = FileManager.default
        let dir = try fm.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
            .appendingPathComponent("MaiaCoach", isDirectory: true)
        try fm.createDirectory(at: dir, withIntermediateDirectories: true)
        let url = dir.appendingPathComponent("store.sqlite")
        guard sqlite3_open_v2(url.path, &db, SQLITE_OPEN_CREATE | SQLITE_OPEN_READWRITE | SQLITE_OPEN_FULLMUTEX, nil) == SQLITE_OK else {
            throw NSError(domain: "AppStore", code: 1, userInfo: [NSLocalizedDescriptionKey: errorMessage()])
        }
        try exec("PRAGMA journal_mode=WAL;")
        try exec("PRAGMA synchronous=NORMAL;")
        try exec("PRAGMA busy_timeout=5000;")
        try exec("CREATE TABLE IF NOT EXISTS documents (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL, updated_at REAL NOT NULL);")
        try exec("CREATE TABLE IF NOT EXISTS game_checkpoint (id INTEGER PRIMARY KEY CHECK(id=1), value TEXT NOT NULL, updated_at REAL NOT NULL);")
        ready = true
    }

    private func errorMessage() -> String {
        guard let db, let c = sqlite3_errmsg(db) else { return "sqlite error" }
        return String(cString: c)
    }

    private func exec(_ sql: String) throws {
        guard let db else { throw NSError(domain: "AppStore", code: 2, userInfo: [NSLocalizedDescriptionKey: "database unavailable"]) }
        var err: UnsafeMutablePointer<CChar>?
        guard sqlite3_exec(db, sql, nil, nil, &err) == SQLITE_OK else {
            let message = err.map { String(cString: $0) } ?? errorMessage()
            sqlite3_free(err)
            throw NSError(domain: "AppStore", code: 3, userInfo: [NSLocalizedDescriptionKey: message])
        }
    }

    private func ensureOpen() throws { if db == nil { try open() } }

    @objc func bootstrap(_ call: CAPPluginCall) {
        queue.async { [self] in
            do {
                try ensureOpen()
                guard let db else { throw NSError(domain: "AppStore", code: 2) }
                var stmt: OpaquePointer?
                // Search evaluations are rebuildable and can grow to tens of megabytes. Keep
                // them out of bootstrap so a WebView restart never copies that blob over Capacitor.
                guard sqlite3_prepare_v2(db, "SELECT key, value FROM documents WHERE key != 'maia-coach.evals'", -1, &stmt, nil) == SQLITE_OK else { throw NSError(domain: "AppStore", code: 4, userInfo: [NSLocalizedDescriptionKey: errorMessage()]) }
                defer { sqlite3_finalize(stmt) }
                var values: [String: String] = [:]
                var status = sqlite3_step(stmt)
                while status == SQLITE_ROW {
                    defer { status = sqlite3_step(stmt) }
                    guard let k = sqlite3_column_text(stmt, 0), let v = sqlite3_column_text(stmt, 1) else { continue }
                    values[String(cString: k)] = String(cString: v)
                }
                guard status == SQLITE_DONE else { throw NSError(domain: "AppStore", code: 5, userInfo: [NSLocalizedDescriptionKey: errorMessage()]) }
                call.resolve(["values": values])
            } catch { call.reject(error.localizedDescription) }
        }
    }

    @objc func set(_ call: CAPPluginCall) {
        guard let key = call.getString("key"), let value = call.getString("value") else { return call.reject("missing key/value") }
        if key == "maia-coach.evals" { return call.resolve() }
        queue.async { [self] in
            do {
                try ensureOpen()
                guard let db else { throw NSError(domain: "AppStore", code: 2) }
                var stmt: OpaquePointer?
                defer { sqlite3_finalize(stmt) }
                guard sqlite3_prepare_v2(db, "INSERT INTO documents(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at", -1, &stmt, nil) == SQLITE_OK else { throw NSError(domain: "AppStore", code: 4, userInfo: [NSLocalizedDescriptionKey: errorMessage()]) }
                sqlite3_bind_text(stmt, 1, key, -1, sqliteTransient)
                sqlite3_bind_text(stmt, 2, value, -1, sqliteTransient)
                sqlite3_bind_double(stmt, 3, Date().timeIntervalSince1970)
                guard sqlite3_step(stmt) == SQLITE_DONE else { throw NSError(domain: "AppStore", code: 5, userInfo: [NSLocalizedDescriptionKey: errorMessage()]) }
                call.resolve()
            } catch { call.reject(error.localizedDescription) }
        }
    }

    @objc func writeBatch(_ call: CAPPluginCall) {
        guard let entries = call.getObject("entries"), entries.values.allSatisfy({ $0 is String || $0 is NSNull }) else {
            return call.reject("invalid entries")
        }
        queue.async { [self] in
            do {
                try ensureOpen()
                try exec("BEGIN IMMEDIATE")
                do {
                    guard let db else { throw NSError(domain: "AppStore", code: 2) }
                    for (key, value) in entries where key != "maia-coach.evals" {
                        var stmt: OpaquePointer?
                        defer { sqlite3_finalize(stmt) }
                        let sql = value is NSNull ? "DELETE FROM documents WHERE key=?" : "INSERT INTO documents(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at"
                        guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK else { throw NSError(domain: "AppStore", code: 4, userInfo: [NSLocalizedDescriptionKey: errorMessage()]) }
                        sqlite3_bind_text(stmt, 1, key, -1, sqliteTransient)
                        if let text = value as? String {
                            sqlite3_bind_text(stmt, 2, text, -1, sqliteTransient)
                            sqlite3_bind_double(stmt, 3, Date().timeIntervalSince1970)
                        }
                        guard sqlite3_step(stmt) == SQLITE_DONE else { throw NSError(domain: "AppStore", code: 5, userInfo: [NSLocalizedDescriptionKey: errorMessage()]) }
                    }
                    try exec("COMMIT")
                } catch { try? exec("ROLLBACK"); throw error }
                call.resolve()
            } catch { call.reject(error.localizedDescription) }
        }
    }

    @objc func remove(_ call: CAPPluginCall) {
        guard let key = call.getString("key") else { return call.reject("missing key") }
        queue.async { [self] in
            do {
                try ensureOpen()
                guard let db else { throw NSError(domain: "AppStore", code: 2) }
                var stmt: OpaquePointer?
                defer { sqlite3_finalize(stmt) }
                guard sqlite3_prepare_v2(db, "DELETE FROM documents WHERE key=?", -1, &stmt, nil) == SQLITE_OK else { throw NSError(domain: "AppStore", code: 4, userInfo: [NSLocalizedDescriptionKey: errorMessage()]) }
                sqlite3_bind_text(stmt, 1, key, -1, sqliteTransient)
                guard sqlite3_step(stmt) == SQLITE_DONE else { throw NSError(domain: "AppStore", code: 5, userInfo: [NSLocalizedDescriptionKey: errorMessage()]) }
                call.resolve()
            }
            catch { call.reject(error.localizedDescription) }
        }
    }

    @objc func clear(_ call: CAPPluginCall) {
        queue.async { [self] in
            do { try ensureOpen(); try exec("DELETE FROM documents"); try exec("DELETE FROM game_checkpoint"); call.resolve() }
            catch { call.reject(error.localizedDescription) }
        }
    }

    @objc func saveCheckpoint(_ call: CAPPluginCall) {
        guard let game = call.getObject("game"), let data = try? JSONSerialization.data(withJSONObject: game),
              let value = String(data: data, encoding: .utf8) else { return call.reject("invalid game checkpoint") }
        queue.async { [self] in
            do {
                try ensureOpen()
                guard let db else { throw NSError(domain: "AppStore", code: 2) }
                var stmt: OpaquePointer?
                defer { sqlite3_finalize(stmt) }
                let sql = "INSERT INTO game_checkpoint(id,value,updated_at) VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at"
                guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK else { throw NSError(domain: "AppStore", code: 4, userInfo: [NSLocalizedDescriptionKey: errorMessage()]) }
                sqlite3_bind_text(stmt, 1, value, -1, sqliteTransient)
                sqlite3_bind_double(stmt, 2, Date().timeIntervalSince1970)
                guard sqlite3_step(stmt) == SQLITE_DONE else { throw NSError(domain: "AppStore", code: 5, userInfo: [NSLocalizedDescriptionKey: errorMessage()]) }
                call.resolve()
            } catch { call.reject(error.localizedDescription) }
        }
    }

    @objc func loadCheckpoint(_ call: CAPPluginCall) {
        queue.async { [self] in
            do {
                try ensureOpen()
                guard let db else { throw NSError(domain: "AppStore", code: 2) }
                var stmt: OpaquePointer?
                defer { sqlite3_finalize(stmt) }
                guard sqlite3_prepare_v2(db, "SELECT value FROM game_checkpoint WHERE id=1", -1, &stmt, nil) == SQLITE_OK else { throw NSError(domain: "AppStore", code: 4, userInfo: [NSLocalizedDescriptionKey: errorMessage()]) }
                let status = sqlite3_step(stmt)
                if status == SQLITE_DONE { return call.resolve() }
                guard status == SQLITE_ROW, let raw = sqlite3_column_text(stmt, 0) else { throw NSError(domain: "AppStore", code: 5, userInfo: [NSLocalizedDescriptionKey: errorMessage()]) }
                let value = String(cString: raw)
                guard let data = value.data(using: .utf8), let game = try JSONSerialization.jsonObject(with: data) as? [String: Any] else { throw NSError(domain: "AppStore", code: 6, userInfo: [NSLocalizedDescriptionKey: "invalid game checkpoint"]) }
                call.resolve(["game": game])
            } catch { call.reject(error.localizedDescription) }
        }
    }
}
