// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Vibtra
import Foundation
import XCTest

final class BlockNoticeIntegrationTests: GuardIntegrationCase {
    private let keywordBody = Data(#"{"messages":[{"role":"user","content":"please summarise the bluebird-example notes"}]}"#.utf8)

    private func fetchHeaders(_ extra: [(String, String)] = []) -> [(String, String)] {
        [("Content-Type", "application/json"), ("Accept", "application/json"), ("Sec-Fetch-Mode", "cors"), ("Sec-Fetch-Dest", "empty")] + extra
    }

    private func eventId(_ exchange: TLSExchange) -> String? {
        if let id = exchange.json()?["eventId"] as? String { return id }
        guard let header = exchange.header("x-vibtra-guard"), let range = header.range(of: "event=") else { return nil }
        return String(header[range.upperBound...])
    }

    func testABlockTheTabCannotShowBecomesOneNoticeThatOpensTheAgentsPage() throws {
        let fixture = try makeFixture()
        let catalogue = try XCTUnwrap(fixture.extensionDocuments().catalogue)
        let stream = try fixture.events()
        let front = try fixture.front(SteeringRoute(host: "chatgpt.com"), catalogue: catalogue)
        let fetch = request("POST", host: "chatgpt.com", path: "/backend-api/conversation", headers: fetchHeaders(), body: keywordBody)

        let refused = try fixture.send(front, serverName: "chatgpt.com", fetch)
        XCTAssertEqual(refused.status, 403)
        let json = try XCTUnwrap(refused.json())
        XCTAssertEqual(json["code"] as? String, "GUARD_BLOCKED")
        XCTAssertEqual(json["action"] as? String, "block")
        let id = try XCTUnwrap(json["eventId"] as? String)
        let blockPage = try XCTUnwrap((json["blockPage"] as? String).flatMap { URL(string: $0) })
        XCTAssertFalse(fixture.upstream.requests.contains { $0.path == "/backend-api/conversation" }, "the refused request never left the laptop")

        let decision = try XCTUnwrap(stream.waitForDecision { $0.eventId == id }, "the agent streamed the decision")
        XCTAssertEqual(decision.action, "blocked")
        XCTAssertEqual(decision.delivery, "notice", "a fetch cannot show the block page")
        XCTAssertEqual(decision.enforced, true)
        XCTAssertTrue(decision.shouldPopUp)
        XCTAssertTrue(decision.needsNotice)
        XCTAssertEqual(decision.serviceId, "openai-chatgpt")
        XCTAssertEqual(decision.serviceName, "ChatGPT")
        XCTAssertEqual(decision.ruleId, GuardPolicy.chatgptContentRuleId)
        XCTAssertEqual(decision.ruleName, GuardPolicy.chatgptContentRuleName)
        XCTAssertEqual(decision.matchType, "keyword")
        XCTAssertEqual(decision.workspaceEnabled, true)
        XCTAssertEqual(decision.workspaceUrl, GuardPolicy.workspaceURL)
        XCTAssertEqual(decision.requestsEnabled, true)
        XCTAssertLessThanOrEqual(decision.example?.count ?? 0, GuardConstants.snippetMax)
        XCTAssertNotNil(decision.occurredDate)

        var gate = BlockNoticeGate()
        XCTAssertTrue(gate.admit(decision))
        let notice = BlockNotice(decision)
        XCTAssertEqual(notice.title, "Request blocked")
        XCTAssertEqual(notice.eventId, id)
        XCTAssertTrue(notice.body.contains("ChatGPT"), notice.body)
        XCTAssertTrue(notice.body.contains(GuardPolicy.chatgptContentRuleName), notice.body)
        for secret in ["chatgpt.com", GuardPolicy.chatgptKeyword, "backend-api", "conversation", "summarise"] {
            XCTAssertFalse((notice.title + notice.body + notice.identifier).contains(secret), "the notice never carries \(secret)")
        }
        XCTAssertEqual(AgentClient.blockPage(eventId: id).path, blockPage.path, "clicking the notice opens the agent's own block page")
        let page = try fixture.agent.get(blockPage.path, headers: ["Accept": "text/html"])
        XCTAssertEqual(page.status, 200)
        XCTAssertTrue(page.text.contains("Request blocked"))
        XCTAssertTrue(page.text.contains("What to do next"))

        let retry = try fixture.send(front, serverName: "chatgpt.com", fetch)
        XCTAssertEqual(retry.status, 403)
        let retryId = try XCTUnwrap(eventId(retry))
        let retryRow = try XCTUnwrap(fixture.activityRow(retryId))
        XCTAssertEqual(retryRow["coalesced"] as? Bool, true, "the agent keeps a quick retry in the same burst")
        Thread.sleep(forTimeInterval: 1.5)
        XCTAssertNil(stream.decisions().first { $0.eventId == retryId }, "and streams no second decision for it")
        let retryDecision = try XCTUnwrap(DecisionEvent(json: retryRow))
        XCTAssertEqual(BlockNoticeGate.key(retryDecision), BlockNoticeGate.key(decision))
        XCTAssertFalse(gate.admit(retryDecision), "the app's gate agrees: one notice per retry burst")
        XCTAssertEqual(BlockNotice(retryDecision).identifier, notice.identifier, "a later notice replaces the earlier one instead of stacking")
        XCTAssertTrue(gate.admit(retryDecision, now: Date().addingTimeInterval(BlockNoticeGate.quietGap + 1)), "after the quiet gap it is a new action")
    }

    func testANavigationShowsThePageInTheTabAndAnAskNamesTheApproval() throws {
        let fixture = try makeFixture()
        let catalogue = try XCTUnwrap(fixture.extensionDocuments().catalogue)
        let stream = try fixture.events()

        let deepseek = try fixture.front(SteeringRoute(host: "chat.deepseek.com"), catalogue: catalogue)
        let navigation = request(host: "chat.deepseek.com", path: "/", headers: [
            ("Accept", "text/html,application/xhtml+xml"), ("Sec-Fetch-Mode", "navigate"), ("Sec-Fetch-Dest", "document"),
        ])
        let page = try fixture.send(deepseek, serverName: "chat.deepseek.com", navigation)
        XCTAssertEqual(page.status, 403)
        XCTAssertTrue(page.header("content-type")?.hasPrefix("text/html") == true)
        XCTAssertTrue(page.text.contains("What to do next"), "the tab itself shows the explanation")
        XCTAssertTrue(page.text.contains(GuardPolicy.deepseekNote))
        let pageId = try XCTUnwrap(eventId(page))
        let shown = try XCTUnwrap(stream.waitForDecision { $0.eventId == pageId })
        XCTAssertEqual(shown.delivery, "page")
        XCTAssertTrue(shown.shouldPopUp)
        XCTAssertFalse(shown.needsNotice, "a navigation already shows the block page")
        var gate = BlockNoticeGate()
        XCTAssertFalse(gate.admit(shown), "a page delivery never posts and never starts a burst")

        let claude = try fixture.front(SteeringRoute(host: "claude.ai"), catalogue: catalogue)
        let held = try fixture.send(claude, serverName: "claude.ai", request("POST", host: "claude.ai", path: "/api/append_message", headers: fetchHeaders(), body: Data("{}".utf8)))
        XCTAssertEqual(held.status, 403)
        XCTAssertEqual(held.json()?["action"] as? String, "ask")
        let askId = try XCTUnwrap(eventId(held))
        let ask = try XCTUnwrap(stream.waitForDecision { $0.eventId == askId })
        XCTAssertEqual(ask.action, "asked")
        XCTAssertTrue(ask.needsNotice)
        XCTAssertTrue(gate.admit(ask))
        let notice = BlockNotice(ask)
        XCTAssertEqual(notice.title, "Approval needed")
        XCTAssertTrue(notice.body.contains("Claude"), notice.body)
        XCTAssertFalse(notice.body.contains("claude.ai"))
    }

    func testMonitorModeRecordsTheWouldBlockQuietly() throws {
        var policy = GuardPolicy()
        policy.clientMode = "monitor"
        let fixture = try makeFixture(policy)
        let documents = try fixture.extensionDocuments()
        let catalogue = try XCTUnwrap(documents.catalogue)
        XCTAssertEqual(FlowVerdict.decide(host: "chat.deepseek.com", signingId: "com.google.Chrome", bundle: documents.bundle, catalogue: catalogue), .allow(.monitor),
                       "the filter lets the flow on to the agent")
        let stream = try fixture.events()
        let front = try fixture.front(SteeringRoute(host: "chatgpt.com"), catalogue: catalogue)
        let exchange = try fixture.send(front, serverName: "chatgpt.com",
                                        request("POST", host: "chatgpt.com", path: "/backend-api/conversation", headers: fetchHeaders(), body: keywordBody))
        XCTAssertEqual(exchange.status, 200, "monitor mode never blocks")
        XCTAssertEqual(exchange.text, GuardFixture.upstreamBody)
        XCTAssertTrue(exchange.header("x-vibtra-guard")?.hasPrefix("would-block; event=") == true)
        let id = try XCTUnwrap(eventId(exchange))
        let decision = try XCTUnwrap(stream.waitForDecision { $0.eventId == id })
        XCTAssertEqual(decision.action, "observed")
        XCTAssertEqual(decision.enforced, false)
        XCTAssertFalse(decision.shouldPopUp)
        XCTAssertFalse(decision.needsNotice, "monitor mode stays quiet")
        var gate = BlockNoticeGate()
        XCTAssertFalse(gate.admit(decision))
    }
}
