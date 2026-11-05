// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Vibtra
import CryptoKit
import Foundation

struct GuardPolicy {
    static let chatgptContentRuleId = "gcr_0a1b2c3d"
    static let chatgptContentRuleName = "Project codename"
    static let chatgptKeyword = "bluebird-example"
    static let deepseekRuleId = "gsr_0a1b2c3d"
    static let deepseekNote = "Example residency note"
    static let claudeRuleId = "gsr_1a2b3c4d"
    static let perplexityRuleId = "gsr_2a3b4c5d"
    static let perplexityGrantId = "pgr_000001"
    static let workspaceURL = "https://workspace.example.test/example-org"
    static let customServiceId = "custom-example"
    static let customHost = "ai.example.test"

    var bundleVersion = 1
    var clientMode = "enforce"
    var catalogueVersion = "2026-10-17+example.1"
    var bundleCatalogueVersion: String?
    var disabledServices: Set<String> = []
    var enabledServices: Set<String> = []
    var extraServices: [JSONValue] = [
        .object([
            "serviceId": .string(GuardPolicy.customServiceId),
            "name": .string("Example AI"),
            "domains": .array([.string(GuardPolicy.customHost)]),
        ]),
    ]
    var services: [String: JSONValue] = [
        "openai-chatgpt": .object(["action": .string("allow")]),
        "deepseek": .object(["action": .string("block"), "ruleId": .string(GuardPolicy.deepseekRuleId), "note": .string(GuardPolicy.deepseekNote)]),
        "anthropic-claude": .object(["action": .string("ask"), "ruleId": .string(GuardPolicy.claudeRuleId)]),
        "perplexity": .object(["action": .string("block"), "ruleId": .string(GuardPolicy.perplexityRuleId)]),
    ]
    var contentRules: [JSONValue] = [
        .object([
            "ruleId": .string(GuardPolicy.chatgptContentRuleId),
            "name": .string(GuardPolicy.chatgptContentRuleName),
            "detector": .object(["kind": .string("keyword"), "keywords": .array([.string(GuardPolicy.chatgptKeyword)])]),
            "services": .array([.string("openai-chatgpt")]),
            "action": .string("block"),
        ]),
    ]
    var exceptions: [JSONValue] = [
        .object(["grantId": .string(GuardPolicy.perplexityGrantId), "scope": .string("user"), "serviceId": .string("perplexity")]),
        .object(["grantId": .string("pgr_000002"), "scope": .string("user"), "serviceId": .string("openai-chatgpt"), "ruleId": .string("gcr_9f8e7d6c")]),
    ]

    func bundleDocument(deviceId: String, orgId: String, personEmail: String) -> JSONValue {
        .object([
            "protocol": .int(1),
            "orgId": .string(orgId),
            "deviceId": .string(deviceId),
            "bundleVersion": .int(bundleVersion),
            "catalogueVersion": .string(bundleCatalogueVersion ?? catalogueVersion),
            "generatedAt": .string("2026-10-24T00:00:00.000Z"),
            "person": .object(["userId": .string("usr_example"), "email": .string(personEmail)]),
            "clientMode": .string(clientMode),
            "defaultAction": .string("allow"),
            "services": .object(services),
            "contentRules": .array(contentRules),
            "exceptions": .array(exceptions),
            "settings": .object([
                "requestsEnabled": .bool(true),
                "workspaceRedirect": .object(["enabled": .bool(true), "url": .string(GuardPolicy.workspaceURL)]),
                "snippetPolicy": .string("redacted"),
                "snippetMax": .int(80),
            ]),
        ])
    }

    func catalogueDocument() throws -> JSONValue {
        let seed = try JSONValue.parse(Data(contentsOf: IntegrationPaths.seedCatalogue))
        guard let rows = seed["services"]?.arrayValue else { throw IntegrationError("the seed catalogue has no services") }
        let services: [JSONValue] = rows.map { row in
            guard let id = row["serviceId"]?.stringValue else { return row }
            if disabledServices.contains(id) { return row.setting("enabled", .bool(false)) }
            if enabledServices.contains(id) { return row.setting("enabled", .bool(true)) }
            return row
        }
        return seed.setting("version", .string(catalogueVersion)).setting("services", .array(services + extraServices))
    }
}

final class PolicyAuthority {
    let key = P256.Signing.PrivateKey()
    let keyId = "gk_" + PolicyAuthority.hex(bytes: 4)
    let orgId = "org_exampleorg"
    let orgHandle = "example-org"
    let orgName = "Example Org"
    let personEmail = "person@example.test"
    let personName = "Example Person"
    let deviceId = "gdev_" + PolicyAuthority.hex(bytes: 8)
    let deviceToken = "gdt_example_" + PolicyAuthority.hex(bytes: 16)

    static func hex(bytes: Int) -> String {
        (0..<bytes).map { _ in String(format: "%02x", UInt8.random(in: 0...255)) }.joined()
    }

    static func base64url(_ data: Data) -> String {
        data.base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }

    func enrolment(clientMode: String) -> JSONValue {
        .object([
            "deviceId": .string(deviceId),
            "orgId": .string(orgId),
            "orgHandle": .string(orgHandle),
            "orgName": .string(orgName),
            "person": .object(["userId": .string("usr_example"), "email": .string(personEmail), "name": .string(personName)]),
            "signing": .object(["keyId": .string(keyId), "alg": .string("ES256"), "publicKeyPem": .string(key.publicKey.pemRepresentation)]),
            "server": .object(["syncIntervalSeconds": .int(10), "batchSize": .int(100)]),
            "clientMode": .string(clientMode),
            "deviceToken": .string(deviceToken),
        ])
    }

    func envelope(kind: String, document: JSONValue, version: JSONValue) throws -> JSONValue {
        let digest = SHA256.hash(data: document.canonical).map { String(format: "%02x", $0) }.joined()
        let header: JSONValue = .object(["alg": .string("ES256"), "kid": .string(keyId), "typ": .string("vibtra-guard+jwt")])
        let payload: JSONValue = .object([
            "kind": .string(kind),
            "keyId": .string(keyId),
            "orgId": .string(orgId),
            "deviceId": .string(deviceId),
            "version": version,
            "digest": .string(digest),
        ])
        let input = Self.base64url(header.canonical) + "." + Self.base64url(payload.canonical)
        let signature = try key.signature(for: Data(input.utf8))
        return .object([
            kind: document,
            "signature": .object(["alg": .string("ES256"), "keyId": .string(keyId), "jws": .string(input + "." + Self.base64url(signature.rawRepresentation))]),
        ])
    }

    func signedPair(_ policy: GuardPolicy) throws -> (bundle: JSONValue, catalogue: JSONValue) {
        let bundle = policy.bundleDocument(deviceId: deviceId, orgId: orgId, personEmail: personEmail)
        let catalogue = try policy.catalogueDocument()
        return (try envelope(kind: "bundle", document: bundle, version: .int(policy.bundleVersion)),
                try envelope(kind: "catalogue", document: catalogue, version: .string(policy.catalogueVersion)))
    }
}
