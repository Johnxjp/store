import AVFoundation
import Foundation

/// Captures the default microphone via AVAudioEngine at the device's native
/// format and writes 16-bit mono WAV. No resampling here — the WAV header
/// carries the native sample rate and ffmpeg converts later.
final class MicRecorder {
    private let engine = AVAudioEngine()
    private var writer: WavWriter?
    private let anchorLock = NSLock()
    private(set) var firstBufferEpochMs: Int64?

    var sampleRate: Int { Int(engine.inputNode.outputFormat(forBus: 0).sampleRate) }

    func start(url: URL) throws {
        let input = engine.inputNode
        // Apple's voice-processing unit (AEC) subtracts whatever the Mac is
        // playing from the mic signal, so speaker bleed of the far side never
        // reaches the recording. Must be enabled before reading the format —
        // it changes the node's I/O format.
        do {
            try input.setVoiceProcessingEnabled(true)
        } catch {
            throw CaptureError("failed to enable voice processing (AEC): \(error)")
        }
        // Voice processing ducks other apps' audio by default; the system
        // recorder is capturing that same audio, so keep ducking minimal.
        input.voiceProcessingOtherAudioDuckingConfiguration =
            AVAudioVoiceProcessingOtherAudioDuckingConfiguration(
                enableAdvancedDucking: false, duckingLevel: .min)
        let format = input.outputFormat(forBus: 0)
        guard format.sampleRate > 0, format.channelCount > 0 else {
            throw CaptureError("microphone reports invalid format (no input device?)")
        }
        let writer = try WavWriter(url: url, sampleRate: Int(format.sampleRate))
        self.writer = writer

        input.installTap(onBus: 0, bufferSize: 4096, format: format) { [weak self] buffer, _ in
            guard let self else { return }
            self.anchorLock.lock()
            if self.firstBufferEpochMs == nil {
                let bufferDurationMs = Int64(Double(buffer.frameLength) / format.sampleRate * 1000)
                self.firstBufferEpochMs = Int64(Date().timeIntervalSince1970 * 1000) - bufferDurationMs
            }
            self.anchorLock.unlock()
            writer.append(Self.monoInt16(from: buffer))
        }
        engine.prepare()
        try engine.start()
    }

    func stop() {
        engine.inputNode.removeTap(onBus: 0)
        engine.stop()
        writer?.finalize()
    }

    private static func monoInt16(from buffer: AVAudioPCMBuffer) -> [Int16] {
        let frames = Int(buffer.frameLength)
        let channels = Int(buffer.format.channelCount)
        guard frames > 0 else { return [] }
        var out = [Int16](repeating: 0, count: frames)

        if let floatData = buffer.floatChannelData {
            for i in 0..<frames {
                var sum: Float = 0
                for ch in 0..<channels { sum += floatData[ch][i] }
                let v = max(-1, min(1, sum / Float(channels)))
                out[i] = Int16(v * Float(Int16.max))
            }
        } else if let int16Data = buffer.int16ChannelData {
            for i in 0..<frames {
                var sum = 0
                for ch in 0..<channels { sum += Int(int16Data[ch][i]) }
                out[i] = Int16(sum / channels)
            }
        }
        return out
    }
}

struct CaptureError: Error, CustomStringConvertible {
    let description: String
    init(_ message: String) { description = message }
}
