// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Vibtra
import Foundation
import XCTest

final class AppInputsIntegrationTests: GuardIntegrationCase {
    func testAnEnrolLinkOrPastedTokenTheAppAcceptsEnrolsTheRealAgent() throws {
        let registry = try FakeRegistry(policy: GuardPolicy())
        addTeardownBlock { registry.stop() }
        let server = try XCTUnwrap(registry.baseURL.addingPercentEncoding(withAllowedCharacters: .alphanumerics))
        let link = EnrolLink.parse("vibtra-guard://enrol?server=\(server)&token=\(registry.enrolToken)")
        XCTAssertEqual(link, EnrolLink(server: registry.baseURL, token: registry.enrolToken))
        XCTAssertEqual(EnrolLink.parse("  \(registry.enrolToken)\n"), EnrolLink(server: nil, token: registry.enrolToken), "a pasted token keeps the default server")

        let agent = try GuardAgent()
        addTeardownBlock { agent.remove() }
        let enrolled = try agent.enrol(server: try XCTUnwrap(link.server), token: try XCTUnwrap(link.token))
        XCTAssertEqual(enrolled.status, 0, enrolled.output)
        XCTAssertEqual(registry.enrolments.count, 1)
        XCTAssertEqual(registry.enrolments.first?["enrolToken"] as? String, registry.enrolToken)
        try agent.start()
        let status = try XCTUnwrap(AgentStatus.parse(agent.get("/status").body))
        XCTAssertTrue(status.enrolled)
        XCTAssertEqual(status.server, registry.baseURL)

        for refused in ["vibtra-guard://enrol?server=\(server)&token=nope",
                        "https://evil.example/enrol?token=\(registry.enrolToken)",
                        "vibtra-guard://other?token=\(registry.enrolToken)"] {
            XCTAssertNil(EnrolLink.parse(refused).token, refused)
        }
        let stranger = try GuardAgent()
        addTeardownBlock { stranger.remove() }
        XCTAssertNotEqual(try stranger.enrol(server: registry.baseURL, token: "nope").status, 0, "the agent refuses a token the app would not pass on")
        XCTAssertEqual(registry.enrolments.count, 1, "a malformed token never reaches the registry")
    }

    func testTheAppLabelsBodiesTheAgentCouldNotOrOnlyPartlyCheck() throws {
        let fixture = try makeFixture()
        let catalogue = try XCTUnwrap(fixture.extensionDocuments().catalogue)
        let front = try fixture.front(SteeringRoute(host: "chatgpt.com"), catalogue: catalogue)
        let undecodable = try fixture.send(front, serverName: "chatgpt.com",
                                           request("POST", host: "chatgpt.com", path: "/backend-api/conversation",
                                                   headers: [("Content-Type", "application/json"), ("Content-Encoding", "gzip"), ("Accept", "application/json")],
                                                   body: Data("not gzip".utf8)))
        XCTAssertEqual(undecodable.status, 403, "Guard never treats a body it cannot decode as an empty allowed request")
        var partial = Data([0x0a, 0x08])
        partial.append(Data("Medicare".utf8))
        partial.append(contentsOf: [0x1a, 0x03, 0xff, 0xfe, 0xfd])
        let opaque = try fixture.send(front, serverName: "chatgpt.com",
                                      request("POST", host: "chatgpt.com", path: "/backend-api/files",
                                              headers: [("Content-Type", "application/proto")], body: partial))
        XCTAssertEqual(opaque.status, 200)

        XCTAssertNotNil(fixture.agent.waitForActivity { $0.count >= 2 })
        let activity = try XCTUnwrap(LocalActivity.parse(fixture.agent.get("/activity", headers: ["Accept": "application/json"]).body))
        XCTAssertEqual(activity.events.map { $0.inspection?.label }, ["Text fields checked (partial)", "Message could not be checked"])
        XCTAssertEqual(activity.events.last?.inspection?.coverageFailure, true)
        XCTAssertEqual(activity.events.first?.inspection?.state, "partial")
    }
}
