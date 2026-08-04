#!/bin/bash
# Compiles the Swift helpers with swiftc directly — SwiftPM's manifest tooling
# is broken in this machine's Command Line Tools install (PackageDescription
# link mismatch), and plain swiftc is sufficient for single-target executables.
set -euo pipefail
cd "$(dirname "$0")/.."

mkdir -p resources/bin
# macOS 14.2+ for CoreAudio process taps (CATapDescription)
swiftc -O -parse-as-library -target arm64-apple-macosx14.2 \
  -o resources/bin/audio-capture \
  native/AudioCapture/Sources/AudioCapture/*.swift

# fluid-transcribe: parakeet v2 CoreML ASR. Compiles the Parakeet + Shared
# subset of FluidAudio's sources directly (no SwiftPM, no NemoTextProcessing
# binary dep) together with our thin CLI in native/FluidTranscribe.
FLUIDAUDIO_TAG=v0.15.5
VENDOR=native/vendor/FluidAudio
if [ ! -d "$VENDOR" ]; then
  git clone --quiet --depth 1 --branch "$FLUIDAUDIO_TAG" \
    https://github.com/FluidInference/FluidAudio.git "$VENDOR"
fi
LIB="$VENDOR/Sources/FluidAudio"
BUILD=out/native
mkdir -p "$BUILD"

clang -c "$VENDOR/Sources/MachTaskSelfWrapper/MachTaskSelf.c" \
  -I "$VENDOR/Sources/MachTaskSelfWrapper/include" -o "$BUILD/MachTaskSelf.o"

swiftc -O -target arm64-apple-macos14.0 -swift-version 6 -parse-as-library \
  -I "$VENDOR/Sources/MachTaskSelfWrapper/include" \
  $(find "$LIB/ASR/Parakeet" "$LIB/ASR/Shared" "$LIB/Shared" -name '*.swift') \
  "$LIB/ModelNames.swift" "$LIB/ModelRegistry.swift" "$LIB/FluidAudioSwift.swift" \
  "$LIB/Diarizer/Core/DiarizerTypes.swift" \
  "$LIB/Diarizer/Sortformer/SortformerTypes.swift" \
  "$LIB/TTS/PocketTTS/PocketTtsConstants.swift" \
  native/FluidTranscribe/Transcribe.swift "$BUILD/MachTaskSelf.o" \
  -o resources/bin/fluid-transcribe

echo "Built helpers: $(ls resources/bin)"
