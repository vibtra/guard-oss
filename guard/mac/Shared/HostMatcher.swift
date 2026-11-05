// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Vibtra

import Foundation

public enum HostMatcher {
    private static let lock = NSLock()
    nonisolated(unsafe) private static var regexes: [String: NSRegularExpression] = [:]

    public static func normalise(_ host: String) -> String {
        var h = host
        if h.contains(":") && !h.hasPrefix("["), let colon = h.firstIndex(of: ":") {
            h = String(h[..<colon])
        }
        h = h.lowercased()
        if h.hasSuffix(".") { h.removeLast() }
        return h
    }

    private static func regex(for pattern: String) -> NSRegularExpression? {
        lock.lock()
        defer { lock.unlock() }
        if let cached = regexes[pattern] { return cached }
        let escaped = pattern
            .components(separatedBy: "*")
            .map { NSRegularExpression.escapedPattern(for: $0) }
            .joined(separator: "[a-z0-9-]+")
        guard let re = try? NSRegularExpression(pattern: "^\(escaped)$") else { return nil }
        regexes[pattern] = re
        return re
    }

    public static func matches(host: String, pattern: String) -> Bool {
        let h = normalise(host)
        if h.isEmpty { return false }
        if !pattern.contains("*") { return h == pattern || h.hasSuffix(".\(pattern)") }
        guard let re = regex(for: pattern) else { return false }
        let range = NSRange(h.startIndex..<h.endIndex, in: h)
        return re.firstMatch(in: h, options: [], range: range) != nil
    }

    public static func serviceForHost(_ catalogue: GuardCatalogue, host: String) -> GuardService? {
        var best: (service: GuardService, length: Int)?
        for service in catalogue.services where service.enabled {
            for pattern in service.domains where matches(host: host, pattern: pattern) {
                if best == nil || pattern.count > best!.length { best = (service, pattern.count) }
            }
        }
        return best?.service
    }

    public static func serviceForFlow(_ catalogue: GuardCatalogue, host: String, bundleId: String? = nil, cliName: String? = nil) -> GuardService? {
        for service in catalogue.services {
            let owns = (bundleId.map { service.bundleIds.contains($0) } ?? false) || (cliName.map { service.cliNames.contains($0) } ?? false)
            if owns && service.domains.contains(where: { matches(host: host, pattern: $0) }) {
                return service.enabled ? service : nil
            }
        }
        return serviceForHost(catalogue, host: host)
    }

    public static func isIntercepted(_ catalogue: GuardCatalogue, host: String) -> Bool {
        serviceForHost(catalogue, host: host) != nil
    }
}

public struct FlowDecision: Equatable, Sendable {
    public enum Source: String, Sendable { case rule, `default`, exception }
    public var action: GuardFlowAction
    public var source: Source
    public var ruleId: String?
    public var grantId: String?
    public var note: String?

    public static func decide(_ bundle: GuardBundle, serviceId: String) -> FlowDecision {
        if let exception = bundle.exceptions.first(where: { $0.serviceId == serviceId && $0.ruleId == nil }) {
            return FlowDecision(action: .allow, source: .exception, ruleId: nil, grantId: exception.grantId, note: nil)
        }
        if let decision = bundle.services[serviceId] {
            return FlowDecision(action: decision.action, source: decision.ruleId == nil ? .default : .rule, ruleId: decision.ruleId, grantId: nil, note: decision.note)
        }
        return FlowDecision(action: bundle.defaultAction, source: .default, ruleId: nil, grantId: nil, note: nil)
    }

    public func drops(in mode: GuardClientMode) -> Bool {
        mode == .enforce && (action == .block || action == .ask)
    }

    public var eventAction: String {
        switch action {
        case .allow: return "allowed"
        case .block: return "blocked"
        case .ask: return "asked"
        }
    }

    public var ruleKind: String {
        switch source {
        case .rule: return "service"
        case .default: return "default"
        case .exception: return "exception"
        }
    }
}
