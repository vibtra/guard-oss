// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Vibtra
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
