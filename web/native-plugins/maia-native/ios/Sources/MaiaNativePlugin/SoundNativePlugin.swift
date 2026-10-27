import AVFoundation
import Capacitor
import UIKit
import PiperPlus
import EspeakBridge

private enum PiperPlusError: LocalizedError {
    case invalidAudio
    case implausiblyShortAudio

    var errorDescription: String? {
        switch self {
        case .invalidAudio: "Piper returned invalid or silent audio"
        case .implausiblyShortAudio: "Piper returned audio that is too short for the requested speech"
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

private enum LegacyPiperPhonemizer {
    private static var initialized = false

    static func wrap(_ text: String) throws -> String {
        let directory = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first!
        if !initialized {
            let sampleRate = directory.path.withCString { maia_espeak_initialize($0) }
            guard sampleRate > 0 else {
                let detail = maia_espeak_last_error().map { String(cString: $0) } ?? "unknown eSpeak error"
                throw NSError(domain: "EspeakBridge", code: Int(sampleRate), userInfo: [NSLocalizedDescriptionKey: detail])
            }
            initialized = true
            TTSRuntimeLog.record("eSpeak initialized at \(sampleRate)Hz")
        }

        var byteCount = 0
        let result = text.withCString { maia_espeak_phonemize($0, &byteCount) }
        guard let result, byteCount > 0 else {
            let detail = maia_espeak_last_error().map { String(cString: $0) } ?? "empty eSpeak phonemes"
            throw NSError(domain: "EspeakBridge", code: 1, userInfo: [NSLocalizedDescriptionKey: detail])
        }
        let phonemes = String(cString: result)
        guard !phonemes.isEmpty else {
            throw NSError(domain: "EspeakBridge", code: 2, userInfo: [NSLocalizedDescriptionKey: "empty eSpeak phonemes"])
        }
        TTSRuntimeLog.record("eSpeak produced \(phonemes.unicodeScalars.count) IPA codepoints")
        return phonemes
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
            throw NSError(domain: "PiperPlus", code: Int(status.rawValue), userInfo: [NSLocalizedDescriptionKey: "engine creation failed: \(detail)"])
        }
        engine = created
    }

    deinit {
        piper_plus_free(engine)
    }

    func synthesize(_ text: String, minimumDuration: Double) throws -> Data {
        var options = piper_plus_default_options()
        // Match the bundled rhasspy Piper Medium voice configs.
        options.noise_scale = 0.667
        options.length_scale = 1.0
        options.noise_w = 0.8
        var samples: UnsafeMutablePointer<Float>?
        var sampleCount: Int32 = 0
        var sampleRate: Int32 = 0
        let status = text.withCString { input in
            piper_plus_synthesize(engine, input, &options, &samples, &sampleCount, &sampleRate)
        }
        guard status == PIPER_PLUS_OK, let samples else {
            let detail = piper_plus_get_last_error().map { String(cString: $0) } ?? "no native error detail"
            throw NSError(domain: "PiperPlus", code: Int(status.rawValue), userInfo: [NSLocalizedDescriptionKey: "synthesis failed: \(detail)"])
        }
        defer { piper_plus_free_audio(samples) }
        let count = Int(sampleCount)
        guard count > 0, sampleRate > 0, count <= Int(sampleRate) * 60,
              count <= (Int.max - 44) / MemoryLayout<Float>.stride else {
            throw PiperPlusError.invalidAudio
        }

        var peak: Float = 0
        var energy: Double = 0
        var pcm = Data(capacity: count * MemoryLayout<Float>.stride)
        for index in 0..<count {
            let sample = samples[index]
            guard sample.isFinite else { throw PiperPlusError.invalidAudio }
            peak = max(peak, abs(sample))
            energy += Double(sample) * Double(sample)
            var littleEndianSample = sample.bitPattern.littleEndian
            Swift.withUnsafeBytes(of: &littleEndianSample) { pcm.append(contentsOf: $0) }
        }
        let rms = sqrt(energy / Double(count))
        guard rms > 0.001 else { throw PiperPlusError.invalidAudio }
        let duration = Double(count) / Double(sampleRate)
        TTSRuntimeLog.record(String(format: "generated %.2fs at %dHz (peak %.3f rms %.3f)", duration, sampleRate, peak, rms))
        guard duration >= minimumDuration else { throw PiperPlusError.implausiblyShortAudio }

        var wav = Data(capacity: 44 + pcm.count)
        wav.append(contentsOf: "RIFF".utf8)
        appendLE(UInt32(36 + pcm.count), to: &wav)
        wav.append(contentsOf: "WAVEfmt ".utf8)
        appendLE(UInt32(16), to: &wav)
        appendLE(UInt16(3), to: &wav)
        appendLE(UInt16(1), to: &wav)
        appendLE(UInt32(sampleRate), to: &wav)
        appendLE(UInt32(sampleRate) * UInt32(MemoryLayout<Float>.stride), to: &wav)
        appendLE(UInt16(MemoryLayout<Float>.stride), to: &wav)
        appendLE(UInt16(MemoryLayout<Float>.stride * 8), to: &wav)
        wav.append(contentsOf: "data".utf8)
        appendLE(UInt32(pcm.count), to: &wav)
        wav.append(pcm)
        return wav
    }

    private func appendLE<T: FixedWidthInteger>(_ value: T, to data: inout Data) {
        var littleEndian = value.littleEndian
        Swift.withUnsafeBytes(of: &littleEndian) { data.append(contentsOf: $0) }
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
    private var speechPlayer: AVAudioPlayer?

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
            throw NSError(domain: "SoundNative", code: 4, userInfo: [NSLocalizedDescriptionKey: "AVAudioPlayer could not start Piper audio"])
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
                let phoneticInput = try LegacyPiperPhonemizer.wrap(text)
                let minDuration = max(0.2, Double(text.count) * 0.01)
                let buffer = try engine.synthesize(phoneticInput, minimumDuration: minDuration)
                guard isCurrentSpeechRequest(request) else {
                    return call.resolve()
                }
                DispatchQueue.main.async { [self] in
                    guard isCurrentSpeechRequest(request), UIApplication.shared.applicationState == .active else {
                        return call.resolve()
                    }
                    do {
                        try activateSession()
                        try playSpeech(buffer)
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
