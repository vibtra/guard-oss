// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Vibtra
import Foundation
import Network

struct HTTPMessage {
    let startLine: String
    let headers: [String: String]
    let body: Data

    var method: String { startLine.split(separator: " ").first.map(String.init) ?? "" }
    var path: String { startLine.split(separator: " ").dropFirst().first.map(String.init) ?? "" }
    var status: Int { startLine.split(separator: " ").dropFirst().first.flatMap { Int($0) } ?? 0 }
    var text: String { String(decoding: body, as: UTF8.self) }

    func json() -> [String: Any]? { (try? JSONSerialization.jsonObject(with: body)) as? [String: Any] }
}

struct HTTPReply {
    var status: Int
    var headers: [String: String] = [:]
    var body = Data()

    static func json(_ status: Int, _ value: JSONValue) -> HTTPReply {
        HTTPReply(status: status, headers: ["Content-Type": "application/json"], body: value.canonical)
    }

    static func text(_ status: Int, _ text: String) -> HTTPReply {
        HTTPReply(status: status, headers: ["Content-Type": "text/plain; charset=utf-8"], body: Data(text.utf8))
    }
}

enum HTTPWire {
    private static let headerEnd = Data("\r\n\r\n".utf8)

    static func parse(_ data: Data, complete: Bool) -> HTTPMessage? {
        guard let end = data.range(of: headerEnd) else { return nil }
        let head = String(decoding: data[data.startIndex..<end.lowerBound], as: UTF8.self)
        var lines = head.components(separatedBy: "\r\n")
        guard !lines.isEmpty else { return nil }
        let startLine = lines.removeFirst()
        var headers: [String: String] = [:]
        for line in lines {
            guard let colon = line.firstIndex(of: ":") else { continue }
            let name = line[..<colon].trimmingCharacters(in: .whitespaces).lowercased()
            let value = line[line.index(after: colon)...].trimmingCharacters(in: .whitespaces)
            headers[name] = headers[name].map { "\($0), \(value)" } ?? value
        }
        let rest = Data(data[end.upperBound...])
        if headers["transfer-encoding"]?.lowercased().contains("chunked") == true {
            guard let body = dechunk(rest) else { return complete ? HTTPMessage(startLine: startLine, headers: headers, body: rest) : nil }
            return HTTPMessage(startLine: startLine, headers: headers, body: body)
        }
        if let length = headers["content-length"].flatMap({ Int($0) }) {
            guard rest.count >= length else { return nil }
            return HTTPMessage(startLine: startLine, headers: headers, body: rest.prefix(length))
        }
        if startLine.hasPrefix("HTTP/") && !complete { return nil }
        return HTTPMessage(startLine: startLine, headers: headers, body: rest)
    }

    private static func dechunk(_ data: Data) -> Data? {
        var out = Data()
        var cursor = data.startIndex
        let crlf = Data("\r\n".utf8)
        while true {
            guard let lineEnd = data.range(of: crlf, in: cursor..<data.endIndex) else { return nil }
            let sizeText = String(decoding: data[cursor..<lineEnd.lowerBound], as: UTF8.self).split(separator: ";").first ?? ""
            guard let size = Int(sizeText.trimmingCharacters(in: .whitespaces), radix: 16) else { return nil }
            cursor = lineEnd.upperBound
            if size == 0 { return out }
            guard data.distance(from: cursor, to: data.endIndex) >= size + 2 else { return nil }
            let chunkEnd = data.index(cursor, offsetBy: size)
            out.append(data[cursor..<chunkEnd])
            cursor = data.index(chunkEnd, offsetBy: 2)
        }
    }

    static func encode(_ reply: HTTPReply) -> Data {
        let reason: String
        switch reply.status {
        case 200: reason = "OK"
        case 400: reason = "Bad Request"
        case 401: reason = "Unauthorized"
        case 403: reason = "Forbidden"
        case 404: reason = "Not Found"
        default: reason = "Status"
        }
        var head = "HTTP/1.1 \(reply.status) \(reason)\r\n"
        for (name, value) in reply.headers.sorted(by: { $0.key < $1.key }) { head += "\(name): \(value)\r\n" }
        head += "Content-Length: \(reply.body.count)\r\nConnection: close\r\n\r\n"
        return Data(head.utf8) + reply.body
    }

    static func request(_ method: String, host: String, path: String, headers: [(String, String)] = [], body: Data? = nil) -> Data {
        var head = "\(method) \(path) HTTP/1.1\r\nHost: \(host)\r\n"
        for (name, value) in headers { head += "\(name): \(value)\r\n" }
        if let body { head += "Content-Length: \(body.count)\r\n" }
        head += "Connection: close\r\n\r\n"
        return Data(head.utf8) + (body ?? Data())
    }
}

final class HTTPStub: @unchecked Sendable {
    private let listener: NWListener
    private let queue = DispatchQueue(label: "app.vibtra.guard.integration.http")
    private let lock = NSLock()
    private var recorded: [HTTPMessage] = []
    private var connections: [NWConnection] = []
    private var handlerValue: (HTTPMessage) -> HTTPReply = { _ in .text(404, "no handler") }

    init() throws {
        let params = NWParameters.tcp
        params.requiredLocalEndpoint = .hostPort(host: "127.0.0.1", port: .any)
        listener = try NWListener(using: params)
        listener.newConnectionHandler = { [weak self] connection in self?.serve(connection) }
        let ready = DispatchSemaphore(value: 0)
        listener.stateUpdateHandler = { state in if case .ready = state { ready.signal() } }
        listener.start(queue: queue)
        guard ready.wait(timeout: .now() + 5) == .success, port != 0 else { throw IntegrationError("the HTTP stub did not start") }
    }

    var handler: (HTTPMessage) -> HTTPReply {
        get { lock.withLock { handlerValue } }
        set { lock.withLock { handlerValue = newValue } }
    }

    var port: UInt16 { listener.port?.rawValue ?? 0 }
    var baseURL: String { "http://127.0.0.1:\(port)" }
    var requests: [HTTPMessage] { lock.withLock { recorded } }

    private func serve(_ connection: NWConnection) {
        lock.withLock { connections.append(connection) }
        connection.start(queue: queue)
        var buffer = Data()
        func read() {
            connection.receive(minimumIncompleteLength: 1, maximumLength: 65_536) { [weak self] data, _, done, error in
                guard let self else { return }
                if let data { buffer.append(data) }
                if let request = HTTPWire.parse(buffer, complete: done) {
                    self.lock.withLock { self.recorded.append(request) }
                    let reply = self.handler(request)
                    connection.send(content: HTTPWire.encode(reply), completion: .contentProcessed { _ in connection.cancel() })
                    return
                }
                if done || error != nil {
                    connection.cancel()
                    return
                }
                read()
            }
        }
        read()
    }

    func stop() {
        listener.cancel()
        let open = lock.withLock { connections }
        open.forEach { $0.cancel() }
    }
}
