// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Vibtra

import Foundation

enum AgentClient {
    static let session: URLSession = {
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = 5
        config.requestCachePolicy = .reloadIgnoringLocalCacheData
        config.connectionProxyDictionary = [:]
        return URLSession(configuration: config)
    }()

    static let streamSession: URLSession = {
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = 3600
        config.timeoutIntervalForResource = 86_400
        config.connectionProxyDictionary = [:]
        return URLSession(configuration: config)
    }()

    static func url(_ path: String) -> URL { GuardConstants.localBase.appendingPathComponent(String(path.drop(while: { $0 == "/" }))) }

    static func blockPage(eventId: String) -> URL { url("/blocked/\(eventId)") }

    private static func localData(_ path: String) async throws -> Data {
        var request = URLRequest(url: url(path))
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        let (data, response) = try await session.data(for: request)
        guard (response as? HTTPURLResponse)?.statusCode == 200 else {
            throw AgentError.http((response as? HTTPURLResponse)?.statusCode ?? 0)
        }
        return data
    }

    static func policy() async throws -> LocalPolicy {
        try JSONDecoder().decode(LocalPolicy.self, from: await localData("/policy"))
    }

    static func activity() async throws -> [DecisionEvent] {
        guard let activity = LocalActivity.parse(try await localData("/activity")) else { throw AgentError.unreadable }
        return activity.events
    }

    static func status() async -> Result<AgentStatus, Error> {
        var request = URLRequest(url: url("/status"))
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        do {
            let (data, response) = try await session.data(for: request)
            guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
                return .failure(AgentError.http((response as? HTTPURLResponse)?.statusCode ?? 0))
            }
            guard let status = AgentStatus.parse(data) else { return .failure(AgentError.unreadable) }
            return .success(status)
        } catch {
            return .failure(error)
        }
    }

    static func requestAccess(eventId: String, note: String?) async -> Result<String, Error> {
        var request = URLRequest(url: url("/blocked/\(eventId)/request"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        var body: [String: Any] = [:]
        if let note, !note.isEmpty { body["note"] = String(note.prefix(500)) }
        request.httpBody = try? JSONSerialization.data(withJSONObject: body)
        do {
            let (data, response) = try await session.data(for: request)
            let code = (response as? HTTPURLResponse)?.statusCode ?? 0
            guard (200..<300).contains(code) else { return .failure(AgentError.http(code)) }
            return .success(askStatus(data) ?? "pending")
        } catch {
            return .failure(error)
        }
    }

    static func askStatus(eventId: String) async -> String? {
        for suffix in ["status", "request"] {
            var request = URLRequest(url: url("/blocked/\(eventId)/\(suffix)"))
            request.setValue("application/json", forHTTPHeaderField: "Accept")
            guard let (data, response) = try? await session.data(for: request),
                  let http = response as? HTTPURLResponse, http.statusCode == 200,
                  let status = askStatus(data) else { continue }
            return status == "none" ? nil : status
        }
        return nil
    }

    static func askStatus(_ data: Data) -> String? {
        guard let root = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else { return nil }
        if let req = root["request"] as? [String: Any], let s = req["status"] as? String { return s }
        if let ask = root["ask"] as? [String: Any], let s = ask["status"] as? String { return s }
        return root["status"] as? String
    }

    static func streamEvents(onOpen: @escaping @Sendable () async -> Void, onMessage: @escaping @Sendable (SSEParser.Message) async -> Void) async throws {
        var request = URLRequest(url: url("/events"))
        request.setValue("text/event-stream", forHTTPHeaderField: "Accept")
        let (bytes, response) = try await streamSession.bytes(for: request)
        guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
            throw AgentError.http((response as? HTTPURLResponse)?.statusCode ?? 0)
        }
        await onOpen()
        var parser = SSEParser()
        var line = Data()
        for try await byte in bytes {
            if byte == 0x0A {
                if let message = parser.feed(String(decoding: line, as: UTF8.self)) { await onMessage(message) }
                line.removeAll(keepingCapacity: true)
            } else {
                line.append(byte)
            }
        }
    }
}

enum AgentError: LocalizedError {
    case http(Int)
    case unreadable

    var errorDescription: String? {
        switch self {
        case .http(let code): return code == 0 ? "the agent did not answer" : "the agent answered HTTP \(code)"
        case .unreadable: return "the agent's status was not JSON"
        }
    }
}
