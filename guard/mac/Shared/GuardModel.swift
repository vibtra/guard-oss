// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Vibtra

import CryptoKit
import Foundation

public enum GuardConstants {
    public static let protocolVersion = 1
    public static let localPort: UInt16 = 9471
    public static let transparentPort: UInt16 = 9472
    public static let localHost = "guard.vibtra.local"
    public static let appBundleId = GuardIdentity.value("GuardAppBundleID")
    public static let extensionBundleId = GuardIdentity.value("GuardExtensionBundleID")
    public static let appGroup = GuardIdentity.value("GuardAppGroup")
    public static let extensionMachService = GuardIdentity.value("GuardExtensionMachService")
    public static let teamId = GuardIdentity.value("GuardTeamID")
    public static let agentSigningId = GuardIdentity.value("GuardAgentSigningID")
    public static func isOwnAgent(signingId: String?) -> Bool {
        guard let s = signingId else { return false }
        return s == agentSigningId || s == appBundleId || s == extensionBundleId || s.hasPrefix("vibtra-guard") || s.hasPrefix("vibtra_guard")
    }
    public static let localBase = URL(string: "http://127.0.0.1:9471")!
    public static let snippetMax = 80
}

final class GuardIdentity {
    static func value(_ key: String) -> String {
        let bundle = Bundle(for: GuardIdentity.self)
        guard let text = bundle.object(forInfoDictionaryKey: key) as? String, !text.isEmpty, !text.contains("$(") else {
            fatalError("\(bundle.bundlePath) Info.plist lacks \(key); build it from guard/mac/project.yml")
        }
        return text
    }
}

public enum GuardFlowAction: String, Codable, Sendable, Equatable {
    case allow, block, ask
}

public enum GuardClientMode: String, Codable, Sendable, Equatable {
    case off, monitor, enforce

    public init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = GuardClientMode(rawValue: raw) ?? .enforce
    }

    private var rank: Int {
        switch self {
        case .off: return 0
        case .monitor: return 1
        case .enforce: return 2
        }
    }

    public func raised(to other: GuardClientMode) -> GuardClientMode { other.rank > rank ? other : self }
}

public struct GuardBundleServiceDecision: Codable, Sendable, Equatable {
    public var action: GuardFlowAction
    public var ruleId: String?
    public var note: String?
}

public struct GuardException: Codable, Sendable, Equatable {
    public var grantId: String
    public var scope: String
    public var serviceId: String
    public var ruleId: String?
    public var expiresAt: String?
}

public struct GuardWorkspaceRedirect: Codable, Sendable, Equatable {
    public var enabled: Bool
    public var url: String?
}

public struct GuardBundleSettings: Codable, Sendable, Equatable {
    public var requestsEnabled: Bool
    public var workspaceRedirect: GuardWorkspaceRedirect
    public var snippetPolicy: String
    public var snippetMax: Int
}

public struct GuardBundlePerson: Codable, Sendable, Equatable {
    public var userId: String
    public var email: String
}

public struct GuardBundle: Codable, Sendable, Equatable {
    public var `protocol`: Int
    public var orgId: String
    public var deviceId: String
    public var bundleVersion: Int
    public var catalogueVersion: String
    public var generatedAt: String
    public var person: GuardBundlePerson
    public var clientMode: GuardClientMode
    public var defaultMode: GuardClientMode?
    public var protectionRevision: Int?
    public var defaultAction: GuardFlowAction
    public var services: [String: GuardBundleServiceDecision]
    public var exceptions: [GuardException]
    public var settings: GuardBundleSettings
}

public struct GuardService: Codable, Sendable, Equatable {
    public var serviceId: String
    public var name: String
    public var vendor: String?
    public var category: String?
    public var domains: [String]
    public var bundleIds: [String]
    public var cliNames: [String]
    public var defaultAction: GuardFlowAction?
    public var markId: String?
    public var custom: Bool
    public var enabled: Bool

    enum CodingKeys: String, CodingKey {
        case serviceId, name, vendor, category, domains, bundleIds, cliNames, defaultAction, markId, custom, enabled
    }

    public init(serviceId: String, name: String, domains: [String], bundleIds: [String] = [], cliNames: [String] = [], enabled: Bool = true) {
        self.serviceId = serviceId
        self.name = name
        self.domains = domains
        self.bundleIds = bundleIds
        self.cliNames = cliNames
        self.custom = false
        self.enabled = enabled
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        serviceId = try c.decode(String.self, forKey: .serviceId)
        name = try c.decode(String.self, forKey: .name)
        vendor = try c.decodeIfPresent(String.self, forKey: .vendor)
        category = try c.decodeIfPresent(String.self, forKey: .category)
        domains = try c.decode([String].self, forKey: .domains)
        bundleIds = try c.decodeIfPresent([String].self, forKey: .bundleIds) ?? []
        cliNames = try c.decodeIfPresent([String].self, forKey: .cliNames) ?? []
        defaultAction = try c.decodeIfPresent(GuardFlowAction.self, forKey: .defaultAction)
        markId = try c.decodeIfPresent(String.self, forKey: .markId)
        custom = try c.decodeIfPresent(Bool.self, forKey: .custom) ?? false
        enabled = try c.decodeIfPresent(Bool.self, forKey: .enabled) ?? true
    }
}

public struct GuardCatalogue: Codable, Sendable, Equatable {
    public var version: String
    public var generatedAt: String
    public var services: [GuardService]

    public init(version: String, generatedAt: String, services: [GuardService]) {
        self.version = version
        self.generatedAt = generatedAt
        self.services = services
    }
}

public enum GuardDocuments {
    private struct SignedBundle: Decodable { var bundle: GuardBundle }
    private struct SignedCatalogue: Decodable { var catalogue: GuardCatalogue }

    public static func decodeBundle(_ data: Data) throws -> GuardBundle {
        let decoder = JSONDecoder()
        if let signed = try? decoder.decode(SignedBundle.self, from: data) { return signed.bundle }
        return try decoder.decode(GuardBundle.self, from: data)
    }

    public static func decodeCatalogue(_ data: Data) throws -> GuardCatalogue {
        let decoder = JSONDecoder()
        if let signed = try? decoder.decode(SignedCatalogue.self, from: data) { return signed.catalogue }
        return try decoder.decode(GuardCatalogue.self, from: data)
    }
}

public struct GuardDocumentState: Sendable {
    public private(set) var bundle: GuardBundle?
    public private(set) var catalogue: GuardCatalogue?

    public init() {}

    private enum PairError: LocalizedError {
        case incomplete, versionMismatch
        var errorDescription: String? {
            switch self {
            case .incomplete: return "A complete policy and catalogue pair is required"
            case .versionMismatch: return "Policy and catalogue versions do not match"
            }
        }
    }

    public mutating func load(bundleData: Data?, catalogueData: Data?) throws {
        guard bundleData != nil || catalogueData != nil else { return }
        let candidateBundle = try bundleData.map(GuardDocuments.decodeBundle) ?? bundle
        let candidateCatalogue = try catalogueData.map(GuardDocuments.decodeCatalogue) ?? catalogue
        guard let candidateBundle, let candidateCatalogue else { throw PairError.incomplete }
        guard candidateBundle.catalogueVersion == candidateCatalogue.version else { throw PairError.versionMismatch }
        bundle = candidateBundle
        catalogue = candidateCatalogue
    }
}

public struct GuardPolicyPin: Equatable, Sendable {
    public let deviceId: String
    public let orgId: String
    public let keyId: String
    public let publicKeyPem: String

    public init?(record: Data) {
        guard record.count <= 4096,
              let object = (try? JSONSerialization.jsonObject(with: record)) as? [String: Any],
              object["source"] as? String != "first-use",
              let deviceId = object["deviceId"] as? String, !deviceId.isEmpty,
              let orgId = object["orgId"] as? String, !orgId.isEmpty,
              let signing = object["signing"] as? [String: Any], signing["alg"] as? String == "ES256",
              let keyId = signing["keyId"] as? String, !keyId.isEmpty,
              let publicKeyPem = signing["publicKeyPem"] as? String,
              (try? P256.Signing.PublicKey(pemRepresentation: publicKeyPem)) != nil else { return nil }
        self.deviceId = deviceId
        self.orgId = orgId
        self.keyId = keyId
        self.publicKeyPem = publicKeyPem
    }
}

public enum GuardPolicyError: LocalizedError, Equatable {
    case unverified(String)
    case older
    case unpinned

    public var errorDescription: String? {
        switch self {
        case .unverified(let kind): return "The signed \(kind) did not verify against the pinned policy-signing key"
        case .older: return "The policy is older than the one already verified"
        case .unpinned: return "No pinned policy-signing key to verify the policy with"
        }
    }
}

enum GuardCanonicalJSON {
    static func data(_ value: Any) throws -> Data {
        var out = ""
        try write(value, into: &out)
        return Data(out.utf8)
    }

    private static func write(_ value: Any, into out: inout String) throws {
        switch value {
        case is NSNull:
            out += "null"
        case let text as String:
            quote(text, into: &out)
        case let number as NSNumber:
            if CFGetTypeID(number as CFTypeRef) == CFBooleanGetTypeID() {
                out += number.boolValue ? "true" : "false"
            } else {
                let integer = number.int64Value
                guard Double(integer) == number.doubleValue, integer.magnitude <= 9_007_199_254_740_991 else {
                    throw GuardPolicyError.unverified("document")
                }
                out += String(integer)
            }
        case let items as [Any]:
            out += "["
            for (index, item) in items.enumerated() {
                if index > 0 { out += "," }
                try write(item, into: &out)
            }
            out += "]"
        case let fields as [String: Any]:
            out += "{"
            let keys = fields.keys.sorted { Array($0.utf16).lexicographicallyPrecedes(Array($1.utf16)) }
            for (index, key) in keys.enumerated() {
                if index > 0 { out += "," }
                quote(key, into: &out)
                out += ":"
                try write(fields[key] ?? NSNull(), into: &out)
            }
            out += "}"
        default:
            throw GuardPolicyError.unverified("document")
        }
    }

    private static func quote(_ text: String, into out: inout String) {
        out += "\""
        for scalar in text.unicodeScalars {
            switch scalar {
            case "\"": out += "\\\""
            case "\\": out += "\\\\"
            case "\u{08}": out += "\\b"
            case "\u{0C}": out += "\\f"
            case "\n": out += "\\n"
            case "\r": out += "\\r"
            case "\t": out += "\\t"
            default:
                if scalar.value < 0x20 {
                    out += String(format: "\\u%04x", scalar.value)
                } else {
                    out.unicodeScalars.append(scalar)
                }
            }
        }
        out += "\""
    }
}

enum GuardSignedDocument {
    struct Verified {
        let document: Data
        let issuedAt: Int
        let validUntil: Int?
    }

    static func verify(_ envelope: Data, kind: String, pin: GuardPolicyPin) throws -> Verified {
        let fail = GuardPolicyError.unverified(kind)
        guard let root = (try? JSONSerialization.jsonObject(with: envelope)) as? [String: Any],
              let document = root[kind] as? [String: Any],
              let signature = root["signature"] as? [String: Any],
              signature["alg"] as? String == "ES256", signature["keyId"] as? String == pin.keyId,
              let jws = signature["jws"] as? String else { throw fail }
        let parts = jws.split(separator: ".", omittingEmptySubsequences: false).map(String.init)
        guard parts.count == 3,
              let headerData = base64url(parts[0]), let payloadData = base64url(parts[1]), let signatureBytes = base64url(parts[2]),
              let header = (try? JSONSerialization.jsonObject(with: headerData)) as? [String: Any],
              let payload = (try? JSONSerialization.jsonObject(with: payloadData)) as? [String: Any],
              header["alg"] as? String == "ES256", header["kid"] as? String == pin.keyId, header["typ"] as? String == "vibtra-guard+jwt",
              payload["kind"] as? String == kind, payload["keyId"] as? String == pin.keyId, payload["orgId"] as? String == pin.orgId else { throw fail }
        if kind == "bundle" {
            guard payload["deviceId"] as? String == pin.deviceId, document["deviceId"] as? String == pin.deviceId,
                  document["orgId"] as? String == pin.orgId else { throw fail }
        }
        guard let canonical = try? GuardCanonicalJSON.data(document),
              payload["digest"] as? String == SHA256.hash(data: canonical).map({ String(format: "%02x", $0) }).joined(),
              let version = document[kind == "bundle" ? "bundleVersion" : "version"], let claimed = payload["version"],
              let versionBytes = try? GuardCanonicalJSON.data(version), versionBytes == (try? GuardCanonicalJSON.data(claimed)),
              signatureBytes.count == 64,
              let key = try? P256.Signing.PublicKey(pemRepresentation: pin.publicKeyPem),
              let ecdsa = try? P256.Signing.ECDSASignature(rawRepresentation: signatureBytes),
              key.isValidSignature(ecdsa, for: Data((parts[0] + "." + parts[1]).utf8)) else { throw fail }
        return Verified(document: canonical, issuedAt: (payload["iat"] as? NSNumber)?.intValue ?? 0,
                        validUntil: (payload["validUntil"] as? NSNumber)?.intValue)
    }

    private static func base64url(_ text: String) -> Data? {
        var standard = text.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        while standard.count % 4 != 0 { standard += "=" }
        return Data(base64Encoded: standard)
    }
}

public struct GuardVerifiedPolicy: Sendable {
    public private(set) var documents = GuardDocumentState()
    public private(set) var pin: GuardPolicyPin?
    public private(set) var validUntil: Date?
    private var issuedAt = 0

    public init() {}

    private init(pin: GuardPolicyPin) { self.pin = pin }

    public mutating func load(bundleData: Data?, catalogueData: Data?, pin: GuardPolicyPin) throws {
        guard bundleData != nil || catalogueData != nil else { return }
        var next = pin == self.pin ? self : GuardVerifiedPolicy(pin: pin)
        let bundle = try bundleData.map { try GuardSignedDocument.verify($0, kind: "bundle", pin: pin) }
        let catalogue = try catalogueData.map { try GuardSignedDocument.verify($0, kind: "catalogue", pin: pin) }
        if let bundle, let held = next.documents.bundle {
            let candidate = try GuardDocuments.decodeBundle(bundle.document)
            let stamp = (candidate.bundleVersion, candidate.protectionRevision ?? 0)
            let heldStamp = (held.bundleVersion, held.protectionRevision ?? 0)
            if stamp < heldStamp || stamp == heldStamp && bundle.issuedAt < next.issuedAt { throw GuardPolicyError.older }
        }
        try next.documents.load(bundleData: bundle?.document, catalogueData: catalogue?.document)
        if let bundle {
            next.issuedAt = bundle.issuedAt
            next.validUntil = bundle.validUntil.map { Date(timeIntervalSince1970: TimeInterval($0)) }
        }
        self = next
    }

    public mutating func restore(bundleData: Data?, catalogueData: Data?, pin offered: GuardPolicyPin?) throws {
        guard bundleData != nil || catalogueData != nil else { return }
        guard let held = pin ?? offered else { throw GuardPolicyError.unpinned }
        try load(bundleData: bundleData, catalogueData: catalogueData, pin: held)
    }

    public func expired(at now: Date) -> Bool { validUntil.map { now >= $0 } ?? false }

    public func bundle(at now: Date, hold: GuardExpiryHold = GuardExpiryHold()) -> GuardBundle? {
        guard var bundle = documents.bundle else { return nil }
        if expired(at: now) && !hold.keepsSignedMode(validUntil: validUntil, at: now) {
            bundle.clientMode = bundle.clientMode.raised(to: bundle.defaultMode ?? .enforce)
        }
        return bundle
    }
}

public struct GuardExpiryHold: Sendable {
    public static let grace: TimeInterval = 120
    public static let sleptOver: TimeInterval = 10
    private var lastWall: Date?
    private var lastUptime: TimeInterval = 0
    private var missedFrom = Date.distantPast
    private var missedTo: Date?
    public private(set) var until: Date?

    public init() {}

    public mutating func observe(wall: Date, uptime: TimeInterval) -> Bool {
        defer {
            lastWall = wall
            lastUptime = uptime
        }
        var from = Date.distantPast
        if let lastWall {
            guard wall.timeIntervalSince(lastWall) - (uptime - lastUptime) > Self.sleptOver else { return false }
            from = lastWall
        }
        if let until, wall < until { from = min(from, missedFrom) }
        missedFrom = from
        missedTo = wall
        until = wall.addingTimeInterval(Self.grace)
        return true
    }

    public func keepsSignedMode(validUntil: Date?, at now: Date) -> Bool {
        guard let validUntil, let missedTo, let until else { return false }
        return now < until && validUntil > missedFrom && validUntil <= missedTo
    }
}
