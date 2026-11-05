// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Vibtra
import Foundation
import XCTest

final class HostMatchingParityIntegrationTests: XCTestCase {
    private var agent: GuardAgent!
    private var files: URL!

    override func setUpWithError() throws {
        agent = try GuardAgent()
        files = try IntegrationPaths.temporaryDirectory("parity")
    }

    override func tearDown() {
        agent?.remove()
        if let files { try? FileManager.default.removeItem(at: files) }
        super.tearDown()
    }

    private func write(_ value: JSONValue, _ name: String) throws -> URL {
        let url = files.appendingPathComponent(name)
        try value.canonical.write(to: url)
        return url
    }

    private func agentVerdict(bundle: URL, catalogue: URL, host: String, bundleId: String? = nil, cli: String? = nil) throws -> [String: Any] {
        var arguments = ["test", "--bundle", bundle.path, "--catalogue", catalogue.path, "--host", host]
        if let bundleId { arguments += ["--bundle-id", bundleId] }
        if let cli { arguments += ["--cli", cli] }
        let result = try agent.command(arguments)
        guard result.status == 0,
              let json = try? JSONSerialization.jsonObject(with: Data(result.output.utf8)) as? [String: Any] else {
            throw IntegrationError("vibtra-guard test \(host) exited \(result.status): \(result.output)")
        }
        return json
    }

    private func agentService(_ verdict: [String: Any]) -> String? {
        guard verdict["intercepted"] as? Bool == true else { return nil }
        return (verdict["service"] as? [String: Any])?["serviceId"] as? String
    }

    private func documents(_ policy: GuardPolicy) throws -> (bundle: URL, catalogue: URL, decoded: GuardCatalogue, decodedBundle: GuardBundle) {
        let bundle = policy.bundleDocument(deviceId: "gdev_0000000000000001", orgId: "org_parity", personEmail: "person@example.test")
        let catalogue = try policy.catalogueDocument()
        return (try write(bundle, "bundle-\(policy.bundleVersion).json"), try write(catalogue, "catalogue-\(policy.bundleVersion).json"),
                try GuardDocuments.decodeCatalogue(catalogue.canonical), try GuardDocuments.decodeBundle(bundle.canonical))
    }

    private func vectors() throws -> [String: Any] {
        try XCTUnwrap(JSONSerialization.jsonObject(with: Data(String(contentsOf: IntegrationPaths.vectors, encoding: .utf8).replacingOccurrences(of: "~~", with: "").utf8)) as? [String: Any])
    }

    func testTheExtensionAndTheAgentPickTheSameRowForEverySharedVector() throws {
        let docs = try documents(GuardPolicy())
        let vectors = try vectors()

        let hostRows = try XCTUnwrap(vectors["serviceForHost"] as? [[String: Any]])
        XCTAssertFalse(hostRows.isEmpty, "the shared vectors lost their serviceForHost section")
        for row in hostRows {
            let host = try XCTUnwrap(row["host"] as? String)
            let expected = row["serviceId"] as? String
            XCTAssertEqual(HostMatcher.serviceForHost(docs.decoded, host: host)?.serviceId, expected, "extension: \(host)")
            XCTAssertEqual(HostMatcher.isIntercepted(docs.decoded, host: host), expected != nil, "extension: \(host)")
            XCTAssertEqual(agentService(try agentVerdict(bundle: docs.bundle, catalogue: docs.catalogue, host: host)), expected, "agent: \(host)")
        }

        let flowRows = try XCTUnwrap(vectors["serviceForFlow"] as? [[String: Any]])
        XCTAssertFalse(flowRows.isEmpty, "the shared vectors lost their serviceForFlow section")
        for row in flowRows {
            let host = try XCTUnwrap(row["host"] as? String)
            let bundleId = row["bundleId"] as? String
            let cli = row["cliName"] as? String
            let expected = row["serviceId"] as? String
            XCTAssertEqual(HostMatcher.serviceForFlow(docs.decoded, host: host, bundleId: bundleId, cliName: cli)?.serviceId, expected, "extension: \(row)")
            XCTAssertEqual(agentService(try agentVerdict(bundle: docs.bundle, catalogue: docs.catalogue, host: host, bundleId: bundleId, cli: cli)), expected, "agent: \(row)")
        }

        let ownership: [(host: String, bundleId: String?, cli: String?, expected: String?)] = [
            ("chatgpt.com", "com.google.Chrome", nil, "openai-chatgpt"),
            ("chatgpt.com", nil, "curl", "openai-chatgpt"),
            ("claude.ai", "com.openai.codex", nil, "anthropic-claude"),
            ("claude.ai", nil, "codex", "anthropic-claude"),
            ("chatgpt.com", nil, "codex", "openai-codex"),
            ("example.com", "com.openai.codex", "codex", nil),
        ]
        for case let (host, bundleId, cli, expected) in ownership {
            XCTAssertEqual(HostMatcher.serviceForFlow(docs.decoded, host: host, bundleId: bundleId, cliName: cli)?.serviceId, expected, "extension: \(host)")
            XCTAssertEqual(agentService(try agentVerdict(bundle: docs.bundle, catalogue: docs.catalogue, host: host, bundleId: bundleId, cli: cli)), expected, "agent: \(host)")
        }
        let claude = try XCTUnwrap(docs.decoded.services.first { $0.serviceId == "anthropic-claude" })
        XCTAssertEqual(claude.bundleIds, ["com.anthropic.claudefordesktop"], "the extension reads the same seed the agent embeds")
        XCTAssertGreaterThanOrEqual(docs.decoded.services.count, 40)
    }

    func testEveryHostPatternVectorMatchesOnBothSides() throws {
        let rows = try XCTUnwrap(try vectors()["hosts"] as? [[String: Any]])
        XCTAssertGreaterThanOrEqual(rows.count, 10, "the shared vectors lost their hosts section")
        let bundle = try write(GuardPolicy().bundleDocument(deviceId: "gdev_0000000000000002", orgId: "org_parity", personEmail: "person@example.test"), "bundle-hosts.json")
        for (index, row) in rows.enumerated() {
            let host = try XCTUnwrap(row["host"] as? String)
            let pattern = try XCTUnwrap(row["pattern"] as? String)
            let expected = try XCTUnwrap(row["matches"] as? Bool)
            let catalogue = JSONValue.object([
                "version": .string("vectors"),
                "generatedAt": .string("2026-10-24T00:00:00.000Z"),
                "services": .array([.object(["serviceId": .string("vector-row"), "name": .string("Vector row"), "domains": .array([.string(pattern)])])]),
            ])
            XCTAssertEqual(HostMatcher.matches(host: host, pattern: pattern), expected, "extension: \(host) vs \(pattern)")
            let verdict = try agentVerdict(bundle: bundle, catalogue: try write(catalogue, "catalogue-hosts-\(index).json"), host: host)
            XCTAssertEqual(verdict["intercepted"] as? Bool, expected, "agent: \(host) vs \(pattern)")
        }
    }

    func testTheExtensionsFlowDecisionMatchesTheAgentsForEveryRuleShape() throws {
        let docs = try documents(GuardPolicy())
        XCTAssertEqual(docs.decodedBundle.clientMode, .enforce)
        for (host, service) in [("chatgpt.com", "openai-chatgpt"), ("chat.deepseek.com", "deepseek"), ("claude.ai", "anthropic-claude"),
                                ("www.perplexity.ai", "perplexity"), ("chat.mistral.ai", "mistral")] {
            let swift = FlowDecision.decide(docs.decodedBundle, serviceId: service)
            let verdict = try agentVerdict(bundle: docs.bundle, catalogue: docs.catalogue, host: host)
            let flow = try XCTUnwrap(verdict["flow"] as? [String: Any], host)
            XCTAssertEqual(flow["action"] as? String, swift.action.rawValue, host)
            XCTAssertEqual(flow["source"] as? String, swift.source.rawValue, host)
            XCTAssertEqual(flow["ruleId"] as? String, swift.ruleId, host)
            XCTAssertEqual(flow["grantId"] as? String, swift.grantId, host)
            XCTAssertEqual(verdict["verdict"] as? String, swift.eventAction, host)
            XCTAssertEqual(swift.drops(in: .enforce), ["blocked", "asked"].contains(verdict["verdict"] as? String ?? ""), host)
            XCTAssertFalse(swift.drops(in: .monitor), "monitor mode never drops: \(host)")
        }
        let deepseek = FlowDecision.decide(docs.decodedBundle, serviceId: "deepseek")
        XCTAssertEqual(deepseek.ruleKind, "service")
        XCTAssertEqual(deepseek.note, GuardPolicy.deepseekNote)
        XCTAssertEqual(FlowDecision.decide(docs.decodedBundle, serviceId: "perplexity").ruleKind, "exception")
        XCTAssertEqual(FlowDecision.decide(docs.decodedBundle, serviceId: "openai-chatgpt").ruleKind, "default",
                       "a content exception never opens the flow")

        var monitor = GuardPolicy()
        monitor.bundleVersion = 2
        monitor.clientMode = "monitor"
        let monitorDocs = try documents(monitor)
        let observed = try agentVerdict(bundle: monitorDocs.bundle, catalogue: monitorDocs.catalogue, host: "chat.deepseek.com")
        XCTAssertEqual(observed["enforced"] as? Bool, false)
        XCTAssertFalse(FlowDecision.decide(monitorDocs.decodedBundle, serviceId: "deepseek").drops(in: monitorDocs.decodedBundle.clientMode))
    }

    func testSwitchedOffRowsAgreeOnBothSides() throws {
        var codexOff = GuardPolicy()
        codexOff.bundleVersion = 3
        codexOff.disabledServices = ["openai-codex"]
        let codex = try documents(codexOff)
        for (bundleId, cli, expected) in [("com.openai.codex", nil, nil), (nil, "codex", nil), ("com.google.Chrome", nil, "openai-chatgpt")] as [(String?, String?, String?)] {
            XCTAssertEqual(HostMatcher.serviceForFlow(codex.decoded, host: "chatgpt.com", bundleId: bundleId, cliName: cli)?.serviceId, expected)
            XCTAssertEqual(agentService(try agentVerdict(bundle: codex.bundle, catalogue: codex.catalogue, host: "chatgpt.com", bundleId: bundleId, cli: cli)), expected,
                           "a switched-off app row never falls back to the shared host's row")
        }

        var chatgptOff = GuardPolicy()
        chatgptOff.bundleVersion = 4
        chatgptOff.disabledServices = ["openai-chatgpt", "deepseek"]
        let chatgpt = try documents(chatgptOff)
        XCTAssertEqual(HostMatcher.serviceForHost(chatgpt.decoded, host: "chatgpt.com")?.serviceId, "openai-codex", "chatgpt.com stays Codex's host")
        XCTAssertEqual(agentService(try agentVerdict(bundle: chatgpt.bundle, catalogue: chatgpt.catalogue, host: "chatgpt.com")), "openai-codex")
        XCTAssertNil(HostMatcher.serviceForHost(chatgpt.decoded, host: "chat.openai.com"))
        XCTAssertNil(agentService(try agentVerdict(bundle: chatgpt.bundle, catalogue: chatgpt.catalogue, host: "chat.openai.com")))
        XCTAssertEqual(FlowVerdict.decide(host: "chat.deepseek.com", signingId: "com.google.Chrome", bundle: chatgpt.decodedBundle, catalogue: chatgpt.decoded),
                       .allow(.notCatalogued), "a row IT switched off is not an AI host for the filter")
        XCTAssertNil(agentService(try agentVerdict(bundle: chatgpt.bundle, catalogue: chatgpt.catalogue, host: "chat.deepseek.com")))
    }
}
