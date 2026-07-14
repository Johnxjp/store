import Foundation

/// Usage: audio-capture --dir <recording-dir>
///
/// Starts capturing immediately: microphone -> mic.wav, system audio -> system.wav.
/// Emits newline-delimited JSON events on stdout:
///   {"event":"started","micFile":"mic.wav","systemFile":"system.wav",
///    "micEpochMs":...,"systemEpochMs":...,"micSampleRate":...}
///   {"event":"stopped","durationMs":...}
///   {"event":"error","message":"..."}
/// Stops on a "stop" line on stdin, or on stdin EOF.
@main
struct AudioCaptureMain {
    static func main() async {
        let args = CommandLine.arguments
        guard args.count >= 3, args[1] == "--dir" else {
            Events.error("usage: audio-capture --dir <recording-dir>")
            exit(1)
        }
        let dir = URL(fileURLWithPath: args[2], isDirectory: true)
        do {
            try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        } catch {
            Events.error("cannot create recording dir: \(error.localizedDescription)")
            exit(1)
        }

        let mic = MicRecorder()
        let system = SystemAudioRecorder()

        do {
            try mic.start(url: dir.appendingPathComponent("mic.wav"))
            try await system.start(url: dir.appendingPathComponent("system.wav"))
        } catch {
            Events.error("failed to start capture: \(error)")
            exit(1)
        }

        // Both streams deliver buffers continuously (silence included), so
        // waiting for the first buffer of each gives reliable epoch anchors.
        // Bluetooth mics can take several seconds to switch into their
        // hands-free input profile before any buffers flow.
        let deadline = Date().addingTimeInterval(15)
        while (mic.firstBufferEpochMs == nil || system.firstBufferEpochMs == nil), Date() < deadline {
            try? await Task.sleep(nanoseconds: 50_000_000)
        }
        guard let micEpochMs = mic.firstBufferEpochMs, let systemEpochMs = system.firstBufferEpochMs else {
            Events.error("timed out waiting for first audio buffers (mic: \(mic.firstBufferEpochMs != nil), system: \(system.firstBufferEpochMs != nil))")
            mic.stop()
            await system.stop()
            exit(1)
        }

        Events.emit([
            "event": "started",
            "micFile": "mic.wav",
            "systemFile": "system.wav",
            "micEpochMs": micEpochMs,
            "systemEpochMs": systemEpochMs,
            "micSampleRate": mic.sampleRate,
        ])

        let startedAt = Date()
        do {
            for try await line in FileHandle.standardInput.bytes.lines {
                if line.trimmingCharacters(in: .whitespaces) == "stop" { break }
            }
        } catch {
            // stdin closed uncleanly — treat as stop
        }

        mic.stop()
        await system.stop()
        let durationMs = Int(Date().timeIntervalSince(startedAt) * 1000)
        Events.emit(["event": "stopped", "durationMs": durationMs])
    }
}
