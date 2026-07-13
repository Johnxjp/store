#!/bin/bash
# Compiles the Swift helpers with swiftc directly — SwiftPM's manifest tooling
# is broken in this machine's Command Line Tools install (PackageDescription
# link mismatch), and plain swiftc is sufficient for single-target executables.
set -euo pipefail
cd "$(dirname "$0")/.."

mkdir -p resources/bin
swiftc -O -parse-as-library -target arm64-apple-macosx14.0 \
  -o resources/bin/audio-capture \
  native/AudioCapture/Sources/AudioCapture/*.swift
echo "Built helpers: $(ls resources/bin)"
