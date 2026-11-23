// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Vibtra
import CryptoKit
import Foundation
import XCTest

final class DocumentPairIntegrationTests: GuardIntegrationCase {
    private func lastSyncError(_ status: [String: Any]) -> String {
        (status["lastSync"] as? [String: Any])?["error"] as? String ?? ""
    }

    func testTheExtensionHoldsExactlyThePairTheAgentActivated() throws {
        let fixture = try makeFixture()
        let first = try fixture.mirroredDocuments()
        let signed = try GuardDocuments.decodeBundle(first.bundle)
        XCTAssertEqual(signed.protocol, 1)
        XCTAssertEqual(signed.bundleVersion, 1)
        XCTAssertEqual(signed.clientMode, .enforce)
        XCTAssertEqual(signed.defaultAction, .allow)
        XCTAssertEqual(signed.services["deepseek"], GuardBundleServiceDecision(action: .block, ruleId: GuardPolicy.deepseekRuleId, note: GuardPolicy.deepseekNote))
        XCTAssertEqual(signed.exceptions.count, 2)
        XCTAssertEqual(signed.settings.workspaceRedirect, GuardWorkspaceRedirect(enabled: true, url: GuardPolicy.workspaceURL))
        XCTAssertEqual(signed.settings.snippetMax, 80)
        let envelope = try XCTUnwrap(JSONSerialization.jsonObject(with: first.bundle) as? [String: Any])
        let bare = try JSONSerialization.data(withJSONObject: try XCTUnwrap(envelope["bundle"]))
        XCTAssertEqual(try GuardDocuments.decodeBundle(bare), signed, "the bare document and the agent's signed envelope decode alike")

        var state = GuardDocumentState()
        XCTAssertThrowsError(try state.load(bundleData: first.bundle, catalogueData: nil), "a bundle alone activates nothing")
        XCTAssertNil(state.bundle)
        XCTAssertNil(state.catalogue)
        XCTAssertThrowsError(try state.load(bundleData: nil, catalogueData: first.catalogue))
        XCTAssertNil(state.catalogue)
        try state.load(bundleData: first.bundle, catalogueData: first.catalogue)
        let active = (bundle: state.bundle, catalogue: state.catalogue)
        XCTAssertEqual(active.bundle?.bundleVersion, 1)

        var mismatched = GuardPolicy()
        mismatched.bundleVersion = 2
        mismatched.catalogueVersion = "2026-10-17+example.2"
        mismatched.bundleCatalogueVersion = "2026-10-17+example.other"
        try fixture.registry.publish(mismatched)
        let refused = try XCTUnwrap(fixture.agent.waitForStatus { self.lastSyncError($0).contains("catalogue version mismatch") },
                                    "the agent refuses a pair whose versions disagree")
        XCTAssertEqual(refused["bundleVersion"] as? Int, 1, "and keeps enforcing the last verified pair")
        XCTAssertEqual(try fixture.mirroredDocuments().bundle, first.bundle, "its published mirrors are untouched")
        let offeredBundle = fixture.registry.bundleEnvelope.canonical
        let offeredCatalogue = fixture.registry.catalogueEnvelope.canonical
        let malformed = Data("{bad".utf8)
        for (bundle, catalogue) in [(offeredBundle, offeredCatalogue), (offeredBundle, malformed), (malformed, offeredCatalogue), (malformed, first.catalogue)] {
            XCTAssertThrowsError(try state.load(bundleData: bundle, catalogueData: catalogue))
            XCTAssertEqual(state.bundle, active.bundle, "the extension keeps the same pair as the agent")
            XCTAssertEqual(state.catalogue, active.catalogue)
        }
        XCTAssertThrowsError(try state.load(bundleData: nil, catalogueData: offeredCatalogue))
        XCTAssertEqual(state.catalogue, active.catalogue)

        var coherent = GuardPolicy()
        coherent.bundleVersion = 2
        coherent.catalogueVersion = "2026-10-17+example.2"
        coherent.disabledServices = ["openai-codex"]
        try fixture.registry.publish(coherent)
        try fixture.waitForPolicy(2)
        let second = try fixture.mirroredDocuments()
        try state.load(bundleData: second.bundle, catalogueData: second.catalogue)
        XCTAssertEqual(state.bundle?.bundleVersion, 2)
        XCTAssertEqual(state.catalogue?.version, coherent.catalogueVersion)
        XCTAssertTrue(CodexWorkExclusion.shouldBypass(signingId: "com.openai.codex", catalogue: state.catalogue, validSignature: true))

        var bundleOnly = coherent
        bundleOnly.bundleVersion = 3
        try fixture.registry.publish(bundleOnly, catalogue: false)
        try fixture.waitForPolicy(3)
        let third = try fixture.mirroredDocuments()
        XCTAssertEqual(third.catalogue, second.catalogue, "a bundle-only download keeps the agent's catalogue")
        try state.load(bundleData: third.bundle, catalogueData: nil)
        XCTAssertEqual(state.bundle?.bundleVersion, 3)
        XCTAssertEqual(state.catalogue?.version, coherent.catalogueVersion, "and the extension keeps its catalogue too")
        XCTAssertTrue(CodexWorkExclusion.shouldBypass(signingId: "com.openai.codex", catalogue: state.catalogue, validSignature: true),
                      "the disabled Codex row survives a bundle-only update")

        var catalogueOnly = bundleOnly
        catalogueOnly.disabledServices = []
        try fixture.registry.publish(catalogueOnly, bundle: false)
        XCTAssertTrue(Wait.until(15) { (try? fixture.mirroredDocuments().catalogue) != third.catalogue }, "the agent took the same-version catalogue")
        let fourth = try fixture.mirroredDocuments()
        XCTAssertEqual(fourth.bundle, third.bundle)
        try state.load(bundleData: nil, catalogueData: fourth.catalogue)
        XCTAssertEqual(state.bundle?.bundleVersion, 3)
        XCTAssertFalse(CodexWorkExclusion.shouldBypass(signingId: "com.openai.codex", catalogue: state.catalogue, validSignature: true),
                       "a same-version catalogue update turns the exemption off on both sides")
        let codex = try XCTUnwrap(try JSONSerialization.jsonObject(with: Data(fixture.agent.command(["test", "--host", "chatgpt.com", "--bundle-id", "com.openai.codex"]).output.utf8)) as? [String: Any])
        XCTAssertEqual(codex["intercepted"] as? Bool, true)
        try state.load(bundleData: nil, catalogueData: nil)
        XCTAssertEqual(state.catalogue?.version, coherent.catalogueVersion, "an empty update changes nothing")
    }
}

final class SignedPolicyIntegrationTests: XCTestCase {
    private let authority = PolicyAuthority()

    private func bundle(_ fields: [String: JSONValue] = [:]) -> JSONValue {
        fields.reduce(GuardPolicy().bundleDocument(deviceId: authority.deviceId, orgId: authority.orgId, personEmail: authority.personEmail)) { $0.setting($1.key, $1.value) }
    }

    private func signed(_ document: JSONValue, claims: [String: JSONValue] = [:]) throws -> Data {
        try authority.envelope(kind: "bundle", document: document, version: document["bundleVersion"] ?? .int(1), claims: claims).canonical
    }

    private func signedCatalogue() throws -> Data {
        try authority.envelope(kind: "catalogue", document: GuardPolicy().catalogueDocument(), version: .string(GuardPolicy().catalogueVersion)).canonical
    }

    private func pinned(publicKeyPem: String? = nil) throws -> GuardPolicyPin {
        try XCTUnwrap(GuardPolicyPin(record: authority.pinRecord(publicKeyPem: publicKeyPem)))
    }

    func testTheExtensionUsesOnlyAPolicySignedWithThePinnedKey() throws {
        let pin = try pinned()
        var state = GuardVerifiedPolicy()
        try state.load(bundleData: try signed(bundle()), catalogueData: try signedCatalogue(), pin: pin)
        XCTAssertEqual(state.documents.bundle?.clientMode, .enforce)

        let next = bundle(["bundleVersion": .int(2)])
        let envelope = try JSONValue.parse(try signed(next))
        let tampered = envelope.setting("bundle", next.setting("clientMode", .string("off"))).canonical
        for (name, data) in [("an edited bundle", tampered), ("a bundle with no signature", next.canonical)] {
            XCTAssertThrowsError(try state.load(bundleData: data, catalogueData: nil, pin: pin), name) {
                XCTAssertEqual($0 as? GuardPolicyError, .unverified("bundle"), name)
            }
            XCTAssertEqual(state.documents.bundle?.bundleVersion, 1, "\(name) changes nothing")
            XCTAssertEqual(state.bundle(at: Date())?.clientMode, .enforce, name)
        }

        var otherKey = GuardVerifiedPolicy()
        let stranger = P256.Signing.PrivateKey().publicKey.pemRepresentation
        XCTAssertThrowsError(try otherKey.load(bundleData: try signed(next), catalogueData: try signedCatalogue(), pin: try pinned(publicKeyPem: stranger)),
                             "a policy signed by a key other than the pinned one")
        XCTAssertNil(otherKey.documents.bundle)

        let otherDevice = JSONValue.object([
            "deviceId": .string("gdev_00000000000000ff"),
            "orgId": .string(authority.orgId),
            "signing": .object(["keyId": .string(authority.keyId), "alg": .string("ES256"), "publicKeyPem": .string(authority.key.publicKey.pemRepresentation)]),
            "source": .string("enrolment"),
        ]).canonical
        var elsewhere = GuardVerifiedPolicy()
        XCTAssertThrowsError(try elsewhere.load(bundleData: try signed(next), catalogueData: try signedCatalogue(), pin: try XCTUnwrap(GuardPolicyPin(record: otherDevice))),
                             "a policy for another device")
        XCTAssertNil(GuardPolicyPin(record: try JSONValue.parse(authority.pinRecord()).setting("source", .string("first-use")).canonical),
                     "a pin an earlier Guard took from device.json is not trusted")

        try state.load(bundleData: try signed(next), catalogueData: nil, pin: pin)
        XCTAssertEqual(state.documents.bundle?.bundleVersion, 2)
    }

    func testAnOlderStampIsRefusedAndANewerOneTaken() throws {
        let pin = try pinned()
        let catalogue = try signedCatalogue()
        var state = GuardVerifiedPolicy()
        func load(version: Int, revision: Int, signedAt: Int) throws {
            let document = bundle(["bundleVersion": .int(version), "protectionRevision": .int(revision)])
            try state.load(bundleData: try signed(document, claims: ["iat": .int(signedAt)]), catalogueData: catalogue, pin: pin)
        }
        try load(version: 1, revision: 5, signedAt: 1_000)
        for (revision, signedAt) in [(4, 2_000), (5, 999)] {
            XCTAssertThrowsError(try load(version: 1, revision: revision, signedAt: signedAt), "revision \(revision) signed at \(signedAt)") {
                XCTAssertEqual($0 as? GuardPolicyError, .older)
            }
            XCTAssertEqual(state.documents.bundle?.protectionRevision, 5)
        }
        try load(version: 1, revision: 5, signedAt: 1_000)
        try load(version: 1, revision: 6, signedAt: 500)
        XCTAssertEqual(state.documents.bundle?.protectionRevision, 6, "a higher revision wins over an earlier signing time")
        try load(version: 2, revision: 0, signedAt: 0)
        XCTAssertEqual(state.documents.bundle?.bundleVersion, 2, "a higher bundle version wins over the revision")
    }

    func testAStoredCopyNeverLowersTheHeldStampOrReplacesTheHeldPin() throws {
        let pin = try pinned()
        let catalogue = try signedCatalogue()
        func stored(revision: Int) throws -> Data { try signed(bundle(["protectionRevision": .int(revision)])) }
        var state = GuardVerifiedPolicy()
        try state.restore(bundleData: try stored(revision: 5), catalogueData: catalogue, pin: pin)
        XCTAssertEqual(state.pin, pin, "with nothing held, the container's copy brings its pin")

        XCTAssertThrowsError(try state.restore(bundleData: try stored(revision: 4), catalogueData: catalogue, pin: pin), "an older turn-on snapshot") {
            XCTAssertEqual($0 as? GuardPolicyError, .older)
        }
        XCTAssertEqual(state.documents.bundle?.protectionRevision, 5, "the newer copy stays the floor")

        let earlier = PolicyAuthority()
        var earlierPolicy = GuardPolicy()
        earlierPolicy.bundleVersion = 9
        let earlierPair = try earlier.signedPair(earlierPolicy)
        let earlierPin = try XCTUnwrap(GuardPolicyPin(record: earlier.pinRecord()))
        XCTAssertThrowsError(try state.restore(bundleData: earlierPair.bundle.canonical, catalogueData: earlierPair.catalogue.canonical, pin: earlierPin),
                             "a snapshot under another key")
        XCTAssertEqual(state.pin, pin, "a stored copy never replaces the held pin")
        XCTAssertEqual(state.documents.bundle?.bundleVersion, 1)

        try state.restore(bundleData: try stored(revision: 6), catalogueData: nil, pin: earlierPin)
        XCTAssertEqual(state.documents.bundle?.protectionRevision, 6, "a newer copy is checked against the held pin and taken")
        XCTAssertEqual(state.pin, pin)
    }

    func testANewPinTakesOverOnlyWithAPairThatVerifiesUnderIt() throws {
        let pin = try pinned()
        var state = GuardVerifiedPolicy()
        try state.load(bundleData: try signed(bundle()), catalogueData: try signedCatalogue(), pin: pin)
        let next = PolicyAuthority()
        var nextPolicy = GuardPolicy()
        nextPolicy.bundleVersion = 7
        let pair = try next.signedPair(nextPolicy)
        let nextPin = try XCTUnwrap(GuardPolicyPin(record: next.pinRecord()))
        let oldBundle = try signed(bundle())
        let oldCatalogue = try signedCatalogue()
        let refused: [(name: String, bundle: Data, catalogue: Data?)] = [
            ("documents the new key did not sign", oldBundle, oldCatalogue),
            ("a bundle without its catalogue", pair.bundle.canonical, nil),
        ]
        for item in refused {
            XCTAssertThrowsError(try state.load(bundleData: item.bundle, catalogueData: item.catalogue, pin: nextPin), item.name)
            XCTAssertEqual(state.pin, pin, "\(item.name): the previous pin stays")
            XCTAssertEqual(state.documents.bundle?.bundleVersion, 1, "\(item.name): and so does its pair")
            XCTAssertNotNil(state.documents.catalogue, item.name)
        }
        try state.load(bundleData: pair.bundle.canonical, catalogueData: pair.catalogue.canonical, pin: nextPin)
        XCTAssertEqual(state.pin, nextPin)
        XCTAssertEqual(state.documents.bundle?.bundleVersion, 7, "a pair that verifies under the new pin replaces both together")
    }

    func testPastValidUntilTheModeRisesToTheDefaultAndUnknownModesEnforce() throws {
        let pin = try pinned()
        let now = Date()
        let soon = Int(now.timeIntervalSince1970) + 3_600
        let cases: [(mode: String, defaultMode: String?, validUntil: Int?, before: GuardClientMode, after: GuardClientMode)] = [
            ("off", "monitor", soon, .off, .monitor),
            ("enforce", "off", soon, .enforce, .enforce),
            ("monitor", "audit", soon, .monitor, .enforce),
            ("lockdown", "off", soon, .enforce, .enforce),
            ("off", "enforce", nil, .off, .off),
        ]
        for item in cases {
            var fields: [String: JSONValue] = ["clientMode": .string(item.mode)]
            if let defaultMode = item.defaultMode { fields["defaultMode"] = .string(defaultMode) }
            var state = GuardVerifiedPolicy()
            try state.load(bundleData: try signed(bundle(fields), claims: item.validUntil.map { ["validUntil": JSONValue.int($0)] } ?? [:]), catalogueData: try signedCatalogue(), pin: pin)
            let label = "\(item.mode) with default \(item.defaultMode ?? "none")"
            XCTAssertEqual(state.bundle(at: now)?.clientMode, item.before, label)
            XCTAssertEqual(state.bundle(at: now.addingTimeInterval(7_200))?.clientMode, item.after, label)
            XCTAssertEqual(state.expired(at: now.addingTimeInterval(7_200)), item.validUntil != nil, label)
        }
    }

    func testAnExpiryMissedAsleepOrBeforeStartKeepsTheSignedModeForTheGrace() throws {
        let pin = try pinned()
        let expiry = Int(Date().timeIntervalSince1970) + 3_600
        let validUntil = Date(timeIntervalSince1970: TimeInterval(expiry))
        var state = GuardVerifiedPolicy()
        try state.load(bundleData: try signed(bundle(["clientMode": .string("off"), "defaultMode": .string("enforce")]), claims: ["validUntil": .int(expiry)]), catalogueData: try signedCatalogue(), pin: pin)
        let grace = GuardExpiryHold.grace

        var started = GuardExpiryHold()
        let start = validUntil.addingTimeInterval(7_200)
        XCTAssertTrue(started.observe(wall: start, uptime: 30))
        XCTAssertEqual(state.bundle(at: start.addingTimeInterval(60), hold: started)?.clientMode, .off, "a policy that expired before the extension started keeps its signed mode")
        XCTAssertEqual(state.bundle(at: start.addingTimeInterval(grace + 1), hold: started)?.clientMode, .enforce, "until the grace passes")
        XCTAssertEqual(state.bundle(at: start.addingTimeInterval(60))?.clientMode, .enforce, "without the hold the fallback applies at once")

        var slept = GuardExpiryHold()
        let beforeSleep = validUntil.addingTimeInterval(-60)
        XCTAssertTrue(slept.observe(wall: beforeSleep, uptime: 1_000))
        XCTAssertFalse(slept.observe(wall: beforeSleep.addingTimeInterval(2), uptime: 1_002), "no sleep, no wake")
        let woke = validUntil.addingTimeInterval(7_200)
        XCTAssertTrue(slept.observe(wall: woke, uptime: 1_003), "the wall clock ran ahead of the uptime")
        XCTAssertEqual(state.bundle(at: woke.addingTimeInterval(5), hold: slept)?.clientMode, .off, "an expiry slept through keeps the signed mode")
        XCTAssertEqual(state.bundle(at: woke.addingTimeInterval(grace + 1), hold: slept)?.clientMode, .enforce)

        var seen = GuardExpiryHold()
        XCTAssertTrue(seen.observe(wall: beforeSleep, uptime: 1_000))
        XCTAssertFalse(seen.observe(wall: validUntil.addingTimeInterval(30), uptime: 1_090), "the expiry passed while awake")
        XCTAssertEqual(state.bundle(at: validUntil.addingTimeInterval(31), hold: seen)?.clientMode, .enforce)
        XCTAssertTrue(seen.observe(wall: woke, uptime: 1_091))
        XCTAssertEqual(state.bundle(at: woke.addingTimeInterval(5), hold: seen)?.clientMode, .enforce, "an expiry seen awake is not undone by a later sleep")
    }

    func testTheCanonicalFormMatchesTheTypeScriptSigner() throws {
        let fixtures = IntegrationPaths.repoRoot.appendingPathComponent("guard/agent/tests/fixtures")
        let signed = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: fixtures.appendingPathComponent("signed-bundle.json"))) as? [String: Any])
        let digests = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: fixtures.appendingPathComponent("digests.json"))) as? [String: Any])
        let expected = try XCTUnwrap(digests["bundleCanonical"] as? String)
        XCTAssertEqual(String(decoding: try GuardCanonicalJSON.data(try XCTUnwrap(signed["bundle"])), as: UTF8.self), expected)
        XCTAssertEqual(SHA256.hash(data: Data(expected.utf8)).map { String(format: "%02x", $0) }.joined(), digests["bundleDigest"] as? String)
    }
}
