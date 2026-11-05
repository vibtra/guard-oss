// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Vibtra
import Foundation
import Security
import XCTest

final class ExtensionInboxIntegrationTests: GuardIntegrationCase {
    private let chrome = "com.google.Chrome"

    private func inbox(_ fixture: GuardFixture) -> URL {
        fixture.agent.profileFile(AgentPaths.extensionEventsInbox.lastPathComponent)
    }

    private func waitForBaseline(_ fixture: GuardFixture) throws {
        let cursor = fixture.agent.profileFile("extension-inbox-cursor.json")
        guard Wait.until(15, { FileManager.default.fileExists(atPath: cursor.path) }) else {
            throw IntegrationError("the agent never started reading the extension inbox\n\(fixture.agent.logTail())")
        }
    }

    private func syncedAt(_ status: [String: Any]) -> String? {
        (status["lastSync"] as? [String: Any])?["at"] as? String
    }

    private func waitForTwoSyncs(_ fixture: GuardFixture) {
        for _ in 0..<2 {
            let seen = (try? fixture.agent.status()).flatMap(syncedAt)
            XCTAssertNotNil(fixture.agent.waitForStatus { self.syncedAt($0) != seen }, "the agent finished another sync")
        }
    }

    private func drop(_ host: String, signingId: String?, documents: GuardDocumentState, now: Date = Date()) throws -> (event: [String: Any], line: Data) {
        let verdict = FlowVerdict.decide(host: host, signingId: signingId, bundle: documents.bundle, catalogue: documents.catalogue)
        guard case let .drop(decision, serviceId, signing) = verdict else { throw IntegrationError("expected the filter to drop \(host), got \(verdict)") }
        let event = ExtensionEvents.flowEvent(decision: decision, serviceId: serviceId, host: host, port: 443, signingId: signing,
                                              bundleVersion: documents.bundle?.bundleVersion, now: now)
        return (event, try XCTUnwrap(ExtensionEvents.jsonLine(event)))
    }

    func testFlowsTheFilterDropsReachTheAgentThroughTheInbox() throws {
        let fixture = try makeFixture()
        try waitForBaseline(fixture)
        let documents = try fixture.extensionDocuments()

        let blocked = try drop("Chat.DeepSeek.com.", signingId: chrome, documents: documents)
        XCTAssertEqual(blocked.event["action"] as? String, "blocked")
        XCTAssertEqual(blocked.event["host"] as? String, "chat.deepseek.com")
        XCTAssertEqual(blocked.line.last, 0x0A)
        XCTAssertEqual(blocked.line.filter { $0 == 0x0A }.count, 1, "one event, one line")
        let asked = try drop("claude.ai", signingId: chrome, documents: documents)
        XCTAssertEqual(asked.event["action"] as? String, "asked")
        try ExtensionInboxWriter.append(blocked.line + asked.line, to: inbox(fixture))
        let permissions = try FileManager.default.attributesOfItem(atPath: inbox(fixture).path)[.posixPermissions] as? NSNumber
        XCTAssertEqual(permissions?.intValue, 0o600)

        let blockedId = try XCTUnwrap(blocked.event["eventId"] as? String)
        let askedId = try XCTUnwrap(asked.event["eventId"] as? String)
        let rows = try XCTUnwrap(fixture.agent.waitForActivity { rows in
            Set(rows.compactMap { $0["eventId"] as? String }).isSuperset(of: [blockedId, askedId])
        }, "the agent ingested both rows\n\(fixture.agent.logTail())")
        let row = try XCTUnwrap(rows.first { $0["eventId"] as? String == blockedId })
        XCTAssertEqual(row["serviceId"] as? String, "deepseek")
        XCTAssertEqual(row["serviceName"] as? String, "DeepSeek")
        XCTAssertEqual(row["ruleId"] as? String, GuardPolicy.deepseekRuleId)
        XCTAssertEqual(row["ruleKind"] as? String, "service")
        XCTAssertEqual((row["inspection"] as? [String: Any])?["attribution"] as? String, "extension-inbox-report")
        XCTAssertEqual(rows.first { $0["eventId"] as? String == askedId }?["action"] as? String, "asked")

        let status = try XCTUnwrap(fixture.agent.waitForStatus { (($0["today"] as? [String: Any])?["blocked"] as? Int) == 1 })
        XCTAssertEqual((status["today"] as? [String: Any])?["asked"] as? Int, 1)
        XCTAssertEqual(try fixture.agent.get("/blocked/\(blockedId)").status, 200, "the notice's page exists for an extension drop too")

        XCTAssertTrue(Wait.until(15) { Set(fixture.registry.uploads.compactMap { $0["eventId"] as? String }).isSuperset(of: [blockedId, askedId]) },
                      "the agent uploads the extension's events to the registry")
        let uploaded = try XCTUnwrap(fixture.registry.uploads.first { $0["eventId"] as? String == blockedId })
        XCTAssertEqual(uploaded["reason"] as? String, "extension-flow")
        XCTAssertEqual(uploaded["host"] as? String, "chat.deepseek.com")
        XCTAssertEqual(uploaded["port"] as? Int, 443)
        XCTAssertEqual(uploaded["bundleVersion"] as? Int, documents.bundle?.bundleVersion)
        XCTAssertNil(uploaded["app"], "a disk inbox cannot prove which process made the flow")
    }

    func testOnlyEnforcedDropsAreRecordedAndNeverTheGuardsOwnFlows() throws {
        let fixture = try makeFixture()
        let documents = try fixture.extensionDocuments()
        let bundle = try XCTUnwrap(documents.bundle)
        let catalogue = try XCTUnwrap(documents.catalogue)
        XCTAssertEqual(bundle.clientMode, .enforce)
        XCTAssertEqual(FlowVerdict.decide(host: "chatgpt.com", signingId: chrome, bundle: bundle, catalogue: catalogue), .allow(.allowed), "a rule allows it")
        XCTAssertEqual(FlowVerdict.decide(host: "chat.mistral.ai", signingId: nil, bundle: bundle, catalogue: catalogue), .allow(.allowed), "the default allows it")
        XCTAssertEqual(FlowVerdict.decide(host: "www.perplexity.ai", signingId: chrome, bundle: bundle, catalogue: catalogue), .allow(.allowed),
                       "a flow exception beats the block rule")
        XCTAssertEqual(FlowVerdict.decide(host: "chat.deepseek.com", signingId: chrome, bundle: nil, catalogue: catalogue), .allow(.noBundle))
        var looked = 0
        XCTAssertEqual(FlowVerdict.decide(host: "chat.deepseek.com", signingId: { looked += 1; return chrome }(), bundle: bundle, catalogue: nil), .allow(.noCatalogue))
        for host in ["example.com", "", "notchatgpt.com", "deepseek.com.evil.example"] {
            XCTAssertEqual(FlowVerdict.decide(host: host, signingId: { looked += 1; return chrome }(), bundle: bundle, catalogue: catalogue), .allow(.notCatalogued), host)
        }
        XCTAssertEqual(looked, 0, "the signing id is not read before the host is known to be an AI host")

        let agentCopy = try signedAgentCopy(fixture)
        let identifier = try XCTUnwrap(signingIdentifier(agentCopy))
        XCTAssertEqual(identifier, GuardConstants.agentSigningId, "the build phase's ad hoc identity")
        for own in [identifier, GuardConstants.appBundleId, GuardConstants.extensionBundleId] {
            XCTAssertTrue(GuardConstants.isOwnAgent(signingId: own), own)
            XCTAssertEqual(FlowVerdict.decide(host: "chat.deepseek.com", signingId: own, bundle: bundle, catalogue: catalogue), .allow(.ownAgent), own)
        }
        if let built = signingIdentifier(fixture.agent.binary) {
            XCTAssertTrue(GuardConstants.isOwnAgent(signingId: built), "the unbundled agent build (\(built)) is never dropped either")
        }
        for other in ["com.google.Chrome", "com.openai.chat", "evil.vibtra-guard", GuardConstants.agentSigningId + "x", GuardConstants.extensionBundleId + "x", ""] {
            XCTAssertFalse(GuardConstants.isOwnAgent(signingId: other), other)
        }
        XCTAssertFalse(GuardConstants.isOwnAgent(signingId: nil))

        var policy = fixture.registry.policy
        policy.bundleVersion = 2
        policy.clientMode = "monitor"
        try fixture.registry.publish(policy)
        try fixture.waitForPolicy(2)
        let monitor = try XCTUnwrap(fixture.extensionDocuments().bundle)
        XCTAssertEqual(monitor.clientMode, .monitor)
        XCTAssertEqual(FlowVerdict.decide(host: "chat.deepseek.com", signingId: chrome, bundle: monitor, catalogue: catalogue), .allow(.monitor),
                       "monitor mode lets the flow on to the agent, which records the would-block")
        XCTAssertFalse(FlowVerdict.decide(host: "claude.ai", signingId: chrome, bundle: monitor, catalogue: catalogue).drops)
        let decision = FlowDecision.decide(monitor, serviceId: "deepseek")
        XCTAssertFalse(decision.drops(in: monitor.clientMode))
        let stale = ExtensionEvents.flowEvent(decision: decision, serviceId: "deepseek", host: "chat.deepseek.com", port: 443, signingId: chrome,
                                              bundleVersion: monitor.bundleVersion)
        try waitForBaseline(fixture)
        try ExtensionInboxWriter.append(try XCTUnwrap(ExtensionEvents.jsonLine(stale)), to: inbox(fixture))
        waitForTwoSyncs(fixture)
        XCTAssertFalse(try fixture.agent.activity().contains { $0["eventId"] as? String == stale["eventId"] as? String },
                       "a monitor-mode agent never records a drop the filter did not make")
    }

    func testTheAppDecidesTheRowOnASharedHost() throws {
        let codexRuleId = "gsr_3a4b5c6d"
        let fixture = try makeFixture()
        try waitForBaseline(fixture)
        var policy = fixture.registry.policy
        policy.bundleVersion = 2
        policy.services["openai-codex"] = .object(["action": .string("block"), "ruleId": .string(codexRuleId)])
        try fixture.registry.publish(policy)
        try fixture.waitForPolicy(2)
        let documents = try fixture.extensionDocuments()
        let bundle = try XCTUnwrap(documents.bundle)
        let catalogue = try XCTUnwrap(documents.catalogue)
        XCTAssertEqual(bundle.bundleVersion, 2)

        let codex = try drop("chatgpt.com", signingId: "com.openai.codex", documents: documents)
        XCTAssertEqual(codex.event["serviceId"] as? String, "openai-codex", "the Codex app's own row decides, not the shared host's")
        XCTAssertEqual(codex.event["action"] as? String, "blocked")
        XCTAssertEqual(FlowVerdict.decide(host: "chatgpt.com", signingId: chrome, bundle: bundle, catalogue: catalogue), .allow(.allowed),
                       "ChatGPT in a browser is ChatGPT")

        try ExtensionInboxWriter.append(codex.line, to: inbox(fixture))
        let codexId = try XCTUnwrap(codex.event["eventId"] as? String)
        let rows = try XCTUnwrap(fixture.agent.waitForActivity { rows in rows.contains { $0["eventId"] as? String == codexId } },
                                 "the agent ingested the Codex drop\n\(fixture.agent.logTail())")
        let row = try XCTUnwrap(rows.first { $0["eventId"] as? String == codexId })
        XCTAssertEqual(row["serviceId"] as? String, "openai-codex")
        XCTAssertEqual(row["action"] as? String, "blocked")
        XCTAssertEqual(row["ruleId"] as? String, codexRuleId)
        XCTAssertEqual(row["host"] as? String, "chatgpt.com")
        XCTAssertNotNil(fixture.agent.waitForStatus { (($0["today"] as? [String: Any])?["blocked"] as? Int) == 1 },
                        "only the Codex flow counts as blocked\n\(fixture.agent.logTail())")
    }

    func testConcurrentDrainsKeepEveryCompleteLine() throws {
        let fixture = try makeFixture()
        try waitForBaseline(fixture)
        let documents = try fixture.extensionDocuments()
        let now = Date()
        let lines = try (0..<25).map { _ in try drop("chat.deepseek.com", signingId: chrome, documents: documents, now: now) }
        let failures = Counter()
        let url = inbox(fixture)
        DispatchQueue.concurrentPerform(iterations: lines.count) { index in
            do { try ExtensionInboxWriter.append(lines[index].line, to: url) } catch { failures.increment() }
        }
        XCTAssertEqual(failures.value, 0)
        let ids = Set(lines.compactMap { $0.event["eventId"] as? String })
        XCTAssertEqual(ids.count, 25)
        XCTAssertNotNil(fixture.agent.waitForStatus { (($0["today"] as? [String: Any])?["blocked"] as? Int) == 25 },
                        "every concurrently appended row parsed as one whole event\n\(fixture.agent.logTail())")
        XCTAssertTrue(Wait.until(15) { Set(fixture.registry.uploads.compactMap { $0["eventId"] as? String }).isSuperset(of: ids) })
    }

    func testRedirectedOrSharedInboxFilesAreRefusedAtBothEnds() throws {
        let fixture = try makeFixture()
        try waitForBaseline(fixture)
        let documents = try fixture.extensionDocuments()
        let url = inbox(fixture)
        let target = fixture.agent.profileFile("inbox-target")
        try Data("unchanged".utf8).write(to: target)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: target.path)
        let row = try drop("chat.deepseek.com", signingId: chrome, documents: documents).line

        try FileManager.default.createSymbolicLink(at: url, withDestinationURL: target)
        XCTAssertThrowsError(try ExtensionInboxWriter.append(row, to: url), "never append through a symlink")
        XCTAssertNotNil(fixture.agent.waitForStatus { (($0["lastSync"] as? [String: Any])?["error"] as? String)?.isEmpty == false },
                        "the agent refuses to read a redirected inbox")
        try FileManager.default.removeItem(at: url)
        try FileManager.default.linkItem(at: target, to: url)
        XCTAssertThrowsError(try ExtensionInboxWriter.append(row, to: url), "never append through a second hard link")
        XCTAssertEqual(try String(contentsOf: target, encoding: .utf8), "unchanged")
        try FileManager.default.removeItem(at: url)

        try Data("unchanged".utf8).write(to: url)
        try FileManager.default.setAttributes([.posixPermissions: 0o644], ofItemAtPath: url.path)
        XCTAssertThrowsError(try ExtensionInboxWriter.append(row, to: url), "a readable inbox is refused")
        XCTAssertEqual(try String(contentsOf: url, encoding: .utf8), "unchanged")
        let refused = fixture.agent.waitForStatus {
            (($0["lastSync"] as? [String: Any])?["error"] as? String)?.contains("private owned regular file") == true
        }
        XCTAssertNotNil(refused, "the agent refuses a group- or world-readable inbox too")
        try row.write(to: url)
        try FileManager.default.setAttributes([.posixPermissions: 0o644], ofItemAtPath: url.path)
        waitForTwoSyncs(fixture)
        XCTAssertEqual(((try fixture.agent.status())["today"] as? [String: Any])?["blocked"] as? Int ?? 0, 0,
                       "a whole drop line in a readable inbox is still not ingested")
    }

    private func signedAgentCopy(_ fixture: GuardFixture) throws -> URL {
        let copy = fixture.agent.workDir.appendingPathComponent("vibtra-guard")
        try? FileManager.default.removeItem(at: copy)
        try FileManager.default.copyItem(at: fixture.agent.binary, to: copy)
        let signed = try Command.run(URL(fileURLWithPath: "/usr/bin/codesign"),
                                     ["--force", "--sign", "-", "--identifier", GuardConstants.agentSigningId, copy.path])
        guard signed.status == 0 else { throw IntegrationError("codesign failed: \(signed.output)") }
        return copy
    }

    private func signingIdentifier(_ url: URL) -> String? {
        var code: SecStaticCode?
        guard SecStaticCodeCreateWithPath(url as CFURL, SecCSFlags(), &code) == errSecSuccess, let code else { return nil }
        var info: CFDictionary?
        guard SecCodeCopySigningInformation(code, SecCSFlags(rawValue: kSecCSSigningInformation), &info) == errSecSuccess,
              let values = info as? [String: Any] else { return nil }
        return values[kSecCodeInfoIdentifier as String] as? String
    }
}
