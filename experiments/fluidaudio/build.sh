#!/bin/bash
# Builds fluid-transcribe with plain swiftc (SwiftPM is broken on this machine —
# see CLAUDE.md). Compiles FluidAudio's Parakeet ASR + Shared sources directly,
# skipping TTS/Diarizer/VAD/ITN and the NemoTextProcessing binary dependency.
# Usage: FLUIDAUDIO_SRC=/path/to/FluidAudio ./build.sh
set -euo pipefail
cd "$(dirname "$0")"

SRC="${FLUIDAUDIO_SRC:?set FLUIDAUDIO_SRC to a FluidAudio checkout}"
LIB="$SRC/Sources/FluidAudio"
OUT=build
mkdir -p "$OUT"

clang -c "$SRC/Sources/MachTaskSelfWrapper/MachTaskSelf.c" \
  -I "$SRC/Sources/MachTaskSelfWrapper/include" -o "$OUT/MachTaskSelf.o"

swiftc -O -target arm64-apple-macos14.0 -swift-version 6 -parse-as-library \
  -I "$SRC/Sources/MachTaskSelfWrapper/include" \
  $(find "$LIB/ASR/Parakeet" "$LIB/ASR/Shared" "$LIB/Shared" -name '*.swift') \
  "$LIB/ModelNames.swift" "$LIB/ModelRegistry.swift" "$LIB/FluidAudioSwift.swift" \
  "$LIB/Diarizer/Core/DiarizerTypes.swift" \
  "$LIB/Diarizer/Sortformer/SortformerTypes.swift" \
  "$LIB/TTS/PocketTTS/PocketTtsConstants.swift" \
  Transcribe.swift "$OUT/MachTaskSelf.o" \
  -o "$OUT/fluid-transcribe"

echo "built $OUT/fluid-transcribe"
