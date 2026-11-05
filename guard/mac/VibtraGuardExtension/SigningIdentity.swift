// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Vibtra

import Foundation
import Network
import Security
import os

enum SigningIdentity {
    private static let lock = NSLock()
    nonisolated(unsafe) private static var identifiers: [Data: String] = [:]
    nonisolated(unsafe) private static var ownAgent: [Data: Bool] = [:]
    nonisolated(unsafe) private static var excludedCodex: [Data: Bool] = [:]
    nonisolated(unsafe) private static var relayIdentities: [Data: NativeRelayIdentity.Verification] = [:]
    private static let capacity = 2048
    private static let log = Logger(subsystem: GuardConstants.extensionBundleId, category: "signing")

    private static func code(auditToken: Data) -> SecCode? {
        let attributes = [kSecGuestAttributeAudit: auditToken] as CFDictionary
        var code: SecCode?
        guard SecCodeCopyGuestWithAttributes(nil, attributes, SecCSFlags(), &code) == errSecSuccess else { return nil }
        return code
    }

    private static func cached<T>(_ table: inout [Data: T], _ key: Data, compute: () -> T) -> T {
        lock.lock()
        if let hit = table[key] { lock.unlock(); return hit }
        lock.unlock()
        let value = compute()
        lock.lock()
        if table.count >= capacity { table.removeAll(keepingCapacity: true) }
        table[key] = value
        lock.unlock()
        return value
    }

    static func identifier(auditToken: Data?) -> String? {
        guard let auditToken else { return nil }
        let found: String = cached(&identifiers, auditToken) {
            guard let code = code(auditToken: auditToken) else { return "" }
            var staticCode: SecStaticCode?
            guard SecCodeCopyStaticCode(code, SecCSFlags(), &staticCode) == errSecSuccess, let staticCode else { return "" }
            var info: CFDictionary?
            guard SecCodeCopySigningInformation(staticCode, SecCSFlags(rawValue: kSecCSSigningInformation), &info) == errSecSuccess,
                  let dict = info as? [String: Any] else { return "" }
            return dict[kSecCodeInfoIdentifier as String] as? String ?? ""
        }
        return found.isEmpty ? nil : found
    }

    static func isExcludedCodex(signingId: String?, auditToken: Data?, catalogue: GuardCatalogue?) -> Bool {
        CodexWorkExclusion.shouldBypass(signingId: signingId, catalogue: catalogue, validSignature: {
            guard let signingId, let auditToken,
                  identifier(auditToken: auditToken) == signingId,
                  let text = CodexWorkExclusion.requirement(signingId: signingId) else { return false }
            return cached(&excludedCodex, auditToken) {
                guard let code = code(auditToken: auditToken) else { return false }
                var requirement: SecRequirement?
                guard SecRequirementCreateWithString(text as CFString, SecCSFlags(), &requirement) == errSecSuccess,
                      let requirement else { return false }
                let valid = SecCodeCheckValidity(code, SecCSFlags(), requirement) == errSecSuccess
                if valid { log.notice("verified Codex work process \(signingId, privacy: .public); disabled catalogue row bypasses TCP/QUIC inspection") }
                return valid
            }
        }())
    }

    static func relayIdentity(signingId: String?, auditToken: Data?) -> NativeRelayIdentity.Verification {
        guard let auditToken, let signingId else {
            return NativeRelayIdentity.verification(auditToken: auditToken, expectedSigningId: signingId)
        }
        let found = cached(&relayIdentities, auditToken) {
            NativeRelayIdentity.verification(auditToken: auditToken, expectedSigningId: signingId)
        }
        if let identity = found.identity, identity.signingId != signingId {
            return .init(identity: nil, reason: .sourceSigningIdMismatch)
        }
        return found
    }

    static func isOwnAgent(signingId: String?, auditToken: Data?) -> Bool {
        guard GuardConstants.isOwnAgent(signingId: signingId) else { return false }
        guard let auditToken else {
            #if DEBUG
            return true
            #else
            return false
            #endif
        }
        return cached(&ownAgent, auditToken) {
            if signedByOurTeam(auditToken: auditToken) { return true }
            #if DEBUG
            log.info("\(signingId ?? "?", privacy: .public) is not signed by team \(GuardConstants.teamId, privacy: .public); accepted as the agent in this Debug build only")
            return true
            #else
            log.error("\(signingId ?? "?", privacy: .public) calls itself the Guard agent but is not signed by team \(GuardConstants.teamId, privacy: .public): its flows are treated as any app's (ship a team-signed agent binary)")
            return false
            #endif
        }
    }

    private static func signedByOurTeam(auditToken: Data) -> Bool {
        guard let code = code(auditToken: auditToken) else { return false }
        var requirement: SecRequirement?
        let text = "anchor apple generic and certificate leaf[subject.OU] = \"\(GuardConstants.teamId)\"" as CFString
        guard SecRequirementCreateWithString(text, SecCSFlags(), &requirement) == errSecSuccess, let requirement else { return false }
        return SecCodeCheckValidity(code, SecCSFlags(), requirement) == errSecSuccess
    }
}

enum EndpointParts {
    static func of(_ endpoint: NWEndpoint) -> (String?, Int?) {
        guard case let .hostPort(host, port) = endpoint else { return (nil, nil) }
        let text: String
        switch host {
        case .name(let name, _): text = name
        case .ipv4(let address): text = "\(address)"
        case .ipv6(let address): text = "\(address)"
        @unknown default: return (nil, Int(port.rawValue))
        }
        return (text, Int(port.rawValue))
    }
}
