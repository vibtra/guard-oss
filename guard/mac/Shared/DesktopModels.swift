// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Vibtra
import Foundation

public struct InspectionFacts: Equatable, Sendable {
    public let state: String
    public let reason: String?
    public let format: String?
    public let textParts: Int
    public let requestCategory: String?
    public let coverageFailure: Bool

    init(json: [String: Any]) {
        state = json["state"] as? String ?? "unknown"
        coverageFailure = json["coverageFailure"] as? Bool ?? false
        requestCategory = json["requestCategory"] as? String
        reason = json["reason"] as? String
        format = json["format"] as? String
        textParts = json["textParts"] as? Int ?? 0
    }

    public var categoryLabel: String? {
        switch requestCategory {
        case "background": return "Background request"
        case "conversation": return "Conversation request"
        case "websocket-message": return "WebSocket message"
        case "session-check": return "Session check"
        case "unclassified": return "Other request"
        default: return nil
        }
    }

    public var label: String {
        if coverageFailure { return "Message could not be checked" }
        if state == "inspected" { return requestCategory == "websocket-message" ? "Message checked" : "Request body checked" }
        if state == "partial" { return "Text fields checked (partial)" }
        switch reason {
        case "no-request-body": return "Service check"
        case "encoded-body": return "Compressed body not checked"
        case "unsupported-content-type": return "Binary body not checked"
        case "body-too-large": return "Body over 4 MB not checked"
        default: return "Service check only"
        }
    }
}

public struct LocalPolicy: Decodable, Equatable, Sendable {
    public struct Rule: Decodable, Equatable, Sendable, Identifiable {
        public let id: String
        public let name: String
        public let action: String
        public let note: String?
        public let detector: String?
        public let source: String?
        public let serviceNames: [String]?
    }
    public let available: Bool
    public let mode: String?
    public let bundleVersion: Int?
    public let services: [Rule]
    public let contentRules: [Rule]
    public let warnings: [String]?
}

public struct LocalActivity {
    public let events: [DecisionEvent]
    public static func parse(_ data: Data) -> LocalActivity? {
        guard let root = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
              let rows = root["events"] as? [[String: Any]] else { return nil }
        return LocalActivity(events: rows.compactMap(DecisionEvent.init(json:)))
    }
}

public enum GuardConsoleLink {
    public static func url(server: String?, handle: String?, page: String = "") -> URL? {
        guard let server, let handle, !handle.isEmpty,
              handle.range(of: "^[a-z0-9][a-z0-9-]*$", options: .regularExpression) != nil,
              var url = URL(string: server), let scheme = url.scheme, ["http", "https"].contains(scheme),
              url.host != nil, url.user == nil, url.password == nil,
              let components = URLComponents(url: url, resolvingAgainstBaseURL: false),
              components.query == nil, components.fragment == nil else { return nil }
        url.appendPathComponent(handle)
        url.appendPathComponent("guard")
        if !page.isEmpty { url.appendPathComponent(page) }
        return url
    }
}
