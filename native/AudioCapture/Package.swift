// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "AudioCapture",
    platforms: [.macOS(.v14)],
    targets: [
        .executableTarget(name: "AudioCapture", path: "Sources/AudioCapture")
    ]
)
