// Run on macOS: swift test/sound-assets.native.swift ios/App/App/public
// Decode the actual bundled MP3s with AVFoundation; no audio output device is required.
import AVFoundation
import Foundation

let root = URL(fileURLWithPath: CommandLine.arguments[1], isDirectory: true)
let themes = ["board", "wood", "felt", "glass", "sfx", "piano", "nes", "futuristic"]
let files = ["Move", "Capture", "Check", "GenericNotify", "Victory", "Defeat", "Draw", "LowTime"]
var decoded = Set<URL>()
for theme in themes {
    for name in files {
        var url = root.appendingPathComponent("sounds/\(theme)/\(name).mp3")
        if !FileManager.default.fileExists(atPath: url.path) {
            precondition(["board", "wood", "felt", "glass"].contains(theme) && !["Move", "Capture"].contains(name), "Missing sound: \(url.path)")
            url = root.appendingPathComponent("sounds/sfx/\(name).mp3")
        }
        guard decoded.insert(url).inserted else { continue }
        let file = try AVAudioFile(forReading: url)
        precondition(file.length > 0 && file.processingFormat.sampleRate > 0, "Empty MP3: \(url.path)")
        let buffer = AVAudioPCMBuffer(pcmFormat: file.processingFormat, frameCapacity: AVAudioFrameCount(file.length))!
        try file.read(into: buffer)
        let samples = UnsafeBufferPointer(start: buffer.floatChannelData![0], count: Int(buffer.frameLength))
        precondition(samples.allSatisfy { $0.isFinite }, "Non-finite samples: \(url.path)")
        precondition(samples.contains { abs($0) > 0.001 }, "Silent MP3: \(url.path)")
    }
}
let voiceRoot = root.appendingPathComponent("voices", isDirectory: true)
struct VoiceClip: Decodable { let file: String; let role: String }
let clips = try JSONDecoder().decode([VoiceClip].self, from: Data(contentsOf: voiceRoot.appendingPathComponent("catalog.json")))
precondition(clips.count == 968 && Set(clips.map(\.file)).count == 968, "Incomplete coach recording catalog")
precondition(Set(clips.map(\.role)).count == 8, "Expected eight coach voices")
for role in Set(clips.map(\.role)) { precondition(clips.filter { $0.role == role }.count == 121, "Incomplete voice pack: \(role)") }
for clip in clips {
    let url = voiceRoot.appendingPathComponent(clip.role, isDirectory: true).appendingPathComponent(clip.file)
    let file = try AVAudioFile(forReading: url)
    precondition(file.length > 0 && file.processingFormat.sampleRate == 24000 && file.processingFormat.channelCount == 1, "Invalid coach recording: \(clip.file)")
    let buffer = AVAudioPCMBuffer(pcmFormat: file.processingFormat, frameCapacity: AVAudioFrameCount(file.length))!
    try file.read(into: buffer)
    let samples = UnsafeBufferPointer(start: buffer.floatChannelData![0], count: Int(buffer.frameLength))
    precondition(samples.allSatisfy { $0.isFinite } && samples.contains { abs($0) > 0.001 }, "Silent coach recording: \(clip.file)")
}
let config = try JSONSerialization.jsonObject(with: Data(contentsOf: root.deletingLastPathComponent().appendingPathComponent("capacitor.config.json"))) as! [String: Any]
precondition((config["packageClassList"] as? [String])?.contains("SoundNativePlugin") == true, "Native sound plugin was not registered")
print("PASS: \(decoded.count) bundled MP3s decode; 968 coach M4As decode and SoundNativePlugin is present")
