import AudioToolbox
import CoreAudio
import Foundation

/// Captures system (loopback) audio via a CoreAudio process tap and writes
/// 16-bit mono WAV. Unlike ScreenCaptureKit, taps are classified as "System
/// Audio Recording Only" — no screen-recording indicator. Own-process audio
/// is irrelevant here: this helper never plays sound.
final class SystemAudioRecorder {
    private var tapID = AudioObjectID(kAudioObjectUnknown)
    private var aggregateID = AudioObjectID(kAudioObjectUnknown)
    private var ioProcID: AudioDeviceIOProcID?
    private var writer: WavWriter?
    private let anchorLock = NSLock()
    private(set) var firstBufferEpochMs: Int64?
    private var sampleRate = 48000
    private var channels = 1

    func start(url: URL) async throws {
        let desc = CATapDescription(monoGlobalTapButExcludeProcesses: [])
        desc.name = "ai-meeting-notes system audio"
        desc.isPrivate = true
        desc.muteBehavior = .unmuted

        var tap = AudioObjectID(kAudioObjectUnknown)
        var status = AudioHardwareCreateProcessTap(desc, &tap)
        guard status == noErr else {
            throw CaptureError(
                "failed to create system audio tap (status \(status)) — check System Audio Recording permission")
        }
        tapID = tap

        var addr = AudioObjectPropertyAddress(
            mSelector: kAudioTapPropertyFormat,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain)
        var asbd = AudioStreamBasicDescription()
        var size = UInt32(MemoryLayout<AudioStreamBasicDescription>.size)
        status = AudioObjectGetPropertyData(tapID, &addr, 0, nil, &size, &asbd)
        guard status == noErr, asbd.mSampleRate > 0 else {
            throw CaptureError("cannot read system audio tap format (status \(status))")
        }
        sampleRate = Int(asbd.mSampleRate)
        channels = max(1, Int(asbd.mChannelsPerFrame))

        writer = try WavWriter(url: url, sampleRate: sampleRate)

        let aggregateDesc: [String: Any] = [
            kAudioAggregateDeviceNameKey as String: "ai-meeting-notes-tap",
            kAudioAggregateDeviceUIDKey as String: UUID().uuidString,
            kAudioAggregateDeviceIsPrivateKey as String: true,
            kAudioAggregateDeviceTapAutoStartKey as String: true,
            kAudioAggregateDeviceTapListKey as String: [
                [
                    kAudioSubTapUIDKey as String: desc.uuid.uuidString,
                    kAudioSubTapDriftCompensationKey as String: true,
                ]
            ],
        ]
        var aggregate = AudioObjectID(kAudioObjectUnknown)
        status = AudioHardwareCreateAggregateDevice(aggregateDesc as CFDictionary, &aggregate)
        guard status == noErr else {
            throw CaptureError("failed to create aggregate device for tap (status \(status))")
        }
        aggregateID = aggregate

        status = AudioDeviceCreateIOProcIDWithBlock(&ioProcID, aggregateID, nil) {
            [weak self] _, inInputData, _, _, _ in
            self?.handle(inInputData)
        }
        guard status == noErr, ioProcID != nil else {
            throw CaptureError("failed to create IO proc for tap (status \(status))")
        }
        status = AudioDeviceStart(aggregateID, ioProcID)
        guard status == noErr else {
            throw CaptureError("failed to start tap aggregate device (status \(status))")
        }
    }

    func stop() async {
        if let ioProcID, aggregateID != AudioObjectID(kAudioObjectUnknown) {
            AudioDeviceStop(aggregateID, ioProcID)
            AudioDeviceDestroyIOProcID(aggregateID, ioProcID)
        }
        ioProcID = nil
        if aggregateID != AudioObjectID(kAudioObjectUnknown) {
            AudioHardwareDestroyAggregateDevice(aggregateID)
            aggregateID = AudioObjectID(kAudioObjectUnknown)
        }
        if tapID != AudioObjectID(kAudioObjectUnknown) {
            AudioHardwareDestroyProcessTap(tapID)
            tapID = AudioObjectID(kAudioObjectUnknown)
        }
        writer?.finalize()
    }

    /// The tap delivers float32 PCM in the format reported by
    /// kAudioTapPropertyFormat (mono mixdown requested, but average whatever
    /// channels arrive to stay safe).
    private func handle(_ list: UnsafePointer<AudioBufferList>) {
        let buffers = UnsafeMutableAudioBufferListPointer(UnsafeMutablePointer(mutating: list))
        guard let buf = buffers.first, let ptr = buf.mData else { return }
        let totalFloats = Int(buf.mDataByteSize) / MemoryLayout<Float>.size
        guard totalFloats > 0 else { return }
        let floats = UnsafeBufferPointer(start: ptr.assumingMemoryBound(to: Float.self), count: totalFloats)

        let ch = max(1, channels)
        let frames = totalFloats / ch
        guard frames > 0 else { return }
        let samples: [Int16] = (0..<frames).map { i in
            var sum: Float = 0
            for c in 0..<ch { sum += floats[i * ch + c] }
            let v = max(-1, min(1, sum / Float(ch)))
            return Int16(v * Float(Int16.max))
        }

        anchorLock.lock()
        if firstBufferEpochMs == nil {
            let bufferDurationMs = Int64(Double(frames) / Double(sampleRate) * 1000)
            firstBufferEpochMs = Int64(Date().timeIntervalSince1970 * 1000) - bufferDurationMs
        }
        anchorLock.unlock()
        writer?.append(samples)
    }
}
