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
        XCTAssertEqual(status.policyKeyStore, "keychain", "enrolment pinned the signing key in the test stand-in for the keychain")
        XCTAssertNil(status.policyKeyReason)
        XCTAssertNil(status.policyKeyProblem)
        XCTAssertNotNil(AgentStatus(json: ["policyKey": ["store": "keychain", "reason": "policy-key-mismatch"]]).policyKeyProblem)
        XCTAssertNotNil(AgentStatus(json: ["policyKey": ["store": "keychain", "reason": "policy-key-unavailable"]]).policyKeyProblem)
        XCTAssertNotNil(AgentStatus(json: ["policyKey": ["store": "keychain", "reason": "policy-key-fetching"]]).policyKeyProblem)
        XCTAssertNotNil(AgentStatus(json: ["policyKey": ["store": "keychain", "reason": "policy-key-untrusted-source"]]).policyKeyProblem)
        XCTAssertNil(status.registryProblem)
        XCTAssertNotNil(AgentStatus(json: ["registry": ["fixed": true, "reason": "registry-origin-missing"]]).registryProblem)
        XCTAssertNotNil(AgentStatus(json: ["registry": ["fixed": true, "origin": "https://vibtra.app", "reason": "registry-origin-mismatch"]]).registryProblem)
        XCTAssertNotNil(AgentStatus(json: ["policyKey": ["store": "unprotected"]]).policyKeyProblem, "an unprotected store never looks protected")

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

    func testASignedGuardOffersOnlyTheServerBuiltIntoItsAgent() throws {
        let agent = try GuardAgent()
        addTeardownBlock { agent.remove() }
        let answer = try agent.command(["registry"])
        XCTAssertEqual(answer.status, 0, answer.output)
        XCTAssertEqual(BuiltInRegistry.parse(Data(answer.output.utf8)), .unsigned, "the test agent is not team-signed")

        let unsigned = BuiltInRegistry.unsigned
        XCTAssertEqual(unsigned.server(asked: "https://guard.example").server, "https://guard.example", "an unsigned build takes any server")
        XCTAssertNil(unsigned.server(asked: " ").server)

        let signed = try XCTUnwrap(BuiltInRegistry.parse(Data(#"{"fixed":true,"origin":"https://vibtra.app"}"#.utf8)))
        XCTAssertEqual(signed.server(asked: nil).server, "https://vibtra.app", "a pasted token enrols with the built-in server")
        XCTAssertEqual(signed.server(asked: "https://VIBTRA.app/").server, "https://vibtra.app")
        XCTAssertEqual(signed.server(asked: "https://vibtra.app:443").server, "https://vibtra.app", "the default port is the same origin, as in the agent")
        for different in ["http://vibtra.app", "https://vibtra.app:8443", "https://vibtra.app/other", "https://vibtra.app.example"] {
            XCTAssertNil(signed.server(asked: different).server, different)
        }
        let other = signed.server(asked: "https://evil.example")
        XCTAssertNil(other.server, "a link for another server is never offered")
        XCTAssertNotNil(other.problem)

        let missing = try XCTUnwrap(BuiltInRegistry.parse(Data(#"{"fixed":true,"reason":"registry-origin-missing"}"#.utf8)))
        XCTAssertNil(missing.server(asked: "https://vibtra.app").server, "a signed build without a server enrols nowhere")
        XCTAssertNotNil(missing.server(asked: nil).problem)
    }

    func testNoEnrolLinkOpensTheSelfServeEnrolPageOnTheServerGuardEnrolsWith() throws {
        let unsigned = BuiltInRegistry.unsigned
        let page = { (typed: String) in unsigned.enrolPage(typed: typed)?.absoluteString }
        XCTAssertEqual(page(" https://guard.example\n"), "https://guard.example/guard/enrol")
        XCTAssertEqual(page("https://guard.example/"), "https://guard.example/guard/enrol", "no double slash")
        XCTAssertEqual(page("http://localhost:8080"), "http://localhost:8080/guard/enrol")
        XCTAssertEqual(page("http://[::1]:8080"), "http://[::1]:8080/guard/enrol")
        XCTAssertEqual(page("https://user:secret@guard.example/admin/x?token=genr_1#top"), "https://guard.example/guard/enrol",
                       "the page keeps only the server's origin")
        for unusable in ["", " ", "guard.example", "ftp://guard.example", "vibtra-guard://enrol?server=https://guard.example", "https://"] {
            XCTAssertNil(page(unusable), "an unusable server leaves the action off: \(unusable)")
        }

        let signed = try XCTUnwrap(BuiltInRegistry.parse(Data(#"{"fixed":true,"origin":"https://vibtra.app"}"#.utf8)))
        XCTAssertEqual(signed.enrolPage(typed: "")?.absoluteString, "https://vibtra.app/guard/enrol", "a locked build needs no server typed")
        XCTAssertEqual(signed.enrolPage(typed: "https://evil.example")?.absoluteString, "https://vibtra.app/guard/enrol",
                       "a locked build only ever opens its own server")

        let missing = try XCTUnwrap(BuiltInRegistry.parse(Data(#"{"fixed":true,"reason":"registry-origin-missing"}"#.utf8)))
        XCTAssertNil(missing.enrolPage(typed: "https://vibtra.app"), "a locked build without a server opens nothing")
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
