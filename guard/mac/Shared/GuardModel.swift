// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Vibtra

import Foundation

public enum GuardConstants {
    public static let protocolVersion = 1
    public static let proxyPort: UInt16 = 9470
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
    case monitor, enforce
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
