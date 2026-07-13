import CoreMedia
import Foundation
import ScreenCaptureKit

/// Captures system (loopback) audio via ScreenCaptureKit and writes 16-bit
/// mono WAV at 48 kHz. Own-process audio is excluded so app sounds don't leak
/// into the transcript.
final class SystemAudioRecorder: NSObject, SCStreamOutput, SCStreamDelegate {
    private var stream: SCStream?
    private var writer: WavWriter?
    private let queue = DispatchQueue(label: "system-audio")
    private let anchorLock = NSLock()
    private(set) var firstBufferEpochMs: Int64?

    static let sampleRate = 48000

    func start(url: URL) async throws {
        let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)
        guard let display = content.displays.first else {
            throw CaptureError("no display found for system audio capture")
        }
        writer = try WavWriter(url: url, sampleRate: Self.sampleRate)

        let filter = SCContentFilter(display: display, excludingApplications: [], exceptingWindows: [])
        let config = SCStreamConfiguration()
        config.capturesAudio = true
        config.excludesCurrentProcessAudio = true
        config.sampleRate = Self.sampleRate
        config.channelCount = 2
        config.width = 2
        config.height = 2
        config.minimumFrameInterval = CMTime(value: 1, timescale: 1)

        let stream = SCStream(filter: filter, configuration: config, delegate: self)
        try stream.addStreamOutput(self, type: .audio, sampleHandlerQueue: queue)
        try await stream.startCapture()
        self.stream = stream
    }

    func stop() async {
        if let stream {
            try? await stream.stopCapture()
        }
        stream = nil
        writer?.finalize()
    }

    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .audio, sampleBuffer.isValid else { return }
        let samples = Self.monoInt16(from: sampleBuffer)
        guard !samples.isEmpty else { return }

        anchorLock.lock()
        if firstBufferEpochMs == nil {
            let bufferDurationMs = Int64(Double(samples.count) / Double(Self.sampleRate) * 1000)
            firstBufferEpochMs = Int64(Date().timeIntervalSince1970 * 1000) - bufferDurationMs
        }
        anchorLock.unlock()
        writer?.append(samples)
    }

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        Events.error("system audio stream stopped: \(error.localizedDescription)")
    }

    /// SCK delivers float32 audio (interleaved or not, per the format flags).
    /// Downmix all channels to mono int16.
    private static func monoInt16(from sampleBuffer: CMSampleBuffer) -> [Int16] {
        guard let formatDesc = sampleBuffer.formatDescription,
              let asbd = formatDesc.audioStreamBasicDescription else { return [] }
        let isFloat = asbd.mFormatFlags & kAudioFormatFlagIsFloat != 0
        let isNonInterleaved = asbd.mFormatFlags & kAudioFormatFlagIsNonInterleaved != 0
        guard isFloat else { return [] }

        var out: [Int16] = []
        try? sampleBuffer.withAudioBufferList { audioBufferList, _ in
            let buffers = Array(audioBufferList)
            guard !buffers.isEmpty else { return }

            if isNonInterleaved {
                // One buffer per channel.
                let channelData: [[Float]] = buffers.map { buf in
                    guard let ptr = buf.mData else { return [] }
                    let count = Int(buf.mDataByteSize) / MemoryLayout<Float>.size
                    return Array(UnsafeBufferPointer(start: ptr.assumingMemoryBound(to: Float.self), count: count))
                }
                guard let frames = channelData.first?.count, frames > 0 else { return }
                out = (0..<frames).map { i in
                    var sum: Float = 0
                    for ch in channelData where i < ch.count { sum += ch[i] }
                    let v = max(-1, min(1, sum / Float(channelData.count)))
                    return Int16(v * Float(Int16.max))
                }
            } else {
                guard let ptr = buffers[0].mData else { return }
                let channels = max(1, Int(asbd.mChannelsPerFrame))
                let totalFloats = Int(buffers[0].mDataByteSize) / MemoryLayout<Float>.size
                let floats = UnsafeBufferPointer(start: ptr.assumingMemoryBound(to: Float.self), count: totalFloats)
                let frames = totalFloats / channels
                out = (0..<frames).map { i in
                    var sum: Float = 0
                    for ch in 0..<channels { sum += floats[i * channels + ch] }
                    let v = max(-1, min(1, sum / Float(channels)))
                    return Int16(v * Float(Int16.max))
                }
            }
        }
        return out
    }
}
