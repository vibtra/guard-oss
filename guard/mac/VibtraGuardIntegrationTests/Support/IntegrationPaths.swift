// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Vibtra
import Darwin
import Foundation

struct IntegrationError: Error, CustomStringConvertible {
    let description: String
    init(_ description: String) { self.description = description }
}

enum IntegrationPaths {
    static let suiteDir = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
    static let macDir = suiteDir.deletingLastPathComponent()
    static let repoRoot = macDir.deletingLastPathComponent().deletingLastPathComponent()
    static let seedCatalogue = repoRoot.appendingPathComponent("guard/agent-go/catalogue.json")
    static let vectors = repoRoot.appendingPathComponent("packages/guard-contract/src/detectors.vectors.json")

    static func agentBinary() throws -> URL {
        if let env = ProcessInfo.processInfo.environment["VIBTRA_GUARD_AGENT_BIN"], !env.isEmpty, FileManager.default.isExecutableFile(atPath: env) {
            return URL(fileURLWithPath: env)
        }
        let built = repoRoot.appendingPathComponent("guard/agent-go/build/vibtra-guard")
        guard FileManager.default.isExecutableFile(atPath: built.path) else {
            throw IntegrationError("no agent binary at \(built.path): run zsh tests/mac/run.sh or zsh guard/agent-go/build.sh, or set VIBTRA_GUARD_AGENT_BIN")
        }
        return built
    }

    static func temporaryDirectory(_ label: String) throws -> URL {
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("vibtra-guard-it-\(label)-\(UUID().uuidString.prefix(8))", isDirectory: true)
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        return url
    }
}

enum Wait {
    @discardableResult
    static func until(_ limit: TimeInterval, every step: TimeInterval = 0.05, _ condition: () -> Bool) -> Bool {
        let end = Date().addingTimeInterval(limit)
        while Date() < end {
            if condition() { return true }
            Thread.sleep(forTimeInterval: step)
        }
        return condition()
    }
}

enum LoopbackPort {
    static func free() -> UInt16 {
        for _ in 0..<20 {
            let port = bindAndRelease()
            if port != 0, !(9470...9472).contains(port) { return port }
        }
        return 0
    }

    private static func bindAndRelease() -> UInt16 {
        let fd = Darwin.socket(AF_INET, SOCK_STREAM, 0)
        guard fd >= 0 else { return 0 }
        defer { Darwin.close(fd) }
        var addr = sockaddr_in()
        addr.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
        addr.sin_family = sa_family_t(AF_INET)
        addr.sin_addr.s_addr = inet_addr("127.0.0.1")
        addr.sin_port = 0
        var len = socklen_t(MemoryLayout<sockaddr_in>.size)
        let bound = withUnsafeMutablePointer(to: &addr) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { Darwin.bind(fd, $0, len) } }
        guard bound == 0 else { return 0 }
        let named = withUnsafeMutablePointer(to: &addr) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { getsockname(fd, $0, &len) } }
        guard named == 0 else { return 0 }
        return UInt16(bigEndian: addr.sin_port)
    }
}

struct CommandResult {
    let status: Int32
    let output: String
}

enum Command {
    static func run(_ executable: URL, _ arguments: [String], environment: [String: String]? = nil,
                    currentDirectory: URL? = nil, captureErrors: Bool = true, timeout: TimeInterval = 60) throws -> CommandResult {
        let process = Process()
        process.executableURL = executable
        process.arguments = arguments
        if let environment { process.environment = environment }
        if let currentDirectory { process.currentDirectoryURL = currentDirectory }
        let pipe = Pipe()
        process.standardOutput = pipe
        if captureErrors { process.standardError = pipe } else { process.standardError = FileHandle.nullDevice }
        process.standardInput = FileHandle.nullDevice
        let collected = DataBox()
        let drained = DispatchSemaphore(value: 0)
        try process.run()
        DispatchQueue.global(qos: .userInitiated).async {
            collected.set(pipe.fileHandleForReading.readDataToEndOfFile())
            drained.signal()
        }
        if drained.wait(timeout: .now() + timeout) == .timedOut {
            process.terminate()
            _ = drained.wait(timeout: .now() + 5)
            process.waitUntilExit()
            throw IntegrationError("\(executable.lastPathComponent) \(arguments.joined(separator: " ")) did not finish in \(Int(timeout)) s")
        }
        process.waitUntilExit()
        return CommandResult(status: process.terminationStatus, output: String(decoding: collected.get(), as: UTF8.self))
    }
}

final class DataBox: @unchecked Sendable {
    private let lock = NSLock()
    private var value = Data()
    func set(_ data: Data) { lock.withLock { value = data } }
    func get() -> Data { lock.withLock { value } }
}
