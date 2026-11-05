// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Vibtra
import Darwin
import Foundation
import Security

struct LocalResponse {
    let status: Int
    let headers: [String: String]
    let body: Data

    var text: String { String(decoding: body, as: UTF8.self) }
    func json() -> [String: Any]? { (try? JSONSerialization.jsonObject(with: body)) as? [String: Any] }
}

enum LocalHTTP {
    static let session: URLSession = {
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = 10
        config.requestCachePolicy = .reloadIgnoringLocalCacheData
        config.connectionProxyDictionary = [:]
        return URLSession(configuration: config)
    }()

    static func request(_ method: String, _ url: URL, headers: [String: String] = [:], body: Data? = nil) throws -> LocalResponse {
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.httpBody = body
        for (name, value) in headers { request.setValue(value, forHTTPHeaderField: name) }
        let done = DispatchSemaphore(value: 0)
        let box = ResponseBox()
        session.dataTask(with: request) { data, response, error in
            box.set(data: data, response: response as? HTTPURLResponse, error: error)
            done.signal()
        }.resume()
        guard done.wait(timeout: .now() + 15) == .success else { throw IntegrationError("\(method) \(url) did not answer") }
        let (data, response, error) = box.get()
        if let error { throw error }
        guard let response else { throw IntegrationError("\(method) \(url): no HTTP response") }
        var fields: [String: String] = [:]
        for (name, value) in response.allHeaderFields {
            if let name = name as? String, let value = value as? String { fields[name.lowercased()] = value }
        }
        return LocalResponse(status: response.statusCode, headers: fields, body: data ?? Data())
    }
}

final class ResponseBox: @unchecked Sendable {
    private let lock = NSLock()
    private var value: (Data?, HTTPURLResponse?, Error?) = (nil, nil, nil)
    func set(data: Data?, response: HTTPURLResponse?, error: Error?) { lock.withLock { value = (data, response, error) } }
    func get() -> (Data?, HTTPURLResponse?, Error?) { lock.withLock { value } }
}

enum PEM {
    static func blocks(_ text: String) -> [String] {
        var out: [String] = []
        var current: [String]?
        for line in text.components(separatedBy: .newlines) {
            if line.hasPrefix("-----BEGIN CERTIFICATE-----") { current = [line] }
            else if current != nil {
                current?.append(line)
                if line.hasPrefix("-----END CERTIFICATE-----"), let block = current {
                    out.append(block.joined(separator: "\n"))
                    current = nil
                }
            }
        }
        return out
    }

    static func certificate(_ block: String) -> SecCertificate? {
        let body = block.components(separatedBy: .newlines).filter { !$0.hasPrefix("-----") }.joined()
        guard let der = Data(base64Encoded: body) else { return nil }
        return SecCertificateCreateWithData(nil, der as CFData)
    }
}

final class GuardAgent {
    let binary: URL
    let workDir: URL
    let dataDir: URL
    let logURL: URL
    let proxyPort: UInt16
    let localPort: UInt16
    let transparentPort: UInt16
    private var process: Process?

    init() throws {
        binary = try IntegrationPaths.agentBinary()
        workDir = try IntegrationPaths.temporaryDirectory("agent")
        dataDir = workDir.appendingPathComponent("profile", isDirectory: true)
        logURL = workDir.appendingPathComponent("agent.log")
        FileManager.default.createFile(atPath: logURL.path, contents: nil)
        proxyPort = LoopbackPort.free()
        localPort = LoopbackPort.free()
        transparentPort = LoopbackPort.free()
        guard ![proxyPort, localPort, transparentPort].contains(0), Set([proxyPort, localPort, transparentPort]).count == 3 else {
            throw IntegrationError("no free loopback ports for the agent")
        }
    }

    var environment: [String: String] {
        var env = ProcessInfo.processInfo.environment
        env["VIBTRA_GUARD_DIR"] = dataDir.path
        return env
    }

    var pid: pid_t { process?.processIdentifier ?? 0 }
    var isRunning: Bool { process?.isRunning ?? false }

    @discardableResult
    func command(_ arguments: [String], timeout: TimeInterval = 30) throws -> CommandResult {
        try Command.run(binary, ["--data-dir", dataDir.path] + arguments, environment: environment, timeout: timeout)
    }

    func enrol(server: String, token: String) throws -> CommandResult {
        try command(["enrol", "--server", server, "--token", token])
    }

    func enrol(_ registry: FakeRegistry) throws {
        let result = try enrol(server: registry.baseURL, token: registry.enrolToken)
        guard result.status == 0 else { throw IntegrationError("enrol exited \(result.status): \(result.output)") }
    }

    func start(upstreams: [String: UInt16] = [:], syncEvery: Int = 1) throws {
        var arguments = ["--data-dir", dataDir.path, "run",
                         "--proxy", "127.0.0.1:\(proxyPort)", "--local", "127.0.0.1:\(localPort)",
                         "--transparent", "127.0.0.1:\(transparentPort)", "--sync-every", String(syncEvery)]
        if !upstreams.isEmpty {
            arguments += ["--upstream-map", upstreams.keys.sorted().map { "\($0)=http://127.0.0.1:\(upstreams[$0] ?? 0)" }.joined(separator: ",")]
        }
        let process = Process()
        process.executableURL = binary
        process.arguments = arguments
        process.environment = environment
        let log = try FileHandle(forWritingTo: logURL)
        log.seekToEndOfFile()
        process.standardOutput = log
        process.standardError = log
        process.standardInput = FileHandle.nullDevice
        try process.run()
        self.process = process
        guard Wait.until(15, { (try? self.get("/healthz").status) == 200 }) else {
            throw IntegrationError("the agent never answered /healthz on 127.0.0.1:\(localPort)\n\(logTail())")
        }
    }

    func stop() {
        guard let process else { return }
        self.process = nil
        guard process.isRunning else { return }
        kill(process.processIdentifier, SIGCONT)
        process.terminate()
        if !Wait.until(5, { !process.isRunning }) { kill(process.processIdentifier, SIGKILL) }
        process.waitUntilExit()
    }

    func remove() {
        stop()
        try? FileManager.default.removeItem(at: workDir)
    }

    func url(_ path: String) -> URL { URL(string: "http://127.0.0.1:\(localPort)\(path)")! }

    func get(_ path: String, headers: [String: String] = [:]) throws -> LocalResponse {
        try LocalHTTP.request("GET", url(path), headers: headers)
    }

    func status() throws -> [String: Any] {
        guard let json = try get("/status", headers: ["Accept": "application/json"]).json() else { throw IntegrationError("/status was not JSON") }
        return json
    }

    func activity() throws -> [[String: Any]] {
        try get("/activity", headers: ["Accept": "application/json"]).json()?["events"] as? [[String: Any]] ?? []
    }

    func waitForStatus(_ limit: TimeInterval = 15, _ condition: ([String: Any]) -> Bool) -> [String: Any]? {
        var last: [String: Any]?
        let ok = Wait.until(limit, every: 0.1) {
            last = try? self.status()
            return last.map(condition) ?? false
        }
        return ok ? last : nil
    }

    func waitForActivity(_ limit: TimeInterval = 15, _ condition: ([[String: Any]]) -> Bool) -> [[String: Any]]? {
        var last: [[String: Any]] = []
        let ok = Wait.until(limit, every: 0.1) {
            last = (try? self.activity()) ?? []
            return condition(last)
        }
        return ok ? last : nil
    }

    func caCertificate() throws -> SecCertificate {
        let text = try String(contentsOf: dataDir.appendingPathComponent("ca.pem"), encoding: .utf8)
        guard let block = PEM.blocks(text).first, let certificate = PEM.certificate(block) else {
            throw IntegrationError("the agent's ca.pem is not a certificate")
        }
        return certificate
    }

    func profileFile(_ name: String) -> URL { dataDir.appendingPathComponent(name) }

    func logTail(_ count: Int = 60) -> String {
        let text = (try? String(contentsOf: logURL, encoding: .utf8)) ?? ""
        return text.components(separatedBy: "\n").suffix(count).joined(separator: "\n")
    }
}
