// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Vibtra
import CryptoKit
import Foundation
import OSLog
import Security
import XCTest

final class CASignerIntegrationTests: XCTestCase {
    private var fixtures: [CASignerFixture] = []

    override func setUp() {
        super.setUp()
        signal(SIGPIPE, SIG_IGN)
    }

    override func tearDown() {
        fixtures.forEach { $0.tearDown() }
        fixtures = []
        super.tearDown()
    }

    private static let helperRequirement = Result { try CASignerFixture.helperRequirement() }

    private func makeFixture() throws -> CASignerFixture {
        try makeFixture(requirement: Self.helperRequirement.get())
    }

    private func makeFixture(requirement: String?) throws -> CASignerFixture {
        let fixture = try CASignerFixture(requirement: requirement)
        fixtures.append(fixture)
        return fixture
    }

    private struct CreatedKey {
        let id: String
        let spki: Data
    }

    private func created(_ reply: String?) throws -> CreatedKey {
        let parts = reply?.split(separator: " ") ?? []
        guard parts.count == 3, parts[0] == "ok", let spki = Data(base64Encoded: String(parts[2])) else {
            throw IntegrationError("create replied \(reply ?? "nothing")")
        }
        return CreatedKey(id: String(parts[1]), spki: spki)
    }

    private func signature(_ reply: String?) throws -> P256.Signing.ECDSASignature {
        guard let reply, reply.hasPrefix("ok "), let der = Data(base64Encoded: String(reply.dropFirst(3))) else {
            throw IntegrationError("expected a signature, got \(reply ?? "nothing")")
        }
        return try P256.Signing.ECDSASignature(derRepresentation: der)
    }

    private func caRequest(_ key: CreatedKey, spki: Data? = nil) -> String {
        "ca \(key.id) \(TestTBS.certificate(spki: spki ?? key.spki, ca: true).base64EncodedString())"
    }

    private func leaf(basicConstraints: Bool = false) -> Data {
        TestTBS.leaf(spki: P256.Signing.PrivateKey().publicKey.derRepresentation, basicConstraints: basicConstraints)
    }

    func testKeysCreateCAPubSignAndPrune() throws {
        let client = try makeFixture().session()
        XCTAssertEqual(client.send("keys"), "ok", "no keys yet")

        let first = try created(client.send("create"))
        XCTAssertEqual(first.id, SHA256.hash(data: first.spki).map { String(format: "%02x", $0) }.joined(), "the key ID is the SPKI's SHA-256")
        let firstKey = try P256.Signing.PublicKey(derRepresentation: first.spki)
        let ca = TestTBS.certificate(spki: first.spki, ca: true)
        XCTAssertTrue(firstKey.isValidSignature(try signature(client.send("ca \(first.id) \(ca.base64EncodedString())")), for: ca))
        XCTAssertEqual(client.send("pub \(first.id)"), "ok " + first.spki.base64EncodedString())
        for tbs in [leaf(), leaf(basicConstraints: true)] {
            XCTAssertTrue(firstKey.isValidSignature(try signature(client.send("sign \(first.id) m \(tbs.base64EncodedString())")), for: tbs))
        }

        let second = try created(client.send("create"))
        let listed = try XCTUnwrap(client.send("keys"))
        XCTAssertTrue(listed.hasPrefix("ok "), listed)
        XCTAssertEqual(Set(listed.dropFirst(3).split(separator: ",").map(String.init)), [first.id, second.id])
        XCTAssertEqual(client.send("prune \(first.id)"), "ok 1")
        XCTAssertEqual(client.send("keys"), "ok \(first.id)")
        XCTAssertEqual(client.send("pub \(second.id)"), "err no-key")
        XCTAssertEqual(client.send("sign \(second.id) m \(leaf().base64EncodedString())"), "err no-key")
        XCTAssertEqual(client.send("prune"), "ok 1", "prune with nothing kept deletes every key")
        XCTAssertEqual(client.send("keys"), "ok")
    }

    func testCAIsOnlyTheNextRequestAfterItsKeysCreate() throws {
        let fixture = try makeFixture()
        let client = try fixture.session()

        let first = try created(client.send("create"))
        XCTAssertEqual(client.send("keys"), "ok \(first.id)")
        XCTAssertEqual(client.send(caRequest(first)), "err policy ca-only-after-create", "another request came in between")

        _ = try created(client.send("create"))
        XCTAssertEqual(client.send(caRequest(first)), "err policy ca-only-after-create", "an older key")

        let notCA = try created(client.send("create"))
        XCTAssertEqual(client.send("ca \(notCA.id) \(TestTBS.certificate(spki: notCA.spki, ca: false).base64EncodedString())"), "err policy not-ca")
        XCTAssertEqual(client.send(caRequest(notCA)), "err policy ca-only-after-create", "a failed ca uses up its one chance")

        let noConstraints = try created(client.send("create"))
        XCTAssertEqual(client.send("ca \(noConstraints.id) \(TestTBS.certificate(spki: noConstraints.spki, ca: nil).base64EncodedString())"),
                       "err policy not-ca")

        let mismatched = try created(client.send("create"))
        XCTAssertEqual(client.send(caRequest(mismatched, spki: first.spki)), "err policy spki-mismatch")

        let garbled = try created(client.send("create"))
        XCTAssertEqual(client.send("ca \(garbled.id) \(Data([1, 2, 3]).base64EncodedString())"), "err policy not-tbs")

        let elsewhere = try created(client.send("create"))
        client.close()
        let next = try fixture.session()
        XCTAssertEqual(next.send(caRequest(elsewhere)), "err policy ca-only-after-create", "another connection")

        let fresh = try created(next.send("create"))
        let ca = TestTBS.certificate(spki: fresh.spki, ca: true)
        XCTAssertTrue(try P256.Signing.PublicKey(derRepresentation: fresh.spki).isValidSignature(try signature(next.send(caRequest(fresh))), for: ca),
                      "the refusals left the next key's own ca working")
    }

    func testSignFollowsThePolicyFixtures() throws {
        let client = try makeFixture().session()
        let key = try created(client.send("create"))
        let publicKey = try P256.Signing.PublicKey(derRepresentation: key.spki)
        let current = (name: "leaf as ca.go leaf()", reply: "ok", tbs: leaf().base64EncodedString())
        for fixture in SignPolicyFixtures.cases + [current] {
            let tbs = try XCTUnwrap(Data(base64Encoded: fixture.tbs), fixture.name)
            let reply = client.send("sign \(key.id) m \(fixture.tbs)")
            if fixture.reply == "ok" {
                XCTAssertTrue(publicKey.isValidSignature(try signature(reply), for: tbs), fixture.name)
            } else {
                XCTAssertEqual(reply, fixture.reply, fixture.name)
            }
        }
    }

    func testUnknownKeysGetNoKey() throws {
        let client = try makeFixture().session()
        let unknown = String(repeating: "0", count: 64)
        XCTAssertEqual(client.send("sign \(unknown) m \(leaf().base64EncodedString())"), "err no-key")
        XCTAssertEqual(client.send("pub \(unknown)"), "err no-key")
    }

    func testMalformedRequestsGetBadRequestAndKeepTheConnection() throws {
        let client = try makeFixture().session()
        let id = try created(client.send("create")).id
        let tbs = leaf().base64EncodedString()
        let malformed = ["", "nope", " keys", "keys ", "keys now", "create now", "pub", "pub abc", "pub \(id.uppercased())", "pub \(id) extra",
                         "sign \(id) d \(tbs)", "sign \(id) m", "sign \(id) m not*base64", "sign abc m \(tbs)", "ca \(id) not*base64",
                         "ca abc \(tbs)", "prune \(id),", "prune ,\(id)", "prune nothex"]
        for line in malformed {
            XCTAssertEqual(client.send(line), "err bad-request", "\"\(line)\"")
        }
        XCTAssertEqual(client.send("keys"), "ok \(id)", "the connection still serves and nothing was pruned")
    }

    func testAnOverlongLineGetsBadRequestAndClosesTheConnection() throws {
        let client = try makeFixture().session()
        let longest = "pub " + String(repeating: "a", count: CASigner.maximumLineBytes - 4)
        XCTAssertEqual(client.send(longest), "err bad-request", "a line of exactly the limit is read")
        XCTAssertEqual(client.send("keys"), "ok", "and keeps the connection")
        client.write(Data(repeating: UInt8(ascii: "a"), count: CASigner.maximumLineBytes + 1))
        XCTAssertEqual(client.line(), "err bad-request")
        XCTAssertTrue(client.closes())
    }

    func testNonPrintableBytesGetBadRequestAndCloseTheConnection() throws {
        let fixture = try makeFixture()
        for line in [Data("keys".utf8) + Data([0xc3, 0xa9, 10]), Data("ke\tys\n".utf8), Data("ke\u{7f}ys\n".utf8)] {
            let client = try fixture.session()
            client.write(line)
            XCTAssertEqual(client.line(), "err bad-request")
            XCTAssertTrue(client.closes())
        }
    }

    func testStoreFailuresMapToNoSEAndKeychainErrors() throws {
        let fixture = try makeFixture()
        let client = try fixture.session()
        fixture.store.fail(with: .noSecureEnclave)
        XCTAssertEqual(client.send("create"), "err no-se")

        fixture.store.fail(with: .keychain(errSecMissingEntitlement))
        XCTAssertEqual(client.send("create"), "err keychain -34018")
        XCTAssertEqual(client.send("keys"), "err keychain -34018")
        XCTAssertEqual(client.send("prune"), "err keychain -34018")

        fixture.store.fail(with: nil)
        let key = try created(client.send("create"))
        fixture.store.fail(with: .keychain(errSecInteractionNotAllowed))
        XCTAssertEqual(client.send("sign \(key.id) m \(leaf().base64EncodedString())"), "err keychain -25308", "a signing failure")
        XCTAssertEqual(client.send("pub \(key.id)"), "err keychain -25308")
    }

    func testOnlyTheCallerTheRequirementNamesIsServed() throws {
        let served = try makeFixture().connect()
        XCTAssertEqual(served.line(), "ready", "the helper named by its own cdhash")
        XCTAssertEqual(served.send("keys"), "ok")

        let other = try makeFixture().connectOtherHelper()
        XCTAssertEqual(other.line(), "err unauthorised unsigned", "a helper with another cdhash and no team")
        XCTAssertTrue(other.closes(), "a helper with another cdhash is closed")

        let unrequired = try makeFixture(requirement: nil).connect()
        XCTAssertEqual(unrequired.line(), "err unauthorised unsigned", "no requirement serves nobody")
        XCTAssertTrue(unrequired.closes())
    }

    func testAWrongOrEarlyFirstLineIsRefused() throws {
        let fixture = try makeFixture()
        for helper in [SignerHelper.wrong, .early] {
            let client = try fixture.connect(helper)
            XCTAssertEqual(client.line(), "err unauthorised binding", helper.rawValue)
            XCTAssertTrue(client.closes(), helper.rawValue)
        }
    }

    func testANonceEchoedByAForkedChildIsRefused() throws {
        let client = try makeFixture().connect(.forkEcho)
        XCTAssertEqual(client.line(), "err unauthorised binding")
        XCTAssertTrue(client.closes())
    }

    func testARequestFromAForkedChildClosesTheConnection() throws {
        let fixture = try makeFixture()
        let client = try fixture.connect(.forkRequest)
        XCTAssertEqual(client.line(), "ready")
        XCTAssertEqual(client.line(), "ok", "the parent's own keys is served")
        XCTAssertTrue(client.closes(), "the child's create gets no reply")
        XCTAssertEqual(try fixture.store.keyIDs(), [], "and is never handled")
    }

    func testANonceEchoedAfterExecIsRefused() throws {
        let client = try makeFixture().connect(.execEcho)
        XCTAssertEqual(client.line(), "err unauthorised binding")
        XCTAssertTrue(client.closes())
    }

    func testRefusalsAreLoggedOncePerReason() throws {
        let earlier = try refusalLog().count
        let fixture = try makeFixture()
        let otherHelper: () throws -> SignerClient = { try fixture.connectOtherHelper() }
        let wrongEcho: () throws -> SignerClient = { try fixture.connect(.wrong) }
        for (connect, refusal) in [(otherHelper, "unsigned"), (otherHelper, "unsigned"), (wrongEcho, "binding"), (wrongEcho, "binding")] {
            let client = try connect()
            XCTAssertEqual(client.line(), "err unauthorised " + refusal)
            XCTAssertTrue(client.closes())
        }
        let logged = refusals(after: earlier, count: 2)
        XCTAssertEqual(logged.count, 2, "\(logged)")
        XCTAssertEqual(Set(logged), ["ca signer refused a caller: unsigned", "ca signer refused a caller: binding"])
    }

    private func refusals(after earlier: Int, count: Int) -> [String] {
        var logged: [String] = []
        Wait.until(5) {
            logged = Array(((try? refusalLog()) ?? []).dropFirst(earlier))
            return logged.count >= count
        }
        return logged
    }

    private func refusalLog() throws -> [String] {
        let store = try OSLogStore(scope: .currentProcessIdentifier)
        let matching = NSPredicate(format: "subsystem == %@ AND category == %@", GuardConstants.appBundleId, "ca-signer")
        return try store.getEntries(matching: matching)
            .compactMap { ($0 as? OSLogEntryLog)?.composedMessage }
            .filter { $0.hasPrefix("ca signer refused a caller") }
    }
}
