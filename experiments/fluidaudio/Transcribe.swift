// Minimal FluidAudio CoreML transcription harness for the parakeet experiment.
// Compiled together with FluidAudio's ASR sources by build.sh (SwiftPM is
// broken on this machine), so no `import FluidAudio`.
import AVFoundation
import Foundation

@main
struct Transcribe {
    static func main() async {
        let args = CommandLine.arguments
        guard args.count >= 3, args[1] == "v2" || args[1] == "v3" else {
            FileHandle.standardError.write(Data("usage: fluid-transcribe <v2|v3> <wav> [out.txt]\n".utf8))
            exit(1)
        }
        let version: AsrModelVersion = args[1] == "v2" ? .v2 : .v3
        let url = URL(fileURLWithPath: args[2])
        do {
            let t0 = Date()
            let models = try await AsrModels.downloadAndLoad(version: version)
            let manager = AsrManager(config: .default)
            try await manager.loadModels(models)
            print(String(format: "load: %.1fs", Date().timeIntervalSince(t0)))

            var state = TdtDecoderState.make(decoderLayers: await manager.decoderLayerCount)
            let t1 = Date()
            let result = try await manager.transcribe(url, decoderState: &state)
            let elapsed = Date().timeIntervalSince(t1)
            print(
                String(
                    format: "transcribe: %.1fs (%.1fx RT), audio %.0fs, %d token timings",
                    elapsed, result.duration / elapsed, result.duration,
                    result.tokenTimings?.count ?? 0))
            if let timings = result.tokenTimings, let first = timings.first, let last = timings.last {
                print(String(format: "first token %.2fs, last token %.2fs", first.startTime, last.endTime))
            }
            if args.count >= 4 {
                try result.text.write(toFile: args[3], atomically: true, encoding: .utf8)
            } else {
                print(result.text.prefix(300))
            }
        } catch {
            FileHandle.standardError.write(Data("error: \(error)\n".utf8))
            exit(1)
        }
    }
}
