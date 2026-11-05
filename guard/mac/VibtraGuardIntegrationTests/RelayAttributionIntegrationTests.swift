// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Vibtra
import CryptoKit
import Foundation
import Security
import XCTest

final class RelayAttributionIntegrationTests: GuardIntegrationCase {
    private let identity = NativeRelayIdentity(signingId: "com.example.synthetic", teamId: "TEST123456")

    private func newestAttribution(_ fixture: GuardFixture, after count: Int) throws -> [String: Any] {
        let rows = try XCTUnwrap(fixture.agent.waitForActivity { $0.count > count }, "the agent recorded request \(count + 1)")
        let inspection = try XCTUnwrap(rows.first?["inspection"] as? [String: Any])
        return try XCTUnwrap(inspection["processAttribution"] as? [String: Any])
    }

    private func writePin(_ pin: Data, _ fixture: GuardFixture) throws {
        let file = fixture.agent.profileFile(AgentPaths.relayAttributionPin.lastPathComponent)
        try pin.write(to: file, options: .atomic)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: file.path)
    }

    func testTheAgentVerifiesTheExtensionsSignedIdentityOnlyWhileTheLeaseIsOn() throws {
        let fixture = try makeFixture()
        let status = try XCTUnwrap(AgentStatus.parse(fixture.agent.get("/status").body))
        XCTAssertEqual(status.relayAttributionProtocol, 1, "the app turns attribution on only for an agent that can verify it")
        XCTAssertTrue(status.proxyListening)
        XCTAssertNil(AgentStatus(json: [:]).relayAttributionProtocol, "an older agent without the capability keeps it off")

        let signer = NativeRelaySigner()
        var requests = NativeRelayPinRequest()
        let asked = Date()
        let ticket = try XCTUnwrap(requests.begin(now: asked))
        XCTAssertNil(requests.begin(now: asked.addingTimeInterval(1)), "one pin request at a time")
        var replies: [Data?] = []
        signer.receiveMessage(NativeRelaySigner.request, now: asked) { replies.append($0) }
        XCTAssertEqual(replies.count, 1)
        let reply = try XCTUnwrap(replies.first ?? nil)
        XCTAssertEqual(reply, signer.publicPin)
        XCTAssertTrue(requests.accept(ticket, now: asked.addingTimeInterval(1)))
        XCTAssertFalse(signer.isEnabled(), "reading the public pin does not enable attribution")
        let pin = try NativeRelayPublicPin.decode(reply)
        try writePin(reply, fixture)

        var stale = NativeRelayPinRequest()
        let late = try XCTUnwrap(stale.begin(now: asked))
        XCTAssertTrue(stale.hasExpired(now: asked.addingTimeInterval(5)))
        XCTAssertFalse(stale.accept(late, now: asked.addingTimeInterval(5)), "a reply after 5 s never rewrites the pin")
        let beforeReconnect = try XCTUnwrap(stale.begin(now: asked.addingTimeInterval(6)))
        stale.invalidate()
        let afterReconnect = try XCTUnwrap(stale.begin(now: asked.addingTimeInterval(7)))
        XCTAssertFalse(stale.accept(beforeReconnect, now: asked.addingTimeInterval(8)), "nor does a reply from before a reconnect")
        XCTAssertTrue(stale.accept(afterReconnect, now: asked.addingTimeInterval(8)))

        let catalogue = try XCTUnwrap(fixture.extensionDocuments().catalogue)
        let front = try fixture.front(SteeringRoute(host: "chatgpt.com"), catalogue: catalogue)
        front.attribute(with: signer, identity: identity)
        _ = try fixture.send(front, serverName: "chatgpt.com", request(host: "chatgpt.com", path: "/attribution-off"))
        let legacy = try newestAttribution(fixture, after: 0)
        XCTAssertEqual(legacy["status"] as? String, "unattributed")
        XCTAssertEqual(legacy["reason"] as? String, "not-provided", "without the lease the extension sends the legacy preamble")

        signer.receiveMessage(NativeRelaySigner.enableMessage(pin: pin))
        XCTAssertTrue(signer.isEnabled(), "the enable message works without a reply handler")
        _ = try fixture.send(front, serverName: "chatgpt.com", request(host: "chatgpt.com", path: "/attribution-on"))
        let verified = try newestAttribution(fixture, after: 1)
        XCTAssertEqual(verified["status"] as? String, "verified")
        XCTAssertEqual(verified["source"] as? String, "network-extension")
        XCTAssertEqual(verified["signingId"] as? String, identity.signingId)
        XCTAssertEqual(verified["teamId"] as? String, identity.teamId)
        let row = try XCTUnwrap(fixture.agent.activity().first)
        XCTAssertEqual((row["app"] as? [String: Any])?["bundleId"] as? String, identity.signingId)
        let line = try XCTUnwrap(front.preambles.last.map { String(decoding: $0, as: UTF8.self) })
        XCTAssertTrue(line.hasPrefix("PROXY UNKNOWN\r\nVIBTRA_APP_V1 "))
        XCTAssertLessThanOrEqual(line.utf8.count - "PROXY UNKNOWN\r\n".utf8.count, NativeRelaySigner.maximumLineBytes)

        let rotated = NativeRelaySigner()
        rotated.receiveMessage(NativeRelaySigner.enableMessage(pin: try NativeRelayPublicPin.decode(rotated.publicPin)))
        XCTAssertNotEqual(try NativeRelayPublicPin.decode(rotated.publicPin).keyId, pin.keyId)
        front.attribute(with: rotated, identity: identity)
        _ = try fixture.send(front, serverName: "chatgpt.com", request(host: "chatgpt.com", path: "/attribution-rotated"))
        XCTAssertEqual(try newestAttribution(fixture, after: 2)["reason"] as? String, "key-mismatch",
                       "a claim from a key the app did not pin is never trusted")

        front.attribute(with: signer, identity: NativeRelayIdentity(signingId: "com.example", teamId: "ADHOC"))
        _ = try fixture.send(front, serverName: "chatgpt.com", request(host: "chatgpt.com", path: "/attribution-invalid"))
        XCTAssertEqual(try newestAttribution(fixture, after: 3)["reason"] as? String, "not-provided",
                       "an identity the signer refuses produces no claim at all")

        signer.receiveMessage(Data("guard-relay-disable".utf8))
        XCTAssertFalse(signer.isEnabled())
        front.attribute(with: signer, identity: identity)
        _ = try fixture.send(front, serverName: "chatgpt.com", request(host: "chatgpt.com", path: "/attribution-disabled"))
        XCTAssertEqual(try newestAttribution(fixture, after: 4)["reason"] as? String, "not-provided")

        let counts = front.diagnostics.snapshot()
        XCTAssertEqual(counts["emitted"], 2)
        XCTAssertEqual(counts["signingFailed"], 1)
        XCTAssertEqual(counts["leaseDisabled"], 2)
        XCTAssertTrue(Set(counts.keys).isSubset(of: Set(NativeRelayDiagnosticReason.allCases.map(\.rawValue))), "fixed, bounded categories only")
    }

    func testTheExtensionNamesOnlyTeamSignedProcesses() throws {
        let fixture = try makeFixture()
        var guest: SecCode?
        XCTAssertEqual(SecCodeCopyGuestWithAttributes(nil, [kSecGuestAttributePid: NSNumber(value: fixture.agent.pid)] as CFDictionary, SecCSFlags(), &guest), errSecSuccess)
        let agentCode = try XCTUnwrap(guest)
        var staticCode: SecStaticCode?
        XCTAssertEqual(SecCodeCopyStaticCode(agentCode, SecCSFlags(), &staticCode), errSecSuccess)
        var info: CFDictionary?
        _ = SecCodeCopySigningInformation(try XCTUnwrap(staticCode), SecCSFlags(rawValue: kSecCSSigningInformation), &info)
        let identifier = (info as? [String: Any])?[kSecCodeInfoIdentifier as String] as? String
        let verification = NativeRelayIdentity.verification(code: agentCode, expectedSigningId: identifier ?? "vibtra-guard")
        XCTAssertNil(verification.identity, "an ad hoc build has no team, so the extension never claims an identity for it")
        XCTAssertTrue([NativeRelayDiagnosticReason.teamMissing, .signingInformationFailed].contains(verification.reason), "\(verification.reason)")

        var me: SecCode?
        XCTAssertEqual(SecCodeCopySelf(SecCSFlags(), &me), errSecSuccess)
        XCTAssertNil(NativeRelayIdentity.verified(code: try XCTUnwrap(me), expectedSigningId: "com.forged.identity"))
        XCTAssertEqual(NativeRelayIdentity.verification(auditToken: nil, expectedSigningId: "com.example").reason, .auditTokenMissing)
        XCTAssertEqual(NativeRelayIdentity.verification(auditToken: Data(count: 31), expectedSigningId: "com.example").reason, .auditTokenInvalid)
        XCTAssertEqual(NativeRelayIdentity.verification(auditToken: Data(count: 32), expectedSigningId: nil).reason, .sourceSigningIdMissing)
        XCTAssertNil(NativeRelayIdentity.verified(auditToken: Data(repeating: 0, count: 31), expectedSigningId: "com.example"))
        let mismatch = NativeRelayIdentity.metadata(signingId: "com.example.helper", teamId: "TEST123456", expectedSigningId: "com.example")
        XCTAssertEqual(mismatch.reason, .sourceSigningIdMismatch)
        XCTAssertNil(mismatch.identity)
        XCTAssertEqual(NativeRelayIdentity.metadata(signingId: "com.example", teamId: nil, expectedSigningId: "com.example").reason, .teamMissing)
        XCTAssertEqual(NativeRelayIdentity.metadata(signingId: "com.example", teamId: "ADHOC", expectedSigningId: "com.example").reason, .identityInvalid)
        XCTAssertEqual(NativeRelayIdentity.metadata(signingId: "com.example", teamId: "TEST123456", expectedSigningId: "com.example").reason, .metadataOnly,
                       "valid strings alone never claim a verified signature")

        let signer = NativeRelaySigner()
        for id in ["", "com.example\n", "com.example\r\nforged", String(repeating: "x", count: 256)] {
            XCTAssertNil(signer.line(proxyLine: Data("PROXY UNKNOWN\r\n".utf8), identity: NativeRelayIdentity(signingId: id, teamId: "TEST123456")))
        }
        XCTAssertNil(signer.line(proxyLine: Data("PROXY UNKNOWN\r\nextra\r\n".utf8), identity: identity), "the claim binds exactly one PROXY line")
        XCTAssertThrowsError(try NativeRelayPublicPin.decode(Data(repeating: 0, count: 1025)))
        var forged = try XCTUnwrap(JSONSerialization.jsonObject(with: signer.publicPin) as? [String: Any])
        forged["keyId"] = String(repeating: "0", count: 64)
        XCTAssertThrowsError(try NativeRelayPublicPin.decode(JSONSerialization.data(withJSONObject: forged)), "the app never writes a pin whose key id does not match its key")
    }

    func testTheSignedLineCarriesAValidSteeringHostAndDropsAnInvalidOne() throws {
        let signer = NativeRelaySigner()
        let activationPin = try NativeRelayPublicPin.decode(signer.publicPin)
        _ = signer.handleMessage(NativeRelaySigner.enableMessage(pin: activationPin, steering: true))
        let proxy = Data("PROXY TCP4 127.0.0.1 203.0.113.5 1234 443\r\n".utf8)
        let line = try XCTUnwrap(signer.line(proxyLine: proxy, identity: identity, steeringHost: "chatgpt.com"))
        let parts = try XCTUnwrap(String(data: line, encoding: .utf8)).trimmingCharacters(in: .newlines).split(separator: " ")
        let payload = try XCTUnwrap(NativeRelaySigner.unbase64url(String(parts[1])))
        var fields = try XCTUnwrap(JSONSerialization.jsonObject(with: payload) as? [String: Any])
        XCTAssertEqual(fields["steeringHost"] as? String, "chatgpt.com")
        let pin = try NativeRelayPublicPin.decode(signer.publicPin)
        let key = try P256.Signing.PublicKey(x963Representation: XCTUnwrap(NativeRelaySigner.unbase64url(pin.publicKey)))
        let signature = try P256.Signing.ECDSASignature(rawRepresentation: XCTUnwrap(NativeRelaySigner.unbase64url(String(parts[2]))))
        XCTAssertTrue(key.isValidSignature(signature, for: Data("VIBTRA_APP_V1\n".utf8) + proxy + payload))
        fields["steeringHost"] = "attacker.example"
        XCTAssertFalse(key.isValidSignature(signature, for: Data("VIBTRA_APP_V1\n".utf8) + proxy + (try JSONSerialization.data(withJSONObject: fields, options: [.sortedKeys]))))
        func signedFields(_ line: Data?) throws -> [String: Any] {
            let text = try XCTUnwrap(String(data: XCTUnwrap(line), encoding: .utf8))
            let parts = text.trimmingCharacters(in: .newlines).split(separator: " ")
            return try XCTUnwrap(JSONSerialization.jsonObject(with: XCTUnwrap(NativeRelaySigner.unbase64url(String(parts[1])))) as? [String: Any])
        }
        for bad in ["bad/host", "127.0.0.1", "1.2.3.4", "foo.123", "a_b.example", "-x.example", "x..example", "chatgpt.com.", ""] {
            XCTAssertFalse(NativeRelaySigner.isSteeringHost(bad), bad)
            let kept = try signedFields(signer.line(proxyLine: proxy, identity: identity, steeringHost: bad))
            XCTAssertNil(kept["steeringHost"], bad)
            XCTAssertEqual(kept["signingId"] as? String, identity.signingId, bad)
            XCTAssertEqual(kept["teamId"] as? String, identity.teamId, bad)
            XCTAssertNil(signer.line(proxyLine: proxy, identity: nil, steeringHost: bad), bad)
        }
        for good in ["chatgpt.com", "123.example", "a-b.c0", "x"] { XCTAssertTrue(NativeRelaySigner.isSteeringHost(good), good) }
        XCTAssertEqual(try signedFields(signer.line(proxyLine: proxy, identity: identity, steeringHost: "ChatGPT.com"))["steeringHost"] as? String, "chatgpt.com")
        XCTAssertNotNil(signer.line(proxyLine: proxy, identity: nil, steeringHost: "chatgpt.com"))
        XCTAssertNil(signer.line(proxyLine: proxy, identity: nil))
    }

    func testTheSteeringHostNeedsASteeringActivationLease() throws {
        let signer = NativeRelaySigner()
        let pin = try NativeRelayPublicPin.decode(signer.publicPin)
        let now = Date(timeIntervalSince1970: 1000)
        let proxy = Data("PROXY UNKNOWN\r\n".utf8)
        func fields(at date: Date) throws -> [String: Any] {
            let line = try XCTUnwrap(signer.line(proxyLine: proxy, identity: identity, steeringHost: "chatgpt.com", now: date))
            let parts = try XCTUnwrap(String(data: line, encoding: .utf8)).trimmingCharacters(in: .newlines).split(separator: " ")
            return try XCTUnwrap(JSONSerialization.jsonObject(with: XCTUnwrap(NativeRelaySigner.unbase64url(String(parts[1])))) as? [String: Any])
        }
        XCTAssertEqual(signer.handleMessage(NativeRelaySigner.steeringRequest, now: now), NativeRelaySigner.steeringSupported)
        _ = signer.handleMessage(NativeRelaySigner.enableMessage(pin: pin), now: now)
        XCTAssertNil(try fields(at: now)["steeringHost"])
        XCTAssertEqual(try fields(at: now)["signingId"] as? String, identity.signingId)
        XCTAssertNil(signer.line(proxyLine: proxy, identity: nil, steeringHost: "chatgpt.com", now: now))
        _ = signer.handleMessage(NativeRelaySigner.enableMessage(pin: pin, steering: true), now: now)
        XCTAssertEqual(try fields(at: now)["steeringHost"] as? String, "chatgpt.com")
        XCTAssertNil(try fields(at: now.addingTimeInterval(30))["steeringHost"])
        _ = signer.handleMessage(NativeRelaySigner.enableMessage(pin: pin), now: now)
        XCTAssertNil(try fields(at: now)["steeringHost"])
        XCTAssertNil(AgentStatus(json: ["capabilities": ["nativeRelayAttribution": 1]]).relaySteeringProtocol)
        XCTAssertEqual(AgentStatus(json: ["capabilities": ["nativeRelaySteering": 1]]).relaySteeringProtocol, 1)
    }
}
