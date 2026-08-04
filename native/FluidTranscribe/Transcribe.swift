// Parakeet v2 CoreML transcription helper, compiled together with FluidAudio's
// ASR sources by scripts/build-native.sh (SwiftPM is broken on this machine),
// so no `import FluidAudio`. Dumb pipe per project convention: transcribe one
// WAV, write word-level timings as JSON, exit. Sentence assembly, stream
// merging and all orchestration live in TypeScript.
import AVFoundation
import Foundation

@main
struct Transcribe {
    static func main() async {
        let args = CommandLine.arguments
        guard args.count == 4 else {
            FileHandle.standardError.write(
                Data("usage: fluid-transcribe <models-root-dir> <wav> <out.json>\n".utf8))
            exit(1)
        }
        let modelsRoot = URL(fileURLWithPath: args[1])
        let wav = URL(fileURLWithPath: args[2])
        let outPath = args[3]

        let version = AsrModelVersion.v2
        let modelDir = modelsRoot.appendingPathComponent(version.repo.folderName)
        do {
            let models = try await AsrModels.downloadAndLoad(to: modelDir, version: version)
            let manager = AsrManager(config: .default)
            try await manager.loadModels(models)

            var state = TdtDecoderState.make(decoderLayers: await manager.decoderLayerCount)
            let result = try await manager.transcribe(wav, decoderState: &state)

            let words = buildWordTimings(from: result.tokenTimings ?? []).map { w in
                Word(word: w.word, start: w.startTime, end: w.endTime)
            }
            let output = Output(words: words)
            let encoder = JSONEncoder()
            try encoder.encode(output).write(to: URL(fileURLWithPath: outPath), options: .atomic)
            FileHandle.standardError.write(
                Data(
                    String(
                        format: "transcribed in %.1fs, %d words\n",
                        result.processingTime, words.count
                    ).utf8))
        } catch {
            FileHandle.standardError.write(Data("error: \(error)\n".utf8))
            exit(1)
        }
    }
}

struct Word: Codable {
    let word: String
    let start: Double
    let end: Double
}

struct Output: Codable {
    let words: [Word]
}
