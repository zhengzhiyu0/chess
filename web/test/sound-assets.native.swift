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
let speechRoot = root.appendingPathComponent("native/speech", isDirectory: true)
for voice in ["en_US-lessac-medium", "en_US-ryan-medium"] {
    let model = speechRoot.appendingPathComponent("\(voice).onnx")
    let config = speechRoot.appendingPathComponent("\(voice).onnx.json")
    let card = speechRoot.appendingPathComponent("\(voice).MODEL_CARD")
    guard let attributes = try? FileManager.default.attributesOfItem(atPath: model.path),
          let size = attributes[.size] as? NSNumber, size.intValue > 60_000_000,
          let data = try? Data(contentsOf: config),
          let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
          (object["audio"] as? [String: Any])?["sample_rate"] as? Int == 22_050,
          object["phoneme_id_map"] is [String: Any],
          FileManager.default.fileExists(atPath: card.path) else {
        fatalError("Invalid or missing Piper voice assets: \(voice)")
    }
}
let config = try JSONSerialization.jsonObject(with: Data(contentsOf: root.deletingLastPathComponent().appendingPathComponent("capacitor.config.json"))) as! [String: Any]
precondition((config["packageClassList"] as? [String])?.contains("SoundNativePlugin") == true, "Native sound plugin was not registered")
print("PASS: \(decoded.count) bundled MP3s decode; both Piper voices and SoundNativePlugin are present")
