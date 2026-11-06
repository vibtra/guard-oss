// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Vibtra

import Foundation

private func dict(_ any: Any?) -> [String: Any]? { any as? [String: Any] }
private func str(_ any: Any?) -> String? {
    if let s = any as? String, !s.isEmpty { return s }
    if let n = any as? NSNumber { return n.stringValue }
    return nil
}
private func int(_ any: Any?) -> Int? {
    if let n = any as? NSNumber { return n.intValue }
    if let s = any as? String { return Int(s) }
    return nil
}
private func bool(_ any: Any?) -> Bool? { (any as? NSNumber)?.boolValue }
private func date(_ any: Any?) -> Date? {
    str(any).flatMap {
        (try? Date.ISO8601FormatStyle(includingFractionalSeconds: true).parse($0))
            ?? (try? Date.ISO8601FormatStyle().parse($0))
    }
}
private func first<T>(_ candidates: T?...) -> T? { for c in candidates { if let c { return c } }; return nil }

public struct GuardCounts: Equatable, Sendable {
    public var allowed = 0
    public var blocked = 0
    public var asked = 0
    public var observed = 0
    public var wouldBlocked = 0
    public var wouldAsked = 0

    public var wouldAllow: Int { max(0, observed - wouldBlocked - wouldAsked) }

    public init(allowed: Int = 0, blocked: Int = 0, asked: Int = 0, observed: Int = 0, wouldBlocked: Int = 0, wouldAsked: Int = 0) {
        self.allowed = allowed; self.blocked = blocked; self.asked = asked; self.observed = observed
        self.wouldBlocked = wouldBlocked; self.wouldAsked = wouldAsked
    }

    init?(json: [String: Any]?) {
        guard let json else { return nil }
        allowed = int(json["allowed"]) ?? 0
        blocked = int(json["blocked"]) ?? 0
        asked = int(json["asked"]) ?? 0
        observed = int(json["observed"]) ?? 0
        wouldBlocked = int(json["wouldBlocked"]) ?? 0
        wouldAsked = int(json["wouldAsked"]) ?? 0
    }
}

public enum InterceptionOffReason: String, Equatable, Sendable {
    case unsignedBuild = "unsigned-build"
    case noSecureEnclave = "no-secure-enclave"
    case keyUnavailable = "key-unavailable"
    case signerUnavailable = "signer-unavailable"
    case unsupportedPlatform = "unsupported-platform"
}

public enum CAState: Equatable, Sendable {
    case unknown
    case ready
    case awaitingTrust(staleCAs: Int, holdUntil: Date?)
    case off(InterceptionOffReason?)
}

public struct CANotice: Equatable, Sendable {
    public enum Tone: Equatable, Sendable { case amber, red }

    public var tone: Tone
    public var heading: String
    public var body: String?
    public var offersTrust: Bool

    private init(_ tone: Tone, _ heading: String, _ body: String?, offersTrust: Bool) {
        self.tone = tone
        self.heading = heading
        self.body = body
        self.offersTrust = offersTrust
    }

    public init?(_ state: CAState) {
        let unchecked = "Requests to AI services go through without Guard checking them. Your admin can see this."
        switch state {
        case .ready, .unknown:
            return nil
        case .awaitingTrust:
            self.init(.amber, "Trust Guard's new certificate", "Until you trust it, AI requests go through without Guard checking them.", offersTrust: true)
        case .off(.signerUnavailable?):
            self.init(.amber, "Guard is restarting. Until it is back, AI requests may go through without Guard checking them.", nil, offersTrust: false)
        case .off(let reason):
            let why: String?
            switch reason {
            case .noSecureEnclave?: why = "It has no Secure Enclave, so Guard cannot check AI traffic."
            case .keyUnavailable?: why = "Guard could not make its key. Reinstall Guard or ask your admin."
            case .unsignedBuild?: why = "This is an unsigned build of Guard, so it does not check AI traffic."
            case .signerUnavailable?, .unsupportedPlatform?, nil: why = nil
            }
            self.init(.red, "This Mac is not protected", why.map { "\($0) \(unchecked)" } ?? unchecked, offersTrust: false)
        }
    }
}

public struct CATrustAlert: Equatable, Sendable {
    public var title: String
    public var message: String

    public init?(_ state: CAState, dataDir: URL) {
        guard case .awaitingTrust(let staleCAs, _) = state else { return nil }
        let twice = "macOS asks for your login password twice: once to trust the new certificate, once to remove the old one."
        if staleCAs > 0, FileManager.default.fileExists(atPath: dataDir.appendingPathComponent("ca.key").path) {
            title = "Finish moving Guard's key into the Secure Enclave"
            message = "Guard now keeps its certificate key in this Mac's Secure Enclave, where it cannot be copied. Trust the new certificate to finish. "
                + "Until you do, AI requests go through without Guard checking them.\n\n" + twice
        } else {
            title = "Trust Guard's new certificate"
            message = "Guard made a new certificate for this Mac. Its key is kept in this Mac's Secure Enclave and cannot be copied.\n\n"
                + "Until you trust it, AI requests go through without Guard checking them. "
                + (staleCAs > 0 ? twice : "macOS asks for your login password.")
        }
    }
}

public struct AgentStatus: Equatable, Sendable {
    public var enrolled: Bool
    public var personEmail: String?
    public var personName: String?
    public var orgName: String?
    public var orgHandle: String?
    public var deviceId: String?
    public var hostname: String?
    public var clientMode: String?
    public var lastSyncAt: String?
    public var lastSyncError: String?
    public var agentVersion: String?
    public var pid: Int32?
    public var bundleVersion: Int?
    public var today: GuardCounts
    public var requestsEnabled: Bool
    public var workspaceEnabled: Bool
    public var workspaceUrl: String?
    public var lastBlockedEventId: String?
    public var caTrusted: Bool?
    public var caFingerprint: String?
    public var caState: CAState
    public var proxyListening: Bool
    public var server: String?
    public var revoked: Bool
    public var upstreamTransport: String?
    public var utlsAvailable: Bool?
    public var relayAttributionProtocol: Int?
    public var relaySteeringProtocol: Int?

    public static func parse(_ data: Data) -> AgentStatus? {
        guard let root = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else { return nil }
        return AgentStatus(json: root)
    }

    public init(json root: [String: Any]) {
        let person = dict(root["person"])
        let org = dict(root["org"])
        let sync = first(dict(root["sync"]), dict(root["lastSync"]))
        let settings = first(dict(root["settings"]), dict(dict(root["bundle"])?["settings"]))
        let workspace = first(dict(settings?["workspaceRedirect"]), dict(root["workspaceRedirect"]), dict(root["workspace"]))
        let lastBlocked = first(dict(root["lastBlocked"]), dict(root["lastBlockedEvent"]))
        personEmail = first(str(person?["email"]), str(root["personEmail"]), str(root["email"]))
        personName = first(str(person?["name"]), str(root["personName"]))
        orgName = first(str(org?["name"]), str(root["orgName"]))
        orgHandle = first(str(org?["handle"]), str(root["orgHandle"]))
        deviceId = first(str(root["deviceId"]), str(dict(root["device"])?["deviceId"]))
        hostname = first(str(root["hostname"]), str(dict(root["device"])?["hostname"]))
        clientMode = first(str(root["clientMode"]), str(root["mode"]))
        lastSyncAt = first(str(root["lastSyncAt"]), str(sync?["at"]), str(sync?["lastAt"]), str(root["lastSync"]))
        lastSyncError = first(str(root["lastSyncError"]), str(sync?["error"]))
        agentVersion = first(str(root["agentVersion"]), str(root["version"]))
        pid = int(root["pid"]).map(Int32.init)
        bundleVersion = first(int(root["bundleVersion"]), int(dict(root["bundle"])?["bundleVersion"]))
        today = first(GuardCounts(json: dict(root["today"])), GuardCounts(json: dict(root["counts"])), GuardCounts(json: dict(root["countsToday"]))) ?? GuardCounts()
        requestsEnabled = first(bool(settings?["requestsEnabled"]), bool(root["requestsEnabled"])) ?? true
        workspaceEnabled = bool(workspace?["enabled"]) ?? false
        workspaceUrl = str(workspace?["url"])
        lastBlockedEventId = first(str(lastBlocked?["eventId"]), str(root["lastBlockedEventId"]))
        let ca = dict(root["ca"])
        let interception = dict(root["interception"])
        caTrusted = first(bool(ca?["trusted"]), bool(root["caTrusted"]))
        caFingerprint = str(ca?["fingerprintSha256"])
        let state = str(ca?["state"])
        let reason = str(interception?["reason"])
        let offReason = reason.flatMap(InterceptionOffReason.init(rawValue:))
        if bool(interception?["on"]) == false && reason != "awaiting-trust" {
            caState = .off(offReason)
        } else if state == "awaiting-trust" || reason == "awaiting-trust" {
            caState = .awaitingTrust(staleCAs: int(ca?["staleCAs"]) ?? 0, holdUntil: date(ca?["holdUntil"]))
        } else if state == "off" {
            caState = .off(offReason)
        } else {
            caState = state == "ready" ? .ready : .unknown
        }
        proxyListening = bool(root["proxyListening"]) ?? false
        server = str(root["server"])
        revoked = bool(root["revoked"]) ?? false
        upstreamTransport = str(dict(root["upstreamTransport"])?["kind"])
        utlsAvailable = bool(dict(root["upstreamTransport"])?["available"])
        relayAttributionProtocol = int(dict(root["capabilities"])?["nativeRelayAttribution"])
        relaySteeringProtocol = int(dict(root["capabilities"])?["nativeRelaySteering"])
        enrolled = bool(root["enrolled"]) ?? (deviceId != nil || personEmail != nil)
    }

    public func certificateToPrompt(alreadyPrompted: String?) -> String? {
        guard case .awaitingTrust = caState, let caFingerprint, caFingerprint != alreadyPrompted else { return nil }
        return caFingerprint
    }
}

public struct DecisionEvent: Equatable, Sendable, Identifiable {
    public var id: String { eventId }
    public var eventId: String
    public var action: String
    public var serviceId: String?
    public var serviceName: String?
    public var host: String?
    public var ruleId: String?
    public var ruleName: String?
    public var matchType: String?
    public var matchCount: Int?
    public var example: String?
    public var enforced: Bool?
    public var requestsEnabled: Bool?
    public var workspaceEnabled: Bool?
    public var workspaceUrl: String?
    public var appName: String?
    public var occurredAt: String?
    public var occurredDate: Date?
    public var inspection: InspectionFacts?
    public var reason: String?
    public var delivery: String?

    public static func parse(_ text: String) -> DecisionEvent? {
        guard let data = text.data(using: .utf8),
              let root = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else { return nil }
        return DecisionEvent(json: root)
    }

    public init?(json root: [String: Any]) {
        let ev = dict(root["event"]) ?? [:]
        func pick(_ key: String) -> Any? { root[key] ?? ev[key] }
        guard let eventId = str(pick("eventId")), let action = first(str(pick("action")), str(pick("verdict"))) else { return nil }
        self.eventId = eventId
        self.action = action
        serviceId = str(pick("serviceId"))
        serviceName = first(str(pick("serviceName")), str(dict(pick("service"))?["name"]))
        host = str(pick("host"))
        ruleId = str(pick("ruleId"))
        ruleName = first(str(pick("ruleName")), str(dict(pick("rule"))?["name"]))
        matchType = str(pick("matchType"))
        matchCount = int(pick("matchCount"))
        let rawExample = first(str(pick("example")), str(pick("snippet")))
        example = rawExample.map { String($0.prefix(GuardConstants.snippetMax)) }
        enforced = bool(pick("enforced"))
        requestsEnabled = bool(pick("requestsEnabled"))
        let workspace = dict(pick("workspace")) ?? dict(pick("workspaceRedirect"))
        if let w = pick("workspace") as? String { workspaceUrl = w; workspaceEnabled = true } else {
            workspaceUrl = str(workspace?["url"])
            workspaceEnabled = bool(workspace?["enabled"]) ?? (workspaceUrl != nil ? true : nil)
        }
        let app = dict(pick("app"))
        appName = first(str(app?["name"]), str(app?["cli"]), str(app?["bundleId"]))
        occurredAt = str(pick("occurredAt"))
        occurredDate = date(pick("occurredAt"))
        inspection = dict(pick("inspection")).map { InspectionFacts(json: $0) }
        reason = str(pick("reason"))
        delivery = str(pick("delivery"))
    }

    public var shouldPopUp: Bool {
        (action == "blocked" || action == "asked") && enforced != false
    }

    public var needsNotice: Bool {
        shouldPopUp && delivery != "page"
    }
}

public struct SSEParser {
    public struct Message: Equatable { public var event: String; public var data: String; public var id: String? }
    private var event = ""
    private var data: [String] = []
    private var id: String?

    public init() {}

    public mutating func feed(_ rawLine: String) -> Message? {
        let line = rawLine.hasSuffix("\r") ? String(rawLine.dropLast()) : rawLine
        if line.isEmpty {
            defer { event = ""; data = []; id = nil }
            guard !data.isEmpty else { return nil }
            return Message(event: event.isEmpty ? "message" : event, data: data.joined(separator: "\n"), id: id)
        }
        if line.hasPrefix(":") { return nil }
        let field: Substring
        var value: Substring
        if let colon = line.firstIndex(of: ":") {
            field = line[..<colon]
            value = line[line.index(after: colon)...]
            if value.hasPrefix(" ") { value = value.dropFirst() }
        } else {
            field = Substring(line)
            value = ""
        }
        switch field {
        case "event": event = String(value)
        case "data": data.append(String(value))
        case "id": id = String(value)
        default: break
        }
        return nil
    }
}

public struct EnrolLink: Equatable {
    public var server: String?
    public var token: String?

    public static let tokenPattern = "^genr_[0-9a-f]{32}$"

    public static func isToken(_ s: String) -> Bool {
        s.range(of: tokenPattern, options: .regularExpression) != nil
    }

    public static func parse(_ input: String) -> EnrolLink {
        let trimmed = input.trimmingCharacters(in: .whitespacesAndNewlines)
        if isToken(trimmed) { return EnrolLink(server: nil, token: trimmed) }
        guard let comps = URLComponents(string: trimmed), comps.scheme == "vibtra-guard" else { return EnrolLink(server: nil, token: nil) }
        guard comps.host == "enrol" || comps.path == "enrol" || comps.path == "/enrol" else { return EnrolLink(server: nil, token: nil) }
        let items = comps.queryItems ?? []
        let server = items.first { $0.name == "server" }?.value
        let token = items.first { $0.name == "token" }?.value
        return EnrolLink(server: server, token: token.flatMap { isToken($0) ? $0 : nil })
    }
}
