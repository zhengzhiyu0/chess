import AVFoundation
import Capacitor
import UIKit
import KittenTTS

private enum KittenRuntimeError: LocalizedError {
    case invalidAudio
    case missingAsset(String)

    var errorDescription: String? {
        switch self {
        case .invalidAudio: "KittenTTS returned invalid or silent audio"
        case .missingAsset(let name): "KittenTTS bundled asset is missing: \(name)"
        }
    }
}

private enum TTSRuntimeLog {
    private static let lock = NSLock()
    private static var entries: [String] = []

    static func record(_ message: String) {
        let line = "\(ISO8601DateFormatter().string(from: Date())) [iOS/TTS] \(message)"
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

private actor KittenRuntime {
    private var engine: KittenTTS?

    func prepare() async throws {
        guard engine == nil else { return }
        let applicationSupport = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("KittenTTS", isDirectory: true)
        let modelDirectory = applicationSupport.appendingPathComponent(KittenModel.mini.rawValue, isDirectory: true)
        let phonemizerDirectory = modelDirectory.appendingPathComponent("EPhonemizer", isDirectory: true)
        try FileManager.default.createDirectory(at: modelDirectory, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: phonemizerDirectory, withIntermediateDirectories: true)

        try installBundledAsset("kitten_tts_mini_v0_8", extension: "onnx", to: modelDirectory)
        try installBundledAsset("voices", extension: "npz", to: modelDirectory)
        try installBundledAsset("en_rules", extension: nil, to: phonemizerDirectory)
        try installBundledAsset("en_list", extension: nil, to: phonemizerDirectory)

        let config = KittenTTSConfig(
            model: .mini,
            defaultVoice: .bella,
            speed: 1.0,
            storageDirectory: applicationSupport,
            ortNumThreads: 2
        )
        engine = try await KittenTTS(config)
        TTSRuntimeLog.record("KittenTTS 0.8 Mini initialized (Bella/Jasper, bundled offline assets)")
    }

    func synthesize(_ text: String, voice: KittenVoice) async throws -> Data {
        try await prepare()
        guard let engine else { throw KittenRuntimeError.invalidAudio }
        let result = try await engine.generate(text, voice: voice, speed: 1.0)
        guard result.duration > 0, !result.samples.isEmpty, result.samples.allSatisfy(\.isFinite) else {
            throw KittenRuntimeError.invalidAudio
        }
        let peak = result.samples.reduce(Float.zero) { max($0, abs($1)) }
        TTSRuntimeLog.record(String(format: "KittenTTS generated %.2fs at %dHz (peak %.3f)", result.duration, result.sampleRate, peak))
        return result.wavData()
    }

    private func installBundledAsset(_ name: String, extension fileExtension: String?, to directory: URL) throws {
        let destination = directory.appendingPathComponent(fileExtension.map { "\(name).\($0)" } ?? name)
        guard let source = Bundle.main.url(forResource: name, withExtension: fileExtension, subdirectory: "public/native/speech/kitten-mini") else {
            throw KittenRuntimeError.missingAsset(fileExtension.map { "\(name).\($0)" } ?? name)
        }
        if let sourceSize = try? FileManager.default.attributesOfItem(atPath: source.path)[.size] as? NSNumber,
           let destinationSize = try? FileManager.default.attributesOfItem(atPath: destination.path)[.size] as? NSNumber,
           sourceSize == destinationSize { return }
        if FileManager.default.fileExists(atPath: destination.path) {
            try FileManager.default.removeItem(at: destination)
        }
        try FileManager.default.copyItem(at: source, to: destination)
    }
}

/// Play bundled MP3s outside WKWebView's gesture, decoding and AudioContext lifecycle.
@objc(SoundNativePlugin)
public class SoundNativePlugin: CAPPlugin, CAPBridgedPlugin, AVAudioPlayerDelegate {
    public let identifier = "SoundNativePlugin"
    public let jsName = "SoundNative"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "play", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stop", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "prepareSpeech", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "speak", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stopSpeech", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getLogs", returnType: CAPPluginReturnPromise),
    ]

    private static let themes: Set<String> = ["board", "wood", "felt", "glass", "sfx", "piano", "nes", "futuristic"]
    private static let files: Set<String> = ["Move", "Capture", "Check", "GenericNotify", "Victory", "Defeat", "Draw", "LowTime"]
    private var players: [AVAudioPlayer] = []
    private var recordings: [URL: Data] = [:]
    private var observers: [NSObjectProtocol] = []
    private var sessionActive = false
    private let speechLock = NSLock()
    private var speechRequest = 0
    private let kitten = KittenRuntime()
    private var speechPlayer: AVAudioPlayer?

    private static let kittenVoices: Set<String> = ["bella", "jasper"]

    /// Configure the session once when the plugin is loaded. Reapplying the
    /// category for every move can make iOS renegotiate the route while a very
    /// short MP3 is starting, which is perceived as a quiet or missed move.
    private let session = AVAudioSession.sharedInstance()

    override public func load() {
        do {
            try session.setCategory(.playback, mode: .default, options: [.mixWithOthers])
        } catch {
            TTSRuntimeLog.record("audio session setup failed: \(error.localizedDescription)")
        }
        let center = NotificationCenter.default
        for name in [UIApplication.willResignActiveNotification, AVAudioSession.interruptionNotification] {
            observers.append(center.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in
                // Discard interrupted and scheduled sounds; never replay them on return.
                self?.stopPlayers()
                self?.stopSpeechNow()
                self?.sessionActive = false
            })
        }
        observers.append(center.addObserver(forName: AVAudioSession.mediaServicesWereResetNotification, object: nil, queue: .main) { [weak self] _ in
            self?.stopPlayers()
            self?.recordings.removeAll()
            self?.stopSpeechNow()
            self?.sessionActive = false
        })
    }

    deinit {
        for observer in observers { NotificationCenter.default.removeObserver(observer) }
    }

    private func recording(theme: String, file: String) throws -> Data {
        // Compact themes only override Move / Capture; other events use the Lichess set.
        let url = Bundle.main.url(forResource: file, withExtension: "mp3", subdirectory: "public/sounds/\(theme)")
            ?? Bundle.main.url(forResource: file, withExtension: "mp3", subdirectory: "public/sounds/sfx")
        guard let url else {
            throw NSError(domain: "SoundNative", code: 1, userInfo: [NSLocalizedDescriptionKey: "音效 \(theme)/\(file).mp3 未打包"])
        }
        if let data = recordings[url] { return data }
        let data = try Data(contentsOf: url)
        recordings[url] = data
        return data
    }

    private func stopPlayers() {
        for player in players { player.stop() }
        players.removeAll()
    }

    private func start(_ player: AVAudioPlayer) {
        // `play(atTime:)` is unreliable for tiny effects when the device clock
        // has just been activated. Start zero-delay clips immediately so their
        // attack is never clipped. Delayed preview clips are scheduled by the
        // main queue instead of the audio device clock for the same reason.
        guard players.contains(where: { $0 === player }) else { return }
        guard player.prepareToPlay(), player.play() else {
            players.removeAll { $0 === player }
            return
        }
    }

    private func activateSession() throws {
        if sessionActive { return }
        try session.setActive(true)
        sessionActive = true
    }

    private func nextSpeechRequest() -> Int {
        speechLock.lock()
        defer { speechLock.unlock() }
        speechRequest += 1
        return speechRequest
    }

    private func isCurrentSpeechRequest(_ request: Int) -> Bool {
        speechLock.lock()
        defer { speechLock.unlock() }
        return speechRequest == request
    }

    private func stopSpeechPlayback() {
        speechPlayer?.stop()
        speechPlayer = nil
    }

    private func playSpeech(_ wav: Data) throws {
        stopSpeechPlayback()
        let player = try AVAudioPlayer(data: wav, fileTypeHint: AVFileType.wav.rawValue)
        player.delegate = self
        speechPlayer = player
        guard player.prepareToPlay(), player.play() else {
            speechPlayer = nil
            throw NSError(domain: "SoundNative", code: 4, userInfo: [NSLocalizedDescriptionKey: "AVAudioPlayer could not start KittenTTS audio"])
        }
        let route = session.currentRoute.outputs.map { "\($0.portType.rawValue):\($0.portName)" }.joined(separator: ",")
        TTSRuntimeLog.record("AVAudioPlayer started route=\(route) duration=\(String(format: "%.2f", player.duration))s")
    }

    private func stopSpeechNow() {
        _ = nextSpeechRequest()
        stopSpeechPlayback()
    }

    @objc func stop(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [self] in
            stopPlayers()
            call.resolve()
        }
    }

    @objc func stopSpeech(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [self] in
            stopSpeechNow()
            call.resolve()
        }
    }

    @objc func getLogs(_ call: CAPPluginCall) {
        call.resolve(["logs": TTSRuntimeLog.text()])
    }

    @objc func prepareSpeech(_ call: CAPPluginCall) {
        guard let voice = call.getString("voice"), Self.kittenVoices.contains(voice) else {
            return call.reject("invalid KittenTTS voice")
        }
        Task { [self] in
            do {
                TTSRuntimeLog.record("KittenTTS prepare started voice=\(voice)")
                try await kitten.prepare()
                TTSRuntimeLog.record("prepare succeeded voice=\(voice)")
                call.resolve()
            } catch {
                TTSRuntimeLog.record("prepare failed voice=\(voice): \(error.localizedDescription)")
                call.reject("KittenTTS 初始化失败：\(error.localizedDescription)", nil, error)
            }
        }
    }

    @objc func speak(_ call: CAPPluginCall) {
        guard let text = call.getString("text"), !text.isEmpty, text.count <= 240,
              let voice = call.getString("voice"), Self.kittenVoices.contains(voice) else {
            return call.reject("invalid speech request")
        }
        let request = nextSpeechRequest()
        TTSRuntimeLog.record("speak requested voice=\(voice) chars=\(text.count)")
        DispatchQueue.main.async { [self] in stopSpeechPlayback() }
        Task { [self] in
            do {
                guard isCurrentSpeechRequest(request) else { return call.resolve() }
                let selectedVoice: KittenVoice = voice == "jasper" ? .jasper : .bella
                let wav = try await kitten.synthesize(text, voice: selectedVoice)
                guard isCurrentSpeechRequest(request) else {
                    return call.resolve()
                }
                DispatchQueue.main.async { [self] in
                    guard isCurrentSpeechRequest(request), UIApplication.shared.applicationState == .active else {
                        return call.resolve()
                    }
                    do {
                        try activateSession()
                        try playSpeech(wav)
                        call.resolve()
                    } catch {
                        TTSRuntimeLog.record("playback failed voice=\(voice): \(error.localizedDescription)")
                        call.reject("KittenTTS 播放失败：\(error.localizedDescription)", nil, error)
                    }
                }
            } catch {
                TTSRuntimeLog.record("synthesis failed voice=\(voice): \(error.localizedDescription)")
                call.reject("KittenTTS 合成失败：\(error.localizedDescription)", nil, error)
            }
        }
    }

    @objc func play(_ call: CAPPluginCall) {
        guard let clips = call.getArray("clips", JSObject.self), !clips.isEmpty, clips.count <= 2 else {
            return call.reject("invalid sound clips")
        }
        DispatchQueue.main.async { [self] in
            guard UIApplication.shared.applicationState == .active else { return call.resolve() }
            do {
                var batch: [(AVAudioPlayer, Double)] = []
                for clip in clips {
                    guard let theme = clip["theme"] as? String, Self.themes.contains(theme),
                          let file = clip["file"] as? String, Self.files.contains(file),
                          let delay = clip["delay"] as? Double, delay.isFinite, delay >= 0, delay <= 2 else {
                        return call.reject("invalid sound clip")
                    }
                    let player = try AVAudioPlayer(data: recording(theme: theme, file: file), fileTypeHint: AVFileType.mp3.rawValue)
                    player.delegate = self
                    batch.append((player, delay))
                }
                // The in-app sound setting controls muting. Mix short effects with other audio,
                // and activate again only after an interruption or background transition.
                try activateSession()
                if players.count + batch.count > 8 { stopPlayers() }
                for (player, delay) in batch {
                    player.volume = 1
                    players.append(player)
                    if delay <= 0 {
                        start(player)
                    } else {
                        DispatchQueue.main.asyncAfter(deadline: .now() + delay) { [weak self, weak player] in
                            guard let self, let player else { return }
                            self.start(player)
                        }
                    }
                }
                call.resolve()
            } catch {
                call.reject("原生音效失败：\(error.localizedDescription)", nil, error)
            }
        }
    }

    public func audioPlayerDidFinishPlaying(_ player: AVAudioPlayer, successfully flag: Bool) {
        players.removeAll { $0 === player }
        if player === speechPlayer {
            TTSRuntimeLog.record("speech playback finished successfully=\(flag)")
            speechPlayer = nil
        }
    }

    public func audioPlayerDecodeErrorDidOccur(_ player: AVAudioPlayer, error: Error?) {
        players.removeAll { $0 === player }
        if player === speechPlayer {
            TTSRuntimeLog.record("speech decode failed: \(error?.localizedDescription ?? "unknown error")")
            speechPlayer = nil
        } else {
            NSLog("原生音效解码失败：%@", error?.localizedDescription ?? "unknown error")
        }
    }
}
