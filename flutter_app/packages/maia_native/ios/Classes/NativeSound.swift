import AVFoundation
import UIKit

final class NativeSound: NSObject, AVAudioPlayerDelegate {
    private static let themes: Set<String> = ["board", "wood", "felt", "glass", "standard"]
    private static let files: Set<String> = ["Move", "Capture", "Check", "Castle", "Promotion", "GenericNotify", "Victory", "Defeat", "Draw", "LowTime", "move", "capture", "error", "dong"]
    private let assets: NativeAssets
    private let session = AVAudioSession.sharedInstance()
    private var sessionActive = false
    private var configured = false
    private var players: [AVAudioPlayer] = []
    private var recordings: [URL: Data] = [:]
    private var observers: [NSObjectProtocol] = []
    private var scheduled: [ObjectIdentifier: DispatchWorkItem] = [:]

    init(assets: NativeAssets) {
        self.assets = assets
        super.init()
        configureSession()
        let center = NotificationCenter.default
        observers.append(center.addObserver(forName: AVAudioSession.interruptionNotification, object: nil, queue: .main) { [weak self] _ in
            self?.interrupt()
        })
        observers.append(center.addObserver(forName: AVAudioSession.mediaServicesWereResetNotification, object: nil, queue: .main) { [weak self] _ in
            self?.interrupt()
            self?.recordings.removeAll()
            self?.configured = false
            self?.configureSession()
        })
    }

    private func configureSession() {
        do {
            try session.setCategory(.playback, mode: .default, options: [.mixWithOthers])
            configured = true
        } catch { NativeRuntimeLog.record("session setup failed: \(error.localizedDescription)", subsystem: "Audio") }
    }

    private static func standardFile(_ file: String) -> String {
        switch file {
        case "Move", "Check", "Castle": return "move"
        case "Promotion": return "dong"
        case "Capture": return "capture"
        case "GenericNotify", "Victory", "Defeat", "Draw": return "dong"
        case "LowTime": return "error"
        default: return file
        }
    }

    private func recording(theme: String, file: String) throws -> Data {
        guard let url = assets.url("sounds/\(theme)/\(file).mp3")
            ?? assets.url("sounds/standard/\(Self.standardFile(file)).mp3") else {
            throw NativeFailure(code: "sound_missing", message: "Sound \(theme)/\(file).mp3 is not bundled")
        }
        if let data = recordings[url] { return data }
        let data = try Data(contentsOf: url)
        recordings[url] = data
        return data
    }

    func stop() {
        for work in scheduled.values { work.cancel() }
        scheduled.removeAll()
        for player in players { player.stop() }
        players.removeAll()
    }

    func interrupt() {
        stop()
        if sessionActive {
            do { try session.setActive(false, options: .notifyOthersOnDeactivation) }
            catch { NativeRuntimeLog.record("session deactivation: \(error.localizedDescription)", subsystem: "Audio") }
        }
        sessionActive = false
    }

    private func start(_ player: AVAudioPlayer) {
        scheduled.removeValue(forKey: ObjectIdentifier(player))
        guard UIApplication.shared.applicationState == .active,
              players.contains(where: { $0 === player }) else { return }
        guard player.prepareToPlay(), player.play() else {
            players.removeAll { $0 === player }
            NativeRuntimeLog.record("player failed to start", subsystem: "Audio")
            return
        }
    }

    func play(_ args: [String: Any], reply: NativeReply) {
        do {
            guard let clips = args["clips"] as? [[String: Any]], !clips.isEmpty, clips.count <= 2 else {
                throw NativeFailure.invalid("clips must contain one or two sound clips")
            }
            var batch: [(AVAudioPlayer, Double)] = []
            for clip in clips {
                guard let theme = clip["theme"] as? String, Self.themes.contains(theme),
                      let file = clip["file"] as? String, Self.files.contains(file),
                      let delay = NativeArguments.number(clip["delay"]), delay >= 0, delay <= 2 else {
                    throw NativeFailure.invalid("invalid sound theme, file or delay (0...2 seconds)")
                }
                let player = try AVAudioPlayer(data: recording(theme: theme, file: file), fileTypeHint: AVFileType.mp3.rawValue)
                player.delegate = self
                batch.append((player, delay))
            }
            guard UIApplication.shared.applicationState == .active else { reply.finish(); return }
            if !configured { configureSession() }
            if !sessionActive { try session.setActive(true); sessionActive = true }
            if players.count + batch.count > 8 { stop() }
            for (player, delay) in batch {
                player.volume = 1
                players.append(player)
                if delay == 0 { start(player) }
                else {
                    let work = DispatchWorkItem { [weak self, weak player] in
                        guard let self, let player else { return }
                        self.start(player)
                    }
                    scheduled[ObjectIdentifier(player)] = work
                    DispatchQueue.main.asyncAfter(deadline: .now() + delay, execute: work)
                }
            }
            reply.finish()
        } catch {
            NativeRuntimeLog.record("play failed: \(error.localizedDescription)", subsystem: "Audio")
            reply.fail(error)
        }
    }

    func audioPlayerDidFinishPlaying(_ player: AVAudioPlayer, successfully flag: Bool) {
        players.removeAll { $0 === player }
    }

    func audioPlayerDecodeErrorDidOccur(_ player: AVAudioPlayer, error: Error?) {
        players.removeAll { $0 === player }
        NativeRuntimeLog.record("decode failed: \(error?.localizedDescription ?? "unknown")", subsystem: "Audio")
    }

    deinit { for observer in observers { NotificationCenter.default.removeObserver(observer) } }
}
