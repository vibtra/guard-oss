// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Vibtra
import Foundation
import XCTest

final class LocalPagesIntegrationTests: GuardIntegrationCase {
    func testTheAppReadsTheAgentsStatusAsTheAgentWritesIt() throws {
        let fixture = try makeFixture()
        let authority = fixture.registry.authority
        let statusBody = try fixture.agent.get("/status", headers: ["Accept": "application/json"]).body
        let status = try XCTUnwrap(AgentStatus.parse(statusBody))
        XCTAssertTrue(status.enrolled)
        XCTAssertFalse(status.revoked)
        XCTAssertEqual(status.personEmail, authority.personEmail)
        XCTAssertEqual(status.personName, authority.personName)
        XCTAssertEqual(status.orgName, authority.orgName)
        XCTAssertEqual(status.orgHandle, authority.orgHandle)
        XCTAssertEqual(status.deviceId, authority.deviceId)
        XCTAssertNotNil(status.hostname)
        XCTAssertEqual(status.clientMode, "enforce")
        XCTAssertEqual(status.bundleVersion, 1)
        XCTAssertTrue(status.proxyListening)
        var stopped = try XCTUnwrap(JSONSerialization.jsonObject(with: statusBody) as? [String: Any])
        XCTAssertEqual(stopped["proxyListening"] as? Bool, true)
        stopped["proxyListening"] = false
        XCTAssertFalse(AgentStatus(json: stopped).proxyListening, "the agent's status with its proxy stopped reads as stopped")
        XCTAssertTrue(AgentStatus(json: stopped).enrolled)
        stopped.removeValue(forKey: "proxyListening")
        XCTAssertFalse(AgentStatus(json: stopped).proxyListening, "a status without the listener fact never claims a listening proxy")
        XCTAssertEqual(status.server, fixture.registry.baseURL)
        XCTAssertEqual(status.relayAttributionProtocol, 1)
        XCTAssertEqual(status.upstreamTransport, "utls")
        XCTAssertEqual(status.utlsAvailable, true)
        XCTAssertNotNil(status.lastSyncAt)
        XCTAssertNil(status.lastSyncError)
        XCTAssertTrue(status.requestsEnabled)
        XCTAssertTrue(status.workspaceEnabled)
        XCTAssertEqual(status.workspaceUrl, GuardPolicy.workspaceURL)
        XCTAssertEqual(status.caTrusted, false, "a fresh profile's certificate is not trusted until the person trusts it")
        XCTAssertEqual(status.today, GuardCounts())
        XCTAssertNil(status.lastBlockedEventId)
        XCTAssertEqual(GuardConsoleLink.url(server: status.server, handle: status.orgHandle, page: "rules")?.absoluteString,
                       "\(fixture.registry.baseURL)/\(authority.orgHandle)/guard/rules", "Open web dashboard goes to the enrolled registry")
        XCTAssertEqual(GuardConsoleLink.url(server: status.server, handle: status.orgHandle)?.absoluteString,
                       "\(fixture.registry.baseURL)/\(authority.orgHandle)/guard")
        for (server, handle) in [("file:///tmp/a", authority.orgHandle), ("https://name:password@example.test", authority.orgHandle),
                                 ("https://example.test/?token=secret", authority.orgHandle), (status.server ?? "", "../other")] {
            XCTAssertNil(GuardConsoleLink.url(server: server, handle: handle), "\(server) \(handle)")
        }
        XCTAssertNil(AgentStatus.parse(Data("not json".utf8)))
    }

    func testActivityAndPolicyPagesParseAsTheAgentServesThem() throws {
        let fixture = try makeFixture()
        let catalogue = try XCTUnwrap(fixture.extensionDocuments().catalogue)
        let front = try fixture.front(SteeringRoute(host: "chatgpt.com"), catalogue: catalogue)
        let get = try fixture.send(front, serverName: "chatgpt.com", request(host: "chatgpt.com", path: "/c/example"))
        let json = try fixture.send(front, serverName: "chatgpt.com",
                                    request("POST", host: "chatgpt.com", path: "/backend-api/conversation",
                                            headers: [("Content-Type", "application/json"), ("Accept", "application/json")],
                                            body: Data(#"{"messages":[{"role":"user","content":"an ordinary question"}]}"#.utf8)))
        let binary = try fixture.send(front, serverName: "chatgpt.com",
                                      request("POST", host: "chatgpt.com", path: "/backend-api/files",
                                              headers: [("Content-Type", "application/octet-stream")], body: Data(repeating: 0x5a, count: 64)))
        XCTAssertEqual([get.status, json.status, binary.status], [200, 200, 200])

        XCTAssertNotNil(fixture.agent.waitForActivity { $0.count >= 3 })
        let activityBody = try fixture.agent.get("/activity", headers: ["Accept": "application/json"]).body
        let activity = try XCTUnwrap(LocalActivity.parse(activityBody))
        XCTAssertEqual(activity.events.count, 3)
        let newestFirst = activity.events
        XCTAssertEqual(newestFirst.map { $0.inspection?.label }, ["Binary body not checked", "Request body checked", "Service check"])
        XCTAssertEqual(newestFirst[1].inspection?.requestCategory, "conversation")
        XCTAssertEqual(newestFirst[1].inspection?.categoryLabel, "Conversation request")
        XCTAssertGreaterThan(newestFirst[1].inspection?.textParts ?? 0, 0)
        XCTAssertTrue(newestFirst.allSatisfy { $0.action == "allowed" && !$0.shouldPopUp && $0.occurredDate != nil })
        let dates = newestFirst.compactMap(\.occurredDate)
        XCTAssertEqual(dates.count, 3)
        XCTAssertTrue(zip(dates, dates.dropFirst()).allSatisfy { $0 > $1 }, "millisecond timestamps order the activity strictly, newest first")
        let rows = try XCTUnwrap((JSONSerialization.jsonObject(with: activityBody) as? [String: Any])?["events"] as? [[String: Any]])
        var row = try XCTUnwrap(rows.first)
        let stamp = try XCTUnwrap(row["occurredAt"] as? String)
        let dot = try XCTUnwrap(stamp.firstIndex(of: "."), "the agent writes milliseconds")
        let millis = try XCTUnwrap(Int(stamp[stamp.index(after: dot)...].dropLast()))
        let precise = try XCTUnwrap(DecisionEvent(json: row)?.occurredDate)
        XCTAssertEqual(precise, dates[0])
        row["occurredAt"] = String(stamp[..<dot]) + "Z"
        row.removeValue(forKey: "inspection")
        let older = try XCTUnwrap(DecisionEvent(json: row), "a row without a fraction or inspection facts still parses")
        XCTAssertNil(older.inspection)
        let whole = try XCTUnwrap(older.occurredDate, "a timestamp without a fraction still parses")
        XCTAssertEqual(precise.timeIntervalSince(whole), Double(millis) / 1000, accuracy: 0.0005)

        let status = try XCTUnwrap(AgentStatus.parse(fixture.agent.get("/status").body))
        XCTAssertEqual(status.today.allowed, 3)
        XCTAssertEqual(status.today.blocked, 0)

        let policy = try JSONDecoder().decode(LocalPolicy.self, from: fixture.agent.get("/policy").body)
        XCTAssertTrue(policy.available)
        XCTAssertEqual(policy.mode, "enforce")
        XCTAssertEqual(policy.bundleVersion, 1)
        let rule = try XCTUnwrap(policy.contentRules.first)
        XCTAssertEqual(rule.id, GuardPolicy.chatgptContentRuleId)
        XCTAssertEqual(rule.name, GuardPolicy.chatgptContentRuleName)
        XCTAssertEqual(rule.action, "block")
        XCTAssertEqual(rule.detector, "keyword")
        XCTAssertEqual(rule.serviceNames, ["ChatGPT"])
        let deepseek = try XCTUnwrap(policy.services.first { $0.id == "deepseek" })
        XCTAssertEqual(deepseek.action, "block")
        XCTAssertEqual(deepseek.source, "rule")
        XCTAssertEqual(deepseek.note, GuardPolicy.deepseekNote)
    }

    func testARevokedDeviceSaysSoAndAnUnenrolledAgentIsNotEnrolled() throws {
        let fixture = try makeFixture()
        let stream = try fixture.events()
        fixture.registry.revoke()
        let revokedJSON = try XCTUnwrap(fixture.agent.waitForStatus { $0["revoked"] as? Bool == true }, "the agent learns of the revocation on its next sync")
        let revoked = try XCTUnwrap(AgentStatus.parse(JSONSerialization.data(withJSONObject: revokedJSON)))
        XCTAssertTrue(revoked.revoked)
        XCTAssertFalse(revoked.enrolled)
        let policy = try JSONDecoder().decode(LocalPolicy.self, from: fixture.agent.get("/policy").body)
        XCTAssertFalse(policy.available, "a revoked device enforces nothing")
        XCTAssertTrue(Wait.until(5) { stream.messages.contains { $0.event == "synced" && $0.data.contains("\"revoked\":true") } },
                      "the app hears about it on the event stream")

        let bare = try GuardAgent()
        addTeardownBlock { bare.remove() }
        try bare.start()
        let unenrolled = try XCTUnwrap(AgentStatus.parse(bare.get("/status").body))
        XCTAssertFalse(unenrolled.enrolled)
        XCTAssertFalse(unenrolled.revoked)
        XCTAssertNil(unenrolled.personEmail)
        let empty = try JSONDecoder().decode(LocalPolicy.self, from: bare.get("/policy").body)
        XCTAssertFalse(empty.available)
        XCTAssertTrue(empty.contentRules.isEmpty)
    }

    func testMonitorCountsSplitWhatEnforceWouldHaveDone() throws {
        let counts = try XCTUnwrap(GuardCounts(json: ["observed": 5, "wouldBlocked": 2, "wouldAsked": 1]))
        XCTAssertEqual(counts.wouldAllow, 2)
        XCTAssertEqual(counts.wouldBlocked, 2)
        XCTAssertEqual(counts.wouldAsked, 1)
        XCTAssertEqual(GuardCounts(observed: 1, wouldBlocked: 2).wouldAllow, 0, "a stale total never shows a negative count")
    }
}
