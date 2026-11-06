// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Vibtra
import Foundation
import Security

final class CASignerFixture {
    static let otherHelper = URL(fileURLWithPath: "/usr/bin/nc")

    let store = SoftwareCAKeyStore()
    let signer: CASigner
    private let directory: URL
    private var clients: [SignerClient] = []

    static func helperRequirement() throws -> String {
        let process = Process()
        let input = Pipe()
        let output = Pipe()
        process.executableURL = SignerHelper.perl
        process.arguments = ["-e", "syswrite(STDOUT, qq(up\\n)); sysread(STDIN, my $x, 1)"]
        process.standardInput = input
        process.standardOutput = output
        try process.run()
        defer {
            try? input.fileHandleForWriting.close()
            process.waitUntilExit()
        }
        guard output.fileHandleForReading.readData(ofLength: 3) == Data("up\n".utf8) else { throw IntegrationError("the helper's interpreter did not start") }
        var code: SecCode?
        var staticCode: SecStaticCode?
        var info: CFDictionary?
        guard SecCodeCopyGuestWithAttributes(nil, [kSecGuestAttributePid: process.processIdentifier] as CFDictionary, SecCSFlags(), &code) == errSecSuccess,
              let code, SecCodeCopyStaticCode(code, SecCSFlags(), &staticCode) == errSecSuccess, let staticCode,
              SecCodeCopySigningInformation(staticCode, SecCSFlags(rawValue: kSecCSSigningInformation), &info) == errSecSuccess,
              let cdhash = (info as? [String: Any])?[kSecCodeInfoUnique as String] as? Data else {
            throw IntegrationError("no cdhash for the running helper interpreter")
        }
        return "cdhash H\"\(cdhash.map { String(format: "%02x", $0) }.joined())\""
    }

    init(requirement: String?) throws {
        directory = try IntegrationPaths.temporaryDirectory("ca")
        signer = CASigner(requirement: requirement, store: store, directory: directory)
        signer.start()
        guard FileManager.default.fileExists(atPath: signer.socketPath) else { throw IntegrationError("ca signer not listening on \(signer.socketPath)") }
    }

    func connect(_ helper: SignerHelper = .relay) throws -> SignerClient {
        try track(SignerClient(executable: SignerHelper.perl, arguments: helper.arguments(socket: signer.socketPath)))
    }

    func connectOtherHelper() throws -> SignerClient {
        try track(SignerClient(executable: Self.otherHelper, arguments: ["-U", signer.socketPath]))
    }

    private func track(_ client: SignerClient) -> SignerClient {
        clients.append(client)
        return client
    }

    func session() throws -> SignerClient {
        let client = try connect()
        let greeting = client.line()
        guard greeting == "ready" else { throw IntegrationError("ca signer greeted the helper with \(greeting ?? "nothing")") }
        return client
    }

    func tearDown() {
        clients.forEach { $0.close() }
        clients = []
        try? FileManager.default.removeItem(at: directory)
    }
}

final class SignerClient {
    private let process = Process()
    private let input = Pipe()
    private let output = Pipe()
    private let condition = NSCondition()
    private var buffer = Data()
    private var ended = false

    init(executable: URL, arguments: [String]) throws {
        process.executableURL = executable
        process.arguments = arguments
        process.standardInput = input
        process.standardOutput = output
        process.standardError = FileHandle.nullDevice
        output.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            if data.isEmpty { handle.readabilityHandler = nil }
            self?.received(data)
        }
        try process.run()
    }

    private func received(_ data: Data) {
        condition.withLock {
            if data.isEmpty { ended = true } else { buffer.append(data) }
            condition.broadcast()
        }
    }

    func line(timeout: TimeInterval = 10) -> String? {
        let deadline = Date().addingTimeInterval(timeout)
        return condition.withLock {
            while true {
                if let end = buffer.firstIndex(of: 10) {
                    let line = String(decoding: buffer[buffer.startIndex..<end], as: UTF8.self)
                    buffer.removeSubrange(buffer.startIndex...end)
                    return line
                }
                if ended || !condition.wait(until: deadline) { return nil }
            }
        }
    }

    func closes(timeout: TimeInterval = 10) -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        return condition.withLock {
            while !ended {
                if !condition.wait(until: deadline) { return false }
            }
            return buffer.isEmpty
        }
    }

    func write(_ bytes: Data) {
        try? input.fileHandleForWriting.write(contentsOf: bytes)
    }

    func send(_ request: String) -> String? {
        write(Data((request + "\n").utf8))
        return line()
    }

    func close() {
        try? input.fileHandleForWriting.close()
        if process.isRunning { process.terminate() }
        process.waitUntilExit()
    }
}
