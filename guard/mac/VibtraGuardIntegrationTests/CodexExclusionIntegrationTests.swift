// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Vibtra
import Foundation
import Security
import XCTest

final class CodexExclusionIntegrationTests: GuardIntegrationCase {
    private func agentIntercepts(_ fixture: GuardFixture, bundleId: String) throws -> [String: Any] {
        let result = try fixture.agent.command(["test", "--host", "chatgpt.com", "--bundle-id", bundleId])
        return try XCTUnwrap(try JSONSerialization.jsonObject(with: Data(result.output.utf8)) as? [String: Any], result.output)
    }

    func testOnlyAVerifiedCodexProcessIsExemptedWhileItsRowIsOff() throws {
        var policy = GuardPolicy()
        policy.disabledServices = ["openai-codex"]
        let fixture = try makeFixture(policy)
        let documents = try fixture.extensionDocuments()
        let bundle = try XCTUnwrap(documents.bundle)
        let catalogue = try XCTUnwrap(documents.catalogue)

        for id in CodexWorkExclusion.signingIds {
            XCTAssertTrue(CodexWorkExclusion.isCandidate(signingId: id, catalogue: catalogue), id)
        }
        for id in ["com.openai.chat", "com.anthropic.claudefordesktop", "com.google.Chrome", "com.openai.codex.evil", "evil.com.openai.codex", "codex-dev", ""] {
            var inspected = false
            XCTAssertFalse(CodexWorkExclusion.shouldBypass(signingId: id, catalogue: catalogue, validSignature: { inspected = true; return true }()), id)
            XCTAssertFalse(inspected, "no signature read for an unrelated identity: \(id)")
        }
        XCTAssertFalse(CodexWorkExclusion.shouldBypass(signingId: "com.openai.codex", catalogue: nil, validSignature: true))
        var missing = catalogue
        missing.services.removeAll { $0.serviceId == "openai-codex" }
        XCTAssertFalse(CodexWorkExclusion.shouldBypass(signingId: "com.openai.codex", catalogue: missing, validSignature: true))

        var staticCode: SecStaticCode?
        XCTAssertEqual(SecStaticCodeCreateWithPath(fixture.agent.binary as CFURL, SecCSFlags(), &staticCode), errSecSuccess)
        let agentCode = try XCTUnwrap(staticCode)
        var me: SecCode?
        XCTAssertEqual(SecCodeCopySelf(SecCSFlags(), &me), errSecSuccess)
        let selfCode = try XCTUnwrap(me)
        for id in CodexWorkExclusion.signingIds {
            let text = try XCTUnwrap(CodexWorkExclusion.requirement(signingId: id))
            var requirement: SecRequirement?
            XCTAssertEqual(SecRequirementCreateWithString(text as CFString, SecCSFlags(), &requirement), errSecSuccess, text)
            let parsed = try XCTUnwrap(requirement)
            let agentPasses = SecStaticCodeCheckValidity(agentCode, SecCSFlags(), parsed) == errSecSuccess
            XCTAssertFalse(agentPasses, "a binary that is not OpenAI's never satisfies \(id)'s requirement")
            XCTAssertNotEqual(SecCodeCheckValidity(selfCode, SecCSFlags(), parsed), errSecSuccess)
            XCTAssertFalse(CodexWorkExclusion.shouldBypass(signingId: id, catalogue: catalogue, validSignature: agentPasses))
        }
        XCTAssertNil(CodexWorkExclusion.requirement(signingId: "com.openai.chat"))
        XCTAssertNil(CodexWorkExclusion.requirement(signingId: "com.openai.codex\" or true"))

        let front = try fixture.front(SteeringRoute(host: "chatgpt.com", excludedApp: true), catalogue: catalogue)
        XCTAssertThrowsError(try fixture.send(front, serverName: "chatgpt.com", request(host: "chatgpt.com", path: "/codex-work")))
        XCTAssertEqual(front.verdicts.last, .passThrough(.excludedApp), "a verified Codex socket is handed back to the system")
        let addresses = HostAddressCache()
        addresses.record(address: "203.0.113.7", host: "chatgpt.com")
        for host in ["chatgpt.com", "api.openai.com", "claude.ai", "chat.deepseek.com"] {
            XCTAssertEqual(ProxySteering.decide(isTCP: true, host: host, port: 443, catalogue: catalogue, ownAgent: false, excludedApp: true), .passThrough(.excludedApp), host)
            XCTAssertEqual(FlowVerdict.decide(host: host, signingId: "com.openai.codex.helper", bundle: bundle, catalogue: catalogue, excludedApp: true), .allow(.excludedApp), host)
            XCTAssertEqual(FlowVerdict.decideDatagram(host: host, remoteAddress: nil, port: 443, catalogue: catalogue, excludedApp: true) { _ in nil }, .allow(.excludedApp), host)
        }
        XCTAssertEqual(ProxySteering.decide(isTCP: true, host: "203.0.113.7", port: 443, catalogue: catalogue, ownAgent: false, excludedApp: true,
                                            hostForAddress: { addresses.host(for: $0) }), .passThrough(.excludedApp))

        front.route = SteeringRoute(host: "chatgpt.com")
        let browser = try fixture.send(front, serverName: "chatgpt.com", request(host: "chatgpt.com", path: "/still-protected"))
        XCTAssertEqual(front.verdicts.last, .steer(serviceId: "openai-chatgpt"), "everyone else's chatgpt.com flows stay steered")
        XCTAssertEqual(browser.peerSubject, "chatgpt.com")
        XCTAssertTrue(FlowVerdict.decide(host: "claude.ai", signingId: "com.anthropic.claudefordesktop", bundle: bundle, catalogue: catalogue).drops)
        XCTAssertTrue(FlowVerdict.decideDatagram(host: "chatgpt.com", remoteAddress: nil, port: 443, catalogue: catalogue) { _ in nil }.drops)
        XCTAssertEqual(try agentIntercepts(fixture, bundleId: "com.openai.codex")["intercepted"] as? Bool, false,
                       "the agent also leaves Codex's own identity alone while the row is off")

        var on = policy
        on.bundleVersion = 2
        on.catalogueVersion = "2026-10-17+example.2"
        on.disabledServices = []
        try fixture.registry.publish(on)
        try fixture.waitForPolicy(2)
        let after = try XCTUnwrap(fixture.extensionDocuments().catalogue)
        XCTAssertFalse(CodexWorkExclusion.shouldBypass(signingId: "com.openai.codex", catalogue: after, validSignature: true),
                       "turning the row back on ends the exemption")
        let enabled = try agentIntercepts(fixture, bundleId: "com.openai.codex")
        XCTAssertEqual(enabled["intercepted"] as? Bool, true)
        XCTAssertEqual((enabled["service"] as? [String: Any])?["serviceId"] as? String, "openai-codex")
    }
}
