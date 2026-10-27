import AVFoundation
import Capacitor
import UIKit
import PiperPlus

private enum PiperPlusError: LocalizedError {
    case invalidAudio

    var errorDescription: String? { "Piper returned invalid or silent audio" }
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

private final class PiperPlusVoice {
    private let engine: OpaquePointer

    init(modelPath: String, configPath: String) throws {
        var created: OpaquePointer?
        let status = modelPath.withCString { model in
            configPath.withCString { configFile in
                "cpu".withCString { provider in
                    var config = PiperPlusConfig()
                    config.model_path = model
                    config.config_path = configFile
                    config.provider = provider
                    config.num_threads = 2
                    return piper_plus_create(&config, &created)
                }
            }
        }
        guard status == PIPER_PLUS_OK, let created else {
            let detail = piper_plus_get_last_error().map { String(cString: $0) } ?? "no native error detail"
            throw NSError(domain: "PiperPlus", code: Int(status), userInfo: [NSLocalizedDescriptionKey: "engine creation failed: \(detail)"])
        }
        engine = created
    }

    deinit {
        piper_plus_free(engine)
    }

    func synthesize(_ text: String) throws -> AVAudioPCMBuffer {
        var options = piper_plus_default_options()
        var samples: UnsafeMutablePointer<Float>?
        var sampleCount: Int32 = 0
        var sampleRate: Int32 = 0
        let status = text.withCString { input in
            piper_plus_synthesize(engine, input, &options, &samples, &sampleCount, &sampleRate)
        }
        guard status == PIPER_PLUS_OK, let samples else {
            let detail = piper_plus_get_last_error().map { String(cString: $0) } ?? "no native error detail"
            throw NSError(domain: "PiperPlus", code: Int(status), userInfo: [NSLocalizedDescriptionKey: "synthesis failed: \(detail)"])
        }
        defer { piper_plus_free_audio(samples) }
        let count = Int(sampleCount)
        guard count > 0, sampleRate > 0, count <= Int(sampleRate) * 60,
              let format = AVAudioFormat(standardFormatWithSampleRate: Double(sampleRate), channels: 1),
              let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(count)),
              let channel = buffer.floatChannelData?.pointee else {
            throw PiperPlusError.invalidAudio
        }

        var peak: Float = 0
        for index in 0..<count {
            let sample = samples[index]
            guard sample.isFinite else { throw PiperPlusError.invalidAudio }
            channel[index] = sample
            peak = max(peak, abs(sample))
        }
        buffer.frameLength = AVAudioFrameCount(count)
        guard peak > 0.0001 else { throw PiperPlusError.invalidAudio }
        TTSRuntimeLog.record(String(format: "generated %.2fs at %dHz (peak %.3f)", Double(count) / Double(sampleRate), sampleRate, peak))
        return buffer
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
    private let speechQueue = DispatchQueue(label: "maia.piper", qos: .userInitiated)
    private let speechLock = NSLock()
    private var speechRequest = 0
    private var piper: PiperPlusVoice?
    private var piperVoice: String?
    private var speechEngine: AVAudioEngine?
    private var speechPlayerNode: AVAudioPlayerNode?

    private static let piperVoices: Set<String> = ["en_US-lessac-medium", "en_US-ryan-medium"]

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

    private func loadPiper(_ voice: String) throws -> PiperPlusVoice {
        if piperVoice == voice, let piper { return piper }
        let directory = "public/native/speech"
        guard let model = Bundle.main.url(forResource: voice, withExtension: "onnx", subdirectory: directory),
              let config = Bundle.main.url(forResource: "\(voice).onnx", withExtension: "json", subdirectory: directory) else {
            throw NSError(domain: "SoundNative", code: 2, userInfo: [NSLocalizedDescriptionKey: "未打包 Piper 音色：\(voice)"])
        }
        piper = nil
        piperVoice = nil
        let engine = try PiperPlusVoice(modelPath: model.path, configPath: config.path)
        piper = engine
        piperVoice = voice
        return engine
    }

    private func stopSpeechPlayback() {
        speechPlayerNode?.stop()
        speechEngine?.stop()
        speechPlayerNode = nil
        speechEngine = nil
    }

    private func playSpeechBuffer(_ buffer: AVAudioPCMBuffer) throws {
        stopSpeechPlayback()
        let engine = AVAudioEngine()
        let player = AVAudioPlayerNode()
        engine.attach(player)
        engine.connect(player, to: engine.mainMixerNode, format: buffer.format)
        try engine.start()
        player.scheduleBuffer(buffer)
        player.play()
        speechEngine = engine
        speechPlayerNode = player
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
        guard let voice = call.getString("voice"), Self.piperVoices.contains(voice) else {
            return call.reject("invalid Piper voice")
        }
        speechQueue.async { [self] in
            do {
                TTSRuntimeLog.record("prepare started voice=\(voice)")
                _ = try loadPiper(voice)
                TTSRuntimeLog.record("prepare succeeded voice=\(voice)")
                call.resolve()
            } catch {
                TTSRuntimeLog.record("prepare failed voice=\(voice): \(error.localizedDescription)")
                call.reject("Piper 初始化失败：\(error.localizedDescription)", nil, error)
            }
        }
    }

    @objc func speak(_ call: CAPPluginCall) {
        guard let text = call.getString("text"), !text.isEmpty, text.count <= 240,
              let voice = call.getString("voice"), Self.piperVoices.contains(voice) else {
            return call.reject("invalid speech request")
        }
        let request = nextSpeechRequest()
        TTSRuntimeLog.record("speak requested voice=\(voice) chars=\(text.count)")
        DispatchQueue.main.async { [self] in stopSpeechPlayback() }
        speechQueue.async { [self] in
            do {
                guard isCurrentSpeechRequest(request) else { return call.resolve() }
                let engine = try loadPiper(voice)
                let buffer = try engine.synthesize(text)
                guard isCurrentSpeechRequest(request) else {
                    return call.resolve()
                }
                DispatchQueue.main.async { [self] in
                    guard isCurrentSpeechRequest(request), UIApplication.shared.applicationState == .active else {
                        return call.resolve()
                    }
                    do {
                        try activateSession()
                        try playSpeechBuffer(buffer)
                        TTSRuntimeLog.record("playback started voice=\(voice)")
                        call.resolve()
                    } catch {
                        TTSRuntimeLog.record("playback failed voice=\(voice): \(error.localizedDescription)")
                        call.reject("Piper 播放失败：\(error.localizedDescription)", nil, error)
                    }
                }
            } catch {
                TTSRuntimeLog.record("synthesis failed voice=\(voice): \(error.localizedDescription)")
                call.reject("Piper 合成失败：\(error.localizedDescription)", nil, error)
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
    }

    public func audioPlayerDecodeErrorDidOccur(_ player: AVAudioPlayer, error: Error?) {
        players.removeAll { $0 === player }
        NSLog("原生音效解码失败：%@", error?.localizedDescription ?? "unknown error")
    }
}
