import Foundation

/// Writes a 16-bit PCM mono WAV file incrementally. The RIFF size fields are
/// re-patched periodically so the file stays playable even if the process dies.
final class WavWriter {
    private let handle: FileHandle
    private let sampleRate: Int
    private var dataBytes: Int = 0
    private var appendsSinceHeaderPatch = 0
    private let lock = NSLock()
    private var finalized = false

    private(set) var samplesWritten: Int = 0

    init(url: URL, sampleRate: Int) throws {
        self.sampleRate = sampleRate
        FileManager.default.createFile(atPath: url.path, contents: nil)
        self.handle = try FileHandle(forWritingTo: url)
        try handle.write(contentsOf: Self.header(sampleRate: sampleRate, dataBytes: 0))
    }

    func append(_ samples: [Int16]) {
        lock.lock()
        defer { lock.unlock() }
        guard !finalized else { return }
        samples.withUnsafeBufferPointer { buf in
            let data = Data(buffer: buf)
            try? handle.write(contentsOf: data)
            dataBytes += data.count
        }
        samplesWritten += samples.count
        appendsSinceHeaderPatch += 1
        if appendsSinceHeaderPatch >= 10 {
            patchHeader()
            appendsSinceHeaderPatch = 0
        }
    }

    func finalize() {
        lock.lock()
        defer { lock.unlock() }
        guard !finalized else { return }
        finalized = true
        patchHeader()
        try? handle.close()
    }

    private func patchHeader() {
        let header = Self.header(sampleRate: sampleRate, dataBytes: dataBytes)
        try? handle.seek(toOffset: 0)
        try? handle.write(contentsOf: header)
        _ = try? handle.seekToEnd()
    }

    private static func header(sampleRate: Int, dataBytes: Int) -> Data {
        var d = Data()
        func str(_ s: String) { d.append(contentsOf: Array(s.utf8)) }
        func u32(_ v: UInt32) { withUnsafeBytes(of: v.littleEndian) { d.append(contentsOf: $0) } }
        func u16(_ v: UInt16) { withUnsafeBytes(of: v.littleEndian) { d.append(contentsOf: $0) } }
        let channels = 1, bits = 16
        let byteRate = sampleRate * channels * bits / 8
        str("RIFF"); u32(UInt32(36 + dataBytes)); str("WAVE")
        str("fmt "); u32(16); u16(1); u16(UInt16(channels))
        u32(UInt32(sampleRate)); u32(UInt32(byteRate))
        u16(UInt16(channels * bits / 8)); u16(UInt16(bits))
        str("data"); u32(UInt32(dataBytes))
        return d
    }
}
