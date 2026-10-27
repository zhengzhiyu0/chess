import AVFoundation
import Capacitor
import UIKit
import piper_objc

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
    private var piper: Piper?
    private var piperVoice: String?
    private var speechPlayer: AVAudioPlayer?
    private var speechFile: URL?

    private static let piperVoices: Set<String> = ["en_US-lessac-medium", "en_US-ryan-medium"]

    /// Configure the session once when the plugin is loaded. Reapplying the
    /// category for every move can make iOS renegotiate the route while a very
    /// short MP3 is starting, which is perceived as a quiet or missed move.
    private let session = AVAudioSession.sharedInstance()

    override public func load() {
        do {
            try session.setCategory(.playback, mode: .default, options: [.mixWithOthers])
        } catch {
            NSLog("SoundNative: audio session setup failed: %@", error.localizedDescription)
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

    private func loadPiper(_ voice: String) throws -> Piper {
        if piperVoice == voice, let piper { return piper }
        let directory = "public/native/speech"
        guard let model = Bundle.main.url(forResource: voice, withExtension: "onnx", subdirectory: directory),
              let config = Bundle.main.url(forResource: "\(voice).onnx", withExtension: "json", subdirectory: directory) else {
            throw NSError(domain: "SoundNative", code: 2, userInfo: [NSLocalizedDescriptionKey: "未打包 Piper 音色：\(voice)"])
        }
        piper = nil
        piperVoice = nil
        let engine = try Piper(modelPath: model.path, configPath: config.path, espeakNGData: "")
        piper = engine
        piperVoice = voice
        return engine
    }

    private func stopSpeechPlayback() {
        speechPlayer?.stop()
        speechPlayer = nil
        if let speechFile { try? FileManager.default.removeItem(at: speechFile) }
        speechFile = nil
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

    @objc func prepareSpeech(_ call: CAPPluginCall) {
        guard let voice = call.getString("voice"), Self.piperVoices.contains(voice) else {
            return call.reject("invalid Piper voice")
        }
        speechQueue.async { [self] in
            do {
                _ = try loadPiper(voice)
                call.resolve()
            } catch {
                NSLog("Piper 语音初始化失败：%@", error.localizedDescription)
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
        DispatchQueue.main.async { [self] in stopSpeechPlayback() }
        speechQueue.async { [self] in
            var output: URL?
            do {
                guard isCurrentSpeechRequest(request) else { return call.resolve() }
                let engine = try loadPiper(voice)
                let file = FileManager.default.temporaryDirectory.appendingPathComponent("piper-\(UUID().uuidString).wav")
                output = file
                let completed = DispatchSemaphore(value: 0)
                engine.synthesize(text, toFileAtPath: file.path) { completed.signal() }
                completed.wait()
                guard isCurrentSpeechRequest(request) else {
                    try? FileManager.default.removeItem(at: file)
                    return call.resolve()
                }
                let attributes = try? FileManager.default.attributesOfItem(atPath: file.path)
                let fileSize = attributes?[.size] as? Int
                guard engine.status == .completed, let fileSize, fileSize > 44 else {
                    throw NSError(domain: "SoundNative", code: 3, userInfo: [NSLocalizedDescriptionKey: "Piper 没有生成有效音频"])
                }
                DispatchQueue.main.async { [self] in
                    guard isCurrentSpeechRequest(request), UIApplication.shared.applicationState == .active else {
                        try? FileManager.default.removeItem(at: file)
                        return call.resolve()
                    }
                    do {
                        try activateSession()
                        let player = try AVAudioPlayer(contentsOf: file)
                        player.delegate = self
                        speechFile = file
                        speechPlayer = player
                        guard player.prepareToPlay(), player.play() else {
                            stopSpeechPlayback()
                            return call.reject("Piper 音频无法播放")
                        }
                        call.resolve()
                    } catch {
                        try? FileManager.default.removeItem(at: file)
                        call.reject("Piper 播放失败：\(error.localizedDescription)", nil, error)
                    }
                }
            } catch {
                if let output { try? FileManager.default.removeItem(at: output) }
                NSLog("Piper 语音合成失败：%@", error.localizedDescription)
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
            speechPlayer = nil
            if let speechFile { try? FileManager.default.removeItem(at: speechFile) }
            speechFile = nil
        }
    }

    public func audioPlayerDecodeErrorDidOccur(_ player: AVAudioPlayer, error: Error?) {
        players.removeAll { $0 === player }
        NSLog("原生音效解码失败：%@", error?.localizedDescription ?? "unknown error")
    }
}
