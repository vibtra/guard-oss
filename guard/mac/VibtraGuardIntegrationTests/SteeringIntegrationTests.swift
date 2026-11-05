// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Vibtra
import Foundation
import XCTest

final class SteeringIntegrationTests: GuardIntegrationCase {
    func testAnAIHostOpenedByNameIsSteeredThroughTheAgentAndInspected() throws {
        let fixture = try makeFixture()
        let catalogue = try XCTUnwrap(fixture.extensionDocuments().catalogue)
        XCTAssertTrue(SteeringRules.steeredHosts(catalogue).contains("chatgpt.com"), "the network rule hands chatgpt.com flows to the provider")
        XCTAssertEqual(ProxySteering.decide(isTCP: true, host: "Gemini.Google.com.", port: 443, catalogue: catalogue, ownAgent: false),
                       .steer(serviceId: "google-gemini"))
        XCTAssertEqual(ProxySteering.decide(isTCP: true, host: "chatgpt.com", port: nil, catalogue: catalogue, ownAgent: false),
                       .steer(serviceId: "openai-chatgpt"), "a name endpoint without a port is the rule's 443")

        let front = try fixture.front(SteeringRoute(host: "chatgpt.com"), catalogue: catalogue)
        let exchange = try fixture.send(front, serverName: "chatgpt.com",
                                        request(host: "chatgpt.com", path: "/steering-check", headers: [("Accept", "application/json")]))
        XCTAssertEqual(front.verdicts, [.steer(serviceId: "openai-chatgpt")])
        XCTAssertEqual(front.preambles.map { String(decoding: $0, as: UTF8.self) }, ["PROXY UNKNOWN\r\n"])
        XCTAssertEqual(exchange.status, 200)
        XCTAssertEqual(exchange.text, GuardFixture.upstreamBody)
        XCTAssertEqual(exchange.peerSubject, "chatgpt.com", "the agent, not the site, answered the TLS handshake")
        XCTAssertEqual(exchange.header("x-vibtra-guard"), "allowed")
        XCTAssertEqual(front.onQueue { front.lastRelay?.wentDirect }, false)
        XCTAssertTrue(fixture.upstream.requests.contains { $0.path == "/steering-check" }, "the allowed request reached the upstream")
        let row = try XCTUnwrap(fixture.agent.waitForActivity { !$0.isEmpty }?.first)
        XCTAssertEqual(row["serviceId"] as? String, "openai-chatgpt")
        XCTAssertEqual(row["host"] as? String, "chatgpt.com")
    }

    func testFlowsTheExtensionDoesNotOwnAreHandedBackAndNeverReachTheAgent() throws {
        let fixture = try makeFixture()
        let catalogue = try XCTUnwrap(fixture.extensionDocuments().catalogue)
        let steered = SteeringRules.steeredHosts(catalogue)
        XCTAssertTrue(steered.contains("googleapis.com"), "the network rules over-match googleapis.com on purpose")
        XCTAssertTrue(steered.contains("amazonaws.com"))
        XCTAssertFalse(steered.contains("sora.chatgpt.com"), "a subdomain of a steered domain is already covered")
        XCTAssertEqual(steered, steered.sorted())
        for host in ["chatgpt.com", "api.openai.com", "claude.ai", "api2.cursor.sh", "bedrock-runtime.us-east-1.amazonaws.com", GuardPolicy.customHost] {
            XCTAssertTrue(steered.contains { host == $0 || host.hasSuffix(".\($0)") }, "\(host) reaches the provider")
        }
        XCTAssertEqual(SteeringRules.steeredHost(for: "*.openai.azure.com"), "openai.azure.com")
        XCTAssertEqual(SteeringRules.steeredHost(for: "bedrock-runtime.*.amazonaws.com"), "amazonaws.com")
        XCTAssertNil(SteeringRules.steeredHost(for: "*.com"), "never a bare public suffix")

        let front = try fixture.front(SteeringRoute(host: "content-autofill.googleapis.com"), catalogue: catalogue)
        let cases: [(SteeringRoute, ProxySteering.Verdict)] = [
            (SteeringRoute(host: "content-autofill.googleapis.com"), .passThrough(.notCatalogued)),
            (SteeringRoute(host: "s3.amazonaws.com"), .passThrough(.notCatalogued)),
            (SteeringRoute(host: "notchatgpt.com"), .passThrough(.notCatalogued)),
            (SteeringRoute(host: "chatgpt.com.evil.example"), .passThrough(.notCatalogued)),
            (SteeringRoute(host: "chatgpt.com", port: 80), .passThrough(.notHTTPS)),
            (SteeringRoute(host: "chatgpt.com", ownAgent: true), .passThrough(.ownAgent)),
            (SteeringRoute(host: ""), .passThrough(.noHost)),
        ]
        for (route, expected) in cases {
            front.route = route
            XCTAssertThrowsError(try fixture.send(front, serverName: "chatgpt.com", request(host: "chatgpt.com", path: "/handed-back")),
                                 "\(route.host):\(route.port) is not relayed")
            XCTAssertEqual(front.verdicts.last, expected, "\(route.host):\(route.port)")
        }
        front.catalogue = nil
        front.route = SteeringRoute(host: "chatgpt.com")
        XCTAssertThrowsError(try fixture.send(front, serverName: "chatgpt.com", request(host: "chatgpt.com", path: "/handed-back")))
        XCTAssertEqual(front.verdicts.last, .passThrough(.noCatalogue), "before documents load every flow is the system's")
        XCTAssertEqual(ProxySteering.decide(isTCP: false, host: "chatgpt.com", port: 443, catalogue: catalogue, ownAgent: false), .passThrough(.notTCP))
        var signatureReads = 0
        _ = ProxySteering.decide(isTCP: true, host: "example.com", port: 443, catalogue: catalogue, ownAgent: { signatureReads += 1; return false }())
        XCTAssertEqual(signatureReads, 0, "no code-signature read for a flow that is not an AI host's")

        XCTAssertTrue(front.relays.isEmpty, "nothing was relayed to the agent")
        XCTAssertTrue(try fixture.agent.activity().isEmpty, "the agent saw none of these flows")
        XCTAssertTrue(fixture.upstream.requests.isEmpty)
    }

    func testWildcardAndMinimalCustomRowsAreSteeredAndInterceptedOnBothSides() throws {
        let fixture = try makeFixture()
        let catalogue = try XCTUnwrap(fixture.extensionDocuments().catalogue)
        let custom = try XCTUnwrap(catalogue.services.first { $0.serviceId == GuardPolicy.customServiceId })
        XCTAssertTrue(custom.enabled, "a row with no enabled field is enabled, as the contract defaults it")
        XCTAssertEqual(custom.bundleIds, [])
        XCTAssertEqual(custom.cliNames, [])
        XCTAssertFalse(custom.custom)
        XCTAssertNil(custom.markId)

        for (host, service) in [("us-central1-aiplatform.googleapis.com", "google-vertex-ai"), (GuardPolicy.customHost, GuardPolicy.customServiceId)] {
            let front = try fixture.front(SteeringRoute(host: host), catalogue: catalogue)
            let exchange = try fixture.send(front, serverName: host, request(host: host, path: "/row-check"))
            XCTAssertEqual(front.verdicts, [.steer(serviceId: service)], host)
            XCTAssertEqual(exchange.status, 200, host)
            XCTAssertEqual(exchange.peerSubject, host, "the agent intercepted \(host)")
            XCTAssertEqual(exchange.header("x-vibtra-guard"), "allowed", host)
        }
        let rows = try XCTUnwrap(fixture.agent.waitForActivity { $0.count >= 2 })
        XCTAssertEqual(Set(rows.compactMap { $0["serviceId"] as? String }), ["google-vertex-ai", GuardPolicy.customServiceId],
                       "the agent picked the same rows as the extension")
    }

    func testASwitchedOffRowIsNeitherSteeredNorInspected() throws {
        let fixture = try makeFixture()
        var policy = GuardPolicy()
        policy.bundleVersion = 2
        policy.catalogueVersion = "2026-10-17+example.2"
        policy.disabledServices = ["anthropic-claude"]
        try fixture.registry.publish(policy)
        try fixture.waitForPolicy(2)

        let catalogue = try XCTUnwrap(fixture.extensionDocuments().catalogue)
        XCTAssertEqual(catalogue.version, policy.catalogueVersion, "the extension holds the pair the agent activated")
        let front = try fixture.front(SteeringRoute(host: "claude.ai"), catalogue: catalogue)
        XCTAssertThrowsError(try fixture.send(front, serverName: "claude.ai", request(host: "claude.ai", path: "/switched-off")))
        XCTAssertEqual(front.verdicts, [.passThrough(.notCatalogued)])

        let verdict = try fixture.agent.command(["test", "--host", "claude.ai"])
        XCTAssertEqual(verdict.status, 0, verdict.output)
        let agentView = try XCTUnwrap(try JSONSerialization.jsonObject(with: Data(verdict.output.utf8)) as? [String: Any])
        XCTAssertEqual(agentView["intercepted"] as? Bool, false, "the agent no longer inspects the switched-off row either")
    }

    func testTheAgentAcceptsEveryPreambleTheExtensionCanWrite() throws {
        let fixture = try makeFixture()
        let catalogue = try XCTUnwrap(fixture.extensionDocuments().catalogue)
        let widest = "ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff"
        let lines = [
            ProxyProtocolV1.line(sourceHost: "192.0.2.20", sourcePort: 51234, destinationHost: "203.0.113.7", destinationPort: 443),
            ProxyProtocolV1.line(sourceHost: nil, sourcePort: nil, destinationHost: "203.0.113.7", destinationPort: 443),
            ProxyProtocolV1.line(sourceHost: "fe80::1", sourcePort: 50000, destinationHost: "2001:db8::7", destinationPort: 443),
            ProxyProtocolV1.line(sourceHost: "10.0.0.1", sourcePort: 1, destinationHost: "[2001:db8::7]", destinationPort: 443),
            ProxyProtocolV1.line(sourceHost: "10.0.0.2", sourcePort: 99999, destinationHost: "198.51.100.3", destinationPort: 443),
            ProxyProtocolV1.line(sourceHost: nil, sourcePort: nil, destinationHost: "chatgpt.com", destinationPort: 443),
            ProxyProtocolV1.line(sourceHost: nil, sourcePort: nil, destinationHost: "203.0.113.7", destinationPort: 70000),
            ProxyProtocolV1.line(sourceHost: widest, sourcePort: 65535, destinationHost: widest, destinationPort: 65535),
        ]
        XCTAssertEqual(Array(lines.prefix(7)), [
            "PROXY TCP4 192.0.2.20 203.0.113.7 51234 443\r\n",
            "PROXY TCP4 127.0.0.1 203.0.113.7 0 443\r\n",
            "PROXY TCP6 fe80::1 2001:db8::7 50000 443\r\n",
            "PROXY TCP6 ::1 2001:db8::7 1 443\r\n",
            "PROXY TCP4 10.0.0.2 198.51.100.3 0 443\r\n",
            "PROXY UNKNOWN\r\n",
            "PROXY UNKNOWN\r\n",
        ])
        XCTAssertTrue(lines[7].hasPrefix("PROXY TCP6 "))
        XCTAssertLessThanOrEqual(lines[7].utf8.count, ProxyProtocolV1.maxLength)
        XCTAssertEqual(ProxyProtocolV1.data(sourceHost: nil, sourcePort: nil, destinationHost: "chatgpt.com", destinationPort: 443), Data("PROXY UNKNOWN\r\n".utf8))

        let front = try fixture.front(SteeringRoute(host: "chatgpt.com"), catalogue: catalogue)
        for line in lines {
            let fields = line.trimmingCharacters(in: .whitespacesAndNewlines).split(separator: " ")
            let port = fields.count == 6 ? Int(fields[5]) ?? 443 : 443
            let authority = port == 443 ? "chatgpt.com" : "chatgpt.com:\(port)"
            front.preambleOverride = Data(line.utf8)
            let exchange = try fixture.send(front, serverName: "chatgpt.com", request(host: authority, path: "/preamble-check"))
            XCTAssertEqual(exchange.status, 200, line)
            XCTAssertEqual(exchange.peerSubject, "chatgpt.com", line)
        }
    }
}
