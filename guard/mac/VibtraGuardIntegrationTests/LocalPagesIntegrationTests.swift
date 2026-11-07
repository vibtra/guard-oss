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
        XCTAssertNotNil(status.pid)
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
        XCTAssertEqual(status.caTrusted, true, "the agent reports what the security stub answers for its certificate")
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
        XCTAssertEqual(status.caFingerprint?.count, 64, "the app reads the certificate fingerprint the agent reports")
    }

    func testTheAppReadsTheCertificateStateTheAgentReports() {
        func state(_ json: [String: Any]) -> CAState { AgentStatus(json: json).caState }
        XCTAssertEqual(state([:]), .unknown, "an older agent without the facts")
        XCTAssertEqual(state(["ca": ["fingerprintSha256": "ab12"], "interception": ["on": true]]), .unknown)
        XCTAssertEqual(state(["ca": ["state": "ready"], "interception": ["on": true]]), .ready)
        XCTAssertEqual(state(["ca": ["state": "awaiting-trust", "staleCAs": 2, "holdUntil": "2026-11-06T10:00:30Z"],
                              "interception": ["on": false, "reason": "awaiting-trust"]]),
                       .awaitingTrust(staleCAs: 2, holdUntil: Date(timeIntervalSince1970: 1_793_959_230)))
        XCTAssertEqual(state(["ca": ["state": "awaiting-trust", "holdUntil": "2026-11-06T10:00:30.5Z"]]),
                       .awaitingTrust(staleCAs: 0, holdUntil: Date(timeIntervalSince1970: 1_793_959_230.5)))
        XCTAssertEqual(state(["ca": ["state": "awaiting-trust"]]), .awaitingTrust(staleCAs: 0, holdUntil: nil), "outside a hold window")
        XCTAssertEqual(state(["ca": ["state": "off"], "interception": ["on": false, "reason": "no-secure-enclave"]]), .off(.noSecureEnclave))
        XCTAssertEqual(state(["ca": ["state": "off"], "interception": ["on": false, "reason": "key-unavailable"]]), .off(.keyUnavailable))
        XCTAssertEqual(state(["ca": ["state": "ready"], "interception": ["on": false, "reason": "signer-unavailable"]]), .off(.signerUnavailable),
                       "never ready while interception is off")
        XCTAssertEqual(state(["interception": ["on": false, "reason": "unsigned-build"]]), .off(.unsignedBuild), "an agent without ca.state")
        XCTAssertEqual(state(["interception": ["on": false, "reason": "something-new"]]), .off(nil))
        XCTAssertEqual(state(["interception": ["on": false, "reason": "awaiting-trust"]]), .awaitingTrust(staleCAs: 0, holdUntil: nil),
                       "an agent without ca.state")
        XCTAssertEqual(state(["ca": ["state": "off"]]), .off(nil))
        XCTAssertEqual(state(["ca": ["state": "awaiting-trust"], "interception": ["on": false, "reason": "signer-unavailable"]]),
                       .off(.signerUnavailable), "trusting cannot help while the signer is unreachable")
        XCTAssertEqual(state(["ca": ["state": "awaiting-trust"], "interception": ["on": false, "reason": "no-secure-enclave"]]),
                       .off(.noSecureEnclave))
        XCTAssertEqual(AgentStatus(json: ["ca": ["fingerprintSha256": "ab12"]]).caFingerprint, "ab12")
    }

    func testTheAppPromptsOnceForEachNewCertificate() {
        func prompt(_ ca: [String: Any], _ interception: [String: Any] = [:], after prompted: String?) -> String? {
            AgentStatus(json: ["ca": ca, "interception": interception]).certificateToPrompt(alreadyPrompted: prompted)
        }
        let awaiting: [String: Any] = ["state": "awaiting-trust", "fingerprintSha256": "bb22"]
        XCTAssertEqual(prompt(awaiting, after: nil), "bb22", "a first certificate")
        XCTAssertEqual(prompt(awaiting, after: "aa11"), "bb22", "a certificate that replaced one already prompted")
        XCTAssertNil(prompt(awaiting, after: "bb22"), "a certificate already prompted")
        XCTAssertNil(prompt(["state": "ready", "fingerprintSha256": "bb22"], after: nil))
        XCTAssertNil(prompt(["state": "off", "fingerprintSha256": "bb22"], after: nil))
        XCTAssertNil(prompt(awaiting, ["on": false, "reason": "signer-unavailable"], after: nil))
        XCTAssertNil(prompt(["state": "awaiting-trust"], after: nil), "no fingerprint to remember")
    }

    func testTheMacNoticeMatchesTheCertificateState() {
        let unchecked = "Requests to AI services go through without Guard checking them. Your admin can see this."

        XCTAssertNil(CANotice(.ready))
        XCTAssertNil(CANotice(.unknown))

        for holdUntil in [Date(timeIntervalSince1970: 1_793_959_230), nil] as [Date?] {
            let untrusted = CANotice(.awaitingTrust(staleCAs: 1, holdUntil: holdUntil))
            XCTAssertEqual(untrusted?.tone, .amber, "\(String(describing: holdUntil))")
            XCTAssertEqual(untrusted?.heading, "Trust Guard's new certificate")
            XCTAssertEqual(untrusted?.body, "Until you trust it, AI requests go through without Guard checking them.")
            XCTAssertEqual(untrusted?.offersTrust, true)
        }

        let reasons: [(InterceptionOffReason?, String?)] = [
            (.noSecureEnclave, "It has no Secure Enclave, so Guard cannot check AI traffic."),
            (.keyUnavailable, "Guard could not make its key. Reinstall Guard or ask your admin."),
            (.unsignedBuild, "This is an unsigned build of Guard, so it does not check AI traffic."),
            (.unsupportedPlatform, nil),
            (nil, nil),
        ]
        for (reason, why) in reasons {
            let off = CANotice(.off(reason))
            XCTAssertEqual(off?.tone, .red, "\(String(describing: reason))")
            XCTAssertEqual(off?.heading, "This Mac is not protected")
            XCTAssertEqual(off?.body, why.map { "\($0) \(unchecked)" } ?? unchecked)
            XCTAssertEqual(off?.offersTrust, false, "trusting cannot protect this Mac")
        }

        let restarting = CANotice(.off(.signerUnavailable))
        XCTAssertEqual(restarting?.tone, .amber)
        XCTAssertEqual(restarting?.heading, "Guard is restarting. Until it is back, AI requests may go through without Guard checking them.")
        XCTAssertNil(restarting?.body)
        XCTAssertEqual(restarting?.offersTrust, false)
    }

    func testTheTrustAlertNamesAMigrationOnlyWhileTheFileKeyIsThere() throws {
        let dataDir = try IntegrationPaths.temporaryDirectory("trust-alert")
        addTeardownBlock { try? FileManager.default.removeItem(at: dataDir) }
        let firstRun = CATrustAlert(.awaitingTrust(staleCAs: 0, holdUntil: nil), dataDir: dataDir)
        XCTAssertEqual(firstRun?.title, "Trust Guard's new certificate")
        XCTAssertEqual(firstRun?.message, "Guard made a new certificate for this Mac. Its key is kept in this Mac's Secure Enclave and cannot be copied.\n\n" +
                       "Until you trust it, AI requests go through without Guard checking them. macOS asks for your login password.")
        let twice = "macOS asks for your login password twice: once to trust the new certificate, once to remove the old one."
        let keyLost = CATrustAlert(.awaitingTrust(staleCAs: 1, holdUntil: nil), dataDir: dataDir)
        XCTAssertEqual(keyLost?.title, "Trust Guard's new certificate", "a lost key with its old certificate still on disk")
        XCTAssertEqual(keyLost?.message, "Guard made a new certificate for this Mac. Its key is kept in this Mac's Secure Enclave and cannot be copied.\n\n" +
                       "Until you trust it, AI requests go through without Guard checking them. " + twice)

        try Data("not a key".utf8).write(to: dataDir.appendingPathComponent("ca.key"))
        let migration = CATrustAlert(.awaitingTrust(staleCAs: 1, holdUntil: nil), dataDir: dataDir)
        XCTAssertEqual(migration?.title, "Finish moving Guard's key into the Secure Enclave")
        XCTAssertEqual(migration?.message, "Guard now keeps its certificate key in this Mac's Secure Enclave, where it cannot be copied. " +
                       "Trust the new certificate to finish. Until you do, AI requests go through without Guard checking them.\n\n" + twice)
        XCTAssertEqual(CATrustAlert(.awaitingTrust(staleCAs: 0, holdUntil: nil), dataDir: dataDir)?.title, "Trust Guard's new certificate",
                       "a file key with no earlier certificate is not a migration")
        XCTAssertNil(CATrustAlert(.ready, dataDir: dataDir))
        XCTAssertNil(CATrustAlert(.off(.noSecureEnclave), dataDir: dataDir))
    }

    func testTheDesktopNeverSaysThisMacIsProtectedWhenItIsNot() {
        func status(_ ca: [String: Any], _ interception: [String: Any], trusted: Bool = false) -> AgentStatus {
            AgentStatus(json: ["enrolled": true, "bundleVersion": 3, "proxyListening": true, "clientMode": "enforce", "caTrusted": trusted,
                               "ca": ca, "interception": interception])
        }
        let unchecked = "Requests to AI services go through without Guard checking them. Your admin can see this."
        let noChip = DesktopOverview(status: status(["state": "off"], ["on": false, "reason": "no-secure-enclave"]), protectionOn: true)
        XCTAssertEqual(noChip.title, "This Mac is not protected")
        XCTAssertEqual(noChip.detail, "It has no Secure Enclave, so Guard cannot check AI traffic. " + unchecked)
        XCTAssertEqual(noChip.mark, .notProtected)

        for reason in ["no-secure-enclave", "key-unavailable", "unsigned-build", "unsupported-platform", "something-new"] {
            let off = status(["state": "off"], ["on": false, "reason": reason], trusted: true)
            let overview = DesktopOverview(status: off, protectionOn: true)
            XCTAssertEqual(overview.title, "This Mac is not protected", reason)
            XCTAssertEqual(overview.detail, CANotice(off.caState)?.body, reason)
            XCTAssertEqual(overview.mark, .notProtected, reason)
            XCTAssertFalse(overview.title.contains("protection is on"), reason)
            XCTAssertFalse(overview.detail.contains("applies your organisation"), reason)

            let trust = CertificateTrust(status: off)
            XCTAssertEqual(trust.fact, "This Mac is not protected", reason)
            XCTAssertEqual(trust.label, "This Mac is not protected", reason)
            XCTAssertFalse(trust.showsTrusted, "a trusted certificate does not protect this Mac: \(reason)")
            XCTAssertFalse(trust.canTrust, "trusting cannot protect this Mac: \(reason)")
        }

        let ready = status(["state": "ready"], ["on": true], trusted: true)
        XCTAssertEqual(DesktopOverview(status: ready, protectionOn: true),
                       DesktopOverview(status: status(["state": "ready"], ["on": false, "reason": "signer-unavailable"], trusted: true), protectionOn: true),
                       "a restarting signer is not reported as an unprotected Mac")
        XCTAssertEqual(DesktopOverview(status: ready, protectionOn: true).title, "Network protection is on")
        XCTAssertEqual(DesktopOverview(status: ready, protectionOn: true).mark, .protectionOn)
        XCTAssertEqual(DesktopOverview(status: ready, protectionOn: false).mark, .protectionOff)
        XCTAssertEqual(DesktopOverview(status: ready, protectionOn: true).detail,
                       "Guard applies your organisation’s service and content rules to traffic routed through this agent.")
        XCTAssertEqual(DesktopOverview(status: nil, protectionOn: false).title, "Waiting for the agent")

        let awaiting = CertificateTrust(status: status(["state": "awaiting-trust"], ["on": false, "reason": "awaiting-trust"]))
        XCTAssertEqual(awaiting, CertificateTrust(status: status(["state": "ready"], ["on": true])), "awaiting trust keeps step 2 as it is")
        XCTAssertEqual(awaiting.fact, "Not trusted — finish Setup")
        XCTAssertEqual(awaiting.label, "Certificate trust not verified")
        XCTAssertTrue(awaiting.canTrust)
        let trusted = CertificateTrust(status: ready)
        XCTAssertEqual(trusted.fact, "Trusted on this Mac")
        XCTAssertEqual(trusted.label, "Certificate trusted")
        XCTAssertTrue(trusted.showsTrusted)
        XCTAssertEqual(CertificateTrust(status: nil).fact, "Not verified")
        XCTAssertTrue(CertificateTrust(status: nil).canTrust)
    }

    func testNoDesktopProtectionLineClaimsProtectionWhileGuardIsNotChecking() {
        func status(_ interception: [String: Any], state: String = "off", enrolled: Bool = true, revoked: Bool = false) -> AgentStatus {
            AgentStatus(json: ["enrolled": enrolled, "revoked": revoked, "bundleVersion": 3, "proxyListening": true, "clientMode": "enforce",
                               "caTrusted": true, "ca": ["state": state], "interception": interception])
        }
        let networks: [ExtensionStatus] = [.on, .starting, .partlyOn("content filter on, transparent proxy off"), .off, .notInstalled,
                                           .updateAvailable(installed: "25", bundled: "26", protection: .on, error: "replacement refused")]
        let claims = ["go through Guard", "covers supported apps", "Content checks cover", "are decrypted", "evaluated in memory", "network protection",
                      "applies your organisation", "protection is on", "Monitoring AI use"]
        let offReasons = ["no-secure-enclave", "key-unavailable", "unsigned-build", "unsupported-platform", "something-new"]
        let unchecked = offReasons.map { status(["on": false, "reason": $0]) }
            + [status(["on": false, "reason": "awaiting-trust"], state: "awaiting-trust")]

        for off in unchecked {
            let awaiting = !off.caState.leavesMacUnprotected
            let overview = DesktopOverview(status: off, protectionOn: true)
            XCTAssertEqual(overview.title, CANotice(off.caState)?.heading, "\(off.caState)")
            XCTAssertEqual(overview.detail, CANotice(off.caState)?.body, "\(off.caState)")
            XCTAssertEqual(overview.mark, awaiting ? .awaitingTrust : .notProtected, "\(off.caState)")
            XCTAssertEqual(CertificateTrust(status: off).canTrust, awaiting, "only trusting the new certificate fixes the state: \(off.caState)")
            for network in networks {
                let lines = DesktopProtection(status: off, network: network)
                var shown = [overview.title, overview.detail, lines.networkFact, lines.networkIntro, lines.contentNote, lines.decryptionNote,
                             lines.title(network.action), lines.title(.turnOn), lines.title(.turnOff)]
                if !awaiting { shown.append(lines.certificateIntro) }
                for line in shown {
                    for claim in claims { XCTAssertFalse(line.contains(claim), "\(off.caState), \(network): \(line)") }
                }
                XCTAssertTrue(lines.networkFact.hasSuffix(awaiting ? " · Not checking AI requests until you trust the certificate" : " · This Mac is not protected"),
                              "\(off.caState), \(network)")
                XCTAssertTrue(lines.contentNote.hasSuffix("Guard decrypts no AI traffic and does not check request contents."), "\(off.caState)")
                XCTAssertEqual(lines.decryptionNote, lines.contentNote)
                XCTAssertEqual(lines.certificateIntro, awaiting ? DesktopProtection(status: nil, network: network).certificateIntro : CANotice(off.caState)?.body)
            }
            XCTAssertTrue(DesktopProtection(status: off, network: .on).networkFact.hasPrefix("On · "), "the extension's own state stays visible")
            XCTAssertTrue(DesktopProtection(status: off, network: .off).networkFact.hasPrefix("Off · "))
            XCTAssertTrue(DesktopProtection(status: off, network: networks[5]).networkFact.hasPrefix("On · Extension update available (25 → 26) · replacement refused · "))
            XCTAssertEqual(DesktopProtection(status: off, network: .on).title(.turnOff), "Turn off network extension")
        }
        let noChip = DesktopProtection(status: unchecked[0], network: .on)
        XCTAssertEqual(noChip.networkFact, "On · This Mac is not protected")
        XCTAssertEqual(noChip.contentNote, "While this Mac is not protected, Guard decrypts no AI traffic and does not check request contents.")
        let untrusted = DesktopOverview(status: unchecked[5], protectionOn: true)
        XCTAssertEqual(untrusted.title, "Trust Guard's new certificate")
        XCTAssertEqual(untrusted.detail, "Until you trust it, AI requests go through without Guard checking them.")
        XCTAssertEqual(DesktopProtection(status: unchecked[5], network: .on).contentNote,
                       "Until you trust the new certificate, Guard decrypts no AI traffic and does not check request contents.")

        for unseen in [status(["on": false, "reason": "no-secure-enclave"], enrolled: false), status(["on": false, "reason": "no-secure-enclave"], revoked: true)] {
            let overview = DesktopOverview(status: unseen, protectionOn: false)
            XCTAssertEqual(overview.title, "This Mac is not protected", "not protected comes first, enrolled or not")
            XCTAssertEqual(overview.detail, "It has no Secure Enclave, so Guard cannot check AI traffic. Requests to AI services go through without Guard checking them.")
            XCTAssertEqual(DesktopProtection(status: unseen, network: .off).certificateIntro, overview.detail)
            XCTAssertFalse(overview.detail.contains("admin"), "no admin sees a Mac that is not enrolled or was revoked")
        }
        XCTAssertFalse(DesktopOverview(status: status(["on": false, "reason": "something-new"], enrolled: false), protectionOn: false).detail.contains("admin"))
        XCTAssertTrue(DesktopOverview(status: unchecked[0], protectionOn: true).detail.hasSuffix("Your admin can see this."))

        let ready = status(["on": true], state: "ready")
        let restarting = status(["on": false, "reason": "signer-unavailable"], state: "ready")
        XCTAssertEqual(DesktopOverview(status: restarting, protectionOn: true), DesktopOverview(status: ready, protectionOn: true))
        for network in networks {
            XCTAssertEqual(DesktopProtection(status: restarting, network: network), DesktopProtection(status: ready, network: network),
                           "a restarting signer is not reported as an unprotected Mac")
            XCTAssertEqual(DesktopProtection(status: nil, network: network), DesktopProtection(status: ready, network: network))
            XCTAssertEqual(DesktopProtection(status: ready, network: network).networkFact, network.text)
        }
        let on = DesktopProtection(status: ready, network: .on)
        XCTAssertEqual(on.networkFact, "On: AI sites go through Guard")
        XCTAssertEqual(on.title(.turnOn), "Turn on network protection")
        XCTAssertEqual(on.title(.install), "Install network extension…")
        XCTAssertEqual(on.decryptionNote, "Only catalogued AI domains are decrypted. Prompt contents are evaluated in memory and are never added to this app’s activity history.")
        XCTAssertTrue(on.contentNote.hasPrefix("Content checks cover supported text"))
        XCTAssertTrue(on.certificateIntro.hasPrefix("Guard creates a certificate unique to this Mac"))
        XCTAssertTrue(on.networkIntro.hasPrefix("Network protection covers supported apps"))
        XCTAssertEqual(DesktopOverview(status: ready, protectionOn: true).mark, .protectionOn)
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
