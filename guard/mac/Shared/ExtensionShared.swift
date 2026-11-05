// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Vibtra

import Foundation

public enum CodexWorkExclusion {
    public static let teamId = "2DC432GLL2"
    public static let signingIds: Set<String> = [
        "com.openai.codex", "com.openai.codex.helper", "com.openai.codex.helper.renderer",
        "com.openai.codex.framework.AlertNotificationService", "codex",
    ]

    public static func isCandidate(signingId: String?, catalogue: GuardCatalogue?) -> Bool {
        guard let signingId, signingIds.contains(signingId), let catalogue else { return false }
        return catalogue.services.contains {
            $0.serviceId == "openai-codex" && !$0.enabled && $0.bundleIds.contains("com.openai.codex")
        }
    }

    public static func shouldBypass(signingId: String?, catalogue: GuardCatalogue?, validSignature: @autoclosure () -> Bool) -> Bool {
        isCandidate(signingId: signingId, catalogue: catalogue) && validSignature()
    }

    public static func requirement(signingId: String) -> String? {
        guard signingIds.contains(signingId) else { return nil }
        return "anchor apple generic and certificate leaf[subject.OU] = \"\(teamId)\" and identifier \"\(signingId)\""
    }
}

@objc public protocol GuardExtensionXPC {
    func update(bundle: Data, catalogue: Data, reply: @escaping (String?) -> Void)
    func drainEvents(reply: @escaping (Data) -> Void)
    func status(reply: @escaping (String) -> Void)
}

public enum ExtensionEvents {
    public static func mintEventId() -> String {
        var bytes = [UInt8](repeating: 0, count: 8)
        for i in bytes.indices { bytes[i] = UInt8.random(in: 0...255) }
        return "gev_" + bytes.map { String(format: "%02x", $0) }.joined()
    }

    private static let iso: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()

    public static func flowEvent(decision: FlowDecision, serviceId: String, host: String, port: Int?, signingId: String?, bundleVersion: Int?, now: Date = Date()) -> [String: Any] {
        var event: [String: Any] = [
            "eventId": mintEventId(),
            "occurredAt": iso.string(from: now),
            "kind": "flow",
            "action": decision.eventAction,
            "serviceId": serviceId,
            "host": String(HostMatcher.normalise(host).prefix(253)),
            "ruleKind": decision.ruleKind,
        ]
        if let port, (1...65535).contains(port) { event["port"] = port }
        if let ruleId = decision.ruleId { event["ruleId"] = ruleId }
        if let signingId, !signingId.isEmpty { event["app"] = ["bundleId": String(signingId.prefix(200))] }
        if let bundleVersion { event["bundleVersion"] = bundleVersion }
        return event
    }

    public static func jsonLine(_ event: [String: Any]) -> Data? {
        guard var data = try? JSONSerialization.data(withJSONObject: event, options: [.sortedKeys]) else { return nil }
        data.append(0x0A)
        return data
    }
}

public enum FlowVerdict: Equatable, Sendable {
    public enum Pass: String, Equatable, Sendable {
        case noCatalogue, notCatalogued, ownAgent, noBundle, noService, monitor, allowed, excludedApp
        case notQUIC
    }

    case allow(Pass)
    case drop(decision: FlowDecision, serviceId: String, signingId: String?)
    case dropQUIC(serviceId: String)

    public static func decide(host: String, signingId: @autoclosure () -> String?, bundle: GuardBundle?, catalogue: GuardCatalogue?,
                              isOwnAgent: (String?) -> Bool = GuardConstants.isOwnAgent(signingId:),
                              excludedApp: @autoclosure () -> Bool = false) -> FlowVerdict {
        guard let catalogue else { return .allow(.noCatalogue) }
        guard !host.isEmpty, HostMatcher.isIntercepted(catalogue, host: host) else { return .allow(.notCatalogued) }
        if excludedApp() { return .allow(.excludedApp) }
        let signing = signingId()
        if isOwnAgent(signing) { return .allow(.ownAgent) }
        guard let bundle else { return .allow(.noBundle) }
        guard let service = HostMatcher.serviceForFlow(catalogue, host: host, bundleId: signing, cliName: nil) else { return .allow(.noService) }
        let decision = FlowDecision.decide(bundle, serviceId: service.serviceId)
        if decision.drops(in: bundle.clientMode) { return .drop(decision: decision, serviceId: service.serviceId, signingId: signing) }
        return .allow(decision.action == .allow ? .allowed : .monitor)
    }

    public static func decideDatagram(host: String?, remoteAddress: String?, port: Int?, catalogue: GuardCatalogue?,
                                      excludedApp: @autoclosure () -> Bool = false, hostForAddress: (String) -> String?) -> FlowVerdict {
        guard port == 443 else { return .allow(.notQUIC) }
        guard let catalogue else { return .allow(.noCatalogue) }
        if excludedApp() { return .allow(.excludedApp) }
        var candidates: [String] = []
        if let host, !host.isEmpty { candidates.append(host) }
        if let remoteAddress, let named = hostForAddress(remoteAddress) { candidates.append(named) }
        for candidate in candidates {
            if let service = HostMatcher.serviceForHost(catalogue, host: candidate) { return .dropQUIC(serviceId: service.serviceId) }
        }
        return .allow(.notCatalogued)
    }

    public var drops: Bool {
        switch self {
        case .drop, .dropQUIC: return true
        case .allow: return false
        }
    }
}

public enum SteeringRules {
    public static func steeredHost(for pattern: String) -> String? {
        let labels = pattern.split(separator: ".").map(String.init)
        guard let lastWild = labels.lastIndex(where: { $0.contains("*") }) else { return pattern }
        let rest = labels[(lastWild + 1)...]
        guard rest.count >= 2 else { return nil }
        return rest.joined(separator: ".")
    }

    public static func steeredHosts(_ catalogue: GuardCatalogue) -> [String] {
        var hosts = Set<String>()
        for service in catalogue.services where service.enabled {
            for pattern in service.domains { if let h = steeredHost(for: pattern) { hosts.insert(h) } }
        }
        let sorted = hosts.sorted { $0.count == $1.count ? $0 < $1 : $0.count < $1.count }
        var kept: [String] = []
        for h in sorted where !kept.contains(where: { h == $0 || h.hasSuffix(".\($0)") }) { kept.append(h) }
        return kept.sorted()
    }
}
