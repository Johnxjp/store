import Foundation

enum Events {
    private static let lock = NSLock()

    static func emit(_ payload: [String: Any]) {
        lock.lock()
        defer { lock.unlock() }
        guard let data = try? JSONSerialization.data(withJSONObject: payload),
              let line = String(data: data, encoding: .utf8) else { return }
        FileHandle.standardOutput.write(Data((line + "\n").utf8))
    }

    static func error(_ message: String) {
        emit(["event": "error", "message": message])
    }
}
