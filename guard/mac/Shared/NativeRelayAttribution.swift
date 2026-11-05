// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Vibtra
import Foundation
import CryptoKit
import Security
import os

public struct NativeRelayIdentity: Codable, Equatable, Sendable {
    public let signingId: String
    public let teamId: String

    public init(signingId: String, teamId: String) {
        self.signingId = signingId
        self.teamId = teamId
    }

    public var isValid: Bool {
        let id = signingId.utf8
        return (1...255).contains(id.count) && id.allSatisfy { (65...90).contains($0) || (97...122).contains($0) || (48...57).contains($0) || [45, 46, 95].contains($0) } &&
            teamId.utf8.count == 10 && teamId.utf8.allSatisfy { (65...90).contains($0) || (48...57).contains($0) }
    }

    public struct Verification: Sendable {
        public let identity: NativeRelayIdentity?
        public let reason: NativeRelayDiagnosticReason
        init(identity: NativeRelayIdentity?, reason: NativeRelayDiagnosticReason) { self.identity = identity; self.reason = reason }
        static func rejected(_ reason: NativeRelayDiagnosticReason) -> Self { Self(identity: nil, reason: reason) }
    }

    public static func verified(auditToken: Data?, expectedSigningId: String?) -> NativeRelayIdentity? {
        verification(auditToken: auditToken, expectedSigningId: expectedSigningId).identity
    }

    public static func verification(auditToken: Data?, expectedSigningId: String?) -> Verification {
        guard let auditToken else { return .rejected(.auditTokenMissing) }
        guard auditToken.count == 32 else { return .rejected(.auditTokenInvalid) }
        guard let expectedSigningId, !expectedSigningId.isEmpty else { return .rejected(.sourceSigningIdMissing) }
        var code: SecCode?
        guard SecCodeCopyGuestWithAttributes(nil, [kSecGuestAttributeAudit: auditToken] as CFDictionary,
                                            SecCSFlags(), &code) == errSecSuccess, let code else { return .rejected(.codeLookupFailed) }
        return verification(code: code, expectedSigningId: expectedSigningId)
    }

    static func verified(code: SecCode, expectedSigningId: String) -> NativeRelayIdentity? {
        verification(code: code, expectedSigningId: expectedSigningId).identity
    }

    static func metadata(signingId: String?, teamId: String?, expectedSigningId: String) -> Verification {
        guard let signingId else { return .rejected(.signingInformationFailed) }
        guard signingId == expectedSigningId else { return .rejected(.sourceSigningIdMismatch) }
        guard let teamId else { return .rejected(.teamMissing) }
        let identity = NativeRelayIdentity(signingId: signingId, teamId: teamId)
        guard identity.isValid else { return .rejected(.identityInvalid) }
        return Verification(identity: identity, reason: .metadataOnly)
    }

    static func verification(code: SecCode, expectedSigningId: String) -> Verification {
        var staticCode: SecStaticCode?
        guard SecCodeCopyStaticCode(code, SecCSFlags(), &staticCode) == errSecSuccess, let staticCode else { return .rejected(.codeLookupFailed) }
        var info: CFDictionary?
        guard SecCodeCopySigningInformation(staticCode, SecCSFlags(rawValue: kSecCSSigningInformation), &info) == errSecSuccess,
              let values = info as? [String: Any] else { return .rejected(.signingInformationFailed) }
        let parsed = metadata(signingId: values[kSecCodeInfoIdentifier as String] as? String,
                              teamId: values[kSecCodeInfoTeamIdentifier as String] as? String, expectedSigningId: expectedSigningId)
        guard let identity = parsed.identity else { return parsed }
        var requirement: SecRequirement?
        let rule = "anchor apple generic and identifier \"\(identity.signingId)\" and certificate leaf[subject.OU] = \"\(identity.teamId)\""
        guard SecRequirementCreateWithString(rule as CFString, SecCSFlags(), &requirement) == errSecSuccess,
              let requirement, SecCodeCheckValidity(code, SecCSFlags(), requirement) == errSecSuccess else { return .rejected(.signatureRejected) }
        return Verification(identity: identity, reason: .verified)
    }

}

public struct NativeRelayPublicPin: Codable, Equatable, Sendable {
    public let version: Int
    public let keyId: String
    public let publicKey: String

    public static func decode(_ data: Data) throws -> NativeRelayPublicPin {
        guard data.count <= 1024 else { throw NativeRelaySigner.Invalid.input }
        let pin = try JSONDecoder().decode(Self.self, from: data)
        guard pin.version == 1, let raw = NativeRelaySigner.unbase64url(pin.publicKey), raw.count == 65,
              pin.keyId == NativeRelaySigner.keyId(raw),
              (try? P256.Signing.PublicKey(x963Representation: raw)) != nil else { throw NativeRelaySigner.Invalid.input }
        return pin
    }
}

public final class NativeRelaySigner: @unchecked Sendable {
    public static let request = Data("guard-relay-key-v1".utf8)
    public static let steeringRequest = Data("guard-relay-steering-capability-v1".utf8)
    public static let steeringSupported = Data("guard-relay-steering-v1".utf8)
    public static let prefix = "VIBTRA_APP_V1"
    public static let maximumLineBytes = 2048
    enum Invalid: Error { case input }
    private let key: P256.Signing.PrivateKey
    private let activationLock = NSLock()
    private var enabledUntil = Date.distantPast
    private var steeringEnabled = false
    private let diagnostics = NativeRelayDiagnostics(component: "provider")

    public static func enableMessage(pin: NativeRelayPublicPin, steering: Bool = false) -> Data {
        Data("guard-relay-enable-v1 \(pin.keyId)\(steering ? " steering-v1" : "")".utf8)
    }

    public func receiveMessage(_ message: Data, now: Date = Date(), completionHandler: ((Data?) -> Void)? = nil) {
        let response = handleMessage(message, now: now)
        completionHandler?(response)
    }

    public func handleMessage(_ message: Data, now: Date = Date()) -> Data? {
        if message == Self.request { diagnostics.record(.keyRequested); return publicPin }
        if message == Self.steeringRequest { return Self.steeringSupported }
        activationLock.lock(); defer { activationLock.unlock() }
        if let pin = try? NativeRelayPublicPin.decode(publicPin), (message == Self.enableMessage(pin: pin) || message == Self.enableMessage(pin: pin, steering: true)) {
            steeringEnabled = message == Self.enableMessage(pin: pin, steering: true)
            diagnostics.record(.enableAccepted)
            enabledUntil = now.addingTimeInterval(30)
            return Data("ok".utf8)
        }
        diagnostics.record(message == Data("guard-relay-disable".utf8) ? .disabled : .enableRejected)
        enabledUntil = .distantPast
        steeringEnabled = false
        return nil
    }

    public func isEnabled(now: Date = Date()) -> Bool {
        activationLock.lock(); defer { activationLock.unlock() }
        return now < enabledUntil
    }
    public func isSteeringEnabled(now: Date = Date()) -> Bool {
        activationLock.lock(); defer { activationLock.unlock() }
        return steeringEnabled && now < enabledUntil
    }
    public init() { key = P256.Signing.PrivateKey() }
    init(testKey: P256.Signing.PrivateKey) { key = testKey }

    public var publicPin: Data {
        let raw = key.publicKey.x963Representation
        let pin = NativeRelayPublicPin(version: 1, keyId: Self.keyId(raw), publicKey: Self.base64url(raw))
        let encoder = JSONEncoder(); encoder.outputFormatting = [.sortedKeys]
        return (try? encoder.encode(pin)) ?? Data()
    }

    private struct Payload: Codable {
        let version: Int
        let keyId: String
        let issuedAt: Int64
        let nonce: String
        let signingId: String
        let teamId: String
        let steeringHost: String?
    }

    public func line(proxyLine: Data, identity: NativeRelayIdentity?, steeringHost: String? = nil, now: Date = Date()) -> Data? {
        var nonce = Data(count: 16)
        let result = nonce.withUnsafeMutableBytes { SecRandomCopyBytes(kSecRandomDefault, 16, $0.baseAddress!) }
        guard result == errSecSuccess else { return nil }
        return line(proxyLine: proxyLine, identity: identity, steeringHost: isSteeringEnabled(now: now) ? steeringHost : nil, issuedAt: Int64(now.timeIntervalSince1970), nonce: nonce)
    }

    func line(proxyLine: Data, identity: NativeRelayIdentity?, steeringHost: String? = nil, issuedAt: Int64, nonce: Data) -> Data? {
        let canonicalHost = steeringHost.map { $0.lowercased() }.flatMap { Self.isSteeringHost($0) ? $0 : nil }
        guard (identity?.isValid ?? (canonicalHost != nil)), nonce.count == 16, proxyLine.count <= 107,
              let proxy = String(data: proxyLine, encoding: .ascii), proxy.hasPrefix("PROXY "), proxy.hasSuffix("\r\n"),
              proxyLine.suffix(2) == Data([13, 10]), proxyLine.dropLast(2).allSatisfy({ (32...126).contains($0) }) else { return nil }
        let payload = Payload(version: 1, keyId: Self.keyId(key.publicKey.x963Representation), issuedAt: issuedAt,
                              nonce: Self.base64url(nonce), signingId: identity?.signingId ?? "", teamId: identity?.teamId ?? "", steeringHost: canonicalHost)
        let encoder = JSONEncoder(); encoder.outputFormatting = [.sortedKeys]
        guard let raw = try? encoder.encode(payload),
              let signature = try? key.signature(for: Data("\(Self.prefix)\n".utf8) + proxyLine + raw) else { return nil }
        let line = Data("\(Self.prefix) \(Self.base64url(raw)) \(Self.base64url(signature.rawRepresentation))\r\n".utf8)
        return line.count <= Self.maximumLineBytes ? line : nil
    }

    static func isSteeringHost(_ host: String) -> Bool {
        guard !host.isEmpty, host.utf8.count <= 253 else { return false }
        let labels = host.split(separator: ".", omittingEmptySubsequences: false)
        guard labels.allSatisfy({ label in
            !label.isEmpty && label.utf8.count <= 63 && label.first != "-" && label.last != "-" && label.utf8.allSatisfy({ (97...122).contains($0) || (48...57).contains($0) || $0 == 45 })
        }) else { return false }
        return !(labels.last?.utf8.allSatisfy({ (48...57).contains($0) }) ?? true)
    }

    static func keyId(_ raw: Data) -> String { SHA256.hash(data: raw).map { String(format: "%02x", $0) }.joined() }
    static func base64url(_ raw: Data) -> String { raw.base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "") }
    static func unbase64url(_ text: String) -> Data? {
        guard !text.isEmpty, text.utf8.allSatisfy({ (65...90).contains($0) || (97...122).contains($0) || (48...57).contains($0) || [45, 95].contains($0) }) else { return nil }
        let base = text.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        return Data(base64Encoded: base + String(repeating: "=", count: (4 - base.count % 4) % 4))
    }
}

public struct NativeRelayPinRequest {
    private var pending: (id: UUID, deadline: Date)?
    public init() {}
    public func hasExpired(now: Date = Date()) -> Bool {
        pending.map { now >= $0.deadline } ?? false
    }
    public mutating func begin(now: Date = Date()) -> UUID? {
        if let pending, pending.deadline > now { return nil }
        let id = UUID(); pending = (id, now.addingTimeInterval(5)); return id
    }
    public mutating func accept(_ id: UUID, now: Date = Date()) -> Bool {
        guard let current = pending, current.id == id else { return false }
        pending = nil
        return now < current.deadline
    }
    public mutating func invalidate() { pending = nil }
}

public enum NativeRelayDiagnosticReason: String, CaseIterable, Sendable {
    case auditTokenMissing, auditTokenInvalid, sourceSigningIdMissing, codeLookupFailed
    case signingInformationFailed, sourceSigningIdMismatch, teamMissing, identityInvalid
    case metadataOnly, signatureRejected, verified, leaseDisabled, signingFailed, emitted
    case keyRequested, enableAccepted, enableRejected, disabled
    case providerUnavailable, providerSendFailed, providerReplyInvalid, providerReplyExpired
    case capabilityUnavailable, proxyUnavailable, pinWriteFailed, enableSent
}

public final class NativeRelayDiagnostics: @unchecked Sendable {
    private let lock = NSLock()
    private var counts: [NativeRelayDiagnosticReason: UInt64] = [:]
    private let log: Logger
    public init(component: String) { log = Logger(subsystem: GuardConstants.extensionBundleId, category: "relay-attribution-" + component) }
    @discardableResult public func record(_ reason: NativeRelayDiagnosticReason) -> UInt64 {
        lock.lock()
        let old = counts[reason, default: 0]
        let count = old == UInt64.max ? old : old + 1
        counts[reason] = count
        lock.unlock()
        if count <= 1024 && count & (count - 1) == 0 {
            log.notice("relay attribution reason=\(reason.rawValue, privacy: .public) count=\(count, privacy: .public)")
        }
        return count
    }
    public func snapshot() -> [String: UInt64] {
        lock.lock(); defer { lock.unlock() }
        return Dictionary(uniqueKeysWithValues: counts.map { ($0.key.rawValue, $0.value) })
    }
}
